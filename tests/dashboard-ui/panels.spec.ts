import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

const call = (id: string, name: string, args: unknown) => ({
  frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone],
});
const todos = (count: number) => ({ title: "Ship", todos: Array.from({ length: count }, (_, index) => ({ content: `Step ${index + 1}`, status: index === 0 ? "in_progress" : "pending" })) });
const KEY = "raw.dashboard.panels.v1";
const tab = (page: Page, title: string) => page.getByRole("tab", { name: title, exact: true });
/** The Overview card of a panel, by its full id. */
const card = (page: Page, panel: string) => page.locator(`.sp-overview-card[data-card="${panel}"]`);
const titles = (page: Page) => page.getByRole("tab").evaluateAll((tabs) => tabs.map((element) => element.getAttribute("aria-label")));
const side = (page: Page) => page.getByRole("button", { name: "Side panel", exact: true });
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
/** A local plugin whose panels are declared in tool.json; `publish` (a JS expression body) runs inside the handler. */
function plugin(raw: { env: NodeJS.ProcessEnv }, folder: string, panels: object[], publish = "") {
  const dir = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ api_version: 2, id: folder, version: "1.0.0", name: folder, description: `Tool ${folder}.`,
    input_schema: { type: "object", additionalProperties: false }, entry: "./index.mjs", panels }));
  writeFileSync(join(dir, "index.mjs"), `export async function handler(args, context) { ${publish} return { content: [{ type: "text", text: "ok" }] }; }`);
}
const decl = (id: string, title: string, extra: object = {}) => ({ id, title, icon: "list-checks", open: "never", ...extra });


