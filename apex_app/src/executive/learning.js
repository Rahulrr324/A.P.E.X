// What the records about past attempts say, read for the capabilities a plan actually touches.
//
// Batch AL asks APEX to improve the next attempt from what it learned, and the learning already exists
// in this application as three kinds of record: an adaptation the user approved, an expectation the
// user recorded, and an outcome assessment recorded against a plan. What does not exist is a way to
// read them that keeps their status straight. A candidate adaptation is not an approved one; an
// expectation is not an observation; a prediction whose horizon passed is not a wrong prediction; a
// match rate over three evaluations is not a probability. Read carelessly, those four distinctions are
// exactly what an answer would lose, and the loss would make the plan look better supported than the
// records support.
//
// So this module reads and discloses, and nothing else. It is deliberately not an input to the
// comparison: no gate, no ranked dimension, no score, and no candidate digest is computed from anything
// here, because a heuristic informed by an expectation would present that expectation as a fact about
// the world. The disclosure is where the learning enters, and the user is where it is weighed.
//
// Two rules bound every read:
//  - only a record the user placed is shown. For adaptations that means `active`, which the experience
//    store derives from an approved decision whose supporting evidence still stands; a candidate, a
//    rejected, a retired or an ambiguous adaptation is never surfaced as guidance, and its absence is
//    reported as "none approved" rather than as "none recorded";
//  - only the store's own derived wording is repeated for a prediction. Its status, its status reason,
//    its horizon and its cited-evidence basis come from the projection, and the expectation's own
//    subject text is not carried here, because a plan answer can reach a model context and an
//    expectation must not arrive there as prose that reads like an observation.
import { createHash } from 'node:crypto';
import { shortId, singleLine } from '../util.js';
import { ClaimKind } from './vocabulary.js';

export const LEARNING_SCHEMA = 1;

// What this read is, stated once so an answer cannot describe itself more strongly than its rule.
export const LEARNING_RULE = 'what bears on these capabilities is read from three records: an adaptation the user approved, '
  + 'an expectation the user recorded, and an outcome assessment recorded against a plan for this goal. '
  + 'An adaptation that is only a candidate, or was rejected, retired, or whose support no longer stands, is not in this read.';

// The five separations Batch AL requires between a learning record and a claim about the world. They
// are printed with the block, not assumed: a reader who has never seen the prediction store's own
// limitations has nothing else to tell them that `[prediction]` is not a weaker `[fact]`.
export const LEARNING_SEPARATIONS = Object.freeze([
  'an approved adaptation is the user\'s own recorded guidance for how the work should be done. It is not a fact about the world, and it grants no permission.',
  'a prediction is the user\'s recorded expectation. It is not an observation, an experience, a verified outcome, or evidence that anything happened.',
  'a prediction whose horizon passed with no outcome evidence is expired. Expiry is never counted as wrong, and never as a match.',
  'a match rate is a count of recorded evaluations over a stated denominator. It is not a probability, and it adjusts no score, gate, or ranking in this answer.',
  'an outcome assessment is a reading of records. Whether the intention holds outside APEX\'s records is a different question, and this read does not settle it.',
]);

// How much of each record is shown. The reads themselves are bounded by their own stores; these bounds
// are about what an answer prints, so a store with hundreds of records still yields a readable answer.
export const LEARNING_BOUNDS = Object.freeze({
  capabilities: 8,
  adaptations: 3,
  predictions: 4,
  assessments: 3,
  activeRead: 10,
  ruleChars: 96,
  // How many statements the executive answer prints. The block is disclosure, and the answer that prints
  // it is bounded line by line: a record list long enough to push the selection off the end of the
  // answer would make the answer worse, not more informative. The command's own print shows all of them.
  answerStatements: 4,
  // How many supporting record ids travel beside an adaptation row. The store caps one adaptation at 20
  // per evidence list, so this is that cap restated: a row that carried more would be a row the store
  // could not have produced.
  evidenceIds: 20,
});

