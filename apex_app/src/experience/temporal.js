// Temporal experience projection. This is a read-only view over the experience log: it orders the
// recorded events, filters them to a time window, aggregates them by capability, compares two
// windows, and detects a small set of sequences that the recorded outcomes actually show.
//
// The stages this module keeps apart are fixed, and only the first two exist here:
//
//   observation       what was recorded: one audited event, its outcome, when it finished, its
//                     capture route, the user's feedback on it, and later corrections of it.
//   pattern           a deterministic statement about the order of recorded observations. It names
//                     the records that support it, the records that contradict it, and its limits.
//   hypothesis        (not implemented) a proposed explanation for a pattern.
//   prediction        (not implemented) a claim about an outcome that has not happened yet.
//   observed_outcome  (not implemented) what actually happened afterwards, recorded as itself.
//
// A pattern is never a prediction and never an adaptation. Nothing here writes, approves, derives,
// or executes. Temporal order alone is not evidence of cause: every pattern says so, and the
// engine deliberately has no mechanism for turning proximity into a causal claim.
//
// Time is taken from the stored records only. An experience prefers `finishedAt` (when the audited
// operation ended), then `requestedAt`, then `createdAt` (when the experience itself was written),
// and reports which one it used. A record with no usable timestamp is reported as undated and is
// never placed in a window, ordered against dated events, or silently treated as "now". Equal
// timestamps are ordered by their position in the append-only log, so two records written with one
// clock reading still have one stable order.
import { ValidationError } from '../errors.js';
import { Outcome } from '../outcomes.js';
import { shortId, truncate } from '../util.js';
import { CORRECTIVE_ASSESSMENTS } from './derivation.js';

export const TEMPORAL_SCHEMA = 1;
export const TEMPORAL_STAGES = Object.freeze([
  'observation', 'pattern', 'hypothesis', 'prediction', 'observed_outcome',
]);
export const IMPLEMENTED_STAGES = Object.freeze(['observation', 'pattern']);

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 3650;
export const MAX_TEMPORAL_EVENTS = 50;
export const MAX_TEMPORAL_CAPABILITIES = 20;
export const MAX_PATTERNS = 20;
export const MAX_PATTERN_EVIDENCE = 20;
export const MIN_PATTERN_EVENTS = 3;
export const MIN_CORRECTION_FEEDBACK = 2;
export const MAX_EVENT_LINE_CHARS = 200;
export const MAX_LIMITATION_CHARS = 240;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const FAILURE_OUTCOMES = new Set([
  Outcome.EXECUTION_FAILED,
  Outcome.VERIFICATION_FAILED,
  Outcome.VERIFICATION_UNAVAILABLE,
  Outcome.AUDIT_INTEGRITY_FAILED,
  Outcome.MODEL_UNAVAILABLE,
  Outcome.TASK_CANCELLED,
]);
// A refusal is not a failure of execution. It is kept apart so "repeated failure" cannot be
// inflated by requests the system correctly declined, and so a streak is broken by a refusal
// rather than counted as one.
const BLOCKED_OUTCOMES = new Set([
  Outcome.ACTION_DENIED,
  Outcome.INPUT_REJECTED,
  Outcome.CLARIFICATION_REQUIRED,
  Outcome.PLAN_REJECTED,
]);

const PATTERN_KINDS = Object.freeze([
  'repeated_failure',
  'repeated_success',
  'alternating_outcomes',
  'regression_after_success',
  'improvement_after_correction',
  'recurring_corrections',
]);

const LIMITS = Object.freeze([
  'Derived at read time from stored records; nothing is persisted, repaired, or approved.',
  'A recorded event is evidence that an audited operation ended with an outcome, not proof about the user or the world.',
  'Patterns describe the order of recorded outcomes. Temporal order alone does not establish that one event caused another, and no pattern is a prediction.',
  'No pattern becomes an adaptation. A behaviour rule needs the user\'s corrective feedback and an explicit user approval, exactly as before.',
  'Events are ordered by finishedAt, then requestedAt, then createdAt; equal timestamps keep their append-only log order. Undated records are never placed in a window.',
]);

export function isCorrectiveAssessment(assessment) {
  return CORRECTIVE_ASSESSMENTS.includes(assessment);
}

export function outcomeClass(outcome) {
  if (outcome === Outcome.SUCCESS_VERIFIED) return 'success';
  if (FAILURE_OUTCOMES.has(outcome)) return 'failure';
  if (BLOCKED_OUTCOMES.has(outcome)) return 'blocked';
  if (typeof outcome === 'string' && outcome.length > 0) return 'other';
  return 'unknown';
}

// ---- time -------------------------------------------------------------------

export function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// `since` and `until` accept an ISO 8601 timestamp or a calendar date. A date is read in UTC, so
// the result does not depend on the machine's local time zone. A date-only `until` includes that
// whole UTC day; a date-only `since` begins at its first millisecond.
function parseBound(value, { end = false, name }) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${name} must be an ISO 8601 timestamp or YYYY-MM-DD`);
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isNaN(ms)) throw new ValidationError(`${name} is not a calendar date`);
    return end ? ms + DAY_MS - 1 : ms;
  }
  const ms = parseInstant(value);
  if (ms === null) throw new ValidationError(`${name} is not a recognizable time; use an ISO 8601 timestamp or YYYY-MM-DD`);
  return ms;
}

// What a bound may be is defined here and nowhere else, so the action's `validate` calls this rather
// than re-implementing the check. A malformed bound is then refused as rejected input, before any
// read starts, instead of surfacing later as a failed read.
export function checkTimeBound(value, { end = false, name = 'bound' } = {}) {
  parseBound(value, { end, name });
  return value;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Both bounds are inclusive. An explicit bound always wins; `days` only fills the bound that was
// not given, so "the last 7 days" and "since Monday" cannot quietly disagree about one end.
export function resolveWindow({ since, until, days, now } = {}) {
  const nowMs = parseInstant(now ?? new Date());
  if (nowMs === null) throw new ValidationError('the current time is not available');
  let dayCount = null;
  if (days !== undefined && days !== null) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      throw new ValidationError(`days must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
    }
    dayCount = days;
  }
  const explicitStart = parseBound(since, { end: false, name: 'since' });
  const explicitEnd = parseBound(until, { end: true, name: 'until' });
  const span = (dayCount ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
  const start = explicitStart ?? (explicitEnd === null ? nowMs - span : explicitEnd - span + 1);
  const end = explicitEnd ?? nowMs;
  if (start > end) throw new ValidationError('the start of the window is after its end');
  return {
    since: iso(start),
    until: iso(end),
    sinceMs: start,
    untilMs: end,
    days: dayCount,
    bounded: explicitStart !== null || explicitEnd !== null,
  };
}

