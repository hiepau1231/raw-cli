import type { HookDispatcher } from "../src/hooks/dispatcher.js";
import assert from "node:assert/strict";
import test from "node:test";
import { goalFixture, goalUsage } from "./fixtures/goals.js";
import type { RunEvent } from "../src/agent.js";
test("AC-3 continues natural final replies inside one run and completes without extra inference", async () => {
  const seenSystems: string[] = [];
  const f = goalFixture((request, n) => { seenSystems.push(request.system); return n < 3 ? { text: `working ${n}`, toolCalls: [], finishReason: "stop", usage: goalUsage } : { text: "", toolCalls: n === 3 ? [{ id: "progress", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "node --test passed" }] } }] : [{ id: "complete", name: "goal", arguments: { action: "complete" } }, { id: "should-not-run", name: "effect", arguments: {} }], finishReason: "tool_calls", usage: goalUsage }; }, {}, [{ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() { throw new Error("must not dispatch after complete"); } }]);
  try {
    const events: RunEvent[] = [];
    const result = await f.agent.runGoal({ objective: "Finish fixture", criteria: [{ id: "c", label: "Test passes" }], tokenBudget: 1000 }, e => events.push(e));
    assert.equal(result.goal?.snapshot?.status, "complete");
    assert.equal(f.requests(), 4);
    assert.equal(events.filter(e => e.type === "run_end").length, 1);
    assert.equal(f.agent.transcript.filter(m => m.role === "user").length, 1);
    assert.ok(seenSystems.every(s => s.includes("Finish fixture")));
    assert.ok(events.some(e => e.type === "tool_result" && e.id === "should-not-run" && e.result.isError));
    const notices = f.store.getSessionHistory({ sessionId: f.session.id, limit: 100 }).items.filter(i => i.kind === "goal_notice");
    assert.equal(notices.length, 2);
    assert.ok(notices.every(n => n.payload.origin === "host"));
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 prose is not completion and an empty reply loop pauses after three finals", async () => {
  const f = goalFixture(() => ({ text: "Everything is done", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    const result = await f.agent.runGoal({ objective: "Do not accept prose as proof" });
    assert.equal(result.goal?.snapshot?.status, "paused");
    assert.equal(result.goal?.stopReason, "no_progress");
    assert.equal(f.requests(), 3);
    assert.equal(f.agent.getGoal()!.definition.criteria[0]!.status, "pending");
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 pause aborts pending inference and late response cannot restart work", async () => {
  let release!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const f = goalFixture(() => { started(); return new Promise(r => { release = r; }); });
  try {
    const running = f.agent.runGoal({ objective: "Wait safely" });
    await ready;
    await f.agent.pauseGoal();
    const result = await running;
    assert.equal(result.goal?.snapshot?.status, "paused");
    assert.equal(f.requests(), 1);
    release({ text: "late", toolCalls: [], finishReason: "stop", usage: goalUsage });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.requests(), 1);
    assert.ok(!f.agent.transcript.some(m => m.role === "assistant" && m.text === "late"));
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 ordinary runs keep one-response completion and unchanged system/user input", async () => {
  let system = "";
  const f = goalFixture(r => { system = r.system; return { text: "done", toolCalls: [], finishReason: "stop" }; }, { system: "original system" });
  try {
    const result = await f.agent.run("ordinary");
    assert.equal(result.status, "completed");
    assert.equal(result.goal, undefined);
    assert.equal(f.requests(), 1);
    assert.equal(system, "original system");
    assert.deepEqual(f.agent.transcript[0], { role: "user", content: "ordinary" });
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 pause while approval is pending never grants consent or dispatches tools", async () => {
  let ready!: () => void;
  const waiting = new Promise<void>(r => { ready = r; });
  let effects = 0;
  const f = goalFixture(() => ({ text: "", toolCalls: [{ id: "effect", name: "effect", arguments: {} }], finishReason: "tool_calls", usage: goalUsage }), { approve: async () => { ready(); return new Promise<boolean>(() => { }); } }, [{ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() { effects++; return { isError: false, content: [] }; } }], [{ match: "effect", effect: "ask" }]);
  try {
    const run = f.agent.runGoal({ objective: "Wait for consent" });
    await waiting;
    assert.equal(f.agent.getGoal()!.status, "active");
    await new Promise(r => setTimeout(r, 20));
    await f.agent.pauseGoal();
    const result = await run;
    assert.equal(result.status, "cancelled");
    assert.equal(f.agent.getGoal()!.status, "paused");
    assert.equal(effects, 0);
    assert.equal(f.requests(), 1);
    assert.ok(f.agent.getGoal()!.elapsedMs >= 20);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 model block commits its reason and cancels the remaining declared calls", async () => {
  let effects = 0;
  const f = goalFixture(() => ({ text: "", toolCalls: [{ id: "block", name: "goal", arguments: { action: "block", reason: "Need secret", nextAction: "Configure credential" } }, { id: "effect", name: "effect", arguments: {} }], finishReason: "tool_calls", usage: goalUsage }), {}, [{ name: "effect", description: "Effect", inputSchema: { type: "object" }, async handler() { effects++; return { isError: false, content: [] }; } }]);
  try {
    const result = await f.agent.runGoal({ objective: "Ship" });
    assert.equal(result.goal?.snapshot?.status, "blocked");
    assert.equal(result.goal?.snapshot?.nextAction, "Configure credential");
    assert.equal(f.requests(), 1);
    assert.equal(effects, 0);
    assert.ok(f.agent.transcript.some(m => m.role === "tool" && m.callId === "effect" && m.result.isError));
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 failed request checkpoint stops before inference without unhandled abort", async () => {
  const f = goalFixture(() => ({ text: "unexpected", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    f.store.database.exec("CREATE TRIGGER fail_goal_start BEFORE INSERT ON history WHEN NEW.kind='goal_update' AND json_extract(NEW.payload_json,'$.action')='request_start' BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END");
    const result = await f.agent.runGoal({ objective: "Fail safely" });
    assert.equal(result.status, "error");
    assert.equal(result.code, "persistence_error");
    assert.equal(f.requests(), 0);
    assert.equal(f.agent.getGoal()!.usage.requests, 0);
    await new Promise(r => setTimeout(r, 20));
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 continuation fires UserPromptSubmit and Stop exactly once", async () => {
  const counts: Record<string, number> = {};
  const hooks = { validateTools() { }, async run(name: string) { counts[name] = (counts[name] ?? 0) + 1; return {}; } } as unknown as HookDispatcher;
  const f = goalFixture((_request, n) => n < 3 ? { text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage } : { text: "", toolCalls: [n === 3 ? { id: "proof", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "verified" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage }, { hooks });
  try {
    assert.equal((await f.agent.runGoal({ objective: "One lifecycle", criteria: [{ id: "c", label: "Proof" }] })).goal?.snapshot?.status, "complete");
    assert.equal(f.requests(), 4);
    assert.equal(counts.UserPromptSubmit, 1);
    assert.equal(counts.Stop, 1);
  }
  finally {
    await f.cleanup();
  }
});

test("AC-3 elapsed heartbeat during a slow post-tool hook does not invalidate staged progress", { timeout: 15000 }, async () => {
  let waited = false;
  const hooks = { validateTools() {}, async run(event: string, request: { tool?: { identity: string } }) {
    if (event === "PostToolUse" && request.tool?.identity === "builtin/goal" && !waited) {
      waited = true; await new Promise(resolve => setTimeout(resolve, 5350));
    }
    return {};
  } } as unknown as HookDispatcher;
  const f = goalFixture((_request, n) => ({ text: "", toolCalls: [n === 1 ? { id: "proof", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "Verified" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage }), { hooks });
  try {
    const result = await f.agent.runGoal({ objective: "Slow hook", criteria: [{ id: "c", label: "Proof" }] });
    assert.equal(result.goal?.snapshot?.status, "complete"); assert.equal(f.requests(), 2);
    assert.equal(f.agent.getGoal()?.definition.criteria[0]?.evidence, "Verified");
    assert.ok(f.agent.getGoal()!.elapsedMs >= 5300);
    assert.ok(!f.agent.transcript.some(m => m.role === "tool" && m.result.code === "stale_revision"));
  } finally { await f.cleanup(); }
});
