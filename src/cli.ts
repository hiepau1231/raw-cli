import { goalCliCommand, goalStatus, nativeGoalExit } from "./goals/cli.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { terminalInteractionAdapter } from "./interactions/terminal.js";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createAgent, type AgentSession, type RunResult } from "./agent.js";
import type { RawFlags, RuntimeConfig } from "./config.js";
import { createProvider } from "./llm/client.js";
import { createRuntimeTools } from "./tools/plugins/runtime.js";
import { runtimeAgentOptions } from "./sessions/runtime.js";
import { renderTerminalHistory } from "./terminal/history.js";
import { terminalCapabilities } from "./terminal/options.js";
import { formatResumeCommand, formatStats, formatTurnFooter } from "./terminal/footer.js";
import { effectiveInputBudget } from "./llm/context.js";
import { decor, icon, paint } from "./terminal/theme.js";
import { runSessionMaintenance } from "./sessions/maintenance.js";
import type { SessionStore, SessionSummary } from "./sessions/store.js";

import { toolArguments } from "./sessions/display.js";
import { TerminalRenderer } from "./terminal/renderer.js";
import { safeTerminalText } from "./terminal/safe.js";
import type { ToolApprovalRequest } from "./tools/primitives.js";
import { panelTitle, renderPanelsText, selectPanels } from "./panels/render.js";
import { effectiveOutputTokens } from "./llm/output.js";
import { onShutdown } from "./platform/signals.js";

async function textRun(session: AgentSession, task: string, renderer: TerminalRenderer): Promise<RunResult> {
  renderer.start();
  try {
    const result = await session.run(task, renderer.event);
    renderer.finish(result);
    return result;
  } catch (error) {
    renderer.beforeInput();
    throw error;
  }
}

function statusCode(result: RunResult): number {
  if (result.status === "completed") return 0;
  if (result.status === "cancelled") return 130;
  if (result.status === "max_steps") return 3;
  if (result.code === "approval_required") return 2;
  return 1;
}

function lineQueue(rl: ReadlineInterface): {
  next(signal?: AbortSignal): Promise<string | undefined>;
  nextAfter(mark: number, signal?: AbortSignal): Promise<string | undefined>;
  mark(): number;
  intercept(handler: ((line: string) => boolean) | undefined): void;
  drain(): void;
} {
  const buffered: Array<{ id: number; line: string }> = [];
  let closed = false;
  let interceptor: ((line: string) => boolean) | undefined;
  let lastId = 0;
  let waiting: { after: number; deliver: (line: string | undefined) => void } | undefined;
  rl.on("line", (line) => {
    const entry = { id: ++lastId, line };
    if (interceptor?.(line)) return;
    if (waiting && entry.id > waiting.after) { const deliver = waiting.deliver; waiting = undefined; deliver(line); }
    else buffered.push(entry);
  });
  rl.on("close", () => { closed = true; if (waiting) { const deliver = waiting.deliver; waiting = undefined; deliver(undefined); } });
  const take = (after: number, signal?: AbortSignal): Promise<string | undefined> => {
    if (signal?.aborted) return Promise.resolve(undefined);
    const index = buffered.findIndex((entry) => entry.id > after);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]!.line);
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => { if (waiting?.deliver === deliver) waiting = undefined; deliver(undefined); };
      const deliver = (line: string | undefined) => { signal?.removeEventListener("abort", onAbort); resolve(line); };
      waiting = { after, deliver };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  return { next: (signal) => take(0, signal), nextAfter: take, mark: () => lastId, intercept: handler => { interceptor = handler; },
    drain: () => { for (let i = 0; i < buffered.length;) { if (interceptor?.(buffered[i]!.line)) buffered.splice(i, 1); else i++; } } };
}

async function askPermission(lines: ReturnType<typeof lineQueue>, request: ToolApprovalRequest, renderer?: TerminalRenderer): Promise<boolean> {
  const { name, arguments: args, signal, identity } = request;
  if (signal?.aborted) return false;
  const mark = lines.mark();
  process.stderr.write(renderer?.approvalPrompt(request)
    ?? `raw: allow ${safeTerminalText(`${request.title}  ${request.summary}`)}? (${name} ${safeTerminalText(toolArguments(name, args, true, identity))}) [y/N] `);
  const answer = await lines.nextAfter(mark, signal);
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim());
}

