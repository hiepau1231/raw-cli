import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftStore } from "../web/src/composer/draft-store.js";

test("the draft round-trips through the drafts map, so it survives switching chats", () => {
  const drafts = new Map([["a", "kept"]]);
  const store = createDraftStore("a", drafts);
  assert.equal(store.get(), "kept");
  store.set("hello");
  assert.equal(drafts.get("a"), "hello");
  assert.equal(createDraftStore("a", drafts).get(), "hello", "a new store for the same chat reads the saved draft");
  drafts.set("a", "changed elsewhere");
  assert.equal(store.get(), "changed elsewhere", "the map is the source of truth");
});

test("subscribers hear a change once and not a write of the same text", () => {
  const store = createDraftStore("a", new Map());
  const heard: string[] = [];
  const stop = store.subscribe(() => heard.push(store.get()));
  store.set("h");
  store.set("h");
  store.set("hi");
  stop();
  store.set("hi!");
  assert.deepEqual(heard, ["h", "hi"]);
});

test("an empty draft removes the chat's entry", () => {
  const drafts = new Map<string, string>();
  const store = createDraftStore("a", drafts);
  store.set("text");
  store.set("");
  assert.equal(drafts.has("a"), false);
  assert.equal(store.get(), "");
});

test("two chats' stores are independent", () => {
  const drafts = new Map<string, string>();
  const a = createDraftStore("a", drafts);
  const b = createDraftStore("b", drafts);
  let heardB = 0;
  b.subscribe(() => heardB++);
  a.set("for a");
  b.set("for b");
  assert.equal(a.get(), "for a");
  assert.equal(b.get(), "for b");
  assert.equal(heardB, 1);
  assert.deepEqual([...drafts], [["a", "for a"], ["b", "for b"]]);
});
