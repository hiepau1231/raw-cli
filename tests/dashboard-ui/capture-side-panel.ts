import { chromium } from "@playwright/test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { installStressTools, seedStress, stressScenario } from "./side-panel-stress.js";

// Run after npm run build. The side-panel gallery (docs/side-panel-design.md §10): the stress session at the default
// 320 px width, one image per tab in dark and light, written to test-results/side-panel/ and copied to
// docs/dashboard/side-panel-*.png. Compare them by eye with docs/design/side-panel/; they are not pixel assertions.
const out = "test-results/side-panel";
mkdirSync(out, { recursive: true });
mkdirSync("docs/dashboard", { recursive: true });
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const raw = await dashboardFixture(stressScenario);
installStressTools(raw);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.emulateMedia({ colorScheme: "dark" });
  await seedStress(page, raw);
  const titles = (await page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label") ?? ""))).filter(Boolean);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const title of titles) {
      await page.getByRole("tab", { name: title, exact: true }).click();
      await page.waitForTimeout(300);
      const file = `side-panel-${slug(title)}-${scheme}.png`;
      await page.locator(".inspector").screenshot({ path: join(out, file), animations: "disabled" });
      copyFileSync(join(out, file), join("docs/dashboard", file));
    }
  }
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  console.log(`captured ${titles.length * 2} images: ${titles.join(", ")}`);
} finally {
  await browser.close();
  await raw.close();
}
