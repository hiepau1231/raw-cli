// src/platform/paths.ts
import path from "path";
function pathFor(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}
function resolveToolPath(cwd, input, platform = process.platform) {
  const api = pathFor(platform);
  if (platform !== "win32") return api.resolve(cwd, input);
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(input);
  return api.resolve(cwd, drive ? `${drive[1].toUpperCase()}:\\${drive[2] ?? ""}` : input);
}

// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, unlink } from "fs/promises";
import { dirname as dirname2, join as join2, parse, relative, sep } from "path";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/spill.ts
import { closeSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";
var SPILL_MAX_BYTES = 64 * 1024 * 1024;
var SPILL_TOTAL_BYTES = 1024 * 1024 * 1024;
var SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 60 * 1e3;
var PREFIX = "raw-output-";
var directory;
var lastSweep = 0;
var saved = [];
var savedBytes = 0;
var totalLimit = SPILL_TOTAL_BYTES;
var SPILL_PATH_RESERVE = tmpdir().length + 96;
function sweep(root) {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  try {
    const cutoff = Date.now() - SPILL_RETENTION_MS;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const path5 = join(root, name);
      if (path5 === directory) continue;
      try {
        if (statSync(path5).mtimeMs < cutoff) rmSync(path5, { recursive: true, force: true });
      } catch {
      }
    }
  } catch {
  }
}
function spillDirectory() {
  const root = tmpdir();
  sweep(root);
  directory ??= mkdtempSync(join(root, PREFIX));
  return directory;
}
function reserve(bytes, keep) {
  savedBytes += bytes;
  keep.bytes += bytes;
  while (savedBytes > totalLimit) {
    const oldest = saved.find((entry) => entry !== keep);
    if (!oldest) break;
    saved.splice(saved.indexOf(oldest), 1);
    savedBytes -= oldest.bytes;
    try {
      rmSync(oldest.path, { force: true });
    } catch {
    }
  }
}
var OutputSpill = class {
  constructor(label) {
    this.label = label;
  }
  label;
  fd;
  failed = false;
  entry;
  path;
  bytes = 0;
  capped = false;
  write(data) {
    if (this.failed || this.capped) return;
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    try {
      if (this.fd === void 0) {
        const path5 = join(spillDirectory(), `${this.label}-${randomUUID().slice(0, 8)}.log`);
        this.fd = openSync(path5, "wx", 384);
        this.path = path5;
        this.entry = { path: path5, bytes: 0 };
        saved.push(this.entry);
      }
      const room = SPILL_MAX_BYTES - this.bytes;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      writeSync(this.fd, slice);
      this.bytes += slice.length;
      reserve(slice.length, this.entry);
      if (slice.length < buffer.length) this.capped = true;
    } catch {
      this.failed = true;
      this.close();
      this.path = void 0;
    }
  }
  close() {
    if (this.fd === void 0) return;
    try {
      closeSync(this.fd);
    } catch {
    }
    this.fd = void 0;
  }
};
function savedLabel(path5, capped = false) {
  return path5 && capped ? `${path5} (first ${SPILL_MAX_BYTES} bytes only)` : path5;
}

// src/tools/results.ts
var DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
var HOST_CONTENT_BYTES = 1024 * 1024;
function utf8Prefix(value, limit) {
  let text = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar);
    if (bytes + size > limit) return { text, bytes, truncated: true };
    text += scalar;
    bytes += size;
  }
  return { text, bytes, truncated: false };
}
function utf8Suffix(value, limit) {
  const scalars = [...value];
  let bytes = 0;
  let start = scalars.length;
  while (start > 0) {
    const size = Buffer.byteLength(scalars[start - 1]);
    if (bytes + size > limit) break;
    bytes += size;
    start--;
  }
  return { text: scalars.slice(start).join(""), bytes, truncated: start > 0 };
}
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/platform/fs.ts
import { closeSync as closeSync2, fsyncSync, openSync as openSync2 } from "fs";
import { access, readFile, rename } from "fs/promises";
import path2 from "path";
function contained(root, candidate, api = path2) {
  const rel = api.relative(api.resolve(root), api.resolve(candidate));
  return rel === "" || rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

// src/tools/write-changes.ts
import { homedir } from "os";

// src/panels/contract.ts
var PANEL_LIMITS = {
  panelsPerTool: 4,
  actionsPerPanel: 8,
  panelsPerSession: 16,
  documentBytes: 64 * 1024,
  blocks: 20,
  items: 200,
  steps: 30,
  checklistDepth: 3,
  updatesPerCall: 200,
  receiptBytes: 1024,
  reminderBytes: 2 * 1024,
  reminderTotalBytes: 8 * 1024,
  markdownBytes: 16 * 1024,
  fallbackBytes: 4 * 1024,
  contextSummaryBytes: 2048
};

// src/tools/write-changes.ts
var HOST_DIFF_BYTES = 64 * 1024;
var ENTRY_DIFF_BYTES = 8 * 1024;
var MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile as readFile2, stat } from "fs/promises";
import { dirname as dirname4 } from "path";

