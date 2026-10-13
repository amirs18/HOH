import { z } from 'zod';

export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
export const RequirementSchema = z.object({
  id: Id, statement: z.string().min(1), priority: z.enum(['critical', 'high', 'normal']),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  verificationIds: z.array(Id).min(1), dependencies: z.array(Id),
}).strict();
export const ContractSchema = z.object({
  schemaVersion: z.literal(1), sourceSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
  productGoal: z.string().min(1), constraints: z.array(z.string()),
  requirements: z.array(RequirementSchema).min(1),
  unresolvedDecisions: z.array(z.object({
    id: Id, question: z.string().min(1), impact: z.enum(['blocking', 'nonblocking']),
    recommendedDefault: z.string().optional(),
  }).strict()),
}).strict();
export const TaskSchema = z.object({
  id: Id, title: z.string().min(1), requirementIds: z.array(Id).min(1),
  scope: z.string().min(1), dependencies: z.array(Id),
  objectiveChecks: z.array(Id).min(1), exitCriteria: z.array(z.string().min(1)).min(1),
}).strict();
function graphIssues(items: { id: string; dependencies: string[] }[], ctx: z.RefinementCtx, label: string) {
  const ids = new Set(items.map(x => x.id));
  if (ids.size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} IDs` });
  const active = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    for (const dep of items.find(x => x.id === id)?.dependencies ?? []) {
      if (!ids.has(dep) || !visit(dep)) return false;
    }
    active.delete(id); visited.add(id); return true;
  };
  if (items.some(x => !visit(x.id))) ctx.addIssue({ code: 'custom', message: `Invalid or cyclic ${label} dependencies` });
}
export const PlanSchema = z.object({ contract: ContractSchema, tasks: z.array(TaskSchema).min(1) }).strict()
  .superRefine((p, ctx) => {
    graphIssues(p.tasks, ctx, 'task'); graphIssues(p.contract.requirements, ctx, 'requirement');
    const requirements = new Set(p.contract.requirements.map(r => r.id));
    for (const t of p.tasks) if (t.requirementIds.some(id => !requirements.has(id)))
      ctx.addIssue({ code: 'custom', message: `Unknown requirement in ${t.id}` });
    for (const r of requirements) if (!p.tasks.some(t => t.requirementIds.includes(r)))
      ctx.addIssue({ code: 'custom', message: `Unscheduled requirement ${r}` });
    if (new Set(p.contract.unresolvedDecisions.map(d => d.id)).size !== p.contract.unresolvedDecisions.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate decision IDs' });
  });
export const FindingSchema = z.object({
  id: Id, category: z.enum(['functional', 'regression', 'security', 'architecture', 'ux', 'operational']),
  severity: z.enum(['critical', 'high', 'medium', 'low']), requirementIds: z.array(Id),
  description: z.string().min(1), reproduction: z.string().optional(),
  evidencePaths: z.array(z.string()), proposedFix: z.string().optional(),
}).strict();
export const ReviewSchema = z.object({ findings: z.array(FindingSchema) }).strict();
export const DiagnosisSchema = z.object({ hypothesis: z.string().min(1), strategy: z.string().min(1) }).strict();
const CommandSchema = z.object({
  id: Id, kind: z.enum(['build', 'typecheck', 'lint', 'acceptance', 'regression', 'security', 'performance', 'browser']),
  executable: z.string().min(1), args: z.array(z.string()).default([]),
  requirementIds: z.array(Id).default([]), mandatory: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
}).strict();
export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runner: z.object({
    command: z.string().default('pi'), args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}), inheritEnv: z.array(z.string()).default([]),
  }).strict().default({ command: 'pi', args: [], env: {}, inheritEnv: [] }),
  isolation: z.enum(['auto', 'macos', 'none']).default('auto'),
  worktreeRoot: z.string().default('.hoh/worktrees'),
  evaluators: z.array(CommandSchema).default([]),
  allowlistedExecutables: z.array(z.string().min(1)).default(['node']),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  maxAttemptsPerTask: z.number().int().min(1).max(20).default(3),
  maxTotalIterations: z.number().int().min(1).max(100).default(10),
  maxStructuredRetries: z.number().int().min(0).max(3).default(1),
  maxLogBytes: z.number().int().min(1024).max(10_000_000).default(100_000),
  protectedPaths: z.array(z.string()).default(['SPEC.md', 'test', 'tests', '.hoh', '.git', '.pi', '.env']),
  allowSnapshotCommit: z.boolean().default(false),
  reviewRequired: z.boolean().default(true),
  planApproval: z.enum(['manual', 'configured-requirements']).default('manual'),
  requirements: z.array(RequirementSchema).optional(),
  tokenBudget: z.number().int().positive().optional(), costBudgetUsd: z.number().positive().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.requirements) graphIssues(c.requirements, ctx, 'configured requirement');
  if (new Set(c.evaluators.map(e => e.id)).size !== c.evaluators.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate evaluator IDs' });
  if (c.evaluators.some(e => ['integrity', 'isolation', 'acceptance-suite', 'regression-suite', 'review', 'frozen-revision', 'verifier-integrity'].includes(e.id)))
    ctx.addIssue({ code: 'custom', message: 'Evaluator IDs must not use reserved gate names' });
  if (c.evaluators.some(e => !c.allowlistedExecutables.includes(e.executable)))
    ctx.addIssue({ code: 'custom', message: 'Evaluator executable is not allowlisted' });
  if (c.planApproval === 'configured-requirements' && !c.requirements?.length)
    ctx.addIssue({ code: 'custom', message: 'Configured plan approval requires authoritative requirements' });
  if (c.protectedPaths.some(p => p.startsWith('/') || p.includes('..') || !p))
    ctx.addIssue({ code: 'custom', message: 'Protected paths must be project-relative' });
  if (!c.worktreeRoot.startsWith('.hoh/') || c.worktreeRoot.split('/').includes('..'))
    ctx.addIssue({ code: 'custom', message: 'Worktree root must be a relative path beneath .hoh/' });
});
export type Config = z.infer<typeof ConfigSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type CheckResult = {
  id: string; requirementIds: string[]; status: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_CONFIGURED';
  mandatory: boolean; exitCode?: number; durationMs: number; summary: string; evidencePaths: string[];
};
export type Evaluation = {
  id: string; attemptId: string; candidateSha: string; contractHash: string; evaluationConfigHash: string;
  createdAt: string; finishedAt: string; checks: CheckResult[]; findings: Finding[];
  decision: 'ACCEPT' | 'REJECT'; summary: string; evidencePaths: string[];
};
