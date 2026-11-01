// TEST FIXTURE for Batch Z: a real process that writes the APEX experience log while the test
// parent and other copies of itself do the same. Every attempt is reported as one `RESULT` line of
// JSON, so the parent asserts the authoritative records and derived lifecycle states rather than an
// exit code.
//   record-experience <dataDir> <writer> <operationIds,csv>
//   record-feedback   <dataDir> <writer> <experienceIds,csv> <assessment> <guidance>
//   derive            <dataDir> <writer>
//   decide            <dataDir> <writer> <adaptationId> <decision>
//   retire            <dataDir> <writer> <adaptationId>
//   hold-lock         <dataDir> <writer> <holdMs>   (0 holds until killed)
//   read-only         <dataDir> <writer>
//   read-loop         <dataDir> <writer> <expectedRecords> <ceilingMs>
// APEX_RACERS makes the copies start together; APEX_WAIT_MS bounds a writer's lock wait.
import fs from 'node:fs';
import path from 'node:path';
import { ExperienceStore } from '../../src/experience/experience-store.js';
import { OperationLog } from '../../src/operations/operation-log.js';
import { WriterLock } from '../../src/memory/writer-lock.js';

const [mode, dataDir, writer, arg3, arg4, arg5] = process.argv.slice(2);
const racers = Number(process.env.APEX_RACERS || '1');
const waitMs = process.env.APEX_WAIT_MS ? Number(process.env.APEX_WAIT_MS) : undefined;

const LOG = path.join(dataDir, 'experiences.jsonl');

function report(obj) {
  process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`);
}

function store() {
  // The audit log is configured because an experience is a verified reference to one audited event:
  // without it the store refuses every experience write, in this child exactly as in the app.
  return new ExperienceStore(LOG, {
    operations: new OperationLog(path.join(dataDir, 'operations.jsonl')),
    ...(waitMs ? { lockWaitMs: waitMs } : {}),
  });
}

const ids = (csv) => String(csv ?? '').split(',').filter((x) => x !== '');

// The writers start from the same instant, so a lost decision, a duplicated candidate or a write
// that derived from a state another process had already changed is reproduced rather than
// scheduled around. The barrier lives in its own directory: the store directory is asserted to hold
// only the files a write should leave.
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

  if (mode === 'record-experience') {
    const x = store();
    const targets = ids(arg3);
    for (let i = 0; i < targets.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`experience-${i}`, async () => {
        const { record } = await x.recordExperience({
          operationId: targets[i],
          subject: `event ${writer}-${i} as experienced`,
          origin: 'user',
        });
        return { id: record.id, operationId: record.operationId, capability: record.capability };
      });
    }
  } else if (mode === 'record-feedback') {
    const x = store();
    const targets = ids(arg3);
    for (let i = 0; i < targets.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`feedback-${i}`, async () => {
        const { record } = await x.recordFeedback({
          target: targets[i],
          assessment: arg4,
          guidance: arg5,
          origin: 'user',
        });
        return { id: record.id, experienceId: record.experienceId, assessment: record.assessment };
      });
    }
  } else if (mode === 'derive') {
    const x = store();
    await attempt('derive', async () => {
      const { created, skipped } = await x.deriveAdaptations({ origin: 'user' });
      return {
        created: created.map((c) => ({ id: c.id, capability: c.capability, rule: c.rule })),
        skipped: skipped.length,
      };
    });
  } else if (mode === 'decide') {
    const x = store();
    await attempt('decide', async () => {
      const { record, adaptation } = await x.decideAdaptation({
        target: arg3,
        decision: arg4,
        reason: `decided by writer ${writer}`,
        origin: 'user',
      });
      return { id: record.id, targetId: record.targetId, decision: record.decision, was: adaptation.decisionState };
    });
  } else if (mode === 'retire') {
    const x = store();
    await attempt('retire', async () => {
      const { record, adaptation } = await x.retireAdaptation({
        target: arg3,
        reason: `retired by writer ${writer}`,
        origin: 'user',
      });
      return { id: record.id, targetId: record.targetId, was: adaptation.decisionState };
    });
  } else if (mode === 'hold-lock') {
    const lock = new WriterLock(LOG, { waitMs: waitMs ?? 10000 });
    await lock.run(async () => {
      process.stdout.write(`HELD ${JSON.stringify({ pid: process.pid, file: path.basename(LOG) })}\n`);
      const ms = Number(arg3);
      if (ms > 0) await sleep(ms);
      else await new Promise(() => {}); // hold until the parent terminates this process
      return {};
    });
    report({ mode, writer, label: 'released', ok: true });
  } else if (mode === 'read-only') {
    const x = store();
    const before = fs.readdirSync(dataDir).sort().join(',');
    const experiences = await x.list({ limit: 50 });
    const adaptations = await x.adaptations({ limit: 50 });
    const active = await x.activeAdaptations({ query: 'answer in one line' });
    await x.status();
    await x.health();
    await x.evidenceCheck(experiences[0]?.id ?? 'none');
    await x.lockReport();
    const after = fs.readdirSync(dataDir).sort().join(',');
    report({
      mode,
      writer,
      label: 'reads',
      ok: true,
      experiences: experiences.length,
      adaptations: adaptations.length,
      active: active.adaptations.length,
      unchanged: before === after,
    });
  } else if (mode === 'read-loop') {
    // Raw byte reads while writers are appending, paced until the expected number of records has
    // arrived. Each read reports how many lines it saw, how many parsed as complete experience
    // records, and whether a cold read through the store answered or refused - so a torn line is
    // visible as a number and a refusal, never as a shorter list that looks like the whole store.
    const expected = Number(arg3);
    const ceiling = Date.now() + Number(arg4 ?? '20000');
    let reads = 0;
    let lastParsed = 0;
    for (;;) {
      const startedAt = Date.now();
      let entry;
      try {
        const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
        const lines = text.split('\n').filter((line) => line.trim() !== '');
        let parsed = 0;
        let torn = 0;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (typeof obj.id !== 'string' || typeof obj.kind !== 'string' || obj.schema === undefined) torn += 1;
            else parsed += 1;
          } catch {
            torn += 1;
          }
        }
        let storeRead = 'ok';
        try {
          const records = await store().list({ limit: 200 });
          storeRead = `ok:${records.length}`;
        } catch (err) {
          storeRead = String(err?.message ?? err);
        }
        entry = { lines: lines.length, parsed, torn, storeRead };
      } catch (err) {
        entry = { lines: 0, parsed: lastParsed, torn: 0, storeRead: `fatal`, code: err?.code ?? null, message: String(err?.message ?? err) };
      }
      reads += 1;
      lastParsed = entry.parsed;
      report({ mode, writer, label: `read-${reads}`, ok: true, ms: Date.now() - startedAt, ...entry });
      if (entry.parsed >= expected) break;
      if (Date.now() >= ceiling) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    report({ mode, writer, label: 'summary', ok: lastParsed >= expected, reads, lastParsed, expected });
    if (lastParsed < expected) process.exitCode = 1;
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report({ mode, writer, label: 'fatal', ok: false, code: err?.code ?? null, message: String(err?.message ?? err) });
  process.exitCode = 1;
}