test.describe("todo panel", () => {
  const sixty = (doneFirst: boolean) => ({ title: "Ship", todos: Array.from({ length: 60 }, (_, index) => ({ content: `Step ${index + 1}`, status: index === 0 && doneFirst ? "done" : index === (doneFirst ? 1 : 0) ? "in_progress" : "pending" })) });
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/todo"] } },
      responses: [call("c1", "todo", todos(3)), answer, call("c2", "todo", sixty(false)), answer, call("c3", "todo", sixty(true)), answer],
    },
  });

  test("the side panel starts closed, opens on Overview with a card for the declared panel, and follows the tabs pattern", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await side(page).click();
    await expect(page.getByRole("heading", { name: "Side panel", exact: true })).toBeVisible();
    expect(await titles(page)).toEqual(["Overview", "Todo", "Details"]);
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await tab(page, "Overview").getAttribute("id"))!);
    await expect(card(page, "builtin/todo#todo")).toContainText("No data yet");
    // Manual activation: arrows, Home and End move focus only; Enter or Space selects. Only one tab is in the tab order.
    await tab(page, "Overview").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Todo")).toBeFocused();
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab").and(page.locator("[tabindex='0']"))).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await tab(page, "Todo").getAttribute("id"))!);
    await page.keyboard.press("End");
    await expect(tab(page, "Details")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab(page, "Overview")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Details")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
    // A card opens its tab, and the selected tab is stored per session and survives a reload.
    await tab(page, "Overview").click();
    await card(page, "builtin/todo#todo").focus();
    await page.keyboard.press("Enter");
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
    // The card left with Overview, so focus moves into the tab it opened instead of falling to the page.
    await expect(page.getByRole("tabpanel")).toBeFocused();
    await page.reload();
    await side(page).click();
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
  });

  test("the first update opens the side panel once on the panel's tab without moving focus, and later updates never switch the tab, move focus or scroll", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await expect(tab(page, "Todo")).toHaveAccessibleDescription("0 of 3 done");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await send(page, "more");
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(page.getByText("Step 60", { exact: true })).toBeAttached();
    await expect(page.locator(".side-panel [role=status]")).toHaveText("Todo: 0 of 60 done");
    await expect(tab(page, "Todo")).toHaveAccessibleDescription("0 of 60 done");
    // The reader scrolls the tab; the next update keeps the tab, the focus and the scroll position.
    const content = page.getByRole("tabpanel");
    expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await content.evaluate((element) => { element.scrollTop = 200; });
    await page.getByRole("textbox", { name: "Message" }).fill("again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(3);
    await expect(tab(page, "Todo")).toHaveAccessibleDescription("1 of 60 done");
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
    expect(await content.evaluate((element) => element.scrollTop)).toBe(200);
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
  });

  test("Follow the tool keeps a tab the user chose and only marks the update", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await tab(page, "Details").click();
    await page.getByRole("button", { name: "Close side panel" }).click();
    await expect(page.locator(".inspector")).toHaveCount(0);
    await send(page, "plan it");
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(tab(page, "Details")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Todo").locator(".sp-unseen")).toHaveCount(1);
    await expect(tab(page, "Todo")).toHaveAccessibleDescription("0 of 3 done, New update");
  });

  test("Never keeps the side panel closed and the unseen dot marks the update", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, panelOpen: "never" })));
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await side(page).click();
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    // Overview shows the card but does not count as reading the panel.
    await expect(card(page, "builtin/todo#todo")).toContainText("Step 1");
    await expect(tab(page, "Todo").locator(".sp-unseen")).toHaveCount(1);
    await tab(page, "Todo").click();
    await expect(tab(page, "Todo").locator(".sp-unseen")).toHaveCount(0);
    await expect(page.getByText("Step 1", { exact: true })).toBeVisible();
  });

  test("a narrow viewport never opens the drawer by itself", async ({ page, raw }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Side panel" })).toHaveCount(0);
    await side(page).click();
    await expect(page.getByRole("dialog", { name: "Side panel" })).toBeVisible();
    await expect(tab(page, "Todo")).toBeVisible();
  });

  test("a receipt row opens the side panel, unhides its tab and selects it, and a hidden tab stays hidden on update", async ({ page, raw }) => {
    await page.addInitScript(([key]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, hidden: { raw: ["builtin/todo#todo"] } }));
    }, [KEY]);
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    // A hidden tab never opens the side panel by itself.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByText("Work", { exact: true }).click();
    const receipt = page.locator(".panel-receipt");
    await expect(receipt).toHaveCount(1);
    await expect(receipt).toContainText("Ship");
    await receipt.click();
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(tab(page, "Todo")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    await tab(page, "Overview").click();
    await expect(page.getByText(/\d hidden/)).toHaveCount(0);
  });

  test("Hide tab, Move left and Move right live in the tab menu and the hidden row shows the tab again", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await tab(page, "Todo").click();
    await page.getByRole("button", { name: "Todo panel menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: "Move right" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Hide tab" }).click();
    await expect(tab(page, "Todo")).toHaveCount(0);
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "1 hidden" })).toBeVisible();
    await page.reload();
    await side(page).click();
    await page.getByRole("button", { name: "1 hidden" }).click();
    await page.getByRole("button", { name: "Show Todo" }).click();
    await expect(tab(page, "Todo")).toBeVisible();
    // Overview and Details have no menu: they cannot move or hide.
    for (const fixed of ["Overview", "Details"]) {
      await tab(page, fixed).click();
      await expect(page.getByRole("button", { name: `${fixed} panel menu` })).toHaveCount(0);
    }
  });

  test("the side panel passes axe in light and dark", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      for (const title of ["Overview", "Todo", "Details"]) {
        await tab(page, title).click();
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
    }
  });
});

