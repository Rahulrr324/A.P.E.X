import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT, UI_CSS, UI_PAGE } from '../src/ui/assets.js';
import { CLIENT_CONTRACT_SOURCE } from '../src/ui/client-contract.js';
import { STATE_EVENT_OWNERS } from '../src/ui/event-contract.js';
import { resolveCoreStateFromOwners } from '../src/ui/core-state.js';

const readyOwners = () => ({
  tasks: { available: true, total: 0, counts: { runningTasks: 0, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 0 }, items: [] },
  plans: { available: true, total: 0, counts: { unapprovedDrafts: 0 }, items: [] },
  approval: {
    available: true,
    taskStepCount: 0,
    draftPlanCount: 0,
    taskSteps: [],
    truncatedTaskSteps: false,
    draftPlans: [],
    truncatedDraftPlans: false,
  },
  lockdown: { available: true, active: false, policyUnavailable: false, reason: null },
  runtime: { available: true, lifecycle: 'stopped', paused: false, lastError: null, corruption: null },
  health: {
    available: true,
    overall: 'healthy',
    areas: [],
    unhealthyAreaCount: 0,
    attentionCount: 0,
    errorCount: 0,
    coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 },
  },
  conversation: { available: true, sessionStatus: 'missing', turnCount: 0, corruptCount: 0 },
});

function servedFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `served UI contains ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${signature} has a closing brace`);
}

function runServedProjection(owners, { eventReconciled = true, stateReadAvailable = true, thinking = false, eventStreamDegraded = false } = {}) {
  const projection = servedFunction(UI_CLIENT, 'function applyCoreProjection(');
  const state = { ownerSnapshots: owners, eventReconciled, stateReadAvailable, thinking, core: null };
  const sandbox = {
    resolveCoreStateFromOwners,
    state,
    eventStreamDegraded,
    coreCaptionFor: (core) => core,
    setCore: (next, caption) => { state.core = next; state.caption = caption; },
    renderSafety() {},
  };
  vm.runInNewContext(`${projection}\napplyCoreProjection();`, sandbox);
  return state;
}

function runSafetyRender(lockdown, overrides = {}) {
  const renderSafety = servedFunction(UI_CLIENT, 'function renderSafety()');
  const state = {
    ownerSnapshots: { lockdown },
    eventReconciled: true,
    stateReadAvailable: true,
    safetyLatchFresh: true,
    safetyMutationInFlight: false,
    ...overrides,
  };
  const els = {
    safetyStatus: { dataset: {}, textContent: '' },
    safetyLockButton: { disabled: false },
    safetyReleaseButton: { disabled: false },
  };
  const sandbox = { state, els, eventStreamDegraded: false };
  vm.runInNewContext(`${renderSafety}\nrenderSafety();`, sandbox);
  return { state, els };
}

