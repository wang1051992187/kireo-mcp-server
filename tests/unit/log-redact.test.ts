import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

describe('redact paths', () => {
  it('authorization 头被遮盖', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const logger = pino(
      { redact: ['headers.authorization', 'apiKey'] },
      pino.multistream([{ stream: sink }]),
    );
    logger.info(
      { headers: { authorization: 'Bearer ki_sk_secret' }, apiKey: 'ki_sk_secret' },
      'hello',
    );
    await new Promise((r) => setTimeout(r, 10));
    const joined = chunks.join('');
    expect(joined).not.toContain('ki_sk_secret');
    expect(joined).toContain('[Redacted]');
  });
});
