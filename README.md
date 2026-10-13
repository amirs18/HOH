# HoH — built from pi-autoresearch

HoH v0.2 is a Pi-native quality experiment loop based on [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch), pinned at `04b8a50dac7efe80ffc91648bd00ed9b022e24c2` (1.9.0). The downloaded source and license are in `vendor/pi-autoresearch`; provenance and adapted modules are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The earlier POC is preserved under `archive/poc-v0.1`. Active code has **no SQLite** and no separate planner/worker/reviewer service. Pi proposes changes in its existing session; the extension measures frozen candidates and computes keep/discard. The native tool cycle, structured metric output, JSONL history, disk-based learnings and deterministic compaction come from autoresearch.

## What is deterministic

- Verifiers run against an exact commit and frozen specification/configuration/test hashes.
- Each candidate is measured three times by default, with the same seed and a minimal environment.
- HoH takes the median, enforces the configured absolute tolerance, and checks that requirement outcomes agree across repeats.
- Failed/missing backpressure checks, missing metrics, unknown or duplicate protocol values, prior-requirement regressions and untrusted verification prevent keep.
- Immutable JSON measurements plus fixed policy reproduce each decision exactly. Corrupt or forged decisions fail closed.
- Compaction reconstructs the context from those files, using the adapted upstream compaction code, without an LLM summary call.

The model's hypotheses and code edits remain nondeterministic. A fixed seed does not make arbitrary programs reproducible: the verifier must actually use it. Wall-clock measures need a reviewed tolerance. Git commit metadata and timing/artifact timestamps can differ between separate executions. The discrete seeded acceptance-score example uses zero tolerance.

## Setup

Tested with **Pi 1.1.0**, Node **24.21.0** and macOS.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run demo
npm run smoke:pi
```

`demo` creates a temporary defective Git project and runs the real engine/verifier with scripted edits. A partial improvement is kept, a higher-scoring regression is rejected, restart preserves the best revision, and a final repair reaches the goal. Every trial has repeated measurements and JSON evidence. It verifies that the user's main branch/file stayed unchanged and that context reconstruction is identical after reopening.

`smoke:pi` loads the actual extension into Pi, starts a baseline in manual mode, inspects status/evidence and pauses, without model calls. Tests additionally kill a real CLI process, recover its JSON lease/checkpoint, terminate an orphan verifier and repair in a new experiment. CI uses macOS; OS-isolation integration tests are explicitly skipped elsewhere.

## Prepare an experiment

Use a clean, committed target project with `SPEC.md`. Do not include credentials, symlinks, submodules, Git filters, or tracked `.hoh` state. HoH never stashes or commits the user's checkout.

Copy [examples/config.json](examples/config.json) to `<project>/.hoh/config.json`, then place your trusted scripts in `.hoh/evaluation/`. The example scripts are in `test/fixtures/evaluation/`. Ignore `.hoh/` in Git.

Configuration includes an objective/target, explicit source scope, requirement IDs/statements, allowlisted executables, measure and checks commands, repetitions, seed, tolerance, timeout and budgets. Commands are executable/argument arrays with `{candidate}`, `{evaluation}` and `{scratch}` placeholders; no shell interpolation occurs. Both measure and checks are required. Starting a run approves and freezes this prepared configuration and verifier assets. Changing current config affects only new runs.

The included `/skill:hoh-create` helps prepare these reviewable files before activation. It does not let the active loop weaken verifiers or restart budgets.

The measure command receives:

| Variable | Meaning |
| --- | --- |
| `HOH_CANDIDATE` | Frozen candidate worktree, read-only during verification |
| `HOH_SEED` | Fixed configured seed |
| `HOH_REPEAT` | Repetition number (do not use it to change the measured workload) |
| `HOH_ARTIFACTS` | Writable per-sample scratch/output directory |
| `PYTHONHASHSEED`, `TZ` | Seed and UTC for reproducibility |

It must exit zero after successful execution and emit:

```text
METRIC requirements_passed=1
CHECK R1=PASS
CHECK R2=FAIL
```

The primary metric name must match config. Extra numeric metrics are advisory. Decimal finite values only; duplicate, malformed, NaN/Infinity, hex and prototype-polluting names are rejected. Emit one explicit outcome for every configured requirement. A requirement failure can contribute to a partial score, but cannot count as completing the product goal.

The separate checks command must exit zero for mandatory regression/correctness checks. Configure build/type/lint checks here when appropriate. It runs after each successfully executed measure command. Do not import arbitrary candidate code into the trusted assertion process: use subprocess or black-box API checks. The fixture tests rejection of a candidate's early `process.exit(0)` and uses seeded cases.

## Native Pi loop

From the target project:

```sh
pi -e /absolute/path/to/HOH/src/extension.ts
```

Or install the local package using `pi install /absolute/path/to/HOH`. The Pi manifest includes both the extension and setup skill; nothing is published automatically.

```text
/hoh start SPEC.md
/hoh status
/hoh inspect
/hoh pause
/hoh resume
/hoh stop
```

Start measures the baseline asynchronously, creates a dedicated draft and starts the bounded loop. `--manual` on start/resume enables the tools without triggering a model call. Opening a session never resumes billing automatically; `/hoh resume` is explicit. The widget shows recent experiments and the footer shows progress.

The tool cycle is:

1. `hoh_init_experiment`: read the approved objective/checkpoint.
2. Edit only the checkpoint's absolute draft paths in the configured source scope.
3. `hoh_run_experiment`: snapshot, freeze, repeat and collect evidence.
4. `hoh_log_experiment`: supply run number, hypothesis, description, learned evidence and next focus. HoH computes the decision.

These names are prefixed so an installed upstream autoresearch package cannot collide with HoH's tools. There are no agent-supplied score/status fields. A measured result blocks further edits until logged. Repeated log calls are idempotent. Discard leaves the failed draft for inspection and gives the next experiment a fresh worktree from the verified best commit, preserving user changes rather than resetting/cleaning them.

**Keep means measured progress. COMPLETED means the product goal passed.** Improvements must exceed `minImprovement`; ties are discarded. Satisfying all requirements plus the configured target can close a previously incomplete goal. Already verified requirements may not regress, even when the headline metric improves. Iteration and no-progress budgets block further work; an agent that produces no experiment activity receives only bounded continuation nudges before pause.

## JSON database

```text
.hoh/
  config.json                 # reviewed input for the next run
  evaluation/                 # trusted verifier source
  current.json                # active run pointer
  lease.json                  # single-writer PID/birth identity/heartbeat
  runs/<id>/
    run.json                  # immutable spec/config/baseline/hashes
    state.json                # atomic resumable checkpoint
    prompt.md                 # durable objective, from the original spec
    ideas.md                  # derived learnings/next-focus memory
    log.jsonl                 # derived autoresearch-compatible history
    evaluation/               # frozen verifier copy
    experiments/0000/
      measurement.json        # immutable repeated evidence
      decision.json           # immutable policy verdict + observations
      candidate.diff
      sample-1/               # invocation, stdout, stderr, scratch artifacts
  worktrees/<id>/<number>/     # editable drafts (all preserved)
  evaluation-worktrees/...    # frozen tested commits
