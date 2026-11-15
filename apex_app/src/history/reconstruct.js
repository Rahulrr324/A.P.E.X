// Cross-store cognitive history: one read-only reconstruction of what APEX had recorded by a cutoff,
// across the stores that can honestly answer it.
//
// Three stores are integrated, and each keeps its own record model and lifecycle vocabulary:
//
//   experience   what happened, the user's feedback on it, and the review/adaptation records derived
//                from it. The store replays only records stored at or before the cutoff and derives
//                its lifecycle from that replay, so a feedback, correction, or review written later
//                cannot retire, supersede, or support anything in the past view.
//   predictions  what was expected, and whether a recorded evaluation, withdrawal, or replacement
//                existed by then. A verdict recorded after the cutoff is absent from the past ledger
//                and appears only in the current one, beside the past reading.
//   world        what was asserted as fact, relationship, or event. AP-15's replay supplies the state
//                at the cutoff; this module summarizes it and reports what changed later.
//
// Everything else is disclosed as unsupported rather than approximated. The goal, plan, and task logs
// carry a recorded `.at` on every event but have no cutoff read, and the operations audit log has no
// recorded-time field at all - it is appended when an operation completes, so its `requestedAt` cannot
// prove a record existed at that instant. Memory and knowledge expose id-based as-of reads, not a
// bounded as-of listing. Naming that boundary is part of the answer, not an omission from it.
//
// What this is not: a transaction, a claim of objective historical truth, or an authorization. Each
// store's read is internally consistent and the snapshot certifies that no contributing file changed
// between the start and end of the operation, which makes the combination describe one quiescent
// window. It says nothing about whether the records are true, and nothing here writes or authorizes.
//
// A record that exists now but not at the cutoff is reported as `recorded_later` and is never used as
// evidence for the past. The historical and current views are separate outputs throughout; this module
// has no code path that merges them into one lifecycle.
import { StoreError, ValidationError } from '../errors.js';
import { parseIsoInstant, singleLine } from '../util.js';
import { contributingStores, runConsistentEvidenceRead } from '../evidence/snapshot.js';
import { outcomeClass, parseInstant } from '../experience/temporal.js';
import { occurredAtOf } from '../experience/experience-store.js';

export const COGNITIVE_HISTORY_SCHEMA = 'apex.cognitive-history.v1';
export const MAX_HISTORY_ROWS = 50;
export const MAX_HISTORY_CITATIONS = 40;
export const DEFAULT_HISTORY_ROWS = 20;
export const HISTORY_RULE = 'a cutoff replays only records stored at or before it; recorded time is not event time, and a record dated after the cutoff is disclosed as later rather than used to settle the past';

const SOURCE_NAMES = Object.freeze(['experience', 'predictions', 'world']);
const MAX_LATER_CHANGES = 10;

export const UNSUPPORTED_SOURCES = Object.freeze([
  {
    source: 'goals',
    status: 'unsupported',
    reason: 'the goal log records a `.at` on every event and has a pure reducer, but no cutoff read exists yet; replaying it here would be a second, independent temporal implementation rather than reuse of a tested contract',
  },
  {
    source: 'plans',
    status: 'unsupported',
    reason: 'the plan log records a `.at` on every event and has a pure reducer, but no cutoff read exists yet; a plan status at a cutoff needs the same replay contract as the goal log, which this milestone did not add',
  },
  {
    source: 'tasks',
    status: 'unsupported',
    reason: 'the task log records a `.at` on every event and has a pure reducer, but no cutoff read exists yet; a task record also carries no single completion instant that a cutoff could be judged against',
  },
  {
    source: 'operations',
    status: 'unsupported',
    reason: 'the operations audit log carries requestedAt and finishedAt but no recorded-at field, and a line is appended only when the operation completes; a cutoff judged on requestedAt would claim a record existed before it was written',
  },
  {
    source: 'memory',
    status: 'unsupported',
    reason: 'as-of reads are by record id (memory traceMany), not a bounded listing of every record stored by a cutoff; enumerating memory at a cutoff would need a read this milestone did not add',
  },
  {
    source: 'knowledge',
    status: 'unsupported',
    reason: 'as-of reads are by record id (knowledge getMany), not a bounded listing of every statement stored by a cutoff; the cross-store belief trace already covers a named record at a cutoff',
  },
]);

