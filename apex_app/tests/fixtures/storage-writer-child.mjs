// TEST FIXTURE for Batch F / 065: a real process that appends to APEX stores while
// other copies of itself do the same. It waits at a file barrier so the writers start
// together, then performs its own appends and reports the outcome on stdout.
//   append-jsonl <file> <writerId> <count> <padBytes>
//   add-memory   <dataDir> <writerId> <count>
//   append-ops   <dataDir> <writerId> <count>
import fs from 'node:fs';
import path from 'node:path';
import { JsonlStore } from '../../src/memory/jsonl-store.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { OperationLog } from '../../src/operations/operation-log.js';

const [mode, target, idText, countText, padText] = process.argv.slice(2);
const writer = Number(idText);
const count = Number(countText);
const pad = Number(padText || '0');
const dir = mode === 'append-jsonl' ? path.dirname(target) : target;
const racers = Number(process.env.APEX_RACERS || '1');

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `ready-${process.pid}`), 'r');
const ceiling = Date.now() + 15000;
while (fs.readdirSync(dir).filter((f) => f.startsWith('ready-')).length < racers && Date.now() < ceiling) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

try {
  if (mode === 'append-jsonl') {
    const store = new JsonlStore(target);
    for (let i = 0; i < count; i += 1) {
      await store.append({ writer, seq: i, pad: 'x'.repeat(pad), markerEnd: 'END' });
    }
  } else if (mode === 'add-memory') {
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    for (let i = 0; i < count; i += 1) {
      await store.add({ content: `fact from writer ${writer} number ${i}` });
    }
  } else if (mode === 'append-ops') {
    const log = new OperationLog(path.join(dir, 'operations.jsonl'));
    for (let i = 0; i < count; i += 1) {
      await log.append({
        schema: 1,
        app: 'APEX',
        stage: 'Local Alpha',
        id: `op-${writer}-${i}`,
        requestedAt: new Date().toISOString(),
        origin: 'user',
        request: `request ${writer}/${i}`,
        capability: 'probe',
        retrieval: [],
        prompt: null,
        backend: null,
        model: null,
        steps: [],
        status: 'success_verified',
        decision: 'success',
        output: 'probe result',
        errors: [],
        finishedAt: new Date().toISOString(),
      });
    }
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  console.log(`done ${writer}`);
} catch (err) {
  console.log(`failed ${writer}: ${err.message}`);
  process.exitCode = 1;
}
