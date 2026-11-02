// TEST FIXTURE for Batch AE: a real process that writes the APEX prediction ledger while the test
// parent and other copies of itself do the same. Every attempt is reported as one `RESULT` line of
// JSON, so the parent asserts the authoritative records and the derived lifecycle states rather than
// an exit code.
//   record        <dataDir> <writer> <capability,csv> [expectation] [subject]   standing expectations
//   evaluate      <dataDir> <writer> <predictionId,csv>
//   invalidate    <dataDir> <writer> <predictionId,csv> <reason>
//   replace       <dataDir> <writer> <targetId> [expectation]                   one expectation replacing one
//   cite          <dataDir> <writer> <experienceId,csv>                         record citing experience ids
//   model-write   <dataDir> <writer>                                            the refused model-origin attempt
//   hold-lock     <dataDir> <writer> <holdMs>          (0 holds until killed)
//   read-only     <dataDir> <writer>
//   read-loop     <dataDir> <writer> <expectedRecords> <ceilingMs>
//   raw-append    <dataDir> <writer> <jsonLine> [noNewline]                     install damage, not a store write
// APEX_RACERS makes the copies start together; APEX_WAIT_MS bounds a writer's lock wait;
// APEX_NOW fixes the store clock, so a child records against the same instant the parent's fixtures
// were dated at and the parent can read the same derived lifecycle state back; APEX_HORIZON names the
// horizon exactly, so two writers recording one expectation cannot differ by a millisecond;
// APEX_PROGRESS_AFTER makes a writer print PROGRESS once it has appended its first record, so the
// parent can interrupt it between writes.
import fs from 'node:fs';
import path from 'node:path';
import { PredictionStore } from '../../src/prediction/prediction-store.js';
import { ExperienceStore } from '../../src/experience/experience-store.js';
import { OperationLog } from '../../src/operations/operation-log.js';
import { WriterLock } from '../../src/memory/writer-lock.js';

const [mode, dataDir, writer, arg3, arg4, arg5] = process.argv.slice(2);
const racers = Number(process.env.APEX_RACERS || '1');
const waitMs = process.env.APEX_WAIT_MS ? Number(process.env.APEX_WAIT_MS) : undefined;
const clock = process.env.APEX_NOW ? () => new Date(process.env.APEX_NOW) : () => new Date();
const ledgerPath = path.join(dataDir, 'predictions.jsonl');

