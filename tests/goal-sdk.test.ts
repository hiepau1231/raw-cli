import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { goalFixture, goalModel, goalRegistry, goalUsage } from "./fixtures/goals.js";
import type { GoalDefinition, GoalSnapshot, GoalCommand, GoalReceipt } from "../src/index.js";
import { GoalService } from "../src/index.js";
const definition: GoalDefinition = { objective: "Ship", maxRequests: 3 };
test("AC-4 SDK exports contracts and rejects missing persistence/selection before inference", async () => {
  let requests = 0;
  const provider = { modelConfig: goalModel, async generate() { requests++; return { text: "", toolCalls: [], finishReason: "stop" }; } };
  const agent = createAgent({ provider, registry: goalRegistry() });
  try { await assert.rejects(agent.runGoal(definition), /persistence/); assert.equal(requests, 0); } finally { await agent.close(); }
  assert.equal(typeof GoalService, "function");
  const command: GoalCommand = { action: "pause" }; assert.equal(command.action, "pause");
  const snapshot: GoalSnapshot | undefined = undefined; const receipt: GoalReceipt | undefined = undefined;
  assert.equal(snapshot, receipt);
});
test("AC-4 SDK live steering is durable/idempotent without requiring a config file and never resumes a paused goal", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = goalFixture(async (_request, n) => { if (n === 1) await gate; return { text: "Working", toolCalls: [], finishReason: "stop", usage: goalUsage }; });
  try {
    const running = f.agent.runGoal(definition);
    while (!f.requests()) await new Promise(resolve => setTimeout(resolve, 1));
    const first = f.agent.queueUserInput("Steer the next request", "steer");
    assert.deepEqual(f.agent.queueUserInput("Steer the next request", "steer"), first);
    assert.throws(() => f.agent.queueUserInput("Different", "steer"), /conflict/);
    release(); const result = await running;
    assert.equal(result.goal?.snapshot?.usage.requests, 3);
    assert.equal(f.store.findQueuedInput(f.session.id, "steer")?.state, "delivered");
    assert.equal(f.agent.transcript.filter(m => m.role === "user").length, 2);
    f.agent.queueUserInput("Do not resume", "paused-steer");
    assert.equal(f.agent.getGoal()?.status, "paused"); assert.equal(f.requests(), 3);
    const service = new GoalService({ store: f.store, sessionId: f.session.id });
    assert.throws(() => service.setBudget({ maxRequests: 5 }, "foreign", service.state().revision), /busy/);
  } finally { release(); await f.cleanup(); }
});

test("AC-4 SDK steering persistence failure aborts in-flight work before any next request", async () => {
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const f = goalFixture(() => { ready(); return new Promise(() => {}); });
  try {
    const running = f.agent.runGoal({ objective: "Storage safety" }); await started;
    f.store.database.exec("CREATE TRIGGER fail_native_queue BEFORE INSERT ON session_queued_inputs BEGIN SELECT RAISE(ABORT,'queue storage failed'); END");
    assert.throws(() => f.agent.queueUserInput("Stop safely"), /queue storage failed/);
    const result = await running; assert.equal(result.code, "persistence_error"); assert.equal(f.requests(), 1);
    await assert.rejects(f.agent.resumeGoal(), /persistence failed/);
  } finally { await f.cleanup(); }
});

test("AC-4 SDK pause settles a standalone native-tool run too", async () => {
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const f = goalFixture(() => { ready(); return new Promise(() => {}); });
  try {
    const row = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    new GoalService({ store: f.store, sessionId: f.session.id, owner: { token: String(row.owner_token), generation: Number(row.owner_generation) } }).start({ objective: "Host-started goal" }, "host-start", 0);
    const running = f.agent.run("Work on this goal"); await started;
    await f.agent.pauseGoal(); assert.equal(f.agent.state, "idle");
    assert.equal((await running).status, "cancelled"); assert.equal(f.agent.getGoal()?.status, "paused"); assert.equal(f.requests(), 1);
  } finally { f.agent.abort(); await f.cleanup(); }
});
