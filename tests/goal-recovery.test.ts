import { spawn } from "node:child_process";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openSessionStore } from "../src/sessions/store.js";
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
    assert.equal(receipt.revision, before.revision + 2);
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

test("AC-3 SDK crash with provisional usage is recovered through a host operation without inference", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/goal-provisional-child.ts")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit"); let root: string | undefined; let store: ReturnType<typeof openSessionStore> | undefined; let agent: ReturnType<typeof createAgent> | undefined;
  try {
    const ready = await new Promise<{ root: string; sessionId: string }>((resolve, reject) => {
      let text = ""; const timeout = setTimeout(() => reject(new Error("child not ready")), 10000);
      child.once("error", e => { clearTimeout(timeout); reject(e); }); child.once("exit", () => { clearTimeout(timeout); reject(new Error("child exited")); });
      child.stdout.on("data", b => { text += String(b); for (const line of text.split("\n")) try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timeout); resolve(v); } } catch {} });
    });
    root = ready.root; child.kill("SIGKILL"); await exited;
    store = openSessionStore({ env: { XDG_STATE_HOME: root }, now: () => Date.now() + 16000 });
    const provisional = store.getGoalState(ready.sessionId).goal!;
    assert.equal(provisional.usage.currentRequest?.settled, false);
    const { owner } = store.acceptOperation({ sessionId: ready.sessionId, clientRequestId: "host-after-sdk-crash", kind: "turn", input: "Read only", agentName: "test", configPath: root + "/raw.json" });
    let requests = 0;
    agent = createAgent({ registry: goalRegistry(), cwd: root, persistence: { store, sessionId: ready.sessionId, owner: owner!, ownership: "host", surface: "web" }, provider: { modelConfig: goalModel, async generate() { requests++; return { text: "status", toolCalls: [], finishReason: "stop", usage: goalUsage }; } } });
    assert.equal(agent.getGoal()?.status, "paused"); assert.equal(agent.getGoal()?.reason, "interrupted"); assert.equal(agent.getGoal()?.elapsedApproximate, true);
    assert.equal(agent.getGoal()?.usage.requests, 1); assert.equal(agent.getGoal()?.usage.inputTokens, 5); assert.equal(agent.getGoal()?.usage.outputCoverage, 0);
    await assert.rejects(agent.resumeGoal(), /usage_unknown/); assert.equal(requests, 0);
    assert.throws(() => new GoalService({ store: store!, sessionId: ready.sessionId, owner: owner! }).command({ clientRequestId: "model-cannot-mutate", expectedRevision: agent!.getGoal()!.revision, command: { action: "block", reason: "old goal", nextAction: "wait" } }, "model"), /goal_inactive/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await agent?.close(); store?.close(); if (root) rmSync(root, { recursive: true, force: true });
  }
});
test("AC-3 a queued host turn recovers an expired SDK goal on its own idle claim", async () => {
  const f = goalFixture(() => ({ text: "working", toolCalls: [], finishReason: "stop", usage: goalUsage }));
  try {
    await f.agent.runGoal({ objective: "Recover queued owner" });
    const row = f.store.database.prepare("SELECT owner_token,owner_generation FROM sessions WHERE id=?").get(f.session.id)!;
    const owner = { token: String(row.owner_token), generation: Number(row.owner_generation) };
    const queued = f.store.enqueueInput(f.session.id, owner, { sessionId: f.session.id, clientRequestId: "queued-host", agentName: "test", configPath: f.root + "/raw.json", kind: "turn", mode: "queue", input: "Read status" });
    f.store.updateGoal(f.session.id, owner, g => { g.status = "active"; delete g.reason; });
    await f.agent.close(); f.store.database.prepare("UPDATE sessions SET owner_token='2147483647-dead',lease_until=0 WHERE id=?").run(f.session.id);
    const count = f.requests(); f.store.startQueuedInput(f.session.id, queued.id);
    assert.equal(f.store.getGoalState(f.session.id).goal?.status, "paused"); assert.equal(f.store.getGoalState(f.session.id).goal?.reason, "interrupted"); assert.equal(f.requests(), count);
  } finally { await f.cleanup(); }
});

