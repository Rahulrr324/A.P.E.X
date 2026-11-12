// Experience actions: the user-facing surface of the experience store, registered by the
// composition root alongside the memory and knowledge actions.
//
// The trust boundaries these actions exist to hold:
//  - an experience is evidence that something happened, not a permanent user fact;
//  - feedback is something only the user can say, so every feedback and decision write is
//    user-origin only, refused twice (here by the registry, again by the store);
//  - a candidate adaptation is derived by a deterministic rule from that feedback and is
//    unapproved until the user records a decision;
//  - an adaptation changes how APEX behaves, never what the user is allowed to ask for.
//
// Read actions see the whole record set: memory separates private records by origin, but an
// experience is a bounded pointer to an audited event and its feedback is the user's own words
// about APEX's behaviour, so neither has a private variant to hide from a model-origin read.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import {
  ADAPTATION_DECISIONS,
  ASSESSMENTS,
  GUIDANCE_ORDERS,
  MAX_GUIDANCE_NAMES,
  MAX_GUIDANCE_STEPS,
  MAX_REASON_CHARS,
  MAX_RULE_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_SUPERSEDES,
  MAX_SUPPORT_REFS,
  MAX_PREDICTION_CANDIDATES,
  CAPTURE_AUTOMATIC,
  captureOf,
} from '../experience/experience-store.js';
import { MIN_SUPPORT_FEEDBACK } from '../experience/derivation.js';
import { LONGITUDINAL_DERIVATION_METHOD, PREDICTION_DERIVATION_METHOD } from '../experience/prediction-derivation.js';
import {
  MAX_TEMPORAL_EVENTS,
  MAX_WINDOW_DAYS,
  checkTimeBound,
  comparisonAuditShape,
  patternsAuditShape,
  renderComparison,
  renderPatterns,
  renderTimeline,
  renderTrends,
  temporalAuditShape,
} from '../experience/temporal.js';

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

function optionalTextField(value, name, max) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
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

function refList(value, name, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list of record ids`);
  if (value.length > MAX_SUPERSEDES) throw new ValidationError(`${name} may name at most ${MAX_SUPERSEDES} records`);
  return value.map((entry) => recordRef(entry, name));
}

function limitValue(value, { name = 'limit', max = 50, fallback = 20 } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

// A window bound is passed through as text: the temporal engine is the one place that decides what
// a valid timestamp or calendar date is, so a request cannot be accepted with a bound the engine
// would then read differently. This only rejects text that cannot be a bound at all.
function timeBound(value, name, { end = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${name} must be an ISO 8601 timestamp or YYYY-MM-DD`);
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (text.length > 40) throw new ValidationError(`${name} is longer than 40 characters`);
  if (CONTROL_CHARS.test(text)) throw new ValidationError(`${name} contains control characters`);
  return checkTimeBound(text, { end, name });
}

function windowDays(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) {
    throw new ValidationError(`days must be an integer from 1 to ${MAX_WINDOW_DAYS}`);
  }
  return value;
}

function capabilityFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('capability must be text');
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > 128) throw new ValidationError('capability is longer than 128 characters');
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(text)) {
    throw new ValidationError('capability must be a name such as memory.add or filesystem');
  }
  return text;
}

