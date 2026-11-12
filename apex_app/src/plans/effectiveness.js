// Batch AP-04: what happened after an approved adaptation was actually in force.
//
// AP-01 recorded the decision an approved rule produced beside the decision without it. AP-02 and
// AP-03 added prediction-derived rules and longitudinal support. None of that answers the next
// question honestly: did the work that followed an adapted decision go well? This module answers it
// only from records that already exist, and it keeps four claims apart that are easy to conflate:
//
//   1. approved     - the user recorded a decision, and its support still stands;
//   2. applied      - a comparison put the rule on the table and its dimension changed the front;
//   3. executed     - a plan recorded in the same audit operation as that comparison was activated;
//   4. evaluated    - the plan's recorded outcomes and assessments classify what happened.
//
// Approval is not application, application is not success, and a recorded success is not proof that
// the rule caused it. The unadapted candidate was never executed, so no baseline outcome exists and
// none is estimated. A use is linked only when the audit record, the plan content digest, the goal,
// and the rule version all still agree; anything else is disclosed as excluded rather than counted.
//
// This is a read. It approves nothing, changes no rule, increases no influence, retires nothing, and
// executes nothing. A recommendation is a sentence for the user, and retirement remains the existing
// `adaptation.retire` action.
import { createHash } from 'node:crypto';
import { stableStringify } from '../tasks/model.js';
import { planContent, planContentHash } from './model.js';
import { assessOutcome } from './assessment.js';
import { StoreError, ValidationError } from '../errors.js';
import { shortId, singleLine } from '../util.js';

export const EFFECTIVENESS_SCHEMA = 'apex.adaptation-effectiveness.v1';
export const EFFECTIVENESS_NOTE = 'An effectiveness report is a bounded read of recorded evidence. It states observations, not causes, probabilities, or a decision: nothing here approves, changes, retires, or executes anything.';

// The eight outcome values Batch AP-04 fixes. A use either carries one of these or says explicitly
// that no outcome is available yet; it never borrows "failed" to mean "not recorded".
export const EFFECTIVENESS_OUTCOMES = Object.freeze([
  'successful',
  'partially_successful',
  'failed',
  'blocked',
  'uncertain',
  'awaiting_confirmation',
  'insufficient_evidence',
  'conflicting_evidence',
]);

// One classification per adaptation, derived from its current version's uses. The first nine are the
// distinctions the batch requires; the three after them name situations the records can also show
// without pretending they are one of the nine.
export const EFFECTIVENESS_STATES = Object.freeze([
  'not_approved',
  'approved_never_applied',
  'applied_outcome_pending',
  'applied_successful',
  'applied_failed',
  'applied_blocked_or_uncertain',
  'applied_insufficient_evidence',
  'applied_conflicting_evidence',
  'retired_before_evaluation',
  'ineligible_support_invalid',
  'applied_partially_successful',
  'applied_awaiting_confirmation',
  'applied_mixed_outcomes',
  'applied_not_changed',
  'applied_unattributed',
  'applied_to_earlier_version',
]);

export const EFFECTIVENESS_SUMMARIES = Object.freeze([
  'repeated_success',
  'repeated_failure',
  'mixed_outcomes',
  'no_measurable_difference',
  'insufficient_evidence',
  'conflicting_evidence',
  'too_few_observations',
]);

export const EFFECTIVENESS_RECOMMENDATIONS = Object.freeze(['none', 'review', 'consider_retirement']);

export const MAX_EFFECTIVENESS_ADAPTATIONS = 20;
export const MAX_EFFECTIVENESS_USES = 100;

const MAX_USES_PER_ADAPTATION = 20;
const MAX_AUDIT_SCAN = 20000;
const MAX_EVIDENCE_IDS = 20;
const MAX_SAMPLES = 10;
const MAX_RENDERED_USES = 5;
const MAX_TEXT = 240;

const DISCLOSURE_ACTIONS = new Set(['plan.candidates', 'plan.replan']);
const ADAPTED_ATTRIBUTIONS = new Set(['adapted_unique', 'adapted_shared']);
// A plan recorded while the guidance was declined, or while the applied guidance changed nothing, is
// an actual unadapted execution: the comparison reached that plan without the rule changing it.
const BASELINE_ATTRIBUTIONS = new Set(['declined', 'applied_not_changed']);
// The rule was applied, but the record that should tie an outcome to it does not hold: no plan was
// written, the plan names another goal, the plan's content changed, or the recorded approach is not
// the leading one the rule named. These are uses of the rule, so they are never `approved_never_applied`.
const UNAttributed_APPLIED = new Set([
  'applied_unlinked',
  'goal_mismatch',
  'plan_unbound',
  'plan_content_changed',
  'adapted_not_leading',
]);
const EVALUATED_KINDS = new Set(['successful', 'partially_successful', 'failed', 'blocked', 'uncertain', 'awaiting_confirmation']);

const VERDICT_OUTCOME = Object.freeze({
  successful: 'successful',
  partial: 'partially_successful',
  failed: 'failed',
  blocked: 'blocked',
  uncertain: 'uncertain',
  awaiting_confirmation: 'awaiting_confirmation',
});

const SUMMARY_TEXT = Object.freeze({
  repeated_success: 'Every evaluated use of this version recorded a successful outcome. This is a count of what the records say, not evidence that the rule caused it.',
  repeated_failure: 'Every evaluated use of this version recorded a failed outcome. The records state what failed; they do not establish that the rule caused it.',
  mixed_outcomes: 'The evaluated uses of this version do not agree. The records do not identify what separated the successful work from the rest.',
  no_measurable_difference: 'The adapted and unadapted observations that could be compared recorded the same outcomes. The sample is small and no effect is claimed.',
  insufficient_evidence: 'The records do not classify enough evaluated uses of this version to summarize what followed.',
  conflicting_evidence: 'The records disagree about what happened after this version was in force, so no single outcome is reported.',
  too_few_observations: 'Fewer than two evaluated uses of this version are attributable to it, so the sample remains explicitly insufficient.',
});

