// Grounded response construction and validation.
//
// This module does not write APEX's prose: the model does that. What it builds is the bounded
// grounding brief the model is given, and the check that a structured answer stays inside it. A
// response may only cite evidence ids that this request actually retrieved, may not claim more
// certainty than the deterministic analysis found, and may not carry fields that would look like
// provenance, authorization, or an execution. A claim marked supported may rest only on evidence the
// deterministic layer derived as directly supported, so a model cannot turn a conflict, a stale
// record, or an expectation into a settled fact. Missing mandatory disclosures are added from the
// deterministic analysis rather than trusted to the model's wording.
import { CONTROL_CHARS, truncate } from '../util.js';
import {
  BOUNDS, ClaimKind, DecisionKind, Disclosure, EVIDENCE_STATES, EvidenceState, MissingInfo, Uncertainty,
  UncertaintyAbout,
} from './vocabulary.js';

export const MAX_GROUNDING_ANSWER_CHARS = 12000;
export const MAX_STRUCTURED_COMMAND_CHARS = 400;

const DISCLOSURE_PHRASES = Object.freeze({
  [Disclosure.NO_EVIDENCE]: 'no stored evidence was found for this request',
  [Disclosure.SOURCE_UNAVAILABLE]: 'a relevant store could not be read, so an empty result is not proof that nothing exists',
  [Disclosure.SOURCE_DAMAGED]: 'a relevant store is damaged, so part of it could not be read',
  [Disclosure.CONFLICT_UNRESOLVED]: 'stored records disagree and the disagreement is unresolved',
  [Disclosure.EVIDENCE_HISTORICAL]: 'matching records describe a past state, not the current one',
  [Disclosure.EVIDENCE_UNKNOWN_VALIDITY]: 'at least one matching record has no usable validity',
  [Disclosure.EXPECTATION_NOT_FACT]: 'a recorded expectation is not evidence that the expected outcome happened',
  [Disclosure.INFERENCE_MARKED]: 'part of the answer is inferred from records, not copied from one',
  [Disclosure.ASSUMPTION_STATED]: 'the answer uses a stated assumption',
  [Disclosure.CLARIFICATION_REQUIRED]: 'one detail is needed before this can be answered',
  [Disclosure.CONTEXT_TRUNCATED]: 'some lower-relevance material was omitted to stay within the context budget',
  [Disclosure.EVIDENCE_NOT_SINGLE_INSTANT]: 'a contributing store changed while this evidence was assembled, so the combined records describe no single instant',
  [Disclosure.EVIDENCE_SNAPSHOT_UNVERIFIED]: 'a contributing store could not be inspected while this evidence was assembled, so consistency could not be checked',
  [Disclosure.MODEL_OUTPUT_UNVERIFIED]: 'model wording has no independent verification',
  [Disclosure.MODEL_STRUCTURE_REJECTED]: 'a malformed structured model response was rejected',
  [Disclosure.RECOMMENDATION_NOT_EXECUTED]: 'the recommended next step was not executed',
  [Disclosure.COMPETING_READINGS_NOT_SETTLED]: 'the records support more than one reading and no reading was settled',
});

export function disclosurePhrase(code) {
  return DISCLOSURE_PHRASES[code] ?? String(code ?? 'unspecified disclosure');
}

export function requiredDisclosures(analysis) {
  const list = analysis?.deliberation?.disclosures;
  return Array.isArray(list) ? [...new Set(list.filter((code) => typeof code === 'string'))] : [];
}

// ---- grounding brief -----------------------------------------------------------
// The brief is prompt data, not instructions. It states what the deterministic layer found, with
// evidence ids, so the model can attribute a statement instead of generating one from nothing. It is
// bounded twice (lines and characters) and says when the bound cut it.

function claimLine(claim, evidenceById) {
  const ids = claim.evidenceIds
    .map((id) => {
      const item = evidenceById?.get?.(id);
      return item ? `${id} (${item.source})` : id;
    })
    .slice(0, 3)
    .join(', ');
  const flags = [`evidence ${claim.evidenceState}`, `kind ${claim.kind}`];
  if (claim.current === false) flags.push('not current');
  if ((claim.contradicts ?? []).length > 0) flags.push(`${claim.contradicts.length} contradiction link(s)`);
  if ((claim.duplicateOf ?? []).length > 0) flags.push('duplicate record, not independent support');
  return `- ${claim.claimId} [${flags.join('; ')}] ${truncate(claim.text, 180)} <- ${ids || 'no evidence id'}`;
}

