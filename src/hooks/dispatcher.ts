import { HookError, type HookEventName, type HookRequest, type SelectedHook } from "./contract.js";
import { matchesHookSubscription } from "./manifest.js";
import { runHook } from "./runner.js";
import { bindWhenToSchema, compileWhen } from "../tools/policy.js";
import { truncateBytes } from "../panels/render.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";

export interface HookReceipt {
  id: string;
  event: HookEventName;
  outcome: "continued" | "denied" | "error";
  durationMs: number;
  message?: string;
  code?: string;
}
/** `continueWith`: the joined reasons of the `Stop` hooks that asked the run to continue. */
export interface HookDispatchResult { blocked?: "denied" | "error"; reason?: string; continueWith?: string }
/** Host text added to the context on every continuation: the size raw already allows for panel reminders (`PANEL_LIMITS.reminderTotalBytes`), close to the 10,000 characters Claude Code lets one hook string inject. */
const STOP_CONTINUE_MAX_BYTES = 8 * 1024;
const STOP_CONTINUE_DEFAULT = "A Stop hook asked the run to continue.";

/** The joined reasons, kept whole up to the bound; beyond it the text is cut on a character boundary and says how much was cut. */
function boundedContinuation(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= STOP_CONTINUE_MAX_BYTES) return text;
  const marker = ` [Stop hook reasons cut: ${bytes} → ${STOP_CONTINUE_MAX_BYTES} bytes]`;
  return truncateBytes(text, STOP_CONTINUE_MAX_BYTES - Buffer.byteLength(marker)) + marker;
}

export class HookDispatcher {
  constructor(readonly selected: readonly SelectedHook[], private readonly env?: NodeJS.ProcessEnv) {}

  validateTools(registry: ToolRegistry, visibleNames: readonly string[]): void {
    for (const tool of registry.definitions(visibleNames)) this.validateTool(registry.canonicalIdentity(tool.name) ?? tool.name,
      registry.inspectionDefinition(tool.name)!);
  }

  validateTool(identity: string, definition: ToolDefinition): void {
    for (const hook of this.selected) for (const subscription of hook.events) {
      if (!subscription.when) continue;
      if (matchesHookSubscription({ name: subscription.name,
          ...(subscription.match ? { match: subscription.match } : {}) }, subscription.name, identity)) {
        bindWhenToSchema(compileWhen(subscription.when), definition, identity);
      }
    }
  }

  async run(event: HookEventName, request: Omit<HookRequest, "protocol_version" | "event">,
    options: { signal?: AbortSignal; deadline?: number; onReceipt?: (receipt: HookReceipt) => void;
      /** An interruption: once it aborts, the remaining hooks of this event share `graceMs` instead of their own timeouts. */
      hurry?: { signal: AbortSignal; graceMs: number } } = {}): Promise<HookDispatchResult> {
    const gate = event === "UserPromptSubmit" || event === "PreToolUse";
    let deadline = options.deadline;
    const continuations: string[] = [];
    for (const hook of this.selected) {
      if (gate && hook.events.some(item => item.when?.source === "effects"
        && matchesHookSubscription({ name: item.name, ...(item.match ? { match: item.match } : {}) }, event, request.tool?.identity))
        && request.tool?.effects === undefined) return { blocked: "error", reason: `hook ${hook.id}: effects inspection unavailable` };
      if (!hook.events.some((item) => matchesHookSubscription(item, event, request.tool?.identity, request.tool?.arguments, request.tool?.effects))) continue;
      if (options.signal?.aborted) return gate ? { blocked: "error", reason: "hook aborted" } : {};
      if (options.hurry?.signal.aborted) deadline = Math.min(deadline ?? Infinity, Date.now() + options.hurry.graceMs);
      if (deadline !== undefined && Date.now() >= deadline) break;
      const started = performance.now();
      let receipt: HookReceipt;
      let denial: string | undefined;
      try {
        const response = await runHook(hook, { protocol_version: 2, event, ...request }, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(deadline !== undefined ? { timeoutMs: Math.max(1, deadline - Date.now()) } : {}),
          ...(options.hurry ? { hurry: options.hurry } : {}),
          ...(this.env ? { env: this.env } : {}),
        });
        receipt = { id: hook.id, event, outcome: response.decision === "deny" ? "denied" : "continued",
          durationMs: response.durationMs, ...(response.message ? { message: response.message } : {}) };
        if (response.decision === "deny") denial = response.reason || (event === "Stop" ? STOP_CONTINUE_DEFAULT : `hook ${hook.id} denied`);
      } catch (error) {
        const code = error instanceof HookError ? error.code : "hook_callback";
        receipt = { id: hook.id, event, outcome: "error", durationMs: Math.round(performance.now() - started), code };
      }
      options.onReceipt?.(receipt);
      if (receipt.outcome === "error" && gate) return { blocked: "error", reason: `hook ${hook.id} failed: ${receipt.code}` };
      if (denial && event === "Stop") continuations.push(denial);
      else if (denial) return gate ? { blocked: "denied", reason: denial } : {};
    }
    return continuations.length ? { continueWith: boundedContinuation([...new Set(continuations)].join("\n\n")) } : {};
  }
}
