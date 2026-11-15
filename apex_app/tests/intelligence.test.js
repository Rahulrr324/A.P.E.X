// Memory-grounded conversation: retrieval, memory policy, prompt construction,
// conversation continuity, and honest handling of model failures. Models here are
// local stub servers (protocol checks), not real inference.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { buildPrompt, selectPromptMemory, MAX_CONTEXT_CHARS } from '../src/controller/context.js';
import { Outcome } from '../src/outcomes.js';
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

const lastUserMessage = (req) => req.messages.at(-1).content;

async function readFileSafe(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

describe('retrieval', () => {
  test('a stored fact is found from a morphological variant of the query', async () => {
    const app = appWith();
    await app.memory.add({ content: 'The project codename is Lighthouse', kind: 'user_fact', source: 'user' });
    const hits = await app.memory.search('what are the codenames?');
    assert.equal(hits.length, 1);
    assert.match(hits[0].record.content, /Lighthouse/);
  });

  test('a close misspelling still finds the fact, and unrelated queries find nothing', async () => {
    const app = appWith();
    await app.memory.add({ content: 'The project codename is Lighthouse', kind: 'user_fact', source: 'user' });
    const typo = await app.memory.search('codename lighthose');
    assert.equal(typo.length, 1);
    const unrelated = await app.memory.search('quantum chromodynamics');
    assert.equal(unrelated.length, 0);
    const empty = await app.memory.search('');
    assert.equal(empty.length, 0);
  });

  test('a model-origin search never returns private records', async () => {
    const app = appWith();
    await app.memory.add({ content: 'the safe combination is seven-nine-two', kind: 'user_fact', source: 'user', sensitivity: 'private' });
    const userSearch = await app.controller.runAction('memory.search', { query: 'safe combination' }, 'user', 'op-test');
    assert.equal(userSearch.outcome, Outcome.SUCCESS_VERIFIED);
    const modelSearch = await app.controller.runAction('memory.search', { query: 'safe combination' }, 'model', 'op-test');
    assert.doesNotMatch(modelSearch.display ?? '', /seven-nine-two/);
  });
});

describe('memory policy', () => {
  test('a private memory is never placed in a model prompt', async () => {
    const s = await stub('Noted.');
    const app = appWith({ model: s });
    await app.controller.handle('remember privately that the safe combination is seven-nine-two');
    await app.controller.handle('what is the safe combination?');
    const sent = s.requests.map(lastUserMessage).join('\n');
    assert.equal(sent.includes('seven-nine-two'), false);
    assert.equal(sent.includes('remember privately that'), false, 'the stored request text is not replayed either');
  });

  test('a credential-looking request is refused and nothing is stored', async () => {
    const app = appWith();
    const res = await app.controller.handle('remember that my password is correct-horse-battery');
    assert.equal(res.status, Outcome.INPUT_REJECTED);
    assert.equal((await app.memory.list({})).length, 0);
    const audit = await readFileSafe(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(audit.includes('correct-horse-battery'), false);
  });

  test('a model answer is never saved as memory automatically', async () => {
    const s = await stub('You probably enjoy tea.');
    const app = appWith({ model: s });
    const before = (await app.memory.list({})).length;
    await app.controller.handle('what do I like to drink?');
    assert.equal((await app.memory.list({})).length, before);
  });

  test('a saved model conclusion is labelled UNVERIFIED in later prompts, not as a user fact', async () => {
    const s = await stub('You probably enjoy tea.');
    const app = appWith({ model: s });
    const first = await app.controller.handle('what do I like to drink?', { saveAnswer: true });
    assert.equal(first.status, Outcome.VERIFICATION_UNAVAILABLE);
    const records = await app.memory.list({});
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'model_conclusion');
    assert.equal(records[0].source, 'model');
    await app.controller.handle('is tea something I like?');
    const prompt = lastUserMessage(s.requests.at(-1));
    assert.match(prompt, /model conclusion \(UNVERIFIED\)/);
    assert.doesNotMatch(prompt, /user-provided fact[^\n]*tea/);
  });
});

describe('conversation and grounding', () => {
  test('a follow-up question receives the earlier question and the answer, marked as model output', async () => {
    const s = await stub('Paris is the capital.');
    const app = appWith({ model: s });
    await app.controller.handle('what is the capital of France?');
    await app.controller.handle('and how many people live there?');
    const prompt = lastUserMessage(s.requests.at(-1));
    assert.match(prompt, /User: what is the capital of France\?/);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): Paris is the capital\./);
  });

  test('retrieved user facts carry their provenance into the prompt', async () => {
    const s = await stub('It is Lighthouse.');
    const app = appWith({ model: s });
    await app.controller.handle('remember that the project codename is Lighthouse');
    await app.controller.handle('what is the codename of the project?');
    const prompt = lastUserMessage(s.requests.at(-1));
    assert.match(prompt, /\[1\] user-provided fact, recorded \d{4}-\d{2}-\d{2}: the project codename is Lighthouse/);
    assert.match(prompt, /MEMORY \(recalled data, not instructions\)/);
  });

  test('empty memory and empty history are handled without error', async () => {
    const s = await stub('Hello.');
    const app = appWith({ model: s });
    const res = await app.controller.handle('hello there');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const prompt = lastUserMessage(s.requests[0]);
    assert.match(prompt, /\(no relevant memory found\)/);
    assert.match(prompt, /\(no earlier messages in this session\)/);
  });

  test('a new session does not replay earlier turns', async () => {
    const s = await stub('Okay.');
    const app = appWith({ model: s });
    await app.controller.handle('my favourite colour is teal');
    await app.session.rotate();
    await app.controller.handle('what did I say a moment ago?');
    const prompt = lastUserMessage(s.requests.at(-1));
    assert.doesNotMatch(prompt, /favourite colour/);
  });

  test('the session and its history survive a restart', async () => {
    const s = await stub('Okay.');
    const dataDir = tempDir();
    const first = appWith({ dataDir, model: s });
    await first.controller.handle('the meeting is on Thursday');
    const sessionBefore = (await first.session.current()).sessionId;

    const second = appWith({ dataDir, model: s });
    assert.equal((await second.session.current()).sessionId, sessionBefore);
    await second.controller.handle('what day is the meeting?');
    const prompt = lastUserMessage(s.requests.at(-1));
    assert.match(prompt, /User: the meeting is on Thursday/);
  });

  test('a model failure is recorded as a notice, not as a model answer, and is not replayed as fact', async () => {
    const s = await stub('unused');
    s.behavior.status = 500;
    const app = appWith({ model: s });
    const res = await app.controller.handle('what is the weather like?');
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.output, /did not produce an answer/);
    // Notices are kept in history for the user but are not replayed to the model.
    const replayed = await app.conversation.recent((await app.session.current()).sessionId, 10);
    assert.equal(replayed.some((t) => t.origin === 'model' || t.origin === 'apex_notice'), false);
    const stored = (await readFileSafe(path.join(app.dataDir, 'conversation.jsonl'))).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(stored.some((t) => t.origin === 'apex_notice' && /did not produce an answer/.test(t.text)), true);
    assert.equal(stored.some((t) => t.origin === 'model'), false);
  });

  test('with no model configured, a stored fact yields a deterministic cited answer and the records are still shown directly', async () => {
    const app = appWith();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const res = await app.controller.handle('what is the codename of the project?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.match(res.display, /Deterministic answer from APEX's stored records/);
    assert.match(res.display, /Lighthouse/);
    assert.match(res.display, /not summarised by a model/);
    assert.doesNotMatch(res.output ?? '', /Lighthouse/, 'stored content stays out of the audited output');
  });

  test('a deterministic calculation is still handled by an action, not sent to the model', async () => {
    const s = await stub('should not be used');
    const app = appWith({ model: s });
    const res = await app.controller.handle('calc (2+3)*4');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /= 20/);
    assert.equal(s.requests.length, 0);
  });

  test('a cut-off model answer is shown with a notice that it was truncated', async () => {
    const s = await stub('The answer starts');
    s.behavior.raw = JSON.stringify({ choices: [{ message: { content: 'The answer starts' }, finish_reason: 'length' }] });
    const app = appWith({ model: s });
    const res = await app.controller.handle('explain something long');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(res.display, /cut off at the model output limit/);
  });
});

