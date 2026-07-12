import type { PartialConfig, RuntimeConfig } from './schema.js';

type LogLevel = RuntimeConfig['logLevel'];

const parseBool = (v: string | undefined): boolean | undefined => {
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  return undefined;
};

const parseInteger = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export const readEnv = (env: NodeJS.ProcessEnv = process.env): PartialConfig => {
  const cfg: PartialConfig = {};
  if (env.KIREO_API_KEY) cfg.apiKey = env.KIREO_API_KEY;
  if (env.KIREO_API_URL) cfg.apiUrl = env.KIREO_API_URL;
  // KIREO_REQUEST_TIMEOUT_MS (preferred) or KIREO_TIMEOUT_MS (alias)
  const timeout = parseInteger(env.KIREO_REQUEST_TIMEOUT_MS ?? env.KIREO_TIMEOUT_MS);
  if (timeout !== undefined) cfg.requestTimeoutMs = timeout;
  // KIREO_RETRY_MAX_ATTEMPTS (preferred) or KIREO_RETRY_MAX (alias)
  const attempts = parseInteger(env.KIREO_RETRY_MAX_ATTEMPTS ?? env.KIREO_RETRY_MAX);
  if (attempts !== undefined) cfg.retryMaxAttempts = attempts;
  // KIREO_RETRY_BASE_MS (new)
  const retryBase = parseInteger(env.KIREO_RETRY_BASE_MS);
  if (retryBase !== undefined) cfg.retryBaseMs = retryBase;
  const tel = parseBool(env.KIREO_TELEMETRY);
  if (tel !== undefined) cfg.telemetryEnabled = tel;
  if (env.KIREO_LOG_LEVEL && LOG_LEVELS.includes(env.KIREO_LOG_LEVEL as LogLevel)) {
    cfg.logLevel = env.KIREO_LOG_LEVEL as LogLevel;
  }
  if (env.KIREO_DEFAULT_NAMESPACE) cfg.defaultNamespace = env.KIREO_DEFAULT_NAMESPACE;
  // KIREO_PROXY_URL (preferred) or HTTPS_PROXY (fallback)
  if (env.KIREO_PROXY_URL) cfg.proxyUrl = env.KIREO_PROXY_URL;
  else if (env.HTTPS_PROXY) cfg.proxyUrl = env.HTTPS_PROXY;
  // KIREO_ACCEPT_LANGUAGE (new)
  if (env.KIREO_ACCEPT_LANGUAGE) cfg.acceptLanguage = env.KIREO_ACCEPT_LANGUAGE;
  if (env.NODE_EXTRA_CA_CERTS) cfg.extraCaCerts = env.NODE_EXTRA_CA_CERTS;
  return cfg;
};
