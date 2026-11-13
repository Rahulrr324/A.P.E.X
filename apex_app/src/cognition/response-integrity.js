// Grounded response integrity: the request-to-response contract, the model-output trust boundary,
// and the assessment that keeps a fluent answer from acquiring authority it was never given.
//
// Three fixed sets live here, and none of them is inferred from model text:
//
//   - RESPONSE_STAGES names the fourteen stages a request passes through on its way to an answer.
//     A stage that was skipped, that ran and produced nothing, and that was never reached are three
//     different records. Only the final handoff stage can carry a proposal toward the registry, and
//     even there the authority is the registry's, not the stage's.
//   - ResponseTrustState separates received from syntactically valid, from accepted for presentation,
//     from factually supported, from verified by APEX. This build never reports `verified` for model
//     prose: no independent check of a model's sentence exists, so the top of the ladder stays empty.
//   - ResponseFinding keeps the seven ways evidence can fail separate. Disagreement is not disproof;
//     a missing record is not a false one; an unread store is not an empty one.
//
// The assessment is read-only and bounded. It carries identifiers, states, and counts, never the
// request, evidence text, or model prose, and every record it produces says `authorizes: false`.
import { EvidenceState } from './vocabulary.js';

export const RESPONSE_CONTRACT_SCHEMA = 1;

export const ResponseStage = Object.freeze({
  REQUEST_RECEIVED: 'request_received',
  REQUEST_CLASSIFICATION: 'request_classification',
  CONTEXT_RETRIEVAL: 'context_retrieval',
  EVIDENCE_SNAPSHOT_VALIDATION: 'evidence_snapshot_validation',
  CLAIM_EXTRACTION: 'claim_extraction',
  CONTRADICTION_ANALYSIS: 'contradiction_analysis',
  DELIBERATION: 'deliberation',
  UNCERTAINTY_ASSESSMENT: 'uncertainty_assessment',
  MODEL_REQUEST_PREPARATION: 'model_request_preparation',
  MODEL_OUTPUT_CLASSIFICATION: 'model_output_classification',
  RESPONSE_CONSTRUCTION: 'response_construction',
  GROUNDING_VALIDATION: 'grounding_validation',
  FINAL_RESPONSE: 'final_response',
  EXECUTIVE_HANDOFF: 'executive_handoff',
});

export const RESPONSE_STAGES = Object.freeze([
  Object.freeze({ order: 1, id: ResponseStage.REQUEST_RECEIVED, name: 'user request received', owner: 'user', readOnly: true, authority: 'none', evidenceRequirement: 'request' }),
  Object.freeze({ order: 2, id: ResponseStage.REQUEST_CLASSIFICATION, name: 'request classification', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'request' }),
  Object.freeze({ order: 3, id: ResponseStage.CONTEXT_RETRIEVAL, name: 'context retrieval', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'stores' }),
  Object.freeze({ order: 4, id: ResponseStage.EVIDENCE_SNAPSHOT_VALIDATION, name: 'evidence snapshot and integrity validation', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'stores' }),
  Object.freeze({ order: 5, id: ResponseStage.CLAIM_EXTRACTION, name: 'claim extraction', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'stores' }),
  Object.freeze({ order: 6, id: ResponseStage.CONTRADICTION_ANALYSIS, name: 'contradiction analysis', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'stores' }),
  Object.freeze({ order: 7, id: ResponseStage.DELIBERATION, name: 'deliberation', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'derived' }),
  Object.freeze({ order: 8, id: ResponseStage.UNCERTAINTY_ASSESSMENT, name: 'uncertainty and limitation assessment', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'derived' }),
  Object.freeze({ order: 9, id: ResponseStage.MODEL_REQUEST_PREPARATION, name: 'model request preparation', owner: 'controller', readOnly: true, authority: 'none', evidenceRequirement: 'derived' }),
  Object.freeze({ order: 10, id: ResponseStage.MODEL_OUTPUT_CLASSIFICATION, name: 'model-output classification', owner: 'gateway', readOnly: true, authority: 'none', evidenceRequirement: 'model' }),
  Object.freeze({ order: 11, id: ResponseStage.RESPONSE_CONSTRUCTION, name: 'response construction', owner: 'model', readOnly: false, authority: 'none', evidenceRequirement: 'model' }),
  Object.freeze({ order: 12, id: ResponseStage.GROUNDING_VALIDATION, name: 'grounding and provenance validation', owner: 'cognition', readOnly: true, authority: 'none', evidenceRequirement: 'derived' }),
  Object.freeze({ order: 13, id: ResponseStage.FINAL_RESPONSE, name: 'final response', owner: 'controller', readOnly: false, authority: 'none', evidenceRequirement: 'derived' }),
  Object.freeze({ order: 14, id: ResponseStage.EXECUTIVE_HANDOFF, name: 'executive proposal and handoff', owner: 'executive', readOnly: false, authority: 'proposal_only', evidenceRequirement: 'derived' }),
]);

