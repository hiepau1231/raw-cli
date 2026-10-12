import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { fileURLToPath } from "node:url";
import { resolveToolPath } from "../src/platform/paths.js";

/** How a stopped bash call ends: Windows stops the whole job, elsewhere the process group. */
const STOPPED = process.platform === "win32" ? "process tree stopped" : "process group stopped";

const context = (cwd: string, maxOutputBytes = 8192) => ({ cwd, maxOutputBytes, autoApprove: true });

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((block) => block.type === "text" ? block.text : "").join("");

test("files resolve per session, create parents, accept empty content and surface errors", async () => {
  const [a, b] = await Promise.all([mkdtemp(join(tmpdir(), "raw-a-")), mkdtemp(join(tmpdir(), "raw-b-"))]);
  const registry = createTestToolRegistry();
  await Promise.all([
    registry.dispatch("write_file", { path: "nested/item", content: "alpha" }, context(a)),
    registry.dispatch("write_file", { path: "nested/item", content: "beta" }, context(b)),
  ]);
  assert.equal(await readFile(join(a, "nested/item"), "utf8"), "alpha");
  assert.equal(await readFile(join(b, "nested/item"), "utf8"), "beta");
  const empty = await registry.dispatch("write_file", { path: join(a, "empty"), content: "" }, context(b));
  assert.equal(empty.isError, false);
  assert.equal(await readFile(join(a, "empty"), "utf8"), "");
  const read = await registry.dispatch("read_file", { path: "nested/item" }, context(b));
  assert.equal(read.content[0]?.type, "text");
  assert.equal(text(read), "   1│beta\n[lines 1–1 of 1; end of file]");
  assert.equal((await registry.dispatch("read_file", { path: "missing" }, context(a))).isError, true);
  assert.equal((await registry.dispatch("read_file", { path: a }, context(a))).isError, true);
  await writeFile(join(a, "utf8"), "😀".repeat(20));
  // A line longer than the output budget is cut on a character boundary and names the next offset.
  const bounded = await registry.dispatch("read_file", { path: "utf8" }, context(a, 240));
  assert.match(text(bounded), /^   1│(😀)+ …\[line cut\]\n\[line 1 of 1 cut at the output budget \(80 bytes\); next: offset 2\]$/);
  assert.ok(!text(bounded).includes("\uFFFD"));
  await writeFile(join(a, "replacement"), "\uFFFDx");
  const replacement = await registry.dispatch("read_file", { path: "replacement" }, context(a));
  assert.equal(text(replacement).split("\n")[0], "   1│\uFFFDx");
  await writeFile(join(a, "bom"), "\uFEFFabc");
  const bom = await registry.dispatch("read_file", { path: "bom" }, context(a));
  assert.equal(text(bom).split("\n")[0], "   1│\uFEFFabc");
});

test("bash preserves output channels, exit status and bounded UTF-8 while draining large pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-"));
  const registry = createTestToolRegistry();
  const result = await registry.dispatch("bash", { command: "printf hi; printf err >&2; exit 7" }, context(cwd));
  assert.equal(result.host?.exitCode, 7);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.filter((block) => block.type === "text" && block.channel).map((block) => block.type === "text" ? [block.channel, block.text] : []),
    [["stdout", "hi"], ["stderr", "err"]]);
  assert.match(text(result), /\[exit 7 · \d+\.\ds\]$/);
  const exact = await registry.dispatch("bash", { command: "printf abcde" }, context(cwd));
  assert.equal(exact.truncated ?? false, false);
  assert.equal(exact.host?.fullOutputPath, undefined);
  assert.match(text(exact), /^abcde\n?\[exit 0 · /);
  const huge = await registry.dispatch("bash", { command: "node -e 'process.stdout.write(\"😀\"+\"x\".repeat(200000))'" }, context(cwd, 512));
  assert.equal(huge.host?.exitCode, 0);
  assert.ok(huge.host?.fullOutputPath, "the oversized output names its saved copy");
  assert.ok(Buffer.byteLength(text(huge)) <= 512);
  assert.ok(text(huge).startsWith("😀"), "the head keeps whole UTF-8 characters");
  assert.ok(!text(huge).includes("\uFFFD"));
  assert.equal(Buffer.byteLength(await readFile(huge.host.fullOutputPath, "utf8")), 200004);
  const timeout = await registry.dispatch("bash", { command: "sleep 5", timeout: 20 }, context(cwd));
  assert.equal(timeout.host?.status, "timeout");
  assert.match(text(timeout), new RegExp(`\\[timed out after 0\\.02s; ${STOPPED}\\]$`));
  assert.notEqual(timeout.host?.exitCode, 0);
});

