// Epistemic world-state projection. This is a read-only view of what APEX's stores
// currently hold: who asserted each belief, which claims conflict, which conflicts have
// a recorded user decision, and what is not established. It owns no state, writes
// nothing, calls no model, and never repairs or reinterprets a stored record.
//
// A belief here is a stored record, not a verified fact. The projection deliberately
// keeps model conclusions separate from user assertions and keeps history (superseded,
// retracted) out of the belief lists while still counting it.
import { findMemoryConflictGroups } from '../memory/memory-store.js';
import { readReport, sourceRead } from '../evidence/read-contract.js';
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
  'Derived at read time from stored records; nothing is persisted or repaired. A model answer built from stored context is sent a bounded, counts-only view of this projection, never a belief statement.',
  'A belief is a stored record, not verified truth. Provenance says who recorded it, not whether it is correct.',
  'At most 100 recent records per store are represented; older records are counted but not shown.',
  'Memory contradiction detection is heuristic: it compares "subject is value" clauses inside the represented records only, and memory has no user-decision mechanism.',
  'APEX represents no causal links and no hypotheses, and a belief that was never written to memory or knowledge is not represented here. A prediction is represented, when a ledger is available, only as the user\'s own recorded expectation about a later outcome - in its own section, never as a belief and never as an observation.',
  'When an experience store is available, a bounded temporal section reports recorded outcomes and their order. Order is not cause, nothing in it is a prediction, and no pattern is or becomes an adaptation.',
]);

