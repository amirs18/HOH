import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Isolation, scratchEnv } from '../infra/isolation.js';
import { launch, resolveExecutable, type ProcessTracker } from '../infra/process.js';
import { redact } from '../evaluation/artifacts.js';
import type { Config } from '../core/schemas.js';
import type { AgentJob, AgentJobResult, AgentRunner } from './runner.js';

export const piCli = (): string => join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
export class JsonlDecoder {
  private buffer = '';
  constructor(private onRecord: (record: Record<string, unknown>) => void, private limit = 1_000_000) {}
  feed(chunk: string): void {
    this.buffer += chunk;
    let pos: number;
    while ((pos = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, pos); this.buffer = this.buffer.slice(pos + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line || line.length > this.limit) throw new Error('RPC_INVALID_FRAME');
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error('RPC_MALFORMED_JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== 'string')
        throw new Error('RPC_INVALID_RECORD');
      this.onRecord(value as Record<string, unknown>);
    }
    if (this.buffer.length > this.limit) throw new Error('RPC_FRAME_TOO_LARGE');
  }
  end(): void { if (this.buffer) throw new Error('RPC_TRUNCATED_FRAME'); }
}
export class PiRpcRunner implements AgentRunner {
  readonly secretValues: string[];
  constructor(private config: Config, private isolation: Isolation, private tracker?: ProcessTracker) {
    this.secretValues = [...Object.values(config.runner.env), ...config.runner.inheritEnv.map(k => process.env[k] ?? '')];
  }
  async execute(job: AgentJob, { signal }: { signal: AbortSignal }): Promise<AgentJobResult> {
    if (signal.aborted) throw new Error('ABORTED');
    const defaultPi = this.config.runner.command === 'pi';
    const executable = defaultPi ? process.execPath : resolveExecutable(this.config.runner.command);
    const args = [...(defaultPi ? [piCli()] : []), ...this.config.runner.args, '--mode', 'rpc', '--no-session',
      '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes',
      ...(job.readOnly ? ['--tools', 'read,grep,find,ls'] : ['--tools', 'read,edit,write'])];
    const env = { ...scratchEnv(job.cwd), ...Object.fromEntries(this.config.runner.inheritEnv.map(k => [k, process.env[k]])), ...this.config.runner.env };
    // Do not permit config to remount a real HOME, agent directory, or inject Node code.
    for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) delete env[k];
    Object.assign(env, scratchEnv(job.cwd));
    const denied = [join(job.cwd, '.git'), ...(!job.readOnly ? this.config.protectedPaths.map(p => join(job.cwd, p)) : [])];
    const spec = this.isolation.wrap({ executable, args, cwd: job.cwd, env }, {
      read: [job.cwd, ...(defaultPi ? [dirname(dirname(piCli()))] : [executable])],
      write: job.readOnly ? [join(job.cwd, '.hoh-scratch')] : [job.cwd], deny: denied, network: true,
    });
    const handle = launch(spec, this.tracker), child = handle.child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let output = '', stderr = '', promptAccepted = false, settled = false, modelError = '', finished = false;
    let usage: AgentJobResult['usage'];
    let resolveResult!: (value: AgentJobResult) => void, rejectResult!: (reason: Error) => void;
    const done = new Promise<AgentJobResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const fail = (error: Error) => { if (!finished) { finished = true; rejectResult(error); } };
    const send = (value: object) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n', e => { if (e) fail(e); }); };
    let requestedStats = false;
    const maybeStats = () => {
      if (promptAccepted && settled && !requestedStats) {
        if (modelError) { fail(new Error(`RPC_MODEL_ERROR: ${redact(modelError, this.secretValues)}`)); return; }
        requestedStats = true; send({ id: 'stats', type: 'get_session_stats' });
      }
    };
    const decoder = new JsonlDecoder(record => {
      if (record.type === 'response') {
        if (record.success === false) { fail(new Error(`RPC_COMMAND_FAILED: ${redact(String(record.error), this.secretValues)}`)); return; }
        if (record.id === 'job') {
          if ((record.data as { disposition?: string } | undefined)?.disposition === 'handled') { fail(new Error('RPC_PROMPT_HANDLED_WITHOUT_RUN')); return; }
          promptAccepted = true; maybeStats();
        }
        if (record.id === 'stats') {
          const data = record.data as { tokens?: { input?: number; output?: number; total?: number }; cost?: number } | undefined;
          if (data?.tokens && Number.isFinite(data.tokens.total)) usage = {
            inputTokens: data.tokens.total! - (data.tokens.output ?? 0), outputTokens: data.tokens.output,
            ...(Number.isFinite(data.cost) ? { costUsd: data.cost } : {}),
          };
          if (!finished) { finished = true; resolveResult({ exitCode: 0, output: redact(output, this.secretValues), usage, artifacts: [] }); }
        }
      }
      if (record.type === 'message_end') {
        const message = record.message as { role?: string; content?: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string } | undefined;
        if (message?.role === 'assistant') {
          if (['error', 'aborted'].includes(message.stopReason ?? '')) modelError = message.errorMessage ?? message.stopReason!;
          else modelError = '';
          output = (message.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
          if (output.length > this.config.maxLogBytes) fail(new Error('RPC_OUTPUT_TOO_LARGE'));
        }
      }
      if (record.type === 'agent_settled') {
        if (record.aborted) { fail(new Error('RPC_ABORTED')); return; }
        settled = true; maybeStats();
      }
      if (record.type === 'extension_error') fail(new Error('RPC_EXTENSION_ERROR'));
    });
    child.stdout.on('data', c => { try { decoder.feed(c); } catch (e) { fail(e as Error); } });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(0, this.config.maxLogBytes); });
    child.on('error', fail);
    child.on('close', (code, exitSignal) => {
      if (!finished) {
        try { decoder.end(); } catch (e) { fail(e as Error); return; }
        fail(new Error(`RPC_CHILD_EXIT: ${code ?? exitSignal}: ${redact(stderr, this.secretValues)}`));
      }
    });
    const abort = () => { send({ id: 'clear', type: 'clear_queue' }); send({ id: 'abort', type: 'abort' }); fail(new Error('ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail(new Error('RPC_TIMEOUT')), job.timeoutMs);
    try {
      await handle.registered;
      if (signal.aborted) abort();
      if (!finished) send({ id: 'job', type: 'prompt', message: job.instructions });
      return await done;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); await handle.cleanup();
    }
  }
}
