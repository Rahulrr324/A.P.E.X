// Record shapes and the reducer for the situational log. The reducer is pure so a restart replays
// exactly the same state, and validation runs on every appended and every replayed record: a line
// that cannot be applied refuses the whole read instead of producing a partial picture.
import { createHash } from 'node:crypto';
import {
  EVENT_CATEGORIES, EVENT_SOURCES, MAX_EVENT_REF, MAX_EVENT_TEXT, MAX_PAYLOAD_BYTES, MAX_REFS,
  RECORD_KINDS, RESPONSES, SITUATION_SCHEMA,
} from './vocabulary.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value, name, max) {
  if (typeof value !== 'string') return `${name} must be text`;
  if (value.trim().length === 0) return `${name} is empty`;
  if (value.length > max) return `${name} exceeds ${max} characters`;
  if (CONTROL_CHARS.test(value)) return `${name} contains control characters`;
  return null;
}

function refList(value, name) {
  if (!Array.isArray(value)) return `${name} must be a list`;
  if (value.length > MAX_REFS) return `${name} holds more than ${MAX_REFS} references`;
  for (const entry of value) {
    const problem = text(entry, `${name} entry`, MAX_EVENT_REF);
    if (problem) return problem;
  }
  return null;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function payloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// A stable digest of the payload's canonical JSON. Object key order is normalised so the same
// observation from two providers is recognised as the same information.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function fingerprintOf(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function validateSituationRecord(record) {
  if (!plainObject(record)) return 'record must be an object';
  if (record.schema !== SITUATION_SCHEMA) return `schema must be ${SITUATION_SCHEMA}`;
  if (!RECORD_KINDS.includes(record.kind)) return `unknown record kind ${String(record.kind)}`;
  if (typeof record.id !== 'string' || !ID_RE.test(record.id)) return 'record id is not usable';
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return 'record at must be an ISO instant';
  if (record.origin !== 'user') return 'every situational record is user origin';

  if (record.kind === 'event_observed') {
    if (!EVENT_SOURCES.includes(record.source)) return `unknown event source ${String(record.source)}`;
    if (!EVENT_CATEGORIES.includes(record.category)) return `unknown event category ${String(record.category)}`;
    const typeProblem = text(record.type, 'event type', MAX_EVENT_TEXT);
    if (typeProblem) return typeProblem;
    const idProblem = text(record.sourceEventId, 'source event id', MAX_EVENT_REF);
    if (idProblem) return idProblem;
    if (typeof record.observedAt !== 'string' || Number.isNaN(Date.parse(record.observedAt))) return 'observedAt must be an ISO instant';
    if (typeof record.ingestedAt !== 'string' || Number.isNaN(Date.parse(record.ingestedAt))) return 'ingestedAt must be an ISO instant';
    if (record.validUntil !== null && (typeof record.validUntil !== 'string' || Number.isNaN(Date.parse(record.validUntil)))) {
      return 'validUntil must be null or an ISO instant';
    }
    if (!plainObject(record.payload)) return 'payload must be an object';
    if (payloadBytes(record.payload) > MAX_PAYLOAD_BYTES) return `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`;
    if (typeof record.confidence !== 'number' || !(record.confidence >= 0 && record.confidence <= 1)) {
      return 'confidence must be a number from 0 to 1';
    }
    if (!plainObject(record.provenance)) return 'provenance must be an object';
    for (const field of ['entityRefs', 'goalRefs', 'planRefs', 'taskRefs']) {
      const problem = refList(record[field], field);
      if (problem) return problem;
    }
    if (typeof record.fingerprint !== 'string' || record.fingerprint.length !== 64) return 'fingerprint must be a sha256 hex digest';
    if (!plainObject(record.integrity)) return 'integrity must be an object';
    if (record.integrity.validated !== true) return 'integrity.validated must be true';
    if (!plainObject(record.worldRefs)) return 'worldRefs must be an object';
    return null;
  }

  if (record.kind === 'event_assessed') {
    for (const field of ['eventId', 'assessmentId']) {
      const problem = text(record[field], field, MAX_EVENT_REF);
      if (problem) return problem;
    }
    if (!plainObject(record.significance)) return 'significance must be an object';
    if (!plainObject(record.relevance)) return 'relevance must be an object';
    if (!plainObject(record.authorization)) return 'authorization must be an object';
    if (!RESPONSES.includes(record.recommended)) return `recommended must be one of: ${RESPONSES.join(', ')}`;
    if (!Array.isArray(record.candidates) || record.candidates.length === 0) return 'candidates must be a non-empty list';
    if (!Array.isArray(record.consequences)) return 'consequences must be a list';
    if (!Array.isArray(record.uncertainty)) return 'uncertainty must be a list';
    if (!Array.isArray(record.affectedObjectives)) return 'affectedObjectives must be a list';
    if (typeof record.rationale !== 'string' || record.rationale.length === 0) return 'rationale is required';
    return null;
  }

  if (record.kind === 'response_decided') {
    for (const field of ['eventId', 'assessmentId', 'decisionId']) {
      const problem = text(record[field], field, MAX_EVENT_REF);
      if (problem) return problem;
    }
    if (!RESPONSES.includes(record.response)) return `response must be one of: ${RESPONSES.join(', ')}`;
    if (record.action !== null && (typeof record.action !== 'string' || record.action.length > MAX_EVENT_REF)) {
      return 'action must be null or an action name';
    }
    if (record.inputDigest !== null && (typeof record.inputDigest !== 'string' || record.inputDigest.length !== 64)) {
      return 'inputDigest must be null or a sha256 hex digest';
    }
    if (typeof record.reason !== 'string' || record.reason.length === 0) return 'a decision needs a reason';
    if (!plainObject(record.notification)) return 'notification must be an object';
    return null;
  }

  if (record.kind === 'response_recorded') {
    for (const field of ['eventId', 'decisionId', 'responseId', 'operationId']) {
      const problem = text(record[field], field, MAX_EVENT_REF);
      if (problem) return problem;
    }
    if (typeof record.action !== 'string' || record.action.length === 0) return 'action is required';
    if (typeof record.outcome !== 'string' || record.outcome.length === 0) return 'outcome is required';
    if (!['executed', 'failed', 'refused'].includes(record.status)) return 'status must be executed, failed, or refused';
    if (record.evaluationId !== null && typeof record.evaluationId !== 'string') return 'evaluationId must be null or an id';
    if (record.experienceId !== null && typeof record.experienceId !== 'string') return 'experienceId must be null or an id';
    return null;
  }

  return 'unreachable record kind';
}

