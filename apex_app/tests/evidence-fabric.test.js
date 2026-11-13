// Batch AP-06: the evidence fabric - one cross-store read window, one closed integrity vocabulary, and
// the consumers that now read through them.
//
// The claims under test are narrow and are meant to stay narrow. A snapshot proves that no contributing
// append-only file changed while a read was in progress; it is not a transaction, holds no lock, and
// cannot stop a writer. An integrity state is a statement about the records as they read now, never a
// claim that they are true. Every refusal is explicit: a window that changed is reported as a change to
// the read, never as an empty result, a success, or evidence of harm.
//
// Everything here is deterministic. Real child processes append to real files for the cross-process
// cases, the application is assembled with NoBackend and a fixed clock, and no model is contacted. No
// store is ever repaired by this suite, and the one same-size rewrite case exists to pin the documented
// limit of a stat-based window rather than to claim it is detected.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import {
  SNAPSHOT_SCHEMA,
  SNAPSHOT_STATES,
  MAX_SNAPSHOT_STORES,
  DEFAULT_SNAPSHOT_ATTEMPTS,
  MAX_SNAPSHOT_ATTEMPTS,
  storeIdentity,
  openEvidenceSnapshot,
  runConsistentEvidenceRead,
  contributingStores,
} from '../src/evidence/snapshot.js';
import {
  INTEGRITY_SCHEMA,
  EVIDENCE_READ_SCHEMA,
  INTEGRITY_STATES,
  INTEGRITY_USABLE_STATES,
  MAX_INTEGRITY_FINDINGS,
  integrityFinding,
  integrityReport,
  integrityUsable,
  isIntegrityState,
  worstIntegrityState,
  duplicateFindings,
  referenceFindings,
  digestFindings,
  snapshotFindings,
  evidenceIntegrityReport,
  renderEvidenceIntegrity,
} from '../src/evidence/integrity.js';
import { governanceReport } from '../src/plans/governance.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
const dir = () => { const d = makeTempDataDir(); dirs.push(d); return d; };

function clock(start = '2026-11-13T09:00:00.000Z') {
  let ms = Date.parse(start);
  const now = () => new Date(ms);
  now.advance = (minutes) => { ms += minutes * 60_000; };
  return now;
}

const appIn = (dataDir, now = clock()) => createApp({
  dataDir,
  now,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const data = (res) => res?.operation?.steps?.[0]?.result?.data ?? res?.result?.data ?? {};
const display = (res) => String(res?.display ?? res?.result?.display ?? res?.output ?? '');

// A file fixture inside a fresh temp directory. Nothing here is a real store unless a test says so.
function fixture(name = 'store.jsonl', text = '') {
  const d = dir();
  const filePath = path.join(d, name);
  fs.writeFileSync(filePath, text);
  return { dir: d, filePath };
}

// Append one blank line: JSONL readers skip blank lines, so the file grows without becoming corrupt.
// That isolates "the window moved" from "the store is damaged" in the tests that need each alone.
const bumpSize = async (filePath) => { await fs.promises.appendFile(filePath, '\n'); };

// A real child process that appends a complete JSONL line and exits. Used where the write must happen
// outside this process to be a genuine cross-process case rather than an in-process re-entrancy.
function childAppend(filePath, lines = 1) {
  const script = [
    "const fs = require('node:fs');",
    'const p = process.argv[1];',
    'const n = Number(process.argv[2]);',
    "for (let i = 0; i < n; i += 1) fs.appendFileSync(p, JSON.stringify({ n: i, pid: process.pid }) + '\\n');",
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, filePath, String(lines)], { windowsHide: true }, (err) => (
      err ? reject(err) : resolve()
    ));
  });
}

// A real child process that writes part of a line and is killed mid-write, leaving a truncated tail.
function childTruncatedTail(filePath) {
  const script = [
    "const fs = require('node:fs');",
    'const p = process.argv[1];',
    "fs.writeFileSync(p, '{\"kind\":\"record\",\"id\":\"half');",
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, filePath], { windowsHide: true }, (err) => (
      err ? reject(err) : resolve()
    ));
  });
}

