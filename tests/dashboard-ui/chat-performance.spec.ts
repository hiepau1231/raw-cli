import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { ASK, chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";
import { LIVE_ANSWER, LIVE_REQUEST, longStream, seedLongChat, turnTag } from "./chat-long.js";
import { probe, startCommits, stopCommits } from "./perf-probe.js";
import { openAiFrame } from "../fixtures/mock-provider.js";

// docs/chat-design.md §10 on a 60-turn long chat: what typing and streaming re-render, and what they must not lose.
// After the first stress turn: a streamed answer, the question and its answer.
test.use({ scenario: { ...chatScenario, responses: [...chatScenario.responses.slice(0, 5), longStream(LIVE_ANSWER, 600, 10), chatScenario.responses[7]!, chatScenario.responses[8]!] } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Raw = Parameters<typeof seedLongChat>[1];

/** Seeds the long chat in a page of its own and opens it with the commit probe installed. */
async function openLong(page: Page, raw: Raw, turns = 60) {
  installChatWorkspace(raw as unknown as { root: string });
  const seed = await page.context().newPage();
  const { sessionId } = await seedLongChat(seed, raw, turns);
  await seed.close();
  await page.addInitScript("globalThis.__name = (target) => target;");
  await page.addInitScript(probe, false);
  await page.addInitScript(droppableStream);
  await page.goto(raw.server.launchUrl.replace("/#", `/chat/${encodeURIComponent(sessionId)}#`));
  await expect(page.getByTestId("assistant-message").first()).toBeVisible({ timeout: 30000 });
  return sessionId;
}
/**
 * Wraps the session event stream so the test can drop it. The page then reconnects as after a network error, without its
 * cursor, so the server answers with a full snapshot.
 */
function droppableStream() {
  const w = window as unknown as { fetch: typeof fetch; __drop?: () => void; __fresh?: boolean; __reconnects?: number };
  const original = w.fetch.bind(window);
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/events")) return original(input, init);
    if (w.__fresh) {
      w.__fresh = false;
      const headers = new Headers(init?.headers);
      headers.delete("Last-Event-ID");
      init = { ...init, headers };
      w.__reconnects = (w.__reconnects ?? 0) + 1;
    }
    const response = await original(input, init);
    const reader = response.body!.getReader();
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => { try { controller.close(); } catch { /* already closed */ } void reader.cancel().catch(() => {}); };
        void (async () => {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return close();
            try { controller.enqueue(chunk.value); } catch { return; }
          }
        })().catch(() => close());
      },
    });
    w.__drop = () => { w.__fresh = true; close(); };
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
async function send(page: Page, text: string) {
  await box(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
/** Marks a node so a later check can tell it is the same DOM node, not a remounted copy. */
const mark = (locator: Locator, name: string) => locator.evaluate((element, value) => { element.setAttribute("data-kept", value); }, name);
const kept = (page: Page, name: string) => page.locator(`[data-kept="${name}"]`);
/** Flips a tool card's disclosure and returns the state it now has. */
async function flipCard(card: Locator) {
  const toggle = card.locator(".tool-toggle");
  const next = (await toggle.getAttribute("aria-expanded")) === "true" ? "false" : "true";
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", next);
  return next;
}
async function openGroup(group: Locator) {
  const toggle = group.locator(".work-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
/** Sends the long answer and resolves once it is streaming. */
async function startStream(page: Page) {
  await send(page, LIVE_REQUEST);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("assistant-message").last()).toContainText("Lần kiểm tra 1", { timeout: 30000 });
}
async function openSide(page: Page) {
  const side = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await side.getAttribute("aria-expanded")) !== "true") await side.click();
  await expect(page.locator(".inspector")).toBeVisible();
}
const streamDone = (page: Page) => expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 60000 });
const frames = (page: Page, count: number) => page.evaluate((n) => new Promise<void>((resolve) => {
  const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(n);
}), count);
/**
 * Holds each earlier-history response until `release` (or for good after `open`), and records the requests' cursors and
 * how many were in flight at once.
 */
