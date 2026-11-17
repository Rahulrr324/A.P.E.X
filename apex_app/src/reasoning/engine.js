// Deterministic reasoning over the normalized evidence set. Nothing in this file calls a model; every
// classification below is a stated rule over explicit records, and every rule can be replayed.
import {
  BOUNDS, ConclusionClass, DecisionKind, EvidenceRelation, HypothesisStatus, SETTLING_TRUST,
  TimeState, Trust,
} from './vocabulary.js';
import { cleanText, queryTokens } from './evidence.js';

const SUPPORT_LEVELS = new Set(['direct', 'partial', 'none', 'contradicted', 'unknown']);

function uniq(values) {
  return [...new Set(values.filter((value) => value != null))];
}

export function assessEvidence(evidence, { now, conflicts = [], unsupportedClaims = [], missing = [], sources = [] } = {}) {
  const counts = {
    supporting: 0, contradicting: 0, contextual: 0, historical: 0, total: evidence.length,
  };
  const trustCounts = {};
  const stale = [];
  const candidate = [];
  const untrusted = [];
  for (const item of evidence) {
    if (Object.hasOwn(counts, item.relation)) counts[item.relation] += 1;
    trustCounts[item.trust] = (trustCounts[item.trust] ?? 0) + 1;
    if (item.relation === EvidenceRelation.HISTORICAL || !item.current) stale.push(item.evidenceId);
    if (item.trust === Trust.CANDIDATE) candidate.push(item.evidenceId);
    if (item.untrustedContent) untrusted.push(item.evidenceId);
  }

  const explicit = new Map();
  for (const item of evidence) {
    if (item.source === 'conflict') continue;
    for (const other of item.contradicts ?? []) {
      if (!evidence.some((candidateItem) => candidateItem.evidenceId === other)) continue;
      const key = [item.evidenceId, other].sort().join('|');
      explicit.set(key, { id: `conflict:${key}`, members: [item.evidenceId, other].sort(), kind: 'explicit_contradiction' });
    }
  }
  const groups = [];
  for (const conflict of conflicts) {
    if (!conflict || typeof conflict !== 'object') continue;
    const members = uniq([...(conflict.members ?? []), ...(conflict.evidenceIds ?? []), ...(conflict.contradicts ?? [])]);
    groups.push({
      id: String(conflict.id ?? conflict.kind ?? `conflict:${groups.length + 1}`).slice(0, 160),
      kind: String(conflict.kind ?? 'source_conflict').slice(0, 60),
      members,
      statement: cleanText(conflict.statement ?? conflict.claim ?? 'recorded sources disagree', 300),
      resolved: false,
      resolution: null,
    });
  }
  for (const group of explicit.values()) {
    if (groups.some((existing) => existing.members.join('|') === group.members.join('|'))) continue;
    groups.push({
      ...group,
      statement: 'the stored records explicitly mark one another as contradicting; both are retained',
      resolved: false,
      resolution: null,
    });
  }

  const independentSupport = uniq(evidence
    .filter((item) => item.current && item.relation === EvidenceRelation.SUPPORTING && SETTLING_TRUST.has(item.trust))
    .map((item) => `${item.source}:${item.recordId ?? item.evidenceId}`));
  const independentContradiction = uniq(evidence
    .filter((item) => item.current && item.relation === EvidenceRelation.CONTRADICTING && SETTLING_TRUST.has(item.trust))
    .map((item) => `${item.source}:${item.recordId ?? item.evidenceId}`));

  const unavailable = (sources ?? []).filter((source) => source.status === 'unavailable' || source.status === 'damaged');
  return {
    counts,
    trustCounts,
    independentSupport,
    independentContradiction,
    stale,
    candidate,
    untrusted,
    conflicts: groups.slice(0, 12),
    unsupportedClaims: (unsupportedClaims ?? []).slice(0, 12),
    missing: uniq((missing ?? []).map((item) => String(item.code ?? item).slice(0, 80))).slice(0, 12),
    sources: (sources ?? []).slice(0, 24),
    unavailable: unavailable.map((source) => source.source),
    currentSupport: evidence.filter((item) => item.current && item.relation === EvidenceRelation.SUPPORTING).length,
    currentContradiction: evidence.filter((item) => item.current && item.relation === EvidenceRelation.CONTRADICTING).length,
    note: 'counts describe retrieved records under stated rules; they are not probabilities',
  };
}

