import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCliArgs } from "../src/config.js";
import { GoalService } from "../src/goals/service.js";
import { openSessionStore } from "../src/sessions/store.js";
import { startMockProvider, openAiDone, openAiFrame } from "./fixtures/mock-provider.js";
const pause = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(check: () => boolean, diagnostic: () => string = () => "condition not reached") {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error(diagnostic()); await pause(); }
}
function config(root: string, url: string, tools = ["builtin/goal"], rules: unknown[] = []) {
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ default_agent: "coder", models: { local: { provider: "local", method: "openai-chat-completions", model_id: "fixture", base_url: url } }, agents: { coder: { model: "local", compact: { trigger_tokens: false }, tools: { use: tools, rules } } } }));
  return path;
}
function raw(root: string, args: string[]) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), ...args], { cwd: root, env: { ...process.env, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = ""; child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; }); child.stderr.setEncoding("utf8").on("data", chunk => { output += chunk; });
  const done = new Promise<number | null>(resolve => child.once("exit", resolve));
  return { child, done, output: () => output };
}
const final = (content: string) => ({ frames: [openAiFrame({ content }, "stop"), openAiDone] });
const calls = (items: { id: string; name: string; arguments: unknown }[]) => ({ frames: [openAiFrame({ tool_calls: items.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }, "tool_calls"), openAiDone] });
test("AC-4 native flags validate before inference and sessions goal is passive", () => {
  assert.equal(parseCliArgs(["--goal", "Ship", "--goal-token-budget", "200"]).flags.goal, "Ship");
  assert.equal(parseCliArgs(["--resume", "id", "--goal-resume"]).flags.goalResume, true);
  assert.equal(parseCliArgs(["sessions", "goal", "id", "--json"]).command, "sessions-goal");
  for (const args of [["--goal-resume"], ["--goal", "Ship", "--goal-resume", "--resume", "id"], ["--goal-token-budget", "5"], ["--goal", ""], ["--goal", "Ship", "task"], ["--goal", "Ship", "--acp"], ["--goal", "Ship", "--goal-token-budget", "0"]]) assert.throws(() => parseCliArgs(args), /goal/i);
});
test("AC-4 spawned CLI pauses an actual in-flight inference before any next request", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-")); const provider = await startMockProvider([{ hold: true }, final("unexpected")]);
  const running = raw(root, ["--config", config(root, provider.url), "--goal", "Ship"]);
  try {
    await until(() => provider.requests.length === 1, running.output);
    running.child.stdin.write("/goal pause\n");
    assert.equal(await running.done, 4, running.output()); assert.equal(provider.requests.length, 1);
    const store = openSessionStore({ env: { XDG_STATE_HOME: root } });
    try { assert.equal(store.getGoalState(store.listSessions({}).items[0]!.id).goal?.status, "paused"); } finally { store.close(); }
  } finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});
test("AC-4 spawned CLI pauses a running real tool and does not infer again", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-tool-"));
  const script = `require('node:fs').writeFileSync('started','yes'); setTimeout(()=>require('node:fs').writeFileSync('finished','bad'),30000)`;
  const provider = await startMockProvider([calls([{ id: "slow", name: "bash", arguments: { command: `node -e "${script}"` } }]), final("unexpected")]);
  const running = raw(root, ["--config", config(root, provider.url, ["builtin/goal", "builtin/bash"]), "--goal", "Ship"]);
  try {
    await until(() => existsSync(join(root, "started")), running.output);
    running.child.stdin.write("/goal pause\n");
    assert.equal(await running.done, 4, running.output()); assert.equal(provider.requests.length, 1); assert.equal(existsSync(join(root, "finished")), false);
  } finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});
test("AC-4 pre-approval steering yes is queued, not tool consent", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-consent-")); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = await startMockProvider([{ ...calls([{ id: "danger", name: "write_file", arguments: { path: "forbidden", content: "bad" } }]), gate }]);
  const running = raw(root, ["--config", config(root, provider.url, ["builtin/goal", "builtin/write_file"], [{ match: "builtin/write_file", effect: "ask" }]), "--goal", "Ship"]);
  try {
    await until(() => provider.requests.length === 1, running.output); running.child.stdin.write("yes\n");
    await until(() => running.output().includes("queued"), running.output); release();
    assert.equal(await running.done, 1, running.output()); assert.equal(provider.requests.length, 1); assert.equal(existsSync(join(root, "forbidden")), false);
  } finally { release(); running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});
