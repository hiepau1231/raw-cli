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
function errorResult(code2, message) {
  return { isError: true, code: code2, content: [{ type: "text", text: message }] };
}
function indexedResultFits(results, maxOutputBytes) {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8") <= maxOutputBytes;
}
function indexedResult(results, maxOutputBytes, isError) {
  if (!indexedResultFits(results, maxOutputBytes)) return errorResult("output_budget_too_small", "batch status exceeds output budget");
  return { isError, content: [{ type: "json", value: { results } }] };
}

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;
var FILE_LINES = 2e5;
var MATCH_LINE_VISITS = 8e6;
var PatchError = class extends Error {
  constructor(code2) {
    super(code2);
    this.code = code2;
  }
  code;
};
var fail = (code2) => {
  throw new PatchError(code2);
};
var hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function checkLines(bytes) {
  let lines2 = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (const byte of bytes) if (byte === 10 && ++lines2 > FILE_LINES) fail("patch_too_many_lines");
}
var code = (error) => {
  const candidate = error instanceof PatchError ? error.code : error?.code;
  return typeof candidate === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(candidate) ? candidate : "patch_io_error";
};
function parseFilePatch(source, cwd) {
  return parsePatch(source, cwd, true);
}
function validateFilePatchSyntax(source) {
  parsePatch(source, "/", false);
}
function parsePatch(source, cwd, checkResolvedTargets) {
  if (typeof source !== "string" || Buffer.byteLength(source) > PATCH_BYTES || source.includes("\0")) fail("patch_invalid_size_or_binary");
  const lines2 = source.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines2.at(-1) === "") lines2.pop();
  if (lines2.shift() !== "*** Begin Patch" || lines2.pop() !== "*** End Patch") fail("patch_invalid_envelope");
  const changes = [];
  const targets = /* @__PURE__ */ new Set();
  let targetCount = 0;
  const target = (raw) => {
    if (!raw || raw.trim() !== raw || /[\r\n\0]/.test(raw)) fail("patch_invalid_path");
    const path = resolve2(cwd, raw);
    if (++targetCount > 64) fail("patch_too_many_paths");
    if (!checkResolvedTargets) return path;
    if (targets.has(path)) fail("patch_repeated_target");
    for (const other of targets) if (path.startsWith(other + sep) || other.startsWith(path + sep)) fail("patch_conflicting_targets");
    targets.add(path);
    if (targets.size > 64) fail("patch_too_many_paths");
    return path;
  };
  let cursor = 0;
  while (cursor < lines2.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines2[cursor++]);
    if (!header) fail("patch_invalid_header");
    const rawPath = header[2];
    const kind = header[1] === "Add" ? "add" : header[1] === "Update" ? "update" : "delete";
    const change = { kind, path: target(rawPath), rawPath, hunks: [], added: [], noNewline: false };
    if (kind === "update" && lines2[cursor]?.startsWith("*** Move to: ")) {
      change.rawDestination = lines2[cursor++].slice("*** Move to: ".length);
      change.destination = target(change.rawDestination);
    }
    if (kind === "add") {
      while (lines2[cursor]?.startsWith("+")) change.added.push(lines2[cursor++].slice(1));
    } else if (kind === "update") {
      while (lines2[cursor] === "@@") {
        cursor++;
        const hunk = { lines: [], eof: false };
        while (cursor < lines2.length && /^[ +\-]/.test(lines2[cursor])) {
          const line = lines2[cursor++];
          hunk.lines.push({ kind: line[0], text: line.slice(1) });
        }
        if (!hunk.lines.length) fail("patch_empty_hunk");
        if (lines2[cursor] === "*** End of File") {
          hunk.eof = true;
          cursor++;
        }
        change.hunks.push(hunk);
        if (hunk.eof && lines2[cursor] === "@@") fail("patch_hunk_after_eof");
      }
      if (!change.hunks.length) fail("patch_missing_hunk");
    }
    if (kind !== "delete" && lines2[cursor] === "*** No newline at end of file") {
      change.noNewline = true;
      cursor++;
    }
    changes.push(change);
  }
  if (!changes.length) fail("patch_empty");
  return { changes };
}
function describePatchEffects(parsed) {
  return { files: parsed.changes.flatMap((change) => change.destination ? [{ path: change.path, operation: "rename_source" }, { path: change.destination, operation: "rename_destination" }] : [{ path: change.path, operation: change.kind === "delete" ? "delete" : "write" }]) };
}
async function safeParents(path) {
  const root = parse(path).root;
  let current = root;
  const parts = relative(root, dirname2(path)).split(sep).filter(Boolean);
  for (const component of ["", ...parts]) {
    if (component) current = join2(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("patch_symlink_path");
      if (!info.isDirectory()) fail("patch_parent_not_directory");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}
async function absent(path) {
  await safeParents(path);
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail("patch_destination_exists");
}
async function snapshot(path) {
  await safeParents(path);
  const before = await lstat(path);
  if (before.isSymbolicLink()) fail("patch_symlink_path");
  if (!before.isFile()) fail("patch_not_regular_file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) fail("patch_source_changed");
    if (info.size > SOURCE_BYTES) fail("patch_source_too_large");
    const buffer = Buffer.alloc(Math.min(SOURCE_BYTES + 1, info.size + 1));
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== info.size) fail("patch_source_changed");
    const bytes = buffer.subarray(0, count);
    if (bytes.includes(0)) fail("patch_binary_source");
    checkLines(bytes);
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail("patch_invalid_utf8");
    }
    return { bytes, hash: hash(bytes), mode: info.mode & 4095, dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
}
function applyHunks(bytes, change, work) {
  const decoded = bytes.toString("utf8");
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? decoded.slice(1) : decoded;
  const source = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    if (end < 0) {
      source.push({ text: text.slice(offset), ending: "" });
      break;
    }
    const crlf = end > offset && text[end - 1] === "\r";
    source.push({ text: text.slice(offset, crlf ? end - 1 : end), ending: crlf ? "\r\n" : "\n" });
    offset = end + 1;
  }
  const fallback = source.find((line) => line.ending)?.ending ?? "\n";
  const output = [];
  let cursor = 0;
  for (const hunk of change.hunks) {
    const expected = hunk.lines.filter((line) => line.kind !== "+");
    const matches = [];
    if (!expected.length) {
      if (source.length || cursor || output.length) fail("patch_unanchored_insertion");
      matches.push(0);
    } else {
      const prefix = new Array(expected.length).fill(0);
      for (let i = 1, matched = 0; i < expected.length; i++) {
        while (matched && expected[i].text !== expected[matched].text) matched = prefix[matched - 1];
        if (expected[i].text === expected[matched].text) matched++;
        prefix[i] = matched;
      }
      for (let i = cursor, matched = 0; i < source.length; i++) {
        if (--work.remaining < 0) fail("patch_matching_limit");
        while (matched && source[i].text !== expected[matched].text) matched = prefix[matched - 1];
        if (source[i].text === expected[matched].text) matched++;
        if (matched === expected.length) {
          if (!hunk.eof || i === source.length - 1) matches.push(i - matched + 1);
          if (matches.length > 1) break;
          matched = prefix[matched - 1];
        }
      }
    }
    if (matches.length !== 1) fail(matches.length ? "patch_ambiguous_context" : "patch_context_not_found");
    const at = matches[0];
    for (let i = cursor; i < at; i++) output.push({ ...source[i] });
    let input = at;
    for (const line of hunk.lines) {
      if (line.kind === " ") output.push({ ...source[input++] });
      else if (line.kind === "-") input++;
      else {
        const ending = source[input]?.ending || source[input - 1]?.ending || fallback;
        output.push({ text: line.text, ending });
      }
    }
    cursor = input;
  }
  for (let i = cursor; i < source.length; i++) output.push({ ...source[i] });
  for (let i = 0; i < output.length - 1; i++) if (!output[i].ending) output[i].ending = fallback;
  if (output.length) output[output.length - 1].ending = change.noNewline || !text.endsWith("\n") ? "" : output.at(-1).ending || fallback;
  return Buffer.from(bom + output.map((line) => line.text + line.ending).join(""));
}
async function stageFilePatch(parsed) {
  const changes = [];
  const work = { remaining: MATCH_LINE_VISITS };
  let retained = 0;
  const account = (bytes) => {
    retained += bytes.length;
    if (retained > STAGED_BYTES) fail("patch_staging_too_large");
    checkLines(bytes);
    return bytes;
  };
  for (const change of parsed.changes) {
    if (change.kind === "add") {
      await absent(change.path);
      const text = change.added.join("\n") + (change.added.length && !change.noNewline ? "\n" : "");
      changes.push({ change, after: account(Buffer.from(text)) });
    } else {
      const source = await snapshot(change.path);
      account(source.bytes);
      if (change.destination) await absent(change.destination);
      changes.push({ change, source, ...change.kind === "update" ? { after: account(applyHunks(source.bytes, change, work)) } : {} });
    }
  }
  return { changes };
}
async function recheck(staged) {
  if (staged.source) {
    const current = await snapshot(staged.change.path);
    if (current.hash !== staged.source.hash || current.mode !== staged.source.mode || current.dev !== staged.source.dev || current.ino !== staged.source.ino) fail("patch_source_changed");
  } else await absent(staged.change.path);
  if (staged.change.destination) await absent(staged.change.destination);
}
function reserved(parsed) {
  return parsed.changes.map((change, index) => ({
    index,
    path: change.rawPath,
    mode: "patch",
    status: "skipped",
    ...change.rawDestination ? { destination: change.rawDestination } : {},
    error: "x".repeat(120),
    bytes_written: 999999999,
    destination_created: true
  }));
}
function basic(change, index) {
  return {
    index,
    path: change.rawPath,
    mode: "patch",
    status: "skipped",
    ...change.rawDestination ? { destination: change.rawDestination } : {}
  };
}
async function notify(options, change) {
  try {
    await options.onCompleted?.(change);
  } catch {
  }
}
async function applyStagedFilePatch(staged, options) {
  const parsed = { changes: staged.changes.map((item) => item.change) };
  if (!indexedResultFits(reserved(parsed), options.maxOutputBytes)) return errorResult("output_budget_too_small", "patch outcomes exceed output budget");
  const rows = parsed.changes.map(basic);
  if (options.signal?.aborted) return indexedResult(rows.map((row) => ({ ...row, error: "aborted" })), options.maxOutputBytes, true);
  try {
    for (const item of staged.changes) await recheck(item);
  } catch (error) {
    return errorResult("patch_preflight_failed", code(error));
  }
  let stopped = false;
  for (const [index, item] of staged.changes.entries()) {
    const { change, source, after } = item;
    if (stopped || options.signal?.aborted) {
      rows[index] = { ...rows[index], error: options.signal?.aborted ? "aborted" : "prior_patch_failure" };
      continue;
    }
    let temporary;
    let destinationCreated = false;
    try {
      await recheck(item);
      if (options.signal?.aborted) fail("aborted");
      if (change.kind === "delete") {
        await unlink(change.path);
        await notify(options, { path: change.path, kind: "deleted", before: source.bytes });
      } else {
        const destination = change.destination ?? change.path;
        await mkdir(dirname2(destination), { recursive: true });
        await safeParents(destination);
        temporary = join2(dirname2(destination), `.raw-patch-${randomUUID2()}.tmp`);
        const handle = await open(temporary, "wx", source?.mode ?? 438);
        try {
          await handle.writeFile(after);
        } finally {
          await handle.close();
        }
        if (source) await chmod(temporary, source.mode);
        await recheck(item);
        if (options.signal?.aborted) fail("aborted");
        if (change.kind === "add" || change.destination) {
          await link(temporary, destination);
          destinationCreated = true;
          if (change.destination) await unlink(change.path);
        } else await rename(temporary, destination);
        await notify(options, {
          path: destination,
          kind: change.destination ? "renamed" : change.kind === "add" ? "added" : "modified",
          ...change.destination ? { oldPath: change.path } : {},
          ...source ? { before: source.bytes } : {},
          after
        });
      }
      rows[index] = { ...rows[index], status: "ok", bytes_written: after?.length ?? 0 };
    } catch (error) {
      stopped = true;
      if (destinationCreated && change.destination) await notify(options, { path: change.destination, kind: "added", after });
      rows[index] = {
        ...rows[index],
        status: code(error) === "aborted" ? "skipped" : "error",
        error: code(error),
        ...destinationCreated ? { destination_created: true } : {}
      };
    } finally {
      if (temporary) {
        try {
          await unlink(temporary);
        } catch {
        }
      }
    }
  }
  return indexedResult(rows, options.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}
async function applyFilePatch(parsed, options) {
  if (!indexedResultFits(reserved(parsed), options.maxOutputBytes)) return errorResult("output_budget_too_small", "patch outcomes exceed output budget");
  if (options.signal?.aborted) return indexedResult(parsed.changes.map((change, index) => ({ ...basic(change, index), error: "aborted" })), options.maxOutputBytes, true);
  let staged;
  try {
    staged = await stageFilePatch(parsed);
  } catch (error) {
    return errorResult("patch_preflight_failed", code(error));
  }
  return applyStagedFilePatch(staged, options);
}

// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

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

// src/tools/line-diff.ts
var CONTEXT_LINES = 3;
var MAX_CELLS = 1e6;
var NO_EOL = "\0";
function lines(text) {
  if (!text) return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  else split[split.length - 1] += NO_EOL;
  return split;
}
function nextAt(positions, from) {
  if (!positions) return Infinity;
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const mid = low + high >> 1;
    if (positions[mid] < from) low = mid + 1;
    else high = mid;
  }
  return low < positions.length ? positions[low] : Infinity;
}
function operations(before, after, emit) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endOld = before.length;
  let endNew = after.length;
  while (endOld > start && endNew > start && before[endOld - 1] === after[endNew - 1]) {
    endOld--;
    endNew--;
  }
  for (let index = Math.max(0, start - CONTEXT_LINES); index < start; index++) if (!emit({ kind: " ", text: before[index], oldAt: index, newAt: index })) return;
  const n = endOld - start;
  const m = endNew - start;
  const old = (i2) => before[start + i2];
  const neu = (j2) => after[start + j2];
  let i = 0;
  let j = 0;
  const step = (kind) => {
    const op = { kind, text: kind === "+" ? neu(j) : old(i), oldAt: start + i, newAt: start + j };
    if (kind !== "+") i++;
    if (kind !== "-") j++;
    return emit(op);
  };
  if (n && m && n * m <= MAX_CELLS) {
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
      common[a * width + b] = old(a) === neu(b) ? common[(a + 1) * width + b + 1] + 1 : Math.max(common[(a + 1) * width + b], common[a * width + b + 1]);
    }
    while (i < n || j < m) {
      const kind = i < n && j < m && old(i) === neu(j) ? " " : i < n && (j === m || common[(i + 1) * width + j] >= common[i * width + j + 1]) ? "-" : "+";
      if (!step(kind)) return;
    }
  } else {
    const index = (count, line) => {
      const positions = /* @__PURE__ */ new Map();
      for (let k = 0; k < count; k++) {
        const list = positions.get(line(k));
        if (list) list.push(k);
        else positions.set(line(k), [k]);
      }
      return positions;
    };
    const inOld = index(n, old);
    const inNew = index(m, neu);
    while (i < n && j < m) {
      if (old(i) === neu(j)) {
        if (!step(" ")) return;
        continue;
      }
      const added = nextAt(inNew.get(old(i)), j) - j;
      const removed = nextAt(inOld.get(neu(j)), i) - i;
      if (added === Infinity && removed === Infinity) {
        if (!step("-") || !step("+")) return;
      } else if (added <= removed) {
        for (let k = 0; k < added; k++) if (!step("+")) return;
      } else for (let k = 0; k < removed; k++) if (!step("-")) return;
    }
    while (i < n) if (!step("-")) return;
    while (j < m) if (!step("+")) return;
  }
  for (let index = 0; index < Math.min(CONTEXT_LINES, before.length - endOld); index++) {
    if (!emit({ kind: " ", text: before[endOld + index], oldAt: endOld + index, newAt: endNew + index })) return;
  }
}
function unifiedDiff(before, after, budgetBytes, indent = "") {
  const out = [];
  let bytes = 0;
  let truncated = false;
  const push = (line) => {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size <= budgetBytes) {
      out.push(line);
      bytes += size;
      return true;
    }
    const cut = utf8Prefix(line, budgetBytes - bytes - Buffer.byteLength("\u2026", "utf8") - 1).text;
    if (cut.length > indent.length + 1) {
      out.push(`${cut}\u2026`);
      bytes += Buffer.byteLength(`${cut}\u2026`, "utf8") + 1;
    }
    truncated = true;
    return false;
  };
  const render = (hunk2) => {
    const oldCount = hunk2.filter((op) => op.kind !== "+").length;
    const newCount = hunk2.filter((op) => op.kind !== "-").length;
    const first = hunk2[0];
    if (!push(`${indent}@@ -${first.oldAt + (oldCount ? 1 : 0)},${oldCount} +${first.newAt + (newCount ? 1 : 0)},${newCount} @@`)) return false;
    for (const op of hunk2) {
      const ending = op.text.endsWith(NO_EOL);
      if (!push(`${indent}${op.kind}${ending ? op.text.slice(0, -1) : op.text}`)) return false;
      if (ending && !push(`${indent}\\ No newline at end of file`)) return false;
    }
    return true;
  };
  let leading = [];
  let hunk;
  let hunkBytes = 0;
  let trailing = 0;
  operations(lines(before), lines(after), (op) => {
    if (op.kind === " ") {
      if (!hunk) {
        leading.push(op);
        if (leading.length > CONTEXT_LINES) leading.shift();
        return true;
      }
      hunk.push(op);
      if (++trailing <= 2 * CONTEXT_LINES) return true;
      const closed = hunk.splice(0, hunk.length - trailing + CONTEXT_LINES);
      leading = hunk.slice(-CONTEXT_LINES);
      hunk = void 0;
      return render(closed);
    }
    if (!hunk) {
      hunk = leading;
      leading = [];
      hunkBytes = 0;
    }
    hunk.push(op);
    trailing = 0;
    hunkBytes += Buffer.byteLength(op.text, "utf8") + indent.length + 2;
    if (bytes + hunkBytes <= budgetBytes) return true;
    render(hunk);
    hunk = void 0;
    truncated = true;
    return false;
  });
  if (hunk && !truncated) render(hunk.slice(0, hunk.length - Math.max(0, trailing - CONTEXT_LINES)));
  return { text: out.join("\n"), truncated };
}
function lineCounts(before, after) {
  let added = 0;
  let removed = 0;
  operations(lines(before), lines(after), (op) => {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
    return true;
  });
  return { added, removed };
}

