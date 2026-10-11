import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createAgent, type RunEvent } from "../src/agent.js";
import { acpUpdate, storedAcpUpdates } from "../src/sessions/display.js";
import type { ProviderAdapter, ProviderRequest } from "../src/llm/types.js";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { SelectedHook } from "../src/hooks/contract.js";
import { createProvider } from "../src/llm/client.js";
import type { ModelMessage } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { loadToolPlugins } from "../src/tools/plugins/loader.js";
import { ToolRegistry, type NormalizedArguments, type ToolPolicyRule, type ToolRegistration } from "../src/tools/registry.js";
import { capResult } from "../src/tools/results.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

/** A built-in-like reader: `file_path` is an alias of `path`, `timeout_s` an explicit seconds alias of `timeout`. */
function normalizeReader(input: Record<string, unknown>): NormalizedArguments {
  if (Array.isArray(input.files)) return { args: input, rejected: 'reader takes one path: {"path":"a.txt"}; call reader once per file' };
  const args = { ...input };
  const notes: string[] = [];
  if (args.path === undefined && typeof args.file_path === "string") { args.path = args.file_path; notes.push("read file_path as path"); }
  delete args.file_path;
  if (typeof args.timeout_s === "number" && args.timeout === undefined) { args.timeout = args.timeout_s * 1000; notes.push("read timeout_s as timeout"); }
  delete args.timeout_s;
  return { args, notes };
}

function reader(calls: Record<string, unknown>[], extra: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    name: "reader", canonicalName: "fixture/reader", description: "Read one path",
    inputSchema: { type: "object", properties: { path: { type: "string" }, timeout: { type: "integer" } }, required: ["path"], additionalProperties: false },
    normalizeArguments: normalizeReader, example: { path: "a.txt" }, renamedArguments: { files: "path" },
    handler: async (args) => {
      calls.push(structuredClone(args));
      return { isError: false, content: [{ type: "text", text: `read ${String(args.path)}` }],
        host: { summary: `Read ${String(args.path)}`, status: "ok", notes: ["from handler"] } };
    },
    ...extra,
  };
}

async function hookFixture(cwd: string): Promise<{ hook: SelectedHook; log: string }> {
  const script = join(cwd, "hook.mjs");
  const log = join(cwd, "hook.jsonl");
  await writeFile(script, `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], readFileSync(0, "utf8").trim() + "\\n");`);
  return { log, hook: { protocol_version: 2, id: "agent/watch", name: "watch", folder: cwd, command: process.execPath, args: [script, log],
    timeoutMs: 5000, events: [{ name: "PreToolUse" }, { name: "PostToolUse" }] } };
}

const call = (id: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [
  { index: 0, id, type: "function", function: { name: "reader", arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const done = { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] };

async function persistedRun(raw: Record<string, unknown>, rules: ToolPolicyRule[] = [], extra: Partial<ToolRegistration> = {},
  surface: "cli" | "acp" = "cli", expected = "completed") {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-tool-contracts-")));
  const store = openSessionStore({ env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd } });
  const sessionId = store.createSession({ cwd, title: "contracts" }).id;
  const fixture = await startMockProvider([call("c1", raw), done]);
  const calls: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  const registry = new ToolRegistry(rules);
  registry.register(reader(calls, extra));
  const { hook, log } = await hookFixture(cwd);
  const provider = createProvider({ agentName: "fixture", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "test" });
  const agent = createAgent({ cwd, provider, registry, system: "tiny", maxSteps: 4, maxOutputBytes: 8192, requestTimeoutMs: 5000,
    autoApprove: true, hooks: new HookDispatcher([hook]),
    approve: (request) => { approvals.push(structuredClone(request.arguments)); return true; },
    persistence: { store, sessionId, surface } });
  const events: RunEvent[] = [];
  try {
    const result = await agent.run("read it", (event) => events.push(structuredClone(event)));
    assert.equal(result.status, expected);
  } finally { await fixture.close(); }
  await agent.close();
  const hooks = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; tool: Record<string, unknown> });
  const owner = store.claimSession(sessionId);
  const context = store.readAgentState(sessionId, owner).messages;
  store.releaseSession(sessionId, owner);
  const history = store.getSessionHistory({ sessionId, limit: 100 }).items;
  return { fixture, calls, approvals, hooks, context, history, agent, events };
}