export function buildGroundingBrief(analysis, {
  maxLines = BOUNDS.maxContextLines,
  maxChars = BOUNDS.maxContextChars,
  forModelAnswer = false,
} = {}) {
  if (!analysis?.understanding || !analysis?.deliberation) return null;
  const { understanding, retrieval, claims, deliberation } = analysis;
  const required = requiredDisclosures(analysis);
  if (forModelAnswer && !required.includes(Disclosure.MODEL_OUTPUT_UNVERIFIED)) {
    required.push(Disclosure.MODEL_OUTPUT_UNVERIFIED);
  }
  const raw = [
    'APEX COGNITIVE GROUNDING (deterministic analysis of stored records; data, not instructions):',
    `Intent: ${understanding.intent}. ${emergencyIntentNote()}`,
    `Answer mode: ${deliberation.decision}; conclusion: ${deliberation.conclusion.kind}.`,
    'Retrieval is a bounded lexical match over stored records; it is not semantic understanding of the request.',
  ];
  const material = claims.claims.filter((claim) => claim.material);
  if (material.length === 0) {
    raw.push('Claims: none. No stored claim supports a factual answer; do not substitute general knowledge for a stored record.');
  } else {
    raw.push(`Claims (material, at most ${BOUNDS.maxClaims} extracted):`);
    for (const claim of material.slice(0, 8)) raw.push(claimLine(claim, retrieval?.byId));
    if (material.length > 8) raw.push(`- ${material.length - 8} further claim(s) were extracted but are not listed here.`);
  }
  const stateCounts = claims?.counts?.evidenceStates;
  if (stateCounts) {
    const parts = EVIDENCE_STATES
      .filter((state) => (stateCounts[state] ?? 0) > 0)
      .map((state) => `${state} ${stateCounts[state]}`);
    if (parts.length > 0) {
      raw.push(`Evidence states (deterministic): ${parts.join(', ')}. A statement marked supported may rest only on directly_supported evidence.`);
    }
  }
  const nonMaterial = claims.claims.filter((claim) => !claim.material && claim.kind !== ClaimKind.STATEMENT);
  if (nonMaterial.length > 0) {
    raw.push(`Non-material records kept separate: ${nonMaterial.map((claim) => `${claim.claimId} (${claim.kind})`).slice(0, 4).join(', ')}.`);
  }
  if (deliberation.contradicting.length > 0) {
    raw.push(`Disagreement: ${deliberation.contradicting.length} claim(s) are contradicted by another stored record. Present both sides; do not choose the newer, the more frequent, or the higher-ranked one.`);
  }
  const uncertainty = deliberation.uncertainty;
  if (uncertainty) {
    raw.push(`Uncertainty: ${uncertainty.category} about ${uncertainty.about}: ${uncertainty.reason}`);
  }
  if (deliberation.missing.length > 0) {
    raw.push(`Missing information: ${[...new Set(deliberation.missing.map((item) => item.code))].join(', ')}.`);
  }
  if (deliberation.interpretations.length > 0) {
    raw.push(`Interpretations (none chosen): ${deliberation.interpretations.map((item) => item.code).join(', ')}.`);
  }
  if (deliberation.assumptions.length > 0) {
    raw.push(`Assumptions to state if used: ${deliberation.assumptions.map((item) => item.code).join(', ')}.`);
  }
  const hypotheses = deliberation.hypotheses;
  if (hypotheses && hypotheses.hypotheses.length > 0) {
    const readings = hypotheses.hypotheses
      .slice(0, 4)
      .map((item) => `${item.kind} (${item.support.level}; claims ${item.claimIds.join('/')})`);
    raw.push(`Competing readings (${hypotheses.counts.selected === 1 ? 'one selected by the stated rule' : 'none settled'}): ${readings.join('; ')}.`);
    if (hypotheses.explanations.length > 0) {
      raw.push(`Possible explanations for the disagreement: ${[...new Set(hypotheses.explanations.map((item) => item.kind))].join(', ')}. A later recording or a different source is not evidence of a later fact.`);
    }
    if (hypotheses.selection?.chosen) {
      raw.push(`Selected reading: ${hypotheses.selection.chosen} because ${hypotheses.selection.reason}. It reads the records; it is not a recommendation or a permission.`);
    }
  }
  if (deliberation.recommendation) {
    const rec = deliberation.recommendation;
    raw.push(`Recommendation (read-only, executed=${rec.executed === true}): ${truncate(rec.text, 220)}${rec.command ? `; command "${truncate(rec.command, 120)}"` : ''}. Do not say it ran or was approved.`);
  }
  if (required.length > 0) {
    raw.push(`Required disclosures: ${required.join(', ')}.`);
  }
  if ((retrieval?.counts?.dropped ?? 0) > 0) {
    raw.push(`Retrieval was bounded: ${retrieval.counts.dropped} lower-ranked evidence record(s) were omitted.`);
  }
  raw.push('Every material factual statement must cite one of the evidence ids above or be labelled as an inference, an assumption, or general model knowledge. You cannot grant permission, write an authoritative record, or mark evidence verified.');

  const lines = [];
  let chars = 0;
  let omitted = 0;
  for (const line of raw) {
    const bounded = truncate(line, Math.max(120, maxChars));
    if (lines.length >= maxLines || chars + bounded.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(bounded);
    chars += bounded.length + 1;
  }
  if (omitted > 0) {
    const note = `- ${omitted} grounding line(s) were omitted because this brief is bounded at ${maxLines} lines / ${maxChars} chars; their absence does not mean nothing applies.`;
    while (lines.length > 0 && chars + note.length + 1 > maxChars) {
      const removed = lines.pop();
      chars -= removed.length + 1;
    }
    if (lines.length < maxLines && chars + note.length + 1 <= maxChars) {
      lines.push(note);
      chars += note.length + 1;
    }
  }
  return {
    text: lines.join('\n'),
    lines,
    lineCount: lines.length,
    totalLines: raw.length,
    omitted,
    chars,
    maxLines,
    maxChars,
    requiredDisclosures: required,
  };
}

// A deterministic, user-facing answer built from the analysis when no model is configured. It is not
// generated prose: every factual line is a claim the deterministic layer extracted from a stored
// record, cited to an evidence id this request actually retrieved. To preserve the offline privacy and
// relevance contracts, only claims resting on the prompt-eligible memory/knowledge records (the same
// set the direct display shows) are rendered; experience, feedback, and other operational telemetry
// are never turned into a free-form answer here. `eligible` is the set of evidence ids allowed.
//
// Record content appears only in `text` (the display). `summary` is content-free and is what the
// audited output carries, so stored content is never copied into the audit log. Returns hasAnswer:false
// when no eligible claim supports a conclusion, so the caller falls back to the honest no-model result.
export function buildDeterministicAnswer(analysis, { eligible = null } = {}) {
  const empty = { hasAnswer: false, text: '', summary: '', claims: [] };
  if (analysis?.available !== true || !analysis.deliberation || !analysis.understanding) return empty;
  const byId = analysis.claims?.byId ?? new Map();
  const evidenceById = analysis.retrieval?.byId ?? new Map();
  const allowed = (claim) => Array.isArray(claim?.evidenceIds) && claim.evidenceIds.length > 0
    && (eligible === null || claim.evidenceIds.every((id) => eligible.has(id)));
  const conclusionIds = analysis.deliberation.conclusion?.claimIds ?? [];
  const rendered = conclusionIds.map((id) => byId.get(id)).filter((claim) => claim && allowed(claim));
  if (rendered.length === 0) return empty;

  const lines = [
    "Deterministic answer from APEX's stored records. No model was used: this is a bounded reading of what is recorded, cited to evidence ids, not generated prose.",
    '',
    'Records this rests on:',
  ];
  const shown = [];
  let contradicted = 0;
  for (const claim of rendered.slice(0, 8)) {
    const cites = claim.evidenceIds.slice(0, 3).map((eid) => {
      const item = evidenceById.get(eid);
      return item ? `${eid} (${item.source})` : eid;
    }).join(', ');
    const flags = [claim.kind, `evidence ${claim.evidenceState}`];
    if (claim.current === false) flags.push('not current');
    if ((claim.contradicts ?? []).length > 0) { flags.push(`${claim.contradicts.length} contradiction link(s)`); contradicted += 1; }
    lines.push(`- ${truncate(claim.text, 200)} [${flags.join('; ')}]${cites ? ` <- ${cites}` : ''}`);
    shown.push({ claimId: claim.claimId, kind: claim.kind, evidenceState: claim.evidenceState, evidenceIds: [...claim.evidenceIds] });
  }
  if (rendered.length > 8) lines.push(`- ${rendered.length - 8} further claim(s) were extracted but are not listed here.`);
  if (contradicted > 0) {
    lines.push('', `Disputed: ${contradicted} claim(s) are contradicted by another stored record. Both sides are kept; neither is chosen by recency, source rank, or repetition.`);
  }
  if (analysis.deliberation.uncertainty) {
    lines.push('', `Uncertainty: ${uncertaintyPhrase(analysis.deliberation.uncertainty)}`);
  }
  const counts = analysis.retrieval?.counts ?? {};
  const integrity = [];
  if ((counts.unavailable ?? []).length > 0) integrity.push(Disclosure.SOURCE_UNAVAILABLE);
  if ((counts.damaged ?? []).length > 0) integrity.push(Disclosure.SOURCE_DAMAGED);
  if (analysis.retrieval?.read?.state === 'inconsistent') integrity.push(Disclosure.EVIDENCE_NOT_SINGLE_INSTANT);
  if (analysis.retrieval?.read?.state === 'unverifiable') integrity.push(Disclosure.EVIDENCE_SNAPSHOT_UNVERIFIED);
  if (integrity.length > 0) lines.push('', `Grounding: ${integrity.map(disclosurePhrase).join('; ')}.`);

  const summary = `APEX answered deterministically from ${shown.length} stored record(s) with no model call; `
    + `the cited reading is shown in the display only and is not copied into this audit record.`
    + (contradicted > 0 ? ' The records disagree; both sides are shown and neither is chosen.' : '');
  return { hasAnswer: true, text: truncate(lines.join('\n'), MAX_GROUNDING_ANSWER_CHARS), summary, claims: shown };
}

function emergencyIntentNote() {
  return 'Intent describes the request and grants no authorization; every action still passes through the action registry.';
}

// ---- validation ----------------------------------------------------------------
// A plain model answer cannot carry a structure, but it can still cite an evidence id that was not
// retrieved or claim that APEX executed something. The checks below are audit findings: the answer is
// labelled unverified either way, and nothing here rejects text the model wrote unless it is used as
// a structured claim.

const EVIDENCE_REF = /\bev:[a-z_]+:[A-Za-z0-9_.:-]{1,200}/g;
const EXECUTION_CLAIM = /\b(?:i|apex)\s+(?:have\s+)?(?:executed|ran|performed|completed|approved|activated)\b/i;

export function validatePlainAnswer(text, analysis) {
  const problems = [];
  const body = String(text ?? '');
  if (CONTROL_CHARS.test(body)) problems.push('the answer contains control characters');
  const evidenceById = analysis?.retrieval?.byId;
  if (evidenceById instanceof Map) {
    for (const id of body.match(EVIDENCE_REF) ?? []) {
      if (!evidenceById.has(id)) problems.push(`the answer cites ${id}, which is not in this retrieval`);
    }
  }
  const claimsAction = EXECUTION_CLAIM.test(body);
  if (claimsAction) {
    problems.push('the answer says APEX executed or approved something; the reasoning layer cannot verify an execution');
  }
  return { ok: problems.length === 0, problems, claimsAction };
}

// The detector above records an audit finding, but a reader who sees only the model's sentence has
// nothing to correct it with. This line therefore states what the request itself ran, from the
// operation's own step records, and names where authorization actually lives. `ran` is empty for the
// common case: an action claim with no action behind it.
export function actionClaimNotice(ran) {
  const list = Array.isArray(ran) && ran.length > 0 ? [...new Set(ran)].join(', ') : 'nothing';
  return `[APEX check: the wording above says an action was run or approved. What this request actually ran: ${list}. `
    + 'A model answer cannot approve, start or execute anything; the plan and task records are the authority, '
    + 'so read them before acting on that sentence.]';
}

const ROOT_KEYS = new Set(['schema', 'decision', 'answer', 'claims', 'uncertainty', 'disclosures', 'missing', 'recommendation']);
const CLAIM_KEYS = new Set(['text', 'evidence', 'kind']);
const RECOMMENDATION_KEYS = new Set(['text', 'command', 'executed']);
const FORBIDDEN_KEYS = new Set([
  'action', 'actions', 'authorization', 'authorized', 'permission', 'permissions', 'provenance',
  'origin', 'verified', 'verify', 'authoritative', 'trusted', 'capability', 'approve', 'approved',
  'activate', 'activated', 'execute', 'run', 'role', 'user', 'truth', 'confidence',
]);
const CLAIM_KINDS = new Set(['supported', 'partially_supported', 'historical', 'inference', 'assumption', 'general_knowledge', 'unknown', 'recommendation']);
const DECISIONS = new Set([DecisionKind.ANSWER, DecisionKind.CLARIFY, DecisionKind.REFUSE, DecisionKind.DECLINE]);
const DISCLOSURES = new Set(Object.values(Disclosure));
const MISSING = new Set(Object.values(MissingInfo));
const UNCERTAINTIES = new Set(Object.values(Uncertainty));
const CERTAINTY_RANK = Object.freeze({
  [Uncertainty.UNKNOWN]: 0,
  [Uncertainty.UNVERIFIABLE]: 0,
  [Uncertainty.CONFLICTING]: 0,
  [Uncertainty.OUTDATED]: 1,
  [Uncertainty.WEAKLY_SUPPORTED]: 1,
  [Uncertainty.ASSUMED]: 2,
  [Uncertainty.INFERRED]: 2,
  [Uncertainty.SUPPORTED_INCOMPLETE]: 3,
  [Uncertainty.STRONGLY_SUPPORTED]: 4,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function forbiddenField(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forbiddenField(entry, `${path}[${index}]`, problems));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) problems.push(`${path}.${key} is not allowed in a structured response`);
    forbiddenField(child, `${path}.${key}`, problems);
  }
}

