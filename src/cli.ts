import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { MEMORY_LIMITS, ctxNamespace } from '@kireo/shared';
import type { Logger } from 'pino';
import { loadConfig } from './config/merge.js';
import {
  type BackfillItem,
  type SessionPrivacyVerdict,
  backfillBody,
  runBackfill,
} from './context/backfill.js';
import { formatDoctorReport, runDoctor } from './context/doctor.js';
import { listHomeCards } from './context/home.js';
import { repoRoot, repoRootOrCwd, resolveProjectHere } from './context/project.js';
import { isDisabled } from './context/redact.js';
import { appendOutboundAudit, outboundDigests } from './context/redact.js';
import { codeNamespace } from './index/assemble.js';
import { runIndex } from './index/run-index.js';
import { RestApiError } from './lib/errors.js';
import { homeDir } from './lib/platform.js';
import { sleep } from './lib/sleep.js';
import { deviceIdOrAnon } from './observability/device-id.js';
import { createLogger } from './observability/logger.js';
import { type RestClient, createRestClient } from './rest/client.js';
import { startServer } from './server.js';
import { contextLoadTool } from './tools/context-load.js';
import { __KIREO_MCP_VERSION__ } from './version.js';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const USAGE = `kireo — long-term memory for MCP-compatible AI tools (v${__KIREO_MCP_VERSION__})

Usage:
  kireo                       Start the MCP stdio server (default; used by AI hosts)
  kireo index [dir] [flags]   Index a local repo's code symbols into your memory
  kireo doctor                Diagnose the context relay end to end (run this first when
                              "nothing gets saved" or "resume shows nothing")
  kireo resume [--all]        Print this project's saved context (--all = every project)
  kireo backfill [--since 90d] [--dry-run=false]
                              Import past Claude Code / Codex sessions
  kireo project info          Show the resolved project key and its buckets
  kireo project init [--migrate]
                              Pin the project key into .kireo/project.json (commit it).
                              --migrate also renames the old buckets — BOTH ctx and
                              code — to the new stable names, server-side, with no
                              re-indexing.
  kireo project set <key> [--migrate | --yes]
                              Pin an explicit project key. A different key means a
                              different ctx bucket, so /kireo:resume would start
                              reading an empty one: this refuses to switch unless you
                              pass --migrate (move the cards too) or --yes (leave them
                              behind on purpose).
  kireo project merge <from> <to> [--yes]
                              Move every memory from one namespace into another
  kireo --help                Show this help
  kireo --version             Show the version

Index flags:
  --repo <name>        Namespace repo name (default: the directory's basename)
  --batch-size <n>     Symbols per upload batch, 1..${MEMORY_LIMITS.BATCH_MAX} (default: ${MEMORY_LIMITS.BATCH_MAX})
  --timeout <ms>       Per-request timeout in ms (default: 60000, max: 300000)
  --api-key <key>      Bearer token (ki_sk_…); overrides KIREO_API_KEY
  --api-url <url>      API base URL (default: https://api.kireo.app)
  --namespace <name>   Default namespace for memory tools
  --log-level <level>  fatal | error | warn | info | debug | trace | silent
  --no-telemetry       Drop the X-Device-Id header

Environment variables (CLI flags take precedence):
  KIREO_API_KEY              Bearer token (ki_sk_…) — required to index or serve
  KIREO_API_URL              API base URL
  KIREO_REQUEST_TIMEOUT_MS   Per-request timeout in ms (alias: KIREO_TIMEOUT_MS)
  KIREO_RETRY_MAX_ATTEMPTS   5xx/429 retries (alias: KIREO_RETRY_MAX)
  KIREO_RETRY_BASE_MS        Exponential backoff base
  KIREO_TELEMETRY            Set to 0 to disable the device-id header
  KIREO_LOG_LEVEL            Log level (see --log-level)
  KIREO_PROXY_URL            HTTP(S) proxy
  KIREO_ACCEPT_LANGUAGE      Locale for error hints
  KIREO_DISABLED             Privacy kill switch (same as a .kireo/disabled file in the
                             repo): every outbound command — index, resume, backfill,
                             project init/set --migrate, project merge — stops before
                             it opens a connection. 'kireo doctor' is the one
                             exception, on purpose: it has to keep working to tell you
                             the switch is what silenced everything else.

Docs: https://docs.kireo.app
`;

const USAGE_HINT = "Run 'kireo --help' for usage.";

/** Index-command flags that consume a following value (`--flag value` or `--flag=value`). */
const INDEX_VALUE_FLAGS = new Set([
  'repo',
  'batch-size',
  'timeout',
  'timeout-ms',
  'api-key',
  'api-url',
  'namespace',
  'log-level',
]);
/** Index-command flags that stand alone (no value). */
const INDEX_BOOL_FLAGS = new Set(['no-telemetry']);

/** "2h前" / "3d前" — relative age for `resume --all`'s project list. */
function formatAgeZh(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '?';
  const hours = Math.max(0, (now.getTime() - t) / 3_600_000);
  return hours < 24 ? `${Math.max(1, Math.round(hours))}h前` : `${Math.round(hours / 24)}d前`;
}

/** Parse `--since` (e.g. "90d") into a cutoff `Date`; defaults to 90 days. */
function parseSinceFlag(val: string | undefined): Date {
  const raw = (val ?? '90d').trim();
  const m = /^(\d+)d$/.exec(raw);
  if (!m || m[1] === undefined) {
    throw new Error(`invalid --since "${raw}": expected e.g. "90d".\n${USAGE_HINT}`);
  }
  const days = Number.parseInt(m[1], 10);
  return new Date(Date.now() - days * 86_400_000);
}

const isHelpToken = (t: string): boolean => t === '--help' || t === '-h';
const isVersionToken = (t: string): boolean => t === '--version' || t === '-v';

/**
 * Subcommands that must never fall through to the stdio server.
 *
 * The historical default was "anything that isn't `index` is an MCP server",
 * which meant a typo or a not-yet-wired command hung silently instead of
 * erroring. Every command added here errors loudly until it is implemented.
 */
export const KNOWN_COMMANDS = ['index', 'ctx', 'project', 'resume', 'backfill', 'doctor'] as const;

/** Parse `--batch-size` into a validated integer within `1..BATCH_MAX`. */
function parseBatchSize(val: string | undefined): number {
  const n = val === undefined ? Number.NaN : Number.parseInt(val, 10);
  if (!Number.isInteger(n) || n < 1 || n > MEMORY_LIMITS.BATCH_MAX) {
    throw new Error(
      `invalid --batch-size "${val ?? ''}": expected an integer 1..${MEMORY_LIMITS.BATCH_MAX}.\n${USAGE_HINT}`,
    );
  }
  return n;
}

/**
 * Pull `index [dir]`, `--repo <name>` and `--batch-size <n>` out of argv (the
 * REST config flags are re-read by loadConfig). Unknown `--flags` are rejected
 * so a typo can't silently fall through to "index the current directory".
 */
function parseIndexArgs(argv: string[]): {
  dir: string;
  repo: string | undefined;
  batchSize: number | undefined;
} {
  const positionals: string[] = [];
  let repo: string | undefined;
  let batchSize: number | undefined;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const key = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    let val: string | undefined = eq > 0 ? tok.slice(eq + 1) : undefined;
    if (INDEX_BOOL_FLAGS.has(key)) continue;
    if (!INDEX_VALUE_FLAGS.has(key)) {
      throw new Error(`unknown flag "--${key}" for 'kireo index'.\n${USAGE_HINT}`);
    }
    if (val === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i++;
      }
    }
    if (key === 'repo') repo = val;
    else if (key === 'batch-size') batchSize = parseBatchSize(val);
    // api-key/api-url/timeout/namespace/log-level are consumed by loadConfig.
  }
  return { dir: positionals[0] ?? '.', repo, batchSize };
}

