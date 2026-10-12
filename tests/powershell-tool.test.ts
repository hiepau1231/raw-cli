import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeArguments as bashArguments } from "../src/tools/bundled/bash/index.js";
import { normalizeArguments as powershellArguments } from "../src/tools/bundled/powershell/index.js";
import { systemBinary } from "../src/platform/windows.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { resolvePowerShell } from "../src/tools/shells.js";
import type { ToolResult } from "../src/tools/types.js";
import { processesWithMarker } from "./fixtures/windows-processes.js";

const windows = process.platform === "win32";
const found = resolvePowerShell({ workspace: tmpdir() });
const skip = found.ok ? false : "needs PowerShell (pwsh on PATH)";
/** Windows runs every case under pwsh 7 and again under Windows PowerShell 5.1; elsewhere under the pwsh found. */
const versions: { name: string; path?: string }[] = windows
  ? [{ name: "pwsh" }, { name: "5.1", path: systemBinary("WindowsPowerShell\\v1.0\\powershell.exe") }] : [{ name: "pwsh" }];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// PowerShell ends lines with CRLF on Windows; the assertions read LF.
const text = (result: ToolResult) => result.content.map((block) => block.type === "text" ? block.text : "").join("").replaceAll("\r\n", "\n");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const node = quote(process.execPath);

async function registry(): Promise<ToolRegistry> {
  const tools = new ToolRegistry();
  for (const tool of await loadBundledTools(["powershell", "process"])) tools.register(tool);
  return tools;
}

/** Runs `body` with RAW_POWERSHELL_PATH selecting `version`, restoring the environment after. */
async function using<T>(version: { path?: string }, body: () => Promise<T>): Promise<T> {
  const saved = process.env.RAW_POWERSHELL_PATH;
  if (version.path) process.env.RAW_POWERSHELL_PATH = version.path; else delete process.env.RAW_POWERSHELL_PATH;
  try { return await body(); } finally { if (saved === undefined) delete process.env.RAW_POWERSHELL_PATH; else process.env.RAW_POWERSHELL_PATH = saved; }
}

/** Live process IDs whose command line carries `marker`. */
function marked(marker: string): number[] {
  if (windows) return processesWithMarker(marker).map((item) => item.pid);
  const listed = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).stdout;
  return listed.split("\n").filter((line) => line.includes(marker)).map((line) => Number.parseInt(line, 10));
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 10000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting");
    await sleep(100);
  }
}

