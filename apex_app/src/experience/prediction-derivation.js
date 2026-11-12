// Prediction-derived adaptation proposals. Pure: no I/O, no clock, no model.
//
// Batch AP-01 let one user-approved adaptation, shaped by a guidance record the user wrote, move the
// ordering of one later candidate comparison. Batch AP-02 asks whether the same pathway may also rest
// on a recorded outcome: a prediction the user made, and the verdict a deterministic evaluation later
// recorded against it. This module is the whole of the new rule, and it is deliberately narrower than
// the feedback rule beside it:
//
//   a prediction is eligible to propose an adaptation candidate only when the ledger reports it
//   evaluated, no withdrawal or replacement retires it, the recorded evaluation still agrees with a
//   fresh read, its lineage is readable with no unresolved citation, and every outcome experience the
//   evaluation cited is still present and still current.
//
// The proposal is a *statement of the recorded outcome*, mapped to the same four-field guidance
// vocabulary a user already uses: a success proposes that work naming the capability be preferred; a
// failure or a block proposes that it be avoided. The prediction's own subject text is never parsed -
// it is display only - so no sentence the user wrote can become an executable rule. The proposal is
// not executable at all until `adaptation.decide` records the user's approval of the candidate that
// carries it, and even then it can only re-order approaches in a comparison.
//
// Nothing here approves, authorizes, plans, or executes anything. A verdict is not consent.
import { createHash } from 'node:crypto';
import { isScopableCapability } from './experience-store.js';
import { DERIVATION_METHOD, normalizeRuleText } from './derivation.js';
import { outcomeClass } from './temporal.js';

export const PREDICTION_DERIVATION_METHOD = 'evaluated_prediction';
export const LONGITUDINAL_DERIVATION_METHOD = 'repeated_outcome_pattern';
export const LONGITUDINAL_PROPOSAL_TYPE = 'repeated_outcome_pattern';

// The closed set of methods an adaptation record may name. An unknown method is damage, and the
// record validator refuses it before any reader can act on it.
export const ADAPTATION_METHODS = Object.freeze([
  DERIVATION_METHOD, PREDICTION_DERIVATION_METHOD, LONGITUDINAL_DERIVATION_METHOD,
]);

// The one dimension a prediction-derived candidate may feed. It is the same ranked dimension AP-01
// built; no second ordering rule is introduced. A longitudinal candidate feeds the same dimension.
export const PREDICTION_DECISION_DIMENSION = 'approved_adaptation_fit';
export const PREDICTION_PROPOSAL_TYPE = 'evaluated_prediction';

// Why a prediction cannot propose a candidate. Closed, so a reader never has to guess what an
// unlisted state meant, and `INELIGIBLE_REASONS` supplies the wording once.
export const PREDICTION_ELIGIBILITY_STATES = Object.freeze([
  'eligible',
  'not_scopable',
  'provenance_not_user',
  'not_evaluated',
  'invalidated',
  'superseded',
  'evaluation_missing',
  'evaluation_stale',
  'evidence_unavailable',
  'unresolved_citation',
  'outcome_evidence_not_current',
  'evaluation_changed',
  'prediction_store_unavailable',
]);

export const MAX_PROPOSAL_LIMITATIONS = 4;

// What a recorded outcome class proposes. This is the whole of the mapping, and it is stated in the
// record so a reader can disagree with it: success proposes preference, failure and block propose
// avoidance. It is an ordering proposal, never a causal claim.
export const OUTCOME_PROPOSAL_FIELD = Object.freeze({
  success: 'prefer',
  failure: 'avoid',
  blocked: 'avoid',
});

export const PROPOSAL_LIMITATIONS = Object.freeze([
  'one recorded evaluation of one expectation is a single observation, not a pattern',
  'the verdict compares the recorded outcome with the user\'s own expectation, not with an external standard',
  'it states which outcome was recorded, not that the capability caused it',
  'the proposal only re-orders approaches in a comparison; it authorizes, refuses, and starts nothing',
]);

