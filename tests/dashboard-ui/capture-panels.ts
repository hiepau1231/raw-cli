import { chromium } from "@playwright/test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

// Run after npm run build. Real todo, file and bash calls against a mock provider, in disposable local state. Writes
// docs/dashboard/chat-dark-side-panel.png, and with RAW_CAPTURE_DIR set also the side panel in several states, for
// comparing by eye in review (docs/tool-ux-design.md §6.6); they are not pixel assertions.
mkdirSync("docs/dashboard", { recursive: true });
const extra = process.env.RAW_CAPTURE_DIR;
if (extra) mkdirSync(extra, { recursive: true });
const call = (id: string, name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const answer = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
const todos = ["Read the failing test", "Fix the parser", "Run the suite", "Update the docs"].map((content, index) => ({ content, status: index === 0 ? "done" : index === 1 ? "in_progress" : "pending" }));
const raw = await dashboardFixture({
  agent: { tools: { use: ["builtin/todo", "builtin/write_file", "builtin/edit_file", "builtin/bash"] } },
  responses: [
    call("todo1", "todo", { title: "Fix the parser", todos }), answer("I made a plan and started on it."),
    call("write1", "write_file", { path: "src/parser.ts", content: "export const a = 1;\nexport const b = 2;\n" }), answer("Added the parser."),
    call("edit1", "edit_file", { path: "README.md", old_string: "old", new_string: "new\nwith a second line" }), answer("Updated the README."),
    call("bash1", "bash", { command: "printf 'all 42 tests passed\\n'", description: "Run the tests" }), answer("Tests passed."),
    call("bash2", "bash", { command: "printf 'error: missing semicolon\\n' >&2; exit 2", description: "Run the linter" }), answer("Lint failed."),
  ],
  // The workspace is in the temporary directory; as HOME it shows as ~/… in the chat header, as on a real machine.
  env: { HOME: realpathSync(tmpdir()) },
});
writeFileSync(join(raw.root, "README.md"), "# Raw\nold\n");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const send = async (text: string, count: number) => {
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByTestId("assistant-message").nth(count - 1).waitFor({ timeout: 20000 });
  };
  await send("Fix the parser and tell me when the suite passes", 1);
  await page.locator(".work-toggle").first().click();
  await page.locator(".receipt-pill").first().waitFor();
  await page.getByText("Update the docs", { exact: true }).waitFor();
  await page.screenshot({ path: "docs/dashboard/chat-dark-side-panel.png", animations: "disabled" });
  console.log("wrote docs/dashboard/chat-dark-side-panel.png");
  if (extra) {
    for (const [index, text] of ["Write the parser", "Update the README", "Run the tests", "Run the linter"].entries()) await send(text, index + 2);
    const shot = async (name: string) => {
      await page.waitForTimeout(200);
      await page.locator(".inspector").screenshot({ path: join(extra, name), animations: "disabled" });
      console.log(`wrote ${join(extra, name)}`);
    };
    const select = (title: string) => page.getByRole("tab", { name: title, exact: true }).click();
    await shot("01-todo.png");
    await select("Overview");
    await shot("02-overview.png");
    await select("Commands");
    await page.locator("li.command-card", { hasText: "missing semicolon" }).first().getByRole("button", { name: "Output", exact: true }).click();
    await page.locator(".command-output pre", { hasText: "missing semicolon" }).waitFor();
    await shot("03-commands.png");
    await page.emulateMedia({ colorScheme: "light" });
    await shot("04-commands-light.png");
  }
} finally {
  await browser.close();
  await raw.close();
}
