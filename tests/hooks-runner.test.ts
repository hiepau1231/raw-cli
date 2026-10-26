import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/hooks/runner.js";
import type { SelectedHook } from "../src/hooks/contract.js";
import { processesWithMarker, waitForNoMarked } from "./fixtures/windows-processes.js";

async function fixture(source: string, timeoutMs = 1500): Promise<SelectedHook> {
  const folder = await mkdtemp(join(tmpdir(), "raw-hook-runner-"));
  await writeFile(join(folder, "run.mjs"), source);
  return { protocol_version: 2, id: "agent/check", name: "check", folder, command: process.execPath,
    args: [join(folder, "run.mjs")], timeoutMs, events: [{ name: "PreToolUse" }] };
}
const request = { protocol_version: 2 as const, event: "PreToolUse" as const, cwd: process.cwd(),
  tool: { identity: "builtin/bash", name: "bash", arguments: { command: "rm x" } } };

test("hook runner accepts empty success and structured denial, with exit 2 taking precedence", async () => {
  const empty = await fixture("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  assert.equal((await runHook(empty, request)).decision, "continue");
  const deny = await fixture("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked'})); });");
  assert.deepEqual((await runHook(deny, request)).decision, "deny");
  const exitTwo = await fixture("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'continue'})); process.exitCode=2; });");
  assert.equal((await runHook(exitTwo, request)).decision, "deny");
});

test("invalid output and nonblocking-looking exit codes are errors, not successful gates", async () => {
  for (const source of ["process.stdout.write('{} garbage')", "process.stdout.write('{')", "process.exitCode=1",
    "process.stdout.write('x'.repeat(70000))"]) {
    await assert.rejects(runHook(await fixture(source), request));
  }
});

test("hook runner bounds timeout and cancellation including descendants", async () => {
  const hang = await fixture("setInterval(() => {}, 1000)", 100);
  const started = Date.now();
  await assert.rejects(runHook(hang, request), /timeout/i);
  assert.ok(Date.now() - started < 3000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(runHook(await fixture("setInterval(() => {}, 1000)"), request,
    { signal: controller.signal }), /abort/i); }
  finally { clearTimeout(timer); }
  if (process.platform !== "win32") {
    const marker = join(await mkdtemp(join(tmpdir(), "raw-hook-descendant-")), "survived");
    const childSource = `import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 400) `)}],
        { stdio: "inherit" }); setInterval(() => {}, 1000);`;
    await assert.rejects(runHook(await fixture(childSource, 100), request), /timeout/i);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await assert.rejects(readFile(marker));
  }
});

const onlyWindows = process.platform === "win32" ? false : "needs Windows";

test("on Windows a .cmd hook and a .mjs hook run with their arguments", { skip: onlyWindows }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "raw hook "));
  await writeFile(join(folder, "gate.mjs"), "process.stdin.resume(); process.stdin.on('end', () => "
    + "process.stdout.write(JSON.stringify({ decision: 'deny', reason: process.argv.slice(2).join('|') })));");
  await writeFile(join(folder, "gate.cmd"), `@"${process.execPath}" "%~dp0gate.mjs" %*\r\n`);
  const hook = (command: string, args: string[]): SelectedHook => ({ protocol_version: 2, id: "agent/gate", name: "gate", folder,
    command, args, timeoutMs: 10000, events: [{ name: "PreToolUse" }] });
  assert.equal((await runHook(hook(join(folder, "gate.cmd"), ["a b", "x&y", "50%"]), request)).reason, "a b|x&y|50%");
  assert.equal((await runHook(hook(join(folder, "gate.mjs"), ["m n"]), request)).reason, "m n");
  await assert.rejects(runHook(hook(join(folder, "missing.cmd"), []), request), /spawn/);
});

test("on Windows a cancelled hook takes its detached grandchild with it", { skip: onlyWindows }, async () => {
  const marker = `marker-${randomUUID()}`;
  const hang = await fixture(`import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", ${JSON.stringify(marker)}], { detached: true, stdio: "ignore" }).unref();
    setInterval(() => {}, 1000);`, 8000);
  const controller = new AbortController();
  const running = runHook(hang, request, { signal: controller.signal });
  for (let i = 0; i < 50 && !processesWithMarker(marker).length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processesWithMarker(marker).length, 1, "the grandchild runs before the stop");
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.deepEqual(await waitForNoMarked(marker), []);
});

const stopRequest = { protocol_version: 2 as const, event: "Stop" as const, cwd: process.cwd() };
async function stopFixture(source: string): Promise<SelectedHook> {
  const hook = await fixture(source);
  return { ...hook, events: [{ name: "Stop" }] };
}
const printing = (value: unknown) => `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(value))}));`;

test("a Stop hook may answer deny with a reason; the other notification events and exit 2 still may not", async () => {
  const deny = await runHook(await stopFixture(printing({ decision: "deny", reason: "keep going — ünï" })), stopRequest);
  assert.deepEqual([deny.decision, deny.reason], ["deny", "keep going — ünï"]);
  assert.equal((await runHook(await stopFixture(printing({ decision: "continue" })), stopRequest)).decision, "continue");
  assert.equal((await runHook(await stopFixture(printing({ message: "hi" })), stopRequest)).decision, "continue");
  await assert.rejects(runHook(await stopFixture(printing({ decision: "maybe" })), stopRequest), /invalid_output/);
  // A Stop reason is not held to the gates' 1024 bytes: a long goal text must not end the run as invalid output.
  assert.equal((await runHook(await stopFixture(printing({ decision: "deny", reason: "x".repeat(50_000) })), stopRequest)).reason?.length, 50_000);
  await assert.rejects(runHook(await stopFixture(printing({ decision: "deny", reason: "x".repeat(1025) })), request), /invalid_output/);
  await assert.rejects(runHook(await stopFixture(printing({ decision: "deny", reason: 5 })), stopRequest), /invalid_output/);
  await assert.rejects(runHook(await stopFixture("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('{\"decision\":\"deny\"}'); process.exitCode = 2; });"), stopRequest), /exit/);
  for (const event of ["SessionStart", "PostToolUse", "PostToolUseFailure", "SessionEnd"] as const) {
    await assert.rejects(runHook(await stopFixture(printing({ decision: "deny" })), { ...stopRequest, event }), /invalid_output/, event);
  }
});
