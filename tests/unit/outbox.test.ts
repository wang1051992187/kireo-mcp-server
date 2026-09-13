import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { dropOutbox, listOutbox, writeOutbox } from '../../src/context/outbox.js';

const mkdir = () => mkdtempSync(join(tmpdir(), 'kireo-outbox-'));

const rec = (ns: string) => ({ ts: new Date().toISOString(), namespace: ns, entries: [{ a: 1 }] });

describe('outbox', () => {
  it('writes a record readable back through listOutbox', () => {
    const d = mkdir();
    writeOutbox(d, rec('ctx-a-111111'));
    const all = listOutbox(d);
    expect(all).toHaveLength(1);
    expect(all[0]?.rec.namespace).toBe('ctx-a-111111');
  });

  it('writes with 0600 — the payload can contain anything the session touched', () => {
    const d = mkdir();
    const p = writeOutbox(d, rec('ctx-a-111111'));
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('returns [] for a directory that does not exist yet', () => {
    expect(listOutbox(join(mkdir(), 'nope'))).toEqual([]);
  });

  it('skips a corrupt file and leaves it on disk for inspection', () => {
    const d = mkdir();
    writeOutbox(d, rec('ctx-a-111111'));
    const bad = join(d, '1700000000000-bad.json');
    writeFileSync(bad, '{ not json');
    const all = listOutbox(d);
    expect(all).toHaveLength(1);
    expect(() => readFileSync(bad, 'utf8')).not.toThrow();
  });

  it('drops only the record it is told to drop', () => {
    const d = mkdir();
    const p1 = writeOutbox(d, rec('ctx-a-111111'));
    writeOutbox(d, rec('ctx-b-222222'));
    dropOutbox(p1);
    const all = listOutbox(d);
    expect(all).toHaveLength(1);
    expect(all[0]?.rec.namespace).toBe('ctx-b-222222');
  });

  it('does not throw when dropping something already gone', () => {
    expect(() => dropOutbox(join(mkdir(), 'ghost.json'))).not.toThrow();
  });

  it('never collides when two records are written in the same millisecond', () => {
    const d = mkdir();
    const paths = new Set([
      writeOutbox(d, rec('ctx-a-111111')),
      writeOutbox(d, rec('ctx-a-111111')),
      writeOutbox(d, rec('ctx-a-111111')),
    ]);
    expect(paths.size).toBe(3);
    expect(listOutbox(d)).toHaveLength(3);
  });
});
