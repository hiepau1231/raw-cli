import { closeSync, fsyncSync, openSync } from "node:fs";
import { access, readFile, rename } from "node:fs/promises";
import path, { type PlatformPath } from "node:path";

/** Windows reports a file another process (often antivirus or the indexer) briefly holds open with these codes. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameRetryOptions {
  /** Total time spent retrying, in milliseconds; default 2000. */
  deadlineMs?: number;
  /** Fail at once, without retrying, when the target already exists (a lost publish race). */
  keepExisting?: boolean;
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Whether two stats describe the same file. Some Node 22 releases on Windows report `dev` 0 from a path-based stat
 * (libuv's GetFileInformationByName path leaves the volume serial unset) while `fstat` reports it, so a zero `dev`
 * is unknown and only the file ID is compared.
 */
export function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.ino === right.ino && (left.dev === right.dev || left.dev === 0 || right.dev === 0);
}

export async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; }
  catch { return false; }
}

/**
 * `rename`, retried with backoff on Windows while the error is one a short-lived open handle causes. Throws the last
 * error once the deadline passes; any other error throws at once.
 */
export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const { deadlineMs = 2000, keepExisting = false, platform = process.platform, rename: move = rename,
    exists: present = exists, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), now = Date.now } = options;
  const deadline = now() + deadlineMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    try { return await move(from, to); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !TRANSIENT.has(code) || now() + delay > deadline) throw error;
      if (keepExisting && await present(to)) throw error;
      await sleep(delay);
    }
  }
}

/** JSON text with a leading UTF-8 byte order mark removed; editors on Windows often add one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readJsonText(file: string): Promise<string> {
  return stripBom(await readFile(file, "utf8"));
}

/** Flushes a directory entry to disk. Windows cannot open a directory as a file, and NTFS journals the entry itself. */
export function fsyncDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  let handle: number;
  try { handle = openSync(directory, "r"); }
  catch (error) { if (ignorable(error)) return; throw error; }
  try { fsyncSync(handle); }
  catch (error) { if (!ignorable(error)) throw error; }
  finally { closeSync(handle); }
}

function ignorable(error: unknown): boolean {
  return ["EISDIR", "EPERM", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Whether `candidate` is `root` or inside it, compared the way `api` compares paths (case-insensitively on win32). */
export function contained(root: string, candidate: string, api: PlatformPath = path): boolean {
  const rel = api.relative(api.resolve(root), api.resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

/** Whether `value` contains a path separator: `/` everywhere, and `\` too where `api` is Windows. */
export function hasSeparator(value: string, api: PlatformPath = path): boolean {
  return value.includes("/") || (api.sep === "\\" && value.includes("\\"));
}

/** Whether a command names a file, absolute or relative, rather than a program looked up on PATH. */
export function isPathCommand(command: string, api: PlatformPath = path): boolean {
  return api.isAbsolute(command) || hasSeparator(command, api);
}

/** Whether a command argument names a file: absolute, or starting with `./` (`.\` too where `api` is Windows). */
export function isFileArgument(arg: string, api: PlatformPath = path): boolean {
  return api.isAbsolute(arg) || arg.startsWith("./") || (api.sep === "\\" && arg.startsWith(".\\"));
}