test.describe("tab layout", () => {
  // `short` publishes two lines on its first call and eighty on later ones; `long` always publishes eighty lines.
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join("\\n\\n");
  const publish = (text: string) => `await context.panels.update("p", { op: "replace", document: { blocks: [{ id: "m", kind: "markdown", text: ${text} }] } });`;
  const seed = (raw: { env: NodeJS.ProcessEnv }) => {
    const counter = join(raw.env.XDG_CONFIG_HOME!, "short-calls");
    plugin(raw, "short", [decl("p", "Short")], `const fs = await import("node:fs"); const calls = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8") : 0) + 1;
      fs.writeFileSync(${JSON.stringify(counter)}, String(calls)); ${publish(`calls === 1 ? "${lines(2)}" : "${lines(80)}"`)}`);
    plugin(raw, "long", [decl("p", "Long")], publish(`"${lines(80)}"`));
  };
  test.use({
    scenario: {
      agent: { tools: { use: ["local/short", "local/long"] } },
      responses: [
        { frames: [openAiFrame({ tool_calls: ["short", "long"].map((name, index) => ({ index, id: name, type: "function", function: { name, arguments: "{}" } })) }, "tool_calls"), openAiDone] },
        answer, call("again", "short", {}), answer,
      ],
    },
  });

  test("a tab's content takes the side panel's whole height and scrolls inside it", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await send(page, "publish");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await side(page).click();
    const inspector = (await page.locator(".inspector").boundingBox())!;
    for (const [title, scrolls] of [["Long", true], ["Short", false]] as const) {
      await tab(page, title).click();
      const content = page.getByRole("tabpanel");
      await expect(content.getByText("Line 2", { exact: true })).toBeVisible();
      const box = (await content.boundingBox())!;
      expect(Math.abs(box.y + box.height - (inspector.y + inspector.height))).toBeLessThanOrEqual(2);
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(scrolls);
      expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    // Another tab starts at its top.
    await tab(page, "Long").click();
    await page.getByRole("tabpanel").evaluate((element) => { element.scrollTop = 400; });
    await tab(page, "Short").click();
    expect(await page.getByRole("tabpanel").evaluate((element) => element.scrollTop)).toBe(0);
  });

  test("an update to another panel changes neither the tab, the focus nor the scroll position", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await send(page, "publish");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await side(page).click();
    await tab(page, "Short").click();
    await tab(page, "Long").click();
    const content = page.getByRole("tabpanel");
    await content.evaluate((element) => { element.scrollTop = 300; });
    await send(page, "grow the short one");
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(tab(page, "Short").locator(".sp-unseen")).toHaveCount(1);
    await expect(tab(page, "Long")).toHaveAttribute("aria-selected", "true");
    expect(await content.evaluate((element) => element.scrollTop)).toBe(300);
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await tab(page, "Short").click();
    await expect(page.getByRole("tabpanel").getByText("Line 80", { exact: true })).toBeAttached();
  });
});

