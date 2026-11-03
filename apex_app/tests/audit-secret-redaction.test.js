// Batch AF: what reaches the disk and what reaches a reader when text looks like a credential.
//
// Every assertion here inspects the serialized bytes of a real store file, not the in-memory result
// of a redaction call, because the defect this suite holds was a writer that filtered one field and
// copied the rest. The synthetic values are unmistakably not real credentials. Detection is a
// heuristic, so the suite pins the listed formats and the shape of the boundary - a record that
// loses text says so in a marker - rather than claiming every possible secret is caught.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OperationLog, minimizeOperation, scanCredentialShapedRecords } from '../src/operations/operation-log.js';
import { TaskStore } from '../src/tasks/store.js';
import { inputHash } from '../src/tasks/model.js';
import { OPERATION_SCHEMA, Outcome } from '../src/outcomes.js';
import { SECRET_OMITTED, containsSecret } from '../src/security/secrets.js';
import { createApp } from '../src/app.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// Synthetic, never real. Each carries the SYNTHETIC-NOT-REAL marker inside it.
const S = {
  apiKey: 'sk-SYNTHETICNOTAREALKEY00000',
  aws: 'AKIASYNTHETICNOTREAL',
  bearer: 'Bearer SYNTHETIC.TOKEN_NOT_REAL_v1',
  password: 'password: SYNTHETIC_NOT_REAL_PW_42',
  assignment: 'api_key=SYNTHETIC_NOT_REAL_GUIDANCE_123456',
  keyBody: 'c3ludGhldGljLW5vdC1hLXJlYWwtcHJpdmF0ZS1rZXk',
};
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${S.keyBody}\n${S.keyBody}\n-----END OPENSSH PRIVATE KEY-----`;
const ALL_SYNTH = [S.apiKey, S.aws, S.bearer, S.password, S.assignment, S.keyBody, 'SYNTHETIC_NOT_REAL'];

function operation(overrides = {}) {
  return {
    schema: OPERATION_SCHEMA,
    app: 'APEX',
    stage: 'test',
    id: 'op-af',
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

function logIn(dir) {
  const file = path.join(dir, 'operations.jsonl');
  return { log: new OperationLog(file), file, raw: () => fs.readFileSync(file, 'utf8') };
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function assertNoSecret(raw) {
  for (const value of ALL_SYNTH) {
    assert.equal(raw.includes(value), false, `the persisted bytes must not contain ${value}`);
  }
}

async function appendOne(dir, op) {
  const { log, file } = logIn(dir);
  await log.append(op);
  return { record: lines(file)[0], raw: fs.readFileSync(file, 'utf8'), file };
}

// A record written by an older build, whose boundary only filtered `output`. It is left exactly
// as it is: this is the historical-leakage case, and the reader is the boundary that must hold.
const HISTORICAL = {
  schema: 1, app: 'APEX', stage: 'Local Alpha', id: 'hist-1', requestedAt: '2025-01-01T00:00:00.000Z',
  origin: 'user', request: `feedback record guidance ${S.assignment}`, capability: 'feedback.record',
  retrieval: [], prompt: null, backend: null, model: null,
  steps: [{ action: 'feedback.record', origin: 'user', input: { guidance: S.assignment }, summary: 'input rejected' }],
  status: 'input_rejected', decision: 'refuse_or_block',
  output: 'input rejected: guidance looks like a password, key, or token', errors: [],
  finishedAt: '2025-01-01T00:00:01.000Z',
};

// Writes one pre-fix line into a fresh log and returns the file plus the exact bytes it holds.
function historicalLog(dir, record = HISTORICAL) {
  const file = path.join(dir, 'operations.jsonl');
  const bytes = `${JSON.stringify(record)}\n`;
  fs.writeFileSync(file, bytes, 'utf8');
  return { file, bytes };
}

function envFor(dir) {
  return cleanEnv({
    APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir,
    APEX_MODEL_URL: 'http://127.0.0.1:9/v1', APEX_MODEL_PROVIDER: 'openai', APEX_MODEL_NAME: 'stub',
    APEX_MODEL_TIMEOUT_MS: '1500', APEX_MODEL_RETRIES: '0',
  });
}

describe('AF: the audit write boundary masks the whole record, not one field', () => {
  test('a credential inside a step input is absent from the bytes and the record says it was masked', async () => {
    const op = operation({
      capability: 'feedback.record',
      status: Outcome.INPUT_REJECTED,
      steps: [{
        action: 'feedback.record',
        origin: 'user',
        input: { target: '11111111-1111-4111-8111-111111111111', assessment: 'incorrect', guidance: S.assignment },
        summary: `input rejected: ${S.assignment}`,
      }],
    });
    const { record, raw } = await appendOne(tempDir(), op);

    assertNoSecret(raw);
    assert.equal(record.steps[0].input.guidance, SECRET_OMITTED);
    assert.equal(record.steps[0].summary, SECRET_OMITTED, 'a summary that quotes the value is replaced with it');
    assert.equal(record.secretsMasked, true, 'the record marks that a leaf was omitted');
    assert.equal(record.status, Outcome.INPUT_REJECTED, 'the outcome is unchanged');
    assert.equal(record.capability, 'feedback.record');
    assert.equal(record.steps[0].action, 'feedback.record', 'the command itself stays visible');
    assert.equal(op.steps[0].input.guidance, S.assignment, 'persistence does not rewrite the caller object');
  });

  test('a credential-shaped value in a field nobody declared is caught by content alone', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      unexpectedBlob: { inner: [{ deep: `here is the value ${S.apiKey}` }] },
    }));
    assertNoSecret(raw);
    assert.equal(record.unexpectedBlob.inner[0].deep, SECRET_OMITTED);
    assert.equal(record.secretsMasked, true);
  });

  test('a field named like a credential is omitted even when its content matches no pattern', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      steps: [{ action: 'x', input: { apiKey: 'plainlooking', notes: 'plainlooking' } }],
    }));
    assert.equal(record.steps[0].input.apiKey, SECRET_OMITTED, 'the name alone is enough');
    assert.equal(record.steps[0].input.notes, 'plainlooking', 'the same value under an ordinary name is kept');
    assertNoSecret(raw);
  });

  test('a credential carried in a field name is masked as surely as a value', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      steps: [{ action: 'x', input: { [S.assignment]: 'plainlooking', alsoKnownAs: 'kept' } }],
    }));
    assertNoSecret(raw);
    assert.equal(record.steps[0].input[S.assignment], undefined, 'the name itself was the secret, so it is not kept as a name');
    assert.equal(record.steps[0].input['[redacted-secret]'], 'plainlooking', 'the value under it is still there, attributed to a withheld name');
    assert.equal(record.steps[0].input.alsoKnownAs, 'kept', 'an ordinary name next to it is untouched');
    assert.equal(record.secretsMasked, true, 'a masked name counts as masking, so the record says so');
  });

  test('two credential-shaped names are both kept, distinguishably', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      steps: [{ action: 'x', input: { [S.assignment]: 'first', [`password: ${S.aws}`]: 'second' } }],
    }));
    assertNoSecret(raw);
    assert.deepEqual(record.steps[0].input,
      { '[redacted-secret]': 'first', '[redacted-secret] 2': SECRET_OMITTED },
      'renaming must not merge two refused fields into one, and a name that also reads as a credential field still omits its value');
  });

  test('a private key loses its body: the whole output is omitted, not only the header', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({ output: `the key was:\n${PRIVATE_KEY}` }));
    assertNoSecret(raw);
    assert.equal(record.output, SECRET_OMITTED);
    assert.equal(record.outputMinimized, true);
    assert.equal('secretsMasked' in record, false, 'the output rule marks itself with outputMinimized');
  });

  test('output prose survives: only the matched substring is removed from the model answer', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      output: `The AWS access key id is ${S.aws} for that account.`,
    }));
    assert.equal(record.output, 'The AWS access key id is [redacted-secret] for that account.');
    assert.equal(record.outputMinimized, true);
    assert.equal('secretsMasked' in record, false, 'a minimized output is still the model sentence');
    assertNoSecret(raw);
  });

  test('a credential in an error message or a retrieval entry is masked too', async () => {
    const { record, raw } = await appendOne(tempDir(), operation({
      errors: [{ stage: 'input', code: 'SECRET_REFUSED', message: `rejected ${S.password}` }],
      retrieval: [{ id: 'm1', content: `note ${S.bearer}` }],
    }));
    assertNoSecret(raw);
    assert.equal(record.errors[0].message, SECRET_OMITTED);
    assert.equal(record.errors[0].code, 'SECRET_REFUSED', 'the reason for the refusal is kept');
    assert.equal(record.retrieval[0].content, SECRET_OMITTED);
    assert.equal(record.retrieval[0].id, 'm1');
  });

  test('every listed credential format is masked, in any nesting, whatever the wrapper', async () => {
    const variants = {
      'api key token': S.apiKey,
      'aws access key id': S.aws,
      'bearer token': S.bearer,
      'mixed case bearer': S.bearer.replace('Bearer', 'BEARER'),
      'password assignment': S.password,
      'equals assignment': S.assignment,
      'quoted assignment': `password = "SYNTHETIC_NOT_REAL_QUOTED_7"`,
      'space before colon': 'password : SYNTHETIC_NOT_REAL_SPACED_8',
      'tab separator': 'password:\tSYNTHETIC_NOT_REAL_TABBED_9',
      'non-breaking space': 'password:\u00a0SYNTHETIC_NOT_REAL_NBSP_10',
      'newline separator': `password:\nSYNTHETIC_NOT_REAL_NEWLINE_11`,
      'accented value': 'password: SYNTHÉTIQUE_NOT_REAL_12',
      'long value': `password: SYNTHETIC_NOT_REAL_${'x'.repeat(4000)}`,
      'embedded in prose': 'I keep the whole sentence readable but the key is sk-SYNTHETICNOTAREALKEY00000 inside it.',
    };
    const dir = tempDir();
    const { log } = logIn(dir);
    for (const [index, [name, text]] of Object.entries(variants).entries()) {
      await log.append(operation({
        id: `op-var-${index}`,
        capability: 'test.variant',
        steps: [{ action: 'test.variant', input: { name, nested: { list: [text] } } }],
      }));
    }
    const raw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    assertNoSecret(raw);
    assert.equal(raw.includes('SYNTHETIC'), false, 'no synthetic marker survives anywhere in the log');
    const stored = lines(path.join(dir, 'operations.jsonl'));
    assert.equal(stored.length, Object.keys(variants).length);
    assert.equal(stored.filter((r) => r.secretsMasked === true).length, stored.length, 'each variant is marked');
    for (const [index, record] of stored.entries()) {
      assert.equal(record.steps[0].input.name, Object.keys(variants)[index], 'which field was refused stays readable');
      assert.equal(record.steps[0].input.nested.list[0], SECRET_OMITTED);
    }
    const { corrupt } = await log.inspect();
    assert.equal(corrupt.length, 0, 'every masked record is still a valid audit record');
  });

  test('false positives are left byte-for-byte readable', async () => {
    const clean = [
      'The password field accepts any length you like.',
      'She pinned the notice to the board.',
      'AKIA is only an example prefix in these docs.',
      'sk- is the prefix that API keys often use.',
      'Tokens are issued per session and expire hourly.',
      'The api_key column stores a hash, not a value.',
      'Set the monkey and mapping keys before the run.',
      'Bearer is the scheme name; the value follows it.',
    ];
    const dir = tempDir();
    const { log, file } = logIn(dir);
    for (const [index, text] of clean.entries()) {
      await log.append(operation({ id: `op-clean-${index}`, output: text, steps: [{ action: 'a', input: { summary: text } }] }));
    }
    const stored = lines(file);
    assert.equal(stored.length, clean.length);
    for (const [index, record] of stored.entries()) {
      assert.equal(record.output, clean[index], 'clean prose is stored exactly as it arrived');
      assert.equal(record.steps[0].input.summary, clean[index]);
      assert.equal('outputMinimized' in record, false);
      assert.equal('secretsMasked' in record, false, 'an unmodified record is not marked');
    }
    assert.equal(fs.readFileSync(file, 'utf8').includes(SECRET_OMITTED), false);
  });

  test('the boundary is deterministic and idempotent', async () => {
    const op = operation({ steps: [{ action: 'a', input: { guidance: S.assignment } }], output: `key ${S.aws} here` });
    const first = minimizeOperation(op);
    const second = minimizeOperation(op);
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'same input, same bytes');
    assert.equal(JSON.stringify(first), JSON.stringify(minimizeOperation(first)), 'masking an already masked record changes nothing');
    const keys = Object.keys(first);
    assert.deepEqual(keys.slice(0, Object.keys(op).length), Object.keys(op), 'the original keys keep their order; markers are appended');
    assert.deepEqual(Object.keys(first).slice(-2), ['outputMinimized', 'secretsMasked'], 'the markers say what the boundary did');

    const dir = tempDir();
    const { log, file } = logIn(dir);
    await log.append(op);
    const afterFirst = fs.readFileSync(file, 'utf8');
    await log.append(op);
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst + afterFirst, 'two appends of one input write identical lines');
    assertNoSecret(fs.readFileSync(file, 'utf8'));
  });

  test('the node budget stops the walk, the record says so, and masking stays bounded', async () => {
    const many = Array.from({ length: 6000 }, (_, i) => `row ${i}`);
    const started = Date.now();
    const record = minimizeOperation(operation({ retrieval: many.map((text) => ({ content: text })) }));
    const elapsed = Date.now() - started;
    assert.equal(record.auditMaskBoundReached, true);
    assert.equal(record.retrieval.length, 6000, 'the shape is preserved so the count is still evidence');
    assert.ok(elapsed < 2000, `masking must stay bounded, took ${elapsed}ms`);

    const { raw } = await appendOne(tempDir(), operation({ retrieval: many.map((text) => ({ content: text })) }));
    assert.equal(raw.includes('[omitted: audit masking bound reached]'), true);
  });

  test('a record that cannot be minimized is reduced to a bounded shell, never to its raw text', async () => {
    const dir = tempDir();
    const { log, file } = logIn(dir);
    const op = operation({
      request: `typed ${S.password}`,
      output: `said ${S.apiKey}`,
      steps: [{ action: 'x', input: { guidance: S.password } }],
    });
    // A field the shell does not consult is still read while the body is being copied, so one
    // unreadable field has to take the whole minimization down with it.
    Object.defineProperty(op, 'notes', { enumerable: true, get() { throw new Error('hostile getter'); } });
    await log.append(op);

    const raw = fs.readFileSync(file, 'utf8');
    assertNoSecret(raw);
    const record = lines(file)[0];
    assert.equal(record.auditMinimizationFailed, true);
    assert.equal(record.id, 'op-af', 'the event is still identifiable');
    assert.equal(record.status, Outcome.VERIFICATION_UNAVAILABLE, 'the outcome is still reported');
    assert.equal(record.capability, 'model.answer');
    assert.equal(record.request, '[omitted: audit minimization failed]');
    assert.equal(record.output, '[omitted: audit minimization failed]');
    assert.equal(record.stepCount, 1, 'the count survives even when the body does not');
    assert.equal(record.errors[0].code, 'MINIMIZATION_FAILED');
    assert.equal(record.errors[0].message.includes(S.password), false, 'the fallback reason names no value');
    const { corrupt } = await log.inspect();
    assert.equal(corrupt.length, 0, 'a shell is a valid audit record, not damage');
  });

  test('shell metadata is bounded, so a hostile field cannot smuggle text', async () => {
    const op = operation({ capability: `${S.apiKey}${' long '.repeat(400)}`, status: 'not_a_real_status' });
    Object.defineProperty(op, 'errors', { enumerable: true, get() { throw new Error('hostile getter'); } });
    const { record, raw } = await appendOne(tempDir(), op);
    assertNoSecret(raw);
    assert.equal(record.capability, null, 'an over-long metadata field is dropped rather than stored');
    assert.equal(record.status, Outcome.AUDIT_INTEGRITY_FAILED, 'an unknown status is not restated as a real outcome');
    assert.equal(record.auditMinimizationFailed, true);
  });

  test('a record that is not an object is refused and nothing is appended', async () => {
    const dir = tempDir();
    const { log, file } = logIn(dir);
    await assert.rejects(() => log.append(null), /audit record is not an object/);
    await assert.rejects(() => log.append('a line of text'), /audit record is not an object/);
    await assert.rejects(() => log.append([operation()]), /audit record is not an object/);
    assert.equal(fs.existsSync(file), false, 'a refused append writes no bytes');
  });
});

describe('AF: the task log is behind the same boundary', () => {
  function taskStore(dir) {
    const file = path.join(dir, 'tasks.jsonl');
    return { store: new TaskStore(file, { now: () => new Date('2026-01-01T00:00:00.000Z'), idFactory: () => 'ev-1' }), file };
  }

  test('a model-proposed step input with a credential is masked before it is written', async () => {
    const dir = tempDir();
    const { store, file } = taskStore(dir);
    const created = await store.createTask({
      taskId: 'task-af',
      goal: 'refresh the report',
      origin: 'model',
      planner: 'model',
      steps: [{ id: 'step1', description: 'store the note', action: 'memory.add', permission: 'write', input: { content: S.password }, dependsOn: [] }],
    });
    const raw = fs.readFileSync(file, 'utf8');
    assertNoSecret(raw);
    assert.equal(created.secretsMasked, true);
    assert.equal(JSON.parse(raw).steps[0].input.content, SECRET_OMITTED);
    assert.equal(created.steps[0].input.content, SECRET_OMITTED, 'the caller gets the bytes the log holds');

    const task = await store.get('task-af');
    assert.equal(task.steps[0].input.content, SECRET_OMITTED, 'the replayed state matches the log');
    assert.equal(inputHash(task.steps[0].input), inputHash(created.steps[0].input), 'an approval hash is stable across a restart');
  });

  test('a clean plan is written unchanged', async () => {
    const dir = tempDir();
    const { store, file } = taskStore(dir);
    const created = await store.createTask({
      taskId: 'task-clean',
      goal: 'list the files in the project',
      origin: 'user',
      planner: 'deterministic',
      steps: [{ id: 'step1', description: 'list', action: 'fs.list', permission: 'read', input: { path: '.' }, dependsOn: [] }],
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).steps[0].input.path, '.');
    assert.equal('secretsMasked' in created, false);
  });
});

describe('AF: the three reported leaks, end to end through the real CLI', () => {
  function env(dir) {
    return cleanEnv({
      APEX_DATA_DIR: dir,
      HOME: dir,
      USERPROFILE: dir,
      APEX_MODEL_URL: 'http://127.0.0.1:9/v1',
      APEX_MODEL_PROVIDER: 'openai',
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '1500',
      APEX_MODEL_RETRIES: '0',
    });
  }

  const cases = [
    { name: 'feedback record with credential-shaped guidance', args: ['feedback', 'record', '11111111-1111-4111-8111-111111111111', '--assessment', 'incorrect', '--guidance', S.assignment], capability: 'feedback.record', field: 'guidance' },
    { name: 'experience record with a credential-shaped subject', args: ['experience', 'record', '00000000-0000-4000-8000-000000000000', '--subject', 'password: SYNTHETIC_NOT_REAL_SUBJECT_654321'], capability: 'experience.record', field: 'subject' },
    { name: 'adaptation approve with a credential-shaped reason', args: ['adaptation', 'approve', '11111111-1111-4111-8111-111111111111', '--reason', 'token=SYNTHETIC_NOT_REAL_REASON_abcdef'], capability: 'adaptation.approve', field: 'reason' },
  ];

  for (const testCase of cases) {
    test(`${testCase.name}: refused, disclosed without the value, and absent from every store`, async () => {
      const dir = tempDir();
      const res = await runCli(testCase.args, env(dir));
      assert.equal(res.code, 1, `a rejected input must not exit 0: ${res.stdout}${res.stderr}`);
      const combined = `${res.stdout}${res.stderr}`;
      assert.match(combined, /looks like a password, key, or token/, 'the refusal names why');
      assert.match(combined, new RegExp(testCase.field), 'the refusal names which field');
      assertNoSecret(combined);

      const raw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
      assertNoSecret(raw);
      assert.equal(raw.includes(SECRET_OMITTED), true, 'the audit record shows the omission instead of the value');
      const [op] = lines(path.join(dir, 'operations.jsonl'));
      assert.equal(op.capability, testCase.capability, 'the record still identifies what was attempted');
      assert.equal(op.status, Outcome.INPUT_REJECTED);
      assert.equal(op.steps[0].input[testCase.field], SECRET_OMITTED);

      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'operations.jsonl') continue;
        const full = path.join(dir, entry);
        if (!fs.statSync(full).isFile()) continue;
        assertNoSecret(fs.readFileSync(full, 'utf8'));
      }
    });
  }

  test('a rejected request is still answered when it holds no credential shape, and the audit request is masked when it does', async () => {
    const dir = tempDir();
    const model = await startStubModel();
    stubs.push(model);
    model.behavior.reply = 'Noted.';
    const res = await runCli(['ask', `my password is ${S.password.split(': ')[1]}`], cleanEnv({
      APEX_DATA_DIR: dir,
      HOME: dir,
      USERPROFILE: dir,
      APEX_MODEL_URL: model.url,
      APEX_MODEL_PROVIDER: 'openai',
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '5000',
      APEX_MODEL_RETRIES: '0',
    }));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(model.requests.length, 1, 'the documented boundary: the model call is not the persistence boundary');
    const raw = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8');
    assert.equal(raw.includes('SYNTHETIC_NOT_REAL_PW_42'), false);
    assert.equal(raw.includes('[request omitted'), true);
  });
});

describe('AF: readers of an existing log do not reprint what they find', () => {
  test('history redacts a leaked value on read and rewrites nothing', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);

    const res = await runCli(['history', '--limit', '5'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assertNoSecret(res.stdout);
    assert.match(res.stdout, /hist-1/, 'the record is still listed as evidence');
    assert.equal(res.stdout.includes('feedback.record'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a read never rewrites historical bytes');
  });

  test('diagnose reports the log without printing a stored body', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);
    const res = await runCli(['diagnose'], envFor(dir));
    assertNoSecret(`${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });

  test('the same value still reaches a caller that asked for the record, so redaction is a print-side rule', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'operations.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(HISTORICAL)}\n`, 'utf8');
    const { log } = logIn(dir);
    const { records, corrupt } = await log.inspect();
    assert.equal(corrupt.length, 0, 'a pre-fix record is still a valid record');
    assert.equal(records[0].id, 'hist-1');
    assert.equal(containsSecret(records[0].request), true, 'documented limitation: history is not rewritten, so an old line still holds what it was given');
  });
});