// src/tools/process.ts
import { spawn as spawn2 } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/shells.ts
import { constants as constants2, accessSync, statSync as statSync3 } from "fs";
import path4 from "path";

// src/platform/windows.ts
import { spawn, spawnSync } from "child_process";
import { createHash as createHash2, randomUUID as randomUUID3 } from "crypto";
import { existsSync as existsSync2, mkdirSync, readFileSync, renameSync, rmSync as rmSync2, statSync as statSync2, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import path3 from "path";

// src/package-root.ts
import { existsSync } from "fs";
import { dirname as dirname3, join as join3 } from "path";
import { fileURLToPath } from "url";
function packageRoot() {
  let directory2 = dirname3(fileURLToPath(import.meta.url));
  for (; ; ) {
    if (existsSync(join3(directory2, "package.json"))) return directory2;
    const parent = dirname3(directory2);
    if (parent === directory2) throw new Error("Raw package root not found");
    directory2 = parent;
  }
}

// src/platform/windows.ts
var win32 = path3.win32;
function mergeEnv(base, overrides = {}, platform = process.platform) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === "win32") for (const existing of Object.keys(merged)) {
      if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete merged[existing];
    }
    merged[key] = value;
  }
  return merged;
}
function envValue(env, name) {
  if (env[name] !== void 0) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return void 0;
}
function windowsFolder(env = process.env) {
  return envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows";
}
function systemBinary(name, env = process.env) {
  return win32.join(windowsFolder(env), "System32", name);
}
function isRegularFile(file) {
  try {
    return statSync2(file).isFile();
  } catch {
    return false;
  }
}
function resolveCommand(command, args, options) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { ok: true, file: command, args: [...args] };
  const env = options.env ?? process.env;
  const exists = options.exists ?? isRegularFile;
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const withExtensions = (base) => [...win32.extname(base) ? [base] : [], ...extensions.map((ext) => base + ext.toLowerCase())];
  const locate = (name) => {
    if (win32.isAbsolute(name) || /[\\/]/.test(name)) return withExtensions(win32.resolve(options.cwd, name)).find(exists);
    for (const directory2 of (envValue(env, "PATH") ?? "").split(";")) {
      const entry = directory2.replace(/^"(.*)"$/, "$1");
      if (!entry || !win32.isAbsolute(entry)) continue;
      const found2 = withExtensions(win32.join(entry, name)).find(exists);
      if (found2) return found2;
    }
    return void 0;
  };
  const interpreter = (found2) => win32.isAbsolute(found2) ? found2 : locate(found2);
  const file = locate(command);
  if (!file) return { ok: false, code: "not_found", message: `command not found: ${command}` };
  const extension = win32.extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { ok: true, file: options.node ?? process.execPath, args: [file, ...args] };
  if (extension === ".ps1") {
    const configured = (options.powershell ?? (() => findPowerShell(env, exists, options.cwd)))();
    const powershell = configured && interpreter(configured);
    if (!powershell) return { ok: false, code: "not_found", message: "PowerShell was not found" };
    return { ok: true, file: powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args] };
  }
  if (extension === ".sh") {
    const configured = (options.bash ?? (() => findGitBash(env, options.cwd, exists)))();
    const bash = configured && interpreter(configured);
    if (!bash) return { ok: false, code: "bash_unavailable", message: "Bash was not found. Install Git for Windows or set RAW_BASH_PATH to its bin\\bash.exe." };
    return { ok: true, file: bash, args: [file, ...args] };
  }
  if (extension === ".cmd" || extension === ".bat") {
    const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
    const line = [quoteCmdCommand(file), ...args.map((arg) => quoteCmdArgument(arg, twice))].join(" ");
    return { ok: true, file: systemBinary("cmd.exe", env), args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, batch: file };
  }
  return { ok: true, file, args: [...args] };
}
var CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function quoteCmdCommand(file) {
  return win32.normalize(file).replace(CMD_META, "^$1");
}
function quoteCmdArgument(arg, twice = false) {
  let quoted = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return twice ? quoted.replace(CMD_META, "^$1") : quoted;
}
function quoteWindowsArgument(arg) {
  if (!arg) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = "";
  let beforeQuote = true;
  for (let i = arg.length - 1; i >= 0; i--) {
    const char = arg[i];
    out = char + out;
    if (beforeQuote && char === "\\") out = "\\" + out;
    else if (char === '"') {
      beforeQuote = true;
      out = "\\" + out;
    } else beforeQuote = false;
  }
  return `"${out}"`;
}
function findPowerShell(env = process.env, exists = isRegularFile, workspace) {
  const configured = envValue(env, "RAW_POWERSHELL_PATH");
  if (configured) return configured;
  const outside = (candidate) => workspace === void 0 || !contained(workspace, candidate, win32);
  for (const directory2 of (envValue(env, "PATH") ?? "").split(";")) {
    const entry = directory2.replace(/^"(.*)"$/, "$1");
    if (!entry || !win32.isAbsolute(entry) || !outside(entry)) continue;
    if (exists(win32.join(entry, "pwsh.exe"))) return win32.join(entry, "pwsh.exe");
  }
  const programFiles = envValue(env, "ProgramFiles");
  for (const candidate of [
    ...programFiles ? [win32.join(programFiles, "PowerShell", "7", "pwsh.exe")] : [],
    systemBinary(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env)
  ]) {
    if (outside(candidate) && exists(candidate)) return candidate;
  }
  return void 0;
}
function findGitBash(env, workspace, exists = isRegularFile) {
  const configured = envValue(env, "RAW_BASH_PATH");
  if (configured) return configured;
  const windows = windowsFolder(env);
  const allowed = (candidate) => !contained(windows, candidate, win32) && !contained(workspace, candidate, win32) && !candidate.split(/[\\/]/).some((part) => part.toLowerCase() === "windowsapps");
  const usable = (candidate) => allowed(candidate) && exists(candidate);
  const installs = [envValue(env, "ProgramFiles"), envValue(env, "ProgramW6432")].filter((root) => !!root).map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  const local = envValue(env, "LOCALAPPDATA");
  for (const candidate of [...installs, ...local ? [win32.join(local, "Programs", "Git", "bin", "bash.exe")] : []]) {
    if (usable(candidate)) return candidate;
  }
  const entries = (envValue(env, "PATH") ?? "").split(";").map((entry) => entry.replace(/^"(.*)"$/, "$1")).filter((entry) => entry && win32.isAbsolute(entry) && allowed(entry));
  for (const entry of entries) {
    if (!exists(win32.join(entry, "git.exe"))) continue;
    const root = /[\\/]cmd[\\/]?$/i.test(entry) ? win32.dirname(win32.resolve(entry)) : /[\\/]mingw(?:32|64)[\\/]bin[\\/]?$/i.test(entry) ? win32.dirname(win32.dirname(win32.resolve(entry))) : void 0;
    if (root && usable(win32.join(root, "bin", "bash.exe"))) return win32.join(root, "bin", "bash.exe");
  }
  for (const entry of entries) if (exists(win32.join(entry, "bash.exe"))) return win32.join(entry, "bash.exe");
  return void 0;
}
var launchers = /* @__PURE__ */ new Map();
var warned = false;
function launcherSource() {
  const root = packageRoot();
  for (const candidate of [path3.join(root, "dist", "platform", "job-launcher.cs"), path3.join(root, "src", "platform", "job-launcher.cs")]) {
    if (existsSync2(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("job-launcher.cs is missing from the Raw package");
}
function compileLauncher(source, output, env) {
  const windows = windowsFolder(env);
  const compiler = ["Framework64", "Framework"].map((folder) => win32.join(windows, "Microsoft.NET", folder, "v4.0.30319", "csc.exe")).find((candidate) => existsSync2(candidate));
  if (!compiler) throw new Error("the .NET Framework C# compiler (csc.exe) was not found");
  const input = `${output}.cs`;
  writeFileSync(input, source);
  try {
    const result = spawnSync(compiler, ["/nologo", "/optimize", "/target:exe", `/out:${output}`, input], { encoding: "utf8", windowsHide: true, env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`csc.exe failed: ${(result.stdout + result.stderr).trim().slice(0, 2e3)}`);
  } finally {
    rmSync2(input, { force: true });
  }
}
function stateDirectory(env = process.env) {
  return path3.join(env.XDG_STATE_HOME ? path3.resolve(env.XDG_STATE_HOME) : path3.join(homedir2(), ".local", "state"), "raw");
}
function jobLauncher(options) {
  if ((options.platform ?? process.platform) !== "win32") return void 0;
  const env = options.env ?? process.env;
  let result;
  let target;
  try {
    const source = options.source ?? launcherSource();
    target = path3.join(options.stateDir, "bin", `raw-job-${createHash2("sha256").update(source).digest("hex").slice(0, 12)}.exe`);
    if (launchers.has(target)) return launchers.get(target);
    if (!existsSync2(target)) {
      mkdirSync(path3.dirname(target), { recursive: true });
      const staged = `${target}.${randomUUID3()}.exe`;
      try {
        (options.compile ?? compileLauncher)(source, staged, env);
        try {
          renameSync(staged, target);
        } catch (error) {
          if (!existsSync2(target)) throw error;
        }
      } finally {
        rmSync2(staged, { force: true });
      }
    }
    result = target;
  } catch (error) {
    if (!warned) {
      warned = true;
      (options.log ?? ((message) => process.stderr.write(`${message}
`)))(
        `raw: the Windows job launcher is unavailable (${error.message}); process trees are stopped with taskkill`
      );
    }
  }
  if (target) launchers.set(target, result);
  return result;
}
function wrapInJob(resolved, launcher) {
  if (!launcher) return resolved;
  const quote = resolved.windowsVerbatimArguments ? (arg) => arg : quoteWindowsArgument;
  const line = [resolved.file, ...resolved.args].map(quote).join(" ");
  const encode = (text) => Buffer.from(text, "utf8").toString("base64");
  return { file: launcher, args: ["--app", encode(resolved.file), "--line", encode(line)] };
}
var exited = (child) => child.exitCode !== null || child.signalCode !== null;
function terminateTree(child, options) {
  if (!child.pid || exited(child)) return;
  const report = (message) => {
    setTimeout(() => {
      if (!exited(child)) options.onError?.(message);
    }, 250).unref();
  };
  const last = () => {
    if (exited(child)) return;
    try {
      if (!child.kill()) report(`cannot stop process ${child.pid}`);
    } catch (error) {
      report(`cannot stop process ${child.pid}: ${error.message}`);
    }
  };
  if (options.jobbed) return last();
  const killer = spawn(systemBinary("taskkill.exe", options.env), ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
  killer.on("error", (error) => {
    report(`taskkill failed: ${error.message}`);
    last();
  });
  killer.on("exit", (code) => {
    if (code !== 0) report(`taskkill exited with ${code}`);
    last();
  });
}

// src/tools/shells.ts
var BASH_UNAVAILABLE = "Bash was not found. Install Git for Windows, set RAW_BASH_PATH to its bin\\bash.exe, or select builtin/powershell.";
var POWERSHELL_UNAVAILABLE = "PowerShell was not found. Install PowerShell 7 (pwsh) or set RAW_POWERSHELL_PATH to pwsh or powershell.exe.";
var found = /* @__PURE__ */ new Map();
function cached(kind, options, names, search) {
  const env = options.env ?? process.env;
  const key = JSON.stringify([kind, options.workspace, ...names.map((name) => envValue(env, name) ?? null)]);
  const hit = options.exists ? void 0 : found.get(key);
  const result = hit ?? search();
  if (result && !options.exists) found.set(key, result);
  return result;
}
function resolveBash(options) {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return { ok: true, path: env.RAW_BASH_PATH || "bash" };
  const found2 = cached(
    "bash",
    options,
    ["RAW_BASH_PATH", "PATH", "ProgramFiles", "ProgramW6432", "LOCALAPPDATA", "SystemRoot", "windir"],
    () => findGitBash(env, options.workspace, options.exists)
  );
  return found2 ? { ok: true, path: found2 } : { ok: false, code: "bash_unavailable", message: BASH_UNAVAILABLE };
}
var executable = (file) => {
  try {
    return statSync3(file).isFile() && (accessSync(file, constants2.X_OK), true);
  } catch {
    return false;
  }
};
function resolvePowerShell(options) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const search = platform === "win32" ? () => findPowerShell(env, options.exists, options.workspace) : () => {
    if (env.RAW_POWERSHELL_PATH) return env.RAW_POWERSHELL_PATH;
    const exists = options.exists ?? executable;
    for (const entry of (env.PATH ?? "").split(path4.posix.delimiter)) {
      if (!path4.posix.isAbsolute(entry) || contained(options.workspace, entry, path4.posix)) continue;
      if (exists(path4.posix.join(entry, "pwsh"))) return path4.posix.join(entry, "pwsh");
    }
    return void 0;
  };
  const result = cached("powershell", options, ["RAW_POWERSHELL_PATH", "PATH", "ProgramFiles", "SystemRoot", "windir"], search);
  return result ? { ok: true, path: result } : { ok: false, code: "powershell_unavailable", message: POWERSHELL_UNAVAILABLE };
}
var powerShellQuote = (value) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
function powerShellArgs(command) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'; if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding",
    `$__rawText = ${powerShellQuote(command)}`,
    "try { $__rawAst = [ScriptBlock]::Create($__rawText).Ast } catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }",
    "$__rawBlock = @($__rawAst.EndBlock, $__rawAst.ProcessBlock, $__rawAst.BeginBlock) | Where-Object { $_ } | Select-Object -First 1",
    '$__rawRun = if (-not $__rawBlock) { $__rawText } elseif ($__rawBlock.Unnamed) { $__rawText + "`n`$global:__rawOk = `$?" } else { $__rawText.Insert($__rawBlock.Extent.EndOffset - 1, "`n`$global:__rawOk = `$?`n") }',
    "$global:__rawOk = $true; $global:__rawNative = $false; $global:LASTEXITCODE = 0",
    "$ExecutionContext.InvokeCommand.PostCommandLookupAction = { param($name, $lookup) $found = $lookup.Command; while ($found -is [System.Management.Automation.AliasInfo]) { $found = $found.ResolvedCommand }; $global:__rawNative = $found -is [System.Management.Automation.ApplicationInfo] }",
    ". ([ScriptBlock]::Create($__rawRun))",
    "$ExecutionContext.InvokeCommand.PostCommandLookupAction = $null; Set-StrictMode -Off; $ErrorActionPreference = 'Continue'",
    "$__rawLast = if ($__rawBlock) { $__rawBlock.Statements | Select-Object -Last 1 }",
    "$__rawPiped = $__rawLast -is [System.Management.Automation.Language.PipelineAst] -and ($__rawLast.PipelineElements | Select-Object -Last 1) -is [System.Management.Automation.Language.CommandAst]",
    "if ($global:__rawNative -and ($__rawPiped -or -not $global:__rawOk)) { exit $global:LASTEXITCODE }",
    "if ($global:__rawOk) { exit 0 }",
    "exit 1"
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}

// src/tools/process.ts
var OrderedCapture = class {
  constructor(headCap, tailCap) {
    this.headCap = headCap;
    this.tailCap = tailCap;
  }
  headCap;
  tailCap;
  head = [];
  headBytes = 0;
  tail = [];
  tailBytes = 0;
  total = 0;
  dropped = false;
  push(channel, text) {
    if (!text) return;
    this.total += Buffer.byteLength(text);
    let rest = text;
    if (!this.tail.length && this.headBytes < this.headCap) {
      const prefix = utf8Prefix(rest, this.headCap - this.headBytes);
      if (prefix.text) this.head.push({ channel, text: prefix.text });
      this.headBytes += prefix.bytes;
      rest = rest.slice(prefix.text.length);
      if (!rest) return;
    }
    this.tail.push({ channel, text: rest });
    this.tailBytes += Buffer.byteLength(rest);
    while (this.tail.length > 1 && this.tailBytes - Buffer.byteLength(this.tail[0].text) >= this.tailCap) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift().text);
      this.dropped = true;
    }
  }
  /** Everything when nothing was dropped and it fits; otherwise start + marker + end within `limit`. */
  render(limit, fullOutputPath) {
    const all = [...this.head, ...this.tail];
    if (!this.dropped && this.total <= limit) return { segments: merge(all), truncated: false };
    const marker = (omitted) => `
\u2026[${omitted} bytes omitted${fullOutputPath ? `; full output: ${fullOutputPath}` : ""}]\u2026
`;
    const room = limit - Buffer.byteLength(marker(this.total));
    if (room <= 0) return { segments: merge(take(all, limit)), truncated: true };
    const start = take(all, Math.floor(room / 5));
    const startBytes = start.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    const end = takeEnd(this.dropped ? this.tail : all, room - startBytes);
    const endBytes = end.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    return { segments: merge([...start, { text: marker(this.total - startBytes - endBytes) }, ...end]), truncated: true };
  }
};
function take(segments, limit) {
  const kept = [];
  let remaining = limit;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const prefix = utf8Prefix(segment.text, remaining);
    if (prefix.text) kept.push({ ...segment, text: prefix.text });
    remaining -= prefix.bytes;
    if (prefix.truncated) break;
  }
  return kept;
}
function takeEnd(segments, limit) {
  const kept = [];
  let remaining = limit;
  for (let index = segments.length - 1; index >= 0 && remaining > 0; index--) {
    const suffix = utf8Suffix(segments[index].text, remaining);
    if (suffix.text) kept.unshift({ ...segments[index], text: suffix.text });
    remaining -= suffix.bytes;
    if (suffix.truncated) break;
  }
  return kept;
}
function merge(segments) {
  const merged = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && last.channel === segment.channel) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}
