import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { packageRoot } from "../package-root.js";
import { contained } from "./fs.js";

const win32 = path.win32;

/** An environment with `overrides` applied. Windows names are case-insensitive, so every spelling of a key is replaced. */
export function mergeEnv(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === "win32") for (const existing of Object.keys(merged)) {
      if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete merged[existing];
    }
    merged[key] = value;
  }
  return merged;
}

/** The value of `name` in a Windows environment, whatever its spelling. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/** The Windows folder: SystemRoot, else windir, else C:\\Windows; an empty value counts as unset. */
export function windowsFolder(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "SystemRoot") || envValue(env, "windir") || "C:\\Windows";
}

/** An executable in the Windows System32 folder, by absolute path so neither PATH nor the cwd can shadow it. */
export function systemBinary(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(windowsFolder(env), "System32", name);
}

export interface ResolvedCommand {
  file: string; args: string[]; windowsVerbatimArguments?: boolean;
  /** The batch file a `cmd.exe` line runs, for a launcher such as the MCP SDK's that builds that line itself. */
  batch?: string;
}
export type CommandResolution = ResolvedCommand & { ok: true } | { ok: false; code: "not_found" | "bash_unavailable"; message: string };

export interface ResolveOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  /** Git Bash for `.sh` commands; undefined when it is not installed. */
  bash?: () => string | undefined;
  /** PowerShell for `.ps1` commands. */
  powershell?: () => string | undefined;
  node?: string;
}

/** Whether `file` is a regular file; a directory named like a program never shadows the real one. */
export function isRegularFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

/**
 * How to start `command` with `args` without a shell. Elsewhere it is unchanged. On Windows a command naming a file runs
 * by its extension (Node scripts with this Node, `.ps1` with PowerShell, `.sh` with Git Bash, `.cmd`/`.bat` through the
 * system cmd.exe), and a bare name is looked up on PATH with PATHEXT, never in the cwd or a relative PATH entry.
 */
