import { describe, expect, it } from 'vitest';
import { cacheDir, configDir, configFile, logsDir } from '../../src/lib/platform.js';

describe('platform paths', () => {
  it('configDir ends with .kireo', () => {
    expect(configDir()).toMatch(/\.kireo$/);
  });
  it('configFile ends with config.json', () => {
    expect(configFile().endsWith('config.json')).toBe(true);
  });
  it('logsDir ends with logs', () => {
    expect(logsDir().endsWith('logs')).toBe(true);
  });
  it('cacheDir ends with cache', () => {
    expect(cacheDir().endsWith('cache')).toBe(true);
  });
});
