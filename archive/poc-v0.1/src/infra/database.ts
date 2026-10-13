import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, Evaluation, Plan } from '../core/schemas.js';
import { acceptance, hash } from '../core/policy.js';
import { transition, type RunState } from '../core/states.js';
import type { TaskRecord } from '../core/scheduler.js';

export type RunRecord = {
  id: string; repoRoot: string; baselineSha: string; acceptedSha: string; specHash: string; spec: string;
  state: RunState; createdAt: string; updatedAt: string; config: Config; configHash: string; verifierHash: string;
  plan?: Plan; contractHash?: string; planApproved: boolean; tasks: TaskRecord[]; iterations: number;
  elapsedMs: number; tokens: number; costUsd: number; usageAvailable: boolean; blocker?: string;
  lastEvaluationId?: string; control?: 'pause' | 'stop';
};
export type AttemptRecord = {
  id: string; runId: string; taskId: string; number: number; cwd: string; parentSha: string; startedAt: string;
  endedAt?: string; candidateSha?: string; exitOutcome?: string; fingerprint?: string; diffHash?: string;
};
const json = (x: unknown) => JSON.stringify(x);
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 1) throw new Error('DATABASE_VERSION_UNSUPPORTED');
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE runs (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, baseline_sha TEXT NOT NULL, spec_hash TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, config TEXT NOT NULL, json TEXT NOT NULL, control TEXT);
      CREATE UNIQUE INDEX one_active_run ON runs(repo_root) WHERE state IN ('NEW','PLANNING','RUNNING','PAUSED','BLOCKED');
      CREATE TABLE contracts (run_id TEXT NOT NULL REFERENCES runs(id), version INTEGER NOT NULL, source_hash TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,version));
      CREATE TABLE requirements (run_id TEXT NOT NULL, id TEXT NOT NULL, contract_version INTEGER NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE tasks (run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, dependencies TEXT NOT NULL, state TEXT NOT NULL, accepted_sha TEXT, attempt_count INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, worker_type TEXT NOT NULL DEFAULT 'builder', start TEXT NOT NULL, end TEXT, candidate_sha TEXT, exit_outcome TEXT, failure_fingerprint TEXT, json TEXT NOT NULL);
      CREATE TABLE evaluations (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), candidate_sha TEXT NOT NULL, contract_hash TEXT NOT NULL, evaluation_hash TEXT NOT NULL, decision TEXT NOT NULL, summary TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE checks (evaluation_id TEXT NOT NULL REFERENCES evaluations(id), id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(evaluation_id,id));
      CREATE TABLE findings (evaluation_id TEXT NOT NULL REFERENCES evaluations(id), id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(evaluation_id,id));
      CREATE TABLE artifacts (evaluation_id TEXT NOT NULL REFERENCES evaluations(id), path TEXT NOT NULL, PRIMARY KEY(evaluation_id,path));
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), timestamp TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE leases (run_id TEXT PRIMARY KEY REFERENCES runs(id), pid INTEGER NOT NULL, identity TEXT NOT NULL, token TEXT NOT NULL, heartbeat INTEGER NOT NULL);
      CREATE TABLE children (run_id TEXT NOT NULL REFERENCES runs(id), pid INTEGER PRIMARY KEY, identity TEXT NOT NULL, started_at TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
  }
  close(): void { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private write(run: RunRecord, verified = false): void {
    const old = this.get(run.id);
    if (old && old.state !== run.state) transition('run', old.state, run.state, verified);
    for (const task of run.tasks) {
      const before = old?.tasks.find(t => t.id === task.id);
      if (before && before.state !== task.state) transition('task', before.state, task.state, verified);
    }
    run.updatedAt = new Date().toISOString();
    const { control: _, ...record } = run;
    this.db.prepare(`INSERT INTO runs (id,repo_root,baseline_sha,spec_hash,state,created_at,updated_at,config,json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,json=excluded.json`)
      .run(run.id, run.repoRoot, run.baselineSha, run.specHash, run.state, run.createdAt, run.updatedAt, json(run.config), json(record));
    for (const t of run.tasks) this.db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id,id)
      DO UPDATE SET state=excluded.state,accepted_sha=excluded.accepted_sha,attempt_count=excluded.attempt_count,json=excluded.json`)
      .run(run.id, t.id, json(t.dependencies), t.state, t.acceptedSha ?? null, t.attempts, json(t));
    for (const r of run.plan?.contract.requirements ?? []) this.db.prepare(`INSERT INTO requirements VALUES (?,?,?,?,?)
      ON CONFLICT(run_id,id) DO UPDATE SET status=excluded.status`)
      .run(run.id, r.id, 1, r.priority, run.tasks.filter(t => t.requirementIds.includes(r.id)).every(t => t.state === 'ACCEPTED') ? 'ACCEPTED' : 'PENDING');
  }
  save(run: RunRecord, type: string, data: unknown = {}): void {
    this.transaction(() => { this.write(run); this.event(run.id, type, data); });
  }
  event(id: string, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events (run_id,timestamp,type,json) VALUES (?,?,?,?)').run(id, new Date().toISOString(), type, json(data));
  }
  get(id?: string): RunRecord | undefined {
    const row = (id ? this.db.prepare('SELECT json,control FROM runs WHERE id=?').get(id) :
      this.db.prepare('SELECT json,control FROM runs ORDER BY created_at DESC LIMIT 1').get()) as { json: string; control: RunRecord['control'] } | undefined;
    return row ? { ...JSON.parse(row.json), control: row.control ?? undefined } : undefined;
  }
  active(): RunRecord | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE state IN ('NEW','PLANNING','RUNNING','PAUSED','BLOCKED') LIMIT 1").get() as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }
  savePlan(run: RunRecord): void {
    this.transaction(() => {
      this.write(run);
      this.db.prepare('INSERT INTO contracts VALUES (?,?,?,?,?)').run(run.id, 1, run.specHash, json(run.plan!.contract), new Date().toISOString());
      this.event(run.id, 'PLAN_COMPILED', { contractHash: run.contractHash, tasks: run.tasks.length });
    });
  }
  attempt(a: AttemptRecord): void {
    this.db.prepare(`INSERT INTO attempts (id,run_id,task_id,start,end,candidate_sha,exit_outcome,failure_fingerprint,json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET end=excluded.end,candidate_sha=excluded.candidate_sha,
      exit_outcome=excluded.exit_outcome,failure_fingerprint=excluded.failure_fingerprint,json=excluded.json`)
      .run(a.id, a.runId, a.taskId, a.startedAt, a.endedAt ?? null, a.candidateSha ?? null, a.exitOutcome ?? null, a.fingerprint ?? null, json(a));
  }
  attempts(runId: string): AttemptRecord[] {
    return (this.db.prepare('SELECT json FROM attempts WHERE run_id=? ORDER BY start').all(runId) as { json: string }[]).map(r => JSON.parse(r.json));
  }
  evaluation(e: Evaluation): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO evaluations VALUES (?,?,?,?,?,?,?,?)').run(e.id, e.attemptId, e.candidateSha, e.contractHash, e.evaluationConfigHash, e.decision, e.summary, json(e));
      for (const c of e.checks) this.db.prepare('INSERT INTO checks VALUES (?,?,?)').run(e.id, c.id, json(c));
      for (const f of e.findings) this.db.prepare('INSERT INTO findings VALUES (?,?,?)').run(e.id, f.id, json(f));
      for (const p of new Set(e.evidencePaths)) this.db.prepare('INSERT INTO artifacts VALUES (?,?)').run(e.id, p);
    });
  }
  getEvaluation(id?: string): Evaluation | undefined {
    if (!id) return;
    const row = this.db.prepare('SELECT json FROM evaluations WHERE id=?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  acceptTask(run: RunRecord, taskId: string, evaluationId: string): void {
    this.transaction(() => {
      const persisted = this.get(run.id)!;
      if (persisted.control === 'stop' || persisted.state !== 'RUNNING') throw new Error('ACCEPTANCE_INTERRUPTED');
      const t = run.tasks.find(t => t.id === taskId)!, e = this.getEvaluation(evaluationId);
      const attempt = this.attempts(run.id).find(a => a.id === e?.attemptId && a.taskId === t.id);
      if (!e || !attempt || e.decision !== 'ACCEPT' || attempt.candidateSha !== e.candidateSha ||
        attempt.parentSha !== persisted.acceptedSha || persisted.tasks.find(x => x.id === t.id)?.state !== 'VERIFYING' ||
        t.dependencies.some(id => persisted.tasks.find(x => x.id === id)?.state !== 'ACCEPTED') ||
        e.contractHash !== run.contractHash || e.evaluationConfigHash !== hash({ config: run.config, verifierHash: run.verifierHash }) ||
        acceptance(e.checks, e.findings, t.requirementIds, run.plan!, run.config).length)
        throw new Error('ACCEPTANCE_EVIDENCE_INVALID');
      t.state = 'ACCEPTED'; t.acceptedSha = e.candidateSha; run.acceptedSha = e.candidateSha;
      this.write(run, true); this.event(run.id, 'TASK_ACCEPTED', { taskId, candidateSha: e.candidateSha, evidencePaths: e.evidencePaths });
    });
  }
  finish(run: RunRecord): void {
    this.transaction(() => {
      const e = this.getEvaluation(run.lastEvaluationId);
      if (this.get(run.id)?.control || !run.planApproved || !run.tasks.length || run.tasks.some(t => t.state !== 'ACCEPTED') ||
        !e || e.candidateSha !== run.acceptedSha || e.decision !== 'ACCEPT' ||
        acceptance(e.checks, e.findings, run.plan!.contract.requirements.map(r => r.id), run.plan!, run.config).length)
        throw new Error('RELEASE_GATE_INCOMPLETE');
      run.state = 'ACCEPTED'; this.write(run, true); this.event(run.id, 'RUN_ACCEPTED', { candidateSha: run.acceptedSha, evidencePaths: e.evidencePaths });
    });
  }
  requestControl(runId: string, control: 'pause' | 'stop' | undefined): void {
    this.transaction(() => {
      this.db.prepare('UPDATE runs SET control=? WHERE id=?').run(control ?? null, runId);
      this.event(runId, 'CONTROL_REQUEST', { control });
    });
  }
  lease(runId: string): { pid: number; identity: string; token: string; heartbeat: number } | undefined {
    return this.db.prepare('SELECT pid,identity,token,heartbeat FROM leases WHERE run_id=?').get(runId) as ReturnType<Store['lease']>;
  }
  claim(runId: string, identity: string): string {
    const token = randomUUID();
    this.db.prepare('INSERT INTO leases VALUES (?,?,?,?,?)').run(runId, process.pid, identity, token, Date.now()); return token;
  }
  heartbeat(runId: string, token: string): void {
    if (this.db.prepare('UPDATE leases SET heartbeat=? WHERE run_id=? AND token=?').run(Date.now(), runId, token).changes !== 1)
      throw new Error('LEASE_LOST');
  }
  release(runId: string, token: string): void { this.db.prepare('DELETE FROM leases WHERE run_id=? AND token=?').run(runId, token); }
  recordChild(runId: string, pid: number, identity: string): void {
    this.db.prepare('INSERT OR REPLACE INTO children VALUES (?,?,?,?)').run(runId, pid, identity, new Date().toISOString());
  }
  children(runId: string): { pid: number; identity: string }[] {
    return this.db.prepare('SELECT pid,identity FROM children WHERE run_id=?').all(runId) as { pid: number; identity: string }[];
  }
  removeChild(pid: number): void { this.db.prepare('DELETE FROM children WHERE pid=?').run(pid); }
}
