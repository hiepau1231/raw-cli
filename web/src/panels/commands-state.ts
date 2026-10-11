import type { CommandRecord } from "../../../src/processes/presentation.js";
import type { PanelStackItem } from "../../../src/panels/stack.js";
export const COMMANDS_ID = "__commands";
export const commandRunning = (item: CommandRecord) => ["starting", "running", "stopping"].includes(item.state);
/** A local layout descriptor only: never submitted to PanelHost or exposed as tool authority. */
export function commandsSection(commands: readonly CommandRecord[]): PanelStackItem {
  const revision = commands.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  return { panel: COMMANDS_ID, owner: "", title: "Commands", icon: "activity", revision, updatedAt: revision || null, closed: false, stale: false,
    declaration: { id: COMMANDS_ID, title: "Commands", icon: "activity", open: "never", context: "none", acp_plan: false, actions: [] },
    document: commands.length ? { blocks: [], summary: `${commands.filter(commandRunning).length} running · ${commands.length} total` } : null };
}
/** Strip OSC (including hyperlinks), CSI and remaining terminal controls; never interpret terminal markup as HTML. */
export function terminalText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Command groups of the Commands section (docs/tool-ux-design.md §6.4). */
export type CommandGroup = "running" | "completed";
export const commandsStorageKey = "raw.dashboard.commands.v1";
/** Sessions whose group choices are kept; the least recently changed are dropped first. */
export const MAX_COMMAND_SESSIONS = 200;
export interface CommandGroupPrefs { version: 1; sessions: Record<string, { running?: boolean; completed?: boolean; at: number }> }

const storage = (): Storage | undefined => {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
};
/** Corrupt or foreign storage falls back to the defaults, entry by entry. */
export function loadCommandGroups(from: Pick<Storage, "getItem"> | undefined = storage()): CommandGroupPrefs {
  const prefs: CommandGroupPrefs = { version: 1, sessions: {} };
  try {
    const raw = JSON.parse(from?.getItem(commandsStorageKey) ?? "null") as { version?: unknown; sessions?: unknown } | null;
    if (raw?.version !== 1 || !raw.sessions || typeof raw.sessions !== "object") return prefs;
    for (const [id, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      prefs.sessions[id] = { at: typeof entry.at === "number" ? entry.at : 0,
        ...(typeof entry.running === "boolean" ? { running: entry.running } : {}),
        ...(typeof entry.completed === "boolean" ? { completed: entry.completed } : {}) };
    }
  } catch { /* the defaults */ }
  return prefs;
}
export function saveCommandGroups(prefs: CommandGroupPrefs, to: Pick<Storage, "setItem"> | undefined = storage()): void {
  try { to?.setItem(commandsStorageKey, JSON.stringify(prefs)); } catch { /* storage full or disabled: the choice lasts this page */ }
}
/** Running is open and Completed collapsed until the user chooses otherwise for the session. */
export const groupOpen = (prefs: CommandGroupPrefs, sessionId: string, group: CommandGroup): boolean =>
  prefs.sessions[sessionId]?.[group] ?? group === "running";
export function setGroupOpen(prefs: CommandGroupPrefs, sessionId: string, group: CommandGroup, open: boolean, now = Date.now()): CommandGroupPrefs {
  const sessions = { ...prefs.sessions, [sessionId]: { ...prefs.sessions[sessionId], [group]: open, at: now } };
  const kept = Object.entries(sessions).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_COMMAND_SESSIONS);
  return { version: 1, sessions: Object.fromEntries(kept) };
}

/**
 * The page's group choices, outside any section body: a collapsed section unmounts its body, and storage may be full or
 * disabled, so the choices live here first and are saved best-effort. A change starts from storage, so choices another
 * tab made for other sessions are kept, and this page's choices win.
 */
export function commandGroupStore(from: () => Pick<Storage, "getItem" | "setItem"> | undefined = storage) {
  let memory: CommandGroupPrefs | undefined;
  return {
    get: (): CommandGroupPrefs => (memory ??= loadCommandGroups(from())),
    set(sessionId: string, group: CommandGroup, open: boolean, now = Date.now()): CommandGroupPrefs {
      const stored = loadCommandGroups(from());
      memory = setGroupOpen({ version: 1, sessions: { ...stored.sessions, ...memory?.sessions } }, sessionId, group, open, now);
      saveCommandGroups(memory, from());
      return memory;
    },
  };
}
export const commandGroups = commandGroupStore();
