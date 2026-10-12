import type { ToolDefinition } from "../src/tools/registry.js";

export interface OverheadReport {
  promptTokens: number;
  combinedTokens: number;
  /** Each definition's own tokens, the three built-ins and powershell. */
  definitionTokens: Record<string, number>;
  definitions: readonly ToolDefinition[];
  canonical: string;
}

export function countOverhead(): OverheadReport;
