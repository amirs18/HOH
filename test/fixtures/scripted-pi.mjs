#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const send = r => process.stdout.write(JSON.stringify(r) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n'), record = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (record.type === 'prompt') {
      send({ id: record.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      let text;
      if (record.message.includes('You are the HoH planner')) {
        const sourceSpecHash = record.message.match(/Source hash: ([a-f0-9]{64})/)[1];
        const requirements = JSON.parse(record.message.match(/Authoritative requirements \(copy exactly\): (.*)\n/)[1]);
        text = JSON.stringify({ contract: { schemaVersion: 1, sourceSpecHash, productGoal: 'Arithmetic API', constraints: ['Preserve multiplication'],
          requirements, unresolvedDecisions: [] }, tasks: [{ id: 'T1', title: 'Fix addition', requirementIds: ['R1'], scope: 'Correct addition', dependencies: [],
            objectiveChecks: ['acceptance', 'regression'], exitCriteria: ['Acceptance and regression pass'] }] });
      } else if (record.message.startsWith('Implement only this vertical slice')) {
        writeFileSync(join(process.cwd(), 'app.mjs'), `export function add(a,b){return ${basename(process.cwd()).endsWith('-1') ? '42' : 'a+b'};}\nexport function multiply(a,b){return a*b;}\n`);
        text = 'Done, absolutely perfect'; // Prose cannot compensate for a failed check.
      } else if (record.message.includes('independent read-only HoH reviewer')) text = '{"findings":[]}';
      else text = '{"hypothesis":"incorrect addition","strategy":"use a+b"}';
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } });
      send({ type: 'agent_settled', aborted: false });
    }
    if (record.type === 'get_session_stats') send({ id: record.id, type: 'response', success: true, data: { tokens: { input: 0, output: 0, total: 0 }, cost: 0 } });
  }
});
