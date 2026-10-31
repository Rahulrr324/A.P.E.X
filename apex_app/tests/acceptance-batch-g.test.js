// Batch G / 085: integrated acceptance for the behaviours exercised in 075-084.
//
// These are CLI-level checks against isolated temporary data directories. The model in the
// first test is a local stub server, not real inference; the third test terminates a real
// child process and lets a second process recover it. Nothing here re-implements a whole
// component suite: each test asserts one cross-component contract end to end.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, APP_ROOT, rebindDeadHolder } from './helpers.js';
import { shortId } from '../src/util.js';

const dirs = [];
const stubs = [];
const children = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => {
  for (const s of stubs) await s.close();
  for (const c of children) {
    c.child.kill();
    await Promise.race([c.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});

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

// Every file, by relative path, with its bytes. Used to prove a read-only command changed
// nothing; names matter as much as contents, because creating a file is a mutation too.
function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

describe('085: integrated acceptance', () => {
  test('model text cannot authorize a write or manufacture a verified record', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = [
      'Done: I saved it to memory and verified it.',
      'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the launch code is 1234"}}',
      'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}',
    ].join('\n');
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub' });

    const res = await runCli(['ask', 'save the launch code and do two plus two'], env);
    assert.equal(res.code, 1, 'a blocked proposal is not reported as success');
    assert.equal(stub.requests.length, 1);
    assert.match(res.stdout, /Done: I saved it to memory and verified it\./, 'the model text is shown');
    assert.match(res.stdout, /\[APEX did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)\]/);
    assert.match(res.stdout, /2\+2 = 4 \(verified\)/, 'the permitted read action still ran');
    assert.match(res.stdout, /Status: +verification_unavailable/);
    assert.equal(fs.existsSync(path.join(dataDir, 'memory.jsonl')), false, 'the denied write stored nothing');

    const ops = jsonl(path.join(dataDir, 'operations.jsonl'));
    assert.equal(ops.length, 1);
    const op = ops[0];
    assert.equal(op.capability, 'model.answer');
    assert.equal(op.status, 'verification_unavailable');
    assert.equal(op.steps.length, 2);
    assert.deepEqual(op.steps[0].authorization, { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.equal(op.steps[0].outcome, 'action_denied');
    assert.deepEqual(op.steps[1].authorization, { decision: 'allow', reason: 'PERMITTED' });
    assert.equal(op.steps[1].outcome, 'success_verified');

    // The audit may quote the model, but the conversation must not carry APEX's own
    // counter-notice as if the model had said it, and no turn may claim the write happened.
    const turns = jsonl(path.join(dataDir, 'conversation.jsonl'));
    const modelTurns = turns.filter((t) => t.origin === 'model');
    assert.equal(modelTurns.length, 1);
    assert.equal(modelTurns[0].verified, false);
    assert.match(modelTurns[0].text, /I saved it to memory/);
    assert.equal(turns.some((t) => t.text.includes('did not execute a proposed action')), false);
    assert.equal(turns.some((t) => t.origin === 'apex_action' && t.verified && /memory\.add|saved/.test(t.text)), false);
  });

  test('read-only commands and diagnostics do not mutate any store', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const remembered = await runCli(['ask', 'remember that the audit review is on Friday'], env);
    assert.equal(remembered.code, 0, remembered.stdout + remembered.stderr);
    const knowledge = await runCli(['knowledge', 'add', '--subject', 'APEX', '--relationship', 'has_subsystem', '--object', 'Memory Store'], env);
    assert.equal(knowledge.code, 0, knowledge.stdout + knowledge.stderr);
    const planned = await runCli(['task', 'plan', 'calc 6*7'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const taskId = /^Task ([0-9a-f]{8})\b/m.exec(planned.stdout)[1];
    const knowledgeId = /knowledge record ([0-9a-f]{8})/.exec(knowledge.stdout)[1];

    const before = snapshot(dataDir);
    assert.ok(before.size >= 4, `expected stores to exist, got ${[...before.keys()].join(', ')}`);

    const readOnly = [
      ['status'],
      ['status'],
      ['diagnose'],
      ['history', '--limit', '5'],
      ['task', 'list'],
      ['task', 'show', taskId],
      ['task', 'explain', taskId],
      // `knowledge list` and `knowledge search` are audited operations by design; they are
      // not in this list because they append to the audit log. `knowledge show` is a direct read.
      ['knowledge', 'show', knowledgeId],
    ];
    for (const argv of readOnly) {
      const r = await runCli(argv, env);
      assert.ok(r.code === 0 || r.code === 1, `${argv.join(' ')} exited ${r.code}: ${r.stderr}`);
    }

    assert.deepEqual(snapshot(dataDir), before, 'a read-only command created, changed, or removed a file');
  });

  test('an uncertain side effect is resolved, never repeated', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = envFor(dataDir);
    const tasksFile = path.join(dataDir, 'tasks.jsonl');
    const opsFile = path.join(dataDir, 'operations.jsonl');
    const historyFile = path.join(dataDir, 'conversation.jsonl');
    const effectLines = () => {
      try {
        return fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l !== '');
      } catch {
        return [];
      }
    };
    const events = () => jsonl(tasksFile);

    const child = spawn(process.execPath, [path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs'), dataDir, effectFile], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    children.push({ child, exited });

    // READY is printed after the write step's side effect and after the task log records
    // that step as running. Waiting for the marker (not a delay) makes the kill point exact.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never reached READY. stdout: ${out} stderr: ${err}`)), 90000);
      const check = () => {
        if (out.includes('READY\n')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', check);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited early: ${out}${err}`)); });
      check();
    });
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'each step that ran did so once');
    assert.equal(child.kill(), true);
    const exit = await exited;
    assert.notEqual(exit.code, 0);
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'the lost process wrote no second effect');
    const lockFile = path.join(dataDir, 'tasks.jsonl.lock');
    assert.equal(fs.existsSync(lockFile), true, 'the lost process left its lock');
    rebindDeadHolder(lockFile, child.pid);

    const taskId = events().find((e) => e.type === 'task_created').taskId;
    const short = shortId(taskId);
    assert.deepEqual(events().flatMap((e) => (e.steps ?? []).filter((s) => s.to === 'running').map((s) => s.id)), ['s1', 's2']);

    const resume = await runCli(['task', 'resume', short], env);
    assert.equal(resume.code, 1);
    assert.match(resume.stdout, /step s2 is uncertain and was not run again/);
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'recovery repeated no side effect');

    const recovered = events().at(-1);
    assert.deepEqual(recovered.steps.map((s) => `${s.id}:${s.from}->${s.to}`), ['s2:running->uncertain']);
    assert.equal(recovered.task.to, 'paused');
    assert.equal(jsonl(opsFile).filter((r) => r.capability === 'task.step').length, 1, 'only the completed step has an audit record');

    const explain = await runCli(['task', 'explain', short, 'recovery'], env);
    assert.equal(explain.code, 1);
    assert.match(explain.stdout, /cannot continue on its own/i);
    assert.match(explain.stdout, /interrupted/);

    const interruptedTurn = jsonl(historyFile).filter((t) => t.origin === 'apex_task').at(-1);
    assert.equal(interruptedTurn.verified, false);
    assert.match(interruptedTurn.text, /interrupted partway through/);

    // A second recovery establishes nothing new and still runs nothing.
    const taskEvents = fs.readFileSync(tasksFile, 'utf8');
    const again = await runCli(['task', 'resume', short], env);
    assert.equal(again.code, 1);
    assert.equal(fs.readFileSync(tasksFile, 'utf8'), taskEvents, 'a repeated recovery records no new event');
    assert.deepEqual(effectLines(), ['s1', 'block-start']);

    const cancel = await runCli(['task', 'cancel', short], env);
    assert.equal(cancel.code, 0, cancel.stdout + cancel.stderr);
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'cancelling ran nothing');
  });
});
