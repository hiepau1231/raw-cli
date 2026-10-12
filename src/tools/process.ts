import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolResult } from "./types.js";
import { errorResult, utf8Prefix, utf8Suffix } from "./results.js";
import { OutputSpill, savedLabel } from "./spill.js";

type Channel = "stdout" | "stderr";
interface Segment { channel?: Channel; text: string }

/**
 * Output in the order it was produced: the start of the stream and a rolling window of its end, each piece tagged with
 * its channel. The middle of an oversized stream is dropped.
 */
class OrderedCapture {
  private head: Segment[] = [];
  private headBytes = 0;
  private tail: Segment[] = [];
  private tailBytes = 0;
  total = 0;
  dropped = false;
  constructor(private readonly headCap: number, private readonly tailCap: number) {}
  push(channel: Channel, text: string): void {
    if (!text) return;
    this.total += Buffer.byteLength(text);
    let rest = text;
    // Once anything reaches the tail the head is closed, so later output never moves ahead of earlier output.
    if (!this.tail.length && this.headBytes < this.headCap) {
      const prefix = utf8Prefix(rest, this.headCap - this.headBytes);
      if (prefix.text) this.head.push({ channel, text: prefix.text });
      this.headBytes += prefix.bytes;
      rest = rest.slice(prefix.text.length);
      if (!rest) return;
    }
    this.tail.push({ channel, text: rest });
    this.tailBytes += Buffer.byteLength(rest);
    while (this.tail.length > 1 && this.tailBytes - Buffer.byteLength(this.tail[0]!.text) >= this.tailCap) {
      this.tailBytes -= Buffer.byteLength(this.tail.shift()!.text);
      this.dropped = true;
    }
  }
  /** Everything when nothing was dropped and it fits; otherwise start + marker + end within `limit`. */
  render(limit: number, fullOutputPath?: string): { segments: Segment[]; truncated: boolean } {
    const all = [...this.head, ...this.tail];
    if (!this.dropped && this.total <= limit) return { segments: merge(all), truncated: false };
    const marker = (omitted: number) => `\n…[${omitted} bytes omitted${fullOutputPath ? `; full output: ${fullOutputPath}` : ""}]…\n`;
    const room = limit - Buffer.byteLength(marker(this.total));
    if (room <= 0) return { segments: merge(take(all, limit)), truncated: true };
    const start = take(all, Math.floor(room / 5));
    const startBytes = start.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    const end = takeEnd(this.dropped ? this.tail : all, room - startBytes);
    const endBytes = end.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    return { segments: merge([...start, { text: marker(this.total - startBytes - endBytes) }, ...end]), truncated: true };
  }
}

function take(segments: readonly Segment[], limit: number): Segment[] {
  const kept: Segment[] = [];
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

function takeEnd(segments: readonly Segment[], limit: number): Segment[] {
  const kept: Segment[] = [];
  let remaining = limit;
  for (let index = segments.length - 1; index >= 0 && remaining > 0; index--) {
    const suffix = utf8Suffix(segments[index]!.text, remaining);
    if (suffix.text) kept.unshift({ ...segments[index]!, text: suffix.text });
    remaining -= suffix.bytes;
    if (suffix.truncated) break;
  }
  return kept;
}

/** Adjacent pieces of one channel become one block. */
function merge(segments: readonly Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && last.channel === segment.channel) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

export interface BashOptions {
  onOutput?: (channel: "stdout" | "stderr", text: string) => void;
  env?: NodeJS.ProcessEnv;
  command: string;
  cwd: string;
  maxOutputBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  bashPath?: string;
}

/** Shared shell spawn/group primitive; lifecycle and output policy belong to its caller. */
export function spawnShell(options: { command: string; cwd: string; env?: NodeJS.ProcessEnv; bashPath?: string }, platform: NodeJS.Platform = process.platform) {
  return spawn(options.bashPath ?? process.env.RAW_BASH_PATH ?? "bash", ["-c", options.command], {
    cwd: options.cwd, ...(options.env ? { env: options.env } : {}), stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true,
  });
}
export function signalShellGroup(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  try { if (child.pid) process.kill(platform !== "win32" ? -child.pid : child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/**
 * Runs one command in its own process group. The result holds the output in production order, each text block tagged
 * with its channel; an oversized stream keeps its start and end around a marker naming the saved complete copy.
 */
export async function runBash(options: BashOptions): Promise<ToolResult> {
  if (options.signal?.aborted) return errorResult("aborted", "bash aborted before execution");
  const timeoutMs = options.timeoutMs ?? 120000;
  const child = spawnShell(options);
  let observedBytes = 0;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;
  const max = Math.max(0, options.maxOutputBytes);
  const capture = new OrderedCapture(Math.floor(max / 5), max);
  // Output stays in memory until it exceeds the budget; from then on the complete stream is saved for the model to read.
  let pending: Buffer[] = [];
  let spill: OutputSpill | undefined;
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let killTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let reapTimer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let resolveCancelled!: () => void;
  const cancellationWatchdog = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  let escalation: Promise<void> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => signalShellGroup(child, signal);
  const stop = (reason: "abort" | "timeout") => {
    if (aborted || timedOut) return;
    if (reason === "abort") aborted = true;
    else timedOut = true;
    signalGroup("SIGTERM");
    escalation = new Promise<void>((resolve) => {
      killTimer = setTimeout(() => { signalGroup("SIGKILL"); resolve(); }, 500);
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
  const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
    observedBytes += chunk.length;
    const text = (channel === "stdout" ? outDecoder : errDecoder).write(chunk);
    try { options.onOutput?.(channel, text); } catch { /* observers never own execution */ }
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
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  let exited: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  const exitedPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => { exited = { code, signal }; resolve(); });
  });
  const closedPromise = new Promise<void>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", () => resolve());
  });
  const outcome = await Promise.race([closedPromise.then(() => "closed" as const), cancellationWatchdog.then(() => "watchdog" as const)]);
  if (outcome === "watchdog") {
    await Promise.race([exitedPromise, new Promise<void>((resolve) => { reapTimer = setTimeout(resolve, 1300); })]);
    if (reapTimer) clearTimeout(reapTimer);
  }
  if (deadline) clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  if (escalation) await escalation;
  if (drainTimer) clearTimeout(drainTimer);
  for (const [channel, tail] of [["stdout", outDecoder.end()], ["stderr", errDecoder.end()]] as const) {
    if (!tail) continue;
    try { options.onOutput?.(channel, tail); } catch { /* observers never own execution */ }
    capture.push(channel, tail);
  }
  spill?.close();
  if (killTimer) clearTimeout(killTimer);
  if (spawnError) return errorResult("bash_spawn_error", `cannot start Bash: ${spawnError.message}`);
  const { segments, truncated } = capture.render(max, savedLabel(spill?.path, spill?.capped));
  const content: ToolResult["content"] = segments.map((segment) => segment.channel
    ? { type: "text", channel: segment.channel, text: segment.text } : { type: "text", text: segment.text });
  return {
    isError: aborted || timedOut,
    ...(aborted ? { code: "aborted" } : timedOut ? { code: "timeout" } : {}),
    content,
    exitCode: exited.code,
    signal: exited.signal,
    timedOut,
    truncated,
    retainedBytes: segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0),
    observedBytes,
    ...(truncated && spill?.path ? { fullOutputPath: spill.path, ...(spill.capped ? { fullOutputCapped: true } : {}) } : {}),
  };
}
