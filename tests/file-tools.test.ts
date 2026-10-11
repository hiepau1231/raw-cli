import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import type { FileEntry, PanelContext, PanelDocument } from "../src/panels/contract.js";
import { PanelHost } from "../src/panels/host.js";
import { validateDocument } from "../src/panels/validate.js";
import { openSessionStore } from "../src/sessions/store.js";
import { loadBundledTools, loadToolPlugins } from "../src/tools/plugins/loader.js";
import { ToolRegistry, type ToolPolicyRule } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";

/** Every registry here comes from the production loader, so normalization runs on the real path. */
async function registry(names: string[], rules: ToolPolicyRule[] = []): Promise<ToolRegistry> {
  const tools = new ToolRegistry(rules);
  for (const tool of await loadBundledTools(names)) tools.register(tool);
  return tools;
}
const text = (result: ToolResult) => result.content.map((block) => block.type === "text" ? block.text : "").join("");
const workdir = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const entries = (document: PanelDocument) => (document.blocks.find((block) => block.kind === "files") as { entries: FileEntry[] }).entries;

/** A panel host the way the agent wires one tool call to it. */
function panelContext(host: PanelHost, tools: ToolRegistry, name: string): { panels: PanelContext; settle: () => void } {
  const call = host.begin(`call-${Math.random()}`, tools.panelDeclarations(name)!);
  return { panels: call.context, settle: () => { call.settle(false); call.commit(); } };
}

test("1: read_file returns a numbered window with a range footer, for the canonical shape and every alias", async () => {
  const cwd = await workdir("raw-read-");
  await writeFile(join(cwd, "a.txt"), numbered(10));
  const tools = await registry(["read_file"]);
  const read = (args: Record<string, unknown>, maxOutputBytes = 8192) => tools.dispatch("read_file", args, { cwd, maxOutputBytes });

  const window = await read({ path: "a.txt", offset: 2, limit: 2 });
  assert.equal(text(window), "   2│line 2\n   3│line 3\n[lines 2–3 of 10; next: offset 4]");
  assert.deepEqual(window.host?.range, { start: 2, end: 3, total: 10 });
  assert.equal(window.host?.path, "a.txt");
  assert.equal(window.content.some((block) => block.type === "json"), false);
  assert.equal(JSON.stringify(window).includes("sha256"), false);

  assert.match(text(await read({ path: "a.txt" })), /  10│line 10\n\[lines 1–10 of 10; end of file\]$/);
  assert.equal(text(await read({ path: "a.txt", offset: 20 })), "[offset 20 is past the end: a.txt has 10 lines]");

  const same = "   2│line 2\n   3│line 3\n[lines 2–3 of 10; next: offset 4]";
  for (const args of [{ file_path: "a.txt", offset: 2, limit: 2 }, { filePath: "a.txt", start_line: 2, end_line: 3 },
    { absolute_path: join(cwd, "a.txt"), start_line: "2", max_lines: 2 }, { path: "a.txt", offset: 2, lines: 2 },
    { path: "a.txt", view_range: [2, 3] }]) {
    assert.equal(text(await read(args)), same, JSON.stringify(args));
  }
  assert.match(text(await read({ path: "a.txt", view_range: [9, -1] })), /^   9│line 9\n  10│line 10\n\[lines 9–10 of 10; end of file\]$/);
  // -1 reads to the end of the file, past the default limit, while the output budget still applies.
  await writeFile(join(cwd, "tall.txt"), numbered(3000));
  for (const args of [{ path: "tall.txt", view_range: [1, -1] }, { path: "tall.txt", start_line: 1, end_line: -1 }]) {
    const whole = text(await read(args, 1024 * 1024));
    assert.ok(/^ +1│line 1\n/.test(whole) && whole.endsWith("3000│line 3000\n[lines 1–3000 of 3000; end of file]"), JSON.stringify(args));
  }

  // A line far longer than the budget is cut, and its full length is still counted while only a prefix is kept.
  await writeFile(join(cwd, "wide.txt"), `${"x".repeat(300_000)}\nnext\n`);
  const wide = await read({ path: "wide.txt" }, 1024);
  assert.ok(Buffer.byteLength(text(wide)) <= 1024);
  assert.match(text(wide), /\[line 1 of 2 cut at the output budget \(300000 bytes\); next: offset 2\]$/);

  // A long file says how to continue; a budget smaller than the line limit ends the window early.
  await writeFile(join(cwd, "long.txt"), numbered(3000));
  assert.match(text(await read({ path: "long.txt" }, 1024 * 1024)), /\[lines 1–2000 of 3000; next: offset 2001\]$/);
  const tight = await read({ path: "long.txt", limit: 500 }, 400);
  assert.ok(Buffer.byteLength(text(tight)) <= 400);
  const next = /next: offset (\d+)/.exec(text(tight))?.[1];
  assert.ok(next && Number(next) > 1 && Number(next) < 500, text(tight));
  assert.equal(text(tight).split("\n").length - 1, Number(next) - 1);
});

