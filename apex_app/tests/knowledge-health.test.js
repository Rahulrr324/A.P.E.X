// Implementation Batch R: store-wide knowledge health.
//
// These tests pin the counting rules, the lifecycle anomalies, the difference between
// claims and retraction events, incomplete inspection, bounded traversal, read-only
// behavior, and truthful CLI exit status. Fixtures are deterministic; no model server
// is used, and the tests that need a model double prove it is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { KnowledgeStore, MAX_HISTORY_CHAIN, sha256Hex } from '../src/knowledge/knowledge-store.js';
import { Outcome } from '../src/outcomes.js';
import { ModelGateway } from '../src/model/gateway.js';

// Deterministic, validation-compatible UUIDs.
function recordId(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const A = recordId(1);
const B = recordId(2);
const C = recordId(3);
const D = recordId(4);
const E = recordId(5);
const EVENT_1 = recordId(101);
const EVENT_2 = recordId(102);

function tempDir() {
  return makeTempDataDir();
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

function seededRecord({
  id,
  subject,
  relationship,
  object,
  status = 'supported',
  evidence = null,
  createdAt = '2026-01-01T00:00:00.000Z',
  supersededBy = null,
}) {
  return {
    schema: 1,
    id,
    subject,
    relationship,
    object,
    evidence,
    tripleHash: sha256Hex(`${subject}\x00${relationship}\x00${object}`),
    status,
    createdAt,
    provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
    ...(supersededBy ? { supersededBy } : {}),
  };
}

function retractionEvent({ id = EVENT_1, targetId, reason = null, createdAt = '2026-01-02T00:00:00.000Z' }) {
  return {
    schema: 1,
    kind: 'retraction',
    id,
    targetId,
    ...(reason ? { reason } : {}),
    createdAt,
    provenance: { origin: 'user_supplied', updateMode: 'user_confirmed' },
  };
}

function seed(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'knowledge.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
}

function healthOf(dir) {
  return new KnowledgeStore(path.join(dir, 'knowledge.jsonl')).health();
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

// TEST DOUBLE: proves read-only inspection never reaches the model.
function countingGateway() {
  const state = { calls: 0 };
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => {
      state.calls += 1;
      return {
        ok: true,
        backend: 'test-double',
        provider: 'test-double',
        model: 'test-double',
        text: '{}',
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), calls: state };
}

// ---- empty, claims-only, superseded, retracted ------------------------------

test('knowledge health - an empty store is healthy and is not confused with damage', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));

  const health = await healthOf(dir);
  assert.equal(health.inspected, true);
  assert.equal(health.complete, true);
  assert.equal(health.state, 'ok');
  assert.equal(health.claims, 0);
  assert.equal(health.lifecycleEvents, 0);
  assert.equal(health.active, 0);
  assert.equal(health.superseded, 0);
  assert.equal(health.retracted, 0);
  assert.equal(health.ambiguous, 0);
  assert.equal(health.conflicts.groups, 0);
  assert.equal(health.corruptLines, 0);
  assert.equal(health.chains.components, 0);
  assert.equal(health.anomalies.count, 0);
  assert.equal(health.attention, false);
  assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl')), false, 'health must not create the store');

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /empty store \(no claims or lifecycle events\)/);
  assert.match(cli.stdout, /read-only/);
  assert.doesNotMatch(cli.stdout, /unavailable|corrupt|damaged/);
});

test('knowledge health - claims without conflicts are active and need no attention', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, [
    seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: B, subject: 'Brake', relationship: 'type', object: 'Disc' }),
  ]);

  const health = await healthOf(dir);
  assert.equal(health.claims, 2);
  assert.equal(health.lifecycleEvents, 0);
  assert.equal(health.active, 2);
  assert.equal(health.superseded, 0);
  assert.equal(health.retracted, 0);
  assert.equal(health.ambiguous, 0);
  assert.equal(health.conflicts.groups, 0);
  assert.equal(health.anomalies.count, 0);
  assert.equal(health.attention, false);

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Claims:\s+2 total/);
  assert.match(cli.stdout, /active:\s+2/);
});

