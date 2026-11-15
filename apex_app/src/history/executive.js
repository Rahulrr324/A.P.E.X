// Historical executive state: what the goal, plan, and task logs had recorded by a cutoff, and what the
// operations audit log can and cannot say about the same instant.
//
// The three executive logs record a `.at` on every event and have a pure reducer, so their cutoff view
// is the store's own replay: a later completion, approval, revision, start, or outcome is simply absent
// from the past state. This module never merges the historical and current views; a difference is
// reported as a `later` flag beside the historical row, so a reader sees what was known then and what
// is known now as two separate statements.
//
// The audit log is different and is kept that way. A line is written only when an operation finalizes
// and it carries no recorded-at field, so no cutoff can prove that a line existed at an instant. The
// operations section is therefore a current read with an explicit per-row classification: a record
// whose request or finish is after the cutoff provably did not exist then (`later`); one that finished
// by the cutoff may or may not have been written by then (`finished_by_cutoff`), and the report says
// so instead of counting it as past knowledge. A citation from a record stored by the cutoff to an
// operation that finished after it is reported as inconsistent, never repaired.
//
// None of this is authorization, replay, or resumption. A historical approval is a record of what the
// user authorized then; a task running at the cutoff stays running; nothing here starts anything.
import { singleLine } from '../util.js';
import { goalProgress } from '../goals/model.js';
import { planProgress, planRisk } from '../plans/model.js';
import { progressOf } from '../tasks/model.js';

const MAX_ITEM_TEXT = 160;
const MAX_DESCRIPTION_TEXT = 120;
const MAX_OUTCOME_TEXT = 200;
const MAX_RECORD_OPERATIONS = 4;

function text(value, max = MAX_ITEM_TEXT) {
  return typeof value === 'string' ? singleLine(value, max) : null;
}

function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function uniqueIds(values, max = MAX_RECORD_OPERATIONS) {
  const seen = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!seen.includes(value)) seen.push(value);
    if (seen.length >= max) break;
  }
  return seen;
}

function evidenceCounts(criterion) {
  const evidence = criterion.evidence ?? [];
  return {
    total: evidence.length,
    supporting: evidence.filter((entry) => entry.kind === 'supports').length,
    contradicting: evidence.filter((entry) => entry.kind === 'contradicts').length,
  };
}

function criterionRow(criterion) {
  const counts = evidenceCounts(criterion);
  return {
    id: criterion.id,
    description: text(criterion.description, MAX_DESCRIPTION_TEXT),
    basis: criterion.basis ?? null,
    requirement: criterion.requirement ?? null,
    status: criterion.status,
    evidence: counts,
    operationIds: uniqueIds((criterion.evidence ?? []).map((entry) => entry.operationId)),
  };
}

function goalOperationIds(goal) {
  const ids = [];
  for (const criterion of goal.criteria ?? []) {
    for (const entry of criterion.evidence ?? []) ids.push(entry.operationId);
  }
  for (const entry of goal.completion?.criteria ?? []) ids.push(entry.operationId);
  return uniqueIds(ids, MAX_RECORD_OPERATIONS * 2);
}

