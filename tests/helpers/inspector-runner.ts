import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

export interface InspectorRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runInspector(
  args: string[],
  env: Record<string, string> = {},
): Promise<InspectorRun> {
  const binPath = join(process.cwd(), 'bin/kireo-mcp.cjs');
  const child = spawn(
    'npx',
    ['-y', '@modelcontextprotocol/inspector', '--cli', 'node', binPath, ...args],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const [code] = await once(child, 'exit');
  return { exitCode: Number(code), stdout, stderr };
}
