import { basename, resolve } from 'node:path';
import { MEMORY_LIMITS } from '@kireo/shared';
import { loadConfig } from './config/merge.js';
import { createLogger } from './observability/logger.js';
import { deviceIdOrAnon } from './observability/device-id.js';
import { createRestClient } from './rest/client.js';
import { runIndex } from './index/run-index.js';
import { startServer } from './server.js';
import { __KIREO_MCP_VERSION__ } from './version.js';

const USAGE = `kireo — long-term memory for MCP-compatible AI tools (v${__KIREO_MCP_VERSION__})

Usage:
  kireo                       Start the MCP stdio server (default; used by AI hosts)
  kireo index [dir] [flags]   Index a local repo's code symbols into your memory
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

const isHelpToken = (t: string): boolean => t === '--help' || t === '-h';
const isVersionToken = (t: string): boolean => t === '--version' || t === '-v';

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
function parseIndexArgs(argv: string[]): { dir: string; repo: string | undefined; batchSize: number | undefined } {
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

export async function runCli(opts: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
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

  if (argv[0] !== 'index') {
    // Default behaviour: act as the MCP stdio server.
    await startServer(opts);
    return;
  }

  // Validate flags BEFORE loading config or touching the filesystem so an
  // unknown flag errors out (exit 1) instead of silently indexing the cwd.
  const { dir, repo, batchSize } = parseIndexArgs(argv);
  const { config } = loadConfig({ argv, env: opts.env ?? process.env });
  const logger = createLogger(config);
  const deviceId = deviceIdOrAnon(config.telemetryEnabled);
  const rest = createRestClient({ config, deviceId, version: __KIREO_MCP_VERSION__, logger });
  const root = resolve(dir);
  const repoName = repo ?? basename(root);
  const summary = await runIndex({ rest, logger, root, repo: repoName, batchSize });
  process.stdout.write(
    `Indexed "${summary.repo}" -> namespace ${summary.namespace}\n` +
      `  files: ${summary.filesScanned} scanned, ${summary.filesChanged} changed, ${summary.filesDeleted} deleted\n` +
      `  symbols: ${summary.symbols} in ${summary.batches} batch(es)\n`,
  );
}
