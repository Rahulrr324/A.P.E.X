// Prediction actions: the user-facing surface of the prediction ledger, registered by the
// composition root alongside the memory, knowledge, and experience actions.
//
// The trust boundaries these actions exist to hold:
//  - a prediction is an expectation, never an observation. Nothing here can write an experience,
//    feedback, adaptation, memory, knowledge, or authorization record, because nothing here calls
//    those stores;
//  - an expectation exists only because the user said so. Every write is user-origin only, refused
//    twice (here by the registry, again by the store), and `plannable: false` keeps it out of a
//    model's plan: a model response cannot silently create a durable prediction;
//  - a verdict is computed by the store from recorded outcomes. No caller supplies one, so no action
//    here can let a model grade its own expectation;
//  - the ledger's numbers never come with an invented confidence. The reads state why it is
//    unavailable rather than leaving the field out.
//
// Unlike memory, these records have no private variant: a prediction is a pointer to evidence that
// already exists in the audit and experience logs, so a model-origin read sees the same record set a
// user-origin read sees.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import { PATTERN_KINDS, parseInstant } from '../experience/temporal.js';
import {
  EXPECTATIONS,
  MAX_EVIDENCE_IDS,
  MAX_PREDICTION_HORIZON_DAYS,
  MAX_PREDICTION_LIST,
  MAX_REASON_CHARS,
  MAX_REPLACES,
  MAX_SUBJECT_CHARS,
  PREDICTION_STATUSES,
  renderCalibration,
  renderEvaluationResult,
  renderPredictionDetail,
  renderPredictionHistory,
  renderPredictionList,
  isRecordRef,
  invalidRefMessage,
} from '../prediction/prediction-engine.js';

const DAY_MS = 86_400_000;

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(t)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return t;
}

// A record reference is not a field of the record, so it has its own refusal. The value is never
// quoted back in the error text: it can reach the audit record through the execution error.
function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(ref)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  }
  return ref;
}

