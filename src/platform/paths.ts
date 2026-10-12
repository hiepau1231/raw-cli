import path, { type PlatformPath } from "node:path";

/** The path functions of `platform`, so Windows behavior can be exercised on any host. */
export function pathFor(platform: NodeJS.Platform = process.platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * A tool's path argument resolved against the session cwd. On Windows a Git Bash path such as `/c/Users/x` names
 * `C:\Users\x`; `/cx/...` is not a drive and resolves as usual. Other platforms are unchanged.
 */
export function resolveToolPath(cwd: string, input: string, platform: NodeJS.Platform = process.platform): string {
  const api = pathFor(platform);
  if (platform !== "win32") return api.resolve(cwd, input);
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(input);
  return api.resolve(cwd, drive ? `${drive[1]!.toUpperCase()}:\\${drive[2] ?? ""}` : input);
}

/** A path as shown to the model and the user: always with `/`, which Windows also accepts back. */
export function slashPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? value.replaceAll("\\", "/") : value;
}
