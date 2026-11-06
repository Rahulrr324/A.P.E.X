// Outcome assessment: what a plan's execution established, kept apart from what the plan set out to
// do and from what the user's goal asks for.
//
// The milestone's distinction is the whole reason this module exists. A step that ran and verified is
// a fact about the audit log. It is not the same fact as "the output the step expected exists", which
// is not the same as "the condition the step named is satisfied in the world", which is not the same
// as "the goal's criterion is met". Each of those is answered by a different record, so this joins the
// records rather than reasoning from the plan's prose:
//
//   - the plan's own recorded step outcomes (`plan.stepResults`),
//   - each cited operation, re-opened in the audit log,
//   - the goal's criteria and the state of their evidence now (`../goals/assess.js`),
//   - what the knowledge store still holds as written by those operations.
//
// The verifier checks that an action returned what it claims to return. It does not look at the world,
// so `success_verified` is never treated here as proof of a real-world result. Running a step also
// does not satisfy a goal criterion: criteria have their own evidence path, and a plan that ran
// perfectly can leave every criterion of its goal open.
//
// The verdict is one of six named states, reached by a disclosed precedence over what the records
// show. It is not a score, a probability, or a percentage, and it grants nothing: the plan's approval
// binds to its own content bytes, and recording an assessment changes no status, no approval, and no
// timestamp on the plan. Where the settling evidence lies outside APEX's records, the verdict says so
// instead of guessing, and `awaiting_confirmation` is not counted as a failure.
//
// Every finding cites only operations this module actually read and found. That is what lets the plan
// store accept it as an assessment: an answer with no record behind it is reported as unrecordable
// rather than written.
import { Outcome } from '../outcomes.js';
import { shortId, singleLine } from '../util.js';
import { StepStatus } from '../tasks/model.js';
import { EvidenceVerdict, assessGoal } from '../goals/assess.js';
import { Requirement, requirementOf } from '../goals/model.js';
import {
  ASSESSMENT_ASPECTS,
  MAX_ASSERTION_CHARS,
  MAX_ASSESSMENT_SUMMARY_CHARS,
  MAX_CITED_IDS,
  MAX_FINDINGS,
  VERDICT_REQUIRED_ASPECT,
  planContentHash,
  planProgress,
} from './model.js';

export const ASSESSMENT_NOTE = 'an outcome assessment is APEX reading its own records back: it is not a real-world confirmation, not a score or probability, and it authorizes nothing';

// The order the verdict rules are tried in, and the name of the rule that fired. Stated to the reader
// because a verdict whose cause is hidden is indistinguishable from a guess.
export const VERDICT_RULE = 'the first rule the records satisfy decides the verdict: failed, then uncertain, then blocked, then partial, then awaiting_confirmation, then successful';

// The seven questions, in the words they are shown in. Each one is answerable from a record, and none
// of them is answerable from the plan's own description of itself.
export const ASPECT_QUESTIONS = Object.freeze({
  step_completion: 'what status did each step record?',
  expected_output: 'does the output each step expected exist in that step\'s own audit record?',
  verification: 'did that step\'s own verifier reach a verdict, and what was it?',
  goal_criteria: 'which of the goal\'s criteria does this outcome settle?',
  evidence_state: 'what does the audit log hold behind these outcomes, read back now?',
  durability: 'does what the plan wrote still stand in the store it wrote to?',
  external_confirmation: 'what can only be confirmed from outside APEX\'s records?',
});

const NOT_RUN = 'not_run';

function stmt(text) {
  return singleLine(text, MAX_ASSERTION_CHARS);
}

function cite(ids) {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 64))].slice(0, MAX_CITED_IDS);
}

