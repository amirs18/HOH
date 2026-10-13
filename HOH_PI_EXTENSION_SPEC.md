# HoH — Harness of Harnesses for Pi

**Status:** Implementation specification (MVP v0.1)  
**Primary implementer:** Codex  
**Language:** TypeScript / Node.js  
**Target:** Pi coding-agent extension plus a small, durable local controller  
**Purpose:** Turn a high-level product goal into a demonstrably high-quality, working software deliverable through repeated independent evaluation and repair.

## 0. Codex execution instruction

Implement this specification in the current repository. First inspect the repository and the **installed Pi version and its official extension/RPC interfaces**. Do not invent API methods. Use the official `@mariozechner/pi-coding-agent` APIs corresponding to the installed version, or adapt imports if the installed package has changed. Document any incompatibility.

Work incrementally, but finish a **runnable vertical slice**, not only scaffolding. Run tests and perform an end-to-end demonstration with a deliberately defective sample project. Report precisely what works and what remains incomplete. Do not declare success based only on successful compilation. If the repository already contains relevant code, reuse it; do not overwrite unrelated work.

Do not silently broaden the MVP into a general multi-provider platform, distributed scheduler, graphical dashboard, or cloud service. Respect hard security and approval boundaries below.

## 1. Product problem and success criteria

Many coding-agent workflows produce software that compiles, but is incomplete, inconsistent, poorly designed, or broken in realistic user journeys. HoH must **optimize independent evidence of product quality** instead of agent activity or self-reported completion.

HoH accepts a specification, asks a worker Pi instance to implement the next valuable vertical slice, and then evaluates that result independently. It either accepts the exact implementation revision or creates a bounded, actionable repair/redesign task. It persists all decisions, findings, artifacts, and status so that work can resume safely.

**MVP success:** Given a small example repository with a failing acceptance test and a spec requiring the behavior, `/hoh start SPEC.md` causes HoH to (a) create a work plan, (b) run a Pi worker in a Git worktree, (c) run an independently controlled test suite, (d) provide failure evidence and trigger one or more repairs, (e) mark a revision accepted only after all mandatory checks pass, and (f) allow `/hoh status`, `/hoh stop`, and `/hoh resume` across process restart. Use fake agents for deterministic automated tests and real Pi for an optional integration smoke test.

### Non-goals for v0.1

- No autonomous production deployment, publishing, payments, or remote repository mutation.
- No general-purpose swarm of agents or role hierarchy.
- No hosted service, SaaS dashboard, Kubernetes, Redis, or message bus.
- No guarantee that an LLM reviewer can objectively certify product quality.
- No user-approval bypasses for hazardous operations.
- No implementation of the Git-inspired CMS itself inside this extension.

## 2. Architecture and trust boundaries

```text
Interactive Pi process
  └─ HoH extension (thin UI/command adapter)
      └─ HoH controller (Node/TS, durable state machine)
          ├─ Product/spec compiler (Pi in isolated planning session)
          ├─ Task scheduler (deterministic)
          ├─ Worker runner (separate Pi process; writable Git worktree)
          ├─ Evaluation pipeline
          │    ├─ deterministic tests (controlled by controller)
          │    ├─ browser tests, when configured
          │    └─ separate Pi review session (read-only inputs)
          ├─ Repair policy (deterministic decisions + optional planning)
          └─ SQLite state + immutable evidence records
```

**Hard boundary:** The worker may modify its assigned project worktree, but **must not be able to write the HoH state database, evaluation definitions, protected tests, or supervisor configuration**. Mere prompt instructions do not enforce this. For the MVP, materialize protected acceptance tests in a separate controller-owned evaluation directory and run them against the candidate revision; prefer OS/container isolation and narrow filesystem permissions. If hard isolation is unavailable, declare the workspace untrusted and fail closed for acceptance (or explicitly mark verification `UNTRUSTED`, which cannot satisfy the release gate). Prevent worker tools from reading hidden test sources if such tests are advertised as hidden. Do not mount secrets or the controller state into the worker execution environment.

**Git rule:** Every evaluation is bound to a specific commit SHA plus the spec/evaluation version. No task is accepted based on unstaged edits. Use distinct worktrees for workers. HoH must never reset, clean, force-push, or rewrite the user's working tree. Require a clean project baseline or explicit isolated setup before starting.