var SHELL_NAMES = { bash: "Bash", powershell: "PowerShell" };
var jobbedShells = /* @__PURE__ */ new WeakSet();
function spawnShell(options, platform = process.platform) {
  const workspace = options.workspace ?? options.cwd;
  const powershell = options.shell === "powershell";
  const shell = powershell ? resolvePowerShell({ platform, workspace }) : options.bashPath ? { ok: true, path: options.bashPath } : resolveBash({ platform, workspace });
  if (!shell.ok) throw Object.assign(new Error(shell.message), { code: shell.code });
  let launch = { file: shell.path, args: powershell ? powerShellArgs(options.command) : ["-c", options.command] };
  let jobbed = false;
  if (platform === "win32") {
    const resolved = resolveCommand(shell.path, launch.args, { cwd: options.cwd, platform });
    if (!resolved.ok) throw Object.assign(new Error(`spawn ${shell.path} ENOENT`), { code: "ENOENT", syscall: "spawn" });
    launch = resolved;
    const launcher = jobLauncher({ platform, stateDir: stateDirectory() });
    launch = wrapInJob(launch, launcher);
    jobbed = launcher !== void 0;
  }
  const child = spawn2(launch.file, launch.args, {
    cwd: options.cwd,
    ...options.env ? { env: options.env } : {},
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true
  });
  if (jobbed) jobbedShells.add(child);
  return child;
}
function signalShellGroup(child, signal, platform = process.platform, onError) {
  if (platform === "win32") {
    terminateTree(child, { jobbed: jobbedShells.has(child), ...onError ? { onError } : {} });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function runBash(options) {
  const shell = options.shell ?? "bash";
  if (options.signal?.aborted) return errorResult("aborted", `${shell} aborted before execution`);
  const timeoutMs = options.timeoutMs ?? 12e4;
  let child;
  try {
    child = spawnShell(options);
  } catch (error) {
    const code = error.code;
    if (code === "bash_unavailable" || code === "powershell_unavailable") return errorResult(code, error.message);
    return errorResult(`${shell}_spawn_error`, `cannot start ${SHELL_NAMES[shell]}: ${error.message}`);
  }
  let observedBytes = 0;
  let timedOut = false;
  let aborted = false;
  let spawnError;
  const max = Math.max(0, options.maxOutputBytes);
  const capture = new OrderedCapture(Math.floor(max / 5), max);
  let pending = [];
  let spill;
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let killTimer;
  let drainTimer;
  let reapTimer;
  let deadline;
  let resolveCancelled;
  const cancellationWatchdog = new Promise((resolve2) => {
    resolveCancelled = resolve2;
  });
  let escalation;
  let stopFailure;
  const signalGroup = (signal) => {
    const failed = (message) => {
      stopFailure ??= message;
    };
    try {
      signalShellGroup(child, signal, process.platform, failed);
    } catch (error) {
      failed(error.message);
    }
  };
  const stop = (reason) => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise((resolve2) => {
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve2();
      }, 500);
    });
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveCancelled();
    }, 700);
  };
  const onAbort = () => stop("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  deadline = setTimeout(() => stop("timeout"), timeoutMs);
  const append = (channel, chunk) => {
    observedBytes += chunk.length;
    const text = (channel === "stdout" ? outDecoder : errDecoder).write(chunk);
    try {
      options.onOutput?.(channel, text);
    } catch {
    }
    capture.push(channel, text);
    if (spill) spill.write(chunk);
    else {
      pending.push(chunk);
      if (observedBytes > max) {
        spill = new OutputSpill(shell);
        for (const buffered of pending) spill.write(buffered);
        pending = [];
      }
    }
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  let exited2 = { code: null, signal: null };
  const exitedPromise = new Promise((resolve2) => {
    child.once("exit", (code, signal) => {
      exited2 = { code, signal };
      resolve2();
    });
  });
  let started = false;
  child.once("spawn", () => {
    started = true;
  });
  const closedPromise = new Promise((resolve2) => {
    child.on("error", (error) => {
      if (started) stopFailure ??= error.message;
      else spawnError ??= error;
    });
    child.once("close", () => resolve2());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed"), cancellationWatchdog.then(() => "watchdog")]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise((resolve2) => {
      reapTimer = setTimeout(resolve2, 1300);
    })]);
    if (reapTimer) clearTimeout(reapTimer);
  }
  if (deadline) clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  if (escalation) await escalation;
  if (drainTimer) clearTimeout(drainTimer);
  for (const [channel, tail] of [["stdout", outDecoder.end()], ["stderr", errDecoder.end()]]) {
    if (!tail) continue;
    try {
      options.onOutput?.(channel, tail);
    } catch {
    }
    capture.push(channel, tail);
  }
  spill?.close();
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return errorResult(`${shell}_spawn_error`, `cannot start ${SHELL_NAMES[shell]}: ${spawnError.message}`);
  const { segments, truncated } = capture.render(max, savedLabel(spill?.path, spill?.capped));
  const content = segments.map((segment) => segment.channel ? { type: "text", channel: segment.channel, text: segment.text } : { type: "text", text: segment.text });
  if (stopFailure) content.push({ type: "text", text: `
[stopping the command failed: ${stopFailure}]` });
  return {
    isError: aborted || timedOut,
    ...aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {},
    content,
    exitCode: exited2.code,
    signal: exited2.signal,
    timedOut,
    truncated,
    retainedBytes: segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0),
    observedBytes,
    ...truncated && spill?.path ? { fullOutputPath: spill.path, ...spill.capped ? { fullOutputCapped: true } : {} } : {}
  };
}