function validText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL_CHARS.test(value);
}

// Severity order for a claim that cites more than one record: the weakest cited record decides,
// because a conclusion cannot be stronger than its weakest premise. A withdrawn or replaced record is
// weaker than an old one, and both are weaker than a record that merely does not establish the claim.
const EVIDENCE_STATE_SEVERITY = Object.freeze([
  EvidenceState.CONFLICTING,
  EvidenceState.RETRACTED,
  EvidenceState.SUPERSEDED,
  EvidenceState.TEMPORALLY_STALE,
  EvidenceState.UNSUPPORTED,
  EvidenceState.UNVERIFIED,
  EvidenceState.PARTIALLY_SUPPORTED,
  EvidenceState.DIRECTLY_SUPPORTED,
]);

const KIND_ALLOWED_STATES = Object.freeze({
  supported: new Set([EvidenceState.DIRECTLY_SUPPORTED]),
  partially_supported: new Set([EvidenceState.DIRECTLY_SUPPORTED, EvidenceState.PARTIALLY_SUPPORTED]),
  historical: new Set([EvidenceState.TEMPORALLY_STALE]),
});

const STATE_WITHOUT_EVIDENCE = Object.freeze({
  supported: EvidenceState.UNVERIFIED,
  partially_supported: EvidenceState.UNVERIFIED,
  historical: EvidenceState.UNVERIFIED,
  inference: EvidenceState.UNVERIFIED,
  assumption: EvidenceState.UNVERIFIED,
  general_knowledge: EvidenceState.UNSUPPORTED,
  unknown: EvidenceState.UNVERIFIED,
  recommendation: EvidenceState.UNSUPPORTED,
});