// A store-shaped proxy whose named method appends to a file after it answers. Delegation is explicit
// because store instances keep their state in private fields and must not be copied.
function tamperingProxy(store, methodName, filePath) {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === methodName && typeof value === 'function') {
        return async (...args) => {
          const result = await value.apply(target, args);
          await bumpSize(filePath);
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function proxyHealth(store, health) {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'health') return health;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const allStores = (app) => ({
  experience: app.experience,
  plans: app.plans,
  operations: app.operations,
  goals: app.goals,
  knowledge: app.knowledge,
  memory: app.memory,
  predictions: app.predictions,
  world: app.worldModel,
  tasks: app.taskStore,
});

// ---- the window itself ------------------------------------------------------------------------

describe('AP-06 snapshot: a window that can be certified', () => {
  test('quiescent stores certify as consistent and record both identities', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    const b = fixture('b.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: [
      { name: 'a', filePath: a.filePath },
      { name: 'b', filePath: b.filePath },
    ] });
    const seen = await snapshot.read('a', async () => fs.promises.readFile(a.filePath, 'utf8'));
    const verdict = await snapshot.verify();
    assert.equal(verdict.schema, SNAPSHOT_SCHEMA);
    assert.equal(verdict.state, 'consistent');
    assert.equal(verdict.consistent, true);
    assert.equal(verdict.complete, true);
    assert.equal(verdict.reads, 1);
    assert.deepEqual(verdict.changed, []);
    assert.deepEqual(verdict.unverifiable, []);
    assert.equal(seen, '{"n":1}\n');
    const row = verdict.stores.find((store) => store.name === 'a');
    assert.equal(row.exists, true);
    assert.equal(row.size, 8);
    assert.equal(row.changed, false);
    assert.match(verdict.note, /not a transaction/);
  });

  test('a missing file is a real identity, not a change', async () => {
    const d = dir();
    const missing = path.join(d, 'never-created.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'missing', filePath: missing }] });
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'consistent');
    const row = verdict.stores.find((store) => store.name === 'missing');
    assert.equal(row.exists, false);
    assert.equal(row.state, 'absent');
    assert.equal(row.changed, false);
  });

  test('a store this build does not configure is omitted, never counted as a change', () => {
    const stores = contributingStores({ experience: { filePath: 'x' }, plans: null, operations: undefined, goals: {} });
    assert.deepEqual(stores.map((entry) => entry.name), ['experience']);
    assert.deepEqual(contributingStores({}), []);
  });

  test('a path that cannot be inspected makes the snapshot unverifiable, never consistent', async () => {
    const d = dir();
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'directory', filePath: d }] });
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'unverifiable');
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.complete, false);
    assert.deepEqual(verdict.unverifiable, ['directory']);
    assert.match(verdict.stores[0].detail, /not a regular file/);
  });

  test('an append inside the window is reported as concurrent modification of the read', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    await snapshot.read('a', async () => { await bumpSize(a.filePath); return 'ok'; });
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'concurrent_modification');
    assert.equal(verdict.consistent, false);
    assert.equal(verdict.changed.length, 1);
    assert.equal(verdict.changed[0].name, 'a');
    assert.equal(verdict.changed[0].from.size, 8);
    assert.equal(verdict.changed[0].to.size, 9);
    assert.match(snapshotFindings(verdict)[0].detail, /describes no single instant/);
  });

  test('a real child-process append inside the window is detected', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    await snapshot.read('a', async () => childAppend(a.filePath, 3));
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'concurrent_modification');
    assert.ok(verdict.changed[0].to.size > verdict.changed[0].from.size);
    const lines = fs.readFileSync(a.filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 4, 'the child wrote three records and the fixture line is still there');
  });

  test('a rewrite that changes the size is a change, not a silently shorter history', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n{"n":2}\n');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    fs.writeFileSync(a.filePath, '{"n":1}\n');
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'concurrent_modification');
    assert.ok(verdict.changed[0].to.size < verdict.changed[0].from.size);
  });

  test('a same-size rewrite that restores the modification time is outside what a stat can see (documented limit)', async () => {
    const a = fixture('a.jsonl', 'aaaa\n');
    const before = await storeIdentity(a.filePath);
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    fs.writeFileSync(a.filePath, 'bbbb\n');
    fs.utimesSync(a.filePath, new Date(before.mtimeMs), new Date(before.mtimeMs));
    const verdict = await snapshot.verify();
    assert.equal(fs.readFileSync(a.filePath, 'utf8'), 'bbbb\n');
    // This is the honest boundary: the stat window cannot see a replacement that preserves both size
    // and mtime. The stores' own content validation and digests remain the authority for it.
    assert.equal(verdict.state, 'consistent');
    assert.match(verdict.note, /says nothing about whether the records are true/);
  });

  test('the summary before verification is unverified rather than optimistically consistent', async () => {
    const a = fixture('a.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    const summary = snapshot.summary();
    assert.equal(summary.state, 'unverified');
    assert.equal(summary.consistent, false);
    assert.equal(summary.complete, false);
    assert.equal(summary.digest, null);
    assert.ok(summary.beginDigest);
  });

  test('one labeled read is performed once per snapshot', async () => {
    const a = fixture('a.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
    let calls = 0;
    const first = await snapshot.read('same', async () => { calls += 1; return calls; });
    const second = await snapshot.read('same', async () => { calls += 1; return calls; });
    await snapshot.read('other', async () => { calls += 1; return calls; });
    assert.equal(first, 1);
    assert.equal(second, 1);
    assert.equal(calls, 2);
    assert.equal((await snapshot.verify()).reads, 2);
  });

  test('a snapshot refuses more than its bounded store count', async () => {
    const stores = Array.from({ length: MAX_SNAPSHOT_STORES + 1 }, (_, i) => ({
      name: `s${i}`, filePath: path.join(dir(), `s${i}.jsonl`),
    }));
    await assert.rejects(openEvidenceSnapshot({ stores }), /at most 32 stores/);
  });

  test('two windows over unchanged bytes agree on both digests', async () => {
    const a = fixture('a.jsonl', '{"n":1}\n');
    const readOnce = async () => {
      const snapshot = await openEvidenceSnapshot({ stores: [{ name: 'a', filePath: a.filePath }] });
      await snapshot.read('a', async () => null);
      return snapshot.verify();
    };
    const first = await readOnce();
    const second = await readOnce();
    assert.equal(first.state, 'consistent');
    assert.equal(first.digest, second.digest);
    assert.equal(first.beginDigest, second.beginDigest);
  });
});

