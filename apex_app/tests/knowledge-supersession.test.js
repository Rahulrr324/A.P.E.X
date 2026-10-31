// Implementation Batch P: explicit user-approved supersession of a conflicting
// knowledge claim. The readers already supported superseded records, but no write path
// could produce one, so a detected conflict could never be resolved. These tests pin the
// store contract, the verification, the CLI surface, and the authorization boundary.
//
// Live model inference is not involved. The tests use the real stores and the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, sha256Hex } from '../src/knowledge/knowledge-store.js';
import { shortId } from '../src/util.js';

function tempDir() {
  return makeTempDataDir();
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}
function knowledgeLines(dir) {
  return fs.readFileSync(path.join(dir, 'knowledge.jsonl'), 'utf8').trim().split('\n');
}
function operations(dir) {
  return fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}
function seededRecord({ id, subject, relationship, object }) {
  return {
    schema: 1,
    id,
    subject,
    relationship,
    object,
    evidence: null,
    tripleHash: sha256Hex(`${subject}\x00${relationship}\x00${object}`),
    status: 'supported',
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
  };
}
function seed(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

test('knowledge supersession - the store retires a conflicting claim without deleting it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  const first = await store.add({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Coal',
    evidence: 'maintenance log, 2025',
    origin: 'user',
    provenance: { operationId: 'op-old' },
  });
  assert.equal(first.record.status, 'supported');

  const second = await store.add({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Electric',
    evidence: 'service record, 2026',
    origin: 'user',
    provenance: { operationId: 'op-new' },
    supersedes: [shortId(first.record.id)],
  });

  assert.equal(second.record.status, 'supported', 'the only conflict was superseded');
  assert.deepEqual(second.conflictingIds, []);
  assert.deepEqual(second.supersededIds, [first.record.id]);
  assert.deepEqual(second.record.supersededBy, [first.record.id]);
  assert.equal(second.record.provenance.origin, 'user_supplied');
  assert.equal(second.record.provenance.updateMode, 'user_confirmed');
  assert.equal(second.record.provenance.operationId, 'op-new');

  const old = (await store.findByPrefix(first.record.id))[0];
  assert.equal(old.status, 'superseded');
  assert.deepEqual(old.supersededBy, [second.record.id]);
  assert.equal(old.object, 'Coal', 'the historical claim is preserved, not rewritten');
  assert.ok(await store.get(first.record.id), 'the earlier record remains in the log');
  assert.equal(knowledgeLines(dir).length, 2, 'supersession appends; it does not rewrite');

  const fresh = (await store.findByPrefix(second.record.id))[0];
  assert.equal(fresh.status, 'supported');
  assert.deepEqual(fresh.conflictsWith, []);
});

test('knowledge supersession - only a live conflicting claim may be retired', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  const unrelated = (await store.add({ subject: 'Car', relationship: 'color', object: 'Red', origin: 'user' })).record;
  const first = (await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Coal', origin: 'user' })).record;

  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: [unrelated.id],
    }),
    /different subject or relationship/,
  );
  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Coal', origin: 'user', supersedes: [first.id],
    }),
    /states the same object/,
  );
  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: ['does-not-exist'],
    }),
    /not found/,
  );
  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: first.id,
    }),
    /must be a list/,
  );
  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'model', supersedes: [first.id],
    }),
    (err) => err.code === 'WRITE_REQUIRES_USER_ORIGIN',
  );

  assert.equal(knowledgeLines(dir).length, 2, 'every refused write left the log unchanged');

  const replacement = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: [first.id],
  })).record;
  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Hydrogen', origin: 'user', supersedes: [first.id],
    }),
    /already superseded/,
  );
  assert.ok(replacement.id);
});

test('knowledge supersession - an ambiguous id prefix is refused', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const a = seededRecord({
    id: 'aaaaaaaa-1111-4111-8111-111111111111', subject: 'Engine', relationship: 'fuel', object: 'Coal',
  });
  const b = seededRecord({
    id: 'aaaaaaaa-2222-4222-8222-222222222222', subject: 'Engine', relationship: 'fuel', object: 'Diesel',
  });
  seed(dir, [a, b]);
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: ['aaaaaaaa'],
    }),
    /ambiguous/,
  );
  assert.equal(knowledgeLines(dir).length, 2);
});

