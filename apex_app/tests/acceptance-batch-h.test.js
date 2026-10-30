// Batch H / 097: integrated acceptance for 087-096.
//
// One cross-component contract per scenario, driven through the real CLI and the real
// application components in isolated temporary directories. Model behaviour is a local
// stub server, never inference; the task-recovery test terminates a real child process.
// Fixtures already used by the focused suites are reused rather than re-implemented.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import {
  makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, closedPortUrl, APP_ROOT,
} from './helpers.js';
import { shortId } from '../src/util.js';
import { main } from '../src/cli.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, sha256Hex as knowledgeSha256 } from '../src/knowledge/knowledge-store.js';
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
// Every file by relative path, with its modification time and bytes. A read-only command
// must not create, remove, or rewrite anything.
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

describe('097: integrated acceptance', () => {
  test('1. a deterministic operation completes with no model configured', async () => {
    const dataDir = tempDir();
    const res = await runCli(['ask', 'calc 2+2'], envFor(dataDir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/);
    assert.match(res.stdout, /2\+2 = 4 \(verified\)/);
    const op = jsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(op.status, 'success_verified');
    assert.equal(op.prompt, null, 'no model context was retrieved or sent');
  });

  test('2. a reachable endpoint that lacks the configured model is reported as unconfirmed, not healthy', async () => {
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
    assert.match(diagnose.stdout, /model list only - no inference was run/);
    assert.equal(stub.requests.length, 0, 'readiness never ran an inference request');
  });

  test('3. a model proposal for a write is denied by authorization and stores nothing', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = 'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the launch code is 1234"}}';
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });

    const res = await runCli(['ask', 'save the launch code'], env);
    assert.equal(res.code, 1, 'a denied proposal is not success');
    assert.match(res.stdout, /did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.equal(fs.existsSync(path.join(dataDir, 'memory.jsonl')), false, 'the denied write stored nothing');
    const op = jsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.equal(op.steps[0].outcome, 'action_denied');
    assert.deepEqual(op.steps[0].authorization, { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
  });

  test('4. credential-like input is refused and never appears in output, diagnostics, or the audit log', async () => {
    const dataDir = tempDir();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const env = envFor(dataDir);

    const add = await runCli(['knowledge', 'add', '--subject', 'API key', '--relationship', 'is', '--object', secret], env);
    assert.equal(add.code, 1);
    assert.match(add.stdout, /looks like a password, key, or token; it was not stored/);
    assert.equal(add.stdout.includes(secret), false);
    assert.equal(add.stderr.includes(secret), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'knowledge.jsonl')), false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'operations.jsonl'), 'utf8').includes(secret), false);

    const diagnose = await runCli(['diagnose'], env);
    assert.equal(diagnose.stdout.includes(secret), false);
    assert.equal(diagnose.stderr.includes(secret), false);
  });

  test('5. an audit failure after an executed write exits 3 and never reports verified success', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const app = createApp({ dataDir });
    app.operations.append = async () => { throw new Error('injected audit failure'); };
    const stdout = capture();
    const stderr = capture();
    const code = await main(['knowledge', 'add', '--subject', 'Alpha', '--relationship', 'trusts', '--object', 'Beta'], {
      env,
      stdout,
      stderr,
      stdin: { isTTY: false },
      appFactory: () => app,
    });
    assert.equal(code, 3);
    assert.match(stderr.text, /Audit: NOT RECORDED \(injected audit failure\)/);
    assert.match(stdout.text, /Stored knowledge record/);
    assert.doesNotMatch(stdout.text, /verified/i, 'the outcome is not called verified');
    const records = jsonl(path.join(dataDir, 'knowledge.jsonl'));
    assert.equal(records.length, 1, 'the write may have happened; the report does not claim it did not');
    assert.equal(fs.existsSync(path.join(dataDir, 'operations.jsonl')), false);
  });

  test('6. a task interrupted after its side effect is recovered without repeating it', async () => {
    const dataDir = tempDir();
    const effectFile = path.join(dataDir, 'side-effects.txt');
    const env = envFor(dataDir);
    const effectLines = () => {
      try { return fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l !== ''); } catch { return []; }
    };
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'tests', 'fixtures', 'interrupted-run-child.mjs'), dataDir, effectFile], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'each step ran once');
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'the lost process wrote no second effect');

    const taskId = jsonl(path.join(dataDir, 'tasks.jsonl')).find((e) => e.type === 'task_created').taskId;
    const resume = await runCli(['task', 'resume', shortId(taskId)], env);
    assert.equal(resume.code, 1);
    assert.match(resume.stdout, /uncertain and was not run again/);
    assert.deepEqual(effectLines(), ['s1', 'block-start'], 'recovery repeated no side effect');
    const turn = jsonl(path.join(dataDir, 'conversation.jsonl')).filter((t) => t.origin === 'apex_task').at(-1);
    assert.equal(turn.verified, false);
    assert.match(turn.text, /interrupted/);
  });

  test('7. a corrupt store refuses writes, preserves its bytes, and is reported', async () => {
    const dataDir = tempDir();
    const memoryFile = path.join(dataDir, 'memory.jsonl');
    const damaged = '{"schema":1,"id":"partial';
    fs.writeFileSync(memoryFile, damaged);
    const env = envFor(dataDir);

    const refused = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /memory store contains 1 corrupt line\(s\); refusing incomplete write/);
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), damaged, 'the damaged bytes were not rewritten');

    const diagnose = await runCli(['diagnose'], env);
    assert.equal(diagnose.code, 1);
    assert.match(diagnose.stdout, /Memory: corrupt/);
    assert.match(diagnose.stdout, /interrupted append/);

    const calc = await runCli(['ask', 'calc 3*3'], env);
    assert.equal(calc.code, 0, 'a deterministic operation does not depend on the damaged store');
    assert.match(calc.stdout, /3\*3 = 9 \(verified\)/);
  });

  test('8. concurrent summary-queue updates preserve every intent', async () => {
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
  });

  test('9. a process that exits inside a lock takeover leaves the claim, and the next process completes the work', async () => {
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
      env,
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: 'ignore',
    });
    const exit = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    assert.equal(exit, 9, 'the child exited inside the election');
    assert.equal(fs.readFileSync(lock, 'utf8'), raw, 'the dead claim is left for inspection');
    assert.equal(fs.existsSync(`${lock}.takeover.${key}.0`), true, 'its abandoned token is left too');

    const run = await runCli(['task', 'run', taskShort], env);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /status: completed/);
    assert.match(run.stdout, /6\*7 = 42 \(verified\)/);
    assert.equal(fs.existsSync(lock), false, 'the next taker released its own claim');
    assert.equal(fs.existsSync(`${lock}.takeover.${key}.0`), true, 'the abandoned token is not deleted by a stranger');
  });

  test('10. knowledge conflict retrieval stays bounded and exact at 3,200 records', async () => {
    const dataDir = tempDir();
    const records = [];
    for (let i = 1; i <= 3200; i += 1) {
      const subject = `module ${i}`;
      const relationship = 'owned by';
      const object = `team ${i}`;
      records.push({
        schema: 1,
        id: randomUUID(),
        subject,
        relationship,
        object,
        evidence: `the release checklist covers module ${i} and budget item ${i}`,
        tripleHash: knowledgeSha256(`${subject}\x00${relationship}\x00${object}`),
        status: 'supported',
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
      });
    }
    for (const [object, at] of [['Zephyr', 3201], ['Falcon', 3202]]) {
      const subject = 'the launch code name';
      const relationship = 'is';
      records.push({
        schema: 1,
        id: randomUUID(),
        subject,
        relationship,
        object,
        evidence: null,
        tripleHash: knowledgeSha256(`${subject}\x00${relationship}\x00${object}`),
        status: 'supported',
        createdAt: new Date(Date.UTC(2026, 0, 1) + at * 1000).toISOString(),
        provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
      });
    }
    const file = path.join(dataDir, 'knowledge.jsonl');
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const started = performance.now();
    const res = await runCli(['knowledge', 'search', 'launch code name'], envFor(dataDir));
    const elapsed = performance.now() - started;
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(elapsed < 5000, `knowledge search at 3,200 records took ${Math.round(elapsed)} ms`);
    assert.match(res.stdout, /the launch code name --\[is\]--> (Zephyr|Falcon)/);
    assert.match(res.stdout, /the launch code name --\[is\]--> (Zephyr|Falcon)/);
    assert.equal((res.stdout.match(/conflicting \(conflicts with:/g) ?? []).length, 2);

    const hits = await new KnowledgeStore(file).search('launch code name', { limit: 10 });
    assert.deepEqual(hits.map((h) => h.record.object).sort(), ['Falcon', 'Zephyr']);
    for (const hit of hits) assert.deepEqual(hit.record.conflictsWith, [hits.find((o) => o !== hit).record.id]);
  });

  test('11. read-only diagnostics and views leave every persistent file unchanged', async () => {
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
    const readOnly = [
      ['status'],
      ['diagnose'],
      ['history', '--limit', '5'],
      ['task', 'list'],
      ['task', 'show', taskId],
      ['task', 'explain', taskId],
      ['knowledge', 'show', knowledgeId],
    ];
    for (const argv of readOnly) {
      const r = await runCli(argv, env);
      assert.ok(r.code === 0 || r.code === 1, `${argv.join(' ')} exited ${r.code}: ${r.stderr}`);
    }
    assert.deepEqual(snapshot(dataDir), before, 'a read-only command created, changed, or removed a file');
  });

  test('12. an unavailable or invalid neural-style response is untrusted data, never authority', async () => {
    const dataDir = tempDir();
    const stub = await startStubModel();
    stubs.push(stub);
    // The runtime of the proposal does not exist; this stub returns the response shape a
    // future one would send, including a field claiming authority.
    stub.behavior.reply = JSON.stringify({
      schema: 'apex.neural.response/1',
      requestId: 'r1',
      status: 'ok',
      authorized: true,
      proposals: [{
        kind: 'knowledge_claim',
        payload: { subject: 'Alpha', relationship: 'trusts', object: 'Beta' },
        authorized: true,
        confidence: 0.99,
      }],
    });
    const env = envFor(dataDir, { APEX_MODEL_URL: stub.url, APEX_MODEL_NAME: 'stub-model' });

    const claim = await runCli(['ask', 'record that Alpha trusts Beta'], env);
    assert.equal(claim.code, 0, 'the text is shown as a model answer');
    assert.match(claim.stdout, /Status:\s+verification_unavailable/);
    assert.match(claim.stdout, /"authorized":true/);
    assert.equal(fs.existsSync(path.join(dataDir, 'knowledge.jsonl')), false, 'a claimed authorization wrote nothing');
    assert.equal(fs.existsSync(path.join(dataDir, 'memory.jsonl')), false);
    const claimOp = jsonl(path.join(dataDir, 'operations.jsonl')).at(-1);
    assert.deepEqual(claimOp.steps, [], 'no proposal became an executed step');

    stub.behavior.raw = '{"schema":"apex.neural.response/1","status":"ok"';
    const invalid = await runCli(['ask', 'record that Alpha trusts Beta'], env);
    assert.equal(invalid.code, 1, 'an invalid response is a failure, not an answer');
    assert.match(invalid.stdout, /MALFORMED_RESPONSE/);
    assert.match(invalid.stdout, /No answer has been generated/);
    assert.equal(fs.existsSync(path.join(dataDir, 'knowledge.jsonl')), false);

    const unavailable = await runCli(['ask', 'record that Alpha trusts Beta'], envFor(dataDir, {
      APEX_MODEL_URL: await closedPortUrl(),
      APEX_MODEL_NAME: 'stub-model',
    }));
    assert.equal(unavailable.code, 1);
    assert.match(unavailable.stdout, /UNREACHABLE|unavailable|backend/i);
    assert.equal(fs.existsSync(path.join(dataDir, 'knowledge.jsonl')), false, 'an unreachable runtime changed nothing');
  });
});
