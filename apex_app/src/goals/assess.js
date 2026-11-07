// Goal assessment: what the goal record claims, checked against what the other stores still hold.
//
// `goal show` replays the goal log and renders it. This answers the next question of the planning
// loop - does what the goal says about itself still match the records APEX holds now? An operation
// in the audit log can never change its own past, but a knowledge claim it established can be
// retracted or superseded afterwards, and a criterion whose proof has been withdrawn is not the
// same as a criterion whose proof still stands.
//
// It reads only. It appends no event, links nothing, and decides nothing on the user's behalf. What
// the goal is missing comes back as a question: a criterion APEX invented would be an inference,
// and an inference counts only after the user decides it (see the provenance rules in model.js).
import { Outcome } from '../outcomes.js';
import { shortId, singleLine } from '../util.js';
import {
  GOAL_ITEM_FIELDS,
  GoalBasis,
  GoalStatus,
  Requirement,
  basisOf,
  goalProgress,
  isOpenStatus,
  needsUserDecision,
  requirementOf,
} from './model.js';

// What the read found behind one criterion. Each value says who is lacking: `invalid` is a claim
// the audit log does not support, `stale` is a claim it supported and the world withdrew, and
// `unverifiable` is APEX not being able to tell - three different things to tell the user.
export const EvidenceVerdict = Object.freeze({
  CURRENT: 'current',
  STALE: 'stale',
  INVALID: 'invalid',
  UNVERIFIABLE: 'unverifiable',
  NONE: 'none',
  CONTRADICTED: 'contradicted',
});

// Questions are what only the user can settle, in a fixed order, and the list is finite: an
// assessment that never stops asking is as unusable as one that answers for them.
export const MAX_QUESTIONS = 8;

const VERDICT_ORDER = Object.values(EvidenceVerdict);
const SHOWN_TRIPLE_CHARS = 120;

function tripleText(record) {
  return singleLine(`${record.subject} --[${record.relationship}]--> ${record.object}`, SHOWN_TRIPLE_CHARS);
}

// How a retired claim was retired, in the store's own words: a retraction names its reason, a
// supersession names what replaced it. Nothing here invents a cause the log does not hold.
function retirementNote(record) {
  if (record.retraction?.reason) return singleLine(record.retraction.reason, 120);
  const by = (record.supersededBy ?? []).map((id) => shortId(id)).join(', ');
  if (by) return `replaced by ${by}`;
  return null;
}

function unverifiable(reason) {
  return { verdict: EvidenceVerdict.UNVERIFIABLE, reason, records: [] };
}

// One read per record per assessment. A goal can cite the same claim from a criterion and from a
// decomposition item, and each store read re-parses the whole log, so repeating an identical read
// would only slow the answer down and could report two different states for one record inside one
// report. The memo lives for the duration of a single assessment, never across reads.
function memoized(read) {
  const cache = new Map();
  return (key) => {
    let pending = cache.get(key);
    if (!pending) {
      pending = read(key);
      cache.set(key, pending);
    }
    return pending;
  };
}