export const MAX_WORLD_TEMPORAL_PATTERNS = 3;
export const MAX_WORLD_PREDICTION_ITEMS = 3;

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
  // The projection's own store reads, in the shared bounded-read vocabulary. "truncated" names the
  // bound that cut the read, so the reader can tell a complete survey from the most recent records.
  if (world.read) {
    const parts = [world.read.state];
    if ((world.read.truncatedSources ?? []).length > 0) {
      parts.push(`truncated at ${WORLD_RECORD_LIMIT} recent records: ${world.read.truncatedSources.join(', ')}`);
    }
    if ((world.read.damagedSources ?? []).length > 0) {
      parts.push(`damaged: ${world.read.damagedSources.join(', ')}`);
    }
    if (world.read.window !== 'unverified') {
      parts.push(`window ${world.read.window}${world.read.certification ? ` (${world.read.certification})` : ''}`);
    }
    lines.push(`  Store read:     ${parts.join('; ')}`);
  }
  lines.push(`  Beliefs:        ${world.counts.userAsserted} user-asserted, ${world.counts.unverifiedModel} unverified model conclusion(s), ${world.counts.private} private`);
  lines.push(`  Contradictions: ${world.counts.unresolvedConflicts} unresolved knowledge group(s), ${world.counts.resolvedConflicts} with a recorded user decision, ${world.counts.memoryConflictGroups} memory subject group(s) carrying different values`);
  lines.push(`  History:        ${world.history.superseded} superseded, ${world.history.retracted} retracted, ${world.history.resolutions} resolution(s) (history or decisions, not beliefs)`);

  // The temporal section is present only when a caller supplied one, so a projection built from
  // memory and knowledge alone has exactly the shape it had before. It reports counts, capability
  // names, and pattern kinds - never a subject, feedback text, or the stored wording of a record.
  if (world.temporal) {
    const t = world.temporal;
    if (t.available === false) {
      lines.push(`  Temporal:       unavailable (${safeText(t.detail ?? 'the experience store could not be read', 120)}); recorded outcomes are not represented`);
    } else {
      const window = t.window ?? {};
      const counts = t.counts ?? {};
      lines.push(`  Temporal:       ${safeCount(counts.events) ?? 0} recorded event(s) from ${String(window.since ?? '').slice(0, 10)} to ${String(window.until ?? '').slice(0, 10)}: ${safeCount(counts.success) ?? 0} success, ${safeCount(counts.failure) ?? 0} failure; ${safeCount(counts.automatic) ?? 0} captured automatically, ${safeCount(counts.explicit) ?? 0} recorded by you; ${safeCount(counts.patterns) ?? 0} pattern(s) met their threshold`);
      if ((t.capabilities ?? []).length > 0) {
        const capabilities = t.capabilities.slice(0, 3)
          .map((group) => `${group.capability} ${group.total} (${group.trend}${group.outcomeChanged ? ', outcome changed' : ''})`);
        lines.push(`  Temporal caps:  ${capabilities.join('; ')}${t.capabilitiesTruncated ? '; further groups counted but not listed' : ''}`);
      }
      if ((t.patterns ?? []).length > 0) {
        const patterns = t.patterns.slice(0, MAX_WORLD_TEMPORAL_PATTERNS)
          .map((pattern) => `${pattern.kind}${pattern.capability ? ` in ${pattern.capability}` : ''} (${pattern.supporting} supporting, ${pattern.contradicting} contradicting, ${pattern.excluded ?? 0} excluded${pattern.feedback ? `, ${pattern.feedback} feedback` : ''})`);
        lines.push(`  Temporal order: ${patterns.join('; ')}${t.patternsTruncated ? '; more patterns exist' : ''}`);
      }
      if ((counts.undated ?? 0) > 0 || (counts.superseded ?? 0) > 0) {
        const gaps = [];
        if ((counts.superseded ?? 0) > 0) gaps.push(`${counts.superseded} corrected by a later record and excluded from patterns`);
        if ((counts.undated ?? 0) > 0) gaps.push(`${counts.undated} with no usable timestamp and not placed in the window`);
        lines.push(`  Temporal gaps:  ${gaps.join('; ')}`);
      }
      lines.push('  Temporal limit: recorded order is not cause; nothing here is a prediction, and no pattern becomes an adaptation');
    }
  }

  // Expectations get their own section and their own label, one deliberately unlike "Beliefs". A
  // belief here is a stored record of something the user or a model asserted; an expectation is the
  // user's own record of what they think will happen later. The counts come from the prediction
  // ledger's published prompt shape, so this says nothing about a prediction that the ledger's own
  // reader would not say, and no subject or reason text appears here at all.
  if (world.predictions) {
    const p = world.predictions;
    if (p.available === false) {
      lines.push(`  Expectations:   unavailable (${safeText(p.detail ?? 'the prediction ledger could not be read', 120)}); recorded expectations are not represented`);
    } else {
      const c = p.counts ?? {};
      const n = (value) => (Number.isInteger(value) ? value : 0);
      lines.push(`  Expectations:   ${n(c.live)} standing expectation(s) of ${n(c.evaluated) + n(c.recorded) + n(c.awaiting_evaluation) + n(c.expired)} recorded: ${n(c.recorded)} with nothing establishing them, ${n(c.awaiting_evaluation)} whose outcome evidence exists but no verdict was recorded, ${n(c.expired)} past their horizon with no outcome evidence, ${n(c.evaluated)} with a recorded verdict; ${n(c.invalidated)} withdrawn, ${n(c.superseded)} superseded`);
      lines.push(`  Expectation verdicts: ${n(c.matched)} matched, ${n(c.contradicted)} contradicted${p.matchRate?.value === null ? `; no rate stated (${safeText(p.matchRate?.reason ?? 'no evaluation exists', 100)})` : `; ${p.matchRate.value} over ${n(p.matchRate.denominator)} evaluation(s)`}; confidence is unavailable for every record`);
      const items = (p.active ?? []).slice(0, MAX_WORLD_PREDICTION_ITEMS)
        .map((item) => `[${shortId(item.id)}] ${item.capability} expects ${item.expectation} (${item.status}, horizon ${String(item.expiresAt ?? '').slice(0, 10)}, evidence at creation ${item.evidenceBasis ?? 'unknown'})`);
      if (items.length > 0) {
        lines.push(`  Expectations standing: ${items.join('; ')}${p.omitted > 0 ? `; ${p.omitted} more in the ledger, readable with "prediction list"` : ''}`);
      }
      lines.push('  Expectation limit: an expectation is what the user recorded about a later outcome, not an observation and not a belief; it authorizes nothing, and a horizon that passed without outcome evidence establishes nothing in either direction');
    }
  }

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

// One store's contribution to the projection, expressed in the shared bounded-read vocabulary. The
// distinction the projection previously lost is between "read the whole store" and "read the most
// recent 100 records": both produced a believable-looking window, so a projection cut short by the
// record limit still called itself complete. The store's own health says what it holds; the records
// this read actually received say what was represented.
function projectionSourceRead(name, { health, total, returned, limit }) {
  if (health.inspected !== true) {
    return sourceRead({
      source: name,
      status: 'unavailable',
      reason: health.detail ?? `the ${name} store could not be inspected`,
    });
  }
  if ((health.corruptLines ?? 0) > 0) {
    return sourceRead({
      source: name,
      status: 'damaged',
      returned,
      reason: `${health.corruptLines} line(s) in the ${name} store could not be parsed, so no record from it is represented`,
    });
  }
  const known = safeCount(total);
  if (known !== null && known > returned) {
    return sourceRead({
      source: name,
      status: 'truncated',
      returned,
      total: known,
      limit,
      stoppedAt: 'WORLD_RECORD_LIMIT',
    });
  }
  return sourceRead({
    source: name,
    status: returned === 0 ? 'empty' : 'ok',
    returned,
    total: known ?? returned,
  });
}

