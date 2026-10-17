# Native Goal runtime qualification

## Status

Implementation is present through runtime repair `5fdb026`. Qualification is **not complete**: Phase 6 re-verification, final cumulative review, final Global Gates and the complete browser matrix are pending. No full-suite or cross-platform approval is claimed.

## Scope and oracle

Base: `e6d6d62`. Native Goal is explicit opt-in; coding-kit v1 is retained. No publication, version bump, automatic restart execution, daemon, delegation or native ACP controls.

`tests/goal-e2e.test.ts` packs the host, installs it into an unrelated temporary consumer without source/tsx, packs/removes/installs/binds the separate native-goal-kit, then drives installed CLI and installed dashboard with a deterministic local SSE provider. The oracle is canonical Goal state, complete required evidence, provider request captures, durable history and the sentinel file, not process exit alone.

- Start: two natural final responses, then a real sentinel append and guarded completion. Three provider calls, sentinel exactly `x`.
- Recovery: gate the next PreToolUse after the sentinel result commits; kill the installed CLI; reopen idle as paused/interrupted/approximate with zero new provider calls; explicit resume completes on call four without replaying the sentinel.
- Browser: installed host, real Chromium UI start, two natural finals, sentinel and native completion; reload retains canonical completion/evidence.
- Existing OS/Node matrix is retained, native Goal Chromium controls smoke added, full browser suite configured on standard Ubuntu with Chromium/Firefox/WebKit. Local execution does not prove the remote six-job matrix.

## Review checkpoints

| Checkpoint | Evidence | State |
| --- | --- | --- |
| Phase 1 | review-impl-20261017-001 round 2 | APPROVE |
| Phases 2-3 | review-impl-20261017-002 round 3 | APPROVE |
| Phases 4-6 | review-impl-20261017-003, six findings repaired | Re-verification pending |
| Final cumulative e6d6d62..HEAD | Not yet run | Pending |

Phase 6 repairs cover resumed steering delivery, live resumed CLI controls, editor revision capture, step-detail preservation, durable same-Goal input association and automatic ordinary-turn handoff fencing. The malformed round-3 verdict was not treated as approval; the same reviewer context is retained for re-verification.

## Focused verification already observed

- Latest storage/SDK/recovery/operations/queue/API regressions: 66/66, no skips, 23.956 s, including genuinely killed SDK ownership and direct handoff rollback. Typecheck/diff checks passed on the repaired runtime.
- Installed CLI/start/crash/reopen/resume/dashboard E2E: 5/5, 49.731 s, exit 0 on the earlier qualification candidate. Goal usage start/browser: requests 3, input 24, output 6, coverage 3/3; recovery: requests 3 before explicit resume and 4 afterward, input 32/output 8, coverage 4/4. Required evidence recorded; sentinel exactly `x`. This must be rerun on the settled runtime, not extrapolated to it.

## Initial diagnostic Global Gates (not final qualification)

| Command | Exit | Seconds | Result |
| --- | ---: | ---: | --- |
| npm run typecheck | 0 | 14.520 | Passed on initial candidate |
| npm test | 1 | 414.201 | 1258 pass, 24 fail, 20 existing platform skips /1302 |
| npm run test:overhead | 0 | 1.126 | Passed on initial candidate |
| npm run test:package | 1 | 72.867 | 3 pass, 1 fail: Windows symlink EPERM |
| npm run test:web | -1 | 804.641 | Obsolete diagnostic interrupted after source advanced; not a passing gate |
| git diff --check | 0 | 0.057 | Clean at that observation |

The workspace fixture originally attempted a privileged symlink before entering try/finally. EPERM leaked its server and kept the full test process alive. The test content matched base byte-for-byte before the cleanup-only repair. Only the verified leaked child was terminated in the diagnostic run. The committed repair moves setup into the cleanup scope: EPERM remains a failure, not a skip or a pass.

## Baseline comparison

Archived `e6d6d62` was built and exercised with the same node_modules dependency junction and only that cleanup-only harness repair. `npm test`: exit 1, 563.846 s; 1167 pass, 28 fail, 20 existing platform skips /1215. All 24 diagnostic-current failure labels also appear in this baseline; no current-only failure label was found. Error-code/syscall comparisons are retained separately in the local verification logs rather than assuming matching labels prove matching causes.

The environment cannot create privileged Windows symlinks (EPERM), affecting existing workspace, plugin, package, hook, skill, output-route and patch security tests. Contended startup timeouts and the pre-existing setup-evaluation fixture failure are also present in the baseline. No test has been skipped or converted to green to hide these outcomes. Final runs and comparisons remain required before qualification is complete.