test("1: an aliased call reaches policy, hooks, approval and the handler canonical, while the stored call keeps the raw arguments", async () => {
  const raw = { file_path: "notes/secret.txt", timeout_s: 2 };
  const run = await persistedRun(raw, [{ match: "fixture/*", effect: "ask", when: { source: "arguments", any: "path", regex: "secret" } }]);
  const canonical = { path: "notes/secret.txt", timeout: 2000 };
  // The conditional ask rule on `path` matched a call that never named `path`, and approval saw the canonical form.
  assert.deepEqual(run.approvals, [canonical]);
  assert.deepEqual(run.calls, [canonical]);
  const pre = run.hooks.find((item) => item.event === "PreToolUse")!;
  assert.deepEqual(pre.tool.arguments, canonical);
  assert.deepEqual(pre.tool.raw_arguments, raw);
  // History and model context keep the call byte-for-byte as the model sent it.
  const assistant = run.context.find((message) => message.role === "assistant" && message.toolCalls.length) as Extract<ModelMessage, { role: "assistant" }>;
  assert.equal(JSON.stringify(assistant.toolCalls[0]!.arguments), JSON.stringify(raw));
  const tool = run.context.find((message) => message.role === "tool") as Extract<ModelMessage, { role: "tool" }>;
  assert.deepEqual(tool.arguments, canonical);
  // The replayed request sends the raw arguments string unchanged.
  assert.match(JSON.stringify(run.fixture.requests[1]!.body), new RegExp(JSON.stringify(JSON.stringify(raw)).slice(1, -1).replace(/[\\[\](){}.*+?^$|]/g, "\\$&")));
  // The display records show the canonical call.
  const display = run.history.filter((item) => item.kind === "tool_call").map((item) => (item.payload as { display: { arguments: unknown } }).display.arguments);
  assert.deepEqual(display.at(-1), canonical);
});

test("1b: normalization is pure and idempotent, and canonical calls are not reported as normalized", async () => {
  const once = normalizeReader({ file_path: "a", timeout_s: 1 });
  assert.deepEqual(normalizeReader(once.args).args, once.args);
  assert.deepEqual(normalizeReader(once.args).notes, []);
  const registry = new ToolRegistry();
  const calls: Record<string, unknown>[] = [];
  registry.register(reader(calls));
  const seen: unknown[] = [];
  await registry.dispatch("reader", { path: "a" }, { cwd: tmpdir(), maxOutputBytes: 4096, onNormalized: (args) => seen.push(args) });
  assert.equal(seen.length, 0);
  await registry.dispatch("reader", { file_path: "b" }, { cwd: tmpdir(), maxOutputBytes: 4096, onNormalized: (args) => seen.push(args) });
  assert.deepEqual(seen, [{ path: "b" }]);
});

