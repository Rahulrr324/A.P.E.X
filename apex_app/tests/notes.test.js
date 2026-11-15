// Structured personal notes: the append-only store, the seven registered actions, the digest-topic
// workflow, the natural-language routes and the CLI. Everything here is deterministic; no model is
// called and no inference is involved.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { NoteStore } from '../src/notes/note-store.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';
import {
  AUTO_CAPTURE_CAPABILITIES,
  CAPTURE_EXCLUDED_CAPABILITIES,
  CAPTURE_EXCLUSION_CATEGORIES,
  CAPTURE_VERIFIED_SUCCESS,
  autoCaptureDecision,
} from '../src/experience/capture.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
test.after(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function appOn(dir) {
  return createApp({ dataDir: dir });
}

test('the note store appends revisions and keeps the earlier text readable', async () => {
  const dir = tempDir();
  const notes = new NoteStore(path.join(dir, 'notes.jsonl'));

  const { record } = await notes.add({ title: 'Release', body: 'first draft', tags: ['release'], origin: 'user' });
  const revised = await notes.update({ target: record.id, body: 'second draft', origin: 'user' });

  assert.equal(revised.revision, 2);
  assert.deepEqual(revised.record.supersedes, [record.id]);
  assert.equal(revised.record.title, 'Release', 'unspecified fields are carried over');
  assert.deepEqual(revised.record.tags, ['release'], 'tags are carried over too');

  const current = await notes.show(record.id);
  assert.equal(current.id, revised.record.id, 'the original id resolves to the current revision');
  assert.equal(current.body, 'second draft');

  const history = await notes.history(record.id);
  assert.deepEqual(history.versions.map((v) => v.revision), [1, 2]);
  assert.equal(history.current, revised.record.id);
  assert.equal(history.conflict, false);

  const listed = await notes.list();
  assert.equal(listed.length, 1, 'one logical note, not two revisions');
  assert.equal(listed[0].id, revised.record.id);
});

test('a revision written against a stale head is refused as a conflicting revision', async () => {
  const dir = tempDir();
  const notes = new NoteStore(path.join(dir, 'notes.jsonl'));
  const { record } = await notes.add({ title: 'Plan', body: 'a', origin: 'user' });
  await notes.update({ target: record.id, body: 'b', origin: 'user' });

  await assert.rejects(
    () => notes.update({ target: record.id, body: 'c', origin: 'user' }),
    (err) => err.code === 'REVISION_CONFLICT' && /revised/.test(err.message),
  );
  const history = await notes.history(record.id);
  assert.equal(history.versions.length, 2, 'the refused write appended nothing');
});

test('a private note keeps its body out of lists, searches, and an unqualified show', async () => {
  const dir = tempDir();
  const notes = new NoteStore(path.join(dir, 'notes.jsonl'));
  const { record } = await notes.add({
    title: 'Server access',
    body: 'the vault token lives in the safe',
    sensitivity: 'private',
    origin: 'user',
  });

  const listed = await notes.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Server access', 'the title stays visible so the note is findable');
  assert.equal(listed[0].body, null);
  assert.equal(listed[0].bodyHidden, true);

  const hidden = await notes.show(record.id);
  assert.equal(hidden.body, null);
  assert.equal(hidden.bodyHidden, true);

  const shown = await notes.show(record.id, { includePrivate: true });
  assert.equal(shown.body, 'the vault token lives in the safe');

  const excluded = await notes.search('vault');
  assert.equal(excluded.results.length, 0);
  assert.equal(excluded.excludedPrivate, 1, 'the refusal says a private match existed');

  const included = await notes.search('vault', { includePrivate: true });
  assert.equal(included.results.length, 1);
  assert.equal(included.results[0].body, null, 'search still does not hand out the body');
});

test('the store refuses model-origin writes and credential-like content', async () => {
  const dir = tempDir();
  const notes = new NoteStore(path.join(dir, 'notes.jsonl'));

  await assert.rejects(
    () => notes.add({ title: 'Model note', body: 'written by a model', origin: 'model' }),
    /model output cannot write notes/,
  );
  await assert.rejects(
    () => notes.add({ title: 'Keys', body: 'password: hunter2', origin: 'user' }),
    (err) => err.code === 'SECRET_REFUSED',
  );
  assert.equal((await notes.list()).length, 0);
});

test('note.add and note.update verify independently and keep the body out of the audit', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const body = 'the release checklist must list export and restore';
  const edited = 'the release checklist must list export, restore, and a clean-start pass';

  const added = await app.controller.noteAdd({ title: 'Release checklist', body, tags: ['release'] });
  assert.equal(added.status, Outcome.SUCCESS_VERIFIED, added.display);
  const id = added.operation.steps[0].result.data.id;
  assert.equal(added.operation.steps[0].result.data.body, undefined);

  const revised = await app.controller.noteUpdate({ target: id, body: edited });
  assert.equal(revised.status, Outcome.SUCCESS_VERIFIED, revised.display);
  assert.equal(revised.operation.steps[0].result.data.previousId, id);

  const shown = await app.controller.noteShow({ target: id, includePrivate: true });
  assert.equal(shown.status, Outcome.SUCCESS_VERIFIED, shown.display);
  assert.match(shown.display, /export, restore, and a clean-start pass/);
  assert.equal(shown.operation.steps[0].result.data.note.body, null);

  const audit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
  assert.ok(!audit.includes(body), 'the first body is not duplicated into the audit log');
  assert.ok(!audit.includes(edited), 'the revised body is not duplicated into the audit log');
  assert.ok(audit.includes('note add'), 'the operation itself is still recorded');
});