test("AC-3 killed SDK steering cannot auto-handoff after one explicitly submitted ordinary turn",{timeout:20000},async()=>{
 const marker="NATIVE_STEERING_MUST_NOT_START_AN_ORDINARY_TURN";
 const child=spawn(process.execPath,["--import",import.meta.resolve("tsx"),join(process.cwd(),"tests/fixtures/goal-provisional-child.ts"),marker],{stdio:["ignore","pipe","pipe"],windowsHide:true});
 const exited=once(child,"exit");let root:string|undefined,store:ReturnType<typeof openSessionStore>|undefined,operations:SessionOperations|undefined;
 try{
  const ready=await new Promise<{root:string;sessionId:string}>((resolve,reject)=>{
   let text="";const timeout=setTimeout(()=>reject(new Error("child not ready")),10000);
   child.once("error",error=>{clearTimeout(timeout);reject(error);});child.once("exit",()=>{clearTimeout(timeout);reject(new Error("child exited"));});
   child.stdout.on("data",b=>{text+=String(b);for(const line of text.split("\n"))try{const value=JSON.parse(line);if(value.ready){clearTimeout(timeout);resolve(value);}}catch{}});
  });
  root=ready.root;child.kill("SIGKILL");await exited;
  store=openSessionStore({env:{XDG_STATE_HOME:root},now:()=>Date.now()+16000});const current=store;const captured:string[]=[];
  operations=new SessionOperations({store:current,attach:async({owner,operation})=>({
   agent:createAgent({cwd:root!,registry:goalRegistry(),deliverQueuedInputs:true,provider:{modelConfig:goalModel,async generate(request){captured.push(JSON.stringify(request.messages));return{text:"Explicit ordinary result",toolCalls:[],finishReason:"stop",usage:goalUsage};}},persistence:{store:current,sessionId:ready.sessionId,owner,ownership:"host",surface:"web",operationId:operation.id}}),
   modelConfig:goalModel,compactOptions:{keepRecentTurns:1,maxOutputTokens:64},async close(){}
  })});
  assert.equal(captured.length,0);
  const operation=operations.submit({sessionId:ready.sessionId,clientRequestId:"one-ordinary-turn",kind:"turn",agentName:"test",configPath:root+"/raw.json",input:"Explicit ordinary task"});await operations.wait(operation.id);
  const deadline=Date.now()+5000;while(operations.activeIds().length){assert.ok(Date.now()<deadline,"host cleanup timed out");await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(captured.length,1);assert.equal(captured[0]!.includes(marker),false);assert.equal(current.listOperations(ready.sessionId).length,1);
  assert.equal(current.getGoalState(ready.sessionId).goal?.status,"paused");assert.equal(current.findQueuedInput(ready.sessionId,"crash-steer")?.state,"paused");
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}
  await operations?.close();store?.close();if(root)rmSync(root,{recursive:true,force:true});
 }
});

test("AC-3 killed SDK idle budget removal recovers atomically without authorizing resume", { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "tests/fixtures/goal-provisional-child.ts"), "budget steering"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit"); let root: string | undefined, store: ReturnType<typeof openSessionStore> | undefined, host: SessionOperations | undefined;
  try {
    const ready = await new Promise<{ root: string; sessionId: string }>((resolve, reject) => {
      let text = ""; const timeout = setTimeout(() => reject(new Error("child not ready")), 10000);
      child.once("error", error => { clearTimeout(timeout); reject(error); }); child.once("exit", () => { clearTimeout(timeout); reject(new Error("child exited")); });
      child.stdout.on("data", b => { text += String(b); for (const line of text.split("\n")) try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timeout); resolve(value); } } catch {} });
    });
    root = ready.root; child.kill("SIGKILL"); await exited;
    store = openSessionStore({ env: { XDG_STATE_HOME: root }, now: () => Date.now() + 16000 }); host = new SessionOperations({ store });
    const before = store.getGoalState(ready.sessionId);
    const request = { clientRequestId: "remove-cap-after-crash", expectedRevision: before.revision, command: { action: "setBudget" as const, tokenBudget: null } };
    const binding = { agentName: "test", configPath: root + "/raw.json" };
    await assert.rejects(host.commandGoal(ready.sessionId, { ...request, expectedRevision: before.revision - 1 }, binding), /stale_revision/);
    assert.deepEqual(store.getGoalState(ready.sessionId), before);
    store.database.exec("CREATE TRIGGER fail_recover_budget BEFORE INSERT ON session_goal_commands BEGIN SELECT RAISE(ABORT,'budget receipt failed'); END");
    await assert.rejects(host.commandGoal(ready.sessionId, request, binding), /budget receipt failed/);
    assert.deepEqual(store.getGoalState(ready.sessionId), before);
    store.database.exec("DROP TRIGGER fail_recover_budget");
    const receipt = await host.commandGoal(ready.sessionId, request, binding);
    assert.equal(receipt.goal?.status, "paused"); assert.equal(receipt.goal?.reason, "interrupted"); assert.equal(receipt.goal?.elapsedApproximate, true);
    assert.equal(receipt.goal?.definition.tokenBudget, undefined); assert.deepEqual(receipt.goal?.usage, before.goal!.usage);
    assert.equal(store.findQueuedInput(ready.sessionId, "crash-steer")?.state, "paused");
    assert.equal(store.listOperations(ready.sessionId).length, 0); assert.equal(store.sessionIsBusy(ready.sessionId), false);
    assert.deepEqual(await host.commandGoal(ready.sessionId, request, binding), receipt);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await host?.close(); store?.close(); if (root) rmSync(root, { recursive: true, force: true });
  }
});
