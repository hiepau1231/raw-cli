import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPackage } from "../src/packages/inspect.js";

const ROOT = "examples/packages/goal-kit";

test("goal kit manifest exports the agent, tool, hook and skill", async () => {
  const report = await inspectPackage(ROOT);
  assert.equal(report.name, "@raw/goal-kit");
  assert.equal(report.version, "1.0.0");
  assert.deepEqual(report.exports.agents, ["coder"]);
  assert.deepEqual(report.exports.tools, ["goal"]);
  assert.deepEqual(report.exports.hooks, ["goal"]);
  assert.deepEqual(report.exports.skills, ["goal"]);
  assert.deepEqual(report.requires, [
    "raw.agent/1",
    "raw.hook/2",
    "raw.panel/2",
    "raw.skill/1",
    "raw.stop-continue/1",
    "raw.tool-api/2",
  ]);
  assert.deepEqual(report.prerequisites, ["node"]);
});