function normalizeBaseHypothesis(item, selection) {
  const level = String(item?.support?.level ?? 'unknown');
  const evidenceIds = uniq((item?.claims ?? []).flatMap((claim) => claim.evidenceIds ?? []));
  return {
    id: String(item?.id ?? `hypothesis:${evidenceIds.join(',') || 'unknown'}`).slice(0, 120),
    kind: String(item?.kind ?? 'record_reading').slice(0, 60),
    statement: cleanText(item?.statement ?? 'a recorded reading is possible', BOUNDS.maxStatementChars),
    evidenceIds: evidenceIds.slice(0, BOUNDS.maxEvidencePerHypothesis),
    supportLevel: SUPPORT_LEVELS.has(level) ? level : 'unknown',
    supportBasis: uniq((item?.support?.basis ?? []).map((basis) => String(basis).slice(0, 80))).slice(0, 8),
    contradictions: (item?.claims ?? []).filter((claim) => (claim.contradicts ?? []).length > 0)
      .flatMap((claim) => claim.contradicts).slice(0, 8),
    chosen: selection?.chosen === item?.id,
    preferred: false,
    status: HypothesisStatus.UNRESOLVED,
    reason: 'a recorded reading; the support level is qualitative, not a probability',
  };
}

export function buildHypotheses({ evidence, assessment, baseHypotheses = null, now }) {
  const normalized = (baseHypotheses?.hypotheses ?? [])
    .slice(0, BOUNDS.maxHypotheses)
    .map((item) => normalizeBaseHypothesis(item, baseHypotheses?.selection));
  for (const item of normalized) {
    if (item.chosen) {
      item.preferred = true;
      item.status = HypothesisStatus.PREFERRED;
      item.reason = baseHypotheses?.selection?.reason ?? 'the T-02 hypothesis rule selected this reading';
    }
  }

  // A document conflict whose facts are candidates rather than T-02 claims needs its own competing
  // readings. Each side is annotated with the document it came from and left unresolved.
  for (const conflict of assessment.conflicts) {
    if (normalized.length >= BOUNDS.maxHypotheses) break;
    const members = conflict.members
      .map((id) => evidence.find((item) => item.evidenceId === id))
      .filter(Boolean);
    if (members.length < 2) continue;
    for (const member of members.slice(0, 3)) {
      if (normalized.length >= BOUNDS.maxHypotheses) break;
      normalized.push({
        id: `hypothesis:${conflict.id}:${normalized.length + 1}`.slice(0, 140),
        kind: 'document_side',
        statement: `the record from ${member.locator ?? member.recordId ?? member.source} may hold: ${cleanText(member.claim, 220)}`,
        evidenceIds: [member.evidenceId],
        supportLevel: member.trust === Trust.CANDIDATE ? 'partial' : 'unknown',
        supportBasis: member.trust === Trust.CANDIDATE ? ['extracted_candidate_is_not_confirmed'] : ['source_excerpt_only'],
        contradictions: conflict.members.filter((id) => id !== member.evidenceId).slice(0, 8),
        chosen: false,
        preferred: false,
        status: HypothesisStatus.UNRESOLVED,
        reason: 'different authorized documents record different values; no source is selected',
      });
    }
  }

  if (normalized.length === 0) {
    if (assessment.currentSupport > 0) {
      const support = evidence.find((item) => item.current && item.relation === EvidenceRelation.SUPPORTING);
      normalized.push({
        id: 'hypothesis:support',
        kind: 'records_support',
        statement: `the current records may support an answer: ${cleanText(support?.claim ?? '', 240)}`,
        evidenceIds: support ? [support.evidenceId] : [],
        supportLevel: assessment.independentSupport.length >= 2 ? 'direct' : 'partial',
        supportBasis: [assessment.independentSupport.length >= 2 ? 'multiple_independent_current_records' : 'one_current_record'],
        contradictions: [],
        chosen: false,
        preferred: false,
        status: HypothesisStatus.UNRESOLVED,
        reason: 'one reading exists; it is not preferred unless the evidence rules support it',
      });
    } else {
      normalized.push({
        id: 'hypothesis:insufficient',
        kind: 'insufficient_evidence',
        statement: 'no current record establishes an answer to the request',
        evidenceIds: [],
        supportLevel: 'none',
        supportBasis: ['no_current_supporting_record'],
        contradictions: [],
        chosen: false,
        preferred: false,
        status: HypothesisStatus.UNRESOLVED,
        reason: 'absence of retrieved evidence is not evidence that the opposite is true',
      });
    }
  }

  const preferred = normalized.filter((item) => item.preferred);
  if (preferred.length !== 1) for (const item of normalized) {
    item.preferred = false;
    item.status = HypothesisStatus.UNRESOLVED;
  }
  const direct = normalized.filter((item) => item.supportLevel === 'direct' && item.contradictions.length === 0);
  if (preferred.length === 0 && direct.length === 1 && !assessment.conflicts.length) {
    direct[0].preferred = true;
    direct[0].status = HypothesisStatus.PREFERRED;
    direct[0].reason = 'the only reading with direct, uncontradicted support in the bounded evidence';
  }

  const alternatives = normalized.filter((item) => !item.preferred);
  return {
    hypotheses: normalized.slice(0, BOUNDS.maxHypotheses),
    preferred: normalized.find((item) => item.preferred)?.id ?? null,
    unresolved: alternatives.length,
    distinguishingEvidence: [
      ...(assessment.conflicts.length > 0 ? ['a user correction naming the authoritative source', 'a newer authorized document version'] : []),
      ...(assessment.currentSupport === 0 ? ['a user-supplied statement or a current authorized document that addresses the request'] : []),
      ...(assessment.candidate.length > 0 ? ['user confirmation of a candidate fact, which would still be a separate recorded act'] : []),
      ...(assessment.stale.length > 0 ? ['a current replacement for the historical record'] : []),
    ].slice(0, 6),
    note: 'preference is a rule outcome over recorded support, not a probability and not a settled truth',
    authorizes: false,
  };
}

