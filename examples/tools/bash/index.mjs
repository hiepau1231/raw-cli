// src/tools/bundled/bash/index.ts
import { isAbsolute, relative as relative2, resolve as resolve3 } from "path";

// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "fs/promises";
import { dirname, join as join2, parse, relative, resolve, sep } from "path";

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
      const path = join(root, name);
      if (path === directory) continue;
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
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
        const path = join(spillDirectory(), `${this.label}-${randomUUID().slice(0, 8)}.log`);
        this.fd = openSync(path, "wx", 384);
        this.path = path;
        this.entry = { path, bytes: 0 };
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
function savedLabel(path, capped = false) {
  return path && capped ? `${path} (first ${SPILL_MAX_BYTES} bytes only)` : path;
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

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

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
var MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile, appendFile, stat } from "fs/promises";
import { createHash as createHash2 } from "crypto";
import { dirname as dirname2, resolve as resolve2 } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
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
function spawnShell(options, platform = process.platform) {
  return spawn(options.bashPath ?? process.env.RAW_BASH_PATH ?? "bash", ["-c", options.command], {
    cwd: options.cwd,
    ...options.env ? { env: options.env } : {},
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32"
  });
}
function signalShellGroup(child, signal, platform = process.platform) {
  try {
    if (child.pid) process.kill(platform !== "win32" ? -child.pid : child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function runBash(options) {
  if (options.signal?.aborted) return errorResult("aborted", "bash aborted before execution");
  const timeoutMs = options.timeoutMs ?? 12e4;
  const child = spawnShell(options);
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
  const cancellationWatchdog = new Promise((resolve4) => {
    resolveCancelled = resolve4;
  });
  let escalation;
  const signalGroup = (signal) => signalShellGroup(child, signal);
  const stop = (reason) => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise((resolve4) => {
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve4();
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
        spill = new OutputSpill("bash");
        for (const buffered of pending) spill.write(buffered);
        pending = [];
      }
    }
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  let exited = { code: null, signal: null };
  const exitedPromise = new Promise((resolve4) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve4();
    });
  });
  const closedPromise = new Promise((resolve4) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", () => resolve4());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed"), cancellationWatchdog.then(() => "watchdog")]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise((resolve4) => {
      reapTimer = setTimeout(resolve4, 1300);
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
  if (spawnError) return errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`);
  const { segments, truncated } = capture.render(max, savedLabel(spill?.path, spill?.capped));
  const content = segments.map((segment) => segment.channel ? { type: "text", channel: segment.channel, text: segment.text } : { type: "text", text: segment.text });
  return {
    isError: aborted || timedOut,
    ...aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {},
    content,
    exitCode: exited.code,
    signal: exited.signal,
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
async function bashTool(args, context) {
  const cwd = args.workdir === void 0 ? context.cwd : resolve2(context.cwd, args.workdir);
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
    activity = context.commandActivity?.begin(args.command, cwd);
  } catch {
  }
  const started = performance.now();
  let result;
  try {
    result = await runBash({
      command: args.command,
      cwd,
      maxOutputBytes: Math.max(0, context.maxOutputBytes - BASH_STATUS_RESERVE),
      timeoutMs: timeout,
      ...activity ? { onOutput: activity.output } : {},
      ...bindings ? { env: { ...process.env, ...bindings } } : {},
      ...context.signal ? { signal: context.signal } : {},
      ...context.bashPath ? { bashPath: context.bashPath } : {}
    });
  } catch (error) {
    result = errorResult("bash_error", error.message);
  }
  try {
    activity?.finish(result);
  } catch {
  }
  const durationMs = Math.round(performance.now() - started);
  if (result.code === "bash_spawn_error" || result.code === "bash_error") return { ...result, host: host("error", { durationMs }) };
  const aborted = result.code === "aborted" || context.signal?.aborted === true;
  const status = aborted ? `[aborted after ${seconds(durationMs)}; process group stopped]` : result.timedOut ? `[timed out after ${timeout / 1e3}s; process group stopped]` : result.exitCode === null || result.exitCode === void 0 ? `[killed by ${result.signal ?? "signal"} \xB7 ${seconds(durationMs)}]` : `[exit ${result.exitCode} \xB7 ${seconds(durationMs)}]`;
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
var BATCH = 'bash takes one command: {"command":"npm test"}; call bash once per command';
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
function commandText(value) {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string")) return value;
  const words = value;
  if (words.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba)?sh$/.test(words[0]) && /^-l?c$/.test(words[1])) return words[2];
  return words.map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(" ");
}
function normalizeArguments(input) {
  if (Object.hasOwn(input, "commands")) return { args: input, rejected: BATCH };
  const args = { ...input };
  const notes = [];
  rename2(args, notes, "cmd", "command");
  rename2(args, notes, "script", "command");
  if (Array.isArray(args.command)) {
    args.command = commandText(args.command);
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
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (Object.hasOwn(args, "commands")) return BATCH;
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
function delegate(args, context) {
  if (args.run_in_background !== true) return void 0;
  const command = String(args.command);
  const workdir = typeof args.workdir === "string" ? relative2(context.cwd, resolve3(context.cwd, args.workdir)) : "";
  const summary = command.split("\n", 1)[0].slice(0, 200);
  const clamped = typeof args.timeout === "number" && args.timeout > BASH_MAX_TIMEOUT_MS;
  return {
    identity: "builtin/process",
    arguments: {
      action: "start",
      command,
      ...workdir && !isAbsolute(workdir) ? { cwd: workdir } : {},
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
  example,
  handler,
  normalizeArguments,
  renamedArguments,
  validateArgs
};
