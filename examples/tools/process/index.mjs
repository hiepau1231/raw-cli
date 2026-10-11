// src/tools/bundled/process/index.ts
import { isAbsolute, resolve } from "path";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/spill.ts
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
var SPILL_MAX_BYTES = 64 * 1024 * 1024;
var SPILL_TOTAL_BYTES = 1024 * 1024 * 1024;
var SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 60 * 1e3;
var SPILL_PATH_RESERVE = tmpdir().length + 96;

// src/tools/results.ts
var DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
var HOST_CONTENT_BYTES = 1024 * 1024;
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/bundled/process/index.ts
var ACTIONS = ["start", "list", "status", "output", "stop"];
var FIELDS = {
  start: ["action", "command", "cwd", "label", "timeout", "env_refs"],
  list: ["action"],
  status: ["action", "id"],
  output: ["action", "id", "cursor", "max_bytes"],
  stop: ["action", "id"]
};
var EXAMPLES = {
  start: '{"action":"start","command":"npm run dev"}',
  status: '{"action":"status","id":"<id>"}',
  output: '{"action":"output","id":"<id>"}',
  stop: '{"action":"stop","id":"<id>"}',
  list: '{"action":"list"}'
};
var FOOTER_RESERVE = 160;
var example = { action: "start", command: "npm run dev", label: "Dev server" };
var renamedArguments = { timeout_ms: "timeout" };
function normalizeArguments(input) {
  const args = { ...input };
  const notes = [];
  const rename = (from, to) => {
    if (!Object.hasOwn(args, from) || args[to] !== void 0) return;
    args[to] = args[from];
    delete args[from];
    notes.push(`read ${from} as ${to}`);
  };
  rename("timeout_ms", "timeout");
  for (const alias of ["process_id", "shell_id", "bash_id"]) rename(alias, "id");
  const allowed = typeof args.action === "string" ? FIELDS[args.action] : void 0;
  if (allowed) {
    for (const key of Object.keys(args)) if (!allowed.includes(key)) {
      delete args[key];
      notes.push(`ignored ${key} for action ${String(args.action)}`);
    }
  }
  return { args, notes };
}
function validateArgs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
  const args = raw;
  if (!ACTIONS.includes(args.action)) return `action must be one of ${ACTIONS.join(", ")}`;
  const allowed = FIELDS[args.action];
  const extra = Object.keys(args).find((key) => !allowed.includes(key));
  if (extra) return `${extra} is not used by action ${args.action}; example: ${EXAMPLES[args.action]}`;
  if (args.action === "start") {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.length > 65536) return `start needs a nonempty command of at most 65536 characters; example: ${EXAMPLES.start}`;
    if (args.cwd !== void 0 && (typeof args.cwd !== "string" || !args.cwd || isAbsolute(args.cwd))) return "cwd must be relative to the session";
    if (args.label !== void 0 && (typeof args.label !== "string" || !args.label || [...args.label].length > 200)) return "label must be 1\u2013200 characters";
    if (args.timeout !== void 0 && (!Number.isSafeInteger(args.timeout) || args.timeout < 1 || args.timeout > 2147483647)) return "timeout must be a positive number of milliseconds";
    if (args.env_refs !== void 0 && (!args.env_refs || typeof args.env_refs !== "object" || Array.isArray(args.env_refs) || Object.entries(args.env_refs).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || !value))) return "env_refs must map environment identifiers to variable names";
  } else if (args.action !== "list" && (typeof args.id !== "string" || !args.id || args.id.length > 128)) return `${args.action} needs the job id; example: ${EXAMPLES[args.action]}`;
  if (args.cursor !== void 0 && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) return "cursor must be a byte offset from an earlier output page";
  if (args.max_bytes !== void 0 && (!Number.isSafeInteger(args.max_bytes) || args.max_bytes < 1 || args.max_bytes > 65536)) return "max_bytes must be 1\u201365536";
  return void 0;
}
function state(record) {
  return `${record.state}${typeof record.exitCode === "number" ? ` \xB7 exit ${record.exitCode}` : record.signal ? ` \xB7 ${record.signal}` : ""}`;
}
function line(record) {
  return `${record.id} \xB7 ${state(record)} \xB7 ${record.label ? `${record.label}: ` : ""}${record.command.split("\n", 1)[0]}`;
}
var text = (value, host) => ({ isError: false, content: [{ type: "text", text: value }], host: { status: "ok", ...host } });
async function handler(raw, context) {
  const invalid = validateArgs(raw);
  if (invalid) return errorResult("invalid_arguments", invalid);
  if (!context.processes) return errorResult("process_unavailable", "This host has no process supervisor");
  const args = raw;
  try {
    if (args.action === "start") {
      let bindings;
      if (args.env_refs && Object.keys(args.env_refs).length) {
        if (!context.vars) return errorResult("vars_unavailable", "variable services are unavailable");
        context.vars.validateEnvRefs(args.env_refs);
        bindings = await context.vars.resolveEnv(args.env_refs, { ...context.signal ? { signal: context.signal } : {} });
      }
      const record2 = await context.processes.start({
        command: args.command,
        cwd: resolve(context.cwd, args.cwd ?? "."),
        ...args.label ? { label: args.label } : {},
        ...args.timeout !== void 0 ? { timeout_ms: args.timeout } : {},
        ...context.signal ? { signal: context.signal } : {},
        ...context.bashPath ? { bashPath: context.bashPath } : {},
        ...bindings ? { env: { ...process.env, ...bindings } } : {}
      });
      return text(`Started ${record2.id} \xB7 ${args.label ?? args.command.split("\n", 1)[0]}`, { summary: args.command.split("\n", 1)[0].slice(0, 200), processId: record2.id });
    }
    if (args.action === "list") {
      const records = context.processes.list();
      return text(records.length ? records.map(line).join("\n") : "No background jobs.", { summary: "list" });
    }
    if (args.action === "status") {
      const record2 = context.processes.status(args.id);
      return text(`${line(record2)}
[output bytes: ${record2.cursor}]`, { summary: record2.id, processId: record2.id });
    }
    if (args.action === "stop") {
      const record2 = await context.processes.stop(args.id);
      return text(`Stopped ${record2.id} \xB7 ${state(record2)}`, { summary: record2.id, processId: record2.id });
    }
    const room = context.maxOutputBytes - FOOTER_RESERVE;
    if (room < 1) return errorResult("output_budget_too_small", "process output needs room for its cursor line");
    const page = context.processes.output(args.id, args.cursor, Math.min(args.max_bytes ?? 65536, room));
    const record = context.processes.status(args.id);
    const content = [];
    for (const chunk of page.chunks) {
      const last = content.at(-1);
      if (last?.type === "text" && last.channel === chunk.channel) last.text += chunk.text;
      else content.push({ type: "text", channel: chunk.channel, text: chunk.text });
    }
    const notes = [
      `[next cursor: ${page.nextCursor}]`,
      `[${state(record)}]`,
      ...page.truncated ? ["[more output is available from that cursor]"] : [],
      ...page.droppedBytes ? [`[${page.droppedBytes} earlier bytes were dropped]`] : []
    ];
    content.push({ type: "text", text: `${page.chunks.length ? "\n" : "No new output.\n"}${notes.join("\n")}` });
    return { isError: false, content, host: {
      status: "ok",
      summary: record.id,
      processId: record.id,
      page: {
        cursor: page.chunks[0]?.start ?? page.nextCursor,
        next: page.nextCursor,
        total: page.cursor,
        earliestCursor: page.earliestCursor,
        droppedBytes: page.droppedBytes,
        truncated: page.truncated
      }
    } };
  } catch (error) {
    const failure = error;
    return errorResult(failure.code ?? "process_error", failure.message);
  }
}
export {
  example,
  handler,
  normalizeArguments,
  renamedArguments,
  validateArgs
};
