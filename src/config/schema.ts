import { z } from 'zod';

export const RuntimeConfigSchema = z.object({
  apiKey: z
    .string()
    .min(8, 'KIREO_API_KEY too short')
    .regex(/^ki_sk_[A-Za-z0-9_-]+$/, 'KIREO_API_KEY must look like ki_sk_xxx'),
  apiUrl: z.string().url().default('https://api.kireo.app'),
  requestTimeoutMs: z.number().int().positive().max(300_000).default(60_000),
  retryMaxAttempts: z.number().int().min(0).max(10).default(3),
  retryBaseMs: z.number().int().positive().max(5_000).default(200),
  telemetryEnabled: z.boolean().default(true),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  defaultNamespace: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .default('default'),
  acceptLanguage: z.string().default('en'),
  proxyUrl: z
    .string()
    .url()
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
      message: 'proxyUrl must use http or https scheme',
    })
    .optional(),
  extraCaCerts: z.string().optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type PartialConfig = Partial<RuntimeConfig>;
