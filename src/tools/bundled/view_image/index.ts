import { viewImageTool } from "../../image.js";
import type { ToolContext } from "../../primitives.js";
import type { ToolResult } from "../../types.js";
import type { NormalizedArguments } from "../../registry.js";
import { PATH_ALIASES, renameArgument } from "../../normalize.js";

/** Claude Code sends `file_path`; the other path aliases follow read_file (docs/tool-ux-design.md §4.2). */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  const args = { ...input };
  const notes: string[] = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  return { args, notes };
}

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (!Object.hasOwn(args, "path")) return "missing path";
  for (const key of Object.keys(args)) if (key !== "path") return `unknown property ${key}`;
  if (typeof args.path !== "string") return "path must be a string";
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return viewImageTool(args as { path: string }, context);
}
