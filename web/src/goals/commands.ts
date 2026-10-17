import type { GoalCommand } from "../../../src/goals/contract.js";
/** Browser-only parser; no Node runtime or host-control context is exposed to plugins. */
export function nativeGoalCommand(text: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/.exec(text);
  const action = match?.[1] ?? "status", value = match?.[2]?.trim();
  if (!match) throw new Error("Use /goal status|start|pause|resume|edit|budget|complete|clear|abandon");
  if (action === "status" && !value) return undefined;
  if ((action === "start" || action === "edit") && value) return { action, definition: { objective: value } };
  if (["pause", "resume", "complete", "clear", "abandon"].includes(action) && !value) return { action } as GoalCommand;
  if (action === "budget") {
    if (value === "none") return { action: "setBudget", tokenBudget: null };
    const parts = /^(?:(requests)\s+)?([0-9]+)$/.exec(value ?? ""), n = Number(parts?.[2]);
    if (parts && Number.isSafeInteger(n) && n > 0) return parts[1] ? { action: "setBudget", maxRequests: n } : { action: "setBudget", tokenBudget: n };
  }
  throw new Error("Use /goal status|start TEXT|pause|resume|edit TEXT|budget N|budget requests N|budget none|complete|clear|abandon");
}