const unique = () => `raw-ps-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

test("command arrays are quoted for the tool's own shell, and only powershell unwraps a PowerShell invocation", () => {
  const ps = (command: string[]) => powershellArguments({ command }).args.command;
  const bash = (command: string[]) => bashArguments({ command }).args.command;
  assert.equal(ps(["pwsh", "-Command", "Write-Output hi"]), "Write-Output hi");
  assert.equal(ps(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-c", "Get-Date"]), "Get-Date");
  assert.equal(ps(["Write-Output", "it's fine", "a,b", "@x", "$y", "‘q’"]), "Write-Output 'it''s fine' 'a,b' '@x' '$y' '‘‘q’’'");
  assert.equal(ps(["C:\\Program Files\\nodejs\\node.exe", "-v"]), "& 'C:\\Program Files\\nodejs\\node.exe' -v");
  assert.equal(ps(["npm", "run", "build:ci", "--", "--flag=1", ".\\out"]), "npm run build:ci -- --flag=1 .\\out");
  // Bash keeps its own quoting and runs an explicit PowerShell invocation as written.
  assert.equal(bash(["pwsh", "-Command", "Write-Output hi"]), "pwsh -Command 'Write-Output hi'");
  assert.equal(bash(["bash", "-lc", "npm test"]), "npm test");
  assert.equal(bash(["echo", "it's"]), "echo 'it'\\''s'");
  assert.equal(ps(["bash", "-lc", "npm test"]), "bash -lc 'npm test'");
});

test("on Windows the powershell tool defaults to pwsh 7", { skip: windows ? false : "needs Windows" }, () => {
  const resolved = resolvePowerShell({ env: { ...process.env, RAW_POWERSHELL_PATH: "" }, workspace: tmpdir() });
  assert.ok(resolved.ok && /\\pwsh\.exe$/i.test(resolved.path), JSON.stringify(resolved));
});

for (const version of versions) {
  test(`${version.name}: exit statuses follow the last statement and output is UTF-8`, { skip }, () => using(version, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-ps-exit-")));
    const tools = await registry();
    const run = async (command: string) => text(await tools.dispatch("powershell", { command }, { cwd, maxOutputBytes: 8192 }));
    const nativeFails = windows ? "cmd /c exit 4" : `& ${node} -e "process.exit(4)"`;
    const cases: [string, RegExp][] = [
      ["Write-Output hi", /^hi\n\n?\[exit 0 · [^\]]+\]$/],
      ["Write-Output hi; exit 3", /^hi\n\n?\[exit 3 · [^\]]+\]$/],
      [nativeFails, /\[exit 4 · [^\]]+\]$/],
      [`& ${node} -e "process.exit(4)"`, /\[exit 4 · [^\]]+\]$/],
      ["Get-Item ./does-not-exist", /does-not-exist[\s\S]*\[exit 1 · [^\]]+\]$/],
      ["throw 'boom'", /boom[\s\S]*\[exit 1 · [^\]]+\]$/],
      [`${nativeFails}; Write-Output after`, /after\n\n?\[exit 0 · [^\]]+\]$/],
      // A failing cmdlet after a failed native command fails with 1, not the native code; the reverse keeps the code.
      [`${nativeFails}; Get-Item ./does-not-exist`, /does-not-exist[\s\S]*\[exit 1 · [^\]]+\]$/],
      [`Get-Item ./does-not-exist; ${nativeFails}`, /\[exit 4 · [^\]]+\]$/],
      [`$program = ${node}; & $program -e "process.exit(6)"`, /\[exit 6 · [^\]]+\]$/],
      // The last program counts through a variable or an alias even after an earlier cmdlet failed.
      [`Get-Item ./does-not-exist; $program = ${node}; & $program -e "process.exit(6)"`, /\[exit 6 · [^\]]+\]$/],
      [`Get-Item ./does-not-exist; Set-Alias rawnode ${node}; rawnode -e "process.exit(7)"`, /\[exit 7 · [^\]]+\]$/],
      ["end { Get-Item ./does-not-exist }", /does-not-exist[\s\S]*\[exit 1 · [^\]]+\]$/],
      ["begin { Write-Output first } process { Get-Item ./does-not-exist }", /^first\n[\s\S]*\[exit 1 · [^\]]+\]$/],
      ["end { Write-Output x; exit 9 }", /^x\n\n?\[exit 9 · [^\]]+\]$/],
      // A program named in a string, run by a function or by a script without exit still gives its code.
      [`Get-Item ./does-not-exist; $env:RAW_NODE = ${node}; & "$env:RAW_NODE" -e "process.exit(8)"`, /\[exit 8 · [^\]]+\]$/],
      [`function build { & ${node} -e "process.exit(4)" }; build`, /\[exit 4 · [^\]]+\]$/],
      [`Set-Content child.ps1 "& ${node} -e 'process.exit(12)'"; ./child.ps1`, /\[exit 12 · [^\]]+\]$/],
      [`if ($true) { ${nativeFails} }`, /\[exit 4 · [^\]]+\]$/],
      // A native failure followed by a successful assignment succeeds.
      [`${nativeFails}; $after = 1`, /^\n?\[exit 0 · [^\]]+\]$/],
      // StrictMode and Stop set by the command do not break the closing code.
      ["Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'; $x = 1", /^\n?\[exit 0 · [^\]]+\]$/],
      ["Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'; if ($true) { $y = 2 }", /^\n?\[exit 0 · [^\]]+\]$/],
      [`Set-StrictMode -Version Latest; ${nativeFails}`, /\[exit 4 · [^\]]+\]$/],
      // The command parses on its own: a leading using statement is valid.
      ['using namespace System.Text; [StringBuilder]::new().Append("built").ToString()', /^built\n\n?\[exit 0 · [^\]]+\]$/],
      ["end { Write-Output named }", /^named\n\n?\[exit 0 · [^\]]+\]$/],
      ["Write-Output 'unterminated", /terminator[\s\S]*\[exit 1 · [^\]]+\]$/],
      ['Write-Output "héllo ✓"', /^héllo ✓\n\n?\[exit 0 · [^\]]+\]$/],
    ];
    for (const [command, expected] of cases) assert.match(await run(command), expected, command);
    // Arrays reach PowerShell with their words intact.
    const array = await tools.dispatch("powershell", { command: ["Write-Output", "it's fine", "a,b"] }, { cwd, maxOutputBytes: 8192 });
    assert.match(text(array), /^it's fine\na,b\n\n?\[exit 0 · [^\]]+\]$/);
    // The error's line number is the command's own line, though the setup runs before it: 5.1 says "At line:2", pwsh 7
    // draws "2 |" beside the line.
    assert.match(await run("Write-Output one\nthrow 'second line'"), /(At line:2 char|^\s+2 \| +throw)/m);
    if (windows) {
      // npm resolves to npm.ps1, which the default Restricted policy would refuse.
      assert.match(await run("npm --version"), /^\d+\.\d+\.\d+\n\n?\[exit 0 · [^\]]+\]$/);
    }
  }));

  test(`${version.name}: a timeout stops the command with its native grandchildren`, { skip }, () => using(version, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-ps-timeout-")));
    const marker = unique();
    await writeFile(join(cwd, "grand.mjs"), "import { spawn } from 'node:child_process';\n"
      + "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[2]], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n");
    const tools = await registry();
    const running = tools.dispatch("powershell", { timeout: 15000,
      command: `Start-Process -NoNewWindow -FilePath ${node} -ArgumentList 'grand.mjs','${marker}'; Start-Sleep 300` }, { cwd, maxOutputBytes: 8192 });
    // Both the child and its grandchild carry the marker; see them alive before the deadline.
    await waitFor(() => marked(marker).length >= 2 ? true : undefined, 14000);
    const result = await running;
    assert.match(text(result), /\[timed out after 15s; process (tree|group) stopped\]$/);
    assert.deepEqual(await waitFor(() => marked(marker).length ? undefined : [], 5000), []);
  }));

  test(`${version.name}: on Windows a command that exits takes what it started with it`, { skip: windows ? skip : "needs Windows" }, () => using(version, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-ps-leader-")));
    const marker = unique();
    const tools = await registry();
    const running = tools.dispatch("powershell", { command: `Start-Process -NoNewWindow -FilePath ${node} -ArgumentList '-e','setInterval(()=>{},1000)','${marker}'; `
      + "while (-not (Test-Path go)) { Start-Sleep -Milliseconds 100 }; Write-Output leaving" }, { cwd, maxOutputBytes: 8192 });
    await waitFor(() => marked(marker).length ? true : undefined);
    await writeFile(join(cwd, "go"), "");
    assert.match(text(await running), /leaving\n\n?\[exit 0 · [^\]]+\]$/);
    assert.deepEqual(await waitFor(() => marked(marker).length ? undefined : [], 5000), []);
  }));

  test(`${version.name}: background calls and process starts with shell powershell run in PowerShell`, { skip }, () => using(version, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "raw-ps-background-")));
    const tools = await registry();
    const supervisor = new ProcessSupervisor();
    const processes = supervisor.forSession("powershell");
    const context = { cwd, maxOutputBytes: 8192, processes };
    try {
      const started = await tools.dispatch("powershell", { command: "Write-Output \"edition $($PSVersionTable.PSVersion.Major)\"; Start-Sleep 30", run_in_background: true }, context);
      assert.equal(started.isError, false, text(started));
      const id = started.host!.processId!;
      const page = await waitFor(async () => {
        const output = text(await tools.dispatch("process", { action: "output", id }, context));
        return /edition \d+/.test(output) ? output : undefined;
      });
      assert.match(page, version.name === "5.1" ? /edition 5/ : /edition [7-9]/);
      assert.match(text(await tools.dispatch("process", { action: "stop", id }, context)), new RegExp(`^Stopped ${id} · `));

      const direct = await tools.dispatch("process", { action: "start", shell: "powershell", command: "Write-Output $PSVersionTable.PSEdition; exit 5" }, context);
      const directId = direct.host!.processId!;
      const done = await waitFor(async () => {
        const output = text(await tools.dispatch("process", { action: "output", id: directId }, context));
        return /\[(exited|failed) · /.test(output) ? output : undefined;
      });
      assert.match(done, /^(Core|Desktop)\n[\s\S]*\[failed · exit 5\]$/);
      const invalid = await tools.dispatch("process", { action: "start", shell: "cmd", command: "echo hi" }, context);
      assert.equal(invalid.isError, true);
      assert.match(text(invalid), /shell must be bash or powershell/);
    } finally { await supervisor.close(); }
  }));
}
