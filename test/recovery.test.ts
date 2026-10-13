import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { HoH } from '../src/engine.js';
import { birthIdentity, command, baseEnv } from '../src/io.js';
import { fixture, edit } from './support.js';

describe.skipIf(process.platform !== 'darwin')('JSON recovery and process boundaries', () => {
  it('recovers an actual killed CLI process, kills its orphan verifier, and never accepts interrupted evidence', async () => {
    const repo = await fixture(), e = new HoH(repo); await e.start('SPEC.md');
    edit(e.status()!.checkpoint.draft!.cwd, '(()=>{while(true){}})()');
    const child = spawn(process.execPath, ['--import','tsx',resolve('src/cli.ts'),'run','--repo',repo], { stdio:['ignore','pipe','pipe'] });
    let stderr=''; child.stderr.on('data',c=>{stderr+=c;});
    let worker:{pid:number;identity:string}|undefined; const deadline=Date.now()+5000;
    try {
      while(Date.now()<deadline&&!worker){worker=e.status()!.checkpoint.pending?.children[0];if(!worker)await new Promise(r=>setTimeout(r,20));}
      expect(worker,stderr).toBeDefined(); const exited=new Promise<void>(r=>child.once('close',()=>r()));child.kill('SIGKILL');await exited;
      const resumed=new HoH(repo); await resumed.resume();
      expect(await birthIdentity(worker!.pid)).not.toBe(worker!.identity);
      expect(resumed.status()!.checkpoint.pending?.phase).toBe('MEASURED');
      expect((await resumed.log(1,{description:'Interrupted run'})).status).toBe('crash');
      edit(resumed.status()!.checkpoint.draft!.cwd,'a+b');await resumed.run();expect((await resumed.log(2,{description:'Recovered repair'})).goalReached).toBe(true);
      expect(existsSync(join(repo,'.hoh/lease.json'))).toBe(false);
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  });
  it('treats a timed-out evaluator as crash, not a valid measured result', async () => {
    const repo=await fixture({timeoutMs:500}), e=new HoH(repo);await e.start('SPEC.md');
    edit(e.status()!.checkpoint.draft!.cwd,'(()=>{while(true){}})()'); const m=await e.run();
    expect(m.samples[0].error).toBe('TIMEOUT');expect((await e.log(1,{description:'Timeout'})).status).toBe('crash');
  });
  it('protects verifier and supervisor files from evaluated candidate code with OS enforcement', async () => {
    const repo=await fixture(), e=new HoH(repo);await e.start('SPEC.md');
    const statePath=join(e.repo,'.hoh/config.json'), before=readFileSync(statePath,'utf8');
    writeFileSync(join(e.status()!.checkpoint.draft!.cwd,'app.mjs'), `import {writeFileSync} from 'node:fs';
      try {writeFileSync(${JSON.stringify(statePath)},'overwritten');}catch{}
      export function add(a,b){return a+b;}export function multiply(a,b){return a*b;}`);
    await e.run();expect(readFileSync(statePath,'utf8')).toBe(before);
    expect((await e.log(1,{description:'Verify filesystem isolation'})).goalReached).toBe(true);
  });
  it('the built CLI exposes the same history and idempotent recovery without needing a model', async () => {
    const repo=await fixture(), e=new HoH(repo);await e.start('SPEC.md');await e.pause();
    const invoke=async(verb:string)=>{
      const output=await command({executable:process.execPath,args:['--import','tsx',resolve('src/cli.ts'),verb,'--repo',repo],cwd:process.cwd(),env:baseEnv()},10000);
      expect(output.code,output.stderr).toBe(0);return JSON.parse(output.stdout);
    };
    expect((await invoke('status')).state).toBe('PAUSED');expect((await invoke('resume')).state).toBe('RUNNING');
    expect((await invoke('inspect')).samples.map((s:any)=>s.metric)).toEqual([0,0,0]);
  });
});
