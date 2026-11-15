// Cross-source digest over memory and knowledge. This answers one question - what does
// APEX hold about this topic, and what of it still stands - from the two stores that hold
// what the owner told it, without a model in the path.
//
// The stores stay separate. A memory record and a knowledge claim are not merged, ranked
// against each other, or linked: no store records an identity or a relationship between
// them, so the digest cannot report one. It reports each store's own health summary, the
// current records (or the query matches), and the stored lifecycle links that mark a
// record as corrected, superseded, retracted, or in conflict.
//
// A listing is not proof. Every note the digest adds says so, because "APEX holds X" and
// "X is true" are different claims and the first must never be shown as the second.
import { shortId, truncate } from '../util.js';

export const DIGEST_DEFAULT_LIMIT = 5;
export const DIGEST_MAX_LIMIT = 10;

const NOTE_STORED_NOT_TRUE = 'A stored record is what APEX holds; it is not proof that the claim is true in the world.';
const NOTE_SEPARATE_SOURCES = 'Memory and knowledge are reported separately; the digest does not merge them or infer a relationship between them.';
const NOTE_DAMAGED = 'An unreadable or damaged store is reported as such, never as empty; its counts cover readable records only.';
const NOTE_SEARCH = 'Search matches are ranked by term overlap against the whole readable store. A missing match means no record matched the query terms; it does not mean the claim is false.';

function knowledgeCounts(health) {
  return {
    claims: health.claims ?? null,
    active: health.active ?? null,
    superseded: health.superseded ?? null,
    retracted: health.retracted ?? null,
    ambiguous: health.ambiguous ?? null,
    conflicts: health.conflicts
      ? {
          groups: health.conflicts.groups ?? null,
          claims: health.conflicts.claims ?? null,
          resolvedGroups: health.conflicts.resolvedGroups ?? null,
        }
      : null,
    corruptLines: health.corruptLines ?? null,
  };
}

function memoryCounts(health) {
  return {
    records: health.records ?? null,
    privateRecords: health.privateRecords ?? null,
    corrections: health.corrections ?? null,
    replacedClaims: health.replacedClaims ?? null,
    kinds: health.kinds ?? null,
    sources: health.sources ?? null,
    updateModes: health.updateModes ?? null,
    corruptLines: health.corruptLines ?? null,
  };
}

function knowledgeStatus(record) {
  if (record.lifecycleState === 'ambiguous') return 'ambiguous';
  if (record.lifecycleState === 'retracted') return 'retracted';
  if (record.active === false || (record.supersededBy ?? []).length > 0) return 'superseded';
  if ((record.conflictsWith ?? []).length > 0) return 'conflicting';
  return 'active';
}

// Only what a reader needs to judge the record and find it again: the claim, its evidence,
// its provenance, and the lifecycle links the store itself recorded. Nothing is summarised
// or paraphrased, so no field here can drift from the stored text.
function knowledgeCitation(record) {
  return {
    id: record.id,
    shortId: shortId(record.id),
    subject: record.subject,
    relationship: record.relationship,
    object: record.object,
    evidence: record.evidence ?? null,
    status: knowledgeStatus(record),
    lifecycleState: record.lifecycleState ?? null,
    conflictsWith: (record.conflictsWith ?? []).map((id) => shortId(id)),
    supersededBy: (record.supersededBy ?? []).map((id) => shortId(id)),
    retractedAt: record.retraction?.createdAt ?? null,
    createdAt: record.createdAt,
    origin: record.provenance?.origin ?? null,
    operationId: record.provenance?.operationId ?? null,
  };
}

// The memory store's status names the update mode of a normal record (`user_confirmed`), which
// the digest would otherwise show as if it were a lifecycle warning. Only a record that is
// superseded, in conflict, or model-proposed gets a tag; everything else is current.
function memoryStatus(status) {
  if (status === undefined || status === null || status === 'stored' || status === 'user_confirmed') return 'active';
  if (status === 'unresolved_conflict') return 'conflicting';
  return status;
}

// `search()` returns a ranked hit that carries the record plus its derived lifecycle, while a
// projection window returns the record with `status`/`replacedBy` already attached. Both are
// accepted here so the citation comes from whichever shape the store handed back.
function memoryCitation(hit) {
  const record = hit.record ?? hit;
  const lifecycle = hit.record ? hit : record;
  const replaces = lifecycle.replaces ?? record.replaces ?? record.provenance?.replaces ?? [];
  const replacedBy = lifecycle.replacedBy ?? record.replacedBy ?? [];
  const conflict = lifecycle.conflict ?? lifecycle.conflictsWith ?? record.conflict ?? [];
  return {
    id: record.id,
    shortId: shortId(record.id),
    content: record.content,
    kind: record.kind,
    source: record.source,
    status: memoryStatus(lifecycle.status ?? record.status),
    replaces: replaces.map((id) => shortId(id)),
    replacedBy: replacedBy.map((id) => shortId(id)),
    conflictsWith: Array.isArray(conflict) ? conflict.map((id) => shortId(id)) : [],
    createdAt: record.createdAt,
    updateMode: record.provenance?.updateMode ?? null,
  };
}