// Printed beside every block this module produces. Batch AL wrote it as a flat absence, because nothing
// in the read moved anything. Batch AM adds the second sentence, and only where it is true: an approved
// adaptation whose user recorded a shape is compared, so the flat absence would be a false statement
// about the answer it is printed under. Which of the two a reader sees is decided by the read itself,
// from the records that were actually in scope - not by a guess about what guidance might exist.
export const LEARNING_NOT_APPLIED = 'This read changed nothing above it: no gate, no ranked dimension, no score, and no candidate digest is computed from these records.';
export const LEARNING_GUIDED = 'This read authorized nothing and gated nothing: no gate, no candidate digest, and no score is computed from these records. '
  + 'What it did feed is one ranked dimension, approved_adaptation_fit: the records named above carry a shape the user recorded, and each candidate\'s own steps were checked against it. '
  + 'Nothing else above this line changed, and an expectation, an outcome assessment, or an approved rule with no shape moved nothing at all.';

// The capabilities a set of recorded steps actually names, in the order the steps name them,
// deduplicated and bounded. A candidate is not asked what it hopes to learn; it is asked what it would
// do, and the actions are the only part of it a learning record can bear on.
function collectCapabilities(lists) {
  const seen = [];
  for (const steps of lists) {
    for (const step of steps ?? []) {
      const name = typeof step?.action === 'string' ? step.action : null;
      if (name && !seen.includes(name)) seen.push(name);
    }
  }
  return seen;
}

export function learningScope(candidates = [], prior = null) {
  const seen = collectCapabilities([
    ...(candidates ?? []).map((c) => c?.content?.steps ?? []),
    prior?.steps ?? [],
  ]);
  const shown = seen.slice(0, LEARNING_BOUNDS.capabilities);
  return { capabilities: shown, truncated: seen.length > shown.length, considered: seen.length };
}

// A store's derived wording, kept as prose on one line and kept absent when the store was absent.
// Collapsing a missing reason into `''` would let an answer print an empty justification.
function wording(value, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return singleLine(value, max);
}

function readFailure(err) {
  return wording(err?.message ?? String(err), 200) ?? 'unreadable';
}

// Approved adaptations in the capabilities this work touches. `total` is what the store reports for the
// scope it read, so an answer can say "none is approved for these capabilities" without claiming that
// none is recorded - the distinction is the store's to make and this read only repeats it.
const NO_ADAPTATIONS = Object.freeze({ rows: [], shown: 0, total: 0, scopeTotal: 0, truncated: false });

// One adaptation row, in the shape both the disclosure and the guidance ledger read. It is exported
// because the ledger has to see the states the disclosure deliberately hides: an unapproved, rejected,
// or retired rule is not guidance, and a report that proves it changed nothing has to be able to say
// which record it looked at and what state it was in.
export function adaptationRow(a) {
  return {
    id: a.id,
    capability: a.capability,
    rule: wording(a.rule, LEARNING_BOUNDS.ruleChars) ?? 'no rule text is recorded',
    ruleHash: a.ruleHash ?? null,
    method: a.method ?? null,
    minSupport: a.minSupport ?? null,
    supportCount: (a.support?.experienceIds ?? []).length,
    // The exact records the rule rests on, bounded like the store's own support lists. The comparison's
    // decision record names these, because "a rule the user approved" is not traceable without them.
    support: {
      experienceIds: [...(a.support?.experienceIds ?? [])].slice(0, LEARNING_BOUNDS.evidenceIds),
      feedbackIds: [...(a.support?.feedbackIds ?? [])].slice(0, LEARNING_BOUNDS.evidenceIds),
    },
    decidedAt: a.decision?.createdAt ?? null,
    decisionReason: wording(a.decision?.reason, 200),
    decisionState: a.decisionState ?? null,
    active: a.active === true,
    guidance: a.guidance ?? null,
    guidanceCount: a.guidanceCount ?? 0,
    // The rule-level disagreement the store derives between two active records in one scope. The count
    // is the store's own field and stays a count; the comparison needs the partners to withhold an
    // ordering rather than pick a winner, so they travel beside it instead of being re-derived from a
    // second read.
    conflicts: (a.conflicts ?? []).length,
    conflictsWith: (a.conflicts ?? []).map((c) => ({ id: c.id, capability: c.capability })),
    supportState: a.supportState ?? null,
    inactiveReason: a.inactiveReason ?? null,
    updateMode: a.provenance?.updateMode ?? null,
    origin: a.provenance?.origin ?? null,
  };
}

