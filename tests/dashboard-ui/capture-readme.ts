import { chromium, expect } from "@playwright/test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

// Run after npm run build. The README screenshot (docs/dashboard/overview-dark.png): an English session with a
// todo, a command, an edit with its diff and an answer, then a write waiting for approval, with the side panel open.
// The chat gallery (capture-chat.ts) runs the same shapes with Vietnamese text to stress the layout.
const call = (id: string, name: string, args: unknown, reasoning?: string) => ({
  frames: [openAiFrame({ ...(reasoning ? { reasoning } : {}), tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone],
});
const done = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });

const todos = [
  { content: "Run the link checker on every docs page", status: "done" },
  { content: "Retry fetches that fail with ECONNRESET", status: "in_progress" },
  { content: "Fix the links to renamed pages", status: "pending" },
];
const ANSWER = `## Link check

Checked **44 links** on 12 pages: 41 work and 3 are broken.

| Page | Problem | Broken |
|---|---|---:|
| docs/getting-started.md | target page renamed | 2 |
| docs/faq.md | ECONNRESET | 1 |

\`scripts/check-links.mjs\` now retries a fetch up to 3 times on \`ECONNRESET\`. Next: point the 2 links at the renamed page and run the checker again.`;

const scenario = {
  agent: { tools: { use: ["builtin/todo", "builtin/edit_file", "builtin/write_file", "builtin/bash"], rules: [{ match: "builtin/bash", effect: "allow" }, { match: "builtin/edit_file", effect: "allow" }, { match: "builtin/todo", effect: "allow" }, { match: "builtin/write_file", effect: "ask" }] } },
  responses: [
    call("t1", "todo", { title: "Fix the docs links", todos }, "Plan first, then run the link checker and read what fails."),
    call("b1", "bash", { command: "node scripts/check-links.mjs --all", description: "Check every docs link" }),
    call("e1", "edit_file", { path: "scripts/check-links.mjs", old_string: "  return await fetchPage(url);", new_string: "  for (let attempt = 1; attempt <= 3; attempt++) {\n    try { return await fetchPage(url); }\n    catch (error) { if (error.code !== \"ECONNRESET\" || attempt === 3) throw error; }\n  }" }),
    done(ANSWER),
    call("w1", "write_file", { path: "reports/links.md", content: "# Link report\n\n41 ok, 3 broken\n" }),
    done("Saved the report to `reports/links.md`."),
  ],
};

mkdirSync("docs/dashboard", { recursive: true });
const browser = await chromium.launch();
// The workspace is in the temporary directory; as HOME it shows as ~/… in the header, as on a real machine.
const raw = await dashboardFixture({ ...scenario, env: { HOME: realpathSync(tmpdir()) } });
try {
  mkdirSync(join(raw.root, "scripts"), { recursive: true });
  writeFileSync(join(raw.root, "scripts", "check-links.mjs"), "async function check(url) {\n  return await fetchPage(url);\n}\nconsole.log('checked 44 links: 41 ok, 3 broken');\n");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1240 }, deviceScaleFactor: 2 });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const box = page.getByRole("textbox", { name: "Message" });
  const send = async (text: string) => { await box.fill(text); await page.getByRole("button", { name: "Send", exact: true }).click(); };
  await send("Check every link in the docs and make the checker retry when the connection resets");
  await expect(page.getByTestId("assistant-message").first()).toContainText("Link check", { timeout: 30000 });
  await send("Save a report to reports/links.md");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible({ timeout: 30000 });
  // The first work group open, one row per tool; the whole conversation fits from the request to the approval.
  const group = page.locator(".work-group").first();
  if ((await group.locator(".work-toggle").getAttribute("aria-expanded")) === "false") await group.locator(".work-toggle").click();
  await page.locator(".conversation-scroll").evaluate((element) => { element.scrollTop = 0; });
  const request = (await page.getByTestId("user-message").first().boundingBox())!;
  const approval = (await page.getByRole("button", { name: "Allow once", exact: true }).boundingBox())!;
  const composer = (await page.locator(".composer-area").boundingBox())!;
  if (request.y < 0 || approval.y + approval.height > composer.y) throw new Error("the conversation does not fit above the composer");
  await page.mouse.move(0, 0);
  await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; if (active?.closest(".composer-box")) active.blur(); });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/dashboard/overview-dark.png", animations: "disabled" });
  console.log("captured docs/dashboard/overview-dark.png");
} finally {
  await raw.close();
  await browser.close();
}
