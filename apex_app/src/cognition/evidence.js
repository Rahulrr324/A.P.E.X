// Integrated evidence retrieval and the unified evidence representation.
//
// This is a coordinator, not a store. It reads the stores APEX already has, under explicit bounds,
// and reduces what it read to one in-memory shape so later stages can link a claim to the record it
// came from. Nothing is written and nothing is persisted. When a caller already retrieved a section
// (memory hits, the World Model state, executive records), the seed is used instead of reading the
// same store twice.
//
// Two distinctions the coordinator must keep:
//  - "nothing is recorded" (an empty source) is not "the store could not be read" (unavailable or
//    damaged). Both are reported, and only the first supports a claim that nothing exists.
//  - a derived view (temporal pattern, prediction expectation) is never represented as an
//    observation. Its evidence type and status say what it is.
import { singleLine, truncate } from '../util.js';
import * as worldQuery from '../world/query.js';
import { readReport, sourceRead } from '../evidence/read-contract.js';
import {
  BOUNDS, ClaimKind, EVIDENCE_VALIDITIES, EvidenceSource, EvidenceValidity, SourceStatus, Uncertainty,
  sourceRank,
} from './vocabulary.js';

function provided(seeds, key) {
  return Object.prototype.hasOwnProperty.call(seeds ?? {}, key);
}

function failureStatus(err) {
  const message = String(err?.message ?? '');
  if (/corrupt|damaged|invalid line/i.test(message) || err?.code === 'CORRUPT' || err?.code === 'STORE_CORRUPT') {
    return SourceStatus.DAMAGED;
  }
  return SourceStatus.UNAVAILABLE;
}

function safeClaim(text, max = BOUNDS.maxClaimChars) {
  return singleLine(text, max);
}

