import { MEMORY_LIMITS } from '@kireo/shared';
import { redact } from './redact.js';
import {
  type TranscriptHost,
  type TranscriptTurn,
  parseClaudeTranscript,
  parseCodexRollout,
} from './transcript.js';

/** Minimal shape both `node:fs` and an in-memory test double satisfy. */
export interface StatLike {
  isDirectory: () => boolean;
  mtimeMs: number;
}

/** Filesystem access, injected so tests never touch the real `homeDir`. */
export interface BackfillFsDeps {
  readDir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  stat: (path: string) => Promise<StatLike>;
}

export interface DiscoverSessionsOpts extends BackfillFsDeps {
  since: Date;
  homeDir: string;
}

export interface DiscoveredSession {
  host: TranscriptHost;
  path: string;
  cwdSlug: string;
  mtime: Date;
}

/** How many leading lines to scan for the session's recorded cwd. */
const CWD_SCAN_LINES = 40;

/**
 * The absolute cwd a session ran in, read out of the transcript itself.
 *
 * Both hosts record it: Claude Code puts a top-level `cwd` on its rows (not
 * always the first one — verified on real ~/.claude/projects data), Codex puts
 * it under `payload.cwd` in the session_meta line. This is what lets a
 * backfilled session be filed under the SAME project identity a live
 * `context_save` in that directory would resolve to; the cwd-slug alone cannot
 * (it is lossy and un-reversible). Returns null when nothing recorded it.
 */
