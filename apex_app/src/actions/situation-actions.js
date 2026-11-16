// Situational-awareness actions: the user-facing surface of T-09.
//
// Every write is user-origin only and never plannable. An event is data, never an instruction: the
// ingest action validates structure and provenance and cannot name an action to run. Only
// `situation.decide` can choose `execute`, and it must name one registered action and a usable
// input; `situation.response` records what the controller actually ran. The reads may be made for a
// model origin, but none of them is offered as a plan step.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import {
  EVENT_CATEGORIES, EVENT_SOURCES, MAX_EVENT_REF, MAX_EVENT_TEXT, MAX_EVENTS_READ, MAX_PAYLOAD_BYTES,
  MAX_REFS, RESPONSES,
} from '../situational/vocabulary.js';
import { payloadBytes } from '../situational/model.js';

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const text = value.trim();
  if (text.length === 0) throw new ValidationError(`${name} is empty`);
  if (text.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(text)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(text)) throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  return text;
}

function refValue(value, name) {
  const text = textField(value, name, MAX_EVENT_REF);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new ValidationError(`${name} is not a record reference`);
  return text;
}

function refList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list`);
  if (value.length > MAX_REFS) throw new ValidationError(`${name} holds more than ${MAX_REFS} references`);
  return value.map((entry, i) => refValue(entry, `${name} ${i + 1}`));
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${String(key).slice(0, 40)}"`);
  }
  return input;
}

function limitValue(value, max = MAX_EVENTS_READ, fallback = 20) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationError(`limit must be an integer from 1 to ${max}`);
  return value;
}

function confidenceValue(value) {
  if (value === undefined || value === null) return 0.5;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new ValidationError('confidence must be a number from 0 to 1');
  return value;
}

function instantValue(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ValidationError(`${name} must be an ISO date or date-time`);
  return value;
}

function optionalInstant(value, name) {
  if (value === undefined || value === null) return null;
  return instantValue(value, name);
}

function payloadValue(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('payload must be an object');
  if (payloadBytes(value) > MAX_PAYLOAD_BYTES) throw new ValidationError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  return value;
}

function eventLine(row) {
  const { event, assessment, decision, response } = row;
  const level = assessment?.significance.level ?? 'unassessed';
  return `  [${shortId(event.id)}] ${event.category}/${event.type} from ${event.source}`
    + ` | ${level}${assessment ? ` (${assessment.significance.score})` : ''}`
    + ` | ${event.payload?.summary ? String(event.payload.summary).slice(0, 90) : 'no summary'}`
    + `${decision ? ` | decision ${decision.response}${decision.notification?.suppressed ? ' (notice suppressed)' : ''}` : ''}`
    + `${response ? ` | ran ${response.action}: ${response.outcome}` : ''}`;
}