test.describe("tab chrome", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/same", "local/other"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: ["same", "other"].map((name, index) => ({ index, id: name, type: "function", function: { name, arguments: "{}" } })) }, "tool_calls"), openAiDone] }, answer] } });
  const seed = (raw: { env: NodeJS.ProcessEnv }) => {
    plugin(raw, "same", [decl("p", "Notes")], `await context.panels.update("p", { op: "replace", document: { title: "Notes", subtitle: "Explains what this panel tracks.", status: "done",
      summary: "${"a long summary that keeps going ".repeat(3)}", blocks: [{ id: "c", kind: "checklist", title: "Notes", items: [{ id: "a", label: "First row" }, { id: "b", label: "Second row", ref: { path: "src/a.ts" } }] },
      { id: "t", kind: "table", title: "Checks", columns: [{ id: "name", label: "Name" }], rows: [{ id: "r1", cells: { name: "lint" } }, { id: "r2", cells: { name: "test" }, ref: { path: "src/b.ts" } }] }] } });`);
    plugin(raw, "other", [decl("p", "Other")], 'await context.panels.update("p", { op: "replace", document: { title: "Release plan", blocks: [{ id: "m", kind: "markdown", text: "body\\n\\n```sh\\nnpm test\\n```" }] } });');
  };

  test("the body repeats neither the tab title nor its explanation, which moves to the header tooltip", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await send(page, "publish");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await side(page).click();
    await tab(page, "Notes").click();
    const notes = page.getByRole("tabpanel");
    await expect(notes.getByText("First row")).toBeVisible();
    await expect(notes.locator("h4", { hasText: /^Notes$/i })).toHaveCount(0);
    await expect(notes.locator(".sp-tab-heading h3")).toHaveText("Notes");
    await expect(notes.locator(".sp-tab-heading h3")).toHaveAttribute("title", /Explains what this panel tracks\./);
    await expect(notes).not.toContainText("Explains what this panel tracks.");
    await expect(notes.locator("h4")).toHaveText(["Checks"]);
    // A done document shows a glyph on its tab and in the header, never a text pill.
    await expect(tab(page, "Notes").locator(".sp-doc-status.done")).toHaveCount(1);
    await expect(tab(page, "Notes")).toHaveAccessibleDescription("Done");
    await expect(notes.locator(".sp-tab-header .sp-doc-status.done")).toHaveCount(1);
    await expect(notes.locator(".sp-tab-header .sp-chip")).toHaveCount(0);
    // A document or block title that differs from the tab title still shows.
    await tab(page, "Other").click();
    await expect(page.getByRole("tabpanel").locator("h4")).toHaveText("Release plan");
    // Content is not a nested card: a code block inside a tab has no outer border.
    const code = page.getByRole("tabpanel").locator(".code-block");
    await expect(code).toContainText("npm test");
    await expect(code).toHaveCSS("border-top-width", "0px");
    await expect(code).toHaveCSS("border-radius", "0px");
  });

  test("rows are 24 px with 13 px text and file references keep the row size", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await send(page, "publish");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await side(page).click();
    await tab(page, "Notes").click();
    // Checklist rows (one with a file reference) and table rows share the row geometry.
    const rows = page.getByRole("tabpanel").locator(".panel-checklist li, .panel-table tbody tr");
    await expect(rows).toHaveCount(4);
    for (const row of await rows.all()) {
      expect((await row.boundingBox())!.height).toBe(24);
      expect(await row.evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
    }
    await expect(page.getByRole("tabpanel").locator(".panel-ref").first()).toHaveCSS("font-size", "13px");
  });
});

test.describe("panel ordering", () => {
  test.use({
    scenario: { agent: { tools: { use: ["local/a", "local/b", "local/c", "local/d"] } }, responses: [answer] },
  });
  const seed = (raw: { env: NodeJS.ProcessEnv }) => {
    for (const name of ["a", "b", "c", "d"]) plugin(raw, name, [decl("p", name.toUpperCase())]);
  };

  test("new panels are inserted after their nearest present predecessor, not appended and not default-sorted", async ({ page, raw }) => {
    seed(raw);
    // The user's order has D and B only, reversed from the defaults; A and C are new to the stack.
    await page.addInitScript(([key]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, order: { raw: ["local/d#p", "local/b#p"] } }));
    }, [KEY]);
    await openChat(page, raw);
    await side(page).click();
    await expect(tab(page, "A")).toBeVisible();
    expect(await titles(page)).toEqual(["Overview", "A", "D", "B", "C", "Details"]);
  });

  test("dragging a tab along the strip reorders and persists, while a plain click still selects", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    await tab(page, "A").click();
    await expect(tab(page, "A")).toHaveAttribute("aria-selected", "true");
    await tab(page, "Overview").click();
    const from = (await tab(page, "A").boundingBox())!;
    const to = (await tab(page, "C").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await titles(page)).toEqual(["Overview", "B", "C", "A", "D", "Details"]);
    // The drag did not select the tab.
    await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await side(page).click();
    expect(await titles(page)).toEqual(["Overview", "B", "C", "A", "D", "Details"]);
  });

  test("a fast drag whose first movement already leaves the source tab still reorders, and Overview and Details do not move", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    const from = (await tab(page, "A").boundingBox())!;
    const to = (await tab(page, "C").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
    await page.mouse.up();
    expect(await titles(page)).toEqual(["Overview", "B", "C", "A", "D", "Details"]);
    const details = (await tab(page, "Details").boundingBox())!;
    const b = (await tab(page, "B").boundingBox())!;
    await page.mouse.move(details.x + details.width / 2, details.y + details.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    expect(await titles(page)).toEqual(["Overview", "B", "C", "A", "D", "Details"]);
  });

  test("Move left and Move right reorder by the keyboard and persist per agent", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    expect(await titles(page)).toEqual(["Overview", "A", "B", "C", "D", "Details"]);
    await tab(page, "C").click();
    await page.getByRole("button", { name: "C panel menu" }).click();
    await page.getByRole("menuitem", { name: "Move left" }).press("Enter");
    expect(await titles(page)).toEqual(["Overview", "A", "C", "B", "D", "Details"]);
    await tab(page, "A").click();
    await page.getByRole("button", { name: "A panel menu" }).click();
    await page.getByRole("menuitem", { name: "Move right" }).press("Enter");
    expect(await titles(page)).toEqual(["Overview", "C", "A", "B", "D", "Details"]);
    await page.reload();
    await side(page).click();
    expect(await titles(page)).toEqual(["Overview", "C", "A", "B", "D", "Details"]);
  });
});

