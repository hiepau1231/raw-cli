import type { SessionOwner, SessionStore } from "../sessions/store.js";
import type { GoalActor, GoalCommand, GoalRequest, GoalDefinition, GoalReceipt, GoalState } from "./contract.js";
/** User/host facade. Live hosts must pause and settle their AgentSession before edits/clear. */
export class GoalService {
  constructor(private readonly options: {
    store: SessionStore;
    sessionId: string;
    owner?: SessionOwner;
    defaultMaxRequests?: number;
  }) { }
  state(): GoalState { return this.options.store.getGoalState(this.options.sessionId); }
  get() { return this.state().goal ?? undefined; }
  command(request: GoalRequest, actor: GoalActor = "user"): GoalReceipt { return this.options.store.commandGoal(this.options.sessionId, request, actor, this.options.owner, this.options.defaultMaxRequests); }
  private submit(action: GoalCommand, clientRequestId: string, expectedRevision: number) { return this.command({ clientRequestId, expectedRevision, command: action }); }
  start(definition: GoalDefinition, id: string, revision: number) { return this.submit({ action: "start", definition }, id, revision); }
  pause(id: string, revision: number) { return this.submit({ action: "pause" }, id, revision); }
  resume(id: string, revision: number) { return this.submit({ action: "resume" }, id, revision); }
  edit(definition: GoalDefinition, id: string, revision: number) { return this.submit({ action: "edit", definition }, id, revision); }
  setBudget(budget: {
    tokenBudget?: number | null;
    maxRequests?: number;
  }, id: string, revision: number) { return this.submit({ action: "setBudget", ...budget }, id, revision); }
  complete(id: string, revision: number) { return this.submit({ action: "complete" }, id, revision); }
  clear(id: string, revision: number) { return this.submit({ action: "clear" }, id, revision); }
  abandon(id: string, revision: number) { return this.submit({ action: "abandon" }, id, revision); }
}
