import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolStart, formatToolResult } from "../src/terminal/tools.js";
import { projectToolCall, projectToolResult } from "../src/sessions/visible.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";

const caps = terminalCapabilities(true, { TERM: "xterm" }, resolveUiOptions({ color: "always" }));
const strip = (text: string) => text.replace(/\u001b\[[0-9;]+m/g, "");

test("builtin actions have distinct type icons and status is independent", () => {
  const ui = resolveUiOptions({ color: "always" });
  const read = projectToolCall("read_file", "builtin/read_file", { path: "src/index.ts" }, true);
  const command = projectToolCall("bash", "builtin/bash", { command: "pwd" }, true);
  assert.match(strip(formatToolStart(read, ui, caps, 80)), /↳ read_file.*src\/index.ts/);
  assert.match(strip(formatToolStart(command, ui, caps, 80)), /\$ bash.*pwd/);
  const failed = projectToolResult("bash", "builtin/bash", { isError: true,
    content: [{ type: "text", text: "permission denied" }], exitCode: 13 }, 120);
  const result = strip(formatToolResult(failed, ui, caps, 80));
  assert.match(result, /✗ bash.*exit 13.*120ms/);
  assert.match(result, /permission denied/);
});

test("normal and compact density preserve failed reads, bash exit codes and generic tool identity", () => {
  const result = projectToolResult("read_file", "builtin/read_file", { isError: true, code: "ENOENT", content: [{ type: "text", text: "b.txt does not exist" }] });
  const exited = projectToolResult("bash", "builtin/bash", { isError: false,
    content: [{ type: "text", channel: "stdout", text: "out" }, { type: "text", text: "[exit 3 · 0.1s]" }], host: { exitCode: 3, status: "ok" } });
  for (const density of ["compact", "normal", "verbose"] as const) {
    const ui = resolveUiOptions({ density, color: "always" });
    const rendered = strip(formatToolResult(result, ui, caps, 40));
    assert.match(rendered, /✗ read_file/);
    assert.match(rendered, /b\.txt does not exist/);
    assert.match(strip(formatToolResult(exited, ui, caps, 40)), /✗ bash.*exit 3/);
  }
  const custom = projectToolCall("read_file", "mcp/server/read_file", { query: "test" }, true);
  assert.match(strip(formatToolStart(custom, resolveUiOptions({}), caps, 80)), /↗ read_file.*query/);
  assert.match(strip(formatToolStart(custom, resolveUiOptions({ density: "verbose" }), caps, 80)), /mcp\/server\/read_file/);
});

test("tool-provided control bytes cannot erase terminal output", () => {
  const ui = resolveUiOptions({ color: "always" });
  const call = projectToolCall("bash", "builtin/bash", { command: "printf '\u001b[2J'" }, true);
  const result = projectToolResult("bash", "builtin/bash", { isError: false, content: [{ type: "text", text: "\u001b[2Jdanger" }] });
  const shown = formatToolStart(call, ui, caps, 80) + formatToolResult(result, ui, caps, 80);
  assert.doesNotMatch(shown, /\u001b\[2J/);
  assert.match(shown, /␛\[2Jdanger/);
});

test("terminal patch summary names paths without printing patch contents", () => {
  const call = projectToolCall("apply_patch", "builtin/apply_patch", { patch: "*** Begin Patch\n*** Add File: hello.txt\n+private-patch-content\n*** End Patch" }, true);
  const printed = strip(formatToolStart(call, resolveUiOptions({}), caps, 120));
  assert.match(printed, /hello.txt/);
  assert.match(printed, /patch/);
  assert.doesNotMatch(printed, /private-patch-content/);
  for (const [name, args] of [["write_file", { path: "notes.txt", content: "private-write-content" }],
    ["edit_file", { path: "notes.txt", old_string: "private-old", new_string: "private-new" }]] as const) {
    const shown = strip(formatToolStart(projectToolCall(name, `builtin/${name}`, args, true), resolveUiOptions({ density: "verbose" }), caps, 120));
    assert.match(shown, /notes\.txt/);
    assert.doesNotMatch(shown, /private-/);
  }
});
