// Recorded deadlines: a date the owner read from a local file, kept with its source path,
// digest, and line. Every test runs through the assembled application in a temp data directory
// and a temp workspace root, with a fixed clock so a day count is a fact rather than a guess.
// Nothing here calls a model.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';
import { MAX_DEADLINES, deadlineIdentity } from '../src/deadlines/store.js';
import { MAX_IMPORT_BYTES } from '../src/actions/deadline-actions.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function fixture() {
  const root = tempDir();
  return root;
}

function write(root, name, text) {
  fs.writeFileSync(path.join(root, name), text);
}

function appFor(root) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root, now: () => NOW });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

const auditLines = (dir) => readJsonl(path.join(dir, 'operations.jsonl'));

const JSONL = [
  '{"title": "submit the quarterly report", "dueAt": "2026-11-20"}',
  '{"title": "renew the parking permit", "dueAt": "2026-11-10"}',
].join('\n');

describe('deadline.import', () => {
  test('records each date with its source path, digest, and line, and schedules nothing', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);

    const res = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.deepEqual([data.added, data.duplicates, data.total], [2, 0, 2]);
    assert.equal(data.format, 'jsonl');
    assert.equal(data.path, 'plan.jsonl');
    assert.match(data.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(data.entries.map((entry) => entry.line), [1, 2]);
    assert.match(res.display, /nothing was scheduled, and no due date was inferred/);

    const stored = readJsonl(path.join(app.dataDir, 'deadlines.jsonl'));
    assert.equal(stored.length, 2);
    for (const record of stored) {
      assert.equal(record.source.path, 'plan.jsonl');
      assert.equal(record.source.sha256, data.sha256);
      assert.equal(record.provenance.origin, 'user_supplied');
      assert.ok(Number.isInteger(record.source.line) && record.source.line >= 1);
    }
    assert.deepEqual(stored.map((record) => record.dueAt), ['2026-11-20', '2026-11-10']);

    // One audit line for the request, and no experience: the ledger class is excluded from
    // automatic capture, so the owner's schedule is not copied into the behaviour log.
    assert.equal(auditLines(app.dataDir).length, 1);
    assert.equal(auditLines(app.dataDir)[0].capability, 'deadline.import');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'experiences.jsonl')), false);
  });

  test('reads CSV and TSV by their header, including a quoted field with a comma', async () => {
    const root = fixture();
    write(root, 'plan.csv', 'title,dueAt\n"submit the report, reviewed",2026-11-20\n');
    write(root, 'plan.tsv', 'title\tdueAt\nrenew the permit\t2026-11-10\n');

    const app = appFor(root);
    const csv = await app.controller.deadlineImport({ path: 'plan.csv' });
    assert.equal(csv.status, Outcome.SUCCESS_VERIFIED, csv.display);
    assert.equal(csv.operation.steps[0].result.data.added, 1);
    assert.equal(csv.operation.steps[0].result.data.format, 'csv');

    const tsv = await app.controller.deadlineImport({ path: 'plan.tsv' });
    assert.equal(tsv.status, Outcome.SUCCESS_VERIFIED, tsv.display);
    assert.equal(tsv.operation.steps[0].result.data.format, 'tsv');
    assert.equal(tsv.operation.steps[0].result.data.added, 1);
  });

  test('refuses a file that is not JSONL, NDJSON, CSV, or TSV, and one whose header is wrong', async () => {
    const root = fixture();
    write(root, 'plan.txt', 'submit the report, 2026-11-20\n');
    write(root, 'wrong.csv', 'name,date\nsubmit the report,2026-11-20\n');
    const app = appFor(root);

    const unsupported = await app.controller.deadlineImport({ path: 'plan.txt' });
    assert.equal(unsupported.status, Outcome.EXECUTION_FAILED);
    assert.match(unsupported.display, /no supported extension/);

    const header = await app.controller.deadlineImport({ path: 'wrong.csv' });
    assert.equal(header.status, Outcome.EXECUTION_FAILED);
    assert.match(header.display, /header naming a "title" column and a "dueAt" column/);
  });

  test('refuses the whole file on one malformed date and names the line', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', [
      '{"title": "submit the report", "dueAt": "2026-11-20"}',
      '{"title": "renew the permit", "dueAt": "2026-02-30"}',
      '{"title": "plan the trip", "dueAt": "2026-12-01"}',
    ].join('\n'));
    const app = appFor(root);

    const res = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /line 2: dueAt is not a real calendar date: 2026-02-30/);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false, 'a refused import stores nothing');
  });

  test('refuses an instant without a UTC marker, a missing field, and an unexpected field', async () => {
    const root = fixture();
    const cases = [
      ['nozone.jsonl', '{"title": "submit", "dueAt": "2026-11-20T10:00"}', /must be a date \(YYYY-MM-DD\) or a UTC instant ending in Z/],
      ['missing.jsonl', '{"title": "submit"}', /dueAt must be text/],
      ['extra.jsonl', '{"title": "submit", "dueAt": "2026-11-20", "note": "x"}', /unexpected field "note"/],
    ];
    const app = appFor(root);
    for (const [name, text, pattern] of cases) {
      write(root, name, text);
      const res = await app.controller.deadlineImport({ path: name });
      assert.equal(res.status, Outcome.EXECUTION_FAILED, name);
      assert.match(res.display, pattern, name);
    }
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false);
  });

  test('stores a normalized UTC instant beside a calendar date', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', '{"title": "submit the report", "dueAt": "2026-11-20T09:30Z"}\n');
    const app = appFor(root);
    const res = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const [record] = readJsonl(path.join(app.dataDir, 'deadlines.jsonl'));
    assert.equal(record.dueAt, '2026-11-20T09:30:00.000Z');
  });

  test('refuses a title that looks like a credential before anything is stored', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', '{"title": "password: hunter2secret", "dueAt": "2026-11-20"}\n');
    const app = appFor(root);
    const res = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /looks like a password, key, or token/);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false);
  });

  test('rejects an import larger than the ledger bound without reading further', async () => {
    const root = fixture();
    const lines = [];
    for (let i = 0; i < MAX_DEADLINES + 1; i += 1) {
      lines.push(JSON.stringify({ title: `task ${i}`, dueAt: '2026-12-01' }));
    }
    write(root, 'too-many.jsonl', lines.join('\n'));
    const app = appFor(root);
    const res = await app.controller.deadlineImport({ path: 'too-many.jsonl' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, new RegExp(`at most ${MAX_DEADLINES} may be imported at once`));
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false);
  });

  test('re-importing the same entries adds nothing, and a moved line is still the same deadline', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    await app.controller.deadlineImport({ path: 'plan.jsonl' });

    const again = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(again.status, Outcome.SUCCESS_VERIFIED, again.display);
    assert.deepEqual(
      [again.operation.steps[0].result.data.added, again.operation.steps[0].result.data.duplicates],
      [0, 2],
    );
    assert.equal(readJsonl(path.join(app.dataDir, 'deadlines.jsonl')).length, 2);

    // The identity is the content, not the line: reordering the file adds nothing either.
    write(root, 'plan.jsonl', JSONL.split('\n').reverse().join('\n'));
    const moved = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(moved.operation.steps[0].result.data.added, 0);
    assert.equal(readJsonl(path.join(app.dataDir, 'deadlines.jsonl')).length, 2);
  });

  test('refuses a path outside the root and an absolute path', async () => {
    const root = fixture();
    const outside = tempDir();
    write(outside, 'elsewhere.jsonl', JSONL);
    const app = appFor(root);

    const escape = await app.controller.deadlineImport({ path: '../elsewhere.jsonl' });
    assert.equal(escape.status, Outcome.EXECUTION_FAILED);

    const absolute = await app.controller.deadlineImport({ path: path.join(outside, 'elsewhere.jsonl') });
    assert.equal(absolute.status, Outcome.EXECUTION_FAILED);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false);
  });

  test('a model origin cannot import a deadline and changes nothing', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    const step = await app.controller.runAction('deadline.import', { path: 'plan.jsonl' }, 'model', 'op-model');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.execution.status, 'not_run');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'deadlines.jsonl')), false);
  });

  test('the verifier re-reads the source and reports a file that changed after the import', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    const res = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    const step = res.operation.steps[0];
    const def = app.registry.get('deadline.import');
    const input = def.validate({ path: 'plan.jsonl' });

    const fresh = await def.verify({ now: () => NOW }, input, step.result);
    assert.equal(fresh.ok, true, fresh.detail);

    write(root, 'plan.jsonl', `${JSONL}\n{"title": "plan the trip", "dueAt": "2026-12-01"}`);
    const changed = await def.verify({ now: () => NOW }, input, step.result);
    assert.equal(changed.ok, false);
    assert.match(changed.detail, /changed since it was imported/);
  });
});