export function sameWindow(a, b) {
  return Boolean(a && b) && a.sinceMs === b.sinceMs && a.untilMs === b.untilMs;
}

// ---- events -----------------------------------------------------------------

function eventTime(experience) {
  const finished = parseInstant(experience.finishedAt);
  if (finished !== null) return { ms: finished, source: 'finishedAt' };
  const requested = parseInstant(experience.requestedAt);
  if (requested !== null) return { ms: requested, source: 'requestedAt' };
  const created = parseInstant(experience.createdAt);
  if (created !== null) return { ms: created, source: 'createdAt' };
  return { ms: null, source: null };
}

function feedbackSummary(entries, retiredFeedback) {
  const current = entries.filter((entry) => !retiredFeedback.has(entry.id));
  const corrective = current.filter((entry) => isCorrectiveAssessment(entry.assessment));
  const latest = current.length > 0 ? current.at(-1) : null;
  return {
    total: entries.length,
    current: current.length,
    corrected: entries.length - current.length,
    corrective: corrective.length,
    assessments: [...new Set(current.map((entry) => entry.assessment))],
    latestAt: latest?.createdAt ?? null,
    latestAssessment: latest?.assessment ?? null,
  };
}

function buildEvent(experience, { feedbackByExperience, retiredFeedback, position, window }) {
  const { ms, source } = eventTime(experience);
  const entries = feedbackByExperience.get(experience.id) ?? [];
  return {
    id: experience.id,
    operationId: experience.operationId,
    capability: experience.capability ?? null,
    outcome: experience.outcome ?? null,
    outcomeClass: outcomeClass(experience.outcome),
    capture: experience.capture ?? 'unknown',
    active: experience.active === true,
    superseded: experience.superseded === true,
    requestedAt: experience.requestedAt ?? null,
    finishedAt: experience.finishedAt ?? null,
    createdAt: experience.createdAt ?? null,
    occurredAt: ms === null ? null : iso(ms),
    timeSource: source,
    undated: ms === null,
    inWindow: ms !== null && ms >= window.sinceMs && ms <= window.untilMs,
    logPosition: position.get(experience.id) ?? null,
    feedback: feedbackSummary(entries, retiredFeedback),
    replaces: [...(experience.replaces ?? [])],
    replacedBy: [...(experience.replacedBy ?? [])],
  };
}

