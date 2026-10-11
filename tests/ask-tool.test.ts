import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { createAgent } from "../src/agent.js";
import { createProvider } from "../src/llm/client.js";
import { startMockProvider,openAiFrame,openAiDone } from "./fixtures/mock-provider.js";
import type { InteractionAdapter } from "../src/interactions/contract.js";
async function registry(rules:ConstructorParameters<typeof ToolRegistry>[0]=[]){
  const result=new ToolRegistry(rules);for(const tool of await loadBundledTools(["ask_user"]))result.register(tool);return result;
}
type Fields=Array<Record<string,unknown>>;
const text=(result:{content:Array<{type:string;text?:string}>})=>result.content.map(block=>block.text??"").join("");
/** Dispatches one call through the production loader and answers its form; returns the form fields and the result. */
async function ask(args:Record<string,unknown>,answers:Record<string,unknown>|"cancelled"){
  const tools=await registry();let fields:Fields=[];
  const result=await tools.dispatch("ask_user",args,{cwd:process.cwd(),maxOutputBytes:8192,interactions:{request:async input=>{
    fields=(input.document.blocks[0] as {fields:Fields}).fields;
    return answers==="cancelled"?{status:"cancelled"}:{status:"answered",answers} as never;}}});
  // Text fields carry the byte limit that keeps the result within the budget (tested on its own below).
  for(const field of fields) if(field.kind==="text"){assert.ok((field.max_bytes as number)>1000);delete field.max_bytes;}
  return {fields,result};
}
test("one question with string options is a single choice with Other and answers as text",async()=>{
  const {fields,result}=await ask({question:"Which database should the service use?",options:["Postgres","SQLite"]},{answer:"o1"});
  assert.deepEqual(fields,[
    {id:"answer",label:"Which database should the service use?",kind:"single_select",options:[{id:"o1",label:"Postgres"},{id:"o2",label:"SQLite"}],required:false},
    {id:"answer_other",label:"Other",kind:"text",required:false}]);
  assert.equal(result.isError,false);assert.equal(text(result),"User answered: Postgres");
  assert.equal(result.content.some(block=>block.type==="json"),false);
  assert.equal(text((await ask({question:"Which database?",options:["Postgres","SQLite"]},{answer_other:"MySQL"})).result),"User answered: MySQL");
  assert.equal(text((await ask({question:"Which database?",options:["Postgres","SQLite"]},{})).result),"User skipped the question");
  const strict=await ask({question:"Which database?",options:["Postgres","SQLite"],allow_other:false},{answer:"o2"});
  assert.deepEqual(strict.fields.map(field=>[field.id,field.required]),[["answer",true]]);
  assert.equal(text(strict.result),"User answered: SQLite");
});
test("multi_select lists every choice, multiSelect reads as multi_select, and no options asks for free text",async()=>{
  const many=await ask({question:"Which targets?",options:["linux","mac","windows"],multiSelect:true},{answer:["o3","o1"],answer_other:"bsd"});
  assert.equal(many.fields[0]!.kind,"multi_select");
  assert.equal(text(many.result),"User answered: windows, linux, bsd");
  const free=await ask({question:"What should the release be called?"},{answer:"Snow 雪"});
  assert.deepEqual(free.fields,[{id:"answer",label:"What should the release be called?",kind:"text",multiline:true,required:false}]);
  assert.equal(text(free.result),"User answered: Snow 雪");
});
test("questions[] in the Claude Code shape becomes one form with generated fields and ordered answers",async()=>{
  const {fields,result}=await ask({questions:[
    {question:"Which database should the service use?",header:"Database",options:[{label:"Postgres",description:"Managed, relational"},{label:"SQLite"}],multiSelect:false},
    {question:"Which regions?",header:"Regions",options:[{label:"eu"},{label:"us"}],multiSelect:true},
    {question:"Anything else?"},
  ]},{q1:"o1",q2:["o2"],q3:""});
  assert.deepEqual(fields,[
    {id:"q1",label:"Database",description:"Which database should the service use?",kind:"single_select",
      options:[{id:"o1",label:"Postgres — Managed, relational"},{id:"o2",label:"SQLite"}],required:false},
    {id:"q1_other",label:"Other",kind:"text",required:false},
    {id:"q2",label:"Regions",description:"Which regions?",kind:"multi_select",options:[{id:"o1",label:"eu"},{id:"o2",label:"us"}],required:false},
    {id:"q2_other",label:"Other",kind:"text",required:false},
    {id:"q3",label:"Anything else?",kind:"text",multiline:true,required:false}]);
  assert.equal(text(result),"User answered:\n- Which database should the service use?: Postgres\n- Which regions?: us\n- Anything else?: (skipped)");
});
test("selection counts and text lengths keep the spelled-out answer within the output budget",async()=>{
  const tools=await registry();
  const options=Array.from({length:32},(_,i)=>`option ${i} ${"label ".repeat(20)}`);
  const questions=[1,2,3].map(n=>({question:`Question ${n}?`,options,multiSelect:true}));
  let fields:Fields=[];
  // Many ignored extras make dispatch append a note; it is bounded, so it never pushes accepted answers out.
  const extras=Object.fromEntries(Array.from({length:20},(_,i)=>[`unused_argument_${i}`,i]));
  const result=await tools.dispatch("ask_user",{questions,...extras},{cwd:process.cwd(),maxOutputBytes:8192,interactions:{request:async input=>{
    fields=(input.document.blocks[0] as {fields:Fields}).fields;
    // The user picks as many choices and types as much as each field allows.
    const answers=Object.fromEntries(fields.map(field=>[field.id,field.kind==="text"?"x".repeat(field.max_bytes as number)
      :(field.options as Array<{id:string}>).slice(0,(field.max_selected as number|undefined)??32).map(option=>option.id)]));
    return {status:"answered",answers} as never;}}});
  assert.ok(fields.some(field=>field.kind==="multi_select"&&(field.max_selected as number)<32),"some selection count is limited");
  assert.equal(result.truncated,false);
  assert.ok(Buffer.byteLength(text(result))<=8192);
  assert.match(text(result),/\[ignored unknown argument: unused_argument_0\][\s\S]*\[20 notes in all; rest omitted\]$/);
  for(const field of fields.filter(field=>field.kind==="multi_select"))
    assert.match(text(result),new RegExp(`option ${(field.max_selected as number)-1} `),"the last allowed choice is in the result");
  const tiny=await tools.dispatch("ask_user",{question:"Q",options:["A".repeat(200)]},{cwd:process.cwd(),maxOutputBytes:300,interactions:{request:async()=>({status:"cancelled"})}});
  assert.equal(tiny.code,"interaction_budget_too_small");
});
test("unused nested fields and redundant aliases are dropped, and long labels stay whole beside descriptions",async()=>{
  const {fields,result}=await ask({questions:[{question:"Pick",options:[{label:"A",value:"a"},"B"],irrelevant:true,multiSelect:true,multi_select:false}]},{answer:"o1"});
  assert.equal(result.isError,false,text(result));
  assert.equal(fields[0]!.kind,"single_select","multi_select wins over the redundant multiSelect");
  assert.equal(text(result),"User answered: A");
  const long=await ask({question:"Which?",options:[{label:"a".repeat(199)+"B",description:"first"},{label:"a".repeat(199)+"C",description:"second"},{label:"short",description:"d".repeat(300)}]},{answer:"o2"});
  const labels=(long.fields[0]!.options as Array<{label:string}>).map(option=>option.label);
  assert.deepEqual(labels.slice(0,2),["a".repeat(199)+"B","a".repeat(199)+"C"]);
  assert.match(labels[2]!,/^short — d+…$/);assert.equal([...labels[2]!].length,200);
  assert.equal(text(long.result),`User answered: ${"a".repeat(199)}C`);
});
test("the removed kind/id schema and invalid questions are rejected before permission or publication",async()=>{
  const tools=await registry([{match:"builtin/ask_user",effect:"ask"}]);let approvals=0;let requests=0;
  const dispatch=(args:Record<string,unknown>)=>tools.dispatch("ask_user",args,{cwd:process.cwd(),maxOutputBytes:8192,approve:()=>{approvals++;return true;},
    interactions:{request:async()=>{requests++;return {status:"cancelled"};}}});
  const old=await dispatch({questions:[{id:"q",label:"Q",kind:"text"}]});
  assert.equal(old.code,"invalid_arguments");
  assert.match(text(old),/ask_user asks a question in plain words: \{"question":"Which database should the service use\?","options":\["Postgres","SQLite"\]\}/);
  for(const args of [{},{question:""},{questions:[]},{questions:[{question:"a"},{question:"b"},{question:"c"},{question:"d"}]},
    {question:"Q",questions:[{question:"R"}]},{question:"Q",options:[{name:"x"}]},{question:"Q",options:Array.from({length:33},(_,i)=>`o${i}`)}]){
    const result=await dispatch(args);
    assert.equal(result.code,"invalid_arguments",JSON.stringify(args));
  }
  assert.equal(approvals,0);assert.equal(requests,0);
});
test("Ask reports unavailable surfaces and unanswered endings as text",async()=>{
  const tools=await registry();
  const unavailable=await tools.dispatch("ask_user",{question:"Q"},{cwd:process.cwd(),maxOutputBytes:8192});
  assert.equal(unavailable.code,"interaction_unavailable");
  for(const [status,message] of [["cancelled","User skipped the question"],["expired","The question expired without an answer"],
    ["interrupted","The question was interrupted before an answer"]] as const){
    const result=await tools.dispatch("ask_user",{question:"Q"},{cwd:process.cwd(),maxOutputBytes:8192,interactions:{request:async()=>({status})}});
    assert.equal(result.isError,true);assert.equal(result.code,`interaction_${status}`);assert.deepEqual(result.content,[{type:"text",text:message}]);
  }
});
test("packaged Ask delivers the user's exact text through the real provider",async()=>{
  const tools=await registry();
  const answer='雪\n"\t\\'.repeat(80);
  const fixture=await startMockProvider([
    {frames:[openAiFrame({tool_calls:[{index:0,id:"ask",type:"function",function:{name:"ask_user",arguments:JSON.stringify({question:"Describe"})}}]},"tool_calls"),openAiDone]},
    {frames:[openAiFrame({content:"received"},"stop"),openAiDone]},
  ]);
  let requested=0;
  const interactionAdapter:InteractionAdapter=async request=>{
    requested++;assert.equal(request.declaration.placement,"chat");
    return {requestId:request.identity.requestId,expectedRevision:request.revision,idempotencyKey:randomUUID(),response:"submit",answers:{answer}};
  };
  const agent=createAgent({registry:tools,provider:createProvider({agentName:"fixture",provider:"openai",method:"openai-chat-completions",model:"fixture",baseUrl:fixture.url,apiKey:"fixture"}),interactionAdapter});
  try{
    assert.equal((await agent.run("ask")).status,"completed");assert.equal(requested,1);
    const payload=fixture.requests[1]!.body as {messages:Array<{role:string;content:string}>};
    assert.equal(payload.messages.find(message=>message.role==="tool")!.content,`User answered: ${answer}`);
  }finally{await agent.close();await fixture.close();}
});

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { SelectedHook } from "../src/hooks/contract.js";
test("Ask keeps permission before publication and exposes only ordinary result data to hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-ask-hooks-"));
  const script = join(root, "hook.mjs"); const log = join(root, "events.jsonl");
  await writeFile(script, 'import {appendFileSync} from "node:fs";let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>appendFileSync(process.argv[2],input+"\\n"));');
  const hook: SelectedHook = { protocol_version: 2, id: "agent/audit", name: "audit", folder: root,
    command: process.execPath, args: [script, log], timeoutMs: 1000, events: [{ name: "PreToolUse" }, { name: "PostToolUse" }] };
  const tools = await registry([{ match: "builtin/ask_user", effect: "ask" }]);
  let steps = 0; const order: string[] = [];
  const agent = createAgent({ registry: tools, autoApprove: false, cwd: root, hooks: new HookDispatcher([hook]),
    provider: { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ++steps === 1 ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "ask", name: "ask_user", arguments: { question: "Q" } }] } : { text: "done", finishReason: "stop", toolCalls: [] } },
    approve: () => { order.push("approval"); return true; },
    interactionAdapter: async request => { order.push("question");
      const pre = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      assert.equal(pre.length, 1); assert.equal(pre[0].event, "PreToolUse");
      return { requestId: request.identity.requestId, expectedRevision: request.revision, idempotencyKey: randomUUID(), response: "submit", answers: { answer: "accepted" } }; },
  });
  try {
    assert.equal((await agent.run("ask")).status, "completed"); assert.deepEqual(order, ["approval", "question"]);
    const entries = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(entries.length, 2); assert.equal(entries[1].event, "PostToolUse");
    assert.match(JSON.stringify(entries[1]), /accepted/);
    assert.doesNotMatch(JSON.stringify(entries), /requestId|viewInstanceId|formBlockId|canonicalResult/);
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});
