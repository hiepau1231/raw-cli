import { GoalError, type GoalModelCommand } from "../../../goals/contract.js";
import type { ToolContext } from "../../primitives.js";
import { errorResult } from "../../results.js";
import type { ToolResult } from "../../types.js";
export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  if (!context.goals)
    return errorResult("goals_unavailable", "native goals require session persistence and builtin/goal selection");
  try {
    let goal;
    if (args.action === "get") {
      if (Object.keys(args).some(k => k !== "action"))
        throw new GoalError("invalid_goal", "get accepts only action");
      goal = context.goals.get();
    }
    else
      goal = context.goals.command(args as unknown as GoalModelCommand);
    if (!goal)
      return errorResult("no_active_goal", "there is no current native goal; only the user can start one");
    return { isError: false, content: [{ type: "text", text: JSON.stringify(goal) }] };
  }
  catch (error) {
    if (error instanceof Error && error.name === "GoalError" && "code" in error && typeof error.code === "string")
      return errorResult(error.code, error.message);
    throw error;
  }
}
