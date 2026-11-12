// Candidate plan evaluation: comparing approaches without pretending to know their odds.
//
// APEX can say what each candidate does - which recorded criteria it settles, which capabilities it
// needs, whether it changes a store, what its own validation found. It cannot say how likely a plan
// is to succeed: nothing in the records measures the future. So this module ranks nothing by a
// composite number. It applies hard gates first (a candidate whose step cannot run is excluded and
// says why, rather than being marked down), then compares the remaining candidates dimension by
// dimension on facts each one actually records.
//
// Ordering is a Pareto comparison over a short, named, disclosed list of dimensions: a candidate
// comes before another only where it is at least as good on every ranked dimension and strictly
// better on one. Where two candidates each lead on some dimension, both stay on the list and the
// trade-off is reported as unresolved, naming the dimensions that pull in opposite directions. That
// is the honest answer more often than a single ranking: an approach that records nothing settles
// less, and an approach that settles more writes to a store. The reader's own priorities decide
// which of those they prefer, and APEX does not have a preference it can justify as fact.
//
// Nothing here is a permission. The evaluation reads candidates and reports bands; recording a
// candidate is still `plan.add`, approval is still `plan.approve` bound to the exact content bytes,
// and execution is still the existing task runner. The evaluation is bound to the digests of the
// candidates it looked at, so a candidate that changed afterwards is disclosed as unassessed rather
// than quietly compared against stale bytes.
import { dependencyProblems, stableStringify, StepStatus } from '../tasks/model.js';
import { shortId, singleLine } from '../util.js';
import { Requirement, requirementOf } from '../goals/model.js';
import { constraintFinding, constraintLedger } from './constraints.js';
import { emptyGuidance, guidanceDeclinedReason } from './guidance.js';
import { outcomesAudit } from './outcomes.js';
import {
  MAX_ASSERTIONS, MAX_PLAN_STEPS, MAX_PRECONDITIONS, MAX_PRECONDITION_CHARS, RISK_ORDER,
  validatePlanContent,
} from './model.js';

export const EVALUATION_NOTE = 'an evaluation compares what each candidate records; it is not a prediction, a probability, or an approval, and it starts nothing';

// The one decision dimension an approved adaptation is allowed to move. Naming it here is what lets the
// comparison compute the same ranking without it, so the reader can see the decision the records of the
// work alone would have produced beside the decision the user's approved guidance produced.
export const ADAPTATION_DECISION_DIMENSION = 'approved_adaptation_fit';
export const ADAPTATION_DECISION_SCHEMA = 'apex.adaptation-decision.v1';
export const ADAPTATION_DECISION_NOTE = 'the recorded guidance moved at most which candidate leads a comparison of approaches that passed every gate; it recorded no plan, approved no plan, authorized no step, and started nothing';
const MAX_DECISION_EVIDENCE = 20;

// The dimensions the ordering uses, in the order they are named to the reader. Every one of them is
// a recorded count or a recorded class, not a weight: the list is disclosed so the reader can see
// exactly what was compared and can disagree with it knowingly.
//
// Batch AM added two of them. `verification_quality` is the registry's own fact - which of these
// steps will be re-checked by an action that carries its own verifier - and `recorded_outcome_history`
// is the count of steps naming a capability whose recorded outcome the caller actually handed this
// comparison. Both are counts of records, never a rate, a probability, or a forecast: a capability
// that failed once is not claimed to fail again, and a capability nobody has run is not claimed to be
// risky. A dimension whose records were not read reports `value: null` and separates nothing, because
// an unread store is not an empty one.
export const RANKED_DIMENSIONS = Object.freeze([
  'criterion_coverage',
  'uncertainty',
  'step_risk',
  'reversibility',
  'resource_requirements',
  'verification_quality',
  'recorded_outcome_history',
  'approved_adaptation_fit',
]);

// Dimensions that are reported for every candidate but do not move the ranking, because there is no
// honest way to trade one against another: they are context for the user's decision, not inputs to a
// formula. Each names, in its own band, why it stays here.
export const DISCLOSED_DIMENSIONS = Object.freeze([
  'goal_alignment',
  'evidence_sufficiency',
  'dependency_validity',
  'capability_availability',
  'expected_verification_quality',
  'known_blockers',
]);

// Hard facts are gates, not dimensions: a candidate that cannot run is excluded rather than marked
// down, and no ranked count can outweigh one. The list is what the rule text points at.
export const GATES = Object.freeze([
  'candidate_validation',
  'dependency_structure',
  'capability_available_now',
  'constraints_satisfied',
  'plan_bounds',
  'goal_still_open',
]);

// The rule, in the words the reader is shown. It is not hidden behind a number.
export const EVALUATION_RULE = `Hard gates first: a candidate that fails any gate is excluded and names why - `
  + `${GATES.join(', ')} are facts about whether the work can run at all, and no ranked count outweighs one. `
  + `Then ${RANKED_DIMENSIONS.join(', ')} are compared as recorded, and a candidate ranks above another `
  + `only where it is at least as good on all of them and strictly better on at least one. `
  + `Candidates that lead on different dimensions are both kept and the trade-off is reported as unresolved. `
  + `A dimension whose records were not read ranks nothing. `
  + `No score, weight, or probability is computed, because none of the records supports one.`;

function openRequiredCriteria(goal) {
  return (goal?.criteria ?? [])
    .filter((c) => c.status !== 'satisfied' && requirementOf(c) !== Requirement.DECLINED)
    .filter((c) => requirementOf(c) === Requirement.REQUIRED)
    .map((c) => c.id);
}

function openSuggestedCriteria(goal) {
  return (goal?.criteria ?? [])
    .filter((c) => c.status !== 'satisfied' && requirementOf(c) !== Requirement.DECLINED)
    .filter((c) => requirementOf(c) === Requirement.SUGGESTED)
    .map((c) => c.id);
}

// ---- gates ------------------------------------------------------------------
// A gate is a fact that makes a candidate un-runnable rather than merely less preferable, so it
// removes the candidate and says what is wrong. Each gate re-reads the candidate's own steps: a
// gate that trusted the candidate's self-report would not be a check.

function gateCandidateValidation(candidate, { registry }) {
  const checked = validatePlanContent(candidate.content);
  return checked.length > 0
    ? { passed: false, detail: checked.join('; ') }
    : candidate.validation.ok === true
      ? { passed: true, detail: `the generator's own read-only validation passed; ${candidate.steps} step(s) against a registry of ${registry.names().length} action(s)` }
      : { passed: false, detail: (candidate.validation.problems ?? []).join('; ') || 'the generator reported a problem without naming it' };
}

