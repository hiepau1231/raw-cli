// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "fs/promises";
import { dirname as dirname2, join as join2, parse, relative, resolve as resolve2, sep } from "path";

// src/tools/types.ts
var MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// src/tools/spill.ts
import { closeSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";
var SPILL_MAX_BYTES = 64 * 1024 * 1024;
var SPILL_TOTAL_BYTES = 1024 * 1024 * 1024;
var SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 60 * 1e3;
var SPILL_PATH_RESERVE = tmpdir().length + 96;

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
function errorResult(code, message) {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

// src/tools/write-changes.ts
import { homedir } from "os";
import { isAbsolute as isAbsolute2, relative as relative2, sep as sep2 } from "path";

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
var HOST_DIFF_BYTES = 64 * 1024;
var ENTRY_DIFF_BYTES = 8 * 1024;
var MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;
var within = (inside) => !!inside && inside !== ".." && !inside.startsWith(`..${sep2}`) && !isAbsolute2(inside);
function displayPath(path, cwd) {
  const inside = relative2(cwd, path);
  return within(inside) ? inside : path;
}

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile, stat } from "fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/primitives.ts
var READ_DEFAULT_LIMIT = 2e3;
var READ_FOOTER_RESERVE = 200;
var errorCode = (error, fallback) => {
  const code = error?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code) ? code : fallback;
};
async function readFileTool(args, context) {
  const path = resolve3(context.cwd, args.path);
  const shown = displayPath(path, context.cwd);
  const offset = args.offset ?? 1;
  const last = args.limit === void 0 ? offset + READ_DEFAULT_LIMIT - 1 : offset + args.limit - 1;
  const budget = context.maxOutputBytes - READ_FOOTER_RESERVE;
  if (budget < 32) return errorResult("output_budget_too_small", "read_file needs room for at least one line and its footer");
  const failed = (code, message) => ({ ...errorResult(code, message), host: { summary: shown, status: "error", path: shown } });
  let handle;
  try {
    handle = await open2(path, "r");
  } catch (error) {
    const code = errorCode(error, "file_error");
    return failed(code, code === "ENOENT" ? `${shown} does not exist` : `cannot read ${shown}: ${code}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return failed("not_a_file", `${shown} is not a regular file`);
    const probe = Buffer.alloc(Math.min(info.size, 8192));
    await handle.read(probe, 0, probe.length, 0);
    if (probe.includes(0)) {
      return { isError: false, content: [{ type: "text", text: `[binary file: ${info.size} bytes; not shown]` }], host: { summary: shown, status: "ok", path: shown } };
    }
    const width = Math.max(4, String(Math.min(last, offset + info.size)).length);
    const lines = [];
    let used = 0;
    let total = 0;
    let stopped = false;
    let cut;
    let pending = [];
    let kept = 0;
    let lineBytes = 0;
    const keep = budget + 4;
    const take = (line, raw, bytes) => {
      if (stopped || line < offset || line > last) return;
      const text = raw.toString("utf8").replace(/\r$/, "");
      const rendered = `${String(line).padStart(width)}\u2502${text}
`;
      const size = Buffer.byteLength(rendered);
      if (used + size <= budget) {
        lines.push(rendered);
        used += size;
        return;
      }
      stopped = true;
      if (lines.length) return;
      const marker = " \u2026[line cut]\n";
      const prefix = utf8Prefix(rendered, budget - Buffer.byteLength(marker)).text;
      lines.push(prefix + marker);
      cut = { line, bytes };
    };
    for await (const rawChunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end2 = newline < 0 ? chunk.length : newline + 1;
        const line = total + 1;
        if (line >= offset && line <= last && !stopped) {
          const part = chunk.subarray(cursor, newline < 0 ? end2 : newline);
          lineBytes += part.length;
          if (kept < keep) {
            pending.push(part.subarray(0, keep - kept));
            kept += Math.min(part.length, keep - kept);
          }
        }
        cursor = end2;
        if (newline < 0) continue;
        total++;
        take(line, Buffer.concat(pending), lineBytes);
        pending = [];
        kept = 0;
        lineBytes = 0;
      }
    }
    if (pending.length || info.size && probe.length && !await lastByteIsNewline(handle, info.size)) {
      total++;
      take(total, Buffer.concat(pending), lineBytes);
    }
    const end = offset + lines.length - 1;
    const footer = total === 0 ? "[empty file]" : offset > total ? `[offset ${offset} is past the end: ${shown} has ${total} lines]` : cut ? `[line ${cut.line} of ${total} cut at the output budget (${cut.bytes} bytes); next: offset ${cut.line + 1}]` : end >= total ? `[lines ${offset}\u2013${end} of ${total}; end of file]` : `[lines ${offset}\u2013${end} of ${total}; next: offset ${end + 1}]`;
    return {
      isError: false,
      content: [{ type: "text", text: lines.join("") + footer }],
      host: { summary: shown, status: "ok", path: shown, ...total && offset <= total ? { range: { start: offset, end, total } } : {} }
    };
  } catch (error) {
    return failed(errorCode(error, "file_error"), `cannot read ${shown}: ${errorCode(error, "file_error")}`);
  } finally {
    await handle.close();
  }
}
async function lastByteIsNewline(handle, size) {
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, size - 1);
  return byte[0] === 10;
}

// src/tools/normalize.ts
function renameArgument(args, notes, from, to, convert = (value) => value) {
  if (!Object.hasOwn(args, from) || args[to] !== void 0) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}
var integerArgument = (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
var PATH_ALIASES = ["file_path", "filePath", "absolute_path"];

// src/tools/bundled/read_file/index.ts
var example = { path: "src/app.ts", offset: 120, limit: 80 };
var renamedArguments = { files: "path" };
var TO_END = 2147483647;
var BATCH = 'read_file reads one file: {"path":"src/app.ts","offset":120,"limit":80}; call read_file once per file';
function normalizeArguments(input) {
  if (Object.hasOwn(input, "files")) return { args: input, rejected: BATCH };
  const args = { ...input };
  const notes = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const key of ["offset", "limit", "start_line", "end_line", "max_lines", "lines"]) if (Object.hasOwn(args, key)) args[key] = integerArgument(args[key]);
  if (Array.isArray(args.view_range) && args.offset === void 0 && args.limit === void 0) {
    const [first, last] = args.view_range.map(integerArgument);
    if (typeof first === "number") {
      args.offset = first;
      if (typeof last === "number") args.limit = last === -1 ? TO_END : last - first + 1;
      delete args.view_range;
      notes.push("read view_range as offset and limit");
    }
  }
  renameArgument(args, notes, "start_line", "offset");
  if (typeof args.end_line === "number" && args.limit === void 0) {
    args.limit = args.end_line === -1 ? TO_END : args.end_line - (typeof args.offset === "number" ? args.offset : 1) + 1;
    delete args.end_line;
    notes.push("read end_line as limit");
  }
  renameArgument(args, notes, "max_lines", "limit");
  renameArgument(args, notes, "lines", "limit");
  return { args, notes };
}
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (Object.hasOwn(args, "files")) return BATCH;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  for (const key of ["offset", "limit"]) {
    if (args[key] !== void 0 && (!Number.isSafeInteger(args[key]) || args[key] < 1 || args[key] > 2147483647)) return `${key} must be a positive integer`;
  }
  return void 0;
}
async function handler(args, context) {
  return readFileTool(args, context);
}
export {
  example,
  handler,
  normalizeArguments,
  renamedArguments,
  validateArgs
};
