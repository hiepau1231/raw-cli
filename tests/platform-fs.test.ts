import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { contained, fsyncDirectory, readJsonText, renameWithRetry, sameFile, stripBom } from "../src/platform/fs.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fakeRename(failures: string[]) {
  const calls: Array<[string, string]> = [];
  let clock = 0;
  const slept: number[] = [];
  return {
    calls, slept,
    options: {
      platform: "win32" as const,
      rename: async (from: string, to: string) => { calls.push([from, to]); const code = failures.shift(); if (code) throw errno(code); },
      sleep: async (ms: number) => { slept.push(ms); clock += ms; },
      now: () => clock,
      exists: async () => false,
    },
  };
}

test("a rename retries transient Windows errors and succeeds once the handle is gone", async () => {
  for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    const fake = fakeRename([code, code]);
    await renameWithRetry("a.tmp", "a", fake.options);
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(fake.slept, [10, 20]);
  }
});

test("a rename gives up after its deadline and throws the last error", async () => {
  const fake = fakeRename(Array(100).fill("EBUSY"));
  await assert.rejects(renameWithRetry("a.tmp", "a", fake.options), { code: "EBUSY" });
  assert.ok(fake.calls.length > 3 && fake.calls.length < 20, String(fake.calls.length));
  assert.ok(fake.slept.reduce((sum, ms) => sum + ms, 0) <= 2000);
  const short = fakeRename(Array(100).fill("EPERM"));
  await assert.rejects(renameWithRetry("a.tmp", "a", { ...short.options, deadlineMs: 25 }), { code: "EPERM" });
  assert.equal(short.calls.length, 2);
});

test("a rename throws at once for other errors, on other platforms and over an existing target when asked", async () => {
  const missing = fakeRename(["ENOENT"]);
  await assert.rejects(renameWithRetry("a.tmp", "a", missing.options), { code: "ENOENT" });
  assert.equal(missing.calls.length, 1);
  const posix = fakeRename(["EBUSY"]);
  await assert.rejects(renameWithRetry("a.tmp", "a", { ...posix.options, platform: "linux" }), { code: "EBUSY" });
  assert.equal(posix.calls.length, 1);
  const raced = fakeRename(["EPERM", "EPERM"]);
  await assert.rejects(renameWithRetry("stage", "snap", { ...raced.options, keepExisting: true, exists: async (target) => target === "snap" }), { code: "EPERM" });
  assert.equal(raced.calls.length, 1);
});

test("JSON text loses a leading byte order mark and nothing else", async () => {
  assert.equal(stripBom("\uFEFF{\"a\":1}"), "{\"a\":1}");
  assert.equal(stripBom("{\"a\":\"\uFEFF\"}"), "{\"a\":\"\uFEFF\"}");
  const dir = mkdtempSync(join(tmpdir(), "raw-platform-fs-"));
  try {
    writeFileSync(join(dir, "bom.json"), "\uFEFF{\"name\":\"x\"}\n");
    assert.deepEqual(JSON.parse(await readJsonText(join(dir, "bom.json"))), { name: "x" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a directory fsync never throws for a directory on any platform", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-platform-fs-"));
  try {
    fsyncDirectory(dir);
    fsyncDirectory(dir, "win32");
    assert.throws(() => fsyncDirectory(join(dir, "missing"), "linux"), { code: "ENOENT" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("containment compares Windows paths case-insensitively and resolves dot segments", () => {
  assert.equal(contained("c:\\a", "C:\\A\\x", path.win32), true);
  assert.equal(contained("c:\\a", "c:\\a", path.win32), true);
  assert.equal(contained("c:\\a", "C:\\a\\..\\b", path.win32), false);
  assert.equal(contained("c:\\a", "c:\\ab", path.win32), false);
  assert.equal(contained("c:\\a", "d:\\a\\x", path.win32), false);
  assert.equal(contained("c:\\a", "c:\\a\\..foo", path.win32), true);
  assert.equal(contained("/a", "/a/b/c", path.posix), true);
  assert.equal(contained("/a", "/A/b", path.posix), false);
  assert.equal(contained("/a", "/a/../b", path.posix), false);
});

test("sameFile compares file IDs, and devices only when both stats report one", () => {
  assert.equal(sameFile({ dev: 5, ino: 9 }, { dev: 5, ino: 9 }), true);
  // Node 22 on Windows: a path-based stat leaves dev 0 while fstat reports the volume.
  assert.equal(sameFile({ dev: 0, ino: 9 }, { dev: 5, ino: 9 }), true);
  assert.equal(sameFile({ dev: 5, ino: 9 }, { dev: 0, ino: 9 }), true);
  assert.equal(sameFile({ dev: 5, ino: 9 }, { dev: 6, ino: 9 }), false);
  assert.equal(sameFile({ dev: 0, ino: 9 }, { dev: 5, ino: 8 }), false);
});
