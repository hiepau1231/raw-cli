import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { goalFixture, goalUsage } from "./goals.js";
const f = goalFixture((_request, n) => n === 1 ? { text: "write", toolCalls: [{ id: "sentinel", name: "effect", arguments: {} }], finishReason: "tool_calls", usage: goalUsage } : new Promise(() => { }), {}, [{ name: "effect", description: "Sentinel", inputSchema: { type: "object" }, async handler() { appendFileSync(join(f.root, "sentinel"), "1"); return { isError: false, content: [{ type: "text", text: "written" }] }; } }]);
void f.agent.runGoal({ objective: "Crash recovery", criteria: [{ id: "c", label: "Sentinel once" }], maxRequests: 20 }, event => { if (event.type === "tool_result" && event.id === "sentinel")
  process.stdout.write(JSON.stringify({ ready: true, root: f.root, sessionId: f.session.id }) + "\n"); }).catch(error => { console.error(error); process.exitCode = 1; });