test("2: write_file creates and overwrites, reading the aliases other harnesses send", async () => {
  const cwd = await workdir("raw-write-");
  const tools = await registry(["write_file"]);
  const created = await tools.dispatch("write_file", { file_path: "x/y.txt", content: "one\n" }, { cwd, maxOutputBytes: 8192, autoApprove: true });
  assert.equal(text(created), "Wrote 4 bytes to x/y.txt (created)");
  assert.deepEqual(created.host?.files, [{ path: "x/y.txt", action: "create", added: 1, removed: 0 }]);
  for (const [alias, value] of [["file_text", "two\n"], ["text", "three\n"], ["contents", "four\n"]]) {
    const result = await tools.dispatch("write_file", { filePath: "x/y.txt", [alias!]: value }, { cwd, maxOutputBytes: 8192, autoApprove: true });
    assert.equal(text(result), `Wrote ${value!.length} bytes to x/y.txt (overwritten)`, alias);
    assert.equal(await readFile(join(cwd, "x/y.txt"), "utf8"), value);
  }
  const big = await tools.dispatch("write_file", { absolute_path: join(cwd, "big.txt"), content: "z".repeat(1240) }, { cwd, maxOutputBytes: 8192, autoApprove: true });
  assert.equal(text(big), "Wrote 1,240 bytes to big.txt (created)");
});

test("3: edit_file replaces one exact match, refuses ambiguous or missing text, and replace_all changes every match", async () => {
  const cwd = await workdir("raw-edit-");
  const tools = await registry(["edit_file"]);
  const edit = (args: Record<string, unknown>) => tools.dispatch("edit_file", args, { cwd, maxOutputBytes: 8192, autoApprove: true });
  await writeFile(join(cwd, "app.ts"), "const a = 1;\nconst b = 1;\nconst a = 1;\nexport { a, b };\n");

  const ambiguous = await edit({ path: "app.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
  assert.equal(ambiguous.code, "edit_not_unique");
  assert.match(text(ambiguous), /old_string matches 2 times in app\.ts; add surrounding lines to make it unique or set replace_all\nMatching lines:\n1│const a = 1;\n3│const a = 1;$/);
  assert.equal(await readFile(join(cwd, "app.ts"), "utf8"), "const a = 1;\nconst b = 1;\nconst a = 1;\nexport { a, b };\n");

  const missing = await edit({ path: "app.ts", old_string: "const b = 2;", new_string: "const b = 3;" });
  assert.equal(missing.code, "edit_not_found");
  assert.match(text(missing), /old_string not found in app\.ts\nNearest lines:\n(.|\n)*2│const b = 1;/);

  const single = await edit({ file_path: "app.ts", old_str: "const b = 1;\n", new_str: "const b = 2;\nconst c = 3;\n" });
  assert.equal(text(single), "Edited app.ts: 1 replacement (+2 −1 lines)");
  assert.deepEqual(single.host?.files, [{ path: "app.ts", action: "edit", added: 2, removed: 1 }]);
  assert.match(single.host?.diff ?? "", /^--- a\/app\.ts\n\+\+\+ b\/app\.ts\n@@/);

  const all = await edit({ filePath: "app.ts", oldString: "const a = 1;", newString: "const a = 9;", allow_multiple: true });
  assert.equal(text(all), "Edited app.ts: 2 replacements (+2 −2 lines)");
  assert.equal(await readFile(join(cwd, "app.ts"), "utf8"), "const a = 9;\nconst b = 2;\nconst c = 3;\nconst a = 9;\nexport { a, b };\n");
  const replaceAll = await edit({ path: "app.ts", old_text: "const a = 9;", new_text: "", replaceAll: true });
  assert.equal(text(replaceAll), "Edited app.ts: 2 replacements (+2 −2 lines)");
  assert.equal(await readFile(join(cwd, "app.ts"), "utf8"), "\nconst b = 2;\nconst c = 3;\n\nexport { a, b };\n");

  // Overlapping matches are ambiguous too: "aa" starts twice in "aaa".
  await writeFile(join(cwd, "run.txt"), "aaa\n");
  const overlapping = await edit({ path: "run.txt", old_string: "aa", new_string: "X" });
  assert.equal(overlapping.code, "edit_not_unique");
  assert.match(text(overlapping), /matches 2 times[\s\S]*\nMatching lines:\n1│aaa$/);
  assert.equal(await readFile(join(cwd, "run.txt"), "utf8"), "aaa\n");

  // A CRLF file matches an LF old_string and keeps its endings; bytes that are not UTF-8 survive an edit elsewhere.
  await writeFile(join(cwd, "dos.txt"), Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("\r\none\r\ntwo\r\n")]));
  const crlf = await edit({ path: "dos.txt", old_string: "one\ntwo\n", new_string: "one\n2\n" });
  assert.equal(text(crlf), "Edited dos.txt: 1 replacement (+1 −1 lines)");
  assert.deepEqual(await readFile(join(cwd, "dos.txt")), Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("\r\none\r\n2\r\n")]));
});

