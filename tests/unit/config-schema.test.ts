import { describe, expect, it } from 'vitest';
import { RuntimeConfigSchema } from '../../src/config/schema.js';

describe('RuntimeConfigSchema', () => {
  it('telemetry default true', () => {
    const parsed = RuntimeConfigSchema.parse({ apiKey: 'ki_sk_abcdef12' });
    expect(parsed.telemetryEnabled).toBe(true);
    // BUG-001: default bumped 10s -> 60s so a full 100-symbol batch survives.
    expect(parsed.requestTimeoutMs).toBe(60_000);
    expect(parsed.retryMaxAttempts).toBe(3);
  });

  it('timeout accepts up to 300s and caps beyond it', () => {
    // BUG-001: hard cap raised 60s -> 300s.
    expect(
      RuntimeConfigSchema.parse({ apiKey: 'ki_sk_abcdef12', requestTimeoutMs: 300_000 })
        .requestTimeoutMs,
    ).toBe(300_000);
    expect(() =>
      RuntimeConfigSchema.parse({ apiKey: 'ki_sk_abcdef12', requestTimeoutMs: 300_001 }),
    ).toThrow();
  });

  it('namespace regex rejects bad name', () => {
    expect(() =>
      RuntimeConfigSchema.parse({ apiKey: 'ki_sk_abcdef12', defaultNamespace: 'BAD NAME' }),
    ).toThrow();
  });

  it('apiKey too short throws', () => {
    expect(() => RuntimeConfigSchema.parse({ apiKey: 'ki_sk_' })).toThrow();
  });
});
