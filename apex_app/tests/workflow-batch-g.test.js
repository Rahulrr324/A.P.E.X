// Batch G / 084: a complete workflow across deterministic actions, history, a model-proposed
// plan and its approval, a task run, an injected persistence outage, evidence disclosure, a
// follow-up question, and diagnostics.
//
// Every command below is a real CLI subprocess against a fresh temporary data directory. The
// model is a local stub server: it is deterministic test infrastructure, never evidence about
// real inference. The persistence outage is real filesystem state (the audit path is replaced
// by a directory), not a patched function inside the process under test.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}
function jsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function taskIdFrom(stdout) {
  const match = /^Task ([0-9a-f]{8})\b/m.exec(stdout);
  assert.ok(match, `no task id in output:\n${stdout}`);
  return match[1];
}

describe('084: a realistic workflow', () => {
  test('deterministic memory, history, a model-proposed plan, its approval, and a verified run', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const opsFile = path.join(dataDir, 'operations.jsonl');

    const remembered = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(remembered.code, 0, remembered.stdout + remembered.stderr);
    assert.match(remembered.stdout, /Stored \(user fact\)/);
    assert.match(remembered.stdout, /Audit: +recorded in operations\.jsonl/);

    const recalled = await runCli(['ask', 'recall codename'], env);
    assert.equal(recalled.code, 0, recalled.stdout + recalled.stderr);
    assert.match(recalled.stdout, /the project codename is Lighthouse/);
    assert.match(recalled.stdout, /verification success_verified/);

    const history = await runCli(['history', '--limit', '5'], env);
    assert.equal(history.code, 0);
    const ops = jsonl(opsFile);
    assert.deepEqual(ops.map((o) => o.capability), ['memory.add', 'memory.search']);
    assert.match(history.stdout, /memory\.add/);
    assert.match(history.stdout, /memory\.search/);

    // A stub model proposes one read step. The plan is a proposal, not permission.
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.raw = JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            steps: [{ id: 's1', description: 'calculate 3*7', action: 'calc.evaluate', input: { expression: '3*7' }, depends_on: [] }],
          }),
        },
      }],
    });
    const modelEnv = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub' });
    const planned = await runCli(['task', 'plan', 'calculate three times seven'], modelEnv);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /status: proposed/);
    assert.match(planned.stdout, /proposed by a model/);
    assert.equal(stub.requests.length, 1, 'the plan came from exactly one model call');
    const taskId = taskIdFrom(planned.stdout);

    // Refusal: nothing may run before the user approves the plan.
    const beforeApproval = jsonl(path.join(dataDir, 'tasks.jsonl')).length;
    const refused = await runCli(['task', 'run', taskId], modelEnv);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /needs your approval first/);
    assert.equal(jsonl(path.join(dataDir, 'tasks.jsonl')).length, beforeApproval, 'a refused run records no task event');
    assert.equal(jsonl(opsFile).filter((o) => o.capability === 'task.step').length, 0, 'a refused run executes no step');

    const approved = await runCli(['task', 'approve', taskId], modelEnv);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    assert.match(approved.stdout, /status: pending/);

    const ran = await runCli(['task', 'run', taskId], modelEnv);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /status: completed/);
    assert.match(ran.stdout, /1 of 1 step\(s\) completed/);
    assert.match(ran.stdout, /3\*7 = 21 \(verified\)/);
    const stepRecords = jsonl(opsFile).filter((o) => o.capability === 'task.step');
    assert.equal(stepRecords.length, 1);
    assert.equal(stepRecords[0].task.id.length > 0, true);
    assert.equal(stepRecords[0].status, 'success_verified');

    const explained = await runCli(['task', 'explain', taskId, 'finished'], modelEnv);
    assert.equal(explained.code, 0, explained.stdout + explained.stderr);
    assert.match(explained.stdout, /all 1 step\(s\) ran and each one was verified/);
    assert.match(explained.stdout, /all 1 step result\(s\) the task log records as verified have an operation record/);
  });

  test('an audit outage during a task write leaves one side effect and discloses the missing evidence', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const opsFile = path.join(dataDir, 'operations.jsonl');
    const memoryFile = path.join(dataDir, 'memory.jsonl');

    const planned = await runCli(['task', 'plan', 'remember that the release train is Green'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /status: pending/);
    const taskId = taskIdFrom(planned.stdout);

    // Real persistence failure: the audit path becomes a directory, so no operation record
    // (neither the step's nor the run's) can be appended. The task log and memory store stay
    // writable, which is exactly the split the report must not blur.
    const saved = `${opsFile}.saved`;
    fs.renameSync(opsFile, saved);
    fs.mkdirSync(opsFile);
    let outage;
    try {
      outage = await runCli(['task', 'run', taskId], env);
    } finally {
      fs.rmdirSync(opsFile);
      fs.renameSync(saved, opsFile);
    }

    // The step ran and the task log recorded it; the audit record did not survive.
    assert.equal(outage.code, 3, 'an unrecorded operation exits 3');
    assert.match(outage.stdout, /status: completed/);
    assert.match(outage.stdout, /1 of 1 step\(s\) completed/);
    assert.match(outage.stdout, /stored user fact .* \(verified\)/);
    assert.match(outage.stdout, /Audit integrity failure: 1 required task-step operation record\(s\) could not be written/);
    assert.match(outage.stderr, /Audit: NOT RECORDED/);
    assert.match(outage.stderr, /1 step record\(s\) could not be written/);

    const storedFacts = () => jsonl(memoryFile).filter((r) => r.content === 'the release train is Green');
    assert.equal(storedFacts().length, 1, 'the write happened exactly once');

    // The task log is authoritative about what ran, and the audit cannot support it.
    const explained = await runCli(['task', 'explain', taskId], env);
    assert.equal(explained.code, 1, 'completed without evidence is not reported as verified success');
    assert.match(explained.stdout, /status: completed; 1 of 1 step\(s\) verified complete/);
    assert.match(explained.stdout, /no operation record is available for s1/);
    assert.match(explained.stdout, /0 of 1 recorded step result\(s\) have an operation record/);

    // No automatic or requested rerun of a side effect that may already have happened.
    const again = await runCli(['task', 'run', taskId], env);
    assert.equal(again.code, 1);
    assert.match(again.stdout, /already completed; nothing to run/);
    assert.equal(storedFacts().length, 1, 'the refusal did not repeat the write');

    // A follow-up is answered from the records and states the evidence gap.
    const asked = await runCli(['ask', `task ${taskId} finished?`], env);
    assert.equal(asked.code, 0, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /status: completed; 1 of 1 step\(s\) verified complete/);
    assert.match(asked.stdout, /described as complete because the task log says so, but its audit evidence is missing|no operation record is available for s1/);
    assert.equal(storedFacts().length, 1, 'a question runs nothing');

    // Diagnostics find the same gap, remain read-only, and point at the evidence rather than
    // recommending a rerun.
    const before = {
      memory: fs.readFileSync(memoryFile, 'utf8'),
      tasks: fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8'),
      ops: fs.readFileSync(opsFile, 'utf8'),
    };
    const diagnose = await runCli(['diagnose'], env);
    assert.equal(diagnose.code, 1);
    assert.match(diagnose.stdout, /Overall: attention required/);
    assert.match(diagnose.stdout, /audit record .* was not found/);
    assert.match(diagnose.stdout, /do not repeat an action merely because its audit record is missing/);
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), before.memory, 'diagnose did not change memory');
    assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8'), before.tasks, 'diagnose did not change tasks');
    assert.equal(fs.readFileSync(opsFile, 'utf8'), before.ops, 'diagnose did not change the audit log');
    assert.equal(storedFacts().length, 1, 'diagnose ran nothing');

    const status = await runCli(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Integrity: attention required/);
  });
});
