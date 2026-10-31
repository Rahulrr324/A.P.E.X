// Epistemic world-state projection. This is a read-only view of what APEX's stores
// currently hold: who asserted each belief, which claims conflict, which conflicts have
// a recorded user decision, and what is not established. It owns no state, writes
// nothing, calls no model, and never repairs or reinterprets a stored record.
//
// A belief here is a stored record, not a verified fact. The projection deliberately
// keeps model conclusions separate from user assertions and keeps history (superseded,
// retracted) out of the belief lists while still counting it.
import { findMemoryConflictGroups } from '../memory/memory-store.js';
import { shortId, truncate } from '../util.js';

export const WORLD_SCHEMA = 1;
export const MAX_WORLD_BELIEFS = 20;
export const MAX_WORLD_CONFLICTS = 5;
export const MAX_WORLD_CONFLICT_MEMBERS = 8;
export const MAX_WORLD_UNKNOWNS = 8;
export const WORLD_RECORD_LIMIT = 100;
export const MAX_WORLD_STATEMENT_CHARS = 240;
export const MAX_WORLD_EVIDENCE_CHARS = 160;
export const MAX_WORLD_LIMIT = 50;

const LIMITS = Object.freeze([
  'Derived at read time from stored records; nothing is persisted, repaired, or sent to a model.',
  'A belief is a stored record, not verified truth. Provenance says who recorded it, not whether it is correct.',
  'At most 100 recent records per store are represented; older records are counted but not shown.',
  'Memory contradiction detection is heuristic: it compares "subject is value" clauses inside the represented records only, and memory has no user-decision mechanism.',
  'APEX does not represent events, time intervals, causal links, or beliefs that were never written to memory or knowledge.',
]);

function safeText(value, max) {
  return truncate(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' '), max);
}

function memoryBelief(record) {
  const updateMode = record.provenance?.updateMode ?? (record.source === 'model' ? 'model_proposed' : 'user_confirmed');
  return {
    id: record.id,
    store: 'memory',
    epistemic: record.source === 'model' ? 'unverified_model' : 'user_asserted',
    statement: safeText(record.content, MAX_WORLD_STATEMENT_CHARS),
    evidence: null,
    private: record.sensitivity === 'private',
    recordedAt: record.createdAt ?? null,
    provenance: {
      origin: record.provenance?.origin ?? null,
      operationId: record.provenance?.operationId ?? null,
      backend: record.provenance?.backend ?? null,
      updateMode,
    },
  };
}

