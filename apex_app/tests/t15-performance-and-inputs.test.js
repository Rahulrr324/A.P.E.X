// T-15 regressions. Two performance fixes on the situational read path and one input-normalisation
// defect found while measuring document ingestion. Each test states the guarantee, not a timing, so
// a slow machine changes nothing about whether it passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from '../src/errors.js';
import { SituationStore } from '../src/situational/store.js';
import { fingerprintOf, reduceSituation } from '../src/situational/model.js';
import { SITUATION_PARSE_CACHE_BYTES } from '../src/situational/vocabulary.js';
import { DocumentService } from '../src/documents/service.js';
import { runDocumentCommand } from '../src/documents/cli.js';
import { makeTempDataDir, cleanup } from './helpers.js';

function eventRecord(index = 0) {
  const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString();
  const payload = { summary: `observation ${index}` };
  return {
    schema: 'apex.situation/1', kind: 'event_observed', id: `event-${String(index).padStart(4, '0')}`,
    source: 'external_provider', sourceEventId: `source:${index}`, type: 'test_observation', category: 'external',
    observedAt: at, ingestedAt: at, payload, confidence: 0.5,
    provenance: { origin: 'user', reporter: 'test', operationId: null, provider: null },
    entityRefs: [], goalRefs: [], planRefs: [], taskRefs: [], validUntil: null,
    integrity: { algorithm: 'sha256', digest: fingerprintOf(payload), validated: true },
    fingerprint: fingerprintOf(payload), worldRefs: {}, at, origin: 'user',
  };
}

function assessmentFor(event, id = `${event.id}-assessment`) {
  return {
    schema: 'apex.situation/1', kind: 'event_assessed', id, assessmentId: id, eventId: event.id,
    at: event.at, origin: 'user',
    significance: { level: 'low' }, relevance: { level: 'low' }, authorization: { level: 'none' },
    recommended: 'record', candidates: [{ response: 'record' }], consequences: [], uncertainty: [],
    affectedObjectives: [], rationale: 'recorded for the test',
  };
}

test('the situational log keeps a bounded parse snapshot and still reads the file', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'situational.jsonl');
  const store = new SituationStore(file);
  assert.equal(store.log.parseCacheStats.enabled, true);
  assert.equal(store.log.parseCacheStats.maxBytes, SITUATION_PARSE_CACHE_BYTES);

  const event = eventRecord(0);
  await store.observe(event);
  await store.recordAssessment({ eventId: event.id, assessmentId: `${event.id}-a`, spec: assessmentFor(event) });

  // The first read after this instance's own appends parses; the next unchanged read hashes and
  // installs the snapshot; the read after that is served from it.
  await store.events({ limit: 5 });
  await store.events({ limit: 5 });
  const rows = await store.events({ limit: 5 });
  assert.equal(rows.rows.length, 1);
  assert.ok(store.log.parseCacheStats.hits >= 1, 'an unchanged repeated read is served from the snapshot');

  // A second instance's append changes the bytes, so the first instance must not answer from its
  // snapshot. It re-reads and re-validates instead.
  const other = new SituationStore(file);
  const second = eventRecord(1);
  await other.observe(second);
  const state = await store.load();
  assert.equal(state.state.events.size, 2, 'another writer is visible on the next read');
});

test('a corrupt situational line is still refused with the parse snapshot enabled', async (t) => {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'situational.jsonl');
  const store = new SituationStore(file);
  await store.observe(eventRecord(0));
  await store.events({ limit: 5 });
  fs.appendFileSync(file, '{not json}\n');
  await assert.rejects(() => store.load(), (err) => err instanceof StoreError && /corrupt line/.test(err.message));
  const inspected = await store.inspect();
  assert.equal(inspected.corrupt.length, 1);
  assert.equal(inspected.complete, false);
});

test('the validated reducer still detects every structural rule', () => {
  const event = eventRecord(0);
  const assessment = assessmentFor(event);
  const decision = {
    schema: 'apex.situation/1', kind: 'response_decided', id: 'decision-0001', decisionId: 'decision-0001',
    eventId: event.id, assessmentId: 'a-different-assessment', at: event.at, origin: 'user',
    response: 'record', action: null, inputDigest: null, reason: 'test', notification: {},
  };
  const problems = reduceSituation([event, assessment, decision], { validated: true }).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /latest assessment/);
});

test('document extensions are accepted with or without a leading dot', async (t) => {
  const dir = makeTempDataDir();
  const root = makeTempDataDir();
  t.after(() => { cleanup(dir); cleanup(root); });
  fs.writeFileSync(path.join(root, 'note.md'), '# Note\n\nThe codename is Lighthouse.\n');
  const service = new DocumentService({ dataDir: dir });
  const configured = await service.configure({ roots: [root], extensions: ['.md', 'MARKDOWN'] });
  assert.deepEqual(configured.config.extensions, ['md', 'markdown']);
  await service.enable();
  const report = await service.ingest();
  assert.equal(report.indexed, 1);
  assert.equal(report.failed, 0);
});

test('document ingest reports a limited index and its notes to the operator', async () => {
  const lines = [];
  const app = {
    documents: {
      ingest: async () => ({
        status: 'ingested', indexed: 2, changed: 0, duplicates: 0, failed: 0, deleted: 0, observed: 3,
        durationMs: 5, truncated: false, limited: 1, documents: [], warnings: ['the document index is at its 500-document limit'],
      }),
    },
  };
  const code = await runDocumentCommand({
    app, args: ['ingest'], out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`),
    parseFlags: (rest) => ({ flags: {}, rest }), rejectUnexpected: () => {},
  });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /1 current file\(s\) were not indexed/);
  assert.match(text, /note: the document index is at its 500-document limit/);
});