test('note search and history report only what the store holds', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const a = await app.controller.noteAdd({ title: 'Backup plan', body: 'export nightly', tags: ['ops'] });
  const id = a.operation.steps[0].result.data.id;
  await app.controller.noteAdd({ title: 'Lunch', body: 'soup' });

  const found = await app.controller.noteSearch({ query: 'export' });
  assert.equal(found.status, Outcome.SUCCESS_VERIFIED, found.display);
  assert.equal(found.operation.steps[0].result.data.results.length, 1);
  assert.match(found.display, /Backup plan/);

  await app.controller.noteUpdate({ target: id, body: 'export nightly and verify the archive' });
  const history = await app.controller.noteHistory({ target: id });
  assert.equal(history.status, Outcome.SUCCESS_VERIFIED, history.display);
  assert.equal(history.operation.steps[0].result.data.history.versions.length, 2);
  assert.match(history.display, /Revisions of/);
});

test('the digest-to-note workflow cites the records it used and excludes private memory', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const publicMemory = await app.memory.add({ content: 'the deploy job runs on Fridays' });
  const privateMemory = await app.memory.add({ content: 'the deploy vault combination is 12-34', sensitivity: 'private' });
  const claim = await app.controller.knowledgeAdd({ subject: 'deploy cadence', relationship: 'is', object: 'weekly' });

  const res = await app.controller.noteFromDigest({ query: 'deploy', title: 'Deploy reading' });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  const data = res.operation.steps[0].result.data;
  assert.equal(data.sensitivity, 'normal');
  assert.equal(data.privateMemoryExcluded, true);
  assert.ok(data.sources >= 2, 'both stores contributed a cited record');

  const note = await app.notes.show(data.id, { includePrivate: true });
  assert.equal(note.title, 'Deploy reading');
  const refs = note.sources.map((s) => `${s.kind}:${s.ref}`);
  assert.ok(refs.includes(`knowledge:${claim.operation.steps[0].result.data.id}`), refs.join(', '));
  assert.ok(refs.includes(`memory:${publicMemory.id}`), refs.join(', '));
  assert.ok(!refs.includes(`memory:${privateMemory.id}`), 'private memory is never a digest source');
  assert.ok(!note.body.includes('12-34'), 'private memory text is not copied into the note');
});

test('the natural-language routes reach the note actions without capturing ordinary prose', () => {
  assert.equal(route('save a note titled Release: ship it').action, 'note.add');
  assert.equal(route('save a note titled Release: ship it').input.title, 'Release');
  assert.equal(route('save a private note titled Keys: abc').input.sensitivity, 'private');
  assert.equal(route('save a note from the digest about backups').action, 'note.from_digest');
  assert.equal(route('save a note from the digest about backups as Backup reading').input.title, 'Backup reading');
  assert.equal(route('list my notes').action, 'note.list');
  assert.equal(route('show note 1234abcd').action, 'note.show');
  assert.equal(route('show private note 1234abcd').input.includePrivate, true);
  assert.equal(route('search my notes for backup').action, 'note.search');
  assert.equal(route('note history 1234abcd').action, 'note.history');
  assert.equal(route('note save-digest deploy').action, 'note.from_digest');
  assert.equal(route('note that the meeting moved').kind, 'model', 'ordinary prose is not a note write');
});

