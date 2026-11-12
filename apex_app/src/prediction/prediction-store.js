// The append-only prediction ledger: one JSONL log holding three record kinds, and the only place a
// prediction can be written.
//
//   prediction               the user's recorded expectation, with its horizon and its cited evidence
//   prediction_invalidation   the user's explicit withdrawal of one expectation, with its reason
//   prediction_evaluation    the deterministic verdict of one expectation against recorded outcomes
//
// Why this is a separate file and not two more kinds inside `experiences.jsonl`: the experience store
// dispatches over a closed kind list, so an unknown kind is reported as damage, and every reader of
// that log - the timeline, the trends, the pattern detector, the adaptation derivation, the health
// report - would need a new clause saying "and skip predictions". That is precisely how an
// expectation would end up counted as something that happened. A separate log makes the guarantee
// physical instead of polite: the temporal engine reads `experiences.jsonl` and cannot see a
// prediction at all, and this store reads `predictions.jsonl` and cannot write an experience.
//
// Trust boundaries, in the order a record can appear:
//   1 a prediction exists only after a user-origin, explicitly authorized command wrote it. There is
//     no natural-language route and no automatic capture: a model response cannot create one, and the
//     action registry refuses a model-origin write before this store is reached;
//   2 the store re-checks the origin for the same reason the experience store does;
//   3 every cited evidence id must resolve in the experience log at write time, and none of them may
//     be dated after the prediction, or the write is refused. A prediction cannot be built on a
//     record nothing can confirm, nor on one that had not happened yet;
//   4 a verdict is computed here from recorded outcomes, and a caller supplies nothing but the
//     target: no verdict, confidence, score, or outcome text reaches this file from a model.
//
// What a prediction can never become is enforced by there being no path: no method here writes an
// experience, feedback, adaptation, memory, knowledge, or authorization record.
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { StoreError, ValidationError } from '../errors.js';
import { shortId, singleLine } from '../util.js';
import { isScopableCapability } from '../experience/experience-store.js';
import { MAX_TEMPORAL_EVENTS, PATTERN_KINDS, parseInstant } from '../experience/temporal.js';
import { MAX_LONGITUDINAL_PREDICTIONS, analyzeLongitudinal } from './longitudinal.js';
import {
  EVALUATION_KIND,
  EVALUATION_VERDICTS,
  EXPECTATIONS,
  INVALIDATION_KIND,
  MAX_CONTEXT_CHARS,
  MAX_EVIDENCE_IDS,
  MAX_PREDICTION_LIST,
  MAX_PREDICTION_PROMPT_ITEMS,
  MAX_REASON_CHARS,
  MAX_REPLACES,
  MAX_SUBJECT_CHARS,
  PREDICTION_KIND,
  PREDICTION_RECORD_KINDS,
  PREDICTION_SCHEMA,
  PROVENANCE_BY_KIND,
  FORBIDDEN_PREDICTION_FIELDS,
  deriveCalibration,
  deriveLimitations,
  deriveReplacementState,
  horizonProblem,
  projectLedger,
  predictionPromptShape,
  isPredictionId,
  replacementCircleIds,
  splitPredictionRecords,
  validateRefList,
  validatePredictionRecord,
  validateTextField,
} from './prediction-engine.js';

export const PREDICTION_PARSE_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_PREDICTION_HEALTH_SAMPLES = 20;

const EPOCH = '1970-01-01T00:00:00.000Z';
const NO_EXPERIENCE_LOG = 'no experience log is configured for this store, so no outcome can be established';

function matchesPredictionRef(record, ref) {
  return record.id === ref || record.id.startsWith(ref) || shortId(record.id) === ref;
}

// The ids that answer to more than one record, in first-appearance order. Every record kind shares one
// id space, so a prediction and an evaluation cannot wear the same id either.
function reusedRecordIds(records) {
  const seen = new Set();
  const reused = new Set();
  for (const record of records) {
    if (typeof record?.id !== 'string') continue;
    if (seen.has(record.id)) reused.add(record.id);
    else seen.add(record.id);
  }
  return [...reused];
}

// Provenance is derived from the record kind, exactly as in the experience store: `origin` and
// `updateMode` are the fields that say who authorized the record, so a caller may attach its
// operation id and a short context, and nothing else.
function sanitizeProvenance(p, kind) {
  const expected = PROVENANCE_BY_KIND[kind];
  const base = { origin: expected.origin, updateMode: expected.updateMode };
  if (p === undefined || p === null) return base;
  if (typeof p !== 'object' || Array.isArray(p)) throw new ValidationError('provenance must be an object');
  if (p.origin !== undefined || p.updateMode !== undefined) {
    throw new ValidationError('provenance origin and updateMode may not be supplied directly; they are derived from the record kind and the operation');
  }
  if (p.operationId !== undefined) {
    if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(p.operationId)) {
      throw new ValidationError('provenance operationId has an invalid format');
    }
    base.operationId = p.operationId;
  }
  if (p.context !== undefined && p.context !== null) {
    const ctx = validateTextField(p.context, 'provenance context', { max: MAX_CONTEXT_CHARS });
    if (ctx) base.context = ctx;
  }
  return base;
}

