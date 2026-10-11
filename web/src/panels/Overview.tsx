import { useState, type ReactNode } from "react";
import { ChevronRight, Circle, CircleCheck, CircleX, Loader } from "lucide-react";
import type { PanelSummary, SummaryLine } from "./summaries.js";
import { DocumentStatus } from "./Tabs.js";

export interface OverviewCard { id: string; title: string; icon: ReactNode; summary: PanelSummary }

const lineGlyph = (glyph: SummaryLine["glyph"]) =>
  glyph === "running" ? <Loader size={13} aria-hidden="true" className="panel-spin" />
  : glyph === "failed" ? <CircleX size={13} aria-hidden="true" />
  : glyph === "done" ? <CircleCheck size={13} aria-hidden="true" />
  : glyph === "pending" ? <Circle size={13} aria-hidden="true" /> : null;
const glyphWord = { running: "Running", failed: "Failed", done: "Done", pending: "Next" } as const;

/** Badge, chips and totals at the right of a card header. */
export function SummaryStatus({ summary }: { summary: PanelSummary }) {
  return (
    <span className="sp-card-status">
      {summary.chips.map((chip) => (
        <span key={chip.text} className={`sp-chip tone-${chip.tone}`}>{chip.spin && <Loader size={10} aria-hidden="true" className="panel-spin" />}{chip.text}</span>
      ))}
      {summary.stats?.added !== undefined && <span className="sp-stat added">+{summary.stats.added}</span>}
      {summary.stats?.removed !== undefined && <span className="sp-stat removed">−{summary.stats.removed}</span>}
      {summary.meta && <span className="sp-meta">{summary.meta}</span>}
      {summary.status && <DocumentStatus status={summary.status} />}
    </span>
  );
}

/** The Overview tab: one summary card per shown panel; a card opens its tab (docs/side-panel-design.md §3). */
export function Overview({ cards, hidden, onOpen, onShow }: {
  cards: readonly OverviewCard[];
  hidden: ReadonlyArray<{ id: string; title: string }>;
  onOpen: (id: string) => void;
  onShow: (id: string) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  return (
    <div className="sp-overview">
      {cards.map(({ id, title, icon, summary }) => (
        <button key={id} type="button" className="sp-card sp-overview-card" data-card={id} onClick={() => onOpen(id)}>
          <span className="sp-card-head">
            <span className="sp-card-icon">{icon}</span>
            <span className="sp-card-title">{title}</span>
            <SummaryStatus summary={summary} />
            {/* Two chips fill the header; the whole card still opens the tab. */}
            {summary.chips.length < 2 && <ChevronRight size={14} aria-hidden="true" className="sp-card-chevron" />}
          </span>
          {summary.progress && (
            <span className="sp-bar" aria-hidden="true"><i className={`tone-${summary.progress.tone}`} style={{ width: `${Math.round(summary.progress.value * 100)}%` }} /></span>
          )}
          {summary.lines.map((line, index) => (
            <span key={index} className={`sp-card-line ${line.glyph ? `glyph-${line.glyph}` : ""}`}>
              {line.glyph && <span className="sp-line-glyph">{lineGlyph(line.glyph)}<span className="sr-only">{glyphWord[line.glyph]}: </span></span>}
              <span className="sp-line-text" title={line.text}>{line.text}</span>
              {line.meta && <span className="sp-line-meta">{line.meta}</span>}
            </span>
          ))}
        </button>
      ))}
      {hidden.length > 0 && (
        <div className="sp-hidden">
          <button type="button" className="sp-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((value) => !value)}>
            {hidden.length} hidden
          </button>
          {showHidden && (
            <ul>
              {hidden.map((entry) => (
                <li key={entry.id}><button type="button" onClick={() => onShow(entry.id)}>Show {entry.title}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
