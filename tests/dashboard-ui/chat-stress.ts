/**
 * A chat with real-length content (docs/chat-design.md §9), the same shapes as the approved mockups with neutral sample text:
 * a long Vietnamese request, reasoning, a todo, a successful command, an edit with a diff, a failing `npm run lint`, and
 * an answer with a heading, a table, inline code, a code block with `!==` and `<=`, and a list; then a write that waits
 * for approval; then a pending `ask_user` question.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { expect } from "./fixtures.js";

const call = (id: string, name: string, args: unknown, reasoning?: string) => ({
  frames: [openAiFrame({ ...(reasoning ? { reasoning } : {}), tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone],
});
const done = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });

export const REQUEST = "Rà soát lại toàn bộ liên kết trong thư mục tài liệu và sửa script kiểm tra nếu gặp lỗi kết nối";
export const REPORT = "Ghi báo cáo vào reports/links.md";
export const ASK = "Hỏi tôi cách xử lý 3 liên kết hỏng";
export const REASONING = "Người dùng muốn rà soát liên kết. Trước hết lập kế hoạch, rồi đọc script check-links và chạy nó.";
export const QUESTION = "Bạn muốn xử lý 3 liên kết hỏng thế nào?";
export const todos = [
  { content: "Đọc báo cáo lỗi của lần chạy trước", status: "done" },
  { content: "Kiểm tra lại liên kết của từng trang tài liệu", status: "in_progress" },
  { content: "Sửa script check-links để thử lại khi ECONNRESET", status: "pending" },
];
export const CHECK = { command: "node scripts/check-links.mjs --all --verbose", description: "Kiểm tra liên kết của tất cả trang tài liệu" };
export const LINT = { command: "npm run lint", description: "Chạy linter" };
export const EDIT = { path: "scripts/check-links.mjs", old_string: "  return await fetchPage(url);", new_string: "  for (let attempt = 1; attempt <= 3; attempt++) {\n    try { return await fetchPage(url); }\n    catch (error) { if (error.code !== \"ECONNRESET\" || attempt === 3) throw error; }\n  }" };
export const WRITE = { path: "reports/links.md", content: "# Link report\n\n41 ok, 3 broken\n" };
export const ANSWER = `## Kết quả rà soát liên kết

Đã kiểm tra **44 liên kết** trong 12 trang. 41 liên kết hoạt động, 3 liên kết hỏng vì trang đích đã đổi tên.

| Trang | Trạng thái | Liên kết hỏng |
|---|---|---:|
| docs/getting-started-with-the-command-line.md | trang đích đã đổi tên | 2 |
| docs/faq.md | ECONNRESET | 1 |
| docs/index.md | ổn | 0 |

Tôi đã sửa \`scripts/check-links.mjs\` để thử lại tối đa 3 lần khi gặp \`ECONNRESET\`:

\`\`\`js
for (let attempt = 1; attempt <= 3; attempt++) {
  try { return await fetchPage(url); }
  catch (error) { if (error.code !== "ECONNRESET" || attempt === 3) throw error; }
}
\`\`\`

Việc tiếp theo:
- Cập nhật 3 liên kết trỏ tới trang đã đổi tên.
- Chạy lại \`npm run check-links\` để xác nhận.`;

/** Bash, edit and todo run without asking; write_file waits for approval, as in the mockup. */
export const chatScenario = {
  agent: { tools: { use: ["builtin/todo", "builtin/edit_file", "builtin/write_file", "builtin/bash", "builtin/ask_user"], rules: [{ match: "builtin/bash", effect: "allow" }, { match: "builtin/edit_file", effect: "allow" }, { match: "builtin/todo", effect: "allow" }, { match: "builtin/write_file", effect: "ask" }] } },
  responses: [
    call("t1", "todo", { title: "Rà soát liên kết", todos }, REASONING),
    call("b1", "bash", CHECK),
    call("e1", "edit_file", EDIT),
    call("b2", "bash", LINT),
    done(ANSWER),
    call("w1", "write_file", WRITE),
    done("Đã ghi báo cáo vào `reports/links.md`."),
    call("a1", "ask_user", { question: QUESTION, options: [{ label: "Sửa tất cả" }, { label: "Bỏ qua và báo cáo" }] }),
    done("ok"),
  ],
};

/** The script the session runs and edits, and a lint script that fails on stderr; install before the chat is opened. */
export function installChatWorkspace(raw: { root: string }) {
  mkdirSync(join(raw.root, "scripts"), { recursive: true });
  writeFileSync(join(raw.root, "scripts", "check-links.mjs"), "async function check(url) {\n  return await fetchPage(url);\n}\nconsole.log('checked 44 links: 41 ok, 3 broken');\n");
  writeFileSync(join(raw.root, "package.json"), JSON.stringify({ scripts: { lint: "node -e \"console.error('scripts/check-links.mjs:3:5  error  Missing semicolon'); process.exit(1)\"" } }));
}

/**
 * Runs the session up to `stage`: "answer" (the first turn answered), "approval" (the write waits for approval) or
 * "question" (the write allowed, the question pending). Leaves the side panel as it is.
 */
export async function seedChat(page: Page, raw: { server: { launchUrl: string } }, stage: "answer" | "approval" | "question" = "answer") {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  const box = page.getByRole("textbox", { name: "Message" });
  const send = async (text: string) => { await box.fill(text); await page.getByRole("button", { name: "Send", exact: true }).click(); };
  await send(REQUEST);
  await expect(page.getByTestId("assistant-message").first()).toContainText("Kết quả rà soát liên kết", { timeout: 30000 });
  if (stage === "answer") return;
  await send(REPORT);
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeVisible({ timeout: 30000 });
  if (stage === "approval") return;
  await allow.click();
  await expect(page.getByTestId("assistant-message").nth(1)).toBeVisible({ timeout: 30000 });
  await send(ASK);
  await page.locator(".inline-tool-view").last().waitFor({ timeout: 30000 });
}