async function readAdaptations(experience, scope) {
  if (!experience || typeof experience.activeAdaptations !== 'function') {
    return { ...NO_ADAPTATIONS, unavailable: 'no experience store is configured in this build' };
  }
  try {
    const read = await experience.activeAdaptations({ limit: LEARNING_BOUNDS.activeRead });
    const inScope = (read.adaptations ?? []).filter((a) => scope.capabilities.includes(a.capability));
    return {
      rows: inScope.slice(0, LEARNING_BOUNDS.adaptations).map(adaptationRow),
      shown: inScope.length,
      total: read.total ?? 0,
      scopeTotal: inScope.length,
      truncated: Boolean(read.truncated) || inScope.length > LEARNING_BOUNDS.adaptations,
      unavailable: null,
    };
  } catch (err) {
    return { ...NO_ADAPTATIONS, unavailable: `the experience log could not be read: ${readFailure(err)}` };
  }
}

// The prediction ledger, opened once. `calibration` returns the projections and the counts from the same
// projection, so one read answers both and the two cannot disagree about what instant of the log they
// describe. Rows are limited to the capabilities in scope; the aggregate counts are not, because a
// denominator carved to the capabilities being discussed would flatter the record.
async function readPredictions(predictions, scope) {
  const empty = {
    rows: [], shown: 0, totals: null, matchRate: null, rateDenominator: null, reliability: null, byCapability: [],
    rateExclusions: [], limitations: [], expired: 0, unevaluated: 0, storedTotal: 0,
    truncated: false, capabilitiesTruncated: false,
  };
  if (!predictions || typeof predictions.calibration !== 'function') {
    return { ...empty, unavailable: 'no prediction store is configured in this build' };
  }
  try {
    const { calibration, ledger } = await predictions.calibration({});
    const projections = ledger?.projections ?? [];
    const inScope = projections.filter((p) => scope.capabilities.includes(p.capability) && p.retired !== true);
    // Standing expectations first: they are the ones that could still be settled by this work. An
    // evaluated or expired record is history, and showing it ahead of an open one would describe the
    // user's expectations as though the unresolved ones had already been resolved.
    const order = { recorded: 0, awaiting_evaluation: 1, expired: 2, evaluated: 3, invalidated: 4, superseded: 5 };
    const sorted = [...inScope].sort((a, b) => {
      const rank = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (rank !== 0) return rank;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? -1 : 1);
    });
    return {
      rows: sorted.slice(0, LEARNING_BOUNDS.predictions).map((p) => ({
        id: p.id,
        capability: p.capability,
        expectation: p.expectation,
        status: p.status,
        statusReason: wording(p.statusReason, 220),
        expiresAt: p.expiresAt ?? null,
        createdAt: p.createdAt ?? null,
        evidenceBasis: p.evidenceBasis ?? null,
        confidence: p.confidence ?? null,
        verdict: p.evaluation?.verdict ?? null,
        // Only the two states whose meaning a reader most often invert. A matched row needs no reason
        // restated; an expired or unevaluable row is exactly where "expired" gets read as "wrong".
        evaluationReason: p.evaluationDecision === 'outcome_unavailable' || p.status === 'expired'
          ? wording(p.evaluationReason, 220)
          : null,
        canRecordEvaluation: p.canRecordEvaluation === true,
      })),
      shown: sorted.length,
      totals: calibration?.totals ?? null,
      matchRate: calibration?.matchRate ?? null,
      rateDenominator: wording(calibration?.rateDenominator, 200),
      reliability: calibration?.reliability ?? null,
      rateExclusions: calibration?.rateExclusions ?? [],
      limitations: calibration?.limitations ?? [],
      byCapability: (calibration?.byCapability ?? []).filter((c) => scope.capabilities.includes(c.capability)),
      capabilitiesTruncated: calibration?.capabilitiesTruncated === true,
      expired: projections.filter((p) => p.status === 'expired').length,
      unevaluated: calibration?.totals?.unevaluated ?? 0,
      storedTotal: calibration?.totals?.stored ?? 0,
      truncated: sorted.length > LEARNING_BOUNDS.predictions,
      unavailable: null,
    };
  } catch (err) {
    return { ...empty, unavailable: `the prediction log could not be read: ${readFailure(err)}` };
  }
}

