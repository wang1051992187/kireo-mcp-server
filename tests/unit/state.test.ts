import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffState, hashContent, loadState, saveState } from '../../src/index/state.js';

describe('hashContent', () => {
  it('is stable sha256 hex', () => {
    expect(hashContent('abc')).toBe(hashContent(Buffer.from('abc')));
    expect(hashContent('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('diffState', () => {
  it('classifies changed / deleted / unchanged', () => {
    const prev = { 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h3' };
    const cur = { 'a.ts': 'h1', 'b.ts': 'CHANGED' };
    expect(diffState(prev, cur)).toEqual({
      changed: ['b.ts'],
      deleted: ['gone.ts'],
      unchanged: ['a.ts'],
    });
  });
  it('treats brand-new files as changed', () => {
    expect(diffState({}, { 'new.ts': 'h' }).changed).toEqual(['new.ts']);
  });
});

describe('load/save round-trip', () => {
  it('persists to .kireo/index-state.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kireo-state-'));
    expect(await loadState(root)).toEqual({});
    await saveState(root, { 'a.ts': 'h1' });
    const raw = JSON.parse(readFileSync(join(root, '.kireo', 'index-state.json'), 'utf8'));
    expect(raw).toEqual({ 'a.ts': 'h1' });
    expect(await loadState(root)).toEqual({ 'a.ts': 'h1' });
  });

  it('returns {} when state file is corrupted JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kireo-state-'));
    const stateDir = join(root, '.kireo');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'index-state.json'), 'NOT JSON', 'utf8');
    expect(await loadState(root)).toEqual({});
  });

  it('returns {} when state file contains non-string values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kireo-state-'));
    const stateDir = join(root, '.kireo');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'index-state.json'), JSON.stringify({ 'a.ts': 42 }), 'utf8');
    expect(await loadState(root)).toEqual({});
  });
});
