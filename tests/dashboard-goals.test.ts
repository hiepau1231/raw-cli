import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import type { GoalReceipt, GoalState } from "../src/goals/contract.js";
import type { SessionSummary } from "../src/sessions/store.js";
const tools = { tools: { use: ["builtin/goal"] } };
const final = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const complete = { frames: [openAiFrame({ tool_calls: [
  { index: 0, id: "proof", type: "function", function: { name: "goal", arguments: JSON.stringify({ action: "update", criteria: [{ id: "criterion-1", status: "done", evidence: "fixture result inspected" }] }) } },
  { index: 1, id: "done", type: "function", function: { name: "goal", arguments: JSON.stringify({ action: "complete" }) } },
] }, "tool_calls"), openAiDone] };
async function until(check: () => boolean) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error("goal barrier timed out"); await new Promise(r => setTimeout(r, 10)); } }
test("AC-5 HTTP start is atomic/idempotent, continues in one operation, and requires explicit opt-in", async () => {
 const f = await dashboardFixture({ agent: tools, responses: [final("one"), final("two"), complete] });
 try {
  const s = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
  assert.deepEqual(await f.json(`/sessions/${s.id}/goal`), {revision:0,goal:null});
  const request = { clientRequestId:"start", expectedRevision:0, command:{action:"start",definition:{objective:"Ship"}} };
  const path = `/sessions/${s.id}/goal/commands`;
  const [a,b] = await Promise.all([1,2].map(()=>f.json<GoalReceipt>(path,"POST",request)));
  assert.ok(a); assert.deepEqual(a,b); assert.ok(a.operationId); await f.wait(a.operationId!);
  const g = await f.json<GoalState>(`/sessions/${s.id}/goal`);
  assert.equal(g.goal?.status,"complete"); assert.equal(g.goal?.usage.requests,3); assert.equal(f.provider.requests.length,3);
  assert.deepEqual(await f.json(path,"POST",request),a);
  assert.equal((await f.api(path,"POST",{...request,command:{action:"start",definition:{objective:"Changed"}}})).status,409);
  assert.equal((await f.api(path,"POST",{clientRequestId:"stale",expectedRevision:0,command:{action:"clear"}})).status,409);
  assert.equal(f.server.context.store!.listOperations(s.id).length,1);
  assert.equal(f.server.context.store!.listSessionPanels(s.id).length,0);
  const unauth = await fetch(`${f.server.url}/api${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)}); assert.equal(unauth.status,401);
 } finally { await f.close(); }
 const legacy = await dashboardFixture();
 try { const s=await legacy.json<SessionSummary>("/sessions","POST",{cwd:legacy.root,agent:"raw"}); assert.equal((await legacy.api(`/sessions/${s.id}/goal/commands`,"POST",{clientRequestId:"off",expectedRevision:0,command:{action:"start",definition:{objective:"No"}}})).status,422); assert.equal(legacy.provider.requests.length,0); } finally { await legacy.close(); }
});
test("AC-5 live edit settles, keeps usage, does not hand off queued input; SSE clear is canonical", async () => {
 const f=await dashboardFixture({agent:tools,responses:[{hold:true},complete]});
 try {
  const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"}),path=`/sessions/${s.id}/goal`;
  const a=await f.json<GoalReceipt>(`${path}/commands`,"POST",{clientRequestId:"start",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}});
  await until(()=>f.provider.requests.length===1);
  const before=await f.json<GoalState>(path);
  const queued=await f.json<{queued:{id:string}}>(`/sessions/${s.id}/inputs`,"POST",{clientRequestId:"steer",agent:"raw",input:"yes",mode:"queue"}); assert.ok(queued.queued);
  assert.equal((await f.api(`${path}/commands`,"POST",{clientRequestId:"stale",expectedRevision:0,command:{action:"pause"}})).status,409);
  assert.equal(f.server.context.store!.getOperation(a.operationId!)!.state,"running");
  const edit={clientRequestId:"edit",expectedRevision:before.revision,command:{action:"edit",definition:{objective:"Reframed"}}};
  const [edited,duplicate]=await Promise.all([f.json<GoalReceipt>(`${path}/commands`,"POST",edit),f.json<GoalReceipt>(`${path}/commands`,"POST",edit)]); assert.ok(edited); assert.deepEqual(edited,duplicate);
  assert.equal(edited.goal?.status,"paused"); assert.equal(edited.goal?.definition.objective,"Reframed"); assert.equal(edited.goal?.usage.requests,1); assert.equal(f.provider.requests.length,1);
  assert.equal(f.server.context.store!.queuedInputs(s.id)[0]?.state,"paused"); assert.equal(f.server.context.store!.listOperations(s.id).length,1);
  const stream=await eventStream(f.server,s.id);
  try {
   const snap=await stream.next(); assert.equal(snap.type,"snapshot"); assert.deepEqual((snap.data as unknown as {goal:GoalState}).goal,await f.json(path));
   const clear=await f.json<GoalReceipt>(`${path}/commands`,"POST",{clientRequestId:"clear",expectedRevision:edited.revision,command:{action:"clear"}});
   let frame=await stream.next(); while(frame.type!=="goal") frame=await stream.next();
   assert.equal(frame.data.revision,clear.revision); assert.equal(frame.data.goal,null);
  } finally { stream.close(); }
 } finally { await f.close(); }
});
test("AC-5 foreign lease stays readable/busy and startup failure pauses without inference", async()=>{
 const f=await dashboardFixture({agent:tools});
 try { const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"}),store=f.server.context.store!,owner=store.claimSession(s.id);
  try { assert.equal((await f.api(`/sessions/${s.id}/goal`)).status,200); assert.equal((await f.api(`/sessions/${s.id}/goal/commands`,"POST",{clientRequestId:"busy",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}})).status,409); assert.equal(f.provider.requests.length,0); } finally {store.releaseSession(s.id,owner);}
 } finally {await f.close();}
 const broken=await dashboardFixture({agent:tools,attach:async()=>{throw new Error("fixture attach failed");}});
 try { const s=await broken.json<SessionSummary>("/sessions","POST",{cwd:broken.root,agent:"raw"}); const r=await broken.json<GoalReceipt>(`/sessions/${s.id}/goal/commands`,"POST",{clientRequestId:"start",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}}); assert.equal((await broken.wait(r.operationId!)).state,"error"); assert.equal((await broken.json<GoalState>(`/sessions/${s.id}/goal`)).goal?.status,"paused"); assert.equal(broken.provider.requests.length,0); } finally {await broken.close();}
});

test("AC-5 paused Goal text remains steering and explicit resume retains usage", async()=>{
 const f=await dashboardFixture({agent:tools,responses:[{hold:true},complete]});
 try {
  const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"}),path=`/sessions/${s.id}/goal`;
  await f.json<GoalReceipt>(`${path}/commands`,"POST",{clientRequestId:"start",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}}); await until(()=>f.provider.requests.length===1);
  const active=await f.json<GoalState>(path); const paused=await f.json<GoalReceipt>(`${path}/commands`,"POST",{clientRequestId:"pause",expectedRevision:active.revision,command:{action:"pause"}});
  const queued=await f.json<{queued?:{id:string;state:string}}>(`/sessions/${s.id}/inputs`,"POST",{clientRequestId:"steer-paused",agent:"raw",input:"keep the original constraints",mode:"queue"});
  assert.ok(queued.queued); assert.equal(queued.queued.state,"paused"); assert.equal(f.provider.requests.length,1); assert.equal(f.server.context.store!.listOperations(s.id).length,1);
  const request={clientRequestId:"resume",expectedRevision:paused.revision,command:{action:"resume"}};
  const [a,b]=await Promise.all([f.json<GoalReceipt>(`${path}/commands`,"POST",request),f.json<GoalReceipt>(`${path}/commands`,"POST",request)]); assert.ok(a); assert.deepEqual(a,b); await f.wait(a.operationId!);
  const done=await f.json<GoalState>(path); assert.equal(done.goal?.status,"complete"); assert.equal(done.goal?.usage.requests,2); assert.equal(f.provider.requests.length,2);
 } finally {await f.close();}
});
test("AC-5 a completed Goal run never hands a waiting queued message to a new operation",async()=>{
 let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
 const f=await dashboardFixture({agent:tools,responses:[{...complete,gate},final("must not run")]});
 try {
  const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"}),path=`/sessions/${s.id}/goal`;
  const a=await f.json<GoalReceipt>(`${path}/commands`,"POST",{clientRequestId:"start",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}}); await until(()=>f.provider.requests.length===1);
  await f.json(`/sessions/${s.id}/inputs`,"POST",{clientRequestId:"steer",agent:"raw",input:"do not start another run",mode:"queue"}); release();
  assert.equal((await f.wait(a.operationId!)).state,"completed"); assert.equal(f.provider.requests.length,1); assert.equal(f.server.context.store!.listOperations(s.id).length,1); assert.equal(f.server.context.store!.queuedInputs(s.id)[0]?.state,"paused");
 } finally {release();await f.close();}
});
test("AC-5 failure inserting an authorized operation rolls back Goal state receipt and audit",async()=>{
 const f=await dashboardFixture({agent:tools});
 try {const s=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
 const db=(f.server.context.store! as unknown as {database:{exec:(sql:string)=>void}}).database;
 db.exec("CREATE TRIGGER fail_goal_operation BEFORE INSERT ON session_operations BEGIN SELECT RAISE(ABORT, 'fixture operation failure'); END");
 const request={clientRequestId:"atomic",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}};
 assert.equal((await f.api(`/sessions/${s.id}/goal/commands`,"POST",request)).status,500); assert.deepEqual(await f.json(`/sessions/${s.id}/goal`),{revision:0,goal:null});
 assert.equal(f.server.context.store!.goalCommandReceipt(s.id,request as import('../src/goals/contract.js').GoalRequest),undefined); assert.equal(f.server.context.store!.historyWatermark(s.id),0); assert.equal(f.server.context.store!.sessionIsBusy(s.id),false); assert.equal(f.provider.requests.length,0);
 db.exec("DROP TRIGGER fail_goal_operation");
 } finally {await f.close();}
});

test("AC-5 closing the host before an accepted command microtask cannot launch work",async()=>{
 const f=await dashboardFixture({agent:tools});
 try { const session=await f.json<SessionSummary>("/sessions","POST",{cwd:f.root,agent:"raw"});
 const operations=f.server.context.operations!;
 const command=operations.commandGoal(session.id,{clientRequestId:"closing",expectedRevision:0,command:{action:"start",definition:{objective:"Ship"}}},{agentName:"raw",configPath:f.configPath});
 const rejected=assert.rejects(command,/closed/); await operations.close(); await rejected;
 assert.equal(f.provider.requests.length,0); assert.equal(f.server.context.store!.getGoalState(session.id).goal,null);
 } finally {await f.close();}
});