// ---- bounded consistent reads -------------------------------------------------------------------

describe('AP-06 bounded consistent read: retry is visible and finite', () => {
  test('a clean read certifies on the first attempt', async () => {
    const a = fixture('a.jsonl');
    let reads = 0;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'a', filePath: a.filePath }],
      read: async (snapshot) => snapshot.read('a', async () => { reads += 1; return 7; }),
    });
    assert.equal(run.ok, true);
    assert.equal(run.state, 'consistent');
    assert.equal(run.attempts, 1);
    assert.equal(run.value, 7);
    assert.equal(reads, 1);
  });

  test('a single mid-read append is retired by the next attempt and the retried read is certified', async () => {
    const a = fixture('a.jsonl');
    let attemptsSeen = 0;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'a', filePath: a.filePath }],
      read: async (snapshot) => {
        attemptsSeen += 1;
        const value = await snapshot.read('a', async () => attemptsSeen);
        if (attemptsSeen === 1) await bumpSize(a.filePath);
        return value;
      },
    });
    assert.equal(run.ok, true);
    assert.equal(run.state, 'consistent');
    assert.equal(run.attempts, 2);
    assert.equal(run.value, 2);
    assert.equal(attemptsSeen, 2);
  });

  test('a write inside every attempt exhausts the budget at exactly three and is refused, not retried forever', async () => {
    const a = fixture('a.jsonl');
    let attemptsSeen = 0;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'a', filePath: a.filePath }],
      read: async (snapshot) => {
        attemptsSeen += 1;
        await snapshot.read('a', async () => { await bumpSize(a.filePath); return null; });
        return null;
      },
    });
    assert.equal(run.ok, false);
    assert.equal(run.state, 'concurrent_modification');
    assert.equal(run.attempts, MAX_SNAPSHOT_ATTEMPTS);
    assert.equal(attemptsSeen, 3);
  });

  test('an unverifiable store is refused immediately and is never retried', async () => {
    const d = dir();
    let attemptsSeen = 0;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'directory', filePath: d }],
      attempts: 3,
      read: async () => { attemptsSeen += 1; return null; },
    });
    assert.equal(run.ok, false);
    assert.equal(run.state, 'unverifiable');
    assert.equal(run.attempts, 1);
    assert.equal(attemptsSeen, 1);
  });

  test('a read that throws propagates unchanged and is not converted into a concurrency finding', async () => {
    const a = fixture('a.jsonl');
    await assert.rejects(
      runConsistentEvidenceRead({
        stores: [{ name: 'a', filePath: a.filePath }],
        read: async () => { throw new StoreError('the store could not be read'); },
      }),
      /the store could not be read/,
    );
  });

  test('a throwing read on a later attempt still propagates rather than being swallowed as a retry', async () => {
    const a = fixture('a.jsonl');
    let attemptsSeen = 0;
    await assert.rejects(
      runConsistentEvidenceRead({
        stores: [{ name: 'a', filePath: a.filePath }],
        read: async (snapshot) => {
          attemptsSeen += 1;
          await snapshot.read('a', async () => {
            if (attemptsSeen === 1) { await bumpSize(a.filePath); return null; }
            throw new StoreError('the second read failed');
          });
        },
      }),
      /the second read failed/,
    );
    assert.equal(attemptsSeen, 2);
  });

  test('the caller cannot widen the retry budget past the maximum', async () => {
    assert.equal(MAX_SNAPSHOT_ATTEMPTS, 3);
    assert.equal(DEFAULT_SNAPSHOT_ATTEMPTS, 3);
    const a = fixture('a.jsonl');
    let attemptsSeen = 0;
    const run = await runConsistentEvidenceRead({
      stores: [{ name: 'a', filePath: a.filePath }],
      attempts: 100,
      read: async (snapshot) => {
        attemptsSeen += 1;
        await snapshot.read('a', async () => { await bumpSize(a.filePath); return null; });
      },
    });
    assert.equal(run.attempts, 3);
    assert.equal(attemptsSeen, 3);
  });
});

