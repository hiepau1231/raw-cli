import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBatcher, type BatchScheduler } from "../web/src/session-batch.js";

/** A scheduler the test drives: frames and timers run only when the test says so. */
function fakeScheduler() {
  const frames = new Set<() => void>();
  const timers = new Set<{ run: () => void; ms: number }>();
  const scheduler: BatchScheduler = {
    frame: (run) => { frames.add(run); return () => frames.delete(run); },
    timer: (run, ms) => { const entry = { run, ms }; timers.add(entry); return () => timers.delete(entry); },
  };
  return {
    scheduler,
    frames,
    timers,
    runFrames: () => { const pending = [...frames]; frames.clear(); for (const run of pending) run(); },
    runTimers: () => { const pending = [...timers]; timers.clear(); for (const entry of pending) entry.run(); },
  };
}

test("events of one frame apply together, once, in arrival order", () => {
  const fake = fakeScheduler();
  const applied: Array<{ events: string[]; urgent: boolean }> = [];
  const batcher = createEventBatcher<string>((events, urgent) => applied.push({ events, urgent }), fake.scheduler);
  batcher.push("a");
  batcher.push("b");
  batcher.push("c");
  assert.equal(applied.length, 0, "nothing applies before the frame");
  assert.equal(fake.frames.size, 1, "one frame is requested for the whole batch");
  fake.runFrames();
  fake.runTimers();
  assert.deepEqual(applied, [{ events: ["a", "b", "c"], urgent: false }]);
  batcher.push("d");
  fake.runFrames();
  assert.deepEqual(applied.at(-1), { events: ["d"], urgent: false });
});

test("the timer applies the queue within 100 ms when no frame runs", () => {
  const fake = fakeScheduler();
  const applied: string[][] = [];
  const batcher = createEventBatcher<string>((events) => applied.push(events), fake.scheduler);
  batcher.push("a");
  batcher.push("b");
  assert.deepEqual([...fake.timers].map((timer) => timer.ms), [100]);
  fake.runTimers();
  assert.deepEqual(applied, [["a", "b"]]);
  assert.equal(fake.frames.size, 0, "the frame is cancelled once the timer applied the queue");
});

test("a snapshot flushed urgently applies after the queued events, in one update", () => {
  const fake = fakeScheduler();
  const applied: Array<{ events: string[]; urgent: boolean }> = [];
  const batcher = createEventBatcher<string>((events, urgent) => applied.push({ events, urgent }), fake.scheduler);
  batcher.push("a");
  batcher.push("b");
  batcher.push("snapshot");
  batcher.flush(true);
  assert.deepEqual(applied, [{ events: ["a", "b", "snapshot"], urgent: true }]);
  assert.equal(fake.frames.size + fake.timers.size, 0, "nothing is left scheduled");
  batcher.push("after");
  fake.runFrames();
  assert.deepEqual(applied.at(-1), { events: ["after"], urgent: false });
});

test("dispose cancels the pending frame and timer and drops the queue", () => {
  const fake = fakeScheduler();
  const applied: string[][] = [];
  const batcher = createEventBatcher<string>((events) => applied.push(events), fake.scheduler);
  batcher.push("a");
  batcher.dispose();
  assert.equal(fake.frames.size, 0);
  assert.equal(fake.timers.size, 0);
  batcher.flush();
  assert.deepEqual(applied, []);
});

test("an empty queue applies nothing", () => {
  const fake = fakeScheduler();
  const applied: string[][] = [];
  const batcher = createEventBatcher<string>((events) => applied.push(events), fake.scheduler);
  batcher.flush();
  batcher.flush(true);
  fake.runFrames();
  fake.runTimers();
  assert.deepEqual(applied, []);
  batcher.push("a");
  fake.runFrames();
  fake.runTimers();
  batcher.flush();
  assert.deepEqual(applied, [["a"]], "a queue applied by its frame is not applied again");
});