// A citation has a shape as well as a limit: it names one record, so it is a full id or the leading
// characters a read prints for one. Checked here because a mistyped reference is a rejected input -
// nothing was attempted - while the store repeats the rule as the boundary for every other caller.
function citationList(value, name, { max = MAX_EVIDENCE_IDS } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list of record ids`);
  if (value.length > max) throw new ValidationError(`${name} may name at most ${max} records`);
  const refs = value.map((entry) => recordRef(entry, name));
  for (const ref of refs) {
    if (!isRecordRef(ref)) throw new ValidationError(invalidRefMessage(name));
  }
  return refs;
}

function limitValue(value, { max = MAX_PREDICTION_LIST, fallback = 20 } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`limit must be an integer from 1 to ${max}`);
  }
  return value;
}

// The scope of an expectation is the capability it is about, so it must name a real one. The store
// applies the same rule; this only turns it into a refusal that says what to type.
function capabilityName(value, name = 'capability') {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const text = value.trim();
  if (text.length === 0) throw new ValidationError(`${name} is empty`);
  if (text.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (!/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(text) || text === 'none') {
    throw new ValidationError(`${name} must be a capability name such as memory.add or knowledge.search`);
  }
  return text;
}

function capabilityFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('capability must be text');
  const text = value.trim();
  if (text.length === 0) return null;
  return capabilityName(text);
}

function statusFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('status must be text');
  const text = value.trim();
  if (text.length === 0) return null;
  if (!PREDICTION_STATUSES.includes(text)) {
    throw new ValidationError(`status must be one of: ${PREDICTION_STATUSES.join(', ')}`);
  }
  return text;
}

// The horizon is the one field with two acceptable spellings, because "in 30 days" is what a person
// means and an instant is what the ledger stores. Both cannot be given: one question, one answer.
// The shape is checked here with the ledger's own parser, so a request is never accepted with a bound
// the engine would then read differently. Whether the instant is after the creation stamp is decided
// by the store, which is where that stamp is taken.
function horizonFields(o) {
  const hasExpires = o.expiresAt !== undefined && o.expiresAt !== null;
  const hasDays = o.inDays !== undefined && o.inDays !== null;
  if (hasExpires && hasDays) {
    throw new ValidationError('give the horizon either as expiresAt or as inDays, not both');
  }
  if (!hasExpires && !hasDays) throw new ValidationError('a prediction must have a horizon: give expiresAt or inDays');
  if (hasDays) {
    if (!Number.isInteger(o.inDays) || o.inDays < 1 || o.inDays > MAX_PREDICTION_HORIZON_DAYS) {
      throw new ValidationError(`inDays must be an integer from 1 to ${MAX_PREDICTION_HORIZON_DAYS}`);
    }
    return { expiresAt: null, inDays: o.inDays };
  }
  if (typeof o.expiresAt !== 'string') throw new ValidationError('expiresAt must be an ISO 8601 timestamp');
  const text = o.expiresAt.trim();
  if (text.length === 0 || text.length > 40) throw new ValidationError('expiresAt must be 1 to 40 characters');
  if (CONTROL_CHARS.test(text)) throw new ValidationError('expiresAt contains control characters');
  if (parseInstant(text) === null) throw new ValidationError('expiresAt is not a recognizable time; use an ISO 8601 timestamp');
  return { expiresAt: text, inDays: null };
}

// Resolved against the operation's clock, in the write path where the creation instant is taken. A
// horizon that has already passed cannot be an expectation about a later outcome, and saying so here
// refuses the request before the ledger is opened: nothing was written, which is what the caller is
// told, rather than a derived verdict about a record that does not exist.
function resolveHorizon(fields, now) {
  if (fields.inDays !== null) {
    return new Date(now().getTime() + fields.inDays * DAY_MS).toISOString();
  }
  if (parseInstant(fields.expiresAt) <= now().getTime()) {
    throw new ValidationError('expiresAt is not in the future, so it is not a horizon; nothing was written');
  }
  return fields.expiresAt;
}

function evidenceInput(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('evidence must be an object naming record ids');
  }
  for (const key of Object.keys(value)) {
    if (!['supportingExperienceIds', 'contradictingExperienceIds', 'feedbackIds', 'patternKinds'].includes(key)) {
      throw new ValidationError(`evidence has an unknown field "${key}"; cite supportingExperienceIds, contradictingExperienceIds, feedbackIds, or patternKinds`);
    }
  }
  const kinds = value.patternKinds === undefined || value.patternKinds === null
    ? []
    : Array.isArray(value.patternKinds) ? value.patternKinds.map((kind) => recordRef(kind, 'patternKinds')) : (() => { throw new ValidationError('patternKinds must be a list'); })();
  for (const kind of kinds) {
    if (!PATTERN_KINDS.includes(kind)) {
      throw new ValidationError(`"${kind.slice(0, 40)}" is not a pattern kind the temporal engine can produce`);
    }
  }
  return {
    supportingExperienceIds: citationList(value.supportingExperienceIds, 'supportingExperienceIds'),
    contradictingExperienceIds: citationList(value.contradictingExperienceIds, 'contradictingExperienceIds'),
    feedbackIds: citationList(value.feedbackIds, 'feedbackIds'),
    patternKinds: [...new Set(kinds)],
  };
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
  }
  return input;
}

// The reference a read refused because nothing matches it. `matchOne` says so by code, so this is a
// branch on the typed error rather than on its message.
function isNotFound(err) {
  return err instanceof ValidationError && err.code === 'PREDICTION_NOT_FOUND';
}

// The re-read that confirms a "nothing matches that reference" answer. The store states an absent
// reference by throwing, so the read that has to establish absence catches its own answer: a throw
// left here would surface as a verification that could not be completed, which reports an
// unverifiable outcome for a fact the ledger just confirmed. An ambiguous reference is different
// and still throws, because nothing about it can be confirmed either way.
async function auditProjectionOrNone(store, target) {
  try {
    return await store.auditProjection(target);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

const NOT_RECORDED = (target) => `No recorded prediction matches "${target}". APEX makes no predictions of its own: an expectation exists only after "prediction record" writes one, and only an audited capability can be one.`;

// ---- audit shapes ------------------------------------------------------------
//
// The fields an independent re-read can confirm. Lifecycle state and the evaluation decision are
// deliberately absent from every shape below: both are derived from the horizon measured against
// "now", so two reads a few milliseconds apart can report different ones simply because a horizon
// expired between them. A re-read that disagrees about a stored field means the ledger changed
// under the operation; a re-read that reports a different status means time passed, and reporting
// that as a failed verification would be a false alarm about a correct record.
function predictionReadShape(item) {
  return {
    id: item.id,
    createdAt: item.createdAt,
    capability: item.capability,
    expectation: item.expectation,
    subject: item.subject,
    expiresAt: item.expiresAt,
    confidence: item.confidence,
    evidenceBasis: item.evidenceBasis,
    evidence: {
      supportingExperienceIds: [...(item.evidence.supportingExperienceIds ?? [])].sort(),
      contradictingExperienceIds: [...(item.evidence.contradictingExperienceIds ?? [])].sort(),
      feedbackIds: [...(item.evidence.feedbackIds ?? [])].sort(),
      patternKinds: [...(item.evidence.patternKinds ?? [])].sort(),
    },
    limitations: [...item.limitations].sort(),
    replaces: [...item.replaces].sort(),
    provenance: { ...item.provenance },
    statusIsDerivable: PREDICTION_STATUSES.includes(item.status),
    // The distinctive postcondition of this store: the records a prediction cites have to resolve in
    // the experience log, so a re-read that finds a citation missing is a real disagreement.
    citationsResolve: item.lineage.available === false
      ? null
      : item.lineage.atCreation.unresolvedExperienceIds.length === 0
        && item.lineage.atCreation.unresolvedFeedbackIds.length === 0,
    evaluationRecorded: item.evaluation === null
      ? null
      : {
        id: item.evaluation.id,
        verdict: item.evaluation.verdict,
        createdAt: item.evaluation.createdAt,
        window: { ...item.evaluation.window },
        outcomeExperienceIds: [...item.evaluation.outcomeExperienceIds].sort(),
        decidingExperienceId: item.evaluation.decidingExperienceId,
      },
    invalidationRecorded: item.invalidation === null
      ? null
      : {
        id: item.invalidation.id,
        reason: item.invalidation.reason,
        createdAt: item.invalidation.createdAt,
        provenance: { ...item.invalidation.provenance },
      },
  };
}

// The same reasoning for the aggregate read: the counts of what was scored are stored facts, the
// three buckets that depend on whether a horizon has elapsed are not.
function calibrationReadShape(calibration) {
  const t = calibration.totals;
  return {
    records: t.records,
    live: t.live,
    evaluated: t.evaluated,
    matched: t.matched,
    contradicted: t.contradicted,
    invalidated: t.invalidated,
    superseded: t.superseded,
    staleEvaluations: t.staleEvaluations,
    byStatus: {
      evaluated: t.byStatus.evaluated,
      invalidated: t.byStatus.invalidated,
      superseded: t.byStatus.superseded,
    },
    matchRate: { ...calibration.matchRate },
    rateDenominator: calibration.rateDenominator,
    reliability: calibration.reliability,
    confidence: { ...calibration.confidence },
    capabilities: calibration.byCapability.map((item) => ({
      capability: item.capability,
      matched: item.matched,
      contradicted: item.contradicted,
      denominator: item.denominator,
      rate: item.rate,
    })).sort((a, b) => a.capability.localeCompare(b.capability)),
  };
}

// ---- actions -----------------------------------------------------------------

export function predictionActions(store) {
  if (!store || typeof store.recordPrediction !== 'function') {
    throw new TypeError('predictionActions requires a prediction store');
  }
  return [
    {
      name: 'prediction.record',
      description: 'Record one expectation the user holds about a later outcome of a capability, with its horizon and the recorded events it is based on. Write: user origin only.',
      inputHint: '{"capability":"memory.add","expectation":"success|failure|blocked","subject":"short description","expiresAt":"ISO 8601","inDays":optional 1-366,"evidence":{"supportingExperienceIds":[],"contradictingExperienceIds":[],"feedbackIds":[],"patternKinds":[]},"replaces":["optional prediction ids"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model must not be able to put an expectation into the ledger by planning it. The words
      // "I expect this to work" in a response are not a record of what the user expects.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['capability', 'expectation', 'subject', 'expiresAt', 'inDays', 'evidence', 'replaces']);
        if (typeof o.expectation !== 'string' || !EXPECTATIONS.includes(o.expectation.trim())) {
          throw new ValidationError(`expectation must be one of: ${EXPECTATIONS.join(', ')}`);
        }
        return {
          capability: capabilityName(o.capability),
          expectation: o.expectation.trim(),
          subject: textField(o.subject, 'subject', MAX_SUBJECT_CHARS),
          horizon: horizonFields(o),
          evidence: evidenceInput(o.evidence),
          replaces: citationList(o.replaces, 'replaces', { max: MAX_REPLACES }),
        };
      },
      async execute(ctx, input) {
        const { record } = await store.recordPrediction({
          capability: input.capability,
          expectation: input.expectation,
          subject: input.subject,
          expiresAt: resolveHorizon(input.horizon, ctx.now),
          evidence: input.evidence,
          replaces: input.replaces,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        // The same projection a later read produces, so the creation reply cannot promise a state
        // the ledger would not report.
        const projection = await store.detail(record.id);
        return {
          summary: `recorded prediction ${shortId(record.id)}: ${record.capability} expects ${record.expectation}`,
          data: { id: record.id, projection: predictionReadShape(projection) },
          display: [
            renderPredictionDetail(projection),
            '',
            'This is an expectation, not an observation: nothing about it has happened.',
            'It authorizes no action, approves no adaptation, and changes no recorded experience.',
          ].join('\n'),
        };
      },
      async verify(_ctx, input, result) {
        const fresh = await store.auditProjection(result.data.id);
        if (!fresh) return { ok: false, detail: 'prediction not found in the ledger after write' };
        if (fresh.id !== result.data.id) return { ok: false, detail: 'stored prediction id differs from the write result' };
        if (fresh.capability !== input.capability) return { ok: false, detail: 'stored capability differs from the request' };
        if (fresh.expectation !== input.expectation) return { ok: false, detail: 'stored expectation differs from the request' };
        if (fresh.subject !== input.subject) return { ok: false, detail: 'stored subject differs from the request' };
        const expected = predictionReadShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projection)) {
          return { ok: false, detail: 'an independent read of the ledger disagrees about the stored prediction or its citations' };
        }
        if (expected.confidence !== null) {
          return { ok: false, detail: 'a stored prediction carries a confidence value, which no writer in this build produces' };
        }
        if (expected.evaluationRecorded !== null || expected.invalidationRecorded !== null) {
          return { ok: false, detail: 'a prediction that was just recorded already carries a verdict or a withdrawal' };
        }
        return {
          ok: true,
          detail: `prediction present; ${expected.evidence.supportingExperienceIds.length + expected.evidence.contradictingExperienceIds.length + expected.evidence.feedbackIds.length} citation set(s) re-read against the experience log; no state or verdict stored`,
        };
      },
    },

    {
      name: 'prediction.list',
      description: 'List recorded expectations with their horizon, lifecycle state, evidence basis, and any recorded verdict. Read-only; derives state from the ledger and calls no model.',
      inputHint: '{"limit": optional 1-50, "capability": optional exact capability, "status": optional recorded|expired|awaiting_evaluation|evaluated|superseded|invalidated}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit', 'capability', 'status']);
        return { limit: limitValue(o.limit), capability: capabilityFilter(o.capability), status: statusFilter(o.status) };
      },
      async execute(_ctx, query) {
        const view = await readList(store, query);
        return {
          summary: `${view.projections.length} prediction(s) shown of ${view.total} recorded expectation(s)`,
          data: { query, total: view.total, truncated: view.truncated, projections: view.projections.map(predictionReadShape) },
          display: renderPredictionList(view.projections, { query, total: view.total, truncated: view.truncated }),
        };
      },
      async verify(_ctx, query, result) {
        const fresh = await readList(store, query);
        if (fresh.total !== result.data.total) {
          return { ok: false, detail: `listed ${result.data.total} expectation(s); an independent read gives ${fresh.total}` };
        }
        const expected = fresh.projections.map(predictionReadShape);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projections)) {
          return { ok: false, detail: 'listed predictions differ from an independent store read' };
        }
        return { ok: true, detail: `${expected.length} prediction(s) of ${fresh.total} confirmed against the store` };
      },
    },

    {
      name: 'prediction.show',
      description: 'Show one recorded expectation with its evidence lineage, its lifecycle state, the verdict if one is recorded, and why it carries no confidence. Read-only.',
      inputHint: '{"target":"prediction id or unique prefix"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async execute(_ctx, { target }) {
        let projection;
        try {
          projection = await store.detail(target);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          return {
            summary: `no recorded prediction matches ${target}`,
            data: { found: false, target },
            display: NOT_RECORDED(target),
          };
        }
        return {
          summary: `showed prediction ${shortId(projection.id)} (${projection.capability}, ${projection.status})`,
          data: { found: true, target, projection: predictionReadShape(projection) },
          display: renderPredictionDetail(projection),
        };
      },
      async verify(_ctx, { target }, result) {
        if (!result.data.found) {
          const fresh = await auditProjectionOrNone(store, target);
          return fresh
            ? { ok: false, detail: 'an independent read resolves the reference to a prediction after all' }
            : { ok: true, detail: 'absence confirmed by an independent read' };
        }
        const fresh = await store.auditProjection(target);
        if (!fresh) return { ok: false, detail: 'an independent read no longer resolves the reference' };
        const expected = predictionReadShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projection)) {
          return { ok: false, detail: 'the shown prediction differs from an independent read of the ledger' };
        }
        return { ok: true, detail: `prediction, its ${expected.evidence.supportingExperienceIds.length + expected.evidence.contradictingExperienceIds.length} citation set(s), and its limitations confirmed against the store` };
      },
    },

    {
      name: 'prediction.history',
      description: 'Show every record that names one expectation in append order: the prediction itself, the withdrawals and evaluations that describe it, and the expectations that replaced it. Read-only; nothing is rewritten.',
      inputHint: '{"target":"prediction id or unique prefix"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async execute(_ctx, { target }) {
        let view;
        try {
          view = await store.history(target);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          return {
            summary: `no recorded prediction matches ${target}`,
            data: { found: false, target },
            display: NOT_RECORDED(target),
          };
        }
        return {
          summary: `showed ${view.records.length} record(s) in the history of prediction ${shortId(view.projection.id)}`,
          data: {
            found: true,
            target,
            projection: predictionReadShape(view.projection),
            // The append order is the history, so it is listed as kinds and ids: who said what, in
            // what order, with the user\'s words staying out of the audit record.
            records: view.records.map((r) => ({ kind: r.kind, id: r.id, createdAt: r.createdAt })),
          },
          display: renderPredictionHistory(view.projection, view.records),
        };
      },
      async verify(_ctx, { target }, result) {
        if (!result.data.found) {
          const fresh = await auditProjectionOrNone(store, target);
          return fresh
            ? { ok: false, detail: 'an independent read resolves the reference to a prediction after all' }
            : { ok: true, detail: 'absence confirmed by an independent read' };
        }
        const fresh = await store.history(target);
        const expectedRecords = fresh.records.map((r) => ({ kind: r.kind, id: r.id, createdAt: r.createdAt }));
        if (JSON.stringify(expectedRecords) !== JSON.stringify(result.data.records)) {
          return { ok: false, detail: 'the listed history differs from an independent read of the ledger' };
        }
        const expected = predictionReadShape(fresh.projection);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projection)) {
          return { ok: false, detail: 'the predicted state behind the history differs from an independent read' };
        }
        return { ok: true, detail: `${expectedRecords.length} record(s) in append order confirmed against the store; none of them rewrote another` };
      },
    },

    {
      name: 'prediction.evaluate',
      description: 'Judge one recorded expectation against the outcomes recorded in the experience log and store the verdict. The verdict is computed from the evidence, never supplied. Nothing is written when the records do not establish an outcome. Write: user origin only.',
      inputHint: '{"target":"prediction id or unique prefix"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model cannot grade its own expectation, and a plan that names this action is refused before
      // the ledger is opened.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async execute(ctx, { target }) {
        let written;
        try {
          written = await store.recordEvaluation({
            target,
            provenance: { operationId: ctx.operationId },
            origin: ctx.origin,
          });
        } catch (err) {
          if (!isNotFound(err)) throw err;
          return {
            summary: `no recorded prediction matches ${target}`,
            data: { found: false, target },
            display: NOT_RECORDED(target),
          };
        }
        const recorded = written.record !== null;
        return {
          summary: recorded
            ? `prediction ${shortId(written.record.predictionId)} evaluated as ${written.record.verdict}`
            : `prediction ${shortId(written.projection.id)} was not evaluated (${written.projection.evaluationDecision}); nothing written`,
          data: {
            found: true,
            recorded,
            target,
            verdict: recorded ? written.record.verdict : null,
            evaluationId: recorded ? written.record.id : null,
            projection: predictionReadShape(written.projection),
          },
          display: renderEvaluationResult(written.projection, { recorded }),
        };
      },
      async verify(_ctx, { target }, result) {
        if (!result.data.found) {
          const fresh = await auditProjectionOrNone(store, target);
          return fresh
            ? { ok: false, detail: 'an independent read resolves the reference to a prediction after all' }
            : { ok: true, detail: 'absence confirmed by an independent read' };
        }
        const fresh = await store.auditProjection(target);
        if (!fresh) return { ok: false, detail: 'an independent read no longer resolves the reference' };
        if (result.data.recorded) {
          if (fresh.evaluation === null) {
            return { ok: false, detail: 'the evaluation the write reported is not in the ledger' };
          }
          if (fresh.evaluation.id !== result.data.evaluationId || fresh.evaluation.verdict !== result.data.verdict) {
            return { ok: false, detail: 'the stored evaluation differs from the one the write reported' };
          }
          return { ok: true, detail: `evaluation ${fresh.evaluation.verdict} present in the ledger, decided from ${fresh.evaluation.outcomeExperienceIds.length} outcome record(s)` };
        }
        // The postcondition of a refusal is that the ledger is unchanged: no verdict the records do
        // not support may have been written.
        if (fresh.evaluation !== null) {
          return { ok: false, detail: `a verdict (${fresh.evaluation.verdict}) was stored although the evidence establishes none` };
        }
        const expected = predictionReadShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projection)) {
          return { ok: false, detail: 'an independent read disagrees about the prediction the refusal was based on' };
        }
        return { ok: true, detail: `no evaluation recorded, as the evidence requires: the ledger holds no verdict for this expectation` };
      },
    },

    {
      name: 'prediction.invalidate',
      description: 'Withdraw one recorded expectation, keeping its reason and provenance in the log. The expectation is not deleted and stays auditable. Write: user origin only.',
      inputHint: '{"target":"prediction id or unique prefix","reason":"why the expectation is withdrawn"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS),
        };
      },
      async execute(ctx, { target, reason }) {
        let written;
        try {
          written = await store.invalidatePrediction({
            target,
            reason,
            provenance: { operationId: ctx.operationId },
            origin: ctx.origin,
          });
        } catch (err) {
          if (!isNotFound(err)) throw err;
          return {
            summary: `no recorded prediction matches ${target}`,
            data: { found: false, target },
            display: NOT_RECORDED(target),
          };
        }
        const projection = await store.detail(written.predictionId);
        return {
          summary: `withdrew prediction ${shortId(written.predictionId)}`,
          data: {
            found: true,
            target,
            invalidationId: written.record.id,
            predictionId: written.predictionId,
            projection: predictionReadShape(projection),
          },
          display: [
            `Prediction ${shortId(written.predictionId)} is withdrawn.`,
            `  Reason:       ${reason}`,
            `  Recorded:     withdrawal ${shortId(written.record.id)} in predictions.jsonl`,
            `  Now reads as: ${projection.status} (${projection.statusReason})`,
            '  The expectation and any verdict it already carried stay in the log; withdrawing it did not delete a record and does not make the outcome unknown.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { target, reason }, result) {
        if (!result.data.found) {
          const fresh = await auditProjectionOrNone(store, target);
          return fresh
            ? { ok: false, detail: 'an independent read resolves the reference to a prediction after all' }
            : { ok: true, detail: 'absence confirmed by an independent read' };
        }
        const fresh = await store.auditProjection(result.data.predictionId);
        if (!fresh) return { ok: false, detail: 'the withdrawn prediction is no longer in the ledger' };
        if (fresh.invalidation === null) return { ok: false, detail: 'no withdrawal record names this prediction' };
        if (fresh.invalidation.id !== result.data.invalidationId) {
          return { ok: false, detail: 'the stored withdrawal differs from the one the write reported' };
        }
        if (fresh.invalidation.reason !== reason) {
          return { ok: false, detail: 'the stored reason differs from the one given' };
        }
        if (fresh.invalidation.provenance.origin !== 'user_retirement' || fresh.invalidation.provenance.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'the stored withdrawal is not marked as a user-origin retirement' };
        }
        // The one derived state a withdrawal decides on its own, independent of the clock.
        if (fresh.status !== 'invalidated') {
          return { ok: false, detail: `the ledger still reads this expectation as ${fresh.status}, not withdrawn` };
        }
        const expected = predictionReadShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.projection)) {
          return { ok: false, detail: 'an independent read disagrees about the prediction behind the withdrawal' };
        }
        return { ok: true, detail: `withdrawal present with its reason and provenance; the expectation stays in the log as history` };
      },
    },

    {
      name: 'prediction.summary',
      description: 'The ledger as counts: how many expectations are live, expired, withdrawn, superseded or evaluated, the matched/contradicted counts with each rate named by its denominator, and why no confidence is available. Read-only.',
      inputHint: '{"capability":"optional exact capability","limit": optional 1-10 for the listed pending expectations}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['capability', 'limit']);
        const limit = o.limit === undefined ? 5 : limitValue(o.limit, { max: 10 });
        return { capability: capabilityFilter(o.capability), limit };
      },
      async execute(_ctx, { capability, limit }) {
        const { calibration, ledger } = await store.calibration({ capability });
        return {
          summary: `prediction ledger: ${calibration.totals.live} live expectation(s), ${calibration.totals.evaluated} evaluated (${calibration.totals.matched} matched, ${calibration.totals.contradicted} contradicted); ${calibration.matchRate.value === null ? 'no rate stated' : `rate ${calibration.matchRate.value} over ${calibration.matchRate.denominator}`}`,
          data: { capability, calibration: calibrationReadShape(calibration), pending: pendingShapes(ledger.projections, limit) },
          display: renderCalibration(calibration),
        };
      },
      async verify(_ctx, { capability, limit }, result) {
        const fresh = await store.calibration({ capability });
        const expected = calibrationReadShape(fresh.calibration);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.calibration)) {
          return { ok: false, detail: 'an independent read of the ledger produces different counts or a different rate' };
        }
        if (JSON.stringify(pendingShapes(fresh.ledger.projections, limit)) !== JSON.stringify(result.data.pending)) {
          return { ok: false, detail: 'an independent read lists different pending expectations' };
        }
        if (expected.confidence.available !== false) {
          return { ok: false, detail: 'the summary reports confidence as available; no method in this build supplies one' };
        }
        return { ok: true, detail: `${expected.records} ledger record(s) and the ${expected.evaluated} recorded evaluation(s) confirmed by an independent read` };
      },
    },
  ];
}

// The list read, with its filters applied to the projection rather than to the raw log: a status is
// derived, so it cannot be selected before it is derived, and a limit applied before filtering would
// report a bound view of the wrong records.
async function readList(store, { limit, capability, status }) {
  const { projections, ledger } = await store.list({ limit: MAX_PREDICTION_LIST });
  const filtered = projections.filter((item) => (capability === null || item.capability === capability)
    && (status === null || item.status === status));
  return {
    projections: filtered.slice(0, limit),
    total: ledger.projections.length,
    truncated: filtered.length > limit,
  };
}

// The pending expectations a summary names by id and state only. Sorted by horizon, which is the
// order a reader decides what to look at first, and never includes subject text: the summary is the
// shape a model context and an audit record both receive.
function pendingShapes(projections, limit) {
  return projections
    .filter((item) => !item.retired && item.invalidation === null
      && (item.status === 'recorded' || item.status === 'awaiting_evaluation' || item.status === 'expired'))
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      capability: item.capability,
      expectation: item.expectation,
      status: item.status,
      expiresAt: item.expiresAt,
      evidenceBasis: item.evidenceBasis,
    }));
}