**Process rule:** Spawn Pi as a child process using **the documented Pi RPC interface** (JSONL) for long-lived, bidirectional control. Provide a replaceable `AgentRunner` interface so tests do not require model access. The extension itself must remain responsive; orchestration should not monopolize the Pi session event loop. RPC framing, stdout event parsing, stderr, timeouts, aborts, exit codes and child cleanup must be handled correctly. Do not treat assistant prose as a reliable machine protocol.

## 3. Public user interface

Implement Pi extension commands, using `pi.registerCommand` according to the installed API:

| Command | Behavior |
|---|---|
| `/hoh start <path-to-spec>` | Validate spec, verify repository/baseline, create project run, show run ID, start supervised execution. Refuse conflicting active run. |
| `/hoh status` | Show run/task state, current revision, last gate results, elapsed work, attempts, budget, blockers, and next action. |
| `/hoh inspect` | Show evidence and actionable findings for the most recent evaluation; include artifact file paths. |
| `/hoh pause` | Stop dispatching new work; let the current operation finish safely, or record an interrupted state. |
| `/hoh resume` | Recover an interrupted/paused run using durable state, validating worktree and revision first. |
| `/hoh stop` | Cancel running children, persist cancellation, safely release resources; never delete user changes. |

Support `ctx.ui.notify` and compact footer status using documented Pi UI APIs; degrade gracefully in headless contexts. Commands must not assume a TUI exists. Include a terminal CLI entrypoint (`hoh ...`) exposing the same controller operations for reliable automated tests and recovery if the host Pi process dies.

Configuration file: `.hoh/config.json` in the *controller-owned project root*, validated by Zod. Defaults must be conservative. Config must include runner command/options, worktree root, evaluator commands, allowlisted executables, timeout, maximum attempts/task, maximum total iterations, and optional token/cost budget when reliable usage metadata is available. Credentials are inherited only through explicitly configured environments; never log them.

## 4. User-provided product specification

Input is an ordinary Markdown file (`SPEC.md`). The product compiler produces **versioned, machine-readable** contracts, approved by schema validation, rather than requiring users to write rigid JSON by hand.

Example output model:

```ts
type Requirement = {
  id: string;
  statement: string;
  priority: 'critical' | 'high' | 'normal';
  acceptanceCriteria: string[];
  verificationIds: string[];
  dependencies: string[];
};

type ProductContract = {
  schemaVersion: 1;
  sourceSpecHash: string;
  productGoal: string;
  constraints: string[];
  requirements: Requirement[];
  unresolvedDecisions: Array<{
    id: string;
    question: string;
    impact: 'blocking' | 'nonblocking';
    recommendedDefault?: string;
  }>;
};
```

The planning output must never be auto-accepted if it changes externally provided acceptance criteria. The supervisor may expand verifications, but cannot quietly delete or weaken user requirements. Blocking product ambiguities should pause and request a decision; nonblocking implementation choices get documented defaults. Persist the original spec hash and every subsequent contract revision.

Task decomposition favors **end-to-end vertical slices** that can be tested in isolation. A task must specify requirement IDs, implementation scope, dependencies, objective checks, and exit criteria. The planner cannot mark tasks accepted.

## 5. Agent roles and interfaces

Use only these roles in v0.1, with separate sessions and contexts:

1. **Planner:** Converts spec to an explicit contract and ordered vertical-slice tasks. No permission to modify project code or tests.
2. **Builder:** Implements a single planned task. Can edit project code only inside its dedicated worktree and may run approved project tooling. Returns code changes and a proposed commit SHA; cannot accept its own task.
3. **Reviewer:** Receives the spec, relevant implementation diff, and evidence; returns structured *specific* findings (severity, location, reproduction, requirement impact). Read-only, separate session. Its subjective verdict cannot override a failed deterministic gate.
4. **Diagnostician:** Optional invocation only after repeated failures or ambiguous defects; returns a root-cause hypothesis and bounded repair strategy. No unchecked authority over acceptance gates.

```ts
interface AgentRunner {
  execute(input: AgentJob, options: { signal: AbortSignal }): Promise<AgentJobResult>;
}

type AgentJob = {
  runId: string;
  taskId: string;
  role: 'planner' | 'builder' | 'reviewer' | 'diagnostician';
  cwd: string;
  instructions: string;
  contextFiles: string[];
  timeoutMs: number;
  readOnly: boolean;
};

type AgentJobResult = {
  exitCode: number | null;
  output: string;
  structured?: unknown; // Validate by role-specific Zod schema.
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  artifacts: string[];
};
```

All structured outputs use validation and bounded retries for malformed responses. Capture usage metrics when Pi exposes them, but do not fabricate cost estimates.

## 6. Controller state machine

