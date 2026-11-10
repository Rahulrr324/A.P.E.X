// Evidence lineage and claim re-evaluation.
//
// A claim records what it rested on when it was extracted: bounded references to the evidence that
// supported it, the links to records that contradicted it, and the lifecycle each cited record had at
// that moment. That recorded assessment is history and is never rewritten. A later read may ask what
// the same claim can still carry against the records as they are now; the answer is a new, separate
// assessment that names both the previous state and the current one.
//
// Missing or unreadable evidence makes a claim unverified, never false and never unsupported: the
// absence of a record is not evidence that the claim is wrong. Contradictory evidence is a different
// state and stays distinguishable from a claim nothing supports. This module reads no store, writes
// nothing, and performs no I/O.
import {
  BOUNDS, ClaimKind, CLAIM_KINDS, EVIDENCE_STATES, EvidenceState, EvidenceValidity, SourceStatus,
} from './vocabulary.js';

const MAX_LINEAGE_CLAIMS = BOUNDS.maxClaims;
const MAX_LINEAGE_REFS = BOUNDS.maxLineageRefs;
const EVIDENCE_REF = /^ev:([a-z_]+):[A-Za-z0-9_.:-]{1,200}$/;
const CLAIM_ID = /^cl:[1-9][0-9]?$/;

// The kinds whose recorded state is a statement about the evidence's strength rather than about the
// claim's category. Only these can return to directly supported when a stale record becomes current.
const FACT_KINDS = new Set([
  ClaimKind.SUPPORTED,
  ClaimKind.PARTIALLY_SUPPORTED,
  ClaimKind.OBSERVATION,
  ClaimKind.GOAL_STATE,
  ClaimKind.PLAN_STATE,
  ClaimKind.TASK_STATE,
  ClaimKind.STATEMENT,
  ClaimKind.RULE,
]);

const SUPPORTED_STATES = new Set([EvidenceState.DIRECTLY_SUPPORTED, EvidenceState.PARTIALLY_SUPPORTED]);
const WITHDRAWN_STATES = new Set([
  EvidenceState.CONFLICTING,
  EvidenceState.RETRACTED,
  EvidenceState.SUPERSEDED,
  EvidenceState.TEMPORALLY_STALE,
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEvidenceRef(value) {
  return typeof value === 'string' && EVIDENCE_REF.test(value);
}

function isClaimId(value) {
  return typeof value === 'string' && CLAIM_ID.test(value);
}

function boundedRefs(values, test) {
  const kept = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!test(value) || kept.includes(value)) continue;
    kept.push(value);
    if (kept.length >= MAX_LINEAGE_REFS) break;
  }
  return kept;
}

function sourceOf(ref) {
  const match = EVIDENCE_REF.exec(ref);
  return match ? match[1] : null;
}

function validityOf(item) {
  if (typeof item?.validity === 'string' && Object.values(EvidenceValidity).includes(item.validity)) {
    return item.validity;
  }
  return item?.current === false ? EvidenceValidity.HISTORICAL : EvidenceValidity.CURRENT;
}

// ---- snapshots ---------------------------------------------------------------------------------
// A snapshot is what a caller may keep so a later read can re-evaluate it. It carries identifiers,
// kinds, states, and counts only: no claim text, no stored content, no prose.

export function claimLineageSnapshot(claimSetOrClaims) {
  const all = Array.isArray(claimSetOrClaims) ? claimSetOrClaims : claimSetOrClaims?.claims;
  const claims = Array.isArray(all) ? all.slice(0, MAX_LINEAGE_CLAIMS) : [];
  return {
    schema: 1,
    source: 'claim_set',
    claimCount: Array.isArray(all) ? all.length : 0,
    truncated: Array.isArray(all) ? all.length > claims.length : false,
    claims: claims.map((claim) => ({
      claimId: typeof claim?.claimId === 'string' ? claim.claimId : null,
      kind: typeof claim?.kind === 'string' ? claim.kind : null,
      evidenceState: typeof claim?.evidenceState === 'string' ? claim.evidenceState : null,
      evidenceIds: boundedRefs(claim?.lineage?.supports ?? claim?.evidenceIds, isEvidenceRef),
      contradicts: boundedRefs(claim?.lineage?.contradicts ?? claim?.contradicts, isEvidenceRef),
      claimLinks: boundedRefs(claim?.lineage?.claimLinks ?? claim?.contradicts, isClaimId),
    })),
    note: 'bounded lineage recorded when this reading was produced; re-evaluate it against a later view and never overwrite it',
  };
}

export function responseLineageSnapshot(structured) {
  const all = Array.isArray(structured?.claims) ? structured.claims : [];
  const claims = all.slice(0, BOUNDS.maxStructuredClaims);
  return {
    schema: 1,
    source: 'model_response',
    claimCount: all.length,
    truncated: all.length > claims.length,
    claims: claims.map((claim, index) => ({
      claimId: null,
      at: index + 1,
      kind: typeof claim?.kind === 'string' ? claim.kind : null,
      evidenceState: typeof claim?.evidenceState === 'string' ? claim.evidenceState : null,
      evidenceIds: boundedRefs(claim?.evidenceIds ?? claim?.evidence, isEvidenceRef),
      contradicts: [],
      claimLinks: [],
    })),
    note: 'the evidence a validated model response cited; the response itself remains unverified',
  };
}

