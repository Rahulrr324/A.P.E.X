// Competing hypotheses, contradiction explanations, and a facts/assumptions/unknowns ledger.
//
// This module reads the claims a request already extracted and asks two questions the claim layer
// does not: when the records disagree, what readings of them are possible, and what in the records
// could explain the disagreement. It composes no new fact and settles no conflict by recency,
// repetition, or source rank. Every reading cites the claims and evidence ids it rests on, and its
// support is a fixed label derived by rule from the evidence states, never a probability.
//
// The one selection this module makes is deliberately narrow: an observation of an outcome is
// directly supported where a recorded expectation about the same capability is not evidence of its
// own fulfilment. That rule is stated, bounded to a single matching observation, and recorded in the
// result. Everything else - including every explicit conflict between records - is left unselected
// with the reason stated.
import { ClaimKind, EvidenceState } from './vocabulary.js';

export const HYPOTHESIS_SCHEMA = 'apex.hypotheses.v1';

export const HYPOTHESIS_NOTE = 'competing readings describe what the records could mean and grant no authorization; every action is still authorized by the action registry';

const MAX_CLUSTERS = 3;
const MAX_MEMBERS = 3;
const MAX_HYPOTHESES = 6;
const MAX_EXPLANATIONS = 6;
const MAX_FACTS = 8;
const MAX_UNKNOWNS = 8;
const MAX_EVIDENCE_REFS = 12;
const MAX_STATEMENT_CHARS = 240;

export const SupportLevel = Object.freeze({
  DIRECT: 'directly_supported',
  PARTIAL: 'partially_supported',
  CONTRADICTED: 'contradicted',
  UNSUPPORTED: 'unsupported',
  UNRESOLVED: 'unresolved',
});

export const ReadingKind = Object.freeze({
  RECORD_HOLDS: 'record_holds',
  TIME_SCOPED: 'time_scoped',
  OBSERVATION_REPORTS: 'observation_reports',
  EXPECTATION_REPORTS: 'expectation_reports',
});

export const ExplanationKind = Object.freeze({
  RETRACTION_RECORDED: 'retraction_recorded',
  SUPERSESSION_RECORDED: 'supersession_recorded',
  TIME_SCOPE_DIFFERS: 'time_scope_differs',
  RECORDED_LATER: 'recorded_later',
  SOURCE_DIVERGENCE: 'source_divergence',
  EXPECTATION_NOT_OBSERVATION: 'expectation_not_observation',
  UNEXPLAINED: 'unexplained',
});

export const UnknownKind = Object.freeze({
  MISSING_INFORMATION: 'missing_information',
  UNESTABLISHED_CLAIM: 'unestablished_claim',
  UNREAD_SOURCE: 'unread_source',
});

