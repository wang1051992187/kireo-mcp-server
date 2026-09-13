import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RedactResult {
  text: string;
  hits: string[];
}

/**
 * Known credential-shaped patterns. Deliberately narrow and literal — this is
 * a net for things that look like a key, not a business-secret detector.
 *
 * The real leak path is NOT the raw transcript: it's the distillation step
 * itself. A session that ran `cat .env` or pasted a production SQL result has
 * that text sitting in model context, and it gets paraphrased straight into
 * `evidence` / `files` when the model writes an entry. This module cannot see
 * that a paraphrase is happening — it only pattern-matches literal secret
 * shapes — so it is exactly a credential net, never a privacy guarantee. See
 * the "is honest that it cannot catch business secrets" test below: that is
 * the documented boundary, not a bug, and the reason dry-run + the kill
 * switch exist as the actual backstop.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'kireo_key', re: /ki_sk_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { name: 'openai_key', re: /sk-proj-[A-Za-z0-9]{8,}/g },
  { name: 'aws_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
];

/** Pattern-match known credential shapes and replace them with a placeholder. */
export const redact = (text: string): RedactResult => {
  const hits: string[] = [];
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, () => {
      hits.push(name);
      return '[REDACTED]';
    });
  }
  return { text: out, hits };
};

/**
 * Repo-level kill switch: a `.kireo/disabled` marker file OR the
 * `KIREO_DISABLED` env var. Either one must stop outbound context saving
 * cold — no redaction, no dry-run, no outbox write, nothing.
 */
export const isDisabled = (repoRoot: string, env: Record<string, string | undefined>): boolean => {
  if (env.KIREO_DISABLED) return true;
  return existsSync(join(repoRoot, '.kireo', 'disabled'));
};

export interface OutboundAuditEntry {
  ts: string;
  namespace: string;
  count: number;
  digests: string[];
}

/**
 * Per-entry audit digest: sha256 prefix + an 80-char preview, with
 * `metadata.files` folded into the hash input.
 *
 * Shared by context_save and by the outbox flush so both leave the SAME shape
 * of trace — a flush is a real outbound upload, and an audit log that only
 * covers the first attempt is not an audit log. `files` is included because it
 * travels in the same request body, so a files-only leak would otherwise
 * depart with zero trace.
 */
export const outboundDigests = (
  items: { content: string; metadata?: Record<string, unknown> }[],
): string[] =>
  items.map((it) => {
    const files = Array.isArray(it.metadata?.files) ? (it.metadata.files as string[]) : [];
    const hashInput = files.length > 0 ? `${it.content}\n${files.join('\n')}` : it.content;
    const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
    const filesTag = files.length > 0 ? ` [files:${files.length}]` : '';
    return `${hash}:${it.content.slice(0, 80)}${filesTag}`;
  });

/**
 * Local, append-only record of what left this device — summary only, never
 * content: a timestamp, the namespace, how many entries, and per-entry
 * digests (sha256 prefix + short preview, computed by the caller). Losing
 * this ability to audit outbound traffic would be worse than losing the
 * traffic itself, so this never truncates or rewrites the file — only appends.
 */
export const appendOutboundAudit = (logPath: string, entry: OutboundAuditEntry): void => {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
};
