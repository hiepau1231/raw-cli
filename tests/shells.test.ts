import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findGitBash, findPowerShell } from "../src/platform/windows.js";
import { BASH_UNAVAILABLE, POWERSHELL_UNAVAILABLE, resolveBash, resolvePowerShell } from "../src/tools/shells.js";

const base = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
const files = (...present: string[]) => (file: string) => present.some((item) => item.toLowerCase() === file.toLowerCase());
const find = (env: NodeJS.ProcessEnv, present: string[], workspace = "C:\\repo") => findGitBash({ ...base, ...env }, workspace, files(...present));

test("Git Bash is found in the documented order", () => {
  const program = "C:\\Program Files\\Git\\bin\\bash.exe";
  const user = "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
  const derived = "D:\\PortableGit\\bin\\bash.exe";
  const onPath = "D:\\msys\\usr\\bin\\bash.exe";
  const Path = "D:\\PortableGit\\cmd;D:\\msys\\usr\\bin";
  const all = [program, user, "D:\\PortableGit\\cmd\\git.exe", derived, onPath];
  assert.equal(find({ RAW_BASH_PATH: "E:\\custom\\bash.exe", Path }, all), "E:\\custom\\bash.exe");
  assert.equal(find({ Path }, all), program);
  assert.equal(find({ Path, ProgramFiles: "C:\\Program Files (x86)" }, all), program, "ProgramW6432 on a 32-bit Node");
  assert.equal(find({ Path }, all.slice(1)), user);
  assert.equal(find({ Path }, all.slice(2)), derived);
  assert.equal(find({ Path }, [onPath]), onPath);
  // Git's own layout puts git.exe in mingw64\bin too.
  assert.equal(find({ Path: "D:\\G\\mingw64\\bin" }, ["D:\\G\\mingw64\\bin\\git.exe", "D:\\G\\bin\\bash.exe"]), "D:\\G\\bin\\bash.exe");
  assert.equal(find({ PATH: "D:\\PortableGit\\cmd" }, ["D:\\PortableGit\\cmd\\git.exe", derived]), derived, "PATH under any spelling");
});