function temporalQuery(o, names) {
  return {
    since: timeBound(o[names.since], names.since),
    until: timeBound(o[names.until], names.until, { end: true }),
    days: windowDays(o.days),
    capability: capabilityFilter(o.capability),
    limit: limitValue(o.limit, { max: MAX_TEMPORAL_EVENTS }),
  };
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

// ---- rendering ---------------------------------------------------------------

const ASSESSMENT_LABEL = Object.freeze({
  correct: 'correct',
  incorrect: 'incorrect',
  partially_correct: 'partially correct',
  useful: 'useful',
  not_useful: 'not useful',
  user_correction: 'user correction',
  outcome_succeeded: 'outcome succeeded',
  outcome_failed: 'outcome failed',
});

// A corrective assessment is the kind that can support a candidate rule, so a reader of a list
// needs to know which of the eight it was looking at.
const CORRECTIVE = new Set(['incorrect', 'not_useful', 'user_correction', 'outcome_failed']);

// A reader must be able to tell the two ways an experience exists: the user named the operation and
// asked for it, or APEX captured a verified outcome. Neither one is the user's judgement of it.
function captureLabel(r) {
  if (r.capture === 'automatic') return 'captured automatically';
  if (r.capture === 'explicit') return 'recorded by you';
  return 'provenance unknown';
}

function experienceLine(r) {
  const state = r.active ? '' : ' [corrected by a later record]';
  const feedback = r.feedbackTotal === 0
    ? 'no feedback'
    : `${r.feedbackCount} current feedback record(s)${r.feedbackCorrected > 0 ? `, ${r.feedbackCorrected} corrected` : ''}`;
  return `  [${shortId(r.id)}] ${r.capability ?? 'unscoped'} | outcome ${r.outcome ?? 'unknown'}${state}\n`
    + `      about: ${r.subject}\n`
    + `      audit: ${shortId(r.operationId)} | requested: ${String(r.requestedAt).slice(0, 19)} | ${feedback}`
    + ` | ${captureLabel(r)}${r.adaptationEligible ? '' : ' | not adaptation-eligible'}`;
}

function feedbackLine(f) {
  const guidance = f.guidance ? `\n      guidance: ${f.guidance}` : '';
  const reason = f.reason ? `\n      why: ${f.reason}` : '';
  return `  [${shortId(f.id)}] ${ASSESSMENT_LABEL[f.assessment] ?? f.assessment}`
    + `${CORRECTIVE.has(f.assessment) ? ' (corrective)' : ''}`
    + ` | ${f.provenance?.origin ?? 'unknown'}${f.superseded ? ' | corrected later' : ''}${guidance}${reason}`;
}

function adaptationLine(a) {
  const state = a.active ? 'active' : a.decisionState;
  const predictionDerived = a.source === 'prediction' || a.method === PREDICTION_DERIVATION_METHOD;
  const notes = [];
  if (a.decisionState === 'candidate') notes.push('not approved: no user decision recorded');
  if (a.decisionState === 'rejected') notes.push('the user rejected this candidate');
  if (a.decisionState === 'retired') notes.push('retired; excluded from future context');
  if (a.decisionState === 'ambiguous') notes.push('contradictory decisions: not applied');
  if (a.decisionState === 'approved' && !a.active) notes.push(a.inactiveReason ?? 'support no longer stands');
  if (a.conflicts.length > 0) {
    notes.push(`conflicts with ${a.conflicts.map((c) => `[${shortId(c.id)}]`).join(', ')} in the same scope`);
  }
  // The record's own provenance describes how the rule was produced, and it never changes, so it
  // is printed as derivation evidence. `decisionState` is what says whether the user approved it;
  // printing "candidate_unapproved" beside an approved rule would read as a contradiction.
  const derived = predictionDerived
    ? 'derived by deterministic derivation from an evaluated prediction'
      + (a.provenance.updateMode === 'candidate_unapproved' ? ' (a candidate until your decision)' : '')
    : `derived by ${a.provenance.origin === 'deterministic_derivation' ? 'deterministic derivation' : a.provenance.origin}`
      + (a.provenance.updateMode === 'candidate_unapproved' ? ' (a candidate until your decision)' : '');
  // A prediction-derived rule rests on one prediction and one evaluation, not on a group of experiences.
  // Printing "0 experience(s)" would read as missing evidence rather than as a different kind of evidence.
  const support = predictionDerived
    ? `${(a.support.predictionIds ?? []).length} prediction(s), ${(a.support.evaluationIds ?? []).length} evaluation(s)`
    : `${a.support.experienceIds.length} experience(s), ${a.support.feedbackIds.length} feedback record(s)`;
  return `  [${shortId(a.id)}] scope ${a.capability} | ${state}\n`
    + `      rule: ${a.rule}\n`
    + `      support: ${support} | ${derived}\n`
    + (notes.length > 0 ? `      ${notes.join('; ')}` : '      in effect for this scope');
}

// ---- actions -----------------------------------------------------------------

export function experienceActions(store) {
  if (!store || typeof store.recordExperience !== 'function') {
    throw new TypeError('experienceActions requires an experience store');
  }
  return [
    {
      name: 'experience.record',
      description: 'Record one audited operation as an experience: what APEX did and what outcome followed. The event itself stays in the audit log; this stores a verified reference to it. Write: user origin only.',
      inputHint: '{"operationId":"audit record id","subject":"short description of what happened","replaces":["optional experience ids this corrects"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model could name an operation and write its own account of what happened. An
      // experience is the user's record of an event, so it never enters a model plan.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['operationId', 'subject', 'replaces']);
        return {
          operationId: recordRef(o.operationId, 'operationId'),
          subject: textField(o.subject, 'subject', MAX_SUBJECT_CHARS),
          replaces: refList(o.replaces, 'replaces'),
        };
      },
      async execute(ctx, { operationId, subject, replaces }) {
        const { record, supersededIds } = await store.recordExperience({
          operationId,
          subject,
          replaces,
          capture: 'explicit',
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const correction = supersededIds.length > 0
          ? ` (corrects ${supersededIds.map(shortId).join(', ')})`
          : '';
        return {
          summary: `recorded experience ${shortId(record.id)} for operation ${shortId(record.operationId)}${correction}`,
          data: {
            id: record.id,
            operationId: record.operationId,
            capability: record.capability,
            subject: record.subject,
            outcome: record.outcome,
            decision: record.decision,
            requestedAt: record.requestedAt,
            finishedAt: record.finishedAt,
            adaptationEligible: record.adaptationEligible,
            evidenceSha256: record.evidenceSha256,
            replaces: [...(record.replaces ?? [])],
            supersededIds,
          },
          display: [
            `Recorded experience ${shortId(record.id)} as an account of operation ${shortId(record.operationId)}:`,
            `  scope: ${record.capability ?? 'not scopable'} | outcome: ${record.outcome ?? 'unknown'} | decision: ${record.decision ?? 'none'}`,
            `  subject: ${record.subject}`,
            `  evidence: ${String(record.evidenceSha256).slice(0, 16)} (recomputed from the audit record on every read)`,
            correction ? `  corrects: ${supersededIds.map(shortId).join(', ')} (the earlier record stays in the log)` : '  the earlier records are unchanged',
            'This is evidence that the event happened, not a permanent fact about the user.',
          ].join('\n'),
        };
      },
      async verify(ctx, { subject }, result) {
        const rec = await store.get(result.data.id);
        if (!rec) return { ok: false, detail: 'experience not found in the store after write' };
        if (rec.id !== result.data.id) return { ok: false, detail: 'stored experience id differs from the write result' };
        if (rec.operationId !== result.data.operationId) return { ok: false, detail: 'stored operation reference differs from the write result' };
        if (rec.subject !== subject) return { ok: false, detail: 'stored subject differs from the request' };
        if (rec.provenance?.origin !== 'user_recorded' || rec.provenance?.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'stored provenance is not a user-recorded confirmation' };
        }
        // The independent check: re-read the audit record and recompute the evidence from it.
        const check = await store.evidenceCheck(result.data.id);
        if (!check?.ok) return { ok: false, detail: check?.detail ?? 'evidence could not be verified against the audit log' };
        for (const targetId of result.data.supersededIds) {
          const replaced = await store.get(targetId);
          if (!replaced) return { ok: false, detail: `corrected experience ${shortId(targetId)} is no longer in the store` };
          if (replaced.active) return { ok: false, detail: `experience ${shortId(targetId)} is still reported as standing` };
        }
        return { ok: true, detail: `experience present; ${check.detail}; append-only history preserved` };
      },
    },

    {
      name: 'experience.list',
      description: 'List recent recorded experiences with their outcome, feedback counts, and correction state. Read-only.',
      inputHint: '{"limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: limitValue(o.limit) };
      },
      async execute(_ctx, { limit }) {
        const records = await store.list({ limit });
        return {
          summary: `${records.length} experience record(s) listed`,
          data: { limit, records },
          display: `${records.length} recorded experience(s), newest first:\n${records.map(experienceLine).join('\n') || '  (none recorded)'}`,
        };
      },
      async verify(_ctx, { limit }, result) {
        const fresh = await store.list({ limit });
        if (fresh.length !== result.data.records.length) {
          return { ok: false, detail: `listed ${result.data.records.length}; an independent read gives ${fresh.length}` };
        }
        if (fresh.some((r, i) => r.id !== result.data.records[i].id)) {
          return { ok: false, detail: 'listed ids differ from an independent store read' };
        }
        return { ok: true, detail: `${fresh.length} experience(s) confirmed against the store` };
      },
    },

    {
      name: 'experience.show',
      description: 'Show one recorded experience with its evidence and its full feedback history. Read-only.',
      inputHint: '{"target":"experience or operation id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async execute(_ctx, { target }) {
        const view = await store.feedbackFor(target);
        if (!view) {
          return {
            summary: `no recorded experience matches ${target}`,
            data: { found: false, target },
            display: `No recorded experience matches "${target}". An experience must be recorded first (experience record), and only audited operations can be recorded.`,
          };
        }
        const r = view.experience;
        return {
          summary: `showed experience ${shortId(r.id)} with ${view.history.length} feedback record(s)`,
          data: { found: true, ...view },
          display: [
            experienceLine(r),
            `  replaces: ${r.replaces.map(shortId).join(', ') || 'none'} | replaced by: ${r.replacedBy.map(shortId).join(', ') || 'none'}`,
            view.history.length === 0
              ? '  feedback: none recorded; silence is never an assessment'
              : `  feedback (${view.current.length} current, ${view.history.length - view.current.length} corrected):`,
            ...view.history.map(feedbackLine),
            view.truncated ? '  (older feedback omitted by the bound)' : null,
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { target }, result) {
        const fresh = await store.feedbackFor(target);
        if (Boolean(fresh) !== result.data.found) return { ok: false, detail: 'an independent read disagrees about whether the experience exists' };
        if (!fresh) return { ok: true, detail: 'absence confirmed by an independent read' };
        if (fresh.experience.id !== result.data.experience.id) return { ok: false, detail: 'an independent read resolves the reference to a different experience' };
        if (fresh.history.length !== result.data.history.length) {
          return { ok: false, detail: `showed ${result.data.history.length} feedback record(s); an independent read gives ${fresh.history.length}` };
        }
        if (fresh.history.some((f, i) => f.id !== result.data.history[i].id)) {
          return { ok: false, detail: 'feedback history differs from an independent read' };
        }
        return { ok: true, detail: `experience and ${fresh.history.length} feedback record(s) confirmed against the store` };
      },
    },

    {
      name: 'feedback.record',
      description: 'Record the user\'s own assessment of one recorded experience, optionally with the guidance APEX should follow next time. Previous feedback is kept as history. Write: user origin only.',
      inputHint: '{"target":"experience or operation id","assessment":"correct|incorrect|partially_correct|useful|not_useful|user_correction|outcome_succeeded|outcome_failed","guidance":"optional text","reason":"optional text","supersedes":["optional feedback ids this corrects"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // The whole point of the boundary: model-authored text must not be recorded as the user's
      // assessment, and feedback is the only route by which a rule can reach a candidate.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'assessment', 'guidance', 'reason', 'supersedes']);
        if (typeof o.assessment !== 'string' || !ASSESSMENTS.includes(o.assessment.trim())) {
          throw new ValidationError(`assessment must be one of: ${ASSESSMENTS.join(', ')}`);
        }
        return {
          target: recordRef(o.target, 'target'),
          assessment: o.assessment.trim(),
          guidance: optionalTextField(o.guidance, 'guidance', MAX_RULE_CHARS),
          reason: optionalTextField(o.reason, 'reason', MAX_REASON_CHARS),
          supersedes: refList(o.supersedes, 'supersedes'),
        };
      },
      async execute(ctx, { target, assessment, guidance, reason, supersedes }) {
        const { record, experience, supersededIds } = await store.recordFeedback({
          target,
          assessment,
          guidance,
          reason,
          supersedes,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const correction = supersededIds.length > 0
          ? ` (corrects ${supersededIds.map(shortId).join(', ')})`
          : '';
        return {
          summary: `recorded user feedback ${shortId(record.id)} on experience ${shortId(experience.id)}${correction}`,
          data: {
            id: record.id,
            experienceId: experience.id,
            operationId: experience.operationId,
            capability: experience.capability,
            assessment: record.assessment,
            guidance: record.guidance ?? null,
            reason: record.reason ?? null,
            supersedes: [...(record.supersedes ?? [])],
            supersededIds,
          },
          display: [
            `Recorded your feedback ${shortId(record.id)} on experience ${shortId(experience.id)} (operation ${shortId(experience.operationId)}):`,
            `  assessment: ${ASSESSMENT_LABEL[record.assessment]}${CORRECTIVE.has(record.assessment) ? ' (corrective: it can support a candidate adaptation)' : ' (not corrective)'}`,
            `  guidance: ${record.guidance ?? 'none given'}`,
            `  reason: ${record.reason ?? 'not given'}`,
            correction ? `  corrects: ${supersededIds.map(shortId).join(', ')} (the earlier feedback stays in the log)` : '  earlier feedback on this experience is unchanged',
            // The event and the judgement are different records. When the event was one APEX
            // observed on its own, the display must say so, because the outcome line above the
            // user is about a verified execution and not about their opinion. The record read back
            // from the log carries only its provenance, so the route is derived the same way every
            // other reader derives it.
            captureOf(experience) === CAPTURE_AUTOMATIC
              ? '  note: this experience was captured automatically from a verified outcome; APEX recorded no assessment of it, and this feedback is yours alone.'
              : null,
            'Recording feedback changes nothing about your future requests. A behaviour change needs a candidate, and a candidate needs your explicit approval.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(ctx, { assessment, guidance }, result) {
        const view = await store.feedbackFor(result.data.experienceId);
        if (!view) return { ok: false, detail: 'the experience this feedback was recorded on cannot be read back' };
        const entry = view.current.find((f) => f.id === result.data.id);
        if (!entry) return { ok: false, detail: 'feedback not found among the current records of that experience' };
        if (entry.assessment !== assessment) return { ok: false, detail: 'stored assessment differs from the request' };
        if ((entry.guidance ?? null) !== (guidance ?? null)) return { ok: false, detail: 'stored guidance differs from the request' };
        if (entry.provenance?.origin !== 'user_feedback' || entry.provenance?.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'stored feedback provenance is not the user\'s own' };
        }
        if (entry.operationId !== ctx.operationId) return { ok: false, detail: 'stored feedback does not name the operation that recorded it' };
        // Append-only: corrected feedback is still readable, just no longer current.
        for (const targetId of result.data.supersededIds) {
          if (!view.history.some((f) => f.id === targetId)) {
            return { ok: false, detail: `corrected feedback ${shortId(targetId)} is no longer readable` };
          }
          if (view.current.some((f) => f.id === targetId)) {
            return { ok: false, detail: `feedback ${shortId(targetId)} is still reported current` };
          }
        }
        return {
          ok: true,
          detail: `feedback present as the user's own; ${view.history.length} record(s) readable on this experience`,
        };
      },
    },

    {
      name: 'adaptation.derive',
      description: 'Derive candidate adaptations from recorded experiences, the user\'s corrective feedback, and completed evaluations of recorded predictions. Deterministic and bounded: a candidate is unapproved until the user decides. Write: user origin only.',
      inputHint: '{"minSupport": optional integer 1-20}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // Derivation appends records. A model that could trigger it could fill the store with
      // candidates shaped from the user's own feedback without the user asking for that.
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['minSupport']);
        const minSupport = o.minSupport === undefined ? MIN_SUPPORT_FEEDBACK : o.minSupport;
        if (!Number.isInteger(minSupport) || minSupport < 1 || minSupport > MAX_SUPPORT_REFS) {
          throw new ValidationError(`minSupport must be an integer from 1 to ${MAX_SUPPORT_REFS}`);
        }
        return { minSupport };
      },
      async execute(ctx, { minSupport }) {
        const { created, skipped, prediction } = await store.deriveAdaptations({
          minSupport,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        return {
          summary: created.length === 0
            ? `no new candidate adaptation (${skipped.length} supporting group(s) already recorded or too small)`
            : `derived ${created.length} candidate adaptation(s); ${skipped.length} group(s) skipped`,
          data: {
            created: created.map((r) => ({
              id: r.id,
              capability: r.capability,
              rule: r.rule,
              method: r.method,
              support: r.support,
            })),
            skipped,
            minSupport,
            // The prediction-ledger read that ran beside the feedback derivation, reported even when it
            // found nothing: "no evaluated prediction was eligible" and "the ledger could not be read" are
            // different facts, and only the report can tell them apart.
            prediction: prediction ?? null,
          },
          display: [
            created.length === 0
              ? 'No new candidate adaptation.'
              : `Derived ${created.length} candidate(s) from the recorded evidence:`,
            ...created.map((r) => (r.method === LONGITUDINAL_DERIVATION_METHOD
              ? `  [${shortId(r.id)}] scope ${r.capability} | rule: ${r.rule}\n      pattern: ${r.proposal?.pattern?.kind ?? '-'} over ${(r.support.predictionIds ?? []).length} observation(s) | predictions: ${(r.support.predictionIds ?? []).join(', ')} | NOT APPROVED`
              : r.method === PREDICTION_DERIVATION_METHOD
                ? `  [${shortId(r.id)}] scope ${r.capability} | rule: ${r.rule}\n      prediction: ${(r.support.predictionIds ?? []).join(', ')} | evaluation: ${(r.support.evaluationIds ?? []).join(', ')} | single observation, NOT APPROVED`
                : `  [${shortId(r.id)}] scope ${r.capability} | rule: ${r.rule}\n      support: ${r.support.experienceIds.length} experience(s) | NOT APPROVED`)),
            skipped.length === 0 ? null : `Skipped: ${skipped.map((s) => `${s.capability}: ${s.reason}`).join('; ')}`,
            prediction && prediction.considered > 0
              ? `Predictions: ${prediction.considered} evaluated record(s) read, ${prediction.eligible} eligible, ${prediction.created} candidate(s) added${prediction.truncated ? '; the read was bounded and more remain' : ''}.`
              : null,
            prediction?.longitudinal && prediction.longitudinal.supported > 0
              ? `Longitudinal: ${prediction.longitudinal.supported} scope(s) hold a supported pattern; ${prediction.longitudinal.created} candidate(s) added, ${prediction.longitudinal.skipped.length} not derived - a pattern is an association in recorded order, not a cause and not a forecast.`
              : null,
            // A prediction-derived candidate rests on recorded evaluations, so the feedback wording would
            // be false for it; the feedback-only path keeps its exact AP-01 sentence.
            created.some((r) => r.method === PREDICTION_DERIVATION_METHOD || r.method === LONGITUDINAL_DERIVATION_METHOD)
              ? 'A candidate is a bounded restatement of recorded evidence, never an instruction. Nothing takes effect until you approve it.'
              : 'A candidate is evidence that you asked for the same thing more than once. Nothing takes effect until you approve it.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { minSupport }, result) {
        for (const created of result.data.created) {
          const detail = await store.adaptationDetail(created.id);
          if (!detail) return { ok: false, detail: `candidate ${shortId(created.id)} is not in the store after derivation` };
          if (detail.decisionState !== 'candidate') {
            return { ok: false, detail: `candidate ${shortId(created.id)} is reported ${detail.decisionState}, not unapproved` };
          }
          if (detail.active) return { ok: false, detail: `candidate ${shortId(created.id)} is active without a user decision` };
          if (detail.provenance?.origin !== 'deterministic_derivation' || detail.provenance?.updateMode !== 'candidate_unapproved') {
            return { ok: false, detail: `candidate ${shortId(created.id)} provenance is not deterministic derivation` };
          }
          // A prediction-derived candidate rests on recorded evaluations by construction, so the
          // requested feedback threshold does not apply to it. A single-observation candidate cites
          // exactly one prediction and one evaluation; a longitudinal one cites as many pairs as its
          // pattern counts, and never fewer than two.
          if (detail.method === PREDICTION_DERIVATION_METHOD) {
            if (detail.minSupport !== 1) {
              return { ok: false, detail: `prediction-derived candidate ${shortId(created.id)} was stored with a different support threshold` };
            }
            if ((detail.support.predictionIds ?? []).length !== 1 || (detail.support.evaluationIds ?? []).length !== 1) {
              return { ok: false, detail: `prediction-derived candidate ${shortId(created.id)} does not cite exactly one prediction and one evaluation` };
            }
          } else if (detail.method === LONGITUDINAL_DERIVATION_METHOD) {
            const cited = (detail.support.predictionIds ?? []).length;
            if (cited < 2 || cited > 20) {
              return { ok: false, detail: `longitudinal candidate ${shortId(created.id)} does not cite between two and twenty observations` };
            }
            if ((detail.support.evaluationIds ?? []).length !== cited) {
              return { ok: false, detail: `longitudinal candidate ${shortId(created.id)} does not cite one evaluation per observation` };
            }
            if (detail.minSupport !== cited || detail.proposal?.pattern?.observations !== cited) {
              return { ok: false, detail: `longitudinal candidate ${shortId(created.id)} does not state the observation count its evidence supports` };
            }
          } else if (detail.minSupport !== minSupport) {
            return { ok: false, detail: `candidate ${shortId(created.id)} was stored with a different support threshold` };
          }
          if (detail.support.experienceIds.length !== created.support.experienceIds.length) {
            return { ok: false, detail: `candidate ${shortId(created.id)} support differs from the derivation result` };
          }
          if ((detail.support.predictionIds ?? []).length !== (created.support.predictionIds ?? []).length
            || (detail.support.evaluationIds ?? []).length !== (created.support.evaluationIds ?? []).length) {
            return { ok: false, detail: `candidate ${shortId(created.id)} prediction support differs from the derivation result` };
          }
        }
        const active = await store.activeAdaptations({ limit: MAX_SUPPORT_REFS });
        const invented = result.data.created.filter((c) => active.adaptations.some((a) => a.id === c.id));
        if (invented.length > 0) {
          return { ok: false, detail: `a just-derived candidate is already in the active set: ${shortId(invented[0].id)}` };
        }
        return {
          ok: true,
          detail: `${result.data.created.length} candidate(s) present and unapproved; ${skippedPhrase(result.data.skipped)}`,
        };
      },
    },

    {
      name: 'adaptation.decide',
      description: 'Record the user\'s decision on one candidate adaptation: approved or rejected. Only an approved, unretired adaptation with intact support can affect future context. Write: user origin only.',
      inputHint: '{"target":"adaptation id","decision":"approved|rejected","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // This is the approval gate itself. Model origin is refused by the registry, and the store
      // refuses a non-user origin again, so a candidate cannot approve itself.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'decision', 'reason']);
        if (typeof o.decision !== 'string' || !ADAPTATION_DECISIONS.includes(o.decision.trim())) {
          throw new ValidationError('decision must be approved or rejected');
        }
        return {
          target: recordRef(o.target, 'target'),
          decision: o.decision.trim(),
          reason: optionalTextField(o.reason, 'reason', MAX_REASON_CHARS),
        };
      },
      async execute(ctx, { target, decision, reason }) {
        const { record, adaptation, previous } = await store.decideAdaptation({
          target,
          decision,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const changed = previous ? ` (this replaces an earlier ${previous.decision} decision, which stays in the log)` : '';
        return {
          summary: `recorded user decision ${shortId(record.id)}: ${decision} for adaptation ${shortId(adaptation.id)}${changed}`,
          data: {
            decisionId: record.id,
            adaptationId: adaptation.id,
            capability: adaptation.capability,
            rule: adaptation.rule,
            decision,
            reason: record.reason ?? null,
            previousDecision: previous ? { id: previous.id, decision: previous.decision } : null,
          },
          display: [
            `Recorded your decision ${shortId(record.id)} on adaptation ${shortId(adaptation.id)}: ${decision}.`,
            `  scope: ${adaptation.capability} | rule: ${adaptation.rule}`,
            adaptation.method === PREDICTION_DERIVATION_METHOD
              ? `  support: ${(adaptation.support.predictionIds ?? []).length} prediction(s), ${(adaptation.support.evaluationIds ?? []).length} evaluation(s)`
              : `  support: ${adaptation.support.experienceIds.length} recorded experience(s)`,
            changed ? `  earlier decision: ${previous.decision} (${shortId(previous.id)}) kept as history` : '  this is the first decision on this candidate',
            decision === 'approved'
              ? 'This now applies to future requests in this scope, within the bounded context. It grants no permission: an approved rule never authorizes an action.'
              : 'This candidate will not change anything. It stays in the log as the record that you declined it.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { decision, reason }, result) {
        const detail = await store.adaptationDetail(result.data.adaptationId);
        if (!detail) return { ok: false, detail: 'the decided adaptation cannot be read back' };
        const latest = detail.decisions.at(-1);
        if (!latest || latest.id !== result.data.decisionId) {
          return { ok: false, detail: 'the recorded decision is not the latest decision on that adaptation' };
        }
        if (detail.decisionState !== decision) {
          return { ok: false, detail: `adaptation state is ${detail.decisionState}, not ${decision}` };
        }
        if (detail.rule !== result.data.rule || detail.capability !== result.data.capability) {
          return { ok: false, detail: 'the decision changed the candidate itself; the rule and scope must stay as derived' };
        }
        if ((latest.reason ?? null) !== (reason ?? null)) {
          return { ok: false, detail: 'stored decision reason differs from the request' };
        }
        // An approved prediction-derived rule is active only while the prediction it cites still stands;
        // approval is preserved, but the ledger can withdraw the evidence underneath it. The store derives
        // that currentness, so verification reads it rather than assuming approval alone is sufficient.
        const ledgerCurrent = detail.predictionEvidence == null || detail.predictionEvidence.eligible === true;
        const shouldBeActive = decision === 'approved' && detail.supportState === 'intact' && ledgerCurrent;
        if (detail.active !== shouldBeActive) {
          return { ok: false, detail: `active state ${detail.active} does not follow from the decision, the support, and the prediction evidence` };
        }
        if (decision === 'approved' && !shouldBeActive) {
          return { ok: true, detail: `decision recorded; the rule is not applied because ${detail.inactiveReason ?? 'its evidence no longer stands'}` };
        }
        const active = await store.activeAdaptations({ capability: detail.capability, limit: MAX_SUPPORT_REFS });
        if (decision === 'approved' && !active.adaptations.some((a) => a.id === detail.id)) {
          return { ok: false, detail: 'an approved adaptation with intact support is not retrievable for its scope' };
        }
        if (decision === 'rejected' && active.adaptations.some((a) => a.id === detail.id)) {
          return { ok: false, detail: 'a rejected adaptation is still being retrieved as active' };
        }
        return { ok: true, detail: `decision confirmed as the user's own; ${detail.decisions.length} decision(s) readable` };
      },
    },

    {
      name: 'adaptation.guide',
      description: 'Record the shape the user gave one adaptation: which step order they ask for, which capabilities to avoid or prefer, and how many steps is too many. Only an approved, unretired adaptation whose support stands can move a comparison, and nothing here authorizes, refuses, or starts any work. Write: user origin only.',
      inputHint: '{"target":"adaptation id","order":"reads_first|writes_first","avoid":["capability"],"prefer":["capability"],"maxSteps":"optional integer","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // The record that lets guidance count in a comparison has to be the user's own act, or an approval
      // would be enough to let APEX reshape future work by inference. The registry refuses a model
      // origin, and the store refuses a non-user origin again.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'order', 'avoid', 'prefer', 'maxSteps', 'reason']);
        if (o.order !== undefined && o.order !== null && !GUIDANCE_ORDERS.includes(String(o.order).trim())) {
          throw new ValidationError(`order must be one of: ${GUIDANCE_ORDERS.join(', ')}`);
        }
        const list = (value, label) => {
          if (value === undefined || value === null) return [];
          if (!Array.isArray(value) || value.length > MAX_GUIDANCE_NAMES) {
            throw new ValidationError(`${label} must be a list of at most ${MAX_GUIDANCE_NAMES} capability names`);
          }
          return value.map((name) => textField(name, `a name in ${label}`, 64));
        };
        const avoid = list(o.avoid, 'avoid');
        const prefer = list(o.prefer, 'prefer');
        let maxSteps = null;
        if (o.maxSteps !== undefined && o.maxSteps !== null) {
          maxSteps = Number(o.maxSteps);
          if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_GUIDANCE_STEPS) {
            throw new ValidationError(`maxSteps must be an integer from 1 to ${MAX_GUIDANCE_STEPS}`);
          }
        }
        if ((o.order ?? null) === null && avoid.length === 0 && prefer.length === 0 && maxSteps === null) {
          throw new ValidationError('name at least one shape: an order, a capability to avoid or prefer, or a step bound');
        }
        return {
          target: recordRef(o.target, 'target'),
          order: o.order ?? null,
          avoid,
          prefer,
          maxSteps,
          reason: optionalTextField(o.reason, 'reason', MAX_REASON_CHARS),
        };
      },
      async execute(ctx, { target, order, avoid, prefer, maxSteps, reason }) {
        // A name the registry does not hold could never match a step, so the guidance would silently
        // ask for something no plan can answer: refused, with the names listed, as `cannot_use` does.
        const registry = ctx?.registry ?? null;
        if (registry && typeof registry.get === 'function') {
          const unknown = [...new Set([...avoid, ...prefer])].filter((name) => !registry.get(name));
          if (unknown.length > 0) {
            throw new ValidationError(`avoid and prefer must name registered capabilities; not found: ${unknown.join(', ')}`);
          }
        }
        const { record, adaptation, previous } = await store.guideAdaptation({
          target,
          order,
          avoid,
          prefer,
          maxSteps,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const shape = [
          order ? `order ${order}` : null,
          avoid.length ? `avoid ${avoid.join(', ')}` : null,
          prefer.length ? `prefer ${prefer.join(', ')}` : null,
          maxSteps !== null ? `at most ${maxSteps} step(s)` : null,
        ].filter(Boolean).join(', ');
        const decided = adaptation.decisionState;
        return {
          summary: `recorded guidance shape ${shortId(record.id)} for adaptation ${shortId(adaptation.id)}: ${shape}`,
          data: {
            guidanceId: record.id,
            adaptationId: adaptation.id,
            capability: adaptation.capability,
            rule: adaptation.rule,
            order,
            avoid,
            prefer,
            maxSteps,
            reason: record.reason ?? null,
            decisionState: decided,
            active: adaptation.active === true,
            previous: previous ? { id: previous.id, order: previous.order ?? null } : null,
          },
          display: [
            `Recorded your guidance ${shortId(record.id)} on adaptation ${shortId(adaptation.id)}: ${shape}.`,
            `  scope: ${adaptation.capability} | rule: ${adaptation.rule}`,
            previous ? `  earlier shape: ${previous.order ?? 'none'} (${shortId(previous.id)}) kept as history` : '  this is the first shape recorded on this candidate',
            decided === 'approved' && adaptation.active === true
              ? '  This can now move an approach in a comparison of candidates for this scope, as recorded guidance. It grants nothing: a step is still authorized when it runs, and a plan is still approved by you.'
              : `  It changes nothing yet, because the adaptation it belongs to is ${decided === 'approved' ? 'no longer standing as approved evidence' : decided}: a shape recorded on a candidate the user never approved stays inert.`,
          ].join('\n'),
        };
      },
      async verify(ctx, { order, avoid, prefer, maxSteps }, result) {
        const detail = await store.adaptationDetail(result.data.adaptationId);
        if (!detail) return { ok: false, detail: 'the guided adaptation cannot be read back' };
        const latest = (detail.guidanceHistory ?? []).at(-1);
        if (!latest || latest.id !== result.data.guidanceId) {
          return { ok: false, detail: 'the recorded guidance is not the latest shape on that adaptation' };
        }
        if ((latest.order ?? null) !== (order ?? null)
          || (latest.avoid ?? []).join(',') !== avoid.join(',')
          || (latest.prefer ?? []).join(',') !== prefer.join(',')
          || (latest.maxSteps ?? null) !== (maxSteps ?? null)) {
          return { ok: false, detail: 'the shape read back differs from the shape recorded' };
        }
        if (detail.rule !== result.data.rule || detail.capability !== result.data.capability) {
          return { ok: false, detail: 'the guidance changed the candidate itself; the rule and scope stay as derived' };
        }
        if (result.data.decisionState === 'approved' && detail.active !== true) {
          return { ok: true, detail: `shape recorded; it moves nothing because ${detail.inactiveReason ?? 'its support no longer stands as recorded'}` };
        }
        return { ok: true, detail: `shape confirmed as the user's own; ${(detail.guidanceHistory ?? []).length} shape(s) readable` };
      },
    },

    {
      name: 'adaptation.retire',
      description: 'End one adaptation explicitly. The candidate, the decision, and the supporting evidence all stay in the log; only the active state changes. Write: user origin only.',
      inputHint: '{"target":"adaptation id","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          reason: optionalTextField(o.reason, 'reason', MAX_REASON_CHARS),
        };
      },
      async execute(ctx, { target, reason }) {
        const { record, adaptation } = await store.retireAdaptation({
          target,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        return {
          summary: `retired adaptation ${shortId(adaptation.id)}; its evidence and decision history preserved`,
          data: {
            retirementId: record.id,
            adaptationId: adaptation.id,
            capability: adaptation.capability,
            rule: adaptation.rule,
            reason: record.reason ?? null,
            decisionStateBefore: adaptation.decisionState,
          },
          display: [
            `Retired adaptation ${shortId(adaptation.id)}: ${adaptation.capability} | ${adaptation.rule}`,
            `  it was ${adaptation.decisionState} before this retirement${record.reason ? `; reason recorded` : ''}`,
            '  the candidate, your decision, and the supporting experiences remain in the log and are still readable',
            'It no longer contributes to future context. Nothing else about your history changed.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { reason }, result) {
        const detail = await store.adaptationDetail(result.data.adaptationId);
        if (!detail) return { ok: false, detail: 'the retired adaptation cannot be read back' };
        if (detail.decisionState !== 'retired') return { ok: false, detail: `adaptation is reported ${detail.decisionState}, not retired` };
        if (detail.active) return { ok: false, detail: 'a retired adaptation is still reported active' };
        if (detail.retirement?.id !== result.data.retirementId) {
          return { ok: false, detail: 'stored retirement event differs from the write result' };
        }
        if ((detail.retirement?.reason ?? null) !== (reason ?? null)) {
          return { ok: false, detail: 'stored retirement reason differs from the request' };
        }
        if (detail.rule !== result.data.rule || detail.capability !== result.data.capability) {
          return { ok: false, detail: 'the retirement altered the adaptation itself' };
        }
        if (detail.support.experienceIds.length === 0) {
          return { ok: false, detail: 'the supporting evidence is no longer recorded on the adaptation' };
        }
        const active = await store.activeAdaptations({ capability: detail.capability, limit: MAX_SUPPORT_REFS });
        if (active.adaptations.some((a) => a.id === detail.id)) {
          return { ok: false, detail: 'a retired adaptation is still being retrieved for future context' };
        }
        return { ok: true, detail: 'retirement confirmed; rule, decision, and supporting evidence preserved and excluded from active retrieval' };
      },
    },

    {
      name: 'adaptation.list',
      description: 'List derived adaptations with their state: candidate, approved, rejected, retired, or ambiguous, plus intact or stale support. Read-only.',
      inputHint: '{"limit": optional 1-50, "includeRetired": optional true|false}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit', 'includeRetired']);
        if (o.includeRetired !== undefined && typeof o.includeRetired !== 'boolean') {
          throw new ValidationError('includeRetired must be true or false');
        }
        return { limit: limitValue(o.limit), includeRetired: o.includeRetired ?? true };
      },
      async execute(_ctx, { limit, includeRetired }) {
        const records = await store.adaptations({ limit, includeRetired });
        const active = records.filter((a) => a.active).length;
        return {
          summary: `${records.length} adaptation record(s) listed; ${active} active`,
          data: { limit, includeRetired, records },
          display: [
            `${records.length} adaptation record(s), newest first (${active} in effect):`,
            records.map(adaptationLine).join('\n') || '  (none derived yet)',
            'Only an approved adaptation whose support still stands is retrieved into future context.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { limit, includeRetired }, result) {
        const fresh = await store.adaptations({ limit, includeRetired });
        if (fresh.length !== result.data.records.length) {
          return { ok: false, detail: `listed ${result.data.records.length}; an independent read gives ${fresh.length}` };
        }
        if (fresh.some((a, i) => a.id !== result.data.records[i].id || a.decisionState !== result.data.records[i].decisionState)) {
          return { ok: false, detail: 'listed adaptations or their states differ from an independent store read' };
        }
        return { ok: true, detail: `${fresh.length} adaptation(s) and their states confirmed against the store` };
      },
    },
    {
      name: 'adaptation.eligibility',
      description: 'Inspect which recorded predictions carry a completed evaluation that could become a candidate adaptation, and why the others cannot. Read-only; nothing is derived, approved, or applied.',
      inputHint: '{"capability":"optional capability name","limit":"optional 1-20"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // A user-facing question about their own prediction ledger. It is not offered as a step a model
      // plan may use: no plan becomes better by naming this read, and the transition from evidence to
      // candidate is the user's act through `adaptation.derive`.
      plannable: false,
      // Read-only and derived: this answers "what could be proposed and why is the rest inert". It
      // deliberately stops before derivation, because the transition from evidence to candidate is the
      // user's act, not a read.
      validate(input) {
        const o = expectObject(input ?? {}, ['capability', 'limit']);
        const capability = o.capability === undefined || o.capability === null
          ? null
          : textField(o.capability, 'capability', 64);
        return {
          capability,
          limit: limitValue(o.limit, { max: MAX_PREDICTION_CANDIDATES, fallback: MAX_PREDICTION_CANDIDATES }),
        };
      },
      async execute(_ctx, { capability, limit }) {
        const report = await store.predictionEligibilityReport({ capability, limit });
        const eligible = report.considered.filter((p) => p.eligible).length;
        return {
          summary: report.available
            ? `prediction eligibility: ${report.considered.length} of ${report.total} projected record(s) inspected; ${eligible} eligible`
            : 'prediction eligibility could not be read',
          data: { capability, limit, report },
          display: [
            report.available
              ? `Prediction eligibility (${report.considered.length} of ${report.total} projected, limit ${report.limit}${report.truncated ? ', truncated' : ''}):`
              : `Prediction eligibility unavailable: ${report.reason}`,
            ...report.considered.map((p) => {
              const proposed = p.proposal
                ? `\n      proposed rule: ${p.proposal.guidance.prefer.length ? `prefer ${p.proposal.guidance.prefer.join(', ')}` : `avoid ${p.proposal.guidance.avoid.join(', ')}`}`
                : '';
              return `  [${shortId(p.predictionId)}] ${p.capability ?? '-'} | ${p.status} | verdict ${p.verdict ?? '-'} | ${p.eligible ? 'ELIGIBLE' : `not eligible: ${p.state}`}\n`
                + `      ${singleLine(p.subject ?? '', 200)}`
                + (p.reason ? `\n      why: ${p.reason}` : '')
                + proposed
                + (p.alreadyCandidate ? '\n      a candidate already records this prediction' : '');
            }),
            report.available && report.considered.length === 0 ? '  (none recorded for this scope)' : null,
            'An eligible prediction is only a candidate for your approval. Nothing here was derived, approved, or applied; run adaptation.derive and then decide explicitly.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { capability, limit }, result) {
        const fresh = await store.predictionEligibilityReport({ capability, limit });
        if (fresh.available !== result.data.report.available) {
          return { ok: false, detail: 'the prediction ledger became readable, or unreadable, between two reads' };
        }
        const before = result.data.report.considered.map((p) => [p.predictionId, p.eligible, p.state, p.evaluationId]);
        const after = fresh.considered.map((p) => [p.predictionId, p.eligible, p.state, p.evaluationId]);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          return { ok: false, detail: 'the prediction ledger changed between two reads of the same eligibility question' };
        }
        return { ok: true, detail: `${fresh.considered.length} prediction record(s) confirmed against an independent read; nothing was derived` };
      },
    },
    {
      name: 'experience.timeline',
      description: 'Ordered, time-filtered view of recorded experiences: when each occurred, its recorded outcome, capture route, feedback counts, and correction state. Read-only; derives everything from the stored log and calls no model.',
      inputHint: '{"since":"optional ISO 8601 or YYYY-MM-DD","until":"optional ISO 8601 or YYYY-MM-DD","days":"optional 1-3650","capability":"optional exact capability","limit":"optional 1-50"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['since', 'until', 'days', 'capability', 'limit']);
        return temporalQuery(o, { since: 'since', until: 'until' });
      },
      async execute(_ctx, query) {
        const analysis = await store.temporalAnalysis(query);
        const { view } = analysis;
        return {
          summary: `experience timeline: ${view.counts.inWindow} dated event(s) in ${view.window.since}..${view.window.until}, ${view.counts.undated} undated, ${view.counts.superseded} corrected`,
          data: { query, view: temporalAuditShape(view), adaptations: analysis.adaptations },
          display: renderTimeline(view),
        };
      },
      async verify(_ctx, query, result) {
        // The default window ends at "now", which advances between the two reads. The second
        // read re-uses the first read's resolved bounds, so it compares the same window rather
        // than reporting a false change from a few milliseconds of clock drift.
        const { since, until } = result.data.view.window;
        const fresh = await store.temporalAnalysis({ ...query, since, until });
        const expected = temporalAuditShape(fresh.view);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.view)) {
          return { ok: false, detail: 'a second read produced a different timeline; the experience store changed during the read' };
        }
        return { ok: true, detail: `window bounds, ${fresh.view.counts.inWindow} dated event id(s), and ${fresh.view.counts.undated} undated record(s) confirmed by an independent read` };
      },
    },

    {
      name: 'experience.trends',
      description: 'Per-capability outcome counts, success rate, first/last occurrence, and an early/late trend for the window. Read-only; a trend is a description of recorded order, not a cause or a prediction.',
      inputHint: '{"since":"optional ISO 8601 or YYYY-MM-DD","until":"optional ISO 8601 or YYYY-MM-DD","days":"optional 1-3650","capability":"optional exact capability","limit":"optional 1-50"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['since', 'until', 'days', 'capability', 'limit']);
        return temporalQuery(o, { since: 'since', until: 'until' });
      },
      async execute(_ctx, query) {
        const analysis = await store.temporalAnalysis(query);
        const { view } = analysis;
        const leading = view.byCapability[0];
        return {
          summary: leading
            ? `experience trends: ${view.byCapability.length} capability group(s) in the window; ${leading.capability} has ${leading.total} event(s), trend ${leading.trend}`
            : 'experience trends: no dated experience falls inside the window',
          data: { query, view: temporalAuditShape(view) },
          display: renderTrends(view),
        };
      },
      async verify(_ctx, query, result) {
        const { since, until } = result.data.view.window;
        const fresh = await store.temporalAnalysis({ ...query, since, until });
        const expected = temporalAuditShape(fresh.view);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.view)) {
          return { ok: false, detail: 'a second read produced different per-capability trends; the experience store changed during the read' };
        }
        return { ok: true, detail: `${fresh.view.byCapability.length} capability group(s) and their counts confirmed by an independent read` };
      },
    },

    {
      name: 'experience.patterns',
      description: 'Deterministic descriptions of recorded outcome order: repeated success or failure, alternation, regression after success, improvement after a user correction, and recurring corrections. Every pattern names its supporting and contradicting records and its limits. Read-only; no pattern is a cause, a prediction, or an adaptation.',
      inputHint: '{"since":"optional ISO 8601 or YYYY-MM-DD","until":"optional ISO 8601 or YYYY-MM-DD","days":"optional 1-3650","capability":"optional exact capability","limit":"optional 1-50"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['since', 'until', 'days', 'capability', 'limit']);
        return temporalQuery(o, { since: 'since', until: 'until' });
      },
      async execute(_ctx, query) {
        const analysis = await store.temporalAnalysis(query);
        const detection = analysis.patterns;
        return {
          summary: `experience patterns: ${detection.total} pattern(s) met their threshold in the window${detection.truncated ? ' (the list is bounded)' : ''}`,
          data: { query, patterns: patternsAuditShape(analysis.view, detection) },
          display: renderPatterns(analysis.view, detection),
        };
      },
      async verify(_ctx, query, result) {
        const { since, until } = result.data.patterns.window;
        const fresh = await store.temporalAnalysis({ ...query, since, until });
        const expected = patternsAuditShape(fresh.view, fresh.patterns);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.patterns)) {
          return { ok: false, detail: 'a second derivation produced different patterns or evidence; the experience store changed during the read' };
        }
        return { ok: true, detail: `${fresh.patterns.total} pattern(s) and their evidence ids reproduced by an independent derivation` };
      },
    },

    {
      name: 'experience.compare',
      description: 'Compare two time windows over the same stored experiences: counts, outcomes, success rate, feedback, and the largest per-capability changes. Read-only; a difference is a difference in what was recorded, not a causal finding.',
      inputHint: '{"aSince":"optional","aUntil":"optional","bSince":"optional","bUntil":"optional","days":"optional 1-3650","capability":"optional exact capability"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['aSince', 'aUntil', 'bSince', 'bUntil', 'days', 'capability']);
        return {
          aSince: timeBound(o.aSince, 'aSince'),
          aUntil: timeBound(o.aUntil, 'aUntil', { end: true }),
          bSince: timeBound(o.bSince, 'bSince'),
          bUntil: timeBound(o.bUntil, 'bUntil', { end: true }),
          days: windowDays(o.days),
          capability: capabilityFilter(o.capability),
        };
      },
      async execute(_ctx, query) {
        const comparison = await store.temporalComparison(query);
        return {
          summary: `experience comparison: A ${comparison.totals.a.total} event(s), B ${comparison.totals.b.total} event(s); ${comparison.changed ? 'recorded counts differ' : 'recorded counts are equal'}`,
          data: { query, comparison: comparisonAuditShape(comparison) },
          display: renderComparison(comparison),
        };
      },
      async verify(_ctx, query, result) {
        // Both windows are re-read at the bounds the first comparison resolved, for the same
        // reason the timeline verification does: the default B window ends at "now".
        const windows = result.data.comparison.windows;
        const fresh = await store.temporalComparison({
          ...query,
          aSince: windows.a.since,
          aUntil: windows.a.until,
          bSince: windows.b.since,
          bUntil: windows.b.until,
        });
        const expected = comparisonAuditShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data.comparison)) {
          return { ok: false, detail: 'a second comparison produced different windows or counts; the experience store changed during the read' };
        }
        return { ok: true, detail: `both windows and their counts confirmed by an independent read` };
      },
    },
  ];
}

function skippedPhrase(skipped) {
  if (skipped.length === 0) return 'no supporting group skipped';
  return `${skipped.length} group(s) skipped: ${skipped.map((s) => s.reason).join('; ')}`;
}