// src/tools/write-changes.ts
var HOST_DIFF_BYTES = 64 * 1024;
var ENTRY_DIFF_BYTES = 8 * 1024;
var clean = (text) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "\uFFFD");
var omittedKey = "Omitted history entries";
var MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;
function undiffable(change) {
  const sides2 = [change.before, change.after];
  const size = (bytes) => (bytes?.length ?? 0) > MAX_DIFF_SOURCE_BYTES ? `more than ${MAX_DIFF_SOURCE_BYTES}` : String(bytes?.length ?? 0);
  if (change.beforeUnavailable || change.afterUnavailable) return "[diff unavailable: file bytes could not be read]";
  if (sides2.some((bytes) => bytes && bytes.length > MAX_DIFF_SOURCE_BYTES)) return `[file too large to diff: ${size(change.before)} \u2192 ${size(change.after)} bytes]`;
  if (sides2.some((bytes) => bytes?.subarray(0, 8192).includes(0))) return `[binary content: ${size(change.before)} \u2192 ${size(change.after)} bytes]`;
  return void 0;
}
var sides = (change) => [clean(change.before?.toString("utf8") ?? ""), clean(change.after?.toString("utf8") ?? "")];
function counts(change) {
  if (change.beforeUnavailable || change.afterUnavailable || change.beforePartial) return void 0;
  if ([change.before, change.after].some((bytes) => bytes?.subarray(0, 8192).includes(0))) return void 0;
  return lineCounts(change.before?.toString("utf8") ?? "", change.after?.toString("utf8") ?? "");
}
var within = (inside) => !!inside && inside !== ".." && !inside.startsWith(`..${sep2}`) && !isAbsolute2(inside);
function displayPath(path, cwd) {
  const inside = relative2(cwd, path);
  return within(inside) ? inside : path;
}
function changeHostData(changes, cwd, withDiff) {
  const files = changes.map((change) => {
    const action = change.kind === "added" ? "create" : change.kind === "deleted" ? "delete" : change.kind === "renamed" ? "rename" : change.overwritten ? "overwrite" : "edit";
    const shown = displayPath(change.oldPath ?? change.path, cwd);
    return { path: shown, action, ...counts(change), ...change.oldPath ? { destination: displayPath(change.path, cwd) } : {} };
  });
  if (!withDiff) return { files };
  const parts = changes.map((change) => {
    const from = displayPath(change.oldPath ?? change.path, cwd);
    const to = displayPath(change.path, cwd);
    const reason = undiffable(change);
    const body = reason ?? unifiedDiff(...sides(change), HOST_DIFF_BYTES + 1).text;
    return `--- ${change.kind === "added" ? "/dev/null" : `a/${from}`}
+++ ${change.kind === "deleted" ? "/dev/null" : `b/${to}`}
${body}`;
  });
  const diff = parts.join("\n");
  return Buffer.byteLength(diff) <= HOST_DIFF_BYTES ? { files, diff } : { files, diffOmitted: true };
}
function homeLabel(path) {
  const home = homedir();
  const inside = home ? relative2(home, path) : "";
  return isAbsolute2(path) && within(inside) ? `~/${inside.split(sep2).join("/")}` : void 0;
}
function buildWriteChanges(previous, changes, cwd) {
  const files = previous?.blocks.find((b) => b.id === "files" && b.kind === "files");
  const retention = previous?.blocks.find((b) => b.id === "retention" && b.kind === "key_value");
  let omitted = Number(retention?.entries.find((e) => e.key === omittedKey)?.value ?? 0) || 0;
  const byPath = new Map((files?.entries ?? []).map((e) => [e.path, { ...e }]));
  const put = (path, status, label, change) => {
    if ([...path].length > 500 || /[\u0000-\u001F\u007F]/.test(path)) {
      omitted++;
      return;
    }
    const old = byPath.get(path);
    byPath.delete(path);
    const latest = change ? counts(change) : { added: 0, removed: 0 };
    const known = latest && (!old || old.added !== void 0);
    const reason = change && undiffable(change);
    const diff = change && !reason ? unifiedDiff(...sides(change), ENTRY_DIFF_BYTES) : void 0;
    const shownLabel = label ?? homeLabel(path);
    byPath.set(path, {
      path,
      status: status === "modified" && old?.status === "added" ? "added" : status,
      ...shownLabel ? { label: [...clean(shownLabel)].slice(0, 200).join("") } : {},
      ...known ? { added: (old?.added ?? 0) + latest.added, removed: (old?.removed ?? 0) + latest.removed } : {},
      ...reason ? { diff: reason } : diff?.text ? { diff: diff.text + (diff.truncated ? "\n[diff truncated]" : "") } : {}
    });
  };
  for (const change of changes) {
    const to = displayPath(change.path, cwd);
    if (change.kind === "renamed" && change.oldPath) {
      const from = displayPath(change.oldPath, cwd);
      const label = `${homeLabel(from) ?? from} \u2192 ${homeLabel(to) ?? to}`;
      put(from, "deleted", label);
      put(to, "added", label, change);
    } else put(to, change.kind === "deleted" ? "deleted" : change.kind === "added" ? "added" : "modified", void 0, change);
  }
  while (byPath.size > 200) {
    byPath.delete(byPath.keys().next().value);
    omitted++;
  }
  const fileCount = (count) => `${count} ${count === 1 ? "file" : "files"}`;
  const doc = () => {
    const shown = [...byPath.values()];
    const totals = shown.length && shown.every((entry) => entry.added !== void 0 && entry.removed !== void 0) ? ` \xB7 +${shown.reduce((sum, entry) => sum + entry.added, 0)} \u2212${shown.reduce((sum, entry) => sum + entry.removed, 0)}` : "";
    return {
      title: "Files changed",
      subtitle: "Successful tool writes in this session; not Git status or Bash edits.",
      summary: `${fileCount(shown.length)}${totals}`,
      context_summary: `${byPath.size} successful tool-write paths retained; ${omitted} history entries omitted.`,
      blocks: [
        { id: "files", kind: "files", entries: shown },
        ...omitted ? [{ id: "retention", kind: "key_value", entries: [{ key: omittedKey, value: String(omitted) }] }] : []
      ]
    };
  };
  let document = doc();
  for (const entry of byPath.values()) {
    if (Buffer.byteLength(JSON.stringify(document)) <= PANEL_LIMITS.documentBytes) break;
    if (entry.diff !== void 0) {
      delete entry.diff;
      document = doc();
    }
  }
  while (Buffer.byteLength(JSON.stringify(document)) > PANEL_LIMITS.documentBytes && byPath.size) {
    byPath.delete(byPath.keys().next().value);
    omitted++;
    document = doc();
  }
  return document;
}
async function publishWriteChanges(context, changes) {
  if (!changes.length) return;
  try {
    context.onWriteCompleted?.();
  } catch {
  }
  if (!context.panels) return;
  try {
    const previous = context.panels.get("files_changed")?.document;
    await context.panels.update("files_changed", { op: "replace", document: buildWriteChanges(previous, changes, context.cwd) });
  } catch {
  }
}