/**
 * Refuse `project merge` above this many memories in the source bucket.
 *
 * This number is a safety wall, not a benchmark, and it is deliberately low.
 * `PATCH /v1/namespaces/:name` was read end to end for this command
 * (apps/api/src/namespaces/service.ts#renameNamespace →
 * apps/api/src/namespaces/worker.ts#processNamespaceJob) and it is a
 * single-shot bulk operation with none of the properties a large migration
 * needs:
 *
 * - **Not atomic.** One `table.update({where: user_id AND namespace=from})`
 *   against LanceDB, then one `UPDATE memories_meta`, then one `UPDATE
 *   namespaces` — deliberately with no `db.transaction()` (the production
 *   neon-http driver has none). A crash between step 1 and step 2 leaves
 *   LanceDB and Postgres disagreeing about which bucket the rows are in.
 * - **No checkpoint, no resume, no progress.** `progress` is written once,
 *   as 100, at the very end. A job that dies halfway restarts from scratch.
 * - **No rollback.** Nothing anywhere compensates a half-applied move; the
 *   only recovery is the retry (`attempts: 3`), which works precisely
 *   because each statement is idempotent — and if all three attempts are
 *   spent, the task is marked `failed` and the split state simply stays.
 * - **No batching.** The whole namespace moves in one native LanceDB call.
 *   The longer that call blocks, the likelier BullMQ's stalled-job detector
 *   re-queues the job and runs a second copy concurrently.
 *
 * None of that is a bug at the size this endpoint was built for (renaming a
 * bucket you just created). It is simply not a migration engine, and this
 * command must not pretend otherwise for someone's ten-thousand-card history.
 */
const MERGE_MAX_MEMORIES = 5000;

/** Poll cadence + budget for the async rename/merge task. */
const MERGE_POLL_INTERVAL_MS = 2_000;
const MERGE_POLL_MAX_MS = 120_000;

/**
 * Machine-local files that must never be committed, written next to
 * `project.json` by `project init/set`.
 *
 * The CLI tells the user to commit `.kireo/`'s marker file, but the same
 * directory also holds `index-state.json` (this machine's path→sha256 map) and
 * `CONTEXT.md` (the distilled context body). Committing `index-state.json` is
 * actively destructive: a teammate clones, `run-index.ts` finds the file, the
 * hashes match the freshly checked-out contents, `diffState` returns
 * `changed: []`, and their code bucket stays empty run after run with no error.
 * `CONTEXT.md` is content that the save path gates behind a forced first-run
 * preview before letting it leave the device.
 *
 * Never overwrites an existing `.kireo/.gitignore` — the user may have added
 * their own entries.
 */
export function writeKireoGitignore(kireoDir: string): void {
  const path = join(kireoDir, '.gitignore');
  if (existsSync(path)) return;
  writeFileSync(
    path,
    [
      '# 由 `kireo project init/set` 生成。',
      '# .kireo/ 下只有 project.json 与本文件该进 git，其余都是本机状态或本机内容。',
      'index-state.json',
      '.index-state.tmp.*',
      'CONTEXT.md',
      'disabled',
      '',
    ].join('\n'),
  );
}

/** Ask a y/N question on stdin. Returns false for anything but y/yes. */
async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

interface NamespaceListItem {
  name: string;
  count?: number;
}

async function listNamespaces(rest: RestClient): Promise<NamespaceListItem[]> {
  const res = await rest.request<{ items?: NamespaceListItem[] }>({
    method: 'GET',
    path: '/v1/namespaces',
  });
  return res.items ?? [];
}

interface AsyncTaskRow {
  status?: string;
  error?: { code?: string; message?: string } | null;
}

/** Poll `GET /v1/async-tasks/:id` until it settles or the budget runs out. */
async function waitForTask(rest: RestClient, taskId: string): Promise<AsyncTaskRow | null> {
  const deadline = Date.now() + MERGE_POLL_MAX_MS;
  for (;;) {
    try {
      const t = await rest.request<AsyncTaskRow>({
        method: 'GET',
        path: `/v1/async-tasks/${encodeURIComponent(taskId)}`,
      });
      if (t.status === 'succeeded' || t.status === 'failed') return t;
    } catch {
      // A transient read failure must not abort a migration that is already
      // running server-side; keep polling until the budget is gone.
    }
    if (Date.now() >= deadline) return null;
    await sleep(MERGE_POLL_INTERVAL_MS);
  }
}

/**
 * `kireo project merge <from> <to>` — move every memory in one namespace into
 * another. Returns the process exit code.
 *
 * Two sharp edges of the underlying endpoint are handled here rather than
 * leaked as raw HTTP errors, because both of them are guaranteed to be hit by
 * the exact users this command exists for:
 *
 * 1. `renameNamespace` looks the source up in the `namespaces` TABLE, but
 *    `POST /v1/memories` never registers a row there (only `POST
 *    /v1/namespaces` does — see the BUG-003 comments in
 *    apps/api/src/namespaces/service.ts and quota.ts). Every bucket this
 *    feature creates — `ctx-*`, `code-*`, `kireo-home` — is therefore
 *    memory-derived only, and a bare PATCH answers 404 for all of them. So a
 *    404 is followed by registering the name and retrying exactly once.
 * 2. The same function REJECTS a target that is registered
 *    (`NAMESPACE_ALREADY_EXISTS`). It is a rename primitive; the only reason
 *    merging into a live bucket works at all is that the destination is
 *    normally derived-only and therefore invisible to that check. When it is
 *    not, say so plainly instead of printing "conflict".
 */
