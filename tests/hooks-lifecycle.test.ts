import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { SelectedHook } from "../src/hooks/contract.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function setup(script: string) {
  const cwd = await mkdtemp(join(tmpdir(), "raw-hooks-life-"));
  const scriptPath = join(cwd, "hook.mjs");
  const log = join(cwd, "events.jsonl");
  await writeFile(scriptPath, script);
  const hook: SelectedHook = { protocol_version: 2, id: "agent/watch", name: "watch", folder: cwd, command: process.execPath,
    args: [scriptPath, log], timeoutMs: 1000, events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
      "PostToolUseFailure", "Stop", "SessionEnd"].map(name => ({ name: name as SelectedHook["events"][number]["name"] })) };
  const registry = new ToolRegistry();
  registry.register({ name: "doit", canonicalName: "agent/doit", description: "fixture",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    handler: async (args) => ({ isError: false, content: [{ type: "text", text: String(args.value) }] }) });
  return { cwd, hook, registry, log };
}

test("changing tool exposure binds hook conditions before publishing the new view", async () => {
  const f = await setup("");
  f.hook.events = [{ name: "PreToolUse", match: "acp:*", when: { source: "effects", any: "files[*].path", regex: ".*" } }];
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ({ text: "done", finishReason: "stop", toolCalls: [] }) };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, whitelist: ["doit"], hooks: new HookDispatcher([f.hook]) });
  f.registry.register({ name: "peer", canonicalName: "acp:write", description: "peer", inputSchema: { type: "object" },
    handler: async () => ({ isError: false, content: [] }) });
  assert.throws(() => agent.setToolView(["doit", "peer"]), /source effects is unavailable/);
  assert.deepEqual(agent.toolDefinitions.map(tool => tool.name), ["doit"]);
  const hook = await new HookDispatcher([f.hook]).run("PreToolUse", { cwd: f.cwd, agent_id: "raw", tool: { identity: "acp:write", name: "peer", arguments: {} } });
  assert.equal(hook.blocked, "error");
  await agent.close();
});