describe('AF: historical leakage is reported as a finding, never repaired silently', () => {
  test('audit health counts a record written before the mask and prints no value', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);
    const res = await runCli(['audit', 'health'], envFor(dir));
    assert.equal(res.code, 1, 'a credential-shaped value on disk requires attention even when every line parses');
    assert.match(res.stdout, /ok - fully inspected/, 'the log is readable: this is not reported as parse damage');
    assert.match(res.stdout, /Corrupt lines:\s+0/);
    assert.match(res.stdout, /Credential-shaped: 1 record\(s\)/);
    assert.match(res.stdout, /operation \[hist-1\]/);
    assert.match(res.stdout, /never rewritten/, 'the report states that APEX will not edit the line');
    assertNoSecret(`${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a read never rewrites historical bytes');
  });

  test('diagnose states the disclosure, gives remediation, and prints no value', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);
    const res = await runCli(['diagnose'], envFor(dir));
    assert.match(res.stdout, /Overall: attention required/);
    assert.match(res.stdout, /Audit: ok/, 'the audit subsystem stays ok: a stored credential is not damage');
    assert.match(res.stdout, /1 operation record\(s\) hold text that looks like a password, key, or token/);
    assert.match(res.stdout, /Audit credential exposure/);
    assert.match(res.stdout, /rotate it where it was issued/, 'the remediation is what the user can still do');
    assert.match(res.stdout, /APEX does not rewrite or delete operations\.jsonl/);
    assert.equal(res.code, 1, `a confirmed finding is attention: ${res.stdout}${res.stderr}`);
    assertNoSecret(`${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });

  test('new writes into a log that already holds a pre-fix leak are masked and the old line is untouched', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);
    const { log } = logIn(dir);
    await log.append(operation({ id: 'op-after', steps: [{ action: 'feedback.record', input: { guidance: S.assignment } }] }));
    assert.equal(fs.readFileSync(file, 'utf8').startsWith(bytes), true, 'the historical line is byte-identical');
    const health = await log.health();
    assert.equal(health.records, 2);
    assert.equal(health.credentials.matched, 1, 'a record the boundary masked is not counted as disclosed');
    assert.deepEqual(health.credentials.samples, ['hist-1']);
    assertNoSecret(fs.readFileSync(file, 'utf8').slice(bytes.length));
  });

  test('damage next to a disclosed record is still reported as damage', async () => {
    const dir = tempDir();
    const { file, bytes } = historicalLog(dir);
    fs.appendFileSync(file, '{not a record\n', 'utf8');
    const { log } = logIn(dir);
    const health = await log.health();
    assert.equal(health.state, 'damaged');
    assert.equal(health.corruptLines, 1);
    assert.equal(health.credentials.matched, 1, 'the readable record is counted even though the log is damaged');
    const res = await runCli(['audit', 'health'], envFor(dir));
    assert.equal(res.code, 1);
    assert.match(res.stdout, /damaged - 1 corrupt line/);
    assertNoSecret(res.stdout);
    assert.equal(fs.readFileSync(file, 'utf8'), `${bytes}{not a record\n`, 'a damaged log is never repaired by a read');
  });

  test('the sample list is capped and says how many records it withheld', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'operations.jsonl');
    const many = Array.from({ length: 25 }, (_, i) => ({ ...HISTORICAL, id: `hist-${i}` }));
    fs.writeFileSync(file, `${many.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    const { log } = logIn(dir);
    const health = await log.health();
    assert.equal(health.credentials.matched, 25);
    assert.equal(health.credentials.samples.length, 20, 'one report cannot print an unbounded list');
    assert.equal(health.credentials.partial, false, 'a capped sample list is not a capped scan');
    const res = await runCli(['audit', 'health'], envFor(dir));
    assert.match(res.stdout, /5 more such record\(s\) not shown/);
    assertNoSecret(res.stdout);
  });

  test('the scan bound is announced instead of silently truncating the count', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ ...HISTORICAL, id: `hist-${i}` }));
    const bounded = scanCredentialShapedRecords(records, { max: 2 });
    assert.deepEqual(bounded, { matched: 2, scanned: 2, partial: true, samples: ['hist-0', 'hist-1'] });
    const whole = scanCredentialShapedRecords(records);
    assert.equal(whole.matched, 5);
    assert.equal(whole.partial, false);
    assert.equal(scanCredentialShapedRecords([]).matched, 0);
    assert.equal(scanCredentialShapedRecords(null).matched, 0, 'an unreadable input yields a count of zero, not an error in a read-only report');
  });

  test('reading an old record back adds no marker and no recomputed outcome', async () => {
    const dir = tempDir();
    const verified = { ...HISTORICAL, id: 'hist-ok', status: Outcome.SUCCESS_VERIFIED, decision: 'allow', output: 'listed 3 file(s)' };
    const { file, bytes } = historicalLog(dir, verified);
    const { log } = logIn(dir);
    const { records, corrupt } = await log.inspect();
    assert.equal(corrupt.length, 0);
    assert.equal(`${JSON.stringify(records[0])}\n`, bytes, 'a read replays the stored bytes rather than restating them');
    assert.equal(records[0].status, Outcome.SUCCESS_VERIFIED, 'the recorded outcome is reported as it was recorded');
    assert.equal('secretsMasked' in records[0], false, 'a boundary this record never passed through is not stamped onto it');
    assert.equal('outputMinimized' in records[0], false);
    const health = await log.health();
    assert.equal(health.outcomes.success_verified, 1, 'a disclosed value does not turn a verified record into a failed one');
    assert.equal(health.credentials.matched, 1, 'and it is still reported as disclosed');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });

  test('a clean log is not made to look alarmed', async () => {
    const dir = tempDir();
    const { log } = logIn(dir);
    await log.append(operation({ steps: [{ action: 'fs.list', input: { path: '.' }, summary: 'listed 3 file(s)' }] }));
    const health = await log.health();
    assert.equal(health.credentials.matched, 0);
    assert.equal(health.attention, false);
    const res = await runCli(['audit', 'health'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(res.stdout.includes('Credential-shaped'), false, 'a finding that does not exist is not announced');
  });
});

describe('AF: a refusal explains itself without repeating the value', () => {
  test('an unexpected field whose name is credential-shaped is refused by description', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const step = await app.controller.runAction('memory.add', { content: 'a plain note', [S.apiKey]: 1 }, 'user', 'op-af-07');
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.match(step.summary, /unexpected input field/, 'the reader still learns what kind of mistake this was');
    assert.match(step.summary, /\[redacted-secret\]/);
    assertNoSecret(step.summary);
    assertNoSecret(JSON.stringify(step));

    await app.operations.append(operation({ id: 'op-af-07', capability: 'memory.add', status: Outcome.INPUT_REJECTED, steps: [step] }));
    const stored = lines(path.join(dir, 'operations.jsonl'))[0];
    assertNoSecret(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8'));
    assert.equal(Object.keys(stored.steps[0].input).includes(S.apiKey), false, 'the field name is not kept as a name');
    assert.equal(stored.status, Outcome.INPUT_REJECTED, 'the outcome of the refusal survives');
  });

  test('an ordinary field name is still named, in full', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const step = await app.controller.runAction('memory.add', { content: 'a plain note', notes: 'plainlooking' }, 'user', 'op-af-07b');
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.equal(step.summary, 'input rejected: unexpected input field "notes"', 'the explanation is not blurred by the filter');
  });

  test('a credential-shaped task query is refused without echoing it back', async () => {
    const dir = tempDir();
    const res = await runCli(['task', 'show', S.apiKey], envFor(dir));
    assert.equal(res.code, 2, 'an unmatched id is a usage error and changes nothing');
    const combined = `${res.stdout}${res.stderr}`;
    assert.match(combined, /no task matches/, 'the refusal says what it looked for');
    assertNoSecret(combined);
    assert.equal(fs.existsSync(path.join(dir, 'operations.jsonl')), false, 'a refused read writes no audit record');
  });

  test('a credential offered as memory content is refused by reason, never echoed', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const step = await app.controller.runAction('memory.add', { content: `the token is ${S.bearer}` }, 'user', 'op-af-07d');
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.match(step.summary, /looks like a password, key, or token; it was not stored/, 'the refusal says why');
    assertNoSecret(step.summary);
    const raw = fs.existsSync(path.join(dir, 'memory.jsonl')) ? fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8') : '';
    assert.equal(raw.includes('the token is'), false, 'a refused note is not stored in any form');
  });

  test('a successful operation keeps its wording byte for byte', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const step = await app.controller.runAction('memory.add', { content: 'The password field accepts any length you like.' }, 'user', 'op-af-07c');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
    assert.match(step.summary, /^stored user fact [0-9a-f]{8} \(verified\)$/, 'the step reports what it did, in its own words');
    assert.equal(step.summary.includes('[redacted-secret]'), false, 'clean prose is not rewritten by the disclosure filter');
    assert.equal(step.display.includes('[redacted-secret]'), false);
    const stored = fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8');
    assert.equal(stored.includes('The password field accepts any length you like.'), true, 'the note really was stored, so this step is not a refusal');
    assert.equal(stored.includes('[redacted-secret]'), false, 'and it was stored as written');
  });
});
