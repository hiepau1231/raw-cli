import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectPackage } from "../src/packages/inspect.js";

const ROOT = "examples/packages/goal-kit";

interface StateApi {
  STATE_VERSION: number;
  MAX_STATE_BYTES: number;
  stateDir(env?: NodeJS.ProcessEnv): string;
  statePath(cwd: string, env?: NodeJS.ProcessEnv): string;
  stateLockPath(cwd: string, env?: NodeJS.ProcessEnv): string;
  readState(cwd: string, env?: NodeJS.ProcessEnv): Promise<unknown>;
  updateState(cwd: string, mutate: (state: Record<string, unknown>) => Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<unknown>;
  deleteState(cwd: string, env?: NodeJS.ProcessEnv): Promise<void>;
}

async function stateApi(): Promise<StateApi> {
  // @ts-expect-error - the shipped package helper is plain .mjs without a declaration file
  return await import("../examples/packages/goal-kit/tools/goal/state.mjs") as unknown as StateApi;
}

function stateFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    goalId: "00000000-0000-4000-8000-000000000001",
    status: "active",
    objective: "Ship the fix",
    doneWhen: "The tests pass",
    criteria: [{ id: "c1", label: "Tests pass", required: true, status: "pending" }],
    steps: [],
    budget: { maxContinuations: 20 },
    baselinePending: true,
    continuations: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tempStateEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-state-"));
  return { root, env: { ...process.env, RAW_GOAL_STATE_DIR: join(root, "state") } };
}

test("goal kit manifest exports the agent, tool, hook and skill", async () => {
  const report = await inspectPackage(ROOT);
  assert.equal(report.name, "@raw/goal-kit");
  assert.equal(report.version, "1.0.0");
  assert.deepEqual(report.exports.agents, ["coder"]);
  assert.deepEqual(report.exports.tools, ["goal"]);
  assert.deepEqual(report.exports.hooks, ["goal"]);
  assert.deepEqual(report.exports.skills, ["goal"]);
  assert.deepEqual(report.requires, [
    "raw.agent/1",
    "raw.hook/2",
    "raw.panel/2",
    "raw.skill/1",
    "raw.stop-continue/1",
    "raw.tool-api/2",
  ]);
  assert.deepEqual(report.prerequisites, ["node"]);
});

test("goal state is workspace-scoped and round-trips atomically", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    assert.equal(api.STATE_VERSION, 1);
    assert.equal(api.MAX_STATE_BYTES, 65536);
    const one = join(root, "one");
    const two = join(root, "two");
    assert.equal(dirname(api.statePath(one, env)), api.stateDir(env));
    assert.match(api.statePath(one, env), /goal-[a-f0-9]{64}\.json$/);
    assert.notEqual(api.statePath(one, env), api.statePath(two, env));
    await api.updateState(one, () => stateFixture(), env);
    const read = await api.readState(one, env) as Record<string, unknown>;
    assert.equal(read.objective, "Ship the fix");
    assert.deepEqual(read.criteria, stateFixture().criteria);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state serializes concurrent writers", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    await Promise.all(Array.from({ length: 10 }, () => api.updateState(root, (state) => ({
      ...state, continuations: Number(state.continuations) + 1,
    }), env)));
    const read = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(read.continuations, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state recovers a stale lock and refuses a fresh one", { timeout: 8000 }, async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    const lock = api.stateLockPath(root, env);
    await api.updateState(root, () => stateFixture(), env);
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await api.updateState(root, (state) => ({ ...state, objective: "recovered" }), env);
    const read = await api.readState(root, env) as Record<string, unknown>;
    assert.equal(read.objective, "recovered");
    writeFileSync(lock, "");
    await assert.rejects(api.updateState(root, (state) => ({ ...state, objective: "blocked" }), env),
      (error: unknown) => (error as { code?: string }).code === "state_busy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal state rejects corrupt and oversized files", async () => {
  const api = await stateApi();
  const { env, root } = tempStateEnv();
  try {
    await api.updateState(root, () => stateFixture(), env);
    const path = api.statePath(root, env);
    writeFileSync(path, "{not json");
    await assert.rejects(api.readState(root, env), (error: unknown) => (error as { code?: string }).code === "state_corrupt");
    writeFileSync(path, "x".repeat(api.MAX_STATE_BYTES + 1));
    await assert.rejects(api.readState(root, env), (error: unknown) => (error as { code?: string }).code === "state_too_large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal tool and hook carry byte-identical state modules", () => {
  const tool = readFileSync(join(ROOT, "tools/goal/state.mjs"), "utf8");
  const hook = readFileSync(join(ROOT, "hooks/goal/state.mjs"), "utf8");
  assert.equal(hook, tool);
});
