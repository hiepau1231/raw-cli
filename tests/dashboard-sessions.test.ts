import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { makePng } from "./fixtures/images.js";
import { startDashboard } from "../src/dashboard/server.js";
import type { HistoryView, QueuedInputView } from "../src/sessions/view.js";
import { openAiFrame, openAiDone } from "./fixtures/mock-provider.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import { createAgent } from "../src/agent.js";
import { COMPACT_SYSTEM_PROMPT } from "../src/compact.js";
import { compactionInput, isCompactionRequest } from "./fixtures/compaction.js";

test("HTTP duplicate submissions execute one real Bash effect and return the saved receipt", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: "printf x >> effect.txt" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    assert.equal(f.provider.requests.length, 0);
    const intent = { clientRequestId: "one", kind: "turn", agent: "raw", input: "do the effect" };
    const [a, b] = await Promise.all([1, 2].map(() => f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", intent)));
    assert.equal(a!.id, b!.id); assert.equal((await f.wait(a!.id)).state, "completed");
    const duplicate = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", intent); assert.equal(duplicate.id, a!.id);
    const lookup = await f.json<SessionOperation>(`/sessions/${session.id}/operations?clientRequestId=one`); assert.equal(lookup.id, a!.id);
    assert.equal((await f.api(`/sessions/${session.id}/operations`, "POST", { ...intent, input: "different" })).status, 409);
    assert.equal(f.provider.requests.length, 2); assert.equal(readFileSync(join(f.root, "effect.txt"), "utf8"), "x");
    const measured = await f.json<{ metrics: { capabilities: { tools: string[]; skills: string[]; vars: string[] } } }>(`/sessions/${session.id}/metrics`);
    assert.deepEqual(measured.metrics.capabilities, { tools: ["builtin/bash"], skills: [], vars: [] });
    const history = await f.json<{ items: Array<{ kind: string }> }>(`/sessions/${session.id}/history`);
    assert.equal(history.items.filter((item) => item.kind === "user").length, 1);
    const originalUpdated = f.server.context.store!.getSession(session.id)!.updatedAt;
    await f.json(`/sessions/${session.id}`, "PATCH", { title: "Named session" });
    assert.equal(f.server.context.store!.getSession(session.id)!.updatedAt, originalUpdated);
    const list = await f.json<{ items: SessionSummary[] }>("/sessions?title=Named"); assert.equal(list.items[0]?.id, session.id);
  } finally { await f.close(); }
});

test("web turns see current config then stabilize and the installed CLI resumes the same ID", async () => {
  const frames = [openAiFrame({ content: "continued" }, "stop"), openAiDone];
  const f = await dashboardFixture({ responses: [{ frames }, { frames }, { frames }, { frames }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    for (const [index, prompt] of ["one", "two"].entries()) {
      if (index) { f.config.agents.raw.system_prompt = "Changed prompt"; writeFileSync(f.configPath, JSON.stringify(f.config)); }
      const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: prompt, kind: "turn", agent: "raw", input: prompt });
      assert.equal((await f.wait(op.id)).state, "completed");
    }
    const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "--resume", session.id, "three"], { cwd: f.root, env: f.env });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    const back = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "back-to-web", kind: "turn", agent: "raw", input: "four" });
    assert.equal((await f.wait(back.id)).state, "completed");
    const requests = f.provider.requests.map((entry) => entry.body as { messages: Array<{ role: string; content: string }>; prompt_cache_key: string });
    assert.notEqual(requests[0]?.prompt_cache_key, requests[1]?.prompt_cache_key);
    assert.equal(requests[1]?.prompt_cache_key, requests[2]?.prompt_cache_key);
    assert.equal(requests[2]?.prompt_cache_key, requests[3]?.prompt_cache_key);
    assert.equal(requests[1]?.messages[0]?.content, "Changed prompt");
    assert.deepEqual(requests[2]?.messages.slice(0, requests[1]!.messages.length), requests[1]?.messages);
    assert.ok((await f.json<{ session: SessionSummary }>(`/sessions/${session.id}`)).session.id === session.id);
  } finally { await f.close(); }
});

