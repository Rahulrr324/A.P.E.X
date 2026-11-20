// T-33 Step 3 (2026-11-19): the Workshop sandbox loop and the TaskGraph inspector.
//
// Two promises are pinned here.
//
//  1. Honest cinema (Part 4, Principle #7): a verified badge exists only when the backend record says
//     `verified: true`, a promotion refuses without one, and a failed verification is recorded as a
//     failure rather than as an absent record.
//  2. The graph the owner inspects is the log's: node states, dependency edges and per-node
//     verification come from the task record, and the controls offered are the ones the controller
//     route can actually perform.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import {
  WORKSHOP_CHECKS, WorkshopVerificationLedger, verifyArtifact,
} from '../src/workshop/verification.js';

const TOKEN = 't33-sandbox-token-0123456789';
const dirs = [];
const servers = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

async function start() {
  const dir = tempDir();
  const app = createApp({ dataDir: dir });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  servers.push(ui);
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
  return { app, dir, base, headers };
}

const SOUND = {
  title: 'T-33 sandbox design',
  domain: 'plan',
  components: [
    { id: 'supply', kind: 'resource', supply: 10, demand: 0, cost: 1 },
    { id: 'load', kind: 'service', supply: 0, demand: 5, cost: 1 },
  ],
  connections: [{ from: 'supply', to: 'load' }],
  budget: { total: 4 },
};
const SHORT = {
  title: 'T-33 short design',
  domain: 'plan',
  components: [
    { id: 'supply', kind: 'resource', supply: 1, demand: 9, cost: 1 },
    { id: 'load', kind: 'service', supply: 1, demand: 9, cost: 1 },
  ],
  connections: [{ from: 'supply', to: 'load' }],
  budget: { total: 2 },
};

