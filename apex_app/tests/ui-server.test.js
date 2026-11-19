// The local browser interface. These tests drive the real HTTP server, the real controller,
// the real task and plan stores, and (for one case) the real `bin/apex-serve.js` process.
// No test performs inference: the app is assembled with NoBackend, so every answer comes from
// the deterministic path, and a green result here says nothing about model quality.
//
// What is asserted is the transport contract: the page and API are reachable only on loopback
// and only with the process token, a chat turn is exactly the controller call the CLI makes,
// the state view is read-only, and every write surface the page offers is the same user-origin
// controller method the CLI uses - never a second authorization path.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer, UI_LIMITS } from '../src/ui/server.js';
import { UI_CLIENT, UI_PAGE } from '../src/ui/assets.js';
import { Outcome } from '../src/outcomes.js';

const TOKEN = 'ui-test-token-0123456789abcdef';
const dirs = [];
const uis = [];
const children = [];

afterEach(async () => {
  while (children.length) {
    const child = children.pop();
    // A child terminated by a signal on Windows keeps exitCode null and reports signalCode
    // instead, so both are checked before waiting for an exit that already happened.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
  while (uis.length) {
    const ui = uis.pop();
    await ui.stop().catch(() => {});
  }
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function offlineApp(dir, options = {}) {
  return createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }), ...options });
}

async function uiOn(dir, options = {}) {
  const app = options.app ?? offlineApp(dir);
  const ui = createUiServer({
    app,
    token: options.token ?? TOKEN,
    host: '127.0.0.1',
    port: 0,
    ...(options.server ?? {}),
  });
  const started = await ui.start();
  uis.push(ui);
  return { app, ui, started, base: `http://127.0.0.1:${started.port}` };
}

function request(base, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.cookie) headers.cookie = options.cookie;
  const init = { method: options.method ?? 'GET', headers, redirect: options.redirect ?? 'manual' };
  if (options.body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  return fetch(`${base}${pathname}`, init);
}

// A POST the page itself would send: token in the cookie, the anti-CSRF header, JSON body.
function post(base, pathname, body = {}) {
  return request(base, pathname, {
    method: 'POST',
    bearer: TOKEN,
    headers: { 'x-apex-ui': '1' },
    body,
  });
}

async function json(response) {
  return JSON.parse(await response.text());
}

