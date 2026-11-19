// Council service: deterministic multi-perspective evaluation over evidence owned by other APEX
// subsystems. It never creates a duplicate evidence store or a separate memory.
//
// Evidence can arrive in two explicitly-labelled ways:
//   supplied - the caller cited evidence ids/claims (a test fixture, an owner statement, or a
//              record the caller already read);
//   gathered - the service asked the ReasoningService for a bounded read of the real stores.
// A synthetic fixture is never presented as gathered evidence.
//
// The service is deterministic for a fixed evaluation time and input digest. Repeating the same
// deliberation is idempotent: the session id is derived from the input, and the store refuses to
// write a second divergent copy.
import { ValidationError } from '../errors.js';
import {
  buildEvidenceSet, canonicalJson, classifyDisagreement, councilSessionId, digestOf, evaluatePerspective,
  MAX_EVIDENCE_ITEMS, parseObjective, PERSPECTIVES, synthesize,
} from './index.js';

const MAX_TASK_STEPS = 200;

// Reasoning's trust vocabulary is closed but wider than the council's. The mapping is explicit so
// a `source_derived_candidate` can never be mistaken for a user-confirmed fact.
export const REASONING_TRUST_MAP = Object.freeze({
  user_confirmed: 'user_confirmed',
  user_statement: 'user_statement',
  user_objective: 'user_statement',
  authorized_document: 'document',
  external_observation: 'external_observation',
  world_model: 'world_model',
  operational_record: 'operational_record',
  outcome: 'outcome',
  expectation: 'derived',
  derived: 'derived',
  model_unverified: 'candidate',
  source_derived_candidate: 'candidate',
  unknown: 'unknown',
});

export function mapTrust(trust) {
  return REASONING_TRUST_MAP[trust] ?? 'unknown';
}

export function mapRelation(relation) {
  if (relation === 'historical') return 'historical';
  if (relation === 'supporting' || relation === 'contradicting' || relation === 'contextual') return relation;
  return 'contextual';
}

export class CouncilService {
  constructor({ store = null, capabilityLookup, evidenceProvider = null, evidenceProviderName = null, context = null, now = () => new Date(), idFactory } = {}) {
    this.store = store ?? null;
    this.capabilityLookup = capabilityLookup ?? (() => null);
    this.evidenceProvider = evidenceProvider;
    this.evidenceProviderName = evidenceProviderName ?? (evidenceProvider ? 'reasoning' : null);
    this.context = context ?? null;
    this.now = now;
    this.idFactory = idFactory;
  }