```ts
type TaskState =
  | 'READY' | 'BUILDING' | 'VERIFYING' | 'REPAIRING'
  | 'ACCEPTED' | 'BLOCKED' | 'CANCELLED';

type RunState =
  | 'NEW' | 'PLANNING' | 'RUNNING' | 'PAUSED'
  | 'BLOCKED' | 'ACCEPTED' | 'FAILED' | 'CANCELLED';
```

Flow:

1. Load and validate config + spec; create durable run and baseline ref.
2. Compile product contract and tasks. Save revisions and unresolved decisions.
3. Select a READY task whose dependencies are accepted.
4. Create isolated worktree from current accepted integration revision.
5. Invoke builder with relevant context and failure history.
6. Require a valid candidate commit SHA (create a controlled snapshot commit if required and explicitly permitted); capture diff.
7. Evaluate exact SHA: deterministic checks first, independent reviewer after required checks; save all evidence.
8. If hard gates pass and mandatory review findings are resolved, advance accepted revision and mark task ACCEPTED atomically.
9. Otherwise persist findings, create a repair iteration using a fresh or appropriately reset worker context, and repeat within limits.
10. If repeated repair attempts stagnate, try a fresh diagnostic/replan once; on continued failure mark BLOCKED with a human-readable report. Never silently count a blocked task as done.
11. When all critical and high-priority requirements and release gates are satisfied, mark the run ACCEPTED with a final report. Otherwise label the result partial/blocked.

Ensure each state transition is recorded transactionally and illegal transitions are rejected. Crash recovery must not simultaneously dispatch duplicated workers. Use a run-level lock and worker process tracking; detect stale locks using PID + durable lease semantics where appropriate. The system should be restart-safe, with reconciliation of unfinished worktrees and child processes. Never silently move to ACCEPTED during recovery.

## 7. Evaluation engine (the core product)

Every result MUST include `candidateSha`, `contractHash`, `evaluationConfigHash`, check outcomes, evidence paths and timestamps.

### Mandatory mechanical gates

- Build/typecheck/lint as configured; report `NOT_CONFIGURED` explicitly rather than pretending success.
- Acceptance tests tied to requirement IDs, executed from a trusted evaluation environment.
- Regression suite on every candidate to protect previously accepted requirements.
- Git/diff integrity: no changes to prohibited files or acceptance criteria; no secrets in logs.
- Test timeout, signal, and process exit handling; a crashed evaluator is an error, never a pass.

### Optional but supported gates

- Playwright E2E against an explicitly started local app, with screenshots, traces and bounded waits.
- Property-based tests (e.g. branching/merging invariants for the CMS benchmark).
- Structured architecture/maintainability review.
- Security and performance checks configured per project.

```ts
type CheckResult = {
  id: string;
  requirementIds: string[];
  status: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_CONFIGURED';
  mandatory: boolean;
  exitCode?: number;
  durationMs: number;
  summary: string;
  evidencePaths: string[];
};

type Finding = {
  id: string;
  category: 'functional' | 'regression' | 'security' | 'architecture' | 'ux' | 'operational';
  severity: 'critical' | 'high' | 'medium' | 'low';
  requirementIds: string[];
  description: string;
  reproduction?: string;
  evidencePaths: string[];
  proposedFix?: string;
};
```

Acceptance policy:
- Any mandatory FAIL, ERROR, or NOT_CONFIGURED => reject.
- Critical/high reviewer findings with concrete evidence => reject pending repair or explicit human adjudication.
- Reviewer praise, confidence ratings, or a test count can never compensate for failed hard gates.
- Scores for UX/maintainability are advisory in v0.1 unless the user explicitly configures measurable thresholds.
- Require actual verification for every requirement designated mandatory by the contract; no acceptance by unchecked assertion.
- The reviewer and builder cannot modify acceptance policies or protected verifier assets.
- Detect unchanged failure signatures and lack of diff progress; trigger diagnosis instead of infinite retry.

Store machine-readable `evaluation.json`, command/stdout/stderr logs, exact SHA, diff summary, test results, and review findings in a controller-owned artifacts directory. Redact credentials and bound log size. Each final acceptance claim must link to its concrete evidence.

## 8. Git and isolation rules

