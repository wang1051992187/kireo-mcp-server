import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { codeNamespaceV2 } from '@kireo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { indexRootRel, resolveProjectHere } from '../../src/context/project.js';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kireo-project-'));
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# x\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'kireo@test.invalid');
  git(root, 'config', 'user.name', 'kireo');
  git(root, 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * `kireo doctor` / `kireo project info` / the project_info tool all printed
 * `codeNamespaceV2(key)` while `kireo index` wrote `code-<repoSlug(basename)>`.
 * Nothing in the codebase read or wrote the reported name, so the "which
 * bucket am I writing to" line — whose entire reason for existing is letting
 * the user catch a misidentified project on the spot — was itself wrong, and
 * `kireo project merge <that name>` answered "找不到源 namespace".
 */
describe('resolveProjectHere code bucket', () => {
  it('reports the LEGACY bucket while no project.json is committed', () => {
    const p = resolveProjectHere(root);
    expect(p.source).toBe('git');
    expect(p.key).toBe('github.com/acme/api');
    expect(p.pinned).toBe(false);
    // What `kireo index` really writes: derived from the directory name.
    expect(p.codeNs).toBe(
      `code-${basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')}`,
    );
    expect(p.codeNs).toBe(p.codeNsLegacy);
    expect(p.codeNsPinned).toBe(codeNamespaceV2('github.com/acme/api', sha256Hex));
    // spec §5.4[3]: keep the old behaviour, but SAY so.
    expect(p.codeNsMigrationHint).toContain(p.codeNsLegacy);
    expect(p.codeNsMigrationHint).toContain(p.codeNsPinned);
  });

  it('switches to the hash-suffixed bucket once project.json is committed', () => {
    mkdirSync(join(root, '.kireo'), { recursive: true });
    writeFileSync(
      join(root, '.kireo', 'project.json'),
      JSON.stringify({ project_key: 'github.com/acme/api' }),
    );
    const p = resolveProjectHere(root);
    expect(p.source).toBe('file');
    expect(p.pinned).toBe(true);
    expect(p.codeNs).toBe(codeNamespaceV2('github.com/acme/api', sha256Hex));
    // No hint once there is nothing left to migrate.
    expect(p.codeNsMigrationHint).toBeNull();
  });

  it('the legacy name has no hash, so two repos named api DO collide', () => {
    // context-namespace.ts's own comment ("hash-suffixed so two repos named
    // `api` never collide") is only true of the pinned form — which is exactly
    // why the migration hint has to be printed rather than assumed.
    const a = mkdtempSync(join(tmpdir(), 'kireo-a-'));
    const b = mkdtempSync(join(tmpdir(), 'kireo-b-'));
    try {
      mkdirSync(join(a, 'api'));
      mkdirSync(join(b, 'api'));
      expect(resolveProjectHere(join(a, 'api')).codeNsLegacy).toBe(
        resolveProjectHere(join(b, 'api')).codeNsLegacy,
      );
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('indexRootRel', () => {
  it('is empty at the repo root and relative below it', () => {
    expect(indexRootRel(root)).toBe('');
    expect(indexRootRel(join(root, 'apps', 'api'))).toBe('apps/api');
  });

  it('resolves symlinks on BOTH sides', () => {
    // `git rev-parse --show-toplevel` answers with symlinks resolved. Comparing
    // that against a raw resolve(dir) yields a `../../..`-shaped prefix wherever
    // the tree sits behind a symlink — /var → /private/var on macOS, temp dirs
    // included — and that prefix matches none of git's paths, reintroducing the
    // "zero symbols uploaded" bug this value exists to prevent.
    expect(indexRootRel(join(root, 'apps', 'api'))).not.toContain('..');
  });

  it('is empty outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'kireo-plain-'));
    try {
      expect(indexRootRel(plain)).toBe('');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
