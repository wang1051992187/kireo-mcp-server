import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { MEMORY_LIMITS, ctxNamespace } from '@kireo/shared';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A directory archive is deliberately separate from the Git-based relay. */
export function archiveProject(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
  const directory = realpathSync(cwd);
  if (!statSync(directory).isDirectory()) throw new Error('cwd must be a directory');
  const name = basename(directory);
  if (!name) throw new Error('Choose a project directory instead of the filesystem root');
  // Distinguish same-named checkouts without sending the absolute path upstream.
  const key = `directory:${digest(directory).slice(0, 16)}/${name}`;
  return {
    directory,
    name,
    filename: `${name}.md`,
    namespace: ctxNamespace(key, digest),
    archiveDir: join(directory, '.kireo', 'archives'),
  };
}

/** Lossless splitting within the API limit, including astral Unicode at the boundary. */
export function archiveChunks(text: string, limit: number = MEMORY_LIMITS.CONTENT_MAX): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/** Missing/duplicate acknowledgements must never discard the only retry copy. */
export function completeBatchAck(
  result: { succeeded?: { index: number; id: string }[]; failures?: unknown[] },
  count: number,
): boolean {
  return (
    Array.isArray(result.succeeded) &&
    Array.isArray(result.failures) &&
    result.failures.length === 0 &&
    result.succeeded.length === count &&
    new Set(result.succeeded.map((entry) => entry.index)).size === count &&
    result.succeeded.every(
      (entry) =>
        Number.isInteger(entry.index) &&
        entry.index >= 0 &&
        entry.index < count &&
        typeof entry.id === 'string' &&
        entry.id.length > 0,
    )
  );
}