const MODEL_ONLY_KINDS = new Set(['general_knowledge']);

export function validateLineageSnapshot(snapshot) {
  const problems = [];
  if (!isObject(snapshot)) return { ok: false, problems: ['a lineage snapshot must be an object'] };
  if (snapshot.schema !== 1) problems.push('lineage.schema must be 1');
  if (snapshot.source !== 'claim_set' && snapshot.source !== 'model_response') {
    problems.push('lineage.source must be claim_set or model_response');
  }
  if (!Array.isArray(snapshot.claims) || snapshot.claims.length > MAX_LINEAGE_CLAIMS) {
    problems.push(`lineage.claims must hold at most ${MAX_LINEAGE_CLAIMS} entries`);
    return { ok: false, problems: problems.slice(0, 8) };
  }
  if (!Number.isInteger(snapshot.claimCount) || snapshot.claimCount < snapshot.claims.length) {
    problems.push('lineage.claimCount must be an integer covering the listed claims');
  }
  snapshot.claims.forEach((claim, index) => {
    const at = `lineage.claims[${index}]`;
    if (!isObject(claim)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (claim.claimId !== null && !isClaimId(claim.claimId)) problems.push(`${at}.claimId must be a claim id or null`);
    if (claim.at !== undefined && (!Number.isInteger(claim.at) || claim.at < 1)) problems.push(`${at}.at must be a positive integer when present`);
    if (claim.kind !== null && !(CLAIM_KINDS.includes(claim.kind) || MODEL_ONLY_KINDS.has(claim.kind))) {
      problems.push(`${at}.kind is not a known claim kind`);
    }
    if (claim.evidenceState !== null && !EVIDENCE_STATES.includes(claim.evidenceState)) {
      problems.push(`${at}.evidenceState is not a known evidence state`);
    }
    for (const field of ['evidenceIds', 'contradicts']) {
      const refs = claim[field];
      if (!Array.isArray(refs) || refs.length > MAX_LINEAGE_REFS || !refs.every(isEvidenceRef)) {
        problems.push(`${at}.${field} must be a bounded list of evidence references`);
      }
    }
    const links = claim.claimLinks;
    if (!Array.isArray(links) || links.length > MAX_LINEAGE_REFS || !links.every(isClaimId)) {
      problems.push(`${at}.claimLinks must be a bounded list of claim ids`);
    }
  });
  return { ok: problems.length === 0, problems: problems.slice(0, 8) };
}

// ---- re-evaluation ------------------------------------------------------------------------------

function statusMap(sources, unavailable, damaged) {
  const map = new Map();
  for (const entry of Array.isArray(sources) ? sources : []) {
    if (typeof entry?.source === 'string' && typeof entry?.status === 'string') map.set(entry.source, entry.status);
    else if (typeof entry === 'string') map.set(entry, SourceStatus.UNAVAILABLE);
  }
  for (const source of Array.isArray(unavailable) ? unavailable : []) map.set(source, SourceStatus.UNAVAILABLE);
  for (const source of Array.isArray(damaged) ? damaged : []) map.set(source, SourceStatus.DAMAGED);
  return map;
}

function inspect(id, byId, statuses) {
  const source = sourceOf(id);
  const status = statuses.get(source);
  if (status === SourceStatus.UNAVAILABLE || status === SourceStatus.DAMAGED) {
    return { code: 'unreadable' };
  }
  const item = byId.get(id);
  if (!item) return { code: 'missing' };
  const validity = validityOf(item);
  if (validity === EvidenceValidity.RETRACTED) return { code: 'retracted' };
  if (validity === EvidenceValidity.SUPERSEDED) return { code: 'superseded' };
  if (validity === EvidenceValidity.HISTORICAL || item.current === false) return { code: 'stale' };
  if (item.status === ClaimKind.CONTRADICTED || (Array.isArray(item.contradicts) && item.contradicts.length > 0)) {
    return { code: 'contradicted' };
  }
  return { code: null };
}

// What a claim can be when every record it cites is readable and current. Kind-derived states
// (unverified inference, unsupported expectation) are not evidence-strength states, so they do not
// move toward supported just because the record was read again.
function baselineStateFor(kind) {
  if (!kind) return EvidenceState.UNVERIFIED;
  if (FACT_KINDS.has(kind)) return EvidenceState.DIRECTLY_SUPPORTED;
  if (kind === ClaimKind.EXPECTATION || kind === ClaimKind.RECOMMENDATION
    || MODEL_ONLY_KINDS.has(kind)) return EvidenceState.UNSUPPORTED;
  return EvidenceState.UNVERIFIED;
}

function stateWithoutEvidence(previous) {
  return SUPPORTED_STATES.has(previous) ? EvidenceState.UNVERIFIED : previous;
}

export function reassessClaims(recorded, {
  evidenceById = new Map(),
  sources = [],
  unavailable = [],
  damaged = [],
} = {}) {
  const all = Array.isArray(recorded) ? recorded : (Array.isArray(recorded?.claims) ? recorded.claims : []);
  const byId = evidenceById instanceof Map ? evidenceById : new Map(Object.entries(evidenceById ?? {}));
  const statuses = statusMap(sources, unavailable, damaged);
  const assessed = [];
  const reasonCounts = {
    contradicted: 0, retracted: 0, superseded: 0, stale: 0, missing: 0, unreadable: 0,
  };

  for (const entry of all.slice(0, MAX_LINEAGE_CLAIMS)) {
    const previous = typeof entry?.evidenceState === 'string' && EVIDENCE_STATES.includes(entry.evidenceState)
      ? entry.evidenceState
      : EvidenceState.UNVERIFIED;
    const supports = boundedRefs(entry?.lineage?.supports ?? entry?.evidenceIds ?? entry?.supports, isEvidenceRef);
    const opposes = boundedRefs(entry?.contradicts ?? entry?.lineage?.contradicts, isEvidenceRef);
    const reasons = [];
    const found = {
      conflicting: false, retracted: false, superseded: false, stale: false, missing: false, unreadable: false,
    };
    const note = (code, evidenceId, side) => {
      reasons.push({ code, evidenceId, side });
    };

    for (const id of supports) {
      const result = inspect(id, byId, statuses);
      if (result.code === null) continue;
      if (result.code === 'contradicted') {
        found.conflicting = true;
        note('contradicted', id, 'supporting');
        continue;
      }
      found[result.code] = true;
      note(result.code, id, 'supporting');
    }

    // A contradicting record that is currently readable and current keeps the disagreement live. A
    // withdrawn one no longer contradicts; a missing or unreadable one cannot be used as proof either
    // way, so it is reported but never settles the claim.
    for (const id of opposes) {
      const result = inspect(id, byId, statuses);
      if (result.code === null) {
        found.conflicting = true;
        note('contradicted', id, 'opposing');
      } else if (result.code === 'retracted' || result.code === 'superseded' || result.code === 'stale') {
        note(result.code, id, 'opposing');
      } else {
        found[result.code] = true;
        note(result.code, id, 'opposing');
      }
    }

    let evidenceState;
    if (found.conflicting) evidenceState = EvidenceState.CONFLICTING;
    else if (found.retracted) evidenceState = EvidenceState.RETRACTED;
    else if (found.superseded) evidenceState = EvidenceState.SUPERSEDED;
    else if (found.stale) evidenceState = EvidenceState.TEMPORALLY_STALE;
    else if (found.missing || found.unreadable) evidenceState = stateWithoutEvidence(previous);
    else if (SUPPORTED_STATES.has(previous) || previous === EvidenceState.UNVERIFIED
      || previous === EvidenceState.UNSUPPORTED) evidenceState = previous;
    else if (WITHDRAWN_STATES.has(previous)) evidenceState = baselineStateFor(entry?.kind);
    else evidenceState = previous;

    const codes = new Set(reasons.map((reason) => reason.code));
    for (const code of Object.keys(reasonCounts)) {
      if (codes.has(code)) reasonCounts[code] += 1;
    }
    assessed.push({
      claimId: typeof entry?.claimId === 'string' ? entry.claimId : null,
      kind: typeof entry?.kind === 'string' ? entry.kind : null,
      previousState: previous,
      evidenceState,
      changed: evidenceState !== previous,
      reasons: reasons.slice(0, MAX_LINEAGE_REFS),
    });
  }

  const byState = {};
  for (const state of EVIDENCE_STATES) {
    const count = assessed.filter((item) => item.evidenceState === state).length;
    if (count > 0) byState[state] = count;
  }
  const weakened = assessed.filter((item) => item.changed
    && SUPPORTED_STATES.has(item.previousState) && !SUPPORTED_STATES.has(item.evidenceState)).length;
  const restored = assessed.filter((item) => item.changed
    && WITHDRAWN_STATES.has(item.previousState) && SUPPORTED_STATES.has(item.evidenceState)).length;

  return {
    schema: 1,
    claims: assessed,
    counts: {
      total: assessed.length,
      changed: assessed.filter((item) => item.changed).length,
      unchanged: assessed.filter((item) => !item.changed).length,
      previouslySupported: assessed.filter((item) => SUPPORTED_STATES.has(item.previousState)).length,
      stillSupported: assessed.filter((item) => SUPPORTED_STATES.has(item.evidenceState)).length,
      weakened,
      restored,
      byState,
      reasons: reasonCounts,
    },
    note: 'derived at read time from the records as they are now; the recorded assessment is not rewritten, missing evidence is not disproof, and contradictory evidence stays distinct from no support',
  };
}
