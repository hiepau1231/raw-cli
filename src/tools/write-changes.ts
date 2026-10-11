import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { PANEL_LIMITS, type FileEntry, type PanelDocument } from "../panels/contract.js";
import { lineCounts, unifiedDiff } from "./line-diff.js";
import type { CompletedPatchChange } from "./file-patch.js";
import type { ToolContext } from "./primitives.js";
import type { HostData, HostFileChange } from "./types.js";

/** The host owner of the one files-changed panel the editing tools share (docs/tool-ux-design.md §6.3). */
export const FILES_CHANGED_OWNER = "host/files_changed";
/** Bundled tools that publish to it; local copies and package tools with these names keep their own identity. */
export const FILE_EDITING_TOOLS: ReadonlySet<string> = new Set(["builtin/write_file", "builtin/edit_file", "builtin/apply_patch"]);
/** Bound of the unified diff a result carries in host data. */
export const HOST_DIFF_BYTES = 64 * 1024;
/** Bound of the latest diff one panel entry keeps; older entries lose theirs first when the document is full. */
const ENTRY_DIFF_BYTES = 8 * 1024;

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "�");
export type CompletedWriteChange = CompletedPatchChange & { beforeUnavailable?: boolean; afterUnavailable?: boolean;
  /** The before snapshot holds only a prefix of the file, enough to know it is too large to diff. */ beforePartial?: boolean;
  /** write_file: whether the file existed before. */ overwritten?: boolean };
const omittedKey = "Omitted history entries";
/** Larger files are reported by size; the write snapshot reads one byte more to detect them. */
export const MAX_DIFF_SOURCE_BYTES = 8 * 1024 * 1024;

/** Why a change has no line diff: too large or binary; undefined when both sides are diffable text. */
function undiffable(change: CompletedWriteChange): string | undefined {
  const sides = [change.before, change.after];
  // A write snapshot stops one byte past the limit, so a longer side is only known to be larger than it.
  const size = (bytes: Buffer | undefined) => (bytes?.length ?? 0) > MAX_DIFF_SOURCE_BYTES ? `more than ${MAX_DIFF_SOURCE_BYTES}` : String(bytes?.length ?? 0);
  if (change.beforeUnavailable || change.afterUnavailable) return "[diff unavailable: file bytes could not be read]";
  if (sides.some((bytes) => bytes && bytes.length > MAX_DIFF_SOURCE_BYTES)) return `[file too large to diff: ${size(change.before)} → ${size(change.after)} bytes]`;
  if (sides.some((bytes) => bytes?.subarray(0, 8192).includes(0))) return `[binary content: ${size(change.before)} → ${size(change.after)} bytes]`;
  return undefined;
}

const sides = (change: CompletedWriteChange) => [clean(change.before?.toString("utf8") ?? ""), clean(change.after?.toString("utf8") ?? "")] as const;

/**
 * Complete line counts of a change: from the whole, unsanitized before and after content, never from a bounded preview,
 * so a file too large to preview still has counts. Unknown when a side is unavailable, partial or binary.
 */
function counts(change: CompletedWriteChange): { added: number; removed: number } | undefined {
  if (change.beforeUnavailable || change.afterUnavailable || change.beforePartial) return undefined;
  if ([change.before, change.after].some((bytes) => bytes?.subarray(0, 8192).includes(0))) return undefined;
  return lineCounts(change.before?.toString("utf8") ?? "", change.after?.toString("utf8") ?? "");
}

/** Whether `inside`, a path relative to some root, stays under it; a name such as `..config` does. */
const within = (inside: string) => !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);

/** A path as the session sees it: relative inside the cwd, absolute outside it. */
export function displayPath(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  return within(inside) ? inside : path;
}

/** The host data of completed changes (docs/tool-ux-design.md §4.5): one entry per file and, if asked, a bounded diff. */
export function changeHostData(changes: readonly CompletedWriteChange[], cwd: string, withDiff: boolean): Pick<HostData, "files" | "diff" | "diffOmitted"> {
  const files = changes.map((change): HostFileChange => {
    const action = change.kind === "added" ? "create" : change.kind === "deleted" ? "delete" : change.kind === "renamed" ? "rename"
      : change.overwritten ? "overwrite" : "edit";
    const shown = displayPath(change.oldPath ?? change.path, cwd);
    return { path: shown, action, ...counts(change), ...(change.oldPath ? { destination: displayPath(change.path, cwd) } : {}) };
  });
  if (!withDiff) return { files };
  const parts = changes.map((change) => {
    const from = displayPath(change.oldPath ?? change.path, cwd);
    const to = displayPath(change.path, cwd);
    const reason = undiffable(change);
    const body = reason ?? unifiedDiff(...sides(change), HOST_DIFF_BYTES + 1).text;
    return `--- ${change.kind === "added" ? "/dev/null" : `a/${from}`}\n+++ ${change.kind === "deleted" ? "/dev/null" : `b/${to}`}\n${body}`;
  });
  const diff = parts.join("\n");
  return Buffer.byteLength(diff) <= HOST_DIFF_BYTES ? { files, diff } : { files, diffOmitted: true };
}

