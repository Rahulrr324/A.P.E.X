// TEST FIXTURE for Batch W: a real process that writes APEX memory and knowledge stores,
// holds one store's writer lock, or only reads, while the test parent and other copies of
// itself do the same. Every attempt is reported as one `RESULT` line of JSON, so the parent
// asserts the authoritative records and lifecycle states rather than an exit code.
//   add-memory          <dataDir> <writer> <count>
//   correct-memory      <dataDir> <writer> <targetId>
//   add-knowledge       <dataDir> <writer> <count>
//   conflict-knowledge  <dataDir> <writer> <object>
//   supersede-knowledge <dataDir> <writer> <targetId>
//   retract-knowledge   <dataDir> <writer> <targetId>
//   resolve-knowledge   <dataDir> <writer> <targetId> <chooseId>
//   hold-lock           <dataDir> <store> <holdMs>   (store = memory|knowledge; 0 holds until killed)
//   read-only           <dataDir>
// APEX_RACERS makes the copies start together; APEX_WAIT_MS bounds a writer's lock wait.
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { KnowledgeStore } from '../../src/knowledge/knowledge-store.js';
import { WriterLock } from '../../src/memory/writer-lock.js';

const [mode, dataDir, idText, arg3, arg4] = process.argv.slice(2);
// The writer label stays a string: a stress round labels its writers `2-1`, and every claim has to
// stay distinct across rounds.
const writer = idText;
const racers = Number(process.env.APEX_RACERS || '1');
const waitMs = process.env.APEX_WAIT_MS ? Number(process.env.APEX_WAIT_MS) : undefined;

function report(obj) {
  process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`);
}

function memoryStore() {
  return new MemoryStore(path.join(dataDir, 'memory.jsonl'), waitMs ? { lockWaitMs: waitMs } : {});
}

function knowledgeStore() {
  return new KnowledgeStore(path.join(dataDir, 'knowledge.jsonl'), waitMs ? { lockWaitMs: waitMs } : {});
}

// The writers start from the same instant, so a lost decision or a stale-state write is
// reproduced rather than scheduled around. The barrier lives in its own directory: the
// store directories are asserted to hold exactly the files a write should leave.
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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

  if (mode === 'add-memory') {
    const store = memoryStore();
    for (let i = 0; i < Number(arg3); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`memory-${i}`, async () => {
        const record = await store.add({ content: `fact from writer ${writer} number ${i}` });
        return { id: record.id, content: record.content };
      });
    }
  } else if (mode === 'correct-memory') {
    const store = memoryStore();
    await attempt('correct', async () => {
      // The replacement has to contradict the seeded claim in the store's own clause form
      // ("the launch code name is …"), otherwise the store refuses it as not a correction at all.
      const record = await store.correct({
        targetId: arg3,
        content: `the launch code name is corrected by writer ${writer}`,
        origin: 'user',
      });
      return { id: record.id, replaces: record.provenance?.replaces ?? null };
    });
  } else if (mode === 'add-knowledge') {
    const store = knowledgeStore();
    for (let i = 0; i < Number(arg3); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`knowledge-${i}`, async () => {
        const res = await store.add({
          subject: `claim ${writer}-${i}`,
          relationship: 'recorded by test',
          object: `number ${i}`,
          origin: 'user',
        });
        return { id: res.record.id, status: res.record.status, conflictingIds: res.conflictingIds };
      });
    }
  } else if (mode === 'conflict-knowledge') {
    const store = knowledgeStore();
    await attempt('conflict', async () => {
      const res = await store.add({
        subject: 'the launch code name',
        relationship: 'is',
        object: arg3,
        origin: 'user',
      });
      return { id: res.record.id, status: res.record.status, conflictingIds: res.conflictingIds };
    });
  } else if (mode === 'supersede-knowledge') {
    const store = knowledgeStore();
    await attempt('supersede', async () => {
      const res = await store.add({
        subject: 'the launch code name',
        relationship: 'is',
        object: `replacement by writer ${writer}`,
        origin: 'user',
        supersedes: [arg3],
      });
      return { id: res.record.id, supersededIds: res.supersededIds, status: res.record.status };
    });
  } else if (mode === 'retract-knowledge') {
    const store = knowledgeStore();
    await attempt('retract', async () => {
      const res = await store.retract({ target: arg3, reason: `retracted by writer ${writer}`, origin: 'user' });
      return { id: res.event.id, targetId: res.event.targetId };
    });
  } else if (mode === 'resolve-knowledge') {
    const store = knowledgeStore();
    await attempt('resolve', async () => {
      const res = await store.resolve({ target: arg3, choose: arg4, reason: `chosen by writer ${writer}`, origin: 'user' });
      return { id: res.event.id, targetIds: res.event.targetIds, chosenId: res.event.chosenId };
    });
  } else if (mode === 'hold-lock') {
    // `hold-lock <dataDir> <store> <holdMs>`: the store name arrives in the writer slot and the
    // hold duration in the first argument slot, because this mode has no writer or count.
    const file = idText === 'knowledge' ? 'knowledge.jsonl' : 'memory.jsonl';
    const lock = new WriterLock(path.join(dataDir, file), { waitMs: waitMs ?? 10000 });
    await lock.run(async () => {
      process.stdout.write(`HELD ${JSON.stringify({ pid: process.pid, file })}\n`);
      const ms = Number(arg3);
      if (ms > 0) await sleep(ms);
      else await new Promise(() => {}); // hold until the parent terminates this process
      return {};
    });
    report({ mode, writer: idText, label: 'released', ok: true });
  } else if (mode === 'read-only') {
    const memory = memoryStore();
    const knowledge = knowledgeStore();
    const before = fs.readdirSync(dataDir).sort().join(',');
    const records = await memory.list({ limit: 50 });
    const search = await memory.search('fact', { limit: 50 });
    const claims = await knowledge.list({ limit: 50 });
    const ksearch = await knowledge.search('claim', { limit: 50 });
    await memory.status();
    await memory.health();
    await knowledge.status();
    await knowledge.health();
    await knowledge.history(claims[0]?.id ?? 'none');
    const after = fs.readdirSync(dataDir).sort().join(',');
    report({
      mode,
      writer,
      label: 'reads',
      ok: true,
      memoryRecords: records.length,
      memoryMatches: search.length,
      knowledgeClaims: claims.length,
      knowledgeMatches: ksearch.length,
      unchanged: before === after,
    });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report({ mode, writer, label: 'fatal', ok: false, code: err?.code ?? null, message: String(err?.message ?? err) });
  process.exitCode = 1;
}
