// T-29 (2026-11-19): the cognitive pipeline through the HTTP surface the Command Deck uses,
// plus the served client rendering the five-stage trace and reacting to the authoritative
// `cognition` event.
//
// The client half runs the exact string the server ships (`UI_CLIENT`) inside a vm with a fake
// browser. That is not a browser and is not reported as one: it proves the script assembles,
// renders five stages from the run record, offers an approval control only when the run says a
// step is waiting, and POSTs that approval to the route the server exposes.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createUiServer, UI_LIMITS } from '../src/ui/server.js';
import { UI_CLIENT } from '../src/ui/assets.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const TOKEN = 'ui-cognition-token-0123456789';
const dirs = [];
const uis = [];

afterEach(async () => {
  while (uis.length) await uis.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

async function uiOn() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  await app.memory.add({ content: 'the launch checklist covers the staging migration', kind: 'user_fact', source: 'user' });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0, ownerPollMs: 50, heartbeatMs: UI_LIMITS.heartbeatMs });
  const started = await ui.start();
  uis.push(ui);
  return { app, dir, base: `http://127.0.0.1:${started.port}` };
}

function auth(method = 'GET', body) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

async function jsonAt(base, path) {
  const response = await fetch(`${base}${path}`, auth());
  return { status: response.status, body: await response.json() };
}

async function send(base, path, body) {
  const response = await fetch(`${base}${path}`, auth('POST', body));
  return { status: response.status, body: await response.json() };
}

async function openStream(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal });
  const received = { text: '' };
  const reader = response.body?.getReader() ?? null;
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
  return { received, close: async () => { controller.abort(); await pump; } };
}

function frames(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    let event = null;
    let data = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event || data === null) return [];
    try { return [{ event, payload: JSON.parse(data) }]; } catch { return []; }
  });
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