// The store's own diagnostic profile, bounded to the fixed keys both search functions fill in.
function searchProfile(query, diagnostics, limit, error = null) {
  return {
    query,
    terms: diagnostics.terms ?? [],
    droppedTokens: diagnostics.droppedTokens ?? 0,
    totalTokens: diagnostics.totalTokens ?? 0,
    unmatched: diagnostics.unmatched ?? [],
    corpusSize: diagnostics.corpusSize ?? 0,
    matched: diagnostics.matched ?? 0,
    returned: diagnostics.returned ?? 0,
    limit,
    truncated: (diagnostics.matched ?? 0) > (diagnostics.returned ?? 0),
    error,
  };
}

async function readKnowledge({ knowledge, query, limit }) {
  const projection = await knowledge.projectionRead({ limit });
  const health = projection.health;
  const section = {
    state: health.state,
    inspected: health.inspected === true,
    complete: health.complete === true,
    counts: knowledgeCounts(health),
    attention: health.attention === true,
    records: null,
    search: null,
  };
  // A damaged store yields no certified record window; the digest says counts are partial
  // and does not present a listing as if it were the whole store.
  if (projection.claims) section.records = projection.claims.map(knowledgeCitation);
  if (query === null) return section;

  const diagnostics = {};
  try {
    const hits = await knowledge.search(query, { limit, diagnostics });
    section.search = searchProfile(query, diagnostics, limit);
    section.search.results = hits.map((hit) => ({ ...knowledgeCitation(hit.record), score: hit.score }));
  } catch (err) {
    // Search refuses a damaged store instead of returning a partial answer. The health
    // section already says why; this records that no match list could be produced.
    section.search = searchProfile(query, diagnostics, limit, err?.message ?? String(err));
    section.search.results = [];
  }
  return section;
}

async function readMemory({ memory, query, limit, includePrivate }) {
  const projection = await memory.projectionRead({ limit, includePrivate });
  const health = projection.health;
  const section = {
    state: health.state,
    inspected: health.inspected === true,
    complete: health.complete === true,
    counts: memoryCounts(health),
    attention: health.attention === true,
    records: null,
    search: null,
  };
  if (projection.records) section.records = projection.records.map(memoryCitation);
  if (query === null) return section;

  const diagnostics = {};
  try {
    const hits = await memory.search(query, { limit, includePrivate, diagnostics });
    section.search = searchProfile(query, diagnostics, limit);
    section.search.results = hits.map((hit) => ({ ...memoryCitation(hit), score: hit.score }));
  } catch (err) {
    section.search = searchProfile(query, diagnostics, limit, err?.message ?? String(err));
    section.search.results = [];
  }
  return section;
}

function digestNotes({ topic, knowledge, memory }) {
  const notes = [NOTE_STORED_NOT_TRUE, NOTE_SEPARATE_SOURCES];
  if (knowledge.inspected === false || memory.inspected === false
    || knowledge.state === 'damaged' || memory.state === 'damaged') notes.push(NOTE_DAMAGED);
  if (knowledge.counts.conflicts?.groups > 0) {
    notes.push(`${knowledge.counts.conflicts.groups} knowledge conflict group(s) are unresolved; a conflict needs an explicit user decision and is not settled by listing it.`);
  }
  const outdated = (knowledge.counts.superseded ?? 0) + (knowledge.counts.retracted ?? 0) + (knowledge.counts.ambiguous ?? 0);
  if (outdated > 0) {
    notes.push(`Knowledge history holds ${knowledge.counts.superseded} superseded, ${knowledge.counts.retracted} retracted, and ${knowledge.counts.ambiguous} ambiguous claim(s); they are not current.`);
  }
  if ((memory.counts.corrections ?? 0) > 0) {
    notes.push(`Memory holds ${memory.counts.corrections} correction(s); a corrected record is shown as replaced, not current.`);
  }
  if (topic !== null) notes.push(NOTE_SEARCH);
  return notes;
}

function evidenceLine(value) {
  return value ? `; evidence: ${truncate(value, 160)}` : '';
}

