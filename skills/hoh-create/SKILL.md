---
name: hoh-create
description: Prepare a Pi-native HoH quality experiment with protected verifiers, a repeatable metric, fixed seed, bounded iterations, and JSON-file state. Derived from pi-autoresearch's setup workflow.
---

# Set up a HoH experiment

Infer or clarify the product goal, source scope, metric, target, and mandatory correctness requirements. Prefer a discrete acceptance score (for example verified requirements passed) over wall-clock time when the goal is product completeness.

Before activating HoH, prepare reviewable files:

1. A committed `SPEC.md` in a clean Git project. Do not commit or stash unrelated user edits.
2. `.hoh/config.json`, using the schema/example from this package. Use executable/argument arrays; require both measure and backpressure commands. List every requirement ID and its real acceptance statement. Set a target, explicit source scope, at least two repetitions, seed, absolute tolerance, iteration and no-progress limits.
3. Controller-owned `.hoh/evaluation/` scripts. The measure script receives `HOH_CANDIDATE`, `HOH_SEED` and `HOH_ARTIFACTS`, emits exactly one finite `METRIC <primary>=<number>` and one `CHECK <id>=PASS|FAIL` for every requirement, and exits nonzero on execution/protocol failure. The separate checks script exits nonzero on regression/type/build/integrity failures. Verify candidate behavior through a subprocess or API, not by trusting agent prose or importing arbitrary code into the assertion process.
4. `.hoh/` must be ignored by Git. Keep credentials out of source/worktrees. Do not change evaluator definitions during a run; new definitions require a new reviewed run.

Explain the objective, checks, threshold/tolerance, source scope and budget to the user, then have them invoke `/hoh start SPEC.md`. This command approves and freezes the prepared configuration and verifier assets. It records the baseline and creates a separate worker worktree; do not change the user's branch or reset/clean it.

During active mode use `hoh_init_experiment` to read the checkpoint, then edit only its absolute draft paths. Run one hypothesis with `hoh_run_experiment`. Always call `hoh_log_experiment` with the returned run number, description, hypothesis, learned evidence and nextFocus. Never supply a metric or keep status: the controller computes these deterministically.

A fresh session can recover with `/hoh resume`. Read the injected disk-based context; if a measurement is pending, log it before editing. Learnings and deferred ideas survive in JSON decisions, JSONL history, prompt.md and ideas.md. Stop on COMPLETED, BLOCKED, PAUSED or CANCELLED. Do not restart segments to bypass budgets.

No background hooks, publishing, remote mutations or deployment are part of this workflow. Configuration of a verifier is trusted executable code and must be reviewable before starting.
