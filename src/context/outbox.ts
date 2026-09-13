import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OutboxRecord {
  ts: string;
  namespace: string;
  entries: unknown[];
  /**
   * Ids this save supersedes, to be soft-deleted only AFTER its entries are
   * safely uploaded. Recorded here because the delete intent is otherwise
   * unrecoverable: a replay from disk that cannot see it would resurrect the
   * duplicate the save meant to retire.
   */
  supersedes?: string[];
}

/**
 * Local write-ahead buffer for distilled context.
 *
 * Without it, any upload failure — offline, unconfigured key, 402, VM restart,
 * TEI timeout — vaporises the distillation permanently: it surfaces as an MCP
 * error at the tail of a session, the user does not retry, and closing the
 * session loses it for good. That single experience destroys the "I saved it"
 * mental model the whole product rests on. Write first, upload second.
 */
export const writeOutbox = (dir: string, rec: OutboxRecord): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Timestamp orders them; the random suffix keeps same-millisecond writes apart.
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  const path = join(dir, name);
  // 0600: the payload can quote anything the session touched.
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
  return path;
};

export const listOutbox = (dir: string): { path: string; rec: OutboxRecord }[] => {
  if (!existsSync(dir)) return [];
  const out: { path: string; rec: OutboxRecord }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      out.push({ path, rec: JSON.parse(readFileSync(path, 'utf8')) as OutboxRecord });
    } catch {
      // Leave corrupt files in place — losing them silently is the exact
      // failure this module exists to prevent.
    }
  }
  return out;
};

export const dropOutbox = (path: string): void => {
  rmSync(path, { force: true });
};
