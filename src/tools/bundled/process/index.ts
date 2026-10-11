import { isAbsolute, resolve } from "node:path";
import type { ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import type { ToolContent, ToolHandlerResult } from "../../types.js";
import { errorResult } from "../../results.js";
import type { ProcessRecord } from "../../../processes/contract.js";

interface Input { action: "start" | "list" | "status" | "output" | "stop"; command?: string; cwd?: string; label?: string; timeout?: number;
  env_refs?: Record<string, string>; id?: string; cursor?: number; max_bytes?: number }

const ACTIONS = ["start", "list", "status", "output", "stop"];
const FIELDS: Record<string, readonly string[]> = {
  start: ["action", "command", "cwd", "label", "timeout", "env_refs"], list: ["action"],
  status: ["action", "id"], output: ["action", "id", "cursor", "max_bytes"], stop: ["action", "id"],
};
const EXAMPLES: Record<string, string> = {
  start: '{"action":"start","command":"npm run dev"}', status: '{"action":"status","id":"<id>"}',
  output: '{"action":"output","id":"<id>"}', stop: '{"action":"stop","id":"<id>"}', list: '{"action":"list"}',
};
/** Room kept beside an output page for its cursor line. */
const FOOTER_RESERVE = 160;

export const example = { action: "start", command: "npm run dev", label: "Dev server" };
export const renamedArguments = { timeout_ms: "timeout" };

/** Aliases used by other harnesses (docs/tool-ux-design.md §4.2). */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  const args = { ...input };
  const notes: string[] = [];
  const rename = (from: string, to: string) => {
    if (!Object.hasOwn(args, from) || args[to] !== undefined) return;
    args[to] = args[from];
    delete args[from];
    notes.push(`read ${from} as ${to}`);
  };
  rename("timeout_ms", "timeout");
  for (const alias of ["process_id", "shell_id", "bash_id"]) rename(alias, "id");
  // Fields another action takes are dropped with a note instead of failing the call.
  const allowed = typeof args.action === "string" ? FIELDS[args.action] : undefined;
  if (allowed) for (const key of Object.keys(args)) if (!allowed.includes(key)) { delete args[key]; notes.push(`ignored ${key} for action ${String(args.action)}`); }
  return { args, notes };
}

export function validateArgs(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
  const args = raw as Input;
  if (!ACTIONS.includes(args.action)) return `action must be one of ${ACTIONS.join(", ")}`;
  const allowed = FIELDS[args.action]!;
  const extra = Object.keys(args).find((key) => !allowed.includes(key));
  if (extra) return `${extra} is not used by action ${args.action}; example: ${EXAMPLES[args.action]}`;
  if (args.action === "start") {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 65536) return `start needs a nonempty command of at most 65536 characters; example: ${EXAMPLES.start}`;
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd || isAbsolute(args.cwd))) return "cwd must be relative to the session";
    if (args.label !== undefined && (typeof args.label !== "string" || !args.label || [...args.label].length > 200)) return "label must be 1–200 characters";
    if (args.timeout !== undefined && (!Number.isSafeInteger(args.timeout) || args.timeout < 1 || args.timeout > 2147483647)) return "timeout must be a positive number of milliseconds";
    if (args.env_refs !== undefined && (!args.env_refs || typeof args.env_refs !== "object" || Array.isArray(args.env_refs) || Object.entries(args.env_refs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || !value))) return "env_refs must map environment identifiers to variable names";
  } else if (args.action !== "list" && (typeof args.id !== "string" || !args.id || args.id.length > 128)) return `${args.action} needs the job id; example: ${EXAMPLES[args.action]}`;
  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) return "cursor must be a byte offset from an earlier output page";
  if (args.max_bytes !== undefined && (!Number.isSafeInteger(args.max_bytes) || args.max_bytes < 1 || args.max_bytes > 65536)) return "max_bytes must be 1–65536";
  return undefined;
}