test('knowledge health - superseded and retracted claims are historical, not damage', async (t) => {
  await t.test('a supersession link does not inflate the claim count', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Diesel', supersededBy: [A] }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 2, 'both records are claims; the link is not another record');
    assert.equal(health.lifecycleEvents, 0);
    assert.equal(health.active, 1);
    assert.equal(health.superseded, 1);
    assert.equal(health.retracted, 0);
    assert.equal(health.ambiguous, 0);
    assert.equal(health.conflicts.groups, 0, 'the retired claim is not a live conflict');
    assert.equal(health.chains.components, 1);
    assert.equal(health.chains.largest, 2);
    assert.equal(health.chains.truncated, 0);
    assert.equal(health.anomalies.count, 0);
    assert.equal(health.attention, false);

    const cli = await runCli(['knowledge', 'health'], envFor(dir));
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /superseded:\s+1/);
  });

  await t.test('a retraction event is counted as an event, never as a claim', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      retractionEvent({ id: EVENT_1, targetId: A }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 1);
    assert.equal(health.lifecycleEvents, 1);
    assert.equal(health.active, 0);
    assert.equal(health.retracted, 1);
    assert.equal(health.superseded, 0);
    assert.equal(health.ambiguous, 0);
    assert.equal(health.anomalies.count, 0);
    assert.equal(health.attention, false, 'retraction is recorded history, not damage');

    const cli = await runCli(['knowledge', 'health'], envFor(dir));
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /Claims:\s+1 total/);
    assert.match(cli.stdout, /Lifecycle:\s+1 event\(s\) \(retraction events; not claims\)/);
  });
});

test('knowledge health - active conflicts are reported and require explicit handling', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, [
    seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Diesel' }),
  ]);

  const health = await healthOf(dir);
  assert.equal(health.claims, 2);
  assert.equal(health.active, 2);
  assert.equal(health.conflicts.groups, 1);
  assert.equal(health.conflicts.claims, 2);
  assert.equal(health.conflicts.samples.length, 1);
  assert.equal(health.anomalies.count, 0, 'a conflict is preserved data, not a lifecycle anomaly');
  assert.equal(health.attention, true);

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /1 unresolved group\(s\), 2 active claim\(s\)/);
  assert.match(cli.stdout, /require explicit handling/);
});

test('knowledge health - mixed claims and lifecycle events keep separate counts', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  seed(dir, [
    seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    seededRecord({ id: B, subject: 'Brake', relationship: 'type', object: 'Disc' }),
    seededRecord({ id: C, subject: 'Brake', relationship: 'type', object: 'Drum', supersededBy: [B] }),
    seededRecord({ id: D, subject: 'Tire', relationship: 'pressure', object: '30' }),
    seededRecord({ id: E, subject: 'Tire', relationship: 'pressure', object: '32' }),
    retractionEvent({ id: EVENT_1, targetId: D }),
  ]);

  const health = await healthOf(dir);
  assert.equal(health.claims, 5);
  assert.equal(health.lifecycleEvents, 1);
  assert.equal(health.active, 3, 'a, c, and e remain active');
  assert.equal(health.superseded, 1, 'b was replaced');
  assert.equal(health.retracted, 1, 'd was retracted; its retraction event is not a claim');
  assert.equal(health.ambiguous, 0);
  assert.equal(health.conflicts.groups, 0);
  assert.equal(health.anomalies.count, 0);
  assert.equal(health.attention, false);
  assert.equal(health.active + health.superseded + health.retracted + health.ambiguous, health.claims);

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Claims:\s+5 total/);
  assert.match(cli.stdout, /Lifecycle:\s+1 event\(s\)/);
});

// ---- ambiguity and anomalies ----------------------------------------------

test('knowledge health - ambiguous lifecycle evidence is counted separately, never as active', async (t) => {
  await t.test('a record that is both retracted and superseded is ambiguous', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Diesel', supersededBy: [A] }),
      retractionEvent({ id: EVENT_1, targetId: A }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 2);
    assert.equal(health.lifecycleEvents, 1);
    assert.equal(health.active, 1);
    assert.equal(health.ambiguous, 1);
    assert.equal(health.superseded, 0);
    assert.equal(health.retracted, 0);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /is both retracted and superseded/);
    assert.equal(health.attention, true);

    const cli = await runCli(['knowledge', 'health'], envFor(dir));
    assert.equal(cli.code, 1, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /ambiguous:\s+1/);
    assert.match(cli.stdout, /both retracted and superseded/);
  });

  await t.test('more than one retraction event for one claim is ambiguous', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      retractionEvent({ id: EVENT_1, targetId: A, createdAt: '2026-01-02T00:00:00.000Z' }),
      retractionEvent({ id: EVENT_2, targetId: A, createdAt: '2026-01-03T00:00:00.000Z' }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 1);
    assert.equal(health.lifecycleEvents, 2);
    assert.equal(health.active, 0);
    assert.equal(health.ambiguous, 1);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /2 retraction events/);
    assert.equal(health.attention, true);
  });
});