function compareEvents(a, b) {
  if (a.undated !== b.undated) return a.undated ? 1 : -1;
  if (!a.undated && a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.logPosition !== b.logPosition) return (a.logPosition ?? 0) - (b.logPosition ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newCounts() {
  return {
    total: 0,
    success: 0,
    failure: 0,
    blocked: 0,
    other: 0,
    unknown: 0,
    automatic: 0,
    explicit: 0,
    unknownCapture: 0,
    feedback: 0,
    correctiveFeedback: 0,
    superseded: 0,
  };
}

function addToCounts(counts, event) {
  counts.total += 1;
  counts[event.outcomeClass] += 1;
  if (event.capture === 'automatic') counts.automatic += 1;
  else if (event.capture === 'explicit') counts.explicit += 1;
  else counts.unknownCapture += 1;
  counts.feedback += event.feedback.current;
  counts.correctiveFeedback += event.feedback.corrective;
  if (event.superseded) counts.superseded += 1;
}

function finalizeCounts(counts) {
  const classified = counts.success + counts.failure + counts.blocked + counts.other + counts.unknown;
  return {
    ...counts,
    successRate: classified === 0 ? null : Math.round((counts.success / classified) * 1000) / 1000,
  };
}

// One grouping of the same records for one window. Everything a query reports is built from this,
// so two windows are always aggregated the same way.
function buildSlice({ experiences, feedbackByExperience, retiredFeedback, position, window, capability }) {
  const events = experiences.map((experience) => buildEvent(experience, {
    feedbackByExperience,
    retiredFeedback,
    position,
    window,
  }));
  const inScope = capability
    ? events.filter((event) => event.capability === capability)
    : events;
  const dated = inScope.filter((event) => !event.undated && event.inWindow).sort(compareEvents);
  const undated = inScope.filter((event) => event.undated).sort(compareEvents);
  const outside = inScope.filter((event) => !event.undated && !event.inWindow);

  const groups = new Map();
  for (const event of dated) {
    const key = event.capability ?? 'unscoped';
    const group = groups.get(key) ?? { capability: key, counts: newCounts(), first: event, last: event, events: [] };
    addToCounts(group.counts, event);
    group.last = event;
    group.events.push(event);
    groups.set(key, group);
  }
  const byCapability = [...groups.values()]
    .map((group) => {
      const counts = finalizeCounts(group.counts);
      return {
        capability: group.capability,
        ...counts,
        firstAt: group.first.occurredAt,
        lastAt: group.last.occurredAt,
        firstClass: group.first.outcomeClass,
        lastClass: group.last.outcomeClass,
        outcomeChanged: group.first.outcomeClass !== group.last.outcomeClass,
        trend: trendOf(group.events),
      };
    })
    .sort((a, b) => b.total - a.total || a.capability.localeCompare(b.capability));

  const totals = finalizeCounts(dated.reduce((acc, event) => {
    addToCounts(acc, event);
    return acc;
  }, newCounts()));

  return { dated, undated, outside, byCapability, totals };
}

// The later half against the earlier half of the same ordered sequence. A tie is reported as
// stable; fewer than two events in either half is reported as insufficient rather than guessed.
function trendOf(events) {
  if (events.length < 2) return 'insufficient';
  const half = Math.floor(events.length / 2);
  const earlier = events.slice(0, half);
  const later = events.slice(events.length - half);
  const rate = (list) => {
    const classified = list.filter((event) => event.outcomeClass === 'success' || event.outcomeClass === 'failure');
    return classified.length === 0 ? null : classified.filter((event) => event.outcomeClass === 'success').length / classified.length;
  };
  const a = rate(earlier);
  const b = rate(later);
  if (a === null || b === null) return 'insufficient';
  if (b > a) return 'improving';
  if (b < a) return 'worsening';
  return 'stable';
}

function feedbackIndex(experiences, feedback, retiredFeedback, position) {
  const byExperience = new Map();
  for (const entry of feedback) {
    const list = byExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    byExperience.set(entry.experienceId, list);
  }
  const byCapability = new Map();
  for (const experience of experiences) {
    for (const entry of byExperience.get(experience.id) ?? []) {
      if (retiredFeedback.has(entry.id)) continue;
      if (!isCorrectiveAssessment(entry.assessment)) continue;
      const ms = parseInstant(entry.createdAt);
      const item = {
        id: entry.id,
        experienceId: experience.id,
        capability: experience.capability ?? null,
        assessment: entry.assessment,
        createdAt: entry.createdAt ?? null,
        ms,
        logPosition: position.get(entry.id) ?? null,
      };
      const list = byCapability.get(item.capability) ?? [];
      list.push(item);
      byCapability.set(item.capability, list);
    }
  }
  for (const list of byCapability.values()) {
    list.sort((a, b) => {
      if (a.ms === null && b.ms === null) return (a.logPosition ?? 0) - (b.logPosition ?? 0);
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return (a.logPosition ?? 0) - (b.logPosition ?? 0);
    });
  }
  return byCapability;
}

// ---- patterns ---------------------------------------------------------------

function evidenceOf(events) {
  const ids = events.slice(0, MAX_PATTERN_EVIDENCE).map((event) => event.id);
  return { experienceIds: ids, truncated: events.length > ids.length };
}

function patternBase({ kind, capability, window, events, supporting, contradicting, feedbackIds = [], basis }) {
  const automatic = supporting.filter((event) => event.capture === 'automatic').length;
  const explicit = supporting.filter((event) => event.capture === 'explicit').length;
  return {
    stage: 'pattern',
    kind,
    capability,
    basis,
    window: { since: window.since, until: window.until },
    evidence: evidenceOf(supporting),
    feedbackIds: feedbackIds.slice(0, MAX_PATTERN_EVIDENCE),
    counterEvidence: evidenceOf(contradicting),
    counts: {
      supporting: supporting.length,
      contradicting: contradicting.length,
      automatic,
      explicit,
      unknownCapture: supporting.length - automatic - explicit,
      evaluated: events.length,
    },
    supportTruncated: supporting.length > MAX_PATTERN_EVIDENCE,
    counterTruncated: contradicting.length > MAX_PATTERN_EVIDENCE,
    causal: false,
    adaptation: false,
  };
}

function streakPattern({ kind, label, capability, window, events, expected, contradicting, min = MIN_PATTERN_EVENTS }) {
  const recent = events.slice(-min);
  if (recent.length < min) return null;
  if (!recent.every((event) => event.outcomeClass === expected)) return null;
  const pattern = patternBase({
    kind,
    capability,
    window,
    events,
    supporting: recent,
    contradicting,
    basis: 'recorded_experiences',
  });
  pattern.threshold = `the ${min} most recent dated events in this window all record ${expected}`;
  pattern.explanation = `${min} consecutive recorded ${expected} outcome(s) ending at ${recent.at(-1).occurredAt}`;
  pattern.limitations = [
    `${label} describes these ${min} recorded events. It does not show why they ended that way, and a different set of events may exist outside this window.`,
    ...(contradicting.length > 0
      ? [`${contradicting.length} other recorded event(s) in the window have a different outcome and are listed as contradicting evidence.`]
      : []),
  ];
  return pattern;
}

function alternatingPattern({ capability, window, events, contradicting }) {
  const sequence = events.filter((event) => event.outcomeClass === 'success' || event.outcomeClass === 'failure');
  if (sequence.length < 4) return null;
  let start = sequence.length - 1;
  while (start > 0 && sequence[start - 1].outcomeClass !== sequence[start].outcomeClass) start -= 1;
  const run = sequence.slice(start);
  if (run.length < 4) return null;
  const pattern = patternBase({
    kind: 'alternating_outcomes',
    capability,
    window,
    events,
    supporting: run,
    contradicting,
    basis: 'recorded_experiences',
  });
  pattern.threshold = 'at least 4 consecutive dated success/failure events with no two adjacent outcomes equal';
  pattern.explanation = `${run.length} consecutive recorded events alternate between success and failure`;
  pattern.limitations = [
    'Alternation is a description of the recorded order, not evidence of a cycle or a rule. It does not predict that the next outcome alternates, and it does not show cause.',
    `Only success and failure outcomes participate; ${events.length - sequence.length} event(s) with another outcome were left out of the sequence.`,
  ];
  return pattern;
}

function regressionPattern({ capability, window, events, min = MIN_PATTERN_EVENTS }) {
  if (events.length < min) return null;
  const last = events.at(-1);
  if (last.outcomeClass !== 'failure') return null;
  const before = events.slice(0, -1);
  if (!before.every((event) => event.outcomeClass === 'success')) return null;
  if (before.length < min - 1) return null;
  const pattern = patternBase({
    kind: 'regression_after_success',
    capability,
    window,
    events,
    supporting: [...before, last],
    contradicting: [],
    basis: 'recorded_experiences',
  });
  pattern.threshold = `at least ${min - 1} successes followed by a failure, with no other outcome between them`;
  pattern.explanation = `the most recent recorded event is a failure after ${before.length} recorded success(es)`;
  pattern.limitations = [
    'This reports the first recorded failure after a run of successes. It does not establish that something changed or what caused the failure.',
  ];
  return pattern;
}

function improvementPattern({ capability, window, events, corrections }) {
  if (corrections.length === 0) return null;
  for (const correction of corrections) {
    if (correction.ms === null || correction.ms < window.sinceMs || correction.ms > window.untilMs) continue;
    const laterSuccesses = events.filter((event) => {
      const ms = parseInstant(event.occurredAt);
      return ms !== null && ms > correction.ms && event.outcomeClass === 'success';
    });
    if (laterSuccesses.length === 0) continue;
    const laterOther = events.filter((event) => {
      const ms = parseInstant(event.occurredAt);
      return ms !== null && ms > correction.ms && event.outcomeClass !== 'success';
    });
    const supporting = events.filter((event) => event.id === correction.experienceId).concat(laterSuccesses);
    const pattern = patternBase({
      kind: 'improvement_after_correction',
      capability,
      window,
      events,
      supporting,
      contradicting: laterOther,
      feedbackIds: [correction.id],
      basis: 'mixed',
    });
    pattern.threshold = 'one current corrective feedback record followed by at least one recorded success in the same capability';
    pattern.explanation = `a corrective feedback record from ${correction.createdAt} is followed by ${laterSuccesses.length} recorded success(es)`;
    pattern.limitations = [
      'A later success is not proof that the user correction caused it. Other changes between the two events are not represented here.',
      'Only current corrective feedback is considered; corrected feedback remains readable but no longer supports or contradicts this pattern.',
    ];
    return pattern;
  }
  return null;
}

function correctionPattern({ capability, window, events, corrections }) {
  const inWindow = corrections.filter((correction) => correction.ms !== null
    && correction.ms >= window.sinceMs
    && correction.ms <= window.untilMs);
  if (inWindow.length < MIN_CORRECTION_FEEDBACK) return null;
  const experienceIds = new Set(inWindow.map((correction) => correction.experienceId));
  const supporting = events.filter((event) => experienceIds.has(event.id));
  const without = events.filter((event) => !experienceIds.has(event.id));
  const pattern = patternBase({
    kind: 'recurring_corrections',
    capability,
    window,
    events,
    supporting,
    contradicting: without,
    feedbackIds: inWindow.map((correction) => correction.id),
    basis: 'user_feedback',
  });
  pattern.threshold = `${MIN_CORRECTION_FEEDBACK} current corrective feedback records in the same capability and window`;
  pattern.explanation = `${inWindow.length} corrective feedback record(s) assess experiences in this capability`;
  pattern.limitations = [
    'The feedback records are the user\'s assessments of separate events. They may concern different aspects, and their number alone does not identify a rule.',
    'A candidate adaptation still requires the deterministic derivation rule and your explicit approval.',
  ];
  return pattern;
}

function insufficientPattern({ window, events, feedbackCount, min = MIN_PATTERN_EVENTS }) {
  const pattern = {
    stage: 'pattern',
    kind: 'insufficient_evidence',
    capability: null,
    basis: 'recorded_experiences',
    window: { since: window.since, until: window.until },
    evidence: evidenceOf(events),
    feedbackIds: [],
    counterEvidence: { experienceIds: [], truncated: false },
    counts: {
      supporting: events.length,
      contradicting: 0,
      automatic: events.filter((event) => event.capture === 'automatic').length,
      explicit: events.filter((event) => event.capture === 'explicit').length,
      unknownCapture: events.filter((event) => event.capture === 'unknown').length,
      evaluated: events.length,
    },
    supportTruncated: events.length > MAX_PATTERN_EVIDENCE,
    counterTruncated: false,
    causal: false,
    adaptation: false,
    threshold: `at least ${min} dated events in the window`,
    explanation: events.length === 0
      ? `no dated experience falls inside the window; ${feedbackCount} feedback record(s) were considered`
      : `${events.length} dated event(s) fall inside the window, below the threshold for a sequence pattern`,
    limitations: [
      `A sequence pattern needs at least ${min} dated events. Fewer events are not enough to describe a repeated or changing outcome.`,
      'Absence of a pattern is not evidence that outcomes are stable; it means this window does not contain enough recorded events to say.',
    ],
  };
  return pattern;
}

export function detectPatterns({
  capability = null,
  window,
  dated,
  feedback = [],
  minEvents = MIN_PATTERN_EVENTS,
  maxPatterns = MAX_PATTERNS,
} = {}) {
  if (!window) throw new ValidationError('a window is required to detect patterns');
  const min = Number.isInteger(minEvents) && minEvents >= 2 && minEvents <= 20 ? minEvents : MIN_PATTERN_EVENTS;
  const correctionsByCapability = new Map();
  for (const item of feedback) {
    const list = correctionsByCapability.get(item.capability) ?? [];
    list.push(item);
    correctionsByCapability.set(item.capability, list);
  }

  const patterns = [];
  const groups = new Map();
  for (const event of dated) {
    const key = event.capability ?? 'unscoped';
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  const capabilities = [...groups.keys()].sort();

  for (const name of capabilities) {
    const events = groups.get(name);
    const corrections = correctionsByCapability.get(name === 'unscoped' ? null : name) ?? [];
    // Each candidate applies its own threshold. The group is not gated on the event count here:
    // `recurring_corrections` is supported by the user's assessments, and a window with two
    // corrective records but only two events would otherwise never reach its own stated minimum.
    const candidates = [
      streakPattern({
        kind: 'repeated_failure',
        label: 'Repeated failure',
        capability: name,
        window,
        events,
        expected: 'failure',
        contradicting: events.filter((event) => event.outcomeClass !== 'failure'),
        min,
      }),
      streakPattern({
        kind: 'repeated_success',
        label: 'Repeated success',
        capability: name,
        window,
        events,
        expected: 'success',
        contradicting: events.filter((event) => event.outcomeClass !== 'success'),
        min,
      }),
      alternatingPattern({
        capability: name,
        window,
        events,
        contradicting: events.filter((event) => event.outcomeClass !== 'success' && event.outcomeClass !== 'failure'),
      }),
      regressionPattern({ capability: name, window, events, min }),
      improvementPattern({ capability: name, window, events, corrections }),
      correctionPattern({ capability: name, window, events, corrections }),
    ].filter(Boolean);
    // A sequence that failed the threshold still shows in `trends` as counts. Only the patterns
    // above are named, and `minEvents` is stated in the output.
    patterns.push(...candidates);
  }

  if (dated.length < min) {
    patterns.unshift(insufficientPattern({ window, events: dated, feedbackCount: feedback.length, min }));
  }

  const bounded = patterns.slice(0, Math.max(1, maxPatterns));
  return {
    patterns: bounded,
    total: patterns.length,
    truncated: patterns.length > bounded.length,
    minEvents: min,
    minCorrections: MIN_CORRECTION_FEEDBACK,
    kinds: [...PATTERN_KINDS],
  };
}

// ---- views, trends, comparison ---------------------------------------------

export function buildTemporalView({
  experiences = [],
  feedback = [],
  retiredFeedback = new Set(),
  position = new Map(),
  window,
  capability = null,
  limit = MAX_TEMPORAL_EVENTS,
  slice = null,
} = {}) {
  if (!window) throw new ValidationError('a window is required');
  const feedbackByExperience = new Map();
  for (const entry of feedback) {
    const list = feedbackByExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    feedbackByExperience.set(entry.experienceId, list);
  }
  const scoped = slice ?? buildSlice({ experiences, feedbackByExperience, retiredFeedback, position, window, capability });
  const shownEvents = scoped.dated.slice(-Math.max(1, limit));
  const shownUndated = scoped.undated.slice(0, Math.max(1, limit));
  const capabilityWindow = scoped.byCapability.slice(0, MAX_TEMPORAL_CAPABILITIES);
  const totals = scoped.totals;
  return {
    schema: TEMPORAL_SCHEMA,
    window: { since: window.since, until: window.until },
    capability,
    counts: {
      storedExperiences: experiences.length,
      inWindow: scoped.dated.length,
      shown: shownEvents.length,
      outsideWindow: scoped.outside.length,
      undated: scoped.undated.length,
      live: scoped.dated.filter((event) => event.active).length,
      superseded: scoped.dated.filter((event) => event.superseded).length,
      success: totals.success,
      failure: totals.failure,
      blocked: totals.blocked,
      other: totals.other,
      unknown: totals.unknown,
      successRate: totals.successRate,
      automatic: totals.automatic,
      explicit: totals.explicit,
      unknownCapture: totals.unknownCapture,
      feedback: totals.feedback,
      correctiveFeedback: totals.correctiveFeedback,
    },
    events: shownEvents,
    undated: shownUndated,
    byCapability: capabilityWindow,
    capabilitiesTruncated: scoped.byCapability.length > capabilityWindow.length,
    limitations: [...LIMITS],
  };
}

export function analyzeTemporal({
  experiences = [],
  feedback = [],
  adaptations = [],
  retiredFeedback = new Set(),
  window,
  capability = null,
  limit = MAX_TEMPORAL_EVENTS,
  minEvents = MIN_PATTERN_EVENTS,
  maxPatterns = MAX_PATTERNS,
  position: suppliedPosition = null,
} = {}) {
  if (!window) throw new ValidationError('a window is required');
  // Order within one timestamp comes from the append-only log. The store passes a position map
  // covering every record kind; when it does not, experience order stands in for it.
  const position = suppliedPosition ?? new Map();
  if (!suppliedPosition) {
    for (const experience of experiences) position.set(experience.id, position.size);
  }
  const feedbackByExperience = new Map();
  for (const entry of feedback) {
    const list = feedbackByExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    feedbackByExperience.set(entry.experienceId, list);
  }
  const slice = buildSlice({ experiences, feedbackByExperience, retiredFeedback, position, window, capability });
  const view = buildTemporalView({
    experiences,
    feedback,
    retiredFeedback,
    position,
    window,
    capability,
    limit,
    slice,
  });
  const correctionIndex = feedbackIndex(experiences, feedback, retiredFeedback, position);
  const allCorrections = capability
    ? (correctionIndex.get(capability) ?? [])
    : [...correctionIndex.values()].flat().sort((a, b) => {
      if (a.ms === null && b.ms === null) return (a.logPosition ?? 0) - (b.logPosition ?? 0);
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      return a.ms - b.ms;
    });
  const detection = detectPatterns({
    capability,
    window,
    dated: slice.dated,
    feedback: allCorrections,
    minEvents,
    maxPatterns,
  });
  // The current adaptation state is read, never changed. It says which recorded rules cite
  // experiences inside this window; no pattern is allowed to create or alter one.
  const experienceIds = new Set(slice.dated.map((event) => event.id));
  const cited = adaptations.filter((adaptation) =>
    (adaptation.support?.experienceIds ?? []).some((id) => experienceIds.has(id)));
  return {
    view,
    patterns: detection,
    slice,
    adaptations: {
      total: adaptations.length,
      active: adaptations.filter((adaptation) => adaptation.active).length,
      citingWindow: cited.length,
      citingActive: cited.filter((adaptation) => adaptation.active).length,
      ids: cited.slice(0, MAX_PATTERN_EVIDENCE).map((adaptation) => adaptation.id),
    },
  };
}

export function compareTemporalWindows({
  experiences = [],
  feedback = [],
  retiredFeedback = new Set(),
  windowA,
  windowB,
  capability = null,
  position: suppliedPosition = null,
} = {}) {
  if (!windowA || !windowB) throw new ValidationError('two windows are required for a comparison');
  const position = suppliedPosition ?? new Map();
  if (!suppliedPosition) {
    for (const experience of experiences) position.set(experience.id, position.size);
  }
  const feedbackByExperience = new Map();
  for (const entry of feedback) {
    const list = feedbackByExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    feedbackByExperience.set(entry.experienceId, list);
  }
  const a = buildSlice({ experiences, feedbackByExperience, retiredFeedback, position, window: windowA, capability });
  const b = buildSlice({ experiences, feedbackByExperience, retiredFeedback, position, window: windowB, capability });
  const rows = new Map();
  for (const group of a.byCapability) rows.set(group.capability, { a: group, b: null });
  for (const group of b.byCapability) {
    const row = rows.get(group.capability) ?? { a: null, b: null };
    row.b = group;
    rows.set(group.capability, row);
  }
  const delta = (x, y) => (y ?? 0) - (x ?? 0);
  const rate = (group) => (group && group.successRate !== null ? group.successRate : null);
  const allRows = [...rows.values()]
    .map(({ a: left, b: right }) => {
      const capabilityName = left?.capability ?? right?.capability;
      const leftRate = rate(left);
      const rightRate = rate(right);
      return {
        capability: capabilityName,
        a: left ? { total: left.total, success: left.success, failure: left.failure, successRate: leftRate, lastAt: left.lastAt } : { total: 0, success: 0, failure: 0, successRate: null, lastAt: null },
        b: right ? { total: right.total, success: right.success, failure: right.failure, successRate: rightRate, lastAt: right.lastAt } : { total: 0, success: 0, failure: 0, successRate: null, lastAt: null },
        delta: {
          total: delta(left?.total, right?.total),
          success: delta(left?.success, right?.success),
          failure: delta(left?.failure, right?.failure),
          successRate: leftRate === null || rightRate === null ? null : Math.round((rightRate - leftRate) * 1000) / 1000,
        },
      };
    })
    .sort((x, y) => {
      const ax = Math.abs(x.delta.total) + Math.abs(x.delta.success) + Math.abs(x.delta.failure);
      const ay = Math.abs(y.delta.total) + Math.abs(y.delta.success) + Math.abs(y.delta.failure);
      return ay - ax || x.capability.localeCompare(y.capability);
    });
  const byCapability = allRows.slice(0, MAX_TEMPORAL_CAPABILITIES);
  const totalsOf = (slice) => ({
    total: slice.dated.length,
    undated: slice.undated.length,
    success: slice.totals.success,
    failure: slice.totals.failure,
    blocked: slice.totals.blocked,
    other: slice.totals.other,
    unknown: slice.totals.unknown,
    successRate: slice.totals.successRate,
    feedback: slice.totals.feedback,
    correctiveFeedback: slice.totals.correctiveFeedback,
    automatic: slice.totals.automatic,
    explicit: slice.totals.explicit,
  });
  const totalsA = totalsOf(a);
  const totalsB = totalsOf(b);
  const overlap = windowA.sinceMs <= windowB.untilMs && windowB.sinceMs <= windowA.untilMs;
  return {
    schema: TEMPORAL_SCHEMA,
    windows: {
      a: { since: windowA.since, until: windowA.until },
      b: { since: windowB.since, until: windowB.until },
    },
    capability,
    totals: {
      a: totalsA,
      b: totalsB,
      delta: {
        total: totalsB.total - totalsA.total,
        success: totalsB.success - totalsA.success,
        failure: totalsB.failure - totalsA.failure,
        feedback: totalsB.feedback - totalsA.feedback,
        correctiveFeedback: totalsB.correctiveFeedback - totalsA.correctiveFeedback,
        successRate: totalsA.successRate === null || totalsB.successRate === null
          ? null
          : Math.round((totalsB.successRate - totalsA.successRate) * 1000) / 1000,
      },
    },
    byCapability,
    capabilitiesTruncated: allRows.length > byCapability.length,
    changed: totalsB.total !== totalsA.total
      || totalsB.success !== totalsA.success
      || totalsB.failure !== totalsA.failure
      || allRows.some((row) => row.delta.total !== 0 || row.delta.success !== 0 || row.delta.failure !== 0),
    limitations: [
      'Each window is a separate filter over the same stored records. A difference between them is a difference in what was recorded, not proof that one window caused the other.',
      ...(overlap
        ? ['The two windows overlap, so an event can be counted in both; their totals are not disjoint.']
        : ['The two windows do not overlap, so no event is counted twice.']),
      ...(totalsA.undated > 0 || totalsB.undated > 0
        ? ['Undated records are counted separately and are not placed in either window.']
        : []),
      ...(allRows.length > byCapability.length
        ? [`The per-capability list is bounded to ${MAX_TEMPORAL_CAPABILITIES} rows; ${allRows.length - byCapability.length} further capability group(s) are counted in the totals.`]
        : []),
    ],
  };
}

// ---- bounded summary for world state and model context ----------------------

export function summarizeTemporal({ view, patterns, adaptations = null } = {}) {
  if (!view) throw new ValidationError('a temporal view is required for a summary');
  const top = view.byCapability.slice(0, 5).map((group) => ({
    capability: group.capability,
    total: group.total,
    success: group.success,
    failure: group.failure,
    trend: group.trend,
    outcomeChanged: group.outcomeChanged,
    lastAt: group.lastAt,
  }));
  const named = (patterns?.patterns ?? []).slice(0, 5).map((pattern) => ({
    kind: pattern.kind,
    capability: pattern.capability,
    supporting: pattern.counts.supporting,
    contradicting: pattern.counts.contradicting,
  }));
  const limitations = [
    'A pattern describes recorded order, not cause, and never a prediction.',
    'Nothing in this summary becomes an adaptation; adaptations still require the user\'s corrective feedback and approval.',
  ];
  if (view.counts.undated > 0) {
    limitations.push(`${view.counts.undated} experience record(s) have no usable timestamp and are not placed in the window.`);
  }
  if (view.counts.superseded > 0) {
    limitations.push(`${view.counts.superseded} experience record(s) in the window were corrected by a later record; the correction is reported, not hidden.`);
  }
  if (view.capabilitiesTruncated || (patterns?.truncated ?? false)) {
    limitations.push('The summary is bounded: some capabilities or patterns are counted but not listed.');
  }
  return {
    schema: TEMPORAL_SCHEMA,
    window: view.window,
    counts: {
      events: view.counts.inWindow,
      stored: view.counts.storedExperiences,
      undated: view.counts.undated,
      live: view.counts.live,
      superseded: view.counts.superseded,
      success: view.counts.success,
      failure: view.counts.failure,
      successRate: view.counts.successRate,
      automatic: view.counts.automatic,
      explicit: view.counts.explicit,
      correctiveFeedback: view.counts.correctiveFeedback,
      patterns: patterns?.total ?? 0,
    },
    capabilities: top,
    capabilitiesTruncated: view.byCapability.length > top.length,
    patterns: named,
    patternsTruncated: patterns?.truncated ?? false,
    adaptations: adaptations ?? null,
    stages: [...IMPLEMENTED_STAGES],
    causal: false,
    prediction: false,
    limitations,
  };
}

// ---- rendering --------------------------------------------------------------

function clockOf(isoText) {
  return typeof isoText === 'string' ? isoText.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z') : 'unknown time';
}

function feedbackPhrase(event) {
  if (event.feedback.current === 0) {
    return event.feedback.corrected > 0 ? `${event.feedback.corrected} corrected feedback record(s)` : 'no feedback';
  }
  return `${event.feedback.current} current feedback record(s)${event.feedback.corrective > 0 ? `, ${event.feedback.corrective} corrective` : ''}${event.feedback.corrected > 0 ? `, ${event.feedback.corrected} corrected` : ''}`;
}

function capturePhrase(capture) {
  if (capture === 'automatic') return 'captured automatically';
  if (capture === 'explicit') return 'recorded by you';
  return 'capture provenance unknown';
}

export function renderTimeline(view) {
  const lines = [`Experience timeline (read-only; derived from stored records; window ${view.window.since} to ${view.window.until}, inclusive)`];
  lines.push(`  Events:         ${view.counts.inWindow} dated event(s) in the window, ${view.counts.undated} undated; ${view.counts.live} live, ${view.counts.superseded} corrected by a later record`);
  lines.push(`  Outcomes:       ${view.counts.success} success, ${view.counts.failure} failure, ${view.counts.blocked} refused, ${view.counts.other + view.counts.unknown} other/unknown${view.counts.successRate === null ? '' : ` (success rate ${(view.counts.successRate * 100).toFixed(0)}% of classified)`}`);
  lines.push(`  Provenance:     ${view.counts.automatic} captured automatically, ${view.counts.explicit} recorded by you${view.counts.unknownCapture > 0 ? `, ${view.counts.unknownCapture} with capture provenance no writer produces` : ''}`);
  lines.push(`  Feedback:       ${view.counts.feedback} current record(s), ${view.counts.correctiveFeedback} corrective`);
  if (view.events.length === 0) {
    lines.push('  (no dated experience falls inside this window)');
  } else {
    lines.push(`  Newest first${view.events.length < view.counts.inWindow ? ` (the most recent ${view.events.length} of ${view.counts.inWindow}; the output is bounded)` : ''}:`);
    for (const event of [...view.events].reverse()) {
      const state = event.superseded ? ' [corrected by a later record]' : '';
      lines.push(`    [${shortId(event.id)}] ${clockOf(event.occurredAt)} (${event.timeSource}) ${event.capability ?? 'unscoped'} | ${event.outcome ?? 'unknown'}${state}`);
      lines.push(`        audit: ${shortId(event.operationId)} | ${capturePhrase(event.capture)} | ${feedbackPhrase(event)}`);
      if (event.replaces.length > 0 || event.replacedBy.length > 0) {
        lines.push(`        corrections: replaces ${event.replaces.map(shortId).join(', ') || 'none'}; replaced by ${event.replacedBy.map(shortId).join(', ') || 'none'}`);
      }
    }
  }
  if (view.undated.length > 0) {
    lines.push(`  Undated records (no usable timestamp; not placed in the window${view.counts.undated > view.undated.length ? `; first ${view.undated.length} of ${view.counts.undated}` : ''}):`);
    for (const event of view.undated) {
      lines.push(`    [${shortId(event.id)}] ${event.capability ?? 'unscoped'} | ${event.outcome ?? 'unknown'} | audit ${shortId(event.operationId)} | ${capturePhrase(event.capture)}`);
    }
  }
  if (view.capabilitiesTruncated) {
    lines.push(`  (${view.byCapability.length} of the window's capability groups are shown; older groups are counted but not listed)`);
  }
  lines.push('  Limits:');
  for (const limit of view.limitations) lines.push(`    - ${limit}`);
  return lines.join('\n');
}

export function renderTrends(view) {
  const lines = [`Experience trends (read-only; derived from stored records; window ${view.window.since} to ${view.window.until}, inclusive)`];
  lines.push(`  Totals:         ${view.counts.inWindow} dated event(s); ${view.counts.success} success, ${view.counts.failure} failure, ${view.counts.blocked} refused, ${view.counts.other + view.counts.unknown} other/unknown${view.counts.successRate === null ? '' : ` (success rate ${(view.counts.successRate * 100).toFixed(0)}%)`}`);
  lines.push(`  Feedback:       ${view.counts.feedback} current record(s), ${view.counts.correctiveFeedback} corrective; ${view.counts.superseded} experience(s) corrected by a later record`);
  if (view.byCapability.length === 0) {
    lines.push('  (no dated experience in this window, so no capability has a trend)');
  } else {
    lines.push('  By capability (largest first):');
    for (const group of view.byCapability) {
      const rate = group.successRate === null ? 'no classified outcome' : `${(group.successRate * 100).toFixed(0)}% success`;
      lines.push(`    ${group.capability}: ${group.total} event(s) | ${group.success} success, ${group.failure} failure, ${group.blocked} refused, ${group.other + group.unknown} other | ${rate} | trend ${group.trend}${group.outcomeChanged ? ` | outcome changed from ${group.firstClass} to ${group.lastClass}` : ''}`);
      lines.push(`        first ${clockOf(group.firstAt)} | last ${clockOf(group.lastAt)} | ${group.automatic} automatic, ${group.explicit} explicit | ${group.feedback} current feedback, ${group.correctiveFeedback} corrective`);
    }
  }
  if (view.capabilitiesTruncated) {
    lines.push(`  (the list is bounded to ${MAX_TEMPORAL_CAPABILITIES} capability group(s); more exist in the window)`);
  }
  lines.push('  Limits:');
  for (const limit of view.limitations) lines.push(`    - ${limit}`);
  return lines.join('\n');
}

export function renderPatterns(view, detection) {
  const lines = [`Experience patterns (read-only; descriptions of recorded order, not causes; window ${view.window.since} to ${view.window.until}, inclusive)`];
  lines.push(`  Thresholds:     at least ${detection.minEvents} dated event(s) for a sequence; at least ${detection.minCorrections} current corrective feedback record(s) for recurring corrections`);
  if (detection.patterns.length === 0) {
    lines.push('  (no pattern meets its threshold in this window)');
  } else {
    for (const pattern of detection.patterns) {
      lines.push(`  [${pattern.kind}] ${pattern.capability ?? 'all capabilities'}: ${pattern.explanation}`);
      lines.push(`      evidence: ${pattern.evidence.experienceIds.length} experience(s)${pattern.evidence.truncated ? ` (first ${pattern.evidence.experienceIds.length} shown)` : ''}${pattern.feedbackIds.length > 0 ? `, ${pattern.feedbackIds.length} feedback record(s)` : ''}`);
      if (pattern.counterEvidence.experienceIds.length > 0) {
        lines.push(`      contradicting: ${pattern.counts.contradicting} event(s) with a different outcome${pattern.counterEvidence.truncated ? ` (first ${pattern.counterEvidence.experienceIds.length} shown)` : ''}`);
      }
      lines.push(`      basis: ${pattern.counts.automatic} captured automatically, ${pattern.counts.explicit} recorded by you${pattern.counts.unknownCapture > 0 ? `, ${pattern.counts.unknownCapture} unknown capture` : ''}; ${pattern.basis}`);
      lines.push(`      threshold: ${pattern.threshold}`);
      for (const limitation of pattern.limitations) lines.push(`      limitation: ${truncate(limitation, MAX_LIMITATION_CHARS)}`);
    }
  }
  if (detection.truncated) {
    lines.push(`  (${detection.total} pattern(s) met their thresholds; the first ${detection.patterns.length} are shown)`);
  }
  lines.push('  This is not an adaptation and not a prediction. No pattern approves a rule, changes a behaviour, or shows that one event caused another.');
  return lines.join('\n');
}

export function renderComparison(comparison) {
  const lines = ['Experience comparison (read-only; two windows over the same stored records)'];
  lines.push(`  Window A:       ${comparison.windows.a.since} to ${comparison.windows.a.until} (inclusive)`);
  lines.push(`  Window B:       ${comparison.windows.b.since} to ${comparison.windows.b.until} (inclusive)`);
  const rate = (value) => (value === null ? 'no classified outcome' : `${(value * 100).toFixed(0)}%`);
  const side = (label, totals) => `${label}: ${totals.total} event(s), ${totals.success} success, ${totals.failure} failure | ${rate(totals.successRate)} | ${totals.feedback} current feedback, ${totals.correctiveFeedback} corrective`;
  lines.push(`  ${side('A', comparison.totals.a)}`);
  lines.push(`  ${side('B', comparison.totals.b)}`);
  const d = comparison.totals.delta;
  lines.push(`  Change:         ${d.total >= 0 ? '+' : ''}${d.total} event(s), ${d.success >= 0 ? '+' : ''}${d.success} success, ${d.failure >= 0 ? '+' : ''}${d.failure} failure${d.successRate === null ? '' : `, success rate ${d.successRate >= 0 ? '+' : ''}${(d.successRate * 100).toFixed(0)} points`}`);
  if (comparison.byCapability.length === 0) {
    lines.push('  (neither window contains a dated experience)');
  } else {
    lines.push('  By capability (largest change first):');
    for (const row of comparison.byCapability) {
      const deltaRate = row.delta.successRate === null ? 'rate not comparable' : `rate ${row.delta.successRate >= 0 ? '+' : ''}${(row.delta.successRate * 100).toFixed(0)} points`;
      lines.push(`    ${row.capability}: A ${row.a.total} event(s) / ${rate(row.a.successRate)}, B ${row.b.total} event(s) / ${rate(row.b.successRate)} | ${deltaRate}`);
    }
    if (comparison.capabilitiesTruncated) {
      lines.push(`    (the per-capability list is bounded to ${MAX_TEMPORAL_CAPABILITIES} rows; further groups are counted in the totals)`);
    }
  }
  lines.push(`  Changed:        ${comparison.changed ? 'yes, in what was recorded' : 'no difference in the recorded counts'}`);
  lines.push('  Limits:');
  for (const limitation of comparison.limitations) lines.push(`    - ${limitation}`);
  return lines.join('\n');
}

// The audit record keeps counts, ids, and the window; never a subject, feedback guidance, or any
// other user text. This is the same minimization rule the other read actions follow.
export function temporalAuditShape(view) {
  return {
    schema: view.schema,
    window: view.window,
    capability: view.capability,
    counts: view.counts,
    eventIds: view.events.map((event) => event.id),
    operationIds: view.events.map((event) => event.operationId),
    undatedIds: view.undated.map((event) => event.id),
    capabilities: view.byCapability.map((group) => ({
      capability: group.capability,
      total: group.total,
      success: group.success,
      failure: group.failure,
      trend: group.trend,
    })),
    capabilitiesTruncated: view.capabilitiesTruncated,
    limits: view.limitations.length,
  };
}

export function patternsAuditShape(view, detection) {
  return {
    schema: view.schema,
    window: view.window,
    capability: view.capability,
    counts: view.counts,
    minEvents: detection.minEvents,
    minCorrections: detection.minCorrections,
    total: detection.total,
    truncated: detection.truncated,
    patterns: detection.patterns.map((pattern) => ({
      kind: pattern.kind,
      capability: pattern.capability,
      supporting: pattern.counts.supporting,
      contradicting: pattern.counts.contradicting,
      experienceIds: pattern.evidence.experienceIds,
      feedbackIds: pattern.feedbackIds,
    })),
  };
}

export function comparisonAuditShape(comparison) {
  return {
    schema: comparison.schema,
    windows: comparison.windows,
    capability: comparison.capability,
    totals: comparison.totals,
    byCapability: comparison.byCapability.map((row) => ({
      capability: row.capability,
      a: row.a,
      b: row.b,
      delta: row.delta,
    })),
    changed: comparison.changed,
    capabilitiesTruncated: comparison.capabilitiesTruncated,
    limits: comparison.limitations.length,
  };
}
