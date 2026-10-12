import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ToolRegistry } from "../src/tools/registry.js";
import { compileWhen, matchesWhen } from "../src/tools/policy.js";

const schema = { type: "object" as const, properties: { files: { type: "array", items: { type: "object",
  properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  required: ["files"], additionalProperties: false };

function fixture(rules: ConstructorParameters<typeof ToolRegistry>[0], descriptor?: (args: Record<string, unknown>, context: { cwd: string }) => unknown) {
  const registry = new ToolRegistry(rules);
  let invoked = 0;
  registry.register({ name: "write", canonicalName: "local/write", description: "write",
    inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
    conditionSources: ["effects"], effectsSchema: schema,
    describeEffects: descriptor ?? ((_args, context) => ({ files: [{ path: resolve(context.cwd, "protected.txt") }] })),
    handler: async () => { invoked++; return { isError: false, content: [{ type: "text", text: "done" }] }; },
  });
  return { registry, invoked: () => invoked };
}

test("effect predicates ask before handler without synthesizing arguments", async () => {
  const { registry, invoked } = fixture([{ match: "local/write", effect: "ask",
    when: { source: "effects", any: "files[*].path", regex: "protected\\.txt$" } }]);
  const args = { patch: "original patch" };
  const observed: unknown[] = [];
  const result = await registry.dispatch("write", args, { cwd: "/workspace", maxOutputBytes: 8192,
    onHook: async (_event, _identity, _name, original, _result, effects) => { observed.push({ original, effects }); return {}; },
    approve: (request) => { observed.push(request); return false; },
  });
  assert.equal(result.code, "approval_denied");
  assert.equal(invoked(), 0);
  assert.deepEqual(args, { patch: "original patch" });
  assert.deepEqual((observed[0] as { original: unknown }).original, args);
  assert.deepEqual((observed[1] as { arguments: unknown }).arguments, args);
  // Effect paths are absolute for the platform: on Windows "/workspace" is on the current drive.
  assert.deepEqual((observed[1] as { effects: unknown }).effects, { files: [{ path: resolve("/workspace/protected.txt") }] });
});

test("descriptor failure or invalid effects never invokes the handler", async () => {
  for (const descriptor of [() => { throw new Error("bad descriptor"); }, () => ({ files: [{ path: 1 }] })]) {
    const { registry, invoked } = fixture([], descriptor);
    const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
    assert.equal(result.isError, true);
    assert.equal(invoked(), 0);
  }
});

test("condition source is mandatory and cannot fall back to arguments", () => {
  assert.throws(() => compileWhen({ any: "patch", regex: ".*" } as never));
  assert.throws(() => fixture([{ match: "local/write", effect: "ask", when: { source: "arguments", any: "patch", regex: ".*" } }]));
  const when = compileWhen({ source: "effects", any: "files[*].path", regex: "protected" });
  assert.equal(matchesWhen(when, { files: [{ path: "protected" }] }, {}), false);
  assert.equal(matchesWhen(when, {}, { files: [{ path: "protected" }] }), true);
});

test("effects are prepared once from current input and cannot be mutated by hooks", async () => {
  let described = 0;
  const { registry, invoked } = fixture([], (args, context) => {
    described++;
    return { files: [{ path: resolve(context.cwd, String(args.patch)) }] };
  });
  for (const path of ["one.txt", "nested/two.txt"]) {
    let received = "";
    const result = await registry.dispatch("write", { patch: path }, { cwd: "/workspace", maxOutputBytes: 8192,
      onHook: async (event, _identity, _name, args, _result, effects) => {
        assert.equal(args.patch, path);
        const files = effects!.files as Array<{ path: string }>;
        received = files[0]!.path;
        assert.throws(() => { files[0]!.path = "/different"; }, TypeError);
        assert.equal(event === "PreToolUse" || event === "PostToolUse", true);
        return {};
      },
    });
    assert.equal(result.isError, false);
    assert.equal(received, resolve("/workspace", path));
  }
  assert.equal(described, 2);
  assert.equal(invoked(), 2);
  assert.doesNotThrow(() => registry.definitions());
});

test("unconditional deny prevents descriptor execution and invalid effects schemas do not register", async () => {
  let described = 0;
  const { registry } = fixture([{ match: "local/write", effect: "deny" }], () => { described++; return { files: [] }; });
  const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
  assert.equal(result.code, "tool_denied");
  assert.equal(described, 0);
  const asyncFixture = fixture([], () => Promise.resolve({ files: [] }));
  assert.equal((await asyncFixture.registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 })).code, "invalid_effects");
  const invalid = new ToolRegistry();
  assert.throws(() => invalid.register({ name: "bad", description: "bad", inputSchema: { type: "object" },
    effectsSchema: { type: "object", $ref: "https://example.invalid/schema" }, conditionSources: ["effects"],
    describeEffects: () => ({}), handler: async () => ({ isError: false, content: [] }) }));
  assert.equal(invalid.definitions().length, 0);
});

test("gates receive only the validated serialized effects snapshot", async () => {
  for (const descriptor of [
    () => Object.create({ files: [{ path: "/protected.txt" }] }),
    () => ({ files: [{ path: "/protected.txt" }], toJSON: () => ({}) }),
  ]) {
    const { registry, invoked } = fixture([], descriptor);
    const result = await registry.dispatch("write", { patch: "p" }, { cwd: "/workspace", maxOutputBytes: 8192 });
    assert.equal(result.isError, true);
    assert.equal(invoked(), 0);
  }
});

test("input schema is fully checked before descriptor even with a permissive semantic validator", async () => {
  let described = 0;
  let validated = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "nested", description: "nested", inputSchema: { type: "object", required: ["operations"],
    properties: { operations: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", required: ["path"],
      properties: { path: { type: "string", minLength: 1 }, mode: { enum: ["create", "replace"] } }, additionalProperties: false } } }, additionalProperties: false },
    effectsSchema: schema, conditionSources: ["effects"],
    describeEffects: () => { described++; return { files: [] }; },
    validateArgs: () => { validated++; return undefined; }, handler: async () => ({ isError: false, content: [] }) });
  for (const operations of ["not an array", [], [{ path: 1 }], [{ path: "a", mode: "delete" }], [{ path: "a" }, { path: "b" }, { path: "c" }]]) {
    assert.equal((await registry.dispatch("nested", { operations }, { cwd: "/workspace", maxOutputBytes: 8192 })).code, "invalid_arguments");
  }
  assert.equal(described, 0);
  assert.equal(validated, 5);
});