test('knowledge health - broken links, multiple successors, cycles, and contradictions are anomalies', async (t) => {
  await t.test('a missing supersession target is reported, not inferred', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal', supersededBy: [B] }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 1);
    // The record that names the missing predecessor is not itself retired: only the
    // link is unresolved, so it stays active while the anomaly is reported.
    assert.equal(health.active, 1);
    assert.equal(health.superseded, 0);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /is not in the store/);
    assert.equal(health.chains.components, 0, 'a dangling link links nothing');
    assert.equal(health.attention, true);
  });

  await t.test('more than one later record naming the same predecessor is an anomaly', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Petrol', supersededBy: [D] }),
      seededRecord({ id: C, subject: 'Engine', relationship: 'fuel', object: 'Diesel', supersededBy: [D] }),
      seededRecord({ id: D, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 3);
    assert.equal(health.active, 2);
    assert.equal(health.superseded, 1);
    assert.equal(health.conflicts.groups, 1, 'the two live successors still conflict');
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /named by 2 later records/);
    assert.equal(health.attention, true);
  });

  await t.test('a supersession cycle is reported without guessing a direction', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal', supersededBy: [B] }),
      seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Diesel', supersededBy: [A] }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 2);
    assert.equal(health.active, 0);
    assert.equal(health.superseded, 2);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /contain a cycle/);
    assert.equal(health.attention, true);
  });

  await t.test('a stored superseded status without a successor is an anomaly', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal', status: 'superseded' }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 1);
    assert.equal(health.superseded, 1);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /no successor names it/);
    assert.equal(health.attention, true);
  });

  await t.test('a link across different subject or relationship is an anomaly', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      seededRecord({ id: B, subject: 'Brake', relationship: 'type', object: 'Disc', supersededBy: [A] }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 2);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /different subject or relationship/);
    assert.equal(health.attention, true);
  });

  await t.test('a link between records stating the same triple is an anomaly', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [
      seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' }),
      seededRecord({ id: B, subject: 'Engine', relationship: 'fuel', object: 'Coal', supersededBy: [A] }),
    ]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 2);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /same triple/);
    assert.equal(health.attention, true);
  });

  await t.test('a retraction event whose target is absent is an orphan, not a claim', async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    seed(dir, [retractionEvent({ id: EVENT_1, targetId: B })]);

    const health = await healthOf(dir);
    assert.equal(health.claims, 0);
    assert.equal(health.lifecycleEvents, 1);
    assert.equal(health.retracted, 0);
    assert.equal(health.anomalies.count, 1);
    assert.match(health.anomalies.samples[0], /targets \[.*\], which is not in the store/);
    assert.equal(health.attention, true);
  });
});

// ---- damage, unavailability, and bounded chains ----------------------------

test('knowledge health - corrupt lines are reported and every count is limited to readable records', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const damaged = [
    JSON.stringify(seededRecord({ id: A, subject: 'Engine', relationship: 'fuel', object: 'Coal' })),
    JSON.stringify(retractionEvent({ id: EVENT_1, targetId: A })),
    '{broken',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), damaged, 'utf8');

  const health = await healthOf(dir);
  assert.equal(health.inspected, true);
  assert.equal(health.complete, false);
  assert.equal(health.state, 'damaged');
  assert.equal(health.claims, 1);
  assert.equal(health.lifecycleEvents, 1);
  assert.equal(health.retracted, 1);
  assert.equal(health.corruptLines, 1);
  assert.equal(health.corrupt[0].line, 3);
  assert.equal(health.attention, true);

  const store = new KnowledgeStore(path.join(dir, 'knowledge.jsonl'));
  await assert.rejects(() => store.list(), /corrupt/i, 'a damaged store still fails closed for normal reads');

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /damaged - 1 corrupt line\(s\); inspection incomplete/);
  assert.match(cli.stdout, /counts cover readable records only/);
  assert.equal(fs.readFileSync(path.join(dir, 'knowledge.jsonl'), 'utf8'), damaged, 'health must not repair or rewrite');

  const diag = await runCli(['diagnose'], envFor(dir));
  assert.equal(diag.code, 1);
  assert.match(diag.stdout, /Knowledge: corrupt \(1 claim\(s\), 1 lifecycle event\(s\), 1 corrupt line\(s\); lifecycle state cannot be fully established\)/);
  assert.match(diag.stdout, /knowledge lifecycle consistency was checked only against readable records/);
});

