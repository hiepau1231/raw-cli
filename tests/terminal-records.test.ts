import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectToolCall, projectToolResult, renderPlainToolResult } from "../src/sessions/visible.js";
import { initializeSessionSchema, SESSION_SCHEMA_VERSION } from "../src/sessions/schema.js";
import { openSessionStore } from "../src/sessions/store.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { testConfig } from "./fixtures/config.js";

async function raw(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

test("long read results keep both ends within the preview bounds, failed or not", () => {
  const body = Array.from({ length: 800 }, (_, index) => `${String(index + 1).padStart(4)}│const value${index} = ${index};`).join("\n");
  for (const isError of [false, true]) {
    const projected = projectToolResult("read_file", "builtin/read_file", {
      isError, content: [{ type: "text", text: `${body}\n[lines 1–800 of 900; next: offset 801]` }],
      host: { path: "src/a.ts", range: { start: 1, end: 800, total: 900 } },
    }, 23);
    assert.equal(projected.failed, isError);
    assert.deepEqual(projected.rows, []);
    assert.ok(projected.segments.reduce((count, segment) => count + [...segment.text].length, 0) <= 2000);
    assert.ok(projected.segments.length <= 9);
    assert.equal(projected.durationMs, 23);
    assert.deepEqual(projected.host?.range, { start: 1, end: 800, total: 900 });
    const plain = renderPlainToolResult(projected);
    // A successful window is path-tagged code without the gutter; an error result stays plain text.
    assert.match(plain, isError ? /^   1│const value0 = 0;/ : /^const value0 = 0;/);
    if (!isError) assert.ok(projected.segments.filter(segment => segment.kind === "code").every(segment => segment.path === "src/a.ts"));
    assert.equal(projected.segments.at(-1)?.kind, "text");
    assert.match(plain, /\[lines 1–800 of 900; next: offset 801\]$/);
    assert.match(plain, /hidden/);
  }
});

test("custom and MCP tools that mimic a built-in name remain generic", () => {
  const result = { isError: false, content: [{ type: "json" as const, value: {
    results: [{ index: 0, path: "secret.ts", status: "ok", text: "const secret = 1;" }],
  } }] };
  for (const identity of ["local/fake_read", "mcp/server/read_file", undefined]) {
    const projected = projectToolResult("read_file", identity, result);
    assert.deepEqual(projected.rows, []);
    assert.ok(projected.segments.every((segment) => segment.kind !== "code"));
    assert.match(renderPlainToolResult(projected), /"results"/);
  }
});

test("character cap keeps both ends across nine medium-sized preview lines", () => {
  const content = Array.from({ length: 9 }, (_, index) =>
    `${index === 0 ? "HEAD" : index === 8 ? "TAIL" : `middle${index}`}${"x".repeat(220)}`).join("\n");
  const projected = projectToolResult("search", "mcp/server/search", { isError: false,
    content: [{ type: "text", text: content }] });
  const preview = renderPlainToolResult(projected);
  assert.ok([...preview].length <= 2000);
  assert.match(preview, /HEAD/);
  assert.match(preview, /TAIL/);
  assert.match(preview, /hidden/);
  assert.ok(projected.segments.length <= 9);
});

test("display calls retain Bash commands and omit write payload values", () => {
  const command = "printf 'a'.repeat(200)";
  const bash = projectToolCall("bash", "builtin/bash", { command }, false);
  assert.match(JSON.stringify(bash), /printf/);
  const write = projectToolCall("write_file", "builtin/write_file", { path: "src/a.ts", content: "private-value" }, true);
  assert.deepEqual(write.arguments, { path: "src/a.ts", content_bytes: 13 });
  const edit = projectToolCall("edit_file", "builtin/edit_file", { path: "src/a.ts", old_string: "private-old", new_string: "private-value", replace_all: true }, true);
  assert.deepEqual(edit.arguments, { path: "src/a.ts", old_string_bytes: 11, new_string_bytes: 13, replace_all: true });
  const patch = projectToolCall("apply_patch", "builtin/apply_patch", { patch: "*** Begin Patch\n*** Add File: src/a.ts\n+private-value\n*** End Patch" }, true);
  assert.deepEqual((patch.arguments as { patch_paths: string[] }).patch_paths, ["src/a.ts"]);
  assert.doesNotMatch(JSON.stringify(patch), /private-value/);
  // The display projection sees the model's arguments before normalization: aliases and old shapes still hide payloads.
  for (const [name, args] of [
    ["write_file", { file_path: "src/a.ts", file_text: "private-value" }],
    ["write_file", { operations: [{ path: "src/a.ts", mode: "overwrite", content: "private-value" }] }],
    ["write_file", { path: "src/a.ts", patch: "*** Begin Patch\n*** Add File: b\n+private-value\n*** End Patch" }],
    ["edit_file", { path: "src/a.ts", old_str: "private-old", new_str: "private-value" }],
    ["apply_patch", { input: "*** Begin Patch\n*** Add File: b\n+private-value\n*** End Patch" }],
  ] as const) {
    assert.doesNotMatch(JSON.stringify(projectToolCall(name, `builtin/${name}`, args, false)), /private-/, `${name} ${Object.keys(args).join(",")}`);
  }
});

test("schema 6 rejects a prior schema without mutation", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA user_version = 4");
    assert.throws(() => initializeSessionSchema(database), /schema version: 4/);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 4);
    database.exec("PRAGMA user_version = 0");
    initializeSessionSchema(database);
    assert.equal(SESSION_SCHEMA_VERSION, 6);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 6);
  } finally { database.close(); }
});

test("CLI read preview survives process restart as path-tagged code without changing provider result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-display-history-"));
  writeFileSync(join(cwd, "sample.ts"), "const answer = 42;\n");
  const env = { ...process.env, XDG_STATE_HOME: join(cwd, "state"), XDG_CONFIG_HOME: join(cwd, "config"), OPENAI_API_KEY: "key" };
  const provider = await startMockProvider([
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "read-one", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ path: "sample.ts" }),
    } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Found it" }, "stop"), openAiDone] },
  ]);
  try {
    const config = testConfig("openai", "fixture", provider.url);
    const result = await raw(["--config", config, "read code"], cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Found it\n");
    assert.match(JSON.stringify(provider.requests[1]?.body), /const answer = 42/);
    const store = openSessionStore({ env });
    let id: string;
    try {
      id = store.listSessions({ cwd }).items[0]!.id;
      const item = store.getSessionHistory({ sessionId: id }).items.find((entry) => entry.kind === "tool_result");
      const display = item?.payload.display as ReturnType<typeof projectToolResult>;
      assert.equal(display.identity, "builtin/read_file");
      assert.ok(display.segments.some((segment) => segment.kind === "code" && segment.path === "sample.ts"
        && segment.text.includes("const answer = 42")));
    } finally { store.close(); }
    const replay = await raw(["sessions", "show", id], cwd, env);
    assert.equal(replay.code, 0, replay.stderr);
    assert.match(replay.stdout, /const answer = 42/);
  } finally { await provider.close(); }
});
