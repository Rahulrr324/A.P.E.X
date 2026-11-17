// T-16 real-world repair: replacing the runtime checkpoint while another process reads it.
//
// Windows can refuse a rename when the destination is open elsewhere, even though the writer
// lock serialised this write against every other writer. A `runtime stop` issued from a second
// process observed that as `fatal: EPERM: operation not permitted, rename ... -> runtime.json`,
// exited 1, and left the ticking runtime alive. These tests drive the real store against a real
// temporary directory with only `fs.renameSync` made to fail the way the operating system did.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempDataDir, cleanup } from './helpers.js';
import { RuntimeStateStore, defaultRuntimeState } from '../src/runtime/state.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function store(dir) {
  return new RuntimeStateStore(dir);
}

function transientError(code) {
  const err = new Error(`${code}: operation not permitted, rename`);
  err.code = code;
  return err;
}

// Counts attempts and fails the first `failures` of them, then performs the real rename.
function failFirstRename(failures, code = 'EPERM') {
  const real = fs.renameSync;
  const codes = [];
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls += 1;
    if (calls <= failures) {
      codes.push(code);
      throw transientError(code);
    }
    return real(from, to);
  };
  return {
    calls: () => calls,
    codes,
    restore: () => { fs.renameSync = real; },
  };
}

function stagedFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('runtime checkpoint replace under a transient operating-system refusal', () => {
  test('a transient EPERM is retried and the checkpoint is replaced', async () => {
    const dir = tempDir();
    const patched = failFirstRename(2);
    try {
      const saved = await store(dir).save(defaultRuntimeState({ now: () => new Date('2026-11-17T00:00:00.000Z') }));
      assert.equal(saved.lifecycle, 'stopped');
      assert.equal(patched.calls(), 3);
      assert.deepEqual(patched.codes, ['EPERM', 'EPERM']);
      const onDisk = JSON.parse(fs.readFileSync(`${dir}/runtime.json`, 'utf8'));
      assert.equal(onDisk.runtimeId, saved.runtimeId);
      assert.equal(onDisk.checksum, saved.checksum);
      assert.deepEqual(stagedFiles(dir), []);
    } finally {
      patched.restore();
    }
  });

  test('EACCES and EBUSY are treated the same way as EPERM', async () => {
    for (const code of ['EACCES', 'EBUSY']) {
      const dir = tempDir();
      const patched = failFirstRename(1, code);
      try {
        await store(dir).save(defaultRuntimeState({ now: () => new Date('2026-11-17T00:00:00.000Z') }));
        assert.equal(patched.calls(), 2, code);
        assert.ok(fs.existsSync(`${dir}/runtime.json`), code);
      } finally {
        patched.restore();
      }
    }
  });

  test('the retries are bounded and the operating-system error is reported', async () => {
    const dir = tempDir();
    const patched = failFirstRename(Number.POSITIVE_INFINITY);
    try {
      await assert.rejects(
        store(dir).save(defaultRuntimeState({ now: () => new Date('2026-11-17T00:00:00.000Z') })),
        (err) => err.code === 'EPERM',
      );
      assert.equal(patched.calls(), 8);
      assert.equal(fs.existsSync(`${dir}/runtime.json`), false);
      assert.deepEqual(stagedFiles(dir), []);
    } finally {
      patched.restore();
    }
  });

  test('a non-transient error is not retried', async () => {
    const dir = tempDir();
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = () => { calls += 1; const err = new Error('EXDEV: cross-device link not permitted'); err.code = 'EXDEV'; throw err; };
    try {
      await assert.rejects(store(dir).save(defaultRuntimeState({ now: () => new Date('2026-11-17T00:00:00.000Z') })), (err) => err.code === 'EXDEV');
      assert.equal(calls, 1);
      assert.deepEqual(stagedFiles(dir), []);
    } finally {
      fs.renameSync = real;
    }
  });
});
