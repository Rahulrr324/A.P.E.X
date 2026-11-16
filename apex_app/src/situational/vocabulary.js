// Closed vocabularies for T-09. Nothing here is inferred: an event arrives with a category and a
// type the caller states, and every downstream decision is a rule over recorded values.
export const SITUATION_SCHEMA = 'apex.situation/1';

export const RECORD_KINDS = Object.freeze([
  'event_observed',   // one normalised environmental change
  'event_assessed',   // one deterministic contextual reading of an event
  'response_decided', // the user's own choice among the candidate responses
  'response_recorded', // what actually happened when an approved response ran
]);

export const EVENT_CATEGORIES = Object.freeze([
  'task', 'plan', 'goal', 'memory', 'knowledge', 'prediction', 'adaptation',
  'observation', 'external', 'system',
]);

// `runtime` is the T-10 executive runtime publishing a lifecycle transition it observed. It is a
// distinct source from `apex` because the runtime, not the action that made the change, is the
// reporter, and from `user` because the user did not state it.
export const EVENT_SOURCES = Object.freeze(['apex', 'user', 'runtime', 'test_provider', 'external_provider']);

// The responses are ordered from least to most consequential. Only `execute` changes anything, and
// only after the user has recorded it as a decision; no event can choose it.
export const RESPONSES = Object.freeze([
  'ignore', 'record', 'investigate', 'notify', 'recommend', 'request_approval', 'execute',
]);

export const SIGNIFICANCE_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'critical']);

export const SIGNIFICANCE_RANK = Object.freeze({
  none: 0, low: 1, medium: 2, high: 3, critical: 4,
});

// Explicit thresholds. They are deliberately low-resolution: a score is a documented rule total,
// not a probability, and the bands are wide enough that one extra keyword does not change a level.
export const SIGNIFICANCE_THRESHOLDS = Object.freeze({
  critical: 75,
  high: 50,
  medium: 25,
  low: 8,
});

// Bounds. An event storm must not grow a store without limit, flood notices, or make one read
// return an unbounded page.
export const MAX_EVENT_TEXT = 400;
export const MAX_EVENT_REF = 64;
export const MAX_REFS = 12;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_EVENTS_READ = 100;
export const DEFAULT_EVENTS_READ = 20;
export const MAX_DECISIONS_READ = 100;
export const DEFAULT_DECISIONS_READ = 20;
export const MAX_ALERTS = 10;
export const MAX_RECENT = 10;
export const MAX_SUPPRESSED = 50;

// Notification hygiene. A condition repeated inside the cooldown is still recorded as a decision,
// but its notification is marked suppressed so the same fact is not surfaced twice.
export const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_NOTIFICATIONS_PER_HOUR = 5;
export const DECISION_REPLAY_WINDOW_MS = 10 * 60 * 1000;

// A fact or observation stops being current truth at its validity end, and an event older than this
// without an explicit validity end is reported as stale rather than as a current condition.
export const DEFAULT_OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;

// Actions that must never be chosen as an event response: doing so would let an event drive the
// awareness log itself (a loop) or the approval surface. The check is in the service, not only in
// the CLI, so a direct caller cannot bypass it.
export const RESPONSE_ACTION_GUARD = Object.freeze([
  'situation.ingest', 'situation.evaluate', 'situation.decide', 'situation.response',
  'situation.execute', 'situation.state', 'situation.events', 'situation.decisions',
  'situation.status',
  'adaptation.decide', 'adaptation.derive', 'goal.add', 'goal.update', 'plan.approve',
  'backup.restore', 'world.entity.merge',
]);

export const OPEN_GOAL_STATUSES = Object.freeze(['proposed', 'accepted', 'active', 'blocked']);
export const CLOSED_TASK_STATUSES = Object.freeze(['completed', 'cancelled']);
