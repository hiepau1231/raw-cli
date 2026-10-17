import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessions/store.js";
import { GoalService } from "../src/goals/service.js";
import { GoalCall } from "../src/goals/call.js";
import { handler } from "../src/tools/bundled/goal/index.js";
import { createAgent, type RunEvent } from "../src/agent.js";
import { ToolRegistry, type ToolRegistration } from "../src/tools/registry.js";
import { loadToolPlugins, loadBundledTools } from "../src/tools/plugins/loader.js";
function fixture() { const root = mkdtempSync(join(tmpdir(), "raw-goal-tool-")); const store = openSessionStore({ env: { XDG_STATE_HOME: root } }); const session = store.createSession({ cwd: root, title: "Tool" }); const owner = store.claimSession(session.id); const service = new GoalService({ store, sessionId: session.id, owner }); service.start({ objective: "Ship", criteria: [{ id: "c", label: "Tests pass" }] }, "start", 0); return { root, store, session, owner, service, call(signal?: AbortSignal) { return new GoalCall(() => store.getGoalState(session.id), signal); }, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } }; }
test("AC-2 native tool stages only model progress and rejects host powers", async () => {
  const f = fixture();
  try {
    const before = f.service.state();
    const call = f.call();
    const result = await handler({ action: "update", criteria: [{ id: "c", status: "done", evidence: "node --test passed" }] }, { cwd: f.root, maxOutputBytes: 65536, goals: call.context });
    assert.equal(result.isError, false);
    assert.deepEqual(f.service.state(), before);
    const writes = call.settle(true)!;
    assert.equal(writes.goal.definition.criteria[0]!.status, "done");
    assert.throws(() => call.context.command({ action: "complete" }), /goal_scope_closed/);
    f.store.appendAgentMessage(f.session.id, f.owner, { role: "tool", callId: "c1", name: "goal", result }, {}, [{ kind: "tool_result", payload: { id: "c1" } }], undefined, undefined, undefined, undefined, writes);
    assert.equal(f.service.get()!.definition.criteria[0]!.status, "done");
    for (const command of [{ action: "start", definition: { objective: "Other" } }, { action: "setBudget", tokenBudget: 999999 }, { action: "edit", definition: { objective: "Other" } }, { action: "update", criteria: [{ id: "c", required: false }] }]) {
      const scope = f.call();
      const rejected = await handler(command, { cwd: f.root, maxOutputBytes: 65536, goals: scope.context });
      assert.equal(rejected.isError, true);
      assert.equal(scope.settle(!rejected.isError), undefined);
    }
  }
  finally {
    f.cleanup();
  }
});
test("AC-2 cancellation, error and failed result transaction discard staged changes", async () => {
  const f = fixture();
  try {
    for (const mode of ["cancel", "error", "storage"]) {
      const before = f.service.state();
      const controller = new AbortController();
      const call = f.call(controller.signal);
      await handler({ action: "update", criteria: [{ id: "c", status: "done", evidence: "proof" }] }, { cwd: f.root, maxOutputBytes: 65536, goals: call.context });
      if (mode === "cancel")
        controller.abort();
      const writes = call.settle(mode !== "error");
      if (mode !== "storage")
        assert.equal(writes, undefined);
      else {
        f.store.database.exec("CREATE TRIGGER fail_goal_result BEFORE INSERT ON history WHEN NEW.kind='tool_result' BEGIN SELECT RAISE(ABORT,'result failed'); END");
        assert.throws(() => f.store.appendAgentMessage(f.session.id, f.owner, { role: "tool", callId: "c", name: "goal", result: { isError: false, content: [] } }, {}, [{ kind: "tool_result", payload: {} }], undefined, undefined, undefined, undefined, writes), /result failed/);
        f.store.database.exec("DROP TRIGGER fail_goal_result");
      }
      assert.deepEqual(f.service.state(), before);
    }
  }
  finally {
    f.cleanup();
  }
});
test("AC-2 no goal/persistence, completion guard and immutable get snapshot", async () => {
  const f = fixture();
  try {
    const unavailable = await handler({ action: "get" }, { cwd: f.root, maxOutputBytes: 65536 });
    assert.equal(unavailable.code, "goals_unavailable");
    const call = f.call();
    const read = call.context.get()!;
    read.definition.objective = "tampered";
    assert.notEqual(call.context.get()!.definition.objective, "tampered");
    const incomplete = await handler({ action: "complete" }, { cwd: f.root, maxOutputBytes: 65536, goals: call.context });
    assert.equal(incomplete.code, "criteria_incomplete");
    assert.throws(() => call.context.command({ action: "update", criteria: [{ id: "missing", status: "done" }] }), /invalid_goal/);
    call.settle(false);
    const empty = new GoalCall(() => ({ revision: 0, goal: null }));
    const result = await handler({ action: "get" }, { cwd: f.root, maxOutputBytes: 65536, goals: empty.context });
    assert.equal(result.code, "no_active_goal");
  }
  finally {
    f.cleanup();
  }
});
const modelConfig = { agentName: "test", provider: "local", method: "openai-chat-completions" as const, model: "fixture" };
function registration(): ToolRegistration { return { canonicalName: "builtin/goal", name: "goal", description: "Native goal", inputSchema: JSON.parse(readFileSync(new URL("../src/tools/bundled/goal/tool.json", import.meta.url), "utf8")).input_schema, handler }; }
test("AC-2 AgentSession commits canonical goal and linked result before emitting update", async () => {
  const f = fixture();
  let requests = 0;
  const registry = new ToolRegistry();
  registry.register(registration());
  const events: RunEvent[] = [];
  const agent = createAgent({ registry, cwd: f.root, provider: { modelConfig, async generate() { return ++requests === 1 ? { text: "progress", toolCalls: [{ id: "update", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "test output" }] } }], finishReason: "tool_calls" } : { text: "done", toolCalls: [], finishReason: "stop" }; } }, persistence: { store: f.store, sessionId: f.session.id, owner: f.owner, ownership: "host", surface: "cli" } });
  try {
    const result = await agent.run("Work", event => { if (event.type === "goal_update") {
      assert.deepEqual(f.service.get(), event.goal);
      const rows = f.store.database.prepare("SELECT payload_json FROM model_context").all();
      assert.ok(rows.some(row => JSON.parse(String(row.payload_json)).callId === "update"));
    } events.push(event); });
    assert.equal(result.status, "completed");
    assert.equal(events.filter(e => e.type === "goal_update").length, 1);
    assert.equal(f.service.get()!.definition.criteria[0]!.status, "done");
    assert.equal(f.store.listSessionPanels(f.session.id).length, 0);
  }
  finally {
    await agent.close();
    f.cleanup();
  }
});
test("AC-2 AgentSession cancellation rolls back native goal while recording linked cancellation", async () => {
  const f = fixture();
  const registry = new ToolRegistry();
  let agent: ReturnType<typeof createAgent>;
  const tool = registration();
  registry.register({ ...tool, async handler(args, context) { const result = await handler(args, context); agent.abort(); return result; } });
  agent = createAgent({ registry, cwd: f.root, provider: { modelConfig, async generate() { return { text: "", toolCalls: [{ id: "update", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "proof" }] } }], finishReason: "tool_calls" }; } }, persistence: { store: f.store, sessionId: f.session.id, owner: f.owner, ownership: "host", surface: "cli" } });
  try {
    const before = f.service.state();
    const events: RunEvent[] = [];
    assert.equal((await agent.run("Work", e => events.push(e))).status, "cancelled");
    assert.deepEqual(f.service.state(), before);
    assert.equal(events.filter(e => e.type === "goal_update").length, 0);
    assert.ok(events.some(e => e.type === "tool_result" && e.id === "update" && e.result.isError));
  }
  finally {
    await agent.close();
    f.cleanup();
  }
});
test("AC-2 installed native loader forwards only the model scope, arbitrary plugins receive none", async () => {
  const f = fixture();
  try {
    const native = (await loadBundledTools(["goal"]))[0]!;
    const registry = new ToolRegistry();
    registry.register(native);
    const scope = f.call();
    const result = await registry.dispatch("goal", { action: "get" }, { cwd: f.root, maxOutputBytes: 65536, goals: scope.context });
    assert.equal(result.isError, false);
    const rejected = await registry.dispatch("goal", {action:"update",criteria:[{id:"missing",status:"done"}]}, {cwd:f.root,maxOutputBytes:65536,goals:f.call().context});
    assert.equal(rejected.code,"invalid_goal", "host GoalError must survive the separately bundled builtin boundary");
    const dir = join(f.root, "tools", "probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool.json"), JSON.stringify({ api_version: 2, id: "probe", name: "probe", version: "1.0.0", description: "Probe scoped context", entry: "./index.mjs", input_schema: { type: "object", additionalProperties: false } }));
    writeFileSync(join(dir, "index.mjs"), 'export async function handler(args,context){return {isError:false,content:[{type:"text",text:String(Boolean(context.goals))}]}}');
    const plugin = (await loadToolPlugins({ selectedIds: ["local/probe"], configPath: join(f.root, "raw.json"), globalConfigRoot: f.root }))[0]!;
    const other = new ToolRegistry();
    other.register(plugin.registration);
    const probe = await other.dispatch("probe", {}, { cwd: f.root, maxOutputBytes: 65536, goals: scope.context });
    assert.equal(probe.content[0]!.type, "text");
    assert.equal((probe.content[0] as {
      text: string;
    }).text, "false");
  }
  finally {
    f.cleanup();
  }
});

test("AC-2 staged updates cannot overwrite a newer user budget revision",async()=>{
 const f=fixture();try{const call=f.call();await handler({action:"update",criteria:[{id:"c",status:"done",evidence:"proof"}]},{cwd:f.root,maxOutputBytes:65536,goals:call.context});const state=f.service.state();f.service.setBudget({tokenBudget:100},"budget",state.revision);assert.throws(()=>call.settle(true),/stale_revision/);assert.equal(f.service.get()!.definition.criteria[0]!.status,"pending");assert.equal(f.service.get()!.definition.tokenBudget,100);}finally{f.cleanup();}
});