async function openStream(base, { query = '', bearer = TOKEN } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events${query}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    signal: controller.signal,
  });
  // Only an accepted stream carries SSE; a refusal is a JSON body the caller still has to read.
  const reader = response.status === 200 ? response.body?.getReader() ?? null : null;
  const received = { text: '' };
  const pump = reader
    ? (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received.text += decoder.decode(value, { stream: true });
      }
    })().catch(() => {})
    : Promise.resolve();
  return {
    response,
    received,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

async function waitFor(check, what, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('startup and authentication', () => {
  test('the server refuses a non-loopback host and a token that is too short', () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    assert.throws(() => createUiServer({ app, host: '0.0.0.0', token: TOKEN }), /loopback only/);
    assert.throws(() => createUiServer({ app, host: 'localhost', token: TOKEN }), /loopback only/);
    assert.throws(() => createUiServer({ app, token: 'short' }), /16-128/);
    assert.throws(() => createUiServer({ app, token: 'has spaces in it which is not allowed' }), /16-128/);
    assert.throws(() => createUiServer({}), /requires an APEX application/);
  });

  test('it binds loopback, prints a tokenized URL, and answers an unauthenticated health check', async () => {
    const dir = tempDir();
    const { ui, started, base } = await uiOn(dir);
    assert.equal(started.host, '127.0.0.1');
    assert.match(started.url, new RegExp(`^http://127\\.0\\.0\\.1:${started.port}/\\?token=[A-Za-z0-9_-]{16,128}$`));
    assert.equal(ui.server.address().address, '127.0.0.1');
    assert.equal(ui.stats().subscribers, 0);
    assert.equal(ui.stats().chatInFlight, false);

    const health = await request(base, '/healthz');
    assert.equal(health.status, 200);
    assert.equal((await json(health)).ok, true);
  });

  test('the page needs the token; the token becomes an HttpOnly, SameSite=Strict cookie', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);

    const anonymous = await request(base, '/');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /Bearer/);
    assert.equal(anonymous.headers.get('set-cookie'), null);

    const wrong = await request(base, '/?token=wrong-token-value-0000');
    assert.equal(wrong.status, 401);

    const login = await request(base, `/?token=${TOKEN}`);
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^apex_ui=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);

    const page = await request(base, '/', { cookie: cookie.split(';')[0] });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    const html = await page.text();
    assert.ok(html.includes('<h1>APEX</h1>'));
    assert.match(html, /loopback only/);

    const bearer = await request(base, '/', { bearer: TOKEN });
    assert.equal(bearer.status, 200, 'an Authorization header reaches the page too');
  });

  test('the page and client reference no remote origin and never build markup from text', async () => {
    for (const asset of [UI_PAGE, UI_CLIENT]) {
      assert.doesNotMatch(asset, /https?:\/\//i, 'the interface must not point at any remote origin');
      assert.doesNotMatch(asset, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    }
    assert.match(UI_CLIENT, /textContent/);
  });

  test('the API refuses a missing or wrong token and every request the page would not send', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);

    const anonymous = await request(base, '/api/state');
    assert.equal(anonymous.status, 401);
    assert.match((await json(anonymous)).error, /token/);

    const wrongToken = await request(base, '/api/state', { bearer: 'not-the-token-000000000000' });
    assert.equal(wrongToken.status, 401);

    const noHeader = await request(base, '/api/chat', { method: 'POST', bearer: TOKEN, body: { text: 'hello' } });
    assert.equal(noHeader.status, 403);
    assert.match((await json(noHeader)).error, /x-apex-ui/);

    const crossOrigin = await request(base, '/api/chat', {
      method: 'POST',
      bearer: TOKEN,
      headers: { 'x-apex-ui': '1', origin: 'http://example.invalid' },
      body: { text: 'hello' },
    });
    assert.equal(crossOrigin.status, 403);
    assert.match((await json(crossOrigin)).error, /cross-origin/);

    const notJson = await request(base, '/api/chat', {
      method: 'POST',
      bearer: TOKEN,
      headers: { 'x-apex-ui': '1', 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(notJson.status, 415);

    const unknownRoute = await request(base, '/api/nothing', { bearer: TOKEN });
    assert.equal(unknownRoute.status, 404);
  });
});

describe('a conversation through the page', () => {
  test('a chat turn is the controller call, and the state view shows the turns and session', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const { base } = await uiOn(dir, { app });

    // The fact is recorded through the same controller the page calls; a memory write's own
    // turn is redacted by the conversation store, which is why the page is then asked a
    // question rather than reading the write back out of the history.
    const seeded = await app.controller.handle('remember that the ui test colour is teal');
    assert.equal(seeded.status, Outcome.SUCCESS_VERIFIED, seeded.display);

    const asked = await post(base, '/api/chat', { text: 'what is the ui test colour?' });
    assert.equal(asked.status, 200);
    const first = await json(asked);
    assert.equal(first.status, Outcome.SUCCESS_DETERMINISTIC, first.display);
    assert.equal(first.verified, false, 'a deterministic answer is not reported as verified');
    assert.equal(first.timedOut, false);
    assert.ok(first.operation && typeof first.operation.id === 'string', 'the audit operation id is reported');
    assert.match(first.display, /teal/);

    const state = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.equal(state.session.status, 'ok');
    assert.match(state.session.id, /^[0-9a-f-]{36}$/);
    assert.equal(state.session.unavailable, null);
    assert.equal(state.turns.filter((t) => t.role === 'user').length, 2);
    assert.ok(state.turns.some((t) => t.role === 'user' && t.text.includes('colour')));
    // The recorded reply turn is the audited reading, which is deliberately content-free; the
    // answer text with the stored fact is in the display, not in the conversation log.
    const reply = state.turns.find((t) => t.role === 'apex' && t.origin === 'apex_notice');
    assert.ok(reply, 'the reply is a turn too');
    assert.ok(reply.text.length > 0);
    assert.equal(reply.verified, false, 'a deterministic reading is never stored as verified');
    assert.equal(state.limits.maxMessageChars, UI_LIMITS.maxMessageChars);
    assert.equal(state.limits.oneRequestAtATime, true);
    for (const turn of state.turns) {
      assert.ok(turn.at === null || !Number.isNaN(Date.parse(turn.at)), 'a turn timestamp is a date when present');
    }

    // A follow-up stays in the same session and is answered from the recorded fact: this is the
    // deterministic path, and its citation is in the text, not in a claim about a model.
    const followUp = await post(base, '/api/chat', { text: 'what colour did I just ask about?' });
    assert.equal(followUp.status, 200);
    const second = await json(followUp);
    assert.ok(['success_deterministic', 'model_unavailable'].includes(second.status), second.display);

    const after = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.equal(after.session.id, state.session.id, 'the session did not change between turns');
    assert.equal(after.turns.filter((t) => t.role === 'user').length, 3);
  });

  test('reading the state creates no store file and writes nothing', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const before = fs.readdirSync(dir).sort();
    const state = await request(base, '/api/state', { bearer: TOKEN });
    assert.equal(state.status, 200);
    await state.text();
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'a read-only view must not create state');
    assert.deepEqual(before, [], 'the fixture starts from an empty data directory');
  });

  test('a null conversation turn is reported as unavailable instead of crashing the state view', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    await app.session.current();
    app.conversation.transcript = async () => [null];
    const { base } = await uiOn(dir, { app });

    const state = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.deepEqual(state.turns, []);
    assert.match(state.session.unavailable, /invalid turn/);
  });

  test('a new session rotates the conversation without erasing the log', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const { base } = await uiOn(dir, { app });
    await app.controller.handle('remember that the ui test room is the east one');
    await (await post(base, '/api/chat', { text: 'is the east room recorded?' })).text();
    const before = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.ok(before.turns.filter((t) => t.role === 'user').length >= 1);

    const rotated = await post(base, '/api/session/new');
    assert.equal(rotated.status, 200);
    const result = await json(rotated);
    assert.equal(result.status, Outcome.SUCCESS_VERIFIED);
    assert.notEqual(result.session.id, before.session.id);

    const after = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.equal(after.session.id, result.session.id);
    assert.equal(after.turns.filter((t) => t.role === 'user').length, 0, 'the new session replays no earlier turn');
    assert.ok(fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8').includes('east room'),
      'the earlier turn stays in the conversation log');
  });

  test('only one chat runs at a time: a second request is refused while the first is in flight', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const handle = app.controller.handle.bind(app.controller);
    const controller = Object.create(app.controller);
    controller.handle = async (...args) => {
      await gate;
      return handle(...args);
    };
    const { ui, base } = await uiOn(dir, { app: { ...app, controller } });
    assert.equal(typeof controller.approveTask, 'function', 'the approval surface is inherited from the real controller');

    const first = post(base, '/api/chat', { text: 'remember that the ui test gate opened' });
    await waitFor(() => ui.stats().chatInFlight === true, 'the first chat to be in flight');

    const second = await post(base, '/api/chat', { text: 'a second message while the first runs' });
    assert.equal(second.status, 409);
    assert.match((await json(second)).error, /already running/);

    release();
    const answered = await first;
    assert.equal(answered.status, 200);
    assert.equal((await json(answered)).status, Outcome.SUCCESS_VERIFIED);
    assert.equal(ui.stats().chatInFlight, false);
  });

  test('the request bounds are enforced before anything reaches the controller', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);

    const empty = await post(base, '/api/chat', { text: '   ' });
    assert.equal(empty.status, 400);

    const missing = await post(base, '/api/chat', {});
    assert.equal(missing.status, 400);
    assert.match((await json(missing)).error, /text is required/);

    const wrongType = await post(base, '/api/chat', { text: 42 });
    assert.equal(wrongType.status, 400);

    const extra = await post(base, '/api/chat', { text: 'hello', tool: 'execute' });
    assert.equal(extra.status, 400);
    assert.match((await json(extra)).error, /unknown field: tool/);

    const arrayBody = await post(base, '/api/chat', ['hello']);
    assert.equal(arrayBody.status, 400);

    const invalidJson = await post(base, '/api/chat', '{"text":');
    assert.equal(invalidJson.status, 400);

    const tooLong = await post(base, '/api/chat', { text: 'x'.repeat(UI_LIMITS.maxMessageChars + 1) });
    assert.equal(tooLong.status, 413);
    assert.match((await json(tooLong)).error, /longer than 4000 characters/);

    const oversized = await post(base, '/api/chat', { text: 'x'.repeat(70 * 1024) });
    assert.equal(oversized.status, 413);
    assert.match((await json(oversized)).error, /too large/);
    assert.equal(oversized.headers.get('connection'), 'close', 'the refused body ends the connection');

    // The server is still healthy for the next request on a fresh connection.
    const state = await request(base, '/api/state', { bearer: TOKEN });
    assert.equal(state.status, 200);
    assert.equal((await json(state)).turns.length, 0, 'no refused request became a turn');
  });
});