test("AC-4 one-shot EOF completes across finals and passive inspect launches no provider", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-complete-"));
  const provider = await startMockProvider([final("First"), final("Second"), calls([{ id: "proof", name: "goal", arguments: { action: "update", criteria: [{ id: "criterion-1", status: "done", evidence: "fixture output checked" }] } }, { id: "done", name: "goal", arguments: { action: "complete" } }])]);
  const running = raw(root, ["--config", config(root, provider.url), "--goal", "Ship"]); running.child.stdin.end();
  try {
    assert.equal(await running.done, 0, running.output()); assert.equal(provider.requests.length, 3);
    const store = openSessionStore({ env: { XDG_STATE_HOME: root } }); const id = store.listSessions({}).items[0]!.id; store.close();
    const inspect = raw(root, ["sessions", "goal", id, "--json"]); inspect.child.stdin.end();
    assert.equal(await inspect.done, 0, inspect.output()); assert.match(inspect.output(), /"status":"complete"/); assert.equal(provider.requests.length, 3);
  } finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ["edit Reframed", "abandon"]) test(`AC-4 live ${action} settles before host mutation`, { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-edit-")); const provider = await startMockProvider([{ hold: true }]);
  const running = raw(root, ["--config", config(root, provider.url), "--goal", "Ship"]);
  try {
    await until(() => provider.requests.length === 1, running.output); running.child.stdin.write(`/goal ${action}\n`);
    assert.equal(await running.done, action === "abandon" ? 130 : 4, running.output());
    const store = openSessionStore({ env: { XDG_STATE_HOME: root } });
    try {
      const goal = store.getGoalState(store.listSessions({}).items[0]!.id).goal!;
      assert.equal(goal.status, action === "abandon" ? "abandoned" : "paused"); assert.equal(goal.usage.requests, 1);
      if (action.startsWith("edit")) { assert.equal(goal.definition.objective, "Reframed"); assert.equal(goal.definition.criteria[0]?.status, "pending"); }
    } finally { store.close(); }
    assert.equal(provider.requests.length, 1);
  } finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});
test("AC-4 CLI explicit resume preserves request usage and does not submit a fake user turn", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-resume-"));
  const provider = await startMockProvider([final("First"), calls([{ id: "proof", name: "goal", arguments: { action: "update", criteria: [{ id: "criterion-1", status: "done", evidence: "result checked" }] } }, { id: "done", name: "goal", arguments: { action: "complete" } }])]);
  const first = raw(root, ["--config", config(root, provider.url), "--goal", "Ship", "--max-steps", "1"]); first.child.stdin.end();
  try {
    assert.equal(await first.done, 3, first.output());
    const store = openSessionStore({ env: { XDG_STATE_HOME: root } }); const id = store.listSessions({}).items[0]!.id;
    const service = new GoalService({ store, sessionId: id }); service.setBudget({ maxRequests: 3 }, "raise", service.state().revision); store.close();
    const second = raw(root, ["--resume", id, "--goal-resume", "--max-steps", "10"]); second.child.stdin.end();
    assert.equal(await second.done, 0, second.output()); assert.equal(provider.requests.length, 2);
    const messages = (provider.requests[1]!.body as { messages: { role: string }[] }).messages;
    assert.equal(messages.filter(m => m.role === "user").length, 1);
    const reopened = openSessionStore({ env: { XDG_STATE_HOME: root } });
    try { assert.equal(reopened.getGoalState(id).goal?.usage.requests, 2); assert.equal(reopened.getGoalState(id).goal?.status, "complete"); } finally { reopened.close(); }
  } finally { first.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});

test("AC-4 CLI opt-in selection diagnostic rejects before its first request", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-selection-")); const provider = await startMockProvider([final("unexpected")]);
  const running = raw(root, ["--config", config(root, provider.url, ["builtin/read_file"]), "--goal", "Ship"]); running.child.stdin.end();
  try { assert.equal(await running.done, 2, running.output()); assert.match(running.output(), /select builtin\/goal/); assert.equal(provider.requests.length, 0); }
  finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});

