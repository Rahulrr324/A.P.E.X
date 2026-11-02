// Batch AE (AE-07): cross-process coordination of the prediction ledger, tested with real child
// processes.
//
// Every prediction write reads the whole authoritative ledger, derives one decision from it (does
// this standing expectation already exist, is the prediction being replaced still standing, has this
// expectation already been evaluated or withdrawn, does the horizon hold an outcome that establishes
// a verdict?), and then appends. Two processes doing that without coordination each "succeed" while
// one logical outcome is lost: the same expectation recorded twice, one replaced prediction with two
// successors, one expectation with two verdicts, or a withdrawal that raced the evaluation it should
// never have followed. `src/memory/writer-lock.js` covers that read-derive-append section for this
// store exactly as it does for memory, knowledge and experience.
//
// What makes this ledger a harder case than the three stores before it is that its lifecycle is not
// in the record. A status, a verdict and an evidence lineage are computed on every read from
// predictions.jsonl plus experiences.jsonl, so a lost decision here does not show up as a stored
// field that disagrees with the log - it shows up as a ledger that supports two answers to "what did
// the user expect, and what established the outcome?". So the scenarios below assert the authoritative
// records and the derived states a fresh reader reports, never exit codes:
//   A concurrent appends   B one successor, one verdict, one withdrawal
//   C a held lock, a dead holder, a killed writer, a damaged ledger, readers alongside writers
//   D the trust boundary and the operational surface: coordination is not authority.
//
// A model-origin write is refused before a lock is ever sought, so "took the lock" can never be what
// made a ledger write legitimate. No test in this file contacts a model, starts an inference service,
// or downloads anything; the audited events the expectations are dated against are written by the real
// stores on a fixed clock in a temporary directory.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';
import { PredictionStore } from '../src/prediction/prediction-store.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { WriterLock, WRITE_LOCK_WAIT_MS } from '../src/memory/writer-lock.js';
import { TAKEOVER_EPOCHS } from '../src/tasks/lock-recovery.js';
import { Outcome, OPERATION_SCHEMA } from '../src/outcomes.js';
import { EVALUATION_KIND, INVALIDATION_KIND, PREDICTION_KIND } from '../src/prediction/prediction-engine.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'prediction-writer-child.mjs');
const LEDGER = (dir) => path.join(dir, 'predictions.jsonl');
const EXP = (dir) => path.join(dir, 'experiences.jsonl');
const OPS = (dir) => path.join(dir, 'operations.jsonl');
const LOCK = (dir) => `${LEDGER(dir)}.lock`;

// One fixed instant for the parent and every child, so a horizon written by one process is measured
// against the same "now" the parent reads it back at. APEX_HORIZON then names one bound exactly: two
// writers competing over one expectation compete over the same record, not over two horizons a
// millisecond apart.
const DAY = 86_400_000;
const NOW_ISO = '2026-11-05T09:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const CLOCK = () => new Date(NOW_MS);
const HORIZON_ISO = new Date(NOW_MS + 30 * DAY).toISOString();
const instant = (days) => new Date(NOW_MS + days * DAY).toISOString();

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

// A fresh instance on purpose: a test must not read a lifecycle state out of the same in-memory
// snapshot that wrote it, the way a second APEX process has to re-derive it from disk.
function parentStores(dir, options = {}) {
  const operations = new OperationLog(OPS(dir));
  const experience = new ExperienceStore(EXP(dir), { now: CLOCK, operations });
  const predictions = new PredictionStore(LEDGER(dir), {
    now: CLOCK,
    experiences: experience,
    ...options,
  });
  return { dir, operations, experience, predictions };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function readRecords(file) {
  return readLines(file).map((line) => JSON.parse(line));
}

function ledgerOf(dir) {
  return readLines(LEDGER(dir)).map((line) => line.trim());
}

function expectations(dir) {
  return readRecords(LEDGER(dir)).filter((r) => r.kind === PREDICTION_KIND);
}

function byKind(dir) {
  const groups = new Map();
  for (const record of readRecords(LEDGER(dir))) groups.set(record.kind, (groups.get(record.kind) ?? 0) + 1);
  return groups;
}

// Anything a coordinated write is expected to clean up. A refusal that leaves a claim behind is
// correct only when the claim belongs to a live holder the test itself installed.
function residue(dir) {
  return fs.readdirSync(dir).filter((name) => (
    name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')
  ));
}

function claim(pid, nonce = 'fixture') {
  return JSON.stringify({ pid, nonce, at: new Date(NOW_MS).toISOString() });
}

// Takeover tokens are named by the digest of the claim they belong to, so an exhausted-takeover
// fixture has to derive the same prefix WriterLock does rather than invent one.
function keyOf(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function writeTokens(lockPath, raw, count = TAKEOVER_EPOCHS) {
  const key = keyOf(raw);
  const tokens = [];
  for (let epoch = 0; epoch < count; epoch += 1) {
    const token = `${lockPath}.takeover.${key}.${epoch}`;
    fs.writeFileSync(token, claim(deadPid()));
    tokens.push(token);
  }
  return tokens;
}

function resultsOf(out) {
  return out.split('\n').filter((line) => line.startsWith('RESULT ')).map((line) => JSON.parse(line.slice('RESULT '.length)));
}

function startChild(args, { racers = 1, waitMs = null, progress = false } = {}) {
  const env = cleanEnv({
    APEX_RACERS: String(racers),
    APEX_NOW: NOW_ISO,
    APEX_HORIZON: HORIZON_ISO,
  });
  if (waitMs !== null) env.APEX_WAIT_MS = String(waitMs);
  if (progress) env.APEX_PROGRESS_AFTER = '1';
  const child = spawn(process.execPath, [CHILD, ...args], { env, cwd: APP_ROOT, windowsHide: true });
  let out = '';
  let exitInfo = null;
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
  const waitFor = (predicate, ceilingMs = 25000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const hit = predicate(out);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (exitInfo || Date.now() - startedAt > ceilingMs) {
        clearInterval(timer);
        reject(new Error(`child ${args.join(' ')} did not report what was expected (exit ${exitInfo?.code ?? 'still running'}):\n${out}`));
      }
    }, 10);
  });
  return {
    child,
    exit,
    waitFor,
    get out() { return out; },
    get results() { return resultsOf(out); },
  };
}