// src/tools/primitives.ts
import { open as open2, mkdir as mkdir2, writeFile, readFile, stat } from "fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "path";

// src/tools/process.ts
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

// src/tools/primitives.ts
var LETTERS = { added: "A", modified: "M", deleted: "D", renamed: "R" };
async function applyPatchTool(args, context) {
  let parsed;
  try {
    parsed = parseFilePatch(args.patch, context.cwd);
  } catch (error) {
    return { ...errorResult("invalid_patch", error instanceof Error ? error.message : "invalid patch"), host: { status: "error" } };
  }
  const completed = [];
  const applied = await applyFilePatch(parsed, {
    maxOutputBytes: 1024 * 1024,
    ...context.signal ? { signal: context.signal } : {},
    onCompleted: async (change) => {
      completed.push(change);
      await publishWriteChanges(context, [change]);
    }
  });
  const rows = applied.content[0]?.type === "json" ? applied.content[0].value.results : void 0;
  const host = {
    summary: `${parsed.changes.length} file${parsed.changes.length === 1 ? "" : "s"}`,
    status: applied.isError ? "error" : "ok",
    ...changeHostData(completed, context.cwd, true)
  };
  if (!rows) return { ...applied, host };
  const lines2 = completed.map((change, index) => {
    const file = host.files[index];
    return `${LETTERS[change.kind]} ${file.path}${file.destination ? ` \u2192 ${file.destination}` : ""}${file.added === void 0 ? "" : ` (+${file.added} \u2212${file.removed})`}`;
  });
  for (const row of rows) if (row.status !== "ok") lines2.push(`${row.status === "skipped" ? "skipped" : "failed"} ${String(row.path)}: ${String(row.error ?? row.status)}`);
  return { isError: applied.isError, ...applied.code ? { code: applied.code } : {}, content: [{ type: "text", text: lines2.join("\n") || "No changes." }], host };
}

// src/tools/normalize.ts
function renameArgument(args, notes, from, to, convert = (value) => value) {
  if (!Object.hasOwn(args, from) || args[to] !== void 0) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}

// src/tools/bundled/apply_patch/index.ts
var example = { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch" };
function normalizeArguments(input) {
  const args = { ...input };
  const notes = [];
  renameArgument(args, notes, "input", "patch");
  return { args, notes };
}
function describeEffects(args, context) {
  return describePatchEffects(parseFilePatch(String(args.patch), context.cwd));
}
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (typeof args.patch !== "string") return "patch must be a string";
  try {
    validateFilePatchSyntax(args.patch);
  } catch (error) {
    return error instanceof Error ? error.message : "invalid patch";
  }
  return void 0;
}
async function handler(args, context) {
  return applyPatchTool(args, context);
}
export {
  describeEffects,
  example,
  handler,
  normalizeArguments,
  validateArgs
};
