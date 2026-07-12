import pino from 'pino';
import type { RuntimeConfig } from '../config/schema.js';
import { currentLogFile, ensureLogsDir } from './log-paths.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  '*.headers.authorization',
  '*.headers["x-api-key"]',
  'apiKey',
  'api_key',
  'config.apiKey',
  '*.api_key',
  'password',
  'token',
  'secret',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.token',
  '*.secret',
];

export function createLogger(config: RuntimeConfig): pino.Logger {
  const writableLogsDir = ensureLogsDir();
  const targets: pino.TransportMultiOptions['targets'] = [
    ...(writableLogsDir
      ? [
          {
            target: 'pino-roll',
            level: config.logLevel,
            options: {
              file: currentLogFile(writableLogsDir),
              frequency: 'daily',
              mkdir: true,
              size: '10m',
              limit: { count: 7 },
            },
          },
        ]
      : []),
    // stderr remains available when the configured home directory is read-only.
    { target: 'pino/file', level: 'warn', options: { destination: 2 } },
  ];
  const stream = pino.transport({
    targets,
  });
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { component: 'mcp-server' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );
}