async function runChild(args, opts) {
  const handle = startChild(args, opts);
  const done = await handle.exit;
  return { ...done, out: handle.out, results: handle.results };
}

async function runTogether(runs) {
  const out = [];
  for (const handle of runs) out.push({ ...(await handle.exit), out: handle.out, results: resultsOf(handle.out) });
  return out;
}

// ---- deterministic audited evidence, written by the real stores ---------------------------------

let seq = 0;

// One audited event and the user's experience of it. `at` is the instant the event happened: a record
// dated before an expectation was made is prior evidence and can be cited; one dated after it, inside
// the horizon, is what establishes the outcome and can never be cited as original support.
async function event(stores, { capability, at, outcome = Outcome.SUCCESS_VERIFIED, subject = 'the release train ran as scheduled' }) {
  seq += 1;
  const operationId = `op-${String(seq).padStart(4, '0')}`;
  await stores.operations.append({
    schema: OPERATION_SCHEMA, id: operationId, capability, origin: 'user', decision: 'answer',
    status: outcome, requestedAt: at, finishedAt: at, output: 'verified',
  });
  const { record } = await stores.experience.recordExperience({ operationId, subject, origin: 'user' });
  return record;
}

// One standing expectation, recorded by a real writer process so the ledger the race begins from is
// the ledger a second APEX process would read.
async function seededPrediction(dir, capability, writer = 'p') {
  const created = await runChild(['record', dir, writer, capability, 'success', `writer ${writer} expects ${capability} to report its next outcome`], {});
  assert.equal(created.code, 0, created.out);
  assert.equal(created.results[0].ok, true, JSON.stringify(created.results[0]));
  return created.results[0].id;
}

const csv = (list) => list.join(',');
// The fixture also reports bookkeeping lines (a directory diff, a raw damage append, a read summary).
// Only an actual write attempt can succeed or be refused, so the counts below are over those.
const BOOKKEEPING = new Set(['directory', 'raw-append', 'reads', 'summary', 'released']);
const attemptsOf = (runs) => runs.flatMap((run) => run.results).filter((r) => !BOOKKEEPING.has(r.label));
const okOf = (runs) => attemptsOf(runs).filter((r) => r.ok);
const failedOf = (runs) => attemptsOf(runs).filter((r) => !r.ok);

