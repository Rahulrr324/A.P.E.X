// T-44 Package 2 (2026-11-19): the unified executive agenda.
//
// Two things are worth testing here, and they are different kinds of claim.
//
//   * The **horizon** is arithmetic, so it is tested against a pinned clock: a commitment due three days
//     ago is overdue and a completed one is not, whatever its date. Testing it against the wall clock
//     would make the test pass or fail depending on when it ran.
//   * The **derived items** are readings of stores the agenda does not own. So they are tested by writing
//     to those stores and proving the agenda reports what is there - and by proving it wrote nothing.
//     A derived item the agenda had copied would keep saying a mission was running after it finished.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { buildUnifiedAgenda, horizonFor, HORIZON_BUCKETS } from '../src/executive/agenda.js';
import { routeLine } from '../src/cognition/command-router.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already gone */ }
  }
});

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

function at(offsetMs) {
  return new Date(NOW + offsetMs).toISOString();
}

// ------------------------------------------------------------------------------------ the horizon ---

describe('T-44 agenda: the horizon arithmetic', () => {
  test('the six buckets are decided in one order, and the terminal states win', () => {
    const base = { dueAt: at(-10 * DAY) };
    assert.equal(horizonFor({ ...base, status: 'pending' }, NOW), 'overdue');
    assert.equal(horizonFor({ ...base, status: 'completed' }, NOW), 'completed',
      'a completed item is not overdue however old its due date is');
    assert.equal(horizonFor({ ...base, status: 'dismissed' }, NOW), 'dismissed');
    assert.equal(horizonFor({ dueAt: at(-1), status: 'pending' }, NOW), 'overdue', 'one millisecond late is late');
    assert.equal(horizonFor({ dueAt: at(0), status: 'pending' }, NOW), 'today', 'due now is today, not overdue');
    assert.equal(horizonFor({ dueAt: at(DAY), status: 'pending' }, NOW), 'today', 'exactly 24h is today');
    assert.equal(horizonFor({ dueAt: at(DAY + 1), status: 'pending' }, NOW), 'upcoming');
    assert.equal(horizonFor({ dueAt: null, status: 'pending' }, NOW), 'unscheduled');
    // Every answer is a declared bucket: a horizon the panel does not know how to paint would be a card
    // with no colour.
    for (const due of [at(-DAY), at(0), at(DAY * 3), null]) {
      assert.ok(HORIZON_BUCKETS.includes(horizonFor({ dueAt: due, status: 'pending' }, NOW)));
    }
  });

  test('the counts and the cards agree on a pinned clock', async () => {
    const app = createApp({ dataDir: tempDir() });
    const agenda = app.agenda;
    // A clock the engine reads directly, so the fixture dates and the evaluation instant are the same.
    const pinned = new (Object.getPrototypeOf(agenda).constructor)({
      dataDir: app.dataDir,
      now: () => new Date(NOW),
    });
    pinned.create({ title: 'late', dueAt: at(-3 * DAY) });
    pinned.create({ title: 'due today', dueAt: at(2 * HOUR) });
    pinned.create({ title: 'later', dueAt: at(5 * DAY) });
    pinned.create({ title: 'someday' });
    const done = pinned.create({ title: 'done thing', dueAt: at(-30 * DAY) });
    pinned.complete(done.itemId);
    const dropped = pinned.create({ title: 'dropped thing' });
    pinned.dismiss(dropped.itemId);

    const view = await pinned.build();
    assert.equal(view.summary.totalCommitments, 6);
    assert.equal(view.summary.overdueCount, 1, 'the completed one is not overdue');
    assert.equal(view.summary.todayCount, 1);
    assert.equal(view.summary.upcomingCount, 1);
    assert.equal(view.summary.unscheduledCount, 1);
    assert.equal(view.summary.completedCount, 1);
    assert.equal(view.summary.dismissedCount, 1);
    const counted = view.summary.overdueCount + view.summary.todayCount + view.summary.upcomingCount
      + view.summary.unscheduledCount + view.summary.completedCount + view.summary.dismissedCount;
    assert.equal(counted, view.summary.totalCommitments, 'every item is in exactly one bucket');
    // The order is horizon first: what is late outranks what is due today.
    assert.deepEqual(view.items.map((item) => item.horizonBucket),
      ['overdue', 'today', 'upcoming', 'unscheduled', 'completed', 'dismissed']);
  });

  test('the pure builder takes already-read inputs and writes nothing', () => {
    const commitments = [
      { itemId: 'ag_1', title: 'late', status: 'pending', priority: 'high', dueAt: at(-HOUR), category: 'commitment' },
      { itemId: 'ag_2', title: 'today', status: 'pending', priority: 'critical', dueAt: at(HOUR), category: 'focus_block' },
    ];
    const view = buildUnifiedAgenda({
      now: new Date(NOW),
      commitments,
      tasks: [{ id: 't1', goal: 'a mission', status: 'running' }],
      approvals: [{ id: 'p1', kind: 'proposal', summary: 'a change' }],
      advisories: [{ alertClass: 'storage_pressure', signature: 'sig-1', severity: 'critical' }],
      standingOrders: [{ orderId: 'so_1', title: 'armed', enabled: true, action: { capabilityId: 'system.doctor' }, trigger: { eventType: 'session_start' } }],
      workshopCandidates: [{ candidateId: 'cand_1', relativePath: 'a.txt', verdict: 'pass' }],
    });
    assert.equal(view.summary.overdueCount, 1);
    assert.equal(view.summary.todayCount, 1);
    assert.equal(view.summary.derivedActionCount, 2, 'the approval and the candidate both need an act');
    assert.equal(view.derivedItems.length, 5);
    const sources = view.derivedItems.map((item) => item.source).sort();
    assert.deepEqual(sources, ['approval_gate', 'sentinel', 'standing_order', 'taskgraph', 'workshop']);
    for (const item of view.derivedItems) assert.equal(item.readOnly, true, 'a derived item is a reading');
  });
});

