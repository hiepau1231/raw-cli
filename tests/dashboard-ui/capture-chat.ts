import { chromium, expect, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

// Run after npm run build. The chat gallery (docs/chat-design.md §9): the chat stress session in dark and light, written
// to test-results/chat/chat-<view>-<scheme>.png and copied to docs/dashboard/. Compare them by eye with the approved
// mockups (compare-chat.ts); they are not pixel assertions.
const out = "test-results/chat";
mkdirSync(out, { recursive: true });
mkdirSync("docs/dashboard", { recursive: true });
const browser = await chromium.launch();
const shoot = async (page: Page, view: string, scheme: string, target?: string) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const file = `chat-${view}-${scheme}.png`;
  if (target) await page.locator(target).first().screenshot({ path: join(out, file), animations: "disabled" });
  else await page.screenshot({ path: join(out, file), animations: "disabled" });
  copyFileSync(join(out, file), join("docs/dashboard", file));
};
/** A fresh dashboard with the stress session run up to `stage`. */
const session = async (stage: "answer" | "question", viewport: { width: number; height: number }) => {
  const raw = await dashboardFixture(chatScenario);
  installChatWorkspace(raw);
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.emulateMedia({ colorScheme: "dark" });
  await seedChat(page, raw, stage);
  return { raw, page };
};
const shots: string[] = [];
try {
  // The desktop with the side panel open, the conversation from its first message (work), and the composer.
  const desktop = await session("answer", { width: 1440, height: 900 });
  for (const scheme of ["dark", "light"] as const) {
    await desktop.page.emulateMedia({ colorScheme: scheme });
    await shoot(desktop.page, "desktop", scheme);
    await desktop.page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = 0; });
    await expect(desktop.page.locator(".work-group").first()).toBeInViewport();
    await shoot(desktop.page, "work", scheme, ".chat-main");
    await desktop.page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await shoot(desktop.page, "composer", scheme, ".composer-area");
  }
  shots.push("desktop", "work", "composer");
  await desktop.raw.close();
  // The pending ask_user question.
  const question = await session("question", { width: 1440, height: 900 });
  for (const scheme of ["dark", "light"] as const) {
    await question.page.emulateMedia({ colorScheme: scheme });
    await shoot(question.page, "question", scheme, ".chat-main");
  }
  shots.push("question");
  await question.raw.close();
  // 390 px: the full-bleed frame.
  const narrow = await session("answer", { width: 390, height: 844 });
  for (const scheme of ["dark", "light"] as const) {
    await narrow.page.emulateMedia({ colorScheme: scheme });
    await shoot(narrow.page, "narrow", scheme);
  }
  shots.push("narrow");
  await narrow.raw.close();
  console.log(`captured ${shots.length * 2} images: ${shots.join(", ")}`);
} finally {
  await browser.close();
}
