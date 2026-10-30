// The real entry point, run as separate processes. The restart tests start one
// process, exit, and start another against the same data directory.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli, startStubModel, closedPortUrl } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { main } from '../src/cli.js';
import { Outcome } from '../src/outcomes.js';
import { StoreError } from '../src/errors.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

// Each test gets its own data directory. The home directory is pointed at the same
// temp directory so the default data path cannot touch the real ~/.apex either.
function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
      return true;
    },
  };
}

describe('command line', () => {
  test('task run exits nonzero when a required step audit record is missing', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir, gateway: new ModelGateway({ backend: new NoBackend() }) });
    await app.controller.planTask('calc 1+1');
    const task = (await app.taskStore.list())[0];
    const originalAppend = app.operations.append.bind(app.operations);
    app.operations.append = async (record) => {
      if (record.capability === 'task.step') throw new Error('injected step audit failure');
      return originalAppend(record);
    };
    const stdout = capture();
    const stderr = capture();

    const code = await main(['task', 'run', task.id], {
      env: envFor(dataDir),
      stdout,
      stderr,
      stdin: { isTTY: false },
      appFactory: () => app,
    });

    assert.equal(code, 1);
    assert.match(stdout.text, /Audit integrity failure/);
    assert.match(stderr.text, /could not be written/);
    assert.equal((await app.taskStore.get(task.id)).status, 'completed');
    assert.equal((await app.operations.list({ limit: 20 })).records.some((r) => r.status === Outcome.AUDIT_INTEGRITY_FAILED), true);
  });

  test('task run reports a step that already ran when the task log refuses the result', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir, gateway: new ModelGateway({ backend: new NoBackend() }) });
    await app.controller.planTask('calc 1+1');
    const task = (await app.taskStore.list())[0];
    const original = app.taskStore.transition.bind(app.taskStore);
    let injected = false;
    app.taskStore.transition = async (id, event) => {
      if (!injected && event.steps?.some((s) => s.to === 'completed')) {
        injected = true;
        throw new StoreError('injected: task log write failed');
      }
      return original(id, event);
    };
    const stdout = capture();
    const stderr = capture();

    const code = await main(['task', 'run', task.id], {
      env: envFor(dataDir),
      stdout,
      stderr,
      stdin: { isTTY: false },
      appFactory: () => app,
    });

    assert.equal(code, 1);
    assert.match(stdout.text, /had already returned success_verified/);
    assert.match(stdout.text, /its own audit record/);
    assert.match(stdout.text, /APEX will not run it again/);
    assert.match(stdout.text, /Audit: recorded in operations\.jsonl/);
    assert.doesNotMatch(`${stdout.text}${stderr.text}`, /execution failed/i);
    assert.equal((await app.taskStore.get(task.id)).status, 'running');
  });

  test('the application starts and reports status with no model configured', async () => {
    const dataDir = tempDir();
    const r = await runCli(['status'], envFor(dataDir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^APEX Local Alpha 0\.1\.0/);
    assert.match(r.stdout, /Model backend: none configured/);
    assert.match(r.stdout, /Memory records: 0/);
  });

  test('status --model reports an unreachable model without blaming the data store', async () => {
    const dataDir = tempDir();
    const url = await closedPortUrl();
    const r = await runCli(['status', '--model'], envFor(dataDir, {
      APEX_MODEL_URL: url,
      APEX_MODEL_PROVIDER: 'ollama',
      APEX_MODEL_NAME: 'missing-model',
      APEX_MODEL_TIMEOUT_MS: '1000',
    }));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /Model backend: .* - unavailable:/);
    assert.doesNotMatch(r.stderr, /data store unavailable/);
    assert.match(r.stdout, /Memory records: 0/);
  });

  test('help and version work without any configuration', async () => {
    const dataDir = tempDir();
    const help = await runCli(['help'], envFor(dataDir));
    assert.equal(help.code, 0);
    assert.match(help.stdout, /node bin\/apex\.js ask/);
    const version = await runCli(['version'], envFor(dataDir));
    assert.equal(version.stdout.trim(), 'APEX Local Alpha 0.1.0');
  });

  test('memory and records survive a restart: a second process reads what the first wrote', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);

    const first = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Status:\s+success_verified/);
    const firstOp = first.stdout.match(/Operation: ([0-9a-f-]{36})/)[1];

    // New process, same data directory.
    const second = await runCli(['ask', 'recall codename'], env);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /the project codename is Lighthouse/);

    const history = await runCli(['history'], env);
    assert.equal(history.code, 0);
    assert.ok(history.stdout.includes(firstOp), 'the first operation record must survive the restart');
    assert.equal(history.stdout.trim().split('\n').length, 2);

    const status = await runCli(['status'], env);
    assert.match(status.stdout, /Memory records: 1/);
    assert.match(status.stdout, /Operation records: 2/);
  });

  test('memory correction CLI requires explicit resolution and preserves inspectable history', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const stored = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(stored.code, 0, stored.stderr);

    const listed = await runCli(['ask', 'list memory'], env);
    assert.equal(listed.code, 0, listed.stderr);
    const targetId = listed.stdout.match(/\[([0-9a-f]{8}-[0-9a-f-]{27})\]/i)?.[1];
    assert.ok(targetId, `expected a full memory ID in list output: ${listed.stdout}`);

    const missingConsent = await runCli(['memory', 'correct', targetId, 'The', 'project', 'codename', 'is', 'Bluebird'], env);
    assert.equal(missingConsent.code, 2);
    assert.match(missingConsent.stderr, /--resolve/);

    const corrected = await runCli(['memory', 'correct', '--resolve', targetId, 'The', 'project', 'codename', 'is', 'Bluebird'], env);
    assert.equal(corrected.code, 0, corrected.stderr + corrected.stdout);
    assert.match(corrected.stdout, new RegExp(`corrects ${targetId}`));
    assert.match(corrected.stdout, /Earlier evidence remains stored/);

    const after = await runCli(['ask', 'list memory'], env);
    assert.equal(after.code, 0);
    assert.match(after.stdout, new RegExp(`${targetId}.*superseded`));
    assert.match(after.stdout, new RegExp(`corrects ${targetId}`));

    const history = await runCli(['history'], env);
    assert.equal(history.code, 0);
    assert.match(history.stdout, /memory\.correct/);
    assert.doesNotMatch(history.stdout, /The project codename is Bluebird/);
    const rawAudit = await fs.readFile(path.join(dataDir, 'operations.jsonl'), 'utf8');
    assert.doesNotMatch(rawAudit, /The project codename is Bluebird/);
  });

  test('a verified calculation is shown with its verification result', async () => {
    const dataDir = tempDir();
    const r = await runCli(['ask', 'calc', '(2+3)*4'], envFor(dataDir));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /verification success_verified/);
    assert.match(r.stdout, /\(2\+3\)\*4 = 20/);
  });

  test('a request needing a model, with no model configured, exits 1 and says nothing was generated', async () => {
    const dataDir = tempDir();
    const r = await runCli(['ask', 'what is the capital of France'], envFor(dataDir));
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Status:\s+model_unavailable/);
    assert.match(r.stdout, /Nothing has been generated/);
  });

  test('ask with --save-answer stores a model answer as a model_conclusion only on explicit request', async () => {
    const dataDir = tempDir();
    const s = await startStubModel();
    stubs.push(s);
    s.behavior.reply = 'You appear to work best in the morning.';
    const env = envFor(dataDir, { APEX_MODEL_URL: s.url, APEX_MODEL_NAME: 'stub' });

    const without = await runCli(['ask', 'when do I work best?'], env);
    assert.equal(without.code, 0, without.stdout + without.stderr);
    assert.match(without.stdout, /model answer; APEX cannot independently verify/);
    let status = await runCli(['status'], env);
    assert.match(status.stdout, /Memory records: 0/);

    const withSave = await runCli(['ask', '--save-answer', 'when do I work best again?'], env);
    assert.equal(withSave.code, 0, withSave.stdout + withSave.stderr);
    status = await runCli(['status'], env);
    assert.match(status.stdout, /Memory records: 1/);
    const recall = await runCli(['ask', 'recall', 'morning'], env);
    assert.match(recall.stdout, /model_conclusion from model/);
    assert.match(status.stdout, /Model backend: http:\/\/127\.0\.0\.1:\d+/);
  });

  test('a model answer whose proposed action is denied is not reported as success', async () => {
    const dataDir = tempDir();
    const s = await startStubModel();
    stubs.push(s);
    const env = envFor(dataDir, { APEX_MODEL_URL: s.url, APEX_MODEL_NAME: 'stub' });

    // The model claims it saved something, but memory writes from a model origin
    // are denied by the registry. The request was only partly completed.
    s.behavior.reply = 'I saved that for you.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"the launch code is Zephyr"}}';
    const denied = await runCli(['ask', 'what is the launch code?'], env);
    assert.equal(denied.code, 1, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /Status:\s+verification_unavailable/);
    assert.match(denied.stdout, /did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)/);

    // A proposal that executes and verifies is still a successful request.
    s.behavior.reply = 'It is 4.\nPROPOSE_ACTION {"action":"calc.evaluate","input":{"expression":"2+2"}}';
    const verified = await runCli(['ask', 'explain why two plus two makes four'], env);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /verification success_verified/);
  });

  test('a model answer with no proposal still exits 0', async () => {
    const dataDir = tempDir();
    const s = await startStubModel();
    stubs.push(s);
    s.behavior.reply = 'Paris is the capital of France.';
    const r = await runCli(['ask', 'what is the capital of France?'], envFor(dataDir, { APEX_MODEL_URL: s.url, APEX_MODEL_NAME: 'stub' }));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Status:\s+verification_unavailable/);
  });

  test('usage errors exit 2 with a clear message', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const noText = await runCli(['ask'], env);
    assert.equal(noText.code, 2);
    assert.match(noText.stderr, /usage: ask/);
    const unknown = await runCli(['launch-missiles'], env);
    assert.equal(unknown.code, 2);
    const badFlag = await runCli(['history', '--bogus'], env);
    assert.equal(badFlag.code, 2);
  });

  test('invalid configuration is refused with exit 2 (remote endpoint without the explicit opt-in)', async () => {
    const dataDir = tempDir();
    const r = await runCli(['status'], envFor(dataDir, { APEX_MODEL_URL: 'https://api.example.com' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not loopback/);
    const t = await runCli(['status'], envFor(dataDir, { APEX_MODEL_TIMEOUT_MS: 'soon' }));
    assert.equal(t.code, 2);
    assert.match(t.stderr, /APEX_MODEL_TIMEOUT_MS must be a whole number between/);
    assert.match(t.stderr, /No data was read or changed/);

    const missingName = await runCli(['status'], envFor(dataDir, {
      APEX_MODEL_PROVIDER: 'ollama',
      APEX_MODEL_URL: 'http://127.0.0.1:11434',
    }));
    assert.equal(missingName.code, 2);
    assert.match(missingName.stderr, /APEX_MODEL_NAME is required/);
    assert.match(missingName.stderr, /No data was read or changed/);
    assert.deepEqual(await fs.readdir(dataDir), [], 'invalid configuration must not create any store');
  });

  test('an unavailable data store fails safely: status exits 1, and a write is not reported as recorded', async () => {
    const dataDir = tempDir();
    const blocker = path.join(dataDir, 'data-is-a-file');
    await fs.writeFile(blocker, 'x');
    const env = envFor(blocker);
    const status = await runCli(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.stderr, /store unavailable/);
    const write = await runCli(['ask', 'remember that nothing can be stored'], env);
    assert.equal(write.code, 3, 'an unrecorded operation must exit 3');
    assert.match(write.stdout, /Audit:\s+NOT RECORDED/);
  });
});