describe('the approval surface reuses the controller', () => {
  function writeTask(taskId) {
    return {
      taskId,
      goal: 'store the review note',
      origin: 'model',
      planner: 'deterministic',
      steps: [{
        id: 'w1',
        description: 'store the review note',
        action: 'memory.add',
        permission: 'write',
        input: { content: 'the ui approval fixture note' },
        dependsOn: [],
      }],
      reason: 'recorded for the ui fixture',
    };
  }

  test('a paused task is visible, retry needs a step id, approve and cancel are the user-origin calls', async () => {
    const dir = tempDir();
    const { app, base } = await uiOn(dir);
    await app.taskStore.createTask(writeTask('ui-task-1'));
    // A task a model proposed starts as a proposal and is not runnable until the user approves
    // the plan; only then does its write step reach the approval pause this test is about.
    const planned = await app.controller.approveTask('ui-task-1');
    assert.equal(planned.status, Outcome.SUCCESS_VERIFIED, planned.display);
    const run = await app.controller.runTask('ui-task-1', 'run');
    assert.equal(run.status, Outcome.TASK_PAUSED, run.display);

    const state = await json(await request(base, '/api/state', { bearer: TOKEN }));
    const task = state.tasks.find((t) => t.id === 'ui-task-1');
    assert.ok(task, 'the paused task is listed');
    assert.equal(task.status, 'paused');
    assert.equal(task.steps[0].status, 'awaiting_approval');
    assert.equal(task.steps[0].permission, 'write');

    const steplessRetry = await post(base, '/api/tasks/ui-task-1/retry');
    assert.equal(steplessRetry.status, 400);
    assert.match((await json(steplessRetry)).error, /requires a stepId/);

    const badStep = await post(base, '/api/tasks/ui-task-1/approve', { stepId: 'not a step!' });
    assert.equal(badStep.status, 400);
    assert.match((await json(badStep)).error, /not a step id/);

    const stepCancel = await post(base, '/api/tasks/ui-task-1/cancel', { stepId: 'w1' });
    assert.equal(stepCancel.status, 400);
    assert.match((await json(stepCancel)).error, /does not take a stepId/);

    const approved = await post(base, '/api/tasks/ui-task-1/approve', { stepId: 'w1' });
    assert.equal(approved.status, 200);
    const approval = await json(approved);
    assert.equal(approval.status, Outcome.SUCCESS_VERIFIED, approval.display);
    assert.match(approval.display, /w1/);

    const recorded = await app.taskStore.get('ui-task-1');
    const step = recorded.steps.find((s) => s.id === 'w1');
    assert.equal(step.status, 'pending');
    assert.equal(step.approval?.approvedBy, 'user', 'the approval is recorded on the step, in the task log');
    assert.equal(typeof step.approval.inputSha256, 'string', 'the approval is bound to the step input');

    const cancelled = await post(base, '/api/tasks/ui-task-1/cancel');
    assert.equal(cancelled.status, 200);
    assert.match((await json(cancelled)).display, /Cancelled/);
    const after = await json(await request(base, '/api/state', { bearer: TOKEN }));
    assert.equal(after.tasks.find((t) => t.id === 'ui-task-1').status, 'cancelled');

    const unknown = await post(base, '/api/tasks/no-such-task/cancel');
    assert.equal(unknown.status, 200, 'a missing task is a refusal reported by the controller, not a transport error');
    assert.doesNotMatch((await json(unknown)).display, /^Cancelled$/);
  });

  test('a draft plan is approved through the same hash-bound record the CLI writes', async () => {
    const dir = tempDir();
    const { app, base } = await uiOn(dir);
    const created = await app.plans.createPlan({
      outcome: 'know which notes are already stored',
      steps: [{
        id: 's1',
        description: 'list the stored memory records',
        action: 'memory.list',
        input: {},
        dependsOn: [],
        expectedResult: 'the stored records are listed',
        verification: 'the listing matches the store',
        risk: 'low',
      }],
    });
    const planId = created.plan.id;

    const before = await json(await request(base, '/api/state', { bearer: TOKEN }));
    const draft = before.plans.find((p) => p.id === planId);
    assert.ok(draft, 'the draft plan is listed');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.approved, false);

    const approved = await post(base, `/api/plans/${planId}/approve`);
    assert.equal(approved.status, 200);
    const result = await json(approved);
    assert.equal(result.status, Outcome.PLAN_STORED, result.display);
    assert.match(result.display, /Approved plan/);

    const after = await json(await request(base, '/api/state', { bearer: TOKEN }));
    const stored = after.plans.find((p) => p.id === planId);
    assert.equal(stored.status, 'approved');
    assert.equal(stored.approved, true);

    const unknown = await post(base, '/api/plans/no-such-plan/approve');
    assert.equal(unknown.status, 200);
    assert.doesNotMatch((await json(unknown)).status, /^success_/);
  });
});

