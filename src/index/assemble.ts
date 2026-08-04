import { MEMORY_LIMITS, repoSlug } from '@kireo/shared';
import type { ExtractedSymbol } from './extractor.js';

export interface CodeMemoryMetadata {
  file_path: string;
  start_line: number;
  end_line: number;
  kind: string;
  symbol_name: string;
  language: string;
  is_exported: boolean;
  repo: string;
  content_hash: string;
}

export interface CreateMemoryDTO {
  content: string;
  type: 'code';
  namespace: string;
  metadata: CodeMemoryMetadata;
}

/** `code-${repoSlug(name)}` — asserts the result fits the shared namespace regex. */
export function codeNamespace(repoName: string): string {
  const ns = `code-${repoSlug(repoName)}`;
  if (!MEMORY_LIMITS.NAMESPACE_REGEX.test(ns)) {
    throw new Error(`derived code namespace "${ns}" violates NAMESPACE_REGEX`);
  }
  return ns;
}

/**
 * Assembles an {@link ExtractedSymbol} into a {@link CreateMemoryDTO} ready for
 * the memory API. `contentHash` is caller-supplied (e.g. SHA-256 of the raw
 * source); `namespace` should be `code-<slug>` obtained from {@link codeNamespace}.
 *
 * @throws if the serialized metadata exceeds `METADATA_BYTES_MAX` (2048 bytes),
 *   which can happen when `filePath` is unusually long.
 */
export function assembleSymbol(args: {
  symbol: ExtractedSymbol;
  filePath: string;
  language: string;
  repo: string;
  namespace: string;
  contentHash: string;
}): CreateMemoryDTO {
  const { symbol, filePath, language, repo, namespace, contentHash } = args;
  // `symbol.source` is the verbatim slice of the node, so it already begins with
  // the signature line — and for languages like Python it also contains the
  // docstring as the first body statement. Only prepend a part when it is NOT
  // already present in the source, so signature / docstring / body each appear
  // exactly once instead of `signature + signature + source` (BUG-007).
  const { source } = symbol;
  const firstLine = source.split('\n', 1)[0]?.trim() ?? '';
  const sigInSource = symbol.signature.length > 0 && firstLine.startsWith(symbol.signature);
  const docInSource = symbol.docstring.length > 0 && source.includes(symbol.docstring);
  const headParts: string[] = [];
  if (symbol.signature && !sigInSource) headParts.push(symbol.signature);
  if (symbol.docstring && !docInSource) headParts.push(symbol.docstring);
  const head = headParts.length > 0 ? `${headParts.join('\n')}\n` : '';
  const budget = MEMORY_LIMITS.CONTENT_MAX - head.length;
  const snippet = source.length > budget ? source.slice(0, Math.max(0, budget)) : source;
  const content = `${head}${snippet}`.slice(0, MEMORY_LIMITS.CONTENT_MAX);
  const metadata: CodeMemoryMetadata = {
    file_path: filePath,
    start_line: symbol.startLine,
    end_line: symbol.endLine,
    kind: symbol.kind,
    symbol_name: symbol.name,
    language,
    is_exported: symbol.isExported,
    repo,
    content_hash: contentHash,
  };
  const metadataJson = JSON.stringify(metadata);
  if (metadataJson.length > MEMORY_LIMITS.METADATA_BYTES_MAX) {
    throw new Error(
      `metadata for symbol "${symbol.name}" in "${filePath}" serializes to ` +
      `${metadataJson.length} bytes, exceeding METADATA_BYTES_MAX (${MEMORY_LIMITS.METADATA_BYTES_MAX})`,
    );
  }
  return {
    content,
    type: 'code',
    namespace,
    metadata,
  };
}
