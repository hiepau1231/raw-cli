import assert from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { delegate } from "../src/tools/bundled/bash/index.js";
import { createAgent, type RunEvent } from "../src/agent.js";
import { HookDispatcher } from "../src/hooks/dispatcher.js";
import type { HookEventName, SelectedHook } from "../src/hooks/contract.js";
import { createProvider } from "../src/llm/client.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { openSessionStore } from "../src/sessions/store.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import type { ToolContext } from "../src/tools/primitives.js";
import { ToolRegistry, type ToolPolicyRule } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { processesWithMarker, waitForNoMarked } from "./fixtures/windows-processes.js";
import { resolveBash } from "../src/tools/shells.js";
import { runBash } from "../src/tools/process.js";

/** How a stopped bash call ends: Windows stops the whole job, elsewhere the process group. */
const STOPPED = process.platform === "win32" ? "process tree stopped" : "process group stopped";

const BACKGROUND_NOTE = "[ignored run_in_background: background jobs need the process tool; ran in the foreground]";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test 8: every registry here is built from the production loader, never from the module imported directly. */
async function registry(names: string[], rules: ToolPolicyRule[] = []): Promise<ToolRegistry> {
  const tools = new ToolRegistry(rules);
  for (const tool of await loadBundledTools(names)) tools.register(tool);
  return tools;
}

const text = (result: ToolResult) => result.content.map((block) => block.type === "text" ? block.text : "").join("");
const workdir = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

async function groupGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(-pid, 0); } catch { return true; }
    await sleep(50);
  }
  return false;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting");
    await sleep(25);
  }
}

/** A hook that logs every input and, in `always` mode, blocks; in `flag` mode it blocks a call whose arguments set run_in_background. */
async function hook(cwd: string, match: string, mode: "watch" | "always" | "flag"): Promise<{ hook: SelectedHook; log: string }> {
  const script = join(cwd, `hook-${mode}.mjs`);
  const log = join(cwd, `hook-${mode}.jsonl`);
  await writeFile(script, `import { appendFileSync, readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(process.argv[2], JSON.stringify(input) + "\\n");
const mode = process.argv[3];
if (input.event === "PreToolUse" && (mode === "always" || (mode === "flag" && input.tool.arguments.run_in_background === true)))
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "blocked by test" }));`);
  const events = mode === "watch" ? [{ name: "PreToolUse" as const, match }, { name: "PostToolUse" as const, match }] : [{ name: "PreToolUse" as const, match }];
  return { log, hook: { protocol_version: 2, id: `agent/${mode}`, name: mode, folder: cwd, command: process.execPath, args: [script, log, mode],
    timeoutMs: 5000, events } };
}

function hookContext(hooks: HookDispatcher, cwd: string): Pick<ToolContext, "onHook"> {
  return { onHook: (event: HookEventName, identity, name, args, result, effects, raw) => hooks.run(event, { cwd, agent_id: "test",
    tool: { identity, name, arguments: args, ...(raw ? { raw_arguments: raw } : {}), ...(effects ? { effects } : {}), ...(result ? { result } : {}) } }) };
}

test("1: one command returns stdout and stderr in production order, then the status line, with host data", async () => {
  const cwd = await workdir("raw-bash-canonical-");
  const tools = await registry(["bash"]);
  const result = await tools.dispatch("bash", { command: "printf one; sleep 0.1; printf two >&2; sleep 0.1; printf three", description: "Count to three" },
    { cwd, maxOutputBytes: 8192 });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.slice(0, 3).map((block) => block.type === "text" ? [block.channel, block.text] : []),
    [["stdout", "one"], ["stderr", "two"], ["stdout", "three"]]);
  assert.match(text(result), /^onetwothree\n?\[exit 0 · \d+\.\ds\]$/);
  assert.equal(result.host?.exitCode, 0);
  assert.equal(result.host?.status, "ok");
  assert.equal(result.host?.summary, "printf one; sleep 0.1; printf two >&2; sleep 0.1; printf three");
  assert.equal(result.host?.description, "Count to three");
  assert.equal(typeof result.host?.durationMs, "number");
  const echo = await tools.dispatch("bash", { command: "echo hi" }, { cwd, maxOutputBytes: 8192 });
  assert.match(text(echo), /^hi\n\[exit 0 · \d+\.\ds\]$/);
});