describe('objective planning through the page', () => {
  test('the page compiles and carries the planning panel without markup sinks', () => {
    assert.doesNotThrow(() => new Function(UI_CLIENT));
    assert.match(UI_PAGE, /id="planning-form"/);
    assert.match(UI_PAGE, /id="planning-objective"/);
    assert.match(UI_CLIENT, /renderPlanning/);
    assert.match(UI_CLIENT, /\/api\/planning/);
  });

  test('the planning read is the CLI call, is projected, and records nothing', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const { base } = await uiOn(dir, { app });

    const anonymous = await request(base, '/api/planning', {
      method: 'POST',
      headers: { 'x-apex-ui': '1' },
      body: { objective: 'remember the launch fact' },
    });
    assert.equal(anonymous.status, 401);

    const response = await post(base, '/api/planning', { objective: 'remember the launch fact; recall the build note' });
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.status, Outcome.SUCCESS_VERIFIED, payload.display);
    assert.equal(payload.planning.schema, 'apex.objective-planning.v1');
    assert.equal(payload.planning.recorded, false);
    assert.equal(payload.planning.approved, false);
    assert.equal(payload.planning.executable, false);
    assert.equal(payload.planning.objective.basis, 'user_stated');
    assert.deepEqual(payload.planning.tasks.map((task) => task.action), ['memory.add', 'memory.search']);
    assert.equal(payload.planning.tasks.every((task) => task.class === 'needs_approval'), true,
      'an unapproved proposal has no ready step, whatever the registry allows');
    assert.equal(payload.planning.counts.ready, 0);
    assert.match(payload.planning.feasibility, /wait on approval/);
    assert.equal(payload.planning.approval.required, true);
    assert.equal(payload.planning.approval.bound, false);

    const plans = await app.plans.list();
    assert.equal(plans.length, 0, 'the planning read records no plan');

    const missing = await post(base, '/api/planning', {});
    assert.equal(missing.status, 400);
    const extra = await post(base, '/api/planning', { objective: 'remember x', budget: 3 });
    assert.equal(extra.status, 400);
    const badGoal = await post(base, '/api/planning', { objective: 'remember x', goal: 7 });
    assert.equal(badGoal.status, 400);
  });

  test('a rejected objective is reported and recorded without a plan', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const { base } = await uiOn(dir, { app });

    const response = await post(base, '/api/planning', { objective: 'x'.repeat(501) });
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.planning, null);
    assert.match(payload.display, /input rejected/);
    assert.equal((await app.plans.list()).length, 0);
  });
});