test("2: unknown extra arguments are ignored with a note to the model; missing or non-alias shapes are rejected with an example", async () => {
  const registry = new ToolRegistry();
  const calls: Record<string, unknown>[] = [];
  registry.register(reader(calls));
  const context = { cwd: tmpdir(), maxOutputBytes: 4096 };
  const ran = await registry.dispatch("reader", { path: "a.txt", bogus: 1, encoding: "utf8" }, context);
  assert.equal(ran.isError, false);
  assert.deepEqual(calls, [{ path: "a.txt" }]);
  const text = ran.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  assert.match(text, /^read a\.txt\n\[ignored unknown argument: bogus\]\n\[ignored unknown argument: encoding\]$/);
  // Alias notes are host data, never model text.
  assert.doesNotMatch(text, /file_path/);
  const aliased = await registry.dispatch("reader", { file_path: "b.txt" }, context);
  assert.deepEqual(aliased.host?.notes, ["from handler", "read file_path as path"]);
  assert.doesNotMatch(JSON.stringify(aliased.content), /read file_path as path/);

  const missing = await registry.dispatch("reader", { timeout: 5 }, context);
  assert.equal(missing.code, "invalid_arguments");
  assert.match(missing.content[0]!.type === "text" ? missing.content[0]!.text : "", /; example: \{"path":"a\.txt"\}$/);
  const batch = await registry.dispatch("reader", { files: [{ path: "a" }] }, context);
  assert.equal(batch.code, "invalid_arguments");
  assert.match(batch.content[0]!.type === "text" ? batch.content[0]!.text : "", /reader takes one path: \{"path":"a\.txt"\}/);
  assert.equal(calls.length, 2);
});

test("3: host data is persisted in model context and history, given to hooks, and never sent to a provider", async () => {
  const run = await persistedRun({ path: "host-marker-file" });
  const tool = run.context.find((message) => message.role === "tool") as Extract<ModelMessage, { role: "tool" }>;
  assert.deepEqual(tool.result.host, { summary: "Read host-marker-file", status: "ok", notes: ["from handler"] });
  const result = run.history.find((item) => item.kind === "tool_result")!;
  assert.deepEqual((result.payload as { display: { host?: unknown } }).display.host, tool.result.host);
  const post = run.hooks.find((item) => item.event === "PostToolUse")!;
  assert.deepEqual((post.tool.result as { host?: unknown }).host, tool.result.host);
  assert.equal(post.tool.raw_arguments, undefined);
  // The provider request after the tool call carries the text result but none of the host facts.
  const wire = JSON.stringify(run.fixture.requests[1]!.body);
  assert.match(wire, /read host-marker-file/);
  assert.doesNotMatch(wire, /Read host-marker-file|from handler|"host"/);
});

test("4: an oversized JSON result stays valid JSON for the model, with the whole value saved", async () => {
  const value = { title: "x".repeat(5000), items: Array.from({ length: 500 }, (_, index) => ({ index, name: `item-${index}` })) };
  const capped = capResult({ isError: false, content: [{ type: "json", value }] }, 2048);
  assert.equal(capped.truncated, true);
  const json = capped.content.find((block) => block.type === "json");
  assert.ok(json && json.type === "json");
  const text = JSON.stringify(json.value);
  assert.ok(Buffer.byteLength(text) <= 2048);
  const parsed = JSON.parse(text) as { title: string; items: unknown[] };
  assert.match(String(parsed.items.at(-1)), /^… \d+ more items$/);
  assert.match(parsed.title, /characters omitted/);
  const total = capped.content.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : block.type === "json" ? Buffer.byteLength(JSON.stringify(block.value)) : 0), 0);
  assert.ok(total <= 2048, `capped output ${total} bytes`);
  assert.ok(capped.fullOutputPath);
  assert.deepEqual(JSON.parse(await readFile(capped.fullOutputPath!, "utf8")), value);
  assert.match(capped.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""), new RegExp(capped.fullOutputPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Values of different sizes and shapes are reduced the same way, never cut as text.
  for (const [sample, limit] of [[Array.from({ length: 3000 }, (_, index) => index), 1200], [{ deep: { list: ["y".repeat(9000)] } }, 1000],
    [Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index])), 1500]] as const) {
    const reduced = capResult({ isError: false, content: [{ type: "json", value: sample }] }, limit);
    const block = reduced.content.find((item) => item.type === "json");
    assert.ok(block && block.type === "json");
    assert.ok(Buffer.byteLength(JSON.stringify(block.value)) <= limit);
    JSON.parse(JSON.stringify(block.value));
  }
});

