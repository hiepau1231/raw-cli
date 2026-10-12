import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isRegularFile, jobLauncher, mergeEnv, prepareSpawn, quoteCmdArgument, quoteWindowsArgument, resetJobLauncherForTests,
  resolveCommand, terminateTree, wrapInJob, type ResolvedCommand } from "../src/platform/windows.js";
import { processesWithMarker, waitForNoMarked } from "./fixtures/windows-processes.js";

const windows = process.platform === "win32";
const onlyWindows = windows ? false : "needs Windows";
// cross-spawn is what the MCP SDK uses to start .cmd servers; its escaping is the reference for ours.
const crossSpawnEscape = createRequire(import.meta.url)("cross-spawn/lib/util/escape.js") as { argument(arg: string, twice?: boolean): string };

const env = { Path: "C:\\Windows\\System32;relative\\bin;C:\\tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
const files = (...present: string[]) => (file: string) => present.some((item) => item.toLowerCase() === file.toLowerCase());
const resolveWin = (command: string, args: string[], present: string[]) =>
  resolveCommand(command, args, { cwd: "C:\\work", env, platform: "win32", exists: files(...present), node: "C:\\node\\node.exe",
    powershell: () => "C:\\pwsh\\pwsh.exe", bash: () => "C:\\Git\\bin\\bash.exe" });

test("a bare name resolves on PATH with PATHEXT, never in the cwd or a relative PATH entry", () => {
  const planted = ["C:\\work\\npx.cmd", "C:\\work\\relative\\bin\\npx.cmd", "C:\\Program Files\\nodejs\\npx.cmd"];
  const npx = resolveWin("npx", ["-y", "server"], planted);
  assert.equal(npx.ok, true);
  assert.deepEqual(npx.ok && npx, { ok: true, file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `"C:\\Program^ Files\\nodejs\\npx.cmd ${quoteCmdArgument("-y")} ${quoteCmdArgument("server")}"`], windowsVerbatimArguments: true,
    batch: "C:\\Program Files\\nodejs\\npx.cmd" });
  assert.deepEqual(resolveWin("npx", [], ["C:\\work\\npx.cmd", "C:\\work\\relative\\bin\\npx.cmd"]),
    { ok: false, code: "not_found", message: "command not found: npx" });
  assert.deepEqual(resolveWin("tool", ["a"], ["C:\\tools\\tool.exe"]), { ok: true, file: "C:\\tools\\tool.exe", args: ["a"] });
  assert.deepEqual(resolveWin("node.exe", ["-v"], ["C:\\Program Files\\nodejs\\node.exe"]),
    { ok: true, file: "C:\\Program Files\\nodejs\\node.exe", args: ["-v"] });
});

test("a command naming a file runs by its extension", () => {
  assert.deepEqual(resolveWin("./hook.mjs", ["x"], ["C:\\work\\hook.mjs"]), { ok: true, file: "C:\\node\\node.exe", args: ["C:\\work\\hook.mjs", "x"] });
  assert.deepEqual(resolveWin("scripts\\a.cjs", [], ["C:\\work\\scripts\\a.cjs"]), { ok: true, file: "C:\\node\\node.exe", args: ["C:\\work\\scripts\\a.cjs"] });
  assert.deepEqual(resolveWin("./hook.ps1", ["x"], ["C:\\work\\hook.ps1"]), { ok: true, file: "C:\\pwsh\\pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\work\\hook.ps1", "x"] });
  assert.deepEqual(resolveWin("./hook.sh", ["x"], ["C:\\work\\hook.sh"]), { ok: true, file: "C:\\Git\\bin\\bash.exe", args: ["C:\\work\\hook.sh", "x"] });
  const noBash = resolveCommand("./hook.sh", [], { cwd: "C:\\work", env, platform: "win32", exists: files("C:\\work\\hook.sh") });
  assert.equal(noBash.ok === false && noBash.code, "bash_unavailable");
  // A configured interpreter given by name is found on PATH, never as a same-named file in the cwd.
  const named = (shell: string, script: string) => resolveCommand(script, [], { cwd: "C:\\work", env, platform: "win32",
    exists: files(`C:\\work\\${script.slice(2)}`, `C:\\work\\${shell}`, `C:\\tools\\${shell}`), bash: () => shell, powershell: () => shell });
  assert.equal(named("bash.exe", "./hook.sh").ok && (named("bash.exe", "./hook.sh") as ResolvedCommand).file, "C:\\tools\\bash.exe");
  assert.equal(named("pwsh.exe", "./hook.ps1").ok && (named("pwsh.exe", "./hook.ps1") as ResolvedCommand).file, "C:\\tools\\pwsh.exe");
  const unresolved = resolveCommand("./hook.sh", [], { cwd: "C:\\work", env, platform: "win32", exists: files("C:\\work\\hook.sh", "C:\\work\\bash.exe"),
    bash: () => "bash.exe" });
  assert.equal(unresolved.ok === false && unresolved.code, "bash_unavailable");
  const batch = resolveWin("./hook", [], ["C:\\work\\hook.bat"]);
  assert.equal(batch.ok && batch.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(resolveWin("D:\\bin\\x.exe", ["a b"], ["D:\\bin\\x.exe"]), { ok: true, file: "D:\\bin\\x.exe", args: ["a b"] });
  assert.equal(resolveWin("./missing.mjs", [], []).ok, false);
});