test("2: a nonzero exit is reported, not an error; a timeout stops the process group; a large timeout is clamped", async () => {
  const cwd = await workdir("raw-bash-exit-");
  const tools = await registry(["bash"]);
  const failed = await tools.dispatch("bash", { command: "echo out; exit 3" }, { cwd, maxOutputBytes: 8192 });
  assert.equal(failed.isError, false);
  assert.match(text(failed), /\[exit 3 · \d+\.\ds\]$/);
  assert.equal(failed.host?.exitCode, 3);

  const started = Date.now();
  const timedOut = await tools.dispatch("bash", { command: "echo $$ > pid; sleep 5 & sleep 5; wait", timeout_s: 1 }, { cwd, maxOutputBytes: 8192 });
  assert.ok(Date.now() - started < 4000, "timeout_s is seconds, converted to 1000 ms");
  assert.match(text(timedOut), new RegExp(`\\[timed out after 1s; ${STOPPED}\\]$`));
  assert.equal(timedOut.host?.status, "timeout");
  // `$$` is an MSYS process id on Windows; the Windows tree stop has its own test below.
  if (process.platform !== "win32") assert.equal(await groupGone(Number((await readFile(join(cwd, "pid"), "utf8")).trim())), true);

  const clamped = await tools.dispatch("bash", { command: "true", timeout: 900000 }, { cwd, maxOutputBytes: 8192 });
  assert.match(text(clamped), /\[exit 0 · \d+\.\ds\]\n\[timeout clamped to 600000 ms\]$/);
});

