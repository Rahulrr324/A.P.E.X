// Implementation Batch Q: knowledge lifecycle and historical integrity.
//
// Retraction is an append-only lifecycle event: an authorized user can mark an
// existing claim as no longer active, but the claim itself is never rewritten,
// moved, or deleted. These tests pin the store contract, verification, retrieval
// exclusion, read-only history, failure reporting, and the authorization boundary.
//
// Live model inference is not involved. The tests use the real stores and the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, MAX_HISTORY_CHAIN, sha256Hex } from '../src/knowledge/knowledge-store.js';
import { Outcome } from '../src/outcomes.js';
import { ModelGateway } from '../src/model/gateway.js';
import { StoreError } from '../src/errors.js';
import { shortId } from '../src/util.js';

const AUDIT_OMITTED = '[omitted: contained a password, key, or token]';

const CLAIM_IDS = {
  a: 'aaaaaaaa-1111-4111-8111-111111111111',
  b: 'bbbbbbbb-2222-4222-8222-222222222222',
  c: 'cccccccc-3333-4333-8333-333333333333',
  d: 'dddddddd-4444-4444-8444-444444444444',
  e: 'eeeeeeee-5555-4555-8555-555555555555',
};

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

function seededRecord({
  id,
  subject,
  relationship,
  object,
  status = 'supported',
  evidence = null,
  createdAt = '2026-01-01T00:00:00.000Z',
  supersededBy = null,
}) {
  return {
    schema: 1,
    id,
    subject,
    relationship,
    object,
    evidence,
    tripleHash: sha256Hex(`${subject}\x00${relationship}\x00${object}`),
    status,
    createdAt,
    provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
    ...(supersededBy ? { supersededBy } : {}),
  };
}

function retractionEvent({ id = CLAIM_IDS.d, targetId, reason = null, createdAt = '2026-01-02T00:00:00.000Z' }) {
  return {
    schema: 1,
    kind: 'retraction',
    id,
    targetId,
    ...(reason ? { reason } : {}),
    createdAt,
    provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
  };
}

function seed(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'knowledge.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
}

// TEST DOUBLE: a model that returns fixed text and records the request. It proves how
// APEX handles a reply, not what a real model would say.
function scriptedGateway(text) {
  const captured = {};
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async (req) => {
      captured.request = req;
      return {
        ok: true,
        backend: 'test-double',
        provider: 'test-double',
        model: 'test-double',
        text,
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), captured };
}

// TEST DOUBLE: a model that answers but counts how often it was called. Read-only
// lifecycle inspection must never increment this count.
function countingGateway() {
  const state = { calls: 0 };
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => {
      state.calls += 1;
      return {
        ok: true,
        backend: 'test-double',
        provider: 'test-double',
        model: 'test-double',
        text: '{}',
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), calls: state };
}

test('knowledge lifecycle - retraction appends an event and preserves the original claim', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = createApp({ dataDir: dir });

  const added = await app.controller.knowledgeAdd({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Coal',
    evidence: 'maintenance log, 2025',
  });
  assert.equal(added.status, Outcome.SUCCESS_VERIFIED);
  const claimId = added.operation.steps[0].result.data.id;

  const retracted = await app.controller.knowledgeRetract({
    target: shortId(claimId),
    reason: '  replaced by the 2026 electric service record  ',
  });
  assert.equal(retracted.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(retracted.recorded, true);
  assert.match(retracted.display, /original claim/);

  const lines = knowledgeLines(dir);
  assert.equal(lines.length, 2, 'retraction appends; the claim line is not rewritten');
  const original = JSON.parse(lines[0]);
  const event = JSON.parse(lines[1]);
  assert.equal(event.kind, 'retraction');
  assert.equal(event.targetId, claimId);
  assert.equal(event.reason, 'replaced by the 2026 electric service record');
  assert.equal(event.provenance.origin, 'user_supplied');
  assert.equal(event.provenance.updateMode, 'user_confirmed');
  assert.equal(event.provenance.operationId, retracted.operation.id);

  const raw = await app.knowledge.get(claimId);
  assert.equal(raw.object, 'Coal');
  assert.equal(raw.evidence, 'maintenance log, 2025');
  assert.equal(raw.createdAt, original.createdAt);

  const [read] = await app.knowledge.findByPrefix(claimId);
  assert.equal(read.active, false);
  assert.equal(read.status, 'retracted');
  assert.equal(read.lifecycleState, 'retracted');
  assert.equal(read.retraction.id, event.id);
  assert.equal(read.retraction.reason, event.reason);
  assert.deepEqual(read.replaces, []);

  const step = retracted.operation.steps[0];
  assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
  assert.equal(step.result.data.targetId, claimId);
  assert.equal(step.result.data.retractionId, event.id);
});