  #evaluationTime() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  async deliberate({
    objective, evidence, candidateId, candidate, resourceContext, taskRecord,
    signalledContradiction, useContext = false, signal,
  } = {}) {
    const parsed = parseObjective(objective);
    if (!parsed.valid) throw new ValidationError(parsed.error);
    if (signal?.aborted) throw new ValidationError('council deliberation was cancelled');

    const supplied = Array.isArray(evidence)
      ? evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({ ...item, origin: 'supplied' }))
      : [];
    let gathered = [];
    let evidenceProvenance = supplied.length > 0 ? 'supplied' : 'none';
    const limitations = [];

    // Only gather when asked, or when the caller supplied nothing and a provider is configured.
    if ((useContext || supplied.length === 0) && this.evidenceProvider) {
      try {
        const result = await this.evidenceProvider({ objective: parsed.objective, signal });
        gathered = (Array.isArray(result?.items) ? result.items : []).slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({
          evidenceId: item.evidenceId,
          source: item.source,
          recordId: item.recordId ?? null,
          claim: item.claim ?? item.statement ?? item.text ?? '',
          trust: mapTrust(item.trust),
          relation: mapRelation(item.relation),
          current: item.current !== false,
          validity: item.validity ?? item.timeState ?? null,
          observedAt: item.observedAt ?? item.createdAt ?? null,
          validFrom: item.validFrom ?? null,
          validUntil: item.validUntil ?? null,
          provenance: item.provenance ?? null,
          origin: 'gathered',
        }));
        evidenceProvenance = supplied.length > 0 ? 'supplied+gathered' : 'gathered';
        if (Array.isArray(result?.limitations)) limitations.push(...result.limitations.slice(0, 8));
      } catch (err) {
        limitations.push(`gathered evidence is unavailable: ${err?.message ?? err}`);
        evidenceProvenance = supplied.length > 0 ? 'supplied' : 'unavailable';
      }
    }

    const combined = [...supplied, ...gathered].slice(0, MAX_EVIDENCE_ITEMS);
    if (signalledContradiction && typeof signalledContradiction === 'string') {
      combined.push({
        evidenceId: `council:contradiction:${digestOf(signalledContradiction).slice(0, 12)}`,
        source: 'council_input',
        claim: signalledContradiction.slice(0, 500),
        trust: 'derived',
        relation: 'contradicting',
        current: true,
        origin: 'supplied',
      });
    }

    const resolvedCandidate = candidate ?? (await this.candidateContext(candidateId));
    const capability = resolvedCandidate ? this.capabilityLookup(resolvedCandidate.action || resolvedCandidate.id) : null;

    const evaluatedAt = this.#evaluationTime();
    const nowFn = () => evaluatedAt;
    const evidenceSet = buildEvidenceSet({ evidence: combined, now: nowFn });
    const positions = PERSPECTIVES.map((perspective) => evaluatePerspective(perspective, {
      objective: { text: parsed.objective },
      evidence: evidenceSet.items,
      candidate: resolvedCandidate,
      capability,
      resourceContext: resourceContext ?? null,
      taskRecord: boundTaskRecord(taskRecord),
      evaluatedAt: evaluatedAt.toISOString(),
    }));
    const disagreement = classifyDisagreement(positions);
    const synthesis = synthesize({
      objective: { text: parsed.objective, valid: parsed.valid },
      positions,
      disagreement,
      evidence: evidenceSet,
      candidate: resolvedCandidate,
      evaluatedAt: evaluatedAt.toISOString(),
    });

    const input = canonicalInput({
      objective: parsed.objective,
      evidence: evidenceSet.items,
      candidateId: candidateId ?? null,
      candidate: resolvedCandidate,
      resourceContext: resourceContext ?? null,
      taskRecord: boundTaskRecord(taskRecord),
      signalledContradiction: signalledContradiction ?? null,
      evidenceProvenance,
    });
    const inputDigest = digestOf(input);
    const sessionId = councilSessionId(inputDigest);

    const session = {
      schema: 'apex.council.v1',
      schemaVersion: 1,
      kind: 'session',
      sessionId,
      inputDigest,
      objective: parsed.objective,
      evaluatedAt: evaluatedAt.toISOString(),
      at: evaluatedAt.toISOString(),
      status: 'completed',
      input,
      evidenceProvenance: {
        mode: evidenceProvenance,
        supplied: supplied.length,
        gathered: gathered.length,
        provider: this.evidenceProviderName,
        limitations: [...new Set(limitations)].slice(0, 8),
      },
      evidenceSet: {
        count: evidenceSet.count,
        currentCount: evidenceSet.currentCount,
        contradicting: evidenceSet.contradicting.length,
        historical: evidenceSet.historical.length,
        duplicateIds: evidenceSet.duplicates,
        sources: [...evidenceSet.bySource.keys()],
      },
      positions,
      disagreement,
      disagreementExplanation: synthesis.disagreementExplanation,
      synthesis,
      authorizesExecution: false,
    };

    let saved = { saved: false, reason: 'no session store' };
    let persistenceError = null;
    try {
      saved = await this.#append(session);
    } catch (err) {
      // Council output is deliberation data, so a storage failure does not pretend the
      // deliberation did not happen. It is reported explicitly and the session is not marked
      // persisted; nothing is authorized either way.
      persistenceError = String(err?.message ?? err);
      saved = { saved: false, reason: persistenceError };
    }
    return {
      session,
      synthesis,
      disagreement,
      positions,
      evidenceSet,
      evidenceProvenance: session.evidenceProvenance,
      saved,
      persisted: saved.saved === true || saved.duplicate === true,
      persistenceError,
    };
  }

  async session(sessionId) {
    if (!this.store) return { found: false, detail: 'no council store' };
    return this.store.get(sessionId);
  }

  async list({ limit = 20 } = {}) {
    if (!this.store) return { sessions: [], total: 0, unavailable: 'no council store' };
    return this.store.list({ limit });
  }

  async status() {
    if (!this.store) return { sessions: 0, unavailable: 'no council store' };
    return this.store.status();
  }

  async invalidate(sessionId) {
    // Council sessions are append-only evidence of a deliberation. Retracting one would rewrite
    // history, so this is reported as unsupported rather than faked.
    return {
      invalidated: false,
      reason: 'council sessions are append-only; a later deliberation with different input produces a new session, and the earlier one is never rewritten',
    };
  }

  // Recompute a stored session from its recorded input at its recorded evaluation time. A match
  // proves the persisted synthesis follows deterministically from the persisted input; a mismatch
  // is reported with the fields that differ rather than hidden.
  async replay(sessionId) {
    if (!this.store) return { replayed: false, reason: 'no council store' };
    const found = await this.store.get(sessionId);
    if (!found.found) return { replayed: false, reason: found.detail ?? 'session not found' };
    const stored = found.session;
    const input = stored.input;
    if (!input) return { replayed: false, reason: 'the session did not retain its input, so it cannot be replayed' };

    const evaluatedAt = new Date(stored.evaluatedAt);
    const nowFn = () => evaluatedAt;
    const evidenceSet = buildEvidenceSet({ evidence: input.evidence ?? [], now: nowFn });
    const positions = PERSPECTIVES.map((perspective) => evaluatePerspective(perspective, {
      objective: { text: input.objective },
      evidence: evidenceSet.items,
      candidate: input.candidate ?? null,
      capability: input.candidate ? this.capabilityLookup(input.candidate.action || input.candidate.id) : null,
      resourceContext: input.resourceContext ?? null,
      taskRecord: input.taskRecord ?? null,
      evaluatedAt: evaluatedAt.toISOString(),
    }));
    const disagreement = classifyDisagreement(positions);
    const synthesis = synthesize({
      objective: { text: input.objective, valid: true },
      positions,
      disagreement,
      evidence: evidenceSet,
      candidate: input.candidate ?? null,
      evaluatedAt: evaluatedAt.toISOString(),
    });
    const recomputedDigest = digestOf(synthesis);
    const storedDigest = digestOf(stored.synthesis);
    const match = recomputedDigest === storedDigest
      && digestOf(positions) === digestOf(stored.positions)
      && digestOf(disagreement) === digestOf(stored.disagreement);
    return {
      replayed: true,
      match,
      sessionId: stored.sessionId,
      evaluatedAt: stored.evaluatedAt,
      recomputedDigest,
      storedDigest,
      detail: match
        ? 'the stored synthesis is reproducible from the stored input at the recorded evaluation time'
        : 'the stored synthesis does not match a replay of its recorded input',
      ...(match ? {} : { differences: diffVerdicts(stored.positions ?? [], positions) }),
    };
  }

  // Compare two sessions without pretending they are the same decision. It reports objective,
  // input and per-perspective differences.
  async compare(sessionIdA, sessionIdB) {
    if (!this.store) return { compared: false, reason: 'no council store' };
    if (typeof sessionIdA !== 'string' || typeof sessionIdB !== 'string') {
      return { compared: false, reason: 'two session ids are required' };
    }
    const [a, b] = await Promise.all([this.store.get(sessionIdA), this.store.get(sessionIdB)]);
    if (!a.found) return { compared: false, reason: a.detail ?? 'first session not found' };
    if (!b.found) return { compared: false, reason: b.detail ?? 'second session not found' };
    const verdictsA = new Map((a.session.positions ?? []).map((p) => [p.perspectiveId, p.position?.verdict ?? null]));
    const verdictsB = new Map((b.session.positions ?? []).map((p) => [p.perspectiveId, p.position?.verdict ?? null]));
    const perspectiveDifferences = [];
    for (const id of new Set([...verdictsA.keys(), ...verdictsB.keys()])) {
      if (verdictsA.get(id) !== verdictsB.get(id)) {
        perspectiveDifferences.push({ perspectiveId: id, a: verdictsA.get(id) ?? null, b: verdictsB.get(id) ?? null });
      }
    }
    return {
      compared: true,
      a: { sessionId: a.session.sessionId, objective: a.session.objective, evaluatedAt: a.session.evaluatedAt },
      b: { sessionId: b.session.sessionId, objective: b.session.objective, evaluatedAt: b.session.evaluatedAt },
      sameObjective: a.session.objective === b.session.objective,
      sameInput: a.session.inputDigest === b.session.inputDigest,
      recommendationA: a.session.synthesis?.synthesis?.recommendedOption?.level ?? null,
      recommendationB: b.session.synthesis?.synthesis?.recommendedOption?.level ?? null,
      disagreementA: a.session.disagreement?.kind ?? null,
      disagreementB: b.session.disagreement?.kind ?? null,
      perspectiveDifferences,
      note: perspectiveDifferences.length === 0 && a.session.inputDigest === b.session.inputDigest
        ? 'the two sessions record the same input and the same verdicts'
        : 'differences are preserved; neither session is treated as authoritative over the other',
    };
  }

  async candidateContext(candidateId) {
    if (!candidateId || typeof candidateId !== 'string') return null;
    if (this.context && typeof this.context.candidate === 'function') {
      try {
        const found = await this.context.candidate(candidateId);
        if (found) return found;
      } catch {
        return null;
      }
    }
    return null;
  }

  async #append(session) {
    if (!this.store || typeof this.store.append !== 'function') return { saved: false, reason: 'no session store' };
    const outcome = await this.store.append(session);
    return { saved: outcome?.appended !== false, ...outcome };
  }
}

