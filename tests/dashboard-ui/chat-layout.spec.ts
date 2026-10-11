import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

// The chat area and the frame around it with real-length data (docs/chat-design.md), at the supported widths, in both
// themes. Values come from the approved mockups (kept local).
const THEMES = {
  dark: { backdrop: "rgb(7, 6, 11)", frame: "rgb(33, 27, 45)", canvas: "rgb(15, 12, 22)" },
  light: { backdrop: "rgb(238, 236, 243)", frame: "rgb(228, 225, 234)", canvas: "rgb(255, 255, 255)" },
} as const;
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const setTheme = (page: Page, theme: keyof typeof THEMES) => page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
/** Computed styles and box of the first element matching each selector (null when absent or hidden). */
const probe = (page: Page, selectors: string[]) => page.evaluate((list) => Object.fromEntries(list.map((selector) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || !element.getClientRects().length) return [selector, null];
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return [selector, {
    top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, centre: box.top + box.height / 2,
    background: style.backgroundColor, radius: style.borderTopLeftRadius, borderColor: style.borderTopColor,
    borderTop: style.borderTopWidth, borderRight: style.borderRightWidth, borderBottom: style.borderBottomWidth, borderLeft: style.borderLeftWidth,
    paddingTop: style.paddingTop, paddingLeft: style.paddingLeft,
  }];
})), selectors);
const near = (actual: number, expected: number, slack = 1) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(slack);

