// Batch Z (Z-08): cross-process coordination of the experience log, tested with real child
// processes.
//
// Every experience write reads the whole authoritative log, derives one decision from it (does this
// operation already have an experience, is this feedback current, does a candidate for this scope
// and rule already exist, has this adaptation already been decided or retired?), and then appends.
// Two processes doing that without coordination each "succeed" while one logical outcome is lost:
// an operation with two experiences for the same event, the same user correction deriving two
// candidates, a candidate acquiring two conflicting decisions, or a rule that reads as both retired
// and in effect. `src/memory/writer-lock.js` now covers the read-derive-append section of the
// experience log, one per store, exactly as it does for memory and knowledge.
//
// The scenarios below assert the authoritative records and the derived lifecycle states rather than
// exit codes, and every legitimate loser of a race is asserted to return a truthful refusal rather
// than a pretend success:
//   A concurrent distinct appends   B concurrent derivation   C concurrent decisions and retirement
//   D live lock, killed holder, ambiguous claim, corrupt log, readers alongside writers
//   E the operational surface: diagnose, repair locks, and the CLI refusal wording.
//
// The last group is the trust boundary again: coordination is not authority. A model-origin write is
// refused before a lock is ever sought, so "took the lock" can never be what made a lifecycle write
// legitimate. No model is contacted by any test in this file; the audited events the experiences
// reference come from the real request path with deterministic routing, and dead lock holders are
// produced by the shared fixtures (`deadPid`, `rebindDeadHolder`) rather than assumed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, deadPid, rebindDeadHolder } from './helpers.js';
import { createApp } from '../src/app.js';
import { ExperienceStore } from '../src/experience/experience-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { WriterLock, WRITE_LOCK_WAIT_MS } from '../src/memory/writer-lock.js';
import { TAKEOVER_EPOCHS } from '../src/tasks/lock-recovery.js';
import { Outcome } from '../src/outcomes.js';

