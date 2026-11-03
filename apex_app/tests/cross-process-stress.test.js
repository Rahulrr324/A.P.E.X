// AF-18: what several real APEX processes do to the persistent stores at the same time.
//
// Every write here comes from a separate `node` process running the production controller through
// tests/fixtures/cross-store-writer-child.mjs, released together by a file barrier, so an
// interleaving is reproduced rather than scheduled around. Nothing is stubbed: the writer locks, the
// takeover election, the independent verifier, the audit append and the disclosure text are the ones
// a user runs.
//
// The seven questions this file answers, in the order AF-18 states them:
//   duplicate ids    - do two processes ever publish the same identifier into one store?
//   missing records  - is every record a process reported as stored actually on disk?
//   partial records  - did concurrent appends leave a torn or unparseable line anywhere?
//   lock residue     - does a directory hold a claim, token or temp file no process owns?
//   lost updates     - can two processes both rewrite one claim, or silently undo each other?
//   audit consistency- does every cited operation identifier resolve in the audit log?
//   disclosures      - does the text a refused process prints match what it actually did?
//
// What this file deliberately does NOT claim: it does not show that a lost audit record is impossible
// (the audit log has no writer lock and no unique index - see the append-failure semantics file), and
// it is not a benchmark. Its assertions are structural, so they hold whichever interleaving occurs:
// counts, uniqueness, parseability, and the rule that a record is either present or honestly
// reported as absent.
//
// Fixtures are deterministic: one fixed set of writers, one fixed number of rounds, and a repeat test
// that compares two runs of the same shape. No model, no network, no real user data - every
// directory is created under the OS temp root by helpers.js, and child environments carry
// APEX_DATA_ISOLATED so a forgotten path fails instead of writing into ~/.apex.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'cross-store-writer-child.mjs');
const HOLDER = path.join(APP_ROOT, 'tests', 'fixtures', 'store-writer-child.mjs');

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const file = (dir, name) => path.join(dir, name);

// ---- reading the stores back as they were actually written ------------------------------------
// One parse per line, and the failures are returned rather than thrown: a torn line is a finding, and
// the test has to be able to say which line it was.
function recordsOf(dir, name) {
  const target = file(dir, name);
  if (!fs.existsSync(target)) return { records: [], bad: [], missing: true, endsWithNewline: true };
  const text = fs.readFileSync(target, 'utf8');
  const parts = text.split('\n');
  const bad = [];
  const records = [];
  parts.forEach((line, index) => {
    if (index === parts.length - 1) return;         // the element after the final newline
    if (line.trim() === '') { bad.push({ line: index + 1, raw: '' }); return; }
    try {
      records.push(JSON.parse(line));
    } catch {
      bad.push({ line: index + 1, raw: line.slice(0, 80) });
    }
  });
  return { records, bad, missing: false, endsWithNewline: text === '' || text.endsWith('\n') };
}

// The nine files a request path may create, and nothing else. Anything additional is residue.
const DATA_FILES = [
  'memory.jsonl', 'conversation.jsonl', 'operations.jsonl', 'session.json', 'tasks.jsonl',
  'task-summary-queue.json', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl',
];
function unexpected(dir) {
  return fs.readdirSync(dir).filter((name) => !DATA_FILES.includes(name) && name !== 'barrier');
}

// ---- running the fixture -----------------------------------------------------------------------
// The collector is attached in the same tick the child is spawned, so no line can be emitted before
// something is listening for it. `timedOut` is always a boolean: a child that never returned is a
// finding the test must be able to name, not an `undefined` it has to guess about.
function collect(child) {
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d.toString(); });
  child.stderr.on('data', (d) => { out.text += d.toString(); });
  return out;
}

function resultsFrom(text) {
  return text.split('\n').filter((line) => line.startsWith('RESULT '))
    .map((line) => JSON.parse(line.slice('RESULT '.length)));
}

const CHILD_CEILING_MS = 90000;

async function runChild(script, args, dir, { racers = 1, ceilingMs = CHILD_CEILING_MS } = {}) {
  const env = cleanEnv({
    APEX_DATA_DIR: dir,
    HOME: dir,
    USERPROFILE: dir,
    APEX_RACERS: String(racers),
  });
  const child = spawn(process.execPath, [script, ...args], { env, cwd: APP_ROOT, windowsHide: true });
  const out = collect(child);
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill(); }, ceilingMs);
  const info = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killer);
  return { info, timedOut, results: resultsFrom(out.text), stdout: out.text };
}