test("3: aliases from other harnesses run, and workdir runs the command in that directory", async () => {
  const cwd = await workdir("raw-bash-alias-");
  await mkdir(join(cwd, "sub"));
  const tools = await registry(["bash"]);
  const cmd = await tools.dispatch("bash", { cmd: "printf alias", timeout_ms: "5000" }, { cwd, maxOutputBytes: 8192 });
  assert.match(text(cmd), /^alias\n?\[exit 0/);
  assert.deepEqual(cmd.host?.notes, ["read cmd as command", "read timeout_ms as timeout"]);
  for (const key of ["workdir", "cwd", "dir_path", "directory"]) {
    // Git Bash prints /c/...; cygpath gives the Windows path to compare.
    const command = process.platform === "win32" ? "cygpath -w \"$(pwd -P)\"" : "pwd -P";
    const pwd = await tools.dispatch("bash", { command, [key]: "sub" }, { cwd, maxOutputBytes: 8192 });
    assert.equal(text(pwd).split("\n")[0], join(cwd, "sub"), key);
  }
  const codex = await tools.dispatch("bash", { command: ["bash", "-lc", "printf codex"] }, { cwd, maxOutputBytes: 8192 });
  assert.match(text(codex), /^codex\n?\[exit 0/);
});

test("4: the real failing shape, top-level command with timeout_ms, succeeds", async () => {
  const cwd = await workdir("raw-bash-real-");
  const result = await (await registry(["bash"])).dispatch("bash", { command: "ls -1", timeout_ms: 60000 }, { cwd, maxOutputBytes: 8192 });
  assert.equal(result.isError, false);
  assert.match(text(result), /\[exit 0 · /);
});

test("5: the old batch shape is rejected with the one-command example", async () => {
  const cwd = await workdir("raw-bash-batch-");
  const result = await (await registry(["bash"])).dispatch("bash", { commands: [{ command: "touch marker" }] }, { cwd, maxOutputBytes: 8192 });
  assert.equal(result.code, "invalid_arguments");
  assert.equal(text(result), 'bash takes one command: {"command":"npm test"}; call bash once per command');
  assert.equal(existsSync(join(cwd, "marker")), false);
});

test("6: oversized output keeps its start and end around a marker, and the saved copy holds everything", async () => {
  const cwd = await workdir("raw-bash-spill-");
  const result = await (await registry(["bash"])).dispatch("bash", { command: "printf START; head -c 200000 /dev/zero | tr '\\0' a; printf END" },
    { cwd, maxOutputBytes: 4096 });
  const body = text(result);
  assert.ok(Buffer.byteLength(body) <= 4096);
  assert.ok(body.startsWith("START"));
  assert.match(body, /END\n?\[exit 0 · /);
  const path = result.host?.fullOutputPath;
  assert.ok(path, "host data names the saved copy");
  assert.ok(body.includes(`full output: ${path}`));
  const saved = await readFile(path, "utf8");
  assert.equal(saved.length, 200008);
  assert.ok(saved.startsWith("START") && saved.endsWith("END"));
});

test("7: a conditional ask rule on command sees aliased calls before anything runs", async () => {
  const cwd = await workdir("raw-bash-policy-");
  const tools = await registry(["bash"], [{ match: "builtin/bash", effect: "ask", when: { source: "arguments", any: "command", regex: "rm -rf " } }]);
  const asked: Record<string, unknown>[] = [];
  const context = { cwd, maxOutputBytes: 8192, approve: (request: { arguments: Record<string, unknown> }) => { asked.push(request.arguments); return false; } };
  const marker = join(cwd, "marker");
  for (const args of [{ command: `rm -rf x && touch marker` }, { cmd: `rm -rf x && touch marker` }]) {
    const result = await tools.dispatch("bash", args, context);
    assert.equal(result.code, "approval_denied");
  }
  assert.deepEqual(asked, [{ command: `rm -rf x && touch marker` }, { command: `rm -rf x && touch marker` }]);
  assert.equal(existsSync(marker), false);
  const control = await tools.dispatch("bash", { cmd: "touch marker2" }, context);
  assert.equal(control.isError, false);
  assert.equal(asked.length, 2);
  assert.equal(existsSync(join(cwd, "marker2")), true);
});

test("8: the production loader forwards the bash normalizer, example, renamed path and delegation", async () => {
  const [bash] = await loadBundledTools(["bash"]);
  assert.equal(typeof bash?.normalizeArguments, "function");
  assert.equal(typeof bash?.delegate, "function");
  assert.deepEqual(bash?.renamedArguments, { commands: "command" });
  assert.deepEqual(bash?.example, { command: "npm test", timeout: 300000, description: "Run the test suite" });
});

test("9a: run_in_background starts a managed job through process and returns at once", async () => {
  const cwd = await workdir("raw-bash-background-");
  const tools = await registry(["bash", "process"]);
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession("background");
  const context = { cwd, maxOutputBytes: 8192, processes };
  try {
    const ids: string[] = [];
    for (const [index, flag] of ["run_in_background", "is_background", "background"].entries()) {
      const started = Date.now();
      const result = await tools.dispatch("bash", { command: `echo $$ > pid${index}; sleep 30; echo done`, [flag]: true, description: "Long job" }, context);
      assert.ok(Date.now() - started < 2000, flag);
      assert.equal(result.isError, false, text(result));
      const id = result.host?.processId;
      assert.ok(id, flag);
      ids.push(id);
      assert.equal(text(result), `Started background job ${id} (echo $$ > pid${index}; sleep 30; echo done).\n`
        + `Read output: process {"action":"output","id":"${id}"}\nStop: process {"action":"stop","id":"${id}"}`);
      assert.equal(result.host?.description, "Long job");
    }
    assert.deepEqual(processes.list().map((job) => job.id).sort(), [...ids].sort());
    assert.ok(processes.list().every((job) => job.label === "Long job"));
    const listed = await tools.dispatch("process", { action: "list" }, context);
    for (const id of ids) assert.ok(text(listed).includes(id));

    const short = await tools.dispatch("bash", { command: "sleep 1; echo done", run_in_background: true }, context);
    const shortId = short.host!.processId!;
    const output = await waitFor(async () => {
      const page = await tools.dispatch("process", { action: "output", id: shortId }, context);
      // The output can reach "done" before the job's exit is recorded.
      return text(page).includes("[exited") ? page : undefined;
    });
    assert.match(text(output), /^done\n\n\[next cursor: 5\]\n\[exited · exit 0\]$/);

    const pid = Number((await waitFor(async () => (await readFile(join(cwd, "pid0"), "utf8").catch(() => "")) || undefined)).trim());
    const stopped = await tools.dispatch("process", { action: "stop", id: ids[0] }, context);
    assert.match(text(stopped), new RegExp(`^Stopped ${ids[0]} · `));
    assert.equal(await groupGone(pid), true);
  } finally { await supervisor.close(); }
});

test("9b: without an available process tool the call runs in the foreground with a note, after bash gates that saw the flag", async () => {
  const cwd = await workdir("raw-bash-fallback-");
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession("fallback");
  try {
    const setups: Array<[string, () => Promise<ToolRegistry>, ToolPolicyRule[]]> = [
      ["unselected", () => registry(["bash"]), []],
      ["denied", () => registry(["bash", "process"], [{ match: "builtin/process", effect: "deny" }]), [{ match: "builtin/process", effect: "deny" }]],
    ];
    for (const [label, build, base] of setups) {
      const marker = join(cwd, `${label}-ran`);
      const result = await (await build()).dispatch("bash", { command: `touch ${basename(marker)}; echo fg`, is_background: true }, { cwd, maxOutputBytes: 8192, processes });
      assert.equal(result.isError, false, label);
      assert.equal(existsSync(marker), true, label);
      assert.ok(text(result).endsWith(BACKGROUND_NOTE), label);
      assert.equal(processes.list().length, 0, label);

      // The bash rule conditioned on the flag matches the aliased flag, also in the fallback.
      const ruled = await registry(label === "unselected" ? ["bash"] : ["bash", "process"],
        [...base, { match: "builtin/bash", effect: "ask", when: { source: "arguments", any: "run_in_background", regex: "^true$" } }]);
      const blockedMarker = join(cwd, `${label}-blocked`);
      const asked: Record<string, unknown>[] = [];
      const denied = await ruled.dispatch("bash", { command: `touch ${basename(blockedMarker)}`, is_background: true },
        { cwd, maxOutputBytes: 8192, processes, approve: (request) => { asked.push(request.arguments); return false; } });
      assert.equal(denied.code, "approval_denied", label);
      assert.deepEqual(asked, [{ command: `touch ${basename(blockedMarker)}`, run_in_background: true }], label);

      const { hook: flagHook } = await hook(cwd, "builtin/bash", "flag");
      const hooked = await (await build()).dispatch("bash", { command: `touch ${basename(blockedMarker)}`, is_background: true },
        { cwd, maxOutputBytes: 8192, processes, ...hookContext(new HookDispatcher([flagHook]), cwd) });
      assert.equal(hooked.code, "hook_denied", label);
      assert.equal(existsSync(blockedMarker), false, label);
      assert.equal(processes.list().length, 0, label);
    }
    // Not exposed to this call: the whitelist leaves process out.
    const marker = join(cwd, "unexposed-ran");
    const unexposed = await (await registry(["bash", "process"])).dispatch("bash", { command: `touch ${basename(marker)}`, background: true },
      { cwd, maxOutputBytes: 8192, processes, whitelist: ["bash"] });
    assert.equal(existsSync(marker), true);
    assert.ok(text(unexposed).endsWith(BACKGROUND_NOTE));
    assert.equal(processes.list().length, 0);
  } finally { await supervisor.close(); }
});

test("9c: a process gate that refuses ends the call with an error and nothing runs", async () => {
  const cwd = await workdir("raw-bash-process-gates-");
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession("gates");
  try {
    const marker = join(cwd, "ran");
    const rule: ToolPolicyRule = { match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^start$" } };
    const asked: string[] = [];
    const rejected = await (await registry(["bash", "process"], [rule])).dispatch("bash", { command: `touch ${basename(marker)}`, run_in_background: true },
      { cwd, maxOutputBytes: 8192, processes, approve: (request) => { asked.push(request.identity); return false; } });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.code, "approval_denied");
    assert.deepEqual(asked, ["builtin/process"]);

    const { hook: block } = await hook(cwd, "builtin/process", "always");
    const blocked = await (await registry(["bash", "process"])).dispatch("bash", { command: `touch ${basename(marker)}`, run_in_background: true },
      { cwd, maxOutputBytes: 8192, processes, ...hookContext(new HookDispatcher([block]), cwd) });
    assert.equal(blocked.code, "hook_denied");
    await sleep(300);
    assert.equal(existsSync(marker), false);
    assert.equal(processes.list().length, 0);
  } finally { await supervisor.close(); }
});

test("10: a background call is one bash call on every surface, with bash's arguments stored", async () => {
  const cwd = await workdir("raw-bash-surface-");
  const store = openSessionStore({ env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd } });
  const sessionId = store.createSession({ cwd, title: "background" }).id;
  const raw = { command: "sleep 30; echo done", is_background: true };
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify(raw) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ]);
  const supervisor = new ProcessSupervisor({ store });
  const { hook: watch, log } = await hook(cwd, "builtin/*", "watch");
  const provider = createProvider({ agentName: "fixture", provider: "openai", method: "openai-chat-completions", model: "fixture", baseUrl: fixture.url, apiKey: "test" });
  const agent = createAgent({ cwd, provider, registry: await registry(["bash", "process"]), system: "tiny", maxSteps: 4, maxOutputBytes: 8192,
    requestTimeoutMs: 5000, autoApprove: true, hooks: new HookDispatcher([watch]), processes: supervisor, persistence: { store, sessionId, surface: "cli" } });
  const events: RunEvent[] = [];
  try {
    try {
      const result = await agent.run("start it", (event) => events.push(structuredClone(event)));
      assert.equal(result.status, "completed");
    } finally { await fixture.close(); }
    const starts = events.filter((event) => event.type === "tool_start");
    const results = events.filter((event) => event.type === "tool_result");
    assert.deepEqual(starts.map((event) => [event.id, event.name]), [["c1", "bash"]]);
    assert.deepEqual(results.map((event) => [event.id, event.name]), [["c1", "bash"]]);

    await agent.close();
    const owner = store.claimSession(sessionId);
    const messages = store.readAgentState(sessionId, owner).messages;
    store.releaseSession(sessionId, owner);
    const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls.length);
    assert.ok(assistant?.role === "assistant");
    assert.deepEqual(assistant.toolCalls[0]!.arguments, raw);
    const tool = messages.find((message) => message.role === "tool");
    assert.ok(tool?.role === "tool");
    assert.deepEqual(tool.arguments, { command: "sleep 30; echo done", run_in_background: true });
    const id = tool.result.host?.processId;
    assert.ok(id);

    const hooks = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: string; tool: { identity: string } });
    assert.deepEqual(hooks.map((item) => `${item.event} ${item.tool.identity}`),
      ["PreToolUse builtin/bash", "PreToolUse builtin/process", "PostToolUse builtin/process", "PostToolUse builtin/bash"]);

    const rows = supervisor.commands.list(sessionId);
    assert.deepEqual(rows.map((row) => [row.kind, row.id]), [["background", id]]);
  } finally {
    await agent.close();
    await supervisor.close();
  }
});

