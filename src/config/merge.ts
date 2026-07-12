import { readCli } from './cli.js';
import { readEnv } from './env.js';
import { readFile } from './file.js';
import { type PartialConfig, type RuntimeConfig, RuntimeConfigSchema } from './schema.js';

export type ConfigOrigin = 'cli' | 'env' | 'file' | 'default';

export interface ConfigSource {
  origin: Record<keyof RuntimeConfig, ConfigOrigin>;
}

const KNOWN_KEYS: (keyof RuntimeConfig)[] = [
  'apiKey',
  'apiUrl',
  'requestTimeoutMs',
  'retryMaxAttempts',
  'retryBaseMs',
  'telemetryEnabled',
  'logLevel',
  'defaultNamespace',
  'acceptLanguage',
  'proxyUrl',
  'extraCaCerts',
];

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  configPath?: string;
}

/** Priority: CLI > env > file > default (MCP-02) */
export const loadConfig = (
  opts: LoadConfigOptions = {},
): { config: RuntimeConfig; source: ConfigSource } => {
  const cli = readCli(opts.argv);
  const env = readEnv(opts.env);
  const file = readFile(opts.configPath);

  const merged: PartialConfig = { ...file, ...env, ...cli };
  const origin = {} as ConfigSource['origin'];
  for (const k of KNOWN_KEYS) {
    if (k in cli) origin[k] = 'cli';
    else if (k in env) origin[k] = 'env';
    else if (k in file) origin[k] = 'file';
    else origin[k] = 'default';
  }

  const ENV_NAME_MAP: Partial<Record<keyof RuntimeConfig, string>> = {
    apiKey: 'KIREO_API_KEY',
    apiUrl: 'KIREO_API_URL',
    requestTimeoutMs: 'KIREO_REQUEST_TIMEOUT_MS',
    retryMaxAttempts: 'KIREO_RETRY_MAX_ATTEMPTS',
    retryBaseMs: 'KIREO_RETRY_BASE_MS',
    telemetryEnabled: 'KIREO_TELEMETRY',
    logLevel: 'KIREO_LOG_LEVEL',
    defaultNamespace: 'KIREO_DEFAULT_NAMESPACE',
    proxyUrl: 'KIREO_PROXY_URL',
    acceptLanguage: 'KIREO_ACCEPT_LANGUAGE',
  };

  const parsed = RuntimeConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const field = i.path.join('.') as keyof RuntimeConfig;
        const envName = ENV_NAME_MAP[field];
        const label = envName ? `${envName} (${field})` : field;
        return `${label}: ${i.message}`;
      })
      .join('; ');
    throw new Error(
      `Invalid Kireo configuration: ${issues}. See https://docs.kireo.app/errors/CONFIG_INVALID`,
    );
  }
  return { config: parsed.data, source: { origin } };
};
