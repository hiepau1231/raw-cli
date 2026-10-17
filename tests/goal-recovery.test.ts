import { GoalService } from "../src/goals/service.js";
import { SessionOperations } from "../src/sessions/operations.js";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { goalFixture, goalUsage, goalRegistry, goalModel } from "./fixtures/goals.js";
import { createAgent } from "../src/agent.js";
test("AC-3 reopening an unfinished active goal pauses and never executes before explicit resume", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    await f.agent.runGoal({ objective: "Recover" });
    const owner = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    f.store.updateGoal(f.session.id, { token: String(owner.owner_token), generation: Number(owner.owner_generation) }, g => { g.status = "active"; delete g.reason; });
    await f.agent.close();
    const count = f.requests();
    const reopened = createAgent({ provider: f.provider, registry: f.registry, cwd: f.root, persistence: { store: f.store, sessionId: f.session.id, surface: "cli" } });
    try {
      assert.equal(reopened.getGoal()!.status, "paused");
      assert.equal(reopened.getGoal()!.reason, "interrupted");
      assert.equal(f.requests(), count);
      assert.equal(reopened.getGoal()!.elapsedApproximate, true);
      await reopened.resumeGoal();
      assert.equal(f.requests(), count + 3);
    }
    finally {
      await reopened.close();
    }
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 killed process recovers committed effects without replay or automatic requests", { timeout: 20000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, appendFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { openSessionStore } = await import("../src/sessions/store.js");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/goal-crash-child.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  let root: string | undefined;
  let store: ReturnType<typeof openSessionStore> | undefined;
  let agent: ReturnType<typeof createAgent> | undefined;
  let stderr = "";
  child.stderr.on("data", b => { stderr += String(b); });
  try {
    const ready = await new Promise<{
      root: string;
      sessionId: string;
    }>((resolve, reject) => {
      let text = "";
      const timeout = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 8000);
      child.once("error", e => { clearTimeout(timeout); reject(e); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`child exited ${code}: ${stderr}`)); });
      child.stdout.on("data", b => {
        text += String(b);
        for (const line of text.split("\n")) {
          try {
            const value = JSON.parse(line);
            if (value.ready) {
              clearTimeout(timeout);
              resolve(value);
              return;
            }
          }
          catch { }
        }
      });
    });
    root = ready.root;
    child.kill("SIGKILL");
    await exited;
    store = openSessionStore({ env: { XDG_STATE_HOME: root }, now: () => Date.now() + 16000 });
    let requests = 0;
    const registry = goalRegistry([{ name: "effect", description: "Sentinel", inputSchema: { type: "object" }, async handler() { appendFileSync(join(root!, "sentinel"), "1"); return { isError: false, content: [{ type: "text", text: "written" }] }; } }]);
    agent = createAgent({ registry, cwd: root, persistence: { store, sessionId: ready.sessionId, surface: "cli" }, provider: { modelConfig: goalModel, async generate() { return { text: "", toolCalls: [++requests === 1 ? { id: "proof", name: "goal", arguments: { action: "update", criteria: [{ id: "c", status: "done", evidence: "verified sentinel once" }] } } : { id: "complete", name: "goal", arguments: { action: "complete" } }], finishReason: "tool_calls", usage: goalUsage }; } } });
    assert.equal(agent.getGoal()!.status, "paused");
    assert.equal(agent.getGoal()!.reason, "interrupted");
    assert.equal(agent.getGoal()!.elapsedApproximate, true);
    assert.equal(requests, 0);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(requests, 0);
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "1");
    assert.ok(agent.transcript.some(m => m.role === "tool" && m.callId === "sentinel" && !m.result.isError));
    const spent = agent.getGoal()!.usage.requests;
    assert.ok(spent >= 1);
    const result = await agent.resumeGoal();
    assert.equal(result.goal?.snapshot?.status, "complete");
    assert.equal(agent.getGoal()!.usage.requests, spent + 2);
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "1");
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await agent?.close();
    store?.close();
    if (root)
      rmSync(root, { recursive: true, force: true });
  }
});
test("AC-3 user control after an expired dead lease does not loop on stale revisions", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    await f.agent.runGoal({ objective: "Recover controls" });
    const owner = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    f.store.updateGoal(f.session.id, { token: String(owner.owner_token), generation: Number(owner.owner_generation) }, g => { g.status = "active"; delete g.reason; });
    await f.agent.close();
    f.store.database.prepare("UPDATE sessions SET owner_token='2147483647-dead',lease_until=0 WHERE id=?").run(f.session.id);
    const service = new GoalService({ store: f.store, sessionId: f.session.id });
    const before = service.state();
    const receipt = service.pause("recover-pause", before.revision);
    assert.equal(receipt.revision, before.revision + 1);
    assert.equal(receipt.goal!.status, "paused");
    assert.equal(receipt.goal!.elapsedApproximate, true);
    assert.deepEqual(service.pause("recover-pause", before.revision), receipt);
  }
  finally {
    await f.cleanup();
  }
});
test("AC-3 operation recovery pauses its interrupted native goal exactly once", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    await f.agent.runGoal({ objective: "Host recovery" });
    await f.agent.close();
    const { operation, owner } = f.store.acceptOperation({ sessionId: f.session.id, clientRequestId: "host-run", kind: "turn", input: "work", agentName: "test", configPath: f.root + "/raw.json" });
    f.store.updateGoal(f.session.id, owner!, g => { g.status = "active"; delete g.reason; });
    f.store.database.prepare("UPDATE sessions SET owner_token='2147483647-dead',lease_until=0 WHERE id=?").run(f.session.id);
    const operations = new SessionOperations({ store: f.store });
    try {
      assert.equal(f.store.getOperation(operation.id)!.state, "interrupted");
      assert.equal(f.store.getGoalState(f.session.id).goal!.status, "paused");
      assert.equal(f.store.getGoalState(f.session.id).goal!.reason, "interrupted");
      const revision = f.store.getGoalState(f.session.id).revision;
      assert.equal(f.store.recoverOperations(), 0);
      assert.equal(f.store.getGoalState(f.session.id).revision, revision);
    }
    finally {
      await operations.close();
    }
  }
  finally {
    await f.cleanup();
  }
});
