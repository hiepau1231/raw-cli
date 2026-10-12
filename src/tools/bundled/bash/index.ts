import { pathFor, resolveToolPath } from "../../../platform/paths.js";
import { BASH_MAX_TIMEOUT_MS, bashTool, type BashArgs, type ToolContext } from "../../primitives.js";
import type { NormalizedArguments, ToolDelegation } from "../../registry.js";
import type { ToolResult } from "../../types.js";
import { powerShellQuote, type ShellKind } from "../../shells.js";

export const example = { command: "npm test", timeout: 300000, description: "Run the test suite" };
export const renamedArguments = { commands: "command" };

const batch = (name: string) => `${name} takes one command: {"command":"npm test"}; call ${name} once per command`;

function rename(args: Record<string, unknown>, notes: string[], from: string, to: string, convert = (value: unknown) => value): void {
  if (!Object.hasOwn(args, from)) return;
  // With the canonical name present the alias stays, so dispatch drops it with a note the model can read.
  if (args[to] !== undefined) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}

const integer = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
const seconds = (value: unknown) => {
  const number = integer(value);
  return typeof number === "number" && Number.isFinite(number) ? Math.round(number * 1000) : value;
};

/**
 * For bash, `["bash", "-lc", "npm test"]`, the Codex shell shape, is the command `npm test`; for powershell so is
 * `["pwsh", "-Command", "npm test"]`. Other arrays are joined as words quoted for that shell.
 */
function commandText(shell: ShellKind, value: unknown): unknown {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string")) return value;
  const words = value as string[];
  if (shell === "bash") {
    if (words.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba)?sh$/.test(words[0]!) && /^-l?c$/.test(words[1]!)) return words[2];
    return words.map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(" ");
  }
  if (words.length === 3 && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(words[0]!) && /^-(?:c|command)$/i.test(words[1]!)) return words[2];
  // A comma, `@`, `$` or space would change what PowerShell reads; a quoted program name needs the call operator.
  const quoted = words.map((word) => /^[\w+=:./\\-]+$/.test(word) ? word : powerShellQuote(word));
  return `${quoted[0] === words[0] ? "" : "& "}${quoted.join(" ")}`;
}

/** Aliases used by other harnesses (docs/tool-ux-design.md §4.2); the old batch shape is rejected with an example. */
export const normalizeArguments = shellNormalizer("bash");

/** The argument normalizer of the shell tool `name`; bash and powershell share one shape. */
export function shellNormalizer(name: ShellKind): (input: Record<string, unknown>) => NormalizedArguments {
  return (input) => normalizeShellArguments(name, input);
}

function normalizeShellArguments(name: ShellKind, input: Record<string, unknown>): NormalizedArguments {
  if (Object.hasOwn(input, "commands")) return { args: input, rejected: batch(name) };
  const args = { ...input };
  const notes: string[] = [];
  rename(args, notes, "cmd", "command");
  rename(args, notes, "script", "command");
  if (Array.isArray(args.command)) { args.command = commandText(name, args.command); notes.push("read the command array as one shell command"); }
  if (typeof args.timeout === "string") args.timeout = integer(args.timeout);
  rename(args, notes, "timeout_ms", "timeout", integer);
  rename(args, notes, "timeout_s", "timeout", seconds);
  rename(args, notes, "timeout_seconds", "timeout", seconds);
  for (const alias of ["cwd", "dir_path", "directory"]) rename(args, notes, alias, "workdir");
  rename(args, notes, "is_background", "run_in_background");
  rename(args, notes, "background", "run_in_background");
  if (typeof args.description === "string" && [...args.description].length > 200) {
    args.description = [...args.description].slice(0, 200).join("");
    notes.push("cut description to 200 characters");
  }
  return { args, notes };
}

export const validateArgs = shellValidator("bash");

/** The argument validator of the shell tool `name`. */
export function shellValidator(name: ShellKind): (value: unknown) => string | undefined {
  return (value) => validateShellArguments(name, value);
}

function validateShellArguments(name: ShellKind, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value as Record<string, unknown>;
  if (Object.hasOwn(args, "commands")) return batch(name);
  if (typeof args.command !== "string" || !args.command.trim()) return "command must be a nonempty string";
  if (args.timeout !== undefined && (!Number.isSafeInteger(args.timeout) || (args.timeout as number) < 1)) return "timeout must be a positive integer number of milliseconds";
  if (args.description !== undefined && (typeof args.description !== "string" || [...args.description].length > 200)) return "description must be a string of at most 200 characters";
  if (args.workdir !== undefined && (typeof args.workdir !== "string" || !args.workdir)) return "workdir must be a nonempty path";
  if (args.run_in_background !== undefined && typeof args.run_in_background !== "boolean") return "run_in_background must be true or false";
  if (args.env_refs !== undefined && (!args.env_refs || typeof args.env_refs !== "object" || Array.isArray(args.env_refs)
    || Object.entries(args.env_refs).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || !item))) {
    return "env_refs must map environment identifiers to variable names";
  }
  return undefined;
}

export async function handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return bashTool(args as unknown as BashArgs, context);
}

/**
 * A background call starts a managed job through the process tool's full dispatch (design D10). The job has no
 * default timeout: only a timeout the model gave is passed on, clamped like a foreground one. Without delegation the
 * handler runs the command in the foreground and notes that it ignored the flag.
 */
export function delegate(args: Record<string, unknown>, context: { cwd: string }, platform: NodeJS.Platform = process.platform): ToolDelegation | undefined {
  return delegateShell("bash", args, context, platform);
}

/** `delegate` for the shell tool `shell`: a PowerShell job starts through process with `shell: "powershell"`. */
export function delegateShell(shell: ShellKind, args: Record<string, unknown>, context: { cwd: string },
  platform: NodeJS.Platform = process.platform): ToolDelegation | undefined {
  if (args.run_in_background !== true) return undefined;
  const command = String(args.command);
  // Relative inside or beside the cwd; absolute when no relative path reaches it (another Windows drive), never dropped.
  const target = typeof args.workdir === "string" ? resolveToolPath(context.cwd, args.workdir, platform) : context.cwd;
  const relativeTarget = pathFor(platform).relative(context.cwd, target);
  const workdir = pathFor(platform).isAbsolute(relativeTarget) ? target : relativeTarget;
  const summary = command.split("\n", 1)[0]!.slice(0, 200);
  const clamped = typeof args.timeout === "number" && args.timeout > BASH_MAX_TIMEOUT_MS;
  return {
    identity: "builtin/process",
    arguments: { action: "start", command, ...(shell === "bash" ? {} : { shell }),
      ...(workdir ? { cwd: workdir } : {}),
      ...(typeof args.description === "string" && args.description ? { label: args.description } : {}),
      ...(args.env_refs ? { env_refs: args.env_refs } : {}),
      ...(typeof args.timeout === "number" ? { timeout: Math.min(args.timeout, BASH_MAX_TIMEOUT_MS) } : {}) },
    finish(result) {
      const description = typeof args.description === "string" && args.description ? { description: args.description } : {};
      const id = result.host?.processId;
      if (result.isError || !id) return { ...result, host: { ...result.host, summary, status: "error", ...description } };
      return { isError: false, content: [{ type: "text", text: `Started background job ${id} (${summary}).\n`
        + `Read output: process {"action":"output","id":"${id}"}\nStop: process {"action":"stop","id":"${id}"}`
        + (clamped ? `\n[timeout clamped to ${BASH_MAX_TIMEOUT_MS} ms]` : "") }],
      host: { summary, status: "ok", processId: id, ...description } };
    },
  };
}