test("4: old batch, operation and patch shapes are rejected with an example of the new shape", async () => {
  const cwd = await workdir("raw-old-shapes-");
  const tools = await registry(["read_file", "write_file"]);
  const context = { cwd, maxOutputBytes: 8192, autoApprove: true };
  const read = await tools.dispatch("read_file", { files: [{ path: "a" }] }, context);
  assert.equal(read.code, "invalid_arguments");
  assert.match(text(read), /read_file reads one file: \{"path":"src\/app\.ts","offset":120,"limit":80\}/);
  for (const args of [{ operations: [{ path: "a", mode: "overwrite", content: "x" }] }, { patch: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" }]) {
    const write = await tools.dispatch("write_file", args, context);
    assert.equal(write.code, "invalid_arguments");
    assert.match(text(write), /write_file writes one whole file: \{"path":"notes\/todo\.md","content":"# Todo\\n"\}; use edit_file/);
  }
  await assert.rejects(readFile(join(cwd, "a")), { code: "ENOENT" });
});

test("5: a policy rule on effects files[*].path covers edit_file and apply_patch", async () => {
  const cwd = await workdir("raw-file-effects-");
  await writeFile(join(cwd, "secret.env"), "KEY=1\n");
  const rule: ToolPolicyRule = { match: "builtin/*", effect: "ask", when: { source: "effects", any: "files[*].path", regex: "secret" } };
  const tools = await registry(["edit_file", "apply_patch"], [rule]);
  const asked: Array<{ identity: string; effects: unknown }> = [];
  const context = { cwd, maxOutputBytes: 8192, approve: (request: { identity: string; effects?: unknown }) => { asked.push({ identity: request.identity, effects: request.effects }); return false; } };
  assert.equal((await tools.dispatch("edit_file", { path: "secret.env", old_string: "KEY=1", new_string: "KEY=2" }, context)).code, "approval_denied");
  assert.equal((await tools.dispatch("apply_patch", { patch: "*** Begin Patch\n*** Update File: secret.env\n@@\n-KEY=1\n+KEY=3\n*** End Patch" }, context)).code, "approval_denied");
  assert.deepEqual(asked, [
    { identity: "builtin/edit_file", effects: { files: [{ path: join(cwd, "secret.env"), operation: "edit" }] } },
    { identity: "builtin/apply_patch", effects: { files: [{ path: join(cwd, "secret.env"), operation: "write" }] } },
  ]);
  assert.equal(await readFile(join(cwd, "secret.env"), "utf8"), "KEY=1\n");
  await writeFile(join(cwd, "open.txt"), "a\n");
  assert.equal((await tools.dispatch("edit_file", { path: "open.txt", old_string: "a", new_string: "b" }, context)).isError, false);
  assert.equal(asked.length, 2);
});

test("6: write_file, edit_file and apply_patch publish to one host-owned panel with complete line counts", async () => {
  const cwd = await workdir("raw-shared-panel-");
  await writeFile(join(cwd, "edit.txt"), "one\ntwo\nthree\n");
  await writeFile(join(cwd, "patch.txt"), "alpha\nbeta\n");
  const tools = await registry(["write_file", "edit_file", "apply_patch"]);
  for (const name of ["write_file", "edit_file", "apply_patch"]) assert.equal(tools.panelDeclarations(name)?.owner, "host/files_changed");
  const host = new PanelHost();
  const run = async (name: string, args: Record<string, unknown>) => {
    const call = panelContext(host, tools, name);
    const result = await tools.dispatch(name, args, { cwd, maxOutputBytes: 8192, autoApprove: true, panels: call.panels });
    call.settle();
    assert.equal(result.isError, false, text(result));
    return result;
  };
  await run("write_file", { path: "new.txt", content: "a\nb\n" });
  await run("edit_file", { path: "edit.txt", old_string: "two\n", new_string: "2\n2b\n" });
  const patched = await run("apply_patch", { patch: "*** Begin Patch\n*** Update File: patch.txt\n@@\n-alpha\n+ALPHA\n beta\n*** End Patch" });
  assert.equal(text(patched), "M patch.txt (+1 −1)");
  const panels = host.snapshot();
  assert.deepEqual(panels.map((panel) => panel.panelId), ["host/files_changed#files_changed"]);
  const files = entries(panels[0]!.document);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.added, file.removed]), [
    [join(cwd, "new.txt"), "added", 2, 0], [join(cwd, "edit.txt"), "modified", 2, 1], [join(cwd, "patch.txt"), "modified", 1, 1]]);
  assert.match(files[1]!.diff!, /-two\n\+2\n\+2b/);
  validateDocument(panels[0]!.document);
  host.close();
});

