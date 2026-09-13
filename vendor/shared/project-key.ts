/**
 * Project identity for cross-device context.
 *
 * HARD RULE: an absolute filesystem path never participates in the computed
 * key. `/Users/x/proj` and `C:\proj` share nothing, so any path-derived
 * identity forks the moment the user switches machines — which is precisely
 * the scenario this feature exists to serve.
 */

export type ProjectKeySource = 'env' | 'file' | 'git' | 'basename';

export interface ResolvedProjectKey {
  key: string;
  source: ProjectKeySource;
  /** Short human-facing name, for terminal output and dashboard labels. */
  displayName: string;
  /** Non-null when the resolution is not stable across machines. */
  warn: string | null;
}

export interface ResolveProjectKeyDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Reads `<repoRoot>/.kireo/project.json`; returns null when absent. */
  readFile: (path: string) => string | null;
  /** `git remote get-url origin`; returns null when unavailable. */
  gitRemote: (cwd: string) => string | null;
  /** Nearest enclosing git repo root; null when not in a repo. */
  repoRoot: (cwd: string) => string | null;
}

const lastSegment = (s: string): string => {
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? s;
};

/** `C:\repo`, `c:/repo` — a Windows absolute path, never a remote. */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * Normalize any git remote spelling to `host/owner/repo`, lowercased.
 *
 * The result deliberately contains no scheme, credentials, port, drive letter,
 * or backslash — two checkouts of the same repo on different platforms produce
 * byte-identical output.
 *
 * The colon is the whole difficulty, and it is resolved by whether the URL had
 * an explicit scheme, because that is the only thing that disambiguates it:
 *
 *  - WITH a scheme (`ssh://`, `https://`, `git://`) the `:N` after the host is
 *    a PORT and must be dropped. Self-hosted GitLab/Gitea on a non-22 SSH port
 *    is ordinary, and keeping the port made
 *    `ssh://git@gitlab.example.com:2222/acme/api.git` and
 *    `https://gitlab.example.com/acme/api.git` — the same repo, cloned two
 *    ways — resolve to `ctx-api-46e32c` and `ctx-api-155166`. Two buckets,
 *    source='git', warn=null: no signal at all that the two machines had
 *    stopped sharing context.
 *  - WITHOUT a scheme it is scp syntax (`git@host:owner/repo`), where the
 *    colon separates host from PATH and can never be a port — scp-style URLs
 *    have no port field; ssh:// exists precisely for that. The old
 *    `(?!\d+\/)` guard tried to protect ports here and instead split
 *    `git@github.com:2/api.git` (a numeric owner) away from its https spelling.
 *
 * Returns null for anything path-shaped. A POSIX absolute path already fell
 * out via the empty-host check; a Windows one used to survive as
 * `c/\repos\api` — a machine-local absolute path becoming a stable project
 * key, in direct violation of this file's HARD RULE. Both now take the
 * basename fallback, which at least warns.
 */
export const canonicalizeGitRemote = (url: string): string | null => {
  const raw = url.trim();
  if (!raw) return null;
  if (WINDOWS_DRIVE_PATH.test(raw)) return null;

  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let s = raw;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^@/]*@/, ''); // user[:token]@
  if (hadScheme) {
    s = s.replace(/^([^/:]+):\d+(?=\/|$)/, '$1'); // authority port
  } else {
    s = s.replace(/^([^/:]+):/, '$1/'); // scp-style host:path
  }
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  s = s.toLowerCase();

  // No backslash can appear in a real remote; if one survived this far the
  // input was a filesystem path, not a URL.
  if (s.includes('\\')) return null;
  if (!s.includes('/')) return null;
  const [host, ...rest] = s.split('/');
  if (!host || rest.length === 0 || rest.some((p) => p === '')) return null;
  return [host, ...rest].join('/');
};

export const resolveProjectKey = (deps: ResolveProjectKeyDeps): ResolvedProjectKey => {
  const { cwd, env, readFile, gitRemote, repoRoot } = deps;

  // Level 1 — explicit escape hatch.
  const pinned = env.KIREO_PROJECT?.trim();
  if (pinned) {
    return { key: pinned, source: 'env', displayName: lastSegment(pinned), warn: null };
  }

  const root = repoRoot(cwd);

  // Level 2 — committed marker file. The only 100%-stable source that needs no
  // per-machine setup, because it travels inside the repo.
  if (root) {
    const raw = readFile(`${root}/.kireo/project.json`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { project_key?: unknown };
        if (typeof parsed.project_key === 'string' && parsed.project_key.trim()) {
          const key = parsed.project_key.trim();
          return { key, source: 'file', displayName: lastSegment(key), warn: null };
        }
      } catch {
        // A malformed marker must never block the user; fall through.
      }
    }
  }

  // Level 3 — git remote.
  const remote = root ? gitRemote(root) : gitRemote(cwd);
  if (remote) {
    const key = canonicalizeGitRemote(remote);
    if (key) return { key, source: 'git', displayName: lastSegment(key), warn: null };
  }

  // Level 4 — directory name. NOT stable across machines; say so loudly.
  const key = lastSegment(root ?? cwd);
  return {
    key,
    source: 'basename',
    displayName: key,
    warn:
      `Project identity falls back to directory name "${key}" and may change across devices or directories.` +
      ` Run \`kireo project init\` to pin it in .kireo/project.json and commit the file.`,
  };
};