function report(obj) {
  process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`);
}

// Built the way the app builds it: the ledger is given the experience log, because a citation that
// does not resolve there is refused and every horizon is re-opened against it on read.
function store() {
  const operations = new OperationLog(path.join(dataDir, 'operations.jsonl'));
  const experiences = new ExperienceStore(path.join(dataDir, 'experiences.jsonl'), { now: clock, operations });
  return new PredictionStore(ledgerPath, {
    now: clock,
    ...(waitMs ? { lockWaitMs: waitMs } : {}),
    experiences,
  });
}

const ids = (csv) => String(csv ?? '').split(',').filter((x) => x !== '');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// One whole-file read, counted by hand: complete records, and everything that is not one. A torn
// append shows up as `torn` rather than as a shorter ledger.
function sampleLedger() {
  const text = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
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
  return { lines: lines.length, parsed, torn };
}

// The writers start from the same instant, so a duplicated expectation, a lost verdict, or a write
// that derived from a state another process had already changed is reproduced rather than scheduled
// around. The barrier is in its own directory: the ledger directory is asserted to hold only the
// files a write should leave.
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

// APEX_HORIZON names one instant exactly, so two writers racing over one expectation compete over the
// same record rather than over two horizons a millisecond apart.
const horizon = (days = 30) => process.env.APEX_HORIZON
  ?? new Date(clock().getTime() + days * 86400000).toISOString();

try {
  startTogether();

  if (mode === 'record') {
    const x = store();
    const capabilities = ids(arg3);
    for (let i = 0; i < capabilities.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`record-${i}`, async () => {
        const { record } = await x.recordPrediction({
          capability: capabilities[i],
          expectation: arg4 ?? 'success',
          subject: arg5 ?? `writer ${writer} expects capability ${capabilities[i]} to report its next outcome`,
          expiresAt: horizon(),
          origin: 'user',
          provenance: { operationId: `fixture-${writer}-${i}` },
        });
        if (process.env.APEX_PROGRESS_AFTER === '1') process.stdout.write(`PROGRESS ${record.id}\n`);
        return { id: record.id, capability: record.capability, expectation: record.expectation };
      });
      if (process.env.APEX_PROGRESS_AFTER === '1' && i === 0) {
        // Stay alive for the parent to interrupt between writes.
        await sleep(30000);
      }
    }
  } else if (mode === 'evaluate') {
    const x = store();
    const targets = ids(arg3);
    for (let i = 0; i < targets.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`evaluate-${i}`, async () => {
        const { record, projection, reason } = await x.recordEvaluation({
          target: targets[i],
          origin: 'user',
          provenance: { operationId: `fixture-eval-${writer}` },
        });
        return {
          id: record?.id ?? null,
          verdict: record?.verdict ?? null,
          reason: reason ?? null,
          state: projection?.status ?? null,
          decision: projection?.evaluationDecision ?? null,
        };
      });
    }
  } else if (mode === 'invalidate') {
    const x = store();
    const targets = ids(arg3);
    for (let i = 0; i < targets.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await attempt(`invalidate-${i}`, async () => {
        const { record } = await x.invalidatePrediction({
          target: targets[i],
          reason: arg4 ?? `withdrawn by writer ${writer}`,
          origin: 'user',
          provenance: { operationId: `fixture-inv-${writer}` },
        });
        return { id: record.id, predictionId: record.predictionId };
      });
    }
  } else if (mode === 'replace') {
    const x = store();
    await attempt('replace', async () => {
      const { record } = await x.recordPrediction({
        capability: 'calc.evaluate',
        expectation: arg4 ?? 'success',
        subject: `writer ${writer} replaces the standing expectation with a later one`,
        expiresAt: horizon(),
        replaces: [arg3],
        origin: 'user',
        provenance: { operationId: `fixture-replace-${writer}` },
      });
      return { id: record.id, replaces: record.replaces };
    });
  } else if (mode === 'cite') {
    const x = store();
    await attempt('cite', async () => {
      const { record } = await x.recordPrediction({
        capability: 'calc.evaluate',
        expectation: arg4 ?? 'success',
        subject: `writer ${writer} cites recorded events`,
        expiresAt: horizon(),
        evidence: { supportingExperienceIds: ids(arg3) },
        origin: 'user',
        provenance: { operationId: `fixture-cite-${writer}` },
      });
      return { id: record.id, cited: record.evidence.supportingExperienceIds.length };
    });
  } else if (mode === 'model-write') {
    // Authorization is decided before the lock is sought, so a refused model-origin write must leave
    // neither a ledger line nor a claim on the write lock.
    const x = store();
    const before = fs.readdirSync(dataDir).sort().join(',');
    await attempt('model-write', async () => {
      const { record } = await x.recordPrediction({
        capability: 'calc.evaluate',
        expectation: 'success',
        subject: 'a model claims this outcome is expected',
        expiresAt: horizon(),
        origin: 'model',
      });
      return { id: record.id };
    });
    const after = fs.readdirSync(dataDir).sort().join(',');
    report({ mode, writer, label: 'directory', ok: before === after, before, after, lockSeen: after.includes('predictions.jsonl.lock') });
  } else if (mode === 'hold-lock') {
    const lock = new WriterLock(ledgerPath, { waitMs: waitMs ?? 10000 });
    await lock.run(async () => {
      process.stdout.write(`HELD ${JSON.stringify({ pid: process.pid, file: path.basename(ledgerPath) })}\n`);
      const ms = Number(arg3);
      if (ms > 0) await sleep(ms);
      else await new Promise(() => {}); // hold until the parent terminates this process
      return {};
    });
    report({ mode, writer, label: 'released', ok: true });
  } else if (mode === 'read-only') {
    const x = store();
    const before = fs.readdirSync(dataDir).sort().join(',');
    const listed = await x.list({ limit: 50 });
    const first = listed.projections[0]?.id ?? 'none';
    let detail = null;
    let readError = null;
    try {
      detail = await x.detail(first);
      await x.history(first);
      await x.calibration({});
      await x.promptView({});
      await x.status();
      await x.health();
      await x.lockReport();
    } catch (err) {
      readError = String(err?.message ?? err);
    }
    const after = fs.readdirSync(dataDir).sort().join(',');
    report({
      mode,
      writer,
      label: 'reads',
      ok: true,
      listed: listed.projections.length,
      detail: detail ? `${detail.status}/${detail.evaluation ? 'evaluated' : 'unrecorded'}` : null,
      readError,
      unchanged: before === after,
    });
  } else if (mode === 'read-loop') {
    // Raw byte reads while writers append, paced until the expected number of records has arrived.
    // A torn line must be visible as a number and a refusal, never as a shorter list.
    const expected = Number(arg3);
    const ceiling = Date.now() + Number(arg4 ?? '20000');
    let reads = 0;
    let lastParsed = 0;
    for (;;) {
      const startedAt = Date.now();
      let entry;
      try {
        const { parsed, torn, lines } = sampleLedger();
        let storeRead = 'ok';
        let parsedAfter = parsed;
        try {
          const listed = await store().list({ limit: 200 });
          storeRead = `ok:${listed.projections.length}`;
          parsedAfter = sampleLedger().parsed;
        } catch (err) {
          storeRead = String(err?.message ?? err);
        }
        entry = { lines, parsed, torn, parsedAfter, storeRead };
      } catch (err) {
        entry = { lines: 0, parsed: lastParsed, torn: 0, storeRead: 'fatal', code: err?.code ?? null, message: String(err?.message ?? err) };
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
  } else if (mode === 'raw-append') {
    // Damage is installed by this fixture rather than by the store, so a test can show what a reader
    // does with a line no writer could have produced - including one with no trailing newline, which
    // is what a process killed mid-append leaves behind.
    const text = `${arg3}\n`;
    fs.appendFileSync(ledgerPath, arg4 === 'no-newline' ? `${arg3}` : text);
    report({ mode, writer, label: 'raw-append', ok: true, bytes: text.length });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report({ mode, writer, label: 'fatal', ok: false, code: err?.code ?? null, message: String(err?.message ?? err) });
  process.exitCode = 1;
}