test("output order holds when a character does not fit the start of the window", async () => {
  const cwd = await workdir("raw-bash-order-");
  const result = await (await registry(["bash"])).dispatch("bash", { command: "printf 'x%.0s' {1..1586}; printf '\\360\\237\\230\\200'; sleep 0.1; printf a >&2" },
    { cwd, maxOutputBytes: 8192 });
  assert.deepEqual(result.content.slice(0, -1).map((block) => block.type === "text" ? [block.channel, block.text] : []),
    [["stdout", `${"x".repeat(1586)}😀`], ["stderr", "a"]]);
});

test("a background timeout is clamped like a foreground one, and a long Unicode description still starts the job", async () => {
  const cwd = await workdir("raw-bash-bg-clamp-");
  const tools = await registry(["bash", "process"]);
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession("clamp");
  const started: Array<Record<string, unknown>> = [];
  const spy = { ...processes, start: (input: Parameters<typeof processes.start>[0]) => { started.push({ timeout_ms: input.timeout_ms, label: input.label }); return processes.start(input); } };
  try {
    const description = "😀".repeat(150);
    const result = await tools.dispatch("bash", { command: "sleep 30", run_in_background: true, timeout: 2147483648, description }, { cwd, maxOutputBytes: 8192, processes: spy });
    assert.equal(result.isError, false, text(result));
    assert.ok(text(result).endsWith("\n[timeout clamped to 600000 ms]"));
    assert.deepEqual(started, [{ timeout_ms: 600000, label: description }]);
  } finally { await supervisor.close(); }
});