test("only a regular file counts as a program, so a directory named like one never shadows it", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-resolve-"));
  try {
    mkdirSync(join(dir, "tool.exe"));
    writeFileSync(join(dir, "tool.cmd"), "@echo off\r\n");
    assert.equal(isRegularFile(join(dir, "tool.exe")), false);
    assert.equal(isRegularFile(join(dir, "tool.cmd")), true);
    assert.equal(isRegularFile(join(dir, "missing.exe")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("on Windows a directory named like a program on PATH is skipped for the real one further on", { skip: onlyWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-resolve-"));
  try {
    mkdirSync(join(dir, "first", "tool.exe"), { recursive: true });
    mkdirSync(join(dir, "second"));
    writeFileSync(join(dir, "second", "tool.exe"), "");
    const found = resolveCommand("tool", [], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "first")};${join(dir, "second")}` } });
    assert.deepEqual(found, { ok: true, file: join(dir, "second", "tool.exe"), args: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("other platforms start commands unchanged", () => {
  assert.deepEqual(resolveCommand("npx", ["-y", "x"], { cwd: "/work", platform: "linux", exists: () => false }), { ok: true, file: "npx", args: ["-y", "x"] });
  assert.deepEqual(resolveCommand("./hook.sh", [], { cwd: "/work", platform: "darwin", exists: () => false }), { ok: true, file: "./hook.sh", args: [] });
});

test("batch arguments are escaped for cmd.exe exactly as cross-spawn escapes them", () => {
  for (const arg of ["a b", "a&b", "\"q\"", "50%", "x^y", "", "a\\", "a\\\"b", "(x)|<y>"]) {
    assert.equal(quoteCmdArgument(arg), crossSpawnEscape.argument(arg), arg);
    assert.equal(quoteCmdArgument(arg, true), crossSpawnEscape.argument(arg, true), arg);
  }
  const shim = resolveWin("C:\\work\\node_modules\\.bin\\tool.cmd", ["a&b"], ["C:\\work\\node_modules\\.bin\\tool.cmd"]);
  assert.ok(shim.ok && shim.args[3]!.endsWith(`${crossSpawnEscape.argument("a&b", true)}"`));
});

test("Windows argument quoting matches Node's (libuv quote_cmd_arg)", () => {
  const vectors: Array<[string, string]> = [["", "\"\""], ["plain", "plain"], ["a b", "\"a b\""], ["a\"b", "\"a\\\"b\""],
    ["a\\b", "a\\b"], ["a\\\"b", "\"a\\\\\\\"b\""], ["a b\\", "\"a b\\\\\""], ["C:\\Program Files\\x", "\"C:\\Program Files\\x\""],
    ["a\tb", "\"a\tb\""], ["hello\\\\\"world", "\"hello\\\\\\\\\\\"world\""]];
  for (const [arg, quoted] of vectors) assert.equal(quoteWindowsArgument(arg), quoted, JSON.stringify(arg));
});

test("environment overrides replace every spelling of a Windows key", () => {
  assert.deepEqual(mergeEnv({ Path: "a", HOME: "h" }, { PATH: "b" }, "win32"), { HOME: "h", PATH: "b" });
  assert.deepEqual(mergeEnv({ Path: "a", path: "c" }, { PATH: "b" }, "win32"), { PATH: "b" });
  assert.deepEqual(mergeEnv({ Path: "a" }, { PATH: "b" }, "linux"), { Path: "a", PATH: "b" });
  assert.deepEqual(mergeEnv({ Path: "a" }, {}, "win32"), { Path: "a" });
});

test("wrapping in the job launcher passes only base64 tokens that decode to the program and its exact line", () => {
  const decode = (resolved: ResolvedCommand) => {
    assert.equal(resolved.file, "C:\\state\\raw-job.exe");
    assert.equal(resolved.args.length, 4);
    assert.deepEqual([resolved.args[0], resolved.args[2]], ["--app", "--line"]);
    for (const token of [resolved.args[1]!, resolved.args[3]!]) assert.match(token, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(resolved.windowsVerbatimArguments, undefined);
    return [Buffer.from(resolved.args[1]!, "base64").toString("utf8"), Buffer.from(resolved.args[3]!, "base64").toString("utf8")];
  };
  const direct = { file: "C:\\Program Files\\nodejs\\node.exe", args: ["-e", "x", "a b", "\"q\"", "", "é"] };
  assert.deepEqual(decode(wrapInJob(direct, "C:\\state\\raw-job.exe")),
    [direct.file, "\"C:\\Program Files\\nodejs\\node.exe\" -e x \"a b\" \"\\\"q\\\"\" \"\" é"]);
  const batch = resolveWin("npx", ["a&b"], ["C:\\tools\\npx.cmd"]);
  assert.ok(batch.ok);
  assert.deepEqual(decode(wrapInJob(batch, "C:\\state\\raw-job.exe")), [batch.file, `${batch.file} ${batch.args.join(" ")}`]);
  assert.equal(wrapInJob(direct, undefined), direct);
});

test("the launcher is compiled once per source, named by its hash, and its failure is logged once", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "raw-launcher-"));
  try {
    resetJobLauncherForTests();
    let compiled = 0;
    const compile = (_source: string, output: string) => { compiled++; writeFileSync(output, "exe"); };
    const first = jobLauncher({ platform: "win32", stateDir, source: "class A {}", compile });
    assert.match(first!, /raw-job-[0-9a-f]{12}\.exe$/);
    assert.ok(existsSync(first!));
    assert.equal(jobLauncher({ platform: "win32", stateDir, source: "class A {}", compile }), first);
    resetJobLauncherForTests();
    assert.equal(jobLauncher({ platform: "win32", stateDir, source: "class A {}", compile }), first, "a cached file is reused");
    assert.equal(compiled, 1);
    const other = jobLauncher({ platform: "win32", stateDir, source: "class B {}", compile });
    assert.notEqual(other, first);
    resetJobLauncherForTests();
    const logged: string[] = [];
    const broken = { platform: "win32" as const, stateDir, source: "class C {}", log: (line: string) => logged.push(line),
      compile: () => { throw new Error("csc.exe was not found"); } };
    assert.equal(jobLauncher(broken), undefined);
    assert.equal(jobLauncher({ ...broken, source: "class D {}" }), undefined);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /csc\.exe was not found.*taskkill/);
    assert.equal(jobLauncher({ platform: "linux", stateDir, source: "class A {}", compile }), undefined);
  } finally { resetJobLauncherForTests(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("stopping a tree never signals a child that has already exited", () => {
  let killed = 0;
  const exited = { pid: 4242, exitCode: 0, signalCode: null, kill: () => { killed++; return true; } } as unknown as ChildProcess;
  terminateTree(exited, { jobbed: true });
  terminateTree(exited, { jobbed: false });
  assert.equal(killed, 0);
  const running = { pid: 4243, exitCode: null, signalCode: null, kill: () => { killed++; return true; } } as unknown as ChildProcess;
  terminateTree(running, { jobbed: true });
  assert.equal(killed, 1);
});

test("a stop that fails while the child still runs is reported; one that loses a race with its exit is not", async () => {
  const errors: string[] = [];
  const onError = (message: string) => errors.push(message);
  const stuck = { pid: 4244, exitCode: null, signalCode: null, kill: () => { throw new Error("access denied"); } } as unknown as ChildProcess;
  terminateTree(stuck, { jobbed: true, onError });
  const refused = { pid: 4245, exitCode: null, signalCode: null, kill: () => false } as unknown as ChildProcess;
  terminateTree(refused, { jobbed: true, onError });
  // Refuses the kill because it has just exited; its exit is seen a moment later.
  const racing = { pid: 4246, exitCode: null as number | null, signalCode: null, kill() { setTimeout(() => { racing.exitCode = 0; }, 10); return false; } };
  terminateTree(racing as unknown as ChildProcess, { jobbed: true, onError });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(errors, ["cannot stop process 4244: access denied", "cannot stop process 4245"]);
});

// The real launcher, compiled with the .NET Framework compiler on the Windows runner.

function run(prepared: ResolvedCommand, options: { cwd?: string } = {}) {
  return spawnSync(prepared.file, prepared.args, { encoding: "utf8", windowsHide: true, ...options,
    ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

function launch(command: string, args: string[], cwd = process.cwd()) {
  const prepared = prepareSpawn(command, args, { cwd });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.equal(prepared.jobbed, true, "the job launcher must build on the Windows runner");
  return prepared;
}

const echo = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
const awkward = ["a b", "\"q\"", "a\\\"b", "trail\\", "", "a&b", "50%", "x^y", "é ü"];

test("the job launcher passes every argument through unchanged and returns the exit code", { skip: onlyWindows }, () => {
  const direct = spawnSync(process.execPath, ["-e", echo, ...awkward], { encoding: "utf8" });
  const viaJob = run(launch(process.execPath, ["-e", echo, ...awkward]));
  assert.equal(viaJob.status, 0, viaJob.stderr);
  assert.deepEqual(JSON.parse(viaJob.stdout), JSON.parse(direct.stdout));
  assert.deepEqual(JSON.parse(viaJob.stdout), awkward);
  assert.equal(run(launch(process.execPath, ["-e", "process.exit(7)"])).status, 7);
});

test("a .cmd in a folder with a space receives its arguments unchanged through the launcher", { skip: onlyWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), "raw cmd "));
  try {
    const script = join(dir, "echo args.js");
    // A script's own path is argv[1], so its arguments start at argv[2].
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    writeFileSync(join(dir, "show.cmd"), `@"${process.execPath}" "%~dp0echo args.js" %*\r\n`);
    const args = ["a b", "\"q\"", "a&b", "50%", "x^y"];
    const result = run(launch(join(dir, "show.cmd"), args, dir), { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const jobTree = resolve("tests/fixtures/job-tree.mjs");
const until = async (ready: () => boolean, tries = 50) => {
  for (let i = 0; i < tries && !ready(); i++) await new Promise((done) => setTimeout(done, 100));
};

test("killing the launcher kills a grandchild whose parent already exited", { skip: onlyWindows }, async () => {
  const marker = `marker-${randomUUID()}`;
  // The leader stays; its intermediate starts the marked process and exits, so only the job still ties that one to the
  // leader and a taskkill /T of the launcher would miss it.
  const prepared = launch(process.execPath, [jobTree, "orphan"]);
  const child = spawn(prepared.file, prepared.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    env: { ...process.env, RAW_JOB_MARKER: marker } });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  try {
    await until(() => stdout.includes("middle-exited") && processesWithMarker(marker).length > 0);
    assert.match(stdout, /middle-exited/, "the intermediate process exits before the stop");
    assert.equal(processesWithMarker(marker).length, 1, "the orphaned grandchild runs before the stop");
    assert.equal(child.exitCode, null, "the leader still runs");
    terminateTree(child, { jobbed: true });
    assert.deepEqual(await waitForNoMarked(marker), []);
  } finally { child.kill(); }
});

test("a leader that exits takes the processes it left behind with it", { skip: onlyWindows }, async () => {
  const marker = `marker-${randomUUID()}`;
  const prepared = launch(process.execPath, [jobTree, "leader"]);
  const child = spawn(prepared.file, prepared.args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
    env: { ...process.env, RAW_JOB_MARKER: marker } });
  const exited = new Promise<void>((done) => { child.once("exit", () => done()); });
  try {
    await until(() => processesWithMarker(marker).length > 0);
    assert.equal(processesWithMarker(marker).length, 1, "the left-behind process runs while the leader does");
    assert.equal(child.exitCode, null, "the leader waits for its stdin to close");
    child.stdin.end();
    await exited;
    assert.deepEqual(await waitForNoMarked(marker), []);
  } finally { child.kill(); }
});
