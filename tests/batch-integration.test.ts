import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpServer } from "../src/acp/methods.js";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/llm/client.js";
import { testConfig } from "./fixtures/config.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

function toolContent(body: unknown): Map<string, string> {
  const messages = (body as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> }).messages;
  return new Map(messages.filter((message) => message.role === "tool").map((message) => [message.tool_call_id!, message.content!]));
}

function toolRows(body: unknown): Map<string, Array<Record<string, unknown>>> {
  return new Map([...toolContent(body)].flatMap(([id, content]) => {
    try { return [[id, (JSON.parse(content) as { results: Array<Record<string, unknown>> }).results] as const]; } catch { return []; }
  }));
}

test("real CLI and OpenAI adapter replay indexed batches and single bash calls with stable schema and bounded display", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-integration-"));
  await writeFile(join(cwd, "first.txt"), "one\n");
  await writeFile(join(cwd, "second.txt"), "alpha\nbeta\n");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "read-batch", type: "function", function: { name: "read_file",
        arguments: JSON.stringify({ files: [{ path: "first.txt" }, { path: "second.txt", start_line: 2, max_lines: 1 }] }) } },
      { index: 1, id: "write-batch", type: "function", function: { name: "write_file",
        arguments: JSON.stringify({ operations: [
          { path: "created.txt", mode: "overwrite", content: "first\n" },
          { path: "created.txt", mode: "replace_text", old_text: "absent", new_text: "x" },
          { path: "created.txt", mode: "append", content: "last\n" },
        ] }) } },
      { index: 2, id: "bash-exit", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "exit 7" }) } },
      { index: 3, id: "bash-cat", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat created.txt" }) } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "batch done" }, "stop"), openAiDone] },
  ]);
  try {
    const configPath = testConfig("openai", "fixture", fixture.url);
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
      "--config", configPath, "run batches"], { cwd, env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "batch done\n");
    assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "first\nlast\n");
    assert.equal(fixture.requests.length, 2);
    const before = fixture.requests[0]!.body as { messages: unknown[]; tools: unknown };
    const after = fixture.requests[1]!.body as { messages: unknown[]; tools: unknown };
    assert.deepEqual(after.messages[0], before.messages[0]);
    assert.deepEqual(after.tools, before.tools);
    const contents = toolContent(after);
    assert.deepEqual([...contents.keys()], ["read-batch", "write-batch", "bash-exit", "bash-cat"]);
    const batches = toolRows(after);
    assert.deepEqual(batches.get("read-batch")?.map((row) => row.text), ["one\n", "beta\n"]);
    assert.deepEqual(batches.get("write-batch")?.map((row) => row.status), ["ok", "error", "ok"]);
    assert.match(contents.get("bash-exit")!, /^\[exit 7 · \d+\.\ds\]$/);
    assert.match(contents.get("bash-cat")!, /^first\nlast\n\n?\[exit 0 · \d+\.\ds\]$/);
    assert.match(stderr, /statuses: 0:ok 1:error 2:ok/);
    assert.doesNotMatch(stderr, /"content":"first\\n"|"content":"last\\n"/);
  } finally { await fixture.close(); }
});

test("ACP links one batch call to one indexed rawOutput update", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-acp-"));
  await writeFile(join(cwd, "a.txt"), "a\n");
  await writeFile(join(cwd, "b.txt"), "b\n");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "acp-batch", type: "function", function: { name: "read_file",
      arguments: JSON.stringify({ files: [{ path: "a.txt" }, { path: "b.txt" }] }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "ACP done" }, "stop"), openAiDone] },
  ]);
  const runtime = await loadConfig({ flags: { configPath: testConfig("openai", "fixture", fixture.url) },
    env: { OPENAI_API_KEY: "key" }, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: createProvider });
  const peer = client({ name: "batch-acp-test" });
  const updates: Array<Record<string, unknown>> = [];
  peer.onNotification("session/update", ({ params }) => { updates.push(params.update as Record<string, unknown>); });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd, mcpServers: [] });
    const result = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read both" }] });
    assert.equal(result.stopReason, "end_turn");
    const call = updates.find((item) => item.sessionUpdate === "tool_call" && item.toolCallId === "acp-batch");
    const done = updates.find((item) => item.sessionUpdate === "tool_call_update" && item.toolCallId === "acp-batch" && item.status === "completed");
    assert.ok(call);
    assert.ok(done);
    const output = done.rawOutput as { content: Array<{ type: string; value: { results: Array<Record<string, unknown>> } }> };
    assert.deepEqual(output.content[0]?.value.results.map((row) => row.text), ["a\n", "b\n"]);
    assert.deepEqual(toolRows(fixture.requests[1]?.body).get("acp-batch")?.map((row) => row.index), [0, 1]);
  } finally { connection.close(); await server.close(); await fixture.close(); }
});
