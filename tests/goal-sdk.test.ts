import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { goalFixture, goalModel, goalRegistry, goalUsage } from "./fixtures/goals.js";
import type { GoalDefinition, GoalSnapshot, GoalCommand, GoalReceipt } from "../src/index.js";
import { GoalService } from "../src/index.js";
import { SessionOperations } from "../src/sessions/operations.js";
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

test("AC-4 paused SDK steering never leaks into a replacement Goal",async()=>{
 const seen:string[]=[];const f=goalFixture(request=>{seen.push(JSON.stringify(request.messages));return{text:"Working",toolCalls:[],finishReason:"stop",usage:goalUsage};});
 try{
  await f.agent.runGoal({objective:"Goal A"}); const queued=f.agent.queueUserInput("ONLY_FOR_GOAL_A_DO_NOT_USE_FOR_B","only-a");
  f.agent.commandGoal({clientRequestId:"clear-a",expectedRevision:f.agent.getGoal()!.revision,command:{action:"clear"}});
  const count=seen.length;await f.agent.runGoal({objective:"Goal B"});assert.equal(seen.slice(count).some(text=>text.includes("ONLY_FOR_GOAL_A_DO_NOT_USE_FOR_B")),false);assert.equal(f.store.queuedInputView(f.session.id,queued.id)?.state,"paused");
 }finally{await f.cleanup();}
});
for (const origin of ["released-sdk", "dead-operation"] as const) test(`AC-4 recovery ${origin} preserves paused steering for explicit resume`,async()=>{
 const seen:string[]=[];
 const f=goalFixture(()=>({text:"Working",toolCalls:[],finishReason:"stop",usage:goalUsage})); let host:SessionOperations|undefined;
 try{
  await f.agent.runGoal({objective:"Ship",maxRequests:10});
  if(origin==="released-sdk")f.agent.queueUserInput("IMPORTANT_RECOVERED_STEERING","recover-steer");
  await f.agent.close();
  if(origin==="dead-operation"){
   const active=f.store.acceptGoalOperation({sessionId:f.session.id,clientRequestId:"accepted",kind:"goal",agentName:"test",configPath:f.root+"/config.json"},{clientRequestId:"accepted",expectedRevision:f.store.getGoalState(f.session.id).revision,command:{action:"resume"}});
   f.store.enqueueInput(f.session.id,active.owner!,{sessionId:f.session.id,clientRequestId:"recover-steer",kind:"turn",agentName:"test",configPath:f.root+"/config.json",input:"IMPORTANT_RECOVERED_STEERING",mode:"queue"});
   f.store.database.prepare("UPDATE sessions SET owner_token='2147483647-dead',lease_until=0 WHERE id=?").run(f.session.id);
  }
  host=new SessionOperations({store:f.store,attach:async({owner,operation})=>({agent:createAgent({provider:{modelConfig:goalModel,async generate(request){seen.push(JSON.stringify(request.messages));return{text:"Working",toolCalls:[],finishReason:"stop",usage:goalUsage};}},registry:goalRegistry(),cwd:f.root,persistence:{store:f.store,sessionId:f.session.id,owner,ownership:"host",surface:"web",operationId:operation.id}}),modelConfig:goalModel,compactOptions:{keepRecentTurns:1,maxOutputTokens:64},async close(){}})});
  assert.equal(seen.length,0);assert.equal(f.store.findQueuedInput(f.session.id,"recover-steer")?.state,"paused");
  const receipt=await host.commandGoal(f.session.id,{clientRequestId:"resume-final",expectedRevision:f.store.getGoalState(f.session.id).revision,command:{action:"resume"}},{agentName:"test",configPath:f.root+"/config.json"}); await host.wait(receipt.operationId!);
  assert.ok(seen.length>0); assert.equal(seen[0]!.split("IMPORTANT_RECOVERED_STEERING").length-1,1);assert.equal(f.store.findQueuedInput(f.session.id,"recover-steer")?.state,"delivered");
 }finally{await host?.close();await f.cleanup();}
});
