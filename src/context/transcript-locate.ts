import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../lib/platform.js';
import { slugifyCwd } from './backfill.js';
import type { TranscriptHost } from './transcript.js';

/**
 * Best-effort on-disk path of the transcript for a LIVE session.
 *
 * Used by context_save to run spec §6.2[4]'s literal evidence check. Claude
 * Code's layout is deterministic — `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
 * with the same slug rule backfill already relies on — so this is one
 * `existsSync`, no directory walking on the save path.
 *
 * Codex returns null on purpose: its rollouts are grouped by DATE with a
 * `rollout-<ts>-<uuid>.jsonl` filename, so finding one by session id would
 * mean walking `~/.codex/sessions` on every save. The Codex skill passes
 * `transcript_path` explicitly instead; when it doesn't, verification degrades
 * open (verifyEvidence returns all-true for an empty transcript), exactly like
 * spec §6.2[4]'s "格式探测失败 → 跳过校验，绝不阻断".
 */
export const locateTranscript = (
  host: string,
  sessionId: string,
  cwd: string,
  home: string = homeDir(),
): string | null => {
  if (host !== ('claude-code' satisfies TranscriptHost)) return null;
  if (!sessionId || /[\\/]/.test(sessionId)) return null;
  const path = join(home, '.claude', 'projects', slugifyCwd(cwd), `${sessionId}.jsonl`);
  return existsSync(path) ? path : null;
};
