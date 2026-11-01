// Batch AD: adversarial histories for the temporal evidence engine.
//
// These tests use synthetic records only. They exist to pin what the engine does with histories
// that are contradictory, sparse, replaced, superseded, truncated, duplicated, or badly timestamped,
// and to prove the limits of the claims it makes. Nothing here is a model call; nothing here is
// evidence that a real operation happened. The point is not that a pattern is "reliable" when its
// test passes, but that the engine never says more than the recorded order supports.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PATTERN_EVIDENCE,
  analyzeTemporal,
  compareTemporalWindows,
  parseInstant,
  patternsAuditShape,
  renderPatterns,
  renderTimeline,
  resolveWindow,
  summarizeTemporal,
  temporalAuditShape,
} from '../src/experience/temporal.js';
import { temporalPromptLines, buildPrompt } from '../src/controller/context.js';
import { Outcome } from '../src/outcomes.js';

const NOW = new Date('2026-11-01T00:00:00.000Z');
let seq = 0;

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
  return {
    id: rest.id ?? `adv-${String(seq).padStart(3, '0')}`,
    operationId: rest.operationId ?? `op-${String(seq).padStart(3, '0')}`,
    capability,
    outcome,
    capture,
    active: rest.active ?? true,
    superseded: rest.superseded ?? false,
    requestedAt: requestedAt === undefined ? at : requestedAt,
    finishedAt: finishedAt === undefined ? null : finishedAt,
    createdAt: createdAt === undefined ? at : createdAt,
    replaces: rest.replaces ?? [],
    replacedBy: rest.replacedBy ?? [],
    content: rest.content ?? 'MARKER-USER-TEXT',
  };
}

function feedbackEntry({ id = `fb-${++seq}`, experienceId, assessment = 'user_correction', at = null }) {
  return { id, experienceId, assessment, createdAt: at };
}

function window(since, until) {
  return resolveWindow({ since, until, now: NOW });
}

function run(experiences, {
  since = '2026-09-01',
  until = '2026-12-01',
  capability = null,
  feedback = [],
  retiredFeedback = new Set(),
  position = null,
  adaptations = [],
  minEvents,
  maxPatterns,
} = {}) {
  return analyzeTemporal({
    experiences,
    feedback,
    retiredFeedback,
    adaptations,
    window: window(since, until),
    capability,
    position,
    minEvents,
    maxPatterns,
  });
}

function day(n, time = '00:00:00.000') {
  return `2026-10-${String(n).padStart(2, '0')}T${time}Z`;
}

function byKind(detection, kind) {
  return detection.patterns.find((pattern) => pattern.kind === kind);
}

describe('AD-1 outcome orders that look like patterns but are not', () => {
  test('success, failure, success is neither a streak, a regression, nor an improvement', () => {
    const events = [
      exp({ at: day(1), outcome: Outcome.SUCCESS_VERIFIED, id: 'sfs-1' }),
      exp({ at: day(2), outcome: Outcome.EXECUTION_FAILED, id: 'sfs-2' }),
      exp({ at: day(3), outcome: Outcome.SUCCESS_VERIFIED, id: 'sfs-3' }),
    ];
    const { patterns } = run(events);
    assert.equal(patterns.patterns.length, 0);
    assert.equal(patterns.total, 0);
  });

  test('failure, success, failure is not a regression after success', () => {
    const events = [
      exp({ at: day(1), outcome: Outcome.EXECUTION_FAILED, id: 'fsf-1' }),
      exp({ at: day(2), outcome: Outcome.SUCCESS_VERIFIED, id: 'fsf-2' }),
      exp({ at: day(3), outcome: Outcome.EXECUTION_FAILED, id: 'fsf-3' }),
    ];
    const { patterns, view } = run(events);
    assert.equal(patterns.patterns.length, 0);
    assert.equal(view.counts.failure, 2);
    assert.equal(view.counts.success, 1);
  });

  test('an interrupted alternation still alternates, and the interrupting outcome is excluded by name', () => {
    for (const interruption of [Outcome.PLAN_REJECTED, Outcome.PLAN_CREATED]) {
      const events = [
        exp({ at: day(1), outcome: Outcome.SUCCESS_VERIFIED, id: 'alt-1' }),
        exp({ at: day(2), outcome: interruption, id: 'alt-block' }),
        exp({ at: day(3), outcome: Outcome.EXECUTION_FAILED, id: 'alt-2' }),
        exp({ at: day(4), outcome: Outcome.SUCCESS_VERIFIED, id: 'alt-3' }),
        exp({ at: day(5), outcome: Outcome.EXECUTION_FAILED, id: 'alt-4' }),
      ];
      const { patterns } = run(events);
      const pattern = byKind(patterns, 'alternating_outcomes');
      assert.ok(pattern);
      assert.equal(pattern.counts.supporting, 4);
      assert.equal(pattern.counts.contradicting, 0);
      assert.equal(pattern.counts.excluded, 1);
      assert.deepEqual(pattern.excludedEvidence.experienceIds, ['alt-block']);
      assert.match(pattern.explanation, /success\/failure outcomes alternate/);
      assert.match(pattern.threshold, /success\/failure outcomes/);
      assert.match(pattern.limitations.join(' '), /not as counter-evidence/);
    }
  });
});

