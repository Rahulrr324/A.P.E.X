// Batch AP-11 Priority 3: hash-keyed reuse of the derived knowledge lifecycle indexes.
//
// The request path reads the same knowledge snapshot several times, and each read used to rebuild the
// supersession, conflict and resolution indexes and the store-wide health summary from scratch. The
// reuse is keyed by the SHA-256 of the exact bytes the read certified, so it may only answer a read of
// the same content. These tests drive real persisted JSONL through the real store and, where the
// request path is involved, the real controller. No inference, no network, no model.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore } from '../src/knowledge/knowledge-store.js';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'apex-ap11-lifecycle-'));
  dirs.push(dir);
  return dir;
}
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const newStore = (dir, name = 'knowledge.jsonl') => new KnowledgeStore(path.join(dir, name));
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'knowledge-append-child.mjs');

// A real second OS process: it opens the same store, appends one claim and exits. Nothing is shared
// with the parent except the file, so the parent's only way to see the write is to notice that the
// bytes it certified have changed.
function runChild(dataDir) {
  const child = spawn(process.execPath, [CHILD, dataDir], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the child process did not finish within 60000 ms. stdout: ${out} stderr: ${err}`));
    }, 60000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the child process exited ${code}. stderr: ${err}`));
      else resolve(out);
    });
  });
}
const claim = (subject, relationship, object) => ({ subject, relationship, object, origin: 'user' });
const NOW = () => new Date('2026-06-01T00:00:00.000Z');

function fixtureGateway(text) {
  return new ModelGateway({
    backend: {
      name: 'ap11-fixture',
      provider: 'fixture',
      configured: true,
      describe: () => ({ configured: true, provider: 'fixture', endpoint: 'in-process fixture', model: 'fixture' }),
      health: async () => ({ available: true, detail: 'in-process fixture' }),
      complete: async () => ({
        ok: true, backend: 'ap11-fixture', provider: 'fixture', model: 'fixture',
        text: typeof text === 'function' ? text() : text,
        finishReason: 'stop', truncated: false, latencyMs: 0,
      }),
    },
  });
}

// Six claims exercising every lifecycle rule at once: a resolvable two-claim conflict, a supersession
// link, a retraction, and a standalone claim. Reuse must reproduce all of it exactly.
async function seedLifecycle(store) {
  const alpha = (await store.add(claim('lighthouse', 'status', 'green'))).record;
  const beta = (await store.add(claim('lighthouse', 'status', 'amber'))).record;
  const gamma = (await store.add(claim('generator', 'fuel', 'diesel'))).record;
  const old = (await store.add(claim('boiler', 'pressure', 'low'))).record;
  const replacement = (await store.add({ ...claim('boiler', 'pressure', 'normal'), supersedes: [old.id] })).record;
  const extra = (await store.add(claim('pump', 'state', 'running'))).record;
  await store.retract({ target: gamma.id, reason: 'the delivery was cancelled', origin: 'user' });
  await store.resolve({ target: alpha.id, choose: beta.id, reason: 'the inspection record', origin: 'user' });
  return { alpha, beta, gamma, old, replacement, extra };
}

const projectionOf = (store) => store.projectionRead({ limit: 50 });

