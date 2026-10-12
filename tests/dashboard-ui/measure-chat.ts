import { chromium, expect, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { installChatWorkspace } from "./chat-stress.js";
import { LIVE_ANSWER, LIVE_REQUEST, longScenario, longStream, seedLongChat } from "./chat-long.js";

// Run after npm run build. Measures the long chat of docs/chat-design.md §10 and writes test-results/chat-perf/report-<label>.json.
//   --label <name>    report name (default "run")
//   --assert          fail when a budget of §10 is missed
//   --strict-frames   the streaming long-animation-frame budget is 50 ms instead of 100 ms
//   --cpu <rate>      slow the CPU through the DevTools protocol; reports only
//   --turns <n>       copies of the recorded turn (default 300)
//   --no-observer     debug: run without the Event Timing observer; the run must fail as incomplete
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const label = option("--label") ?? "run";
const cpu = Number(option("--cpu") ?? 1);
const turns = Number(option("--turns") ?? 300);
const strictFrames = flag("--strict-frames");
const asserting = flag("--assert") && cpu === 1;
const observe = !flag("--no-observer");
const KEYS = 40;

/**
 * Installed before the app loads. The Event Timing and long-animation-frame observers, and a test-only React DevTools hook that,
 * while enabled, counts the DOM nodes whose props changed in each commit, by region.
 */
function probe(observeEvents: boolean) {
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
        if (lastUser && !lastUser.contains(element) && lastUser.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) counts.beforeLastUser++;
      });
    },
  };
  w.__commits = {
    start: () => { snapshot(); Object.assign(counts, { conversation: 0, beforeLastUser: 0, inspector: 0, commits: 0 }); enabled = true; },
    stop: () => { enabled = false; return { ...counts }; },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = (page: Page) => page.evaluate(() => performance.now());
/** Two frames and 100 ms, so the observers have delivered every entry of what just happened. */
const drain = async (page: Page) => { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await sleep(100); };

/** Types one character at a time through the DevTools protocol: each key is one trusted interaction. */
async function typeKeys(cdp: CDPSession, count: number, delayMs: number) {
  const letters = "the quick brown fox jumps over a lazy dog ";
  for (let index = 0; index < count; index++) {
    const char = letters[index % letters.length]!;
    const code = char === " " ? "Space" : `Key${char.toUpperCase()}`;
    const keyCode = char === " " ? 32 : char.toUpperCase().charCodeAt(0);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, code, text: char, unmodifiedText: char, windowsVirtualKeyCode: keyCode });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: char, code, windowsVirtualKeyCode: keyCode });
    await sleep(delayMs);
  }
}

interface Typing { samples: number; observed: number; complete: boolean; p50: number; p95: number; max: number }
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0; };

/**
 * Keypress→paint samples for `count` keys typed between `from` and `to`: per interaction, the longest of its keydown, keypress
 * and input entries. Keys without an entry were under the 16 ms threshold, which is only trusted when observation is complete.
 */
async function samples(page: Page, from: number, to: number, count: number, trusted: boolean): Promise<Typing & { values: number[] }> {
  await drain(page);
  const { events, observing } = await page.evaluate(() => (window as unknown as { __perf: { events: Array<{ name: string; start: number; duration: number; interactionId: number }>; observing: boolean } }).__perf);
  const byInteraction = new Map<number, number>();
  for (const event of events)
    if (event.interactionId > 0 && event.start >= from && event.start <= to && ["keydown", "keypress", "input"].includes(event.name))
      byInteraction.set(event.interactionId, Math.max(byInteraction.get(event.interactionId) ?? 0, event.duration));
  const observed = [...byInteraction.values()];
  const complete = observing && trusted && observed.length <= count;
  const values = complete ? [...observed, ...Array(count - observed.length).fill(16)] : observed;
  return { samples: complete ? count : observed.length, observed: observed.length, complete, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(0, ...values), values };
}
const longFrames = async (page: Page, from: number, to: number) => {
  const frames = (await page.evaluate(() => (window as unknown as { __perf: { frames: Array<{ start: number; duration: number }> } }).__perf.frames))
    .filter((frame) => frame.start >= from && frame.start <= to && frame.duration > 50);
  // Unrounded: the budgets compare these; the report rounds only when it prints.
  return { count: frames.length, totalMs: frames.reduce((sum, frame) => sum + frame.duration, 0), maxMs: Math.max(0, ...frames.map((frame) => frame.duration)) };
};

