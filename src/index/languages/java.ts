import type { SyntaxNode } from 'web-tree-sitter';
import type { LanguageConfig } from '../extractor.js';

export const javaConfig: LanguageConfig = {
  language: 'java',
  rules: [
    { type: 'class_declaration', kind: 'class' },
    { type: 'interface_declaration', kind: 'class' },
    { type: 'method_declaration', kind: 'method' },
  ],
  isExported(node: SyntaxNode, source: string): boolean {
    // The Java grammar exposes modifiers as a child node of type 'modifiers',
    // but it is NOT accessible via childForFieldName — scan children by type.
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type === 'modifiers') {
        return source.slice(c.startIndex, c.endIndex).includes('public');
      }
    }
    return false;
  },
  docstring(node: SyntaxNode, source: string): string {
    const prev = node.previousSibling;
    if (prev?.type === 'block_comment' && prev.text.startsWith('/**')) {
      return source.slice(prev.startIndex, prev.endIndex);
    }
    return '';
  },
};
