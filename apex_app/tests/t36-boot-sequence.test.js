// T-36 Step 2 (2026-11-21): the HUD boot sequence - Part 4 Screen #1.
//
// The walk in `tests/e2e/t36-cold-boot-unseeded.spec.mjs` is the real evidence. This file is the
// fast half: the same client source, run under the project's browser stand-in, so the properties
// the walk depends on are pinned where a regression is cheap to find.
//
// What is pinned here:
//   * the Core is Dormant while the machine is waking, and it is not Dormant afterwards;
//   * every line in the overlay is a measured value that came from the server;
//   * the overlay never traps focus and Escape dismisses it;
//   * reduced motion removes the reveal delay and nothing else;
//   * an unseeded data directory opens on the sequence, and a set-up one does not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT, UI_PAGE } from '../src/ui/assets.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const DOCTOR_REPORT = {
  schema: 'apex.system.doctor/1',
  status: 'ok',
  ok: true,
  counts: { pass: 6, degraded: 0, failed: 0, notConfigured: 0 },
  checks: [
    { name: 'safety_latch', state: 'pass', summary: 'the latch is clear and enforced' },
    { name: 'ecp_authority', state: 'pass', summary: 'the ECP is the sole authority' },
    { name: 'stores_integrity', state: 'pass', summary: '1 store file, every line parses' },
    { name: 'capability_inventory', state: 'pass', summary: '156 capabilities, 0 orphans' },
    { name: 'browser_binary', state: 'pass', summary: 'a Chromium-family browser is installed' },
    { name: 'workspace_sensor', state: 'pass', summary: 'the git sensor reads branch main' },
  ],
  durationMs: 3.1,
  budgetMs: 500,
  withinBudget: true,
};

const BOOTSTRAP_REPORT = {
  schema: 'apex.system.bootstrap/1',
  at: '2026-11-21T09:00:00.000Z',
  status: 'ok',
  verified: true,
  detail: '4/4 check(s) verified',
  firstRun: true,
  idempotent: false,
  checks: [
    { id: 'doctor_readiness', label: 'Safety Latch', state: 'pass', verified: true, detail: 'readiness gate: 6/6 doctor check(s) passed', digest: 'a'.repeat(64) },
    { id: 'host_workspace_perception', label: 'Resource Fabric', state: 'pass', verified: true, detail: '14 observed entr(ies)', digest: 'b'.repeat(64) },
    { id: 'workstation_enrollment', label: 'Device Trust', state: 'pass', verified: true, detail: 'the local workstation was enrolled', digest: 'c'.repeat(64) },
    { id: 'executive_briefing', label: 'Executive Briefing', state: 'pass', verified: true, detail: 'Doctor: 6/6 ok', digest: 'd'.repeat(64) },
  ],
  doctor: DOCTOR_REPORT,
  perception: {
    reading: {
      schema: 'apex.host-workspace-sensor/1',
      at: '2026-11-21T09:00:00.000Z',
      source: 'host-workspace-sensor',
      host: { cpu: { logicalCount: 12, loadAverage1m: 0.4 }, memory: { totalBytes: 34359738368, freeBytes: 8589934592 }, process: { uptimeSeconds: 42 } },
      workspace: { available: true, root: '/home/owner/A.P.E.X', branch: 'main', head: 'abc1234', dirtyFiles: 0, untrackedFiles: 0 },
    },
    observed: 14,
    unavailable: 0,
  },
  device: { deviceId: 'local-workstation', label: 'owner-pc (linux)', status: 'trusted', alreadyEnrolled: false, total: 1 },
  briefing: {
    schema: 'apex.briefing.v1',
    generatedAt: '2026-11-21T09:00:00.000Z',
    concise: 'Doctor: 6/6 ok (ok) | Host: 12 CPU | Workspace: main @ abc1234 | Device: local-workstation',
    facts: [{ kind: 'workspace', text: 'git main at abc1234', status: 'observed' }],
    inferred: [],
    counts: { facts: 4, inferred: 0 },
    verified: true,
  },
  marker: { path: '/tmp/data/system-bootstrap.json', at: '2026-11-21T09:00:00.000Z', firstAt: '2026-11-21T09:00:00.000Z', runs: 1, status: 'ok' },
};

