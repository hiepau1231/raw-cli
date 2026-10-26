/**
 * One package hook for the goal kit.
 *
 * Stop: deny while the goal is active, under budget and under the continuation cap. The host
 * (raw.stop-continue/1) then adds the reason as a host message and makes one more request.
 * SessionStart: pause an interrupted goal so a restart never continues by itself.
 * UserPromptSubmit: pause an active goal so an ordinary user message is not consent to continue.
 *
 * Every path is fail-open for observations and never blocks a user prompt. A corrupt or locked
 * state file ends the run (or lets the prompt through) instead of trapping it.
 */

import { readState, updateState } from "./state.mjs";

const MAX_REASON_BYTES = 8 * 1024;
const DEFAULT_REASON = "Continue toward the goal.";

function output(value) {
  process.stdout.write(JSON.stringify(value));
}

function message(text) {
  if (Buffer.byteLength(text, "utf8") <= 512) output({ message: text });
}

function clipBytes(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "", used = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (used + size > limit - 3) break;
    result += scalar; used += size;
  }
  return `${result}…`;
}

function usageOf(request) {
  const usage = request.stop?.usage ?? {};
  const number = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    requests: number(usage.requests),
    inputTokensKnown: number(usage.inputTokensKnown),
    outputTokensKnown: number(usage.outputTokensKnown),
    inputCoverage: number(usage.inputCoverage),
    outputCoverage: number(usage.outputCoverage),
  };
}

function budgetReason(state, usage) {
  const budget = state.budget ?? {};
  const baseline = state.usageBaseline ?? { requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 };
  if (budget.maxRequests !== undefined && usage.requests - baseline.requests >= budget.maxRequests) {
    return "request_budget_exhausted";
  }
  if (budget.tokenBudget !== undefined) {
    if (usage.inputCoverage < usage.requests || usage.outputCoverage < usage.requests) return "usage_unknown";
    const spent = (usage.inputTokensKnown + usage.outputTokensKnown) -
      (baseline.inputTokensKnown + baseline.outputTokensKnown);
    if (spent >= budget.tokenBudget) return "token_budget_exhausted";
  }
  return undefined;
}