// One supporting evidence entry, re-opened in the audit log and followed through to whatever that
// operation established in the knowledge store.
async function assessSupport(entry, { operations, knowledge }) {
  const base = {
    kind: 'supports',
    operationId: entry.operationId ?? null,
    at: entry.at ?? null,
    detail: entry.detail ?? null,
  };
  const id = entry.operationId;
  if (!id) return { ...base, verdict: EvidenceVerdict.INVALID, reason: 'the support names no audit operation', records: [] };
  if (!operations) return { ...base, ...unverifiable(`no audit log is available, so operation ${shortId(id)} cannot be re-opened`) };
  let found;
  try {
    found = await operations.findById(id);
  } catch (err) {
    return { ...base, ...unverifiable(`the audit log could not be read (${err?.code ?? 'store error'})`) };
  }
  if (!found.found) {
    return { ...base, verdict: EvidenceVerdict.INVALID, reason: `operation ${shortId(id)} is not in the audit log`, records: [] };
  }
  const record = found.record;
  if (record.status !== Outcome.SUCCESS_VERIFIED) {
    return { ...base, verdict: EvidenceVerdict.INVALID, reason: `operation ${shortId(id)} ended as ${record.status}`, records: [] };
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return { ...base, verdict: EvidenceVerdict.INVALID, reason: `operation ${shortId(id)} carries ${record.errors.length} error(s)`, records: [] };
  }
  if (!knowledge) {
    return { ...base, ...unverifiable(`operation ${shortId(id)} verified, but no knowledge store is available, so what it established cannot be re-checked`) };
  }
  let written;
  try {
    written = await knowledge.byOperation(record.id);
  } catch (err) {
    return { ...base, ...unverifiable(`the knowledge store could not be read (${err?.code ?? 'store error'}), so what operation ${shortId(id)} established cannot be re-checked`) };
  }
  const records = written.records.map((r) => ({
    id: r.id,
    shortId: shortId(r.id),
    triple: tripleText(r),
    active: r.active === true,
    state: r.lifecycleState ?? r.status,
    note: r.active === true ? null : retirementNote(r),
  }));
  const retired = records.filter((r) => !r.active);
  const bound = written.truncated
    ? `; it established ${written.matched} record(s) and only the first ${records.length} could be shown, so an unlisted one may have been retired too`
    : '';
  // A verified operation that wrote nothing to the knowledge store is a different thing from one
  // whose every record still stands: the first has no knowledge evidence to withdraw at all.
  const established = written.matched === 0
    ? 'it established no knowledge record, so nothing has been withdrawn from it'
    : `every one of the ${written.matched} record(s) it established is still current`;
  const reason = retired.length > 0
    ? `operation ${shortId(id)} verified, but ${retired.map((r) => `${r.shortId} is ${r.state}`).join(', ')}${bound}`
    : `operation ${shortId(id)} ended as a verified success and ${established}${bound}`;
  return {
    ...base,
    verdict: retired.length > 0 ? EvidenceVerdict.STALE : EvidenceVerdict.CURRENT,
    reason,
    records,
    truncated: written.truncated === true,
    matched: written.matched,
  };
}

// One record the goal itself names - a criterion's reference, or a decomposition item stated as a
// verified fact. The goal says which record it relies on; this asks that store whether it still
// stands, and says so plainly when the reference names nothing the knowledge store holds.
async function assessRef(ref, from, { knowledge }, uncheckable) {
  const entry = { ref, from, found: false, active: null, state: null, detail: null };
  if (!knowledge) {
    uncheckable.push(`${from} cites ${ref}, but no knowledge store is available to check it against`);
    return { ...entry, state: 'unchecked' };
  }
  let view;
  try {
    view = await knowledge.history(ref);
  } catch (err) {
    uncheckable.push(`${from} cites ${ref}, and the knowledge store could not be read (${err?.code ?? 'store error'})`);
    return { ...entry, state: 'unreadable' };
  }
  if (!view?.record) {
    return { ...entry, state: 'no such knowledge record', detail: `the knowledge store holds no claim with the id ${ref}; the goal does not name which other store it belongs to` };
  }
  const record = view.record;
  return {
    ...entry,
    found: true,
    active: record.active === true,
    state: record.lifecycleState ?? record.status,
    detail: record.active === true ? null : retirementNote(record),
  };
}

