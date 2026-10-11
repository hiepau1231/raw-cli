import { InteractionView } from "./panels/InteractionView.js";
import { useId, useState, type ReactNode } from "react";
import { InlineToolView } from "./panels/ToolView.js";
import type { ActionHost } from "./panels/actions.js";
import type { InsertRef } from "./panels/status.js";
import { Brain, ChevronRight, LoaderCircle, ShieldQuestion } from "lucide-react";
import type { HistoryView } from "../../src/sessions/view.js";
import type {
  VisibleToolCall,
  VisibleToolResult,
} from "../../src/sessions/visible.js";
import type { CompactionDetails } from "../../src/agent.js";
import type { Approval } from "../../src/dashboard/approvals.js";
import type { LiveSegment } from "../../src/dashboard/live-output.js";
import type { Preferences } from "./preferences.js";
import { api, errorText } from "./api.js";
import { isTerminal, type ChatState } from "./session.js";
import { CodeBlock, Markdown } from "./markdown.js";
import { CopyButton, ErrorMessage } from "./ui.js";
import type { PanelIcon, PanelReceipt } from "../../src/panels/contract.js";
import { Receipt } from "./panels/Receipt.js";
import { PanelGlyph } from "./panels/Tabs.js";
import { receiptPanel } from "./panels/panel-state.js";
import { COMMANDS_ID } from "./panels/commands-state.js";
import { HistoryAttachments } from "./composer/HistoryAttachments.js";
import { ToolRow } from "./tool-cards/ToolRow.js";
import { diffTotals } from "./tool-cards/diff-totals.js";
import { statusBadge } from "./tool-cards/status.js";

/** The owner of the files-changed panel the editing tools share (src/tools/write-changes.ts FILES_CHANGED_OWNER). */
const FILES_CHANGED_OWNER = "host/files_changed";

