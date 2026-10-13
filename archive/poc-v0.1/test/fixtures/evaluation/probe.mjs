import { spawn } from 'node:child_process';

// The trusted assertion process never imports candidate code into its own VM.
// Operands cross stdin; expected results remain in the parent verifier's memory.
export async function probe(operation, operands) {
  const program = `
    import {pathToFileURL} from 'node:url';
    import {join} from 'node:path';
    const api = await import(pathToFileURL(join(process.cwd(), 'app.mjs')));
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const operands = JSON.parse(input);
    process.stdout.write(JSON.stringify(operands.map(([a,b]) => api[process.env.HOH_OPERATION](a,b))));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    cwd: process.env.HOH_CANDIDATE,
    env: { PATH: process.env.PATH, HOH_OPERATION: operation, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    stdio: 'pipe',
  });
  let output = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output = (output + data).slice(0, 10000); });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr = (stderr + data).slice(0, 10000); });
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(operands));
  });
  if (exit.code !== 0 || exit.signal) throw new Error(`Candidate process failed: ${exit.code}/${exit.signal}: ${stderr}`);
  return JSON.parse(output); // Early exit(0), forged prose, and missing output fail validation.
}
