// Implementation 020: end-to-end operational verification.
//
// These tests drive the assembled application (composition root -> controller ->
// stores/registry/executor/verifier) and the CLI diagnostics surface. A local stub
// model stands in for a real inference backend: it exercises the real gateway
// protocol, but no claim is made that local model inference was verified here.
// Every test uses its own temp data directory; real user data is never read.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { collectDiagnostics, renderDiagnostics } from '../src/diagnostics.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import {
  makeTempDataDir,
  cleanup,
  cleanEnv,
  runCli,
  startStubModel,
  closedPortUrl,
} from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

function appOn({ dataDir = tempDir(), model = null, gateway = null, extraActions = [] } = {}) {
  const g = gateway ?? (model
    ? createGateway({ url: model.url, name: 'stub', timeoutMs: 3000, retries: 0, allowRemote: false })
    : new ModelGateway({ backend: new NoBackend() }));
  return { dataDir, ...createApp({ dataDir, gateway: g, extraActions }) };
}

async function stub(reply = 'stub answer') {
  const s = await startStubModel();
  stubs.push(s);
  s.behavior.reply = reply;
  return s;
}

// A real HTTP endpoint that answers only after delayMs, so a short gateway
// timeout is exercised with an actual late response rather than a fake fetch.
async function delayedOllama(delayMs, content = 'late answer') {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    setTimeout(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'm',
          message: { role: 'assistant', content },
          done: true,
          done_reason: 'stop',
        }));
      }
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stubs.push({ close: () => new Promise((resolve) => server.close(resolve)) });
  return { url: `http://127.0.0.1:${server.address().port}`, count: () => requests };
}

