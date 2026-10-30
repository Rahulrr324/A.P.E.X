// TEST FIXTURE for 061: a real process that tries to hold the task lock and reports what it
// was allowed to do. It prints one line per event to the trace file given by APEX_TRACE:
//   ENTER <pid> / LEAVE <pid>  inside the critical section (the hold is APEX_HOLD_MS long)
//   ACQUIRED <pid>             the lock was held and released normally
//   refused <pid>: <message>   the lock was refused
// It performs no task work: it shows only whether the lock itself was exclusive.
import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from '../../src/tasks/store.js';

const dataDir = process.argv[2];
const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
const traceFile = process.env.APEX_TRACE;
const racers = Number(process.env.APEX_RACERS || '1');
const holdMs = Number(process.env.APEX_HOLD_MS || '120');
const mark = (line) => fs.appendFileSync(traceFile, `${line}\n`);

// Every racer writes a ready marker first, so none starts before all are alive. This is a
// barrier, not a delay: the wait ends when the last process appears, or after the ceiling.
fs.writeFileSync(path.join(dataDir, `ready-${process.pid}`), 'r');
const ceiling = Date.now() + 10000;
while (
  fs.readdirSync(dataDir).filter((f) => f.startsWith('ready-')).length < racers
  && Date.now() < ceiling
) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

try {
  await store.withLock(async () => {
    mark(`ENTER ${process.pid}`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    mark(`LEAVE ${process.pid}`);
  });
  mark(`ACQUIRED ${process.pid}`);
} catch (err) {
  mark(`refused ${process.pid}: ${err.message}`);
}
