import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessions/store.js";
import { GoalService } from "../src/goals/service.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-store-"));
  const options = { env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } };
  const store = openSessionStore(options);
  const session = store.createSession({ cwd: root, title: "Goal" });
  const owner = store.claimSession(session.id);
  const service = new GoalService({ store, sessionId: session.id, owner });
  let n = 0;
  const command = (command: any, actor: "user" | "model" = "user", revision = service.state().revision) => service.command({ clientRequestId: `r${++n}`, expectedRevision: revision, command }, actor);
  return { root, options, store, session, owner, service, command, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("AC-1 lifecycle, authority, required evidence, edits and terminal guards", () => {
  const f = fixture();
  try {
    assert.throws(() => f.command({ action: "start", definition: { objective: "Ship" } }, "model"), /forbidden/);
    let g = f.command({ action: "start", definition: { objective: "Ship", criteria: [{ id: "c", label: "Tests pass" }], tokenBudget: 100 } }).goal!;
    assert.equal(g.status, "active");
    assert.equal(g.definition.maxRequests, 10000);
    assert.throws(() => f.command({ action: "start", definition: { objective: "Another" } }), /goal_exists/);
    assert.throws(() => f.command({ action: "complete" }, "model"), /criteria_incomplete/);
    assert.throws(() => f.command({ action: "setBudget", tokenBudget: 200 }, "model"), /forbidden/);
    assert.throws(() => f.command({ action: "update", criteria: [{ id: "c", required: false }] }, "model"), /invalid_goal/);
    f.command({ action: "update", criteria: [{ id: "c", status: "skipped", evidence: "not run" }] }, "model");
    assert.throws(() => f.command({ action: "complete" }, "model"), /criteria_incomplete/);
    assert.throws(() => f.command({ action: "edit", definition: { objective: "Changed" } }), /goal_active/);
    f.command({ action: "pause" });
    g = f.command({ action: "edit", definition: { objective: "Changed" } }).goal!;
    assert.equal(g.status, "paused");
    assert.equal(g.definition.tokenBudget, 100);
    assert.equal(g.definition.criteria[0]!.status, "pending");
    assert.equal(g.definition.criteria[0]!.evidence, undefined);
    f.command({ action: "resume" });
    const id = f.service.get()!.definition.criteria[0]!.id;
    f.command({ action: "update", criteria: [{ id, status: "done", evidence: "node --test: passed" }] }, "model");
    assert.equal(f.command({ action: "complete" }, "model").goal!.status, "complete");
    assert.throws(() => f.command({ action: "resume" }), /goal_terminal/);
    f.command({ action: "clear" });
    assert.equal(f.service.get(), undefined);
    assert.notEqual(f.command({ action: "start", definition: { objective: "Next" } }).goal!.id, g.id);
  }
  finally {
    f.cleanup();
  }
});
test("AC-1 CAS, durable replay, foreign owner and transaction rollback", () => {
  const f = fixture();
  try {
    const request = { clientRequestId: "same", expectedRevision: 0, command: { action: "start" as const, definition: { objective: "Ship" } } };
    const receipt = f.service.command(request);
    assert.deepEqual(f.service.command(request), receipt);
    assert.throws(() => f.service.command({ ...request, command: { action: "start", definition: { objective: "Different" } } }), /conflict/);
    assert.throws(() => f.command({ action: "pause" }, "user", 0), /stale_revision/);
    const foreign = new GoalService({ store: f.store, sessionId: f.session.id });
    assert.throws(() => foreign.command({ clientRequestId: "foreign", expectedRevision: receipt.revision, command: { action: "pause" } }), /busy/);
    const before = f.service.state();
    const count = f.store.database.prepare("SELECT count(*) n FROM history").get()!.n;
    f.store.database.exec("CREATE TRIGGER fail_goal_history BEFORE INSERT ON history WHEN NEW.kind='goal_update' BEGIN SELECT RAISE(ABORT,'forced failure'); END");
    assert.throws(() => f.command({ action: "pause" }), /forced failure/);
    assert.deepEqual(f.service.state(), before);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM history").get()!.n, count);
    f.store.database.exec("DROP TRIGGER fail_goal_history");
    f.store.releaseSession(f.session.id, f.owner);
    const other = openSessionStore(f.options);
    try {
      const service = new GoalService({ store: other, sessionId: f.session.id });
      assert.deepEqual(service.command(request), receipt);
      assert.equal(other.database.prepare("PRAGMA user_version").get()!.user_version, 6);
    }
    finally {
      other.close();
    }
    f.store.database.prepare("DELETE FROM sessions WHERE id=?").run(f.session.id);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM session_goals").get()!.n, 0);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM session_goal_commands").get()!.n, 0);
  }
  finally {
    f.cleanup();
  }
});
test("AC-1 rejects invalid definitions and named capacity violations without writes", () => {
  const f = fixture();
  try {
    for (const definition of [{ objective: " " }, { objective: "x", criteria: [] }, { objective: "x", maxRequests: 0 }, { objective: "x", tokenBudget: -1 }, { objective: "x".repeat(70000) }, { objective: "x", criteria: Array.from({ length: 51 }, () => ({ label: "c" })) }, { objective: "x", criteria: [{ id: "same", label: "c" }], steps: [{ id: "same", label: "s" }] }]) {
      assert.throws(() => f.command({ action: "start", definition }), /invalid_goal|goal_limit/);
      assert.equal(f.service.get(), undefined);
    }
  }
  finally {
    f.cleanup();
  }
});
test("AC-1 additive initialization of a pre-goal format-6 database preserves history", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-old-db-"));
  const options = { env: { XDG_STATE_HOME: root } };
  let store = openSessionStore(options);
  try {
    const session = store.createSession({ cwd: root, title: "Legacy" });
    store.appendHistory({ sessionId: session.id, kind: "user", payload: { text: "legacy input" } });
    store.database.exec("DROP TABLE session_goal_commands; DROP TABLE session_goals");
    store.close();
    store = openSessionStore(options);
    assert.equal(store.getGoalState(session.id).goal, null);
    assert.equal(store.getSessionHistory({ sessionId: session.id }).items[0]!.payload.text, "legacy input");
    assert.equal(store.database.prepare("PRAGMA user_version").get()!.user_version, 6);
  }
  finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("AC-1 ownership fencing and bounded updates preserve state and usage", () => {
  const f = fixture();
  try {
    f.command({ action: "start", definition: { objective: "Ship", criteria: [{ id: "c", label: "Test" }] } });
    f.store.updateGoal(f.session.id, f.owner, g => { g.usage.requests = 2; g.usage.inputTokens = 10; g.usage.outputTokens = 4; g.usage.inputCoverage = 2; g.usage.outputCoverage = 2; });
    const before = f.service.state();
    assert.throws(() => f.command({ action: "update", criteria: [{ id: "c", evidence: "x".repeat(301) }] }, "model"), /goal_limit/);
    assert.deepEqual(f.service.state(), before);
    const stale = new GoalService({ store: f.store, sessionId: f.session.id, owner: { token: "wrong", generation: f.owner.generation } });
    assert.throws(() => stale.command({ clientRequestId: "stale-owner", expectedRevision: before.revision, command: { action: "pause" } }), /ownership lost/);
    f.command({ action: "pause" });
    f.command({ action: "edit", definition: { objective: "Changed" } });
    assert.deepEqual(f.service.get()!.usage, before.goal!.usage);
    f.command({ action: "setBudget", maxRequests: 2 });
    assert.throws(() => f.command({ action: "resume" }), /request_budget_exhausted/);
    f.command({ action: "setBudget", maxRequests: 3 });
    assert.equal(f.command({ action: "resume" }).goal!.status, "active");
    f.command({ action: "block", reason: "missing input", nextAction: "provide credential" }, "model");
    assert.equal(f.service.get()!.status, "blocked");
    f.command({ action: "resume" });
    assert.equal(f.command({ action: "abandon" }).goal!.status, "abandoned");
  }
  finally {
    f.cleanup();
  }
});
