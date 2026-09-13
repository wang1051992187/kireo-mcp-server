/**
 * `kireo doctor` — the one place a silent breakage can surface.
 *
 * Almost every failure mode of the context relay is quiet by construction:
 *
 * - A host changes its on-disk transcript format and every parse yields zero
 *   turns, which is indistinguishable from "the session was empty". Codex
 *   already did this once INSIDE a single 0.14x minor line (the retired
 *   `payload.type == 'user_message'` shape occurs zero times in current
 *   rollouts; the live shape is `event_msg` → `payload.item.type ==
 *   'UserMessage' | 'AgentMessage'`). Nothing else in the product notices.
 * - The API changes a response envelope and the relay's readers silently see
 *   an empty list instead of an error.
 * - The project key falls back to the directory basename, so the same repo
 *   splits into two buckets across machines and each looks "empty but fine".
 * - The outbox quietly accumulates because every upload is failing.
 * - The write quota runs out and saves become no-ops with a friendly message.
 *
 * So doctor's job is not "ping the API". It is to run the real parsers over
 * real files on this machine, to name the resolved identity out loud, and to
 * make every degraded-but-silent state loud. Every check returns a status and
 * a human-readable line; nothing here throws.
 */
import { HOME_NAMESPACE, PLAN_CONFIG } from '@kireo/shared';
import { type IndexHeadScope, readIndexHead } from '../index/index-head.js';
import { RestApiError } from '../lib/errors.js';
import type { RestClient } from '../rest/client.js';
import type { BackfillFsDeps } from './backfill.js';
import { listOutbox } from './outbox.js';
import { repoRootOrCwd, resolveProjectHere } from './project.js';
import { isDisabled } from './redact.js';
import {
  TranscriptFormatError,
  type TranscriptHost,
  parseClaudeTranscript,
  parseCodexRollout,
} from './transcript.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  /** Stable machine id, safe to grep for in a bug report. */
  id: string;
  /** Human label (Chinese, like the rest of the CLI's user-facing output). */
  title: string;
  status: DoctorStatus;
  detail: string;
  /** What to do about it. Only set when there is something to do. */
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  failed: number;
  warned: number;
}

export interface DoctorDeps {
  /** null when the config failed to load — the config check reports why. */
  rest: RestClient | null;
  /** Message from a failed `loadConfig`; null/undefined when config is fine. */
  configError?: string | null;
  /** Resolved API base URL, for the config line. */
  apiUrl?: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  outboxDir: string;
  fs: BackfillFsDeps;
  now?: Date;
}

/**
 * Which response key the context relay's list readers dereference.
 *
 * `context-load.ts`, `context/home.ts` and `index/index-head.ts` all read
 * `res.items` from `GET /v1/memories`. If the API ever answers under a
 * different key those three degrade to "this project has no saved context"
 * (or, for context-load, throw a bare TypeError) with no other signal — which
 * is exactly the kind of silent break this command exists to catch, so the
 * expectation is asserted here against the live API rather than only against
 * a mock in a unit test.
 *
 * It said `'data'` while the server has always answered `{ items, next_cursor }`
 * — this constant was itself the drift it was written to detect, and would
 * have reported `fail` on its very first run against production.
 */
const EXPECTED_LIST_KEY = 'items';

/** How many recent transcripts to try before declaring a host unparseable. */
const TRANSCRIPT_SAMPLE_SIZE = 3;

const CLAUDE_SESSION_ROOT = '.claude/projects';
const CODEX_SESSION_ROOT = '.codex/sessions';

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Every `*.jsonl` under `dir`, newest first. A missing dir yields []. */
async function newestJsonl(
  fs: BackfillFsDeps,
  dir: string,
  acc: { path: string; mtimeMs: number }[] = [],
): Promise<{ path: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await fs.readDir(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    const full = `${dir}/${name}`;
    let st: { isDirectory: () => boolean; mtimeMs: number };
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) await newestJsonl(fs, full, acc);
    else if (name.endsWith('.jsonl')) acc.push({ path: full, mtimeMs: st.mtimeMs });
  }
  return acc.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Run a host's real parser over its most recent transcripts on this machine.
 *
 * This is the whole point of the command. A format break does not raise
 * anywhere in normal operation — `runBackfill` catches `TranscriptFormatError`
 * per file and moves on (correctly: one bad file must not lose the other 46),
 * so the ONLY place the error is ever shown to a human is here.
 *
 * Sampling several files matters: the newest file may be a live session whose
 * only line so far is the session header, which parses to zero turns without
 * throwing. "Nothing said yet" and "we can no longer read this host" must not
 * come out the same, so a host is only declared broken when every sampled
 * file raised a format error, and only declared quiet when none did.
 */