test("hook lifecycle receipts include successful empty-output hooks without changing model context", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      appendFileSync(process.argv[2], JSON.stringify(JSON.parse(input)) + "\\n");
    });`);
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const events: Array<{ type: string; outcome?: string }> = [];
  await agent.start("create", event => { if (event.type === "hook_event") events.push(event); });
  const result = await agent.run("do it", event => { if (event.type === "hook_event") events.push(event); });
  await agent.close();
  assert.equal(result.status, "completed");
  assert.deepEqual(events.map(e => e.outcome), ["continued", "continued", "continued", "continued", "continued"]);
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n").map(s => JSON.parse(s).event),
    ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]);
  assert.equal(agent.transcript.some(message => message.role === "tool" && message.result.content[0]?.type === "text"
    && message.result.content[0].text === "ok"), true);
});

test("PreToolUse denial skips approval and handler while preserving model linkage", async () => {
  const f = await setup(`let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
    if (JSON.parse(input).event === "PreToolUse") process.stdout.write(JSON.stringify({ decision:"deny", reason:"blocked" }));
  });`);
  let requests = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++requests === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "bad" } }] }
      : { text: "understood", finishReason: "stop", toolCalls: [] } };
  let approvals = 0;
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]),
    autoApprove: false, approve: () => { approvals++; return true; } });
  const result = await agent.run("do it");
  await agent.close();
  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(agent.transcript.find(message => message.role === "tool")?.result.code, "hook_denied");
});

test("notification failure does not change a completed tool result", async () => {
  const f = await setup(`let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
    if (JSON.parse(input).event === "PostToolUse") process.exitCode = 1;
  });`);
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const receipts: string[] = [];
  const result = await agent.run("do it", event => { if (event.type === "hook_event") receipts.push(`${event.event}:${event.outcome}`); });
  assert.equal(result.status, "completed");
  assert.equal(agent.transcript.find(message => message.role === "tool")?.result.isError, false);
  assert.ok(receipts.includes("PostToolUse:error"));
  await agent.close();
});

test("Stop and SessionEnd run after cancellation without an inherited aborted signal", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      appendFileSync(process.argv[2], JSON.parse(input).event + "\\n");
    });`);
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async request => new Promise((_resolve, reject) => {
      entered(); request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const events: string[] = [];
  const running = agent.run("wait", event => events.push(event.type));
  await ready;
  agent.abort();
  assert.equal((await running).status, "cancelled");
  await agent.close();
  assert.deepEqual((await readFile(f.log, "utf8")).trim().split("\n"),
    ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.equal(events.filter(event => event === "run_end").length, 1);
});

test("observing hooks get their own timeout_ms instead of a fixed two-second budget", async () => {
  const f = await setup(`import { appendFileSync } from "node:fs";
    let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      const event = JSON.parse(input).event;
      setTimeout(() => { appendFileSync(process.argv[2], event + "\\n"); }, event === "PostToolUse" ? 2300 : 0);
    });`);
  f.hook.timeoutMs = 10000;
  f.hook.events = [{ name: "PostToolUse" }];
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const outcomes: string[] = [];
  const result = await agent.run("do it", event => { if (event.type === "hook_event") outcomes.push(event.outcome); });
  await agent.close();
  assert.equal(result.status, "completed");
  assert.deepEqual(outcomes, ["continued"]);
  assert.equal((await readFile(f.log, "utf8")).trim(), "PostToolUse");
});

test("interrupting a run while an observing hook works cuts the hook to the cleanup window", async () => {
  const f = await setup(`let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { setTimeout(() => {}, 20000); });`);
  f.hook.timeoutMs = 30000;
  f.hook.events = [{ name: "PostToolUse" }];
  let calls = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ++calls === 1
      ? { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "ok" } }] }
      : { text: "done", finishReason: "stop", toolCalls: [] } };
  const agent = createAgent({ provider, registry: f.registry, cwd: f.cwd, hooks: new HookDispatcher([f.hook]) });
  const started = Date.now();
  const interrupt = setTimeout(() => agent.abort(), 500);
  const result = await agent.run("do it");
  clearTimeout(interrupt);
  await agent.close();
  assert.equal(result.status, "cancelled");
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started}ms`);
});

async function stopDispatcher(scripts: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "raw-hooks-stop-"));
  const hooks: SelectedHook[] = [];
  for (const [index, script] of scripts.entries()) {
    const path = join(cwd, `hook${index}.mjs`);
    await writeFile(path, `import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(join(cwd, "ran.log"))}, "${index}\\n");
      process.stdin.resume(); process.stdin.on("end", () => { ${script} });`);
    hooks.push({ protocol_version: 2, id: `agent/h${index}`, name: `h${index}`, folder: cwd, command: process.execPath,
      args: [path], timeoutMs: 20000, events: [{ name: "Stop" }] });
  }
  return { cwd, dispatcher: new HookDispatcher(hooks), ran: async () => (await readFile(join(cwd, "ran.log"), "utf8")).trim().split("\n") };
}
const deny = (reason?: string) => `process.stdout.write(${JSON.stringify(JSON.stringify({ decision: "deny", ...(reason !== undefined ? { reason } : {}) }))});`;

test("Stop hooks all run and their denials join into one continuation text", async () => {
  const f = await stopDispatcher([deny("A"), "", deny("B"), "process.exit(1);"]);
  const receipts: string[] = [];
  const result = await f.dispatcher.run("Stop", { cwd: f.cwd }, { onReceipt: (receipt) => receipts.push(receipt.outcome) });
  assert.deepEqual(await f.ran(), ["0", "1", "2", "3"]);
  assert.deepEqual(receipts, ["denied", "continued", "denied", "error"]);
  assert.deepEqual(result, { continueWith: "A\n\nB" });
});

test("a Stop run with no denial returns nothing, and a bare deny uses the default sentence", async () => {
  const none = await stopDispatcher(["", "process.exit(1);"]);
  assert.deepEqual(await none.dispatcher.run("Stop", { cwd: none.cwd }), {});
  const bare = await stopDispatcher([deny()]);
  assert.deepEqual(await bare.dispatcher.run("Stop", { cwd: bare.cwd }), { continueWith: "A Stop hook asked the run to continue." });
});

test("a joined Stop continuation over 4096 bytes is cut without splitting a character", async () => {
  const long = "é".repeat(500);
  const f = await stopDispatcher([deny(long), deny(long), deny(long), deny(long), deny(long)]);
  const { continueWith } = await f.dispatcher.run("Stop", { cwd: f.cwd });
  assert.ok(continueWith && continueWith.length > 0);
  assert.ok(Buffer.byteLength(continueWith) <= 4096);
  assert.ok(!continueWith.includes("�"));
});

// A Stop hook that logs its request and denies while `stop.continuations` is below `limit` ("inf" never stops denying).
async function continuing(limit: string, reason = "keep going", extra: { second?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "raw-hooks-continue-"));
  const log = join(cwd, "stop.jsonl");
  const path = join(cwd, "hook.mjs");
  await writeFile(path, `import { appendFileSync } from "node:fs";
    let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {
      const request = JSON.parse(input);
      if (request.event !== "Stop") return;
      appendFileSync(process.argv[2], JSON.stringify(request) + "\\n");
      const limit = process.argv[3] === "inf" ? Infinity : Number(process.argv[3]);
      if (process.argv[3] !== "none" && request.stop.continuations < limit)
        process.stdout.write(JSON.stringify({ decision: "deny", reason: process.argv[4] }));
    });`);
  const hooks: SelectedHook[] = [{ protocol_version: 2, id: "agent/continue", name: "continue", folder: cwd, command: process.execPath,
    args: [path, log, limit, reason], timeoutMs: 20000, events: [{ name: "Stop" }] }];
  if (extra.second) hooks.push({ ...hooks[0]!, id: "agent/observe", name: "observe", args: [path, join(cwd, "observe.jsonl"), "none", ""] });
  const stops = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { run: { status: string; text?: string }; stop: { hook_active: boolean; continuations: number; usage: { requests: number } } });
  return { cwd, hooks, stops, observed: async () => (await readFile(join(cwd, "observe.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length };
}

function recording(texts: Array<string | { text: string; truncated?: boolean }>, onCall?: (index: number) => Promise<void> | void) {
  const requests: Array<Array<{ role: string; content?: unknown }>> = [];
  const provider: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async (request) => {
      requests.push(structuredClone(request.messages) as never);
      await onCall?.(requests.length);
      const item = texts[requests.length - 1] ?? "end";
      const { text, truncated } = typeof item === "string" ? { text: item, truncated: false } : { truncated: false, ...item };
      return { text, finishReason: truncated ? "length" : "stop", toolCalls: [], ...(truncated ? { truncated: true } : {}) };
    } };
  const lastRoles = () => requests.map((messages) => messages.at(-1)?.role);
  const lastText = (index: number) => String(requests[index]!.at(-1)?.content);
  return { provider, requests, lastRoles, lastText };
}

async function runWith(hooks: SelectedHook[], cwd: string, provider: ProviderAdapter, options: { maxSteps?: number } = {}) {
  const agent = createAgent({ provider, registry: new ToolRegistry(), cwd, hooks: new HookDispatcher(hooks), ...options });
  const events: Array<{ type: string; result?: { status: string } }> = [];
  const result = await agent.run("go", (event) => { events.push(event as never); });
  await agent.close();
  return { result, events };
}

test("a denying Stop hook makes the agent ask again with a host user message, and sees how many times it did", async () => {
  for (const reason of ["keep going", "tiếp tục — ünï", "x"]) {
    const f = await continuing("2", reason);
    const model = recording(["a", "b", "c"]);
    const { result, events } = await runWith(f.hooks, f.cwd, model.provider);
    assert.equal(result.status, "completed");
    assert.equal(result.text, "c");
    assert.equal(model.requests.length, 3);
    assert.deepEqual(model.lastRoles(), ["user", "user", "user"]);
    assert.equal(model.lastText(1), `[Raw hook continuation] ${reason}`);
    assert.equal(model.lastText(2), `[Raw hook continuation] ${reason}`);
    const stops = await f.stops();
    assert.deepEqual(stops.map((stop) => stop.stop.continuations), [0, 1, 2]);
    assert.deepEqual(stops.map((stop) => stop.stop.hook_active), [false, true, true]);
    assert.deepEqual(stops.map((stop) => stop.stop.usage.requests), [1, 2, 3]);
    assert.equal(events.filter((event) => event.type === "run_end").length, 1);
  }
});

test("a Stop hook that never denies runs once per run and changes nothing", async () => {
  const f = await continuing("none");
  const model = recording(["only"]);
  const { result } = await runWith(f.hooks, f.cwd, model.provider);
  assert.deepEqual([result.status, result.text, model.requests.length], ["completed", "only", 1]);
  const stops = await f.stops();
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0]!.run, { status: "completed", steps: 1, text: "only" });
  assert.equal(stops[0]!.stop.continuations, 0);
});

test("with no step left a denying Stop hook ends the run max_steps, not completed, and Stop is not run again", async () => {
  const f = await continuing("inf");
  const model = recording(["a", "b", "c", "d"]);
  const { result } = await runWith(f.hooks, f.cwd, model.provider, { maxSteps: 3 });
  assert.equal(result.status, "max_steps");
  assert.equal(result.code, "max_steps");
  assert.match(result.message ?? "", /Stop hook asked the run to continue/);
  assert.equal(result.text, "c");
  assert.equal(model.requests.length, 3);
  assert.equal((await f.stops()).length, 3);
  assert.deepEqual(model.lastRoles(), ["user", "user", "user"]);
});

test("a denial is ignored when the run did not complete", async () => {
  const f = await continuing("inf");
  const failing: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => { throw new Error("provider down"); } };
  const { result } = await runWith(f.hooks, f.cwd, failing);
  assert.equal(result.status, "error");
  const stops = await f.stops();
  assert.deepEqual(stops.map((stop) => stop.run.status), ["error"]);
});

test("an interruption while a Stop hook runs leaves the run completed, with one Stop call and the denial ignored", async () => {
  const f = await continuing("inf");
  const cwd = f.cwd;
  const model = recording(["a", "b"]);
  const agent = createAgent({ provider: model.provider, registry: new ToolRegistry(), cwd, hooks: new HookDispatcher(f.hooks) });
  const result = await agent.run("go", (event) => { if (event.type === "hook_event") agent.abort(); });
  await agent.close();
  assert.equal(result.status, "completed");
  assert.equal(model.requests.length, 1);
  assert.equal((await f.stops()).length, 1);
});

test("a failing or silent Stop hook ends the run normally, and every Stop hook runs on each continuation", async () => {
  const f = await continuing("1", "again", { second: true });
  const model = recording(["a", "b"]);
  const { result } = await runWith(f.hooks, f.cwd, model.provider);
  assert.deepEqual([result.status, model.requests.length, await f.observed()], ["completed", 2, 2]);
  const broken = await stopDispatcher(["process.exit(1);"]);
  const quiet = recording(["x"]);
  const run = await runWith([...(broken.dispatcher.selected)], broken.cwd, quiet.provider);
  assert.deepEqual([run.result.status, quiet.requests.length], ["completed", 1]);
});

test("the output-limit budget restarts after a Stop continuation", async () => {
  const f = await continuing("1");
  const cut = (text: string) => ({ text, truncated: true });
  // Five cut answers before and five after the Stop continuation: a shared budget of eight would run out in the second half.
  const model = recording([cut("a"), cut("a"), cut("a"), cut("a"), cut("a"), "e1", cut("b"), cut("b"), cut("b"), cut("b"), cut("b"), "e2"]);
  const { result } = await runWith(f.hooks, f.cwd, model.provider);
  assert.equal(result.status, "completed");
  assert.equal(model.requests.length, 12);
  assert.equal(result.text, "bbbbbe2");
  assert.equal((await f.stops()).length, 2);
});

test("a denial is ignored for a cancelled run and for the tool-step limit, each with one Stop call", async () => {
  const cancelled = await continuing("inf");
  const agent = createAgent({ provider: recording(["a"], () => { agent.abort(); }).provider, registry: new ToolRegistry(), cwd: cancelled.cwd,
    hooks: new HookDispatcher(cancelled.hooks) });
  const first = await agent.run("go");
  await agent.close();
  assert.equal(first.status, "cancelled");
  assert.deepEqual((await cancelled.stops()).map((stop) => stop.run.status), ["cancelled"]);

  const limited = await continuing("inf");
  const toolCall: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "c", name: "doit", arguments: { value: "x" } }] }) };
  const { result } = await runWith(limited.hooks, limited.cwd, toolCall, { maxSteps: 1 });
  assert.equal(result.status, "max_steps");
  assert.match(result.message ?? "", /tool calls require another inference step/);
  assert.deepEqual((await limited.stops()).map((stop) => stop.run.status), ["max_steps"]);
});

test("a Stop continuation is stored and replayed when the session is resumed", async () => {
  const f = await continuing("1", "again please");
  const state = mkdtempSync(join(tmpdir(), "raw-stop-resume-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: state, XDG_CONFIG_HOME: state } });
  const id = store.createSession({ cwd: f.cwd, title: "resume" }).id;
  const first = recording(["a", "b"]);
  const make = (provider: ProviderAdapter, hooks: SelectedHook[] = []) => createAgent({ provider, registry: new ToolRegistry(), cwd: f.cwd,
    hooks: new HookDispatcher(hooks), persistence: { store, sessionId: id, surface: "cli" } });
  try {
    const agent = make(first.provider, f.hooks);
    assert.equal((await agent.run("go")).text, "b");
    await agent.close();
    const second = recording(["c"]);
    const resumed = make(second.provider);
    assert.deepEqual(resumed.transcript.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.equal((resumed.transcript[2] as { content: string }).content, "[Raw hook continuation] again please");
    assert.equal((await resumed.run("next")).text, "c");
    await resumed.close();
    assert.deepEqual(second.requests[0]!.map((message) => message.role), ["user", "assistant", "user", "assistant", "user"]);
    assert.equal(second.lastText(0), "next");
  } finally { store.close(); }
});

test("Stop runs again for the end of a run that fails after a Stop continuation", async () => {
  const f = await continuing("inf");
  let calls = 0;
  const flaky: ProviderAdapter = { modelConfig: { agentName: "raw", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async () => { if (++calls === 2) throw new Error("provider down"); return { text: "a", finishReason: "stop", toolCalls: [] }; } };
  const { result } = await runWith(f.hooks, f.cwd, flaky);
  assert.equal(result.status, "error");
  assert.deepEqual((await f.stops()).map((stop) => stop.run.status), ["completed", "error"]);
});

test("an exception from the completed-run Stop hooks ends the run as hook_event_error, with Stop not run again", async () => {
  let stops = 0;
  class Throwing extends HookDispatcher {
    override async run(event: Parameters<HookDispatcher["run"]>[0]) { if (event === "Stop") { stops++; throw new Error("receipt failed"); } return {}; }
  }
  const dispatcher = new Throwing([]);
  const model = recording(["a"]);
  const agent = createAgent({ provider: model.provider, registry: new ToolRegistry(), cwd: process.cwd(), hooks: dispatcher });
  const result = await agent.run("go");
  await agent.close();
  assert.deepEqual([result.status, result.code, stops, model.requests.length], ["error", "hook_event_error", 1, 1]);
});

test("a gate hook that denies with an empty reason still blocks, with the default reason", async () => {
  const f = await stopDispatcher([deny("")]);
  const hook = { ...f.dispatcher.selected[0]!, events: [{ name: "UserPromptSubmit" as const }] };
  assert.deepEqual(await new HookDispatcher([hook]).run("UserPromptSubmit", { cwd: f.cwd, input: "hi" }),
    { blocked: "denied", reason: "hook agent/h0 denied" });
});
