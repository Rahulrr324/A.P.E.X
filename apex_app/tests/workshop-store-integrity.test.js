import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildArtifact, normalizeComposition } from '../src/workshop/index.js';
import { WorkshopStore } from '../src/workshop/store.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-workshop-integrity-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workshop.jsonl');
  const store = new WorkshopStore(file, { now: () => new Date('2026-01-02T03:04:05.000Z') });
  const composition = normalizeComposition({
    title: 'Integrity fixture',
    domain: 'plan',
    note: 'test only',
    components: [
      { id: 'planner', kind: 'service', supply: 5, demand: 1, cost: 2 },
      { id: 'store', kind: 'database', supply: 0, demand: 3, cost: 1 },
    ],
    connections: [{ from: 'planner', to: 'store' }],
    budget: { total: 10 },
  });
  return { dir, file, store, artifact: buildArtifact(composition, { now: () => new Date('2026-01-02T03:04:05.000Z') }) };
}

test('Workshop append, read, and status verify the complete digest chain', async (t) => {
  const { store, artifact } = await fixture(t);
  const appended = await store.append(artifact);
  assert.equal(appended.appended, true);
  assert.equal((await store.status()).chain, 'intact');
  assert.equal((await store.get(artifact.artifactId)).found, true);
  assert.equal((await store.list()).total, 1);
});

test('Workshop integrity survives a store instance restart', async (t) => {
  const { file, artifact } = await fixture(t);
  await new WorkshopStore(file).append(artifact);
  const restarted = new WorkshopStore(file);
  assert.equal((await restarted.status()).chain, 'intact');
  assert.equal((await restarted.get(artifact.artifactId)).found, true);
});

test('Workshop refuses reads and appends after a record is tampered with', async (t) => {
  const { file, store, artifact } = await fixture(t);
  await store.append(artifact);
  const line = await fs.readFile(file, 'utf8');
  const changed = line.replace('Integrity fixture', 'Tampered fixture');
  assert.notEqual(changed, line);
  await fs.writeFile(file, changed, 'utf8');

  const status = await store.status();
  assert.equal(status.chain, 'damaged');
  await assert.rejects(() => store.get(artifact.artifactId), /integrity|corrupt/i);
  await assert.rejects(() => store.list(), /integrity|corrupt/i);
  await assert.rejects(() => store.append(artifact), /integrity|corrupt/i);
});

test('Workshop refuses to append after malformed JSON is found', async (t) => {
  const { file, store, artifact } = await fixture(t);
  await store.append(artifact);
  await fs.appendFile(file, '{broken json\n', 'utf8');

  const status = await store.status();
  assert.equal(status.chain, 'damaged');
  assert.equal(status.corrupt, 1);
  await assert.rejects(() => store.append(artifact), /corrupt/i);
});

test('Workshop store rejects a record whose identity digest does not match its content', async (t) => {
  const { store, artifact } = await fixture(t);
  const forged = { ...artifact, title: 'Changed after identity' };
  await assert.rejects(() => store.append(forged), /identity digest/i);
});
