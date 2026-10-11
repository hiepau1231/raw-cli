import { DropdownMenu } from "radix-ui";
import { Check, EyeOff, MoreHorizontal, MoveLeft, MoveRight } from "lucide-react";
import type { PanelSummary } from "./summaries.js";
import { SummaryStatus } from "./Overview.js";

export interface TabMenu {
  actions?: Array<{ id: string; label: string; disabled?: string | undefined; run: () => void }> | undefined;
  /** View options of the tab's content, such as a checklist's "Hide completed". */
  toggles?: Array<{ id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }> | undefined;
  left?: (() => void) | undefined;
  right?: (() => void) | undefined;
  hide?: (() => void) | undefined;
}

/** The header of a panel tab: full title, the muted summary, status, and the `⋯` menu (docs/side-panel-design.md §3). */
export function TabHeader({ title, tooltip, summary, menu }: {
  title: string;
  /** The document's explanation (its subtitle), shown as the title's tooltip instead of in the body. */
  tooltip?: string | undefined;
  summary?: PanelSummary | undefined;
  menu?: TabMenu | undefined;
}) {
  return (
    <div className="sp-tab-header">
      <div className="sp-tab-heading">
        <h3 title={[title, tooltip].filter(Boolean).join("\n")}>{title}</h3>
        {summary?.summary && <p className="sp-tab-summary" title={summary.summary}>{summary.summary}</p>}
      </div>
      {summary && <SummaryStatus summary={{ chips: summary.chips, lines: [], ...(summary.status ? { status: summary.status } : {}) }} />}
      {menu && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="icon-button sp-tab-menu" aria-label={`${title} panel menu`} title="Panel menu">
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="workspace-menu" align="end" sideOffset={4} collisionPadding={8}>
              {menu.actions?.map((entry) => (
                <DropdownMenu.Item key={entry.id} className="workspace-menu-item" disabled={!!entry.disabled} title={entry.disabled} onSelect={entry.run}>{entry.label}</DropdownMenu.Item>
              ))}
              {!!menu.actions?.length && <DropdownMenu.Separator className="workspace-menu-separator" />}
              {menu.toggles?.map((entry) => (
                <DropdownMenu.CheckboxItem key={entry.id} className="workspace-menu-item" checked={entry.checked} onCheckedChange={(checked) => entry.onChange(checked === true)}>
                  <span className="agent-menu-check">
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  {entry.label}
                </DropdownMenu.CheckboxItem>
              ))}
              {!!menu.toggles?.length && <DropdownMenu.Separator className="workspace-menu-separator" />}
              <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.left} onSelect={() => menu.left?.()}><MoveLeft size={15} aria-hidden="true" />Move left</DropdownMenu.Item>
              <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.right} onSelect={() => menu.right?.()}><MoveRight size={15} aria-hidden="true" />Move right</DropdownMenu.Item>
              <DropdownMenu.Item className="workspace-menu-item" disabled={!menu.hide} onSelect={() => menu.hide?.()}><EyeOff size={15} aria-hidden="true" />Hide tab</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
