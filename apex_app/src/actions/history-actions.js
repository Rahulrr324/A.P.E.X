// The user-facing surface of cross-store cognitive history: one read-only action that replays the
// experience log, the prediction ledger, the world model, the goal, plan, and task logs, and the
// memory and knowledge stores to a cutoff, and reports what each store had recorded by then, what
// changed later, and what it cannot answer at all. The operations audit log is read current, because
// it has no recorded-at: every row is classified against the cutoff instead of pretending the log can
// be queried as of an instant.
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

function goalMarks(row) {
  const marks = [];
  if (row.later.completionRecordedLater) marks.push('completed later');
  else if (row.later.stoppedLater) marks.push('stopped later');
  else if (row.later.statusChangedLater) marks.push('changed later');
  if (row.later.revisionAdvancedLater) marks.push('revised later');
  if (row.later.evidenceAddedLater) marks.push('evidence added later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

function planMarks(row) {
  const marks = [];
  if (row.later.approvedLater) marks.push('approved later');
  if (row.later.activatedLater) marks.push('activated later');
  if (row.later.revisedLater) marks.push('revised later');
  if (row.later.supersededLater) marks.push('superseded later');
  else if (row.later.statusChangedLater) marks.push('changed later');
  if (row.later.outcomeRecordedLater) marks.push('outcomes added later');
  if (row.later.assessedLater) marks.push('assessed later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

function taskMarks(row) {
  const marks = [];
  if (row.interruptedAtCutoff) marks.push('open or uncertain at cutoff');
  if (row.later.stepCompletedLater) marks.push('steps completed later');
  if (row.later.statusChangedLater && !row.later.stepCompletedLater) marks.push('changed later');
  if (row.later.recoveredLater) marks.push('recovered later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

function memoryMarks(row) {
  const marks = [];
  if (row.later.replacedLater) marks.push('corrected later');
  if (row.later.conflictChangedLater) marks.push('conflict changed later');
  return marks.length === 0 ? '' : ` [${marks.join('; ')}]`;
}

function knowledgeMarks(row) {
  const marks = [];
  if (row.later.retractedLater) marks.push('retracted later');
  if (row.later.supersededLater) marks.push('superseded later');
  if (row.later.resolutionRecordedLater) marks.push('resolved later');
  if (row.later.conflictChangedLater) marks.push('conflict changed later');
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

  const goals = view.goals;
  lines.push('');
  if (goals.available) {
    lines.push(`goals: ${goals.counts.goals} goal(s) recorded by then, ${goals.counts.live} live, ${goals.counts.completed} completed; ${goals.excluded} later event(s) excluded; statuses ${JSON.stringify(goals.counts.byStatus)}`);
    if (goals.problemCount > 0) lines.push(`  replay problems: ${goals.problemCount}; the replayed goal state is not reliable`);
    for (const row of goals.rows) {
      lines.push(`  ${row.createdAt}  ${row.id}  ${row.status}  priority ${row.priority}  rev ${row.revision}  ${row.progress.satisfied}/${row.progress.total} satisfied (${row.progress.gatingSatisfied}/${row.progress.gating} required)${goalMarks(row)}`);
      if (row.completion !== null) lines.push(`    completion recorded ${row.completion.at}: ${row.completion.criteria.length} criterion evidence reference(s), ${row.completion.declined.length} declined`);
    }
    if (goals.truncated) lines.push(`  (${goals.total - goals.rows.length} older goal(s) not shown)`);
  } else {
    lines.push(`goals: ${goals.status} - ${goals.reason}`);
  }

  const plans = view.plans;
  lines.push('');
  if (plans.available) {
    lines.push(`plans: ${plans.counts.plans} plan(s) recorded by then, ${plans.counts.approved} approved, ${plans.counts.active} activated; ${plans.excluded} later event(s) excluded; statuses ${JSON.stringify(plans.counts.byStatus)}`);
    if (plans.problemCount > 0) lines.push(`  replay problems: ${plans.problemCount}; the replayed plan state is not reliable`);
    for (const row of plans.rows) {
      const approval = row.approval === null
        ? 'not approved then'
        : `approved by the user ${row.approval.at} at version ${row.approval.version} (historical, not a current authorization)`;
      const activation = row.activation === null ? '' : `; activated ${row.activation.at} as task ${row.activation.taskId}`;
      lines.push(`  ${row.createdAt}  ${row.id}  v${row.version}  ${row.status}  risk ${row.risk}  ${row.progress.completed}/${row.progress.total} completed; ${approval}${activation}${planMarks(row)}`);
    }
    if (plans.truncated) lines.push(`  (${plans.total - plans.rows.length} older plan(s) not shown)`);
  } else {
    lines.push(`plans: ${plans.status} - ${plans.reason}`);
  }

  const tasks = view.tasks;
  lines.push('');
  if (tasks.available) {
    lines.push(`tasks: ${tasks.counts.tasks} task(s) recorded by then, ${tasks.counts.interrupted} open or uncertain; ${tasks.excluded} later event(s) excluded; statuses ${JSON.stringify(tasks.counts.byStatus)}`);
    if (tasks.problemCount > 0) lines.push(`  replay problems: ${tasks.problemCount}; the replayed task state is not reliable`);
    for (const row of tasks.rows) {
      lines.push(`  ${row.createdAt}  ${row.id}  ${row.status}  ${row.progress.completed}/${row.progress.total} step(s) completed${taskMarks(row)}`);
    }
    if (tasks.truncated) lines.push(`  (${tasks.total - tasks.rows.length} older task(s) not shown)`);
  } else {
    lines.push(`tasks: ${tasks.status} - ${tasks.reason}`);
  }

  const memory = view.memory;
  lines.push('');
  if (memory.available) {
    const private_ = memory.privateExcluded > 0 ? `, ${memory.privateExcluded} private record(s) excluded` : '';
    lines.push(`memory: ${memory.counts.memories} record(s) recorded by then, ${memory.counts.corrections} correction(s), ${memory.counts.conflictGroups} conflict group(s); ${memory.excluded} later record(s) excluded${private_}; statuses ${JSON.stringify(memory.counts.byStatus)}`);
    if (memory.problemCount > 0) lines.push(`  link problems: ${memory.problemCount}; the reconstructed memory lifecycle is not reliable`);
    for (const row of memory.rows) {
      const conflict = row.conflict === null ? '' : `, conflict on ${row.conflict.subject}`;
      const replaces = row.provenance.replaces.length === 0 ? '' : `, replaces ${row.provenance.replaces.length} record(s)`;
      lines.push(`  ${row.createdAt}  ${row.id}  ${row.kind}/${row.source}  ${row.status}${conflict}${replaces}${memoryMarks(row)}`);
    }
    if (memory.truncated) lines.push(`  (${memory.total - memory.rows.length} older record(s) not shown)`);
  } else {
    lines.push(`memory: ${memory.status} - ${memory.reason}`);
  }

  const knowledge = view.knowledge;
  lines.push('');
  if (knowledge.available) {
    lines.push(`knowledge: ${knowledge.counts.claims} claim(s) recorded by then, ${knowledge.counts.retractions} retraction(s), ${knowledge.counts.resolutions} resolution(s), ${knowledge.counts.active} active; ${knowledge.excluded} later record(s) excluded; lifecycle ${JSON.stringify(knowledge.counts.byLifecycleState)}; conflicts ${knowledge.counts.conflicts.total} (${knowledge.counts.conflicts.unresolved} unresolved)`);
    if (knowledge.problemCount > 0) lines.push(`  link problems: ${knowledge.problemCount}; the reconstructed knowledge lifecycle is not reliable`);
    for (const row of knowledge.rows) {
      const evidence = row.evidence === null ? '' : ' (free-text evidence, not a record reference)';
      const resolution = row.resolution === null ? '' : `, resolved by user decision (not verified truth)`;
      lines.push(`  ${row.createdAt}  ${row.id}  ${row.subject} --[${row.relationship}]--> ${row.object}  ${row.lifecycleState}${evidence}${resolution}${knowledgeMarks(row)}`);
    }
    if (knowledge.truncated) lines.push(`  (${knowledge.total - knowledge.rows.length} older claim(s) not shown)`);
  } else {
    lines.push(`knowledge: ${knowledge.status} - ${knowledge.reason}`);
  }

  const operations = view.operations;
  lines.push('');
  if (operations.available) {
    lines.push(`operations: ${operations.records} audit record(s), current read only; ${operations.counts.byStateAtCutoff.finished_by_cutoff ?? 0} finished by the cutoff (line existence at the cutoff not recorded), ${operations.counts.later} provably later${operations.corrupt > 0 ? `, ${operations.corrupt} unreadable line(s)` : ''}`);
    for (const row of operations.rows) {
      lines.push(`  ${row.finishedAt ?? row.requestedAt ?? '(no timestamp)'}  ${row.id}  ${row.capability ?? '(no capability)'}  ${row.status ?? 'no status'}  ${row.stateAtCutoff}`);
    }
    if (operations.truncated) lines.push(`  (${operations.total - operations.rows.length} older record(s) not shown)`);
  } else {
    lines.push(`operations: ${operations.status} - ${operations.reason}`);
  }

  const operationCitations = view.operationCitations;
  const notable = operationCitations.rows.filter((row) => row.state !== 'finished_by_cutoff');
  if (notable.length > 0) {
    lines.push('');
    lines.push(`operation citations: ${operationCitations.total} cited, ${operationCitations.inconsistent} inconsistent with the cutoff`);
    for (const row of notable) {
      lines.push(`  operation ${row.id}: ${row.state}${row.inconsistent ? ' (inconsistent)' : ''}${row.reason ? ` - ${row.reason}` : ''}`);
    }
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
  lines.push(`later: experiences ${view.later.experiencesRecorded ?? '?'}, feedback ${view.later.feedbackRecorded ?? '?'}, predictions ${view.later.predictionsRecorded ?? '?'}, evaluations ${view.later.evaluationsRecorded ?? '?'}, withdrawals ${view.later.invalidationsRecorded ?? '?'}, world changes ${view.later.worldRecordsAdded ?? '?'}, goal events ${view.later.goalsRecorded ?? '?'}, plan events ${view.later.plansRecorded ?? '?'}, task events ${view.later.tasksRecorded ?? '?'}, memory records ${view.later.memoryRecordsAdded ?? '?'}, memory corrections ${view.later.memoryCorrectionsRecorded ?? '?'}, knowledge claims ${view.later.knowledgeClaimsRecorded ?? '?'}, retractions ${view.later.knowledgeRetractionsRecorded ?? '?'}, resolutions ${view.later.knowledgeResolutionsRecorded ?? '?'}, operations finished after ${view.later.operationsFinishedLater ?? '?'}`);
  lines.push(`unsupported: ${view.unsupported.length === 0 ? 'none - every integrated store answers a cutoff listing' : view.unsupported.map((item) => item.source).join(', ')}`);
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
    goals: ctx?.goals ?? fallback.goals,
    plans: ctx?.plans ?? fallback.plans,
    tasks: ctx?.taskStore ?? fallback.tasks,
    memory: ctx?.memory ?? fallback.memory,
    knowledge: ctx?.knowledge ?? fallback.knowledge,
    operations: ctx?.operations ?? fallback.operations,
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

export function historyActions({
  experience = null, predictions = null, world = null, goals = null, plans = null, tasks = null,
  memory = null, knowledge = null, operations = null,
} = {}) {
  const fallback = {
    experience, predictions, world, goals, plans, tasks, memory, knowledge, operations,
  };
  return [
    {
      name: 'history.reconstruct',
      description: 'Reconstruct what the experience log, the prediction ledger, the world model, the goal, plan, and task logs, and the memory and knowledge stores had recorded by a cutoff, with what the stores recorded later kept separate. The operations audit log is read current and each row is classified against the cutoff because it has no recorded-at field. Records are filtered by recorded time, not event or valid time; a source that cannot be read or cannot answer a cutoff is named rather than omitted. Read-only; it writes nothing, calls no model, and authorizes nothing.',
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
        const count = (section, pick) => (section.available ? pick(section) : 'unavailable');
        return {
          summary: `history at ${view.cutoff}: ${count(view.experience, (s) => `${s.counts.experiences} experience(s)`)}, ${count(view.predictions, (s) => `${s.recorded} prediction(s)`)}, ${count(view.goals, (s) => `${s.counts.goals} goal(s)`)}, ${count(view.plans, (s) => `${s.counts.plans} plan(s)`)}, ${count(view.tasks, (s) => `${s.counts.tasks} task(s)`)}, ${count(view.memory, (s) => `${s.counts.memories} memory record(s)`)}, ${count(view.knowledge, (s) => `${s.counts.claims} knowledge claim(s)`)}, ${count(view.operations, (s) => `${s.records} operation(s) current`)}; snapshot ${view.asOf.state}; nothing written`,
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
