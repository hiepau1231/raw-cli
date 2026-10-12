import { envValue, findGitBash } from "../platform/windows.js";

export const BASH_UNAVAILABLE = "Bash was not found. Install Git for Windows, set RAW_BASH_PATH to its bin\\bash.exe, or select builtin/powershell.";

export type BashResolution = { ok: true; path: string } | { ok: false; code: "bash_unavailable"; message: string };

const found = new Map<string, string>();

/**
 * The Bash the `bash` tool runs. Elsewhere it is RAW_BASH_PATH or `bash` on PATH, as before. On Windows it is Git Bash
 * found by `findGitBash`; a hit is cached per process by the values the search reads, a miss is searched again.
 */
export function resolveBash(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; workspace: string; exists?: (file: string) => boolean }): BashResolution {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return { ok: true, path: env.RAW_BASH_PATH || "bash" };
  const key = JSON.stringify([options.workspace, ...["RAW_BASH_PATH", "PATH", "ProgramFiles", "ProgramW6432", "LOCALAPPDATA", "SystemRoot", "windir"]
    .map((name) => envValue(env, name) ?? null)]);
  const cached = options.exists ? undefined : found.get(key);
  const path = cached ?? findGitBash(env, options.workspace, options.exists);
  if (!path) return { ok: false, code: "bash_unavailable", message: BASH_UNAVAILABLE };
  if (!options.exists) found.set(key, path);
  return { ok: true, path };
}