async function probeTranscripts(
  fs: BackfillFsDeps,
  host: TranscriptHost,
  root: string,
  parse: (jsonl: string) => { role: string; text: string }[],
): Promise<DoctorCheck> {
  const id = `transcript-${host}`;
  const title = `${host} 会话格式`;
  const files = (await newestJsonl(fs, root)).slice(0, TRANSCRIPT_SAMPLE_SIZE);
  if (files.length === 0) {
    return {
      id,
      title,
      status: 'skip',
      detail: `这台机器上没有找到 ${host} 的会话记录（${root}）`,
    };
  }

  const formatErrors: string[] = [];
  let emptyOrUnreadable = 0;
  for (const f of files) {
    try {
      const turns = parse(await fs.readFile(f.path));
      if (turns.length > 0) {
        return {
          id,
          title,
          status: 'ok',
          detail: `用真实文件解析通过：${f.path} → ${turns.length} 轮`,
        };
      }
      emptyOrUnreadable++;
    } catch (err) {
      if (err instanceof TranscriptFormatError) formatErrors.push(`${f.path}：${err.message}`);
      else emptyOrUnreadable++;
    }
  }

  if (formatErrors.length > 0) {
    return {
      id,
      title,
      status: 'fail',
      // The message already carries the observed line types — that string is
      // the actual diagnostic payload, so it is passed through, not summarised.
      detail: `采样 ${files.length} 个文件，${formatErrors.length} 个解析失败：\n    ${formatErrors.join('\n    ')}`,
      hint: `${host} 很可能改了磁盘格式。先 \`npm i -g @kireo/mcp-server@latest\`；若仍失败，把上面的"观察到的行类型"贴进 issue —— context_save 与 backfill 在这个宿主上已经读不到任何内容了。`,
    };
  }

  return {
    id,
    title,
    status: 'warn',
    detail: `采样了 ${files.length} 个最新文件，都没解析出对话轮次（${emptyOrUnreadable} 个空/不可读）`,
    hint: '可能只是这几个会话还没说话。先跟宿主聊两句再跑一次 doctor；如果依旧为空，就按格式断裂处理。',
  };
}

/** GET /v1/health — is the API reachable at all. */
async function checkApi(rest: RestClient): Promise<DoctorCheck> {
  try {
    const res = await rest.request<{ ok?: boolean }>({ method: 'GET', path: '/v1/health' });
    return res?.ok === true
      ? { id: 'api', title: 'API 可达性', status: 'ok', detail: '/v1/health → ok' }
      : {
          id: 'api',
          title: 'API 可达性',
          status: 'warn',
          detail: `/v1/health 返回了非 ok 的响应：${JSON.stringify(res)}`,
        };
  } catch (err) {
    return {
      id: 'api',
      title: 'API 可达性',
      status: 'fail',
      detail: `/v1/health 请求失败：${reason(err)}`,
      hint: '检查 KIREO_API_URL、网络与代理（KIREO_PROXY_URL）。API 不通时 save 会全部落进本地 outbox。',
    };
  }
}

interface MeResponse {
  plan?: string;
  status?: string;
  quotas?: { writes?: number; reads?: number; memories?: number; storageBytes?: number };
  usage?: { writes?: number; reads?: number; memories?: number; storage_bytes?: number };
}

const pct = (used: number, limit: number): number => (limit > 0 ? used / limit : 0);

