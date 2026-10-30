import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, validateKnowledgeRecord, sha256Hex } from '../src/knowledge/knowledge-store.js';
import { knowledgeActions } from '../src/actions/knowledge-actions.js';
import { Outcome } from '../src/outcomes.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { main } from '../src/cli.js';

// TEST DOUBLE: a model backend that returns fixed text and records the request it
// receives. It proves how APEX handles a reply, not what a real model would say.
function scriptedGateway(reply, captured = {}) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async (req) => {
      captured.request = req;
      const text = typeof reply === 'function' ? reply(req) : reply;
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

function appOn(dir, gateway = new ModelGateway({ backend: new NoBackend() })) {
  return createApp({ dataDir: dir, gateway });
}

// A record shaped exactly as validateKnowledgeRecord accepts. Used to represent
// records that only a future ingestion path could produce (model_proposed) or
// historical supersession metadata that no current write path sets.
function seededRecord({
  id,
  subject,
  relationship,
  object,
  status = 'supported',
  evidence = null,
  origin = 'user_supplied',
  updateMode = 'user_confirmed',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { origin, updateMode },
    ...(supersededBy ? { supersededBy } : {}),
  };
}

function seedKnowledge(dir, records) {
  const file = path.join(dir, 'knowledge.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function capture() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}

test('knowledge store - validation and provenance', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const filePath = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(filePath);

  await t.test('requires user origin to add knowledge', async () => {
    await assert.rejects(
      () => store.add({
        subject: 'APEX',
        relationship: 'architecture',
        object: 'modular',
        origin: 'model',
      }),
      (err) => {
        assert.equal(err.code, 'WRITE_REQUIRES_USER_ORIGIN');
        return true;
      },
    );
  });

  await t.test('refuses secrets in fields', async () => {
    await assert.rejects(
      () => store.add({
        subject: 'API_KEY',
        relationship: 'is',
        object: 'sk-1234567890abcdef1234567890abcdef',
        origin: 'user',
      }),
      (err) => {
        assert.equal(err.code, 'SECRET_REFUSED');
        return true;
      },
    );
  });

  await t.test('successfully adds record with user-confirmed provenance', async () => {
    const { record, conflictingIds } = await store.add({
      subject: 'APEX',
      relationship: 'has_subsystem',
      object: 'Cognitive Controller',
      evidence: 'README section 3',
      origin: 'user',
      provenance: { operationId: 'op-123' },
    });

    assert.ok(record.id);
    assert.equal(record.subject, 'APEX');
    assert.equal(record.relationship, 'has_subsystem');
    assert.equal(record.object, 'Cognitive Controller');
    assert.equal(record.evidence, 'README section 3');
    assert.equal(record.status, 'supported');
    assert.equal(conflictingIds.length, 0);
    assert.equal(record.provenance.origin, 'user_supplied');
    assert.equal(record.provenance.updateMode, 'user_confirmed');
    assert.equal(record.provenance.operationId, 'op-123');

    const fetched = await store.get(record.id);
    assert.equal(fetched.id, record.id);
  });
});

test('knowledge store - conflict detection', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const filePath = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(filePath);

  const first = await store.add({
    subject: 'Server',
    relationship: 'default_port',
    object: '8080',
    origin: 'user',
  });

  const second = await store.add({
    subject: 'Server',
    relationship: 'default_port',
    object: '9090',
    origin: 'user',
  });

  assert.equal(second.conflictingIds.length, 1);
  assert.equal(second.conflictingIds[0], first.record.id);
  assert.equal(second.record.status, 'conflicting');

  const list = await store.list();
  assert.equal(list.length, 2);
  const updatedFirst = list.find((r) => r.id === first.record.id);
  const updatedSecond = list.find((r) => r.id === second.record.id);

  assert.equal(updatedFirst.status, 'conflicting');
  assert.ok(updatedFirst.conflictsWith.includes(second.record.id));
  assert.equal(updatedSecond.status, 'conflicting');
  assert.ok(updatedSecond.conflictsWith.includes(first.record.id));
});

test('knowledge store - search and retrieval bounding', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const filePath = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(filePath);

  await store.add({ subject: 'Antigravity', relationship: 'developed_by', object: 'Google DeepMind', origin: 'user' });
  await store.add({ subject: 'NodeJS', relationship: 'runtime_for', object: 'JavaScript', origin: 'user' });
  await store.add({ subject: 'APEX', relationship: 'written_in', object: 'JavaScript', origin: 'user' });

  const hits = await store.search('JavaScript runtime', { limit: 2 });
  assert.ok(hits.length >= 1 && hits.length <= 2);
  assert.equal(hits[0].record.subject, 'NodeJS');
});

test('knowledge store - question words alone do not retrieve unrelated records', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  await store.add({ subject: 'Weekly sync', relationship: 'notes', object: 'Bring what you need to the meeting', origin: 'user' });
  await store.add({ subject: 'France', relationship: 'capital', object: 'Paris', origin: 'user' });

  const hits = await store.search('What is the capital of France?');
  assert.deepEqual(hits.map((h) => h.record.subject), ['France']);
  assert.deepEqual(await store.search('what is it?'), [], 'a question made only of stopwords matches nothing');
});