// The OpenAI-compatible adapter sends the prompt as the user message.
function promptOf(s, index = -1) {
  const req = s.requests.at(index);
  return (req?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const AT = '2026-01-01T00:00:00.000Z';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OP_ID = '22222222-2222-4222-8222-222222222222';

function createdEvent(taskId = TASK_ID) {
  return {
    schema: 1,
    eventId: `create-${taskId}`,
    type: 'task_created',
    taskId,
    at: AT,
    goal: 'integration fixture',
    origin: 'user',
    planner: 'deterministic',
    steps: [{
      id: 's1',
      description: 'fixture step',
      action: 'calc',
      permission: 'read',
      input: { expression: '1+1' },
      dependsOn: [],
    }],
    reason: 'created',
  };
}

function transitionEvent(taskId, eventId, { task = null, steps = [], reason = 'fixture' } = {}) {
  return { schema: 1, eventId, type: 'transition', taskId, at: AT, reason, task, steps, approval: null };
}

function auditRecord({ id = OP_ID, status = Outcome.SUCCESS_VERIFIED, taskId = TASK_ID, stepId = 's1' } = {}) {
  return {
    schema: 1,
    id,
    status,
    requestedAt: AT,
    finishedAt: AT,
    origin: 'user',
    request: 'task fixture step s1',
    capability: 'task.step',
    task: { id: taskId, stepId },
    steps: [],
    errors: [],
  };
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

describe('A. conversation and context', () => {
  test('a self-contained question is answered by the model without a clarification', async () => {
    const s = await stub('Paris is the capital of France.');
    const app = appOn({ model: s });

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 1, 'the model is called exactly once');
    assert.match(res.display, /Paris is the capital of France\./);
  });

  test('Ollama reasoning text and a think marker reach the user unchanged, and a token cut is reported', async () => {
    const content = 'I should work this out step by step.\n</think>\n\nPartial ans';
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content },
        done: true,
        done_reason: 'length',
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stubs.push({ close: () => new Promise((resolve) => server.close(resolve)) });
    const app = appOn({
      gateway: createGateway({
        provider: 'ollama',
        url: `http://127.0.0.1:${server.address().port}`,
        name: 'm',
        maxTokens: 64,
        timeoutMs: 3000,
        retries: 0,
        allowRemote: false,
      }),
    });

    const res = await app.controller.handle('Explain why the sky appears blue.');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.match(res.display, /I should work this out step by step\./);
    assert.match(res.display, /<\/think>/, 'marker text is preserved, not stripped');
    assert.match(res.display, /Partial ans/);
    assert.match(res.display, /cut off at the model output limit/);
    assert.equal(res.operation.model.finishReason, 'length');
    assert.equal(res.operation.errors.some((e) => e.code === 'TRUNCATED'), true);
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    const modelTurn = turns.find((t) => t.origin === 'model');
    assert.equal(modelTurn.text, content, 'the stored turn is the unmodified model text');
    assert.doesNotMatch(modelTurn.text, /cut off at the model output limit/,
      'an APEX notice is never stored as if the model had said it');
  });

  test('a saved conclusion and the stored turn exclude APEX notices', async () => {
    const s = await startStubModel();
    stubs.push(s);
    s.behavior.raw = JSON.stringify({
      model: 'stub',
      choices: [{ message: { role: 'assistant', content: 'The answer begins and then' }, finish_reason: 'length' }],
    });
    const app = appOn({ model: s });

    const res = await app.controller.handle('Explain a long process.', { saveAnswer: true });

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(res.display, /cut off at the model output limit/, 'the user is still told the answer was cut');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.find((t) => t.origin === 'model').text, 'The answer begins and then');
    const saved = readJsonl(path.join(app.dataDir, 'memory.jsonl')).find((r) => r.kind === 'model_conclusion');
    assert.ok(saved, 'the user-approved conclusion is stored');
    assert.equal(saved.content, 'The answer begins and then', 'the notice is not part of the saved conclusion');

    const later = await app.controller.handle('What process was that?');
    assert.equal(later.operation.prompt.turnIds.length > 0, true);
    assert.doesNotMatch(JSON.stringify(s.requests.at(-1).messages), /cut off at the model output limit/,
      'the notice is not replayed to the model as earlier conversation');
  });

  test('a knowledge-unavailable notice is not stored as model text', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), 'CORRUPT\n');
    const s = await stub('Paris is the capital of France.');
    const app = appOn({ dataDir: dir, model: s });

    const res = await app.controller.handle('What is the capital of France?');

    assert.match(res.output, /Knowledge context was unavailable \(STORE_UNAVAILABLE\)/);
    const turns = readJsonl(path.join(dir, 'conversation.jsonl'));
    assert.equal(turns.find((t) => t.origin === 'model').text, 'Paris is the capital of France.');
  });

  test('separate reasoning is not shown or stored; only the final answer reaches the user', async () => {
    const reasoning = 'The user asks about France. From my knowledge, its capital is Paris.';
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content: 'Paris.', thinking: reasoning },
        done: true,
        done_reason: 'stop',
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stubs.push({ close: () => new Promise((resolve) => server.close(resolve)) });
    const app = appOn({
      gateway: createGateway({
        provider: 'ollama',
        url: `http://127.0.0.1:${server.address().port}`,
        name: 'm',
        maxTokens: 128,
        timeoutMs: 3000,
        retries: 0,
        allowRemote: false,
      }),
    });

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'still an unverified answer');
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(res.display, 'Paris.', 'display is the final answer only');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.find((t) => t.origin === 'model').text, 'Paris.', 'the stored turn is the final answer only');
    assert.equal(fs.readFileSync(path.join(app.dataDir, 'conversation.jsonl'), 'utf8').includes('From my knowledge'), false);
    assert.equal(fs.readFileSync(path.join(app.dataDir, 'operations.jsonl'), 'utf8').includes('The user asks about France'), false,
      'reasoning is not stored in the audit record');
  });

  test('a reasoning-only generation is an honest failure, never an answer or a stored model turn', async () => {
    const reasoning = 'The user asks about France. Let me recall the capital carefully step by step.';
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content: '', thinking: reasoning },
        done: true,
        done_reason: 'length',
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stubs.push({ close: () => new Promise((resolve) => server.close(resolve)) });
    const app = appOn({
      gateway: createGateway({
        provider: 'ollama',
        url: `http://127.0.0.1:${server.address().port}`,
        name: 'm',
        maxTokens: 64,
        timeoutMs: 3000,
        retries: 0,
        allowRemote: false,
      }),
    });

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(res.display, /reasoning but no final answer/);
    assert.match(res.display, /APEX_MODEL_MAX_TOKENS/);
    assert.match(res.display, /No answer has been generated\./);
    assert.equal(res.display.includes(reasoning), false, 'reasoning text is not shown');
    assert.equal(res.operation.errors[0].stage, 'model');
    assert.equal(res.operation.errors[0].code, 'EMPTY_RESPONSE');
    const raw = fs.readFileSync(path.join(app.dataDir, 'conversation.jsonl'), 'utf8');
    const kept = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.deepEqual(kept.map((t) => t.origin), ['user', 'apex_notice'], 'only the request and a failure notice are kept');
    assert.equal(kept.some((t) => t.origin === 'model'), false);
    assert.equal(raw.includes('Let me compute carefully'), false);
    const audit = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(audit[0].status, Outcome.EXECUTION_FAILED);
  });

  test('a model timeout is a failure, not an answer, and a late reply changes no state', async () => {
    const { url, count } = await delayedOllama(300);
    const app = appOn({
      gateway: createGateway({
        provider: 'ollama',
        url,
        name: 'm',
        timeoutMs: 50,
        retries: 2,
        allowRemote: false,
      }),
    });

    const res = await app.controller.handle('Explain why the sky appears blue.');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(res.display, /TIMEOUT/);
    assert.match(res.display, /No answer has been generated/);
    assert.equal(res.operation.errors[0].code, 'TIMEOUT');
    assert.equal(count(), 1, 'a timeout is not retried, even when retries are configured');
    const before = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(before.some((t) => t.origin === 'model'), false, 'no model turn is invented');
    assert.equal(before.some((t) => t.origin === 'apex_notice' && /did not produce an answer/.test(t.text)), true);
    const opsBefore = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(opsBefore.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.deepEqual(readJsonl(path.join(app.dataDir, 'conversation.jsonl')), before, 'a late reply adds no turn');
    assert.deepEqual(readJsonl(path.join(app.dataDir, 'operations.jsonl')), opsBefore, 'a late reply adds no operation');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'tasks.jsonl')), false, 'a timed-out answer creates no task');
  });

  test('an ambiguous follow-up asks for the missing referent before any model call, even when repeated', async () => {
    const s = await stub('This must not be called.');
    const app = appOn({ model: s });

    const first = await app.controller.handle('what about that?');
    const second = await app.controller.handle('what about that?');

    for (const [label, res] of [['first', first], ['second', second]]) {
      assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED, label);
      assert.equal(res.decision, Decision.CLARIFY, label);
      assert.match(res.display, /What are you referring to\? Please include the subject\./, label);
      assert.equal(res.operation.prompt, null, `${label}: nothing was sent to a model`);
      assert.equal(res.recorded, true, `${label}: the clarification is audited`);
    }
    assert.equal(s.requests.length, 0, 'a clarification-only history is not resolvable context');
  });

  test('a resolvable follow-up uses the earlier conversation', async () => {
    const s = await stub('The meeting room is B-204.');
    const app = appOn({ model: s });
    await app.controller.handle('The meeting room is B-204.');

    s.behavior.reply = 'You mentioned B-204.';
    const res = await app.controller.handle('what about that?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(s.requests.length, 2);
    const prompt = promptOf(s);
    assert.match(prompt, /User: The meeting room is B-204\./);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): The meeting room is B-204\./);
    assert.equal(res.operation.prompt.turnIds.length, 2, 'both earlier turns are referenced in the audit');
  });

  test('a new session does not inherit unrelated turns but persistent memory remains', async () => {
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

  test('a corrupt conversation log produces an answer with a visible limitation, not silent history loss', async () => {
    const s = await stub('Paris is the capital of France.');
    const app = appOn({ model: s });
    const file = path.join(app.dataDir, 'conversation.jsonl');
    const damaged = '{broken\n';
    fs.writeFileSync(file, damaged);

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.ANSWER);
    assert.match(res.display, /Paris is the capital of France\./);
    assert.match(res.display, /\[Earlier conversation was unavailable \(STORE_UNAVAILABLE\); this answer did not use earlier turns\.\]/);
    assert.equal(s.requests.length, 1);
    assert.match(promptOf(s), /\(earlier conversation could not be loaded\)/);
    assert.equal(res.operation.errors[0].stage, 'context');
    const stored = fs.readFileSync(file, 'utf8');
    assert.ok(stored.startsWith(damaged), 'the damaged line is preserved');
    const turns = stored.split('\n').filter(Boolean).slice(1).map((line) => JSON.parse(line));
    const modelTurn = turns.find((t) => t.origin === 'model');
    assert.equal(modelTurn.text, 'Paris is the capital of France.', 'the limitation notice is not stored as model text');
  });

  test('a corrupt session produces an answer with a visible notice that it was not saved', async () => {
    const s = await stub('Paris.');
    const app = appOn({ model: s });
    fs.writeFileSync(path.join(app.dataDir, 'session.json'), '{bad');

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(res.display, /\[The session could not be loaded \(STORE_UNAVAILABLE\); this answer was not saved to conversation history\.\]/);
    assert.equal(res.operation.errors[0].stage, 'session');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'conversation.jsonl')), false, 'no turn is recorded without a session');
    assert.equal(fs.readFileSync(path.join(app.dataDir, 'session.json'), 'utf8'), '{bad', 'the damaged session is preserved');
  });

  test('one reply with denial, malformed proposal, and overflow stays consistent across display, audit, and history', async () => {
    const s = await stub(
      'Done - everything was saved.\n'
      + 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"model-authored fact"}}\n'
      + 'PROPOSE_ACTION this is not json\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"1+1"}}\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"3+3"}}',
    );
    const app = appOn({ model: s });

    const first = await app.controller.handle('Please do all of it.');
    assert.equal(first.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(first.display, /denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.match(first.display, /malformed proposal rejected/);
    assert.match(first.display, /considered only the first 3 proposed actions; 1 more was ignored/);
    assert.equal(first.operation.steps.filter((step) => step.action === 'calc.evaluate').length, 2,
      'the fourth proposal was not executed');
    assert.ok(first.operation.errors.some((e) => e.stage === 'proposals' && e.code === 'TOO_MANY'));
    assert.equal(fs.existsSync(path.join(app.dataDir, 'memory.jsonl')), false, 'the denied write did not happen');

    s.behavior.reply = 'Here is what happened.';
    await app.controller.handle('What actually happened?');
    const prompt = promptOf(s);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): Done - everything was saved\./);
    assert.match(prompt, /APEX \(action result\): denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.match(prompt, /APEX \(action result\): malformed proposal rejected/);
    assert.equal(prompt.includes('3+3'), false, 'the ignored proposal is not replayed as an action result');
  });

  test('a conversation-history write failure is shown to the user, not silently hidden', async () => {
    const s = await stub('A model answer.');
    const app = appOn({ model: s });
    app.conversation.append = async () => {
      const err = new Error('disk full');
      err.code = 'EIO';
      throw err;
    };

    const res = await app.controller.handle('What is the capital of France?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.ok(res.operation.errors.some((e) => e.stage === 'conversation' && e.code === 'EIO'));
    assert.match(res.display, /A model answer\./, 'the answer is still shown');
    assert.match(res.display, /could not be fully saved to conversation history \(EIO\); a later turn may not see it/);
    assert.equal(String(res.output ?? '').includes('could not be fully saved'), false, 'the notice is display-only');
  });

  test('a failure notice is kept for history but never replayed as assistant context', async () => {
    const s = await stub('Recovered answer.');
    const app = appOn({ model: s });

    s.behavior.status = 500;
    const failed = await app.controller.handle('What is the answer?');
    assert.equal(failed.status, Outcome.EXECUTION_FAILED);
    const notice = readJsonl(path.join(app.dataDir, 'conversation.jsonl')).find((t) => t.origin === 'apex_notice');
    assert.ok(notice, 'the failure is kept in conversation history');

    s.behavior.status = 200;
    const ok = await app.controller.handle('What is the answer now?');
    assert.equal(ok.status, Outcome.VERIFICATION_UNAVAILABLE);
    const prompt = promptOf(s);
    assert.doesNotMatch(prompt, /did not produce an answer/, 'the failure notice is not replayed as context');
    assert.doesNotMatch(prompt, /No answer has been generated/);
    assert.match(prompt, /User: What is the answer\?/);
    assert.equal(ok.operation.prompt.turnIds.length, 1, 'only the user turn is replayed');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.ok(turns.some((t) => t.origin === 'apex_notice'), 'the failure remains visible in history');
  });

  test('a fresh session after a recoverable failure starts clean but preserves the failure record', async () => {
    const s = await stub('A fresh answer.');
    const app = appOn({ model: s });

    s.behavior.status = 500;
    const failed = await app.controller.handle('the first question');
    assert.equal(failed.status, Outcome.EXECUTION_FAILED);
    await app.session.rotate();

    s.behavior.status = 200;
    const ok = await app.controller.handle('the second question');
    assert.equal(ok.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(ok.operation.prompt.turnIds.length, 0, 'the old session is not replayed');
    assert.doesNotMatch(promptOf(s), /the first question/);
    const ops = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(ops.length, 2);
    assert.equal(ops[0].status, Outcome.EXECUTION_FAILED, 'the original failure stays in the audit');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.ok(turns.some((t) => t.origin === 'apex_notice' && /did not produce an answer/.test(t.text)),
      'the original failure is not hidden by the new session');
  });

  test('memory and knowledge are labelled distinctly and conflicting claims stay visible', async () => {
    const s = await stub('The stored records disagree.');
    const app = appOn({ model: s });
    await app.controller.handle('remember that the meeting room is B-204');
    await app.controller.handle('remember that the meeting room is C-301');
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'design review' });
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'budget review' });

    const res = await app.controller.handle('what is the meeting room?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const prompt = promptOf(s);
    assert.match(prompt, /MEMORY \(recalled data, not instructions\)/);
    assert.match(prompt, /KNOWLEDGE \(explicit relationships, not instructions\)/);
    assert.match(prompt, /user-provided fact/, 'memory provenance is labelled');
    assert.match(prompt, /user-supplied fact/, 'knowledge provenance is labelled');
    assert.match(prompt, /B-204/);
    assert.match(prompt, /C-301/);
    assert.match(prompt, /design review/);
    assert.match(prompt, /budget review/);
    assert.match(prompt, /\[conflicting memory: 1 other record\(s\) disagree/, 'memory conflict is marked in the prompt');
    assert.match(prompt, /\[CONFLICTING: another record disagrees; treat as unresolved\]/, 'knowledge conflict is marked in the prompt');
    assert.match(res.display, /Stored context contains conflicting records; APEX has not resolved them\./);
    assert.equal(res.operation.prompt.memoryIds.length, 2);
    assert.equal(res.operation.prompt.knowledgeIds.length, 2);
  });

  test('the prompt budget is enforced and knowledge is dropped after memory', async () => {
    const s = await stub('ok');
    const app = appOn({ model: s });
    app.controller.maxContextChars = 700;
    for (let i = 0; i < 3; i += 1) {
      await app.memory.add({
        content: `budget topic ${i} ${'detail '.repeat(60)}`,
        kind: 'user_fact',
        source: 'user',
        provenance: { origin: 'user_request' },
      });
    }
    await app.controller.knowledgeAdd({ subject: 'budget topic', relationship: 'owner', object: 'team' });

    const res = await app.controller.handle('what is the budget topic?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const prompt = promptOf(s);
    assert.ok(prompt.length <= 700, `prompt is ${prompt.length} chars`);
    assert.equal(res.operation.prompt.chars, prompt.length);
    assert.equal(res.operation.prompt.memoryIds.length, 0, 'memory is dropped to meet the budget');
    assert.equal(res.operation.prompt.knowledgeIds.length, 1, 'knowledge is the last section to be dropped');
  });
});

