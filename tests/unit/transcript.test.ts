import { describe, expect, it } from 'vitest';

import {
  TranscriptFormatError,
  parseClaudeTranscript,
  parseCodexRollout,
} from '../../src/context/transcript.js';

const claudeJsonl = [
  JSON.stringify({ type: 'mode', mode: 'normal' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the search bug' } }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'looking at client.ts:31' }] },
  }),
  JSON.stringify({ type: 'ai-title', title: 'x' }),
].join('\n');

// Shape verified against a real ~/.codex/sessions/**/rollout-*.jsonl on 2026-08-30 (5 recent
// files, spot-checked back to 2026-08-18): item.text (top-level string) does NOT occur for
// either message kind. Both UserMessage and AgentMessage carry an `item.content` array of
// blocks; the block's own `type` discriminator is 'text' for UserMessage and 'Text' for
// AgentMessage, but the string itself lives under a lowercase `text` field in both cases.
const codexJsonl = [
  JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', id: 'i1', content: [{ type: 'text', text: 'index my repo' }] },
    },
  }),
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: 'i2',
        content: [{ type: 'Text', text: 'walking the tree' }],
        phase: 'commentary',
      },
    },
  }),
].join('\n');

describe('parseClaudeTranscript', () => {
  it('extracts user and assistant turns in order, skipping bookkeeping lines', () => {
    const turns = parseClaudeTranscript(claudeJsonl);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user' });
    expect(turns[0]?.text).toContain('fix the search bug');
    expect(turns[1]).toMatchObject({ role: 'assistant' });
    expect(turns[1]?.text).toContain('client.ts:31');
  });

  it('returns [] for an empty file rather than throwing', () => {
    expect(parseClaudeTranscript('')).toEqual([]);
    expect(parseClaudeTranscript('\n\n')).toEqual([]);
  });

  it('throws TranscriptFormatError when nothing parses — never a silent []', () => {
    // The whole point: a host format change must be loud. Codex already broke
    // this way once inside a single 0.14x minor line.
    const alien = [
      JSON.stringify({ kind: 'turn', who: 'human', body: 'hi' }),
      JSON.stringify({ kind: 'turn', who: 'ai', body: 'hello' }),
    ].join('\n');
    expect(() => parseClaudeTranscript(alien)).toThrow(TranscriptFormatError);
    try {
      parseClaudeTranscript(alien);
    } catch (e) {
      expect((e as TranscriptFormatError).sampledTypes.length).toBeGreaterThan(0);
    }
  });

  it('tolerates a truncated last line', () => {
    expect(() => parseClaudeTranscript(`${claudeJsonl}\n{"type":"user","mess`)).not.toThrow();
  });

  it('tolerates a line whose value is the JSON literal null, extracting the valid turns around it', () => {
    // `null` is valid JSON, so readLines' JSON.parse doesn't drop it as a
    // truncated line — it reaches the row loop as an actual `null` value.
    // Naively casting and reading `row.type` on that throws a native
    // TypeError instead of following the parser's own three-way contract.
    const withNullLine = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      'null',
    ].join('\n');
    const turns = parseClaudeTranscript(withNullLine);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain('hi');
  });

  it('throws TranscriptFormatError (not a raw TypeError) when every line is the JSON literal null', () => {
    expect(() => parseClaudeTranscript('null\nnull')).toThrow(TranscriptFormatError);
    try {
      parseClaudeTranscript('null\nnull');
    } catch (e) {
      expect(e).not.toBeInstanceOf(TypeError);
      expect((e as TranscriptFormatError).sampledTypes).toContain('null');
    }
  });
});

describe('parseCodexRollout', () => {
  it('reads the current item.content[].text shape, not the retired payload.type one', () => {
    const turns = parseCodexRollout(codexJsonl);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.text).toContain('index my repo');
    expect(turns[1]?.role).toBe('assistant');
    expect(turns[1]?.text).toContain('walking the tree');
  });

  it('throws on the retired format instead of silently returning nothing', () => {
    const retired = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
    ].join('\n');
    expect(() => parseCodexRollout(retired)).toThrow(TranscriptFormatError);
  });

  it('returns [] for an empty file', () => {
    expect(parseCodexRollout('')).toEqual([]);
  });

  it('tolerates a line whose value is the JSON literal null, extracting the valid turns around it', () => {
    const withNullLine = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: 'hi' }] },
        },
      }),
      'null',
    ].join('\n');
    const turns = parseCodexRollout(withNullLine);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain('hi');
  });

  it('throws TranscriptFormatError (not a raw TypeError) when every line is the JSON literal null', () => {
    expect(() => parseCodexRollout('null\nnull')).toThrow(TranscriptFormatError);
    try {
      parseCodexRollout('null\nnull');
    } catch (e) {
      expect(e).not.toBeInstanceOf(TypeError);
      expect((e as TranscriptFormatError).sampledTypes).toContain('null');
    }
  });
});

describe('format-break detection (spec §11: 绝不静默)', () => {
  it.each([
    ['plain text log', 'session started\nuser: hi\nassistant: hello\n'],
    ['a non-JSONL blob', '<html><body>nope</body></html>'],
    ['binary-ish bytes', '\u001f\u008b\u0008\u0000gzip-looking'],
  ])('claude parser THROWS on %s instead of returning []', (_label, text) => {
    // The host switching away from line-delimited JSON makes every line fail
    // JSON.parse, so `rows` is empty and BOTH parsers returned [] before their
    // TranscriptFormatError could fire (it only triggered on "valid JSON
    // lines, none of a known shape"). doctor then reported `warn` — "maybe
    // these sessions just haven't said anything, chat a bit and re-run" —
    // steering the user away from the real cause, and runBackfill counted the
    // file as processed and uploaded an empty body.
    expect(() => parseClaudeTranscript(text)).toThrow(TranscriptFormatError);
    expect(() => parseCodexRollout(text)).toThrow(TranscriptFormatError);
  });

  it('names the offending lines in the error, so a bug report is actionable', () => {
    try {
      parseClaudeTranscript('session started\nuser: hi\n');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptFormatError);
      expect((err as TranscriptFormatError).message).toContain('session started');
    }
  });

  it('an EMPTY file is still silence, not a format break', () => {
    for (const text of ['', '   ', '\n\n']) {
      expect(parseClaudeTranscript(text)).toEqual([]);
      expect(parseCodexRollout(text)).toEqual([]);
    }
  });

  it('still tolerates a truncated final line in a live session', () => {
    // The reason readLines swallows parse errors in the first place: a session
    // being written right now can end mid-line. As long as SOMETHING parsed,
    // this is normal.
    const good = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parseClaudeTranscript(`${good}\n{"type":"assist`)).toHaveLength(1);
  });
});
