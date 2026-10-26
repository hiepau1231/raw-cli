/**
 * Workspace-scoped goal state for the goal kit package.
 *
 * This file is deliberately self-contained: a package tool and a package hook are snapshotted by
 * folder, so the copy in hooks/goal/ must stay byte-identical to this one. It uses no Raw source
 * modules and no third-party packages.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

export const STATE_VERSION = 1;
export const MAX_STATE_BYTES = 65536;
export const STATE_DIR_ENV = "RAW_GOAL_STATE_DIR";
export const LOCK_WAIT_MS = 2000;
export const LOCK_STALE_MS = 30000;

const STATUSES = new Set(["active", "paused", "blocked", "complete", "abandoned"]);
const ITEM_STATUSES = new Set(["pending", "in_progress", "done", "blocked", "skipped"]);
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new StateError(code, message); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isInteger = (value) => typeof value === "number" && Number.isSafeInteger(value);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function canonicalCwd(cwd) {
  try { return realpathSync(cwd); }
  catch { return resolve(cwd); }
}

function goalKey(cwd) {
  return createHash("sha256").update(canonicalCwd(cwd)).digest("hex");
}

export function stateDir(env = process.env) {
  const override = env[STATE_DIR_ENV];
  if (typeof override === "string" && override.trim()) return resolve(override);
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "raw-goal");
  }
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "raw-goal");
}

export function statePath(cwd, env = process.env) {
  return join(stateDir(env), `goal-${goalKey(cwd)}.json`);
}

function lockPath(cwd, env = process.env) {
  return join(stateDir(env), `goal-${goalKey(cwd)}.lock`);
}

function text(value, name, max) {
  if (typeof value !== "string" || !value.trim()) fail("state_corrupt", `${name} must be a non-empty string`);
  if ([...value].length > max) fail("state_corrupt", `${name} must be at most ${max} characters`);
  return value;
}

function optionalText(value, name, max) {
  if (value === undefined) return;
  text(value, name, max);
}

function nonNegativeInteger(value, name) {
  if (!isInteger(value) || value < 0) fail("state_corrupt", `${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!isInteger(value) || value < 1 || value > max) fail("state_corrupt", `${name} must be a positive integer`);
  return value;
}

export function validateState(value) {
  if (!isObject(value)) fail("state_corrupt", "goal state must be an object");
  if (value.schemaVersion !== STATE_VERSION) fail("state_corrupt", `goal state schemaVersion must be ${STATE_VERSION}`);
  text(value.goalId, "goalId", 128);
  if (value.ownerSessionId !== undefined) text(value.ownerSessionId, "ownerSessionId", 128);
  if (!STATUSES.has(value.status)) fail("state_corrupt", "unknown goal status");
  text(value.objective, "objective", 2000);
  text(value.doneWhen, "doneWhen", 500);
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 50) {
    fail("state_corrupt", "criteria must contain 1..50 items");
  }
  let required = 0;
  const ids = new Set();
  for (const item of value.criteria) {
    if (!isObject(item)) fail("state_corrupt", "criterion must be an object");
    if (typeof item.id !== "string" || !ITEM_ID.test(item.id) || ids.has(item.id)) fail("state_corrupt", "criterion id is invalid or duplicated");
    ids.add(item.id);
    text(item.label, "criterion label", 200);
    if (typeof item.required !== "boolean") fail("state_corrupt", "criterion required must be boolean");
    if (item.required) required++;
    if (!ITEM_STATUSES.has(item.status)) fail("state_corrupt", "unknown criterion status");
    optionalText(item.evidence, "criterion evidence", 300);
  }
  if (!required) fail("state_corrupt", "at least one required criterion is required");
  if (!Array.isArray(value.steps) || value.steps.length > 30) fail("state_corrupt", "steps must contain at most 30 items");
  let running = 0;
  for (const item of value.steps) {
    if (!isObject(item)) fail("state_corrupt", "step must be an object");
    if (typeof item.id !== "string" || !ITEM_ID.test(item.id) || ids.has(item.id)) fail("state_corrupt", "step id is invalid or duplicated");
    ids.add(item.id);
    text(item.label, "step label", 200);
    if (!ITEM_STATUSES.has(item.status)) fail("state_corrupt", "unknown step status");
    if (item.status === "in_progress") running++;
    optionalText(item.detail, "step detail", 200);
  }
  if (running > 1) fail("state_corrupt", "at most one step may be in_progress");
  if (!isObject(value.budget)) fail("state_corrupt", "budget must be an object");
  if (value.budget.tokenBudget !== undefined) positiveInteger(value.budget.tokenBudget, "budget.tokenBudget");
  if (value.budget.maxRequests !== undefined) positiveInteger(value.budget.maxRequests, "budget.maxRequests");
  positiveInteger(value.budget.maxContinuations, "budget.maxContinuations", 100);
  if (value.usageBaseline !== undefined) {
    if (!isObject(value.usageBaseline)) fail("state_corrupt", "usageBaseline must be an object");
    for (const name of ["requests", "inputTokensKnown", "outputTokensKnown", "inputCoverage", "outputCoverage"]) {
      nonNegativeInteger(value.usageBaseline[name], `usageBaseline.${name}`);
    }
  }
  if (typeof value.baselinePending !== "boolean") fail("state_corrupt", "baselinePending must be boolean");
  nonNegativeInteger(value.continuations, "continuations");
  optionalText(value.reason, "reason", 300);
  optionalText(value.nextAction, "nextAction", 300);
  nonNegativeInteger(value.createdAt, "createdAt");
  nonNegativeInteger(value.updatedAt, "updatedAt");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_STATE_BYTES) {
    fail("state_too_large", `goal state: at most ${MAX_STATE_BYTES} bytes`);
  }
  return value;
}

async function ensureStateDir(env) {
  const dir = stateDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await chmod(dir, 0o700); } catch { /* Windows does not apply POSIX modes. */ }
  return dir;
}

