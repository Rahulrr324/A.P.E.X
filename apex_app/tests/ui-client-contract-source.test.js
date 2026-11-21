// T-30 P0 (2026-11-19): guards the one assumption the previous suite could not see — that
// the contract program rendered into the served client is a complete program on its own.
//
// The browser received Function.prototype.toString() output for functions that closed over
// module-scope identifiers, so the shipped script threw ReferenceError at its first event.
// These tests execute the rendered source in a bare vm context (no Node globals, no imports)
// and compare its behaviour with the Node implementation it is built from.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT } from '../src/ui/assets.js';
import {
  CLIENT_CONTRACT,
  CLIENT_CONTRACT_CONSTANTS,
  CLIENT_CONTRACT_SOURCE,
} from '../src/ui/client-contract.js';
import {
  STATE_EVENT_OWNERS,
  STATE_EVENT_SCHEMA,
  HEARTBEAT_SCHEMA,
  validateStateEventEnvelope,
  validateHeartbeatEnvelope,
} from '../src/ui/event-contract.js';
import { resolveCoreStateFromOwners } from '../src/ui/core-state.js';

const STREAM_ID = 'c'.repeat(32);
const versions = () => Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, 1]));
const owners = () => Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, { available: true }]));

function reconcile(overrides = {}) {
  return {
    schema: STATE_EVENT_SCHEMA,
    streamId: STREAM_ID,
    seq: 5,
    at: '2026-11-19T00:00:00.000Z',
    type: 'reconcile',
    versions: versions(),
    payload: { reason: 'initial', owners: owners() },
    ...overrides,
  };
}

// A bare context: standard intrinsics only. If the rendered program ever depends on a Node
// module binding, this throws instead of the browser throwing.
function runInBareContext() {
  const sandbox = {};
  const context = vm.createContext(sandbox, { name: 'bare-contract' });
  vm.runInContext(`${CLIENT_CONTRACT_SOURCE}\nthis.__contract = APEX_CONTRACT;`, context, {
    filename: 'contract-source.js',
    displayErrors: true,
  });
  return sandbox.__contract;
}

