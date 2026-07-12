import { z } from 'zod';

export const namespaceInput = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const entityInput = z.string().min(1).max(64);
export const tagInput = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/);

export const metadataInput = z
  .record(z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2 * 1024, {
    message: 'metadata exceeds 2048 bytes',
  });