const LIMITATIONS = Object.freeze([
  'Approval is not application, application is not success, and a recorded success is not evidence that the adaptation caused it.',
  'The unadapted candidate was never executed, so no baseline outcome exists. An unavailable baseline is not a zero, a failure, or a success, and none is estimated.',
  'Counts are observations of this store\'s records. They are not confidence percentages, success probabilities, statistical significance, or a forecast.',
  'An outcome assessment records what verification, step outcomes, goal evidence, and the knowledge and memory stores still establish. It does not establish real-world success beyond those records.',
  'The read is bounded: at most 20 adaptations, 20 uses per adaptation, 100 uses in total, and 20,000 audit records. Truncation is disclosed rather than hidden.',
  'Nothing here approves a rule, changes a rule, increases an influence, retires another adaptation, changes a plan or goal, or executes or retries a task. Retirement remains `adaptation.retire`.',
]);

function digestOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function boundedLimit(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_EFFECTIVENESS_ADAPTATIONS;
  return Math.min(value, MAX_EFFECTIVENESS_ADAPTATIONS);
}

// The plan record's bytes as the comparison's candidate content shaped them. Approval adds fields
// that are not part of the candidate (`goalRevision`), and plan.add materialises nulls the candidate
// omitted (`criterionId`, `ref`). Dropping exactly those gives the digest the candidate set was bound
// to, or a digest no candidate matches - which is the honest answer for an edited plan.
function candidateContentOf(plan) {
  const content = planContent(plan);
  const steps = content.steps.map((s) => {
    const out = { ...s };
    if (out.criterionId === null) delete out.criterionId;
    return out;
  });
  const assertions = content.assertions.map((a) => {
    const out = { ...a };
    if (out.ref === null) delete out.ref;
    if (out.expected === undefined || out.expected === null) delete out.expected;
    return out;
  });
  return {
    goalId: content.goalId ?? null,
    outcome: content.outcome,
    steps,
    preconditions: content.preconditions,
    assertions,
    resources: content.resources,
  };
}

function planDigest(plan) {
  return digestOf(candidateContentOf(plan));
}

function progressOf(plan) {
  const progress = { completed: 0, failed: 0, uncertain: 0, skipped: 0, pending: 0 };
  for (const step of plan.steps ?? []) {
    const status = plan.stepResults?.[step.id]?.status ?? null;
    if (status === 'completed') progress.completed += 1;
    else if (status === 'failed') progress.failed += 1;
    else if (status === 'uncertain') progress.uncertain += 1;
    else if (status === 'skipped') progress.skipped += 1;
    else progress.pending += 1;
  }
  return progress;
}

// The audit records were already read whole and found clean. Reusing that one read for the outcome
// assessments is equivalent to findById over the same bytes: the first record in append order is the
// one that counts, every absent id reports the number of lines inspected, and damage is impossible
// because a damaged log was refused before this reader was built.
function auditReader(records) {
  const first = new Map();
  for (const record of records) {
    if (typeof record?.id !== 'string') continue;
    if (!first.has(record.id)) first.set(record.id, record);
  }
  return {
    async findById(id) {
      if (typeof id !== 'string' || id.length === 0) {
        return { found: false, record: null, inspected: 0, corrupt: 0, stoppedEarly: false };
      }
      const record = first.get(id) ?? null;
      return {
        found: record !== null,
        record,
        inspected: records.length,
        corrupt: 0,
        stoppedEarly: record !== null,
      };
    },
  };
}

function scanDisclosures(records) {
  const decisions = [];
  let inspected = 0;
  let unlinkedWrites = 0;
  for (let i = records.length - 1; i >= 0 && inspected < MAX_AUDIT_SCAN; i -= 1) {
    inspected += 1;
    const record = records[i];
    const steps = Array.isArray(record?.steps) ? record.steps : [];
    const reads = steps.filter((s) => DISCLOSURE_ACTIONS.has(s?.action) && s?.result?.data?.adaptationDecision);
    const writes = steps.filter((s) => s?.action === 'plan.add' && typeof s?.result?.data?.planId === 'string');
    if (reads.length === 0) {
      if (writes.length > 0) unlinkedWrites += writes.length;
      continue;
    }
    // One disclosure and at most one recorded plan is the shape the controller writes. Anything else
    // cannot say which decision produced which plan, so the plan is not linked rather than guessed.
    const unambiguous = reads.length === 1 && writes.length <= 1;
    for (const step of reads) {
      const data = step.result.data;
      const decision = data.adaptationDecision;
      decisions.push({
        operationId: record.id,
        recordedAt: record.requestedAt ?? record.finishedAt ?? null,
        via: step.action,
        goalId: data.goalId ?? null,
        planId: unambiguous ? (writes[0]?.result?.data?.planId ?? null) : null,
        linkage: unambiguous ? (writes.length === 1 ? 'linked' : 'disclosed_only') : 'ambiguous_operation',
        candidates: (Array.isArray(data.candidates) ? data.candidates : [])
          .map((c) => ({ strategy: c?.strategy ?? null, digest: c?.digest ?? null }))
          .filter((c) => typeof c.strategy === 'string' && typeof c.digest === 'string'),
        decision,
      });
    }
  }
  return {
    decisions,
    inspected,
    truncated: records.length > inspected,
    unlinkedWrites,
  };
}

