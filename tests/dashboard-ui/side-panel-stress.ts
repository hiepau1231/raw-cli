/**
 * A session that fills every kind of side panel with real-length content (docs/side-panel-design.md §10), the same data
 * as the approved mockups (docs/design/side-panel/): long Vietnamese todo items in every state, a modified file on a deep
 * path, an added and a deleted one, a timed-out command, foreground Bash with a description, a failing command with
 * stderr, a background job that keeps streaming, a plugin panel with every block kind, and an `ask_user` question.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { expect } from "./fixtures.js";

const call = (id: string, name: string, args: unknown) => ({
  frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone],
});
const done = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });

export const LONG = "Sửa liên kết getting-started: trang đích đã đổi tên, không thể tải nội dung từ máy chủ tài liệu";
export const ACTIVE_TODO = "Kết thúc: kiểm tra lần cuối 44/44 liên kết trên toàn bộ trang tài liệu đã xuất bản";
export const ACTIVE_NOTE = "đang chờ phản hồi của máy chủ, khoảng 40 trang còn lại";
export const DEEP_FILE = "src/very/deep/nested/directory/structure/component-file-name-that-is-long.ts";
export const todos = [
  { content: LONG, status: "done" },
  { content: ACTIVE_TODO, status: "in_progress", note: ACTIVE_NOTE },
  { content: "Gửi báo cáo tổng hợp cho nhóm tài liệu kèm danh sách liên kết hỏng", status: "pending" },
  { content: "Ngắn", status: "pending" },
  { content: "Bỏ qua bước này vì đã có kết quả từ hôm qua", status: "skipped" },
];
export const TIMED_OUT = { command: "sleep 5", description: "npm test", timeout: 1000 };
export const FOREGROUND = { command: "for page in $(cat pages.txt 2>/dev/null); do node scripts/check-links.mjs --page \"$page\" --verbose; done; echo checked", description: "Kiểm tra lại liên kết của từng trang sau khi cập nhật mục lục" };
export const FAILING = { command: "printf 'error: missing semicolon\\n' >&2; exit 2", description: "Chạy linter" };
export const BACKGROUND = { command: "for i in $(seq 1 100000); do echo \"tick $i đang chạy kiểm tra\"; sleep 1; done", description: "Theo dõi liên kết sau khi cập nhật mục lục", run_in_background: true };
export const gadget = {
  title: "Gadget", status: "active", progress: { done: 1, total: 2 },
  blocks: [
    { id: "st", kind: "steps", title: "Steps", items: [{ id: "s1", label: LONG, status: "done", started_at: 1759140000000, ended_at: 1759140600000 }, { id: "s2", label: `Second ${LONG}`, status: "in_progress", detail: "đang chạy kiểm tra từng trang một, có thể mất vài phút" }, { id: "s3", label: "Gửi báo cáo", status: "pending" }] },
    { id: "pr", kind: "progress", title: "Progress", label: "Kiểm tra liên kết của tất cả trang đã đăng ký trong hệ thống", value: 3, max: 10 },
    { id: "kv", kind: "key_value", title: "Facts", entries: [{ key: "Nhánh làm việc hiện tại của dự án", value: "feature/very-long-branch-name-for-testing-overflow" }, { key: "Branch", value: "main" }, { key: "File", value: "x", ref: { path: "src/very/deep/nested/directory/structure/component-file-name.ts", line: 42 } }] },
    { id: "tb", kind: "table", title: "Results", columns: [{ id: "n", label: "Trang" }, { id: "s", label: "Trạng thái" }, { id: "v", label: "Liên kết", align: "end" }], rows: [{ id: "r1", status: "done", cells: { n: "getting-started-with-the-command-line-and-configuration.md", s: "liên kết ổn, xem lại sau 30 ngày", v: "44" } }, { id: "r2", status: "failed", cells: { n: "faq.md", s: "lỗi", v: "0" } }] },
    { id: "md", kind: "markdown", title: "Notes", text: "Một đoạn **ghi chú** dài để xem markdown xuống dòng thế nào trong panel hẹp, kèm `inline code` và [một link](https://example.com).\n\n- mục một\n- mục hai rất dài để xem cách xuống dòng của danh sách trong panel" },
    { id: "tl", kind: "timeline", title: "Log", events: [{ id: "e1", at: Date.now() - 3600000, level: "success", label: LONG }, { id: "e2", at: Date.now() - 60000, level: "error", label: "Lỗi kết nối", detail: "ECONNRESET khi gọi docs.example.com sau 3 lần thử lại" }] },
    { id: "fm", kind: "form", title: "Question", fields: [{ id: "q", kind: "single_select", label: "Chọn cách xử lý liên kết hỏng", options: [{ id: "a", label: "Thử lại" }, { id: "b", label: "Bỏ qua" }] }, { id: "t", kind: "text", label: "Ghi chú", max_bytes: 400 }] },
    { id: "un", kind: "hologram", title: "Future", fallback: "Shown as plain text" },
  ],
};

const MESSAGES = ["todo", "slow", "edit", "write", "delete", "bash", "lint", "bg", "gadget", "ask"] as const;
export const stressScenario = {
  agent: { tools: { use: ["builtin/todo", "builtin/write_file", "builtin/edit_file", "builtin/apply_patch", "builtin/bash", "builtin/process", "builtin/ask_user", "local/gadget"], rules: [{ match: "local/gadget", effect: "allow" }, { match: "builtin/bash", effect: "allow" }, { match: "builtin/process", effect: "allow" }, { match: "builtin/write_file", effect: "allow" }, { match: "builtin/edit_file", effect: "allow" }, { match: "builtin/apply_patch", effect: "allow" }] } },
  responses: [
    call("t1", "todo", { title: "Link check", todos }), done("ok"),
    call("b0", "bash", TIMED_OUT), done("ok"),
    call("e1", "edit_file", { path: DEEP_FILE, old_string: "export const b = 2;", new_string: "export const b = 3;\nexport const c = 4;" }), done("ok"),
    call("w1", "write_file", { path: "README.md", content: "# Link check\n\nKiểm tra liên kết của các trang tài liệu.\n\nnpm test\n" }), done("ok"),
    call("p1", "apply_patch", { patch: "*** Begin Patch\n*** Delete File: config/old-config.json\n*** End Patch" }), done("ok"),
    call("b1", "bash", FOREGROUND), done("ok"),
    call("b2", "bash", FAILING), done("ok"),
    call("b3", "bash", BACKGROUND), done("ok"),
    call("g1", "gadget", {}), done("ok"),
    call("a1", "ask_user", { question: "Bạn muốn xử lý 3 liên kết hỏng thế nào? Đây là câu hỏi dài để xem cách xuống dòng.", options: [{ label: "Sửa tất cả" }, { label: "Bỏ qua và báo cáo" }] }), done("ok"),
  ],
};

/** The local `gadget` plugin with every block kind and the files the session edits and deletes; install before the chat is opened. */
export function installStressTools(raw: { env: NodeJS.ProcessEnv; root: string }) {
  mkdirSync(join(raw.root, DEEP_FILE, ".."), { recursive: true });
  writeFileSync(join(raw.root, DEEP_FILE), "export const a = 1;\nexport const b = 2;\n");
  mkdirSync(join(raw.root, "config"), { recursive: true });
  writeFileSync(join(raw.root, "config", "old-config.json"), "{ \"legacy\": true }\n");
  const dir = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "gadget");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ api_version: 2, id: "gadget", version: "1.0.0", name: "gadget", description: "Tool gadget.", input_schema: { type: "object", additionalProperties: false }, entry: "./index.mjs", panels: [{ id: "g", title: "Gadget", icon: "gauge", open: "never" }] }));
  writeFileSync(join(dir, "index.mjs"), `export async function handler(args, context) { await context.panels.update("g", { op: "replace", document: ${JSON.stringify(gadget)} }); return { content: [{ type: "text", text: "ok" }] }; }`);
}

/** Sends every scripted turn, waiting for each answer, then opens the side panel. Stops at the pending question. */
export async function seedStress(page: Page, raw: { server: { launchUrl: string } }) {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  for (const [index, text] of MESSAGES.entries()) {
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (text === "ask") { await page.locator(".inline-tool-view").last().waitFor({ timeout: 20000 }); break; }
    await page.getByTestId("assistant-message").nth(index).waitFor({ timeout: 20000 });
  }
  if (!(await page.locator(".inspector").count())) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Side panel tabs" })).toBeVisible();
}
