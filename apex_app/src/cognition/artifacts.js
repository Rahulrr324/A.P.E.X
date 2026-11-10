// Typed cognitive artifacts.
//
// Every value that crosses a stage boundary is one of a fixed set of artifacts. This module states
// each artifact's shape once and validates it at the boundary where it is produced or consumed:
// the deterministic stage outputs on their way into the next stage, the model's structured answer,
// the typed action proposal, and the handoff from a proposal to the executive path.
//
// Validation is read-only. A valid artifact is returned by reference, never copied, so a stage
// boundary does not duplicate evidence, claims, or prose and cannot grow them without a bound. A
// malformed or self-contradictory artifact is rejected whole; no field of it is used, displayed as
// authoritative, or executed.
//
// Ownership and origin are not decoration. A cognitive artifact is derived from stored records or
// the user's words; a model artifact is untrusted output whatever it says about itself; a handoff is
// a proposal that has not yet met the action registry. Every result states `authorizes: false`,
// because no artifact in this list grants permission.
import { ACTION_NAME_RE } from '../actions/registry.js';
import { CONTROL_CHARS } from '../util.js';
import {
  BOUNDS, CLAIM_KINDS, DecisionKind, Disclosure, EVIDENCE_VALIDITIES, EvidenceSource, EVIDENCE_STATES,
  Intent, MissingInfo, SourceStatus, Uncertainty, UncertaintyAbout,
} from './vocabulary.js';

export const ARTIFACT_SCHEMA = 1;

export const ArtifactKind = Object.freeze({
  REQUEST_INTERPRETATION: 'request_interpretation',
  RETRIEVED_EVIDENCE: 'retrieved_evidence',
  EVIDENCE_REFERENCE: 'evidence_reference',
  EXTRACTED_CLAIMS: 'extracted_claims',
  CLAIM_ASSESSMENT: 'claim_assessment',
  DELIBERATION_RESULT: 'deliberation_result',
  CLARIFICATION_REQUEST: 'clarification_request',
  GROUNDED_RESPONSE: 'grounded_response',
  MODEL_PROPOSAL: 'model_proposal',
  EXECUTIVE_HANDOFF: 'executive_handoff',
});

export const ArtifactOwner = Object.freeze({
  COGNITIVE: 'cognitive',
  MODEL: 'model',
  EXECUTIVE: 'executive',
});

// `owner` is who produced the artifact; `origin` is where its content came from. They differ where
// the distinction matters: a request interpretation is produced by the cognitive layer from the
// user's words, and an executive handoff is produced by the executive path from model output.
const ARTIFACT_META = Object.freeze({
  [ArtifactKind.REQUEST_INTERPRETATION]: { owner: ArtifactOwner.COGNITIVE, origin: 'user_request', validity: 'derived' },
  [ArtifactKind.RETRIEVED_EVIDENCE]: { owner: ArtifactOwner.COGNITIVE, origin: 'stores', validity: 'read' },
  [ArtifactKind.EVIDENCE_REFERENCE]: { owner: ArtifactOwner.COGNITIVE, origin: 'stores', validity: 'reference' },
  [ArtifactKind.EXTRACTED_CLAIMS]: { owner: ArtifactOwner.COGNITIVE, origin: 'stores', validity: 'derived' },
  [ArtifactKind.CLAIM_ASSESSMENT]: { owner: ArtifactOwner.COGNITIVE, origin: 'stores', validity: 'derived' },
  [ArtifactKind.DELIBERATION_RESULT]: { owner: ArtifactOwner.COGNITIVE, origin: 'cognitive', validity: 'derived' },
  [ArtifactKind.CLARIFICATION_REQUEST]: { owner: ArtifactOwner.COGNITIVE, origin: 'user_request', validity: 'derived' },
  [ArtifactKind.GROUNDED_RESPONSE]: { owner: ArtifactOwner.MODEL, origin: 'model', validity: 'unverified' },
  [ArtifactKind.MODEL_PROPOSAL]: { owner: ArtifactOwner.MODEL, origin: 'model', validity: 'untrusted' },
  [ArtifactKind.EXECUTIVE_HANDOFF]: { owner: ArtifactOwner.EXECUTIVE, origin: 'model', validity: 'pending_authorization' },
});

