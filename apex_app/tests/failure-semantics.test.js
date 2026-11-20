// Implementation 104: one request traced through input validation, authorization,
// execution, verification, persistence, the audit record, and the user-visible result.
// Each failure is injected at one boundary, and the response must agree with the
// strongest evidence: a rejected input never ran, a denied action never ran, a failed
// verification is not success, a write that failed after it started is disclosed as
// unknown rather than retried, and a missing audit record is never invented.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { StoreError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { main } from '../src/cli.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function capture() {
  return {
    text: '',
    write(chunk) { this.text += chunk; return true; },
  };
}

async function runThroughCli(app, dir, argv) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }),
    stdout,
    stderr,
    stdin: { isTTY: false },
    appFactory: () => app,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('104: the response never claims more than the pipeline established', () => {
  test('a rejected input stops before execution, and a denied action stops before it too', async () => {
    const app = createApp({ dataDir: tempDir() });

    // The action was selected, but its input was refused. The body never ran.
    const rejected = await app.controller.handle('calc 1+', { origin: 'user' });
    assert.equal(rejected.status, Outcome.INPUT_REJECTED);
    assert.equal(rejected.operation.steps[0].execution.status, 'rejected');
    assert.equal(rejected.operation.steps[0].verification.outcome, 'not_run');
    assert.match(rejected.display, /expression ends unexpectedly/);

    // A model origin may propose a memory write, but authorization denies it.
    const denied = await app.controller.handle('remember that the launch code is Zephyr', { origin: 'model' });
    assert.equal(denied.status, Outcome.ACTION_DENIED);
    assert.equal(denied.operation.steps[0].authorization.decision, 'deny');
    assert.equal(denied.operation.steps[0].authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.equal(denied.operation.steps[0].execution.status, 'not_run');
    assert.equal((await app.memory.list()).length, 0, 'the denied write left no record');

    const records = (await app.operations.inspect()).records;
    assert.deepEqual(records.map((r) => r.status), [Outcome.INPUT_REJECTED, Outcome.ACTION_DENIED]);
  });

  test('failed and unavailable verification are distinct from success and from each other', async () => {
    const dir = tempDir();
    const failedApp = createApp({ dataDir: dir });
    failedApp.controller.verifier.check = async () => ({
      outcome: Outcome.VERIFICATION_FAILED,
      detail: 'injected: the stored value differs from the request',
    });
    const failed = await runThroughCli(failedApp, dir, ['ask', 'calc', '2+2']);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /Status:\s+verification_failed/);
    assert.match(failed.stdout, /result NOT confirmed: injected: the stored value differs/);
    assert.doesNotMatch(failed.stdout, /Status:\s+success_verified/);
    assert.equal((await failedApp.operations.inspect()).records.at(-1).status, Outcome.VERIFICATION_FAILED);

    const gapDir = tempDir();
    const gapApp = createApp({ dataDir: gapDir });
    gapApp.controller.verifier.check = async () => ({
      outcome: Outcome.VERIFICATION_UNAVAILABLE,
      detail: 'injected: the evidence could not be read',
    });
    const gap = await runThroughCli(gapApp, gapDir, ['ask', 'calc', '2+2']);
    assert.equal(gap.code, 1, gap.stdout + gap.stderr);
    assert.match(gap.stdout, /Status:\s+verification_unavailable/);
    assert.match(gap.stdout, /executed; verification unavailable: injected: the evidence could not be read/);
    assert.doesNotMatch(gap.stdout, /Status:\s+success_verified/);
  });

  test('a write that fails after it started is disclosed as unknown and is not retried', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    const original = app.memory.add.bind(app.memory);
    let calls = 0;
    app.memory.add = async (...args) => {
      calls += 1;
      const record = await original(...args);
      throw new Error('injected: the write completed, then the writer failed');
    };

    const res = await runThroughCli(app, dir, ['ask', 'remember that the archive code is 7412']);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+execution_failed/);
    assert.match(res.stdout, /execution failed: injected: the write completed/);
    assert.match(res.stdout, /cannot establish whether it changed stored data/);
    assert.match(res.stdout, /do not repeat it unless you can confirm it did not take effect/);
    assert.equal(calls, 1, 'the failed write was attempted once, not automatically retried');
    assert.equal((await app.memory.list()).length, 1, 'the side effect that did occur is still there');

    const record = (await app.operations.inspect()).records.at(-1);
    assert.equal(record.status, Outcome.EXECUTION_FAILED);
    assert.equal(record.steps[0].execution.status, 'failed');
    assert.equal(record.steps[0].verification.outcome, 'not_run');
    assert.equal(record.steps[0].result, null, 'no result was invented for the failed step');
  });

  test('a missing audit record is disclosed, exit 3, and the write is not repeated', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });
    app.operations.append = async () => { throw new StoreError('injected: audit write failed'); };

    const res = await runThroughCli(app, dir, ['ask', 'remember that the audit boundary is tested']);
    assert.equal(res.code, 3, res.stdout + res.stderr);
    assert.match(res.stdout, /Audit:\s+NOT RECORDED/);
    assert.match(res.stdout, /Do not repeat the request just to obtain a record/);
    assert.match(res.stdout, /that action may already have happened/);
    assert.equal((await app.memory.list()).length, 1, 'the write happened once');
    assert.equal((await app.operations.inspect()).records.length, 0, 'no record was invented');
  });

  test('an unavailable data path is an environment failure, not a rejected request', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'data-is-a-file');
    fs.writeFileSync(blocker, 'x');
    const app = createApp({ dataDir: blocker });

    const res = await runThroughCli(app, blocker, ['ask', 'remember that nothing can be stored']);
    assert.equal(res.code, 3, res.stdout + res.stderr);
    // [T-30, 2026-11-19] The earlier execution_failed expectation is superseded: the ECP's
    // durable kill-switch latch is under dataDir too. An unreadable latch must deny before execute;
    // it is not an execution failure and must never be recast as one to satisfy a storage message.
    assert.match(res.stdout, /Status:\s+action_denied/);
    assert.match(res.stdout, /authorization deny \(POLICY_UNAVAILABLE\)/);
    assert.match(res.stdout, /Audit:\s+NOT RECORDED/);
    assert.doesNotMatch(res.stdout, /Status:\s+success_verified|execution failed:/);
    assert.equal(fs.existsSync(path.join(blocker, 'memory.jsonl')), false, 'no memory write was attempted');
    assert.equal(fs.readFileSync(blocker, 'utf8'), 'x');
  });
});
