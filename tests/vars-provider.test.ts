import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runVariableProvider } from "../src/vars/provider.js";
import { processesWithMarker, waitForNoMarked } from "./fixtures/windows-processes.js";
const path = resolve("tests/fixtures/var-provider.mjs");
const spec = (mode: string, timeoutMs = 2000) => ({ command: process.execPath, args: [path, mode], cwd: process.cwd(), timeoutMs, maxOutputBytes: 65536 });
const request = { protocol_version: 1 as const, name: "x", params: { field: "value" } };
test("executable protocol sends one request and literal environment without shell expansion", async () => {
  const output = await runVariableProvider(spec("ok"), request, { env: { VAR_TEST: "$(no); ' literal" } });
  assert.deepEqual(output.value, { request, env: "$(no); ' literal", cwd: process.cwd() });
});
test("malformed, extra, invalid UTF-8, failed exit, output overflow and invalid response metadata fail", async () => {
  for (const mode of ["bad", "extra", "utf8", "exit", "overflow", "date", "unknown", "early"]) {
    await assert.rejects(runVariableProvider(spec(mode), request), error => {
      assert.doesNotMatch(String(error), /secret bytes|private stderr/); return true;
    });
  }
  await assert.rejects(runVariableProvider({ ...spec("ok"), command: "/missing/raw-provider" }, request), /var_provider_spawn/);
});
test("timeout and abort settle boundedly, including inherited pipes", async () => {
  for (const mode of ["hang", "descendant"]) {
    const started = Date.now();
    // On Windows the provider's job ends the descendant as soon as the provider exits, so its pipes close at once and
    // the empty output is the failure, unless Node starts too slowly to exit before the deadline; elsewhere the
    // descendant holds them open until the deadline.
    const expected = mode === "descendant" && process.platform === "win32" ? /var_provider_(?:invalid_response|timeout)/ : /var_provider_timeout/;
    await assert.rejects(runVariableProvider(spec(mode, 150), request), expected);
    assert.ok(Date.now() - started < 3000);
  }
  await assert.rejects(runVariableProvider(spec("ok"), request, { signal: AbortSignal.abort() }), /aborted/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(runVariableProvider(spec("hang"), request, { signal: controller.signal }), /aborted/); }
  finally { clearTimeout(timer); }
});
const onlyWindows = process.platform === "win32" ? false : "needs Windows";
test("on Windows a .cmd provider and a .mjs provider run with their arguments", { skip: onlyWindows }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "raw provider "));
  writeFileSync(join(folder, "value.mjs"), "for await (const _ of process.stdin); console.log(JSON.stringify({ value: process.argv.slice(2) }));");
  writeFileSync(join(folder, "value.cmd"), `@"${process.execPath}" "%~dp0value.mjs" %*\r\n`);
  const at = (command: string, args: string[]) => ({ command, args, cwd: folder, timeoutMs: 10000, maxOutputBytes: 65536 });
  assert.deepEqual((await runVariableProvider(at(join(folder, "value.cmd"), ["a b", "x&y", "50%"]), request)).value, ["a b", "x&y", "50%"]);
  assert.deepEqual((await runVariableProvider(at(join(folder, "value.mjs"), ["m n"]), request)).value, ["m n"]);
  await assert.rejects(runVariableProvider(at("raw-missing-provider", []), request), /var_provider_spawn/);
});
test("on Windows a cancelled provider takes its detached grandchild with it", { skip: onlyWindows }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "raw provider "));
  const marker = `marker-${randomUUID()}`;
  writeFileSync(join(folder, "hang.mjs"), `import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", ${JSON.stringify(marker)}], { detached: true, stdio: "ignore" }).unref();
    setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const running = runVariableProvider({ command: join(folder, "hang.mjs"), args: [], cwd: folder, timeoutMs: 8000, maxOutputBytes: 65536 },
    request, { signal: controller.signal });
  for (let i = 0; i < 50 && !processesWithMarker(marker).length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processesWithMarker(marker).length, 1, "the grandchild runs before the stop");
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.deepEqual(await waitForNoMarked(marker), []);
});
