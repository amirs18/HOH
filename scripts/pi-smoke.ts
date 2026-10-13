import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fixture } from '../test/support.js';
import { baseEnv } from '../src/io.js';

const repo = await fixture(), cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
const child = spawn(process.execPath, [cli, '--mode','rpc','--no-session','--no-tools','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','-e',resolve('src/extension.ts')],
  { cwd: repo, env: { ...baseEnv(), HOME: repo, PI_CODING_AGENT_DIR: join(repo,'.hoh/pi-smoke-agent') }, stdio:'pipe' });
let buffer='', stderr='', n=0;
const pending=new Map<string,{resolve:(r:any)=>void;reject:(e:Error)=>void}>();
const messages:any[]=[];
child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{
  buffer+=data;
  while(buffer.includes('\n')) { const i=buffer.indexOf('\n'), line=buffer.slice(0,i);buffer=buffer.slice(i+1);
    const record=JSON.parse(line); messages.push(record);
    if(record.type==='response' && pending.has(record.id)){const job=pending.get(record.id)!;pending.delete(record.id);record.success?job.resolve(record):job.reject(new Error(record.error));}
  }
});
child.stderr.on('data',c=>{stderr+=c;});
const send=(type:string,message?:string)=>new Promise<any>((resolve,reject)=>{
  const id=String(++n);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,type,message})+'\n');
});
const deadline=setTimeout(()=>{console.error(stderr);child.kill('SIGKILL');process.exitCode=1;},15000);
try {
  const commands=await send('get_commands');if(!commands.data.commands.some((c:any)=>c.name==='hoh'))throw new Error('HoH command not registered');
  await send('prompt','/hoh start SPEC.md --manual');
  let ready=false;
  for(let i=0;i<80&&!ready;i++){
    await new Promise(r=>setTimeout(r,100));await send('prompt','/hoh status');
    const notice=messages.filter(r=>r.type==='extension_ui_request'&&r.method==='notify').at(-1);
    if(notice){try{const status=JSON.parse(notice.message);ready=status.bestMetric===0&&status.draft?.run===1&&!status.pending;}catch{}}
  }
  if(!ready)throw new Error(`Pi baseline did not complete: ${JSON.stringify(messages.slice(-5))} ${stderr}`);
  await send('prompt','/hoh inspect');await send('prompt','/hoh pause');
  console.log(JSON.stringify({piVersion:'1.1.0',extensionLoaded:true,baselineMeasured:true,commands:['start --manual','status','inspect','pause'],modelCalls:0,repo},null,2));
}finally{clearTimeout(deadline);child.kill('SIGTERM');}
