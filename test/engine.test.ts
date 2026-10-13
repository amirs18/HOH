import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HoH } from '../src/engine.js';
import { context } from '../src/context.js';
import { git, readJson, writeJson } from '../src/io.js';
import { DecisionSchema } from '../src/model.js';
import { fixture, edit } from './support.js';

describe.skipIf(process.platform !== 'darwin')('real file/Git/OS-verifier experiment loop', () => {
  it('keeps partial progress, rejects regression, repairs, and resumes exact JSON evidence', async () => {
    const repo = await fixture(), e = new HoH(repo), main = await git(repo, ['rev-parse', 'HEAD']); await e.start('SPEC.md');
    expect(e.status()!.checkpoint.bestMetric).toBe(0);
    edit(e.status()!.checkpoint.draft!.cwd, '(a>0&&b>0)?a+b:a-b');
    const first = await e.run(); expect(first.samples.map(s => s.metric)).toEqual([1,1,1]);
    expect(e.guard('write', { path: join(e.status()!.checkpoint.draft!.cwd, 'app.mjs') })).toContain('Log');
    const kept = await e.log(1, { description: 'Positive case', hypothesis: 'Fix positive additions', learned: 'Signed behavior is still missing' });
    expect(kept.status).toBe('keep'); expect(kept.goalReached).toBe(false); const partial = e.status()!.checkpoint.bestSha;
    edit(e.status()!.checkpoint.draft!.cwd, 'a+b', '0'); await e.run();
    expect((await e.log(2, { description: 'Regression' })).status).toBe('checks_failed');
    expect(e.status()!.checkpoint.bestSha).toBe(partial);
    await e.pause(); const restarted = new HoH(repo); await restarted.resume();
    edit(restarted.status()!.checkpoint.draft!.cwd, 'a+b'); const measurement = await restarted.run();
    const reopened = new HoH(repo); await reopened.resume();
    const final = await reopened.log(measurement.run, { description: 'Full repair' }); expect(final.goalReached).toBe(true);
    expect(reopened.status()!.checkpoint.state).toBe('COMPLETED');
    expect(await reopened.log(3, { description: 'Duplicate' })).toEqual(final);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(main); expect(readFileSync(join(repo, 'app.mjs'), 'utf8')).toContain('a - b');
    expect(context(reopened)).toBe(context(new HoH(repo))); expect(context(reopened)).toContain('Signed behavior is still missing');
    expect(existsSync(join(repo, '.hoh/state.sqlite'))).toBe(false);
  });
  it('caps identical/no-progress experiments and preserves failed draft edits', async () => {
    const repo = await fixture({ maxNoProgress: 2 }), e = new HoH(repo); await e.start('SPEC.md');
    const drafts: string[] = [];
    for (let n=1; n<=2; n++) { const dir=e.status()!.checkpoint.draft!.cwd; drafts.push(dir); edit(dir,'42'); await e.run(); expect((await e.log(n,{description:'Same failure'})).status).toBe('discard'); }
    expect(e.status()!.checkpoint.state).toBe('BLOCKED'); expect(e.status()!.checkpoint.noProgress).toBe(2);
    expect(readFileSync(join(drafts[0],'app.mjs'),'utf8')).toContain('42'); await expect(e.run()).rejects.toThrow('RUN_NOT_ACTIVE');
  });
  it('binds keep to frozen evidence and rejects altered result/config files', async () => {
    const repo = await fixture(), e = new HoH(repo); await e.start('SPEC.md');
    edit(e.status()!.checkpoint.draft!.cwd,'a+b'); await e.run();
    const path=join(e.files.trial(e.status()!.header.id,1),'measurement.json'); const value=JSON.parse(readFileSync(path,'utf8')); value.candidateSha='b'.repeat(40); writeJson(path,value);
    await expect(e.log(1,{description:'Forged evidence'})).rejects.toThrow('EVIDENCE_BINDING_MISMATCH');
  });
  it('refuses replayed caller-selected keep decisions', async () => {
    const repo=await fixture(), e=new HoH(repo); await e.start('SPEC.md'); edit(e.status()!.checkpoint.draft!.cwd,'42'); await e.run(); await e.log(1,{description:'Failure'});
    const path=join(e.files.trial(e.status()!.header.id,1),'decision.json'), decision=readJson(path,DecisionSchema); decision.status='keep'; writeJson(path,decision);
    expect(()=>e.status()).toThrow('DECISION_REPLAY_MISMATCH'); await expect(e.resume()).rejects.toThrow('DECISION_REPLAY_MISMATCH');
  });
  it('reports evaluator timeouts and premature candidate exits as failures', async () => {
    const repo=await fixture(), e=new HoH(repo); await e.start('SPEC.md');
    writeFileSync(join(e.status()!.checkpoint.draft!.cwd,'app.mjs'),'process.exit(0)'); await e.run();
    expect((await e.log(1,{description:'Try to bypass verifier'})).status).toBe('crash');
    edit(e.status()!.checkpoint.draft!.cwd,'(()=>{while(true){}})()');
    // Only the frozen configured timeout governs this run (5s).
    const pending=e.run(); const pause=new Promise(r=>setTimeout(r,100)); await pause; await e.stop(); await pending;
    expect(e.status()!.checkpoint.state).toBe('CANCELLED'); expect(e.inspect()!.samples[0].error).toBe('ABORTED');
  });
  it('cannot mutate state, verifiers, old worktrees, Git metadata or execute arbitrary tools', async () => {
    const repo=await fixture(), e=new HoH(repo); await e.start('SPEC.md'); const cwd=e.status()!.checkpoint.draft!.cwd;
    expect(e.guard('write',{path:join(cwd,'app.mjs')})).toBeUndefined();
    for(const path of [join(repo,'app.mjs'),join(repo,'.hoh/config.json'),join(repo,'.hoh/evaluation/measure.mjs'),join(cwd,'.git')]) expect(e.guard('write',{path})).toBeTruthy();
    for(const tool of ['bash','codemode','powershell','mcp__bad__run','some_other_tool','init_experiment','run_experiment','log_experiment']) expect(e.guard(tool,{})).toBeTruthy();
    symlinkSync(join(repo,'app.mjs'),join(cwd,'linked.mjs'));
    expect(e.guard('write',{path:join(cwd,'linked.mjs')})).toBeTruthy();
  });
  it('rejects dirty starts, pauses/resumes drafts and enforces a single measurement/log writer', async () => {
    const repo=await fixture(), e=new HoH(repo); writeFileSync(join(repo,'new.txt'),'dirty'); await expect(e.start('SPEC.md')).rejects.toThrow('DIRTY_BASELINE');
    const clean=await fixture(), first=new HoH(clean); await first.start('SPEC.md'); await first.pause(); const second=new HoH(clean); await second.resume();
    const job=second.run(); await new Promise(r=>setTimeout(r,20)); await expect(new HoH(clean).run()).rejects.toThrow(); await job;
    expect(second.status()!.checkpoint.pending?.phase).toBe('MEASURED'); await expect(second.run()).rejects.toThrow('MEASUREMENT_PENDING');
  });
  it('uses canonical JSON records even if the derived JSONL display cache is damaged', async () => {
    const repo=await fixture(), e=new HoH(repo); await e.start('SPEC.md'); const before=context(e);
    writeFileSync(join(e.files.runDir(e.status()!.header.id),'log.jsonl'),'bad partial cache\n');
    expect(context(e)).toBe(before); await e.pause(); await new HoH(repo).resume();
    expect(readFileSync(join(e.files.runDir(e.status()!.header.id),'log.jsonl'),'utf8')).toContain('"type":"config"');
  });
});
