import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileTool } from "../src/tools/primitives.js";
import { buildWriteChanges } from "../src/tools/write-changes.js";
import { unifiedDiff } from "../src/tools/line-diff.js";
import { validateDocument } from "../src/panels/validate.js";
import type { PanelDocument, PanelContext, FileEntry } from "../src/panels/contract.js";

const entries = (doc: PanelDocument) => (doc.blocks.find(b => b.kind === "files") as {entries: FileEntry[]}).entries;

test("successful writes accumulate normalized paths, preserve added status, count lines and omit failed writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-changes-"));
  let document: PanelDocument | undefined;
  const panels: PanelContext = { protocol: 2, get: () => document ? { revision: 1, document } : undefined,
    update: async (_id, update) => { assert.equal(update.op, "replace"); if (update.op === "replace") document = update.document; return { revision: 1 }; } };
  try {
    await mkdir(join(cwd, "directory"));
    assert.equal((await writeFileTool({ path: "a", content: "one\n" }, { cwd, panels, maxOutputBytes: 4096 })).isError, false);
    assert.equal((await writeFileTool({ path: "directory", content: "fails" }, { cwd, panels, maxOutputBytes: 4096 })).isError, true);
    await writeFileTool({ path: "b", content: "two" }, { cwd, panels, maxOutputBytes: 4096 });
    assert.deepEqual(entries(document!).map(e => e.path), [join(cwd, "a"), join(cwd, "b")]);
    await writeFileTool({ path: "./a", content: "updated\nmore\n" }, { cwd, panels, maxOutputBytes: 4096 });
    assert.equal(entries(document!).length, 2);
    const a = entries(document!).find(e => e.path === join(cwd, "a"));
    assert.equal(a?.status, "added");
    // Counts accumulate over the session: +1 from the create, then +2 −1 from the overwrite; the diff is the latest one.
    assert.deepEqual([a?.added, a?.removed], [3, 1]);
    assert.match(a!.diff!, /-one\n\+updated\n\+more/);
    validateDocument(document);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("entry counts come from the whole change while the stored entry diff stays bounded", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `row ${i}`);
  const after = before.map((row, i) => i % 3 === 0 ? `${row} edited` : row);
  const doc = buildWriteChanges(undefined, [{ path: "/p/big.txt", kind: "modified", before: Buffer.from(before.join("\n")), after: Buffer.from(after.join("\n")) }]);
  const [entry] = entries(doc);
  assert.deepEqual([entry?.added, entry?.removed], [1000, 1000]);
  assert.ok(Buffer.byteLength(entry!.diff!) <= 8 * 1024 + 32);
  assert.match(entry!.diff!, /\[diff truncated\]$/);
  // Counts do not stop at the preview's source limit and see changes that display sanitizing would hide.
  const huge = "row\n".repeat(2_300_000);
  const large = buildWriteChanges(undefined, [{ path: "/p/huge.txt", kind: "modified", before: Buffer.from(huge + "old\n"), after: Buffer.from(huge + "new\n") }]);
  assert.deepEqual([entries(large)[0]?.added, entries(large)[0]?.removed], [1, 1]);
  const control = buildWriteChanges(undefined, [{ path: "/p/ctl", kind: "modified", before: Buffer.from("a\u000b\n"), after: Buffer.from("a\u000c\n") }]);
  assert.deepEqual([entries(control)[0]?.added, entries(control)[0]?.removed], [1, 1]);
  const partial = buildWriteChanges(undefined, [{ path: "/p/partial", kind: "modified", before: Buffer.from("a\n"), beforePartial: true, after: Buffer.from("b\n") }]);
  assert.equal(entries(partial)[0]?.added, undefined, "a partial snapshot has no counts");
  // Known, then unknown, then known again: the session total stays unknown instead of skipping a write.
  let mixed = buildWriteChanges(undefined, [{ path: "/p/m", kind: "added", after: Buffer.from("a\n") }]);
  assert.equal(entries(mixed)[0]?.added, 1);
  mixed = buildWriteChanges(mixed, [{ path: "/p/m", kind: "modified", before: Buffer.from("a\n"), beforePartial: true, after: Buffer.from("b\n") }]);
  mixed = buildWriteChanges(structuredClone(mixed), [{ path: "/p/m", kind: "modified", before: Buffer.from("b\n"), after: Buffer.from("z\n") }]);
  assert.deepEqual([entries(mixed)[0]?.added, entries(mixed)[0]?.removed], [undefined, undefined]);
  validateDocument(mixed);
  const binary = buildWriteChanges(doc, [{ path: "/p/bin", kind: "added", after: Buffer.from([0, 1, 2]) }]);
  const bin = entries(binary).find(e => e.path === "/p/bin");
  assert.equal(bin?.added, undefined, "binary content has no line counts");
  assert.equal(bin?.diff, undefined);
  validateDocument(binary);
});

