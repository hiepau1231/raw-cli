import { randomUUID } from "node:crypto";
import { GoalError, transitionGoal, type GoalRequest, type GoalReceipt, type GoalState } from "../goals/contract.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { InteractionService } from "../interactions/service.js";
import type { AgentSession, RunEvent, RunResult } from "../agent.js";
import type { CompactOptions, CompactResult } from "../compact.js";
import type { CompactSettings } from "../config.js";
import type { ResolvedModelConfig } from "../llm/types.js";
import type { RequestOverride } from "../request-controls.js";
import type { ToolContext } from "../tools/primitives.js";
import type { UserInput } from "../llm/types.js";
import { measureSession, type SessionMetrics } from "./metrics.js";
import { approvalTimeoutMs, SessionOperationError, terminalOperationStates, type OperationIntent, type OperationState, type SessionOperation } from "./operation-types.js";
import { attachSessionRuntime } from "./runtime.js";
import { queuedGoalId, type QueuedIntent, type SessionOwner, type SessionStore, type SessionSummary } from "./store.js";
import type { QueuedInputView } from "./view.js";


export type { OperationIntent, OperationState, SessionOperation } from "./operation-types.js";
export { SessionOperationError } from "./operation-types.js";

export interface SessionRuntime {
  capabilities?: SessionMetrics["capabilities"];
  agent: AgentSession;
  modelConfig: Readonly<ResolvedModelConfig>;
  compactOptions: CompactOptions;
  compact?: Readonly<CompactSettings>;
  close(): Promise<void>;
}
export type AttachSessionRuntime = (options: {
  store: SessionStore; session: SessionSummary; operation: SessionOperation; owner: SessionOwner;
  signal: AbortSignal; processes?: ProcessSupervisor; interactions?: InteractionService; approve?: ToolContext["approve"]; env?: NodeJS.ProcessEnv;
  /** Per-turn request override, applied to this operation's provider request only. */
  request?: RequestOverride;
}) => Promise<SessionRuntime>;

export type OperationEvent = { sessionId: string; operationId: string } & (
  | { type: "operation"; operation: SessionOperation }
  | { type: "event"; event: RunEvent }
  | { type: "goal"; state: GoalState }
  | { type: "host_error"; message: string }
  /** The session's waiting messages changed; `items` is the full list. */
  | { type: "inputs"; items: QueuedInputView[] }
);
interface ActiveOperation {
  sessionId: string;
  owner: SessionOwner;
  /** Structured turn input for this process only; the persisted operation keeps the text. */
  blocks?: UserInput;
  /** Per-turn request override for this process only; never persisted. */
  request?: RequestOverride;
  controller: AbortController;
  done: Promise<SessionOperation>;
  agent?: AgentSession;
  measure?: () => SessionMetrics;
  holdGoalControl?: boolean;
}

export class SessionOperations {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly observers = new Set<(event: OperationEvent) => void>();
  private closed = false;
  private readonly goalControls = new Map<string, { id: string; promise: Promise<GoalReceipt> }>();
  constructor(private readonly options: {
    store: SessionStore; attach?: AttachSessionRuntime; env?: NodeJS.ProcessEnv;
    interactions?: InteractionService;
    processes?: ProcessSupervisor;
    approve?: (operation: SessionOperation) => ToolContext["approve"];
  }) { options.store.recoverOperations(); }

  subscribe(observer: (event: OperationEvent) => void): () => void {
    this.observers.add(observer); return () => { this.observers.delete(observer); };
  }
  private publish(event: OperationEvent): void {
    for (const observer of this.observers) {
      try { observer(structuredClone(event)); } catch { /* Observers never own execution. */ }
    }
  }
  owns(operationId: string): boolean { return this.active.has(operationId); }
  activeIds(): string[] { return [...this.active.keys()]; }
  metrics(operationId: string): SessionMetrics | undefined { return this.active.get(operationId)?.measure?.(); }
  approvalTimeout(_operationId: string): number { return approvalTimeoutMs(this.options.env); }
  toolIdentity(operationId: string, name: string): string | undefined { return this.active.get(operationId)?.agent?.toolIdentity(name); }

