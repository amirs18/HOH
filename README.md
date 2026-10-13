# HoH for Pi — v0.1

HoH supervises small coding tasks using separate planning, building, and review sessions. A builder's completion message has no authority: controller-owned acceptance and regression checks evaluate a frozen Git commit, and only verified commits advance a private integration ref. Runs, attempts, findings, decisions, and evidence survive process restart in SQLite.

Implemented against **Pi 1.1.0**, package **`@earendil-works/pi-coding-agent`**, on Node **24.21.0** / macOS. The specification's `@mariozechner/pi-coding-agent` name is obsolete for this installation. See the installed package's `docs/extensions.md`, `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, and extension type declarations. Upstream references: [extensions](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md), [RPC](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md).

## Install and verify

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run demo
npm run smoke:pi
```

`demo` creates a temporary, deliberately defective Git project. A deterministic fake model first produces incorrect addition, then repairs it after a real acceptance failure. Git, SQLite, subprocesses, OS isolation, and the verifier are real. It prints the repository, run ID, both SHAs, and evidence paths; reopening the database and resuming accepted work does not dispatch another builder. The fixture verifier executes candidate code in a separate subprocess so `process.exit(0)` cannot bypass its assertions.

`smoke:pi` starts actual Pi 1.1.0 with `-e ./src/extension.ts`, checks command registration through RPC, and invokes `/hoh status`. It uses no model calls or credentials. Tests also run the entire CLI loop through deterministic JSONL model processes and kill a real controller process to exercise recovery.

Acceptance currently requires macOS `sandbox-exec`. Other operating systems and nested environments that prohibit sandboxing fail closed with `UNTRUSTED`, before dispatching any agent. Portable unit/fail-closed tests still run there; isolation-dependent integration tests are explicitly skipped. CI uses macOS.

## Configure a project

Use a **clean, committed Git project** with its spec inside the project root. HoH refuses dirty baselines and does not initialize, stash, reset, clean, or commit the user's checkout. The HoH implementation repository itself initially has no baseline commit; use the provided temporary fixture to try it without changing this checkout.

```sh
npm run fixture
```

The last line is the temporary project path. Its `.hoh/config.json` is copied from [examples/defective-config.json](examples/defective-config.json), and its protected verifiers live in `.hoh/evaluation/`. Adapt the runner's `args` to select your provider/model and `inheritEnv` to explicitly name the credential environment variables to pass. For example, set `args` to `["--provider", "openai", "--model", "YOUR_MODEL_ID"]` and `inheritEnv` to `["OPENAI_API_KEY"]`. No user's Pi auth directory, settings, extensions, MCP servers, skills, or shell environment is mounted into worker sessions. OAuth credential-directory forwarding is not implemented.

Each configured evaluator is an executable plus an argument array. No shell interpolation occurs. Its executable must appear in `allowlistedExecutables`. `{candidate}`, `{evaluation}`, and `{scratch}` are substituted as individual argument values. Verifiers run from the run's private copy of `.hoh/evaluation`; relative script paths therefore refer to that directory. Environment variables:

| Variable | Purpose |
| --- | --- |
| `HOH_CANDIDATE` | Read-only worktree of the exact candidate commit |
| `HOH_EVALUATION` | Immutable snapshot of protected verifier assets |
| `HOH_ARTIFACTS` | Writable output directory; captured into immutable evidence after the check |

Screenshots, traces, JSON results, and other outputs written to `HOH_ARTIFACTS` are collected (100 files / 50 MB total / 10 MB each; no symlinks). Stdout, stderr, invocation, diff, and `evaluation.json` are always recorded. Known environment values and credential patterns are redacted from text logs/artifacts. Treat screenshots and compressed binary results as potentially sensitive evidence.

All mandatory checks must pass. Acceptance and regression suites are always required. Missing build/typecheck/lint configurations are explicitly `NOT_CONFIGURED` and advisory; configure them as mandatory when the project needs them. Acceptance verifiers must cover the contract's requirement IDs. Future-slice acceptance checks are deferred; the current slice and every previously accepted requirement are verified again. Regression checks run on every candidate. The final release gate requires coverage of **all** requirements, including normal-priority requirements.

The default `planApproval: "manual"` pauses after planning. Inspect `.hoh/runs/<id>/plan/plan.json`, approve its exact contract hash, then resume. This is needed because a Markdown-to-contract model translation cannot prove that it preserved every acceptance criterion. `planApproval: "configured-requirements"` enables automatic planning only with controller-owned authoritative `requirements`; the planner must preserve each one exactly and provide real verifiers. The original Markdown and hash remain persisted. Blocking product decisions pause the run; resolving them currently requires stopping and starting with a revised spec.

`allowSnapshotCommit` defaults to false. Set it to true to authorize controller-created commits of worker edits. Workers cannot access shared Git metadata; the controller snapshots their index into commits without altering the worker HEAD or user branch. A fresh worktree/context is used for each repair and receives prior failure output and implementation diff.

Conservative bounds default to three attempts per task, ten total builder iterations, one structured-output retry, and five minutes per operation. Stagnation invokes one separate diagnostician; further stagnation blocks. Token/cost budgets use reported Pi session statistics, fail closed when required usage is unavailable, and are checked between jobs. An in-flight job can overshoot a usage budget; these are not provider billing caps. Elapsed-time, attempts, limits, usage availability, and blockers appear in status.

