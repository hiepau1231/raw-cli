import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";
import { contained } from "../platform/fs.js";
import { envValue, findGitBash, findPowerShell } from "../platform/windows.js";

export type ShellKind = "bash" | "powershell";

export const BASH_UNAVAILABLE = "Bash was not found. Install Git for Windows, set RAW_BASH_PATH to its bin\\bash.exe, or select builtin/powershell.";
export const POWERSHELL_UNAVAILABLE = "PowerShell was not found. Install PowerShell 7 (pwsh) or set RAW_POWERSHELL_PATH to pwsh or powershell.exe.";

export type ShellResolution = { ok: true; path: string } | { ok: false; code: "bash_unavailable" | "powershell_unavailable"; message: string };
export type BashResolution = ShellResolution;

interface ResolveOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; workspace: string; exists?: (file: string) => boolean }

const found = new Map<string, string>();

/** A hit is cached per process by the values the search reads; a miss is searched again. */
function cached(kind: ShellKind, options: ResolveOptions, names: string[], search: () => string | undefined): string | undefined {
  const env = options.env ?? process.env;
  const key = JSON.stringify([kind, options.workspace, ...names.map((name) => envValue(env, name) ?? null)]);
  const hit = options.exists ? undefined : found.get(key);
  const result = hit ?? search();
  if (result && !options.exists) found.set(key, result);
  return result;
}

/**
 * The Bash the `bash` tool runs. Elsewhere it is RAW_BASH_PATH or `bash` on PATH, as before. On Windows it is Git Bash
 * found by `findGitBash`.
 */
export function resolveBash(options: ResolveOptions): ShellResolution {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return { ok: true, path: env.RAW_BASH_PATH || "bash" };
  const found = cached("bash", options, ["RAW_BASH_PATH", "PATH", "ProgramFiles", "ProgramW6432", "LOCALAPPDATA", "SystemRoot", "windir"],
    () => findGitBash(env, options.workspace, options.exists));
  return found ? { ok: true, path: found } : { ok: false, code: "bash_unavailable", message: BASH_UNAVAILABLE };
}

const executable = (file: string) => {
  try { return statSync(file).isFile() && (accessSync(file, constants.X_OK), true); } catch { return false; }
};

/**
 * The PowerShell the `powershell` tool runs: RAW_POWERSHELL_PATH, else on Windows `findPowerShell` (pwsh 7 before the
 * Windows PowerShell 5.1 that every Windows has), elsewhere `pwsh` on PATH. PATH entries that are relative or inside the
 * workspace are skipped.
 */
export function resolvePowerShell(options: ResolveOptions): ShellResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const search = platform === "win32"
    ? () => findPowerShell(env, options.exists, options.workspace)
    : () => {
      if (env.RAW_POWERSHELL_PATH) return env.RAW_POWERSHELL_PATH;
      const exists = options.exists ?? executable;
      for (const entry of (env.PATH ?? "").split(path.posix.delimiter)) {
        if (!path.posix.isAbsolute(entry) || contained(options.workspace, entry, path.posix)) continue;
        if (exists(path.posix.join(entry, "pwsh"))) return path.posix.join(entry, "pwsh");
      }
      return undefined;
    };
  const result = cached("powershell", options, ["RAW_POWERSHELL_PATH", "PATH", "ProgramFiles", "SystemRoot", "windir"], search);
  return result ? { ok: true, path: result } : { ok: false, code: "powershell_unavailable", message: POWERSHELL_UNAVAILABLE };
}

/** A PowerShell single-quoted string; PowerShell also closes one at a typographic single quote. */
export const powerShellQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

/**
 * The arguments that run `command` in PowerShell like a Bash `-c`: no profile or prompts, scripts allowed (npm.ps1 runs
 * under the default Restricted policy), UTF-8 output without progress records, and an exit status like Bash's: `exit N`
 * gives N; when the last program that ran is native, a failing command, or a last statement that is a command, gives
 * that program's code; any other failure gives 1; success gives 0.
 */
export function powerShellArgs(command: string): string[] {
  // The command is parsed on its own, so a leading `using` statement still parses and error lines are the command's.
  // `$?` is read inside the block that runs last (after a dot-sourced block it is always true): appended to an unnamed
  // block, or on a new line before the closing brace of a named one. A lookup hook records whether the last command
  // PowerShell resolved (through a name, path, alias, variable or string) is a native program, because $LASTEXITCODE
  // keeps an earlier native command's code when a cmdlet fails last. The command may have set StrictMode or Stop.
  const script = [
    "$ProgressPreference = 'SilentlyContinue'; if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding",
    `$__rawText = ${powerShellQuote(command)}`,
    "try { $__rawAst = [ScriptBlock]::Create($__rawText).Ast } catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }",
    "$__rawBlock = @($__rawAst.EndBlock, $__rawAst.ProcessBlock, $__rawAst.BeginBlock) | Where-Object { $_ } | Select-Object -First 1",
    "$__rawRun = if (-not $__rawBlock) { $__rawText } elseif ($__rawBlock.Unnamed) { $__rawText + \"`n`$global:__rawOk = `$?\" } else { $__rawText.Insert($__rawBlock.Extent.EndOffset - 1, \"`n`$global:__rawOk = `$?`n\") }",
    "$global:__rawOk = $true; $global:__rawNative = $false; $global:LASTEXITCODE = 0",
    "$ExecutionContext.InvokeCommand.PostCommandLookupAction = { param($name, $lookup) $found = $lookup.Command; while ($found -is [System.Management.Automation.AliasInfo]) { $found = $found.ResolvedCommand }; $global:__rawNative = $found -is [System.Management.Automation.ApplicationInfo] }",
    ". ([ScriptBlock]::Create($__rawRun))",
    "$ExecutionContext.InvokeCommand.PostCommandLookupAction = $null; Set-StrictMode -Off; $ErrorActionPreference = 'Continue'",
    "$__rawLast = if ($__rawBlock) { $__rawBlock.Statements | Select-Object -Last 1 }",
    "$__rawPiped = $__rawLast -is [System.Management.Automation.Language.PipelineAst] -and ($__rawLast.PipelineElements | Select-Object -Last 1) -is [System.Management.Automation.Language.CommandAst]",
    "if ($global:__rawNative -and ($__rawPiped -or -not $global:__rawOk)) { exit $global:LASTEXITCODE }",
    "if ($global:__rawOk) { exit 0 }",
    "exit 1",
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}
