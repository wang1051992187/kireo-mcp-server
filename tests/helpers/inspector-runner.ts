import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

export interface InspectorRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// 版本钉死，不用 latest。2026-08-04 踩到：原来写的是 `npx -y
// @modelcontextprotocol/inspector`（无版本号 = latest），inspector 在 07-28
// 发了 2.0.0，测试第二天就红了，而本仓库 src/bin 自 0.2.1 起一行没改——
// 上游的 breaking change 变成了我们的"发版被阻断"。测试依赖用 latest 等于
// 把 CI 的绿灯交给别人的发布节奏。升级时改这里，让它是一次有意的动作。
const INSPECTOR = '@modelcontextprotocol/inspector@2.0.0';

export async function runInspector(
  args: string[],
  env: Record<string, string> = {},
): Promise<InspectorRun> {
  const binPath = join(process.cwd(), 'bin/kireo-mcp.cjs');
  // 2.0.0 起 inspector 不再把自己进程的环境变量继承给它 spawn 出来的 stdio
  // server，必须用 `-e KEY=VALUE` 显式传，且要放在目标命令**之后**。只设
  // spawn 的 env 已经不够——server 会因为拿不到 KIREO_API_KEY 而以
  // CONFIG_INVALID 退出，表现为 exitCode=1。
  // 仍然同时保留 env 继承：对 1.x 兼容，且不影响 2.x。
  const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const child = spawn(
    'npx',
    ['-y', INSPECTOR, '--cli', 'node', binPath, ...args, ...envFlags],
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