// A bounded list of names or ids inside one disclosure: what is shown, then how many more there are.
// A finding has to say which records it rests on and still fit the assertion bound, so the listing is
// capped and the remainder counted. Dropping the tail without counting it would leave a reader unable
// to tell whether the list was the whole answer.
function listed(items, { key = null, of = 3 } = {}) {
  const names = items.map((item) => (key ? shortId(item[key]) : String(item)));
  const shown = names.slice(0, of);
  const rest = names.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

// Joins several disclosures into one statement without cutting one of them mid-sentence. An answer cut
// short says nothing about what was lost, so whole items are kept and the remainder is counted.
function boundedJoin(parts) {
  const note = (n) => `${n} further item(s) not listed here`;
  const kept = [];
  for (const part of parts) {
    const rest = parts.length - kept.length - 1;
    const trial = [...kept, part, ...(rest > 0 ? [note(rest)] : [])].join('; ');
    if (trial.length > MAX_ASSERTION_CHARS) break;
    kept.push(part);
  }
  const omitted = parts.length - kept.length;
  if (!kept.length) {
    // The first disclosure alone does not fit the bound. It is still shown, cut at the bound, and where
    // there is more than one the count of what is not listed is kept beside it rather than dropped.
    if (parts.length < 2) return stmt(parts[0] ?? '');
    const room = MAX_ASSERTION_CHARS - 2 - note(parts.length - 1).length;
    return `${singleLine(parts[0] ?? '', room)}; ${note(parts.length - 1)}`;
  }
  if (omitted > 0) kept.push(note(omitted));
  return stmt(kept.join('; '));
}

// One operation, re-opened in the audit log. Four different things a reader must not have to guess
// between: the record is there, it is not there, the log could not be read, or no log is configured.
// The second is an integrity finding; the third and fourth establish nothing either way.
async function readOperations(operations, ids) {
  const reads = new Map();
  for (const id of ids) {
    if (!operations || typeof operations.findById !== 'function') {
      reads.set(id, { state: 'unavailable', record: null, detail: 'no audit log is configured for this request' });
      continue;
    }
    try {
      const found = await operations.findById(id);
      reads.set(id, found.found
        ? { state: 'present', record: found.record }
        : { state: 'absent', record: null, detail: `not in the log after ${found.inspected} line(s)${found.corrupt ? `, ${found.corrupt} unreadable` : ''}` });
    } catch (err) {
      reads.set(id, { state: 'unreadable', record: null, detail: err?.code ?? 'the audit log could not be read' });
    }
  }
  return reads;
}

// The step as its own audit record describes it. The TaskRunner writes one operation per step with
// `capability: 'task.step'`, the task and step ids it belongs to, the controller's step object in
// `steps[0]`, and the step's summary as `output`. Those fields are the only evidence this module has
// that a step produced anything at all.
function stepView(step, result, read, plan) {
  const record = read?.record ?? null;
  const audited = record && Array.isArray(record.steps) ? record.steps[0] ?? null : null;
  return {
    stepId: step.id,
    action: step.action,
    criterionId: step.criterionId ?? null,
    status: result?.status ?? NOT_RUN,
    detail: result?.detail ?? null,
    operationId: result?.operationId ?? null,
    auditState: !result ? NOT_RUN : !result.operationId ? 'no_operation' : (read?.state ?? 'unreadable'),
    recordStatus: record?.status ?? null,
    errors: Array.isArray(record?.errors) ? record.errors.length : 0,
    verifierOutcome: audited?.verification?.outcome ?? null,
    resultPresent: Boolean(audited?.result),
    outputPresent: typeof record?.output === 'string' && record.output.trim().length > 0,
    linkMatches: record
      ? record.capability === 'task.step'
        && record.task?.id === plan.activation?.taskId
        && record.task?.stepId === step.id
      : null,
  };
}

function one(states, name) {
  return states.filter((s) => s.auditState === name);
}

function withStatus(views, status) {
  return views.filter((v) => v.status === status);
}

// ---- the seven answers ------------------------------------------------------

function stepCompletion(views, progress) {
  const parts = [];
  for (const [status, name] of [
    [StepStatus.COMPLETED, 'completed'],
    [StepStatus.FAILED, 'failed'],
    [StepStatus.UNCERTAIN, 'uncertain'],
    [StepStatus.SKIPPED, 'skipped'],
  ]) {
    const hit = withStatus(views, status);
    if (hit.length) parts.push(`${hit.length} ${name} (${listed(hit.map((v) => v.stepId), { of: 4 })})`);
  }
  const notRun = withStatus(views, NOT_RUN);
  if (notRun.length) parts.push(`${notRun.length} with no recorded outcome (${listed(notRun.map((v) => v.stepId), { of: 4 })})`);
  return {
    aspect: 'step_completion',
    statement: boundedJoin([`${progress.completed} of ${progress.total} step(s) recorded completed`, ...(parts.length ? parts : ['nothing recorded'])]),
    operations: cite(views.filter((v) => v.auditState === 'present').map((v) => v.operationId)),
  };
}

// "The expected output exists" can only mean "the step's own record carries a result and an output" -
// the plan's `expectedResult` is prose about the world, and nothing here compares prose with a world
// it cannot observe. Saying which of the two this answer is stops the reading of more into it.
function expectedOutput(views) {
  const done = views.filter((v) => v.status !== NOT_RUN && v.operationId);
  const present = done.filter((v) => v.auditState === 'present' && v.resultPresent && v.outputPresent);
  const silent = done.filter((v) => v.auditState === 'present' && !(v.resultPresent && v.outputPresent));
  const unread = done.filter((v) => v.auditState !== 'present');
  const parts = [`${present.length} of ${done.length} step(s) have a result payload and a non-empty output in their own record`];
  if (silent.length) parts.push(`${listed(silent.map((v) => v.stepId), { of: 4 })} do not`);
  if (unread.length) parts.push(`${unread.length} could not be read`);
  parts.push('whether that is what the step expected is a question for the world, not this log');
  return {
    aspect: 'expected_output',
    statement: boundedJoin(parts),
    operations: cite([...present, ...silent].map((v) => v.operationId)),
  };
}

// The verifier's own verdict per step, plus the limit of what it checked. A step whose record says
// `verification_unavailable` is not a step that passed.
function verification(views) {
  const done = views.filter((v) => v.auditState === 'present');
  const tally = new Map();
  for (const v of done) {
    const key = v.verifierOutcome ?? 'no verdict in the record';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const counts = [...tally].map(([outcome, n]) => `${n} ${outcome}`).join(', ');
  const missing = views.filter((v) => v.status !== NOT_RUN && v.auditState !== 'present').length;
  const parts = [`${done.length} step(s) have a verifier verdict readable in their own record: ${counts || 'none readable'}`];
  if (missing) parts.push(`${missing} recorded outcome(s) could not be re-opened`);
  parts.push('the condition each step names is a claim about the world, which this verdict does not test');
  return {
    aspect: 'verification',
    statement: boundedJoin(parts),
    operations: cite(done.map((v) => v.operationId)),
  };
}

// Which criteria this plan's steps were aimed at, and what the goal record says about each of them
// now. Running a step is not satisfying a criterion - that needs evidence on the criterion itself.
function goalCriteria(views, goalAssessment) {
  const targeted = [...new Set(views.map((v) => v.criterionId).filter((id) => id))];
  const done = views.filter((v) => v.auditState === 'present');
  if (!goalAssessment) {
    return {
      aspect: 'goal_criteria',
      statement: stmt(`the plan records no goal, so no criterion is settled by it; whether the intention was met is the user's to say`
        + (targeted.length ? ` (its steps still name ${targeted.join(', ')})` : '')),
      operations: cite(done.map((v) => v.operationId)),
    };
  }
  const criteria = goalAssessment.criteria ?? [];
  const named = targeted.map((id) => criteria.find((c) => c.id === id)).filter((c) => c);
  const untargted = targeted.filter((id) => !criteria.some((c) => c.id === id));
  const openRequired = criteria
    .filter((c) => requirementOf(c) === Requirement.REQUIRED && c.status !== 'satisfied')
    .map((c) => c.id);
  // The clause naming what is still unsettled comes first: when the bound cuts the per-criterion list,
  // the reader still gets the part they would act on.
  const parts = [
    ...(openRequired.length ? [`still open and required: ${listed(openRequired)}`] : []),
    `${named.length} criterion(s) of goal ${shortId(goalAssessment.goalId)} named by these steps`,
    ...named.map((c) => `${c.id} ${c.status}${c.verdict === EvidenceVerdict.CURRENT ? ' (evidence stands)'
      : c.verdict === EvidenceVerdict.NONE ? ' (no evidence recorded)' : ` (evidence ${c.verdict})`}`),
    ...untargted.map((id) => `${id} is not a criterion of this goal`),
  ];
  return {
    aspect: 'goal_criteria',
    statement: boundedJoin(parts),
    operations: cite([
      ...done.map((v) => v.operationId),
      ...named.flatMap((c) => (c.evidence ?? [])
        .filter((e) => e.kind === 'supports' && [EvidenceVerdict.CURRENT, EvidenceVerdict.STALE].includes(e.verdict))
        .map((e) => e.operationId)),
    ]),
    records: cite(named.flatMap((c) => (c.evidence ?? []).flatMap((e) => (e.records ?? []).map((r) => r.id)))),
  };
}

// The audit log as it reads now, behind this plan's recorded outcomes: what is present, what is
// missing, what carries errors, and whether the records point back at the task that ran them.
function evidenceState(views, progress, readNote) {
  const present = one(views, 'present');
  const absent = one(views, 'absent');
  const unreadable = [...one(views, 'unreadable'), ...one(views, 'unavailable')];
  const nameless = views.filter((v) => v.status !== NOT_RUN && !v.operationId);
  const errored = present.filter((v) => v.errors > 0);
  const notVerified = present.filter((v) => v.recordStatus !== Outcome.SUCCESS_VERIFIED);
  const unlinked = present.filter((v) => v.linkMatches === false);
  const parts = [`${present.length} of ${progress.total} step(s) name an operation that is in the audit log`];
  if (absent.length) parts.push(`absent: ${listed(absent.map((v) => `${v.stepId}->${shortId(v.operationId)}`), { of: 2 })}`);
  if (unreadable.length) parts.push(`not checkable: ${listed(unreadable.map((v) => v.stepId), { of: 3 })}`);
  if (nameless.length) parts.push(`${listed(nameless.map((v) => v.stepId), { of: 3 })} recorded an outcome naming no operation`);
  if (errored.length) parts.push(`${listed(errored.map((v) => v.stepId), { of: 3 })} carry error(s) in their record`);
  if (notVerified.length) parts.push(`not a verified success: ${listed(notVerified.map((v) => `${v.stepId} as ${v.recordStatus}`), { of: 2 })}`);
  if (unlinked.length) parts.push(`${listed(unlinked.map((v) => v.stepId), { of: 3 })} name(s) a record that does not point back at this plan's task and step`);
  if (readNote) parts.push(readNote);
  return {
    aspect: 'evidence_state',
    statement: boundedJoin(parts),
    operations: cite(present.map((v) => v.operationId)),
  };
}

// Whether what the plan wrote still stands where it was written. The knowledge store answers by
// operation id, because a claim it established can be retracted or superseded afterwards while the
// operation itself can never change its past. The memory store holds no such index, so a memory write
// is reported as readable and not re-checkable, which is a limit to disclose rather than a result.
async function durability(views, { knowledge, memory }, memo) {
  const present = views.filter((v) => v.auditState === 'present');
  const current = [];
  const retired = [];
  const truncated = [];
  // An operation that established a knowledge claim is followed through that claim's lifecycle, which
  // is a stronger read than a record id. Only an operation that established none falls to the memory
  // read-back below, so the two views never report the same write twice.
  const matched = new Map();
  const memoryWrites = [];
  if (knowledge && typeof knowledge.byOperation === 'function') {
    for (const v of present) {
      let written;
      try {
        if (!memo.has(v.operationId)) memo.set(v.operationId, knowledge.byOperation(v.operationId));
        written = await memo.get(v.operationId);
      } catch {
        continue;
      }
      matched.set(v.operationId, written.records.length);
      if (written.truncated) truncated.push(v);
      for (const r of written.records) {
        (r.active === true ? current : retired).push({
          stepId: v.stepId,
          id: r.id,
          state: r.lifecycleState ?? r.state ?? (r.active === true ? 'current' : 'retired'),
        });
      }
    }
  }
  // A write that established no knowledge claim still names a record in its own result. Only the
  // store it belongs to can say whether it reads back, and the memory store has no lifecycle index by
  // operation, so its continued standing is a question for the reader rather than a result here.
  const unreadable = [];
  for (const v of present) {
    if (!v.payloadRecordId || (matched.get(v.operationId) ?? 0) > 0) continue;
    if (!memory || typeof memory.get !== 'function') {
      unreadable.push({ ...v, note: 'named no store this read could check it in' });
      continue;
    }
    try {
      const record = await memory.get(v.payloadRecordId);
      if (record) memoryWrites.push(v);
      else unreadable.push({ ...v, note: 'does not read back from the memory store' });
    } catch {
      unreadable.push({ ...v, note: 'could not be re-read: the memory store would not answer' });
    }
  }

  const parts = [];
  if (!knowledge) parts.push('no knowledge store is configured here, so nothing this plan wrote can be re-checked against a claim lifecycle');
  if (current.length) parts.push(`${current.length} claim(s) it established are still current (${listed(current, { key: 'id' })})`);
  if (retired.length) parts.push(`withdrawn since written: ${retired.map((r) => `${shortId(r.id)} ${r.state}`).slice(0, 3).join(', ')}${retired.length > 3 ? ` +${retired.length - 3} more` : ''}`);
  if (truncated.length) parts.push(`${listed(truncated.map((r) => r.stepId))} wrote more claims than this bounded read could show, so an unlisted one may have been withdrawn`);
  if (memoryWrites.length) {
    // The read-back is the result; the limit of what a read-back can say is part of the same statement,
    // so it is kept even when the listing has to shrink to hold it.
    parts.push(`${listed(memoryWrites.map((v) => v.stepId), { of: 2 })} wrote memory record(s) `
      + `(${listed(memoryWrites, { key: 'payloadRecordId', of: 2 })}) that still read back by id, `
      + 'but the memory store keeps no index by operation, so a later correction is not visible here');
  }
  for (const v of unreadable) parts.push(`${v.stepId} ${v.note}`);
  if (!parts.length) parts.push('no recorded step of this plan established a claim or record this read can follow');
  return {
    aspect: 'durability',
    statement: boundedJoin(parts),
    operations: cite(present.map((v) => v.operationId)),
    records: cite([...current, ...retired].map((r) => r.id)),
    hadMemoryWrite: memoryWrites.length > 0,
  };
}

// What only something outside APEX's records can settle. Kept separate from the questions the goal
// assessment puts to the user, because these bear on this plan's outcome rather than on its criteria.
function externalConfirmation(views, goalAssessment, plan, memoryWrites) {
  // The plan's own intended outcome leads the list. It is the one thing here that is about this plan
  // rather than about APEX's stores, so it is the item a bound must never cost the reader.
  const out = ['whether the intended outcome holds outside APEX\'s records: ' + singleLine(plan.outcome, 60)];
  const unrefWorld = (plan.assertions ?? []).filter((a) => ['world_fact', 'world_entity'].includes(a.kind) && !a.ref);
  if (unrefWorld.length) out.push(`${unrefWorld.length} world assertion(s) name no record, so no store can be asked about them`);
  if (goalAssessment) {
    const undecided = (goalAssessment.criteria ?? []).filter((c) => c.needsUserDecision).map((c) => c.id);
    if (undecided.length) out.push(`${listed(undecided, { of: 4 })} still ${undecided.length === 1 ? 'needs' : 'need'} your decision as a criterion`);
    const unverifiable = (goalAssessment.criteria ?? []).filter((c) => [EvidenceVerdict.UNVERIFIABLE, EvidenceVerdict.NONE].includes(c.verdict)).map((c) => c.id);
    if (unverifiable.length) out.push(`${listed(unverifiable, { of: 4 })} ${unverifiable.length === 1 ? 'has' : 'have'} no evidence APEX can check now`);
  }
  // Phrased to the reader, as the criterion questions above are: this is the one item that survives the
  // bound at the widest plan the store accepts, and a memory record outlives the plan that wrote it.
  if (memoryWrites) out.push('whether a memory record this plan wrote still says what you mean');
  return {
    aspect: 'external_confirmation',
    statement: boundedJoin(out),
    operations: cite(views.filter((v) => v.auditState === 'present').map((v) => v.operationId)),
  };
}

// ---- the verdict ------------------------------------------------------------

// The first rule that the records satisfy. Ordered so that a positive record of a failure always
// outranks an inference from absence, and so that nothing the log cannot answer is reported as a
// conclusion about the world.
function decideVerdict({ views, progress, plan, goalAssessment }) {
  const present = one(views, 'present');
  const failed = withStatus(views, StepStatus.FAILED);
  if (failed.length || plan.status === 'failed') {
    return {
      verdict: 'failed',
      basis: `${failed.length} step(s) recorded a failed outcome${plan.status === 'failed' ? ` and the plan is recorded as failed${plan.failureReason ? ` (${singleLine(plan.failureReason, 80)})` : ''}` : ''}`,
    };
  }
  const uncertain = withStatus(views, StepStatus.UNCERTAIN);
  const unreadable = views.filter((v) => ['unreadable', 'unavailable'].includes(v.auditState));
  const absent = one(views, 'absent');
  const notVerified = present.filter((v) => v.recordStatus !== Outcome.SUCCESS_VERIFIED || v.errors > 0);
  const nameless = views.filter((v) => v.status !== NOT_RUN && !v.operationId);
  if (uncertain.length || unreadable.length || absent.length || notVerified.length || nameless.length) {
    const why = [
      uncertain.length ? `${uncertain.map((v) => v.stepId).join(', ')} recorded an uncertain outcome` : null,
      absent.length ? `${absent.map((v) => v.stepId).join(', ')} name(s) an operation that is not in the audit log` : null,
      unreadable.length ? `${unreadable.map((v) => v.stepId).join(', ')} could not be re-opened in the audit log` : null,
      notVerified.length ? `${notVerified.map((v) => `${v.stepId} as ${v.recordStatus}`).join(', ')} did not end as a verified success with no errors` : null,
      nameless.length ? `${nameless.map((v) => v.stepId).join(', ')} recorded an outcome naming no operation` : null,
    ].filter(Boolean);
    return { verdict: 'uncertain', basis: why.join('; ') };
  }
  if (plan.status === 'blocked') {
    return { verdict: 'blocked', basis: `the plan is recorded as blocked${plan.blockedReason ? `: ${singleLine(plan.blockedReason, 90)}` : ''}` };
  }
  if (progress.completed === 0) {
    const stop = [
      plan.status === 'cancelled' ? `cancelled${plan.cancelledReason ? `: ${singleLine(plan.cancelledReason, 80)}` : ''}` : null,
      plan.status === 'superseded' ? `superseded by ${shortId(plan.supersededBy ?? '')}` : null,
      withStatus(views, StepStatus.SKIPPED).length ? `${withStatus(views, StepStatus.SKIPPED).length} step(s) skipped` : null,
    ].filter(Boolean);
    return {
      verdict: 'blocked',
      basis: `no step produced a completed outcome${stop.length ? `; the plan record states why: ${stop.join(', ')}` : ''}`,
    };
  }
  if (progress.completed < progress.total) {
    const skipped = withStatus(views, StepStatus.SKIPPED).map((v) => v.stepId);
    const notRun = withStatus(views, NOT_RUN).map((v) => v.stepId);
    return {
      verdict: 'partial',
      basis: `${progress.completed} of ${progress.total} step(s) completed${skipped.length ? `, ${skipped.join(', ')} skipped` : ''}${notRun.length ? `, ${notRun.join(', ')} with no recorded outcome` : ''}`,
    };
  }
  // Every step completed and verified. The remaining question is whether that settles the goal, and
  // that is answered by the goal's own criteria - never by the step statuses.
  const criteriaShort = goalCriteriaShortfall(goalAssessment, views);
  if (criteriaShort) return { verdict: 'awaiting_confirmation', basis: criteriaShort };
  return {
    verdict: 'successful',
    basis: `every step recorded a completed outcome whose operation is present and verified, and every required criterion of goal ${shortId(plan.goalId)} is satisfied on evidence that still stands`,
  };
}

// The two ways a completed, fully verified plan still does not claim success: no goal to settle (so
// there is nothing APEX can mark met), or criteria that the goal record does not show as satisfied on
// evidence that still stands. A criterion this plan never aimed at is reported as open, not ignored.
function goalCriteriaShortfall(goalAssessment, views) {
  if (!goalAssessment) return 'the plan records no goal, so no criterion is settled by this outcome: whether the intention was met is the user\'s to say';
  const criteria = goalAssessment.criteria ?? [];
  const required = criteria.filter((c) => requirementOf(c) === Requirement.REQUIRED);
  const unmet = required.filter((c) => c.status !== 'satisfied');
  const notStanding = required.filter((c) => c.status === 'satisfied' && ![EvidenceVerdict.CURRENT].includes(c.verdict));
  if (!required.length) {
    return `no required criterion is recorded on goal ${shortId(goalAssessment.goalId)}, so nothing here can be met against it`;
  }
  if (unmet.length) return `${unmet.map((c) => `${c.id} (${c.status})`).join(', ')} of goal ${shortId(goalAssessment.goalId)} is required and not satisfied`;
  if (notStanding.length) return `${notStanding.map((c) => c.id).join(', ')} is recorded satisfied on evidence that is ${notStanding.map((c) => c.verdict).join(', ')}`;
  const targeted = [...new Set(views.map((v) => v.criterionId).filter((id) => id))];
  if (!targeted.length) return `every step completed and verified, but no step names a criterion of goal ${shortId(goalAssessment.goalId)}, so this outcome settles none of them`;
  return null;
}

function summaryOf(assessment) {
  const v = assessment.verdict;
  const parts = [`${v}: ${assessment.progress.completed} of ${assessment.progress.total} step(s) completed`];
  if (assessment.goalId) {
    const counts = assessment.goalAssessment?.counts;
    if (counts) {
      const words = [];
      if (counts.current) words.push(`${counts.current} current`);
      if (counts.none) words.push(`${counts.none} without evidence`);
      if (counts.stale) words.push(`${counts.stale} withdrawn`);
      if (counts.invalid) words.push(`${counts.invalid} unsupported`);
      if (counts.unverifiable) words.push(`${counts.unverifiable} uncheckable`);
      if (counts.contradicted) words.push(`${counts.contradicted} contradicted`);
      if (words.length) parts.push(`goal criteria ${words.join(', ')}`);
    }
  } else {
    parts.push('no goal recorded');
  }
  parts.push(assessment.basis);
  // The caller bounds this at the assessment summary's own limit, which is wider than a finding's, so
  // the whole of the cause survives rather than the last clause being cut mid-sentence.
  return parts.join('; ');
}

// ---- the derivation ---------------------------------------------------------

// Assess what one plan's execution established. `plan` is the plan record as the store holds it, and
// every reader is one the composition root has: a missing reader is reported as something APEX could
// not check, never passed off as a clean result.
export async function assessOutcome(plan, {
  goal = null,
  operations = null,
  knowledge = null,
  memory = null,
} = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new TypeError('assessOutcome needs a plan record');
  }
  if (!plan.activation) {
    return {
      ok: false,
      reason: 'the plan has not been started, so there is no execution outcome to assess',
      planId: plan.id,
      version: plan.version,
      status: plan.status,
      contentHash: planContentHash(plan),
      findings: [],
      dropped: [],
      recordable: false,
    };
  }

  const progress = planProgress(plan);
  const results = plan.stepResults ?? {};
  const ids = [...new Set(plan.steps.map((s) => results[s.id]?.operationId).filter((id) => typeof id === 'string' && id.length > 0))];
  const reads = await readOperations(operations, ids);
  const views = plan.steps.map((s) => {
    const result = results[s.id] ?? null;
    const view = stepView(s, result, result?.operationId ? reads.get(result.operationId) : null, plan);
    const payload = reads.get(view.operationId)?.record?.steps?.[0]?.result?.data;
    view.payloadRecordId = payload && typeof payload.id === 'string' ? payload.id : null;
    return view;
  });

  let goalAssessment = null;
  let goalReadNote = null;
  if (goal) {
    try {
      goalAssessment = await assessGoal(goal, { knowledge, operations });
    } catch (err) {
      goalReadNote = `the goal's own evidence could not be re-read (${err?.code ?? 'store error'})`;
    }
  }

  const memo = new Map();
  const answers = [];
  const push = (answer) => { if (answer) answers.push(answer); };
  push(stepCompletion(views, progress));
  push(expectedOutput(views));
  push(verification(views));
  const criteriaAnswer = goalCriteria(views, goalAssessment);
  push(criteriaAnswer);
  push(evidenceState(views, progress, goalReadNote));
  const durable = await durability(views, { knowledge, memory }, memo);
  push(durable);
  push(externalConfirmation(views, goalAssessment, plan, durable.hadMemoryWrite));

  const { verdict, basis } = decideVerdict({ views, progress, plan, goalAssessment });
  const required = VERDICT_REQUIRED_ASPECT[verdict];
  const findings = [];
  const dropped = [];
  for (const a of answers.slice(0, MAX_FINDINGS)) {
    const ops = a.operations ?? [];
    if (ops.length === 0) {
      dropped.push({ aspect: a.aspect, reason: 'its answer rests on no operation that this read found in the audit log' });
      continue;
    }
    findings.push({
      aspect: a.aspect,
      statement: a.statement,
      operations: ops,
      ...(a.records?.length ? { records: a.records } : {}),
    });
  }
  const answered = new Set(findings.map((f) => f.aspect));
  const holdsVerdict = !required || answered.has(required);

  const assessment = {
    ok: true,
    planId: plan.id,
    version: plan.version,
    status: plan.status,
    contentHash: planContentHash(plan),
    taskId: plan.activation.taskId,
    goalId: plan.goalId ?? null,
    goalRevision: plan.goalRevision ?? null,
    goalStatus: goal?.status ?? null,
    progress,
    verdict,
    basis,
    summary: '',
    findings,
    dropped,
    // Whether this can become a recorded assessment: the store requires at least one finding that
    // cites an operation, and the model requires the verdict's own question to be answered.
    recordable: findings.length > 0 && holdsVerdict,
    unrecordableReason: findings.length === 0
      ? 'no finding rests on an operation this read found in the audit log, so the plan store would refuse it as an assessment with no evidence behind it'
      : (holdsVerdict ? null : `a ${verdict} assessment must answer ${required}, and that answer cites nothing that was found`),
    goalAssessment,
    aspects: ASSESSMENT_ASPECTS.map((aspect) => {
      const finding = findings.find((f) => f.aspect === aspect);
      return { aspect, question: ASPECT_QUESTIONS[aspect], answered: Boolean(finding), statement: finding?.statement ?? null };
    }),
    auditReads: [...reads].map(([id, r]) => ({ operationId: id, state: r.state, detail: r.detail ?? null })),
    note: ASSESSMENT_NOTE,
  };
  assessment.summary = singleLine(summaryOf(assessment), MAX_ASSESSMENT_SUMMARY_CHARS);
  return assessment;
}

// ---- rendering --------------------------------------------------------------

const AUDIT_WORDS = Object.freeze({
  present: 'in the audit log',
  absent: 'not in the audit log',
  unreadable: 'the audit log could not be read',
  unavailable: 'no audit log is configured',
  no_operation: 'records no operation',
  [NOT_RUN]: 'has no recorded outcome',
});

export function renderAssessment(assessment, { indent = '' } = {}) {
  if (!assessment) return `${indent}No outcome assessment was derived.`;
  if (assessment.ok === false) {
    return `${indent}This plan's outcome cannot be assessed: ${assessment.reason}`;
  }
  const lines = [
    `${indent}Outcome assessment for plan ${shortId(assessment.planId)} v${assessment.version} (${assessment.status}), task ${shortId(assessment.taskId)}:`,
    `${indent}  verdict: ${assessment.verdict} - ${assessment.basis}`,
    `${indent}  rule: ${VERDICT_RULE}`,
    `${indent}  goal: ${assessment.goalId ? `${shortId(assessment.goalId)} at revision ${assessment.goalRevision ?? '-'}` : 'none recorded on this plan'}`,
    `${indent}  steps: ${assessment.progress.completed} completed, ${assessment.progress.failed} failed, ${assessment.progress.uncertain} uncertain, ${assessment.progress.skipped} skipped, ${assessment.progress.pending} with no recorded outcome`,
  ];
  for (const a of assessment.aspects) {
    if (a.answered) continue;
    const dropped = assessment.dropped.find((d) => d.aspect === a.aspect);
    lines.push(`${indent}  ${a.aspect} (${a.question}): not recorded - ${dropped?.reason ?? 'not reached'}`);
  }
  for (const f of assessment.findings) {
    lines.push(`${indent}  ${f.aspect}: ${f.statement}`);
    lines.push(`${indent}    cites operation(s) ${f.operations.map((o) => shortId(o)).join(', ')}${f.records?.length ? `; record(s) ${f.records.map((r) => shortId(r)).join(', ')}` : ''}`);
  }
  const loose = assessment.auditReads.filter((r) => r.state !== 'present');
  if (loose.length) {
    lines.push(`${indent}  audit reads: ${loose.map((r) => `${shortId(r.operationId)} ${AUDIT_WORDS[r.state] ?? r.state}${r.detail ? ` (${singleLine(r.detail, 60)})` : ''}`).join('; ')}`);
  }
  lines.push(`${indent}  ${assessment.recordable
    ? 'Recordable as an assessment. Recording it is `plan.assess`, a user act; it changes no status, approval, or timestamp.'
    : `Not recordable: ${assessment.unrecordableReason}`}`);
  lines.push(`${indent}  ${assessment.note}`);
  return lines.join('\n');
}