test("WSL's bash, WindowsApps, relative entries and the workspace are never picked implicitly", () => {
  const wsl = ["C:\\Windows\\System32\\bash.exe", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", "C:\\work\\bin\\bash.exe"];
  assert.equal(find({ Path: "C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;bin" }, wsl), undefined);
  assert.equal(find({ Path: "c:\\windows\\system32" }, ["c:\\windows\\system32\\bash.exe"]), undefined, "any case");
  // A bash.exe or git.exe in a PATH entry inside the workspace, or a fixed location inside it, is skipped.
  assert.equal(find({ Path: "C:\\repo\\tools" }, ["C:\\repo\\tools\\bash.exe"]), undefined);
  assert.equal(find({ Path: "C:\\repo\\git\\cmd" }, ["C:\\repo\\git\\cmd\\git.exe", "C:\\repo\\git\\bin\\bash.exe"]), undefined);
  assert.equal(find({ Path: "" }, ["C:\\Program Files\\Git\\bin\\bash.exe"], "C:\\Program Files"), undefined);
  // The exclusions hold for every implicit step, not only the last PATH search.
  const apps = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps";
  assert.equal(find({ Path: `${apps}\\Git\\cmd` }, [`${apps}\\Git\\cmd\\git.exe`, `${apps}\\Git\\bin\\bash.exe`]), undefined);
  assert.equal(find({ Path: "C:\\Windows\\Git\\cmd" }, ["C:\\Windows\\Git\\cmd\\git.exe", "C:\\Windows\\Git\\bin\\bash.exe"]), undefined);
  assert.equal(find({ Path: "", ProgramFiles: "C:\\Windows\\pf", ProgramW6432: "", LOCALAPPDATA: `${apps}\\x` },
    ["C:\\Windows\\pf\\Git\\bin\\bash.exe", `${apps}\\x\\Programs\\Git\\bin\\bash.exe`]), undefined);
  for (const SystemRoot of [undefined, ""]) {
    const viaWindir = { Path: "D:\\Win\\Git\\cmd", SystemRoot, windir: "D:\\Win" };
    const present = ["D:\\Win\\Git\\cmd\\git.exe", "D:\\Win\\Git\\bin\\bash.exe"];
    assert.equal(find(viaWindir, present), undefined, `windir with SystemRoot ${SystemRoot === undefined ? "unset" : "empty"}`);
    assert.equal(find({ ...viaWindir, windir: "D:\\Other" }, present), "D:\\Win\\Git\\bin\\bash.exe", "the same Git outside the Windows folder");
  }
  // An explicit RAW_BASH_PATH is honored wherever it points.
  assert.equal(find({ RAW_BASH_PATH: "C:\\Windows\\System32\\bash.exe" }, []), "C:\\Windows\\System32\\bash.exe");
  assert.equal(find({ RAW_BASH_PATH: "C:\\repo\\bash.exe" }, []), "C:\\repo\\bash.exe");
});

test("resolveBash reports bash_unavailable on Windows and keeps other platforms unchanged", () => {
  assert.equal(BASH_UNAVAILABLE, "Bash was not found. Install Git for Windows, set RAW_BASH_PATH to its bin\\bash.exe, or select builtin/powershell.");
  assert.deepEqual(resolveBash({ env: { ...base, Path: "C:\\Windows\\System32" }, platform: "win32", workspace: "C:\\repo", exists: files("C:\\Windows\\System32\\bash.exe") }),
    { ok: false, code: "bash_unavailable", message: BASH_UNAVAILABLE });
  assert.deepEqual(resolveBash({ env: { ...base, Path: "" }, platform: "win32", workspace: "C:\\repo", exists: files("C:\\Program Files\\Git\\bin\\bash.exe") }),
    { ok: true, path: "C:\\Program Files\\Git\\bin\\bash.exe" });
  assert.deepEqual(resolveBash({ env: {}, platform: "linux", workspace: "/repo" }), { ok: true, path: "bash" });
  assert.deepEqual(resolveBash({ env: { RAW_BASH_PATH: "/opt/bash" }, platform: "darwin", workspace: "/repo" }), { ok: true, path: "/opt/bash" });
});

test("on Windows CI the bash tool finds Git's bin\\bash.exe", { skip: process.platform === "win32" ? false : "needs Windows" }, () => {
  const found = resolveBash({ env: { ...process.env, RAW_BASH_PATH: "" }, platform: "win32", workspace: process.cwd() });
  assert.ok(found.ok, JSON.stringify(found));
  assert.match(found.path, /\\Git\\bin\\bash\.exe$/i);
});

test("on Windows a cached Bash is looked up again when an excluding folder changes", { skip: process.platform === "win32" ? false : "needs Windows" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-bash-cache-"));
  try {
    mkdirSync(join(dir, "win", "tools"), { recursive: true });
    writeFileSync(join(dir, "win", "tools", "bash.exe"), "");
    const at = (windir: string) => resolveBash({ platform: "win32", workspace: join(dir, "repo"),
      env: { PATH: join(dir, "win", "tools"), windir, ProgramFiles: join(dir, "none"), ProgramW6432: "", LOCALAPPDATA: "", RAW_BASH_PATH: "" } });
    assert.deepEqual(at(join(dir, "elsewhere")), { ok: true, path: join(dir, "win", "tools", "bash.exe") });
    assert.equal(at(join(dir, "win")).ok, false, "the same PATH under the new Windows folder is excluded, not served from the cache");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PowerShell is found in the documented order on Windows", () => {
  const onPath = "D:\\tools\\pwsh\\pwsh.exe";
  const seven = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const five = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const all = [onPath, seven, five];
  const look = (env: NodeJS.ProcessEnv, present: string[]) => findPowerShell({ ...base, ...env }, files(...present), "C:\\repo");
  assert.equal(look({ RAW_POWERSHELL_PATH: "E:\\ps\\pwsh.exe", Path: "D:\\tools\\pwsh" }, all), "E:\\ps\\pwsh.exe");
  assert.equal(look({ Path: "D:\\tools\\pwsh" }, all), onPath);
  assert.equal(look({ PATH: "D:\\tools\\pwsh" }, all), onPath, "PATH under any spelling");
  assert.equal(look({ Path: "D:\\tools\\pwsh" }, all.slice(1)), seven);
  assert.equal(look({ Path: "" }, [five]), five, "Windows PowerShell 5.1 last");
  assert.equal(look({ Path: "", SystemRoot: "", windir: "D:\\Win" }, ["D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]),
    "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "the Windows folder from windir");
  // Relative PATH entries and entries inside the workspace are skipped; a quoted entry is read without its quotes.
  assert.equal(look({ Path: "tools;C:\\repo\\bin" }, ["tools\\pwsh.exe", "C:\\repo\\bin\\pwsh.exe", five]), five);
  assert.equal(look({ Path: '"D:\\tools\\pwsh"' }, [onPath]), onPath);
  assert.equal(look({ Path: "", ProgramFiles: "C:\\repo\\pf" }, ["C:\\repo\\pf\\PowerShell\\7\\pwsh.exe"]), undefined);
});

test("resolvePowerShell reports powershell_unavailable, and elsewhere looks for pwsh on PATH", () => {
  assert.equal(POWERSHELL_UNAVAILABLE, "PowerShell was not found. Install PowerShell 7 (pwsh) or set RAW_POWERSHELL_PATH to pwsh or powershell.exe.");
  const missing = { ok: false, code: "powershell_unavailable", message: POWERSHELL_UNAVAILABLE };
  assert.deepEqual(resolvePowerShell({ env: { ...base, Path: "" }, platform: "win32", workspace: "C:\\repo", exists: files() }), missing);
  for (const platform of ["darwin", "linux"] as const) {
    const at = (env: NodeJS.ProcessEnv, present: string[]) => resolvePowerShell({ env, platform, workspace: "/repo", exists: files(...present) });
    assert.deepEqual(at({ PATH: "/usr/bin:/opt/ps" }, ["/opt/ps/pwsh"]), { ok: true, path: "/opt/ps/pwsh" });
    assert.deepEqual(at({ PATH: "bin:/repo/tools:/usr/bin" }, ["bin/pwsh", "/repo/tools/pwsh"]), missing, `${platform}: relative and workspace entries skipped`);
    assert.deepEqual(at({ RAW_POWERSHELL_PATH: "/x/pwsh", PATH: "/opt/ps" }, ["/opt/ps/pwsh"]), { ok: true, path: "/x/pwsh" });
  }
});

test("on Windows CI the powershell tool finds a PowerShell", { skip: process.platform === "win32" ? false : "needs Windows" }, () => {
  const found = resolvePowerShell({ env: { ...process.env, RAW_POWERSHELL_PATH: "" }, platform: "win32", workspace: process.cwd() });
  assert.ok(found.ok, JSON.stringify(found));
  assert.match(found.path, /\\(pwsh|powershell)\.exe$/i);
});