test('knowledge lifecycle - retraction refuses targets it cannot retire without writing', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  const old = (await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Coal', origin: 'user' })).record;
  const current = (await store.add({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Electric',
    origin: 'user',
    supersedes: [old.id],
  })).record;
  const before = knowledgeLines(dir).length;

  await assert.rejects(() => store.retract({ target: 'missing-id', origin: 'user' }), /not found/);
  await assert.rejects(() => store.retract({ target: '', origin: 'user' }), /empty/);
  await assert.rejects(() => store.retract({ target: 'bad\u0000id', origin: 'user' }), /control characters/);
  await assert.rejects(() => store.retract({ target: 'x'.repeat(65), origin: 'user' }), /longer than 64/);
  await assert.rejects(() => store.retract({ target: old.id, origin: 'user' }), /already superseded/);
  await assert.rejects(
    () => store.retract({ target: current.id, origin: 'model' }),
    (err) => err.code === 'WRITE_REQUIRES_USER_ORIGIN',
  );
  await assert.rejects(
    () => store.retract({ target: current.id, origin: 'user', provenance: { origin: 'user_supplied' } }),
    /may not be supplied directly/,
  );
  await assert.rejects(
    () => store.retract({ target: current.id, origin: 'user', reason: 'x'.repeat(501) }),
    /exceeds 500 characters/,
  );
  await assert.rejects(
    () => store.retract({ target: current.id, origin: 'user', reason: 'bad\u0000reason' }),
    /control characters/,
  );
  assert.equal(knowledgeLines(dir).length, before, 'refused retractions wrote nothing');

  const done = await store.retract({ target: current.id, origin: 'user' });
  assert.equal(done.event.targetId, current.id);
  await assert.rejects(() => store.retract({ target: current.id, origin: 'user' }), /already retracted/);
  assert.equal(knowledgeLines(dir).length, before + 1, 'the duplicate retraction wrote nothing');

  await assert.rejects(
    () => store.add({
      subject: 'Engine',
      relationship: 'fuel',
      object: 'Hydrogen',
      origin: 'user',
      supersedes: [current.id],
    }),
    /retracted; a historical record cannot be replaced/,
  );
  assert.equal(knowledgeLines(dir).length, before + 1, 'a retracted record cannot be superseded');
});

test('knowledge lifecycle - an ambiguous retraction target is refused', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, [
    seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: 'aaaaaaaa-2222-4222-8222-222222222222', subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
  ]);
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  await assert.rejects(() => store.retract({ target: 'aaaaaaaa', origin: 'user' }), /ambiguous/);
  assert.equal(knowledgeLines(dir).length, 2);
});

test('knowledge lifecycle - model origin can never retract and the planner never offers it', async () => {
  const dir = tempDir();
  try {
    const plan = JSON.stringify({
      steps: [{
        id: 's1',
        description: 'retire a claim',
        action: 'knowledge.retract',
        input: { target: 'aaaaaaaa' },
        depends_on: [],
      }],
    });
    const { gateway, captured } = scriptedGateway(plan);
    const app = createApp({ dataDir: dir, gateway });

    assert.equal(app.registry.get('knowledge.retract').plannable, false);

    const auth = app.registry.authorize('knowledge.retract', 'model');
    assert.equal(auth.decision, 'deny');
    assert.equal(auth.reason, 'ORIGIN_NOT_PERMITTED');

    const denied = await app.controller.runAction('knowledge.retract', { target: 'aaaaaaaa' }, 'model', 'op-model');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl')), false, 'no retraction write occurred');

    const res = await app.controller.planTask('make the system remember who to trust');
    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /cannot be part of a plan/);
    assert.equal((await app.taskStore.list()).length, 0);
    assert.ok(captured.request);
    assert.ok(!captured.request.system.includes('knowledge.retract'), 'the planner never invites the model to retract');
  } finally {
    cleanup(dir);
  }
});

