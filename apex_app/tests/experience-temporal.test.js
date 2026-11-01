// Batch AC: the temporal projection engine.
//
// These tests pin the deterministic contract of `temporal.js` with synthetic records only: no
// model, no local inference, no network. An experience fixture here stands for a stored record and
// is not evidence that any real operation happened. What is tested is what the engine does with an
// order, a window, a correction, and a repeated outcome: it reports them, bounds them, and never
// turns an order into a cause, a forecast, or an approved behaviour rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPLEMENTED_STAGES,
  MAX_PATTERN_EVIDENCE,
  MAX_TEMPORAL_EVENTS,
  MIN_PATTERN_EVENTS,
  analyzeTemporal,
  comparisonAuditShape,
  compareTemporalWindows,
  outcomeClass,
  parseInstant,
  patternsAuditShape,
  renderComparison,
  renderPatterns,
  renderTimeline,
  renderTrends,
  resolveWindow,
  summarizeTemporal,
  temporalAuditShape,
} from '../src/experience/temporal.js';
import { Outcome } from '../src/outcomes.js';

const NOW = new Date('2026-11-01T00:00:00.000Z');
let seq = 0;

// A stored experience fixture. Only the fields the projection reads are set, so a test cannot
// accidentally depend on something the engine does not consume.
function exp({
  at = null,
  outcome = Outcome.SUCCESS_VERIFIED,
  capability = 'calc.evaluate',
  capture = 'explicit',
  finishedAt = undefined,
  requestedAt = undefined,
  createdAt = undefined,
  ...rest
} = {}) {
  seq += 1;
  const base = at;
  return {
    id: rest.id ?? `exp-${String(seq).padStart(3, '0')}`,
    operationId: rest.operationId ?? `op-${String(seq).padStart(3, '0')}`,
    capability,
    outcome,
    capture,
    active: rest.active ?? true,
    superseded: rest.superseded ?? false,
    requestedAt: requestedAt === undefined ? base : requestedAt,
    finishedAt: finishedAt === undefined ? null : finishedAt,
    createdAt: createdAt === undefined ? base : createdAt,
    replaces: rest.replaces ?? [],
    replacedBy: rest.replacedBy ?? [],
    // Marker text: it must never reach an audit shape or a pattern line.
    content: rest.content ?? 'MARKER-USER-TEXT',
  };
}

function feedbackEntry({ id = `fb-${++seq}`, experienceId, assessment = 'user_correction', at = null }) {
  return { id, experienceId, assessment, createdAt: at };
}

function window(since, until) {
  return resolveWindow({ since, until, now: NOW });
}

// Consecutive dated fixtures in one capability, one per day.
function three(outcomes) {
  return outcomes.map((outcome, index) => exp({
    at: `2026-10-0${index + 1}T00:00:00.000Z`,
    outcome,
    id: `e${index + 1}`,
  }));
}

function run(experiences, { since = '2026-09-01', until = '2026-12-01', capability = null, feedback = [], retiredFeedback = new Set(), position = null, minEvents, maxPatterns, limit } = {}) {
  return analyzeTemporal({
    experiences,
    feedback,
    retiredFeedback,
    window: window(since, until),
    capability,
    position,
    minEvents,
    maxPatterns,
    limit,
  });
}