const MAX_ENTITIES = 6;
const MAX_REFS = 4;
const MAX_ITEMS = 8;
const MAX_DISCLOSURES = 16;
const MAX_LIST = 16;
const MAX_ANSWER_CHARS = 12000;
const MAX_CLAIM_CHARS = 500;
const MAX_REASON_CHARS = 600;
const MAX_PROBLEMS = 8;

const INTENTS = new Set(Object.values(Intent));
const MISSING = new Set(Object.values(MissingInfo));
const CLAIM_KIND_SET = new Set(CLAIM_KINDS);
const EVIDENCE_STATE_SET = new Set(EVIDENCE_STATES);
const DECISIONS = new Set(Object.values(DecisionKind));
const DISCLOSURES = new Set(Object.values(Disclosure));
const UNCERTAINTIES = new Set(Object.values(Uncertainty));
const UNCERTAINTY_ABOUT = new Set(Object.values(UncertaintyAbout));
const SOURCES = new Set(Object.values(EvidenceSource));
const SOURCE_STATUS = new Set(Object.values(SourceStatus));
const VALIDITY_SET = new Set(EVIDENCE_VALIDITIES);
const CONCLUSION_KINDS = new Set(['clarify', 'refuse', 'unknown', 'conflicting', 'partial', 'supported']);
const RESPONSE_CLAIM_KINDS = new Set(['supported', 'partially_supported', 'historical', 'inference', 'assumption', 'general_knowledge', 'unknown', 'recommendation']);
const REF = /^ev:[a-z_]+:[A-Za-z0-9_.:-]{1,200}$/;
const CLAIM_ID = /^cl:[1-9][0-9]?$/;
const PROPOSAL_ID = /^mp:[1-9][0-9]?$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMap(value) {
  return value instanceof Map;
}

function isText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value);
}

function isOptionalText(value, max) {
  return value === null || value === undefined || isText(value, max);
}

function isEvidenceRef(value) {
  if (typeof value !== 'string' || !REF.test(value)) return false;
  return SOURCES.has(value.slice(3, value.indexOf(':', 3)));
}

function isClaimId(value) {
  return typeof value === 'string' && CLAIM_ID.test(value);
}

function isStringArray(value, max = MAX_ITEMS) {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string');
}

function isEvidenceRefArray(value, max = MAX_ITEMS) {
  return Array.isArray(value) && value.length <= max && value.every(isEvidenceRef);
}

function isClaimIdArray(value, max = MAX_ITEMS) {
  return Array.isArray(value) && value.length <= max && value.every(isClaimId);
}

function reject(kind, problems) {
  return { schema: ARTIFACT_SCHEMA, kind, ...ARTIFACT_META[kind], authorizes: false, ok: false, problems: problems.slice(0, MAX_PROBLEMS) };
}

function accept(kind) {
  return { schema: ARTIFACT_SCHEMA, kind, ...ARTIFACT_META[kind], authorizes: false, ok: true, problems: [] };
}

// ---- validators -------------------------------------------------------------------------------

