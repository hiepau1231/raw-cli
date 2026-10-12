import { chromium, expect, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
const shoot = async (page: Page, view: string, scheme: string, target?: string | string[]) => {
  await page.mouse.move(0, 0);
  // No focus ring on the message box, as in the mockups; an open Context card keeps its focus.
  await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; if (active?.closest(".composer-box")) active.blur(); });
  await page.waitForTimeout(300);
  const file = `chat-${view}-${scheme}.png`;
  if (Array.isArray(target)) {
    // The region around several elements, such as the composer and its Context card above it.
    const boxes = await Promise.all(target.map(async (selector) => (await page.locator(selector).first().boundingBox())!));
    const x = Math.min(...boxes.map((box) => box.x)), y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height));
    await page.screenshot({ path: join(out, file), animations: "disabled", clip: { x, y, width: right - x, height: bottom - y } });
  } else if (target) await page.locator(target).first().screenshot({ path: join(out, file), animations: "disabled" });
  else await page.screenshot({ path: join(out, file), animations: "disabled" });
  copyFileSync(join(out, file), join("docs/dashboard", file));
};
/** A fresh dashboard with the stress session run up to `stage`. */
const session = async (stage: "answer" | "approval" | "question", viewport: { width: number; height: number }) => {
  // The workspace is in the temporary directory; as HOME it shows as ~/… in the header, as on a real machine.
  const raw = await dashboardFixture({ ...chatScenario, env: { HOME: realpathSync(tmpdir()) } });
  installChatWorkspace(raw);
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.emulateMedia({ colorScheme: "dark" });
  await seedChat(page, raw, stage);
  return { raw, page };
};
/** Messages sent while the turn waits for approval: they wait as cards above the composer. */
const queue = async ({ raw, page }: Awaited<ReturnType<typeof session>>) => {
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  for (const item of [
    { input: "Sau khi sửa xong, chạy lại kiểm tra liên kết cho cả thư mục docs và ghi số liên kết hỏng vào báo cáo, kèm đường dẫn của từng trang có liên kết hỏng để tôi xem lại trước khi gửi." },
    { input: "Xem thêm script này", files: ["scripts/check-links.mjs"] },
    { input: "Bỏ qua các liên kết tới localhost." },
  ]) await raw.json(`/sessions/${sessionId}/inputs`, "POST", { clientRequestId: crypto.randomUUID(), agent: "raw", mode: "queue", ...item });
  await expect(page.getByTestId("queued-input")).toHaveCount(3);
};
const shots: string[] = [];
try {
  // The desktop with the side panel open and the write waiting for approval, as in the mockup, then the conversation
  // from its first message (work).
  const desktop = await session("approval", { width: 1440, height: 900 });
  for (const scheme of ["dark", "light"] as const) {
    await desktop.page.emulateMedia({ colorScheme: scheme });
    await shoot(desktop.page, "desktop", scheme);
    // The work view, as in the mockup: the first group open, with the edit's diff and the failed command's card.
    const group = desktop.page.locator(".work-group").first();
    if ((await group.locator(".work-toggle").getAttribute("aria-expanded")) === "false") await group.locator(".work-toggle").click();
    const edit = group.locator(".tool-row[data-kind=edit] .tool-toggle");
    if ((await edit.getAttribute("aria-expanded")) === "false") await edit.click();
    // Tall enough for the whole open group, its last card's footer above the composer.
    await desktop.page.setViewportSize({ width: 1440, height: 1240 });
    await desktop.page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = 0; });
    const foot = (await group.locator(".tool-card-foot").last().boundingBox())!;
    const composer = (await desktop.page.locator(".composer-area").boundingBox())!;
    if (foot.y + foot.height > composer.y) throw new Error("the work group's last card is under the composer");
    await shoot(desktop.page, "work", scheme, ".chat-main");
    await desktop.page.setViewportSize({ width: 1440, height: 900 });
    await group.locator(".work-toggle").click();
    await desktop.page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  }
  shots.push("desktop", "work");
  // Three waiting messages above the composer, one long, one with a file.
  await queue(desktop);
  for (const scheme of ["dark", "light"] as const) {
    await desktop.page.emulateMedia({ colorScheme: scheme });
    await shoot(desktop.page, "queued", scheme, ".chat-main");
  }
  shots.push("queued");
  await desktop.raw.close();
  // The composer of an idle conversation, its Context card open, as in the mockup.
  const idle = await session("answer", { width: 1440, height: 900 });
  await idle.page.locator(".composer-area").getByRole("button", { name: /^Context: / }).click();
  await idle.page.locator(".context-popover").waitFor();
  for (const scheme of ["dark", "light"] as const) {
    await idle.page.emulateMedia({ colorScheme: scheme });
    await shoot(idle.page, "composer", scheme, [".composer-area", ".context-popover"]);
  }
  shots.push("composer");
  await idle.raw.close();
  // The pending ask_user question.
  const question = await session("question", { width: 1440, height: 900 });
  for (const scheme of ["dark", "light"] as const) {
    await question.page.emulateMedia({ colorScheme: scheme });
    await shoot(question.page, "question", scheme, ".chat-main");
  }
  shots.push("question");
  await question.raw.close();
  // 390 px: the full-bleed frame, with the pending question as in the mockup.
  const narrow = await session("question", { width: 390, height: 844 });
  for (const scheme of ["dark", "light"] as const) {
    await narrow.page.emulateMedia({ colorScheme: scheme });
    await shoot(narrow.page, "narrow", scheme);
  }
  shots.push("narrow");
  await narrow.raw.close();
  const narrowQueued = await session("approval", { width: 390, height: 844 });
  await queue(narrowQueued);
  for (const scheme of ["dark", "light"] as const) {
    await narrowQueued.page.emulateMedia({ colorScheme: scheme });
    await shoot(narrowQueued.page, "queued-narrow", scheme);
  }
  shots.push("queued-narrow");
  await narrowQueued.raw.close();
  console.log(`captured ${shots.length * 2} images: ${shots.join(", ")}`);
} finally {
  await browser.close();
}
