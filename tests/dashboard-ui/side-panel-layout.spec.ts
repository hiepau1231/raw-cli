import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { ACTIVE_TODO, BACKGROUND, FAILING, installStressTools, seedStress, stressScenario } from "./side-panel-stress.js";

// Geometry and content of the side panel with real-length data (docs/side-panel-design.md §10), at the supported widths.
const PREFERENCES = "raw.dashboard.preferences.v1";
const tab = (page: Page, title: string) => page.getByRole("tab", { name: title, exact: true });

/** Layout faults inside the selected tab: horizontal overflow, glyphs off the first text line, clamped text without its full value. */
function layoutFaults(page: Page) {
  return page.getByRole("tabpanel").evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth) faults.push(`tab content overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of root.querySelectorAll<HTMLElement>(".sp-card"))
      if (card.scrollWidth > card.clientWidth) faults.push(`card ${card.dataset.card} overflows`);
    for (const line of root.querySelectorAll<HTMLElement>(".sp-card-line")) {
      const glyph = line.querySelector(".sp-line-glyph svg")?.getBoundingClientRect();
      const text = line.querySelector<HTMLElement>(".sp-line-text")!;
      const first = text.getBoundingClientRect().top + parseFloat(getComputedStyle(text).lineHeight);
      if (glyph && (glyph.top + glyph.height / 2 < text.getBoundingClientRect().top || glyph.top + glyph.height / 2 > first))
        faults.push(`glyph off the first line of "${text.textContent}"`);
      if (text.scrollHeight > text.clientHeight + 1 && text.title !== text.textContent) faults.push(`clamped text without its full value: "${text.textContent}"`);
    }
    for (const title of root.querySelectorAll<HTMLElement>(".sp-card-title"))
      if (title.getBoundingClientRect().height > 24) faults.push(`card title wraps: "${title.textContent}"`);
    return faults;
  });
}

test.describe("side panel layout", () => {
  test.use({ scenario: stressScenario });
  for (const width of [320, 360]) {
    test(`at ${width} px the Overview cards and tab badges show the stress session without overflow, and each card opens its tab`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Overview").click();
      expect(Math.round((await page.locator(".inspector").boundingBox())!.width)).toBe(width);

      const card = (title: string) => page.locator(".sp-overview-card", { has: page.locator(".sp-card-title", { hasText: new RegExp(`^${title}$`) }) });
      await expect(card("Todo").locator(".sp-meta")).toHaveText("3 of 5");
      await expect(card("Todo").locator(".sp-card-line.glyph-running")).toContainText(ACTIVE_TODO);
      await expect(card("Todo").locator(".sp-bar > i")).toHaveAttribute("style", /width: 60%/);
      await expect(card("Files changed").locator(".sp-stat.added")).toHaveText(/^\+\d+$/);
      await expect(card("Files changed").locator(".sp-card-line")).toHaveText("component-file-name-that-is-long.ts, README.md");
      await expect(card("Commands").locator(".sp-chip")).toHaveText(["1 running", "1 failed"]);
      await expect(card("Commands").locator(".sp-card-line.glyph-running")).toContainText(BACKGROUND.description);
      await expect(card("Commands").locator(".sp-card-line.glyph-failed")).toContainText(FAILING.description);
      await expect(card("Commands").locator(".sp-card-line.glyph-failed .sp-line-meta")).toHaveText("exit 2");
      await expect(card("Gadget").locator(".sp-meta")).toHaveText("1 of 2");
      await expect(card("Context").locator(".sp-chip")).toHaveText(/^\d+%$/);
      await expect(page.locator(".sp-overview-card").last()).toHaveAttribute("data-card", "__details");

      await expect(tab(page, "Todo")).toHaveAccessibleDescription(/^3 of 5 done/);
      await expect(tab(page, "Files changed")).toHaveAccessibleDescription(/^2 files/);
      await expect(tab(page, "Commands")).toHaveAccessibleDescription(/^1 running/);
      await expect(tab(page, "Gadget")).toHaveAccessibleDescription(/^1 of 2 done/);
      await expect(tab(page, "Details")).toHaveAccessibleDescription(/^\d+% of the (context window|auto-compact trigger) used$/);
      // The tab strip never wraps: it is one row that scrolls sideways.
      const strip = (await page.getByRole("tablist").boundingBox())!;
      expect(strip.height).toBeLessThanOrEqual(40);

      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await layoutFaults(page)).toEqual([]);
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }

      // Every card opens its own tab; the Context card opens Details.
      const ids = await page.locator(".sp-overview-card").evaluateAll((cards) => cards.map((element) => (element as HTMLElement).dataset.card!));
      expect(ids.length).toBe(5);
      for (const id of ids) {
        await page.locator(`.sp-overview-card[data-card="${id}"]`).click();
        const selected = page.locator(`[role=tab][data-tab="${id}"]`);
        await expect(selected).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await selected.getAttribute("id"))!);
        await tab(page, "Overview").click();
      }
    });
  }
});