// The questions only the user can settle, in a fixed order, each naming the criterion or field it
// came from. An assessment that wrote its own answers would be fabricating part of the goal.
function questionsFor(goal, criteria, records) {
  const open = isOpenStatus(goal.status);
  const out = [];
  for (const c of criteria) {
    if (needsUserDecision(c)) {
      out.push(`${c.id} is ${basisOf(c)} rather than something you asked for, and nothing has decided it: does it belong in this goal? goal confirm ${shortId(goal.id)} ${c.id} required|suggested|declined --reason <text>`);
    }
  }
  for (const c of criteria) {
    if (c.verdict === EvidenceVerdict.CONTRADICTED) {
      out.push(`${c.id} has contradicting evidence on record${c.contradictedDetail ? ` ("${singleLine(c.contradictedDetail, 100)}")` : ''}. Do you want to revise the goal, block it, or record what resolves the contradiction?`);
    }
    if (c.verdict === EvidenceVerdict.STALE) {
      out.push(`the proof recorded for ${c.id} has since been withdrawn from the knowledge record. What stands in its place, if anything?`);
    }
  }
  if (open) {
    for (const c of criteria) {
      if (c.requirement === Requirement.REQUIRED && c.status === 'pending' && !c.requiredEvidence) {
        out.push(`${c.id} is required and says nothing about what would prove it. What would you accept as proof? (goal revise ${shortId(goal.id)} --criterion ... states it)`);
      }
    }
    for (const item of goal.unknowns ?? []) {
      out.push(`the goal records an unknown: "${singleLine(item.text, 100)}". Can you settle it, or should it stay open?`);
    }
    for (const item of goal.blockers ?? []) {
      out.push(`the goal records a blocker: "${singleLine(item.text, 100)}". Is it still in the way?`);
    }
    for (const field of GOAL_ITEM_FIELDS) {
      for (const item of goal[field] ?? []) {
        if (basisOf(item) === GoalBasis.ASSUMPTION && field !== 'unknowns') {
          out.push(`the goal assumes "${singleLine(item.text, 100)}" (${field}). Is the assumption still worth carrying?`);
        }
      }
    }
    for (const record of records) {
      if (record.active === false && record.found) {
        out.push(`${record.from} relies on ${record.ref}, which the knowledge store reports as ${record.state}. Does the goal still mean what it says?`);
      }
      if (record.found === false && record.state !== 'unchecked' && record.state !== 'unreadable') {
        out.push(`${record.from} cites ${record.ref}, which is not a knowledge record APEX can read back. Where does that fact come from?`);
      }
    }
  }
  return out;
}

