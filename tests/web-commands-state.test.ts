import assert from "node:assert/strict";
import { test } from "node:test";
import { commandGroupStore, commandsStorageKey, groupOpen, loadCommandGroups, MAX_COMMAND_SESSIONS, saveCommandGroups, setGroupOpen } from "../web/src/panels/commands-state.js";

test("command groups default to Running open and Completed collapsed, per session, and round-trip through storage", () => {
  let saved = "";
  let prefs = loadCommandGroups({ getItem: () => null });
  assert.deepEqual([groupOpen(prefs, "a", "running"), groupOpen(prefs, "a", "completed")], [true, false]);
  prefs = setGroupOpen(prefs, "a", "completed", true, 1);
  prefs = setGroupOpen(prefs, "a", "running", false, 2);
  saveCommandGroups(prefs, { setItem: (key, value) => { assert.equal(key, commandsStorageKey); saved = value; } });
  const loaded = loadCommandGroups({ getItem: () => saved });
  assert.deepEqual([groupOpen(loaded, "a", "running"), groupOpen(loaded, "a", "completed")], [false, true]);
  assert.deepEqual([groupOpen(loaded, "b", "running"), groupOpen(loaded, "b", "completed")], [true, false], "another session keeps the defaults");
});

test("corrupt command group storage falls back to defaults and the oldest sessions are dropped first", () => {
  for (const value of ["{", "[]", JSON.stringify({ version: 2, sessions: { a: { completed: true } } }), JSON.stringify({ version: 1, sessions: { a: "open", b: { completed: "yes", at: 1 } } })]) {
    const prefs = loadCommandGroups({ getItem: () => value });
    assert.equal(groupOpen(prefs, "a", "completed"), false, value);
    assert.equal(groupOpen(prefs, "b", "completed"), false, value);
  }
  let prefs = loadCommandGroups({ getItem: () => null });
  for (let i = 0; i <= MAX_COMMAND_SESSIONS; i++) prefs = setGroupOpen(prefs, `s${i}`, "completed", true, i);
  assert.equal(Object.keys(prefs.sessions).length, MAX_COMMAND_SESSIONS);
  assert.equal(groupOpen(prefs, "s0", "completed"), false, "the least recently changed session is dropped");
  assert.equal(groupOpen(prefs, `s${MAX_COMMAND_SESSIONS}`, "completed"), true);
});

test("a commands event replaces the rows and the count of older rows that were cut", async () => {
  const { reduceEvent } = await import("../web/src/session.js");
  const state = { commands: [], commandsOmitted: 5 } as never;
  const event = (omitted?: number) => ({ type: "commands", data: { items: [], ...(omitted ? { omitted } : {}) } }) as never;
  assert.equal((reduceEvent(state, event(68)) as { commandsOmitted?: number }).commandsOmitted, 68);
  assert.equal((reduceEvent(state, event()) as { commandsOmitted?: number }).commandsOmitted, 0);
});

test("group choices last for the page when storage fails, and a change keeps other tabs' sessions", () => {
  const broken = commandGroupStore(() => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } }));
  broken.set("a", "completed", true);
  broken.set("a", "running", false);
  // A remounted section reads the same page memory.
  assert.deepEqual([groupOpen(broken.get(), "a", "running"), groupOpen(broken.get(), "a", "completed")], [false, true]);
  let saved = JSON.stringify({ version: 1, sessions: { other: { completed: true, at: 5 } } });
  const shared = commandGroupStore(() => ({ getItem: () => saved, setItem: (_key, value) => { saved = value; } }));
  shared.set("a", "completed", true, 10);
  saved = JSON.stringify({ version: 1, sessions: { ...JSON.parse(saved).sessions, late: { completed: true, at: 11 } } });
  shared.set("a", "running", false, 12);
  const after = loadCommandGroups({ getItem: () => saved });
  assert.deepEqual([groupOpen(after, "other", "completed"), groupOpen(after, "late", "completed"), groupOpen(after, "a", "completed"), groupOpen(after, "a", "running")], [true, true, true, false]);
});
