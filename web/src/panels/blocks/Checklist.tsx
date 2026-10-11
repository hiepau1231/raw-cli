import { createContext, useContext, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { ChecklistItem, PanelItemStatus } from "../../../../src/panels/contract.js";
import { ItemActions, StatusControl } from "../actions.js";
import { Ref, StatusGlyph, type InsertRef } from "../status.js";

const settled = (status: PanelItemStatus | undefined) => status === "done" || status === "skipped";
/** The whole subtree is done or skipped. */
const finished = (item: ChecklistItem): boolean => settled(item.status) && (item.children ?? []).every(finished);
const active = (item: ChecklistItem): boolean => item.status === "in_progress" || (item.children ?? []).some(active);
const leaves = (items: readonly ChecklistItem[]): ChecklistItem[] => items.flatMap((item) => item.children?.length ? leaves(item.children) : [item]);
const WORDS: Partial<Record<PanelItemStatus, string>> = { blocked: "Blocked", failed: "Failed" };

/** The panel a block belongs to, so per-panel choices (the Completed row) survive switching tabs. */
export const PanelScope = createContext("");
/** Open Completed rows for this page, by panel and block. */
const completedOpen = new Map<string, boolean>();

/** The controls of a row, by role, so focus returns to the same one even when an update adds or removes another. */
const CONTROLS = [".panel-disclosure", ".panel-glyph-button", ".panel-ref", ".panel-action-menu"];

type Group = "now" | "next";
interface Tree { collapsed: ReadonlySet<string>; toggle: (id: string) => void }
function Items({ block, items, group, state, onInsert, hideCompleted }: { block: string; items: readonly ChecklistItem[]; group: Group | "completed"; state: Tree; onInsert: InsertRef; hideCompleted: boolean }) {
  // Hide completed drops finished subtrees inside unfinished ones, never an unfinished descendant.
  const shown = hideCompleted && group !== "completed" ? items.filter((item) => !finished(item)) : items;
  // Rows keep a disclosure column only where a sibling can expand.
  const tree = shown.some((item) => item.children?.length);
  return (
    <ul className="panel-checklist">
      {shown.map((item) => {
        const nested = !!item.children?.length;
        const closed = state.collapsed.has(item.id);
        const running = item.status === "in_progress";
        const word = WORDS[item.status ?? "pending"];
        // The item in progress shows its note; the others keep label and note in the label's tooltip.
        const noteLine = running && item.note;
        const full = item.note && !noteLine ? `${item.label}\n${item.note}` : item.label;
        return (
          <li key={item.id} className="todo-item" data-id={item.id} data-status={item.status ?? "pending"}>
            <div className="panel-row todo-row">
              {nested ? (
                <button type="button" className="panel-disclosure" aria-expanded={!closed} aria-label={`${closed ? "Expand" : "Collapse"} ${item.label}`}
                  onClick={() => state.toggle(item.id)}>
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              ) : tree && <span className="panel-disclosure-space" aria-hidden="true" />}
              <StatusControl block={block} item={item} name={item.label}><StatusGlyph status={item.status} /></StatusControl>
              <span className="todo-text">
                <span className={`todo-label${settled(item.status) ? " panel-done" : ""}${running && group === "now" ? " todo-current" : ""}`} title={full}>{item.label}</span>
                {word && <span className={`todo-state status-${item.status}`} aria-hidden="true">{word}</span>}
                {noteLine && <span className="todo-note">{item.note}</span>}
              </span>
              {item.priority && <small className="panel-tag">{item.priority}</small>}
              {item.ref && <Ref value={item.ref} onInsert={onInsert} />}
              <ItemActions block={block} item={item} name={item.label} />
            </div>
            {nested && !closed ? <Items block={block} items={item.children!} group={group} state={state} onInsert={onInsert} hideCompleted={hideCompleted} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A checklist (docs/side-panel-design.md §5): "N of M done" and a bar, then the top-level subtrees grouped so a hierarchy
 * is never split: Now (anything in progress), Next (anything unfinished) and one Completed row.
 */
export function Checklist({ block, title, items, onInsert, hideCompleted }: { block: string; title?: string | undefined; items: ChecklistItem[]; onInsert: InsertRef; hideCompleted: boolean }) {
  const scope = useContext(PanelScope);
  const key = `${scope}\u0000${block}`;
  const [open, setOpen] = useState(() => completedOpen.get(key) ?? false);
  const all = leaves(items);
  const done = all.filter((item) => settled(item.status)).length;
  const now = items.filter(active);
  const next = items.filter((item) => !active(item) && !finished(item));
  const completed = items.filter(finished);
  const skipped = completed.filter((item) => item.status === "skipped").length;
  const label = `Completed ${completed.length}${skipped ? ` · skipped ${skipped}` : ""}`;
  const toggle = () => { completedOpen.set(key, !open); setOpen(!open); };
  // Disclosure state belongs to the checklist, so a subtree keeps it when an update moves it to another group.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const state: Tree = { collapsed, toggle: (id) => setCollapsed((old) => { const next = new Set(old); if (!next.delete(id)) next.add(id); return next; }) };
  // Moving a subtree remounts its rows: the focused control is focused again at its new place, without scrolling.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<{ element: HTMLElement; id: string; control: string }>(undefined);
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const control = target.closest(".todo-row") ? CONTROLS.find((selector) => target.matches(selector)) : undefined;
    const id = target.closest<HTMLElement>(".todo-item")?.dataset.id;
    focused.current = control && id !== undefined ? { element: target, id, control } : undefined;
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Focus that moved elsewhere, or a click on nothing, forgets the control; a removed control is restored by the effect below.
    if (event.relatedTarget) focused.current = undefined;
    else queueMicrotask(() => { if (focused.current?.element === target && target.isConnected && document.activeElement !== target) focused.current = undefined; });
  };
  useLayoutEffect(() => {
    const last = focused.current;
    if (!last || last.element.isConnected || !root.current) return;
    if (document.activeElement && document.activeElement !== document.body) { focused.current = undefined; return; }
    const row = [...root.current.querySelectorAll<HTMLElement>(".todo-item")].find((element) => element.dataset.id === last.id)?.querySelector(":scope > .todo-row");
    const target = row?.querySelector<HTMLElement>(last.control);
    if (target) target.focus({ preventScroll: true });
    else focused.current = undefined;
  });
  const lists = { block, state, onInsert };
  return (
    <div className="todo" ref={root} onFocus={onFocus} onBlur={onBlur}>
      {(title || all.length > 0) && (
        <div className="todo-head">
          {title && <h4 className="todo-title">{title}</h4>}
          {all.length > 0 && <span className="todo-count">{done} of {all.length} done</span>}
        </div>
      )}
      {all.length > 0 && <span className="sp-bar todo-bar" aria-hidden="true"><i style={{ width: `${(done / all.length) * 100}%` }} /></span>}
      {now.length > 0 && (
        <section className="todo-group todo-now" data-group="now" aria-label="Now">
          <div className="todo-kicker" aria-hidden="true">Now</div>
          <Items {...lists} items={now} group="now" hideCompleted={hideCompleted} />
        </section>
      )}
      {next.length > 0 && (
        <section className="todo-group" data-group="next" aria-label="Next">
          <div className="todo-group-label" aria-hidden="true">Next</div>
          <Items {...lists} items={next} group="next" hideCompleted={hideCompleted} />
        </section>
      )}
      {completed.length > 0 && !hideCompleted && (
        <section className="todo-group" data-group="completed">
          <button type="button" className="todo-completed-toggle" aria-expanded={open} onClick={toggle}>
            <ChevronRight size={12} aria-hidden="true" className="panel-chevron" />{label}
          </button>
          {open && <Items {...lists} items={completed} group="completed" hideCompleted={false} />}
        </section>
      )}
    </div>
  );
}