test('knowledge store - a rare term match outranks an incidental common-word match', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));

  await store.add({ subject: 'martinez account', relationship: 'owned_by', object: 'finance team', origin: 'user' });
  await store.add({ subject: 'office printer', relationship: 'budget_code', object: 'sigma 9', origin: 'user' });
  await store.add({ subject: 'break room fridge', relationship: 'cleaned_by', object: 'vendor sigma 9 team', origin: 'user' });

  // Counting matched words alone gives the triple that shares "team" and the triple
  // that names the queried account the same standing, because every word of the
  // request is weighted equally. Rarity is what separates them.
  const hits = await store.search('which team owns the martinez account budget review', { limit: 10 });
  const bySubject = new Map(hits.map((h) => [h.record.subject, h.score]));
  assert.equal(hits[0].record.subject, 'martinez account');
  assert.ok(bySubject.get('office printer') < bySubject.get('martinez account'));
  assert.ok(bySubject.get('break room fridge') < bySubject.get('martinez account'));
  assert.ok(hits.every((h) => h.score > 0 && h.score <= 1), 'scores stay in [0, 1]');
});

test('knowledge store - corrupt storage handling', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const filePath = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(filePath);

  await store.add({ subject: 'Alpha', relationship: 'leads_to', object: 'Beta', origin: 'user' });
  // Corrupt a line
  fs.appendFileSync(filePath, 'NOT_VALID_JSON\n', 'utf8');

  const status = await store.status();
  assert.equal(status.records, 1);
  assert.equal(status.corrupt, 1);

  await assert.rejects(
    () => store.list(),
    /corrupt line/,
  );
});

test('knowledge actions - registry and verification', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const filePath = path.join(dir, 'knowledge.jsonl');
  const store = new KnowledgeStore(filePath);
  const actions = knowledgeActions(store);

  const addDef = actions.find((a) => a.name === 'knowledge.add');
  assert.ok(addDef);
  assert.deepEqual(addDef.origins, ['user']);

  const listDef = actions.find((a) => a.name === 'knowledge.list');
  assert.ok(listDef.origins.includes('model'));

  const searchDef = actions.find((a) => a.name === 'knowledge.search');
  assert.ok(searchDef.origins.includes('model'));

  // Execute add through action
  const validated = addDef.validate({ subject: 'ItemA', relationship: 'relates_to', object: 'ItemB' });
  const execResult = await addDef.execute({ operationId: 'test-op', origin: 'user' }, validated);
  assert.ok(execResult.data.id);

  const verifyResult = await addDef.verify({ operationId: 'test-op', origin: 'user' }, validated, execResult);
  assert.equal(verifyResult.ok, true);
});

test('controller - knowledge methods and context retrieval in model answer', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));

  let capturedPrompt = null;
  const mockBackend = {
    configured: true,
    describe: () => ({ kind: 'mock', name: 'mock-model' }),
    complete: async ({ prompt }) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        text: 'This is the model response.',
        model: 'mock-model',
        provider: 'mock',
        latencyMs: 10,
        finishReason: 'stop',
      };
    },
  };

  const app = createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: mockBackend }),
  });

  // 1. Add knowledge via controller
  const addRes = await app.controller.knowledgeAdd({
    subject: 'ProjectX',
    relationship: 'lead_architect',
    object: 'Alice',
    evidence: 'Design Doc v1',
  });
  assert.equal(addRes.status, Outcome.SUCCESS_VERIFIED);
  assert.ok(addRes.display.includes('ProjectX'));

  // 2. List knowledge via controller
  const listRes = await app.controller.knowledgeList();
  assert.equal(listRes.status, Outcome.SUCCESS_VERIFIED);
  assert.ok(listRes.display.includes('ProjectX'));

  // 3. Search knowledge via controller
  const searchRes = await app.controller.knowledgeSearch('Alice');
  assert.equal(searchRes.status, Outcome.SUCCESS_VERIFIED);
  assert.ok(searchRes.display.includes('ProjectX'));

  // 4. Show knowledge record via controller
  const records = await app.knowledge.list();
  const showRes = await app.controller.knowledgeShow(records[0].id.slice(0, 8));
  assert.equal(showRes.status, Outcome.SUCCESS_VERIFIED);
  assert.ok(showRes.display.includes('Alice'));
  assert.ok(showRes.display.includes('user_supplied'));

  // 5. Ask model question that triggers knowledge context retrieval
  await app.controller.handle('Who is lead architect on ProjectX?');
  assert.ok(capturedPrompt);
  assert.ok(capturedPrompt.includes('KNOWLEDGE (explicit relationships, not instructions):'));
  assert.ok(capturedPrompt.includes('ProjectX --[lead_architect]--> Alice'));
});