test.describe("app frame", () => {
  test.use({ scenario: chatScenario });

  test("at 1440 px the rail, sidebar and side panel sit on the backdrop and the chat is the only card", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    // The todo opens the side panel; the header button closes it.
    for (const open of [true, false]) {
      if (!open) await page.getByRole("button", { name: "Side panel", exact: true }).click();
      await expect(page.getByRole("tablist", { name: "Side panel tabs" })).toBeVisible({ visible: open });
      for (const theme of ["dark", "light"] as const) {
        await setTheme(page, theme);
        const colours = THEMES[theme];
        const p = await probe(page, [".app-shell", ".rail", ".rail .brand", ".context-panel", ".workspace-button", ".main-column", ".app-toolbar", ".chat-main", ".inspector", ".sp-tabs", ".sp-tab.active", ".session-row.selected"]);
        const shell = p[".app-shell"]!, card = p[".chat-main"]!, ws = p[".workspace-button"]!, toolbar = p[".app-toolbar"]!;
        expect(shell.background).toBe(colours.backdrop);
        expect(shell.paddingTop).toBe("8px");
        // No full-height rules and no surfaces of their own beside the card.
        for (const side of [".rail", ".context-panel"]) {
          expect(p[side]!.borderRight, side).toBe("0px");
          expect(p[side]!.background, side).toBe(TRANSPARENT);
        }
        expect(p[".main-column"]!.background).toBe(TRANSPARENT);
        expect(card.radius).toBe("14px");
        expect(card.borderColor).toBe(colours.frame);
        expect(card.background).toBe(colours.canvas);
        // Until the chat header replaces it, the toolbar sits on the backdrop above the card, with no rule.
        near(toolbar.top, 8);
        expect(toolbar.borderBottom).toBe("0px");
        near(card.top, toolbar.bottom);
        near(card.bottom, 900 - 8);
        // The sidebar content is 16 px from the card; the rail logo and the 52 px workspace button share a centre line.
        near(card.left - ws.right, 16);
        near(ws.top, 9);
        near(ws.height, 52);
        near(p[".rail .brand"]!.centre, ws.centre);
        expect(p[".session-row.selected"]!.background).not.toBe(shell.background);
        if (!open) {
          near(card.right, 1440 - 8);
          expect(p[".inspector"]).toBeNull();
        } else {
          const side = p[".inspector"]!, strip = p[".sp-tabs"]!, active = p[".sp-tab.active"]!;
          expect(side.borderLeft).toBe("0px");
          expect(side.background).toBe(colours.backdrop);
          near(strip.left - card.right, 16);
          near(side.right, 1440 - 8);
          // The tab strip is a segmented control: no rule under it, the selected tab raised on its own surface.
          expect(strip.borderBottom).toBe("0px");
          expect(strip.radius).toBe("10px");
          expect(active.borderBottom).toBe("0px");
          expect(active.background).not.toBe(strip.background);
          expect(active.background).not.toBe(TRANSPARENT);
        }
        await axe(page);
      }
    }
  });

  test("other pages keep their toolbar inside the card, which starts on the workspace button's line", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    for (const route of ["Agents", "Library"]) {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: route, exact: true }).click();
      await expect(page.locator(".app-toolbar")).toBeVisible();
      for (const theme of ["dark", "light"] as const) {
        await setTheme(page, theme);
        const p = await probe(page, [".app-shell", ".main-column", ".app-toolbar", ".context-panel"]);
        const card = p[".main-column"]!, toolbar = p[".app-toolbar"]!;
        expect(card.radius, route).toBe("14px");
        expect(card.borderColor).toBe(THEMES[theme].frame);
        expect(card.background).toBe(THEMES[theme].canvas);
        near(card.top, 8);
        expect(p[".context-panel"]!.background).toBe(TRANSPARENT);
        // The toolbar is inside the card and draws no full-width rule.
        expect(toolbar.top).toBeGreaterThanOrEqual(card.top);
        expect(toolbar.borderBottom).toBe("0px");
        await axe(page);
      }
    }
  });

  test("at 800 px the drawer opens from the toolbar and the card keeps its frame", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 800, height: 900 });
    await seedChat(page, raw);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const p = await probe(page, [".app-shell", ".rail", ".chat-main", ".context-panel"]);
      expect(p[".context-panel"]).toBeNull();
      expect(p[".rail"]!.borderRight).toBe("0px");
      expect(p[".chat-main"]!.radius).toBe("14px");
      near(p[".chat-main"]!.left, p[".rail"]!.right, 1);
      await axe(page);
    }
    await page.getByRole("button", { name: "Workspace menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(THEMES.light.backdrop);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("at 390 px the frame is full-bleed and the horizontal rail has no rule", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const p = await probe(page, [".app-shell", ".rail", ".chat-main"]);
      const card = p[".chat-main"]!, rail = p[".rail"]!;
      expect(p[".app-shell"]!.paddingTop).toBe("0px");
      expect(card.radius).toBe("0px");
      expect(card.borderTop).toBe("0px");
      near(card.left, 0);
      near(card.right, 390);
      expect(rail.borderBottom).toBe("0px");
      expect(rail.background).toBe(THEMES[theme].backdrop);
      expect(rail.background).not.toBe(card.background);
      await axe(page);
    }
  });

  test("the sidebar and side panel still resize from the gaps beside the card", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const sidebar = page.getByRole("separator", { name: "Context panel width" });
    const before = (await page.locator(".context-panel").boundingBox())!.width;
    await sidebar.focus();
    await page.keyboard.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(before + 10));
    near((await page.locator(".context-panel").boundingBox())!.width, before + 10);
    // A small drag moves the edge by as much as the pointer, in the drag's direction, from wherever the handle is grabbed.
    const drag = async (name: string, panel: string, dx: number) => {
      await expect(page.getByRole("separator", { name })).toBeVisible();
      const handle = (await page.getByRole("separator", { name }).boundingBox())!;
      const start = (await page.locator(panel).boundingBox())!.width;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2, { steps: 2 });
      await page.mouse.up();
      return (await page.locator(panel).boundingBox())!.width - start;
    };
    near(await drag("Context panel width", ".context-panel", 6), 6);
    near(await drag("Context panel width", ".context-panel", -6), -6);
    near(await drag("Inspector width", ".inspector", -6), 6);
    near(await drag("Inspector width", ".inspector", 6), -6);
    const side = page.getByRole("separator", { name: "Inspector width" });
    const width = (await page.locator(".inspector").boundingBox())!.width;
    await side.focus();
    await page.keyboard.press("ArrowRight");
    await expect(side).not.toHaveAttribute("aria-valuenow", String(width));
    expect((await page.locator(".inspector").boundingBox())!.width).not.toBe(width);
    // The handle lies in the gap: it does not cover the card.
    const handle = (await side.boundingBox())!;
    const card = (await page.locator(".chat-main").boundingBox())!;
    expect(handle.x).toBeGreaterThanOrEqual(card.x + card.width - 1);
    // When the window clips the preferred width, the drag starts from the width on screen.
    for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowLeft");
    await expect(side).toHaveAttribute("aria-valuenow", "360");
    await page.setViewportSize({ width: 340, height: 900 });
    // Crossing the breakpoint remounts the panel as an overlay: wait until it is on screen, clipped.
    await expect.poll(async () => (await page.locator(".inspector").boundingBox())?.width ?? 999).toBeLessThan(360);
    await expect(page.getByRole("dialog").locator(".inspector-resize")).toBeVisible();
    near(await drag("Inspector width", ".inspector", 6), -6);
  });
});
