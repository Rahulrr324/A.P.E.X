// The user-facing surface of cross-store cognitive history: one read-only action that replays the
// experience log, the prediction ledger, and the world model to a cutoff and reports what each store
// had recorded by then, what changed later, and what it cannot answer at all.
//
// The action is a read in the registry's sense: it writes no store, takes no model call, and cannot
// authorize anything. It is deliberately not plannable. A plan step that names this action would make
// a plan depend on a historical view of the plan's own inputs, and the same reconstruction is
// available to the user directly with an explicit cutoff; nothing about planning is improved by
// letting a model schedule it. The model origin may still run it through the registry, which is what
// keeps the answer usable in a request that needs it, but the cutoff and the uncertainty travel with
// the result: `asOf` states whether the combined read was consistent, and every row that exists now
// but not at the cutoff is marked as later rather than folded into the past.
import { ValidationError } from '../errors.js';
import { parseIsoInstant, singleLine } from '../util.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import { DEFAULT_HISTORY_ROWS, MAX_HISTORY_ROWS, reconstructCognition } from '../history/reconstruct.js';

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

// The cutoff is strict on purpose: a zone-less date-time parses differently on two machines, and a
// historical reading must not depend on the reader's clock. The store replays use the same parsing
// for record timestamps; this only refuses an ambiguous question before it is asked.
function cutoffField(value) {
  if (value === undefined || value === null) throw new ValidationError('at is required: the cutoff to reconstruct');
  if (typeof value !== 'string' || parseIsoInstant(value) === null) {
    throw new ValidationError(`at must be an ISO date or an ISO date-time with a time zone, such as 2026-01-01 or 2026-01-01T09:00:00Z`);
  }
  return parseIsoInstant(value);
}

