import type { ProviderAdapter } from "../src/llm/types.js";
import assert from "node:assert/strict";
import test from "node:test";
import { goalFixture, goalUsage } from "./fixtures/goals.js";
import { isCompactionRequest } from "./fixtures/compaction.js";
import { GoalService } from "../src/goals/service.js";
test("AC-3 repeated usage callbacks replace one slot and token threshold blocks next dispatch", async () => {
  let effects = 0;
  const f = goalFixture(request => { request.onUsage?.({ prompt_tokens: 2, completion_tokens: 1 }); request.onUsage?.(goalUsage); return { text: "", toolCalls: [{ id: "effect", name: "effect", arguments: {} }], finishReason: "tool_calls", usage: goalUsage }; }, {}, [{ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() { effects++; return { isError: false, content: [] }; } }]);
  try {
    const result = await f.agent.runGoal({ objective: "Budget", tokenBudget: 7 });
    assert.equal(result.goal?.stopReason, "token_budget_exhausted");
    assert.equal(f.requests(), 1);
    assert.equal(effects, 0);
    assert.equal(f.agent.getGoal()!.usage.requests, 1);
    assert.equal(f.agent.getGoal()!.usage.inputTokens + f.agent.getGoal()!.usage.outputTokens, 7);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 missing usage pauses with coverage unknown rather than counting zero", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop" }));
  try {
    const result = await f.agent.runGoal({ objective: "Usage", tokenBudget: 100 });
    assert.equal(result.goal?.stopReason, "usage_unknown");
    assert.equal(f.requests(), 1);
    assert.equal(f.agent.getGoal()!.usage.inputCoverage, 0);
    await assert.rejects(() => f.agent.resumeGoal(), /usage_unknown/);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 request allowance accumulates across resume without synthetic user messages", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    await f.agent.runGoal({ objective: "Budget", maxRequests: 2 });
    assert.equal(f.requests(), 2);
    assert.equal(f.agent.getGoal()!.reason, "request_budget_exhausted");
    await assert.rejects(() => f.agent.resumeGoal(), /request_budget_exhausted/);
    const owner = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    const service = new GoalService({ store: f.store, sessionId: f.session.id, owner: { token: String(owner.owner_token), generation: Number(owner.owner_generation) } });
    service.setBudget({ maxRequests: 4 }, "raise", service.state().revision);
    await f.agent.resumeGoal();
    assert.equal(f.requests(), 4);
    assert.equal(f.agent.getGoal()!.usage.requests, 4);
    assert.equal(f.agent.transcript.filter(m => m.role === "user").length, 1);
  }
  finally {
    await f.cleanup();
  }
});
for (const cap of [1, 20])
  test(`AC-3 automatic compaction counts against cumulative request/token budget (cap ${cap})`, async () => {
    let compactions = 0, main = 0, seed = true;
    const f = goalFixture(request => {
      if (isCompactionRequest(request)) {
        compactions++;
        return { text: "checkpoint summary", toolCalls: [], finishReason: "stop", usage: goalUsage };
      }
      if (seed)
        return { text: "body ".repeat(1500), toolCalls: [], finishReason: "stop", usage: goalUsage };
      main++;
      return { text: "", toolCalls: [main === 1 ? { id: "update", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "proof" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage };
    }, { system: "small", compact: { triggerTokens: 1800, keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 64 } });
    try {
      await f.agent.run("seed");
      seed = false;
      const result = await f.agent.runGoal({ objective: "Retain canonical goal after compaction", criteria: [{ id: "c", label: "Proof" }], maxRequests: cap, tokenBudget: 10000 });
      assert.ok(compactions > 0);
      assert.equal(f.agent.getGoal()!.usage.requests, compactions + main);
      assert.equal(f.agent.getGoal()!.usage.inputTokens, (compactions + main) * 5);
      if (cap === 1) {
        assert.equal(result.goal?.stopReason, "request_budget_exhausted");
        assert.equal(main, 0);
      }
      else {
        assert.equal(result.goal?.snapshot?.status, "complete");
        assert.equal(main, 2);
      }
    }
    finally {
      await f.cleanup();
    }
  });
test("AC-3 native compaction usage and invocations count once including final usage", async () => {
  let seed = true, main = 0, native = 0;
  const f = goalFixture(request => { if (isCompactionRequest(request))
    throw new Error("native summary should not fall back"); if (seed)
    return { text: "body ".repeat(1500), toolCalls: [], finishReason: "stop", usage: goalUsage }; main++; return { text: "", toolCalls: [main === 1 ? { id: "update", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "proof" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage }; }, { system: "small", compact: { triggerTokens: 1800, keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 64, strategy: "native" } });
  (f.provider as ProviderAdapter).compact = async (request) => { native++; request.onUsage?.({ prompt_tokens: 2, completion_tokens: 1 }); return { summary: "native checkpoint", items: [{ type: "compaction", encrypted_content: "fixture" }], usage: goalUsage }; };
  try {
    await f.agent.run("seed");
    seed = false;
    const result = await f.agent.runGoal({ objective: "Native checkpoint", criteria: [{ id: "c", label: "Proof" }], maxRequests: 20, tokenBudget: 10000 });
    assert.ok(native > 0);
    assert.equal(result.goal?.snapshot?.status, "complete");
    assert.equal(f.agent.getGoal()!.usage.requests, native + main);
    assert.equal(f.agent.getGoal()!.usage.inputTokens, (native + main) * 5);
    assert.equal(f.agent.getGoal()!.usage.outputTokens, (native + main) * 2);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 reasoning replay attempts count as distinct goal requests with honest missing coverage", async () => {
  let seed = true, goalCalls = 0;
  const f = goalFixture(request => { if (isCompactionRequest(request))
    return { text: "summary", toolCalls: [], finishReason: "stop", usage: goalUsage }; if (seed)
    return { text: "body ".repeat(400), toolCalls: [], finishReason: "stop", usage: goalUsage }; goalCalls++; if (goalCalls === 1)
    throw Object.assign(new Error("invalid reasoning signature"), { status: 400 }); return { text: "", toolCalls: [goalCalls === 2 ? { id: "update", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "proof" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage }; }, { system: "small" });
  try {
    await f.agent.run("one");
    await f.agent.run("two");
    assert.equal((await f.agent.compact({ keepRecentTurns: 0, keepRecentTokens: 1, maxOutputTokens: 64 })).status, "compacted");
    seed = false;
    const result = await f.agent.runGoal({ objective: "Replay", criteria: [{ id: "c", label: "Proof" }] });
    assert.equal(result.goal?.snapshot?.status, "complete");
    assert.equal(goalCalls, 3);
    assert.equal(f.agent.getGoal()!.usage.requests, 3);
    assert.equal(f.agent.getGoal()!.usage.inputCoverage, 2);
    assert.equal(f.agent.getGoal()!.usage.inputTokens, 10);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 cancelled unreported usage needs explicit token-cap clearing before resume", async () => {
  let ready!: () => void;
  const waiting = new Promise<void>(r => { ready = r; });
  const f = goalFixture((_request, n) => { if (n === 1) {
    ready();
    return new Promise(() => { });
  } return { text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }; });
  try {
    const run = f.agent.runGoal({ objective: "Unknown cancelled usage", tokenBudget: 100 });
    await waiting;
    await f.agent.pauseGoal();
    const result = await run;
    assert.equal(result.goal?.stopReason, "usage_unknown");
    await assert.rejects(() => f.agent.resumeGoal(), /usage_unknown/);
    const owner = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    const service = new GoalService({ store: f.store, sessionId: f.session.id, owner: { token: String(owner.owner_token), generation: Number(owner.owner_generation) } });
    service.setBudget({ tokenBudget: null }, "clear-token-cap", service.state().revision);
    await f.agent.resumeGoal();
    assert.equal(f.requests(), 4);
    assert.equal(f.agent.getGoal()!.usage.requests, 4);
    assert.equal(f.agent.getGoal()!.usage.inputCoverage, 3);
  }
  finally {
    await f.cleanup();
  }
});