test("foreign writer remains readable and cannot be deleted or run through this host", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const owner = f.server.context.store!.claimSession(session.id);
    try {
      assert.equal((await f.json<{ ownership: string }>(`/sessions/${session.id}`)).ownership, "elsewhere");
      assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 409);
      assert.equal((await f.api(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "busy", kind: "turn", agent: "raw", input: "go" })).status, 409);
      assert.equal(f.provider.requests.length, 0);
    } finally { f.server.context.store!.releaseSession(session.id, owner); }
    assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 200);
  } finally { await f.close(); }
});

test("history keysets split tool pairs without losing identity and metrics reads never start a runtime", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    assert.deepEqual(await f.json(`/sessions/${session.id}/metrics`), { metrics: null, metricsStale: false });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "metrics", kind: "turn", agent: "raw", input: "hello" });
    await f.wait(op.id);
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.metricsStale, false); assert.equal(snapshot.metrics?.context.contextWindow, 8192);
    assert.ok(snapshot.metrics!.context.percentage! > 0); assert.equal(snapshot.metrics!.turn.cacheReadCoverage, 0);
    f.server.context.store!.appendHistory({ sessionId: session.id, kind: "tool_call", payload: { display: { id: "past", name: "old", started: true, arguments: {} } } });
    f.server.context.store!.appendHistory({ sessionId: session.id, kind: "tool_result", payload: { update: { toolCallId: "past", status: "failed", rawOutput: { code: "outcome_unknown", preview: "inspect" } } } });
    const newest = await f.json<{ items: Array<{ callId: string; toolState: string }>; nextCursor: string }>(`/sessions/${session.id}/history?limit=1`);
    const previous = await f.json<{ items: Array<{ callId: string }> }>(`/sessions/${session.id}/history?limit=1&before=${encodeURIComponent(newest.nextCursor)}`);
    assert.equal(newest.items[0]?.callId, previous.items[0]?.callId); assert.equal(newest.items[0]?.toolState, "outcome_unknown");
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).metricsStale, true);
    assert.equal((await f.api(`/sessions/${session.id}/history?limit=101`)).status, 400);
    assert.equal((await f.api(`/sessions/${session.id}/history?before=garbage`)).status, 400);
    assert.equal(f.provider.requests.length, 1);
  } finally { await f.close(); }
});

test("manual compaction preserves history, summary and failure rollback through HTTP", async () => {
  const long = "details ".repeat(300);
  const f = await dashboardFixture({ agent: { compact: { keep_recent_turns: 0, keep_recent_tokens: 1, max_output_tokens: 64 } }, responses: [
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "remember task" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: long }, "stop"), openAiDone] },
    { status: 500, body: { error: { message: "summary unavailable" } } },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const run = async (kind: "turn" | "compact", key: string) => f.wait((await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) })).id);
    await run("turn", "one"); await run("turn", "again"); const compact = await run("compact", "compact"); assert.equal(compact.result?.status, "compacted", JSON.stringify(compact));
    let snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.context.summary, "remember task"); assert.ok(snapshot.history.items.some((item) => item.text === long));
    const successes = snapshot.history.items.filter((item) => item.compaction?.status === "compacted"); assert.equal(successes.length, 1);
    await run("turn", "two"); const before = f.server.context.store!.getContextSummary(session.id);
    assert.equal((await run("compact", "failure")).state, "error");
    assert.deepEqual(f.server.context.store!.getContextSummary(session.id), before);
    snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.history.items.filter((item) => item.compaction?.status === "compacted").length, 1);
    assert.ok(snapshot.history.items.some((item) => item.compaction?.status === "error"));
  } finally { await f.close(); }
});

