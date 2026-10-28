// Controller decision integration: ANSWER, CLARIFY, PROPOSE_ACTION, and
// REFUSE_OR_BLOCK are decided from recorded outcomes, while retrieval,
// authorization, execution, verification, and audit keep their existing paths.
// Every test uses its own temp data directory. The model is a local stub.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';
import { MAX_CONTEXT_CHARS } from '../src/controller/context.js';
import { StoreError } from '../src/errors.js';
import { makeTempDataDir, cleanup, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function appWith({ dataDir = tempDir(), model = null } = {}) {
  const gateway = model
    ? createGateway({ url: model.url, name: 'stub', timeoutMs: 3000, retries: 0, allowRemote: false })
    : new ModelGateway({ backend: new NoBackend() });
  return { dataDir, ...createApp({ dataDir, gateway }) };
}

async function stub(reply = 'stub answer') {
  const s = await startStubModel();
  s.behavior.reply = reply;
  stubs.push(s);
  return s;
}

const lastPrompt = (s) => s.requests.at(-1).messages.at(-1).content;
const lastSystem = (s) => s.requests.at(-1).messages[0].content;

describe('decision: answer with evidence', () => {
  test('relevant memory and knowledge are used and stay labelled by provenance', async () => {
    const s = await stub('The meeting room is B-204 and the engine fuel is Diesel.');
    const app = appWith({ model: s });
    await app.controller.handle('remember that the meeting room is B-204');
    const added = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Diesel' });
    assert.equal(added.status, Outcome.SUCCESS_VERIFIED);

    const res = await app.controller.handle('where is the meeting room and what fuel does the engine use?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.ok(res.operation.prompt.memoryIds.length >= 1, 'the stored fact is in the prompt');
    assert.ok(res.operation.prompt.knowledgeIds.length >= 1, 'the stored triple is in the prompt');
    assert.ok(res.operation.prompt.chars <= MAX_CONTEXT_CHARS, 'the prompt stays within its budget');

    const prompt = lastPrompt(s);
    assert.match(prompt, /user-provided fact/);
    assert.match(prompt, /user-supplied fact/);
    assert.match(prompt, /B-204/);
    assert.match(prompt, /Diesel/);
    // The model is told that unprompted knowledge is its own, not a stored record.
    assert.match(lastSystem(s), /your own model knowledge, not a stored record/);
  });

  test('a request with no relevant evidence is answered without inventing a store record', async () => {
    const s = await stub('Paris is the capital of France.');
    const app = appWith({ model: s });
    const res = await app.controller.handle('what is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(res.operation.prompt.memoryIds.length, 0);
    assert.equal(res.operation.prompt.knowledgeIds.length, 0);
    assert.equal(res.operation.retrieval.length, 0);
    assert.notEqual(res.decision, Decision.CLARIFY, 'an answerable question is not sent to clarification');

    const prompt = lastPrompt(s);
    assert.match(prompt, /\(no relevant memory found\)/);
    assert.doesNotMatch(prompt, /KNOWLEDGE \(explicit relationships/);
  });

  test('conflicting stored claims remain visible and unresolved', async () => {
    const s = await stub('I cannot tell which fuel claim is correct.');
    const app = appWith({ model: s });
    await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Diesel' });
    const second = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Petrol' });
    assert.equal(second.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(second.operation.steps[0].result.data.conflictingIds.length, 1, 'the conflict is detected at write time');

    const res = await app.controller.handle('what fuel does the engine use?');

    assert.equal(res.decision, Decision.ANSWER);
    assert.match(res.output, /\[Stored context contains conflicting records; APEX has not resolved them\.\]/);
    assert.match(lastPrompt(s), /CONFLICTING/);

    const stored = await app.knowledge.search('engine');
    assert.equal(stored.length, 2);
    for (const hit of stored) {
      assert.equal(hit.record.status, 'conflicting');
      assert.equal(hit.record.conflictsWith.length, 1, 'both claims are kept, neither is chosen by recency');
    }
  });
});

describe('decision: clarify only when information is missing', () => {
  test('a memory lookup with no topic asks instead of searching or calling a model', async () => {
    const s = await stub('This should never be called.');
    const app = appWith({ model: s });
    let searches = 0;
    const original = app.memory.search.bind(app.memory);
    app.memory.search = async (...args) => { searches += 1; return original(...args); };

    for (const request of ['recall', 'search memory', 'what do you remember about?']) {
      const res = await app.controller.handle(request);
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED, request);
      assert.equal(res.decision, Decision.CLARIFY, request);
      assert.match(res.display, /What topic should I search your memory for\?/);
      assert.equal(res.operation.steps.length, 0);
      assert.equal(res.recorded, true);
    }
    assert.equal(searches, 0, 'no lookup runs without a topic');
    assert.equal(s.requests.length, 0, 'no model is asked to guess');
  });

  test('a file request with no target asks for a path', async () => {
    const s = await stub('This should never be called.');
    const app = appWith({ model: s });
    for (const request of ['read it', 'open the file', 'list the folder']) {
      const res = await app.controller.handle(request);
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED, request);
      assert.equal(res.decision, Decision.CLARIFY, request);
      assert.match(res.display, /Which file or directory do you mean\?/);
    }
    assert.equal(s.requests.length, 0);
  });

  test('a content-free follow-up asks when there is no conversation context', async () => {
    const s = await stub('Okay.');
    const app = appWith({ model: s });
    const res = await app.controller.handle('continue');
    assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(res.decision, Decision.CLARIFY);
    assert.match(res.display, /What would you like APEX to do\?/);
    assert.equal(s.requests.length, 0);
  });

  test('a follow-up is not clarified when earlier turns exist', async () => {
    const s = await stub('Here is the summary of the prior step.');
    const app = appWith({ model: s });
    await app.controller.handle('calc 2+2');
    const res = await app.controller.handle('continue');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 1);
  });
});

describe('decision: proposals through the existing workflow', () => {
  test('a verified model-originated read proposal is reported as a proposal', async () => {
    const s = await stub();
    const app = appWith({ model: s });
    await app.controller.handle('remember that the launch code word is Harbor');
    s.behavior.reply = 'Let me check.\nPROPOSE_ACTION {"action":"memory.search","input":{"query":"launch code"}}';

    const res = await app.controller.handle('what is my launch code word?');

    const step = res.operation.steps.find((x) => x.action === 'memory.search');
    assert.equal(step.origin, 'model');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(res.decision, Decision.PROPOSE_ACTION);
    assert.match(res.display, /Harbor/);
  });

  test('a deterministic multi-step plan is a proposal until the user runs it', async () => {
    const app = appWith();
    const res = await app.controller.planTask('calc 2+2; calc 3+3');
    assert.equal(res.status, Outcome.PLAN_CREATED);
    assert.equal(res.decision, Decision.PROPOSE_ACTION);
    assert.match(res.display, /Nothing has run yet/);
  });
});

describe('decision: refuse or block', () => {
  test('a model proposal to write memory is denied and a claim of success is contradicted', async () => {
    const s = await stub([
      'Done - I saved that to memory.',
      'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
    ].join('\n'));
    const app = appWith({ model: s });

    const res = await app.controller.handle('please keep track of my preferences');

    const step = res.operation.steps.find((x) => x.action === 'memory.add');
    assert.equal(step.origin, 'model');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.output, /\[APEX did not execute a proposed action: denied /);
    assert.equal((await app.memory.status()).records, 0, 'a denied write changes nothing');
  });

  test('an unsupported destructive request is refused before any lookup or model call', async () => {
    const s = await stub('This should never be called.');
    const app = appWith({ model: s });
    let searches = 0;
    app.memory.search = async () => { searches += 1; return []; };

    const res = await app.controller.handle('rm -rf /');

    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(res.operation.capability, 'none');
    assert.match(res.display, /nothing was executed/i);
    assert.equal(searches, 0);
    assert.equal(s.requests.length, 0);
  });

  test('unavailable memory is not treated as empty context', async () => {
    const s = await stub('This should never be used.');
    const app = appWith({ model: s });
    app.memory.search = async () => { throw new StoreError('memory unavailable'); };

    const res = await app.controller.handle('what is the capital of France?');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(res.output, /Memory retrieval failed \(STORE_UNAVAILABLE\)/);
    assert.equal(s.requests.length, 0, 'the model is not asked to answer without checked context');
  });

  test('unavailable knowledge is reported without blocking the answer or the decision', async () => {
    const s = await stub('Paris is the capital of France.');
    const app = appWith({ model: s });
    app.knowledge.search = async () => { throw new StoreError('knowledge unavailable'); };

    const res = await app.controller.handle('what is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.match(res.output, /\[Knowledge context was unavailable \(STORE_UNAVAILABLE\)/);
    assert.ok(res.operation.errors.some((e) => e.stage === 'knowledge'));
  });

  test('an audit write failure is reported as unrecorded, not silently verified', async () => {
    const app = appWith();
    app.operations.append = async () => { throw new Error('injected audit failure'); };

    const res = await app.controller.handle('calc 2+2');

    // The existing contract keeps the visible result and reports recorded=false,
    // so the audit gap is distinguishable from a verified, recorded operation.
    assert.equal(res.recorded, false);
    assert.ok(res.recordError);
    assert.match(res.display, /2\+2 = 4/);
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
  });

  test('a failed knowledge audit is also reported as audit_integrity_failed', async () => {
    const app = appWith();
    app.operations.append = async () => { throw new Error('injected audit failure'); };

    const res = await app.controller.knowledgeAdd({ subject: 'Alpha', relationship: 'leads_to', object: 'Beta' });

    assert.equal(res.recorded, false);
    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(res.output, /could not be written/);
  });
});