function decisionRule(decision, id) {
  return (Array.isArray(decision?.rules) ? decision.rules : []).find((r) => r?.id === id) ?? null;
}

function decisionConsidered(decision, id) {
  return (Array.isArray(decision?.considered) ? decision.considered : []).find((r) => r?.id === id) ?? null;
}

function evaluateUse({ adaptation, disclosure, plan, currentVersion }) {
  const rule = decisionRule(disclosure.decision, adaptation.id);
  const considered = decisionConsidered(disclosure.decision, adaptation.id);
  if (!rule && !considered) return null;
  const applied = disclosure.decision.applied === true;
  const changed = disclosure.decision.changed === true;
  const ruleVersion = rule?.version ?? considered?.version ?? null;
  const base = {
    operationId: disclosure.operationId,
    decidedAt: disclosure.recordedAt,
    via: disclosure.via,
    goalId: disclosure.goalId,
    planId: disclosure.planId,
    linkage: disclosure.linkage,
    ruleVersion,
    applied,
    changed,
    decisionOutcome: disclosure.decision.outcome ?? null,
    before: disclosure.decision.before ?? { leading: null, front: [] },
    after: disclosure.decision.after ?? { leading: null, front: [] },
    ruleIds: (Array.isArray(disclosure.decision.rules) ? disclosure.decision.rules : [])
      .map((r) => r?.id).filter((id) => typeof id === 'string'),
  };
  if (!rule) {
    return {
      ...base,
      attribution: applied ? 'not_applicable' : 'declined',
      why: applied
        ? `the comparison read this record but used other guidance instead (${considered?.state ?? 'inert'})${considered?.why ? `: ${singleLine(considered.why, MAX_TEXT)}` : ''}`
        : `the comparison applied no approved guidance, and this record was read (${considered?.state ?? 'inert'})${considered?.why ? `: ${singleLine(considered.why, MAX_TEXT)}` : ''}`,
    };
  }
  if (currentVersion !== null && ruleVersion !== currentVersion) {
    return {
      ...base,
      attribution: 'stale_rule_version',
      why: `the decision used version ${ruleVersion ?? 'unrecorded'}, but the record now stands at version ${currentVersion}; the use belongs to an earlier shape and is not counted against the current one`,
    };
  }
  if (!applied) {
    return {
      ...base,
      attribution: 'declined',
      why: disclosure.decision.declinedReason
        ? `the comparison declined the approved guidance: ${singleLine(disclosure.decision.declinedReason, MAX_TEXT)}`
        : 'the comparison did not apply the approved guidance',
    };
  }
  if (!plan) {
    return {
      ...base,
      attribution: 'applied_unlinked',
      why: disclosure.planId
        ? 'the decision names a plan that is not in the plan store'
        : 'the rule was applied but no plan was recorded in the same operation, so no outcome can be tied to this use',
    };
  }
  if (disclosure.goalId && plan.goalId && disclosure.goalId !== plan.goalId) {
    return {
      ...base,
      attribution: 'goal_mismatch',
      why: `the decision answered goal ${shortId(disclosure.goalId)} but the recorded plan names ${shortId(plan.goalId)}`,
    };
  }
  if (plan.goalId === null) {
    return {
      ...base,
      attribution: 'plan_unbound',
      why: 'the recorded plan names no goal, so the decision it was recorded from cannot be established from the plan record',
    };
  }
  const digest = planDigest(plan);
  const match = disclosure.candidates.find((c) => c.digest === digest) ?? null;
  if (!match) {
    return {
      ...base,
      attribution: 'plan_content_changed',
      why: 'the plan record no longer matches any candidate the decision compared, so the decision it was recorded from cannot be established',
      planDigest: digest,
    };
  }
  if (!changed) {
    return {
      ...base,
      attribution: 'applied_not_changed',
      why: 'the guidance was applied, but the comparison had already reached the same front; the recorded plan is also the unadapted choice',
      recordedStrategy: match.strategy,
      planDigest: digest,
    };
  }
  if (disclosure.decision.after?.leading !== match.strategy) {
    return {
      ...base,
      attribution: 'adapted_not_leading',
      why: `the guidance changed the front, but the recorded approach ${match.strategy} is not the leading one the adapted rule named`,
      recordedStrategy: match.strategy,
      planDigest: digest,
    };
  }
  const conflictFree = (adaptation.conflicts ?? []).length === 0;
  if (base.ruleIds.length === 1 && conflictFree) {
    return {
      ...base,
      attribution: 'adapted_unique',
      why: `the recorded approach ${match.strategy} is the leading candidate the adapted rule named, and it is the only applicable rule in this decision`,
      recordedStrategy: match.strategy,
      planDigest: digest,
    };
  }
  return {
    ...base,
    attribution: 'adapted_shared',
    why: `the recorded approach ${match.strategy} is the leading candidate, but ${base.ruleIds.length} approved rule(s) were on the table${conflictFree ? '' : ', and at least one disagrees with another recorded rule'}, so the choice cannot be attributed to this record alone`,
    recordedStrategy: match.strategy,
    planDigest: digest,
  };
}

function dedupeUses(uses) {
  const byPlan = new Map();
  const noPlan = [];
  let duplicates = 0;
  for (const use of uses) {
    if (!use.planId) {
      noPlan.push(use);
      continue;
    }
    const prior = byPlan.get(use.planId);
    if (!prior) {
      byPlan.set(use.planId, use);
      continue;
    }
    duplicates += 1;
    if (String(use.decidedAt ?? '') < String(prior.decidedAt ?? '')) byPlan.set(use.planId, use);
  }
  return { uses: [...byPlan.values(), ...noPlan], duplicates };
}

