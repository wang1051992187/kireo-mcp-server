import { memoryDeleteTool } from './memory-delete.js';
import { memoryGetTool } from './memory-get.js';
import { memoryHealthTool } from './memory-health.js';
import { memoryListNamespacesTool } from './memory-list-namespaces.js';
import { memoryRecallTool } from './memory-recall.js';
import { memorySaveTool } from './memory-save.js';
import { memorySearchTool } from './memory-search.js';
import { memoryUpdateTool } from './memory-update.js';
import type { ToolDef } from './shared.js';

export const ALL_TOOLS: ToolDef<unknown>[] = [
  memorySaveTool as ToolDef<unknown>,
  memorySearchTool as ToolDef<unknown>,
  memoryRecallTool as ToolDef<unknown>,
  memoryGetTool as ToolDef<unknown>,
  memoryUpdateTool as ToolDef<unknown>,
  memoryDeleteTool as ToolDef<unknown>,
  memoryListNamespacesTool as ToolDef<unknown>,
  memoryHealthTool as ToolDef<unknown>,
];

export function findTool(name: string): ToolDef<unknown> | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export {
  memorySaveTool,
  memorySearchTool,
  memoryRecallTool,
  memoryGetTool,
  memoryUpdateTool,
  memoryDeleteTool,
  memoryListNamespacesTool,
  memoryHealthTool,
};
