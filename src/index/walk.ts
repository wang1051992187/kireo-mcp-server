import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import ignore from 'ignore';
import { configForExtension } from './languages/index.js';

export const DEFAULT_EXCLUDES = ['node_modules', 'dist', '.venv', '.git', '.kireo'];
export const MAX_FILE_BYTES = 1_000_000;

export interface WalkedFile {
  absPath: string;
  relPath: string;
  ext: string;
}

async function loadGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(DEFAULT_EXCLUDES);
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore — defaults only
  }
  return ig;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function walkRepo(root: string): Promise<WalkedFile[]> {
  const ig = await loadGitignore(root);
  const out: WalkedFile[] = [];

  const recurse = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (!rel || ig.ignores(rel)) continue;
      if (e.isDirectory()) {
        await recurse(abs);
        continue;
      }
      // symlinks intentionally skipped (dirent.isFile() is false for them)
      if (!e.isFile()) continue;
      const ext = extname(e.name);
      if (!configForExtension(ext)) continue;
      const info = await stat(abs).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(abs).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      out.push({ absPath: abs, relPath: rel, ext });
    }
  };

  await recurse(root);
  return out;
}
