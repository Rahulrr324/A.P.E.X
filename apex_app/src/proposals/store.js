// Proposal store: an append-only JSON Lines event log (proposals.jsonl).
//
// The log holds two kinds of event: a model-origin proposal and a user-origin decision about it.
// They are deliberately separate, so a model can never write a decision, and a user decision
// never rewrites the proposal it answered. Nothing here executes, approves, activates, or edits
// a goal or plan: acceptance applies a change through the ordinary goal or plan store operation.
//
// Every write runs under the store's WriterLock, because each one is a read-modify-write and a
// duplicate pending proposal would ask the user the same question twice.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { ValidationError, StoreError } from '../errors.js';
import { shortId, singleLine } from '../util.js';
import { containsSecret, maskSecretLeaves } from '../security/secrets.js';
import {
  PROPOSAL_SCHEMA,
  PROPOSAL_TTL_MS,
  ProposalStatus,
  proposalContentHash,
  proposalStatus,
  reduceEvents,
  validateEventShape,
  validateProposalChanges,
} from './model.js';

function assertNoSecret(value, name) {
  if (containsSecret(typeof value === 'string' ? value : JSON.stringify(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

export class ProposalStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.log = new JsonlStore(filePath, { validateRecord: validateEventShape });
    this.lock = new WriterLock(filePath, { label: path.basename(filePath), now, idFactory });
  }

  async #readComplete() {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`proposal log contains ${corrupt.length} corrupt line(s); refusing incomplete proposal state`);
    }
    const { proposals, problems } = reduceEvents(records);
    if (problems.length > 0) {
      throw new StoreError(`proposal log contains ${problems.length} event(s) that cannot be applied; refusing incomplete proposal state`);
    }
    return { records, proposals };
  }

  async load() {
    const { records, proposals } = await this.#readComplete();
    return { proposals, events: records.length };
  }

  async inspect() {
    const { records, corrupt } = await this.log.load();
    const { proposals, problems } = reduceEvents(records);
    return { events: records.length, proposals: [...proposals.values()], corrupt, problems };
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { proposals, problems } = reduceEvents(records);
    return { records: records.length, proposals: proposals.size, corrupt: corrupt.length, problems: problems.length };
  }

  async get(proposalId) {
    const { proposals } = await this.load();
    return proposals.get(proposalId) ?? null;
  }

  async list() {
    const { proposals } = await this.load();
    return [...proposals.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async resolve(ref) {
    const q = String(ref ?? '').trim();
    if (q.length === 0) throw new ValidationError('a proposal id is required');
    const { proposals } = await this.load();
    if (proposals.has(q)) return proposals.get(q);
    if (q.length < 4) throw new ValidationError(`proposal id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...proposals.values()].filter((p) => p.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no proposal matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} proposals; use a longer id`);
    return matches[0];
  }

  #pick(proposals, ref) {
    const q = String(ref ?? '').trim();
    if (proposals.has(q)) return proposals.get(q);
    if (q.length < 4) throw new ValidationError(`proposal id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...proposals.values()].filter((p) => p.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no proposal matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} proposals; use a longer id`);
    return matches[0];
  }

  #base(type, proposalId) {
    return { schema: PROPOSAL_SCHEMA, eventId: this.idFactory(), type, proposalId, at: this.now().toISOString() };
  }

  async #mutate(build) {
    return this.lock.run(async () => {
      const { records, proposals } = await this.#readComplete();
      const event = await build(proposals);
      const masked = maskSecretLeaves(event);
      const safe = masked.masked > 0 ? { ...masked.value, secretsMasked: true } : masked.value;
      const next = reduceEvents([...records, safe]);
      const refused = next.problems.find((p) => p.index === records.length);
      if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
      await this.log.append(safe);
      return { event: safe, proposal: next.proposals.get(event.proposalId) };
    });
  }

  async createProposal({
    kind,
    title,
    rationale,
    changes,
    goalId = null,
    planId = null,
    baseRevision = null,
    baseVersion = null,
    evidence = [],
    assumptions = [],
    unknowns = [],
    invalidation = [],
    risk = 'low',
    expiresAt = null,
    validation,
  }) {
    assertNoSecret(title, 'the proposal title');
    assertNoSecret(rationale, 'the proposal rationale');
    assertNoSecret(changes, 'the proposed changes');
    assertNoSecret(assumptions, 'an assumption');
    assertNoSecret(unknowns, 'an unknown');
    const problems = validateProposalChanges(kind, changes);
    if (problems.length > 0) {
      throw new ValidationError(`the proposal is malformed: ${problems.join('; ')}`, 'PROPOSAL_INVALID');
    }
    const proposalId = this.idFactory();
    const at = this.now();
    const expiry = expiresAt ?? new Date(at.getTime() + PROPOSAL_TTL_MS).toISOString();
    const contentHash = proposalContentHash({ kind, goalId, planId, changes });
    return this.#mutate((proposals) => {
      const duplicate = [...proposals.values()].find((p) => !p.decision && p.contentHash === contentHash);
      if (duplicate) {
        throw new ValidationError(`the same proposal is already pending as ${shortId(duplicate.id)}`, 'PROPOSAL_DUPLICATE');
      }
      return {
        ...this.#base('proposal_created', proposalId),
        origin: 'model',
        kind,
        title,
        rationale,
        goalId,
        planId,
        ...(baseRevision !== null ? { baseRevision } : {}),
        ...(baseVersion !== null ? { baseVersion } : {}),
        changes,
        evidence: evidence.map((item) => ({
          source: item.source,
          ref: item.ref,
          ...(item.note ? { note: item.note } : {}),
        })),
        assumptions,
        unknowns,
        invalidation,
        risk,
        expiresAt: expiry,
        validation: {
          ok: validation?.ok === true,
          problems: Array.isArray(validation?.problems) ? validation.problems : [],
          checkedAt: at.toISOString(),
        },
        contentHash,
      };
    });
  }

  // The decision is recorded only after the caller has validated the live state. This method
  // re-checks the two facts the log itself can prove: the proposal is undecided, and it has not
  // passed its recorded expiry. Anything about the goal or plan is checked by the caller.
  async decide(ref, { decision, reason = '', applied = null }) {
    return this.#mutate((proposals) => {
      const proposal = this.#pick(proposals, ref);
      if (proposal.decision) {
        throw new ValidationError(`proposal ${shortId(proposal.id)} already has a decision (${proposal.decision.decision})`, 'PROPOSAL_DECIDED');
      }
      const now = this.now();
      if (proposal.expiresAt && Date.parse(proposal.expiresAt) <= now.getTime()) {
        throw new ValidationError(`proposal ${shortId(proposal.id)} expired at ${proposal.expiresAt}; it is not accepted or rejected implicitly`, 'PROPOSAL_EXPIRED');
      }
      if (decision === ProposalStatus.ACCEPTED && proposal.validation?.ok === false) {
        throw new ValidationError(`proposal ${shortId(proposal.id)} failed its own validation and cannot be accepted`, 'PROPOSAL_INVALID');
      }
      return {
        ...this.#base('proposal_decided', proposal.id),
        origin: 'user',
        decision,
        reason,
        ...(applied ? { applied } : {}),
      };
    });
  }

  // A read-only view of the lock, for diagnostics and recovery inspection.
  async lockState() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }
}

export { ProposalStatus, proposalStatus };
