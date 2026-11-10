// Claim extraction and contradiction mapping.
//
// A claim is a statement the evidence actually makes, or a conclusion the deterministic layer drew
// from those statements. The extractor never composes a new fact by joining two records, never
// resolves a disagreement by recency or repetition, and keeps every side of a conflict as its own
// linked claim. A derived view keeps its derived kind, so a pattern cannot be read as an observation
// and an expectation cannot be read as something that happened.
import {
  BOUNDS, ClaimKind, EvidenceSource, EvidenceState,
} from './vocabulary.js';

function claimKindFor(item) {
  switch (item.source) {
    case EvidenceSource.USER_INSTRUCTION:
    case EvidenceSource.CONVERSATION:
      return ClaimKind.STATEMENT;
    case EvidenceSource.PREDICTION:
      return ClaimKind.EXPECTATION;
    case EvidenceSource.ADAPTATION:
      return ClaimKind.RULE;
    case EvidenceSource.TEMPORAL:
      return item.type === 'temporal-pattern' ? ClaimKind.INFERENCE : ClaimKind.INFERENCE;
    case EvidenceSource.WORLD_CONFLICT:
      return ClaimKind.CONTRADICTED;
    case EvidenceSource.WORLD_FACT:
    case EvidenceSource.WORLD_RELATIONSHIP:
    case EvidenceSource.KNOWLEDGE:
      return item.status;
    case EvidenceSource.MEMORY:
      if (item.type === 'model_conclusion') return ClaimKind.INFERENCE;
      return item.status === 'recorded' ? ClaimKind.SUPPORTED : item.status;
    case EvidenceSource.EXPERIENCE:
      return ClaimKind.OBSERVATION;
    case EvidenceSource.FEEDBACK:
      return ClaimKind.OBSERVATION;
    case EvidenceSource.GOAL:
      return ClaimKind.GOAL_STATE;
    case EvidenceSource.PLAN:
      return ClaimKind.PLAN_STATE;
    case EvidenceSource.TASK:
      return ClaimKind.TASK_STATE;
    case EvidenceSource.WORLD_EVENT:
      return item.status === ClaimKind.UNKNOWN ? ClaimKind.UNKNOWN : ClaimKind.OBSERVATION;
    case EvidenceSource.WORLD_ENTITY:
      return ClaimKind.SUPPORTED;
    default:
      return ClaimKind.UNKNOWN;
  }
}

function isMaterial(kind) {
  return ![ClaimKind.STATEMENT, ClaimKind.RULE, ClaimKind.EXPECTATION, ClaimKind.RECOMMENDATION].includes(kind);
}

// What the evidence behind a claim can carry. Conflict wins over everything else: a contested record
// is not made current by being recent. Staleness comes next, then the kind's own strength. This is a
// label, never a score, and it is not a probability that the claim is true.
export function evidenceStateForClaim(claim) {
  if ((claim.contradicts?.length ?? 0) > 0 || claim.kind === ClaimKind.CONTRADICTED) {
    return EvidenceState.CONFLICTING;
  }
  if (claim.current === false || claim.kind === ClaimKind.HISTORICAL) {
    return EvidenceState.TEMPORALLY_STALE;
  }
  switch (claim.kind) {
    case ClaimKind.PARTIALLY_SUPPORTED:
      return EvidenceState.PARTIALLY_SUPPORTED;
    case ClaimKind.SUPPORTED:
    case ClaimKind.OBSERVATION:
    case ClaimKind.RULE:
    case ClaimKind.STATEMENT:
    case ClaimKind.GOAL_STATE:
    case ClaimKind.PLAN_STATE:
    case ClaimKind.TASK_STATE:
      return EvidenceState.DIRECTLY_SUPPORTED;
    case ClaimKind.INFERENCE:
    case ClaimKind.ASSUMPTION:
    case ClaimKind.UNKNOWN:
      return EvidenceState.UNVERIFIED;
    case ClaimKind.EXPECTATION:
    case ClaimKind.RECOMMENDATION:
      // The record shows that the expectation or recommendation exists. It is not evidence that the
      // expected outcome happened or that the advice is right, so the claim itself is unsupported.
      return EvidenceState.UNSUPPORTED;
    default:
      return EvidenceState.UNVERIFIED;
  }
}

function subjectKey(item) {
  if (item.subject?.entityId) return `entity:${item.subject.entityId}`;
  return `${item.source}:${item.recordId}`;
}