test.describe("panel widgets", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/gadget"], rules: [{ match: "local/gadget", effect: "allow" }] } }, responses: [call("g1", "gadget", {}), answer] } });
  const gadgetDocument = {
    title: "Gadget run", subtitle: "All widgets", status: "active", summary: "Halfway", progress: { done: 1, total: 2 },
    blocks: [
      { id: "cl", kind: "checklist", title: "Checklist", items: [{ id: "i1", label: "Parent", status: "done", children: [{ id: "i2", label: "Child", status: "in_progress", note: "a note" }] }, { id: "i3", label: "Failing", status: "failed", note: "failing note", ref: { path: "src/a.ts", line: 3 } }, { id: "i4", label: "Finished chore", status: "done" }] },
      { id: "st", kind: "steps", title: "Steps", items: [{ id: "s1", label: "First", status: "done", started_at: 1759140000000, ended_at: 1759140600000 }, { id: "s2", label: "Second", status: "in_progress", detail: "working" }] },
      { id: "pr", kind: "progress", title: "Progress", label: "Build", value: 3, max: 10 },
      { id: "kv", kind: "key_value", title: "Facts", entries: [{ key: "Branch", value: "main" }, { key: "File", value: "x", ref: { path: "src/b.ts" } }] },
      { id: "tb", kind: "table", title: "Results", columns: [{ id: "n", label: "Name" }, { id: "v", label: "Value", align: "end" }], rows: [{ id: "r1", status: "done", cells: { n: "alpha", v: "1" } }] },
      { id: "md", kind: "markdown", title: "Notes", text: "Some **bold** text" },
      { id: "tl", kind: "timeline", title: "Log", events: [{ id: "e1", at: 1700000000000, level: "success", label: "Older event" }, { id: "e2", at: 1700000100000, level: "info", label: "Newer event" }] },
      { id: "fl", kind: "files", title: "Files", entries: [{ path: "src/c.ts", status: "modified", added: 12, removed: 3 }, { path: "/opt/shared/notes.md", status: "referenced" }, { path: "src/api.ts", line: 42, added: 3 }] },
      { id: "un", kind: "hologram", title: "Future", fallback: "Shown as plain text" },
    ],
  };
  const publish = `await context.panels.update("g", { op: "replace", document: ${JSON.stringify(gadgetDocument)} });`;

  test("all eight block kinds render, an unknown kind shows its fallback, file references insert @path, and axe is clean", async ({ page, raw }) => {
    plugin(raw, "gadget", [decl("g", "Gadget", { open: "first_update", icon: "gauge" })], publish);
    await openChat(page, raw);
    await send(page, "run gadget");
    await expect(tab(page, "Gadget")).toHaveAttribute("aria-selected", "true");
    const body = page.getByRole("tabpanel");
    for (const kind of ["checklist", "steps", "progress", "key_value", "table", "markdown", "timeline", "files"])
      await expect(body.locator(`[data-kind="${kind}"]`)).toHaveCount(1);
    await expect(body.getByText("Parent")).toBeVisible();
    await expect(body.locator(".panel-status.status-done").first().locator(".sr-only")).toHaveText("Done");
    await expect(body.locator("progress")).toHaveCount(1);
    await expect(body.getByRole("table")).toBeVisible();
    await expect(body.locator("strong", { hasText: "bold" })).toBeVisible();
    await expect(body.getByTestId("panel-fallback")).toHaveText("Shown as plain text");
    // Steps show how long a finished step took; the timeline is newest first with relative time; files show a status letter.
    await expect(body.locator('[data-kind="steps"] .panel-tag', { hasText: "10m" })).toHaveCount(1);
    await expect(body.locator('[data-kind="timeline"] li').first()).toContainText("Newer event");
    await expect(body.locator('[data-kind="timeline"] li').last()).toContainText("Older event");
    await expect(body.locator('[data-kind="timeline"] time').first()).toHaveText(/ago$/);
    // Files: name, muted directory, +/− and the status letter; a path outside the cwd is shown whole.
    const files = body.locator('[data-kind="files"] li');
    await expect(files.first().locator(".panel-file-name")).toHaveText("c.ts");
    await expect(files.first().locator(".panel-file-dir")).toHaveText("src/");
    await expect(files.first().locator(".panel-file-added")).toHaveText("+12");
    await expect(files.first().locator(".panel-file-removed")).toHaveText("−3");
    await expect(files.first().locator(".panel-file-status")).toHaveText("M");
    await expect(files.nth(1).locator(".panel-file-name")).toHaveText("/opt/shared/notes.md");
    await expect(files.nth(1).locator(".panel-file-dir, .panel-file-added")).toHaveCount(0);
    await expect(files.nth(1).locator(".panel-file-status")).toHaveText("R");
    // A count that is not given is not shown as zero, and the line number does not hide the file type.
    await expect(files.last().locator(".panel-file-name")).toHaveText("api.ts:42");
    await expect(files.last().locator(".panel-file-added")).toHaveText("+3");
    await expect(files.last().locator(".panel-file-removed")).toHaveCount(0);
    await expect(files.last().locator("svg.lucide-file-code")).toHaveCount(1);
    await files.nth(1).getByRole("button", { name: "Insert @/opt/shared/notes.md into the message" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("@/opt/shared/notes.md ");
    await page.getByRole("textbox", { name: "Message" }).fill("");
    // Only the item in progress shows its note; another item's note is in its tooltip.
    await expect(body.getByText("a note", { exact: true })).toBeVisible();
    await expect(body.getByText("failing note")).toHaveCount(0);
    await expect(body.getByText("Failing", { exact: true })).toHaveAttribute("title", "failing note");
    // Checklist: children collapse, and "Hide completed" in the tab menu is remembered by the browser.
    await expect(body.getByText("Child", { exact: true })).toBeVisible();
    await body.getByRole("button", { name: "Collapse Parent" }).click();
    await expect(body.getByText("Child", { exact: true })).toHaveCount(0);
    await body.getByRole("button", { name: "Expand Parent" }).click();
    await expect(body.getByText("Child", { exact: true })).toBeVisible();
    await expect(body.getByText("Finished chore")).toBeVisible();
    await expect(body.getByLabel("Hide completed")).toHaveCount(0);
    const hideCompleted = async () => {
      await page.getByRole("button", { name: "Gadget panel menu" }).click();
      return page.getByRole("menuitemcheckbox", { name: "Hide completed" });
    };
    await expect(await hideCompleted()).toHaveAttribute("aria-checked", "false");
    await page.getByRole("menuitemcheckbox", { name: "Hide completed" }).click();
    await expect(body.getByText("Finished chore")).toHaveCount(0);
    await expect(body.getByText("Parent", { exact: true })).toBeVisible();
    await page.reload();
    await side(page).click();
    await expect(page.getByRole("tabpanel").getByText("Finished chore")).toHaveCount(0);
    await expect(await hideCompleted()).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemcheckbox", { name: "Hide completed" }).click();
    await expect(page.getByRole("tabpanel").getByText("Finished chore")).toBeVisible();
    await body.getByRole("button", { name: "src/a.ts:3" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/@src\/a\.ts /);
    expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
  });
});

test.describe("agent switch", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/todo"] } }, extraAgents: { bare: { model: "fixture", tools: { use: [] } } }, responses: [answer] } });
  test("choosing another agent rebuilds the tabs for that agent and choosing back restores them", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await expect(tab(page, "Todo")).toBeVisible();
    const pick = async (name: string) => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /^Agent:/ }).press("ArrowRight");
      await page.getByRole("menuitemradio", { name }).press("Enter");
    };
    await pick("bare");
    await expect(tab(page, "Todo")).toHaveCount(0);
    await expect(tab(page, "Details")).toBeVisible();
    await pick("raw");
    await expect(tab(page, "Todo")).toBeVisible();
  });
});


