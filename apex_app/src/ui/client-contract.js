// T-30 P0 (2026-11-19): the one contract source the Node modules and the served
// browser client share.
//
// Before this file existed, assets.js embedded individual Node functions with
// Function.prototype.toString(). Those functions closed over module-scope identifiers
// (STREAM_ID_RE, positiveVersion, the schema constants), which do not exist in the
// browser, so the served client threw ReferenceError while parsing its first event and
// parked the Core on Degraded against a healthy server.
//
// The fix is structural rather than a rename: buildClientContract() is a single factory
// that references nothing outside its own parameters and local declarations, so its
// source text is a complete program on its own. Node calls the factory directly; the
// browser receives the same text verbatim through CLIENT_CONTRACT_SOURCE. There is one
// implementation, and a guard test executes the rendered text in a bare VM context so a
// future module-scope reference fails the suite instead of the browser.
import {
  CORE_REACHABLE_STATES,
  CORE_STATE_DEFINITIONS,
  CORE_STATE_PRECEDENCE,
} from './core-state-tables.js';

export const STATE_EVENT_SCHEMA = 'apex.state-event/1';
export const HEARTBEAT_SCHEMA = 'apex.event-heartbeat/1';
export const STATE_EVENT_OWNERS = Object.freeze([
  'tasks',
  'plans',
  'approval',
  'lockdown',
  'runtime',
  'health',
  'conversation',
]);

export const EVENT_HEARTBEAT_MS = 500;
export const EVENT_WATCHDOG_MS = 1500;
export const OWNER_POLL_MS = 250;
export const STATE_EVENT_HISTORY_LIMIT = 128;
export const MAX_EVENT_FRAME_BYTES = 256 * 1024;
export const STREAM_ID_PATTERN = '^[a-f0-9]{32}$';

// Everything the factory needs, as plain data so the browser receives values rather
// than references. Adding a field here is the only way to give the client a new value.
export const CLIENT_CONTRACT_CONSTANTS = Object.freeze({
  stateEventSchema: STATE_EVENT_SCHEMA,
  heartbeatSchema: HEARTBEAT_SCHEMA,
  owners: STATE_EVENT_OWNERS,
  heartbeatMs: EVENT_HEARTBEAT_MS,
  watchdogMs: EVENT_WATCHDOG_MS,
  ownerPollMs: OWNER_POLL_MS,
  historyLimit: STATE_EVENT_HISTORY_LIMIT,
  maxFrameBytes: MAX_EVENT_FRAME_BYTES,
  streamIdPattern: STREAM_ID_PATTERN,
  coreStateDefinitions: CORE_STATE_DEFINITIONS,
  coreReachableStates: CORE_REACHABLE_STATES,
  coreStatePrecedence: CORE_STATE_PRECEDENCE,
});