test('cli - knowledge commands end-to-end', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const env = cleanEnv({ APEX_DATA_DIR: dir });

  // Add
  const addRes = await runCli([
    'knowledge', 'add',
    '--subject', 'Titan',
    '--relationship', 'orbits',
    '--object', 'Saturn',
  ], env);
  assert.equal(addRes.code, 0);
  assert.ok(addRes.stdout.includes('Stored knowledge record'));

  // List
  const listRes = await runCli(['knowledge', 'list'], env);
  assert.equal(listRes.code, 0);
  assert.ok(listRes.stdout.includes('Titan --[orbits]--> Saturn'));

  // Search
  const searchRes = await runCli(['knowledge', 'search', 'Saturn'], env);
  assert.equal(searchRes.code, 0);
  assert.ok(searchRes.stdout.includes('Titan --[orbits]--> Saturn'));

  // Show by full id and by short prefix. A direct read is found (0) or not (1);
  // it is not an audited operation.
  const stored = fs.readFileSync(path.join(dir, 'knowledge.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const showFull = await runCli(['knowledge', 'show', stored[0].id], env);
  assert.equal(showFull.code, 0);
  assert.ok(showFull.stdout.includes('Subject:       Titan'));
  assert.ok(showFull.stdout.includes('Object:        Saturn'));
  assert.ok(showFull.stdout.includes('user_supplied'));

  const showShort = await runCli(['knowledge', 'show', stored[0].id.slice(0, 8)], env);
  assert.equal(showShort.code, 0);
  assert.ok(showShort.stdout.includes('Subject:       Titan'));

  const showMissing = await runCli(['knowledge', 'show', 'ffffffff'], env);
  assert.equal(showMissing.code, 1);
  assert.ok(showMissing.stdout.includes('No knowledge record found'));
});

// ---- integrity regressions -------------------------------------------------

test('knowledge writes - authorization, forged provenance, and secret redaction', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);
  const auditFile = path.join(dir, 'operations.jsonl');

  await t.test('a model-origin knowledge write is denied before execution', async () => {
    const step = await app.controller.runAction(
      'knowledge.add',
      { subject: 'Alpha', relationship: 'trusts', object: 'Beta' },
      'model',
      'op-model-add',
    );
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.execution.status, 'not_run');
    assert.equal((await app.knowledge.list()).length, 0);
  });

  await t.test('forged provenance fields in the input are rejected', async () => {
    const step = await app.controller.runAction(
      'knowledge.add',
      { subject: 'Alpha', relationship: 'trusts', object: 'Beta', origin: 'user', updateMode: 'user_confirmed' },
      'user',
      'op-forged-provenance',
    );
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.equal((await app.knowledge.list()).length, 0);
  });

  await t.test('the store itself refuses a supplied provenance origin or updateMode', async () => {
    await assert.rejects(
      () => app.knowledge.add({
        subject: 'Alpha',
        relationship: 'trusts',
        object: 'Beta',
        origin: 'user',
        provenance: { origin: 'user_supplied' },
      }),
      /may not be supplied directly/,
    );
    await assert.rejects(
      () => app.knowledge.add({
        subject: 'Alpha',
        relationship: 'trusts',
        object: 'Beta',
        origin: 'user',
        provenance: { updateMode: 'user_confirmed' },
      }),
      /may not be supplied directly/,
    );
    assert.equal((await app.knowledge.list()).length, 0);
  });

  await t.test('a credential-like value is refused and never written to the audit log', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const add = await app.controller.knowledgeAdd({ subject: 'API key', relationship: 'is', object: secret });
    assert.equal(add.status, Outcome.INPUT_REJECTED);
    assert.equal(add.recorded, true);
    assert.equal((await app.knowledge.list()).length, 0);
    assert.ok(!fs.readFileSync(auditFile, 'utf8').includes(secret));

    const search = await app.controller.knowledgeSearch(`find ${secret}`);
    assert.equal(search.status, Outcome.INPUT_REJECTED);
    assert.ok(!fs.readFileSync(auditFile, 'utf8').includes(secret));

    const evidence = await app.controller.knowledgeAdd({
      subject: 'Server',
      relationship: 'uses',
      object: 'token',
      evidence: 'password: hunter2',
    });
    assert.equal(evidence.status, Outcome.INPUT_REJECTED);
    assert.ok(!fs.readFileSync(auditFile, 'utf8').includes('hunter2'));
  });

  await t.test('secret-looking provenance context is not persisted', async () => {
    const { record } = await app.knowledge.add({
      subject: 'Gamma',
      relationship: 'relates_to',
      object: 'Delta',
      origin: 'user',
      provenance: { context: 'password: hunter2' },
    });
    assert.equal(record.provenance.context, undefined);
    assert.ok(!fs.readFileSync(path.join(dir, 'knowledge.jsonl'), 'utf8').includes('hunter2'));
  });
});

test('knowledge - a model plan cannot propose a knowledge write', async () => {
  const dir = makeTempDataDir();
  try {
    const plan = JSON.stringify({
      steps: [{
        id: 's1',
        description: 'record a claim',
        action: 'knowledge.add',
        input: { subject: 'Alpha', relationship: 'trusts', object: 'Beta' },
        depends_on: [],
      }],
    });
    const { gateway, captured } = scriptedGateway(plan);
    const app = createApp({ dataDir: dir, gateway });

    assert.equal(app.registry.get('knowledge.add').plannable, false);

    const res = await app.controller.planTask('make the system remember who to trust');

    assert.equal(res.status, Outcome.PLAN_REJECTED);
    assert.match(res.display, /cannot be part of a plan/);
    assert.equal((await app.taskStore.list()).length, 0);
    assert.equal((await app.knowledge.list()).length, 0);
    // The planner never invites the model to use a user-only write.
    assert.ok(captured.request);
    assert.ok(!captured.request.system.includes('knowledge.add'));
  } finally {
    cleanup(dir);
  }
});

