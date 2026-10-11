import { useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Ban, CheckCircle2, ChevronRight, CircleDashed, CircleX, Clock, LoaderCircle, ShieldAlert } from "lucide-react";
import type { VisibleToolCall, VisibleToolResult } from "../../../src/sessions/visible.js";
import type { PanelIcon, PanelReceipt } from "../../../src/panels/contract.js";
import { PanelGlyph } from "../panels/Tabs.js";
import type { Preferences } from "../preferences.js";
import { CodeBlock } from "../markdown.js";
import { CopyButton } from "../ui.js";
import { ResultBody } from "./ResultBody.js";
import { bodyKind, diffFileCount, parsedJson, previewText, resultCopy } from "./result-data.js";
import { JsonTree } from "./JsonTree.js";
import { parseTerminalPreview } from "./terminal.js";
import { useFullOutput } from "./FullOutput.js";
import { formatDuration, statusBadge, statusGlyph, type StatusGlyph } from "./status.js";
import { diffTotals } from "./diff-totals.js";

const GLYPHS: Record<StatusGlyph, typeof CheckCircle2> = {
  check: CheckCircle2, x: CircleX, spinner: LoaderCircle, pending: CircleDashed, shield: ShieldAlert, ban: Ban, clock: Clock,
};
const TONES: Record<string, string> = { ok: "success", error: "error", warning: "warning", pending: "muted" };

/** A panel this call updated, as a pill on its row: progress, its summary, or the rejection. */
export interface RowReceipt { receipt: PanelReceipt; onOpen: () => void; panelTitle: string; icon: PanelIcon }

/**
 * One tool call in a work group (docs/chat-design.md §6): a one-line row (status glyph, title, summary, diff stats,
 * receipt pills, a chip for states other than OK, duration) that opens a card with the body, a footer and the arguments.
 */