async function runProjectMerge(args: {
  rest: RestClient;
  from: string;
  to: string;
  assumeYes: boolean;
  /** `project init --migrate`: "there is no old bucket" is success, not failure. */
  missingSourceOk?: boolean;
  /** Names the bucket in user-facing lines; `--migrate` moves two of them. */
  label?: string;
}): Promise<MergeOutcome> {
  const { rest, from, to, assumeYes } = args;
  const label = args.label ?? 'namespace';
  if (from === to) {
    process.stderr.write('kireo project merge: <from> 与 <to> 相同，无事可做\n');
    return 'failed';
  }

  let items: NamespaceListItem[];
  try {
    items = await listNamespaces(rest);
  } catch (err) {
    process.stderr.write(`kireo project merge: 读取 namespace 列表失败：${String(err)}\n`);
    return 'failed';
  }
  const src = items.find((i) => i.name === from);
  const dst = items.find((i) => i.name === to);
  if (!src) {
    if (args.missingSourceOk) {
      process.stdout.write(`没有旧的 ${label} "${from}" 需要迁移。\n`);
      return 'nothing';
    }
    const known = items.map((i) => i.name).join(', ') || '(空)';
    process.stderr.write(`kireo project merge: 找不到源 namespace "${from}"。\n当前有：${known}\n`);
    return 'failed';
  }
  const count = src.count ?? 0;
  if (count === 0) {
    process.stdout.write(`"${from}" 里没有任何条目，不需要合并。\n`);
    return 'nothing';
  }
  if (count > MERGE_MAX_MEMORIES) {
    // Refusing is the honest answer: see MERGE_MAX_MEMORIES. Pretending the
    // endpoint can do this would risk a half-migrated bucket with no way back.
    process.stderr.write(
      `kireo project merge: 拒绝执行 —— "${from}" 有 ${count} 条，超过上限 ${MERGE_MAX_MEMORIES}。\n服务端这条路径是一次性整桶搬迁：不分页、无断点续传、失败不回滚，\n中途失败会让向量库与元数据库对同一批条目的归属产生分歧。\n这个规模请先用导出/导入（https://app.kireo.app 的 Export），或联系支持。\n`,
    );
    return 'failed';
  }

  process.stdout.write(
    `准备把 ${count} 条从 "${from}" 搬到 "${to}"（目标当前 ${dst?.count ?? 0} 条）。\n这是服务端异步任务：一次性整桶搬迁，没有断点续传，中途失败不回滚。\n搬迁后源 namespace 不再存在。\n`,
  );
  if (!assumeYes && !(await askYesNo('确认继续？(y/N) '))) {
    process.stdout.write('已取消，什么都没动。\n');
    return 'cancelled';
  }

  const patch = () =>
    rest.request<{ task_id?: string }>({
      method: 'PATCH',
      path: `/v1/namespaces/${encodeURIComponent(from)}`,
      body: { name: to },
    });

  let res: { task_id?: string };
  try {
    res = await patch();
  } catch (err) {
    const code = err instanceof RestApiError ? err.code : '';
    if (code === 'NAMESPACE_NOT_FOUND') {
      // Sharp edge 1 — register the derived name, then retry once.
      process.stdout.write(`"${from}" 只由记忆派生、没有注册行，先补一条注册记录…\n`);
      try {
        await rest.request({ method: 'POST', path: '/v1/namespaces', body: { name: from } });
        res = await patch();
      } catch (err2) {
        process.stderr.write(`kireo project merge: 补注册后仍然失败：${String(err2)}\n`);
        return 'failed';
      }
    } else if (code === 'NAMESPACE_ALREADY_EXISTS') {
      // Sharp edge 2 — be explicit that the server primitive is a rename.
      process.stderr.write(
        `kireo project merge: 目标 "${to}" 已经是一个已注册的 namespace，服务端拒绝了。\n服务端这个接口本质是"改名"而不是"合并"：目标名字已注册时它一律拒绝。\n变通做法：先把 "${to}" 改名成一个不存在的名字，再把 "${from}" 改成 "${to}"，\n或者用导出/导入手工合并。\n`,
      );
      return 'failed';
    } else {
      process.stderr.write(`kireo project merge: 请求失败：${String(err)}\n`);
      return 'failed';
    }
  }

  const taskId = res.task_id;
  if (!taskId) {
    process.stderr.write('kireo project merge: 服务端没有返回 task_id，无法跟踪进度\n');
    return 'failed';
  }
  process.stdout.write(`已提交（task ${taskId}），等待服务端完成…\n`);

  const task = await waitForTask(rest, taskId);
  if (task === null) {
    process.stdout.write(
      `等待超时（${MERGE_POLL_MAX_MS / 1000}s）。任务可能仍在跑 —— 稍后用 \`kireo project merge\` 之前\n` +
        `先跑 \`kireo doctor\` 或看 https://app.kireo.app 确认 "${to}" 的条数。\n`,
    );
    return 'failed';
  }
  if (task.status === 'failed') {
    process.stderr.write(
      `kireo project merge: 服务端任务失败（${task.error?.code ?? 'UNKNOWN'}）：${task.error?.message ?? ''}\n⚠️ 这条路径没有回滚：向量库与元数据库可能对这批条目的归属不一致。\n请先用 \`kireo doctor\` 与 https://app.kireo.app 核对 "${from}" / "${to}" 的条数，再决定是否重试。\n`,
    );
    return 'failed';
  }
  process.stdout.write(`完成：${count} 条已并入 "${to}"。\n`);
  return 'done';
}

/** Everything the CLI needs to reach the API — and the only sanctioned source of it. */
interface OutboundSession {
  rest: RestClient;
  logger: Logger;
}

/**
 * The CLI's ONE outbound choke point: kill switch first, REST client second.
 *
 * The switch used to be re-checked by hand at each call site, and the two sites
 * that were missing were the two that mattered most. `kireo index` POSTs every
 * extracted symbol — function names, signatures, file paths — to
 * /v1/memories/batch, and `kireo resume --all` reads the cross-project
 * `kireo-home` bucket; both ran, and uploaded, with KIREO_DISABLED=1 set, while
 * the comment on backfill's own check described that variable as "machine-wide,
 * so nothing may run at all". A privacy switch whose comment promises more than
 * its implementation delivers is worse than no switch at all: it is what makes
 * a user drop `.kireo/disabled` into a confidential repo, believe nothing can
 * leave it, and then run `kireo index .`.
 *
 * So the check no longer lives at call sites. `createRestClient` is called in
 * exactly two places in this file: here, and in the `doctor` branch. Doctor is
 * the single deliberate exemption — it must run WITH the switch on and report
 * that it is on, because "why did nothing happen" is the entire question it
 * exists to answer. Every other command, present or future, gets its client
 * from this function, so a new subcommand cannot acquire the ability to send
 * anything without passing through this gate. cli.test.ts walks KNOWN_COMMANDS
 * and asserts zero requests and zero clients for every command but doctor; it
 * fails the moment a command is added to that list without an entry.
 *
 * `dirs` is who gets a vote. The cwd always does; a command that operates on
 * some OTHER directory passes that too, because the marker file belongs to the
 * repo whose content is about to be uploaded (`kireo index ~/secret-repo` run
 * from elsewhere must obey ~/secret-repo/.kireo/disabled).
 *
 * SCOPE, stated so no comment here over-promises again: this gate covers the
 * CLI's own subcommands. The `memory_*` MCP tools, which a host invokes
 * explicitly, do not consult the switch and never have — see doctor's
 * kill-switch hint, which says so to the user's face rather than letting them
 * infer a guarantee that does not exist.
 *
 * EXIT CODE is the caller's call, and the two answers in this file are
 * deliberate, not an oversight — this is the rule a new command picks from:
 *
 *  - `index` / `resume` / `backfill` return, leaving exit 0. These are sync
 *    commands: "the switch is on, so there is nothing to sync" is the setting
 *    working, and nothing is lost by it (symbols come back from one re-index,
 *    the outbox stays on disk). A cron'd `kireo backfill` on a machine with
 *    KIREO_DISABLED=1 must not mail a failure every night.
 *  - `project … --migrate` / `project merge` set exit 1. The user named
 *    specific data and asked for it to be MOVED; it was not. Exiting 0 there
 *    would let `kireo project merge old new && rm-the-old-thing` read a
 *    no-op as a completed migration, and ctx cards do not come back.
 *
 * Short form: a blocked sync is success, a blocked data move is failure.
 */
function openOutbound(args: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Directories whose `.kireo/disabled` governs this command; defaults to cwd. */
  dirs?: string[];
  /** Command name for the refusal line, e.g. "kireo index". */
  what: string;
  /** What specifically did NOT happen — vague reassurance is not reassurance. */
  effect?: string;
}): OutboundSession | null {
  const dirs = args.dirs ?? [process.cwd()];
  const blocked = dirs.map(repoRootOrCwd).find((root) => isDisabled(root, args.env));
  if (blocked !== undefined) {
    const origin = args.env.KIREO_DISABLED
      ? 'KIREO_DISABLED 环境变量'
      : join(blocked, '.kireo', 'disabled');
    process.stdout.write(
      [
        `kireo 隐私开关已启用（${origin}），${args.what} 已中止：${
          args.effect ?? '没有联网，没有上传任何内容。'
        }`,
        '要恢复：删掉那个 .kireo/disabled，或取消 KIREO_DISABLED 环境变量。',
        '（`kireo doctor` 不受这个开关影响 —— 开关开着时它照样能跑，并告诉你为什么什么都没发生。）',
        '',
      ].join('\n'),
    );
    return null;
  }
  const { config } = loadConfig({ argv: args.argv, env: args.env });
  const logger = createLogger(config);
  const deviceId = deviceIdOrAnon(config.telemetryEnabled);
  return {
    rest: createRestClient({ config, deviceId, version: __KIREO_MCP_VERSION__, logger }),
    logger,
  };
}

