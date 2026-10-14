import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { listWorkspaceFiles, type WorkspaceFileListing } from "../src/dashboard/files.js";
import { dashboardFixture } from "./fixtures/dashboard.js";

function tempDir(prefix: string): string { return realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); }
function write(root: string, path: string, text = "x"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function git(cwd: string, ...args: string[]): void { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" }); }
const paths = (listing: WorkspaceFileListing) => listing.entries.map((entry) => entry.path);

test("the listing is workspace-relative when the workspace is a subdirectory of a repository", async () => {
  const repo = tempDir("raw-files-repo-");
  try {
    write(repo, "sub/a.ts", "a");
    write(repo, "sub/deep/b.ts", "b");
    write(repo, "sub/notes.log", "noise");
    write(repo, "sub/.gitignore", "*.log\n");
    write(repo, "root.ts", "r");
    git(repo, "init", "-q");
    git(repo, "add", "-A");

    const listing = await listWorkspaceFiles(join(repo, "sub"));
    assert.deepEqual(paths(listing), [".gitignore", "a.ts", "deep/b.ts"]);
    assert.deepEqual(listing.entries.map((entry) => entry.name), [".gitignore", "a.ts", "b.ts"]);
    assert.equal(listing.total, 3);
    assert.equal(listing.truncated, false);
    assert.equal(listing.root, realpathSync.native(join(repo, "sub")));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the listing skips .git and node_modules, scopes to the workspace and reports its cap", async () => {
  const root = tempDir("raw-files-plain-");
  try {
    write(root, "README.md", "readme");
    write(root, "src/app.ts", "app");
    write(root, "src/deep/x.ts", "x");
    write(root, "node_modules/pkg/index.js", "dep");
    write(root, ".git/config", "[core]");

    const all = await listWorkspaceFiles(root);
    assert.deepEqual(paths(all), ["README.md", "src/app.ts", "src/deep/x.ts"]);
    assert.equal(all.total, 3);
    assert.equal(all.truncated, false);

    const capped = await listWorkspaceFiles(root, { max: 2 });
    assert.deepEqual(paths(capped), ["README.md", "src/app.ts"]);
    assert.equal(capped.total, 3);
    assert.equal(capped.truncated, true);

    const inside = await listWorkspaceFiles(join(root, "src"));
    assert.deepEqual(paths(inside), ["app.ts", "deep/x.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a tracked node_modules entry is still not part of the workspace view", async () => {
  const repo = tempDir("raw-files-forced-");
  try {
    write(repo, "app.ts", "app");
    write(repo, "node_modules/pkg/index.js", "dep");
    git(repo, "init", "-q");
    git(repo, "add", "-A", "-f");

    assert.deepEqual(paths(await listWorkspaceFiles(repo)), ["app.ts"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("an empty workspace lists nothing rather than failing", async () => {
  const root = tempDir("raw-files-empty-");
  try {
    const listing = await listWorkspaceFiles(root);
    assert.deepEqual(paths(listing), []);
    assert.equal(listing.total, 0);
    assert.equal(listing.truncated, false);
    await assert.rejects(() => listWorkspaceFiles(join(root, "missing")), /cannot be read/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the files route answers the workspace listing", async () => {
  const f = await dashboardFixture({ responses: [{ hold: true }] });
  try {
    write(f.root, "app.ts", "app");
    write(f.root, "src/deep/x.ts", "x");
    const listing = await f.json<WorkspaceFileListing>("/workspaces/files");
    assert.equal(listing.root, realpathSync.native(f.root));
    // The fixture keeps the dashboard's own config and state under the workspace root, so the listing carries them too.
    const listed = paths(listing);
    assert.ok(listed.includes("app.ts") && listed.includes("src/deep/x.ts"), listed.join(", "));
    assert.ok(listed.every((path) => path !== "" && !path.startsWith("/") && !path.includes("\\")), listed.join(", "));
    assert.equal(listing.total, listed.length);
    assert.equal(listing.truncated, false);
  } finally { await f.close(); }
});