function proposalLimitations() {
  return PROPOSAL_LIMITATIONS.slice(0, MAX_PROPOSAL_LIMITATIONS);
}

export function proposalRule(capability, outcomeClass) {
  const field = OUTCOME_PROPOSAL_FIELD[outcomeClass];
  if (field === 'prefer') {
    return `prefer work that names ${capability}: the latest live recorded outcome inside the expectation's horizon was a success`;
  }
  if (field === 'avoid') {
    return `avoid work that names ${capability}: the latest live recorded outcome inside the expectation's horizon was ${outcomeClass}`;
  }
  return null;
}

// A stable identity for one piece of prediction evidence: the prediction, its evaluation, the verdict,
// the deciding outcome class, and the outcome experiences the evaluation cited. Changing any of those
// is a change to the evidence, and the digest is what a reader of the proposal can compare.
export function evidenceDigest({ predictionId, evaluationId, verdict, outcomeClass, outcomeExperienceIds }) {
  return createHash('sha256').update(JSON.stringify({
    predictionId,
    evaluationId,
    verdict,
    outcomeClass,
    outcomeExperienceIds: [...outcomeExperienceIds],
  })).digest('hex');
}

function ineligible(state, reason) {
  return { eligible: false, state, reason };
}

// The outcome class the recorded verdict was read from. A projection of an evaluated prediction keeps
// the evaluation's deciding record id but not its class (the class is a derived read), so the class is
// taken from the deciding experience when the caller supplied the derived log. Without it, the class
// cannot be established and the prediction cannot propose a rule - which is the honest answer.
export function decidingOutcomeOf(projection, experiencesById = null) {
  const recorded = projection?.deciding;
  if (recorded && OUTCOME_PROPOSAL_FIELD[recorded.outcomeClass]) {
    return { id: recorded.id ?? null, outcomeClass: recorded.outcomeClass };
  }
  const id = projection?.evaluation?.decidingExperienceId ?? null;
  if (!id || !experiencesById) return null;
  const record = experiencesById.get(id);
  if (!record || typeof record.outcome !== 'string') return null;
  const cls = outcomeClass(record.outcome);
  if (!OUTCOME_PROPOSAL_FIELD[cls]) return null;
  return { id, outcomeClass: cls };
}

// Judge one projection. `experiencesById` maps derived experience records, so an outcome record that
// a later record corrected is visible as `active: false` without a second store read.
export function predictionEligibility({ projection, experiencesById = null } = {}) {
  if (!projection || typeof projection !== 'object') {
    return ineligible('not_evaluated', 'the prediction ledger did not return this record');
  }
  if (!isScopableCapability(projection.capability)) {
    return ineligible('not_scopable', `its scope "${projection.capability ?? 'none'}" is not a capability name`);
  }
  if (projection.provenance?.origin !== 'user_recorded') {
    return ineligible('provenance_not_user', 'it was not recorded as the user\'s own expectation');
  }
  if (projection.invalidation) {
    return ineligible('invalidated', 'the user withdrew this expectation, so it is not evidence');
  }
  if (projection.retired === true || (projection.supersededBy ?? []).length > 0 || projection.status === 'superseded') {
    return ineligible('superseded', 'a later expectation replaced it, so it is not current evidence');
  }
  if (!projection.evaluation || !projection.evaluation.id) {
    return ineligible('evaluation_missing', 'it carries no recorded evaluation');
  }
  if (projection.status !== 'evaluated') {
    return ineligible('not_evaluated', `the ledger reports it ${projection.status}, and only an evaluated expectation can propose a rule`);
  }
  if (projection.evaluationStale === true) {
    return ineligible('evaluation_stale', 'a read now would settle it differently than the recorded evaluation, so the recorded verdict is not current evidence');
  }
  const lineage = projection.lineage;
  if (!lineage || lineage.available === false) {
    return ineligible('evidence_unavailable', lineage?.reason ?? 'the experience log could not be read, so the outcome evidence cannot be confirmed');
  }
  const unresolved = [
    ...(lineage.atCreation?.unresolvedExperienceIds ?? []),
    ...(lineage.atCreation?.unresolvedFeedbackIds ?? []),
  ];
  if (unresolved.length > 0 || lineage.atCreation?.unavailableDeclared === true) {
    return ineligible('unresolved_citation', `the cited record(s) ${unresolved.map((id) => String(id).slice(0, 8)).join(', ') || 'named by the prediction'} are not in the experience log`);
  }
  const outcomeIds = projection.evaluation.outcomeExperienceIds ?? [];
  if (outcomeIds.length === 0) {
    return ineligible('outcome_evidence_not_current', 'the recorded evaluation cites no outcome experience');
  }
  const deciding = decidingOutcomeOf(projection, experiencesById);
  if (!deciding) {
    return ineligible('outcome_evidence_not_current', 'the evaluation names no deciding outcome class that can propose a rule');
  }
  if (experiencesById) {
    const notCurrent = outcomeIds.filter((id) => {
      const record = experiencesById.get(id);
      return !record || record.active !== true;
    });
    if (notCurrent.length > 0) {
      return ineligible(
        'outcome_evidence_not_current',
        `the outcome experience(s) ${notCurrent.map((id) => String(id).slice(0, 8)).join(', ')} no longer stand as recorded evidence`,
      );
    }
  }
  return { eligible: true, state: 'eligible', reason: null };
}