describe('AP-11 lifecycle-index reuse is equivalent to rebuilding', () => {
  test('a reused derivation equals a fresh instance deriving the same file', async () => {
    const dir = tempDir();
    const warm = newStore(dir);
    const ids = await seedLifecycle(warm);
    await warm.list({ limit: 50 });
    await warm.search('lighthouse status', { limit: 10 });
    await projectionOf(warm);
    const cold = newStore(dir);
    // A fresh instance derives once, from nothing, before it can reuse anything.
    await cold.list({ limit: 50 });
    assert.equal(cold.lifecycleIndexStats.builds, 1);
    assert.equal(cold.lifecycleIndexStats.hits, 0, 'the fresh instance reused nothing to derive it');

    const readers = [
      ['list', (s) => s.list({ limit: 50 })],
      ['search', (s) => s.search('lighthouse status', { limit: 10 })],
      ['findByPrefix', (s) => s.findByPrefix('lighthouse')],
      ['byOperation', (s) => s.byOperation(ids.alpha.provenance?.operationId ?? 'none')],
      ['projectionRead', projectionOf],
      ['health', (s) => s.health()],
      ['history', (s) => s.history(ids.alpha.id)],
      ['getMany', (s) => s.getMany([ids.alpha.id, ids.old.id])],
    ];
    for (const [name, read] of readers) {
      assert.deepEqual(await read(warm), await read(cold), `${name}: reused equals freshly derived`);
    }
    assert.ok(warm.lifecycleIndexStats.hits > 0, 'the warm instance reused a derivation');
    assert.ok(cold.lifecycleIndexStats.hits > 0, 'the fresh instance reuses its own derivation too');
  });

  test('repeated reads of one unchanged snapshot construct the indexes once', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    await seedLifecycle(store);
    // The read immediately after this instance's own append is not certified: the write path skips
    // hashing, so that read derives without retaining. Prime past it, then measure the steady state.
    await store.list({ limit: 20 });
    await store.list({ limit: 20 });
    const base = store.lifecycleIndexStats.builds;
    const hitsBefore = store.lifecycleIndexStats.hits;
    for (let i = 0; i < 5; i += 1) {
      await store.list({ limit: 20 });
      await store.search('lighthouse status', { limit: 5 });
      await store.projectionRead({ limit: 20 });
      await store.health();
    }
    const stats = store.lifecycleIndexStats;
    assert.equal(stats.builds, base, 'twenty unchanged reads constructed no further index');
    assert.equal(stats.healthBuilds, 1, 'one store-wide health summary for the same snapshot');
    assert.equal(stats.hits - hitsBefore, 20, 'every one of the twenty reads was answered from it');
    assert.equal(stats.authorizes, false, 'the reuse grants no authority');
  });

  test('an append misses and the new claim is visible to every reader', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    await seedLifecycle(store);
    await store.list({ limit: 50 });
    const before = store.lifecycleIndexStats.builds;
    const added = (await store.add(claim('lighthouse', 'status', 'blue'))).record;
    const window = await store.list({ limit: 50 });
    assert.equal(window.length, 7);
    assert.ok(window.some((r) => r.id === added.id), 'the appended claim is in the window');
    const hits = await store.search('lighthouse status', { limit: 20 });
    assert.ok(hits.some((h) => h.record.id === added.id), 'the appended claim is retrievable');
    const { health } = await store.projectionRead({ limit: 50 });
    assert.equal(health.claims, 7, 'the health summary counts the new snapshot');
    // The group grew, so the recorded decision no longer governs it. That must be visible, not cached.
    assert.equal(window.find((r) => r.id === added.id).conflictState, 'unresolved');
    assert.ok(store.lifecycleIndexStats.builds > before, 'the append invalidated the derivation');
  });

  test('a retraction misses and retires the claim in every reader', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const ids = await seedLifecycle(store);
    const before = await store.search('lighthouse status', { limit: 20 });
    assert.deepEqual(before.map((h) => h.record.id).sort(), [ids.alpha.id, ids.beta.id].sort());
    const builds = store.lifecycleIndexStats.builds;
    await store.retract({ target: ids.beta.id, reason: 'the reading was mistaken', origin: 'user' });
    const after = await store.search('lighthouse status', { limit: 20 });
    assert.deepEqual(after.map((h) => h.record.id), [ids.alpha.id], 'a retracted claim is not retrievable');
    const window = await store.list({ limit: 50 });
    const beta = window.find((r) => r.id === ids.beta.id);
    assert.equal(beta.lifecycleState, 'retracted');
    assert.equal(beta.active, false);
    const alpha = window.find((r) => r.id === ids.alpha.id);
    assert.deepEqual(alpha.conflictsWith, [], 'the retired partner left the conflict group');
    assert.equal(alpha.conflictState, null, 'the group no longer conflicts, and the cache did not hide it');
    assert.ok(store.lifecycleIndexStats.builds > builds, 'the retraction invalidated the derivation');
  });

  test('a resolution misses and changes the conflict state it governs', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const a = (await store.add(claim('pump', 'state', 'running'))).record;
    const b = (await store.add(claim('pump', 'state', 'stopped'))).record;
    const before = await store.list({ limit: 10 });
    assert.equal(before.find((r) => r.id === a.id).conflictState, 'unresolved');
    const builds = store.lifecycleIndexStats.builds;
    await store.resolve({ target: a.id, choose: b.id, reason: 'the operator log', origin: 'user' });
    const after = await store.list({ limit: 10 });
    const resolved = after.find((r) => r.id === a.id);
    assert.equal(resolved.conflictState, 'resolved');
    assert.equal(resolved.resolution.chosen, false);
    assert.equal(after.find((r) => r.id === b.id).resolution.chosen, true);
    assert.deepEqual(resolved.conflictsWith, [b.id], 'the conflict itself is kept, not erased');
    const { health } = await store.projectionRead({ limit: 10 });
    assert.equal(health.conflicts.resolvedGroups, 1);
    assert.ok(store.lifecycleIndexStats.builds > builds, 'the resolution invalidated the derivation');
  });

  test('a supersession misses and retires exactly the named predecessor', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const first = (await store.add(claim('valve', 'position', 'open'))).record;
    await store.list({ limit: 10 });
    const builds = store.lifecycleIndexStats.builds;
    const second = (await store.add({ ...claim('valve', 'position', 'closed'), supersedes: [first.id] })).record;
    const window = await store.list({ limit: 10 });
    assert.equal(window.find((r) => r.id === first.id).lifecycleState, 'superseded');
    assert.equal(window.find((r) => r.id === second.id).lifecycleState, 'supported');
    assert.deepEqual(window.find((r) => r.id === first.id).supersededBy, [second.id]);
    const hits = await store.search('valve position', { limit: 10 });
    assert.deepEqual(hits.map((h) => h.record.id), [second.id], 'only the live successor is retrievable');
    assert.ok(store.lifecycleIndexStats.builds > builds, 'the supersession invalidated the derivation');
  });

  test('a same-length content replacement misses: the key is content, not size or count', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const record = (await store.add({ ...claim('lighthouse', 'status', 'green'), evidence: 'note one' })).record;
    const first = await store.list({ limit: 10 });
    assert.equal(first[0].evidence, 'note one');
    const builds = store.lifecycleIndexStats.builds;
    const text = fs.readFileSync(store.filePath, 'utf8');
    // Same byte length, same record count, same id, same triple hash: only the content differs.
    const replaced = text.replace('"evidence":"note one"', '"evidence":"note two"');
    assert.equal(replaced.length, text.length, 'the replacement is the same size');
    assert.notEqual(replaced, text);
    fs.writeFileSync(store.filePath, replaced);
    const second = await store.list({ limit: 10 });
    assert.equal(second[0].evidence, 'note two', 'the read describes the replaced content');
    assert.equal(second[0].id, record.id);
    assert.ok(store.lifecycleIndexStats.builds > builds, 'a same-size rewrite invalidated the derivation');
    const { health } = await store.projectionRead({ limit: 10 });
    assert.equal(health.claims, 1);
  });

  test('a writer appending during a read cannot leave a mixed or stale result', async () => {
    const dir = tempDir();
    const reader = newStore(dir);
    const writer = newStore(dir);
    const seed = (await writer.add(claim('lighthouse', 'status', 'green'))).record;
    await reader.list({ limit: 10 });
    // The read is in flight while another instance appends to the same file.
    const inFlight = reader.list({ limit: 50 });
    const added = (await writer.add(claim('lighthouse', 'status', 'amber'))).record;
    const during = await inFlight;
    const ids = during.map((r) => r.id);
    assert.ok(ids.includes(seed.id));
    assert.ok(ids.length === 1 || ids.length === 2, 'the read saw one whole snapshot, not a mixture');
    if (ids.length === 2) assert.ok(ids.includes(added.id));
    const after = await reader.list({ limit: 50 });
    assert.deepEqual(after.map((r) => r.id).sort(), [seed.id, added.id].sort(), 'the next read sees the write');
    assert.deepEqual(after.find((r) => r.id === added.id).conflictsWith, [seed.id]);
  });

  test('each read describes its own snapshot as the store moves', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const a = (await store.add(claim('lighthouse', 'status', 'green'))).record;
    const first = await store.list({ limit: 10 });
    assert.deepEqual(first[0].conflictsWith, []);
    const b = (await store.add(claim('lighthouse', 'status', 'amber'))).record;
    const second = await store.list({ limit: 10 });
    assert.deepEqual(second.find((r) => r.id === a.id).conflictsWith, [b.id]);
    await store.retract({ target: b.id, reason: 'withdrawn', origin: 'user' });
    const third = await store.list({ limit: 10 });
    assert.deepEqual(third.find((r) => r.id === a.id).conflictsWith, [], 'the retired partner is gone');
    assert.equal(third.find((r) => r.id === b.id).lifecycleState, 'retracted');
    assert.equal(store.lifecycleIndexStats.builds, 3, 'three snapshots, three constructions');
  });

  test('an interrupted write fails closed and retains nothing', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    await seedLifecycle(store);
    await store.list({ limit: 50 });
    await store.list({ limit: 50 });
    assert.equal(store.lifecycleIndexStats.cached, true);
    // A torn append: the last line was never finished, so the store is damaged.
    fs.appendFileSync(store.filePath, '{"id":"partial","kind":');
    await assert.rejects(() => store.list({ limit: 50 }), /corrupt line/);
    const projection = await store.projectionRead({ limit: 50 });
    assert.equal(projection.health.state, 'damaged');
    assert.equal(projection.claims, null, 'a damaged store supplies no projection');
    assert.equal(store.lifecycleIndexStats.cached, false, 'the damaged read retained no derivation');
    const health = await store.health();
    assert.equal(health.complete, false);
    assert.ok(health.corruptLines >= 1);
  });

  test('a damaged store is never answered from the entry built before the damage', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const ids = await seedLifecycle(store);
    const clean = await projectionOf(store);
    assert.equal(clean.health.state, 'ok');
    assert.equal(clean.claims.length, 6);
    const text = fs.readFileSync(store.filePath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    lines.splice(2, 0, 'this is not a record');
    fs.writeFileSync(store.filePath, `${lines.join('\n')}\n`);
    const damaged = await projectionOf(store);
    assert.equal(damaged.health.state, 'damaged');
    assert.equal(damaged.claims, null);
    assert.notDeepEqual(damaged.health, clean.health, 'the cached clean summary was not served');
    await assert.rejects(() => store.search('lighthouse status', { limit: 5 }), /corrupt line/);
    assert.equal(store.lifecycleIndexStats.cached, false);
    // Repairing the file must rebuild from the repaired content, not resume the old entry.
    fs.writeFileSync(store.filePath, text);
    const repaired = await projectionOf(store);
    assert.equal(repaired.health.state, 'ok');
    assert.equal(repaired.claims.length, 6);
    assert.ok(repaired.claims.some((r) => r.id === ids.alpha.id));
  });

  test('conflict partners outside the returned window stay discoverable', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const ids = [];
    for (let i = 0; i < 30; i += 1) {
      ids.push((await store.add(claim('lighthouse', 'status', `reading ${i}`))).record.id);
    }
    await store.list({ limit: 5 });
    const window = await store.list({ limit: 5 });
    assert.equal(window.length, 5, 'the window is bounded');
    const shown = new Set(window.map((r) => r.id));
    assert.equal(shown.size, 5);
    for (const record of window) {
      assert.equal(record.conflictsWith.length, 29, 'every partner is named, not only the returned ones');
      const outside = record.conflictsWith.filter((id) => !shown.has(id));
      assert.equal(outside.length, 25, 'the partners outside the window are still discoverable');
      assert.ok(outside.every((id) => ids.includes(id)));
    }
    const { health } = await store.projectionRead({ limit: 5 });
    assert.equal(health.conflicts.groups, 1);
    assert.equal(health.conflicts.claims, 30, 'the store-wide summary is not bounded by the window');
    const hits = await store.search('lighthouse status', { limit: 5 });
    assert.equal(hits[0].record.conflictsWith.length, 29);
  });

  test('a cold instance derives once and equals the warm instance', async () => {
    const dir = tempDir();
    const warm = newStore(dir);
    await seedLifecycle(warm);
    await warm.list({ limit: 50 });
    await warm.list({ limit: 50 });
    const cold = newStore(dir);
    assert.equal(cold.lifecycleIndexStats.builds, 0, 'nothing is derived before the first read');
    assert.equal(cold.lifecycleIndexStats.cached, false);
    const first = await cold.list({ limit: 50 });
    assert.equal(cold.lifecycleIndexStats.builds, 1);
    assert.equal(cold.lifecycleIndexStats.hits, 0);
    assert.deepEqual(first, await warm.list({ limit: 50 }));
    const second = await cold.list({ limit: 50 });
    assert.equal(cold.lifecycleIndexStats.builds, 1, 'the second cold read reuses');
    assert.deepEqual(second, first);
  });

  test('two app instances on one data directory each invalidate independently', async () => {
    const dir = tempDir();
    const reply = 'The lighthouse status is green.\nCOGNITION '
      + JSON.stringify({ schema: 1, decision: 'answer', answer: 'The lighthouse status is green.', claims: [] });
    const options = { gateway: fixtureGateway(reply), experienceCapture: CAPTURE_OFF, now: NOW };
    const first = createApp({ dataDir: dir, ...options });
    const second = createApp({ dataDir: dir, ...options });
    const record = (await first.knowledge.add(claim('lighthouse', 'status', 'green'))).record;
    assert.deepEqual((await second.knowledge.list({ limit: 10 })).map((r) => r.id), [record.id]);
    await second.knowledge.list({ limit: 10 });
    const builds = second.knowledge.lifecycleIndexStats.builds;
    const added = (await first.knowledge.add(claim('lighthouse', 'status', 'amber'))).record;
    const window = await second.knowledge.list({ limit: 10 });
    assert.deepEqual(window.map((r) => r.id).sort(), [record.id, added.id].sort());
    assert.ok(second.knowledge.lifecycleIndexStats.builds > builds, 'the other instance write invalidated this one');
    assert.deepEqual(window.find((r) => r.id === added.id).conflictsWith, [record.id]);
    // Separate directories are separate stores: one never answers for the other.
    const other = createApp({ dataDir: tempDir(), ...options });
    await other.knowledge.add(claim('lighthouse', 'status', 'green'));
    assert.deepEqual((await other.knowledge.list({ limit: 10 }))[0].conflictsWith, []);
    assert.equal((await second.knowledge.list({ limit: 10 })).length, 2);
  });

  test('a caller editing a returned record cannot reach the next read', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    const ids = await seedLifecycle(store);
    const first = await store.list({ limit: 50 });
    const alpha = first.find((r) => r.id === ids.alpha.id);
    assert.deepEqual(alpha.conflictsWith, [ids.beta.id]);
    alpha.supersededBy.push('injected');
    alpha.conflictsWith.length = 0;
    alpha.replaces.push('injected');
    if (alpha.resolution) alpha.resolution.targetIds.push('injected');
    const second = await store.list({ limit: 50 });
    const again = second.find((r) => r.id === ids.alpha.id);
    assert.deepEqual(again.supersededBy, []);
    assert.deepEqual(again.conflictsWith, [ids.beta.id]);
    assert.deepEqual(again.replaces, []);
    if (again.resolution) assert.ok(!again.resolution.targetIds.includes('injected'));
    const { health } = await projectionOf(store);
    health.anomalies.samples.push('injected');
    health.conflicts.groups = 999;
    const fresh = await projectionOf(store);
    assert.ok(!fresh.health.anomalies.samples.includes('injected'));
    assert.notEqual(fresh.health.conflicts.groups, 999);
  });

  test('the real controller path is unchanged and derives once per snapshot', async () => {
    const dir = tempDir();
    const target = 'the lighthouse project status is green';
    let evidenceId = null;
    const app = createApp({
      dataDir: dir,
      experienceCapture: CAPTURE_OFF,
      now: NOW,
      gateway: fixtureGateway(() => 'The lighthouse project status is green.\nCOGNITION '
        + JSON.stringify({
          schema: 1, decision: 'answer', answer: 'The lighthouse project status is green.',
          claims: [{ text: target, evidence: [`ev:memory:${evidenceId}`], kind: 'supported' }],
        })),
    });
    evidenceId = (await app.memory.add({ content: target, kind: 'user_fact', source: 'user' })).id;
    await app.knowledge.add(claim('lighthouse project', 'status', 'green'));
    const question = 'tell me about the lighthouse project status';
    const first = await app.controller.handle(question, { origin: 'user' });
    const second = await app.controller.handle(question, { origin: 'user' });
    assert.equal(first.output, second.output, 'the answer is identical');
    assert.equal(first.operation.status, second.operation.status);
    const integrityOf = (res) => {
      const integrity = res.operation.cognition.responseIntegrity;
      return {
        trust: integrity.trust,
        claims: integrity.claims,
        citation: integrity.citationCompleteness,
        retrieval: res.operation.prompt.retrievalReport.state,
      };
    };
    assert.deepEqual(integrityOf(first), integrityOf(second), 'classification and completeness are identical');
    assert.equal(integrityOf(first).trust, 'factually_supported');
    const stats = app.knowledge.lifecycleIndexStats;
    assert.ok(stats.builds >= 1, 'the request path derived the indexes');
    assert.ok(stats.hits > 0, 'the repeated reads inside one request reused the derivation');
    assert.equal(stats.authorizes, false);
  });
});
describe('AP-11: a write from another process is never answered from an older derivation', () => {
  test('the parent rebuilds after a real child appends, and matches an instance that derived from nothing', async () => {
    const dir = tempDir();
    const store = newStore(dir);
    await store.add(claim('lighthouse', 'status', 'green'));
    const first = await projectionOf(store);
    assert.equal(first.health.claims, 1);
    assert.equal(first.claims.length, 1);
    const before = store.lifecycleIndexStats;

    const output = await runChild(dir);
    assert.match(output, /^APPENDED [\w-]+/m, output);

    const second = await projectionOf(store);
    assert.equal(second.health.claims, 2, "the other process's claim is visible");
    assert.equal(store.lifecycleIndexStats.builds, before.builds + 1, 'the old derivation was not reused');
    assert.equal(store.lifecycleIndexStats.misses, before.misses + 1);
    assert.ok(second.claims.some((record) => record.subject === 'compass'), 'the appended claim is in the window');

    const reference = await projectionOf(newStore(dir));
    assert.deepEqual(second, reference, 'the parent agrees with an instance that derived from nothing');
  });
});