test("an old tool-owned Files changed panel is stale on resume next to the one shared host panel", async () => {
  const { knownPanelDeclarations, isStalePanel } = await import("../src/panels/declarations.js");
  const { buildPanelStack } = await import("../src/panels/stack.js");
  const runtime = { toolIds: ["builtin/write_file", "builtin/edit_file", "builtin/apply_patch"], configPath: join(tmpdir(), "none.json"),
    globalConfigRoot: tmpdir(), packageTools: {}, availableMcpServers: {}, packageMcpIdentities: {} };
  const known = await knownPanelDeclarations(runtime as never);
  assert.deepEqual(known.declared.map(item => `${item.owner}#${item.declaration.id}`), ["host/files_changed#files_changed"]);
  const document = buildWriteChanges(undefined, [{ path: "/p/a", kind: "added", after: Buffer.from("a\n") }]);
  const old = { panelId: "builtin/write_file#files_changed", owner: "builtin/write_file", revision: 3, createdAt: 1, updatedAt: 1, closed: false,
    declaration: known.declared[0]!.declaration, document };
  assert.equal(isStalePanel(old.panelId, known), true);
  assert.equal(isStalePanel("host/files_changed#files_changed", known), false);
  const stack = buildPanelStack(known, [old]);
  assert.deepEqual(stack.map(item => [item.panel, item.stale, item.document === null]),
    [["host/files_changed#files_changed", false, true], ["builtin/write_file#files_changed", true, false]], "the old data stays visible, marked stale");
});

test("Files changed is bounded after reload and rename records both paths", () => {
  let document: PanelDocument | undefined;
  for (let i = 0; i < 210; i++) document = buildWriteChanges(document, [{ path: `/p/${i}`, kind: "added", after: Buffer.from("x".repeat(40000)) }]);
  document = buildWriteChanges(structuredClone(document), [{ path: "/p/new", oldPath: "/p/209", kind: "renamed", before: Buffer.from("x"), after: Buffer.from("y") }]);
  assert.ok(entries(document).length <= 200);
  assert.match(document.summary!, /omitted/);
  assert.match(JSON.stringify(document), /209.*new/);
  assert.match(JSON.stringify(document), /truncated|Recent diff/);
  assert.ok(Buffer.byteLength(JSON.stringify(document)) <= 65536);
  validateDocument(document);
});

