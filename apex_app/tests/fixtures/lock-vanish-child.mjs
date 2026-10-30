// TEST FIXTURE for the task-lock release race.
//
//   node lock-vanish-child.mjs <data dir>
//
// It places a live lock first, so the store's link fails with EEXIST. It then makes the
// holder release exactly between that failed link and the store's read of the lock: the
// first read of the lock path removes the file and lets the read observe ENOENT. A waiter
// must treat that as "the lock is free" and retry, never as an unknown holder.
//
// The patch is confined to this child process and touches only `readFile`; everything else
// is the real TaskStore and the real filesystem.
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from '../../src/tasks/store.js';

const dataDir = process.argv[2];
const lockPath = path.join(dataDir, 'tasks.jsonl.lock');

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

const realReadFile = fs.readFile.bind(fs);
let released = false;
fs.readFile = async (file, ...rest) => {
  if (!released && file === lockPath) {
    released = true;
    await fs.rm(lockPath, { force: true });
  }
  return realReadFile(file, ...rest);
};

const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
try {
  const value = await store.withLock(async () => 'acquired');
  console.log(`RESULT ${value}`);
} catch (err) {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
}