export const ResponseStageStatus = Object.freeze({
  RAN: 'ran',
  RAN_NO_RESULT: 'ran_no_result',
  SKIPPED: 'skipped',
  NOT_REACHED: 'not_reached',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
});

export const ResponseTrustState = Object.freeze({
  RECEIVED: 'received',
  SYNTACTICALLY_VALID: 'syntactically_valid',
  ACCEPTED_FOR_PRESENTATION: 'accepted_for_presentation',
  FACTUALLY_SUPPORTED: 'factually_supported',
  VERIFIED: 'verified',
});

export const RESPONSE_TRUST_STATES = Object.freeze(Object.values(ResponseTrustState));

export const ResponseFindingKind = Object.freeze({
  UNKNOWN: 'unknown',
  NOT_FOUND: 'not_found',
  NOT_CHECKED: 'not_checked',
  UNAVAILABLE: 'unavailable',
  CONFLICTING: 'conflicting',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  EXPLICITLY_DISPROVEN: 'explicitly_disproven',
});

export const RESPONSE_FINDING_KINDS = Object.freeze(Object.values(ResponseFindingKind));

export const ResponseDegradation = Object.freeze({
  NO_OUTPUT: 'no_output',
  PRESENT_WITH_LIMITATIONS: 'present_with_limitations',
  PRESENT_AS_IS: 'present_as_is',
});

export const RESPONSE_AUTHORITY = Object.freeze({
  authorizes: false,
  factualAuthority: 'none',
  executionAuthority: 'none',
  authorizationOwner: 'action_registry',
  modelOutputGrantsAuthorization: false,
  statement: 'A grounded response reports what the records support. It neither verifies model prose nor authorizes an action; only the action registry does that.',
});

const STAGE_BY_ORDER = new Map(RESPONSE_STAGES.map((stage) => [stage.order, stage]));
const OUTCOMES = new Set(Object.values(ResponseStageStatus));
const MAX_STAGE_COUNTS = 8;
const MAX_LIMITATIONS = 10;

// The claim kinds that assert a stored fact. Only these have to restate a cited record; an inference,
// an assumption, a general-knowledge sentence, and an unknown are labelled as such by the model and
// are not presented as copied from a record.
const FACTUAL_KINDS = new Set(['supported', 'partially_supported', 'historical']);
const SUPPORTED_STATES = new Set([EvidenceState.DIRECTLY_SUPPORTED, EvidenceState.PARTIALLY_SUPPORTED]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'with', 'that', 'this', 'from',
  'into', 'but', 'not', 'its', 'his', 'her', 'their', 'our', 'you', 'your', 'they', 'them', 'then',
  'than', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'about', 'would',
  'could', 'should', 'will', 'shall', 'may', 'might', 'must', 'been', 'being', 'does', 'did', 'done',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainCounts(counts, max = MAX_STAGE_COUNTS) {
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (keys >= max) break;
    if (!/^[a-z][a-z0-9_]{0,24}$/.test(key)) continue;
    if (!Number.isFinite(value) || value < 0) continue;
    out[key] = Math.trunc(value);
    keys += 1;
  }
  return out;
}

function lifecycleStages(lifecycle) {
  if (!lifecycle) return new Map();
  const snapshot = typeof lifecycle.snapshot === 'function' ? lifecycle.snapshot() : lifecycle;
  const stages = snapshot?.stages;
  const map = new Map();
  for (const entry of Array.isArray(stages) ? stages : []) {
    if (Number.isInteger(entry?.order)) map.set(entry.order, entry);
  }
  return map;
}