function state(record: ProcessRecord): string {
  return `${record.state}${typeof record.exitCode === "number" ? ` · exit ${record.exitCode}` : record.signal ? ` · ${record.signal}` : ""}`;
}

function line(record: ProcessRecord): string {
  return `${record.id} · ${state(record)} · ${record.label ? `${record.label}: ` : ""}${record.command.split("\n", 1)[0]}`;
}

const text = (value: string, host: NonNullable<ToolHandlerResult["host"]>): ToolHandlerResult =>
  ({ isError: false, content: [{ type: "text", text: value }], host: { status: "ok", ...host } });

export async function handler(raw: unknown, context: ToolContext): Promise<ToolHandlerResult> {
  const invalid = validateArgs(raw); if (invalid) return errorResult("invalid_arguments", invalid);
  if (!context.processes) return errorResult("process_unavailable", "This host has no process supervisor");
  const args = raw as Input;
  try {
    if (args.action === "start") {
      let bindings: Record<string, string> | undefined;
      if (args.env_refs && Object.keys(args.env_refs).length) {
        if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
        context.vars.validateEnvRefs(args.env_refs); bindings = await context.vars.resolveEnv(args.env_refs, { ...(context.signal ? { signal: context.signal } : {}) });
      }
      const record = await context.processes.start({ command: args.command!, cwd: resolve(context.cwd, args.cwd ?? "."),
        ...(args.label ? { label: args.label } : {}), ...(args.timeout !== undefined ? { timeout_ms: args.timeout } : {}),
        ...(context.signal ? { signal: context.signal } : {}), ...(context.bashPath ? { bashPath: context.bashPath } : {}),
        ...(bindings ? { env: { ...process.env, ...bindings } } : {}) });
      return text(`Started ${record.id} · ${args.label ?? args.command!.split("\n", 1)[0]}`, { summary: args.command!.split("\n", 1)[0]!.slice(0, 200), processId: record.id });
    }
    if (args.action === "list") {
      const records = context.processes.list();
      return text(records.length ? records.map(line).join("\n") : "No background jobs.", { summary: "list" });
    }
    if (args.action === "status") {
      const record = context.processes.status(args.id!);
      return text(`${line(record)}\n[output bytes: ${record.cursor}]`, { summary: record.id, processId: record.id });
    }
    if (args.action === "stop") {
      const record = await context.processes.stop(args.id!);
      return text(`Stopped ${record.id} · ${state(record)}`, { summary: record.id, processId: record.id });
    }
    const room = context.maxOutputBytes - FOOTER_RESERVE;
    if (room < 1) return errorResult("output_budget_too_small", "process output needs room for its cursor line");
    const page = context.processes.output(args.id!, args.cursor, Math.min(args.max_bytes ?? 65536, room));
    const record = context.processes.status(args.id!);
    const content: ToolContent[] = [];
    for (const chunk of page.chunks) {
      const last = content.at(-1);
      if (last?.type === "text" && last.channel === chunk.channel) last.text += chunk.text;
      else content.push({ type: "text", channel: chunk.channel, text: chunk.text });
    }
    const notes = [`[next cursor: ${page.nextCursor}]`, `[${state(record)}]`,
      ...(page.truncated ? ["[more output is available from that cursor]"] : []),
      ...(page.droppedBytes ? [`[${page.droppedBytes} earlier bytes were dropped]`] : [])];
    content.push({ type: "text", text: `${page.chunks.length ? "\n" : "No new output.\n"}${notes.join("\n")}` });
    // The page's bytes stay in the channel blocks; host data keeps only its position.
    return { isError: false, content, host: { status: "ok", summary: record.id, processId: record.id,
      page: { cursor: page.chunks[0]?.start ?? page.nextCursor, next: page.nextCursor, total: page.cursor, earliestCursor: page.earliestCursor,
        droppedBytes: page.droppedBytes, truncated: page.truncated } } };
  } catch (error) { const failure = error as Error & { code?: string }; return errorResult(failure.code ?? "process_error", failure.message); }
}
