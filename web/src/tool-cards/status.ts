import type { VisibleToolResult } from "../../../src/sessions/visible.js";

export type StatusTone = "ok" | "error" | "warning" | "pending";
export interface StatusBadge {
  label: string;
  tone: StatusTone;
  /** ok, error, exit, timeout, cancelled, denied, or a lifecycle state before the result. */
  state: string;
}

const LIFECYCLE: Record<string, string> = {
  requested: "Requested",
  running: "Running",
  denied: "Denied",
  cancelled: "Cancelled",
  outcome_unknown: "Outcome unknown",
};

/** A result's one status (docs/tool-ux-design.md §5.3), for old records too; mirrors `statusLabel` in src/sessions/visible.ts. */
function resultStatus(result: VisibleToolResult): string {
  return (
    result.status ??
    (!result.failed
      ? "ok"
      : typeof result.exitCode === "number" && result.exitCode !== 0
        ? "exit"
        : "error")
  );
}

/** The card's badge: approval first, then the result's status, then the lifecycle state while there is no result. */
export function statusBadge({
  result,
  lifecycle,
  approval,
  started,
}: {
  result?: VisibleToolResult | undefined;
  lifecycle?: string | undefined;
  approval: boolean;
  started: boolean;
}): StatusBadge {
  if (approval)
    return { label: "Needs approval", tone: "warning", state: "approval" };
  if (lifecycle === "outcome_unknown")
    return { label: "Outcome unknown", tone: "error", state: lifecycle };
  if (result) {
    const state = resultStatus(result);
    const label =
      state === "ok"
        ? "OK"
        : state === "exit"
          ? `Exit ${String(result.exitCode)}`
          : state === "timeout"
            ? "Timed out"
            : state[0]!.toUpperCase() + state.slice(1);
    return { label, tone: state === "ok" ? "ok" : "error", state };
  }
  const state = lifecycle && LIFECYCLE[lifecycle] ? lifecycle : started ? "running" : "requested";
  return {
    label: LIFECYCLE[state]!,
    tone: state === "denied" || state === "cancelled" ? "error" : "pending",
    state,
  };
}

/** `850 ms`, `1.2 s`, `3m 04s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type StatusGlyph = "check" | "x" | "spinner" | "pending" | "shield" | "ban" | "clock";
/** A row's status glyph (docs/chat-design.md §6): one per state, so a row reads without its chip. */
export function statusGlyph(badge: StatusBadge): StatusGlyph {
  if (badge.state === "approval") return "shield";
  if (badge.tone === "ok") return "check";
  if (badge.state === "timeout") return "clock";
  if (badge.state === "denied" || badge.state === "cancelled") return "ban";
  if (badge.tone === "error") return "x";
  return badge.state === "running" ? "spinner" : "pending";
}