export function analyzeTemporal(evidence, { now, plans = [] } = {}) {
  const at = Date.parse(now);
  const entries = evidence.map((item) => {
    const from = item.validFrom ? Date.parse(item.validFrom) : null;
    const until = item.validUntil ? Date.parse(item.validUntil) : null;
    let state = item.timeState;
    if (!state) {
      if (!item.current || ['retracted', 'superseded', 'historical'].includes(item.validity)) state = TimeState.HISTORICAL;
      else if (from && Number.isFinite(at) && from > at) state = TimeState.FUTURE;
      else if (until && Number.isFinite(at) && until < at) state = TimeState.EXPIRED;
      else state = Number.isFinite(at) ? TimeState.CURRENT : TimeState.UNKNOWN;
    }
    return {
      evidenceId: item.evidenceId,
      state,
      observedAt: item.observedAt,
      recordedAt: item.recordedAt,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      ageMs: Number.isFinite(at) && item.observedAt ? Math.max(0, at - Date.parse(item.observedAt)) : null,
    };
  });
  const sorted = [...entries].sort((a, b) => {
    const left = a.observedAt ? Date.parse(a.observedAt) : Number.MAX_SAFE_INTEGER;
    const right = b.observedAt ? Date.parse(b.observedAt) : Number.MAX_SAFE_INTEGER;
    return left - right || (a.evidenceId < b.evidenceId ? -1 : 1);
  });
  const byDocument = new Map();
  for (const item of evidence) {
    if (!item.documentId) continue;
    if (!byDocument.has(item.documentId)) byDocument.set(item.documentId, []);
    byDocument.get(item.documentId).push(item);
  }
  const changes = [];
  for (const [documentId, items] of byDocument) {
    const versions = uniq(items.map((item) => item.version)).sort((a, b) => a - b);
    if (versions.length < 2) continue;
    changes.push({
      documentId,
      versions,
      evidenceIds: items.map((item) => item.evidenceId).sort(),
      note: 'versions are ordered by their recorded version number; a later version is not automatically correct',
    });
  }
  const currentIds = new Set(entries.filter((entry) => entry.state === TimeState.CURRENT).map((entry) => entry.evidenceId));
  const historicalIds = new Set(entries.filter((entry) => entry.state === TimeState.HISTORICAL).map((entry) => entry.evidenceId));
  const crossTime = evidence
    .filter((item) => item.relation === EvidenceRelation.CONTRADICTING)
    .filter((item) => (item.contradicts ?? []).some((id) => historicalIds.has(id) || currentIds.has(id)))
    .map((item) => item.evidenceId);
  const outOfOrder = entries.filter((entry) => entry.observedAt && entry.recordedAt
    && Date.parse(entry.recordedAt) - Date.parse(entry.observedAt) > 86_400_000);
  return {
    entries: entries.slice(0, BOUNDS.maxEvidence),
    ordering: sorted.slice(0, BOUNDS.maxEvidence).map((entry) => entry.evidenceId),
    counts: {
      current: entries.filter((entry) => entry.state === TimeState.CURRENT).length,
      historical: entries.filter((entry) => entry.state === TimeState.HISTORICAL).length,
      expired: entries.filter((entry) => entry.state === TimeState.EXPIRED).length,
      future: entries.filter((entry) => entry.state === TimeState.FUTURE).length,
      unknown: entries.filter((entry) => entry.state === TimeState.UNKNOWN).length,
    },
    documentChanges: changes.slice(0, 8),
    contradictionsAcrossTime: uniq(crossTime).slice(0, 12),
    recordedLater: outOfOrder.slice(0, 12).map((entry) => entry.evidenceId),
    outdatedPlans: (plans ?? []).filter((plan) => ['blocked', 'cancelled', 'failed'].includes(plan.status))
      .slice(0, 12).map((plan) => ({ planId: plan.id, status: plan.status, version: plan.version ?? null })),
    note: 'event ordering is recorded order; the engine does not infer causation from it',
  };
}

