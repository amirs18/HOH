# Plain Pi versus Pi + HoH

Start with the tiny arithmetic fixture, then CMS-1. This repository does not implement a CMS or provide completed CMS verifiers. The sample contract contains a placeholder source hash: compile the real stage-specific spec and approve its contract. Write and freeze independent API/persistence tests before either comparison arm runs.

For each stage, give both arms identical clean baseline commits, Markdown specs, model/provider/thinking settings, token or measured cost budgets, operation time limits, and dependency tooling. HoH uses separate sessions; count planner, builder, reviewer, diagnostic and retry usage in its totals. Plain Pi's independently executed final verification is also required. Do not compare HoH's internal test count to the other arm's self-reported completion.

1. Create distinct local repositories from the same baseline. Do not share state or worker credentials.
2. Freeze the acceptance and regression suite outside worker workspaces; record its hash. Run the suite on the known defective baseline to prove it rejects the intended defect.
3. Run plain Pi with the chosen spec and budget; snapshot its deliverable to a commit and execute the protected suite against that SHA.
4. Configure HoH's authoritative requirements, acceptance checks and regression suite. Run HoH using the same provider/model and comparable total budget. Save `.hoh/runs/<id>/REPORT.md`, evaluations and usage metadata.
5. Repeat with several seeds/orderings; keep failures, timeouts and blocked runs in the results. Record actual billable usage when available, otherwise use null and label it unavailable.
6. Compare mandatory requirement pass rates, regressions, attempts, elapsed time, supported review defects, costs and manual interventions. An untrusted verification result cannot count as a pass.

For CMS-2, property generators should produce API calls (`createDocument`, `updateDocument`, `deleteDocument`, `forkBranch`, `readDocument`) over persistent branches. Capture the main snapshot before beta mutations; assert exact equality through API and a restart. Never use an in-memory object-copy test as the sole branch-isolation proof. For CMS-3 include merge-base selection and all conflict cases from the spec. For CMS-5 pin immutable commit IDs and test visitor assignment deterministically.

Browser verifiers should own application startup, bounded readiness checks and teardown, put screenshots/traces under `HOH_ARTIFACTS`, and return nonzero on any failed journey. They are custom evaluator scripts in v0.1. Model review is supplementary; keep severity and concrete reproduction evidence, not numerical confidence scores.

`scripts/benchmark-summary.ts RESULTS.json` validates and summarizes comparison records. A record must contain `arm`, `stage`, `candidateSha`, `trusted`, `mandatoryPassed`, `mandatoryTotal`, `elapsedMs`, `attempts`, and nullable `tokens`/`costUsd`. Run it with `node --import tsx`; it performs no model calls and does not fabricate missing metrics.
