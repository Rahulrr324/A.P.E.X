// TEST FIXTURE for the task lock's bounded publication attempts (Batch AF, AF-16).
//
//   node task-lock-exhaust-child.mjs <data dir>
//
// A live claim is placed first, so every attempt to publish this process's own claim fails with
// EEXIST. Then the store's read of the lock path is made to report ENOENT every time: the holder
// appears to release in the gap between the failed publication and the read, again and again. A
// waiter must stop after its bounded attempts and say that it could not acquire the lock. It must
// not spin forever, and it must not delete the claim it was never able to read.
//
// The patch is confined to this child process and touches only `readFile` for the lock path;
// everything else is the real TaskStore and the real filesystem.
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from '../../src/tasks/store.js';

const dataDir = process.argv[2];
const lockPath = path.join(dataDir, 'tasks.jsonl.lock');

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: 'exhaust-fixture', at: new Date().toISOString() }));

const realReadFile = fs.readFile.bind(fs);
let reads = 0;
fs.readFile = async (file, ...rest) => {
  if (file === lockPath) {
    reads += 1;
    const err = new Error(`ENOENT: no such file or directory, open '${lockPath}'`);
    err.code = 'ENOENT';
    err.path = lockPath;
    throw err;
  }
  return realReadFile(file, ...rest);
};

const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
let ran = false;
try {
  await store.withLock(async () => { ran = true; return 'acquired'; });
  console.log(`RESULT acquired ran=${ran}`);
} catch (err) {
  console.log(`RESULT code=${err.code || 'UNSET'} ran=${ran} reads=${reads} message=${err.message}`);
  process.exitCode = 1;
}
