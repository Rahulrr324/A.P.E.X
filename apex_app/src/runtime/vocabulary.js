// Closed vocabulary and explicit limits for the T-10 executive runtime.
export const RUNTIME_SCHEMA = 'apex.runtime/1';

export const LIFECYCLE = Object.freeze(['stopped', 'starting', 'running', 'stopping']);

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  version: 1,
  tickIntervalMs: 5000,
  maxEventsPerTick: 5,
  maxActionsPerTick: 1,
  maxProvidersPerTick: 2,
  maxBacklog: 500,
  maxProcessedIds: 2000,
  maxPublishedKeys: 2000,
  maxDeadLetters: 100,
  maxNotifications: 200,
  maxHistory: 100,
  notificationTtlMs: 48 * 60 * 60 * 1000,
  deadlineHorizonMs: 48 * 60 * 60 * 1000,
  leaseTtlMs: 30 * 1000,
  retry: Object.freeze({ maxAttempts: 3, baseDelayMs: 60 * 1000, multiplier: 2 }),
});

// Outcomes that mean the scheduler's attempt did not succeed. Kept explicit rather than treating
// every non-success string as a failure, because a plan can also end in a user decision.
export const FAILED_PLAN_STATUSES = Object.freeze(['failed', 'blocked', 'cancelled', 'superseded']);

export const OPEN_GOAL_STATUSES = Object.freeze(['proposed', 'accepted', 'active', 'blocked']);
export const TASK_IN_FLIGHT = Object.freeze(['running', 'paused', 'proposed']);

// Runtime-generated events carry this source. They are deliberately not themselves scanned as
// lifecycle records, which is what stops an event from generating an equivalent event forever.
export const RUNTIME_EVENT_SOURCE = 'runtime';

export const DEAD_LETTER_REASONS = Object.freeze({
  PROCESSING_ERROR: 'processing_error',
  RETRY_EXHAUSTED: 'retry_exhausted',
  MALFORMED_RECORD: 'malformed_record',
});