export function evaluateConclusion({ assessment, hypotheses, dependencies, temporal, evidence, analysis = null, now }) {
  const conflict = assessment.conflicts.length > 0 || assessment.currentContradiction > 0;
  const trustedSupport = evidence.filter((item) => item.current && item.relation === EvidenceRelation.SUPPORTING
    && SETTLING_TRUST.has(item.trust));
  const untrustedSupport = evidence.filter((item) => item.current && item.relation === EvidenceRelation.SUPPORTING
    && !SETTLING_TRUST.has(item.trust));
  const staleSupport = evidence.filter((item) => !item.current && item.relation === EvidenceRelation.SUPPORTING);
  let classification;
  let reason;
  if (conflict) {
    classification = ConclusionClass.CONFLICTING;
    reason = 'current sources disagree; the disagreement is retained rather than settled by recency or repetition';
  } else if (trustedSupport.length >= 2 && assessment.independentSupport.length >= 2) {
    classification = ConclusionClass.STRONGLY_SUPPORTED;
    reason = 'at least two independent current records from settling trust classes support the reading';
  } else if (trustedSupport.length > 0) {
    classification = ConclusionClass.DIRECTLY_SUPPORTED;
    reason = 'a current record from a settling trust class supports the reading';
  } else if (untrustedSupport.length > 0 || staleSupport.length > 0 || assessment.candidate.length > 0) {
    classification = ConclusionClass.TENTATIVE;
    reason = staleSupport.length > 0 && trustedSupport.length === 0
      ? 'only historical or non-settling evidence was retrieved; it is not a current conclusion'
      : 'support exists only in a non-settling, candidate, or external class; it remains tentative';
  } else if (assessment.unsupportedClaims.length > 0) {
    classification = ConclusionClass.UNSUPPORTED;
    reason = 'the request contains a claim with no retrieved supporting record';
  } else {
    classification = ConclusionClass.UNKNOWN;
    reason = 'no current supporting record was retrieved; missing evidence is reported as unknown';
  }
  const top = trustedSupport[0] ?? evidence.find((item) => item.current && item.relation === EvidenceRelation.SUPPORTING);
  const statement = classification === ConclusionClass.CONFLICTING
    ? 'The current records conflict. No single conclusion is established; both sides are preserved and clarification is required.'
    : classification === ConclusionClass.TENTATIVE
      ? `A tentative reading is possible from ${staleSupport.length > 0 && trustedSupport.length === 0 ? 'historical' : 'non-settling'} evidence${top ? `: ${cleanText(top.claim, 240)}` : ''}`
      : classification === ConclusionClass.UNKNOWN
        ? 'The available records do not establish an answer. The missing information is listed explicitly.'
        : classification === ConclusionClass.UNSUPPORTED
          ? 'The statement is not supported by any retrieved current record.'
          : `The current records support: ${cleanText(top?.claim ?? '', 260)}`;
  const evidenceIds = uniq([
    ...trustedSupport.map((item) => item.evidenceId),
    ...(classification === ConclusionClass.CONFLICTING ? assessment.conflicts.flatMap((item) => item.members) : []),
    ...(classification === ConclusionClass.TENTATIVE ? untrustedSupport.concat(staleSupport).map((item) => item.evidenceId) : []),
  ]).slice(0, BOUNDS.maxEvidence);
  const rule = `conclusion:${classification}`;
  return {
    classification,
    statement,
    reason,
    evidenceIds,
    hypotheses: hypotheses.hypotheses.map((item) => item.id).slice(0, BOUNDS.maxHypotheses),
    preferredHypothesis: hypotheses.preferred,
    rules: [rule],
    confidence: classification === ConclusionClass.STRONGLY_SUPPORTED ? 'strong'
      : classification === ConclusionClass.DIRECTLY_SUPPORTED ? 'direct'
        : classification === ConclusionClass.CONFLICTING ? 'conflicting'
          : classification === ConclusionClass.TENTATIVE ? 'tentative' : 'none',
    stale: trustedSupport.length === 0 && staleSupport.length > 0,
    blockedDependencies: (dependencies.blocked ?? []).slice(0, 8).map((item) => item.nodeId),
    temporalLimitations: temporal.counts.historical > 0 ? [`${temporal.counts.historical} historical record(s) are shown but do not settle a current conclusion`] : [],
    authorizes: false,
    note: 'this classification is deterministic and explainable; it is not a probability and grants no permission',
  };
}

