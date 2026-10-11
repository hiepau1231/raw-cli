import { constants as fsConstants } from "node:fs";
import { parseFilePatch, applyFilePatch } from "./file-patch.js";
import { MAX_DIFF_SOURCE_BYTES, publishWriteChanges } from "./write-changes.js";
import type { CommandActivity } from "../processes/presentation.js";
import type { ProcessContext } from "../processes/contract.js";
import type { InteractionContext } from "../interactions/contract.js";
import type { VariableContext } from "../vars/contract.js";
import { open, mkdir, writeFile, readFile, appendFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { runBash } from "./process.js";
import { elideMiddle, errorResult, indexedResult, indexedResultFits, utf8Prefix, type IndexedResult } from "./results.js";
import { savedLabel, spillText } from "./spill.js";
import type { ToolResult } from "./types.js";
import type { PanelContext } from "../panels/contract.js";
import type { ToolContentPanel } from "./types.js";
import type { SelectedSkill } from "../skills/contract.js";
import type { HookDispatchResult } from "../hooks/dispatcher.js";
import type { HookEventName } from "../hooks/contract.js";

export interface ToolApprovalRequest {
  identity: string;
  name: string;
  arguments: Record<string, unknown>;
  effects?: Readonly<Record<string, unknown>>;
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface ToolContext {
  /** Host accounting for actual successful builtin writes; never provider metadata. */
  onWriteCompleted?: () => void;
  commandActivity?: CommandActivity;
  interactions?: InteractionContext;
  processes?: ProcessContext;
  effects?: Readonly<Record<string, unknown>>;
  vars?: VariableContext;
  cwd: string;
  maxOutputBytes: number;
  autoApprove?: boolean;
  approve?: (request: ToolApprovalRequest) => boolean | Promise<boolean>;
  toolCallId?: string;
  onStart?: (name: string, args: Record<string, unknown>) => void;
  /** `raw` is the call as the model sent it, present only when normalization changed it. */
  onHook?: (event: HookEventName, identity: string, name: string, args: Record<string, unknown>,
    result?: ToolResult, effects?: Record<string, unknown>, raw?: Record<string, unknown>) => Promise<HookDispatchResult>;
  /** Host-only: the normalized arguments of a call whose normalization changed them (docs/tool-ux-design.md §4.3). */
  onNormalized?: (args: Record<string, unknown>, notes: readonly string[]) => void;
  whitelist?: readonly string[];
  signal?: AbortSignal;
  bashPath?: string;
  skills?: readonly SelectedSkill[];
  /** raw.panel/2 streaming API for the calling tool (docs/panels-design.md §8.2). Forwarded to plugin handlers. */
  panels?: PanelContext;
  /** Host-only: receives the panel blocks `ToolRegistry.dispatch` removes from a handler result. Never forwarded to plugins. */
  /** Host-only: the handler has returned (or thrown); no further streaming updates are accepted. */
  onHandlerSettled?: () => void;
  onPanelUpdates?: (updates: ToolContentPanel[]) => void;
}

export interface ReadFileSpec {
  path: string;
  start_line?: number;
  end_line?: number;
  max_lines?: number;
  max_bytes?: number;
}

function selectedHash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function readFileTool(args: { files: ReadFileSpec[] }, context: ToolContext): Promise<ToolResult> {
  const rows: IndexedResult[] = args.files.map((file, index) => ({ index, path: file.path, status: "budget_exhausted" }));
  if (!indexedResultFits(rows, context.maxOutputBytes)) return errorResult("output_budget_too_small", "read batch status exceeds output budget");
  const reserve = (index: number): IndexedResult => ({ index, path: args.files[index]!.path, status: "error", error: "x".repeat(160) });
  if (!indexedResultFits(rows.map((row, index) => index ? reserve(index) : row), context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "read batch outcomes exceed output budget");
  }
  const put = (index: number, candidate: IndexedResult): boolean => {
    const copy = [...rows];
    copy[index] = candidate;
    if (!indexedResultFits(copy.map((row, at) => at > index ? reserve(at) : row), context.maxOutputBytes)) return false;
    rows[index] = candidate;
    return true;
  };
  const itemFits = (file: ReadFileSpec, candidate: IndexedResult): boolean =>
    file.max_bytes === undefined || Buffer.byteLength(JSON.stringify(candidate), "utf8") <= file.max_bytes;
  for (const [index, file] of args.files.entries()) {
    if (context.signal?.aborted) { put(index, { index, path: file.path, status: "skipped", error: "aborted" }); continue; }
    const path = resolve(context.cwd, file.path);
    try {
      const handle = await open(path, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) { put(index, { index, path: file.path, status: "error", error: "not a regular file" }); continue; }
        const ranged = file.start_line !== undefined || file.end_line !== undefined || file.max_lines !== undefined;
        if (!ranged && stat.size <= Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes)) {
          const buffer = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead === stat.size) {
            const selected = buffer.subarray(0, bytesRead);
            const count = bytesRead === 0 ? 0 : selected.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0)
              + (selected[bytesRead - 1] === 10 ? 0 : 1);
            const candidate: IndexedResult = { index, path: file.path, status: "ok", text: selected.toString("utf8"),
              start_line: count ? 1 : 0, end_line: count, eof: true, sha256: selectedHash(selected) };
            if (itemFits(file, candidate) && put(index, candidate)) continue;
          }
        }
        const start = file.start_line ?? 1;
        const requestedEnd = file.end_line ?? (file.max_lines !== undefined ? start + file.max_lines - 1 : Infinity);
        const itemByteLimit = Math.min(file.max_bytes ?? Infinity, context.maxOutputBytes);
        const accepted: Buffer[] = [];
        let acceptedBytes = 0;
        let deferred: Buffer[] = [];
        let deferredBytes = 0;
        let actualEnd = start - 1;
        let currentLine = 1;
        let position = 0;
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let stopped = false;
        let budgetStop = false;
        let reachedEof = false;
        const acceptLine = (line: number): boolean => {
          const raw = Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          const nextBytes = Buffer.concat([...accepted, ...deferred, raw], acceptedBytes + deferredBytes + raw.length);
          const complete = line >= requestedEnd || position === stat.size;
          const candidate: IndexedResult = { index, path: file.path, status: complete ? "ok" : "partial", text: nextBytes.toString("utf8"),
            start_line: start, end_line: line, eof: position === stat.size,
            ...(!complete ? { next_line: line + 1 } : {}), sha256: selectedHash(nextBytes) };
          if (nextBytes.length > itemByteLimit) {
            budgetStop = true;
            stopped = true;
            return false;
          }
          const fits = itemFits(file, candidate) && indexedResultFits(rows.map((row, at) =>
            at === index ? candidate : at > index ? reserve(at) : row), context.maxOutputBytes);
          if (fits) {
            accepted.push(...deferred, raw);
            acceptedBytes += deferredBytes + raw.length;
            deferred = [];
            deferredBytes = 0;
            actualEnd = line;
          } else if (complete) {
            budgetStop = true;
            stopped = true;
            return false;
          } else {
            deferred.push(raw);
            deferredBytes += raw.length;
          }
          return true;
        };
        const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
        scan: for await (const rawChunk of stream) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          let cursor = 0;
          while (cursor < chunk.length) {
            const newline = chunk.indexOf(10, cursor);
            const end = newline < 0 ? chunk.length : newline + 1;
            const segment = chunk.subarray(cursor, end);
            position += segment.length;
            if (currentLine >= start) {
              pending.push(segment);
              pendingBytes += segment.length;
              if (acceptedBytes + deferredBytes + pendingBytes > itemByteLimit || acceptedBytes + deferredBytes + pendingBytes > context.maxOutputBytes) {
                budgetStop = true;
                stopped = true;
                break scan;
              }
            }
            cursor = end;
            if (newline < 0) continue;
            if (currentLine >= start && !acceptLine(currentLine)) break scan;
            if (currentLine >= requestedEnd) {
              reachedEof = position === stat.size;
              stopped = true;
              break scan;
            }
            currentLine++;
          }
        }
        if (!stopped) {
          if (pendingBytes > 0 && currentLine >= start) acceptLine(currentLine);
          reachedEof = !budgetStop;
        }
        const selected = Buffer.concat(accepted, acceptedBytes);
        const candidate: IndexedResult = budgetStop || deferredBytes
          ? { index, path: file.path, status: acceptedBytes ? "partial" : "line_too_large", text: selected.toString("utf8"),
            start_line: start, end_line: actualEnd, eof: false, next_line: actualEnd + 1,
            ...(acceptedBytes ? { sha256: selectedHash(selected) } : {}) }
          : { index, path: file.path, status: "ok", text: selected.toString("utf8"), start_line: start,
            end_line: actualEnd, eof: reachedEof, sha256: selectedHash(selected) };
        if (!itemFits(file, candidate) && candidate.status === "ok") {
          put(index, { index, path: file.path, status: "budget_exhausted" });
        } else {
          put(index, candidate);
        }
      } finally { await handle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      put(index, { index, path: file.path, status: "error", error: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "file_error" });
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => !["ok", "partial"].includes(row.status)));
}

