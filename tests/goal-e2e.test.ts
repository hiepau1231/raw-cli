import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { parse } from "yaml";
import { openAiFrame, openAiDone, startMockProvider, type MockResponse } from "./fixtures/mock-provider.js";
import { launch } from "./fixtures/platform.js";
import type { GoalSnapshot } from "../src/goals/contract.js";
const usage = `data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10,prompt_tokens_details:{cached_tokens:0}}})}\n\n`;
const final = (content: string): MockResponse => ({frames:[openAiFrame({content},"stop"),usage,openAiDone]});
const calls = (items: {id:string;name:string;args:unknown}[]):MockResponse => ({frames:[openAiFrame({tool_calls:items.map((item,index)=>({index,id:item.id,type:"function",function:{name:item.name,arguments:JSON.stringify(item.args)}}))},"tool_calls"),usage,openAiDone]});
const effect = {id:"sentinel-effect",name:"bash",args:{command:`node -e "require('node:fs').appendFileSync('sentinel','x')"`}};
const proof = {id:"proof",name:"goal",args:{action:"update",criteria:[{id:"criterion-1",status:"done",evidence:"sentinel acceptance checked"}]}};
const complete = {id:"complete",name:"goal",args:{action:"complete"}};
function running(bin:string,args:string[],cwd:string,env:NodeJS.ProcessEnv) {
 const [file,argv]=launch(bin,args);const child=spawn(file,argv,{cwd,env,stdio:["pipe","pipe","pipe"],windowsHide:true});let stdout="",stderr="";
 child.stdout.setEncoding("utf8").on("data",b=>{stdout+=b;});child.stderr.setEncoding("utf8").on("data",b=>{stderr+=b;});
 const done=new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});void done.catch(()=>{});
 return {child,done,stdout:()=>stdout,stderr:()=>stderr,output:()=>stdout+stderr};
}
async function command(bin:string,args:string[],cwd:string,env:NodeJS.ProcessEnv) {
 const run=running(bin,args,cwd,env);run.child.stdin.end();let timeout:ReturnType<typeof setTimeout>|undefined;
 try {const code=await Promise.race([run.done,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{run.child.kill("SIGKILL");reject(new Error(`${bin} timed out: ${run.output()}`));},600000);})]);assert.equal(code,0,`${bin} ${args.join(" ")}: ${run.output()}`);return run;}
 finally {clearTimeout(timeout);}
}
async function until(check:()=>boolean|Promise<boolean>,description:()=>string=()=>"barrier",timeout=15000) {
 const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw new Error(`Timed out: ${description()}`);await new Promise(resolve=>setTimeout(resolve,20));}
}
function assertComplete(goal:GoalSnapshot|undefined,requests:number) {
 assert.ok(goal);assert.equal(goal.status,"complete");assert.equal(goal.usage.requests,requests);assert.equal(goal.usage.inputCoverage,requests);assert.equal(goal.usage.outputCoverage,requests);
 assert.ok(goal.definition.criteria.some(c=>c.required));assert.ok(goal.definition.criteria.every(c=>!c.required||(c.status==="done"&&!!c.evidence?.trim())));
}
test("AC-7 installed CLI, crash recovery and installed browser qualify the native Goal lifecycle",{timeout:900000},async t=>{
 const repo=process.cwd(),root=await mkdtemp(join(tmpdir(),"raw-goal-installed-")),consumer=join(root,"consumer");const started=Date.now();
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("RAW_"))),XDG_CONFIG_HOME:join(root,"config"),XDG_DATA_HOME:join(root,"data"),XDG_STATE_HOME:join(root,"state")};
 try {
  await mkdir(consumer);await writeFile(join(consumer,"package.json"),'{"name":"goal-qualification-consumer","private":true,"type":"module"}\n');
  const packed=await command("npm",["pack","--ignore-scripts","--json","--pack-destination",root],repo,env);const tarball=join(root,JSON.parse(packed.stdout())[0].filename);
  const artifactSha256=createHash("sha256").update(await readFile(tarball)).digest("hex");
  await command("npm",["install","--omit=dev","--prefer-offline","--legacy-peer-deps","--ignore-scripts","--no-audit","--no-fund",tarball],consumer,env);
  const installed=join(consumer,"node_modules/@tlelabs/raw"),entry=join(installed,"dist/raw.js");assert.equal(existsSync(join(installed,"src")),false);assert.equal(existsSync(join(consumer,"node_modules/tsx")),false);assert.ok(existsSync(join(installed,"docs/goals.md")));
  const sdk=await import(pathToFileURL(join(installed,"dist/index.js")).href) as typeof import("../src/index.js");
  const state=()=>sdk.openSessionStore({env});
  const setup=async(name:string,url:string)=>{
   const workspace=join(root,name),configPath=join(workspace,"config.json"),author=join(workspace,"author"),archive=join(workspace,"native.rawpkg");await mkdir(workspace);await cp(join(installed,"examples/packages/native-goal-kit"),author,{recursive:true});
   await writeFile(configPath,JSON.stringify({default_agent:"existing",models:{local:{provider:"local",method:"openai-chat-completions",model_id:"fixture",base_url:url}},agents:{existing:{model:"local",tools:{use:[]}}}}));
   await command(process.execPath,[entry,"package","pack",author,"--out",archive],workspace,env);await rm(author,{recursive:true,force:true});
   await command(process.execPath,[entry,"package","install",archive,"--as","native","--config",configPath],workspace,env);await command(process.execPath,[entry,"agent","add","coder","--from","pkg/native/agents/coder","--model","local","--config",configPath],workspace,env);
   const document=JSON.parse(await readFile(configPath,"utf8"));document.agents.coder.overrides={compact:{trigger_tokens:false}};await writeFile(configPath,JSON.stringify(document));
   return {workspace,configPath,document};
  };
  await t.test("AC-7 installed explicit start continues across finals, commits sentinel once and completes with evidence",async()=>{
   const provider=await startMockProvider([final("First result"),final("Second result"),calls([effect,proof,complete])]);
   try {const f=await setup("start",provider.url);await command(process.execPath,[entry,"--config",f.configPath,"--agent","coder","--goal","Complete fixture acceptance","--goal-token-budget","100000"],f.workspace,env);
    assert.equal(provider.requests.length,3);assert.equal(await readFile(join(f.workspace,"sentinel"),"utf8"),"x");const store=state();try{const session=store.listSessions({cwd:f.workspace}).items[0]!;const goal=store.getGoalState(session.id).goal!;assertComplete(goal,3);const history=store.getSessionHistory({sessionId:session.id,limit:100}).items;assert.equal(history.filter(i=>i.kind==="goal_notice").length,2);t.diagnostic(JSON.stringify({flow:"start",goalId:goal.id,status:goal.status,usage:goal.usage,requests:provider.requests.length,sentinel:"x"}));}finally{store.close();}
   }finally{await provider.close();}
  });
  await t.test("AC-7 kill after committed sentinel reopens interrupted without inference and never replays the effect",async()=>{
   const provider=await startMockProvider([final("First result"),final("Second result"),calls([effect,proof]),calls([proof,complete])]);let first:ReturnType<typeof running>|undefined,inspector:ReturnType<typeof running>|undefined;
   let workspace:string|undefined;
   try {
    const f=await setup("recovery",provider.url);workspace=f.workspace;const hook=join(workspace,"hooks","barrier");await mkdir(hook,{recursive:true});
    await writeFile(join(hook,"hook.json"),JSON.stringify({protocol_version:2,name:"barrier",events:[{name:"PreToolUse",match:"builtin/goal"}],command:"node",args:["./barrier.mjs"],timeout_ms:30000}));
    await writeFile(join(hook,"barrier.mjs"),`import{existsSync,writeFileSync}from'node:fs';import{join}from'node:path';let input='';for await(const b of process.stdin)input+=b;const request=JSON.parse(input);if(request.tool?.arguments.action==='update'&&!existsSync(join(request.cwd,'release-hook'))){writeFileSync(join(request.cwd,'hook-ready'),JSON.stringify({sessionId:request.session_id,pid:process.pid}));while(!existsSync(join(request.cwd,'release-hook')))await new Promise(r=>setTimeout(r,20));}process.stdout.on('error',()=>process.exit(0));process.stdout.write('{}');`);
    f.document.agents.coder.overrides.hooks={use:["agent/barrier"]};await writeFile(f.configPath,JSON.stringify(f.document));
    first=running(process.execPath,[entry,"--config",f.configPath,"--agent","coder","--goal","Complete fixture acceptance","--goal-token-budget","100000"],workspace,env);first.child.stdin.end();
    await until(()=>existsSync(join(workspace!,"hook-ready")),()=>first!.output());const ready=JSON.parse(await readFile(join(workspace,"hook-ready"),"utf8"));const id=ready.sessionId as string;
    const store=state();let before:GoalSnapshot;
    try {before=store.getGoalState(id).goal!;assert.equal(before.status,"active");assert.equal(before.usage.requests,3);assert.equal(before.usage.inputCoverage,3);assert.equal(before.usage.outputCoverage,3);assert.equal(await readFile(join(workspace,"sentinel"),"utf8"),"x");assert.ok(store.getSessionHistory({sessionId:id,limit:100}).items.some(i=>i.kind==="tool_result"&&JSON.stringify(i.payload).includes("sentinel-effect")),"kill barrier must follow a committed sentinel tool result");}finally{store.close();}
    first.child.kill("SIGKILL");await first.done;await writeFile(join(workspace,"release-hook"),"cleanup hook");first=undefined;
    assert.equal(provider.requests.length,3);
    await until(()=>{const s=state();try{return !s.sessionIsBusy(id);}finally{s.close();}},()=>"dead process lease must expire without inference",20000);
    inspector=running(process.execPath,[entry,"--resume",id,"--interactive"],workspace,env);
    await until(()=>{const s=state();try{return s.getGoalState(id).goal?.status==="paused";}finally{s.close();}},()=>inspector!.output());
    const reopened=state();try{const g=reopened.getGoalState(id).goal!;assert.equal(g.reason,"interrupted");assert.equal(g.elapsedApproximate,true);assert.equal(g.usage.requests,before!.usage.requests);assert.equal(provider.requests.length,3);}finally{reopened.close();}
    inspector.child.stdin.end();assert.equal(await inspector.done,0,inspector.output());inspector=undefined;assert.equal(provider.requests.length,3);
    await command(process.execPath,[entry,"--config",f.configPath,"--resume",id,"--goal-resume"],workspace,env);assert.equal(provider.requests.length,4);assert.equal(await readFile(join(workspace,"sentinel"),"utf8"),"x");
    const resumed=state();try{const goal=resumed.getGoalState(id).goal!;assertComplete(goal,4);assert.equal(resumed.getSessionHistory({sessionId:id,limit:100}).items.filter(i=>i.kind==="tool_result"&&JSON.stringify(i.payload).includes("sentinel-effect")).length,1);t.diagnostic(JSON.stringify({flow:"recovery",status:goal.status,usage:goal.usage,requestsBeforeResume:3,requestsAfterResume:provider.requests.length,sentinel:"x",elapsedApproximate:goal.elapsedApproximate}));}finally{resumed.close();}
   }finally{if(workspace&&existsSync(workspace))await writeFile(join(workspace,"release-hook"),"cleanup");for(const run of[first,inspector])if(run){run.child.kill("SIGKILL");await run.done.catch(()=>{});}await provider.close();}
  });
  await t.test("AC-7 installed dashboard browser continues to verified canonical completion",async()=>{
   const provider=await startMockProvider([final("First browser result"),final("Second browser result"),calls([effect,proof,complete])]);let host:ReturnType<typeof running>|undefined;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
   try {
    const f=await setup("browser",provider.url);host=running(process.execPath,[entry,"dashboard","--config",f.configPath,"--port","0","--no-open"],f.workspace,env);host.child.stdin.end();
    await until(()=>!!host!.output().match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/),()=>host!.output());const launchUrl=host.output().match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/)![0],url=new URL(launchUrl),token=url.hash.slice("#token=".length);
    const post=async(path:string,body:unknown)=>{const response=await fetch(`${url.origin}/api${path}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});assert.equal(response.ok,true,await response.clone().text());return response.json();};
    const session=await post("/sessions",{cwd:f.workspace,agent:"coder"}) as {id:string};
    browser=await chromium.launch(process.env.RAW_TEST_CHROMIUM_EXECUTABLE?{executablePath:process.env.RAW_TEST_CHROMIUM_EXECUTABLE}:{});const page=await browser.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(launchUrl);await expect(page.getByRole("button",{name:"New chat",exact:true}).first()).toBeVisible();await page.goto(`${url.origin}/chat/${session.id}`);
    const goal=page.getByTestId("native-goal");await goal.getByRole("button",{name:"Start native Goal",exact:true}).click();await goal.getByRole("textbox",{name:"Goal objective",exact:true}).fill("Complete fixture acceptance");await goal.getByRole("button",{name:"Start Goal",exact:true}).click();
    await expect(page.getByTestId("goal-status")).toHaveText("complete");await goal.getByText("Criteria and evidence",{exact:true}).click();await expect(goal).toContainText("sentinel acceptance checked");await page.reload();await expect(page.getByTestId("goal-status")).toHaveText("complete");assert.deepEqual(errors,[]);assert.equal(provider.requests.length,3);assert.equal(await readFile(join(f.workspace,"sentinel"),"utf8"),"x");
    const store=state();try{const snapshot=store.getGoalState(session.id).goal!;assertComplete(snapshot,3);t.diagnostic(JSON.stringify({flow:"browser",browserVersion:browser.version(),status:snapshot.status,usage:snapshot.usage,sentinel:"x"}));}finally{store.close();}
   }finally{await browser?.close();if(host){host.child.kill("SIGTERM");await host.done;}await provider.close();}
  });
  t.diagnostic(JSON.stringify({artifactSha256,node:process.version,platform:process.platform,elapsedMs:Date.now()-started}));
 }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:500});}
});
test("AC-7 CI retains all OS/Node combinations and includes native Goal Chromium smoke",async()=>{
 const workflow=parse(await readFile(join(process.cwd(),".github/workflows/ci.yml"),"utf8"));assert.deepEqual(workflow.jobs.verify.strategy.matrix.os,["ubuntu-latest","macos-latest","windows-latest"]);assert.deepEqual(workflow.jobs.verify.strategy.matrix.node,["22.13.0","24"]);assert.ok(workflow.jobs.verify.steps.some((step:{run?:string})=>/playwright test.*tests\/dashboard-ui\/goal\.spec\.ts.*--project[= ]chromium/.test(step.run??"")),"native Goal Chromium smoke is required in CI");
});