function option(id, kind, label, { satisfied = [], unmet = [], risks = [], reversible = null, requiresApproval = false, reason, evidenceIds = [], executable = false } = {}) {
  return {
    id,
    kind,
    label: cleanText(label, 240),
    satisfiedCriteria: satisfied,
    unmetCriteria: unmet,
    risks,
    reversible,
    requiresApproval,
    recommended: false,
    executable,
    reason: cleanText(reason, 320),
    evidenceIds: evidenceIds.slice(0, BOUNDS.maxEvidence),
  };
}

export function buildDecision({ conclusion, assessment, dependencies, temporal, goal = null }) {
  const options = [];
  const blocked = dependencies.blocked ?? [];
  const firstBlocked = blocked[0] ?? null;
  const evidenceIds = conclusion.evidenceIds ?? [];
  const criteria = uniq([
    ...(goal?.criteria ?? []).map((criterion) => String(criterion.text ?? criterion).slice(0, 120)),
    'preserve every conflicting source',
    'do not treat candidate or external evidence as confirmed knowledge',
    'do not execute an action from a reasoning conclusion',
  ]).slice(0, 12);

  if (conclusion.classification === ConclusionClass.CONFLICTING) {
    options.push(option('clarify', DecisionKind.CLARIFY, 'Ask the user to identify the authoritative source', {
      satisfied: ['both conflicting sides were retrieved', 'provenance was preserved'],
      unmet: ['no rule selects between the recorded values'],
      risks: ['choosing a source without the user would hide a real disagreement'],
      reversible: true,
      requiresApproval: false,
      reason: 'the sources conflict and the engine has no authority to choose one',
      evidenceIds,
    }));
  }
  if (firstBlocked) {
    const target = firstBlocked.blockers?.[0] ?? null;
    options.push(option('complete-prerequisite', DecisionKind.COMPLETE_PREREQUISITE, `Resolve prerequisite ${target ?? firstBlocked.nodeId} before continuing`, {
      satisfied: ['the dependency edge is explicitly recorded'],
      unmet: ['the prerequisite is not complete'],
      risks: ['executing downstream work before its prerequisite would violate the recorded plan order'],
      reversible: true,
      requiresApproval: false,
      reason: 'dependency propagation identifies an unsatisfied prerequisite; the recommendation does not execute it',
      evidenceIds,
    }));
  }
  if (temporal.counts.historical > 0 || temporal.counts.expired > 0 || conclusion.stale) {
    options.push(option('refresh', DecisionKind.REVIEW_OUTDATED, 'Retrieve a current replacement for the historical evidence', {
      satisfied: ['the historical record and its validity are known'],
      unmet: ['no current replacement is established'],
      risks: ['using a historical record as current would misstate the present'],
      reversible: true,
      requiresApproval: false,
      reason: 'time-scoped evidence cannot settle a current question',
      evidenceIds,
    }));
  }
  if (!options.length && [ConclusionClass.UNKNOWN, ConclusionClass.UNSUPPORTED, ConclusionClass.TENTATIVE].includes(conclusion.classification)) {
    options.push(option('gather', DecisionKind.GATHER_EVIDENCE, 'Gather the missing evidence before deciding', {
      satisfied: ['the missing evidence classes are listed'],
      unmet: ['no current supporting record is available'],
      risks: ['answering from absent evidence would invent information'],
      reversible: true,
      requiresApproval: false,
      reason: 'the current evidence set does not support a conclusion',
      evidenceIds,
    }));
  }
  if (!options.length) {
    options.push(option('answer', DecisionKind.ANSWER, 'Answer with the cited current records', {
      satisfied: ['the conclusion has current supporting evidence'],
      unmet: [],
      risks: ['the answer remains limited to the retrieved records'],
      reversible: true,
      requiresApproval: false,
      reason: 'the conclusion is supported by current evidence and needs no consequential action',
      evidenceIds,
    }));
  }

  const riskRank = { low: 0, medium: 1, high: 2, critical: 3, unknown: 1 };
  const ranked = [...options].sort((a, b) => {
    const approved = Number(b.requiresApproval) - Number(a.requiresApproval);
    if (approved !== 0) return approved;
    return (riskRank[a.risks.length > 0 ? 'medium' : 'low'] - riskRank[b.risks.length > 0 ? 'medium' : 'low'])
      || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  });
  const recommended = ranked[0];
  if (recommended) recommended.recommended = true;
  return {
    options: options.slice(0, 6),
    recommended: recommended?.id ?? null,
    criteria,
    constraints: goal?.constraints ? goal.constraints.slice?.(0, 8) ?? [] : [],
    missingInformation: assessment.missing,
    irreversibleActions: (dependencies.nodes ?? []).filter((node) => ['irreversible', 'not_reversible'].includes(node.reversibility) && node.status !== 'completed')
      .slice(0, 8).map((node) => ({ nodeId: node.id, action: node.action, description: node.description })),
    requiresApproval: recommended?.requiresApproval === true,
    executable: false,
    authorizes: false,
    note: 'options are compared with explicit recorded criteria; no utility score or probability is invented',
  };
}