describe('AD-2 contradictory and superseded feedback', () => {
  test('two different corrective assessments of one experience are two pieces of current feedback', () => {
    const e1 = exp({ at: day(1), id: 'one-exp' });
    const { patterns, view } = run([e1], {
      feedback: [
        feedbackEntry({ id: 'fb-a', experienceId: 'one-exp', assessment: 'user_correction', at: day(2) }),
        feedbackEntry({ id: 'fb-b', experienceId: 'one-exp', assessment: 'not_useful', at: day(3) }),
      ],
    });
    assert.equal(view.counts.correctiveFeedback, 2);
    const pattern = byKind(patterns, 'recurring_corrections');
    assert.ok(pattern);
    assert.deepEqual(pattern.feedbackIds.sort(), ['fb-a', 'fb-b']);
    assert.equal(pattern.counts.feedback, 2);
    assert.equal(pattern.counts.supporting, 1);
    assert.equal(patterns.feedbackScope.currentInWindow, 2);
  });

  test('feedback corrected by later feedback does not count, and the exclusion is reported', () => {
    const e1 = exp({ at: day(1), id: 'sup-1' });
    const e2 = exp({ at: day(2), id: 'sup-2' });
    const feedback = [
      feedbackEntry({ id: 'keep', experienceId: 'sup-1', at: day(3) }),
      feedbackEntry({ id: 'old', experienceId: 'sup-2', at: day(3) }),
      feedbackEntry({ id: 'new', experienceId: 'sup-2', at: day(4) }),
    ];
    const { patterns } = run([e1, e2], { feedback, retiredFeedback: new Set(['old']) });
    const pattern = byKind(patterns, 'recurring_corrections');
    assert.ok(pattern);
    assert.deepEqual(pattern.feedbackIds.sort(), ['keep', 'new']);
    assert.equal(pattern.counts.feedback, 2);
    assert.deepEqual(pattern.evidence.experienceIds.sort(), ['sup-1', 'sup-2']);
    assert.equal(patterns.feedbackScope.currentInWindow, 2);
    assert.equal(patterns.feedbackScope.supersededByFeedback, 1);
    assert.match(pattern.limitations.join(' '), /themselves corrected by a later feedback record/);
  });

  test('supersession that leaves one current correction cannot meet the recurring threshold', () => {
    const e1 = exp({ at: day(1), id: 'thin-1' });
    const e2 = exp({ at: day(2), id: 'thin-2' });
    const feedback = [
      feedbackEntry({ id: 'thin-keep', experienceId: 'thin-1', at: day(3) }),
      feedbackEntry({ id: 'thin-old', experienceId: 'thin-2', at: day(3) }),
    ];
    const { patterns } = run([e1, e2], { feedback, retiredFeedback: new Set(['thin-old']) });
    assert.equal(byKind(patterns, 'recurring_corrections'), undefined);
    assert.equal(patterns.feedbackScope.currentInWindow, 1);
    assert.equal(patterns.feedbackScope.supersededByFeedback, 1);
  });

  test('corrective feedback outside the window is not counted, even on an in-window experience', () => {
    const e1 = exp({ at: '2026-09-10T00:00:00.000Z', id: 'outside-fb-exp' });
    const { patterns, view } = run([e1], {
      feedback: [feedbackEntry({ id: 'outside-fb', experienceId: 'outside-fb-exp', at: '2026-08-01T00:00:00.000Z' })],
    });
    assert.equal(view.counts.correctiveFeedback, 1, 'the event-level timeline still reports the feedback');
    assert.equal(byKind(patterns, 'recurring_corrections'), undefined);
    assert.equal(patterns.feedbackScope.currentInWindow, 0);
    assert.match(renderPatterns(view, patterns), /Corrections:\s+0 current corrective feedback record\(s\) in the window/);
  });

  test('feedback inside the window about an older experience is disclosed, not silently dropped', () => {
    const older = exp({ at: '2026-08-01T00:00:00.000Z', id: 'older-exp' });
    const { patterns, view, ...analysis } = run([older], {
      feedback: [
        feedbackEntry({ id: 'older-fb1', experienceId: 'older-exp', at: day(1) }),
        feedbackEntry({ id: 'older-fb2', experienceId: 'older-exp', at: day(2) }),
      ],
    });
    assert.equal(view.counts.inWindow, 0);
    assert.equal(view.counts.correctiveFeedback, 0);
    const pattern = byKind(patterns, 'recurring_corrections');
    assert.ok(pattern);
    assert.equal(pattern.counts.supporting, 0);
    assert.equal(pattern.counts.feedback, 2);
    assert.deepEqual(pattern.evidence.experienceIds, []);
    assert.match(pattern.limitations.join(' '), /outside this dated window/);
    assert.equal(patterns.feedbackScope.currentInWindow, 2);

    const summary = summarizeTemporal({ view, patterns, adaptations: analysis.adaptations });
    assert.equal(summary.counts.events, 0);
    assert.ok(summary.patterns.some((item) => item.kind === 'recurring_corrections'));
    const lines = temporalPromptLines(summary);
    assert.ok(lines.some((line) => /recurring_corrections/.test(line)), 'a real pattern with no in-window event is not suppressed');
    assert.ok(lines.some((line) => /0 recorded event\(s\)/.test(line)));
  });
});

