// src/tools/primitives.ts
import { constants as fsConstants } from "fs";

// src/tools/file-patch.ts
import { createHash, randomUUID as randomUUID2 } from "crypto";
import { constants } from "fs";
import { chmod, link, lstat, mkdir, open, unlink } from "fs/promises";
import { dirname as dirname2, join as join2, parse, relative, sep } from "path";

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

// src/platform/fs.ts
import { closeSync as closeSync2, fsyncSync, openSync as openSync2 } from "fs";
import { access, readFile, rename } from "fs/promises";
import path from "path";

// src/platform/paths.ts
import path2 from "path";
function pathFor(platform = process.platform) {
  return platform === "win32" ? path2.win32 : path2.posix;
}
function resolveToolPath(cwd, input, platform = process.platform) {
  const api = pathFor(platform);
  if (platform !== "win32") return api.resolve(cwd, input);
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(input);
  return api.resolve(cwd, drive ? `${drive[1].toUpperCase()}:\\${drive[2] ?? ""}` : input);
}
function slashPath(value, platform = process.platform) {
  return platform === "win32" ? value.replaceAll("\\", "/") : value;
}

// src/tools/file-patch.ts
var PATCH_BYTES = 1024 * 1024;
var SOURCE_BYTES = 16 * 1024 * 1024;
var STAGED_BYTES = 64 * 1024 * 1024;