describe('deadline.list', () => {
  test('lists earliest first with day counts, filters by horizon, and counts what is overdue', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    await app.controller.deadlineImport({ path: 'plan.jsonl' });

    const all = await app.controller.deadlineList({ horizonDays: 30 });
    assert.equal(all.status, Outcome.SUCCESS_VERIFIED, all.display);
    const data = all.operation.steps[0].result.data;
    assert.deepEqual([data.total, data.within, data.overdue], [2, 2, 1]);
    assert.deepEqual(data.items.map((item) => item.dueAt), ['2026-11-10', '2026-11-20']);
    assert.deepEqual(data.items.map((item) => item.daysUntil), [-5, 5]);
    assert.equal(data.items[0].source.path, 'plan.jsonl');
    assert.match(all.display, /\(from plan\.jsonl:2\)/);
    assert.match(all.display, /recorded dates only; APEX schedules nothing/);

    const narrow = await app.controller.deadlineList({ horizonDays: 0 });
    assert.equal(narrow.operation.steps[0].result.data.within, 1, 'only the overdue date is within a zero-day horizon');
  });

  test('bounds its arguments and counts nothing it was not asked for', async () => {
    const app = createApp({ dataDir: tempDir(), now: () => NOW });
    for (const input of [{ limit: 0 }, { limit: 201 }, { horizonDays: -1 }, { horizonDays: 3651 }]) {
      const res = await app.controller.deadlineList(input);
      assert.equal(res.status, Outcome.INPUT_REJECTED, JSON.stringify(input));
    }
    const empty = await app.controller.deadlineList();
    assert.equal(empty.status, Outcome.SUCCESS_VERIFIED, empty.display);
    assert.match(empty.display, /No deadlines have been imported/);
  });

  test('a model origin cannot read the ledger through runAction', async () => {
    const app = createApp({ dataDir: tempDir(), now: () => NOW });
    const step = await app.controller.runAction('deadline.list', {}, 'model', 'op-model');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.execution.status, 'not_run');
  });

  test('a corrupt ledger is reported as a refusal, never as an empty one', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    await app.controller.deadlineImport({ path: 'plan.jsonl' });
    fs.appendFileSync(path.join(app.dataDir, 'deadlines.jsonl'), 'not a json record\n');

    const res = await app.controller.deadlineList();
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /corrupt line/);

    const status = await app.getStatus();
    assert.equal(status.deadlineRecords, 2);
    assert.equal(status.corruptDeadlineLines, 1);
  });
});