describe('B. model behavior', () => {
  test('a successful model response is reported as an unverified answer and audited', async () => {
    const s = await stub('The answer is 42.');
    const app = appOn({ model: s });

    const res = await app.controller.handle('What is the answer?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.recorded, true);
    assert.equal(res.operation.capability, 'model.answer');
    assert.equal(res.operation.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(readJsonl(path.join(app.dataDir, 'operations.jsonl')).length, 1);
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.ok(turns.some((t) => t.role === 'assistant' && t.origin === 'model' && t.verified === false));
  });

  test('an unreachable model produces an accurate failure and no invented answer', async () => {
    const url = await closedPortUrl();
    const app = appOn({ gateway: createGateway({ url, name: 'down', timeoutMs: 1000, retries: 0, allowRemote: false }) });

    const res = await app.controller.handle('What is the answer?');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.match(res.display, /did not produce an answer \(UNREACHABLE:/);
    assert.match(res.display, /No answer has been generated\./);
    assert.equal(res.operation.errors[0].stage, 'model');
    assert.equal(res.operation.errors[0].code, 'UNREACHABLE');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.some((t) => t.origin === 'model'), false, 'no model turn is invented for a failed call');
  });

  test('empty and malformed model outputs fail honestly instead of becoming an answer', async () => {
    for (const [label, configure, code] of [
      ['empty', (s) => { s.behavior.reply = ''; }, 'EMPTY_RESPONSE'],
      ['malformed', (s) => { s.behavior.raw = 'this is not json'; }, 'MALFORMED_RESPONSE'],
    ]) {
      const s = await stub('placeholder');
      configure(s);
      const app = appOn({ model: s });
      const res = await app.controller.handle('What is the answer?');
      assert.equal(res.status, Outcome.EXECUTION_FAILED, label);
      assert.match(res.display, new RegExp(`did not produce an answer \\(${code}:`), label);
      assert.match(res.display, /No answer has been generated\./, label);
      const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
      assert.equal(turns.some((t) => t.origin === 'model'), false, `${label}: no model turn is stored`);
    }
  });

  test('a model proposal cannot authorize a write for itself', async () => {
    const s = await stub(
      'I can store that.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"model-authored fact"}}\n'
      + 'PROPOSE_ACTION {"action":"knowledge.add","input":{"subject":"APEX","relationship":"has","object":"model-authored"}}',
    );
    const app = appOn({ model: s });

    const res = await app.controller.handle('Please store this for me.');

    assert.equal(res.operation.steps.length, 2);
    for (const step of res.operation.steps) {
      assert.equal(step.outcome, Outcome.ACTION_DENIED);
      assert.equal(step.authorization.decision, 'deny');
    }
    assert.match(res.display, /did not execute 2 proposed actions/);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'memory.jsonl')), false, 'nothing was written to memory');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'knowledge.jsonl')), false, 'nothing was written to knowledge');
  });

  test('a destructive request is refused before the model is consulted', async () => {
    const s = await stub('This must not be called.');
    const app = appOn({ model: s });

    const rm = await app.controller.handle('rm -rf /');
    const shell = await app.controller.handle('execute a shell command');

    for (const res of [rm, shell]) {
      assert.equal(res.status, Outcome.ACTION_DENIED);
      assert.match(res.display, /APEX has no capability for that operation/);
      assert.equal(res.operation.prompt, null);
    }
    assert.equal(s.requests.length, 0, 'safety does not depend on model instruction-following');
  });
});

