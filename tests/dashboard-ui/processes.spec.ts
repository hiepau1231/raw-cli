import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const call = (name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "command", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const section = (page: import("@playwright/test").Page) => page.locator('[data-panel="__commands"]');
const KEY = "raw.dashboard.commands.v1";
const toggleOf = (row: import("@playwright/test").Locator) => row.locator("button.command-toggle");
async function showCommands(page: import("@playwright/test").Page) {
  if (!await page.locator(".inspector").count()) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  const toggle = section(page).locator(".panel-toggle");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}
test.describe("Commands foreground", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "ok", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'zero ok'", description: "Say ok" }) } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "two", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'two fails' >&2; exit 2", workdir: "sub" }) } },
    ] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ tool_calls: [
      { index: 0, id: "slow", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 5", timeout: 1000 }) } },
    ] }, "tool_calls"), openAiDone] },
    answer,
  ] } });
  test("the Completed group stays open across a section collapse and a reload, and rows show glyph, command, duration and exit", async ({ page, raw }) => {
    mkdirSync(join(raw.root, "sub"));
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("run commands");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    // Foreground calls never open the side panel by themselves.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await showCommands(page);
    const rows = section(page).locator("li.command-row");
    const completed = section(page).getByRole("button", { name: "Completed (3)" });
    await expect(section(page).getByRole("button", { name: /^Running/ })).toHaveCount(0);
    await expect(completed).toHaveAttribute("aria-expanded", "false");
    await expect(rows.filter({ visible: true })).toHaveCount(0);
    // 1. The reported reset: open Completed, collapse the section, reopen it.
    await completed.click();
    await expect(rows.filter({ visible: true })).toHaveCount(3);
    await section(page).locator(".panel-toggle").click();
    await section(page).locator(".panel-toggle").click();
    await expect(completed).toHaveAttribute("aria-expanded", "true");
    await expect(rows.filter({ visible: true })).toHaveCount(3);
    // 2. A reload keeps it, from this browser's storage.
    await page.reload();
    await showCommands(page);
    await expect(completed).toHaveAttribute("aria-expanded", "true");
    await expect(rows.filter({ visible: true })).toHaveCount(3);
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").version, KEY)).toBe(1);
    // 3. Newest first: a timeout, a nonzero exit in another directory, then exit 0 with its description.
    const [slow, two, ok] = [rows.nth(0), rows.nth(1), rows.nth(2)];
    await expect(slow.locator(".command-glyph")).toHaveAttribute("data-glyph", "timeout");
    await expect(slow.locator("code.command-text")).toHaveText("sleep 5");
    await expect(slow.locator(".command-exit")).toHaveCount(0);
    await expect(slow.locator(".command-duration")).toHaveText(/^1\.\d s$/);
    await expect(two.locator(".command-glyph")).toHaveAttribute("data-glyph", "error");
    await expect(two.locator(".command-exit")).toHaveText("exit 2");
    await expect(two.locator(".command-cwd")).toHaveText(/\/sub$/);
    await expect(ok.locator(".command-glyph")).toHaveAttribute("data-glyph", "ok");
    await expect(ok.locator(".command-exit")).toHaveCount(0);
    await expect(ok.locator(".command-detail")).toHaveText("Say ok");
    await expect(ok.locator(".command-cwd")).toHaveCount(0);
    for (const row of [slow, two, ok]) expect((await row.locator(".command-line").boundingBox())!.height).toBe(24);
    // The command is one monospace line with an ellipsis.
    expect(await ok.locator("code.command-text").evaluate((element) => [getComputedStyle(element).whiteSpace, getComputedStyle(element).textOverflow])).toEqual(["nowrap", "ellipsis"]);
    // Clicking a row opens its output frame with the exit status.
    await toggleOf(two).click();
    await expect(toggleOf(two)).toHaveAttribute("aria-expanded", "true");
    await expect(two.locator(".command-output pre")).toContainText("two fails");
    await expect(two.locator(".command-output .terminal-bar")).toContainText("exit 2");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
  });
});