// ---- the closed vocabulary ----------------------------------------------------------------------

describe('AP-06 integrity vocabulary: closed, ordered, and never a repair', () => {
  test('the vocabulary is exactly the ten documented states in severity order', () => {
    assert.deepEqual([...INTEGRITY_STATES], [
      'valid', 'valid_bounded', 'missing', 'stale', 'conflicting',
      'broken_reference', 'damaged_store', 'truncated_history', 'concurrent_modification', 'unverifiable',
    ]);
    assert.deepEqual([...INTEGRITY_USABLE_STATES], ['valid', 'valid_bounded']);
    assert.deepEqual([...SNAPSHOT_STATES], ['consistent', 'concurrent_modification', 'unverifiable']);
    assert.ok(INTEGRITY_STATES.includes('concurrent_modification'));
    assert.ok(INTEGRITY_STATES.includes('unverifiable'));
  });

  test('an unknown state is a programming error, not a finding with an invented name', () => {
    assert.equal(isIntegrityState('valid'), true);
    assert.equal(isIntegrityState('probably_fine'), false);
    assert.throws(() => worstIntegrityState(['fine']), /unknown integrity state/);
    assert.throws(() => integrityFinding('fine', { check: 'x' }), /unknown integrity state/);
  });

  test('the worst state wins and an empty list is valid, never an absence of judgement', () => {
    assert.equal(worstIntegrityState([]), 'valid');
    assert.equal(worstIntegrityState(['valid', 'valid_bounded']), 'valid_bounded');
    assert.equal(worstIntegrityState(['missing', 'conflicting', 'valid']), 'conflicting');
    assert.equal(worstIntegrityState(['damaged_store', 'concurrent_modification']), 'concurrent_modification');
    assert.equal(worstIntegrityState(['unverifiable', 'unverifiable']), 'unverifiable');
  });

  test('a bounded read is valid_bounded, not truncated_history', () => {
    const report = integrityReport({ subject: 'x', truncated: true, truncatedSources: ['b', 'a'] });
    assert.equal(report.state, 'valid_bounded');
    assert.equal(report.usable, true);
    assert.deepEqual(report.truncatedSources, ['a', 'b']);
  });

  test('a reference outside the window is unread rather than broken, because a limit is not a fact', () => {
    const findings = referenceFindings({ references: [
      { to: 'a', status: 'resolved' },
      { to: 'b', status: 'out_of_window', check: 'plan' },
      { to: 'c', status: 'unread', check: 'plan' },
      { to: 'd', status: 'missing', check: 'plan' },
      { to: 'e', status: 'superseded' },
    ] });
    const byTarget = Object.fromEntries(findings.map((finding) => [finding.subject, finding.state]));
    assert.deepEqual(byTarget, { b: 'valid_bounded', c: 'valid_bounded', d: 'broken_reference' });
    assert.equal(worstIntegrityState(findings.map((finding) => finding.state)), 'broken_reference');
    assert.throws(
      () => referenceFindings({ references: [{ to: 'x', status: 'probably_missing' }] }),
      /unknown reference status/,
    );
  });

  test('a duplicate identity is conflicting and names the append that is actually read', () => {
    const findings = duplicateFindings({
      store: 'experience',
      records: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].state, 'conflicting');
    assert.equal(findings[0].check, 'duplicate_identity');
    assert.equal(findings[0].subject, 'a');
    assert.equal(findings[0].occurrences, 3);
    assert.match(findings[0].detail, /earliest append is the one read/);
  });

  test('a digest mismatch is conflicting, and carries both digests so the caller can see them', () => {
    const findings = digestFindings({ pairs: [
      { expected: 'aa', actual: 'aa' },
      { expected: 'aa', actual: 'bb', subject: 'report' },
      { expected: null, actual: 'bb' },
    ] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].state, 'conflicting');
    assert.equal(findings[0].expected, 'aa');
    assert.equal(findings[0].actual, 'bb');
    assert.equal(findings[0].subject, 'report');
  });

  test('a snapshot verdict becomes a finding only when it has something to disclose', () => {
    assert.deepEqual(snapshotFindings({ state: 'consistent' }), []);
    assert.deepEqual(snapshotFindings(null), []);
    assert.deepEqual(snapshotFindings({ state: 'unverified' }), []);
    const changed = snapshotFindings({ state: 'concurrent_modification', changed: [{ name: 'a' }, { name: 'b' }] });
    assert.equal(changed[0].state, 'concurrent_modification');
    assert.equal(changed[0].subject, 'a, b');
    const unverifiable = snapshotFindings({ state: 'unverifiable', unverifiable: ['c'] });
    assert.equal(unverifiable[0].state, 'unverifiable');
    assert.equal(unverifiable[0].subject, 'c');
  });

  test('findings are disclosed up to the bound, counted untrimmed, and the digest covers the untrimmed set', () => {
    const make = (n) => Array.from({ length: n }, (_, i) => integrityFinding('missing', {
      check: 'reference', subject: `subject-${i}`,
    }));
    const sixty = integrityReport({ subject: 'x', findings: make(60) });
    assert.equal(sixty.findings.length, MAX_INTEGRITY_FINDINGS);
    assert.equal(sixty.bounded.findings, 60);
    assert.equal(sixty.bounded.disclosed, MAX_INTEGRITY_FINDINGS);
    assert.equal(sixty.bounded.truncated, true);
    assert.equal(sixty.bounded.byState.missing, 60);
    assert.equal(sixty.state, 'missing');
    const fiftyNine = integrityReport({ subject: 'x', findings: make(59) });
    assert.equal(fiftyNine.findings.length, 50);
    assert.notEqual(fiftyNine.digest, sixty.digest, 'a clipped report does not pretend to have seen fewer');
  });

  test('every report says it authorizes nothing, and only usable states are usable', () => {
    const report = integrityReport({ subject: 'x' });
    assert.equal(report.schema, INTEGRITY_SCHEMA);
    assert.equal(report.authorizes, false);
    assert.equal(report.state, 'valid');
    assert.equal(report.usable, true);
    assert.equal(integrityUsable(report), true);
    assert.equal(integrityUsable(null), false);
    assert.equal(integrityUsable(integrityReport({ subject: 'x', findings: [integrityFinding('damaged_store', { check: 'c' })] })), false);
    assert.match(report.note, /does not establish that they are true/);
  });

  test('the digest describes what was found, not when it ran', () => {
    const findings = [integrityFinding('stale', { check: 'report_digest', subject: 'a' })];
    const first = integrityReport({ subject: 'x', findings, generatedAt: '2026-01-01T00:00:00.000Z' });
    const second = integrityReport({ subject: 'x', findings, generatedAt: '2030-01-01T00:00:00.000Z' });
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.generatedAt, second.generatedAt);
  });
});