// One goal as the log held it at the cutoff, beside what later records say about it now. `stoppedLater`
// is a narrower statement than `statusChangedLater`: it names a terminal stop the user did not know
// about at the cutoff, which is the difference between "still open then" and "ended since".
export function goalRow(goal, now) {
  const current = now ?? null;
  const totalEvidence = (g) => (g.criteria ?? []).reduce((sum, c) => sum + (c.evidence?.length ?? 0), 0);
  const stopped = ['failed', 'cancelled', 'abandoned', 'superseded'];
  return {
    id: goal.id,
    request: text(goal.request),
    status: goal.status,
    priority: goal.priority,
    deadline: goal.deadline ?? null,
    revision: goal.revision ?? 1,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    progress: goalProgress(goal),
    criteriaTotal: (goal.criteria ?? []).length,
    criteria: (goal.criteria ?? []).map(criterionRow),
    completion: goal.completion === null || goal.completion === undefined ? null : {
      at: goal.completion.at,
      criteria: (goal.completion.criteria ?? []).map((entry) => ({
        criterionId: entry.criterionId,
        operationId: entry.operationId ?? null,
      })),
      declined: [...(goal.completion.declined ?? [])],
    },
    links: {
      plans: [...(goal.planIds ?? [])],
      tasks: [...(goal.taskIds ?? [])],
      entities: [...(goal.entityIds ?? [])],
      worldEvents: [...(goal.worldEventIds ?? [])],
    },
    operationIds: goalOperationIds(goal),
    supersededBy: goal.supersededBy ?? null,
    later: {
      statusChangedLater: current !== null && current.status !== goal.status,
      stoppedLater: current !== null && stopped.includes(current.status) && !stopped.includes(goal.status),
      revisionAdvancedLater: current !== null && (current.revision ?? 1) > (goal.revision ?? 1),
      completionRecordedLater: (goal.completion ?? null) === null && (current?.completion ?? null) !== null,
      evidenceAddedLater: current !== null && totalEvidence(current) > totalEvidence(goal),
    },
    now: current === null ? null : {
      status: current.status,
      revision: current.revision ?? 1,
      completionAt: current.completion?.at ?? null,
      satisfied: goalProgress(current).satisfied,
    },
  };
}

function planOperationIds(plan) {
  const ids = [];
  for (const result of Object.values(plan.stepResults ?? {})) ids.push(result?.operationId);
  for (const assessment of plan.assessments ?? []) {
    for (const finding of assessment.findings ?? []) {
      for (const id of finding.operations ?? []) ids.push(id);
    }
  }
  return uniqueIds(ids, MAX_RECORD_OPERATIONS * 2);
}

// One plan version as it stood at the cutoff. The reducer keeps only the version current at the
// cutoff, which is exactly what a cutoff asks for, and the approval it carries names that version and
// content hash. `usable` is always false: it records what the user authorized then, and running the
// plan today revalidates it against live state.
export function planRow(plan, now) {
  const current = now ?? null;
  const results = plan.stepResults ?? {};
  const assessments = plan.assessments ?? [];
  const latest = assessments.length === 0 ? null : assessments[assessments.length - 1];
  return {
    id: plan.id,
    goalId: plan.goalId ?? null,
    goalRevision: plan.goalRevision ?? null,
    version: plan.version,
    status: plan.status,
    origin: plan.origin ?? null,
    outcome: text(plan.outcome, MAX_OUTCOME_TEXT),
    risk: planRisk(plan.steps),
    progress: planProgress(plan),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: (plan.steps ?? []).map((step) => ({
      id: step.id,
      description: text(step.description, MAX_DESCRIPTION_TEXT),
      action: step.action,
      permission: step.permission,
      dependsOn: [...(step.dependsOn ?? [])],
      risk: step.risk ?? null,
      result: results[step.id] === undefined ? null : {
        status: results[step.id].status,
        operationId: results[step.id].operationId ?? null,
        at: results[step.id].at ?? null,
      },
    })),
    approval: plan.approval === null || plan.approval === undefined ? null : {
      at: plan.approval.at,
      version: plan.approval.version,
      contentHash: plan.approval.contentHash,
      validationOk: plan.approval.validation?.ok ?? null,
      usable: false,
    },
    activation: plan.activation === null || plan.activation === undefined ? null : {
      at: plan.activation.at,
      taskId: plan.activation.taskId,
      version: plan.activation.version,
      contentHash: plan.activation.contentHash,
    },
    assessments: {
      count: assessments.length,
      latest: latest === null ? null : {
        at: latest.at,
        verdict: latest.verdict,
        planVersion: latest.planVersion,
      },
    },
    operationIds: planOperationIds(plan),
    blockedReason: plan.blockedReason ? text(plan.blockedReason, MAX_OUTCOME_TEXT) : null,
    failureReason: plan.failureReason ? text(plan.failureReason, MAX_OUTCOME_TEXT) : null,
    cancelledReason: plan.cancelledReason ? text(plan.cancelledReason, MAX_OUTCOME_TEXT) : null,
    supersededBy: plan.supersededBy ?? null,
    later: {
      approvedLater: (plan.approval ?? null) === null && (current?.approval ?? null) !== null,
      activatedLater: (plan.activation ?? null) === null && (current?.activation ?? null) !== null,
      revisedLater: current !== null && current.version > plan.version,
      statusChangedLater: current !== null && current.status !== plan.status,
      supersededLater: current !== null && (current.supersededBy ?? null) !== null && (plan.supersededBy ?? null) === null,
      outcomeRecordedLater: current !== null
        && Object.keys(current.stepResults ?? {}).length > Object.keys(plan.stepResults ?? {}).length,
      assessedLater: current !== null && (current.assessments ?? []).length > assessments.length,
    },
    now: current === null ? null : {
      version: current.version,
      status: current.status,
      approvalAt: current.approval?.at ?? null,
      activationAt: current.activation?.at ?? null,
      taskId: current.activation?.taskId ?? null,
    },
  };
}

