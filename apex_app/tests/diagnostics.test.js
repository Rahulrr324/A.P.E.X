// Implementation 019: operational diagnostics must report subsystem state
// accurately, distinguish confirmed damage from suspicion, never mutate the
// stores they inspect, and never expose stored content or secrets.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeTempDataDir,
  cleanup,
  cleanEnv,
  runCli,
  startStubModel,
  closedPortUrl,
} from './helpers.js';
import { createApp } from '../src/app.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

const AT = '2026-01-01T00:00:00.000Z';
const SECRET = 'sk-abcdefghijklmnopqrstuvwx1234';

function createdEvent(taskId) {
  return {
    schema: 1,
    eventId: `create-${taskId}`,
    type: 'task_created',
    taskId,
    at: AT,
    goal: 'diagnostics fixture',
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

function writeLines(file, lines) {
  fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
}

describe('diagnostics: subsystem states', () => {
  test('missing stores are valid absences, not corruption, and diagnostics create no state', async () => {
    const dir = tempDir();
    const before = snapshot(dir);

    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Memory records: 0/);
    assert.match(status.stdout, /Session: none yet/);
    assert.equal(fs.existsSync(path.join(dir, 'session.json')), false);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 0, diag.stderr);
    assert.match(diag.stdout, /Memory: missing \(valid: no record/);
    assert.match(diag.stdout, /Knowledge: missing \(valid: no record/);
    assert.match(diag.stdout, /Conversation: missing/);
    assert.match(diag.stdout, /Tasks: missing \(valid: no tasks yet\)/);
    assert.match(diag.stdout, /Audit: missing \(valid: no operations yet\)/);
    assert.match(diag.stdout, /Session: missing/);
    assert.match(diag.stdout, /Model: not configured/);
    assert.match(diag.stdout, /No recovery action needed/);
    assert.deepEqual(snapshot(dir), before, 'diagnostics must not create a session or any store');
  });

  test('healthy stores are reported as ok, without printing stored content', async () => {
    const dir = tempDir();
    const env = envFor(dir);
    assert.equal((await runCli(['ask', 'remember that the project codename is Lighthouse'], env)).code, 0);
    assert.equal((await runCli(['knowledge', 'add', '--subject', 'APEX', '--relationship', 'has_subsystem', '--object', 'Diagnostics'], env)).code, 0);
    assert.equal((await runCli(['task', 'plan', 'calc', '1+1'], env)).code, 0);

    const diag = await runCli(['diagnose'], env);
    assert.equal(diag.code, 0, diag.stderr);
    assert.match(diag.stdout, /Memory: ok \(1 record/);
    assert.match(diag.stdout, /Knowledge: ok \(1 record/);
    assert.match(diag.stdout, /Conversation: ok \([1-9]\d* turn/);
    assert.match(diag.stdout, /Tasks: ok \(1 task/);
    assert.match(diag.stdout, /Audit: ok \([2-9]\d* operation/);
    assert.match(diag.stdout, /Session: ok/);
    assert.doesNotMatch(diag.stdout, /Lighthouse/, 'diagnostics must not print memory contents');
    assert.match(diag.stdout, /No recovery action needed/);
  });

  test('corrupt memory is reported with reasons, blocked operations, and preservation guidance', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory.jsonl');
    const damaged = '{"schema":1}\n{broken\n';
    fs.writeFileSync(file, damaged);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Memory: corrupt \(0 readable record\(s\), 2 corrupt line\(s\)/);
    assert.match(diag.stdout, /memory\.jsonl: line 1: missing id/);
    assert.match(diag.stdout, /memory\.jsonl: line 2: invalid JSON/);
    assert.match(diag.stdout, /memory reads, search, and corrections are blocked/);
    assert.match(diag.stdout, /no supported repair command/i);
    assert.match(diag.stdout, /Preserve memory\.jsonl/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
    assert.equal(fs.existsSync(path.join(dir, 'session.json')), false);

    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Memory records: 0 \(corrupt lines skipped: 2\)/);
    assert.match(status.stdout, /Integrity: attention required/);
  });

  for (const { file, label, guidance } of [
    { file: 'knowledge.jsonl', label: 'Knowledge', guidance: /Preserve knowledge\.jsonl/ },
    { file: 'conversation.jsonl', label: 'Conversation', guidance: /Preserve conversation\.jsonl/ },
  ]) {
    test(`a corrupt ${file} is reported as corrupt and left untouched`, async () => {
      const dir = tempDir();
      const full = path.join(dir, file);
      const damaged = '{broken\n';
      fs.writeFileSync(full, damaged);

      const diag = await runCli(['diagnose'], envFor(dir));
      assert.equal(diag.code, 1);
      assert.match(diag.stdout, new RegExp(`${label}: corrupt \\(0 readable`));
      assert.match(diag.stdout, new RegExp(`${file.replace('.', '\\.')}: line 1: invalid JSON`));
      assert.match(diag.stdout, guidance);
      assert.equal(fs.readFileSync(full, 'utf8'), damaged);
    });
  }

  test('a corrupt session is reported with the existing explicit recovery command', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'session.json');
    const damaged = '{not json';
    fs.writeFileSync(file, damaged);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Session: corrupt/);
    assert.match(diag.stdout, /session\.json: session state is corrupt \(invalid JSON\)/);
    assert.match(diag.stdout, /"apex new" starts a new session and replaces session\.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);

    const status = await runCli(['status'], envFor(dir));
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Session: corrupt/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  });

  test('an unavailable data path is unavailable, never reported as empty', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'data-is-a-file');
    fs.writeFileSync(blocker, 'x');
    const diag = await runCli(['diagnose'], envFor(blocker));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Memory: unavailable/);
    assert.match(diag.stdout, /Storage: .* unavailable/);
    assert.match(diag.stdout, /does not recreate or truncate data automatically/);
    assert.doesNotMatch(diag.stdout, /Memory: missing/);
  });
});

