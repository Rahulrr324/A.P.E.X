// TEST FIXTURE for 077: a real process that adds one task-summary intent to the
// delivery queue. Every racer writes a ready marker first, so none starts before all
// are alive; the wait ends when the last process appears, or after the ceiling.
// It prints one JSON line reporting whether the intent was queued, or the error.
import fs from 'node:fs';
import path from 'node:path';
import { SummaryQueue } from '../../src/tasks/summary-queue.js';

const dataDir = process.argv[2];
const taskId = process.argv[3];
const queue = new SummaryQueue(path.join(dataDir, 'task-summary-queue.json'));
const racers = Number(process.env.APEX_RACERS || '1');

fs.writeFileSync(path.join(dataDir, `ready-${process.pid}`), 'r');
const ceiling = Date.now() + 10000;
while (
  fs.readdirSync(dataDir).filter((f) => f.startsWith('ready-')).length < racers
  && Date.now() < ceiling
) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

try {
  const result = await queue.add({
    sessionId: 's1',
    taskId,
    signature: 'a'.repeat(64),
    text: `summary for ${taskId}`,
    verified: true,
  });
  console.log(JSON.stringify(result));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
}
