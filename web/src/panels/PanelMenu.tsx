import { DropdownMenu } from "radix-ui";
import { Check, EyeOff, MoreHorizontal, MoveLeft, MoveRight } from "lucide-react";

export interface TabMenu {
  actions?: Array<{ id: string; label: string; disabled?: string | undefined; run: () => void }> | undefined;
  /** View options of the tab's content, such as a checklist's "Hide completed". */
  toggles?: Array<{ id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }> | undefined;
  left?: (() => void) | undefined;
  right?: (() => void) | undefined;
  hide?: (() => void) | undefined;
}

/** The selected panel tab's `⋯` menu, in the side panel's title row (docs/side-panel-design.md §3). */
export function PanelMenu({ title, menu }: { title: string; menu: TabMenu }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-button sp-panel-menu" aria-label={`${title} panel menu`} title="Panel menu">
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
  );
}
