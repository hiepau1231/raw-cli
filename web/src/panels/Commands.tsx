import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AtSign, Ban, Check, ChevronRight, Clock, Copy, LoaderCircle, Square, X, type LucideIcon } from "lucide-react";
import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { ProcessOutput } from "../../../src/processes/contract.js";
import { api, errorText } from "../api.js";
import { FullOutput } from "../tool-cards/FullOutput.js";
import { formatDuration } from "../tool-cards/status.js";
import { CopyButton } from "../ui.js";
import { commandGroups, commandRunning, groupOpen, terminalText, type CommandGroup } from "./commands-state.js";
import type { InsertRef } from "./status.js";
const MAX_TEXT = 65536;

type Glyph = "running" | "ok" | "error" | "timeout" | "stopped";
const GLYPHS: Record<Glyph, [LucideIcon, string]> = {
  running: [LoaderCircle, "Running"], ok: [Check, "Succeeded"], error: [X, "Failed"], timeout: [Clock, "Timed out"], stopped: [Ban, "Stopped"],
};
function glyphOf(item: CommandRecord): Glyph {
  if (commandRunning(item)) return "running";
  if (item.state === "timed_out") return "timeout";
  if (item.state === "stopped") return "stopped";
  return item.state === "exited" && !item.exitCode ? "ok" : "error";
}
/** The exit badge: a nonzero exit, or the signal of a command that failed without one. */
const badgeOf = (item: CommandRecord, glyph: Glyph): string | undefined =>
  item.exitCode ? `exit ${item.exitCode}` : glyph === "error" && item.signal ? item.signal : undefined;
function statusOf(item: CommandRecord, glyph: Glyph): string {
  if (glyph === "running") return item.state === "stopping" ? "Stopping" : "Running";
  if (item.exitCode != null) return `exit ${item.exitCode}`;
  return glyph === "error" ? (item.signal ?? item.error ?? "Failed") : GLYPHS[glyph][1];
}