function unavailableOutcome(reason) {
  return {
    state: 'unavailable',
    kind: null,
    available: false,
    source: 'none',
    reason,
    planId: null,
    planStatus: null,
    planVersion: null,
    contentHash: null,
    taskId: null,
    steps: null,
    evidence: { assessments: 0, staleAssessments: 0, verdicts: [], operations: [], derived: false, derivedVerdict: null, derivedBasis: null, derivedError: null },
  };
}

async function derivePlanOutcome(plan, { goals, operations, knowledge, memory }) {
  const currentHash = planContentHash(plan);
  const all = Array.isArray(plan.assessments) ? plan.assessments : [];
  const current = all.filter((a) => a.planVersion === plan.version && a.contentHash === currentHash);
  const verdicts = [...new Set(current.map((a) => a.verdict))];
  const steps = progressOf(plan);
  const base = {
    planId: plan.id,
    planStatus: plan.status,
    planVersion: plan.version,
    contentHash: currentHash,
    taskId: plan.activation?.taskId ?? null,
    steps,
    evidence: {
      assessments: current.length,
      staleAssessments: all.length - current.length,
      verdicts,
      operations: [],
      derived: false,
      derivedVerdict: null,
      derivedBasis: null,
      derivedError: null,
    },
  };
  if (verdicts.length > 1) {
    return {
      ...base,
      state: 'evaluated',
      kind: 'conflicting_evidence',
      available: true,
      source: 'recorded_assessment',
      verdict: null,
      reason: `current assessments of this version disagree: ${verdicts.join(', ')}`,
    };
  }
  let derived = null;
  let derivedError = null;
  if (plan.activation && operations) {
    let goal = null;
    if (plan.goalId && goals && typeof goals.get === 'function') {
      try {
        goal = await goals.get(plan.goalId);
      } catch (err) {
        derivedError = `the goal could not be read (${err?.code ?? 'store error'})`;
      }
    }
    try {
      derived = await assessOutcome(plan, { goal, operations, knowledge, memory });
    } catch (err) {
      derivedError = err?.code ?? err?.message ?? 'the outcome assessment could not be completed';
    }
  }
  const derivedKind = derived?.ok ? (VERDICT_OUTCOME[derived.verdict] ?? null) : null;
  base.evidence.derived = derived?.ok === true;
  base.evidence.derivedVerdict = derived?.verdict ?? null;
  base.evidence.derivedBasis = derived?.basis ?? null;
  base.evidence.derivedError = derivedError;
  if (derived?.ok) {
    base.evidence.operations = [...new Set((derived.findings ?? []).flatMap((f) => f.operations ?? []))].slice(0, MAX_EVIDENCE_IDS);
  }
  if (!plan.activation) {
    // A plan the user recorded as blocked or failed before it ever started is a stated disposition,
    // not an outcome still waiting to be recorded. Reporting it as pending would turn a known block
    // into silence; it is not a failure merely because no step ran.
    if (plan.status === 'blocked' || plan.status === 'failed') {
      return {
        ...base,
        state: 'evaluated',
        kind: plan.status,
        available: true,
        source: 'plan_status',
        verdict: null,
        reason: plan.status === 'blocked'
          ? 'the plan is recorded as blocked and was never started, so the work is blocked rather than failed or awaiting an outcome'
          : 'the plan is recorded as failed and was never started, so the failure is the user\'s recorded disposition, not a step outcome',
      };
    }
    if (plan.status === 'draft' || plan.status === 'approved') {
      return {
        ...base,
        state: 'pending',
        kind: null,
        available: false,
        source: 'none',
        verdict: null,
        reason: `the plan is ${plan.status} and has not been started, so no execution outcome exists yet`,
      };
    }
    if (plan.status === 'cancelled' || plan.status === 'superseded') {
      return {
        ...base,
        state: 'not_executed',
        kind: 'insufficient_evidence',
        available: false,
        source: 'none',
        verdict: null,
        reason: `the plan was ${plan.status} without an activation, so there is no execution outcome to evaluate`,
      };
    }
    return {
      ...base,
      state: 'pending',
      kind: null,
      available: false,
      source: 'none',
      verdict: null,
      reason: `the plan is ${plan.status} and records no activation`,
    };
  }
  if (verdicts.length === 1) {
    const recordedKind = VERDICT_OUTCOME[verdicts[0]] ?? 'insufficient_evidence';
    if (recordedKind === 'successful' && (steps.failed > 0 || steps.uncertain > 0)) {
      return {
        ...base,
        state: 'evaluated',
        kind: 'conflicting_evidence',
        available: true,
        source: 'recorded_assessment',
        verdict: verdicts[0],
        reason: `the recorded assessment says ${verdicts[0]}, but the plan's step records hold ${steps.failed} failed and ${steps.uncertain} uncertain step(s)`,
      };
    }
    if (derivedKind && EVALUATED_KINDS.has(derivedKind) && EVALUATED_KINDS.has(recordedKind) && derivedKind !== recordedKind) {
      return {
        ...base,
        state: 'evaluated',
        kind: 'conflicting_evidence',
        available: true,
        source: 'recorded_and_derived',
        verdict: verdicts[0],
        reason: `the recorded assessment says ${verdicts[0]}, while the evidence re-read now says ${derived.verdict}`,
      };
    }
    return {
      ...base,
      state: 'evaluated',
      kind: recordedKind,
      available: true,
      source: derived?.ok ? 'recorded_and_derived' : 'recorded_assessment',
      verdict: verdicts[0],
      reason: `a current assessment of this version records ${verdicts[0]}${derived?.ok ? `, and the evidence re-read agrees` : ''}`,
    };
  }
  if (derived?.ok && derivedKind) {
    return {
      ...base,
      state: 'evaluated',
      kind: derivedKind,
      available: true,
      source: 'derived',
      verdict: derived.verdict,
      reason: `the plan's recorded steps and audit outcomes support ${derived.verdict}; ${derived.basis}`,
    };
  }
  if (derived && derived.ok === false) {
    return {
      ...base,
      state: 'not_executed',
      kind: 'insufficient_evidence',
      available: false,
      source: 'none',
      verdict: null,
      reason: derived.reason ?? 'the plan has no execution outcome that can be assessed',
    };
  }
  return {
    ...base,
    state: 'unavailable',
    kind: 'insufficient_evidence',
    available: false,
    source: 'none',
    verdict: null,
    reason: derivedError ? `the outcome could not be re-read (${derivedError})` : 'no outcome assessment or audit evidence is available for this plan',
  };
}

