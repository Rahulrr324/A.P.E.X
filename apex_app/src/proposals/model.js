// Executive proposal model: the lifecycle and reducer for proposals.jsonl.
//
// A proposal is a model's suggestion, never a user record and never permission. It cannot
// create, alter, complete, approve, or activate anything by itself. Only an explicit
// user-origin decision can accept one, and acceptance still goes through the ordinary goal or
// plan store operation, which validates the live state at that moment.
//
// Every proposal names the evidence it used, the assumptions it makes, what it does not know,
// its risk, when it expires, and what would make it stale. A decision is a separate event,
// so a proposal and the user's answer are both preserved.
import { createHash } from 'node:crypto';
import { singleLine } from '../util.js';
import { stableStringify } from '../tasks/model.js';
import { validatePlanContent } from '../plans/model.js';
import {
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  MAX_GOAL_REQUEST_CHARS,
} from '../goals/model.js';

export const PROPOSAL_SCHEMA = 1;
export const MAX_PROPOSAL_TITLE_CHARS = 200;
export const MAX_PROPOSAL_RATIONALE_CHARS = 2000;
export const MAX_PROPOSAL_ITEMS = 8;
export const MAX_PROPOSAL_ITEM_CHARS = 300;
export const MAX_PROPOSAL_EVIDENCE = 8;
export const MAX_PROPOSAL_EXPIRY_DAYS = 30;
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROPOSAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9-]{1,64}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export const PROPOSAL_KINDS = Object.freeze([
  'goal_create', // propose a new goal
  'goal_clarify', // propose revised request/criteria for an existing goal
  'plan_create', // propose a draft plan, optionally for a goal
  'plan_revise', // propose a revision of a draft or blocked plan
  'advice', // explain, suggest a next step, or list alternatives; applies nothing
]);

export const PROPOSAL_DECISIONS = Object.freeze(['accepted', 'rejected', 'invalidated']);
export const PROPOSAL_RISK = Object.freeze(['low', 'medium', 'high']);
export const EVIDENCE_SOURCES = Object.freeze([
  'memory', 'knowledge', 'experience', 'prediction', 'operation', 'goal', 'plan', 'task',
]);

// Statuses a reader may see. Only the first four are stored decisions; the rest are derived
// from the record and the live state, and the difference is stated in every rendering.
export const ProposalStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  INVALIDATED: 'invalidated',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  STALE: 'stale',
});

function plainText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function textList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return false;
  if (value.length > maxItems) return false;
  return value.every((item) => plainText(item, maxChars));
}

function criteriaProblems(criteria, problems) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    problems.push('at least one success criterion is required');
    return;
  }
  if (criteria.length > MAX_CRITERIA) {
    problems.push(`at most ${MAX_CRITERIA} success criteria are allowed`);
    return;
  }
  criteria.forEach((c, i) => {
    if (!plainText(c, MAX_CRITERION_CHARS)) problems.push(`criterion ${i + 1} must be plain text of at most ${MAX_CRITERION_CHARS} characters`);
  });
}

// Validates the structured change the proposal asks for. This is shape and type checking only:
// acceptance re-validates against the live stores, which is where a credential-shaped value,
// a missing capability, or a changed goal is refused.
export function validateProposalChanges(kind, changes) {
  const problems = [];
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return ['changes must be an object'];

  if (kind === 'goal_create' || kind === 'goal_clarify') {
    const allowed = kind === 'goal_create'
      ? ['request', 'criteria', 'priority', 'deadline']
      : ['request', 'criteria', 'priority', 'deadline'];
    for (const key of Object.keys(changes)) {
      if (!allowed.includes(key)) problems.push(`unexpected change field "${singleLine(key, 40)}"`);
    }
    if (kind === 'goal_create' || changes.request !== undefined) {
      if (!plainText(changes.request, MAX_GOAL_REQUEST_CHARS)) problems.push('the request must be plain text within the stored limit');
    }
    criteriaProblems(changes.criteria, problems);
    if (changes.priority !== undefined && (!Number.isInteger(changes.priority) || changes.priority < 1 || changes.priority > 5)) {
      problems.push('priority must be an integer from 1 to 5');
    }
    if (changes.deadline !== undefined && changes.deadline !== null
      && (typeof changes.deadline !== 'string' || Number.isNaN(Date.parse(changes.deadline)))) {
      problems.push('deadline must be an ISO date, a time, or null');
    }
    return problems;
  }

  if (kind === 'plan_create' || kind === 'plan_revise') {
    return validatePlanContent(changes);
  }

  if (kind === 'advice') {
    for (const key of Object.keys(changes)) {
      if (!['summary', 'recommendedActions'].includes(key)) problems.push(`unexpected change field "${singleLine(key, 40)}"`);
    }
    if (!plainText(changes.summary, MAX_PROPOSAL_RATIONALE_CHARS)) problems.push('advice needs a plain summary');
    if (changes.recommendedActions !== undefined && !textList(changes.recommendedActions, 5, MAX_PROPOSAL_ITEM_CHARS)) {
      problems.push('recommendedActions must be at most 5 plain lines');
    }
    return problems;
  }

  return [`unknown proposal kind "${singleLine(kind, 40)}"`];
}

