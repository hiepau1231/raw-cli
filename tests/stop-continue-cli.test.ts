import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/hooks/runner.js";
import type { SelectedHook } from "../src/hooks/contract.js";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "raw-stop-continue-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "raw-stop-continue-state-"));

const example = join(process.cwd(), "examples/hooks/keep-going");
const reply = (text: string) => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });

async function raw(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(process.cwd(), "bin/raw.ts"), ...args],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdin.end("");
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

async function scenario(options: { done: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "raw-stop-continue-"));
  await mkdir(join(root, "hooks"), { recursive: true });
  await cp(example, join(root, "hooks", "keep-going"), { recursive: true });
  if (options.done) await writeFile(join(root, "DONE"), "");
  const fixture = await startMockProvider([reply("one"), reply("two"), reply("three"), reply("four")]);
  const config = join(root, "raw.json");
  await writeFile(config, JSON.stringify({ default_agent: "fixture",
    models: { fixture: { provider: "openai", method: "openai-chat-completions", model_id: "fixture", base_url: fixture.url } },
    agents: { fixture: { model: "fixture", tools: { use: [] }, hooks: { use: ["agent/keep-going"] } } } }));
  try {
    const result = await raw(["--config", config, "do the task"], root, { ...process.env, OPENAI_API_KEY: "key" });
    const lastMessages = fixture.requests.map((request) => {
      const messages = (request.body as { messages: Array<{ role: string; content: unknown }> }).messages;
      return messages.at(-1)!;
    });
    return { result, lastMessages };
  } finally { await fixture.close(); }
}

test("the real CLI keeps going exactly while the keep-going hook denies", async () => {
  const { result, lastMessages } = await scenario({ done: false });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastMessages.length, 4, "the first answer plus three continuations");
  assert.deepEqual(lastMessages.map((message) => message.role), ["user", "user", "user", "user"]);
  assert.equal(lastMessages[0]!.content, "do the task");
  for (const message of lastMessages.slice(1)) {
    assert.match(String(message.content), /^\[Raw hook continuation\] Keep going until a file named DONE exists/);
  }
  assert.match(result.stdout, /four/);
});

test("with the DONE file present the CLI makes one request", async () => {
  const { result, lastMessages } = await scenario({ done: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastMessages.length, 1);
  assert.match(result.stdout, /one/);
});

test("the keep-going example decides from DONE and the continuation count", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-keep-going-"));
  const hook: SelectedHook = { protocol_version: 2, id: "agent/keep-going", name: "keep-going", folder: example,
    command: process.execPath, args: [join(example, "index.mjs")], timeoutMs: 3000, events: [{ name: "Stop" }] };
  const usage = { requests: 1 } as never;
  const ask = (continuations: number, status = "completed") => runHook(hook, { protocol_version: 2, event: "Stop", cwd,
    run: { status, steps: 1, text: "x" }, stop: { hook_active: continuations > 0, continuations, usage } });
  assert.equal((await ask(0)).decision, "deny");
  assert.equal((await ask(2)).decision, "deny");
  assert.equal((await ask(3)).decision, "continue");
  assert.equal((await ask(0, "error")).decision, "continue");
  await writeFile(join(cwd, "DONE"), "");
  assert.equal((await ask(0)).decision, "continue");
});

test("docs/hooks.md describes the Stop continuation and no longer says Stop cannot deny", async () => {
  const docs = await readFile(join(process.cwd(), "docs/hooks.md"), "utf8");
  assert.doesNotMatch(docs, /cannot deny Stop/);
  assert.doesNotMatch(docs, /Hooks do not edit model messages or tool schemas\./);
  for (const name of ["hook_active", "continuations", "raw.stop-continue/1", "[Raw hook continuation]"]) assert.ok(docs.includes(name), name);
});
