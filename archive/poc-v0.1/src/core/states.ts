export type TaskState = 'READY' | 'BUILDING' | 'VERIFYING' | 'REPAIRING' | 'ACCEPTED' | 'BLOCKED' | 'CANCELLED';
export type RunState = 'NEW' | 'PLANNING' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'ACCEPTED' | 'FAILED' | 'CANCELLED';
const runEdges: Record<RunState, RunState[]> = {
  NEW: ['PLANNING', 'CANCELLED', 'FAILED'], PLANNING: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED'],
  RUNNING: ['PAUSED', 'BLOCKED', 'ACCEPTED', 'FAILED', 'CANCELLED'], PAUSED: ['PLANNING', 'RUNNING', 'CANCELLED', 'BLOCKED'],
  BLOCKED: ['PAUSED', 'CANCELLED'], ACCEPTED: [], FAILED: [], CANCELLED: [],
};
const taskEdges: Record<TaskState, TaskState[]> = {
  READY: ['BUILDING', 'BLOCKED', 'CANCELLED'], BUILDING: ['VERIFYING', 'REPAIRING', 'CANCELLED', 'BLOCKED'],
  VERIFYING: ['ACCEPTED', 'REPAIRING', 'BLOCKED', 'CANCELLED'], REPAIRING: ['BUILDING', 'BLOCKED', 'CANCELLED'],
  ACCEPTED: [], BLOCKED: [], CANCELLED: [],
};
export function transition<S extends RunState | TaskState>(kind: 'run' | 'task', from: S, to: S, verified = false): S {
  const allowed: readonly string[] = kind === 'run' ? runEdges[from as RunState] : taskEdges[from as TaskState];
  if (!allowed?.includes(to)) throw new Error(`ILLEGAL_TRANSITION: ${kind} ${from} -> ${to}`);
  if (to === 'ACCEPTED' && !verified) throw new Error('ACCEPTANCE_REQUIRES_EVIDENCE');
  return to;
}
