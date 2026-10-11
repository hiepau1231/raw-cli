import { writeFileTool, type ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { PATH_ALIASES, renameArgument } from "../../normalize.js";
import { resolve } from "node:path";

export const example = { path: "notes/todo.md", content: "# Todo\n" };
export const renamedArguments = { operations: "path" };

const OLD = 'write_file writes one whole file: {"path":"notes/todo.md","content":"# Todo\\n"}; use edit_file to change part of a file and apply_patch for patches';

/** Aliases used by other harnesses (docs/tool-ux-design.md §4.2); the old operation and patch shapes are rejected. */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  if (Object.hasOwn(input, "operations") || Object.hasOwn(input, "patch")) return { args: input, rejected: OLD };
  const args = { ...input };
  const notes: string[] = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const alias of ["file_text", "text", "contents"]) renameArgument(args, notes, alias, "content");
  return { args, notes };
}

export function describeEffects(args: Record<string, unknown>, context: { cwd: string }): Record<string, unknown> {
  return { files: [{ path: resolve(context.cwd, String(args.path)), operation: "write" }] };
}

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.hasOwn(args, "operations") || Object.hasOwn(args, "patch")) return OLD;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  if (typeof args.content !== "string") return "content must be a string";
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return writeFileTool(args as { path: string; content: string }, context);
}