describe('the workshop sandbox', () => {
  test('every check is named, and the record is arithmetic over the stored sheet', async () => {
    const { app } = await start();
    const composed = await app.controller.runAction('workshop.compose', SOUND, 'user', 'op-compose');
    assert.equal(composed.outcome, 'success_verified', composed.summary);
    const artifactId = composed.result.data.artifactId;
    const found = await app.workshop.get(artifactId);
    const verified = verifyArtifact(found.artifact, await app.workshop.inspect(artifactId).then((r) => r.report),
      await app.workshop.simulate(artifactId).then((r) => r.report), { now: () => new Date('2026-11-19T10:00:00.000Z') });
    assert.deepEqual(verified.checks.map((check) => check.id), WORKSHOP_CHECKS.map((check) => check.id), 'the check list is the declared one, in order');
    assert.equal(verified.verified, true);
    assert.equal(verified.authorizesExecution, false);
    assert.equal(verified.executedCode, false);
    // Determinism: the same sheet and the same clock produce the same verdicts.
    const again = verifyArtifact(found.artifact, await app.workshop.inspect(artifactId).then((r) => r.report),
      await app.workshop.simulate(artifactId).then((r) => r.report), { now: () => new Date('2026-11-19T10:00:00.000Z') });
    assert.deepEqual(again.checks, verified.checks);
  });

  test('a verification is recorded, a promotion needs it, and the badge follows the record', async () => {
    const { app, base, headers, dir } = await start();
    const composed = await app.controller.runAction('workshop.compose', SOUND, 'user', 'op-compose');
    const artifactId = composed.result.data.artifactId;

    // Before any verification, the promotion is refused and the UI is told why.
    const refused = await app.controller.runAction('workshop.promote', { artifactId, reason: 'premature' }, 'user', 'op-early');
    assert.notEqual(refused.outcome, 'success_verified');
    assert.equal(refused.result, null);
    assert.match(refused.summary, /NOT_VERIFIED|no verification/i);

    const verified = await app.controller.runAction('workshop.verify', { artifactId, reason: 'T-33 sandbox run' }, 'user', 'op-verify');
    assert.equal(verified.outcome, 'success_verified', verified.summary);
    assert.equal(verified.result.data.verified, true);
    assert.equal(verified.result.data.failed.length, 0);

    const promoted = await app.controller.runAction('workshop.promote', { artifactId, reason: 'accepted after the sandbox check' }, 'user', 'op-promote');
    assert.equal(promoted.outcome, 'success_verified', promoted.summary);
    assert.equal(promoted.result.data.verified, true);
    assert.ok(promoted.result.data.memoryId, 'the promotion writes one memory-timeline entry');
    const memory = await app.memory.list({ limit: 5 });
    const record = (memory.records ?? memory).find((entry) => entry.id === promoted.result.data.memoryId);
    assert.ok(record, 'the memory entry is readable by the id the promotion reported');
    assert.match(record.content, new RegExp(`workshop artifact ${artifactId} promoted`));

    // The surface the deck reads reports the same facts, from the ledger.
    const page = await fetch(`${base}/api/workshop`, { headers }).then((r) => r.json());
    const entry = page.verificationSummary.entries.find((row) => row.artifactId === artifactId);
    assert.equal(entry.verified, true);
    assert.equal(entry.verification.verified, true);
    assert.equal(entry.promotion.verificationId, verified.result.data.verificationId);
    assert.ok(fs.existsSync(path.join(dir, 'workshop-verifications.jsonl')), 'the ledger is its own append-only file');
  });

  test('a failed verification is recorded as a failure, and blocks the promotion', async () => {
    const { app } = await start();
    const composed = await app.controller.runAction('workshop.compose', SHORT, 'user', 'op-compose');
    const artifactId = composed.result.data.artifactId;
    const verified = await app.controller.runAction('workshop.verify', { artifactId }, 'user', 'op-verify');
    assert.equal(verified.outcome, 'success_verified', 'recording a failed check is a successful recording');
    assert.equal(verified.result.data.verified, false);
    assert.deepEqual(verified.result.data.failed, ['supply_meets_demand']);
    const promotion = await app.controller.runAction('workshop.promote', { artifactId, reason: 'try anyway' }, 'user', 'op-promote');
    assert.notEqual(promotion.outcome, 'success_verified');
    const state = await app.workshop.verificationState(artifactId);
    assert.equal(state.verified, false);
    assert.equal(state.promotion, null);
    // A later passing verification is what unblocks it: the ledger keeps the failure as evidence.
    const fixed = await app.controller.runAction('workshop.compose', {
      title: 'T-33 fixed design',
      domain: 'plan',
      components: [
        { id: 'supply', kind: 'resource', supply: 9, demand: 0, cost: 1 },
        { id: 'load', kind: 'service', supply: 0, demand: 9, cost: 1 },
      ],
      connections: [{ from: 'supply', to: 'load' }],
      budget: { total: 2 },
    }, 'user', 'op-compose-2');
    const second = await app.controller.runAction('workshop.verify', { artifactId: fixed.result.data.artifactId }, 'user', 'op-verify-2');
    assert.equal(second.result.data.verified, true);
    const ledger = new WorkshopVerificationLedger(WorkshopVerificationLedger.pathFor(app.dataDir));
    const listed = await ledger.list({ limit: 10 });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.corrupt, 0);
  });

  test('the ledger refuses a promotion whose verification was recorded against other content', async () => {
    const { app } = await start();
    const composed = await app.controller.runAction('workshop.compose', SOUND, 'user', 'op-compose');
    const artifactId = composed.result.data.artifactId;
    await app.controller.runAction('workshop.verify', { artifactId }, 'user', 'op-verify');
    // Rewrite the recorded digest, as a tampered or stale ledger would.
    const file = path.join(app.dataDir, 'workshop-verifications.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    lines[0].identityDigest = 'f'.repeat(64);
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const promotion = await app.controller.runAction('workshop.promote', { artifactId, reason: 'stale digest' }, 'user', 'op-promote');
    assert.notEqual(promotion.outcome, 'success_verified');
    assert.match(promotion.summary, /different content|DIGEST_MISMATCH/i);
  });
});