function validateRequestInterpretation(value) {
  const problems = [];
  if (!INTENTS.has(value.intent)) problems.push('request_interpretation.intent is not a known intent');
  if (value.authorization?.granted !== false) {
    problems.push('request_interpretation.authorization.granted must be false; an interpretation is not permission');
  }
  if (value.executionRequested !== undefined && typeof value.executionRequested !== 'boolean') {
    problems.push('request_interpretation.executionRequested must be a boolean');
  }
  if (!Array.isArray(value.intents) || value.intents.length > MAX_LIST || !value.intents.every((intent) => INTENTS.has(intent))) {
    problems.push('request_interpretation.intents must be a bounded list of known intents');
  }
  if (!Array.isArray(value.entities) || value.entities.length > MAX_ENTITIES) {
    problems.push(`request_interpretation.entities must hold at most ${MAX_ENTITIES} matches`);
  } else {
    value.entities.forEach((entity, index) => {
      const at = `request_interpretation.entities[${index}]`;
      if (!isObject(entity)) { problems.push(`${at} must be an object`); return; }
      if (typeof entity.id !== 'string' || entity.id.length === 0) problems.push(`${at}.id must be a non-empty string`);
      if (typeof entity.name !== 'string') problems.push(`${at}.name must be a string`);
      if (typeof entity.ambiguous !== 'boolean') problems.push(`${at}.ambiguous must be a boolean`);
      if (entity.ambiguous === true && (!Array.isArray(entity.candidates) || entity.candidates.length === 0)) {
        problems.push(`${at} is marked ambiguous but names no candidates`);
      }
    });
  }
  for (const field of ['goals', 'plans', 'tasks']) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > MAX_REFS) {
      problems.push(`request_interpretation.${field} must hold at most ${MAX_REFS} references`);
      continue;
    }
    list.forEach((ref, index) => {
      const at = `request_interpretation.${field}[${index}]`;
      if (!isObject(ref)) { problems.push(`${at} must be an object`); return; }
      if (typeof ref.ref !== 'string' || ref.ref.length === 0) problems.push(`${at}.ref must be a non-empty string`);
      if (ref.id !== null && typeof ref.id !== 'string') problems.push(`${at}.id must be a string or null`);
      if (typeof ref.ambiguous !== 'boolean') problems.push(`${at}.ambiguous must be a boolean`);
    });
  }
  if (!Array.isArray(value.missing) || value.missing.length > MAX_LIST
    || !value.missing.every((item) => isObject(item) && MISSING.has(item.code))) {
    problems.push('request_interpretation.missing must be a bounded list of known missing-information codes');
  }
  if (!Array.isArray(value.ambiguities) || value.ambiguities.length > MAX_LIST) {
    problems.push('request_interpretation.ambiguities must be a bounded list');
  }
  if (!isOptionalText(value.clarification, MAX_REASON_CHARS)) {
    problems.push('request_interpretation.clarification must be null or bounded text');
  }
  return problems;
}

function validateRetrievedEvidence(value) {
  const problems = [];
  const evidence = value.evidence;
  if (!Array.isArray(evidence) || evidence.length > BOUNDS.maxEvidenceTotal) {
    problems.push(`retrieved_evidence.evidence must hold at most ${BOUNDS.maxEvidenceTotal} records`);
    return problems;
  }
  if (!isMap(value.byId) || value.byId.size !== evidence.length) {
    problems.push('retrieved_evidence.byId must index every kept evidence record exactly once');
  }
  const seen = new Set();
  const unavailable = new Set(Array.isArray(value.counts?.unavailable) ? value.counts.unavailable : []);
  evidence.forEach((item, index) => {
    const at = `retrieved_evidence.evidence[${index}]`;
    if (!isObject(item)) { problems.push(`${at} must be an object`); return; }
    if (!isEvidenceRef(item.evidenceId)) problems.push(`${at}.evidenceId is not a well-formed evidence reference`);
    else if (seen.has(item.evidenceId)) problems.push(`${at}.evidenceId is a duplicate`);
    else seen.add(item.evidenceId);
    if (!SOURCES.has(item.source)) problems.push(`${at}.source is not a known evidence source`);
    else if (unavailable.has(item.source)) problems.push(`${at}.source is reported unavailable but supplied a record`);
    if (typeof item.recordId !== 'string') problems.push(`${at}.recordId must be a string`);
    if (typeof item.claim !== 'string' || item.claim.length > BOUNDS.maxClaimChars) problems.push(`${at}.claim is not bounded text`);
    if (typeof item.current !== 'boolean') problems.push(`${at}.current must be a boolean`);
    if (item.validity !== undefined && !VALIDITY_SET.has(item.validity)) problems.push(`${at}.validity is not a known evidence validity`);
    if (!isObject(item.provenance)) problems.push(`${at}.provenance must be an object`);
    if (isMap(value.byId) && value.byId.get(item.evidenceId) !== item) {
      problems.push(`${at} is not the object indexed under its own evidence id`);
    }
  });
  if (!isObject(value.counts) || value.counts.total !== evidence.length) {
    problems.push('retrieved_evidence.counts.total must equal the kept evidence count');
  } else if (!Number.isInteger(value.counts.dropped) || value.counts.dropped < 0) {
    problems.push('retrieved_evidence.counts.dropped must be a non-negative integer');
  }
  if (!Array.isArray(value.sources) || !value.sources.every((entry) => isObject(entry) && SOURCE_STATUS.has(entry.status))) {
    problems.push('retrieved_evidence.sources must be a list of known source statuses');
  }
  return problems;
}

