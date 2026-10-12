/**
 * One chat's message-box text (docs/chat-design.md §10), kept in the map that holds every chat's draft so it survives
 * switching chats. Only the composer subscribes, so a keystroke re-renders nothing else.
 */
export interface DraftStore {
  get(): string;
  /** Replaces the draft; an empty draft removes the chat's entry. Subscribers hear only a real change. */
  set(value: string): void;
  subscribe(listener: () => void): () => void;
}

export function createDraftStore(id: string, drafts: Map<string, string>): DraftStore {
  const listeners = new Set<() => void>();
  const get = () => drafts.get(id) ?? "";
  return {
    get,
    set(value) {
      if (value === get()) return;
      if (value) drafts.set(id, value);
      else drafts.delete(id);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
