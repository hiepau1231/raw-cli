/**
 * The Files tab's shell: the rail reaches the page, a deep link is served rather than 404ed, and every main link stays
 * reachable at narrow widths without page-wide overflow.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
const heading = (page: Page) => page.getByRole("heading", { name: "Files", exact: true });
/** The Files navigation that is on screen: the second column on a wide window, the menu drawer on a narrow one. */
const navOf = (page: Page) => page.locator('nav[aria-label="Files"]:visible');
const treeOf = (page: Page) => navOf(page).locator("[data-files-tree]");
const filterOf = (page: Page) => navOf(page).getByRole("textbox", { name: "Filter files" });
const made: string[] = [];
test.afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `raw-files-${name}-`)));
  made.push(dir);
  return dir;
}
/** A file in the fixture's workspace, which is also the dashboard's working directory. */
function workspaceFile(root: string, path: string, text = "x"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
/** Opens the tab from the launch link, so the token is in this tab's session storage. */
async function openFiles(page: Page, raw: { server: { launchUrl: string } }): Promise<void> {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(heading(page)).toBeVisible();
}

test("the rail opens the files page and the server serves it as a page", async ({ page, raw }) => {
  const origin = new URL(raw.server.launchUrl).origin;
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(heading(page)).toBeVisible();

  // A reload and a deep link (the token lives in this tab's session storage after the first visit) are pages, not 404s.
  await page.reload();
  await expect(heading(page)).toBeVisible();
  await page.goto(`${origin}/files`);
  await expect(heading(page)).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await axe(page);
  }
});

