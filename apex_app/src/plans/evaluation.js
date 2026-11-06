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
import { dependencyProblems, stableStringify } from '../tasks/model.js';
import { singleLine } from '../util.js';
import { Requirement, requirementOf } from '../goals/model.js';
import {
  MAX_ASSERTIONS, MAX_PLAN_STEPS, MAX_PRECONDITIONS, MAX_PRECONDITION_CHARS, RISK_ORDER,
  validatePlanContent,
} from './model.js';

export const EVALUATION_NOTE = 'an evaluation compares what each candidate records; it is not a prediction, a probability, or an approval, and it starts nothing';

// The dimensions the ordering uses, in the order they are named to the reader. Every one of them is
// a recorded count or a recorded class, not a weight: the list is disclosed so the reader can see
// exactly what was compared and can disagree with it knowingly.
export const RANKED_DIMENSIONS = Object.freeze([
  'criterion_coverage',
  'uncertainty',
  'step_risk',
  'reversibility',
  'resource_requirements',
]);

// Dimensions that are reported for every candidate but do not move the ranking, because there is no
// honest way to trade one against another: they are context for the user's decision, not inputs to a
// formula.
export const DISCLOSED_DIMENSIONS = Object.freeze([
  'goal_alignment',
  'evidence_sufficiency',
  'dependency_validity',
  'capability_availability',
  'expected_verification_quality',
  'known_blockers',
]);

export const GATES = Object.freeze([
  'candidate_validation',
  'dependency_structure',
  'capability_available_now',
  'plan_bounds',
  'goal_still_open',
]);

// The rule, in the words the reader is shown. It is not hidden behind a number.
export const EVALUATION_RULE = `Hard gates first: a candidate that fails any gate is excluded and names why. `
  + `Then ${RANKED_DIMENSIONS.join(', ')} are compared as recorded, and a candidate ranks above another `
  + `only where it is at least as good on all of them and strictly better on at least one. `
  + `Candidates that lead on different dimensions are both kept and the trade-off is reported as unresolved. `
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
function gateGoalStillOpen(candidate, { goal }) {
  if (!goal || !goal.id) return { passed: false, detail: 'no recorded goal is available, so nothing can be checked against it' };
  if (candidate.content.goalId !== goal.id) {
    return { passed: false, detail: `the candidate is for goal ${singleLine(String(candidate.content.goalId ?? 'none'), 24)}, not ${singleLine(goal.id, 24)}` };
  }
  if (['completed', 'failed', 'cancelled', 'superseded', 'abandoned'].includes(goal.status)) {
    return { passed: false, detail: `the goal is ${goal.status}, so this candidate plans work that is no longer open` };
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

// ---- disclosed dimensions ---------------------------------------------------

function disclosedAlignment(candidate, { requiredOpen, suggestedOpen }) {
  const leftOut = candidate.criteriaLeftOutOfThisApproach.filter((id) => requiredOpen.includes(id));
  const suggestedLeft = candidate.criteriaLeftOutOfThisApproach.filter((id) => suggestedOpen.includes(id));
  const parts = [];
  if (leftOut.length > 0) parts.push(`leaves required ${leftOut.join(', ')} out of the approach`);
  if (suggestedLeft.length > 0) parts.push(`leaves the APEX suggestion ${suggestedLeft.join(', ')} out of the approach`);
  return { band: parts.length ? parts.join('; ') : 'takes on every open criterion its approach covers' };
}

function disclosedEvidence(candidate) {
  const kinds = new Map();
  for (const a of candidate.content.assertions) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  const unsettled = (kinds.get('inference') ?? 0) + (kinds.get('unknown') ?? 0);
  const established = candidate.content.assertions
    .filter((a) => ['user_fact', 'stored_knowledge', 'retrieved_evidence', 'world_fact', 'world_entity'].includes(a.kind))
    .map((a) => a.kind);
  return {
    band: `${established.length} established assertion(s)${established.length ? ` (${[...new Set(established)].join(', ')})` : ''}; ${unsettled} inference or unknown`,
    kinds: Object.fromEntries([...kinds.entries()].sort()),
  };
}

function disclosedDependencies(candidate) {
  const problems = dependencyProblems(candidate.content.steps);
  return { band: problems.length === 0 ? 'each step lists the step before it, as the sequential runner works' : problems.join('; ') };
}

function disclosedCapabilities(candidate) {
  return {
    band: candidate.capabilities.map((k) => `${k.action} (${k.permission}${k.hasVerifier ? ', has its own verifier' : ', no verifier'})`).join(', '),
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
    band: noVerifier.length > 0
      ? `no independent verifier for ${noVerifier.join(', ')}`
      : `every step is re-checked by its own action's verifier${wanted.length ? `; the goal's recorded evidence condition is carried for ${carried.join(', ') || 'no criterion'}${missing.length ? ` and not for ${missing.join(', ')}, which has no step of its own here` : ''}` : ''}`,
  };
}

// A blocker is whatever the goal record and the handed evidence say it is; this says whether the
// candidate states what is on record, rather than quietly dropping an obstacle from the plan text.
function disclosedBlockers(candidate, { goal, evidence }) {
  const recorded = [
    ...(goal?.blockers ?? []).map((b) => singleLine(b?.text ?? '', MAX_PRECONDITION_CHARS)),
    ...(evidence?.knownBlockers ?? []).map((b) => singleLine(String(b), MAX_PRECONDITION_CHARS)),
  ].filter((t) => t.length > 0);
  if (recorded.length === 0) return { band: 'no blocker is on record for this goal or this generation' };
  const stated = candidate.content.preconditions.filter((p) => recorded.some((b) => p.includes(b)));
  return {
    band: stated.length === recorded.length
      ? `${recorded.length} blocker(s) on record, each stated in the candidate's own preconditions`
      : `${recorded.length} blocker(s) on record, ${stated.length} of them stated in the preconditions`,
  };
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
// reducing a genuine trade-off to one winner is the false precision this avoids.
function dominance(rows) {
  const wins = new Map(rows.map((r) => [r.strategy, []]));
  const losses = new Map(rows.map((r) => [r.strategy, []]));
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue;
      let better = 0;
      let worse = 0;
      const dims = [];
      for (const name of RANKED_DIMENSIONS) {
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

// Evaluate a generated candidate set. `result` is what `candidatesForGoal` or `revisedCandidates`
// returned; `goal` is the goal as it is recorded now, so a stale candidate is caught rather than
// ranked; `evidence` may name actions this generation must not offer and blockers on record.
export function evaluateCandidates({ result, goal, registry, evidence = null } = {}) {
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
  };
  const rows = result.candidates.map((candidate) => {
    const gates = {
      candidate_validation: gateCandidateValidation(candidate, context),
      dependency_structure: gateDependencyStructure(candidate),
      capability_available_now: gateCapabilityAvailable(candidate, context),
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
      assessed: assess(candidate, context),
    };
  });
  const included = rows.filter((r) => r.included);
  const excluded = rows.filter((r) => !r.included);
  const { wins, losses } = dominance(included);
  const front = included.filter((r) => losses.get(r.strategy).length === 0);
  const behind = included.filter((r) => losses.get(r.strategy).length > 0);

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
