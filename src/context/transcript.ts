export type TranscriptHost = 'claude-code' | 'codex';

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Raised when a transcript file has content but none of it matches the shape
 * we know how to read.
 *
 * This exists because the failure it guards is silent by nature: a host
 * changing its on-disk format yields a file we parse into zero turns, which is
 * indistinguishable from "nothing was said". Codex already broke this way once
 * inside a single 0.14x minor line (the retired `payload.type == 'user_message'`
 * shape is gone from current sessions). `kireo doctor` surfaces this error.
 */
export class TranscriptFormatError extends Error {
  constructor(
    readonly host: TranscriptHost,
    readonly sampledTypes: string[],
  ) {
    super(
      `无法解析 ${host} 的会话记录：文件有内容但没有一行匹配已知格式。 观察到的行类型：${sampledTypes
        .slice(0, 8)
        .join(', ')}。 宿主可能改了磁盘格式，请运行 \`kireo doctor\` 并升级 @kireo/mcp-server。`,
    );
    this.name = 'TranscriptFormatError';
  }
}

/**
 * Best-effort label for a line we couldn't classify, for TranscriptFormatError
 * diagnostics. Prefers the top-level `type` field (the common case for both
 * hosts); when a line has no `type` at all — e.g. a wholly foreign format —
 * falls back to its key set so the error still points at *something* instead
 * of leaving `sampledTypes` empty.
 */
const rowLabel = (row: unknown): string => {
  if (row && typeof row === 'object') {
    const t = (row as { type?: unknown }).type;
    if (typeof t === 'string') return t;
    const keys = Object.keys(row);
    if (keys.length > 0) return `{${keys.join(',')}}`;
  }
  return String(row);
};

interface ReadLines {
  rows: unknown[];
  /** Non-empty lines that were not valid JSON, for diagnostics. */
  unparsed: string[];
}

const readLines = (jsonl: string): ReadLines => {
  const rows: unknown[] = [];
  const unparsed: string[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // A truncated final line is normal for a live session — tolerated as
      // long as SOMETHING else parsed. Counted either way, because "the file
      // has content but not one line is JSON" is a format break, not silence.
      unparsed.push(t);
    }
  }
  return { rows, unparsed };
};

/**
 * `rows` came back empty. Decide between "nothing was said" and "we can no
 * longer read this host's on-disk format".
 *
 * Returning [] for both is exactly the silent failure spec §11 forbids: a host
 * switching away from line-delimited JSON (plain text, gzip, anything) made
 * every line fail JSON.parse, `rows` empty, and both parsers returned [] BEFORE
 * their TranscriptFormatError could fire — which only triggered on "valid JSON
 * lines, none of a known shape". Downstream, doctor's probeTranscripts then
 * reported `warn` ("maybe these sessions just haven't said anything — chat a
 * bit and re-run"), actively steering the user away from the real cause, and
 * runBackfill counted such files as `processed` and uploaded empty bodies.
 */
const assertReadable = (host: TranscriptHost, read: ReadLines): void => {
  if (read.rows.length > 0 || read.unparsed.length === 0) return;
  throw new TranscriptFormatError(
    host,
    read.unparsed.slice(0, 8).map((l) => `非 JSON 行: ${JSON.stringify(l.slice(0, 60))}`),
  );
};

/**
 * Flatten a message content field: a bare string, or an array of blocks.
 *
 * Block field casing is inconsistent across hosts/roles — verified on real
 * ~/.codex/sessions data (2026-08-30): UserMessage blocks carry
 * `{ type: 'text', text }` while AgentMessage blocks carry
 * `{ type: 'Text', text }`. The `type` discriminator's casing differs but the
 * value has always been the lowercase `text` field in every sample found; the
 * capitalized `Text` field check below is kept only as cheap tolerance in case
 * some block shape puts the value there instead — it is not exercised by any
 * real sample seen so far.
 */
const flattenContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      const o = b as { text?: unknown; Text?: unknown };
      if (typeof o.text === 'string') return o.text;
      if (typeof o.Text === 'string') return o.Text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const parseClaudeTranscript = (jsonl: string): TranscriptTurn[] => {
  const read = readLines(jsonl);
  assertReadable('claude-code', read);
  const rows = read.rows;
  if (rows.length === 0) return [];

  const turns: TranscriptTurn[] = [];
  const seenTypes = new Set<string>();

  for (const r of rows) {
    // A JSONL line whose entire content is the literal `null` is valid JSON
    // (readLines' JSON.parse succeeds, so it isn't dropped as a truncated
    // line) but is not an object, and `r as {...}` casts don't change that at
    // runtime — accessing a property on it throws a native TypeError instead
    // of going through the parser's own error contract. Treat it as just
    // another unrecognized row shape.
    if (r === null || typeof r !== 'object') {
      seenTypes.add(rowLabel(r));
      continue;
    }
    const row = r as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    seenTypes.add(rowLabel(r));
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const text = flattenContent(row.message?.content);
    if (text.trim()) turns.push({ role: row.type, text });
  }

  if (turns.length === 0) throw new TranscriptFormatError('claude-code', [...seenTypes]);
  return turns;
};

export const parseCodexRollout = (jsonl: string): TranscriptTurn[] => {
  const read = readLines(jsonl);
  assertReadable('codex', read);
  const rows = read.rows;
  if (rows.length === 0) return [];

  const turns: TranscriptTurn[] = [];
  const seenTypes = new Set<string>();

  for (const r of rows) {
    // See the matching guard in parseClaudeTranscript: a line that is the
    // literal JSON value `null` parses successfully but isn't an object, and
    // `row.payload` below would throw a native TypeError on it.
    if (r === null || typeof r !== 'object') {
      seenTypes.add(rowLabel(r));
      continue;
    }
    const row = r as {
      type?: unknown;
      payload?: { type?: unknown; item?: { type?: unknown; content?: unknown } };
    };
    const item = row.payload?.item;
    const itemType = typeof item?.type === 'string' ? item.type : undefined;
    seenTypes.add(
      [row.type, row.payload?.type, itemType].filter((x) => typeof x === 'string').join('/'),
    );
    if (itemType !== 'UserMessage' && itemType !== 'AgentMessage') continue;
    const text = flattenContent(item?.content);
    if (text.trim()) {
      turns.push({ role: itemType === 'UserMessage' ? 'user' : 'assistant', text });
    }
  }

  if (turns.length === 0) throw new TranscriptFormatError('codex', [...seenTypes]);
  return turns;
};
