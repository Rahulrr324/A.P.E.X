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

// Exported because a record that cites a pattern has to be validated against the same closed
// vocabulary that produced it; a private copy here and a copy elsewhere would drift.
export const PATTERN_KINDS = Object.freeze([
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
  'No pattern becomes an adaptation. A behaviour rule needs the user\'s corrective feedback or a completed evaluation of a recorded prediction, and an explicit user approval in every case.',
  'Events are ordered by finishedAt, then requestedAt, then createdAt; equal timestamps keep their append-only log order. Undated records are never placed in a window.',
  'A success rate is computed over completed attempts (success or failure). Refused, other, and unknown outcomes are counted but are not attempts, so they neither raise nor lower the rate.',
  'An experience a later record replaced is reported in the timeline and counts, but it is not current evidence and is excluded from every pattern, which says how many it left out.',
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

// A date-and-time without a zone is ambiguous: `Date.parse` reads it in the machine's local time,
// so the same stored text would order differently on two machines and across a DST change. Date-only
// values are already read as UTC; a zone-less date-and-time is read as UTC for the same reason.
// Writers store `toISOString()` values, so this only affects hand-edited or external records.
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

export function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const candidate = ZONELESS_DATETIME.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const ms = Date.parse(candidate);
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

// Code-point order, not locale order: the same records must sort the same way on every machine.
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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

// A success rate is computed over attempts: events that ended in success or failure. A refusal,
// an unclassified outcome, and an event with no outcome were not attempts, so counting them as
// failures would understate the rate and counting them as successes would overstate it. They are
// still reported in their own counts. The trend uses the same denominator, so a reported rate and
// a reported trend cannot disagree about the same events.
function finalizeCounts(counts) {
  const attempts = counts.success + counts.failure;
  return {
    ...counts,
    attempts,
    successRate: attempts === 0 ? null : Math.round((counts.success / attempts) * 1000) / 1000,
  };
}

// One grouping of the same records for one window. Everything a query reports is built from this,
// so two windows are always aggregated the same way.
function aggregate(dated) {
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
    .sort((a, b) => b.total - a.total || compareNames(a.capability, b.capability));

  const totals = finalizeCounts(dated.reduce((acc, event) => {
    addToCounts(acc, event);
    return acc;
  }, newCounts()));

  return { byCapability, totals };
}

// The whole log, prepared once for one read of it.
//
// Every field below is window-independent: the event shape of each record, which capability bucket it
// belongs to, the order inside that bucket, the two correction indexes, and the id lookups. They used to
// be rebuilt inside every window query, so a query cost time proportional to the size of the store even
// when it returned nothing - and the prediction ledger runs one query per recorded prediction, which is
// how a planning read came to cost predictions x experiences. Preparing once makes a window query a
// bounded range read over the records that actually answer it.
//
// This is not a cache of results and not derived state: it is keyed on the record array it was built
// from, it is rebuilt whenever that array or the inputs that shape it differ, it is never written to a
// store, and it cannot outlive the read that made it.
const PREPARATIONS = new WeakMap();
const FULL_WINDOW = { sinceMs: Number.MIN_SAFE_INTEGER, untilMs: Number.MAX_SAFE_INTEGER };
const EMPTY_MS = new Float64Array(0);
const EMPTY_BUCKET = Object.freeze({ sorted: [], byFile: [], undated: [], ms: EMPTY_MS });

function normalizePosition(experiences, suppliedPosition) {
  // Order within one timestamp comes from the append-only log. The store passes a position map
  // covering every record kind; when it does not, experience order stands in for it.
  const position = suppliedPosition ?? new Map();
  if (!suppliedPosition) {
    for (const experience of experiences) position.set(experience.id, position.size);
  }
  return position;
}

function groupFeedback(feedback) {
  const byExperience = new Map();
  for (const entry of feedback) {
    const list = byExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    byExperience.set(entry.experienceId, list);
  }
  return byExperience;
}

function lowerBound(ms, value) {
  let lo = 0;
  let hi = ms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function upperBound(ms, value) {
  let lo = 0;
  let hi = ms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function prepareTemporal({
  experiences = [],
  feedback = [],
  adaptations = [],
  retiredFeedback = new Set(),
  position: suppliedPosition = null,
} = {}) {
  const position = normalizePosition(experiences, suppliedPosition);
  const feedbackByExperience = groupFeedback(feedback);
  const events = experiences.map((experience) => {
    const event = buildEvent(experience, { feedbackByExperience, retiredFeedback, position, window: FULL_WINDOW });
    // The instant the bucket order was built over, kept off the enumerable shape: a range search
    // compares it, and a report must not gain a field the record itself never had.
    Object.defineProperty(event, 'timeMs', { value: eventTime(experience).ms, enumerable: false });
    return event;
  });
  const buckets = new Map();
  const all = { sorted: [], byFile: [], undated: [] };
  const bucketFor = (key) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sorted: [], byFile: [], undated: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const event of events) {
    const bucket = bucketFor(event.capability);
    if (event.undated) {
      bucket.undated.push(event);
      all.undated.push(event);
      continue;
    }
    bucket.sorted.push(event);
    bucket.byFile.push(event);
    all.sorted.push(event);
    all.byFile.push(event);
  }
  for (const bucket of [...buckets.values(), all]) {
    bucket.sorted.sort(compareEvents);
    bucket.undated.sort(compareEvents);
    bucket.ms = Float64Array.from(bucket.sorted.map((event) => event.timeMs));
  }
  const corrections = feedbackIndex(experiences, feedback, retiredFeedback, position);
  const flat = (map) => [...map.values()].flat().sort(compareCorrections);
  return {
    // The inputs that shape this structure, apart from the records array it is keyed on. A caller that
    // supplies no position map gets the position derived from the records, so it is reported as absent
    // here and rebuilt the same way next time.
    signature: `${feedback.length}:${retiredFeedback.size ?? retiredFeedback.length ?? 0}:${suppliedPosition ? suppliedPosition.size : 0}:${adaptations.length}`,
    position,
    all: { ...all, ms: all.ms ?? EMPTY_MS },
    buckets,
    corrections,
    correctionsAll: { current: flat(corrections.current), corrected: flat(corrections.corrected) },
    experienceById: new Map(experiences.map((record) => [record.id, record])),
    feedbackById: new Map(feedback.map((record) => [record.id, record])),
  };
}

export function temporalPreparation(source = {}) {
  const key = Array.isArray(source.experiences) ? source.experiences : null;
  if (!key) return prepareTemporal(source);
  const built = PREPARATIONS.get(key);
  if (built && built.signature === preparedSignature(source)) return built;
  const prep = prepareTemporal(source);
  PREPARATIONS.set(key, prep);
  return prep;
}

// The inputs that would change a prepared structure, apart from the records themselves. Checked on
// reuse so a hand-built source cannot read a preparation that describes different feedback, different
// retirements, or a different log position.
function preparedSignature(source) {
  const retired = source.retiredFeedback;
  const retiredCount = retired ? (retired.size ?? retired.length ?? 0) : 0;
  const feedback = source.feedback ?? [];
  const position = source.position;
  const adaptations = source.adaptations ?? [];
  return `${feedback.length}:${retiredCount}:${position ? position.size : 0}:${adaptations.length}`;
}

// One window over a prepared log. `dated` is the range the window selects, in the order the records
// sort into; `outside` is only materialized for a reader that asks for the records themselves, because
// every consumer of this answer needs their count and none needs the list.
function sliceFromPreparation(prep, { window, capability }) {
  const bucket = capability ? (prep.buckets.get(capability) ?? EMPTY_BUCKET) : prep.all;
  const lo = lowerBound(bucket.ms, window.sinceMs);
  const hi = upperBound(bucket.ms, window.untilMs);
  const dated = hi > lo ? bucket.sorted.slice(lo, hi) : [];
  const outsideCount = bucket.sorted.length - (hi - lo);
  const slice = {
    dated,
    undated: bucket.undated,
    outsideCount,
    ...aggregate(dated),
  };
  Object.defineProperty(slice, 'outside', {
    enumerable: true,
    configurable: true,
    get() {
      return bucket.byFile
        .filter((event) => event.timeMs !== null && (event.timeMs < window.sinceMs || event.timeMs > window.untilMs))
        .map((event) => ({ ...event, inWindow: false }));
    },
  });
  return slice;
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

function compareCorrections(a, b) {
  if (a.ms === null && b.ms === null) return (a.logPosition ?? 0) - (b.logPosition ?? 0);
  if (a.ms === null) return 1;
  if (b.ms === null) return -1;
  if (a.ms !== b.ms) return a.ms - b.ms;
  return (a.logPosition ?? 0) - (b.logPosition ?? 0);
}

// Two indexes over the same corrective feedback. `current` supports patterns; `corrected` holds
// feedback a later feedback record superseded, which no longer supports anything. Both are returned
// so the read can say how many were left out instead of silently counting fewer.
function feedbackIndex(experiences, feedback, retiredFeedback, position) {
  const byExperience = new Map();
  for (const entry of feedback) {
    const list = byExperience.get(entry.experienceId) ?? [];
    list.push(entry);
    byExperience.set(entry.experienceId, list);
  }
  const current = new Map();
  const corrected = new Map();
  for (const experience of experiences) {
    for (const entry of byExperience.get(experience.id) ?? []) {
      if (!isCorrectiveAssessment(entry.assessment)) continue;
      const target = retiredFeedback.has(entry.id) ? corrected : current;
      const item = {
        id: entry.id,
        experienceId: experience.id,
        capability: experience.capability ?? null,
        assessment: entry.assessment,
        createdAt: entry.createdAt ?? null,
        ms: parseInstant(entry.createdAt),
        logPosition: position.get(entry.id) ?? null,
        // The experience a feedback record assesses may itself have been replaced. The feedback
        // stays readable, but it is not current evidence about the current record.
        experienceSuperseded: experience.superseded === true,
      };
      const list = target.get(item.capability) ?? [];
      list.push(item);
      target.set(item.capability, list);
    }
  }
  for (const list of current.values()) list.sort(compareCorrections);
  for (const list of corrected.values()) list.sort(compareCorrections);
  return { current, corrected };
}

// ---- patterns ---------------------------------------------------------------

function evidenceOf(events) {
  const ids = events.slice(0, MAX_PATTERN_EVIDENCE).map((event) => event.id);
  return { experienceIds: ids, truncated: events.length > ids.length };
}

// Every pattern separates the live dated events it examined into three disjoint groups:
//
//   supporting     records that meet the rule the pattern states
//   contradicting  records that count against that rule
//   excluded       records the rule does not use and that do not refute it
//
// An outcome that merely differs from the rule's evidence is not counter-evidence. An earlier
// failure does not contradict "the three most recent events are successes", and an experience the
// user never assessed does not contradict "two corrective records exist". Calling such records
// contradicting overstates the disagreement; dropping them hides it. They are listed as excluded
// with the reason, their count is always reported in full, and only their ids are bounded.
function patternBase({
  kind,
  capability,
  window,
  events,
  supporting,
  contradicting = [],
  excludedReason = null,
  feedbackIds = [],
  basis,
}) {
  const used = new Set([...supporting, ...contradicting].map((event) => event.id));
  const excluded = events.filter((event) => !used.has(event.id));
  const automatic = supporting.filter((event) => event.capture === 'automatic').length;
  const explicit = supporting.filter((event) => event.capture === 'explicit').length;
  const shownFeedback = feedbackIds.slice(0, MAX_PATTERN_EVIDENCE);
  return {
    stage: 'pattern',
    kind,
    capability,
    basis,
    window: { since: window.since, until: window.until },
    evidence: evidenceOf(supporting),
    feedbackIds: shownFeedback,
    feedbackCount: feedbackIds.length,
    feedbackTruncated: feedbackIds.length > shownFeedback.length,
    counterEvidence: evidenceOf(contradicting),
    excludedEvidence: evidenceOf(excluded),
    excludedReason: excluded.length > 0 ? excludedReason : null,
    counts: {
      supporting: supporting.length,
      contradicting: contradicting.length,
      excluded: excluded.length,
      feedback: feedbackIds.length,
      automatic,
      explicit,
      unknownCapture: supporting.length - automatic - explicit,
      evaluated: events.length,
    },
    supportTruncated: supporting.length > MAX_PATTERN_EVIDENCE,
    counterTruncated: contradicting.length > MAX_PATTERN_EVIDENCE,
    excludedTruncated: excluded.length > MAX_PATTERN_EVIDENCE,
    causal: false,
    adaptation: false,
  };
}

function streakPattern({ kind, label, capability, window, events, expected, min = MIN_PATTERN_EVENTS }) {
  const recent = events.slice(-min);
  if (recent.length < min) return null;
  if (!recent.every((event) => event.outcomeClass === expected)) return null;
  const pattern = patternBase({
    kind,
    capability,
    window,
    events,
    supporting: recent,
    excludedReason: `recorded before the most recent ${min}; the rule names only the most recent ${min}`,
    basis: 'recorded_experiences',
  });
  pattern.threshold = `the ${min} most recent dated events in this window all record ${expected}`;
  pattern.explanation = `${min} consecutive recorded ${expected} outcome(s) ending at ${recent.at(-1).occurredAt}`;
  pattern.limitations = [
    `${label} describes these ${min} recorded events. It does not show why they ended that way, and a different set of events may exist outside this window.`,
    ...(pattern.counts.excluded > 0
      ? [`${pattern.counts.excluded} other recorded event(s) in the window fall outside this run and are listed as excluded, not as counter-evidence; they neither support nor refute it.`]
      : []),
  ];
  return pattern;
}

function alternatingPattern({ capability, window, events }) {
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
    excludedReason: 'outside the alternating run, or an outcome that is neither success nor failure',
    basis: 'recorded_experiences',
  });
  pattern.threshold = 'at least 4 consecutive dated success/failure outcomes with no two adjacent classes equal';
  pattern.explanation = `${run.length} consecutive recorded success/failure outcomes alternate between success and failure`;
  pattern.limitations = [
    'Alternation is a description of the recorded order, not evidence of a cycle or a rule. It does not predict that the next outcome alternates, and it does not show cause.',
    ...(pattern.counts.excluded > 0
      ? [`${pattern.counts.excluded} recorded event(s) are outside the run or have another outcome; they are listed as excluded, not as counter-evidence.`]
      : []),
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
    // A correction of an experience a later record replaced is not current evidence.
    if (correction.experienceSuperseded) continue;
    const later = events.filter((event) => {
      const ms = parseInstant(event.occurredAt);
      return event.id !== correction.experienceId && ms !== null && ms > correction.ms;
    });
    const laterSuccesses = later.filter((event) => event.outcomeClass === 'success');
    if (laterSuccesses.length === 0) continue;
    const laterFailures = later.filter((event) => event.outcomeClass === 'failure');
    const corrected = events.find((event) => event.id === correction.experienceId);
    const supporting = corrected ? [corrected, ...laterSuccesses] : laterSuccesses;
    const pattern = patternBase({
      kind: 'improvement_after_correction',
      capability,
      window,
      events,
      supporting,
      contradicting: laterFailures,
      excludedReason: 'recorded before or at the correction, or after it with a refused or unclassified outcome',
      feedbackIds: [correction.id],
      basis: 'mixed',
    });
    pattern.threshold = 'one current corrective feedback record followed by at least one recorded success in the same capability';
    pattern.explanation = `a corrective feedback record from ${correction.createdAt} is followed by ${laterSuccesses.length} recorded success(es)`;
    pattern.limitations = [
      'A later success is not proof that the user correction caused it. Other changes between the two events are not represented here.',
      'Only current corrective feedback is considered; corrected feedback remains readable but no longer supports or contradicts this pattern.',
      'The corrected event is counted once and is never later evidence for its own correction.',
      'A later refused or unclassified event is listed as excluded, not as counter-evidence: it was not a failed attempt.',
      ...(corrected
        ? []
        : ['The experience this correction assesses is not in this dated window (it may be earlier, undated, or replaced), so only the later events are listed as evidence.']),
    ];
    return pattern;
  }
  return null;
}

function correctionPattern({ capability, window, events, corrections, correctedFeedback = [] }) {
  const inWindow = corrections.filter((correction) => correction.ms !== null
    && correction.ms >= window.sinceMs
    && correction.ms <= window.untilMs);
  // The threshold is about current feedback, so feedback on an experience a later record replaced
  // does not count. It is disclosed instead of silently reducing the count.
  const usable = inWindow.filter((correction) => !correction.experienceSuperseded);
  if (usable.length < MIN_CORRECTION_FEEDBACK) return null;
  const experienceIds = new Set(usable.map((correction) => correction.experienceId));
  const supporting = events.filter((event) => experienceIds.has(event.id));
  const replaced = inWindow.length - usable.length;
  const supersededByFeedback = correctedFeedback.filter((correction) => correction.ms !== null
    && correction.ms >= window.sinceMs
    && correction.ms <= window.untilMs).length;
  const pattern = patternBase({
    kind: 'recurring_corrections',
    capability,
    window,
    events,
    supporting,
    excludedReason: 'not assessed by a current corrective feedback record in this window',
    feedbackIds: usable.map((correction) => correction.id),
    basis: 'user_feedback',
  });
  pattern.threshold = `${MIN_CORRECTION_FEEDBACK} current corrective feedback records in the same capability and window, each assessing a record that still stands`;
  pattern.explanation = `${usable.length} corrective feedback record(s) assess experiences in this capability`;
  pattern.limitations = [
    'The feedback records are the user\'s assessments of separate events. They may concern different aspects, and their number alone does not identify a rule.',
    'A candidate adaptation still requires the deterministic derivation rule and your explicit approval.',
    ...(replaced > 0
      ? [`${replaced} corrective feedback record(s) in the window assess an experience a later record replaced and are not counted.`]
      : []),
    ...(supersededByFeedback > 0
      ? [`${supersededByFeedback} corrective feedback record(s) in the window were themselves corrected by a later feedback record and are not counted.`]
      : []),
    ...(supporting.length === 0
      ? ['The assessed experience records are outside this dated window, so the evidence is the feedback records alone.']
      : []),
  ];
  return pattern;
}

// Insufficient evidence is not a finding about outcomes; it says the window does not contain enough
// current records to describe a sequence. It keeps the query's capability scope so a filtered query
// cannot be read as a statement about every capability.
function insufficientPattern({
  capability = null,
  window,
  events,
  feedbackCount,
  replacedCount = 0,
  min = MIN_PATTERN_EVENTS,
}) {
  const pattern = patternBase({
    kind: 'insufficient_evidence',
    capability,
    window,
    events,
    supporting: events,
    basis: 'recorded_experiences',
  });
  const scope = capability ? ` for ${capability}` : '';
  pattern.threshold = `at least ${min} current dated events in the window${scope}`;
  pattern.explanation = events.length === 0
    ? `no current dated experience falls inside the window${scope}; ${feedbackCount} current corrective feedback record(s) were considered${replacedCount > 0 ? `, and ${replacedCount} event(s) were replaced by a later record` : ''}`
    : `${events.length} current dated event(s) fall inside the window${scope}, below the threshold for a sequence pattern${replacedCount > 0 ? `; ${replacedCount} replaced event(s) are not counted` : ''}`;
  pattern.limitations = [
    `A sequence pattern needs at least ${min} current dated events. Fewer events are not enough to describe a repeated or changing outcome.`,
    'Absence of a pattern is not evidence that outcomes are stable; it means this window does not contain enough current recorded events to say.',
    ...(replacedCount > 0
      ? [`${replacedCount} event(s) in the window were replaced by a later record and are not current evidence; the timeline still lists them as corrected.`]
      : []),
  ];
  return pattern;
}

export function detectPatterns({
  capability = null,
  window,
  dated,
  feedback = [],
  correctedFeedback = [],
  minEvents = MIN_PATTERN_EVENTS,
  maxPatterns = MAX_PATTERNS,
} = {}) {
  if (!window) throw new ValidationError('a window is required to detect patterns');
  const min = Number.isInteger(minEvents) && minEvents >= 2 && minEvents <= 20 ? minEvents : MIN_PATTERN_EVENTS;
  // A record a later record replaced is still listed by every other read, but it is not current
  // evidence: the correction is the current statement about that event. Patterns are built from
  // current records only, and the number left out is reported rather than dropped.
  const live = dated.filter((event) => !event.superseded);
  const replaced = dated.filter((event) => event.superseded);
  const correctionsByCapability = new Map();
  for (const item of feedback) {
    const key = item.capability ?? 'unscoped';
    const list = correctionsByCapability.get(key) ?? [];
    list.push(item);
    correctionsByCapability.set(key, list);
  }
  const correctedByCapability = new Map();
  for (const item of correctedFeedback) {
    const key = item.capability ?? 'unscoped';
    const list = correctedByCapability.get(key) ?? [];
    list.push(item);
    correctedByCapability.set(key, list);
  }

  const patterns = [];
  const groups = new Map();
  const names = new Set();
  for (const event of live) {
    const key = event.capability ?? 'unscoped';
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
    names.add(key);
  }
  // A capability whose assessed experiences fall outside the window can still have current
  // corrective feedback inside it. Its recurring-correction threshold is about the feedback, so the
  // capability must be examined even when it has no in-window event.
  for (const item of feedback) {
    if (item.ms === null || item.ms < window.sinceMs || item.ms > window.untilMs) continue;
    if (item.experienceSuperseded) continue;
    names.add(item.capability ?? 'unscoped');
  }
  const capabilities = [...names].sort(compareNames);

  for (const name of capabilities) {
    const events = groups.get(name) ?? [];
    const corrections = correctionsByCapability.get(name) ?? [];
    const corrected = correctedByCapability.get(name) ?? [];
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
        min,
      }),
      streakPattern({
        kind: 'repeated_success',
        label: 'Repeated success',
        capability: name,
        window,
        events,
        expected: 'success',
        min,
      }),
      alternatingPattern({ capability: name, window, events }),
      regressionPattern({ capability: name, window, events, min }),
      improvementPattern({ capability: name, window, events, corrections }),
      correctionPattern({ capability: name, window, events, corrections, correctedFeedback: corrected }),
    ].filter(Boolean);
    // A sequence that failed the threshold still shows in `trends` as counts. Only the patterns
    // above are named, and `minEvents` is stated in the output.
    patterns.push(...candidates);
  }

  const inWindowFeedback = feedback.filter((item) => item.ms !== null
    && item.ms >= window.sinceMs
    && item.ms <= window.untilMs
    && !item.experienceSuperseded).length;
  if (live.length < min) {
    patterns.unshift(insufficientPattern({
      capability,
      window,
      events: live,
      feedbackCount: inWindowFeedback,
      replacedCount: replaced.length,
      min,
    }));
  }

  const bounded = patterns.slice(0, Math.max(1, maxPatterns));
  return {
    patterns: bounded,
    total: patterns.length,
    truncated: patterns.length > bounded.length,
    minEvents: min,
    minCorrections: MIN_CORRECTION_FEEDBACK,
    liveEvents: live.length,
    replacedExcluded: replaced.length,
    kinds: [...PATTERN_KINDS],
  };
}