  publishGoal(sessionId: string): void {
    this.publish({ type: "goal", sessionId, operationId: this.holder(sessionId)?.operationId ?? "", state: this.options.store.getGoalState(sessionId) });
  }

  /** Commands belong to this host or an idle fenced lease, never a foreign live process. */
  commandGoal(sessionId: string, request: GoalRequest, binding: { agentName: string; configPath: string; maxRequests?: number }): Promise<GoalReceipt> {
    if (this.closed) return Promise.reject(new SessionOperationError("closed", "session operations are closed"));
    const prior = this.options.store.goalCommandReceipt(sessionId, request);
    if (prior) return Promise.resolve(prior);
    const pending = this.goalControls.get(sessionId);
    if (pending) {
      if (pending.id !== request.clientRequestId) return Promise.reject(new SessionOperationError("busy", "a goal command is settling"));
      return pending.promise.then(() => this.commandGoal(sessionId, request, binding));
    }
    const promise = Promise.resolve().then(() => {
      if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
      return this.applyGoalCommand(sessionId, request, binding);
    }).finally(() => {
      if (this.goalControls.get(sessionId)?.promise === promise) this.goalControls.delete(sessionId);
    });
    this.goalControls.set(sessionId, { id: request.clientRequestId, promise });
    return promise;
  }

  private async applyGoalCommand(sessionId: string, request: GoalRequest, binding: { agentName: string; configPath: string; maxRequests?: number }): Promise<GoalReceipt> {
    const { store } = this.options;
    if (["update", "block"].includes(request.command.action)) throw new GoalError("forbidden", "model-only progress actions are not dashboard controls");
    if (request.command.action === "start" || request.command.action === "resume") {
      const accepted = store.acceptGoalOperation({ sessionId, clientRequestId: request.clientRequestId, kind: "goal", agentName: binding.agentName, configPath: binding.configPath }, request, binding.maxRequests);
      if (accepted.owner) { this.launch(accepted.operation, accepted.owner); this.publishGoal(sessionId); }
      return accepted.receipt;
    }
    const before = store.getGoalState(sessionId);
    if (before.revision !== request.expectedRevision) throw new GoalError("stale_revision", "goal changed before the command");
    // Validate the complete payload/guard before stopping anything. Only edit requires an anticipated pause.
    const check = request.command.action === "edit" && before.goal?.status === "active"
      ? { ...before, goal: { ...before.goal, status: "paused" as const } } : before;
    transitionGoal(check, request.command, "user");
    const holder = this.holder(sessionId), active = holder && this.active.get(holder.operationId);
    if (!holder || !active) {
      const receipt = store.commandGoal(sessionId, request, "user"); this.publishGoal(sessionId); return receipt;
    }
    active.holdGoalControl = true;
    try {
      if (before.goal?.status === "active") {
        store.commandGoal(sessionId, { clientRequestId: randomUUID(), expectedRevision: before.revision, command: { action: "pause" } }, "user", holder.owner);
        this.publishGoal(sessionId);
      }
      active.controller.abort(); active.agent?.abort();
      await active.done;
      const receipt = store.settledGoalCommand(sessionId, request, holder.owner, before.goal!.id);
      this.publishGoal(sessionId);
      return receipt;
    } catch (error) {
      active.controller.abort(); active.agent?.abort(); await active.done.catch(() => {}); throw error;
    } finally { active.holdGoalControl = false; store.releaseSession(sessionId, holder.owner); }
  }

  private ensureNoGoalControl(sessionId: string): void {
    if (this.goalControls.has(sessionId)) throw new SessionOperationError("busy", "a goal command is settling");
  }

  submit(intent: OperationIntent, blocks?: UserInput, request?: RequestOverride): SessionOperation {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.ensureNoGoalControl(intent.sessionId);
    this.options.store.recoverOperations();
    const { operation, owner } = this.options.store.acceptOperation(intent);
    if (!owner) return operation;
    this.launch(operation, owner, blocks, request);
    return structuredClone(operation);
  }

