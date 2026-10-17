import { GoalService } from "../src/goals/service.js";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpServer } from "../src/acp/methods.js";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { packPackage } from "../src/packages/archive.js";
import { installPackage } from "../src/packages/store.js";
import { addPackageAgent } from "../src/packages/cli.js";
import { inspectPackage } from "../src/packages/inspect.js";
import { loadPackageManifest } from "../src/packages/manifest.js";
import { resolveComponent } from "../src/packages/components.js";
import { hostCapabilities } from "../src/packages/contract.js";
import { exportAgentPackage } from "../src/packages/export.js";
import { loadConfig } from "../src/config.js";
import { createRuntimeTools } from "../src/tools/plugins/runtime.js";
import { openSessionStore } from "../src/sessions/store.js";
import { startMockProvider, openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
const kit=join("examples","packages","native-goal-kit");
const final=(text:string)=>({frames:[openAiFrame({content:text},"stop"),openAiDone]});
const complete={frames:[openAiFrame({tool_calls:[{index:0,id:"proof",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"update",criteria:[{id:"criterion-1",status:"done",evidence:"installed package checked"}]})}},{index:1,id:"done",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"complete"})}}]},"tool_calls"),openAiDone]};
test("AC-6 native manifest requires capability and rejects an older host",async()=>{
 const report=await inspectPackage(kit); assert.equal(report.name,"@raw/native-goal-kit"); assert.deepEqual(report.exports.agents,["coder"]); assert.deepEqual(report.exports.tools,[]); assert.ok(report.requires.includes("raw.goal/1")); assert.ok(hostCapabilities.has("raw.goal/1"));
 const pkg=await loadPackageManifest(kit); assert.throws(()=>resolveComponent("#agents/coder",{self:pkg,hostCapabilities:new Set([...hostCapabilities].filter(c=>c!=="raw.goal/1"))}),/unsupported host capability raw.goal\/1/);
});
test("AC-6 packed installed bound native kit runs without author source; ordinary turns remain ordinary",{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),"raw-native-package-")),author=join(root,"author"),archive=join(root,"native.rawpkg"),configPath=join(root,"config.json");
 const provider=await startMockProvider([final("First"),final("Second"),complete,final("ordinary final")]);
 const env={...process.env,XDG_DATA_HOME:join(root,"data"),XDG_STATE_HOME:join(root,"state"),XDG_CONFIG_HOME:join(root,"config")};
 const previous=process.env.XDG_DATA_HOME;process.env.XDG_DATA_HOME=env.XDG_DATA_HOME;
 try {
  cpSync(kit,author,{recursive:true});await packPackage(author,archive);rmSync(author,{recursive:true,force:true});
  const existing={model:"local",tools:{use:[]}};writeFileSync(configPath,JSON.stringify({default_agent:"existing",models:{local:{provider:"local",method:"openai-chat-completions",model_id:"fixture",base_url:provider.url}},agents:{existing}}));
  await installPackage({configPath,source:archive,alias:"native",dataHome:env.XDG_DATA_HOME});await addPackageAgent({configPath,name:"coder",from:"pkg/native/agents/coder",model:"local"});
  const config=JSON.parse(readFileSync(configPath,"utf8"));assert.equal(config.default_agent,"existing");assert.deepEqual(config.agents.existing,existing);
  const run=async(args:string[])=>{const child=spawn(process.execPath,[join(process.cwd(),"dist/raw.js"),"--config",configPath,"--agent","coder",...args],{cwd:root,env,stdio:["pipe","pipe","pipe"],windowsHide:true});let output="";child.stdout.on("data",b=>{output+=String(b);});child.stderr.on("data",b=>{output+=String(b);});child.stdin.end();const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});return {code,output};};
  const native=await run(["--goal","Ship installed fixture"]);assert.equal(native.code,0,native.output);assert.equal(provider.requests.length,3);
  const ordinary=await run(["Ordinary task"]);assert.equal(ordinary.code,0,ordinary.output);assert.equal(provider.requests.length,4);
  const store=openSessionStore({env});try{const goals=store.listSessions({}).items.map(s=>store.getGoalState(s.id).goal);assert.equal(goals.filter(g=>g?.status==="complete").length,1);assert.equal(goals.filter(g=>g===null).length,1);}finally{store.close();}
  const runtime=await loadConfig({configPath,flags:{agent:"coder"},env,cwd:root,requireModel:false});const tools=await createRuntimeTools({runtime,cwd:root,env});try{assert.equal(tools.registry.canonicalIdentity("goal"),"builtin/goal");}finally{await tools.mcp.close();}
  const exported=await exportAgentPackage({configPath,env,agentName:"coder",name:"@fixture/native-export",version:"1.0.0",out:join(root,"exported")});assert.ok(exported.report.requires.includes("raw.goal/1"));
  // Install the unchanged legacy tracker alongside it, then explicitly select both to exercise the diagnostic.
  await installPackage({configPath,source:join(process.cwd(),"examples/packages/coding-kit"),alias:"legacy",dataHome:env.XDG_DATA_HOME});
  config.agents.coder={model:"local",tools:{use:["builtin/goal","pkg/legacy/tools/goal"]}};writeFileSync(configPath,JSON.stringify(config));
  const conflict=await loadConfig({configPath,flags:{agent:"coder"},env,cwd:root,requireModel:false});await assert.rejects(createRuntimeTools({runtime:conflict,cwd:root,env}),/duplicate tool name: goal.*native.*legacy/i);
 }finally{if(previous===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=previous;await provider.close();rmSync(root,{recursive:true,force:true});}
});