describe('live updates', () => {
  test('the event stream greets, heartbeats, and refuses a ninth subscriber', async () => {
    const dir = tempDir();
    const { ui, base } = await uiOn(dir, { server: { heartbeatMs: 40 } });

    const first = await openStream(base, { query: `?token=${TOKEN}` });
    assert.equal(first.response.status, 200);
    assert.match(first.response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    assert.match(await waitFor(() => first.received.text, 'the hello event'), /event: hello/);
    assert.ok(await waitFor(() => first.received.text.includes(': ping'), 'a heartbeat'), 'the stream heartbeats while idle');

    const rest = [];
    for (let i = 1; i < UI_LIMITS.maxSubscribers; i += 1) {
      rest.push(await openStream(base));
    }
    assert.equal(ui.stats().subscribers, UI_LIMITS.maxSubscribers);

    const refused = await openStream(base);
    assert.equal(refused.response.status, 429);
    assert.match((await json(refused.response)).error, /too many event stream subscribers/);
    assert.equal(ui.stats().subscribers, UI_LIMITS.maxSubscribers);

    for (const stream of [first, ...rest, refused]) await stream.close();

    await waitFor(() => ui.stats().subscribers === 0, 'the closed streams to be released');
    const reopened = await openStream(base);
    assert.equal(reopened.response.status, 200, 'a freed slot is reusable');
    await reopened.close();
  });

  test('a chat broadcasts its completion to an open stream', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const stream = await openStream(base);
    await waitFor(() => /event: hello/.test(stream.received.text), 'the hello event');

    const answered = await post(base, '/api/chat', { text: 'remember that the ui test stream finished' });
    assert.equal(answered.status, 200);

    const frame = await waitFor(() => {
      const match = /event: chat\ndata: (\{[^\n]*\})/.exec(stream.received.text);
      return match ? match[1] : null;
    }, 'the chat event');
    const data = JSON.parse(frame);
    assert.equal(data.status, Outcome.SUCCESS_VERIFIED);
    assert.ok(typeof data.operationId === 'string');
    await stream.close();
  });

  test('progress events remain available alongside owner-state reconciliation', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const controller = Object.create(app.controller);
    controller.handle = async (_text, { onProgress } = {}) => {
      onProgress?.({ stage: 'model' });
      return {
        status: Outcome.SUCCESS_VERIFIED,
        display: 'the injected test controller completed',
        recorded: true,
        operation: { id: 'progress-test-operation', capability: 'test.progress' },
      };
    };
    const { base } = await uiOn(dir, { app: { ...app, controller } });
    const stream = await openStream(base);
    await waitFor(() => /event: reconcile/.test(stream.received.text), 'the initial owner reconciliation');

    const answered = await post(base, '/api/chat', { text: 'exercise the transient progress callback' });
    assert.equal(answered.status, 200);
    const progress = await waitFor(() => {
      const match = /event: progress\ndata: (\{[^\n]*\})/.exec(stream.received.text);
      return match ? JSON.parse(match[1]) : null;
    }, 'the transient progress event');
    assert.equal(progress.stage, 'model');
    const chat = await waitFor(() => /event: chat\ndata: /.test(stream.received.text), 'the completion chat event');
    assert.ok(chat);
    assert.ok(stream.received.text.indexOf('event: progress') < stream.received.text.indexOf('event: chat'));
    await stream.close();
  });
});