// ------------------------------------------------------------------------------------ the ledger ---

describe('T-44 agenda: commitments', () => {
  test('create, complete and dismiss move the item and nothing else', async () => {
    const app = createApp({ dataDir: tempDir() });
    const agenda = app.agenda;
    const item = agenda.create({ title: 'Review phase 2 telemetry', priority: 'high', category: 'follow_up' });
    assert.match(item.itemId, /^ag_[0-9a-f]{16}$/);
    assert.equal(item.status, 'pending');
    assert.equal(item.completedAt, null);
    assert.equal(item.verified, true);

    const completed = agenda.complete(item.itemId);
    assert.equal(completed.status, 'completed');
    assert.ok(typeof completed.completedAt === 'string' && !Number.isNaN(Date.parse(completed.completedAt)));

    // A second completion is idempotent and does not move the date: the completion date is a fact.
    const again = agenda.complete(item.itemId);
    assert.equal(again.completedAt, completed.completedAt);
    assert.equal(again.already, true);

    const other = agenda.create({ title: 'Something else' });
    const dismissed = agenda.dismiss(other.itemId);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal(dismissed.completedAt, null, 'a dismissal is not a completion');

    // A completed item can still be dismissed: an owner who completed something by mistake and then
    // decided it should not count gets the state they asked for.
    const redone = agenda.dismiss(item.itemId);
    assert.equal(redone.status, 'dismissed');
    assert.equal(redone.completedAt, null, 'moving to dismissed clears the completion date rather than keeping a claim that it was done');
  });

  test('a bad category, priority or date is refused rather than stored and rendered', () => {
    const app = createApp({ dataDir: tempDir() });
    assert.throws(() => app.agenda.create({ title: 'x', category: 'someday' }),
      (err) => err.code === 'AGENDA_INVALID_INPUT' && err.status === 400);
    assert.throws(() => app.agenda.create({ title: 'x', priority: 'urgent' }),
      (err) => err.code === 'AGENDA_INVALID_INPUT' && err.status === 400);
    assert.throws(() => app.agenda.create({ title: 'x', dueAt: 'next tuesday' }),
      (err) => err.code === 'AGENDA_INVALID_INPUT' && err.status === 400);
    assert.throws(() => app.agenda.create({ title: '   ' }),
      (err) => err.code === 'AGENDA_INVALID_INPUT' && err.status === 400);
    assert.throws(() => app.agenda.complete('ag_missing'),
      (err) => err.code === 'AGENDA_ITEM_NOT_FOUND' && err.status === 404);
    assert.throws(() => app.agenda.dismiss('ag_missing'),
      (err) => err.code === 'AGENDA_ITEM_NOT_FOUND' && err.status === 404);
  });

  test('a linked artifact id is stored and is what the trace follows', async () => {
    const app = createApp({ dataDir: tempDir(), filesystemRoot: tempDir() });
    const order = app.standingOrders.create({
      title: 'a reading when dirty', eventType: 'workspace_dirty', capabilityId: 'system.inspect_ports',
    });
    const item = app.agenda.create({
      title: 'Follow up on the standing order', linkedArtifactId: order.orderId, priority: 'high',
    });
    assert.equal(item.linkedArtifactId, order.orderId);

    const byItem = await app.memoryTrace.trace(item.itemId);
    assert.equal(byItem.ok, true);
    assert.ok(byItem.entries.some((e) => e.kind === 'agenda_item' && e.detail.itemId === item.itemId));
    assert.ok(byItem.entries.some((e) => e.kind === 'standing_order' && e.detail.orderId === order.orderId),
      'a commitment opened on a standing order reaches that order');

    const byOrder = await app.memoryTrace.trace(order.orderId);
    assert.equal(byOrder.ok, true);
    assert.ok(byOrder.entries.some((e) => e.kind === 'agenda_item' && e.detail.itemId === item.itemId),
      'and the standing order reaches the commitment that is about it');
  });
});