test("5: a rule or hook on a replaced batch path fails to bind with the specific message", () => {
  const rule: ToolPolicyRule = { match: "fixture/reader", effect: "ask", when: { source: "arguments", any: "files[*].path", regex: "secret" } };
  assert.throws(() => new ToolRegistry([rule]).register(reader([])),
    /^Error: rule path files\[\*\]\.path does not exist in fixture\/reader; the argument is now path$/);
  const registry = new ToolRegistry();
  registry.register(reader([]));
  const hooks = new HookDispatcher([{ protocol_version: 2, id: "agent/guard", name: "guard", folder: tmpdir(), command: "true", args: [], timeoutMs: 1000,
    events: [{ name: "PreToolUse", match: "fixture/*", when: { source: "arguments", any: "files[*].path", regex: "x" } }] }]);
  assert.throws(() => hooks.validateTools(registry, ["reader"]), /rule path files\[\*\]\.path does not exist in fixture\/reader; the argument is now path/);
  // A path that never existed keeps the generic message, and the current path binds.
  assert.throws(() => new ToolRegistry([{ ...rule, when: { source: "arguments", any: "other", regex: "x" } }]).register(reader([])), /does not resolve to a string/);
  new ToolRegistry([{ ...rule, when: { source: "arguments", any: "path", regex: "x" } }]).register(reader([]));
});

test("6: the loader never forwards a normalizer from a local tool", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "raw-contracts-loader-")));
  const configPath = join(root, "agent", "raw.json");
  const folder = join(dirname(configPath), "tools", "local_reader");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "local_reader", version: "1.0.0", name: "local_reader",
    description: "fixture", entry: "./index.mjs", input_schema: { type: "object", properties: { path: { type: "string" }, file_path: { type: "string" } } } }));
  await writeFile(join(folder, "index.mjs"), `export async function handler(args) { return { isError: false, content: [{ type: "json", value: args }] }; }
export function normalizeArguments(args) { return { args: { path: args.file_path } }; }
export const example = { path: "a" };
export const renamedArguments = { files: "path" };`);
  const [tool] = await loadToolPlugins({ selectedIds: ["agent/local_reader"], configPath, cwd: root, env: { XDG_CONFIG_HOME: join(root, "xdg") } });
  assert.equal(tool!.registration.normalizeArguments, undefined);
  assert.equal(tool!.registration.example, undefined);
  assert.equal(tool!.registration.renamedArguments, undefined);
  const registry = new ToolRegistry();
  registry.register(tool!.registration);
  const result = await registry.dispatch("local_reader", { file_path: "x.txt" }, { cwd: root, maxOutputBytes: 4096 });
  assert.deepEqual(result.content, [{ type: "json", value: { file_path: "x.txt" } }]);
});

test("7: execution-level capping records its saved copy in host data", async () => {
  const text = capResult({ isError: false, content: [{ type: "text", text: "line\n".repeat(4000) }], host: { summary: "kept" } }, 1024);
  assert.ok(text.fullOutputPath);
  assert.deepEqual(text.host, { summary: "kept", fullOutputPath: text.fullOutputPath });
  const json = capResult({ isError: false, content: [{ type: "json", value: { rows: Array.from({ length: 900 }, (_, index) => index) } }] }, 512);
  assert.equal(json.host?.fullOutputPath, json.fullOutputPath);
  // A result that fits gets no host data it did not have.
  assert.equal(capResult({ isError: false, content: [{ type: "text", text: "small" }] }, 1024).host, undefined);
});