describe('AE-07 A: concurrent prediction appends lose nothing', () => {
  test('four processes recording distinct expectations all persist, with no malformed line', async () => {
    const dir = tempDir();
    const capabilities = [0, 1, 2, 3].map((w) => [`race.w${w}a`, `race.w${w}b`, `race.w${w}c`]);

    const runs = await runTogether(capabilities.map((list, w) => (
      startChild(['record', dir, String(w), csv(list)], { racers: 4, waitMs: 60000 })
    )));
    for (const run of runs) assert.equal(run.code, 0, run.out);
    assert.equal(okOf(runs).length, 12, 'every writer reported every one of its three appends');

    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 12, 'no expectation was lost');
    assert.equal(new Set(records.map((r) => r.id)).size, 12, 'no record was overwritten');
    assert.deepEqual(
      [...new Set(records.map((r) => r.capability))].sort(),
      capabilities.flat().sort(),
      'each names the capability it was recorded against',
    );
    for (const record of records) {
      assert.equal(record.kind, PREDICTION_KIND);
      assert.equal(record.provenance.origin, 'user_recorded');
      assert.equal(record.confidence, null, 'no record carries a confidence value');
      assert.equal(record.expectation, 'success');
      assert.equal(record.evidenceBasis, 'none_cited');
      assert.ok(!('status' in record) && !('evaluation' in record) && !('outcome' in record), 'a lifecycle state is derived on read, never stored');
    }
    assert.deepEqual([...byKind(dir).entries()], [[PREDICTION_KIND, 12]], 'nothing but expectations was appended');

    // A cold reader derives the lifecycle of the raced ledger, not the one any writer saw.
    const listed = await parentStores(dir).predictions.list({ limit: 50 });
    assert.equal(listed.total, 12);
    assert.deepEqual([...new Set(listed.projections.map((p) => p.status))], ['recorded'], 'all twelve stand, none has an outcome to judge it');
    const counts = await parentStores(dir).predictions.status();
    assert.equal(counts.records, 12);
    assert.equal(counts.live, 12);
    assert.equal(counts.superseded, 0);
    assert.equal(counts.evaluations, 0);
    assert.deepEqual(residue(dir), [], 'coordination left no claim, token or temp file');
  });

  test('two processes recording the identical expectation: one prediction, and the other refuses truthfully', async () => {
    const dir = tempDir();
    const subject = 'the next release train departs on the published time';

    const runs = await runTogether([0, 1].map((w) => (
      startChild(['record', dir, String(w), 'race.duplicate', 'success', subject], { racers: 2, waitMs: 60000 })
    )));
    const succeeded = okOf(runs);
    const refused = failedOf(runs);
    assert.equal(succeeded.length, 1, `one process recorded the expectation: ${JSON.stringify(runs.map((r) => r.results))}`);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].code, 'PREDICTION_EXISTS');
    assert.match(refused[0].message, /already records this expectation; correct it by naming that record in replaces/, refused[0].message);

    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 1, 'one standing expectation, not two that disagree about what the user said');
    assert.equal(records[0].id, succeeded[0].id, 'the record on disk is the one its writer reported');
    assert.equal(records[0].subject, subject);
    assert.deepEqual(residue(dir), []);
  });
});

describe('AE-07 B: one successor, one verdict, one withdrawal', () => {
  test('concurrent replacements of one standing expectation produce exactly one successor', async () => {
    const dir = tempDir();
    const target = await seededPrediction(dir, 'race.replaced');

    const runs = await runTogether([0, 1].map((w) => startChild(['replace', dir, String(w), target], { racers: 2, waitMs: 60000 })));
    const succeeded = okOf(runs);
    const refused = failedOf(runs);
    assert.equal(succeeded.length, 1, JSON.stringify(runs.map((r) => r.results)));
    assert.equal(refused.length, 1);
    assert.match(refused[0].message, /is already replaced by \[[0-9a-f-]{8}\]; replace the standing one instead/, refused[0].message);

    const records = readRecords(LEDGER(dir));
    assert.equal(records.filter((r) => r.kind === PREDICTION_KIND).length, 2, 'one expectation and one successor');
    assert.deepEqual(records.filter((r) => (r.replaces ?? []).includes(target)).length, 1, 'exactly one record claims to replace it');

    const stores = parentStores(dir);
    const superseded = await stores.predictions.detail(target);
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.supersededBy.length, 1, 'the replaced expectation names one successor, whatever the interleaving');
    assert.equal(superseded.supersededBy[0], succeeded[0].id);
    assert.equal(superseded.retired, true);
    const standing = await stores.predictions.list({ limit: 50 });
    assert.equal(standing.ledger.projections.filter((p) => p.status === 'recorded').length, 1, 'one expectation stands');
    assert.equal((await stores.predictions.health()).anomalies.count, 0, 'the race left no replacement loop');
    assert.deepEqual(residue(dir), []);
  });

  test('concurrent evaluations of one prediction record one verdict, and the loser says it is already evaluated', async () => {
    const dir = tempDir();
    const stores = parentStores(dir);
    // An outcome recorded after the expectation was made, inside its horizon: that is what settles it.
    const target = await seededPrediction(dir, 'race.verdict');
    await event(stores, { capability: 'race.verdict', at: instant(1) });

    const runs = await runTogether([0, 1].map((w) => startChild(['evaluate', dir, String(w), target], { racers: 2, waitMs: 60000 })));
    const succeeded = runs.flatMap((r) => r.results).filter((r) => r.ok && r.id !== null);
    const refused = failedOf(runs);
    assert.equal(succeeded.length, 1, JSON.stringify(runs.map((r) => r.results)));
    assert.equal(refused.length, 1);
    assert.equal(refused[0].code, 'EVALUATION_EXISTS');
    assert.match(refused[0].message, /already has a recorded evaluation \(matched\); a second one would duplicate it/, refused[0].message);

    const verdicts = readRecords(LEDGER(dir)).filter((r) => r.kind === EVALUATION_KIND);
    assert.equal(verdicts.length, 1, 'one expectation is not judged twice');
    assert.equal(verdicts[0].verdict, 'matched', 'the verdict is the one the recorded outcome establishes');
    assert.equal(verdicts[0].predictionId, target);
    assert.equal(verdicts[0].outcomeExperienceIds.length, 1, 'and it names the record that established it');

    const detail = await parentStores(dir).predictions.detail(target);
    assert.equal(detail.status, 'evaluated');
    assert.equal(detail.evaluation.verdict, 'matched');
    assert.equal(detail.canRecordEvaluation, false);
    assert.deepEqual(residue(dir), []);
  });

  test('a concurrent withdrawal and evaluation never leave a withdrawn expectation scored', async () => {
    const dir = tempDir();
    const stores = parentStores(dir);
    const target = await seededPrediction(dir, 'race.withdrawn');
    await event(stores, { capability: 'race.withdrawn', at: instant(1) });

    const runs = await runTogether([
      startChild(['evaluate', dir, '0', target], { racers: 2, waitMs: 60000 }),
      startChild(['invalidate', dir, '1', target, 'the release was moved, so this expectation no longer applies'], { racers: 2, waitMs: 60000 }),
    ]);
    const results = runs.flatMap((run) => run.results);
    assert.equal(results.filter((r) => r.mode === 'invalidate').length, 1, 'the withdrawal always lands: nothing races it');
    const evaluated = results.find((r) => r.mode === 'evaluate' && r.ok && r.id !== null);
    const notScored = results.find((r) => r.mode === 'evaluate' && r.ok && r.id === null);
    if (notScored) assert.match(notScored.reason, /the user withdrew this expectation, so it is not scored/, JSON.stringify(notScored));

    const records = readRecords(LEDGER(dir));
    const withdrawals = records.filter((r) => r.kind === INVALIDATION_KIND);
    const verdicts = records.filter((r) => r.kind === EVALUATION_KIND);
    assert.equal(withdrawals.length, 1, 'the expectation is withdrawn once, whatever the interleaving');
    assert.ok(verdicts.length <= 1, 'and judged at most once');
    if (verdicts.length === 1) {
      assert.ok(records.indexOf(verdicts[0]) < records.indexOf(withdrawals[0]), 'a verdict that landed did so while the expectation still stood');
    }

    const detail = await parentStores(dir).predictions.detail(target);
    assert.equal(detail.status, 'invalidated', 'a withdrawn expectation is not reported as a scored one');
    assert.equal(detail.evaluationDecision, 'invalidated');
    assert.equal(detail.canRecordEvaluation, false);
    if (evaluated) {
      assert.equal(detail.evaluation?.verdict, 'matched', 'the verdict the records supported stays readable as history');
    } else {
      assert.equal(detail.evaluation, null, 'and a withdrawal that came first means no verdict was ever computed');
    }
    assert.equal((await parentStores(dir).predictions.health()).anomalies.count, 0);
    assert.deepEqual(residue(dir), []);
  });
});