export type WriteOperation =
  | { path: string; mode: "overwrite"; content: string }
  | { path: string; mode: "append"; content: string }
  | { path: string; mode: "replace_text"; old_text: string; new_text: string }
  | { path: string; mode: "replace_lines"; start_line: number; end_line: number; content: string; expected_sha256: string };

function selectedLineSpan(bytes: Buffer, startLine: number, endLine: number): { start: number; end: number } | undefined {
  let start = 0;
  let line = 1;
  let selectedStart = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    if (line === startLine) selectedStart = start;
    if (line === endLine) return { start: selectedStart, end };
    start = end;
    line++;
  }
  return undefined;
}

async function writeSnapshot(path: string): Promise<{ bytes?: Buffer; missing: boolean }> {
  let file;
  try {
    if (!(await stat(path)).isFile()) return { missing: false };
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return { missing: false };
    // One byte past the diff limit is enough to know the file is too large to diff.
    const bytes = Buffer.alloc(Math.min(info.size, MAX_DIFF_SOURCE_BYTES) + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return { bytes: bytes.subarray(0, filled), missing: false };
  } catch (error) { return { missing: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
  finally { await file?.close().catch(() => {}); }
}

export async function writeFileTool(args: { operations: WriteOperation[]; patch?: never } | { patch: string; operations?: never }, context: ToolContext): Promise<ToolResult> {
  if (typeof args.patch === "string") {
    try {
      return await applyFilePatch(parseFilePatch(args.patch, context.cwd), { maxOutputBytes: context.maxOutputBytes,
        ...(context.signal ? { signal: context.signal } : {}), onCompleted: change => publishWriteChanges(context, [change]) });
    } catch (error) { return errorResult("invalid_patch", error instanceof Error ? error.message : "invalid patch"); }
  }
  const rows: IndexedResult[] = args.operations.map((op, index) => ({ index, path: op.path, mode: op.mode, status: "error", error: "x".repeat(120) }));
  if (!indexedResultFits(rows, context.maxOutputBytes)) {
    return errorResult("output_budget_too_small", "write batch outcomes exceed output budget");
  }
  for (const [index, op] of args.operations.entries()) {
    if (context.signal?.aborted) {
      rows[index] = { index, path: op.path, mode: op.mode, status: "skipped", error: "aborted" };
      continue;
    }
    const path = resolve(context.cwd, op.path);
    try {
      const before = context.panels ? await writeSnapshot(path) : { missing: false };
      let bytesWritten = 0;
      if (op.mode === "overwrite" || op.mode === "append") {
        await mkdir(dirname(path), { recursive: true });
        if (op.mode === "overwrite") await writeFile(path, op.content, "utf8");
        else await appendFile(path, op.content, "utf8");
        bytesWritten = Buffer.byteLength(op.content);
      } else if (op.mode === "replace_text") {
        const source = await readFile(path);
        const oldBytes = Buffer.from(op.old_text, "utf8");
        const first = source.indexOf(oldBytes);
        if (first < 0) throw new Error("text_not_found");
        if (source.indexOf(oldBytes, first + 1) >= 0) throw new Error("text_not_unique");
        const replacement = Buffer.from(op.new_text, "utf8");
        await writeFile(path, Buffer.concat([source.subarray(0, first), replacement, source.subarray(first + oldBytes.length)]));
        bytesWritten = replacement.length;
      } else {
        const source = await readFile(path);
        const span = selectedLineSpan(source, op.start_line, op.end_line);
        if (!span) throw new Error("line_out_of_range");
        const { start, end } = span;
        if (selectedHash(source.subarray(start, end)) !== op.expected_sha256) throw new Error("guard_mismatch");
        let replacement = Buffer.from(op.content, "utf8");
        if (start === 0 && source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
          && !replacement.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
          replacement = Buffer.concat([source.subarray(0, 3), replacement]);
        }
        if (op.content.length && end < source.length && replacement[replacement.length - 1] !== 10) {
          const boundary = source[end - 1] === 10 ? (source[end - 2] === 13 ? Buffer.from("\r\n") : Buffer.from("\n")) : Buffer.from("\n");
          replacement = Buffer.concat([replacement, boundary]);
        }
        await writeFile(path, Buffer.concat([source.subarray(0, start), replacement, source.subarray(end)]));
        bytesWritten = replacement.length;
      }
      rows[index] = { index, path: op.path, mode: op.mode, status: "ok", bytes_written: bytesWritten };
      const after = context.panels ? await writeSnapshot(path) : { missing: false };
      await publishWriteChanges(context, [{ path, kind: before.missing ? "added" : "modified",
        ...(before.bytes ? { before: before.bytes } : !before.missing ? { beforeUnavailable: true } : {}),
        ...(after.bytes ? { after: after.bytes } : { afterUnavailable: true }) }]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      rows[index] = { index, path: op.path, mode: op.mode, status: "error", error: /^[A-Za-z0-9_]+$/.test(code) ? code : "write_error" };
    }
  }
  return indexedResult(rows, context.maxOutputBytes, rows.some((row) => row.status !== "ok"));
}

export const BASH_DEFAULT_TIMEOUT_MS = 120000;
export const BASH_MAX_TIMEOUT_MS = 600000;
/** Room kept beside the output for the status line and a clamp note. */
const BASH_STATUS_RESERVE = 256;
const BACKGROUND_IGNORED = "[ignored run_in_background: background jobs need the process tool; ran in the foreground]";

export interface BashArgs { command: string; timeout?: number; description?: string; workdir?: string; run_in_background?: boolean;
  env_refs?: Record<string, string> }

function seconds(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

/**
 * One Bash command (docs/tool-ux-design.md §4.2): the output in production order, then one status line such as
 * `[exit 0 · 1.2s]`. A nonzero exit is not an error; a timeout or abort is, and stops the process group.
 */
export async function bashTool(args: BashArgs, context: ToolContext): Promise<ToolResult> {
  const cwd = args.workdir === undefined ? context.cwd : resolve(context.cwd, args.workdir);
  const requested = args.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(requested, BASH_MAX_TIMEOUT_MS);
  const summary = utf8Prefix(args.command.split("\n", 1)[0]!, 200).text;
  const host = (status: NonNullable<NonNullable<ToolResult["host"]>["status"]>, extra: NonNullable<ToolResult["host"]> = {}): NonNullable<ToolResult["host"]> =>
    ({ summary, status, ...(args.description ? { description: args.description } : {}), ...extra });
  let bindings: Record<string, string> | undefined;
  if (args.env_refs && Object.keys(args.env_refs).length) {
    if (!context.vars) return { ...errorResult("vars_unavailable", "variable services are unavailable"), host: host("error") };
    try {
      context.vars.validateEnvRefs(args.env_refs);
      bindings = await context.vars.resolveEnv(args.env_refs, { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "var_env_refs_invalid";
      return { ...errorResult(code, error instanceof Error ? error.message : "invalid variable references"), host: host("error") };
    }
  }
  let activity: ReturnType<CommandActivity["begin"]> | undefined;
  try { activity = context.commandActivity?.begin(args.command, cwd); } catch { /* UI persistence cannot change Bash execution. */ }
  const started = performance.now();
  let result: ToolResult;
  try {
    result = await runBash({ command: args.command, cwd, maxOutputBytes: Math.max(0, context.maxOutputBytes - BASH_STATUS_RESERVE),
      timeoutMs: timeout,
      ...(activity ? { onOutput: activity.output } : {}),
      ...(bindings ? { env: { ...process.env, ...bindings } } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.bashPath ? { bashPath: context.bashPath } : {}),
    });
  } catch (error) {
    result = errorResult("bash_error", (error as Error).message);
  }
  try { activity?.finish(result); } catch { /* UI persistence cannot change the completed Bash outcome. */ }
  const durationMs = Math.round(performance.now() - started);
  if (result.code === "bash_spawn_error" || result.code === "bash_error") return { ...result, host: host("error", { durationMs }) };
  const aborted = result.code === "aborted" || context.signal?.aborted === true;
  const status = aborted ? `[aborted after ${seconds(durationMs)}; process group stopped]`
    : result.timedOut ? `[timed out after ${timeout / 1000}s; process group stopped]`
      : result.exitCode === null || result.exitCode === undefined ? `[killed by ${result.signal ?? "signal"} · ${seconds(durationMs)}]`
        : `[exit ${result.exitCode} · ${seconds(durationMs)}]`;
  // Reached with run_in_background only when the call was not handed to the process tool.
  const notes = [...(requested > BASH_MAX_TIMEOUT_MS ? [`[timeout clamped to ${BASH_MAX_TIMEOUT_MS} ms]`] : []),
    ...(args.run_in_background === true ? [BACKGROUND_IGNORED] : [])];
  return { ...result, content: [...result.content, { type: "text", text: [status, ...notes].join("\n") }],
    host: host(aborted ? "cancelled" : result.timedOut ? "timeout" : "ok", { durationMs,
      exitCode: result.exitCode ?? null, signal: result.signal ?? null,
      ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath, ...(result.fullOutputCapped ? { fullOutputCapped: true } : {}) } : {}) }) };
}