function gateDependencyStructure(candidate) {
  const problems = dependencyProblems(candidate.content.steps);
  return problems.length === 0
    ? { passed: true, detail: 'each step depends only on steps before it, and the ids are unique' }
    : { passed: false, detail: problems.join('; ') };
}

// A step is runnable now only if the live registry holds it, allows it in a plan, authorizes it for
// the user who would run the plan, and is not named by the evidence as unavailable in this generation.
function gateCapabilityAvailable(candidate, { registry, unavailable }) {
  const missing = [];
  for (const s of candidate.content.steps) {
    const def = registry.get(s.action);
    if (!def) missing.push(`${s.id}: ${s.action} is not registered in this configuration`);
    else if (def.plannable === false) missing.push(`${s.id}: ${s.action} cannot be part of a plan`);
    else if (unavailable.has(s.action)) missing.push(`${s.id}: ${s.action} is recorded as unavailable, so this generation does not offer it`);
    else {
      const auth = registry.authorize(def.name, 'user');
      if (auth.decision !== 'allow') missing.push(`${s.id}: ${s.action} is not permitted (${auth.reason})`);
    }
  }
  return missing.length === 0
    ? { passed: true, detail: 'every step names a registered, plannable capability this configuration authorizes' }
    : { passed: false, detail: missing.join('; ') };
}

// A constraint the goal record establishes and this approach walks into is not a drawback to be
// marked down: the work is refused until something clears it. The gate re-reads the candidate's own
// steps, because a precondition line saying a blocker exists is not the same thing as a plan that
// avoids it - which is precisely what this batch found missing before.
function gateConstraints(candidate, { constraints }) {
  const finding = candidateConstraintFinding(candidate, { constraints });
  return { passed: finding.passed, detail: finding.detail, finding };
}

// The same finding, computed once per candidate and reused by the gate and the disclosure, so the
// exclusion and the explanation cannot disagree about what the records say.
function candidateConstraintFinding(candidate, { constraints }) {
  return constraintFinding(constraints, { steps: candidate.content.steps, strategy: candidate.strategy });
}

// The bounds a plan record can hold, re-measured here rather than trusted from the generator: a
// candidate that could not be stored as a plan could not be approved either, and that is a gate, not
// a drawback.
function gatePlanBounds(candidate) {
  const content = candidate.content;
  const problems = [];
  if (!Array.isArray(content.steps) || content.steps.length === 0) problems.push('a plan needs at least one step');
  if ((content.steps?.length ?? 0) > MAX_PLAN_STEPS) problems.push(`a plan may have at most ${MAX_PLAN_STEPS} steps`);
  if ((content.preconditions?.length ?? 0) > MAX_PRECONDITIONS) problems.push(`a plan may state at most ${MAX_PRECONDITIONS} preconditions`);
  if ((content.assertions?.length ?? 0) > MAX_ASSERTIONS) problems.push(`a plan may classify at most ${MAX_ASSERTIONS} assertions`);
  return problems.length === 0
    ? { passed: true, detail: `within the ${MAX_PLAN_STEPS}-step, ${MAX_PRECONDITIONS}-precondition and ${MAX_ASSERTIONS}-assertion bounds` }
    : { passed: false, detail: problems.join('; ') };
}

// A candidate generated against a goal that has since been completed, cancelled or superseded is a
// statement about an intention that no longer stands. Re-checked against the goal as it is now.
//
// A completed goal whose recorded proof has since been withdrawn is a different finding, and the gate
// says which one it is: the record still closes this generation, and what settles it is the user's own
// reopen, not a candidate that quietly treats the goal as if it were open. Where nobody re-read the
// evidence, the gate says that too rather than implying it was checked.
function gateGoalStillOpen(candidate, { goal, goalEvidence }) {
  if (!goal || !goal.id) return { passed: false, detail: 'no recorded goal is available, so nothing can be checked against it' };
  if (candidate.content.goalId !== goal.id) {
    return { passed: false, detail: `the candidate is for goal ${singleLine(String(candidate.content.goalId ?? 'none'), 24)}, not ${singleLine(goal.id, 24)}` };
  }
  if (['completed', 'failed', 'cancelled', 'superseded', 'abandoned'].includes(goal.status)) {
    if (goal.status === 'completed' && goalEvidence && goalEvidence.holds === false) {
      return {
        passed: false,
        detail: `the goal is completed on record, ${goalEvidence.detail.replace(/^the goal is recorded as completed, /, '')}; it stays closed until the user reopens it, and no candidate reopens it`,
      };
    }
    const unchecked = goal.status === 'completed' && (!goalEvidence || goalEvidence.holds === null)
      ? ` (${goalEvidence?.detail ?? 'the completion evidence was not re-read by this comparison'})`
      : '';
    return { passed: false, detail: `the goal is ${goal.status}, so this candidate plans work that is no longer open${unchecked}` };
  }
  return { passed: true, detail: `the goal is ${goal.status}, and the candidate is bound to goal revision ${goal.revision}` };
}

// ---- ranked dimensions ------------------------------------------------------
// Each returns the band name plus the recorded facts behind it. `value` is the comparable quantity;
// a dimension that cannot be compared honestly returns `value: null` and is disclosed, not ranked.
function dimensionCoverage(candidate, { requiredOpen }) {
  if (requiredOpen.length === 0) {
    return { band: 'the goal records no open required criterion, so nothing is compared here', value: null };
  }
  const settled = candidate.criteriaCovered.filter((id) => requiredOpen.includes(id));
  const rest = requiredOpen.filter((id) => !settled.includes(id));
  if (settled.length === requiredOpen.length) {
    return { band: `settles all ${requiredOpen.length} open required criteria (${settled.join(', ')})`, value: settled.length };
  }
  return {
    band: `settles ${settled.length} of the ${requiredOpen.length} open required criteria${rest.length ? `; ${rest.join(', ')} is not settled by this approach` : ''}`,
    value: settled.length,
  };
}

function dimensionUncertainty(candidate, { requiredOpen }) {
  const unsettled = [...new Set([
    ...candidate.criteriaLeftUnaddressed,
    ...candidate.criteriaAssumedFromTheGoalRequest,
    ...candidate.stepsBeyondThePlanBound,
  ])].filter((id) => requiredOpen.includes(id));
  if (unsettled.length === 0) {
    return { band: 'no required criterion is left unmatched, unaddressed, or outside the plan bound', value: 0 };
  }
  return {
    band: `${unsettled.join(', ')} is taken on without a step that settles it from its own words`,
    value: unsettled.length,
    invert: true,
  };
}

