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
    assert.equal(turns.some((t) => t.origin === 'model' && t.text.includes('</think>')), true,
      'the stored turn is the same unmodified model text');
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

  test('an interrupted running task is reported, and resume records uncertainty without replaying it', async () => {
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
    assert.equal(resumed.code, 1, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /uncertain and was not run again/);

    const events = readJsonl(path.join(dir, 'tasks.jsonl'));
    assert.ok(events.some((e) => (e.steps ?? []).some((s) => s.id === 's1' && s.to === StepStatus.UNCERTAIN)));
    assert.equal(events.some((e) => (e.steps ?? []).some((s) => s.to === StepStatus.COMPLETED)), false, 'the step was not executed again');
    const ops = readJsonl(path.join(dir, 'operations.jsonl'));
    assert.equal(ops.filter((op) => op.capability === 'task.step').length, 1, 'no new step execution was audited');

    const app = createApp({ dataDir: dir });
    const task = await app.taskStore.get(TASK_ID);
    assert.equal(task.status, TaskStatus.PAUSED);
    assert.equal(task.steps.find((s) => s.id === 's1').status, StepStatus.UNCERTAIN);
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