for (const [name, args, file] of [
  ["edit_file", { path: "target.txt", old_string: "before", new_string: "after" }, "target.txt"],
  ["apply_patch", { patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-before\n+after\n*** End Patch" }, "target.txt"],
] as const) {
  test(`7: an aborted turn keeps the completed ${name} write in the panel and in history`, async () => {
    const cwd = await workdir(`raw-abort-${name}-`);
    await writeFile(join(cwd, file), "before\n");
    const store = openSessionStore({ env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd } });
    const sessionId = store.createSession({ cwd, title: "abort" }).id;
    const agent = createAgent({ cwd, registry: await registry([name]), autoApprove: true, maxOutputBytes: 8192, maxSteps: 2,
      persistence: { store, sessionId, surface: "cli" },
      provider: { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
        generate: async () => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "abort-call", name, arguments: args }] }) } });
    try {
      const result = await agent.run("edit", (event) => { if (event.type === "panel_update" && event.live && event.owner === "host/files_changed") agent.abort(); });
      assert.equal(result.status, "cancelled");
      assert.equal(await readFile(join(cwd, file), "utf8"), "after\n");
      const saved = store.listSessionPanels(sessionId);
      assert.deepEqual(saved.map((panel) => panel.panelId), ["host/files_changed#files_changed"]);
      assert.deepEqual(entries(saved[0]!.document).map((entry) => [entry.path, entry.added, entry.removed]), [[join(cwd, file), 1, 1]]);
    } finally { await agent.close(); store.close(); }
  });
}

test("7b: a local tool named edit_file is not given the completed-write callback", async () => {
  const root = await workdir("raw-local-edit-");
  const folder = join(root, "tools", "edit_file");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "edit_file", version: "1.0.0", name: "edit_file", description: "local copy",
    input_schema: { type: "object", properties: {}, additionalProperties: false }, entry: "./index.mjs" }));
  await writeFile(join(folder, "index.mjs"), `export async function handler(args, context) {
  return { isError: false, content: [{ type: "text", text: typeof context.onWriteCompleted }] };
}`);
  await writeFile(join(root, "raw.json"), "{}");
  const tools = new ToolRegistry();
  for (const plugin of await loadToolPlugins({ selectedIds: ["agent/edit_file"], configPath: join(root, "raw.json"), cwd: root })) tools.register(plugin.registration);
  const result = await tools.dispatch("edit_file", {}, { cwd: root, maxOutputBytes: 8192, autoApprove: true, onWriteCompleted: () => {} });
  assert.equal(text(result), "undefined");
  assert.notEqual(tools.panelDeclarations("edit_file")?.owner, "host/files_changed");
});

test("8: a 500-line edit reports complete counts while the stored diff stays bounded", async () => {
  const cwd = await workdir("raw-large-edit-");
  const before = Array.from({ length: 500 }, (_, index) => `old line ${index} ${"x".repeat(60)}`).join("\n") + "\n";
  const after = Array.from({ length: 500 }, (_, index) => `new line ${index} ${"y".repeat(60)}`).join("\n") + "\n";
  await writeFile(join(cwd, "big.txt"), `head\n${before}tail\n`);
  const tools = await registry(["edit_file"]);
  const host = new PanelHost();
  const call = panelContext(host, tools, "edit_file");
  const result = await tools.dispatch("edit_file", { path: "big.txt", old_string: before, new_string: after }, { cwd, maxOutputBytes: 8192, autoApprove: true, panels: call.panels });
  call.settle();
  assert.equal(text(result), "Edited big.txt: 1 replacement (+500 −500 lines)");
  assert.deepEqual(result.host?.files, [{ path: "big.txt", action: "edit", added: 500, removed: 500 }]);
  assert.ok(result.host?.diffOmitted === true || Buffer.byteLength(result.host?.diff ?? "") <= 64 * 1024);
  const entry = entries(host.snapshot()[0]!.document)[0]!;
  assert.deepEqual([entry.added, entry.removed], [500, 500]);
  assert.ok(Buffer.byteLength(entry.diff ?? "") <= 64 * 1024);
  host.close();
});

test("9: view_image reads file_path as path through the production loader", async () => {
  const cwd = await workdir("raw-view-image-");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(cwd, "dot.png"), png);
  const result = await (await registry(["view_image"])).dispatch("view_image", { file_path: "dot.png" }, { cwd, maxOutputBytes: 8192 });
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.find((block) => block.type === "image")?.type, "image");
});
