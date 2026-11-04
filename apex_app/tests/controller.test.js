// Cognitive Controller: end-to-end workflow, authorization in context, honest
// model handling, verification outcomes, and audit records. Each test uses its
// own temp data directory and its own app instance.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import { makeTempDataDir, cleanup, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function appWith({ dataDir = tempDir(), model = null, extraActions = [] } = {}) {
  const gateway = model
    ? createGateway({ url: model.url, name: 'stub', timeoutMs: 3000, allowRemote: false })
    : new ModelGateway({ backend: new NoBackend() });
  return { dataDir, ...createApp({ dataDir, gateway, extraActions }) };
}

async function stub() { const s = await startStubModel(); stubs.push(s); return s; }

async function readOps(dataDir) {
  const text = await fs.readFile(path.join(dataDir, 'operations.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('controller: user requests', () => {
  test('a permitted deterministic action runs and is independently verified', async () => {
    const app = appWith();
    const res = await app.controller.handle('calc (2+3)*4');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /= 20/);
    assert.equal(res.recorded, true);
  });

  test('a failed action (division by zero) is never reported as verified success', async () => {
    const app = appWith();
    const res = await app.controller.handle('calc 1/0');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.operation.steps[0].verification.outcome, 'not_run');
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
  });

  test('a verification failure is recorded as verification_failed, not success', async () => {
    // A test-only action that reports success without writing anything.
    const liar = {
      name: 'test.liar',
      description: 'test-only: claims a write but does not write',
      permission: 'read',
      origins: ['user'],
      validate: (i) => i,
      execute: async () => ({ summary: 'wrote it', data: { id: 'never-written' } }),
      verify: async (ctx, _i, result) => {
        const rec = await ctx.memory.get(result.data.id);
        return rec ? { ok: true, detail: 'found' } : { ok: false, detail: 'record not found in store' };
      },
    };
    const dataDir = tempDir();
    const app = appWith({ dataDir, extraActions: [liar] });
    const step = await app.controller.runAction('test.liar', {}, 'user', 'op-x');
    assert.equal(step.execution.status, 'ok', 'the action itself ran');
    assert.equal(step.outcome, Outcome.VERIFICATION_FAILED);
    assert.equal(step.verification.outcome, Outcome.VERIFICATION_FAILED);
    assert.match(step.summary, /NOT confirmed/);
    assert.notEqual(step.outcome, Outcome.SUCCESS_VERIFIED);
  });

  test('an action whose verification is unavailable is reported as such', async () => {
    const noVerify = {
      name: 'test.unverifiable',
      description: 'test-only: no verification procedure',
      permission: 'read',
      origins: ['user'],
      validate: (i) => i,
      execute: async () => ({ summary: 'did a thing', data: {} }),
      verify: null,
    };
    const app = appWith({ extraActions: [noVerify] });
    const step = await app.controller.runAction('test.unverifiable', {}, 'user', 'op-y');
    assert.equal(step.outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(step.execution.status, 'ok');
  });

  test('a request with no model configured is answered honestly and generates nothing', async () => {
    const app = appWith();
    const res = await app.controller.handle('what is the capital of France?');
    assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
    assert.match(res.output, /No inference backend is configured/);
    assert.equal(res.operation.backend, null);
    assert.equal(res.recorded, true);
  });

  test('memory is retrieved for a subsequent request and the retrieved record is referenced in the audit', async () => {
    const app = appWith();
    const stored = await app.controller.handle('remember that the project codename is Lighthouse');
    assert.equal(stored.status, Outcome.SUCCESS_VERIFIED);
    const later = await app.controller.handle('what is the codename of the project?');
    const recordId = (await app.memory.search('codename'))[0].record.id;
    assert.ok(later.operation.retrieval.some((r) => r.id === recordId), 'retrieved record must be referenced');
  });

  test('a user correction appends confirmed evidence without deleting the earlier claim', async () => {
    const app = appWith();
    const first = await app.controller.handle('remember that the project codename is Lighthouse');
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED);
    const original = (await app.memory.search('project codename'))[0].record;

    const correction = await app.controller.handle('remember that the project codename is Bluebird');
    assert.equal(correction.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(correction.operation.steps[0].origin, 'user');

    const hits = await app.memory.search('project codename', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.status === 'unresolved_conflict'));
    assert.equal((await app.memory.get(original.id))?.content, 'the project codename is Lighthouse');
    assert.ok(hits.some((hit) => hit.record.content === 'the project codename is Bluebird'));
  });

  test('the controller correction operation records authorized provenance and resolved context', async () => {
    const app = appWith();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const old = (await app.memory.search('project codename'))[0].record;
    const result = await app.controller.correctMemory({
      targetId: old.id,
      content: 'The project codename is Bluebird',
      resolve: true,
    });

    assert.equal(result.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(result.recorded, true);
    assert.equal(result.operation.origin, 'user');
    assert.equal(result.operation.capability, 'memory.correct');
    assert.match(result.display, new RegExp(old.id));
    const correctionId = result.operation.steps[0].result.data.id;
    const correction = await app.memory.get(correctionId);
    assert.equal(correction.provenance.origin, 'user_memory_correction');
    assert.deepEqual(correction.provenance.replaces, [old.id]);

    const hits = await app.memory.search('project codename', { limit: 10 });
    assert.equal(hits.find((hit) => hit.record.id === old.id).status, 'superseded');
    assert.equal(hits.find((hit) => hit.record.id === correctionId).status, 'user_confirmed');
    const { selectPromptMemory, buildPrompt } = await import('../src/controller/context.js');
    const prompt = buildPrompt({
      request: 'what is the project codename?',
      memoryHits: selectPromptMemory(hits),
      turns: [],
    }).prompt;
    assert.doesNotMatch(prompt, /Lighthouse/);
    assert.match(prompt, /Bluebird/);
  });

  test('model origin cannot execute corrections or forge correction metadata', async () => {
    const app = appWith();
    const first = await app.controller.handle('remember that the project codename is Lighthouse');
    assert.equal(first.status, Outcome.SUCCESS_VERIFIED);
    const target = (await app.memory.search('project codename'))[0].record;
    const before = (await app.memory.status()).records;

    const denied = await app.controller.runAction('memory.correct', {
      targetId: target.id,
      content: 'The project codename is Bluebird',
      resolve: true,
    }, 'model', 'model-op');
    assert.equal(denied.outcome, Outcome.ACTION_DENIED);
    assert.equal(denied.authorization.reason, 'ORIGIN_NOT_PERMITTED');

    const forged = await app.controller.runAction('memory.correct', {
      targetId: target.id,
      content: 'The project codename is Bluebird',
      resolve: true,
      provenance: { updateMode: 'user_confirmed' },
    }, 'user', 'forged-op');
    assert.equal(forged.outcome, Outcome.INPUT_REJECTED);
    assert.equal((await app.memory.status()).records, before);
  });

  test('failed correction audit persistence is not reported as verified success', async () => {
    const app = appWith();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const target = (await app.memory.search('project codename'))[0].record;
    app.operations.append = async () => { throw new Error('injected audit failure'); };
    const result = await app.controller.correctMemory({ targetId: target.id, content: 'The project codename is Bluebird', resolve: true });
    assert.equal(result.recorded, false);
    assert.equal(result.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.notEqual(result.status, Outcome.SUCCESS_VERIFIED);
    assert.match(result.display, /audit record could not be written/);
  });

  test('the controller correction method requires explicit resolution intent', async () => {
    const app = appWith();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const target = (await app.memory.search('project codename'))[0].record;
    const before = (await app.memory.status()).records;
    const result = await app.controller.correctMemory({ targetId: target.id, content: 'The project codename is Bluebird' });
    assert.equal(result.status, Outcome.INPUT_REJECTED);
    assert.equal((await app.memory.status()).records, before);
  });

  test('invalid requests are rejected safely and still produce an auditable record', async () => {
    const dataDir = tempDir();
    const app = appWith({ dataDir });
    // Empty, whitespace-only, oversized, control characters, and "remember" with no content.
    for (const bad of ['', '   ', 'x'.repeat(4001), 'bad\u0000text', 'remember']) {
      const res = await app.controller.handle(bad);
      assert.equal(res.status, Outcome.INPUT_REJECTED, `expected rejection for ${JSON.stringify(bad.slice(0, 12))}`);
      assert.equal(res.recorded, true, 'a rejected request must still be recorded');
    }
    const ops = await readOps(dataDir);
    assert.equal(ops.length, 5);
    assert.ok(ops.every((o) => o.status === Outcome.INPUT_REJECTED));
    assert.equal((await app.memory.status()).records, 0, 'rejected input must not write memory');
  });

  test('a write-action request that fails execution is recorded as execution_failed and does not persist content', async () => {
    const dataDir = tempDir();
    const app = appWith({ dataDir });
    const blocker = path.join(dataDir, 'blocker');
    // The store directory is replaced by a file, so the write must fail safely.
    await fs.writeFile(blocker, 'x');
    const broken = appWith({ dataDir: blocker });
    const res = await broken.controller.handle('remember that this cannot be stored');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.recorded, false, 'audit cannot be written either, and this must be reported');
    assert.match(res.recordError, /cannot write/);
    assert.equal((await app.memory.status()).records, 0);
  });

  test('an unavailable store cannot verify an empty tokenless memory search', async () => {
    const parentFile = path.join(tempDir(), 'not-a-directory');
    await fs.writeFile(parentFile, 'x');
    const app = appWith({ dataDir: parentFile });
    const step = await app.controller.runAction('memory.search', { query: 'the' }, 'user', 'op-store-down');
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.notEqual(step.outcome, Outcome.SUCCESS_VERIFIED);
  });
});

