import { useId, useRef, type PointerEvent, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Activity, ChevronRight, EyeOff, FileText, Flag, FolderTree, Gauge, ListChecks, ListOrdered, MoreHorizontal, MoveDown, MoveUp, PanelTop, Table } from "lucide-react";
import type { PanelIcon } from "../../../src/panels/contract.js";
import { derivedProgress, derivedSummary } from "../../../src/panels/render.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";

export const HEADER_HEIGHT = 28;
const icons: Record<PanelIcon, typeof Activity> = {
  "list-checks": ListChecks, "list-ordered": ListOrdered, "file-text": FileText, table: Table, activity: Activity, gauge: Gauge, "folder-tree": FolderTree, flag: Flag, panel: PanelTop,
};
export const PanelGlyph = ({ icon, size = 16 }: { icon: PanelIcon; size?: number }) => {
  const Icon = icons[icon] ?? PanelTop;
  return <Icon size={size} aria-hidden="true" />;
};

export interface SectionProps {
  /** Stable DOM key for scrolling to the section. */
  panel: string;
  title: string;
  icon?: PanelIcon;
  summary?: string | undefined;
  /** 0..1 progress drawn as a 2 px line along the header's bottom edge. */
  progress?: number | undefined;
  statusText?: string | undefined;
  /** Explanatory text (a document subtitle) shown in the header tooltip instead of the body. */
  tooltip?: string | undefined;
  unseen?: boolean;
  muted?: boolean;
  expanded: boolean;
  /** Outer height (header included) while expanded, given by the stack; content never changes it. */
  height: number;
  onToggle: () => void;
  onResize?: (height: number) => void;
  /** Header drag-to-reorder (§13.1): the parent owns the gesture, the header only reports pointer events. */
  drag?: { onPointerDown: (event: PointerEvent<HTMLDivElement>) => void; state?: "dragging" | "target" | undefined } | undefined;
  menu?: { actions?: Array<{ id: string; label: string; disabled?: string | undefined; run: () => void }> | undefined; up?: (() => void) | undefined; down?: (() => void) | undefined; hide?: (() => void) | undefined } | undefined;
  children?: ReactNode;
}
/** One accordion section (WAI-ARIA accordion): a header button with `aria-expanded`, and a body of the given height that scrolls inside. */
export function Section(props: SectionProps) {
  const id = useId();
  const { panel, title, icon, summary, progress, statusText, tooltip, unseen, muted, expanded, height, onToggle, onResize, drag, menu, children } = props;
  // Labels end with an ellipsis; the tooltip carries the full text and the explanation.
  const hint = [summary ? `${title} · ${summary}` : title, tooltip].filter(Boolean).join("\n");
  // A drag resizes from where it started: the section's top can move while other sections give up height.
  const dragStart = useRef<{ y: number; height: number } | undefined>(undefined);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!onResize || !dragStart.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onResize(dragStart.current.height + event.clientY - dragStart.current.y);
  };
  return (
    <>
      <section className={`panel-section ${expanded ? "expanded" : ""} ${muted ? "muted-section" : ""} ${drag?.state ? `drag-${drag.state}` : ""}`} data-panel={panel} style={expanded ? { height } : undefined}>
        <div
          className="panel-header"
          {...(drag ? { onPointerDown: drag.onPointerDown } : {})}
        >
          <h3>
            <button type="button" className="panel-toggle" aria-expanded={expanded} aria-controls={`${id}-body`} title={hint} onClick={onToggle}>
              <ChevronRight size={14} aria-hidden="true" className="panel-chevron" />
              {icon && <PanelGlyph icon={icon} />}
              <span className="panel-title">{title}</span>
              {summary && <span className="panel-header-summary">{summary}</span>}
              {statusText && <span className="panel-status-text">{statusText}</span>}
              {unseen && <span className="panel-unseen" role="img" aria-label="New update" />}
            </button>
          </h3>
          {menu && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="icon-button panel-menu" aria-label={`${title} section menu`} title="Section menu">
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={4} collisionPadding={8}>
                  {menu.actions?.map((entry) => (
                    <DropdownMenu.Item key={entry.id} className="workspace-menu-item" disabled={!!entry.disabled} title={entry.disabled} onSelect={entry.run}>{entry.label}</DropdownMenu.Item>
                  ))}
                  {!!menu.actions?.length && <DropdownMenu.Separator className="workspace-menu-separator" />}
                  <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.up} onSelect={() => menu.up?.()}><MoveUp size={15} aria-hidden="true" />Move up</DropdownMenu.Item>
                  <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.down} onSelect={() => menu.down?.()}><MoveDown size={15} aria-hidden="true" />Move down</DropdownMenu.Item>
                  <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.hide} onSelect={() => menu.hide?.()}><EyeOff size={15} aria-hidden="true" />Hide section</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          {progress !== undefined && <span className="panel-progress-line" aria-hidden="true" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />}
        </div>
        {expanded && (
          <div id={`${id}-body`} role="region" aria-label={title} className="panel-body" tabIndex={0}>
            <div className="panel-body-content">{children}</div>
          </div>
        )}
      </section>
      {expanded && onResize && (
        <div
          className="panel-divider"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Section height"
          aria-valuenow={Math.round(height)}
          aria-valuemin={120}
          aria-valuemax={2000}
          onKeyDown={(event) => {
            const step = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : event.key === "PageUp" ? -96 : event.key === "PageDown" ? 96 : 0;
            if (!step) return;
            event.preventDefault();
            onResize(height + step);
          }}
          onPointerDown={(event) => {
            dragStart.current = { y: event.clientY, height };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => { dragStart.current = undefined; }}
          onPointerCancel={() => { dragStart.current = undefined; }}
          onPointerMove={resize}
        />
      )}
    </>
  );
}

export const statusTextFor = (item: PanelStackItem): string | undefined =>
  item.stale ? "Stale" : item.closed ? "Closed" : item.document?.status === "done" ? "Done" : item.document?.status === "failed" ? "Failed" : undefined;
export const summaryFor = (item: PanelStackItem): string | undefined => (item.document ? derivedSummary(item.document) || undefined : "No data yet");
export const progressFor = (item: PanelStackItem): number | undefined => {
  const progress = item.document && derivedProgress(item.document);
  return progress && progress.total > 0 ? progress.done / progress.total : undefined;
};
