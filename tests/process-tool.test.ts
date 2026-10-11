import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.type === "text" ? block.text : "").join("");
async function registry(rules: ConstructorParameters<typeof ToolRegistry>[0] = []) {
  const registry = new ToolRegistry(rules); for (const tool of await loadBundledTools(["process"])) registry.register(tool); return registry;
}
test("packaged Process uses normal policy and validates all action arguments before approval or spawn", async () => {
  const tools = await registry([{ match: "builtin/process", effect: "ask" }]); let approvals = 0;
  const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("s");
  try {
    for (const [args, example] of [[{ action: "start", command: "true", cwd: "/tmp" }, undefined], [{ action: "stop" }, '{"action":"stop","id":"<id>"}'],
      [{ action: "start" }, '{"action":"start","command":"npm run dev"}'], [{ action: "output", id: "x", cursor: -1 }, undefined],
      [{ action: "launch", command: "true" }, undefined], [{ action: "start", command: "true", env_refs: { "bad-name": "var" } }, undefined]] as const) {
      const result = await tools.dispatch("process", args, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => { approvals++; return true; } });
      assert.equal(result.code, "invalid_arguments", JSON.stringify(args));
      if (example) assert.ok(JSON.stringify(result.content).includes(JSON.stringify(example).slice(1, -1)), JSON.stringify(result.content));
    }
    assert.equal(approvals, 0); assert.equal(processes.list().length, 0);
    const unavailable = await tools.dispatch("process", { action: "list" }, { cwd: process.cwd(), maxOutputBytes: 8192, approve: () => true });
    assert.equal(unavailable.code, "process_unavailable");
    const noVariables = await tools.dispatch("process", { action: "start", command: "true", env_refs: { KEY: "missing" } }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => true });
    assert.equal(noVariables.code, "vars_unavailable"); assert.equal(processes.list().length, 0);
    const denied = await tools.dispatch("process", { action: "start", command: "sleep 30" }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => false });
    assert.equal(denied.isError, true); assert.equal(processes.list().length, 0);
    const started = await tools.dispatch("process", { action: "start", command: "printf process; sleep 30" }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => { approvals++; return true; } });
    assert.equal(started.isError, false);
    const id = started.host!.processId!;
    assert.deepEqual(started.content, [{ type: "text", text: `Started ${id} · printf process; sleep 30` }]);
    const stopped = await tools.dispatch("process", { action: "stop", id }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => true });
    assert.equal(stopped.isError, false); assert.match(text(stopped), new RegExp(`^Stopped ${id} · stopped`));
  } finally { await supervisor.close(); }
});

test("Process output pages channel text and advances cursors under escaped-text result budgets", async () => {
  const tools = await registry(); const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("output");
  try {
    const job = await processes.start({ command: "node -e \"process.stdout.write(String.fromCharCode(1).repeat(1500))\"", cwd: process.cwd() });
    for (let i = 0; i < 200 && processes.status(job.id).state === "running"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    let cursor = 0; let output = "";
    while (cursor < processes.status(job.id).cursor) {
      const result = await tools.dispatch("process", { action: "output", id: job.id, cursor }, { cwd: process.cwd(), maxOutputBytes: 512, processes, autoApprove: true });
      assert.equal(result.isError, false); assert.equal(result.truncated, false);
      const page = result.host!.page!;
      assert.ok(page.next > cursor, "each budget-aware page makes progress");
      assert.ok(text(result).includes(`\n[next cursor: ${page.next}]\n[exited · exit 0]`), text(result));
      output += result.content.map(block => block.type === "text" && block.channel ? block.text : "").join(""); cursor = page.next;
    }
    assert.equal(output, String.fromCharCode(1).repeat(1500));
  } finally { await supervisor.close(); }
});

test("Process action is a typed policy path so Stop can require approval independently of reads", async () => {
  const tools = await registry([{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }]);
  const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("policy");
  try {
    const job = await processes.start({ command: "sleep 30", cwd: process.cwd() });
    const context = { cwd: process.cwd(), maxOutputBytes: 8192, processes, autoApprove: true };
    assert.equal((await tools.dispatch("process", { action: "status", id: job.id }, context)).isError, false);
    assert.equal((await tools.dispatch("process", { action: "stop", id: job.id }, { ...context, approve: () => false })).isError, true);
    assert.equal(processes.status(job.id).state, "running");
    assert.equal((await tools.dispatch("process", { action: "stop", id: job.id }, { ...context, approve: () => true })).isError, false);
  } finally { await supervisor.close(); }
});

test("Process takes the flat shape with aliases, drops fields another action does not use, and lists jobs as text", async () => {
  const tools = await registry(); const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("flat");
  const context = { cwd: process.cwd(), maxOutputBytes: 8192, processes, autoApprove: true };
  try {
    assert.equal(text(await tools.dispatch("process", { action: "list" }, context)), "No background jobs.");
    const started = await tools.dispatch("process", { action: "start", command: "sleep 30", label: "Sleeper", timeout_ms: 60000 }, context);
    const id = started.host!.processId!;
    assert.equal(text(started), `Started ${id} · Sleeper`);
    assert.deepEqual(started.host?.notes, ["read timeout_ms as timeout"]);
    for (const alias of ["process_id", "shell_id", "bash_id"]) {
      const status = await tools.dispatch("process", { action: "status", [alias]: id }, context);
      assert.equal(status.isError, false, alias);
      assert.match(text(status), new RegExp(`^${id} · running · Sleeper: sleep 30\n\\[output bytes: 0\\]$`));
    }
    const extra = await tools.dispatch("process", { action: "status", id, command: "ignored" }, context);
    assert.equal(extra.isError, false);
    assert.deepEqual(extra.host?.notes, ["ignored command for action status"]);
    assert.equal(text(await tools.dispatch("process", { action: "list" }, context)), `${id} · running · Sleeper: sleep 30`);
    const empty = await tools.dispatch("process", { action: "output", id }, context);
    assert.equal(text(empty), "No new output.\n[next cursor: 0]\n[running]");
  } finally { await supervisor.close(); }
});