function lifecycleStatus(byOrder, order) {
  const status = byOrder.get(order)?.status;
  if (status === 'ran') return ResponseStageStatus.RAN;
  if (status === 'failed') return ResponseStageStatus.FAILED;
  if (status === 'skipped') return ResponseStageStatus.SKIPPED;
  if (status === 'unavailable') return ResponseStageStatus.UNAVAILABLE;
  if (status === 'not_reached') return ResponseStageStatus.NOT_REACHED;
  return null;
}

function stage(order, status, counts = {}) {
  const definition = STAGE_BY_ORDER.get(order);
  return {
    order,
    id: definition.id,
    status: OUTCOMES.has(status) ? status : ResponseStageStatus.UNAVAILABLE,
    counts: plainCounts(counts),
  };
}

// ---- evidence finding --------------------------------------------------------------------------

// Exactly one primary classification, in a fixed precedence. A disagreement is reported as a
// disagreement even when a store is also unavailable, because the reader can still act on it; an
// unavailable store outranks an empty result, because "not read" is not "nothing there". The
// seventh state, `explicitly_disproven`, is reserved for an explicit negation record. No current
// store expresses negation - two disagreeing records do not prove either one false - so this build
// reports that case as `conflicting` and never claims disproof.
export function evidenceFinding(analysis) {
  if (!analysis?.available) {
    return { kind: ResponseFindingKind.NOT_CHECKED, reason: 'the request was not analysed against stored records' };
  }
  const counts = analysis.retrieval?.counts ?? {};
  const unavailable = Array.isArray(counts.unavailable) ? counts.unavailable.length : 0;
  const damaged = Array.isArray(counts.damaged) ? counts.damaged.length : 0;
  if (unavailable + damaged > 0) {
    return { kind: ResponseFindingKind.UNAVAILABLE, reason: `${unavailable + damaged} contributing source(s) could not be read` };
  }
  const conflicts = Array.isArray(analysis.retrieval?.conflicts) ? analysis.retrieval.conflicts.length : 0;
  if (conflicts > 0) {
    return { kind: ResponseFindingKind.CONFLICTING, reason: `${conflicts} stored disagreement(s) are unresolved` };
  }
  const readState = analysis.retrieval?.read?.state ?? null;
  if (readState === 'inconsistent' || readState === 'unverifiable') {
    return { kind: ResponseFindingKind.NOT_CHECKED, reason: 'the stores could not be checked as one consistent snapshot' };
  }
  const claims = analysis.claims?.claims ?? [];
  const material = claims.filter((claim) => claim.material);
  if (claims.length === 0 || material.length === 0) {
    // A bounded lexical read cannot prove absence. "Not found" is only stated for a read the
    // contract reports as complete; otherwise the honest classification is "unknown".
    return analysis.retrieval?.read?.complete === true
      ? { kind: ResponseFindingKind.NOT_FOUND, reason: 'a complete read found no matching record' }
      : { kind: ResponseFindingKind.UNKNOWN, reason: 'no matching record was found, and the read was bounded' };
  }
  if (material.some((claim) => SUPPORTED_STATES.has(claim.evidenceState))) {
    return { kind: null, reason: null };
  }
  return {
    kind: ResponseFindingKind.INSUFFICIENT_EVIDENCE,
    reason: 'matching records do not establish the claim as current and supported',
  };
}

// ---- claim attribution -------------------------------------------------------------------------