export function ApprovalActions({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(`/permissions/${approval.id}`, "POST", {
        operationId: approval.operationId,
        callId: approval.callId,
        allow,
      });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <section className="approval" aria-label="Tool permission">
      <strong>
        <ShieldQuestion size={17} aria-hidden="true" /> Permission needed
      </strong>
      <p className="approval-headline">
        <span className="approval-title">{approval.title}</span>
        {approval.summary && <code className="approval-summary">{approval.summary}</code>}
      </p>
      <p>Allow this call once? This does not change your rules.</p>
      <details className="approval-arguments">
        <summary>Arguments</summary>
        <CodeBlock
          code={JSON.stringify(approval.arguments, null, 2)}
          language="json"
        />
      </details>
      {approval.effects && <><p>Intended effects</p><CodeBlock code={JSON.stringify(approval.effects, null, 2)} language="json" /></>}
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            void answer(true);
          }}
        >
          Allow once
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void answer(false);
          }}
        >
          Deny
        </button>
      </div>
      <small className="muted">
        Expires {new Date(approval.deadline).toLocaleString()}
      </small>
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}
function Compaction({ details }: { details: CompactionDetails }) {
  const titles: Record<string, string> = {
    running: "Compacting context…",
    compacted: "Context compacted",
    noop: "Nothing to compact",
    not_smaller: "Summary was not smaller",
    cancelled: "Compaction cancelled",
    error: "Compaction failed",
  };
  return (
    <details className="compaction">
      <summary>
        <Brain size={16} aria-hidden="true" />
        {titles[details.status] ?? details.status}
        <span className="muted">{details.cause}</span>
      </summary>
      <div className="inset">
        <p>
          ~{details.beforeTokens.toLocaleString()} tokens
          {details.afterTokens === undefined
            ? ""
            : ` → ~${details.afterTokens.toLocaleString()}`}
          . Retains {details.keepRecentTurns} recent turns.
        </p>
        {details.beforeBytes !== undefined && (
          <p className="muted small">
            Serialized bytes: {details.beforeBytes.toLocaleString()} →{" "}
            {details.afterBytes?.toLocaleString() ?? "unavailable"}
          </p>
        )}
        {details.summary && (
          <>
            <Markdown>{details.summary}</Markdown>
            <CopyButton value={details.summary} label="Copy summary" />
          </>
        )}
        {details.message && <ErrorMessage>{details.message}</ErrorMessage>}
        <p className="muted small">
          Earlier messages stay in History. The model uses the summary and
          retained context.
        </p>
      </div>
    </details>
  );
}
function PagedLive({
  segment,
  sessionId,
}: {
  segment: LiveSegment;
  sessionId: string;
}) {
  const [loaded, setLoaded] = useState("");
  const [offset, setOffset] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <Markdown>{loaded || segment.text}</Markdown>
      <p className="muted small">
        Long live output · showing a partial preview. Committed history will
        replace it.
      </p>
      {!done && (
        <button
          onClick={() => {
            void api<{ text: string; nextOffset: number; done: boolean }>(
              `/sessions/${sessionId}/output?operationId=${segment.operationId}&segmentId=${encodeURIComponent(segment.segmentId)}&offset=${offset}`,
            ).then(
              (page) => {
                setLoaded((old) => old + page.text);
                setOffset(page.nextOffset);
                setDone(page.done);
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          Load {offset ? "more" : "live output"}
        </button>
      )}
      <ErrorMessage>{segment.unavailable ?? error}</ErrorMessage>
    </div>
  );
}
/** A reasoning row: one muted italic line that opens to the full text. */
function ReasoningRow({ text, preferences }: { text: string; preferences: Preferences }) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? preferences.reasoning;
  const body = useId();
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" aria-expanded={open} aria-controls={body} onClick={() => setExpanded(!open)}>
        <Brain size={14} aria-hidden="true" />
        <i>{open ? "Reasoning" : text.replace(/\s+/g, " ").trim()}</i>
      </button>
      {/* Rendered only when open, so the text is on the page once. */}
      <div className="reasoning-body" id={body} hidden={!open}>
        {open && <Markdown>{text}</Markdown>}
      </div>
    </div>
  );
}
/** A header pill: one panel the group updated, opening it in the side panel. */
interface WorkPill { key: string; label: ReactNode; name: string; icon: PanelIcon; error: boolean; onOpen: () => void }
/**
 * A turn's tool activity (docs/chat-design.md §6): a summary line (time, tool count, failed and approval chips, one pill
 * per panel updated) over the reasoning and tool rows. It opens on the user's toggle, by preference, or while a call in it
 * waits for approval.
 */
function WorkGroup({
  children,
  count,
  failed,
  approval,
  active,
  preferences,
  elapsedMs,
  pills,
}: {
  children: ReactNode;
  count: number;
  failed: number;
  approval: boolean;
  active: boolean;
  preferences: Preferences;
  elapsedMs?: number | undefined;
  pills: WorkPill[];
}) {
  const [expanded, setExpanded] = useState<boolean>();
  // A pending approval's actions are in its row's card, so its group opens while it waits.
  const open = expanded ?? (approval || preferences.reasoning || preferences.toolDetails);
  const content = useId();
  return (
    <div className="work-group" data-state={active ? "running" : "done"}>
      <div className="work-head">
        <button type="button" className="work-toggle" aria-expanded={open} aria-controls={content} onClick={() => setExpanded(!open)}>
          <ChevronRight className="chevron" size={14} aria-hidden="true" />
          <strong className="work-time">
            {active ? "Working" : elapsedMs !== undefined ? `Worked ${(elapsedMs / 1000).toFixed(1)}s` : "Worked"}
          </strong>
          <span className="work-count">· {count ? `${count} ${count === 1 ? "tool" : "tools"}` : "Reasoning"}</span>
          {failed > 0 && <span className="sp-chip tone-error">{failed} failed</span>}
          {approval && <span className="sp-chip tone-warning">Needs approval</span>}
        </button>
        <span className="tool-spacer" />
        {pills.map((pill) => (
          <button
            type="button"
            key={pill.key}
            className={`work-pill${pill.error ? " tone-error" : ""}`}
            aria-label={pill.name}
            title={`Show ${pill.name} in the side panel`}
            onClick={pill.onOpen}
          >
            <PanelGlyph icon={pill.icon} size={12} />
            <span className="pill-text">{pill.label}</span>
          </button>
        ))}
        {active && <LoaderCircle className="work-spinner" size={13} aria-hidden="true" />}
      </div>
      <div className="work-content" id={content} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
export function Timeline({
  state,
  preferences,
  onOpenPanel,
  actions,
  onInsert = () => {},
}: {
  state: ChatState;
  preferences: Preferences;
  onOpenPanel: (panel: string) => void;
  actions?: ActionHost | undefined;
  onInsert?: InsertRef;
}) {
  const records = [...state.history.items];
  for (const segment of state.live)
    if (!records.some((record) => record.id === segment.segmentId))
      records.push({
        id: segment.segmentId,
        kind: segment.kind,
        status: "streaming",
        text: segment.text,
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        operationId: segment.operationId,
        ...(segment.turnId ? { turnId: segment.turnId } : {}),
      });
  const pairs = new Map<
    string,
    {
      call?: VisibleToolCall;
      result?: VisibleToolResult;
      status?: string;
      abbreviated?: boolean;
    }
  >();
  const scopes = new Map<string, string>();
  let legacyTurn = "legacy:before-page";
  for (const record of records) {
    if (record.kind === "user") legacyTurn = `legacy:${record.id}`;
    scopes.set(record.id, record.operationId ?? record.turnId ?? legacyTurn);
  }
  const keyFor = (record: HistoryView) =>
    `${scopes.get(record.id) ?? record.operationId ?? record.turnId ?? legacyTurn}:${record.callId}`;
  for (const record of records)
    if (record.callId) {
      const item = pairs.get(keyFor(record)) ?? {};
      if (record.toolCall) item.call = record.toolCall;
      if (record.toolResult) {
        item.result = record.toolResult;
        item.abbreviated = record.previewAbbreviated ?? false;
      }
      if (record.toolState) item.status = record.toolState;
      pairs.set(keyFor(record), item);
    }
  for (const tool of Object.values(state.tools)) {
    const key = `${tool.operationId}:${tool.callId}`;
    const old = pairs.get(key) ?? {};
    pairs.set(key, {
      ...old,
      ...(tool.call ? { call: tool.call } : {}),
      ...(tool.result ? { result: tool.result } : {}),
      ...(tool.state ? { status: tool.state } : {}),
    });
    if (!records.some((item) => keyFor(item) === key))
      records.push({
        id: `live:${key}`,
        kind: "tool_call",
        status: "streaming",
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        operationId: tool.operationId,
        callId: tool.callId,
      });
  }
  for (const approval of state.approvals) {
    const key = `${approval.operationId}:${approval.callId}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        call: {
          id: approval.callId,
          name: approval.name,
          arguments: approval.arguments,
          started: false,
        },
      });
      records.push({
        id: `approval:${approval.id}`,
        kind: "tool_call",
        status: "pending",
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: approval.createdAt,
        operationId: approval.operationId,
        callId: approval.callId,
      });
    }
  }
  for (const request of state.interactions ?? []) if (!records.some(item => item.interactionRequestId === request.identity.requestId)) {
    records.push({ id: `interaction:${request.identity.requestId}`, kind: "interaction_request", status: request.state,
      sequence: Number.MAX_SAFE_INTEGER, createdAt: request.createdAt, interactionRequestId: request.identity.requestId,
      ...(request.identity.viewInstanceId ? { interactionViewInstanceId: request.identity.viewInstanceId } : {}) });
  }
  for (const frame of Object.values(state.views)) if (frame.view && !records.some(item => item.panelReceipt?.view?.instanceId === frame.view!.instanceId)) {
    records.push({ id: `view:${frame.view.instanceId}`, kind: "tool_view", status: frame.live ? "streaming" : "complete",
      sequence: Number.MAX_SAFE_INTEGER, createdAt: Date.now(), operationId: frame.operationId, toolView: frame.view });
  }
  const compactions = new Map<string, CompactionDetails>();
  for (const item of records)
    if (item.compaction) compactions.set(item.compaction.id, item.compaction);
  for (const item of Object.values(state.compactions))
    if (item.details && !compactions.has(item.details.id)) {
      compactions.set(item.details.id, item.details);
      records.push({
        id: item.details.id,
        kind: "compaction",
        status: item.details.status,
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: Date.now(),
        compaction: item.details,
      });
    }
  const result: ReactNode[] = [];
  /** The open group's entries; rows are built at flush, when the receipts of its calls are known. */
  let work: Array<{ reasoning: string; id: string } | { key: string; callId: string; operationId?: string | undefined }> = [];
  let receipts: PanelReceipt[] = [];
  let workId = "";
  let workActive = false;
  let elapsedMs: number | undefined;
  const renderedTools = new Set<string>();
  const renderedCompact = new Set<string>();
  const renderedViews = new Set<string>();
  const availabilityRevision = `${state.snapshotCount}:${state.session.agentName}:${state.operations.filter(op => isTerminal(op.state)).map(op => `${op.id}:${op.state}`).join(",")}`;
  const stackOf = (receipt: PanelReceipt) => state.panels.find((panel) => panel.panel === receiptPanel(receipt));
  const flush = () => {
    if (work.length) {
      const byCall = new Map<string, PanelReceipt[]>();
      for (const receipt of receipts) byCall.set(receipt.toolCallId, [...(byCall.get(receipt.toolCallId) ?? []), receipt]);
      let failed = 0;
      let approvals = false;
      const results: VisibleToolResult[] = [];
      const rows = work.map((entry) => {
        if ("reasoning" in entry) return <ReasoningRow key={entry.id} text={entry.reasoning} preferences={preferences} />;
        const pair = pairs.get(entry.key)!;
        const approval = state.approvals.find((pending) => pending.operationId === entry.operationId && pending.callId === entry.callId);
        const badge = statusBadge({ result: pair.result, lifecycle: pair.status, approval: !!approval, started: !!pair.call?.started });
        if (badge.tone === "error") failed++;
        approvals ||= !!approval;
        if (pair.result) results.push(pair.result);
        return (
          <ToolRow
            key={entry.key}
            call={pair.call}
            result={pair.result}
            status={pair.status}
            approval={!!approval}
            preferences={preferences}
            previewAbbreviated={pair.abbreviated}
            sessionId={state.session.id}
            // Files changed is the header's +a −r pill; other panels get a pill on the row that updated them.
            receipts={(byCall.get(entry.callId) ?? []).filter((receipt) => receipt.owner !== FILES_CHANGED_OWNER).map((receipt) => ({
              receipt, panelTitle: stackOf(receipt)?.title ?? receipt.title, icon: stackOf(receipt)?.icon ?? "panel", onOpen: () => onOpenPanel(receiptPanel(receipt)) }))}
            onOpenCommands={() => onOpenPanel(COMMANDS_ID)}
          >
            {approval && <ApprovalActions approval={approval} />}
          </ToolRow>
        );
      });
      // One pill per panel, in the order the group first updated it, showing its latest receipt.
      const latest = new Map<string, PanelReceipt>();
      for (const receipt of receipts) latest.set(receiptPanel(receipt), receipt);
      const pills = [...latest].map(([panel, receipt]): WorkPill => {
        const stack = stackOf(receipt);
        const pill = { key: panel, icon: stack?.icon ?? "panel", error: false, onOpen: () => onOpenPanel(panel) };
        if (receipt.error) return { ...pill, label: receipt.title, name: `${receipt.title}: update rejected`, error: true };
        // This group's own lines, from its diff results; the receipt's summary counts the whole session.
        const totals = receipt.owner === FILES_CHANGED_OWNER ? diffTotals(results) : undefined;
        if (totals)
          return { ...pill, name: `${receipt.title} +${totals.added} −${totals.removed}`,
            label: <><span className="add">+{totals.added}</span> <span className="remove">−{totals.removed}</span></> };
        const title = stack?.title ?? receipt.title;
        const label = receipt.progress && receipt.progress.total > 0 ? `${title} ${receipt.progress.done}/${receipt.progress.total}` : receipt.title;
        return { ...pill, label, name: label };
      });
      result.push(
        <WorkGroup
          key={`work:${workId}`}
          count={rows.length - work.filter((entry) => "reasoning" in entry).length}
          failed={failed}
          approval={approvals}
          active={workActive}
          preferences={preferences}
          elapsedMs={elapsedMs}
          pills={pills}
        >
          {rows}
        </WorkGroup>,
      );
    }
    work = [];
    receipts = [];
    workActive = false;
    elapsedMs = undefined;
  };
  for (const item of records) {
    if (item.interactionRequestId) {
      flush();
      if (item.interactionViewInstanceId) renderedViews.add(item.interactionViewInstanceId);
      result.push(<InteractionView key={item.interactionRequestId} sessionId={state.session.id} requestId={item.interactionRequestId}
        live={state.interactions?.find(request => request.identity.requestId === item.interactionRequestId)} availabilityRevision={availabilityRevision}
        actions={actions} onInsert={onInsert} onOpenPanel={onOpenPanel} />);
      continue;
    }
    const identity = item.toolView ?? item.panelReceipt?.view;
    if (identity) {
      if (renderedViews.has(identity.instanceId)) {
        if (item.panelReceipt) {
          flush();
          result.push(<Receipt key={item.id} receipt={item.panelReceipt} icon="panel" openLabel="Show this tool view"
            onOpen={() => document.querySelector(`[data-instance="${CSS.escape(identity.instanceId)}"]`)?.scrollIntoView({ block: "nearest" })} />);
        }
        continue;
      }
      renderedViews.add(identity.instanceId);
      flush();
      result.push(<InlineToolView key={identity.instanceId} sessionId={state.session.id} identity={identity}
        live={state.views[identity.instanceId]} receipt={item.panelReceipt}
        availabilityRevision={availabilityRevision} actions={actions} onInsert={onInsert} />);
      continue;
    }
    if (item.kind === "reasoning" || item.callId) {
      if (!work.length) workId = item.id;
      workActive ||= state.operations.some(
        (op) => op.id === item.operationId && !isTerminal(op.state),
      );
      elapsedMs ??= state.operations.find((op) => op.id === item.operationId)
        ?.metrics?.elapsedMs;
      if (item.kind === "reasoning") work.push({ reasoning: item.text ?? "", id: item.id });
      else {
        const key = keyFor(item);
        if (renderedTools.has(key)) continue;
        renderedTools.add(key);
        work.push({ key, callId: item.callId!, operationId: item.operationId });
      }
      continue;
    }
    if (item.panelReceipt) {
      // A call's receipt is a pill of its group; one without a call in the open group (a user action) is a row of its own.
      const receipt = item.panelReceipt;
      if (receipt.source === "tool" && work.some((entry) => "callId" in entry && entry.callId === receipt.toolCallId)) {
        receipts.push(receipt);
        continue;
      }
      flush();
      result.push(<Receipt key={item.id} receipt={receipt} icon={stackOf(receipt)?.icon ?? "panel"} onOpen={() => onOpenPanel(receiptPanel(receipt))} />);
      continue;
    }
    flush();
    if (item.hook) {
      result.push(<p className="run-status" key={item.id}>
        Hook {item.hook.id} · {item.hook.event} · {item.hook.outcome}
        {item.hook.message ? ` · ${item.hook.message}` : item.hook.code ? ` · ${item.hook.code}` : ""}
      </p>);
      continue;
    }
    if (item.compaction) {
      const id = item.compaction.id;
      if (!renderedCompact.has(id)) {
        renderedCompact.add(id);
        result.push(<Compaction key={id} details={compactions.get(id)!} />);
      }
      continue;
    }
    if (item.kind === "run_end") {
      if (item.runResult?.status !== "completed")
        result.push(
          <p className="run-status" key={item.id}>
            {item.runResult?.status === "cancelled"
              ? "Stopped · response may be incomplete"
              : `${item.runResult?.status ?? item.status}${item.runResult?.message ? ` · ${item.runResult.message}` : ""}`}
          </p>,
        );
      continue;
    }
    if (item.kind === "user" || item.kind === "assistant") {
      const segment = state.live.find((entry) => entry.segmentId === item.id);
      result.push(
        <article
          className={`message ${item.kind}`}
          key={item.id}
          data-testid={
            item.kind === "user" ? "user-message" : "assistant-message"
          }
        >
          {item.kind === "user" ? (
            <>
              {/* The user's bubble: attachments above the text, the time and Copy message under it. */}
              <div className="bubble">
                {item.attachments?.length ? (
                  <HistoryAttachments
                    items={item.attachments}
                    sessionId={state.session.id}
                    sequence={item.sequence}
                  />
                ) : null}
                {segment?.paged ? (
                  <PagedLive segment={segment} sessionId={state.session.id} />
                ) : (
                  <div className="user-text">{item.text}</div>
                )}
              </div>
              <div className="message-meta">
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <CopyButton value={item.text ?? ""} label="Copy message" />
              </div>
            </>
          ) : (
            <>
              <div className="message-label">
                <span className="avatar" aria-hidden="true">r</span>
                <strong>Raw</strong>
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {segment?.paged ? (
                <PagedLive segment={segment} sessionId={state.session.id} />
              ) : (
                <Markdown>{item.text ?? ""}</Markdown>
              )}
            </>
          )}
          {item.status === "interrupted" && (
            <small className="warning">Incomplete response</small>
          )}
          {item.kind === "assistant" && (
            <div className="message-actions">
              <CopyButton value={item.text ?? ""} label="Copy message" />
            </div>
          )}
        </article>,
      );
    } else if (item.text)
      result.push(
        <p className="system-note" key={item.id}>
          {item.text}
        </p>,
      );
  }
  flush();
  return <>{result}</>;
}