test('knowledge lifecycle - secret-like targets and reasons are refused and never audited', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir);
  const secret = 'sk-1234567890abcdef1234567890abcdef';

  const added = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
  ], env);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const claimId = JSON.parse(knowledgeLines(dir)[0]).id;
  const before = knowledgeLines(dir).length;

  const badTarget = await runCli(['knowledge', 'retract', secret], env);
  assert.equal(badTarget.code, 1, badTarget.stdout + badTarget.stderr);
  assert.match(badTarget.stdout, /password, key, or token/, badTarget.stdout);
  assert.equal(badTarget.stdout.includes(secret), false, 'the refused target is not echoed to the terminal');
  assert.equal(knowledgeLines(dir).length, before, 'the refused target wrote nothing');

  const badReason = await runCli([
    'knowledge', 'retract', shortId(claimId), '--reason', secret,
  ], env);
  assert.equal(badReason.code, 1, badReason.stdout + badReason.stderr);
  assert.match(badReason.stdout, /password, key, or token/, badReason.stdout);
  assert.equal(badReason.stdout.includes(secret), false, 'the refused reason is not echoed to the terminal');
  assert.equal(knowledgeLines(dir).length, before, 'the refused reason wrote nothing');

  const rawAudit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
  assert.equal(rawAudit.includes(secret), false, 'the secret-like value never reaches the audit log');
  const retractOps = operations(dir).filter((op) => op.capability === 'knowledge.retract');
  assert.equal(retractOps.length, 2);
  assert.equal(retractOps[0].status, Outcome.INPUT_REJECTED);
  assert.equal(retractOps[0].steps[0].input.target, AUDIT_OMITTED);
  assert.equal(retractOps[1].status, Outcome.INPUT_REJECTED);
  assert.equal(retractOps[1].steps[0].input.reason, AUDIT_OMITTED);
});