test("async effects descriptors fail one call without an unhandled rejection", () => {
  const script = `import { ToolRegistry } from './src/tools/registry.ts';
    for (const describeEffects of [async () => ({}), async () => { throw new Error('async failure'); }, () => ({then(resolve, reject) { reject(new Error('thenable failure')); }})]) {
      let invoked = 0;
      const registry = new ToolRegistry();
      registry.register({ name:'bad', description:'bad', inputSchema:{type:'object'}, effectsSchema:{type:'object'},
        conditionSources:['effects'], describeEffects, handler:async () => { invoked++; return {isError:false,content:[]}; } });
      const result = await registry.dispatch('bad', {}, {cwd:process.cwd(),maxOutputBytes:8192});
      if (!result.isError || invoked) throw new Error('async descriptor accepted');
    }
    await new Promise(resolve => setImmediate(resolve));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("builtin write_file, edit_file and apply_patch share effects gates including rename destinations", async () => {
  const { readFile } = await import("node:fs/promises");
  const registry = new ToolRegistry(["write_file", "edit_file", "apply_patch"].map((id) => (
    { match: `builtin/${id}`, effect: "ask" as const, when: { source: "effects" as const, any: "files[*].path", regex: "protected\\.txt$" } })));
  for (const id of ["write_file", "edit_file", "apply_patch"]) {
    const { describeEffects, validateArgs, handler } = await import(`../src/tools/bundled/${id}/index.js`);
    const manifest = JSON.parse(await readFile(new URL(`../src/tools/bundled/${id}/tool.json`, import.meta.url), "utf8"));
    registry.register({ name: id, canonicalName: `builtin/${id}`, description: id, inputSchema: manifest.input_schema,
      conditionSources: ["effects"], effectsSchema: manifest.effects_schema, describeEffects, validateArgs, handler });
  }
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["write_file", { path: "protected.txt", content: "no" }, "write"],
    ["edit_file", { path: "protected.txt", old_string: "old", new_string: "new" }, "edit"],
    ["apply_patch", { patch: "*** Begin Patch\n*** Add File: protected.txt\n+no\n*** End Patch" }, "write"],
    ["apply_patch", { patch: "*** Begin Patch\n*** Delete File: protected.txt\n*** End Patch" }, "delete"],
    ["apply_patch", { patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: protected.txt\n@@\n-old\n+new\n*** End Patch" }, "rename_destination"],
  ];
  for (const [name, args, operation] of cases) {
    let approved = false;
    const result = await registry.dispatch(name, args, { cwd: "/nonexistent-phase7", maxOutputBytes: 8192,
      approve: (request) => {
        approved = true;
        assert.deepEqual(request.arguments, args);
        assert.ok((request.effects!.files as Array<{ path: string; operation: string }>)
          .some(f => f.path === resolve("/nonexistent-phase7/protected.txt") && f.operation === operation));
        return false;
      } });
    assert.equal(approved, true);
    assert.equal(result.code, "approval_denied");
    const denied = await registry.dispatch(name, args, { cwd: "/nonexistent-phase7", maxOutputBytes: 8192, autoApprove: true,
      onHook: async (event, _identity, _name, original, _result, effects) => { assert.deepEqual(original, args); assert.ok(effects); return event === "PreToolUse" ? { blocked: "denied", reason: "protected" } : {}; } });
    assert.equal(denied.code, "hook_denied");
  }
  const write = await import("../src/tools/bundled/write_file/index.js");
  const patch = await import("../src/tools/bundled/apply_patch/index.js");
  assert.match(write.validateArgs({ patch: cases[2]![1].patch })!, /apply_patch for patches/);
  assert.ok(write.validateArgs({}));
  assert.ok(patch.validateArgs({}));
  assert.ok(patch.validateArgs({ patch: "malformed" }));
  assert.throws(() => patch.describeEffects({ patch: "malformed" }, { cwd: "/tmp" }));
});

test("patch validator does not invent cwd aliases and real effects reject actual aliases", async () => {
  const { validateArgs, describeEffects } = await import("../src/tools/bundled/apply_patch/index.js");
  // An absolute path for the platform: on Windows "/a" alone would be read as drive A:, so it is spelled with its drive.
  const top = resolve("/a");
  const patch = `*** Begin Patch\n*** Add File: ../a\n+one\n*** Add File: ${top.replaceAll("\\", "/")}\n+two\n*** End Patch`;
  assert.equal(validateArgs({ patch }), undefined);
  assert.deepEqual(describeEffects({ patch }, { cwd: resolve("/work/project") }), { files: [
    { path: resolve("/work/a"), operation: "write" }, { path: top, operation: "write" },
  ] });
  assert.throws(() => describeEffects({ patch }, { cwd: resolve("/work") }));
});