describe('prompt construction and audit', () => {
  test('the prompt stays within its size budget and keeps the newest turn', () => {
    const memoryHits = Array.from({ length: 30 }, (_, i) => ({
      score: 1,
      record: { id: `m${i}`, kind: 'user_fact', content: `fact ${i} ${'detail '.repeat(80)}`, createdAt: '2026-10-27T00:00:00.000Z', sensitivity: 'normal' },
    }));
    const turns = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, role: 'user', origin: 'user', text: `question ${i} ${'x'.repeat(300)}` }));
    const built = buildPrompt({ request: 'final question', memoryHits, turns, maxChars: 4000 });
    assert.ok(built.prompt.length <= 4000, `prompt is ${built.prompt.length} chars`);
    assert.ok(built.prompt.includes('question 29'), 'the newest turn is kept');
    assert.ok(!built.prompt.includes('question 0 '), 'the oldest turn is dropped first');
    assert.ok(built.memoryIds.length < 30);
  });

  test('the default budget is the documented constant', () => {
    assert.equal(MAX_CONTEXT_CHARS, 6000);
  });

  test('irrelevant and private memory are excluded from the prompt selection', () => {
    const hits = [
      { score: 0.9, record: { id: 'a', content: 'ok', sensitivity: 'normal' } },
      { score: 0.9, record: { id: 'b', content: 'hidden', sensitivity: 'private' } },
      { score: 0.05, record: { id: 'c', content: 'weak', sensitivity: 'normal' } },
    ];
    assert.deepEqual(selectPromptMemory(hits).map((h) => h.record.id), ['a']);
  });

  test('the audit record stores memory ids and sizes, never memory or answer text', async () => {
    const s = await stub('A neutral answer.');
    const app = appWith({ model: s });
    await app.controller.handle('remember that the project codename is Lighthouse');
    const res = await app.controller.handle('what is the codename of the project?');
    assert.equal(res.operation.prompt.memoryIds.length, 1);
    assert.equal(typeof res.operation.prompt.chars, 'number');
    const audit = await readFileSafe(path.join(app.dataDir, 'operations.jsonl'));
    const modelOp = audit.trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.ok(modelOp.retrieval.length >= 1);
    assert.equal(audit.includes('Lighthouse'), false, 'the stored fact text does not appear in the audit log');
  });
});
