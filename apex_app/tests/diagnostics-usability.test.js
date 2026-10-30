// Implementation 101: when an operation runs into damaged data, missing evidence, a lock,
// a queue, an uncertain result, or a model problem, the CLI must say what is known, what
// is not, and whether a retry is safe. It must never suggest repeating an action that may
// already have executed. Every diagnostic view used here is checked to be read-only.
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

function writeLines(file, lines) {
  fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`);
}

describe('101: the CLI explains recovery conditions and retry safety', () => {
  test('corrupt storage names the damage and says nothing ran; it does not suggest permissions', async () => {
    const dir = tempDir();
    const memory = path.join(dir, 'memory.jsonl');
    fs.writeFileSync(memory, '{not json}\n');

    const res = await runCli(['ask', 'recall', 'codename'], envFor(dir));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /execution failed: memory store contains 1 corrupt line\(s\); refusing incomplete retrieval/, res.stdout);
    assert.match(res.stdout, /a stored data file is damaged, so this step was refused before it ran/, res.stdout);
    assert.match(res.stdout, /retrying is safe only after the store is repaired/, res.stdout);
    assert.doesNotMatch(`${res.stdout}${res.stderr}`, /Check APEX_DATA_DIR and its permissions/, 'damage is not a permissions problem');
    assert.equal(fs.readFileSync(memory, 'utf8'), '{not json}\n', 'the damaged store was not rewritten');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Memory: corrupt/, diag.stdout);
    assert.match(diag.stdout, /Preserve memory\.jsonl/, diag.stdout);
  });

  test('corrupt audit lines are reported as an incomplete list, not as no operations', async () => {
    const dir = tempDir();
    writeLines(path.join(dir, 'operations.jsonl'), [
      '{broken',
      { schema: 1, id: 'readable-op', status: 'success_verified', requestedAt: AT, capability: 'model.answer', request: 'hello' },
    ]);
    const before = snapshot(dir);

    const res = await runCli(['history'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /readable-op/, res.stdout);
    assert.match(res.stdout, /1 corrupt audit line\(s\) skipped/, res.stdout);
    assert.match(res.stdout, /this list is incomplete/, res.stdout);
    assert.match(res.stdout, /A missing record does not prove an action did not execute/, res.stdout);
    assert.deepEqual(snapshot(dir), before, 'history is read-only');

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.match(diag.stdout, /Audit: corrupt/, diag.stdout);
    assert.match(diag.stdout, /Preserve operations\.jsonl/, diag.stdout);
  });

  test('an unavailable audit log is disclosed after a verified result, without advising a repeat', async () => {
    const dir = tempDir();
    // A directory where the audit file should be makes every append fail.
    fs.mkdirSync(path.join(dir, 'operations.jsonl'));

    const res = await runCli(['ask', 'calc', '1+1'], envFor(dir));
    assert.equal(res.code, 3, res.stdout + res.stderr);
    assert.match(res.stdout, /1\+1 = 2/, res.stdout);
    assert.match(res.stdout, /Audit:     NOT RECORDED \(cannot write operations\.jsonl: EISDIR\)/, res.stdout);
    assert.match(res.stdout, /the result above is what this run observed, but the audit trail will not contain it/, res.stdout);
    assert.match(res.stdout, /Do not repeat the request just to obtain a record/, res.stdout);
    assert.equal(fs.statSync(path.join(dir, 'operations.jsonl')).isDirectory(), true, 'the blocking path was not replaced');

    const history = await runCli(['history'], envFor(dir));
    assert.equal(history.code, 1, history.stdout + history.stderr);
    assert.match(history.stderr, /Audit: unavailable/, history.stderr);
    assert.match(history.stderr, /does not establish that any operation did not run/, history.stderr);
    assert.match(history.stderr, /do not repeat an action merely because its record cannot be listed/, history.stderr);
  });

  test('a held task lock is a refusal before any step, and an unreadable holder is not called temporary', async () => {
    const dir = tempDir();
    const lock = path.join(dir, 'tasks.jsonl.lock');
    const held = JSON.stringify({ pid: process.pid, nonce: 'held', at: new Date().toISOString() });
    fs.writeFileSync(lock, held);

    const refused = await runCli(['task', 'plan', 'calc', '1+1'], envFor(dir));
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, new RegExp(`task run refused: tasks are in use by process ${process.pid}`), refused.stdout);
    assert.match(refused.stdout, /No task step was run and nothing was changed/, refused.stdout);
    assert.match(refused.stdout, /retrying after the active run finishes is safe/, refused.stdout);
    assert.equal(fs.readFileSync(lock, 'utf8'), held, 'the live lock was not touched');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl')), false, 'no task was created while the lock was held');

    const unreadable = 'not a lock body';
    fs.writeFileSync(lock, unreadable);
    const unknown = await runCli(['task', 'plan', 'calc', '2+2'], envFor(dir));
    assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout, /tasks are in use by process unknown/, unknown.stdout);
    assert.match(unknown.stdout, /The lock holder cannot be identified, so a retry may be refused again/, unknown.stdout);
    assert.equal(fs.readFileSync(lock, 'utf8'), unreadable);

    const repair = await runCli(['repair', 'locks'], envFor(dir));
    assert.equal(repair.code, 1, repair.stdout + repair.stderr);
    assert.match(repair.stderr, /not recovered: the task lock holder cannot be identified; refusing recovery/, repair.stderr);
    assert.match(repair.stderr, /No live holder or takeover was displaced, and no lock claim was deleted/, repair.stderr);
    assert.equal(fs.readFileSync(lock, 'utf8'), unreadable, 'repair did not delete a claim it could not identify');
  });

  test('queue contention is stated as a refused update, while the read-only view still works', async () => {
    const dir = tempDir();
    const lock = path.join(dir, 'task-summary-queue.json.lock');
    const held = JSON.stringify({ pid: process.pid, nonce: 'held', at: new Date().toISOString() });
    fs.writeFileSync(lock, held);

    const res = await runCli(['queue'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Queue lock: holder process \d+ is live/, res.stdout);
    assert.match(res.stdout, /A queue update is refused while that process holds the lock/, res.stdout);
    assert.match(res.stdout, /This view is read-only; retrying the update after it finishes is safe/, res.stdout);
    assert.equal(fs.readFileSync(lock, 'utf8'), held, 'the live lock was not touched');
    assert.equal(fs.existsSync(path.join(dir, 'task-summary-queue.json')), false, 'the read created no queue');
  });

  test('an uncertain task result says it may have executed and forbids blind repetition', async () => {
    const dir = tempDir();
    const taskId = '11111111-1111-4111-8111-111111111111';
    const opId = '22222222-2222-4222-8222-222222222222';
    writeLines(path.join(dir, 'tasks.jsonl'), [
      {
        schema: 1, eventId: 'create-1', type: 'task_created', taskId, at: AT,
        goal: 'fixture', origin: 'user', planner: 'deterministic', reason: 'created',
        steps: [{ id: 's1', description: 'fixture step', action: 'calc', permission: 'read', input: { expression: '1+1' }, dependsOn: [] }],
      },
      { schema: 1, eventId: 'start-1', type: 'transition', taskId, at: AT, reason: 'start', task: { from: 'pending', to: 'running' }, steps: [{ id: 's1', from: 'pending', to: 'running', operationId: opId }], approval: null },
      { schema: 1, eventId: 'interrupt-1', type: 'transition', taskId, at: AT, reason: 'interrupt', task: { from: 'running', to: 'failed' }, steps: [{ id: 's1', from: 'running', to: 'uncertain', outcome: null, summary: 'interrupted before outcome' }], approval: null },
    ]);
    writeLines(path.join(dir, 'operations.jsonl'), [
      { schema: 1, id: opId, status: 'verification_unavailable', requestedAt: AT, capability: 'task.step', task: { id: taskId, stepId: 's1' } },
    ]);
    const before = snapshot(dir);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /uncertain: it may have executed; no action was taken/, diag.stdout);
    assert.match(diag.stdout, /Review it with "apex task show 11111111"/, diag.stdout);
    assert.match(diag.stdout, /Do not repeat the action blindly/, diag.stdout);
    assert.deepEqual(snapshot(dir), before, 'diagnostics neither resumed nor cancelled the task');
  });

  test('missing evidence is a suspicion, not proof that nothing executed', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const planned = await app.controller.planTask('calc 1+1');
    const taskId = planned.operation.task.id;
    await app.controller.runTask(taskId, 'run');
    const opsFile = path.join(dir, 'operations.jsonl');
    const kept = fs.readFileSync(opsFile, 'utf8').trim().split('\n')
      .filter((line) => JSON.parse(line).capability !== 'task.step');
    fs.writeFileSync(opsFile, `${kept.join('\n')}\n`);
    const before = snapshot(dir);

    const diag = await runCli(['diagnose'], envFor(dir));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Unverified integrity suspicions:/, diag.stdout);
    assert.match(diag.stdout, /does not prove the action did not execute/i, diag.stdout);
    assert.match(diag.stdout, /do not repeat an action merely because its audit record is missing/i, diag.stdout);
    assert.deepEqual(snapshot(dir), before, 'diagnostics did not rewrite the task or audit logs');
  });

  test('an unavailable model says no inference was tested and that a request is safe to retry', async () => {
    const dir = tempDir();
    const url = await closedPortUrl();
    const env = envFor(dir, { APEX_MODEL_URL: url, APEX_MODEL_NAME: 'local' });

    const ask = await runCli(['ask', 'hello'], env);
    assert.equal(ask.code, 1, ask.stdout + ask.stderr);
    assert.match(ask.stdout, /did not produce an answer \(UNREACHABLE:/, ask.stdout);
    assert.match(ask.stdout, /No answer has been generated/, ask.stdout);
    assert.match(ask.stdout, /No action was proposed or run, so retrying this request after the backend is available is safe/, ask.stdout);

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /unavailable: could not reach the endpoint/, status.stdout);
    assert.match(status.stdout, /no inference was tested/i, status.stdout);
    assert.match(status.stdout, /re-running "status --model" is safe/, status.stdout);

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /retrying that read-only check is safe/, diag.stdout);
    assert.equal(fs.existsSync(path.join(dir, 'tasks.jsonl')), false, 'no task was created by a failed model request');
  });

  test('a configured model missing from the listing is unconfirmed, not failed, and no inference is claimed', async () => {
    const dir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.modelsRaw = JSON.stringify({ data: [{ id: 'some-other-model' }] });
    const env = envFor(dir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'wanted-model' });
    const before = snapshot(dir);

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /reachable, model not confirmed:/, status.stdout);
    assert.match(status.stdout, /does not include configured model "wanted-model"/, status.stdout);
    assert.match(status.stdout, /no inference was run/, status.stdout);

    const diag = await runCli(['diagnose', '--model'], env);
    assert.equal(diag.code, 0, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Model: reachable but not confirmed/, diag.stdout);
    assert.match(diag.stdout, /unconfirmed, not a failure, and no inference was run/, diag.stdout);
    assert.match(diag.stdout, /Retrying "apex diagnose --model" is safe/, diag.stdout);
    assert.equal(stub.requests.length, 0, 'readiness probes never send a completion request');
    assert.deepEqual(snapshot(dir), before, 'status and diagnose created no data');
  });
});
