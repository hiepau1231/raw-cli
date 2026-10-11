import { useEffect, useRef, useState } from "react";
import { ApiError, errorText, fetchFullToolOutput } from "../api.js";
import { TerminalFrame } from "./ResultBody.js";

export type FullOutputState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; text: string; capped: boolean }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** Loads the call's saved full output through the read-only session route; a missing copy keeps the preview. */
export function useFullOutput(sessionId: string, callId: string): { state: FullOutputState; load: () => Promise<void> } {
  const [state, setState] = useState<FullOutputState>({ kind: "idle" });
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const load = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: "loading" });
    try {
      const output = await fetchFullToolOutput(sessionId, callId, controller.signal);
      setState({ kind: "loaded", ...output });
    } catch (cause) {
      if (controller.signal.aborted) return;
      // Not recorded, deleted, unreadable or outside the spill directories: nothing the user can load.
      if (cause instanceof ApiError && [403, 404, 410].includes(cause.status))
        setState({ kind: "unavailable" });
      else setState({ kind: "error", message: errorText(cause) });
    }
  };
  return { state, load };
}

/** The Commands panel's Load full output: a button, then the saved output in a terminal frame. */
export function FullOutput({ sessionId, callId }: { sessionId: string; callId: string }) {
  const { state, load } = useFullOutput(sessionId, callId);
  if (state.kind === "loaded")
    return (
      <div className="full-output">
        <TerminalFrame label="Full output" text={state.text} />
        {state.capped && (
          <p className="muted small">Output was capped at 64 MiB when saved.</p>
        )}
      </div>
    );
  return (
    <div className="full-output">
      <button
        className="full-output-button"
        disabled={state.kind === "loading"}
        onClick={() => {
          void load();
        }}
      >
        {state.kind === "loading" ? "Loading full output…" : "Load full output"}
      </button>
      {state.kind === "unavailable" && (
        <p className="muted small" role="status">
          Full output is no longer available.
        </p>
      )}
      {state.kind === "error" && (
        <p className="error-text small" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