function validateEvidenceReference(value) {
  return isEvidenceRef(value) ? [] : ['evidence_reference must be a well-formed ev:<source>:<record> reference'];
}

function claimProblems(claim, at, { requireSupport }) {
  const problems = [];
  if (!isObject(claim)) return [`${at} must be an object`];
  if (!isClaimId(claim.claimId)) problems.push(`${at}.claimId is not a claim identifier`);
  if (typeof claim.text !== 'string' || claim.text.length === 0 || claim.text.length > BOUNDS.maxClaimText || CONTROL_CHARS.test(claim.text)) {
    problems.push(`${at}.text must be non-empty bounded text without control characters`);
  }
  if (!CLAIM_KIND_SET.has(claim.kind)) problems.push(`${at}.kind is not a known claim kind`);
  if (!isEvidenceRefArray(claim.evidenceIds)) problems.push(`${at}.evidenceIds must be a bounded list of evidence references`);
  if (!EVIDENCE_STATE_SET.has(claim.evidenceState)) problems.push(`${at}.evidenceState is not a known evidence state`);
  if (typeof claim.material !== 'boolean') problems.push(`${at}.material must be a boolean`);
  if (typeof claim.current !== 'boolean') problems.push(`${at}.current must be a boolean`);
  for (const field of ['contradicts', 'duplicateOf']) {
    if (claim[field] !== undefined && (!Array.isArray(claim[field]) || claim[field].length > 12
      || !claim[field].every((entry) => isClaimId(entry) || isEvidenceRef(entry)))) {
      problems.push(`${at}.${field} must be a bounded list of claim or evidence references`);
    }
  }
  if (claim.validity !== undefined && !VALIDITY_SET.has(claim.validity)) problems.push(`${at}.validity is not a known evidence validity`);
  // The lineage is a claim's own bounded record of what it rested on. It may not name records this
  // request did not retrieve, and it may not grow without a bound.
  if (claim.lineage !== undefined) {
    if (!isObject(claim.lineage)) problems.push(`${at}.lineage must be an object`);
    else {
      for (const field of ['supports', 'contradicts']) {
        if (!isEvidenceRefArray(claim.lineage[field] ?? [], BOUNDS.maxLineageRefs)) {
          problems.push(`${at}.lineage.${field} must be a bounded list of evidence references`);
        }
      }
      if (!isClaimIdArray(claim.lineage.claimLinks ?? [], BOUNDS.maxLineageRefs)) {
        problems.push(`${at}.lineage.claimLinks must be a bounded list of claim ids`);
      }
      if (claim.lineage.validity !== undefined && !VALIDITY_SET.has(claim.lineage.validity)) {
        problems.push(`${at}.lineage.validity is not a known evidence validity`);
      }
    }
  }
  // A material claim that names no evidence is exactly the contradiction this contract exists to
  // catch: it would be shown as supported by records that were never cited.
  if (requireSupport && claim.material === true && Array.isArray(claim.evidenceIds) && claim.evidenceIds.length === 0) {
    problems.push(`${at} is material but cites no evidence`);
  }
  return problems;
}