/** One command (docs/tool-ux-design.md §6.4): a 24 px row that opens its output in a terminal frame. */
function Command({ item, sessionId, sessionCwd, now, groupOpen: shown, onInsert }: {
  item: CommandRecord; sessionId: string; sessionCwd?: string | undefined; now: number; groupOpen: boolean; onInsert: InsertRef;
}) {
  const row = useRef<HTMLLIElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  // Follows new output while the reader stays at the bottom of the frame.
  const following = useRef(true);
  const [focused, setFocused] = useState(false);
  const [opened, setOpened] = useState(false);
  const [output, setOutput] = useState({ text: "", next: 0, truncated: false, channel: "" });
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | undefined>(undefined);
  const stopAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stopAbort.current?.abort(), []);
  const [page, setPage] = useState(0);
  const live = commandRunning(item);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && focused) row.current?.focus();
    wasLive.current = live;
  }, [live, focused]);
  const url = `/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(item.id)}`;
  const latestCursor = useRef(item.cursor);
  latestCursor.current = item.cursor;
  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController();
    let pending = false;
    let failed = false;
    let cursor = output.next;
    const read = async (force = false) => {
      if (pending || failed || (!force && cursor >= latestCursor.current)) return;
      pending = true;
      try {
        const result = await api<ProcessOutput>(`${url}/output?cursor=${cursor}&maxBytes=16384`, "GET", undefined, abort.signal);
        if (abort.signal.aborted) return;
        cursor = result.nextCursor;
        setOutput(old => {
          // A channel label only where the channel changes, so streamed output reads as one terminal.
          let channel = old.channel;
          let text = old.text;
          for (const chunk of result.chunks) {
            if (chunk.channel !== channel) text += `${text && !text.endsWith("\n") ? "\n" : ""}[${chunk.channel}]\n`;
            channel = chunk.channel;
            text += terminalText(chunk.text);
          }
          return { text: text.slice(-MAX_TEXT), next: result.nextCursor, channel,
            truncated: old.truncated || result.truncated || result.droppedBytes > 0 || text.length > MAX_TEXT };
        });
        setError("");
      } catch (cause) { failed = true; if (!abort.signal.aborted) setError(errorText(cause)); }
      finally { pending = false; }
    };
    void read(true);
    // Serialize reads so a slow approval or output flood cannot create overlapping permission requests.
    const timer = setInterval(() => { void read(); }, 1000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [opened, page, url]);
  useLayoutEffect(() => {
    if (following.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output.text, opened]);
  const stop = async () => {
    const abort = new AbortController();
    stopAbort.current?.abort(); stopAbort.current = abort;
    requestId.current ??= crypto.randomUUID();
    setStopping(true); setError("");
    try {
      type Receipt = { id: string; state: string; result?: { content?: Array<{ type: string; text?: string }> } };
      const settled = (receipt: Receipt) => {
        setNotice(receipt.state === "completed" ? "Stop completed." : `Stop ${receipt.state}. ${receipt.result?.content?.map(c => c.text ?? "").join(" ") ?? ""}`);
        requestId.current = undefined;
      };
      const receipt = await api<Receipt>(`${url}/stop`, "POST", { clientRequestId: requestId.current }, abort.signal);
      if (receipt.state !== "running") settled(receipt);
      else setNotice("Stop requested. Check approval controls if approval is required.");
      // A receipt is an independent audited control, not a model operation.
      while (receipt.state === "running" && !abort.signal.aborted) {
        const result = await api<Receipt>(`${url}/controls/${encodeURIComponent(receipt.id)}`, "GET", undefined, abort.signal);
        if (result.state !== "running") { settled(result); break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (cause) { if (!abort.signal.aborted) setError(errorText(cause)); }
    finally { setStopping(false); }
  };
  const glyph = glyphOf(item);
  const [Glyph, glyphLabel] = GLYPHS[glyph];
  const badge = badgeOf(item, glyph);
  const otherCwd = sessionCwd !== undefined && item.cwd !== sessionCwd;
  const name = item.label || item.command;
  // A row whose group is collapsed stays visible while someone works with it.
  return <li ref={row} tabIndex={-1} className="command-row" data-state={item.state} hidden={!shown && !opened && !stopping && !focused && !notice && !error}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <div className="panel-row command-line">
      <button type="button" className="command-toggle" aria-expanded={opened} title={item.command} onClick={() => setOpened(value => !value)}>
        <span className="command-glyph" data-glyph={glyph}>
          <Glyph size={14} aria-hidden="true" className={glyph === "running" ? "panel-spin" : undefined} />
          <span className="sr-only">{glyphLabel}</span>
        </span>
        <code className="command-text">{item.command}{item.commandTruncated ? "…" : ""}</code>
        <span className="command-duration">{formatDuration((item.endedAt ?? now) - item.createdAt)}</span>
        {badge && <span className="command-exit">{badge}</span>}
      </button>
      {item.kind === "background" && live && (
        <button type="button" className="icon-button panel-row-action" aria-label="Stop" title={`Stop ${name}`} disabled={stopping || item.state === "stopping"} onClick={() => void stop()}>
          <Square size={12} aria-hidden="true" />
        </button>
      )}
      {item.commandTruncated ? (
        // Only the first 4 KiB were kept: copying them would paste a different command.
        <button type="button" className="icon-button panel-row-action" aria-label="Copy command (unavailable: the command was cut at 4 KiB)" title="The command was cut at 4 KiB for display, so it cannot be copied" disabled>
          <Copy size={14} aria-hidden="true" />
        </button>
      ) : <CopyButton value={item.command} label="Copy command" className="panel-row-action" />}
      {item.fullOutputPath && (
        <button type="button" className="icon-button panel-row-action" aria-label={`Insert @${item.fullOutputPath} into the message`} title={`Insert @${item.fullOutputPath} into the message`} onClick={() => onInsert(item.fullOutputPath!)}>
          <AtSign size={14} aria-hidden="true" />
        </button>
      )}
    </div>
    {(item.label || otherCwd) && (
      <div className="command-detail">
        {item.label && <span>{item.label}</span>}
        {otherCwd && <span className="command-cwd" title={item.cwd}>{item.cwd}</span>}
      </div>
    )}
    {item.error && <p className="command-note" role="note">{item.error}</p>}
    {notice && <p className="command-note" role="status">{notice}</p>}
    {error && <p className="command-note error" role="alert">{error}</p>}
    {opened && <div className="terminal-frame command-output">
      <div className="terminal-bar">
        <span>{statusOf(item, glyph)}</span>
        <CopyButton value={output.text} label="Copy output" />
      </div>
      {output.truncated && <p className="command-note" role="note">Output truncated: older bytes were dropped or the display limit was reached.</p>}
      <pre ref={pre} tabIndex={0} aria-label={`Output for ${name}`}
        onScroll={event => { const el = event.currentTarget; following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4; }}>
        <code>{output.text || "No output yet."}</code>
      </pre>
      {output.next < item.cursor && <button type="button" className="command-more-output" onClick={() => setPage(value => value + 1)}>Load more output</button>}
    </div>}
    {opened && item.toolCallId && item.fullOutputPath && <FullOutput sessionId={sessionId} callId={item.toolCallId} />}
  </li>;
}

/** Group open state lives outside the section body, so collapsing the section or reloading keeps it (§6.4). */
function useCommandGroups(sessionId: string): [(group: CommandGroup) => boolean, (group: CommandGroup, open: boolean) => void] {
  const [prefs, setPrefs] = useState(commandGroups.get);
  return [group => groupOpen(prefs, sessionId, group), (group, open) => setPrefs(commandGroups.set(sessionId, group, open))];
}

function GroupToggle({ title, count, open, onToggle }: { title: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="command-group" aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={12} aria-hidden="true" className="panel-chevron" />
      {title} ({count})
    </button>
  );
}

export function Commands({ items, sessionId, sessionCwd, omitted = 0, onInsert }: {
  /** `omitted`: older commands the server left out of `items`; Completed counts them too. */
  items: readonly CommandRecord[]; sessionId: string; sessionCwd?: string | undefined; omitted?: number | undefined; onInsert: InsertRef;
}) {
  const [now, setNow] = useState(Date.now);
  const running = items.filter(commandRunning);
  const done = items.filter(item => !commandRunning(item));
  useEffect(() => { if (!running.length) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running.length > 0]);
  const [isOpen, setOpen] = useCommandGroups(sessionId);
  const row = (item: CommandRecord, open: boolean) =>
    <Command key={`${sessionId}:${item.id}`} item={item} sessionId={sessionId} sessionCwd={sessionCwd} now={now} groupOpen={open} onInsert={onInsert} />;
  // One flat list, so a row that finishes keeps its state when it moves from Running to Completed.
  return <div className="commands">{!items.length && <p className="muted small">No commands yet.</p>}<ul className="commands-list">
    {[...(running.length ? [<li key="running-heading" className="command-group-item"><GroupToggle title="Running" count={running.length} open={isOpen("running")} onToggle={() => setOpen("running", !isOpen("running"))} /></li>] : []),
      ...running.map(item => row(item, isOpen("running"))),
      ...(done.length || omitted ? [<li key="completed-heading" className="command-group-item"><GroupToggle title="Completed" count={done.length + omitted} open={isOpen("completed")} onToggle={() => setOpen("completed", !isOpen("completed"))} /></li>] : []),
      ...done.map(item => row(item, isOpen("completed"))),
      ...(omitted && isOpen("completed") ? [<li key="more" className="command-more">Older commands not shown</li>] : [])]}
  </ul></div>;
}