function renderKnowledgeCitation(record) {
  const lifecycle = record.status === 'active' ? '' : ` [${record.status}]`;
  const links = [
    record.conflictsWith.length > 0 ? `conflicts: ${record.conflictsWith.join(', ')}` : '',
    record.supersededBy.length > 0 ? `superseded by: ${record.supersededBy.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `  [${record.shortId}] ${truncate(record.subject, 60)} --[${truncate(record.relationship, 40)}]--> ${truncate(record.object, 60)}${lifecycle}${evidenceLine(record.evidence)}\n      recorded ${String(record.createdAt).slice(0, 10)}; origin ${record.origin ?? 'unknown'}${links ? `; ${links}` : ''}`;
}

function renderMemoryCitation(record) {
  const lifecycle = record.status === 'active' ? '' : ` [${record.status}]`;
  const links = [
    record.replaces.length > 0 ? `replaces: ${record.replaces.join(', ')}` : '',
    record.conflictsWith.length > 0 ? `conflicts: ${record.conflictsWith.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `  [${record.shortId}] ${truncate(record.content, 100)}${lifecycle}\n      ${record.kind} from ${record.source}; recorded ${String(record.createdAt).slice(0, 10)}${links ? `; ${links}` : ''}`;
}

function renderSection(label, section, renderCitation) {
  const lines = [];
  if (!section.inspected) {
    lines.push(`${label}: unavailable - the store could not be inspected`);
    return lines;
  }
  if (section.search) {
    const s = section.search;
    if (s.error) {
      lines.push(`${label} matches: unavailable - ${truncate(s.error, 160)}`);
    } else if (s.terms.length === 0) {
      lines.push(`${label} matches: the query held no searchable term`);
    } else {
      const unmatched = s.unmatched.length > 0 ? `; no record holds: ${s.unmatched.join(', ')}` : '';
      lines.push(`${label} matches: ${s.returned} returned of ${s.matched} matched (corpus ${s.corpusSize}, limit ${s.limit}${unmatched})`);
    }
    lines.push(...(section.search.results ?? []).map(renderCitation));
    const history = section.records?.length
      ? `\n${label} newest stored records (including history):\n${section.records.map(renderCitation).join('\n')}`
      : '';
    if (history) lines.push(history);
    return lines;
  }
  if (section.records === null) {
    lines.push(`${label} newest stored records: unavailable - the store is damaged, so no listing is certified`);
    return lines;
  }
  lines.push(`${label} newest stored records:\n${section.records.length > 0 ? section.records.map(renderCitation).join('\n') : '  (none stored)'}`);
  return lines;
}

export function renderDigest(data) {
  const k = data.knowledge;
  const m = data.memory;
  const topicLine = data.topic === null ? '' : ` for "${data.topic}"`;
  const lines = [`Knowledge digest${topicLine} (read-only; records as stored)`];
  const kCounts = k.counts;
  lines.push(k.inspected
    ? `  knowledge: ${k.state} - ${kCounts.claims} claim(s): ${kCounts.active} active, ${kCounts.superseded} superseded, ${kCounts.retracted} retracted, ${kCounts.ambiguous} ambiguous; ${kCounts.conflicts?.groups ?? 0} unresolved conflict group(s)`
    : '  knowledge: unavailable');
  const mCounts = m.counts;
  lines.push(m.inspected
    ? `  memory:    ${m.state} - ${mCounts.records} record(s): ${mCounts.corrections} correction(s), ${mCounts.privateRecords} private${data.includePrivate ? ' (included)' : ' (excluded)'}`
    : '  memory:    unavailable');
  lines.push('');
  lines.push(...renderSection('Knowledge', k, renderKnowledgeCitation));
  lines.push('');
  lines.push(...renderSection('Memory', m, renderMemoryCitation));
  lines.push('');
  lines.push('Notes:');
  for (const note of data.notes) lines.push(`  - ${note}`);
  return lines.join('\n');
}

// The single entry point. It reads each store once for its health summary and, when a topic
// is given, once more for a ranked search; nothing is written, repaired, or inferred. The two
// sections are built independently so one unreadable store still leaves the other readable.
export async function buildKnowledgeDigest({
  memory,
  knowledge,
  query = null,
  limit = DIGEST_DEFAULT_LIMIT,
  includePrivate = true,
}) {
  const topic = typeof query === 'string' && query.trim() !== '' ? query.trim() : null;
  const bound = Math.max(1, Math.min(DIGEST_MAX_LIMIT, Number.isInteger(limit) ? limit : DIGEST_DEFAULT_LIMIT));
  const [knowledgeSection, memorySection] = await Promise.all([
    readKnowledge({ knowledge, query: topic, limit: bound }),
    readMemory({ memory, query: topic, limit: bound, includePrivate }),
  ]);
  return {
    topic,
    limit: bound,
    includePrivate,
    knowledge: knowledgeSection,
    memory: memorySection,
    notes: digestNotes({ topic, knowledge: knowledgeSection, memory: memorySection }),
  };
}