const CLOCK = () => new Date('2026-11-01T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'experience-writer-child.mjs');
const LOG = (dir) => path.join(dir, 'experiences.jsonl');
const LOCK = (dir) => `${LOG(dir)}.lock`;

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

function claim(pid, nonce = 'fixture') {
  return JSON.stringify({ pid, nonce, at: new Date().toISOString() });
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

// A fresh instance on purpose: a test must not read the lifecycle state out of the same in-memory
// snapshot it just wrote, the way a second APEX process would have to re-derive it from disk.
function storeFor(dir, options = {}) {
  return new ExperienceStore(LOG(dir), {
    now: CLOCK,
    operations: new OperationLog(path.join(dir, 'operations.jsonl')),
    ...options,
  });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function readRecords(file) {
  return readLines(file).map((line) => JSON.parse(line));
}

function byKind(dir) {
  const groups = new Map();
  for (const record of readRecords(LOG(dir))) groups.set(record.kind, (groups.get(record.kind) ?? 0) + 1);
  return groups;
}

// Anything a coordinated write is expected to clean up. A refusal that leaves a claim behind is
// correct only when the claim belongs to a live holder that the test itself installed.
function residue(dir) {
  return fs.readdirSync(dir).filter((name) => (
    name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')
  ));
}

function resultsOf(out) {
  return out.split('\n').filter((line) => line.startsWith('RESULT ')).map((line) => JSON.parse(line.slice('RESULT '.length)));
}

function startChild(args, { racers = 1, waitMs = null } = {}) {
  const env = cleanEnv({ APEX_RACERS: String(racers) });
  if (waitMs !== null) env.APEX_WAIT_MS = String(waitMs);
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

// ---- deterministic audited evidence, produced through the real request path ---------------------

async function seededApp(dir, count, prefix = 'seed') {
  const app = createApp({ dataDir: dir, now: CLOCK });
  const operations = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await app.controller.handle(`remember that ${prefix} note ${i} is held`, { origin: 'user' });
    assert.equal(res.operation.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
    assert.equal(res.operation.capability, 'memory.add', 'the fixture depends on this request routing to memory.add');
    operations.push(res.operation);
  }
  return { app, operations };
}

async function parentExperiences(app, operations, writer = 'p') {
  const ids = [];
  for (let i = 0; i < operations.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { record } = await app.experience.recordExperience({
      operationId: operations[i].id, subject: `event ${writer}-${i} as experienced`, origin: 'user',
    });
    ids.push(record.id);
  }
  return ids;
}

// The support a candidate needs: two distinct experiences in one scope, each answered by current
// corrective feedback carrying the same guidance.
async function parentSupport(app, operations, guidance) {
  const ids = await parentExperiences(app, operations);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await app.experience.recordFeedback({ target: id, assessment: 'not_useful', guidance, origin: 'user' });
  }
  return ids;
}

const csv = (list) => list.join(',');
const okOf = (runs) => runs.flatMap((run) => run.results).filter((r) => r.ok);
const failedOf = (runs) => runs.flatMap((run) => run.results).filter((r) => !r.ok && r.label !== 'summary');

describe('Z-08 A: concurrent experience appends lose nothing', () => {
  test('four processes recording distinct audited events all persist, with no malformed line', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 12, 'append');
    const perWriter = [operations.slice(0, 3), operations.slice(3, 6), operations.slice(6, 9), operations.slice(9, 12)];

    const runs = await runTogether(perWriter.map((ops, w) => startChild(['record-experience', dir, String(w), csv(ops.map((o) => o.id))], { racers: 4, waitMs: 60000 })));
    for (const run of runs) assert.equal(run.code, 0, run.out);
    assert.equal(okOf(runs).length, 12, 'every writer reported every one of its three appends');

    const records = readRecords(LOG(dir));
    assert.equal(records.length, 12, 'no experience was lost');
    assert.equal(new Set(records.map((r) => r.id)).size, 12, 'no record was overwritten');
    assert.equal(new Set(records.map((r) => r.operationId)).size, 12, 'each names a different audited event');
    assert.deepEqual(
      records.map((r) => r.subject).sort(),
      perWriter.flatMap((_, w) => [0, 1, 2].map((i) => `event ${w}-${i} as experienced`)).sort(),
      'the log holds exactly what the four writers recorded',
    );
    for (const record of records) {
      assert.equal(record.kind, 'experience');
      assert.equal(record.provenance.origin, 'user_recorded');
      assert.equal(record.adaptationEligible, true, 'a verified memory write is usable as adaptation support');
    }
    assert.deepEqual([...byKind(dir).entries()], [['experience', 12]], 'nothing but experiences was appended');
    assert.deepEqual(residue(dir), [], 'coordination left no claim, token or temp file');
  });

  test('two processes recording the same operation: one experience, and the other refuses truthfully', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 1, 'same-op');
    const id = operations[0].id;

    const runs = await runTogether([0, 1].map((w) => startChild(['record-experience', dir, String(w), id], { racers: 2, waitMs: 60000 })));
    const succeeded = okOf(runs);
    const refused = failedOf(runs);
    assert.equal(succeeded.length, 1, `one process recorded the event: ${JSON.stringify(runs.map((r) => r.results))}`);
    assert.equal(refused.length, 1);
    assert.match(refused[0].message, /already has a recorded experience; correct it by naming that record in replaces/, refused[0].message);

    const records = readRecords(LOG(dir));
    assert.equal(records.length, 1, 'one audited event has one live experience');
    assert.equal(records[0].id, succeeded[0].id, 'the record on disk is the one its writer reported');
    assert.deepEqual(residue(dir), []);
  });
});