test("at 320 px every main link stays on screen and the new one keeps its name", async ({ page, raw }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(heading(page)).toBeVisible();

  const links = await page.getByRole("navigation", { name: "Main" }).locator("a").evaluateAll((items) => items.map((item) => {
    const rect = item.getBoundingClientRect();
    return { name: (item.textContent ?? "").trim(), x: rect.x, right: rect.right, width: rect.width, height: rect.height };
  }));
  expect(links.length).toBeGreaterThanOrEqual(5);
  for (const link of links) {
    expect(link.x, `${link.name} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(link.right, `${link.name} ends on screen`).toBeLessThanOrEqual(320);
    expect(link.width, `${link.name} is at least 32 px wide`).toBeGreaterThanOrEqual(32);
    expect(link.height, `${link.name} is at least 32 px tall`).toBeGreaterThanOrEqual(32);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Labels remain visible on a phone, while each link keeps a 32 px touch target and fits the viewport.
  for (const name of ["Chat", "Agents", "Library", "Files", "Settings"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link, name).toBeVisible();
    await expect(link, name).toHaveAccessibleName(name);
    await expect(link.locator("span").first(), name).toBeVisible();
  }
  await axe(page);
});

test("the tree lists the workspace, opens folders and filters by path", async ({ page, raw }) => {
  workspaceFile(raw.root, "src/app.ts", "const a = 1;\n");
  workspaceFile(raw.root, "src/deep/notes.md", "# Notes\n");
  workspaceFile(raw.root, "docs/readme.md", "# Readme\n");
  await openFiles(page, raw);

  const tree = treeOf(page);
  await expect(tree).toBeVisible();
  // The tree is in the second column; the main area holds the viewer only.
  await expect(page.locator(".context-panel nav[aria-label=\"Files\"] [data-files-tree]")).toBeVisible();
  await expect(page.locator("main [data-files-tree]")).toHaveCount(0);
  // A top-level folder starts collapsed: its children are not rendered at all until it is opened.
  const src = tree.locator('button[data-folder="src"]');
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(tree.locator('button[data-file="src/app.ts"]')).toHaveCount(0);
  await src.click();
  await expect(src).toHaveAttribute("aria-expanded", "true");
  await expect(tree.locator('button[data-file="src/app.ts"]')).toBeVisible();
  // A nested folder has its own state, and closing the parent hides the branch again.
  const deep = tree.locator('button[data-folder="src/deep"]');
  await expect(deep).toHaveAttribute("aria-expanded", "false");
  await deep.click();
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toBeVisible();
  await src.click();
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toHaveCount(0);

  // The filter keeps matching files with the folders that lead to them, really open, and counts them.
  const filter = filterOf(page);
  await filter.fill("notes.md");
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toBeVisible();
  await expect(tree.locator('button[data-folder="src/deep"]')).toHaveAttribute("aria-expanded", "true");
  await expect(tree.locator('button[data-file="docs/readme.md"]')).toHaveCount(0);
  await expect(page.getByText(/^1 of \d+ files$/)).toBeVisible();
  // Open because the reader's filter opened it, not because the button claims so: clicking it really collapses.
  await tree.locator('button[data-folder="src/deep"]').click();
  await expect(tree.locator('button[data-folder="src/deep"]')).toHaveAttribute("aria-expanded", "false");
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toHaveCount(0);
  await tree.locator('button[data-folder="src/deep"]').click();
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toBeVisible();
  await filter.fill("nothing-matches-this");
  await expect(page.getByText("No file matches the filter")).toBeVisible();
  await filter.fill("");
  await expect(tree.locator('button[data-folder="docs"]')).toBeVisible();
  await expect(page.getByText(/^1 of \d+ files$/)).toHaveCount(0);
});

test("an empty workspace says so, and a cut listing says how many of how many are shown", async ({ page, raw }) => {
  // The fixture keeps its own config and state inside the workspace, so these two states are injected.
  await page.route("**/api/workspaces/files?*", (route) =>
    route.fulfill({ json: { root: raw.root, entries: [], total: 0, truncated: false } }));
  await openFiles(page, raw);
  await expect(page.getByText("This workspace has no files")).toBeVisible();
  await expect(treeOf(page)).toHaveCount(0);

  const entries = [0, 1, 2].map((index) => ({ path: `f${index}.ts`, name: `f${index}.ts` }));
  await page.unroute("**/api/workspaces/files?*");
  await page.route("**/api/workspaces/files?*", (route) =>
    route.fulfill({ json: { root: raw.root, entries, total: 20_005, truncated: true } }));
  await page.reload();
  await expect(page.getByText("Showing 3 of 20005 files")).toBeVisible();
  await expect(treeOf(page).locator('button[data-file="f1.ts"]')).toBeVisible();
});

/** A one-pixel PNG, so the viewer's image branch is exercised against real bytes. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("choosing a file shows it, keeps the choice in the address and survives a reload", async ({ page, raw }) => {
  workspaceFile(raw.root, "src/app.ts", "const answer = 42;\n");
  workspaceFile(raw.root, "tài liệu/ghi chú #1 100%.md", "# Ghi chú\n");
  await openFiles(page, raw);

  const tree = treeOf(page);
  await tree.locator('button[data-folder="src"]').click();
  await tree.locator('button[data-file="src/app.ts"]').click();
  const viewer = page.locator("[data-files-viewer]");
  await expect(viewer).toContainText("const answer = 42;");
  await expect(page).toHaveURL(/\/files\?path=src%2Fapp\.ts$/);

  // The address carries the choice, so a reload comes back to the same file.
  await page.reload();
  await expect(page.locator("[data-files-viewer]")).toContainText("const answer = 42;");

  // A name with a space, a hash, a percent sign and non-ASCII characters round-trips too.
  const filter = filterOf(page);
  await filter.fill("ghi chú");
  await treeOf(page).locator('button[data-file="tài liệu/ghi chú #1 100%.md"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("# Ghi chú");
  await page.reload();
  await expect(page.locator("[data-files-viewer]")).toContainText("# Ghi chú");

  // The rail's own Files link comes back to a clean tab because its address carries no file.
  await filter.fill("");
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.locator("[data-files-viewer]")).toContainText("Choose a file");
});
test("the Files tab reads the selected workspace when relative names overlap", async ({ page, raw }) => {
  const other = folder("same-name");
  workspaceFile(raw.root, "shared.txt", "default workspace");
  workspaceFile(other, "shared.txt", "selected workspace");
  await raw.json("/sessions", "POST", { cwd: other });
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-file="shared.txt"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("default workspace");

  await page.locator(".workspace-button:visible").click();
  await page.locator(".workspace-popover .workspace-row", { hasText: basename(other) }).locator("[data-row-main]").click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(treeOf(page).locator('button[data-file="shared.txt"]')).toBeVisible();
  await treeOf(page).locator('button[data-file="shared.txt"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("selected workspace");
});

test("Files Reload rereads text and immediately refreshes a new listing entry", async ({ page, raw }) => {
  workspaceFile(raw.root, "reload.txt", "before reload");
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-file="reload.txt"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("before reload");
  writeFileSync(join(raw.root, "reload.txt"), "after reload");
  workspaceFile(raw.root, "new-entry.txt", "new");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("[data-files-viewer]")).toContainText("after reload");
  await expect(treeOf(page).locator('button[data-file="new-entry.txt"]')).toBeVisible();
});

test("Files Retry rereads a file that vanished and was recreated", async ({ page, raw }) => {
  workspaceFile(raw.root, "retry.txt", "first");
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-file="retry.txt"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("first");
  rmSync(join(raw.root, "retry.txt"));
  await treeOf(page).locator('button[data-file="retry.txt"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("no longer exists");
  workspaceFile(raw.root, "retry.txt", "recreated");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("[data-files-viewer]")).toContainText("recreated");
});

test("an ignored file deep link opens even when no files are listed", async ({ page, raw }) => {
  workspaceFile(raw.root, ".env", "DIRECT_LINK_VALUE=visible");
  await page.route("**/api/workspaces/files?*", (route) => route.fulfill({
    json: { root: raw.root, entries: [], total: 0, truncated: false },
  }));
  await page.goto(raw.server.launchUrl);
  await page.goto(`${new URL(raw.server.launchUrl).origin}/files?path=.env`);
  await expect(page.locator("[data-files-viewer]")).toContainText("DIRECT_LINK_VALUE=visible");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("[data-files-viewer]")).toContainText("DIRECT_LINK_VALUE=visible");
});


test("markdown renders as source and as a preview", async ({ page, raw }) => {
  workspaceFile(raw.root, "notes.md", "# Title\n\nSome **bold** text.\n");
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-file="notes.md"]').click();

  const viewer = page.locator("[data-files-viewer]");
  await expect(viewer).toContainText("# Title");
  await page.getByRole("radio", { name: "Preview", exact: true }).click();
  await expect(viewer.getByRole("heading", { name: "Title" })).toBeVisible();
  await expect(viewer).not.toContainText("Some **bold** text.");
  await page.getByRole("radio", { name: "Source", exact: true }).click();
  await expect(viewer).toContainText("Some **bold** text.");
});

test("an image renders, and one whose bytes are not an image says so", async ({ page, raw }) => {
  writeFileSync(join(raw.root, "pixel.png"), PIXEL_PNG);
  workspaceFile(raw.root, "fake.png", "this is not a png");
  await openFiles(page, raw);

  const tree = treeOf(page);
  await tree.locator('button[data-file="pixel.png"]').click();
  const image = page.locator("[data-files-viewer] img[data-files-image]");
  await expect(image).toBeVisible();
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.locator("[data-files-image-size]")).toHaveText(`${PIXEL_PNG.length} bytes`);

  // A .png the browser cannot decode is explained instead of showing a broken image.
  await tree.locator('button[data-file="fake.png"]').click();
  await expect(page.locator("[data-files-notice]")).toContainText("cannot be shown");

  // So is one the host refuses to serve at all: the request itself failed, which is the other branch. The glob
  // carries the query, so it matches the file route and not the listing beside it.
  await page.route("**/api/workspaces/file?*", (route) =>
    route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: { code: "unsupported_media_type", message: "Only raster images can be shown" } }) }));
  await page.reload();
  await expect(page.locator("[data-files-notice]")).toContainText("cannot be shown");
});

test("binary, oversized and unreadable files are explained rather than guessed", async ({ page, raw }) => {
  writeFileSync(join(raw.root, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0x03]));
  writeFileSync(join(raw.root, "big.txt"), "a".repeat(1024 * 1024 + 500));
  workspaceFile(raw.root, "gone.ts", "bye");
  await openFiles(page, raw);

  const tree = treeOf(page);
  const viewer = page.locator("[data-files-viewer]");
  await tree.locator('button[data-file="blob.bin"]').click();
  await expect(page.locator("[data-files-notice]")).toContainText("binary file, 4 bytes, not shown");

  await tree.locator('button[data-file="big.txt"]').click();
  await expect(page.locator("[data-files-notice]")).toContainText(/first 1 MiB of \d+ bytes/);

  // A file the listing showed and something removed before the click: the server's message and a Retry, while the
  // tree keeps working.
  await expect(tree.locator('button[data-file="gone.ts"]')).toBeVisible();
  rmSync(join(raw.root, "gone.ts"));
  await tree.locator('button[data-file="gone.ts"]').click();
  await expect(viewer).toContainText("no longer exists");
  await expect(viewer.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await tree.locator('button[data-file="blob.bin"]').click();
  await expect(viewer).toContainText("binary file, 4 bytes, not shown");
});

test("the copy buttons copy the path and the contents", async ({ page, raw, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  workspaceFile(raw.root, "src/app.ts", "const answer = 42;\n");
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-folder="src"]').click();
  await treeOf(page).locator('button[data-file="src/app.ts"]').click();

  const viewer = page.locator("[data-files-viewer]");
  await expect(viewer).toContainText("const answer = 42;");
  await viewer.getByRole("button", { name: "Copy path" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("src/app.ts");
  await viewer.getByRole("button", { name: "Copy contents" }).click();
  // The clipboard keeps the platform's line endings (CRLF on Windows); the file's text is unchanged.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe("const answer = 42;\n");
});

for (const width of [320, 360]) {
  test(`at ${width} px the tree is in the menu drawer, the viewer fits and every control is a target`, async ({ page, raw }) => {
    const deep = "src/deeply/nested/very-long-file-name-that-keeps-going-and-going.ts";
    workspaceFile(raw.root, deep, "const deep = true;\n");
    workspaceFile(raw.root, "docs/README.md", "# Readme\n");
    await page.setViewportSize({ width, height: 900 });
    await openFiles(page, raw);

    // The main area is the viewer: the tree and its filter are not on the page until the menu is opened.
    await expect(page.locator("[data-files-tree]:visible")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(true);
    await page.getByRole("button", { name: "Workspace menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-files-tree]")).toBeVisible();

    // A deeply nested file: its name is cut in the tree but keeps its full value, and the row still fits.
    await dialog.getByRole("textbox", { name: "Filter files" }).fill("very-long-file-name");
    const row = dialog.locator(`button[data-file="${deep}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("title", deep);
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "the row fits").toBe(true);
    const target = async (scope: Locator) => scope.locator("button:visible").evaluateAll((items) =>
      items
        .map((item) => {
          const rect = item.getBoundingClientRect();
          return { label: item.getAttribute("aria-label") ?? (item.textContent ?? "").trim(), width: rect.width, height: rect.height };
        })
        .filter((item) => item.width < 32 || item.height < 32));
    expect(await target(dialog.locator('nav[aria-label="Files"]')), "the drawer's controls are 32 px targets").toEqual([]);
    await row.click();
    await expect(dialog).toHaveCount(0);

    const viewer = page.locator("[data-files-viewer]");
    await expect(viewer).toContainText("const deep = true;");
    await expect(page.locator(".files-viewer-path")).toHaveAttribute("title", deep);
    /** Nothing in the pane may stick out of it; a name that is cut with an ellipsis is meant to be wider inside. */
    const overflowing = await viewer.evaluate((element) => {
      const limit = element.getBoundingClientRect().right;
      return Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter((node) => node.getBoundingClientRect().right > limit + 1)
        .map((node) => `${node.tagName}.${node.className}`);
    });
    expect(overflowing, "nothing in the viewer sticks out of the pane").toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(true);
    expect(await target(page.locator(".files-page")), "the page's controls are 32 px targets").toEqual([]);

    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await axe(page);
    }
  });
}

