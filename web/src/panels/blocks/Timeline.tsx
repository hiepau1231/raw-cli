import type { TimelineEvent } from "../../../../src/panels/contract.js";
import { relativeTime } from "../panel-state.js";

const levelLabel = { info: "Info", success: "Success", warning: "Warning", error: "Error" } as const;
/** Newest first (steps.png): a dot in the level's colour, the relative time above the label, the detail below. */
export function Timeline({ events, max }: { events: TimelineEvent[]; max?: number | undefined }) {
  const kept = max && max > 0 ? events.slice(-max) : events;
  const shown = [...kept].reverse();
  const now = Date.now();
  return (
    <ol className="panel-timeline">
      {shown.map((event, index) => (
        <li key={event.id} className={`panel-event level-${event.level}`}>
          {index < shown.length - 1 && <span className="panel-event-line" aria-hidden="true" />}
          <span className="panel-event-dot" aria-hidden="true" />
          <div className="panel-event-text">
            <time dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>{relativeTime(event.at, now)}</time>
            <span className="sr-only">{levelLabel[event.level]}: </span><span className="panel-event-label">{event.label}</span>
            {event.detail && <span className="panel-event-detail">{event.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
