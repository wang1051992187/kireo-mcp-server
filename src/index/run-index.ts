import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { MEMORY_LIMITS } from '../vendored/shared.js';
import type { RestClient } from '../rest/client.js';
import type { BatchCreateResponse } from '../rest/types.js';
import { type CreateMemoryDTO, assembleSymbol, codeNamespace } from './assemble.js';
import { extractSymbols } from './extractor.js';
import { loadParser } from './grammars.js';
import { configForExtension } from './languages/index.js';
import { diffState, hashContent, loadState, saveState } from './state.js';
import { walkRepo } from './walk.js';

export interface IndexSummary {
  repo: string;
  namespace: string;
  filesScanned: number;
  filesChanged: number;
  filesDeleted: number;
  symbols: number;
  batches: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
  /** Symbols per batch (1..BATCH_MAX). Defaults to BATCH_MAX. */
  batchSize?: number | undefined;
}): Promise<IndexSummary> {
  const { rest, logger, root, repo } = args;
  const namespace = codeNamespace(repo);
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

  const prev = await loadState(root);
  const { changed, deleted } = diffState(prev, currentHashes);

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

  for (const rel of deleted) {
    await rest.request<{ deleted: number }>({
      method: 'DELETE',
      path: '/v1/memories',
      query: { namespace, file_path: rel },
    });
  }

  await saveState(root, currentHashes);

  return {
    repo,
    namespace,
    filesScanned: files.length,
    filesChanged: changed.length,
    filesDeleted: deleted.length,
    symbols: symbolsSucceeded,
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
