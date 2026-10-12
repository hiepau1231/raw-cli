import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolStart, formatToolResult } from "../src/terminal/tools.js";
import { projectToolCall, projectToolResult } from "../src/sessions/visible.js";
import { resolveUiOptions, terminalCapabilities } from "../src/terminal/options.js";
import { bundledDisplay } from "./fixtures/display.js";
import { Writable } from "node:stream";
import { sharedInteractiveTerminal } from "../src/terminal/renderer.js";
import { renderMarkdown } from "../src/terminal/markdown.js";
import { formatStats, formatTurnFooter } from "../src/terminal/footer.js";
import { renderTerminalHistory } from "../src/terminal/history.js";
import { decor } from "../src/terminal/theme.js";
import { TerminalWriter } from "../src/terminal/writer.js";
import { TerminalRenderer } from "../src/terminal/renderer.js";
import { receiptLine, renderPanelText } from "../src/panels/render.js";
import type { HistoryItem } from "../src/sessions/store.js";

const caps = terminalCapabilities(true, { TERM: "xterm" }, resolveUiOptions({ color: "always" }));
const strip = (text: string) => text.replace(/\u001b\[[0-9;]+m/g, "");

test("builtin actions have distinct type icons and status is independent", () => {
  const ui = resolveUiOptions({ color: "always" });
  const read = projectToolCall("read_file", "builtin/read_file", { path: "src/index.ts" }, true, bundledDisplay("read_file"));
  const command = projectToolCall("bash", "builtin/bash", { command: "pwd" }, true, bundledDisplay("bash"));
  assert.equal(strip(formatToolStart(read, ui, caps, 80)), "↳ Read  src/index.ts\n");
  assert.equal(strip(formatToolStart(command, ui, caps, 80)), "$ Run command  pwd\n");
  const failed = projectToolResult("bash", "builtin/bash", { isError: false,
    content: [{ type: "text", text: "permission denied" }], exitCode: 13 }, 120, bundledDisplay("bash"));
  const result = strip(formatToolResult(failed, ui, caps, 80));
  assert.match(result, /^✗ exit 13 · 120ms/);
  assert.match(result, /permission denied/);
});

test("normal and compact density preserve failed reads, bash exit codes and generic tool identity", () => {
  const result = projectToolResult("read_file", "builtin/read_file", { isError: true, code: "ENOENT", content: [{ type: "text", text: "b.txt does not exist" }] }, undefined, bundledDisplay("read_file"));
  const exited = projectToolResult("bash", "builtin/bash", { isError: false,
    content: [{ type: "text", channel: "stdout", text: "out" }, { type: "text", text: "[exit 3 · 0.1s]" }], host: { exitCode: 3, status: "ok" } }, undefined, bundledDisplay("bash"));
  for (const density of ["compact", "normal", "verbose"] as const) {
    const ui = resolveUiOptions({ density, color: "always" });
    const rendered = strip(formatToolResult(result, ui, caps, 40));
    assert.match(rendered, /✗ error · ENOENT/);
    assert.match(rendered, /b\.txt does not exist/);
    assert.match(strip(formatToolResult(exited, ui, caps, 40)), /✗ exit 3/);
  }
  // An MCP tool named like a built-in keeps the MCP icon and the generic summary.
  const custom = projectToolCall("read_file", "mcp/server/read_file", { query: "test" }, true);
  assert.equal(strip(formatToolStart(custom, resolveUiOptions({}), caps, 80)), "↗ Read file  test\n");
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
  const call = projectToolCall("apply_patch", "builtin/apply_patch", { patch: "*** Begin Patch\n*** Add File: hello.txt\n+private-patch-content\n*** End Patch" }, true, bundledDisplay("apply_patch"));
  const printed = strip(formatToolStart(call, resolveUiOptions({}), caps, 120));
  assert.equal(printed, "✎ Patch  hello.txt\n");
  assert.doesNotMatch(printed, /private-patch-content/);
  for (const [name, args] of [["write_file", { path: "notes.txt", content: "private-write-content" }],
    ["edit_file", { path: "notes.txt", old_string: "private-old", new_string: "private-new" }]] as const) {
    const shown = strip(formatToolStart(projectToolCall(name, `builtin/${name}`, args, true, bundledDisplay(name)), resolveUiOptions({ density: "verbose" }), caps, 120));
    assert.match(shown, /notes\.txt/);
    assert.doesNotMatch(shown, /private-/);
  }
});

test("Windows consoles get rich mode when both streams are terminals", () => {
  const tty = { isTTY: true, fd: 1 };
  assert.equal(sharedInteractiveTerminal("win32", { stdout: tty, stderr: { isTTY: true, fd: 2 } }, {}), true);
  assert.equal(sharedInteractiveTerminal("win32", { stdout: tty, stderr: { isTTY: false, fd: 2 } }, {}), false);
  assert.equal(sharedInteractiveTerminal("win32", { stdout: { isTTY: false, fd: 1 }, stderr: tty }, {}), false);
  assert.equal(sharedInteractiveTerminal("win32", { stdout: tty, stderr: tty }, { TERM: "dumb" }), false);
});

test("with ASCII decorations every glyph Raw draws itself is ASCII", () => {
  const ui = resolveUiOptions({ color: "never", density: "verbose" });
  const ascii = terminalCapabilities(true, {}, ui, "win32");
  assert.equal(ascii.ascii, true);
  const sample: string[] = [];
  // Tool start and result: icons, separators, the changed-line counts and the hidden-lines and omitted-JSON markers.
  sample.push(formatToolStart(projectToolCall("read_file", "builtin/read_file", { path: "a.ts" }, true, bundledDisplay("read_file")), ui, ascii, 80));
  sample.push(formatToolStart(projectToolCall("bash", "builtin/bash", { command: "pwd" }, false, bundledDisplay("bash")), ui, ascii, 80));
  sample.push(formatToolStart(projectToolCall("bash", "builtin/bash", { command: `echo ${"x".repeat(200)}` }, true, bundledDisplay("bash")), ui, ascii, 80));
  const failed = projectToolResult("bash", "builtin/bash", { isError: true, code: "ENOENT", truncated: true,
    content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") }] }, undefined, bundledDisplay("bash"));
  sample.push(formatToolResult(failed, ui, ascii, 80));
  const edited = projectToolResult("edit_file", "builtin/edit_file", { isError: false, content: [{ type: "text", text: "ok" }],
    host: { files: [{ path: "a.ts", added: 2, removed: 1 }] } } as never, undefined, bundledDisplay("edit_file"));
  sample.push(formatToolResult(edited, ui, ascii, 80));
  const json = projectToolResult("mcp", "mcp/s/t", { isError: false, content: Array.from({ length: 30 }, (_, index) => ({ type: "text" as const,
    text: JSON.stringify({ index, items: Array.from({ length: 50 }, (_, item) => `value ${item}`) }) })) }, undefined, undefined);
  sample.push(formatToolResult(json, ui, ascii, 80));
  // Markdown table rules and a horizontal rule.
  sample.push(renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n", ui, ascii, 80));
  // Footer, stats, history (hook, thinking, panel receipt) and the plain panel text.
  const stats = { requests: 1, inputTokensKnown: 10, inputCoverage: 1, outputTokensKnown: 5, outputCoverage: 1, cacheReadTokensKnown: 0,
    cacheWriteTokensKnown: 0, cacheReadCoverage: 1, cacheWriteCoverage: 0, cacheRatioCoverage: 0 } as never;
  sample.push(formatTurnFooter({ status: "error", code: "provider_error", elapsedMs: 1200, startedToolCalls: 2, notRunToolCalls: 1, stats,
    contextTokens: 500, contextReported: true, contextWindow: 1000, inputBudget: 400, compactTrigger: 300, sessionId: "s", resumable: true, ui, caps: ascii }));
  sample.push(formatStats(stats, ui, ascii, { elapsedMs: 1000, firstTextMs: 200 }));
  const item = (kind: string, payload: Record<string, unknown>) => ({ id: 1, sessionId: "s", runId: "r", kind, payload, createdAt: 0 }) as unknown as HistoryItem;
  sample.push(renderTerminalHistory(item("hook_event", { id: "guard", event: "PreToolUse", outcome: "error", message: "blocked" }), ui, ascii, 80));
  sample.push(renderTerminalHistory(item("reasoning", { text: "x" }), ui, ascii, 80));
  sample.push(renderTerminalHistory(item("panel_receipt", { title: "Todo", revision: 2, summary: "1/2" }), ui, ascii, 80));
  const checklist = decor(renderPanelText("Todo", { blocks: [{ kind: "checklist", items: [{ id: "a", label: "A", status: "failed", note: "why" },
    { id: "b", label: "B", status: "done" }] }] } as never), ascii);
  assert.match(checklist, /\[F\] A - why\n\[x\] B/, "a failed item stays distinct from a done one");
  sample.push(checklist);
  sample.push(decor(receiptLine({ title: "Todo", revision: 1, error: { code: "invalid", message: "x" } } as never), ascii));
  // The plain renderer's warning, failure and read marks.
  sample.push(decor("raw: ⚠ x\nraw: ✗ x · y\nraw: ↳ x", ascii));
  // The spinner.
  const frames: string[] = [];
  let tick: (() => void) | undefined;
  const writer = new TerminalWriter(new Writable({ write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); } }), true,
    { interval: ((callback: () => void) => { tick = callback; return 1 as never; }) as unknown as typeof setInterval, clear: (() => {}) as typeof clearInterval }, 80, ascii.ascii);
  writer.activity(decor("Compacting…", ascii));
  for (let index = 0; index < 4; index++) tick?.();
  writer.finish();
  sample.push(frames.join(""));
  const text = sample.join("\n");
  assert.match(text, /\| Compacting[\s\S]*\/ Compacting[\s\S]*- Compacting[\s\S]*\\ Compacting/, "the spinner turned");
  assert.equal([...text].filter((character) => character.codePointAt(0)! > 0x7f).join(""), "", text);
  // The same sample keeps its Unicode decorations where the terminal draws them.
  assert.match(formatToolResult(failed, ui, terminalCapabilities(true, { WT_SESSION: "1" }, ui, "win32"), 80), /✗.*·/);
});

test("the plain renderer draws a long call and a cut preview in ASCII when icons are ascii", () => {
  const session = { toolIdentity: () => "builtin/bash", toolDisplay: () => bundledDisplay("bash") } as never;
  const renderer = new TerminalRenderer(session, { ui: resolveUiOptions({ color: "never", icons: "ascii" }) } as never, process.cwd(), false);
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    renderer.event({ type: "tool_call", id: "g", name: "bash", arguments: { command: `echo ${"y".repeat(200)}` } });
    renderer.event({ type: "tool_start", id: "s", name: "bash", arguments: { command: `echo ${"x".repeat(200)}` } });
    renderer.event({ type: "tool_result", id: "s", name: "bash", arguments: { command: `echo ${"x".repeat(200)}` },
      result: { isError: false, content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `match ${index} ${"z".repeat(300)}`).join("\n") }] } });
    renderer.event({ type: "tool_result", id: "g", name: "bash", arguments: { command: `echo ${"y".repeat(200)}` },
      result: { isError: true, code: "approval_denied", content: [{ type: "text", text: "denied" }] } });
  } finally { process.stderr.write = write; }
  const output = written.join("");
  assert.match(output, /\.\.\./, "the cut summary and preview are marked");
  assert.match(output, /raw: ! /, "the call that never ran is marked");
  assert.equal([...output].filter((character) => character.codePointAt(0)! > 0x7f).join(""), "", output);
});