export async function withStateLock(cwd, action, env = process.env) {
  await ensureStateDir(env);
  const path = lockPath(cwd, env);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(path);
          continue;
        }
      } catch { /* The holder may have released the lock between stat and unlink. */ }
      if (Date.now() >= deadline) fail("state_busy", "another goal update is still running");
      await sleep(25);
    }
  }
  try { return await action(); }
  finally { await unlink(path).catch(() => {}); }
}

async function readStateUnlocked(cwd, env) {
  const path = statePath(cwd, env);
  try {
    const info = await stat(path);
    if (info.size > MAX_STATE_BYTES) fail("state_too_large", `goal state: at most ${MAX_STATE_BYTES} bytes`);
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) fail("state_too_large", `goal state: at most ${MAX_STATE_BYTES} bytes`);
    let value;
    try { value = JSON.parse(source); }
    catch { fail("state_corrupt", "goal state is not valid JSON"); }
    return validateState(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof StateError) throw error;
    throw new StateError("state_corrupt", `goal state could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readState(cwd, env = process.env) {
  return readStateUnlocked(cwd, env);
}

async function writeStateUnlocked(cwd, value, env) {
  validateState(value);
  const path = statePath(cwd, env);
  const source = JSON.stringify(value);
  if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) fail("state_too_large", `goal state: at most ${MAX_STATE_BYTES} bytes`);
  await ensureStateDir(env);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    try { await chmod(path, 0o600); } catch { /* Windows does not apply POSIX modes. */ }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return value;
}

export async function updateState(cwd, mutate, env = process.env) {
  return withStateLock(cwd, async () => {
    const before = await readStateUnlocked(cwd, env);
    const after = mutate(before);
    if (after === undefined) {
      await rm(statePath(cwd, env), { force: true });
      return undefined;
    }
    return writeStateUnlocked(cwd, after, env);
  }, env);
}

export async function deleteState(cwd, env = process.env) {
  return withStateLock(cwd, async () => {
    await rm(statePath(cwd, env), { force: true });
  }, env);
}

// Keep the path helpers testable without exposing the lock implementation.
export function stateLockPath(cwd, env = process.env) {
  return lockPath(cwd, env);
}