test("a copied bash tool without delegation runs in the foreground and says so", async () => {
  const cwd = await workdir("raw-bash-local-");
  const [bash] = await loadBundledTools(["bash"]);
  const tools = new ToolRegistry();
  const { delegate: _delegate, ...local } = bash!;
  tools.register(local);
  const result = await tools.dispatch("bash", { command: "touch ran", run_in_background: true }, { cwd, maxOutputBytes: 8192 });
  assert.equal(existsSync(join(cwd, "ran")), true);
  assert.ok(text(result).endsWith(BACKGROUND_NOTE));
});

test("a background workdir is passed on as a relative cwd, or absolute when no relative path reaches it", () => {
  const cwd = (args: Record<string, unknown>, base: string, platform: NodeJS.Platform) =>
    (delegate({ command: "x", run_in_background: true, ...args }, { cwd: base }, platform)!.arguments as { cwd?: string }).cwd;
  assert.equal(cwd({ workdir: "sub" }, "C:\\work", "win32"), "sub");
  assert.equal(cwd({ workdir: "D:\\data" }, "C:\\work", "win32"), "D:\\data");
  assert.equal(cwd({ workdir: "/d/data" }, "C:\\work", "win32"), "D:\\data");
  assert.equal(cwd({ workdir: "C:\\work" }, "C:\\work", "win32"), undefined);
  assert.equal(cwd({}, "C:\\work", "win32"), undefined);
  assert.equal(cwd({ workdir: "../x" }, "/work/a", "linux"), "../x");
  assert.equal(cwd({ workdir: "/srv" }, "/work", "linux"), "../srv");
});