// Polled rather than attached as a second stdout listener: a listener added after the one that
// fills `out` can only see data that arrives after it, so a line that already arrived would leave
// this waiting for a repeat that never comes.
async function waitForText(out, prefix, ceilingMs = 20000) {
  const until = Date.now() + ceilingMs;
  while (!out.text.split('\n').some((line) => line.startsWith(prefix))) {
    if (Date.now() > until) throw new Error(`no ${prefix} line within ${ceilingMs}ms: ${out.text.slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A deterministic set of writers: the labels are valid capability-name segments, so one fixture
// definition serves every mode.
const WRITERS = ['w1', 'w2', 'w3', 'w4'];

async function fanout(dir, rounds, writers = WRITERS) {
  return Promise.all(writers.map((w) => runChild(CHILD, ['fanout', dir, w, String(rounds)], dir, { racers: writers.length })));
}

// Every label that claims a store record, and where that record lives. The pairing is what lets one
// loop answer "missing", "duplicate" and "partial" for all four writer-locked stores instead of four
// tests. `id` is read from the file, because the file is the authority on what was stored.
const STORE_OF = {
  memory: { file: 'memory.jsonl' },
  knowledge: { file: 'knowledge.jsonl' },
  experience: { file: 'experiences.jsonl' },
  prediction: { file: 'predictions.jsonl' },
};

function claimed(results, label) {
  return results.filter((r) => r.label === label && r.ok);
}

function describeResults(results) {
  return JSON.stringify(results.filter((r) => !r.ok).map((r) => [r.writer, r.label, r.status, r.message ?? null]));
}

// The shared answer to "missing record / duplicate id" for one store: every identifier a process
// reported as stored is on disk, no identifier repeats, and the line count is exactly the number of
// processes that claimed one. A line short is a lost write and a line over is a duplicate.
function assertStoreMatchesClaims(dir, store, winners) {
  const read = recordsOf(dir, store.file);
  assert.deepEqual(read.bad, [], `${store.file} holds unparseable lines: ${JSON.stringify(read.bad)}`);
  assert.ok(read.endsWithNewline, `${store.file} ends mid-line`);
  const ids = read.records.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `${store.file} repeats an identifier`);
  assert.equal(
    ids.length,
    winners.length,
    `${store.file} holds ${ids.length} record(s) but ${winners.length} process(es) reported writing one`,
  );
  const reported = winners.map((r) => r.recordId);
  assert.deepEqual(reported.filter((id) => typeof id !== 'string' || id === ''), [], `${store.file}: a process claimed a record without naming its identifier`);
  assert.equal(new Set(reported).size, reported.length, `${store.file}: two processes published the same identifier`);
  const onDisk = new Set(ids);
  for (const id of reported) assert.ok(onDisk.has(id), `${store.file} does not hold ${id}, which a process reported as stored`);
}

describe('AF-18 1: four processes writing every store at once', () => {
  test('every reported record is on disk, no identifier repeats, and no line is torn', async () => {
    const dir = tempDir();
    const runs = await fanout(dir, 2);
    for (const run of runs) assert.equal(run.timedOut, false, `a child hung and was killed: ${run.stdout.slice(0, 300)}`);
    const results = runs.flatMap((r) => r.results);
    assert.equal(results.length, WRITERS.length * 2 * 6, `each round reports six labels: ${describeResults(results)}`);

    for (const [label, store] of Object.entries(STORE_OF)) {
      assertStoreMatchesClaims(dir, store, claimed(results, label));
    }

    // Tasks are not one record per write - the log is a sequence of events about a task - so they are
    // counted as the set of tasks this run created, and every planned task has to be reachable.
    const taskLines = recordsOf(dir, 'tasks.jsonl');
    assert.deepEqual(taskLines.bad, [], `tasks.jsonl holds unparseable lines: ${JSON.stringify(taskLines.bad)}`);
    const planned = claimed(results, 'task-plan');
    assert.equal(new Set(planned.map((r) => r.taskId)).size, planned.length, 'two processes created the same task id');
    const created = new Set(taskLines.records.map((l) => l.taskId));
    assert.equal(created.size, planned.length, 'the task log holds a task no process planned, or lost one');
    for (const r of planned) assert.ok(created.has(r.taskId), `task ${r.taskId} was planned and reported, but is not in the log`);

    // Audit consistency: this is the log with no writer lock, so it is where a lost or interleaved
    // append would appear first. Every identifier is distinct, and one operation is reported by one
    // process only - two processes claiming the same operation id would mean a shared or reused record.
    const audit = recordsOf(dir, 'operations.jsonl');
    assert.deepEqual(audit.bad, [], `operations.jsonl holds unparseable lines: ${JSON.stringify(audit.bad)}`);
    assert.ok(audit.endsWithNewline, 'operations.jsonl ends mid-line');
    const auditIds = audit.records.map((r) => r.id);
    assert.equal(new Set(auditIds).size, auditIds.length, 'the audit log repeats an operation identifier');
    const opIds = results.map((r) => r.opId).filter(Boolean);
    assert.equal(new Set(opIds).size, opIds.length, 'two processes reported the same operation identifier');
    const present = new Set(auditIds);
    // A record that is absent must have been reported as absent by the process that wrote it: that is
    // the one honest outcome of an append that failed, and anything else is an undisclosed gap.
    for (const r of results.filter((x) => x.opId && !present.has(x.opId))) {
      assert.equal(r.recorded, false, `${r.writer}/${r.label}: no audit line for ${r.opId}, yet it reported recorded=${r.recorded}`);
    }

    // Lock residue: the directory holds exactly the nine data files, the barrier, and nothing else.
    assert.deepEqual(unexpected(dir), [], 'a writer left a lock, token or temp file behind');
  });

  test('the provenance each store cites resolves in the audit log, across processes', async () => {
    const dir = tempDir();
    await fanout(dir, 1);
    const audit = new Set(recordsOf(dir, 'operations.jsonl').records.map((r) => r.id));

    // Memory and knowledge records name the operation that wrote them.
    for (const record of recordsOf(dir, 'memory.jsonl').records) {
      assert.ok(audit.has(record.provenance?.operationId), `memory claim ${record.id} cites ${record.provenance?.operationId}, which the audit log does not hold`);
    }
    for (const record of recordsOf(dir, 'knowledge.jsonl').records) {
      if (record.provenance?.operationId) {
        assert.ok(audit.has(record.provenance.operationId), `a knowledge record cites operation ${record.provenance.operationId}, which the audit log does not hold`);
      }
    }
    // An experience is defined as a reference to one audit record, so this one is not optional.
    const experiences = recordsOf(dir, 'experiences.jsonl').records.filter((r) => r.kind === 'experience');
    assert.ok(experiences.length > 0, 'the fixture wrote no experience to check');
    for (const exp of experiences) {
      assert.ok(audit.has(exp.operationId), `experience ${exp.id} references operation ${exp.operationId}, which the audit log does not hold`);
    }
    // A prediction's citations are experience identifiers, which must exist in the log they name.
    const expIds = new Set(experiences.map((r) => r.id));
    const predictions = recordsOf(dir, 'predictions.jsonl').records.filter((r) => r.kind === 'prediction');
    assert.ok(predictions.length > 0, 'the fixture wrote no prediction to check');
    let cited = 0;
    for (const line of predictions) {
      for (const id of [...(line.evidence?.supportingExperienceIds ?? []), ...(line.evidence?.contradictingExperienceIds ?? [])]) {
        cited += 1;
        assert.ok(expIds.has(id), `prediction ${line.id} cites experience ${id}, which is not stored`);
      }
    }
    // The cross-store reference path was actually exercised, rather than skipped by an empty list.
    assert.ok(cited > 0, 'no prediction cited an experience, so the cross-store check was not run');

    // The task log's step records name the operations that produced them.
    const steps = recordsOf(dir, 'tasks.jsonl').records.flatMap((l) => (l.steps ?? []).filter((s) => s.operationId));
    assert.ok(steps.length > 0, 'the fixture wrote no completed step to check');
    for (const step of steps) {
      assert.ok(audit.has(step.operationId), `step ${step.id} names operation ${step.operationId}, which the audit log does not hold`);
    }
  });
});

describe('AF-18 2: lost updates - eight processes correcting the one claim', () => {
  test('exactly one correction lands, the rest are refused, and the store holds one replacement', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    // The subject the store's own clause form recognises, so a replacement is a real correction.
    const seed = await app.controller.handle('remember that the launch code name is alpha', { origin: 'user' });
    assert.equal(seed.status, Outcome.SUCCESS_VERIFIED, seed.display);
    const target = recordsOf(dir, 'memory.jsonl').records.at(-1).id;

    const runs = await Promise.all(WRITERS.concat(['w5', 'w6', 'w7', 'w8'])
      .map((w) => runChild(CHILD, ['correct', dir, w, target], dir, { racers: 8 })));
    for (const run of runs) assert.equal(run.timedOut, false, `a correcting child hung: ${run.stdout.slice(0, 300)}`);
    const results = runs.flatMap((r) => r.results);
    assert.equal(results.length, 8, JSON.stringify(results.map((r) => [r.writer, r.status])));

    const accepted = results.filter((r) => r.ok);
    assert.equal(accepted.length, 1, `exactly one process may replace one claim; got ${describeResults(results)}`);

    // Every loser says what it did not do. A lock timeout and an already-corrected target are
    // different reasons, and both are honest - an unexplained failure is not.
    for (const r of results.filter((x) => !x.ok)) {
      assert.ok([Outcome.INPUT_REJECTED, Outcome.EXECUTION_FAILED].includes(r.status), `${r.writer}: unexpected status ${r.status}`);
      const reason = `${r.message ?? ''} ${r.display ?? ''} ${r.recordError ?? ''}`.toLowerCase();
      assert.match(reason, /corrected|contradict|in use|nothing was written|lock/, `${r.writer}: a refusal with no stated reason: ${JSON.stringify(r)}`);
    }

    // The store itself: the original claim plus one replacement, and no other process's write.
    const memory = recordsOf(dir, 'memory.jsonl').records;
    assert.equal(memory.length, 2, 'a second correction reached the store');
    assert.deepEqual(memory[1].provenance.replaces, [target]);
    assert.equal(memory[1].content, `the launch code name is corrected by writer ${accepted[0].writer}`);
    // The identifier the winning process published is the line the store holds, and no identifier
    // repeats - the seed claim is counted separately, so the store's total is one more than the
    // number of corrections that landed.
    const ids = memory.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'memory.jsonl repeats an identifier');
    assert.ok(ids.includes(accepted[0].recordId), 'the winning correction names an id the store does not hold');
    assert.equal(new Set(results.filter((r) => r.recordId).map((r) => r.recordId)).size, results.filter((r) => r.recordId).length, 'two correcting processes published the same identifier');
    assert.deepEqual(unexpected(dir), [], 'the losing writers left residue behind');

    // Audit consistency for the same race: every attempt is its own operation record, and only one
    // of them claims a verified correction.
    const auditRead = recordsOf(dir, 'operations.jsonl');
    assert.deepEqual(auditRead.bad, [], `operations.jsonl holds unparseable lines: ${JSON.stringify(auditRead.bad)}`);
    const audit = auditRead.records;
    assert.equal(new Set(audit.map((r) => r.id)).size, audit.length, 'the audit log repeats an identifier');
    assert.equal(audit.filter((r) => r.status === Outcome.SUCCESS_VERIFIED && r.capability === 'memory.correct').length, 1);
    const attempted = audit.filter((r) => r.capability === 'memory.correct').map((r) => r.id);
    assert.equal(attempted.length, results.filter((r) => r.opId).length, 'a correcting process is not in the audit log');
    for (const r of results.filter((x) => x.opId)) assert.ok(attempted.includes(r.opId) || r.recorded === false, `${r.writer}: neither an audit record nor a disclosure that it is missing`);
  });
});

describe('AF-18 3: a live holder makes the rest refuse, and their text says what they did not do', () => {
  test('three processes denied the memory lock report nothing written; the next one recovers and writes', async () => {
    const dir = tempDir();
    // A real process holding the real writer lock for longer than the denial window below. The
    // fixture's "0" spelling is deliberately not used: measured, a child whose only pending work is
    // an unsettled promise exits with Node's "unsettled top-level await" warning, so a 0 hold leaves
    // a claim from a dead pid - which is scenario 10's subject, but here it would let the waiting
    // writers take the lock over instead of being refused by a live holder.
    const holder = spawn(process.execPath, [HOLDER, 'hold-lock', dir, 'memory', '60000'], {
      env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, APEX_RACERS: '1' }),
      cwd: APP_ROOT, windowsHide: true,
    });
    const held = collect(holder);
    await waitForText(held, 'HELD');
    assert.match(held.text, /"file":"memory\.jsonl"/, held.text.slice(0, 400));
    assert.equal(JSON.parse(fs.readFileSync(file(dir, 'memory.jsonl.lock'), 'utf8')).pid, holder.pid, 'the live holder did not publish its own claim');

    const denied = await Promise.all(WRITERS.slice(0, 3)
      .map((w) => runChild(CHILD, ['ask', dir, w, `remember that the berth ${w} is taken`], dir)));
    for (const run of denied) {
      assert.equal(run.timedOut, false, `a waiting writer never returned: ${run.stdout.slice(0, 300)}`);
      assert.equal(run.results.length, 1, run.stdout.slice(0, 400));
      const [res] = run.results;
      // The request ran against a lock it could not take, so it must not claim a stored fact.
      assert.doesNotMatch(res.text, /Stored \(user fact\)/, `a denied writer claimed a stored memory: ${res.text}`);
      assert.match(res.text, /nothing was written|refused before it began/i, res.text);
      assert.match(res.text, /in use by process/, `the refusal does not name the holder it waited for: ${res.text}`);
      assert.notEqual(res.exit, 0, `a refused write must not exit 0: ${res.text}`);
    }
    assert.equal(recordsOf(dir, 'memory.jsonl').records.length, 0, 'a denied write left a record anyway');

    holder.kill();
    await new Promise((resolve) => holder.on('exit', resolve));
    // The abandoned claim is the previous holder's, and it is dead: the next writer recovers it and
    // the request succeeds. Nothing here shortened a timeout or loosened an ownership check.
    assert.ok(fs.existsSync(file(dir, 'memory.jsonl.lock')), 'the killed holder left no claim to recover');
    const after = await runChild(CHILD, ['ask', dir, 'w9', 'remember that the berth w9 is free'], dir);
    assert.equal(after.timedOut, false, after.stdout.slice(0, 300));
    assert.match(after.stdout, /Stored \(user fact\)/, after.stdout);
    const memory = recordsOf(dir, 'memory.jsonl').records;
    assert.equal(memory.length, 1);
    assert.equal(memory[0].content, 'the berth w9 is free');
    assert.deepEqual(unexpected(dir), [], 'recovery left a token or lock file behind');

    // The refusal of the live holder is visible in the audit trail too: the denied requests are
    // recorded as the failures they were, not silently dropped from the log.
    const audit = recordsOf(dir, 'operations.jsonl').records;
    const byStatus = audit.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    assert.ok(byStatus[Outcome.SUCCESS_VERIFIED] >= 1, JSON.stringify(byStatus));
    assert.equal(audit.filter((r) => r.status !== Outcome.SUCCESS_VERIFIED).length, 3, `each denied request should be audited once: ${JSON.stringify(byStatus)}`);
    assert.equal(new Set(audit.map((r) => r.id)).size, audit.length, 'the audit log repeats an identifier');
  });
});

describe('AF-18 4: the same fixture twice gives the same structure', () => {
  test('two independent runs of one shape produce equal per-store counts and statuses', async () => {
    // The two writers in one round run one after the other on purpose. This test's question is
    // whether the fixture's shape repeats, and a lock refusal under contention would make two runs
    // differ for a reason that has nothing to do with repeatability; tests 1 to 3 hold the contention.
    const shape = async () => {
      const dir = tempDir();
      const runs = [];
      for (const w of WRITERS.slice(0, 2)) {
        // eslint-disable-next-line no-await-in-loop
        runs.push(await runChild(CHILD, ['fanout', dir, w, '1'], dir));
      }
      const results = runs.flatMap((r) => r.results);
      return {
        timedOut: runs.map((r) => r.timedOut),
        counts: Object.fromEntries(Object.entries(STORE_OF).map(([label, store]) => [label, recordsOf(dir, store.file).records.length])),
        statuses: results.map((r) => [r.label, r.status, r.ok]),
        auditCaps: Object.entries(recordsOf(dir, 'operations.jsonl').records.reduce((m, r) => ({ ...m, [r.capability]: (m[r.capability] ?? 0) + 1 }), {}))
          .sort((a, b) => a[0].localeCompare(b[0])),
        residue: unexpected(dir),
        bad: Object.values(STORE_OF).map((store) => recordsOf(dir, store.file).bad.length)
          .concat([recordsOf(dir, 'operations.jsonl').bad.length, recordsOf(dir, 'tasks.jsonl').bad.length]),
      };
    };

    const first = await shape();
    const second = await shape();
    assert.deepEqual(first.timedOut, [false, false]);
    assert.deepEqual(second.timedOut, [false, false]);
    // Identifiers and timestamps differ between runs by design; what must not differ is the shape.
    assert.deepEqual(second.counts, first.counts);
    assert.deepEqual(second.statuses, first.statuses);
    assert.deepEqual(second.auditCaps, first.auditCaps);
    assert.deepEqual(second.bad, first.bad);
    assert.deepEqual(second.residue, first.residue);
    // And the shape is the one the fixture claims: two writers, one round, one record per store, and
    // every reported label successful.
    assert.deepEqual(first.counts, { memory: 2, knowledge: 2, experience: 2, prediction: 2 });
    assert.deepEqual(first.bad, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(first.statuses.map(([label, , ok]) => [label, ok]), [
      'memory', 'knowledge', 'experience', 'prediction', 'task-plan', 'task-run',
      'memory', 'knowledge', 'experience', 'prediction', 'task-plan', 'task-run',
    ].map((label) => [label, true]));
  });
});
