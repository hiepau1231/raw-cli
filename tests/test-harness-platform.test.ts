import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testRun } from "../scripts/test-tmp.mjs";
import { launch, posixOnly, POSIX_ONLY } from "./fixtures/platform.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("npm starts through the test launcher on every platform", () => {
  const result = spawnSync(...launch("npm", ["--version"]), { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("on Windows npm runs as its Node script, else as npm.cmd through the system cmd.exe", () => {
  assert.deepEqual(launch("npm", ["pack", "--json"], "linux", "/x/npm-cli.js"), ["npm", ["pack", "--json"]]);
  assert.deepEqual(launch("npm", ["pack", "--json"], "win32", "C:\\nodejs\\npm-cli.js"),
    [process.execPath, ["C:\\nodejs\\npm-cli.js", "pack", "--json"]]);
  assert.deepEqual(launch("npm", ["install", "C:\\a b\\raw.tgz"], "win32", null, { SystemRoot: "D:\\Win" }),
    ["D:\\Win\\System32\\cmd.exe", ["/d", "/s", "/c", "npm.cmd", "install", "C:\\a b\\raw.tgz"]]);
  assert.throws(() => launch("npm", ["install", "a&b"], "win32", null, { SystemRoot: "C:\\Windows" }), /cmd\.exe/);
  assert.deepEqual(launch("C:\\c\\node_modules\\.bin\\raw", ["--version"], "win32", null),
    [process.execPath, ["C:\\c\\node_modules\\@tlelabs\\raw\\dist\\raw.js", "--version"]]);
});

test("a test run points Node's temp directory into the disposable run on Windows", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const run = testRun({ signals: false, platform });
    try {
      assert.ok(existsSync(run.env.TMPDIR));
      if (platform === "win32") {
        assert.equal(run.env.TEMP, run.env.TMPDIR);
        assert.equal(run.env.TMP, run.env.TMPDIR);
        assert.equal(run.env.WT_SESSION, "raw-test");
      } else {
        assert.equal("WT_SESSION" in run.env, false);
        assert.equal("TEMP" in run.env, false);
        assert.equal("TMP" in run.env, false);
      }
    } finally {
      run.cleanup();
    }
    assert.equal(existsSync(run.env.TMPDIR), false);
  }
});

test("POSIX-only skips apply on Windows alone and always carry a reason", () => {
  for (const reason of Object.keys(POSIX_ONLY) as (keyof typeof POSIX_ONLY)[]) {
    assert.equal(posixOnly(reason, "win32"), POSIX_ONLY[reason]);
    assert.equal(posixOnly(reason, "linux"), false);
    assert.equal(posixOnly(reason, "darwin"), false);
  }
});

test("the overhead script prints its report when run from a path with a space and a #", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw overhead "));
  try {
    // A junction needs no privilege on Windows; the preserve flags keep the spaced path as the entry point's URL.
    const linked = join(dir, "raw #cli");
    symlinkSync(root, linked, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", "--import", "tsx",
      join(linked, "scripts", "overhead.mjs")], { cwd: linked, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { promptTokens: number; definitions: unknown[] };
    assert.equal(report.definitions.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