function validateExtractedClaims(value) {
  const problems = [];
  const claims = value.claims;
  if (!Array.isArray(claims) || claims.length > BOUNDS.maxClaims) {
    problems.push(`extracted_claims.claims must hold at most ${BOUNDS.maxClaims} claims`);
    return problems;
  }
  if (!isMap(value.byId) || value.byId.size !== claims.length) {
    problems.push('extracted_claims.byId must index every claim exactly once');
  }
  if (!isMap(value.forEvidence)) {
    problems.push('extracted_claims.forEvidence must be a map of evidence id to claim ids');
  } else {
    for (const [id, claimIds] of value.forEvidence) {
      if (!isEvidenceRef(id)) problems.push('extracted_claims.forEvidence has a key that is not an evidence reference');
      if (!isClaimIdArray(claimIds, BOUNDS.maxClaims)) problems.push('extracted_claims.forEvidence has a value that is not a list of claim ids');
    }
  }
  const seen = new Set();
  claims.forEach((claim, index) => {
    const at = `extracted_claims.claims[${index}]`;
    problems.push(...claimProblems(claim, at, { requireSupport: true }));
    if (isObject(claim) && isClaimId(claim.claimId)) {
      if (seen.has(claim.claimId)) problems.push(`${at}.claimId is a duplicate`);
      seen.add(claim.claimId);
      if (isMap(value.byId) && value.byId.get(claim.claimId) !== claim) {
        problems.push(`${at} is not the object indexed under its own claim id`);
      }
    }
  });
  if (isObject(value.counts) && value.counts.total !== claims.length) {
    problems.push('extracted_claims.counts.total must equal the claim count');
  }
  return problems;
}

function validateClaimAssessment(value) {
  return claimProblems(value, 'claim_assessment', { requireSupport: false });
}

function validateDeliberationResult(value, context = {}) {
  const problems = [];
  if (!DECISIONS.has(value.decision)) problems.push('deliberation_result.decision is not a known decision');
  const conclusion = value.conclusion;
  if (!isObject(conclusion)) problems.push('deliberation_result.conclusion must be an object');
  else {
    if (!CONCLUSION_KINDS.has(conclusion.kind)) problems.push('deliberation_result.conclusion.kind is not a known conclusion kind');
    if (!isClaimIdArray(conclusion.claimIds, BOUNDS.maxClaims)) problems.push('deliberation_result.conclusion.claimIds must be a bounded list of claim ids');
    if (!isEvidenceRefArray(conclusion.evidenceIds, BOUNDS.maxEvidenceTotal)) problems.push('deliberation_result.conclusion.evidenceIds must be a bounded list of evidence references');
    if (isClaimIdArray(conclusion.claimIds, BOUNDS.maxClaims) && Array.isArray(context.claimIds)) {
      for (const id of conclusion.claimIds) {
        if (!context.claimIds.includes(id)) problems.push('deliberation_result.conclusion names a claim that was not extracted');
      }
    }
  }
  const uncertainty = value.uncertainty;
  if (!isObject(uncertainty)) problems.push('deliberation_result.uncertainty must be an object');
  else {
    if (!UNCERTAINTIES.has(uncertainty.category)) problems.push('deliberation_result.uncertainty.category is not a known category');
    if (!UNCERTAINTY_ABOUT.has(uncertainty.about)) problems.push('deliberation_result.uncertainty.about is not a known subject');
    if (!isText(uncertainty.reason, MAX_REASON_CHARS)) problems.push('deliberation_result.uncertainty.reason must be bounded text');
  }
  const clarification = value.clarification;
  if (!isObject(clarification) || typeof clarification.needed !== 'boolean') {
    problems.push('deliberation_result.clarification must be an object with a boolean needed');
  } else {
    if (clarification.needed && !isText(clarification.question, MAX_REASON_CHARS)) {
      problems.push('deliberation_result.clarification is needed but names no question');
    }
    if (clarification.needed && value.decision !== DecisionKind.CLARIFY) {
      problems.push('deliberation_result requires clarification but its decision is not clarify');
    }
    if (!clarification.needed && clarification.question !== null && clarification.question !== undefined) {
      problems.push('deliberation_result clarification is not needed but carries a question');
    }
  }
  if (!Array.isArray(value.disclosures) || value.disclosures.length > MAX_DISCLOSURES
    || !value.disclosures.every((code) => DISCLOSURES.has(code))) {
    problems.push('deliberation_result.disclosures must be a bounded list of known disclosure codes');
  }
  if (!isObject(value.validation) || typeof value.validation.ok !== 'boolean' || !Array.isArray(value.validation.problems)) {
    problems.push('deliberation_result.validation must state ok and problems');
  }
  if (value.recommendation !== null && value.recommendation !== undefined) {
    const rec = value.recommendation;
    if (!isObject(rec)) problems.push('deliberation_result.recommendation must be null or an object');
    else {
      if (typeof rec.text !== 'string') problems.push('deliberation_result.recommendation.text must be a string');
      if (rec.executed !== false) problems.push('deliberation_result.recommendation must never be marked executed');
      if (typeof rec.requiresAuthorization !== 'boolean') problems.push('deliberation_result.recommendation must state whether it requires authorization');
      if (!isEvidenceRefArray(rec.evidenceIds ?? [], BOUNDS.maxEvidenceTotal)) problems.push('deliberation_result.recommendation.evidenceIds must be a bounded list of evidence references');
    }
  }
  if (!Array.isArray(value.subquestions) || value.subquestions.length > BOUNDS.maxSubquestions) {
    problems.push('deliberation_result.subquestions must be a bounded list');
  }
  return problems;
}