// src/tools/primitives.ts
var BASH_DEFAULT_TIMEOUT_MS = 12e4;
var BASH_MAX_TIMEOUT_MS = 6e5;
var BASH_STATUS_RESERVE = 256;
var BACKGROUND_IGNORED = "[ignored run_in_background: background jobs need the process tool; ran in the foreground]";
function seconds(ms) {
  return `${(ms / 1e3).toFixed(1)}s`;
}
function shellTool(kind) {
  return (args, context) => runShellTool(kind, args, context);
}
var bashTool = shellTool("bash");
async function runShellTool(kind, args, context) {
  const cwd = args.workdir === void 0 ? context.cwd : resolveToolPath(context.cwd, args.workdir);
  const requested = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(requested, BASH_MAX_TIMEOUT_MS);
  const summary = utf8Prefix(args.command.split("\n", 1)[0], 200).text;
  const host = (status2, extra = {}) => ({ summary, status: status2, ...args.description ? { description: args.description } : {}, ...extra });
  let bindings;
  if (args.env_refs && Object.keys(args.env_refs).length) {
    if (!context.vars) return { ...errorResult("vars_unavailable", "variable services are unavailable"), host: host("error") };
    try {
      context.vars.validateEnvRefs(args.env_refs);
      bindings = await context.vars.resolveEnv(args.env_refs, { ...context.signal ? { signal: context.signal } : {} });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_env_refs_invalid";
      return { ...errorResult(code, error instanceof Error ? error.message : "invalid variable references"), host: host("error") };
    }
  }
  let activity;
  try {
    activity = context.commandActivity?.begin(args.command, cwd, { owner: `builtin/${kind}`, ...args.description ? { label: args.description } : {}, ...context.toolCallId ? { toolCallId: context.toolCallId } : {} });
  } catch {
  }
  const started = performance.now();
  let result;
  try {
    result = await runBash({
      shell: kind,
      command: args.command,
      cwd,
      workspace: context.cwd,
      maxOutputBytes: Math.max(0, context.maxOutputBytes - BASH_STATUS_RESERVE),
      timeoutMs: timeout,
      ...activity ? { onOutput: activity.output } : {},
      ...bindings ? { env: mergeEnv(process.env, bindings) } : {},
      ...context.signal ? { signal: context.signal } : {},
      ...kind === "bash" && context.bashPath ? { bashPath: context.bashPath } : {}
    });
  } catch (error) {
    result = errorResult(`${kind}_error`, error.message);
  }
  try {
    activity?.finish(result);
  } catch {
  }
  const durationMs = Math.round(performance.now() - started);
  if ([`${kind}_spawn_error`, `${kind}_error`, `${kind}_unavailable`].includes(result.code ?? "")) return { ...result, host: host("error", { durationMs }) };
  const aborted = result.code === "aborted" || context.signal?.aborted === true;
  const stopped = process.platform === "win32" ? "process tree stopped" : "process group stopped";
  const status = aborted ? `[aborted after ${seconds(durationMs)}; ${stopped}]` : result.timedOut ? `[timed out after ${timeout / 1e3}s; ${stopped}]` : result.exitCode === null || result.exitCode === void 0 ? `[killed by ${result.signal ?? "signal"} \xB7 ${seconds(durationMs)}]` : `[exit ${result.exitCode} \xB7 ${seconds(durationMs)}]`;
  const notes = [
    ...requested > BASH_MAX_TIMEOUT_MS ? [`[timeout clamped to ${BASH_MAX_TIMEOUT_MS} ms]`] : [],
    ...args.run_in_background === true ? [BACKGROUND_IGNORED] : []
  ];
  return {
    ...result,
    content: [...result.content, { type: "text", text: [status, ...notes].join("\n") }],
    host: host(aborted ? "cancelled" : result.timedOut ? "timeout" : "ok", {
      durationMs,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      ...result.fullOutputPath ? { fullOutputPath: result.fullOutputPath, ...result.fullOutputCapped ? { fullOutputCapped: true } : {} } : {}
    })
  };
}