test('knowledge lifecycle - persistence failures are never reported as success', async (t) => {
  await t.test('an audit append failure is reported, never as verified success', async () => {
    const dir = tempDir();
    try {
      const app = createApp({ dataDir: dir });
      const added = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const claimId = added.operation.steps[0].result.data.id;

      app.operations.append = async () => { throw new Error('injected audit failure'); };
      const res = await app.controller.knowledgeRetract({ target: claimId, reason: 'outdated' });

      assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
      assert.equal(res.recorded, false);
      assert.match(res.output, /could not be written/);
      assert.doesNotMatch(String(res.output), /verified/);

      const [rec] = await app.knowledge.findByPrefix(claimId);
      assert.equal(rec.status, 'retracted', 'the retraction itself was appended');
      assert.equal(knowledgeLines(dir).length, 2);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a store append failure leaves the log unchanged', async () => {
    const dir = tempDir();
    try {
      const app = createApp({ dataDir: dir });
      const added = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const claimId = added.operation.steps[0].result.data.id;
      const file = path.join(dir, 'knowledge.jsonl');
      const before = fs.readFileSync(file, 'utf8');

      app.knowledge.log.append = async () => { throw new StoreError('simulated append failure'); };
      const res = await app.controller.knowledgeRetract({ target: claimId });

      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.equal(res.recorded, true);
      assert.match(res.output, /simulated append failure/);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was appended');
    } finally {
      cleanup(dir);
    }
  });
});

test('knowledge lifecycle - corrupt lifecycle data fails closed', async (t) => {
  await t.test('a damaged line refuses every read and write', async () => {
    const dir = tempDir();
    try {
      const app = createApp({ dataDir: dir });
      const added = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const claimId = added.operation.steps[0].result.data.id;
      await app.knowledge.retract({ target: claimId, origin: 'user' });

      const file = path.join(dir, 'knowledge.jsonl');
      fs.appendFileSync(file, 'BROKEN LINE\n', 'utf8');
      const damaged = fs.readFileSync(file, 'utf8');
      const isStoreError = (err) => err.code === 'STORE_UNAVAILABLE';

      await assert.rejects(() => app.knowledge.list(), isStoreError);
      await assert.rejects(() => app.knowledge.search('engine'), isStoreError);
      await assert.rejects(() => app.knowledge.findByPrefix(claimId), isStoreError);
      await assert.rejects(() => app.knowledge.history(claimId), isStoreError);
      await assert.rejects(() => app.knowledge.retract({ target: claimId, origin: 'user' }), isStoreError);

      const status = await app.knowledge.status();
      assert.equal(status.records, 1);
      assert.equal(status.retractions, 1);
      assert.equal(status.corrupt, 1);

      const res = await app.controller.knowledgeRetract({ target: claimId });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.equal(res.recorded, true);
      await assert.rejects(() => app.controller.knowledgeHistory(claimId), isStoreError);
      assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'no refused operation rewrote the damaged log');
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a structurally invalid retraction event is corrupt, not active knowledge', async () => {
    const dir = tempDir();
    try {
      const claim = seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const badEvent = {
        ...retractionEvent({ targetId: claim.id }),
        provenance: { origin: 'model_proposed', updateMode: 'user_confirmed' },
      };
      seed(dir, [claim, badEvent]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      await assert.rejects(() => store.list(), (err) => err.code === 'STORE_UNAVAILABLE');
      const status = await store.status();
      assert.equal(status.records, 1);
      assert.equal(status.retractions, 0, 'the invalid event is not counted as lifecycle evidence');
      assert.equal(status.corrupt, 1);
    } finally {
      cleanup(dir);
    }
  });
});

test('knowledge lifecycle - retraction removes a claim from retrieval and live conflicts', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  const coal = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Coal', evidence: 'maintenance log 2025', origin: 'user',
  })).record;
  const diesel = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Diesel', origin: 'user',
  })).record;
  const electric = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Electric', origin: 'user',
  })).record;

  const [conflicted] = await store.findByPrefix(electric.id);
  assert.deepEqual(new Set(conflicted.conflictsWith), new Set([coal.id, diesel.id]));
  assert.equal(conflicted.status, 'conflicting');
  assert.ok((await store.search('maintenance')).some((hit) => hit.record.id === coal.id));

  await store.retract({ target: coal.id, origin: 'user' });
  assert.equal((await store.search('maintenance')).length, 0, 'retracted evidence is out of retrieval');
  assert.equal((await store.search('coal')).length, 0, 'the retracted claim is out of retrieval');

  const [electricAfter] = await store.findByPrefix(electric.id);
  assert.deepEqual(electricAfter.conflictsWith, [diesel.id], 'an unrelated live conflict remains visible');
  assert.equal(electricAfter.status, 'conflicting');

  const listed = await store.list({ limit: 10 });
  assert.equal(listed.find((r) => r.id === coal.id).status, 'retracted', 'listed history still shows the retired claim');
  assert.equal(listed.find((r) => r.id === diesel.id).status, 'conflicting');

  await store.retract({ target: diesel.id, origin: 'user' });
  const [electricLast] = await store.findByPrefix(electric.id);
  assert.deepEqual(electricLast.conflictsWith, []);
  assert.equal(electricLast.status, 'supported', 'the stored snapshot is normalized when its conflicts are retired');

  const again = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Coal', evidence: '2026 rebuild', origin: 'user',
  })).record;
  const [oldCoal] = await store.findByPrefix(coal.id);
  assert.equal(oldCoal.status, 'retracted', 'the retired record stays retired');
  const [freshCoal] = await store.findByPrefix(again.id);
  assert.equal(freshCoal.active, true);
  assert.deepEqual(freshCoal.conflictsWith, [electric.id], 'a fresh assertion is a new claim, not a revival');
});