function validateClarificationRequest(value) {
  const problems = [];
  if (!isObject(value) || typeof value.needed !== 'boolean') return ['clarification_request must be an object with a boolean needed'];
  if (value.needed) {
    if (!isText(value.question, MAX_REASON_CHARS)) problems.push('clarification_request.question is required when clarification is needed');
    if (!MISSING.has(value.missing)) problems.push('clarification_request.missing must be a known missing-information code');
  } else {
    if (value.question !== null && value.question !== undefined) problems.push('clarification_request.question must be null when clarification is not needed');
    if (value.missing !== null && value.missing !== undefined) problems.push('clarification_request.missing must be null when clarification is not needed');
  }
  if (!isOptionalText(value.reason, MAX_REASON_CHARS)) problems.push('clarification_request.reason must be null or bounded text');
  return problems;
}

function validateGroundedResponse(value) {
  const problems = [];
  if (value.schema !== 1) problems.push('grounded_response.schema must be 1');
  if (!DECISIONS.has(value.decision)) problems.push('grounded_response.decision is not a known decision');
  if (!isText(value.answer, MAX_ANSWER_CHARS)) problems.push('grounded_response.answer must be bounded non-empty text');
  if (value.claims !== undefined) {
    if (!Array.isArray(value.claims) || value.claims.length > BOUNDS.maxStructuredClaims) {
      problems.push(`grounded_response.claims must hold at most ${BOUNDS.maxStructuredClaims} claims`);
    } else {
      value.claims.forEach((claim, index) => {
        const at = `grounded_response.claims[${index}]`;
        if (!isObject(claim)) { problems.push(`${at} must be an object`); return; }
        if (!isText(claim.text, MAX_CLAIM_CHARS)) problems.push(`${at}.text must be bounded non-empty text`);
        if (!RESPONSE_CLAIM_KINDS.has(claim.kind)) problems.push(`${at}.kind is not a claim kind a grounded response may use`);
        if (!isEvidenceRefArray(claim.evidenceIds ?? claim.evidence ?? [], MAX_ITEMS)) problems.push(`${at}.evidenceIds must be a bounded list of evidence references`);
        if (!EVIDENCE_STATE_SET.has(claim.evidenceState)) problems.push(`${at}.evidenceState is not a known evidence state`);
      });
    }
  }
  if (value.uncertainty !== null && value.uncertainty !== undefined && !UNCERTAINTIES.has(value.uncertainty)) {
    problems.push('grounded_response.uncertainty is not a known category');
  }
  if (!Array.isArray(value.disclosures) || value.disclosures.length > MAX_DISCLOSURES
    || !value.disclosures.every((code) => DISCLOSURES.has(code))) {
    problems.push('grounded_response.disclosures must be a bounded list of known codes');
  }
  if (!Array.isArray(value.missing) || value.missing.length > MAX_ITEMS || !value.missing.every((code) => MISSING.has(code))) {
    problems.push('grounded_response.missing must be a bounded list of known codes');
  }
  if (value.recommendation !== null && value.recommendation !== undefined) {
    const rec = value.recommendation;
    if (!isObject(rec) || !isText(rec.text, MAX_CLAIM_CHARS)) problems.push('grounded_response.recommendation must carry bounded text');
    else {
      if (rec.command !== null && rec.command !== undefined && typeof rec.command !== 'string') problems.push('grounded_response.recommendation.command must be a string or null');
      if (rec.executed !== false) problems.push('grounded_response.recommendation must never be marked executed');
    }
  }
  return problems;
}

