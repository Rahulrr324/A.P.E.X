// Memory and knowledge in the cross-store reconstruction: what each store had recorded by a cutoff,
// what the lifecycle implied then, and what later records changed. Both stores answer a cutoff from
// the same kind of field - `createdAt`, the time the record was appended - and neither has an event
// time or a valid interval, so the cutoff rule is the same one the record model already supports.
//
// The two stores differ in what a lifecycle even is, and the sections keep that difference visible:
//
//   memory     an append-only record with no retraction event. A correction is a later record that
//              names the claim it replaces, so supersession is derived from those names and conflict
//              groups are the store's read-time heuristic clause rule. A claim later corrected was
//              still the belief recorded at an earlier cutoff. Private records never enter this
//              view, because the reconstruction may be run by the model origin.
//   knowledge  claims plus two append-only lifecycle events (retraction, resolution). Filtering the
//              record set before deriving means a later retraction, supersession, or resolution is
//              absent from the earlier view instead of applied backwards. A recorded resolution is a
//              user decision at that time, not proof the chosen claim is true.
//
// Nothing here merges the past derivation with the present one. A later change is reported beside the
// historical row as a separate statement, and the row's own state is what the store implied at the
// cutoff.
import { singleLine } from '../util.js';

const MAX_CONFLICT_SAMPLES = 5;

function compareNewestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function countStatuses(records) {
  const counts = {};
  for (const record of records) counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

function memoryRow(record) {
  return {
    id: record.id,
    kind: record.kind,
    source: record.source,
    sensitivity: record.sensitivity ?? 'normal',
    content: record.content,
    createdAt: record.createdAt,
    provenance: {
      origin: record.provenance?.origin ?? null,
      operationId: record.provenance?.operationId ?? null,
      updateMode: record.provenance?.updateMode ?? null,
      replaces: [...(record.provenance?.replaces ?? [])],
    },
    status: record.status,
    replacedBy: [...record.replacedBy],
    conflict: record.conflict === null ? null : {
      subject: record.conflict.subject,
      values: [...record.conflict.values],
      recordIds: [...record.conflict.recordIds],
    },
    later: { ...record.later },
    now: record.now === null ? null : { ...record.now },
  };
}

function knowledgeRow(claim) {
  return {
    id: claim.id,
    subject: claim.subject,
    relationship: claim.relationship,
    object: claim.object,
    evidence: claim.evidence,
    createdAt: claim.createdAt,
    status: claim.status,
    lifecycleState: claim.lifecycleState,
    active: claim.active,
    conflictsWith: [...claim.conflictsWith],
    conflictState: claim.conflictState,
    resolution: claim.resolution === null ? null : { ...claim.resolution },
    replaces: [...claim.replaces],
    replacedBy: [...claim.replacedBy],
    retraction: claim.retraction === null ? null : { ...claim.retraction },
    retractionAmbiguous: claim.retractionAmbiguous,
    provenance: { ...claim.provenance },
    later: { ...claim.later },
    now: claim.now === null ? null : { ...claim.now },
  };
}

export function memorySection(view, source, cutoff, limit) {
  if (!view) {
    return {
      available: false,
      status: source.status,
      reason: source.detail ?? 'the memory store was not read at this cutoff',
      cutoff,
      records: null,
      excluded: null,
      undated: null,
      privateExcluded: null,
      counts: null,
      problemCount: null,
      problems: [],
      rows: [],
      total: 0,
      truncated: false,
      current: null,
      note: null,
    };
  }
  const ordered = [...view.memories].sort(compareNewestFirst);
  const shown = ordered.slice(0, limit);
  return {
    available: true,
    status: source.status,
    reason: source.detail,
    cutoff,
    records: view.records,
    excluded: view.excluded,
    undated: view.undated,
    privateExcluded: view.privateExcluded,
    counts: {
      memories: view.memories.length,
      corrections: view.corrections,
      superseded: view.superseded,
      conflictGroups: view.conflictGroups,
      byStatus: countStatuses(view.memories),
    },
    problemCount: view.problems.length,
    problems: [...view.problems],
    rows: shown.map(memoryRow),
    total: ordered.length,
    truncated: ordered.length > shown.length,
    current: view.current,
    note: view.note,
  };
}

export function knowledgeSection(view, source, cutoff, limit) {
  if (!view) {
    return {
      available: false,
      status: source.status,
      reason: source.detail ?? 'the knowledge store was not read at this cutoff',
      cutoff,
      records: null,
      excluded: null,
      undated: null,
      counts: null,
      problemCount: null,
      problems: [],
      rows: [],
      total: 0,
      truncated: false,
      current: null,
      note: null,
    };
  }
  const ordered = [...view.statements].sort(compareNewestFirst);
  const shown = ordered.slice(0, limit);
  return {
    available: true,
    status: source.status,
    reason: source.detail,
    cutoff,
    records: view.records,
    excluded: view.excluded,
    undated: view.undated,
    counts: {
      claims: view.claimsRecorded,
      retractions: view.retractionEvents,
      resolutions: view.resolutionEvents,
      active: view.statements.filter((claim) => claim.active).length,
      byLifecycleState: { ...view.byLifecycleState },
      conflicts: { ...view.conflicts },
      conflictSamples: [...view.statements]
        .filter((claim) => claim.conflictState === 'unresolved')
        .slice(0, MAX_CONFLICT_SAMPLES)
        .map((claim) => claim.id),
    },
    problemCount: view.problems.length,
    problems: [...view.problems],
    rows: shown.map(knowledgeRow),
    total: ordered.length,
    truncated: ordered.length > shown.length,
    current: view.current,
    note: view.note,
  };
}

// The two cutoff rules stated where a reader of the combined answer can find them, beside the ones the
// executive module contributes. They are descriptions of the record models, not permissions.
export const MEMORY_KNOWLEDGE_CUTOFF_SEMANTICS = Object.freeze({
  memory: 'memory records carry only `createdAt`, the time the record was appended; a correction is a later record naming the one it replaces, so an earlier claim stays the belief recorded at an earlier cutoff, and there is no event time, valid interval, or retraction event to apply',
  knowledge: 'knowledge claims and their retraction and resolution events carry only `createdAt`; the lifecycle at a cutoff is derived from the records appended at or before it, so a later retraction, supersession, or resolution cannot apply to an earlier view',
});

export const MEMORY_KNOWLEDGE_LIMITATIONS = Object.freeze([
  'memory has no event time, valid interval, or retraction event: a record is retired only by a later correction that names it, so a claim later found wrong is still shown as the belief recorded at the earlier cutoff',
  'memory conflict groups are derived at read time from a heuristic subject/value clause rule; the store records no conflict event, so a historical disagreement is a statement about stored content, not a recorded lifecycle event',
  'memory records marked private are excluded from this reconstruction and only their count is disclosed, because the reconstruction may be produced for a model-origin request and private memory must never reach a model',
  'knowledge `evidence` is stored free text, not a record reference: it cannot be resolved to a record or shown to have existed at the cutoff; the only structured citation is `provenance.operationId`, which the operation-citation section resolves against the audit log',
  'a knowledge resolution recorded by the cutoff is shown as a recorded user decision at that time and never as proof the chosen claim is true; a resolution recorded later is disclosed as later and is not applied to the past',
  'knowledge supersession is a link stored on the successor claim; a successor recorded after the cutoff is absent from the earlier view, so the earlier claim is not retroactively replaced',
  'the memory and knowledge listings replay the whole log to derive their lifecycle; the output is bounded, the read cost is not, and no persistent index was added for historical queries',
]);
