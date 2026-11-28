// T-34 Steps 2 and 3 (2026-11-19): candidate associative recall, the briefing delta and its
// checkpoint, and the Sentinel's watch rules.
//
// Three promises are pinned here.
//
//  1. A recall is a candidate association. It names the record it came from, carries a similarity and
//     a capped confidence, and can never be produced as `observed`, as a fact or as a permission.
//  2. A briefing delta is a comparison of two readings. With no checkpoint it says so in the honest
//     words; with one it lists what changed and where to look, and acknowledging writes the next
//     checkpoint through the governed action rather than through the client.
//  3. The Sentinel's watch rules report what the governor actually did: thresholds, the last
//     signature, hit counts and when each last fired - and zero hits when a rule has never fired.
//
// Nothing here runs a model, and every write goes to an isolated temporary data directory.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import {
  ASSOCIATION_SCHEMA, MAX_CANDIDATE_CONFIDENCE, MIN_SIMILARITY, associationId, candidateAssociations, relatedness,
} from '../src/cognition/associations.js';
import { NO_PRIOR_CHECKPOINT, briefingDelta } from '../src/briefing/checkpoints.js';
import { Outcome } from '../src/outcomes.js';

const TOKEN = 't34-brief-token-0123456789';
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

async function start(extra = {}) {
  const dir = tempDir();
  const app = createApp({ dataDir: dir, ...extra });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  servers.push(ui);
  return { app, dir, base: `http://127.0.0.1:${started.port}`, headers: { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' } };
}

const get = (base, headers, route) => fetch(`${base}${route}`, { headers }).then(async (response) => ({ status: response.status, body: await response.json() }));
const post = (base, headers, route, body) => fetch(`${base}${route}`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (response) => ({ status: response.status, body: await response.json() }));

describe('T-34 a recall is a candidate association, never an observation', () => {
  const episodes = [
    { id: 'cog-aaaa', text: 'the lighthouse project status is green', outcome: 'completed', at: '2026-11-18T00:00:00.000Z' },
    { id: 'cog-bbbb', text: 'a completely different note about onions and soup', outcome: 'failed', at: '2026-11-18T01:00:00.000Z' },
  ];

  test('relatedness is the plain Dice number of two token sets, and it is symmetric', () => {
    assert.equal(relatedness('the lighthouse project is green', 'the lighthouse project is green'), 1);
    assert.equal(relatedness('lighthouse', 'onions'), 0);
    const forward = relatedness('is the lighthouse project green', 'the lighthouse project status is green');
    const backward = relatedness('the lighthouse project status is green', 'is the lighthouse project green');
    assert.equal(forward, backward);
    assert.ok(forward > MIN_SIMILARITY && forward < 1);
  });

  test('the recall carries its source, its similarity, its basis and a capped confidence', () => {
    const recalls = candidateAssociations({ intent: 'is the lighthouse project still on track', episodes });
    assert.equal(recalls.length, 1, 'the unrelated episode is not recalled');
    const [recall] = recalls;
    assert.equal(recall.schema, ASSOCIATION_SCHEMA);
    assert.equal(recall.kind, 'candidate_association');
    assert.equal(recall.epistemicStatus, 'candidate_association');
    assert.notEqual(recall.epistemicStatus, 'observed');
    assert.equal(recall.status, 'candidate');
    assert.equal(recall.sourceRecordId, 'cog-aaaa');
    assert.equal(recall.sourceType, 'cognition_run');
    assert.equal(recall.id, associationId({ intent: 'is the lighthouse project still on track', sourceRecordId: 'cog-aaaa' }));
    assert.ok(recall.similarity >= MIN_SIMILARITY);
    assert.ok(recall.confidence <= MAX_CANDIDATE_CONFIDENCE, 'a candidate is never as confident as an observation');
    assert.match(recall.basis, /^shared terms: /);
    assert.equal(recall.verified, false);
    assert.equal(recall.authorizesExecution, false);
    assert.equal(recall.grantsPermission, false);
    assert.equal(Object.hasOwn(recall, 'permission'), false, 'a recall is not a capability');
    assert.equal(Object.hasOwn(recall, 'capability'), false);
  });

  test('the same request always produces the same recalls in the same order', () => {
    const first = candidateAssociations({ intent: 'lighthouse project status check', episodes });
    const second = candidateAssociations({ intent: 'lighthouse project status check', episodes });
    assert.deepEqual(second, first);
    const none = candidateAssociations({ intent: 'nothing in common at all here', episodes });
    assert.deepEqual(none, [], 'an intent that shares too little is not associated with anything');
    assert.deepEqual(candidateAssociations({ intent: 'lighthouse project', episodes: [] }), []);
  });
});

describe('T-34 a later run recalls a related prior episode, and the packet says so', () => {
  test('the packet carries the recall, its source id and its own epistemic class', async () => {
    const { app } = await start();
    // The memory is seeded through the store; the runs themselves are reads, so nothing is gated and
    // the recalls are about episodes rather than about approvals.
    await app.memory.add({ content: 'lighthouse project status: green', kind: 'user_fact', source: 'user' });
    const first = await app.controller.runAction('cognition.run', {
      intent: 'check the lighthouse project status', action: 'memory.search', input: { query: 'lighthouse project status' },
    }, 'user');
    assert.equal(first.outcome, Outcome.SUCCESS_VERIFIED);
    const firstRunId = first.result.data.runId;

    const second = await app.controller.runAction('cognition.run', {
      intent: 'is the lighthouse project still on track', action: 'memory.search', input: { query: 'lighthouse project' },
    }, 'user');
    assert.equal(second.outcome, Outcome.SUCCESS_VERIFIED);
    const run = await app.cognition.get(second.result.data.runId);
    const recalls = run.stages.context.associativeRecalls;
    assert.equal(recalls.count, 1);
    assert.equal(recalls.authorizesExecution, false);
    const [recall] = recalls.recalls;
    assert.equal(recall.epistemicStatus, 'candidate_association');
    assert.equal(recall.sourceRecordId, firstRunId, 'the recall names the prior run it came from');
    assert.ok(recall.similarity > 0);
    // The epistemic counts are separate: a recall never inflates the observed total.
    assert.equal(run.stages.context.epistemic.candidate_association, 1);
    assert.equal(run.stages.context.epistemic.observed, 0);
    // And the recall is not in the memory or the knowledge list, which are the observed/recorded ones.
    assert.equal((run.stages.context.memory.items ?? []).some((item) => item.id === recall.id), false);
  });

  test('/api/memory/associations lists the recall with its source and never as observed', async () => {
    const { app, base, headers } = await start();
    await app.memory.add({ content: 'the ferry timetable is posted', kind: 'user_fact', source: 'user' });
    const first = await app.controller.runAction('cognition.run', {
      intent: 'read the ferry timetable', action: 'memory.search', input: { query: 'ferry timetable' },
    }, 'user');
    assert.equal(first.outcome, Outcome.SUCCESS_VERIFIED);
    const second = await app.controller.runAction('cognition.run', {
      intent: 'when was the ferry timetable posted', action: 'memory.search', input: { query: 'ferry timetable' },
    }, 'user');
    assert.equal(second.outcome, Outcome.SUCCESS_VERIFIED);
    const listed = await get(base, headers, '/api/memory/associations?limit=10');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.epistemicStatus, 'candidate_association');
    assert.equal(listed.body.authorizesExecution, false);
    assert.ok(listed.body.count >= 1);
    const recall = listed.body.recalls[0];
    assert.equal(recall.epistemicStatus, 'candidate_association');
    assert.match(recall.sourceRecordId, /^cog-/);
    assert.ok(recall.forIntent, 'the recall names the intent it was recalled for');
    assert.equal(Object.hasOwn(recall, 'permission'), false);
  });
});

describe('T-34 the briefing delta and its checkpoint', () => {
  test('with no checkpoint the answer is the honest sentence, not a wall of changes', async () => {
    const { base, headers } = await start();
    const view = await get(base, headers, '/api/briefing');
    assert.equal(view.status, 200);
    assert.equal(view.body.delta.available, false);
    assert.equal(view.body.delta.text, 'No prior briefing checkpoint recorded — showing full current state');
    assert.equal(view.body.delta.text, NO_PRIOR_CHECKPOINT);
    assert.deepEqual(view.body.delta.items, []);
  });

  test('acknowledging writes a verified checkpoint in the isolated data dir, and the delta then compares against it', async () => {
    const { app, dir, base, headers } = await start();
    const acknowledged = await post(base, headers, '/api/briefing/acknowledge', { reason: 'read the morning brief' });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.status, Outcome.SUCCESS_VERIFIED);
    const checkpointId = acknowledged.body.checkpoint.checkpointId;
    assert.match(checkpointId, /^bc-/);
    assert.equal(fs.existsSync(path.join(dir, 'briefing-checkpoints.jsonl')), true, 'the checkpoint lives in the isolated data dir');
    assert.equal(acknowledged.body.delta.available, true);
    assert.match(acknowledged.body.delta.text, /^Nothing has changed since the briefing you acknowledged at /);

    // The action is the governor's, not the route's: registered as a user-origin write.
    const definition = app.registry.get('briefing.acknowledge');
    assert.equal(definition.permission, 'write');
    assert.deepEqual(definition.origins, ['user']);

    // A change after the checkpoint shows up as a delta item that names the view and the task.
    const ran = await app.controller.runAction('cognition.run', {
      intent: 'read the briefing delta marker', action: 'memory.search', input: { query: 'briefing delta marker' },
    }, 'user');
    assert.equal(ran.outcome, Outcome.SUCCESS_VERIFIED);
    const after = await get(base, headers, '/api/briefing');
    assert.equal(after.body.delta.available, true);
    assert.equal(after.body.delta.checkpointId, checkpointId);
    assert.match(after.body.delta.text, /^Changes since the briefing you acknowledged at /);
    const item = after.body.delta.items.find((entry) => entry.kind === 'task_new' || entry.kind === 'task_status');
    assert.ok(item, 'the new task is in the delta');
    assert.equal(item.goto.view, 'missions');
    assert.match(item.goto.task, /^task-/);

    // A second acknowledgement makes that change history: the delta is empty again.
    const second = await post(base, headers, '/api/briefing/acknowledge', {});
    assert.equal(second.status, 200);
    assert.notEqual(second.body.checkpoint.checkpointId, checkpointId);
    assert.match(second.body.delta.text, /^Nothing has changed since the briefing you acknowledged at /);

    // The route validates its body and refuses an unknown field.
    const refused = await post(base, headers, '/api/briefing/acknowledge', { snapshot: 'mine' });
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.body), /unknown field/);
  });

  test('the delta is a comparison of readings: each kind of change has its own line and its own destination', () => {
    const prior = {
      at: '2026-11-19T00:00:00.000Z',
      id: 'bc-prior',
      snapshot: {
        taskStatuses: { 'task-a': 'paused' },
        taskCount: 1,
        advisories: ['workspace_dirty'],
        lastObservationAt: '2026-11-19T00:00:00.000Z',
        observedCount: 4,
        runStatuses: { 'cog-1': 'completed' },
        runCount: 1,
        workshopVerifications: 1,
        evolutionVerifications: 0,
        unavailable: [],
      },
    };
    const current = {
      taskStatuses: { 'task-a': 'completed', 'task-b': 'pending' },
      taskCount: 2,
      advisories: ['workspace_dirty', 'memory_pressure'],
      lastObservationAt: '2026-11-19T02:00:00.000Z',
      observedCount: 5,
      runStatuses: { 'cog-1': 'completed', 'cog-2': 'awaiting_approval' },
      runCount: 2,
      workshopVerifications: 3,
      evolutionVerifications: 1,
      unavailable: [],
    };
    const delta = briefingDelta({ prior, current });
    assert.equal(delta.available, true);
    assert.equal(delta.checkpointId, 'bc-prior');
    const kinds = delta.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['advisory', 'evolution', 'observation', 'task_new', 'task_status', 'workshop']);
    const statusChange = delta.items.find((item) => item.kind === 'task_status');
    assert.equal(statusChange.from, 'paused');
    assert.equal(statusChange.to, 'completed');
    assert.equal(statusChange.goto.task, 'task-a');
    assert.equal(delta.items.find((item) => item.kind === 'advisory').goto.view, 'sentinel');
    assert.equal(delta.items.find((item) => item.kind === 'workshop').goto.view, 'workshop');
    assert.deepEqual(delta.counts, { tasks: 2, advisories: 1, observations: 1, workshop: 1, evolution: 1 });
    // The same reading twice is no change at all, and it says that rather than showing zeros as news.
    const same = briefingDelta({ prior: { ...prior, snapshot: current }, current });
    assert.deepEqual(same.items, []);
    assert.match(same.text, /^Nothing has changed since the briefing you acknowledged at /);
  });
});

