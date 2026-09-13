import { repoSlug } from './slug.js';

/** Global bucket for the cross-project overview. One per user. */
export const HOME_NAMESPACE = 'kireo-home';

/**
 * Cap on the slug portion of a namespace.
 *
 * NOT sized off NAMESPACE_REGEX's 32-char ceiling directly — it is sized so
 * the *fully composed* namespace (`<prefix>-<slug>-<hash6>`) never exceeds
 * repoSlug's OWN internal 27-char truncation budget (`32 - 'code-'.length`,
 * see slug.ts). That budget was designed for a bare slug about to be
 * prefixed with `code-`; here it instead bites the whole already-prefixed
 * string when the idempotence test re-runs `repoSlug(ns)` on it. Worst case
 * is the `code-` prefix (5 chars): `5 + slug + 1(dash) + 6(hash) <= 27` =>
 * slug <= 15. Miss this and repoSlug silently truncates the composed
 * namespace further on any later pass — the very bucket-split bug this
 * module exists to prevent, just triggered one level up.
 */
const SLUG_MAX = 15;
const HASH_LEN = 6;

const lastSegment = (s: string): string => {
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? s;
};

/**
 * Truncate to SLUG_MAX and re-trim.
 *
 * The trailing re-trim is load-bearing: repoSlug collapses `--` to `-`, so a
 * truncation landing on a hyphen would produce `foo--<hash>` here and
 * `foo-<hash>` on any later pass — the same project silently splitting into
 * two buckets. `context-namespace.test.ts` asserts `repoSlug(ns) === ns`.
 */
const shortSlug = (key: string): string =>
  repoSlug(lastSegment(key)).slice(0, SLUG_MAX).replace(/-+$/g, '') || 'repo';

const suffix = (key: string, sha256Hex: (s: string) => string): string =>
  sha256Hex(key).slice(0, HASH_LEN);

/**
 * Context bucket. Deliberately separate from the code bucket: GET /v1/memories
 * offers no type or tag filter and orders by occurred_at DESC, while code
 * symbols land with occurred_at = now — sharing one bucket makes `resume`
 * return nothing but code symbols.
 */
export const ctxNamespace = (canonicalKey: string, sha256Hex: (s: string) => string): string =>
  `ctx-${shortSlug(canonicalKey)}-${suffix(canonicalKey, sha256Hex)}`;

/** Code-symbol bucket, hash-suffixed so two repos named `api` never collide. */
export const codeNamespaceV2 = (canonicalKey: string, sha256Hex: (s: string) => string): string =>
  `code-${shortSlug(canonicalKey)}-${suffix(canonicalKey, sha256Hex)}`;