// The bounded proposal one eligible projection supports. `null` when the projection cannot propose a
// rule, so a caller cannot build one by forgetting to check eligibility first.
export function proposalFor({ projection, experiencesById = null } = {}) {
  const eligibility = predictionEligibility({ projection, experiencesById });
  if (!eligibility.eligible) return null;
  const deciding = decidingOutcomeOf(projection, experiencesById);
  const outcomeClass = deciding.outcomeClass;
  const capability = projection.capability;
  const field = OUTCOME_PROPOSAL_FIELD[outcomeClass];
  const evaluation = projection.evaluation;
  const guidance = {
    order: null,
    avoid: field === 'avoid' ? [capability] : [],
    prefer: field === 'prefer' ? [capability] : [],
    maxSteps: null,
  };
  return {
    type: PREDICTION_PROPOSAL_TYPE,
    dimension: PREDICTION_DECISION_DIMENSION,
    // The ids live in one place: the record's own `support` lists. A verdict names the records it was
    // read from, and the validator cross-checks the two, so there is no second copy to drift.
    verdicts: [{
      predictionId: projection.id,
      evaluationId: evaluation.id,
      capability,
      expectation: projection.expectation,
      verdict: evaluation.verdict,
      outcomeClass,
    }],
    guidance,
    limitations: proposalLimitations(),
    evidenceDigest: evidenceDigest({
      predictionId: projection.id,
      evaluationId: evaluation.id,
      verdict: evaluation.verdict,
      outcomeClass,
      outcomeExperienceIds: evaluation.outcomeExperienceIds,
    }),
  };
}

// The normalized scope-and-rule key the feedback derivation already uses, so a prediction-derived
// proposal cannot duplicate a rule an approved feedback candidate already states for the same scope.
export function proposalKey(capability, rule) {
  return `${capability}\u0000${normalizeRuleText(rule)}`;
}

// Which evidence a candidate rests on, stated in the record's own method. `single_evaluation` is one
// observation; `longitudinal_pattern` is a supported sequence; `repeated_feedback` is the original
// AP-01 derivation. A reader never has to infer the basis from a count.
export function derivationBasis(method) {
  if (method === LONGITUDINAL_DERIVATION_METHOD) return 'longitudinal_pattern';
  if (method === PREDICTION_DERIVATION_METHOD) return 'single_evaluation';
  return 'repeated_feedback';
}

export function isPredictionDerived(method) {
  return method === PREDICTION_DERIVATION_METHOD || method === LONGITUDINAL_DERIVATION_METHOD;
}
