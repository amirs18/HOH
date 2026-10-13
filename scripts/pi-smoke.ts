import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { piCli, JsonlDecoder } from '../src/agents/pi-rpc-runner.js';
import { minimalEnv } from '../src/infra/process.js';

const cwd = mkdtempSync(join(tmpdir(), 'hoh-pi-smoke-'));
const child = spawn(process.execPath, [piCli(), '--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions', '--no-mcp',
  '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', resolve('src/extension.ts')],
  { cwd, env: { ...minimalEnv(), HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, 'agent') }, stdio: 'pipe' });
let stderr = '', loaded = false, notified = false;
const send = (x: object) => child.stdin.write(JSON.stringify(x) + '\n');
const success = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`PI_SMOKE_TIMEOUT: ${stderr}`)), 15_000);
  const decoder = new JsonlDecoder(r => {
    if (r.type === 'response' && r.id === 'commands') {
      const commands = (r.data as { commands: { name: string }[] }).commands;
      loaded = commands.some(c => c.name === 'hoh');
      if (!loaded) { clearTimeout(timer); reject(new Error(`HOH_COMMAND_NOT_REGISTERED: ${stderr}`)); return; }
      send({ type: 'prompt', id: 'status', message: '/hoh status' });
    }
    if (r.type === 'extension_ui_request' && r.method === 'notify') {
      notified = String(r.message).includes('NO_RUN');
    }
    if (r.type === 'response' && r.id === 'status') {
      clearTimeout(timer);
      if (!r.success || !notified) reject(new Error(`HOH_STATUS_FAILED: ${stderr}`)); else resolve();
    }
  });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', c => { try { decoder.feed(c); } catch (e) { clearTimeout(timer); reject(e); } });
  child.stderr.on('data', c => { stderr += c; });
  child.on('error', e => { clearTimeout(timer); reject(e); });
  child.on('exit', () => { clearTimeout(timer); reject(new Error(`PI_EXITED_BEFORE_SMOKE: ${stderr}`)); });
});
try {
  send({ type: 'get_commands', id: 'commands' }); await success;
  console.log(JSON.stringify({ piVersion: '1.1.0', extensionLoaded: loaded, command: '/hoh status', rpcNotification: notified, modelCalls: 0, cwd }, null, 2));
} finally { child.kill('SIGTERM'); }
