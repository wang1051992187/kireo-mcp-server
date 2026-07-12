/**
 * msw/node + undici 互通 setup
 *
 * undici 的 `fetch` 是独立实现，不等于 globalThis.fetch，
 * 因此 msw 默认无法拦截通过 `import { fetch } from 'undici'` 发出的请求。
 *
 * 解决方案：通过 vi.mock 将 undici 模块的 fetch 重定向到 globalThis.fetch，
 * 这样 msw 的 FetchInterceptor（patch globalThis.fetch）就可以拦截所有请求。
 *
 * 注意：vi.mock 调用在 vitest 中会被 hoisted 到文件顶部，
 * 所以即使写在 import 之后也会先执行。
 */
import { vi } from 'vitest';

vi.mock('undici', async (importOriginal) => {
  const mod = await importOriginal<typeof import('undici')>();
  return {
    ...mod,
    // 将 undici 的 fetch 替换为 globalThis.fetch（msw 会 patch 这个）
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  };
});
