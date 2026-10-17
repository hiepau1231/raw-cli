import { randomUUID } from "node:crypto";
export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "abandoned";
export type GoalItemStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
export type GoalActor = "user" | "model";
export interface GoalCriterionInput {
  id?: string;
  label: string;
  required?: boolean;
}
export interface GoalStepInput {
  id?: string;
  label: string;
  detail?: string;
}
export interface GoalDefinition {
  objective: string;
  doneWhen?: string;
  criteria?: readonly GoalCriterionInput[];
  steps?: readonly GoalStepInput[];
  tokenBudget?: number;
  maxRequests?: number;
}
export interface GoalCriterion extends GoalCriterionInput {
  id: string;
  required: boolean;
  status: GoalItemStatus;
  evidence?: string;
}
export interface GoalStep extends GoalStepInput {
  id: string;
  status: GoalItemStatus;
}
export interface GoalResolvedDefinition {
  objective: string;
  doneWhen: string;
  criteria: GoalCriterion[];
  steps: GoalStep[];
  tokenBudget?: number;
  maxRequests: number;
}
export interface GoalUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  inputCoverage: number;
  outputCoverage: number;
  currentRequest?: {
    id: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}
export interface GoalSnapshot {
  id: string;
  revision: number;
  status: GoalStatus;
  reason?: string;
  nextAction?: string;
  definition: GoalResolvedDefinition;
  usage: GoalUsage;
  elapsedMs: number;
  elapsedApproximate: boolean;
  noProgress: number;
  createdAt: number;
  updatedAt: number;
}
export interface GoalState {
  revision: number;
  goal: GoalSnapshot | null;
}
export interface GoalProgressUpdate {
  criteria?: readonly {
    id: string;
    status?: GoalItemStatus;
    evidence?: string;
  }[];
  steps?: readonly {
    id: string;
    status?: GoalItemStatus;
    detail?: string;
  }[];
}
export type GoalCommand = {
  action: "start";
  definition: GoalDefinition;
} | {
  action: "pause";
  reason?: string;
} | {
  action: "resume";
} | {
  action: "edit";
  definition: GoalDefinition;
} | {
  action: "setBudget";
  tokenBudget?: number | null;
  maxRequests?: number;
} | ({
  action: "update";
} & GoalProgressUpdate) | {
  action: "block";
  reason: string;
  nextAction: string;
} | {
  action: "complete" | "clear" | "abandon";
};
export interface GoalRequest {
  clientRequestId: string;
  expectedRevision: number;
  command: GoalCommand;
}
export interface GoalReceipt extends GoalState {
  clientRequestId: string;
  goalId: string;
  action: GoalCommand["action"];
  operationId?: string;
}
/** Prepared in a model call scope; only SessionStore may commit it with the linked tool result. */
export interface GoalWrites {
  expectedRevision: number;
  goal: GoalSnapshot;
}
export interface GoalContext {
  get(): GoalSnapshot | undefined;
  command(command: GoalCommand): GoalSnapshot;
}
export class GoalError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "GoalError"; }
}
const fail = (code: string, message: string): never => { throw new GoalError(code, message); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function keys(v: unknown, allowed: readonly string[], at: string): void {
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k)))
    fail("invalid_goal", `${at}: unsupported fields`);
}
function text(v: unknown, at: string, max?: number): string {
  if (typeof v !== "string" || !v.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))
    fail("invalid_goal", `${at} must be nonempty text without control characters`);
  const value = (v as string).trim();
  if (max !== undefined && [...value].length > max)
    fail("goal_limit", `${at}: at most ${max} characters`);
  return value;
}
function positive(v: unknown, at: string): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
  fail("invalid_goal", `${at} must be a positive safe integer`); return v as number; }