export async function buildWorldState({
  memory,
  knowledge,
  now = () => new Date(),
  limit = MAX_WORLD_BELIEFS,
  recordLimit = WORLD_RECORD_LIMIT,
  temporal = null,
  predictions = null,
  window = null,
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

  // The projection's own two store reads, described once and shared by `complete`, the rendered
  // summary, and any caller that already holds a certified window. A store the caller could not
  // inspect is `unavailable`, never an empty store; one the record limit cut short is `truncated`
  // and names the bound, so a 100-record prefix cannot pass as the whole history.
  const read = readReport({
    subject: 'world-state',
    window,
    reads: [
      projectionSourceRead('memory', {
        health: memoryHealth,
        total: memoryHealth.records,
        returned: memoryRecords.length,
        limit: windowLimit,
      }),
      projectionSourceRead('knowledge', {
        health: knowledgeHealth,
        total: knowledgeHealth.claims,
        returned: claimRecords.length,
        limit: windowLimit,
      }),
    ],
  });

  // Only live records are beliefs. A superseded or retracted record is history: it is
  // counted, shown by its own store's history command, and never presented as current.
  const activeMemory = memoryRecords.filter((record) => (record.replacedBy ?? []).length === 0 && record.status !== 'superseded');
  const activeClaims = claimRecords.filter((claim) => claim.active === true);

  const memoryBeliefs = activeMemory.map(memoryBelief);
  // Document-derived candidates are deliberately not user beliefs. They remain visible through the
  // document/knowledge read surfaces and can participate in a conflict, but the epistemic projection
  // never counts them as something the user asserted.
  const knowledgeBeliefs = activeClaims
    .filter((claim) => claim.provenance?.origin !== 'source_extracted')
    .map(knowledgeBelief);
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
  if (temporal && temporal.available === false) {
    addUnknown(`The experience store could not be read, so recorded outcomes and their order could not be inspected${temporal.detail ? ` (${safeText(temporal.detail, 100)})` : ''}.`);
  } else if (temporal && (temporal.counts?.undated ?? 0) > 0) {
    addUnknown(`${temporal.counts.undated} recorded experience(s) have no usable timestamp and are not placed in the temporal window.`);
  }
  // An unreadable ledger is an explicit unknown, not an empty expectations section: "the user
  // recorded no expectation" and "this could not be checked" must not sound the same here.
  if (predictions && predictions.available === false) {
    addUnknown(`The prediction ledger could not be read, so the user's recorded expectations could not be inspected${predictions.detail ? ` (${safeText(predictions.detail, 100)})` : ''}.`);
  }

  // Completeness means every part of the projection covered what it claims to cover. A bounded
  // record window and a caller-supplied section that could not be read both make the projection
  // partial, and a partial projection says so instead of reporting a complete view of a subset.
  const temporalComplete = !temporal || temporal.available !== false;
  const predictionsComplete = !predictions || predictions.available !== false;
  const complete = read.complete && temporalComplete && predictionsComplete;
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
    read,
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
    ...(temporal ? { temporal } : {}),
    // Expectations, kept in their own field and never merged into `beliefs`: a reader must be able to
    // tell what the stores say happened from what the user said they expect to happen.
    ...(predictions ? { predictions } : {}),
    limits: [...LIMITS],
  };
}

// A caller that reads the projection inside a consistency window only learns the verdict after every
// contributing read finished, which is after this projection was built. Re-deriving the report from
// the per-source reads already recorded applies that verdict without re-reading a store: an
// inconsistent or uninspectable window overrides each source read, and a projection that was complete
// becomes partial, never the other way around.
export function certifyWorldRead(world, window) {
  if (!world || !world.read || !Array.isArray(world.read.reads) || !window) return world;
  const reads = world.read.reads.map((read) => ({ ...read, state: read.sourceState ?? read.state }));
  const read = readReport({ subject: world.read.subject ?? 'world-state', reads, window });
  const complete = world.complete === true && read.complete;
  return {
    ...world,
    read,
    complete,
    attention: world.attention === true || !complete,
  };
}