test('knowledge health - an unreadable store is unavailable, and unrelated deterministic work still runs', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'knowledge.jsonl'));

  const health = await healthOf(dir);
  assert.equal(health.inspected, false);
  assert.equal(health.state, 'unavailable');
  assert.equal(health.claims, null);
  assert.equal(health.lifecycleEvents, null);
  assert.equal(health.anomalies.count, null);
  assert.equal(health.attention, true);
  assert.match(health.detail, /EISDIR|EACCES|EPERM|not a file|cannot read/i);

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Store:\s+unavailable/);
  assert.match(cli.stdout, /no claim, event, lifecycle, or conflict count can be established/);
  assert.match(cli.stdout, /an unreadable store is not an empty store/);

  const calc = await runCli(['ask', 'calc', '2+2'], envFor(dir));
  assert.equal(calc.code, 0, calc.stdout + calc.stderr);
  assert.match(calc.stdout, /2\+2 = 4 \(verified\)/);
});

test('knowledge health - a chain beyond the history view bound is bounded, not called damaged', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const records = [];
  for (let i = 0; i < MAX_HISTORY_CHAIN + 5; i += 1) {
    records.push(seededRecord({
      id: recordId(i),
      subject: 'Engine',
      relationship: 'generation',
      object: String(i),
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      ...(i > 0 ? { supersededBy: [recordId(i - 1)] } : {}),
    }));
  }
  seed(dir, records);

  const health = await healthOf(dir);
  assert.equal(health.claims, MAX_HISTORY_CHAIN + 5);
  assert.equal(health.active, 1);
  assert.equal(health.superseded, MAX_HISTORY_CHAIN + 4);
  assert.equal(health.chains.components, 1);
  assert.equal(health.chains.largest, MAX_HISTORY_CHAIN + 5);
  assert.equal(health.chains.truncated, 1);
  assert.equal(health.anomalies.count, 0);
  assert.equal(health.complete, true);
  assert.equal(health.attention, false, 'a view bound is not store damage');

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /exceed the 20-record history view bound/);

  const view = await new KnowledgeStore(path.join(dir, 'knowledge.jsonl')).history(recordId(0));
  assert.equal(view.chain.length, MAX_HISTORY_CHAIN);
  assert.equal(view.chainTruncated, true);
  assert.equal(view.complete, false);
});

// ---- read-only behavior and CLI contract -----------------------------------

test('knowledge health - the read is read-only and never calls the model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const { gateway, calls } = countingGateway();
  const app = createApp({ dataDir: dir, gateway });
  const shop = { subject: 'Engine', relationship: 'fuel', object: 'Coal' };
  const added = await app.controller.knowledgeAdd(shop);
  assert.equal(added.status, Outcome.SUCCESS_VERIFIED);
  await app.controller.knowledgeRetract({ target: added.operation.steps[0].result.data.id });

  const before = snapshot(dir);
  const res = await app.controller.knowledgeHealth();

  assert.equal(calls.calls, 0, 'health must not call the model');
  assert.equal(res.recorded, false);
  assert.equal(res.operation, null);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(res.health.claims, 1);
  assert.equal(res.health.lifecycleEvents, 1);
  assert.equal(res.health.retracted, 1);
  assert.equal(res.health.attention, false);
  assert.match(res.display, /read-only/);
  assert.deepEqual(snapshot(dir), before, 'health wrote no knowledge or audit record');

  const cli = await runCli(['knowledge', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.deepEqual(snapshot(dir), before, 'the CLI health command wrote nothing');
});

test('knowledge health - CLI usage is strict and the help lists the command', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));

  const help = await runCli(['help'], envFor(dir));
  assert.equal(help.code, 0);
  assert.match(help.stdout, /knowledge health\s+store-wide counts, conflicts, and lifecycle anomalies \(read-only\)/);

  const extra = await runCli(['knowledge', 'health', 'extra'], envFor(dir));
  assert.equal(extra.code, 2, extra.stdout + extra.stderr);
  assert.match(extra.stderr, /usage: knowledge health/);
  assert.deepEqual(snapshot(dir), {}, 'a usage error wrote nothing');
});