describe('C. knowledge and memory', () => {
  test('retrieval reports provenance for memory and knowledge', async () => {
    const s = await stub('The codename is Lighthouse.');
    const app = appOn({ model: s });
    await app.controller.handle('remember that the launch codename is Lighthouse');
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'design review' });

    const memory = await app.controller.handle('what do you remember about launch codename');
    assert.equal(memory.status, Outcome.SUCCESS_VERIFIED);
    assert.match(memory.display, /user_fact from user:/);
    assert.match(memory.display, /Lighthouse/);
    assert.match(memory.display, /\[user_confirmed\]/);

    const model = await app.controller.handle('what is the meeting room?');
    assert.equal(model.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(promptOf(s), /meeting room --\[booked_for\]--> design review \[user-supplied fact\]/);
    assert.equal(model.operation.prompt.knowledgeIds.length, 1);
  });

  test('conflicting knowledge records are preserved and shown as unresolved', async () => {
    const app = appOn();
    const first = await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'deployment_target', object: 'Windows' });
    await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'deployment_target', object: 'Linux' });

    const list = await app.controller.knowledgeList({ limit: 10 });
    assert.equal(list.status, Outcome.SUCCESS_VERIFIED);
    assert.match(list.display, /conflicting \(conflicts with: [0-9a-f]{8}\)/);

    const id = first.operation.steps[0].result.data.id;
    const shown = await app.controller.knowledgeShow(id);
    assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
    assert.match(shown.display, /Status:\s+conflicting/);
    assert.match(shown.display, /CONFLICTS WITH: [0-9a-f]{8}/, 'the competing record is named, not merged away');

    assert.equal(readJsonl(path.join(app.dataDir, 'knowledge.jsonl')).length, 2, 'both claims remain stored');
  });

  test('a corrupt knowledge store fails safely without being overwritten or treated as empty', async () => {
    const s = await stub('Answer without stored knowledge.');
    const app = appOn({ model: s });
    const file = path.join(app.dataDir, 'knowledge.jsonl');
    const damaged = '{"schema":1}\n{broken\n';
    fs.writeFileSync(file, damaged);

    const res = await app.controller.handle('what is the meeting room?');

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'the model answer is still produced');
    assert.match(res.display, /\[Knowledge context was unavailable \(STORE_UNAVAILABLE\); this answer did not use stored knowledge\.\]/);
    assert.equal(res.operation.errors[0].stage, 'knowledge');
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged store is preserved, not overwritten or emptied');

    const write = await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'has', object: 'knowledge' });
    assert.equal(write.status, Outcome.EXECUTION_FAILED);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);

    const diag = await runCli(['diagnose'], envFor(app.dataDir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Knowledge: corrupt \(0 readable record\(s\), 2 corrupt line\(s\)/);
    assert.match(diag.stdout, /knowledge reads and writes stay blocked/);
  });

  test('a corrupt memory store blocks the answer with a limitation instead of guessing', async () => {
    const s = await stub('This must not be called.');
    const app = appOn({ model: s });
    const file = path.join(app.dataDir, 'memory.jsonl');
    const damaged = '{"schema":1}\n{broken\n';
    fs.writeFileSync(file, damaged);

    const res = await app.controller.handle('What is the meeting room?');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /Memory retrieval failed \(STORE_UNAVAILABLE\)\. APEX did not generate an answer because stored context could not be checked\./);
    assert.equal(s.requests.length, 0, 'no model call without checked stored context');
    assert.equal(res.operation.errors[0].stage, 'retrieval');
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged store is preserved');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.some((t) => t.origin === 'model'), false, 'no model turn is invented');
  });

  test('a deterministic action is not audited as though it had consulted memory', async () => {
    const s = await stub('This must not be called.');
    const app = appOn({ model: s });
    const file = path.join(app.dataDir, 'memory.jsonl');
    const damaged = '{"schema":1}\n{broken\n';
    fs.writeFileSync(file, damaged);

    // The action reads nothing from memory, so a lookup made on its behalf could
    // only ever misreport: the verified result carried a store failure it never
    // depended on, and an empty retrieval was audited as though context had been
    // considered and found irrelevant.
    const res = await app.controller.handle('calc 2+2');

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /4/);
    assert.equal(res.operation.capability, 'calc.evaluate');
    assert.equal(res.operation.retrieval.length, 0, 'an action that reads nothing retrieves nothing');
    assert.equal(res.operation.errors.length, 0, 'a memory failure the action never used is not its defect');
    assert.equal(s.requests.length ?? 0, 0, 'no model call');

    const cli = await runCli(['ask', 'calc 2+2'], envFor(app.dataDir));
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /Context:   0 memory record\(s\) retrieved/);

    const audit = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(audit.at(-1).errors.length, 0, 'the audit record stays clean');
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged store is preserved, not repaired or emptied');
  });

  test('secret-like memory and knowledge values are refused and never stored', async () => {
    const app = appOn();
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234';

    const memory = await app.controller.handle(`remember that the api key is ${secret}`);
    assert.equal(memory.status, Outcome.INPUT_REJECTED);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'memory.jsonl')), false);

    const knowledge = await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'api_key', object: secret });
    assert.equal(knowledge.status, Outcome.INPUT_REJECTED);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'knowledge.jsonl')), false);

    for (const file of ['memory.jsonl', 'knowledge.jsonl', 'operations.jsonl', 'conversation.jsonl']) {
      const full = path.join(app.dataDir, file);
      if (fs.existsSync(full)) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /sk-abcdefghijklmnopqrstuvwx1234/);
    }
  });
});