describe('work.review reads the ledger', () => {
  test('the review counts recorded dates, derives deadline attention, and names the source line', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    await app.controller.deadlineImport({ path: 'plan.jsonl' });

    const res = await app.controller.workReview({ horizonDays: 7 });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.sources.deadlines.state, 'ok');
    assert.equal(data.sources.deadlines.records, 2);
    assert.deepEqual(data.counts.deadlines, { total: 2, within: 2, overdue: 1 });
    assert.equal(data.deadlines.length, 2);

    const kinds = data.attention.map((item) => item.kind);
    assert.ok(kinds.includes('deadline_due'));
    assert.ok(kinds.includes('deadline_overdue'));
    const overdue = data.attention.find((item) => item.kind === 'deadline_overdue');
    assert.match(overdue.detail, /passed 5 day\(s\) ago \(from plan\.jsonl:2\)/);
    assert.equal(overdue.refs.deadlineId, data.deadlines.find((item) => item.title === 'renew the parking permit').id);

    assert.match(res.display, /deadlines: 2 recorded, 2 within 7 day\(s\), 1 overdue/);
    assert.match(res.display, /Deadlines \(2 shown\):/);
    assert.match(res.display, /from plan\.jsonl:1/);
    assert.match(res.display, /APEX does not infer a due date, schedule a reminder, or act when one passes/);

    const narrow = await app.controller.workReview({ horizonDays: 0 });
    const narrowKinds = narrow.operation.steps[0].result.data.attention.map((item) => item.kind);
    assert.ok(narrowKinds.includes('deadline_overdue'));
    assert.ok(!narrowKinds.includes('deadline_due'), 'a date outside the horizon is not called out');
    assert.equal(narrow.operation.steps[0].result.data.counts.deadlines.within, 1);
  });

  test('an unreadable ledger is shown as unavailable while the rest of the board is still read', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    const imported = await app.controller.deadlineImport({ path: 'plan.jsonl' });
    assert.equal(imported.status, Outcome.SUCCESS_VERIFIED, imported.display);
    fs.appendFileSync(path.join(app.dataDir, 'deadlines.jsonl'), 'not a json record\n');

    const res = await app.controller.workReview();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.sources.deadlines.state, 'unavailable');
    assert.equal(data.sources.deadlines.records, null);
    assert.equal(data.counts.deadlines.total, 0);
    assert.match(res.display, /Deadlines: unavailable - the store could not be read/);
    assert.match(res.display, /reported as unavailable, not as empty: deadlines/);
  });
});