## Pi commands and CLI

From the target project, load this extension with an absolute path:

```sh
pi -e /path/to/HOH/src/extension.ts
```

The package also declares the `pi.extensions` manifest. To add this local package through Pi, use `pi install /path/to/HOH`. No publishing is performed.

```text
/hoh start SPEC.md
/hoh status
/hoh inspect
/hoh pause
/hoh approve-plan <contractHash>
/hoh resume
/hoh stop
```

The extension responds immediately to start/resume, runs orchestration asynchronously, emits UI notifications (RPC supported), and shows a compact TUI footer. Shutdown interrupts current children and leaves the run resumable. Headless contexts receive a custom status message.

The same operations are available without the Pi UI:

```sh
node /path/to/HOH/dist/cli.js start SPEC.md --repo /path/to/project
node /path/to/HOH/dist/cli.js status --repo /path/to/project
node /path/to/HOH/dist/cli.js inspect --repo /path/to/project
node /path/to/HOH/dist/cli.js pause --repo /path/to/project
node /path/to/HOH/dist/cli.js resume --repo /path/to/project
node /path/to/HOH/dist/cli.js stop --repo /path/to/project
```

Start/resume launch a detached local controller. `--wait` keeps it in the foreground and prints final status. From this repository, `npm run hoh -- ...` runs the TypeScript CLI. CLI output is JSON and excludes credentials and raw spec/config. Control requests are durable: pause lets the current bounded operation finish, while stop aborts children. Status may briefly show a pending control request before the owner processes it.

SQLite uses WAL, migrations, normalized records and transactional state/events. A unique active-run index prevents conflicting starts. PID + process birth identity + a durable heartbeat lease prevent duplicate dispatch. Resume kills recorded orphan process groups before reconciling attempts. Interrupted attempts consume their original attempt budget, and unfinished evaluations never become accepted during recovery. Completed accepted tasks are preserved. Verification configuration and assets are frozen per run; editing the current `.hoh/config.json` affects only new runs.

Blocked runs are terminal for automatic work; inspect the evidence, stop the blocked run, fix its cause, and start anew. Worktrees and user edits are retained on stop. They are not automatically garbage-collected.

After acceptance, inspect `REPORT.md` and adopt the private ref manually from a clean checkout:

```sh
git merge --ff-only refs/hoh/runs/<run-id>/accepted
```

If your branch has diverged, review and cherry-pick the accepted commits yourself. HoH does not merge into user branches or push.

## Trust boundary and scope

The operator, configured runner executable, controller installation, and verifier definitions are trusted. Spec text, project code, and agent responses are untrusted. macOS profiles allow worker writes only in the assigned worktree, deny shared `.git` and protected paths, and exclude controller state and verifier directories. Planner/reviewer/diagnostician workspaces allow writes only to session scratch. Evaluators can read the frozen source and verifier snapshot, and write only to bounded scratch. Their process groups are killed after execution, timeout, or cancellation. Protected asset hashes and candidate cleanliness are checked before acceptance.

Builders have `read`, `edit`, and `write` tools. **Builder shell tooling is deliberately disabled in this MVP**; approved executable tooling is run by the controller. Read-only sessions use `read`, `grep`, `find`, and `ls`. Worker sessions disable resource discovery, MCP, built-in extensions and context-file discovery. Only explicitly configured API credential variables reach Pi, and scratch HOME/agent paths are forced. The default runner launches the pinned Pi package directly, avoiding terminal wrapper extension injection.

These profiles demonstrate filesystem boundaries; they are not a hardened VM or defense against OS sandbox vulnerabilities. Tests are protected, not advertised as secret. Their sources are unavailable to builder tools, but evaluated candidate subprocesses inherit the verifier's read permissions. Do not import arbitrary candidate code into a trusted assertion process: use a subprocess or black-box API verifier, as the fixture does. A configured command returning zero is only as meaningful as its trusted verifier. An LLM reviewer provides advisory evidence of defects, not an objective certification of quality.

Symlinks, submodules, Git filters, tracked credential files (including `.env.*`), and externally rooted worktrees are rejected in v0.1. Dependency installation/bootstrap is not automated; configure self-contained controller-owned scripts and provision tooling yourself. Test processes cannot write the candidate, so builds must write outputs to scratch. No container/Linux backend, interactive ambiguity-resolution command, human finding-adjudication command, built-in Playwright app lifecycle, benchmark CMS, or automatic cleanup/deployment is implemented. Browser/security/performance/property-test commands can be configured through the evaluator interface, but no browser-specific smoke was performed.

## Optional model-backed smoke

```sh
HOH_LIVE_PROVIDER=YOUR_PROVIDER \
HOH_LIVE_MODEL=YOUR_MODEL_ID \
HOH_LIVE_INHERIT_ENV=YOUR_API_KEY_VARIABLE \
npm run smoke:live
```

This explicitly configured run can incur model charges and uses separate Pi planner/builder/reviewer sessions. It leaves its fixture and evidence available for inspection. The implementation environment had no explicitly supplied API-key variables or selected live model; the actual Pi load/RPC smoke and deterministic model-process loop were run, but a billed live-model repair run was not.

See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for measured outcomes and [the CMS benchmark guide](examples/git-cms/benchmark-guide.md) for the next experiment.