// ---- the cross-store report ---------------------------------------------------------------------

describe('AP-06 evidence integrity report: one window over every configured store', () => {
  test('a build with no configured store states that there is nothing to certify', async () => {
    const report = await evidenceIntegrityReport({ stores: {} });
    assert.equal(report.schema, EVIDENCE_READ_SCHEMA);
    assert.equal(report.available, false);
    assert.equal(report.state, 'missing');
    assert.equal(report.usable, false);
    assert.equal(report.counts.stores, 0);
    assert.match(report.reason, /no evidence store is configured/);
    assert.equal(report.integrity.authorizes, false);
    assert.equal(report.digest, report.integrity.digest);
  });

  test('a healthy application certifies valid, with each store checked by the health it actually has', async () => {
    const app = await appIn(dir());
    const report = await evidenceIntegrityReport({ stores: allStores(app) });
    assert.equal(report.available, true);
    assert.equal(report.state, 'valid');
    assert.equal(report.usable, true);
    assert.equal(report.attempts, 1);
    assert.equal(report.counts.stores, 9);
    assert.equal(report.snapshot.state, 'consistent');
    const byName = Object.fromEntries(report.stores.map((row) => [row.name, row]));
    assert.equal(byName.experience.checked, 'health');
    assert.equal(byName.operations.checked, 'health');
    assert.equal(byName.knowledge.checked, 'health');
    assert.equal(byName.plans.checked, 'identity');
    assert.equal(byName.world.checked, 'identity');
    assert.equal(byName.tasks.checked, 'identity');
    assert.equal(byName.plans.records, null, 'a store without a health check makes no count claim');
    assert.equal(byName.experience.state, 'ok');
  });

  test('a corrupt line in any store is damaged_store while the read window itself stays consistent', async () => {
    const d = dir();
    const app = await appIn(d);
    fs.appendFileSync(path.join(d, 'memory.jsonl'), '{not json}\n');
    const report = await evidenceIntegrityReport({ stores: allStores(app) });
    assert.equal(report.available, true, 'the window was consistent; damage is a separate statement about the records');
    assert.equal(report.state, 'damaged_store');
    assert.equal(report.usable, false);
    assert.ok(report.integrity.findings.some((finding) =>
      finding.state === 'damaged_store' && finding.subject === 'memory' && /1 unreadable record line/.test(finding.detail)));
    const memory = report.stores.find((row) => row.name === 'memory');
    assert.equal(memory.corrupt, 1);
    assert.equal(memory.readable, true);
  });

  test('a health check that throws makes the report unverifiable and is not retried', async () => {
    const app = await appIn(dir());
    let healthCalls = 0;
    const memory = proxyHealth(app.memory, async () => {
      healthCalls += 1;
      throw new Error('the memory store could not be inspected');
    });
    const report = await evidenceIntegrityReport({ stores: { ...allStores(app), memory } });
    assert.equal(report.available, false);
    assert.equal(report.state, 'unverifiable');
    assert.equal(report.usable, false);
    assert.equal(report.attempts, 1);
    assert.equal(healthCalls, 1);
    assert.match(report.reason, /cannot be certified/);
    assert.ok(report.integrity.findings.some((finding) =>
      finding.state === 'unverifiable' && /could not be inspected/.test(finding.detail)));
  });

  test('a health check that reports itself unavailable is unverifiable, not valid and not zero records', async () => {
    const app = await appIn(dir());
    const memory = proxyHealth(app.memory, async () => ({
      state: 'unavailable', inspected: false, complete: false, detail: 'the file is unreadable',
      records: null, corruptLines: null, corrupt: [],
    }));
    const report = await evidenceIntegrityReport({ stores: { ...allStores(app), memory } });
    assert.equal(report.available, false);
    assert.equal(report.state, 'unverifiable');
    assert.equal(report.stores.find((row) => row.name === 'memory').readable, false);
  });

  test('a store with a truncated history is truncated_history, and still says nothing about the records it lost', async () => {
    const app = await appIn(dir());
    const experience = proxyHealth(app.experience, async () => ({
      state: 'ok', inspected: true, complete: true, records: 3, corruptLines: 0, corrupt: [], truncated: true,
    }));
    const report = await evidenceIntegrityReport({ stores: { ...allStores(app), experience } });
    assert.equal(report.state, 'truncated_history');
    assert.equal(report.usable, false);
    assert.ok(report.integrity.findings.some((finding) => finding.state === 'truncated_history'));
  });

  test('an identity-only store is inspected by identity and no damage is invented for it', async () => {
    const d = dir();
    const app = await appIn(d);
    // Garbage in a store this build has no health check for is not evidence of damage: nothing inspected it.
    fs.appendFileSync(path.join(d, 'goals.jsonl'), '{not json}\n');
    const report = await evidenceIntegrityReport({ stores: allStores(app) });
    const goals = report.stores.find((row) => row.name === 'goals');
    assert.equal(goals.checked, 'identity');
    assert.equal(goals.corrupt, null);
    assert.equal(goals.readable, null);
    assert.ok(!report.integrity.findings.some((finding) => finding.subject === 'goals'));
    assert.equal(report.state, 'valid');
  });

  test('two reads over unchanged records agree on the digest', async () => {
    const app = await appIn(dir());
    const first = await evidenceIntegrityReport({ stores: allStores(app) });
    const second = await evidenceIntegrityReport({ stores: allStores(app) });
    assert.equal(first.digest, second.digest);
    assert.equal(first.snapshot.digest, second.snapshot.digest);
  });

  test('a change inside every attempt is refused at the budget as concurrent_modification, never reported as valid or damaged', async () => {
    const d = dir();
    const app = await appIn(d);
    const experiencePath = path.join(d, 'experiences.jsonl');
    const experience = proxyHealth(app.experience, async () => {
      const health = await app.experience.health();
      await bumpSize(experiencePath);
      return health;
    });
    const report = await evidenceIntegrityReport({ stores: { ...allStores(app), experience } });
    assert.equal(report.available, false);
    assert.equal(report.state, 'concurrent_modification');
    assert.equal(report.attempts, 3);
    assert.match(report.reason, /retried 2 time/);
    assert.equal(report.integrity.state, 'concurrent_modification');
  });

  test('the renderer states the window limit and never claims truth', async () => {
    const app = await appIn(dir());
    const report = await evidenceIntegrityReport({ stores: allStores(app) });
    const text = renderEvidenceIntegrity(report);
    assert.match(text, /Evidence integrity: valid/);
    assert.match(text, /experience: absent \| health \| absent/);
    assert.match(text, /not a transaction/);
    assert.match(text, /never that the records are true/);
    assert.match(renderEvidenceIntegrity(null), /No evidence-integrity report/);
  });
});

