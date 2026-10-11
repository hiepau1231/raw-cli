import { readFileTool, type ReadFileArgs, type ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { integerArgument, PATH_ALIASES, renameArgument } from "../../normalize.js";

export const example = { path: "src/app.ts", offset: 120, limit: 80 };
export const renamedArguments = { files: "path" };

/** `-1` as the last line means the end of the file; the output budget still bounds the window. */
const TO_END = 2147483647;
const BATCH = 'read_file reads one file: {"path":"src/app.ts","offset":120,"limit":80}; call read_file once per file';

/** Aliases used by other harnesses (docs/tool-ux-design.md §4.2); the old batch shape is rejected with an example. */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  if (Object.hasOwn(input, "files")) return { args: input, rejected: BATCH };
  const args = { ...input };
  const notes: string[] = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const key of ["offset", "limit", "start_line", "end_line", "max_lines", "lines"]) if (Object.hasOwn(args, key)) args[key] = integerArgument(args[key]);
  if (Array.isArray(args.view_range) && args.offset === undefined && args.limit === undefined) {
    const [first, last] = (args.view_range as unknown[]).map(integerArgument);
    if (typeof first === "number") {
      args.offset = first;
      if (typeof last === "number") args.limit = last === -1 ? TO_END : last - first + 1;
      delete args.view_range;
      notes.push("read view_range as offset and limit");
    }
  }
  renameArgument(args, notes, "start_line", "offset");
  if (typeof args.end_line === "number" && args.limit === undefined) {
    args.limit = args.end_line === -1 ? TO_END : args.end_line - (typeof args.offset === "number" ? args.offset : 1) + 1;
    delete args.end_line;
    notes.push("read end_line as limit");
  }
  renameArgument(args, notes, "max_lines", "limit");
  renameArgument(args, notes, "lines", "limit");
  return { args, notes };
}

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.hasOwn(args, "files")) return BATCH;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  for (const key of ["offset", "limit"] as const) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1 || (args[key] as number) > 2147483647)) return `${key} must be a positive integer`;
  }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return readFileTool(args as unknown as ReadFileArgs, context);
}