describe('D. actions and tasks', () => {
  test('a permitted action runs through authorization, execution, verification, and audit', async () => {
    const app = appOn();

    const res = await app.controller.handle('calc 2+2');

    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.decision, Decision.ANSWER);
    const step = res.operation.steps[0];
    assert.equal(step.action, 'calc.evaluate');
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /2\+2 = 4/);
    const audit = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].id, res.operation.id);
    assert.equal(audit[0].status, Outcome.SUCCESS_VERIFIED);
  });

  test('a model-plan timeout creates no task, and a late plan is never stored', async () => {
    const { url, count } = await delayedOllama(300);
    const app = appOn({
      gateway: createGateway({
        provider: 'ollama',
        url,
        name: 'm',
        timeoutMs: 50,
        retries: 2,
        allowRemote: false,
      }),
    });

    const res = await app.controller.planTask('organise my week and save the total');

    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /did not return a plan/);
    assert.match(res.display, /TIMEOUT/);
    assert.equal(res.operation.errors[0].code, 'TIMEOUT');
    assert.equal((await app.taskStore.list()).length, 0);
    assert.equal(count(), 1, 'a timeout is not retried');
    const opsBefore = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.equal(opsBefore.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal((await app.taskStore.list()).length, 0, 'a late reply does not create a task');
    assert.deepEqual(readJsonl(path.join(app.dataDir, 'operations.jsonl')), opsBefore);
  });

  test('unknown and malformed model proposals never execute', async () => {
    const s = await stub(
      'Here you go.\nPROPOSE_ACTION {"action":"memory.delete","input":{}}\nPROPOSE_ACTION {"action": "calc.evaluate", "input": ',
    );
    const app = appOn({ model: s });

    const res = await app.controller.handle('Please do it.');

    const unknown = res.operation.steps.find((step) => step.action === 'memory.delete');
    assert.equal(unknown.outcome, Outcome.ACTION_DENIED);
    assert.equal(unknown.authorization.reason, 'UNKNOWN_ACTION');
    assert.ok(res.operation.steps.some((step) => step.action === null && /malformed proposal rejected/.test(step.summary)));
    assert.match(res.display, /did not execute 2 proposed actions/);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'memory.jsonl')), false);
  });

  test('the proposal shape a real model sent is rejected, and the documented shape still executes and verifies', async () => {
    // The exact reply two real-model runs produced: valid JSON, correct keys, and a
    // bare string where the action's parameter object belongs.
    const s = await stub('Working on it.\nPROPOSE_ACTION {"action": "calc.evaluate", "input": "123*456"}');
    const app = appOn({ model: s });

    const rejected = await app.controller.handle('Use an action to compute 123*456.');

    assert.equal(rejected.operation.steps.length, 1);
    const step = rejected.operation.steps[0];
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.equal(step.authorization, null, 'a proposal with no parameter object is rejected before authorization');
    assert.equal(step.execution.status, 'not_run');
    assert.match(step.summary, /"input" must be an object of the action's parameters, got string/);
    assert.match(rejected.display, /APEX did not execute a proposed action/);
    assert.equal(rejected.decision, Decision.REFUSE_OR_BLOCK);

    // The same action in the documented shape is still accepted: the change refuses
    // nothing that used to work.
    s.behavior.reply = 'The result is 56088.\nPROPOSE_ACTION {"action": "calc.evaluate", "input": {"expression": "123*456"}}';
    const accepted = await app.controller.handle('Use an action to compute 123*456 again.');

    assert.equal(accepted.operation.steps.length, 1);
    assert.equal(accepted.operation.steps[0].action, 'calc.evaluate');
    assert.equal(accepted.operation.steps[0].outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(accepted.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(accepted.decision, Decision.PROPOSE_ACTION);
    assert.match(accepted.display, /56088|56,088/);
  });

  test('a malformed model proposal is recorded in history, not only its text claim', async () => {
    const s = await stub('Done - I did what you asked.\nPROPOSE_ACTION this is not json');
    const app = appOn({ model: s });

    const first = await app.controller.handle('Please do the thing.');
    const malformed = first.operation.steps.find((step) => step.action === null);
    assert.equal(malformed.outcome, Outcome.INPUT_REJECTED);
    assert.match(malformed.summary, /malformed proposal rejected/);

    s.behavior.reply = 'I could not run it.';
    const second = await app.controller.handle('What happened?');

    const prompt = promptOf(s);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): Done - I did what you asked\./);
    assert.match(prompt, /APEX \(action result\): malformed proposal rejected/,
      'the rejection is replayed alongside the claim');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    const actionTurn = turns.find((t) => t.origin === 'apex_action');
    assert.ok(actionTurn, 'the rejection is stored as a turn');
    assert.equal(actionTurn.verified, false);
    assert.equal(second.operation.prompt.turnIds.length, 3);
  });

  test('an execution failure is reported as a failure, never as success', async () => {
    const s = await stub('Trying that.\nPROPOSE_ACTION {"action":"broken.read","input":{}}');
    const app = appOn({
      model: s,
      extraActions: [{
        name: 'broken.read',
        description: 'test-only action that fails during execution',
        permission: 'read',
        origins: ['user', 'model'],
        validate: () => ({}),
        async execute() { throw new Error('underlying read failed'); },
      }],
    });

    const res = await app.controller.handle('Please read it.');

    const step = res.operation.steps[0];
    assert.equal(step.outcome, Outcome.EXECUTION_FAILED);
    assert.equal(step.execution.status, 'failed');
    assert.equal(step.verification.outcome, 'not_run');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'the model answer does not mask the step failure');
    assert.match(res.display, /proposed an action that did not complete: execution failed: underlying read failed/);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK);
  });

  test('an executed action with no independent verification is not reported as verified', async () => {
    const s = await stub('Doing that.\nPROPOSE_ACTION {"action":"blind.read","input":{}}');
    const app = appOn({
      model: s,
      extraActions: [{
        name: 'blind.read',
        description: 'test-only action with no verifier',
        permission: 'read',
        origins: ['user', 'model'],
        validate: () => ({}),
        async execute() { return { summary: 'did the thing' }; },
      }],
    });

    const res = await app.controller.handle('Please do it.');

    const step = res.operation.steps[0];
    assert.equal(step.execution.status, 'ok');
    assert.equal(step.verification.outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(step.outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.notEqual(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(res.display, /executed a proposed action but could not be independently verified/);
  });

  test('a verified model-proposed action result is carried into the next turn', async () => {
    const s = await stub('PROPOSE_ACTION {"action":"app.status","input":{}}');
    const app = appOn({ model: s });

    const first = await app.controller.handle('Please check the application status.');
    assert.equal(first.decision, Decision.PROPOSE_ACTION);
    assert.equal(first.operation.steps[0].outcome, Outcome.SUCCESS_VERIFIED);

    s.behavior.reply = 'It reported the current status.';
    const second = await app.controller.handle('What did the status check report?');

    assert.equal(second.status, Outcome.VERIFICATION_UNAVAILABLE);
    const prompt = promptOf(s);
    assert.match(prompt, /APEX \(action result\): APEX .*memory record\(s\)/,
      'the verified summary is replayed, not only the user request');
    assert.equal(second.operation.prompt.turnIds.length, 2, 'the user turn and the action result are replayed');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    const actionTurn = turns.find((t) => t.origin === 'apex_action');
    assert.ok(actionTurn, 'the action result is stored as a turn');
    assert.equal(actionTurn.verified, true);
    assert.equal(turns.filter((t) => t.origin === 'model').length, 1, 'only the second (text) reply is stored as a model answer');
  });

  test('extra model proposals are ignored with a visible notice, and the prompt states the cap', async () => {
    const s = await stub(
      'Four results follow.\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"1+1"}}\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"3+3"}}\n'
      + 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"4+4"}}',
    );
    const app = appOn({ model: s });

    const res = await app.controller.handle('Please run these four calculations.');

    assert.equal(res.operation.steps.filter((step) => step.action === 'calc.evaluate').length, 3);
    assert.ok(res.operation.steps.every((step) => step.outcome === Outcome.SUCCESS_VERIFIED));
    assert.ok(res.operation.errors.some((e) => e.stage === 'proposals' && e.code === 'TOO_MANY'));
    assert.match(res.display, /APEX considered only the first 3 proposed actions; 1 more was ignored/);
    assert.match(s.requests[0].messages[0].content, /At most 3 such lines are considered/);
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.filter((t) => t.origin === 'apex_action').length, 3);
  });

  test('a denied model proposal is recorded in history so its claim is not the only record', async () => {
    const s = await stub(
      'Done - I saved that to memory.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"model-authored fact"}}',
    );
    const app = appOn({ model: s });

    const first = await app.controller.handle('Please store this for me.');
    assert.equal(first.decision, Decision.REFUSE_OR_BLOCK);

    s.behavior.reply = 'It was not stored.';
    const second = await app.controller.handle('Did you save it?');

    const prompt = promptOf(s);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): Done - I saved that to memory\./);
    assert.match(prompt, /APEX \(action result\): denied \(ORIGIN_NOT_PERMITTED\)/,
      'the denial is replayed alongside the claim');
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    const actionTurn = turns.find((t) => t.origin === 'apex_action');
    assert.ok(actionTurn, 'the denial is stored as a turn');
    assert.equal(actionTurn.verified, false);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'memory.jsonl')), false, 'the denial did not write anything');
    assert.equal(second.operation.prompt.turnIds.length, 3, 'user, model claim, and denial are all replayed');
  });

  test('an interrupted step is resolved from its own audit record and never executed again', async () => {
    const dir = tempDir();
    writeJsonl(path.join(dir, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
    ]);
    writeJsonl(path.join(dir, 'operations.jsonl'), [auditRecord()]);
    const env = envFor(dir);

    const diag = await runCli(['diagnose'], env);
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /is recorded as running but no live process holds the task lock/);
    assert.match(diag.stdout, /may have executed; no action was taken/);
    assert.match(diag.stdout, /"apex task resume 11111111"/);
    assert.equal(readJsonl(path.join(dir, 'tasks.jsonl')).length, 2, 'diagnostics did not change the task log');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl.lock')), false, 'diagnostics created no lock');

    const resumed = await runCli(['task', 'resume', TASK_ID], env);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /recovered from its audit record/);
    assert.doesNotMatch(resumed.stdout, /uncertain/, 'the audit record resolves the outcome');

    const events = readJsonl(path.join(dir, 'tasks.jsonl'));
    assert.ok(events.some((e) => (e.steps ?? []).some((s) => s.id === 's1' && s.to === StepStatus.COMPLETED)),
      'the step is completed as its audit record states');
    assert.equal(events.some((e) => (e.steps ?? []).some((s) => s.to === StepStatus.UNCERTAIN)), false);
    const ops = readJsonl(path.join(dir, 'operations.jsonl'));
    assert.equal(ops.filter((op) => op.capability === 'task.step').length, 1, 'no new step execution was audited');

    const app = createApp({ dataDir: dir });
    const task = await app.taskStore.get(TASK_ID);
    assert.equal(task.status, TaskStatus.COMPLETED);
    const step = task.steps.find((s) => s.id === 's1');
    assert.equal(step.status, StepStatus.COMPLETED);
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.operationId, OP_ID, 'the step stays linked to the record it was recovered from');
  });

  test('an interrupted step without an audit record stays uncertain, and one from another step is rejected', async () => {
    const noRecord = tempDir();
    writeJsonl(path.join(noRecord, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
    ]);
    const noRecordApp = createApp({ dataDir: noRecord });
    const lost = await noRecordApp.controller.runTask(TASK_ID, 'resume');
    assert.equal(lost.status, Outcome.INPUT_REJECTED);
    assert.match(lost.display, /not run again/);
    const lostTask = await noRecordApp.taskStore.get(TASK_ID);
    assert.equal(lostTask.steps[0].status, StepStatus.UNCERTAIN);
    assert.equal(lostTask.steps[0].outcome, null, 'no evidence means no claimed outcome');
    assert.match(lostTask.steps[0].summary, /interrupted before its outcome was recorded/);

    // The audit record names a different step, so it is not evidence about this one.
    const otherStep = tempDir();
    writeJsonl(path.join(otherStep, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
    ]);
    writeJsonl(path.join(otherStep, 'operations.jsonl'), [auditRecord({ stepId: 's2' })]);
    const otherApp = createApp({ dataDir: otherStep });
    const mismatch = await otherApp.controller.runTask(TASK_ID, 'resume');
    assert.equal(mismatch.status, Outcome.INPUT_REJECTED);
    const mismatchTask = await otherApp.taskStore.get(TASK_ID);
    assert.equal(mismatchTask.steps[0].status, StepStatus.UNCERTAIN);
    assert.equal(mismatchTask.steps[0].outcome, null, 'a record for another step proves nothing here');

    // A record that says the step failed is reported as failed, not as uncertain and
    // never as success. It is still not run again.
    const failedRecord = tempDir();
    writeJsonl(path.join(failedRecord, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
    ]);
    writeJsonl(path.join(failedRecord, 'operations.jsonl'), [auditRecord({ status: Outcome.EXECUTION_FAILED })]);
    const failedApp = createApp({ dataDir: failedRecord });
    const recovered = await failedApp.controller.runTask(TASK_ID, 'resume');
    const failedTask = await failedApp.taskStore.get(TASK_ID);
    assert.equal(failedTask.steps[0].status, StepStatus.FAILED);
    assert.equal(failedTask.steps[0].outcome, Outcome.EXECUTION_FAILED);
    assert.notEqual(recovered.status, Outcome.SUCCESS_VERIFIED);
    assert.equal((await failedApp.operations.inspect()).records
      .filter((op) => op.capability === 'task.step').length, 1, 'the failed step was not executed again');
  });

  test('an incomplete audit link is a suspicion and a disagreeing record is a confirmed defect', async () => {
    const missingDir = tempDir();
    writeJsonl(path.join(missingDir, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
      transitionEvent(TASK_ID, 'done', {
        task: { from: 'running', to: 'completed' },
        steps: [{ id: 's1', from: 'running', to: 'completed', outcome: Outcome.SUCCESS_VERIFIED, operationId: OP_ID }],
      }),
    ]);
    const missing = await runCli(['diagnose'], envFor(missingDir));
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Unverified integrity suspicions:/);
    assert.match(missing.stdout, /was not found\. This does not prove the action did not execute\./);
    assert.match(missing.stdout, /do not repeat an action merely because its audit record is missing or inconsistent/);

    const disagreeDir = tempDir();
    writeJsonl(path.join(disagreeDir, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
      transitionEvent(TASK_ID, 'done', {
        task: { from: 'running', to: 'completed' },
        steps: [{ id: 's1', from: 'running', to: 'completed', outcome: Outcome.SUCCESS_VERIFIED, operationId: OP_ID }],
      }),
    ]);
    writeJsonl(path.join(disagreeDir, 'operations.jsonl'), [auditRecord({ status: Outcome.EXECUTION_FAILED })]);
    const disagree = await runCli(['diagnose'], envFor(disagreeDir));
    assert.equal(disagree.code, 1);
    assert.match(disagree.stdout, /Confirmed integrity defects:/);
    assert.match(disagree.stdout, /records outcome success_verified but its audit record says execution_failed/);
  });
});

