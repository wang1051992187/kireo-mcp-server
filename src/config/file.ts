import { existsSync, readFileSync } from 'node:fs';
import { configFile } from '../lib/platform.js';
import type { PartialConfig } from './schema.js';

interface ConfigFileShape {
  api_key?: string;
  apiKey?: string;
  api_url?: string;
  apiUrl?: string;
  timeout_ms?: number;
  requestTimeoutMs?: number;
  telemetry?: boolean;
  telemetryEnabled?: boolean;
  default_namespace?: string;
  defaultNamespace?: string;
  log_level?: string;
  logLevel?: string;
}

export const readFile = (path: string = configFile()): PartialConfig => {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const json = JSON.parse(raw) as ConfigFileShape;
    const cfg: PartialConfig = {};
    const apiKey = json.api_key ?? json.apiKey;
    if (apiKey) cfg.apiKey = apiKey;
    const apiUrl = json.api_url ?? json.apiUrl;
    if (apiUrl) cfg.apiUrl = apiUrl;
    const timeout = json.timeout_ms ?? json.requestTimeoutMs;
    if (timeout !== undefined) cfg.requestTimeoutMs = timeout;
    const telemetry = json.telemetry ?? json.telemetryEnabled;
    if (telemetry !== undefined) cfg.telemetryEnabled = telemetry;
    const ns = json.default_namespace ?? json.defaultNamespace;
    if (ns) cfg.defaultNamespace = ns;
    const level = json.log_level ?? json.logLevel;
    if (level) cfg.logLevel = level as NonNullable<PartialConfig['logLevel']>;
    return cfg;
  } catch (err) {
    process.stderr.write(`[kireo-mcp] config file ${path} unreadable: ${(err as Error).message}\n`);
    return {};
  }
};
