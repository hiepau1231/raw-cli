import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Gauge, LayoutGrid, SquareTerminal } from "lucide-react";
import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
import type { ContextUsageInput } from "../composer/context-usage.js";
import { Commands } from "./Commands.js";
import { COMMANDS_ID, commandRunning } from "./commands-state.js";
import { offeredActions, type ActionHost } from "./actions.js";
import { ToolView } from "./ToolView.js";
import { sidebarPresentation } from "./interaction-state.js";
import { Overview, type OverviewCard } from "./Overview.js";
import { TabHeader, type TabMenu } from "./TabHeader.js";
import { PanelGlyph, TabStrip, type TabSpec } from "./Tabs.js";
import { summarizeCommands, summarizeContext, summarizePanel, type PanelSummary } from "./summaries.js";
import {
  DETAILS_ID, OVERVIEW_ID, activeTab, currentOrder, layout, markSeen, move, newAnnouncer, placeAt, planAnnouncements, rejectedCode, setHidden,
  setHideCompleted, setOrder, setTab, unseen,
  type PanelPrefs,
} from "./panel-state.js";
import type { InsertRef } from "./status.js";

export interface SidePanelProps {
  commands?: readonly CommandRecord[];
  /** How many older commands the server left out beyond its row limit. */
  commandsOmitted?: number | undefined;
  /** A command's directory shows only when it differs from this. */
  sessionCwd?: string | undefined;
  sessionId: string;
  agent: string | null;
  items: PanelStackItem[];
  prefs: PanelPrefs;
  setPrefs: Dispatch<SetStateAction<PanelPrefs>>;
  history: ReadonlyArray<{ panelReceipt?: { panel: string; owner: string; error?: { code: string } } }>;
  onInsert: InsertRef;
  /** Runs panel actions; without it no action is offered. */
  actions?: ActionHost | undefined;
  /** The session's context measurement, for the Details badge and the Overview Context card. */
  context?: ContextUsageInput | undefined;
  /** The Details tab content (the former inspector). */
  details: ReactNode;
}

const iconFor = (item: PanelStackItem) => (item.panel === COMMANDS_ID ? <SquareTerminal size={15} aria-hidden="true" /> : <PanelGlyph icon={item.icon} size={15} />);

