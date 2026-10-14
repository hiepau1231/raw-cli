/**
 * The Files tab's shell (docs/files-tab-spec.md D6, D8; docs/dashboard.md): the rail reaches the page, a deep link
 * is served rather than 404ed, and adding the fifth rail item keeps every main link on screen at 320 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
const heading = (page: Page) => page.getByRole("heading", { name: "Files", exact: true });

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