function counterfactualOf(use) {
  const before = use.before ?? { leading: null, front: [] };
  const after = use.after ?? { leading: null, front: [] };
  return {
    changed: use.changed === true,
    applied: use.applied === true,
    unadaptedDecision: before,
    adaptedDecision: after,
    recordedStrategy: use.recordedStrategy ?? null,
    unadaptedExecuted: false,
    baselineOutcome: 'unavailable',
    statement: use.changed === true
      ? `Without this record the comparison led with ${before.leading ?? 'no single candidate'}; that approach was not executed, so its outcome is unavailable and is not estimated.`
      : 'The comparison reached the same front with and without this record, so the recorded plan is also the unadapted choice; no second, unadapted execution exists to compare.',
    note: 'An unavailable baseline is not a zero, a failure, or a success.',
  };
}

function countKinds(kinds) {
  const counts = {};
  for (const kind of EFFECTIVENESS_OUTCOMES) counts[kind] = 0;
  for (const kind of kinds) if (kind in counts) counts[kind] += 1;
  return counts;
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

function summarize({ adaptation, version, uses, current }) {
  const adapted = uses.filter((u) => ADAPTED_ATTRIBUTIONS.has(u.attribution) && u.outcome?.state === 'evaluated');
  const baseline = uses.filter((u) => BASELINE_ATTRIBUTIONS.has(u.attribution) && u.outcome?.state === 'evaluated');
  const evaluated = uses.filter((u) => u.outcome?.state === 'evaluated');
  const pending = uses.filter((u) => u.outcome?.state === 'pending');
  const excluded = uses.filter((u) => !ADAPTED_ATTRIBUTIONS.has(u.attribution) && !BASELINE_ATTRIBUTIONS.has(u.attribution));
  const adaptedKinds = adapted.map((u) => u.outcome.kind);
  const baselineKinds = baseline.map((u) => u.outcome.kind);
  let kind;
  if (evaluated.some((u) => u.outcome.kind === 'conflicting_evidence')) {
    kind = 'conflicting_evidence';
  } else if (adaptedKinds.length === 0) {
    kind = 'insufficient_evidence';
  } else if (adaptedKinds.length < 2) {
    kind = 'too_few_observations';
  } else if (baselineKinds.length >= 2) {
    kind = sameMultiset(adaptedKinds, baselineKinds) ? 'no_measurable_difference' : 'mixed_outcomes';
  } else {
    const distinct = new Set(adaptedKinds);
    if (distinct.size > 1) {
      kind = 'mixed_outcomes';
    } else if (adaptedKinds[0] === 'successful') {
      kind = 'repeated_success';
    } else if (adaptedKinds[0] === 'failed') {
      kind = 'repeated_failure';
    } else {
      kind = 'insufficient_evidence';
    }
  }
  return {
    version,
    current,
    observations: {
      uses: uses.length,
      evaluated: evaluated.length,
      adapted: adapted.length,
      baseline: baseline.length,
      pending: pending.length,
      excluded: excluded.length,
    },
    outcomeCounts: countKinds(evaluated.map((u) => u.outcome.kind)),
    adaptedOutcomeCounts: countKinds(adaptedKinds),
    baselineOutcomeCounts: countKinds(baselineKinds),
    kind,
    statement: `${SUMMARY_TEXT[kind]} ${adapted.length} adapted and ${baseline.length} unadapted observation(s) were evaluated.`,
    recommendation: recommendationFor(kind),
  };
}

function recommendationFor(kind) {
  if (kind === 'repeated_failure') {
    return {
      kind: 'consider_retirement',
      why: 'Every evaluated use of this version recorded a failed outcome. Retirement is still your decision through adaptation.retire; this report cannot perform it.',
      authorizes: false,
    };
  }
  if (kind === 'conflicting_evidence' || kind === 'mixed_outcomes' || kind === 'no_measurable_difference') {
    return {
      kind: 'review',
      why: 'The evaluated uses do not give one answer. Review the uses below before deciding whether the rule should keep its current shape; this report authorizes no change.',
      authorizes: false,
    };
  }
  return {
    kind: 'none',
    why: 'The recorded evidence does not support a recommendation. Absence of a recommendation is not a finding of effectiveness.',
    authorizes: false,
  };
}

function classify({ adaptation, uses, allUses = [], summary }) {
  const current = uses.filter((u) => !u.staleVersion);
  const stale = allUses.filter((u) => u.staleVersion);
  const changed = current.filter((u) => ADAPTED_ATTRIBUTIONS.has(u.attribution));
  const unchanged = current.filter((u) => u.attribution === 'applied_not_changed');
  if (adaptation.decisionState !== 'approved' && adaptation.decisionState !== 'retired') {
    return {
      state: 'not_approved',
      why: `the record is ${adaptation.decisionState}; there is no approved rule whose uses could be evaluated`,
    };
  }
  if (adaptation.retired && changed.filter((u) => u.outcome?.state === 'evaluated').length === 0) {
    return {
      state: 'retired_before_evaluation',
      why: 'the record was retired before any use of it produced an evaluated outcome',
    };
  }
  if (adaptation.supportState && adaptation.supportState !== 'intact') {
    return {
      state: 'ineligible_support_invalid',
      why: `the supporting evidence no longer stands: ${(adaptation.supportProblems ?? []).join('; ') || 'support is stale'}`,
    };
  }
  // A use is only evidence about the version it read. When every use belongs to an earlier shape,
  // the current version has no observations and the earlier ones are excluded rather than counted.
  if (current.length === 0 && stale.length > 0) {
    return {
      state: 'applied_to_earlier_version',
      why: `${stale.length} recorded use(s) belong to an earlier shape of this rule; they are excluded from the current version, which has no recorded use`,
    };
  }
  if (changed.length === 0) {
    if (unchanged.length > 0) {
      return {
        state: 'applied_not_changed',
        why: 'the guidance was applied but the comparison had already reached the same front, so no recorded plan is attributable to a changed choice',
      };
    }
    // A use whose rule was applied but whose plan could not be tied to the decision is not the same
    // as a rule that was never applied, and it must not be reported as one.
    if (current.some((u) => UNAttributed_APPLIED.has(u.attribution))) {
      return {
        state: 'applied_unattributed',
        why: 'the rule was applied to a comparison, but no recorded plan could be tied to that decision, so no outcome is counted for it',
      };
    }
    return {
      state: 'approved_never_applied',
      why: current.some((u) => u.attribution === 'declined')
        ? 'approved, but every comparison that read it declined to apply it'
        : 'no recorded decision applied this record',
    };
  }
  const evaluated = changed.filter((u) => u.outcome?.state === 'evaluated');
  if (evaluated.length === 0) {
    const withPlan = changed.filter((u) => u.planId);
    if (withPlan.length === 0) {
      return {
        state: 'applied_unattributed',
        why: 'the rule was applied and changed the comparison, but no recorded plan could be tied to the decision',
      };
    }
    // A plan that exists but whose outcome evidence establishes nothing is insufficient evidence,
    // not an outcome still waiting to be recorded.
    if (changed.every((u) => u.outcome?.kind === 'insufficient_evidence')) {
      return {
        state: 'applied_insufficient_evidence',
        why: 'the rule was applied and a plan was recorded, but the recorded evidence does not establish what happened; that is not a failure',
      };
    }
    return {
      state: 'applied_outcome_pending',
      why: 'the rule was applied and a plan was recorded, but none of its uses has an evaluated outcome yet',
    };
  }
  const kinds = evaluated.map((u) => u.outcome.kind);
  if (kinds.includes('conflicting_evidence')) {
    return { state: 'applied_conflicting_evidence', why: 'the evaluated uses disagree about what happened, or a recorded assessment contradicts the evidence' };
  }
  if (kinds.every((k) => k === 'successful')) {
    return { state: 'applied_successful', why: 'every evaluated use recorded a successful outcome' };
  }
  if (kinds.every((k) => k === 'failed')) {
    return { state: 'applied_failed', why: 'every evaluated use recorded a failed outcome' };
  }
  if (kinds.every((k) => k === 'blocked' || k === 'uncertain')) {
    return { state: 'applied_blocked_or_uncertain', why: 'every evaluated use is blocked or uncertain; neither is reported as a failure' };
  }
  if (kinds.every((k) => k === 'awaiting_confirmation')) {
    return { state: 'applied_awaiting_confirmation', why: 'every evaluated use is waiting for a confirmation the records do not hold' };
  }
  if (kinds.every((k) => k === 'partially_successful')) {
    return { state: 'applied_partially_successful', why: 'every evaluated use recorded a partial outcome' };
  }
  if (kinds.every((k) => k === 'insufficient_evidence')) {
    return { state: 'applied_insufficient_evidence', why: 'every evaluated use rests on insufficient evidence; that is not a failure' };
  }
  return { state: 'applied_mixed_outcomes', why: `the evaluated uses disagree: ${[...new Set(kinds)].join(', ')}` };
}

function useRow(use) {
  return {
    operationId: use.operationId,
    decidedAt: use.decidedAt,
    via: use.via,
    attribution: use.attribution,
    why: use.why,
    ruleVersion: use.ruleVersion,
    decision: {
      applied: use.applied,
      changed: use.changed,
      outcome: use.decisionOutcome,
      before: use.before,
      after: use.after,
      rules: [...use.ruleIds],
    },
    recordedStrategy: use.recordedStrategy ?? null,
    planId: use.planId,
    planStatus: use.outcome?.planStatus ?? null,
    counterfactual: use.counterfactual ?? counterfactualOf(use),
    outcome: use.outcome,
    countedAs: ADAPTED_ATTRIBUTIONS.has(use.attribution)
      ? 'adapted'
      : (BASELINE_ATTRIBUTIONS.has(use.attribution) ? 'baseline' : 'excluded'),
  };
}

function unavailableReport(reason, generatedAt, scope = null) {
  const report = {
    schema: EFFECTIVENESS_SCHEMA,
    available: false,
    reason,
    generatedAt,
    scope,
    reads: null,
    adaptations: [],
    totals: null,
    limitations: [...LIMITATIONS],
    authorizes: false,
    note: EFFECTIVENESS_NOTE,
  };
  report.digest = digestOf({ schema: report.schema, available: report.available, reason: report.reason, adaptations: [] });
  return report;
}

export async function analyzeAdaptationEffectiveness({
  experience,
  plans,
  operations,
  goals = null,
  knowledge = null,
  memory = null,
  now = () => new Date(),
  target = null,
  limit = MAX_EFFECTIVENESS_ADAPTATIONS,
} = {}) {
  const generatedAt = now().toISOString();
  if (!experience || typeof experience.adaptationDetail !== 'function') {
    return unavailableReport('the experience store is not available in this configuration', generatedAt);
  }
  if (!plans || typeof plans.load !== 'function') {
    return unavailableReport('the plan store is not available in this configuration', generatedAt);
  }
  if (!operations || typeof operations.inspect !== 'function') {
    return unavailableReport('the audit log is not available in this configuration', generatedAt);
  }
  const size = boundedLimit(limit);
  const scope = { target: target ?? null, limit: size };
  let adaptations;
  if (target !== null && target !== undefined && String(target).trim().length > 0) {
    const ref = String(target).trim();
    const one = await experience.adaptationDetail(ref);
    if (!one) throw new ValidationError(`no adaptation matches "${singleLine(ref, 40)}"`);
    adaptations = [one];
  } else {
    adaptations = await experience.adaptations({ limit: size, includeRetired: true });
  }

  const planRead = await plans.load();
  const planMap = planRead.plans instanceof Map
    ? planRead.plans
    : new Map((planRead.plans ?? []).map((p) => [p.id, p]));
  const audit = await operations.inspect();
  if ((audit.corrupt ?? []).length > 0) {
    throw new StoreError(`the audit log contains ${audit.corrupt.length} corrupt line(s); adaptation effectiveness cannot be established from an incomplete audit history`);
  }
  const records = Array.isArray(audit.records) ? audit.records : [];
  const scanning = scanDisclosures(records);
  const auditView = auditReader(records);

  const outcomeCache = new Map();
  const outcomeOf = async (planId) => {
    if (outcomeCache.has(planId)) return outcomeCache.get(planId);
    const plan = planMap.get(planId) ?? null;
    let outcome;
    if (!plan) {
      outcome = unavailableOutcome('the plan named by the decision is not in the plan store');
    } else {
      try {
        outcome = await derivePlanOutcome(plan, { goals, operations: auditView, knowledge, memory });
      } catch (err) {
        outcome = unavailableOutcome(`the plan's outcome evidence could not be read (${err?.code ?? 'store error'})`);
      }
    }
    outcomeCache.set(planId, outcome);
    return outcome;
  };

  const adaptationRows = [];
  let remaining = MAX_EFFECTIVENESS_USES;
  let totalUses = 0;
  let totalEvaluated = 0;
  for (const adaptation of adaptations.slice(0, MAX_EFFECTIVENESS_ADAPTATIONS)) {
    const currentVersion = adaptation.shapeVersion ?? null;
    const rawUses = [];
    for (const disclosure of scanning.decisions) {
      const use = evaluateUse({
        adaptation,
        disclosure,
        plan: disclosure.planId ? (planMap.get(disclosure.planId) ?? null) : null,
        currentVersion,
      });
      if (!use) continue;
      use.outcome = use.planId ? await outcomeOf(use.planId) : unavailableOutcome(use.why);
      use.staleVersion = use.attribution === 'stale_rule_version';
      use.counterfactual = counterfactualOf(use);
      rawUses.push(use);
    }
    const deduped = dedupeUses(rawUses);
    const sorted = deduped.uses
      .sort((a, b) => String(b.decidedAt ?? '').localeCompare(String(a.decidedAt ?? '')));
    const kept = [];
    for (const use of sorted) {
      if (kept.length >= MAX_USES_PER_ADAPTATION || remaining <= 0) break;
      kept.push(use);
      remaining -= 1;
    }
    totalUses += kept.length;
    totalEvaluated += kept.filter((u) => u.outcome?.state === 'evaluated').length;

    const versions = [...new Set(kept.map((u) => (u.ruleVersion === null ? 'unrecorded' : String(u.ruleVersion))))]
      .map((version) => summarize({
        adaptation,
        version,
        uses: kept.filter((u) => (u.ruleVersion === null ? 'unrecorded' : String(u.ruleVersion)) === version),
        current: version === (currentVersion === null ? 'unrecorded' : String(currentVersion)),
      }))
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
      });
    const currentVersionKey = currentVersion === null ? 'unrecorded' : String(currentVersion);
    const currentUses = kept.filter((u) => !u.staleVersion);
    const summary = versions.find((v) => v.version === currentVersionKey)
      ?? { version: currentVersionKey, current: true, observations: { uses: 0, evaluated: 0, adapted: 0, baseline: 0, pending: 0, excluded: 0 }, outcomeCounts: countKinds([]), adaptedOutcomeCounts: countKinds([]), baselineOutcomeCounts: countKinds([]), kind: 'insufficient_evidence', statement: SUMMARY_TEXT.insufficient_evidence, recommendation: recommendationFor('insufficient_evidence') };
    const classification = classify({ adaptation, uses: currentUses, allUses: kept, summary });

    adaptationRows.push({
      id: adaptation.id,
      capability: adaptation.capability,
      rule: adaptation.rule,
      ruleHash: adaptation.ruleHash ?? null,
      source: adaptation.source ?? 'feedback',
      basis: adaptation.basis ?? null,
      decisionState: adaptation.decisionState,
      active: adaptation.active === true,
      retired: adaptation.retired === true,
      supportState: adaptation.supportState ?? null,
      supportProblems: [...(adaptation.supportProblems ?? [])],
      decision: adaptation.decision ? { decision: adaptation.decision.decision, at: adaptation.decision.createdAt ?? null, reason: adaptation.decision.reason ?? null } : null,
      retirement: adaptation.retirement ? { at: adaptation.retirement.createdAt ?? null, reason: adaptation.retirement.reason ?? null } : null,
      shape: adaptation.guidance ? {
        id: adaptation.guidance.id ?? null,
        order: adaptation.guidance.order ?? null,
        avoid: [...(adaptation.guidance.avoid ?? [])],
        prefer: [...(adaptation.guidance.prefer ?? [])],
        maxSteps: adaptation.guidance.maxSteps ?? null,
        source: adaptation.guidance.source ?? null,
      } : null,
      version: currentVersion,
      classification,
      versions,
      summary,
      recommendation: summary.recommendation,
      lifecycle: {
        approved: adaptation.decisionState === 'approved' || adaptation.decisionState === 'retired',
        applied: kept.some((u) => u.applied === true && !u.staleVersion),
        executed: kept.some((u) => u.planId && u.outcome?.taskId !== null),
        evaluated: kept.some((u) => u.outcome?.state === 'evaluated'),
        retired: adaptation.retired === true,
      },
      uses: kept.slice(0, MAX_SAMPLES).map(useRow),
      usesTruncated: kept.length > MAX_SAMPLES,
      readings: {
        decisionsScanned: scanning.decisions.length,
        usesRead: sorted.length,
        usesKept: kept.length,
        duplicatesSuppressed: deduped.duplicates,
        excluded: kept.filter((u) => !ADAPTED_ATTRIBUTIONS.has(u.attribution) && !BASELINE_ATTRIBUTIONS.has(u.attribution)).length,
      },
    });
  }

  const classificationCounts = {};
  for (const state of EFFECTIVENESS_STATES) classificationCounts[state] = 0;
  for (const row of adaptationRows) classificationCounts[row.classification.state] = (classificationCounts[row.classification.state] ?? 0) + 1;

  const report = {
    schema: EFFECTIVENESS_SCHEMA,
    available: true,
    reason: adaptations.length === 0 ? 'no adaptation record is stored' : null,
    generatedAt,
    scope,
    reads: {
      adaptationsRead: adaptationRows.length,
      plansRead: planMap.size,
      auditRecords: records.length,
      auditRecordsScanned: scanning.inspected,
      auditTruncated: scanning.truncated,
      disclosures: scanning.decisions.length,
      unlinkedWrites: scanning.unlinkedWrites,
    },
    adaptations: adaptationRows,
    totals: {
      adaptations: adaptationRows.length,
      uses: totalUses,
      evaluated: totalEvaluated,
      classifications: classificationCounts,
      truncatedUses: totalUses >= MAX_EFFECTIVENESS_USES,
    },
    limitations: [...LIMITATIONS],
    authorizes: false,
    note: EFFECTIVENESS_NOTE,
  };
  report.digest = digestOf({ ...report, generatedAt: null, digest: null });
  return report;
}

