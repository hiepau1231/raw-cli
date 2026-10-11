import { parseFilePatch } from "../tools/file-patch.js";
import type { HostData, ToolResult } from "../tools/types.js";

export interface VisibleToolCall {
  id?: string;
  name: string;
  identity?: string;
  started: boolean;
  arguments: Record<string, unknown>;
}
export interface PreviewSegment {
  kind: "text" | "json" | "code" | "image";
  text: string;
  path?: string;
  language?: string;
}
export interface VisibleBatchRow { index: number; status: string; exitCode?: number; path?: string }
export interface VisibleToolResult {
  id?: string;
  name: string;
  identity?: string;
  failed: boolean;
  code?: string;
  exitCode?: number | null;
  truncated: boolean;
  durationMs?: number;
  rows: VisibleBatchRow[];
  segments: PreviewSegment[];
  /** The result's host data (docs/tool-ux-design.md §4.5), kept with the durable history record. */
  host?: HostData;
}

const PREVIEW_CHARS = 2000;
const PREVIEW_LINES = 9;


/** The first string among a canonical argument name and the aliases other harnesses send (src/tools/normalize.ts). */
const pick = (args: Record<string, unknown>, names: readonly string[]) => names.map(name => args[name]).find(value => typeof value === "string") as string | undefined;
const PATH_NAMES = ["path", "file_path", "filePath", "absolute_path"];

export function projectToolCall(name: string, identity: string | undefined, args: Record<string, unknown>, started: boolean): VisibleToolCall {
  // File contents never enter the visible record: only paths and sizes. Arguments may still carry aliases, and any other
  // shape (an old batch, a typo) shows only its keys so a rejected call cannot print its payload.
  const bytes = (value: string | undefined) => value === undefined ? undefined : Buffer.byteLength(value, "utf8");
  const path = pick(args, PATH_NAMES);
  if (identity === "builtin/write_file") {
    const content = pick(args, ["content", "file_text", "text", "contents"]);
    if (content !== undefined) return { name, identity, started, arguments: { path, content_bytes: bytes(content) } };
  } else if (identity === "builtin/edit_file") {
    const oldString = pick(args, ["old_string", "old_str", "oldString", "old_text"]);
    const newString = pick(args, ["new_string", "new_str", "newString", "new_text"]);
    const all = [args.replace_all, args.replaceAll, args.allow_multiple].find(value => typeof value === "boolean");
    if (oldString !== undefined || newString !== undefined) return { name, identity, started, arguments: { path,
      old_string_bytes: bytes(oldString), new_string_bytes: bytes(newString), ...(all !== undefined ? { replace_all: all } : {}) } };
  } else if (identity === "builtin/apply_patch") {
    const patch = pick(args, ["patch", "input"]);
    if (patch !== undefined) {
      let paths: string[] = [];
      try { paths = parseFilePatch(patch, "/").changes.map(change => change.rawDestination ? `${change.rawPath} → ${change.rawDestination}` : change.rawPath); } catch { /* invalid patch still gets a content-free summary */ }
      return { name, identity, started, arguments: { patch_bytes: Buffer.byteLength(patch), patch_paths: paths } };
    }
  } else return { name, ...(identity ? { identity } : {}), started, arguments: structuredClone(args) };
  return { name, identity, started, arguments: { argument_keys: Object.keys(args) } };
}

function bounded(lines: PreviewSegment[]): PreviewSegment[] {
  const limited = lines.length > PREVIEW_LINES
    ? [...lines.slice(0, 4), { kind: "text" as const, text: "… [middle lines hidden] …" }, ...lines.slice(-4)] : lines;
  const bodyCap = PREVIEW_CHARS - (PREVIEW_LINES - 1);
  const count = limited.reduce((sum, line) => sum + [...line.text].length, 0);
  if (count <= bodyCap) return limited;
  const marker = "… [middle characters hidden] …";
  const allowance = bodyCap - [...marker].length;
  const head: PreviewSegment[] = [];
  const tail: PreviewSegment[] = [];
  let remaining = Math.ceil(allowance / 2);
  for (const line of limited) {
    if (remaining <= 0 || head.length >= 4) break;
    const chars = [...line.text];
    const take = Math.min(chars.length, remaining);
    head.push({ ...line, text: chars.slice(0, take).join("") });
    remaining -= take;
  }
  remaining = Math.floor(allowance / 2);
  for (const line of [...limited].reverse()) {
    if (remaining <= 0 || tail.length >= 4) break;
    const chars = [...line.text];
    const take = Math.min(chars.length, remaining);
    tail.unshift({ ...line, text: chars.slice(-take).join("") });
    remaining -= take;
  }
  return [...head, { kind: "text" as const, text: marker }, ...tail];
}

function addLines(lines: PreviewSegment[], kind: PreviewSegment["kind"], value: string, path?: string): void {
  if (!value) return;
  for (const line of value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")) {
    lines.push({ kind, text: line, ...(path ? { path } : {}) });
  }
}

export function projectToolResult(name: string, identity: string | undefined, result: ToolResult, durationMs?: number): VisibleToolResult {
  const rows: VisibleBatchRow[] = [];
  const lines: PreviewSegment[] = [];
  // A read window stays path-tagged code for highlighting: gutter lines become code, the range footer stays text.
  const readPath = identity === "builtin/read_file" && !result.isError ? result.host?.path : undefined;
  for (const block of result.content) {
    if (block.type === "text" && readPath) {
      for (const line of block.text.replace(/\n+$/, "").split("\n")) {
        const gutter = /^ *\d+│(.*)$/.exec(line);
        lines.push(gutter ? { kind: "code", text: gutter[1]!.replace(/\r$/, ""), path: readPath } : { kind: "text", text: line });
      }
      continue;
    }
    if (block.type === "text") {
      addLines(lines, "text", block.channel ? `[${block.channel}]\n${block.text}` : block.text);
      continue;
    }
    if (block.type === "image") {
      addLines(lines, "image", `[${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes]`);
      continue;
    }
    addLines(lines, "json", JSON.stringify(block.value));
  }
  const exitCode = result.exitCode ?? result.host?.exitCode;
  return { name, ...(identity ? { identity } : {}), failed: result.isError
      || (typeof exitCode === "number" && exitCode !== 0)
      || rows.some((row) => row.status !== "ok"),
    ...(result.code ? { code: result.code } : {}), ...(exitCode !== undefined ? { exitCode } : {}),
    truncated: result.truncated ?? false,
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    rows, segments: bounded(lines), ...(result.host ? { host: structuredClone(result.host) } : {}) };
}

export function renderPlainToolResult(result: VisibleToolResult): string {
  const statuses = result.rows.length ? `statuses: ${result.rows.map((row) =>
    `${row.index}:${row.status}${row.exitCode === undefined ? "" : `(exit${row.exitCode})`}`).join(" ")}` : "";
  return [statuses, ...result.segments.map((segment) => segment.text)].filter(Boolean).join("\n");
}
