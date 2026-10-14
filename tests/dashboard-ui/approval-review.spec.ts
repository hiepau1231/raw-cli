/**
 * The host-owned Approvals tab (docs/side-panel-design.md §3.3): a call waiting for permission shows the files it
 * intends to change and the lines it would write, and is answered from the panel itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

test.use({ scenario: chatScenario });

const REPORT = "reports/links.md";
const tabOf = (page: Page) => page.getByRole("tab", { name: "Approvals", exact: true });
const panelOf = (page: Page) => page.locator('[data-tab-panel="__approvals"]');
const reviewOf = (page: Page) => panelOf(page).locator(".review-card");
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
/** Opens the side panel on the Approvals tab the way the in-chat card offers it. */
async function openReview(page: Page) {
  await page.locator("section.approval").getByRole("button", { name: "Review", exact: true }).click();
  await expect(panelOf(page)).toBeVisible();
}

test("a write waiting for permission is reviewed and allowed from the side panel", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  // The panel here follows the todo panel; the pending write neither takes that tab nor renders its review yet.
  await expect(page.locator('.sp-tabs [role="tab"][aria-selected="true"]')).toHaveText(/Todo/);
  await expect(panelOf(page)).toHaveCount(0);
  // The card's own control keeps the dashboard's 32 px target, like the ones beside it.
  const review = page.locator("section.approval").getByRole("button", { name: "Review", exact: true });
  const box = await review.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  await openReview(page);
  await expect(tabOf(page)).toHaveAttribute("aria-selected", "true");
  const card = reviewOf(page);
  await expect(card).toHaveCount(1);
  // The same headline the in-chat card carries: the call's title and the path it was given.
  await expect(card.locator(".review-title")).toHaveText("Write");
  await expect(card.locator(".review-summary")).toHaveText("reports/links.md");
  // The intended file, and the lines the call would write, are readable before anything reaches the disk.
  const file = card.getByRole("button", { name: /links\.md/ });
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await file.click();
  await expect(file).toHaveAttribute("aria-expanded", "true");
  const diff = card.locator(".diff-view");
  await expect(diff).toContainText("+++ b/reports/links.md");
  await expect(diff).toContainText("+# Link report");
  await expect(diff).toContainText("+41 ok, 3 broken");
  expect(existsSync(join(raw.root, REPORT))).toBe(false);
  // The panel answers the same call the card would, and the tab leaves with the last pending approval.
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => raw.server.context.store!.listOperations()[0]?.state).toBe("completed");
  expect(readFileSync(join(raw.root, REPORT), "utf8")).toBe("# Link report\n\n41 ok, 3 broken\n");
  await expect(page.locator('[data-tab-panel="__approvals"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveCount(0);
});

test("denying from the side panel writes nothing", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  await openReview(page);
  await reviewOf(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(() => raw.server.context.store!.listOperations()[0]?.state).toBe("completed");
  expect(existsSync(join(raw.root, REPORT))).toBe(false);
  await expect(page.getByTestId("assistant-message").nth(1)).toContainText("Đã ghi báo cáo", { timeout: 30000 });
  await expect(page.locator('[data-tab-panel="__approvals"]')).toHaveCount(0);
});

test("a waiting approval survives a reload and is reviewed without the mouse", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  await page.reload();
  // The pending call comes back from the session snapshot, and its review is still asked for before it shows.
  await expect(page.locator("section.approval")).toHaveCount(1);
  await expect(panelOf(page)).toHaveCount(0);
  await openReview(page);
  const card = reviewOf(page);
  await expect(card).toHaveCount(1);
  // The file row is an ordinary button: Enter opens it, Space closes it.
  const file = card.getByRole("button", { name: /links\.md/ });
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  // Exactly one tab is in the tab order, and the card opened that one.
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveText(/Approvals/);
  await axe(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await axe(page);
});