// A slowed CPU types slower, so the answer streams over proportionally more frames to still overlap the typing.
const scenario = cpu === 1 ? longScenario : { ...longScenario, responses: [...longScenario.responses.slice(0, -1), longStream(LIVE_ANSWER, 2400 * cpu, 10)] };
const raw = await dashboardFixture({ ...scenario, env: { HOME: realpathSync(tmpdir()) } });
installChatWorkspace(raw);
const browser = await chromium.launch();
let exit = 0;
try {
  const seedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { sessionId, records } = await seedLongChat(seedPage, raw, turns);
  await seedPage.close();
  const requestsBefore = raw.provider.requests.length;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // tsx keeps function names with a __name helper that page functions would otherwise not find.
  await page.addInitScript("globalThis.__name = (target) => target;");
  await page.addInitScript(probe, observe);
  const cdp = await page.context().newCDPSession(page);
  await page.goto(raw.server.launchUrl.replace("/#", `/chat/${encodeURIComponent(sessionId)}#`));
  const assistants = page.getByTestId("assistant-message");
  await expect(assistants.first()).toBeVisible({ timeout: 60000 });
  const side = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await side.getAttribute("aria-expanded")) !== "true") await side.click();

  // The whole history: scroll to the top and load earlier pages until there are none.
  const historyStart = Date.now();
  const scroller = page.locator(".conversation-scroll");
  for (let guard = 0; guard < 1000; guard++) {
    const before = await assistants.count();
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    const button = page.locator(".load-earlier");
    const loader = page.locator(".history-loader");
    if (!(await button.count()) && !(await loader.count())) break;
    if (await button.count()) await button.click();
    await expect.poll(async () => (await assistants.count()) > before || !((await button.count()) + (await loader.count())), { timeout: 60000 }).toBe(true);
  }
  const historyMs = Date.now() - historyStart;
  const loaded = await assistants.count();
  if (loaded !== turns) throw new Error(`expected ${turns} answers after loading the history, found ${loaded}`);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  if (cpu !== 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

  const box = page.getByRole("textbox", { name: "Message" });
  await box.focus();
  // Calibration: five keys against a listener that blocks for 80 ms must each measure at least 80 ms.
  await page.evaluate(() => {
    const block = () => { const start = performance.now(); while (performance.now() - start < 80) { /* blocking on purpose */ } };
    (window as unknown as { __block: () => void }).__block = block;
    document.addEventListener("keydown", block, true);
  });
  let from = await now(page);
  await typeKeys(cdp, 5, 150);
  const calibration = await samples(page, from, await now(page), 5, false);
  await page.evaluate(() => document.removeEventListener("keydown", (window as unknown as { __block: () => void }).__block, true));
  const calibrated = calibration.observed === 5 && calibration.values.every((value) => value >= 80);
  await box.fill("");

  // Idle: latency first, then the re-rendered nodes with the probe on (its walk would distort the latency).
  from = await now(page);
  await typeKeys(cdp, KEYS, 50);
  let to = await now(page);
  const idle = await samples(page, from, to, KEYS, calibrated);
  const loafIdle = await longFrames(page, from, to);
  await page.evaluate(() => (window as unknown as { __commits: { start(): void } }).__commits.start());
  await typeKeys(cdp, 20, 50);
  await drain(page);
  const typingIdleCommits = await page.evaluate(() => (window as unknown as { __commits: { stop(): unknown } }).__commits.stop());
  await box.fill("");

  // Streaming: send the live turn, then type while the answer grows.
  await box.fill(LIVE_REQUEST);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const live = assistants.nth(turns);
  await expect(live).toBeVisible({ timeout: 30000 });
  let growth = 0;
  await page.exposeFunction("__grew", () => { growth++; });
  await live.evaluate((element) => new MutationObserver(() => (window as unknown as { __grew(): void }).__grew()).observe(element, { childList: true, subtree: true, characterData: true }));
  await sleep(1000);
  await box.focus();
  // The typing overlaps the stream when the answer grew while the keys were typed and the turn still runs after the last one.
  const grownBefore = growth;
  from = await now(page);
  await typeKeys(cdp, KEYS, 50);
  to = await now(page);
  const overlap = growth > grownBefore && (await page.getByRole("button", { name: "Stop" }).count()) > 0;
  const streaming = await samples(page, from, to, KEYS, calibrated);
  await page.evaluate(() => (window as unknown as { __commits: { start(): void } }).__commits.start());
  const commitFrom = await now(page);
  await sleep(1500);
  const streamingCommits = await page.evaluate(() => (window as unknown as { __commits: { stop(): unknown } }).__commits.stop());
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 60000 });
  // While streaming, without the probe's own cost.
  const loafStreaming = await longFrames(page, from, commitFrom);
  const answers = await assistants.count();
  const liveRequests = raw.provider.requests.length - requestsBefore;
  if (answers !== turns + 1) throw new Error(`expected ${turns + 1} answers after the stream, found ${answers}`);
  if (liveRequests !== 1) throw new Error(`the live turn made ${liveRequests} provider requests, expected 1`);

  // Scrolling from the bottom to the top.
  from = await now(page);
  await scroller.evaluate(async (element) => {
    while (element.scrollTop > 0) { element.scrollTop -= 600; await new Promise((resolve) => requestAnimationFrame(resolve)); }
  });
  to = await now(page);
  await drain(page);
  const loafScrolling = await longFrames(page, from, to);

  const strip = ({ values: _values, ...rest }: Typing & { values: number[] }) => rest;
  const report = {
    label, cpu, turns, historyItems: records, answers, liveRequests, streamEvents: growth, historyMs,
    calibration: { samples: calibration.observed, values: calibration.values.map(Math.round), passed: calibrated },
    overlap,
    typing: { idle: strip(idle), streaming: strip(streaming) },
    loaf: Object.fromEntries(Object.entries({ idle: loafIdle, streaming: loafStreaming, scrolling: loafScrolling })
      .map(([key, value]) => [key, { count: value.count, totalMs: Math.round(value.totalMs), maxMs: Math.round(value.maxMs) }])),
    commits: { typingIdle: typingIdleCommits, streaming: streamingCommits },
  };
  mkdirSync("test-results/chat-perf", { recursive: true });
  writeFileSync(join("test-results/chat-perf", `report-${label}.json`), JSON.stringify(report, null, 2));
  console.table({
    "keypress→paint idle": { p50: idle.p50, p95: idle.p95, max: idle.max, samples: idle.samples },
    "keypress→paint streaming": { p50: streaming.p50, p95: streaming.p95, max: streaming.max, samples: streaming.samples },
  });
  console.log(JSON.stringify({ historyItems: records, answers, historyMs, streamEvents: growth, overlap, calibration: report.calibration, loaf: report.loaf, commits: report.commits }, null, 1));

  const invalid: string[] = [];
  if (!calibrated) invalid.push(`calibration failed (${calibration.observed} of 5 samples, ${calibration.values.map(Math.round).join(", ")} ms)`);
  if (!idle.complete || !streaming.complete) invalid.push("incomplete samples: observation is not complete");
  if (!overlap) invalid.push("no overlap: the answer did not grow while typing, or it ended before the last keystroke");
  if (growth === 0) invalid.push("no stream events seen");
  const failed: string[] = [];
  const frameBudget = strictFrames ? 50 : 100;
  const commits = report.commits as { typingIdle: { conversation: number; inspector: number }; streaming: { beforeLastUser: number } };
  if (idle.p95 >= 50) failed.push(`keypress→paint idle p95 ${idle.p95} ms ≥ 50 ms`);
  if (streaming.p95 >= 50) failed.push(`keypress→paint streaming p95 ${streaming.p95} ms ≥ 50 ms`);
  if (commits.typingIdle.conversation || commits.typingIdle.inspector) failed.push(`typing re-rendered ${commits.typingIdle.conversation} conversation and ${commits.typingIdle.inspector} side panel nodes`);
  if (commits.streaming.beforeLastUser) failed.push(`streaming re-rendered ${commits.streaming.beforeLastUser} nodes before the last message`);
  if (loafStreaming.maxMs > frameBudget) failed.push(`a long animation frame of ${Math.round(loafStreaming.maxMs)} ms while streaming > ${frameBudget} ms`);
  if (invalid.length) { console.error(`INVALID: ${invalid.join("; ")}`); exit = 2; }
  else if (asserting && failed.length) { console.error(`BUDGET FAILED: ${failed.join("; ")}`); exit = 1; }
  else if (failed.length) console.log(`budgets missed (not asserted): ${failed.join("; ")}`);
} finally {
  await browser.close();
  await raw.close();
}
process.exit(exit);
