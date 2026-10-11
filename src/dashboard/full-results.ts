import { constants, promises as fs } from "node:fs";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { SessionStore } from "../sessions/store.js";
import { isSpillFilePath } from "../tools/spill.js";
import { DashboardError } from "./errors.js";

/** What a session recorded about a call's saved full output; `path` is absent when the call is known but nothing was saved. */
export interface StoredFullOutput { path?: string; capped: boolean }

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The saved copy a tool result names in its host data (or, for an ACP record, in the raw result it carries). */
function resultCopy(payload: Record<string, unknown>, callId: string): { known: boolean; copy?: StoredFullOutput } {
  const display = object(payload.display);
  const update = object(payload.update);
  if (display?.id !== callId && update?.toolCallId !== callId) return { known: false };
  const raw = display?.id === callId ? display : object(update?.rawOutput);
  const host = object(raw?.host);
  const fromHost = typeof host?.fullOutputPath === "string" && host.fullOutputPath !== "";
  const path = fromHost ? host!.fullOutputPath : raw?.fullOutputPath;
  if (typeof path !== "string" || !path) return { known: true };
  return { known: true, copy: { path, capped: (fromHost ? host!.fullOutputCapped : raw?.fullOutputCapped) === true } };
}

/** The copy a context-clearing record wrote or reused for the call; clearing only records complete copies. */
function clearedCopy(payload: Record<string, unknown>, callId: string): StoredFullOutput | undefined {
  if (!Array.isArray(payload.results)) return undefined;
  const entry = payload.results.map(object).find((item) => item?.callId === callId);
  return entry && typeof entry.path === "string" && entry.path ? { path: entry.path, capped: false } : undefined;
}

/**
 * Only what this session stored for the call (docs/tool-ux-design.md §5.3): the result's `host.fullOutputPath`, otherwise the
 * path of the latest context-clearing record that contains the call. Undefined when the session never saw the call.
 */
export function storedFullOutput(store: SessionStore, sessionId: string, callId: string): StoredFullOutput | undefined {
  let cleared: StoredFullOutput | undefined; let started = false;
  // Newest first: every clearing that names a call is newer than its result, so the scan stops at the result.
  for (let before: string | undefined; ;) {
    const page = store.getSessionHistory({ sessionId, limit: 100, ...(before ? { before } : {}) });
    for (const item of [...page.items].reverse()) {
      if (item.kind === "context_clearing") cleared ??= clearedCopy(item.payload, callId);
      else if (item.kind === "tool_result") {
        const found = resultCopy(item.payload, callId);
        if (found.known) return found.copy ?? cleared ?? { capped: false };
      } else if (item.kind === "tool_call") started ||= object(item.payload.display)?.id === callId;
    }
    if (!page.nextCursor) break;
    before = page.nextCursor;
  }
  return cleared ?? (started ? { capped: false } : undefined);
}

const unavailable = () => new DashboardError(410, "full_output_unavailable", "The saved full output is no longer available");
const refused = () => new DashboardError(403, "full_output_refused", "The recorded path is not a Raw saved-output file");

/** Streams the saved copy read-only; it never writes, copies or re-creates it. */
export async function sendFullOutput(response: ServerResponse, stored: StoredFullOutput): Promise<void> {
  if (!stored.path) throw unavailable();
  if (!isSpillFilePath(stored.path)) throw refused();
  let real: string;
  try { real = await fs.realpath(stored.path); } catch { throw unavailable(); }
  // A link inside a spill directory must not lead anywhere else.
  if (!isSpillFilePath(real)) throw refused();
  let handle: fs.FileHandle;
  // Non-blocking, so a FIFO or device recorded under a spill directory fails the regular-file check instead of hanging.
  try { handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { throw unavailable(); }
  try {
    const stat = await handle.stat().catch(() => undefined);
    if (!stat?.isFile()) throw unavailable();
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": stat.size, "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Raw-Full-Output-Capped": stored.capped ? "true" : "false" });
    if (!stat.size) { response.end(); return; }
    await pipeline(handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }), response);
  } finally { await handle.close().catch(() => {}); }
}
