# Native Goal runtime qualification

## Scope and oracle

Base: `e6d6d62`. Native Goal is explicit opt-in; coding-kit v1 is retained. No publish, version bump, automatic restart execution, daemon, delegation or native ACP controls.

`tests/goal-e2e.test.ts` packs the host, installs it into an unrelated temporary consumer without source/tsx, packs/removes/installs/binds the separate native-goal-kit, then drives installed CLI and installed dashboard with a deterministic local SSE provider. The oracle is canonical Goal state, complete required evidence, provider request captures, durable history and the sentinel file—not process exit alone.

- Start: two natural final responses, then a real sentinel append and native guarded completion. Three provider calls, sentinel exactly `x`.
- Recovery: gate the next PreToolUse after the sentinel result is committed; kill the installed CLI; reopen idle as paused/interrupted/approximate with zero new provider calls; explicit resume completes on call four without replaying the sentinel.
- Browser: installed host, real Chromium UI start, two natural finals, sentinel and native completion; reload retains canonical completion/evidence.
- Existing OS/Node matrix is retained, native Goal Chromium controls smoke added, full browser suite runs on standard Ubuntu with Chromium/Firefox/WebKit.

## Checkpoints

Phase 1: reviewer APPROVE, session review-impl-20261017-001 round 2.
Phases 2–3: reviewer APPROVE, session review-impl-20261017-002 round 3.
Phases 4–6: four findings reproduced and repaired (resumed steering, live resumed CLI controls, stale editor CAS, step-detail preservation); re-verification pending in review-impl-20261017-003 round 2.
Final cumulative review: pending.

## Verification ledger

Global Gates and final installed E2E are pending on the final cumulative implementation. No whole-suite or multi-platform qualification is claimed yet. Detailed commands, durations, exit codes and baseline comparisons will be recorded here after the runs.

Baseline Windows privilege limitation already independently reproduced from e6d6d62: symlink creation raises EPERM in two tool-plugin and two package-export tests. These failures are not skipped or silently converted to passing results.