test("automatic compaction and manual no-op have distinct persisted outcomes", async () => {
  const f = await dashboardFixture({ agent: { compact: { trigger_tokens: 800, keep_recent_turns: 1, keep_recent_tokens: 1, max_output_tokens: 64 } }, responses: [
    { frames: [openAiFrame({ content: "body ".repeat(400) }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "summary" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "end" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const run = async (kind: "turn" | "compact", key: string) => f.wait((await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) })).id);
    assert.equal((await run("compact", "empty")).result?.status, "noop");
    await run("turn", "one"); await run("turn", "two");
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    const success = snapshot.history.items.filter((item) => item.compaction?.status === "compacted");
    assert.equal(success.length, 1); assert.equal(success[0]?.compaction?.cause, "automatic");
    assert.equal(snapshot.context.summary, "summary"); assert.equal(snapshot.history.items.filter((item) => item.kind === "user").length, 2);
  } finally { await f.close(); }
});

for (const target of ["startup", "provider", "compact"] as const) test(`HTTP Stop cancels ${target} and releases ownership`, async () => {
  let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
  const modelConfig = { agentName: "raw", provider: "ollama", method: "openai-chat-completions" as const, model: "fixture" };
  const stopped = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Error("stopped")); signal?.addEventListener("abort", stop, { once: true });
    entered(); if (signal?.aborted) stop();
  });
  const f = await dashboardFixture({ attach: async ({ store, session, owner, operation, signal }) => {
    if (target === "startup") return stopped(signal);
    return { modelConfig, compactOptions: { keepRecentTurns: 0, keepRecentTokens: 1 }, async close() {},
      agent: createAgent({ cwd: session.cwd, provider: { modelConfig, async generate(request) {
        if (target === "provider" || isCompactionRequest(request)) return stopped(request.signal);
        return { text: "details ".repeat(300), toolCalls: [], finishReason: "stop" };
      } }, persistence: { store, sessionId: session.id, owner, surface: "web", ownership: "host", operationId: operation.id } }),
    };
  } });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const submit = (key: string, kind: string) => f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST",
      { clientRequestId: key, kind, agent: "raw", ...(kind === "turn" ? { input: key } : {}) });
    if (target === "compact") { await f.wait((await submit("seed", "turn")).id); await f.wait((await submit("seed2", "turn")).id); }
    const before = f.server.context.store!.getContextSummary(session.id);
    const op = await submit("stop", target === "compact" ? "compact" : "turn"); await ready;
    await f.json(`/operations/${op.id}/cancel`, "POST"); assert.equal((await f.wait(op.id)).state, "cancelled");
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`); assert.equal(snapshot.ownership, "idle");
    if (target === "compact") assert.deepEqual(snapshot.context, before);
    if (target === "startup") assert.equal(snapshot.history.items.length, 0);
  } finally { await f.close(); }
});

test("HTTP Stop interrupts a real Bash child while another tab can still observe the terminal receipt", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [{ frames: [openAiFrame({ tool_calls: [
    { index: 0, id: "sleep", type: "function", function: { name: "bash", arguments: '{"command":"sleep 30"}' } },
  ] }, "tool_calls"), openAiDone] }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "tool-stop", kind: "turn", agent: "raw", input: "wait" });
    for (let i = 0; i < 200; i++) {
      if ((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).history.items.some((item) => item.toolCall?.started)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await f.json(`/operations/${op.id}/cancel`, "POST"); assert.equal((await f.wait(op.id)).state, "cancelled");
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
  } finally { await f.close(); }
});

test("HTTP Stop during actual MCP initialization terminates its child before consuming input", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["mcp/slow/tool"] } } });
  const marker = join(f.root, "mcp.pid");
  Object.assign(f.config, { mcp: { servers: { slow: { transport: "stdio", command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.stdin.resume();setInterval(()=>{},1000)", marker] } } } });
  writeFileSync(f.configPath, JSON.stringify(f.config));
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "mcp-stop", kind: "turn", agent: "raw", input: "pending input" });
    for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(marker)); const pid = Number(readFileSync(marker, "utf8"));
    await f.json(`/operations/${op.id}/cancel`, "POST"); const end = await f.wait(op.id);
    assert.equal(end.state, "cancelled"); assert.equal(end.committedUserPosition, undefined);
    assert.throws(() => process.kill(pid, 0)); assert.equal(f.provider.requests.length, 0);
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
  } finally { await f.close(); }
});

test("an expired dead writer does not permanently block deleting an idle session", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    f.server.context.store!.database.prepare("UPDATE sessions SET owner_token = ?, lease_until = 0 WHERE id = ?")
      .run("99999999-abandoned", session.id);
    assert.equal((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).ownership, "idle");
    assert.equal((await f.api(`/sessions/${session.id}`, "DELETE")).status, 200);
    assert.equal((await f.api(`/sessions/${session.id}`)).status, 404);
    assert.equal(f.provider.requests.length, 0);
  } finally { await f.close(); }
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
type InputReply = { operation?: SessionOperation; queued?: QueuedInputView; delivered?: { operationId: string; historySequence: number } };

test("POST /inputs starts a turn when idle, queues while it runs and resolves every replay", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { gate: held, frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: "printf x" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const inputs = `/sessions/${session.id}/inputs`;
    const stream = await eventStream(f.server, session.id);
    try {
      assert.equal((await stream.next()).type, "snapshot");
      const started = await f.json<InputReply>(inputs, "POST", { clientRequestId: "first", agent: "raw", input: "start", mode: "queue" });
      assert.ok(started.operation && !started.queued);
      await until(() => f.provider.requests.length === 1, "the first request");
      const uploaded = await fetch(`${f.server.url}/api/sessions/${session.id}/attachments`, { method: "POST", body: new Uint8Array(makePng()),
        headers: { Authorization: `Bearer ${f.server.token}`, "Content-Type": "image/png", "X-Raw-Filename": "shot.png" } });
      const { id: staged } = await uploaded.json() as { id: string };
      const body = { clientRequestId: "later", agent: "raw", input: "queued text", attachments: [staged], mode: "queue" };
      const queued = await f.json<InputReply>(inputs, "POST", body);
      assert.equal(queued.queued?.state, "queued"); assert.deepEqual(queued.queued?.attachments?.map((item) => item.name), ["shot.png"]);
      for (;;) {
        const event = await stream.next();
        if (event.type !== "inputs") continue;
        assert.deepEqual((event.data.items as QueuedInputView[]).map((item) => [item.clientRequestId, item.state]), [["later", "queued"]]);
        break;
      }
      // The staged image now belongs to the queued message; a replay never reads staging again.
      assert.equal((await f.json<InputReply>(inputs, "POST", body)).queued?.id, queued.queued!.id);
      assert.equal((await f.api(inputs, "POST", { ...body, input: "different" })).status, 409);
      release();
      assert.equal((await f.wait(started.operation!.id)).state, "completed");
      const messages = (f.provider.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
      assert.deepEqual(messages.slice(-2).map((message) => message.role), ["tool", "user"]);
      assert.match(JSON.stringify(messages.at(-1)!.content), /queued text/);
      const delivered = await f.json<InputReply>(inputs, "POST", body);
      assert.equal(delivered.delivered?.operationId, started.operation!.id);
      const history = await f.json<{ items: HistoryView[] }>(`/sessions/${session.id}/history`);
      const record = history.items.find((item) => item.kind === "user" && item.text === "queued text")!;
      assert.equal(delivered.delivered?.historySequence, record.sequence); assert.equal(record.queued, true);
      assert.deepEqual(await f.json(`${inputs}?clientRequestId=later`), delivered);
      assert.equal((await f.json<InputReply>(`${inputs}?clientRequestId=first`)).operation?.id, started.operation!.id);
      assert.equal((await f.api(`${inputs}?clientRequestId=unknown`)).status, 404);
      const refused = await f.api(`${inputs}/${queued.queued!.id}`, "DELETE");
      assert.equal(refused.status, 409); assert.equal((await refused.json() as { error: { code: string } }).error.code, "already_sent");
      assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs, []);
      assert.equal(f.provider.requests.length, 2);
    } finally { stream.close(); }
  } finally { await f.close(); }
});

test("leftover messages start the next turn; after Stop they wait, paused, and can be deleted", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await dashboardFixture({ responses: [
    { gate: held, frames: [openAiFrame({ content: "first answer" }, "stop"), openAiDone] },
    { frames: [openAiFrame({ content: "second answer" }, "stop"), openAiDone] },
    { hold: true },
  ] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const inputs = `/sessions/${session.id}/inputs`;
    const send = (key: string, input: string) => f.json<InputReply>(inputs, "POST", { clientRequestId: key, agent: "raw", input, mode: "queue" });
    const first = await send("a", "first");
    await until(() => f.provider.requests.length === 1, "the first request");
    assert.ok((await send("b", "second")).queued);
    release();
    assert.equal((await f.wait(first.operation!.id)).state, "completed");
    let next: SessionOperation | undefined;
    await until(async () => { const response = await f.api(`/sessions/${session.id}/operations?clientRequestId=b`);
      if (response.ok) next = await response.json() as SessionOperation; return !!next; }, "the next turn");
    assert.equal((await f.wait(next!.id)).state, "completed");
    const messages = (f.provider.requests[1]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    assert.deepEqual([messages.at(-1)?.role, messages.at(-1)?.content], ["user", "second"]);
    assert.equal((await send("b", "second")).operation?.id, next!.id);
    const third = await send("c", "third");
    await until(() => f.provider.requests.length === 3, "the third request");
    const waiting = await send("d", "fourth");
    await f.json(`/operations/${third.operation!.id}/cancel`, "POST");
    assert.equal((await f.wait(third.operation!.id)).state, "cancelled");
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs.map((item) => [item.clientRequestId, item.state]), [["d", "paused"]]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(f.provider.requests.length, 3);
    assert.equal((await f.api(`/sessions/${session.id}/operations?clientRequestId=d`)).status, 404);
    assert.equal((await f.api(`${inputs}/${waiting.queued!.id}`, "DELETE")).status, 204);
    assert.deepEqual((await f.json<SessionSnapshot>(`/sessions/${session.id}`)).inputs, []);
    assert.equal((await f.api(`${inputs}/unknown`, "DELETE")).status, 404);
  } finally { await f.close(); }
});

test("a session queues at most 20 messages, and a session owned elsewhere queues none", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const send = (key: string) => f.api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: key, agent: "raw", input: key, mode: "queue" });
    const running = await (await send("run")).json() as InputReply;
    await until(() => f.provider.requests.length === 1, "the request");
    for (let index = 0; index < 20; index++) assert.equal((await send(`q${index}`)).status, 202);
    const full = await send("q20");
    assert.equal(full.status, 409); assert.equal((await full.json() as { error: { code: string } }).error.code, "queue_full");
    await f.json(`/operations/${running.operation!.id}/cancel`, "POST"); await f.wait(running.operation!.id);
    const owner = f.server.context.store!.claimSession(session.id);
    try {
      const busy = await send("elsewhere");
      assert.equal(busy.status, 409); assert.equal((await busy.json() as { error: { code: string } }).error.code, "busy");
    } finally { f.server.context.store!.releaseSession(session.id, owner); }
  } finally { await f.close(); }
});

test("after a restart, 201 delivered messages still resolve their replays and waiting ones are listed paused", async () => {
  const f = await dashboardFixture();
  let restarted: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const store = f.server.context.store!; const owner = store.claimSession(session.id);
    const intent = (key: string) => ({ sessionId: session.id, clientRequestId: key, kind: "turn" as const, agentName: "raw",
      configPath: f.configPath, input: `message ${key}`, mode: "queue" as const });
    for (let index = 0; index < 201; index++) {
      store.enqueueInput(session.id, owner, intent(`m${index}`));
      const claimed = store.claimQueuedInput(session.id, owner)!;
      store.appendAgentMessage(session.id, owner, { role: "user", content: claimed.input }, {},
        [{ kind: "user", payload: { input: claimed.input, queued: true } }], undefined, undefined, undefined, { id: claimed.id, operationId: "op" });
    }
    store.enqueueInput(session.id, owner, intent("open"));
    store.releaseSession(session.id, owner);
    await f.server.close();
    restarted = await startDashboard({ port: 0, cwd: f.root, configPath: f.configPath, env: f.env });
    const api = (path: string, method = "GET", body?: unknown) => fetch(`${restarted!.url}/api${path}`, { method,
      headers: { Authorization: `Bearer ${restarted!.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const replay = await api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "m0", agent: "raw", input: "message m0", attachments: ["consumed"], mode: "queue" });
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { delivered: { operationId: "op", historySequence: 1 } });
    const snapshot = await (await api(`/sessions/${session.id}`)).json() as SessionSnapshot;
    assert.deepEqual(snapshot.inputs.map((item) => [item.clientRequestId, item.state]), [["open", "paused"]]);
    const waiting = await api(`/sessions/${session.id}/inputs`, "POST", { clientRequestId: "open", agent: "raw", input: "message open", attachments: ["consumed"], mode: "queue" });
    assert.equal(((await waiting.json()) as InputReply).queued?.state, "paused");
    assert.equal(f.provider.requests.length, 0);
    assert.equal(restarted.context.store!.historyWatermark(session.id), 201);
  } finally { await restarted?.close(); await f.close(); }
});