export class PredictionStore {
  constructor(filePath, {
    now = () => new Date(),
    experiences = null,
    parseCacheBytes = PREDICTION_PARSE_CACHE_BYTES,
    lockWaitMs,
    lockRetryMs,
    lockRetryMaxMs,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    // The log a prediction cites and the only source of outcome evidence. Reads report it as
    // unavailable when it is missing or unreadable; a write that names a reference refuses.
    this.experiences = experiences;
    this.log = new JsonlStore(filePath, { validateRecord: validatePredictionRecord, parseCacheBytes });
    // Every write derives its decision from the whole authoritative ledger plus the experience log,
    // then appends, so the lock covers read-derive-append for one store.
    this.writeLock = new WriterLock(filePath, { waitMs: lockWaitMs, retryMs: lockRetryMs, retryMaxMs: lockRetryMaxMs });
  }

  #requireUser(origin, what) {
    if (origin !== 'user') {
      throw new ValidationError(
        `${what} requires an authorized user-origin operation; model output cannot record, withdraw, or evaluate a prediction`,
        'WRITE_REQUIRES_USER_ORIGIN',
      );
    }
  }

  // --- reads -----------------------------------------------------------------

  // One authoritative read. `beforeAppend` marks the read a write performs first, which may reuse
  // this instance's incrementally maintained validated records (see ../memory/jsonl-store.js).
  async #loadComplete({ beforeAppend = false } = {}) {
    const { records, corrupt } = beforeAppend ? await this.log.loadForAppend() : await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`prediction store contains ${corrupt.length} corrupt line(s); refusing an incomplete prediction operation`);
    }
    // A reused record id is damage even though every line validates. Two records answering to one id
    // cannot both be that prediction, so a read would have to pick one - and whichever it picked, the
    // ledger would report a lifecycle, a lineage and a verdict for a record whose identity is in
    // dispute. Nothing in this build may resolve that by preference, so the ledger is refused instead.
    const reused = reusedRecordIds(records);
    if (reused.length > 0) {
      throw new StoreError(
        `prediction store reuses ${reused.length} record id(s) (${reused.map(shortId).join(', ')}); refusing an operation on a ledger whose records are not individually identifiable`,
      );
    }
    return records;
  }

  // The experience read one prediction needs: its own capability, its own horizon, and every record
  // it cites. One call per prediction, because a horizon belongs to the expectation it bounds - a
  // shared read could drop the record that decides another capability's verdict.
  //
  // An unavailable experience log is reported as unavailable, never as an empty window: "nothing
  // establishes this" and "nothing could be read" are different statements about different things.
  async #evidenceFor(prediction, snapshot = null) {
    if (!this.experiences || typeof this.experiences.evidenceIndex !== 'function') {
      return { available: false, reason: NO_EXPERIENCE_LOG };
    }
    const e = prediction.evidence ?? {};
    try {
      const index = await this.experiences.evidenceIndex({
        experienceIds: [...(e.supportingExperienceIds ?? []), ...(e.contradictingExperienceIds ?? [])],
        feedbackIds: e.feedbackIds ?? [],
        since: prediction.createdAt,
        until: prediction.expiresAt,
        capability: prediction.capability,
        limit: MAX_TEMPORAL_EVENTS,
        snapshot,
      });
      return { available: true, ...index };
    } catch (err) {
      return { available: false, reason: `the experience log could not be read: ${err?.message ?? String(err)}` };
    }
  }

  // Project the whole ledger. `only` limits the experience reads to the predictions a caller is
  // about to show, which is what makes `show` and one evaluation cost a single horizon read instead
  // of one per record; every other prediction in the projection still contributes its records and
  // replacement links, and says its horizon was not read.
  //
  // When more than one horizon is opened, they are all read from one snapshot of the experience log.
  // Each prediction still gets its own window, capability scope and pattern detection - only the
  // file read, the per-record validation and the lifecycle derivation are shared, and they are the
  // cost that made an aggregate read grow with predictions x the size of the experience log. Sharing
  // them also makes the operation state one thing rather than many: every horizon in one projection
  // now describes the same instant of the log, where reading it record by record could mix an
  // experience appended in the middle of the read into some horizons and leave it out of others.
  // Nothing is retained between operations, so the next read sees whatever was appended since.
  async #project({ records, nowMs, only = null }) {
    const { predictions } = splitPredictionRecords(records);
    const opened = only === null ? predictions : predictions.filter((record) => only.has(record.id));
    let snapshot = null;
    if (opened.length > 1 && typeof this.experiences?.evidenceSnapshot === 'function') {
      // A snapshot that cannot be taken falls back to one read per horizon, which is the cost and
      // the reporting the read had before; no projection is allowed to lose a horizon silently.
      try { snapshot = await this.experiences.evidenceSnapshot(); } catch { snapshot = null; }
    }
    const evidence = new Map();
    for (const record of opened) {
      evidence.set(record.id, await this.#evidenceFor(record, snapshot));
    }
    return projectLedger({
      records,
      nowMs,
      evidenceFor: (record) => evidence.get(record.id) ?? ({
        available: false,
        reason: 'this read did not open a horizon for this prediction; ask for it by id to see its state',
      }),
    });
  }

  // Record counts only. Anything a reader would act on needs the experience log, and the operational
  // status line must not depend on another store being readable.
  async status() {
    const { records, corrupt } = await this.log.load();
    const { predictions, invalidations, evaluations } = splitPredictionRecords(records);
    const { retired } = deriveReplacementState(predictions);
    const nowMs = parseInstant(this.now());
    return {
      path: this.filePath,
      records: records.length,
      predictions: predictions.length,
      live: predictions.filter((r) => !retired.has(r.id)).length,
      superseded: predictions.filter((r) => retired.has(r.id)).length,
      invalidations: invalidations.length,
      evaluations: evaluations.length,
      pastHorizon: predictions.filter((r) => parseInstant(r.expiresAt) !== null
        && nowMs !== null && parseInstant(r.expiresAt) < nowMs).length,
      confidenceValues: 0,
      experienceLogConfigured: Boolean(this.experiences),
      corrupt: corrupt.length,
    };
  }

  async list({ limit = MAX_PREDICTION_LIST, newestFirst = true } = {}) {
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_PREDICTION_LIST) : 20;
    const records = await this.#loadComplete();
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()) });
    const ordered = newestFirst ? [...ledger.projections].reverse() : ledger.projections;
    return {
      projections: ordered.slice(0, size),
      total: ordered.length,
      truncated: ordered.length > size,
      limit: size,
      ledger,
    };
  }

  async detail(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const matches = matchOne(this.#match(records, ref));
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()), only: new Set([matches.id]) });
    return ledger.byId.get(matches.id) ?? null;
  }

  // Several references answered from one read of the ledger. `detail` reads, splits and projects the
  // whole log for one id, so a currentness check that re-judged a candidate citing N predictions paid
  // that cost N times; this resolves every reference by the same rule - an absent or ambiguous
  // reference is an error for that reference alone - and projects the resolved ids in one pass. A
  // reference that resolves to no error carries `projection`, which is the object `detail` would have
  // returned for it. Nothing is retained between calls, so this is a batched read, not a cache.
  async details(refs) {
    const wanted = [...new Set((Array.isArray(refs) ? refs : [])
      .filter((ref) => typeof ref === 'string' && ref.trim().length > 0)
      .map((ref) => ref.trim()))];
    const out = new Map();
    if (wanted.length === 0) return out;
    const records = await this.#loadComplete();
    const { predictions } = splitPredictionRecords(records);
    const ids = new Map();
    for (const ref of wanted) {
      let matches;
      try {
        matches = matchOne(predictions.filter((record) => matchesPredictionRef(record, ref)));
      } catch (err) {
        out.set(ref, { error: err?.message ?? String(err) });
        continue;
      }
      ids.set(ref, matches.id);
    }
    if (ids.size === 0) return out;
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()), only: new Set(ids.values()) });
    for (const [ref, id] of ids) out.set(ref, { projection: ledger.byId.get(id) ?? null });
    return out;
  }

  #match(records, ref) {
    return splitPredictionRecords(records).predictions.filter((record) => matchesPredictionRef(record, ref));
  }

  // Every record that names this prediction, in append order: the prediction itself, the evaluations
  // and withdrawals that describe it, and the predictions that replaced it. Nothing here rewrites an
  // earlier line, so the history shows what was said first even when it was later withdrawn.
  async history(target) {
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) return null;
    const records = await this.#loadComplete();
    const matches = matchOne(this.#match(records, ref));
    const related = records.filter((record) => record.id === matches.id || record.predictionId === matches.id
      || (record.kind === PREDICTION_KIND && (record.replaces ?? []).includes(matches.id)));
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()), only: new Set([matches.id]) });
    return { projection: ledger.byId.get(matches.id), records: related };
  }

  // The counts of every recorded evaluation, with each rate's denominator named and its exclusions
  // listed. `capability` filters the projections after the ledger is derived, so a scoped summary
  // cannot mis-count the records it left out.
  async calibration({ capability = null } = {}) {
    const records = await this.#loadComplete();
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()) });
    const scoped = capability === null
      ? ledger
      : { ...ledger, projections: ledger.projections.filter((item) => item.capability === capability) };
    return { calibration: deriveCalibration({ ledger: scoped }), ledger: scoped };
  }

  // The longitudinal read: one grouped, bounded analysis of how recorded outcomes for a scope are
  // ordered. It reuses the same projections `list` produces, so the eligibility rule and the evidence
  // reads are the ones every other prediction read uses. It writes nothing and derives no candidate.
  async longitudinal({ capability = null, limit = MAX_LONGITUDINAL_PREDICTIONS } = {}) {
    const size = Number.isInteger(limit) && limit >= 1
      ? Math.min(limit, MAX_LONGITUDINAL_PREDICTIONS)
      : MAX_LONGITUDINAL_PREDICTIONS;
    const { projections, ledger } = await this.list({ limit: MAX_PREDICTION_LIST });
    const scoped = capability === null
      ? projections
      : projections.filter((item) => item.capability === capability);
    const chosen = scoped.slice(0, size);
    // One bounded read of the outcome records the chosen evaluations cite. A projection says which
    // records decided each verdict, but not whether a later record corrected one of them; without
    // this read an analysis could count an outcome that no longer stands. The read is reported even
    // when it fails, and a failure is an absence of information, never "everything is current".
    const outcomeIds = [...new Set(chosen.flatMap((p) => p.evaluation?.outcomeExperienceIds ?? []))];
    let experiencesById = null;
    let evidenceRead = null;
    if (outcomeIds.length > 0) {
      const times = chosen
        .flatMap((p) => [p.createdAt, p.expiresAt, p.evaluation?.createdAt])
        .map(parseInstant)
        .filter((ms) => ms !== null);
      if (this.experiences && typeof this.experiences.evidenceIndex === 'function' && times.length > 0) {
        try {
          const index = await this.experiences.evidenceIndex({
            experienceIds: outcomeIds.slice(0, MAX_TEMPORAL_EVENTS),
            since: new Date(Math.min(...times)).toISOString(),
            until: new Date(Math.max(...times)).toISOString(),
            limit: MAX_TEMPORAL_EVENTS,
          });
          experiencesById = new Map((index.experiences ?? []).map((record) => [record.id, record]));
          evidenceRead = {
            available: true,
            resolved: (index.experiences ?? []).length,
            unresolved: [...(index.unresolvedExperienceIds ?? [])],
            reason: null,
          };
        } catch (err) {
          evidenceRead = {
            available: false,
            resolved: 0,
            unresolved: [...outcomeIds],
            reason: err?.message ?? String(err),
          };
        }
      } else {
        evidenceRead = {
          available: false,
          resolved: 0,
          unresolved: [...outcomeIds],
          reason: times.length === 0
            ? 'the chosen expectations carry no readable timestamp, so no outcome window could be opened'
            : 'no experience log is attached to the prediction store',
        };
      }
    }
    return analyzeLongitudinal({
      projections: chosen,
      experiencesById,
      readTotal: scoped.length,
      readTruncated: ledger.truncated === true || scoped.length > size,
      now: this.now().toISOString(),
      evidenceRead,
    });
  }

  // The bounded view a model context and the world-state projection receive: aggregate counts and at
  // most `limit` standing expectations, each as id, capability, expectation, derived status, horizon
  // end and whether it cited records. Subject and reason text never leave this store, so an
  // expectation cannot reach a model as prose that reads like an observation, and a ledger of
  // hundreds of records contributes a fixed-size section.
  async promptView({ limit = MAX_PREDICTION_PROMPT_ITEMS } = {}) {
    const records = await this.#loadComplete();
    const ledger = await this.#project({ records, nowMs: parseInstant(this.now()) });
    return predictionPromptShape({
      calibration: deriveCalibration({ ledger }),
      projections: ledger.projections,
      limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_PREDICTION_PROMPT_ITEMS) : MAX_PREDICTION_PROMPT_ITEMS,
    });
  }

  async lockReport() {
    return this.writeLock.state();
  }

  async recover() {
    return this.writeLock.recover();
  }

  // Damage and inconsistency reporting for this log alone. It reads no other store, so a corrupt
  // experience log cannot make a healthy prediction ledger look broken, or the reverse.
  //
  // Three states are kept apart, because the operator's next step differs for each: the log could
  // not be read at all (`unavailable`, every count null - the file is not known to be empty), it
  // parsed except for lines that do not belong (`damaged`), or it was fully readable and may still
  // disagree with itself (`ok` with anomalies). A count is never reported as zero when the truth is
  // that it could not be established.
  async health() {
    let loaded;
    try {
      loaded = await this.log.load();
    } catch (err) {
      return {
        path: this.filePath,
        state: 'unavailable',
        inspected: false,
        complete: false,
        detail: err?.message ?? String(err),
        records: null,
        kinds: PREDICTION_RECORD_KINDS.map((kind) => ({ kind, count: null })),
        predictions: null,
        live: null,
        superseded: null,
        invalidations: null,
        evaluations: null,
        corruptLines: null,
        corrupt: [],
        anomalies: { count: null, truncated: false, samples: [] },
        attention: true,
      };
    }
    const { records, corrupt } = loaded;
    const { predictions, invalidations, evaluations } = splitPredictionRecords(records);
    const ids = new Set(predictions.map((r) => r.id));
    const anomalies = [];
    for (const record of invalidations) {
      if (!ids.has(record.predictionId)) anomalies.push(`withdrawal ${shortId(record.id)} names prediction ${shortId(record.predictionId)}, which is not in the log`);
    }
    for (const record of evaluations) {
      if (!ids.has(record.predictionId)) anomalies.push(`evaluation ${shortId(record.id)} names prediction ${shortId(record.predictionId)}, which is not in the log`);
    }
    for (const kind of [INVALIDATION_KIND, EVALUATION_KIND]) {
      const byTarget = new Map();
      for (const record of records.filter((r) => r.kind === kind)) {
        byTarget.set(record.predictionId, (byTarget.get(record.predictionId) ?? 0) + 1);
      }
      for (const [target, count] of [...byTarget].sort()) {
        if (count > 1) anomalies.push(`${count} ${kind} records name prediction ${shortId(target)}; the ledger allows one of each`);
      }
    }
    const { retired } = deriveReplacementState(predictions);
    for (const id of [...new Set(predictions
      .flatMap((record) => record.replaces ?? [])
      .filter((id) => !ids.has(id)))].sort()) {
      anomalies.push(`a replacement chain names prediction ${shortId(id)}, which is not in the log; the expectation that names it stands, and what it claims to correct was never recorded`);
    }
    for (const id of replacementCircleIds(predictions).sort()) {
      anomalies.push(`prediction ${shortId(id)} is retired only inside a replacement circle; every member of the circle is retired and none of them stands, so the ledger names the circle instead of choosing a winner`);
    }
    // Every line validated and the file still disagrees with itself: two records answering to one id.
    // Reads and writes refuse it (see #loadComplete); the health report says so rather than counting
    // the disputed record once and reading as though the ledger were merely smaller.
    for (const id of reusedRecordIds(records)) {
      anomalies.push(`record ${shortId(id)} is written more than once in the log; every read and write of this ledger refuses until the duplicate is resolved`);
    }
    return {
      path: this.filePath,
      state: corrupt.length > 0 ? 'damaged' : 'ok',
      inspected: corrupt.length === 0,
      complete: corrupt.length === 0,
      detail: null,
      attention: corrupt.length > 0 || anomalies.length > 0,
      records: records.length,
      kinds: PREDICTION_RECORD_KINDS.map((kind) => ({ kind, count: records.filter((r) => r.kind === kind).length })),
      predictions: predictions.length,
      // Counted over the records that exist, not as `predictions.length - retired.size`: a
      // hand-edited `replaces` can retire an id that was never written, and that is not a record of
      // this ledger. health() names the dangling reference as an anomaly instead.
      live: predictions.filter((r) => !retired.has(r.id)).length,
      superseded: predictions.filter((r) => retired.has(r.id)).length,
      invalidations: invalidations.length,
      evaluations: evaluations.length,
      corruptLines: corrupt.length,
      corrupt: corrupt.slice(0, MAX_PREDICTION_HEALTH_SAMPLES)
        .map((c) => ({ line: c.line, reason: c.reason, truncatedTail: c.truncatedTail === true })),
      anomalies: {
        count: anomalies.length,
        truncated: anomalies.length > MAX_PREDICTION_HEALTH_SAMPLES,
        samples: anomalies.slice(0, MAX_PREDICTION_HEALTH_SAMPLES).sort(),
      },
    };
  }

  // --- writes ----------------------------------------------------------------

  // Record one expectation. Nothing about it is inferred: the capability, the expectation, the
  // horizon, and the cited evidence all arrive from the user's command, and every cited id has to
  // resolve in the experience log before the record is appended.
  async recordPrediction({ capability, expectation, subject, expiresAt, evidence = {}, replaces = [], provenance = {}, origin, ...supplied } = {}) {
    this.#requireUser(origin, 'recording a prediction');
    // A caller cannot hand the ledger a number or a verdict, and it is told so rather than having
    // the field quietly dropped: a silently ignored argument would read as success.
    const stray = ['confidence', ...FORBIDDEN_PREDICTION_FIELDS].filter((field) => supplied[field] !== undefined);
    if (stray.length > 0) {
      throw new ValidationError(`a prediction is not given ${stray.join(', ')}: this build supplies no confidence and derives ${PREDICTION_KIND} state and verdicts at read time`);
    }
    if (!isScopableCapability(capability)) {
      throw new ValidationError('a prediction must name a real capability to scope it; none, blank, and free text are refused');
    }
    if (!EXPECTATIONS.includes(expectation)) {
      throw new ValidationError(`an expectation must be one of ${EXPECTATIONS.join(', ')}`);
    }
    if (evidence !== null && typeof evidence !== 'object') throw new ValidationError('cited evidence must name record ids');
    const e = evidence ?? {};
    if (e.confidence !== undefined || e.probability !== undefined || e.score !== undefined) {
      throw new ValidationError('a prediction carries no confidence value: this build supplies none and computes none');
    }
    for (const key of Object.keys(e)) {
      if (!['supportingExperienceIds', 'contradictingExperienceIds', 'feedbackIds', 'patternKinds'].includes(key)) {
        throw new ValidationError(`cited evidence has an unknown field ${singleLine(key, 40)}`);
      }
    }
    const label = validateTextField(subject, 'subject', { max: MAX_SUBJECT_CHARS });
    const createdAt = this.now().toISOString();
    const createdMs = parseInstant(createdAt);
    const horizonError = horizonProblem(expiresAt, createdMs);
    if (horizonError) throw new ValidationError(horizonError);
    const supporting = validateRefList(e.supportingExperienceIds, 'supporting experience ids', MAX_EVIDENCE_IDS);
    const contradicting = validateRefList(e.contradictingExperienceIds, 'contradicting experience ids', MAX_EVIDENCE_IDS);
    const feedback = validateRefList(e.feedbackIds, 'feedback ids', MAX_EVIDENCE_IDS);
    const patternKinds = e.patternKinds === undefined || e.patternKinds === null
      ? []
      : Array.isArray(e.patternKinds) ? [...new Set(e.patternKinds.map((kind) => String(kind).trim()))] : (() => { throw new ValidationError('cited pattern kinds must be a list'); })();
    if (patternKinds.length > PATTERN_KINDS.length) {
      throw new ValidationError(`cited pattern kinds may name at most ${PATTERN_KINDS.length} kinds`);
    }
    for (const kind of patternKinds) {
      if (!PATTERN_KINDS.includes(kind)) {
        throw new ValidationError(`cited pattern kind ${singleLine(kind, 40)} is not one the temporal engine can produce`);
      }
    }
    const shared = supporting.filter((id) => contradicting.includes(id));
    if (shared.length > 0) {
      throw new ValidationError('the same record cannot be cited as both supporting and contradicting; cite it once, in the role it plays');
    }
    const replaceRefs = validateRefList(replaces, 'replaced prediction ids', MAX_REPLACES);
    const recorded = sanitizeProvenance(provenance, PREDICTION_KIND);

    return this.writeLock.run(() => this.#recordPredictionFromAuthority({
      capability,
      expectation,
      label,
      expiresAt,
      supporting,
      contradicting,
      feedback,
      patternKinds,
      replaceRefs,
      recorded,
      createdAt,
      createdMs,
    }));
  }

  async #recordPredictionFromAuthority(input) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const { predictions, invalidations } = splitPredictionRecords(records);
    const { retired, replacedBy } = deriveReplacementState(predictions);

    const { supporting, contradicting, feedback } = await this.#resolveCitations(input);
    const replaceRefs = [];
    for (const ref of input.replaceRefs) {
      const matches = predictions.filter((record) => matchesPredictionRef(record, ref));
      if (matches.length === 0) throw new ValidationError(`the prediction being replaced ([${shortId(ref)}]) is not in the ledger; nothing written`);
      if (matches.length > 1) {
        throw new ValidationError(`the prediction being replaced ([${shortId(ref)}]) matches ${matches.length} records; use a longer id prefix`);
      }
      const id = matches[0].id;
      // The ledger stores the exact id a reference resolved to, so a replacement names one record
      // permanently and a later reader cannot follow a prefix onto a different line.
      if (replaceRefs.includes(id)) continue;
      if (retired.has(id)) {
        throw new ValidationError(`prediction [${shortId(id)}] is already replaced by [${(replacedBy.get(id) ?? []).map(shortId).join(', ')}]; replace the standing one instead`);
      }
      if (invalidations.some((i) => i.predictionId === id)) {
        throw new ValidationError(`prediction [${shortId(id)}] was withdrawn by the user, so it is not a standing expectation to replace`);
      }
      replaceRefs.push(id);
    }
    const live = predictions.filter((r) => !retired.has(r.id) && !invalidations.some((i) => i.predictionId === r.id));
    const duplicate = live.find((r) => r.capability === input.capability
      && r.expectation === input.expectation
      && r.subject === input.label
      && r.expiresAt === input.expiresAt);
    if (duplicate) {
      throw new ValidationError(
        `prediction [${shortId(duplicate.id)}] already records this expectation; correct it by naming that record in replaces`,
        'PREDICTION_EXISTS',
      );
    }

    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');

    const record = {
      schema: PREDICTION_SCHEMA,
      kind: PREDICTION_KIND,
      id,
      createdAt: input.createdAt,
      capability: input.capability,
      expectation: input.expectation,
      subject: input.label,
      expiresAt: input.expiresAt,
      confidence: null,
      evidence: {
        supportingExperienceIds: supporting,
        contradictingExperienceIds: contradicting,
        feedbackIds: feedback,
        patternKinds: input.patternKinds,
      },
      evidenceBasis: supporting.length + contradicting.length + feedback.length + input.patternKinds.length > 0
        ? 'cited'
        : 'none_cited',
      limitations: [],
      provenance: input.recorded,
      ...(replaceRefs.length > 0 ? { replaces: replaceRefs } : {}),
    };
    record.limitations = deriveLimitations(record);
    const problem = validatePredictionRecord(record);
    if (problem) throw new StoreError(`the recorded prediction failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record };
  }

  // Cross-store reference validation, which is the reason a prediction cannot be built on an event
  // nothing can confirm. Absence is a refusal, and so is a record dated after the moment the
  // expectation is being made: what had not happened yet cannot be what it was based on.
  //
  // Every citation reaches the stored record as an exact id. A caller may name a record any way a
  // read of APEX prints it - the eight characters `experience show` displays, a longer prefix, or the
  // whole id - and the reference is resolved here, against the log it must exist in, before anything
  // is appended. Two records matching one reference is a refusal rather than a choice.
  async #resolveCitations(input) {
    if (input.supporting.length + input.contradicting.length + input.feedback.length === 0) {
      return { supporting: [], contradicting: [], feedback: [] };
    }
    if (!this.experiences || typeof this.experiences.evidenceIndex !== 'function') {
      throw new ValidationError(`${NO_EXPERIENCE_LOG}; a prediction that cites records cannot be written without it`, 'EVIDENCE_UNRESOLVED');
    }
    const supporting = await this.#resolveRefs(input.supporting, 'experience', (ref) => this.experiences.findByPrefix(ref));
    const contradicting = await this.#resolveRefs(input.contradicting, 'experience', (ref) => this.experiences.findByPrefix(ref));
    const feedback = await this.#resolveRefs(input.feedback, 'feedback', (ref) => this.experiences.findFeedbackByPrefix(ref));
    // Re-checked after resolution: two references in different roles can name one record, and one
    // record cannot be both support and counter-evidence for the same expectation.
    const shared = supporting.filter((id) => contradicting.includes(id));
    if (shared.length > 0) {
      throw new ValidationError('the same record cannot be cited as both supporting and contradicting; cite it once, in the role it plays');
    }
    const cited = [...supporting, ...contradicting];
    let index;
    try {
      index = await this.experiences.evidenceIndex({
        experienceIds: cited,
        feedbackIds: feedback,
        // A wide read: a citation is bounded by what existed when the prediction was made, not by
        // the horizon, which is about what will happen.
        since: EPOCH,
        until: input.expiresAt,
        capability: null,
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError(`cannot read the experience log to validate a prediction citation: ${err?.message ?? String(err)}`);
    }
    if (index.unresolvedExperienceIds.length > 0) {
      throw new ValidationError(
        `the experience log does not contain ${index.unresolvedExperienceIds.map((id) => `[${shortId(id)}]`).join(' ')}; a prediction can only cite a recorded event, and "experience list" prints the id to cite`,
        'EVIDENCE_UNRESOLVED',
      );
    }
    if (index.unresolvedFeedbackIds.length > 0) {
      throw new ValidationError(
        `the experience log does not contain feedback ${index.unresolvedFeedbackIds.map((id) => `[${shortId(id)}]`).join(' ')}; a prediction can only cite a recorded assessment, and "experience show" prints the id to cite`,
        'EVIDENCE_UNRESOLVED',
      );
    }
    const future = index.experiences
      .filter((record) => record.occurredAt !== null && parseInstant(record.occurredAt) > input.createdMs)
      .map((record) => `[${shortId(record.id)}]`);
    if (future.length > 0) {
      throw new ValidationError(
        `${future.join(' ')} ${future.length === 1 ? 'is' : 'are'} dated after this prediction would be recorded; future evidence cannot be cited as original support`,
        'EVIDENCE_FROM_FUTURE',
      );
    }
    return { supporting, contradicting, feedback };
  }

  // One reference, one record. An exact id needs no lookup; anything else is resolved by the named
  // reader, and a reference that matches nothing is passed through so the re-read above reports it
  // in the store's own words rather than as a second, weaker refusal here.
  async #resolveRefs(refs, label, find) {
    const out = [];
    for (const ref of refs) {
      if (isPredictionId(ref)) {
        if (!out.includes(ref)) out.push(ref);
        continue;
      }
      let matches;
      try {
        matches = await find(ref);
      } catch (err) {
        if (err instanceof StoreError) throw err;
        throw new StoreError(`cannot read the experience log to resolve a cited ${label} id: ${err?.message ?? String(err)}`);
      }
      if (matches.length === 0) {
        if (!out.includes(ref)) out.push(ref);
        continue;
      }
      if (matches.length > 1) {
        throw new ValidationError(
          `the cited ${label} id ([${shortId(ref)}]) matches ${matches.length} records; use a longer id prefix so it names one`,
          'EVIDENCE_AMBIGUOUS',
        );
      }
      if (!out.includes(matches[0].id)) out.push(matches[0].id);
    }
    return out;
  }

  // Withdraw one expectation. The reason is required and stays with the record, and the prediction is
  // never edited or removed: an invalidated expectation remains inspectable history.
  async invalidatePrediction({ target, reason, provenance = {}, origin } = {}) {
    this.#requireUser(origin, 'withdrawing a prediction');
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) throw new ValidationError('a withdrawal must name the prediction it withdraws');
    const label = validateTextField(reason, 'reason', { max: MAX_REASON_CHARS });
    const recorded = sanitizeProvenance(provenance, INVALIDATION_KIND);
    return this.writeLock.run(() => this.#invalidateFromAuthority({ ref, label, recorded }));
  }

  async #invalidateFromAuthority({ ref, label, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const matches = matchOne(this.#match(records, ref));
    const { invalidations } = splitPredictionRecords(records);
    if (invalidations.some((i) => i.predictionId === matches.id)) {
      throw new ValidationError(`prediction [${shortId(matches.id)}] has already been withdrawn; a second withdrawal would duplicate it`, 'INVALIDATION_EXISTS');
    }
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const record = {
      schema: PREDICTION_SCHEMA,
      kind: INVALIDATION_KIND,
      id,
      predictionId: matches.id,
      reason: label,
      createdAt: this.now().toISOString(),
      provenance: recorded,
    };
    const problem = validatePredictionRecord(record);
    if (problem) throw new StoreError(`the withdrawal failed validation (${problem}); nothing written`);
    await this.log.append(record);
    return { record, predictionId: matches.id };
  }

  // Judge one expectation against the outcomes recorded now. The verdict is computed from the two
  // logs, so no caller - least of all a model - can assert a result, and a verdict the records do not
  // support writes nothing at all.
  async recordEvaluation({ target, provenance = {}, origin, ...supplied } = {}) {
    this.#requireUser(origin, 'evaluating a prediction');
    if (['verdict', 'confidence', 'outcome', 'score', 'probability'].some((field) => supplied[field] !== undefined)) {
      throw new ValidationError('an evaluation is not given a verdict: it is computed from the recorded outcome evidence, and nothing that judges it can be supplied');
    }
    const ref = typeof target === 'string' ? target.trim() : '';
    if (ref.length === 0) throw new ValidationError('an evaluation must name the prediction it judges');
    const recorded = sanitizeProvenance(provenance, EVALUATION_KIND);
    return this.writeLock.run(() => this.#evaluateFromAuthority({ ref, recorded }));
  }

  async #evaluateFromAuthority({ ref, recorded }) {
    const records = await this.#loadComplete({ beforeAppend: true });
    const matches = matchOne(this.#match(records, ref));
    // The projection comes from this same locked read, so the verdict is computed from the state the
    // record is appended to rather than from a snapshot taken before the lock was held.
    const ledger = await this.#project({
      records,
      nowMs: parseInstant(this.now()),
      only: new Set([matches.id]),
    });
    const projection = ledger.byId.get(matches.id);
    if (projection.evaluation !== null) {
      throw new ValidationError(
        `prediction [${shortId(matches.id)}] already has a recorded evaluation (${projection.evaluation.verdict}); a second one would duplicate it`,
        'EVALUATION_EXISTS',
      );
    }
    if (!EVALUATION_VERDICTS.includes(projection.evaluationDecision)) {
      return { record: null, projection, reason: projection.evaluationReason };
    }
    const establishing = projection.lineage?.outcomeEvidence?.ids?.ids ?? [];
    const deciding = projection.deciding?.id;
    const outcomeIds = [...new Set([...establishing, deciding])].slice(-MAX_EVIDENCE_IDS);
    const id = randomUUID();
    if (records.some((r) => r.id === id)) throw new StoreError('identifier collision; nothing written');
    const target = projection;
    const record = {
      schema: PREDICTION_SCHEMA,
      kind: EVALUATION_KIND,
      id,
      predictionId: matches.id,
      verdict: projection.evaluationDecision,
      createdAt: this.now().toISOString(),
      window: { since: target.createdAt, until: target.expiresAt },
      outcomeExperienceIds: outcomeIds,
      decidingExperienceId: deciding,
      decidingOccurredAt: projection.deciding.occurredAt,
      provenance: recorded,
    };
    const problem = validatePredictionRecord(record);
    if (problem) throw new StoreError(`the evaluation failed validation (${problem}); nothing written`);
    await this.log.append(record);
    const after = await this.#loadComplete();
    const reopened = await this.#project({ records: after, nowMs: parseInstant(this.now()), only: new Set([matches.id]) });
    return { record, projection: reopened.byId.get(matches.id) };
  }

  // Independent verification of one write: re-read the ledger and re-derive this prediction's
  // projection. `derivedAt` fixes `now` at the first read's value, because a horizon boundary that
  // advances between the two reads would report a change that is only clock drift.
  async auditProjection(target, { derivedAt = null } = {}) {
    const records = await this.#loadComplete();
    const matches = matchOne(this.#match(records, typeof target === 'string' ? target.trim() : ''));
    const ledger = await this.#project({
      records,
      nowMs: derivedAt ?? parseInstant(this.now()),
      only: new Set([matches.id]),
    });
    return ledger.byId.get(matches.id) ?? null;
  }
}

// A reference is either unique or refused: an ambiguous prefix must not silently pick the older or
// the newer record, and an absent one is reported as absent rather than as an empty result.
function matchOne(matches) {
  // Two distinct refusals with two distinct codes, because the caller's next step differs: an
  // absent reference is reported as nothing recorded, while an ambiguous one must be narrowed.
  if (matches.length === 0) throw new ValidationError('no prediction record matches that reference; nothing to show', 'PREDICTION_NOT_FOUND');
  if (matches.length > 1) throw new ValidationError('the prediction reference is ambiguous; use a longer id prefix', 'PREDICTION_AMBIGUOUS');
  return matches[0];
}
