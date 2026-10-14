/**
 * The Files tab's shell (docs/files-tab-spec.md D6, D8; docs/dashboard.md): the rail reaches the page, a deep link
 * is served rather than 404ed, and adding the fifth rail item keeps every main link on screen at 320 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
const heading = (page: Page) => page.getByRole("heading", { name: "Files", exact: true });
const treeOf = (page: Page) => page.locator("[data-files-tree]");
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

  // D8: on a phone the labels may be visually hidden, but the links keep their names and can still be clicked.
  for (const name of ["Chat", "Agents", "Library", "Files", "Settings"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link, name).toBeVisible();
    await expect(link, name).toHaveAccessibleName(name);
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

  // The filter keeps matching files with the folders that lead to them, open, and counts them.
  const filter = page.getByRole("textbox", { name: "Filter files" });
  await filter.fill("notes.md");
  await expect(tree.locator('button[data-file="src/deep/notes.md"]')).toBeVisible();
  await expect(tree.locator('button[data-folder="src/deep"]')).toHaveAttribute("aria-expanded", "true");
  await expect(tree.locator('button[data-file="docs/readme.md"]')).toHaveCount(0);
  await expect(page.getByText(/^1 of \d+ files$/)).toBeVisible();
  await filter.fill("nothing-matches-this");
  await expect(page.getByText("No file matches the filter")).toBeVisible();
  await filter.fill("");
  await expect(tree.locator('button[data-folder="docs"]')).toBeVisible();
  await expect(page.getByText(/^1 of \d+ files$/)).toHaveCount(0);
});

test("an empty workspace says so, and a cut listing says how many of how many are shown", async ({ page, raw }) => {
  // The fixture keeps its own config and state inside the workspace, so these two states are injected.
  await page.route("**/api/workspaces/files", (route) =>
    route.fulfill({ json: { root: raw.root, entries: [], total: 0, truncated: false } }));
  await openFiles(page, raw);
  await expect(page.getByText("This workspace has no files")).toBeVisible();
  await expect(treeOf(page)).toHaveCount(0);

  const entries = [0, 1, 2].map((index) => ({ path: `f${index}.ts`, name: `f${index}.ts` }));
  await page.unroute("**/api/workspaces/files");
  await page.route("**/api/workspaces/files", (route) =>
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
  const filter = page.getByRole("textbox", { name: "Filter files" });
  await filter.fill("ghi chú");
  await treeOf(page).locator('button[data-file="tài liệu/ghi chú #1 100%.md"]').click();
  await expect(page.locator("[data-files-viewer]")).toContainText("# Ghi chú");
  await page.reload();
  await expect(page.locator("[data-files-viewer]")).toContainText("# Ghi chú");
});

test("markdown renders as source and as a preview", async ({ page, raw }) => {
  workspaceFile(raw.root, "notes.md", "# Title\n\nSome **bold** text.\n");
  await openFiles(page, raw);
  await treeOf(page).locator('button[data-file="notes.md"]').click();

  const viewer = page.locator("[data-files-viewer]");
  await expect(viewer).toContainText("# Title");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(viewer.getByRole("heading", { name: "Title" })).toBeVisible();
  await expect(viewer).not.toContainText("Some **bold** text.");
  await page.getByRole("button", { name: "Source", exact: true }).click();
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

  // A .png the browser cannot decode is explained instead of showing a broken image.
  await tree.locator('button[data-file="fake.png"]').click();
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