test('knowledge - audit failure is reported, never as verified success', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    app.operations.append = async () => { throw new Error('injected audit failure'); };

    const res = await app.controller.knowledgeAdd({ subject: 'Alpha', relationship: 'leads_to', object: 'Beta' });

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(res.recorded, false);
    assert.match(res.output, /could not be written/);
    assert.doesNotMatch(String(res.output), /verified/);
    // The write itself happened; only its audit record failed.
    assert.equal((await app.knowledge.list()).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('knowledge - corrupt storage fails closed instead of looking empty', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);
  const file = path.join(dir, 'knowledge.jsonl');
  const good = await app.knowledge.add({ subject: 'Alpha', relationship: 'leads_to', object: 'Beta', origin: 'user' });
  fs.appendFileSync(file, 'BROKEN LINE\n', 'utf8');

  await t.test('every incomplete read refuses to answer', async () => {
    const isStoreError = (err) => err.code === 'STORE_UNAVAILABLE';
    await assert.rejects(() => app.knowledge.list(), isStoreError);
    await assert.rejects(() => app.knowledge.search('alpha'), isStoreError);
    await assert.rejects(() => app.knowledge.get(good.record.id), isStoreError);
    await assert.rejects(() => app.knowledge.findByPrefix(good.record.id.slice(0, 8)), isStoreError);
    await assert.rejects(
      () => app.knowledge.add({ subject: 'Gamma', relationship: 'relates_to', object: 'Delta', origin: 'user' }),
      isStoreError,
    );
  });

  await t.test('status still reports the damaged record set', async () => {
    const status = await app.knowledge.status();
    assert.equal(status.records, 1);
    assert.equal(status.corrupt, 1);
    // The refused add wrote nothing.
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  });

  await t.test('controller operations fail visibly, not as an empty store', async () => {
    const list = await app.controller.knowledgeList();
    assert.equal(list.status, Outcome.EXECUTION_FAILED);
    assert.equal(list.recorded, true);

    const add = await app.controller.knowledgeAdd({ subject: 'Gamma', relationship: 'relates_to', object: 'Delta' });
    assert.equal(add.status, Outcome.EXECUTION_FAILED);
    assert.equal(add.recorded, true);

    const search = await app.controller.knowledgeSearch('alpha');
    assert.equal(search.status, Outcome.EXECUTION_FAILED);
    assert.equal(search.recorded, true);
  });

  await t.test('show surfaces the storage error rather than a "not found" result', async () => {
    await assert.rejects(() => app.controller.knowledgeShow(good.record.id), (err) => err.code === 'STORE_UNAVAILABLE');
  });
});

test('knowledge - conflict detection is conservative and normalized', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);

  const add = (subject, relationship, object) => app.controller.knowledgeAdd({ subject, relationship, object });
  const forSubject = async (subject) => (await app.knowledge.list({ limit: 100 })).filter((r) => r.subject === subject);

  await t.test('the same triple is a duplicate, not a conflict', async () => {
    assert.equal((await add('Server', 'default_port', '8080')).status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await add('Server', 'default_port', '8080')).status, Outcome.SUCCESS_VERIFIED);
    const rows = await forSubject('Server');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'supported');
      assert.deepEqual(row.conflictsWith, []);
    }
  });

  await t.test('case variants of the same triple are also duplicates', async () => {
    await add('server', 'DEFAULT_PORT', '8080');
    const rows = await forSubject('server');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'supported');
    assert.deepEqual(rows[0].conflictsWith, []);
    assert.equal((await forSubject('Server')).length, 2);
  });

  await t.test('same subject+relationship with a different object conflicts', async () => {
    await add('Cache', 'size_mb', '512');
    await add('Cache', 'size_mb', '1024');
    const rows = await forSubject('Cache');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'conflicting');
      assert.equal(row.conflictsWith.length, 1);
    }
  });

  await t.test('a different subject or relationship is not a conflict', async () => {
    await add('Alpha', 'depends_on', 'Shared');
    await add('Beta', 'depends_on', 'Shared');
    await add('Gamma', 'uses', 'Library');
    await add('Gamma', 'maintains', 'Library');
    for (const subject of ['Alpha', 'Beta', 'Gamma']) {
      for (const row of await forSubject(subject)) {
        assert.equal(row.status, 'supported');
        assert.deepEqual(row.conflictsWith, []);
      }
    }
  });

  await t.test('multiple competing objects are all reported as conflicting', async () => {
    await add('Queue', 'backend', 'Redis');
    await add('Queue', 'backend', 'Kafka');
    await add('Queue', 'backend', 'RabbitMQ');
    const rows = await forSubject('Queue');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, 'conflicting');
      assert.equal(row.conflictsWith.length, 2);
    }
    // A newer timestamp never turns the newest claim into the supported one.
    assert.ok(rows.every((row) => row.status !== 'supported'));
  });
});