```

JSON records are the database, not a mirror of SQLite. Writes fsync temporary files and atomically publish them. Decisions bind measurement hashes. Replay rechecks hashes and recomputes policy rather than trusting a checkpoint or display log to invent keep decisions. JSONL is a human-readable history/cache; damaging its tail cannot change decisions. Context uses canonical JSON records.

Resume validates worktrees and frozen assets, reconciles committed decisions, and kills recorded orphan process groups. Interrupted measurement is logged as a failed experiment; it is never promoted to success. A measured-but-unlogged result can be logged after restart without rerunning the builder. PID/birth-identity leases prevent concurrent measurement/log writers. A crash during the rare stale-lease recovery guard itself can require inspecting/removing the empty `.hoh/recovery.guard`; the extension fails closed rather than guessing ownership.

## CLI and adoption

The same engine is usable without a model:

```sh
node /path/to/HOH/dist/cli.js start SPEC.md --repo /path/to/project
node /path/to/HOH/dist/cli.js status --repo /path/to/project
# Edit the printed draft, then:
node /path/to/HOH/dist/cli.js run --repo /path/to/project
node /path/to/HOH/dist/cli.js log 1 "First hypothesis" --repo /path/to/project
node /path/to/HOH/dist/cli.js inspect --repo /path/to/project
node /path/to/HOH/dist/cli.js pause --repo /path/to/project
node /path/to/HOH/dist/cli.js resume --repo /path/to/project
```

`stop` cancels; `context` prints the deterministic recovery context. `npm run hoh -- ...` runs the source CLI. The CLI does not introduce a separate agent daemon; it is a measurement/recovery interface for the native loop.

After inspecting completed evidence, adopt manually:

```sh
git merge --ff-only refs/hoh/<run-id>/best
```

The private best ref can point to partial progress during a run; check `COMPLETED` and the decision evidence before adopting a final deliverable. HoH performs no automatic merge or push.

## Trust and remaining limits

During active native mode, programmatic tool guards and the enabled-tool set confine the model to scoped `read`/`edit`/`write` operations. Shell, codemode, MCP, unknown tools, metadata, verifier files, old drafts, and out-of-scope paths are blocked. This is capability enforcement, not just a prompt. Evaluated candidate code runs under macOS OS filesystem restrictions with no forwarded credentials or network access; tests/state and frozen source are unwritable. Normal verifier process groups are terminated on exit/timeout/cancellation.

The Pi host, installed extensions, operator and verifier definitions remain trusted. Native model tools share the trusted Pi process; this is not the old POC's separate OS-sandboxed worker design. Untrusted plugin code or hostile daemonization needs stronger process/container containment. Protected tests are not advertised as hidden from candidate code during evaluation. Custom verifier exit semantics must actually check behavior. Dependency installation and browser lifecycle are left to reviewed, self-contained verifiers.

Only macOS verifier isolation is implemented: other platforms fail closed for keep. No live-model autonomous smoke was billed/run, so actual model behavior remains unverified; scripted edits, real verification/recovery, adapter tests and actual Pi command loading/baseline were demonstrated. Multi-provider orchestration, subjective reviewer acceptance, cloud dashboards, arbitrary hooks and production deployment are outside this rewrite.

See [HOH_AUTORESEARCH_SPEC.md](HOH_AUTORESEARCH_SPEC.md) for the revised scope and [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for measured outcomes.
