import { ArrowUp, Pencil, Trash2 } from "lucide-react";
import type { QueuedInputView } from "../../../src/sessions/view.js";

/** What this page knows about a waiting message beyond the session: an action on it in flight, or Already sent. */
export type QueuedNotice = "working" | "already_sent";

const status = (item: QueuedInputView, notice: QueuedNotice | undefined): { label: string; tone: string } =>
  notice === "already_sent"
    ? { label: "Already sent", tone: "tone-muted" }
    : item.state === "delivering" || item.mode === "interrupt"
      ? { label: "Sending…", tone: "tone-accent" }
      : item.state === "paused"
        ? { label: "Paused", tone: "tone-warning" }
        : item.state === "blocked"
          ? { label: `Blocked: ${item.reason ?? "a hook refused it"}`, tone: "tone-error" }
          : { label: "Sends after the current step", tone: "tone-accent" };

/**
 * The messages waiting for the agent, oldest first, as cards above the composer (docs/chat-design.md §8): the text in two
 * lines, its attachments, where it is, and Edit, Delete and Send now.
 */
export function QueuedInputs({
  items,
  notices,
  onEdit,
  onDelete,
  onSendNow,
}: {
  items: QueuedInputView[];
  notices: ReadonlyMap<string, QueuedNotice>;
  onEdit: (item: QueuedInputView) => void;
  onDelete: (item: QueuedInputView) => void;
  onSendNow: (item: QueuedInputView) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="queued-inputs" aria-label="Waiting messages">
      {items.map((item) => {
        const notice = notices.get(item.id);
        const { label, tone } = status(item, notice);
        // The agent has it, or an action on it is in flight: nothing more to do with it here.
        const locked = notice !== undefined || item.state === "delivering";
        return (
          <li key={item.id} className="queued-input" data-testid="queued-input" data-state={notice ?? item.state}>
            <div className="queued-body">
              <p className="queued-text" title={item.text}>{item.text}</p>
              <div className="queued-meta">
                <span className={`sp-chip ${tone}`} title={label}>{label}</span>
                {item.attachments?.map((attachment) => (
                  <span className="sent-attachment" key={attachment.index} title={attachment.name}>{attachment.name}</span>
                ))}
              </div>
            </div>
            <div className="queued-actions">
              <button type="button" className="icon-button" aria-label="Edit" title="Edit" disabled={locked} onClick={() => onEdit(item)}>
                <Pencil size={15} aria-hidden="true" />
              </button>
              <button type="button" className="icon-button" aria-label="Delete" title="Delete" disabled={locked} onClick={() => onDelete(item)}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Send now"
                title="Send now: interrupt the agent and send this message"
                disabled={locked || item.mode === "interrupt"}
                onClick={() => onSendNow(item)}
              >
                <ArrowUp size={15} aria-hidden="true" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