export function proposalContentHash({ kind, goalId = null, planId = null, changes }) {
  return createHash('sha256')
    .update(stableStringify({ kind, goalId: goalId ?? null, planId: planId ?? null, changes }))
    .digest('hex');
}

// ---- event shapes -----------------------------------------------------------

function refOk(value) {
  return value === undefined || value === null || (typeof value === 'string' && REF_RE.test(value));
}

export function validateEventShape(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object';
  if (e.schema !== PROPOSAL_SCHEMA) return 'unsupported schema';
  if (typeof e.eventId !== 'string' || e.eventId.length === 0) return 'missing event id';
  if (typeof e.proposalId !== 'string' || !PROPOSAL_ID_RE.test(e.proposalId)) return 'missing proposal id';
  if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return 'bad timestamp';

  if (e.type === 'proposal_created') {
    if (e.origin !== 'model') return 'a proposal is model-origin only';
    if (!PROPOSAL_KINDS.includes(e.kind)) return 'unknown proposal kind';
    if (!plainText(e.title, MAX_PROPOSAL_TITLE_CHARS)) return 'missing title';
    if (!plainText(e.rationale, MAX_PROPOSAL_RATIONALE_CHARS)) return 'missing rationale';
    if (!refOk(e.goalId) || !refOk(e.planId)) return 'bad reference';
    if (e.baseRevision !== undefined && e.baseRevision !== null && (!Number.isInteger(e.baseRevision) || e.baseRevision < 1)) return 'bad base revision';
    if (e.baseVersion !== undefined && e.baseVersion !== null && (!Number.isInteger(e.baseVersion) || e.baseVersion < 1)) return 'bad base version';
    const problems = validateProposalChanges(e.kind, e.changes);
    if (problems.length > 0) return problems[0];
    if (!PROPOSAL_RISK.includes(e.risk)) return 'bad risk';
    if (e.expiresAt !== null && (typeof e.expiresAt !== 'string' || Number.isNaN(Date.parse(e.expiresAt)))) return 'bad expiry';
    if (e.evidence !== undefined) {
      if (!Array.isArray(e.evidence) || e.evidence.length > MAX_PROPOSAL_EVIDENCE) return 'bad evidence list';
      for (const item of e.evidence) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return 'bad evidence item';
        if (!EVIDENCE_SOURCES.includes(item.source)) return 'unknown evidence source';
        if (typeof item.ref !== 'string' || !REF_RE.test(item.ref)) return 'bad evidence reference';
        if (item.note !== undefined && item.note !== null && !plainText(item.note, MAX_PROPOSAL_ITEM_CHARS)) return 'bad evidence note';
      }
    }
    if (e.assumptions !== undefined && !textList(e.assumptions, MAX_PROPOSAL_ITEMS, MAX_PROPOSAL_ITEM_CHARS)) return 'bad assumptions';
    if (e.unknowns !== undefined && !textList(e.unknowns, MAX_PROPOSAL_ITEMS, MAX_PROPOSAL_ITEM_CHARS)) return 'bad unknowns';
    if (e.invalidation !== undefined && !textList(e.invalidation, MAX_PROPOSAL_ITEMS, MAX_PROPOSAL_ITEM_CHARS)) return 'bad invalidation conditions';
    if (!e.validation || typeof e.validation !== 'object' || typeof e.validation.ok !== 'boolean' || !Array.isArray(e.validation.problems)) {
      return 'missing validation result';
    }
    if (typeof e.contentHash !== 'string' || !HASH_RE.test(e.contentHash)) return 'missing content hash';
    return null;
  }

  if (e.type === 'proposal_decided') {
    if (e.origin !== 'user') return 'a proposal decision is user-origin only';
    if (!PROPOSAL_DECISIONS.includes(e.decision)) return 'unknown decision';
    if (typeof e.reason !== 'string' || e.reason.length > 500) return 'bad reason';
    if (e.decision !== ProposalStatus.ACCEPTED && e.reason.trim().length === 0) return 'this decision needs a reason';
    if (e.applied !== undefined && e.applied !== null) {
      if (typeof e.applied !== 'object' || Array.isArray(e.applied)) return 'bad applied references';
      if (!refOk(e.applied.goalId) || !refOk(e.applied.planId)) return 'bad applied reference';
    }
    return null;
  }

  return 'unknown event type';
}