export function reasoningTrace({ request, analysis, evidence, assessment, hypotheses, dependencies, temporal, conclusion, decision }) {
  const steps = [
    { step: 1, name: 'request', detail: { chars: String(request).length, intent: analysis?.understanding?.intent ?? null } },
    { step: 2, name: 'retrieval', detail: { evidence: evidence.length, sources: uniq(evidence.map((item) => item.source)).length } },
    { step: 3, name: 'assessment', detail: { ...assessment.counts, conflicts: assessment.conflicts.length, candidate: assessment.candidate.length } },
    { step: 4, name: 'hypotheses', detail: { count: hypotheses.hypotheses.length, preferred: hypotheses.preferred, unresolved: hypotheses.unresolved } },
    { step: 5, name: 'dependency', detail: { nodes: dependencies.totalNodes, blocked: dependencies.blocked.length, cycles: dependencies.cycles.length, causal: dependencies.causal.length } },
    { step: 6, name: 'temporal', detail: temporal.counts },
    { step: 7, name: 'conclusion', detail: { classification: conclusion.classification, rules: conclusion.rules } },
    { step: 8, name: 'decision', detail: { recommended: decision.recommended, executable: false } },
  ];
  return steps.slice(0, BOUNDS.maxTraceSteps);
}

export function reasoningSummary({ evidence, assessment, conclusion, dependencies, hypotheses }) {
  return {
    evidence: evidence.length,
    sources: uniq(evidence.map((item) => item.source)).length,
    supporting: assessment.counts.supporting,
    contradicting: assessment.counts.contradicting,
    historical: assessment.counts.historical,
    candidates: assessment.candidate.length,
    conflicts: assessment.conflicts.length,
    hypotheses: hypotheses.hypotheses.length,
    blocked: dependencies.blocked.length,
    conclusion: conclusion.classification,
  };
}

export function tokensFor(value) {
  return queryTokens(value);
}
