import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAgent, type RunEvent } from "../src/agent.js";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/llm/client.js";
import { acpUpdate, storedAcpUpdates } from "../src/sessions/display.js";
import { openSessionStore } from "../src/sessions/store.js";
import { projectToolCall, projectToolResult, renderPlainToolResult, statusLabel, type VisibleToolCall, type VisibleToolResult } from "../src/sessions/visible.js";
import { renderTerminalHistory } from "../src/terminal/history.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { formatToolResult, formatToolStart } from "../src/terminal/tools.js";
import { callSummary, callTitle, mcpDisplay, parseDisplay, renderTemplate } from "../src/tools/display.js";
import { connectMcpServers, parseMcpDisplay } from "../src/tools/mcp-client.js";
import { loadToolPlugins } from "../src/tools/plugins/loader.js";
import { parseToolManifest } from "../src/tools/plugins/manifest.js";
import type { ToolApprovalRequest } from "../src/tools/primitives.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";
import { bundledDisplay } from "./fixtures/display.js";
import { testConfig } from "./fixtures/config.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const ui = resolveUiOptions({ color: "never" });
const caps = terminalCapabilities(true, { TERM: "xterm" }, ui);
const MCP_ALIAS = "mcp_fixture_selected_" + (await import("node:crypto")).createHash("sha256").update("fixture\0selected").digest("hex").slice(0, 12);

