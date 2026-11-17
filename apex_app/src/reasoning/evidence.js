// T-13 evidence normalization. Existing retrieval evidence is kept as a reference to its authoritative
// record: the reasoning session adds trust, time state, relation, and a bounded claim excerpt, not a
// copy of the source store. Document, external-observation and derived-conflict entries use the same
// shape so one assessment can reason over all of them.
import crypto from 'node:crypto';
import { BOUNDS, Trust, EvidenceRelation, TimeState, sourceOrder } from './vocabulary.js';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function cleanText(value, max = BOUNDS.maxEvidenceClaimChars) {
  return String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export function iso(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function queryTokens(value) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'which', 'who',
    'why', 'how', 'does', 'did', 'are', 'was', 'were', 'has', 'have', 'had', 'into', 'about', 'our',
    'you', 'your', 'can', 'could', 'should', 'would', 'there', 'their', 'then', 'than', 'not', 'but',
    'use', 'using', 'project', 'current', 'currently', 'please', 'tell', 'give', 'any', 'all',
  ]);
  return [...new Set(String(value ?? '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? [])]
    .filter((token) => !stop.has(token) && token.length >= 3)
    .slice(0, 20);
}

function overlaps(text, tokens) {
  if (tokens.length === 0) return true;
  const haystack = String(text ?? '').toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function validityOf(raw) {
  const validity = String(raw?.validity ?? '').toLowerCase();
  if (['retracted', 'superseded', 'historical', 'expired'].includes(validity)) return validity;
  return 'current';
}

function currentOf(raw, validity) {
  if (raw?.current === false) return false;
  return !['retracted', 'superseded', 'historical', 'expired'].includes(validity);
}

export function timeStateOf(item, now) {
  const at = Date.parse(now);
  const from = iso(item.validFrom);
  const until = iso(item.validUntil);
  if (item.current === false || ['retracted', 'superseded', 'historical'].includes(item.validity)) {
    return TimeState.HISTORICAL;
  }
  if (from && Number.isFinite(at) && Date.parse(from) > at) return TimeState.FUTURE;
  if (until && Number.isFinite(at) && Date.parse(until) < at) return TimeState.EXPIRED;
  if (Number.isFinite(at)) return TimeState.CURRENT;
  return TimeState.UNKNOWN;
}

export function trustFor(source, raw = {}) {
  const origin = String(raw?.provenance?.origin ?? raw?.origin ?? '').toLowerCase();
  if (source === 'user_instruction') return Trust.USER_STATEMENT;
  if (source === 'memory') {
    if (origin === 'model' || origin === 'apex') return Trust.MODEL_UNVERIFIED;
    return Trust.USER_STATEMENT;
  }
  if (source === 'knowledge' || source === 'knowledge_candidate') {
    if (raw?.candidate === true || origin === 'source_extracted' || source === 'knowledge_candidate') {
      return Trust.CANDIDATE;
    }
    if (origin === 'user_supplied' || origin === 'user_approved' || origin === 'user') return Trust.USER_CONFIRMED;
    if (origin === 'model') return Trust.MODEL_UNVERIFIED;
    return Trust.USER_CONFIRMED;
  }
  if (source === 'document' || source === 'document_history') return Trust.AUTHORIZED_DOCUMENT;
  if (source === 'external_observation') return Trust.EXTERNAL_OBSERVATION;
  if (source.startsWith('world_')) return Trust.WORLD_MODEL;
  if (source === 'goal' || source === 'goal_instruction') return Trust.USER_OBJECTIVE;
  if (source === 'plan' || source === 'task' || source === 'audit' || source === 'operation') {
    return Trust.OPERATIONAL_RECORD;
  }
  if (source === 'experience' || source === 'feedback') return Trust.OUTCOME;
  if (source === 'prediction') return Trust.EXPECTATION;
  if (source === 'temporal' || source === 'adaptation' || source === 'conflict' || source === 'causal') {
    return Trust.DERIVED;
  }
  if (source === 'conversation') {
    return origin === 'user' ? Trust.USER_STATEMENT : Trust.MODEL_UNVERIFIED;
  }
  return Trust.UNKNOWN;
}

export function relationFor(raw, trust) {
  const validity = validityOf(raw);
  if (currentOf(raw, validity) === false || validity === 'historical' || validity === 'superseded') {
    return EvidenceRelation.HISTORICAL;
  }
  // The current request is a statement of what the user asked, not evidence for its own answer.
  if (raw?.source === 'user_instruction') return EvidenceRelation.CONTEXTUAL;
  const contradicts = Array.isArray(raw?.relationships?.contradicts)
    ? raw.relationships.contradicts
    : Array.isArray(raw?.contradicts) ? raw.contradicts : [];
  if (contradicts.length > 0) return EvidenceRelation.CONTRADICTING;
  const status = String(raw?.status ?? raw?.recordStatus ?? '').toLowerCase();
  if (['conflicting', 'contradicted', 'contradicting'].includes(status)) return EvidenceRelation.CONTRADICTING;
  if (trust === Trust.CANDIDATE || trust === Trust.EXTERNAL_OBSERVATION || trust === Trust.MODEL_UNVERIFIED) {
    return EvidenceRelation.CONTEXTUAL;
  }
  if (['supported', 'confirmed', 'observation', 'directly_supported', 'completed', 'success', 'success_verified'].includes(status)) {
    return EvidenceRelation.SUPPORTING;
  }
  if (trust === Trust.USER_STATEMENT || trust === Trust.USER_CONFIRMED || trust === Trust.WORLD_MODEL
    || trust === Trust.OPERATIONAL_RECORD || trust === Trust.OUTCOME) {
    return EvidenceRelation.SUPPORTING;
  }
  return EvidenceRelation.CONTEXTUAL;
}

export function makeEvidence(input) {
  const source = String(input.source ?? 'unknown');
  const trust = input.trust ?? trustFor(source, input);
  const evidenceId = String(input.evidenceId ?? `ev:${source}:${digest(input)}`);
  const validity = input.validity ?? validityOf(input);
  const current = input.current ?? currentOf(input, validity);
  const relation = input.relation ?? relationFor({ ...input, current, validity }, trust);
  const validFrom = iso(input.validFrom);
  const validUntil = iso(input.validUntil);
  const observedAt = iso(input.observedAt) ?? iso(input.recordedAt) ?? iso(input.createdAt);
  const recordedAt = iso(input.recordedAt) ?? iso(input.createdAt) ?? observedAt;
  return {
    evidenceId,
    source,
    recordId: input.recordId == null ? null : String(input.recordId).slice(0, 200),
    documentId: input.documentId == null ? null : String(input.documentId),
    version: Number.isInteger(input.version) ? input.version : null,
    kind: String(input.kind ?? source),
    claim: cleanText(input.claim, BOUNDS.maxEvidenceClaimChars),
    provenance: {
      origin: input.provenance?.origin ?? input.origin ?? 'unknown',
      operationId: input.provenance?.operationId ?? null,
      updateMode: input.provenance?.updateMode ?? null,
    },
    observedAt,
    recordedAt,
    validFrom,
    validUntil,
    validity,
    current,
    trust,
    relation,
    locator: input.locator ? cleanText(input.locator, 240) : null,
    supersession: input.supersession ? cleanText(input.supersession, 200) : null,
    contradicts: (input.contradicts ?? input.relationships?.contradicts ?? [])
      .filter((id) => typeof id === 'string')
      .slice(0, 12),
    retrievalReason: cleanText(input.retrievalReason ?? 'retrieved by the bounded cross-subsystem retrieval coordinator', 240),
    untrustedContent: input.untrustedContent === true || source.startsWith('document') || source === 'external_observation'
      || source === 'knowledge' || source === 'knowledge_candidate',
  };
}

export function normalizeBaseEvidence(items, now, { perSource = BOUNDS.maxEvidencePerSource } = {}) {
  const out = [];
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const source = String(item.source ?? 'unknown');
    const used = counts.get(source) ?? 0;
    if (used >= perSource) continue;
    counts.set(source, used + 1);
    out.push(makeEvidence({
      ...item,
      source,
      recordId: item.recordId,
      claim: item.claim,
      provenance: item.provenance,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      validity: item.validity,
      current: item.current,
      observedAt: item.observedAt,
      recordedAt: item.recordedAt,
      retrievalReason: item.retrievalReason ?? `selected from ${source} by the unified retrieval coordinator`,
    }));
  }
  return out;
}

export function documentEvidence(result, now, { historical = false } = {}) {
  const version = Number.isInteger(result.version) ? result.version : Number(result.version) || null;
  const evidenceId = `ev:document:${result.documentId}:v${version ?? '?'}`;
  return makeEvidence({
    evidenceId,
    source: historical ? 'document_history' : 'document',
    recordId: `${result.documentId}:v${version ?? '?'}`,
    documentId: result.documentId,
    version,
    kind: historical ? 'document_version' : 'document_excerpt',
    claim: result.excerpt?.text ?? result.excerpt ?? result.snippet ?? result.summary ?? result.path ?? '',
    provenance: { origin: historical ? 'document_history' : 'authorized_document', operationId: null, updateMode: null },
    createdAt: result.createdAt,
    observedAt: result.ingestedAt ?? result.indexedAt ?? result.createdAt,
    validFrom: result.validFrom ?? null,
    validUntil: result.validUntil ?? null,
    validity: historical ? 'historical' : 'current',
    current: !historical,
    relation: historical ? EvidenceRelation.HISTORICAL : EvidenceRelation.SUPPORTING,
    trust: Trust.AUTHORIZED_DOCUMENT,
    locator: result.section ? `${result.path ?? result.documentId} § ${result.section.label ?? result.section.index ?? 'section'}` : (result.path ?? result.documentId),
    retrievalReason: historical
      ? 'an earlier authorized document version is retained to show change over time'
      : 'an authorized document matched the bounded lexical retrieval query',
    untrustedContent: true,
  });
}

export function candidateEvidence(fact, document, now) {
  return makeEvidence({
    evidenceId: `ev:knowledge:${fact.id}`,
    source: 'knowledge_candidate',
    recordId: fact.id,
    documentId: document?.documentId ?? null,
    version: document?.version ?? null,
    kind: 'knowledge_candidate',
    claim: `${fact.subject} --[${fact.relationship}]--> ${fact.object}`,
    provenance: { origin: 'source_extracted', operationId: null, updateMode: null },
    observedAt: document?.indexedAt ?? fact.createdAt,
    validFrom: fact.validFrom ?? null,
    validUntil: fact.validUntil ?? null,
    validity: 'current',
    current: true,
    relation: EvidenceRelation.CONTEXTUAL,
    trust: Trust.CANDIDATE,
    locator: document?.path ?? null,
    retrievalReason: 'a document-derived candidate was retrieved for assessment; it is not confirmed knowledge',
    untrustedContent: true,
  });
}

export function externalEvidence(event, now) {
  const observedAt = event.observedAt ?? event.occurredAt ?? event.recordedAt ?? event.createdAt;
  return makeEvidence({
    evidenceId: `ev:external_observation:${event.id}`,
    source: 'external_observation',
    recordId: event.id,
    kind: event.type ?? 'external_event',
    claim: event.summary ?? event.title ?? event.payload?.summary ?? event.type ?? 'external observation',
    provenance: { origin: event.provider ?? 'external_provider', operationId: null, updateMode: null },
    observedAt,
    recordedAt: event.recordedAt ?? observedAt,
    validFrom: event.occurredAt ?? observedAt,
    validUntil: event.validUntil ?? null,
    validity: 'current',
    current: true,
    relation: EvidenceRelation.CONTEXTUAL,
    trust: Trust.EXTERNAL_OBSERVATION,
    locator: event.sourceRef ?? event.provider ?? null,
    retrievalReason: 'an external observation matched the bounded lexical retrieval query',
    untrustedContent: true,
  });
}

// Cross-document candidate conflicts. Only a candidate fact extracted from two different authorized
// documents under the same field is compared. The values are not adjudicated: both are retained and
// the resulting evidence says only that the sources disagree.
export function documentCandidateConflicts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const relationship = String(entry.fact?.relationship ?? '').trim();
    if (!/^field:/i.test(relationship)) continue;
    const key = relationship.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const conflicts = [];
  for (const [key, members] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const documents = new Set(members.map((entry) => entry.document?.documentId).filter(Boolean));
    const values = new Map();
    for (const entry of members) {
      const value = String(entry.fact?.object ?? '').trim().toLowerCase();
      if (!value) continue;
      if (!values.has(value)) values.set(value, []);
      values.get(value).push(entry);
    }
    if (documents.size < 2 || values.size < 2) continue;
    const evidenceIds = [...new Set(members.map((entry) => `ev:knowledge:${entry.fact.id}`))];
    const labels = [...values.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([value, list]) => `${value} (${[...new Set(list.map((entry) => entry.document?.path ?? entry.document?.documentId))].slice(0, 3).join(', ')})`);
    conflicts.push(makeEvidence({
      evidenceId: `ev:reasoning_conflict:${digest({ key, evidenceIds })}`,
      source: 'conflict',
      recordId: `field:${key}`,
      kind: 'cross_document_conflict',
      claim: `${key} has competing recorded values across authorized documents: ${labels.join('; ')}. Both sides are kept and unresolved.`,
      provenance: { origin: 'deterministic_rule', operationId: null, updateMode: null },
      observedAt: null,
      recordedAt: null,
      validity: 'current',
      current: true,
      relation: EvidenceRelation.CONTRADICTING,
      trust: Trust.DERIVED,
      contradicts: evidenceIds,
      retrievalReason: 'the same extracted field has different values in different authorized documents; no source was selected',
    }));
  }
  return conflicts;
}

export function dedupeEvidence(items, { max = BOUNDS.maxEvidence } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.evidenceId || seen.has(item.evidenceId)) continue;
    seen.add(item.evidenceId);
    out.push(item);
  }
  out.sort((a, b) => {
    const current = Number(b.current) - Number(a.current);
    if (current !== 0) return current;
    const source = sourceOrder(a.source) - sourceOrder(b.source);
    if (source !== 0) return source;
    return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
  });
  return out.slice(0, max);
}

export function evidenceDigest(items) {
  return digest(items.map((item) => item.evidenceId).sort());
}

export { overlaps };
