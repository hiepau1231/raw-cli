import type { ToolContent, ToolHandlerContent, ToolHandlerResult, ToolResult } from "./types.js";
import { MAX_IMAGE_BYTES } from "./types.js";
import { SPILL_PATH_RESERVE, spillText, truncationNotice } from "./spill.js";

/** Default text budget of one tool result: room for a few hundred source lines or a long build log's start and end. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Safety bound for host-owned content (selected skills, var catalogs) returned whole instead of within max_output_bytes. */
export const HOST_CONTENT_BYTES = 1024 * 1024;

export function utf8Prefix(value: string, limit: number): { text: string; bytes: number; truncated: boolean } {
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

export function utf8Suffix(value: string, limit: number): { text: string; bytes: number; truncated: boolean } {
  const scalars = [...value];
  let bytes = 0;
  let start = scalars.length;
  while (start > 0) {
    const size = Buffer.byteLength(scalars[start - 1]!);
    if (bytes + size > limit) break;
    bytes += size;
    start--;
  }
  return { text: scalars.slice(start).join(""), bytes, truncated: start > 0 };
}

/**
 * Fits `value` in `limit` bytes by omitting its middle: the start (a fifth) and the end, where errors and summaries
 * usually are, survive around a marker naming the omitted byte count and, when known, the full copy.
 */
export function elideMiddle(value: string, limit: number, fullOutputPath?: string): { text: string; bytes: number; truncated: boolean } {
  const total = Buffer.byteLength(value);
  if (total <= limit) return { text: value, bytes: total, truncated: false };
  return elideParts(value, value, total, limit, fullOutputPath);
}

/** `elideMiddle` over a known start and end of a `total`-byte stream whose middle may already be gone. */
export function elideParts(head: string, tail: string, total: number, limit: number, fullOutputPath?: string): { text: string; bytes: number; truncated: boolean } {
  const marker = (omitted: number) => `\n…[${omitted} bytes omitted${fullOutputPath ? `; full output: ${fullOutputPath}` : ""}]…\n`;
  const room = limit - Buffer.byteLength(marker(total));
  if (room <= 0) return { ...utf8Prefix(head, limit), truncated: true };
  const start = utf8Prefix(head, Math.floor(room / 5));
  const end = utf8Suffix(tail, room - start.bytes);
  const text = start.text + marker(total - start.bytes - end.bytes) + end.text;
  return { text, bytes: Buffer.byteLength(text), truncated: true };
}

export function textResult(value: string, maxOutputBytes: number, meta: Partial<ToolResult> = {}): ToolResult {
  const prefix = utf8Prefix(value, maxOutputBytes);
  return {
    isError: false,
    content: [{ type: "text", text: prefix.text }],
    truncated: prefix.truncated,
    retainedBytes: prefix.bytes,
    observedBytes: Buffer.byteLength(value),
    ...meta,
  };
}

export function errorResult(code: string, message: string): ToolResult {
  return { isError: true, code, content: [{ type: "text", text: message }] };
}

export type IndexedResult = Record<string, unknown> & { index: number; status: string };

export function indexedResultFits(results: readonly IndexedResult[], maxOutputBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify({ results }), "utf8") <= maxOutputBytes;
}

export function indexedResult(results: readonly IndexedResult[], maxOutputBytes: number, isError: boolean): ToolResult {
  if (!indexedResultFits(results, maxOutputBytes)) return errorResult("output_budget_too_small", "batch status exceeds output budget");
  return { isError, content: [{ type: "json", value: { results } }] };
}

/** Room kept for a reduced JSON value however small the budget: enough for `"… JSON value of N bytes omitted"`. */
const MIN_JSON_BYTES = 64;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null");

function shrinkJson(value: unknown, items: number, chars: number, depth: number): unknown {
  if (typeof value === "string") {
    const scalars = [...value];
    if (scalars.length <= chars) return value;
    const half = Math.max(1, Math.floor(chars / 2));
    return `${scalars.slice(0, half).join("")}… ${scalars.length - 2 * half} characters omitted …${scalars.slice(-half).join("")}`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 32) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => shrinkJson(item, items, chars, depth + 1));
    return value.length > items ? [...kept, `… ${value.length - items} more items`] : kept;
  }
  const entries = Object.entries(value);
  const kept = Object.fromEntries(entries.slice(0, items).map(([key, item]) => [key, shrinkJson(item, items, chars, depth + 1)]));
  return entries.length > items ? { ...kept, "…": `${entries.length - items} more keys` } : kept;
}

/**
 * A valid JSON value of at most `limit` serialized bytes (docs/tool-ux-design.md §5.3 "Bounding at execution"):
 * long arrays and objects keep their first entries and say how many more there were, long strings keep their start and end.
 * Returns undefined when not even a placeholder fits.
 */