// src/tools/write-changes.ts
import { homedir } from "os";

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
var clean = (text) => text.replaceAll("\r\n", "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "\uFFFD");
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
var within = (inside, api = pathFor()) => !!inside && inside !== ".." && !inside.startsWith(`..${api.sep}`) && !api.isAbsolute(inside);
function displayPath(path4, cwd, platform = process.platform) {
  const api = pathFor(platform);
  const inside = api.relative(cwd, path4);
  return slashPath(within(inside, api) ? inside : path4, platform);
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
function homeLabel(path4) {
  const home = homedir();
  const api = pathFor();
  const inside = home ? api.relative(home, path4) : "";
  return api.isAbsolute(path4) && within(inside, api) ? `~/${inside.split(api.sep).join("/")}` : void 0;
}
function buildWriteChanges(previous, changes, cwd) {
  const files = previous?.blocks.find((b) => b.id === "files" && b.kind === "files");
  const retention = previous?.blocks.find((b) => b.id === "retention" && b.kind === "key_value");
  let omitted = Number(retention?.entries.find((e) => e.key === omittedKey)?.value ?? 0) || 0;
  const byPath = new Map((files?.entries ?? []).map((e) => [e.path, { ...e }]));
  const put = (path4, status, label, change) => {
    if ([...path4].length > 500 || /[\u0000-\u001F\u007F]/.test(path4)) {
      omitted++;
      return;
    }
    const old = byPath.get(path4);
    byPath.delete(path4);
    const latest = change ? counts(change) : { added: 0, removed: 0 };
    const known = latest && (!old || old.added !== void 0);
    const reason = change && undiffable(change);
    const diff = change && !reason ? unifiedDiff(...sides(change), ENTRY_DIFF_BYTES) : void 0;
    const shownLabel = label ?? homeLabel(path4);
    byPath.set(path4, {
      path: path4,
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
import { open as open2, mkdir as mkdir2, writeFile, readFile as readFile2, stat } from "fs/promises";
import { dirname as dirname4 } from "path";

// src/tools/process.ts
import { spawn as spawn2 } from "child_process";
import { StringDecoder } from "string_decoder";

// src/platform/windows.ts
import { spawn, spawnSync } from "child_process";
import { createHash as createHash2, randomUUID as randomUUID3 } from "crypto";
import { existsSync as existsSync2, mkdirSync, readFileSync, renameSync, rmSync as rmSync2, statSync as statSync2, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import path3 from "path";

// src/package-root.ts
import { existsSync } from "fs";
import { dirname as dirname3, join as join3 } from "path";
import { fileURLToPath } from "url";

// src/platform/windows.ts
var win32 = path3.win32;

// src/tools/primitives.ts
var errorCode = (error, fallback) => {
  const code = error?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code) ? code : fallback;
};
var changeResult = (text, shown, changes, cwd, withDiff) => ({ isError: false, content: [{ type: "text", text }], host: { summary: shown, status: "ok", ...changeHostData(changes, cwd, withDiff) } });
function occurrences(source, needle) {
  const found = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}
function matchStarts(source, needle) {
  const found = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) found.push(at);
  return found;
}
function matchLines(source, starts) {
  const shown = [];
  let line = 1;
  let from = 0;
  let previous = 0;
  for (const at of starts) {
    for (let newline = source.indexOf(10, from); newline >= 0 && newline < at; newline = source.indexOf(10, newline + 1)) line++;
    from = at;
    if (line === previous) continue;
    previous = line;
    const begin = at === 0 ? 0 : source.lastIndexOf(10, at - 1) + 1;
    const end = source.indexOf(10, at);
    const text = source.subarray(begin, end < 0 ? source.length : end).toString("utf8").replace(/\r$/, "");
    shown.push(`${line}\u2502${[...text].slice(0, 200).join("")}`);
    if (shown.length === 3) break;
  }
  return `
Matching lines:
${shown.join("\n")}`;
}
function replaceAt(source, at, length, replacement) {
  const parts = [];
  let from = 0;
  for (const start of at) {
    parts.push(source.subarray(from, start), replacement);
    from = start + length;
  }
  parts.push(source.subarray(from));
  return Buffer.concat(parts);
}
function bigrams(text) {
  const grams = /* @__PURE__ */ new Map();
  for (let index = 0; index < text.length - 1; index++) {
    const gram = text.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}
function nearestLines(text, needle) {
  const target = needle.split("\n").map((line) => line.trim()).find(Boolean);
  const lines2 = text.split("\n");
  if (!target || target.length < 3 || lines2.length > 5e4) return "";
  const wanted = bigrams(target);
  const size = target.length - 1;
  const scored = lines2.map((line, index) => {
    const grams = bigrams(line.trim());
    let common = 0;
    for (const [gram, count] of grams) common += Math.min(count, wanted.get(gram) ?? 0);
    return { index, line, score: 2 * common / (size + Math.max(0, line.trim().length - 1) || 1) };
  }).filter((item) => item.score >= 0.5).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).sort((a, b) => a.index - b.index);
  return scored.length ? `
Nearest lines:
${scored.map((item) => `${item.index + 1}\u2502${[...item.line.replace(/\r$/, "")].slice(0, 200).join("")}`).join("\n")}` : "";
}
async function editFileTool(args, context) {
  const path4 = resolveToolPath(context.cwd, args.path);
  const shown = displayPath(path4, context.cwd);
  const failed = (code, message) => ({ ...errorResult(code, message), host: { summary: shown, status: "error" } });
  let source;
  try {
    source = await readFile2(path4);
  } catch (error) {
    const code = errorCode(error, "file_error");
    return failed(code, code === "ENOENT" ? `${shown} does not exist; create it with write_file` : `cannot read ${shown}: ${code}`);
  }
  if (source.subarray(0, 8192).includes(0)) return failed("binary_file", `${shown} is binary; edit_file changes text files`);
  let oldBytes = Buffer.from(args.old_string, "utf8");
  let newBytes = Buffer.from(args.new_string, "utf8");
  let found = occurrences(source, oldBytes);
  if (!found.length && args.old_string.includes("\n") && !args.old_string.includes("\r") && source.includes("\r\n")) {
    const crlf = Buffer.from(args.old_string.replace(/\n/g, "\r\n"), "utf8");
    const matches = occurrences(source, crlf);
    if (matches.length) {
      oldBytes = crlf;
      newBytes = Buffer.from(args.new_string.replace(/\r?\n/g, "\r\n"), "utf8");
      found = matches;
    }
  }
  const count = found.length;
  if (!count) return failed("edit_not_found", `old_string not found in ${shown}${nearestLines(source.toString("utf8"), args.old_string)}`);
  const starts = matchStarts(source, oldBytes);
  if (starts.length > 1 && !args.replace_all) {
    return failed("edit_not_unique", `old_string matches ${starts.length} times in ${shown}; add surrounding lines to make it unique or set replace_all` + matchLines(source, starts));
  }
  try {
    const after = replaceAt(source, found, oldBytes.length, newBytes);
    await writeFile(path4, after);
    const change = { path: path4, kind: "modified", before: source, after };
    await publishWriteChanges(context, [change]);
    const result = changeResult("", shown, [change], context.cwd, true);
    const file = result.host.files[0];
    const counts2 = file.added === void 0 ? "" : ` (+${file.added} \u2212${file.removed} lines)`;
    return { ...result, content: [{ type: "text", text: `Edited ${shown}: ${count} replacement${count === 1 ? "" : "s"}${counts2}` }] };
  } catch (error) {
    const code = errorCode(error, "write_error");
    return failed(code, `cannot write ${shown}: ${code}`);
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

// src/tools/bundled/edit_file/index.ts
var example = { path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" };
function normalizeArguments(input) {
  const args = { ...input };
  const notes = [];
  for (const alias of PATH_ALIASES) renameArgument(args, notes, alias, "path");
  for (const alias of ["old_str", "oldString", "old_text"]) renameArgument(args, notes, alias, "old_string");
  for (const alias of ["new_str", "newString", "new_text"]) renameArgument(args, notes, alias, "new_string");
  renameArgument(args, notes, "replaceAll", "replace_all");
  if (args.allow_multiple === true && args.replace_all === void 0) {
    args.replace_all = true;
    delete args.allow_multiple;
    notes.push("read allow_multiple as replace_all");
  } else if (args.allow_multiple === false) {
    delete args.allow_multiple;
    notes.push("read allow_multiple as replace_all");
  }
  return { args, notes };
}
function describeEffects(args, context) {
  return { files: [{ path: resolveToolPath(context.cwd, String(args.path)), operation: "edit" }] };
}
function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "arguments must be an object";
  const args = value;
  if (typeof args.path !== "string" || !args.path) return "path must be a nonempty string";
  if (typeof args.old_string !== "string" || !args.old_string) return "old_string must be the nonempty text to replace; create files with write_file";
  if (typeof args.new_string !== "string") return "new_string must be a string (empty deletes the match)";
  if (args.old_string === args.new_string) return "new_string must differ from old_string";
  if (args.replace_all !== void 0 && typeof args.replace_all !== "boolean") return "replace_all must be true or false";
  return void 0;
}
async function handler(args, context) {
  return editFileTool(args, context);
}
export {
  describeEffects,
  example,
  handler,
  normalizeArguments,
  validateArgs
};
