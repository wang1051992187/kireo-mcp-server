export type GitExec = (args: string[], cwd: string) => string;

/**
 * File-level diff between a commit and the working tree.
 *
 * Paths come back verbatim via `-z`, NOT through git's default quoting.
 * With `core.quotePath` at its default (true) and no `-z`, git renders any
 * non-ASCII path as a quoted octal escape — `普通.py` arrives as
 * `"\346\231\256\351\200\232.py"`. That string matched nothing in
 * `bufByPath`, so the file was skipped entirely with no warning at all
 * (`relPath.slice(lastIndexOf('.'))` yields `.py"`, `configForExtension`
 * returns null, and the early `return []` never reaches extractFileDTOs'
 * catch); the same garbage path also went into the prune DELETE, so a deleted
 * non-ASCII file's stale symbols could never be cleared either. `filesChanged`
 * counted it and `symbols` did not — the only visible trace. For a product
 * whose entire CLI output is Chinese, non-ASCII filenames are not an edge case.
 *
 * `-z` also removes the TAB/quote parsing entirely: the stream is
 * `status NUL path [NUL newPath] NUL`, so a path containing a tab or a quote
 * is handled for free. `core.quotePath=false` is passed as well; harmless
 * belt-and-braces since `-z` already disables quoting.
 *
 * Paths are relative to the REPO ROOT, not to the directory git ran in — see
 * run-index.ts, which rebases them onto the index root.
 *
 * Returns null on any git failure — a missing or unreachable commit (shallow
 * clone, rebased history, pruned branch) must degrade to a full scan rather
 * than silently indexing nothing.
 */
export const diffSince = (
  root: string,
  commit: string,
  exec: GitExec,
): { changed: string[]; deleted: string[] } | null => {
  let out: string;
  try {
    out = exec(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        '--name-status',
        '--diff-filter=ACMRD',
        `${commit}..HEAD`,
      ],
      root,
    );
  } catch {
    return null;
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  const posix = (p: string) => p.replace(/\\/g, '/');

  // NUL-separated stream: [status, path] pairs, except renames/copies which
  // are [status, oldPath, newPath].
  const fields = out.split('\0').filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] as string;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 3;
      if (!from || !to) continue;
      // A rename retires the old path exactly like a delete does.
      if (status.startsWith('R')) deleted.push(posix(from));
      changed.push(posix(to));
      continue;
    }
    const path = fields[i + 1];
    i += 2;
    if (!path) continue;
    if (status.startsWith('D')) deleted.push(posix(path));
    else changed.push(posix(path));
  }
  return { changed, deleted };
};
