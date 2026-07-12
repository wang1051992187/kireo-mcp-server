import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const homeDir = (): string => homedir();

/** Config directory: ~/.kireo (uniform across platforms per MCP-02) */
export const configDir = (): string => join(homedir(), '.kireo');

export const configFile = (): string => join(configDir(), 'config.json');

/** Logs directory: ~/.kireo/logs (Windows uses the same path for troubleshooting) */
export const logsDir = (): string => join(configDir(), 'logs');

export const cacheDir = (): string => join(configDir(), 'cache');

export const fallbackTmpDir = (): string => tmpdir();
