// Council service: deterministic multi-perspective evaluation over real evidence.
// Consumes evidence from the ReasoningService; never creates duplicate stores.
// Distinct evaluators; disagreement preserved; synthesis never authorizes execution.
import crypto from 'node:crypto';
import { ValidationError } from '../errors.js';
import { parseObjective, buildEvidenceSet, evaluatePerspective, PERSPECTIVES, classifyDisagreement, synthesize, createCouncilSession, appendCouncilSession } from './index.js';
import { CouncilStore } from './store.js';

export class CouncilService {
  constructor({ store = null, capabilityLookup, context = null, now = () => new Date(), idFactory } = {}) {
    this.store = store ?? null;
    this.capabilityLookup = capabilityLookup ?? (() => null);
    this.context = context ?? null;
    this.now = now;
    this.idFactory = idFactory ?? (() => crypto.randomUUID());
  }

  async deliberate({ objective, evidence, candidateId, resourceContext, taskRecord, signal } = {}) {
    const parsed = parseObjective(objective);
    if (!parsed.valid) throw new ValidationError(parsed.error);
    if (signal?.aborted) throw new ValidationError('council deliberation was cancelled');
    const evidenceSet = buildEvidenceSet({ evidence, now: this.now });
    const candidate = await this.candidateContext(candidateId);
    const capability = candidate ? this.capabilityLookup(candidate.action || candidate.id) : null;
    const positions = PERSPECTIVES.map((p) => evaluatePerspective(p, {
      objective: { text: parsed.objective },
      evidence: evidenceSet.items,
      candidate,
      capability,
      resourceContext,
      taskRecord,
    }));
    const disagreement = classifyDisagreement(positions);
    const synthesis = synthesize({ objective: { text: parsed.objective, valid: parsed.valid }, positions, disagreement, evidence: evidenceSet, candidate });
    const session = createCouncilSession({ objective: { text: parsed.objective }, decisionId: synthesis.sessionId ?? null, now: this.now });
    session.status = 'completed';
    session.synthesis = synthesis;
    session.positions = positions;
    session.disagreement = disagreement;
    session.evidenceSet = { count: evidenceSet.count, current: evidenceSet.currentCount, contradicting: evidenceSet.contradicting.length };
    const saved = await appendCouncilSession(this.store, session);
    return { session, synthesis, disagreement, positions, evidenceSet, saved };
  }

  async session(sessionId) {
    if (!this.store) return { found: false, detail: 'no council store' };
    return this.store.get(sessionId);
  }

  async list({ limit = 20 } = {}) {
    if (!this.store) return { sessions: [], total: 0 };
    return this.store.list({ limit });
  }

  async status() {
    if (!this.store) return { sessions: 0, unavailable: 'no council store' };
    const s = await this.store.status();
    return s;
  }

  async invalidate(sessionId, { reason } = {}) {
    if (!this.store) return { invalidated: false, reason: 'no council store' };
    // Council sessions are append-only; invalidation is metadata-only here.
    return { invalidated: false, reason: 'council sessions are append-only and not invalidated' };
  }

  async replay(sessionId) {
    const found = this.store ? await this.store.get(sessionId) : { found: false };
    if (!found.found) return { replayed: false, reason: found.detail ?? 'not found' };
    return { replayed: false, reason: 'council sessions are deterministic and replay is not implemented as a separate action' };
  }

  async compare(sessionId) {
    return { compared: false, reason: 'council comparison is not implemented' };
  }

  async candidateContext(candidateId) {
    if (!candidateId || typeof candidateId !== 'string') return null;
    // Candidate may be a plan step id or a plan id; resolve through context if provided.
    if (this.context && typeof this.context.candidate === 'function') {
      return this.context.candidate(candidateId);
    }
    return null;
  }
}
