import { describe, it, expect } from 'vitest';
import extension from '../src/extension.js';
import { fixture } from './support.js';
import { HoH } from '../src/engine.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

describe.skipIf(process.platform !== 'darwin')('native Pi adapter', () => {
  it('gates experiment tools, enforces scoped mutations, and compacts without an LLM call', async () => {
    const repo=await fixture(), tools=new Map<string,any>(), events=new Map<string,any>(), commands=new Map<string,any>();
    let active=['read','write','edit','bash','codemode'];
    const pi={registerTool:(t:any)=>tools.set(t.name,t),registerCommand:(n:string,c:any)=>commands.set(n,c),on:(n:string,h:any)=>events.set(n,h),
      getActiveTools:()=>active,setActiveTools:(names:string[])=>{active=names;},sendMessage:()=>{},sendUserMessage:()=>{throw new Error('No model should be called in manual mode');}};
    extension(pi as unknown as ExtensionAPI);
    const ctx={cwd:repo,hasUI:false,mode:'rpc',isIdle:()=>true,hasPendingMessages:()=>false,abort:()=>{},ui:{setStatus:()=>{},setWidget:()=>{},notify:()=>{}}};
    await events.get('session_start')({},ctx);
    expect(events.get('tool_call')({toolName:'hoh_run_experiment',input:{}},ctx).block).toBe(true);
    const e=new HoH(repo);await e.start('SPEC.md');await e.pause();
    await commands.get('hoh').handler('resume --manual',ctx);
    expect(active).not.toContain('bash');expect(active).not.toContain('codemode');
    expect(events.get('tool_call')({toolName:'write',input:{path:repo+'/SPEC.md'}},ctx).block).toBe(true);
    const compact=await events.get('session_before_compact')({preparation:{firstKeptEntryId:'abc',tokensBefore:123}},ctx);
    expect(compact.compaction.summary).toContain('HoH deterministic checkpoint');expect(compact.compaction.tokensBefore).toBe(123);
    expect(compact.compaction.summary).toBe((await events.get('session_before_compact')({preparation:{firstKeptEntryId:'abc',tokensBefore:123}},ctx)).compaction.summary);
    expect(tools.get('hoh_log_experiment').parameters.properties).not.toHaveProperty('status');expect(tools.get('hoh_log_experiment').parameters.properties).not.toHaveProperty('metric');
    await commands.get('hoh').handler('pause',ctx);expect(active).toContain('bash');
  });
});