export function reduceJson(value: unknown, limit: number): unknown {
  if (jsonBytes(value) <= limit) return value;
  for (let items = 64, chars = 2048; ; items = Math.max(1, items >> 1), chars = Math.max(16, chars >> 1)) {
    const reduced = shrinkJson(value, items, chars, 0);
    if (jsonBytes(reduced) <= limit) return reduced;
    if (items === 1 && chars === 16) break;
  }
  const placeholder = `… JSON value of ${jsonBytes(value)} bytes omitted`;
  return jsonBytes(placeholder) <= limit ? placeholder : jsonBytes("…") <= limit ? "…" : undefined;
}

/** Panel blocks pass through untouched and uncounted: their own limits (panels-design §14) bound them, not the output budget. */
export function capResult(result: ToolResult, maxOutputBytes: number): ToolResult;
export function capResult(result: ToolHandlerResult, maxOutputBytes: number): ToolHandlerResult;
export function capResult(result: ToolHandlerResult, maxOutputBytes: number): ToolHandlerResult {
  const textual = result.content.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text)
    : block.type === "json" ? Buffer.byteLength(JSON.stringify(block.value) ?? "") : 0), 0);
  // An oversized result keeps room for a note telling the model it was cut and where the complete copy is.
  const overflow = textual > maxOutputBytes;
  // A JSON result keeps room for at least a minimal valid value; the notice is shortened instead (§5.3).
  const jsonFloor = result.content.some((block) => block.type === "json") ? Math.min(maxOutputBytes, MIN_JSON_BYTES) : 0;
  const noticeReserve = overflow ? Math.min(maxOutputBytes - jsonFloor, 160 + SPILL_PATH_RESERVE) : 0;
  let remaining = maxOutputBytes - noticeReserve;
  let truncated = false;
  const content: ToolHandlerContent[] = [];
  let observed = 0;
  let imageBytes = 0;
  for (const block of result.content) {
    if (block.type === "text") {
      observed += Buffer.byteLength(block.text);
      const prefix = utf8Prefix(block.text, remaining);
      remaining -= prefix.bytes;
      truncated ||= prefix.truncated;
      content.push({ ...block, text: prefix.text });
    } else if (block.type === "json") {
      const serialized = JSON.stringify(block.value);
      observed += Buffer.byteLength(serialized);
      if (Buffer.byteLength(serialized) <= remaining) {
        remaining -= Buffer.byteLength(serialized);
        content.push(block);
      } else {
        // Oversized JSON stays valid JSON for the model; the whole value is saved below.
        const reduced = reduceJson(block.value, remaining);
        truncated = true;
        if (reduced !== undefined) {
          remaining -= jsonBytes(reduced);
          content.push({ type: "json", value: reduced });
        }
      }
    } else if (block.type === "panel") {
      content.push(block);
    } else {
      const size = Buffer.from(block.data, "base64").length;
      imageBytes += size;
      if (imageBytes > MAX_IMAGE_BYTES) return capResult(errorResult("image_too_large", "tool images exceed 16 MiB"), maxOutputBytes);
      observed += Buffer.byteLength(block.data);
      content.push(block);
    }
  }
  remaining += noticeReserve;
  let fullOutputPath = result.fullOutputPath;
  let fullOutputCapped = result.fullOutputCapped === true;
  if (truncated) {
    if (fullOutputPath === undefined) {
      ({ path: fullOutputPath, capped: fullOutputCapped } = spillText("tool", result.content.flatMap((block) => block.type === "text" ? [block.text]
        : block.type === "json" ? [JSON.stringify(block.value, null, 2)] : []).join("\n")));
    }
    const notice = utf8Prefix(truncationNotice(maxOutputBytes - remaining, textual, fullOutputPath, fullOutputCapped), remaining);
    if (notice.text) { content.push({ type: "text", text: notice.text }); remaining -= notice.bytes; }
  }
  const retained = maxOutputBytes - remaining + content.reduce((sum, block) => sum + (block.type === "image" ? Buffer.byteLength(block.data) : 0), 0);
  // The saved copy is also recorded in host data, the durable per-call record the full-output route reads (§5.3).
  return { ...result, content, truncated: result.truncated || truncated, retainedBytes: retained, observedBytes: result.observedBytes ?? observed,
    ...(truncated && fullOutputPath ? { fullOutputPath, ...(fullOutputCapped ? { fullOutputCapped } : {}),
      host: { ...result.host, fullOutputPath, ...(fullOutputCapped ? { fullOutputCapped } : {}) } } : {}) };
}
