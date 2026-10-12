/**
 * The long chat of docs/chat-design.md §10: one real turn of the chat stress session (§9), recorded once through the mock
 * provider, copied into a new session as many distinct turns; and a long answer streamed in small frames.
 */
import type { Page } from "@playwright/test";
import { openAiDone, openAiFrame, type MockResponse } from "../fixtures/mock-provider.js";
import { ANSWER, chatScenario, REQUEST, seedChat } from "./chat-stress.js";

interface Store {
  getSessionHistory(options: { sessionId: string; limit?: number; before?: string }): { items: Array<{ kind: string; payload: Record<string, unknown>; status: string }>; nextCursor?: string };
  createSession(options: { cwd: string; title?: string; agentName?: string }): { id: string };
  appendHistory(options: { sessionId: string; kind: string; payload: Record<string, unknown>; status?: string }): unknown;
}
type Raw = { root: string; server: { launchUrl: string; context: { store?: unknown } } };

/** Keys whose string values identify a record, a turn, an operation or a call; every copy gets its own. */
const ID_KEYS = new Set(["id", "segmentId", "turnId", "operationId", "toolCallId", "callId", "requestId", "instanceId", "viewInstanceId"]);
function collectIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) for (const item of value) collectIds(item, into);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (ID_KEYS.has(key) && typeof item === "string" && item) into.add(item);
      else collectIds(item, into);
    }
}

/** A long Markdown answer streamed in `frames` frames, `delayMs` apart. */
export function longStream(text: string, frames: number, delayMs: number): MockResponse {
  const size = Math.ceil(text.length / frames);
  const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
  return { frames: [...chunks.map((chunk) => openAiFrame({ content: chunk })), openAiFrame({}, "stop"), openAiDone], frameDelayMs: delayMs };
}

/** The live answer: the stress answer repeated, about 10 characters a frame over 2400 frames, so typing at 300 turns still overlaps it. */
export const LIVE_ANSWER = Array.from({ length: 24 }, (_, index) => `### Lần kiểm tra ${index + 1}\n\n${ANSWER}`).join("\n\n");
export const LIVE_REQUEST = "Tổng hợp lại toàn bộ các lần kiểm tra liên kết";

/** The scenario: the first stress turn (5 responses), then the live answer. */
export const longScenario = { ...chatScenario, responses: [...chatScenario.responses.slice(0, 5), longStream(LIVE_ANSWER, 2400, 10)] };

const HEADING = "Kết quả rà soát liên kết";
/** The tag that ends turn `n`'s request and answer heading (1-based). */
export const turnTag = (n: number) => `[lượt ${n}]`;

/**
 * Records the first stress turn in a chat of its own, then copies its history `turns` times into a new session.
 * Returns the new session's id and the number of records written.
 */
export async function seedLongChat(page: Page, raw: Raw, turns: number): Promise<{ sessionId: string; records: number }> {
  await seedChat(page, raw, "answer");
  const source = /\/chat\/([^/?#]+)/.exec(page.url())?.[1];
  if (!source) throw new Error(`no chat id in ${page.url()}`);
  const store = raw.server.context.store as Store;
  const rows: Array<{ kind: string; payload: Record<string, unknown>; status: string }> = [];
  let before: string | undefined;
  do {
    const page_ = store.getSessionHistory({ sessionId: decodeURIComponent(source), limit: 100, ...(before ? { before } : {}) });
    rows.unshift(...page_.items);
    before = page_.nextCursor;
  } while (before);
  const ids = new Set<string>();
  for (const row of rows) collectIds(row.payload, ids);
  // Longest first, so an id that contains another is replaced whole.
  const pattern = new RegExp(`"(${[...ids].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})"`, "g");
  const session = store.createSession({ cwd: raw.root, title: "Long chat", agentName: "raw" });
  for (let copy = 0; copy < turns; copy++)
    for (const row of rows) {
      // The request and the answer's heading end with the turn's number, so each turn has text of its own.
      const json = JSON.stringify(row.payload).replace(pattern, (_, id: string) => JSON.stringify(`${id}~${copy}`))
        .replaceAll(REQUEST, `${REQUEST} ${turnTag(copy + 1)}`).replaceAll(HEADING, `${HEADING} ${turnTag(copy + 1)}`);
      const payload = JSON.parse(json) as Record<string, unknown>;
      store.appendHistory({ sessionId: session.id, kind: row.kind, payload, status: row.status });
    }
  return { sessionId: session.id, records: rows.length * turns };
}