// ------------------------------------------------------------------------------------ the derived ---

describe('T-44 agenda: derived items are readings, never copies', () => {
  test('an enabled standing order appears as a derived item and a paused one does not', async () => {
    const app = createApp({ dataDir: tempDir() });
    const armed = app.standingOrders.create({
      title: 'armed reading', eventType: 'session_start', capabilityId: 'system.doctor',
    });
    const paused = app.standingOrders.create({
      title: 'paused reading', eventType: 'session_start', capabilityId: 'system.inspect_ports',
    });
    app.standingOrders.toggle(paused.orderId, { enabled: false });

    const view = await app.agenda.build();
    const orders = view.derivedItems.filter((item) => item.source === 'standing_order');
    assert.equal(orders.length, 1, 'only the armed order is outstanding');
    assert.equal(orders[0].linkedArtifactId, armed.orderId);
    assert.equal(orders[0].horizonBucket, 'standing');
    assert.equal(view.summary.armedOrderCount, 1);

    // The reading is live: pausing the armed one removes it without the agenda being written. There is
    // no ledger file at all yet - an agenda nobody has written to - and building the view must not
    // create one, because a read that creates its own store is a read with a side effect.
    const ledgerPath = path.join(app.dataDir, 'executive-agenda.json');
    assert.equal(fs.existsSync(ledgerPath), false, 'reading the agenda must not create its ledger');
    app.standingOrders.toggle(armed.orderId, { enabled: false });
    const after = await app.agenda.build();
    assert.equal(after.derivedItems.filter((item) => item.source === 'standing_order').length, 0);
    assert.equal(fs.existsSync(ledgerPath), false, 'and still must not');
  });

  test('a stored commitment is not duplicated as a derived item, and a derived item cannot be settled', async () => {
    const app = createApp({ dataDir: tempDir() });
    app.agenda.create({ title: 'a real commitment' });
    const view = await app.agenda.build();
    assert.equal(view.derivedItems.length, 0, 'nothing in this build is outstanding in another store');
    assert.equal(view.items.length, 1);
    // There is no route or method that settles a derived item, because there is no row to settle.
    assert.throws(() => app.agenda.complete('dv_order_so_whatever'),
      (err) => err.code === 'AGENDA_ITEM_NOT_FOUND');
  });

  test('the build reports each source it read, so a missing family is not rendered as nothing pending', async () => {
    const app = createApp({ dataDir: tempDir() });
    const view = await app.agenda.build();
    assert.deepEqual(view.sources, {
      approvals: 'read', missions: 'read', advisories: 'read', standingOrders: 'read', workshopCandidates: 'read',
    });
    // A source that throws is reported as failed, and the commitments are still returned.
    const { ExecutiveAgenda } = await import('../src/executive/agenda.js');
    const broken = new ExecutiveAgenda({
      dataDir: tempDir(),
      approvals: async () => { throw new Error('the proposal store is unreadable'); },
      standingOrders: async () => [{ orderId: 'so_1', title: 'still armed', enabled: true, action: {}, trigger: {} }],
    });
    broken.create({ title: 'my commitment' });
    const brokenView = await broken.build();
    assert.equal(brokenView.sources.approvals, 'failed');
    assert.equal(brokenView.sources.standingOrders, 'read');
    assert.equal(brokenView.items.length, 1, 'a failed reading must not cost the owner their own commitments');
    assert.equal(brokenView.derivedItems.length, 1);
  });

  test('Lockdown refuses every write and still allows the read, so the latch is visible', async () => {
    const app = createApp({ dataDir: tempDir() });
    const item = app.agenda.create({ title: 'before the latch' });
    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-44 agenda probe' });
    try {
      await assert.rejects(async () => app.agenda.create({ title: 'during the latch' }),
        (err) => err.code === 'LOCKDOWN_ACTIVE' && err.status === 423);
      assert.throws(() => app.agenda.complete(item.itemId), (err) => err.status === 423);
      assert.throws(() => app.agenda.dismiss(item.itemId), (err) => err.status === 423);
      const view = await app.agenda.build();
      assert.equal(view.lockdownActive, true);
      assert.equal(view.items.length, 1, 'the read still works, and it says the latch is up');
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'probe complete' });
    }
  });
});