describe('Z-08 B: concurrent derivation yields one candidate per evidence group', () => {
  test('two processes deriving from the same repeated correction create one candidate', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 2, 'derive-one');
    await parentSupport(app, operations, 'give one dated fact, not a reminder');

    const runs = await runTogether([0, 1].map((w) => startChild(['derive', dir, String(w)], { racers: 2, waitMs: 60000 })));
    const results = runs.flatMap((run) => run.results);
    assert.equal(results.length, 2, JSON.stringify(results));
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));

    const creators = results.filter((r) => r.created.length === 1);
    const none = results.filter((r) => r.created.length === 0);
    assert.equal(creators.length, 1, 'exactly one process created the candidate');
    assert.equal(none.length, 1, 'the other derived from the state that already included it');
    assert.equal(none[0].skipped, 1, 'and reported the group it skipped rather than saying nothing');

    const adaptations = readRecords(LOG(dir)).filter((r) => r.kind === 'adaptation');
    assert.equal(adaptations.length, 1, 'one user correction is not two rules');
    assert.equal(adaptations[0].rule, 'give one dated fact, not a reminder', 'the rule is the user own words');
    assert.equal(adaptations[0].capability, 'memory.add');
    assert.equal(adaptations[0].support.experienceIds.length, 2);
    assert.equal(adaptations[0].support.feedbackIds.length, 2);

    const health = await storeFor(dir).health();
    assert.equal(health.candidates, 1);
    assert.equal(health.approved, 0, 'a candidate is not an approved rule');
    assert.deepEqual(residue(dir), []);
  });

  test('two evidence groups in one concurrent derivation produce exactly one candidate each', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 4, 'derive-two');
    await parentSupport(app, operations.slice(0, 2), 'give one dated fact, not a reminder');
    await parentSupport(app, operations.slice(2, 4), 'never store a private code');

    const runs = await runTogether([0, 1].map((w) => startChild(['derive', dir, String(w)], { racers: 2, waitMs: 60000 })));
    for (const run of runs) assert.equal(run.code, 0, run.out);

    const adaptations = readRecords(LOG(dir)).filter((r) => r.kind === 'adaptation');
    assert.equal(adaptations.length, 2, 'two scopes of evidence give two candidates, not four');
    assert.deepEqual(adaptations.map((a) => a.rule).sort(), ['give one dated fact, not a reminder', 'never store a private code']);
    assert.equal(new Set(adaptations.map((a) => `${a.capability}\u0000${a.rule}`)).size, 2);

    const health = await storeFor(dir).health();
    assert.equal(health.candidates, 2);
    assert.deepEqual(residue(dir), []);
  });
});

describe('Z-08 C: one candidate, concurrent decisions, and a retirement that cannot be in effect', () => {
  async function candidate(dir, count = 2) {
    const { app, operations } = await seededApp(dir, count, 'decide');
    await parentSupport(app, operations, 'answer in one line');
    const { created } = await app.experience.deriveAdaptations({ origin: 'user' });
    assert.equal(created.length, 1);
    return { app, target: created[0].id };
  }

  test('two processes approving one candidate record one decision and the loser says it is already approved', async () => {
    const dir = tempDir();
    const { target } = await candidate(dir);

    const runs = await runTogether([0, 1].map((w) => startChild(['decide', dir, String(w), target, 'approved'], { racers: 2, waitMs: 60000 })));
    const succeeded = okOf(runs);
    const refused = failedOf(runs);
    assert.equal(succeeded.length, 1, JSON.stringify(runs.map((r) => r.results)));
    assert.equal(refused.length, 1);
    assert.match(refused[0].message, /is already approved/, refused[0].message);

    const records = readRecords(LOG(dir));
    const decisions = records.filter((r) => r.kind === 'adaptation_decision');
    assert.equal(decisions.length, 1, 'the same decision was not recorded twice');
    assert.equal(decisions[0].targetId, target);
    assert.equal(decisions[0].decision, 'approved');

    const detail = await storeFor(dir).adaptationDetail(target);
    assert.equal(detail.decisionState, 'approved');
    assert.equal(detail.active, true, 'a rule the user approved and whose support stands is in effect');
    assert.deepEqual(residue(dir), []);
  });

  test('opposing concurrent decisions both stay history, and the newest record governs the derived state', async () => {
    const dir = tempDir();
    const { target } = await candidate(dir);

    const runs = await runTogether([
      startChild(['decide', dir, '0', target, 'approved'], { racers: 2, waitMs: 60000 }),
      startChild(['decide', dir, '1', target, 'rejected'], { racers: 2, waitMs: 60000 }),
    ]);
    const results = runs.flatMap((run) => run.results);
    const succeeded = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    // A changed mind is allowed and every earlier decision stays readable, so a differing decision
    // is not a duplicate. What must never happen is a state no record explains.
    assert.equal(succeeded.length + refused.length, 2, JSON.stringify(results));
    for (const rejection of refused) {
      assert.match(rejection.message, /is already (approved|rejected)/, rejection.message);
    }

    const decisions = readRecords(LOG(dir)).filter((r) => r.kind === 'adaptation_decision' && r.targetId === target);
    assert.equal(decisions.length, succeeded.length, 'the log holds exactly the decisions that were accepted');
    const newest = decisions.at(-1);
    const detail = await storeFor(dir).adaptationDetail(target);
    assert.equal(detail.decisionState, newest.decision, 'the derived state is the newest recorded decision');
    assert.equal(detail.active, newest.decision === 'approved');
    if (succeeded.length === 2) {
      assert.equal(new Set(decisions.map((d) => d.decision)).size, 2, 'the two processes recorded different decisions');
    }
    assert.deepEqual(residue(dir), []);
  });

  test('a concurrent retirement and approval never leave a retired rule in effect', async () => {
    const dir = tempDir();
    const { target } = await candidate(dir);

    const runs = await runTogether([
      startChild(['decide', dir, '0', target, 'approved'], { racers: 2, waitMs: 60000 }),
      startChild(['retire', dir, '1', target], { racers: 2, waitMs: 60000 }),
    ]);
    const results = runs.flatMap((run) => run.results);
    const succeeded = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    assert.ok(succeeded.length >= 1, `at least one lifecycle write landed: ${JSON.stringify(results)}`);
    for (const rejection of refused) {
      assert.match(rejection.message, /was retired; derive a new candidate instead of deciding a retired one/, rejection.message);
    }

    const records = readRecords(LOG(dir));
    const retirements = records.filter((r) => r.kind === 'adaptation_retirement' && r.targetId === target);
    assert.equal(retirements.length, 1, 'the rule is ended once, whatever the interleaving');
    const decisions = records.filter((r) => r.kind === 'adaptation_decision' && r.targetId === target);
    assert.ok(decisions.length <= 1);
    if (decisions.length === 1) {
      assert.ok(records.indexOf(decisions[0]) < records.indexOf(retirements[0]), 'a decision that landed did so before the retirement');
    }

    const detail = await storeFor(dir).adaptationDetail(target);
    assert.equal(detail.decisionState, 'retired');
    assert.equal(detail.active, false, 'a retired rule is never in effect, even when an approval was concurrent');
    const active = await storeFor(dir).activeAdaptations({ query: 'answer in one line' });
    assert.deepEqual(active.adaptations, [], 'and it cannot be retrieved for a future request');
    assert.equal((await storeFor(dir).health()).retiredAdaptations, 1);
    assert.deepEqual(residue(dir), []);
  });
});