describe('AD-2 replaced experiences are visible but not current evidence', () => {
  test('a replaced record stays in the timeline and is excluded from patterns with a stated count', () => {
    const old = exp({ at: day(1), id: 'replaced-old', superseded: true, active: false, replacedBy: ['replacement'] });
    const replacement = exp({ at: day(2), id: 'replacement' });
    const second = exp({ at: day(3), id: 'after-1' });
    const { patterns, view, ...analysis } = run([old, replacement, second]);
    assert.equal(view.counts.inWindow, 3);
    assert.equal(view.counts.live, 2);
    assert.equal(view.counts.superseded, 1);
    assert.equal(byKind(patterns, 'repeated_success'), undefined, 'a corrected success is not a current success');
    const insufficient = byKind(patterns, 'insufficient_evidence');
    assert.equal(insufficient.counts.supporting, 2);
    assert.equal(patterns.replacedExcluded, 1);
    assert.match(insufficient.limitations.join(' '), /replaced by a later record/);

    const text = renderPatterns(view, patterns);
    assert.match(text, /1 replaced by a later record and excluded from every pattern/);
    // The timeline abbreviates ids, so assert the marker and the correction line rather than the
    // raw id text; the full id is still in the evidence arrays above.
    const timeline = renderTimeline(view);
    assert.match(timeline, /\[corrected by a later record\]/);
    assert.match(timeline, /corrections: .*replaced by/);

    const summary = summarizeTemporal({ view, patterns, adaptations: analysis.adaptations });
    assert.match(summary.limitations.join(' '), /not used by any pattern/);
  });
});

