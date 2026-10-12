// The PowerShell tool: bash's arguments, aliases, validation and background delegation, run by PowerShell.
import { shellTool, type BashArgs, type ToolContext } from "../../primitives.js";
import type { ToolDelegation } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { delegateShell, shellNormalizer, shellValidator } from "../bash/index.js";

export { example, renamedArguments } from "../bash/index.js";

export const normalizeArguments = shellNormalizer("powershell");
export const validateArgs = shellValidator("powershell");

const run = shellTool("powershell");

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return run(args as unknown as BashArgs, context);
}

/** A background call starts a managed PowerShell job through the process tool, as bash does. */
export function delegate(args: Record<string, unknown>, context: { cwd: string }, platform: NodeJS.Platform = process.platform): ToolDelegation | undefined {
  return delegateShell("powershell", args, context, platform);
}