function boundTaskRecord(taskRecord) {
  if (!taskRecord || typeof taskRecord !== 'object') return null;
  const steps = Array.isArray(taskRecord.steps)
    ? taskRecord.steps.slice(0, MAX_TASK_STEPS).map((step) => ({
      status: typeof step?.status === 'string' ? step.status.slice(0, 40) : null,
      verified: step?.verified === true,
      outcome: typeof step?.outcome === 'string' ? step.outcome.slice(0, 40) : null,
      approval: step?.approval === true,
    }))
    : [];
  return {
    taskId: taskRecord.taskId ?? taskRecord.id ?? null,
    status: taskRecord.status ?? null,
    deadline: taskRecord.deadline ?? taskRecord.dueAt ?? null,
    steps,
    dependents: Array.isArray(taskRecord.dependents) ? taskRecord.dependents.slice(0, 64) : [],
  };
}

function canonicalInput({ objective, evidence, candidateId, candidate, resourceContext, taskRecord, signalledContradiction, evidenceProvenance }) {
  return {
    objective,
    candidateId: candidateId ? String(candidateId).slice(0, 128) : null,
    candidate: candidate ? {
      id: candidate.id ?? null,
      action: candidate.action ?? null,
      description: candidate.description ?? null,
    } : null,
    evidence: evidence.map((item) => ({
      evidenceId: item.evidenceId,
      source: item.source,
      recordId: item.recordId,
      claim: item.claim,
      trust: item.trust,
      relation: item.relation,
      current: item.current,
      validity: item.validity,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      observedAt: item.observedAt,
    })),
    resourceContext: resourceContext ? boundNumbers(resourceContext) : null,
    taskRecord,
    signalledContradiction: signalledContradiction ?? null,
    evidenceProvenance,
  };
}

function boundNumbers(value) {
  const out = {};
  for (const key of ['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes', 'available']) {
    if (value[key] === undefined) continue;
    out[key] = typeof value[key] === 'number' ? value[key] : null;
  }
  return out;
}

function diffVerdicts(stored, fresh) {
  const before = new Map(stored.map((p) => [p.perspectiveId, p.position?.verdict ?? null]));
  const after = new Map(fresh.map((p) => [p.perspectiveId, p.position?.verdict ?? null]));
  const out = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) !== after.get(id)) out.push({ perspectiveId: id, stored: before.get(id), replayed: after.get(id) });
  }
  return out;
}