// ------------------------------------------------------------------------------------- the router ---

describe('T-44 agenda: the command grammar', () => {
  test('the five lines route by literal match, and an empty argument is refused rather than guessed', () => {
    assert.deepEqual(
      (({ kind, action, targetView }) => ({ kind, action, targetView }))(routeLine('schedule review phase 2 telemetry')),
      { kind: 'agenda', action: 'agenda.create', targetView: 'briefing' },
    );
    assert.equal(routeLine('remind me to call the supplier').argument, 'call the supplier');
    assert.equal(routeLine('schedule review phase 2 telemetry').argument, 'review phase 2 telemetry');
    assert.equal(routeLine('Schedule Review Phase 2').kind, 'agenda', 'matching folds case');
    const shown = routeLine('show agenda');
    assert.equal(shown.kind, 'agenda');
    assert.equal(shown.route, '/api/agenda');
    assert.equal(shown.targetView, 'briefing');
    const orders = routeLine('standing orders');
    assert.equal(orders.kind, 'standing_order');
    assert.equal(orders.route, '/api/standing-orders');
    assert.equal(orders.targetView, 'policy-autonomy');
    // The matcher's rule, stated as a test so a reader can check it: a phrase matches when the line IS
    // the phrase or BEGINS with it followed by a separator - never when it merely contains it. A prefix
    // matches only at the start. Both halves matter, and both are tested here.
    assert.notEqual(routeLine('do not schedule anything').kind, 'agenda',
      'a line that merely contains the word must not write a commitment');
    assert.notEqual(routeLine('the standing orders').kind, 'standing_order',
      'the phrase must be at the start, not merely present');
    // And the documented consequence of the rule, which every existing phrase shares: `git status is
    // fine` already routes to git, so a phrase followed by a separator is the command with a remark.
    assert.equal(routeLine('standing orders are a good idea').kind, 'standing_order');
  });

  test('dispatching a schedule line writes a commitment and says so in its receipt', async () => {
    const app = createApp({ dataDir: tempDir() });
    // The composed router, through the same `dispatch` the command route calls. A receipt is the answer
    // to a command, so this asserts the receipt rather than the ledger: the ledger is asserted above.
    const receipt = await app.commandRouter.dispatch('schedule review phase 2 telemetry');
    assert.equal(receipt.routeKind, 'agenda');
    assert.equal(receipt.actionInvoked, 'agenda.create');
    assert.equal(receipt.target, '#briefing-agenda-panel');
    assert.equal(receipt.verified, true, receipt.summary);
    assert.match(receipt.summary, /Scheduled: review phase 2 telemetry/);
    assert.match(receipt.result.itemId, /^ag_/);
    assert.equal(receipt.authorizesExecution, false, 'a dispatch is a routing decision, never an authorization');
    // And the commitment is really in the ledger, with the title the owner typed.
    const view = await app.agenda.build();
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].title, 'review phase 2 telemetry');

    // The three read lines answer with a route rather than an action, and say so.
    for (const [line, kind, route, target] of [
      ['show agenda', 'agenda', '/api/agenda', '#briefing-agenda-panel'],
      ['remind me to call the supplier', 'agenda', null, '#briefing-agenda-panel'],
      ['standing orders', 'standing_order', '/api/standing-orders', '#standing-orders-panel'],
    ]) {
      const result = await app.commandRouter.dispatch(line);
      assert.equal(result.routeKind, kind, line);
      if (route === null) {
        assert.equal(result.actionInvoked, 'agenda.create', 'a remind line writes a commitment');
        assert.match(result.summary, /Scheduled: call the supplier/);
      } else {
        assert.equal(result.route, route, line);
        assert.equal(result.actionInvoked, null, 'a refresh invokes no capability');
      }
      assert.equal(result.target, target, line);
    }

    // An empty argument is refused with the syntax, not with a generated title.
    const bare = await app.commandRouter.dispatch('schedule');
    assert.equal(bare.routeKind, 'agenda');
    assert.equal(bare.actionInvoked, null);
    assert.match(bare.summary, /Say what to schedule/);
    // Two, not three: `show agenda` and `standing orders` are reads, so only the schedule line and the
    // remind line wrote anything. An empty-argument schedule wrote nothing at all.
    assert.equal((await app.agenda.build()).items.length, 2, 'only the two real commitments were written');
  });
});

