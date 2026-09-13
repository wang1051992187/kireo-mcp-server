/**
 * Extract the array from a `GET /v1/memories` response, loudly.
 *
 * The server answers `{ items, next_cursor }` (apps/api/src/memory/service.ts
 * #ListResult, returned verbatim by routes/memories.ts). Every relay reader
 * used to dereference `res.data`, which does not exist — `context_load` threw
 * a bare TypeError, `resume --all` printed "no projects yet" forever, and the
 * index anchor read as permanently absent.
 *
 * The tempting repair, `res.items ?? []`, would have swapped one silent
 * failure for another: an envelope change would then render every project as
 * "nothing saved yet", which is indistinguishable from the truth and is
 * exactly the "resume 恒定渲染出空" outcome the design spends §5.3 avoiding.
 * So a missing array is an ERROR that names what came back instead.
 */
export function listItems<T>(res: unknown, path: string): T[] {
  const items = (res as { items?: unknown } | null | undefined)?.items;
  if (Array.isArray(items)) return items as T[];
  const keys =
    res && typeof res === 'object' ? Object.keys(res as object).join(', ') || '无' : String(res);
  throw new Error(
    [
      `GET ${path} 的响应里没有 \`items\` 数组（实际字段：${keys}）。`,
      'kireo 的读取路径和 API 的返回契约对不上 —— 先升级 @kireo/mcp-server；',
      '若已是最新版，请跑 `kireo doctor` 并把输出贴进 issue。',
    ].join(''),
  );
}
