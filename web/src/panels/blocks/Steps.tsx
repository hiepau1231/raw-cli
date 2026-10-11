import { useEffect, useState } from "react";
import type { StepItem } from "../../../../src/panels/contract.js";
import { formatDuration, stepDuration } from "../panel-state.js";
import { ItemActions, StatusControl } from "../actions.js";
import { StatusGlyph } from "../status.js";

/**
 * A stepper (steps.png): glyphs joined by a line, the label beside its glyph's first line, the current step at weight
 * 550 with its detail, and the time each step took (a running step's, ticking) muted at the right.
 */
export function Steps({ block, items }: { block: string; items: StepItem[] }) {
  const running = items.some((step) => step.status === "in_progress" && typeof step.started_at === "number" && step.ended_at === undefined);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <ol className="panel-steps">
      {items.map((step, index) => {
        const live = step.status === "in_progress" && typeof step.started_at === "number" && step.ended_at === undefined;
        const took = stepDuration(step) ?? (live ? formatDuration(Math.max(now, Date.now()) - step.started_at!) : undefined);
        return (
          <li key={step.id} className="panel-row panel-step" data-status={step.status} aria-current={step.status === "in_progress" ? "step" : undefined}>
            {index < items.length - 1 && <span className="panel-step-line" aria-hidden="true" />}
            <StatusControl block={block} item={step} name={step.label}><StatusGlyph status={step.status} size={16} /></StatusControl>
            <div className="panel-step-text">
              <span className="panel-step-label">{step.label}</span>
              {step.detail && <span className="panel-step-detail">{step.detail}</span>}
            </div>
            {took ? <span className="panel-step-time" title={live ? "Running for" : "Time taken"}>{took}</span> : <span />}
            <ItemActions block={block} item={step} name={step.label} />
          </li>
        );
      })}
    </ol>
  );
}
