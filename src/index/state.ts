import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type IndexState = Record<string, string>;

const STATE_DIR = '.kireo';
const STATE_FILE = 'index-state.json';

export function hashContent(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function loadState(root: string): Promise<IndexState> {
  try {
    const raw = await readFile(join(root, STATE_DIR, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed as Record<string, unknown>).every((v) => typeof v === 'string')
    ) {
      return parsed as IndexState;
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveState(root: string, state: IndexState): Promise<void> {
  const dir = join(root, STATE_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, STATE_FILE);
  const tmp = join(dir, `.index-state.tmp.${process.pid}`);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

export interface StateDiff {
  changed: string[];
  deleted: string[];
  unchanged: string[];
}

export function diffState(prev: IndexState, current: Record<string, string>): StateDiff {
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (prev[path] === hash) unchanged.push(path);
    else changed.push(path);
  }
  const deleted = Object.keys(prev).filter((p) => !(p in current));
  return { changed, deleted, unchanged };
}