test.describe("Commands output", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash", "builtin/process"] } }, responses: [
    call("bash", { command: "for i in $(seq 1 300); do echo \"line $i\"; sleep 0.02; done; sleep 60", run_in_background: true, description: "Stream lines" }), answer,
  ] } });
  test("the output frame follows a running command and copies it, and Stop from the hover action ends the job", async ({ page, raw, context, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("stream");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    const row = section(page).locator("li.command-row").first();
    await expect(section(page).getByRole("button", { name: "Running (1)" })).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator(".command-glyph")).toHaveAttribute("data-glyph", "running");
    await expect(row.locator(".command-detail")).toHaveText("Stream lines");
    // 4. The frame keeps following new output while the command runs.
    await toggleOf(row).click();
    const pre = row.locator(".command-output pre");
    await expect(pre).toContainText("line 40");
    await expect(pre).toContainText("line 250", { timeout: 15000 });
    await expect.poll(() => pre.evaluate((element) => element.scrollHeight > element.clientHeight && element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
    await row.locator(".command-output").getByRole("button", { name: "Copy output" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/line 1\n[\s\S]*line 250/);
    // Actions show on hover or focus: Copy command, then 5. Stop.
    const stop = row.getByRole("button", { name: "Stop", exact: true });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(stop).toHaveCSS("opacity", "0");
    await row.locator(".command-line").hover();
    await expect(stop).toHaveCSS("opacity", "1");
    await row.getByRole("button", { name: "Copy command" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("for i in $(seq 1 300); do echo \"line $i\"; sleep 0.02; done; sleep 60");
    await row.locator(".command-line").hover();
    await stop.click();
    await expect(section(page).getByRole("button", { name: "Completed (1)" })).toBeVisible();
    await expect(section(page).getByText("Stop completed.", { exact: true })).toBeVisible();
    await expect(section(page).locator("li.command-row").first().locator(".command-glyph")).toHaveAttribute("data-glyph", "stopped");
  });
});

test.describe("Commands long command", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [call("bash", { command: `: '${"x".repeat(5000)}'; echo long done` }), answer] } });
  test("a command cut for display cannot be copied, and group choices survive a section collapse when storage fails", async ({ page, raw }) => {
    await page.addInitScript((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error("quota"); return setItem.call(this, name, value); };
    }, KEY);
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("long");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    const completed = section(page).getByRole("button", { name: "Completed (1)" });
    await completed.click();
    await section(page).locator(".panel-toggle").click();
    await section(page).locator(".panel-toggle").click();
    await expect(completed).toHaveAttribute("aria-expanded", "true");
    const row = section(page).locator("li.command-row").first();
    await expect(row.locator("code.command-text")).toHaveText(/^: 'x+…$/);
    await expect(row.getByRole("button", { name: "Copy command (unavailable: the command was cut at 4 KiB)" })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Copy command", exact: true })).toHaveCount(0);
  });
});

test.describe("Commands full output", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [call("bash", { command: "seq 1 200000" }), answer] } });
  test("a saved full output loads in the frame and @ inserts its path", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("count");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    await section(page).getByRole("button", { name: "Completed (1)" }).click();
    const row = section(page).locator("li.command-row").first();
    await toggleOf(row).click();
    await row.getByRole("button", { name: "Load full output" }).click();
    await expect(row.locator(".terminal-frame").last()).toContainText("199999\n200000");
    await row.locator(".command-line").hover();
    await row.getByRole("button", { name: /^Insert @.+ into the message$/ }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/^@\/\S+ $/);
  });
});

test.describe("Commands background from bash", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash", "builtin/process"] } }, responses: [call("bash", { command: "printf 'bash background'; sleep 60", run_in_background: true }), answer] } });
  test("a background bash call starts one managed job in the Commands panel", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start from bash");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(section(page)).toBeVisible();
    await expect(section(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(1);
    await toggleOf(section(page).locator("li.command-row").first()).click();
    await expect(section(page).locator("pre")).toContainText("bash background");
    await expect(section(page).getByRole("button", { name: /^Completed/ })).toHaveCount(0);
  });
});

test.describe("Commands background", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/process"], rules: [{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }] } }, responses: [call("process", { action: "start", command: "printf 'background ready'; sleep 60" }), { hold: true }] } });
  test("background survives its handler, streams during an active turn and Stop asks approval", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(section(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await toggleOf(section(page).locator("li.command-row").first()).click();
    await expect(section(page).locator("pre")).toContainText("background ready");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(section(page).getByRole("button", { name: /^Completed/ })).toBeVisible();
    await expect(section(page).locator("pre")).toContainText("background ready");
    await expect(section(page).locator("pre")).toContainText("[stdout]");
    await expect(section(page).getByText("Stop completed.", { exact: true })).toBeVisible();
    expect(raw.provider.requests.length).toBe(2);
  });
  test("a lost Stop response replays the failed receipt, then a fresh retry can request approval", async ({ page, raw }) => {
    let loseFirst = true;
    await page.route("**/commands/*/stop", async route => {
      if (!loseFirst) { await route.continue(); return; }
      loseFirst = false;
      await route.fetch();
      await route.abort("failed");
    });
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(section(page)).toBeVisible();
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(section(page).locator(".command-note[role=status]")).toContainText("Stop failed.");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(section(page).getByRole("button", { name: /^Completed/ })).toBeVisible();
  });
  test("Never suppresses background opening and hidden Commands remains hidden after reconnect", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, panelOpen: "never" })));
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await section(page).getByRole("button", { name: /menu/i }).click();
    await page.getByRole("menuitem", { name: /Hide/ }).click();
    await expect(section(page)).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(section(page)).toHaveCount(0);
  });
});
