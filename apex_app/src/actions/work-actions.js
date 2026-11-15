// Work review: the goal, plan, and task records read together as one portfolio.
// This is a read action. It authorizes like any other read and writes nothing except its
// own operation record; the independent verifier re-reads all three stores and compares
// the counts, record ids, and attention items with what the action reported.
import { ValidationError } from '../errors.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import {
  buildWorkReview,
  renderWorkReview,
  WORK_DEFAULT_LIMIT,
  WORK_MAX_LIMIT,
  WORK_DEFAULT_HORIZON_DAYS,
  WORK_MAX_HORIZON_DAYS,
} from '../work/review.js';

function boundedInt(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function workActions() {
  return [
    {
      name: 'work.review',
      description: 'Portfolio view of recorded goals, plans, and tasks with the stored status, recorded deadlines, and items that need attention. Read-only; derived from stored records only.',
      inputHint: '{"limit": optional 1-50, "horizonDays": optional 0-365}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const raw = input ?? {};
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(raw)) {
          if (!['limit', 'horizonDays'].includes(key)) throw new ValidationError(`unexpected field "${key}"`);
        }
        return {
          limit: boundedInt(raw.limit, 'limit', WORK_DEFAULT_LIMIT, 1, WORK_MAX_LIMIT),
          horizonDays: boundedInt(raw.horizonDays, 'horizonDays', WORK_DEFAULT_HORIZON_DAYS, 0, WORK_MAX_HORIZON_DAYS),
        };
      },
      async execute(ctx, { limit, horizonDays }) {
        const data = await buildWorkReview({
          goals: ctx.goals,
          plans: ctx.plans,
          tasks: ctx.taskStore,
          // Optional: a configuration with no deadline ledger shows the same board it always did.
          deadlines: ctx.deadlines ?? undefined,
          now: ctx.now(),
          horizonDays,
          limit,
        });
        return {
          summary: `work review: ${data.counts.goals.open} open goal(s), ${data.counts.plans.open} open plan(s), ${data.counts.tasks.open} unfinished task(s), ${data.attention.length} attention item(s)`,
          data,
          display: renderWorkReview(data),
        };
      },
      async verify(ctx, input, result) {
        const fresh = await buildWorkReview({
          goals: ctx.goals,
          plans: ctx.plans,
          tasks: ctx.taskStore,
          deadlines: ctx.deadlines ?? undefined,
          now: ctx.now(),
          horizonDays: input.horizonDays,
          limit: input.limit,
        });
        const claimed = result.data;
        const ids = (items) => items.map((item) => item.id).join(',');
        const checks = [
          ['goal count', claimed.counts.goals.total, fresh.counts.goals.total],
          ['open goals', claimed.counts.goals.open, fresh.counts.goals.open],
          ['goal records', ids(claimed.goals), ids(fresh.goals)],
          ['plan count', claimed.counts.plans.total, fresh.counts.plans.total],
          ['open plans', claimed.counts.plans.open, fresh.counts.plans.open],
          ['plan records', ids(claimed.plans), ids(fresh.plans)],
          ['task count', claimed.counts.tasks.total, fresh.counts.tasks.total],
          ['unfinished tasks', claimed.counts.tasks.open, fresh.counts.tasks.open],
          ['task records', ids(claimed.tasks), ids(fresh.tasks)],
          ['source states', Object.values(claimed.sources).map((s) => s.state).join(','), Object.values(fresh.sources).map((s) => s.state).join(',')],
          ['attention items', claimed.attention.map((item) => `${item.kind}:${item.subject}`).join('|'), fresh.attention.map((item) => `${item.kind}:${item.subject}`).join('|')],
        ];
        // Only when the deadline ledger was part of the read: its ids, day counts, and overdue count
        // are re-derived from a fresh read against the same `now`, exactly like the other sources.
        if (claimed.counts.deadlines && fresh.counts.deadlines) {
          checks.push(
            ['deadline count', claimed.counts.deadlines.total, fresh.counts.deadlines.total],
            ['deadlines within horizon', claimed.counts.deadlines.within, fresh.counts.deadlines.within],
            ['overdue deadlines', claimed.counts.deadlines.overdue, fresh.counts.deadlines.overdue],
            ['deadline records', ids(claimed.deadlines ?? []), ids(fresh.deadlines ?? [])],
            [
              'deadline day counts',
              (claimed.deadlines ?? []).map((item) => `${item.id}:${item.daysUntil}`).join(','),
              (fresh.deadlines ?? []).map((item) => `${item.id}:${item.daysUntil}`).join(','),
            ],
          );
        }
        const changed = checks.find(([, a, b]) => a !== b);
        if (changed) return { ok: false, detail: `${changed[0]} differs from an independent re-read of the stores` };
        return {
          ok: true,
          detail: `${fresh.counts.goals.total} goal(s), ${fresh.counts.plans.total} plan(s), and ${fresh.counts.tasks.total} task(s) confirmed against the stores`,
        };
      },
    },
  ];
}