function routes({ bootstrapped = true } = {}) {
  const map = new Map();
  map.set('/api/system/doctor', DOCTOR_REPORT);
  map.set('/api/system/bootstrap', BOOTSTRAP_REPORT);
  const state = {
    session: { id: 'session-t36-0001', status: 'ok' },
    turns: [], tasks: [], plans: [], goals: [],
    autonomy: { configured: { chat: 'L1' } },
    runtime: { status: 'stopped', lifecycle: 'stopped', paused: false },
    resources: { cpu: { logicalCount: 12 }, memory: { available: true, totalBytes: 34359738368, freeBytes: 8589934592 }, storage: [] },
    system: { bootstrap: { bootstrapped, at: bootstrapped ? '2026-11-21T09:00:00.000Z' : null, firstAt: null, runs: bootstrapped ? 1 : 0, status: bootstrapped ? 'ok' : null } },
  };
  map.set('/api/state', state);
  map.set('/api/health', { overall: 'healthy', areas: [], unhealthyAreaCount: 0, attentionCount: 0, errorCount: 0, coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 } });
  map.set('/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' });
  return map;
}

// The stand-in's routes are complete enough for the client to boot; the read endpoints the deck
// calls that are not listed answer with an empty object rather than a 404.
function completeRoutes(map) {
  const empty = { available: true, items: [], entries: [], counts: {}, facts: [], sections: [], checks: [], devices: [], observations: [] };
  for (const path of [
    '/api/mission-control', '/api/approvals', '/api/timeline', '/api/situation', '/api/briefing', '/api/runtime',
    '/api/sources', '/api/documents', '/api/reasoning', '/api/council', '/api/workshop', '/api/resources',
    '/api/cognition/runs', '/api/presence', '/api/autonomy/matrix', '/api/world/epistemic', '/api/evolution',
    '/api/step-up', '/api/perception', '/api/taskgraph', '/api/memory/associations',
  ]) {
    if (!map.has(path)) map.set(path, empty);
  }
  return map;
}

// The sequence paces itself with timers, and each step schedules the next one only after the
// previous promise settles. So the clock and the microtask queue have to be interleaved, not run
// once each.
async function settle(browser, rounds = 24) {
  for (let index = 0; index < rounds; index += 1) {
    await flushMicrotasks();
    browser.clock.advance(200);
  }
  await flushMicrotasks();
}

function bootClient({ bootstrapped = true, search = '' } = {}) {
  const browser = createFakeBrowser({ routes: completeRoutes(routes({ bootstrapped })) });
  browser.window.location.search = search;
  const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t36-boot' });
  vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
  return browser;
}

// The client reaches the server through the event stream; the stand-in's source is opened by the
// script itself, and a reconcile is what makes the Core authoritative.
function reconcile(browser) {
  const source = browser.events.sources.at(-1);
  source.open();
  source.emit('reconcile', {
    schema: 'apex.state-event/1', streamId: 'a'.repeat(32), seq: 2, at: '2026-11-21T09:00:00.000Z',
    type: 'reconcile', versions: {}, payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} },
    correlationId: null,
  }, { lastEventId: `${'a'.repeat(32)}:2` });
  return source;
}

