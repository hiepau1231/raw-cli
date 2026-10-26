import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, lineCount } from "../web/src/files/format.js";

test("lineCount counts the lines of the text, not its newlines", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("one"), 1);
  assert.equal(lineCount("one\n"), 1);
  assert.equal(lineCount("one\ntwo"), 2);
  assert.equal(lineCount("one\ntwo\n"), 2);
  assert.equal(lineCount("one\r\ntwo\r\n"), 2);
  assert.equal(lineCount("one\r\n\r\ntwo"), 3);
  assert.equal(lineCount("\n"), 1);
});

test("formatBytes picks the unit and drops a zero fraction", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024 KB");
  assert.equal(formatBytes(1024 * 1024), "1 MB");
  assert.equal(formatBytes(5.25 * 1024 * 1024), "5.3 MB");
});