export function validateGoalSize(goal: GoalSnapshot): void {
  if (Buffer.byteLength(JSON.stringify(goal), "utf8") > 65536)
    fail("goal_limit", "canonical state: at most 64 KiB UTF-8");
}
export function resolveGoalDefinition(input: GoalDefinition, defaultMaxRequests = 10000): GoalResolvedDefinition {
  keys(input, ["objective", "doneWhen", "criteria", "steps", "tokenBudget", "maxRequests"], "definition");
  const objective = text(input.objective, "objective");
  const doneWhen = input.doneWhen === undefined ? objective : text(input.doneWhen, "doneWhen");
  const rawCriteria = input.criteria ?? [{ label: "Đạt mục tiêu và kiểm chứng điều kiện hoàn thành" }];
  const rawSteps = input.steps ?? [];
  if (!Array.isArray(rawCriteria) || !Array.isArray(rawSteps))
    fail("invalid_goal", "criteria and steps must be arrays");
  if (rawCriteria.length > 50)
    fail("goal_limit", "criteria: at most 50");
  if (rawSteps.length > 30)
    fail("goal_limit", "steps: at most 30");
  const ids = new Set<string>();
  for (const item of [...rawCriteria, ...rawSteps]) {
    if (!object(item))
      fail("invalid_goal", "item must be an object");
    if (item.id !== undefined) {
      const id = text(item.id, "id", 200);
      if (ids.has(id))
        fail("invalid_goal", "duplicate item id");
      ids.add(id);
    }
  }
  const id = (provided: unknown, prefix: string, i: number) => { if (provided !== undefined)
    return text(provided, "id", 200); let next = `${prefix}-${i + 1}`; while (ids.has(next))
    next += "-"; ids.add(next); return next; };
  const criteria = rawCriteria.map((item, i): GoalCriterion => { keys(item, ["id", "label", "required"], "criterion"); if (item.required !== undefined && typeof item.required !== "boolean")
    fail("invalid_goal", "required must be boolean"); return { id: id(item.id, "criterion", i), label: text(item.label, "criterion label", 200), required: item.required !== false, status: "pending" }; });
  if (!criteria.some(c => c.required))
    fail("invalid_goal", "at least one required criterion is required");
  const steps = rawSteps.map((item, i): GoalStep => { keys(item, ["id", "label", "detail"], "step"); return { id: id(item.id, "step", i), label: text(item.label, "step label", 200), status: "pending", ...(item.detail === undefined ? {} : { detail: text(item.detail, "step detail", 200) }) }; });
  return { objective, doneWhen, criteria, steps, maxRequests: positive(input.maxRequests ?? defaultMaxRequests, "maxRequests"), ...(input.tokenBudget === undefined ? {} : { tokenBudget: positive(input.tokenBudget, "tokenBudget") }) };
}
export function goalBudgetReason(goal: GoalSnapshot): string | undefined {
  const u = goal.usage, d = goal.definition;
  if (u.requests >= d.maxRequests)
    return "request_budget_exhausted";
  if (d.tokenBudget !== undefined) {
    if (u.inputCoverage < u.requests || u.outputCoverage < u.requests)
      return "usage_unknown";
    if (u.inputTokens + u.outputTokens >= d.tokenBudget)
      return "token_budget_exhausted";
  }
  return undefined;
}
export function transitionGoal(state: GoalState, command: GoalCommand, actor: GoalActor, now = Date.now(), defaultMaxRequests = 10000): GoalState {
  if (!object(command as unknown) || typeof command.action !== "string")
    fail("invalid_goal", "command must have an action");
  if (actor === "model" && !["update", "complete", "block"].includes(command.action))
    fail("forbidden", "model cannot control goal autonomy or definition");
  const fields: Record<string, readonly string[]> = { start: ["definition"], pause: ["reason"], resume: [], edit: ["definition"], setBudget: ["tokenBudget", "maxRequests"], update: ["criteria", "steps"], block: ["reason", "nextAction"], complete: [], clear: [], abandon: [] };
  if (!Object.hasOwn(fields, command.action))
    fail("invalid_goal", "unknown action");
  keys(command, ["action", ...fields[command.action]!], "command");
  const revision = state.revision + 1;
  if (command.action === "start") {
    if (state.goal)
      fail("goal_exists", "clear the current goal before starting another");
    const goal: GoalSnapshot = { id: randomUUID(), revision, status: "active", definition: resolveGoalDefinition(command.definition, defaultMaxRequests), usage: { requests: 0, inputTokens: 0, outputTokens: 0, inputCoverage: 0, outputCoverage: 0 }, elapsedMs: 0, elapsedApproximate: false, noProgress: 0, createdAt: now, updatedAt: now };
    validateGoalSize(goal);
    return { revision, goal };
  }
  if (!state.goal)
    fail("no_active_goal", "there is no current native goal");
  const goal = structuredClone(state.goal!);
  if (command.action === "clear")
    return { revision, goal: null };
  if (goal.status === "complete" || goal.status === "abandoned")
    fail("goal_terminal", "clear a terminal goal before starting another");
  switch (command.action) {
    case "pause":
      goal.status = "paused";
      goal.reason = command.reason === undefined ? "user_paused" : text(command.reason, "reason", 300);
      break;
    case "resume": {
      if (goal.status === "active")
        fail("goal_active", "goal is already active");
      const reason = goalBudgetReason(goal);
      if (reason)
        fail(reason, "raise the exhausted budget or explicitly clear the token cap when usage is unknown");
      goal.status = "active";
      delete goal.reason;
      delete goal.nextAction;
      goal.noProgress = 0;
      break;
    }
    case "edit":
      if (goal.status !== "paused")
        fail("goal_active", "pause and settle the goal before editing");
      goal.definition = resolveGoalDefinition({ ...command.definition, ...(command.definition.tokenBudget === undefined && goal.definition.tokenBudget !== undefined ? { tokenBudget: goal.definition.tokenBudget } : {}) }, goal.definition.maxRequests);
      goal.noProgress = 0;
      break;
    case "setBudget":
      if (command.tokenBudget === null)
        delete goal.definition.tokenBudget;
      else if (command.tokenBudget !== undefined)
        goal.definition.tokenBudget = positive(command.tokenBudget, "tokenBudget");
      if (command.maxRequests !== undefined)
        goal.definition.maxRequests = positive(command.maxRequests, "maxRequests");
      break;
    case "update": {
      if (goal.status !== "active")
        fail("goal_inactive", "only an active goal can receive progress");
      for (const kind of ["criteria", "steps"] as const) {
        const updates = command[kind];
        if (updates === undefined)
          continue;
        if (!Array.isArray(updates))
          fail("invalid_goal", `${kind} must be an array`);
        const seen = new Set<string>();
        for (const raw of updates) {
          const item = raw as Record<string, unknown>;
          keys(item, kind === "criteria" ? ["id", "status", "evidence"] : ["id", "status", "detail"], kind);
          const id = text(item.id, "id", 200);
          if (seen.has(id))
            fail("invalid_goal", "duplicate progress id");
          seen.add(id);
          const target = goal.definition[kind].find(c => c.id === id);
          if (!target)
            fail("invalid_goal", `unknown ${kind} id: ${id}`);
          if (item.status !== undefined) {
            if (!["pending", "in_progress", "done", "blocked", "skipped"].includes(item.status as string))
              fail("invalid_goal", "unknown item status");
            target!.status = item.status as GoalItemStatus;
          }
          if (kind === "criteria" && item.evidence !== undefined)
            (target as GoalCriterion).evidence = text(item.evidence, "evidence", 300);
          if (kind === "steps" && item.detail !== undefined)
            (target as GoalStep).detail = text(item.detail, "step detail", 200);
        }
      }
      break;
    }
    case "complete":
      if (!goal.definition.criteria.some(c => c.required) || goal.definition.criteria.some(c => c.required && (c.status !== "done" || !c.evidence?.trim())))
        fail("criteria_incomplete", "every required criterion must be done with evidence");
      goal.status = "complete";
      delete goal.reason;
      delete goal.nextAction;
      break;
    case "block":
      if (goal.status !== "active")
        fail("goal_inactive", "only an active goal can block");
      goal.status = "blocked";
      goal.reason = text(command.reason, "reason", 300);
      goal.nextAction = text(command.nextAction, "nextAction", 300);
      break;
    case "abandon":
      goal.status = "abandoned";
      goal.reason = "user_abandoned";
      break;
  }
  goal.revision = revision;
  goal.updatedAt = now;
  validateGoalSize(goal);
  return { revision, goal };
}
