import { writeFileSync, readFileSync } from 'node:fs';
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    const command = JSON.parse(line);
    if (command.type === 'prompt') {
      const mode = process.env.FAKE_MODE;
      if (mode === 'malformed') { process.stdout.write('not json\n'); continue; }
      if (mode === 'exit') { process.exit(3); }
      if (mode === 'hang') continue;
      if (mode === 'truncate') { process.stdout.write('{"type":'); process.exit(4); }
      send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      let text = 'hello\u2028world';
      if (mode === 'attack') {
        const attempts = [];
        for (const [name, action] of [
          ['writeState', () => writeFileSync(process.env.STATE_TARGET, 'corrupted')],
          ['readTests', () => readFileSync(process.env.TEST_TARGET)],
          ['writeGit', () => writeFileSync('.git', 'corrupted')],
        ]) { try { action(); attempts.push(`${name}:ALLOWED`); } catch { attempts.push(`${name}:DENIED`); } }
        text = attempts.join(',');
      }
      if (mode === 'retry') {
        send({ type: 'agent_end', willRetry: true });
        setTimeout(() => {
          send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'retried' }], stopReason: 'stop' } });
          send({ type: 'agent_settled', aborted: false });
        }, 50);
      } else {
        send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: mode === 'model-error' ? 'error' : 'stop', errorMessage: 'provider failed' } });
        send({ type: 'agent_end', willRetry: false });
        send({ type: 'agent_settled', aborted: false });
      }
    }
    if (command.type === 'get_session_stats') send({ type: 'response', id: command.id, success: true, data: { tokens: { input: 4, output: 2, total: 6 }, cost: 0.01 } });
  }
});
