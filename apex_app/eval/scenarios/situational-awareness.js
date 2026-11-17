// Situational-awareness scenarios: an observation is stored as data, assessed against what APEX
// already knows, and never executed. The checks distinguish a duplicate, an expired observation,
// and one that is relevant to recorded work.
import { check } from '../framework.js';
import { outcomeIs, dataOf, displayHas, boundedDisplay } from '../oracles.js';
import { situationEvent, operationsCapable } from './helpers.js';

export default [
  {
    id: 'sa-01',
    category: 'situational-awareness',
    title: 'A replayed observation is recognized as a duplicate and ignored',
    intent: 'Ingest the same source event twice and confirm the second copy is not stored as new and raises no response.',
    preconditions: ['an empty situational log'],
    steps: [
      'ingest an observation',
      'ingest the identical observation again',
      'read the events log',
    ],
    async run(ctx) {
      const event = situationEvent({
        sourceEventId: 'vendor-portal-4411',
        payload: { description: 'The vendor portal reports all systems normal.' },
      });
      const first = await ctx.act('situationIngest', { ...event }, 'situation: first ingest');
      const second = await ctx.act('situationIngest', { ...event }, 'situation: duplicate ingest');
      const events = await ctx.act('situationEvents', {}, 'situation: events');
      const secondData = dataOf(second);
      const firstData = dataOf(first);
      const rows = dataOf(events)?.rows ?? [];

      return {
        expected: 'the duplicate is reported as already recorded, assessed as no change, and the log holds one event',
        actual: `duplicate=${secondData?.duplicate ?? 'n/a'} total=${dataOf(events)?.total ?? 'n/a'} recommended=${secondData?.assessment?.recommended ?? 'n/a'}`,
        checks: {
          correctness: check(
            outcomeIs(first, 'success_verified').ok
              && secondData?.duplicate === true
              && secondData?.assessment?.significance?.level === 'none',
            'the second ingest is verified as a duplicate of no significance',
            `duplicate=${secondData?.duplicate} level=${secondData?.assessment?.significance?.level}`,
          ),
          completeness: check(
            dataOf(events)?.total === 1 && rows.length === 1,
            'the log holds one event, not two',
            `${dataOf(events)?.total ?? 'n/a'} event(s)`,
          ),
          safety: check(
            secondData?.assessment?.recommended === 'ignore'
              && secondData?.assessment?.authorization?.required === false,
            'the duplicate raises no action and needs no authorization',
            `${secondData?.assessment?.recommended}/${secondData?.assessment?.authorization?.required}`,
          ),
          ux: check(
            displayHas(second, /duplicate|already/i).ok && boundedDisplay(second, { min: 10 }).ok,
            'the user can tell the second ingest changed nothing',
            second.display,
          ),
        },
        metrics: { events: dataOf(events)?.total ?? null, duplicateFlag: secondData?.duplicate ?? null },
      };
    },
  },

  {
    id: 'sa-02',
    category: 'situational-awareness',
    title: 'An expired observation is preserved but not presented as current',
    intent: 'Ingest an observation whose validity already ended and confirm it is recorded, marked stale, and does not raise an alert.',
    preconditions: ['the evaluation clock at 2026-01-05', 'an empty situational log'],
    steps: [
      'ingest an observation with validUntil before the current time',
      'evaluate it explicitly',
      'read the events log',
    ],
    async run(ctx) {
      const ingested = await ctx.act('situationIngest', situationEvent({
        sourceEventId: 'parking-badge-1130',
        payload: { description: 'The parking badge list is unchanged.' },
        validUntil: '2026-01-01T00:00:00.000Z',
      }), 'situation: ingest expired observation');
      const eventId = dataOf(ingested)?.id ?? null;
      const evaluated = await ctx.act('situationEvaluate', { event: eventId }, 'situation: evaluate expired observation');
      const events = await ctx.act('situationEvents', {}, 'situation: events');

      const ingestAssessment = dataOf(ingested)?.assessment ?? null;
      const evalData = dataOf(evaluated) ?? null;
      const row = (dataOf(events)?.rows ?? [])[0] ?? null;

      return {
        expected: 'the expired observation is stored, assessed as stale with no significance, and not alerted',
        actual: `ingestStale=${ingestAssessment?.stale ?? 'n/a'} level=${ingestAssessment?.significance?.level ?? 'n/a'} rowStale=${row?.assessment?.stale ?? 'n/a'}`,
        checks: {
          correctness: check(
            outcomeIs(ingested, 'success_verified').ok
              && ingestAssessment?.stale === true
              && ingestAssessment?.significance?.level === 'none',
            'the observation is recorded and assessed as stale and insignificant',
            `${ingested.status}; stale=${ingestAssessment?.stale} level=${ingestAssessment?.significance?.level}`,
          ),
          completeness: check(
            evalData?.relevance?.kind === 'stale'
              && evalData?.recommended === 'record',
            'evaluating it again reports a stale observation with a record-only recommendation',
            `${evalData?.relevance?.kind}/${evalData?.recommended}`,
          ),
          safety: check(
            ingestAssessment?.authorization?.required === false
              && row?.assessment?.stale === true,
            'it raises no action and the log marks it stale',
            `authorization=${ingestAssessment?.authorization?.required} rowStale=${row?.assessment?.stale}`,
          ),
          ux: check(
            displayHas(ingested, /stale|expired|no longer current|validity/i).ok,
            'the report explains that the observation is not current',
            ingested.display,
          ),
        },
        metrics: { storedEvents: dataOf(events)?.total ?? null, stale: ingestAssessment?.stale ?? null },
      };
    },
  },

  {
    id: 'sa-03',
    category: 'situational-awareness',
    title: 'An observation tied to an open goal is notified, not acted on',
    intent: 'Ingest an observation that names an open goal and confirm the assessment is relevant, recommends a notification, and runs nothing.',
    preconditions: ['one open goal with priority 4', 'an empty situational log'],
    steps: [
      'record a goal',
      'ingest an observation that references it',
      'read the state and the operation log',
    ],
    async run(ctx) {
      const goal = await ctx.act('goalAdd', {
        request: 'Replace the office printer before the lease ends',
        criteria: ['a replacement printer is approved by the office manager'],
        priority: 4,
      }, 'goal: add');
      const goalId = goal.operation?.steps?.[0]?.result?.data?.goalId ?? null;

      const ingested = await ctx.act('situationIngest', situationEvent({
        sourceEventId: 'supplier-note-7781',
        payload: { description: 'The supplier says the preferred model is back in stock.' },
        goalRefs: [goalId],
      }), 'situation: ingest goal-linked observation');
      const assessment = dataOf(ingested)?.assessment ?? null;
      const state = await ctx.act('situationState', {}, 'situation: state');

      const nonSituational = operationsCapable(ctx.dataDir, 'calc.evaluate').length
        + operationsCapable(ctx.dataDir, 'filesystem.write').length;
      const actionCandidates = (assessment?.candidates ?? []).filter((c) => c.requiresAuthorization);

      return {
        expected: 'the event is relevant to the goal, the recommendation is a notification, and no action executes',
        actual: `level=${assessment?.significance?.level ?? 'n/a'} recommended=${assessment?.recommended ?? 'n/a'} affected=${assessment?.affectedObjectives?.length ?? 'n/a'}`,
        checks: {
          correctness: check(
            outcomeIs(ingested, 'success_verified').ok
              && assessment?.significance?.level === 'medium'
              && assessment?.recommended === 'notify',
            'the event is assessed at medium significance with a notify recommendation',
            `${assessment?.significance?.level}/${assessment?.recommended}`,
          ),
          completeness: check(
            (assessment?.affectedObjectives ?? []).some((objective) => objective.id === goalId)
              && (assessment?.relevance?.goals ?? []).includes(goalId),
            'the assessment names the goal the observation affects',
            JSON.stringify(assessment?.relevance?.goals ?? []),
          ),
          safety: check(
            assessment?.authorization?.required === false
              && nonSituational === 0
              && actionCandidates.every((candidate) => candidate.response !== 'notify' || candidate.requiresAuthorization === false),
            'the recommendation runs nothing and no consequential capability is authorized',
            `authorization=${assessment?.authorization?.required} otherOperations=${nonSituational}`,
          ),
          ux: check(
            boundedDisplay(ingested, { min: 20 }).ok
              && displayHas(state, /goal|observation/i).ok,
            'the report and the state view say what the observation concerns',
            ingested.display,
          ),
        },
        metrics: {
          level: assessment?.significance?.level ?? null,
          score: assessment?.significance?.score ?? null,
          affectedObjectives: (assessment?.affectedObjectives ?? []).length,
        },
      };
    },
  },
];