describe('natural language and CLI', () => {
  test('routes a deadline import and a due question to the same actions, and leaves prose alone', () => {
    const imported = route('import the deadlines from plan.csv');
    assert.equal(imported.action, 'deadline.import');
    assert.equal(imported.input.path, 'plan.csv');

    const due = route('what is due within 14 days');
    assert.equal(due.action, 'deadline.list');
    assert.equal(due.input.horizonDays, 14);
    for (const text of ['deadlines', 'deadline list', 'list my deadlines', "what's due?"]) {
      assert.equal(route(text).action, 'deadline.list', text);
    }

    // Ordinary prose that merely mentions a deadline stays on the model path.
    assert.notEqual(route('remind me about my deadlines tomorrow').action, 'deadline.list');
    assert.notEqual(route('import the deadlines from my notes').action, 'deadline.import');
  });

  test('answers a due question through handle with the recorded dates', async () => {
    const root = fixture();
    write(root, 'plan.jsonl', JSONL);
    const app = appFor(root);
    await app.controller.deadlineImport({ path: 'plan.jsonl' });

    const res = await app.controller.handle('what is due within 30 days', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal(res.operation.capability, 'deadline.list');
    assert.match(res.display, /renew the parking permit/);
    assert.match(res.display, /submit the quarterly report/);
  });

  test('the CLI imports and lists, and refuses a malformed command or a bound it cannot meet', async () => {
    const root = fixture();
    write(root, 'plan.csv', 'title,dueAt\nsubmit the report,2099-01-01\n');
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, APEX_FILESYSTEM_ROOT: root });

    const imported = await runCli(['deadline', 'import', 'plan.csv'], env);
    assert.equal(imported.code, 0, imported.stderr + imported.stdout);
    assert.match(imported.stdout, /Imported 1 new deadline\(s\) from "plan\.csv"/);
    assert.match(imported.stdout, /nothing was scheduled/);
    assert.match(imported.stdout, /Audit: recorded in operations\.jsonl/);

    const listed = await runCli(['deadline', 'list'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /No recorded deadlines within 30 day\(s\)/);
    assert.match(listed.stdout, /The ledger holds 1 later deadline\(s\)/);

    const refused = await runCli(['deadline', 'list', '--limit', '0'], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout + refused.stderr, /limit must be an integer/);

    const unexpected = await runCli(['deadline', 'listen'], env);
    assert.equal(unexpected.code, 2);

    const missingPath = await runCli(['deadline', 'import'], env);
    assert.equal(missingPath.code, 2);
  });
});

describe('the ledger record is the store\'s own contract', () => {
  test('the identity is content, not position, and normalizes case and spacing', () => {
    assert.equal(
      deadlineIdentity('Submit  The Report', '2026-11-20'),
      deadlineIdentity('submit the report', '2026-11-20'),
    );
    assert.notEqual(
      deadlineIdentity('submit the report', '2026-11-20'),
      deadlineIdentity('submit the report', '2026-11-21'),
    );
  });

  test('the import bound is the store bound, not a second number', () => {
    assert.equal(MAX_IMPORT_BYTES, 2 * 1024 * 1024);
    assert.equal(typeof MAX_DEADLINES, 'number');
  });
});