const onlyWindows = process.platform === "win32" ? false : "needs Windows";

test("on Windows abort and timeout stop the whole tree, MSYS pipelines and native grandchildren included", { skip: onlyWindows }, async () => {
  const cwd = await workdir("raw-bash-tree-");
  const tools = await registry(["bash"]);
  const node = process.execPath.replaceAll("\\", "/");
  // Plain taskkill /T misses MSYS pipeline members and processes whose parent already exited; the job does not.
  // Every process meant to be stopped carries the marker on its command line; `running` names those that must be seen
  // alive first, so the stop is never tested against the parent shell alone.
  const cases: { name: string; command: (marker: string) => string; running: string[]; timeout?: number }[] = [
    { name: "aborted pipeline", command: (marker) => `sleep ${marker} | grep -F ${marker}`, running: ["sleep.exe", "grep.exe"] },
    { name: "timed-out find and xargs", command: (marker) => `find / -maxdepth 1 2>/dev/null | xargs -I{} sleep ${marker}`,
      running: ["xargs.exe", "sleep.exe"], timeout: 6000 },
    { name: "native grandchild through a child bash", command: (marker) => `bash -c '"${node}" -e "setInterval(()=>{},1000)" ${marker}'`,
      running: ["bash.exe", "node.exe"] },
  ];
  for (const item of cases) {
    // Numeric, so `sleep` still reads it as a duration, and unique to this case.
    const marker = `300.${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const controller = new AbortController();
    const running = tools.dispatch("bash", { command: item.command(marker), ...(item.timeout ? { timeout: item.timeout } : {}) },
      { cwd, maxOutputBytes: 8192, signal: controller.signal });
    await waitFor(() => {
      const names = new Set(processesWithMarker(marker).map((found) => found.name.toLowerCase()));
      return item.running.every((name) => names.has(name)) ? true : undefined;
    }, 5000);
    if (!item.timeout) controller.abort();
    const result = await running;
    assert.match(text(result), item.timeout ? /\[timed out after 6s; process tree stopped\]$/ : /\[aborted after \d+\.\ds; process tree stopped\]$/, item.name);
    assert.deepEqual(await waitForNoMarked(marker, 3000), [], item.name);
  }
});

test("on Windows the job launcher leaves $0, quoting and exit codes as Git Bash gives them", { skip: onlyWindows }, async () => {
  const cwd = await workdir("raw-bash-same-");
  const tools = await registry(["bash"]);
  const bash = resolveBash({ workspace: cwd });
  assert.ok(bash.ok, JSON.stringify(bash));
  const command = "printf '%s' \"$0 a\\\"b\"; exit 7";
  const direct = spawnSync(bash.path, ["-c", command], { cwd, encoding: "utf8" });
  const result = await tools.dispatch("bash", { command }, { cwd, maxOutputBytes: 8192 });
  assert.equal(direct.status, 7);
  assert.equal(result.host?.exitCode, 7);
  assert.match(text(result), /\[exit 7 · /);
  assert.equal(text(result).replace(/\n?\[exit 7 · [^\]]*\]$/, ""), direct.stdout);
});

test("on Windows a stop that fails keeps the aborted result and its output, and says the stop failed", { skip: onlyWindows }, async () => {
  const cwd = await workdir("raw-bash-stuck-");
  const tools = await registry(["bash"]);
  // Node reports a failed kill with an error event and a false return; the command then ends on its own.
  const kill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (this: ChildProcess) { this.emit("error", new Error("kill EPERM")); return false; };
  try {
    const controller = new AbortController();
    const running = tools.dispatch("bash", { command: "echo started; sleep 3" }, { cwd, maxOutputBytes: 8192, signal: controller.signal });
    await sleep(1000);
    controller.abort();
    const result = await running;
    assert.equal(result.code, "aborted");
    assert.match(text(result), /^started\n/);
    assert.match(text(result), /\[stopping the command failed: kill EPERM\]/);
    assert.match(text(result), new RegExp(`\\[aborted after \\d+\\.\\ds; ${STOPPED}\\]$`));
  } finally { ChildProcess.prototype.kill = kill; }
});

test("on Windows a bare Bash path is looked up on PATH, never in the cwd, and a missing one fails to spawn", { skip: onlyWindows }, async () => {
  const cwd = await workdir("raw-bash-planted-");
  // A planted "Bash" that would run if the launcher were handed the bare name: CreateProcess searches the cwd.
  await copyFile(process.execPath, join(cwd, "raw-planted-bash.exe"));
  for (const bashPath of ["raw-planted-bash", "raw-missing-bash", join(cwd, "missing", "bash.exe")]) {
    const result = await runBash({ command: "echo ran", cwd, maxOutputBytes: 8192, bashPath });
    assert.equal(result.code, "bash_spawn_error", bashPath);
    assert.match(text(result), /cannot start Bash: spawn .* ENOENT/, bashPath);
  }
});