describe('AE-07 C: a held lock, a dead holder, and a damaged ledger', () => {
  test('a live holder makes a prediction write refuse with nothing written, and the ledger works after release', async () => {
    const dir = tempDir();
    const first = await seededPrediction(dir, 'race.locked', '0');
    assert.ok(first);

    const holder = startChild(['hold-lock', dir, 'h', '3500'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    assert.equal(fs.existsSync(LOCK(dir)), true, 'the holder published its claim');

    const before = fs.readFileSync(LEDGER(dir), 'utf8');
    const quick = startChild(['record', dir, '1', 'race.after'], { waitMs: 300 });
    const done = await quick.exit;
    assert.equal(done.code, 1, quick.out);
    const [result] = quick.results;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCKED');
    assert.match(result.message, /cannot write predictions\.jsonl: it is in use by process \d+; nothing was written/, result.message);
    assert.ok(result.ms < 2000, `the refusal came from the 300 ms budget, not the default one (${result.ms} ms)`);
    assert.equal(fs.readFileSync(LEDGER(dir), 'utf8'), before, 'the refused writer changed no byte');
    assert.equal(fs.existsSync(LOCK(dir)), true, 'a refusal never removes another process claim');

    await holder.exit;
    const retry = await runChild(['record', dir, '2', 'race.after'], {});
    assert.equal(retry.code, 0, retry.out);
    assert.equal(retry.results[0].ok, true, JSON.stringify(retry.results[0]));
    assert.equal(expectations(dir).length, 2, 'the refused expectation is absent and the retry is present');
    assert.deepEqual(residue(dir), [], 'the released holder left nothing behind');
  });

  test('a writer that meets a live holder waits within its budget and then writes', async () => {
    const dir = tempDir();
    const holder = startChild(['hold-lock', dir, 'h', '1200'], {});
    await holder.waitFor((out) => out.match(/HELD /));

    const writer = startChild(['record', dir, '1', 'race.waited'], { waitMs: WRITE_LOCK_WAIT_MS });
    const done = await writer.exit;
    const [result] = writer.results;
    assert.equal(result.ok, true, `the writer waited and then wrote: ${JSON.stringify(result)}`);
    assert.equal(done.code, 0, writer.out);
    assert.ok(result.ms >= 100, `the write waited for the holder (took ${result.ms} ms)`);
    await holder.exit;

    assert.equal(expectations(dir).length, 1);
    assert.deepEqual(residue(dir), []);
  });

  test('a process killed while holding the prediction lock leaves a claim the next write takes over', async () => {
    const dir = tempDir();
    const first = await seededPrediction(dir, 'race.killed.holder', '0');

    const holder = startChild(['hold-lock', dir, 'h', '0'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const raw = fs.readFileSync(LOCK(dir), 'utf8');
    assert.equal(JSON.parse(raw).pid, holder.child.pid, 'the claim names the process that wrote it');

    holder.child.kill();
    await holder.exit;
    rebindDeadHolder(LOCK(dir), holder.child.pid);

    const next = await runChild(['record', dir, '1', 'race.after.kill'], { waitMs: 5000 });
    assert.equal(next.code, 0, next.out);
    assert.equal(next.results[0].ok, true, JSON.stringify(next.results[0]));
    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 2, 'the interrupted write wrote nothing and the new write is complete');
    assert.equal(records[0].id, first, 'the pre-existing expectation is unchanged');
    assert.equal(fs.existsSync(LOCK(dir)), false, 'the abandoned claim was taken over');
    assert.deepEqual(residue(dir), [], 'the takeover left no token behind');
  });

  test('a writer killed between appends leaves one complete expectation and no partial one', async () => {
    const dir = tempDir();
    const interrupted = startChild(['record', dir, '0', 'race.kept,race.lost'], { progress: true });
    await interrupted.waitFor((out) => /PROGRESS /.test(out));
    const written = interrupted.out.split('\n')
      .find((line) => line.startsWith('PROGRESS ')).slice('PROGRESS '.length).trim();

    interrupted.child.kill();
    await interrupted.exit;

    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 1, 'the completed append is durable and the never-started one is absent');
    assert.equal(records[0].id, written, 'the record on disk is the one the killed writer reported');
    assert.equal(records[0].capability, 'race.kept');
    assert.ok(fs.readFileSync(LEDGER(dir), 'utf8').endsWith('\n'), 'the ledger still ends on a whole line');
    assert.deepEqual(residue(dir), [], 'a writer killed outside its critical section left no claim');

    // The ledger is readable at once: the interrupt cost no derived state, and the missed expectation
    // is recorded by a fresh writer rather than silently present.
    const listed = await parentStores(dir).predictions.list({ limit: 50 });
    assert.equal(listed.total, 1);
    assert.equal(listed.projections[0].status, 'recorded');
    const resumed = await runChild(['record', dir, '1', 'race.lost'], {});
    assert.equal(resumed.code, 0, resumed.out);
    assert.equal(expectations(dir).length, 2);
    assert.deepEqual(residue(dir), []);
  });

  test('an unreadable prediction claim is reported as in use by an unknown process and is never removed', async () => {
    const dir = tempDir();
    fs.writeFileSync(LOCK(dir), 'this claim is not json');
    const stores = parentStores(dir, { lockWaitMs: 300 });

    const failed = await stores.predictions.recordPrediction({
      capability: 'race.ambiguous', expectation: 'success', subject: 'refused', expiresAt: HORIZON_ISO, origin: 'user',
    }).then(() => null, (err) => err);
    assert.ok(failed, 'a writer does not guess past an unreadable claim');
    assert.equal(failed.code, 'LOCKED');
    assert.match(failed.message, /it is in use by process unknown; nothing was written/, failed.message);
    assert.equal(fs.existsSync(LEDGER(dir)), false, 'the refused write created no ledger');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), 'this claim is not json', 'an ambiguous claim is not deleted on a guess');
    await assert.rejects(() => stores.predictions.recover(), /holder cannot be identified/, 'recovery of an unreadable holder refuses');

    fs.rmSync(LOCK(dir));
    const { record } = await stores.predictions.recordPrediction({
      capability: 'race.ambiguous', expectation: 'success', subject: 'after the operator cleared it', expiresAt: HORIZON_ISO, origin: 'user',
    });
    assert.ok(record.id);
    assert.deepEqual(residue(dir), []);
  });

  test('a corrupt prediction line makes every concurrent writer refuse, and the damage stays byte for byte', async () => {
    const dir = tempDir();
    const target = await seededPrediction(dir, 'race.corrupt');
    // The damage is installed by a real process appending bytes, as a writer killed mid-append would.
    const torn = await runChild(['raw-append', dir, 'd', '{"schema":1,"kind":"prediction"', 'no-newline'], {});
    assert.equal(torn.code, 0, torn.out);
    const before = fs.readFileSync(LEDGER(dir), 'utf8');

    const runs = await runTogether([
      startChild(['record', dir, '0', 'race.after.corrupt'], { racers: 3, waitMs: 60000 }),
      startChild(['evaluate', dir, '1', target], { racers: 3, waitMs: 60000 }),
      startChild(['invalidate', dir, '2', target, 'withdrawn while the ledger was damaged'], { racers: 3, waitMs: 60000 }),
    ]);
    const results = attemptsOf(runs);
    assert.equal(results.length, 3, JSON.stringify(results));
    for (const result of results) {
      assert.equal(result.ok, false, `a damaged ledger never accepts a lifecycle write: ${JSON.stringify(result)}`);
      assert.equal(result.code, 'STORE_UNAVAILABLE');
      assert.match(result.message, /prediction store contains 1 corrupt line\(s\); refusing an incomplete prediction operation/, result.message);
    }
    assert.equal(fs.readFileSync(LEDGER(dir), 'utf8'), before, 'the damaged line was not skipped, repaired, or buried under a new record');
    assert.deepEqual(residue(dir), [], 'three refused writers left no claim or token');

    // The damage is reported rather than hidden, and the reader says which line it could not parse.
    const health = await parentStores(dir).predictions.health();
    assert.equal(health.state, 'damaged');
    assert.equal(health.corruptLines, 1);
    assert.equal(health.complete, false, 'the ledger says its own read was not complete');
    assert.equal(health.attention, true);
    assert.equal(health.predictions, 1, 'the expectation that is still readable stays counted');
    assert.equal(health.corrupt[0].truncatedTail, true, 'and a tail with no newline is reported as a truncated line');

    const lines = ledgerOf(dir);
    fs.writeFileSync(LEDGER(dir), `${lines[0]}\n`);
    const recovered = await parentStores(dir).predictions.recordPrediction({
      capability: 'race.corrupt', expectation: 'failure', subject: 'after the damage was cleared',
      expiresAt: HORIZON_ISO, origin: 'user',
    });
    assert.ok(recovered.record.id);
    assert.equal(ledgerOf(dir).length, 2);
  });

  test('a ledger that reuses one record id fails closed for every concurrent writer', async () => {
    const dir = tempDir();
    const target = await seededPrediction(dir, 'race.duplicated');
    const duplicated = fs.readFileSync(LEDGER(dir), 'utf8').trim();
    const torn = await runChild(['raw-append', dir, 'd', duplicated], {});
    assert.equal(torn.code, 0, torn.out);
    const before = fs.readFileSync(LEDGER(dir), 'utf8');

    const runs = await runTogether([0, 1].map((w) => startChild(['record', dir, String(w), `race.duplicateid${w}`], { racers: 2, waitMs: 60000 })));
    const results = runs.flatMap((run) => run.results);
    assert.equal(results.length, 2, JSON.stringify(results));
    for (const result of results) {
      assert.equal(result.ok, false, 'two records answering to one id is damage, not a smaller ledger');
      assert.equal(result.code, 'STORE_UNAVAILABLE');
      assert.match(result.message, /prediction store reuses 1 record id\(s\) \([0-9a-f-]+\); refusing an operation on a ledger whose records are not individually identifiable/, result.message);
    }
    assert.equal(fs.readFileSync(LEDGER(dir), 'utf8'), before, 'nothing was appended to a disputed ledger');
    assert.deepEqual(residue(dir), []);

    // Every derived read refuses for the same reason; only the count-only status line still answers,
    // and health names the dispute instead of picking a record.
    const stores = parentStores(dir);
    await assert.rejects(() => stores.predictions.list({ limit: 5 }), /reuses 1 record id\(s\)/);
    await assert.rejects(() => stores.predictions.detail(target), /reuses 1 record id\(s\)/);
    await assert.rejects(() => stores.predictions.promptView({}), /reuses 1 record id\(s\)/);
    const counts = await stores.predictions.status();
    assert.equal(counts.records, 2, 'a count of the lines on disk is still a true statement');
    const health = await stores.predictions.health();
    assert.equal(health.state, 'ok', 'every line parses; the ledger disagrees with itself');
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /written more than once in the log; every read and write of this ledger refuses/, JSON.stringify(health.anomalies));
    assert.equal(health.attention, true);
  });

  test('a reader running alongside writers never presents a torn line as a complete ledger', async () => {
    const dir = tempDir();
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seededPrediction(dir, `race.prior${i}`, 'p');
    }

    const writers = [0, 1].map((w) => (
      startChild(['record', dir, String(w), `race.r${w}0,race.r${w}1,race.r${w}2`], { racers: 3, waitMs: 60000 })
    ));
    const reader = startChild(['read-loop', dir, 'r', '8', '25000'], { racers: 3 });

    const writerRuns = await runTogether(writers);
    for (const run of writerRuns) assert.equal(run.code, 0, run.out);
    const readerRun = { ...(await reader.exit), out: reader.out, results: resultsOf(reader.out) };
    assert.equal(readerRun.code, 0, readerRun.out);

    const reads = readerRun.results.filter((r) => r.label !== 'summary');
    const summary = readerRun.results.find((r) => r.label === 'summary');
    assert.ok(summary.ok, JSON.stringify(summary));
    assert.equal(summary.lastParsed, 8, 'the reader eventually saw every record the writers appended');
    assert.ok(reads.length > 1, `the reader ran alongside the writers over ${reads.length} reads`);
    assert.ok(reads.some((r) => r.parsed < 8), 'and answered from a state partway through the race');

    for (const read of reads) {
      if (read.torn === 0) {
        assert.match(read.storeRead, /^ok:\d+$/, JSON.stringify(read));
        const [, count] = read.storeRead.split(':');
        // The store's read is a later instant than the raw sample that produced `parsed`, so a writer
        // can complete an append between them and the store is then right to answer with the extra
        // expectation. Both ends of the interval are sampled, and the answer must sit inside them.
        assert.ok(
          Number(count) >= read.parsed && Number(count) <= read.parsedAfter,
          `a clean read is answered with the records on disk at both ends of the read interval: ${JSON.stringify(read)}`,
        );
      } else {
        assert.match(read.storeRead, /corrupt line\(s\); refusing an incomplete prediction operation/, JSON.stringify(read));
      }
    }
    assert.equal(reads.every((r) => r.parsed <= 8), true, 'a reader never invents an expectation');

    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 8);
    assert.equal(new Set(records.map((r) => r.id)).size, 8);
    assert.equal(okOf(writerRuns).length, 6);
    assert.deepEqual(residue(dir), []);
  });

  test('read-only prediction operations neither take the lock nor disturb a live holder', async () => {
    const dir = tempDir();
    const stores = parentStores(dir);
    const target = await seededPrediction(dir, 'race.readable');
    await event(stores, { capability: 'race.readable', at: instant(1) });
    await stores.predictions.recordEvaluation({ target, origin: 'user' });

    const holder = startChild(['hold-lock', dir, 'h', '1500'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const lockBytes = fs.readFileSync(LOCK(dir), 'utf8');

    const reader = await runChild(['read-only', dir, 'r'], {});
    assert.equal(reader.code, 0, reader.out);
    const [view] = reader.results;
    assert.equal(view.ok, true);
    assert.equal(view.readError, null, JSON.stringify(view));
    assert.equal(view.listed, 1);
    assert.equal(view.detail, 'evaluated/evaluated', 'a reader is answered with the derived verdict while a writer holds the lock');
    assert.equal(view.unchanged, true, 'the reader created no file in the ledger directory');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), lockBytes, 'the live holder claim was not read-write disturbed');

    await holder.exit;
    assert.deepEqual(residue(dir), []);
  });
});