export function sessionCwd(jsonl: string): string | null {
  let n = 0;
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (++n > CWD_SCAN_LINES) break;
    let row: unknown;
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const direct = (row as { cwd?: unknown }).cwd;
    if (typeof direct === 'string' && direct) return direct;
    const nested = (row as { payload?: { cwd?: unknown } }).payload?.cwd;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

const CLAUDE_ROOT = '.claude/projects';
const CODEX_ROOT = '.codex/sessions';

/**
 * Turn any string that isn't `[a-zA-Z0-9]` into `-`, matching Claude's own
 * convention. Exported because `context/transcript-locate.ts` needs the exact
 * same slug to find a live session's jsonl by its cwd.
 */
export const slugifyCwd = (cwd: string): string => {
  const slug = cwd.trim().replace(/[^a-zA-Z0-9]+/g, '-');
  return slug || 'unknown';
};

/**
 * Recursively list every `*.jsonl` file under `dir`, with its mtime.
 *
 * A missing directory (no `.claude` or no `.codex` on this machine) is not an
 * error — it just contributes zero sessions, matching "empty directory
 * returns [] rather than throws".
 */
async function walkJsonlFiles(
  deps: BackfillFsDeps,
  dir: string,
): Promise<{ path: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await deps.readDir(dir);
  } catch {
    return [];
  }
  const out: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const full = `${dir}/${name}`;
    let st: StatLike;
    try {
      st = await deps.stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...(await walkJsonlFiles(deps, full)));
    } else if (name.endsWith('.jsonl')) {
      out.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** `~/.claude/projects/<slug>/<sessionId>.jsonl` — the slug IS the cwd-slug. */
const claudeCwdSlug = (claudeRoot: string, path: string): string => {
  const rest = path.slice(claudeRoot.length + 1);
  return rest.split('/')[0] || 'unknown';
};

/**
 * Codex rollouts carry no cwd in their path (they're grouped by date, not by
 * project) — the cwd lives in the first line's `payload.cwd` (session_meta).
 * Any failure to read/parse it (missing field, foreign shape, unreadable
 * file) degrades to a single 'unknown' bucket rather than throwing; discovery
 * must never abort over a metadata field it can't find.
 */
async function codexCwdSlug(deps: BackfillFsDeps, path: string): Promise<string> {
  try {
    const text = await deps.readFile(path);
    const firstLine = text.split('\n').find((l) => l.trim());
    if (!firstLine) return 'unknown';
    const row = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    const cwd = row.payload?.cwd;
    return typeof cwd === 'string' && cwd ? slugifyCwd(cwd) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Every Claude Code / Codex session touched since `opts.since`, tagged with
 * its host and a cwd-slug for grouping.
 *
 * Claude's cwd-slug is read straight off the directory name Claude Code
 * already produced (see {@link claudeCwdSlug}); Codex's is derived from the
 * rollout's own recorded cwd (see {@link codexCwdSlug}) since its on-disk
 * layout groups by date, not by project.
 */
export async function discoverSessions(opts: DiscoverSessionsOpts): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  const sinceMs = opts.since.getTime();

  const claudeRoot = `${opts.homeDir}/${CLAUDE_ROOT}`;
  for (const f of await walkJsonlFiles(opts, claudeRoot)) {
    if (f.mtimeMs < sinceMs) continue;
    out.push({
      host: 'claude-code',
      path: f.path,
      cwdSlug: claudeCwdSlug(claudeRoot, f.path),
      mtime: new Date(f.mtimeMs),
    });
  }

  const codexRoot = `${opts.homeDir}/${CODEX_ROOT}`;
  for (const f of await walkJsonlFiles(opts, codexRoot)) {
    if (f.mtimeMs < sinceMs) continue;
    out.push({
      host: 'codex',
      path: f.path,
      cwdSlug: await codexCwdSlug(opts, f.path),
      mtime: new Date(f.mtimeMs),
    });
  }

  return out;
}

/** Group discovered sessions by their cwd-slug (their project, best-effort). */
export function groupByProject(sessions: DiscoveredSession[]): Map<string, DiscoveredSession[]> {
  const map = new Map<string, DiscoveredSession[]>();
  for (const s of sessions) {
    const existing = map.get(s.cwdSlug);
    if (existing) existing.push(s);
    else map.set(s.cwdSlug, [s]);
  }
  return map;
}

/** A successfully-parsed session, handed to `post` for upload. */
export interface BackfillItem {
  host: TranscriptHost;
  path: string;
  cwdSlug: string;
  /** Absolute cwd recorded in the transcript, or null. See {@link sessionCwd}. */
  cwd: string | null;
  turns: TranscriptTurn[];
}

/**
 * The exact bytes one backfilled session becomes on the wire: its turns joined,
 * known credential shapes redacted, then truncated to `CONTENT_MAX`.
 *
 * This is deliberately THE single definition of "what will be sent". The
 * confirmation gate in cli.ts prints this, and cli.ts's `post` uploads this —
 * both call this one function, so the text a user approves and the bytes that
 * leave the device cannot drift apart. It used to be two hand-rolled copies:
 * the preview joined raw turns (no redaction, no truncation) while claiming in
 * the very next line that credentials had been scrubbed, so real `ghp_…` /
 * `sk-…` / `AKIA…` strings from history were printed to the terminal and the
 * approved text was not what got uploaded. Keep them fused: never format an
 * outbound backfill body anywhere else.
 *
 * Redaction is a credential net, not a privacy guarantee — see redact.ts.
 */
export function backfillBody(item: BackfillItem): string {
  const raw = item.turns.map((t) => `[${t.role}] ${t.text}`).join('\n\n');
  return redact(raw).text.slice(0, MEMORY_LIMITS.CONTENT_MAX);
}

/**
 * What the caller's privacy gate decided about one session.
 *
 *  - `allow` — the session's project was identified and is not disabled.
 *  - `disabled` — that project has the kill switch on; skip it.
 *  - `unresolved` — the session's project could NOT be identified, so its
 *    `.kireo/disabled` marker could not be consulted. Fail safe: skip.
 */
export type SessionPrivacyVerdict = 'allow' | 'disabled' | 'unresolved';

export interface RunBackfillOpts extends DiscoverSessionsOpts {
  /**
   * Deliberately no schema default here either — see context-save.ts's
   * `dry_run`. `??` below treats omission as `true` (preview-only), which is
   * the one behavior this task actually requires: only an explicit `false`
   * uploads anything.
   */
  dryRun?: boolean;
  /** Upload one already-parsed session. Never called while `dryRun`. */
  post: (item: BackfillItem) => Promise<void>;
  /**
   * Per-session privacy decision, consulted BEFORE `onParsed` and before
   * `post`. Required, not optional-with-a-permissive-default: backfill reads
   * every project on the machine, so "the caller forgot to wire the kill
   * switch" must be a compile error rather than a silent upload of a
   * confidential repo's transcripts.
   *
   * The policy itself (which directory a session belongs to, whether that
   * directory is disabled) lives in the caller — this module owns no
   * filesystem or env access of its own.
   */
  privacyGate: (item: BackfillItem) => SessionPrivacyVerdict;
  /**
   * Fires for every successfully-parsed session regardless of `dryRun`, so a
   * caller can render the exact preview text before deciding to re-run for
   * real — mirrors context_save's "show the preview, then call again with
   * dry_run:false" shape.
   */
  onParsed?: (item: BackfillItem) => void;
}

export interface RunBackfillResult {
  /**
   * Sessions that made it all the way through: parsed, and — when not
   * `dryRun` — uploaded. A session whose upload failed is NOT counted here; it
   * is counted in `skipped` instead, so `processed + skipped` always equals the
   * number of discovered sessions and no session is ever counted twice.
   */
  processed: number;
  /**
   * Sessions that did not make it: parse failures, upload failures, and
   * sessions the privacy gate refused. `processed + skipped` always equals the
   * number of discovered sessions.
   */
  skipped: number;
  /** Subset of `skipped`: the session's project has the kill switch on. */
  privacySkipped: number;
  /**
   * Subset of `skipped`: the session's project could not be identified, so its
   * kill switch could not be read and the session was skipped fail-safe.
   */
  unresolvedSkipped: number;
  /**
   * The subset of `skipped` that parsed cleanly but failed to upload. Kept
   * separate so the caller can tell "one file has an unreadable format"
   * (benign, exit 0) from "the API rejected our writes" (the run did not do
   * what the user asked, exit non-zero). Always 0 under `dryRun`.
   */
  uploadFailed: number;
  errors: string[];
}

/**
 * Discover sessions since `opts.since`, parse each with its host's parser,
 * and (unless `dryRun`) upload every one that parsed cleanly.
 *
 * A single file's `TranscriptFormatError` (transcript.ts) — one host having
 * quietly changed its on-disk shape — must never abort a 90-day scan: it is recorded
 * in `errors` and counted in `skipped`, and the loop moves on. Any other
 * per-file error (unreadable file, permissions) is treated the same way for
 * the same reason: one bad file is not a reason to lose the other 46.
 *
 * **The upload half is under exactly the same rule.** It used not to be: a
 * single 429/503 (or a rest-client retry budget running out) threw straight
 * out of this loop, up through cli.ts, into bin/kireo.cjs's top-level catch —
 * so session #12 of 47 failing meant the user saw `[kireo] fatal: …`, exit 1,
 * and no count of what had already been uploaded or what never got tried. A
 * failed upload is now recorded and the loop continues, exactly like a failed
 * parse; the returned summary is what tells the caller how bad it was.
 *
 * Every recorded error names the file and the stage that failed, because
 * "429 Too Many Requests" on its own tells a user nothing about which of 47
 * sessions to retry.
 */
export async function runBackfill(opts: RunBackfillOpts): Promise<RunBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const sessions = await discoverSessions(opts);

  let processed = 0;
  let skipped = 0;
  let uploadFailed = 0;
  let privacySkipped = 0;
  let unresolvedSkipped = 0;
  const errors: string[] = [];
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  for (const s of sessions) {
    let turns: TranscriptTurn[];
    let cwd: string | null = null;
    try {
      const text = await opts.readFile(s.path);
      turns = s.host === 'claude-code' ? parseClaudeTranscript(text) : parseCodexRollout(text);
      // Same text, already in memory — no second read just to learn the cwd.
      cwd = sessionCwd(text);
    } catch (err) {
      // TranscriptFormatError (one host quietly changed its on-disk shape)
      // is the case this task calls out explicitly, but any other per-file
      // read/parse error is handled identically — one bad file is not a
      // reason to lose the other 46.
      skipped++;
      errors.push(`${s.path}（解析）：${reason(err)}`);
      continue;
    }

    const item: BackfillItem = {
      host: s.host,
      path: s.path,
      cwdSlug: s.cwdSlug,
      cwd,
      turns,
    };
    // Privacy gate BEFORE `onParsed` and before `post`. Before `onParsed`
    // because that callback is what cli.ts prints as the confirmation preview:
    // a disabled repo's raw transcript must not be dumped into the terminal
    // either. The kill switch used to be evaluated ONCE, against the repo the
    // user happened to be standing in, while this loop walked every project
    // under ~/.claude/projects and ~/.codex/sessions — so `cd ~ && kireo
    // backfill --dry-run=false` shipped a confidential repo's sessions with
    // its `.kireo/disabled` sitting right there, unread.
    const verdict = opts.privacyGate(item);
    if (verdict !== 'allow') {
      skipped++;
      if (verdict === 'disabled') privacySkipped++;
      else unresolvedSkipped++;
      continue;
    }

    opts.onParsed?.(item);
    if (!dryRun) {
      try {
        await opts.post(item);
      } catch (err) {
        // Same containment as the parse stage above: one rate-limited or
        // rejected upload must not throw away the other 46 sessions, nor the
        // summary that tells the user which ones to retry.
        skipped++;
        uploadFailed++;
        errors.push(`${s.path}（上传）：${reason(err)}`);
        continue;
      }
    }
    // Counted only once the session is genuinely done — parsed, and uploaded
    // when an upload was asked for. Under dryRun there is nothing to upload,
    // so "parsed" IS done, and cli.ts's `dry.processed === 0` early-out keeps
    // meaning "nothing worth confirming".
    processed++;
  }

  return { processed, skipped, uploadFailed, privacySkipped, unresolvedSkipped, errors };
}
