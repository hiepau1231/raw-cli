import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { ACTIVE_TODO, BACKGROUND, FAILING, FOREGROUND, installStressTools, seedStress, stressScenario } from "./side-panel-stress.js";

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

/** Command cards: no overflow, chips on the first row, truncated text with its full value in a title or the card's name. */
function commandFaults(page: Page) {
  return page.getByRole("tabpanel").evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth) faults.push(`tab content overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of root.querySelectorAll<HTMLElement>("li.command-card:not([hidden])")) {
      const box = card.getBoundingClientRect();
      if (card.scrollWidth > card.clientWidth) faults.push(`card ${card.dataset.id} overflows`);
      for (const child of card.querySelectorAll<HTMLElement>("button, .command-chip, code, .command-tail-line"))
        if (child.getBoundingClientRect().right > box.right + 0.5) faults.push(`"${child.textContent}" sticks out of its card`);
      for (const text of card.querySelectorAll<HTMLElement>(".command-card-title, .command-card-line, .command-card-sub, .command-tail-line")) {
        const cut = text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1;
        const full = (text.closest("[title]") as HTMLElement | null)?.title ?? "";
        const value = (text.textContent ?? "").replace(/^stderr: /, "").replace(/…$/, "");
        if (cut && !full.startsWith(value) && !card.getAttribute("aria-label")?.startsWith(value)) faults.push(`cut without its full value: "${text.textContent}"`);
      }
      const head = card.querySelector<HTMLElement>(".command-card-head");
      if (head && head.getBoundingClientRect().height > 22) faults.push(`card head wraps in ${card.dataset.id}`);
      const glyph = card.querySelector(".command-card-glyph svg")?.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>(".command-card-open > .command-card-title")?.getBoundingClientRect();
      if (glyph && title && Math.abs(glyph.top + glyph.height / 2 - (title.top + title.height / 2)) > 3) faults.push(`glyph off the title line in ${card.dataset.id}`);
    }
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

    test(`at ${width} px Details shows the context first, the usage the provider reports, and every session value`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Details").click();
      const body = page.getByRole("tabpanel");
      const cards = body.locator(".details-card");
      await expect(cards.first()).toHaveAttribute("data-card", "context");
      const context = body.locator('.details-card[data-card="context"]');
      await expect(context.locator(".details-label")).toHaveText("Context");
      await expect(context.locator(".details-big")).toHaveText(/^~?\d+(\.\d)?k?$/);
      await expect(context.locator(".details-of")).toHaveText(/^\/ \d+(\.\d)?k? tokens$/);
      await expect(context.locator(".sp-chip")).toHaveText(/^\d+%$/);
      await expect(context.locator(".sp-bar > i")).toHaveAttribute("style", /width: \d/);
      await expect(context.locator(".details-line")).toHaveText(/^\d+ messages kept · no summary yet · auto compact (at [\d.]+k?|off)$/);
      await expect(context.getByRole("button", { name: "Compact now" })).toBeVisible();
      // The mock provider reports no token counts: one note, request counts, and no "Unavailable" rows anywhere.
      const usage = body.locator('.details-card[data-card="usage"]');
      await expect(usage.locator(".details-note")).toHaveText("This provider does not report token counts.");
      await expect(usage.locator("tbody th")).toHaveText(["Requests"]);
      await expect(body).not.toContainText("Unavailable");
      await expect(body.locator('.details-card[data-card="resume"] code')).toHaveText(/^raw --resume \S+ "Your next message"$/);
      await expect(body.getByRole("button", { name: "Copy resume command" })).toBeVisible();
      await expect(body.locator('.details-card[data-card="capabilities"]')).toContainText("Tools");
      const session = body.locator('.details-card[data-card="session"]');
      for (const label of ["ID", "Workspace", "Config for next turn", "Model"]) await expect(session.locator("dt", { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
      expect(await cards.evaluateAll((list) => list.map((card) => (card as HTMLElement).dataset.card))).toEqual(["context", "usage", "resume", "capabilities", "session"]);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await body.evaluate((root) => [root.scrollWidth - root.clientWidth, ...[...root.querySelectorAll<HTMLElement>(".details-card")].map((card) => card.scrollWidth - card.clientWidth)].filter((overflow) => overflow > 0))).toEqual([]);
        expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
    });

    test(`at ${width} px the Commands tab shows one readable card per command`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Commands").click();
      const cards = page.getByRole("tabpanel").locator("li.command-card");
      await expect(cards).toHaveCount(3);
      const [running, failed, succeeded] = [cards.nth(0), cards.nth(1), cards.nth(2)];
      await expect(running.locator(".command-chip")).toHaveText("Running");
      await expect(running.locator(".command-card-title")).toHaveText(BACKGROUND.description);
      await expect(running.locator("code.command-card-line")).toHaveAttribute("title", BACKGROUND.command);
      await expect(running.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(failed.locator(".command-chip")).toHaveText("Exit 2");
      await expect(failed.locator('.command-tail-line[data-channel="stderr"]')).toHaveText("stderr: error: missing semicolon");
      await expect(succeeded).toHaveAttribute("data-compact", "true");
      await expect(succeeded.locator(".command-card-title")).toHaveText(FOREGROUND.description);
      // Compact: one line for the title, one for the command.
      expect((await succeeded.boundingBox())!.height).toBeLessThanOrEqual(56);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await commandFaults(page)).toEqual([]);
        expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
    });
  }
});

test.describe("Details with reported usage", () => {
  const usage = (prompt: number, completion: number, cached: number) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } } })}\n\n`;
  test.use({ scenario: { responses: [
    { frames: [openAiFrame({ content: "First." }, "stop"), usage(1200, 30, 0), openAiDone] },
    { frames: [openAiFrame({ content: "Second." }, "stop"), usage(1500, 40, 1000), openAiDone] },
  ] } });
  test("the usage card lists the reported counts for the last turn and the session, without the no-report note", async ({ page, raw }) => {
    await openChat(page, raw);
    for (const [index, text] of ["one", "two"].entries()) {
      await page.getByRole("textbox", { name: "Message" }).fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("assistant-message")).toHaveCount(index + 1);
    }
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await tab(page, "Details").click();
    const card = page.getByRole("tabpanel").locator('.details-card[data-card="usage"]');
    await expect(card.locator("thead th")).toHaveText(["", "Last turn", "Session"]);
    const row = (name: string) => card.locator("tbody tr", { has: page.locator("th", { hasText: new RegExp(`^${name}$`) }) }).locator("td");
    await expect(row("Requests")).toHaveText(["1", "2"]);
    await expect(row("Input tokens")).toHaveText(["1,500", "2,700"]);
    await expect(row("Output tokens")).toHaveText(["40", "70"]);
    await expect(row("Cache read")).toHaveText(["1,000", "1,000"]);
    await expect(card.locator(".details-note")).toHaveCount(0);
    await expect(page.getByRole("tabpanel")).not.toContainText("Unavailable");
    await expect(page.getByRole("tabpanel").locator('.details-card[data-card="context"] .details-of')).toBeVisible();
    // Long sessions: coverage and share phrases for hundreds of requests wrap inside the card at the default width.
    await expect(row("Cache coverage")).toHaveText(["1 of 1 requests", "2 of 2 requests"]);
    await row("Cache coverage").nth(1).evaluate((cell) => { cell.textContent = "1,000 of 1,000 requests"; });
    await row("Cache read share").nth(1).evaluate((cell) => { cell.textContent = "50.0% (1,000 of 1,000)"; });
    await row("Requests").nth(1).evaluate((cell) => { cell.textContent = "1,000"; });
    const fits = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const table = element.querySelector("table")!.getBoundingClientRect();
      return { overflow: element.scrollWidth - element.clientWidth, right: Math.round(table.right - box.right) };
    });
    expect(fits.overflow).toBeLessThanOrEqual(0);
    expect(fits.right).toBeLessThan(0);
  });
});
