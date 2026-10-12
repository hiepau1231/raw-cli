import assert from "node:assert/strict";
import { test } from "node:test";
import { assignStableKeys, splitTurns, type KeyUnit } from "../web/src/timeline-keys.js";

const turn = (...ids: string[]): KeyUnit => ({ ids, prefix: "" });
const group = (...ids: string[]): KeyUnit => ({ ids, prefix: "work:" });

test("without a previous render, a turn is keyed by its first record and a group by work:<first record>", () => {
  const { keys } = assignStableKeys([turn("u1", "a1"), group("r1", "c1"), turn("u2")], new Map());
  assert.deepEqual(keys, ["u1", "work:r1", "u2"]);
});

test("a unit keeps its key when an earlier page adds records to its start", () => {
  const first = assignStableKeys([turn("c3", "a1"), turn("u2", "a2")], new Map());
  assert.deepEqual(first.keys, ["c3", "u2"]);
  const second = assignStableKeys([turn("u0", "c1", "c2", "c3", "a1"), turn("u2", "a2")], first.next);
  assert.deepEqual(second.keys, ["c3", "u2"]);
  const groups = assignStableKeys([group("c2", "c3")], new Map());
  assert.deepEqual(assignStableKeys([group("r0", "c1", "c2", "c3")], groups.next).keys, ["work:c2"]);
});

test("a unit keeps its key when it grows at the end", () => {
  const first = assignStableKeys([turn("u1"), group("live:op:c1")], new Map());
  const second = assignStableKeys([turn("u1", "a1", "a2"), group("live:op:c1", "live:op:c2")], first.next);
  assert.deepEqual(second.keys, first.keys);
});

test("a unit takes the key of the earliest record the previous render knew", () => {
  const first = assignStableKeys([group("live:op:c1", "call:op:c1")], new Map());
  // The live call became a history record with another id; the call alias still names the group.
  const second = assignStableKeys([group("r1", "h1", "call:op:c1", "h2")], first.next);
  assert.deepEqual(second.keys, ["work:live:op:c1"]);
});

test("a split by a new user record keeps the earlier part's key and gives the later part a new one", () => {
  const first = assignStableKeys([turn("u1", "a1", "c1")], new Map());
  const second = assignStableKeys([turn("u1", "a1", "c1"), turn("u2", "c2")], first.next);
  assert.deepEqual(second.keys, ["u1", "u2"]);
  // Even when records the previous render knew move into the later part, the key stays with the earlier one.
  const moved = assignStableKeys([turn("u1", "a1"), turn("u2", "c1")], first.next);
  assert.deepEqual(moved.keys, ["u1", "u2"]);
});

test("two units never share a key", () => {
  const previous = new Map([["x", "k"], ["y", "k"], ["z", "u3"]]);
  const units = [turn("x"), turn("y"), turn("u3"), turn("z"), turn("u3")];
  const { keys } = assignStableKeys(units, previous);
  assert.equal(new Set(keys).size, keys.length, keys.join(","));
  assert.equal(keys[0], "k");
});

test("the next map names every record of every unit", () => {
  const { keys, next } = assignStableKeys([turn("u1", "a1"), group("r1", "c1")], new Map());
  assert.deepEqual([...next], [["u1", keys[0]], ["a1", keys[0]], ["r1", keys[1]], ["c1", keys[1]]]);
});

type Row = { id: string; kind: string; operationId?: string };
const r = (id: string, kind: string, operationId?: string): Row => ({ id, kind, ...(operationId ? { operationId } : {}) });
const ids = (turns: Row[][]) => turns.map((turn) => turn.map((row) => row.id));
/** Renders the records twice, as the Timeline does, and returns the key of the turn holding `id` each time. */
function turnKeyOf(first: Row[], second: Row[], id: string) {
  const units = (rows: Row[]) => splitTurns(rows).map((turn) => ({ ids: turn.map((row) => row.id), prefix: "" }));
  const before = assignStableKeys(units(first), new Map());
  const after = assignStableKeys(units(second), before.next);
  return [before.next.get(id), after.next.get(id)];
}

test("turns start at your messages; records without an operation stay in the turn", () => {
  const rows = [r("before", "assistant"), r("u1", "user"), r("a1", "assistant"), r("note", "compaction"), r("u2", "user"), r("a2", "assistant")];
  assert.deepEqual(ids(splitTurns(rows)), [["before"], ["u1", "a1", "note"], ["u2", "a2"]]);
});

test("your message that reaches the history after its answer started keeps the answer's turn", () => {
  const old = [r("u1", "user", "op1"), r("a1", "assistant", "op1")];
  const streaming = [...old, r("live", "assistant", "op2")];
  const committed = [...old, r("u2", "user", "op2"), r("live", "assistant", "op2")];
  assert.deepEqual(ids(splitTurns(streaming)), [["u1", "a1"], ["live"]]);
  assert.deepEqual(ids(splitTurns(committed)), [["u1", "a1"], ["u2", "live"]]);
  const [before, after] = turnKeyOf(streaming, committed, "live");
  assert.equal(after, before);
});

test("a hook receipt recorded before your message does not pull the live answer into the previous turn", () => {
  const old = [r("u1", "user", "op1"), r("a1", "assistant", "op1")];
  const streaming = [...old, r("hook", "hook", "op2"), r("live", "assistant", "op2")];
  const committed = [...old, r("hook", "hook", "op2"), r("u2", "user", "op2"), r("live", "assistant", "op2")];
  assert.deepEqual(ids(splitTurns(streaming)), [["u1", "a1"], ["hook", "live"]]);
  assert.deepEqual(ids(splitTurns(committed)), [["u1", "a1"], ["hook", "u2", "live"]]);
  const [before, after] = turnKeyOf(streaming, committed, "live");
  assert.equal(after, before);
  assert.notEqual(after, turnKeyOf(streaming, committed, "a1")[1]);
});

test("a message delivered inside a running operation splits its turn", () => {
  const rows = [r("u1", "user", "op1"), r("c1", "tool_call", "op1"), r("u2", "user", "op1"), r("c2", "tool_call", "op1"), r("a", "assistant", "op1")];
  assert.deepEqual(ids(splitTurns(rows)), [["u1", "c1"], ["u2", "c2", "a"]]);
});

test("a message of another operation opens its own turn, also after a turn cut by the history page", () => {
  const rows = [r("c0", "tool_call", "op0"), r("a0", "assistant", "op0"), r("u1", "user", "op1"), r("a1", "assistant", "op1")];
  assert.deepEqual(ids(splitTurns(rows)), [["c0", "a0"], ["u1", "a1"]]);
});

test("after terminal history, which has no operation, a dashboard answer keeps its turn when your message arrives", () => {
  const old = [r("u1", "user"), r("a1", "assistant")];
  const streaming = [...old, r("live", "assistant", "op2")];
  const committed = [...old, r("u2", "user", "op2"), r("live", "assistant", "op2")];
  assert.deepEqual(ids(splitTurns(streaming)), [["u1", "a1"], ["live"]]);
  const [before, after] = turnKeyOf(streaming, committed, "live");
  assert.equal(after, before);
});