const PROPOSAL_KEYS = new Set(['type', 'proposalId', 'action', 'input', 'origin', 'trusted', 'authority']);

function proposalProblems(value, at) {
  const problems = [];
  for (const key of Object.keys(value)) {
    if (key === 'executed' || key === 'approved' || key === 'authorization' || key === 'verified' || key === 'permission') {
      problems.push(`${at}.${key} is not allowed; a proposal cannot assert approval, authorization, execution, or verification`);
    } else if (!PROPOSAL_KEYS.has(key)) {
      problems.push(`${at}.${key} is not a proposal field`);
    }
  }
  if (value.type !== 'model_action_proposal') problems.push(`${at}.type must be model_action_proposal`);
  if (!PROPOSAL_ID.test(value.proposalId ?? '')) problems.push(`${at}.proposalId is not a proposal identifier`);
  if (typeof value.action !== 'string' || !ACTION_NAME_RE.test(value.action)) problems.push(`${at}.action is not a valid action name`);
  if (!isObject(value.input)) problems.push(`${at}.input must be an object of named parameters`);
  if (value.origin !== 'model') problems.push(`${at}.origin must be model`);
  if (value.trusted !== false) problems.push(`${at}.trusted must be false; model output is untrusted input`);
  if (value.authority !== 'none') problems.push(`${at}.authority must be none`);
  return problems;
}

function validateModelProposal(value) {
  if (!isObject(value)) return ['model_proposal must be an object'];
  return proposalProblems(value, 'model_proposal');
}

// The handoff is the exact moment a proposal leaves the cognitive/model side and enters the
// executive path. It may name what to do, and nothing else: no authorization, no approval, no
// execution, and no claim that either happened. Authorization is the registry's decision, made
// after this record exists, on this request.
const HANDOFF_KEYS = new Set([...PROPOSAL_KEYS, 'authorization', 'executed']);

function validateExecutiveHandoff(value) {
  if (!isObject(value)) return ['executive_handoff must be an object'];
  const problems = [];
  if (typeof value.proposalId !== 'string' || value.proposalId.length === 0 || value.proposalId.length > 200) {
    problems.push('executive_handoff.proposalId must be a non-empty bounded string');
  }
  if (typeof value.action !== 'string' || !ACTION_NAME_RE.test(value.action)) problems.push('executive_handoff.action is not a valid action name');
  if (!isObject(value.input)) problems.push('executive_handoff.input must be an object of named parameters');
  if (value.origin !== 'model') problems.push('executive_handoff.origin must be model');
  if (value.trusted !== false) problems.push('executive_handoff.trusted must be false; model output is untrusted input');
  if (value.authority !== 'none') problems.push('executive_handoff.authority must be none');
  if (value.authorization !== null && value.authorization !== undefined) {
    problems.push('executive_handoff.authorization must be null; the handoff has not been authorized yet');
  }
  if (value.executed !== false) problems.push('executive_handoff.executed must be false; a handoff is not an execution');
  for (const key of Object.keys(value)) {
    if (!HANDOFF_KEYS.has(key)) problems.push(`executive_handoff.${key} is not a handoff field`);
  }
  return problems;
}

