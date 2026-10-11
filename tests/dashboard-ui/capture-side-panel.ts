import { chromium } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { installStressTools, seedStress, stressScenario } from "./side-panel-stress.js";

// Run after npm run build. The side-panel gallery (docs/side-panel-design.md §10): the stress session at the default
// 320 px width, one image per tab in dark and light, written to test-results/side-panel/ and copied to
// docs/dashboard/side-panel-*.png. Compare them by eye with the approved mockups (compare-side-panel.ts); they are not pixel assertions.
const out = "test-results/side-panel";
mkdirSync(out, { recursive: true });
mkdirSync("docs/dashboard", { recursive: true });
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const raw = await dashboardFixture(stressScenario);
installStressTools(raw);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.emulateMedia({ colorScheme: "dark" });
  await seedStress(page, raw);
  const titles = (await page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? ""))).filter(Boolean);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const title of titles) {
      await page.getByRole("tab", { name: title, exact: true }).click();
      // As in the mockup, Files changed shows its first file's diff.
      const first = page.getByRole("tabpanel").locator("button.panel-file").first();
      if (title === "Files changed" && (await first.getAttribute("aria-expanded")) === "false") await first.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      // The whole tab, not only what fits: the window grows by what the tab scrolls.
      const hidden = await page.locator(".sp-content").evaluate((element) => element.scrollHeight - element.clientHeight);
      await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, hidden) });
      await page.waitForTimeout(100);
      const file = `side-panel-${slug(title)}-${scheme}.png`;
      await page.locator(".inspector").screenshot({ path: join(out, file), animations: "disabled" });
      copyFileSync(join(out, file), join("docs/dashboard", file));
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    // The pending ask_user question, as the chat shows it (question.png).
    const question = `side-panel-question-${scheme}.png`;
    await page.locator(".inline-tool-view").last().screenshot({ path: join(out, question), animations: "disabled" });
    copyFileSync(join(out, question), join("docs/dashboard", question));
  }
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  console.log(`captured ${titles.length * 2 + 2} images: ${titles.join(", ")}, Question`);
} finally {
  await browser.close();
  await raw.close();
}