describe('Package 3 live Core-state projection', () => {
  test('all seven Package 2 owner snapshots participate in the authoritative readiness contract', () => {
    const owners = readyOwners();
    assert.deepEqual(Object.keys(owners).sort(), [...STATE_EVENT_OWNERS].sort());
    assert.equal(resolveCoreStateFromOwners(owners, { eventStreamAvailable: true, stateReadAvailable: true }), 'idle');
    for (const owner of STATE_EVENT_OWNERS) {
      const unavailable = { ...owners, [owner]: { available: false, error: `${owner} unavailable` } };
      const state = resolveCoreStateFromOwners(unavailable, { eventStreamAvailable: true, stateReadAvailable: true });
      assert.equal(state, 'degraded', `${owner} is not inferred healthy when absent`);
    }
    const malformedTasks = readyOwners();
    malformedTasks.tasks.counts.runningTasks = '0';
    assert.equal(resolveCoreStateFromOwners(malformedTasks, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded',
      'malformed owner counts do not become an Idle snapshot');

    const malformedLatch = readyOwners();
    malformedLatch.lockdown.policyUnavailable = 'false';
    assert.equal(resolveCoreStateFromOwners(malformedLatch, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded',
      'an invalid ECP policy flag is not normalized to a clear latch');
    const malformedRuntime = readyOwners();
    delete malformedRuntime.runtime.paused;
    assert.equal(resolveCoreStateFromOwners(malformedRuntime, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded',
      'a missing runtime pause flag is not normalized to false');
    const malformedHealth = readyOwners();
    delete malformedHealth.health.coreAttentionCounts;
    assert.equal(resolveCoreStateFromOwners(malformedHealth, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded',
      'an incomplete health projection is not treated as healthy');
    const malformedConversation = readyOwners();
    malformedConversation.conversation.corruptCount = null;
    assert.equal(resolveCoreStateFromOwners(malformedConversation, { eventStreamAvailable: true, stateReadAvailable: true }), 'degraded',
      'an unreadable conversation corruption count is not treated as zero');
  });

  test('authoritative owner signals resolve with Lockdown-first full precedence', () => {
    const owners = readyOwners();
    const resolve = (sources, flags = {}) => resolveCoreStateFromOwners(sources, {
      eventStreamAvailable: true,
      stateReadAvailable: true,
      ...flags,
    });
    assert.equal(resolve(owners), 'idle');
    assert.equal(resolve(owners, { thinking: true }), 'thinking');

    const executing = readyOwners();
    executing.tasks.counts.runningTasks = 1;
    assert.equal(resolve(executing, { thinking: true }), 'executing');

    const uncertain = readyOwners();
    uncertain.tasks.counts.runningTasks = 1;
    uncertain.tasks.counts.uncertainSteps = 1;
    assert.equal(resolve(uncertain, { thinking: true }), 'uncertain');

    const approval = readyOwners();
    approval.approval.taskStepCount = 1;
    approval.tasks.counts.awaitingApprovalSteps = 1;
    approval.tasks.counts.uncertainSteps = 1;
    assert.equal(resolve(approval), 'awaiting_approval');

    const planApproval = readyOwners();
    planApproval.plans.counts.unapprovedDrafts = 1;
    planApproval.approval.draftPlanCount = 1;
    planApproval.approval.draftPlans = [{ planId: 'plan-1', approved: false }];
    assert.equal(resolve(planApproval), 'awaiting_approval');

    const blockedOnlyByApproval = readyOwners();
    blockedOnlyByApproval.approval.taskStepCount = 1;
    blockedOnlyByApproval.tasks.counts.awaitingApprovalSteps = 1;
    blockedOnlyByApproval.health.overall = 'blocked';
    blockedOnlyByApproval.health.attentionCount = 1;
    blockedOnlyByApproval.health.coreAttentionCounts.approval = 1;
    assert.equal(resolve(blockedOnlyByApproval), 'awaiting_approval',
      'health blocking caused only by the same approval is represented by Awaiting Approval');

    const uncertainWithRepresentedHealth = readyOwners();
    uncertainWithRepresentedHealth.tasks.counts.uncertainSteps = 1;
    uncertainWithRepresentedHealth.health.overall = 'degraded';
    uncertainWithRepresentedHealth.health.attentionCount = 1;
    uncertainWithRepresentedHealth.health.coreAttentionCounts.uncertain = 1;
    assert.equal(resolve(uncertainWithRepresentedHealth), 'uncertain',
      'health degradation caused only by the recorded uncertain step is represented by Uncertain');

    const approvalAndOtherBlocker = readyOwners();
    approvalAndOtherBlocker.approval.taskStepCount = 1;
    approvalAndOtherBlocker.tasks.counts.awaitingApprovalSteps = 1;
    approvalAndOtherBlocker.health.overall = 'blocked';
    approvalAndOtherBlocker.health.attentionCount = 2;
    approvalAndOtherBlocker.health.coreAttentionCounts.approval = 1;
    approvalAndOtherBlocker.health.coreAttentionCounts.other = 1;
    assert.equal(resolve(approvalAndOtherBlocker), 'degraded',
      'an unrelated blocked health condition still outranks approval');

    const uncertainAndOtherDegradation = readyOwners();
    uncertainAndOtherDegradation.tasks.counts.uncertainSteps = 1;
    uncertainAndOtherDegradation.health.overall = 'degraded';
    uncertainAndOtherDegradation.health.attentionCount = 2;
    uncertainAndOtherDegradation.health.coreAttentionCounts.uncertain = 1;
    uncertainAndOtherDegradation.health.coreAttentionCounts.other = 1;
    assert.equal(resolve(uncertainAndOtherDegradation), 'degraded',
      'an unrelated health degradation still outranks Uncertain');

    const pausedRuntime = readyOwners();
    pausedRuntime.runtime.paused = true;
    assert.equal(resolve(pausedRuntime), 'degraded', 'a paused runtime is not reported as healthy Idle');

    const degraded = readyOwners();
    degraded.health.overall = 'failed';
    degraded.approval.taskStepCount = 1;
    assert.equal(resolve(degraded), 'degraded');

    const activeLatch = { ...degraded, lockdown: { available: true, active: true, policyUnavailable: true } };
    activeLatch.tasks.available = false;
    assert.equal(resolve(activeLatch), 'lockdown', 'a positively observed active latch outranks all degradation');

    const paused = readyOwners();
    paused.tasks.counts.pausedTasks = 1;
    assert.equal(resolve(paused), 'degraded', 'an unrepresented paused task is not reported as Idle');
    assert.equal(resolve(owners, { eventStreamAvailable: false }), 'degraded');
    assert.equal(resolve(owners, { stateReadAvailable: false }), 'degraded');
  });

  test('the served client projects reconciled snapshots and request liveness instead of guessing Idle', () => {
    const owners = readyOwners();
    assert.equal(runServedProjection(owners).core, 'idle');
    assert.equal(runServedProjection(owners, { thinking: true }).core, 'thinking');
    assert.equal(runServedProjection(owners, { eventStreamDegraded: true }).core, 'degraded');
    assert.equal(runServedProjection(owners, { eventReconciled: false }).core, 'degraded');
    assert.match(UI_CLIENT, /state\.ownerSnapshots = data\.payload\.owners/);
    assert.match(UI_CLIENT, /state\.ownerSnapshots\[data\.category\] = data\.payload/);
    // T-30 P0 (2026-11-19): supersedes the textual check for the serialized Node
    // function. The client now builds the resolver from the shared contract factory;
    // the intent (the browser runs the same reducer, not a look-alike) is unchanged.
    assert.match(CLIENT_CONTRACT_SOURCE, /function resolveCoreStateFromOwners\(/);
    assert.match(UI_CLIENT, /resolveCoreStateFromOwners \} = APEX_CONTRACT;/);
  });

  test('safety release stays disabled until the latch is fresh and no mutation is pending', () => {
    const active = { available: true, active: true, policyUnavailable: false, reason: 'reviewed latch' };
    const fresh = runSafetyRender(active);
    assert.equal(fresh.els.safetyReleaseButton.disabled, false);

    const stale = runSafetyRender(active, { safetyLatchFresh: false });
    assert.equal(stale.els.safetyReleaseButton.disabled, true);
    assert.match(stale.els.safetyStatus.textContent, /latch has not been freshly read/);

    const pending = runSafetyRender(active, { safetyMutationInFlight: true, safetyLatchFresh: false });
    assert.equal(pending.els.safetyLockButton.disabled, true);
    assert.equal(pending.els.safetyReleaseButton.disabled, true);
    assert.match(pending.els.safetyStatus.textContent, /safety control is in progress/);
  });

  test('boot reports real owner/health outcomes and both Quick boot controls work', () => {
    assert.ok(UI_CLIENT.includes("api('/api/health')"));
    assert.ok(UI_CLIENT.includes("api('/api/killswitch')"));
    assert.ok(UI_CLIENT.includes("Owner event stream: ' + (state.eventReconciled ?"));
    assert.ok(UI_CLIENT.includes("els.quickBoot.addEventListener('click', skipBoot)"));
    assert.ok(UI_PAGE.includes('id="quick-boot"'));
    assert.ok(UI_PAGE.includes('id="boot-skip"'));
    assert.ok(UI_CSS.includes('body[data-core-state="uncertain"]'));
    assert.ok(UI_CSS.includes('body[data-core-state="lockdown"]'));
    assert.equal(UI_CLIENT.includes('Verifying loopback boundary'), false);
  });
});