/** A path outside the cwd as people read it: `~/…` under the home directory; undefined when the path is shown as is. */
function homeLabel(path: string): string | undefined {
  const home = homedir();
  const inside = home ? relative(home, path) : "";
  return isAbsolute(path) && within(inside) ? `~/${inside.split(sep).join("/")}` : undefined;
}

/**
 * Bounded, persisted history of tool writes; it deliberately does not inspect Git or the workspace. Entry paths are relative
 * to the session cwd, the form an `@` reference inserts; a path outside it stays absolute, labeled `~/…` under the home
 * directory (docs/tool-ux-design.md §6.3).
 */
export function buildWriteChanges(previous: PanelDocument | undefined, changes: readonly CompletedWriteChange[], cwd: string): PanelDocument {
  const files = previous?.blocks.find(b => b.id === "files" && b.kind === "files") as { entries: FileEntry[] } | undefined;
  const retention = previous?.blocks.find(b => b.id === "retention" && b.kind === "key_value") as { entries: Array<{key: string; value: string}> } | undefined;
  let omitted = Number(retention?.entries.find(e => e.key === omittedKey)?.value ?? 0) || 0;
  const byPath = new Map((files?.entries ?? []).map(e => [e.path, { ...e }]));
  const put = (path: string, status: FileEntry["status"], label?: string, change?: CompletedWriteChange) => {
    if ([...path].length > 500 || /[\u0000-\u001F\u007F]/.test(path)) { omitted++; return; }
    const old = byPath.get(path);
    byPath.delete(path);
    // Counts accumulate over the session's writes to the path; the diff is the latest one. A rename source moves no
    // lines. Once one write's counts are unknown, the total is unknown and stays omitted.
    const latest = change ? counts(change) : { added: 0, removed: 0 };
    const known = latest && (!old || old.added !== undefined);
    // The latest diff, or why there is none, so that every row of a change expands to something.
    const reason = change && undiffable(change);
    const diff = change && !reason ? unifiedDiff(...sides(change), ENTRY_DIFF_BYTES) : undefined;
    const shownLabel = label ?? homeLabel(path);
    byPath.set(path, { path, status: status === "modified" && old?.status === "added" ? "added" : status!,
      ...(shownLabel ? { label: [...clean(shownLabel)].slice(0, 200).join("") } : {}),
      ...(known ? { added: (old?.added ?? 0) + latest.added, removed: (old?.removed ?? 0) + latest.removed } : {}),
      ...(reason ? { diff: reason } : diff?.text ? { diff: diff.text + (diff.truncated ? "\n[diff truncated]" : "") } : {}) });
  };
  for (const change of changes) {
    const to = displayPath(change.path, cwd);
    if (change.kind === "renamed" && change.oldPath) {
      const from = displayPath(change.oldPath, cwd);
      const label = `${homeLabel(from) ?? from} → ${homeLabel(to) ?? to}`;
      put(from, "deleted", label);
      put(to, "added", label, change);
    } else put(to, change.kind === "deleted" ? "deleted" : change.kind === "added" ? "added" : "modified", undefined, change);
  }
  while (byPath.size > 200) { byPath.delete(byPath.keys().next().value!); omitted++; }
  const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
  const doc = (): PanelDocument => {
    const shown = [...byPath.values()];
    // The header total is only honest when every file's counts are known.
    const totals = shown.length && shown.every(entry => entry.added !== undefined && entry.removed !== undefined)
      ? ` · +${shown.reduce((sum, entry) => sum + entry.added!, 0)} −${shown.reduce((sum, entry) => sum + entry.removed!, 0)}` : "";
    return { title: "Files changed",
      subtitle: "Successful tool writes in this session; not Git status or Bash edits.",
      summary: `${fileCount(shown.length)}${totals}`,
      context_summary: `${byPath.size} successful tool-write paths retained; ${omitted} history entries omitted.`,
      blocks: [{ id: "files", kind: "files", entries: shown },
        ...(omitted ? [{ id: "retention", kind: "key_value" as const, entries: [{ key: omittedKey, value: String(omitted) }] }] : [])] };
  };
  let document = doc();
  // Older entries lose their diff before any entry is dropped.
  for (const entry of byPath.values()) {
    if (Buffer.byteLength(JSON.stringify(document)) <= PANEL_LIMITS.documentBytes) break;
    if (entry.diff !== undefined) { delete entry.diff; document = doc(); }
  }
  while (Buffer.byteLength(JSON.stringify(document)) > PANEL_LIMITS.documentBytes && byPath.size) {
    byPath.delete(byPath.keys().next().value!); omitted++; document = doc();
  }
  return document;
}

/** Publication is secondary to completed I/O and must never turn success into a write error. */
export async function publishWriteChanges(context: ToolContext, changes: readonly CompletedWriteChange[]): Promise<void> {
  if (!changes.length) return;
  try { context.onWriteCompleted?.(); } catch { /* host accounting cannot affect completed I/O */ }
  if (!context.panels) return;
  try {
    const previous = context.panels.get("files_changed")?.document;
    await context.panels.update("files_changed", { op: "replace", document: buildWriteChanges(previous, changes, context.cwd) });
  } catch { /* a full/closed panel does not undo filesystem changes */ }
}
