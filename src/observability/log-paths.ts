import { constants, accessSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../lib/platform.js';

export const ensureLogsDir = (dir = logsDir()): string | undefined => {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch (err) {
    process.stderr.write(`[kireo-mcp] cannot create logs dir ${dir}: ${(err as Error).message}\n`);
    return undefined;
  }
};

export const currentLogFile = (dir = logsDir()): string => join(dir, 'mcp-server.log');
