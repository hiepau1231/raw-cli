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
import { isAbsolute as isAbsolute2, relative as relative2 } from "path";

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
var DIFF_PREVIEW_BYTES = 6144;
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
function diffPreview(change) {
  const reason = undiffable(change);
  if (reason) return `${reason}
`;
  const diff = unifiedDiff(...sides(change), DIFF_PREVIEW_BYTES, "    ");
  return `${diff.text}
${diff.truncated ? "\n[diff truncated]" : ""}`;
}
function counts(change) {
  if (change.beforeUnavailable || change.afterUnavailable || change.beforePartial) return void 0;
  if ([change.before, change.after].some((bytes) => bytes?.subarray(0, 8192).includes(0))) return void 0;
  return lineCounts(change.before?.toString("utf8") ?? "", change.after?.toString("utf8") ?? "");
}
function displayPath(path, cwd) {
  const inside = relative2(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute2(inside) ? inside : path;
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
function buildWriteChanges(previous, changes) {
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
    const diff = change && !undiffable(change) ? unifiedDiff(...sides(change), ENTRY_DIFF_BYTES) : void 0;
    byPath.set(path, {
      path,
      status: status === "modified" && old?.status === "added" ? "added" : status,
      ...label ? { label: [...clean(label)].slice(0, 200).join("") } : {},
      ...known ? { added: (old?.added ?? 0) + latest.added, removed: (old?.removed ?? 0) + latest.removed } : {},
      ...diff?.text ? { diff: diff.text + (diff.truncated ? "\n[diff truncated]" : "") } : {}
    });
  };
  const previews = [];
  for (const change of changes) {
    if (change.kind === "renamed" && change.oldPath) {
      put(change.oldPath, "deleted", `${change.oldPath} \u2192 ${change.path}`);
      put(change.path, "added", `${change.oldPath} \u2192 ${change.path}`, change);
    } else put(change.path, change.kind === "deleted" ? "deleted" : change.kind === "added" ? "added" : "modified", void 0, change);
    previews.push(`Recent diff: ${clean(change.oldPath ? `${change.oldPath} \u2192 ${change.path}` : change.path)}

${diffPreview(change)}`);
  }
  while (byPath.size > 200) {
    byPath.delete(byPath.keys().next().value);
    omitted++;
  }
  const oldPreview = previous?.blocks.find((b) => b.id === "recent_diff" && b.kind === "markdown");
  const allPreview = [...previews.reverse(), ...oldPreview ? [oldPreview.text] : []].join("\n\n");
  const preview = utf8Prefix(allPreview, 12e3);
  const doc = () => ({
    title: "Files changed",
    status: "done",
    subtitle: "Successful tool writes in this session; not Git status or Bash edits.",
    summary: `${byPath.size} paths shown; ${omitted} history entries omitted`,
    context_summary: `${byPath.size} successful tool-write paths retained; ${omitted} history entries omitted.`,
    blocks: [
      { id: "files", kind: "files", entries: [...byPath.values()] },
      { id: "retention", kind: "key_value", entries: [{ key: omittedKey, value: String(omitted) }] },
      { id: "recent_diff", kind: "markdown", title: "Recent diff", text: preview.text + (preview.truncated ? "\n\n[diff truncated]" : "") }
    ]
  });
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
    await context.panels.update("files_changed", { op: "replace", document: buildWriteChanges(previous, changes) });
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
var errorCode = (error, fallback) => {
  const code = error?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code) ? code : fallback;
};
async function writeSnapshot(path) {
  let file;
  try {
    if (!(await stat(path)).isFile()) return { missing: false };
    file = await open2(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return { missing: false };
    const bytes = Buffer.alloc(Math.min(info.size, MAX_DIFF_SOURCE_BYTES) + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return { bytes: bytes.subarray(0, filled), missing: false, partial: filled < info.size };
  } catch (error) {
    return { missing: error.code === "ENOENT" };
  } finally {
    await file?.close().catch(() => {
    });
  }
}
var changeResult = (text, shown, changes, cwd, withDiff) => ({ isError: false, content: [{ type: "text", text }], host: { summary: shown, status: "ok", ...changeHostData(changes, cwd, withDiff) } });
async function writeFileTool(args, context) {
  const path = resolve3(context.cwd, args.path);
  const shown = displayPath(path, context.cwd);
  try {
    const before = await writeSnapshot(path);
    await mkdir2(dirname3(path), { recursive: true });
    const after = Buffer.from(args.content, "utf8");
    await writeFile(path, after);
    const change = {
      path,
      kind: before.missing ? "added" : "modified",
      overwritten: !before.missing,
      ...before.bytes ? { before: before.bytes } : !before.missing ? { beforeUnavailable: true } : {},
      ...before.partial ? { beforePartial: true } : {},
      after
    };
    await publishWriteChanges(context, [change]);
    return changeResult(
      `Wrote ${after.length.toLocaleString("en-US")} bytes to ${shown} (${before.missing ? "created" : "overwritten"})`,
      shown,
      [change],
      context.cwd,
      false
    );
  } catch (error) {
    const code = errorCode(error, "write_error");
    return { ...errorResult(code, `cannot write ${shown}: ${code}`), host: { summary: shown, status: "error" } };
  }
}

// src/tools/normalize.ts
function renameArgument(args, notes, from, to, convert = (value) => value) {
  if (!Object.hasOwn(args, from) || args[to] !== void 0) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}
var PATH_ALIASES = ["file_path", "filePath", "absolute_path"];

// src/tools/bundled/write_file/index.ts
import { resolve as resolve4 } from "path";
var example = { path: "notes/todo.md", content: "# Todo\n" };
var renamedArguments = { operations: "path" };
var OLD = 'write_file writes one whole file: {"path":"notes/todo.md","content":"# Todo\\n"}; use edit_file to change part of a file and apply_patch for patches';
function normalizeArguments(input) {
  if (Object.hasOwn(input, "operations") || Object.hasOwn(input, "patch")) return { args: input, rejected: OLD };
  const args = { ...input };
  const notes = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const alias of ["file_text", "text", "contents"]) renameArgument(args, notes, alias, "content");
  return { args, notes };
}
function describeEffects(args, context) {
  return { files: [{ path: resolve4(context.cwd, String(args.path)), operation: "write" }] };
}
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (Object.hasOwn(args, "operations") || Object.hasOwn(args, "patch")) return OLD;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  if (typeof args.content !== "string") return "content must be a string";
  return void 0;
}
async function handler(args, context) {
  return writeFileTool(args, context);
}
export {
  describeEffects,
  example,
  handler,
  normalizeArguments,
  renamedArguments,
  validateArgs
};