function taskOperationIds(task) {
  return uniqueIds((task.steps ?? []).map((step) => step.operationId), MAX_RECORD_OPERATIONS * 2);
}

// One task as the log held it at the cutoff. A task running or paused then, or a step left running or
// uncertain, is reported as interrupted with its effects unresolved; reading it never resumes it, and a
// completed step is only ever shown with the outcome the log recorded for it.
export function taskRow(task, now) {
  const current = now ?? null;
  const steps = task.steps ?? [];
  const openSteps = steps.filter((step) => ['running', 'uncertain', 'awaiting_approval'].includes(step.status));
  return {
    id: task.id,
    goal: text(task.goal),
    origin: task.origin,
    planner: task.planner,
    goalId: task.goalId ?? null,
    planId: task.planId ?? null,
    status: task.status,
    approvedAt: task.approvedAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: progressOf(task),
    stepCounts: countBy(steps, (step) => step.status),
    interruptedAtCutoff: ['running', 'paused'].includes(task.status) || openSteps.length > 0,
    steps: steps.map((step) => ({
      id: step.id,
      description: text(step.description, MAX_DESCRIPTION_TEXT),
      action: step.action,
      permission: step.permission,
      dependsOn: [...(step.dependsOn ?? [])],
      status: step.status,
      operationId: step.operationId ?? null,
      outcome: step.outcome ?? null,
      approved: step.approval !== null && step.approval !== undefined,
    })),
    operationIds: taskOperationIds(task),
    lastReason: task.lastReason ? text(task.lastReason, MAX_OUTCOME_TEXT) : null,
    later: {
      statusChangedLater: current !== null && current.status !== task.status,
      stepCompletedLater: current !== null
        && current.steps.filter((step) => step.status === 'completed').length
          > steps.filter((step) => step.status === 'completed').length,
      recoveredLater: current !== null
        && ['failed', 'paused'].includes(task.status)
        && !['failed', 'paused'].includes(current.status),
    },
    now: current === null ? null : {
      status: current.status,
      progress: progressOf(current),
      stepCounts: countBy(current.steps, (step) => step.status),
    },
  };
}

// The operations audit log carries `requestedAt` and `finishedAt` but no recorded-at, and a line is
// appended only at finalization. This classification is the whole of what that permits: a record whose
// latest timestamp is after the cutoff provably did not exist then; one that finished by the cutoff may
// have been written before it or after it, and that is stated as unknown rather than guessed.
function operationStateAtCutoff(record, cutoffMs) {
  const requested = Date.parse(record.requestedAt);
  if (Number.isNaN(requested)) return { state: 'unknown', reason: 'the record has no valid requestedAt timestamp' };
  if (record.finishedAt === undefined || record.finishedAt === null) {
    return { state: 'unrecorded_finish', reason: 'the record has no finishedAt timestamp, so the append cannot be placed' };
  }
  const finished = Date.parse(record.finishedAt);
  if (Number.isNaN(finished)) return { state: 'unknown', reason: 'the record has an invalid finishedAt timestamp' };
  if (Math.max(requested, finished) > cutoffMs) {
    return { state: 'later', reason: 'the operation had not finished by the cutoff, so its audit line did not exist then' };
  }
  return {
    state: 'finished_by_cutoff',
    reason: 'the operation finished by the cutoff; the audit line is appended at finalization, so whether it was written by then is not recorded',
  };
}

