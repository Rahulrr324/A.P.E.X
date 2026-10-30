// Implementation 063: the system-readiness acceptance run for Batch E.
//
// One test per acceptance point. Every command line is the real entry point
// (bin/apex.js), in its own process, against a fresh temporary data directory with
// HOME/USERPROFILE redirected as well, so nothing here can read or write a developer's
// own ~/.apex. The only stand-in is a local HTTP server that speaks the OpenAI chat shape
// and returns a fixed reply: it says how APEX classifies an endpoint's answer and nothing
// about any real model. No inference is run, and no model is downloaded.
//
// The interruption test starts the real fixture from Implementation 055 and terminates it
// with `kill()` while it is inside a step; the assertions after that point are made by
// separate processes reading what the dead one left behind.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, closedPortUrl, startStubModel, APP_ROOT } from './helpers.js';
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

const STORE_FILES = ['memory.jsonl', 'knowledge.jsonl', 'operations.jsonl', 'conversation.jsonl', 'session.json', 'tasks.jsonl'];

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}
const readJsonl = (file) => readLines(file).map((l) => JSON.parse(l));

function snapshot(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files[name] = fs.readFileSync(p);
  }
  return files;
}

const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs');

// Starts the 055 fixture and resolves once it prints READY, which happens only after the
// write step is recorded as running and its side effect is on disk.
async function startInterruptedChild(dataDir, effectFile) {
  const child = spawn(process.execPath, [CHILD, dataDir, effectFile], {
    env: envFor(dataDir),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  children.push({ child, exited });
  const ready = new Promise((resolve) => {
    const check = () => { if (out.includes('READY\n')) resolve(); };
    child.stdout.on('data', check);
    check();
  });
  const ceiling = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never reached its step: ${out}`)), 90000);
    child.once('exit', () => clearTimeout(timer));
  });
  const lost = exited.then((info) => {
    throw new Error(`the child exited before the test terminated it (${info.code ?? info.signal}): ${out}`);
  });
  await Promise.race([ready, lost, ceiling]);
  return { child, exited, output: () => out };
}

describe('063: system readiness acceptance', () => {
  test('1. initialization is lazy, isolated, and leaves existing user data byte-identical', async () => {
    const root = tempDir();
    // A pre-existing APEX home, as a user who already has data would have. APEX must not
    // read it, migrate it, or append to it: the data directory is the only place it writes.
    const home = path.join(root, 'home');
    const existing = path.join(home, '.apex');
    fs.mkdirSync(existing, { recursive: true });
    const existingFile = path.join(existing, 'memory.jsonl');
    fs.writeFileSync(existingFile, `${JSON.stringify({ schema: 'user.memory.v1', id: 'pre-existing', content: 'hand-written record' })}\n`, 'utf8');
    const before = fs.readFileSync(existingFile);
    const beforeNames = fs.readdirSync(existing).sort();

    const dataDir = path.join(root, 'data');
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, HOME: home, USERPROFILE: home });

    const started = await runCli(['status'], env);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    assert.match(started.stdout, /Data directory: /);
    assert.match(started.stdout, /Memory records: 0/, 'a fresh data directory starts empty');

    const remember = await runCli(['ask', 'remember that the archive code is 7412'], env);
    assert.equal(remember.code, 0, remember.stdout + remember.stderr);
    assert.match(remember.stdout, /Status:\s+success_verified/);
    const recall = await runCli(['ask', 'recall archive'], env);
    assert.equal(recall.code, 0, recall.stdout + recall.stderr);
    assert.match(recall.stdout, /7412/, 'the fact is retrievable from the new data directory');

    // Initialization happened where it was told to, and only there.
    assert.deepEqual(fs.readdirSync(existing).sort(), beforeNames, 'no file was added to the existing home');
    assert.deepEqual(fs.readFileSync(existingFile), before, 'the existing record is byte-identical');
    const created = fs.readdirSync(dataDir).sort();
    for (const name of created) assert.ok(STORE_FILES.includes(name), `only APEX store files are created, saw ${name}`);
    for (const name of ['memory.jsonl', 'operations.jsonl', 'conversation.jsonl', 'session.json']) {
      assert.ok(created.includes(name), `${name} was created in the data directory`);
    }

    // There is no `init` command: a mistyped command must not create anything.
    const mistaken = path.join(root, 'never-created');
    const init = await runCli(['init'], cleanEnv({ APEX_DATA_DIR: mistaken, HOME: home, USERPROFILE: home }));
    assert.equal(init.code, 2, init.stdout + init.stderr);
    assert.match(init.stderr, /unknown command: init/);
    assert.equal(fs.existsSync(mistaken), false, 'an unknown command creates no data directory');
  });

  test('2. a deterministic action runs, is verified, and needs no model', async () => {
    const dataDir = tempDir();
    const res = await runCli(['ask', 'calc', '2+2'], envFor(dataDir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/);
    assert.match(res.stdout, /= 4/);
    assert.match(res.stdout, /calc\.evaluate \[origin user\]: authorization allow \(PERMITTED\); execution ok; verification success_verified/);

    const op = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(op.status, 'success_verified');
    assert.equal(op.capability, 'calc.evaluate');
    assert.equal(op.backend, null, 'the answer came from the action, not a model');
    assert.equal(op.steps[0].verification.outcome, 'success_verified');
    assert.equal(typeof op.steps[0].verification.detail, 'string', 'the record says how the check was made');

    const status = await runCli(['status'], envFor(dataDir));
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Model backend: none configured/, 'no model is configured, and saying so is not a defect');
  });

  test('3. a model-dependent request fails honestly when the endpoint is unavailable', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir, {
      APEX_MODEL_URL: await closedPortUrl(),
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '1000',
      APEX_MODEL_RETRIES: '0',
    });
    const res = await runCli(['ask', 'what is the capital of France?'], env);
    assert.equal(res.code, 1, 'nothing was answered, so this is not success');
    assert.match(res.stdout, /Status:\s+execution_failed/);
    assert.match(res.stdout + res.stderr, /UNREACHABLE/);
    assert.match(res.stdout, /No answer has been generated/);

    const op = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(op.status, 'execution_failed');
    assert.match(op.output, /No answer has been generated/, 'the record states that nothing was answered');
    assert.doesNotMatch(op.output, /capital of France is/, 'and holds no invented answer');
    const turns = readJsonl(path.join(dataDir, 'conversation.jsonl'));
    assert.equal(turns.some((t) => t.origin === 'model'), false, 'no model turn exists');
    assert.equal(turns.every((t) => t.verified !== true), true, 'nothing is marked verified');

    const status = await runCli(['status', '--model'], env);
    assert.equal(status.code, 1, 'an unreachable endpoint is reported as attention, not success');
    assert.match(status.stdout, /- unavailable: could not reach the endpoint/);
  });

  test('4. an authorized action follows the existing path, and a model cannot authorize itself', async () => {
    const stub = await startStubModel();
    stubs.push(stub);
    const dataDir = tempDir();
    const env = envFor(dataDir, {
      APEX_MODEL_URL: stub.url,
      APEX_MODEL_PROVIDER: 'openai',
      APEX_MODEL_NAME: 'stub',
      APEX_MODEL_TIMEOUT_MS: '5000',
      APEX_MODEL_RETRIES: '0',
    });

    // A read the model proposes goes through authorization, execution, and verification.
    stub.behavior.reply = 'PROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"123*456"}}';
    const read = await runCli(['ask', 'what is 123 times 456?'], env);
    assert.equal(read.code, 0, read.stdout + read.stderr);
    assert.match(read.stdout, /calc\.evaluate \[origin model\]: authorization allow \(PERMITTED\); execution ok; verification success_verified/);
    assert.match(read.stdout, /= 56088/, 'the number is the executor\'s, and the verifier agreed');
    const readOp = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(readOp.steps[0].origin, 'model');
    assert.equal(readOp.steps[0].authorization.decision, 'allow');

    // A write the model proposes is denied by the policy, before anything runs.
    stub.behavior.reply = 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}';
    const write = await runCli(['ask', 'please keep track of my preferences'], env);
    assert.notEqual(write.code, 0, 'a denied proposal is not success');
    assert.match(write.stdout, /memory\.add \[origin model\]: authorization deny \(ORIGIN_NOT_PERMITTED\)/);
    const writeOp = readJsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    const step = writeOp.steps.find((s) => s.action === 'memory.add');
    assert.equal(step.outcome, 'action_denied');
    assert.equal(step.execution.status, 'not_run', 'a denied action did not run');
    assert.deepEqual(readJsonl(path.join(dataDir, 'memory.jsonl')), [], 'nothing was stored');
    assert.equal(stub.requests.length, 2, 'two replies were asked for and both were handled');
  });

  test('5. a failed or interrupted operation never becomes a fabricated success', async () => {
    // 5a. A deterministic failure.
    const failedDir = tempDir();
    const failed = await runCli(['ask', 'calc', '1/0'], envFor(failedDir));
    assert.equal(failed.code, 1, 'a failed action is not success');
    assert.match(failed.stdout, /Status:\s+execution_failed/);
    const failedOp = readJsonl(path.join(failedDir, 'operations.jsonl')).at(-1);
    assert.equal(failedOp.status, 'execution_failed');
    assert.equal(failedOp.steps[0].outcome, 'execution_failed');
    for (const turn of readJsonl(path.join(failedDir, 'conversation.jsonl'))) {
      assert.notEqual(turn.verified, true, 'a failed action is never stored as verified');
    }

    // 5b. A real process terminated inside a step.
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = envFor(dataDir);
    const opsFile = path.join(dataDir, 'operations.jsonl');
    const running = await startInterruptedChild(dataDir, effectFile);
    const opsBeforeKill = readLines(opsFile);
    assert.equal(running.child.kill(), true, 'the process was signalled');
    const exit = await running.exited;
    assert.notEqual(exit.code, 0, 'it did not exit cleanly');
    assert.deepEqual(readLines(opsFile), opsBeforeKill, 'the lost process wrote no operation record of its own');

    const taskId = readJsonl(path.join(dataDir, 'tasks.jsonl')).find((e) => e.type === 'task_created').taskId;
    const short = shortId(taskId);

    // A read of the records never presents the unfinished step as complete.
    const explain = await runCli(['task', 'explain', short], env);
    assert.equal(explain.code, 1, explain.stdout + explain.stderr);
    assert.match(explain.stdout, /1 of 2 step\(s\) verified complete; 1 unresolved/);
    assert.equal(/2 of 2 step\(s\)/.test(explain.stdout), false);

    // Recovery resolves the unknown step without re-running it, and records that it did so.
    const resume = await runCli(['task', 'resume', short], env);
    assert.equal(resume.code, 1, 'an uncertain step is not run again, so the task is not finished');
    assert.match(resume.stdout, /step s2 is uncertain and was not run again/);
    assert.deepEqual(readLines(effectFile), ['s1', 'block-start'], 'no step ran twice');
    const stepsStarted = readJsonl(path.join(dataDir, 'tasks.jsonl'))
      .flatMap((e) => (e.steps ?? []).filter((s) => s.to === 'running').map((s) => s.id));
    assert.deepEqual(stepsStarted, ['s1', 's2'], 'each step started at most once');
    const stepRecords = readJsonl(opsFile).filter((r) => r.capability === 'task.step');
    assert.equal(stepRecords.length, 1, 'only the step that finished has an audit record');
    assert.equal(stepRecords[0].task.stepId, 's1');
  });

  test('6. conversation history and the audit log carry the same outcome', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const ok = await runCli(['ask', 'calc', '6*7'], env);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    const bad = await runCli(['ask', 'calc', '1/0'], env);
    assert.equal(bad.code, 1, bad.stdout + bad.stderr);

    const ops = readJsonl(path.join(dataDir, 'operations.jsonl'));
    const turns = readJsonl(path.join(dataDir, 'conversation.jsonl'));
    const byId = new Map(ops.map((o) => [o.id, o]));
    for (const turn of turns) {
      if (turn.verified !== true) continue;
      const op = byId.get(turn.operationId);
      assert.ok(op, `a verified turn names an operation record: ${turn.operationId}`);
      assert.equal(op.status, 'success_verified', 'a verified turn only ever belongs to a verified operation');
    }
    const verifiedTurns = turns.filter((t) => t.verified === true);
    assert.equal(verifiedTurns.length, 1, 'only the calculation that succeeded produced a verified turn');
    assert.equal(byId.get(verifiedTurns[0].operationId).status, 'success_verified');

    // The audit log itself shows both outcomes, in the order they happened.
    const history = await runCli(['history'], env);
    assert.equal(history.code, 0, history.stdout + history.stderr);
    const rows = history.stdout.split('\n').filter((l) => /\s(success_verified|execution_failed)\s/.test(l));
    assert.equal(rows.length >= 2, true);
    assert.match(rows[0], /execution_failed/, 'newest first: the failure is listed before the earlier success');
    assert.match(rows[1], /success_verified/);
  });

  test('7. diagnostics report damage without changing the authoritative state', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    assert.equal((await runCli(['ask', 'remember that the code is 8891'], env)).code, 0);
    assert.equal((await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], env)).code, 0);

    // Damage the stores the way a partial write or a hand edit would.
    fs.appendFileSync(path.join(dataDir, 'memory.jsonl'), '{ this is not a record\n', 'utf8');
    fs.appendFileSync(path.join(dataDir, 'tasks.jsonl'), '{"schema":\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'session.json'), '{ "sessionId": ', 'utf8');
    const before = snapshot(dataDir);

    const first = await runCli(['diagnose'], env);
    assert.equal(first.code, 1, 'damage is attention, not success');
    assert.match(first.stdout, /Memory: .*corrupt line/);
    assert.match(first.stdout, /Tasks: unavailable|Tasks: .*corrupt/);
    assert.match(first.stdout, /Session: corrupt/);
    assert.deepEqual(snapshot(dataDir), before, 'diagnostics changed nothing on disk');

    const second = await runCli(['diagnose'], env);
    assert.equal(second.code, 1);
    assert.equal(second.stdout, first.stdout, 'the same damage is reported the same way, twice');
    assert.deepEqual(snapshot(dataDir), before);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Integrity: attention required/);
    assert.deepEqual(snapshot(dataDir), before, 'status changed nothing either');

    // A damaged log is not extended: a write is refused rather than appended to it. The
    // refusal itself is audited, which is why only the operation log may grow.
    const write = await runCli(['ask', 'remember that the code is 9900'], env);
    assert.equal(write.code, 1, 'a write to a damaged store is refused');
    const after = snapshot(dataDir);
    for (const name of ['memory.jsonl', 'tasks.jsonl', 'session.json', 'conversation.jsonl']) {
      assert.deepEqual(after[name], before[name], `${name} is unchanged by the refused write`);
    }
    const newLines = after['operations.jsonl'].toString('utf8').slice(before['operations.jsonl'].length).trim().split('\n');
    assert.equal(newLines.length, 1, 'the refusal added exactly one audit record');
    const refusal = JSON.parse(newLines[0]);
    assert.notEqual(refusal.status, 'success_verified', 'the refused write is not recorded as success');
    assert.equal(refusal.errors.some((e) => e.stage === 'execution' || e.code === 'STORE_UNAVAILABLE'), true, `the audit names the failed stage: ${JSON.stringify(refusal.errors)}`);
  });
});