describe('AD-3 evidence identity and lineage', () => {
  test('duplicate operation references are separate experiences, not merged evidence', () => {
    const events = [1, 2, 3].map((n) => exp({
      at: day(n),
      id: `dup-${n}`,
      operationId: 'op-shared',
      content: 'identical wording',
    }));
    const { patterns } = run(events);
    const pattern = byKind(patterns, 'repeated_success');
    assert.deepEqual(pattern.evidence.experienceIds, ['dup-1', 'dup-2', 'dup-3']);
    assert.equal(new Set(pattern.evidence.experienceIds).size, 3);
    assert.equal(pattern.evidence.experienceIds.includes('op-shared'), false);
    const shape = patternsAuditShape(run(events).view, patterns);
    assert.deepEqual(shape.patterns[0].experienceIds, ['dup-1', 'dup-2', 'dup-3']);
  });

  test('an adaptation is read, never cited as experience evidence, and never changed', () => {
    const events = [1, 2, 3].map((n) => exp({ at: day(n), id: `ad-exp-${n}` }));
    const adaptations = [{ id: 'ad-1', active: true, support: { experienceIds: ['ad-exp-1'], feedbackIds: ['fb-x'] } }];
    const before = JSON.stringify(adaptations);
    const { patterns, ...analysis } = run(events, { adaptations });
    assert.equal(analysis.adaptations.total, 1);
    assert.equal(analysis.adaptations.citingWindow, 1);
    assert.equal(analysis.adaptations.citingActive, 1);
    assert.deepEqual(analysis.adaptations.ids, ['ad-1']);
    for (const pattern of patterns.patterns) {
      assert.equal(pattern.evidence.experienceIds.includes('ad-1'), false);
      assert.equal(pattern.feedbackIds.includes('fb-x'), false);
      assert.equal(pattern.adaptation, false);
    }
    assert.equal(JSON.stringify(adaptations), before);
  });

  test('the audit shape names only ids and counts, never stored text', () => {
    const events = [1, 2, 3].map((n) => exp({ at: day(n), id: `audit-${n}`, content: 'SECRET-SUBJECT-TEXT' }));
    const { view, patterns } = run(events);
    const text = JSON.stringify([temporalAuditShape(view), patternsAuditShape(view, patterns)]);
    assert.equal(text.includes('SECRET-SUBJECT-TEXT'), false);
    assert.equal(text.includes('statement'), false);
  });
});