function iso(value) {
  if (!value) return null;
  const text = String(value);
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function provenanceOf(record) {
  const provenance = record?.provenance ?? {};
  return {
    origin: typeof provenance.origin === 'string' ? provenance.origin : null,
    operationId: typeof provenance.operationId === 'string' ? provenance.operationId : null,
    updateMode: typeof provenance.updateMode === 'string' ? provenance.updateMode : null,
  };
}

function evidenceRefs(detail) {
  if (!Array.isArray(detail)) return [];
  return detail.slice(0, 4).map((entry) => {
    if (typeof entry === 'string') return entry;
    const sourceType = typeof entry?.sourceType === 'string' ? entry.sourceType : 'record';
    const sourceId = typeof entry?.sourceId === 'string' ? entry.sourceId : '';
    return sourceId ? `${sourceType}:${sourceId}` : sourceType;
  });
}

export function evidenceId(source, recordId) {
  return `ev:${source}:${String(recordId ?? '').slice(0, 200)}`;
}

function sourceEntry(source) {
  return { source, status: SourceStatus.SKIPPED, count: 0, detail: null };
}

function setSource(sources, source, status, count = 0, detail = null) {
  const entry = sources.find((item) => item.source === source);
  if (!entry) return;
  entry.status = status;
  entry.count = count;
  entry.detail = detail;
}

function addEvidence(list, counters, item) {
  if (!item || typeof item.evidenceId !== 'string') return null;
  if (list.some((entry) => entry.evidenceId === item.evidenceId)) return item.evidenceId;
  const count = counters.get(item.source) ?? 0;
  if (count >= BOUNDS.maxEvidencePerSource) {
    // A record refused by the per-source bound is omitted evidence, not a record that does not
    // exist. It is counted so the disclosure can say retrieval was bounded.
    counters.overflow = (counters.overflow ?? 0) + 1;
    return null;
  }
  counters.set(item.source, count + 1);
  const record = {
    evidenceId: item.evidenceId,
    source: item.source,
    recordId: String(item.recordId ?? ''),
    type: item.type,
    subject: item.subject ?? null,
    claim: safeClaim(item.claim ?? ''),
    observedAt: iso(item.observedAt),
    validFrom: iso(item.validFrom),
    validUntil: iso(item.validUntil),
    recordedAt: iso(item.recordedAt),
    provenance: item.provenance ?? { origin: null, operationId: null, updateMode: null },
    status: item.status ?? 'recorded',
    current: item.current !== false,
    // What this read knew about the record's lifecycle. A reader that does not state one gets the
    // weaker of the two facts it does have: not-current records are historical, not current.
    validity: EVIDENCE_VALIDITIES.includes(item.validity)
      ? item.validity
      : (item.current === false ? EvidenceValidity.HISTORICAL : EvidenceValidity.CURRENT),
    retrievalReason: item.retrievalReason ?? 'match',
    relationships: {
      supports: Array.isArray(item.supports) ? [...new Set(item.supports)].slice(0, 12) : [],
      contradicts: Array.isArray(item.contradicts) ? [...new Set(item.contradicts)].slice(0, 12) : [],
    },
    memberIds: Array.isArray(item.memberIds) ? item.memberIds.slice(0, 8) : [],
  };
  list.push(record);
  return record.evidenceId;
}

function worldFactStatus(status) {
  if (status === 'supported') return ClaimKind.SUPPORTED;
  if (status === 'contested' || status === 'conflicting') return ClaimKind.CONTRADICTED;
  if (status === 'historical') return ClaimKind.HISTORICAL;
  if (status === 'validity_unknown') return ClaimKind.UNKNOWN;
  return ClaimKind.UNKNOWN;
}

function factLabel(fact) {
  if (fact.direction === 'incoming') {
    return `${fact.subjectName} ${fact.predicate} this entity`;
  }
  const value = fact.objectLabel ?? fact.objectValueKey ?? 'an unspecified value';
  return `${fact.predicate} = ${value}`;
}

function rangeLabel(item) {
  if (!item.validFrom) return 'validity unknown';
  return `valid ${item.validFrom}..${item.validUntil ?? 'open'}`;
}

function readWorld(state, conflictSet, understanding, request, list, counters, sources, now) {
  if (!state || !(state.entities instanceof Map)) {
    setSource(sources, EvidenceSource.WORLD_ENTITY, SourceStatus.SKIPPED);
    return;
  }
  // The world query layer wants the full conflict analysis (`{ groups, contested, counts }`); this
  // layer iterates the groups. Both shapes are accepted so a caller can pass whatever it already has.
  const conflicts = Array.isArray(conflictSet) ? conflictSet : (conflictSet?.groups ?? []);
  const entityIds = new Set(understanding.entities.map((entity) => entity.id));
  if (understanding.entities.length === 0) {
    // An overview request names no entity. It gets a counted summary, not every record: the layer
    // does not turn a whole-store read into prompt-sized prose.
    const active = [...state.entities.values()].filter((entity) => entity && entity.status === 'active');
    // A summary of zero records is not evidence. If it were emitted, the claim extractor would label it
    // directly supported and an empty store could read as a supported answer about the request.
    const empty = active.length === 0 && (state.facts?.size ?? 0) === 0
      && (state.relationships?.size ?? 0) === 0 && (state.events?.size ?? 0) === 0;
    if (empty) {
      setSource(sources, EvidenceSource.WORLD_ENTITY, SourceStatus.EMPTY, 0);
    } else {
      addEvidence(list, counters, {
        evidenceId: `ev:${EvidenceSource.WORLD_ENTITY}:overview`,
        source: EvidenceSource.WORLD_ENTITY,
        recordId: 'overview',
        type: 'entity-summary',
        subject: null,
        claim: `${active.length} active entity(s); ${state.facts?.size ?? 0} fact(s); ${state.relationships?.size ?? 0} relationship(s); ${state.events?.size ?? 0} event(s)`,
        observedAt: null,
        recordedAt: null,
        provenance: { origin: 'system', operationId: null, updateMode: null },
        status: 'derived',
        current: true,
        retrievalReason: 'world-overview',
      });
      setSource(sources, EvidenceSource.WORLD_ENTITY, SourceStatus.OK, 1);
    }
  }
  // An as-of question asks what was valid at that instant. The query layer evaluates statement
  // status at the same instant, so a fact that has since ended is still visible in the past view.
  const asOf = understanding.timeRange?.at ?? null;
  const queryConflicts = Array.isArray(conflictSet) ? { groups: conflictSet, contested: [], counts: {} } : (conflictSet ?? undefined);
  const queryOptions = asOf ? { asOf, at: asOf, conflicts: queryConflicts, limit: 8 } : { conflicts: queryConflicts, limit: 8 };
  let entityCount = 0;
  let factCount = 0;
  let relationshipCount = 0;
  let eventCount = 0;
  let factDamaged = false;

  for (const ref of understanding.entities) {
    const entity = state.entities.get(ref.id);
    if (!entity || entity.status !== 'active') continue;
    const entityEvidence = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.WORLD_ENTITY, entity.id),
      source: EvidenceSource.WORLD_ENTITY,
      recordId: entity.id,
      type: 'entity',
      subject: { entityId: entity.id, name: entity.name },
      claim: `${entity.category} entity ${entity.name}${(entity.aliases ?? []).length ? ` (aliases: ${(entity.aliases ?? []).slice(0, 4).join(', ')})` : ''}`,
      observedAt: entity.createdAt ?? null,
      recordedAt: entity.createdAt ?? null,
      provenance: provenanceOf(entity),
      status: entity.status,
      current: true,
      retrievalReason: `entity-${ref.matchedBy}`,
    });
    if (!entityEvidence) continue;
    entityCount += 1;

    let facts = { facts: [], problem: null };
    let relationships = { relationships: [], problem: null };
    let events = { events: [], problem: null };
    try {
      // Dynamic import is unnecessary: the query functions are pure and the controller already
      // imports them. They are imported at module load below.
      facts = worldQuery.factsFor(state, entity.id, queryOptions);
      relationships = worldQuery.relationshipsFor(state, entity.id, { ...queryOptions, limit: 6 });
      events = worldQuery.eventsFor(state, entity.id, { ...queryOptions, limit: 6 });
    } catch (err) {
      factDamaged = true;
      setSource(sources, EvidenceSource.WORLD_FACT, failureStatus(err), 0, err.message);
      continue;
    }
    if (facts.problem || relationships.problem || events.problem) {
      factDamaged = true;
      setSource(sources, EvidenceSource.WORLD_FACT, SourceStatus.DAMAGED, 0,
        facts.problem ?? relationships.problem ?? events.problem);
    }

    for (const fact of facts.facts ?? []) {
      if (!fact || !fact.id || fact.status === 'superseded' || fact.status === 'retracted') continue;
      // The query evaluated the fact at the as-of instant, but an as-of answer is still a statement
      // about a past period. A fact whose validity ended before the request time is historical even
      // though it was current at that instant, so it must not be reported as a current fact.
      const endedBeforeNow = fact.validUntil && Date.parse(fact.validUntil) < now.getTime();
      const factKind = endedBeforeNow ? ClaimKind.HISTORICAL : worldFactStatus(fact.status);
      const factAdded = addEvidence(list, counters, {
        evidenceId: evidenceId(EvidenceSource.WORLD_FACT, fact.id),
        source: EvidenceSource.WORLD_FACT,
        recordId: fact.id,
        type: 'fact',
        subject: { entityId: entity.id, name: entity.name },
        claim: `${entity.name}: ${factLabel(fact)} [${fact.status}; ${rangeLabel(fact)}]`,
        observedAt: fact.observedAt,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        recordedAt: fact.recordedAt,
        provenance: { ...provenanceOf(fact), evidenceRefs: evidenceRefs(fact.evidenceDetail) },
        status: factKind,
        current: factKind === ClaimKind.SUPPORTED || factKind === ClaimKind.CONTRADICTED,
        retrievalReason: asOf ? 'historical-validity' : 'entity-fact',
        contradicts: fact.status === 'contested' || fact.status === 'conflicting'
          ? (conflictsFor(state, entity.id, conflicts).flatMap((group) => group.memberIds ?? [])
            .map((id) => evidenceId(EvidenceSource.WORLD_FACT, id)))
          : [],
      });
      if (factAdded) factCount += 1;
    }

    for (const relationship of relationships.relationships ?? []) {
      if (!relationship || !relationship.id) continue;
      const counterpart = relationship.counterpartName ?? relationship.counterpartId;
      const direction = relationship.direction === 'incoming'
        ? `${relationship.label} from ${counterpart}`
        : `${relationship.label} to ${counterpart}`;
      const relationshipAdded = addEvidence(list, counters, {
        evidenceId: evidenceId(EvidenceSource.WORLD_RELATIONSHIP, relationship.id),
        source: EvidenceSource.WORLD_RELATIONSHIP,
        recordId: relationship.id,
        type: 'relationship',
        subject: { entityId: entity.id, name: entity.name },
        claim: `${entity.name}: ${direction} [${relationship.status}; ${rangeLabel(relationship)}]`,
        observedAt: relationship.observedAt,
        validFrom: relationship.validFrom,
        validUntil: relationship.validUntil,
        recordedAt: relationship.recordedAt,
        provenance: { ...provenanceOf(relationship), evidenceRefs: evidenceRefs(relationship.evidenceDetail) },
        status: worldFactStatus(relationship.status),
        current: relationship.status === 'supported' || relationship.status === 'contested' || relationship.status === 'conflicting',
        retrievalReason: asOf ? 'historical-validity' : 'entity-relationship',
      });
      if (relationshipAdded) relationshipCount += 1;
    }

    // Latest by occurrence, not by storage: a late-recorded past event stays old news.
    const rows = (events.events ?? []).slice(-4);
    for (const event of rows) {
      if (!event || !event.id) continue;
      const eventAdded = addEvidence(list, counters, {
        evidenceId: evidenceId(EvidenceSource.WORLD_EVENT, event.id),
        source: EvidenceSource.WORLD_EVENT,
        recordId: event.id,
        type: 'event',
        subject: { entityId: entity.id, name: entity.name },
        claim: `${event.eventType} occurred ${event.occurredAt ?? 'at an unknown time'}; learned ${event.observedAt ?? 'at an unknown time'}`,
        observedAt: event.observedAt,
        recordedAt: event.recordedAt,
        provenance: { ...provenanceOf(event), evidenceRefs: evidenceRefs(event.evidenceDetail) },
        status: event.status === 'unknown' ? ClaimKind.UNKNOWN : 'recorded',
        current: event.occurredAt !== null && event.occurredAt !== undefined,
        retrievalReason: 'entity-event',
      });
      if (eventAdded) eventCount += 1;
    }
  }
  if (understanding.entities.length > 0) {
    setSource(sources, EvidenceSource.WORLD_ENTITY, entityCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, entityCount);
    if (!factDamaged) setSource(sources, EvidenceSource.WORLD_FACT, factCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, factCount);
    setSource(sources, EvidenceSource.WORLD_RELATIONSHIP, relationshipCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, relationshipCount);
    setSource(sources, EvidenceSource.WORLD_EVENT, eventCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, eventCount);
  }

  // Conflicts are a separate evidence type so a disagreement survives even when one side did not
  // survive the per-source bound. Both sides are named; neither is chosen.
  let conflictCount = 0;
  for (const group of conflicts ?? []) {
    if (entityIds.size > 0 && !entityIds.has(group.subjectId)) continue;
    if (entityIds.size === 0) continue;
    const memberIds = (group.members ?? []).map((member) => member.id).filter(Boolean);
    const labels = (group.members ?? []).slice(0, 4).map((member) => member.value ?? member.id);
    const id = group.id ?? `${group.subjectId}:${group.predicate ?? group.kind}:${group.state}`;
    const added = addEvidence(list, counters, {
      evidenceId: `ev:${EvidenceSource.WORLD_CONFLICT}:${id}`,
      source: EvidenceSource.WORLD_CONFLICT,
      recordId: id,
      type: 'conflict',
      subject: { entityId: group.subjectId, name: group.subjectName ?? null },
      claim: `${group.predicate ?? group.kind} has ${memberIds.length} overlapping value(s) (${labels.join(', ')}); both sides are kept and unresolved${group.state === 'historical' ? ', not current' : ''}`,
      observedAt: null,
      recordedAt: null,
      status: ClaimKind.CONTRADICTED,
      current: group.state !== 'historical',
      retrievalReason: 'unresolved-conflict',
      memberIds,
      supports: memberIds.map((memberId) => evidenceId(EvidenceSource.WORLD_FACT, memberId)),
    });
    if (added) {
      conflictCount += 1;
      const entry = list.find((item) => item.evidenceId === added);
      if (entry) entry.relationships.supports = memberIds.map((memberId) => evidenceId(EvidenceSource.WORLD_FACT, memberId)).slice(0, 12);
    }
  }
  setSource(sources, EvidenceSource.WORLD_CONFLICT, conflictCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, conflictCount);
}

