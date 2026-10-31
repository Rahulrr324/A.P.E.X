// Implementation Batch S: explicit conflict resolution.
//
// A resolution is an append-only event in which an authorized user chooses one claim
// from an exact live conflict group. The decision is recorded; it is never evidence that
// the chosen claim is factually true, and every alternative claim stays stored. These
// tests pin the authorization boundary, exact-group semantics, append-only preservation,
// deterministic repeats, fail-closed behavior, audit reporting, and how a decision is
// presented in list, history, and the model context.
//
// Live model inference is not involved. Model-facing tests use a fixed test double.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, sha256Hex } from '../src/knowledge/knowledge-store.js';
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
  missing: '99999999-9999-4999-8999-999999999999',
  event: 'eeeeeeee-5555-4555-8555-555555555555',
  event2: 'ffffffff-6666-4666-8666-666666666666',
};

// Two ids that share an eight-character prefix, for the ambiguous-reference case.
const SHARED_IDS = {
  one: 'abcdefff-1111-4111-8111-111111111111',
  two: 'abcdefff-2222-4222-8222-222222222222',
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
  status = 'conflicting',
  evidence = null,
  createdAt = '2026-01-01T00:00:00.000Z',
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
  };
}

function resolutionEvent({
  id = CLAIM_IDS.event,
  targetIds,
  chosenId,
  reason = null,
  createdAt = '2026-01-05T00:00:00.000Z',
  provenance = { origin: 'user_supplied', updateMode: 'user_confirmed' },
}) {
  return {
    schema: 1,
    kind: 'resolution',
    id,
    targetIds,
    chosenId,
    ...(reason ? { reason } : {}),
    createdAt,
    provenance,
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

function storeFor(dir) {
  return new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));
}

function healthOf(dir) {
  return storeFor(dir).health();
}

function fuelConflict() {
  return [
    seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal', evidence: 'maintenance log 2025' }),
    seededRecord({ id: CLAIM_IDS.b, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
  ];
}

// TEST DOUBLE: a model that returns fixed text and records the request. It proves how
// APEX labels and ranks stored knowledge, not what a real model would say.
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

test('resolution - records an explicit user decision and preserves every claim', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, fuelConflict());
  const file = path.join(dir, 'knowledge.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const store = storeFor(dir);

  const unresolved = await store.list({ limit: 5 });
  for (const entry of unresolved) {
    assert.equal(entry.conflictState, 'unresolved');
    assert.equal(entry.resolution, null);
    assert.equal(entry.status, 'conflicting');
    assert.deepEqual(entry.conflictsWith, entry.id === CLAIM_IDS.a ? [CLAIM_IDS.b] : [CLAIM_IDS.a]);
  }
  assert.equal((await healthOf(dir)).conflicts.groups, 1, 'the conflict is visible before any decision');

  const result = await store.resolve({
    target: CLAIM_IDS.a,
    choose: CLAIM_IDS.b,
    reason: 'the service record is newer',
    origin: 'user',
  });

  assert.equal(result.event.kind, 'resolution');
  assert.equal(result.event.chosenId, CLAIM_IDS.b);
  assert.deepEqual([...result.event.targetIds].sort(), [CLAIM_IDS.a, CLAIM_IDS.b].sort());
  assert.equal(result.event.reason, 'the service record is newer');
  assert.equal(result.event.provenance.origin, 'user_supplied');
  assert.equal(result.event.provenance.updateMode, 'user_confirmed');

  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), 'the store was appended to, never rewritten');
  assert.equal(after.slice(before.length).trim().split('\n').length, 1, 'exactly one event was added');

  const storedA = await store.get(CLAIM_IDS.a);
  const storedB = await store.get(CLAIM_IDS.b);
  assert.deepEqual(storedA, seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal', evidence: 'maintenance log 2025' }));
  assert.deepEqual(storedB, seededRecord({ id: CLAIM_IDS.b, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }));
  assert.deepEqual(await store.getEvent(result.event.id), result.event);

  // A recorded decision is not verified truth: the conflict, both claims, and both
  // statuses remain exactly what they were.
  const listed = await store.list({ limit: 5 });
  for (const entry of listed) {
    assert.equal(entry.conflictState, 'resolved');
    assert.equal(entry.status, 'conflicting', 'the claims still disagree; the decision does not make one true');
    assert.equal(entry.active, true);
    assert.equal(entry.resolution.chosenId, CLAIM_IDS.b);
    assert.equal(entry.resolution.chosen, entry.id === CLAIM_IDS.b);
  }

  const chosenHistory = await store.history(CLAIM_IDS.b);
  assert.equal(chosenHistory.resolutions.length, 1);
  assert.equal(chosenHistory.resolutions[0].chosen, true);
  assert.equal(chosenHistory.resolutions[0].applicable, true);
  assert.equal(chosenHistory.resolutions[0].reason, 'the service record is newer');
  assert.equal(chosenHistory.complete, true);
  assert.deepEqual(chosenHistory.problems, []);

  const otherHistory = await store.history(CLAIM_IDS.a);
  assert.equal(otherHistory.resolutions[0].chosen, false);
  assert.equal(otherHistory.resolutions[0].chosenId, CLAIM_IDS.b);
});