// Assess one goal. `readers` are the stores the composition root has; a missing reader is reported
// as something APEX could not check, never passed off as a clean result.
export async function assessGoal(goal, { knowledge = null, operations = null, plans = null } = {}) {
  if (!goal || typeof goal !== 'object') throw new TypeError('assessGoal needs a goal record');
  const uncheckable = [];
  if (!operations) uncheckable.push('no audit log is available, so no recorded operation can be re-opened');
  if (!knowledge) uncheckable.push('no knowledge store is available, so a retraction or supersession behind any evidence cannot be seen');
  const readers = {
    operations: operations ? { findById: memoized((id) => operations.findById(id)) } : null,
    knowledge: knowledge ? {
      history: memoized((ref) => knowledge.history(ref)),
      byOperation: memoized((id) => knowledge.byOperation(id)),
    } : null,
    plans,
  };

  const criteria = [];
  for (const criterion of goal.criteria ?? []) {
    const evidence = [];
    for (const entry of criterion.evidence ?? []) {
      if (entry.kind === 'supports') {
        evidence.push(await assessSupport(entry, readers));
      } else {
        evidence.push({
          kind: 'contradicts',
          operationId: entry.operationId ?? null,
          at: entry.at ?? null,
          detail: entry.detail ?? null,
          verdict: null,
          reason: null,
          records: [],
        });
      }
    }
    const lastSupport = [...evidence].reverse().find((e) => e.kind === 'supports');
    let verdict = EvidenceVerdict.NONE;
    let reason = 'no supporting evidence is recorded';
    if (criterion.status === 'contradicted') {
      verdict = EvidenceVerdict.CONTRADICTED;
      reason = 'contradicting evidence is the later record against this criterion';
    } else if (criterion.status === 'satisfied') {
      if (!lastSupport) {
        verdict = EvidenceVerdict.INVALID;
        reason = 'the criterion is recorded as satisfied with no supporting entry';
      } else {
        verdict = lastSupport.verdict;
        reason = lastSupport.reason;
      }
    } else if (lastSupport) {
      reason = `the criterion is ${criterion.status}; the latest support ${lastSupport.reason}`;
    }
    criteria.push({
      id: criterion.id,
      description: criterion.description,
      basis: basisOf(criterion),
      requirement: requirementOf(criterion),
      status: criterion.status,
      needsUserDecision: needsUserDecision(criterion),
      requiredEvidence: criterion.requiredEvidence ?? null,
      contradictedDetail: [...(criterion.evidence ?? [])].reverse().find((e) => e.kind === 'contradicts')?.detail ?? null,
      verdict,
      reason,
      evidence,
    });
  }

  const records = [];
  for (const criterion of criteria) {
    const source = goal.criteria.find((c) => c.id === criterion.id);
    if (source?.ref) records.push(await assessRef(source.ref, `criterion ${criterion.id}`, readers, uncheckable));
  }
  for (const field of GOAL_ITEM_FIELDS) {
    for (const item of goal[field] ?? []) {
      if (item.ref) records.push(await assessRef(item.ref, `${field} "${singleLine(item.text, 60)}"`, readers, uncheckable));
    }
  }

  const planViews = [];
  for (const planId of goal.planIds ?? []) {
    if (!plans) {
      planViews.push({ id: planId, found: false, status: null, detail: 'no plan store is available' });
      continue;
    }
    try {
      const plan = await plans.resolve(planId);
      planViews.push({ id: planId, found: Boolean(plan), status: plan?.status ?? null, detail: null });
    } catch (err) {
      planViews.push({ id: planId, found: false, status: null, detail: err?.message ? singleLine(err.message, 80) : 'the plan could not be read' });
    }
  }

  const allQuestions = questionsFor(goal, criteria, records);
  const questions = allQuestions.slice(0, MAX_QUESTIONS);
  const counts = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0]));
  for (const c of criteria) counts[c.verdict] += 1;
  const damaged = criteria.filter((c) => [EvidenceVerdict.STALE, EvidenceVerdict.INVALID, EvidenceVerdict.CONTRADICTED, EvidenceVerdict.UNVERIFIABLE].includes(c.verdict));

  return {
    goalId: goal.id,
    status: goal.status,
    open: isOpenStatus(goal.status),
    progress: goalProgress(goal),
    criteria,
    records,
    plans: planViews,
    questions,
    questionsTruncated: allQuestions.length > questions.length,
    questionsHeldBack: allQuestions.length - questions.length,
    uncheckable,
    counts,
    // `ok` is not "the goal is met". It means nothing the goal claims about its own evidence is
    // contradicted, withdrawn, unsupported by the audit log, or impossible to check.
    ok: damaged.length === 0 && uncheckable.length === 0,
  };
}