function reasonFor(state) {
  const criteria = state.criteria.map((item) => {
    const mark = item.status === "done" ? "x" : item.status === "skipped" ? "-" : " ";
    return `- [${mark}] ${item.id} ${item.label}${item.required ? " (required)" : ""}`;
  });
  const allDone = state.criteria.filter((item) => item.required)
    .every((item) => item.status === "done" && item.evidence?.trim());
  const text = [
    `Goal: ${state.objective}`,
    `Status: ${state.status}`,
    `Done when: ${state.doneWhen}`,
    "Criteria:",
    ...criteria,
    ...state.steps.length ? ["Steps:", ...state.steps.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.id} ${item.label}`)] : [],
    allDone
      ? "Every required criterion is done. Call goal complete now."
      : "Continue toward this goal. To ask the user for input, call goal pause with a reason first. Do not change the objective or budget.",
  ].join("\n");
  return clipBytes(text || DEFAULT_REASON, MAX_REASON_BYTES);
}

function sessionOf(request) {
  return typeof request.session_id === "string" && request.session_id.trim() ? request.session_id : undefined;
}

async function pause(cwd, session, reason, nextAction) {
  await updateState(cwd, (state) => {
    if (!state || state.status !== "active") return state;
    if (session && state.ownerSessionId && state.ownerSessionId !== session) return state;
    state.status = "paused";
    state.reason = reason;
    state.nextAction = nextAction;
    state.updatedAt = Date.now();
    return state;
  });
}

async function stop(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  let state;
  try { state = await readState(cwd); }
  catch { return; }
  if (!state || state.status !== "active") return;
  if (session && state.ownerSessionId && state.ownerSessionId !== session) {
    message("This goal belongs to another session in the same workspace.");
    return;
  }
  if (request.run?.status !== "completed") {
    await pause(cwd, session, `run_${request.run?.status ?? "stopped"}`, "Resume the goal explicitly.");
    message(`Goal paused: ${request.run?.status ?? "stopped"}.`);
    return;
  }
  const usage = usageOf(request);
  let result;
  try {
    result = await updateState(cwd, (current) => {
      if (!current || current.status !== "active") return current;
      if (session && current.ownerSessionId && current.ownerSessionId !== session) return current;
      if (session && !current.ownerSessionId) current.ownerSessionId = session;
      if (current.baselinePending) {
        current.usageBaseline = { ...usage };
        current.baselinePending = false;
      }
      if (!current.usageBaseline) current.usageBaseline = { requests: 0, inputTokensKnown: 0, outputTokensKnown: 0, inputCoverage: 0, outputCoverage: 0 };
      if (current.continuations >= current.budget.maxContinuations) {
        current.status = "paused";
        current.reason = "continuation_limit";
        current.nextAction = "Raise maxContinuations or clear the goal.";
        current.updatedAt = Date.now();
        return current;
      }
      const budget = budgetReason(current, usage);
      if (budget) {
        current.status = "paused";
        current.reason = budget;
        current.nextAction = "Raise the budget or clear the cap, then resume explicitly.";
        current.updatedAt = Date.now();
        return current;
      }
      current.continuations += 1;
      current.updatedAt = Date.now();
      return current;
    });
  } catch { return; }
  if (!result) return;
  if (session && result.ownerSessionId && result.ownerSessionId !== session) {
    message("This goal belongs to another session in the same workspace.");
    return;
  }
  if (result.status !== "active") {
    message(`Goal paused: ${result.reason ?? result.status}.`);
    return;
  }
  output({ decision: "deny", reason: reasonFor(result) });
}

async function sessionStart(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  try {
    const result = await updateState(cwd, (state) => {
      if (!state || state.status !== "active") return state;
      if (session && state.ownerSessionId && state.ownerSessionId !== session) return state;
      if (session && !state.ownerSessionId) state.ownerSessionId = session;
      state.status = "paused";
      state.reason = "interrupted";
      state.nextAction = "Resume the goal explicitly.";
      state.updatedAt = Date.now();
      return state;
    });
    if (result?.status === "paused" && result.reason === "interrupted") {
      message("Goal paused after restart; resume it explicitly.");
    }
  } catch { /* SessionStart is an observation. */ }
}

async function userPrompt(request) {
  const cwd = request.cwd;
  const session = sessionOf(request);
  let note;
  try {
    const result = await updateState(cwd, (state) => {
      if (!state || state.status !== "active") return state;
      if (session && state.ownerSessionId && state.ownerSessionId !== session) return state;
      if (session && !state.ownerSessionId) state.ownerSessionId = session;
      state.status = "paused";
      state.reason = "user_message";
      state.nextAction = "Run goal resume before continuing.";
      state.updatedAt = Date.now();
      return state;
    });
    if (result?.status === "paused" && result.reason === "user_message") {
      note = "Goal paused for the new user message; resume it explicitly.";
    }
  } catch { /* Never block a user prompt. */ }
  output({ decision: "continue", ...(note ? { message: note } : {}) });
}

async function main(input) {
  let request;
  try { request = JSON.parse(input); }
  catch {
    output({ decision: "continue" });
    return;
  }
  if (!request || typeof request !== "object" || typeof request.event !== "string" || typeof request.cwd !== "string") {
    output({ decision: "continue" });
    return;
  }
  try {
    if (request.event === "Stop") await stop(request);
    else if (request.event === "SessionStart") await sessionStart(request);
    else if (request.event === "UserPromptSubmit") await userPrompt(request);
  } catch {
    if (request.event === "UserPromptSubmit") output({ decision: "continue" });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => { void main(input); });
