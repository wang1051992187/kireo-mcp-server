import type { GrammarName } from '../grammars.js';
import type { LanguageConfig } from '../extractor.js';
import { goConfig } from './go.js';
import { javaConfig } from './java.js';
import { pythonConfig } from './python.js';
import { typescriptConfig } from './typescript.js';

/** Map a file extension to its grammar + extractor config. */
export function configForExtension(
  ext: string,
): { grammar: GrammarName; config: LanguageConfig } | null {
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
    case '.js':
    case '.mjs':
    case '.cjs':
      return { grammar: 'typescript', config: typescriptConfig };
    case '.tsx':
    case '.jsx':
      return { grammar: 'tsx', config: typescriptConfig };
    case '.py':
      return { grammar: 'python', config: pythonConfig };
    case '.go':
      return { grammar: 'go', config: goConfig };
    case '.java':
      return { grammar: 'java', config: javaConfig };
    default:
      return null;
  }
}