test('resolution - model origin cannot decide and a plan cannot propose it', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, fuelConflict());
  const store = storeFor(dir);
  const file = path.join(dir, 'knowledge.jsonl');
  const before = fs.readFileSync(file, 'utf8');

  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b, origin: 'model' }),
    (err) => err.code === 'WRITE_REQUIRES_USER_ORIGIN',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused model decision wrote nothing');

  const app = createApp({ dataDir: dir });
  assert.equal(app.registry.get('knowledge.resolve').plannable, false);
  const auth = app.registry.authorize('knowledge.resolve', 'model');
  assert.equal(auth.decision, 'deny');
  assert.equal(auth.reason, 'ORIGIN_NOT_PERMITTED');

  const denied = await app.controller.runAction(
    'knowledge.resolve',
    { target: CLAIM_IDS.a, choose: CLAIM_IDS.b },
    'model',
    'op-model',
  );
  assert.equal(denied.outcome, Outcome.ACTION_DENIED);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the denied execution wrote nothing');
});

test('resolution - the chosen claim must belong to the live conflict group', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const [a, b] = fuelConflict();
  seed(dir, [
    a,
    b,
    seededRecord({ id: CLAIM_IDS.c, subject: 'Engine', relationship: 'transmission', object: 'Automatic', status: 'supported' }),
    seededRecord({ id: CLAIM_IDS.d, subject: 'Engine', relationship: 'fuel', object: 'Electric' }),
    {
      schema: 1,
      kind: 'retraction',
      id: CLAIM_IDS.event2,
      targetId: CLAIM_IDS.d,
      createdAt: '2026-01-02T00:00:00.000Z',
      provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
    },
  ]);
  const store = storeFor(dir);
  const file = path.join(dir, 'knowledge.jsonl');
  const before = fs.readFileSync(file, 'utf8');

  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.c, origin: 'user' }),
    /chosen claim is not part of the conflict group/,
  );
  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.d, origin: 'user' }),
    /chosen claim is not part of the conflict group/,
    'a retracted claim is not a live alternative',
  );
  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.c, choose: CLAIM_IDS.a, origin: 'user' }),
    /has no live conflicting claim/,
    'an unrelated claim is not resolved',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'every refusal wrote nothing');
});

test('resolution - missing and ambiguous targets are refused', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, [
    seededRecord({ id: SHARED_IDS.one, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: SHARED_IDS.two, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
  ]);
  const store = storeFor(dir);
  const file = path.join(dir, 'knowledge.jsonl');
  const before = fs.readFileSync(file, 'utf8');

  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.missing, choose: SHARED_IDS.one, origin: 'user' }),
    /resolution target not found/,
  );
  await assert.rejects(
    () => store.resolve({ target: 'abcdefff', choose: SHARED_IDS.one, origin: 'user' }),
    /resolution target is ambiguous/,
  );
  await assert.rejects(
    () => store.resolve({ target: SHARED_IDS.one, choose: 'abcdefff', origin: 'user' }),
    /chosen claim is ambiguous/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'no ambiguous or missing reference was guessed');
});