test('knowledge supersession - remaining conflicts stay visible after a partial resolution', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  const coal = (await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Coal', origin: 'user' })).record;
  const diesel = (await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Diesel', origin: 'user' })).record;

  const electric = await store.add({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Electric',
    origin: 'user',
    supersedes: [coal.id],
  });

  assert.equal(electric.record.status, 'conflicting');
  assert.deepEqual(electric.conflictingIds, [diesel.id], 'the unresolved claim is still named');
  assert.equal((await store.findByPrefix(coal.id))[0].status, 'superseded');

  const live = await store.search('Engine fuel');
  const liveIds = live.map((hit) => hit.record.id);
  assert.equal(liveIds.includes(coal.id), false, 'a superseded claim is out of retrieval');
  assert.equal(liveIds.includes(diesel.id), true);
  assert.equal(liveIds.includes(electric.record.id), true);
});

test('knowledge supersession - a corrupt log refuses the write and is not rewritten', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(file);
  const target = (await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Coal', origin: 'user' })).record;
  const before = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, 'not-json\n', 'utf8');
  const damaged = fs.readFileSync(file, 'utf8');

  await assert.rejects(
    () => store.add({
      subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user', supersedes: [target.id],
    }),
    /corrupt line/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged log is left as found');
  assert.notEqual(before, damaged, 'the fixture actually appended damage');
});

test('knowledge supersession - CLI writes, verifies, and exposes the historical record', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));

  const first = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
  ], envFor(dir));
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const oldId = JSON.parse(knowledgeLines(dir)[0]).id;

  const second = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Electric',
    '--supersedes', shortId(oldId),
  ], envFor(dir));
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /supersedes/, second.stdout);

  const newId = JSON.parse(knowledgeLines(dir)[1]).id;
  const shownOld = await runCli(['knowledge', 'show', shortId(oldId)], envFor(dir));
  assert.equal(shownOld.code, 0, shownOld.stdout + shownOld.stderr);
  assert.match(shownOld.stdout, /Status:\s+superseded/, shownOld.stdout);
  assert.match(shownOld.stdout, new RegExp(`SUPERSEDED BY:\\s+${shortId(newId)}`), shownOld.stdout);

  const listed = await runCli(['knowledge', 'list'], envFor(dir));
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /status: superseded/, listed.stdout);

  const op = operations(dir).filter((record) => record.capability === 'knowledge.add').at(-1);
  assert.equal(op.capability, 'knowledge.add');
  assert.equal(op.status, 'success_verified');
  assert.match(op.request, /supersedes 1 record\(s\)/);
  assert.deepEqual(op.steps[0].result.data.supersededIds, [oldId]);
});

test('knowledge supersession - a missing target is refused by the CLI without a write', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const first = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
  ], envFor(dir));
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const before = knowledgeLines(dir).length;

  const failed = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Electric',
    '--supersedes', 'missing123',
  ], envFor(dir));
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /not found/, failed.stdout);
  assert.equal(knowledgeLines(dir).length, before, 'nothing was appended');
});

test('knowledge supersession - a credential-like target id is omitted from the audit record', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const secret = 'sk-1234567890abcdef1234567890abcdef';
  const first = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
  ], envFor(dir));
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const before = knowledgeLines(dir).length;

  const failed = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Electric',
    '--supersedes', secret,
  ], envFor(dir));
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.equal(knowledgeLines(dir).length, before);

  const raw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
  assert.equal(raw.includes(secret), false, 'the credential-like value is not audited');
  const op = operations(dir).at(-1);
  assert.deepEqual(op.steps[0].input.supersedes, ['[omitted: contained a password, key, or token]']);
});

test('knowledge supersession - model origin cannot reach the write', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = createApp({ dataDir: dir });

  const auth = app.registry.authorize('knowledge.add', 'model');
  assert.equal(auth.decision, 'deny');
  assert.equal(auth.reason, 'ORIGIN_NOT_PERMITTED');

  const step = await app.controller.runAction('knowledge.add', {
    subject: 'Engine', relationship: 'fuel', object: 'Electric', supersedes: ['whatever'],
  }, 'model', 'op-model');
  assert.equal(step.outcome, 'action_denied');
  assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl')), false, 'no knowledge write occurred');
});