function contentTokens(text) {
  const tokens = String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
  return new Set(tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

function numbersIn(text) {
  return new Set(String(text ?? '').match(/[0-9]+(?:\.[0-9]+)?/g) ?? []);
}

function intersects(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

// Does the cited record state the claim, or does it merely share a subject? The comparison is
// lexical and bounded: content words only, with digits treated as their own evidence. A claim with
// no content words is `unknown` rather than assumed attributed, and a claim whose numbers do not
// appear in any cited record is `unattributed` even if the nouns match.
export function assessClaimAttribution(text, evidenceIds, evidenceById) {
  const ids = Array.isArray(evidenceIds) ? evidenceIds : [];
  if (ids.length === 0) return { status: 'uncited' };
  if (!(evidenceById instanceof Map)) return { status: 'unknown' };
  const recordTokens = new Set();
  const recordNumbers = new Set();
  let found = 0;
  for (const id of ids) {
    const item = evidenceById.get(id);
    if (!item || typeof item.claim !== 'string') continue;
    found += 1;
    for (const token of contentTokens(item.claim)) recordTokens.add(token);
    for (const number of numbersIn(item.claim)) recordNumbers.add(number);
  }
  if (found === 0) return { status: 'unknown' };
  const claimTokens = contentTokens(text);
  if (claimTokens.size === 0) return { status: 'unknown' };
  const claimNumbers = numbersIn(text);
  if (claimNumbers.size > 0 && recordNumbers.size > 0 && !intersects(claimNumbers, recordNumbers)) {
    return { status: 'unattributed' };
  }
  let shared = 0;
  for (const token of claimTokens) if (recordTokens.has(token)) shared += 1;
  const coverage = shared / claimTokens.size;
  if (coverage >= 0.6) return { status: 'attributed' };
  if (coverage >= 0.5) return { status: 'partial' };
  return { status: 'unattributed' };
}

// ---- trust ladder ------------------------------------------------------------------------------

function acceptedStructure(check) {
  return check?.found === true && isObject(check.structure) && !check.error;
}

function claimStatesForTrust(claims) {
  const factual = claims.filter((claim) => FACTUAL_KINDS.has(claim.kind));
  const attributed = factual.filter((claim) => claim.attribution !== 'unattributed');
  const supported = factual.filter((claim) => SUPPORTED_STATES.has(claim.evidenceState));
  return { factual, attributed, supported };
}

// Model prose is never `verified` in this build. The ladder stops at `factually_supported` even
// when every claim restates a current record, because APEX checked the citation, not the sentence.
export function assessModelOutputTrust({
  text, classification = null, check = null, recheck = null, evidenceById = null,
} = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  const received = body.length > 0;
  const classificationBlocked = classification === 'cancelled' || classification === 'unavailable'
    || classification === 'refused' || classification === 'empty';
  const structured = acceptedStructure(check);
  // With no cognitive analysis there is no structured check at all, but the reply is still text:
  // it is syntactically valid as prose and can never climb past presentation.
  const plain = check === null || (check?.found === false && check.structure === null);
  const controlFree = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body);
  const syntactic = received && controlFree && (structured || plain);
  const accepted = syntactic && !classificationBlocked;
  const responseClaims = structured ? (Array.isArray(check.structure.claims) ? check.structure.claims : []) : [];
  // Whether a factual claim restates the record it cites is checked here, against the same retrieval
  // the claim was validated against. It is an assessment, not a rejection: the structural validator
  // has already decided whether the citation exists.
  const attributed = responseClaims.map((claim) => ({
    ...claim,
    attribution: claim.attribution ?? (Array.isArray(claim.evidenceIds)
      ? assessClaimAttribution(claim.text, claim.evidenceIds, evidenceById).status
      : 'unknown'),
  }));
  const { factual, attributed: attributedFactual, supported } = claimStatesForTrust(attributed);
  const weakened = Number.isFinite(recheck?.weakened) && recheck.weakened > 0;
  // A claim labelled general knowledge or unknown is the model saying it is not backed by a record.
  // The factual claims beside it may each check out, but the answer as a whole then rests on
  // something the records do not establish, so it stays at presentation with a stated limitation.
  const unsupportedClaim = attributed.some((claim) => claim.kind === 'general_knowledge' || claim.kind === 'unknown');
  const factuallySupported = accepted
    && structured
    && factual.length > 0
    && attributedFactual.length === factual.length
    && supported.length > 0
    && !unsupportedClaim
    && !weakened;
  const supportReason = factuallySupported
    ? 'every factual claim restates cited, current records'
    : unsupportedClaim
      ? 'at least one claim is not backed by the cited records'
      : 'at least one factual claim is not supported by the cited records';

  const ladder = [
    { state: ResponseTrustState.RECEIVED, ok: received, reason: received ? 'model output was received' : 'no model output was received' },
    { state: ResponseTrustState.SYNTACTICALLY_VALID, ok: syntactic, reason: syntactic ? 'the output is well-formed text' : 'the output is not well-formed text' },
    { state: ResponseTrustState.ACCEPTED_FOR_PRESENTATION, ok: accepted, reason: accepted ? 'the output passed the presentation checks' : 'the output was not accepted for presentation' },
    { state: ResponseTrustState.FACTUALLY_SUPPORTED, ok: factuallySupported, reason: supportReason },
    { state: ResponseTrustState.VERIFIED, ok: false, reason: 'APEX does not independently verify model prose; a citation check is not verification of the sentence' },
  ];
  const state = [...ladder].reverse().find((entry) => entry.ok)?.state ?? null;
  return {
    state,
    ladder,
    verified: false,
    claims: attributed,
    weakened,
  };
}

function limitationCodes({ analysis, trust, check, recheck, truncated }) {
  const codes = ['model_output_unverified'];
  const structure = acceptedStructure(check) ? check.structure : null;
  if (!structure) codes.push('plain_answer_unstructured');
  if (check?.error) codes.push('structured_response_rejected');
  if (structure) {
    const claims = trust.claims;
    if (claims.some((claim) => claim.attribution === 'unattributed')) codes.push('claim_attribution_unverified');
    if (claims.some((claim) => claim.attribution === 'partial')) codes.push('claim_attribution_partial');
    if (claims.some((claim) => claim.kind === 'inference' || claim.kind === 'assumption')) codes.push('claims_inferred');
    if (claims.some((claim) => claim.kind === 'general_knowledge')) codes.push('claims_general_knowledge');
    if (claims.some((claim) => claim.evidenceState === EvidenceState.PARTIALLY_SUPPORTED)) codes.push('claims_partially_supported');
  }
  if (recheck?.weakened > 0) codes.push('evidence_changed');
  const counts = analysis?.retrieval?.counts ?? {};
  if ((counts.unavailable?.length ?? 0) + (counts.damaged?.length ?? 0) > 0) codes.push('evidence_unavailable');
  if ((analysis?.retrieval?.conflicts?.length ?? 0) > 0) codes.push('evidence_conflicting');
  if ((counts.dropped ?? 0) > 0 || analysis?.retrieval?.read?.state === 'truncated') codes.push('evidence_truncated');
  if (truncated === true) codes.push('output_truncated');
  return [...new Set(codes)].slice(0, MAX_LIMITATIONS);
}

export function assessResponseIntegrity({
  analysis = null, text = '', classification = null, check = null, recheck = null, truncated = false,
} = {}) {
  const trust = assessModelOutputTrust({
    text, classification, check, recheck, evidenceById: analysis?.retrieval?.byId ?? null,
  });
  const finding = evidenceFinding(analysis);
  // With no model output there is no wording to qualify, so the limitation list is empty rather than
  // describing a response that does not exist.
  const limitations = trust.state === null
    ? []
    : limitationCodes({ analysis, trust, check, recheck, truncated });
  const accepted = trust.state === ResponseTrustState.FACTUALLY_SUPPORTED
    || trust.state === ResponseTrustState.ACCEPTED_FOR_PRESENTATION;
  let degradation;
  if (trust.state === null) degradation = ResponseDegradation.NO_OUTPUT;
  else if (trust.state === ResponseTrustState.FACTUALLY_SUPPORTED
    && limitations.every((code) => code === 'model_output_unverified')) {
    // Everything the response asserted was checked against current records; the only remaining
    // qualification is that APEX does not verify model prose.
    degradation = ResponseDegradation.PRESENT_AS_IS;
  } else degradation = ResponseDegradation.PRESENT_WITH_LIMITATIONS;

  const claims = trust.claims;
  return {
    schema: RESPONSE_CONTRACT_SCHEMA,
    trust,
    finding,
    degradation,
    limitations,
    attributionFailures: claims.filter((claim) => claim.attribution === 'unattributed').length,
    accepted,
    verified: false,
    authorizes: false,
  };
}

// The audit form is fixed and bounded: states, kinds, and counts. There is no field that could carry
// the model's answer, a claim's text, or a stored record.
export function responseIntegrityAudit(assessment) {
  if (!assessment) return null;
  const claims = assessment.trust?.claims ?? [];
  return {
    schema: RESPONSE_CONTRACT_SCHEMA,
    trust: assessment.trust?.state ?? null,
    verified: false,
    finding: assessment.finding?.kind ?? null,
    findingReason: assessment.finding?.reason ?? null,
    degradation: assessment.degradation,
    limitations: Array.isArray(assessment.limitations) ? [...assessment.limitations] : [],
    claims: {
      total: claims.length,
      factual: claims.filter((claim) => FACTUAL_KINDS.has(claim.kind)).length,
      supported: claims.filter((claim) => claim.evidenceState === EvidenceState.DIRECTLY_SUPPORTED).length,
      partial: claims.filter((claim) => claim.evidenceState === EvidenceState.PARTIALLY_SUPPORTED).length,
      inferred: claims.filter((claim) => claim.kind === 'inference' || claim.kind === 'assumption').length,
      generalKnowledge: claims.filter((claim) => claim.kind === 'general_knowledge').length,
      partialAttribution: claims.filter((claim) => claim.attribution === 'partial').length,
      unattributed: claims.filter((claim) => claim.attribution === 'unattributed').length,
    },
    authorizes: false,
  };
}

// ---- the fourteen-stage contract ---------------------------------------------------------------

function modelStageStatus(model) {
  if (!model || model.prepared !== true) return ResponseStageStatus.NOT_REACHED;
  if (model.class === 'cancelled' || model.class === 'unavailable') return ResponseStageStatus.FAILED;
  return ResponseStageStatus.RAN;
}

function outputStageStatus(model, text) {
  if (!model || model.prepared !== true) return ResponseStageStatus.NOT_REACHED;
  if (model.ok === false) return ResponseStageStatus.SKIPPED;
  return typeof text === 'string' && text.trim().length > 0
    ? ResponseStageStatus.RAN
    : ResponseStageStatus.RAN_NO_RESULT;
}

// Grounding is only reachable once a model reply exists. A request that ended before the model stage
// leaves it `not_reached`, which must not be read as a check that ran and found nothing.
function groundingStageStatus(check, analysisAvailable, modelReached) {
  if (!modelReached) return ResponseStageStatus.NOT_REACHED;
  if (!analysisAvailable) return ResponseStageStatus.UNAVAILABLE;
  if (!check) return ResponseStageStatus.SKIPPED;
  if (check.error) return ResponseStageStatus.FAILED;
  return check.found === true ? ResponseStageStatus.RAN : ResponseStageStatus.RAN_NO_RESULT;
}

// Builds the contract from records that already exist. It runs no store, no model, and no clock, and
// every input is optional: a path that never reached a stage leaves it `not_reached`, which is a
// different statement from `ran_no_result`.
export function buildResponseContract({
  requestId = null,
  analysis = null,
  lifecycle = null,
  model = null,
  check = null,
  text = '',
  proposals = null,
  steps = [],
  recheck = null,
  trustState = null,
  clarification = false,
  finalAnswer = false,
  cancelled = false,
} = {}) {
  const byOrder = lifecycleStages(lifecycle);
  const analysisAvailable = analysis?.available === true;
  const stages = [];
  stages.push(stage(1, ResponseStageStatus.RAN));
  stages.push(stage(2, analysisAvailable ? (lifecycleStatus(byOrder, 2) ?? ResponseStageStatus.RAN) : ResponseStageStatus.UNAVAILABLE, {
    intents: analysis?.understanding?.intents?.length ?? 0,
  }));

  const retrieved = analysis?.retrieval?.counts?.total ?? 0;
  stages.push(stage(3, analysisAvailable
    ? (lifecycleStatus(byOrder, 3) ?? (retrieved > 0 ? ResponseStageStatus.RAN : ResponseStageStatus.RAN_NO_RESULT))
    : ResponseStageStatus.UNAVAILABLE, { records: retrieved, dropped: analysis?.retrieval?.counts?.dropped ?? 0 }));

  const readState = analysis?.retrieval?.read?.state ?? null;
  const snapshotStatus = !analysisAvailable
    ? ResponseStageStatus.UNAVAILABLE
    : readState === 'inconsistent' || readState === 'unverifiable'
      ? ResponseStageStatus.FAILED
      : readState === null
        ? ResponseStageStatus.UNAVAILABLE
        : ResponseStageStatus.RAN;
  stages.push(stage(4, snapshotStatus, {
    sources: analysis?.retrieval?.sources?.length ?? 0,
    unreadable: (analysis?.retrieval?.counts?.unavailable?.length ?? 0) + (analysis?.retrieval?.counts?.damaged?.length ?? 0),
  }));

  const claimTotal = analysis?.claims?.claims?.length ?? 0;
  stages.push(stage(5, analysisAvailable
    ? (lifecycleStatus(byOrder, 4) ?? (claimTotal > 0 ? ResponseStageStatus.RAN : ResponseStageStatus.RAN_NO_RESULT))
    : ResponseStageStatus.UNAVAILABLE, { claims: claimTotal, material: analysis?.claims?.counts?.material ?? 0 }));

  const conflicts = analysis?.retrieval?.conflicts?.length ?? 0;
  stages.push(stage(6, analysisAvailable
    ? (conflicts > 0 ? ResponseStageStatus.RAN : ResponseStageStatus.RAN_NO_RESULT)
    : ResponseStageStatus.UNAVAILABLE, { conflicts, contradicted: analysis?.claims?.counts?.contradicted ?? 0 }));

  stages.push(stage(7, analysisAvailable
    ? (lifecycleStatus(byOrder, 5) ?? ResponseStageStatus.RAN)
    : ResponseStageStatus.UNAVAILABLE));

  const uncertainty = analysis?.deliberation?.uncertainty ?? null;
  stages.push(stage(8, !analysisAvailable
    ? ResponseStageStatus.UNAVAILABLE
    : uncertainty ? ResponseStageStatus.RAN : ResponseStageStatus.RAN_NO_RESULT));

  const modelReached = model?.prepared === true;
  stages.push(stage(9, clarification
    ? ResponseStageStatus.NOT_REACHED
    : modelReached ? ResponseStageStatus.RAN : ResponseStageStatus.NOT_REACHED, { prompt_chars: model?.promptChars ?? 0 }));

  stages.push(stage(10, clarification
    ? ResponseStageStatus.NOT_REACHED
    : modelStageStatus(model), { cancelled: cancelled ? 1 : 0 }));

  stages.push(stage(11, clarification
    ? ResponseStageStatus.NOT_REACHED
    : outputStageStatus(model, text), { chars: typeof text === 'string' ? Math.min(text.length, 100000) : 0 }));

  stages.push(stage(12, clarification
    ? ResponseStageStatus.NOT_REACHED
    : groundingStageStatus(check, analysisAvailable, modelReached), {
    claims: acceptedStructure(check) ? (check.structure.claims?.length ?? 0) : 0,
    rejected: check?.error ? 1 : 0,
  }));

  stages.push(stage(13, finalAnswer ? ResponseStageStatus.RAN : ResponseStageStatus.NOT_REACHED));

  // A count that is not a non-negative integer is not a count: the stage reports that the proposal
  // tally could not be read rather than claiming zero proposals were handed off.
  const observed = Number.isFinite(proposals?.observed) && proposals.observed >= 0
    ? Math.trunc(proposals.observed)
    : null;
  const executed = (Array.isArray(steps) ? steps : []).filter((step) => step?.execution?.status === 'ok').length;
  const denied = (Array.isArray(steps) ? steps : []).filter((step) => step?.authorization?.decision === 'deny').length;
  const handoffStatus = clarification || !modelReached
    ? ResponseStageStatus.NOT_REACHED
    : observed === null
      ? ResponseStageStatus.UNAVAILABLE
      : observed === 0 ? ResponseStageStatus.SKIPPED : ResponseStageStatus.RAN;
  stages.push(stage(14, handoffStatus, {
    observed,
    well_formed: proposals?.wellFormed ?? 0,
    malformed: proposals?.malformed ?? 0,
    overflow: proposals?.overflow ?? 0,
    executed,
    denied,
  }));

  const checks = contractChecks({ stages, steps, recheck, trustState });
  // A stage whose inputs could not be read (`unavailable`) did not execute, so it cannot count as
  // reached. A stage that ran, ran with no result, was skipped after evaluation, or failed did.
  const reachedThrough = stages.reduce((highest, entry) => (
    entry.status === ResponseStageStatus.NOT_REACHED || entry.status === ResponseStageStatus.UNAVAILABLE
      ? highest
      : Math.max(highest, entry.order)
  ), 0);
  return {
    schema: RESPONSE_CONTRACT_SCHEMA,
    requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null,
    ok: checks.every((entry) => entry.ok),
    reachedThrough,
    stages,
    checks,
    authority: RESPONSE_AUTHORITY,
    authorizes: false,
  };
}

function contractChecks({ stages, steps, recheck, trustState }) {
  const byOrder = new Map(stages.map((entry) => [entry.order, entry]));
  const executed = (Array.isArray(steps) ? steps : []).filter((step) => step?.execution?.status === 'ok');
  const unauthorized = executed.filter((step) => step?.authorization?.decision !== 'allow');
  // A completed handoff records the registry's decision, so an authorization field is expected. What
  // must never appear is one owned by anything but the registry, or a handoff that authorizes itself.
  const handoffClaimsAuthority = (Array.isArray(steps) ? steps : []).some((step) => {
    const handoff = step?.handoff;
    if (handoff == null) return false;
    if (handoff.authorizes !== false) return true;
    return handoff.authorization != null && handoff.authorization.owner !== 'action_registry';
  });
  const grounding = byOrder.get(12);
  const final = byOrder.get(13);
  const groundedBeforeFinal = !final || final.status === ResponseStageStatus.NOT_REACHED
    || grounding.order < final.order;
  const rejectedButTrusted = grounding.status === ResponseStageStatus.FAILED
    && (trustState === ResponseTrustState.FACTUALLY_SUPPORTED || trustState === ResponseTrustState.VERIFIED);
  return [
    {
      check: 'every_stage_records_a_known_outcome',
      ok: stages.every((entry) => OUTCOMES.has(entry.status)),
      detail: 'each stage is one of ran, ran_no_result, skipped, not_reached, unavailable, or failed',
    },
    {
      check: 'grounding_precedes_final_answer',
      ok: groundedBeforeFinal && !rejectedButTrusted,
      detail: rejectedButTrusted
        ? 'a rejected grounding check was nevertheless treated as support'
        : 'a response is validated before it becomes the final answer, and a rejected structure is not treated as checked',
    },
    {
      check: 'execution_requires_registry_allow',
      ok: unauthorized.length === 0,
      detail: unauthorized.length === 0
        ? 'no step executed without an allow decision from the action registry'
        : `${unauthorized.length} step(s) executed with no allow decision`,
    },
    {
      check: 'handoff_claims_no_authority',
      ok: !handoffClaimsAuthority,
      detail: handoffClaimsAuthority
        ? 'a handoff record carried an authorization field'
        : 'every handoff record is a proposal with no authorization of its own',
    },
    {
      check: 'evidence_recheck_is_observation_only',
      ok: recheck == null || recheck.authorizes === false,
      detail: 'the post-answer evidence recheck never grants authority and never rewrites recorded lineage',
    },
  ];
}

// Fixed-key audit. The contract already carries no prose; this form states exactly what a later
// reader may rely on and nothing else.
export function responseContractAudit(contract) {
  if (!contract) return null;
  return {
    schema: RESPONSE_CONTRACT_SCHEMA,
    requestId: contract.requestId,
    ok: contract.ok,
    reachedThrough: contract.reachedThrough,
    stages: contract.stages.map((entry) => ({
      order: entry.order,
      id: entry.id,
      status: entry.status,
      counts: { ...entry.counts },
    })),
    checks: contract.checks.map((entry) => ({ check: entry.check, ok: entry.ok, detail: entry.detail })),
    authority: { ...contract.authority },
    authorizes: false,
  };
}

// A display line for an accepted structure whose supported claims do not restate the cited records.
// It is an APEX notice, never part of the model's turn.
export function attributionNotice(assessment) {
  const failures = assessment?.attributionFailures ?? 0;
  if (failures <= 0) return '';
  return `[APEX check: ${failures} structured claim(s) marked as resting on stored records do not restate those records. That wording is the model's, not a stored fact.]`;
}
