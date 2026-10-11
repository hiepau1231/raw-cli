import { AxeBuilder } from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

// The model-visible name of `mcp/fixture/selected` (src/tools/mcp-client.ts aliasFor).
const mcpAlias = `mcp_fixture_selected_${createHash("sha256").update("fixture\0selected").digest("hex").slice(0, 12)}`;
const call = (id: string, name: string, args: Record<string, unknown>, index: number) =>
  ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test.use({
  scenario: {
    agent: {
      request_timeout_ms: 20000,
      tools: { use: ["builtin/bash", "builtin/edit_file", "mcp/fixture/selected", "local/lookup"] },
    },
    config: {
      mcp: { servers: { fixture: { transport: "stdio", command: process.execPath,
        args: ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href,
          join(process.cwd(), "tests/fixtures/mcp-stdio.ts")],
        env: { MCP_LABEL: "fixture", MCP_ANNOTATE: "1" } } } },
    },
    responses: [
      { frames: [openAiFrame({ tool_calls: [
        call("run", "bash", { command: "printf 'alpha\\nbeta\\n'", description: "Print two lines" }, 0),
        call("fail", "bash", { command: "echo broken >&2; exit 3" }, 1),
        call("edit", "edit_file", { path: "notes.txt", old_string: "--old line", new_string: "++new line" }, 2),
        call("mcp", mcpAlias, { value: "markdown" }, 3),
        call("lookup", "lookup", { query: "widgets" }, 4),
        call("big", "bash", { command: "seq 1 40000" }, 5),
        call("gone", "bash", { command: "seq 1 50000" }, 6),
        call("invalid", "bash", { timeout: 5000 }, 7),
        call("many", "lookup", { query: "many" }, 8),
        call("mixed", mcpAlias, { value: "mixed" }, 9),
      ] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "Tools finished" }, "stop"), openAiDone] },
    ],
  },
});

type Raw = Parameters<Parameters<typeof test>[2]>[0]["raw"];

/** Runs the scripted turn: a plugin tool with display hints, a file to edit, then the seven calls above. */
async function runTools(page: Page, raw: Raw) {
  const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "lookup");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "lookup", version: "1.0.0", name: "lookup",
    description: "Look up records", display: { title: "Lookup", kind: "search", icon: "constructor", summary: "{query}", result: "json" },
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    entry: "./index.mjs" }));
  writeFileSync(join(folder, "index.mjs"), `export async function handler(args) {
    if (args.query === "many") return { content: [{ type: "json", value: { items: Array.from({ length: 4000 }, (_, i) => ({ id: i, label: "item " + i })) } }] };
    return { content: [{ type: "json", value: { query: args.query, results: [{ name: "first", tags: { color: "blue", size: { width: 3 } } }] } }] };
  }`);
  writeFileSync(join(raw.root, "notes.txt"), "keep line\n--old line\nlast line\n");
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("use the tools");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Tools finished")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".tool-row")).toHaveCount(10);
  for (const toggle of await page.locator(".work-toggle").all())
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

const card = (page: Page, summary: string | RegExp) =>
  page.locator(".tool-row").filter({ has: page.locator(".tool-line .tool-summary", { hasText: summary }) });
