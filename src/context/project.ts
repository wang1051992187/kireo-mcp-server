import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { HOME_NAMESPACE, codeNamespaceV2, ctxNamespace, resolveProjectKey } from '@kireo/shared';
import { codeNamespace } from '../index/assemble.js';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const gitRemote = (cwd: string): string | null => {
  try {
    return (
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

export const repoRoot = (cwd: string): string | null => {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

const readFileOrNull = (p: string): string | null => {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};

export interface ProjectHere {
  key: string;
  source: string;
  displayName: string;
  warn: string | null;
  ctxNs: string;
  /**
   * The code bucket `kireo index` will ACTUALLY write from this directory.
   *
   * Not always `codeNsPinned`: spec §5.4 requires that without a committed
   * `.kireo/project.json`, `kireo index` keeps the historical
   * `code-<repoSlug(basename)>` naming and only prints a migration hint —
   * renaming a live bucket behind the user's back would orphan every symbol
   * already in it. Reporting the new-style name while writing the old one is
   * what made `kireo doctor`'s "code 桶 = …" line point at a namespace that
   * never had any data, and made `kireo project merge <that name>` answer
   * "找不到源 namespace".
   */
  codeNs: string;
  /** New-style `code-<slug15>-<h6>` — what `codeNs` becomes once the key is pinned. */
  codeNsPinned: string;
  /** Historical `code-<repoSlug(basename(dir))>` — no hash, so two repos named `api` collide. */
  codeNsLegacy: string;
  /** True when the key came from `.kireo/project.json` or `KIREO_PROJECT`. */
  pinned: boolean;
  /** Non-null exactly when `codeNs` is still the legacy, directory-derived name. */
  codeNsMigrationHint: string | null;
  /** Index root, POSIX and relative to the repo root ('' = the repo root). */
  indexRoot: string;
  homeNs: string;
}

/**
 * Index root as a repo-root-relative POSIX path; '' at the repo root or
 * outside git.
 *
 * Both sides are realpath'd first. `git rev-parse --show-toplevel` already
 * answers with symlinks resolved, so comparing it against a raw `resolve(dir)`
 * silently yields a `../../..`-style path wherever the tree sits behind a
 * symlink — /var → /private/var on macOS being the everyday case, temp dirs
 * included. That bogus prefix then matches nothing when rebasing git's paths,
 * i.e. it would reintroduce the very "zero symbols uploaded" bug this value
 * exists to fix.
 */
export const indexRootRel = (dir: string): string => {
  const root = repoRoot(dir);
  if (!root) return '';
  let here = resolve(dir);
  let top = root;
  try {
    here = realpathSync(here);
  } catch {
    // Unreadable path — fall back to the resolved form.
  }
  try {
    top = realpathSync(root);
  } catch {
    // ditto
  }
  const rel = relative(top, here);
  // `..` means `dir` is not inside the repo root at all; treat it as "no
  // subdirectory" rather than emitting a prefix that can never match.
  if (!rel || rel.startsWith('..')) return '';
  return rel.split(sep).join('/');
};

export const resolveProjectHere = (cwd: string): ProjectHere => {
  const r = resolveProjectKey({
    cwd,
    env: process.env,
    readFile: readFileOrNull,
    gitRemote,
    repoRoot,
  });
  // 'file' = committed .kireo/project.json, 'env' = KIREO_PROJECT. Both are
  // explicit user pins of the same string on every machine, which is exactly
  // what the hash-suffixed name needs to be stable.
  const pinned = r.source === 'file' || r.source === 'env';
  const codeNsPinned = codeNamespaceV2(r.key, sha256Hex);
  const codeNsLegacy = codeNamespace(basename(resolve(cwd)));
  return {
    key: r.key,
    source: r.source,
    displayName: r.displayName,
    warn: r.warn,
    ctxNs: ctxNamespace(r.key, sha256Hex),
    codeNs: pinned ? codeNsPinned : codeNsLegacy,
    codeNsPinned,
    codeNsLegacy,
    pinned,
    codeNsMigrationHint: pinned
      ? null
      : [
          `代码索引仍在用旧式桶名 "${codeNsLegacy}"（按目录名推导，换目录名或换设备就会分裂成另一个桶，`,
          '而且两个都叫 api 的仓库会共用同一个桶）。跑 `kireo project init --migrate` 可以把项目标识固化进 ',
          `.kireo/project.json，并把这个桶原地改名成 "${codeNsPinned}"。`,
        ].join(''),
    indexRoot: indexRootRel(cwd),
    homeNs: HOME_NAMESPACE,
  };
};

/** Nearest enclosing git repo root, or `cwd` when not in a repo. */
export const repoRootOrCwd = (cwd: string): string => repoRoot(cwd) ?? cwd;