/** GET /v1/me — proves the key is valid AND reports what quota is left. */
async function checkAuthAndQuota(rest: RestClient): Promise<DoctorCheck[]> {
  let me: MeResponse;
  try {
    me = await rest.request<MeResponse>({ method: 'GET', path: '/v1/me' });
  } catch (err) {
    const code = err instanceof RestApiError ? err.code : '';
    const invalidKey =
      err instanceof RestApiError && (err.httpStatus === 401 || String(code).startsWith('AUTH_'));
    return [
      {
        id: 'auth',
        title: 'API key 有效性',
        status: 'fail',
        detail: invalidKey
          ? `密钥被拒绝（${code}）：${reason(err)}`
          : `/v1/me 请求失败：${reason(err)}`,
        ...(invalidKey
          ? {
              hint: '去 https://app.kireo.app/app/api-keys 重新签发，然后更新 KIREO_API_KEY（或宿主插件里配置的那份）。',
            }
          : {}),
      },
      { id: 'quota', title: '配额余量', status: 'skip', detail: '拿不到 /v1/me，跳过' },
    ];
  }

  const auth: DoctorCheck = {
    id: 'auth',
    title: 'API key 有效性',
    status: me.status === 'active' || me.status === undefined ? 'ok' : 'warn',
    detail: `plan=${me.plan ?? '?'} status=${me.status ?? '?'}`,
    ...(me.status && me.status !== 'active'
      ? { hint: '账号不是 active（冻结/待删除），写入会被拒。' }
      : {}),
  };

  const q = me.quotas ?? {};
  const u = me.usage ?? {};
  const writesLimit = q.writes ?? 0;
  const memLimit = q.memories ?? 0;
  const writesUsed = u.writes ?? 0;
  const memUsed = u.memories ?? 0;
  const worst = Math.max(pct(writesUsed, writesLimit), pct(memUsed, memLimit));
  // A namespace count is not in /v1/me; the plan cap is still worth printing
  // because "free = 1 project" is the limit users actually hit first.
  const nsCap =
    me.plan === 'pro' || me.plan === 'max'
      ? PLAN_CONFIG.pro.namespaces
      : PLAN_CONFIG.free.namespaces;
  const quota: DoctorCheck = {
    id: 'quota',
    title: '配额余量',
    status: worst >= 1 ? 'fail' : worst >= 0.9 ? 'warn' : 'ok',
    detail:
      `本月写入 ${writesUsed}/${writesLimit} · 条目 ${memUsed}/${memLimit}` +
      ` · 该档 namespace 上限 ${nsCap}（一个项目占 ctx+code 两个桶，另加共享的 ${HOME_NAMESPACE}）`,
    ...(worst >= 0.9
      ? {
          hint: '配额打满后 context_save 会被 API 拒绝，内容只会留在本地 outbox。到 https://app.kireo.app 升级或清理。',
        }
      : {}),
  };
  return [auth, quota];
}

/**
 * Probe the list endpoint's response envelope.
 *
 * See EXPECTED_LIST_KEY: this asserts a client-side assumption against the
 * live server instead of against a mock, because every unit test in this
 * package supplies the shape the client already believes in.
 */