async function holdHistory(page: Page, delayMs = 0) {
  const held = { cursors: [] as string[], inFlight: 0, most: 0, open: false, gates: [] as Array<() => void> };
  await page.route(/\/history\?before=/, async (route) => {
    held.cursors.push(new URL(route.request().url()).searchParams.get("before") ?? "");
    held.most = Math.max(held.most, ++held.inFlight);
    if (!held.open) await new Promise<void>((resolve) => held.gates.push(resolve));
    if (delayMs) await sleep(delayMs);
    const response = await route.fetch();
    held.inFlight--;
    await route.fulfill({ response });
  });
  const release = () => { for (const go of held.gates.splice(0)) go(); };
  return { held, release, open: () => { held.open = true; release(); } };
}
/** Scrolls to the top until the whole history has loaded. */
async function loadAll(page: Page) {
  const scroller = page.locator(".conversation-scroll");
  await expect.poll(async () => {
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    return page.locator(".history-loader").count();
  }, { timeout: 60000, intervals: [50] }).toBe(0);
}

test("typing changes no node in the conversation or the side panel", async ({ page, raw }) => {
  await openLong(page, raw);
  await openSide(page);
  await box(page).focus();
  await startCommits(page);
  await page.keyboard.type("the quick brown fox j", { delay: 30 });
  await sleep(200);
  const counts = await stopCommits(page);
  await expect(box(page)).toHaveValue("the quick brown fox j");
  expect(counts.commits, "the probe saw the composer's commits").toBeGreaterThan(0);
  expect(counts.conversation).toBe(0);
  expect(counts.inspector).toBe(0);
});

test("a streaming answer changes no node before the last message you sent", async ({ page, raw }) => {
  await openLong(page, raw);
  await startStream(page);
  // Your message can reach the history after its answer starts: the answer stays the same node all the same.
  await mark(page.getByTestId("assistant-message").last(), "answer");
  await startCommits(page);
  await sleep(1000);
  const counts = await stopCommits(page);
  expect(counts.conversation, "the live answer grew").toBeGreaterThan(0);
  expect(counts.beforeLastUser).toBe(0);
  await streamDone(page);
  await expect(kept(page, "answer")).toContainText("Lần kiểm tra 24");
  await expect(page.getByTestId("user-message").last()).toContainText(LIVE_REQUEST);
});

test.describe("a turn that starts with reasoning", () => {
  const stream = longStream(LIVE_ANSWER, 600, 10);
  test.use({ scenario: { ...chatScenario, responses: [...chatScenario.responses.slice(0, 5),
    { ...stream, frames: [openAiFrame({ reasoning: "Đọc lại các lần kiểm tra trước rồi tổng hợp." }), ...stream.frames!] }] } });

  test("its first Work group changes no node before the message you sent", async ({ page, raw }) => {
    await openLong(page, raw);
    await startCommits(page);
    await startStream(page);
    const counts = await stopCommits(page);
    await expect(page.locator(".work-group").last()).toContainText("Working");
    expect(counts.conversation, "the new turn rendered").toBeGreaterThan(0);
    expect(counts.beforeLastUser).toBe(0);
  });
});

test("an open group, an open tool card and a typed answer survive a streamed turn and a reconnect", async ({ page, raw }) => {
  await openLong(page, raw);
  // An older turn's Work group and its edit's card, marked first: near the top, earlier pages load in above them.
  await mark(page.locator(".work-group").nth(1), "group");
  const group = kept(page, "group");
  await openGroup(group);
  const card = group.locator('.tool-row[data-kind="edit"]');
  await mark(card, "card");
  const cardState = await flipCard(kept(page, "card"));
  await startStream(page);
  await streamDone(page);
  await send(page, ASK);
  const view = page.locator(".inline-tool-view").last();
  await view.getByRole("radio", { name: "Other…", exact: true }).check({ timeout: 30000 });
  const answer = view.getByRole("textbox", { name: "Other", exact: true });
  await answer.fill("Sửa những liên kết còn sửa được");
  await mark(answer, "answer");
  // Drop the event stream: the page reconnects and the server sends a snapshot.
  await page.evaluate(() => (window as unknown as { __drop(): void }).__drop());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __reconnects?: number }).__reconnects), { timeout: 10000 }).toBe(1);
  await sleep(1000);
  await expect(kept(page, "group").locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(kept(page, "card").locator(".tool-toggle")).toHaveAttribute("aria-expanded", cardState);
  await expect(kept(page, "answer")).toHaveValue("Sửa những liên kết còn sửa được");
});

