import { z } from 'zod';
import { resolveProjectHere } from '../context/project.js';
import { type ToolContext, defineTool, toJsonResult } from './shared.js';

const Input = z
  .object({
    cwd: z
      .string()
      .optional()
      .describe('Absolute path of the project directory. Defaults to the server process cwd.'),
  })
  .strict();

type InputT = z.infer<typeof Input>;

export const projectInfoTool = defineTool<InputT>({
  name: 'project_info',
  description: [
    'Resolve the stable identity of the current project and the namespaces its memories live in.',
    '',
    'When to use: before every context_save and context_load, and any time the',
    'user asks which project or bucket their memories are going to.',
    '',
    'ALWAYS call this before context_save or context_load, and ALWAYS show the',
    'user the returned `key` and `source` — a misidentified project is the one',
    'failure the user can catch instantly, and cannot catch at all if hidden.',
    '',
    'If `warn` is non-null the identity is NOT stable across machines; relay it verbatim.',
    '',
    'Returns: { key, source, display_name, warn, ctx_namespace, code_namespace, home_namespace }',
  ].join('\n'),
  schema: Input,
  handler: async (input, ctx: ToolContext) => {
    const p = resolveProjectHere(input.cwd ?? process.cwd());
    ctx.logger.info({ project_key: p.key, source: p.source }, 'tool.project_info.ok');
    const summary = p.warn
      ? `项目 = ${p.displayName}（来源: ${p.source}）\n⚠️ ${p.warn}`
      : `项目 = ${p.displayName}（来源: ${p.source}）`;
    return toJsonResult(
      {
        key: p.key,
        source: p.source,
        display_name: p.displayName,
        warn: p.warn,
        ctx_namespace: p.ctxNs,
        code_namespace: p.codeNs,
        home_namespace: p.homeNs,
      },
      summary,
    );
  },
});