test('a private note write combined with another request is refused before anything runs', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const secret = 'ZEBRA-SECRET-1947';
  const res = await app.controller.handle(`save a private note titled Keys: ${secret}; list my notes`);
  assert.equal(res.status, Outcome.INPUT_REJECTED);
  assert.equal(res.operation.errors[0].code, 'PRIVATE_WRITE_COMBINED');
  assert.match(res.display, /private memory or note write/);
  assert.equal((await app.notes.list()).length, 0, 'nothing was stored');
  assert.ok(!fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').includes(secret));
});

test('a note write through the conversation path is audited without its body', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const res = await app.controller.handle('save a note titled Ops: rotate the logs before the audit run');
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
  const notes = await app.notes.list();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Ops');
  const audit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
  assert.ok(!audit.includes('rotate the logs before the audit run'));
});

test('note actions are registered, user-only, unplannable and outside automatic capture', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  const names = app.registry.list().map((d) => d.name).filter((n) => n.startsWith('note.'));
  assert.deepEqual(names.sort(), [
    'note.add', 'note.from_digest', 'note.history', 'note.list',
    'note.search', 'note.show', 'note.update',
  ]);
  for (const name of names) {
    const def = app.registry.get(name);
    assert.deepEqual(def.origins, ['user'], name);
    assert.equal(def.plannable, false, name);
    assert.ok(Object.prototype.hasOwnProperty.call(CAPTURE_EXCLUDED_CAPABILITIES, name), `${name} is classified`);
    const category = CAPTURE_EXCLUDED_CAPABILITIES[name];
    assert.ok(Object.prototype.hasOwnProperty.call(CAPTURE_EXCLUSION_CATEGORIES, category), `${name} category exists`);
    assert.ok(!AUTO_CAPTURE_CAPABILITIES.includes(name), `${name} is not auto-captured`);
  }
  const denied = await app.controller.runAction('note.add', { title: 'Model', body: 'written by a model' }, 'model', 'note-model-op');
  assert.equal(denied.outcome, Outcome.ACTION_DENIED);
  assert.equal(denied.authorization.reason, 'ORIGIN_NOT_PERMITTED');

  const op = {
    capability: 'note.add',
    origin: 'user',
    status: Outcome.SUCCESS_VERIFIED,
    id: 'op-note-1',
    steps: [{
      outcome: Outcome.SUCCESS_VERIFIED,
      authorization: { decision: 'allow' },
      execution: { status: 'ok' },
      verification: { outcome: Outcome.SUCCESS_VERIFIED },
      summary: 'stored note',
    }],
    errors: [],
  };
  const decision = autoCaptureDecision(op, { mode: CAPTURE_VERIFIED_SUCCESS, recorded: true });
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /outside the automatic capture subset/);
});

test('a damaged note log refuses an incomplete write instead of appending to it', async () => {
  const dir = tempDir();
  const app = appOn(dir);
  await app.controller.noteAdd({ title: 'Intact', body: 'this line is valid' });
  fs.appendFileSync(path.join(dir, 'notes.jsonl'), '{not json}\n');

  const res = await app.controller.noteAdd({ title: 'After damage', body: 'must not be stored' });
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /corrupt line/);
  const lines = fs.readFileSync(path.join(dir, 'notes.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'the damaged line is kept and no new record was appended');
});

test('the note CLI writes, lists, shows and saves a digest note', async () => {
  const dir = tempDir();
  const env = cleanEnv({ APEX_DATA_DIR: dir });

  const added = await runCli(['note', 'add', '--title', 'Release', '--body', 'ship the offline build', '--tag', 'release'], env);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Note .* stored/);

  const listed = await runCli(['note', 'list'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /Release/);

  const id = /Note ([0-9a-f]{8})/.exec(added.stdout)[1];
  const shown = await runCli(['note', 'show', id], env);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /ship the offline build/);

  const seed = appOn(dir);
  await seed.controller.knowledgeAdd({ subject: 'release', relationship: 'includes', object: 'export' });
  const saved = await runCli(['note', 'save-digest', 'release', '--title', 'Release reading'], env);
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /stored from the digest/);

  const historyId = /Note ([0-9a-f]{8})/.exec(saved.stdout)[1];
  const history = await runCli(['note', 'history', historyId], env);
  assert.equal(history.code, 0, history.stderr);
  assert.match(history.stdout, /Revisions of/);
});