// A goal the record marks completed was closed because every required criterion was satisfied against
// a verified operation. Neither of those records is frozen: the knowledge claim an operation wrote can
// be retracted or superseded afterwards, and an operation the audit log no longer supports was never a
// proof. This answers the question a reader has to answer before it calls a closed goal settled - does
// the evidence that completion was granted on still hold? - and it is a read: it reopens nothing,
// appends nothing, and never decides on the user's behalf that the goal should stop being completed.
//
// `holds: null` is not a soft version of `holds: true`. It means the check could not be made - no
// assessment was handed, no snapshot was recorded, or a store could not be read - and a reader that
// cannot tell says so rather than reporting a settled goal.
export function completionConsistency(goal, assessment = null) {
  const completed = goal?.status === GoalStatus.COMPLETED;
  const snapshot = goal?.completion?.criteria ?? [];
  const out = {
    completed,
    checked: false,
    holds: null,
    withdrawn: [],
    unsupported: [],
    uncheckable: [],
    detail: null,
    command: null,
  };
  if (!completed) {
    out.detail = 'the goal is not recorded as completed, so there is no completion evidence to hold or lose';
    return out;
  }
  if (snapshot.length === 0) {
    out.detail = 'the goal is recorded as completed with no completion-evidence snapshot, so no reader can say what it was closed against';
    return out;
  }
  if (!assessment) {
    out.detail = 'the records behind this completion were not read, so nothing here says the evidence still holds';
    return out;
  }
  out.checked = true;
  out.uncheckable = [...(assessment.uncheckable ?? [])];
  const byId = new Map((assessment.criteria ?? []).map((c) => [c.id, c]));
  for (const item of snapshot) {
    const criterion = byId.get(item.criterionId);
    if (!criterion) {
      out.unsupported.push({ criterionId: item.criterionId, verdict: null, reason: 'the completion names a criterion the goal no longer holds' });
      continue;
    }
    if (criterion.verdict === EvidenceVerdict.CURRENT) continue;
    if (criterion.verdict === EvidenceVerdict.STALE || criterion.verdict === EvidenceVerdict.CONTRADICTED) {
      out.withdrawn.push({
        criterionId: criterion.id,
        requirement: criterion.requirement,
        verdict: criterion.verdict,
        operationId: item.operationId ?? null,
        reason: criterion.reason,
      });
    } else {
      out.unsupported.push({
        criterionId: criterion.id,
        requirement: criterion.requirement,
        verdict: criterion.verdict,
        operationId: item.operationId ?? null,
        reason: criterion.reason,
      });
    }
  }
  const required = out.withdrawn.filter((w) => w.requirement === Requirement.REQUIRED);
  const gating = required.length + out.unsupported.filter((u) => u.requirement === Requirement.REQUIRED).length;
  out.holds = gating === 0 && out.uncheckable.length === 0;
  const id = shortId(goal.id);
  out.command = out.holds ? null
    : `node bin/apex.js goal evidence ${id} --criterion ${required[0]?.criterionId ?? out.unsupported[0]?.criterionId ?? 'c1'} --kind contradicts --reopen`;
  const parts = [];
  if (required.length > 0) {
    parts.push(`${required.map((w) => `${w.criterionId} (${w.verdict}${w.operationId ? `, operation ${shortId(w.operationId)}` : ''})`).join(', ')}: the proof the goal was closed on no longer stands`);
  }
  if (out.unsupported.length > 0) {
    parts.push(`${out.unsupported.map((u) => `${u.criterionId} (${u.verdict ?? 'unmatched'})`).join(', ')}: the completion names work the records do not support`);
  }
  if (out.uncheckable.length > 0) parts.push(`and this could not be checked: ${out.uncheckable.join('; ')}`);
  out.detail = out.holds
    ? `all ${snapshot.length} recorded completion criterion(s) still hold against the records they cite`
    : `the goal is recorded as completed, ${parts.join('; ')}`;
  return out;
}

// A one-line statement of what the assessment adds to the goal record, for a caller that needs the
// finding without the text. It states counts, names no content, and never rounds to a percentage.
export function assessmentSummary(assessment) {
  const c = assessment.counts;
  const parts = [];
  if (c.current) parts.push(`${c.current} current`);
  if (c.stale) parts.push(`${c.stale} withdrawn since recorded`);
  if (c.invalid) parts.push(`${c.invalid} not supported by the audit log`);
  if (c.unverifiable) parts.push(`${c.unverifiable} not checkable`);
  if (c.contradicted) parts.push(`${c.contradicted} contradicted`);
  if (c.none) parts.push(`${c.none} awaiting evidence`);
  const owed = assessment.criteria.filter((x) => x.needsUserDecision).length;
  return `${assessment.criteria.length} criterion(s): ${parts.join(', ') || 'nothing assessed'}${owed ? `; ${owed} awaiting your decision` : ''}`;
}