// What an earlier attempt at this goal concluded. Assessments stay attached to the plan version they
// were derived from, so a stale one is a statement about an older plan and is reported as one.
const NO_ASSESSMENTS = Object.freeze({ rows: [], total: 0, plansRead: 0, truncated: false });

async function readAssessments(plans, scope, goalId, excludePlanId) {
  if (!plans || typeof plans.list !== 'function') {
    return { ...NO_ASSESSMENTS, unavailable: 'no plan store is configured in this build' };
  }
  if (!goalId) {
    return { ...NO_ASSESSMENTS, unavailable: 'this read has no goal to trace earlier attempts to' };
  }
  try {
    const all = await plans.list();
    const forGoal = (all.plans ?? all).filter((p) => p.goalId === goalId && p.id !== excludePlanId);
    const rows = [];
    for (const plan of forGoal) {
      const last = (plan.assessments ?? []).at(-1);
      if (!last) continue;
      const touches = (plan.steps ?? []).some((s) => scope.capabilities.includes(s.action));
      if (!touches) continue;
      rows.push({
        planId: plan.id,
        planVersion: last.planVersion ?? null,
        planStatus: plan.status,
        verdict: last.verdict,
        at: last.at ?? null,
        stale: last.planVersion !== plan.version,
        summary: wording(last.summary, LEARNING_BOUNDS.ruleChars),
        findings: (last.findings ?? []).length,
        operations: [...new Set((last.findings ?? []).flatMap((f) => f?.operations ?? []))].slice(0, 4),
      });
    }
    rows.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    return {
      rows: rows.slice(-LEARNING_BOUNDS.assessments),
      total: rows.length,
      plansRead: forGoal.length,
      truncated: rows.length > LEARNING_BOUNDS.assessments,
      unavailable: null,
    };
  } catch (err) {
    return { ...NO_ASSESSMENTS, unavailable: `the plan records could not be read: ${readFailure(err)}` };
  }
}

// The whole learning read. Every store is optional: a configuration without a prediction log gets a
// disclosure that says the log is not configured, which is a different statement from "no expectation
// is recorded" and is kept distinct in the returned `unavailable` list rather than collapsed into an
// empty row set.
export async function readLearning({
  predictions = null, experience = null, plans = null,
  scope = { capabilities: [], truncated: false, considered: 0 }, goalId = null, excludePlanId = null,
} = {}) {
  const [adaptations, predictionLedger, assessments] = await Promise.all([
    readAdaptations(experience, scope),
    readPredictions(predictions, scope),
    readAssessments(plans, scope, goalId, excludePlanId),
  ]);
  const unavailable = [adaptations, predictionLedger, assessments]
    .map((r) => r.unavailable)
    .filter(Boolean);
  // Which of these records could move the comparison the answer is printed under, stated as the rows
  // themselves say it: approved, still standing, and carrying a shape the user recorded. Everything else
  // in this read - an expectation, an assessment, a rule nobody shaped - is disclosure.
  const shaping = adaptations.rows.filter((a) => a.active === true && a.decisionState === 'approved' && a.guidance);
  return {
    schema: LEARNING_SCHEMA,
    rule: LEARNING_RULE,
    separations: LEARNING_SEPARATIONS,
    note: shaping.length > 0 ? LEARNING_GUIDED : LEARNING_NOT_APPLIED,
    scope,
    adaptations,
    predictions: predictionLedger,
    assessments,
    unavailable,
    // Two claims an answer must be able to make without inference: this read authorized nothing, and
    // exactly which records it fed into the comparison it is printed under, named rather than implied.
    authorizes: false,
    influencesSelection: shaping.length > 0,
    shapingRecords: shaping.map((a) => a.id),
    inertRecords: adaptations.rows.filter((a) => !shaping.includes(a)).map((a) => a.id),
    appliedTo: {
      gates: 'nothing: a gate is a fact about the step and the registry, and no record here can supply one',
      candidateBytes: 'nothing: no candidate digest is computed from these records',
      ordering: shaping.length > 0
        ? `${shaping.length} approved guidance record(s) with a recorded shape, as the comparison's approved_adaptation_fit dimension`
        : 'nothing: no approved record carries a shape these capabilities name',
      scores: 'nothing: no score, weight, or probability is computed anywhere in this answer',
    },
    recordsRead: adaptations.rows.length + predictionLedger.rows.length + assessments.rows.length,
  };
}