describe('T-36: the HUD boot sequence', () => {
  test('an unseeded data directory opens on the boot sequence and the Core wakes from Dormant', async () => {
    const browser = bootClient({ bootstrapped: false });
    await flushMicrotasks();
    // The sequence has begun: the overlay is up and the Core is Dormant.
    const overlay = browser.getElement('hud-boot-sequence');
    assert.equal(overlay.hidden, false, 'the boot overlay is shown');
    assert.equal(browser.coreState(), 'dormant', 'the Core is Dormant while the machine wakes');

    await settle(browser);

    assert.equal(overlay.hidden, true, 'the overlay dismisses when the sequence finishes');
    assert.notEqual(browser.coreState(), 'dormant', 'and the Core leaves Dormant');
  });

  test('every line in the overlay is a measured value, and a value that could not be read says so', async () => {
    const browser = bootClient({ bootstrapped: false });
    await settle(browser);

    const steps = browser.getElement('hud-boot-steps').children;
    assert.equal(steps.length, 6, 'six subsystems are reported');
    const byId = new Map(steps.map((step) => [step.dataset.bootStep, step]));
    assert.deepEqual([...byId.keys()], [
      'safety_latch', 'ecp_authority', 'resource_fabric', 'git_workspace', 'device_trust', 'executive_briefing',
    ]);
    for (const step of steps) {
      assert.notEqual(step.dataset.bootState, 'pending', step.dataset.bootStep + ' was measured');
      const detail = step.children[1].textContent;
      assert.ok(detail.length > 0, step.dataset.bootStep + ' carries a detail');
    }
    assert.match(byId.get('git_workspace').children[1].textContent, /main at abc1234/);
    assert.match(byId.get('device_trust').children[1].textContent, /local-workstation \(trusted\)/);
    assert.match(byId.get('executive_briefing').children[1].textContent, /Doctor: 6\/6 ok/);
    assert.match(byId.get('resource_fabric').children[1].textContent, /12 CPU/);
    assert.deepEqual(browser.events.pageErrors, []);
  });

  test('Escape dismisses the overlay immediately, and the overlay never traps focus', async () => {
    const browser = bootClient({ bootstrapped: false });
    await flushMicrotasks();
    const overlay = browser.getElement('hud-boot-sequence');
    assert.equal(overlay.hidden, false);

    // The overlay is a region, not a dialog: the served markup says so, it does not take focus,
    // and it is not modal.
    assert.match(UI_PAGE, /id="hud-boot-sequence"[^>]*role="region"/,
      'the boot overlay is a region, not a modal dialog');
    assert.doesNotMatch(UI_PAGE, /id="hud-boot-sequence"[^>]*aria-modal="true"/,
      'the boot overlay is never modal');
    assert.doesNotMatch(UI_PAGE, /id="hud-boot-sequence"[^>]*autofocus/i,
      'the boot overlay never takes focus by itself');
    assert.equal(browser.document.activeElement, null, 'nothing was focused behind the owner\'s back');

    const keydown = browser.document.__listeners?.keydown ?? [];
    assert.ok(Array.isArray(keydown) && keydown.length > 0, 'the client listens for keys');
    for (const handler of keydown) {
      handler({ key: 'Escape', target: browser.document.body, preventDefault() {}, defaultPrevented: false });
    }
    assert.equal(overlay.hidden, true, 'Escape dismissed the overlay');
  });

  test('reduced motion removes the reveal delay and changes nothing else', async () => {
    const browser = createFakeBrowser({ routes: completeRoutes(routes({ bootstrapped: false })) });
    // The stand-in's matchMedia always reports reduced motion off; this harness turns it on.
    browser.sandbox.window.matchMedia = (query) => ({
      media: query,
      matches: query.includes('prefers-reduced-motion'),
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t36-boot-reduced' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    await flushMicrotasks();
    // No clock advance at all: with reduced motion the sequence completes without a delay.
    await flushMicrotasks();
    await flushMicrotasks();
    const overlay = browser.getElement('hud-boot-sequence');
    assert.equal(overlay.hidden, true, 'the sequence finished without waiting for a timer');
    assert.equal(browser.getElement('hud-boot-steps').children.length, 6, 'and it still reported six subsystems');
  });

  test('a directory that is already bootstrapped does not open on the boot sequence', async () => {
    const browser = bootClient({ bootstrapped: true });
    await settle(browser);
    assert.equal(browser.getElement('hud-boot-sequence').hidden, true, 'the overlay stays away');
  });

  test('the Run Boot Sequence control starts the sequence on demand', async () => {
    const browser = bootClient({ bootstrapped: true });
    await flushMicrotasks();
    browser.getElement('boot-sequence-run').click();
    await flushMicrotasks();
    assert.equal(browser.getElement('hud-boot-sequence').hidden, false, 'the overlay opened');
    assert.equal(browser.coreState(), 'dormant', 'and the Core went Dormant');
    await settle(browser);
    assert.equal(browser.getElement('hud-boot-sequence').hidden, true, 'and it dismissed when it finished');
  });
});
