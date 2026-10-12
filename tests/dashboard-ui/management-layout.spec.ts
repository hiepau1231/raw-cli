import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { openPath, packageSource, seedLibrary } from "./library-seed.js";

// Agents, Library and Settings in the chat's look (docs/chat-design.md §3 "Second column").

/** Resolves a token to the colour syntax getComputedStyle returns for backgrounds. */
const token = (page: Page, name: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
const style = (locator: Locator, property: "backgroundColor" | "textDecorationLine" | "boxShadow") =>
  locator.evaluate((element, property) => getComputedStyle(element)[property], property);
const setTheme = (page: Page, theme: string) =>
  page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
const nav = (page: Page, name: string) => page.getByRole("navigation", { name });
const count = (page: Page, label: string) =>
  nav(page, "Library categories").getByRole("link", { name: label, exact: true }).locator(".nav-count");

test.describe("navigation rows", () => {
  test("navigation rows fill on hover and are never underlined", async ({ page, raw }) => {
    const pages = [
      { path: "/agents/raw", nav: "Agents", hover: "second", current: "raw" },
      { path: "/library/tools", nav: "Library categories", hover: "Skills", current: "Tools" },
      { path: "/settings/models", nav: "Settings categories", hover: "Chat", current: "Models & connections" },
    ];
    await raw.json("/agents", "POST", { revision: (await raw.json<{ revision: string }>("/config")).revision, action: "create", name: "second",
      value: { model: "fixture", tools: { use: [] } } });
    for (const item of pages) {
      await openPath(page, raw.server.launchUrl, item.path);
      const current = nav(page, item.nav).getByRole("link", { name: item.current, exact: true });
      await expect(current).toHaveAttribute("aria-current", "page");
      for (const theme of ["light", "dark"]) {
        await setTheme(page, theme);
        const hovered = nav(page, item.nav).getByRole("link", { name: item.hover, exact: true });
        await hovered.hover();
        const fill = await token(page, "--backdrop-hover");
        await expect.poll(() => style(hovered, "backgroundColor"), `${item.nav} ${theme} hover fill`).toBe(fill);
        expect(await style(hovered, "textDecorationLine"), `${item.nav} ${theme} underline`).toBe("none");
        expect(await style(current, "backgroundColor"), `${item.nav} ${theme} current`).toBe(await token(page, "--on-backdrop"));
        await page.mouse.move(0, 0);
      }
    }
  });

  test("Library rows show an icon and the count of their list", async ({ page, raw }) => {
    await seedLibrary(raw);
    const lists: [string, string, string][] = [
      ["Tools", "/library/tools", "Tools catalog"],
      ["Skills", "/library/skills", "Skills catalog"],
      ["Hooks", "/library/hooks", "Hooks catalog"],
      ["Vars", "/library/vars", "Variables"],
      ["MCP", "/library/mcp", "MCP servers"],
      ["Packages", "/library/packages", "Installed packages"],
    ];
    for (const [label, path, list] of lists) {
      await openPath(page, raw.server.launchUrl, path);
      const rows = page.getByRole("list", { name: list }).getByRole("listitem");
      await expect(rows.first()).toBeVisible();
      await expect(count(page, label), label).toHaveText(String(await rows.count()));
      const link = nav(page, "Library categories").getByRole("link", { name: label, exact: true });
      await expect(link.locator("svg")).toHaveCount(1);
    }
    // The accessible name is the label alone.
    await expect(nav(page, "Library categories").getByRole("link", { name: "Tools", exact: true })).toHaveCount(1);

    // A component created in the app counts at once. The catalog is the oracle: a local folder is listed under
    // `local/` and `agent/`, so one folder adds two rows.
    const catalog = async () => (await raw.json<unknown[]>("/components/tools")).length;
    await openPath(page, raw.server.launchUrl, "/library/tools");
    const tools = await catalog();
    await expect(count(page, "Tools")).toHaveText(String(tools));
    await page.getByRole("button", { name: "Create tool" }).click();
    await page.getByLabel("Component folder").fill("counted");
    await page.getByRole("button", { name: "Create from example" }).click();
    await expect(page.getByRole("heading", { name: "local/counted" })).toBeVisible();
    const created = await catalog();
    expect(created).toBeGreaterThan(tools);
    await expect(count(page, "Tools")).toHaveText(String(created));
    // Deleting it counts down again.
    await page.getByRole("button", { name: "Actions for local/counted" }).click();
    await page.getByRole("menuitem", { name: "Delete component" }).click();
    await page.getByRole("dialog", { name: "Delete component" }).getByRole("button", { name: "Delete component" }).click();
    await expect(page.getByRole("list", { name: "Tools catalog" })).toBeVisible();
    await expect(count(page, "Tools")).toHaveText(String(tools));

    // Installing a package changes the catalogs while Packages stays open.
    await openPath(page, raw.server.launchUrl, "/library/packages");
    await expect(count(page, "Tools")).toHaveText(String(tools));
    await page.getByRole("button", { name: "Import package" }).first().click();
    await page.getByLabel("Local package path").fill(packageSource(raw.root, "counted-kit"));
    await page.getByRole("button", { name: "Inspect path", exact: true }).click();
    await page.getByLabel("Install alias").fill("counted");
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Installed counted" })).toBeVisible();
    const installed = await catalog();
    expect(installed).toBeGreaterThan(tools);
    await expect(count(page, "Tools")).toHaveText(String(installed));
  });

  test("a count that fails to load is left out, and other pages fetch no catalog", async ({ page, raw }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(raw.server.launchUrl);
    await expect(page.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests.filter((path) => /^\/api\/(components|packages)/.test(path))).toEqual([]);

    const fail = (route: { fulfill(options: object): Promise<void> }) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected failure" } }) });
    await page.route("**/api/components/hooks", fail);
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await expect(count(page, "Tools")).toHaveText(/^\d+$/);
    await expect.poll(() => requests.filter((path) => path === "/api/components/hooks").length).toBeGreaterThan(0);
    await expect(count(page, "Hooks")).toHaveCount(0);

    // A count that loaded is dropped when a later refresh of its list fails, not left stale.
    await page.unroute("**/api/components/hooks");
    await openPath(page, raw.server.launchUrl, "/library/hooks");
    await expect(count(page, "Hooks")).toHaveText(/^\d+$/);
    await expect(count(page, "Skills")).toHaveText(/^\d+$/);
    await page.route("**/api/components/skills", fail);
    // Past SWR's 2 s dedupe window, so opening Skills revalidates the cached list.
    await page.waitForTimeout(2100);
    await nav(page, "Library categories").getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Injected failure");
    await expect(count(page, "Skills")).toHaveCount(0);
    await expect(count(page, "Tools")).toHaveText(/^\d+$/);
  });
});

test.describe("agent rows", () => {
  const long = "release-notes-writer-for-the-vietnamese-documentation-site";
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file", "builtin/bash"] } },
      extraAgents: {
        second: { model: "fixture", tools: { use: [] } },
        [long]: { model: "fixture", tools: { use: ["builtin/read_file"] } },
      },
    },
  });

  test("agent rows show avatar, subtitle and the default dot, and a long name stays on one line", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/agents");
    const agents = nav(page, "Agents");
    const row = (name: string) => agents.getByRole("link", { name, exact: true });
    await expect(row("raw").locator(".nav-agent small")).toHaveText("fixture · 2 tools · 0 skills");
    await expect(row("second").locator(".nav-agent small")).toHaveText("fixture · 0 tools · 0 skills");
    await expect(row(long).locator(".nav-agent small")).toHaveText("fixture · 1 tool · 0 skills");
    await expect(row("second").locator(".nav-avatar")).toHaveText("s");
    await expect(agents.locator(".nav-default")).toHaveCount(1);
    await expect(row("raw").locator(".nav-default")).toHaveCount(1);

    const box = async (name: string) => (await row(name).boundingBox())!;
    expect((await box(long)).height).toBe((await box("second")).height);
    expect((await box(long)).height).toBe((await box("raw")).height);
    const name = row(long).locator(".nav-agent strong > span").first();
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await agents.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
});