test('knowledge lifecycle - history reports direct and chained supersession', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  let tick = 0;
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'), {
    now: () => new Date(Date.parse('2026-02-01T00:00:00.000Z') + tick++ * 1000),
  });

  const coal = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Coal', evidence: 'log 2024', origin: 'user',
  })).record;
  const diesel = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Diesel', evidence: 'log 2025', origin: 'user',
    supersedes: [coal.id],
  })).record;
  const electric = (await store.add({
    subject: 'Engine', relationship: 'fuel', object: 'Electric', evidence: 'log 2026', origin: 'user',
    supersedes: [diesel.id],
  })).record;

  const first = await store.history(coal.id);
  assert.equal(first.state, 'superseded');
  assert.equal(first.record.evidence, 'log 2024', 'history reads the preserved claim');
  assert.equal(first.retraction, null);
  assert.deepEqual(first.replaces, []);
  assert.deepEqual(first.replacedBy.map((link) => link.id), [diesel.id]);
  assert.deepEqual(first.chain.map((entry) => entry.id), [coal.id, diesel.id, electric.id]);
  assert.deepEqual(first.chain.map((entry) => entry.state), ['superseded', 'superseded', 'supported']);
  assert.equal(first.chainTruncated, false);
  assert.equal(first.complete, true);
  assert.deepEqual(first.problems, []);

  const middle = await store.history(diesel.id);
  assert.equal(middle.state, 'superseded');
  assert.deepEqual(middle.replaces.map((link) => link.id), [coal.id]);
  assert.deepEqual(middle.replacedBy.map((link) => link.id), [electric.id]);
  assert.equal(middle.complete, true);

  const last = await store.history(electric.id);
  assert.equal(last.state, 'supported');
  assert.deepEqual(last.replaces.map((link) => link.id), [diesel.id]);
  assert.deepEqual(last.replacedBy, []);
  assert.equal(last.complete, true);
});

