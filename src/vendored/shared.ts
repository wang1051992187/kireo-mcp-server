// Vendored from @kireo/shared (the Kireo monorepo's internal package).
//
// The standalone public repo has no access to the monorepo workspace, so the
// small runtime surface the MCP server consumes — MEMORY_LIMITS and repoSlug —
// is copied here verbatim. Keep these values in sync with the API: MEMORY_LIMITS
// mirrors the server-side validation limits, and repoSlug must produce the same
// `code-<slug>` namespaces the API expects. This is the single source of truth
// for the published package.

/**
 * Server-side validation limits for memory content, mirrored client-side so the
 * CLI/tools can fail fast before a request hits the API.
 */
export const MEMORY_LIMITS = {
  CONTENT_MAX: 8000,
  ENTITY_MAX: 20,
  ENTITY_LEN_MAX: 64,
  TAG_MAX: 10,
  TAG_LEN_MAX: 32,
  TAG_REGEX: /^[a-z0-9_-]+$/,
  NAMESPACE_REGEX: /^[a-z0-9_-]{1,32}$/,
  METADATA_BYTES_MAX: 2 * 1024,
  BATCH_MAX: 100,
  LIST_LIMIT_DEFAULT: 50,
  LIST_LIMIT_MAX: 200,
  SEARCH_LIMIT_DEFAULT: 10,
  SEARCH_LIMIT_MAX: 50,
} as const;

/** Literal prefix for code-index namespaces. Stored namespace = CODE_NS_PREFIX + repoSlug(name). */
export const CODE_NS_PREFIX = 'code-';

// NAMESPACE_REGEX caps the whole namespace at 32 chars. The prefix consumes 5,
// so the bare slug is trimmed to 27 to keep `code-<slug>` valid.
const SLUG_MAX = 32 - CODE_NS_PREFIX.length; // 27

/**
 * Stable, regex-safe slug for a repo name. Lowercases, replaces any char
 * outside [a-z0-9_-] with '-', collapses repeated '-', trims edge '-', and
 * truncates so the prefixed namespace fits NAMESPACE_REGEX.
 */
export function repoSlug(repoName: string): string {
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'repo';
}