describe('Z-08 D: a held lock, a dead holder, and a damaged log', () => {
  test('a live holder makes an experience write refuse with nothing written, and the store works after release', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 2, 'locked');
    const first = await runChild(['record-experience', dir, '0', operations[0].id], {});
    assert.equal(first.code, 0, first.out);

    const holder = startChild(['hold-lock', dir, 'h', '3500'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    assert.equal(fs.existsSync(LOCK(dir)), true, 'the holder published its claim');

    const before = fs.readFileSync(LOG(dir), 'utf8');
    const quick = startChild(['record-experience', dir, '1', operations[1].id], { waitMs: 300 });
    const done = await quick.exit;
    assert.equal(done.code, 1, quick.out);
    const [result] = quick.results;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOCKED');
    assert.match(result.message, /cannot write experiences\.jsonl: it is in use by process \d+; nothing was written/, result.message);
    assert.ok(result.ms < 2000, `the refusal came from the 300 ms budget, not the default one (${result.ms} ms)`);
    assert.equal(fs.readFileSync(LOG(dir), 'utf8'), before, 'the refused writer changed no byte');
    assert.equal(fs.existsSync(LOCK(dir)), true, 'a refusal never removes another process claim');

    await holder.exit;
    const retry = await runChild(['record-experience', dir, '2', operations[1].id], {});
    assert.equal(retry.code, 0, retry.out);
    assert.equal(retry.results[0].ok, true, JSON.stringify(retry.results[0]));
    assert.equal(readRecords(LOG(dir)).length, 2, 'the refused record is absent and the retry is present');
    assert.deepEqual(residue(dir), [], 'the released holder left nothing behind');
  });

  test('a writer that meets a live holder waits within its budget and then writes', async () => {
    const dir = tempDir();
    const { operations } = await seededApp(dir, 2, 'waited');
    const holder = startChild(['hold-lock', dir, 'h', '1200'], {});
    await holder.waitFor((out) => out.match(/HELD /));

    const writer = startChild(['record-experience', dir, '1', operations[1].id], { waitMs: WRITE_LOCK_WAIT_MS });
    const done = await writer.exit;
    const [result] = writer.results;
    assert.equal(result.ok, true, `the writer waited and then wrote: ${JSON.stringify(result)}`);
    assert.equal(done.code, 0, writer.out);
    assert.ok(result.ms >= 100, `the write waited for the holder (took ${result.ms} ms)`);
    await holder.exit;

    assert.equal(readRecords(LOG(dir)).length, 1);
    assert.deepEqual(residue(dir), []);
  });

  test('a process killed while holding the experience lock leaves a claim the next write takes over', async () => {
    const dir = tempDir();
    const { operations } = await seededApp(dir, 2, 'killed');
    const first = await runChild(['record-experience', dir, '0', operations[0].id], {});
    assert.equal(first.code, 0, first.out);

    const holder = startChild(['hold-lock', dir, 'h', '0'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const raw = fs.readFileSync(LOCK(dir), 'utf8');
    assert.equal(JSON.parse(raw).pid, holder.child.pid, 'the claim names the process that wrote it');

    holder.child.kill();
    await holder.exit;
    rebindDeadHolder(LOCK(dir), holder.child.pid);

    const next = await runChild(['record-experience', dir, '1', operations[1].id], { waitMs: 5000 });
    assert.equal(next.code, 0, next.out);
    assert.equal(next.results[0].ok, true, JSON.stringify(next.results[0]));
    const records = readRecords(LOG(dir));
    assert.equal(records.length, 2, 'the interrupted write wrote nothing and the new write is complete');
    assert.equal(fs.existsSync(LOCK(dir)), false, 'the abandoned claim was taken over');
    assert.deepEqual(residue(dir), [], 'the takeover left no token behind');
    assert.equal(records[0].operationId, operations[0].id, 'the pre-existing record is unchanged');
  });

  test('an unreadable experience claim is reported as in use by an unknown process and is never removed', async () => {
    const dir = tempDir();
    const { operations } = await seededApp(dir, 1, 'ambiguous');
    fs.writeFileSync(LOCK(dir), 'this claim is not json');
    const store = storeFor(dir, { lockWaitMs: 300 });

    const failed = await store.recordExperience({ operationId: operations[0].id, subject: 'refused', origin: 'user' })
      .then(() => null, (err) => err);
    assert.ok(failed, 'a writer does not guess past an unreadable claim');
    assert.equal(failed.code, 'LOCKED');
    assert.match(failed.message, /it is in use by process unknown; nothing was written/, failed.message);
    assert.equal(fs.existsSync(LOG(dir)), false, 'the refused write created no log');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), 'this claim is not json', 'an ambiguous claim is not deleted on a guess');
    await assert.rejects(() => store.recover(), /holder cannot be identified/, 'recovery of an unreadable holder refuses');

    fs.rmSync(LOCK(dir));
    const { record } = await store.recordExperience({ operationId: operations[0].id, subject: 'after the operator cleared it', origin: 'user' });
    assert.ok(record.id);
    assert.deepEqual(residue(dir), []);
  });

  test('a corrupt experience log makes every concurrent writer refuse, and the damage stays byte for byte', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 3, 'corrupt');
    const [experienceId] = await parentExperiences(app, operations.slice(0, 1));
    fs.appendFileSync(LOG(dir), 'this line is not a record\n');
    const before = fs.readFileSync(LOG(dir), 'utf8');

    const runs = await runTogether([
      startChild(['record-experience', dir, '0', operations[1].id], { racers: 3, waitMs: 60000 }),
      startChild(['derive', dir, '1'], { racers: 3, waitMs: 60000 }),
      startChild(['retire', dir, '2', experienceId], { racers: 3, waitMs: 60000 }),
    ]);
    const results = runs.flatMap((run) => run.results);
    assert.equal(results.length, 3, JSON.stringify(results));
    for (const result of results) {
      assert.equal(result.ok, false, `a damaged store never accepts a lifecycle write: ${JSON.stringify(result)}`);
      assert.equal(result.code, 'STORE_UNAVAILABLE');
      assert.match(result.message, /experience store contains 1 corrupt line\(s\); refusing an incomplete experience operation/, result.message);
    }
    assert.equal(fs.readFileSync(LOG(dir), 'utf8'), before, 'the corrupt line was not skipped, repaired, or buried under a new record');
    assert.deepEqual(residue(dir), [], 'three refused writers left no claim or token');

    // The damage is reported rather than hidden, and the store is usable once the operator removes it.
    const health = await storeFor(dir).health();
    assert.equal(health.corrupt.length, 1);
    assert.equal(health.complete, false, 'the store says its own read was not complete');
    assert.equal(health.attention, true);
    assert.equal(health.experiences, 1, 'the record that is still readable stays counted');

    const lines = readLines(LOG(dir));
    fs.writeFileSync(LOG(dir), `${lines[0]}\n`);
    const recovered = await storeFor(dir).recordExperience({ operationId: operations[2].id, subject: 'after the damage was cleared', origin: 'user' });
    assert.ok(recovered.record.id);
    assert.equal(readLines(LOG(dir)).length, 2);
  });

  test('a reader running alongside writers never presents a torn line as a complete store', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 8, 'reader');
    await parentExperiences(app, operations.slice(0, 2));

    const writers = [operations.slice(2, 5), operations.slice(5, 8)].map((ops, w) => (
      startChild(['record-experience', dir, String(w), csv(ops.map((o) => o.id))], { racers: 3, waitMs: 60000 })
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
        assert.equal(Number(count), read.parsed, 'a clean read is answered with exactly the records on disk');
      } else {
        assert.match(read.storeRead, /corrupt line\(s\); refusing an incomplete experience operation/, JSON.stringify(read));
      }
    }
    assert.equal(reads.every((r) => r.parsed <= 8), true, 'a reader never invents a record');

    const records = readRecords(LOG(dir));
    assert.equal(records.length, 8);
    assert.equal(new Set(records.map((r) => r.id)).size, 8);
    assert.equal(okOf(writerRuns).length, 6);
    assert.deepEqual(residue(dir), []);
  });

  test('read-only experience operations neither take the lock nor disturb a live holder', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 2, 'readonly');
    await parentSupport(app, operations, 'answer in one line');
    await app.experience.deriveAdaptations({ origin: 'user' });

    const holder = startChild(['hold-lock', dir, 'h', '1500'], {});
    await holder.waitFor((out) => out.match(/HELD /));
    const lockBytes = fs.readFileSync(LOCK(dir), 'utf8');

    const reader = await runChild(['read-only', dir, 'r'], {});
    assert.equal(reader.code, 0, reader.out);
    const [view] = reader.results;
    assert.equal(view.ok, true);
    assert.equal(view.experiences, 2);
    assert.equal(view.adaptations, 1, 'a reader is answered while a writer holds the lock');
    assert.equal(view.active, 0, 'a candidate is not retrievable as an approved rule');
    assert.equal(view.unchanged, true, 'the reader created no file in the store directory');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), lockBytes, 'the live holder claim was not read-write disturbed');

    await holder.exit;
    assert.deepEqual(residue(dir), []);
  });
});

