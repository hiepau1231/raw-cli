import { describePatchEffects, parseFilePatch, validateFilePatchSyntax } from "../../file-patch.js";
import { applyPatchTool, type ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { renameArgument } from "../../normalize.js";

export const example = { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch" };

/** Codex sends the patch as `input`. */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  const args = { ...input };
  const notes: string[] = [];
  renameArgument(args, notes, "input", "patch");
  return { args, notes };
}

export function describeEffects(args: Record<string, unknown>, context: { cwd: string }): Record<string, unknown> {
  return describePatchEffects(parseFilePatch(String(args.patch), context.cwd));
}

export function validateArgs(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (typeof args.patch !== "string") return "patch must be a string";
  try { validateFilePatchSyntax(args.patch); } catch (error) { return error instanceof Error ? error.message : "invalid patch"; }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return applyPatchTool(args as { patch: string }, context);
}