test('knowledge - superseded records are historical, not live conflicts', async () => {
  const dir = makeTempDataDir();
  try {
    const file = path.join(dir, 'knowledge.jsonl');
    const a = seededRecord({ id: 'a0000000-0000-4000-8000-000000000001', subject: 'Engine', relationship: 'fuel', object: 'Petrol' });
    const b = seededRecord({ id: 'b0000000-0000-4000-8000-000000000002', subject: 'Engine', relationship: 'fuel', object: 'Diesel', status: 'conflicting' });
    // c restates A's claim and explicitly supersedes B.
    const c = seededRecord({
      id: 'c0000000-0000-4000-8000-000000000003',
      subject: 'Engine',
      relationship: 'fuel',
      object: 'Petrol',
      supersededBy: [b.id],
    });
    // d carries the legacy raw superseded status with no replacement.
    const d = seededRecord({ id: 'd0000000-0000-4000-8000-000000000004', subject: 'Engine', relationship: 'fuel', object: 'Coal', status: 'superseded' });
    seedKnowledge(dir, [a, b, c, d]);
    const store = new KnowledgeStore(file);

    const byId = new Map((await store.list({ limit: 100 })).map((r) => [r.id, r]));

    assert.equal(byId.get(b.id).status, 'superseded');
    assert.deepEqual(byId.get(b.id).conflictsWith, []);
    assert.deepEqual(byId.get(b.id).supersededBy, [c.id]);

    assert.equal(byId.get(d.id).status, 'superseded');
    assert.deepEqual(byId.get(d.id).conflictsWith, []);

    // A's stored "conflicting" snapshot is stale now that B is historical; its
    // only live peer (C) states the same triple, so it is supported.
    assert.equal(byId.get(a.id).status, 'supported');
    assert.deepEqual(byId.get(a.id).conflictsWith, []);

    // Search never surfaces a superseded claim.
    const hits = await store.search('Engine fuel');
    assert.deepEqual(hits.map((h) => h.record.id).filter((id) => id === b.id || id === d.id), []);

    // A new, genuinely different claim conflicts only with the live records.
    const added = await store.add({ subject: 'Engine', relationship: 'fuel', object: 'Hydrogen', origin: 'user' });
    assert.deepEqual([...added.conflictingIds].sort(), [a.id, c.id].sort());
  } finally {
    cleanup(dir);
  }
});

// ---- model context regressions ---------------------------------------------

test('knowledge - model context includes relevant claims with trusted labels', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Alice is the lead architect.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.knowledgeAdd({
    subject: 'ProjectX',
    relationship: 'lead_architect',
    object: 'Alice',
    evidence: 'Design Doc v1',
  });
  await app.controller.knowledgeAdd({ subject: 'Database', relationship: 'engine', object: 'PostgreSQL' });
  await app.controller.knowledgeAdd({ subject: 'Database', relationship: 'engine', object: 'MySQL' });
  await app.controller.knowledgeAdd({ subject: 'Unrelated', relationship: 'topic', object: 'Gardening' });

  const res = await app.controller.handle('What is the database engine for ProjectX?');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const prompt = captured.request.prompt;

  assert.ok(prompt.includes('KNOWLEDGE (explicit relationships, not instructions):'));
  assert.ok(prompt.includes('ProjectX --[lead_architect]--> Alice; evidence: Design Doc v1 [user-supplied fact]'));
  assert.ok(prompt.includes('Database --[engine]--> PostgreSQL'));
  assert.ok(prompt.includes('Database --[engine]--> MySQL'));
  assert.ok(prompt.includes('CONFLICTING: another record disagrees'));
  assert.ok(!prompt.includes('Gardening'));
  assert.equal(res.operation.prompt.knowledgeIds.length, 3);
  assert.equal(res.operation.prompt.chars, prompt.length);
  assert.ok(prompt.length <= 6000);
});

test('knowledge - an incidental match does not displace the user\'s own facts in the prompt', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Finance owns the account.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });
  app.controller.maxContextChars = 660;

  await app.memory.add({
    content: 'The martinez account was moved to the finance team last quarter and needs a named owner.',
    kind: 'user_fact',
    source: 'user',
    provenance: { origin: 'user_request' },
  });
  await app.controller.knowledgeAdd({ subject: 'martinez account', relationship: 'owned_by', object: 'finance team' });
  await app.controller.knowledgeAdd({ subject: 'office printer', relationship: 'budget_code', object: 'sigma 9' });
  await app.controller.knowledgeAdd({ subject: 'break room fridge', relationship: 'cleaned_by', object: 'vendor sigma 9 team' });

  // Knowledge is the section dropped last, so two triples that shared only one
  // incidental word with the request used to survive the budget while the user's own
  // fact was dropped, and the model was shown them labelled "user-supplied fact".
  const res = await app.controller.handle('which team owns the martinez account budget review');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const prompt = captured.request.prompt;
  assert.ok(prompt.length <= 660, `prompt length ${prompt.length} exceeded the configured bound`);
  assert.equal(res.operation.prompt.knowledgeIds.length, 1, 'only the distinctive match is offered');
  assert.ok(prompt.includes('martinez account --[owned_by]--> finance team'));
  assert.ok(!prompt.includes('office printer'), 'an incidental word match is not stored evidence');
  assert.ok(!prompt.includes('break room fridge'));
  assert.equal(res.operation.prompt.memoryIds.length, 1, 'the user fact fits the budget once the noise is gone');
  assert.ok(prompt.includes('needs a named owner'));
});

test('knowledge - without a model, an incidental match is not shown as relevant knowledge', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);

  await app.controller.knowledgeAdd({ subject: 'martinez account', relationship: 'owned_by', object: 'finance team' });
  await app.controller.knowledgeAdd({ subject: 'office printer', relationship: 'budget_code', object: 'sigma 9' });

  const res = await app.controller.handle('which team owns the martinez account budget review');
  assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
  assert.ok(res.display.includes('martinez account --[owned_by]--> finance team'));
  assert.ok(!res.display.includes('office printer'), 'the direct display uses the same relevance rule');
});