test("the listing is asked for only while Files is open, and the tree keeps its filter within a workspace", async ({ page, raw }) => {
  workspaceFile(raw.root, "src/app.ts", "const a = 1;\n");
  workspaceFile(raw.root, "docs/readme.md", "# Readme\n");
  let listings = 0;
  page.on("request", (request) => { if (request.url().includes("/api/workspaces/files")) listings++; });
  await page.goto(raw.server.launchUrl);
  for (const name of ["Agents", "Library", "Chat"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await page.waitForLoadState("networkidle");
  }
  expect(listings, "nothing asks for the listing outside Files").toBe(0);

  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(treeOf(page).locator('button[data-folder="src"]')).toBeVisible();
  expect(listings, "opening Files asks once").toBe(1);

  // Leaving Files and coming back to the same workspace keeps what the reader typed and the folders they opened.
  await treeOf(page).locator('button[data-folder="src"]').click();
  await filterOf(page).fill("readme");
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(filterOf(page)).toHaveValue("readme");
  await filterOf(page).fill("");
  await expect(treeOf(page).locator('button[data-folder="src"]')).toHaveAttribute("aria-expanded", "true");
});

test("changing workspace clears the filter and the opened folders", async ({ page, raw }) => {
  const other = folder("reset");
  workspaceFile(raw.root, "src/app.ts", "const a = 1;\n");
  workspaceFile(other, "src/app.ts", "const b = 2;\n");
  await raw.json("/sessions", "POST", { cwd: other });
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-folder="src"]').click();
  await treeOf(page).locator('button[data-file="src/app.ts"]').click();
  await filterOf(page).fill("app");

  await page.locator(".workspace-button:visible").click();
  await page.locator(".workspace-popover .workspace-row", { hasText: basename(other) }).locator("[data-row-main]").click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await expect(filterOf(page)).toHaveValue("");
  await expect(treeOf(page).locator('button[data-folder="src"]')).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/files$/);
});