describe('E. diagnostics', () => {
  test('diagnostics work without a model and remain read-only', async () => {
    const dir = tempDir();
    const before = snapshot(dir);
    const env = envFor(dir);

    const first = await runCli(['diagnose'], env);
    const second = await runCli(['diagnose'], env);
    const status = await runCli(['status'], env);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(status.code, 0, status.stderr);
    assert.match(first.stdout, /Model: not configured/);
    assert.match(first.stdout, /No recovery action needed/);
    assert.equal(fs.existsSync(path.join(dir, 'session.json')), false, 'no session was created');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl.lock')), false, 'no task lock was created');
    assert.deepEqual(snapshot(dir), before, 'diagnostics must not create or change any store');
  });

  test('diagnostics report corruption accurately and never print stored or prompt content', async () => {
    const s = await stub('Stub answer that must stay private.');
    const dir = tempDir();
    const env = envFor(dir, { APEX_MODEL_URL: s.url, APEX_MODEL_NAME: 'stub' });
    const asked = await runCli(['ask', 'the launch codeword is Zephyr'], env);
    assert.equal(asked.code, 0, asked.stderr);
    fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), '{"schema":1}\n{oops\n');

    const diag = await runCli(['diagnose'], env);

    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Knowledge: corrupt/);
    assert.doesNotMatch(diag.stdout, /Zephyr/, 'request and prompt text are not printed');
    assert.doesNotMatch(diag.stdout, /Stub answer that must stay private/, 'stored answer text is not printed');
    assert.doesNotMatch(diag.stdout, /sk-/, 'no credential-like text is printed');
  });

  test('a live task lock is reported as running, not as an interruption', async () => {
    const dir = tempDir();
    writeJsonl(path.join(dir, 'tasks.jsonl'), [
      createdEvent(),
      transitionEvent(TASK_ID, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: OP_ID }],
      }),
    ]);
    writeJsonl(path.join(dir, 'operations.jsonl'), [auditRecord()]);
    const lock = JSON.stringify({ pid: process.pid, at: AT });
    fs.writeFileSync(path.join(dir, 'tasks.jsonl.lock'), lock);
    const before = snapshot(dir);

    const app = createApp({ dataDir: dir });
    const diag = await collectDiagnostics(app);
    const text = renderDiagnostics(diag);

    assert.equal(diag.taskState.runningTasks.length, 1);
    assert.equal(diag.taskState.runningTasks[0].live, true);
    assert.equal(diag.needsAttention, false, 'a task held by a live process is not a defect');
    assert.match(text, /Tasks running now \(task lock held by a live process\):/);
    assert.match(text, new RegExp(`task 11111111 is running under process ${process.pid}`));
    assert.doesNotMatch(text, /may have executed/);
    assert.doesNotMatch(text, /recorded as running but/);
    assert.deepEqual(snapshot(dir), before, 'diagnostics did not touch the lock or the stores');
  });
});