const open = async (page: Page, summary: string | RegExp) => {
  const item = card(page, summary);
  const toggle = item.locator(".tool-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  return item;
};

test("rows show the status glyph, title, monospace summary, a chip for other states than OK and the duration", async ({ page, raw }) => {
  await runTools(page, raw);
  const expected = [
    { summary: "$ printf 'alpha\\nbeta\\n'", title: "Print two lines", kind: "execute", status: "OK", glyph: "check" },
    { summary: "notes.txt", title: "Edit", kind: "edit", status: "OK", glyph: "check" },
    { summary: "markdown", title: "Fixture lookup", kind: "read", status: "OK", glyph: "check" },
    { summary: "widgets", title: "Lookup", kind: "search", status: "OK", glyph: "check" },
    { summary: "$ echo broken >&2; exit 3", title: "Run command", kind: "execute", status: "Exit 3", glyph: "x" },
  ];
  for (const item of expected) {
    const row = card(page, item.summary);
    const line = row.locator(".tool-line");
    await expect(row).toHaveAttribute("data-kind", item.kind);
    await expect(line.locator(".tool-glyph")).toHaveAttribute("data-glyph", item.glyph);
    await expect(line.locator(".tool-title")).toHaveText(item.title);
    await expect(line.locator("code.tool-summary")).toHaveText(item.summary);
    // The state is always accessible text; only states other than OK show a chip.
    await expect(line.locator(".tool-toggle")).toHaveAccessibleName(new RegExp(`^${item.status} ${item.title}`));
    if (item.status === "OK") await expect(line.locator(".tool-status")).toHaveCount(0);
    else await expect(line.locator(".tool-status")).toHaveText(item.status);
    await expect(line.locator(".tool-duration")).toHaveText(/^\d+ ms$|^\d+\.\d s$/);
    expect(await line.locator("code.tool-summary").evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i);
  }
});

test("an error row starts open and the others start closed", async ({ page, raw }) => {
  await runTools(page, raw);
  const failed = card(page, "$ echo broken >&2; exit 3");
  await expect(failed.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(failed.locator(".tool-card")).toHaveClass(/failed/);
  await expect(failed.locator(".tool-terminal .term-line[data-channel=stderr]")).toHaveText(["broken"]);
  await expect(failed.locator(".tool-foot-meta")).toHaveText(/^stderr · exit 3 · \d+\.\d s$/);
  for (const summary of ["$ printf 'alpha\\nbeta\\n'", "notes.txt", "markdown", "widgets"]) {
    await expect(card(page, summary).locator(".tool-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(card(page, summary).locator(".tool-card")).toBeHidden();
  }
  // A call that never ran is an error shown as text, not as terminal output.
  const invalid = page.locator(".tool-row").filter({ has: page.locator(".tool-status", { hasText: "Error" }) });
  await expect(invalid).toHaveCount(1);
  await expect(invalid.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(invalid.locator(".tool-text")).toContainText("command");
  await expect(invalid.locator(".tool-terminal")).toHaveCount(0);
  // Arguments open under the body from the card's footer.
  const args = failed.getByRole("button", { name: "Arguments" });
  await expect(args).toHaveAttribute("aria-expanded", "false");
  await expect(failed.locator(".tool-arguments")).toHaveCount(0);
  await args.click();
  await expect(args).toHaveAttribute("aria-expanded", "true");
  await expect(failed.locator(".tool-arguments")).toContainText('"command": "echo broken >&2; exit 3"');
});

test("the card's Copy copies the output without its markers", async ({ page, raw, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await runTools(page, raw);
  const row = await open(page, "$ printf 'alpha\\nbeta\\n'");
  await expect(row.locator(".tool-terminal")).toHaveText("alpha\nbeta\n");
  await expect(row.locator(".tool-foot-meta")).toHaveText(/^stdout · exit 0 · \d+\.\d s$/);
  await row.getByRole("button", { name: "Copy output" }).click();
  await expect(row.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("alpha\nbeta");
});

test("an edit shows a unified diff with added and removed line classes", async ({ page, raw }) => {
  await runTools(page, raw);
  const diff = (await open(page, "notes.txt")).locator(".diff-view");
  // Changed lines whose text starts with `--`/`++` stay changes; only the file headers are metadata.
  await expect(diff.locator(".diff-remove")).toHaveText(["---old line"]);
  await expect(diff.locator(".diff-add")).toHaveText(["+++new line"]);
  await expect(diff.locator(".diff-meta")).toHaveText([/^--- /, /^\+\+\+ /]);
  await expect(diff.locator(".diff-hunk")).toHaveCount(1);
  await expect(diff.locator(".diff-context")).toContainText([" keep line", " last line"]);
  const colors = await diff.evaluate((node) => ["diff-add", "diff-remove", "diff-context"].map((kind) =>
    getComputedStyle(node.querySelector(`.${kind}`)!).backgroundColor));
  expect(new Set(colors).size).toBe(3);
});

test("a markdown MCP result renders as markdown", async ({ page, raw }) => {
  await runTools(page, raw);
  const body = (await open(page, "markdown")).locator(".tool-markdown");
  await expect(body.getByRole("heading", { name: "fixture heading" })).toBeVisible();
  await expect(body.getByRole("listitem")).toHaveText(["first item", "second item"]);
  await expect(body).not.toContainText("# fixture heading");
  await expect(card(page, "markdown").getByRole("button", { name: "Copy result" })).toBeVisible();
  // Markdown text that comes with structured content stays markdown, and the structured content is a tree.
  const mixed = await open(page, "mixed");
  await expect(mixed.locator(".tool-markdown").getByRole("heading", { name: "Search results" })).toBeVisible();
  await expect(mixed.getByRole("list", { name: "JSON result" }).locator(".json-key")).toHaveText(["count: "]);
  await expect(mixed.locator(".tool-markdown")).not.toContainText("count");
});

test("a JSON result is a tree with two levels open that expands and collapses", async ({ page, raw }) => {
  await runTools(page, raw);
  const tree = (await open(page, "widgets")).getByRole("list", { name: "JSON result" });
  await expect(card(page, "widgets").getByRole("button", { name: "Copy result" })).toBeVisible();
  const root = tree.locator(":scope > li > details");
  await expect(root).toHaveAttribute("open", "");
  const results = root.locator(":scope > ul > li > details").filter({ hasText: "results" });
  await expect(results).toHaveAttribute("open", "");
  const first = results.locator(":scope > ul > li > details").first();
  expect(await first.getAttribute("open")).toBeNull();
  await expect(first.locator(".json-string").filter({ hasText: '"first"' })).toBeHidden();
  await first.locator(":scope > summary").click();
  await expect(first.locator(".json-string").filter({ hasText: '"first"' })).toBeVisible();
  await root.locator(":scope > summary").click();
  expect(await root.getAttribute("open")).toBeNull();
  await expect(tree.locator(".json-key").filter({ hasText: "query" })).toBeHidden();
});

test("Load full output shows the saved copy, and the unavailable message once it is deleted", async ({ page, raw }) => {
  await runTools(page, raw);
  const session = page.url().match(/\/chat\/([^/#?]+)/)![1]!;
  const view = await raw.json<{ history: { items: Array<{ toolResult?: { id?: string; host?: { fullOutputPath?: string } } }> } }>(`/sessions/${session}`);
  const path = (id: string) => view.history.items.find((item) => item.toolResult?.id === id)?.toolResult?.host?.fullOutputPath;
  expect(path("big")).toBeTruthy();
  rmSync(path("gone")!);

  const big = await open(page, "$ seq 1 40000");
  await expect(big.locator(".tool-terminal")).not.toContainText("\n20000\n");
  await big.getByRole("button", { name: "Full output" }).click();
  const full = big.locator(".tool-terminal.full");
  await expect(full).toContainText("\n20000\n");
  expect((await full.innerText()).trim().split("\n")).toHaveLength(40000);
  await expect(big.locator(".tool-foot-meta")).toHaveText(/^Full output\b/);
  await expect(big.getByRole("button", { name: "Full output" })).toHaveCount(0);
  await expect(big.getByText("capped at 64 MiB")).toHaveCount(0);

  const gone = await open(page, "$ seq 1 50000");
  await gone.getByRole("button", { name: "Full output" }).click();
  await expect(gone.getByRole("status").filter({ hasText: "Full output is no longer available." })).toBeVisible();
  await expect(gone.locator(".tool-terminal")).toHaveCount(1);
});

test("open tool cards pass axe in light and dark", async ({ page, raw }) => {
  await runTools(page, raw);
  for (const summary of ["$ printf 'alpha\\nbeta\\n'", "notes.txt", "markdown", "widgets", "$ seq 1 40000"]) await open(page, summary);
  for (const item of await page.locator(".tool-card:visible").getByRole("button", { name: "Arguments" }).all()) await item.click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    const results = await new AxeBuilder({ page }).include(".work-group").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations).toEqual([]);
  }
});

test("a capped JSON result keeps its tree and shows the capping notice as text", async ({ page, raw }) => {
  await runTools(page, raw);
  const many = await open(page, "many");
  const tree = many.getByRole("list", { name: "JSON result" });
  await expect(tree.locator(".json-key").filter({ hasText: /^items: $/ })).toBeVisible();
  await expect(many.locator(".tool-text")).toContainText(/truncated|omitted|full output/i);
});
