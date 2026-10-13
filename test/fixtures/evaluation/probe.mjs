import { spawn } from 'node:child_process';
export async function probe(operation, cases) {
  const program = `import {pathToFileURL} from 'node:url';
    const api=await import(pathToFileURL(process.cwd()+'/app.mjs'));
    let data='';for await(const c of process.stdin)data+=c;
    const inputs=JSON.parse(data);
    process.stdout.write(JSON.stringify(inputs.map(([a,b])=>api[process.env.OP](a,b))));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: process.env.HOH_CANDIDATE, env: { PATH: process.env.PATH, OP: operation }, stdio: 'pipe',
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout = (stdout + c).slice(0, 10000); }); child.stderr.on('data', c => { stderr = (stderr + c).slice(0, 10000); });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (c, s) => resolve(s ? null : c)); child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(cases)); });
  if (code !== 0) throw new Error(`Candidate failed: ${code}: ${stderr}`);
  return JSON.parse(stdout); // Premature exit(0) or forged prose is a failure.
}