describe('AD-4 ordering, timestamps, and boundaries', () => {
  test('equal timestamps follow append order, and the same positions give the same answer from any array order', () => {
    const a = exp({ at: day(1), id: 'tie-a' });
    const b = exp({ at: day(1), id: 'tie-b' });
    const c = exp({ at: day(1), id: 'tie-c' });
    const d = exp({ at: day(1), id: 'tie-d' });
    const position = new Map([['tie-d', 1], ['tie-c', 2], ['tie-a', 3], ['tie-b', 4]]);
    const first = run([a, b, c, d], { position });
    const second = run([d, c, a, b], { position });
    assert.deepEqual(first.view.events.map((event) => event.id), ['tie-d', 'tie-c', 'tie-a', 'tie-b']);
    assert.deepEqual(second.view.events.map((event) => event.id), ['tie-d', 'tie-c', 'tie-a', 'tie-b']);
    assert.deepEqual(byKind(first.patterns, 'repeated_success').evidence.experienceIds, ['tie-c', 'tie-a', 'tie-b']);
    assert.deepEqual(byKind(second.patterns, 'repeated_success').evidence.experienceIds, ['tie-c', 'tie-a', 'tie-b']);
  });

  test('a zone-less timestamp is read as UTC, so one stored text has one instant on every machine', () => {
    assert.equal(parseInstant('2026-10-01T00:00:00'), Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(parseInstant('2026-10-01 00:00:00'), Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(parseInstant('2026-10-01T05:00:00+05:00'), Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(parseInstant('2026-10-01T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'));
  });

  test('malformed timestamps fall back or become undated, and undated feedback is counted but unused', () => {
    const fallback = exp({
      finishedAt: 'not-a-date',
      requestedAt: '2026-10-02T00:00:00.000Z',
      createdAt: '2026-10-09T00:00:00.000Z',
      id: 'fallback-exp',
    });
    const undated = exp({ finishedAt: '', requestedAt: 'nope', createdAt: null, id: 'undated-exp' });
    const { view, patterns } = run([fallback, undated], {
      feedback: [
        feedbackEntry({ id: 'undated-fb1', experienceId: 'fallback-exp', at: 'nope' }),
        feedbackEntry({ id: 'undated-fb2', experienceId: 'fallback-exp', at: null }),
      ],
    });
    assert.equal(view.events.length, 1);
    assert.equal(view.events[0].timeSource, 'requestedAt');
    assert.equal(view.counts.undated, 1);
    assert.deepEqual(view.undated.map((event) => event.id), ['undated-exp']);
    assert.equal(byKind(patterns, 'recurring_corrections'), undefined);
    assert.equal(patterns.feedbackScope.undated, 2);
    assert.match(renderPatterns(view, patterns), /2 undated and not placed/);
  });

  test('both window bounds are inclusive and an unspecified bound is filled, not widened', () => {
    const insideStart = exp({ at: '2026-10-01T00:00:00.000Z', id: 'at-since' });
    const insideEnd = exp({ at: '2026-10-31T23:59:59.999Z', id: 'at-until' });
    const before = exp({ at: '2026-09-30T23:59:59.999Z', id: 'before-window' });
    const after = exp({ at: '2026-11-01T00:00:00.000Z', id: 'after-window' });
    const { view } = run([insideStart, insideEnd, before, after], {
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-31T23:59:59.999Z',
    });
    assert.equal(view.counts.inWindow, 2);
    assert.equal(view.counts.outsideWindow, 2);
    assert.deepEqual(view.events.map((event) => event.id), ['at-since', 'at-until']);
  });

  test('a date-only bound covers the whole UTC day, including a DST transition day', () => {
    const dayWindow = resolveWindow({ since: '2026-10-01', until: '2026-10-01', now: NOW });
    assert.equal(dayWindow.since, '2026-10-01T00:00:00.000Z');
    assert.equal(dayWindow.until, '2026-10-01T23:59:59.999Z');
    const dstDay = resolveWindow({ since: '2026-11-01', until: '2026-11-01', now: NOW });
    assert.equal(Date.parse(dstDay.until) - Date.parse(dstDay.since) + 1, 24 * 60 * 60 * 1000);
    // An explicit offset is normalized to the instant it names, not to the machine's local zone.
    const offset = resolveWindow({ since: '2026-10-01T05:30:00+05:30', until: '2026-10-01T00:00:00Z', now: NOW });
    assert.equal(offset.since, '2026-10-01T00:00:00.000Z');
    assert.equal(offset.until, '2026-10-01T00:00:00.000Z');
  });

  test('an empty or extremely sparse window says so instead of inventing a pattern', () => {
    const empty = run([]);
    assert.equal(empty.patterns.total, 1);
    assert.equal(empty.patterns.patterns[0].kind, 'insufficient_evidence');
    assert.equal(empty.patterns.patterns[0].capability, null);
    assert.equal(empty.patterns.patterns[0].counts.supporting, 0);
    assert.match(empty.patterns.patterns[0].explanation, /no current dated experience/);
    assert.match(renderPatterns(empty.view, empty.patterns), /\[insufficient_evidence\][\s\S]*no current dated experience/);

    const sparse = run([exp({ at: day(1), id: 'only-one' })]);
    assert.equal(sparse.patterns.patterns[0].kind, 'insufficient_evidence');
    assert.equal(sparse.patterns.patterns[0].counts.supporting, 1);
    assert.match(renderTimeline(sparse.view), /only-one/);
  });

  test('a capability filter is carried into insufficient evidence, not reported as every capability', () => {
    const { patterns } = run([exp({ at: day(1), id: 'scoped-one', capability: 'calc.evaluate' })], { capability: 'calc.evaluate' });
    const pattern = byKind(patterns, 'insufficient_evidence');
    assert.equal(pattern.capability, 'calc.evaluate');
    assert.match(pattern.explanation, /for calc\.evaluate/);
    assert.match(pattern.threshold, /for calc\.evaluate/);
  });
});

describe('AD-4 comparison construction', () => {
  test('adjacent windows meet at a single instant without overlap or a gap, and both bounds are inclusive', () => {
    const atAEnd = exp({ at: '2026-09-30T23:59:59.999Z', id: 'a-end' });
    const atBStart = exp({ at: '2026-10-01T00:00:00.000Z', id: 'b-start' });
    const comparison = compareTemporalWindows({
      experiences: [atAEnd, atBStart],
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.equal(Date.parse(comparison.windows.a.until) + 1, Date.parse(comparison.windows.b.since));
    assert.equal(comparison.totals.a.total, 1);
    assert.equal(comparison.totals.b.total, 1);
    assert.match(comparison.limitations.join(' '), /do not overlap/);
  });

  test('a capability filter applies to both windows and to the per-capability rows', () => {
    const events = [
      exp({ at: day(1), id: 'cap-a', capability: 'calc.evaluate' }),
      exp({ at: day(2), id: 'cap-b', capability: 'memory.search' }),
    ];
    const comparison = compareTemporalWindows({
      experiences: events,
      capability: 'calc.evaluate',
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.equal(comparison.totals.b.total, 1);
    assert.deepEqual(comparison.byCapability.map((row) => row.capability), ['calc.evaluate']);
  });

  test('undated and replaced records are reported in both windows instead of disappearing', () => {
    const undated = exp({ finishedAt: null, requestedAt: null, createdAt: null, id: 'cmp-undated' });
    const replaced = exp({ at: day(2), id: 'cmp-replaced', superseded: true, active: false });
    const comparison = compareTemporalWindows({
      experiences: [undated, replaced],
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.equal(comparison.totals.a.undated, 1);
    assert.equal(comparison.totals.b.undated, 1);
    assert.equal(comparison.totals.b.superseded, 1);
    assert.match(comparison.limitations.join(' '), /Undated records are counted separately/);
  });

  test('equal-sized capability groups sort by code point, not by machine locale', () => {
    const events = [
      exp({ at: day(1), id: 'ord-lower', capability: 'a.x' }),
      exp({ at: day(2), id: 'ord-upper', capability: 'B.x' }),
    ];
    const comparison = compareTemporalWindows({
      experiences: events,
      windowA: window('2026-09-01', '2026-09-30'),
      windowB: window('2026-10-01', '2026-10-31'),
    });
    assert.deepEqual(comparison.byCapability.map((row) => row.capability), ['B.x', 'a.x']);
  });
});

describe('AD-4 bounded evidence never hides what it left out', () => {
  test('excluded events beyond the display limit keep their full count and a truncation flag', () => {
    const events = [
      ...Array.from({ length: 25 }, (_, index) => exp({
        at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 60000).toISOString(),
        outcome: Outcome.EXECUTION_FAILED,
        id: `early-${index}`,
      })),
      exp({ at: day(1), id: 'late-1' }),
      exp({ at: day(2), id: 'late-2' }),
      exp({ at: day(3), id: 'late-3' }),
    ];
    const { patterns, view } = run(events);
    const pattern = byKind(patterns, 'repeated_success');
    assert.equal(pattern.counts.supporting, 3);
    assert.equal(pattern.counts.excluded, 25);
    assert.equal(pattern.excludedEvidence.experienceIds.length, MAX_PATTERN_EVIDENCE);
    assert.equal(pattern.excludedTruncated, true);
    assert.match(pattern.limitations.join(' '), /25 other recorded event/);
    const text = renderPatterns(view, patterns);
    assert.match(text, /excluded: 25 event\(s\)/);
    assert.match(text, /first 20 shown/);
  });

  test('genuinely contradicting events beyond the display limit keep their full count', () => {
    const failure = exp({ at: day(1), outcome: Outcome.EXECUTION_FAILED, id: 'cf-base' });
    const corrective = feedbackEntry({ id: 'cf-feedback', experienceId: 'cf-base', at: day(1, '12:00:00.000') });
    const success = exp({ at: day(2), outcome: Outcome.SUCCESS_VERIFIED, id: 'cf-success' });
    const laterFailures = Array.from({ length: 25 }, (_, index) => exp({
      at: new Date(Date.parse('2026-10-03T00:00:00.000Z') + index * 60000).toISOString(),
      outcome: Outcome.EXECUTION_FAILED,
      id: `cf-fail-${index}`,
    }));
    const { patterns, view } = run([failure, ...laterFailures, success], { feedback: [corrective] });
    const pattern = byKind(patterns, 'improvement_after_correction');
    assert.ok(pattern);
    assert.equal(pattern.counts.contradicting, 25);
    assert.equal(pattern.counterEvidence.experienceIds.length, MAX_PATTERN_EVIDENCE);
    assert.equal(pattern.counterTruncated, true);
    assert.match(renderPatterns(view, patterns), /contradicting: 25 event\(s\) count against this rule/);
  });

  test('feedback ids beyond the display limit report the full feedback count', () => {
    const events = Array.from({ length: MAX_PATTERN_EVIDENCE + 5 }, (_, index) => exp({
      at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 60000).toISOString(),
      id: `many-${index}`,
    }));
    const feedback = events.map((event, index) => feedbackEntry({
      id: `many-fb-${index}`,
      experienceId: event.id,
      at: new Date(Date.parse('2026-10-02T00:00:00.000Z') + index * 60000).toISOString(),
    }));
    const { patterns, view } = run(events, { feedback });
    const pattern = byKind(patterns, 'recurring_corrections');
    assert.ok(pattern);
    assert.equal(pattern.feedbackIds.length, MAX_PATTERN_EVIDENCE);
    assert.equal(pattern.feedbackCount, events.length);
    assert.equal(pattern.feedbackTruncated, true);
    assert.equal(pattern.counts.feedback, events.length);
    assert.match(renderPatterns(view, patterns), /25 feedback record\(s\) \(first 20 shown\)/);
    const shape = patternsAuditShape(view, patterns);
    assert.equal(shape.patterns.find((item) => item.kind === 'recurring_corrections').feedback, events.length);
  });

  test('every pattern keeps supporting, contradicting, and excluded disjoint and complete', () => {
    const events = [
      exp({ at: day(1), outcome: Outcome.SUCCESS_VERIFIED, capability: 'a.x', id: 'mix-1' }),
      exp({ at: day(2), outcome: Outcome.EXECUTION_FAILED, capability: 'a.x', id: 'mix-2' }),
      exp({ at: day(3), outcome: Outcome.SUCCESS_VERIFIED, capability: 'a.x', id: 'mix-3' }),
      exp({ at: day(4), outcome: Outcome.PLAN_REJECTED, capability: 'a.x', id: 'mix-4' }),
      exp({ at: day(5), outcome: Outcome.EXECUTION_FAILED, capability: 'a.x', id: 'mix-5' }),
      exp({ at: day(6), outcome: Outcome.SUCCESS_VERIFIED, capability: 'b.x', id: 'mix-6' }),
      exp({ at: day(7), outcome: Outcome.SUCCESS_VERIFIED, capability: 'b.x', id: 'mix-7' }),
      exp({ at: day(8), outcome: Outcome.SUCCESS_VERIFIED, capability: 'b.x', id: 'mix-8' }),
    ];
    const { patterns } = run(events);
    assert.equal(patterns.patterns.length > 0, true);
    for (const pattern of patterns.patterns) {
      assert.equal(
        pattern.counts.supporting + pattern.counts.contradicting + pattern.counts.excluded,
        pattern.counts.evaluated,
        `${pattern.kind} accounts for every event it evaluated`,
      );
      assert.equal(
        pattern.counts.automatic + pattern.counts.explicit + pattern.counts.unknownCapture,
        pattern.counts.supporting,
      );
      const shown = [
        ...pattern.evidence.experienceIds,
        ...pattern.counterEvidence.experienceIds,
        ...pattern.excludedEvidence.experienceIds,
      ];
      assert.equal(new Set(shown).size, shown.length, `${pattern.kind} shows no id twice`);
    }
  });
});

describe('AD-5 the constructed prompt states what the evidence can and cannot support', () => {
  test('recorded events and derived order stay separately labelled, and stored text never enters the prompt', () => {
    const events = [1, 2, 3].map((n) => exp({ at: day(n), id: `prompt-${n}`, content: 'SECRET-USER-TEXT' }));
    const { view, patterns } = run(events);
    const summary = summarizeTemporal({ view, patterns });
    const built = buildPrompt({
      request: 'how have recent outcomes gone?',
      memoryHits: [],
      turns: [],
      temporal: { available: true, ...summary },
    });
    assert.equal(built.temporalIncluded, true);
    assert.match(built.prompt, /3 recorded event\(s\)/);
    assert.match(built.prompt, /Order patterns: repeated_success/);
    assert.match(built.prompt, /not instructions/);
    assert.match(built.prompt, /does not show that one event caused another/);
    assert.match(built.prompt, /no pattern is or becomes an approved behaviour rule/);
    assert.doesNotMatch(built.prompt, /SECRET-USER-TEXT/);
  });

  test('a correction superseded by later feedback is not presented as current support', () => {
    const e1 = exp({ at: day(1), id: 'prompt-sup-1' });
    const e2 = exp({ at: day(2), id: 'prompt-sup-2' });
    const feedback = [
      feedbackEntry({ id: 'prompt-keep', experienceId: 'prompt-sup-1', at: day(3) }),
      feedbackEntry({ id: 'prompt-old', experienceId: 'prompt-sup-2', at: day(3) }),
    ];
    const { view, patterns } = run([e1, e2], { feedback, retiredFeedback: new Set(['prompt-old']) });
    const summary = summarizeTemporal({ view, patterns });
    const built = buildPrompt({
      request: 'what corrections have been recorded recently?',
      memoryHits: [],
      turns: [],
      temporal: { available: true, ...summary },
    });
    assert.equal(built.temporalIncluded, true);
    assert.doesNotMatch(built.prompt, /recurring_corrections/, 'one current correction is not a recurring pattern');
    assert.match(summary.limitations.join(' '), /corrected by later feedback and do not support any pattern/);
  });

  test('a pattern with no in-window event is included and says so rather than reading as an empty history', () => {
    const older = exp({ at: '2026-08-01T00:00:00.000Z', id: 'prompt-older' });
    const { view, patterns } = run([older], {
      feedback: [
        feedbackEntry({ id: 'prompt-fb1', experienceId: 'prompt-older', at: day(1) }),
        feedbackEntry({ id: 'prompt-fb2', experienceId: 'prompt-older', at: day(2) }),
      ],
    });
    const summary = summarizeTemporal({ view, patterns });
    const built = buildPrompt({
      request: 'what happened recently?',
      memoryHits: [],
      turns: [],
      temporal: { available: true, ...summary },
    });
    assert.equal(built.temporalIncluded, true);
    assert.match(built.prompt, /0 recorded event\(s\)/);
    assert.match(built.prompt, /recurring_corrections/);
  });
});

describe('AD-1 what a pattern does not establish is stated', () => {
  test('recurring corrections says the feedback may concern different aspects and still needs approval', () => {
    const e1 = exp({ at: day(1), id: 'claim-1' });
    const e2 = exp({ at: day(2), id: 'claim-2' });
    const { patterns } = run([e1, e2], {
      feedback: [
        feedbackEntry({ id: 'claim-fb1', experienceId: 'claim-1', at: day(3) }),
        feedbackEntry({ id: 'claim-fb2', experienceId: 'claim-2', at: day(4) }),
      ],
    });
    const pattern = byKind(patterns, 'recurring_corrections');
    assert.match(pattern.limitations.join(' '), /different aspects/);
    assert.match(pattern.limitations.join(' '), /explicit approval/);
    assert.equal(pattern.causal, false);
    assert.equal(pattern.adaptation, false);
  });

  test('improvement never treats the corrected event as its own later evidence', () => {
    const target = exp({ at: day(2), outcome: Outcome.SUCCESS_VERIFIED, id: 'self-target' });
    const corrective = feedbackEntry({ id: 'self-feedback', experienceId: 'self-target', at: day(1) });
    const { patterns } = run([target], { feedback: [corrective] });
    assert.equal(byKind(patterns, 'improvement_after_correction'), undefined);
  });

  test('a later refusal is excluded from an improvement, not counted as a failed attempt', () => {
    const failure = exp({ at: day(1), outcome: Outcome.EXECUTION_FAILED, id: 'ref-base' });
    const corrective = feedbackEntry({ id: 'ref-feedback', experienceId: 'ref-base', at: day(2) });
    const success = exp({ at: day(3), outcome: Outcome.SUCCESS_VERIFIED, id: 'ref-success' });
    const refused = exp({ at: day(4), outcome: Outcome.PLAN_REJECTED, id: 'ref-refused' });
    const { patterns } = run([failure, success, refused], { feedback: [corrective] });
    const pattern = byKind(patterns, 'improvement_after_correction');
    assert.ok(pattern);
    assert.equal(pattern.counts.contradicting, 0);
    assert.equal(pattern.counts.excluded, 1);
    assert.deepEqual(pattern.excludedEvidence.experienceIds, ['ref-refused']);
    assert.match(pattern.limitations.join(' '), /not as counter-evidence/);
  });
});
