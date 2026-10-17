import { GoalError, transitionGoal, type GoalContext, type GoalModelCommand, type GoalSnapshot, type GoalState, type GoalWrites } from "./contract.js";
/** One native tool call's write window. Reading and staging never mutate canonical state. */
export class GoalCall {
  private closed = false;
  private staged: GoalWrites | undefined;
  readonly context: GoalContext;
  constructor(private readonly read: () => GoalState, private readonly signal?: AbortSignal) {
    const assertOpen = () => { if (this.closed || this.signal?.aborted)
      throw new GoalError("goal_scope_closed", "the goal tool handler has settled or was cancelled"); };
    this.context = Object.freeze({
      get: () => { assertOpen(); return structuredClone(this.staged?.goal ?? this.read().goal ?? undefined); },
      command: (command: GoalModelCommand) => {
        assertOpen();
        const before = this.staged ? { revision: this.staged.goal.revision, goal: this.staged.goal } : this.read();
        const after = transitionGoal(before, command, "model");
        if (!after.goal)
          throw new GoalError("forbidden", "model cannot clear a goal");
        const expectedRevision = this.staged?.expectedRevision ?? before.revision;
        after.goal.revision = expectedRevision + 1;
        this.staged = { expectedRevision, goal: after.goal };
        return structuredClone(after.goal);
      }
    });
  }
  close(): void { this.closed = true; }
  settle(success: boolean): GoalWrites | undefined {
    this.close();
    if (!success || this.signal?.aborted) {
      this.staged = undefined;
      return undefined;
    }
    if (this.staged && this.read().revision !== this.staged.expectedRevision) {
      this.staged = undefined;
      throw new GoalError("stale_revision", "goal changed while the tool was running");
    }
    return this.staged ? structuredClone(this.staged) : undefined;
  }
  rollback(): void { this.close(); this.staged = undefined; }
}
