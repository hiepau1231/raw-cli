import { AxeBuilder } from "@axe-core/playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const call = (id: string, name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const section = (page: import("@playwright/test").Page) => page.locator('[data-tab-panel="host/files_changed#files_changed"]');
/** The row whose file name is exactly `name`. */
const row = (page: import("@playwright/test").Page, name: string) =>
  section(page).locator(".panel-files li", { has: page.locator(".panel-file-name", { hasText: new RegExp(`^${name.replace(".", "\\.")}$`) }) });
async function send(page: import("@playwright/test").Page, text: string, count: number) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message")).toHaveCount(count);
}
async function show(page: import("@playwright/test").Page) {
  if (!await page.locator(".inspector").count()) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.getByRole("tab", { name: "Files changed", exact: true }).click();
}
test.describe("Files changed accumulated successes", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/write_file", "builtin/edit_file", "builtin/apply_patch", "builtin/bash"] } }, responses: [
    call("patch", "apply_patch", { patch: "*** Begin Patch\n*** Add File: alpha.txt\n+hello\n*** Add File: beta.txt\n+world\n*** End Patch" }), answer,
    call("overwrite", "write_file", { path: "alpha.txt", content: "updated alpha\n" }),
    call("failed", "edit_file", { path: "failed.txt", old_string: "missing", new_string: "replacement" }),
    call("edit", "edit_file", { path: "beta.txt", old_string: "world", new_string: "beta edited\nsecond line" }),
    call("create", "write_file", { path: "src/gamma.txt", content: "gamma success\n" }), answer,
    call("bash", "bash", { command: "printf untracked > shell-only.txt" }), answer,
  ] } });
  test("write, edit and patch calls share one panel with only successful paths, preserve diffs on reload and exclude shell changes", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "patch files", 1);
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(2);
    // The explanation is in the tab header's tooltip, not repeated in the body (docs/side-panel-design.md §3).
    await expect(section(page).locator(".sp-tab-heading h3")).toHaveAttribute("title", /Successful tool writes in this session; not Git status or Bash edits\./);
    await expect(section(page)).not.toContainText("Successful tool writes");
    await expect(section(page).locator(".panel-files")).toContainText("alpha.txt");
    await expect(section(page).locator(".panel-files")).toContainText("beta.txt");
    expect(readFileSync(join(raw.root, "alpha.txt"), "utf8")).toBe("hello\n");
    await send(page, "some writes succeed", 2);
    await expect(section(page).locator(".panel-files li")).toHaveCount(3);
    await expect(page.locator('[role=tab][data-tab$="#files_changed"]')).toHaveCount(1);
    await expect(section(page).locator(".panel-files")).not.toContainText("failed.txt");
    expect(readFileSync(join(raw.root, "beta.txt"), "utf8")).toBe("beta edited\nsecond line\n");
    expect(existsSync(join(raw.root, "failed.txt"))).toBe(false);
    // A source-control list (docs/tool-ux-design.md §6.3): the name, its directory muted, the session's +/− and the status letter.
    // alpha: +1 then +1 −1; beta: +1 then +2 −1; gamma: +1.
    await expect(section(page).locator(".sp-tab-summary")).toHaveText("3 files · +6 −2");
    await expect(section(page).locator(".sp-tab-header .sp-chip")).toHaveCount(0);
    await expect(row(page, "gamma.txt").locator(".panel-file-dir")).toHaveText("src/");
    const color = (selector: string) => row(page, "gamma.txt").locator(selector).evaluate((element) => getComputedStyle(element).color);
    expect(await color(".panel-file-dir"), "the directory is muted").not.toBe(await color(".panel-file-name"));
    await expect(row(page, "alpha.txt").locator(".panel-file-dir")).toHaveCount(0);
    for (const [name, added, removed] of [["alpha.txt", "+2", "−1"], ["beta.txt", "+3", "−1"], ["gamma.txt", "+1", "−0"]]) {
      await expect(row(page, name!).locator(".panel-file-added")).toHaveText(added!);
      await expect(row(page, name!).locator(".panel-file-removed")).toHaveText(removed!);
      await expect(row(page, name!).locator(".panel-file-status")).toHaveText("A");
      expect((await row(page, name!).boundingBox())!.height).toBe(24);
    }
    // Hide completed belongs to checklists only.
    await page.getByRole("button", { name: "Files changed panel menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Hide tab" })).toBeVisible();
    await expect(page.getByRole("menuitemcheckbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // No footer while no history was dropped, and no absolute paths.
    await expect(section(page)).not.toContainText("Omitted");
    await expect(section(page)).not.toContainText(raw.root);
    // A row expands its latest diff from the keyboard.
    const beta = row(page, "beta.txt").locator("button[aria-expanded]");
    await expect(beta).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, "beta.txt").locator(".diff-view")).toHaveCount(0);
    await beta.focus();
    await page.keyboard.press("Enter");
    await expect(beta).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, "beta.txt").locator(".diff-add")).toHaveText(["+beta edited", "+second line"]);
    await expect(row(page, "beta.txt").locator(".diff-remove")).toHaveText(["-world"]);
    expect(await row(page, "beta.txt").locator(".diff-view pre").evaluate((element) => getComputedStyle(element).maxHeight)).toBe("400px");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
    await beta.click();
    await expect(row(page, "beta.txt").locator(".diff-view")).toHaveCount(0);
    await send(page, "shell change", 3);
    await expect(section(page).locator(".panel-files")).not.toContainText("shell-only.txt");
    expect(existsSync(join(raw.root, "shell-only.txt"))).toBe(true);
    await page.reload();
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(3);
    await row(page, "gamma.txt").locator("button[aria-expanded]").click();
    await expect(row(page, "gamma.txt").locator(".diff-add")).toHaveText(["+gamma success"]);
    // The @ action shows on hover or focus and inserts the path relative to the session cwd.
    const insert = row(page, "alpha.txt").getByRole("button", { name: "Insert @alpha.txt into the message" });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(insert).toHaveCSS("opacity", "0");
    await row(page, "alpha.txt").hover();
    await expect(insert).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await insert.focus();
    await expect(insert).toHaveCSS("opacity", "1");
    await row(page, "gamma.txt").hover();
    await row(page, "gamma.txt").getByRole("button", { name: "Insert @src/gamma.txt into the message" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("@src/gamma.txt ");
  });
});
test.describe("Files changed preflight", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/apply_patch"] } }, responses: [
    call("conflict", "apply_patch", { patch: "*** Begin Patch\n*** Add File: alpha.txt\n+new\n*** Update File: beta.txt\n@@\n-wrong context\n+changed\n*** End Patch" }), answer,
  ] } });
  test("a later patch conflict publishes no successful file claims", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "beta.txt"), "original\n");
    await openChat(page, raw);
    await send(page, "conflicting patch", 1);
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(0);
    expect(existsSync(join(raw.root, "alpha.txt"))).toBe(false);
    expect(readFileSync(join(raw.root, "beta.txt"), "utf8")).toBe("original\n");
  });
});
test.describe("Files changed bounded diff", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/write_file"] } }, responses: [
    call("large", "write_file", { path: "large.txt", content: "retained content\n".repeat(600) }), answer,
  ] } });
  test("oversized diff visibly reports truncation", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "large write", 1);
    await show(page);
    await expect(row(page, "large.txt").locator(".panel-file-added")).toHaveText("+600");
    await row(page, "large.txt").locator("button[aria-expanded]").click();
    await expect(row(page, "large.txt").locator(".diff-view")).toContainText("[diff truncated]");
  });
});
