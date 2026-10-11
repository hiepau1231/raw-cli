import type { VisibleToolResult } from "../../../src/sessions/visible.js";
import { diffCountable, diffStats, previewText } from "./result-data.js";

/**
 * Lines added and removed by successful file changes: each result's per-file counts when every file has them, else its
 * diff (host data, or the preview of a diff result). Undefined when nothing can be counted, so no `+0 −0` is shown for
 * edits whose lines are unknown.
 */
export function diffTotals(results: readonly VisibleToolResult[]): { added: number; removed: number } | undefined {
  let total: { added: number; removed: number } | undefined;
  for (const result of results) {
    if (result.status ? !["ok", "exit"].includes(result.status) : result.failed) continue;
    const diff = result.host?.diff ?? (result.resultType === "diff" ? previewText(result) : "");
    const files = result.host?.files ?? [];
    const counted = files.length && files.every((file) => file.added !== undefined && file.removed !== undefined)
      ? { added: files.reduce((sum, file) => sum + file.added!, 0), removed: files.reduce((sum, file) => sum + file.removed!, 0) }
      : diff && diffCountable(diff) ? diffStats(diff) : undefined;
    if (!counted) continue;
    total = { added: (total?.added ?? 0) + counted.added, removed: (total?.removed ?? 0) + counted.removed };
  }
  return total;
}
