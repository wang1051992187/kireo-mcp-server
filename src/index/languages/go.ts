import type { SyntaxNode } from 'web-tree-sitter';
import type { LanguageConfig } from '../extractor.js';

export const goConfig: LanguageConfig = {
  language: 'go',
  rules: [
    { type: 'function_declaration', kind: 'function' },
    { type: 'method_declaration', kind: 'method' },
    { type: 'type_declaration', kind: 'class' },
  ],
  isExported(node: SyntaxNode): boolean {
    // Go: exported identifiers start with an uppercase letter.
    const name =
      node.childForFieldName('name')?.text ??
      node.descendantsOfType?.('type_spec')?.[0]?.childForFieldName('name')?.text ??
      '';
    const first = name.charAt(0);
    return first !== '' && first === first.toUpperCase() && first !== first.toLowerCase();
  },
  docstring(): string {
    return '';
  },
};
