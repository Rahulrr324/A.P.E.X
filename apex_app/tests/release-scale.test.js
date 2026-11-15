// Scale and envelope behavior for the offline release: a multi-megabyte store set survives an
// export, an independent inspection, and a restore with exact digests, and the documented per-file
// and total export bounds refuse rather than truncate. No timings are asserted here; measured
// performance lives in benchmarks/run-release-benchmark.mjs.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { inspectArchive, restoreArchive, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../src/backup/archive.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

const digestOf = (value) => createHash('sha256').update(value).digest('hex');

function jsonl(record, count) {
  const lines = new Array(count);
  for (let i = 0; i < count; i += 1) lines[i] = JSON.stringify(record(i));
  return `${lines.join('\n')}\n`;
}

function failureMessage(res) {
  const step = res.operation.steps[0];
  return step.execution.error?.message ?? '';
}

describe('bounded large corpora', () => {
  test('a multi-megabyte store set exports, inspects, and restores with exact digests', async () => {
    const dataDir = tempDir();
    const elsewhere = tempDir();
    const restoredDir = tempDir();
    const corpus = {
      'knowledge.jsonl': jsonl((i) => ({
        schema: 'apex.knowledge/1', id: `knowledge-${i}`, subject: `subject ${i}`, relationship: 'is',
        object: `object ${i}`, recordedAt: '2026-11-15T00:00:00.000Z',
        provenance: { origin: 'user', operationId: `operation-${i}` },
      }), 12000),
      'notes.jsonl': jsonl((i) => ({
        schema: 'apex.note/1', id: `note-${i}`, revision: 1, title: `Note ${i}`,
        body: `The note body for record ${i}, long enough to be a realistic line of stored text.`,
        tags: ['bulk'], sensitivity: 'normal', recordedAt: '2026-11-15T00:00:00.000Z',
        provenance: { origin: 'user', operationId: `operation-note-${i}` },
      }), 4000),
      'operations.jsonl': jsonl((i) => ({
        schema: 'apex.operation/1', id: `operation-${i}`, origin: 'user', capability: 'knowledge.add',
        status: 'success_verified', requestedAt: '2026-11-15T00:00:00.000Z',
      }), 2000),
    };
    let totalBytes = 0;
    for (const [name, text] of Object.entries(corpus)) {
      fs.writeFileSync(path.join(dataDir, name), text);
      totalBytes += Buffer.byteLength(text, 'utf8');
    }
    assert.ok(totalBytes > 2 * 1024 * 1024, `the fixture must be multi-megabyte, not ${totalBytes}`);

    const app = createApp({ dataDir, now: () => NOW });
    const destination = path.join(elsewhere, 'large.json');
    const exported = await app.controller.backupExport({ path: destination });
    assert.equal(exported.status, Outcome.SUCCESS_VERIFIED, exported.display);
    const data = exported.operation.steps[0].result.data;
    assert.equal(data.files.length, 3);
    for (const file of data.files) {
      const text = corpus[file.name];
      assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'), `${file.name} byte length`);
      assert.equal(file.sha256, digestOf(text), `${file.name} digest`);
      assert.equal(file.lines, text.trim().split('\n').length, `${file.name} line count`);
      assert.equal(file.unparsed, 0);
    }

    // An independent read of the archive recomputes the same manifest digest and lengths.
    const inspected = await inspectArchive({ source: destination });
    assert.equal(inspected.ok, true, inspected.problems.join('; '));
    assert.equal(inspected.archiveSha256, data.archiveSha256);
    assert.equal(inspected.totalBytes, totalBytes);
    for (const file of inspected.files) assert.equal(file.sha256, digestOf(corpus[file.name]));

    // Restore into an empty data directory and compare bytes, not reports.
    const restored = await restoreArchive({
      dataDir: restoredDir, source: destination, confirm: data.archiveSha256.slice(0, 12), now: () => NOW, appVersion: 'test',
    });
    assert.deepEqual([...restored.created].sort(), Object.keys(corpus).sort());
    assert.deepEqual(restored.replaced, []);
    assert.equal(restored.safetyPath, null);
    for (const [name, text] of Object.entries(corpus)) {
      const written = fs.readFileSync(path.join(restoredDir, name), 'utf8');
      assert.equal(written, text, `${name} restored byte for byte`);
    }
  });
});

describe('export envelopes', () => {
  test('a file above the per-file bound refuses the export and writes no archive', async () => {
    const dataDir = tempDir();
    const elsewhere = tempDir();
    fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    const destination = path.join(elsewhere, 'too-big.json');
    const app = createApp({ dataDir, now: () => NOW });

    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(failureMessage(res), /per-file export bound/);
    assert.equal(fs.existsSync(destination), false, 'nothing was written');
  });

  test('stores whose total is above the total bound refuse the export and write no archive', async () => {
    const dataDir = tempDir();
    const elsewhere = tempDir();
    const first = 24 * 1024 * 1024;
    const second = MAX_TOTAL_BYTES - first + 1;
    assert.ok(second <= MAX_FILE_BYTES, 'each fixture file is inside the per-file bound');
    fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), Buffer.alloc(first, 0x20));
    fs.writeFileSync(path.join(dataDir, 'knowledge.jsonl'), Buffer.alloc(second, 0x20));
    const destination = path.join(elsewhere, 'too-much.json');
    const app = createApp({ dataDir, now: () => NOW });

    const res = await app.controller.backupExport({ path: destination });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(failureMessage(res), /above the \d+-byte export bound|total .* export bound/);
    assert.equal(fs.existsSync(destination), false, 'nothing was written');
  });
});
