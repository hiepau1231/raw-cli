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

test("only valid built-in batch rows get indexed status summaries", () => {
  const valid = { results: [{ index: 0, status: "ok", path: "a.txt" }, { index: 1, status: "error", error: "nope" }] };
  assert.match(preview("write_file", "builtin/write_file", valid, true),
    /^statuses: 0:ok 1:error\n/);
  const malformed = { results: [null] };
  assert.equal(preview("write_file", "builtin/write_file", malformed),
    JSON.stringify(malformed));
  // bash returns text with a status line; a JSON value from it is shown as is.
  assert.equal(preview("bash", "builtin/bash", valid), JSON.stringify(valid));
});