  /**
   * Sends a turn message: it starts a turn when the session is idle, and waits in the session's queue while a turn of
   * this process runs (docs/sessions.md). `interrupt` also stops that turn, and the message starts the next one. A session
   * held by another process answers `busy`.
   */
  enqueue(intent: OperationIntent, options: { blocks?: UserInput; request?: RequestOverride; mode: QueuedIntent["mode"] }):
    { operation: SessionOperation } | { queued: QueuedInputView } {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    this.ensureNoGoalControl(intent.sessionId);
    const holder = this.holder(intent.sessionId);
    if (holder) {
      try {
        const queued = this.options.store.enqueueInput(intent.sessionId, holder.owner, { ...intent, mode: options.mode,
          ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.request ? { request: options.request } : {}) });
        this.publishInputs(intent.sessionId, holder.operationId);
        // Marked and stopped in one synchronous call, so the ending turn's successor choice sees this message.
        if (options.mode === "interrupt") this.cancel(holder.operationId);
        return { queued };
      } catch (error) {
        // The turn ended between the lookup and the write: the session is free, so this message starts the next turn.
        if (!(error instanceof Error && error.message === "session ownership lost")) throw error;
      }
    }
    const goal = this.options.store.getGoalState(intent.sessionId).goal;
    if (goal && !["complete", "abandoned"].includes(goal.status)) {
      const owner = this.options.store.claimSession(intent.sessionId);
      try {
        const queued = this.options.store.enqueueInput(intent.sessionId, owner, { ...intent, mode: "queue",
          ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.request ? { request: options.request } : {}) });
        this.options.store.pauseGoalInputs(intent.sessionId, owner, "Resume Goal explicitly to deliver steering");
        this.publishInputs(intent.sessionId);
        return { queued: this.options.store.queuedInputView(intent.sessionId, queued.id)! };
      } finally { this.options.store.releaseSession(intent.sessionId, owner); }
    }
    return { operation: this.submit(intent, options.blocks, options.request) };
  }

  /** Sends a waiting, paused or blocked message now: it interrupts the running turn, or starts a turn when the session is idle. */
  sendNow(sessionId: string, inputId: string): { operation: SessionOperation } | { queued: QueuedInputView } {
    if (this.closed) throw new SessionOperationError("closed", "session operations are closed");
    this.options.store.recoverOperations();
    this.ensureNoGoalControl(sessionId);
    const goal = this.options.store.getGoalState(sessionId).goal;
    if (goal && !["complete", "abandoned"].includes(goal.status)) throw new GoalError("goal_inactive", "Resume Goal explicitly to deliver steering");
    const holder = this.holder(sessionId);
    if (holder) {
      try {
        const queued = this.options.store.markInterrupt(sessionId, holder.owner, inputId);
        this.publishInputs(sessionId, holder.operationId);
        this.cancel(holder.operationId);
        return { queued };
      } catch (error) { if (!(error instanceof Error && error.message === "session ownership lost")) throw error; }
    }
    const started = this.options.store.startQueuedInput(sessionId, inputId);
    this.launch(started.operation, started.owner, typeof started.input === "string" ? undefined : started.input, started.request);
    this.publishInputs(sessionId, started.operation.id);
    return { operation: structuredClone(started.operation) };
  }

  /** The operation of this process that holds the session's lease now, if any. */
  private holder(sessionId: string): { operationId: string; owner: SessionOwner } | undefined {
    let found: { operationId: string; owner: SessionOwner } | undefined;
    for (const [operationId, active] of this.active) {
      if (active.sessionId === sessionId && (!found || active.owner.generation > found.owner.generation)) found = { operationId, owner: active.owner };
    }
    return found;
  }

  publishInputs(sessionId: string, operationId = ""): void {
    this.publish({ type: "inputs", sessionId, operationId, items: this.options.store.queuedInputs(sessionId) });
  }

  private launch(operation: SessionOperation, owner: SessionOwner, blocks?: UserInput, request?: RequestOverride): void {
    const controller = new AbortController();
    let resolveDone!: (operation: SessionOperation) => void;
    let rejectDone!: (error: unknown) => void;
    const active: ActiveOperation = { sessionId: operation.sessionId, owner, ...(blocks ? { blocks } : {}), ...(request ? { request } : {}),
      controller, done: new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }) };
    // A detached HTTP client is not responsible for consuming a terminal persistence error.
    void active.done.catch(() => {});
    this.active.set(operation.id, active);
    const heartbeat = setInterval(() => {
      try { this.options.store.renewSession(operation.sessionId, owner); active.agent?.checkpointGoal(); }
      catch { controller.abort(); active.agent?.abort(); }
    }, 5_000);
    this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
    setImmediate(() => {
      void this.execute(operation, owner, active).then(resolveDone, rejectDone).finally(() => {
        clearInterval(heartbeat); this.active.delete(operation.id);
      });
    });
  }

  private async execute(operation: SessionOperation, owner: SessionOwner, active: ActiveOperation): Promise<SessionOperation> {
    try { return await this.executeOwned(operation, owner, active); }
    finally { if (!active.holdGoalControl) this.options.store.releaseSession(operation.sessionId, owner); }
  }

  private async executeOwned(operation: SessionOperation, owner: SessionOwner, active: ActiveOperation): Promise<SessionOperation> {
    const { store } = this.options;
    const startedAt = performance.now();
    let runtime: SessionRuntime | undefined;
    let state: OperationState = "error";
    let result: RunResult | CompactResult | undefined;
    let error: SessionOperation["error"];
    let metrics: SessionMetrics | undefined;
    let startedTools = 0; let failedTools = 0; let firstRequest = 0;
    const publishState = (next: OperationState) => {
      operation = store.updateOperation(operation.id, owner, next);
      this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
    };
    const event = (event: RunEvent) => {
      // The commit set the operation's committed position; clients learn the agent has the message from the operation.
      if (event.type === "input_committed") {
        operation = store.getOperation(operation.id) ?? operation;
        this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation });
        return;
      }
      if (event.type === "queued_input") { this.publishInputs(operation.sessionId, operation.id); return; }
      if (event.type === "tool_start") startedTools++;
      if (event.type === "tool_result" && (event.display?.failed ?? event.result.isError)) failedTools++;
      this.publish({ type: "event", sessionId: operation.sessionId, operationId: operation.id, event });
    };
    try {
      publishState("starting");
      if (active.controller.signal.aborted) throw new Error("operation cancelled");
      const session = store.getSession(operation.sessionId);
      if (!session) throw new SessionOperationError("not_found", store.missingSessionMessage());
      const approve = this.options.approve?.(operation);
      runtime = await (this.options.attach ?? attachSessionRuntime)({ store, session, operation, owner,
        signal: active.controller.signal, ...(this.options.processes ? { processes: this.options.processes } : {}), ...(this.options.interactions ? { interactions: this.options.interactions } : {}), ...(approve ? { approve } : {}), ...(this.options.env ? { env: this.options.env } : {}),
        ...(active.request && operation.kind === "turn" ? { request: active.request } : {}) });
      active.agent = runtime.agent;
      firstRequest = runtime.agent.stats().requests;
      const attached = runtime;
      active.measure = () => ({ ...measureSession(attached.agent, attached.modelConfig, { startedAt, firstRequest, startedTools, failedTools,
        ...(attached.compact ? { compact: attached.compact } : {}) }), historyWatermark: store.historyWatermark(operation.sessionId),
        ...(attached.capabilities ? { capabilities: attached.capabilities } : {}) });
      if (active.controller.signal.aborted) throw new Error("operation cancelled");
      publishState(operation.kind === "compact" ? "compacting" : "running");
      if (operation.kind === "turn") {
        result = await runtime.agent.run(active.blocks ?? operation.input!, event); state = result.status;
      } else if (operation.kind === "goal") {
        result = await runtime.agent.runAcceptedGoal(operation.goal!.id, operation.goal!.start, event); state = result.status;
      } else if (operation.kind === "panel_action") {
        const run = await runtime.agent.runPanelAction(operation.action!, event);
        result = run; state = run.status;
        if (run.status === "error") error = { code: run.code ?? "action_error", message: run.message ?? "the action failed" };
      } else {
        result = await runtime.agent.compact(runtime.compactOptions, event);
        state = result.status === "cancelled" ? "cancelled" : "completed";
      }
    } catch (cause) {
      state = active.controller.signal.aborted ? "cancelled" : "error";
      if (state === "error") error = { code: cause instanceof SessionOperationError ? cause.code : "operation_error",
        message: cause instanceof Error ? cause.message : String(cause) };
    }
    try {
      if (runtime) {
        // The host retains the fenced lease until both tool and agent cleanup complete.
        try { await runtime.close(); } finally { await runtime.agent.close(); }
        metrics = active.measure?.();
      }
    } catch (cause) {
      state = "error"; error = { code: "cleanup_error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (operation.kind === "goal" && store.getGoalState(operation.sessionId).goal?.status === "active") {
      // Startup may fail before an AgentSession/GoalRuntime exists. Never leave a ghost active Goal.
      const goal = store.getGoalState(operation.sessionId);
      store.commandGoal(operation.sessionId, { clientRequestId: randomUUID(), expectedRevision: goal.revision,
        command: { action: "pause", reason: error?.code ?? "runtime_stopped" } }, "user", owner);
    }
    if (operation.kind === "goal") this.publishGoal(operation.sessionId);
    const goalStopped = operation.kind === "goal" || !!(result && "goal" in result && result.goal);
    if (goalStopped || active.holdGoalControl) store.pauseGoalInputs(operation.sessionId, owner, "Goal stopped; explicit user action is required");
    const details = { ...(result ? { result } : {}), ...(error ? { error } : {}), ...(metrics ? { metrics } : {}) };
    // The interrupting message starts the next turn whatever the ending; otherwise a completed turn hands the session to
    // the oldest waiting message, and any other ending, or a Stop that arrived during cleanup, pauses them all.
    let pauseReason: string | undefined;
    // Native steering belongs to an explicitly resumed Goal, never an automatically launched ordinary turn.
    const waiting = this.closed ? [] : store.queuedInputs(operation.sessionId).filter((item) => item.state === "queued" && !queuedGoalId(item.reason));
    const next = goalStopped || active.holdGoalControl ? undefined : (waiting.find((item) => item.mode === "interrupt")
      ?? (state === "completed" && !active.controller.signal.aborted ? waiting[0] : undefined));
    if (next) {
      try {
        const handed = store.handOff({ id: operation.id, owner, state, details }, next.id);
        this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: handed.previous });
        this.launch(handed.operation, handed.owner, typeof handed.input === "string" ? undefined : handed.input, handed.request);
        this.publishInputs(operation.sessionId, handed.operation.id);
        return handed.previous;
      } catch (cause) { pauseReason = `The next turn could not start: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
    try {
      const terminal = store.updateOperation(operation.id, owner, state, details, pauseReason);
      if (!active.holdGoalControl) store.releaseSession(operation.sessionId, owner);
      this.publish({ type: "operation", sessionId: operation.sessionId, operationId: operation.id, operation: terminal });
      if (store.queuedInputs(operation.sessionId).length) this.publishInputs(operation.sessionId, operation.id);
      return terminal;
    } catch (cause) {
      this.publish({ type: "host_error", sessionId: operation.sessionId, operationId: operation.id, message: String(cause) });
      throw cause;
    } finally { if (!active.holdGoalControl) store.releaseSession(operation.sessionId, owner); }
  }

  async wait(operationId: string): Promise<SessionOperation> {
    const active = this.active.get(operationId);
    if (active) return active.done;
    this.options.store.recoverOperations();
    const operation = this.options.store.getOperation(operationId);
    if (!operation) throw new SessionOperationError("not_found", "operation not found");
    if (!terminalOperationStates.has(operation.state)) throw new SessionOperationError("busy", "operation is owned elsewhere");
    return operation;
  }
  cancel(operationId: string): boolean {
    const active = this.active.get(operationId);
    if (!active) return false;
    active.controller.abort(); active.agent?.abort(); return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
    await Promise.allSettled([...this.goalControls.values()].map(item => item.promise));
    this.observers.clear();
  }
}
