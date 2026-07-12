import type Parser from 'web-tree-sitter';
import type { SyntaxNode } from 'web-tree-sitter';

export type SymbolKind = 'function' | 'class' | 'method';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string;
  isExported: boolean;
  source: string;
}

export interface NodeRule {
  type: string;
  kind: SymbolKind;
  /** If the node is nested inside any of these ancestor types, treat it as a method. */
  methodWhenNestedIn?: string[];
}

export interface LanguageConfig {
  language: 'typescript' | 'python' | 'go' | 'java';
  rules: NodeRule[];
  isExported(node: SyntaxNode, source: string): boolean;
  docstring(node: SyntaxNode, source: string): string;
}

function nameOf(node: SyntaxNode): string | null {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  // Go method/func without name field: scan for an identifier child.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && (c.type === 'identifier' || c.type === 'field_identifier' || c.type === 'type_identifier')) {
      return c.text;
    }
    // One level deeper: e.g. Go type_declaration > type_spec > name: identifier "Calc"
    if (c) {
      const deeper = c.childForFieldName('name');
      if (deeper && (deeper.type === 'identifier' || deeper.type === 'type_identifier')) {
        return deeper.text;
      }
    }
  }
  return null;
}

function signatureOf(node: SyntaxNode, source: string): string {
  // If nested inside export_statement, include the export keyword in the signature.
  const target = node.parent?.type === 'export_statement' ? node.parent : node;
  const slice = source.slice(target.startIndex, target.endIndex);
  const firstLine = slice.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.slice(0, 200);
}

function hasAncestor(node: SyntaxNode, types: string[]): boolean {
  let p = node.parent;
  while (p) {
    if (types.includes(p.type)) return true;
    p = p.parent;
  }
  return false;
}

export function extractSymbols(
  cfg: LanguageConfig,
  parser: Parser,
  source: string,
): ExtractedSymbol[] {
  const tree = parser.parse(source);
  if (!tree) return [];
  const ruleByType = new Map(cfg.rules.map((r) => [r.type, r]));
  const out: ExtractedSymbol[] = [];

  const visit = (node: SyntaxNode): void => {
    const rule = ruleByType.get(node.type);
    if (rule) {
      const name = nameOf(node);
      if (name) {
        const kind =
          rule.methodWhenNestedIn && hasAncestor(node, rule.methodWhenNestedIn)
            ? 'method'
            : rule.kind;
        out.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: signatureOf(node, source),
          docstring: cfg.docstring(node, source),
          isExported: cfg.isExported(node, source),
          source: source.slice(node.startIndex, node.endIndex),
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  };
  visit(tree.rootNode);
  return out;
}
