/**
 * The page-side probe of docs/chat-design.md §10, shared by measure-chat.ts and chat-performance.spec.ts. Install it with
 * page.addInitScript after the __name shim (tsx keeps function names with a helper page functions do not have).
 */
import type { Page } from "@playwright/test";

export interface CommitCounts { conversation: number; beforeLastUser: number; inspector: number; commits: number }

/**
 * Installed before the app loads. The Event Timing and long-animation-frame observers, and a test-only React DevTools hook that,
 * while enabled, counts the DOM nodes whose props changed in each commit, by region.
 */
export function probe(observeEvents: boolean) {
  const w = window as unknown as Record<string, unknown>;
  const events: Array<{ name: string; start: number; duration: number; interactionId: number }> = [];
  const frames: Array<{ start: number; duration: number }> = [];
  w.__perf = { events, frames, observing: false };
  if (observeEvents) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEventTiming & { interactionId?: number }>)
        events.push({ name: entry.name, start: entry.startTime, duration: entry.duration, interactionId: entry.interactionId ?? 0 });
    });
    observer.observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    observer.observe({ type: "first-input", buffered: true });
    (w.__perf as { observing: boolean }).observing = true;
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) frames.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "long-animation-frame", buffered: true });
  type Fiber = { child: Fiber | null; sibling: Fiber | null; stateNode: unknown; memoizedProps: unknown };
  const seen = new WeakMap<object, unknown>();
  const counts = { conversation: 0, beforeLastUser: 0, inspector: 0, commits: 0 };
  let enabled = false;
  let last: { current: Fiber } | undefined;
  const walk = (root: Fiber, visit: (fiber: Fiber) => void) => {
    const stack: Fiber[] = [root];
    while (stack.length) {
      const fiber = stack.pop()!;
      visit(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  };
  const snapshot = () => { if (last) walk(last.current, (fiber) => { if (fiber.stateNode instanceof Node) seen.set(fiber.stateNode, fiber.memoizedProps); }); };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject: () => 1, checkDCE: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      last = root;
      if (!enabled) return;
      counts.commits++;
      const lastUser = [...document.querySelectorAll(".conversation .message.user")].at(-1);
      walk(root.current, (fiber) => {
        const node = fiber.stateNode;
        if (!(node instanceof Node)) return;
        const changed = seen.get(node) !== fiber.memoizedProps;
        seen.set(node, fiber.memoizedProps);
        if (!changed || !node.isConnected) return;
        const element = node instanceof Element ? node : node.parentElement;
        if (!element) return;
        if (element.closest(".inspector")) counts.inspector++;
        if (!element.closest(".conversation")) return;
        counts.conversation++;
        // Before it in the document, and not one of its ancestors (the conversation itself is not "before" the message).
        if (lastUser && !lastUser.contains(element) && !element.contains(lastUser) && lastUser.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) counts.beforeLastUser++;
      });
    },
  };
  w.__commits = {
    start: () => { snapshot(); Object.assign(counts, { conversation: 0, beforeLastUser: 0, inspector: 0, commits: 0 }); enabled = true; },
    stop: () => { enabled = false; return { ...counts }; },
  };
}

/** Starts counting changed nodes from the current tree. */
export const startCommits = (page: Page) => page.evaluate(() => (window as unknown as { __commits: { start(): void } }).__commits.start());
/** Stops counting and returns the counts since startCommits. */
export const stopCommits = (page: Page) => page.evaluate(() => (window as unknown as { __commits: { stop(): CommitCounts } }).__commits.stop());
