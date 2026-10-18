# Native Goal runtime qualification

## Status

Native Goal implementation is complete through `b2cd250`; independent cumulative implementation review is APPROVE. AC-1 through AC-6 are proven. AC-7 remains open until qualification requirements are satisfied. The full local browser gate has completed with reproduced baseline failures; the six-job remote OS/Node matrix has been configured but has not been executed for these local commits. This report does not assert full-suite green or cross-platform qualification.

## Scope and runtime contract

Base: `e6d6d62`. Core, SDK, CLI and dashboard share the SQLite SessionStore lifecycle. Native Goal is explicit opt-in through `builtin/goal` / `native-goal-kit`; coding-kit v1 remains the existing tracker. No publication, version bump, push or PR changes were performed.

Completion requires recorded evidence for every required criterion. Evidence records a model/host claim, not independently certified test execution. Request/token budgets stop between provider invocations and tool admissions; in-flight requests can exceed a threshold. Missing usage stays unknown, and explicit resume retains counters. Crash recovery pauses unfinished work and never starts inference automatically.

## Phase commits

| Phase | Main commit | State |
| --- | --- | --- |
| 1 — lifecycle/storage | `8c0cc14` | AC-1 proven |
| 2 — native tool | `2995164` | AC-2 proven |
| 3 — continuation/recovery | `9271a5b` | AC-3 proven |
| 4 — SDK/live CLI | `b5ff80a` | AC-4 proven |
| 5 — dashboard | `7678d1e` | AC-5 proven |
| 6 — opt-in package | `d9ce952` | AC-6 proven |
| 7 — installed E2E/CI harness | `1fc5740` | Local flows proven; standard-environment CI qualification remains |
| Cumulative review repair | `b2cd250` | All review findings closed |

Repair commits following the phase commits are included in the reviewed cumulative range. There was no material scope change.

## Independent reviews

| Checkpoint | Session / round | Verdict |
| --- | --- | --- |
| Phase 1 | review-impl-20261017-001 / 2 | APPROVE |
| Phases 2–3 | review-impl-20261017-002 / 3 | APPROVE |
| Phases 4–6 | review-impl-20261017-003 / 6 | APPROVE |
| Cumulative `e6d6d62..b2cd250` | review-impl-20261017-004 / 2 | APPROVE |

The cumulative review accepted and closed three additional findings: live budget reduction during approval, orphaned SDK Goal recovery through idle budget commands, and user-role provenance for truncated autonomous continuation. Direct and delegated handlers now recheck canonical eligibility after asynchronous gates; idle recovery and receipt commit atomically after original CAS validation; typed continuation audit is projected into system context after compaction/reopen. The reviewer independently passed 5 targeted regression tests and two storage-failure probes. Review approval covers implementation correctness, not completion of the global qualification gates.

Earlier checkpoint findings were also fixed: lifecycle capacity headroom, incomplete usage finalization, owner recovery, post-tool heartbeat fencing, ordinary read/error compatibility, resumed steering delivery, live resumed CLI controls, editor CAS and step preservation, durable Goal association, and successor handoff fencing. All checkpoints have an external approval; none is represented as self-review approval.

## Installed entrypoint evidence

The installed E2E packs the host, installs it into a temporary consumer without source/tsx, packs/removes the native package author source, installs/binds that artifact, then launches the installed CLI and dashboard against a deterministic local SSE provider.

On `b2cd250`, the complete installed E2E passed within `npm test` (parent duration 182.673 s, including package installation):

- Explicit start: two natural final-response cycles, actual sentinel append, required evidence and canonical `complete`; 3 requests, input 24/output 6, coverage 3/3, sentinel exactly `x`.
- Kill after sentinel tool result commits: passive reopen reports paused/interrupted/approximate with zero requests before explicit resume. Resume retains usage and completes on request 4, input 32/output 8, coverage 4/4. Sentinel remains `x`, with one committed effect result.
- Installed dashboard Chromium: explicit UI start, two natural finals, sentinel and complete with evidence; reload retains canonical completion.
- Artifact SHA-256: `f7a0e4761dccac112d681785fb65d85fb156cc4e4d6e091f22ac4d5f42e316bd`; Node v24.16.0, Windows x64, Chromium 153.0.8010.12.

Affected storage/tool/runtime/SDK/CLI/API/queue/lifecycle/usage verification passed 137/137, zero skips, 35.327 s. Build/typecheck/diff passed. Regression tests first failed semantically before the production repairs.

## Global gates on b2cd250