export function renderEffectiveness(report, { indent = '' } = {}) {
  if (!report) return `${indent}No adaptation-effectiveness report was produced.`;
  if (report.available === false) {
    return `${indent}Adaptation effectiveness unavailable: ${report.reason}`;
  }
  const lines = [
    `${indent}Adaptation effectiveness (${report.totals.adaptations} record(s) read; ${report.totals.uses} use(s), ${report.totals.evaluated} evaluated):`,
  ];
  if (report.adaptations.length === 0) {
    lines.push(`${indent}  ${report.reason ?? 'no adaptation record is stored, so there is nothing to evaluate'}`);
  }
  for (const row of report.adaptations) {
    const state = row.classification?.state ?? 'unknown';
    lines.push(`${indent}  [${shortId(row.id)}] ${row.capability} | ${row.decisionState}${row.retired ? ', retired' : ''} | ${state}`);
    lines.push(`${indent}    rule: ${singleLine(row.rule, 200)}`);
    lines.push(`${indent}    support: ${row.supportState ?? 'not recorded'}; version: ${row.version ?? 'none'}; active: ${row.active ? 'yes' : 'no'}`);
    lines.push(`${indent}    why: ${singleLine(row.classification?.why ?? '', 300)}`);
    const obs = row.summary?.observations ?? {};
    lines.push(`${indent}    uses: ${row.readings?.usesRead ?? 0} read (${obs.evaluated ?? 0} evaluated; ${obs.adapted ?? 0} adapted, ${obs.baseline ?? 0} unadapted, ${obs.pending ?? 0} pending, ${obs.excluded ?? 0} excluded)`);
    if (row.summary) {
      lines.push(`${indent}    version ${row.summary.version}: ${row.summary.kind} - ${singleLine(row.summary.statement, 320)}`);
    }
    if (row.recommendation) {
      lines.push(`${indent}    recommendation: ${row.recommendation.kind} - ${singleLine(row.recommendation.why, 300)} (it authorizes nothing; retirement is \`adaptation.retire\`)`);
    }
    for (const use of (row.uses ?? []).slice(0, MAX_RENDERED_USES)) {
      const outcome = use.outcome ?? {};
      lines.push(`${indent}    use [${shortId(use.operationId)}] ${use.attribution}${use.planId ? ` -> plan [${shortId(use.planId)}]` : ''}`);
      lines.push(`${indent}      ${singleLine(use.why, 300)}`);
      lines.push(`${indent}      outcome: ${outcome.state ?? 'unavailable'}${outcome.kind ? ` (${outcome.kind})` : ''}${outcome.reason ? ` - ${singleLine(outcome.reason, 260)}` : ''}`);
      if (use.counterfactual) lines.push(`${indent}      without it: ${singleLine(use.counterfactual.statement, 300)}`);
    }
    if ((row.uses?.length ?? 0) > MAX_RENDERED_USES) {
      lines.push(`${indent}    ... ${(row.uses?.length ?? 0) - MAX_RENDERED_USES} more use(s) omitted from this printed view`);
    }
  }
  lines.push(`${indent}  ${report.note}`);
  return lines.join('\n');
}
