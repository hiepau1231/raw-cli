# Native goals

Native Goal is an opt-in runtime feature, distinct from coding-kit v1's panel tracker. Select `builtin/goal`; ordinary agents and the legacy package retain their behavior. A session has one current goal. SQLite SessionStore is authoritative; UI and tool summaries are projections.

## Lifecycle and authority

States: active, paused, blocked, complete, abandoned. Only the user/host starts or resumes autonomy, edits the definition/budget, clears or abandons. Model actions are get, update, complete and block. Models cannot weaken required criteria or mutate a paused/blocked goal. Completion requires at least one required criterion and every required criterion done with nonempty evidence. Evidence is a recorded claim, not proof a command ran.

Commands carry a clientRequestId and expectedRevision. Replays return the original receipt; reusing an ID for another payload or a stale revision is rejected without mutation. Clear retains audit history. Definition edits require a settled, paused goal, reset criteria/evidence and retain cumulative usage. Complete/abandoned goals must be cleared before a new start.

## Safety and accounting

Restart never executes a goal automatically. Permissions, approvals, hooks and session ownership remain unchanged. Pause cancels and settles in-flight work; committed external effects cannot be rolled back. Budgets are request-boundary thresholds, not hard billing caps. Requests already in flight can overshoot. Usage reported by providers counts input plus output without double-counting cache tokens or repeated streaming callbacks; missing usage is unknown, not zero. Resume retains usage.

State is limited to 64 KiB UTF-8 including reserved headroom for lifecycle/accounting growth, 50 criteria and 30 steps; labels 200 characters, evidence 300 and step details 200. Invalid input is rejected with the named limit, never silently truncated. Audit history is paginated.
