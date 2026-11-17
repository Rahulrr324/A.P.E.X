// T-14 scale bounds: the document index is bounded at 500 documents, and the bound must not turn
// routine re-ingestion into a failure. This is the regression for that defect: at the cap the whole
// ingest used to be refused, so a repeated scan, a changed document, or a deleted document could
// never be observed once the index was full. The index is seeded through its own append-only log for
// the 500-document count (the store's validator accepts every line); everything else - configuration,
// permission, scan, ingest, invalidation - goes through the public service.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const CAP = 500;
const SEEDED = 497;

const dirs = [];
const roots = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
  while (roots.length) {
    try { fs.rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t14-scale-'));
  roots.push(root);
  return root;
}

function write(root, name, text) {
  fs.writeFileSync(path.join(root, name), text, 'utf8');
}

// A current indexed record, valid for the store's own validator. Its path is outside the scanned
// root, so it never collides with a real file; it stands for an index that is already full.
function seededDocument(n) {
  const digest = createHash('sha256').update(`seeded-document-${n}`).digest('hex');
  return {
    schema: 1,
    id: randomUUID(),
    documentId: `doc:${digest.slice(0, 32)}`,
    version: 1,
    contentHash: digest,
    textHash: digest,
    bytes: 0,
    source: { provider: 'filesystem_content', root: 'seeded-1', path: `seeded/doc-${String(n).padStart(6, '0')}.md` },
    format: 'md',
    status: 'indexed',
    text: '',
    sections: [],
    limitations: [],
    warnings: [],
    observedAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('T-14 scale bounds: documents', () => {
  test('a full index still ingests: new documents are skipped, existing ones gain versions, and a deletion frees a slot', async () => {
    const dir = tempDir();
    const root = tempRoot();
    write(root, 'alpha.md', 'alpha v1');
    write(root, 'beta.md', 'beta v1');
    write(root, 'gamma.md', 'gamma v1');

    const first = createApp({ dataDir: dir });
    await first.documents.configure({ roots: [root], extensions: ['md'], maxFiles: 3 });
    await first.documents.enable();
    const initial = await first.documents.ingest();
    assert.equal(initial.indexed, 3, initial.warnings.join('; '));
    assert.equal(initial.totalIndexed, 3);

    const seeded = Array.from({ length: SEEDED }, (_, i) => seededDocument(i + 1));
    fs.appendFileSync(path.join(dir, 'documents.jsonl'), `${seeded.map((record) => JSON.stringify(record)).join('\n')}\n`);

    // A fourth file is present, so the capped scan is disclosed rather than mistaken for a complete
    // view; the index is at its 500-document cap.
    write(root, 'delta.md', 'delta v1');
    const second = createApp({ dataDir: dir });
    assert.equal((await second.documents.status()).documents, CAP);

    const atCap = await second.documents.ingest();
    assert.equal(atCap.status, 'ingested', 'a full index refused a routine re-ingest');
    assert.equal(atCap.totalIndexed, CAP, 'the index passed its own document cap');
    assert.equal(atCap.limited, 1, 'the new document was not counted as held back by the cap');
    assert.ok(atCap.warnings.some((warning) => /500-document limit/.test(warning)), 'the bound was not disclosed');
    assert.equal(atCap.deleted, 0, 'a capped scan was treated as proof that documents disappeared');

    // An existing document still gains a version while the index is full.
    write(root, 'alpha.md', 'alpha v2, with a longer body');
    const updated = await second.documents.ingest();
    assert.equal(updated.changed, 1, 'a changed document could not be observed at the cap');
    assert.equal(updated.limited, 1);
    const alpha = (await second.documents.list({ limit: 100 })).find((row) => row.path === 'alpha.md');
    assert.equal(alpha.version, 2, 'the earlier version was overwritten');
    const versions = await second.documents.versions(alpha.documentId);
    assert.equal(versions.length, 2, 'the earlier version was not preserved');

    const repeated = await second.documents.ingest();
    assert.equal(repeated.status, 'ingested');
    assert.equal(repeated.changed, 0);
    assert.equal(repeated.totalIndexed, CAP);

    // Removing a document frees its slot for the file that was previously held back.
    await second.documents.invalidate(seeded[0].documentId, { reason: 'free a slot for the next document' });
    const afterDelete = await second.documents.ingest();
    assert.equal(afterDelete.limited, 0);
    assert.equal(afterDelete.indexed, 1, 'the freed slot was not used');
    // `documents` counts every identity the log has ever held, including the invalidation; the cap
    // bounds the current ones, so it is measured as documents minus deleted.
    const afterStatus = await second.documents.status();
    assert.equal(afterStatus.documents - afterStatus.deleted, CAP);
    assert.equal(afterStatus.deleted, 1);
    assert.ok((await second.documents.list({ limit: 100 })).some((row) => row.path === 'delta.md'));
  });
});
