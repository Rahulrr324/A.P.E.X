// Deterministic deliberation.
//
// The thirteen steps below are ordinary functions over the records that were read. There is no
// model call, no scoring formula standing in for judgement, and no confidence percentage: every
// conclusion names the claims and evidence it rests on, every conflict is kept, and anything the
// records cannot answer is reported as unanswered rather than filled in.
import { BOUNDS, ClaimKind, DecisionKind, Disclosure, MissingInfo, Uncertainty, UncertaintyAbout } from './vocabulary.js';
import { validateClaims } from './claims.js';

const CLARIFY_PRIORITY = [
  MissingInfo.INTENT,
  MissingInfo.AMBIGUOUS_REFERENCE,
  MissingInfo.TOPIC,
  MissingInfo.ENTITY,
  MissingInfo.GOAL_CRITERIA,
  MissingInfo.TIME_RANGE,
  MissingInfo.CONFLICTING_REQUIREMENTS,
  MissingInfo.PLAN_STEP,
  MissingInfo.ACTION_PARAMETER,
];

function uniq(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function claimIdsOf(claims, predicate) {
  return claims.filter(predicate).map((claim) => claim.claimId);
}

function evidenceIdsOf(claims, predicate) {
  return uniq(claims.filter(predicate).flatMap((claim) => claim.evidenceIds));
}

function subquestionsFor(understanding, claims, retrieval) {
  const material = claims.filter((claim) => claim.material);
  const have = (kind) => material.some((claim) => claim.kind === kind);
  const anyEvidence = material.length > 0;
  const list = [];
  const add = (code, question, answerable, evidenceIds = []) => {
    if (list.length >= BOUNDS.maxSubquestions) return;
    list.push({ code, question, answerable: answerable === true, evidenceIds: uniq(evidenceIds) });
  };
  const intent = understanding.intent;
  add('what-is-asked', 'What does the request ask for?', true, []);
  if (intent === 'comparison') {
    add('referent-a', 'What is recorded about the first referent?', understanding.entities.length >= 1, evidenceIdsOf(claims, (claim) => claim.subject?.entityId === understanding.entities[0]?.id));
    add('referent-b', 'What is recorded about the second referent?', understanding.entities.length >= 2, evidenceIdsOf(claims, (claim) => claim.subject?.entityId === understanding.entities[1]?.id));
    add('shared-attribute', 'Do the records describe the same attribute?', anyEvidence);
  }
  if (intent === 'historical') {
    add('as-of-state', 'What was recorded as valid at the requested time?', Boolean(understanding.timeRange?.parsed), evidenceIdsOf(claims, (claim) => claim.current === false || claim.note?.includes('past')));
    add('later-change', 'What changed after that time?', anyEvidence);
  }
  if (intent === 'goal_progress' || intent === 'plan_review' || intent === 'next_step') {
    add('executive-state', 'What do the goal, plan, and task records say?', anyEvidence);
    add('blockers', 'Is anything blocking the work?', anyEvidence, evidenceIdsOf(claims, (claim) => claim.kind === ClaimKind.GOAL_STATE || claim.kind === ClaimKind.PLAN_STATE || claim.kind === ClaimKind.TASK_STATE));
    add('eligible-step', 'What is the next eligible step, if any?', anyEvidence);
    add('needs-user', 'Does anything require the user\'s decision or authorization?', true);
  }
  if (intent === 'planning') {
    add('outcome', 'What outcome should the plan name?', true);
    add('criteria', 'What success criteria are recorded?', understanding.missing.every((item) => item.code !== MissingInfo.GOAL_CRITERIA));
    add('preconditions', 'What preconditions and authorization does it need?', anyEvidence);
    add('steps', 'Which steps are supported by the records?', anyEvidence);
  }
  if (intent === 'task_execution') {
    add('task', 'Which task is meant?', understanding.tasks.some((ref) => !ref.ambiguous), understanding.tasks.map(() => ''));
    add('authorization', 'Is the capability authorized for this origin?', false);
    add('step', 'Which step would run?', anyEvidence);
  }
  if (intent === 'feedback') {
    add('corrected-record', 'Which recorded claim does the correction name?', anyEvidence);
    add('current-state', 'What does the record say now?', anyEvidence);
  }
  if (intent === 'world_model_question' || intent === 'stored_information_question' || intent === 'general_question' || intent === 'explanation') {
    add('matching-records', 'Which stored records bear on the request?', anyEvidence);
    add('agreement', 'Do they agree, or does the store record a disagreement?', anyEvidence, evidenceIdsOf(claims, (claim) => claim.kind === ClaimKind.CONTRADICTED));
    add('currency', 'Are the records current, historical, or of unknown validity?', anyEvidence, evidenceIdsOf(claims, (claim) => claim.kind === ClaimKind.HISTORICAL || claim.kind === ClaimKind.UNKNOWN));
  }
  if (understanding.unsupported) add('capability', 'Is the requested capability available?', false);
  const unavailable = retrieval?.counts?.unavailable ?? [];
  if (unavailable.length > 0) add('source-completeness', 'Could every relevant source be read?', false);
  return list;
}

function interpretationsFor(understanding, claims) {
  const list = [];
  const add = (code, text, evidenceIds) => {
    if (list.length >= BOUNDS.maxInterpretations) return;
    list.push({ code, text, evidenceIds: uniq(evidenceIds), chosen: false });
  };
  const conflicting = claims.filter((claim) => claim.kind === ClaimKind.CONTRADICTED);
  if (conflicting.length > 0) {
    add('sources-disagree',
      'The records disagree. The newer record may be the later statement, but recency is not truth and neither side is chosen here.',
      conflicting.flatMap((claim) => claim.evidenceIds));
  }
  if (understanding.intent === 'comparison' && understanding.entities.length >= 2) {
    add('two-referents',
      'Each referent has its own recorded statements. A comparison is only supported where the records name the same attribute; no attribute is assumed to be shared.',
      claims.filter((claim) => claim.subject?.entityId).flatMap((claim) => claim.evidenceIds));
  }
  if (claims.some((claim) => claim.kind === ClaimKind.HISTORICAL)) {
    add('past-not-current',
      'A statement recorded as historical describes a past period. It is not the current value and does not by itself show what replaced it.',
      claims.filter((claim) => claim.kind === ClaimKind.HISTORICAL).flatMap((claim) => claim.evidenceIds));
  }
  if (claims.some((claim) => claim.kind === ClaimKind.EXPECTATION)) {
    add('expectation-not-observation',
      'A recorded expectation describes what the user expected, not what happened. No outcome is inferred from it.',
      claims.filter((claim) => claim.kind === ClaimKind.EXPECTATION).flatMap((claim) => claim.evidenceIds));
  }
  return list;
}

function assumptionsFor(understanding, claims) {
  const list = [];
  const add = (code, text) => {
    if (list.length >= BOUNDS.maxAssumptions) return;
    list.push({ code, text });
  };
  if (understanding.entities.length > 0 && understanding.ambiguities.length === 0) {
    add('single-entity-name-match', 'Each named entity matched exactly one active stored entity; the name was not used to decide identity beyond that match.');
  }
  if (claims.some((claim) => claim.source === 'world_fact' || claim.source === 'world_relationship')) {
    add('records-evaluated-now', 'World Model statement status was evaluated at the request time unless an as-of time was given.');
  }
  if (understanding.intent === 'next_step') {
    add('recommendation-is-not-permission', 'The next-step recommendation is read-only and does not authorize, approve, or execute anything.');
  }
  if (understanding.intent === 'planning' || understanding.intent === 'goal_creation') {
    add('proposal-still-required', 'A goal or plan generated for this request would still need to be proposed, accepted, validated, and authorized through the existing workflow.');
  }
  return list;
}

function uncertaintyFor(understanding, retrieval, claims) {
  const material = claims.filter((claim) => claim.material);
  const damaged = retrieval?.counts?.damaged ?? [];
  const unavailable = retrieval?.counts?.unavailable ?? [];
  const citations = (rows) => uniq(rows.flatMap((claim) => claim.evidenceIds));

  if (understanding.ambiguities.length > 0) {
    return {
      category: Uncertainty.UNKNOWN,
      about: UncertaintyAbout.IDENTITY,
      reason: `the reference is ambiguous: ${understanding.ambiguities[0].detail}`,
      evidenceIds: [],
    };
  }
  // A window that moved, or that could not be inspected, is not a damaged source: every record may be
  // individually intact and the combination still describes a moment that never existed. Saying so
  // before the per-source checks keeps the two conditions distinguishable.
  if (retrieval?.read?.state === 'inconsistent') {
    return {
      category: Uncertainty.UNVERIFIABLE,
      about: UncertaintyAbout.FACT,
      reason: 'a contributing store changed while this evidence was assembled, so the combined records describe no single instant',
      evidenceIds: [],
    };
  }
  if (retrieval?.read?.state === 'unverifiable') {
    return {
      category: Uncertainty.UNVERIFIABLE,
      about: UncertaintyAbout.FACT,
      reason: 'a contributing store could not be inspected while this evidence was assembled, so consistency could not be checked',
      evidenceIds: [],
    };
  }
  if (damaged.length > 0) {
    return {
      category: Uncertainty.UNVERIFIABLE,
      about: UncertaintyAbout.FACT,
      reason: `a source was damaged and could not be read: ${damaged.join(', ')}`,
      evidenceIds: [],
    };
  }
  if (unavailable.length > 0) {
    return {
      category: Uncertainty.UNVERIFIABLE,
      about: UncertaintyAbout.FACT,
      reason: `a source was unavailable and could not be read: ${unavailable.join(', ')}`,
      evidenceIds: [],
    };
  }
  const conflicting = material.filter((claim) => claim.kind === ClaimKind.CONTRADICTED);
  if (conflicting.length > 0) {
    return {
      category: Uncertainty.CONFLICTING,
      about: UncertaintyAbout.FACT,
      reason: 'the stored records disagree and the disagreement is unresolved',
      evidenceIds: citations(conflicting),
    };
  }
  if (material.length === 0) {
    const expectations = claims.filter((claim) => claim.kind === ClaimKind.EXPECTATION);
    if (expectations.length > 0) {
      return {
        category: Uncertainty.UNKNOWN,
        about: UncertaintyAbout.FACT,
        reason: 'only recorded expectations were found; an expectation is not evidence that the expected outcome occurred',
        evidenceIds: citations(expectations),
      };
    }
    return {
      category: Uncertainty.UNKNOWN,
      about: UncertaintyAbout.FACT,
      reason: 'no recorded evidence was found for the request',
      evidenceIds: [],
    };
  }
  const inference = material.filter((claim) => claim.kind === ClaimKind.INFERENCE || claim.kind === ClaimKind.ASSUMPTION);
  if (inference.length === material.length) {
    return {
      category: Uncertainty.INFERRED,
      about: UncertaintyAbout.INFERENCE,
      reason: 'every material statement is derived or inferred rather than a direct record',
      evidenceIds: citations(inference),
    };
  }
  const historical = material.filter((claim) => claim.kind === ClaimKind.HISTORICAL);
  // An entity or summary record says the entity exists now; it is not a current statement about the
  // attribute being asked about. Counting it as current would let a historical-only answer lose its
  // "outdated" label merely because the entity itself is still recorded.
  const current = material.filter((claim) => claim.current && claim.kind === ClaimKind.SUPPORTED
    && claim.type !== 'entity' && claim.type !== 'entity-summary');
  if (historical.length > 0 && current.length === 0) {
    return {
      category: Uncertainty.OUTDATED,
      about: UncertaintyAbout.CURRENCY,
      reason: 'the matching records are historical; no current statement was found',
      evidenceIds: citations(historical),
    };
  }
  if (material.some((claim) => claim.kind === ClaimKind.UNKNOWN)) {
    return {
      category: Uncertainty.WEAKLY_SUPPORTED,
      about: UncertaintyAbout.FACT,
      reason: 'at least one matching statement has no usable validity and is not treated as current',
      evidenceIds: citations(material.filter((claim) => claim.kind === ClaimKind.UNKNOWN)),
    };
  }
  // Two distinct source subsystems that record compatible claims about the same subject are stronger
  // support than one source. The rule is stated and conservative: the claims must share a subject,
  // duplicated records inside one source are excluded, and an entity-existence record is not counted
  // as support for a claim about that entity's budget, status, or history.
  const supportGroups = new Map();
  for (const claim of current) {
    if ((claim.duplicateOf ?? []).length > 0) continue;
    if (claim.type === 'entity' || claim.type === 'entity-summary') continue;
    const key = claim.subject?.entityId ?? claim.subjectKey;
    const group = supportGroups.get(key) ?? new Map();
    group.set(claim.source, claim);
    supportGroups.set(key, group);
  }
  const confirmed = [...supportGroups.values()].some((group) => group.size >= 2);
  if (confirmed) {
    return {
      category: Uncertainty.STRONGLY_SUPPORTED,
      about: UncertaintyAbout.FACT,
      reason: 'more than one source subsystem records a compatible claim about the same subject, and no stored disagreement was found',
      evidenceIds: citations(current),
    };
  }
  return {
    category: Uncertainty.SUPPORTED_INCOMPLETE,
    about: UncertaintyAbout.FACT,
    reason: 'at least one current record supports the statement, but the evidence comes from one source and may be incomplete',
    evidenceIds: citations(current.length > 0 ? current : material),
  };
}

function clarificationFor(understanding, retrieval, claims) {
  if (understanding.unsupported) {
    return { needed: false, question: null, missing: MissingInfo.INTENT, reason: 'the request names an unsupported capability' };
  }
  if (understanding.clarification) {
    return {
      needed: true,
      question: understanding.clarification,
      missing: understanding.missing[0]?.code ?? MissingInfo.INTENT,
      reason: understanding.missing[0]?.detail ?? 'the request cannot proceed without one more detail',
    };
  }
  if (understanding.ambiguities.length > 0) {
    return {
      needed: true,
      question: understanding.clarification,
      missing: understanding.ambiguities[0].code,
      reason: understanding.ambiguities[0].detail,
    };
  }
  const missing = [...understanding.missing].sort((a, b) => {
    const left = CLARIFY_PRIORITY.indexOf(a.code);
    const right = CLARIFY_PRIORITY.indexOf(b.code);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
  const topic = missing.find((item) => item.code === MissingInfo.TOPIC);
  if (topic) {
    return { needed: true, question: 'What topic should I search your memory for?', missing: topic.code, reason: topic.detail };
  }
  if (understanding.intent === 'goal_creation') {
    const criteria = missing.find((item) => item.code === MissingInfo.GOAL_CRITERIA);
    if (criteria) {
      return {
        needed: true,
        question: 'What success criterion should the goal use? A goal needs at least one criterion that can be marked satisfied.',
        missing: criteria.code,
        reason: criteria.detail,
      };
    }
  }
  const identity = missing.find((item) => item.code === MissingInfo.AMBIGUOUS_REFERENCE);
  if (identity) {
    return { needed: true, question: understanding.clarification, missing: identity.code, reason: identity.detail };
  }
  // A missing time range is reported as a limitation, not turned into a question: the records may
  // still answer a bounded "what is recorded now" question, and asking for a date when the answer
  // does not depend on one would delay a request that can proceed.
  return { needed: false, question: null, missing: null, reason: null };
}

function conclusionFor(understanding, retrieval, claims, uncertainty, clarification) {
  const material = claims.filter((claim) => claim.material);
  if (clarification.needed) {
    return {
      kind: 'clarify',
      text: clarification.question,
      claimIds: [],
      evidenceIds: [],
    };
  }
  if (understanding.unsupported) {
    return {
      kind: 'refuse',
      text: understanding.unsupported,
      claimIds: [],
      evidenceIds: [],
    };
  }
  if (material.length === 0) {
    const unavailable = (retrieval?.counts?.unavailable ?? []).length + (retrieval?.counts?.damaged ?? []).length;
    return {
      kind: 'unknown',
      text: unavailable > 0
        ? 'No conclusion is supported: at least one relevant source could not be read, so an empty result is not a finding that no record exists.'
        : 'No recorded evidence supports an answer to this request.',
      claimIds: [],
      evidenceIds: [],
    };
  }
  const conflicting = material.filter((claim) => claim.kind === ClaimKind.CONTRADICTED);
  if (conflicting.length > 0) {
    return {
      kind: 'conflicting',
      text: 'The stored records disagree. Both sides are kept, and no side is chosen by recency, source rank, or repetition.',
      claimIds: conflicting.map((claim) => claim.claimId),
      evidenceIds: uniq(conflicting.flatMap((claim) => claim.evidenceIds)),
    };
  }
  const usable = material.filter((claim) => [ClaimKind.SUPPORTED, ClaimKind.OBSERVATION, ClaimKind.GOAL_STATE, ClaimKind.PLAN_STATE, ClaimKind.TASK_STATE].includes(claim.kind));
  const partial = material.filter((claim) => [ClaimKind.HISTORICAL, ClaimKind.UNKNOWN, ClaimKind.INFERENCE, ClaimKind.ASSUMPTION].includes(claim.kind));
  if (usable.length > 0) {
    return {
      kind: partial.length > 0 ? 'partial' : 'supported',
      text: partial.length > 0
        ? 'The records support part of the answer; the remaining statements are historical, derived, or of unknown validity and are labelled as such.'
        : 'The records directly support the answer; a claim is only as good as the evidence id it cites.',
      claimIds: [...usable, ...partial].map((claim) => claim.claimId),
      evidenceIds: uniq([...usable, ...partial].flatMap((claim) => claim.evidenceIds)),
    };
  }
  return {
    kind: 'partial',
    text: 'The only matching statements are derived, historical, or of unknown validity; they do not establish a current fact.',
    claimIds: material.map((claim) => claim.claimId),
    evidenceIds: uniq(material.flatMap((claim) => claim.evidenceIds)),
  };
}

function recommendationFor(understanding, continuation, claims) {
  if (understanding.intent !== 'next_step' && understanding.intent !== 'goal_progress' && understanding.intent !== 'plan_review') {
    return null;
  }
  const candidates = Array.isArray(continuation?.candidates) ? continuation.candidates : [];
  if (candidates.length === 0) {
    return {
      kind: 'none',
      text: 'No eligible next step is described by the records that were read.',
      command: null,
      claimIds: [],
      evidenceIds: [],
      requiresAuthorization: false,
      executed: false,
    };
  }
  const top = candidates[0];
  return {
    kind: top.kind ?? 'next-step',
    text: `${top.title}${top.ready === false ? ' (blocked)' : ''}: ${(top.reasons ?? []).slice(0, 3).join('; ')}`.trim(),
    command: typeof top.command === 'string' ? top.command : null,
    claimIds: claims.filter((claim) => claim.kind === ClaimKind.GOAL_STATE || claim.kind === ClaimKind.PLAN_STATE || claim.kind === ClaimKind.TASK_STATE).map((claim) => claim.claimId),
    evidenceIds: claims.filter((claim) => claim.kind === ClaimKind.GOAL_STATE || claim.kind === ClaimKind.PLAN_STATE || claim.kind === ClaimKind.TASK_STATE).flatMap((claim) => claim.evidenceIds),
    requiresAuthorization: top.requiresAuthorization !== false,
    executed: false,
  };
}

export function deliberate({
  understanding,
  retrieval,
  claims: claimSet,
  continuation = null,
} = {}) {
  const claims = claimSet?.claims ?? [];
  const steps = [];
  const record = (step, name, detail) => steps.push({ step, name, detail });

  const material = claims.filter((claim) => claim.material);
  record(1, 'question', { intent: understanding.intent, intents: understanding.intents, entityIds: understanding.entities.map((entity) => entity.id) });
  const subquestions = subquestionsFor(understanding, claims, retrieval);
  record(2, 'subquestions', { count: subquestions.length, unanswerable: subquestions.filter((item) => !item.answerable).length });
  record(3, 'scope', { timeRange: understanding.timeRange?.label ?? null, entities: understanding.entities.length, goals: understanding.goals.length, plans: understanding.plans.length, tasks: understanding.tasks.length });
  const supporting = claimIdsOf(claims, (claim) => claim.kind === ClaimKind.SUPPORTED || claim.kind === ClaimKind.OBSERVATION || claim.kind === ClaimKind.GOAL_STATE || claim.kind === ClaimKind.PLAN_STATE || claim.kind === ClaimKind.TASK_STATE);
  const contradicting = claimIdsOf(claims, (claim) => claim.kind === ClaimKind.CONTRADICTED);
  record(4, 'supporting-evidence', { claimIds: supporting, count: supporting.length });
  record(5, 'contradicting-evidence', { claimIds: contradicting, count: contradicting.length });
  const missing = [...understanding.missing];
  record(6, 'missing-evidence', { codes: uniq(missing.map((item) => item.code)) });
  const inferred = claimIdsOf(claims, (claim) => claim.kind === ClaimKind.INFERENCE);
  const assumptions = assumptionsFor(understanding, claims);
  record(7, 'known-vs-inferred', { known: supporting.length + contradicting.length, inferred: inferred.length, assumptions: assumptions.length });
  const interpretations = interpretationsFor(understanding, claims);
  record(8, 'interpretations', { count: interpretations.length, chosen: 0 });
  for (const assumption of assumptions) record(9, 'assumption', { code: assumption.code });
  const clarification = clarificationFor(understanding, retrieval, claims);
  record(10, 'clarification', { needed: clarification.needed, missing: clarification.missing });
  const uncertainty = uncertaintyFor(understanding, retrieval, claims);
  const conclusion = conclusionFor(understanding, retrieval, claims, uncertainty, clarification);
  const recommendation = recommendationFor(understanding, continuation, claims);
  record(11, 'proposed-conclusion', { kind: conclusion.kind, claimIds: conclusion.claimIds });
  const claimValidation = validateClaims(claims, retrieval?.byId ?? new Map());
  record(12, 'validation', { ok: claimValidation.ok, problems: claimValidation.problems.length });
  const decision = clarification.needed
    ? DecisionKind.CLARIFY
    : understanding.unsupported
      ? DecisionKind.REFUSE
      : DecisionKind.ANSWER;
  record(13, 'decision', { decision: decision });

  const disclosures = [];
  const disclose = (code) => {
    if (!disclosures.includes(code)) disclosures.push(code);
  };
  if (material.length === 0) disclose(Disclosure.NO_EVIDENCE);
  if ((retrieval?.counts?.unavailable ?? []).length > 0) disclose(Disclosure.SOURCE_UNAVAILABLE);
  if ((retrieval?.counts?.damaged ?? []).length > 0) disclose(Disclosure.SOURCE_DAMAGED);
  if (retrieval?.read?.state === 'inconsistent') disclose(Disclosure.EVIDENCE_NOT_SINGLE_INSTANT);
  if (retrieval?.read?.state === 'unverifiable') disclose(Disclosure.EVIDENCE_SNAPSHOT_UNVERIFIED);
  if (contradicting.length > 0) disclose(Disclosure.CONFLICT_UNRESOLVED);
  if (claims.some((claim) => claim.kind === ClaimKind.HISTORICAL)) disclose(Disclosure.EVIDENCE_HISTORICAL);
  if (claims.some((claim) => claim.kind === ClaimKind.UNKNOWN)) disclose(Disclosure.EVIDENCE_UNKNOWN_VALIDITY);
  if (claims.some((claim) => claim.kind === ClaimKind.EXPECTATION)) disclose(Disclosure.EXPECTATION_NOT_FACT);
  if (inferred.length > 0) disclose(Disclosure.INFERENCE_MARKED);
  if (assumptions.length > 0) disclose(Disclosure.ASSUMPTION_STATED);
  if (clarification.needed) disclose(Disclosure.CLARIFICATION_REQUIRED);
  if ((retrieval?.counts?.dropped ?? 0) > 0) disclose(Disclosure.CONTEXT_TRUNCATED);
  if (recommendation) disclose(Disclosure.RECOMMENDATION_NOT_EXECUTED);

  const validationProblems = [...claimValidation.problems];
  if (conclusion.claimIds.some((id) => !claimSet?.byId?.has(id))) validationProblems.push('the conclusion names a claim that was not extracted');
  if (conclusion.kind !== 'clarify' && clarification.needed) validationProblems.push('clarification is required but the conclusion does not ask for it');
  if (recommendation && recommendation.executed !== false) validationProblems.push('a recommendation must never be marked executed');
  if (readingExecuted(conclusion.text)) validationProblems.push('the conclusion claims an execution, which the reasoning layer cannot verify');
  const claimValidationResult = { ok: validationProblems.length === 0, problems: validationProblems };

  return {
    steps,
    question: { intent: understanding.intent, intents: understanding.intents },
    subquestions,
    supporting,
    contradicting,
    missing,
    knownVsInferred: { known: supporting.length + contradicting.length, inferred: inferred.length, assumptions: assumptions.length },
    interpretations,
    assumptions,
    clarification,
    conclusion,
    uncertainty,
    recommendation,
    decision,
    disclosures,
    validation: claimValidationResult,
  };
}

// The reasoning layer never runs an action, so a conclusion that says one ran is a defect. The check
// is deliberately narrow: it looks for the system's own execution vocabulary, not for the user
// asking what happened.
function readingExecuted(text) {
  return /\b(?:i|apex)\s+(?:have\s+)?(?:executed|ran|performed|completed|approved|activated)\b/i.test(String(text ?? ''));
}