- Never operate directly on the user's dirty working directory.
- `git worktree add` under `.hoh/worktrees/<run>/<task>/<attempt>` (or outside repo if required to keep access boundaries).
- Use a controller-owned integration ref, such as `refs/hoh/runs/<run>/accepted`, that advances **only after verified acceptance**.
- Evaluator executes a frozen revision; no changes to candidate during evaluation.
- Isolate execution via container/restricted OS process if available. If absent, do not claim a security isolation guarantee; fail closed if protected test integrity cannot be assured.
- Prevent arbitrary shell command interpolation: spawn using executable and arg arrays rather than constructing unsanitized shell strings. Enforce per-command timeouts and process-group cleanup.
- Protect `.git`, controller DB, secrets, benchmark fixtures, acceptance policy, and trusted test source paths.
- Do not auto-merge into user branches or push remotely. Provide an explicit manual adoption procedure when accepted.

## 9. Persistence and artifacts

SQLite in `.hoh/state.sqlite` for local v0.1 (outside worker-mounted paths). Use WAL and migrations. Tables at minimum:

- `runs`: ID, repo root, baseline SHA, spec hash, state, created/updated, config.
- `contracts`: version, source hash, JSON, created.
- `requirements`: ID, contract version, priority, status.
- `tasks`: ID, run ID, dependencies, state, accepted SHA, attempt count.
- `attempts`: ID, task ID, worker type, start/end, candidate SHA, exit outcome, failure fingerprint.
- `evaluations`: ID, attempt ID, candidate SHA, contract/evaluation hashes, decision, summary.
- `checks`, `findings`, `artifacts`, `events`.

State changes and decisions must be atomic. Use a durable event log for audit/debugging (event rows in SQLite suffice), not as an excuse to build event-sourcing infrastructure.

## 10. Project file layout

```text
hoh-pi/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts          # default export registers Pi commands
│   ├── cli.ts                # headless CLI
│   ├── core/
│   │   ├── controller.ts
│   │   ├── states.ts
│   │   ├── planner.ts
│   │   ├── scheduler.ts
│   │   ├── policy.ts
│   │   └── schemas.ts
│   ├── agents/
│   │   ├── runner.ts
│   │   ├── pi-rpc-runner.ts
│   │   └── prompts/
│   ├── evaluation/
│   │   ├── evaluator.ts
│   │   ├── command-check.ts
│   │   ├── reviewer.ts
│   │   └── artifacts.ts
│   ├── infra/
│   │   ├── database.ts
│   │   ├── worktrees.ts
│   │   ├── process.ts
│   │   └── locks.ts
│   └── ui/status.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/defective-app/
├── examples/
│   └── git-cms/
│       ├── SPEC.md
│       ├── contract.example.json
│       └── benchmark-guide.md
└── README.md
```

Keep package names and import paths aligned with verified Pi package versions. Package must load via `pi -e ./src/extension.ts` in development and expose a compatible `pi.extensions` manifest for installation. Do not publish automatically.

## 11. Git-inspired CMS benchmark

The CMS is an external test project used to assess HoH quality. It has collections, typed JSON documents, branches, commits, merging, read APIs, an admin UI, and audience experiments. **Do not build all these CMS features as part of the initial HoH MVP.**

Use progressive benchmark slices:

| Stage | Behavior | Verification emphasis |
|---|---|---|
| CMS-1 | Create collection/schema, CRUD document through API | Completeness and integration |
| CMS-2 | Fork main into beta; edits/deletes on beta do not affect main | Branch isolation |
| CMS-3 | Immutable commits, diff, nonconflicting merge, conflicts | Data integrity and algorithmic behavior |
| CMS-4 | Browser admin UI for editing, branching and merge | Real UX and end-to-end behavior |
| CMS-5 | Serve pinned branch revisions to stable experiment cohorts | Cross-cutting correctness |
| CMS-6 | Authorization, concurrency and deploy smoke test | Operational readiness |

For CMS-2 property tests, generate random sequences of `createDocument`, `updateDocument`, `deleteDocument`, `forkBranch`, and `readDocument`. Assert that mutations on beta never change the previously observed main snapshot. Test branch isolation through API and persistence, not only object copies in memory. For CMS-3 test merge-base selection, changed-on-one-side, same-change-on-both-sides, delete/update conflicts, and schema conflicts. For CMS-5 use deterministic visitor assignment and pin experiment variants to immutable commits.

A full CMS is not required to prove v0.1. The initial deterministic fixture should be **much smaller**, with an intentionally failing test that a worker can fix. The CMS specification and benchmark guide must be included so a subsequent experiment can compare plain Pi against Pi + HoH under equivalent model/budget constraints.

## 12. Automated tests required for HoH

Unit tests:

1. State machine rejects illegal transitions and unauthorized acceptance.
2. No acceptance when any required check fails/errors/is missing.
3. Reviewer cannot override deterministic failures.
4. Progress and retry budgets terminate on repeated identical failures.
5. Contract schema rejects malformed task dependencies and duplicate IDs.
6. Agent runner handles malformed JSONL, child exits, aborts, and timeouts.
7. Redaction removes known secret values from artifacts.

Integration tests (use fake `AgentRunner`):

1. A worker's first output fails the trusted acceptance test; the next output fixes it; only the second SHA is accepted.
2. A worker reports "done" but breaks an existing test; task stays unaccepted.
3. A reviewer reports a supported critical bug; the controller creates a repair task.
4. Controller process interruption followed by `resume` does not duplicate work or lose state.
5. Worker attempts to edit protected verification files; attempt is rejected with evidence.
6. An evaluator process times out; result is ERROR, not PASS.
7. A paused/stopped run terminates children and leaves user branch unchanged.
8. Running `/hoh status` and `/hoh inspect` works during and after a run.

Live Pi smoke test (documented, optional in CI): execute `pi -e ./src/extension.ts`, start a tiny fixture run with configured credentials and Pi runner, demonstrate status/evidence, and exit cleanly. CI must remain deterministic without external LLM billing.

## 13. Milestones and implementation priority

**Milestone A — Working extension + state:** Pi command registration, CLI, config validation, SQLite, state transitions, status. Provide tests.

**Milestone B — Execution + deterministic evaluation:** Pi RPC adapter, worktree manager, controller-owned checks, artifact capture, rejection/acceptance. Prove it with fake workers and a defective app.

**Milestone C — Quality loop:** Separate reviewer, failure-to-repair planning, regression checks, bounded retries, diagnosis-on-stagnation, resume/stop cleanup.

**Milestone D — Benchmark preparation:** CMS specification, benchmark scripts, documented comparison protocol. Show at least one genuine Pi-in-the-loop smoke run if the environment permits.

Codex should finish as many milestones as it can responsibly verify, but must prioritize a complete, working A+B vertical slice over skeleton implementations for all four. If a capability is not implemented, mark it explicitly in README and final report.

## 14. Definition of Done for the extension

All of these must be demonstrated:

- Pi loads the extension and registers expected commands.
- A local run starts from a supplied Markdown spec with a persisted ID and consistent status.
- A worker executes in an isolated Git worktree rather than the user's active branch.
- Trusted evaluator runs on an exact candidate SHA, records evidence, and cannot be bypassed by a builder's claim.
- Failing required checks cause rejection and at least one automated repair attempt; repaired code can eventually be accepted.
- Attempt limits and cancellation reliably stop work.
- Pause/restart/resume preserves accepted history and does not duplicate completed tasks.
- An evaluation cannot be marked PASS with missing/unconfigured required checks.
- Tests run without external model credentials using a fake worker.
- README documents setup, extension installation, usage, limitations, trust boundaries and honest security assumptions.

**Deliverables:** Source, lockfile, tests, example SPEC, sample configuration, README, benchmark description, and a brief `IMPLEMENTATION_REPORT.md` with actual command/test outcomes and known limitations.

## 15. Engineering constraints and coding style

- Prefer small typed modules, explicit domain state, pure decision functions, and dependency injection for `AgentRunner`, `Evaluator`, `Store`, `Clock`, and process/Git operations.
- Avoid clever generic frameworks, unnecessary inheritance, mutable global singletons, and loosely typed agent-generated JSON.
- Use structured logging and stable error identifiers; keep raw model output out of the trusted control plane until validated.
- Treat user-supplied spec/repo text and model output as untrusted; never elevate their instructions over the supervisor's security policies.
- Protect against accidental infinite autonomous execution with bounded retries, run budgets and explicit cancellation.
- Prefer Bun/Vitest or Node/Vitest compatible with installed Pi runtime; document the exact tested environment.
- Do not create fake green tests. Tests must execute real controller logic, even when the model backend is simulated.

## 16. References to check during implementation

- Pi extension API: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md`
- Pi RPC mode: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md`
- Pi SDK: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md`

Verify against the **actual current repository/package version** before relying on a method or command. Upstream interfaces may evolve.

---

### Final instruction to Codex

Make the smallest reliable HoH that demonstrates a *real independent quality-driven development loop*. Resist feature creep. Do not call it finished until a broken example project is repaired by the worker, independently evaluated, accepted at a recorded SHA, and the run can be inspected and resumed after restart. When something cannot be proven in the current environment, state exactly why and show the closest deterministic test.