test("panel failure does not report completed filesystem writes as failed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-changes-"));
  try {
    const result = await writeFileTool({ path: "a", content: "done" }, { cwd, maxOutputBytes: 4096,
      panels: { protocol: 2, get: () => undefined, update: async () => { throw new Error("panel limit"); } } });
    assert.equal(result.isError, false);
    assert.equal(await readFile(join(cwd, "a"), "utf8"), "done");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a cancelled turn keeps a completed write, skips the next call and survives session reload", async () => {
  const { createAgent } = await import("../src/agent.js");
  const { openSessionStore } = await import("../src/sessions/store.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { loadBundledTools } = await import("../src/tools/plugins/loader.js");
  const cwd = await mkdtemp(join(tmpdir(), "raw-write-abort-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: cwd, XDG_CONFIG_HOME: cwd } });
  const sessionId = store.createSession({ cwd, title: "write abort" }).id;
  const registry = new ToolRegistry();
  for (const tool of await loadBundledTools(["write_file"])) registry.register(tool);
  const agent = createAgent({ cwd, registry, autoApprove: true, maxOutputBytes: 8192, maxSteps: 2, persistence: { store, sessionId, surface: "cli" },
    provider: { modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture" },
      generate: async () => ({ text: "", finishReason: "tool_calls", toolCalls: [
        { id: "write-completed", name: "write_file", arguments: { path: "completed", content: "yes" } },
        { id: "write-skipped", name: "write_file", arguments: { path: "skipped", content: "no" } }] }) } });
  try {
    const result = await agent.run("write", event => { if (event.type === "panel_update" && event.live && event.owner === "host/files_changed") agent.abort(); });
    assert.equal(result.status, "cancelled");
    assert.equal(await readFile(join(cwd, "completed"), "utf8"), "yes");
    await assert.rejects(readFile(join(cwd, "skipped")), { code: "ENOENT" });
    const saved = store.listSessionPanels(sessionId);
    assert.deepEqual(saved.map(panel => panel.panelId), ["host/files_changed#files_changed"]);
    assert.deepEqual(entries(saved[0]!.document).map(e => e.path), [join(cwd, "completed")]);
    const { PanelHost } = await import("../src/panels/host.js");
    const restored = new PanelHost({ initial: saved });
    assert.deepEqual(restored.snapshot(), saved);
    restored.close();
  } finally { await agent.close(); store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("write-only existing files still overwrite successfully and unavailable snapshots are explicit", async () => {
  const { chmod, writeFile } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "raw-write-only-"));
  const path = join(cwd, "private");
  let document: PanelDocument | undefined;
  try {
    await writeFile(path, "old");
    await chmod(path, 0o200);
    const result = await writeFileTool({ path, content: "new" }, { cwd, maxOutputBytes: 4096,
      panels: { protocol: 2, get: () => undefined, update: async (_id, update) => { if (update.op === "replace") document = update.document; return { revision: 1 }; } } });
    assert.equal(result.isError, false);
    assert.equal(entries(document!)[0]?.status, "modified");
    if (process.getuid?.() !== 0 && process.platform !== "win32") assert.match(JSON.stringify(document), /diff unavailable/);
    await chmod(path, 0o600);
    assert.equal(await readFile(path, "utf8"), "new");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("invalid or oversized display paths are omitted honestly without failing document validation", () => {
  const doc = buildWriteChanges(undefined, [{ path: "/" + "a".repeat(600), kind: "added", after: Buffer.from("x") },
    { path: "/newline\nfile", kind: "added", after: Buffer.from("y") }]);
  assert.equal(entries(doc).length, 0);
  assert.equal(doc.summary, "0 paths shown; 2 history entries omitted");
  validateDocument(doc);
});

const diffText = (doc: PanelDocument) => (doc.blocks.find(b => b.id === "recent_diff") as { text: string }).text;

test("Recent diff shows each changed region with context instead of the start of the file", () => {
  const before = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after[149] = "changed 150";
  after.splice(280, 0, "inserted after 280");
  const doc = buildWriteChanges(undefined, [{ path: "/p/big.ts", kind: "modified",
    before: Buffer.from(before.join("\n") + "\n"), after: Buffer.from(after.join("\n") + "\n") }]);
  const text = diffText(doc);
  assert.match(text, /    @@ -147,7 \+147,7 @@\n     line 147\n     line 148\n     line 149\n    -line 150\n    \+changed 150\n     line 151/);
  assert.match(text, /    @@ -278,6 \+278,7 @@\n(.*\n){3}    \+inserted after 280\n/);
  assert.doesNotMatch(text, /line 1\n|line 100\n/);
  assert.doesNotMatch(text, /diff truncated/);
  validateDocument(doc);
});

test("unified diff covers added files, bounds its size and degrades binary content", () => {
  assert.equal(unifiedDiff("", "a\nb\n", 1000).text, "@@ -0,0 +1,2 @@\n+a\n+b");
  assert.equal(unifiedDiff("a\nb\n", "", 1000).text, "@@ -1,2 +0,0 @@\n-a\n-b");
  const long = unifiedDiff("", Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n"), 2000);
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text) <= 2000);
  const binary = buildWriteChanges(undefined, [{ path: "/p/bin", kind: "modified", before: Buffer.from([0, 1, 2]), after: Buffer.from([0, 1, 3]) }]);
  assert.match(diffText(binary), /\[binary content: 3 → 3 bytes\]/);
});

test("an overwrite deep inside a large file shows that change in Recent diff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-changes-"));
  let document: PanelDocument | undefined;
  const panels: PanelContext = { protocol: 2, get: () => document ? { revision: 1, document } : undefined,
    update: async (_id, update) => { if (update.op === "replace") document = update.document; return { revision: 1 }; } };
  try {
    const rows = Array.from({ length: 4000 }, (_, i) => `row ${i + 1}`);
    await writeFileTool({ path: "big.txt", content: rows.join("\n") }, { cwd, panels, maxOutputBytes: 4096 });
    rows[3499] = "edited row 3500";
    await writeFileTool({ path: "big.txt", content: rows.join("\n") }, { cwd, panels, maxOutputBytes: 4096 });
    assert.match(diffText(document!), /    @@ -3497,7 \+3497,7 @@[\s\S]*    -row 3500\n    \+edited row 3500/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("unified diff keeps sparse edits apart in large files, marks a missing final newline and never hides part of a line silently", () => {
  const rows = Array.from({ length: 20000 }, (_, i) => `row ${i}`);
  const edited = [...rows];
  edited[10] = "first edit";
  edited[19000] = "second edit";
  const sparse = unifiedDiff(rows.join("\n") + "\n", edited.join("\n") + "\n", 6000);
  assert.equal(sparse.truncated, false);
  assert.deepEqual(sparse.text.match(/^@@.*@@$/gm), ["@@ -8,7 +8,7 @@", "@@ -18998,7 +18998,7 @@"]);
  assert.match(sparse.text, /-row 19000\n\+second edit/);
  assert.equal(unifiedDiff("a\nb\n", "a\nb", 1000).text, "@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file");
  const long = unifiedDiff("x\n", `${"y".repeat(2000)}\n`, 1000);
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text) <= 1000);
  assert.match(long.text, /\+y+…$/);
  const everything = unifiedDiff(Array.from({ length: 300000 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 300000 }, (_, i) => `b${i}`).join("\n"), 6144);
  assert.equal(everything.truncated, true);
  assert.ok(Buffer.byteLength(everything.text) <= 6144);
});