describe('the launcher', () => {
  test('bin/apex-serve.js starts loopback, prints the tokenized URL, and stops on a signal', async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex-serve.js')], {
      env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, APEX_UI_PORT: '0' }),
      windowsHide: true,
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const url = await waitFor(() => {
      const match = /Open: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{16,128})/.exec(stdout);
      return match ? match[1] : null;
    }, `the launcher to print its URL (stdout: ${stdout} stderr: ${stderr})`, 20000);
    assert.match(stdout, /loopback only/);
    assert.match(stdout, /Data directory:/);
    assert.match(stdout, /none configured/, 'no model endpoint is configured for this process');
    assert.match(stdout, /Ctrl\+C/);
    assert.equal(stderr, '');

    const health = await fetch(new URL('/healthz', url));
    assert.equal(health.status, 200);
    const page = await fetch(url, { redirect: 'manual' });
    assert.equal(page.status, 303);

    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the launcher process ended');
    // Windows does not deliver SIGTERM to a JavaScript handler: terminating the process is the
    // whole effect there, so the shutdown line is only claimed where a signal is delivered.
    if (process.platform !== 'win32') assert.match(stdout, /stopped/, 'the launcher reports the stop after the signal');
  });
});


describe('Workshop API integration', () => {
  test('compose, list and simulate use the authenticated controller/ECP path', async () => {
    const dir = tempDir();
    const app = offlineApp(dir);
    const { base } = await uiOn(dir, { app });
    const design = {
      title: 'UI integration fixture',
      domain: 'plan',
      components: [
        { id: 'source', kind: 'service', supply: 8, demand: 0, cost: 2 },
        { id: 'sink', kind: 'database', supply: 0, demand: 4, cost: 1 },
      ],
      connections: [{ from: 'source', to: 'sink' }],
      budget: { total: 5 },
      note: 'isolated test fixture',
    };

    const unauthenticated = await request(base, '/api/workshop');
    assert.equal(unauthenticated.status, 401);

    const composed = await post(base, '/api/workshop/compose', design);
    assert.equal(composed.status, 200);
    const created = await json(composed);
    assert.equal(created.status, 'success_verified');
    assert.equal(created.authorizesExecution, false);
    assert.equal(created.executedCode, false);
    assert.match(created.artifactId, /^ws-/);

    const listed = await request(base, '/api/workshop', { bearer: TOKEN });
    assert.equal(listed.status, 200);
    const page = await json(listed);
    assert.equal(page.total, 1);
    assert.equal(page.artifacts[0].artifactId, created.artifactId);
    assert.equal(page.status.chain, 'intact');
    assert.equal(page.authorizesExecution, false);

    const simulated = await post(base, '/api/workshop/simulate', { artifactId: created.artifactId });
    assert.equal(simulated.status, 200);
    const report = await json(simulated);
    assert.equal(report.status, 'success_verified');
    assert.equal(report.authorizesExecution, false);
    assert.equal(report.executedCode, false);
    assert.equal(report.components.find((component) => component.id === 'sink').inbound, 8);

    const after = await json(await request(base, '/api/workshop', { bearer: TOKEN }));
    assert.equal(after.total, 1, 'simulation must not append or mutate workshop history');
  });

  test('Workshop API rejects unknown fields, malformed shapes and missing artifacts', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const unknown = await post(base, '/api/workshop/compose', {
      title: 'bad', components: [], privileged: true,
    });
    assert.equal(unknown.status, 400);
    assert.match((await json(unknown)).error, /unknown field/);

    const invalid = await post(base, '/api/workshop/compose', {
      title: 'bad', components: [{ id: 'x', kind: 'service', supply: 'unbounded' }],
    });
    assert.equal(invalid.status, 400);

    const missing = await post(base, '/api/workshop/simulate', { artifactId: 'ws-does-not-exist' });
    assert.equal(missing.status, 400);
  });

  test('Workshop API keeps the anti-CSRF and JSON transport requirements', async () => {
    const dir = tempDir();
    const { base } = await uiOn(dir);
    const noCsrf = await request(base, '/api/workshop/compose', {
      method: 'POST', bearer: TOKEN, body: { title: 'blocked', components: [] },
    });
    assert.equal(noCsrf.status, 403);

    const notJson = await request(base, '/api/workshop/compose', {
      method: 'POST', bearer: TOKEN,
      headers: { 'x-apex-ui': '1', 'content-type': 'text/plain' },
      body: 'not json',
    });
    assert.equal(notJson.status, 415);
  });
});