// ------------------------------------------------------------------------------------ the routes ---

describe('T-44 agenda: the HTTP surface', () => {
  const TOKEN = 'tok_t44_agenda_http_01';
  const servers = [];
  afterEach(async () => {
    while (servers.length) await servers.pop().stop().catch(() => {});
  });

  async function serve(app) {
    const server = createUiServer({ app, token: TOKEN, port: 0 });
    servers.push(server);
    const started = await server.start();
    const base = `http://127.0.0.1:${started.port}`;
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
    return {
      get: async (url) => {
        const res = await fetch(base + url, { headers });
        return { status: res.status, body: await res.json() };
      },
      post: async (url, body = {}) => {
        const res = await fetch(base + url, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      },
    };
  }

  test('GET answers 200 with the whole shape on a rooted and a rootless build', async () => {
    for (const root of [tempDir(), null]) {
      const http = await serve(createApp({ dataDir: tempDir(), filesystemRoot: root }));
      const result = await http.get('/api/agenda');
      assert.equal(result.status, 200, 'the agenda must never be a server fault, with or without a root');
      assert.equal(result.body.verified, true);
      assert.ok(Array.isArray(result.body.items));
      assert.ok(Array.isArray(result.body.derivedItems));
      for (const key of ['totalCommitments', 'overdueCount', 'todayCount', 'upcomingCount',
        'unscheduledCount', 'completedCount', 'derivedActionCount']) {
        assert.equal(typeof result.body.summary[key], 'number', `the summary must carry ${key}`);
      }
    }
  });

  test('the three POSTs answer 200, 404 and 423 by what actually happened', async () => {
    const app = createApp({ dataDir: tempDir() });
    const http = await serve(app);
    const created = await http.post('/api/agenda', { title: 'a commitment', priority: 'high' });
    assert.equal(created.status, 200);
    assert.match(created.body.itemId, /^ag_/);

    const completed = await http.post(`/api/agenda/${created.body.itemId}/complete`);
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');
    assert.ok(completed.body.completedAt);

    const other = await http.post('/api/agenda', { title: 'another' });
    const dismissed = await http.post(`/api/agenda/${other.body.itemId}/dismiss`);
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.status, 'dismissed');

    assert.equal((await http.post('/api/agenda/ag_missing/complete')).status, 404);
    assert.equal((await http.post('/api/agenda/ag_missing/dismiss')).status, 404);
    assert.equal((await http.post('/api/agenda', { title: 'x', priority: 'nope' })).status, 400);
    assert.equal((await http.post('/api/agenda', { title: 'x', unknownField: 1 })).status, 400);

    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-44 agenda route probe' });
    try {
      assert.equal((await http.get('/api/agenda')).status, 200, 'the read still answers, and reports the latch');
      for (const [url, body] of [
        ['/api/agenda', { title: 'during the latch' }],
        [`/api/agenda/${other.body.itemId}/complete`, {}],
        [`/api/agenda/${other.body.itemId}/dismiss`, {}],
      ]) {
        const result = await http.post(url, body);
        assert.equal(result.status, 423, `${url} must be 423 under Lockdown`);
        assert.equal(result.body.code, 'LOCKDOWN_ACTIVE');
      }
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'probe complete' });
    }
  });
});
