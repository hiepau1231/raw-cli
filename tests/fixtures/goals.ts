import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentOptions } from "../../src/agent.js";
import { openSessionStore } from "../../src/sessions/store.js";
import { ToolRegistry, type ToolRegistration, type ToolPolicyRule } from "../../src/tools/registry.js";
import { handler } from "../../src/tools/bundled/goal/index.js";
import type { ProviderRequest, ProviderTurn } from "../../src/llm/types.js";
export const goalModel = { agentName: "test", provider: "local", method: "openai-chat-completions" as const, model: "fixture", contextWindow: 8192, maxOutputTokens: 512 };
export const goalUsage = { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } };
export function goalRegistry(tools: ToolRegistration[] = [], rules: ToolPolicyRule[] = []) {
  const registry = new ToolRegistry(rules);
  registry.register({ canonicalName: "builtin/goal", name: "goal", description: "Goal", inputSchema: JSON.parse(readFileSync(new URL("../../src/tools/bundled/goal/tool.json", import.meta.url), "utf8")).input_schema, handler });
  for (const tool of tools)
    registry.register(tool);
  return registry;
}
export function goalFixture(generate: (request: ProviderRequest, n: number) => Promise<ProviderTurn> | ProviderTurn, options: Partial<AgentOptions> = {}, tools: ToolRegistration[] = [], rules: ToolPolicyRule[] = []) {
  const root = mkdtempSync(join(tmpdir(), "raw-goal-runtime-"));
  const storeOptions = { env: { XDG_STATE_HOME: root } };
  const store = openSessionStore(storeOptions);
  const session = store.createSession({ cwd: root, title: "Native" });
  const registry = goalRegistry(tools, rules);
  let requests = 0;
  const provider = { modelConfig: goalModel, generate: async (request: ProviderRequest) => generate(request, ++requests) };
  const agent = createAgent({ provider, registry, cwd: root, persistence: { store, sessionId: session.id, surface: "cli" }, ...options });
  return { root, storeOptions, store, session, registry, provider, agent, requests: () => requests, async cleanup() { await agent.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
