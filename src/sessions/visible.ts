import { callSummary, callTitle, displayArguments, isMcpIdentity, type ToolDisplay, type ToolKind, type ToolResultType } from "../tools/display.js";
import { reduceJson } from "../tools/results.js";
import type { HostData, ToolResult } from "../tools/types.js";

/**
 * The display record of a call (docs/tool-ux-design.md §5.4). Title, kind and summary are projected once from the hints
 * and persisted, so replay shows them even when the tool is no longer selected. Old records lack them.
 */
export interface VisibleToolCall {
  id?: string;
  name: string;
  identity?: string;
  started: boolean;
  /** Content-free for the bundled file tools: paths and sizes, never file contents. */
  arguments: Record<string, unknown>;
  title?: string;
  kind?: ToolKind;
  summary?: string;
  icon?: string;
  result?: ToolResultType;
}
export interface PreviewSegment {
  kind: "text" | "markdown" | "json" | "code" | "image";
  text: string;
  path?: string;
  language?: string;
}
/** Exactly one per result (§5.3): `exit` is a nonzero exit code, `denied` a policy, hook or approval refusal. */
export type ToolStatus = "ok" | "error" | "exit" | "timeout" | "cancelled" | "denied";
export interface VisibleToolResult {
  id?: string;
  name: string;
  identity?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  resultType?: ToolResultType;
  failed: boolean;
  code?: string;
  exitCode?: number | null;
  truncated: boolean;
  durationMs?: number;
  /** Line-safe preview: whole lines, head and tail; JSON comes pretty-printed from its value-safe form. */
  segments: PreviewSegment[];
  /** The preview hides lines, cuts a long line or shows a reduced JSON value. */
  abbreviated?: boolean;
  /** Each JSON block of the result as a value-safe reduction, always valid JSON (for the dashboard tree). */
  json?: unknown[];
  /** The result's host data (docs/tool-ux-design.md §4.5), kept with the durable history record. */
  host?: HostData;
}

const PREVIEW_LINES = 9;
const LINE_CHARS = 220;
const JSON_PREVIEW_BYTES = 1500;
const DENIED = new Set(["denied", "approval_denied", "approval_required", "hook_denied", "tool_denied"]);
const CANCELLED = new Set(["aborted", "cancelled", "interaction_cancelled", "interaction_interrupted"]);
const MARKDOWN = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|> )/;

export function projectToolCall(name: string, identity: string | undefined, args: Record<string, unknown>, started: boolean,
  display?: ToolDisplay): VisibleToolCall {
  const shown = displayArguments(identity, args);
  return { name, ...(identity ? { identity } : {}), started, arguments: shown,
    title: callTitle(name, shown, display), kind: display?.kind ?? "other", summary: callSummary(shown, display),
    ...(display?.icon ? { icon: display.icon } : {}), ...(display?.result ? { result: display.result } : {}) };
}

/** At most nine whole lines, the first and last four around a marker; a line longer than 220 characters ends in `…`. */
function bounded(lines: PreviewSegment[]): PreviewSegment[] {
  const capped = lines.map((line) => [...line.text].length <= LINE_CHARS ? line
    : { ...line, text: `${[...line.text].slice(0, LINE_CHARS - 1).join("")}…` });
  return capped.length <= PREVIEW_LINES ? capped
    : [...capped.slice(0, 4), { kind: "text", text: `… [${capped.length - 8} lines hidden] …` }, ...capped.slice(-4)];
}

function addLines(lines: PreviewSegment[], kind: PreviewSegment["kind"], value: string, path?: string): void {
  if (!value) return;
  for (const line of value.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")) {
    lines.push({ kind, text: line, ...(path ? { path } : {}) });
  }
}

export function toolStatus(result: Pick<ToolResult, "isError" | "code" | "exitCode" | "timedOut" | "host">): ToolStatus {
  const exitCode = result.exitCode ?? result.host?.exitCode;
  if (result.code && DENIED.has(result.code)) return "denied";
  if (result.host?.status === "timeout" || result.timedOut || /timeout|timed_out/.test(result.code ?? "")) return "timeout";
  if (result.host?.status === "cancelled" || (result.code && CANCELLED.has(result.code))) return "cancelled";
  if (result.isError) return "error";
  return typeof exitCode === "number" && exitCode !== 0 ? "exit" : "ok";
}

export function projectToolResult(name: string, identity: string | undefined, result: ToolResult, durationMs?: number,
  display?: ToolDisplay): VisibleToolResult {
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  const resultType: ToolResultType = display?.result
    ?? (result.content.length && result.content.every((block) => block.type === "json") ? "json"
      : isMcpIdentity(identity) && MARKDOWN.test(text) ? "markdown" : "text");
  const lines: PreviewSegment[] = [];
  const json: unknown[] = [];
  const jsonBlocks: unknown[] = [];
  // A code result tagged with a path (read_file) stays path-tagged code: gutter lines become code, the footer stays text.
  // Any other code result is code line by line, path-tagged when the result names its file.
  const code = resultType === "code" && !result.isError;
  const codePath = code ? result.host?.path : undefined;
  for (const block of result.content) {
    if (block.type === "text" && code && !block.channel) {
      const split = block.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      const numbered = split.some((line) => /^ *\d+│/.test(line));
      for (const line of split) {
        const gutter = numbered ? /^ *\d+│(.*)$/.exec(line) : undefined;
        const text = numbered ? gutter?.[1] : line;
        lines.push(text !== undefined ? { kind: "code", text, ...(codePath ? { path: codePath } : {}) } : { kind: "text", text: line });
      }
    } else if (block.type === "text") {
      addLines(lines, resultType === "markdown" && !block.channel ? "markdown" : "text", block.channel ? `[${block.channel}]\n${block.text}` : block.text);
    } else if (block.type === "image") {
      addLines(lines, "image", `[${block.mimeType} image, ${block.byteSize ?? Buffer.from(block.data, "base64").length} bytes]`);
    } else {
      jsonBlocks.push(block.value);
      json.push(reduceJson(block.value, JSON_PREVIEW_BYTES) ?? null);
    }
  }
  const preview = bounded(lines);
  let abbreviated = preview.length !== lines.length || preview.some((line, index) => line !== lines[index]);
  // JSON is never cut as text: each block is pretty-printed whole from its value-safe reduction.
  for (const [index, value] of json.entries()) {
    addLines(preview, "json", JSON.stringify(value, null, 2));
    abbreviated ||= value !== jsonBlocks[index];
  }
  const exitCode = result.exitCode ?? result.host?.exitCode;
  const status = toolStatus(result);
  return { name, ...(identity ? { identity } : {}), kind: display?.kind ?? "other",
    status, resultType, failed: status !== "ok",
    ...(result.code ? { code: result.code } : {}), ...(exitCode !== undefined ? { exitCode } : {}),
    truncated: result.truncated ?? false,
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    segments: preview, ...(abbreviated ? { abbreviated } : {}), ...(json.length ? { json } : {}), ...(result.host ? { host: structuredClone(result.host) } : {}) };
}

/** The one status word of a result, for old records too: ok, error, exit N, timed out, cancelled or denied. */
export function statusLabel(result: Pick<VisibleToolResult, "status" | "failed" | "exitCode">): string {
  const status = result.status ?? (!result.failed ? "ok" : typeof result.exitCode === "number" && result.exitCode !== 0 ? "exit" : "error");
  return status === "exit" ? `exit ${String(result.exitCode)}` : status === "timeout" ? "timed out" : status;
}

export function renderPlainToolResult(result: VisibleToolResult): string {
  return result.segments.map((segment) => segment.text).join("\n");
}
