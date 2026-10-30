// TEST FIXTURE for Batch H / 090: a real process that exits inside the takeover
// election, after publishing its token and before it can remove the dead claim. The
// next process must find that exact durable state: the stale lock plus one abandoned
// token whose holder is gone.
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from '../../src/tasks/store.js';

const dataDir = process.argv[2];
const realLink = fs.link;
fs.link = async (src, dest) => {
  await realLink(src, dest);
  if (String(dest).includes('.takeover.')) process.exit(9);
};

const store = new TaskStore(path.join(dataDir, 'tasks.jsonl'));
try {
  await store.withLock(async () => 'acquired');
  console.log('ACQUIRED');
  process.exit(0);
} catch (err) {
  console.log(`ERROR ${err.message}`);
  process.exit(1);
}