function messageOf(err) {
  return err?.message ?? String(err);
}

function rowLimit(value) {
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_HISTORY_ROWS) : DEFAULT_HISTORY_ROWS;
}

function instantOf(record) {
  const occurred = occurredAtOf(record);
  return occurred.ms === null ? null : new Date(occurred.ms).toISOString();
}

function eventMs(record) {
  return occurredAtOf(record).ms ?? parseInstant(record.createdAt) ?? 0;
}

// Newest first, with the file's own order only as a last resort. Code-point and instant comparisons
// only, so two machines sort the same records the same way.
function compareNewestFirst(a, b) {
  const am = eventMs(a);
  const bm = eventMs(b);
  if (am !== bm) return bm - am;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function experienceRow(record, currentById) {
  const occurred = occurredAtOf(record);
  const now = currentById.get(record.id) ?? null;
  const replacedNow = now?.replacedBy ?? [];
  return {
    id: record.id,
    createdAt: record.createdAt,
    occurredAt: occurred.ms === null ? null : new Date(occurred.ms).toISOString(),
    timeSource: occurred.source,
    capability: record.capability ?? null,
    outcome: record.outcome ?? null,
    outcomeClass: outcomeClass(record.outcome),
    capture: record.capture ?? 'unknown',
    active: record.active === true,
    superseded: record.superseded === true,
    replaces: [...(record.replaces ?? [])],
    replacedBy: [...(record.replacedBy ?? [])],
    feedback: {
      total: record.feedbackTotal ?? 0,
      current: record.feedbackCount ?? 0,
      corrected: record.feedbackCorrected ?? 0,
      assessments: [...(record.assessments ?? [])],
      latestAt: record.latestFeedback?.createdAt ?? null,
      latestAssessment: record.latestFeedback?.assessment ?? null,
    },
    correctedLater: replacedNow.some((id) => !(record.replacedBy ?? []).includes(id)),
    feedbackAddedLater: now !== null && (now.feedbackTotal ?? 0) > (record.feedbackTotal ?? 0),
    now: now === null ? null : {
      active: now.active === true,
      superseded: now.superseded === true,
      feedbackTotal: now.feedbackTotal ?? 0,
      latestAssessment: now.latestFeedback?.assessment ?? null,
    },
  };
}

function predictionRow(projection, current) {
  const now = current ?? null;
  return {
    id: projection.id,
    createdAt: projection.createdAt,
    capability: projection.capability,
    expectation: projection.expectation,
    subject: projection.subject,
    expiresAt: projection.expiresAt,
    status: projection.status,
    statusReason: projection.statusReason,
    decision: projection.evaluationDecision,
    decisionReason: projection.evaluationReason,
    verdict: projection.evaluation?.verdict ?? null,
    evaluationAt: projection.evaluation?.createdAt ?? null,
    invalidation: projection.invalidation === null ? null : {
      id: projection.invalidation.id,
      createdAt: projection.invalidation.createdAt,
      reason: projection.invalidation.reason,
    },
    deciding: projection.deciding === null ? null : {
      id: projection.deciding.id,
      occurredAt: projection.deciding.occurredAt,
      outcome: projection.deciding.outcome,
      outcomeClass: projection.deciding.outcomeClass,
    },
    counts: projection.counts,
    evidenceAvailable: projection.evaluationDecision !== 'evidence_unavailable',
    evaluationRecordedLater: now !== null && projection.evaluation === null && now.evaluation !== null,
    invalidatedLater: now !== null && projection.invalidation === null && now.invalidation !== null,
    supersededLater: now !== null && (now.supersededBy ?? []).some((id) => !(projection.supersededBy ?? []).includes(id)),
    now: now === null ? null : {
      status: now.status,
      decision: now.evaluationDecision,
      verdict: now.evaluation?.verdict ?? null,
      evaluationAt: now.evaluation?.createdAt ?? null,
      invalidatedAt: now.invalidation?.createdAt ?? null,
    },
  };
}

// Evidence cited by a prediction, resolved against the experience log as it stood at the cutoff. The
// four states are distinct statements: the record was there; it was there and already superseded; it
// exists now but only after the cutoff; or nothing with that id is in the log at all. A source that
// could not be read makes every citation `unavailable`, never `missing`.
function resolveCitations({ projections, expView, reason, cutoff }) {
  const experienceHist = new Map((expView?.experiences ?? []).map((record) => [record.id, record]));
  const feedbackHist = new Map((expView?.feedback ?? []).map((record) => [record.id, record]));
  const experienceNow = new Map((expView?.current?.experiences ?? []).map((record) => [record.id, record]));
  const feedbackNow = new Map((expView?.current?.feedback ?? []).map((record) => [record.id, record]));
  const retiredExperiences = new Set(expView?.retiredExperiences ?? []);
  const retiredFeedback = new Set(expView?.retiredFeedback ?? []);
  const rows = new Map();
  let references = 0;
  const add = (kind, id, prediction, role) => {
    references += 1;
    const key = `${kind}:${id}`;
    let row = rows.get(key);
    if (!row) {
      row = { kind, id, roles: [], citedBy: [], state: null, reason: null };
      rows.set(key, row);
    }
    if (!row.roles.includes(role)) row.roles.push(role);
    if (!row.citedBy.includes(prediction.id)) row.citedBy.push(prediction.id);
  };
  for (const projection of projections) {
    for (const id of projection.evidence?.supportingExperienceIds ?? []) add('experience', id, projection, 'supporting');
    for (const id of projection.evidence?.contradictingExperienceIds ?? []) add('experience', id, projection, 'contradicting');
    for (const id of projection.evidence?.feedbackIds ?? []) add('feedback', id, projection, 'feedback');
  }
  for (const row of rows.values()) {
    row.roles.sort();
    row.citedBy.sort();
    if (!expView) {
      row.state = 'unavailable';
      row.reason = reason ?? 'the experience log was not read at this cutoff, so this citation cannot be resolved';
      continue;
    }
    const historical = row.kind === 'experience' ? experienceHist.get(row.id) : feedbackHist.get(row.id);
    if (historical) {
      row.state = 'recorded';
      row.createdAt = historical.createdAt ?? null;
      if (row.kind === 'experience') {
        row.occurredAt = instantOf(historical);
        row.outcomeClass = outcomeClass(historical.outcome);
        row.active = historical.active === true;
        row.superseded = historical.superseded === true || retiredExperiences.has(row.id);
      } else {
        row.assessment = historical.assessment;
        row.experienceId = historical.experienceId;
        row.superseded = retiredFeedback.has(row.id);
      }
      continue;
    }
    const later = row.kind === 'experience' ? experienceNow.get(row.id) : feedbackNow.get(row.id);
    if (later) {
      row.state = 'recorded_later';
      row.createdAt = later.createdAt ?? null;
      row.reason = `this record exists in the experience log but is dated after ${cutoff}, so it was not evidence at the cutoff`;
      continue;
    }
    row.state = 'missing';
    row.reason = 'no record with this id appears in the experience log, at the cutoff or now';
  }
  const ordered = [...rows.values()].sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
  const shown = ordered.slice(0, MAX_HISTORY_CITATIONS);
  return {
    rows: shown,
    total: ordered.length,
    references,
    truncated: ordered.length > shown.length,
    note: 'resolved against the experience log as it stood at the cutoff; a record dated after the cutoff is reported as later and was not used as evidence',
  };
}

function worldCounts(state) {
  if (!state) return null;
  return {
    entities: state.entities?.size ?? 0,
    facts: state.facts?.size ?? 0,
    relationships: state.relationships?.size ?? 0,
    events: state.events?.size ?? 0,
    merges: state.merges?.size ?? 0,
    identityDecisions: state.identityDecisions?.size ?? 0,
    retractions: state.retractions?.length ?? 0,
    supersessions: state.supersessions?.length ?? 0,
  };
}

function worldSection(worldView, source, limit) {
  if (!worldView) {
    return {
      available: false,
      status: source.status,
      reason: source.detail ?? 'the world model is not available at this cutoff',
      counts: null,
      current: null,
      later: null,
      rows: [],
      total: 0,
      truncated: false,
    };
  }
  const changes = worldView.later?.changes ?? [];
  const kinds = {};
  for (const change of changes) kinds[change.kind] = (kinds[change.kind] ?? 0) + 1;
  const shown = changes.slice(0, Math.min(limit, MAX_LATER_CHANGES));
  return {
    available: true,
    status: source.status,
    reason: source.detail,
    cutoff: worldView.cutoff,
    records: worldView.records,
    excluded: worldView.excluded,
    problems: [...(worldView.problems ?? [])],
    counts: worldCounts(worldView.state),
    current: worldCounts(worldView.current),
    later: {
      changes: changes.length,
      kinds,
      rows: shown.map((change) => ({
        at: change.at ?? null,
        kind: change.kind,
        recordType: change.recordType ?? null,
        id: change.id ?? null,
      })),
      truncated: changes.length > shown.length,
    },
    rows: [],
    total: 0,
    truncated: false,
    note: 'the replayed world state at the cutoff; per-record historical tracing remains at world.belief.trace --at',
  };
}

function countPredictions(projections) {
  const byStatus = {};
  for (const projection of projections) byStatus[projection.status] = (byStatus[projection.status] ?? 0) + 1;
  return byStatus;
}

function sourceStatuses(reads, verdict) {
  const byName = new Map((verdict?.stores ?? []).map((entry) => [entry.name, entry]));
  const out = {};
  for (const name of SOURCE_NAMES) {
    const read = reads[name] ?? { configured: false };
    const entry = byName.get(name);
    if (!read.configured) {
      out[name] = { name, status: 'not_configured', detail: `the ${name} store is not part of this configuration`, inspectable: null };
      continue;
    }
    if (read.error) {
      out[name] = {
        name,
        status: read.damaged ? 'damaged' : 'unavailable',
        detail: read.error,
        inspectable: entry === undefined ? null : entry.state !== 'unavailable',
      };
      continue;
    }
    const inspect = entry?.state ?? null;
    const status = inspect === 'absent' ? 'absent'
      : inspect === 'unavailable' ? 'unavailable'
        : inspect === 'not_configured' ? 'not_configured'
          : 'read';
    out[name] = {
      name,
      status,
      detail: status === 'unavailable' ? (entry?.detail ?? 'the store file could not be inspected') : null,
      inspectable: inspect !== 'unavailable' && inspect !== 'not_configured',
    };
  }
  return out;
}

async function readSources({ snapshot, cutoff, experience, predictions, world, limit }) {
  const reads = {
    experience: { configured: Boolean(experience), error: null, damaged: false },
    predictions: { configured: Boolean(predictions), error: null, damaged: false },
    world: { configured: Boolean(world) && typeof world.historicalView === 'function', error: null, damaged: false },
  };
  const fail = (name, err) => {
    reads[name].error = messageOf(err);
    reads[name].damaged = err instanceof StoreError;
  };
  let experienceView = null;
  if (reads.experience.configured) {
    try {
      experienceView = await snapshot.read('experience:historical', () => experience.historicalView(cutoff, { withCurrent: true }));
    } catch (err) {
      fail('experience', err);
    }
  }
  let predictionView = null;
  if (reads.predictions.configured) {
    try {
      predictionView = await snapshot.read('predictions:historical', () => predictions.historicalView(cutoff, {
        limit,
        // A replayed experience log is the only evidence a past horizon may be judged against. When
        // the experience source could not be read, `null` says so explicitly; the prediction store
        // then reports the horizons unread instead of consulting the live log.
        experienceSnapshot: experienceView === null ? null : experienceView.snapshot,
        currentExperienceSnapshot: experienceView === null ? null : experienceView.currentSnapshot,
        withCurrent: true,
      }));
    } catch (err) {
      fail('predictions', err);
    }
  }
  let worldView = null;
  if (reads.world.configured) {
    try {
      worldView = await snapshot.read('world:historical', () => world.historicalView(cutoff, { withCurrent: true }));
    } catch (err) {
      fail('world', err);
    }
  }
  return { reads, experienceView, predictionView, worldView };
}

function assemble({ cutoff, readAt, attempts, verdict, value, statuses, limit }) {
  const experienceView = value.experienceView;
  const predictionView = value.predictionView;
  const worldView = value.worldView;

  const experienceCurrentById = new Map((experienceView?.current?.experiences ?? []).map((record) => [record.id, record]));
  let experienceSection;
  if (experienceView) {
    const ordered = [...experienceView.experiences].sort(compareNewestFirst);
    const shown = ordered.slice(0, limit);
    experienceSection = {
      available: true,
      status: statuses.experience.status,
      reason: statuses.experience.detail,
      cutoff,
      records: experienceView.records,
      excluded: experienceView.excluded,
      undated: experienceView.undated,
      counts: {
        experiences: experienceView.experiences.length,
        feedback: experienceView.feedback.length,
        adaptations: experienceView.adaptations.length,
        reviews: experienceView.reviews.length,
        live: experienceView.experiences.filter((record) => record.active).length,
        superseded: experienceView.experiences.filter((record) => record.superseded).length,
        undatedEvents: experienceView.experiences.filter((record) => occurredAtOf(record).ms === null).length,
      },
      rows: shown.map((record) => experienceRow(record, experienceCurrentById)),
      total: ordered.length,
      truncated: ordered.length > shown.length,
      current: experienceView.current === null ? null : {
        records: experienceView.excluded + experienceView.records,
        experiences: experienceView.current.experiences.length,
        feedback: experienceView.current.feedback.length,
        adaptations: experienceView.current.adaptations.length,
        reviews: experienceView.current.reviews.length,
        live: experienceView.current.experiences.filter((record) => record.active).length,
      },
      note: experienceView.note,
    };
  } else {
    experienceSection = {
      available: false,
      status: statuses.experience.status,
      reason: statuses.experience.detail ?? 'the experience log was not read at this cutoff',
      cutoff,
      records: null,
      excluded: null,
      undated: null,
      counts: null,
      rows: [],
      total: 0,
      truncated: false,
      current: null,
      note: null,
    };
  }

  let predictionSection;
  let predictionRows = [];
  if (predictionView) {
    const currentById = new Map((predictionView.currentLedger?.projections ?? []).map((projection) => [projection.id, projection]));
    const opened = predictionView.openedIds
      .map((id) => predictionView.ledger.byId.get(id))
      .filter((projection) => projection !== undefined)
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    predictionRows = opened.map((projection) => predictionRow(projection, currentById.get(projection.id)));
    const currentRows = [...currentById.values()]
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      .map((projection) => ({
        id: projection.id,
        status: projection.status,
        decision: projection.evaluationDecision,
        verdict: projection.evaluation?.verdict ?? null,
        evaluationAt: projection.evaluation?.createdAt ?? null,
        invalidatedAt: projection.invalidation?.createdAt ?? null,
      }));
    predictionSection = {
      available: true,
      status: statuses.predictions.status,
      reason: statuses.predictions.detail,
      cutoff,
      records: predictionView.records,
      excluded: predictionView.excluded,
      undated: predictionView.undated,
      recorded: predictionView.predictions,
      opened: predictionView.opened,
      truncated: predictionView.truncated,
      totals: {
        opened: opened.length,
        byStatus: countPredictions(opened),
      },
      rows: predictionRows,
      current: predictionView.currentLedger === null ? null : {
        opened: currentRows.length,
        totals: countPredictions([...currentById.values()]),
        rows: currentRows,
      },
      note: predictionView.note,
    };
  } else {
    predictionSection = {
      available: false,
      status: statuses.predictions.status,
      reason: statuses.predictions.detail ?? 'the prediction ledger was not read at this cutoff',
      cutoff,
      records: null,
      excluded: null,
      undated: null,
      recorded: null,
      opened: null,
      truncated: false,
      totals: null,
      rows: [],
      current: null,
      note: null,
    };
  }

  const citations = resolveCitations({
    projections: predictionRows.map((row) => ({ id: row.id, evidence: predictionView.ledger.byId.get(row.id)?.evidence })),
    expView: experienceView,
    reason: statuses.experience.detail,
    cutoff,
  });

  const later = {
    cutoff,
    experiencesRecorded: experienceView?.current == null
      ? null : experienceView.current.experiences.length - experienceView.experiences.length,
    feedbackRecorded: experienceView?.current == null
      ? null : experienceView.current.feedback.length - experienceView.feedback.length,
    adaptationsRecorded: experienceView?.current == null
      ? null : experienceView.current.adaptations.length - experienceView.adaptations.length,
    reviewsRecorded: experienceView?.current == null
      ? null : experienceView.current.reviews.length - experienceView.reviews.length,
    predictionsRecorded: predictionView?.later.predictions ?? null,
    evaluationsRecorded: predictionView?.later.evaluations ?? null,
    invalidationsRecorded: predictionView?.later.invalidations ?? null,
    worldRecordsAdded: worldView?.later?.changes?.length ?? null,
    correctedShown: experienceSection.rows.filter((row) => row.correctedLater).length,
    feedbackAddedShown: experienceSection.rows.filter((row) => row.feedbackAddedLater).length,
    evaluationsShownLater: predictionRows.filter((row) => row.evaluationRecordedLater).length,
    invalidationsShownLater: predictionRows.filter((row) => row.invalidatedLater).length,
    replacementsShownLater: predictionRows.filter((row) => row.supersededLater).length,
    note: 'records dated after the cutoff are counted and shown as later; none of them is used to decide the past reading',
  };

  const clean = SOURCE_NAMES.every((name) => ['read', 'absent', 'not_configured'].includes(statuses[name].status));
  // A source that was damaged or could not be read is named in the answer but makes the combined
  // reading unverifiable: a snapshot certificate proves the files did not move, not that a file it
  // could not parse was read.
  const verifiable = verdict?.state !== 'unverifiable'
    && clean
    && SOURCE_NAMES.every((name) => statuses[name].inspectable !== false);
  const state = verdict?.state ?? 'unverified';

  return {
    schema: COGNITIVE_HISTORY_SCHEMA,
    cutoff,
    readAt,
    asOf: {
      cutoff,
      state,
      complete: clean && state === 'consistent',
      verifiable,
      attempts: attempts ?? null,
      snapshot: verdict === null ? null : {
        state: verdict.state,
        certification: verdict.certification,
        digest: verdict.digest ?? null,
        bounded: verdict.bounded === true,
      },
      sources: SOURCE_NAMES.map((name) => ({ ...statuses[name] })),
      note: 'a consistent snapshot proves no contributing file changed during this read; it is not a transaction, and it says nothing about whether the records are true',
    },
    experience: experienceSection,
    predictions: predictionSection,
    world: worldSection(worldView, statuses.world, limit),
    citations,
    later,
    unsupported: UNSUPPORTED_SOURCES.map((item) => ({ ...item })),
    limits: { rows: limit, citations: MAX_HISTORY_CITATIONS },
    rule: HISTORY_RULE,
    authorizes: false,
    note: 'this reconstructs what the stores had recorded by the cutoff, not what was objectively true then; the store that owns each record remains the authority for its lifecycle',
  };
}

// The whole reconstruction, one bounded read of every integrated store. `experience`, `predictions`,
// and `world` are the stores themselves; a store that is not supplied is reported as not configured,
// and one that cannot be read is reported as damaged or unavailable without hiding the others.
export async function reconstructCognition({
  cutoff,
  experience = null,
  predictions = null,
  world = null,
  limit = DEFAULT_HISTORY_ROWS,
  now = () => new Date(),
} = {}) {
  const normalized = parseIsoInstant(cutoff);
  if (normalized === null) {
    throw new ValidationError(`"${singleLine(cutoff, 60)}" is not an ISO date or an ISO date-time with a time zone`);
  }
  const size = rowLimit(limit);
  const readAtMs = parseInstant(typeof now === 'function' ? now() : now);
  const readAt = readAtMs === null ? null : new Date(readAtMs).toISOString();
  const stores = contributingStores({ experience, predictions, world });
  const outcome = await runConsistentEvidenceRead({
    stores,
    read: (snapshot) => readSources({ snapshot, cutoff: normalized, experience, predictions, world, limit: size }),
  });
  const statuses = sourceStatuses(outcome.value.reads, outcome.snapshot);
  return assemble({
    cutoff: normalized,
    readAt,
    attempts: outcome.attempts,
    verdict: outcome.snapshot,
    value: outcome.value,
    statuses,
    limit: size,
  });
}
