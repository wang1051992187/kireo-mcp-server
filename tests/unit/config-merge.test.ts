import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/merge.js';

describe('loadConfig', () => {
  it('CLI overrides env', () => {
    const { config, source } = loadConfig({
      env: { KIREO_API_KEY: 'ki_sk_env123456', KIREO_API_URL: 'https://env.example.com' },
      argv: ['--api-url=https://cli.example.com'],
    });
    expect(config.apiUrl).toBe('https://cli.example.com');
    expect(config.apiKey).toBe('ki_sk_env123456');
    expect(source.origin.apiUrl).toBe('cli');
    expect(source.origin.apiKey).toBe('env');
  });

  it('default apiUrl is https://api.kireo.app', () => {
    const { config, source } = loadConfig({ env: { KIREO_API_KEY: 'ki_sk_abcdefgh' } });
    expect(config.apiUrl).toBe('https://api.kireo.app');
    expect(source.origin.apiUrl).toBe('default');
  });

  it('missing apiKey throws', () => {
    expect(() => loadConfig({ env: {} })).toThrow(/KIREO_API_KEY/);
  });

  it('malformed apiKey throws', () => {
    expect(() => loadConfig({ env: { KIREO_API_KEY: 'not-a-key' } })).toThrow(/ki_sk_xxx/);
  });

  it('telemetry disabled via env KIREO_TELEMETRY=0', () => {
    const { config } = loadConfig({
      env: { KIREO_API_KEY: 'ki_sk_abcdefgh', KIREO_TELEMETRY: '0' },
    });
    expect(config.telemetryEnabled).toBe(false);
  });

  it('CLI --no-telemetry disables telemetry', () => {
    const { config } = loadConfig({
      env: { KIREO_API_KEY: 'ki_sk_abcdefgh' },
      argv: ['--no-telemetry'],
    });
    expect(config.telemetryEnabled).toBe(false);
  });
});
