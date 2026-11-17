// Two defects found by operating the real runtime in two processes: `runtime stop` reported
// success while the foreground `runtime start` process stayed alive holding the lease, and
// `runtime status` reported the configured 5000 ms interval while the live process used the
// interval it was started with. Both are asserted here against real processes: the foreground
// runtime is a spawned `bin/apex.js runtime start`, and every other command is its own process.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT } from './helpers.js';

const START_CEILING_MS = 60000;
const EXIT_CEILING_MS = 20000;

function startForeground(dataDir, intervalMs, env) {
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex.js'), 'runtime', 'start', '--interval', String(intervalMs)], {
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
  const handle = { child, exited, output: () => `${out}${err}` };
  const ready = new Promise((resolve) => {
    const check = () => { if (/started \(boot \d+\)/.test(out)) resolve('ready'); };
    child.stdout.on('data', check);
    check();
  });
  const lost = exited.then((info) => {
    throw new Error(`the runtime exited before the test used it (exit ${info.code ?? info.signal}). ${handle.output()}`);
  });
  const ceiling = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`the runtime did not start within ${START_CEILING_MS} ms. ${handle.output()}`)), START_CEILING_MS);
    child.once('exit', () => clearTimeout(timer));
  });
  return { handle, ready: Promise.race([ready, lost, ceiling]) };
}

function within(promise, ms, describe) {
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${describe} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

describe('a foreground runtime observes an external stop', () => {
  test('the stop rendered by a second process ends the foreground process and releases the lease', async () => {
    const dir = makeTempDataDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir });
    const { handle, ready } = startForeground(dir, 250, env);
    try {
      await ready;
      const startedStatus = await runCli(['runtime', 'status'], env);
      assert.equal(startedStatus.code, 0, startedStatus.stderr);
      // The live cycle is reported from the process that runs it, not the stored default.
      assert.match(startedStatus.stdout, /interval 250 ms \(live\)/);
      assert.match(startedStatus.stdout, new RegExp(`lease: held by pid ${handle.child.pid}`));

      const stopped = await runCli(['runtime', 'stop', '--reason', 'issued by a second process'], env);
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.match(stopped.stdout, /Runtime stopped at/);

      const exit = await within(handle.exited, EXIT_CEILING_MS, 'the foreground runtime');
      assert.equal(exit.code, 0, `the foreground runtime exited ${exit.code}. ${handle.output()}`);
      assert.match(handle.output(), /stopped from another process/);
      assert.equal(fs.existsSync(path.join(dir, 'runtime.lock')), false, 'the foreground process left its lease behind');

      const after = await runCli(['runtime', 'status'], env);
      assert.equal(after.code, 0, after.stderr);
      assert.match(after.stdout, /is stopped/);
      assert.match(after.stdout, /interval 5000 ms \(configured; no live cycle\)/);
      assert.match(after.stdout, /lease: not held/);
    } finally {
      if (handle.child.exitCode === null) {
        handle.child.kill();
        await Promise.race([handle.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
      cleanup(dir);
    }
  });
});