// ---- reducer ----------------------------------------------------------------

export function applyEvent(proposals, e) {
  const shape = validateEventShape(e);
  if (shape) return shape;

  if (e.type === 'proposal_created') {
    if (proposals.has(e.proposalId)) return 'proposal id already exists';
    if (e.contentHash !== proposalContentHash(e)) return 'the content hash does not match the proposal';
    if (e.kind === 'goal_clarify' && !e.goalId) return 'a goal clarification must name the goal';
    if (e.kind === 'plan_revise' && !e.planId) return 'a plan revision proposal must name the plan';
    proposals.set(e.proposalId, {
      id: e.proposalId,
      origin: 'model',
      kind: e.kind,
      title: e.title,
      rationale: e.rationale,
      goalId: e.goalId ?? null,
      planId: e.planId ?? null,
      baseRevision: e.baseRevision ?? null,
      baseVersion: e.baseVersion ?? null,
      changes: e.changes,
      evidence: (e.evidence ?? []).map((item) => ({ source: item.source, ref: item.ref, note: item.note ?? null })),
      assumptions: [...(e.assumptions ?? [])],
      unknowns: [...(e.unknowns ?? [])],
      invalidation: [...(e.invalidation ?? [])],
      risk: e.risk,
      expiresAt: e.expiresAt ?? null,
      validation: {
        ok: e.validation.ok,
        problems: [...e.validation.problems],
        checkedAt: e.validation.checkedAt ?? e.at,
      },
      contentHash: e.contentHash,
      decision: null,
      createdAt: e.at,
      updatedAt: e.at,
    });
    return null;
  }

  const proposal = proposals.get(e.proposalId);
  if (!proposal) return 'unknown proposal';

  if (e.type === 'proposal_decided') {
    if (proposal.decision) return `proposal already has a decision (${proposal.decision.decision})`;
    proposal.decision = {
      decision: e.decision,
      reason: e.reason,
      applied: e.applied
        ? { goalId: e.applied.goalId ?? null, planId: e.applied.planId ?? null }
        : { goalId: null, planId: null },
      at: e.at,
    };
    proposal.updatedAt = e.at;
    return null;
  }

  return 'unknown event type';
}

export function reduceEvents(events) {
  const proposals = new Map();
  const problems = [];
  events.forEach((e, index) => {
    const problem = applyEvent(proposals, e);
    if (problem) problems.push({ index, eventId: e?.eventId ?? null, reason: problem });
  });
  return { proposals, problems };
}

// A decided proposal keeps its decision. A pending one may be expired (by its recorded time
// limit), invalid (its own creation-time validation failed), or stale (the live state moved).
// The distinction matters: rejecting an expired proposal is a different fact from rejecting one
// the user read and declined.
export function proposalStatus(proposal, { now = new Date(), stale = false } = {}) {
  if (proposal?.decision) return proposal.decision.decision;
  if (proposal?.expiresAt && Date.parse(proposal.expiresAt) <= now.getTime()) return ProposalStatus.EXPIRED;
  if (proposal?.validation && proposal.validation.ok === false) return ProposalStatus.INVALID;
  if (stale) return ProposalStatus.STALE;
  return ProposalStatus.PENDING;
}

export function proposalSummary(proposal, options = {}) {
  const status = proposalStatus(proposal, options);
  return {
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    status,
    goalId: proposal.goalId,
    planId: proposal.planId,
    risk: proposal.risk,
    expiresAt: proposal.expiresAt,
    decision: proposal.decision?.decision ?? null,
    applied: proposal.decision?.applied ?? null,
    createdAt: proposal.createdAt,
  };
}