describe('the TaskGraph inspector', () => {
  test('the graph is the task log: nodes, edges, states and verification', async () => {
    const { app, base, headers } = await start();
    const run = await app.controller.runAction('cognition.run', {
      intent: 'store the T-33 graph marker in memory', action: 'memory.add', input: { content: 'the T-33 graph marker' },
    }, 'user', 'op-run').catch(() => null);
    assert.ok(run, 'the pipeline ran (its own route is exercised in the browser suite)');
    const graph = await fetch(`${base}/api/taskgraph`, { headers }).then((r) => r.json());
    assert.ok(graph.taskId, 'a task exists');
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].state, 'awaiting_approval');
    assert.equal(graph.nodes[0].verified, false, 'a gated node is not verified');
    assert.equal(graph.nodes[0].control, 'approve');
    assert.equal(graph.controls.approve, true);
    assert.equal(graph.controls.cancel, true);
    assert.equal(graph.authorizesExecution, false);
    assert.deepEqual(graph.edges, [], 'one node has no dependency edge');
  });

  test('an unknown task id answers with an empty graph rather than another task', async () => {
    const { base, headers } = await start();
    const graph = await fetch(`${base}/api/taskgraph?taskId=task-doesnotexist`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(graph.status, 200);
    assert.equal(graph.body.taskId, null);
    assert.deepEqual(graph.body.nodes, []);
    assert.equal(graph.body.status, 'none');
  });

  test('the checkpoint control approves the gated step and the node becomes verified', async () => {
    const { app, base, headers } = await start();
    await fetch(`${base}/api/cognition/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'store the T-33 approval marker in memory', action: 'memory.add', input: { content: 'the T-33 approval marker' } }),
    }).then((r) => r.json());
    const before = await fetch(`${base}/api/taskgraph`, { headers }).then((r) => r.json());
    const taskId = before.taskId;
    const stepId = before.nodes[0].id;
    const approved = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ stepId }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'success_verified');
    // The approval records intent; the step is now pending and the task paused, so the run is resumed
    // through the same controller the deck uses for a task.
    await app.controller.runTask(taskId, 'resume');
    const after = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(taskId)}`, { headers }).then((r) => r.json());
    assert.equal(after.nodes[0].state, 'completed');
    assert.equal(after.nodes[0].outcome, 'success_verified');
    assert.equal(after.verified, true, 'the whole graph is verified once every node is');
    assert.equal(after.controls.approve, false);
    // The memory write the step performed is really there.
    const memory = await app.memory.list({ limit: 5 });
    const rows = memory.records ?? memory;
    assert.ok(rows.some((entry) => /T-33 approval marker/.test(entry.content)));
  });

  test('a cancelled task refuses further checkpoints and says so without inventing a node', async () => {
    const { base, headers } = await start();
    await fetch(`${base}/api/cognition/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'store the T-33 cancel marker in memory', action: 'memory.add', input: { content: 'the T-33 cancel marker' } }),
    }).then((r) => r.json());
    const graph = await fetch(`${base}/api/taskgraph`, { headers }).then((r) => r.json());
    const cancelled = await fetch(`${base}/api/tasks/${encodeURIComponent(graph.taskId)}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(cancelled.status, 200);
    const after = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(graph.taskId)}`, { headers }).then((r) => r.json());
    assert.equal(after.status, 'cancelled');
    assert.equal(after.controls.cancel, false);
    assert.equal(after.controls.approve, false);
  });
});

describe('the promotion is ECP-gated, not merely user-only', () => {
  test('a promotion proposed through the pipeline pauses at awaiting_approval until the owner approves it', async () => {
    const { app, base, headers } = await start();
    const composed = await app.controller.runAction('workshop.compose', {
      title: 'T-33 gated promotion sheet', domain: 'plan',
      components: [
        { id: 'supply', kind: 'resource', supply: 5, demand: 0, cost: 1 },
        { id: 'load', kind: 'service', supply: 0, demand: 5, cost: 1 },
      ],
      connections: [{ from: 'supply', to: 'load' }], budget: { total: 2 },
    }, 'user', 'op-compose');
    const artifactId = composed.result.data.artifactId;
    await app.controller.runAction('workshop.verify', { artifactId }, 'user', 'op-verify');

    // Asking for the promotion as governed work does not perform it: the ECP gate stops the write
    // step in awaiting_approval, which is the state the graph must show.
    const run = await fetch(`${base}/api/cognition/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'promote the T-33 gated sheet', action: 'workshop.promote', input: { artifactId, reason: 'owner accepts after the sandbox check' } }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(run.status, 200);
    assert.equal(run.body.run.status, 'awaiting_approval', 'the run itself reports the gate, not a completed promotion');
    const taskId = run.body.run.taskId;
    const graph = await fetch(`${base}/api/taskgraph?taskId=${encodeURIComponent(taskId)}`, { headers }).then((r) => r.json());
    assert.equal(graph.nodes[0].state, 'awaiting_approval');
    assert.equal(graph.nodes[0].control, 'approve');
    assert.equal(graph.controls.approve, true);
    // The gate is real: nothing was promoted yet.
    assert.equal((await app.workshop.verificationState(artifactId)).promotion, null);

    // The owner's approval lets the step run, and only then does the ledger hold the promotion.
    const approved = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ stepId: 's1' }),
    }).then((r) => r.json());
    assert.equal(approved.status, 'success_verified');
    await app.controller.runTask(taskId, 'resume');
    const state = await app.workshop.verificationState(artifactId);
    assert.ok(state.promotion, 'the promotion happened only after the approval');
    assert.equal(state.promotion.reason, 'owner accepts after the sandbox check');
  });

  test('lockdown refuses both Workshop writes at the ECP, and the deck says which gate held', async () => {
    const { app, base, headers } = await start();
    const composed = await app.controller.runAction('workshop.compose', {
      title: 'T-33 lockdown sheet', domain: 'plan',
      components: [{ id: 'supply', kind: 'resource', supply: 5, demand: 0, cost: 1 }],
      connections: [], budget: { total: 1 },
    }, 'user', 'op-compose');
    const artifactId = composed.result.data.artifactId;
    await app.controller.runAction('safety.lockdown', { reason: 'T-33 gate survey' }, 'user', 'op-lock');
    for (const [route, body] of [['/api/workshop/verify', { artifactId }], ['/api/workshop/promote', { artifactId, reason: 'while locked down' }]]) {
      const refused = await fetch(base + route, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json() }));
      assert.equal(refused.status, 400, `${route} is refused under lockdown`);
      assert.equal(refused.body.status, 'action_denied');
      assert.match(refused.body.display, /KILL_SWITCH_ACTIVE/);
    }
    // Nothing was recorded by the refused attempts.
    const state = await app.workshop.verificationState(artifactId);
    assert.equal(state.verification, null);
    assert.equal(state.promotion, null);
  });

  test('below the write floor the ECP refuses the promotion, and the refusal is neither a crash nor a success', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, autonomyByDomain: { workshop: 1 } });
    const composed = await app.controller.runAction('workshop.compose', {
      title: 'T-33 low-autonomy sheet', domain: 'plan',
      components: [{ id: 'supply', kind: 'resource', supply: 5, demand: 0, cost: 1 }],
      connections: [], budget: { total: 1 },
    }, 'user', 'op-compose');
    // At level 1 the ECP blocks the write outright, so even composing is refused.
    assert.notEqual(composed.outcome, 'success_verified');
    assert.match(composed.summary, /AUTONOMY_LEVEL_BLOCKS_WRITE|denied/i);
  });
});