// ---- the action path ----------------------------------------------------------------------------

describe('AP-06 evidence.integrity action: read-only, verified by a second window', () => {
  test('the controller runs the action, shows the vocabulary, and records one audit line', async () => {
    const d = dir();
    const app = await appIn(d);
    const res = await app.controller.evidenceIntegrity();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output);
    const report = data(res).report;
    assert.equal(report.schema, EVIDENCE_READ_SCHEMA);
    assert.equal(report.state, 'valid');
    assert.equal(report.authorizes, false);
    assert.match(display(res), /Evidence integrity: valid/);
    assert.match(display(res), /Nothing was repaired/);
    const audit = fs.readFileSync(path.join(d, 'operations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const recorded = audit.filter((record) => record.capability === 'evidence.integrity');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].steps[0].authorization.decision, 'allow');
    assert.equal(app.registry.get('evidence.integrity').permission, 'read');
  });

  test('the verifier re-reads the whole window and refuses when a store changed after the read', async () => {
    const d = dir();
    const app = await appIn(d);
    const def = app.registry.get('evidence.integrity');
    assert.ok(def, 'the action is registered');
    const ctx = { ...allStores(app), now: () => new Date() };
    const result = await def.execute(ctx);
    const unchanged = await def.verify(ctx, {}, result);
    assert.equal(unchanged.ok, true, unchanged.detail);
    assert.match(unchanged.detail, /nothing was repaired or changed/);

    fs.appendFileSync(path.join(d, 'memory.jsonl'), '{not json}\n');
    const changed = await def.verify(ctx, {}, result);
    assert.equal(changed.ok, false);
    assert.match(changed.detail, /changed between two reads/);
  });

  test('the verifier refuses an unchanged unavailable condition instead of calling it verified', async () => {
    const app = await appIn(dir());
    const def = app.registry.get('evidence.integrity');
    const broken = proxyHealth(app.memory, async () => { throw new Error('memory is unreadable'); });
    const ctx = { ...allStores(app), memory: broken, now: () => new Date() };
    const result = await def.execute(ctx);
    assert.equal(result.data.report.available, false);
    const verdict = await def.verify(ctx, {}, result);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /the same condition remains/);
  });
});