const VALIDATORS = Object.freeze({
  [ArtifactKind.REQUEST_INTERPRETATION]: (value) => (isObject(value) ? validateRequestInterpretation(value) : ['request_interpretation must be an object']),
  [ArtifactKind.RETRIEVED_EVIDENCE]: (value) => (isObject(value) ? validateRetrievedEvidence(value) : ['retrieved_evidence must be an object']),
  [ArtifactKind.EVIDENCE_REFERENCE]: validateEvidenceReference,
  [ArtifactKind.EXTRACTED_CLAIMS]: (value) => (isObject(value) ? validateExtractedClaims(value) : ['extracted_claims must be an object']),
  [ArtifactKind.CLAIM_ASSESSMENT]: (value) => validateClaimAssessment(value),
  [ArtifactKind.DELIBERATION_RESULT]: validateDeliberationResult,
  [ArtifactKind.CLARIFICATION_REQUEST]: validateClarificationRequest,
  [ArtifactKind.GROUNDED_RESPONSE]: (value) => (isObject(value) ? validateGroundedResponse(value) : ['grounded_response must be an object']),
  [ArtifactKind.MODEL_PROPOSAL]: validateModelProposal,
  [ArtifactKind.EXECUTIVE_HANDOFF]: validateExecutiveHandoff,
});

// Validates one artifact. The value is not copied and is not otherwise changed, so a valid artifact
// crosses a boundary once and a large retrieval or claim set is never duplicated.
export function validateArtifact(kind, value, context = {}) {
  const validator = VALIDATORS[kind];
  if (!validator) return reject(kind, [`unknown artifact kind: ${String(kind).slice(0, 40)}`]);
  const problems = validator(value, context);
  return problems.length > 0 ? reject(kind, problems) : accept(kind);
}

export class ArtifactValidationError extends Error {
  constructor(kind, problems) {
    super(`artifact ${kind} did not validate: ${problems.slice(0, 3).join('; ')}`.slice(0, 300));
    this.name = 'ArtifactValidationError';
    this.code = 'ARTIFACT_INVALID';
    this.kind = kind;
    this.problems = problems.slice(0, 4);
  }
}

export function assertArtifact(kind, value, context = {}) {
  const result = validateArtifact(kind, value, context);
  if (!result.ok) throw new ArtifactValidationError(kind, result.problems);
  return value;
}

// Validates every artifact the deterministic cognitive stages produce for one request, and returns a
// bounded summary for the audit. This is not a second analysis: it reads the same objects and states
// whether their contracts hold. Any failure means the analysis must not be presented as a reading of
// the records, so the engine fails the stage closed.
export function validateAnalysisArtifacts({ understanding, retrieval, claims, deliberation } = {}) {
  const artifacts = [];
  const problems = [];
  const check = (kind, value, context) => {
    const result = validateArtifact(kind, value, context);
    artifacts.push({ kind, owner: result.owner, ok: result.ok, count: countOf(kind, value) });
    problems.push(...result.problems);
    return result.ok;
  };

  check(ArtifactKind.REQUEST_INTERPRETATION, understanding);
  check(ArtifactKind.RETRIEVED_EVIDENCE, retrieval);
  check(ArtifactKind.EXTRACTED_CLAIMS, claims);
  const claimIds = Array.isArray(claims?.claims) ? claims.claims.map((claim) => claim.claimId) : [];
  check(ArtifactKind.DELIBERATION_RESULT, deliberation, { claimIds });
  check(ArtifactKind.CLARIFICATION_REQUEST, deliberation?.clarification);
  let assessmentsOk = true;
  const claimList = Array.isArray(claims?.claims) ? claims.claims.slice(0, BOUNDS.maxClaims) : [];
  for (const claim of claimList) {
    const result = validateArtifact(ArtifactKind.CLAIM_ASSESSMENT, claim);
    if (!result.ok) {
      assessmentsOk = false;
      problems.push(...result.problems);
      break;
    }
  }
  artifacts.push({ kind: ArtifactKind.CLAIM_ASSESSMENT, owner: ARTIFACT_META[ArtifactKind.CLAIM_ASSESSMENT].owner, ok: assessmentsOk, count: claimList.length });

  return {
    schema: ARTIFACT_SCHEMA,
    ok: problems.length === 0,
    artifacts,
    problems: problems.slice(0, MAX_PROBLEMS),
  };
}

function countOf(kind, value) {
  switch (kind) {
    case ArtifactKind.RETRIEVED_EVIDENCE: return Array.isArray(value?.evidence) ? value.evidence.length : 0;
    case ArtifactKind.EXTRACTED_CLAIMS: return Array.isArray(value?.claims) ? value.claims.length : 0;
    default: return 1;
  }
}