test("8: provider adapters receive tool messages without host data or normalized arguments", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-contracts-adapter-")));
  const requests: Pick<ProviderRequest, "messages">[] = [];
  let turn = 0;
  const provider: ProviderAdapter = { modelConfig: { agentName: "fake", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
    generate: async (request) => {
      requests.push({ messages: structuredClone(request.messages) });
      return turn++ === 0 ? { text: "", toolCalls: [{ id: "c1", name: "reader", arguments: { file_path: "host-a" } }], finishReason: "tool_calls" }
        : { text: "done", toolCalls: [], finishReason: "stop" };
    } };
  const registry = new ToolRegistry();
  registry.register(reader([]));
  const agent = createAgent({ cwd, provider, registry, system: "tiny", maxSteps: 4, maxOutputBytes: 8192, requestTimeoutMs: 5000, autoApprove: true });
  const outcome = await agent.run("go");
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const stored = agent.transcript.find((message) => message.role === "tool") as Extract<ModelMessage, { role: "tool" }>;
  assert.ok(stored.result.host && stored.arguments);
  const sent = requests[1]!.messages.find((message) => message.role === "tool") as Extract<ModelMessage, { role: "tool" }>;
  assert.equal("host" in sent.result, false);
  assert.equal("arguments" in sent, false);
  assert.deepEqual(sent.result.content, stored.result.content);
});

test("9: small budgets keep a valid JSON value, and full-sized results keep the ignored-argument note", async () => {
  for (const limit of [64, 128, 256, 400]) {
    const capped = capResult({ isError: false, content: [{ type: "json", value: { rows: Array.from({ length: 300 }, (_, index) => `row ${index}`) } }] }, limit);
    const block = capped.content.find((item) => item.type === "json");
    assert.ok(block && block.type === "json", `no JSON at ${limit} bytes`);
    JSON.parse(JSON.stringify(block.value));
    const total = capped.content.reduce((sum, item) => sum + (item.type === "text" ? Buffer.byteLength(item.text) : item.type === "json" ? Buffer.byteLength(JSON.stringify(item.value)) : 0), 0);
    assert.ok(total <= limit, `${total} > ${limit}`);
  }
  for (const size of [1024, 5000]) {
    const registry = new ToolRegistry();
    registry.register(reader([], { handler: async () => ({ isError: false, content: [{ type: "text", text: "z".repeat(size) }] }) }));
    const result = await registry.dispatch("reader", { path: "a", bogus: true }, { cwd: tmpdir(), maxOutputBytes: 1024 });
    const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    assert.match(text, /\[ignored unknown argument: bogus\]$/);
    assert.ok(Buffer.byteLength(text) <= 1024, `${Buffer.byteLength(text)} bytes`);
  }
});

test("10: ACP updates show the canonical arguments, live and replayed, including calls rejected before they run", async () => {
  const run = await persistedRun({ file_path: "acp.txt", timeout_s: 1 }, [], {}, "acp");
  const canonical = { path: "acp.txt", timeout: 1000 };
  const start = run.events.find((event) => event.type === "tool_start")!;
  assert.deepEqual((acpUpdate(start) as { rawInput?: unknown }).rawInput, canonical);
  const result = run.events.find((event) => event.type === "tool_result")!;
  assert.deepEqual((acpUpdate(result) as { rawInput?: unknown }).rawInput, canonical);
  const replayed = run.history.flatMap(storedAcpUpdates).filter((update) => update.sessionUpdate === "tool_call_update");
  assert.ok(replayed.some((update) => JSON.stringify((update as { rawInput?: unknown }).rawInput) === JSON.stringify(canonical)));

  // A call that fails validation after normalization never starts, yet its result update still names the canonical form.
  const rejected = await persistedRun({ file_path: "bad.txt", timeout: "soon" }, [], {}, "acp");
  assert.equal(rejected.events.some((event) => event.type === "tool_start"), false);
  const failed = rejected.events.find((event) => event.type === "tool_result")!;
  assert.deepEqual((acpUpdate(failed) as { rawInput?: unknown }).rawInput, { path: "bad.txt", timeout: "soon" });
  assert.equal(rejected.calls.length, 0);
});
