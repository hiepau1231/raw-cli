import { useId, useState } from "react";
import { Popover } from "radix-ui";
import { ContextRing } from "./ContextRing.js";
import type { ContextCard } from "./context-card.js";

/**
 * The composer's context button and its Context card (docs/chat-design.md §8): the ring and the percent, then the
 * tokens against the limit, a bar, the messages kept and the trigger, Compact now and Details.
 */
export function ContextPopover({
  card,
  compact,
  onDetails,
}: {
  card: ContextCard;
  /** The one compaction path; `disabled` is the reason it cannot run now. */
  compact: { run: () => void; disabled?: string | undefined };
  /** Opens the side panel on Details. */
  onDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const reasonId = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="context-button"
          aria-label={card.label}
          title={card.tokens ? `${card.tokens} ${card.of}` : card.label.replace(/^Context: /, "Context ")}
        >
          <ContextRing percent={card.percent} tone={card.tone} />
          {card.percent !== undefined && <span aria-hidden="true">{card.percent}%</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="context-popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-labelledby={titleId}
        >
          <div className="context-head">
            <strong id={titleId}>Context</strong>
            {card.percent !== undefined && <span className={`sp-chip tone-${card.tone}`}>{card.percent}%</span>}
          </div>
          {card.tokens ? (
            <p className="context-meter">
              <span className="context-big">{card.tokens}</span>
              <span className="context-of">{card.of}</span>
            </p>
          ) : (
            <p className="context-note">Measured after the first turn.</p>
          )}
          {card.percent !== undefined && (
            <span className="sp-bar context-bar" aria-hidden="true">
              <i className={`tone-${card.tone}`} style={{ width: `${Math.min(100, card.percent)}%` }} />
            </span>
          )}
          {card.line && <p className="context-line">{card.line}</p>}
          <div className="context-actions">
            <button
              type="button"
              className="foot-button"
              disabled={!!compact.disabled}
              aria-describedby={compact.disabled ? reasonId : undefined}
              title="Summarize model context while keeping visible history"
              onClick={() => {
                setOpen(false);
                compact.run();
              }}
            >
              Compact now
            </button>
            <button
              type="button"
              className="context-details"
              onClick={() => {
                setOpen(false);
                onDetails();
              }}
            >
              Details
            </button>
          </div>
          {compact.disabled && (
            <p id={reasonId} className="context-reason">
              {compact.disabled}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