export function resolveCommand(command: string, args: readonly string[], options: ResolveOptions): CommandResolution {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { ok: true, file: command, args: [...args] };
  const env = options.env ?? process.env;
  const exists = options.exists ?? isRegularFile;
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const withExtensions = (base: string) => [...(win32.extname(base) ? [base] : []), ...extensions.map((ext) => base + ext.toLowerCase())];
  const locate = (name: string): string | undefined => {
    if (win32.isAbsolute(name) || /[\\/]/.test(name)) return withExtensions(win32.resolve(options.cwd, name)).find(exists);
    for (const directory of (envValue(env, "PATH") ?? "").split(";")) {
      const entry = directory.replace(/^"(.*)"$/, "$1");
      if (!entry || !win32.isAbsolute(entry)) continue;
      const found = withExtensions(win32.join(entry, name)).find(exists);
      if (found) return found;
    }
    return undefined;
  };
  // A configured interpreter given by name (RAW_BASH_PATH=bash.exe) is found the same way: the job launcher starts
  // exactly the file it is given, and Windows would look for a bare name in the cwd.
  const interpreter = (found: string) => win32.isAbsolute(found) ? found : locate(found);
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
    // cmd.exe parses its own line, so the batch file and every argument are escaped for it, as cross-spawn does; npm's
    // node_modules/.bin shims pass %* on to another command and need the escape twice.
    const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
    const line = [quoteCmdCommand(file), ...args.map((arg) => quoteCmdArgument(arg, twice))].join(" ");
    return { ok: true, file: systemBinary("cmd.exe", env), args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, batch: file };
  }
  return { ok: true, file, args: [...args] };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** A batch file path escaped for cmd.exe (cross-spawn's escapeCommand). */
export function quoteCmdCommand(file: string): string {
  return win32.normalize(file).replace(CMD_META, "^$1");
}

/** One argument escaped for a cmd.exe line that runs a batch file (cross-spawn's escapeArgument). */
export function quoteCmdArgument(arg: string, twice = false): string {
  let quoted = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"").replace(/(?=(\\+?)?)\1$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return twice ? quoted.replace(CMD_META, "^$1") : quoted;
}

/** One argument quoted the way Node (libuv quote_cmd_arg) quotes it for a Windows command line. */
export function quoteWindowsArgument(arg: string): string {
  if (!arg) return "\"\"";
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  // Backslashes are literal except before a quote or the closing quote, where each one is doubled.
  let out = "";
  let beforeQuote = true;
  for (let i = arg.length - 1; i >= 0; i--) {
    const char = arg[i]!;
    out = char + out;
    if (beforeQuote && char === "\\") out = "\\" + out;
    else if (char === "\"") { beforeQuote = true; out = "\\" + out; }
    else beforeQuote = false;
  }
  return `"${out}"`;
}

/**
 * PowerShell: RAW_POWERSHELL_PATH, then pwsh.exe on PATH (absolute entries outside `workspace`), then PowerShell 7 in
 * Program Files, then the Windows PowerShell in System32.
 */
export function findPowerShell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = isRegularFile,
  workspace?: string): string | undefined {
  const configured = envValue(env, "RAW_POWERSHELL_PATH");
  if (configured) return configured;
  const outside = (candidate: string) => workspace === undefined || !contained(workspace, candidate, win32);
  for (const directory of (envValue(env, "PATH") ?? "").split(";")) {
    const entry = directory.replace(/^"(.*)"$/, "$1");
    if (!entry || !win32.isAbsolute(entry) || !outside(entry)) continue;
    if (exists(win32.join(entry, "pwsh.exe"))) return win32.join(entry, "pwsh.exe");
  }
  const programFiles = envValue(env, "ProgramFiles");
  for (const candidate of [...(programFiles ? [win32.join(programFiles, "PowerShell", "7", "pwsh.exe")] : []),
    systemBinary(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env)]) {
    if (outside(candidate) && exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Git Bash for `workspace`: RAW_BASH_PATH as given, then Git's usual install folders, then the `bin\bash.exe` of the Git
 * whose git.exe is on PATH, then a bash.exe on PATH. WSL's launcher is never picked implicitly: PATH entries under the
 * Windows folder or a WindowsApps folder are skipped, as are relative entries and every candidate inside the workspace.
 */
export function findGitBash(env: NodeJS.ProcessEnv, workspace: string, exists: (file: string) => boolean = isRegularFile): string | undefined {
  const configured = envValue(env, "RAW_BASH_PATH");
  if (configured) return configured;
  const windows = windowsFolder(env);
  // Never implicitly: the Windows folder (WSL's bash.exe), a WindowsApps folder (its app alias) or the workspace.
  const allowed = (candidate: string) => !contained(windows, candidate, win32) && !contained(workspace, candidate, win32)
    && !candidate.split(/[\\/]/).some((part) => part.toLowerCase() === "windowsapps");
  const usable = (candidate: string) => allowed(candidate) && exists(candidate);
  const installs = [envValue(env, "ProgramFiles"), envValue(env, "ProgramW6432")].filter((root): root is string => !!root)
    .map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  const local = envValue(env, "LOCALAPPDATA");
  for (const candidate of [...installs, ...(local ? [win32.join(local, "Programs", "Git", "bin", "bash.exe")] : [])]) {
    if (usable(candidate)) return candidate;
  }
  const entries = (envValue(env, "PATH") ?? "").split(";").map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry && win32.isAbsolute(entry) && allowed(entry));
  for (const entry of entries) {
    if (!exists(win32.join(entry, "git.exe"))) continue;
    // Git for Windows keeps git.exe in <root>\cmd and <root>\mingw64\bin; <root>\bin\bash.exe sets up its environment.
    const root = /[\\/]cmd[\\/]?$/i.test(entry) ? win32.dirname(win32.resolve(entry))
      : /[\\/]mingw(?:32|64)[\\/]bin[\\/]?$/i.test(entry) ? win32.dirname(win32.dirname(win32.resolve(entry))) : undefined;
    if (root && usable(win32.join(root, "bin", "bash.exe"))) return win32.join(root, "bin", "bash.exe");
  }
  for (const entry of entries) if (exists(win32.join(entry, "bash.exe"))) return win32.join(entry, "bash.exe");
  return undefined;
}

export interface JobLauncherOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Raw's state directory; the launcher is cached in its `bin` folder. */
  stateDir: string;
  /** Compiles the source to `output`; throws on failure. */
  compile?: (source: string, output: string, env: NodeJS.ProcessEnv) => void;
  /** The launcher's C# source text. */
  source?: string;
  log?: (message: string) => void;
}

const launchers = new Map<string, string | undefined>();
let warned = false;

/** The launcher's C# source, shipped in dist/platform (src/platform in a checkout). */
export function launcherSource(): string {
  const root = packageRoot();
  for (const candidate of [path.join(root, "dist", "platform", "job-launcher.cs"), path.join(root, "src", "platform", "job-launcher.cs")]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("job-launcher.cs is missing from the Raw package");
}

/** The .NET Framework C# compiler that ships with Windows. */
export function compileLauncher(source: string, output: string, env: NodeJS.ProcessEnv): void {
  const windows = windowsFolder(env);
  const compiler = ["Framework64", "Framework"].map((folder) => win32.join(windows, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"))
    .find((candidate) => existsSync(candidate));
  if (!compiler) throw new Error("the .NET Framework C# compiler (csc.exe) was not found");
  const input = `${output}.cs`;
  writeFileSync(input, source);
  try {
    const result = spawnSync(compiler, ["/nologo", "/optimize", "/target:exe", `/out:${output}`, input], { encoding: "utf8", windowsHide: true, env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`csc.exe failed: ${(result.stdout + result.stderr).trim().slice(0, 2000)}`);
  } finally { rmSync(input, { force: true }); }
}

/** Raw's state directory, where the compiled launcher is cached. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(homedir(), ".local", "state"), "raw");
}

/**
 * The job launcher executable on Windows, compiled from its source on first use and cached by the source's hash;
 * undefined elsewhere, or when it cannot be built, in which case Raw logs once and stops trees with taskkill.
 */
export function jobLauncher(options: JobLauncherOptions): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const env = options.env ?? process.env;
  let result: string | undefined;
  let target: string | undefined;
  try {
    const source = options.source ?? launcherSource();
    target = path.join(options.stateDir, "bin", `raw-job-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.exe`);
    if (launchers.has(target)) return launchers.get(target);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      const staged = `${target}.${randomUUID()}.exe`;
      try {
        (options.compile ?? compileLauncher)(source, staged, env);
        // Another Raw process may have published the same launcher meanwhile; either copy is the same program.
        try { renameSync(staged, target); } catch (error) { if (!existsSync(target)) throw error; }
      } finally { rmSync(staged, { force: true }); }
    }
    result = target;
  } catch (error) {
    if (!warned) {
      warned = true;
      (options.log ?? ((message: string) => process.stderr.write(`${message}\n`)))(
        `raw: the Windows job launcher is unavailable (${(error as Error).message}); process trees are stopped with taskkill`);
    }
  }
  if (target) launchers.set(target, result);
  return result;
}

export function resetJobLauncherForTests(): void { launchers.clear(); warned = false; }

/**
 * `resolved` run through the job launcher: the launcher gets the executable and the complete command line, both
 * base64, built the way Node would build it, so the program receives exactly the same arguments.
 */
export function wrapInJob(resolved: ResolvedCommand, launcher: string | undefined): ResolvedCommand {
  if (!launcher) return resolved;
  const quote = resolved.windowsVerbatimArguments ? (arg: string) => arg : quoteWindowsArgument;
  const line = [resolved.file, ...resolved.args].map(quote).join(" ");
  const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
  return { file: launcher, args: ["--app", encode(resolved.file), "--line", encode(line)] };
}

export type PreparedSpawn = ResolvedCommand & { ok: true; jobbed: boolean };

/** `command` resolved for this platform and, on Windows, wrapped in the job launcher when it is available. */
export function prepareSpawn(command: string, args: readonly string[], options: ResolveOptions & { stateDir?: string }):
  PreparedSpawn | Extract<CommandResolution, { ok: false }> {
  const platform = options.platform ?? process.platform;
  const resolved = resolveCommand(command, args, options);
  if (!resolved.ok || platform !== "win32") return resolved.ok ? { ...resolved, jobbed: false } : resolved;
  const launcher = jobLauncher({ platform, stateDir: options.stateDir ?? stateDirectory() });
  return { ok: true, ...wrapInJob(resolved, launcher), jobbed: launcher !== undefined };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Stops a Windows child and everything it started: killing a job launcher closes its job; without one, the absolute
 * taskkill.exe walks the tree. A child that has already exited is never signalled, so a reused PID is never hit.
 * `onError` hears of a stop that failed while the child still ran, possibly after this returns.
 */
export function terminateTree(child: ChildProcess, options: { jobbed: boolean; env?: NodeJS.ProcessEnv; onError?: (message: string) => void }): void {
  if (!child.pid || exited(child)) return;
  // A child that exited just now makes a kill fail too; only one still running a moment later is a failure.
  const report = (message: string) => { setTimeout(() => { if (!exited(child)) options.onError?.(message); }, 250).unref(); };
  const last = () => {
    if (exited(child)) return;
    try { if (!child.kill()) report(`cannot stop process ${child.pid}`); }
    catch (error) { report(`cannot stop process ${child.pid}: ${(error as Error).message}`); }
  };
  if (options.jobbed) return last();
  const killer = spawn(systemBinary("taskkill.exe", options.env), ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
  killer.on("error", (error) => { report(`taskkill failed: ${error.message}`); last(); });
  killer.on("exit", (code) => { if (code !== 0) report(`taskkill exited with ${code}`); last(); });
}
