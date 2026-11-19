// T-30 Package 1 (2026-11-19): canonical Core-state vocabulary and display eligibility.
// The Core is a read-only projection. These definitions name the owner/source for each state;
// they do not create a state store or authorize an action. Listening, Speaking and Dormant have
// no process-owned state source that a live UI can observe, so they are not displayable states.
export const CORE_STATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'dormant', label: 'Dormant', source: null, owner: null,
    reachability: 'reserved, not reachable', precedence: null,
    rationale: 'No live UI process exists to display its own pre-start state.',
  }),
  Object.freeze({
    id: 'idle', label: 'Idle',
    source: 'Derived snapshot of TaskStore, PlanStore, ECP kill-switch status, health and event-stream liveness; no active higher-priority condition.',
    owner: 'Underlying task, plan, ECP and health owners; the UI server only projects their reads.',
    reachability: 'reachable', precedence: 7,
    rationale: 'There is no persisted idle flag; missing or unreadable required sources must not be treated as idle.',
  }),
  Object.freeze({
    id: 'listening', label: 'Listening', source: null, owner: null,
    reachability: 'reserved, not reachable', precedence: null,
    rationale: 'No audio capture, wake-word or push-to-talk pipeline exists; voice is out of scope.',
  }),
  Object.freeze({
    id: 'thinking', label: 'Thinking',
    source: 'A real UI chat request submitted and still awaiting its /api/chat response.',
    owner: 'UI request lifecycle, presentation-only; it is not persisted system state or authorization.',
    reachability: 'reachable', precedence: 6,
    rationale: 'A request-in-flight indicator is valid only while that actual request is pending.',
  }),
  Object.freeze({
    id: 'speaking', label: 'Speaking', source: null, owner: null,
    reachability: 'reserved, not reachable', precedence: null,
    rationale: 'No text-to-speech output exists; voice is out of scope.',
  }),
  Object.freeze({
    id: 'executing', label: 'Executing',
    source: 'TaskStore tasks.jsonl contains a task whose recorded status is running.',
    owner: 'TaskStore and the existing TaskRunner/Controller transition path.',
    reachability: 'reachable', precedence: 5,
    rationale: 'A plan or UI animation alone is not evidence that execution started.',
  }),
  Object.freeze({
    id: 'awaiting_approval', label: 'Awaiting Approval',
    source: 'PlanStore plans.jsonl approval state or TaskStore tasks.jsonl step status awaiting_approval.',
    owner: 'PlanStore/TaskStore own the recorded lifecycle; ECP owns the authorization decision.',
    reachability: 'reachable', precedence: 3,
    rationale: 'A pending approval must not be hidden by Idle or ordinary activity.',
  }),
  Object.freeze({
    id: 'uncertain', label: 'Uncertain',
    source: 'TaskStore tasks.jsonl records an uncertain step/outcome, with its linked operation and verifier evidence.',
    owner: 'TaskStore owns task lifecycle; OperationLog and the independent verifier own their evidence.',
    reachability: 'reachable', precedence: 4,
    rationale: 'An unestablished side effect remains uncertain and is never reported as completed.',
  }),
  Object.freeze({
    id: 'degraded', label: 'Degraded',
    source: 'Health projection reports a required source unavailable/degraded, or the authoritative event stream/read path is stale or failed.',
    owner: 'Health projection and the underlying source owners; UI transport reports only its own liveness.',
    reachability: 'reachable', precedence: 2,
    rationale: 'Unavailable state is not healthy, unlocked or idle.',
  }),
  Object.freeze({
    id: 'lockdown', label: 'Lockdown',
    source: 'ExecutiveControlPlane.killSwitchStatus() rereads dataDir/kill-switch.json.',
    owner: 'Executive Control Plane (ECP); the UI is a read-only consumer.',
    reachability: 'reachable', precedence: 1,
    rationale: 'An active durable latch overrides every ordinary operating state.',
  }),
]);

// Ordered highest priority first. Reserved states are intentionally absent.
export const CORE_STATE_PRECEDENCE = Object.freeze([
  'lockdown',
  'degraded',
  'awaiting_approval',
  'uncertain',
  'executing',
  'thinking',
  'idle',
]);

export const CORE_REACHABLE_STATES = Object.freeze([...CORE_STATE_PRECEDENCE]);
export const CORE_RESERVED_STATES = Object.freeze(
  CORE_STATE_DEFINITIONS.filter((state) => state.reachability === 'reserved, not reachable').map((state) => state.id),
);

export function isReachableCoreState(state) {
  return CORE_REACHABLE_STATES.includes(state);
}

export function assertReachableCoreState(state) {
  if (!isReachableCoreState(state)) {
    throw new RangeError(`Core state ${String(state)} is reserved or unknown and cannot be set`);
  }
  return state;
}

// Pure contract for Package 3's UI projection. This consumes only validated observations supplied
// by the actual owners; it creates no state and performs no I/O. A known active latch wins even if
// another source is degraded. Otherwise, uncertainty in any required source fails closed to
// Degraded before a pending approval or ordinary activity can be shown.
export function resolveCoreState({
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
  return CORE_STATE_PRECEDENCE.find((state) => signals[state]) ?? 'degraded';
}
