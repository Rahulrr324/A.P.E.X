// Implementation 106: the memory/knowledge retrieval contract. Retrieval must be
// exact where an identifier or claim is exact, must preserve ambiguity instead of
// guessing, must keep conflicting claims and their provenance, must reject malformed
// inputs without writing, must stay bounded at practical synthetic sizes, and a
// deterministic action must not fail because an unrelated retrieval store is damaged.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { createApp } from '../src/app.js';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
import { KnowledgeStore, sha256Hex as knowledgeSha256 } from '../src/knowledge/knowledge-store.js';
import { Outcome } from '../src/outcomes.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const AT = (n) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();

function memoryRecord(content, at) {
  return {
    schema: 1,
    id: randomUUID(),
    kind: 'user_fact',
    source: 'user',
    sensitivity: 'normal',
    content,
    contentSha256: sha256Hex(content),
    createdAt: AT(at),
    provenance: { origin: 'user_request', updateMode: 'user_confirmed' },
  };
}

function knowledgeRecord(subject, relationship, object, evidence, at, provenance = { origin: 'user_supplied', updateMode: 'user_confirmed' }) {
  return {
    schema: 1,
    id: randomUUID(),
    subject,
    relationship,
    object,
    evidence,
    tripleHash: knowledgeSha256(`${subject}\x00${relationship}\x00${object}`),
    status: 'supported',
    createdAt: AT(at),
    provenance,
  };
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function writeKnowledge(dir, records) {
  const file = path.join(dir, 'knowledge.jsonl');
  writeJsonl(file, records);
  return new KnowledgeStore(file);
}

describe('106: retrieval is exact, bounded, and preserves what it cannot resolve', () => {
  test('exact claims survive broad stores, and unrelated records do not displace them', async () => {
    const dir = tempDir();
    const memory = [];
    const knowledge = [];
    for (let i = 1; i <= 2000; i += 1) {
      memory.push(memoryRecord(`the keeper checks supply item ${i}`, i));
      knowledge.push(knowledgeRecord(`module ${i}`, 'owned by', `team ${i}`, `the release checklist covers module ${i}`, i));
    }
    const exactMemory = memoryRecord('the project codename is Lighthouse', 2001);
    memory.push(exactMemory);
    memory.push(memoryRecord('the project codename is Bluebird', 2002));
    const exactKnowledge = knowledgeRecord('the project codename', 'is', 'Lighthouse', 'planning notes', 2001);
    knowledge.push(exactKnowledge);
    knowledge.push(knowledgeRecord('the project codename', 'is', 'Bluebird', 'later planning notes', 2002));

    const dir2 = dir;
    writeJsonl(path.join(dir2, 'memory.jsonl'), memory);
    writeKnowledge(dir2, knowledge);
    const app = createApp({ dataDir: dir2 });

    const memoryStarted = performance.now();
    const memoryHits = await app.memory.search('project codename lighthouse', { limit: 10 });
    const memoryElapsed = performance.now() - memoryStarted;
    assert.ok(memoryHits.length > 0 && memoryHits.length <= 10, 'memory results are bounded');
    assert.equal(memoryHits[0].record.id, exactMemory.id, 'the exact user fact is the best match');
    assert.ok(memoryHits.every((h) => h.record.content !== 'the keeper checks supply item 1999'), 'unrelated noise is not pulled in');
    assert.ok(memoryElapsed < 5000, `memory search over 2,000 records took ${Math.round(memoryElapsed)} ms`);

    const knowledgeStarted = performance.now();
    const knowledgeHits = await app.knowledge.search('project codename lighthouse', { limit: 5 });
    const knowledgeElapsed = performance.now() - knowledgeStarted;
    assert.ok(knowledgeHits.length > 0 && knowledgeHits.length <= 5, 'knowledge results are bounded');
    assert.equal(knowledgeHits[0].record.id, exactKnowledge.id);
    assert.ok(knowledgeElapsed < 5000, `knowledge search over 2,000 records took ${Math.round(knowledgeElapsed)} ms`);

    assert.equal((await app.memory.status()).records, 2002, 'the store was read, not rewritten');
  });

  test('ambiguous identifiers are refused rather than resolved to one record', async () => {
    const dir = tempDir();
    const records = [];
    for (let i = 1; i <= 40; i += 1) {
      records.push(knowledgeRecord(`subject ${i}`, 'relates to', `object ${i}`, null, i));
    }
    writeKnowledge(dir, records);
    const app = createApp({ dataDir: dir });

    // A one-character prefix matches several random ids; pick one that does.
    const buckets = new Map();
    for (const r of records) {
      const first = r.id[0];
      buckets.set(first, [...(buckets.get(first) ?? []), r.id]);
    }
    const [prefix, ids] = [...buckets.entries()].find(([, v]) => v.length >= 2);
    assert.ok(prefix, 'the fixture must contain an ambiguous prefix');

    const ambiguous = await app.controller.knowledgeShow(prefix);
    assert.equal(ambiguous.status, Outcome.INPUT_REJECTED);
    assert.match(ambiguous.display, new RegExp(`matches ${ids.length} knowledge records`));
    assert.match(ambiguous.display, /use a longer prefix/);

    const exact = await app.controller.knowledgeShow(ids[0]);
    assert.equal(exact.status, Outcome.SUCCESS_VERIFIED);
    assert.match(exact.display, new RegExp(`Knowledge Record ${ids[0]}`));
  });

  test('conflicting claims keep both records, their ids, and their provenance', async () => {
    const dir = tempDir();
    const zephyr = knowledgeRecord('the launch code name', 'is', 'Zephyr', 'planning notes', 1);
    const falcon = knowledgeRecord('the launch code name', 'is', 'Falcon', 'later planning notes', 2, {
      origin: 'user_approved',
      updateMode: 'user_confirmed',
    });
    writeKnowledge(dir, [zephyr, falcon]);
    const app = createApp({ dataDir: dir });

    const hits = await app.knowledge.search('launch code name', { limit: 10 });
    assert.deepEqual(hits.map((h) => h.record.id).sort(), [zephyr.id, falcon.id].sort());
    const byId = new Map(hits.map((h) => [h.record.id, h.record]));
    assert.deepEqual(byId.get(zephyr.id).conflictsWith, [falcon.id]);
    assert.deepEqual(byId.get(falcon.id).conflictsWith, [zephyr.id]);
    assert.equal(byId.get(zephyr.id).status, 'conflicting');
    assert.equal(byId.get(falcon.id).status, 'conflicting');
    assert.deepEqual(byId.get(zephyr.id).provenance, { origin: 'user_supplied', updateMode: 'user_confirmed' });
    assert.deepEqual(byId.get(falcon.id).provenance, { origin: 'user_approved', updateMode: 'user_confirmed' });

    const shown = await app.controller.knowledgeShow(zephyr.id);
    assert.equal(shown.status, Outcome.SUCCESS_VERIFIED);
    assert.match(shown.display, new RegExp(`CONFLICTS WITH: ${falcon.id.slice(0, 8)}`));
    assert.match(shown.display, /Provenance:\s+user_supplied \(user_confirmed\)/);
    assert.equal(fs.readFileSync(path.join(dir, 'knowledge.jsonl'), 'utf8').includes('Falcon'), true, 'neither claim was deleted');
  });

  test('malformed retrieval inputs are refused without writing, and unrelated store damage does not block a deterministic action', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir });

    const tooLong = await app.controller.knowledgeAdd({
      subject: 's'.repeat(501), relationship: 'relates to', object: 'x',
    });
    assert.equal(tooLong.status, Outcome.INPUT_REJECTED);
    assert.match(tooLong.display, /subject exceeds 500 characters/);

    const secret = await app.controller.knowledgeAdd({
      subject: 'token', relationship: 'is', object: `sk-${'A'.repeat(24)}`,
    });
    assert.equal(secret.status, Outcome.INPUT_REJECTED);
    assert.match(secret.display, /looks like a password, key, or token/);
    assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl')), false, 'a refused write created no knowledge store');

    // Damage memory, then run a deterministic calculation in a fresh process. The
    // calculation reads no memory, so an unrelated retrieval failure must not fail it.
    fs.writeFileSync(path.join(dir, 'memory.jsonl'), '{ not json\n');
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const calc = await runCli(['ask', 'calc', '(2+3)*4'], env);
    assert.equal(calc.code, 0, calc.stdout + calc.stderr);
    assert.match(calc.stdout, /\(2\+3\)\*4 = 20/);
    assert.match(calc.stdout, /verification success_verified/);
    assert.doesNotMatch(calc.stdout, /retrieval failed/i);
    assert.equal(fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8'), '{ not json\n', 'the damaged store was not rewritten');
  });
});