// src/tools/bundled/bash/index.ts
var example = { command: "npm test", timeout: 3e5, description: "Run the test suite" };
var renamedArguments = { commands: "command" };
var batch = (name) => `${name} takes one command: {"command":"npm test"}; call ${name} once per command`;
function rename2(args, notes, from, to, convert = (value) => value) {
  if (!Object.hasOwn(args, from)) return;
  if (args[to] !== void 0) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}
var integer = (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
var seconds2 = (value) => {
  const number = integer(value);
  return typeof number === "number" && Number.isFinite(number) ? Math.round(number * 1e3) : value;
};
function commandText(shell, value) {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string")) return value;
  const words = value;
  if (shell === "bash") {
    if (words.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba)?sh$/.test(words[0]) && /^-l?c$/.test(words[1])) return words[2];
    return words.map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(" ");
  }
  if (words.length === 3 && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(words[0]) && /^-(?:c|command)$/i.test(words[1])) return words[2];
  const quoted = words.map((word) => /^[\w+=:./\\-]+$/.test(word) ? word : powerShellQuote(word));
  return `${quoted[0] === words[0] ? "" : "& "}${quoted.join(" ")}`;
}
var normalizeArguments = shellNormalizer("bash");
function shellNormalizer(name) {
  return (input) => normalizeShellArguments(name, input);
}
function normalizeShellArguments(name, input) {
  if (Object.hasOwn(input, "commands")) return { args: input, rejected: batch(name) };
  const args = { ...input };
  const notes = [];
  rename2(args, notes, "cmd", "command");
  rename2(args, notes, "script", "command");
  if (Array.isArray(args.command)) {
    args.command = commandText(name, args.command);
    notes.push("read the command array as one shell command");
  }
  if (typeof args.timeout === "string") args.timeout = integer(args.timeout);
  rename2(args, notes, "timeout_ms", "timeout", integer);
  rename2(args, notes, "timeout_s", "timeout", seconds2);
  rename2(args, notes, "timeout_seconds", "timeout", seconds2);
  for (const alias of ["cwd", "dir_path", "directory"]) rename2(args, notes, alias, "workdir");
  rename2(args, notes, "is_background", "run_in_background");
  rename2(args, notes, "background", "run_in_background");
  if (typeof args.description === "string" && [...args.description].length > 200) {
    args.description = [...args.description].slice(0, 200).join("");
    notes.push("cut description to 200 characters");
  }
  return { args, notes };
}
var validateArgs = shellValidator("bash");
function shellValidator(name) {
  return (value) => validateShellArguments(name, value);
}
function validateShellArguments(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (Object.hasOwn(args, "commands")) return batch(name);
  if (typeof args.command !== "string" || !args.command.trim()) return "command must be a nonempty string";
  if (args.timeout !== void 0 && (!Number.isSafeInteger(args.timeout) || args.timeout < 1)) return "timeout must be a positive integer number of milliseconds";
  if (args.description !== void 0 && (typeof args.description !== "string" || [...args.description].length > 200)) return "description must be a string of at most 200 characters";
  if (args.workdir !== void 0 && (typeof args.workdir !== "string" || !args.workdir)) return "workdir must be a nonempty path";
  if (args.run_in_background !== void 0 && typeof args.run_in_background !== "boolean") return "run_in_background must be true or false";
  if (args.env_refs !== void 0 && (!args.env_refs || typeof args.env_refs !== "object" || Array.isArray(args.env_refs) || Object.entries(args.env_refs).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || !item))) {
    return "env_refs must map environment identifiers to variable names";
  }
  return void 0;
}
async function handler(args, context) {
  return bashTool(args, context);
}
function delegate(args, context, platform = process.platform) {
  return delegateShell("bash", args, context, platform);
}
function delegateShell(shell, args, context, platform = process.platform) {
  if (args.run_in_background !== true) return void 0;
  const command = String(args.command);
  const target = typeof args.workdir === "string" ? resolveToolPath(context.cwd, args.workdir, platform) : context.cwd;
  const relativeTarget = pathFor(platform).relative(context.cwd, target);
  const workdir = pathFor(platform).isAbsolute(relativeTarget) ? target : relativeTarget;
  const summary = command.split("\n", 1)[0].slice(0, 200);
  const clamped = typeof args.timeout === "number" && args.timeout > BASH_MAX_TIMEOUT_MS;
  return {
    identity: "builtin/process",
    arguments: {
      action: "start",
      command,
      ...shell === "bash" ? {} : { shell },
      ...workdir ? { cwd: workdir } : {},
      ...typeof args.description === "string" && args.description ? { label: args.description } : {},
      ...args.env_refs ? { env_refs: args.env_refs } : {},
      ...typeof args.timeout === "number" ? { timeout: Math.min(args.timeout, BASH_MAX_TIMEOUT_MS) } : {}
    },
    finish(result) {
      const description = typeof args.description === "string" && args.description ? { description: args.description } : {};
      const id = result.host?.processId;
      if (result.isError || !id) return { ...result, host: { ...result.host, summary, status: "error", ...description } };
      return {
        isError: false,
        content: [{ type: "text", text: `Started background job ${id} (${summary}).
Read output: process {"action":"output","id":"${id}"}
Stop: process {"action":"stop","id":"${id}"}` + (clamped ? `
[timeout clamped to ${BASH_MAX_TIMEOUT_MS} ms]` : "") }],
        host: { summary, status: "ok", processId: id, ...description }
      };
    }
  };
}
export {
  delegate,
  delegateShell,
  example,
  handler,
  normalizeArguments,
  renamedArguments,
  shellNormalizer,
  shellValidator,
  validateArgs
};
