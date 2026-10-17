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

In an ordinary run without attached continuation, inspecting a missing/paused/terminal goal or receiving a goal-tool diagnostic does not stop unrelated work. Only a successfully committed native complete/block mutation triggers standalone terminal dispatch cancellation.

## SDK and terminal controls

The SDK exports GoalDefinition, GoalSnapshot, GoalCommand, GoalReceipt and GoalService. A persistent AgentSession selecting builtin/goal supports runGoal(definition), resumeGoal(), getGoal(), pauseGoal() and queueUserInput(input, clientRequestId?). Ordinary run() never activates a stored goal. Queuing a message is not consent or an implicit resume. SDK steering does not require a config file; unbound messages can be delivered by the owning agent, not launched as independent config-based turns.

Start explicitly with `raw --agent coder --goal "Implement and verify the fix"`, optionally `--goal-token-budget 100000`. Resume explicitly with `raw --resume SESSION_ID --goal-resume`. Start and resume flags are exclusive; the token flag belongs to start. `raw sessions goal SESSION_ID --json` reads canonical state without running a provider.

In the REPL, native `/goal status|start TEXT|pause|resume|edit TEXT|budget N|clear|abandon` is available only when builtin/goal is selected. `/goal budget none` removes a token cap after a warning about unknown usage. Definition edits and destructive controls pause and settle the active work first and do not resume automatically. During a native run, commands are read immediately and ordinary text is durably queued. Already queued `yes` cannot answer a later approval. Explicit responses to a current approval/question still belong to that reader. Pipe EOF does not interrupt a one-shot goal; SIGINT cancels it and cleanup does not wait for more input.

Native one-shot exit codes: 0 complete, 3 request cap, 4 paused/token/no-progress, 5 blocked, 130 user cancel/abandon, 1 runtime error, 2 invalid input. A clean ordinary run is not proof the goal completed; ordinary exit behavior is unchanged.

Commands typed while SessionStart is settling are retained and drained when the authorized native run starts; they are not lost in the REPL buffer or used as later approval responses.

For an already constructed persistent `agent` whose selected registry includes `builtin/goal`:

```ts
const running = agent.runGoal({
  objective: "Implement and verify the requested fix",
  criteria: [{ id: "verified", label: "Acceptance checks have evidence" }],
  tokenBudget: 100000,
});
agent.queueUserInput("Prefer a minimal diff", "steering-1");
// During the run, a user control can await agent.pauseGoal().
const result = await running;
console.log(result.goal?.snapshot?.status, result.goal?.stopReason);
// Resume only following another explicit user action: await agent.resumeGoal().
```


## Dashboard native controls

Native Goal is separate from legacy panels. Select `builtin/goal` explicitly; the composer metadata reports `nativeGoal: true` only for that selection. `GET /api/sessions/:id/goal` is passive and returns `{ revision, goal }`, including a revisioned `goal: null` tombstone after clear. Ordinary snapshots and the `goal` SSE frame carry the same canonical state; older revisions must never restore a cleared/replaced goal. Foreign-process writes are readable but not controllable here.

`POST /api/sessions/:id/goal/commands` accepts `{clientRequestId, expectedRevision, command}` under the existing dashboard authorization. Commands are start/resume/pause/edit/setBudget/complete/clear/abandon. Start and resume atomically persist a Goal receipt linked to one operation, then launch that operation once. Duplicate payloads return the original receipt even after the run ends; changed payloads conflict and stale revisions do not stop or alter work. A failed runtime attachment pauses the accepted Goal instead of leaving it apparently running.

Live pause/edit/budget/clear/abandon/complete serialize on the owning host: validate revision first, stop and settle work under the same fenced lease, then commit the requested change. Edits remain paused and reset criteria/evidence while retaining cumulative usage. While controls settle, other mutations answer busy. A different process cannot stop a live host in this version (no IPC). Stopped Goal operations never hand queued input to a new run, including when their ordinary run result says completed. Plain composer text is steering, not approval and not implicit resume. The UI shows criteria/evidence as recorded claims, usage coverage, elapsed approximation, stop reason and activity/approval separately from lifecycle. Removing a token cap requires an explicit warning/confirmation.


## Choose tracker or runtime (opt-in package)

`examples/packages/coding-kit` v1 remains a portable panel tracker. It does not continue after final responses. No config, starter, session or panel is migrated automatically. For host-owned bounded continuation, install the separate `examples/packages/native-goal-kit`, which selects `builtin/goal` and requires `raw.goal/1`:

```sh
raw package pack examples/packages/native-goal-kit --out native-goal-kit.rawpkg
raw package install native-goal-kit.rawpkg --as native-goal --config CONFIG
raw agent add native-coder --from pkg/native-goal/agents/coder --model LOCAL_MODEL --config CONFIG
raw --config CONFIG --agent native-coder --goal "Complete the acceptance checks"
raw --config CONFIG --resume SESSION_ID --goal-resume
```

The recipient supplies the model/provider and keeps its existing default agent. Packing records builtin references, not checkout paths or a second Goal tool. Exporting an agent that selects `builtin/goal` also declares `raw.goal/1`. A host without that capability rejects the native package explicitly. Selecting native and legacy tools under the same visible name `goal` is an error; choose one. Ordinary SDK/CLI/ACP runs do not start or resume native autonomy merely because the tool is selected. ACP has no native Goal controls in this release; use SDK, CLI or dashboard for explicit lifecycle controls. Removing the native package/tool does not erase canonical Goal audit or migrate it into a panel.

Native `--goal-resume` keeps the session's saved agent unless `--agent` is explicitly supplied, including when `--config` is present. A different default agent in that config does not silently replace the native agent. Ordinary (non-native) resume/config override behavior is unchanged.

Explicit resume releases steering paused for that same Goal, including messages waiting when the previous run stopped. Delivery is recorded exactly once through UserPromptSubmit/history; hook-blocked messages and unrelated ordinary paused messages are not retried. Live CLI start/resume launches do not occupy the control-command queue for the run lifetime: status and subsequent pause/clear/abandon remain live.

Dashboard definition drafts submit the revision captured when the editor opened, not a later SSE revision. A stale draft stays open after a conflict; cancel/reopen to reconcile with canonical state. Saving an objective-only edit preserves unchanged steps' IDs and details while resetting progress/evidence as documented. Removed/replaced step labels do not inherit another step's instructions.

Native steering is associated with its Goal when enqueued, including paused SDK input. The association stays in the existing host-owned queue reason through cancel/requeue/recovery and is fenced again at delivery. Explicitly starting a replacement Goal never consumes the old Goal's steering. This is not an extra state store or automatic input handoff; ordinary queue semantics and hook-blocked state remain unchanged.

Recovery pauses an interrupted Goal's queued input under the same fenced transaction. Native steering is excluded from automatic ordinary-turn successor selection, with a second transactional handoff guard. An explicitly submitted ordinary turn after recovery does not authorize an additional steering turn or resume the Goal.

Handler admission rechecks canonical native Goal status and budget after asynchronous approval and PreToolUse gates, including delegated handlers. Granting tool permission does not raise the Goal budget. An idle host budget command recovers an interrupted Goal as paused/interrupted under its fenced transaction; cap removal alone does not resume work. Native output-limit continuations use durable typed host notices in system context, not user-role messages, and remain available after compaction/reopen. Ordinary output-limit behavior is unchanged.