describe('T-34 the Sentinel reports the watch rules it actually ran', () => {
  test('every declared rule is listed with its threshold, and an unfired rule reports zero hits', async () => {
    const { app } = await start();
    const state = app.perception.state({ limit: 3 });
    const declared = state.watches.map((watch) => watch.alertClass).sort();
    assert.deepEqual(declared, ['degraded', 'load_pressure', 'memory_pressure', 'storage_pressure', 'workspace_dirty', 'workspace_unreadable']);
    for (const watch of state.watches) {
      assert.equal(watch.declared, true);
      assert.ok(typeof watch.threshold === 'string' && watch.threshold.length > 0, `${watch.alertClass} states its threshold`);
      assert.equal(watch.hits, 0, `${watch.alertClass} has not fired yet`);
      assert.equal(watch.lastTriggeredAt, null);
      assert.equal(watch.signature, null);
      assert.equal(watch.suppressed, false);
    }
    assert.equal(state.governor.budget.limit, 3);
    assert.equal(state.governor.budget.remaining, 3);
  });

  test('a rule that fires reports its signature, its hit count and when it last fired', async () => {
    const root = tempDir();
    const workspace = path.join(root, 'workspace');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 't34@apex.invalid'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T-34 fixture'], { stdio: 'ignore' });
    // A repository needs a HEAD for the sensor's git reading to be available at all, so the fixture
    // commits a file and then leaves an uncommitted change - exactly what the T-33 fixture does.
    fs.writeFileSync(path.join(workspace, 'watch.txt'), 'committed\n');
    execFileSync('git', ['-C', workspace, 'add', 'watch.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-34 fixture baseline'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(workspace, 'watch.txt'), 'committed\nuncommitted\n');
    const { app } = await start({ filesystemRoot: workspace });

    const sense = await app.controller.perceptionSense({ reason: 'T-34 watch report' });
    assert.equal(sense.status, Outcome.SUCCESS_VERIFIED);
    const state = app.perception.state({ limit: 3 });
    const dirty = state.watches.find((watch) => watch.alertClass === 'workspace_dirty');
    assert.ok(dirty.hits >= 1, 'the dirty-tree rule fired on a dirty tree');
    assert.ok(typeof dirty.signature === 'string' && dirty.signature.length > 0);
    assert.ok(dirty.lastTriggeredAt, 'the report says when it last fired');
    assert.ok(dirty.lastReason, 'and why the governor decided what it decided');
    assert.ok(dirty.threshold.includes('dirtyFiles') || dirty.threshold.includes('untrackedFiles'));
    const never = state.watches.filter((watch) => watch.hits === 0).map((watch) => watch.alertClass);
    assert.ok(never.length > 0, 'a rule that did not fire still reports zero rather than an invented count');
    // The budget the watch rules are disciplined by is the governor's own, not a copy of it.
    assert.ok(state.governor.budget.remaining <= 3);
  });
});