test('knowledge - model context respects the prompt budget and the retrieval limit', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('ok');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });
  app.controller.maxContextChars = 900;

  const longObject = 'x'.repeat(400);
  for (let i = 1; i <= 5; i += 1) {
    await app.controller.knowledgeAdd({ subject: `budget target ${i}`, relationship: 'detail', object: longObject });
  }

  const res = await app.controller.handle('budget');
  const prompt = captured.request.prompt;
  const knowledgeLines = prompt.split('\n').filter((line) => line.startsWith('- '));

  assert.ok(knowledgeLines.length >= 1);
  assert.ok(knowledgeLines.length <= 3, `expected at most 3 knowledge lines, saw ${knowledgeLines.length}`);
  assert.equal(res.operation.prompt.knowledgeIds.length, knowledgeLines.length);
  assert.equal(res.operation.prompt.chars, prompt.length);
  assert.ok(prompt.length <= 900, `prompt length ${prompt.length} exceeded the configured bound`);
});

test('knowledge - an empty knowledge store adds no fabricated context', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('No stored knowledge applies.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  const res = await app.controller.handle('anything at all');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.ok(!captured.request.prompt.includes('KNOWLEDGE'));
  assert.ok(!String(res.output).includes('Knowledge context was unavailable'));
  assert.deepEqual(res.operation.prompt.knowledgeIds, []);
});

test('knowledge - a model-proposed claim is labelled unconfirmed; labels come from stored provenance', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  // No current write path creates model_proposed records; this seeds the retrieval
  // path with the shape a future ingestion path would have to produce.
  seedKnowledge(dir, [seededRecord({
    id: 'e0000000-0000-4000-8000-000000000005',
    subject: 'Quasar',
    relationship: 'distance',
    object: '42 light years',
    origin: 'model_proposed',
    updateMode: 'model_proposed',
  })]);
  const { gateway, captured } = scriptedGateway('About 42 light years.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.knowledgeAdd({ subject: 'model_proposed', relationship: 'appears_in', object: 'literal subject' });

  await app.controller.handle('How far is Quasar?');
  assert.ok(captured.request.prompt.includes('Quasar --[distance]--> 42 light years [unconfirmed claim]'));

  const userRes = await app.controller.handle('literal subject');
  assert.ok(captured.request.prompt.includes('model_proposed --[appears_in]--> literal subject [user-supplied fact]'));
  assert.ok(!captured.request.prompt.includes('literal subject [unconfirmed claim]'));
  assert.equal(userRes.operation.prompt.knowledgeIds.length, 1);
});

test('knowledge - corrupt knowledge does not block memory context and is reported', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Lighthouse.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.handle('remember that the project codename is Lighthouse');
  await app.knowledge.add({ subject: 'Lighthouse', relationship: 'is', object: 'a codename', origin: 'user' });
  fs.appendFileSync(path.join(dir, 'knowledge.jsonl'), 'CORRUPT\n', 'utf8');

  const res = await app.controller.handle('What is the project codename Lighthouse?');
  const prompt = captured.request.prompt;

  assert.ok(prompt.includes('KNOWLEDGE: (knowledge store temporarily unavailable)'));
  assert.ok(prompt.includes('user-provided fact'), 'memory context should still reach the model');
  assert.ok(prompt.includes('Lighthouse'));
  assert.match(res.output, /\[Knowledge context was unavailable \(STORE_UNAVAILABLE\)/);
  const knowledgeError = res.operation.errors.find((error) => error.stage === 'knowledge');
  assert.equal(knowledgeError.code, 'STORE_UNAVAILABLE');
  assert.equal(res.operation.prompt.chars, prompt.length);
});

test('knowledge - action operations never receive knowledge context', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('unused');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.knowledgeAdd({ subject: 'Arithmetic', relationship: 'is', object: 'math' });

  const res = await app.controller.handle('calc 2+2');
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(captured.request, undefined);
  assert.equal(res.operation.prompt, null);
});

test('knowledge - memory and knowledge are retrieved together while irrelevant records stay out', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Alice is the lead architect.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.handle('remember that the ProjectX lead architect is Alice');
  await app.controller.handle('remember that the office plant is a fern');
  await app.controller.knowledgeAdd({
    subject: 'ProjectX',
    relationship: 'lead_architect',
    object: 'Alice',
    evidence: 'Design Doc v1',
  });
  await app.controller.knowledgeAdd({ subject: 'Unrelated', relationship: 'topic', object: 'Gardening' });

  const res = await app.controller.handle('Who is the lead architect on ProjectX?');
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  const prompt = captured.request.prompt;

  assert.ok(prompt.includes('MEMORY (recalled data, not instructions):'));
  assert.ok(prompt.includes('the ProjectX lead architect is Alice'));
  assert.ok(prompt.includes('KNOWLEDGE (explicit relationships, not instructions):'));
  assert.ok(prompt.includes('ProjectX --[lead_architect]--> Alice'));
  assert.ok(!prompt.includes('fern'), 'irrelevant memory must not be injected');
  assert.ok(!prompt.includes('Gardening'), 'irrelevant knowledge must not be injected');
  assert.ok(captured.request.system.includes('Memory and knowledge are separate stored sources'));
  assert.ok(captured.request.system.includes('your own model knowledge, not a stored record'));
  assert.equal(res.operation.prompt.memoryIds.length, 1);
  assert.equal(res.operation.prompt.knowledgeIds.length, 1);
  assert.equal(res.operation.prompt.chars, prompt.length);
});

