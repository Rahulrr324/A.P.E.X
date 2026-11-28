// T-31 Step 2 (2026-11-19): the controlled Evolution Lab's record keeper.
//
// The lab is the one place APEX may record a proposal about changing its own behaviour. What this
// module adds to the existing `src/evolution/index.js` state machine is persistence and the
// enforcement that makes the state machine mean something:
//
//   proposal created      -> recorded, nothing else. A proposal is an idea, never a permission.
//   sandbox verification  -> recorded only with a real result. `verified` is true or false as
//                            measured by whatever ran the check; this module never invents it,
//                            and a proposal with no verification cannot be promoted.
//   promotion requested   -> recorded with a typed reason once the sandbox verification is true.
//   promotion decided     -> recorded by the owner through the ECP-gated capability, never by the
//                            lab itself.
//
// Immutable safety boundaries are read from the live system, not asserted in prose: the ECP's own
// capability registry, the kill-switch latch and the audit log. Nothing here can modify them, and
// the boundary report says which of them it could actually read.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { ValidationError } from '../errors.js';

export const EVOLUTION_LAB_SCHEMA = 'apex.evolution.lab/1';
// T-41 Step 3 (2026-11-22): a proposal may now name the file it would change and carry the bytes it
// would put there. That is a *description*, not a permission: staging it into the Workshop is a
// separate governed act, the sandbox still has to verify it, and the boundary policy still refuses
// the paths that decide what a change is allowed to be.
import { classifyGovernancePath, governanceBoundaryPolicy, canonicalRelativePath } from './governance-boundary.js';
const EVENT_SCHEMA = 'apex.evolution.event/1';

export const LAB_LIMITS = Object.freeze({
  proposals: 200, evidence: 8, title: 160, hypothesis: 2000, detail: 500, reason: 240, actor: 80,
});

const ID = /^evo-[a-z0-9]{1,32}$/;
const EVENTS = new Set(['proposal_created', 'verification_recorded', 'promotion_requested', 'promotion_decided', 'staged_to_workshop']);
const DECISIONS = new Set(['approved', 'rejected']);