/**
 * What a single bucket move ended up doing.
 *
 * `--migrate` moves TWO buckets now, so the summary has to distinguish "the
 * server rejected it" from "you answered n" from "there was nothing there" —
 * collapsing all three into the numbers 0 and 1 is what would let a partial
 * migration be reported as a clean one.
 */
type MergeOutcome = 'done' | 'nothing' | 'cancelled' | 'failed';

/**
 * The project key that will be in effect AFTER `project init/set` writes
 * `writtenKey` into `<repoRoot>/.kireo/project.json`.
 *
 * Computed with resolveProjectKey's own precedence (shared/project-key.ts:
 * KIREO_PROJECT > <repoRoot>/.kireo/project.json > git remote > basename),
 * because the ctx-bucket refusal below has to decide BEFORE the file lands —
 * and refusing a switch that was never going to happen is exactly as wrong as
 * performing one silently. Two situations make the write a no-op:
 *
 *  - KIREO_PROJECT is set: the env pin outranks the file, so the key does not
 *    move no matter what is written.
 *  - There is no git repo root: level 2 only ever reads
 *    `<repoRoot>/.kireo/project.json`, so a marker written next to a non-repo
 *    cwd is written and then never read back.
 *
 * Reads `process.env`, not runCli's `opts.env`, on purpose: `resolveProjectHere`
 * reads `process.env`, and this value has to agree with what that returns or
 * the comparison it feeds is meaningless.
 */
function keyAfterPin(currentKey: string, writtenKey: string, cwd: string): string {
  const envPin = process.env.KIREO_PROJECT?.trim();
  if (envPin) return envPin;
  return repoRoot(cwd) === null ? currentKey : writtenKey;
}