const STATE_PROBLEM = Object.freeze({
  [EvidenceState.CONFLICTING]: 'the cited records disagree and the disagreement is unresolved; present both sides or label it unknown',
  [EvidenceState.RETRACTED]: 'the cited record was retracted and no longer stands; it cannot support a claim',
  [EvidenceState.SUPERSEDED]: 'a later record replaced the cited one; cite the current record or label it historical',
  [EvidenceState.TEMPORALLY_STALE]: 'the cited records are not current; label it historical',
  [EvidenceState.UNVERIFIED]: 'the cited records could not be verified; label it inference or unknown',
  [EvidenceState.UNSUPPORTED]: 'the cited records do not establish the statement; label it general_knowledge or unknown',
  [EvidenceState.PARTIALLY_SUPPORTED]: 'the cited records support it only in part; label it partially_supported',
});

// The state of a model claim is not the model's to declare: it is derived from the same
// deterministic claims the brief listed, through the evidence ids the model cited.
function derivedEvidenceState(ids, analysis) {
  const forEvidence = analysis?.claims?.forEvidence;
  const byId = analysis?.claims?.byId;
  if (ids.length === 0 || !(forEvidence instanceof Map) || !(byId instanceof Map)) return null;
  const cited = new Set();
  for (const id of ids) {
    for (const claimId of forEvidence.get(id) ?? []) {
      const state = byId.get(claimId)?.evidenceState;
      if (state) cited.add(state);
    }
  }
  if (cited.size === 0) return EvidenceState.UNVERIFIED;
  return EVIDENCE_STATE_SEVERITY.find((state) => cited.has(state)) ?? EvidenceState.UNVERIFIED;
}