test('resolution - a repeated decision is refused and a changed decision is recorded', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, fuelConflict());
  const store = storeFor(dir);
  const file = path.join(dir, 'knowledge.jsonl');

  const first = await store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b, origin: 'user' });
  const afterFirst = fs.readFileSync(file, 'utf8');

  await assert.rejects(
    () => store.resolve({ target: CLAIM_IDS.b, choose: CLAIM_IDS.b, origin: 'user' }),
    /already been recorded for the same claims/,
    'the same decision is deterministic and adds nothing',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'the duplicate wrote nothing');

  const second = await store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.a, origin: 'user' });
  assert.notEqual(second.event.id, first.event.id, 'a changed decision is a separate event');
  assert.equal(knowledgeLines(dir).length, 4, 'two claims and two decisions');

  const [readA, readB] = await store.list({ limit: 5 });
  const byId = new Map([[readA.id, readA], [readB.id, readB]]);
  assert.equal(byId.get(CLAIM_IDS.a).resolution.chosen, true);
  assert.equal(byId.get(CLAIM_IDS.b).resolution.chosen, false);

  const historyA = await store.history(CLAIM_IDS.a);
  assert.equal(historyA.resolutions.length, 2, 'both decisions remain discoverable');
  assert.equal(historyA.resolutions[0].chosen, false, 'the first decision chose the other claim');
  assert.equal(historyA.resolutions[0].applicable, false);
  assert.equal(historyA.resolutions[0].note, 'a later resolution for the same claims governs');
  assert.equal(historyA.resolutions[1].chosen, true);
  assert.equal(historyA.resolutions[1].applicable, true);
  assert.equal(historyA.complete, true, 'a changed mind is history, not damage');

  const historyB = await store.history(CLAIM_IDS.b);
  assert.equal(historyB.resolutions[0].chosen, true);
  assert.equal(historyB.resolutions[0].applicable, false);
  assert.equal(historyB.resolutions[1].chosen, false);
  assert.equal(historyB.resolutions[1].applicable, true);
});

test('resolution - a changed conflict group reopens the conflict without erasing the decision', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, fuelConflict());
  const store = storeFor(dir);

  await store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b, reason: 'the service record', origin: 'user' });
  const beforeHealth = await store.health();
  assert.equal(beforeHealth.conflicts.groups, 0);
  assert.equal(beforeHealth.conflicts.resolvedGroups, 1);
  assert.equal(beforeHealth.conflicts.totalGroups, 1);
  assert.equal(beforeHealth.attention, false);
  assert.equal(beforeHealth.resolutions, 1);

  // A third live claim joins the group. The earlier decision named two claims exactly, so
  // it no longer governs; the decision itself remains stored and visible in history.
  await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Hydrogen', origin: 'user' });

  const [a, b, c] = await store.list({ limit: 5 });
  for (const entry of [a, b, c]) {
    assert.equal(entry.conflictState, 'unresolved', 'the grown group is unresolved again');
    assert.equal(entry.resolution, null);
    assert.equal(entry.conflictsWith.length, 2);
  }

  const historyB = await store.history(CLAIM_IDS.b);
  assert.equal(historyB.resolutions.length, 1, 'the decision is not deleted when the group changes');
  assert.equal(historyB.resolutions[0].applicable, false);
  assert.equal(historyB.resolutions[0].note, 'the live conflict group has a different set of claims');
  assert.equal(historyB.complete, true, 'group drift is ordinary history, not damage');

  const health = await healthOf(dir);
  assert.equal(health.conflicts.groups, 1);
  assert.equal(health.conflicts.claims, 3);
  assert.equal(health.conflicts.resolvedGroups, 0);
  assert.equal(health.conflicts.totalGroups, 1);
  assert.equal(health.corruptLines, 0);
  assert.equal(health.attention, true, 'an unresolved conflict requires a decision');

  // The new group can be decided as a whole; the latest applicable decision governs.
  await store.resolve({ target: c.id, choose: CLAIM_IDS.a, origin: 'user' });
  const [readA] = (await store.list({ limit: 5 })).filter((entry) => entry.id === CLAIM_IDS.a);
  assert.equal(readA.conflictState, 'resolved');
  assert.equal(readA.resolution.chosen, true);
  const afterHealth = await healthOf(dir);
  assert.equal(afterHealth.conflicts.groups, 0);
  assert.equal(afterHealth.conflicts.resolvedGroups, 1);
  assert.equal(afterHealth.conflicts.resolvedClaims, 3);
  assert.equal(afterHealth.attention, false);
});

