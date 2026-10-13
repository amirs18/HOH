import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { HoH } from './engine.js';
import { context, publicStatus } from './context.js';
import type { Notes } from './engine.js';
import { realpathSync } from 'node:fs';

const TOOLS = ['hoh_init_experiment', 'hoh_run_experiment', 'hoh_log_experiment'];
export default function extension(pi: ExtensionAPI): void {
  let engine: HoH | undefined, active = false, closing = false, originalTools: string[] = [], manual = false;
  let starting: Promise<void> | undefined, idleNudges = 0, lastProgress = '';
  const get = (ctx: ExtensionContext) => {
    if (!engine || engine.repo !== realpathSync(ctx.cwd)) engine = new HoH(ctx.cwd);
    return engine;
  };
  const notify = (ctx: ExtensionContext, value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (ctx.hasUI) ctx.ui.notify(text, 'info');
    else pi.sendMessage({ customType: 'hoh-status', content: text, display: true }, { triggerTurn: false });
  };
  const setMode = (enabled: boolean, ctx?: ExtensionContext) => {
    if (enabled && !active) { originalTools = pi.getActiveTools().filter(t => !TOOLS.includes(t)); idleNudges = 0; lastProgress = ''; }
    closing = !enabled && active && !!ctx && !ctx.isIdle();
    active = enabled; pi.setActiveTools(enabled ? ['read', 'write', 'edit', ...TOOLS] : closing ? [] : originalTools);
  };
  const update = (ctx: ExtensionContext) => {
    const state = engine?.status();
    if (ctx.hasUI && state) {
      ctx.ui.setStatus('hoh', `HoH ${state.checkpoint.state} ${state.checkpoint.iterations}/${state.header.config.maxIterations} best ${state.checkpoint.bestMetric ?? '—'}`);
      if (ctx.mode === 'tui') ctx.ui.setWidget('hoh', [
        `HoH · ${state.header.config.name} · ${state.checkpoint.state}`,
        ...state.decisions.slice(-6).map(d => `#${d.run} ${d.status.padEnd(13)} ${d.metric ?? '—'} ${d.candidateSha.slice(0, 8)} ${d.description}`),
      ]);
    }
  };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: {} });
  pi.registerTool({ name: TOOLS[0], label: 'Initialize experiment', description: 'Read the approved HoH configuration and current checkpoint. Never changes metric, tests, or acceptance policy.',
    parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => result(publicStatus(get(ctx))) });
  pi.registerTool({ name: TOOLS[1], label: 'Run experiment', description: 'Snapshot the assigned draft and repeatedly run frozen controller-owned measurements/checks. Uses fixed seed and returns exact evidence. No caller-provided command or metric.',
    parameters: Type.Object({}), execute: async (_id, _args, signal, _update, ctx) => {
      const e = get(ctx); const measurement = await e.run(signal); update(ctx); return result(measurement);
    } });
  pi.registerTool({ name: TOOLS[2], label: 'Log experiment', description: 'Record observations. HoH computes keep/discard from persisted evidence and thresholds; the model cannot choose status or supply scores. Repeated calls for the same run are idempotent.',
    parameters: Type.Object({ run: Type.Integer({ minimum: 0 }), description: Type.String({ minLength: 1, maxLength: 2000 }),
      hypothesis: Type.Optional(Type.String({ maxLength: 4000 })), learned: Type.Optional(Type.String({ maxLength: 4000 })), nextFocus: Type.Optional(Type.String({ maxLength: 4000 })) }),
    execute: async (_id, args, _signal, _update, ctx) => {
      if (typeof args.run !== 'number' || !args.description) throw new Error('A run number and description are required');
      const e = get(ctx), decision = await e.log(args.run, args as Notes); update(ctx);
      if (e.status()?.checkpoint.state !== 'RUNNING') { setMode(false, ctx); notify(ctx, publicStatus(e)); }
      return result(decision);
    } });
  pi.on('session_start', (_event, ctx) => {
    // Disk is the source of truth. Resumption is explicit; no auto-start billing after opening a project.
    if (active || closing) pi.setActiveTools(originalTools);
    active = false; closing = false;
    engine = new HoH(ctx.cwd); originalTools = pi.getActiveTools().filter(t => !TOOLS.includes(t)); pi.setActiveTools(originalTools); update(ctx);
  });
  pi.on('tool_call', event => {
    if (closing) return { block: true, reason: 'HoH is finishing this turn; no further tools may mutate the project' };
    if (!active) {
      if (TOOLS.includes(event.toolName)) return { block: true, reason: 'Activate HoH with /hoh start or /hoh resume first' };
      return;
    }
    const denied = engine?.guard(event.toolName, event.input as Record<string, unknown>);
    if (denied) return { block: true, reason: denied };
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!active || !engine?.status()) return;
    return { message: { customType: 'hoh-context', content: context(engine), display: false } };
  });
  pi.on('session_before_compact', (event, ctx) => {
    if (!active || !engine?.status()) return;
    return { compaction: { summary: context(engine), firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (!active || manual || !engine) return;
    if (ctx.signal?.aborted) return;
    const status = engine.status(); if (!status || status.checkpoint.state !== 'RUNNING') return;
    const progress = JSON.stringify([status.checkpoint.iterations, status.checkpoint.pending?.phase, status.checkpoint.draft?.run]);
    idleNudges = progress === lastProgress ? idleNudges + 1 : 0; lastProgress = progress;
    if (idleNudges >= 2) { await engine.pause(); setMode(false, ctx); notify(ctx, 'HoH paused: the agent made no experiment progress. Inspect the context before resuming.'); return; }
    if (!ctx.hasPendingMessages()) return { continue: true, entries: [{ type: 'custom_message' as const, customType: 'hoh-resume',
      content: context(engine), display: false }] };
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (closing) { closing = false; pi.setActiveTools(originalTools); }
    if (active && event.aborted && engine) { await engine.pause(); setMode(false, ctx); update(ctx); }
  });
  pi.registerCommand('hoh', {
    description: 'HoH autoresearch: start SPEC.md, resume, pause, stop, status, inspect',
    getArgumentCompletions: prefix => ['start', 'resume', 'pause', 'stop', 'status', 'inspect', 'help'].filter(x => x.startsWith(prefix)).map(x => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      const [verb = 'help', ...rest] = args.trim().split(/\s+/); const e = get(ctx);
      try {
        if (verb === 'status') { notify(ctx, publicStatus(e)); return; }
        if (verb === 'inspect') { notify(ctx, e.inspect() ?? 'No measurement yet'); return; }
        if (verb === 'pause' || verb === 'stop') { await e[verb](); if (verb === 'stop') ctx.abort(); setMode(false, ctx); update(ctx); notify(ctx, publicStatus(e)); return; }
        if (verb === 'start') {
          if (starting) throw new Error('A baseline is already starting');
          manual = rest.includes('--manual'); const spec = rest.filter(x => x !== '--manual').join(' ').replace(/^(["'])(.*)\1$/, '$2');
          if (!spec) throw new Error('Usage: /hoh start SPEC.md [--manual]');
          setMode(true); notify(ctx, 'Preparing the baseline and repeated independent measurements…');
          starting = e.start(spec).then(state => {
            update(ctx); notify(ctx, publicStatus(e));
            if (state.state !== 'RUNNING') setMode(false);
            else if (!manual) pi.sendUserMessage('Start the HoH loop: inspect the checkpoint, propose one hypothesis and edit only the assigned draft.');
          }).catch(error => { setMode(false); notify(ctx, (error as Error).message); }).finally(() => { starting = undefined; });
          return;
        }
        if (verb === 'resume') {
          manual = rest.includes('--manual'); const state = await e.resume();
          setMode(state.state === 'RUNNING'); update(ctx); notify(ctx, publicStatus(e));
          if (active && !manual) pi.sendUserMessage('Resume HoH from disk. Log a pending measurement before making any edits.'); return;
        }
        notify(ctx, 'Usage: /hoh start SPEC.md [--manual] | resume [--manual] | pause | stop | status | inspect');
      } catch (error) { notify(ctx, (error as Error).message); }
    },
  });
  pi.on('session_shutdown', async () => { if (engine?.status()?.checkpoint.state === 'RUNNING') await engine.interrupt(); if (starting) await starting; });
}