function operationSortKey(record) {
  const finished = Date.parse(record.finishedAt ?? '');
  if (!Number.isNaN(finished)) return finished;
  const requested = Date.parse(record.requestedAt ?? '');
  return Number.isNaN(requested) ? 0 : requested;
}

function compareOperationNewestFirst(a, b) {
  const am = operationSortKey(a);
  const bm = operationSortKey(b);
  if (am !== bm) return bm - am;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

// The operations section is a current read, not a cutoff read, and says both things in its own shape.
// `supportsCutoff: false` and `recordedAtKnown: false` are fields, not a footnote: a caller that reads
// only the rows still sees `existedAtCutoff: unknown` on every row that was not provably later.
export function operationsSection(read, { cutoff, status, limit }) {
  if (!read) {
    return {
      available: false,
      supportsCutoff: false,
      recordedAtKnown: false,
      status,
      reason: 'the operations audit log was not read',
      cutoff,
      records: null,
      corrupt: null,
      counts: null,
      rows: [],
      total: 0,
      truncated: false,
      note: 'the audit log has no recorded-at field; this read cannot say what it held at a cutoff',
    };
  }
  const cutoffMs = Date.parse(cutoff);
  const records = read.records ?? [];
  const corrupt = Array.isArray(read.corrupt) ? read.corrupt.length : 0;
  const ordered = [...records].sort(compareOperationNewestFirst);
  const shown = ordered.slice(0, limit);
  const byState = {};
  for (const record of records) {
    const { state } = operationStateAtCutoff(record, cutoffMs);
    byState[state] = (byState[state] ?? 0) + 1;
  }
  return {
    available: true,
    supportsCutoff: false,
    recordedAtKnown: false,
    status,
    reason: null,
    cutoff,
    records: records.length,
    corrupt,
    counts: {
      total: records.length,
      corrupt,
      byStatus: countBy(records, (record) => String(record.status ?? 'unknown')),
      byStateAtCutoff: byState,
      later: byState.later ?? 0,
    },
    rows: shown.map((record) => {
      const { state, reason } = operationStateAtCutoff(record, cutoffMs);
      return {
        id: record.id,
        requestedAt: record.requestedAt ?? null,
        finishedAt: record.finishedAt ?? null,
        capability: record.capability ?? null,
        origin: record.origin ?? null,
        status: record.status ?? null,
        request: text(record.request ?? '', MAX_ITEM_TEXT),
        stateAtCutoff: state,
        existedAtCutoff: state === 'later' ? false : 'unknown',
        reason,
      };
    }),
    total: ordered.length,
    truncated: ordered.length > shown.length,
    note: 'the audit log is appended when an operation finalizes and carries no recorded-at; a row that finished by the cutoff may still have been written after it, and a missing line never means an operation did not run',
  };
}

// Every operation id named by a reconstructed executive row, resolved against the current audit log.
// A record stored by the cutoff that cites an operation finishing after it is a chronology the records
// cannot support, so it is reported as later and marked inconsistent rather than read as evidence.
export function operationCitations({ citations, read, status, cutoff, max }) {
  const cutoffMs = Date.parse(cutoff);
  const byId = new Map();
  const corrupt = Array.isArray(read?.corrupt) ? read.corrupt.length : 0;
  for (const record of read?.records ?? []) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  const available = read !== null && read !== undefined;
  const rows = new Map();
  let references = 0;
  for (const citation of citations) {
    for (const id of citation.operationIds ?? []) {
      references += 1;
      let row = rows.get(id);
      if (!row) {
        row = { kind: 'operation', id, citedBy: [], state: null, reason: null, inconsistent: false };
        rows.set(id, row);
      }
      const label = `${citation.kind}:${citation.id}`;
      if (!row.citedBy.includes(label)) row.citedBy.push(label);
    }
  }
  for (const row of rows.values()) {
    row.citedBy.sort();
    if (!available) {
      row.state = 'unavailable';
      row.reason = `the operations log was not read (${status}), so this citation cannot be resolved`;
      continue;
    }
    const record = byId.get(row.id);
    if (!record) {
      // Damaged lines mean an id may simply not have parsed, so absence is not established.
      row.state = corrupt > 0 ? 'unavailable' : 'missing';
      row.reason = corrupt > 0
        ? `the audit log has ${corrupt} unreadable line(s), so absence of this operation is not established`
        : 'no audit record with this id appears in the log, so what it did is not recorded';
      continue;
    }
    const { state, reason } = operationStateAtCutoff(record, cutoffMs);
    row.state = state;
    row.finishedAt = record.finishedAt ?? null;
    row.requestedAt = record.requestedAt ?? null;
    row.outcome = record.status ?? null;
    if (state === 'later') {
      row.inconsistent = true;
      row.reason = `a record stored by the cutoff names this operation, but its audit line says it finished at ${record.finishedAt}, after the cutoff; the citation was not used as past evidence`;
    } else if (state === 'finished_by_cutoff') {
      row.reason = reason;
    }
  }
  const ordered = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown = ordered.slice(0, max);
  return {
    rows: shown,
    total: ordered.length,
    references,
    inconsistent: ordered.filter((row) => row.inconsistent).length,
    truncated: ordered.length > shown.length,
    note: 'resolved against the current audit log; a line written after the cutoff is reported as later and was not used as past evidence, and a line with no recorded-at cannot prove it existed at the cutoff',
  };
}

export const CUTOFF_SEMANTICS = Object.freeze({
  cutoff: 'the instant whose recorded state is asked for; every store filters on the time it records when it appends, unless the entry below says otherwise',
  recordedTime: 'when the store wrote the record: `.at` for goal, plan, and task events, `createdAt` for experience and predictions; this is the only time a cutoff filters on',
  eventTime: 'when the described event happened as the record states it, such as an experience `occurredAt`; it can precede the write and is never used to decide availability at a cutoff',
  validTime: 'the interval a world belief is asserted to hold (`validFrom`/`validUntil`); AP-15 applies it inside the world replay',
  evaluationTime: 'when a prediction verdict or plan assessment was recorded; an evaluation dated after the cutoff is not available to it',
  correctionTime: 'when a later record supersedes, contradicts, reviews, or corrects an earlier one; it changes how the past reads now, never what was recorded then',
  goals: 'events at or before the cutoff are replayed by the goal reducer; a later acceptance, activation, completion, cancellation, supersession, criterion decision, evidence record, or revision does not apply',
  plans: 'events at or before the cutoff are replayed by the plan reducer; a later approval, revision, activation, step outcome, assessment, or status change does not apply, and approval is bound to the version and content hash recorded then',
  tasks: 'events at or before the cutoff are replayed by the task reducer; a later start, completion, failure, retry, approval, or cancellation does not apply, and a task open at the cutoff remains open in the answer',
  operations: 'the audit log has no recorded-at and is appended only at finalization; this section is a current read with each row classified against the cutoff, so `finished_by_cutoff` never claims the line existed then',
});

export const EXECUTIVE_LIMITATIONS = Object.freeze([
  'goal, plan, and task views replay only events recorded at or before the cutoff; an event sequence written by a non-monotonic clock can fail to apply, which is reported as inconsistent and never repaired by reordering',
  'the plan reducer keeps the version current at the cutoff; a superseded earlier version body is not retained, so only the version that was current then is shown',
  'a historical plan approval records what the user authorized then and is bound to that version and content hash; it is not a current authorization, and running the plan today revalidates it',
  'a goal completion recorded by the cutoff shows the criterion-to-operation evidence recorded then; a resolved citation reports whether that audit record exists, not whether the evidence is true',
  'a task running or paused at the cutoff, or with a running or uncertain step, has unresolved effects; this read never resumes, retries, or executes it',
  'the operations log cannot answer a cutoff by itself: `finished_by_cutoff` means the operation finished by then, not that its line existed then, and a missing line never proves an operation did not run',
  'a record stored by the cutoff that cites an operation finishing after it is reported as an inconsistent citation rather than accepted as past evidence',
]);