async function checkListEnvelope(rest: RestClient, namespace: string): Promise<DoctorCheck> {
  const id = 'list-envelope';
  const title = 'GET /v1/memories 响应契约';
  let res: Record<string, unknown>;
  try {
    res = await rest.request<Record<string, unknown>>({
      method: 'GET',
      path: `/v1/memories?namespace=${encodeURIComponent(namespace)}&limit=1`,
    });
  } catch (err) {
    return { id, title, status: 'warn', detail: `探测失败：${reason(err)}` };
  }
  if (res && typeof res === 'object' && Array.isArray(res[EXPECTED_LIST_KEY])) {
    return { id, title, status: 'ok', detail: `列表数组在 \`${EXPECTED_LIST_KEY}\` 字段下` };
  }
  const arrayKeys = Object.entries(res ?? {})
    .filter(([, v]) => Array.isArray(v))
    .map(([k]) => k);
  return {
    id,
    title,
    status: 'fail',
    detail: `客户端读的是 \`${EXPECTED_LIST_KEY}\`，但响应里的数组字段是 ${
      arrayKeys.length > 0 ? arrayKeys.map((k) => `\`${k}\``).join(' / ') : '（没有数组字段）'
    }（响应键：${Object.keys(res ?? {}).join(', ') || '无'}）`,
    hint: 'context_load / resume --all / 索引锚点都会读到空 —— 这三处（tools/context-load.ts、context/home.ts、index/index-head.ts）与 API 的返回字段对不上，升级 @kireo/mcp-server；若已是最新版请提 issue。',
  };
}

/** Read the commit anchor for this project's ctx bucket and age it. */
async function checkIndexHead(
  rest: RestClient,
  ctxNs: string,
  scope: IndexHeadScope,
  now: Date,
): Promise<DoctorCheck> {
  const id = 'index-head';
  const title = '代码索引锚点新鲜度';
  // Scoped to the code bucket `kireo index` actually writes from here: one
  // project can hold several (monorepo subdirectories, an explicit --repo),
  // and reading another one's anchor is what made the second bucket index
  // nothing at all.
  const head = await readIndexHead(rest, ctxNs, scope);
  if (!head) {
    return {
      id,
      title,
      status: 'warn',
      detail: `${ctxNs} 里没有可用的索引锚点`,
      hint: '这个项目还没跑过 `kireo index`（或锚点读不出来）。没有锚点时增量索引会退化成全量扫描。',
    };
  }
  const ts = Date.parse(head.ts);
  if (Number.isNaN(ts)) {
    return { id, title, status: 'warn', detail: `锚点时间戳无法解析：${head.ts}` };
  }
  const ageDays = Math.max(0, (now.getTime() - ts) / 86_400_000);
  const rounded = ageDays.toFixed(1);
  if (ageDays > 30) {
    return {
      id,
      title,
      status: 'fail',
      detail: `锚点停在 ${head.commit.slice(0, 12)}，已 ${rounded} 天没更新`,
      hint: '代码索引严重过期，resume 拿到的"关键文件"可能指向已经不存在的符号。跑一次 `kireo index`。',
    };
  }
  return {
    id,
    title,
    status: ageDays > 7 ? 'warn' : 'ok',
    detail: `锚点 ${head.commit.slice(0, 12)}，${rounded} 天前`,
    ...(ageDays > 7 ? { hint: '超过一周没索引了，建议跑一次 `kireo index`。' } : {}),
  };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.now ?? new Date();
  const checks: DoctorCheck[] = [];

  // 1. Config — everything else depends on it, so it goes first and its
  //    failure downgrades the network checks to `skip` rather than `fail`
  //    (a missing key is not an outage).
  if (deps.configError) {
    checks.push({
      id: 'config',
      title: '本地配置',
      status: 'fail',
      detail: deps.configError,
      hint: '设置 KIREO_API_KEY（ki_sk_…），或在宿主插件的配置里填好这个键。',
    });
  } else {
    checks.push({
      id: 'config',
      title: '本地配置',
      status: 'ok',
      detail: `apiUrl = ${deps.apiUrl ?? '(default)'}，API key 已配置`,
    });
  }

  const { rest } = deps;
  if (rest) checks.push(await checkApi(rest));
  else checks.push({ id: 'api', title: 'API 可达性', status: 'skip', detail: '配置无效，跳过' });

  if (rest) checks.push(...(await checkAuthAndQuota(rest)));
  else {
    checks.push({ id: 'auth', title: 'API key 有效性', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'quota', title: '配额余量', status: 'skip', detail: '配置无效，跳过' });
  }

  // 2. Project identity. Printed in full even when it is fine: "which bucket
  //    am I writing to" is the single most useful line when two machines
  //    disagree, and the user is the only one who can tell it is wrong.
  const p = resolveProjectHere(deps.cwd);
  // `p.codeNs` is what `kireo index` WRITES from this directory, not the
  // new-style name it would use once the key is pinned. Printing the latter
  // (which is what this line used to do) pointed users at a namespace that
  // never held any data — and `kireo project merge`'s own help text tells them
  // to read the bucket name off this very line.
  const codeLine = p.pinned
    ? `code 桶 = ${p.codeNs}`
    : `code 桶 = ${p.codeNs}（旧式命名；固化后会变成 ${p.codeNsPinned}）`;
  checks.push({
    id: 'project',
    title: '项目标识',
    status: p.warn ? 'warn' : 'ok',
    detail: `${p.displayName}（key=${p.key}，来源=${p.source}）\n    ctx 桶 = ${p.ctxNs}\n    ${codeLine}`,
    ...(p.warn ? { hint: p.warn } : p.codeNsMigrationHint ? { hint: p.codeNsMigrationHint } : {}),
  });

  if (rest) checks.push(await checkListEnvelope(rest, p.ctxNs));
  else
    checks.push({
      id: 'list-envelope',
      title: 'GET /v1/memories 响应契约',
      status: 'skip',
      detail: '配置无效，跳过',
    });

  // 3. Kill switch. Deliberate, but it silences the ENTIRE relay, so a user
  //    debugging "nothing happens" must see it here — and must be told the
  //    real scope. This line used to say only "context_save 不会做任何事",
  //    which reads as "…but resume still works". It does not: context_load
  //    returns immediately too (so no outbox retry either), and every outbound
  //    CLI command now stops at the same gate. doctor itself is the one
  //    exemption, which is precisely why it can still print this.
  const repoRoot = repoRootOrCwd(deps.cwd);
  const disabled = isDisabled(repoRoot, deps.env);
  checks.push({
    id: 'kill-switch',
    title: '隐私开关',
    status: disabled ? 'warn' : 'ok',
    detail: disabled
      ? `已开启（${deps.env.KIREO_DISABLED ? 'KIREO_DISABLED 环境变量' : `${repoRoot}/.kireo/disabled`}）—— 上下文中继与所有出站子命令都停了：context_save 与 /kireo:resume（context_load）都直接返回、也不会补传 outbox；kireo index / resume / backfill / project --migrate / project merge 同样一步都不走。只有 doctor 不受影响（否则你没法知道是它在起作用）`
      : '未开启（save / resume / index / backfill 都正常工作）',
    ...(disabled
      ? {
          hint: '这是有意的开关。要恢复：删掉 .kireo/disabled 或 unset KIREO_DISABLED。它管的是上下文中继与 kireo 的出站子命令；memory_* 那组 MCP 工具是宿主显式调用的，不在这个开关的范围内。',
        }
      : {}),
  });

  // 4. Outbox backlog — the write-ahead buffer only grows when uploads fail.
  let pending = 0;
  let outboxError: string | null = null;
  try {
    pending = listOutbox(deps.outboxDir).length;
  } catch (err) {
    outboxError = reason(err);
  }
  checks.push(
    outboxError
      ? {
          id: 'outbox',
          title: '本地未上传队列',
          status: 'warn',
          detail: `读不出来：${outboxError}`,
        }
      : {
          id: 'outbox',
          title: '本地未上传队列',
          status: pending === 0 ? 'ok' : pending >= 20 ? 'fail' : 'warn',
          detail:
            pending === 0
              ? `${deps.outboxDir} 为空`
              : `${pending} 批待上传，堆在 ${deps.outboxDir}`,
          // "next save or resume retries it" stops being true the moment the
          // kill switch is on: BOTH of those return before the flush now, so
          // the backlog just sits there. Telling a user to wait for a retry
          // that structurally cannot happen is how a queue silently becomes
          // permanent.
          ...(pending >= 20
            ? {
                hint: disabled
                  ? '积压这么多说明上传长期失败（配额打满 / key 失效 / 网络）。注意隐私开关正开着：save 与 resume 现在都直接返回，不会重传，这些只会一直堆着。先决定要不要关掉开关，再修上面失败的检查项。'
                  : '积压这么多说明上传长期失败（配额打满 / key 失效 / 网络）。先修上面失败的检查项，再跑一次 save 或 resume —— 两者开头都会自动重传积压的记录（每次最多 20 批）。',
              }
            : pending > 0
              ? {
                  hint: disabled
                    ? '隐私开关正开着：save 与 resume 都直接返回，不会自动重传，这些会一直堆着。关掉开关后下一次 save 或 resume 才会补传。'
                    : '下一次 save 或 resume 开头会自动重传，通常不用管。',
                }
              : {}),
        },
  );

  if (rest)
    checks.push(
      await checkIndexHead(rest, p.ctxNs, { codeNs: p.codeNs, indexRoot: p.indexRoot }, now),
    );
  else
    checks.push({
      id: 'index-head',
      title: '代码索引锚点新鲜度',
      status: 'skip',
      detail: '配置无效，跳过',
    });

  // 5. Host transcript formats — the reason this command exists.
  checks.push(
    await probeTranscripts(
      deps.fs,
      'claude-code',
      `${deps.homeDir}/${CLAUDE_SESSION_ROOT}`,
      parseClaudeTranscript,
    ),
  );
  checks.push(
    await probeTranscripts(
      deps.fs,
      'codex',
      `${deps.homeDir}/${CODEX_SESSION_ROOT}`,
      parseCodexRollout,
    ),
  );

  return {
    checks,
    failed: checks.filter((c) => c.status === 'fail').length,
    warned: checks.filter((c) => c.status === 'warn').length,
  };
}

const ICON: Record<DoctorStatus, string> = {
  ok: '✅',
  warn: '⚠️ ',
  fail: '❌',
  skip: '—',
};

/** Render a report as the text `kireo doctor` prints. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['kireo doctor', ''];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.title}: ${c.detail}`);
    if (c.hint) lines.push(`    → ${c.hint}`);
  }
  lines.push('');
  lines.push(
    report.failed > 0
      ? `${report.failed} 项失败、${report.warned} 项警告。`
      : report.warned > 0
        ? `没有失败项，${report.warned} 项警告。`
        : '全部通过。',
  );
  return `${lines.join('\n')}\n`;
}