describe('rendered client contract is self-contained (T-30 P0)', () => {
  test('the rendered source runs in a bare vm context with no Node globals and no imports', () => {
    const contract = runInBareContext();
    for (const name of ['isRecord', 'validateStateEventEnvelope', 'validateHeartbeatEnvelope', 'createEventWatchdog', 'resolveCoreState', 'resolveCoreStateFromOwners']) {
      assert.equal(typeof contract[name], 'function', `the rendered contract provides ${name}`);
    }
    assert.doesNotMatch(CLIENT_CONTRACT_SOURCE, /\brequire\s*\(/);
    assert.doesNotMatch(CLIENT_CONTRACT_SOURCE, /^\s*import\s/m);
    assert.doesNotMatch(CLIENT_CONTRACT_SOURCE, /\bprocess\s*\./);
    assert.doesNotMatch(CLIENT_CONTRACT_SOURCE, /\bexports\s*\./);
    // A `${` inside the source would be interpolated when it is embedded in the UI template.
    assert.doesNotMatch(CLIENT_CONTRACT_SOURCE, /\$\{/);
    // The old module-scope identifiers must not appear in the factory itself. (The alias
    // lines after it declare the client's own names, which is how the client body expects
    // them; those are local consts assigned from APEX_CONTRACT, not references to Node.)
    const factorySource = CLIENT_CONTRACT_SOURCE.slice(0, CLIENT_CONTRACT_SOURCE.indexOf('const STATE_EVENT_SCHEMA = APEX_CONTRACT'));
    for (const identifier of ['STREAM_ID_RE', 'EVENT_WATCHDOG_MS', 'OWNER_POLL_MS', 'MAX_EVENT_FRAME_BYTES', 'CORE_STATE_DEFINITIONS', 'STATE_EVENT_SCHEMA']) {
      assert.equal(factorySource.includes(identifier), false, `the factory source does not reference ${identifier}`);
    }
  });

  test('the served client is no longer assembled from Node function source', () => {
    assert.doesNotMatch(UI_CLIENT, /\.toString\(\)/);
    assert.match(UI_CLIENT, /const APEX_CONTRACT = \(function buildClientContract\(constants\)/);
    assert.match(UI_CLIENT, /const \{ isRecord, validateStateEventEnvelope, validateHeartbeatEnvelope, createEventWatchdog, resolveCoreState, resolveCoreStateFromOwners \} = APEX_CONTRACT;/);
    // The values the client uses are data, not references to this module.
    assert.equal(JSON.parse(JSON.stringify(CLIENT_CONTRACT_CONSTANTS)).watchdogMs, 1500);
    assert.equal(typeof CLIENT_CONTRACT_CONSTANTS.coreStateDefinitions, 'object');
  });

  test('the browser validator and the Node validator return identical decisions', () => {
    const contract = runInBareContext();
    const cursor = { streamId: STREAM_ID, seq: 4, versions: versions() };
    const cases = [
      ['fresh reconcile', reconcile(), { streamId: null, seq: 0, versions: {} }],
      ['reconcile missing an owner version', reconcile({ versions: { tasks: 1 } }), { streamId: null, seq: 0, versions: {} }],
      ['reconcile with a non-positive version', reconcile({ versions: { ...versions(), tasks: 0 } }), { streamId: null, seq: 0, versions: {} }],
      ['reconcile with an unavailable owner', reconcile({ payload: { reason: 'x', owners: { ...owners(), tasks: { available: 'yes' } } } }), { streamId: null, seq: 0, versions: {} }],
      ['wrong schema', reconcile({ schema: 'apex.state-event/2' }), cursor],
      ['malformed stream id', reconcile({ streamId: 'nope' }), cursor],
      ['contiguous state change', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 5, type: 'state-changed', category: 'tasks', version: 2, payload: { available: true } }, cursor],
      ['sequence gap', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 7, type: 'state-changed', category: 'tasks', version: 2, payload: { available: true } }, cursor],
      ['duplicate sequence', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 4, type: 'state-changed', category: 'tasks', version: 2, payload: { available: true } }, cursor],
      ['unknown owner', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 5, type: 'state-changed', category: 'sensors', version: 2, payload: { available: true } }, cursor],
      ['owner version gap', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 5, type: 'state-changed', category: 'tasks', version: 9, payload: { available: true } }, cursor],
      ['missing payload availability', { schema: STATE_EVENT_SCHEMA, streamId: STREAM_ID, seq: 5, type: 'state-changed', category: 'tasks', version: 2, payload: {} }, cursor],
      ['not an object', 'reconcile', cursor],
    ];
    // Compared as JSON because the vm realm's objects have that realm's prototypes; the
    // decision, not the prototype, is what the browser and the server must share.
    for (const [label, envelope, state] of cases) {
      assert.equal(
        JSON.stringify(contract.validateStateEventEnvelope(envelope, state)),
        JSON.stringify(validateStateEventEnvelope(envelope, state)),
        label,
      );
    }

    const heartbeats = [
      [{ schema: HEARTBEAT_SCHEMA, streamId: STREAM_ID, headSeq: 5 }, { streamId: null, seq: 0 }],
      [{ schema: HEARTBEAT_SCHEMA, streamId: STREAM_ID, headSeq: 9 }, { streamId: STREAM_ID, seq: 4 }],
      [{ schema: HEARTBEAT_SCHEMA, streamId: STREAM_ID, headSeq: 3 }, { streamId: STREAM_ID, seq: 4 }],
      [{ schema: HEARTBEAT_SCHEMA, streamId: 'x', headSeq: 5 }, { streamId: STREAM_ID, seq: 4 }],
      [{ schema: 'wrong', streamId: STREAM_ID, headSeq: 5 }, { streamId: null, seq: 0 }],
    ];
    for (const [envelope, cursorState] of heartbeats) {
      assert.equal(
        JSON.stringify(contract.validateHeartbeatEnvelope(envelope, cursorState)),
        JSON.stringify(validateHeartbeatEnvelope(envelope, cursorState)),
      );
    }
  });

  test('the browser Core reduction and the Node Core reduction agree', () => {
    const contract = runInBareContext();
    const snapshot = (changes = {}) => ({
      tasks: { available: true, counts: { runningTasks: 0, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 0 } },
      plans: { available: true, counts: { unapprovedDrafts: 0 } },
      approval: { available: true, taskStepCount: 0, draftPlanCount: 0, taskSteps: [], truncatedTaskSteps: false, draftPlans: [], truncatedDraftPlans: false },
      lockdown: { available: true, active: false, policyUnavailable: false },
      runtime: { available: true, lifecycle: 'stopped', paused: false },
      health: { available: true, overall: 'healthy', areas: [], unhealthyAreaCount: 0, attentionCount: 0, errorCount: 0, coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 } },
      conversation: { available: true, sessionStatus: 'missing', turnCount: 0, corruptCount: 0 },
      ...changes,
    });
    const scenarios = [
      ['healthy', snapshot(), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['stream missing', snapshot(), { eventStreamAvailable: false, stateReadAvailable: true }],
      ['state read missing', snapshot(), { eventStreamAvailable: true, stateReadAvailable: false }],
      ['thinking', snapshot(), { eventStreamAvailable: true, stateReadAvailable: true, thinking: true }],
      ['lockdown', snapshot({ lockdown: { available: true, active: true, policyUnavailable: false } }), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['pending approval', snapshot({ approval: { available: true, taskStepCount: 1, draftPlanCount: 0, taskSteps: [{ taskId: 't', stepId: 's' }], truncatedTaskSteps: false, draftPlans: [], truncatedDraftPlans: false } }), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['uncertain step', snapshot({ tasks: { available: true, counts: { runningTasks: 0, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 1 } } }), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['running task', snapshot({ tasks: { available: true, counts: { runningTasks: 1, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 0 } } }), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['unavailable owner', snapshot({ health: { available: false } }), { eventStreamAvailable: true, stateReadAvailable: true }],
      ['paused runtime', snapshot({ runtime: { available: true, lifecycle: 'stopped', paused: true } }), { eventStreamAvailable: true, stateReadAvailable: true }],
    ];
    for (const [label, snapshots, options] of scenarios) {
      assert.equal(contract.resolveCoreStateFromOwners(snapshots, options), resolveCoreStateFromOwners(snapshots, options), label);
    }
  });

  test('the rendered watchdog degrades at 1.5 s and not before', () => {
    const contract = runInBareContext();
    let now = 0;
    let firedAt = null;
    let pending = null;
    const watchdog = contract.createEventWatchdog({
      onExpired: () => { firedAt = now; },
      setTimer: (callback, delay) => { pending = { at: now + delay, callback }; return 1; },
      clearTimer: () => { pending = null; },
    });
    watchdog.arm();
    assert.equal(pending.at, 1500, 'the rendered watchdog arms for 1.5 s');
    now = 1499;
    assert.equal(firedAt, null, 'the watchdog has not expired at 1.499 s');
    now = pending.at;
    pending.callback();
    assert.equal(firedAt, 1500, 'the watchdog expires at 1.5 s');
    watchdog.arm();
    assert.notEqual(pending, null, 'the watchdog can be re-armed');
    watchdog.stop();
    assert.equal(pending, null, 'stop clears an armed timer');
  });
});