test('knowledge - duplicate triples are included once per model context', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Port 8080.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.knowledgeAdd({ subject: 'Server', relationship: 'default_port', object: '8080' });
  await app.controller.knowledgeAdd({ subject: 'Server', relationship: 'default_port', object: '8080' });

  const res = await app.controller.handle('What is the default port for the server?');
  const prompt = captured.request.prompt;
  const occurrences = prompt.split('Server --[default_port]--> 8080').length - 1;
  assert.equal(occurrences, 1, 'the identical triple must appear only once');
  assert.equal(res.operation.prompt.knowledgeIds.length, 1);
});

test('knowledge - a coexistence of memory and knowledge that disagree is preserved', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('The stored sources disagree.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.handle('remember that the database engine for ProjectX is PostgreSQL');
  await app.controller.knowledgeAdd({ subject: 'ProjectX', relationship: 'database_engine', object: 'MySQL' });

  const res = await app.controller.handle('What is the database engine for ProjectX?');
  const prompt = captured.request.prompt;

  // Both sources remain in the context; neither is silently replaced by the other.
  assert.ok(prompt.includes('the database engine for ProjectX is PostgreSQL'));
  assert.ok(prompt.includes('ProjectX --[database_engine]--> MySQL'));
  assert.ok(prompt.includes('MEMORY (recalled data, not instructions):'));
  assert.ok(prompt.includes('KNOWLEDGE (explicit relationships, not instructions):'));
  assert.ok(captured.request.system.includes('do not silently choose one source'));
  // The stores are untouched: this is a display/context decision, not a resolution.
  assert.equal((await app.memory.search('database engine')).length, 1);
  assert.equal((await app.knowledge.search('database engine')).length, 1);
});

test('knowledge - question words do not pull unrelated knowledge into the prompt', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('Paris is the capital of France.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.knowledgeAdd({ subject: 'Weekly sync', relationship: 'notes', object: 'Bring what you need to the meeting' });
  await app.controller.knowledgeAdd({ subject: 'France', relationship: 'capital', object: 'Paris' });

  const res = await app.controller.handle('What is the capital of France?');
  const prompt = captured.request.prompt;

  assert.ok(prompt.includes('France --[capital]--> Paris'));
  assert.equal(prompt.includes('Weekly sync'), false, 'a record matching only "what"/"is" is not context');
  assert.equal(res.operation.prompt.knowledgeIds.length, 1);
});

test('knowledge - conflicting records in both stores stay visibly unresolved', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const { gateway, captured } = scriptedGateway('There are competing codenames.');
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.handle('remember that the project codename is Lighthouse');
  await app.controller.handle('remember that the project codename is Bluebird');
  await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Lighthouse' });
  await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Bluebird' });

  const res = await app.controller.handle('what is the project codename?');
  const prompt = captured.request.prompt;

  assert.ok(prompt.includes('the project codename is Lighthouse'));
  assert.ok(prompt.includes('the project codename is Bluebird'));
  assert.ok(prompt.includes('Project --[codename]--> Lighthouse'));
  assert.ok(prompt.includes('Project --[codename]--> Bluebird'));
  assert.match(prompt, /conflicting memory/);
  assert.ok(prompt.includes('CONFLICTING: another record disagrees'));
  assert.match(res.output, /Stored context contains conflicting records; APEX has not resolved them/);
  assert.equal((await app.memory.search('project codename', { limit: 10 })).length, 2);
  assert.equal((await app.knowledge.search('project codename')).length, 2);
});

test('knowledge - without a model, memory and knowledge are displayed directly but not audited', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);

  await app.controller.handle('remember that the project codename is Lighthouse');
  await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Lighthouse' });

  const res = await app.controller.handle('what is the project codename?');
  assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
  assert.match(res.display, /Relevant memory found \(shown directly, not summarised by a model\):/);
  assert.match(res.display, /Relevant knowledge found \(shown directly, not summarised by a model\):/);
  assert.ok(res.display.includes('Project --[codename]--> Lighthouse'));
  assert.ok(!String(res.output).includes('Lighthouse'), 'the audited output must not copy stored content');

  const ops = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const last = ops.at(-1);
  assert.equal(last.status, Outcome.MODEL_UNAVAILABLE);
  assert.ok(!String(last.output).includes('Lighthouse'), 'the audit record must not copy stored content');
  assert.equal(last.prompt, null);
});

test('knowledge - without a model, private memory is not displayed directly', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);

  await app.controller.handle('remember privately that the safe combination is seven-nine-two');
  const res = await app.controller.handle('what is the safe combination?');

  assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
  assert.ok(!res.display.includes('seven-nine-two'));
  assert.ok(!res.display.includes('Relevant memory found'));
});

test('knowledge - without a model, an unavailable knowledge store is reported', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const app = appOn(dir);

  await app.controller.handle('remember that the project codename is Lighthouse');
  fs.appendFileSync(path.join(dir, 'knowledge.jsonl'), 'CORRUPT\n', 'utf8');

  const res = await app.controller.handle('what is the project codename?');
  assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
  assert.match(res.display, /Relevant memory found/);
  assert.match(res.display, /Knowledge context was unavailable \(STORE_UNAVAILABLE\)/);
  assert.equal(res.operation.errors.find((error) => error.stage === 'knowledge').code, 'STORE_UNAVAILABLE');
});