test("1. summaries come from built-in hints, MCP annotations, config overrides and plugin templates", () => {
  // Built-in hints, over the normalized arguments.
  assert.equal(callSummary({ command: "npm test" }, bundledDisplay("bash")), "$ npm test");
  assert.equal(callTitle("bash", { command: "npm test", description: "Run the suite" }, bundledDisplay("bash")), "Run the suite");
  assert.equal(callTitle("bash", { command: "npm test" }, bundledDisplay("bash")), "Run command");
  assert.equal(callSummary({ path: "src/a.ts", offset: 10, limit: 20 }, bundledDisplay("read_file")), "src/a.ts:10 +20");
  assert.equal(callSummary({ path: "src/a.ts" }, bundledDisplay("read_file")), "src/a.ts");
  assert.equal(callSummary({ action: "stop", id: "p1" }, bundledDisplay("process")), "stop p1");
  const patch = projectToolCall("apply_patch", "builtin/apply_patch", { patch: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: b.txt\n@@\n-y\n+z\n*** End Patch" }, true, bundledDisplay("apply_patch"));
  assert.deepEqual([patch.title, patch.kind, patch.summary], ["Patch", "edit", "a.txt · b.txt"]);
  // The generic default: the first named value, then short key=value pairs.
  assert.equal(callSummary({ query: "x", limit: 5 }), "x · limit=5");
  assert.equal(callSummary({ limit: 5, term: "needle" }), "needle · limit=5");
  // Secret-looking names are masked wherever they appear.
  assert.equal(callSummary({ url: "https://x.test", api_key: "sk-123" }), "https://x.test · api_key=•••");
  assert.equal(renderTemplate("{token}", { token: "abc" }), "•••");
  assert.doesNotMatch(callSummary({ password: "hunter2", name: "db" }), /hunter2/);
  // One line, cut to 120 characters.
  const long = callSummary({ command: `echo ${"a".repeat(300)}\nsecond line` });
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(long, /\n/);
  // Templates: fallbacks and optional parts; a required placeholder without a value falls back to the default summary.
  assert.equal(renderTemplate("{a|none}[ ({b})]", {}), "none");
  assert.equal(renderTemplate("{a|none}[ ({b})]", { a: "x", b: "y" }), "x (y)");
  assert.equal(callSummary({ query: "q" }, { summary: "{url}" }), "q");
  // MCP annotations, then the config override field by field.
  assert.deepEqual(mcpDisplay({ title: "Search docs", readOnlyHint: true }), { title: "Search docs", kind: "read" });
  assert.deepEqual(mcpDisplay({ openWorldHint: true }), { kind: "fetch" });
  assert.deepEqual(mcpDisplay(undefined), { kind: "other" });
  assert.deepEqual(mcpDisplay({ title: "Search docs", readOnlyHint: true }, { kind: "search", summary: "{q}" }), { title: "Search docs", kind: "search", summary: "{q}" });
  assert.deepEqual(parseMcpDisplay({ lookup: { kind: "search" } }, "mcp.servers.docs.display"), { lookup: { kind: "search" } });
  assert.throws(() => parseMcpDisplay({ lookup: { kind: "browse" } }, "mcp.servers.docs.display"), /display\.kind must be one of/);
  // tool.json display is validated with the manifest.
  const manifest = (display: unknown) => ({ api_version: 2, id: "fetch_page", version: "1.0.0", name: "fetch_page", description: "Fetch",
    input_schema: { type: "object" }, entry: "./index.mjs", display });
  assert.deepEqual(parseToolManifest(manifest({ kind: "search", summary: "{url}" }), "agent/fetch_page", "fetch_page").display, { kind: "search", summary: "{url}" });
  assert.throws(() => parseToolManifest(manifest({ kind: "search", colour: "red" }), "agent/fetch_page", "fetch_page"), /unknown display field colour/);
  assert.throws(() => parseToolManifest(manifest({ result: "html" }), "agent/fetch_page", "fetch_page"), /display\.result/);
  assert.throws(() => parseDisplay({ icon: "../x" }, "x"), /icon/);
  // Package MCP tools (`pkg#mcp/…`) are MCP tools for icons and markdown detection, not just `mcp/…`.
  for (const identity of ["mcp/docs/lookup", "pkg/docs#mcp/docs/lookup"]) {
    const call = projectToolCall("lookup", identity, { query: "x" }, true, mcpDisplay({}));
    assert.match(formatToolStart(call, ui, caps, 80), /^↗ Lookup {2}x\n$/, identity);
    const result = projectToolResult("lookup", identity, { isError: false, content: [{ type: "text", text: "# Heading\n- item" }] });
    assert.equal(result.resultType, "markdown", identity);
  }
  assert.equal(projectToolResult("lookup", "local/lookup", { isError: false, content: [{ type: "text", text: "# Heading" }] }).resultType, "text");
});

test("2. result bodies: markdown versus text, pretty JSON, value-safe JSON and line-safe text", () => {
  const markdown = projectToolResult("fetch_page", "agent/fetch_page", { isError: false, content: [{ type: "text", text: "# Title\n\n- one\n- two" }] },
    5, { result: "markdown" });
  assert.equal(markdown.resultType, "markdown");
  assert.ok(markdown.segments.every((segment) => segment.kind === "markdown"));
  const rendered = formatToolResult(markdown, resolveUiOptions({ color: "never", density: "verbose" }), caps, 80);
  assert.doesNotMatch(rendered, /^ {2}# Title/m, "markdown is rendered, not printed raw");
  assert.match(rendered, /Title/);
  const text = projectToolResult("echo", "agent/echo", { isError: false, content: [{ type: "text", text: "# not a heading" }] });
  assert.equal(text.resultType, "text");
  assert.equal(text.segments[0]?.kind, "text");
  // Pretty JSON on the CLI and as a structured value in the record.
  const value = { results: [{ title: "hit", score: 1 }], total: 12 };
  const json = projectToolResult("search", "mcp/s/search", { isError: false, content: [{ type: "json", value }] });
  assert.equal(json.resultType, "json");
  assert.deepEqual(json.json, [value]);
  assert.equal(renderPlainToolResult(json), JSON.stringify(value, null, 2));
  assert.ok(json.segments.length > 1, "never a single minified line");
  // A large JSON value stays parseable: value-safe reduction, never a text cut.
  const large = { items: Array.from({ length: 2000 }, (_, index) => ({ index, label: `item ${index} ${"x".repeat(40)}` })), note: "y".repeat(10_000) };
  const reduced = projectToolResult("search", "mcp/s/search", { isError: false, content: [{ type: "json", value: large }] });
  assert.equal(reduced.abbreviated, true);
  const reparsed = JSON.parse(renderPlainToolResult(reduced)) as { items: unknown[]; note: string };
  assert.deepEqual(reparsed, reduced.json?.[0]);
  assert.ok(reparsed.items.length < 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(reparsed)) <= 1500);
  // Several JSON blocks: each preview parses on its own.
  const two = projectToolResult("search", "mcp/s/search", { isError: false, content: [{ type: "json", value: large }, { type: "json", value: [1, 2] }] });
  assert.equal(two.json?.length, 2);
  for (const item of two.json!) JSON.parse(JSON.stringify(item));
  // Long text keeps whole lines, head and tail; an overlong line ends in an ellipsis.
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index} ${"z".repeat(index === 1 ? 500 : 10)}`);
  const long = projectToolResult("bash", "builtin/bash", { isError: false, content: [{ type: "text", text: lines.join("\n") }] }, 1, bundledDisplay("bash"));
  assert.equal(long.resultType, "terminal");
  assert.equal(long.segments.length, 9);
  assert.equal(long.segments[0]?.text, lines[0]);
  assert.ok(long.segments[1]!.text.startsWith("line 1 ") && long.segments[1]!.text.endsWith("…") && [...long.segments[1]!.text].length === 220);
  assert.equal(long.segments[4]?.text, "… [42 lines hidden] …");
  assert.deepEqual(long.segments.slice(-4).map((segment) => segment.text), lines.slice(-4));
  assert.equal(long.abbreviated, true);
});

test("3. every result has exactly one status with its duration", () => {
  const cases: Array<[ToolResult, string]> = [
    [{ isError: false, content: [{ type: "text", text: "fine" }] }, "ok"],
    [{ isError: true, code: "tool_error", content: [{ type: "text", text: "broke" }] }, "error"],
    [{ isError: false, content: [{ type: "text", text: "[exit 2]" }], host: { exitCode: 2, status: "ok" } }, "exit 2"],
    [{ isError: true, code: "timeout", content: [{ type: "text", text: "slow" }], host: { status: "timeout" } }, "timed out"],
    [{ isError: true, code: "aborted", content: [{ type: "text", text: "stopped" }] }, "cancelled"],
    [{ isError: true, code: "interaction_cancelled", content: [{ type: "text", text: "User skipped the question" }] }, "cancelled"],
    [{ isError: true, code: "approval_denied", content: [{ type: "text", text: "approval denied for bash" }] }, "denied"],
    [{ isError: true, code: "hook_denied", content: [{ type: "text", text: "blocked" }] }, "denied"],
  ];
  for (const [result, label] of cases) {
    const projected = projectToolResult("bash", "builtin/bash", result, 42.4, bundledDisplay("bash"));
    assert.equal(statusLabel(projected), label);
    assert.equal(projected.durationMs, 42);
    assert.equal(projected.failed, label !== "ok");
    const header = formatToolResult(projected, ui, caps, 80).split("\n")[0]!;
    assert.match(header, new RegExp(`^[✓✗] ${label}( ·.*)? · 42ms$`), label);
    // Exactly one status word in the header.
    assert.equal(["ok", "error", "exit", "timed out", "cancelled", "denied"].filter((word) => header.includes(` ${word}`)).length, 1, header);
  }
  // Old records without a status still get one.
  const old = { name: "bash", failed: true, exitCode: 3, truncated: false, segments: [] } as unknown as VisibleToolResult;
  assert.equal(statusLabel(old), "exit 3");
  assert.match(formatToolResult(old, ui, caps, 80), /^✗ exit 3\n/);
});

test("4. CLI rendering for bash, edit, MCP and plugin tools", () => {
  const verbose = resolveUiOptions({ color: "never", density: "normal" });
  const bash = projectToolCall("bash", "builtin/bash", { command: "npm test", description: "Run the suite" }, true, bundledDisplay("bash"));
  assert.equal(formatToolStart(bash, verbose, caps, 100), "$ Run the suite  npm test\n");
  const output = projectToolResult("bash", "builtin/bash", { isError: false,
    content: [{ type: "text", channel: "stdout", text: "ok 1\nok 2" }, { type: "text", text: "[exit 0 · 0.3s]" }], host: { exitCode: 0, status: "ok" } }, 300, bundledDisplay("bash"));
  assert.equal(formatToolResult(output, verbose, caps, 100), "✓ ok · 300ms\n  [stdout]\n  ok 1\n  ok 2\n  [exit 0 · 0.3s]\n");
  const edit = projectToolCall("edit_file", "builtin/edit_file", { path: "src/app.ts", old_string: "a", new_string: "b" }, true, bundledDisplay("edit_file"));
  assert.equal(formatToolStart(edit, verbose, caps, 100), "✎ Edit  src/app.ts\n");
  const edited = projectToolResult("edit_file", "builtin/edit_file", { isError: false, content: [{ type: "text", text: "Edited src/app.ts" }],
    host: { files: [{ path: "src/app.ts", action: "edit", added: 3, removed: 1 }] } }, 12, bundledDisplay("edit_file"));
  assert.match(formatToolResult(edited, verbose, caps, 100), /^✓ ok · \+3 −1 · 12ms\n/);
  const mcp = projectToolCall(MCP_ALIAS, "mcp/fixture/selected", { value: "x" }, true, mcpDisplay({ title: "Fixture lookup", readOnlyHint: true }));
  assert.equal(formatToolStart(mcp, verbose, caps, 100), "↗ Fixture lookup  x\n");
  const plugin = projectToolCall("fetch_page", "agent/fetch_page", { url: "https://example.test/a" }, true,
    { title: "Fetch page", kind: "search", summary: "{url}", result: "markdown" });
  assert.equal(formatToolStart(plugin, verbose, caps, 100), "• Fetch page  https://example.test/a\n");
  // A call that never ran prints its full display arguments; file contents never appear.
  const rejected = projectToolCall("write_file", "builtin/write_file", { path: "a.txt", content: "secret-body" }, false, bundledDisplay("write_file"));
  const shown = formatToolStart(rejected, verbose, caps, 100);
  assert.equal(shown, "! ✎ Write  a.txt\n  {\"path\":\"a.txt\",\"content_bytes\":11}\n");
});

test("5. ACP kind and title come from the hints", () => {
  const display = projectToolCall("search_web", "agent/search_web", { query: "raw cli" }, false, { title: "Search the web", kind: "search", summary: "{query}" });
  const declared = acpUpdate({ type: "tool_call", id: "c1", name: "search_web", arguments: { query: "raw cli" }, display }) as Record<string, unknown>;
  assert.equal(declared.kind, "search");
  assert.equal(declared.title, "Search the web raw cli");
  const started = acpUpdate({ type: "tool_start", id: "c1", name: "search_web", arguments: { query: "raw cli" }, display: { ...display, started: true } }) as Record<string, unknown>;
  assert.equal(started.kind, "search");
  const plain = acpUpdate({ type: "tool_call", id: "c2", name: "other_tool", arguments: {} }) as Record<string, unknown>;
  assert.equal(plain.kind, "other");
  assert.equal(plain.title, "other_tool");
  // Stored canonical records replay with the same kind and title.
  const stored = storedAcpUpdates({ sessionId: "s", sequence: 1, createdAt: 1, kind: "tool_call", status: "complete", payload: { display: { ...display, id: "c1" } } });
  assert.equal((stored[0] as Record<string, unknown>).kind, "search");
  assert.equal((stored[0] as Record<string, unknown>).title, "Search the web raw cli");
});

test("6. hints from a loaded plugin and an MCP server reach events, CLI, stored records and ACP, and survive replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "raw-tool-display-")));
  const configPath = join(root, "agent", "raw.json");
  const folder = join(dirname(configPath), "tools", "fetch_page");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "fetch_page", version: "1.0.0", name: "fetch_page",
    description: "Fetch a page", entry: "./index.mjs",
    display: { title: "Fetch page", kind: "search", summary: "{url}", result: "markdown" },
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } }));
  await writeFile(join(folder, "index.mjs"), `export async function handler(args) {
    return { isError: false, content: [{ type: "text", text: "# Page\\n\\n- fetched " + args.url }] };
  }`);
  const plugins = await loadToolPlugins({ selectedIds: ["agent/fetch_page"], configPath, env: { XDG_CONFIG_HOME: join(root, "global") }, cwd: root });
  const registry = new ToolRegistry();
  for (const plugin of plugins) registry.register(plugin.registration);
  const connection = await connectMcpServers({ registry, cwd: process.cwd(), timeoutMs: 5000, servers: { fixture: {
    command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"],
    env: { MCP_LABEL: "fixture", MCP_COUNT: "2", MCP_ANNOTATE: "1" }, tools: ["selected"] } } });
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "page", type: "function", function: { name: "fetch_page", arguments: JSON.stringify({ url: "https://example.test/a" }) } },
      { index: 1, id: "lookup", type: "function", function: { name: MCP_ALIAS, arguments: JSON.stringify({ value: "x" }) } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "global") };
  const store = openSessionStore({ env });
  const expected = {
    page: { title: "Fetch page", kind: "search", summary: "https://example.test/a", result: "markdown", cli: "• Fetch page  https://example.test/a" },
    lookup: { title: "Fixture lookup", kind: "read", summary: "x", result: undefined, cli: "↗ Fixture lookup  x" },
  } as const;
  let sessionId = "";
  try {
    sessionId = store.createSession({ cwd: root, title: "display" }).id;
    const events: RunEvent[] = [];
    const agent = createAgent({ provider: createProvider({ agentName: "model", provider: "openai", method: "openai-chat-completions",
      model: "fixture", baseUrl: provider.url, apiKey: "key" }), registry, cwd: root, system: "system", autoApprove: true,
      persistence: { store, sessionId, surface: "cli" } });
    assert.equal((await agent.run("fetch", (event) => events.push(event))).status, "completed");
    await agent.close();
    for (const [id, want] of Object.entries(expected)) {
      const declared = events.find((event): event is Extract<RunEvent, { type: "tool_call" }> => event.type === "tool_call" && event.id === id)!;
      const started = events.find((event): event is Extract<RunEvent, { type: "tool_start" }> => event.type === "tool_start" && event.id === id)!;
      const finished = events.find((event): event is Extract<RunEvent, { type: "tool_result" }> => event.type === "tool_result" && event.id === id)!;
      for (const display of [declared.display!, started.display!]) {
        assert.deepEqual([display.title, display.kind, display.summary, display.result], [want.title, want.kind, want.summary, want.result], id);
      }
      assert.equal(finished.display?.kind, want.kind);
      if (want.result) assert.equal(finished.display?.resultType, want.result);
      // CLI from the live event.
      assert.equal(formatToolStart(started.display!, ui, caps, 120), `${want.cli}\n`);
      // ACP from the live events.
      for (const event of [declared, started]) {
        const update = acpUpdate(event) as Record<string, unknown>;
        assert.equal(update.kind, want.kind, id);
        assert.equal(update.title, `${want.title} ${want.summary}`, id);
      }
    }
    const page = events.find((event): event is Extract<RunEvent, { type: "tool_result" }> => event.type === "tool_result" && event.id === "page");
    assert.equal(page?.display?.segments[0]?.kind, "markdown");
  } finally { store.close(); await connection.close(); await provider.close(); }
  // Replay from a reopened store, with neither tool selected anywhere.
  const reopened = openSessionStore({ env });
  try {
    const items = reopened.getSessionHistory({ sessionId }).items;
    for (const [id, want] of Object.entries(expected)) {
      const call = items.find((item) => item.kind === "tool_call" && (item.payload.display as VisibleToolCall).id === id)!;
      const display = call.payload.display as VisibleToolCall;
      assert.deepEqual([display.title, display.kind, display.summary], [want.title, want.kind, want.summary], id);
      assert.equal(renderTerminalHistory(call, ui, caps, 120), `${want.cli}\n`);
      const acp = storedAcpUpdates(call)[0] as Record<string, unknown>;
      assert.deepEqual([acp.kind, acp.title], [want.kind, `${want.title} ${want.summary}`]);
      const result = items.find((item) => item.kind === "tool_result" && (item.payload.display as VisibleToolResult).id === id)!;
      assert.equal((result.payload.display as VisibleToolResult).kind, want.kind);
    }
  } finally { reopened.close(); }
});

test("approval requests carry the summary of the normalized arguments to the CLI prompt", async () => {
  const requests: ToolApprovalRequest[] = [];
  const registry = createTestToolRegistry([{ match: "builtin/bash", effect: "ask" }]);
  for (const args of [{ command: "npm test" }, { cmd: "npm test" }]) {
    const result = await registry.dispatch("bash", args, { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true,
      approve: (request) => { requests.push(request); return false; } });
    assert.equal(result.code, "approval_denied");
  }
  assert.deepEqual(requests.map((request) => [request.title, request.summary]), [["Run command", "$ npm test"], ["Run command", "$ npm test"]]);
  const renderer = new TerminalRenderer({} as never, { ui: resolveUiOptions({ color: "never" }) } as never, process.cwd(), false);
  for (const request of requests) assert.match(renderer.approvalPrompt(request), /^raw: allow Run command {2}\$ npm test\? \(bash \{"command":"npm test"\}\) \[y\/N\] $/);
  // edit_file through its loaded registration: the headline names the path, never the strings.
  const edit = new ToolRegistry([{ match: "builtin/edit_file", effect: "ask" }]);
  const [plugin] = await loadToolPlugins({ selectedIds: ["builtin/edit_file"], configPath: join(process.cwd(), "raw.json"), cwd: process.cwd() });
  edit.register(plugin!.registration);
  let headline = "";
  await edit.dispatch("edit_file", { file_path: "src/app.ts", old_str: "private-old", new_str: "private-new" }, { cwd: process.cwd(), maxOutputBytes: 8192,
    autoApprove: true, approve: (request) => { headline = `${request.title} ${request.summary}`; assert.doesNotMatch(headline, /private-/); return false; } });
  assert.equal(headline, "Edit src/app.ts");
});

test("ACP permission requests are titled with the call summary", async () => {
  const path = testConfig("ollama");
  const document = JSON.parse(await readFile(path, "utf8"));
  document.agents.fixture.tools = { use: ["builtin/bash", "builtin/edit_file"], rules: [{ match: "builtin/*", effect: "ask" }] };
  await writeFile(path, JSON.stringify(document));
  const runtime = await loadConfig({ configPath: path, env: {}, flags: {}, requireModel: true });
  const calls = [{ name: "bash", arguments: { command: "npm test" } }, { name: "bash", arguments: { cmd: "npm test" } },
    { name: "edit_file", arguments: { path: "src/app.ts", old_string: "a", new_string: "b" } }];
  let step = 0;
  const server = createAcpServer({ runtime, providerFactory: () => ({ modelConfig: runtime.modelConfig!, async generate() {
    const call = calls[step++];
    return call ? { text: "", toolCalls: [{ id: `call-${step}`, ...call }], finishReason: "tool_calls" } : { text: "done", toolCalls: [], finishReason: "stop" };
  } }) });
  const titles: string[] = [];
  const peer = client({ name: "display-client" });
  peer.onRequest("session/request_permission", (context) => {
    titles.push(String(context.params.toolCall.title));
    return { outcome: { outcome: "selected", optionId: "deny" } };
  });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request<{ sessionId: string }>("session/new", { cwd: process.cwd(), mcpServers: [] });
    const prompted = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    assert.deepEqual(prompted, { stopReason: "end_turn" }, JSON.stringify(prompted));
    assert.deepEqual(titles, ["Run command $ npm test", "Run command $ npm test", "Edit src/app.ts"]);
  } finally { connection.close(); await server.close(); }
});

test("old stored display records render through the generic path", () => {
  const record = (kind: string, display: Record<string, unknown>) => ({ sessionId: "s", sequence: 1, createdAt: 1, kind, status: "complete", payload: { display } });
  // Records written before display hints: no title, kind or summary; results with batch rows and minified JSON.
  const call = record("tool_call", { id: "old", name: "bash", identity: "builtin/bash", started: true, arguments: { command: "ls -la" } });
  const result = record("tool_result", { id: "old", name: "bash", identity: "builtin/bash", failed: false, truncated: false, exitCode: 0,
    rows: [{ index: 0, status: "ok", exitCode: 0 }], segments: [{ kind: "json", text: "{\"a\":1}" }] });
  assert.equal(renderTerminalHistory(call, ui, caps, 80), "• Bash  ls -la\n");
  assert.equal(renderTerminalHistory(result, ui, caps, 80), "✓ ok\n  {\"a\":1}\n");
  const [declared] = storedAcpUpdates(call) as Array<Record<string, unknown>>;
  assert.deepEqual([declared!.title, declared!.kind], ["bash", "other"]);
  const [finished] = storedAcpUpdates(result) as Array<Record<string, unknown>>;
  assert.equal((finished!.rawOutput as { status: string }).status, "ok");
  const failed = record("tool_result", { id: "old", name: "bash", failed: true, truncated: false, segments: [] });
  assert.equal(renderTerminalHistory(failed, ui, caps, 80), "✗ error\n");
});

test("review regressions: secrets, literal braces and newlines, CLI JSON, code hints, ACP status and history, unstarted durations", async () => {
  // Nested secrets in object values are masked; argument text is never read as template syntax; summaries stay one line.
  assert.equal(callSummary({ options: { api_key: "sk-private", limit: 5, nested: [{ token: "t" }] } }, { summary: "{options}" }),
    '{"api_key":"•••","limit":5,"nested":[{"token":"•••"}]}');
  assert.equal(callSummary({ query: "lookup {id}", id: "42" }, { summary: "[{query}]" }), "lookup {id}");
  assert.equal(callSummary({ query: "x [a]", id: "{query}" }, { summary: "{id}[ {query}]" }), "{query} x [a]");
  assert.doesNotMatch(callSummary({ query: "x" }, { summary: "Search\n{query}" }), /\n/);
  assert.doesNotMatch(callTitle("t", { query: "x" }, { title: "Line\none" }), /\n/);
  // The CLI prints JSON whole at every density that shows a body: each value parses.
  const value = { rows: Array.from({ length: 40 }, (_, index) => ({ a: index, label: `row ${index}` })) };
  const projected = projectToolResult("search", "mcp/s/search", { isError: false, content: [{ type: "text", text: "Found rows" }, { type: "json", value }] });
  for (const density of ["normal", "verbose"] as const) {
    const lines = formatToolResult(projected, resolveUiOptions({ color: "never", density }), caps, 200).trimEnd().split("\n");
    const start = lines.findIndex((line) => line === "  {" || line.startsWith("  \""));
    assert.ok(start > 0, density);
    const parsed = JSON.parse(lines.slice(start).map((line) => line.slice(2)).join("\n")) as unknown;
    assert.ok(parsed !== null, density);
    assert.ok(lines.length - start <= (density === "normal" ? 12 : 27), density);
  }
  assert.equal(formatToolResult(projected, resolveUiOptions({ color: "never", density: "compact" }), caps, 80), "✓ ok\n");
  // A code hint makes plain lines code, path-tagged when the result names a file.
  const code = projectToolResult("show", "agent/show", { isError: false, content: [{ type: "text", text: "const x = 1;\nlet y = 2;" }], host: { path: "src/a.ts" } },
    1, { result: "code" });
  assert.deepEqual(code.segments.map((segment) => [segment.kind, segment.path, segment.text]), [["code", "src/a.ts", "const x = 1;"], ["code", "src/a.ts", "let y = 2;"]]);
  assert.ok(projectToolResult("show", "agent/show", { isError: false, content: [{ type: "text", text: "print(1)" }] }, 1, { result: "code" })
    .segments.every((segment) => segment.kind === "code" && segment.path === undefined));
  // ACP: a nonzero exit fails live, as it does on replay.
  const exited: ToolResult = { isError: false, content: [{ type: "text", text: "[exit 2]" }], host: { exitCode: 2, status: "ok" } };
  assert.equal((acpUpdate({ type: "tool_result", id: "c", name: "bash", result: exited }) as Record<string, unknown>).status, "failed");
  const exitDisplay = projectToolResult("bash", "builtin/bash", exited, 3, bundledDisplay("bash"));
  assert.equal((acpUpdate({ type: "tool_result", id: "c", name: "bash", result: exited, display: exitDisplay }) as Record<string, unknown>).status, "failed");
  assert.equal((storedAcpUpdates({ sessionId: "s", sequence: 1, createdAt: 1, kind: "tool_result", status: "complete", payload: { display: { ...exitDisplay, id: "c" } } })[0] as Record<string, unknown>).status, "failed");
  // ACP-origin history keeps the heading, kind and projected result for the dashboard and the CLI.
  const { historyPresentation } = await import("../src/sessions/presentation.js");
  const { projectHistoryItem } = await import("../src/sessions/view.js");
  const acp = historyPresentation("acp");
  const call = projectToolCall("lookup", "mcp/docs/lookup", { query: "x" }, false, { title: "Search docs", kind: "search" });
  const [declared] = acp.declaration("c", "lookup", { query: "x" }, call);
  const declaredItem = { sessionId: "s", sequence: 1, createdAt: 1, kind: declared!.kind, status: "complete", payload: declared!.payload };
  // The declaration is printed by the start or the result; the dashboard gets its projection.
  assert.equal(renderTerminalHistory(declaredItem, ui, caps, 80), "");
  const view = projectHistoryItem(declaredItem).toolCall!;
  assert.deepEqual([view.title, view.kind, view.summary, view.identity], ["Search docs", "search", "x", "mcp/docs/lookup"]);
  // An ACP declaration from before projections were stored still renders from its update.
  assert.equal(renderTerminalHistory({ ...declaredItem, payload: { update: declared!.payload.update } }, ui, caps, 80), "• Search docs x\n");
  const resultDisplay = projectToolResult("lookup", "mcp/docs/lookup", { isError: false, content: [{ type: "text", text: "found" }] }, 12, { kind: "search" });
  const [stored] = acp.result({ type: "tool_result", id: "c", name: "lookup", result: { isError: false, content: [{ type: "text", text: "found" }] }, display: resultDisplay },
    true, call, { ...resultDisplay, id: "c" });
  const storedItem = { sessionId: "s", sequence: 2, createdAt: 1, kind: stored!.kind, status: "complete", payload: stored!.payload };
  assert.equal(projectHistoryItem(storedItem).toolResult?.durationMs, 12);
  assert.match(renderTerminalHistory(storedItem, ui, caps, 80), /^✓ ok · 12ms\n {2}found\n$/);
  assert.equal((storedAcpUpdates(storedItem)[0] as Record<string, unknown>).sessionUpdate, "tool_call_update");
  // A call refused before it starts still gets a duration, through a real Agent run.
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "deny", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] },
  ]);
  try {
    const events: RunEvent[] = [];
    const agent = createAgent({ provider: createProvider({ agentName: "model", provider: "openai", method: "openai-chat-completions", model: "fixture",
      baseUrl: provider.url, apiKey: "key" }), registry: createTestToolRegistry([{ match: "builtin/bash", effect: "ask" }]), cwd: process.cwd(),
      system: "system", autoApprove: true, approve: () => false });
    assert.equal((await agent.run("go", (event) => events.push(event))).status, "completed");
    await agent.close();
    const denied = events.find((event): event is Extract<RunEvent, { type: "tool_result" }> => event.type === "tool_result")!;
    assert.equal(denied.display?.status, "denied");
    assert.equal(typeof denied.display?.durationMs, "number");
  } finally { await provider.close(); }
});

test("review regressions: CLI JSON is never hard-wrapped and shares one line budget", () => {
  const long = projectToolResult("search", "mcp/s/search", { isError: false, content: [{ type: "json", value: { message: "x".repeat(200) } }] });
  const printed = formatToolResult(long, resolveUiOptions({ color: "never", density: "normal" }), caps, 80).trimEnd().split("\n").slice(1);
  assert.deepEqual(JSON.parse(printed.map((line) => line.slice(2)).join("\n")), { message: "x".repeat(200) });
  const many = projectToolResult("numbers", "mcp/s/numbers", { isError: false, content: Array.from({ length: 1000 }, (_, index) => ({ type: "json" as const, value: index })) });
  const lines = formatToolResult(many, resolveUiOptions({ color: "never", density: "normal" }), caps, 80).trimEnd().split("\n");
  assert.equal(lines.length, 1 + 12 + 1);
  assert.equal(lines.at(-1), "  … 988 more JSON values omitted");
  for (const line of lines.slice(1, -1)) JSON.parse(line.slice(2));
});

test("review regressions: ACP-origin history replays the normalized call, its identity and refused calls", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "raw-acp-history-")));
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "run", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "printf hi" }) } },
      { index: 1, id: "refused", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "rm -rf scratch" }) } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  const store = openSessionStore({ env });
  try {
    const sessionId = store.createSession({ cwd: root, title: "acp" }).id;
    const agent = createAgent({ provider: createProvider({ agentName: "model", provider: "openai", method: "openai-chat-completions", model: "fixture",
      baseUrl: provider.url, apiKey: "key" }), cwd: root, system: "system", autoApprove: true,
      registry: createTestToolRegistry([{ match: "builtin/bash", effect: "ask", when: { source: "arguments", any: "command", regex: "^rm\\b" } }]),
      approve: () => false, persistence: { store, sessionId, surface: "acp" } });
    assert.equal((await agent.run("go")).status, "completed");
    await agent.close();
    const items = store.getSessionHistory({ sessionId }).items;
    const printed = items.map((item) => renderTerminalHistory(item, ui, caps, 120)).join("");
    assert.equal((printed.match(/Run command/g) ?? []).length, 2, printed);
    assert.match(printed, /\$ Run command {2}printf hi\n✓ ok · \d+ms\n/);
    assert.match(printed, /! \$ Run command {2}rm -rf scratch\n {2}\{"command":"rm -rf scratch"\}\n✗ denied · approval_denied · \d+ms\n/);
    const { projectHistoryItem } = await import("../src/sessions/view.js");
    const calls = new Map<string, VisibleToolCall>();
    for (const item of items) { const view = projectHistoryItem(item); if (view.callId && view.toolCall) calls.set(view.callId, view.toolCall); }
    assert.deepEqual([calls.get("run")?.summary, calls.get("run")?.identity, calls.get("run")?.arguments], ["$ printf hi", "builtin/bash", { command: "printf hi" }]);
    assert.deepEqual([calls.get("refused")?.summary, calls.get("refused")?.started], ["$ rm -rf scratch", false]);
    // ACP replay still sends one tool_call per call.
    assert.equal(items.flatMap((item) => storedAcpUpdates(item)).filter((update) => update.sessionUpdate === "tool_call").length, 2);
  } finally { store.close(); await provider.close(); }
});

test("review regressions: a live call that never ran is shown from its normalized arguments", () => {
  const session = { toolIdentity: () => "builtin/bash", toolDisplay: () => bundledDisplay("bash") } as never;
  const renderer = new TerminalRenderer(session, { ui: resolveUiOptions({ color: "never" }) } as never, process.cwd(), false);
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    renderer.event({ type: "tool_call", id: "c", name: "bash", arguments: { cmd: "npm test", path: "unrelated.txt", description: "Run the suite" } });
    renderer.event({ type: "tool_result", id: "c", name: "bash", arguments: { command: "npm test", description: "Run the suite" },
      result: { isError: true, code: "approval_denied", content: [{ type: "text", text: "approval denied for bash" }] } });
  } finally { process.stderr.write = write; }
  const output = written.join("");
  assert.match(output, /^raw: ⚠ Run the suite {2}\$ npm test \(bash \{"command":"npm test","description":"Run the suite"\}\)\n/);
  assert.doesNotMatch(output, /unrelated|cmd=/);
});
