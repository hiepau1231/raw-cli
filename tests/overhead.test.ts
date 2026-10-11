import assert from "node:assert/strict";
import { test } from "node:test";
import { countOverhead } from "../scripts/overhead.mjs";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";

test("production prompt is minimal and built-in schema overhead is measurable", () => {
  const report = countOverhead();
  assert.equal(report.definitions.length, 3);
  assert.ok(report.promptTokens <= 50);
  assert.ok(Number.isSafeInteger(report.combinedTokens) && report.combinedTokens >= report.promptTokens);
  assert.equal(JSON.parse(report.canonical).tools.length, 3);
});

test("model-facing tool definitions explain the required workflows", async () => {
  const editing = (await loadBundledTools(["edit_file", "apply_patch"])).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  const tools = Object.fromEntries([...countOverhead().definitions, ...editing].map((definition) => [definition.name, definition]));
  assert.match(tools.read_file!.description, /\{"path":"src\/app\.ts","offset":120,"limit":80\}/);
  assert.match(tools.read_file!.description, /\[lines 120–199 of 431; next: offset 200\]/);
  assert.match(tools.read_file!.description, /several calls/);
  assert.match(tools.write_file!.description, /\{"path":"notes\/todo\.md","content":"# Todo\\n"\}/);
  assert.match(tools.write_file!.description, /edit_file/);
  assert.match(tools.edit_file!.description, /occur once/);
  assert.match(tools.edit_file!.description, /replace_all/);
  assert.match(tools.edit_file!.description, /most similar lines/);
  assert.match(tools.apply_patch!.description, /\*\*\* Begin Patch/);
  assert.match(tools.apply_patch!.description, /\*\*\* Move to:/);
  assert.match(tools.bash!.description, /\[exit 0 · 1\.2s\]/);
  assert.match(tools.bash!.description, /timeout/);
  assert.match(tools.bash!.description, /\{"command":"npm test","timeout":300000,"description":"Run the test suite"\}/);
  assert.match(tools.bash!.description, /several calls/);
  assert.match(tools.bash!.description, /run_in_background.*process tool/);
  for (const tool of Object.values(tools)) {
    const root = tool!.inputSchema as Record<string, unknown>;
    const properties = root.properties as Record<string, Record<string, unknown>>;
    for (const [name, property] of Object.entries(properties)) {
      assert.equal(typeof property.description, "string", `${tool!.name}.${name} needs a description`);
      const itemProperties = (property.items as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {};
      for (const [field, schema] of Object.entries(itemProperties)) {
        assert.equal(typeof schema.description, "string", `${tool!.name}.${name}[].${field} needs a description`);
      }
    }
  }
  const image = createTestToolRegistry([], true).definitions().find((definition) => definition.name === "view_image");
  assert.match(image!.description, /native image block/);
  assert.equal(typeof (image!.inputSchema.properties!.path as { description?: string }).description, "string");
});