function limitField(value) {
  if (value === undefined) return DEFAULT_HISTORY_ROWS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_ROWS) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_HISTORY_ROWS}`);
  }
  return value;
}

function sourceLine(entry) {
  const suffix = entry.detail ? ` (${entry.detail})` : '';
  return `${entry.name} ${entry.status}${suffix}`;
}

function laterMarks(row) {
  const marks = [];
  if (row.correctedLater) marks.push('corrected later');
  if (row.feedbackAddedLater) marks.push('feedback added later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

function predictionMarks(row) {
  const marks = [];
  if (row.evaluationRecordedLater) marks.push('evaluated later');
  if (row.invalidatedLater) marks.push('withdrawn later');
  if (row.supersededLater) marks.push('replaced later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

// Every part of the answer appears here: what was replayed, what is shown, what is later, what could
// not be read, and the cutoff rule. The printed rows are the same bounded rows the data carries, so
// nothing in the display can exceed what the operation recorded.
function render(view) {
  const lines = [];
  lines.push(`Cognitive history at ${view.cutoff}${view.readAt === null ? '' : ` (read at ${view.readAt})`}`);
  lines.push(`snapshot: ${view.asOf.state}${view.asOf.complete ? ', complete' : ''}; ${view.asOf.sources.map(sourceLine).join('; ')}`);
  lines.push(`verifiable: ${view.asOf.verifiable ? 'yes' : 'no'}; rows bounded at ${view.limits.rows}, citations at ${view.limits.citations}`);

  const experience = view.experience;
  if (experience.available) {
    lines.push('');
    const undated = experience.undated > 0 ? `, ${experience.undated} undated record(s) excluded` : '';
    lines.push(`experience: ${experience.counts.experiences} experience(s), ${experience.counts.feedback} feedback, ${experience.counts.adaptations} adaptation(s), ${experience.counts.reviews} review(s) recorded by then; ${experience.excluded} later record(s) excluded${undated}`);
    for (const row of experience.rows) {
      const feedback = row.feedback.total === 0 ? 'no feedback' : `${row.feedback.current} current feedback`;
      lines.push(`  ${row.occurredAt ?? row.createdAt}  ${row.id}  ${row.capability ?? '(no capability)'}  ${row.outcomeClass ?? row.outcome ?? 'no outcome'}  ${feedback}${laterMarks(row)}`);
    }
    if (experience.truncated) lines.push(`  (${experience.total - experience.rows.length} older row(s) not shown)`);
  } else {
    lines.push('');
    lines.push(`experience: ${experience.status} - ${experience.reason}`);
  }

  const predictions = view.predictions;
  if (predictions.available) {
    lines.push('');
    const undated = predictions.undated > 0 ? `, ${predictions.undated} undated ledger record(s) excluded` : '';
    lines.push(`predictions: ${predictions.recorded} recorded by then, ${predictions.opened} opened${undated}; statuses ${JSON.stringify(predictions.totals.byStatus)}`);
    for (const row of predictions.rows) {
      const verdict = row.verdict === null ? '' : `, verdict ${row.verdict}`;
      lines.push(`  ${row.createdAt}  ${row.id}  ${row.capability}  ${row.status} (${row.decision}${verdict})${predictionMarks(row)}`);
    }
    if (predictions.truncated) lines.push(`  (${predictions.recorded - predictions.opened} older prediction(s) not opened)`);
  } else {
    lines.push('');
    lines.push(`predictions: ${predictions.status} - ${predictions.reason}`);
  }

  const world = view.world;
  lines.push('');
  if (world.available) {
    const c = world.counts ?? {};
    lines.push(`world: ${c.entities ?? 0} entit(ies), ${c.facts ?? 0} fact(s), ${c.relationships ?? 0} relationship(s), ${c.events ?? 0} event(s) from ${world.records} replayed record(s); ${world.excluded} later record(s) excluded; ${world.later.changes} later change(s)`);
    if (world.problems.length > 0) lines.push(`  problems: ${world.problems.join('; ')}`);
  } else {
    lines.push(`world: ${world.status} - ${world.reason}`);
  }

  if (view.citations.rows.length > 0) {
    lines.push('');
    lines.push(`citations: ${view.citations.total} record(s) cited, ${view.citations.references} reference(s)`);
    for (const row of view.citations.rows) {
      if (row.state === 'recorded') continue;
      lines.push(`  ${row.kind} ${row.id}: ${row.state}${row.reason ? ` - ${row.reason}` : ''}`);
    }
  }

  lines.push('');
  lines.push(`later: experiences ${view.later.experiencesRecorded ?? '?'}, feedback ${view.later.feedbackRecorded ?? '?'}, predictions ${view.later.predictionsRecorded ?? '?'}, evaluations ${view.later.evaluationsRecorded ?? '?'}, withdrawals ${view.later.invalidationsRecorded ?? '?'}, world changes ${view.later.worldRecordsAdded ?? '?'}`);
  lines.push(`unsupported: ${view.unsupported.map((item) => item.source).join(', ')}`);
  lines.push(`rule: ${view.rule}`);
  lines.push(view.note);
  return lines.join('\n');
}

function reconstruct(ctx, { at, limit }, fallback) {
  return reconstructCognition({
    cutoff: at,
    experience: ctx?.experience ?? fallback.experience,
    predictions: ctx?.predictions ?? fallback.predictions,
    world: ctx?.worldModel ?? fallback.world,
    limit,
    now: ctx?.now,
  });
}

// A re-read can legitimately differ in `readAt` and in the snapshot's retry count; every other field
// is a statement about the records, so a difference there means the logs moved between the two reads
// and the operation's answer can no longer be confirmed.
function comparable(view) {
  return JSON.stringify({ ...view, readAt: null, asOf: { ...view.asOf, attempts: null } });
}

export function historyActions({ experience = null, predictions = null, world = null } = {}) {
  const fallback = { experience, predictions, world };
  return [
    {
      name: 'history.reconstruct',
      description: 'Reconstruct what the experience log, the prediction ledger, and the world model had recorded by a cutoff, with what the stores recorded later kept separate. Records are filtered by recorded time, not event or valid time; a source that cannot be read or cannot answer a cutoff is named rather than omitted. Read-only; it writes nothing, calls no model, and authorizes nothing.',
      inputHint: '{"at":"required ISO date or zoned date-time cutoff","limit":optional 1-50 rows per store}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // See the header: a plan is not made better by scheduling a historical view of its own inputs.
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['at', 'limit']);
        return { at: cutoffField(o.at), limit: limitField(o.limit) };
      },
      async execute(ctx, query) {
        const view = await reconstruct(ctx, query, fallback);
        const experienceCount = view.experience.available ? view.experience.counts.experiences : null;
        const predictionCount = view.predictions.available ? view.predictions.recorded : null;
        return {
          summary: `cognition at ${view.cutoff}: ${experienceCount === null ? 'experience unavailable' : `${experienceCount} experience(s)`}, ${predictionCount === null ? 'predictions unavailable' : `${predictionCount} prediction(s)`}; snapshot ${view.asOf.state}; nothing written`,
          data: { query, view },
          display: render(view),
        };
      },
      async verify(ctx, query, result) {
        const fresh = await reconstruct(ctx, query, fallback);
        if (comparable(fresh) !== comparable(result.data.view)) {
          return { ok: false, detail: 'an independent reconstruction reported different records or lifecycle state for the same cutoff' };
        }
        return {
          ok: true,
          detail: `reconstruction confirmed by an independent read: ${fresh.asOf.state}, ${fresh.asOf.complete ? 'complete' : 'not complete'}; a consistent snapshot is not a claim of historical truth`,
        };
      },
    },
  ];
}
