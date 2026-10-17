import { randomUUID } from "node:crypto";
import type { AgentSession, RunResult } from "../agent.js";
import { GoalError, type GoalCommand, type GoalSnapshot } from "./contract.js";
export function nativeGoalExit(result: RunResult): number {
  if (result.status === "error") return 1;
  const goal = result.goal?.snapshot, reason = result.goal?.stopReason;
  if (goal?.status === "complete") return 0;
  if (goal?.status === "abandoned" || reason === "user_cancelled") return 130;
  if (goal?.status === "blocked") return 5;
  if (reason === "request_budget_exhausted" || result.status === "max_steps") return 3;
  return 4;
}
export function goalStatus(goal: GoalSnapshot | undefined): string {
  if (!goal) return "No current native goal.";
  const u = goal.usage;
  return `Goal ${goal.id} · revision ${goal.revision} · ${goal.status}${goal.reason ? ` (${goal.reason})` : ""}\n${goal.definition.objective}\nRequests ${u.requests}/${goal.definition.maxRequests}; tokens ${u.inputTokens + u.outputTokens}${goal.definition.tokenBudget === undefined ? "" : `/${goal.definition.tokenBudget}`}; usage coverage input ${u.inputCoverage}/${u.requests}, output ${u.outputCoverage}/${u.requests}${goal.elapsedApproximate ? "; elapsed approximate" : ""}`;
}
export async function goalCliCommand(agent: AgentSession, line: string, options: {
  write: (text: string) => void;
  run: (mode: "start" | "resume", objective?: string) => Promise<void>;
}): Promise<void> {
  const match = /^\/goal(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/.exec(line);
  if (!match) throw new GoalError("invalid_goal", "use /goal status|start|pause|resume|edit|budget|clear|abandon");
  const action = match[1] ?? "status", value = match[2]?.trim();
  if (action === "status") { options.write(goalStatus(agent.getGoal())); return; }
  if (action === "start" || action === "resume") {
    if (agent.state !== "idle") throw new GoalError("goal_active", "agent is busy; pause and settle before start/resume");
    if ((action === "start" && !value) || (action === "resume" && value)) throw new GoalError("invalid_goal", "use /goal start TEXT or /goal resume");
    await options.run(action, value); return;
  }
  let command: GoalCommand;
  if (action === "pause") { if (value) throw new GoalError("invalid_goal", "pause takes no value"); await agent.pauseGoal(); options.write(goalStatus(agent.getGoal())); return; }
  if (action === "edit") {
    if (!value) throw new GoalError("invalid_goal", "use /goal edit TEXT");
    command = { action: "edit", definition: { objective: value } };
  } else if (action === "budget") {
    if (value === "none") {
      options.write("Warning: removing the token cap allows continuation without reliable usage when coverage is unknown. Usage is retained.");
      command = { action: "setBudget", tokenBudget: null };
    } else {
      const parts = /^(?:(requests)\s+)?([0-9]+)$/.exec(value ?? "");
      const n = Number(parts?.[2]);
      if (!parts || !Number.isSafeInteger(n) || n < 1) throw new GoalError("invalid_goal", "use /goal budget N|requests N|none");
      command = parts[1] ? { action: "setBudget", maxRequests: n } : { action: "setBudget", tokenBudget: n };
    }
  } else if ((action === "clear" || action === "abandon") && !value) command = { action };
  else throw new GoalError("invalid_goal", "use /goal status|start|pause|resume|edit|budget|clear|abandon");
  if (agent.getGoal()?.status === "active" || agent.state !== "idle") await agent.pauseGoal();
  const goal = agent.getGoal();
  if (!goal) throw new GoalError("no_active_goal", "there is no current native goal");
  agent.commandGoal({ clientRequestId: randomUUID(), expectedRevision: goal.revision, command });
  options.write(goalStatus(agent.getGoal()));
}