function conflictsFor(state, entityId, conflicts) {
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter((group) => group.subjectId === entityId).map((group) => ({
    ...group,
    memberIds: (group.members ?? []).map((member) => member.id).filter(Boolean),
  }));
}

function readMemory(hits, list, counters, sources) {
  if (!Array.isArray(hits)) {
    setSource(sources, EvidenceSource.MEMORY, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const hit of hits) {
    const record = hit?.record ?? hit;
    if (!record || typeof record.id !== 'string') continue;
    if (record.sensitivity === 'private') continue;
    // Memory has no retraction event; a replaced record is superseded, and the store leaves older
    // records in place rather than deleting them.
    const validity = record.status === 'superseded'
      ? EvidenceValidity.SUPERSEDED
      : record.status === 'historical'
        ? EvidenceValidity.HISTORICAL
        : EvidenceValidity.CURRENT;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.MEMORY, record.id),
      source: EvidenceSource.MEMORY,
      recordId: record.id,
      type: record.kind === 'model_conclusion' ? 'model_conclusion' : 'memory',
      subject: null,
      claim: record.content,
      observedAt: record.createdAt,
      recordedAt: record.createdAt,
      provenance: provenanceOf(record),
      status: record.status === 'superseded' ? ClaimKind.HISTORICAL : 'recorded',
      current: record.status !== 'superseded' && record.status !== 'historical',
      validity,
      retrievalReason: 'memory-search',
      contradicts: (hit?.conflict ?? record.conflict ?? []).map((id) => evidenceId(EvidenceSource.MEMORY, id)),
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.MEMORY, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readKnowledge(records, list, counters, sources) {
  if (!Array.isArray(records)) {
    setSource(sources, EvidenceSource.KNOWLEDGE, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const record of records) {
    const item = record?.record ?? record;
    if (!item || typeof item.id !== 'string') continue;
    const claim = `${item.subject} ${item.relationship} ${item.object}`;
    const conflictsWith = Array.isArray(item.conflictsWith) ? item.conflictsWith : [];
    const lifecycle = typeof item.lifecycleState === 'string' ? item.lifecycleState : null;
    const validity = lifecycle === 'retracted' ? EvidenceValidity.RETRACTED
      : lifecycle === 'superseded' ? EvidenceValidity.SUPERSEDED
        : lifecycle === 'historical' ? EvidenceValidity.HISTORICAL
          : lifecycle === 'ambiguous' ? EvidenceValidity.UNKNOWN
            : EvidenceValidity.CURRENT;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.KNOWLEDGE, item.id),
      source: EvidenceSource.KNOWLEDGE,
      recordId: item.id,
      type: 'knowledge',
      subject: null,
      claim,
      observedAt: item.createdAt,
      recordedAt: item.createdAt,
      provenance: provenanceOf(item),
      status: conflictsWith.length > 0 ? ClaimKind.CONTRADICTED : ClaimKind.SUPPORTED,
      current: lifecycle !== 'retracted' && lifecycle !== 'historical' && lifecycle !== 'superseded' && lifecycle !== 'ambiguous',
      validity,
      retrievalReason: 'knowledge-search',
      contradicts: conflictsWith.map((id) => evidenceId(EvidenceSource.KNOWLEDGE, id)),
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.KNOWLEDGE, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readPredictions(view, list, counters, sources) {
  if (!view) {
    setSource(sources, EvidenceSource.PREDICTION, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const item of view.active ?? []) {
    if (!item || !item.id) continue;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.PREDICTION, item.id),
      source: EvidenceSource.PREDICTION,
      recordId: item.id,
      type: 'expectation',
      subject: null,
      claim: `${item.capability}: ${item.expectation}`,
      observedAt: null,
      recordedAt: null,
      provenance: { origin: 'user', operationId: null, updateMode: null },
      status: ClaimKind.EXPECTATION,
      current: item.status !== 'expired' && item.status !== 'invalidated',
      retrievalReason: 'recorded-expectation',
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.PREDICTION, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readTemporal(summary, list, counters, sources) {
  if (!summary) {
    setSource(sources, EvidenceSource.TEMPORAL, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  const window = summary.window ?? {};
  const counts = summary.counts ?? {};
  const patterns = (summary.patterns ?? [])
    .filter((pattern) => ((pattern.supporting ?? 0) + (pattern.contradicting ?? 0)) > 0)
    .slice(0, 3);
  // Zero outcomes and no supported pattern is a summary of nothing. It is dropped only when nothing
  // else was retrieved either: with other records present the summary is a bounded statement about
  // the whole store, not a claim standing in for missing evidence.
  const nothingElseRetrieved = list.every((item) => item.source === EvidenceSource.USER_INSTRUCTION);
  if ((counts.events ?? 0) === 0 && patterns.length === 0 && nothingElseRetrieved) {
    setSource(sources, EvidenceSource.TEMPORAL, SourceStatus.EMPTY, 0);
    return;
  }
  const added = addEvidence(list, counters, {
    evidenceId: `ev:${EvidenceSource.TEMPORAL}:${window.since ?? 'window'}:${window.until ?? 'window'}`,
    source: EvidenceSource.TEMPORAL,
    recordId: `${window.since ?? 'window'}:${window.until ?? 'window'}`,
    type: 'temporal-summary',
    subject: null,
    claim: `${counts.events ?? 0} recorded outcome(s) in ${window.since ?? 'an unstated window'}..${window.until ?? 'now'}; ${counts.success ?? 0} success, ${counts.failure ?? 0} failure; ${counts.patterns ?? 0} pattern(s); a pattern describes recorded order, not cause`,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'system', operationId: null, updateMode: null },
    status: 'derived',
    current: true,
    retrievalReason: 'temporal-window',
  });
  if (added) count += 1;
  for (const pattern of patterns) {
    const id = `${pattern.kind}:${pattern.capability ?? 'all'}:${pattern.supporting}:${pattern.contradicting}`;
    const patternAdded = addEvidence(list, counters, {
      evidenceId: `ev:${EvidenceSource.TEMPORAL}:pattern:${id}`,
      source: EvidenceSource.TEMPORAL,
      recordId: id,
      type: 'temporal-pattern',
      subject: null,
      claim: `${pattern.kind} for ${pattern.capability ?? 'all capabilities'}: ${pattern.supporting} supporting, ${pattern.contradicting} contradicting, ${pattern.feedback ?? 0} feedback record(s); this is recorded order and not evidence that one event caused another`,
      observedAt: null,
      recordedAt: null,
      provenance: { origin: 'system', operationId: null, updateMode: null },
      status: ClaimKind.INFERENCE,
      current: true,
      retrievalReason: 'temporal-pattern',
    });
    if (patternAdded) count += 1;
  }
  setSource(sources, EvidenceSource.TEMPORAL, SourceStatus.OK, count);
}

function readExperience(records, list, counters, sources) {
  if (!Array.isArray(records)) {
    setSource(sources, EvidenceSource.EXPERIENCE, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.EXPERIENCE, record.id),
      source: EvidenceSource.EXPERIENCE,
      recordId: record.id,
      type: 'experience',
      subject: null,
      claim: `${record.subject} [outcome ${record.outcome}${record.capability ? `, capability ${record.capability}` : ''}]`,
      observedAt: record.finishedAt ?? record.requestedAt,
      recordedAt: record.createdAt,
      provenance: provenanceOf(record),
      status: record.outcome === 'success_verified' ? ClaimKind.OBSERVATION : 'recorded',
      current: record.active !== false && record.superseded !== true,
      validity: record.superseded === true
        ? EvidenceValidity.SUPERSEDED
        : (record.active === false ? EvidenceValidity.HISTORICAL : EvidenceValidity.CURRENT),
      retrievalReason: 'recent-outcome',
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.EXPERIENCE, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readFeedback(views, list, counters, sources) {
  if (!Array.isArray(views)) {
    setSource(sources, EvidenceSource.FEEDBACK, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const entry of views) {
    if (!entry || typeof entry.id !== 'string') continue;
    const guidance = entry.guidance ? `; guidance: ${entry.guidance}` : '';
    const reason = entry.reason ? `; reason: ${entry.reason}` : '';
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.FEEDBACK, entry.id),
      source: EvidenceSource.FEEDBACK,
      recordId: entry.id,
      type: 'feedback',
      subject: null,
      claim: `${entry.assessment}${guidance}${reason}`,
      observedAt: entry.createdAt,
      recordedAt: entry.createdAt,
      provenance: { origin: entry.provenance?.origin ?? 'user', operationId: entry.provenance?.operationId ?? null, updateMode: entry.provenance?.updateMode ?? null },
      status: 'user_assessment',
      current: true,
      retrievalReason: 'user-feedback',
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.FEEDBACK, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readAdaptations(seed, list, counters, sources) {
  const adaptations = Array.isArray(seed?.adaptations) ? seed.adaptations : (Array.isArray(seed) ? seed : []);
  let count = 0;
  for (const adaptation of adaptations) {
    if (!adaptation || typeof adaptation.id !== 'string' || adaptation.active !== true) continue;
    const support = Number.isInteger(adaptation.support?.experienceIds?.length)
      ? adaptation.support.experienceIds.length
      : 0;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.ADAPTATION, adaptation.id),
      source: EvidenceSource.ADAPTATION,
      recordId: adaptation.id,
      type: 'adaptation',
      subject: null,
      claim: `scope ${adaptation.capability}: "${adaptation.rule}" (approved behaviour rule, not a fact)`,
      observedAt: null,
      recordedAt: adaptation.createdAt ?? null,
      provenance: provenanceOf(adaptation),
      status: ClaimKind.RULE,
      current: true,
      retrievalReason: 'approved-rule',
      supports: (adaptation.support?.experienceIds ?? []).map((id) => evidenceId(EvidenceSource.EXPERIENCE, id)),
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.ADAPTATION, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function executiveRelevant(understanding, goal) {
  if (understanding.goals.some((ref) => ref.id === goal.id)) return true;
  if ([
    'goal_progress', 'goal_creation', 'planning', 'plan_review', 'next_step', 'task_execution',
  ].includes(understanding.intent)) return true;
  const entityIds = new Set(understanding.entities.map((entity) => entity.id));
  return (goal.entityIds ?? []).some((id) => entityIds.has(id));
}

function readExecutive(executive, understanding, list, counters, sources) {
  if (!executive) {
    setSource(sources, EvidenceSource.GOAL, SourceStatus.SKIPPED);
    setSource(sources, EvidenceSource.PLAN, SourceStatus.SKIPPED);
    setSource(sources, EvidenceSource.TASK, SourceStatus.SKIPPED);
    return;
  }
  const goals = Array.isArray(executive.goals) ? executive.goals : [];
  const plans = Array.isArray(executive.plans) ? executive.plans : [];
  const tasks = Array.isArray(executive.tasks) ? executive.tasks : [];
  let goalCount = 0;
  for (const goal of goals) {
    if (!goal || !goal.id || !executiveRelevant(understanding, goal)) continue;
    const progress = goal.progress ?? { satisfied: 0, contradicted: 0, pending: 0, total: 0 };
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.GOAL, goal.id),
      source: EvidenceSource.GOAL,
      recordId: goal.id,
      type: 'goal',
      subject: null,
      claim: `${goal.status} goal "${truncate(goal.request ?? '', 180)}" (priority ${goal.priority}); ${progress.satisfied} of ${progress.total} criterion(s) satisfied, ${progress.contradicted} contradicted${goal.blockedReason ? `; blocked: ${goal.blockedReason}` : ''}`,
      observedAt: goal.updatedAt ?? goal.createdAt,
      recordedAt: goal.createdAt,
      provenance: { origin: 'user', operationId: null, updateMode: null },
      status: ClaimKind.GOAL_STATE,
      current: ['proposed', 'accepted', 'active', 'blocked'].includes(goal.status),
      retrievalReason: 'executive-goal',
    });
    if (added) goalCount += 1;
  }
  let planCount = 0;
  for (const plan of plans) {
    if (!plan || !plan.id) continue;
    const linkedGoal = goals.find((goal) => goal.id === plan.goalId);
    if (!executiveRelevant(understanding, linkedGoal ?? { id: plan.goalId, entityIds: [] })
      && !understanding.plans.some((ref) => ref.id === plan.id)
      && !['planning', 'plan_review', 'next_step'].includes(understanding.intent)) continue;
    const progress = plan.progress ?? { completed: 0, failed: 0, pending: 0, total: 0 };
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.PLAN, plan.id),
      source: EvidenceSource.PLAN,
      recordId: plan.id,
      type: 'plan',
      subject: null,
      claim: `${plan.status} plan v${plan.version}${plan.goalId ? ` for goal ${plan.goalId}` : ''}: "${truncate(plan.outcome ?? '', 180)}"; ${progress.completed} of ${progress.total} step(s) completed, ${progress.failed} failed; risk ${plan.risk ?? 'not stated'}`,
      observedAt: plan.updatedAt ?? plan.createdAt,
      recordedAt: plan.createdAt,
      provenance: { origin: 'user', operationId: null, updateMode: null },
      status: ClaimKind.PLAN_STATE,
      current: ['draft', 'approved', 'active', 'blocked'].includes(plan.status),
      retrievalReason: 'executive-plan',
    });
    if (added) planCount += 1;
  }
  let taskCount = 0;
  for (const task of tasks) {
    if (!task || !task.id) continue;
    const relevant = understanding.tasks.some((ref) => ref.id === task.id)
      || ['next_step', 'task_execution', 'goal_progress'].includes(understanding.intent)
      || (task.goalId && understanding.goals.some((ref) => ref.id === task.goalId));
    if (!relevant) continue;
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const done = steps.filter((step) => step.status === 'completed').length;
    const unknown = steps.filter((step) => step.status === 'uncertain').length;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.TASK, task.id),
      source: EvidenceSource.TASK,
      recordId: task.id,
      type: 'task',
      subject: null,
      claim: `${task.status} task${task.planId ? ` for plan ${task.planId}` : ''}: "${truncate(task.goal ?? '', 180)}"; ${done} of ${steps.length} step(s) completed, ${unknown} uncertain`,
      observedAt: task.updatedAt ?? task.createdAt,
      recordedAt: task.createdAt,
      provenance: { origin: 'user', operationId: null, updateMode: null },
      status: ClaimKind.TASK_STATE,
      current: ['running', 'paused', 'awaiting_approval', 'planned'].includes(task.status),
      retrievalReason: 'executive-task',
    });
    if (added) taskCount += 1;
  }
  setSource(sources, EvidenceSource.GOAL, goalCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, goalCount);
  setSource(sources, EvidenceSource.PLAN, planCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, planCount);
  setSource(sources, EvidenceSource.TASK, taskCount > 0 ? SourceStatus.OK : SourceStatus.EMPTY, taskCount);
}

function readTurns(turns, list, counters, sources) {
  if (!Array.isArray(turns)) {
    setSource(sources, EvidenceSource.CONVERSATION, SourceStatus.SKIPPED);
    return;
  }
  let count = 0;
  for (const turn of turns.slice(-4)) {
    if (!turn || typeof turn.id !== 'string' || typeof turn.text !== 'string') continue;
    const added = addEvidence(list, counters, {
      evidenceId: evidenceId(EvidenceSource.CONVERSATION, turn.id),
      source: EvidenceSource.CONVERSATION,
      recordId: turn.id,
      type: 'conversation-turn',
      subject: null,
      claim: `${turn.origin ?? turn.role ?? 'turn'}: ${turn.text}`,
      observedAt: turn.at ?? turn.createdAt ?? null,
      recordedAt: turn.at ?? turn.createdAt ?? null,
      provenance: { origin: turn.role === 'user' ? 'user' : 'apex', operationId: null, updateMode: null },
      status: ClaimKind.STATEMENT,
      current: true,
      retrievalReason: 'recent-turn',
    });
    if (added) count += 1;
  }
  setSource(sources, EvidenceSource.CONVERSATION, count > 0 ? SourceStatus.OK : SourceStatus.EMPTY, count);
}

function readInstruction(request, list, counters, sources) {
  const added = addEvidence(list, counters, {
    evidenceId: `ev:${EvidenceSource.USER_INSTRUCTION}:request`,
    source: EvidenceSource.USER_INSTRUCTION,
    recordId: 'request',
    type: 'instruction',
    subject: null,
    claim: request,
    observedAt: null,
    recordedAt: null,
    provenance: { origin: 'user', operationId: null, updateMode: null },
    status: ClaimKind.STATEMENT,
    current: true,
    retrievalReason: 'user-request',
  });
  setSource(sources, EvidenceSource.USER_INSTRUCTION, added ? SourceStatus.OK : SourceStatus.EMPTY, added ? 1 : 0);
}

async function attempt(source, sources, fn) {
  try {
    const result = await fn();
    if (result && result.unavailable) {
      setSource(sources, source, result.damaged ? SourceStatus.DAMAGED : SourceStatus.UNAVAILABLE, 0, result.detail ?? null);
      return null;
    }
    return result;
  } catch (err) {
    setSource(sources, source, failureStatus(err), 0, err?.message ?? 'store error');
    return null;
  }
}

// What each source read actually covered. Retrieval is relevance-gated and bounded, so a source that
// contributed nothing is a window that selected nothing - never proof the store is empty. The only
// source that is complete is the user's own request. `window` is the snapshot verdict for the stores
// the seeds and reads came from, so a bundle assembled across a moving store is reported as such.
function retrievalRead(sources, { seeded = new Set(), window = null } = {}) {
  const reads = [];
  for (const entry of sources) {
    if (entry.status === SourceStatus.SKIPPED) continue;
    if (entry.source === EvidenceSource.USER_INSTRUCTION) {
      reads.push(sourceRead({ source: entry.source, returned: 1, total: 1 }));
      continue;
    }
    if (entry.status === SourceStatus.UNAVAILABLE) {
      reads.push(sourceRead({ source: entry.source, status: 'unavailable', reason: entry.detail ?? null }));
      continue;
    }
    if (entry.status === SourceStatus.DAMAGED) {
      reads.push(sourceRead({ source: entry.source, status: 'damaged', returned: entry.count, reason: entry.detail ?? null }));
      continue;
    }
    reads.push(sourceRead({
      source: entry.source,
      status: 'bounded',
      returned: entry.count,
      limit: BOUNDS.maxEvidencePerSource,
      reason: seeded.has(entry.source)
        ? 'the caller retrieved this source for the same request before the consistency window opened'
        : 'retrieval is bounded by relevance and the per-source evidence budget',
    }));
  }
  return readReport({ subject: 'cognition', reads, window });
}

function seededSources(seeds) {
  const names = new Set();
  const add = (...values) => { for (const value of values) names.add(value); };
  if (provided(seeds, 'memoryHits')) add(EvidenceSource.MEMORY);
  if (provided(seeds, 'knowledge')) add(EvidenceSource.KNOWLEDGE);
  if (provided(seeds, 'experience')) add(EvidenceSource.EXPERIENCE);
  if (provided(seeds, 'feedback')) add(EvidenceSource.FEEDBACK);
  if (provided(seeds, 'adaptations')) add(EvidenceSource.ADAPTATION);
  if (provided(seeds, 'temporal')) add(EvidenceSource.TEMPORAL);
  if (provided(seeds, 'predictions')) add(EvidenceSource.PREDICTION);
  if (provided(seeds, 'executive')) add(EvidenceSource.GOAL, EvidenceSource.PLAN, EvidenceSource.TASK);
  if (provided(seeds, 'worldState')) {
    add(
      EvidenceSource.WORLD_CONFLICT, EvidenceSource.WORLD_FACT, EvidenceSource.WORLD_RELATIONSHIP,
      EvidenceSource.WORLD_EVENT, EvidenceSource.WORLD_ENTITY,
    );
  }
  if (provided(seeds, 'turns')) add(EvidenceSource.CONVERSATION);
  return names;
}

export async function retrieveEvidence({
  request,
  understanding,
  now = new Date(),
  stores = {},
  seeds = {},
  worldConflicts = null,
  window = null,
} = {}) {
  const list = [];
  const counters = new Map();
  const sources = [
    EvidenceSource.USER_INSTRUCTION,
    EvidenceSource.WORLD_CONFLICT,
    EvidenceSource.WORLD_FACT,
    EvidenceSource.WORLD_RELATIONSHIP,
    EvidenceSource.WORLD_EVENT,
    EvidenceSource.WORLD_ENTITY,
    EvidenceSource.KNOWLEDGE,
    EvidenceSource.MEMORY,
    EvidenceSource.EXPERIENCE,
    EvidenceSource.FEEDBACK,
    EvidenceSource.ADAPTATION,
    EvidenceSource.GOAL,
    EvidenceSource.PLAN,
    EvidenceSource.TASK,
    EvidenceSource.TEMPORAL,
    EvidenceSource.PREDICTION,
    EvidenceSource.AUDIT,
    EvidenceSource.CONVERSATION,
  ].map(sourceEntry);
  setSource(sources, EvidenceSource.AUDIT, SourceStatus.SKIPPED);

  readInstruction(request, list, counters, sources);

  // Memory and knowledge arrive as seeds from the request path; a standalone caller may pass the
  // stores instead. Only one read happens either way.
  let memoryHits = provided(seeds, 'memoryHits') ? seeds.memoryHits : null;
  if (memoryHits === null && !provided(seeds, 'memoryHits') && stores.memory?.search) {
    memoryHits = await attempt(EvidenceSource.MEMORY, sources, () => stores.memory.search(request, { limit: BOUNDS.maxEvidencePerSource }));
  }
  // An unavailable source is not an empty one. The caller may have read the store, failed, and passed
  // the empty result it has; the declared failure outranks the empty seed.
  if (seeds.memoryUnavailable) setSource(sources, EvidenceSource.MEMORY, SourceStatus.UNAVAILABLE);
  else if (memoryHits !== null) readMemory(memoryHits, list, counters, sources);

  let knowledgeRecords = provided(seeds, 'knowledge') ? seeds.knowledge : null;
  if (knowledgeRecords === null && !provided(seeds, 'knowledge') && stores.knowledge?.search) {
    knowledgeRecords = await attempt(EvidenceSource.KNOWLEDGE, sources, () => stores.knowledge.search(request, { limit: BOUNDS.maxEvidencePerSource }));
  }
  if (seeds.knowledgeUnavailable) setSource(sources, EvidenceSource.KNOWLEDGE, SourceStatus.UNAVAILABLE);
  else if (knowledgeRecords !== null) readKnowledge(knowledgeRecords, list, counters, sources);

  const experienceRecords = provided(seeds, 'experience') ? seeds.experience : await attempt(EvidenceSource.EXPERIENCE, sources,
    () => (stores.experience?.list ? stores.experience.list({ limit: 5 }) : null));
  if (experienceRecords !== null) readExperience(experienceRecords, list, counters, sources);

  const feedbackViews = provided(seeds, 'feedback') ? seeds.feedback : await attempt(EvidenceSource.FEEDBACK, sources, async () => {
    if (!stores.experience?.feedbackFor || !Array.isArray(experienceRecords)) return null;
    const views = [];
    for (const record of experienceRecords.slice(0, 2)) {
      if (!record?.id) continue;
      const view = await stores.experience.feedbackFor(record.id, { limit: 2 });
      if (view) views.push(...(view.current ?? []));
    }
    return views;
  });
  if (feedbackViews !== null) readFeedback(feedbackViews, list, counters, sources);

  const adaptationSeed = provided(seeds, 'adaptations') ? seeds.adaptations : await attempt(EvidenceSource.ADAPTATION, sources,
    () => (stores.experience?.activeAdaptations ? stores.experience.activeAdaptations({ query: request, limit: 4 }) : null));
  if (seeds.adaptationsUnavailable) setSource(sources, EvidenceSource.ADAPTATION, SourceStatus.UNAVAILABLE);
  else if (adaptationSeed !== null) readAdaptations(adaptationSeed, list, counters, sources);

  const temporal = provided(seeds, 'temporal') ? seeds.temporal : await attempt(EvidenceSource.TEMPORAL, sources,
    () => (stores.experience?.temporalSummary ? stores.experience.temporalSummary() : null));
  if (temporal !== null) readTemporal(temporal, list, counters, sources);
  else if (seeds.temporalUnavailable) setSource(sources, EvidenceSource.TEMPORAL, SourceStatus.UNAVAILABLE);

  let predictions = provided(seeds, 'predictions') ? seeds.predictions : null;
  if (predictions === null && !provided(seeds, 'predictions') && stores.predictions?.promptView) {
    predictions = await attempt(EvidenceSource.PREDICTION, sources, () => stores.predictions.promptView({ limit: 4 }));
  }
  if (predictions !== null) readPredictions(predictions, list, counters, sources);
  else if (seeds.predictionsUnavailable) setSource(sources, EvidenceSource.PREDICTION, SourceStatus.UNAVAILABLE);

  let executive = provided(seeds, 'executive') ? seeds.executive : null;
  if (executive === null && !provided(seeds, 'executive') && (stores.goals || stores.plans || stores.tasks)) {
    executive = await attempt(EvidenceSource.GOAL, sources, async () => {
      const [goals, plans, tasks] = await Promise.all([
        stores.goals?.list ? stores.goals.list() : [],
        stores.plans?.list ? stores.plans.list() : [],
        stores.tasks?.list ? stores.tasks.list() : [],
      ]);
      return { goals: goals ?? [], plans: plans ?? [], tasks: tasks ?? [] };
    });
  }
  if (executive !== null) readExecutive(executive, understanding, list, counters, sources);
  else if (seeds.executiveUnavailable) {
    setSource(sources, EvidenceSource.GOAL, SourceStatus.UNAVAILABLE);
    setSource(sources, EvidenceSource.PLAN, SourceStatus.UNAVAILABLE);
    setSource(sources, EvidenceSource.TASK, SourceStatus.UNAVAILABLE);
  }

  const state = seeds.worldState ?? null;
  const conflictGroups = Array.isArray(worldConflicts) ? worldConflicts : (worldConflicts?.groups ?? []);
  if (state) readWorld(state, worldConflicts, understanding, request, list, counters, sources, now);
  else if (seeds.worldStateUnavailable) {
    setSource(sources, EvidenceSource.WORLD_ENTITY, SourceStatus.UNAVAILABLE);
  }

  readTurns(seeds.turns ?? null, list, counters, sources);
  setSource(sources, EvidenceSource.AUDIT, SourceStatus.SKIPPED);

  // Deterministic ordering: source rank, then record id, then evidence id. The total bound trims
  // the tail, and every trimmed source is reported as omitted rather than silently dropped.
  list.sort((a, b) => sourceRank(a.source) - sourceRank(b.source)
    || a.recordId.localeCompare(b.recordId)
    || a.evidenceId.localeCompare(b.evidenceId));
  const kept = list.slice(0, BOUNDS.maxEvidenceTotal);
  const totalDropped = list.length - kept.length;
  const perSourceDropped = counters.overflow ?? 0;
  const dropped = totalDropped + perSourceDropped;

  const omitted = sources
    .map((entry) => ({
      source: entry.source,
      count: kept.filter((item) => item.source === entry.source).length,
    }))
    .filter((entry) => entry.count === 0)
    .map((entry) => ({ ...entry, reason: 'no record selected' }));
  if (perSourceDropped > 0) {
    omitted.push({
      source: 'all',
      count: perSourceDropped,
      reason: `bounded to ${BOUNDS.maxEvidencePerSource} records per source`,
    });
  }

  const byId = new Map(kept.map((item) => [item.evidenceId, item]));
  const bySource = new Map();
  for (const item of kept) {
    const rows = bySource.get(item.source) ?? [];
    rows.push(item);
    bySource.set(item.source, rows);
  }
  if (totalDropped > 0) {
    omitted.push({ source: 'all', count: totalDropped, reason: `bounded to ${BOUNDS.maxEvidenceTotal} evidence records` });
  }
  const read = retrievalRead(sources, { seeded: seededSources(seeds), window });
  return {
    evidence: kept,
    byId,
    bySource,
    sources,
    conflicts: conflictGroups,
    omitted,
    read,
    counts: {
      total: kept.length,
      dropped,
      bySource: Object.fromEntries([...bySource.entries()].map(([source, rows]) => [source, rows.length])),
      unavailable: sources.filter((entry) => entry.status === SourceStatus.UNAVAILABLE).map((entry) => entry.source),
      damaged: sources.filter((entry) => entry.status === SourceStatus.DAMAGED).map((entry) => entry.source),
      readState: read.state,
      truncatedSources: read.truncatedSources,
      window: read.window,
    },
  };
}

// The uncertainty a source failure forces on an otherwise supported conclusion. It is about
// verifiability, not about the truth of the records that were read. A window that moved, or that
// could not be checked at all, makes the combined evidence describe no single instant, which is an
// unverifiable bundle even when every individual source read succeeded.
export function sourceUncertainty(retrieval) {
  if (!retrieval) return null;
  if (retrieval.read?.state === 'inconsistent' || retrieval.read?.state === 'unverifiable') return Uncertainty.UNVERIFIABLE;
  if ((retrieval.counts?.damaged ?? []).length > 0) return Uncertainty.UNVERIFIABLE;
  if ((retrieval.counts?.unavailable ?? []).length > 0) return Uncertainty.UNVERIFIABLE;
  return null;
}

// ---- late re-check ------------------------------------------------------------------------------
//
// The analysis runs before the model is asked; the final answer is written later. A record the
// analysis read can be corrected, retracted, or become unreadable in between. This reads the cited
// memory and knowledge records again, by id, and returns them in the same shape the retrieval
// coordinator uses, so reassessClaims can say which of a recorded claim's citations are no longer
// readable and current. It is read-only and bounded: it never writes, never widens the store read
// beyond the ids named, and an absent record is reported as missing, not as disproof.

const RECHECK_LIMIT = 128;

function recheckMemoryItem(record) {
  const validity = record.status === 'superseded'
    ? EvidenceValidity.SUPERSEDED
    : record.status === 'historical'
      ? EvidenceValidity.HISTORICAL
      : EvidenceValidity.CURRENT;
  const conflicts = Array.isArray(record.conflict) ? record.conflict : [];
  return {
    validity,
    current: record.status !== 'superseded' && record.status !== 'historical',
    status: record.status === 'superseded' ? ClaimKind.HISTORICAL : 'recorded',
    contradicts: conflicts.map((id) => evidenceId(EvidenceSource.MEMORY, id)),
  };
}

function recheckKnowledgeItem(item) {
  const lifecycle = typeof item.lifecycleState === 'string' ? item.lifecycleState : null;
  const validity = lifecycle === 'retracted' ? EvidenceValidity.RETRACTED
    : lifecycle === 'superseded' ? EvidenceValidity.SUPERSEDED
      : lifecycle === 'historical' ? EvidenceValidity.HISTORICAL
        : lifecycle === 'ambiguous' ? EvidenceValidity.UNKNOWN
          : EvidenceValidity.CURRENT;
  const conflicts = Array.isArray(item.conflictsWith) ? item.conflictsWith : [];
  return {
    validity,
    current: lifecycle !== 'retracted' && lifecycle !== 'historical'
      && lifecycle !== 'superseded' && lifecycle !== 'ambiguous',
    status: conflicts.length > 0 ? ClaimKind.CONTRADICTED : ClaimKind.SUPPORTED,
    contradicts: conflicts.map((id) => evidenceId(EvidenceSource.KNOWLEDGE, id)),
  };
}

async function readRechecked(store, entries) {
  if (typeof store?.getMany === 'function') return store.getMany(entries.map((entry) => entry.recordId));
  const found = new Map();
  for (const entry of entries) {
    const record = await store.get(entry.recordId);
    if (record) found.set(entry.recordId, record);
  }
  return found;
}

export async function recheckEvidence(ids, { memory = null, knowledge = null } = {}) {
  const wanted = { memory: [], knowledge: [] };
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const source = id.startsWith('ev:memory:') ? 'memory'
      : id.startsWith('ev:knowledge:') ? 'knowledge' : null;
    if (!source) continue;
    const recordId = id.slice(`ev:${source}:`.length);
    if (!recordId || wanted[source].length >= RECHECK_LIMIT) continue;
    seen.add(id);
    wanted[source].push({ id, recordId });
  }
  const byId = new Map();
  const sources = [];
  const unavailable = [];
  const rechecked = [];
  const stores = { memory, knowledge };
  const buildItem = { memory: recheckMemoryItem, knowledge: recheckKnowledgeItem };
  for (const source of ['memory', 'knowledge']) {
    const entries = wanted[source];
    if (entries.length === 0) continue;
    rechecked.push(source);
    const store = stores[source];
    if (!store || (typeof store.getMany !== 'function' && typeof store.get !== 'function')) {
      unavailable.push(source);
      sources.push({ source, status: SourceStatus.UNAVAILABLE });
      continue;
    }
    try {
      const records = await readRechecked(store, entries);
      for (const entry of entries) {
        const record = records.get(entry.recordId);
        if (record) byId.set(entry.id, buildItem[source](record));
      }
      sources.push({ source, status: SourceStatus.OK });
    } catch (err) {
      const status = failureStatus(err);
      unavailable.push(source);
      sources.push({ source, status });
    }
  }
  return { byId, sources, unavailable, rechecked };
}