describe('F. acceptance: a multi-step request stays consistent end to end', () => {
  test('a truncated answer with a verified and a denied proposal is reported and persisted honestly', async () => {
    const s = await startStubModel();
    stubs.push(s);
    const content = [
      'The sum is four.',
      'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}',
      'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the sum is four"}}',
    ].join('\n');
    s.behavior.raw = JSON.stringify({
      model: 'stub',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'length' }],
    });
    const app = appOn({ model: s });

    const res = await app.controller.handle('Explain why two plus two is useful, and save the result.', { saveAnswer: true });

    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(res.decision, Decision.REFUSE_OR_BLOCK, 'a denied proposal blocks the request even though answer text exists');
    assert.match(res.display, /cut off at the model output limit/);
    assert.match(res.display, /did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)/);

    assert.deepEqual(
      res.operation.steps.map((step) => `${step.action}:${step.outcome}`),
      ['calc.evaluate:success_verified', 'memory.add:action_denied', 'memory.save_conclusion:success_verified'],
    );
    assert.equal(res.operation.errors.some((e) => e.code === 'TRUNCATED'), true);

    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.equal(turns.find((t) => t.origin === 'model').text, 'The sum is four.',
      'proposal lines and APEX notices are not part of the model turn');
    const actionTurns = turns.filter((t) => t.origin === 'apex_action');
    assert.equal(actionTurns.length, 2);
    assert.equal(actionTurns[0].verified, true);
    assert.equal(actionTurns[1].verified, false);

    const saved = readJsonl(path.join(app.dataDir, 'memory.jsonl')).find((r) => r.kind === 'model_conclusion');
    assert.equal(saved.content, 'The sum is four.', 'the saved conclusion is the model text, not APEX notices');

    const audit = readJsonl(path.join(app.dataDir, 'operations.jsonl')).at(-1);
    assert.equal(audit.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(audit.decision, Decision.REFUSE_OR_BLOCK);
    assert.deepEqual(audit.steps.map((step) => step.outcome), ['success_verified', 'action_denied', 'success_verified']);

    s.behavior.raw = undefined;
    s.behavior.reply = 'Arithmetic helps with everyday estimates.';
    await app.controller.handle('Tell me more about arithmetic.');
    const prompt = promptOf(s, -1);
    assert.match(prompt, /APEX \(model, UNVERIFIED\): The sum is four\./);
    assert.doesNotMatch(prompt, /cut off at the model output limit/,
      'a notice is never replayed as if it were model speech');
  });

  test('a stored fact, a clarification, a proposal, and an interrupted task stay consistent through recovery', async () => {
    const s = await stub('This must not be called yet.');
    const app = appOn({ model: s });

    // 1. In a fresh session an ambiguous request asks before anything is guessed.
    const asked = await app.controller.handle('what is it?');
    assert.equal(asked.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(s.requests.length, 0, 'an unresolved referent never reaches the model');

    // 2. Two user-origin records, stored without any model involvement.
    const stored = await app.controller.handle('remember that the meeting room is B-204');
    assert.equal(stored.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(s.requests.length, 0, 'a deterministic write does not consult the model');
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'design review' });

    // 3. The reply to that question is answered from both stores, while the model's
    // own conclusion and its separately verified read stay distinguishable.
    s.behavior.reply = [
      'The room is B-204, booked for the design review.',
      'PROPOSE_ACTION {"action":"memory.search","input":{"query":"meeting room"}}',
    ].join('\n');
    const answered = await app.controller.handle('which meeting room did I store, and what is it booked for?');
    assert.equal(answered.status, Outcome.VERIFICATION_UNAVAILABLE, 'a model conclusion is never reported as verified');
    assert.equal(answered.decision, Decision.PROPOSE_ACTION, 'a request whose proposal executed is classified as an action, not an answer');
    const prompt = promptOf(s);
    assert.match(prompt, /APEX \(asked the user\): What are you referring to\?/, 'the question this reply answers is in the context');
    assert.match(prompt, /B-204/);
    assert.match(prompt, /meeting room --\[booked_for\]--> design review \[user-supplied fact\]/);
    assert.equal(answered.operation.prompt.knowledgeIds.length, 1);
    assert.deepEqual(answered.operation.steps.map((step) => `${step.action}:${step.outcome}`), ['memory.search:success_verified']);

    // 4. A two-step task loses its process after the first step has been audited.
    const planned = await app.controller.planTask('calc 1+1; calc 2+2');
    assert.equal(planned.status, Outcome.PLAN_CREATED);
    const task = (await app.taskStore.list()).at(-1);

    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (taskId, event) => {
      if (!injected && event.steps?.some((step) => step.to === 'completed')) {
        injected = true;
        throw new Error('simulated process loss after the first step was audited');
      }
      return original(taskId, event);
    };
    await assert.rejects(app.controller.runTask(task.id, 'run'), /simulated process loss/);
    app.taskStore.transition = original;

    const stuck = await app.taskStore.get(task.id);
    assert.equal(stuck.status, TaskStatus.RUNNING, 'the task log still claims a running task');
    assert.equal(readJsonl(path.join(app.dataDir, 'operations.jsonl')).filter((r) => r.capability === 'task.step').length, 1);

    // 5. Recovery resolves the interrupted step from its own audit record, runs only
    // the step that never ran, and never repeats a side effect.
    const resumed = await app.controller.runTask(task.id, 'resume');
    assert.equal(resumed.status, Outcome.SUCCESS_VERIFIED);
    const done = await app.taskStore.get(task.id);
    assert.equal(done.status, TaskStatus.COMPLETED);
    assert.deepEqual(done.steps.map((step) => `${step.status}:${step.outcome}`),
      ['completed:success_verified', 'completed:success_verified']);
    assert.ok(done.steps[0].summary.includes('recovered from its audit record'), 'the recovery is stated, not hidden');
    const stepAudit = readJsonl(path.join(app.dataDir, 'operations.jsonl')).filter((r) => r.capability === 'task.step');
    assert.equal(stepAudit.length, 2, 'each step was executed and audited exactly once');
    assert.equal(new Set(stepAudit.map((r) => r.task.stepId)).size, 2);

    // 6. History and audit carry the session, each part labelled as what it is.
    const turns = readJsonl(path.join(app.dataDir, 'conversation.jsonl'));
    assert.ok(turns.some((t) => t.origin === 'apex_question' && /What are you referring to/.test(t.text)));
    assert.equal(turns.some((t) => t.origin === 'model' && /PROPOSE_ACTION/.test(t.text)), false,
      'proposal lines are not stored as model speech');
    assert.ok(turns.some((t) => t.origin === 'apex_action' && t.verified && /matching memory record\(s\) \(verified\)/.test(t.text)),
      'the verified model-proposed read is replayable history, without copying stored content');
    // Pinned known limitation: `task run` and `task resume` write no conversation
    // turn, so a task's step results live only in the task log and the audit. A
    // follow-up question after a task run therefore cannot see what it produced.
    assert.equal(turns.some((t) => /2\+2 = 4/.test(t.text)), false, 'task steps are not replayed as conversation');
    const ops = readJsonl(path.join(app.dataDir, 'operations.jsonl'));
    assert.ok(ops.length >= 7, `${ops.length} operation(s) audited for the session`);
    assert.equal(ops.some((r) => r.status === Outcome.AUDIT_INTEGRITY_FAILED), false);
    assert.equal(ops.at(-1).task.status, TaskStatus.COMPLETED, 'the recovered task result is in the audit');

    // 7. Diagnostics agree with the recovered state and find no defect.
    const diag = await runCli(['diagnose'], envFor(app.dataDir));
    assert.equal(diag.code, 0, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Memory: ok \(1 record/);
    assert.doesNotMatch(diag.stdout, /no live process holds the task lock/);
    assert.doesNotMatch(diag.stdout, /CONFIRMED DEFECT/);
  });
});
