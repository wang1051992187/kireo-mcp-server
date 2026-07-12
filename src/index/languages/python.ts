import type { SyntaxNode } from 'web-tree-sitter';
import type { LanguageConfig } from '../extractor.js';

export const pythonConfig: LanguageConfig = {
  language: 'python',
  rules: [
    { type: 'function_definition', kind: 'function', methodWhenNestedIn: ['class_definition'] },
    { type: 'class_definition', kind: 'class' },
  ],
  isExported(node: SyntaxNode): boolean {
    // Python has no export keyword: treat non-underscore-prefixed names as public.
    const name = node.childForFieldName('name')?.text ?? '';
    return name.length > 0 && !name.startsWith('_');
  },
  docstring(node: SyntaxNode): string {
    const body = node.childForFieldName('body');
    const first = body?.child(0);
    if (first?.type === 'expression_statement' && first.child(0)?.type === 'string') {
      return first.child(0)!.text;
    }
    return '';
  },
};
