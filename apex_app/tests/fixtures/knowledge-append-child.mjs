// TEST FIXTURE for Batch AP-11: a real second OS process that appends one knowledge claim and exits.
// Spawned by tests/knowledge-lifecycle-reuse.test.js and nothing else. It opens the store directly,
// so the parent can prove that a write made outside its own instance is not served from the
// derivation it built earlier. No model is created and no network is used.
import path from 'node:path';
import { KnowledgeStore } from '../../src/knowledge/knowledge-store.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  process.stderr.write('usage: knowledge-append-child.mjs <dataDir>\n');
  process.exit(2);
}

const store = new KnowledgeStore(path.join(dataDir, 'knowledge.jsonl'));
const { record } = await store.add({
  subject: 'compass',
  relationship: 'heading',
  object: 'north',
  origin: 'user',
});

process.stdout.write(`APPENDED ${record.id}\n`);