// ---- the consumers ------------------------------------------------------------------------------

describe('AP-06 consumers: governance and effectiveness read through one window', () => {
  const GUIDANCE = 'read the list before adding to it';

  async function seedRule(app, guidance = GUIDANCE) {
    for (const n of [1, 2]) {
      const write = await app.controller.handle(`remember that the fabric note ${n} holds`, { origin: 'user' });
      assert.equal(write.status, Outcome.SUCCESS_VERIFIED, write.output);
      const experience = await app.controller.experienceRecord({ operationId: write.operation.id, subject: 'a memory write' });
      assert.equal(experience.status, Outcome.SUCCESS_VERIFIED, experience.output);
      const feedback = await app.controller.feedbackRecord({
        target: data(experience).id, assessment: 'user_correction', guidance, reason: 'done the long way round',
      });
      assert.equal(feedback.status, Outcome.SUCCESS_VERIFIED, feedback.output);
    }
    const derived = data(await app.controller.adaptationDerive({}));
    const adaptation = derived.created.find((rule) => rule.rule === guidance);
    assert.ok(adaptation);
    assert.equal((await app.controller.adaptationDecide({
      target: adaptation.id, decision: 'approved', reason: 'this is how I want it done',
    })).status, Outcome.SUCCESS_VERIFIED);
    return adaptation;
  }

  test('a governance report discloses one consistent window and the same digest twice', async () => {
    const app = await appIn(dir());
    const adaptation = await seedRule(app);
    const first = await app.controller.adaptationReviews({});
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED, first.output);
    const report = data(first).report;
    assert.equal(report.snapshot.state, 'consistent');
    assert.equal(report.integrity.authorizes, false);
    assert.ok(['valid', 'valid_bounded'].includes(report.integrity.state), report.integrity.state);
    assert.ok(report.snapshot.stores.some((store) => store.name === 'experience'));
    assert.ok(report.adaptations.some((row) => row.id === adaptation.id));
    const second = await app.controller.adaptationReviews({});
    assert.equal(data(second).report.digest, report.digest);
  });

  test('an effectiveness read is certified by the same window', async () => {
    const app = await appIn(dir());
    const adaptation = await seedRule(app);
    const first = await app.controller.adaptationEffectiveness({ target: adaptation.id });
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED, first.output);
    const report = data(first).report;
    assert.equal(report.snapshot.state, 'consistent');
    assert.equal(report.integrity.authorizes, false);
    assert.ok(['valid', 'valid_bounded'].includes(report.integrity.state), report.integrity.state);
    // Unlike governance, this report counts the audit records it read, and its own audit line lands
    // after the read. The second report therefore sees one more record and says so instead of
    // pretending the audit log it observed is unchanged.
    const second = data(await app.controller.adaptationEffectiveness({ target: adaptation.id })).report;
    assert.equal(second.snapshot.state, 'consistent');
    assert.ok(second.reads.auditRecords >= report.reads.auditRecords);
    assert.ok(second.reads.auditRecords > report.reads.auditRecords, 'the second read discloses its own audit record');
  });

  test('an effectiveness read discloses a clipped adaptation window instead of an unstated limit', async () => {
    const app = await appIn(dir());
    for (let i = 1; i <= 20; i += 1) await seedRule(app, `fabric rule ${i} reads before writing`);
    const full = await app.controller.adaptationEffectiveness({});
    assert.equal(full.status, Outcome.SUCCESS_VERIFIED, full.output);
    const fullReport = data(full).report;
    assert.equal(fullReport.totals.adaptations, 20);
    assert.equal(fullReport.integrity.truncated, false, 'a window that holds every stored rule is not truncated');

    // One more stored rule than the window. The report still states twenty rows, and now says the
    // window itself was a bound rather than letting the missing rule look like an absence.
    await seedRule(app, 'fabric rule 21 reads before writing');
    const clipped = await app.controller.adaptationEffectiveness({});
    assert.equal(clipped.status, Outcome.SUCCESS_VERIFIED, clipped.output);
    const clippedReport = data(clipped).report;
    assert.equal(clippedReport.totals.adaptations, 20);
    assert.equal(clippedReport.integrity.truncated, true);
    assert.ok(clippedReport.integrity.truncatedSources.includes('adaptations'));
    assert.equal(clippedReport.integrity.state, 'valid_bounded');
  });

  test('a write inside every governance attempt is refused explicitly, not answered from mixed instants', async () => {
    const d = dir();
    const app = await appIn(d);
    await seedRule(app);
    const plansPath = path.join(d, 'plans.jsonl');
    const experience = tamperingProxy(app.experience, 'reviews', plansPath);
    const report = await governanceReport({
      experience,
      plans: app.plans,
      operations: app.operations,
      goals: app.goals,
      knowledge: app.knowledge,
      memory: app.memory,
      predictions: app.predictions,
    });
    assert.equal(report.available, false);
    assert.equal(report.state, 'concurrent_modification');
    assert.equal(report.attempts, MAX_SNAPSHOT_ATTEMPTS);
    assert.match(report.reason, /did not exist at one instant/);
    assert.deepEqual(report.adaptations, [], 'a refused report states no rows rather than a partial answer');
    assert.equal(report.totals, null);
    assert.equal(report.authorizes, false);
  });

  test('the same governance read is certified once the writer stops inside the budget', async () => {
    const d = dir();
    const app = await appIn(d);
    await seedRule(app);
    // Two of the three allowed attempts see a write; the third sees none, so the read is certified.
    let writes = 2;
    const plansPath = path.join(d, 'plans.jsonl');
    const experience = new Proxy(app.experience, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'reviews' && typeof value === 'function') {
          return async (...args) => {
            const answer = await value.apply(target, args);
            if (writes > 0) { writes -= 1; await bumpSize(plansPath); }
            return answer;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const report = await governanceReport({
      experience,
      plans: app.plans,
      operations: app.operations,
      goals: app.goals,
      knowledge: app.knowledge,
      memory: app.memory,
      predictions: app.predictions,
    });
    assert.equal(report.available, true);
    assert.equal(report.snapshot.state, 'consistent');
    assert.equal(writes, 0);
  });
});

