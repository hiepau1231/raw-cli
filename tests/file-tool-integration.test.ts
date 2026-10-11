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

const call = (index: number, id: string, name: string, args: Record<string, unknown>) =>
  ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("real CLI and OpenAI adapter replay single-file tool calls and bash with stable schema and bounded display", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-file-tool-integration-"));
  await writeFile(join(cwd, "first.txt"), "one\n");
  await writeFile(join(cwd, "second.txt"), "alpha\nbeta\ngamma\n");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [
      call(0, "read-whole", "read_file", { path: "first.txt" }),
      call(1, "read-range", "read_file", { path: "second.txt", offset: 2, limit: 1 }),
      call(2, "write", "write_file", { path: "created.txt", content: "first\n" }),
      call(3, "edit-miss", "edit_file", { path: "created.txt", old_string: "absent", new_string: "x" }),
      call(4, "edit", "edit_file", { path: "created.txt", old_string: "first\n", new_string: "first\nlast\n" }),
      call(5, "bash-exit", "bash", { command: "exit 7" }),
      call(6, "bash-cat", "bash", { command: "cat created.txt" }),
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "tools done" }, "stop"), openAiDone] },
  ]);
  try {
    const configPath = testConfig("openai", "fixture", fixture.url);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    document.agents.fixture.tools.use.push("builtin/edit_file");
    await writeFile(configPath, JSON.stringify(document));
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"),
      "--config", configPath, "run tools"], { cwd, env: { ...process.env, OPENAI_API_KEY: "key" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "tools done\n");
    assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "first\nlast\n");
    assert.equal(fixture.requests.length, 2);
    const before = fixture.requests[0]!.body as { messages: unknown[]; tools: unknown };
    const after = fixture.requests[1]!.body as { messages: unknown[]; tools: unknown };
    assert.deepEqual(after.messages[0], before.messages[0]);
    assert.deepEqual(after.tools, before.tools);
    const contents = toolContent(after);
    assert.deepEqual([...contents.keys()], ["read-whole", "read-range", "write", "edit-miss", "edit", "bash-exit", "bash-cat"]);
    assert.equal(contents.get("read-whole"), "   1│one\n[lines 1–1 of 1; end of file]");
    assert.equal(contents.get("read-range"), "   2│beta\n[lines 2–2 of 3; next: offset 3]");
    assert.equal(contents.get("write"), "Wrote 6 bytes to created.txt (created)");
    assert.match(contents.get("edit-miss")!, /old_string not found in created\.txt/);
    assert.equal(contents.get("edit"), "Edited created.txt: 1 replacement (+1 −0 lines)");
    assert.match(contents.get("bash-exit")!, /^\[exit 7 · \d+\.\ds\]$/);
    assert.match(contents.get("bash-cat")!, /^first\nlast\n\n?\[exit 0 · \d+\.\ds\]$/);
    assert.doesNotMatch(stderr, /"content":"first\\n"|"new_string":"first\\nlast\\n"/);
  } finally { await fixture.close(); }
});

test("ACP links one file-tool call to one rawOutput update", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-file-tool-acp-"));
  await writeFile(join(cwd, "a.txt"), "a\nb\n");
  const fixture = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [call(0, "acp-read", "read_file", { path: "a.txt" })] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "ACP done" }, "stop"), openAiDone] },
  ]);
  const runtime = await loadConfig({ flags: { configPath: testConfig("openai", "fixture", fixture.url) },
    env: { OPENAI_API_KEY: "key" }, requireModel: true });
  const server = createAcpServer({ runtime, mcpServers: {}, providerFactory: createProvider });
  const peer = client({ name: "file-tool-acp-test" });
  const updates: Array<Record<string, unknown>> = [];
  peer.onNotification("session/update", ({ params }) => { updates.push(params.update as Record<string, unknown>); });
  const connection = peer.connect(server.app);
  try {
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await connection.agent.request("session/new", { cwd, mcpServers: [] });
    const result = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read it" }] });
    assert.equal(result.stopReason, "end_turn");
    const calls = updates.filter((item) => item.sessionUpdate === "tool_call" && item.toolCallId === "acp-read");
    const done = updates.filter((item) => item.sessionUpdate === "tool_call_update" && item.toolCallId === "acp-read" && item.status === "completed");
    assert.equal(calls.length, 1);
    assert.equal(done.length, 1);
    const output = done[0]!.rawOutput as { content: Array<{ type: string; text?: string }> };
    assert.deepEqual(output.content, [{ type: "text", text: "   1│a\n   2│b\n[lines 1–2 of 2; end of file]" }]);
    assert.equal(toolContent(fixture.requests[1]?.body).get("acp-read"), output.content[0]!.text);
  } finally { connection.close(); await server.close(); await fixture.close(); }
});
