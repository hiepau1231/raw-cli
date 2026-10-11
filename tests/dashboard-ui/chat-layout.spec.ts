import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { REQUEST, chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

// The chat area and the frame around it with real-length data (docs/chat-design.md), at the supported widths, in both
// themes. Values come from the approved mockups (kept local).
const THEMES = {
  dark: { backdrop: "rgb(7, 6, 11)", frame: "rgb(33, 27, 45)", canvas: "rgb(15, 12, 22)" },
  light: { backdrop: "rgb(238, 236, 243)", frame: "rgb(228, 225, 234)", canvas: "rgb(255, 255, 255)" },
} as const;
const TRANSPARENT = "rgba(0, 0, 0, 0)";
// Theme switches are measured at once: no colour transitions in between.
test.use({ reducedMotion: "reduce" });

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
/** A colour token resolved to the rgb() string computed styles report. */
const tokenColour = (page: Page, name: string) => page.evaluate((token) => {
  const sample = document.createElement("i");
  sample.style.color = `var(${token})`;
  document.body.append(sample);
  const colour = getComputedStyle(sample).color;
  sample.remove();
  return colour;
}, name);
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
        // The chat header replaces the toolbar: the card starts on the workspace button's line.
        expect(toolbar).toBeNull();
        near(card.top, 8);
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
      expect(await page.locator(".chat-header .agent-chip").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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

test.describe("chat header", () => {
  // The workspace lives in the temporary directory: as HOME, its path shows as ~/….
  test.use({ scenario: { ...chatScenario, env: { HOME: realpathSync(tmpdir()) } } });
  const header = ".chat-main > .page-header";

  test("at 1440 px one 52 px row on the frame's centre line replaces the toolbar", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const bar = page.locator(header);
    const title = bar.getByRole("heading", { level: 1 });
    const path = bar.locator(".workspace-path");
    const sidePanel = bar.getByRole("button", { name: "Side panel", exact: true });
    const cwd = realpathSync(raw.root);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(page.locator(".app-toolbar")).toHaveCount(0);
      const p = await probe(page, [header, ".chat-main", ".workspace-button", ".rail .brand", ".side-panel-title"]);
      const row = p[header]!;
      near(p[".chat-main"]!.top, 8);
      near(row.height, 52);
      expect(row.borderBottom).toBe("0px");
      expect(row.paddingLeft).toBe("18px");
      for (const other of [".workspace-button", ".rail .brand", ".side-panel-title"]) near(p[other]!.centre, row.centre);
      // One line: a 15 px title that ends in an ellipsis, then the agent and the shortened path.
      // The session title is the request, cut by the server; the whole title is in the tooltip.
      const text = (await title.textContent())!;
      expect(text.length).toBeGreaterThan(40);
      expect(REQUEST.startsWith(text)).toBe(true);
      await expect(title).toHaveAttribute("title", text);
      await expect(title).toHaveCSS("font-size", "15px");
      await expect(title).toHaveCSS("font-weight", "600");
      await expect(title).toHaveCSS("text-overflow", "ellipsis");
      await expect(title).toHaveCSS("white-space", "nowrap");
      await expect(bar.locator(".agent-chip")).toHaveText("raw");
      // A short name is never clipped; only the path gives way.
      expect(await bar.locator(".agent-chip").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(path).toHaveText(`~/${cwd.split("/").pop()}`);
      await expect(path).toHaveAttribute("title", cwd);
      const tops = await bar.locator("h1, .agent-chip, .workspace-path, button:visible").evaluateAll((list) => list.map((element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      }));
      for (const centre of tops) near(centre, row.centre, 1.5);
      // The toolbar's controls, as icon buttons at the 32 px minimum target; the drawer trigger only below 900 px.
      await expect(bar.getByRole("button", { name: "Workspace menu" })).toBeHidden();
      for (const name of ["Quick navigation", "Activity", "Side panel", "More actions"]) {
        const button = bar.getByRole("button", { name, exact: name !== "Activity" });
        await expect(button).toBeVisible();
        await expect(button).toHaveCSS("width", "32px");
        await expect(button).toHaveCSS("border-top-left-radius", "8px");
      }
      // The side panel is open: the button says so and is tinted.
      await expect(sidePanel).toHaveAttribute("aria-expanded", "true");
      await expect(sidePanel).toHaveCSS("background-color", await tokenColour(page, "--accent-soft"));
      await axe(page);
    }
    await sidePanel.click();
    await expect(sidePanel).toHaveAttribute("aria-expanded", "false");
    await expect(sidePanel).toHaveCSS("background-color", TRANSPARENT);
    // Search and Activity open the shell's one palette and one activity dialog.
    await bar.getByRole("button", { name: "Quick navigation" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Activity" }).click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Other pages keep their toolbar and breadcrumb.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.locator(".app-toolbar .breadcrumb")).toContainText("Agents");
  });

  test("at 390 px the header keeps the title, the drawer trigger and the actions", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    const bar = page.locator(header);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(page.locator(".app-toolbar")).toHaveCount(0);
      const row = (await probe(page, [header]))[header]!;
      near(row.height, 52);
      expect(row.borderBottom).toBe("0px");
      // The mockup's spacing holds at 390 px: 18 px and 14 px at the ends, 10 px between the parts, 8 px between buttons.
      expect(await bar.evaluate((element) => [getComputedStyle(element).paddingLeft, getComputedStyle(element).paddingRight, getComputedStyle(element).columnGap]))
        .toEqual(["18px", "14px", "10px"]);
      await expect(bar.locator(".actions")).toHaveCSS("column-gap", "8px");
      await expect(bar.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(bar.locator(".agent-chip")).toBeHidden();
      await expect(bar.locator(".workspace-path")).toBeHidden();
      await expect(bar.getByRole("button", { name: "Quick navigation" })).toBeHidden();
      await expect(bar.getByRole("button", { name: "Activity" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await axe(page);
    }
    await bar.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Workspace menu" }).click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
  });
});

test.describe("chat header with a long agent name", () => {
  const name = "documentation-link-checker-with-a-very-long-agent-name-that-never-breaks";
  test.use({ scenario: { ...chatScenario, extraAgents: { [name]: { model: "fixture", system_prompt: "Check links", tools: { use: [] } } } } });
  test("the agent chip ends in an ellipsis and stays inside the header at every width", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat agent" }).click();
    await page.getByRole("menuitemradio", { name }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    // The long request becomes the title, so the title, the chip and the path all compete for the row.
    await page.getByRole("textbox", { name: "Message" }).fill(REQUEST);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const bar = page.locator(".chat-main > .page-header");
    await expect(bar.getByRole("heading", { level: 1 })).toHaveText(/^Rà soát/);
    const chip = bar.locator(".agent-chip");
    await expect(chip).toHaveText(name);
    await expect(chip).toHaveAttribute("title", name);
    await expect(bar.locator(".workspace-path")).toHaveAttribute("title", /.+/);
    for (const width of [1440, 1000, 800, 600]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await bar.evaluate((element) => {
        const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
        const chip = element.querySelector<HTMLElement>(".agent-chip")!;
        return { bar: element.getBoundingClientRect(), metadata: box(".metadata"), chip: box(".agent-chip"), path: box(".workspace-path"), actions: box(".actions"), clipped: chip.scrollWidth > chip.clientWidth };
      });
      expect(boxes.clipped, `${width}`).toBe(true);
      near(boxes.bar.height, 52);
      expect(boxes.chip.right, `${width}`).toBeLessThanOrEqual(boxes.metadata.right + 0.5);
      expect(boxes.chip.right, `${width}`).toBeLessThanOrEqual(boxes.path.left + 0.5);
      expect(boxes.metadata.right, `${width}`).toBeLessThanOrEqual(boxes.actions.left);
    }
  });
});

test.describe("chat header outside HOME", () => {
  test.use({ scenario: { ...chatScenario, env: { HOME: "/raw-test-home-elsewhere" } } });
  test("a workspace outside HOME shows its full path", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const path = page.locator(".chat-main > .page-header .workspace-path");
    await expect(path).toHaveText(realpathSync(raw.root));
    await expect(path).toHaveAttribute("title", realpathSync(raw.root));
  });
});
