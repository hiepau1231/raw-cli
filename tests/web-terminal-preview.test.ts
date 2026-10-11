import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTerminalPreview } from "../web/src/tool-cards/terminal.js";

// A command's saved preview (src/tools/primitives.ts bashTool, src/sessions/visible.ts bounded): `[stdout]`/`[stderr]`
// open each channel block, one status line ends it, and a long preview keeps four lines around a hidden-lines notice.

test("stdout and stderr blocks lose their markers and the exit line becomes the exit", () => {
  const preview = parseTerminalPreview("[stdout]\n> lint\n[stderr]\nscripts/a.mjs:3:5  error  Missing semicolon\n[exit 1 · 0.1s]");
  assert.deepEqual(preview.lines, [
    { text: "> lint", channel: "stdout" },
    { text: "scripts/a.mjs:3:5  error  Missing semicolon", channel: "stderr" },
  ]);
  assert.deepEqual(preview.exit, { code: 1, seconds: 0.1 });
});

test("stderr only, with a two-digit exit and a longer time", () => {
  const preview = parseTerminalPreview("[stderr]\nbroken\nalso broken\n[exit 23 · 12.4s]");
  assert.deepEqual(preview.lines.map((line) => line.channel), ["stderr", "stderr"]);
  assert.deepEqual(preview.exit, { code: 23, seconds: 12.4 });
});

test("text without markers is unchanged and has no channel or exit", () => {
  const text = "first line\n  indented second\n\nlast";
  const preview = parseTerminalPreview(text);
  assert.deepEqual(preview.lines.map((line) => line.text), ["first line", "  indented second", "", "last"]);
  assert.ok(preview.lines.every((line) => line.channel === undefined));
  assert.equal(preview.exit, undefined);
});

test("a line that only starts with a marker's text, or an exit line in the middle, stays output", () => {
  const preview = parseTerminalPreview("[stdout]\n[stdout] said hello\n[exit 0 · 1.0s]\n[stderr]x\nlast\n[exit 0 · 0.3s]");
  assert.deepEqual(preview.lines.map((line) => line.text), ["[stdout] said hello", "[exit 0 · 1.0s]", "[stderr]x", "last"]);
  assert.ok(preview.lines.every((line) => line.channel === "stdout"));
  assert.deepEqual(preview.exit, { code: 0, seconds: 0.3 });
});

test("after a hidden-lines notice the channel is unknown until the next marker", () => {
  // The `[stderr]` marker fell inside the hidden lines: the tail's channel cannot be known.
  const preview = parseTerminalPreview("[stdout]\n1\n2\n3\n… [40 lines hidden] …\nerr a\nerr b\nerr c\n[exit 2 · 0.5s]");
  assert.deepEqual(preview.lines, [
    { text: "1", channel: "stdout" },
    { text: "2", channel: "stdout" },
    { text: "3", channel: "stdout" },
    { text: "… [40 lines hidden] …", notice: true },
    { text: "err a" },
    { text: "err b" },
    { text: "err c" },
  ]);
  assert.deepEqual(preview.exit, { code: 2, seconds: 0.5 });
  // A marker after the notice makes the channel known again.
  const again = parseTerminalPreview("[stdout]\n1\n… [9 lines hidden] …\nx\n[stderr]\ny\n[exit 1 · 0.2s]");
  assert.deepEqual(again.lines.map((line) => line.channel), ["stdout", undefined, undefined, "stderr"]);
});

test("other status lines stay as notices, and the exit is absent when no exit line ends the preview", () => {
  const timedOut = parseTerminalPreview("[stdout]\nwaiting\n[timed out after 3s; process group stopped]");
  assert.deepEqual(timedOut.lines, [
    { text: "waiting", channel: "stdout" },
    { text: "[timed out after 3s; process group stopped]", notice: true },
  ]);
  assert.equal(timedOut.exit, undefined);
  // Notes after the exit line (a clamped timeout) do not hide it.
  const clamped = parseTerminalPreview("[stdout]\nok\n[exit 0 · 0.0s]\n[timeout clamped to 600000 ms]");
  assert.deepEqual(clamped.exit, { code: 0, seconds: 0 });
  assert.deepEqual(clamped.lines.at(-1), { text: "[timeout clamped to 600000 ms]", notice: true });
});