// The shape the independent verification re-reads. Ids, derived statuses, counts and horizons only -
// never a rule's, an expectation's or a summary's prose, so a verification difference means the records
// moved rather than that a wording changed.
export function learningDigest(learning) {
  if (!learning) return null;
  const counts = (t) => (t ? [t.stored, t.live, t.evaluated, t.matched, t.contradicted, t.expired, t.unevaluated, t.awaitingEvaluation, t.invalidated] : null);
  const rate = (r) => (r ? [r.value, r.numerator, r.denominator] : null);
  const shape = {
    scope: learning.scope?.capabilities ?? [],
    adaptations: (learning.adaptations?.rows ?? []).map((a) => [
      shortId(a.id), a.capability, a.supportCount,
      // The four fields an approved record can move a comparison with, and the state that says whether
      // it may: a guidance shape that changed is a record that moved, not a wording that changed.
      a.guidance ? [a.guidance.order, a.guidance.avoid, a.guidance.prefer, a.guidance.maxSteps] : null,
      a.decisionState ?? null, a.active === true ? 1 : 0,
      (a.conflictsWith ?? []).map((c) => shortId(c.id)).sort(),
    ]),
    adaptationTotal: learning.adaptations?.total ?? null,
    predictions: (learning.predictions?.rows ?? []).map((p) => [shortId(p.id), p.capability, p.expectation, p.status, p.expiresAt, p.verdict]),
    predictionCounts: counts(learning.predictions?.totals ?? null),
    matchRate: rate(learning.predictions?.matchRate ?? null),
    assessments: (learning.assessments?.rows ?? []).map((a) => [shortId(a.planId), a.planVersion, a.verdict, a.stale, a.findings]),
    unavailable: learning.unavailable ?? [],
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// Lines a reader needs when a learning record is absent, in the order that matters: what was read, and
// whether the absence is a fact about the records or a fact about this build. Each part states the scope
// it is an absence within, because "no assessment is recorded" and "none of the recorded assessments
// reaches these capabilities" are different facts, and the first of them is often simply false.
export function learningAbsenceParts(learning) {
  const parts = [];
  if ((learning.adaptations?.rows ?? []).length === 0) {
    parts.push(learning.adaptations?.total ? `${learning.adaptations.total} adaptation(s) the user approved are recorded, none in the capabilities these steps name` : 'no adaptation the user approved is recorded');
  }
  if ((learning.predictions?.rows ?? []).length === 0) {
    parts.push(learning.predictions?.storedTotal
      ? `${learning.predictions.storedTotal} expectation(s) are recorded, none scoped to the capabilities these steps name`
      : 'no expectation is recorded');
  }
  if ((learning.assessments?.rows ?? []).length === 0) {
    parts.push(learning.assessments?.plansRead
      ? `${learning.assessments.plansRead} other plan(s) for this goal were read, none with an outcome assessment recorded against a step in these capabilities`
      : 'no other plan for this goal carries a recorded outcome assessment');
  }
  // What an absence of this kind is easily mistaken for. A step recorded while a plan ran is audited
  // under `task.step`, not under the capability the step names, so the evidence a run actually leaves
  // behind reaches this read only through a record written under the capability itself.
  if ((learning.scope?.capabilities ?? []).length > 0) {
    parts.push('this read asks by the capability each step names, and a step recorded while a plan ran is filed under task.step');
  }
  return parts;
}

export function learningAbsence(learning) {
  if (!learning) return 'no learning read was taken, so nothing about past attempts is claimed here';
  if ((learning.unavailable ?? []).length > 0) return `the learning read was incomplete: ${learning.unavailable.join('; ')}`;
  return learningAbsenceParts(learning).join('; ');
}

// An expectation that has resolved neither way, which is what the `[prediction]` mark means. A record
// carrying a verdict, an invalidation, or a supersession is history: it is printed as a fact about the
// ledger, because marking it `[prediction]` would claim it was still open.
const OPEN_EXPECTATIONS = new Set(['recorded', 'awaiting_evaluation', 'expired']);

function expectationState(p) {
  if (p.status === 'recorded') return `it stands until ${p.expiresAt ?? 'an unrecorded horizon'}`;
  if (p.status === 'awaiting_evaluation') return `outcome evidence exists but no evaluation was recorded, and its horizon is ${p.expiresAt ?? 'unrecorded'}`;
  // The wording Batch I requires: a passed horizon with nothing establishing the outcome is neither a
  // match nor a miss, and an answer that lets a reader count it as one has lost the distinction.
  if (p.status === 'expired') return `its horizon passed on ${p.expiresAt ?? 'an unrecorded time'} with nothing establishing it; expiry is not a wrong prediction`;
  if (p.status === 'evaluated') return `a recorded evaluation judged it ${p.verdict ?? 'unsettled'}`;
  if (p.status === 'invalidated') return 'the user withdrew it, and the record stays in the log';
  if (p.status === 'superseded') return 'a later expectation replaced it, and its own record stays readable';
  return `the ledger records it as ${p.status}`;
}

// One line per record, in the class of claim that record is allowed to make, and short enough to
// survive the answer's own line bound. Nothing here paraphrases a store's status into a stronger claim:
// the verdict, the horizon, and the basis are the store's fields, read back.
export function learningStatements(learning) {
  if (!learning) return [];
  const out = [];
  const caps = learning.scope?.capabilities ?? [];
  const adaptations = learning.adaptations ?? {};
  const ledger = learning.predictions ?? {};
  const assessments = learning.assessments ?? {};

  // The capabilities are named once, from the steps that were read. An empty read skips this line: the
  // header that introduces the block already names them, and the answer bounds its lines.
  if (learning.recordsRead > 0 && caps.length > 0) {
    out.push({ kind: ClaimKind.FACT, text: `this learning read is scoped to the capabilities these steps name: ${caps.join(', ')}${learning.scope?.truncated ? `, of ${learning.scope.considered} named in total` : ''}.` });
  }
  for (const a of adaptations.rows ?? []) {
    out.push({ kind: ClaimKind.FACT, text: `an adaptation the user approved bears on ${a.capability}: "${a.rule}" [record ${shortId(a.id)}, from ${a.supportCount} experience(s) by ${a.method ?? 'an unrecorded method'}, decided ${a.decidedAt ?? 'at an unrecorded time'}].` });
  }
  for (const p of ledger.rows ?? []) {
    out.push({
      kind: OPEN_EXPECTATIONS.has(p.status) ? ClaimKind.PREDICTION : ClaimKind.FACT,
      text: `an expectation the user recorded on ${p.capability} expects ${p.expectation}; ${expectationState(p)} [record ${shortId(p.id)}, cited basis ${p.evidenceBasis ?? 'none recorded'}].`,
    });
  }
  // The ledger's totals describe the whole store, not the capabilities these steps name, so they are
  // stated only beside an in-scope expectation they give context to. Where nothing is in scope the
  // absence part below already gives the store-wide count in the framing a reader needs - "N recorded,
  // none scoped to these capabilities" - and an answer that led with the bare count would spend its
  // bounded lines on a number that appears to bear on a plan it says nothing about.
  const totals = ledger.totals ?? null;
  if (totals && (ledger.rows ?? []).length > 0) {
    out.push({ kind: ClaimKind.FACT, text: `the expectation ledger as read: ${totals.stored ?? 0} record(s) in all, ${totals.evaluated ?? 0} evaluated (${totals.matched ?? 0} matched, ${totals.contradicted ?? 0} contradicted), ${totals.expired ?? 0} expired, ${totals.unevaluated ?? 0} with nothing establishing them, ${totals.invalidated ?? 0} withdrawn. A count of records is not a probability.` });
    const rate = ledger.matchRate ?? null;
    out.push({ kind: ClaimKind.FACT, text: rate?.value === null || rate?.value === undefined
      ? `no match rate is stated: ${rate?.reason ?? 'the ledger returned no reason'}`
      : `the ledger states a match rate of ${rate.numerator}/${rate.denominator} over ${ledger.rateDenominator ?? 'the evaluations the user has not withdrawn'} - a count of recorded evaluations, and nothing in this answer is adjusted by it.` });
  }
  for (const a of assessments.rows ?? []) {
    out.push({ kind: ClaimKind.FACT, text: `an earlier attempt at this goal was assessed: plan ${shortId(a.planId)} v${a.planVersion ?? '?'} (${a.planStatus}) was read as ${a.verdict} at ${a.at ?? 'an unrecorded time'}, citing ${a.findings} finding(s)${(a.operations ?? []).length ? ` [operation(s) ${a.operations.map(shortId).join(', ')}]` : ''}${a.stale ? '; the plan content has since changed, so that reading describes an older version' : ''}.` });
  }
  // An incomplete read is stated store by store: "the plan records could not be read" and "nothing is
  // recorded" are different facts. An empty read is stated part by part, because the answer bounds its
  // lines and one joined sentence would lose its last part to truncation.
  if ((learning.unavailable ?? []).length > 0) {
    for (const u of learning.unavailable) out.push({ kind: ClaimKind.FACT, text: `the learning read was incomplete: ${u}.` });
  } else if (learning.recordsRead === 0) {
    for (const part of learningAbsenceParts(learning)) out.push({ kind: ClaimKind.FACT, text: `${part}.` });
  }
  return out;
}

// The full block, as the command's own print shows it: the statements unbounded, the five separations
// in full, and the absence of any effect on the comparison stated in the same place as the records.
export function renderLearning(learning = null) {
  if (!learning) return ['What the records of past attempts say: nothing read, so nothing claimed.'].join('\n');
  const statements = learningStatements(learning);
  const lines = [
    `What the records of past attempts say about ${learning.scope?.capabilities?.length ?? 0} capability(ies), ${
      learning.influencesSelection
        ? 'disclosed, and the shape the user recorded on an approved rule is checked against the comparison:'
        : 'disclosed and applied to nothing:'
    }`,
    `  rule: ${LEARNING_RULE}`,
  ];
  if (statements.length === 0) lines.push('  - no learning record bears on these capabilities.');
  for (const s of statements) lines.push(`  - ${singleLine(s.text, 320)}`);
  if ((learning.adaptations?.rows ?? []).length > 0) {
    lines.push(`  ${learning.adaptations.total ?? 0} approved adaptation(s) are in scope for the store; the read printed ${learning.adaptations.rows.length} in these capabilities.`);
  }
  if ((learning.predictions?.rows ?? []).length > 0 && learning.predictions?.shown > learning.predictions.rows.length) {
    lines.push(`  ${learning.predictions.shown - learning.predictions.rows.length} further expectation(s) bear on these capabilities and stay in the ledger; "node bin/apex.js prediction list" prints them.`);
  }
  if ((learning.assessments?.rows ?? []).length > 0 && learning.assessments.total > learning.assessments.rows.length) {
    lines.push(`  ${learning.assessments.total - learning.assessments.rows.length} earlier assessment(s) for this goal are recorded against those plans and stay readable there.`);
  }
  lines.push('  What each of these is not:');
  for (const s of LEARNING_SEPARATIONS) lines.push(`    - ${s}`);
  lines.push(`  ${learning.note ?? LEARNING_NOT_APPLIED}`);
  return lines.join('\n');
}
