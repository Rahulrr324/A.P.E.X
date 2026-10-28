// Conversation continuity and restart reliability. These tests exercise the
// existing controller, session, conversation, memory, knowledge, task, and audit
// interfaces. Each test uses its own temp data directory; no real user data is read.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';
import { StoreError } from '../src/errors.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { makeTempDataDir, cleanup, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function appOn({ dataDir = tempDir(), model = null, contextTurns } = {}) {
  const gateway = model
    ? createGateway({ url: model.url, name: 'stub', timeoutMs: 3000, allowRemote: false })
    : new ModelGateway({ backend: new NoBackend() });
  return { dataDir, ...createApp({ dataDir, gateway, contextTurns }) };
}

async function stub(reply = 'stub answer') {
  const s = await startStubModel();
  stubs.push(s);
  s.behavior.reply = reply;
  return s;
}

// The OpenAI-compatible adapter sends the prompt as the user message.
function promptOf(s, index = -1) {
  const req = s.requests.at(index);
  return (req?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

function readTurns(dataDir) {
  const text = fs.readFileSync(path.join(dataDir, 'conversation.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('conversation continuity', () => {
  test('a relevant follow-up receives the earlier turn and its unverified model answer', async () => {
    const s = await stub('Noted: the meeting room is B-204.');
    const app = appOn({ model: s });

    const first = await app.controller.handle('The meeting room is B-204.');
    assert.equal(first.status, Outcome.VERIFICATION_UNAVAILABLE);
    const res = await app.controller.handle('Which room did I just mention?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 2);
    const prompt = promptOf(s);
    assert.match(prompt, /User: The meeting room is B-204\./);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): Noted: the meeting room is B-204\./);
    assert.equal(res.operation.prompt.turnIds.length, 2, 'both earlier turns are referenced in the audit');
  });

  test('an unrelated question retrieves no memory and does not invent stored relevance', async () => {
    const s = await stub('It is often mild.');
    const app = appOn({ model: s });
    await app.controller.handle('What is the weather like?');

    s.behavior.reply = 'Paris is the capital of France.';
    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.operation.retrieval.length, 0, 'the unrelated turn is not treated as a memory hit');
    assert.equal(res.operation.prompt.memoryIds.length, 0);
    assert.match(promptOf(s), /\(no relevant memory found\)/);
  });

  test('a pronoun-only question is clarified when no earlier turn can resolve it', async () => {
    for (const request of ['what is it?', 'who is this?', 'what about that?']) {
      const s = await stub('This must not be called.');
      const app = appOn({ model: s });
      const res = await app.controller.handle(request);
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED, request);
      assert.equal(res.decision, Decision.CLARIFY, request);
      assert.match(res.display, /What are you referring to\? Please include the subject\./, request);
      assert.equal(res.operation.steps.length, 0, request);
      assert.equal(res.operation.prompt, null, request);
      assert.equal(s.requests.length, 0, `${request} must not reach the model`);
      assert.equal(res.recorded, true);
    }
  });

  test('a pronoun follow-up is not clarified when the conversation resolves it', async () => {
    const s = await stub('The result was 4.');
    const app = appOn({ model: s });
    await app.controller.handle('calc 2+2');

    const res = await app.controller.handle('what is it?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 1, 'the action did not use the model; the follow-up did');
    const prompt = promptOf(s);
    assert.match(prompt, /User: calc 2\+2/);
    assert.match(prompt, /APEX \(action result\): 2\+2 = 4 \(verified\)/);
  });

  test('a new session does not replay history but persistent memory remains available', async () => {
    const s = await stub('Understood.');
    const app = appOn({ model: s });
    await app.controller.handle('We discussed the blue launch plan.');
    await app.controller.handle('remember that the launch codename is Lighthouse');
    await app.session.rotate();

    const res = await app.controller.handle('what is the launch codename?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.operation.prompt.turnIds.length, 0, 'old-session turns are not replayed');
    const prompt = promptOf(s);
    assert.doesNotMatch(prompt, /blue launch plan/);
    assert.match(prompt, /Lighthouse/, 'memory is a separate persistent source');
  });

  test('a model failure between interactions is not replayed as a successful answer', async () => {
    const s = await stub('Because it was cold.');
    const app = appOn({ model: s });
    s.behavior.status = 500;
    const first = await app.controller.handle('what is the weather like?');
    assert.equal(first.status, Outcome.EXECUTION_FAILED);
    assert.equal(first.decision, Decision.REFUSE_OR_BLOCK);

    const sid = (await app.session.current()).sessionId;
    const replayed = await app.conversation.recent(sid, 10);
    assert.deepEqual(replayed.map((t) => t.origin), ['user'], 'the failure notice is not replayed as context');
    const stored = readTurns(app.dataDir);
    assert.ok(stored.some((t) => t.origin === 'apex_notice' && /did not produce an answer/.test(t.text)));
    assert.equal(stored.some((t) => t.origin === 'model'), false, 'no model turn was invented for the failed call');

    s.behavior.status = 200;
    const second = await app.controller.handle('why?');
    assert.equal(second.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.notEqual(second.status, Outcome.SUCCESS_VERIFIED);
    const prompt = promptOf(s, -1);
    assert.match(prompt, /User: what is the weather like\?/, 'the earlier request is still history');
    assert.doesNotMatch(prompt, /did not produce an answer/, 'the notice is kept for the user, not sent to the model');
    assert.doesNotMatch(prompt, /APEX \(model/, 'no fabricated assistant answer is replayed');

    const ops = await app.operations.list({ limit: 10 });
    const firstRecord = ops.records.find((o) => o.id === first.operation.id);
    assert.equal(firstRecord.status, Outcome.EXECUTION_FAILED, 'the earlier failure stays recorded as failed');
  });
});

describe('restart and persistence', () => {
  test('valid memory, knowledge, session, history, ops, and tasks survive reconstruction', async () => {
    const dir = tempDir();
    const s = await stub('Noted.');
    const first = appOn({ dataDir: dir, model: s });

    await first.controller.handle('remember that the meeting room is B-204');
    await first.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Diesel' });
    await first.controller.handle('we spoke about the launch schedule');
    const planned = await first.controller.planTask('calc 2+2; calc 3+3');
    assert.equal(planned.status, Outcome.PLAN_CREATED);
    const taskId = planned.operation.task.id;
    const sessionBefore = (await first.session.current()).sessionId;

    // "Restart": new stores read the same directory.
    const second = appOn({ dataDir: dir, model: s });
    assert.equal((await second.session.current()).sessionId, sessionBefore);

    const memoryHits = await second.memory.search('meeting room');
    assert.ok(memoryHits.some((h) => h.record.content.includes('B-204')));
    const knowledgeHits = await second.knowledge.search('engine');
    assert.ok(knowledgeHits.some((h) => h.record.object === 'Diesel'));
    const turns = await second.conversation.recent(sessionBefore, 10);
    assert.ok(turns.some((t) => /launch schedule/.test(t.text)));
    assert.ok((await second.operations.list({ limit: 10 })).records.length >= 3);

    const pending = await second.taskStore.get(taskId);
    assert.equal(pending.status, TaskStatus.PENDING, 'a created task is not completed merely because it exists');
    assert.ok(pending.steps.every((step) => step.status === StepStatus.PENDING));

    const run = await second.controller.runTask(pending.id, 'run');
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(run.recorded, true);
    const done = await second.taskStore.get(taskId);
    assert.equal(done.status, TaskStatus.COMPLETED);

    const ops = (await second.operations.list({ limit: 50 })).records;
    for (const step of done.steps) {
      assert.equal(step.status, StepStatus.COMPLETED);
      assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
      const record = ops.find((o) => o.id === step.operationId);
      assert.ok(record, `step ${step.id} has an operation record`);
      assert.equal(record.capability, 'task.step');
      assert.equal(record.task.stepId, step.id);
      assert.equal(record.status, Outcome.SUCCESS_VERIFIED);
    }
    const runRecord = ops.find((o) => o.id === run.operation.id);
    assert.ok(runRecord, 'the run operation is recorded');
    assert.equal(runRecord.status, Outcome.SUCCESS_VERIFIED);
  });

  test('superseded and conflicting memory semantics survive a restart', async () => {
    const dir = tempDir();
    const first = appOn({ dataDir: dir });
    await first.controller.handle('remember that the project codename is Lighthouse');

    const second = appOn({ dataDir: dir });
    const old = (await second.memory.search('project codename'))[0].record;
    const correction = await second.controller.correctMemory({
      targetId: old.id,
      content: 'the project codename is Bluebird',
      resolve: true,
    });
    assert.equal(correction.status, Outcome.SUCCESS_VERIFIED);

    // A separate competing pair, never corrected.
    await second.controller.handle('remember that the meeting room is B-204');
    await second.controller.handle('remember that the meeting room is C-101');

    const third = appOn({ dataDir: dir });
    const codenameHits = await third.memory.search('project codename');
    assert.equal(codenameHits.find((h) => h.record.id === old.id).status, 'superseded');
    assert.equal(codenameHits.find((h) => h.record.id === correction.operation.steps[0].result.data.id).status, 'user_confirmed');

    const roomHits = await third.memory.search('meeting room');
    assert.equal(roomHits.length, 2);
    assert.ok(roomHits.every((h) => h.status === 'unresolved_conflict'), 'conflict is not silently resolved by recency');
  });

  test('a corrupt conversation store is not replayed as empty history', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'conversation.jsonl'), '{bad json}\n');
    const s = await stub('Paris is the capital of France.');
    const app = appOn({ dataDir: dir, model: s });

    const res = await app.controller.handle('what is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 1, 'an answer without history is still possible');
    const prompt = promptOf(s);
    assert.match(prompt, /\(earlier conversation could not be loaded\)/);
    assert.doesNotMatch(prompt, /\(no earlier messages in this session\)/);
    const contextError = res.operation.errors.find((e) => e.stage === 'context');
    assert.equal(contextError?.code, 'STORE_UNAVAILABLE');
    assert.equal((await app.conversation.status()).corrupt, 1, 'the damaged bytes are preserved');

    // Without trustworthy history, a content-free follow-up is clarified rather
    // than answered from a partial or invented conversation.
    const follow = await app.controller.handle('why?');
    assert.equal(follow.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(follow.decision, Decision.CLARIFY);
    assert.equal(s.requests.length, 1, 'no second model call is made');
  });

  test('a corrupt session file is neither treated as missing nor overwritten', async () => {
    const dir = tempDir();
    const sessionFile = path.join(dir, 'session.json');
    const damaged = '{not json';
    fs.writeFileSync(sessionFile, damaged);
    const s = await stub('Paris is the capital of France.');
    const app = appOn({ dataDir: dir, model: s });

    const res = await app.controller.handle('calc 2+2');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the action itself does not depend on the session file');
    const sessionError = res.operation.errors.find((e) => e.stage === 'session');
    assert.equal(sessionError?.code, 'STORE_UNAVAILABLE');
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), damaged, 'damaged bytes are not silently replaced');

    // A model answer may proceed without history, but the prompt must not claim
    // that this session simply has no earlier messages.
    const answer = await app.controller.handle('what is the capital of France?');
    assert.equal(answer.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(promptOf(s), /\(earlier conversation could not be loaded\)/);
    assert.doesNotMatch(promptOf(s), /\(no earlier messages in this session\)/);

    await assert.rejects(() => app.session.current(), StoreError);
    await assert.rejects(() => app.getStatus(), StoreError);

    // Starting a new session is the explicit recovery path.
    const rotated = await app.session.rotate();
    assert.ok(rotated.sessionId);
    assert.notEqual(fs.readFileSync(sessionFile, 'utf8'), damaged);
    assert.equal((await app.session.current()).sessionId, rotated.sessionId);
  });

  test('a missing session file starts a session; that is not corruption', async () => {
    const app = appOn({ dataDir: tempDir() });
    const state = await app.session.current();
    assert.ok(state.sessionId);
    assert.equal((await app.controller.handle('calc 2+2')).status, Outcome.SUCCESS_VERIFIED);
  });

  test('a corrupt task log fails closed instead of showing an empty list or running', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir });
    const planned = await app.controller.planTask('calc 2+2; calc 3+3');
    const taskId = planned.operation.task.id;
    const file = path.join(dir, 'tasks.jsonl');
    fs.appendFileSync(file, '{broken event\n');
    const before = fs.readFileSync(file, 'utf8');

    const isUnavailable = (err) => err instanceof StoreError && err.code === 'STORE_UNAVAILABLE';
    await assert.rejects(() => app.taskStore.list(), isUnavailable);
    await assert.rejects(() => app.controller.listTasks(), isUnavailable);
    await assert.rejects(() => app.controller.showTask(taskId), isUnavailable);

    const run = await app.controller.runTask(taskId, 'run');
    assert.equal(run.status, Outcome.EXECUTION_FAILED);
    assert.match(run.output, /task store unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'no new event is appended to a damaged log');
  });

  test('a valid-shaped task event that cannot be applied also fails closed', async () => {
    const dir = tempDir();
    const app = appOn({ dataDir: dir });
    const planned = await app.controller.planTask('calc 2+2; calc 3+3');
    const file = path.join(dir, 'tasks.jsonl');
    const firstLine = fs.readFileSync(file, 'utf8').split('\n')[0];
    fs.appendFileSync(file, `${firstLine}\n`); // duplicate task_created: valid JSON, invalid replay

    await assert.rejects(
      () => app.taskStore.get(planned.operation.task.id),
      (err) => err instanceof StoreError && /cannot be applied/.test(err.message),
    );
    assert.equal((await app.controller.listTasks().catch((e) => e.code)), 'STORE_UNAVAILABLE');
  });

  test('a missing task log is an empty store, not a corrupt one', async () => {
    const app = appOn({ dataDir: tempDir() });
    assert.match(await app.controller.listTasks(), /No tasks yet/);
  });

  test('an invalid parent path is unavailable, not an empty store', async () => {
    const dir = tempDir();
    const notADirectory = path.join(dir, 'data-file');
    fs.writeFileSync(notADirectory, 'not a directory');
    const app = appOn({ dataDir: notADirectory });
    const isUnavailable = (err) => err instanceof StoreError && err.code === 'STORE_UNAVAILABLE';

    await assert.rejects(() => app.memory.search('anything'), isUnavailable);
    await assert.rejects(() => app.knowledge.search('anything'), isUnavailable);
    await assert.rejects(() => app.conversation.status(), isUnavailable);
    await assert.rejects(() => app.taskStore.list(), isUnavailable);
    await assert.rejects(() => app.session.current(), isUnavailable);
  });

  test('the context budget is still respected when history and memory are both present', async () => {
    const s = await stub('ok');
    const app = appOn({ dataDir: tempDir(), model: s, contextTurns: 20 });
    for (let i = 0; i < 4; i += 1) {
      await app.controller.handle(`remember that note number ${i} is ${'detail '.repeat(40)}`);
    }
    const res = await app.controller.handle(`tell me about ${'notes '.repeat(200)}`);
    const prompt = promptOf(s, -1);
    assert.ok(prompt.length <= 6000, `prompt is ${prompt.length} chars`);
    assert.equal(res.operation.prompt.chars, prompt.length);
  });
});
