import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Controller } from './core/controller.js';
import { command, verbs } from './core/commands.js';
import { footer } from './ui/status.js';

export default function hohExtension(pi: ExtensionAPI): void {
  const controllers = new Map<string, Controller>();
  const contexts = new Map<string, ExtensionCommandContext>();
  const show = (ctx: ExtensionCommandContext, output: unknown, error = false) => {
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    if (ctx.hasUI) ctx.ui.notify(text, error ? 'error' : 'info');
    else pi.sendMessage({ customType: 'hoh-status', content: text, display: true }, { triggerTurn: false });
  };
  pi.registerCommand('hoh', {
    description: `HoH evidence-driven supervision: ${verbs.join(', ')}`,
    handler: async (args, ctx) => {
      try {
        contexts.set(ctx.cwd, ctx);
        let controller = controllers.get(ctx.cwd);
        if (!controller) {
          controller = new Controller(ctx.cwd, { onChange: run => {
            const current = contexts.get(ctx.cwd);
            if (current?.mode === 'tui') current.ui.setStatus('hoh', footer(run));
          } }); controllers.set(ctx.cwd, controller);
        }
        const trimmed = args.trim(), boundary = trimmed.indexOf(' ');
        const verb = boundary < 0 ? trimmed : trimmed.slice(0, boundary);
        const argument = boundary < 0 ? '' : trimmed.slice(boundary + 1).trim();
        const result = await command(controller, verb || 'status', argument);
        show(ctx, result.output);
        if (result.dispatch) {
          const active = controller;
          void active.drive(result.runId).then(() => show(ctx, { runId: result.runId, state: active.status(result.runId)?.state,
            blocker: active.status(result.runId)?.blocker })).catch(e => show(ctx, (e as Error).message, true));
        }
      } catch (e) { show(ctx, (e as Error).message, true); }
    },
  });
  pi.on('session_shutdown', async () => {
    for (const controller of controllers.values()) { await controller.shutdown(); controller.close(); }
    controllers.clear(); contexts.clear();
  });
}