/** The side panel: Overview, one tab per shown panel, and Details (docs/side-panel-design.md §3). */
export function SidePanel({ commands = [], commandsOmitted, sessionCwd, sessionId, agent, items, prefs, setPrefs, history, onInsert, actions, context, details }: SidePanelProps) {
  const base = useId();
  const panelId = `${base}-panel`;
  // Panel ids hold `/` and `#`; each other character is escaped as `-<hex>`, so two ids never share a DOM id.
  const idOf = (tab: string) => `${base}-tab-${tab.replace(/[^\w]/g, (char) => `-${char.charCodeAt(0).toString(16)}`)}`;
  const [announced, setAnnounced] = useState("");
  const announcer = useRef(newAnnouncer());
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Running commands' durations in the Overview tick while they run.
  const [, setTick] = useState(0);
  const now = Date.now();
  const running = commands.some(commandRunning);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const { visible, hidden } = layout(items, prefs, agent);
  const order = currentOrder(items, prefs, agent);
  const hiddenIds = new Set(hidden.map((item) => item.panel));
  const active = activeTab(prefs, sessionId, visible.map((item) => item.panel));
  const select = (tab: string) => setPrefs((old) => setTab(old, sessionId, tab));
  // A card the user opens unmounts with Overview, so focus moves to the tab it opened. Only that click moves focus.
  const content = useRef<HTMLDivElement>(null);
  const focusContent = useRef(false);
  const open = (tab: string) => { focusContent.current = true; select(tab); };
  useEffect(() => {
    if (!focusContent.current) return;
    focusContent.current = false;
    content.current?.focus();
  }, [active]);
  // The header and cards describe the document the tab shows, which may be a sidebar interaction's.
  const shownOf = (item: PanelStackItem) => sidebarPresentation(item, actions?.interactions ?? []);
  const summaryOf = (item: PanelStackItem): PanelSummary => (item.panel === COMMANDS_ID ? summarizeCommands(commands, now) : summarizePanel(shownOf(item)));
  const contextSummary = summarizeContext(context);
  // What someone can read counts as seen: the selected tab, at its current revision, while the side panel is open.
  const selected = visible.find((item) => item.panel === active);
  useEffect(() => {
    if (selected) setPrefs((old) => markSeen(old, sessionId, selected.panel, selected.revision));
  }, [selected?.panel, selected?.revision, sessionId]);
  // Polite progress announcements: one pass speaks every changed panel, at most once per 5 s each; a text held back by
  // its window is delivered when the window ends.
  useEffect(() => {
    const run = () => {
      const { say, wait } = planAnnouncements(announcer.current, items, Date.now());
      if (say) setAnnounced(say);
      clearTimeout(announceTimer.current);
      if (wait !== undefined) announceTimer.current = setTimeout(run, wait + 20);
    };
    run();
    return () => clearTimeout(announceTimer.current);
  }, [items]);
  const menuFor = (item: PanelStackItem): TabMenu => {
    const shown = order.filter((id) => !hiddenIds.has(id));
    const at = shown.indexOf(item.panel);
    const reorder = (direction: "up" | "down") => setPrefs((old) => setOrder(old, agent, move(currentOrder(items, old, agent), item.panel, direction, new Set(layout(items, old, agent).hidden.map((entry) => entry.panel)))));
    const own = actions && item.panel !== COMMANDS_ID ? offeredActions(item, actions, "panel").map((entry) => ({ id: entry.action.id, label: entry.action.label, disabled: entry.disabled, run: entry.run })) : [];
    return {
      actions: own,
      toggles: shownOf(item).document?.blocks.some((block) => block.kind === "checklist")
        ? [{ id: "hide-completed", label: "Hide completed", checked: prefs.hideCompleted, onChange: (value: boolean) => setPrefs((old) => setHideCompleted(old, value)) }]
        : [],
      left: at > 0 ? () => reorder("up") : undefined,
      right: at >= 0 && at < shown.length - 1 ? () => reorder("down") : undefined,
      hide: () => setPrefs((old) => setHidden(old, agent, item.panel, true)),
    };
  };
  const tabs: TabSpec[] = [
    { id: OVERVIEW_ID, title: "Overview", icon: <LayoutGrid size={15} aria-hidden="true" />, movable: false },
    ...visible.map((item): TabSpec => {
      const summary = summaryOf(item);
      return { id: item.panel, title: item.title, icon: iconFor(item), badge: summary.badge, status: summary.status, unseen: unseen(prefs, sessionId, item), movable: true };
    }),
    { id: DETAILS_ID, title: "Details", icon: <Gauge size={15} aria-hidden="true" />, badge: contextSummary?.badge, movable: false },
  ];
  const cards: OverviewCard[] = [
    ...visible.map((item) => ({ id: item.panel, title: item.title, icon: iconFor(item), summary: summaryOf(item) })),
    ...(contextSummary ? [{ id: DETAILS_ID, title: "Context", icon: <Gauge size={15} aria-hidden="true" />, summary: contextSummary }] : []),
  ];
  const body = () => {
    if (active === OVERVIEW_ID)
      return <Overview cards={cards} hidden={hidden.map((item) => ({ id: item.panel, title: item.title }))} onOpen={open} onShow={(panel) => setPrefs((old) => setHidden(old, agent, panel, false))} />;
    if (active === DETAILS_ID) return <><TabHeader title="Details" summary={contextSummary} />{details}</>;
    const item = selected!;
    const rejected = rejectedCode(history, item.panel);
    return (
      <>
        <TabHeader title={item.title} tooltip={shownOf(item).document?.subtitle} summary={summaryOf(item)} menu={menuFor(item)} />
        {item.panel === COMMANDS_ID ? <Commands items={commands} omitted={commandsOmitted} sessionId={sessionId} sessionCwd={sessionCwd} onInsert={onInsert} /> : (
          <ToolView item={item} actions={actions} onInsert={onInsert} hideCompleted={prefs.hideCompleted}>
            {rejected && <p className="panel-banner error" role="note">Update rejected: {rejected}</p>}
          </ToolView>
        )}
      </>
    );
  };
  return (
    <div className="side-panel">
      <TabStrip tabs={tabs} active={active} panelId={panelId} idOf={idOf} onSelect={select}
        onDrop={(tab, target) => setPrefs((old) => setOrder(old, agent, placeAt(currentOrder(items, old, agent), tab, target)))} />
      {/* A new key per tab starts each tab at its top; updates inside a tab keep the element, so nothing scrolls. */}
      <div key={active} ref={content} className="sp-content" role="tabpanel" id={panelId} aria-labelledby={idOf(active)} tabIndex={0} data-tab-panel={active}>
        {body()}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announced}</span>
    </div>
  );
}
