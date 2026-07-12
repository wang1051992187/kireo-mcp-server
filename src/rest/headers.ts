import type { RuntimeConfig } from '../config/schema.js';

export interface HeaderCtx {
  config: RuntimeConfig;
  deviceId: string;
  requestId: string;
  version: string;
}

export function buildHeaders(
  ctx: HeaderCtx,
  extra?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {
    Authorization: `Bearer ${ctx.config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': ctx.config.acceptLanguage,
    'X-Client': `kireo-mcp-server@${ctx.version}`,
    'X-Request-Id': ctx.requestId,
  };
  if (ctx.config.telemetryEnabled) base['X-Device-Id'] = ctx.deviceId;
  return { ...base, ...extra };
}
