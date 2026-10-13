import type { RunRecord } from '../infra/database.js';
import type { Evaluation } from '../core/schemas.js';
export function publicStatus(run: RunRecord | undefined, evaluation?: Evaluation) {
  if (!run) return { state: 'NO_RUN', nextAction: 'hoh start SPEC.md' };
  const elapsedMs = run.elapsedMs + (run.state === 'RUNNING' ? Math.max(0, Date.now() - Date.parse(run.updatedAt)) : 0);
  return { runId: run.id, state: run.state, control: run.control, baselineSha: run.baselineSha,
    acceptedSha: run.acceptedSha, candidateSha: evaluation?.candidateSha, contractHash: run.contractHash,
    tasks: run.tasks.map(t => ({ id: t.id, title: t.title, state: t.state, attempts: t.attempts, acceptedSha: t.acceptedSha })),
    lastGate: evaluation && { decision: evaluation.decision, summary: evaluation.summary }, elapsedMs,
    iterations: run.iterations, maxTotalIterations: run.config.maxTotalIterations, maxAttemptsPerTask: run.config.maxAttemptsPerTask,
    usage: run.usageAvailable ? { tokens: run.tokens, costUsd: run.costUsd } : 'NOT_AVAILABLE',
    tokenBudget: run.config.tokenBudget, costBudgetUsd: run.config.costBudgetUsd, blocker: run.blocker,
    nextAction: run.state === 'ACCEPTED' ? `Inspect evidence; manually adopt refs/hoh/runs/${run.id}/accepted` :
      run.state === 'PAUSED' ? run.blocker ?? 'hoh resume' : run.state === 'BLOCKED' ? 'Inspect findings; stop and start a new run after resolving the blocker' :
        run.state === 'CANCELLED' ? 'Preserved worktrees can be inspected manually' : 'hoh status / hoh inspect' };
}
export function footer(run: RunRecord): string {
  const task = run.tasks.find(t => ['BUILDING', 'VERIFYING', 'REPAIRING'].includes(t.state));
  return `HoH ${run.state} ${run.id.slice(0, 8)}${task ? ` ${task.id} ${task.state} ${task.attempts}/${run.config.maxAttemptsPerTask}` : ''}`;
}