test("AC-6 ordinary ACP prompts with native selected never activate or resume autonomy",async()=>{
 const root=mkdtempSync(join(tmpdir(),"raw-native-acp-")),configPath=join(root,"config.json"),env={...process.env,XDG_STATE_HOME:join(root,"state")};let requests=0;
 writeFileSync(configPath,JSON.stringify({default_agent:"native",models:{local:{provider:"local",method:"openai-chat-completions",model_id:"fixture",base_url:"http://127.0.0.1:9/v1"}},agents:{native:{model:"local",tools:{use:["builtin/goal"]},compact:{trigger_tokens:false}}}}));
 const runtime=await loadConfig({configPath,cwd:root,env,requireModel:true});
 const server=createAcpServer({runtime,storeOptions:{env},providerFactory:()=>({modelConfig:runtime.modelConfig!,generate:async()=>{requests++;return{text:"Ordinary final",toolCalls:[],finishReason:"stop"};}})});
 const connection=client({name:"native-opt-in-check"}).connect(server.app);
 try {await connection.agent.request("initialize",{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{}});const {sessionId}=await connection.agent.request("session/new",{cwd:root,mcpServers:[]});
 assert.equal((await connection.agent.request("session/prompt",{sessionId,prompt:[{type:"text",text:"Ordinary task"}]})).stopReason,"end_turn");assert.equal(requests,1);
 const store=openSessionStore({env});try{assert.equal(store.getGoalState(sessionId).goal,null);}finally{store.close();}
 }finally{connection.close();await server.close();rmSync(root,{recursive:true,force:true});}
});

test("AC-6 loading a paused native Goal through ordinary ACP does not resume it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"raw-native-acp-paused-")),configPath=join(root,"config.json"),env={...process.env,XDG_STATE_HOME:join(root,"state")};let requests=0;
 writeFileSync(configPath,JSON.stringify({default_agent:"native",models:{local:{provider:"local",method:"openai-chat-completions",model_id:"fixture",base_url:"http://127.0.0.1:9/v1"}},agents:{native:{model:"local",tools:{use:["builtin/goal"]},compact:{trigger_tokens:false}}}}));
 const store=openSessionStore({env});const session=store.createSession({cwd:root,title:"Paused native",agentName:"native",configPath});const service=new GoalService({store,sessionId:session.id});const started=service.start({objective:"Wait for explicit resume"},"start",0);const paused=service.pause("pause",started.revision);
 const runtime=await loadConfig({configPath,cwd:root,env,requireModel:true});const server=createAcpServer({runtime,storeOptions:{env},providerFactory:()=>({modelConfig:runtime.modelConfig!,generate:async()=>{requests++;return{text:"Ordinary final",toolCalls:[],finishReason:"stop"};}})});const connection=client({name:"native-paused-check"}).connect(server.app);
 try {await connection.agent.request("initialize",{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{}});await connection.agent.request("session/load",{sessionId:session.id,cwd:root,mcpServers:[]});assert.equal(requests,0);
 assert.equal((await connection.agent.request("session/prompt",{sessionId:session.id,prompt:[{type:"text",text:"Read status only"}]})).stopReason,"end_turn");assert.equal(requests,1);assert.deepEqual(store.getGoalState(session.id),{revision:paused.revision,goal:paused.goal});
 }finally{connection.close();await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});