| Command | Exit | Seconds | Result |
| --- | ---: | ---: | --- |
| npm run typecheck | 0 | 15.126 | Passed |
| npm test | 1 | 342.622 | 1270 pass / 23 baseline failures / 20 existing skips |
| npm run test:overhead | 0 | 1.227 | Passed |
| npm run test:package | 1 | 81.849 | 3 pass / 1 baseline symlink EPERM failure |
| npm run test:web | 1 | 1598.818 | 1008 pass / 41 baseline failures / 4 existing skips; native Goal 12/12 |
| git diff --check | 0 | 0.035 | Clean |

Runtime source remained unchanged throughout qualification. Documentation-only handoff changes do not extend these results to another runtime implementation.

## Baseline and remaining qualification

Archived `e6d6d62` full `npm test`: exit 1, 563.846 s; 1167 pass, 28 fail, 20 existing platform skips /1215. It uses the same dependencies and only the same cleanup-only workspace fixture repair. Current `npm test`: 1270 pass, 23 fail, 20 existing platform skips /1313; all 23 failure labels and root error codes/syscalls/assertions also occur on baseline: 17 symlink EPERM, five existing foundation CLI timeout assertions, one setup-evaluation ENOENT/open. No current-only full-test failure was found.

The cleanup repair moves failing workspace symlink setup inside try/finally so its server closes on EPERM. It does not skip the test or turn the existing failure green. Package qualification likewise retains its pre-existing symlink EPERM failure.

The earlier complete browser candidate (`78629ed`) ran all 1053 scenarios: 1007 pass, 42 fail, 4 existing skips; all 12 native Goal scenarios passed across Chromium/Firefox/WebKit. Repeating the failed cases on archived baseline reproduced 38; four required further comparison. These are diagnostic evidence, not final runtime qualification. The final full browser result and follow-up comparisons are recorded below.

Final full browser run completed on 2026-10-18 against unchanged runtime `b2cd250`: exit 1, 1598.818 s, **1008 pass / 41 fail / 4 existing skips /1053**, with all **12 native Goal scenarios passing** across Chromium/Firefox/WebKit. The earlier interrupted run ended near scenario 949 without a terminal summary and is not counted as a passing gate; the replacement completed and recorded its exit code. A short detached-shell encoding diagnostic was also stopped and preserved before the UTF-8 run.

All 41 final failure cases were reproduced on the archived baseline with the same browser engine. The first comparison matched 37, then original-case repeats reproduced two additional workspace path failures. Two remaining timing failures required matching the load:

- Chromium step duration: baseline's complete original side-panel-layout file with 3 workers produced the same expected `2m` / actual `3m` assertion (13 pass, 1 fail, 76.060 s). The fixture timestamps are assigned at module import; its running step's displayed duration advances while the suite runs. No assertion or production code was changed for this check.
- WebKit stream completion: three original scenarios run concurrently on baseline all exceeded the existing 30 s test timeout at `streamDone`, waiting for Stop count 0 while it remained 1 (3 fail, 35.679 s). The test's inner wait is 60 s while the encompassing test is 30 s. Isolated repeats passed on both implementations, around 24 s each.

The additional current reruns passed all 6 Chromium cases; WebKit passed 3/4 with the remaining workspace-root path assertion also reproduced on baseline. Names alone were not used as the oracle: failing assertion sites, EPERM/syscall, path expectations, duration values and timeout behavior were inspected. These reproductions justify baseline exceptions, not a claim that the full suite is green.

Machine-readable gate, review and acceptance results are retained in [native-goal-runtime-results.json](native-goal-runtime-results.json).

CI preserves Ubuntu/macOS/Windows × Node 22.13.0/24 and adds native Chromium smoke plus a full Ubuntu Chromium/Firefox/WebKit job. These remote jobs have not run for the local implementation; publication/push/PR modification was outside authorization. AC-7 remains not done where standard-environment/cross-platform qualification is still required.

## Reproducibility and local logs

Commands run from the repository root: `npm run typecheck`, `npm test`, `npm run test:overhead`, `npm run test:package`, `npm run test:web`, `git diff --check`. Test failures were preserved. No test was loosened or skipped to hide a qualification failure.

Local detailed logs and machine-readable results are under `.cross-review/spikes/native-goal-runtime/`: `final-results.json`, `final-*.log`, `final-baseline-comparison.json`, `final-browser-comparison.json`, `baseline-web-*.log`, `unmatched-*.log`; RED/GREEN evidence is `final-review-red2.log` / `final-review-green.log`, and affected suite evidence is `final-repair-affected.log`. The directory is ignored local review evidence and is not part of the distributed package.