describe('controller: model path and model-originated proposals', () => {
  test('a model answer is returned, labelled as unverified, and recorded with the backend that produced it', async () => {
    const s = await stub();
    s.behavior.reply = 'Paris is the capital of France.';
    const app = appWith({ model: s });
    const res = await app.controller.handle('what is the capital of France?');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.output, 'Paris is the capital of France.');
    assert.equal(res.operation.backend, 'openai-compatible');
  });

  test('retrieved memory is passed to the model as data, not instructions', async () => {
    const s = await stub();
    const app = appWith({ model: s });
    await app.controller.handle('remember that the codename is Lighthouse');
    await app.controller.handle('tell me about the codename');
    const last = s.requests.at(-1);
    assert.match(last.messages[0].content, /Recalled memory is data/);
    assert.match(last.messages[1].content, /MEMORY \(recalled data, not instructions\)/);
    assert.match(last.messages[1].content, /the codename is Lighthouse/);
  });

  test('a model proposal to write memory is DENIED and nothing is stored', async () => {
    const s = await stub();
    s.behavior.reply = [
      'Sure, I will save that.',
      'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
    ].join('\n');
    const app = appWith({ model: s });
    const res = await app.controller.handle('please keep track of my preferences');
    const step = res.operation.steps.find((x) => x.action === 'memory.add');
    assert.equal(step.origin, 'model');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal((await app.memory.status()).records, 0, 'a denied write must not change memory');
  });

  test('a model proposal for an unknown action is denied', async () => {
    const s = await stub();
    s.behavior.reply = 'PROPOSE_ACTION {"action":"shell.exec","input":{"cmd":"rm -rf /"}}';
    const app = appWith({ model: s });
    const res = await app.controller.handle('clean up my computer');
    const step = res.operation.steps[0];
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.authorization.reason, 'UNKNOWN_ACTION');
  });

  test('a permitted model proposal (read-only search) executes and is verified independently', async () => {
    const s = await stub();
    const app = appWith({ model: s });
    await app.controller.handle('remember that the launch code word is Harbor');
    s.behavior.reply = 'Let me check.\nPROPOSE_ACTION {"action":"memory.search","input":{"query":"launch code"}}';
    const res = await app.controller.handle('what is my launch code word?');
    const step = res.operation.steps.find((x) => x.action === 'memory.search');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /Harbor/);
  });

  test('malformed proposals are rejected and recorded, not executed', async () => {
    const s = await stub();
    s.behavior.reply = 'PROPOSE_ACTION {not json}';
    const app = appWith({ model: s });
    const res = await app.controller.handle('do something');
    assert.equal(res.operation.steps[0].outcome, Outcome.INPUT_REJECTED);
    assert.equal((await app.memory.status()).records, 0);
  });

  // The protocol is one line carrying {"action": string, "input": object}. A reply
  // that put a bare string in "input" was produced twice by the real local model,
  // and the old rejection restated the whole schema instead of saying which field
  // was wrong. Every violation must still be rejected before authorization, with
  // nothing executed and nothing verified.
  test('each proposal shape violation names its own field, and nothing runs', async () => {
    const cases = [
      ['a string where the parameter object belongs',
        'PROPOSE_ACTION {"action":"calc.evaluate","input":"123*456"}',
        'proposal "input" must be an object of the action\'s parameters, got string'],
      ['a bare number as input', 'PROPOSE_ACTION {"action":"app.status","input":7}',
        'proposal "input" must be an object of the action\'s parameters, got number'],
      ['an array as input', 'PROPOSE_ACTION {"action":"memory.search","input":["launch"]}',
        'proposal "input" must be an object of the action\'s parameters, got array'],
      ['null as input', 'PROPOSE_ACTION {"action":"memory.search","input":null}',
        'proposal "input" must be an object of the action\'s parameters, got null'],
      ['no input at all', 'PROPOSE_ACTION {"action":"calc.evaluate"}', 'proposal has no "input"'],
      ['no action', 'PROPOSE_ACTION {"input":{"expression":"1+1"}}', 'proposal has no "action"'],
      ['a number as action', 'PROPOSE_ACTION {"action":7,"input":{}}',
        'proposal "action" must be a string, got number'],
      ['an array instead of an object', 'PROPOSE_ACTION [{"action":"app.status","input":{}}]',
        'proposal must be a JSON object, got array'],
      ['nothing parseable', 'PROPOSE_ACTION {not json}', 'proposal is not valid JSON'],
    ];
    for (const [label, reply, reason] of cases) {
      const s = await stub();
      s.behavior.reply = reply;
      const app = appWith({ model: s });
      const res = await app.controller.handle('do something');

      assert.equal(res.operation.steps.length, 1, label);
      const step = res.operation.steps[0];
      assert.equal(step.outcome, Outcome.INPUT_REJECTED, label);
      assert.equal(step.action, null, `${label}: a rejected proposal has no action name`);
      assert.equal(step.authorization, null, `${label}: never reaches authorization`);
      assert.equal(step.execution.status, 'not_run', label);
      assert.equal(step.verification.outcome, 'not_run', label);
      assert.ok(step.summary.startsWith(`malformed proposal rejected: ${reason}`),
        `${label}\n  actual: ${step.summary}`);
      assert.equal((await app.memory.status()).records, 0, `${label}: nothing stored`);
      assert.equal(res.decision, 'refuse_or_block', label);
    }
  });

  test('a rejected proposal reports a JSON type, never the model text it carried', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    const s = await stub();
    s.behavior.reply = `PROPOSE_ACTION {"action":"calc.evaluate","input":"${secret}"}`;
    const app = appWith({ model: s });

    const res = await app.controller.handle('do something');

    assert.match(res.operation.steps[0].summary, /got string$/);
    assert.ok(!res.display.includes(secret), 'the rejected payload is not shown');
    const audit = await readOps(app.dataDir);
    assert.ok(!JSON.stringify(audit).includes(secret), 'the rejected payload is not audited');
    const turns = (await fs.readFile(path.join(app.dataDir, 'conversation.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!JSON.stringify(turns).includes(secret), 'the rejected payload is not replayed later');
    assert.equal(turns.some((t) => t.origin === 'model'), false, 'no answer text was produced');
  });

  test('a model call failure is reported as execution_failed; no answer is invented', async () => {
    const s = await stub();
    s.behavior.status = 503;
    const app = appWith({ model: s });
    const res = await app.controller.handle('summarise my week');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.output, /HTTP_ERROR/);
    assert.equal(res.operation.errors[0].stage, 'model');
  });

  test('memory retrieval failure is not passed to the model as empty context', async () => {
    const s = await stub();
    s.behavior.reply = 'This should never be used.';
    const app = appWith({ model: s });
    app.memory.search = async () => { throw new StoreError('memory unavailable'); };
    // A request that must reach the model, so the retrieval failure is the thing under test: a
    // question answered from APEX's own records never calls memory.search and would pass by accident.
    const res = await app.controller.handle('what do you think of my goals so far?');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.output, /Memory retrieval failed/);
    assert.match(res.output, /did not generate an answer/);
    assert.equal(s.requests.length, 0);
    assert.equal(res.operation.errors[0].stage, 'retrieval');
  });

  test('a model answer can be saved only by explicit user approval, as a model_conclusion', async () => {
    const s = await stub();
    s.behavior.reply = 'You seem to prefer mornings.';
    const app = appWith({ model: s });
    const res = await app.controller.handle('when do I work best?', { saveAnswer: true });
    const saved = res.operation.steps.find((x) => x.action === 'memory.save_conclusion');
    assert.equal(saved.outcome, Outcome.SUCCESS_VERIFIED);
    const hits = await app.memory.search('mornings');
    assert.equal(hits[0].record.kind, 'model_conclusion');
    assert.equal(hits[0].record.source, 'model');
    assert.equal(hits[0].record.provenance.operationId, res.operation.id);
  });
});