function claimStateProblem(at, kind, state) {
  const allowed = KIND_ALLOWED_STATES[kind];
  if (!allowed || allowed.has(state)) return null;
  return `${at} is marked ${kind} but ${STATE_PROBLEM[state] ?? 'the cited records do not support that label'}`;
}

export function validateStructuredResponse(value, { analysis } = {}) {
  const problems = [];
  if (!isObject(value)) {
    return { ok: false, problems: ['the structured response is not a JSON object'], value: null, repaired: null };
  }
  forbiddenField(value, 'response', problems);
  for (const key of Object.keys(value)) {
    if (!ROOT_KEYS.has(key)) problems.push(`response.${key} is not a recognized field`);
  }
  if (value.schema !== 1) problems.push('response.schema must be 1');
  if (!DECISIONS.has(value.decision)) problems.push('response.decision must be answer, clarify, refuse, or decline');
  if (!validText(value.answer, MAX_GROUNDING_ANSWER_CHARS)) problems.push(`response.answer must be a non-empty string of at most ${MAX_GROUNDING_ANSWER_CHARS} characters without control characters`);

  const evidenceById = analysis?.retrieval?.byId;
  const claims = [];
  if (value.claims !== undefined) {
    if (!Array.isArray(value.claims)) problems.push('response.claims must be an array');
    else if (value.claims.length > BOUNDS.maxStructuredClaims) problems.push(`response.claims must not exceed ${BOUNDS.maxStructuredClaims} entries`);
    else {
      value.claims.forEach((claim, index) => {
        const at = `response.claims[${index}]`;
        if (!isObject(claim)) {
          problems.push(`${at} must be an object`);
          return;
        }
        for (const key of Object.keys(claim)) {
          if (!CLAIM_KEYS.has(key)) problems.push(`${at}.${key} is not a recognized field`);
        }
        if (!validText(claim.text, BOUNDS.maxClaimText)) problems.push(`${at}.text must be a non-empty string of at most ${BOUNDS.maxClaimText} characters`);
        const kind = claim.kind ?? 'supported';
        if (!CLAIM_KINDS.has(kind)) problems.push(`${at}.kind must be one of ${[...CLAIM_KINDS].join(', ')}`);
        const evidence = claim.evidence ?? [];
        if (!Array.isArray(evidence)) {
          problems.push(`${at}.evidence must be an array of evidence ids`);
          return;
        }
        if (evidence.length > 6) problems.push(`${at}.evidence must cite at most 6 records`);
        const ids = [];
        for (const id of evidence) {
          if (typeof id !== 'string' || !/^ev:[a-z_]+:[A-Za-z0-9_.:-]{1,200}$/.test(id)) {
            problems.push(`${at}.evidence contains a value that is not an evidence id`);
            continue;
          }
          if (!(evidenceById instanceof Map) || !evidenceById.has(id)) {
            problems.push(`${at}.evidence cites ${id}, which is not in this retrieval`);
            continue;
          }
          if (!ids.includes(id)) ids.push(id);
        }
        if (KIND_ALLOWED_STATES[kind] && ids.length === 0) {
          problems.push(`${at} is marked ${kind} but cites no evidence; label it inference, assumption, or general_knowledge instead`);
        }
        const evidenceState = derivedEvidenceState(ids, analysis)
          ?? STATE_WITHOUT_EVIDENCE[kind]
          ?? EvidenceState.UNVERIFIED;
        if (ids.length > 0) {
          const mismatch = claimStateProblem(at, kind, evidenceState);
          if (mismatch) problems.push(mismatch);
        }
        claims.push({
          text: claim.text, kind, evidenceIds: ids, evidenceState,
        });
      });
    }
  }

  const deterministicUncertainty = analysis?.deliberation?.uncertainty?.category ?? null;
  let uncertainty = value.uncertainty ?? deterministicUncertainty;
  if (uncertainty !== null && !UNCERTAINTIES.has(uncertainty)) problems.push('response.uncertainty is not a recognized category');
  if (uncertainty && deterministicUncertainty
    && (CERTAINTY_RANK[uncertainty] ?? 0) > (CERTAINTY_RANK[deterministicUncertainty] ?? 0)) {
    problems.push(`response.uncertainty (${uncertainty}) claims more certainty than the analysis supports (${deterministicUncertainty})`);
  }

  let disclosures = [];
  if (value.disclosures !== undefined) {
    if (!Array.isArray(value.disclosures)) problems.push('response.disclosures must be an array');
    else {
      for (const code of value.disclosures) {
        if (!DISCLOSURES.has(code)) problems.push(`response.disclosures contains an unknown code: ${String(code).slice(0, 40)}`);
        else if (!disclosures.includes(code)) disclosures.push(code);
      }
    }
  }
  const required = [...requiredDisclosures(analysis), Disclosure.MODEL_OUTPUT_UNVERIFIED];
  const addedDisclosures = [...new Set(required)].filter((code) => !disclosures.includes(code));
  disclosures = [...disclosures, ...addedDisclosures];

  let missing = [];
  if (value.missing !== undefined) {
    if (!Array.isArray(value.missing)) problems.push('response.missing must be an array');
    else {
      for (const code of value.missing) {
        if (!MISSING.has(code)) problems.push(`response.missing contains an unknown code: ${String(code).slice(0, 40)}`);
        else if (!missing.includes(code)) missing.push(code);
      }
    }
  }

  let recommendation = null;
  if (value.recommendation !== undefined && value.recommendation !== null) {
    const rec = value.recommendation;
    if (!isObject(rec)) problems.push('response.recommendation must be an object');
    else {
      for (const key of Object.keys(rec)) {
        if (!RECOMMENDATION_KEYS.has(key)) problems.push(`response.recommendation.${key} is not a recognized field`);
      }
      if (!validText(rec.text, BOUNDS.maxClaimText)) problems.push('response.recommendation.text must be a non-empty string');
      if (rec.executed !== undefined && rec.executed !== false) problems.push('a recommendation must never be marked executed');
      if (rec.command !== undefined) {
        if (typeof rec.command !== 'string' || rec.command.length > MAX_STRUCTURED_COMMAND_CHARS || CONTROL_CHARS.test(rec.command)) {
          problems.push(`response.recommendation.command must be a plain string of at most ${MAX_STRUCTURED_COMMAND_CHARS} characters`);
        } else if (!/^node bin\/apex\.js [a-z]/i.test(rec.command)) {
          problems.push('response.recommendation.command must be an APEX CLI command, not an arbitrary command');
        }
      }
      recommendation = {
        text: rec.text,
        command: typeof rec.command === 'string' ? rec.command : null,
        executed: false,
      };
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems, value: null, repaired: null };
  }
  return {
    ok: true,
    problems: [],
    value: {
      schema: 1,
      decision: value.decision,
      answer: value.answer,
      claims,
      uncertainty,
      disclosures,
      missing,
      recommendation,
    },
    repaired: {
      addedDisclosures,
      uncertainty: value.uncertainty === undefined && deterministicUncertainty !== null,
      recommendationExecuted: false,
    },
  };
}

// A structured response is the only case where APEX adds the deterministic disclosures to what the
// user sees: the model named the claims, and the reader must be able to tell which of them rest on
// disagreeing, historical, or expectation-only records.
export function structuredDisclosureNotice(value) {
  const codes = Array.isArray(value?.disclosures) ? value.disclosures : [];
  if (codes.length === 0) return '';
  return `[APEX grounding: ${codes.map(disclosurePhrase).join('; ')}.]`;
}

// The deterministic uncertainty categories are qualitative labels. This helper keeps the wording in
// one place for a display that has no model text to carry it.
export function uncertaintyPhrase(uncertainty) {
  if (!uncertainty) return '';
  const about = uncertainty.about === UncertaintyAbout.FACT ? 'the truth of the claim'
    : uncertainty.about === UncertaintyAbout.CURRENCY ? 'whether the evidence is current'
      : uncertainty.about === UncertaintyAbout.IDENTITY ? 'which record is meant'
        : uncertainty.about === UncertaintyAbout.INFERENCE ? 'whether the inference follows'
          : 'whether an action succeeded';
  return `${uncertainty.category} (${about}): ${uncertainty.reason}`;
}