test.describe("unseen updates", () => {
  test.use({
    scenario: { agent: { tools: { use: ["local/one", "local/two"], rules: [{ match: "local/*", effect: "allow" }] } }, responses: [call("t1", "two", {}), answer] },
  });
  test("an update to a panel whose tab is not selected keeps its unseen dot, also after reopening the side panel, until its tab is selected", async ({ page, raw }) => {
    plugin(raw, "one", [decl("p", "One")]);
    plugin(raw, "two", [decl("p", "Two")], 'await context.panels.update("p", { op: "replace", document: { title: "Second", blocks: [{ id: "m", kind: "markdown", text: "hello" }] } });');
    await page.addInitScript(() => {
      if (!localStorage.getItem("raw.dashboard.panels.v1")) localStorage.setItem("raw.dashboard.panels.v1", JSON.stringify({ version: 1, opened: ["x"] }));
    });
    await openChat(page, raw);
    await side(page).click();
    await tab(page, "One").click();
    await send(page, "run two");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    const dot = tab(page, "Two").locator(".sp-unseen");
    await expect(dot).toHaveCount(1);
    await page.getByRole("button", { name: "Close side panel" }).click();
    await side(page).click();
    await expect(tab(page, "One")).toHaveAttribute("aria-selected", "true");
    await expect(dot).toHaveCount(1);
    // The Overview card shows the content, but only the tab counts as reading it.
    await tab(page, "Overview").click();
    await expect(card(page, "local/two#p")).toBeVisible();
    await expect(dot).toHaveCount(1);
    await tab(page, "Two").click();
    await expect(page.getByRole("tabpanel").getByText("hello")).toBeVisible();
    await expect(dot).toHaveCount(0);
    await tab(page, "One").click();
    await expect(dot).toHaveCount(0);
  });
});

