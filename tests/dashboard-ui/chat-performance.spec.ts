import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { ASK, chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";
import { LIVE_ANSWER, LIVE_REQUEST, longStream, seedLongChat } from "./chat-long.js";
import { probe, startCommits, stopCommits } from "./perf-probe.js";

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

test("an open group, an open tool card and a typed answer survive a streamed turn and a reconnect", async ({ page, raw }) => {
  await openLong(page, raw);
  // An older turn's Work group and its edit's card.
  const group = page.locator(".work-group").nth(1);
  await openGroup(group);
  const card = group.locator('.tool-row[data-kind="edit"]');
  const cardState = await flipCard(card);
  await mark(group, "group");
  await mark(card, "card");
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
  await page.getByRole("button", { name: "Load earlier" }).click();
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
