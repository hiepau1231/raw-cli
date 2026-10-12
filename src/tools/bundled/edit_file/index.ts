import { editFileTool, type EditFileArgs, type ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { PATH_ALIASES, renameArgument } from "../../normalize.js";
import { resolveToolPath } from "../../../platform/paths.js";

export const example = { path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" };

/** Aliases used by other harnesses (docs/tool-ux-design.md §4.2). */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  const args = { ...input };
  const notes: string[] = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const alias of ["old_str", "oldString", "old_text"]) renameArgument(args, notes, alias, "old_string");
  for (const alias of ["new_str", "newString", "new_text"]) renameArgument(args, notes, alias, "new_string");
  renameArgument(args, notes, "replaceAll", "replace_all");
  if (args.allow_multiple === true && args.replace_all === undefined) {
    args.replace_all = true;
    delete args.allow_multiple;
    notes.push("read allow_multiple as replace_all");
  } else if (args.allow_multiple === false) {
    delete args.allow_multiple;
    notes.push("read allow_multiple as replace_all");
  }
  return { args, notes };
}

export function describeEffects(args: Record<string, unknown>, context: { cwd: string }): Record<string, unknown> {
  return { files: [{ path: resolveToolPath(context.cwd, String(args.path)), operation: "edit" }] };
}

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  if (typeof args.old_string !== "string" || !args.old_string) return "old_string must be the nonempty text to replace; create files with write_file";
  if (typeof args.new_string !== "string") return "new_string must be a string (empty deletes the match)";
  if (args.old_string === args.new_string) return "new_string must differ from old_string";
  if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") return "replace_all must be true or false";
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return editFileTool(args as unknown as EditFileArgs, context);
}
