# HoH autoresearch rewrite — v0.2

## Starting point

Downloaded `https://github.com/davebcn87/pi-autoresearch` from GitHub, pinned to
`04b8a50dac7efe80ffc91648bd00ed9b022e24c2` (upstream package 1.9.0).
The downloaded original is preserved in `vendor/pi-autoresearch`, with its license
and provenance manifest. JSONL reconstruction, session-path helpers, deterministic
compaction and structured METRIC parsing were adapted directly from its source.
The native Pi experiment-tool cycle, disk rehydration and hypothesis memory are
retained; attribution is in `THIRD_PARTY_NOTICES.md`.

The original implementation is preserved in `archive/poc-v0.1`, including source,
tests, examples, original reports, package metadata and lockfile. The original
`HOH_PI_EXTENSION_SPEC.md` remains unchanged. The revised direction is documented
in `HOH_AUTORESEARCH_SPEC.md`.

## Changes from the first POC

- Native Pi experiment loop replaces separate planner/worker/reviewer orchestration.
- Atomic JSON files are the database; there is no SQLite import in active source.
- Immutable measurements/decisions are authoritative. JSONL is the readable history,
  not an unchecked acceptance channel.
- Agent tools cannot supply metric values or keep/discard status. Frozen verifier
  output, repeatability, mandatory checks and deterministic policy determine them.
- Fixed seed, repeated measurements, median, explicit tolerance and stable requirement
  outcomes replace subjective confidence as the keep gate.
- Partial improvements are retained without claiming completion. Final completion
  requires target attainment and every requirement, and prior verified requirements
  cannot regress.
- Deterministic compaction reconstructs objective, scope, file paths, hypotheses,
  learnings and evidence from persisted files without an LLM summary call.
- Fresh worker worktrees preserve discarded code for inspection. No reset/clean or
  automatic merge/push touches the user's checkout.

## Actual verification

Environment: Pi **1.1.0**, Node **24.21.0**, macOS.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 29 tests passed across 4 files; final suite 29.47 seconds |
| Upstream JSONL/compaction tests (`node --experimental-strip-types --test …`) | 13 passed |
| `npm run demo` | Passed; partial keep → regression rejection → restart → completed repair |
| `npm run smoke:pi` | Actual Pi loaded the extension and ran start/manual baseline, status, inspect and pause; zero model calls |
| `npm audit --json` | Zero vulnerabilities |

The tests exercise real Git commits/worktrees, file persistence, frozen verifier
commands, OS isolation, repeated measurements and policy. They cover malformed and
duplicate metrics, missing checks, unstable outcomes, prior regressions, metadata
and unknown-tool restrictions, exact evidence binding, forged keep decisions,
idempotent logging, corrupt display-cache recovery, cancellation/timeouts, actual
CLI SIGKILL/orphan cleanup, and native adapter compaction. Upstream experiment
tools are also blocked during HoH mode, preventing collisions with a concurrently
installed autoresearch package.

## Recorded demo

Repository: `/var/folders/4s/4jspqmvd4wbc32y28y09v2dw0000gn/T/hoh-v2-QVCIQM`

Run: `e8d1bbdc-c742-4ab9-addf-22de83527f6f`

| Experiment | Decision | Score | Meaning |
| --- | --- | --- | --- |
| 0 | keep | 0 | Repeatable defective baseline; goal not complete |
| 1 | keep | 1 | Positive additions repaired; signed/zero requirement still fails |
| 2 | checks_failed | — | Higher measured acceptance score rejected because multiplication regressed |
| 3 | keep | 2 | Both requirements and regression pass; state COMPLETED |

Each valid candidate was measured three times with seed 42 and zero allowed score
spread. Final commit: `235986442610f2dde61c0fb6cf4822fc81c3fbef`.
The main branch and defective user-checkout file were unchanged. A restarted engine
preserved the best partial revision, and a measured result was logged after reopening
without rerunning edits. Fresh reconstruction returned the same context text.

Evidence directory:
`/private/var/folders/4s/4jspqmvd4wbc32y28y09v2dw0000gn/T/hoh-v2-QVCIQM/.hoh/runs/e8d1bbdc-c742-4ab9-addf-22de83527f6f/experiments/0003`

It contains `measurement.json`, `decision.json`, the candidate diff, and per-repeat
command/stdout/stderr evidence. `.hoh/demo.json` summarizes the run. These temporary
files remain available locally; use `npm run demo` to regenerate them elsewhere.

## Limits

Deterministic verification/aggregation/decisions/replay do not make LLM-generated
edits deterministic. The native model's autonomous behavior has not been exercised
with a billed provider; scripted edits plus real Pi command and adapter integration
are the demonstrated coverage.

Verifier isolation currently requires macOS `sandbox-exec`. Unsupported platforms
cannot keep a baseline/candidate; OS integration tests are explicitly skipped there.
Native model tools are confined by programmatic capability guards in the trusted Pi
host. This is a different trust boundary from the old POC's separately sandboxed
worker process. Installed plugin code, operator configuration and verifier definitions
remain trusted; hardened containers/hostile daemon containment are not implemented.

Protected verifiers are not advertised as hidden during candidate evaluation.
Meaningful custom subprocess/API assertions are required. Dependency provisioning,
browser lifecycle, external dashboards, arbitrary hooks, production deployment and
multi-provider orchestration are outside this rewrite. A crash inside the narrow
stale-lease recovery-guard window can require manual inspection of the guard; normal
SIGKILL/restart recovery was demonstrated. Original worktrees and discarded edits
are preserved and not automatically cleaned up.
