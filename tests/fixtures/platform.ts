import { existsSync } from "node:fs";
import { dirname, join, win32 } from "node:path";

/**
 * Mechanisms that do not exist on Windows. A test may skip on win32 only for one of these reasons; features Raw
 * supports on Windows are never skipped (native-windows-support-plan.md, Phase 1).
 */
export const POSIX_ONLY = {
  pty: "Python pty is Unix-only",
  signals: "POSIX signals are not delivered to child processes on Windows",
  modes: "POSIX permission bits are not enforced on Windows",
} as const;

/** The `skip` option for a test of a POSIX-only mechanism. */
export function posixOnly(reason: keyof typeof POSIX_ONLY, platform: NodeJS.Platform = process.platform): string | false {
  return platform === "win32" ? POSIX_ONLY[reason] : false;
}

/** npm's CLI script: the one that started this run, else the copy installed beside this Node. */
export function npmCli(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const fromNpm = env.npm_execpath;
  if (fromNpm && /npm-cli\.js$/.test(fromNpm) && existsSync(fromNpm)) return fromNpm;
  for (const candidate of [join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * How to start `command` from a test without a shell. On Windows, `npm` and the `node_modules/.bin` shims are
 * `.cmd` files that Node cannot spawn directly (CVE-2024-27980), so they run as Node scripts instead; an npm
 * installed apart from Node runs as `npm.cmd` through the system cmd.exe.
 */
export function launch(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
  cli: string | null = platform === "win32" ? npmCli() ?? null : null, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform !== "win32") return [command, [...args]];
  if (command === "npm") {
    if (cli) return [process.execPath, [cli, ...args]];
    // Node quotes each argument for the C runtime, which cmd.exe does not parse; refuse what it would misread.
    const unsafe = args.find((arg) => /[&|<>^%!"\r\n]/.test(arg));
    if (unsafe !== undefined) throw new Error(`launch: cannot pass ${JSON.stringify(unsafe)} to npm.cmd through cmd.exe`);
    return [win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "npm.cmd", ...args]];
  }
  if (win32.basename(win32.dirname(command)) === ".bin" && win32.basename(command) === "raw") {
    return [process.execPath, [win32.join(win32.dirname(win32.dirname(command)), "@tlelabs", "raw", "dist", "raw.js"), ...args]];
  }
  return [command, [...args]];
}
