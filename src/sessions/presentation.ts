import type { RunEvent } from "../agent.js";
import { acpUpdate } from "./display.js";
import type { VisibleRecord } from "./store.js";
import type { VisibleToolCall, VisibleToolResult } from "./visible.js";

export type HistorySurface = "cli" | "acp" | "web";

/** Transport presentation is host state; it never changes a model message. */
export function historyPresentation(surface: HistorySurface | undefined) {
  const canonical = surface !== "acp";
  return {
    messages(segments: readonly { kind: "assistant" | "reasoning"; text: string; segmentId: string }[], status: string): VisibleRecord[] {
      if (canonical) return segments.map(({ kind, text, segmentId }) => ({ kind, payload: { text, segmentId }, status }));
      return segments.filter((item) => item.kind === "assistant").map(({ text, segmentId }) => ({
        kind: "assistant", payload: { update: acpUpdate({ type: "text_delta", text }), segmentId }, status,
      }));
    },
    // Every tool record carries the call's projected display (title, kind, summary), so replay needs no tool lookup.
    // ACP records keep the projections next to their protocol updates, so the dashboard and CLI replay them like
    // canonical records: the declared call, the normalized call at start, and the result with the call that never ran.
    declaration(id: string, name: string, args: Record<string, unknown>, display: VisibleToolCall): VisibleRecord[] {
      return canonical ? [] : [{ kind: "tool_call", payload: { update: acpUpdate({ type: "tool_call", id, name, arguments: args, display }),
        display: { ...display, id } } }];
    },
    start(id: string, name: string, args: Record<string, unknown>, display: VisibleToolCall): VisibleRecord[] {
      return canonical ? [{ kind: "tool_call", payload: { display: { ...display, id } } }]
        : [{ kind: "acp_update", payload: { update: acpUpdate({ type: "tool_start", id, name, arguments: args, display }), display: { ...display, id } } }];
    },
    result(event: Extract<RunEvent, { type: "tool_result" }>, started: boolean, call: VisibleToolCall, display: VisibleToolResult): VisibleRecord[] {
      if (!canonical) return [{ kind: "tool_result", payload: { update: acpUpdate(event), display,
        ...(started ? {} : { call: { ...call, id: event.id } }) } }];
      return [...(started ? [] : [{ kind: "tool_call", payload: { display: { ...call, id: event.id } } }]),
        { kind: "tool_result", payload: { display } }];
    },
  };
}