function knowledgeBelief(claim) {
  const updateMode = claim.provenance?.updateMode ?? 'user_confirmed';
  return {
    id: claim.id,
    store: 'knowledge',
    epistemic: updateMode === 'model_proposed' ? 'unverified_model' : 'user_asserted',
    statement: safeText(`${claim.subject} — ${claim.relationship} → ${claim.object}`, MAX_WORLD_STATEMENT_CHARS),
    evidence: typeof claim.evidence === 'string' && claim.evidence.length > 0
      ? safeText(claim.evidence, MAX_WORLD_EVIDENCE_CHARS)
      : null,
    private: false,
    recordedAt: claim.createdAt ?? null,
    provenance: {
      origin: claim.provenance?.origin ?? null,
      operationId: claim.provenance?.operationId ?? null,
      updateMode,
    },
    conflictState: claim.conflictState ?? null,
    conflictsWith: Array.isArray(claim.conflictsWith) ? claim.conflictsWith : [],
    resolution: claim.resolution ?? null,
  };
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function renderWorldState(world) {
  const lines = ['World state (read-only; derived from stored records; nothing is repaired)'];
  const sourceLine = (name, source) => {
    if (!source || source.inspected !== true) {
      return `${name}: unavailable${source?.detail ? ` (${safeText(source.detail, 120)})` : ''}`;
    }
    const damaged = source.corruptLines > 0;
    return `${name}: ${damaged ? `damaged - ${source.corruptLines} corrupt line(s); incomplete` : `ok - ${safeCount(source.records)} readable`}`;
  };
  lines.push(`  Sources:        ${sourceLine('memory', world.sources.memory)} | ${sourceLine('knowledge', world.sources.knowledge)}`);
  lines.push(`  Beliefs:        ${world.counts.userAsserted} user-asserted, ${world.counts.unverifiedModel} unverified model conclusion(s), ${world.counts.private} private`);
  lines.push(`  Contradictions: ${world.counts.unresolvedConflicts} unresolved knowledge group(s), ${world.counts.resolvedConflicts} with a recorded user decision, ${world.counts.memoryConflictGroups} memory subject group(s) carrying different values`);
  lines.push(`  History:        ${world.history.superseded} superseded, ${world.history.retracted} retracted, ${world.history.resolutions} resolution(s) (history or decisions, not beliefs)`);

  const section = (title, items) => {
    if (!items.length) {
      lines.push(`  ${title}: (none)`);
      return;
    }
    lines.push(`  ${title}:`);
    for (const belief of items) {
      const marker = belief.private ? ' [private: never sent to a model]' : '';
      const provenance = belief.provenance.origin ? `; origin ${belief.provenance.origin}` : '';
      const evidence = belief.evidence ? `; evidence: "${belief.evidence}"` : '';
      lines.push(`    [${shortId(belief.id)}] ${belief.store}: ${belief.statement}${marker}${provenance}${evidence}`);
    }
  };
  section('User-asserted beliefs', world.beliefs.userAsserted);
  section('Unverified model conclusions', world.beliefs.unverifiedModel);

  if (world.contradictions.length === 0) {
    lines.push('  Conflicts:      (none represented)');
  } else {
    lines.push('  Conflicts:');
    for (const group of world.contradictions) {
      const shown = group.claimIds.slice(0, MAX_WORLD_CONFLICT_MEMBERS).map(shortId);
      const more = group.claimIds.length - shown.length;
      const ids = `${shown.join(', ')}${more > 0 ? ` (+${more} more record(s) in this group)` : ''}`;
      if (group.state === 'resolved') {
        lines.push(`    - ${group.kind} (user decision chose [${shortId(group.chosenId)}]; a decision, not verified truth): claims ${ids}${group.reason ? `; reason recorded` : ''}`);
      } else {
        lines.push(`    - ${group.kind} (unresolved): claims ${ids}${group.note ? `; ${group.note}` : ''}`);
      }
      if (group.truncated) lines.push('      (some conflicting claims are outside the 100-record projection window)');
    }
  }

  if (world.unknowns.length === 0) {
    lines.push('  Unknowns:       (none detected within the projection)');
  } else {
    lines.push('  Unknowns:');
    for (const unknown of world.unknowns) lines.push(`    - ${unknown.detail}`);
  }

  lines.push(`  Projection:     ${world.beliefs.shown} of ${world.beliefs.total} represented belief(s) shown; ${world.contradictions.length} of ${world.counts.unresolvedConflicts + world.counts.resolvedConflicts + world.counts.memoryConflictGroups} contradiction(s) shown`);
  lines.push(`  Limits:         ${world.limits[0]}`);
  for (const limit of world.limits.slice(1)) lines.push(`                  ${limit}`);
  return lines.join('\n');
}

export async function buildWorldState({
  memory,
  knowledge,
  now = () => new Date(),
  limit = MAX_WORLD_BELIEFS,
  recordLimit = WORLD_RECORD_LIMIT,
} = {}) {
  if (!memory || !knowledge) throw new Error('world state requires both stores');
  const beliefLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_WORLD_LIMIT) : MAX_WORLD_BELIEFS;
  const windowLimit = Number.isInteger(recordLimit) ? Math.min(Math.max(recordLimit, 1), WORLD_RECORD_LIMIT) : WORLD_RECORD_LIMIT;

  // One authoritative read per store. The integrity summary and the bounded record window
  // come from the same snapshot of the same file, so a projection can never combine a
  // summary of one file state with records read from another.
  const memoryRead = await memory.projectionRead({ limit: windowLimit, includePrivate: true });
  const knowledgeRead = await knowledge.projectionRead({ limit: windowLimit });
  const memoryHealth = memoryRead.health;
  const knowledgeHealth = knowledgeRead.health;
  const memoryRecords = memoryRead.records ?? [];
  const claimRecords = knowledgeRead.claims ?? [];
  // A store that could not be read at all, or that has damage, contributes no beliefs; the
  // distinction between the two is carried by the health summary and reported as an unknown.
  const memoryContentAvailable = memoryRead.records !== null;
  const knowledgeContentAvailable = knowledgeRead.claims !== null;

  // Only live records are beliefs. A superseded or retracted record is history: it is
  // counted, shown by its own store's history command, and never presented as current.
  const activeMemory = memoryRecords.filter((record) => (record.replacedBy ?? []).length === 0 && record.status !== 'superseded');
  const activeClaims = claimRecords.filter((claim) => claim.active === true);

  const memoryBeliefs = activeMemory.map(memoryBelief);
  const knowledgeBeliefs = activeClaims.map(knowledgeBelief);
  const allBeliefs = [...memoryBeliefs, ...knowledgeBeliefs]
    .sort((a, b) => {
      if (a.epistemic !== b.epistemic) return a.epistemic === 'user_asserted' ? -1 : 1;
      return String(b.recordedAt ?? '').localeCompare(String(a.recordedAt ?? ''));
    });
  const shownBeliefs = allBeliefs.slice(0, beliefLimit);

  // Knowledge conflict groups, rebuilt from the authoritative `conflictsWith` list so a
  // group is not split by projection order. A group whose members are not all inside the
  // window is marked truncated rather than described as complete.
  const byId = new Map(activeClaims.map((claim) => [claim.id, claim]));
  const groups = new Map();
  for (const claim of activeClaims) {
    if (claim.conflictState !== 'unresolved' && claim.conflictState !== 'resolved') continue;
    const ids = [claim.id, ...(claim.conflictsWith ?? [])].sort();
    const key = ids.join(',');
    if (groups.has(key)) continue;
    groups.set(key, {
      kind: 'knowledge',
      state: claim.conflictState,
      claimIds: ids,
      chosenId: claim.conflictState === 'resolved' ? (claim.resolution?.chosenId ?? null) : null,
      reason: claim.conflictState === 'resolved' ? (claim.resolution?.reason ?? null) : null,
      truncated: ids.some((id) => !byId.has(id)),
      claims: ids.map((id) => byId.get(id)).filter(Boolean).map((record) => ({
        id: record.id,
        statement: safeText(`${record.subject} — ${record.relationship} → ${record.object}`, MAX_WORLD_STATEMENT_CHARS),
      })),
    });
  }
  const knowledgeGroups = [...groups.values()]
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'unresolved' ? -1 : 1));

  // Memory contradictions are heuristic subject groups, not store-level conflict records.
  // One contested subject is one entry: listing every record pair would describe the same
  // disagreement many times over and cost quadratic time to render.
  const memoryGroups = findMemoryConflictGroups(activeMemory).map((group) => {
    const claimIds = group.records.map((record) => record.id).sort();
    return {
      kind: 'memory',
      state: 'unresolved',
      subject: safeText(group.subject, 80),
      claimIds,
      chosenId: null,
      reason: null,
      truncated: false,
      valueCount: group.values.length,
      note: `heuristic clause match on "${safeText(group.subject, 60)}"; ${group.values.length} distinct value(s); memory has no user-decision mechanism`,
      claims: claimIds.slice(0, MAX_WORLD_CONFLICT_MEMBERS).map((id) => ({
        id,
        statement: safeText(group.records.find((record) => record.id === id).content, MAX_WORLD_STATEMENT_CHARS),
      })),
    };
  });

  const contradictions = [...knowledgeGroups, ...memoryGroups].slice(0, MAX_WORLD_CONFLICTS);
  const unresolvedKnowledge = knowledgeGroups.filter((group) => group.state === 'unresolved').length;
  const resolvedKnowledge = knowledgeGroups.filter((group) => group.state === 'resolved').length;
  const totalUnresolved = safeCount(knowledgeHealth.conflicts?.groups) ?? unresolvedKnowledge;
  const totalResolved = safeCount(knowledgeHealth.conflicts?.resolvedGroups) ?? resolvedKnowledge;

  const userAsserted = allBeliefs.filter((belief) => belief.epistemic === 'user_asserted').length;
  const unverifiedModel = allBeliefs.filter((belief) => belief.epistemic === 'unverified_model').length;
  const privateCount = allBeliefs.filter((belief) => belief.private).length;

  const sources = {
    memory: {
      inspected: memoryHealth.inspected === true,
      corruptLines: memoryHealth.corruptLines,
      records: memoryHealth.records,
      detail: memoryHealth.detail ?? null,
      contentAvailable: memoryContentAvailable,
    },
    knowledge: {
      inspected: knowledgeHealth.inspected === true,
      corruptLines: knowledgeHealth.corruptLines,
      records: knowledgeHealth.claims,
      detail: knowledgeHealth.detail ?? null,
      contentAvailable: knowledgeContentAvailable,
    },
  };

  const unknowns = [];
  const addUnknown = (detail) => {
    if (unknowns.length < MAX_WORLD_UNKNOWNS) unknowns.push({ detail });
  };
  if (totalUnresolved > 0) {
    addUnknown(`${totalUnresolved} knowledge conflict group(s) have no user decision; choose one explicitly with "knowledge resolve".`);
  }
  if (memoryGroups.length > 0) {
    addUnknown(`${memoryGroups.length} memory subject group(s) in the projection carry different values for the same claim; this detection is heuristic and memory has no user-decision mechanism.`);
  }
  const withoutEvidence = knowledgeBeliefs.filter((belief) => belief.evidence === null).length;
  if (withoutEvidence > 0) {
    addUnknown(`${withoutEvidence} represented knowledge claim(s) have no recorded evidence; their support is unknown.`);
  }
  if (unverifiedModel > 0) {
    addUnknown(`${unverifiedModel} model conclusion(s) are stored but unverified; they are not treated as established facts.`);
  }
  if (memoryHealth.inspected !== true) {
    addUnknown(`The memory store is unavailable, so memory beliefs and conflicts could not be inspected${memoryHealth.detail ? ` (${safeText(memoryHealth.detail, 100)})` : ''}.`);
  } else if (memoryHealth.corruptLines > 0) {
    addUnknown(`The memory store has ${memoryHealth.corruptLines} corrupt line(s); memory inspection is incomplete.`);
  }
  if (knowledgeHealth.inspected !== true) {
    addUnknown(`The knowledge store is unavailable, so claims and conflicts could not be inspected${knowledgeHealth.detail ? ` (${safeText(knowledgeHealth.detail, 100)})` : ''}.`);
  } else if (knowledgeHealth.corruptLines > 0) {
    addUnknown(`The knowledge store has ${knowledgeHealth.corruptLines} corrupt line(s); claim inspection is incomplete.`);
  }
  if (safeCount(memoryHealth.records) > windowLimit || safeCount(knowledgeHealth.claims) > windowLimit) {
    addUnknown(`Only the most recent ${windowLimit} records per store are represented; older records are counted but not shown.`);
  }
  if (allBeliefs.length > shownBeliefs.length) {
    addUnknown(`${allBeliefs.length - shownBeliefs.length} represented belief(s) are not shown because the projection is bounded to ${beliefLimit}.`);
  }

  const memoryComplete = memoryHealth.inspected === true && memoryHealth.corruptLines === 0;
  const knowledgeComplete = knowledgeHealth.inspected === true && knowledgeHealth.corruptLines === 0;
  const complete = memoryComplete && knowledgeComplete;
  const attention = !complete || totalUnresolved > 0 || memoryGroups.length > 0;
  const history = {
    superseded: safeCount(knowledgeHealth.superseded) ?? 0,
    retracted: safeCount(knowledgeHealth.retracted) ?? 0,
    ambiguous: safeCount(knowledgeHealth.ambiguous) ?? 0,
    retractions: safeCount(knowledgeHealth.retractions) ?? 0,
    resolutions: safeCount(knowledgeHealth.resolutions) ?? 0,
  };

  return {
    schema: WORLD_SCHEMA,
    generatedAt: now().toISOString(),
    complete,
    attention,
    sources,
    counts: {
      representedBeliefs: allBeliefs.length,
      userAsserted,
      unverifiedModel,
      private: privateCount,
      unresolvedConflicts: totalUnresolved,
      resolvedConflicts: totalResolved,
      memoryConflictGroups: memoryGroups.length,
    },
    beliefs: {
      shown: shownBeliefs.length,
      total: allBeliefs.length,
      userAsserted: shownBeliefs.filter((belief) => belief.epistemic === 'user_asserted'),
      unverifiedModel: shownBeliefs.filter((belief) => belief.epistemic === 'unverified_model'),
    },
    contradictions,
    unknowns,
    history,
    limits: [...LIMITS],
  };
}