test.describe("panel actions", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/todo"] } }, extraAgents: { other: { model: "fixture", tools: { use: ["builtin/todo"] } } }, responses: [call("c1", "todo", todos(3)), answer] } });
  const row = (page: Page, label: string) => page.locator(".panel-checklist li", { hasText: label }).first();

  test("the primary action runs on click, updates the row and leaves a receipt from the user", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mark done: Step 2" }).click();
    await expect(row(page, "Step 2").getByText("Done", { exact: true })).toBeAttached();
    await expect(page.getByRole("button", { name: "Mark done: Step 2" })).toHaveCount(0);
    await expect(page.locator(".panel-tag", { hasText: "You" })).toBeVisible();
    // The menu offers every applicable action, and Reopen is now available for the finished row.
    await row(page, "Step 2").getByRole("button", { name: "Actions for Step 2" }).click();
    await expect(page.getByRole("menuitem", { name: "Reopen" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Mark done" })).toHaveCount(0);
  });

  test("rows with actions stay 24 px and show their menu button on hover or focus", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    for (const label of ["Step 1", "Step 2", "Step 3"]) expect((await row(page, label).boundingBox())!.height).toBe(24);
    const button = row(page, "Step 2").getByRole("button", { name: "Actions for Step 2" });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(button).toHaveCSS("opacity", "0");
    await row(page, "Step 2").hover();
    await expect(button).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await button.focus();
    await expect(button).toHaveCSS("opacity", "1");
  });

  test("a prompt action fills the message box without sending", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Todo panel menu" }).click();
    await page.getByRole("menuitem", { name: "Continue" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Continue with the next pending todo item.");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  });

  test("an unsent agent switch disables tool actions with the reason but keeps prompt actions", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /^Agent:/ }).press("ArrowRight");
    await page.getByRole("menuitemradio", { name: "other" }).press("Enter");
    const primary = page.getByRole("button", { name: "Mark done: Step 2" });
    await expect(primary).toBeDisabled();
    await expect(primary).toHaveAttribute("title", "Send a message to switch to other first");
    await page.getByRole("button", { name: "Todo panel menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Continue" })).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: "Clear completed" })).toHaveAttribute("aria-disabled", "true");
  });

  test("the tab menu lists panel actions, and the glyph is the primary action", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    // The status glyph itself is the button.
    await expect(page.getByRole("button", { name: "Mark done: Step 2" }).locator(".panel-status")).toBeVisible();
    await page.getByRole("button", { name: "Todo panel menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Continue" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Clear completed" })).toBeVisible();
  });

  test("the panel with actions passes axe", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByRole("button", { name: "Mark done: Step 2" })).toBeVisible();
    const scan = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect((await scan()).violations).toEqual([]);
  });
});

