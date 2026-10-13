import type { Task } from './schemas.js';
import type { TaskState } from './states.js';
export type TaskRecord = Task & { state: TaskState; attempts: number; acceptedSha?: string; diagnosisUsed?: boolean; repair?: string };
export function nextTask(tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find(t => ['READY', 'REPAIRING'].includes(t.state) &&
    t.dependencies.every(id => tasks.find(t => t.id === id)?.state === 'ACCEPTED'));
}