// ---- cross-process and interruption -------------------------------------------------------------

describe('AP-06 cross-process and interruption behaviour', () => {
  test('a child that stops mid-line leaves a truncated tail that is damage, not a replayed or repaired record', async () => {
    const d = dir();
    const app = await appIn(d);
    const filePath = path.join(d, 'experiences.jsonl');
    await childTruncatedTail(filePath);
    const sizeBefore = fs.statSync(filePath).size;
    const report = await evidenceIntegrityReport({ stores: allStores(app) });
    assert.equal(report.state, 'damaged_store');
    assert.equal(fs.statSync(filePath).size, sizeBefore, 'the read repaired nothing');
    const detail = report.integrity.findings.find((finding) => finding.subject === 'experience');
    assert.match(detail.detail, /1 unreadable record line/);
  });

  test('interruption of the read itself is a failure, not an unverified-but-passed result', async () => {
    const a = fixture('a.jsonl');
    let attemptsSeen = 0;
    await assert.rejects(
      runConsistentEvidenceRead({
        stores: [{ name: 'a', filePath: a.filePath }],
        read: async () => { attemptsSeen += 1; throw new StoreError('interrupted before the read finished'); },
      }),
      /interrupted before the read finished/,
    );
    assert.equal(attemptsSeen, 1, 'an interrupted read is not retried into an apparent success');
  });

  test('a real child writer racing a real application read never turns the window into a success claim', async () => {
    const d = dir();
    const app = await appIn(d);
    await app.controller.handle('remember that the race note holds', { origin: 'user' });
    const plansPath = path.join(d, 'plans.jsonl');
    const snapshot = await openEvidenceSnapshot({ stores: contributingStores(allStores(app)) });
    await snapshot.read('race', async () => {
      // The child writes to a different contributing store than the one this process reads, so the
      // application read itself stays well-formed while the combined window is still perturbed by a
      // writer this process did not make. One writer, not two: two would interleave partial lines and
      // damage the file, which is a different condition than the window question under test.
      await childAppend(plansPath, 3);
      return app.memory.search('race');
    });
    const verdict = await snapshot.verify();
    assert.equal(verdict.state, 'concurrent_modification');
    assert.equal(verdict.consistent, false);
    assert.ok(verdict.changed.some((entry) => entry.name === 'plans'));
  });
});