describe('AC-1 ordering and timestamps', () => {
  test('events are ordered by when they occurred, falling back through finishedAt, requestedAt, createdAt', () => {
    const late = exp({ finishedAt: '2026-10-03T00:00:00.000Z', requestedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', id: 'late' });
    const earlyRequested = exp({ finishedAt: null, requestedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-05T00:00:00.000Z', id: 'req' });
    const createdAtOnly = exp({ finishedAt: null, requestedAt: null, createdAt: '2026-10-02T00:00:00.000Z', id: 'created' });
    const noon = exp({ finishedAt: '2026-10-02T12:00:00.000Z', id: 'noon' });

    const { view } = run([late, earlyRequested, createdAtOnly, noon]);
    assert.deepEqual(view.events.map((event) => event.id), ['req', 'created', 'noon', 'late']);
    assert.deepEqual(view.events.map((event) => event.timeSource), ['requestedAt', 'createdAt', 'finishedAt', 'finishedAt']);
    assert.equal(view.counts.inWindow, 4);
  });

  test('equal timestamps keep the append-only log order supplied by the store', () => {
    const first = exp({ at: '2026-10-02T00:00:00.000Z', id: 'b' });
    const second = exp({ at: '2026-10-02T00:00:00.000Z', id: 'a' });
    const position = new Map([['b', 10], ['a', 11]]);
    const { view } = run([first, second], { position });
    assert.deepEqual(view.events.map((event) => event.id), ['b', 'a']);

    // Without a position map, array order is the stand-in, so the result is still deterministic.
    const fallback = run([first, second]);
    assert.deepEqual(fallback.view.events.map((event) => event.id), ['b', 'a']);
  });

  test('time zone offsets normalize to one instant instead of sorting by text', () => {
    const zulu = exp({ at: '2026-10-02T00:00:00.000Z', id: 'z' });
    const plusFive = exp({ at: '2026-10-02T05:00:00.000+05:00', id: 'p' });
    const { view } = run([plusFive, zulu]);
    assert.equal(view.events[0].occurredAt, '2026-10-02T00:00:00.000Z');
    assert.equal(view.events[1].occurredAt, '2026-10-02T00:00:00.000Z');
    const position = new Map([['p', 1], ['z', 2]]);
    assert.deepEqual(run([plusFive, zulu], { position }).view.events.map((event) => event.id), ['p', 'z']);
  });

  test('missing and invalid timestamps are undated, never placed in a window, and always listed', () => {
    const noStamps = exp({ finishedAt: null, requestedAt: null, createdAt: null, id: 'none' });
    const invalid = exp({ finishedAt: 'not-a-date', requestedAt: 'not-a-date', createdAt: 'not-a-date', id: 'bad' });
    const dated = exp({ at: '2026-10-02T00:00:00.000Z', id: 'ok' });
    const { view, patterns } = run([noStamps, invalid, dated]);
    assert.equal(view.counts.inWindow, 1);
    assert.equal(view.counts.undated, 2);
    assert.deepEqual(view.undated.map((event) => event.id).sort(), ['bad', 'none']);
    assert.equal(view.undated.every((event) => event.occurredAt === null && event.undated === true), true);
    assert.equal(patterns.total, 1);
    assert.equal(patterns.patterns[0].kind, 'insufficient_evidence');
  });

  test('date-only bounds are read in UTC and include the whole final day', () => {
    const insideStart = exp({ at: '2026-10-01T00:00:00.000Z', id: 'start' });
    const insideEnd = exp({ at: '2026-10-02T23:59:59.999Z', id: 'end' });
    const afterEnd = exp({ at: '2026-10-03T00:00:00.000Z', id: 'after' });
    const { view } = run([insideStart, insideEnd, afterEnd], { since: '2026-10-01', until: '2026-10-02' });
    assert.deepEqual(view.events.map((event) => event.id), ['start', 'end']);
    assert.equal(view.counts.outsideWindow, 1);
  });

  test('an explicit bound wins over days, and an invalid window is refused', () => {
    const w = resolveWindow({ since: '2026-10-01T00:00:00.000Z', days: 1, now: NOW });
    assert.equal(w.since, '2026-10-01T00:00:00.000Z');
    assert.equal(w.until, '2026-11-01T00:00:00.000Z');
    assert.equal(w.bounded, true);
    assert.throws(() => resolveWindow({ since: '2026-12-01', until: '2026-11-01', now: NOW }), /start of the window is after its end/);
    assert.throws(() => resolveWindow({ days: 0, now: NOW }), /days must be an integer/);
    assert.throws(() => resolveWindow({ since: 'yesterday-ish', now: NOW }), /not a recognizable time/);
  });

  test('the default window is the last 30 days ending at the supplied clock', () => {
    const w = resolveWindow({ now: new Date('2026-11-01T00:00:00.000Z') });
    assert.equal(w.since, '2026-10-02T00:00:00.000Z');
    assert.equal(w.until, '2026-11-01T00:00:00.000Z');
    assert.equal(w.days, null);
    assert.equal(w.bounded, false);
  });
});

describe('AC-2 corrections, supersession, and feedback', () => {
  test('a corrected experience stays readable, is marked, and carries both directions of the correction', () => {
    const old = exp({ at: '2026-10-01T00:00:00.000Z', id: 'old', superseded: true, active: false, replacedBy: ['new'] });
    const replacement = exp({ at: '2026-10-02T00:00:00.000Z', id: 'new', replaces: ['old'] });
    const { view } = run([old, replacement]);
    assert.equal(view.counts.superseded, 1);
    const shownOld = view.events.find((event) => event.id === 'old');
    assert.equal(shownOld.superseded, true);
    assert.deepEqual(shownOld.replacedBy, ['new']);
    assert.deepEqual(view.events.find((event) => event.id === 'new').replaces, ['old']);
    assert.match(renderTimeline(view), /\[corrected by a later record\]/);
  });

  test('corrected feedback no longer counts as current, but the correction is still reported', () => {
    const event = exp({ at: '2026-10-01T00:00:00.000Z', id: 'e1' });
    const current = feedbackEntry({ id: 'fb-current', experienceId: 'e1', assessment: 'incorrect', at: '2026-10-02T00:00:00.000Z' });
    const retired = feedbackEntry({ id: 'fb-retired', experienceId: 'e1', assessment: 'user_correction', at: '2026-10-03T00:00:00.000Z' });
    const { view } = run([event], { feedback: [current, retired], retiredFeedback: new Set(['fb-retired']) });
    const shown = view.events[0];
    assert.equal(shown.feedback.current, 1);
    assert.equal(shown.feedback.corrected, 1);
    assert.equal(shown.feedback.corrective, 1);
    assert.equal(view.counts.feedback, 1);
    assert.equal(view.counts.correctiveFeedback, 1);
  });

  test('only a corrective assessment supports a correction pattern; an assessment that agrees does not', () => {
    const e1 = exp({ at: '2026-10-01T00:00:00.000Z', id: 'e1' });
    const e2 = exp({ at: '2026-10-02T00:00:00.000Z', id: 'e2' });
    const agreeing = feedbackEntry({ id: 'fb-ok', experienceId: 'e1', assessment: 'correct', at: '2026-10-03T00:00:00.000Z' });
    const corrective = feedbackEntry({ id: 'fb-bad', experienceId: 'e2', assessment: 'not_useful', at: '2026-10-04T00:00:00.000Z' });
    const { view, patterns } = run([e1, e2], { feedback: [agreeing, corrective] });
    assert.equal(view.counts.feedback, 2);
    assert.equal(view.counts.correctiveFeedback, 1);
    assert.equal(patterns.patterns.some((pattern) => pattern.kind === 'recurring_corrections'), false);
  });
});

describe('AC-3 pattern detection', () => {
  test('three consecutive successes are repeated success, with every claim bounded', () => {
    const { patterns } = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]));
    const pattern = patterns.patterns.find((item) => item.kind === 'repeated_success');
    assert.ok(pattern);
    assert.equal(pattern.stage, 'pattern');
    assert.equal(pattern.counts.supporting, 3);
    assert.equal(pattern.counts.contradicting, 0);
    assert.equal(pattern.causal, false);
    assert.equal(pattern.adaptation, false);
    assert.deepEqual(pattern.evidence.experienceIds, ['e1', 'e2', 'e3']);
    assert.match(pattern.threshold, /3 most recent/);
    assert.match(pattern.explanation, /3 consecutive/);
    assert.ok(pattern.limitations.length > 0);
  });

  test('three consecutive failures are repeated failure', () => {
    const { patterns } = run(three([Outcome.EXECUTION_FAILED, Outcome.EXECUTION_FAILED, Outcome.EXECUTION_FAILED]));
    const pattern = patterns.patterns.find((item) => item.kind === 'repeated_failure');
    assert.ok(pattern);
    assert.equal(pattern.counts.supporting, 3);
  });

  test('an event with another outcome is listed as contradicting evidence rather than hidden', () => {
    const { patterns } = run(three([Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED])
      .map((event, index) => ({ ...event, id: `x${index + 1}` })));
    const pattern = patterns.patterns.find((item) => item.kind === 'repeated_success');
    assert.equal(pattern.counts.contradicting, 1);
    assert.deepEqual(pattern.counterEvidence.experienceIds, ['x1']);
    assert.match(pattern.limitations.join(' '), /1 other recorded event/);
  });

  test('four alternating outcomes are alternating, and the alternation is not called a cycle', () => {
    const { patterns } = run(three([Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED])
      .map((event, index) => ({ ...event, id: `alt${index + 1}` })));
    const pattern = patterns.patterns.find((item) => item.kind === 'alternating_outcomes');
    assert.ok(pattern);
    assert.equal(pattern.counts.supporting, 4);
    assert.match(pattern.limitations.join(' '), /not evidence of a cycle or a rule/);
  });

  test('successes then a failure is a regression, and success after the failure is not', () => {
    const regression = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED]));
    const pattern = regression.patterns.patterns.find((item) => item.kind === 'regression_after_success');
    assert.ok(pattern);
    assert.equal(pattern.counts.supporting, 3);
    assert.match(pattern.limitations.join(' '), /does not establish that something changed or what caused the failure/);

    const recovered = run(three([Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED]));
    assert.equal(recovered.patterns.patterns.some((item) => item.kind === 'regression_after_success'), false);
  });

  test('a correction followed by a success is an improvement, and a later failure is counter-evidence', () => {
    const failure = exp({ at: '2026-10-01T00:00:00.000Z', outcome: Outcome.EXECUTION_FAILED, id: 'f1' });
    const corrective = feedbackEntry({ id: 'fb1', experienceId: 'f1', assessment: 'user_correction', at: '2026-10-02T00:00:00.000Z' });
    const success = exp({ at: '2026-10-03T00:00:00.000Z', outcome: Outcome.SUCCESS_VERIFIED, id: 's1' });
    const laterFailure = exp({ at: '2026-10-04T00:00:00.000Z', outcome: Outcome.EXECUTION_FAILED, id: 'f2' });
    const { patterns } = run([failure, success, laterFailure], { feedback: [corrective] });
    const pattern = patterns.patterns.find((item) => item.kind === 'improvement_after_correction');
    assert.ok(pattern);
    assert.deepEqual(pattern.feedbackIds, ['fb1']);
    assert.deepEqual(pattern.counterEvidence.experienceIds, ['f2']);
    assert.match(pattern.limitations.join(' '), /not proof that the user correction caused it/);
  });

  test('two current corrective feedback records are a recurring-correction pattern', () => {
    const e1 = exp({ at: '2026-10-01T00:00:00.000Z', id: 'e1' });
    const e2 = exp({ at: '2026-10-02T00:00:00.000Z', id: 'e2' });
    const { patterns } = run([e1, e2], {
      feedback: [
        feedbackEntry({ id: 'fb1', experienceId: 'e1', at: '2026-10-03T00:00:00.000Z' }),
        feedbackEntry({ id: 'fb2', experienceId: 'e2', at: '2026-10-04T00:00:00.000Z' }),
      ],
    });
    const pattern = patterns.patterns.find((item) => item.kind === 'recurring_corrections');
    assert.ok(pattern);
    assert.deepEqual(pattern.feedbackIds.sort(), ['fb1', 'fb2']);
    assert.match(pattern.limitations.join(' '), /explicit approval/);
  });

  test('fewer events than the threshold produce insufficient evidence, not a guess', () => {
    const { patterns } = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]));
    assert.equal(patterns.total, 1);
    const [pattern] = patterns.patterns;
    assert.equal(pattern.kind, 'insufficient_evidence');
    assert.equal(pattern.counts.supporting, 2);
    assert.equal(pattern.adaptation, false);
    assert.match(pattern.limitations.join(' '), /Absence of a pattern is not evidence/);
  });

  test('a configured minimum is used consistently in detection, thresholds, and explanations', () => {
    const events = three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]);
    const { patterns } = run(events, { minEvents: 4 });
    assert.equal(patterns.minEvents, 4);
    const pattern = patterns.patterns.find((item) => item.kind === 'repeated_success');
    assert.ok(pattern);
    assert.match(pattern.threshold, /4 most recent/);
    assert.match(pattern.explanation, /4 consecutive/);

    const below = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]), { minEvents: 4 });
    assert.equal(below.patterns.patterns[0].kind, 'insufficient_evidence');
    assert.match(below.patterns.patterns[0].threshold, /at least 4/);
  });

  test('pattern output is bounded and says that it was truncated', () => {
    // Five capabilities, each with three failures, is more patterns than the requested bound.
    const names = ['a.x', 'b.x', 'c.x', 'd.x', 'e.x'];
    const events = names.flatMap((capability, group) => [0, 1, 2].map((index) => exp({
      at: `2026-10-0${index + 1}T0${group}:00:00.000Z`,
      outcome: Outcome.EXECUTION_FAILED,
      capability,
      id: `${capability}-${index}`,
    })));
    const { patterns } = run(events, { maxPatterns: 2 });
    assert.equal(patterns.patterns.length, 2);
    assert.equal(patterns.total > 2, true);
    assert.equal(patterns.truncated, true);
    assert.ok(patterns.total <= events.length);
  });

  test('evidence lists are bounded without hiding how much was left out', () => {
    // 25 experiences each carry a corrective feedback record, so the correction pattern has more
    // supporting evidence than one evidence list can name.
    const events = Array.from({ length: MAX_PATTERN_EVIDENCE + 5 }, (_, index) => exp({
      at: `2026-10-01T00:${String(index).padStart(2, '0')}:00.000Z`,
      outcome: Outcome.SUCCESS_VERIFIED,
      id: `big-${index}`,
    }));
    const feedback = events.map((event) => feedbackEntry({
      experienceId: event.id,
      at: `2026-10-02T00:${String(events.indexOf(event)).padStart(2, '0')}:00.000Z`,
    }));
    const { patterns } = run(events, { feedback });
    const pattern = patterns.patterns.find((item) => item.kind === 'recurring_corrections');
    assert.ok(pattern);
    assert.equal(pattern.evidence.experienceIds.length, MAX_PATTERN_EVIDENCE);
    assert.equal(pattern.supportTruncated, true);
    assert.equal(pattern.counts.supporting, events.length);
  });

  test('no pattern is or becomes an adaptation, and the adaptation state is only read', () => {
    const adaptations = [
      { id: 'ad-1', active: true, support: { experienceIds: ['e1'] } },
      { id: 'ad-2', active: false, support: { experienceIds: ['e2'] } },
    ];
    const before = JSON.stringify(adaptations);
    const result = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]), {});
    for (const pattern of result.patterns.patterns) {
      assert.equal(pattern.adaptation, false);
      assert.equal(pattern.causal, false);
    }
    const withAdaptations = analyzeTemporal({
      experiences: three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]),
      adaptations,
      window: window('2026-09-01', '2026-12-01'),
    });
    assert.equal(withAdaptations.adaptations.total, 2);
    assert.equal(withAdaptations.adaptations.active, 1);
    assert.equal(withAdaptations.adaptations.citingWindow, 2);
    assert.equal(withAdaptations.adaptations.citingActive, 1);
    assert.equal(JSON.stringify(adaptations), before, 'the query must not modify the adaptation list');
  });
});