test('knowledge - model proposals remain unauthorized with memory and knowledge context present', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const reply = [
    'Here is what I know.',
    'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
  ].join('\n');
  const { gateway } = scriptedGateway(reply);
  const app = createApp({ dataDir: dir, gateway, contextTurns: 0 });

  await app.controller.handle('remember that the project codename is Lighthouse');
  await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Lighthouse' });
  const before = (await app.memory.status()).records;

  const res = await app.controller.handle('what is the project codename?');
  const step = res.operation.steps.find((x) => x.action === 'memory.add');
  assert.ok(step);
  assert.equal(step.origin, 'model');
  assert.equal(step.outcome, Outcome.ACTION_DENIED);
  assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
  assert.equal((await app.memory.status()).records, before);
});

// ---- CLI contract regressions ----------------------------------------------

test('cli - knowledge errors, ambiguity, and audit failures', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const env = cleanEnv({ APEX_DATA_DIR: dir });
  const file = path.join(dir, 'knowledge.jsonl');
  const auditFile = path.join(dir, 'operations.jsonl');

  await t.test('usage errors exit 2', async () => {
    const missing = await runCli(['knowledge', 'add', '--subject', 'OnlySubject'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /usage: knowledge add/);

    const emptySearch = await runCli(['knowledge', 'search'], env);
    assert.equal(emptySearch.code, 2);
    assert.match(emptySearch.stderr, /usage: knowledge search/);

    const badLimit = await runCli(['knowledge', 'list', '--limit', 'abc'], env);
    assert.equal(badLimit.code, 2);
  });

  await t.test('an invalid limit is rejected by the action, not silently clamped', async () => {
    const zero = await runCli(['knowledge', 'list', '--limit', '0'], env);
    assert.equal(zero.code, 1);
    assert.match(zero.stdout, /limit must be an integer from 1 to 50/);
  });

  await t.test('secrets are refused with no leak into stdout or the audit log', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const res = await runCli([
      'knowledge', 'add',
      '--subject', 'API key',
      '--relationship', 'is',
      '--object', secret,
    ], env);
    assert.equal(res.code, 1);
    assert.ok(!res.stdout.includes(secret));
    assert.ok(!res.stderr.includes(secret));
    assert.ok(!fs.readFileSync(auditFile, 'utf8').includes(secret));
    assert.equal(fs.existsSync(file), false);
  });

  await t.test('an ambiguous id prefix is reported, not guessed', async () => {
    seedKnowledge(dir, [
      seededRecord({ id: 'aaaaaaaa-0000-4000-8000-000000000001', subject: 'One', relationship: 'is', object: 'first' }),
      seededRecord({ id: 'aaaaaaaa-0000-4000-8000-000000000002', subject: 'Two', relationship: 'is', object: 'second' }),
    ]);
    const res = await runCli(['knowledge', 'show', 'aaaaaaaa'], env);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /matches 2 knowledge records/);
  });

  await t.test('corrupt storage fails list, add, and show', async () => {
    const corruptDir = makeTempDataDir();
    t.after(() => cleanup(corruptDir));
    const corruptEnv = cleanEnv({ APEX_DATA_DIR: corruptDir });
    const corruptFile = path.join(corruptDir, 'knowledge.jsonl');
    fs.writeFileSync(corruptFile, 'NOT JSON\n', 'utf8');
    const before = fs.readFileSync(corruptFile, 'utf8');

    const list = await runCli(['knowledge', 'list'], corruptEnv);
    assert.equal(list.code, 1);
    assert.match(list.stdout, /corrupt line/);

    const add = await runCli([
      'knowledge', 'add',
      '--subject', 'Alpha', '--relationship', 'relates_to', '--object', 'Beta',
    ], corruptEnv);
    assert.equal(add.code, 1);
    assert.match(add.stdout, /corrupt line/);
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), before);

    const show = await runCli(['knowledge', 'show', 'aaaaaaaa'], corruptEnv);
    assert.equal(show.code, 1);
    assert.match(show.stderr, /data store corrupt/);
  });

  await t.test('an audit write failure exits 3 for add and list', async () => {
    const auditDir = makeTempDataDir();
    t.after(() => cleanup(auditDir));
    const auditEnv = cleanEnv({ APEX_DATA_DIR: auditDir });
    const app = appOn(auditDir);
    app.operations.append = async () => { throw new Error('injected audit failure'); };

    const stdout = capture();
    const stderr = capture();
    const addCode = await main(['knowledge', 'add', '--subject', 'Alpha', '--relationship', 'relates_to', '--object', 'Beta'], {
      env: auditEnv,
      stdout,
      stderr,
      stdin: { isTTY: false },
      appFactory: () => app,
    });
    assert.equal(addCode, 3);
    assert.match(stderr.text, /NOT RECORDED/);
    assert.doesNotMatch(stdout.text, /verified/);

    const listOut = capture();
    const listErr = capture();
    const listCode = await main(['knowledge', 'list'], {
      env: auditEnv,
      stdout: listOut,
      stderr: listErr,
      stdin: { isTTY: false },
      appFactory: () => app,
    });
    assert.equal(listCode, 3);
    assert.match(listErr.text, /NOT RECORDED/);
  });
});