test("AC-4 rejected live resume leaves the original CLI control reader active", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-busy-")); const provider = await startMockProvider([{ hold: true }]);
  const running = raw(root, ["--config", config(root, provider.url), "--goal", "Ship"]);
  try {
    await until(() => provider.requests.length === 1, running.output); running.child.stdin.write("/goal resume\n");
    await until(() => running.output().includes("busy"), running.output); running.child.stdin.write("/goal pause\n");
    assert.equal(await running.done, 4, running.output()); assert.equal(provider.requests.length, 1);
  } finally { running.child.kill(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
});

test("AC-4 controls buffered during SessionStart stop before the first provider request", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-cli-startup-")); const provider = await startMockProvider([{ hold: true }]);
  const path = config(root, provider.url), folder = join(root, "hooks", "gate"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hook.json"), JSON.stringify({ protocol_version: 2, name: "gate", events: [{ name: "SessionStart" }], command: "node", args: ["./gate.mjs"], timeout_ms: 15000 }));
  writeFileSync(join(folder, "gate.mjs"), `import { existsSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; let input=''; for await(const b of process.stdin) input+=b; const {cwd}=JSON.parse(input); writeFileSync(join(cwd,'hook-ready'),'1'); await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(join(cwd,'release-hook'))){clearInterval(timer);resolve();}},10)}); process.stdout.write('{}');`);
  const document = JSON.parse(readFileSync(path, "utf8")); document.agents.coder.hooks = { use: ["agent/gate"] }; writeFileSync(path, JSON.stringify(document));
  const running = raw(root, ["--config", path, "--goal", "Ship"]);
  try {
    await until(() => existsSync(join(root, "hook-ready")), running.output); running.child.stdin.write("/goal pause\n");
    await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(provider.requests.length, 0); writeFileSync(join(root, "release-hook"), "1");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([running.done.finally(() => clearTimeout(timeout)), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`buffered pause ignored: ${running.output()}`)), 10000); })]);
    assert.equal(code, 4, running.output()); assert.equal(provider.requests.length, 0);
  } finally { running.child.kill(); await running.done; await provider.close(); rmSync(root, { recursive: true, force: true }); }
});

test("AC-4 native resume with explicit config preserves the saved agent instead of unrelated default",async()=>{
 const root=mkdtempSync(join(tmpdir(),"raw-goal-saved-agent-")),configPath=join(root,"config.json"),env={...process.env,XDG_STATE_HOME:root,XDG_CONFIG_HOME:root};
 const provider=await startMockProvider([{frames:[openAiFrame({tool_calls:[{index:0,id:"proof",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"update",criteria:[{id:"criterion-1",status:"done",evidence:"saved-agent result checked"}]})}},{index:1,id:"done",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"complete"})}}]},"tool_calls"),openAiDone]}]);
 try {
 writeFileSync(configPath,JSON.stringify({default_agent:"unrelated",models:{local:{provider:"local",method:"openai-chat-completions",model_id:"fixture",base_url:provider.url}},agents:{unrelated:{model:"local",tools:{use:[]}},coder:{model:"local",tools:{use:["builtin/goal"]},compact:{trigger_tokens:false}}}}));
 const store=openSessionStore({env}),session=store.createSession({cwd:root,title:"saved native",agentName:"coder",configPath}),service=new GoalService({store,sessionId:session.id});const started=service.start({objective:"Ship"},"start",0);service.pause("pause",started.revision);store.close();
 const child=spawn(process.execPath,[join(process.cwd(),"dist/raw.js"),"--config",configPath,"--resume",session.id,"--goal-resume"],{cwd:root,env,stdio:["pipe","pipe","pipe"],windowsHide:true});let output="";child.stdout.on("data",b=>{output+=String(b);});child.stderr.on("data",b=>{output+=String(b);});child.stdin.end();const code=await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});assert.equal(code,0,output);assert.equal(provider.requests.length,1);
 const reopened=openSessionStore({env});try{assert.equal(reopened.getGoalState(session.id).goal?.status,"complete");assert.equal(reopened.getSession(session.id)?.agentName,"coder");}finally{reopened.close();}
 }finally{await provider.close();rmSync(root,{recursive:true,force:true});}
});
