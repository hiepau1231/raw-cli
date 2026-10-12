/** Runs `run` once later; the returned function cancels it. */
export interface BatchScheduler {
  frame(run: () => void): () => void;
  timer(run: () => void, ms: number): () => void;
}

/** The browser's: the next animation frame, and a timer for a hidden tab, which runs no frames. */
export const browserScheduler: BatchScheduler = {
  frame: (run) => { const handle = requestAnimationFrame(run); return () => cancelAnimationFrame(handle); },
  timer: (run, ms) => { const handle = setTimeout(run, ms); return () => clearTimeout(handle); },
};

/** The longest a queued event waits when no frame runs (docs/chat-design.md §10). */
export const BATCH_TIMEOUT_MS = 100;

/**
 * Queues stream events and applies them together, in arrival order: on the next frame, or after BATCH_TIMEOUT_MS when no
 * frame runs. `flush(true)` applies the queue at once and marks it urgent, for a snapshot that must not wait behind it.
 */
export function createEventBatcher<E>(apply: (events: E[], urgent: boolean) => void, schedule: BatchScheduler) {
  let queue: E[] = [];
  let cancels: Array<() => void> = [];
  const cancel = () => { for (const stop of cancels) stop(); cancels = []; };
  const flush = (urgent = false) => {
    cancel();
    if (!queue.length) return;
    const events = queue;
    queue = [];
    apply(events, urgent);
  };
  return {
    push(event: E) {
      queue.push(event);
      if (!cancels.length) cancels = [schedule.frame(() => flush()), schedule.timer(() => flush(), BATCH_TIMEOUT_MS)];
    },
    flush,
    dispose() {
      cancel();
      queue = [];
    },
  };
}