function uniq(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function evidenceOf(claims) {
  return uniq(claims.flatMap((claim) => claim.evidenceIds ?? [])).slice(0, MAX_EVIDENCE_REFS);
}

function claimIdOrder(claim) {
  const match = /^cl:(\d+)$/.exec(String(claim?.claimId ?? ''));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// Union-find over the contradiction links the claim layer already established. Only links between
// claims in this extraction are followed; a link to an evidence id or to a claim that was not
// extracted names no claim here and does not create a reading.
function conflictClusters(claims) {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const parent = new Map(claims.map((claim) => [claim.claimId, claim.claimId]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  for (const claim of claims) {
    for (const ref of claim.contradicts ?? []) {
      if (byId.has(ref)) union(claim.claimId, ref);
    }
    if (claim.groupId && claim.kind === ClaimKind.CONTRADICTED) {
      for (const other of claims) {
        if (other.groupId === claim.groupId && other.claimId !== claim.claimId) {
          union(claim.claimId, other.claimId);
        }
      }
    }
  }
  const groups = new Map();
  for (const claim of claims) {
    if (claim.kind !== ClaimKind.CONTRADICTED && !(claim.contradicts ?? []).some((ref) => byId.has(ref))) continue;
    const root = find(claim.claimId);
    const list = groups.get(root) ?? [];
    list.push(claim);
    groups.set(root, list);
  }
  return [...groups.values()]
    .filter((list) => list.length >= 2)
    .map((list) => list.sort((a, b) => claimIdOrder(a) - claimIdOrder(b)))
    .sort((a, b) => claimIdOrder(a[0]) - claimIdOrder(b[0]))
    .slice(0, MAX_CLUSTERS);
}

// Predictions and experiences both name the capability they concern in a controlled prefix, so a
// recorded expectation can be paired with a recorded outcome without reading free prose. A
// capability that appears on both sides is the only pairing rule; nothing is matched by wording.
function capabilityOf(claim) {
  const text = String(claim.text ?? '');
  if (claim.kind === ClaimKind.EXPECTATION) {
    const match = /^([a-z][a-z0-9_.-]{1,80}):/.exec(text);
    return match ? match[1] : null;
  }
  if (claim.kind === ClaimKind.OBSERVATION) {
    const match = /\bcapability\s+([a-z][a-z0-9_.-]{1,80})\b/.exec(text);
    return match ? match[1] : null;
  }
  return null;
}

function expectationClusters(claims, excluded) {
  const used = new Set(excluded);
  // An expectation is deliberately not a material claim, so materiality cannot gate this pairing.
  const expectations = claims.filter((claim) => claim.kind === ClaimKind.EXPECTATION);
  const observations = claims.filter((claim) => claim.kind === ClaimKind.OBSERVATION);
  const pairs = [];
  for (const expectation of expectations) {
    const capability = capabilityOf(expectation);
    if (!capability) continue;
    const matching = observations.filter((observation) => capabilityOf(observation) === capability && !used.has(observation.claimId));
    if (matching.length === 0) continue;
    pairs.push({
      kind: 'expectation',
      capability,
      claims: [expectation, ...matching.slice(0, MAX_MEMBERS - 1)],
    });
    used.add(expectation.claimId);
    for (const observation of matching.slice(0, MAX_MEMBERS - 1)) used.add(observation.claimId);
    if (pairs.length >= MAX_CLUSTERS) break;
  }
  return pairs;
}

function evaluate(claims, { extraBasis = [] } = {}) {
  let direct = 0;
  let partial = 0;
  let contradicted = 0;
  let stale = 0;
  let unverified = 0;
  let unsupported = 0;
  const sources = new Set();
  for (const claim of claims) {
    switch (claim.evidenceState) {
      case EvidenceState.DIRECTLY_SUPPORTED: direct += 1; break;
      case EvidenceState.PARTIALLY_SUPPORTED: partial += 1; break;
      case EvidenceState.CONFLICTING:
      case EvidenceState.RETRACTED:
      case EvidenceState.SUPERSEDED: contradicted += 1; break;
      case EvidenceState.TEMPORALLY_STALE: stale += 1; break;
      case EvidenceState.UNSUPPORTED: unsupported += 1; break;
      default: unverified += 1;
    }
    if (typeof claim.source === 'string') sources.add(claim.source);
  }
  const basis = [];
  if (direct > 0) basis.push('cites_directly_supported_record');
  if (partial > 0) basis.push('record_supports_part_of_the_reading');
  if (contradicted > 0) basis.push('cited_record_is_contested');
  if (stale > 0) basis.push('cited_record_is_not_current');
  if (unverified > 0) basis.push('cited_record_is_unverified');
  if (unsupported > 0) basis.push('cited_record_does_not_establish_the_reading');
  if (sources.size >= 2) basis.push('more_than_one_source_cited');
  for (const item of extraBasis) {
    if (!basis.includes(item)) basis.push(item);
  }
  let level = SupportLevel.UNRESOLVED;
  if (contradicted > 0) level = SupportLevel.CONTRADICTED;
  else if (direct > 0 && partial + stale + unverified + unsupported === 0) level = SupportLevel.DIRECT;
  else if (direct > 0 || partial > 0) level = SupportLevel.PARTIAL;
  else if (unsupported > 0) level = SupportLevel.UNSUPPORTED;
  return {
    level,
    basis,
    counts: {
      direct, partiallySupported: partial, contradicted, stale, unverified, unsupported,
    },
    sources: [...sources].sort(),
    evidenceIds: evidenceOf(claims),
  };
}

function reading({ id, kind, claims, extraBasis = [], statement }) {
  return {
    id,
    kind,
    statement: String(statement).slice(0, MAX_STATEMENT_CHARS),
    claimIds: claims.map((claim) => claim.claimId),
    evidenceIds: evidenceOf(claims),
    support: evaluate(claims, { extraBasis }),
    chosen: false,
  };
}

function clusterExplanations(cluster, evidenceById, clusterIndex) {
  const list = [];
  const add = (kind, members, detail, explains) => {
    if (list.length >= MAX_EXPLANATIONS) return;
    list.push({
      id: `x:${clusterIndex}:${list.length + 1}`,
      kind,
      claimIds: members.map((claim) => claim.claimId),
      evidenceIds: evidenceOf(members),
      detail,
      explains: explains === true,
      settles: false,
    });
  };
  const validityOf = (claim) => claim.validity;
  const retracted = cluster.filter((claim) => validityOf(claim) === 'retracted');
  const superseded = cluster.filter((claim) => validityOf(claim) === 'superseded');
  const historical = cluster.filter((claim) => claim.current === false || validityOf(claim) === 'historical');
  const current = cluster.filter((claim) => claim.current === true && validityOf(claim) !== 'retracted' && validityOf(claim) !== 'superseded');
  if (retracted.length > 0) {
    add(ExplanationKind.RETRACTION_RECORDED, retracted,
      'a cited record was retracted by the user, so it no longer stands as a statement; the remaining side is not thereby proven current', true);
  }
  if (superseded.length > 0) {
    add(ExplanationKind.SUPERSESSION_RECORDED, superseded,
      'a cited record was replaced by a later record; supersession explains that record, not which remaining statement is true', true);
  }
  if (historical.length > 0 && current.length > 0) {
    add(ExplanationKind.TIME_SCOPE_DIFFERS, [...historical, ...current],
      'one cited record is current and another is historical or of unknown validity, so the statements may describe different periods rather than the same fact', true);
  }
  const recordedTimes = cluster
    .map((claim) => ({
      claim,
      at: claim.evidenceIds
        .map((id) => evidenceById?.get?.(id)?.recordedAt ?? null)
        .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
        .sort()
        .pop() ?? null,
    }))
    .filter((entry) => entry.at !== null);
  if (recordedTimes.length >= 2 && new Set(recordedTimes.map((entry) => entry.at)).size >= 2) {
    const latest = recordedTimes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-1)[0];
    add(ExplanationKind.RECORDED_LATER, [latest.claim],
      'one cited record was recorded later than the other; a later recording is not evidence of a later fact and is not used to settle the conflict', false);
  }
  const sources = new Set(cluster.map((claim) => claim.source));
  if (sources.size >= 2) {
    add(ExplanationKind.SOURCE_DIVERGENCE, cluster,
      'the disagreeing statements come from different source subsystems, so the conflict is between stores and not only between records', false);
  }
  if (!list.some((entry) => entry.explains)) {
    add(ExplanationKind.UNEXPLAINED, cluster,
      'the record metadata does not say why the statements disagree; the conflict is kept unresolved', false);
  }
  return list;
}

function contradictionReadings(cluster, clusterIndex) {
  const hypotheses = [];
  for (const claim of cluster.slice(0, MAX_MEMBERS)) {
    hypotheses.push(reading({
      id: `h:${clusterIndex}:${hypotheses.length + 1}`,
      kind: ReadingKind.RECORD_HOLDS,
      claims: [claim],
      statement: `the record itself says: ${claim.text}`,
    }));
  }
  const historical = cluster.some((claim) => claim.current === false || claim.validity === 'historical');
  const current = cluster.some((claim) => claim.current === true && claim.validity !== 'retracted' && claim.validity !== 'superseded');
  if (historical && current) {
    const scoped = reading({
      id: `h:${clusterIndex}:${hypotheses.length + 1}`,
      kind: ReadingKind.TIME_SCOPED,
      claims: cluster.slice(0, MAX_MEMBERS),
      statement: 'the records may describe different periods: one is recorded as current and another as historical, so both can hold for their own time',
      extraBasis: ['may_describe_different_periods'],
    });
    // The scope reading is possible, not established: the metadata supports the distinction, not the
    // conclusion that the two statements are both true.
    scoped.support.level = SupportLevel.PARTIAL;
    scoped.support.basis = uniq([...scoped.support.basis, 'metadata_separates_current_from_historical']);
    hypotheses.push(scoped);
  }
  return hypotheses;
}

function expectationReadings(pair, clusterIndex) {
  const hypotheses = [];
  for (const claim of pair.claims) {
    const isExpectation = claim.kind === ClaimKind.EXPECTATION;
    hypotheses.push(reading({
      id: `h:${clusterIndex}:${hypotheses.length + 1}`,
      kind: isExpectation ? ReadingKind.EXPECTATION_REPORTS : ReadingKind.OBSERVATION_REPORTS,
      claims: [claim],
      statement: isExpectation
        ? `the record states an expectation, not an outcome: ${claim.text}`
        : `the record states an observed outcome: ${claim.text}`,
      extraBasis: isExpectation ? ['an_expectation_is_not_evidence_of_its_outcome'] : [],
    }));
  }
  return hypotheses;
}

function selectExpectation(hypotheses) {
  const observations = hypotheses.filter((item) => item.kind === ReadingKind.OBSERVATION_REPORTS && item.support.level === SupportLevel.DIRECT);
  const expectations = hypotheses.filter((item) => item.kind === ReadingKind.EXPECTATION_REPORTS);
  if (observations.length !== 1 || expectations.length === 0) return null;
  if (expectations.some((item) => item.support.level === SupportLevel.DIRECT)) return null;
  return {
    chosen: observations[0].id,
    basis: ['observation_of_an_outcome', 'an_expectation_is_not_evidence_of_its_outcome'],
    reason: 'exactly one directly supported observation of the outcome was found; the expectation beside it is recorded intent, not evidence that it happened',
  };
}

function reasoningLedger({ understanding, retrieval, claims, assumptions }) {
  const facts = [];
  for (const claim of claims) {
    if (facts.length >= MAX_FACTS) break;
    if (claim.evidenceState !== EvidenceState.DIRECTLY_SUPPORTED) continue;
    if (![ClaimKind.SUPPORTED, ClaimKind.OBSERVATION].includes(claim.kind)) continue;
    if ((claim.contradicts ?? []).length > 0) continue;
    facts.push({ claimId: claim.claimId, evidenceIds: [...claim.evidenceIds].slice(0, MAX_EVIDENCE_REFS) });
  }
  const unknowns = [];
  const pushUnknown = (item) => {
    if (unknowns.length >= MAX_UNKNOWNS) return;
    unknowns.push(item);
  };
  for (const item of understanding?.missing ?? []) {
    pushUnknown({ kind: UnknownKind.MISSING_INFORMATION, code: String(item.code).slice(0, 60) });
  }
  for (const claim of claims) {
    if (claim.evidenceState !== EvidenceState.UNVERIFIED && claim.evidenceState !== EvidenceState.UNSUPPORTED) continue;
    pushUnknown({ kind: UnknownKind.UNESTABLISHED_CLAIM, claimId: claim.claimId });
  }
  for (const source of [...(retrieval?.counts?.unavailable ?? []), ...(retrieval?.counts?.damaged ?? [])]) {
    pushUnknown({ kind: UnknownKind.UNREAD_SOURCE, source: String(source).slice(0, 60) });
  }
  const assumptionsList = (assumptions ?? []).map((entry) => ({ code: String(entry.code).slice(0, 60) }));
  return {
    facts,
    assumptions: assumptionsList,
    unknowns,
    counts: {
      facts: facts.length,
      assumptions: assumptionsList.length,
      unknowns: unknowns.length,
    },
  };
}

// Returns the competing readings, the explanations for each disagreement, and the
// facts/assumptions/unknowns ledger. `authorizes` is always false: a reading is not a permission.
export function deriveHypotheses({
  understanding = null,
  retrieval = null,
  claims: claimList = [],
  assumptions = [],
} = {}) {
  const claims = Array.isArray(claimList) ? claimList : [];
  const evidenceById = retrieval?.byId ?? new Map();
  const conflictGroups = conflictClusters(claims);
  const used = conflictGroups.flat().map((claim) => claim.claimId);
  const expectationGroups = expectationClusters(claims, used);

  const hypotheses = [];
  const explanations = [];
  const groups = [];
  let clusterIndex = 0;
  for (const cluster of conflictGroups) {
    clusterIndex += 1;
    const readings = contradictionReadings(cluster, clusterIndex);
    const reasons = clusterExplanations(cluster, evidenceById, clusterIndex);
    groups.push({ kind: 'contradiction', hypothesisIds: readings.map((item) => item.id), explanationIds: reasons.map((item) => item.id) });
    for (const item of readings) {
      if (hypotheses.length < MAX_HYPOTHESES) hypotheses.push(item);
    }
    for (const item of reasons) {
      if (explanations.length < MAX_EXPLANATIONS) explanations.push(item);
    }
  }
  for (const pair of expectationGroups) {
    clusterIndex += 1;
    const readings = expectationReadings(pair, clusterIndex);
    const reasons = [{
      id: `x:${clusterIndex}:1`,
      kind: ExplanationKind.EXPECTATION_NOT_OBSERVATION,
      claimIds: pair.claims.map((claim) => claim.claimId),
      evidenceIds: evidenceOf(pair.claims),
      detail: `the expectation and the outcome both concern ${pair.capability}; they are different records and only the observation reports what happened`,
      explains: true,
      settles: false,
    }];
    groups.push({ kind: 'expectation', hypothesisIds: readings.map((item) => item.id), explanationIds: reasons.map((item) => item.id) });
    for (const item of readings) {
      if (hypotheses.length < MAX_HYPOTHESES) hypotheses.push(item);
    }
    for (const item of reasons) {
      if (explanations.length < MAX_EXPLANATIONS) explanations.push(item);
    }
  }

  const selection = selectExpectation(hypotheses) ?? {
    chosen: null,
    basis: hypotheses.length > 0 ? ['no_rule_selects_between_contested_records'] : [],
    reason: hypotheses.length > 0
      ? 'no reading is chosen: recency, repetition, and source rank are never used to settle a disagreement'
      : 'no competing reading was produced for this request',
  };
  for (const item of hypotheses) item.chosen = selection.chosen === item.id;

  const ledger = reasoningLedger({ understanding, retrieval, claims, assumptions });

  return {
    schema: HYPOTHESIS_SCHEMA,
    hypotheses,
    explanations,
    groups,
    selection,
    reasoning: ledger,
    counts: {
      hypotheses: hypotheses.length,
      explanations: explanations.length,
      contested: hypotheses.filter((item) => item.support.level === SupportLevel.CONTRADICTED).length,
      directlySupported: hypotheses.filter((item) => item.support.level === SupportLevel.DIRECT).length,
      unresolved: hypotheses.filter((item) => item.support.level === SupportLevel.UNRESOLVED).length,
      selected: selection.chosen === null ? 0 : 1,
      facts: ledger.counts.facts,
      assumptions: ledger.counts.assumptions,
      unknowns: ledger.counts.unknowns,
    },
    bounded: hypotheses.length >= MAX_HYPOTHESES || explanations.length >= MAX_EXPLANATIONS,
    authorizes: false,
    note: HYPOTHESIS_NOTE,
  };
}

// Counts and fixed labels only: the trace records that competing readings existed, never their
// wording or the records they cite.
export function hypothesisAudit(set) {
  if (!set || typeof set !== 'object') return null;
  const kinds = {};
  for (const item of set.hypotheses ?? []) {
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  }
  return {
    ...set.counts,
    selectedBy: [...new Set((set.selection?.basis ?? []).map((value) => String(value).slice(0, 60)))],
    kinds,
    bounded: set.bounded === true,
    authorizes: false,
  };
}