test("the menu drawer shows the same tree state as the column", async ({ page, raw }) => {
  workspaceFile(raw.root, "src/app.ts", "const a = 1;\n");
  workspaceFile(raw.root, "docs/readme.md", "# Readme\n");
  await openFiles(page, raw);
  await filterOf(page).fill("readme");
  await treeOf(page).locator('button[data-folder="docs"]').waitFor();
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole("button", { name: "Workspace menu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Filter files" })).toHaveValue("readme");
  await expect(dialog.locator('button[data-file="docs/readme.md"]')).toBeVisible();
  await expect(dialog.locator('button[data-file="src/app.ts"]')).toHaveCount(0);
});

test("tree rows line up like the other second-column lists: one left edge, indent per level, a raised selection", async ({ page, raw }) => {
  const long = `${"very-long-file-name-".repeat(6)}end.ts`;
  expect(long.length).toBeGreaterThan(120);
  workspaceFile(raw.root, "alpha.ts");
  workspaceFile(raw.root, "beta.ts");
  workspaceFile(raw.root, "src/one.ts");
  workspaceFile(raw.root, "src/two.ts");
  workspaceFile(raw.root, `src/${long}`);
  workspaceFile(raw.root, "l1/l2/l3/l4/l5/l6/bottom.ts");
  workspaceFile(raw.root, "my docs/notes #1 100%.md");
  workspaceFile(raw.root, "tài-liệu/đọc-tôi.md");
  await openFiles(page, raw);
  const tree = treeOf(page);
  await expect(tree.locator("[data-folder]").first()).toBeVisible();
  const column = page.locator(".context-panel");
  const widthBefore = (await column.boundingBox())!.width;

  const left = async (selector: string) => tree.locator(selector).locator(".files-tree-name").evaluate((el) => el.getBoundingClientRect().left);
  // Siblings share one left edge: names are not centred or pushed by their icons' differences.
  expect(await left('[data-file="alpha.ts"]')).toBeCloseTo(await left('[data-file="beta.ts"]'), 0);

  await tree.locator('[data-folder="src"]').click();
  await expect(tree.locator('[data-file="src/one.ts"]')).toBeVisible();
  const top = await left('[data-folder="src"]');
  const child = await left('[data-file="src/one.ts"]');
  expect(child - top, "a child is indented under its folder").toBeGreaterThanOrEqual(10);
  expect(await left('[data-file="src/one.ts"]')).toBeCloseTo(await left('[data-file="src/two.ts"]'), 0);

  // Six levels deep: each level indents further and the deepest row still lies inside the column.
  let previous = await left('[data-folder="l1"]');
  let path = "l1";
  for (const level of ["l2", "l3", "l4", "l5", "l6"]) {
    await tree.locator(`[data-folder="${path}"]`).click();
    path = `${path}/${level}`;
    const x = await left(`[data-folder="${path}"]`);
    expect(x, `${path} is indented past its parent`).toBeGreaterThan(previous);
    previous = x;
  }
  await tree.locator(`[data-folder="${path}"]`).click();
  await expect(tree.locator(`[data-file="${path}/bottom.ts"]`)).toBeVisible();
  const box = await tree.locator(`[data-file="${path}/bottom.ts"]`).boundingBox();
  const colBox = await column.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(colBox!.x + colBox!.width + 1);

  // A 120+ character name is cut with an ellipsis and a full-name title; it never widens the column or the tree.
  const longRow = tree.locator(`[data-file="src/${long}"]`);
  await expect(longRow).toHaveAttribute("title", `src/${long}`);
  expect((await column.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
  expect(await tree.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await longRow.locator(".files-tree-name").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  // Names with spaces, #, % and diacritics are shown as written and open their file.
  await tree.locator('[data-folder="my docs"]').click();
  await expect(tree.locator('[data-file="my docs/notes #1 100%.md"] .files-tree-name')).toHaveText("notes #1 100%.md");
  await tree.locator('[data-folder="tài-liệu"]').click();
  await tree.locator('[data-file="tài-liệu/đọc-tôi.md"]').click();
  await expect(page).toHaveURL(/path=t%C3%A0i-li%E1%BB%87u%2F%C4%91%E1%BB%8Dc-t%C3%B4i\.md|path=t.*i-li.*u\/.*c-t.*i\.md/);

  // A folder shows how many files it holds, at the right edge of its row.
  const count = tree.locator('[data-folder="src"] .files-tree-count');
  await expect(count).toHaveText("3");
  const row = await tree.locator('[data-folder="src"]').boundingBox();
  const countBox = await count.boundingBox();
  expect(row!.x + row!.width - (countBox!.x + countBox!.width)).toBeLessThanOrEqual(16);

  // The chosen file is a raised card, distinct from a plain row, and carries aria-current.
  const selected = tree.locator('[data-file="tài-liệu/đọc-tôi.md"]');
  await expect(selected).toHaveAttribute("aria-current", "true");
  const paint = (locator: Locator) => locator.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, shadow: s.boxShadow }; });
  const picked = await paint(selected);
  const plain = await paint(tree.locator('[data-file="alpha.ts"]'));
  expect(picked.bg).not.toBe(plain.bg);
  expect(picked.shadow).not.toBe("none");
  expect(plain.shadow).toBe("none");

  // The chevron turns when a folder is open.
  const turn = (name: string) => tree.locator(`[data-folder="${name}"] .files-tree-chevron`).evaluate((el) => getComputedStyle(el).transform);
  expect(await turn("src")).not.toBe("none");
});