// ---- views, trends, comparison ---------------------------------------------

export function buildTemporalView({
  experiences = [],
  feedback = [],
  retiredFeedback = new Set(),
  position = null,
  window,
  capability = null,
  limit = MAX_TEMPORAL_EVENTS,
  slice = null,
} = {}) {
  if (!window) throw new ValidationError('a window is required');
  // A caller that already grouped the records for this window keeps its grouping; a caller that did
  // not gets one preparation of the log, which is the same work the previous per-view scan did.
  const scoped = slice ?? sliceFromPreparation(
    temporalPreparation({ experiences, feedback, retiredFeedback, position }),
    { window, capability },
  );
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
      outsideWindow: scoped.outsideCount ?? scoped.outside.length,
      undated: scoped.undated.length,
      live: scoped.dated.filter((event) => event.active).length,
      superseded: scoped.dated.filter((event) => event.superseded).length,
      success: totals.success,
      failure: totals.failure,
      blocked: totals.blocked,
      other: totals.other,
      unknown: totals.unknown,
      attempts: totals.attempts,
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
  const prep = temporalPreparation({ experiences, feedback, adaptations, retiredFeedback, position: suppliedPosition });
  const slice = sliceFromPreparation(prep, { window, capability });
  const view = buildTemporalView({
    experiences,
    feedback,
    retiredFeedback,
    position: prep.position,
    window,
    capability,
    limit,
    slice,
  });
  const scopedCorrections = (byCapability, flat) => (capability
    ? (byCapability.get(capability) ?? [])
    : flat);
  const allCorrections = scopedCorrections(prep.corrections.current, prep.correctionsAll.current);
  const correctedCorrections = scopedCorrections(prep.corrections.corrected, prep.correctionsAll.corrected);
  const detection = detectPatterns({
    capability,
    window,
    dated: slice.dated,
    feedback: allCorrections,
    correctedFeedback: correctedCorrections,
    minEvents,
    maxPatterns,
  });
  const inWindow = (correction) => correction.ms !== null
    && correction.ms >= window.sinceMs
    && correction.ms <= window.untilMs;
  const currentInWindow = allCorrections.filter(inWindow);
  // What the correction-based pattern could and could not use, stated as counts so a reader can
  // reconcile the pattern's feedback count with the timeline's event-level feedback counts.
  detection.feedbackScope = {
    currentInWindow: currentInWindow.length,
    onReplacedExperience: currentInWindow.filter((correction) => correction.experienceSuperseded).length,
    supersededByFeedback: correctedCorrections.filter(inWindow).length,
    undated: allCorrections.filter((correction) => correction.ms === null).length,
  };
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
  const prep = temporalPreparation({ experiences, feedback, retiredFeedback, position: suppliedPosition });
  const a = sliceFromPreparation(prep, { window: windowA, capability });
  const b = sliceFromPreparation(prep, { window: windowB, capability });
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
      return ay - ax || compareNames(x.capability, y.capability);
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
    attempts: slice.totals.attempts,
    successRate: slice.totals.successRate,
    superseded: slice.totals.superseded,
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
        superseded: totalsB.superseded - totalsA.superseded,
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
    excluded: pattern.counts.excluded,
    feedback: pattern.counts.feedback,
  }));
  const limitations = [
    'A pattern describes recorded order, not cause, and never a prediction.',
    'Nothing in this summary becomes an adaptation; every adaptation still requires the user\'s explicit approval, whether it rests on corrective feedback or on a completed evaluation of a recorded prediction.',
  ];
  if (view.counts.undated > 0) {
    limitations.push(`${view.counts.undated} experience record(s) have no usable timestamp and are not placed in the window.`);
  }
  if (view.counts.superseded > 0) {
    limitations.push(`${view.counts.superseded} experience record(s) in the window were corrected by a later record; the correction is reported, not hidden, and those records are not used by any pattern.`);
  }
  if ((patterns?.feedbackScope?.supersededByFeedback ?? 0) > 0) {
    limitations.push(`${patterns.feedbackScope.supersededByFeedback} corrective feedback record(s) in the window were themselves corrected by later feedback and do not support any pattern.`);
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
      attempts: view.counts.attempts,
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
  lines.push(`  Outcomes:       ${view.counts.success} success, ${view.counts.failure} failure, ${view.counts.blocked} refused, ${view.counts.other + view.counts.unknown} other/unknown${view.counts.successRate === null ? '' : ` (success rate ${(view.counts.successRate * 100).toFixed(0)}% of ${view.counts.attempts} completed attempt(s); refusals are not attempts)`}`);
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
  lines.push(`  Totals:         ${view.counts.inWindow} dated event(s); ${view.counts.success} success, ${view.counts.failure} failure, ${view.counts.blocked} refused, ${view.counts.other + view.counts.unknown} other/unknown${view.counts.successRate === null ? '' : ` (success rate ${(view.counts.successRate * 100).toFixed(0)}% of ${view.counts.attempts} completed attempt(s))`}`);
  lines.push(`  Feedback:       ${view.counts.feedback} current record(s), ${view.counts.correctiveFeedback} corrective; ${view.counts.superseded} experience(s) corrected by a later record`);
  if (view.byCapability.length === 0) {
    lines.push('  (no dated experience in this window, so no capability has a trend)');
  } else {
    lines.push('  By capability (largest first):');
    for (const group of view.byCapability) {
      const rate = group.successRate === null ? 'no completed attempt' : `${(group.successRate * 100).toFixed(0)}% success of ${group.attempts} attempt(s)`;
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
  lines.push(`  Thresholds:     at least ${detection.minEvents} current dated event(s) for a sequence; at least ${detection.minCorrections} current corrective feedback record(s) for recurring corrections`);
  lines.push(`  Evidence:       ${detection.liveEvents} current dated event(s) examined${detection.replacedExcluded > 0 ? `; ${detection.replacedExcluded} replaced by a later record and excluded from every pattern` : ''}; ${view.counts.undated} undated record(s) are never ordered`);
  if (detection.feedbackScope) {
    const scope = detection.feedbackScope;
    lines.push(`  Corrections:    ${scope.currentInWindow} current corrective feedback record(s) in the window${scope.onReplacedExperience > 0 ? `, ${scope.onReplacedExperience} assessing a replaced experience` : ''}${scope.supersededByFeedback > 0 ? `, ${scope.supersededByFeedback} corrected by later feedback` : ''}${scope.undated > 0 ? `; ${scope.undated} undated and not placed` : ''}`);
  }
  if (detection.patterns.length === 0) {
    lines.push('  (no pattern meets its threshold in this window)');
  } else {
    for (const pattern of detection.patterns) {
      lines.push(`  [${pattern.kind}] ${pattern.capability ?? 'all capabilities'}: ${pattern.explanation}`);
      lines.push(`      evidence: ${pattern.evidence.experienceIds.length} experience(s)${pattern.evidence.truncated ? ` (first ${pattern.evidence.experienceIds.length} shown)` : ''}${pattern.feedbackCount > 0 ? `, ${pattern.feedbackCount} feedback record(s)${pattern.feedbackTruncated ? ` (first ${pattern.feedbackIds.length} shown)` : ''}` : ''}`);
      if (pattern.counts.contradicting > 0) {
        lines.push(`      contradicting: ${pattern.counts.contradicting} event(s) count against this rule${pattern.counterEvidence.truncated ? ` (first ${pattern.counterEvidence.experienceIds.length} shown)` : ''}`);
      }
      if (pattern.counts.excluded > 0) {
        lines.push(`      excluded: ${pattern.counts.excluded} event(s) are not used by this rule and do not refute it${pattern.excludedTruncated ? ` (first ${pattern.excludedEvidence.experienceIds.length} shown)` : ''}`);
        if (pattern.excludedReason) lines.push(`      exclusion reason: ${truncate(pattern.excludedReason, MAX_LIMITATION_CHARS)}`);
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
  const rate = (value) => (value === null ? 'no completed attempt' : `${(value * 100).toFixed(0)}%`);
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
    liveEvents: detection.liveEvents,
    replacedExcluded: detection.replacedExcluded,
    feedbackScope: detection.feedbackScope ?? null,
    patterns: detection.patterns.map((pattern) => ({
      kind: pattern.kind,
      capability: pattern.capability,
      supporting: pattern.counts.supporting,
      contradicting: pattern.counts.contradicting,
      excluded: pattern.counts.excluded,
      feedback: pattern.counts.feedback,
      experienceIds: pattern.evidence.experienceIds,
      counterIds: pattern.counterEvidence.experienceIds,
      excludedIds: pattern.excludedEvidence.experienceIds,
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