test('resolution - contradictory or missing resolution evidence fails closed', async (t) => {
  await t.test('a resolution naming a missing claim is reported, never applied', async () => {
    const dir = tempDir();
    try {
      seed(dir, [
        seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
        seededRecord({ id: CLAIM_IDS.b, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
        resolutionEvent({
          targetIds: [CLAIM_IDS.a, CLAIM_IDS.b, CLAIM_IDS.missing],
          chosenId: CLAIM_IDS.b,
        }),
      ]);
      const store = storeFor(dir);

      const listed = await store.list({ limit: 5 });
      assert.ok(listed.every((entry) => entry.conflictState === 'unresolved'));

      const history = await store.history(CLAIM_IDS.b);
      assert.equal(history.resolutions[0].applicable, false);
      assert.equal(history.resolutions[0].note, 'a targeted claim is not in the store');
      assert.equal(history.complete, false);
      assert.match(history.problems.join('; '), /cannot govern the current store/);

      const health = await store.health();
      assert.equal(health.inspected, true);
      assert.equal(health.anomalies.count, 1);
      assert.match(health.anomalies.samples[0], /not in the store/);
      assert.equal(health.conflicts.groups, 1, 'the readable claims still show their conflict');
      assert.equal(health.attention, true);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a resolution naming claims that state one object is reported, never applied', async () => {
    const dir = tempDir();
    try {
      seed(dir, [
        seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
        seededRecord({ id: CLAIM_IDS.c, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
        resolutionEvent({
          id: CLAIM_IDS.event2,
          targetIds: [CLAIM_IDS.a, CLAIM_IDS.c],
          chosenId: CLAIM_IDS.a,
        }),
      ]);
      const store = storeFor(dir);
      const history = await store.history(CLAIM_IDS.a);
      assert.equal(history.resolutions[0].applicable, false);
      assert.equal(history.resolutions[0].note, 'the targeted claims do not state at least two different objects');
      assert.equal(history.complete, false);

      const health = await store.health();
      assert.match(health.anomalies.samples.join('; '), /fewer than two different objects/);
      assert.equal(health.attention, true);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a malformed resolution record is corrupt and refuses every complete read', async () => {
    const dir = tempDir();
    try {
      const valid = resolutionEvent({ targetIds: [CLAIM_IDS.a, CLAIM_IDS.b], chosenId: CLAIM_IDS.a });
      seed(dir, [
        seededRecord({ id: CLAIM_IDS.a, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
        seededRecord({ id: CLAIM_IDS.b, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
        resolutionEvent({
          targetIds: [CLAIM_IDS.a, CLAIM_IDS.b],
          chosenId: CLAIM_IDS.missing,
          id: CLAIM_IDS.event2,
        }),
        valid,
      ]);
      const store = storeFor(dir);
      const isUnavailable = (err) => err.code === 'STORE_UNAVAILABLE';

      await assert.rejects(() => store.list(), isUnavailable);
      await assert.rejects(() => store.history(CLAIM_IDS.a), isUnavailable);
      await assert.rejects(
        () => store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b, origin: 'user' }),
        isUnavailable,
        'a damaged store never accepts a decision',
      );

      const health = await store.health();
      assert.equal(health.state, 'damaged');
      assert.equal(health.complete, false);
      assert.equal(health.corruptLines, 1, 'the malformed event is counted, never applied');
      assert.equal(health.resolutions, 1, 'only the readable decision is counted');
      assert.equal(health.claims, 2);
      assert.equal(health.attention, true);
      assert.equal(health.conflicts.groups, 0, 'the readable decision still governs the readable claims');
      assert.equal(health.conflicts.resolvedGroups, 1, 'readable claims are still reported honestly');
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a damaged line blocks a decision and is never silently skipped', async () => {
    const dir = tempDir();
    try {
      seed(dir, fuelConflict());
      const file = path.join(dir, 'knowledge.jsonl');
      fs.appendFileSync(file, 'BROKEN LINE\n', 'utf8');
      const before = fs.readFileSync(file, 'utf8');
      const store = storeFor(dir);

      await assert.rejects(
        () => store.resolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b, origin: 'user' }),
        (err) => err.code === 'STORE_UNAVAILABLE',
      );
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    } finally {
      cleanup(dir);
    }
  });
});

test('resolution - persistence failures are never reported as verified success', async (t) => {
  await t.test('an audit append failure is reported, never as verified success', async () => {
    const dir = tempDir();
    try {
      seed(dir, fuelConflict());
      const app = createApp({ dataDir: dir });
      app.operations.append = async () => { throw new Error('injected audit failure'); };

      const res = await app.controller.knowledgeResolve({
        target: CLAIM_IDS.a,
        choose: CLAIM_IDS.b,
        reason: 'the service record',
      });
      assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
      assert.equal(res.recorded, false);
      assert.match(res.output, /could not be written/);
      // The wording explicitly denies success; what matters is that the run is not
      // reported as a verified outcome and says the trail is incomplete.
      assert.match(res.output, /not reported as verified success/);
      assert.doesNotMatch(String(res.output), /success_verified/);

      const [read] = (await app.knowledge.list({ limit: 5 })).filter((entry) => entry.id === CLAIM_IDS.b);
      assert.equal(read.conflictState, 'resolved', 'the decision itself was appended');
      assert.equal(knowledgeLines(dir).length, 3);
    } finally {
      cleanup(dir);
    }
  });

  await t.test('a store append failure leaves the log unchanged', async () => {
    const dir = tempDir();
    try {
      seed(dir, fuelConflict());
      const app = createApp({ dataDir: dir });
      const file = path.join(dir, 'knowledge.jsonl');
      const before = fs.readFileSync(file, 'utf8');
      app.knowledge.log.append = async () => { throw new StoreError('simulated append failure'); };

      const res = await app.controller.knowledgeResolve({ target: CLAIM_IDS.a, choose: CLAIM_IDS.b });
      assert.equal(res.status, Outcome.EXECUTION_FAILED);
      assert.equal(res.recorded, true);
      assert.match(res.output, /simulated append failure/);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was appended');
    } finally {
      cleanup(dir);
    }
  });
});

test('resolution - CLI records, shows, and explains a decision without a model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir);

  const coal = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal',
  ], env);
  assert.equal(coal.code, 0, coal.stdout + coal.stderr);
  const diesel = await runCli([
    'knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Diesel',
  ], env);
  assert.equal(diesel.code, 0, diesel.stdout + diesel.stderr);

  const [coalId, dieselId] = knowledgeLines(dir).map((line) => JSON.parse(line).id);

  const showUnresolved = await runCli(['knowledge', 'show', shortId(dieselId)], env);
  assert.equal(showUnresolved.code, 0, showUnresolved.stdout + showUnresolved.stderr);
  assert.match(showUnresolved.stdout, /RESOLUTION:\s+none recorded; the conflict is unresolved/);

  const missingChoice = await runCli(['knowledge', 'resolve', shortId(coalId)], env);
  assert.equal(missingChoice.code, 2, missingChoice.stdout + missingChoice.stderr);
  assert.match(missingChoice.stderr, /usage: knowledge resolve/);

  const resolved = await runCli([
    'knowledge', 'resolve', shortId(coalId), '--choose', shortId(dieselId), '--reason', 'service record 2026',
  ], env);
  assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
  assert.match(resolved.stdout, /Recorded user resolution/);
  assert.match(resolved.stdout, /chosen: \[/);
  assert.match(resolved.stdout, /alternatives preserved: 1/);
  assert.match(resolved.stdout, /This records a user decision\. It does not prove the chosen claim is true/);

  const event = JSON.parse(knowledgeLines(dir)[2]);
  assert.equal(event.kind, 'resolution');
  assert.equal(event.chosenId, dieselId);
  assert.deepEqual([...event.targetIds].sort(), [coalId, dieselId].sort());

  const listed = await runCli(['knowledge', 'list'], env);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /conflicting .*user decision chose .*a recorded decision, not verified truth/);

  const shownChosen = await runCli(['knowledge', 'show', shortId(dieselId)], env);
  assert.equal(shownChosen.code, 0, shownChosen.stdout + shownChosen.stderr);
  assert.match(shownChosen.stdout, /RESOLUTION:\s+this claim was chosen by explicit user decision/);
  assert.match(shownChosen.stdout, /this records a decision, not verified truth/);

  const shownOther = await runCli(['knowledge', 'show', shortId(coalId)], env);
  assert.match(shownOther.stdout, /RESOLUTION:\s+another claim .* was chosen by explicit user decision/);

  const history = await runCli(['knowledge', 'history', shortId(dieselId)], env);
  assert.equal(history.code, 0, history.stdout + history.stderr);
  assert.match(history.stdout, /Resolution:.*service record 2026 — chose this claim \(event .*\); a user decision, not verified truth; governs the current conflict group/);
  assert.match(history.stdout, /State:\s+conflicting/);
  assert.match(history.stdout, /Chain note:\s+complete/);

  const duplicate = await runCli([
    'knowledge', 'resolve', shortId(coalId), '--choose', shortId(dieselId),
  ], env);
  assert.equal(duplicate.code, 1, duplicate.stdout + duplicate.stderr);
  assert.match(duplicate.stdout, /already been recorded/);
  assert.equal(knowledgeLines(dir).length, 3, 'the duplicate wrote nothing');

  const resolveOp = operations(dir).filter((op) => op.capability === 'knowledge.resolve')
    .find((op) => op.status === 'success_verified');
  assert.ok(resolveOp, 'the accepted decision has a verified audit record');
  assert.equal(resolveOp.origin, 'user');
  assert.match(resolveOp.request, /knowledge resolve \[target .*choose /);
  assert.match(resolveOp.request, /\(reason recorded\)/);
  assert.equal(resolveOp.steps[0].input.target, shortId(coalId));
  assert.equal(resolveOp.steps[0].input.choose, shortId(dieselId));
});

test('resolution - secret-like ids and reasons are refused and not audited', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const env = envFor(dir);
  const secret = 'sk-1234567890abcdef1234567890abcdef';

  await runCli(['knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Coal'], env);
  await runCli(['knowledge', 'add', '--subject', 'Engine', '--relationship', 'fuel', '--object', 'Diesel'], env);
  const [coalId, dieselId] = knowledgeLines(dir).map((line) => JSON.parse(line).id);
  const before = knowledgeLines(dir).length;

  const badTarget = await runCli(['knowledge', 'resolve', secret, '--choose', shortId(dieselId)], env);
  assert.equal(badTarget.code, 1, badTarget.stdout + badTarget.stderr);
  assert.match(badTarget.stdout, /password, key, or token/);
  assert.equal(badTarget.stdout.includes(secret), false, 'the refused id is not echoed');

  const badChoice = await runCli(['knowledge', 'resolve', shortId(coalId), '--choose', secret], env);
  assert.equal(badChoice.code, 1, badChoice.stdout + badChoice.stderr);
  assert.equal(badChoice.stdout.includes(secret), false);

  const badReason = await runCli([
    'knowledge', 'resolve', shortId(coalId), '--choose', shortId(dieselId), '--reason', secret,
  ], env);
  assert.equal(badReason.code, 1, badReason.stdout + badReason.stderr);
  assert.match(badReason.stdout, /password, key, or token/);
  assert.equal(badReason.stdout.includes(secret), false);
  assert.equal(knowledgeLines(dir).length, before, 'every refused decision wrote nothing');

  const rawAudit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
  assert.equal(rawAudit.includes(secret), false, 'the secret-like value never reaches the audit log');
  const resolveOps = operations(dir).filter((op) => op.capability === 'knowledge.resolve');
  assert.equal(resolveOps.length, 3);
  for (const op of resolveOps) {
    assert.equal(op.status, Outcome.INPUT_REJECTED);
    assert.equal(op.request.includes(secret), false);
    const values = Object.values(op.steps[0].input).filter((value) => typeof value === 'string');
    assert.ok(values.length > 0);
    for (const value of values) assert.equal(value, AUDIT_OMITTED);
    assert.equal(JSON.stringify(op.steps[0].input).includes(secret), false);
  }
});

test('resolution - the model context presents a decision as a decision, not as truth', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('The engine uses diesel.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  const coal = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
  const diesel = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Diesel' });
  const coalId = coal.operation.steps[0].result.data.id;
  const dieselId = diesel.operation.steps[0].result.data.id;
  const resolved = await app.controller.knowledgeResolve({ target: coalId, choose: dieselId, reason: 'service record' });
  assert.equal(resolved.status, Outcome.SUCCESS_VERIFIED);

  const res = await app.controller.handle('What fuel does the Engine use?');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.ok(captured.request);
  const prompt = captured.request.prompt;
  assert.ok(prompt.includes('Engine --[fuel]--> Coal'), 'the alternative claim stays visible');
  assert.ok(prompt.includes('Engine --[fuel]--> Diesel'));
  assert.match(prompt, /user decision selected this claim; a recorded decision, not verified truth; other claims are preserved/);
  assert.match(prompt, /user decision selected another claim; this claim remains stored as an alternative/);
  assert.equal(prompt.includes('[CONFLICTING'), false, 'a resolved group is not labelled unresolved');
  assert.deepEqual(
    [...res.operation.prompt.knowledgeIds].sort(),
    [coalId, dieselId].sort(),
    'both claims remain retrievable evidence',
  );
});