export async function runCli(
  opts: { argv?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);

  // Help/version are handled FIRST — before any config validation, network, or
  // filesystem access — so they are idempotent, need no API key, and never index
  // the current directory by accident (BUG-004).
  if (argv[0] === 'help' || argv.some(isHelpToken)) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.some(isVersionToken)) {
    process.stdout.write(`${__KIREO_MCP_VERSION__}\n`);
    return;
  }

  const cmd = argv[0];

  if (cmd === 'index') {
    // Validate flags BEFORE loading config or touching the filesystem so an
    // unknown flag errors out (exit 1) instead of silently indexing the cwd.
    const { dir, repo, batchSize } = parseIndexArgs(argv);
    const root = resolve(dir);
    // The kill switch has to hold here, and this is the path where it never
    // did: `runIndex` POSTs every extracted symbol (name, signature, file path)
    // to /v1/memories/batch, so `KIREO_DISABLED=1 kireo index .` used to upload
    // a confidential repo's entire symbol table while the user believed the
    // switch had stopped everything.
    //
    // The vote belongs to `root` — the repo whose symbols are about to leave —
    // not merely to the cwd: `kireo index ~/secret-repo` run from anywhere else
    // must still obey ~/secret-repo/.kireo/disabled. The cwd is checked too, as
    // the same deliberate extra brake backfill's outer check applies.
    const outbound = openOutbound({
      argv,
      env: opts.env ?? process.env,
      dirs: [root, process.cwd()],
      what: 'kireo index',
      effect: '没有扫描代码，没有联网，一个符号都没有上传。',
    });
    // exit 0 — blocked sync, see openOutbound's EXIT CODE note.
    if (outbound === null) return;
    const { rest, logger } = outbound;
    const repoName = repo ?? basename(root);
    const project = resolveProjectHere(root);
    // spec §5.4: with no committed `.kireo/project.json`, KEEP the historical
    // `code-<repoSlug(basename)>` bucket and only print a migration hint —
    // silently switching names would orphan every symbol already indexed. An
    // explicit `--repo` is likewise an explicit request for that old naming.
    const namespace = repo !== undefined ? codeNamespace(repo) : project.codeNs;
    const summary = await runIndex({ rest, logger, root, repo: repoName, namespace, batchSize });
    process.stdout.write(
      `Indexed "${summary.repo}" -> namespace ${summary.namespace}\n` +
        `  files: ${summary.filesScanned} scanned, ${summary.filesChanged} changed, ${summary.filesDeleted} deleted\n` +
        `  symbols: ${summary.symbols} in ${summary.batches} batch(es)\n`,
    );
    if (repo === undefined && project.codeNsMigrationHint) {
      process.stdout.write(`\n提示：${project.codeNsMigrationHint}\n`);
    }
    return;
  }

  if (cmd === 'project') {
    const sub = argv[1] ?? 'info';
    const p = resolveProjectHere(process.cwd());
    if (sub === 'info') {
      const warnLine = p.warn ? `\n⚠️  ${p.warn}\n` : '';
      // `p.codeNs` is the bucket `kireo index` really writes from here, not the
      // pinned-style name. Printing the latter (as this used to) named a
      // namespace that never held any data — and `kireo project merge`'s help
      // text sends users to read the bucket name off exactly this output.
      const migrateLine = p.codeNsMigrationHint ? `\n⚠️  ${p.codeNsMigrationHint}\n` : '';
      process.stdout.write(
        `项目 = ${p.displayName}（来源: ${p.source}）\n  key       = ${p.key}\n  ctx 桶    = ${p.ctxNs}\n  code 桶   = ${p.codeNs}\n${warnLine}${migrateLine}`,
      );
      return;
    }
    if (sub === 'init' || sub === 'set') {
      const positional = argv.slice(2).filter((t) => !t.startsWith('--'));
      const key = sub === 'set' ? positional[0] : p.key;
      if (!key) {
        process.stderr.write('kireo project set <key>\n');
        process.exitCode = 1;
        return;
      }
      const root = repoRootOrCwd(process.cwd());
      const kireoDir = join(root, '.kireo');
      // `--migrate` now applies to `set` as well. It never did, so
      // `kireo project set <newkey> --migrate` accepted the flag and ignored
      // it — which is the one invocation that needs it most, because a new key
      // moves BOTH buckets at once.
      const migrateRequested = argv.includes('--migrate');
      const assumeYes = argv.includes('--yes') || argv.includes('-y');
      const selfCmd = `kireo project ${sub}${sub === 'set' ? ` ${key}` : ''}`;

      // --- The ctx bucket is decided BEFORE anything is written ------------
      //
      // The previous round disclosed the code-bucket switch. The same command
      // switches the CTX bucket too — the one `/kireo:resume` actually reads —
      // and that half is the one that cannot be undone. Code symbols are
      // derived data: `kireo index` regenerates them from the working tree.
      // Context cards are distilled from sessions that are already gone; no
      // command anywhere can produce them a second time.
      //
      // `kireo project set <newkey>` used to repoint that bucket in complete
      // silence — the output named only the code bucket, `--migrate` moved only
      // the code bucket, and there was no escape hatch afterwards either. The
      // user changed their project key once and their next resume was blank.
      //
      // So a ctx-bucket switch is REFUSED until the user says which outcome
      // they want. Refusal is measured against the key that will really be in
      // effect after the write (`keyAfterPin`), never against the raw argument.
      const nextCtxNs = ctxNamespace(keyAfterPin(p.key, key, process.cwd()), sha256Hex);
      if (nextCtxNs !== p.ctxNs && !migrateRequested && !assumeYes) {
        process.stderr.write(
          [
            `kireo project ${sub}: 拒绝执行 —— 这一步会把 ctx 桶换掉：`,
            `      旧桶：${p.ctxNs}  ← /kireo:save 存下来的上下文卡全在这里`,
            `      新桶：${nextCtxNs}  ← 换过去以后 resume 读这里，是空的`,
            '  ctx 桶就是 `/kireo:resume` 直接渲染的那批上下文卡。换桶之后下一次 resume 会是空白，',
            '  而这些卡是从会话里提炼出来的 —— 重跑 `kireo index` 也生不回来，跟代码符号不是一回事。',
            '',
            `  连数据一起搬过去：${selfCmd} --migrate`,
            `  就是要换个空桶、旧卡留在原地：${selfCmd} --yes`,
            '',
            '（什么都没写，.kireo/project.json 保持原样。）',
            '',
          ].join('\n'),
        );
        process.exitCode = 1;
        return;
      }

      // --- With `--migrate`, the outbound gate is a PRECONDITION -----------
      //
      // It used to sit further down, after project.json had already landed.
      // That put `KIREO_DISABLED=1 kireo project set <newkey> --migrate` in the
      // worst possible state: the key was pinned (so BOTH buckets had already
      // repointed), the disclosure above had just promised "下面就会把它原地
      // 改名搬过去", and then the gate aborted the migration and printed not one
      // fixup command. Rerunning the exact same command after clearing the
      // switch was then a no-op — `p.ctxNs` already equalled `after.ctxNs`, so
      // `jobs` came out empty and the run reported "桶名没有变化，不需要迁移。"
      // with exit 0. The old ctx bucket's name never appeared in any output
      // again, and context cards are the half that no re-index brings back.
      //
      // So: with `--migrate`, being stopped by the switch means NOTHING
      // happened — same contract as the ctx-switch refusal above. Clear the
      // switch, rerun the same command, and it is one clean full execution.
      //
      // Nothing below the gate depends on it having run late: `openOutbound`
      // only validates config and constructs a client, it sends nothing. The
      // pin and the rename stay in their original order (pin first, then
      // rename) for the runs that do proceed.
      const outbound = migrateRequested
        ? openOutbound({
            argv,
            env: opts.env ?? process.env,
            what: `${selfCmd} --migrate`,
            effect:
              '什么都没做：.kireo/project.json 保持原样，桶名没有换，也没有搬动任何桶。清掉开关后重跑同一条命令即可。',
          })
        : null;
      // exit 1 — blocked data move, see openOutbound's EXIT CODE note.
      if (migrateRequested && outbound === null) {
        process.exitCode = 1;
        return;
      }

      mkdirSync(kireoDir, { recursive: true });
      writeFileSync(
        join(kireoDir, 'project.json'),
        `${JSON.stringify({ project_key: key }, null, 2)}\n`,
      );
      writeKireoGitignore(kireoDir);
      process.stdout.write(
        [
          `已写入 ${join(kireoDir, 'project.json')}`,
          `同时写了 ${join(kireoDir, '.gitignore')}：**只有 project.json 和这个 .gitignore 该进 git**。`,
          '.kireo/ 里还躺着 index-state.json（本机代码索引状态）和 CONTEXT.md（提炼后的上下文正文）——',
          '把 index-state.json 提交上去，队友克隆后跑 kireo index 会算出"什么都没变"，代码索引静默为空；',
          'CONTEXT.md 则是本该经过预览闸门才离开这台设备的内容。',
          '请提交 .kireo/project.json —— 它跟着仓库走，是唯一 100% 跨设备稳定的标识来源。',
          '',
        ].join('\n'),
      );

      // Writing project.json PINS the key, and a pinned key is what makes
      // `resolveProjectHere` hand `kireo index` the hash-suffixed bucket
      // (spec §5.4[3]). So this command — which most users run just to fix
      // their project identity — silently repoints the code index at a
      // brand-new, empty namespace. That was invisible: the output above said
      // nothing about buckets, and `codeNsMigrationHint` goes null the moment
      // the key is pinned, so NOTHING would ever mention it again either. The
      // user's next resume just finds the code index gone.
      //
      // Say it, always, before anything else can hide it — for BOTH buckets.
      const after = resolveProjectHere(process.cwd());
      if (p.ctxNs !== after.ctxNs) {
        const lines = [
          '',
          '⚠️  ctx 桶（`/kireo:resume` 读上下文卡的那个 namespace）变了：',
          `      旧桶：${p.ctxNs}  ← 之前 save 存的上下文卡都还在这里`,
          `      新桶：${after.ctxNs}  ← 从现在起 save 写这里、resume 读这里，目前是空的`,
          '    旧桶里的上下文卡**不会自动搬过去**，而且它们是从会话里提炼出来的，重跑索引也生不回来。',
          // Safe to promise: with `--migrate` the outbound gate is already
          // open (see above), so the only thing that can still stop the move
          // is the server or the user's own "n" — and both of those paths
          // print the exact `kireo project merge` fixups at the end.
          migrateRequested
            ? '    下面就会把它原地改名搬过去。'
            : `    要搬：\`kireo project merge ${p.ctxNs} ${after.ctxNs}\``,
          '',
        ];
        process.stdout.write(lines.join('\n'));
      }
      if (p.codeNs !== after.codeNs) {
        const lines = [
          '',
          '⚠️  code 桶（`kireo index` 写代码符号的那个 namespace）变了：',
          `      旧桶：${p.codeNs}  ← 之前索引过的符号都还在这里`,
          `      新桶：${after.codeNs}  ← 从现在起 kireo index 写这里，目前是空的`,
        ];
        if (migrateRequested) {
          // Don't tell someone to run the flag they just ran. The migration
          // itself is printed immediately below this block.
          lines.push('    旧桶里的符号**不会自动搬过去** —— 下面就会把它原地改名搬过去。');
        } else {
          lines.push(
            `    旧桶里的符号**不会自动搬过去**。要搬：\`${selfCmd} --migrate\``,
            '    （服务端原地改名，不用重新索引、不消耗写配额）',
          );
          if (existsSync(join(kireoDir, 'index-state.json'))) {
            // The local state file is keyed by file path only — it has no idea
            // which namespace those hashes were uploaded to. So after the
            // switch a plain `kireo index` diffs against it, concludes "nothing
            // changed", uploads zero symbols, and leaves the new bucket empty
            // forever while printing a perfectly healthy summary.
            lines.push(
              '    另外：这台机器上已经有 .kireo/index-state.json（只记「哪些文件索引过」，不记桶名），',
              '    所以不迁移的话直接跑 `kireo index` 会算出「什么都没变」、一个符号也不会补进新桶。',
              '    不想迁移就删掉 .kireo/index-state.json 再跑一次 `kireo index`（全量重传）。',
            );
          }
        }
        lines.push('');
        process.stdout.write(lines.join('\n'));
      }

      // `outbound !== null` is exactly `migrateRequested && the gate opened`;
      // the blocked case returned above without writing anything.
      if (outbound !== null) {
        // spec §5.4[3]: the marker file now exists, so `kireo index` switches to
        // the hash-suffixed bucket. Rename the old buckets in place instead of
        // making the user re-index (and instead of stranding everything already
        // uploaded under the old names).
        //
        // BOTH buckets, ctx first. `--migrate` used to move only the code
        // bucket, which left the irreplaceable half — the context cards resume
        // renders — with no migration path at all. ctx goes first precisely
        // because it is the half that cannot be regenerated: if only one of the
        // two lands, it must be that one.
        //
        // The source of the code move is `p.codeNs` — what `kireo index`
        // actually wrote from here — not `p.codeNsLegacy`. They are the same
        // string for an unpinned repo (the `init` case), but for
        // `project set <newkey>` on an ALREADY pinned repo the old bucket is
        // the previous key's hash-suffixed name, and migrating from the
        // basename-derived legacy name would move a bucket that never existed
        // while stranding the one that does.
        const jobs: { label: string; from: string; to: string }[] = [];
        if (p.ctxNs !== after.ctxNs) jobs.push({ label: 'ctx 桶', from: p.ctxNs, to: after.ctxNs });
        if (p.codeNs !== after.codeNs) {
          jobs.push({ label: 'code 桶', from: p.codeNs, to: after.codeNs });
        }
        if (jobs.length === 0) {
          // Reachable ONLY as a genuine no-op (`project init --migrate` on an
          // already-pinned repo). It can no longer be reached by "the gate ate
          // the migration but kept the pin", which is what turned this line
          // into a false success report for the one command that could still
          // have rescued the old buckets.
          process.stdout.write('桶名没有变化，不需要迁移。\n');
          return;
        }
        type Job = { label: string; from: string; to: string };
        const moved: Job[] = [];
        // "there was no old bucket" is neither a move nor a failure, and
        // calling it 已经搬完 would claim data changed hands that never existed.
        const empty: Job[] = [];
        const failed: Job[] = [];
        for (const job of jobs) {
          process.stdout.write(`\n迁移 ${job.label}：${job.from} → ${job.to}\n`);
          const outcome = await runProjectMerge({
            rest: outbound.rest,
            from: job.from,
            to: job.to,
            assumeYes,
            missingSourceOk: true,
            label: job.label,
          });
          if (outcome === 'cancelled') {
            // They said no to this bucket; asking again for the next one is
            // just nagging. Stop — `pending` below picks up this job and every
            // job after it from `jobs`, so the report still names them.
            break;
          }
          if (outcome === 'failed') failed.push(job);
          else if (outcome === 'nothing') empty.push(job);
          else moved.push(job);
        }

        // Partial outcomes are REPORTED, never swallowed. The two renames are
        // independent server-side operations (one PATCH /v1/namespaces/:name
        // and one async task each) with no transaction spanning them, so
        // "ctx moved, code did not" is a state this genuinely ends in. When it
        // does, say which bucket is where and print the exact command that
        // finishes the job — and exit non-zero, so no script reads a
        // half-migration as success. A failed rename moves nothing: the old
        // bucket's data is still sitting in the old bucket.
        //
        // `pending` = everything that did not land: the buckets whose rename
        // was rejected, plus (when the user answered n) the one they declined
        // and every job after it. A rejection outranks a cancellation — if any
        // bucket actually failed, this is a failed run and exits 1, no matter
        // what the user answered for the next one.
        const pending = failed.concat(jobs.slice(moved.length + empty.length + failed.length));
        if (pending.length > 0) {
          const movedLine =
            moved.length > 0 ? `  已经搬完的：${moved.map((j) => j.label).join('、')}\n` : '';
          const fixups = pending
            .map((j) => `      kireo project merge ${j.from} ${j.to}   # ${j.label}`)
            .join('\n');
          const stuck = pending.map((j) => j.label).join('、');
          const head =
            failed.length > 0
              ? `\n⚠️  迁移只完成了一部分：${stuck}没搬成。\n`
              : `\n已取消：${stuck}没有搬。\n`;
          const body =
            '  两个桶是两次相互独立的服务端改名，中间没有跨桶事务，所以这种半完成状态是真会出现的。\n' +
            '  没搬成的那个，旧数据原封不动还在旧桶里（改名失败不会删数据）。补搬：\n';
          const text = `${head}${movedLine}${body}${fixups}\n`;
          if (failed.length > 0) {
            process.stderr.write(text);
            process.exitCode = 1;
          } else process.stdout.write(text);
        }
      }
      return;
    }
    if (sub === 'merge') {
      const positionals = argv.slice(2).filter((t) => !t.startsWith('--'));
      const [from, to] = positionals;
      if (!from || !to) {
        process.stderr.write(
          'kireo project merge <from> <to> [--yes]\n' +
            '  把 <from> 这个 namespace 里的所有条目搬进 <to>。用 `kireo doctor` 查当前项目的桶名。\n',
        );
        process.exitCode = 1;
        return;
      }
      const outbound = openOutbound({
        argv,
        env: opts.env ?? process.env,
        what: 'kireo project merge',
        effect: '没有联网，没有动过任何 namespace。',
      });
      // exit 1 — blocked data move, see openOutbound's EXIT CODE note.
      if (outbound === null) {
        process.exitCode = 1;
        return;
      }
      const outcome = await runProjectMerge({
        rest: outbound.rest,
        from,
        to,
        assumeYes: argv.includes('--yes') || argv.includes('-y'),
      });
      if (outcome === 'failed') process.exitCode = 1;
      return;
    }
    process.stderr.write(`kireo project: unknown subcommand "${sub}"\n`);
    process.exitCode = 1;
    return;
  }

  if (cmd === 'doctor') {
    // Config failure is a FINDING, not a crash: "the key is missing" is one
    // of the things a user runs doctor to be told. So loadConfig's throw is
    // captured and handed to the report, and every network check downgrades
    // to `skip` instead of the command dying before it can say anything about
    // the transcript formats, the project identity, or the outbox — none of
    // which need an API key at all.
    //
    // Doctor is also the ONE command exempt from `openOutbound`'s kill-switch
    // gate, and therefore the only other place in this file allowed to call
    // `createRestClient` directly. That is the whole point of it: with
    // `.kireo/disabled` or KIREO_DISABLED in play every other command goes
    // quiet, and "why did nothing happen" is exactly the question this command
    // answers — it reports the switch as a check of its own (doctor.ts's
    // `kill-switch`). A doctor that refused to run while the switch was on
    // would leave the user with no way to discover that the switch was on.
    let rest: RestClient | null = null;
    let configError: string | null = null;
    let apiUrl: string | undefined;
    try {
      const { config } = loadConfig({ argv, env: opts.env ?? process.env });
      apiUrl = config.apiUrl;
      const logger = createLogger(config);
      const deviceId = deviceIdOrAnon(config.telemetryEnabled);
      rest = createRestClient({ config, deviceId, version: __KIREO_MCP_VERSION__, logger });
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
    const report = await runDoctor({
      rest,
      configError,
      apiUrl,
      cwd: process.cwd(),
      env: opts.env ?? process.env,
      homeDir: homeDir(),
      outboxDir: `${homeDir()}/.kireo/outbox`,
      fs: {
        readDir: (p: string) => fsReaddir(p),
        readFile: (p: string) => fsReadFile(p, 'utf8'),
        stat: (p: string) => fsStat(p),
      },
    });
    process.stdout.write(formatDoctorReport(report));
    if (report.failed > 0) process.exitCode = 1;
    return;
  }

  if (cmd === 'resume') {
    // BOTH halves of resume are outbound, and only one of them was covered.
    // `contextLoadTool` checks the switch itself (it has to — MCP hosts call it
    // directly), but `--all` never reaches that tool: it goes straight to
    // `listHomeCards`, i.e. a live GET against the cross-project `kireo-home`
    // bucket. Gating here covers both halves, and covers them before a client
    // exists at all.
    const outbound = openOutbound({
      argv,
      env: opts.env ?? process.env,
      what: 'kireo resume',
      effect: '没有联网取回任何上下文，也没有补传本地积压的 outbox。',
    });
    // exit 0 — blocked sync, see openOutbound's EXIT CODE note.
    if (outbound === null) return;
    const { rest, logger } = outbound;

    if (argv.includes('--all')) {
      // Cross-project overview: does not depend on cwd at all, on purpose —
      // "which project was I in" is exactly the question a bare `resume --all`
      // is for. Reads the fixed kireo-home bucket (see context/home.ts).
      const cards = await listHomeCards(rest);
      if (cards.length === 0) {
        process.stdout.write('还没有任何项目的摘要卡。先在某个项目里跑一次 /kireo:save。\n');
        return;
      }
      const top = cards.slice(0, 5);
      const lines = [`你最近 ${top.length} 个项目：`];
      for (const c of top) {
        lines.push(`  ${c.displayName.padEnd(15)}${formatAgeZh(c.ts).padEnd(6)}${c.headline}`);
      }
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }

    // `contextLoadTool`'s input has a zod `.default()` on `token_budget`, so its
    // handler's inferred input type requires it; go through `tool.zod.parse`
    // (the same validation `server.ts` runs before every dispatch) to fill it in.
    const res = await contextLoadTool.handler(contextLoadTool.zod.parse({}), { rest, logger });
    const text = res.content.map((c) => (c as { text: string }).text).join('');
    process.stdout.write(`${text}\n`);
    return;
  }

  if (cmd === 'backfill') {
    let sinceRaw: string | undefined;
    // `--dry-run` is the default; only an explicit `--dry-run=false` performs
    // a real upload — same "affirmative signal" philosophy as context_save's
    // `dry_run` (see context-save.ts).
    let dryRun = true;
    for (let i = 1; i < argv.length; i++) {
      const tok = argv[i];
      if (tok === undefined) continue;
      if (tok === '--since') {
        sinceRaw = argv[++i];
        continue;
      }
      if (tok.startsWith('--since=')) {
        sinceRaw = tok.slice('--since='.length);
        continue;
      }
      if (tok === '--dry-run' || tok === '--dry-run=true') {
        dryRun = true;
        continue;
      }
      if (tok === '--dry-run=false') {
        dryRun = false;
        continue;
      }
      throw new Error(`unknown flag "${tok}" for 'kireo backfill'.\n${USAGE_HINT}`);
    }
    const since = parseSinceFlag(sinceRaw);

    // The kill switch has to hold HERE too, and it has to hold before the scan.
    // `.kireo/disabled` / KIREO_DISABLED is documented (and described by
    // context_save's own tool description) as "kireo stops sending anything
    // out", but only context_save consulted it — while backfill is by far the
    // largest outbound path in the product: it walks EVERY project under
    // ~/.claude/projects and ~/.codex/sessions and uploads raw session text,
    // not distilled cards. A user who set the switch in a confidential repo and
    // then ran `kireo backfill --dry-run=false` shipped that repo's sessions
    // anyway.
    //
    // This is the OUTER check: KIREO_DISABLED, plus "you are standing in a
    // disabled repo" (a deliberate extra brake). It is NOT sufficient on its
    // own — it only sees the current directory, and `cd ~ && kireo backfill`
    // has no current project. The per-session gate below is what actually
    // enforces each project's own switch; see `privacyGate`.
    const outbound = openOutbound({
      argv,
      env: opts.env ?? process.env,
      what: 'kireo backfill',
      effect: '一个会话都没有扫描，没有联网，没有上传任何内容。',
    });
    // exit 0 — blocked sync, see openOutbound's EXIT CODE note.
    if (outbound === null) return;
    const { rest } = outbound;

    /**
     * The directory a discovered session actually ran in, or null when that
     * cannot be established.
     *
     * This answers two questions at once — which bucket the session belongs in
     * and whose kill switch governs it — and it has to, because answering them
     * from different sources is how a session gets filed under one project
     * while another project's privacy setting is consulted.
     *
     * ONLY the transcript's own recorded absolute cwd counts (see
     * `backfill.ts#sessionCwd`; both hosts write it). The cwd-slug is
     * deliberately NOT reversed as a fallback: `slugifyCwd` collapses every
     * run of non-alphanumerics to a single `-`, so `/Users/me/my-app` and
     * `/Users/me/my/app` produce the same slug and `/Users/me/项目` becomes
     * `-Users-me-` — whose only plausible reversal, `/Users/me/`, is a
     * directory that almost certainly exists and is almost certainly the wrong
     * one. Guessing there would mean reading some other project's
     * `.kireo/disabled` and calling the answer authoritative, which is a worse
     * bug than the one being fixed. Unknown means unknown.
     *
     * Used for BOTH the bucket a session lands in and the kill-switch lookup,
     * on purpose — filing a session under one project while consulting another
     * project's privacy setting is exactly the failure this whole change is
     * about.
     */
    const projectDirOf = (item: BackfillItem): string | null =>
      item.cwd && existsSync(item.cwd) ? item.cwd : null;

    /**
     * Which bucket a backfilled session belongs in.
     *
     * `ctxNamespace(cwdSlug)` — what this used to do unconditionally — can
     * NEVER equal the bucket that project's `/kireo:resume` reads: the h6
     * suffix is sha256 of the whole key, and `-Users-me-proj` is not the
     * canonical git key. Not "no guarantee of a match", a guaranteed mismatch.
     * So every upload was write-only: quota and storage spent, buckets created
     * against the free plan's cap of 3, and nothing readable anywhere. The
     * project resolved from the transcript's own cwd is what a live save in
     * that directory would compute, which is the whole point.
     *
     * The slug fallback below is unreachable while `privacyGate` skips every
     * session whose project it cannot identify — kept as a defensive default
     * so this function never has to throw.
     */
    const namespaceFor = (item: BackfillItem): string => {
      const dir = projectDirOf(item);
      return dir ? resolveProjectHere(dir).ctxNs : ctxNamespace(item.cwdSlug, sha256Hex);
    };

    // --- Per-session kill switch ---------------------------------------------
    //
    // The switch belongs to the project whose sessions are about to be
    // uploaded, NOT to the directory kireo was launched from. Deciding it once
    // from `process.cwd()` (which is all the code above used to do) meant
    // `cd ~ && kireo backfill --dry-run=false` uploaded months of a
    // confidential repo's transcripts with that repo's `.kireo/disabled` file
    // sitting right there — the comment on the outer check described exactly
    // that failure while the implementation checked the wrong directory.
    //
    // Hits are skipped per session, so one disabled project never fails or
    // silently widens the rest of the run; the summary reports the count.
    const killSwitchEnv = opts.env ?? process.env;
    const disabledByRoot = new Map<string, boolean>();
    const disabledRoots = new Set<string>();
    const unresolvedPaths = new Set<string>();
    const privacyGate = (item: BackfillItem): SessionPrivacyVerdict => {
      const dir = projectDirOf(item);
      if (dir === null) {
        // Fail SAFE. We cannot read a marker file in a directory we cannot
        // name, and "we could not tell" must never mean "so we sent it".
        // Costs the run any session that recorded no cwd, or whose directory
        // has since been deleted or moved; that is reported, not silent.
        unresolvedPaths.add(item.path);
        return 'unresolved';
      }
      const root = repoRootOrCwd(dir);
      let hit = disabledByRoot.get(root);
      if (hit === undefined) {
        hit = isDisabled(root, killSwitchEnv);
        disabledByRoot.set(root, hit);
      }
      if (hit) {
        disabledRoots.add(root);
        return 'disabled';
      }
      return 'allow';
    };

    /** The "what did NOT get sent, and why" half of the summary. */
    const privacyReport = (res: { privacySkipped: number; unresolvedSkipped: number }): string => {
      const lines: string[] = [];
      if (res.privacySkipped > 0) {
        const roots = [...disabledRoots];
        const shown = roots.slice(0, 3).join('、');
        const more = roots.length > 3 ? ` 等 ${roots.length} 个项目` : '';
        lines.push(
          `🔒 跳过 ${res.privacySkipped} 个（隐私开关）：这些会话所属项目里有 .kireo/disabled，` +
            `一个字节都没上传。涉及 ${shown}${more}`,
        );
      }
      if (res.unresolvedSkipped > 0) {
        const shown = [...unresolvedPaths].slice(0, 3);
        const more = unresolvedPaths.size > 3 ? `\n      …等 ${unresolvedPaths.size} 个文件` : '';
        const why = [
          '会话里没记下自己跑在哪个目录，或那个目录已经不在了。',
          '目录名的 slug 是有损的（非字母数字全压成 "-"，中文路径会塌成 "-Users-me-"），',
          '反推出来的可能是另一个项目，所以不猜。',
          '读不到那个项目的 .kireo/disabled，就按「可能被禁用」处理，跳过：',
        ].join('');
        lines.push(
          `❓ 跳过 ${res.unresolvedSkipped} 个（无法确认所属项目）：${why}\n      ${shown.join('\n      ')}${more}`,
        );
      }
      return lines.length > 0 ? `${lines.join('\n')}\n` : '';
    };

    // Uploads one already-parsed session as a raw (redacted) record in that
    // project's ctx bucket.
    const post = async (item: BackfillItem): Promise<void> => {
      const ns = namespaceFor(item);
      // backfillBody() — never an inline copy of it. The confirmation gate
      // below prints the output of this same call, so what the user approves
      // and what this uploads are the same bytes by construction.
      const content = backfillBody(item);
      await rest.request({
        method: 'POST',
        path: '/v1/memories',
        body: {
          content,
          type: 'event',
          namespace: ns,
          tags: ['kireo-ctx', 'k-backfill'],
          metadata: { source: 'backfill', host: item.host, path: item.path },
        },
      });
      // Outbound audit covers THIS path too. It is the biggest volume of
      // content leaving the device in the whole product, and it was the one
      // path writing nothing to ~/.kireo/logs/outbound.jsonl — spec §10.2's
      // append-only record had a hole exactly where it mattered most.
      appendOutboundAudit(join(homeDir(), '.kireo', 'logs', 'outbound.jsonl'), {
        ts: new Date().toISOString(),
        namespace: ns,
        count: 1,
        digests: outboundDigests([{ content, metadata: { files: [item.path] } }]),
      });
    };

    const fsDeps = {
      readDir: (p: string) => fsReaddir(p),
      readFile: (p: string) => fsReadFile(p, 'utf8'),
      stat: (p: string) => fsStat(p),
    };

    if (!dryRun) {
      // Same gate as context_save's dry-run: before anything leaves this
      // device, print the exact (post-redaction) text and require an
      // explicit confirmation.
      const preview: string[] = [];
      const dry = await runBackfill({
        since,
        homeDir: homeDir(),
        ...fsDeps,
        dryRun: true,
        post,
        privacyGate,
        onParsed: (item) => {
          // Exactly what `post` will send — same function, so the claim two
          // lines down ("已做已知凭据脱敏") is true of the printed text and not
          // just of the uploaded text. This used to print `item.turns` raw:
          // unredacted, untruncated, and therefore a way for a `ghp_…` in a
          // 3-month-old session to land in the terminal scrollback of a user
          // who had just been told credentials were scrubbed.
          preview.push(`--- ${item.path} (${item.host}) ---\n${backfillBody(item)}`);
        },
      });
      if (dry.processed === 0) {
        // Never let a privacy skip masquerade as "there was nothing here".
        process.stdout.write(
          `没有可回填的会话（时间窗口内没有能解析出内容的记录）。\n${privacyReport(dry)}`,
        );
        return;
      }
      process.stdout.write(
        `${preview.join('\n\n')}\n\n以上是即将原样发往 kireo 的 ${dry.processed} 条会话正文（已做已知凭据脱敏，未做业务机密判断）。\n`,
      );
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer: string;
      try {
        answer = await rl.question('确认继续上传？(y/N) ');
      } finally {
        rl.close();
      }
      if (!/^y(es)?$/i.test(answer.trim())) {
        process.stdout.write('已取消，未上传任何内容。\n');
        return;
      }
    }

    const result = await runBackfill({
      since,
      homeDir: homeDir(),
      ...fsDeps,
      dryRun,
      post,
      privacyGate,
    });
    const verb = dryRun ? '预览' : '回填';
    const errLines =
      result.errors.length > 0 ? `${result.errors.map((e) => `  - ${e}`).join('\n')}\n` : '';
    // `skipped` now covers two different failures, and calling an upload
    // rejection "格式无法识别" would be the same kind of lie the preview used
    // to tell, so name them apart.
    const skipParts: string[] = [];
    if (result.uploadFailed > 0) skipParts.push(`${result.uploadFailed} 个上传失败`);
    if (result.privacySkipped > 0) skipParts.push(`${result.privacySkipped} 个隐私开关`);
    if (result.unresolvedSkipped > 0) {
      skipParts.push(`${result.unresolvedSkipped} 个无法确认所属项目`);
    }
    const unexplained =
      result.skipped - result.uploadFailed - result.privacySkipped - result.unresolvedSkipped;
    // Only ever name a residue that exists. `skipParts.length === 0` alone used
    // to qualify, so a completely clean run printed "跳过 0 个（0 个格式无法识别）"
    // — a breakdown of nothing.
    if (unexplained > 0 || (result.skipped > 0 && skipParts.length === 0)) {
      skipParts.push(`${unexplained} 个格式无法识别`);
    }
    const skipDetail = skipParts.length > 0 ? `（${skipParts.join('，')}）` : '';
    process.stdout.write(
      `${verb}完成：处理 ${result.processed} 个会话，跳过 ${result.skipped} 个${skipDetail}。\n` +
        `${privacyReport(result)}${errLines}`,
    );
    if (!dryRun && result.processed > 0) {
      // Say plainly what these are and are not. They are raw session text
      // (tagged `k-backfill`), not entries from the distillation pipeline, so
      // `/kireo:resume` deliberately does not render them — one 8000-character
      // card would otherwise consume an entire resume's token budget in a
      // single bullet. They ARE searchable in the project's own ctx bucket.
      process.stdout.write(
        '这些是会话原文（tag: k-backfill），已存进各项目的 ctx 桶，可以用 memory_search 或 https://app.kireo.app 检索。\n' +
          'resume 只渲染经过提炼的条目，不会展示它们。\n',
      );
    }
    // runBackfill no longer throws on a failed upload, so without this a run
    // where all 47 POSTs were rejected would exit 0 and look successful to any
    // script — trading a loud crash for a silent lie. Format-level skips stay
    // exit 0: they are the documented "one bad file" case, not a failed run.
    if (result.uploadFailed > 0) process.exitCode = 1;
    return;
  }

  // Anything that looks like a subcommand and reached here is a mistake, and
  // must SAY so.
  //
  // Gating this on KNOWN_COMMANDS only caught commands that were listed but
  // unimplemented — a typo (`kireo idnex .`, `kireo resmue`) fell through to
  // the stdio server, which prints nothing and never exits: the process just
  // sits waiting for MCP frames on stdin until Ctrl-C. Verified: `runCli({argv:
  // ['idnex']})` called startServer once and wrote zero bytes to stdout and
  // stderr. spec §12.2 asks for exactly this ("每个新子命令都不得 fallback 成
  // server"), and the comment below has always said silently becoming an MCP
  // server is the worst possible failure mode for a CLI.
  //
  // Leading `-` still falls through on purpose: hosts launch the server as
  // `kireo --api-key … --namespace …`, and loadConfig validates those.
  if (cmd !== undefined && !cmd.startsWith('-')) {
    const known = (KNOWN_COMMANDS as readonly string[]).includes(cmd);
    process.stderr.write(
      known
        ? `kireo: subcommand "${cmd}" is not implemented yet\n`
        : `kireo: unknown subcommand "${cmd}"\n${USAGE_HINT}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Default behaviour: act as the MCP stdio server.
  await startServer(opts);
}
