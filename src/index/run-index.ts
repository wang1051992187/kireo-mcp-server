import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_LIMITS } from '@kireo/shared';
import type { Logger } from 'pino';
import { indexRootRel, resolveProjectHere } from '../context/project.js';
import type { RestClient } from '../rest/client.js';
import type { BatchCreateResponse } from '../rest/types.js';
import { type CreateMemoryDTO, assembleSymbol, codeNamespace } from './assemble.js';
import { extractSymbols } from './extractor.js';
import { type GitExec, diffSince } from './git-diff.js';
import { loadParser } from './grammars.js';
import { type IndexHeadScope, readIndexHead, writeIndexHead } from './index-head.js';
import { configForExtension } from './languages/index.js';
import { type IndexState, diffState, hashContent, loadState, saveState } from './state.js';
import { walkRepo } from './walk.js';

export interface IndexSummary {
  repo: string;
  namespace: string;
  filesScanned: number;
  filesChanged: number;
  filesDeleted: number;
  symbols: number;
  /** Symbols removed by the pre-upload prune of deleted ∪ changed files. */
  symbolsPruned: number;
  batches: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Re-express repo-root-relative git paths in the index root's path space,
 * dropping everything outside the index root. `indexRoot === ''` (indexing the
 * repo root) is the identity.
 */
function rebaseToIndexRoot(
  diff: { changed: string[]; deleted: string[] },
  indexRoot: string,
): { changed: string[]; deleted: string[] } {
  if (!indexRoot) return diff;
  const prefix = `${indexRoot}/`;
  const inside = (paths: string[]): string[] =>
    paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  return { changed: inside(diff.changed), deleted: inside(diff.deleted) };
}

/** Extract all DTOs from a single source file, reused by both runIndex and extractRepo. */
async function extractFileDTOs(args: {
  relPath: string;
  buf: Buffer;
  contentHash: string;
  repo: string;
  namespace: string;
  logger: { warn: (obj: unknown, msg: string) => void };
}): Promise<CreateMemoryDTO[]> {
  const { relPath, buf, contentHash, repo, namespace, logger } = args;
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  const lang = configForExtension(ext);
  if (!lang) return [];
  try {
    const parser = await loadParser(lang.grammar);
    const source = buf.toString('utf8');
    const symbols = extractSymbols(lang.config, parser, source);
    return symbols.map((symbol) =>
      assembleSymbol({
        symbol,
        filePath: relPath,
        language: lang.config.language,
        repo,
        namespace,
        contentHash,
      }),
    );
  } catch (err) {
    // One bad file must not abort the whole repo.
    logger.warn({ file: relPath, err: (err as Error).message }, 'index.file.skip');
    return [];
  }
}

export async function runIndex(args: {
  rest: RestClient;
  logger: Logger;
  root: string;
  repo: string;
  /**
   * Code bucket to write into. Defaults to the historical
   * `code-<repoSlug(repo)>`; cli.ts passes the project-resolved name once
   * `.kireo/project.json` pins the key (spec §5.4's backwards-compat rule:
   * without the marker file, keep the old naming and only print a hint).
   */
  namespace?: string | undefined;
  /** Symbols per batch (1..BATCH_MAX). Defaults to BATCH_MAX. */
  batchSize?: number | undefined;
}): Promise<IndexSummary> {
  const { rest, logger, root, repo } = args;
  const namespace = args.namespace ?? codeNamespace(repo);
  // Clamp to the server-enforced range so a bad caller can't send oversized batches.
  const batchSize = Math.min(
    Math.max(1, Math.trunc(args.batchSize ?? MEMORY_LIMITS.BATCH_MAX)),
    MEMORY_LIMITS.BATCH_MAX,
  );

  const files = await walkRepo(root);
  const currentHashes: Record<string, string> = {};
  const bufByPath = new Map<string, Buffer>();
  for (const f of files) {
    const buf = await readFile(f.absPath);
    bufByPath.set(f.relPath, buf);
    currentHashes[f.relPath] = hashContent(buf);
  }

  // --- Diff mode selection --------------------------------------------------
  //
  // Three ways to find `{ changed, deleted }`, tried in this order:
  //   1. A local .kireo/index-state.json from a prior run on THIS machine —
  //      the cheapest and most precise source (exact prior content hashes).
  //   2. A commit-anchor card in this project's ctx bucket plus
  //      `git diff --name-status` against it — for a fresh checkout on a
  //      device that has never indexed this repo locally before.
  //   3. A full scan (`prev = {}`) — the fallback when neither of the above
  //      is available. This used to be the ONLY path and took it silently;
  //      every branch below now explicitly logs why it took the full-scan
  //      road instead.
  const ctxNs = resolveProjectHere(root).ctxNs;
  // The anchor is scoped to (code bucket, index root), not to the project.
  //
  // A project has ONE ctx bucket but can have several code buckets — a
  // monorepo indexed per package, an explicit `--repo`, a second clone under a
  // different directory name. Sharing one anchor meant the second run read the
  // first run's `@HEAD`, `git diff HEAD..HEAD` came back empty, and it uploaded
  // zero symbols while logging "用 commit 锚点跳过全量扫描" — the second code
  // bucket stayed permanently empty, and only files changed after that commit
  // ever entered it.
  const indexRoot = indexRootRel(root);
  const headScope: IndexHeadScope = { codeNs: namespace, indexRoot };
  const gitExec: GitExec = (gitArgs, cwd) =>
    execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // Resolved once, up front, regardless of mode: a plain (non-git) directory
  // makes this null, which both rules out the anchor path (nothing to
  // `git diff` against) and skips writing a fresh anchor at the end (there is
  // no commit to anchor to).
  let headCommit: string | null;
  try {
    headCommit = gitExec(['rev-parse', 'HEAD'], root).trim() || null;
  } catch {
    headCommit = null;
  }

  const localStateExists = existsSync(join(root, '.kireo', 'index-state.json'));
  let prev: IndexState = {};
  let changed: string[];
  let deleted: string[];

  if (localStateExists) {
    prev = await loadState(root);
    ({ changed, deleted } = diffState(prev, currentHashes));
  } else if (headCommit === null) {
    logger.info(
      'index.full_scan: 当前目录不是 git 仓库（或 HEAD 不可解析），无法使用 commit 锚点，走全量扫描',
    );
    ({ changed, deleted } = diffState(prev, currentHashes));
  } else {
    const head = await readIndexHead(rest, ctxNs, headScope);
    if (!head) {
      logger.info(
        'index.full_scan: 服务端没有可用的 commit 锚点（该项目首次索引，或此前从未有设备写入过），走全量扫描',
      );
      ({ changed, deleted } = diffState(prev, currentHashes));
    } else {
      const anchorDiff = diffSince(root, head.commit, gitExec);
      if (anchorDiff) {
        // `diffSince` answers in REPO-ROOT-relative paths while `walkRepo`
        // (and therefore every stored `metadata.file_path`) is relative to the
        // INDEX ROOT. Identical only when indexing the repo root; for
        // `kireo index apps/api` the two path spaces disagree completely, so
        // every changed file missed `bufByPath` (zero symbols uploaded, while
        // stdout still said "1 changed") and the prune DELETE asked the server
        // to remove `apps/api/a.py` from a bucket that stores `a.py` (stale
        // symbols left forever). Rebase onto the index root and drop anything
        // outside it — `git diff` reports the whole repo no matter which
        // subdirectory it ran in.
        ({ changed, deleted } = rebaseToIndexRoot(anchorDiff, indexRoot));
        // The remote already holds symbols for every file as of the anchor
        // commit, so — unlike the local-state path below — a file
        // `diffSince` reports as changed must be pruned even though it has
        // never been seen in THIS machine's (nonexistent) prior state.
        prev = Object.fromEntries(changed.map((f) => [f, '']));
        logger.info(
          {
            commit: head.commit,
            namespace,
            indexRoot,
            changed: changed.length,
            deleted: deleted.length,
          },
          'index.anchor.diff: 用 commit 锚点跳过全量扫描',
        );
      } else {
        // The anchor commit itself is unreachable here — shallow clone,
        // rebased history, a pruned branch. Must degrade to a full scan
        // rather than silently indexing nothing.
        logger.info(
          { commit: head.commit },
          'index.full_scan: commit 锚点不可达（浅克隆/rebase/分支被裁剪等），git diff 失败，走全量扫描',
        );
        ({ changed, deleted } = diffState(prev, currentHashes));
      }
    }
  }

  // Prune stale symbols for BOTH deleted and changed files before uploading.
  //
  // The previous loop only walked `deleted`, so a function that was renamed or
  // removed inside a still-existing file left its old symbol row in the index
  // forever. Pruning must also happen BEFORE the upload: a symbol that still
  // exists is simply re-created by the batch that follows, whereas pruning
  // afterwards would delete what we just wrote.
  //
  // `changed` also contains files seen for the very first time (not in
  // `prev`); those can't have stale symbols yet, so they're excluded here to
  // avoid a no-op DELETE round-trip on every fresh index.
  const toPrune = [...new Set([...deleted, ...changed.filter((rel) => Object.hasOwn(prev, rel))])];
  let symbolsPruned = 0;
  for (const filePaths of chunk(toPrune, 200)) {
    const res = await rest.request<{ deleted: number }>({
      method: 'DELETE',
      path: '/v1/memories',
      query: { namespace, file_paths: filePaths.join(',') },
    });
    symbolsPruned += res.deleted ?? 0;
  }

  const dtos: CreateMemoryDTO[] = [];
  for (const rel of changed) {
    const fileDTOs = await extractFileDTOs({
      relPath: rel,
      buf: bufByPath.get(rel) as Buffer,
      contentHash: currentHashes[rel] as string,
      repo,
      namespace,
      logger,
    });
    dtos.push(...fileDTOs);
  }

  const batches = chunk(dtos, batchSize);
  let symbolsSucceeded = 0;
  // Batches whose server ack we actually received (i.e. confirmed committed).
  let batchesConfirmed = 0;
  try {
    for (const items of batches) {
      const res = await rest.request<BatchCreateResponse>({
        method: 'POST',
        path: '/v1/memories/batch',
        body: { items, strict: false },
        idempotent: false,
      });
      if (res.failures.length > 0) {
        logger.warn({ count: res.failures.length, failures: res.failures }, 'index.batch.partial');
      }
      symbolsSucceeded += items.length - res.failures.length;
      batchesConfirmed++;
    }
  } catch (err) {
    // On timeout/abort the in-flight batch may ALREADY be committed server-side —
    // the client just never received the ack. `batchesConfirmed` counts only
    // acked batches; the failing (in-flight) batch is the next one after those.
    logger.error(
      {
        batchesConfirmed,
        batchesAttempted: Math.min(batchesConfirmed + 1, batches.length),
        batchesTotal: batches.length,
      },
      'index.batch.failed: the in-flight batch may already be committed server-side ' +
        '(client aborted before the ack). Re-running is safe — the server now dedupes ' +
        'identical symbols by (namespace, content_hash), so it will not create duplicates.',
    );
    throw err;
  }

  await saveState(root, currentHashes);

  if (headCommit !== null) {
    try {
      await writeIndexHead(
        rest,
        ctxNs,
        { commit: headCommit, ts: new Date().toISOString() },
        headScope,
      );
    } catch (err) {
      // The anchor is an optimization for the NEXT run/device, not a
      // correctness requirement for THIS one — a failed write must not turn
      // an otherwise-successful index into a failed command.
      logger.warn({ err }, 'index.anchor.write_failed');
    }
  }

  return {
    repo,
    namespace,
    filesScanned: files.length,
    filesChanged: changed.length,
    filesDeleted: deleted.length,
    symbols: symbolsSucceeded,
    symbolsPruned,
    batches: batches.length,
  };
}

/**
 * Walk all source files in `dir` and return assembled DTOs for every symbol —
 * no incremental diff, no network calls. Intended for M5 integration tests and
 * tooling that needs the full repo snapshot without indexing.
 */
export async function extractRepo(opts: { dir: string; repo: string }): Promise<CreateMemoryDTO[]> {
  const { dir, repo } = opts;
  const namespace = codeNamespace(repo);
  const noop = (): void => undefined;
  const silentLogger = { warn: noop } as { warn: (obj: unknown, msg: string) => void };

  const files = await walkRepo(dir);
  const dtos: CreateMemoryDTO[] = [];
  for (const f of files) {
    const buf = await readFile(f.absPath);
    const contentHash = hashContent(buf);
    const fileDTOs = await extractFileDTOs({
      relPath: f.relPath,
      buf,
      contentHash,
      repo,
      namespace,
      logger: silentLogger,
    });
    dtos.push(...fileDTOs);
  }
  return dtos;
}