function dimensionRisk(candidate) {
  const order = RISK_ORDER[candidate.risk] ?? RISK_ORDER.high;
  const writes = candidate.content.steps.filter((s) => s.risk === 'high').map((s) => s.id);
  return {
    band: `highest recorded step risk ${candidate.risk}${writes.length ? `; high-risk steps ${writes.join(', ')}` : ''}`,
    value: -order,
  };
}

function dimensionReversibility(candidate, { registry }) {
  const writes = candidate.content.steps.filter((s) => registry.get(s.action)?.permission === 'write');
  if (writes.length === 0) {
    return { band: 'changes no APEX store: every step is a read', value: 2 };
  }
  const hard = writes.filter((s) => s.reversibility === 'not_reversible' || s.reversibility === 'unknown' || !s.reversibility);
  if (hard.length > 0) {
    return { band: `${hard.map((s) => s.id).join(', ')} cannot be taken back, or APEX cannot say how far`, value: 0 };
  }
  return { band: `appends ${writes.length} record(s); a later record corrects what was written, nothing erases it`, value: 1 };
}

// Resources are recorded as the two counts that actually cost something here: how many steps run, and
// how many of them write. Fewer of each costs less, so this is the one dimension read the other way.
// They are compared lexicographically rather than summed, because a write and a read are not the same
// expense and adding them would invent an exchange rate between them.
function dimensionResources(candidate) {
  return {
    band: `${candidate.steps} step(s), ${candidate.writes} of them a write${Number.isInteger(candidate.estimatedSeconds) ? `; ${candidate.estimatedSeconds}s of recorded durations` : '; no recorded duration, so no effort estimate'}`,
    value: [candidate.writes, candidate.steps],
    invert: true,
    tuple: true,
  };
}

// Verification quality is a registry fact, not an opinion about the approach: the step is re-checked
// only if the action it names carries its own verifier, and the registry is read again here rather
// than trusted from the candidate. What is compared is the number of steps left *without* one, because
// counting the verified steps would simply reward a candidate for being long: zero is reachable by the
// lean approach and the thorough one alike, and only a step whose action cannot check itself is the
// drawback. The goal's own recorded evidence conditions stay disclosed, because "this criterion asks
// for evidence" is not a quantity to trade against a count.
function dimensionVerification(candidate, { registry }) {
  const lacking = candidate.content.steps
    .filter((s) => typeof registry.get(s.action)?.verify !== 'function')
    .map((s) => s.id);
  return {
    band: lacking.length === 0
      ? `no step is left without its action's own verifier (${candidate.steps} step(s), each re-checked independently)`
      : `${lacking.join(', ')} names an action with no independent verifier, so its completion rests on the action returning`,
    value: lacking.length,
    invert: true,
  };
}

// What past runs of these very capabilities left on record, as the caller handed it. The quantity is
// the number of distinct capabilities this approach uses that the records hold a failed or uncertain
// step outcome for - one record of one past attempt, which says what happened then and nothing about
// what will happen now. When no outcome records were handed at all the dimension reports that and
// ranks nothing: an unread record list is not a clean one, and treating it as one would hand a
// preference to whichever candidate the records simply were not read for.
function dimensionOutcomeHistory(candidate, { outcomes }) {
  if (!outcomes || outcomes.read !== true) {
    return {
      band: 'no recorded step outcome was handed to this comparison, so what past runs did ranks nothing',
      value: null,
    };
  }
  const named = new Map((outcomes.records ?? []).filter((r) => r?.capability).map((r) => [r.capability, r]));
  const hits = candidate.content.steps.filter((s) => named.has(s.action));
  const bound = outcomes.truncated === true
    ? '; the read is bounded, so a capability further back in the records is not named here'
    : '';
  if (hits.length === 0) {
    return {
      band: named.size === 0
        ? `nothing on the ${outcomes.plans ?? 0} recorded plan(s) for this goal ended failed or uncertain${bound}`
        : `no step here names ${[...named.keys()].sort().join(', ')}, the capability or capabilities the records hold an outcome for${bound}`,
      value: 0,
      invert: true,
    };
  }
  const which = hits.map((s) => {
    const r = named.get(s.action);
    return `${s.id} (${s.action}${r.status === StepStatus.UNCERTAIN ? ', uncertain' : ', failed'}${r.operationId ? `, operation ${shortId(r.operationId)}` : ''})`;
  });
  return {
    band: `${which.join(', ')} name a capability the handed records hold a failed or uncertain outcome for - what happened once, not a claim about this run${bound}`,
    // Distinct capabilities, not steps: a candidate that uses the same troubled capability twice is
    // exposed to one recorded history, not two, and counting steps would let length decide this.
    value: new Set(hits.map((s) => s.action)).size,
    invert: true,
  };
}

// The one dimension Batch AM added to the ordering rather than to the disclosure list: what the user's
// own approved guidance asks of these steps. It is a count of recorded requirements the candidate does
// not meet, read the low-is-good way, and it is `null` whenever nothing checkable applies - which is the
// common case, and the case where the comparison must go on ranking the recorded work alone. The rows
// beside it name which record asked for what, so an influence can be argued with.
function dimensionGuidance(candidate, { guidance }) {
  const row = (guidance?.candidates ?? []).find((r) => r.strategy === candidate.strategy) ?? null;
  if (!row || row.value === null) {
    return {
      band: row?.band
        ?? (guidance && (guidance.applicable ?? []).length > 0
          ? 'the guidance on record names no requirement this candidate can answer'
          : 'no approved, applicable guidance record bears on these capabilities'),
      value: null,
    };
  }
  return { band: row.band, value: row.value, invert: true };
}

// ---- disclosed dimensions ---------------------------------------------------

function disclosedAlignment(candidate, { requiredOpen, suggestedOpen }) {
  const leftOut = candidate.criteriaLeftOutOfThisApproach.filter((id) => requiredOpen.includes(id));
  const suggestedLeft = candidate.criteriaLeftOutOfThisApproach.filter((id) => suggestedOpen.includes(id));
  const parts = [];
  if (leftOut.length > 0) parts.push(`leaves required ${leftOut.join(', ')} out of the approach`);
  if (suggestedLeft.length > 0) parts.push(`leaves the APEX suggestion ${suggestedLeft.join(', ')} out of the approach`);
  return { band: `${parts.length ? parts.join('; ') : 'takes on every open criterion its approach covers'}; not ranked, because what the approach settles is already counted by criterion_coverage` };
}