describe('T-29 routes: /api/cognition/run and /api/cognition/runs', () => {
  test('an empty trace is reported as empty, with the five stage names and no execution claim', async () => {
    const { base } = await uiOn();
    const { status, body } = await jsonAt(base, '/api/cognition/runs');
    assert.equal(status, 200);
    assert.deepEqual(body.runs, []);
    assert.deepEqual(body.stages, ['context', 'salience', 'council', 'task_graph', 'execution']);
    assert.equal(body.authorizesExecution, false);
  });

  test('a read-only run completes through the capability and is readable again by id', async () => {
    const { base } = await uiOn();
    const started = await send(base, '/api/cognition/run', { intent: 'what does memory hold about the launch checklist' });
    assert.equal(started.status, 200);
    assert.equal(started.body.runStatus, 'completed');
    assert.equal(started.body.run.stages.context.memory.count >= 1, true);

    const reread = await jsonAt(base, `/api/cognition/runs/${encodeURIComponent(started.body.run.runId)}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.run.status, 'completed');
    assert.equal(reread.body.run.verification.verified, true);
  });

  test('a write run pauses, and only the approval route executes it', async () => {
    const { app, base } = await uiOn();
    const started = await send(base, '/api/cognition/run', {
      intent: 'remember the release window is zulu9c1',
      action: 'memory.add',
      input: { content: 'the release window is zulu9c1' },
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runStatus, 'awaiting_approval');
    assert.deepEqual(started.body.run.approval.waitingSteps, ['s1']);
    assert.equal((await app.memory.search('zulu9c1')).length, 0, 'nothing executed while awaiting approval');

    const approved = await send(base, `/api/cognition/runs/${encodeURIComponent(started.body.run.runId)}/approve`, { stepId: 's1' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.runStatus, 'completed');
    assert.equal(approved.body.run.approval.recorded.approvedBy, 'user');
    assert.equal((await app.memory.search('zulu9c1')).length, 1, 'the approved step executed');

    const again = await send(base, `/api/cognition/runs/${encodeURIComponent(started.body.run.runId)}/approve`, { stepId: 's1' });
    assert.equal(again.status, 409, 'a completed run has nothing awaiting approval');
  });

  test('the run route refuses a malformed request and an unknown run id', async () => {
    const { base } = await uiOn();
    assert.equal((await send(base, '/api/cognition/run', { intent: '' })).status, 400);
    assert.equal((await send(base, '/api/cognition/run', { intent: 'x', surprise: 1 })).status, 400);
    assert.equal((await jsonAt(base, '/api/cognition/runs/cog-notarealrun')).status, 404);
    assert.equal((await jsonAt(base, '/api/cognition/runs/cog-BAD!id')).status, 400);
  });

  test('the authoritative stream carries the cognition transition the client follows', async () => {
    const { base } = await uiOn();
    const stream = await openStream(base);
    await waitFor(() => frames(stream.received.text).some((frame) => frame.event === 'reconcile'), 'the initial reconcile');
    await send(base, '/api/cognition/run', { intent: 'what does memory hold about the launch checklist' });
    const event = await waitFor(() => frames(stream.received.text).find((frame) => frame.event === 'cognition'), 'the cognition event');
    assert.equal(typeof event.payload.runId, 'string');
    assert.equal(event.payload.status, 'completed');
    await stream.close();
  });
});

describe('T-29 client: the served script renders the trace', () => {
  const run = {
    schema: 'apex.cognition.run/1',
    runId: 'cog-clientsmoke00001',
    at: '2026-11-19T10:00:00.000Z',
    intent: 'what does memory hold about the launch checklist',
    status: 'completed',
    action: { name: 'memory.search', permission: 'read', risk: 'low', description: 'Search personal memory by keyword. Read-only.' },
    stages: {
      context: {
        schema: 'apex.cognition.context/1',
        intent: 'what does memory hold about the launch checklist',
        owner: { activeGoals: [{ id: 'g1', title: 'ship the release', progress: 0.5 }], goalCount: 1, principal: 'local-user-origin' },
        memory: { count: 2, items: [{ id: 'm1', content: 'the launch checklist', kind: 'user_fact', at: null, source: 'user' }] },
        knowledge: { count: 1, items: [{ id: 'k1', claim: 'the migration is scheduled', status: 'supported', confidence: 0.8, epistemic: 'observed' }] },
        world: { count: 0, entityCount: 0, facts: [] },
        epistemic: { observed: 1, inferred: 0, assumed: 0, predicted: 0 },
        sentinel: { reading: null, advisories: [{ id: 'a1', severity: 'warning', summary: 'a deadline is close' }], error: null },
        problems: [],
      },
      salience: {
        urgency: 0.3, confidence: 0.3, uncertainty: 0.7, goal_progress: 0.5, resource_pressure: 0.12,
        risk_sensitivity: 0.15, novelty: 1,
        basis: { urgency: '1 Sentinel advisory', confidence: 'mean of 1 declared item confidence', goal_progress: 'mean criteria completion', resource_pressure: 'memory 12% in use' },
      },
      council: {
        status: 'ran',
        perspectives: {
          thesis: { perspective: 'Objective alignment', verdict: 'partial_alignment', summary: '2 of 6 objective terms appear in the candidate.', evidence: [] },
          counter_risk: { perspective: 'Safety and policy', verdict: 'policy_note', summary: 'read action is delegable', evidence: [] },
          evidence_check: { perspective: 'Evidence quality', verdict: 'adequate', summary: 'one direct observation', evidence: [] },
        },
        recommendation: { level: 'conditional', support: 'tentative', confidence: 'low', summary: 'review before execution', requiresAuthorization: true },
        sessionId: 'council-session-1',
        authorizesExecution: false,
      },
      task_graph: {
        nodes: [{ id: 's1', action: 'memory.search', permission: 'read', risk: 'low', description: 'search memory', dependsOn: [] }],
        edges: [],
        rule: 'default read-only retrieval',
        summary: '1 step · read · low risk',
      },
      execution: {
        decision: 'allow', reason: 'PERMITTED', autonomyLevel: 0, autonomySource: null,
        approvalRequired: false, approvalRef: null, auditRef: 'cog-clientsmoke00001', verified: true,
        latch: { active: false, policyUnavailable: false },
        verification: { outcome: 'verified', verified: true, detail: 's1: success_verified' },
        taskStatus: 'completed', outcome: 'success_verified', summary: '1 matching memory record(s)',
      },
    },
    verification: { outcome: 'verified', verified: true, detail: 's1: success_verified' },
    approval: { required: false, status: 'not_required', recorded: null, waitingSteps: [] },
    halted: null,
    taskId: 'task-clientsmoke0001',
    task: { id: 'task-clientsmoke0001', status: 'completed', origin: 'user', planner: 'deterministic', steps: [] },
  };

  function routesWith(payload) {
    const map = new Map();
    map.set('/api/state', {
      session: { id: 'session-test-0001', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [], docs: [], events: [],
      autonomy: { configured: {} }, runtime: { status: 'stopped', lifecycle: 'stopped', paused: false },
      resources: { cpu: { logicalCount: 4 }, memory: { available: false }, storage: [] },
    });
    map.set('/api/health', { overall: 'healthy', areas: [], unhealthyAreaCount: 0, attentionCount: 0, errorCount: 0, coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 } });
    map.set('/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' });
    map.set('/api/mission-control', { available: true, goals: [], plans: [], counts: { goals: 0, plans: 0 } });
    map.set('/api/approvals', { available: true, taskSteps: [], draftPlans: [], taskStepCount: 0, draftPlanCount: 0, truncatedTaskSteps: false, truncatedDraftPlans: false });
    map.set('/api/timeline', { available: true, entries: [], total: 0 });
    map.set('/api/situation', { available: true, counts: {}, items: [], approvals: [] });
    map.set('/api/briefing', { available: true, facts: [], sections: [] });
    map.set('/api/runtime', { available: true, lifecycle: 'stopped', paused: false });
    map.set('/api/sources', { available: true, sources: [] });
    map.set('/api/documents', { available: true, documents: [], documentsTotal: 0 });
    map.set('/api/reasoning', { available: true, items: [] });
    map.set('/api/council', { available: true, sessions: [] });
    map.set('/api/workshop', { available: true, artifacts: [] });
    map.set('/api/resources', { cpu: { logicalCount: 4, available: true }, memory: { available: false }, gpu: { available: false }, network: { available: null }, storage: [], reservations: 0 });
    map.set('/api/cognition/runs', { runs: payload, total: payload.length, corrupt: 0, stages: ['context', 'salience', 'council', 'task_graph', 'execution'], authorizesExecution: false });
    return map;
  }

  function loadClient(routes) {
    const browser = createFakeBrowser({ routes });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    return { browser, context };
  }

  function textOf(node) {
    const parts = [node.textContent ?? ''];
    for (const child of node.children ?? []) parts.push(textOf(child));
    return parts.join(' ');
  }

  test('five stage sections are rendered from the run record, with no placeholder values', async () => {
    const { browser } = loadClient(routesWith([run]));
    await flushMicrotasks();
    const trace = browser.getElement('cognition-trace');
    const stages = (trace.children ?? []).filter((child) => child.className === 'cognition-stage');
    assert.equal(stages.length, 5, 'exactly five stages are rendered');
    const text = textOf(trace);
    for (const marker of ['1 · Context', '2 · Salience', '3 · Council', '4 · Task graph', '5 · Governed execution']) {
      assert.ok(text.includes(marker), `the trace shows ${marker}`);
    }
    assert.ok(text.includes('cog-clientsmoke00001'), 'the run id is shown');
    assert.ok(text.includes('observed'), 'epistemic tags are shown');
    assert.ok(text.includes('deliberation data, not a permission'), 'the Council stage says a recommendation is not a permission');
    assert.ok(!/undefined|NaN|\[object Object\]/.test(text), `no placeholder value is rendered: ${text.slice(0, 200)}`);
    assert.equal(browser.events.consoleErrors.filter((line) => /ReferenceError|SyntaxError|not defined/i.test(line)).length, 0);
  });

  test('an awaiting-approval run offers one approval control that posts to the run approval route', async () => {
    const gated = {
      ...run,
      status: 'awaiting_approval',
      approval: { required: true, status: 'awaiting_owner_decision', recorded: null, waitingSteps: ['s1'] },
      verification: { outcome: 'not_verified', verified: false, detail: 's1: not_run' },
      stages: { ...run.stages, execution: { ...run.stages.execution, verified: false, approvalRequired: true } },
    };
    const { browser } = loadClient(routesWith([gated]));
    await flushMicrotasks();
    const trace = browser.getElement('cognition-trace');
    const buttons = (trace.children ?? []).filter((child) => child.tagName === 'BUTTON');
    assert.equal(buttons.length, 1, 'one approval control is offered');
    assert.match(buttons[0].textContent, /Approve step s1/);
    buttons[0].dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    const posted = browser.events.fetches.filter((entry) => entry.method === 'POST');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, '/api/cognition/runs/cog-clientsmoke00001/approve');
  });

  test('the cognition event triggers an authoritative refresh of the trace', async () => {
    const { browser } = loadClient(routesWith([run]));
    await flushMicrotasks();
    const source = browser.events.sources.at(-1);
    source.open();
    source.emit('reconcile', {
      schema: 'apex.ui.event/1', streamId: 'c'.repeat(32), seq: 3, at: '2026-11-19T10:00:00.000Z', type: 'reconcile',
      versions: {}, payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} }, correlationId: null,
    }, { lastEventId: `cccccccccccccccccccccccccccccccc:3` });
    await flushMicrotasks();
    const before = browser.events.fetches.filter((entry) => entry.url.startsWith('/api/cognition/runs')).length;
    source.emit('cognition', { runId: 'cog-clientsmoke00001', status: 'completed' });
    browser.clock.advance(1000);
    await flushMicrotasks();
    const after = browser.events.fetches.filter((entry) => entry.url.startsWith('/api/cognition/runs')).length;
    assert.ok(after > before, 'the trace is re-read from the owner route after the event');
  });
});