test("abort kills owned shell descendants and leaves unrelated processes running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-tree-"));
  const marker = join(cwd, "owned");
  const unrelated = join(cwd, "unrelated");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ok'), 900)", unrelated], { stdio: "ignore" });
  const otherExited = new Promise((resolve) => other.once("exit", resolve));
  const controller = new AbortController();
  const task = createTestToolRegistry().dispatch("bash", { command: `node ${JSON.stringify(fileURLToPath(new URL("./fixtures/process-tree.cjs", import.meta.url)))} ${JSON.stringify(marker)}` }, { ...context(cwd), signal: controller.signal });
  let ownedPid = 0;
  for (let i = 0; i < 100; i++) {
    try { ownedPid = Number(await readFile(marker + ".ready", "utf8")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(ownedPid > 0, "descendant started before abort");
  controller.abort();
  const result = await task;
  assert.equal(result.host?.status, "cancelled");
  assert.match(text(result), new RegExp(`\\[aborted after \\d+\\.\\ds; ${STOPPED}\\]$`));
  await otherExited;
  await new Promise((resolve) => setTimeout(resolve, 250));
  let ownedRunning = false;
  try { process.kill(ownedPid, 0); ownedRunning = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if (ownedRunning && process.platform === "linux") {
    const status = await readFile(`/proc/${ownedPid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    ownedRunning = status ? status.slice(status.lastIndexOf(")") + 2, status.lastIndexOf(")") + 3) !== "Z" : false;
  }
  assert.equal(ownedRunning, false, "owned descendant exited or is a harmless Linux zombie");
  await assert.rejects(access(marker));
  await assert.rejects(access(marker + ".parent"));
  assert.equal(await readFile(unrelated, "utf8"), "ok");
  const pre = new AbortController();
  pre.abort();
  assert.equal((await createTestToolRegistry().dispatch("bash", { command: `touch ${JSON.stringify(marker)}` }, { ...context(cwd), signal: pre.signal })).code, "aborted");
});

test("timeout settles even when an escaped descendant holds inherited output pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-escaped-"));
  const pidFile = join(cwd, "pid");
  const started = Date.now();
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  try {
    const result = await createTestToolRegistry().dispatch("bash", {
      command: `node ${JSON.stringify(fileURLToPath(new URL("./fixtures/escaped-pipes.cjs", import.meta.url)))} ${JSON.stringify(pidFile)}`,
      timeout: 300,
    }, context(cwd));
    assert.equal(result.host?.status, "timeout");
    assert.ok(Date.now() - started < 2500, "settles inside cancellation budget");
  } finally {
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* fixture may not have started */ }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length <= timersBefore, "no owned timeout remains after settlement");
});

test("file tools read Git Bash drive paths on Windows and leave other paths and platforms alone", () => {
  assert.equal(resolveToolPath("C:\\work", "/c/tmp/x", "win32"), "C:\\tmp\\x");
  assert.equal(resolveToolPath("C:\\work", "/d/a b/y.txt", "win32"), "D:\\a b\\y.txt");
  assert.equal(resolveToolPath("C:\\work", "/c", "win32"), "C:\\");
  assert.equal(resolveToolPath("C:\\work", "/cx/y", "win32"), "C:\\cx\\y");
  assert.equal(resolveToolPath("C:\\work", "src/a.ts", "win32"), "C:\\work\\src\\a.ts");
  assert.equal(resolveToolPath("C:\\work", "D:\\data\\z", "win32"), "D:\\data\\z");
  assert.equal(resolveToolPath("/work", "/c/tmp/x", "darwin"), "/c/tmp/x");
  assert.equal(resolveToolPath("/work", "src/a.ts", "linux"), "/work/src/a.ts");
});
