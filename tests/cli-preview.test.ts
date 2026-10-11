import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToolResult, renderPlainToolResult } from "../src/sessions/visible.js";

const preview = (name: string, identity: string | undefined, value: unknown, isError = false) =>
  renderPlainToolResult(projectToolResult(name, identity, { isError, content: [{ type: "json", value }] }));

test("MCP JSON results arrays remain generic and do not throw on null rows", () => {
  for (const value of [
    { results: [null] },
    { results: [{ title: "hit" }], total: 12 },
  ]) {
    assert.equal(preview("mcp_search", "mcp/server/mcp_search", value), JSON.stringify(value));
  }
});

test("write and bash JSON values are shown as is: no built-in result is parsed as batch rows", () => {
  const rows = { results: [{ index: 0, status: "ok", path: "a.txt" }, { index: 1, status: "error", error: "nope" }] };
  assert.equal(preview("write_file", "builtin/write_file", rows, true), JSON.stringify(rows));
  assert.equal(preview("bash", "builtin/bash", rows), JSON.stringify(rows));
});
