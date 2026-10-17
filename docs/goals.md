# Native goals

Native Goal is an opt-in runtime feature, distinct from coding-kit v1's panel tracker. Select `builtin/goal`; ordinary agents and the legacy package retain their behavior. A session has one current goal. SQLite SessionStore is authoritative; UI and tool summaries are projections.

## Lifecycle and authority

States: active, paused, blocked, complete, abandoned. Only the user/host starts or resumes autonomy, edits the definition/budget, clears or abandons. Model actions are get, update, complete and block. Models cannot weaken required criteria or mutate a paused/blocked goal. Completion requires at least one required criterion and every required criterion done with nonempty evidence. Evidence is a recorded claim, not proof a command ran.

Commands carry a clientRequestId and expectedRevision. Replays return the original receipt; reusing an ID for another payload or a stale revision is rejected without mutation. Clear retains audit history. Definition edits require a settled, paused goal, reset criteria/evidence and retain cumulative usage. Complete/abandoned goals must be cleared before a new start.

## Safety and accounting

Restart never executes a goal automatically. Permissions, approvals, hooks and session ownership remain unchanged. Pause cancels and settles in-flight work; committed external effects cannot be rolled back. Budgets are request-boundary thresholds, not hard billing caps. Requests already in flight can overshoot. Usage reported by providers counts input plus output without double-counting cache tokens or repeated streaming callbacks; missing usage is unknown, not zero. Resume retains usage.

State is limited to 64 KiB UTF-8 including reserved headroom for lifecycle/accounting growth, 50 criteria and 30 steps; labels 200 characters, evidence 300 and step details 200. Invalid input is rejected with the named limit, never silently truncated. Audit history is paginated.

## Native model tool

`builtin/goal` exposes get, update, complete and block only. Update addresses existing criterion/step IDs; it cannot change the objective, required flags, labels or budgets. Block requires a reason and nextAction. The scoped API expires when the handler settles. Goal writes commit atomically with their linked tool result/history and roll back on handler error, cancellation or storage failure. Native goals never create a second persisted panel document.

## Execution and recovery

Explicit start/resume continues at a natural final-response boundary inside one run. Host continuation notices are audited and projected into system context, not user messages. There is one terminal run event/Stop hook. Complete/block stops remaining tool calls with linked cancellations and does not request a closing sentence. Three final replies without actual non-goal tool work or changed progress pause with no_progress; this is only an empty-loop guard.

Request/token counters are cumulative across resume, replay and compaction. Streaming usage replaces the same request slot. Missing usage with a token cap pauses with usage_unknown after the request settles. Cap checks run before requests, compaction and tool dispatch. After the existing owner lease permits recovery, restart recovers an unfinished active goal as paused/interrupted and never calls a provider; a still-valid foreign lease continues to report busy. Elapsed time is monotonic active runtime time, includes approval/input waits, excludes paused/offline time and is approximate across a crash.

Streaming counts are provisional until the provider call returns successfully. Known provisional consumption is retained, but failed/cancelled/incomplete requests do not receive finalized usage coverage; a durable unsettled request also survives a crash. With a token cap, such missing coverage requires an explicit cap removal before resume. Recovery applies to every new idle owner claim, including host operations and queued turns after an SDK run. Native tool complete/block ends remaining dispatch even without autonomous continuation. Lease renewal continues during post-tool hooks, while elapsed-only checkpoints are coalesced until a pending native write settles.