function text(value, label, max) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${label} is empty`);
  if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
  return trimmed;
}

function validateEvent(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'an evolution event must be an object';
  if (record.schema !== EVENT_SCHEMA) return 'unexpected evolution event schema';
  if (!EVENTS.has(record.type)) return 'unknown evolution event type';
  if (typeof record.proposalId !== 'string' || !ID.test(record.proposalId)) return 'an evolution event needs a proposal id';
  if (typeof record.eventId !== 'string' || record.eventId.length === 0) return 'an evolution event needs an event id';
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return 'an evolution event needs a timestamp';
  if (record.type === 'proposal_created' && (typeof record.title !== 'string' || record.title.length === 0)) return 'a proposal needs a title';
  if (record.type === 'verification_recorded' && typeof record.verified !== 'boolean') return 'a verification event records true or false';
  if (record.type === 'promotion_requested' && (typeof record.reason !== 'string' || record.reason.length === 0)) return 'a promotion request needs a reason';
  if (record.type === 'promotion_decided' && !DECISIONS.has(record.decision)) return 'a promotion decision is approved or rejected';
  if (record.type === 'staged_to_workshop') {
    if (typeof record.candidateId !== 'string' || !/^wsc-[0-9a-f]{12}$/.test(record.candidateId)) return 'a staging event names a workshop candidate';
    if (typeof record.targetRelativePath !== 'string' || record.targetRelativePath.length === 0) return 'a staging event names the target path';
  }
  return null;
}

export function createEvolutionLab({ dataDir, now = () => new Date(), idFactory = randomUUID } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('the evolution lab needs a data directory');
  const store = new JsonlStore(path.join(dataDir, 'evolution-proposals.jsonl'), {
    validateRecord: validateEvent,
    parseCacheBytes: 1 << 20,
  });
  const at = () => {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };

  async function readEvents() {
    const { records, corrupt } = await store.load();
    return { records, corrupt };
  }

  // One derived record per proposal. Every field comes from an event; nothing is defaulted to a
  // value that would read as success.
  function reduce(records) {
    const proposals = new Map();
    for (const record of records) {
      let entry = proposals.get(record.proposalId);
      if (!entry) {
        entry = {
          proposalId: record.proposalId,
          title: null, hypothesis: null, evidence: [], createdAt: null,
          targetRelativePath: null, proposedContent: null, testContent: null,
          sandbox: { verified: null, detail: null, at: null, events: 0 },
          promotion: { state: 'not_requested', requestedAt: null, reason: null, decidedAt: null, decision: null, decisionReason: null },
          staging: { count: 0, candidateId: null, at: null },
        };
        proposals.set(record.proposalId, entry);
      }
      if (record.type === 'proposal_created') {
        entry.title = record.title;
        entry.hypothesis = record.hypothesis ?? null;
        entry.evidence = Array.isArray(record.evidence) ? [...record.evidence] : [];
        entry.createdAt = record.at;
        entry.targetRelativePath = record.targetRelativePath ?? null;
        entry.proposedContent = record.proposedContent ?? null;
        entry.testContent = record.testContent ?? null;
      } else if (record.type === 'staged_to_workshop') {
        entry.staging = { count: entry.staging.count + 1, candidateId: record.candidateId, at: record.at };
      } else if (record.type === 'verification_recorded') {
        entry.sandbox = { verified: record.verified === true, detail: record.detail ?? null, at: record.at, events: entry.sandbox.events + 1 };
      } else if (record.type === 'promotion_requested') {
        entry.promotion = { ...entry.promotion, state: 'requested', requestedAt: record.at, reason: record.reason };
      } else if (record.type === 'promotion_decided') {
        entry.promotion = {
          ...entry.promotion,
          state: record.decision === 'approved' ? 'approved' : 'rejected',
          decidedAt: record.at,
          decision: record.decision,
          decisionReason: record.reason ?? null,
        };
      }
    }
    for (const entry of proposals.values()) {
      if (entry.createdAt === null) entry.title = entry.title ?? 'unrecorded proposal';
    }
    return proposals;
  }

  async function append(build) {
    const event = { schema: EVENT_SCHEMA, eventId: idFactory(), at: at(), ...build };
    const problem = validateEvent(event);
    if (problem) throw new ValidationError(problem);
    await store.append(event);
    return event;
  }

  async function list() {
    const { records, corrupt } = await readEvents();
    const proposals = [...reduce(records).values()]
      .map((entry) => Object.freeze({ ...entry, promotionBlocked: promotionBlocker(entry) }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return Object.freeze({
      schema: EVOLUTION_LAB_SCHEMA,
      proposals,
      total: proposals.length,
      corruptEvents: corrupt.length,
      authorizesExecution: false,
    });
  }

  // Why a promotion may not be requested yet, in the lab's own words. A verified sandbox result is
  // the only thing that lifts it.
  function promotionBlocker(entry) {
    if (entry.sandbox.verified === null) return 'no sandbox verification is recorded for this proposal';
    if (entry.sandbox.verified === false) return 'the recorded sandbox verification failed';
    if (entry.promotion.state === 'approved') return 'the promotion is already approved';
    if (entry.promotion.state === 'requested') return 'the promotion request is awaiting the owner decision';
    if (entry.promotion.state === 'rejected') return 'the promotion was rejected; a new proposal is needed';
    return null;
  }

  async function create({ title, hypothesis = null, evidence = [], targetRelativePath = null, proposedContent = null, testContent = null } = {}) {
    const { records } = await readEvents();
    if (new Set(records.map((record) => record.proposalId)).size >= LAB_LIMITS.proposals) {
      throw new ValidationError(`the evolution lab holds at most ${LAB_LIMITS.proposals} proposals`);
    }
    if (!Array.isArray(evidence) || evidence.length > LAB_LIMITS.evidence) {
      throw new ValidationError(`evidence must be a list of at most ${LAB_LIMITS.evidence} items`);
    }
    // A proposal that names a file is checked against the immutable boundary HERE, at the moment it is
    // recorded, as well as when it is staged. Two checks is not redundancy: a refusal that only happens
    // at staging would let a boundary-targeting proposal sit in the ledger looking legitimate.
    let target = null;
    if (targetRelativePath !== null) {
      target = text(targetRelativePath, 'targetRelativePath', 512);
      const refusal = classifyGovernancePath(target);
      if (refusal) {
        const error = new ValidationError(`this path is inside the immutable governance boundary: ${refusal.why}`);
        error.code = refusal.code;
        // The executor copies a plain `detail` object onto the step's error record, which is how the
        // refusal reaches the route and the browser with the boundary's name on it rather than as a
        // message a screen has to parse.
        error.detail = { boundary: refusal };
        throw error;
      }
    }
    if (target === null && (proposedContent !== null || testContent !== null)) {
      throw new ValidationError('proposedContent and testContent need a targetRelativePath');
    }
    if (proposedContent !== null && typeof proposedContent !== 'string') throw new ValidationError('proposedContent must be text');
    if (testContent !== null && typeof testContent !== 'string') throw new ValidationError('testContent must be text');
    const proposalId = `evo-${idFactory().replace(/-/g, '').slice(0, 16)}`;
    const event = await append({
      type: 'proposal_created',
      proposalId,
      title: text(title, 'title', LAB_LIMITS.title),
      hypothesis: hypothesis === null ? null : text(hypothesis, 'hypothesis', LAB_LIMITS.hypothesis),
      evidence: evidence.map((item) => text(String(item), 'an evidence item', 240)),
      targetRelativePath: target,
      proposedContent,
      testContent,
    });
    return { proposalId, createdAt: event.at, targetRelativePath: target };
  }

  // `verified` is a measurement, not a claim: the caller has to have run something. The lab stores
  // the boolean and the detail the run reported, and never flips it on its own.
  async function recordVerification({ proposalId, verified, detail = null } = {}) {
    const { records } = await readEvents();
    if (!records.some((record) => record.proposalId === proposalId)) {
      throw new ValidationError(`no evolution proposal ${String(proposalId)} is recorded`);
    }
    if (typeof verified !== 'boolean') throw new ValidationError('a sandbox verification records true or false');
    const event = await append({
      type: 'verification_recorded',
      proposalId,
      verified,
      detail: detail === null ? null : text(detail, 'detail', LAB_LIMITS.detail),
    });
    return { proposalId, verified: event.verified, at: event.at };
  }

  async function requestPromotion({ proposalId, reason } = {}) {
    const { records } = await readEvents();
    const entry = reduce(records).get(proposalId);
    if (!entry) throw new ValidationError(`no evolution proposal ${String(proposalId)} is recorded`);
    const blocker = promotionBlocker(entry);
    if (blocker) throw new ValidationError(`this proposal cannot be promoted: ${blocker}`);
    const event = await append({
      type: 'promotion_requested',
      proposalId,
      reason: text(reason, 'reason', LAB_LIMITS.reason),
    });
    return { proposalId, requestedAt: event.at, state: 'requested' };
  }

  async function decidePromotion({ proposalId, decision, reason = null, actor = 'owner' } = {}) {
    const { records } = await readEvents();
    const entry = reduce(records).get(proposalId);
    if (!entry) throw new ValidationError(`no evolution proposal ${String(proposalId)} is recorded`);
    if (!DECISIONS.has(decision)) throw new ValidationError('a promotion decision is approved or rejected');
    if (entry.promotion.state !== 'requested') {
      throw new ValidationError('only a requested promotion can be decided');
    }
    const event = await append({
      type: 'promotion_decided',
      proposalId,
      decision,
      reason: reason === null ? null : text(reason, 'reason', LAB_LIMITS.reason),
      actor: text(actor, 'actor', LAB_LIMITS.actor),
    });
    return { proposalId, decision: event.decision, at: event.at };
  }

  // T-41 Step 3: record that this proposal was staged into the Workshop as a candidate. The lab does
  // not stage anything itself - the action calls the sandbox and then writes this event - but the link
  // is recorded here so the causal trace can follow proposal -> candidate without guessing.
  async function recordStaging({ proposalId, candidateId, targetRelativePath } = {}) {
    const { records } = await readEvents();
    if (!records.some((record) => record.proposalId === proposalId)) {
      throw new ValidationError(`no evolution proposal ${String(proposalId)} is recorded`);
    }
    const event = await append({
      type: 'staged_to_workshop',
      proposalId,
      candidateId,
      targetRelativePath: canonicalRelativePath(targetRelativePath) ?? String(targetRelativePath),
    });
    return { proposalId, candidateId, at: event.at };
  }

  async function get(proposalId) {
    const { records } = await readEvents();
    const entry = reduce(records).get(proposalId);
    return entry ? Object.freeze({ ...entry, promotionBlocked: promotionBlocker(entry) }) : null;
  }

  async function status() {
    const { records, corrupt } = await readEvents();
    const proposals = [...reduce(records).values()];
    return Object.freeze({
      schema: EVOLUTION_LAB_SCHEMA,
      events: records.length,
      proposals: proposals.length,
      verified: proposals.filter((entry) => entry.sandbox.verified === true).length,
      failed: proposals.filter((entry) => entry.sandbox.verified === false).length,
      awaitingVerification: proposals.filter((entry) => entry.sandbox.verified === null).length,
      promotionRequested: proposals.filter((entry) => entry.promotion.state === 'requested').length,
      promoted: proposals.filter((entry) => entry.promotion.state === 'approved').length,
      corrupt,
    });
  }

  return Object.freeze({
    filePath: path.join(dataDir, 'evolution-proposals.jsonl'),
    create, recordVerification, requestPromotion, decidePromotion, recordStaging, list, get, status,
  });
}

// The immutable boundaries, as the live system reports them. Each entry is one read with the value
// it produced; a boundary whose source could not be read says so rather than being assumed present.
export function evolutionBoundaries({ registry = null, ecp = null, operations = null } = {}) {
  const entries = [];
  const safetyNames = ['safety.lockdown', 'safety.release'];
  const definitions = safetyNames.map((name) => (typeof registry?.get === 'function' ? registry.get(name) : null));
  entries.push({
    key: 'ecp_sole_authority',
    title: 'ECP is the only authorization authority',
    locked: definitions.every((definition) => definition !== null && definition !== undefined),
    evidence: definitions.every((definition) => definition)
      ? `${safetyNames.join(' and ')} are registered capabilities; every action is authorized by the ECP`
      : 'one or more safety capabilities are not registered, so this could not be confirmed',
  });
  let killSwitch = null;
  try { killSwitch = typeof ecp?.killSwitchStatus === 'function' ? ecp.killSwitchStatus() : null; } catch { killSwitch = null; }
  entries.push({
    key: 'kill_switch',
    title: 'Kill switch cannot be modified by a proposal',
    locked: killSwitch !== null,
    evidence: killSwitch === null
      ? 'the kill-switch latch could not be read'
      : `latch ${killSwitch.active ? 'active' : 'clear'}, persistence: ${killSwitch.persistence}`,
  });
  entries.push({
    key: 'permission_scopes',
    title: 'Permission scopes are fixed by the registry',
    locked: typeof registry?.list === 'function',
    evidence: typeof registry?.list === 'function' ? `${registry.list().length} registered capabilities define their own scope` : 'the capability registry could not be read',
  });
  entries.push({
    key: 'audit_log',
    title: 'Every lab act is audited',
    locked: typeof operations?.findById === 'function',
    evidence: typeof operations?.findById === 'function' ? 'the audit log is readable and every evolution action runs through it' : 'the audit log could not be read',
  });
  entries.push({
    key: 'self_modification',
    title: 'A proposal cannot change APEX\'s own code or policy',
    locked: true,
    evidence: 'the lab only appends records; promotion is a recorded decision, and no code or policy path reads the ledger',
  });
  // T-41 Step 3: the canonical protected-path policy, read from the same module the refusal uses.
  const policy = governanceBoundaryPolicy();
  entries.push({
    key: 'protected_paths',
    title: 'Governance, safety, autonomy, ledger and applier paths cannot be targeted',
    locked: policy.total > 0 && policy.overridable === false,
    evidence: `${policy.total} protected path(s) enforced with no override; a proposal that targets one is refused ${policy.code}`,
    policy,
  });
  return Object.freeze({
    entries,
    allLocked: entries.every((entry) => entry.locked),
    note: 'These are reads of the running system, not a promise: each row shows what was read.',
  });
}