describe('AE-07 D: coordination grants no authority, and the operational surface covers the new lock', () => {
  // The number of times a writer lock was actually sought. An unauthorized request must be refused
  // before that count moves, so taking the lock can never be what made a ledger write legitimate.
  function countAcquisitions() {
    const real = WriterLock.prototype.run;
    const counter = { calls: 0 };
    WriterLock.prototype.run = function counted(fn) {
      counter.calls += 1;
      return real.call(this, fn);
    };
    counter.restore = () => { WriterLock.prototype.run = real; };
    return counter;
  }

  test('a model-origin prediction write is refused before any prediction lock is sought', async () => {
    const dir = tempDir();
    const stores = parentStores(dir);
    const { record } = await stores.predictions.recordPrediction({
      capability: 'race.origin', expectation: 'success', subject: 'the user own expectation',
      expiresAt: HORIZON_ISO, origin: 'user',
    });

    const counter = countAcquisitions();
    let codes;
    try {
      const attempts = [
        () => stores.predictions.recordPrediction({
          capability: 'race.origin', expectation: 'failure', subject: 'a model claims this outcome is expected',
          expiresAt: HORIZON_ISO, origin: 'model',
        }),
        () => stores.predictions.invalidatePrediction({ target: record.id, reason: 'a model withdraws it', origin: 'model' }),
        () => stores.predictions.recordEvaluation({ target: record.id, origin: 'model' }),
        () => stores.predictions.recordEvaluation({ target: record.id, origin: 'model', verdict: 'matched' }),
        () => stores.predictions.recordPrediction({
          capability: 'race.origin', expectation: 'success', subject: 'a user expectation carrying its own number',
          expiresAt: HORIZON_ISO, origin: 'user', confidence: 0.9,
        }),
      ];
      const results = [];
      for (const attempt of attempts) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await attempt().then(() => null, (err) => err));
      }
      codes = results.map((err) => `${err?.code ?? 'NO ERROR'}`);
      for (const err of results) assert.ok(err, 'every write path refuses a non-user origin and a supplied verdict');
      assert.equal(counter.calls, 0, `no refusal sought a lock: ${codes.join(', ')}`);
    } finally {
      counter.restore();
    }
    assert.deepEqual(codes, [
      'WRITE_REQUIRES_USER_ORIGIN',
      'WRITE_REQUIRES_USER_ORIGIN',
      'WRITE_REQUIRES_USER_ORIGIN',
      'WRITE_REQUIRES_USER_ORIGIN',
      'INVALID_INPUT',
    ]);
    assert.equal(fs.existsSync(LOCK(dir)), false, 'the prediction ledger was never coordinated');
    assert.equal(expectations(dir).length, 1, 'and the ledger still holds only the record the user made');
    assert.deepEqual(residue(dir), []);
  });

  test('a model-origin write refused while another process holds the lock leaves no claim and no line', async () => {
    const dir = tempDir();
    const before = await seededPrediction(dir, 'race.contested');
    const holder = startChild(['hold-lock', dir, 'h', '3500'], {});
    await holder.waitFor((out) => out.match(/HELD /));

    const attempt = await runChild(['model-write', dir, 'm'], { waitMs: 300 });
    const refused = attempt.results.find((r) => r.label === 'model-write');
    const directory = attempt.results.find((r) => r.label === 'directory');
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.code, 'WRITE_REQUIRES_USER_ORIGIN', 'the store names the authorization boundary, not a lock');
    assert.match(refused.message, /model output cannot record, withdraw, or evaluate a prediction/, refused.message);
    assert.equal(directory.ok, true, JSON.stringify(directory));
    assert.equal(directory.lockSeen, true, 'the holder claim it found is still there');
    assert.equal(expectations(dir).length, 1);
    assert.equal(fs.existsSync(LEDGER(dir)) && ledgerOf(dir)[0].includes(before), true, 'the standing expectation is untouched');

    await holder.exit;
    assert.equal(expectations(dir).length, 1, 'and releasing the lock does not reveal a deferred model write');
    assert.deepEqual(residue(dir), []);
  });

  test('a prediction CLI write refused by a live holder is reported as refused before writing', async () => {
    const dir = tempDir();
    const raw = claim(process.pid);
    fs.writeFileSync(LOCK(dir), raw);

    const res = await runCli([
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the next calculation is reported as a verified success',
      '--in-days', '30',
    ], envFor(dir));
    assert.notEqual(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /cannot write predictions\.jsonl: it is in use by process \d+; nothing was written/, res.stdout);
    assert.doesNotMatch(res.stdout, /cannot establish whether it changed stored data/, 'a refusal before coordination is not reported as a possible partial write');
    assert.equal(fs.existsSync(LEDGER(dir)), false, 'the ledger was never created by a refused write');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'the refused writer left the live holder claim exactly as it found it');

    const audit = readRecords(OPS(dir));
    const step = audit.at(-1).steps.find((s) => s.action === 'prediction.record');
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.execution.error.code, 'LOCKED', 'the audit names the refusal class, not a generic failure');
    assert.match(step.execution.error.message, /nothing was written/);
    assert.equal(step.verification.outcome, 'not_run', 'verification never ran, because there was nothing to verify');
    assert.equal(audit.at(-1).status, 'execution_failed');

    fs.rmSync(LOCK(dir));
    assert.deepEqual(residue(dir), [], 'the only lock bookkeeping was the claim this test installed');
  });

  test('diagnose reports the prediction lock as needing recovery, repair locks clears only tokens, and the write then lands', async () => {
    const dir = tempDir();
    const raw = claim(deadPid());
    fs.writeFileSync(LOCK(dir), raw);
    const tokens = writeTokens(LOCK(dir), raw);

    const before = await runCli(['diagnose'], envFor(dir));
    assert.match(before.stdout, /Prediction lock: recovery required - 16 takeover token\(s\)/, before.stdout);
    assert.match(before.stdout, /"apex repair locks"/, before.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'diagnose removed nothing');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'diagnose left the claim as it found it');

    const refused = await runCli([
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the next calculation is reported as a verified success',
      '--in-days', '30',
    ], envFor(dir));
    assert.notEqual(refused.code, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /16 takeover attempts are recorded as abandoned/, refused.stdout);
    assert.equal(fs.existsSync(LEDGER(dir)), false, 'the exhausted writer wrote nothing');

    const repaired = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /Prediction lock: removed 16 abandoned takeover token\(s\)/, repaired.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), false);
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'repair never deletes a claim');

    const res = await runCli([
      'prediction', 'record',
      '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the next calculation is reported as a verified success',
      '--in-days', '30',
    ], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Audit: recorded in operations\.jsonl/);
    const records = readRecords(LEDGER(dir));
    assert.equal(records.length, 1, 'the CLI write took the dead claim over');
    assert.equal(records[0].kind, PREDICTION_KIND);
    assert.equal(records[0].confidence, null, 'and recorded no confidence');
    assert.deepEqual(residue(dir), [], 'the recovered ledger is left with no lock bookkeeping');
  });
});
