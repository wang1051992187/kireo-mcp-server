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