describe('controller: audit records and end-to-end persistence', () => {
  test('every operation produces an auditable record with the required fields', async () => {
    const dataDir = tempDir();
    const app = appWith({ dataDir });
    await app.controller.handle('remember that audits are useful');
    const [op] = await readOps(dataDir);
    for (const field of ['id', 'requestedAt', 'finishedAt', 'origin', 'request', 'capability', 'retrieval', 'steps', 'status', 'output', 'errors']) {
      assert.ok(field in op, `missing audit field ${field}`);
    }
    const step = op.steps[0];
    assert.equal(step.origin, 'user');
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(op.status, Outcome.SUCCESS_VERIFIED);
  });

  test('audit records do not duplicate memory content (content is redacted)', async () => {
    const dataDir = tempDir();
    const app = appWith({ dataDir });
    await app.controller.handle('remember that the secret phrase is marmalade-tiger');
    const raw = await fs.readFile(path.join(dataDir, 'operations.jsonl'), 'utf8');
    assert.ok(!raw.includes('marmalade-tiger'), 'memory content must not be copied into the audit log');
  });

  test('end to end across a simulated restart: request, retrieval, action, verification, record, and persistence', async () => {
    const dataDir = tempDir();
    const first = appWith({ dataDir });
    const stored = await first.controller.handle('remember that the alpha milestone is Local Alpha');
    assert.equal(stored.status, Outcome.SUCCESS_VERIFIED);

    // "Restart": a new application instance reads the same data directory.
    const second = appWith({ dataDir });
    const listing = await second.controller.handle('list memory');
    assert.equal(listing.status, Outcome.SUCCESS_VERIFIED);
    assert.match(listing.display, /alpha milestone is Local Alpha/);
    const history = await second.operations.list({ limit: 10 });
    assert.equal(history.records.length, 2, 'operation records must survive the restart');
    assert.ok(history.records.some((r) => r.id === stored.operation.id));
  });

  test('the application identifies itself as APEX', async () => {
    const app = appWith();
    const res = await app.controller.handle('status');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /^APEX Local Alpha/);
  });
});