// The whole current picture, derived only from append order.
// `validated: true` is for a caller whose records were already put through
// `validateSituationRecord` by the store's parser on this read - the situational store refuses
// the read when any line failed that check. The structural rules (record ids, an assessment
// naming a recorded event, a decision naming the latest assessment, one response per decision)
// always run; only the per-record shape check is skipped, so this is a deduplication of work,
// not a weaker read.
export function reduceSituation(records, { validated = false } = {}) {
  const events = new Map();
  const assessments = new Map(); // eventId -> latest assessment record
  const assessmentCounts = new Map();
  const decisions = [];
  const responses = [];
  const responseByDecision = new Map();
  const problems = [];

  records.forEach((record, index) => {
    const problem = validated ? null : validateSituationRecord(record);
    if (problem) {
      problems.push({ index, reason: problem });
      return;
    }
    if (record.kind === 'event_observed') {
      if (events.has(record.id)) {
        problems.push({ index, reason: `duplicate record id ${record.id}` });
        return;
      }
      events.set(record.id, record);
      return;
    }
    if (record.kind === 'event_assessed') {
      if (!events.has(record.eventId)) {
        problems.push({ index, reason: `assessment ${record.id} names event ${record.eventId}, which is not in the log` });
        return;
      }
      assessments.set(record.eventId, record);
      assessmentCounts.set(record.eventId, (assessmentCounts.get(record.eventId) ?? 0) + 1);
      return;
    }
    if (record.kind === 'response_decided') {
      const assessment = assessments.get(record.eventId);
      if (!assessment || assessment.id !== record.assessmentId) {
        problems.push({ index, reason: `decision ${record.id} does not name the latest assessment of its event` });
        return;
      }
      if (record.response === 'execute') {
        if (record.action === null || record.inputDigest === null) {
          problems.push({ index, reason: `decision ${record.id} chooses execute without an action and input` });
          return;
        }
      } else if (record.action !== null) {
        problems.push({ index, reason: `decision ${record.id} names an action for a response that runs nothing` });
        return;
      }
      decisions.push(record);
      return;
    }
    // response_recorded
    const decision = decisions.find((d) => d.id === record.decisionId);
    if (!decision) {
      problems.push({ index, reason: `response ${record.id} names decision ${record.decisionId}, which is not in the log` });
      return;
    }
    if (decision.response !== 'execute') {
      problems.push({ index, reason: `response ${record.id} answers a decision that did not authorize execution` });
      return;
    }
    if (responseByDecision.has(record.decisionId)) {
      problems.push({ index, reason: `decision ${record.decisionId} has more than one recorded response` });
      return;
    }
    responses.push(record);
    responseByDecision.set(record.decisionId, record);
  });

  return { events, assessments, assessmentCounts, decisions, responses, responseByDecision, problems };
}

export function latestDecisionFor(decisions, eventId) {
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    if (decisions[i].eventId === eventId) return decisions[i];
  }
  return null;
}