describe('diagnostics: integrity checks', () => {
  test('task-log corrupt lines and unreplayable events are confirmed defects', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'tasks.jsonl');
    const taskId = '33333333-3333-4333-8333-333333333333';
    const created = createdEvent(taskId);
    const badOutcome = transitionEvent(taskId, 'bad-outcome', {
      steps: [{ id: 's1', from: 'pending', to: 'running', outcome: SECRET }],
    });
    const damaged = `${[created, created, badOutcome].map((e) => JSON.stringify(e)).join('\n')}\n`;
    fs.writeFileSync(file, damaged);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Tasks: corrupt \(2 readable event\(s\), 1 recoverable task\(s\), 1 corrupt line\(s\), 1 event\(s\) that cannot be applied\)/);
    assert.match(diag.stdout, /tasks\.jsonl: line 3: unknown step outcome \[redacted-secret\]/);
    assert.match(diag.stdout, /tasks\.jsonl: readable event 2: task id already exists/);
    assert.match(diag.stdout, /Preserve tasks\.jsonl and do not append to it/);
    assert.doesNotMatch(diag.stdout, new RegExp(SECRET), 'a corrupt reason must not leak a secret-like value');
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  });

  test('a task event whose step outcome contradicts its status is a confirmed defect', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'tasks.jsonl');
    const taskId = '44444444-4444-4444-8444-444444444444';
    writeLines(file, [
      createdEvent(taskId),
      transitionEvent(taskId, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running' }],
      }),
      transitionEvent(taskId, 'finish', {
        task: { from: 'running', to: 'completed' },
        steps: [{ id: 's1', from: 'running', to: 'completed', outcome: 'execution_failed' }],
      }),
    ]);
    const damaged = fs.readFileSync(file, 'utf8');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Tasks: corrupt/);
    assert.match(diag.stdout, /a completed step needs a verified outcome/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  });

  test('a task step whose audit record is missing is an unverified suspicion, not a confirmed defect', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const planned = await app.controller.planTask('calc 1+1');
    const taskId = planned.operation.task.id;
    await app.controller.runTask(taskId, 'run');

    const opsFile = path.join(dir, 'operations.jsonl');
    const kept = fs.readFileSync(opsFile, 'utf8').trim().split('\n')
      .filter((line) => JSON.parse(line).capability !== 'task.step');
    fs.writeFileSync(opsFile, `${kept.join('\n')}\n`);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Unverified integrity suspicions:/);
    assert.match(diag.stdout, /audit record [0-9a-z-]+ was not found/);
    assert.match(diag.stdout, /This does not prove the action did not execute/);
    assert.match(diag.stdout, /Confirmed integrity defects: none/);
    assert.match(diag.stdout, /do not repeat an action merely because its audit record is missing/i);
  });

  test('duplicate audit identifiers and bad timestamps are confirmed defects', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'operations.jsonl');
    writeLines(file, [
      { schema: 1, id: 'dup-operation', status: 'success_verified', requestedAt: AT },
      { schema: 1, id: 'dup-operation', status: 'success_verified', requestedAt: AT },
      { schema: 1, id: 'no-timestamp', status: 'success_verified' },
    ]);
    const damaged = fs.readFileSync(file, 'utf8');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Audit: corrupt \(3 readable operation\(s\)/);
    assert.match(diag.stdout, /operation no-times has a missing or invalid requestedAt timestamp/);
    assert.match(diag.stdout, /duplicate operation id dup-oper appears 2 times/);
    assert.match(diag.stdout, /Preserve operations\.jsonl/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  });
});

