import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, validateKnowledgeRecord } from '../src/knowledge/knowledge-store.js';
import { knowledgeActions } from '../src/actions/knowledge-actions.js';
import { Outcome } from '../src/outcomes.js';
import { ModelGateway } from '../src/model/gateway.js';

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
});
