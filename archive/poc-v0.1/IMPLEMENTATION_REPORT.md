# Implementation report — 2026-10-13

Implemented a runnable HoH v0.1 slice against **Pi 1.1.0**, **Node 24.21.0**, and macOS. The initial repository contained only `HOH_PI_EXTENSION_SPEC.md` and an empty Git history. The spec was preserved; no implementation changes were committed or published.

## Delivered behavior

- Thin Pi `/hoh` adapter with start/status/inspect/pause/resume/stop and contract-hash approval; compact TUI status and RPC/headless handling.
- Standalone CLI with detached or foreground supervision and recovery across processes.
- Zod-validated, versioned contract/task output, authoritative requirement preservation, dependency validation, and manual approval for Markdown-only translations.
- SQLite WAL/migration, normalized required tables, transactional transitions/acceptance/events, active-run uniqueness, durable PID/birth-identity leases and child tracking.
- Documented Pi JSONL subprocess protocol, strict LF framing, request IDs, `agent_settled` lifecycle, malformed-output handling, deadlines, aborts, stderr capture and usage reporting.
- Separate worker worktrees, controller-authorized snapshot commits, frozen evaluation worktrees, private accepted refs, exact SHA/contract/verifier bindings, protected-path integrity checks, and immutable evidence.
- Mandatory acceptance/regression/requirement coverage, independent structured review, fresh repair contexts, bounded budgets, one diagnostic on stagnation, fail-closed isolation, and safe pause/stop/restart.
- Actual macOS filesystem sandboxing, deliberately narrow worker tools, redacted bounded logs, captured evaluator artifacts, defective arithmetic fixture, CMS benchmark spec/contract/protocol/summary script, and macOS CI workflow.

## Actual commands and results

`npm ci --ignore-scripts` is the documented reproducible setup; dependency installation was performed with `npm install --ignore-scripts`, producing `package-lock.json`.

| Command | Observed result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | Passed: 41 tests across 5 files; final suite duration 70.19 seconds |
| `npm run demo` | Passed; first commit rejected, second accepted; reopen/resume dispatched no extra builder |
| `npm run smoke:pi` | Actual Pi 1.1.0 loaded `src/extension.ts`, registered `hoh`, returned `/hoh status` notification through RPC; zero model calls |
| Default `PiRpcRunner` in macOS sandbox without credential forwarding | Pi initialized and returned its documented missing-API-key command error; no model run occurred |
| Sample config and CMS contract schema validation | Passed |
| `npm audit` | Zero vulnerabilities |

The suite uses real controller logic, Git, SQLite, evaluator commands and filesystem isolation with deterministic models. It includes a detached CLI controller using actual JSONL model subprocesses, real SIGKILL/recovery with orphan cleanup, repeated-failure budgets/diagnosis, sequential slices and prior-requirement regressions, critical reviewer repairs, protected-path tampering, timeouts, malformed/truncated RPC, automatic retry settlement, cancellation, dirty baselines, unavailable isolation, and credential/redaction boundaries. Isolation-dependent integration tests are explicitly skipped outside macOS; they were executed here.

## Recorded demonstration

Repository: `/var/folders/4s/4jspqmvd4wbc32y28y09v2dw0000gn/T/hoh-test-VnycV9`

Run: `4618c212-024a-4c10-90fa-204d2117808c`

| Revision | Result |
| --- | --- |
| Baseline `866d91aa934905415128e5ba83a42e842ffbf9c4` | Intentionally defective `add(a,b) = a-b` |
| Attempt 1 `586ab9380df0b5ca1b73dd175164b9063d8b85a4` | REJECT; trusted acceptance fails (`add` returns 42) |
| Attempt 2 `15543d185882d37ae494801d0d6658c875d0549b` | ACCEPT; acceptance, regression, integrity, isolation and separate review all pass |

The run ended `ACCEPTED` after two attempts in approximately 3.8 seconds. The baseline main branch and defective user-checkout file were unchanged. The database was closed, reopened, inspected and resumed with no additional builder call.

Evidence: `/private/var/folders/4s/4jspqmvd4wbc32y28y09v2dw0000gn/T/hoh-test-VnycV9/.hoh/runs/4618c212-024a-4c10-90fa-204d2117808c/artifacts/44d5dfc6-d51e-45ae-a8c5-5d72eb983770/evaluation.json`

The same directory holds command records, stdout/stderr, and the exact diff. `.hoh/demo-result.json` records both attempts and final status; `.hoh/runs/<id>/REPORT.md` links the evidence. Temporary fixture files remain locally available, but another machine must regenerate them with `npm run demo`.

## Honest limits

Milestones A and B are implemented and demonstrated. The core C quality loop is demonstrated with deterministic planner/builder/reviewer/diagnostic sessions. D includes benchmark preparation and a real Pi load/RPC smoke, **not a billed live-model repair run**. No `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` environment variable, nor a live provider/model selection, was supplied. Existing personal OAuth files were not copied into workers. `npm run smoke:live` is provided for an explicitly configured model run.

Only macOS `sandbox-exec` is implemented as an isolation backend. Unsupported or prohibited sandbox environments cannot accept or dispatch model work. Profiles enforce demonstrated filesystem restrictions; they do not claim VM-level security. Verifier definitions and operator configuration remain trusted. Protected tests are not advertised as hidden from candidate code during evaluation. Custom verifiers must use subprocess/API assertions and meaningful exit semantics; the fixture explicitly tests rejection of a candidate's premature `process.exit(0)`.

Builder shell tooling, dependency bootstrap, container/Linux isolation, live contract revision/ambiguity resolution, human review adjudication, automatic worktree cleanup, and built-in browser app startup/teardown are not implemented. Browser/security/performance/property gates can be custom executable verifiers; no Playwright-specific live smoke or CMS implementation was run. Symlinks, submodules, Git filters and tracked credential files are outside the MVP and rejected. Token/cost limits are enforced between jobs using reported usage, not as hard in-flight billing caps. Cancellation cleans recorded process groups; hostile daemonization is not a hardened container containment guarantee.

User branches are never merged or pushed automatically. Adoption is an explicit manual Git operation after inspecting the recorded evidence.