export function ToolRow({
  call,
  result,
  status,
  approval,
  children,
  preferences,
  previewAbbreviated,
  sessionId,
  receipts,
  onOpenCommands,
}: {
  call?: VisibleToolCall | undefined;
  result?: VisibleToolResult | undefined;
  status?: string | undefined;
  approval: boolean;
  /** The approval actions, inside the card while the call waits. */
  children?: ReactNode;
  preferences: Preferences;
  previewAbbreviated?: boolean | undefined;
  sessionId: string;
  receipts: RowReceipt[];
  onOpenCommands: () => void;
}) {
  const badge = statusBadge({ result, lifecycle: status, approval, started: !!call?.started });
  const glyph = statusGlyph(badge);
  const Glyph = GLYPHS[glyph];
  const failed = badge.tone === "error";
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? (preferences.toolDetails || approval || failed);
  const [showArguments, setShowArguments] = useState(false);
  const card = useId();
  const name = call?.name ?? result?.name ?? "Historical tool";
  // The projected title and summary (docs/tool-ux-design.md §5.4); old records fall back to the name and identity.
  const title = call?.title ?? name;
  const summary = call?.summary;
  const fallback = call?.identity ?? result?.identity;
  const callId = call?.id ?? result?.id;
  const kind = result ? bodyKind(result, call?.result) : undefined;
  const stats = result ? diffTotals([result]) : undefined;
  const chip = badge.tone === "error" ? badge.label : undefined;
  const canLoad = !!result && !!callId && (!!result.host?.fullOutputPath || !!previewAbbreviated || result.truncated);
  const full = useFullOutput(sessionId, callId ?? "");
  const notes = result
    ? [
        result.code && result.code !== badge.state ? result.code : "",
        previewAbbreviated ? "Display abbreviated" : "",
        result.truncated ? "Tool truncated its output" : "",
      ].filter(Boolean)
    : [];
  let body: ReactNode = null;
  let meta: string[] = [];
  let copy: ReactNode = null;
  let single = false;
  if (result && kind === "terminal") {
    const preview = parseTerminalPreview(previewText(result));
    const output = preview.lines.filter((line) => !line.notice);
    // The channel only when the visible tail's is known.
    const channel = output.at(-1)?.channel;
    const exit = preview.exit
      ? `exit ${preview.exit.code}`
      : typeof result.exitCode === "number"
        ? `exit ${result.exitCode}`
        : badge.tone === "ok" ? "" : badge.label.toLowerCase();
    const time = preview.exit
      ? `${preview.exit.seconds.toFixed(1)} s`
      : result.durationMs !== undefined ? formatDuration(result.durationMs) : "";
    // The parsed lines, and any structured JSON after them; a loaded full output replaces the lines only.
    const json = parsedJson(result);
    body = full.state.kind === "loaded" ? (
      <>
        <pre className="tool-terminal full" tabIndex={0}>
          <code>{full.state.text}</code>
        </pre>
        {json && <JsonTree values={json} />}
      </>
    ) : (
      <ResultBody result={result} hint={call?.result} card />
    );
    meta = full.state.kind === "loaded"
      ? ["Full output", ...(full.state.capped ? ["capped at 64 MiB when saved"] : [])]
      : [channel ?? "", exit, time];
    copy = (
      <CopyButton
        value={full.state.kind === "loaded" ? full.state.text : output.map((line) => line.text).join("\n")}
        label="Copy output"
        text="Copy"
        className="foot-button"
      />
    );
  } else if (result && kind === "diff") {
    const files = diffFileCount(result);
    // One file: the footer names it and the card hides the diff's file headers; several keep their headers.
    single = files <= 1;
    meta = [single ? (result.host?.files?.[0]?.path ?? result.host?.path ?? summary ?? "") : `${files} files`];
    body = <ResultBody result={result} hint={call?.result} card />;
    copy = <CopyButton value={result.host?.diff ?? previewText(result)} label="Copy diff" text="Copy diff" className="foot-button" />;
  } else if (result) {
    body = <ResultBody result={result} hint={call?.result} card />;
    const { value, label } = resultCopy(result, call?.result);
    if (label === "Copy code") meta = [result.host?.path ?? result.segments.find((segment) => segment.path)?.path ?? ""];
    if (value) copy = <CopyButton value={value} label={label} text="Copy" className="foot-button" />;
  }
  else if (call?.result === "terminal" && !approval)
    body = (
      <p className="tool-waiting">
        Live output is in{" "}
        <button type="button" className="tool-link" onClick={onOpenCommands}>
          Commands
        </button>
        .
      </p>
    );
  // A saved full output of another body reads after the preview.
  if (full.state.kind === "loaded" && kind !== "terminal")
    body = (
      <>
        {body}
        <pre className="tool-terminal full" tabIndex={0}>
          <code>{full.state.text}</code>
        </pre>
      </>
    );
  meta = [...meta, ...notes].filter(Boolean);
  return (
    <div className={`tool-row${failed ? " failed" : ""}`} data-kind={call?.kind ?? result?.kind ?? "other"} data-status={badge.state}>
      <div className="tool-line">
        <button
          type="button"
          className="tool-toggle"
          aria-expanded={open}
          aria-controls={card}
          onClick={() => setExpanded(!open)}
        >
          <span className={`tool-glyph tone-${badge.tone}`} data-glyph={glyph} aria-hidden="true">
            <Glyph size={14} />
          </span>
          <span className="sr-only">{badge.label}</span>
          <strong className="tool-title">{title}</strong>
          {summary ? <code className="tool-summary">{summary}</code> : <span className="tool-summary">{fallback ?? ""}</span>}
        </button>
        <span className="tool-spacer" />
        {stats && (
          <span className="tool-diffstat">
            <span className="add">+{stats.added}</span> <span className="remove">−{stats.removed}</span>
          </span>
        )}
        {receipts.map(({ receipt, onOpen, panelTitle, icon }, index) => (
          <button
            type="button"
            key={`${receipt.owner}#${receipt.panel}:${index}`}
            className={`receipt-pill${receipt.error ? " tone-error" : ""}`}
            title={`Show ${panelTitle} in the side panel`}
            onClick={onOpen}
          >
            <PanelGlyph icon={icon} size={12} />
            <span className="pill-text">
              {receipt.error
                ? "Update rejected"
                : receipt.progress && receipt.progress.total > 0
                  ? `${receipt.progress.done} of ${receipt.progress.total} done`
                  : receipt.op === "close" ? "Closed" : receipt.summary || receipt.title}
            </span>
            <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        ))}
        {chip && (
          <span className={`tool-status sp-chip tone-${TONES[badge.tone]}`} data-status={badge.state} aria-hidden="true">
            {chip}
          </span>
        )}
        {result?.durationMs !== undefined && <span className="tool-duration">{formatDuration(result.durationMs)}</span>}
        <ChevronRight className="tool-chevron" size={13} aria-hidden="true" />
      </div>
      <div className={`tool-card${failed ? " failed" : ""}${single ? " single-file" : ""}`} id={card} hidden={!open}>
        {body}
        {full.state.kind === "unavailable" && (
          <p className="tool-card-note" role="status">
            Full output is no longer available.
          </p>
        )}
        {full.state.kind === "error" && (
          <p className="tool-card-note error-text" role="alert">
            {full.state.message}
          </p>
        )}
        {showArguments && (
          <div className="tool-arguments">
            {call?.arguments ? (
              <CodeBlock code={JSON.stringify(call.arguments, null, 2)} language="json" />
            ) : (
              <p className="muted">Arguments are unavailable in this history record.</p>
            )}
          </div>
        )}
        <div className="tool-card-foot">
          <span className="tool-foot-meta">{meta.join(" · ")}</span>
          <span className="tool-spacer" />
          {copy}
          {canLoad && full.state.kind !== "loaded" && (
            <button
              type="button"
              className="foot-button"
              disabled={full.state.kind === "loading"}
              onClick={() => {
                void full.load();
              }}
            >
              {full.state.kind === "loading" ? "Loading…" : "Full output"}
            </button>
          )}
          <button type="button" className="foot-button" aria-expanded={showArguments} onClick={() => setShowArguments(!showArguments)}>
            Arguments
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
