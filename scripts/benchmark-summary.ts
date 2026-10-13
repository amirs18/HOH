import { readFileSync } from 'node:fs';
import { z } from 'zod';
const schema = z.array(z.object({
  arm: z.enum(['plain-pi', 'hoh']), stage: z.string(), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  trusted: z.boolean(), mandatoryPassed: z.number().int().nonnegative(), mandatoryTotal: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(), attempts: z.number().int().positive(),
  tokens: z.number().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable(),
}).strict().refine(r => r.mandatoryPassed <= r.mandatoryTotal)).min(1);
const records = schema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.table(records.map(r => ({ ...r, accepted: r.trusted && r.mandatoryPassed === r.mandatoryTotal,
  passRate: r.trusted ? r.mandatoryPassed / r.mandatoryTotal : 'UNTRUSTED' })));