describe('diagnostics: model independence', () => {
  test('model connectivity is not checked unless requested', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub' });

    const diag = await runCli(['diagnose'], env);
    assert.equal(diag.code, 0, diag.stderr);
    assert.match(diag.stdout, /Model: not checked/);
    assert.match(diag.stdout, /Memory: missing/);
    assert.equal(stub.requests.length, 0, 'an unrequested diagnostic must not call the model');

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /connectivity not checked/);
    assert.equal(stub.requests.length, 0);
  });

  test('a local model endpoint that is unavailable does not hide local diagnostics', async () => {
    const dir = tempDir();
    const url = await closedPortUrl();
    const env = envFor(dir, { APEX_MODEL_URL: url, APEX_MODEL_NAME: 'stub' });

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Model: unavailable/);
    assert.match(diag.stdout, /Memory: missing/);
    assert.match(diag.stdout, /Knowledge: missing/);
    assert.match(diag.stdout, /start the configured local model server/);
    assert.doesNotMatch(diag.stdout, /Storage: /, 'a model outage is not a storage outage');
  });

  test('an available model is reported as ok when explicitly probed', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub' });
    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 0, diag.stderr);
    assert.match(diag.stdout, /Model: ok/);
    assert.equal(stub.requests.length, 0, 'health must not run inference');
  });

  test('a secret-like model name is redacted from diagnostics', async () => {
    const dir = tempDir();
    const url = await closedPortUrl();
    const env = envFor(dir, { APEX_MODEL_URL: url, APEX_MODEL_NAME: SECRET });
    const diag = await runCli(['diagnose'], env);
    assert.doesNotMatch(diag.stdout, new RegExp(SECRET));
    assert.match(diag.stdout, /\[redacted-secret\]/);
  });
});

describe('diagnostics: read-only behavior', () => {
  test('a pending task is not executed or rewritten by status or diagnose', async () => {
    const dir = tempDir();
    const env = envFor(dir);
    assert.equal((await runCli(['task', 'plan', 'calc', '2+2'], env)).code, 0);
    const before = snapshot(dir);

    assert.equal((await runCli(['status'], env)).code, 0);
    const diag = await runCli(['diagnose'], env);
    assert.equal(diag.code, 0, diag.stderr);
    assert.match(diag.stdout, /Tasks: ok \(1 task/);
    assert.deepEqual(snapshot(dir), before, 'inspecting a pending task must not run it');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl.lock')), false);

    const listed = await runCli(['task', 'list'], env);
    assert.match(listed.stdout, /pending/);
  });

  test('an uncertain task is reported explicitly and is neither resumed nor cancelled', async () => {
    const dir = tempDir();
    const taskId = '11111111-1111-4111-8111-111111111111';
    const opId = '22222222-2222-4222-8222-222222222222';
    writeLines(path.join(dir, 'tasks.jsonl'), [
      createdEvent(taskId),
      transitionEvent(taskId, 'start', {
        task: { from: 'pending', to: 'running' },
        steps: [{ id: 's1', from: 'pending', to: 'running', operationId: opId }],
      }),
      transitionEvent(taskId, 'interrupt', {
        task: { from: 'running', to: 'failed' },
        steps: [{ id: 's1', from: 'running', to: 'uncertain', outcome: null, summary: 'interrupted before outcome' }],
      }),
    ]);
    writeLines(path.join(dir, 'operations.jsonl'), [{
      schema: 1,
      id: opId,
      status: 'verification_unavailable',
      requestedAt: AT,
      capability: 'task.step',
      task: { id: taskId, stepId: 's1' },
    }]);
    const before = snapshot(dir);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1);
    assert.match(diag.stdout, /Task state requiring a decision:/);
    assert.match(diag.stdout, /uncertain: it may have executed; no action was taken/);
    assert.match(diag.stdout, /Review it with "apex task show 11111111"/);
    assert.match(diag.stdout, /Do not repeat the action blindly/);
    assert.deepEqual(snapshot(dir), before, 'an uncertain task must not be resumed, retried, or cancelled');
  });
});
