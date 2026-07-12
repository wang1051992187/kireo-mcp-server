import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java';

const require = createRequire(import.meta.url);

// web-tree-sitter is a CJS module that mutates its own exported class on init().
// Use createRequire to get a stable reference that reflects those mutations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Parser = require('web-tree-sitter') as typeof import('web-tree-sitter');
type Parser = import('web-tree-sitter');

/** Absolute path to a grammar wasm shipped by tree-sitter-wasms (out/tree-sitter-<name>.wasm). */
export function grammarWasmPath(name: GrammarName): string {
  const pkgJson = require.resolve('tree-sitter-wasms/package.json');
  return join(dirname(pkgJson), 'out', `tree-sitter-${name}.wasm`);
}

let initPromise: Promise<void> | null = null;
const cache = new Map<GrammarName, Parser>();

async function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

export async function loadParser(name: GrammarName): Promise<Parser> {
  const hit = cache.get(name);
  if (hit) return hit;
  await ensureInit();
  const language = await Parser.Language.load(grammarWasmPath(name));
  const parser = new Parser();
  parser.setLanguage(language);
  cache.set(name, parser);
  return parser;
}