function disclosedEvidence(candidate) {
  const kinds = new Map();
  for (const a of candidate.content.assertions) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  const unsettled = (kinds.get('inference') ?? 0) + (kinds.get('unknown') ?? 0);
  const established = candidate.content.assertions
    .filter((a) => ['user_fact', 'stored_knowledge', 'retrieved_evidence', 'world_fact', 'world_entity'].includes(a.kind))
    .map((a) => a.kind);
  return {
    band: `${established.length} established assertion(s)${established.length ? ` (${[...new Set(established)].join(', ')})` : ''}; ${unsettled} inference or unknown; `
      + 'not ranked, because an assertion\'s kind is what the candidate claims about itself, and a count of self-claims would reward the candidate that claims most',
    kinds: Object.fromEntries([...kinds.entries()].sort()),
  };
}

function disclosedDependencies(candidate) {
  const problems = dependencyProblems(candidate.content.steps);
  return {
    band: `${problems.length === 0 ? 'each step lists the step before it, as the sequential runner works' : problems.join('; ')}; `
      + 'not ranked, because a dependency structure that is wrong is a gate and one that is right leaves nothing to compare',
  };
}

// The registry answers this, not the candidate: what a step needs is the action it names, and whether
// that action can check itself is something only the live registry knows. A candidate's own claim about
// its verifiers is a claim, and printing it as a fact would let an approach describe itself as safer
// than the registry says it is.
function disclosedCapabilities(candidate, { registry }) {
  const parts = candidate.content.steps.map((s) => {
    const def = registry.get(s.action);
    const permission = def?.permission ?? 'unregistered';
    return `${s.action} (${permission}${typeof def?.verify === 'function' ? ', has its own verifier' : ', no verifier'})`;
  });
  return {
    band: `${parts.join(', ')}; `
      + 'not ranked, because a capability the registry refuses is a gate, not a drawback, and the verifier count is already ranked',
  };
}

