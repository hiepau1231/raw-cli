import assert from "node:assert/strict";
import { test } from "node:test";
import { addQueuedInput, reduceEvent } from "../web/src/session.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { DashboardEvent } from "../src/dashboard/streams.js";
import type { QueuedInputView } from "../src/sessions/view.js";

const queued = (id: string): QueuedInputView => ({ id, clientRequestId: `request-${id}`, text: id, state: "queued", mode: "queue", agent: "raw", createdAt: 1 });

test("a late reply to POST /inputs never brings back a waiting message the session has since taken", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    const envelope = { id: "frame", instanceId: "host", sessionId: session.id, sequence: 1, operationId: "op" };
    const inputs = (items: QueuedInputView[]) => ({ ...envelope, type: "inputs", data: { items } }) as DashboardEvent;
    const start = reduceEvent(undefined, { ...envelope, type: "snapshot", data: snapshot })!;
    // Queued and delivered in one batch of events, reduced before any render: the reply that follows adds nothing.
    let state = [inputs([queued("a")]), inputs([])].reduce(reduceEvent, start)!;
    state = addQueuedInput(state, queued("a"))!;
    assert.deepEqual(state.inputs, []);
    // The reply first: its card shows at once, and the session's own list replaces it from then on.
    state = addQueuedInput(state, queued("b"))!;
    assert.deepEqual(state.inputs.map((item) => item.id), ["b"]);
    state = reduceEvent(state, inputs([{ ...queued("b"), state: "paused" }]))!;
    assert.deepEqual(state.inputs.map((item) => [item.id, item.state]), [["b", "paused"]]);
    state = reduceEvent(state, inputs([]))!;
    assert.equal(addQueuedInput(state, queued("b")), state);
    // A reconnect snapshot keeps what this page already knows.
    state = reduceEvent(state, { ...envelope, type: "reset", data: { ...snapshot, inputs: [queued("c")] } } as DashboardEvent)!;
    assert.deepEqual([...state.knownInputs].sort(), ["a", "b", "c"]);
  } finally { await f.close(); }
});
