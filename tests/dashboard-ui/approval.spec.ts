import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.use({
  scenario: {
    agent: {
      request_timeout_ms: 20000,
      tools: {
        use: ["builtin/bash"],
        rules: [
          {
            match: "builtin/bash",
            effect: "ask",
            when: { source: "arguments", any: "command", regex: "^rm\\b" },
          },
        ],
      },
    },
    responses: [
      {
        frames: [
          openAiFrame(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "approval",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"rm not-present"}',
                  },
                },
              ],
            },
            "tool_calls",
          ),
          openAiDone,
        ],
      },
      {
        frames: [openAiFrame({ content: "Denied safely" }, "stop"), openAiDone],
      },
    ],
  },
});
test("pending permission remains visible from Settings and denying does not edit policy", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("try command");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.getByRole("link", { name: /Needs approval/ }).click();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Denied safely", { exact: true })).toBeVisible();
  expect(raw.config.agents.raw.tools).toEqual({
    use: ["builtin/bash"],
    rules: [
      {
        match: "builtin/bash",
        effect: "ask",
        when: { source: "arguments", any: "command", regex: "^rm\\b" },
      },
    ],
  });
});

test("Allow once executes only the pending call and leaves the rule unchanged", async ({
  page,
  raw,
}) => {
  const file = join(raw.root, "not-present");
  writeFileSync(file, "fixture");
  await openChat(page, raw);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("remove the fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect
    .poll(() => raw.server.context.store!.listOperations()[0]?.state)
    .toBe("completed");
  expect(existsSync(file)).toBe(false);
  expect(raw.provider.requests.length).toBe(2);
});

test.describe("approval headline", () => {
  const bash = (id: string, args: Record<string, unknown>) => ({
    frames: [
      openAiFrame(
        { tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify(args) } }] },
        "tool_calls",
      ),
      openAiDone,
    ],
  });
  test.use({
    scenario: {
      agent: {
        request_timeout_ms: 20000,
        tools: { use: ["builtin/bash"], rules: [{ match: "builtin/bash", effect: "ask" }] },
      },
      responses: [
        bash("canonical", { command: "npm test" }),
        bash("aliased", { cmd: "npm test" }),
        { frames: [openAiFrame({ content: "Both denied" }, "stop"), openAiDone] },
      ],
    },
  });
  test("the card headline is the call summary for canonical and aliased arguments", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("run the tests twice");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    for (let index = 0; index < 2; index++) {
      const card = page.locator("section.approval");
      await expect(card).toHaveCount(1);
      const headline = card.locator(".approval-headline");
      await expect(headline.locator(".approval-title")).toHaveText("Run command");
      await expect(headline.locator(".approval-summary")).toHaveText("$ npm test");
      // The arguments stay available from the card's Arguments toggle, closed at first.
      const args = card.getByRole("button", { name: "Arguments", exact: true });
      await expect(args).toHaveAttribute("aria-expanded", "false");
      await expect(card.locator(".approval-arguments")).toHaveCount(0);
      await args.click();
      await expect(card.locator(".approval-arguments")).toContainText('"command": "npm test"');
      await card.getByRole("button", { name: "Deny", exact: true }).click();
      // The denial reaches the model before the next call (or the answer) is requested.
      await expect.poll(() => raw.provider.requests.length).toBe(index + 2);
    }
    await expect(page.getByText("Both denied", { exact: true })).toBeVisible();
  });
});
