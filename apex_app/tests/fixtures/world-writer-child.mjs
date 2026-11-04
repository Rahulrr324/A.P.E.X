// TEST FIXTURE: a real process that appends user-origin world-model records while the parent and
// other copies of itself do the same. Each attempt is reported as one `RESULT` line of JSON.
//   create   <dataDir> <writer> <count>    create distinct entities through the store write path
//   fact     <dataDir> <writer> <count>    assert facts about the entity the parent seeded
// APEX_RACERS makes the copies start together; APEX_WAIT_MS bounds a writer's lock wait;
// APEX_NOW fixes the store clock, so every child writes against the same instant.
import fs from 'node:fs';
import path from 'node:path';
import { WorldModelStore } from '../../src/world/store.js';

const [mode, dataDir, writer, arg3] = process.argv.slice(2);
const racers = Number(process.env.APEX_RACERS || '1');
const waitMs = process.env.APEX_WAIT_MS ? Number(process.env.APEX_WAIT_MS) : undefined;
const clock = process.env.APEX_NOW ? () => new Date(process.env.APEX_NOW) : () => new Date();
const file = path.join(dataDir, 'world-model.jsonl');

function report(obj) {
  process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`);
}

function store() {
  return new WorldModelStore(file, {
    now: clock,
    ...(waitMs ? { lockWaitMs: waitMs } : {}),
  });
}

const userEvidence = () => [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function startTogether() {
  if (racers <= 1) return;
  const dir = path.join(dataDir, 'barrier');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ready-${process.pid}`), 'r');
  const ceiling = Date.now() + 20000;
  while (fs.readdirSync(dir).filter((f) => f.startsWith('ready-')).length < racers && Date.now() < ceiling) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

async function attempt(label, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    report({ mode, writer, label, ok: true, ms: Date.now() - startedAt, ...value });
  } catch (err) {
    report({
      mode,
      writer,
      label,
      ok: false,
      ms: Date.now() - startedAt,
      code: err?.code ?? null,
      message: String(err?.message ?? err),
    });
    process.exitCode = 1;
  }
}

try {
  startTogether();
  const count = Number(arg3 ?? '1');
  if (mode === 'create') {
    const x = store();
    for (let i = 0; i < count; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`create-${i}`, async () => {
        const { record } = await x.createEntity({
          origin: 'user',
          entityId: `e-w${writer}-${String(i).padStart(3, '0')}`,
          category: 'product',
          name: `Writer ${writer} entity ${i}`,
          evidence: userEvidence(),
        });
        return { id: record.entityId };
      });
    }
  } else if (mode === 'fact') {
    const x = store();
    for (let i = 0; i < count; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`fact-${i}`, async () => {
        const { record } = await x.assertFact({
          origin: 'user',
          factId: `f-w${writer}-${String(i).padStart(3, '0')}`,
          subjectId: 'e-0000',
          predicate: 'described_as',
          object: { kind: 'scalar', valueType: 'string', value: `writer ${writer} claim ${i}` },
          validFrom: clock().toISOString(),
          evidence: userEvidence(),
        });
        return { id: record.factId };
      });
    }
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report({ mode, writer, label: 'fatal', ok: false, code: err?.code ?? null, message: String(err?.message ?? err) });
  process.exitCode = 1;
}