test("drafts: a prompt action fills the box, @path is appended, and each chat keeps its own", async ({ page, raw }) => {
  installChatWorkspace(raw as unknown as { root: string });
  await seedChat(page, raw, "answer");
  const chat = page.url();
  await openSide(page);
  await page.getByRole("button", { name: "Todo panel menu" }).click();
  await page.getByRole("menuitem", { name: "Continue" }).click();
  await expect(box(page)).toHaveValue("Continue with the next pending todo item.");
  await page.getByRole("tab", { name: /Files changed/ }).click();
  await page.getByRole("button", { name: "Insert @scripts/check-links.mjs into the message" }).click();
  await expect(box(page)).toHaveValue("Continue with the next pending todo item. @scripts/check-links.mjs ");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(box(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.goBack();
  expect(page.url()).toBe(chat);
  await expect(box(page)).toHaveValue("Continue with the next pending todo item. @scripts/check-links.mjs ");
});

test("the last turn's open group and card stay open when it settles under the next message", async ({ page, raw }) => {
  await openLong(page, raw);
  const group = page.locator(".work-group").last();
  await openGroup(group);
  const card = group.locator('.tool-row[data-kind="edit"]');
  const cardState = await flipCard(card);
  await mark(group, "group");
  await mark(card, "card");
  await startStream(page);
  await expect(kept(page, "group").locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
  await streamDone(page);
  await expect(kept(page, "group").locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(kept(page, "card").locator(".tool-toggle")).toHaveAttribute("aria-expanded", cardState);
});

test("a Work group cut by the history page keeps its state when the earlier page arrives", async ({ page, raw }) => {
  const history = await holdHistory(page);
  await openLong(page, raw, 10);
  // The snapshot's 50 records start inside a turn's Work group: the timeline begins with that group.
  const conversation = page.locator(".conversation");
  const first = conversation.locator(".message, .work-group").first();
  await expect(first).toHaveClass(/work-group/);
  await openGroup(first);
  const rows = await first.locator(".tool-row").count();
  const card = first.locator(".tool-row").last();
  const cardState = await flipCard(card);
  await mark(first, "group");
  await mark(card, "card");
  // Opening the group at the top asked for the earlier page; it arrives now.
  history.open();
  await expect(kept(page, "group").locator(".tool-row")).not.toHaveCount(rows);
  expect(await kept(page, "group").locator(".tool-row").count()).toBeGreaterThan(rows);
  await expect(kept(page, "group").locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(kept(page, "card").locator(".tool-toggle")).toHaveAttribute("aria-expanded", cardState);
  // The group's own turn now starts with your message, right before it.
  expect(await kept(page, "group").evaluate((element) => {
    let previous = element.previousElementSibling;
    while (previous && !previous.matches(".message, .work-group")) previous = previous.previousElementSibling;
    return previous?.className;
  })).toBe("message user");
});

// Off-screen entries skip layout and paint (docs/chat-design.md §10) but stay in the page for search, selection and assistive tech.
test.describe("off-screen entries", () => {
  /** Opens the 60-turn chat with its whole history loaded, scrolled to the bottom. */
  async function openAll(page: Page, raw: Raw) {
    await openLong(page, raw);
    const scroller = page.locator(".conversation-scroll");
    await loadAll(page);
    await expect(page.getByTestId("assistant-message")).toHaveCount(60);
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await frames(page, 3);
    return scroller;
  }
  /** Whether `locator`'s element intersects the scroller's viewport. */
  const inView = (locator: Locator) => locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = element.closest(".conversation-scroll")!.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom;
  });
  const answer = (page: Page, n: number) => page.getByTestId("assistant-message").filter({ hasText: turnTag(n) });
  /** Whether the browser renders `locator`'s contents: an entry that is skipped still has its own box, its children do not. */
  const rendered = (locator: Locator) => locator.evaluate((element) =>
    element.firstElementChild!.checkVisibility({ contentVisibilityAuto: true } as CheckVisibilityOptions));

  test("an entry outside the viewport is skipped for rendering", async ({ page, raw }) => {
    await openAll(page, raw);
    const first = page.locator(".conversation > .message").first();
    expect(await inView(first)).toBe(false);
    expect(await rendered(first)).toBe(false);
    expect(await rendered(page.locator(".conversation > .work-group").first())).toBe(false);
    // The last answer is on screen and rendered.
    expect(await rendered(page.getByTestId("assistant-message").last())).toBe(true);
  });

  test("find in page reaches a skipped entry and brings it into view", async ({ page, raw }) => {
    await openAll(page, raw);
    expect(await inView(answer(page, 2))).toBe(false);
    // window.find selects the match like the browser's find bar; headless Chromium does not scroll to it, so the test
    // reveals the match as the find bar does.
    const found = await page.evaluate((text) => {
      if (!(window as unknown as { find(text: string): boolean }).find(text)) return "";
      const element = getSelection()!.getRangeAt(0).startContainer.parentElement!;
      element.scrollIntoView({ block: "center" });
      return element.closest('[data-testid="assistant-message"]')?.querySelector("h2")?.textContent ?? "";
    }, `Kết quả rà soát liên kết ${turnTag(2)}`);
    expect(found).toBe(`Kết quả rà soát liên kết ${turnTag(2)}`);
    await frames(page, 2);
    expect(await inView(answer(page, 2))).toBe(true);
    expect(await rendered(answer(page, 2))).toBe(true);
  });

  test("a selection across skipped entries copies their text", async ({ page, raw }) => {
    await openAll(page, raw);
    const text = await page.evaluate(() => {
      const answers = [...document.querySelectorAll('[data-testid="assistant-message"]')];
      const start = answers[1]!.querySelector("h2")!.firstChild!;
      const end = answers.at(-1)!.querySelector("h2")!.firstChild!;
      const selection = getSelection()!;
      selection.setBaseAndExtent(start, 0, end, end.textContent!.length);
      return selection.toString();
    });
    for (const n of [2, 30, 60]) expect(text).toContain(`Kết quả rà soát liên kết ${turnTag(n)}`);
    expect(text).toContain("docs/getting-started-with-the-command-line.md");
  });

  test("following keeps the last line in view while an answer streams", async ({ page, raw }) => {
    const scroller = await openAll(page, raw);
    await startStream(page);
    const gaps = await scroller.evaluate(async (element) => {
      const gaps: number[] = [];
      for (let index = 0; index < 10; index++) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        gaps.push(element.scrollHeight - element.scrollTop - element.clientHeight);
      }
      return gaps;
    });
    for (const gap of gaps) expect(gap).toBeLessThan(80);
    await streamDone(page);
  });

  test("a long chat opens on its latest message once its entries take their size", async ({ page, raw }) => {
    await openLong(page, raw);
    const scroller = page.locator(".conversation-scroll");
    await frames(page, 10);
    await sleep(300);
    expect(await scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await expect(page.locator(".jump-latest")).toHaveCount(0);
    // Scrolling up still leaves the latest message, and its size changing below does not bring you back.
    await scroller.evaluate((element) => { element.scrollTop -= 600; });
    await expect(page.locator(".jump-latest")).toBeVisible();
    const top = await scroller.evaluate((element) => element.scrollTop);
    await page.getByTestId("assistant-message").last().evaluate((element) => { element.style.paddingBottom = "400px"; });
    await frames(page, 4);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(top);
  });

  test("Jump to latest lands on the last message from the top", async ({ page, raw }) => {
    const scroller = await openAll(page, raw);
    await scroller.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await frames(page, 2);
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await frames(page, 2);
    expect(await inView(page.getByTestId("assistant-message").last())).toBe(true);
    expect(await scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  });

  test("an open Work group keeps its state and size when scrolled away and back", async ({ page, raw }) => {
    const scroller = await openAll(page, raw);
    const group = page.locator(".conversation > .work-group").nth(4);
    await group.scrollIntoViewIfNeeded();
    await openGroup(group);
    await frames(page, 2);
    const height = await group.evaluate((element) => element.getBoundingClientRect().height);
    // An entry that holds the focus is always rendered: the toggle gives it up, as when the reader clicks elsewhere.
    await group.locator(".work-toggle").blur();
    await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await frames(page, 3);
    expect(await rendered(group)).toBe(false);
    await group.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await frames(page, 3);
    await expect(group.locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(await group.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
  });

  test("a focus ring at an entry's edge is not clipped", async ({ page, raw }) => {
    await openAll(page, raw);
    // The last answer's Copy message button sits at the message's left edge.
    const button = page.getByTestId("assistant-message").last().getByRole("button", { name: "Copy message" });
    await button.scrollIntoViewIfNeeded();
    // Keyboard focus: a key press first, so the focus ring shows.
    await page.keyboard.press("Shift");
    await button.focus();
    await frames(page, 2);
    const ring = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const message = element.closest(".message")!.getBoundingClientRect();
      return { left: box.left, top: box.top, height: box.height, messageLeft: message.left, outline: getComputedStyle(element).outlineColor };
    });
    // The ring sits 3 to 5 px outside the button, which sits at or left of the message's left edge.
    expect(ring.left - ring.messageLeft).toBeLessThan(3);
    const shot = await page.screenshot({ clip: { x: ring.left - 5, y: ring.top + ring.height / 2 - 4, width: 3, height: 8 } });
    // Decoded in a blank page: the dashboard's CSP allows no data: images.
    const blank = await page.context().newPage();
    const data = await blank.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
    }, shot.toString("base64"));
    await blank.close();
    const [r, g, b] = ring.outline.match(/\d+/g)!.map(Number);
    let ringPixels = 0;
    for (let index = 0; index < data.length; index += 4)
      if (Math.abs(data[index]! - r!) + Math.abs(data[index + 1]! - g!) + Math.abs(data[index + 2]! - b!) < 60) ringPixels++;
    expect(ringPixels).toBeGreaterThan(0);
  });
});

// Earlier history loads as you scroll up and keeps your place (docs/chat-design.md §10).
test.describe("earlier history", () => {
  const scroller = (page: Page) => page.locator(".conversation-scroll");
  const toTop = (page: Page) => scroller(page).evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  /** Marks the first entry in view and returns its offset from the top of the viewport. */
  const firstInView = (page: Page) => page.evaluate(() => {
    const view = document.querySelector(".conversation-scroll")!.getBoundingClientRect();
    const entries = [...document.querySelectorAll(".conversation > .message, .conversation > .work-group")];
    const element = entries.find((entry) => entry.getBoundingClientRect().bottom > view.top)!;
    element.setAttribute("data-anchor", "");
    return element.getBoundingClientRect().top - view.top;
  });
  /** The marked entry's offset now; a remounted entry has lost the mark and fails. */
  const anchorOffset = (page: Page) => page.locator("[data-anchor]").evaluate((element) =>
    element.getBoundingClientRect().top - element.closest(".conversation-scroll")!.getBoundingClientRect().top);
  const answers = (page: Page) => page.getByTestId("assistant-message").count();

  test("scrolling up fast asks for each page once, one at a time", async ({ page, raw }) => {
    const history = await holdHistory(page, 300);
    await openLong(page, raw);
    history.open();
    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let burst = 0; burst < 3; burst++) {
      for (let step = 0; step < 10; step++) await page.mouse.wheel(0, -3000);
      await sleep(100);
    }
    await loadAll(page);
    await expect(page.getByTestId("assistant-message")).toHaveCount(60);
    expect(history.held.cursors.length).toBeGreaterThan(1);
    expect(new Set(history.held.cursors).size).toBe(history.held.cursors.length);
    expect(history.held.most).toBe(1);
  });

  test("a failed page shows its error and Retry, and scrolling does not retry it", async ({ page, raw }) => {
    let fail = true;
    let requests = 0;
    await page.route(/\/history\?before=/, async (route) => {
      requests++;
      if (!fail) return route.continue();
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "History is unavailable" } }) });
    });
    await openLong(page, raw);
    const count = await answers(page);
    await toTop(page);
    const loader = page.locator(".history-loader");
    await expect(loader.getByRole("alert")).toContainText("History is unavailable");
    await expect(loader.getByRole("button", { name: "Retry" })).toBeVisible();
    for (const top of [400, 0, 300, 0]) {
      await scroller(page).evaluate((element, value) => { element.scrollTop = value; }, top);
      await frames(page, 2);
    }
    await sleep(500);
    expect(requests).toBe(1);
    fail = false;
    await loader.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => answers(page)).toBeGreaterThan(count);
    await expect(page.locator(".history-loader [role=alert]")).toHaveCount(0);
    // Loading on scroll goes on.
    await loadAll(page);
    await expect(page.getByTestId("assistant-message")).toHaveCount(60);
  });

  test("a short window keeps loading until the history ends, without scrolling", async ({ page, raw }) => {
    await page.setViewportSize({ width: 1440, height: 2000 });
    const store = raw.server.context.store!;
    const session = store.createSession({ cwd: raw.root, title: "Short window", agentName: "raw" });
    store.appendHistory({ sessionId: session.id, kind: "user", payload: { text: "First request", input: "First request" } });
    for (let index = 1; index < 60; index++) store.appendHistory({ sessionId: session.id, kind: "reasoning", payload: { text: `Thought ${index}` } });
    let requests = 0;
    page.on("request", (request) => { if (request.url().includes("/history?before=")) requests++; });
    await page.goto(raw.server.launchUrl.replace("/#", `/chat/${encodeURIComponent(session.id)}#`));
    // The snapshot's 50 thoughts are one collapsed Work group, far shorter than the window: the rest loads by itself.
    await expect(page.getByTestId("user-message")).toContainText("First request");
    await expect(page.locator(".history-loader")).toHaveCount(0);
    expect(requests).toBe(1);
  });

  test("the first entry in view stays put in every frame as a page lands, and the loader is a status", async ({ page, raw }) => {
    const history = await holdHistory(page);
    await openLong(page, raw);
    await toTop(page);
    await expect.poll(() => history.held.cursors.length).toBe(1);
    const loader = page.locator(".history-loader");
    await expect(loader).toHaveAttribute("role", "status");
    await expect(loader).toHaveText("Loading earlier messages…");
    const start = await firstInView(page);
    await page.evaluate(() => {
      const w = window as unknown as { offsets: number[] };
      w.offsets = [];
      const anchor = document.querySelector("[data-anchor]")!;
      const view = document.querySelector(".conversation-scroll")!;
      const sample = () => {
        w.offsets.push(anchor.getBoundingClientRect().top - view.getBoundingClientRect().top);
        if (w.offsets.length < 40) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const count = await answers(page);
    history.release();
    await expect.poll(() => answers(page)).toBeGreaterThan(count);
    await expect.poll(() => page.evaluate(() => (window as unknown as { offsets: number[] }).offsets.length)).toBe(40);
    const offsets = await page.evaluate(() => (window as unknown as { offsets: number[] }).offsets);
    for (const offset of offsets) expect(Math.abs(offset - start), offsets.join(",")).toBeLessThan(2);
    expect(Math.abs((await anchorOffset(page)) - start)).toBeLessThan(2);
  });

  test("scrolling while a page loads is not undone when it lands", async ({ page, raw }) => {
    const history = await holdHistory(page);
    await openLong(page, raw);
    await toTop(page);
    await expect.poll(() => history.held.cursors.length).toBe(1);
    await scroller(page).evaluate((element) => { element.scrollTop += 300; });
    await frames(page, 2);
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(300);
    const start = await firstInView(page);
    await sleep(800);
    const count = await answers(page);
    history.release();
    await expect.poll(() => answers(page)).toBeGreaterThan(count);
    await frames(page, 5);
    expect(Math.abs((await anchorOffset(page)) - start)).toBeLessThan(2);
  });

  test("an answer streaming below does not move the first entry in view as a page lands", async ({ page, raw }) => {
    const history = await holdHistory(page);
    await openLong(page, raw);
    await startStream(page);
    await toTop(page);
    await expect.poll(() => history.held.cursors.length).toBe(1);
    await frames(page, 2);
    const start = await firstInView(page);
    const streamed = await page.getByTestId("assistant-message").last().textContent();
    await sleep(800);
    expect(await page.getByTestId("assistant-message").last().textContent(), "the answer streamed on while the page loaded").not.toBe(streamed);
    const count = await answers(page);
    history.release();
    await expect.poll(() => answers(page)).toBeGreaterThan(count);
    await frames(page, 5);
    expect(Math.abs((await anchorOffset(page)) - start)).toBeLessThan(2);
    // Following stays off.
    expect(await scroller(page).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(1000);
    await streamDone(page);
  });

  test("Jump to latest right as a page lands stays at the bottom", async ({ page, raw }) => {
    const history = await holdHistory(page);
    await openLong(page, raw);
    await toTop(page);
    await expect.poll(() => history.held.cursors.length).toBe(1);
    await expect(page.locator(".jump-latest")).toBeVisible();
    const count = await answers(page);
    // Clicked from the commit that adds the page, before the next frame.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        document.querySelector<HTMLButtonElement>(".jump-latest")!.click();
      });
      observer.observe(document.querySelector(".conversation")!, { childList: true });
    });
    history.release();
    await expect.poll(() => answers(page)).toBeGreaterThan(count);
    await frames(page, 5);
    expect(await scroller(page).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);
  });
});