// Self-contained by construction: no free identifiers, no imports, no template
// literals, nothing from Node. Its .toString() is the shipped browser source.
export function buildClientContract(constants) {
  if (constants === null || typeof constants !== 'object') {
    throw new TypeError('client contract constants are required');
  }
  const owners = constants.owners;
  const streamIdPattern = constants.streamIdPattern;
  const stateEventSchema = constants.stateEventSchema;
  const heartbeatSchema = constants.heartbeatSchema;
  const watchdogMs = constants.watchdogMs;
  const coreStatePrecedence = constants.coreStatePrecedence;

  const streamIdRe = new RegExp(streamIdPattern);

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function positiveVersion(value) {
    return Number.isSafeInteger(value) && value >= 1;
  }

  // The browser and the server tests use the same validator. A reconnect snapshot is
  // an explicit cursor reset; ordinary state events must be contiguous in both their
  // stream sequence and the owning source's version.
  function validateStateEventEnvelope(envelope, cursor = { streamId: null, seq: 0, versions: {} }) {
    const fail = (reason) => ({ ok: false, reason });
    if (!isRecord(envelope)) return fail('invalid-envelope');
    if (envelope.schema !== stateEventSchema) return fail('unsupported-schema');
    if (typeof envelope.streamId !== 'string' || !streamIdRe.test(envelope.streamId)) return fail('invalid-stream-id');
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 0) return fail('invalid-sequence');

    if (envelope.type === 'reconcile') {
      if (!isRecord(envelope.versions)) return fail('invalid-owner-versions');
      const keys = Object.keys(envelope.versions);
      if (keys.length !== owners.length
        || keys.some((key) => !owners.includes(key))) return fail('invalid-owner-versions');
      const versions = {};
      for (const owner of owners) {
        if (!positiveVersion(envelope.versions[owner])) return fail('invalid-owner-version');
        versions[owner] = envelope.versions[owner];
      }
      if (!isRecord(envelope.payload) || typeof envelope.payload.reason !== 'string'
        || !isRecord(envelope.payload.owners)) return fail('invalid-reconciliation-snapshot');
      const ownerKeys = Object.keys(envelope.payload.owners);
      if (ownerKeys.length !== owners.length
        || ownerKeys.some((key) => !owners.includes(key))) return fail('invalid-reconciliation-snapshot');
      for (const owner of owners) {
        const snapshot = envelope.payload.owners[owner];
        if (!isRecord(snapshot) || typeof snapshot.available !== 'boolean') return fail('invalid-reconciliation-snapshot');
      }
      return {
        ok: true,
        kind: 'reconcile',
        cursor: { streamId: envelope.streamId, seq: envelope.seq, versions },
      };
    }

    if (envelope.type !== 'state-changed') return fail('invalid-event-type');
    if (cursor.streamId !== envelope.streamId) return fail('stream-mismatch');
    if (!Number.isSafeInteger(cursor.seq) || cursor.seq < 0) return fail('invalid-cursor');
    if (envelope.seq <= cursor.seq) return fail(envelope.seq === cursor.seq ? 'duplicate-sequence' : 'out-of-order-sequence');
    if (envelope.seq !== cursor.seq + 1) return fail('sequence-gap');
    if (typeof envelope.category !== 'string' || !owners.includes(envelope.category)) return fail('unknown-owner');
    if (!positiveVersion(envelope.version)) return fail('invalid-owner-version');
    if (!isRecord(envelope.payload) || typeof envelope.payload.available !== 'boolean') return fail('invalid-owner-payload');

    const priorVersion = cursor.versions?.[envelope.category];
    if (priorVersion === undefined) {
      if (envelope.version !== 1) return fail('owner-version-gap');
    } else if (!positiveVersion(priorVersion) || envelope.version !== priorVersion + 1) {
      return fail(envelope.version <= priorVersion ? 'out-of-order-owner-version' : 'owner-version-gap');
    }

    const versions = { ...(cursor.versions ?? {}), [envelope.category]: envelope.version };
    return {
      ok: true,
      kind: 'state-changed',
      cursor: { streamId: envelope.streamId, seq: envelope.seq, versions },
    };
  }

  function validateHeartbeatEnvelope(envelope, cursor = { streamId: null, seq: 0 }) {
    if (!isRecord(envelope)) return { ok: false, reason: 'invalid-heartbeat' };
    if (envelope.schema !== heartbeatSchema) return { ok: false, reason: 'unsupported-heartbeat-schema' };
    if (typeof envelope.streamId !== 'string' || !streamIdRe.test(envelope.streamId)) {
      return { ok: false, reason: 'invalid-stream-id' };
    }
    if (!Number.isSafeInteger(envelope.headSeq) || envelope.headSeq < 0) {
      return { ok: false, reason: 'invalid-head-sequence' };
    }
    if (cursor.streamId && cursor.streamId !== envelope.streamId) return { ok: false, reason: 'stream-mismatch' };
    if (cursor.streamId === envelope.streamId && envelope.headSeq > cursor.seq) {
      return { ok: false, reason: 'sequence-gap' };
    }
    if (cursor.streamId === envelope.streamId && envelope.headSeq < cursor.seq) {
      return { ok: false, reason: 'head-sequence-regression' };
    }
    return { ok: true };
  }

  // Kept dependency-injected so the served client and the timing tests exercise the
  // exact same watchdog. A missing 500 ms heartbeat therefore degrades at 1.5 s, within
  // the two-second acceptance window.
  function createEventWatchdog({
    onExpired = () => {},
    timeoutMs = watchdogMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    let timer = null;
    let stopped = false;
    return Object.freeze({
      arm() {
        if (stopped) return;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => {
          timer = null;
          if (!stopped) onExpired();
        }, timeoutMs);
      },
      stop() {
        stopped = true;
        if (timer !== null) clearTimer(timer);
        timer = null;
      },
    });
  }

  // Package 1's pure precedence reducer, consumed by the live owner projection below.
  // It accepts only validated observations supplied by the actual owners; it creates no
  // state and performs no I/O. A known active latch wins even if another source is
  // degraded. Otherwise, uncertainty in any required source fails closed to Degraded
  // before activity is presented.
  function resolveCoreState({
    lockdown,
    authoritativeStateAvailable,
    healthAvailable,
    eventStreamAvailable,
    degraded = false,
    pendingApproval = false,
    uncertain = false,
    executing = false,
    thinking = false,
    idleReady = false,
  } = {}) {
    const signals = {
      lockdown: lockdown === 'active',
      degraded: lockdown !== 'clear'
        || authoritativeStateAvailable !== true
        || healthAvailable !== true
        || eventStreamAvailable !== true
        || degraded === true,
      awaiting_approval: pendingApproval === true,
      uncertain: uncertain === true,
      executing: executing === true,
      thinking: thinking === true,
      idle: idleReady === true,
    };
    return coreStatePrecedence.find((state) => signals[state]) ?? 'degraded';
  }

  // Package 3 live projection: consume the bounded owner snapshots produced by Package 2.
  // A source is never inferred healthy from a missing field. Lockdown can still be
  // positively known active while another source is unavailable, preserving the
  // highest-priority state.
  function resolveCoreStateFromOwners(snapshotOwners, {
    eventStreamAvailable = false,
    stateReadAvailable = false,
    thinking = false,
  } = {}) {
    const recordOf = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
    const validators = {
      tasks: (value) => recordOf(value.counts)
        && ['runningTasks', 'pausedTasks', 'awaitingApprovalSteps', 'uncertainSteps'].every((key) => isCount(value.counts[key])),
      plans: (value) => recordOf(value.counts) && isCount(value.counts.unapprovedDrafts),
      approval: (value) => isCount(value.taskStepCount) && isCount(value.draftPlanCount)
        && Array.isArray(value.taskSteps) && value.taskSteps.every((step) => recordOf(step)
          && typeof step.taskId === 'string' && typeof step.stepId === 'string')
        && Array.isArray(value.draftPlans) && value.draftPlans.every((plan) => recordOf(plan)
          && typeof plan.planId === 'string' && typeof plan.approved === 'boolean')
        && typeof value.truncatedTaskSteps === 'boolean' && typeof value.truncatedDraftPlans === 'boolean',
      lockdown: (value) => typeof value.active === 'boolean' && typeof value.policyUnavailable === 'boolean',
      runtime: (value) => typeof value.lifecycle === 'string' && typeof value.paused === 'boolean',
      health: (value) => ['healthy', 'unknown', 'degraded', 'blocked', 'failed'].includes(value.overall)
        && Array.isArray(value.areas) && value.areas.every((area) => recordOf(area)
          && typeof area.key === 'string' && typeof area.state === 'string'
          && typeof area.summary === 'string' && typeof area.advisory === 'boolean')
        && isCount(value.unhealthyAreaCount) && isCount(value.attentionCount) && isCount(value.errorCount)
        && recordOf(value.coreAttentionCounts)
        && ['approval', 'uncertain', 'other'].every((key) => isCount(value.coreAttentionCounts[key]))
        && value.attentionCount === value.coreAttentionCounts.approval
          + value.coreAttentionCounts.uncertain + value.coreAttentionCounts.other,
      conversation: (value) => typeof value.sessionStatus === 'string'
        && isCount(value.turnCount) && isCount(value.corruptCount),
    };
    const owner = (name) => {
      const value = snapshotOwners?.[name];
      return recordOf(value) && value.available === true && validators[name]?.(value) ? value : null;
    };
    const tasks = owner('tasks');
    const plans = owner('plans');
    const approvals = owner('approval');
    const lockdownOwner = owner('lockdown');
    const runtime = owner('runtime');
    const health = owner('health');
    const conversation = owner('conversation');

    const lockdown = lockdownOwner?.active === true
      ? 'active'
      : lockdownOwner && lockdownOwner.active === false && lockdownOwner.policyUnavailable !== true
        ? 'clear'
        : 'unavailable';

    const approvalCounts = approvals ?? {};
    const pendingApproval = (Number.isSafeInteger(approvalCounts.taskStepCount) && approvalCounts.taskStepCount > 0)
      || (Number.isSafeInteger(approvalCounts.draftPlanCount) && approvalCounts.draftPlanCount > 0
        && Array.isArray(approvalCounts.draftPlans)
        && approvalCounts.draftPlans.some((plan) => plan && plan.approved === false))
      || (Number.isSafeInteger(tasks?.counts?.awaitingApprovalSteps) && tasks.counts.awaitingApprovalSteps > 0)
      || (Number.isSafeInteger(plans?.counts?.unapprovedDrafts) && plans.counts.unapprovedDrafts > 0);
    const uncertain = Number.isSafeInteger(tasks?.counts?.uncertainSteps) && tasks.counts.uncertainSteps > 0;
    const executing = Number.isSafeInteger(tasks?.counts?.runningTasks) && tasks.counts.runningTasks > 0;
    const pausedTasks = Number.isSafeInteger(tasks?.counts?.pausedTasks) && tasks.counts.pausedTasks > 0;

    const healthOverall = typeof health?.overall === 'string' ? health.overall : 'unknown';
    const healthAttention = health?.coreAttentionCounts ?? {};
    const onlyRepresentedStateHealth = ['degraded', 'blocked'].includes(healthOverall)
      && health.unhealthyAreaCount === 0 && health.errorCount === 0 && healthAttention.other === 0
      && (healthAttention.approval === 0 || pendingApproval)
      && (healthAttention.uncertain === 0 || uncertain)
      && healthAttention.approval + healthAttention.uncertain > 0;
    const healthInconsistent = healthOverall === 'healthy'
      && (health.unhealthyAreaCount > 0 || health.errorCount > 0 || health.attentionCount > 0);
    const healthDegraded = (healthOverall !== 'healthy' && !onlyRepresentedStateHealth) || healthInconsistent;
    const runtimeDegraded = !runtime
      || !['running', 'stopped'].includes(runtime.lifecycle)
      || runtime.paused === true
      || Boolean(runtime.corruption)
      || Boolean(runtime.lastError);
    const conversationDegraded = !conversation
      || !['missing', 'ok'].includes(conversation.sessionStatus)
      || (Number.isSafeInteger(conversation.corruptCount) && conversation.corruptCount > 0);
    const requiredOwnersAvailable = Boolean(tasks && plans && approvals && lockdownOwner && runtime && health && conversation)
      && stateReadAvailable === true;

    return resolveCoreState({
      lockdown,
      authoritativeStateAvailable: requiredOwnersAvailable,
      healthAvailable: Boolean(health),
      eventStreamAvailable: eventStreamAvailable === true,
      degraded: healthDegraded || runtimeDegraded || conversationDegraded || pausedTasks,
      pendingApproval,
      uncertain,
      executing,
      thinking,
      idleReady: requiredOwnersAvailable && !healthDegraded && !runtimeDegraded && !conversationDegraded
        && !pausedTasks && lockdown === 'clear' && eventStreamAvailable === true,
    });
  }

  return Object.freeze({
    constants: Object.freeze({ ...constants }),
    isRecord,
    positiveVersion,
    validateStateEventEnvelope,
    validateHeartbeatEnvelope,
    createEventWatchdog,
    resolveCoreState,
    resolveCoreStateFromOwners,
  });
}