describe('AC-4 comparisons', () => {
  test('two disjoint windows report separate totals and say they do not overlap', () => {
    const events = [
      exp({ at: '2026-09-05T00:00:00.000Z', outcome: Outcome.SUCCESS_VERIFIED, id: 'old-1' }),
      exp({ at: '2026-10-05T00:00:00.000Z', outcome: Outcome.EXECUTION_FAILED, id: 'new-1' }),
      exp({ at: '2026-10-06T00:00:00.000Z', outcome: Outcome.EXECUTION_FAILED, id: 'new-2' }),
    ];
    const comparison = compareTemporalWindows({
      experiences: events,
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.equal(comparison.totals.a.total, 1);
    assert.equal(comparison.totals.b.total, 2);
    assert.equal(comparison.totals.delta.total, 1);
    assert.equal(comparison.totals.delta.failure, 2);
    assert.equal(comparison.changed, true);
    assert.match(comparison.limitations.join(' '), /do not overlap/);
    assert.equal(comparison.schema, 1);
  });

  test('overlapping windows are disclosed so their totals are not read as disjoint', () => {
    const events = [exp({ at: '2026-10-05T00:00:00.000Z', id: 'e1' })];
    const comparison = compareTemporalWindows({
      experiences: events,
      windowA: window('2026-10-01', '2026-10-10'),
      windowB: window('2026-10-05', '2026-10-15'),
    });
    assert.equal(comparison.totals.a.total, 1);
    assert.equal(comparison.totals.b.total, 1);
    assert.match(comparison.limitations.join(' '), /overlap/);
  });

  test('the per-capability list is bounded and reports the truncation', () => {
    const events = Array.from({ length: 25 }, (_, index) => exp({
      at: '2026-10-05T00:00:00.000Z',
      capability: `cap.${String(index).padStart(2, '0')}`,
      id: `cap-${index}`,
    }));
    const comparison = compareTemporalWindows({
      experiences: events,
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.equal(comparison.byCapability.length, 20);
    assert.equal(comparison.capabilitiesTruncated, true);
    assert.match(comparison.limitations.join(' '), /bounded to 20 rows/);
    assert.equal(comparison.totals.b.total, 25);
  });

  test('a comparison is a difference in what was recorded, never a causal finding', () => {
    const comparison = compareTemporalWindows({
      experiences: [exp({ at: '2026-10-05T00:00:00.000Z', id: 'e1' })],
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.match(comparison.limitations[0], /not proof that one window caused the other/);
  });
});

describe('AC-5 summary, rendering, and audit minimization', () => {
  test('the bounded summary is marked as neither causal nor a prediction, and lists only implemented stages', () => {
    const analysis = run(three([Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED]));
    const summary = summarizeTemporal({ view: analysis.view, patterns: analysis.patterns, adaptations: analysis.adaptations });
    assert.equal(summary.causal, false);
    assert.equal(summary.prediction, false);
    assert.deepEqual(summary.stages, [...IMPLEMENTED_STAGES]);
    assert.deepEqual(summary.stages, ['observation', 'pattern']);
    assert.equal(summary.window.since, analysis.view.window.since);
    assert.equal(summary.counts.events, 3);
    assert.equal(summary.schema, 1);
    assert.match(summary.limitations.join(' '), /never a prediction/);
    assert.match(summary.limitations.join(' '), /becomes an adaptation/);
  });

  test('the summary reports undated records rather than silently excluding them', () => {
    const analysis = run([
      exp({ at: '2026-10-01T00:00:00.000Z', id: 'd1' }),
      exp({ finishedAt: null, requestedAt: null, createdAt: null, id: 'u1' }),
    ]);
    const summary = summarizeTemporal({ view: analysis.view, patterns: analysis.patterns });
    assert.equal(summary.counts.undated, 1);
    assert.match(summary.limitations.join(' '), /no usable timestamp/);
  });

  test('audit shapes carry counts and ids, never the fixture text', () => {
    const analysis = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED]), {
      feedback: [feedbackEntry({ id: 'fb1', experienceId: 'e1', at: '2026-10-04T00:00:00.000Z' })],
    });
    const shapes = [
      temporalAuditShape(analysis.view),
      patternsAuditShape(analysis.view, analysis.patterns),
    ];
    for (const shape of shapes) {
      const text = JSON.stringify(shape);
      assert.equal(text.includes('MARKER-USER-TEXT'), false);
      assert.equal(text.includes('statement'), false);
      assert.equal(text.includes('guide'), false);
    }
    assert.deepEqual(temporalAuditShape(analysis.view).eventIds, ['e1', 'e2', 'e3']);
    const patternsShape = patternsAuditShape(analysis.view, analysis.patterns);
    assert.equal(patternsShape.patterns.length, analysis.patterns.patterns.length);
    assert.equal(patternsShape.patterns.every((pattern) => typeof pattern.kind === 'string'), true);
    assert.deepEqual(patternsShape.patterns.map((pattern) => pattern.kind), ['regression_after_success']);
  });

  test('the comparison audit shape keeps windows, counts, and ids only', () => {
    const comparison = compareTemporalWindows({
      experiences: [exp({ at: '2026-10-05T00:00:00.000Z', id: 'e1' })],
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    const shape = comparisonAuditShape(comparison);
    const text = JSON.stringify(shape);
    assert.equal(text.includes('MARKER-USER-TEXT'), false);
    assert.equal(shape.windows.b.since, '2026-10-01T00:00:00.000Z');
    assert.equal(shape.totals.b.total, 1);
  });

  test('every rendering states that order is not cause and no pattern is a prediction', () => {
    const analysis = run(three([Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED]));
    assert.match(renderTimeline(analysis.view), /Derived at read time/);
    assert.match(renderTrends(analysis.view), /trend/);
    const patternsText = renderPatterns(analysis.view, analysis.patterns);
    assert.match(patternsText, /not a prediction|never a prediction|not a cause|no pattern/i);
    const comparison = compareTemporalWindows({
      experiences: [],
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.match(renderComparison(comparison), /not proof that one window caused the other/);
  });
});

describe('AC-6 bounded reads over a large synthetic store', () => {
  test('a large history is bounded by the event limit and the capability list, with counts intact', () => {
    const events = Array.from({ length: 500 }, (_, index) => exp({
      at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 60000).toISOString(),
      capability: `cap.${String(index % 30).padStart(2, '0')}`,
      outcome: index % 3 === 0 ? Outcome.EXECUTION_FAILED : Outcome.SUCCESS_VERIFIED,
      id: `bulk-${String(index).padStart(3, '0')}`,
    }));
    const analysis = run(events, { since: '2026-09-01', until: '2026-12-01' });
    assert.equal(analysis.view.counts.inWindow, 500);
    assert.equal(analysis.view.counts.shown, MAX_TEMPORAL_EVENTS);
    assert.equal(analysis.view.events.length, MAX_TEMPORAL_EVENTS);
    assert.equal(analysis.view.capabilitiesTruncated, true);
    assert.equal(analysis.view.byCapability.length, 20);
    assert.equal(analysis.view.counts.success + analysis.view.counts.failure, 500);
    assert.ok(analysis.patterns.patterns.length > 0);
    assert.equal(analysis.patterns.patterns.every((pattern) => pattern.evidence.experienceIds.length <= MAX_PATTERN_EVIDENCE), true);
  });
});

// Keep a reference to the value the search sorts by so the contract stays explicit: outcomes are
// classified by their stored value, not by the label a renderer chooses.
test('outcome classification distinguishes success, failure, refusal, and unknown', () => {
  assert.equal(outcomeClass(Outcome.SUCCESS_VERIFIED), 'success');
  assert.equal(outcomeClass(Outcome.EXECUTION_FAILED), 'failure');
  assert.equal(outcomeClass(Outcome.VERIFICATION_UNAVAILABLE), 'failure');
  assert.equal(outcomeClass(Outcome.INPUT_REJECTED), 'blocked');
  assert.equal(outcomeClass(Outcome.PLAN_CREATED), 'other');
  assert.equal(outcomeClass(undefined), 'unknown');
  assert.equal(parseInstant('2026-10-02T05:00:00+05:00'), Date.parse('2026-10-02T00:00:00.000Z'));
  assert.equal(parseInstant('nope'), null);
});
