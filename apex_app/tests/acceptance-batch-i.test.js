// Batch I / 108: integrated acceptance for 098-107.
//
// Each scenario crosses component boundaries and is driven through the real CLI or the
// real application objects in an isolated temporary directory. Model traffic is a local
// stub server, never inference; the task and lock scenarios terminate or exit real child
// processes. Focused suites hold the details; this file holds the end-to-end contract.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, APP_ROOT,
} from './helpers.js';
import { shortId } from '../src/util.js';
import { main } from '../src/cli.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';
import { SummaryQueue } from '../src/tasks/summary-queue.js';

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
function capture() {
  return { text: '', write(chunk) { this.text += chunk; return true; } };
}
function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), `${fs.statSync(full).mtimeMs}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(dir);
  return out;
}
function exitedPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(r.status, 0);
  return r.pid;
}
async function runThroughCli(app, dir, argv) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    env: envFor(dir),
    stdout,
    stderr,
    stdin: { isTTY: false },
    appFactory: () => app,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('108: integrated acceptance', () => {
  test('1. a deterministic workflow completes without any model and survives a new process', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);

    const remembered = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(remembered.code, 0, remembered.stdout + remembered.stderr);
    assert.match(remembered.stdout, /Status:\s+success_verified/);

    const recalled = await runCli(['ask', 'recall codename'], env);
    assert.equal(recalled.code, 0, recalled.stdout + recalled.stderr);
    assert.match(recalled.stdout, /Lighthouse/);
    assert.match(recalled.stdout, /Status:\s+success_verified/);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Memory records:\s+1\b/);
    assert.match(status.stdout, /Model backend: none configured/);
    assert.equal(jsonl(path.join(dataDir, 'operations.jsonl')).length, 2);
  });

  test('2. a reachable model server that does not list the configured model is unconfirmed, not healthy', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.modelsRaw = JSON.stringify({ data: [{ id: 'some-other-model' }] });
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'wanted-model' });

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /reachable, model not confirmed/);
    assert.match(status.stdout, /does not include configured model "wanted-model"/);
    assert.match(status.stdout, /model list only; no inference was run/);

    const diagnose = await runCli(['diagnose', '--model'], env);
    assert.equal(diagnose.code, 0, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /Model: reachable but not confirmed/);
    assert.doesNotMatch(diagnose.stdout, /Model: ok/);
    assert.equal(stub.requests.length, 0, 'listing a model never runs inference');
  });

  test('3. a model proposal to write memory is denied and leaves no memory record', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the launch code is 1234"}}';
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });

    const res = await runCli(['ask', 'save the launch code'], env);
    assert.equal(res.code, 1, 'a denied proposal is not success');
    assert.match(res.stdout, /did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.equal(fs.existsSync(path.join(dataDir, 'memory.jsonl')), false);
    const op = jsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(op.steps[0].outcome, 'action_denied');
    assert.deepEqual(op.steps[0].authorization, { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.equal(op.steps[0].execution.status, 'not_run');
  });

  test('4. corrupt storage refuses unsafe writes, preserves the damage, and does not block unrelated work', async () => {
    const dataDir = tempDir();
    const knowledgeFile = path.join(dataDir, 'knowledge.jsonl');
    const damaged = '{"schema":1,"id":"partial';
    fs.writeFileSync(knowledgeFile, damaged);
    const env = envFor(dataDir);

    const refused = await runCli(['knowledge', 'add', '--subject', 'Alpha', '--relationship', 'trusts', '--object', 'Beta'], env);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /knowledge store contains 1 corrupt line\(s\); refusing an incomplete knowledge operation/);
    assert.equal(fs.readFileSync(knowledgeFile, 'utf8'), damaged, 'the damaged bytes were not rewritten');

    const diagnose = await runCli(['diagnose'], env);
    assert.equal(diagnose.code, 1, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /Knowledge: corrupt/);

    const calc = await runCli(['ask', 'calc 3*3'], env);
    assert.equal(calc.code, 0, 'an unrelated deterministic request still works');
    assert.match(calc.stdout, /3\*3 = 9 \(verified\)/);
  });

  test('5. an audit failure after a possible side effect exits 3 and claims nothing more than it knows', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    app.operations.append = async () => { throw new StoreError('injected: audit write failed'); };

    const res = await runThroughCli(app, dataDir, ['ask', 'remember that the audit boundary was tested']);
    assert.equal(res.code, 3, res.stdout + res.stderr);
    assert.match(res.stdout, /Audit:\s+NOT RECORDED/);
    assert.match(res.stdout, /Do not repeat the request just to obtain a record/);
    assert.match(res.stdout, /that action may already have happened/);
    assert.equal((await app.memory.list()).length, 1, 'the write happened once');
    assert.equal((await app.operations.inspect()).records.length, 0, 'no audit record was invented');
  });

  test('6. a task interrupted after its side effect is recovered without re-running it', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = envFor(dataDir);
    const effects = () => {
      try { return fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    };

    const child = spawn(process.execPath, [path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs'), dataDir, effectFile], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ child, exited: new Promise((resolve) => child.once('exit', resolve)) });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never reached READY. ${out}${err}`)), 90000);
      const check = () => { if (out.includes('READY\n')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', check);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited early: ${out}${err}`)); });
      check();
    });
    assert.deepEqual(effects(), ['s1', 'block-start'], 'each step ran once before the loss');
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    assert.deepEqual(effects(), ['s1', 'block-start'], 'the terminated process wrote no second effect');

    const taskId = jsonl(path.join(dataDir, 'tasks.jsonl')).find((e) => e.type === 'task_created').taskId;
    const resume = await runCli(['task', 'resume', shortId(taskId)], env);
    assert.equal(resume.code, 1);
    assert.match(resume.stdout, /uncertain and was not run again/);
    assert.deepEqual(effects(), ['s1', 'block-start'], 'recovery repeated no side effect');

    const explain = await runCli(['task', 'explain', shortId(taskId), 'recovery'], env);
    assert.match(explain.stdout, /uncertain/i);
  });

  test('7. explicit lock recovery removes only abandoned takeover tokens, then the next normal run completes', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const planned = await runCli(['task', 'plan', 'calc 6*7'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const taskShort = /^Task ([0-9a-f]{8})\b/m.exec(planned.stdout)[1];

    const lock = path.join(dataDir, 'tasks.jsonl.lock');
    const raw = JSON.stringify({ pid: exitedPid(), nonce: 'stale', at: new Date().toISOString() });
    fs.writeFileSync(lock, raw);
    const key = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);

    const child = spawn(process.execPath, [path.join(APP_ROOT, 'tests', 'fixtures', 'takeover-exit-child.mjs'), dataDir], {
      env, cwd: APP_ROOT, windowsHide: true, stdio: 'ignore',
    });
    const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    assert.equal(exit, 9, 'the child exited inside the election');
    assert.equal(fs.readFileSync(lock, 'utf8'), raw, 'the dead claim is left for inspection');
    assert.equal(fs.existsSync(`${lock}.takeover.${key}.0`), true, 'its abandoned token is left too');

    const repair = await runCli(['repair', 'locks'], env);
    assert.equal(repair.code, 0, repair.stdout + repair.stderr);
    assert.match(repair.stdout, /Task lock: present/);
    assert.match(repair.stdout, /removed 1 abandoned takeover token\(s\)/);
    assert.match(repair.stdout, /the claim was left for the next normal run/);
    assert.equal(fs.readFileSync(lock, 'utf8'), raw, 'repair never removes the lock claim');
    assert.equal(fs.existsSync(`${lock}.takeover.${key}.0`), false);

    const run = await runCli(['task', 'run', taskShort], env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /status: completed/);
    assert.match(run.stdout, /6\*7 = 42 \(verified\)/);
    assert.equal(fs.existsSync(lock), false, 'the next taker released its own claim');
  });

  test('8. concurrent summary-queue updates keep every intent and leave no lock or temp file', async () => {
    const dataDir = tempDir();
    const ids = ['task-a', 'task-b', 'task-c', 'task-d'];
    const racers = await Promise.all(ids.map((taskId) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(APP_ROOT, 'tests', 'fixtures', 'queue-race-child.mjs'), dataDir, taskId], {
        env: cleanEnv({ APEX_RACERS: String(ids.length) }),
        cwd: APP_ROOT,
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('exit', (code) => resolve({ code, out }));
    })));
    for (const racer of racers) {
      assert.equal(racer.code, 0, racer.out);
      assert.equal(JSON.parse(racer.out.trim().split('\n').at(-1)).queued, true, racer.out);
    }
    const queue = new SummaryQueue(path.join(dataDir, 'task-summary-queue.json'));
    assert.deepEqual((await queue.entries()).map((e) => e.taskId).sort(), [...ids].sort());
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
    assert.equal((await runCli(['queue'], envFor(dataDir))).code, 0);
  });

  test('9. credential-like input and model output are minimized at the persistence boundary', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });
    const apiKey = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
    const password = 'hunter2value';

    stub.behavior.reply = 'Acknowledged.';
    const request = await runCli(['ask', `my password is ${password}`], env);
    assert.equal(request.code, 0, request.stdout + request.stderr);

    stub.behavior.reply = `The key is ${apiKey} and the password is ${password}.`;
    const answer = await runCli(['ask', 'repeat the secret'], env);
    assert.equal(answer.code, 0, answer.stdout + answer.stderr);
    assert.equal(answer.stdout.includes(apiKey), true, 'the terminal shows what the model returned');

    const auditRaw = fs.readFileSync(path.join(dataDir, 'operations.jsonl'), 'utf8');
    assert.equal(auditRaw.includes(apiKey), false, 'the model key is not in the audit log');
    assert.equal(auditRaw.includes(password), false, 'the password is not in the audit log');
    const ops = jsonl(path.join(dataDir, 'operations.jsonl'));
    assert.equal(ops[0].request, '[request omitted: contained a password, key, or token]');
    const minimized = ops.filter((op) => op.capability === 'model.answer').at(-1);
    assert.equal(minimized.outputMinimized, true);
    assert.match(minimized.output, /\[redacted-secret\]/);

    const conversationRaw = fs.readFileSync(path.join(dataDir, 'conversation.jsonl'), 'utf8');
    assert.equal(conversationRaw.includes(apiKey), false);
    assert.equal(conversationRaw.includes(password), false);
    const diagnose = await runCli(['diagnose'], env);
    assert.equal(`${diagnose.stdout}${diagnose.stderr}`.includes(apiKey), false);
  });

  test('10. an uncertain outcome is reported as uncertain, executed once, and not automatically retried', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    const original = app.memory.add.bind(app.memory);
    let executions = 0;
    app.memory.add = async (...args) => {
      executions += 1;
      return original(...args);
    };
    app.controller.verifier.check = async () => ({
      outcome: Outcome.VERIFICATION_UNAVAILABLE,
      detail: 'injected: the evidence could not be read',
    });

    const res = await runThroughCli(app, dataDir, ['ask', 'remember that the launch window is 04:00']);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+verification_unavailable/);
    assert.match(res.stdout, /executed; verification unavailable/);
    assert.doesNotMatch(res.stdout, /Status:\s+success_verified/);
    assert.equal(executions, 1, 'the uncertain write was attempted once');
    assert.equal((await app.memory.list()).length, 1, 'the side effect is reported, not repeated');
    const record = (await app.operations.inspect()).records.at(-1);
    assert.equal(record.status, Outcome.VERIFICATION_UNAVAILABLE);
    assert.equal(record.steps[0].execution.status, 'ok');
    assert.equal(record.steps[0].verification.outcome, 'verification_unavailable');
  });

  test('11. read-only diagnostics and views change no persistent file', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    assert.equal((await runCli(['ask', 'remember that the audit review is on Friday'], env)).code, 0);
    const knowledge = await runCli(['knowledge', 'add', '--subject', 'APEX', '--relationship', 'has_subsystem', '--object', 'Memory Store'], env);
    assert.equal(knowledge.code, 0, knowledge.stdout + knowledge.stderr);
    const knowledgeId = /knowledge record ([0-9a-f]{8})/.exec(knowledge.stdout)[1];
    const planned = await runCli(['task', 'plan', 'calc 6*7'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const taskId = /^Task ([0-9a-f]{8})\b/m.exec(planned.stdout)[1];

    const before = snapshot(dataDir);
    assert.ok(before.size >= 4, `expected stores to exist, got ${[...before.keys()].join(', ')}`);
    for (const argv of [
      ['status'], ['diagnose'], ['history', '--limit', '5'], ['queue'],
      ['task', 'list'], ['task', 'show', taskId], ['task', 'explain', taskId],
      ['knowledge', 'show', knowledgeId],
    ]) {
      const r = await runCli(argv, env);
      assert.ok(r.code === 0 || r.code === 1, `${argv.join(' ')} exited ${r.code}: ${r.stderr}`);
    }
    assert.deepEqual(snapshot(dataDir), before, 'a read-only command created, changed, or removed a file');
  });

  test('12. conflicting knowledge keeps both claims and its provenance in search and in model context', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const one = await runCli(['knowledge', 'add', '--subject', 'the launch code name', '--relationship', 'is', '--object', 'Zephyr', '--evidence', 'mission notes'], env);
    const two = await runCli(['knowledge', 'add', '--subject', 'the launch code name', '--relationship', 'is', '--object', 'Falcon'], env);
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.equal(two.code, 0, two.stdout + two.stderr);

    const found = await runCli(['knowledge', 'search', 'launch code name'], env);
    assert.equal(found.code, 0, found.stdout + found.stderr);
    assert.match(found.stdout, /the launch code name --\[is\]--> Zephyr/);
    assert.match(found.stdout, /the launch code name --\[is\]--> Falcon/);
    assert.equal((found.stdout.match(/conflicting \(conflicts with:/g) ?? []).length, 2);
    assert.equal((found.stdout.match(/user_supplied/g) ?? []).length, 2);

    const id = /knowledge record ([0-9a-f]{8})/.exec(one.stdout)[1];
    const shown = await runCli(['knowledge', 'show', id], env);
    assert.match(shown.stdout, /user_supplied/);
    assert.match(shown.stdout, /CONFLICTS WITH/i);

    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = 'The records disagree.';
    const modelEnv = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });
    const ask = await runCli(['ask', 'what is the launch code name?'], modelEnv);
    assert.equal(ask.code, 0, ask.stdout + ask.stderr);
    assert.equal(stub.requests.length, 1, 'one model request was made');
    const prompt = JSON.stringify(stub.requests[0]);
    assert.match(prompt, /Zephyr/);
    assert.match(prompt, /Falcon/);
    assert.match(prompt, /CONFLICTING: another record disagrees/);
    assert.match(prompt, /user-supplied fact/);
  });

  test('13. CLI help is complete and invalid invocations are usage errors that create nothing', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);

    const help = await runCli(['help'], env);
    assert.equal(help.code, 0, help.stdout + help.stderr);
    for (const line of ['ask', 'diagnose', 'task explain', 'queue', 'repair locks', 'knowledge add']) {
      assert.ok(help.stdout.includes(line), `help omits "${line}"`);
    }
    for (const code of ['0  completed', '1  not completed', '2  usage or configuration error', '3  the outcome could not be written']) {
      assert.ok(help.stdout.includes(code), `help omits exit code text "${code}"`);
    }

    for (const argv of [
      ['frobnicate'],
      ['task', 'show'],
      ['task', 'explain'],
      ['knowledge', 'add', '--subject', 'only-a-subject'],
      ['history', '--limit', 'many'],
    ]) {
      const r = await runCli(argv, env);
      assert.equal(r.code, 2, `${argv.join(' ')} exited ${r.code}: ${r.stdout}${r.stderr}`);
    }
    assert.deepEqual(fs.readdirSync(dataDir), [], 'no command created data before a valid operation');
  });

  test('14. diagnostics report a model-list check as listing only, and no inference is ever run', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.modelsRaw = JSON.stringify({ data: [{ id: 'stub-model' }] });
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });

    const started = performance.now();
    const diagnose = await runCli(['diagnose', '--model'], env);
    const elapsed = performance.now() - started;
    assert.equal(diagnose.code, 0, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /Model: ok/);
    assert.match(diagnose.stdout, /model list only - no inference was run/);
    assert.match(diagnose.stdout, /Remote synchronization: not checked/);
    assert.equal(stub.requests.length, 0, 'the preflight ran no completion request');
    assert.ok(elapsed < 30000, `preflight took ${Math.round(elapsed)} ms`);

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /available \(model list checked; no inference was run\)/);
    assert.equal(stub.requests.length, 0);
  });
});