test("a folder's count is its files, and under a filter only the files that match", async ({ page, raw }) => {
  workspaceFile(raw.root, "src/a.ts");
  workspaceFile(raw.root, "src/b.ts");
  workspaceFile(raw.root, "src/inner/c.ts");
  workspaceFile(raw.root, "src/inner/note.md");
  workspaceFile(raw.root, "docs/d.md");
  await openFiles(page, raw);
  const tree = treeOf(page);
  const count = (folder: string) => tree.locator(`[data-folder="${folder}"] .files-tree-count`);
  await expect(count("src")).toHaveText("4");
  await expect(count("docs")).toHaveText("1");
  await filterOf(page).fill(".md");
  await expect(count("src")).toHaveText("1");
  await expect(count("src/inner")).toHaveText("1");
  await expect(count("docs")).toHaveText("1");
  await filterOf(page).fill("c.ts");
  await expect(count("src")).toHaveText("1");
  await expect(tree.locator('[data-folder="docs"]')).toHaveCount(0);
});

test("the viewer has a header with chips and a code block that fills the main area and scrolls inside itself", async ({ page, raw }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const title = `${"long-title-".repeat(14)}.ts`;
  expect(title.length).toBeGreaterThan(150);
  workspaceFile(raw.root, "five.ts", "a\nb\nc\nd\ne\n");
  workspaceFile(raw.root, "big.ts", Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join("\n"));
  workspaceFile(raw.root, title, "x\n");
  workspaceFile(raw.root, "chat.md", "# T\n\n```ts\nconst a = 1;\n```\n");
  await openFiles(page, raw);
  const viewer = page.locator("[data-files-viewer]");
  const blockFills = async () => {
    const block = await viewer.locator(".code-block").boundingBox();
    const main = await page.locator("main").boundingBox();
    expect(main!.y + main!.height - (block!.y + block!.height), "the block reaches the bottom of the main area").toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), "the page does not grow").toBe(true);
    expect(await page.locator("main").evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "main does not scroll").toBe(true);
  };

  await treeOf(page).locator('[data-file="five.ts"]').click();
  await expect(viewer.getByRole("heading", { name: "five.ts" })).toBeVisible();
  const chips = viewer.locator(".files-viewer-chips");
  await expect(chips).toContainText("TS");
  await expect(chips).toContainText("10 B");
  await expect(chips).toContainText("5 lines");
  await blockFills();
  // One Copy for contents, no code header of its own, and a gutter that is neither read out nor selectable.
  await expect(viewer.getByRole("button", { name: "Copy contents" })).toHaveCount(1);
  await expect(viewer.getByRole("button", { name: "Copy code" })).toHaveCount(0);
  await expect(viewer.locator(".code-label")).toHaveCount(0);
  const gutter = viewer.locator(".code-gutter");
  await expect(gutter).toHaveAttribute("aria-hidden", "true");
  expect(await gutter.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  expect(await gutter.evaluate((el) => el.textContent)).toBe("1\n2\n3\n4\n5");
  await expect(viewer.locator(".code-block code")).toContainText("e");
  // Line N of the code is on the row of number N: the two columns start together and are as tall as each other.
  const rows = async () => viewer.evaluate((el) => {
    const g = el.querySelector(".code-gutter")!.getBoundingClientRect();
    const c = el.querySelector(".code-block code")!.getBoundingClientRect();
    return { top: Math.abs(g.top - c.top), height: Math.abs(g.height - c.height) };
  });
  expect((await rows()).top).toBeLessThanOrEqual(1);
  expect((await rows()).height).toBeLessThanOrEqual(2);

  await treeOf(page).locator('[data-file="big.ts"]').click();
  await expect(viewer.locator(".code-gutter")).toContainText("3000");
  await blockFills();
  expect((await rows()).top).toBeLessThanOrEqual(1);
  expect((await rows()).height).toBeLessThanOrEqual(2);
  await expect(chips).toContainText("3000 lines");
  expect(await viewer.locator(".code-block pre").evaluate((el) => el.scrollHeight > el.clientHeight * 5)).toBe(true);

  await treeOf(page).locator(`[data-file="${title}"]`).click();
  const name = viewer.getByRole("heading", { name: title });
  await expect(name).toBeVisible();
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect((await name.boundingBox())!.width).toBeLessThan(900);

  // Chat's code blocks are unchanged: a fenced block in the preview keeps its label and has no gutter.
  await treeOf(page).locator('[data-file="chat.md"]').click();
  await viewer.getByRole("radio", { name: "Preview", exact: true }).click();
  await expect(viewer.locator(".files-markdown .code-label")).toHaveCount(1);
  await expect(viewer.locator(".files-markdown .code-gutter")).toHaveCount(0);
});