// Verification quality is the registry's, not APEX's opinion: a step is verifiable when the action it
// names carries its own independent verifier, and the goal's own required-evidence condition is part
// of the check only when the step records it.
function disclosedVerification(candidate, { registry, goal }) {
  const noVerifier = candidate.content.steps.filter((s) => typeof registry.get(s.action)?.verify !== 'function').map((s) => s.id);
  const wanted = (goal?.criteria ?? [])
    .filter((c) => typeof c.requiredEvidence === 'string' && c.requiredEvidence.trim().length > 0)
    .map((c) => c.id);
  const carried = candidate.content.steps
    .filter((s) => s.criterionId && wanted.includes(s.criterionId) && s.verification.includes('; and '))
    .map((s) => s.criterionId);
  const missing = wanted.filter((id) => !carried.includes(id));
  return {
    band: `${noVerifier.length > 0
      ? `no independent verifier for ${noVerifier.join(', ')}`
      : `every step is re-checked by its own action's verifier${wanted.length ? `; the goal's recorded evidence condition is carried for ${carried.join(', ') || 'no criterion'}${missing.length ? ` and not for ${missing.join(', ')}, which has no step of its own here` : ''}` : ''}`}; `
      + 'the verifier count is ranked as verification_quality; the evidence conditions are reported here, because asking for evidence is not a quantity to trade against a count',
  };
}

// What the records say stands in the way, and what any of it does to this approach. The classes are
// printed because they mean different things: one stops the work, one is evidence about an obstacle,
// one is an obstacle whose record has gone. A candidate's own precondition text is not trusted here -
// the ledger and the steps are read again.
function disclosedBlockers(candidate, { constraints, finding }) {
  const counts = new Map();
  for (const c of constraints?.constraints ?? []) counts.set(c.class, (counts.get(c.class) ?? 0) + 1);
  const on = [...counts.entries()].sort().map(([cls, n]) => `${n} ${cls}`).join(', ');
  if (!on) {
    return { band: 'no blocker, prerequisite, dependency, or evidence condition is recorded on this goal for the comparison to answer; nothing here is ranked, because a record that stops work is a gate and one that does not is context' };
  }
  const parts = [`${on} on record`];
  if (finding.blockedBy.length > 0) {
    parts.push(`this approach is stopped by ${finding.blockedBy.map((b) => `${b.class} ${b.id} at ${b.steps.join(', ')}`).join('; ')}`);
  } else if (finding.notApplicable.length > 0) {
    parts.push(`${finding.notApplicable.map((b) => `${b.id} (${b.capability})`).join(', ')} name a capability no step here uses`);
  } else {
    parts.push('nothing on the record stops this approach');
  }
  const carried = candidate.content.preconditions.filter((p) => (constraints?.constraints ?? [])
    .some((c) => c.field === 'blockers' || c.field === 'prerequisites' ? p.includes(c.text) : false));
  const stated = (constraints?.constraints ?? []).filter((c) => c.field === 'blockers' || c.field === 'prerequisites').length;
  if (stated > 0) {
    parts.push(`stated in its own preconditions: ${carried.length} of the ${stated} recorded obstacle(s) or condition(s)`);
  }
  return { band: `${parts.join('; ')}; reported, not ranked - a record that stops this approach has already stopped it at the gate` };
}

// ---- comparison -------------------------------------------------------------

// 1 when `a` is strictly better, -1 when `b` is, 0 when they cannot be separated on this dimension.
function compareDimension(left, right) {
  if (left.value === null || right.value === null) return 0;
  if (left.tuple) {
    for (let i = 0; i < left.value.length; i += 1) {
      const x = left.value[i];
      const y = right.value[i];
      if (x === y) continue;
      const better = left.invert ? x < y : x > y;
      return better ? 1 : -1;
    }
    return 0;
  }
  if (left.value === right.value) return 0;
  const better = left.invert ? left.value < right.value : left.value > right.value;
  return better ? 1 : -1;
}

function assess(candidate, context) {
  const ranked = {};
  ranked.criterion_coverage = dimensionCoverage(candidate, context);
  ranked.uncertainty = dimensionUncertainty(candidate, context);
  ranked.step_risk = dimensionRisk(candidate);
  ranked.reversibility = dimensionReversibility(candidate, context);
  ranked.resource_requirements = dimensionResources(candidate);
  ranked.verification_quality = dimensionVerification(candidate, context);
  ranked.recorded_outcome_history = dimensionOutcomeHistory(candidate, context);
  ranked.approved_adaptation_fit = dimensionGuidance(candidate, context);
  const disclosed = {};
  disclosed.goal_alignment = disclosedAlignment(candidate, context);
  disclosed.evidence_sufficiency = disclosedEvidence(candidate, context);
  disclosed.dependency_validity = disclosedDependencies(candidate);
  disclosed.capability_availability = disclosedCapabilities(candidate, context);
  disclosed.expected_verification_quality = disclosedVerification(candidate, context);
  disclosed.known_blockers = disclosedBlockers(candidate, context);
  return { ranked, disclosed };
}

// Pareto: `a` dominates `b` when it is at least as good on every ranked dimension and better on one.
// Anything no other candidate dominates is on the front, and every member of the front is reported -
// reducing a genuine trade-off to one winner is the false precision this avoids. `dimensions` is a
// parameter only so the same rule can be applied to the same candidate bytes without one dimension, which
// is how the adaptation decision's counterfactual is computed. There is one rule then, not two.
function dominance(rows, dimensions = RANKED_DIMENSIONS) {
  const wins = new Map(rows.map((r) => [r.strategy, []]));
  const losses = new Map(rows.map((r) => [r.strategy, []]));
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue;
      let better = 0;
      let worse = 0;
      const dims = [];
      for (const name of dimensions) {
        const c = compareDimension(a.assessed.ranked[name], b.assessed.ranked[name]);
        if (c > 0) { better += 1; dims.push(name); } else if (c < 0) worse += 1;
      }
      if (better > 0 && worse === 0) {
        wins.get(a.strategy).push({ over: b.strategy, on: dims });
        losses.get(b.strategy).push({ under: a.strategy, on: dims });
      }
    }
  }
  return { wins, losses };
}

function frontUnder(rows, dimensions) {
  const { losses } = dominance(rows, dimensions);
  return rows.filter((r) => losses.get(r.strategy).length === 0).map((r) => r.strategy);
}

// What the approved guidance did to the decision, stated as the decision it would have been without it.
// Both sides are the same rule over the same candidate bytes; the only difference is whether the one
// dimension a recorded guidance shape feeds is on the table. Nothing here adds a ranking, a score, or a
// reason the records do not state: `declinedReason` is the ledger's own state, and the candidate bytes
// are bound elsewhere in the evaluation.
function adaptationDecisionOf({ guidance, included, front }) {
  const baseline = frontUnder(included, RANKED_DIMENSIONS.filter((d) => d !== ADAPTATION_DECISION_DIMENSION));
  const adapted = front.map((r) => r.strategy);
  const before = { leading: baseline.length === 1 ? baseline[0] : null, front: baseline };
  const after = { leading: adapted.length === 1 ? adapted[0] : null, front: adapted };
  const applied = guidance?.influencesSelection === true;
  const changed = stableStringify(before) !== stableStringify(after);
  const applicable = new Set(guidance?.applicable ?? []);
  const rules = (guidance?.records ?? [])
    .filter((r) => applicable.has(r.id))
    .map((r) => ({
      id: r.id,
      capability: r.capability,
      version: r.version ?? null,
      ruleHash: r.ruleHash ?? null,
      // Which ledger produced the rule, kept on the rule rather than summarised away: two records can
      // score the same dimension from different evidence, and the reader is entitled to see which.
      source: r.source ?? 'feedback',
      method: r.method ?? null,
      // Whether the rule rests on one recorded evaluation, a supported longitudinal pattern, or repeated
      // user feedback, kept on the rule so a reader need not re-read the ledger. A pattern is an order in
      // recorded outcomes, not a cause and not a forecast.
      basis: r.basis ?? null,
      pattern: r.pattern ? { ...r.pattern } : null,
      support: {
        experienceIds: [...(r.support?.experienceIds ?? [])],
        feedbackIds: [...(r.support?.feedbackIds ?? [])],
        predictionIds: [...(r.support?.predictionIds ?? [])],
        evaluationIds: [...(r.support?.evaluationIds ?? [])],
      },
      predictionEvidence: r.predictionEvidence ? { ...r.predictionEvidence } : null,
    }));
  const experienceIds = [...new Set(rules.flatMap((r) => r.support.experienceIds))];
  const feedbackIds = [...new Set(rules.flatMap((r) => r.support.feedbackIds))];
  const predictionIds = [...new Set(rules.flatMap((r) => r.support.predictionIds))];
  const evaluationIds = [...new Set(rules.flatMap((r) => r.support.evaluationIds))];
  // The five distinctions Batch AP2 owes the reader, derived from the ledger's own record states rather
  // than from a second read: feedback-derived, prediction-derived, both kinds applicable, prediction
  // evidence considered but not usable, and no prediction record at all.
  const sourceLedger = guidance?.sources ?? null;
  const predictionEvidence = !sourceLedger || sourceLedger.predictionConsidered === 0
    ? 'none'
    : sourceLedger.predictionDerived.length > 0 && sourceLedger.feedbackDerived.length > 0
      ? 'both'
      : sourceLedger.predictionDerived.length > 0
        ? 'prediction_derived'
        : 'prediction_rejected';
  return {
    schema: ADAPTATION_DECISION_SCHEMA,
    dimension: ADAPTATION_DECISION_DIMENSION,
    applied,
    changed,
    outcome: !applied ? 'declined' : (changed ? 'changed' : 'applied_not_changed'),
    before,
    after,
    rules,
    evidence: {
      experienceIds: experienceIds.slice(0, MAX_DECISION_EVIDENCE),
      feedbackIds: feedbackIds.slice(0, MAX_DECISION_EVIDENCE),
      predictionIds: predictionIds.slice(0, MAX_DECISION_EVIDENCE),
      evaluationIds: evaluationIds.slice(0, MAX_DECISION_EVIDENCE),
      truncated: experienceIds.length > MAX_DECISION_EVIDENCE
        || feedbackIds.length > MAX_DECISION_EVIDENCE
        || predictionIds.length > MAX_DECISION_EVIDENCE
        || evaluationIds.length > MAX_DECISION_EVIDENCE,
    },
    // Which kind of evidence stands behind the one dimension an approved record may move.
    sources: {
      feedbackDerived: [...(sourceLedger?.feedbackDerived ?? [])],
      predictionDerived: [...(sourceLedger?.predictionDerived ?? [])],
      longitudinalDerived: [...(sourceLedger?.longitudinalDerived ?? [])],
      singleEvaluationDerived: [...(sourceLedger?.singleEvaluationDerived ?? [])],
      bothEligible: sourceLedger?.bothEligible === true,
      predictionConsidered: sourceLedger?.predictionConsidered ?? 0,
      predictionRejected: (sourceLedger?.predictionRejected ?? []).map((r) => ({ id: r.id, state: r.state, why: r.why })),
      predictionEvidence,
    },
    // Every record the ledger read, with the state that decided whether it could move anything. The
    // ineligible ones are here for the same reason as the eligible ones: a reader has to be able to see
    // what was excluded and why, not only what was used.
    considered: (guidance?.records ?? []).map((r) => ({
      id: r.id,
      capability: r.capability,
      state: r.state,
      version: r.version ?? null,
      source: r.source ?? 'feedback',
      basis: r.basis ?? null,
      pattern: r.pattern ? { ...r.pattern } : null,
      predictionEvidence: r.predictionEvidence ? { ...r.predictionEvidence } : null,
      why: r.why,
    })),
    declinedReason: applied ? null : guidanceDeclinedReason(guidance),
    digest: guidance?.digest ?? null,
    authorizes: false,
    note: ADAPTATION_DECISION_NOTE,
  };
}

// Evaluate a generated candidate set. `result` is what `candidatesForGoal` or `revisedCandidates`
// returned; `goal` is the goal as it is recorded now, so a stale candidate is caught rather than
// ranked; `evidence` may name actions this generation must not offer and blockers on record;
// `constraints` is the ledger of what the records say stands in the way, and is built from the goal
// when the caller has not handed one; `outcomes` is what the caller read of past runs of these
// capabilities (`src/plans/outcomes.js`) - `null` says nobody read, which ranks nothing.
export function evaluateCandidates({ result, goal, registry, evidence = null, constraints = null, guidance = null, outcomes = null, goalEvidence = null } = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.candidates)) {
    return {
      ok: false,
      reason: 'no-candidates',
      problems: ['nothing was handed to evaluate, so no candidate was generated or given'],
      skippedApproaches: [],
      note: EVALUATION_NOTE,
      candidates: [],
      included: [],
      excluded: [],
      front: [],
      behind: [],
      // No comparison was made, so no decision was formed for an approved record to move. `null` says
      // that, which is different from "a decision was formed and the guidance was declined".
      adaptationDecision: null,
      outcomesRead: outcomesAudit(outcomes),
      whatWouldSettleIt: [],
    };
  }
  if (!goal || !registry) {
    return {
      ok: false,
      reason: 'no-goal-or-registry',
      problems: ['a goal and the live action registry are both needed: an evaluation checks steps against what is actually registered'],
      skippedApproaches: [],
      note: EVALUATION_NOTE,
      candidates: [],
      included: [],
      excluded: [],
      front: [],
      behind: [],
      adaptationDecision: null,
      outcomesRead: outcomesAudit(outcomes),
      whatWouldSettleIt: [],
    };
  }
  const context = {
    registry,
    goal,
    evidence,
    requiredOpen: openRequiredCriteria(goal),
    suggestedOpen: openSuggestedCriteria(goal),
    unavailable: new Set((evidence?.unavailableActions ?? []).map(String)),
    // Built from the goal as it is recorded now, and from the records the caller read about it: an
    // older ledger would let a cleared obstacle keep refusing work, or a new one let a plan walk into
    // it. A caller that has read more hands the richer ledger; neither answer is allowed to be silent
    // about what it could not check.
    constraints: constraints ?? constraintLedger({ goal, registry, evidence }),
    // The user's own approved guidance, as shaped records the caller read. Handed in rather than read
    // here, because the comparison must be reproducible by a reader that cannot open the store - and
    // when nothing is handed, nothing is claimed: the dimension reports that no guidance was read
    // instead of treating an unread store as an empty one.
    guidance: guidance ?? emptyGuidance('no guidance read was handed to this comparison', result.candidates),
    // What past runs of these capabilities left on record, as the caller read it - the same reasoning
    // as the guidance above: handed in rather than read here, so any reader can reproduce the ranking,
    // and an absent read is reported as absent rather than counted as a clean history.
    outcomes,
    // Whether a goal the record calls completed still rests on the evidence it was closed against.
    // Handed in, like the guidance and the outcomes above: the comparison cannot open the knowledge or
    // audit stores itself, and `goal_still_open` says which of the two answers it was given.
    goalEvidence,
  };
  const rows = result.candidates.map((candidate) => {
    const constraintGate = gateConstraints(candidate, context);
    const gates = {
      candidate_validation: gateCandidateValidation(candidate, context),
      dependency_structure: gateDependencyStructure(candidate),
      capability_available_now: gateCapabilityAvailable(candidate, context),
      constraints_satisfied: constraintGate,
      plan_bounds: gatePlanBounds(candidate),
      goal_still_open: gateGoalStillOpen(candidate, context),
    };
    const failed = Object.entries(gates).filter(([, g]) => !g.passed).map(([gate, g]) => ({ gate, detail: g.detail }));
    return {
      strategy: candidate.strategy,
      note: candidate.note,
      digest: candidate.digest,
      steps: candidate.steps,
      writes: candidate.writes,
      reads: candidate.reads,
      risk: candidate.risk,
      readyForApproval: candidate.readyForApproval,
      gates,
      failedGates: failed,
      included: failed.length === 0,
      constraints: constraintGate.finding,
      assessed: assess(candidate, { ...context, finding: constraintGate.finding }),
    };
  });
  const included = rows.filter((r) => r.included);
  const excluded = rows.filter((r) => !r.included);
  const { wins, losses } = dominance(included);
  const front = included.filter((r) => losses.get(r.strategy).length === 0);
  const behind = included.filter((r) => losses.get(r.strategy).length > 0);
  // The one decision an approved record may move, stated as what the same rule would have said without
  // it. Computed here, from the candidates that already passed every gate, so nothing above this line
  // depends on it: the gate list, the included set, and the candidate bytes are identical either way.
  const adaptationDecision = adaptationDecisionOf({ guidance: context.guidance, included, front });

  // Each unresolved pair says which dimensions pull in opposite directions: that is the whole of what
  // APEX can honestly report, and it is enough for the user to decide on.
  const tradeOffs = [];
  const ties = [];
  for (let i = 0; i < front.length; i += 1) {
    for (const b of front.slice(i + 1)) {
      const a = front[i];
      const aBetter = [];
      const bBetter = [];
      for (const name of RANKED_DIMENSIONS) {
        const c = compareDimension(a.assessed.ranked[name], b.assessed.ranked[name]);
        if (c > 0) aBetter.push(name);
        else if (c < 0) bBetter.push(name);
      }
      if (aBetter.length > 0 && bBetter.length > 0) {
        tradeOffs.push({
          between: [a.strategy, b.strategy],
          [`${a.strategy}_better_on`]: aBetter,
          [`${b.strategy}_better_on`]: bBetter,
          statement: `${a.strategy} is better on ${aBetter.join(', ')}; ${b.strategy} is better on ${bBetter.join(', ')}. Neither dominates the other, so the choice is a priority the user sets, not a finding APEX has made.`,
        });
      } else if (aBetter.length === 0 && bBetter.length === 0) {
        // Equal on everything the rule ranks. Two front members cannot be separated further, because
        // one that dominated the other would have taken it off the front. Saying so is part of not
        // inventing a winner.
        ties.push({
          between: [a.strategy, b.strategy],
          statement: `${a.strategy} and ${b.strategy} match on every ranked dimension: the comparison finds nothing recorded that separates them.`,
        });
      }
    }
  }

  const unresolved = front.length > 1;
  const cannotChoose = front.length === 0;
  return {
    ok: !cannotChoose,
    // When nothing was generated, the generator's own reason is the honest one: it says whether the
    // goal had no criteria, no capability could carry it, or every approach was refused.
    reason: cannotChoose ? (rows.length === 0 ? result.reason ?? 'no-candidates' : 'every-candidate-gated') : null,
    problems: rows.length === 0 ? [...(result.problems ?? [])] : [],
    skippedApproaches: (result.skipped ?? []).map((s) => ({ strategy: s.strategy, reason: s.reason })),
    goalId: goal.id ?? null,
    goalRevision: goal.revision ?? null,
    // What was assessed, byte for byte: an evaluation of candidate content that has since changed is
    // a statement about bytes that are no longer on the table.
    boundTo: {
      candidateDigests: rows.map((r) => ({ strategy: r.strategy, digest: r.digest })),
      candidateSetDigest: stableStringify(rows.map((r) => r.digest)),
    },
    rule: EVALUATION_RULE,
    rankedDimensions: RANKED_DIMENSIONS,
    disclosedDimensions: DISCLOSED_DIMENSIONS,
    gates: GATES,
    constraints: context.constraints,
    guidance: context.guidance,
    // The decision the guidance did or did not move, as the decision without it beside the decision with
    // it. Every record the ledger read is named with the state that allowed or stopped it, so an
    // ineligible record is disclosed rather than silently ignored.
    adaptationDecision,
    // Whether the past runs of these capabilities were read at all, and what that read covered. The
    // audit line carries it so a reader can see that a ranking which used no history did not use a
    // clean history either.
    outcomesRead: outcomesAudit(context.outcomes),
    // The same discipline for a completed goal: what the re-read of its evidence said, or that nobody
    // re-read it. An audit line is not proof that it was checked unless it can say which happened.
    goalEvidenceRead: context.goalEvidence ? {
      completed: context.goalEvidence.completed,
      checked: context.goalEvidence.checked,
      holds: context.goalEvidence.holds,
      withdrawn: context.goalEvidence.withdrawn.map((w) => w.criterionId),
      unsupported: context.goalEvidence.unsupported.map((u) => u.criterionId),
      uncheckable: context.goalEvidence.uncheckable.length,
    } : null,
    candidates: rows,
    included: included.map((r) => r.strategy),
    excluded: excluded.map((r) => ({ strategy: r.strategy, digest: r.digest, failedGates: r.failedGates })),
    front: front.map((r) => r.strategy),
    behind: behind.map((r) => ({
      strategy: r.strategy,
      digest: r.digest,
      whyBehind: losses.get(r.strategy),
      betterThanThose: wins.get(r.strategy),
    })),
    selection: {
      leading: front.length === 1 ? front[0].strategy : null,
      basis: front.length === 1
        ? 'no other candidate that passed every gate is as good on all ranked dimensions and better on one'
        : front.length === 0
          // Nothing is on the table, so the rule has separated nothing. Naming a reason here would read
          // as a comparison of candidates that do not exist.
          ? null
          : tradeOffs.length > 0
            ? 'the ranked dimensions pull in opposite directions between the candidates that passed every gate'
            : 'the candidates that passed every gate match on every ranked dimension; nothing recorded separates them',
      unresolvedTradeOff: unresolved,
      tradeOffs,
      ties,
      userDecisionRequired: true,
      approved: false,
      executable: false,
      note: 'leading is a position under the disclosed rule, not a claim that this plan will work',
    },
    clarificationNeeded: unresolved || cannotChoose || (result.clarificationNeeded ?? false),
    whatWouldSettleIt: [
      ...(unresolved && tradeOffs.length > 0 ? ['which of these matters more to the user: settling more of the goal\'s recorded criteria, or recording and risking less'] : []),
      ...(unresolved && tradeOffs.length === 0 ? ['nothing in the records separates these candidates on the ranked dimensions; the choice rests on their text, which a comparison of recorded facts cannot weigh'] : []),
      ...(cannotChoose && rows.length > 0 ? ['what is wrong with each candidate, per gate, is listed above; nothing can be ranked until one of them passes every gate'] : []),
      // A gating record is the thing to change, so its own resolution is printed as the answer to
      // "what would settle this" - not a suggestion about the work, but what the record says clears it.
      ...context.constraints.gating.map((id) => {
        const c = context.constraints.constraints.find((item) => item.id === id);
        return `the record that gates work: ${c.class} ${c.id} ("${c.text}") - ${c.resolution}`;
      }),
      ...(context.requiredOpen.length === 0 ? ['the goal records no open required criterion: which criteria does the user make required?'] : []),
      ...(result.unaddressed?.length ? [`a criterion no registered capability can carry: ${result.unaddressed.map((u) => `${u.criterionId ?? '-'} ("${u.text}")`).join(', ')}`] : []),
      ...(result.assumedFromGoalRequest?.length ? [`a criterion whose own words name no capability: ${result.assumedFromGoalRequest.map((a) => `${a.criterionId ?? '-'} ("${a.text}")`).join(', ')}`] : []),
    ],
    note: EVALUATION_NOTE,
  };
}

// The comparison, one block per candidate: gates, the ranked bands, the disclosed context, and why a
// candidate sits where it sits. Deliberately no numbers except recorded counts, and no wording that
// reads as a prediction.
export function renderEvaluation(evaluation, { indent = '' } = {}) {
  const lines = [];
  if (!evaluation || evaluation.ok === false) {
    lines.push(`${indent}No candidate plan could be compared: ${evaluation?.reason ?? 'nothing was given to compare'}.`);
    for (const p of evaluation?.problems ?? []) lines.push(`${indent}  - ${p}`);
    for (const s of evaluation?.skippedApproaches ?? []) {
      lines.push(`${indent}  ${s.strategy}: not offered - ${s.reason}`);
    }
    for (const c of evaluation?.excluded ?? []) {
      lines.push(`${indent}  ${c.strategy}: excluded`);
      for (const g of c.failedGates) lines.push(`${indent}    gate ${g.gate}: ${g.detail}`);
    }
    for (const item of evaluation?.whatWouldSettleIt ?? []) {
      lines.push(`${indent}  what would settle this: ${item}`);
    }
    lines.push(`${indent}${evaluation?.note ?? EVALUATION_NOTE}`);
    return lines.join('\n');
  }
  lines.push(`${indent}Plan evaluation for goal ${singleLine(String(evaluation.goalId ?? ''), 24)} (revision ${evaluation.goalRevision ?? '-'}):`);
  lines.push(`${indent}  rule: ${evaluation.rule}`);
  for (const s of evaluation.skippedApproaches ?? []) {
    lines.push(`${indent}  ${s.strategy}: not offered - ${s.reason}`);
  }
  for (const row of evaluation.candidates) {
    lines.push(`${indent}  ${row.strategy}${row.included ? '' : ' - EXCLUDED'}: ${row.note}`);
    if (!row.included) {
      for (const g of row.failedGates) lines.push(`${indent}    gate ${g.gate}: ${g.detail}`);
      continue;
    }
    for (const name of RANKED_DIMENSIONS) {
      lines.push(`${indent}    ${name}: ${row.assessed.ranked[name].band}`);
    }
    for (const name of DISCLOSED_DIMENSIONS) {
      lines.push(`${indent}    ${name} (reported, not ranked): ${row.assessed.disclosed[name].band}`);
    }
    const behind = evaluation.behind.find((b) => b.strategy === row.strategy);
    if (behind) {
      for (const w of behind.whyBehind) lines.push(`${indent}    behind ${w.under} on ${w.on.join(', ')}`);
    }
    if (evaluation.front.includes(row.strategy)) {
      lines.push(`${indent}    no other gated candidate does better everywhere and never worse`);
    }
    lines.push(`${indent}    not recorded, not approved, not started`);
  }
  if (evaluation.selection.unresolvedTradeOff) {
    for (const t of evaluation.selection.tradeOffs) lines.push(`${indent}  unresolved trade-off: ${t.statement}`);
    for (const t of evaluation.selection.ties ?? []) lines.push(`${indent}  not separated by the rule: ${t.statement}`);
  } else if (evaluation.selection.leading) {
    lines.push(`${indent}  under that rule ${evaluation.selection.leading} leads: ${evaluation.selection.basis}.`);
    lines.push(`${indent}  that is a position in the comparison, not a forecast: it is the user who records and approves a plan.`);
  }
  if (evaluation.whatWouldSettleIt.length > 0) {
    lines.push(`${indent}  what would settle the choice:`);
    for (const item of evaluation.whatWouldSettleIt) lines.push(`${indent}    - ${item}`);
  }
  lines.push(`${indent}${evaluation.note}`);
  return lines.join('\n');
}

// The decision an approved record was allowed to move, printed beside the decision the ranked records of
// the work alone would have produced. A reader can disagree with the use made of their own guidance only
// if they can see both answers, so both are printed even when they are the same. Kept separate from
// renderEvaluation because it is disclosure about learning, not a part of the comparison: the same
// candidate bytes, gates and ranked dimensions are what renderEvaluation prints either way.
export function renderAdaptationDecision(decision, { indent = '' } = {}) {
  if (!decision) return `${indent}No comparison was made, so no adaptation decision was formed.`;
  const lines = [];
  lines.push(`${indent}Approved guidance and this decision (${decision.dimension}):`);
  lines.push(`${indent}  without it: ${decision.before.leading ? `${decision.before.leading} leads` : 'no single leading candidate'} (front: ${decision.before.front.join(', ') || 'none'})`);
  lines.push(`${indent}  with it: ${decision.after.leading ? `${decision.after.leading} leads` : 'no single leading candidate'} (front: ${decision.after.front.join(', ') || 'none'})`);
  if (decision.outcome === 'declined') {
    lines.push(`${indent}  declined: ${decision.declinedReason}`);
  } else {
    for (const r of decision.rules) {
      const provenance = r.source === 'prediction'
        ? (r.basis === 'longitudinal_pattern'
          ? `longitudinal-pattern-derived; pattern ${r.pattern?.kind ?? '-'} over ${r.pattern?.observations ?? r.support.predictionIds.length} observation(s); predictions ${r.support.predictionIds.join(', ') || '-'}`
          : `single-evaluation-derived; prediction ${r.support.predictionIds.join(', ') || '-'} evaluation ${r.support.evaluationIds.join(', ') || '-'}`)
        : `feedback-derived; evidence ${r.support.experienceIds.length ? r.support.experienceIds.join(', ') : 'none recorded'}`;
      lines.push(`${indent}  applied: approved record ${r.id} version ${r.version ?? '-'} for ${r.capability} (${provenance})`);
    }
    if (!decision.changed) lines.push(`${indent}  applied, and it changed nothing: the same candidate led with or without it`);
  }
  // The kind of evidence behind the dimension, said in one place so a reader does not have to infer it
  // from the rule list: prediction evidence was absent, present beside feedback evidence, the only kind
  // applied, or considered and unusable. All four are facts about this comparison, not about APEX's
  // confidence in the rule.
  const sources = decision.sources;
  if (sources) {
    if (sources.predictionEvidence === 'none') {
      lines.push(`${indent}  evidence behind this dimension: no prediction-derived adaptation record bears on these capabilities`);
    } else if (sources.predictionEvidence === 'both') {
      lines.push(`${indent}  evidence behind this dimension: both feedback-derived and prediction-derived rules were applicable`);
    } else if (sources.predictionEvidence === 'prediction_derived') {
      lines.push(`${indent}  evidence behind this dimension: a prediction-derived rule was applicable`);
    } else if (sources.predictionEvidence === 'prediction_rejected') {
      lines.push(`${indent}  evidence behind this dimension: prediction evidence was considered and could not be used (${sources.predictionRejected.map((r) => `${r.id} [${r.state}]`).join(', ')})`);
    }
    if (sources.feedbackDerived.length > 0 || sources.predictionDerived.length > 0) {
      lines.push(`${indent}    applied feedback-derived: ${sources.feedbackDerived.join(', ') || 'none'}; applied prediction-derived: ${sources.predictionDerived.join(', ') || 'none'}`);
      if (sources.longitudinalDerived.length > 0 || sources.singleEvaluationDerived.length > 0) {
        lines.push(`${indent}    of the prediction-derived records: longitudinal pattern ${sources.longitudinalDerived.join(', ') || 'none'}; single evaluated observation ${sources.singleEvaluationDerived.join(', ') || 'none'}`);
      }
    }
  }
  for (const c of decision.considered ?? []) {
    if (c.state !== 'applicable') {
      const provenance = c.source === 'prediction' ? ' [prediction-derived]' : '';
      lines.push(`${indent}  not applied: ${c.id} for ${c.capability ?? '-'}${provenance} [${c.state}] - ${c.why}`);
    }
  }
  lines.push(`${indent}  ${decision.note}`);
  return lines.join('\n');
}
