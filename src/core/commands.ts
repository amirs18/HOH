import { Controller } from './controller.js';
import { publicStatus } from '../ui/status.js';
export const verbs = ['start', 'status', 'inspect', 'pause', 'resume', 'stop', 'approve-plan'] as const;
export async function command(controller: Controller, verb: string, argument = ''): Promise<{ output: unknown; runId?: string; dispatch?: boolean }> {
  if (verb === 'start') {
    if (!argument) throw new Error('USAGE: hoh start <spec-path>');
    const run = await controller.start(argument.replace(/^(["'])(.*)\1$/, '$2'));
    return { output: publicStatus(run), runId: run.id, dispatch: true };
  }
  if (verb === 'status') return { output: publicStatus(controller.status(), controller.inspect()) };
  if (verb === 'inspect') return { output: controller.inspect() ?? { summary: 'No completed evaluation', run: publicStatus(controller.status()) } };
  if (verb === 'pause' || verb === 'stop') {
    await controller[verb](); return { output: publicStatus(controller.status(), controller.inspect()) };
  }
  if (verb === 'approve-plan') {
    await controller.approvePlan(argument); return { output: publicStatus(controller.status()) };
  }
  if (verb === 'resume') {
    const run = controller.status(); if (!run) throw new Error('NO_RUN');
    return { output: publicStatus(run), runId: run.id, dispatch: !['ACCEPTED', 'FAILED', 'CANCELLED'].includes(run.state) };
  }
  throw new Error(`USAGE: hoh ${verbs.join('|')}`);
}
