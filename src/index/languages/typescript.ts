import type { SyntaxNode } from 'web-tree-sitter';
import type { LanguageConfig } from '../extractor.js';

export const typescriptConfig: LanguageConfig = {
  language: 'typescript',
  rules: [
    { type: 'function_declaration', kind: 'function' },
    { type: 'class_declaration', kind: 'class' },
    { type: 'method_definition', kind: 'method' },
  ],
  isExported(node: SyntaxNode): boolean {
    // `export function f(){}` => function_declaration whose parent is export_statement.
    return node.parent?.type === 'export_statement';
  },
  docstring(node: SyntaxNode, source: string): string {
    // Leading /** ... */ block comment immediately above the node.
    // When the node is wrapped in an export_statement, walk up to find the comment
    // that precedes the export_statement (matching how signatureOf handles this).
    const target = node.parent?.type === 'export_statement' ? node.parent : node;
    const prev = target.previousSibling;
    if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
      return source.slice(prev.startIndex, prev.endIndex);
    }
    return '';
  },
};