export const CLIENT_CONTRACT = buildClientContract(CLIENT_CONTRACT_CONSTANTS);

// Rendered into the served client ahead of its handlers. The rendered names are the
// client's own; nothing here is a reference to this module.
export const CLIENT_CONTRACT_SOURCE = [
  `const APEX_CONTRACT = (${buildClientContract.toString()})(${JSON.stringify(CLIENT_CONTRACT_CONSTANTS)});`,
  'const STATE_EVENT_SCHEMA = APEX_CONTRACT.constants.stateEventSchema;',
  'const HEARTBEAT_SCHEMA = APEX_CONTRACT.constants.heartbeatSchema;',
  'const STATE_EVENT_OWNERS = APEX_CONTRACT.constants.owners;',
  'const EVENT_WATCHDOG_MS = APEX_CONTRACT.constants.watchdogMs;',
  'const CORE_STATE_DEFINITIONS = APEX_CONTRACT.constants.coreStateDefinitions;',
  'const CORE_REACHABLE_STATES = APEX_CONTRACT.constants.coreReachableStates;',
  'const CORE_STATE_PRECEDENCE = APEX_CONTRACT.constants.coreStatePrecedence;',
  'const { isRecord, validateStateEventEnvelope, validateHeartbeatEnvelope, createEventWatchdog, resolveCoreState, resolveCoreStateFromOwners } = APEX_CONTRACT;',
].join('\n');
