import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appendOutboundAudit, isDisabled, redact } from '../../src/context/redact.js';

describe('redact', () => {
  it.each([
    ['ki_sk_live_abcdefghijklmnop', 'kireo key'],
    ['sk-proj-abcdefghijklmnopqrst', 'openai key'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github token'],
  ])('redacts %s (%s)', (secret) => {
    const out = redact(`token is ${secret} ok`);
    expect(out.text).not.toContain(secret);
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it('is honest that it cannot catch business secrets', () => {
    // Documented limitation, asserted so nobody later mistakes redaction for
    // a privacy guarantee: this is exactly why dry-run and the kill switch exist.
    const out = redact('客户 A 的合同金额是 320 万');
    expect(out.hits).toHaveLength(0);
  });
});

describe('isDisabled', () => {
  it('fires when the repo has a .kireo/disabled marker file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kireo-repo-disabled-'));
    mkdirSync(join(dir, '.kireo'), { recursive: true });
    writeFileSync(join(dir, '.kireo', 'disabled'), '');
    expect(isDisabled(dir, {})).toBe(true);
  });

  it('fires on the KIREO_DISABLED env var alone, regardless of repo state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kireo-repo-clean-'));
    expect(isDisabled(dir, { KIREO_DISABLED: '1' })).toBe(true);
  });

  it('is false when neither the file nor the env var is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kireo-repo-clean-'));
    expect(isDisabled(dir, {})).toBe(false);
  });
});

describe('appendOutboundAudit', () => {
  it('is append-only and stores digests, not content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kireo-audit-'));
    const p = join(dir, 'outbound.jsonl');
    appendOutboundAudit(p, { ts: 'x', namespace: 'ctx-a', count: 2, digests: ['ab12', 'cd34'] });
    appendOutboundAudit(p, { ts: 'y', namespace: 'ctx-a', count: 1, digests: ['ef56'] });
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: 'x',
      namespace: 'ctx-a',
      count: 2,
      digests: ['ab12', 'cd34'],
    });
  });
});