describe('Z-08 E: coordination grants no authority, and the operational surface covers the new lock', () => {
  // The number of times a writer lock was actually sought. An unauthorized request must be refused
  // before that count moves, so taking the lock can never be what made a write legitimate.
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

  test('a model-origin lifecycle write is refused before any experience lock is sought', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 1, 'origin');
    const { record } = await app.experience.recordExperience({ operationId: operations[0].id, subject: 'the user own record', origin: 'user' });

    const counter = countAcquisitions();
    let messages;
    try {
      const attempts = [
        () => app.experience.recordExperience({ operationId: operations[0].id, subject: 'x', origin: 'model' }),
        () => app.experience.recordFeedback({ target: record.id, assessment: 'correct', origin: 'model' }),
        () => app.experience.deriveAdaptations({ origin: 'model' }),
        () => app.experience.decideAdaptation({ target: record.id, decision: 'approved', origin: 'model' }),
        () => app.experience.retireAdaptation({ target: record.id, origin: 'model' }),
      ];
      const results = [];
      for (const attempt of attempts) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await attempt().then(() => null, (err) => err));
      }
      messages = results.map((err) => `${err?.code ?? 'NO ERROR'}`);
      for (const err of results) assert.ok(err, 'every write path refuses a non-user origin');
      assert.equal(counter.calls, 0, `no refusal sought a lock: ${messages.join(', ')}`);
    } finally {
      counter.restore();
    }
    assert.deepEqual(messages, ['WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN', 'WRITE_REQUIRES_USER_ORIGIN']);
    assert.equal(fs.existsSync(LOCK(dir)), false, 'the experience store was never coordinated');
    assert.equal(readLines(LOG(dir)).length, 1, 'and the log still holds only the record the user made');
    assert.deepEqual(residue(dir), []);
  });

  test('an experience CLI write refused by a live holder is reported as refused before writing', async () => {
    const dir = tempDir();
    const { app, operations } = await seededApp(dir, 1, 'cli-lock');
    const seeded = await app.experience.recordExperience({ operationId: operations[0].id, subject: 'the first record', origin: 'user' });
    assert.ok(seeded.record.id);
    const raw = claim(process.pid);
    fs.writeFileSync(LOCK(dir), raw);
    const before = fs.readFileSync(LOG(dir), 'utf8');

    const res = await runCli(['experience', 'record', operations[0].id, '--subject', 'asked to hold a note'], envFor(dir));
    assert.notEqual(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /cannot write experiences\.jsonl: it is in use by process \d+; nothing was written/, res.stdout);
    assert.doesNotMatch(res.stdout, /cannot establish whether it changed stored data/, 'a refusal before coordination is not reported as a possible partial write');
    assert.equal(fs.readFileSync(LOG(dir), 'utf8'), before, 'the store was not touched');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'the refused writer left the live holder claim exactly as it found it');
    assert.equal(readLines(LOG(dir)).length, 1);

    const audit = readRecords(path.join(dir, 'operations.jsonl'));
    const step = audit.at(-1).steps.find((s) => s.action === 'experience.record');
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.execution.error.code, 'LOCKED', 'the audit names the refusal class, not a generic failure');
    assert.match(step.execution.error.message, /nothing was written/);
    assert.equal(step.verification.outcome, 'not_run', 'verification never ran, because there was nothing to verify');
    assert.equal(audit.at(-1).status, 'execution_failed');

    fs.rmSync(LOCK(dir));
    assert.deepEqual(residue(dir), [], 'the only lock bookkeeping was the claim this test installed');
  });

  test('diagnose reports the experience lock as needing recovery, repair locks clears only tokens, and the write then lands', async () => {
    const dir = tempDir();
    const { operations } = await seededApp(dir, 1, 'cli-repair');
    const raw = claim(deadPid());
    fs.writeFileSync(LOCK(dir), raw);
    const tokens = writeTokens(LOCK(dir), raw);

    const before = await runCli(['diagnose'], envFor(dir));
    assert.match(before.stdout, /Experience lock: recovery required - 16 takeover token\(s\)/, before.stdout);
    assert.match(before.stdout, /"apex repair locks"/, before.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), true, 'diagnose removed nothing');
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'diagnose left the claim as it found it');

    const refused = await runCli(['experience', 'record', operations[0].id, '--subject', 'asked to hold a note'], envFor(dir));
    assert.notEqual(refused.code, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /16 takeover attempts are recorded as abandoned/, refused.stdout);
    assert.equal(fs.existsSync(LOG(dir)), false, 'the exhausted writer wrote nothing');

    const repaired = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    assert.match(repaired.stdout, /Experience lock: removed 16 abandoned takeover token\(s\)/, repaired.stdout);
    for (const token of tokens) assert.equal(fs.existsSync(token), false);
    assert.equal(fs.readFileSync(LOCK(dir), 'utf8'), raw, 'repair never deletes a claim');

    const res = await runCli(['experience', 'record', operations[0].id, '--subject', 'asked to hold a note'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Recorded experience [0-9a-f-]{8,} as an account of operation/, res.stdout);
    assert.match(res.stdout, /recomputed from the audit record on every read/, res.stdout);
    assert.match(res.stdout, /Audit:\s+recorded in operations\.jsonl/, res.stdout);
    const records = readRecords(LOG(dir));
    assert.equal(records.length, 1, 'the CLI write took the dead claim over');
    assert.equal(records[0].operationId, operations[0].id, 'and references the event it names');
    assert.deepEqual(residue(dir), [], 'the recovered store is left with no lock bookkeeping');
  });

  test('a fresh data directory reports the experience lock as absent and creates nothing', async () => {
    const dir = tempDir();
    const res = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Experience lock: no lock file; nothing to recover/, res.stdout);
    assert.equal(fs.existsSync(LOCK(dir)), false, 'inspection created no experience lock');
    assert.equal(fs.existsSync(LOG(dir)), false, 'inspection created no experience log');
  });
});
