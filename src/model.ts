import { z } from 'zod';
import { createHash } from 'node:crypto';

const Id = z.string().regex(/^[A-Za-z][\w.-]{0,79}$/).refine(x => !['__proto__', 'constructor', 'prototype'].includes(x));
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const hash = (x: unknown): string => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const Command = z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]) }).strict();
export const ConfigSchema = z.object({
  version: z.literal(1).default(1), name: z.string().min(1),
  metric: z.object({ name: Id, unit: z.string().default(''), direction: z.enum(['higher', 'lower']),
    target: z.number().finite(), minImprovement: z.number().nonnegative().default(0),
    absoluteTolerance: z.number().nonnegative().default(0) }).strict(),
  measure: Command, checks: Command,
  requirements: z.array(z.object({ id: Id, statement: z.string().min(1) }).strict()).min(1),
  scope: z.array(z.string().min(1)).min(1),
  repeats: z.number().int().min(2).max(20).default(3), seed: z.number().int().min(0).max(4294967295).default(42),
  maxIterations: z.number().int().min(1).max(1000).default(10),
  maxNoProgress: z.number().int().min(1).max(100).default(3),
  timeoutMs: z.number().int().min(50).max(3600000).default(120000),
  allowlistedExecutables: z.array(z.string().min(1)).min(1),
}).strict().superRefine((c, ctx) => {
  if (c.requirements.length !== new Set(c.requirements.map(r => r.id)).size)
    ctx.addIssue({ code: 'custom', message: 'Duplicate requirement IDs' });
  for (const cmd of [c.measure, c.checks]) if (!c.allowlistedExecutables.includes(cmd.executable))
    ctx.addIssue({ code: 'custom', message: 'Executable is not allowlisted' });
  if (c.scope.some(p => p.startsWith('/') || p.split('/').some(s => s.startsWith('.')) || p === '/'))
    ctx.addIssue({ code: 'custom', message: 'Scope must be explicit relative source files/directories, never metadata' });
});
export type Config = z.infer<typeof ConfigSchema>;
export const SampleSchema = z.object({
  metric: z.number().finite().nullable(), metrics: z.record(z.string(), z.number().finite()),
  requirements: z.record(z.string(), z.enum(['PASS', 'FAIL'])),
  measureExit: z.number().int().nullable(), checksExit: z.number().int().nullable(),
  error: z.string().optional(), evidence: z.array(z.string()),
  diagnostic: z.string().optional(),
}).strict();
export type Sample = z.infer<typeof SampleSchema>;
export const MeasurementSchema = z.object({
  version: z.literal(1), run: z.number().int().nonnegative(), candidateSha: Sha,
  specHash: z.string(), configHash: z.string(), verifierHash: z.string(),
  samples: z.array(SampleSchema), integrityError: z.string().optional(),
  trusted: z.boolean(), startedAt: z.string(), finishedAt: z.string(),
}).strict();
export type Measurement = z.infer<typeof MeasurementSchema>;
export const DecisionSchema = z.object({
  version: z.literal(1), run: z.number().int().nonnegative(), candidateSha: Sha,
  measurementHash: z.string(), specHash: z.string(), configHash: z.string(), verifierHash: z.string(),
  status: z.enum(['keep', 'discard', 'crash', 'checks_failed', 'unstable']),
  metric: z.number().finite().nullable(), goalReached: z.boolean(), reason: z.string(),
  description: z.string(), hypothesis: z.string(), learned: z.string(), nextFocus: z.string(), timestamp: z.string(),
}).strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const HeaderSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), repo: z.string(), baselineSha: Sha,
  spec: z.string(), specHash: z.string(), config: ConfigSchema, configHash: z.string(), verifierHash: z.string(), createdAt: z.string(),
}).strict();
export type Header = z.infer<typeof HeaderSchema>;
export type Checkpoint = {
  version: 1; id: string; state: 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED';
  bestSha: string; bestMetric: number | null; iterations: number; noProgress: number;
  draft?: { run: number; cwd: string; parentSha: string }; pending?: { run: number; candidateSha: string; phase: 'MEASURING' | 'MEASURED';
    children: { pid: number; identity: string }[] }; reason?: string;
};
export const CheckpointSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), state: z.enum(['RUNNING', 'PAUSED', 'COMPLETED', 'BLOCKED', 'CANCELLED']),
  bestSha: Sha, bestMetric: z.number().finite().nullable(), iterations: z.number().int().nonnegative(), noProgress: z.number().int().nonnegative(),
  draft: z.object({ run: z.number().int().nonnegative(), cwd: z.string(), parentSha: Sha }).strict().optional(),
  pending: z.object({ run: z.number().int().nonnegative(), candidateSha: Sha, phase: z.enum(['MEASURING', 'MEASURED']),
    children: z.array(z.object({ pid: z.number().int().positive(), identity: z.string() }).strict()) }).strict().optional(), reason: z.string().optional(),
}).strict();