test.describe("actions on other blocks", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/board"], rules: [{ match: "local/board", effect: "allow" }] } }, responses: [call("b1", "board", {}), answer] } });
  test("an untitled block and a table row offer their actions", async ({ page, raw }) => {
    const publish = `await context.panels.update("main", { op: "replace", document: { blocks: [
      { id: "notes", kind: "markdown", text: "Just text" },
      { id: "rows", kind: "table", title: "Rows", columns: [{ id: "name", label: "Name" }], rows: [{ id: "r1", cells: { name: "Alpha" }, status: "pending" }] } ] } });`;
    plugin(raw, "board", [decl("main", "Board", { actions: [
      { id: "note", label: "Annotate", scope: "block", blocks: ["notes"], kind: "prompt", text: "About {{block.id}}" },
      { id: "row", label: "Open row", scope: "item", blocks: ["rows"], kind: "prompt", text: "Row {{item.id}} in {{block.id}}" },
    ] })], publish);
    await openChat(page, raw);
    await send(page, "go");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await side(page).click();
    await tab(page, "Board").click();
    await expect(page.getByText("Just text")).toBeVisible();
    await page.getByRole("button", { name: "Actions for markdown" }).click();
    await page.getByRole("menuitem", { name: "Annotate" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("About notes");
    // A table row with actions keeps the 24 px row, and its menu button shows on hover or focus.
    const tableRow = page.locator(".panel-table tbody tr", { hasText: "Alpha" });
    const rowMenu = page.getByRole("button", { name: "Actions for Alpha" });
    expect((await tableRow.boundingBox())!.height).toBe(24);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(rowMenu).toHaveCSS("opacity", "0");
    await tableRow.hover();
    await expect(rowMenu).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await rowMenu.focus();
    await expect(rowMenu).toHaveCSS("opacity", "1");
    await rowMenu.click();
    await page.getByRole("menuitem", { name: "Open row" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Row r1 in rows");
  });
});
