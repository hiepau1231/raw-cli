import { Ban, CheckCircle2, Circle, CircleDashed, CircleX, FileCode, MinusCircle, Loader } from "lucide-react";
import type { PanelItemStatus, PanelRef } from "../../../src/panels/contract.js";

const labels: Record<PanelItemStatus, string> = {
  pending: "Pending", in_progress: "In progress", done: "Done", skipped: "Skipped", blocked: "Blocked", failed: "Failed",
};
/** A status glyph that also carries its meaning as text, so it never relies on shape or colour alone. */
export function StatusGlyph({ status, size = 15 }: { status: PanelItemStatus | undefined; size?: number }) {
  const value = status ?? "pending";
  const props = { size, "aria-hidden": true as const };
  const icon =
    value === "done" ? <CheckCircle2 {...props} /> :
    value === "in_progress" ? <Loader {...props} className="panel-spin" /> :
    value === "failed" ? <CircleX {...props} /> :
    value === "blocked" ? <Ban {...props} /> :
    value === "skipped" ? <MinusCircle {...props} /> :
    status ? <Circle {...props} /> : <CircleDashed {...props} />;
  return <span className={`panel-status status-${value}`} title={labels[value]}>{icon}<span className="sr-only">{labels[value]}</span></span>;
}

/**
 * A file reference as a chip (kvtable.png): the file name and line, the full path in its tooltip; with `folder`, the
 * folder follows it, muted. It inserts `@path` into the composer instead of opening anything.
 */
export function Ref({ value, onInsert, folder = false }: { value: PanelRef; onInsert: (path: string) => void; folder?: boolean }) {
  const cut = Math.max(value.path.lastIndexOf("/"), value.path.lastIndexOf("\\")) + 1;
  const dir = cut > 0 ? value.path.slice(0, cut - 1) : "";
  return (
    <>
      {/* The name is the whole path: the chip shows only the file's name. */}
      <button type="button" className="panel-ref" onClick={() => onInsert(value.path)} title={`Insert @${value.path} into the message`}
        aria-label={`${value.path}${value.line ? `:${value.line}` : ""}`}>
        <FileCode size={11} aria-hidden="true" /><span className="panel-ref-name">{value.path.slice(cut)}{value.line ? `:${value.line}` : ""}</span>
      </button>
      {folder && dir && <span className="panel-ref-dir" title={dir}>{dir}</span>}
    </>
  );
}
export type InsertRef = (path: string) => void;