// Links claims that cite the same conflict group, and claims whose records the source itself marks
// as conflicting. The result is symmetric: both sides list the other, and neither is replaced.
function applyConflictLinks(claims, evidence, conflicts) {
  const claimByEvidence = new Map();
  for (const claim of claims) {
    for (const id of claim.evidenceIds) {
      const list = claimByEvidence.get(id) ?? [];
      list.push(claim);
      claimByEvidence.set(id, list);
    }
  }
  const membersOf = new Map();
  for (const group of conflicts ?? []) {
    const ids = (group.members ?? []).map((member) => member.id).filter(Boolean);
    if (ids.length === 0) continue;
    const claimIds = new Set();
    for (const id of ids) {
      for (const claim of claimByEvidence.get(`ev:world_fact:${id}`) ?? []) claimIds.add(claim.claimId);
    }
    membersOf.set(group, [...claimIds]);
  }
  for (const claim of claims) {
    for (const otherId of claim.contradicts) {
      for (const other of claimByEvidence.get(otherId) ?? []) {
        if (other.claimId === claim.claimId) continue;
        if (!claim.contradicts.includes(other.claimId)) claim.contradicts.push(other.claimId);
        if (!other.contradicts.includes(claim.claimId)) other.contradicts.push(claim.claimId);
        if (claim.kind === ClaimKind.SUPPORTED) claim.kind = ClaimKind.CONTRADICTED;
        if (other.kind === ClaimKind.SUPPORTED) other.kind = ClaimKind.CONTRADICTED;
      }
    }
  }
  for (const [group, claimIds] of membersOf) {
    for (const claimId of claimIds) {
      const claim = claims.find((entry) => entry.claimId === claimId);
      if (!claim) continue;
      claim.kind = ClaimKind.CONTRADICTED;
      claim.groupId = group.id ?? null;
      for (const otherId of claimIds) {
        if (otherId !== claimId && !claim.contradicts.includes(otherId)) claim.contradicts.push(otherId);
      }
    }
  }
}

export function extractClaims({ evidence = [], understanding = null, conflicts = [] } = {}) {
  const claims = [];
  for (const item of evidence) {
    if (claims.length >= BOUNDS.maxClaims) break;
    const kind = claimKindFor(item);
    const claim = {
      claimId: `cl:${claims.length + 1}`,
      text: item.claim,
      kind,
      evidenceIds: [item.evidenceId],
      source: item.source,
      type: item.type,
      subject: item.subject ?? null,
      current: item.current === true,
      material: isMaterial(kind),
      retrievalReason: item.retrievalReason,
      note: null,
      contradicts: [...(item.relationships?.contradicts ?? [])],
      groupId: null,
      subjectKey: subjectKey(item),
    };
    if (item.source === EvidenceSource.PREDICTION) {
      claim.note = 'a recorded expectation is not an observation and is not evidence that it happened';
    } else if (item.type === 'temporal-pattern') {
      claim.note = 'the pattern describes recorded order; it does not establish a cause';
    } else if (item.type === 'model_conclusion') {
      claim.note = 'an earlier model conclusion, stored as unverified';
    } else if (item.source === EvidenceSource.WORLD_CONFLICT) {
      claim.note = 'both sides are stored; the disagreement is unresolved';
    } else if (item.status === ClaimKind.HISTORICAL) {
      claim.note = 'recorded in the past; not current';
    } else if (item.status === ClaimKind.UNKNOWN) {
      claim.note = 'recorded without a usable validity, so it is not treated as current';
    } else if (item.source === EvidenceSource.USER_INSTRUCTION) {
      claim.note = 'the user\'s request; a statement of intent, not a stored fact';
    }
    claims.push(claim);
  }
  applyConflictLinks(claims, evidence, conflicts);

  // Duplicate claims from one store are not independent support. They are kept, because a stored
  // duplicate is a real record, but they share a support group so uncertainty cannot count them twice.
  const byText = new Map();
  for (const claim of claims) {
    const key = `${claim.source}\u0000${claim.text.toLowerCase()}`;
    const group = byText.get(key) ?? [];
    group.push(claim.claimId);
    byText.set(key, group);
  }
  for (const claim of claims) {
    const key = `${claim.source}\u0000${claim.text.toLowerCase()}`;
    claim.duplicateOf = (byText.get(key) ?? []).filter((id) => id !== claim.claimId);
    // Derived last, after conflict links and duplicates, because both can change what the record
    // behind the claim can support.
    claim.evidenceState = evidenceStateForClaim(claim);
  }

  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const forEvidence = new Map();
  for (const claim of claims) {
    for (const id of claim.evidenceIds) {
      const list = forEvidence.get(id) ?? [];
      list.push(claim.claimId);
      forEvidence.set(id, list);
    }
  }
  return {
    claims,
    byId,
    forEvidence,
    counts: {
      total: claims.length,
      material: claims.filter((claim) => claim.material).length,
      supported: claims.filter((claim) => claim.kind === ClaimKind.SUPPORTED).length,
      contradicted: claims.filter((claim) => claim.kind === ClaimKind.CONTRADICTED).length,
      historical: claims.filter((claim) => claim.kind === ClaimKind.HISTORICAL).length,
      inference: claims.filter((claim) => claim.kind === ClaimKind.INFERENCE).length,
      unknown: claims.filter((claim) => claim.kind === ClaimKind.UNKNOWN).length,
      expectation: claims.filter((claim) => claim.kind === ClaimKind.EXPECTATION).length,
      evidenceStates: Object.fromEntries(Object.values(EvidenceState).map((state) => [
        state,
        claims.filter((claim) => claim.evidenceState === state).length,
      ])),
    },
  };
}

// Every material claim the deterministic layer would present must name at least one evidence id that
// exists in the same retrieval. An inference may cite the records it was drawn from; an assumption
// cites nothing and is labelled as an assumption instead.
export function validateClaims(claims, evidenceById) {
  const problems = [];
  for (const claim of claims) {
    if (!claim.material) continue;
    if (claim.evidenceIds.length === 0) {
      problems.push(`${claim.claimId} is material but cites no evidence`);
      continue;
    }
    for (const id of claim.evidenceIds) {
      if (!evidenceById.has(id)) problems.push(`${claim.claimId} cites ${id}, which is not in this retrieval`);
    }
  }
  return { ok: problems.length === 0, problems };
}