export async function runCli(runtime: RuntimeConfig, task: string | undefined,
  store: SessionStore, selected?: SessionSummary, flags: RawFlags = {}): Promise<number> {
  if (!runtime.modelConfig) throw new Error("provider and model are required");
  const cwd = selected?.cwd ?? process.cwd();
  const provider = createProvider(runtime.modelConfig);
  const startupController = new AbortController();
  let startupCancelled = false;
  const cancelStartup = () => { startupCancelled = true; startupController.abort(); };
  process.on("SIGINT", cancelStartup);
  const offStartup = onShutdown(cancelStartup);
  let tools;
  try {
    tools = await createRuntimeTools({ runtime, cwd, signal: startupController.signal });
  } catch (error) {
    if (startupCancelled) return 130;
    throw error;
  } finally {
    process.off("SIGINT", cancelStartup);
    offStartup();
  }
  if (startupCancelled) { await tools.mcp.close(); return 130; }
  const oneShotGoal = flags.goal !== undefined || flags.goalResume === true;
  const rl = oneShotGoal || task === undefined || process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    : undefined;
  const lines = rl ? lineQueue(rl) : undefined;
  let closed = false;
  let cancelledWhileIdle = false;
  let currentRenderer: TerminalRenderer | undefined;
  let nativeRunning = false;
  let nativeUserCancelled = false;
  let reader: "approval" | "interaction" | undefined;
  let liveCommands = Promise.resolve();
  let nativeRun: Promise<RunResult> | undefined;
  let lastTurn: { elapsedMs: number; firstTextMs?: number } | undefined;
  let sessionResumable = true;
  const caps = terminalCapabilities(Boolean(process.stderr.isTTY), process.env, runtime.ui);
  const stdoutCaps = terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui);
  for (const warning of tools.warnings) {
    process.stderr.write(`${paint("warning", icon("attention", runtime.ui, caps), runtime.ui, caps)} ${safeTerminalText(warning)}\n`);
  }
  const formatFooter = (result: RunResult, renderer: TerminalRenderer, id: string, resumable: boolean, repl = false) => {
    const window = runtime.modelConfig!.contextWindow;
    const reserve = effectiveOutputTokens(runtime.modelConfig!);
    const context = session.contextUsage();
    return formatTurnFooter({ status: result.status, ...(result.code ? { code: result.code } : {}),
      elapsedMs: renderer.elapsedMs, startedToolCalls: renderer.startedToolCalls, notRunToolCalls: renderer.notRunToolCalls,
      stats: session.stats(), contextTokens: context.tokens, contextReported: context.source === "provider",
      ...(window === undefined ? {} : { contextWindow: window, inputBudget: effectiveInputBudget(window, reserve) }),
      ...(runtime.compact.triggerTokens === undefined ? {} : { compactTrigger: runtime.compact.triggerTokens }),
      sessionId: id, resumable, repl, ui: runtime.ui, caps });
  };
  const createSavedSession = (title: string) => store.createSession({ cwd, title,
    agentName: runtime.modelConfig!.agentName, configPath: runtime.configPath, modelId: runtime.modelConfig!.model,
    provider: runtime.modelConfig!.provider, method: runtime.modelConfig!.method,
    ...(runtime.modelConfig!.baseUrl ? { endpoint: runtime.modelConfig!.baseUrl } : {}),
    systemPrompt: runtime.systemPrompt });
  const processes = new ProcessSupervisor({ store });
  const createRuntimeAgent = (id: string) => createAgent({ ...runtimeAgentOptions(runtime, tools, provider, cwd),
    processes, persistence: { store, sessionId: id, surface: "cli" },
    ...(process.stdin.isTTY && lines ? { interactionAdapter: async (request, signal) => {
      currentRenderer?.beforeInput();
      reader = "interaction";
      try { return await terminalInteractionAdapter(lines, text => process.stderr.write(text))(request, signal); } finally { reader = undefined; }
    }, approve: async (request: ToolApprovalRequest) => {
      if (request.effects) process.stderr.write(`raw: intended effects ${JSON.stringify(request.effects)}\n`);
      reader = "approval";
      try { return await askPermission(lines, request, currentRenderer); } finally { reader = undefined; }
    } } : {}) });
  const hookEvent = (event: import("./agent.js").RunEvent) => {
    if (currentRenderer) currentRenderer.event(event);
    else if (event.type === "hook_event") process.stderr.write(`${decor(safeTerminalText(`raw: hook ${event.id} ${event.event} ${event.outcome}${event.message ? ` · ${event.message}` : ""}`), caps)}\n`);
  };
  let session: AgentSession;
  let record: SessionSummary;
  try {
    record = selected ?? createSavedSession(task?.trim().replace(/\s+/g, " ").slice(0, 80) || "New session");
    session = createRuntimeAgent(record.id);
    await session.start(selected ? "resume" : "create", selected && task === undefined ? undefined : hookEvent);
  } catch (error) { rl?.close(); try { await processes.close(); } finally { await tools.mcp.close(); } throw error; }
  const interrupt = () => {
    nativeUserCancelled = true;
    currentRenderer?.beforeInput();
    if (session.abort()) return;
    cancelledWhileIdle = true;
    rl?.close();
  };
  const onClose = () => {
    closed = true;
    if (!oneShotGoal) session.abort();
  };
  const onTerm = () => { nativeUserCancelled = true; closed = true; session.abort(); rl?.close(); };
  const nativeSelected = () => session.toolDefinitions.some(tool => session.toolIdentity(tool.name) === "builtin/goal");
  const writeGoal = (text: string) => process.stderr.write(`raw: ${safeTerminalText(text)}\n`);
  const runNative = (mode: "start" | "resume", objective?: string): Promise<RunResult> => {
    const pending = performNative(mode, objective);
    nativeRun = pending;
    // A live command launches work; its admission must not wait for that work's lifetime.
    void pending.catch(() => {});
    return pending;
  };
  const performNative = async (mode: "start" | "resume", objective?: string): Promise<RunResult> => {
    const renderer = new TerminalRenderer(session, runtime, cwd, true, Boolean(selected));
    currentRenderer = renderer; nativeRunning = true; renderer.start();
    try {
      const pending = mode === "start" ? session.runGoal({ objective: objective!, ...(flags.goalTokenBudget === undefined ? {} : { tokenBudget: flags.goalTokenBudget }) }, renderer.event)
        : session.resumeGoal(renderer.event);
      if (session.state !== "idle") lines?.drain();
      const result = await pending;
      renderer.finish(result);
      writeGoal(goalStatus(result.goal?.snapshot ?? session.getGoal()));
      process.stderr.write(formatFooter(result, renderer, record.id, result.code !== "persistence_error", !oneShotGoal));
      return result;
    } finally { nativeRunning = false; currentRenderer = undefined; }
  };
  const command = (line: string) => goalCliCommand(session, line, { write: writeGoal,
    run: async (mode, objective) => { runNative(mode, objective); } });
  const settleNative = async (): Promise<RunResult> => {
    let observed = nativeRun!;
    for (;;) {
      const result = await observed;
      await liveCommands;
      if (nativeRun === observed) return result;
      observed = nativeRun!;
    }
  };
  lines?.intercept(line => {
    if (!nativeRunning) return false;
    if (/^\/goal(?:\s|$)/.test(line)) {
      liveCommands = liveCommands.then(() => command(line)).catch(error => { writeGoal(String(error)); });
      return true;
    }
    if (reader === "interaction" || (reader === "approval" && /^(?:y|yes|n|no)$/i.test(line.trim()))) return false;
    if (!line.trim()) return true;
    try { const queued = session.queueUserInput(line); writeGoal(`queued ${queued.id}`); }
    catch (error) { writeGoal(String(error)); }
    return true;
  });
  process.on("SIGINT", interrupt);
  const offTerm = onShutdown(onTerm);
  rl?.on("SIGINT", interrupt);
  rl?.on("close", onClose);
  try {
    if (oneShotGoal) {
      runNative(flags.goalResume ? "resume" : "start", flags.goal);
      const result = await settleNative();
      const snapshot = session.getGoal();
      return nativeUserCancelled ? 130 : nativeGoalExit({ ...result, goal: { snapshot: snapshot ?? null, stopReason: snapshot?.reason ?? snapshot?.status ?? result.goal?.stopReason ?? "goal_cleared" } });
    }
    if (task !== undefined) {
      currentRenderer = new TerminalRenderer(session, runtime, cwd, true, Boolean(selected));
      const result = await textRun(session, task, currentRenderer);
      let resumable = result.code !== "persistence_error";
      if (resumable) try { resumable = store.getSession(record.id) !== undefined; } catch { resumable = false; }
      process.stderr.write(formatFooter(result, currentRenderer, record.id, resumable));
      return statusCode(result);
    }
    if (!rl || !lines) throw new Error("interactive input unavailable");
    new TerminalRenderer(session, runtime, cwd, true, Boolean(selected)).start();
    if (selected) for (const item of store.getSessionHistory({ sessionId: selected.id }).items) {
      process.stdout.write(renderTerminalHistory(item, runtime.ui,
        terminalCapabilities(Boolean(process.stdout.isTTY), process.env, runtime.ui), process.stdout.columns || 80));
    }
    while (!closed) {
      try { runSessionMaintenance(store, { sweepOrphans: false, reclaim: false }); }
      catch { process.stderr.write("raw: session maintenance deferred\n"); }
      process.stdout.write(`${paint("accent", icon("user", runtime.ui, stdoutCaps), runtime.ui, stdoutCaps)} `);
      const line = await lines.next();
      if (line === undefined) break;
      if (closed) break;
      if (!line.trim()) continue;
      if (line === "/exit") break;
      if (nativeSelected() && /^\/goal(?:\s|$)/.test(line)) {
        try {
          const previous = nativeRun;
          await command(line);
          if (nativeRun !== previous) await settleNative();
        } catch (error) { writeGoal(String(error)); }
        continue;
      }
      if (line === "/clear") {
        await session.close(hookEvent);
        record = createSavedSession("New session");
        session = createRuntimeAgent(record.id);
        await session.start("create", hookEvent);
        lastTurn = undefined;
        sessionResumable = true;
        process.stderr.write("raw: conversation cleared\n");
        new TerminalRenderer(session, runtime, cwd, true).start();
        continue;
      }
      if (line === "/panels" || line.startsWith("/panels ")) {
        const words = line.split(/\s+/).slice(1);
        const all = words.includes("--all");
        const id = words.find((word) => word !== "--all");
        const found = selectPanels(store.listSessionPanels(record.id), { ...(all ? { all: true } : {}), ...(id ? { id } : {}) });
        process.stderr.write(!found ? `raw: unknown panel ${safeTerminalText(id ?? "")}\n`
          : found.length ? `${decor(safeTerminalText(renderPanelsText(found.map((panel) => ({ title: panelTitle(panel), document: panel.document, closed: panel.closed })))), caps)}\n` : "raw: no open panels\n");
        continue;
      }
      if (line === "/stats") { process.stderr.write(formatStats(session.stats(), runtime.ui, caps, lastTurn)); continue; }
      if (line === "/compact") {
        try {
          const modelConfig = runtime.resolveCompactModelConfig();
          process.stderr.write(`${paint("thinking", icon("thinking", runtime.ui, caps), runtime.ui, caps)} Compacting with ${modelConfig.agentName}\n`);
          const result = await session.compact({ provider: createProvider(modelConfig),
            keepRecentTurns: runtime.compact.keepRecentTurns, maxOutputTokens: runtime.compact.maxOutputTokens,
            ...(runtime.compact.maxOutputTokensDefaulted ? { maxOutputTokensDefaulted: true } : {}),
            ...(runtime.compact.keepRecentTokens !== undefined ? { keepRecentTokens: runtime.compact.keepRecentTokens } : {}),
            ...(runtime.compact.instructions ? { instructions: runtime.compact.instructions } : {}) });
          process.stderr.write(`${paint(result.status === "compacted" ? "success" : "warning",
            icon(result.status === "compacted" ? "success" : "attention", runtime.ui, caps), runtime.ui, caps)} Compact ${result.status}\n`);
        } catch { process.stderr.write("raw: compaction failed\n"); }
        continue;
      }
      const goal = nativeSelected() ? session.getGoal() : undefined;
      if (goal && (goal.status === "paused" || goal.status === "blocked")) {
        try { const queued = session.queueUserInput(line); writeGoal(`queued ${queued.id}; goal remains ${goal.status}`); }
        catch (error) { writeGoal(String(error)); }
        continue;
      }
      currentRenderer = new TerminalRenderer(session, runtime, cwd, false);
      const result = await textRun(session, line, currentRenderer);
      lastTurn = { elapsedMs: currentRenderer.elapsedMs,
        ...(currentRenderer.firstTextMs === undefined ? {} : { firstTextMs: currentRenderer.firstTextMs }) };
      if (result.code === "persistence_error") sessionResumable = false;
      process.stderr.write(formatFooter(result, currentRenderer, record.id, false, true));
      if (result.code === "approval_required" && !process.stdin.isTTY) return statusCode(result);
      currentRenderer = undefined;
    }
    if (sessionResumable && store.getSession(record.id)) process.stderr.write(formatResumeCommand(record.id, runtime.ui, caps));
    return cancelledWhileIdle ? 130 : 0;
  } finally {
    lines?.intercept(undefined);
    await liveCommands;
    rl?.close();
    process.off("SIGINT", interrupt);
    offTerm();
    await session.close(hookEvent);
    try { await processes.close(); } finally { await tools.mcp.close(); }
  }
}
