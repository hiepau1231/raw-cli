import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFilterOf, commandFilterStore, commandMatches, commandStatus, commandsStorageKey, loadCommandFilters, MAX_COMMAND_SESSIONS, saveCommandFilters, setCommandFilter } from "../web/src/panels/commands-state.js";
import type { CommandRecord } from "../src/processes/presentation.js";

test("the command filter defaults to All, is kept per session and round-trips through storage", () => {
  let saved = "";
  let prefs = loadCommandFilters({ getItem: () => null });
  assert.equal(commandFilterOf(prefs, "a"), "all");
  prefs = setCommandFilter(prefs, "a", "failed", 1);
  prefs = setCommandFilter(prefs, "a", "running", 2);
  saveCommandFilters(prefs, { setItem: (key, value) => { assert.equal(key, commandsStorageKey); saved = value; } });
  const loaded = loadCommandFilters({ getItem: () => saved });
  assert.equal(commandFilterOf(loaded, "a"), "running");
  assert.equal(commandFilterOf(loaded, "b"), "all", "another session keeps the default");
});

test("corrupt, foreign or old group storage falls back to All and the oldest sessions are dropped first", () => {
  const old = JSON.stringify({ version: 1, sessions: { a: { running: false, completed: true, at: 3 } } });
  for (const value of ["{", "[]", old, JSON.stringify({ version: 2, sessions: { a: { filter: "failed" } } }), JSON.stringify({ version: 1, sessions: { a: "failed", b: { filter: "broken", at: 1 } } })]) {
    const prefs = loadCommandFilters({ getItem: () => value });
    assert.equal(commandFilterOf(prefs, "a"), "all", value);
    assert.equal(commandFilterOf(prefs, "b"), "all", value);
  }
  let prefs = loadCommandFilters({ getItem: () => null });
  for (let i = 0; i <= MAX_COMMAND_SESSIONS; i++) prefs = setCommandFilter(prefs, `s${i}`, "failed", i);
  assert.equal(Object.keys(prefs.sessions).length, MAX_COMMAND_SESSIONS);
  assert.equal(commandFilterOf(prefs, "s0"), "all", "the least recently changed session is dropped");
  assert.equal(commandFilterOf(prefs, `s${MAX_COMMAND_SESSIONS}`), "failed");
});

test("Running holds live commands and Failed holds failures, timeouts and lost jobs, never stopped or succeeded ones", () => {
  const row = (state: CommandRecord["state"], exitCode?: number | null): CommandRecord => ({
    id: state, sessionId: "s", kind: "background", owner: "builtin/process", command: "x", cwd: "/", state, createdAt: 0, updatedAt: 0, cursor: 0, droppedBytes: 0, ...(exitCode === undefined ? {} : { exitCode }),
  });
  const cases: Array<[CommandRecord, boolean, boolean]> = [
    [row("starting"), true, false], [row("running"), true, false], [row("stopping"), true, false],
    [row("exited", 0), false, false], [row("exited", 3), false, true], [row("failed", null), false, true],
    [row("timed_out"), false, true], [row("lost"), false, true], [row("stopped"), false, false],
  ];
  for (const [item, running, failed] of cases) {
    assert.equal(commandMatches(item, "all"), true, item.state);
    assert.equal(commandMatches(item, "running"), running, item.state);
    assert.equal(commandMatches(item, "failed"), failed, `${item.state} ${item.exitCode}`);
  }
});

test("only running and failed commands show the whole card; timed out, lost, stopped and succeeded ones are compact with their own word", () => {
  const row = (state: CommandRecord["state"], extra: Partial<CommandRecord> = {}): CommandRecord => ({
    id: state, sessionId: "s", kind: "background", owner: "builtin/process", command: "x", cwd: "/", state, createdAt: 0, updatedAt: 0, cursor: 0, droppedBytes: 0, ...extra,
  });
  const view = (item: CommandRecord) => { const { tone, chip, compact } = commandStatus(item); return [tone, chip, compact]; };
  assert.deepEqual(view(row("running")), ["running", "Running", false]);
  assert.deepEqual(view(row("stopping")), ["running", "Stopping", false]);
  assert.deepEqual(view(row("exited", { exitCode: 2 })), ["failed", "Exit 2", false]);
  assert.deepEqual(view(row("failed", { signal: "SIGKILL" })), ["failed", "SIGKILL", false]);
  assert.deepEqual(view(row("failed")), ["failed", "Failed", false]);
  assert.deepEqual(view(row("timed_out")), ["warning", "Timed out", true]);
  assert.deepEqual(view(row("lost")), ["warning", "Lost", true]);
  assert.deepEqual(view(row("stopped")), ["muted", "Stopped", true]);
  assert.deepEqual(view(row("exited", { exitCode: 0 })), ["success", "Done", true]);
  assert.equal(commandStatus(row("exited", { exitCode: 0 })).label, "Succeeded");
});

test("a commands event replaces the rows and the count of older rows that were cut", async () => {
  const { reduceEvent } = await import("../web/src/session.js");
  const state = { commands: [], commandsOmitted: 5 } as never;
  const event = (omitted?: number) => ({ type: "commands", data: { items: [], ...(omitted ? { omitted } : {}) } }) as never;
  assert.equal((reduceEvent(state, event(68)) as { commandsOmitted?: number }).commandsOmitted, 68);
  assert.equal((reduceEvent(state, event()) as { commandsOmitted?: number }).commandsOmitted, 0);
});

test("the filter lasts for the page when storage fails, and a change keeps other tabs' sessions", () => {
  const broken = commandFilterStore(() => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } }));
  broken.set("a", "failed");
  // A remounted tab reads the same page memory.
  assert.equal(commandFilterOf(broken.get(), "a"), "failed");
  let saved = JSON.stringify({ version: 1, sessions: { other: { filter: "running", at: 5 } } });
  const shared = commandFilterStore(() => ({ getItem: () => saved, setItem: (_key, value) => { saved = value; } }));
  shared.set("a", "failed", 10);
  saved = JSON.stringify({ version: 1, sessions: { ...JSON.parse(saved).sessions, late: { filter: "failed", at: 11 } } });
  shared.set("a", "running", 12);
  const after = loadCommandFilters({ getItem: () => saved });
  assert.deepEqual([commandFilterOf(after, "other"), commandFilterOf(after, "late"), commandFilterOf(after, "a")], ["running", "failed", "running"]);
});