export function situationActions(service) {
  if (!service || typeof service.ingest !== 'function') throw new TypeError('situationActions requires a situation service');

  return [
    {
      name: 'situation.ingest',
      description: 'Normalise one structured observation, check its provenance, write its fact or world event to the World Model, and record it with a deterministic significance assessment. Untrusted content is stored as data. Write: user origin only.',
      inputHint: '{"source":"apex|user|test_provider|external_provider","sourceEventId":"id","type":"text","category":"...","observedAt":"ISO","payload":{},"confidence":0.5,"entityRefs":[],"goalRefs":[],"planRefs":[],"taskRefs":[],"validUntil":"optional ISO"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, [
          'source', 'sourceEventId', 'type', 'category', 'observedAt', 'payload', 'confidence',
          'entityRefs', 'goalRefs', 'planRefs', 'taskRefs', 'validUntil', 'operationId', 'reporter',
        ]);
        const source = textField(o.source, 'source', 40);
        if (!EVENT_SOURCES.includes(source)) throw new ValidationError(`source must be one of: ${EVENT_SOURCES.join(', ')}`);
        const category = textField(o.category, 'category', 40);
        if (!EVENT_CATEGORIES.includes(category)) throw new ValidationError(`category must be one of: ${EVENT_CATEGORIES.join(', ')}`);
        return {
          source,
          sourceEventId: refValue(o.sourceEventId, 'sourceEventId'),
          type: textField(o.type, 'type', MAX_EVENT_TEXT),
          category,
          observedAt: o.observedAt === undefined || o.observedAt === null ? service.now().toISOString() : instantValue(o.observedAt, 'observedAt'),
          payload: payloadValue(o.payload),
          confidence: confidenceValue(o.confidence),
          entityRefs: refList(o.entityRefs, 'entityRefs'),
          goalRefs: refList(o.goalRefs, 'goalRefs'),
          planRefs: refList(o.planRefs, 'planRefs'),
          taskRefs: refList(o.taskRefs, 'taskRefs'),
          validUntil: optionalInstant(o.validUntil, 'validUntil'),
          provenance: {
            reporter: o.reporter === undefined || o.reporter === null ? null : textField(o.reporter, 'reporter', 120),
            operationId: o.operationId === undefined || o.operationId === null ? null : refValue(o.operationId, 'operationId'),
          },
        };
      },
      async execute(_ctx, input) {
        const result = await service.ingest(input);
        const { event, assessment, duplicate } = result;
        return {
          summary: duplicate
            ? `event ${shortId(event.id)} was already recorded; no second copy was written`
            : `recorded event ${shortId(event.id)} (${event.category}/${event.type}) at significance ${assessment.significance.level}`,
          data: {
            id: event.id,
            duplicate,
            source: event.source,
            sourceEventId: event.sourceEventId,
            type: event.type,
            category: event.category,
            observedAt: event.observedAt,
            ingestedAt: event.ingestedAt,
            validUntil: event.validUntil,
            confidence: event.confidence,
            payload: event.payload,
            entityRefs: event.entityRefs,
            goalRefs: event.goalRefs,
            planRefs: event.planRefs,
            taskRefs: event.taskRefs,
            integrity: event.integrity,
            fingerprint: event.fingerprint,
            worldRefs: event.worldRefs,
            assessment: assessment === null ? null : {
              id: assessment.id,
              significance: assessment.significance,
              relevance: assessment.relevance,
              affectedObjectives: assessment.affectedObjectives,
              consequences: assessment.consequences,
              uncertainty: assessment.uncertainty,
              candidates: assessment.candidates,
              recommended: assessment.recommended,
              authorization: assessment.authorization,
              rationale: assessment.rationale,
              stale: assessment.stale === true,
            },
          },
          display: [
            duplicate ? `Event ${shortId(event.id)} is already recorded; the duplicate was ignored.` : `Recorded event ${shortId(event.id)}.`,
            `  source: ${event.source} (${event.sourceEventId}) | category: ${event.category} | type: ${event.type}`,
            `  observed: ${event.observedAt} | ingested: ${event.ingestedAt}${event.validUntil ? ` | valid until: ${event.validUntil}` : ''}`,
            `  confidence: ${event.confidence} | fingerprint: ${event.fingerprint.slice(0, 16)}...`,
            `  world: ${Object.keys(event.worldRefs).length === 0 ? 'no world record was written' : JSON.stringify(event.worldRefs)}`,
            ...(assessment === null ? ['  no assessment is recorded yet'] : [
              `  significance: ${assessment.significance.level} (${assessment.significance.score}) - ${assessment.significance.reasons.join('; ')}`,
              `  relevant to: ${assessment.affectedObjectives.length === 0 ? 'no recorded objective' : assessment.affectedObjectives.map((o) => `${o.type} ${shortId(o.id)}`).join(', ')}`,
              `  expected: ${assessment.consequences.length === 0 ? 'no rule-backed consequence' : assessment.consequences.map((c) => c.statement).join('; ')}`,
              `  recommended: ${assessment.recommended}${assessment.authorization.required ? ' (needs your decision)' : ''}`,
            ]),
            'The payload is stored as data. It was not executed, and it authorized nothing.',
          ].join('\n'),
        };
      },
      async verify(_ctx, input, result) {
        const stored = await service.events({ limit: 100 });
        const row = stored.rows.find((r) => r.event.id === result.data.id);
        if (!row) return { ok: false, detail: 'the recorded event cannot be read back' };
        if (row.event.fingerprint !== result.data.fingerprint) return { ok: false, detail: 'the stored fingerprint differs from the event that was reported' };
        if (row.event.sourceEventId !== input.sourceEventId) return { ok: false, detail: 'the stored source identity differs from the event that was reported' };
        if (!result.data.duplicate && !row.assessment) return { ok: false, detail: 'the event was reported as newly recorded but has no assessment' };
        const factId = result.data.worldRefs?.factId;
        if (factId) {
          const held = await service.worldModel.holds('fact', factId);
          if (!held) return { ok: false, detail: 'the world fact the event reports is not in the World Model' };
        }
        return { ok: true, detail: `event ${shortId(result.data.id)} confirmed by an independent read${result.data.duplicate ? ' (duplicate)' : ''}` };
      },
    },

    {
      name: 'situation.evaluate',
      description: 'Re-read one recorded event in the current context (goals, plans, tasks, world conflicts, deadlines) and record a fresh deterministic assessment. Read-only except for the assessment record. Write: user origin only.',
      inputHint: '{"event":"event id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['event']);
        return { event: refValue(o.event, 'event') };
      },
      async execute(_ctx, { event }) {
        const { event: stored, assessment } = await service.evaluate(event);
        return {
          summary: `assessed event ${shortId(stored.id)} at significance ${assessment.significance.level}`,
          data: {
            eventId: stored.id,
            assessmentId: assessment.id,
            significance: assessment.significance,
            relevance: assessment.relevance,
            affectedObjectives: assessment.affectedObjectives,
            consequences: assessment.consequences,
            uncertainty: assessment.uncertainty,
            candidates: assessment.candidates,
            recommended: assessment.recommended,
            authorization: assessment.authorization,
            rationale: assessment.rationale,
            stale: assessment.stale === true,
          },
          display: [
            `Assessment ${shortId(assessment.id)} of event ${shortId(stored.id)}: ${assessment.significance.level} (${assessment.significance.score})`,
            ...assessment.significance.reasons.map((r) => `  rule: ${r}`),
            ...assessment.consequences.map((c) => `  consequence: ${c.statement} [${c.basis}]`),
            ...assessment.uncertainty.map((u) => `  uncertainty: ${u}`),
            `  affected: ${assessment.affectedObjectives.length === 0 ? 'no recorded objective' : assessment.affectedObjectives.map((o) => `${o.type} ${shortId(o.id)}`).join(', ')}`,
            `  candidates: ${assessment.candidates.map((c) => c.response).join(', ')}`,
            `  recommended: ${assessment.recommended}`,
            'A candidate response is a choice for you. No response runs from an assessment.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { event }, result) {
        const stored = (await service.events({ limit: 100 })).rows.find((r) => r.event.id === result.data.eventId);
        if (!stored?.assessment || stored.assessment.id !== result.data.assessmentId) {
          return { ok: false, detail: 'the reported assessment is not the one the store holds for that event' };
        }
        const fresh = await service.latestAssessment(result.data.eventId);
        if (!fresh || fresh.id !== result.data.assessmentId) return { ok: false, detail: 'an independent read does not hold this assessment as the latest' };
        if (fresh.significance.level !== result.data.significance.level) return { ok: false, detail: 'the stored significance level differs from the reported one' };
        return { ok: true, detail: 'assessment confirmed as the latest reading of that event' };
      },
    },

    {
      name: 'situation.decide',
      description: 'Record your choice among the candidate responses to an assessed event. Choosing execute names one registered action and its input; nothing runs until "situation execute". Repeated notices inside the cooldown are recorded as suppressed. Write: user origin only.',
      inputHint: '{"event":"event id","response":"ignore|record|investigate|notify|recommend|request_approval|execute","action":"optional action name","input":{},"reason":"why"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['event', 'response', 'action', 'input', 'reason']);
        const response = textField(o.response, 'response', 40);
        if (!RESPONSES.includes(response)) throw new ValidationError(`response must be one of: ${RESPONSES.join(', ')}`);
        return {
          event: refValue(o.event, 'event'),
          response,
          action: o.action === undefined || o.action === null ? null : refValue(o.action, 'action'),
          input: o.input === undefined || o.input === null ? null : payloadValue(o.input),
          reason: textField(o.reason, 'reason', 500),
        };
      },
      async execute(_ctx, { event, response, action, input, reason }) {
        const result = await service.decide(event, { response, action, input, reason });
        const { decision, assessment, event: stored } = result;
        return {
          summary: `recorded decision ${shortId(decision.id)}: ${response}${decision.notification.suppressed ? ' (notice suppressed)' : ''}`,
          data: {
            decisionId: decision.id,
            eventId: stored.id,
            assessmentId: assessment.id,
            response: decision.response,
            action: decision.action,
            inputDigest: decision.inputDigest,
            reason: decision.reason,
            notification: decision.notification,
            recommended: assessment.recommended,
            requiresExecution: decision.response === 'execute',
          },
          display: [
            `Decision ${shortId(decision.id)} for event ${shortId(stored.id)}: ${response}`,
            `  reason: ${decision.reason}`,
            decision.action ? `  approved action: ${decision.action} (input digest ${decision.inputDigest.slice(0, 16)}...)` : '  no action was approved',
            decision.notification.suppressed
              ? `  notice suppressed: ${decision.notification.reason}`
              : `  notice key: ${decision.notification.dedupeKey}`,
            decision.response === 'execute'
              ? 'This decision authorizes one run of that action. Nothing has run yet; use "situation execute" to run it. The registry authorizes it again at that moment.'
              : 'This decision changes no recorded work. It is a recorded choice, not an action.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const stored = await service.decisionForExecutionOrRead(result.data.decisionId);
        if (!stored) return { ok: false, detail: 'the recorded decision cannot be read back' };
        if (stored.response !== result.data.response) return { ok: false, detail: 'the stored response differs from the decision that was reported' };
        if (stored.response === 'execute' && stored.inputDigest !== result.data.inputDigest) {
          return { ok: false, detail: 'the stored input digest differs from the approved input' };
        }
        return { ok: true, detail: `decision ${shortId(stored.id)} confirmed with the response that was recorded` };
      },
    },

    {
      name: 'situation.response',
      description: 'Record what happened when an approved event response ran, citing the audited operation. One response per decision; the audit record must exist. Write: user origin only.',
      inputHint: '{"decision":"decision id","operationId":"audit operation id","action":"action name","outcome":"outcome","status":"executed|failed|refused","evaluationId":null,"experienceId":null}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['decision', 'operationId', 'action', 'outcome', 'status', 'evaluationId', 'experienceId']);
        const status = textField(o.status, 'status', 20);
        if (!['executed', 'failed', 'refused'].includes(status)) throw new ValidationError('status must be executed, failed, or refused');
        return {
          decision: refValue(o.decision, 'decision'),
          operationId: refValue(o.operationId, 'operationId'),
          action: refValue(o.action, 'action'),
          outcome: textField(o.outcome, 'outcome', 40),
          status,
          evaluationId: o.evaluationId === undefined || o.evaluationId === null ? null : refValue(o.evaluationId, 'evaluationId'),
          experienceId: o.experienceId === undefined || o.experienceId === null ? null : refValue(o.experienceId, 'experienceId'),
        };
      },
      async execute(_ctx, input) {
        const record = await service.recordResponse(input.decision, input);
        return {
          summary: `recorded response ${shortId(record.id)}: ${record.action} ${record.outcome}`,
          data: {
            id: record.id,
            decisionId: record.decisionId,
            eventId: record.eventId,
            operationId: record.operationId,
            action: record.action,
            status: record.status,
            outcome: record.outcome,
            evaluationId: record.evaluationId,
            experienceId: record.experienceId,
          },
          display: [
            `Response ${shortId(record.id)} for decision ${shortId(record.decisionId)}: ${record.action} -> ${record.outcome}`,
            `  operation: ${shortId(record.operationId)} | status: ${record.status}`,
            record.evaluationId ? `  learning evaluation: ${shortId(record.evaluationId)}` : null,
            record.experienceId ? `  experience: ${shortId(record.experienceId)}` : null,
            'The operation record is the evidence; this line links it to the event and the decision.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, input, result) {
        const decision = await service.store.decision(input.decision);
        if (!decision.responseRecord || decision.responseRecord.id !== result.data.id) {
          return { ok: false, detail: 'the decision does not hold this response' };
        }
        const audited = await service.operations.findById(result.data.operationId);
        if (!audited?.found) return { ok: false, detail: 'the cited operation is not in the audit log' };
        if (audited.record.status !== result.data.outcome) {
          return { ok: false, detail: `the audit record ended as ${audited.record.status}, not ${result.data.outcome}` };
        }
        return { ok: true, detail: 'response confirmed against the decision and the audit record' };
      },
    },

    {
      name: 'situation.state',
      description: 'The current situational picture: recent important events, active alerts, pending approvals, recommendations, uncertainty, actions already taken and the learning they produced. A reading of records, not a claim about the real world. Read-only.',
      inputHint: '{"limit":"optional 1-20"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: limitValue(o.limit, 20, 10) };
      },
      async execute(_ctx, { limit }) {
        const state = await service.state({ limit });
        return {
          summary: `${state.counts.events} event(s), ${state.counts.alerts} alert(s), ${state.counts.pendingApprovals} pending approval(s)`,
          data: state,
          display: [
            `Situational state at ${state.at}: ${state.counts.events} event(s), ${state.counts.alerts} alert(s), `
              + `${state.counts.pendingApprovals} pending approval(s), ${state.counts.recommendations} recommendation(s)`,
            '',
            'Recent events:',
            ...(state.recent.length === 0 ? ['  none recorded'] : state.recent.map((row) => `  [${shortId(row.id)}] ${row.type}: ${row.significance?.level ?? 'unassessed'}`
              + `${row.stale ? ' (stale)' : ''}${row.decision ? ` | decided ${row.decision.response}` : ''}`)),
            '',
            `Alerts: ${state.alerts.length === 0 ? 'none' : ''}`,
            ...state.alerts.map((alert) => `  ${alert.level}: ${alert.summary} [${shortId(alert.eventId)}]`),
            `Understanding: ${state.understanding.observedEvents} observation(s), ${state.understanding.unresolvedWorldConflicts ?? 'unknown'} unresolved world conflict(s)`,
            `Pending approvals: ${state.pendingApprovals.length === 0 ? 'none' : state.pendingApprovals.map((p) => shortId(p.decisionId)).join(', ')}`,
            `Recommendations: ${state.recommendations.length === 0 ? 'none' : state.recommendations.map((r) => `${shortId(r.decisionId)}${r.suppressed ? ' (suppressed notice)' : ''}`).join(', ')}`,
            `Actions taken: ${state.actionsTaken.length === 0 ? 'none' : state.actionsTaken.map((a) => `${a.action} ${a.outcome}`).join(', ')}`,
            ...state.uncertainty.slice(0, 5).map((u) => `  uncertainty: ${u.text}`),
            'This is what APEX has recorded. It is not a live sensor feed and it does not establish what is true outside these records.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const fresh = await service.state({ limit: 1 });
        if (fresh.counts.events !== result.data.counts.events) return { ok: false, detail: 'an independent read counts a different number of events' };
        if (fresh.counts.decisions !== result.data.counts.decisions) return { ok: false, detail: 'an independent read counts a different number of decisions' };
        if (fresh.counts.responses !== result.data.counts.responses) return { ok: false, detail: 'an independent read counts a different number of responses' };
        return { ok: true, detail: 'counts and pending decisions confirmed by an independent read' };
      },
    },

    {
      name: 'situation.events',
      description: 'List recorded events with their latest significance, relevance, recommendation and decision. Bounded and newest first. Read-only.',
      inputHint: '{"limit":"optional 1-100"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: limitValue(o.limit, MAX_EVENTS_READ, 20) };
      },
      async execute(_ctx, { limit }) {
        const page = await service.events({ limit });
        return {
          summary: `${page.rows.length} of ${page.total} event(s) listed`,
          data: page,
          display: [
            `${page.total} event(s) recorded; showing ${page.rows.length}${page.truncated ? ' (bounded)' : ''}:`,
            ...(page.rows.length === 0 ? ['  none recorded'] : page.rows.map(eventLine)),
            'An event is an observation. Its assessment is a rule total, not a probability and not permission.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { limit }, result) {
        const fresh = await service.events({ limit });
        if (fresh.rows.length !== result.data.rows.length) return { ok: false, detail: 'an independent read returns a different number of events' };
        for (let i = 0; i < fresh.rows.length; i += 1) {
          if (fresh.rows[i].event.id !== result.data.rows[i].event.id) return { ok: false, detail: 'an independent read lists a different event in the same position' };
        }
        return { ok: true, detail: `${fresh.rows.length} event(s) confirmed by an independent read` };
      },
    },

    {
      name: 'situation.decisions',
      description: 'List recorded decisions and the responses they produced. This is the user decision history, newest first and bounded. Read-only.',
      inputHint: '{"limit":"optional 1-100","event":"optional event id"}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['limit', 'event']);
        return {
          limit: limitValue(o.limit, 100, 20),
          event: o.event === undefined || o.event === null ? null : refValue(o.event, 'event'),
        };
      },
      async execute(_ctx, { limit, event }) {
        const page = await service.decisions({ limit, event });
        return {
          summary: `${page.decisions.length} of ${page.total} decision(s) listed`,
          data: page,
          display: [
            `${page.total} decision(s) recorded; showing ${page.decisions.length}${page.truncated ? ' (bounded)' : ''}:`,
            ...(page.decisions.length === 0 ? ['  none recorded'] : page.decisions.map((d) => `  [${shortId(d.id)}] ${d.response} on event ${shortId(d.eventId)}`
              + `${d.action ? ` | action ${d.action}` : ''}${d.notification?.suppressed ? ' | notice suppressed' : ''}`
              + `${d.responseRecord ? ` | ran: ${d.responseRecord.outcome}` : ''}`)),
          ].join('\n'),
        };
      },
      async verify(_ctx, { limit, event }, result) {
        const fresh = await service.decisions({ limit, event });
        if (fresh.decisions.length !== result.data.decisions.length) return { ok: false, detail: 'an independent read returns a different number of decisions' };
        if (fresh.total !== result.data.total) return { ok: false, detail: 'an independent read counts a different total' };
        return { ok: true, detail: `${fresh.decisions.length} decision(s) confirmed by an independent read` };
      },
    },

    {
      name: 'situation.status',
      description: 'Situational log health: events, assessments, decisions, responses, significance counts, pending approvals, suppressed notices and learning links. Read-only.',
      inputHint: '{}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        return expectObject(input ?? {}, []);
      },
      async execute() {
        const status = await service.status();
        return {
          summary: status.available ? `${status.counts.events} event(s), ${status.counts.decisions} decision(s), ${status.counts.responses} response(s)` : 'situational log unavailable',
          data: status,
          display: status.available
            ? [
              `Situational log: ${status.counts.events} event(s), ${status.counts.assessments} assessment(s), ${status.counts.decisions} decision(s), ${status.counts.responses} response(s)`,
              `  levels: ${Object.entries(status.counts.byLevel).map(([level, n]) => `${n} ${level}`).join(', ')}`,
              `  pending approvals: ${status.counts.pendingApprovals} | suppressed notices: ${status.counts.suppressedNotifications}`,
              `  responses: ${status.counts.executedResponses} executed, ${status.counts.failedResponses} failed`,
            ].join('\n')
            : `Situational log unavailable: ${status.detail}`,
        };
      },
      async verify(_ctx, _input, result) {
        const fresh = await service.status();
        if (fresh.available !== result.data.available) return { ok: false, detail: 'the availability reported differs from an independent read' };
        if (fresh.available && fresh.counts.events !== result.data.counts.events) return { ok: false, detail: 'an independent read counts a different number of events' };
        return { ok: true, detail: 'log health confirmed by an independent read' };
      },
    },
  ];
}
