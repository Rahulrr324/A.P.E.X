// Implementation 100: what the audit and conversation stores keep about credentials.
//
// The distinction this suite holds: the user-visible presentation may show the model's text
// as it arrived, the conversation store replaces a turn that contains credential-like text,
// and the audit keeps the event (status, capability, ids, timing) but removes a
// credential-like substring from its output and marks the record as minimized. Only
// synthetic credentials are used. Detection is heuristic, so these tests prove the listed
// formats, not every possible secret.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OperationLog } from '../src/operations/operation-log.js';
import { OPERATION_SCHEMA, Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const API_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
const PASSWORD = 'hunter2value';

function operation(overrides = {}) {
  return {
    schema: OPERATION_SCHEMA,
    app: 'APEX',
    stage: 'test',
    id: 'op-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
    origin: 'user',
    request: null,
    capability: 'model.answer',
    retrieval: [],
    prompt: null,
    backend: 'stub',
    model: 'stub',
    steps: [],
    status: Outcome.VERIFICATION_UNAVAILABLE,
    decision: null,
    output: null,
    errors: [],
    finishedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function records(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

async function stubModel(reply) {
  const s = await startStubModel();
  stubs.push(s);
  s.behavior.reply = reply;
  return s;
}

function cliEnv(model, dataDir) {
  return cleanEnv({
    APEX_DATA_DIR: dataDir,
    HOME: dataDir,
    USERPROFILE: dataDir,
    APEX_MODEL_URL: model.url,
    APEX_MODEL_PROVIDER: 'openai',
    APEX_MODEL_NAME: 'stub',
    APEX_MODEL_TIMEOUT_MS: '5000',
    APEX_MODEL_RETRIES: '0',
  });
}

describe('100: credential-like text is minimized at the audit boundary', () => {
  test('a model answer containing a credential is stored with the match removed and the record marked', async () => {
    const dir = tempDir();
    const log = new OperationLog(path.join(dir, 'operations.jsonl'));
    const op = operation({ output: `The key is ${API_KEY} and the password is ${PASSWORD}.` });

    await log.append(op);

    const [stored] = records(path.join(dir, 'operations.jsonl'));
    assert.equal(stored.id, 'op-1');
    assert.equal(stored.status, Outcome.VERIFICATION_UNAVAILABLE, 'the event and outcome are unchanged');
    assert.equal(stored.capability, 'model.answer');
    assert.equal(stored.outputMinimized, true, 'the record says its output is not verbatim');
    assert.equal(stored.output, 'The key is [redacted-secret] and the [redacted-secret]');
    const raw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    assert.equal(raw.includes(API_KEY), false, 'the API key is not on disk');
    assert.equal(raw.includes(PASSWORD), false, 'the password is not on disk');
    assert.equal(op.output.includes(API_KEY), true, 'the caller object is not rewritten by persistence');
  });

  test('an answer without credential-like text is stored unchanged and without the marker', async () => {
    const dir = tempDir();
    const log = new OperationLog(path.join(dir, 'operations.jsonl'));
    await log.append(operation({ output: 'Paris is the capital of France.' }));

    const [stored] = records(path.join(dir, 'operations.jsonl'));
    assert.equal(stored.output, 'Paris is the capital of France.');
    assert.equal('outputMinimized' in stored, false, 'an unmodified record is not marked');
  });

  test('end to end: the terminal shows the model text, history omits the turn, audit minimizes the output', async () => {
    const dir = tempDir();
    const model = await stubModel(`The key is ${API_KEY} and the password is ${PASSWORD}.`);

    const res = await runCli(['ask', 'repeat the secret'], cliEnv(model, dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(res.stdout.includes(API_KEY), true, 'the user-visible presentation is not silently altered');

    const ops = records(path.join(dir, 'operations.jsonl'));
    const answer = ops.find((op) => op.capability === 'model.answer');
    assert.ok(answer, JSON.stringify(ops));
    assert.equal(answer.outputMinimized, true);
    assert.equal(answer.output.includes(API_KEY), false);
    assert.equal(answer.output.includes(PASSWORD), false);
    const auditRaw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    assert.equal(auditRaw.includes(API_KEY), false);

    const turns = records(path.join(dir, 'conversation.jsonl'));
    const reply = turns.find((t) => t.role === 'assistant');
    assert.equal(reply.text, '[omitted: contained a password, key, or token]', 'history keeps no part of the credential');
    const conversationRaw = fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8');
    assert.equal(conversationRaw.includes(API_KEY), false);
    assert.equal(conversationRaw.includes(PASSWORD), false);
  });

  test('a request that contains a credential is still answered, but not copied into the audit request field', async () => {
    const dir = tempDir();
    const model = await stubModel('Acknowledged.');

    const res = await runCli(['ask', `my password is ${PASSWORD}`], cliEnv(model, dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(model.requests.length, 1, 'the request reached the configured model, as documented');
    assert.match(JSON.stringify(model.requests[0]), new RegExp(PASSWORD), 'the model call is not the persistence boundary');

    const [op] = records(path.join(dir, 'operations.jsonl'));
    assert.equal(op.request, '[request omitted: contained a password, key, or token]');
    assert.equal(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').includes(PASSWORD), false);
    assert.equal(fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8').includes(PASSWORD), false);
  });
});
