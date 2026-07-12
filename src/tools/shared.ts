import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { RestClient } from '../rest/client.js';

export interface ToolContext {
  rest: RestClient;
  logger: Logger;
}

export interface ToolDef<Input> {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
  zod: ZodTypeAny;
  handler: (input: Input, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<Input>(opts: {
  name: string;
  description: string;
  schema: ZodTypeAny;
  handler: (input: Input, ctx: ToolContext) => Promise<CallToolResult>;
}): ToolDef<Input> {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: zodToJsonSchema(opts.schema, { target: 'jsonSchema7', $refStrategy: 'none' }),
    zod: opts.schema,
    handler: opts.handler,
  };
}

export function toJsonResult(value: unknown, summary?: string): CallToolResult {
  const text = summary
    ? `${summary}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
    : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function toTextResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}