test('knowledge lifecycle - history reports incomplete and ambiguous evidence without guessing', async (t) => {
  await t.test('a missing supersession link is reported, not inferred', async () => {
    const dir = tempDir();
    try {
      const claim = seededRecord({
        id: CLAIM_IDS.a,
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Coal',
        supersededBy: [CLAIM_IDS.c],
      });
      seed(dir, [claim]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      const view = await store.history(claim.id);
      // The record itself is not retired by a predecessor that does not exist; the
      // missing link is reported instead of making either state up.
      assert.equal(view.state, 'supported');
      assert.equal(view.record.active, true);
      assert.deepEqual(view.replaces, []);
      assert.deepEqual(view.replacedBy, []);
      assert.equal(view.complete, false);
      assert.match(view.problems.join('; '), /link target cccccccc is not in the store/);
      assert.equal(view.chain.length, 1, 'only the record itself is established');
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a legacy superseded status without a successor is reported', async () => {
    const dir = tempDir();
    try {
      const claim = seededRecord({
        id: CLAIM_IDS.a,
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Coal',
        status: 'superseded',
      });
      seed(dir, [claim]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      const view = await store.history(claim.id);
      assert.equal(view.state, 'superseded');
      assert.equal(view.complete, false);
      assert.match(view.problems.join('; '), /stored status is superseded but no successor record names it/);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('more than one successor is reported, not chosen', async () => {
    const dir = tempDir();
    try {
      const old = seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const one = seededRecord({
        id: CLAIM_IDS.b,
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Diesel',
        createdAt: '2026-01-02T00:00:00.000Z',
        supersededBy: [old.id],
      });
      const two = seededRecord({
        id: CLAIM_IDS.c,
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Electric',
        createdAt: '2026-01-03T00:00:00.000Z',
        supersededBy: [old.id],
      });
      seed(dir, [old, one, two]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      const view = await store.history(old.id);
      assert.equal(view.state, 'superseded');
      assert.deepEqual(new Set(view.replacedBy.map((link) => link.id)), new Set([one.id, two.id]));
      assert.equal(view.complete, false);
      assert.match(view.problems.join('; '), /more than one later record names this record as superseded/);
      assert.equal(view.chain.length, 3);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a long chain is bounded and says it was truncated', async () => {
    const dir = tempDir();
    try {
      let tick = 0;
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'), {
        now: () => new Date(Date.parse('2026-03-01T00:00:00.000Z') + tick++ * 1000),
      });
      const objects = ['Coal', 'Diesel'];
      const records = [];
      for (let i = 0; i < MAX_HISTORY_CHAIN + 1; i += 1) {
        const added = await store.add({
          subject: 'Engine',
          relationship: 'fuel',
          object: objects[i % objects.length],
          origin: 'user',
          supersedes: records.length > 0 ? [records.at(-1).id] : [],
        });
        records.push(added.record);
      }

      const view = await store.history(records[0].id);
      assert.equal(view.chain.length, MAX_HISTORY_CHAIN, 'the chain is bounded');
      assert.equal(view.chainTruncated, true);
      assert.equal(view.complete, false);
      assert.deepEqual(view.problems, []);

      const app = createApp({ dataDir: dir });
      const shown = await app.controller.knowledgeHistory(records[0].id);
      assert.match(shown.display, /Chain:\s+\d+ record\(s\), oldest first \(truncated\)/);
      assert.match(shown.display, /Chain note:\s+limited: chain was truncated/);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('multiple retraction events make the state ambiguous and inactive', async () => {
    const dir = tempDir();
    try {
      const claim = seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      seed(dir, [
        claim,
        retractionEvent({ id: CLAIM_IDS.d, targetId: claim.id, reason: 'first event' }),
        retractionEvent({ id: CLAIM_IDS.e, targetId: claim.id, reason: 'second event', createdAt: '2026-01-03T00:00:00.000Z' }),
      ]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      const [read] = await store.list({ limit: 5 });
      assert.equal(read.lifecycleState, 'ambiguous');
      assert.equal(read.active, false);
      assert.equal(read.retractionAmbiguous, true);
      assert.equal(read.retraction, null, 'no single event is presented as the cause');
      assert.equal((await store.search('engine')).length, 0, 'ambiguous lifecycle evidence is never active');

      const view = await store.history(claim.id);
      assert.equal(view.state, 'ambiguous');
      assert.equal(view.retractionAmbiguous, true);
      assert.equal(view.retraction, null);
      assert.equal(view.complete, false);
      assert.match(view.problems.join('; '), /more than one retraction event targets this record/);
      assert.equal((await store.status()).retractions, 2);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a record that is both retracted and superseded is ambiguous', async () => {
    const dir = tempDir();
    try {
      const old = seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      const replacement = seededRecord({
        id: CLAIM_IDS.b,
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Electric',
        createdAt: '2026-01-02T00:00:00.000Z',
        supersededBy: [old.id],
      });
      seed(dir, [old, replacement, retractionEvent({ targetId: old.id, reason: 'retired by hand' })]);
      const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

      const view = await store.history(old.id);
      assert.equal(view.state, 'ambiguous');
      assert.equal(view.record.active, false);
      assert.equal(view.complete, false);
      assert.match(view.problems.join('; '), /record is both retracted and superseded/);
    } finally {
      cleanup(dir);
    }
  });
});

test('knowledge lifecycle - show and history state lifecycle truth without claiming activity', async (t) => {
  await t.test('a retracted claim is shown as historical with its evidence intact', async () => {
    const dir = tempDir();
    try {
      const app = createApp({ dataDir: dir });
      const added = await app.controller.knowledgeAdd({
        subject: 'Engine',
        relationship: 'fuel',
        object: 'Coal',
        evidence: 'maintenance log 2025',
      });
      const claimId = added.operation.steps[0].result.data.id;
      await app.controller.knowledgeRetract({ target: claimId, reason: 'replaced by the electric service record' });

      const shown = await app.controller.knowledgeShow(claimId);
      assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
      assert.match(shown.display, /Status:\s+retracted/);
      assert.match(shown.display, /RETRACTED:.*replaced by the electric service record/);
      assert.match(shown.display, /Evidence:\s+maintenance log 2025/);
      assert.match(shown.display, /Provenance:\s+user_supplied \(user_confirmed\)/);

      const history = await app.controller.knowledgeHistory(claimId);
      assert.equal(history.status, Outcome.SUCCESS_VERIFIED);
      assert.match(history.display, /State:\s+retracted \(historical\)/);
      assert.match(history.display, /Retraction:.*replaced by the electric service record/);
      assert.match(history.display, /Supersedes:\s+\(none\)/);
      assert.match(history.display, /Superseded by:\s+\(none\)/);
      assert.match(history.display, /Chain note:\s+complete/);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('ambiguous lifecycle evidence is shown as not active', async () => {
    const dir = tempDir();
    try {
      const claim = seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' });
      seed(dir, [
        claim,
        retractionEvent({ id: CLAIM_IDS.d, targetId: claim.id }),
        retractionEvent({ id: CLAIM_IDS.e, targetId: claim.id, createdAt: '2026-01-03T00:00:00.000Z' }),
      ]);
      const app = createApp({ dataDir: dir });

      const shown = await app.controller.knowledgeShow(claim.id);
      assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
      assert.match(shown.display, /Status:\s+ambiguous/);
      assert.match(shown.display, /LIFECYCLE:\s+ambiguous — multiple retraction events; not active/);

      const history = await app.controller.knowledgeHistory(claim.id);
      assert.equal(history.status, Outcome.SUCCESS_VERIFIED);
      assert.match(history.display, /State:\s+ambiguous — multiple retraction events; not active/);
      assert.match(history.display, /Retraction:\s+ambiguous/);
      assert.match(history.display, /Chain note:\s+limited:.*more than one retraction event/);
    } finally {
      cleanup(dir);
    }
  });
});

test('knowledge lifecycle - read-only inspection never calls the model and writes no knowledge', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, calls } = countingGateway();
  const app = createApp({ dataDir: dir, gateway });

  const added = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
  const claimId = added.operation.steps[0].result.data.id;
  const file = path.join(dir, 'knowledge.jsonl');
  const knowledgeBefore = fs.readFileSync(file, 'utf8');
  assert.equal(operations(dir).length, 1, 'only the add is audited so far');

  const shown = await app.controller.knowledgeShow(claimId);
  assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
  const history = await app.controller.knowledgeHistory(claimId);
  assert.equal(history.status, Outcome.SUCCESS_VERIFIED);
  assert.match(history.display, /State:\s+supported/);
  assert.equal(operations(dir).length, 1, 'show and history are direct reads with no audit record');

  const listed = await app.controller.knowledgeList();
  assert.equal(listed.status, Outcome.SUCCESS_VERIFIED);
  const searched = await app.controller.knowledgeSearch('engine');
  assert.equal(searched.status, Outcome.SUCCESS_VERIFIED);

  assert.equal(calls.calls, 0, 'no inference request was made');
  assert.equal(fs.readFileSync(file, 'utf8'), knowledgeBefore, 'no read mutated the knowledge store');
  const audited = operations(dir);
  assert.deepEqual(audited.map((op) => op.capability), ['knowledge.add', 'knowledge.list', 'knowledge.search']);
  for (const op of audited) {
    assert.equal(op.steps.some((step) => step.action === 'knowledge.retract'), false);
  }
});

test('knowledge lifecycle - a retracted claim never reaches the model prompt', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('The engine uses coal.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  const added = await app.controller.knowledgeAdd({
    subject: 'Engine',
    relationship: 'fuel',
    object: 'Coal',
    evidence: 'maintenance log 2025',
  });
  const claimId = added.operation.steps[0].result.data.id;
  await app.controller.knowledgeRetract({ target: claimId, reason: 'the log was withdrawn' });

  const res = await app.controller.handle('What fuel does the Engine use?');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.ok(captured.request);
  assert.ok(!captured.request.prompt.includes('Engine --[fuel]--> Coal'), 'retracted knowledge is not injected');
  assert.ok(!captured.request.prompt.includes('maintenance log 2025'));
  assert.deepEqual(res.operation.prompt.knowledgeIds, [], 'no retired record is counted as retrieved evidence');
});

test('knowledge lifecycle - CLI retraction and history work end to end without a model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir);

  const added = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
    '--evidence', 'maintenance log 2025',
  ], env);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const claimId = JSON.parse(knowledgeLines(dir)[0]).id;

  const retracted = await runCli([
    'knowledge', 'retract', shortId(claimId), '--reason', 'replaced by the electric service record',
  ], env);
  assert.equal(retracted.code, 0, retracted.stdout + retracted.stderr);
  assert.match(retracted.stdout, /Retracted knowledge record/);
  assert.match(retracted.stdout, /original claim, evidence, and provenance remain stored/);

  assert.equal(knowledgeLines(dir).length, 2);
  const event = JSON.parse(knowledgeLines(dir)[1]);
  assert.equal(event.kind, 'retraction');
  assert.equal(event.targetId, claimId);

  const shown = await runCli(['knowledge', 'show', shortId(claimId)], env);
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /Status:\s+retracted/);
  assert.match(shown.stdout, /RETRACTED:.*replaced by the electric service record/);
  assert.match(shown.stdout, /Evidence:\s+maintenance log 2025/);
  assert.match(shown.stdout, /Provenance:\s+user_supplied/);

  const listed = await runCli(['knowledge', 'list'], env);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /status: retracted/);

  const searched = await runCli(['knowledge', 'search', 'maintenance'], env);
  assert.equal(searched.code, 0, searched.stdout + searched.stderr);
  assert.match(searched.stdout, /no matching knowledge records/);

  const history = await runCli(['knowledge', 'history', shortId(claimId)], env);
  assert.equal(history.code, 0, history.stdout + history.stderr);
  assert.match(history.stdout, /State:\s+retracted \(historical\)/);
  assert.match(history.stdout, /Retraction:.*replaced by the electric service record/);
  assert.match(history.stdout, /Supersedes:\s+\(none\)/);
  assert.match(history.stdout, /Superseded by:\s+\(none\)/);
  assert.match(history.stdout, /Chain note:\s+complete/);

  const retractOp = operations(dir).filter((op) => op.capability === 'knowledge.retract').at(-1);
  assert.equal(retractOp.status, 'success_verified');
  assert.equal(retractOp.origin, 'user');
  assert.match(retractOp.request, /knowledge retract \[/);
  assert.match(retractOp.request, /\(reason recorded\)/);
  assert.equal(retractOp.steps[0].input.target, shortId(claimId));
  assert.equal(retractOp.steps[0].input.reason, 'replaced by the electric service record');
  assert.equal(retractOp.steps[0].result.data.retractionId, event.id);

  const duplicate = await runCli(['knowledge', 'retract', shortId(claimId)], env);
  assert.equal(duplicate.code, 1, duplicate.stdout + duplicate.stderr);
  assert.match(duplicate.stdout, /already retracted/);
  assert.equal(knowledgeLines(dir).length, 2, 'the duplicate wrote nothing');
});

test('knowledge lifecycle - CLI refuses malformed, missing, and ambiguous lifecycle requests', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir);

  for (const argv of [
    ['knowledge', 'retract'],
    ['knowledge', 'retract', 'one', 'two'],
    ['knowledge', 'history'],
    ['knowledge', 'history', '--limit', '2'],
  ]) {
    const res = await runCli(argv, env);
    assert.equal(res.code, 2, `${argv.join(' ')} -> ${res.stdout}${res.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(dir, 'operations.jsonl')), false, 'usage errors write nothing');

  const missingHistory = await runCli(['knowledge', 'history', 'missing123'], env);
  assert.equal(missingHistory.code, 1);
  assert.match(missingHistory.stdout, /No knowledge record found/);
  assert.equal(fs.existsSync(path.join(dir, 'operations.jsonl')), false, 'a direct read miss writes no audit record');

  const missingRetract = await runCli(['knowledge', 'retract', 'missing123'], env);
  assert.equal(missingRetract.code, 1);
  assert.match(missingRetract.stdout, /retraction target not found/);
  assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl')), false, 'nothing was appended');

  seed(dir, [
    seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: 'aaaaaaaa-2222-4222-8222-222222222222', subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
  ]);

  const ambiguousHistory = await runCli(['knowledge', 'history', 'aaaaaaaa'], env);
  assert.equal(ambiguousHistory.code, 1);
  assert.match(ambiguousHistory.stdout, /matches 2 knowledge records/);

  const ambiguousRetract = await runCli(['knowledge', 'retract', 'aaaaaaaa'], env);
  assert.equal(ambiguousRetract.code, 1);
  assert.match(ambiguousRetract.stdout, /ambiguous/);
  assert.equal(knowledgeLines(dir).length, 2, 'the ambiguous retraction wrote nothing');
});
