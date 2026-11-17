// T-13 composition. Retrieval is bounded and read-only across the existing stores; the only write is
// the append-only reasoning session. A conclusion never dispatches an action or grants permission.
import { analyzeRequest } from '../cognition/engine.js';
import { computeConflicts } from '../world/conflicts.js';
import { ValidationError } from '../errors.js';
import { BOUNDS, ConclusionClass, REASONING_SCHEMA, SETTLING_TRUST, Trust } from './vocabulary.js';
import {
  candidateEvidence, cleanText, dedupeEvidence, digest, documentCandidateConflicts, documentEvidence,
  evidenceDigest, externalEvidence, iso, makeEvidence, normalizeBaseEvidence, overlaps, queryTokens,
} from './evidence.js';
import {
  analyzeTemporal, assessEvidence, buildDecision, buildHypotheses, evaluateConclusion, reasoningSummary,
  reasoningTrace,
} from './engine.js';
import { dependencyAssessment } from './dependencies.js';
import { ReasoningStore } from './store.js';

const REQUEST_MAX = BOUNDS.maxRequestChars;

function missingFromAnalysis(analysis) {
  const missing = [];
  for (const item of analysis?.understanding?.missing ?? []) {
    missing.push({ code: String(item.code ?? item).slice(0, 80), source: 'objective_understanding' });
  }
  if (!analysis) missing.push({ code: 'retrieval_unavailable', source: 'cognition' });
  return missing;
}

function priorDocument(result, documents) {
  if (!documents || !Number.isInteger(result.version) || result.version <= 1) return null;
  const previous = result.version - 1;
  return documents.evidence(result.documentId, { version: previous })
    .then((evidence) => evidence ? {
      documentId: result.documentId,
      path: evidence.document?.path ?? result.path,
      version: previous,
      excerpt: evidence.excerpt?.text ?? evidence.excerpt,
      section: evidence.section,
      createdAt: evidence.document?.createdAt ?? null,
    } : null)
    .catch(() => null);
}

export class ReasoningService {
  constructor({
    dataDir,
    memory = null,
    knowledge = null,
    experience = null,
    predictions = null,
    goals = null,
    plans = null,
    tasks = null,
    situation = null,
    worldModel = null,
    documents = null,
    now = () => new Date(),
    idFactory,
    store = null,
  } = {}) {
    this.dataDir = dataDir;
    this.memory = memory;
    this.knowledge = knowledge;
    this.experience = experience;
    this.predictions = predictions;
    this.goals = goals;
    this.plans = plans;
    this.tasks = tasks;
    this.situation = situation;
    this.worldModel = worldModel;
    this.documents = documents;
    this.now = now;
    this.store = store ?? new ReasoningStore(dataDir, { now, idFactory });
  }

  #timeNow() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  /**
   * Retrieve, assess and reason. `persist: false` is used by replay and comparison so a re-run does not
   * append a duplicate session. `origin` is limited to a user act or the deterministic runtime.
   */
  async reason({ request, origin = 'user', persist = true, signal = null } = {}) {
    if (!['user', 'runtime'].includes(origin)) {
      throw new ValidationError('reasoning may be started only by a user act or the deterministic runtime', 'AUTHORIZATION');
    }
    if (signal?.aborted) throw new ValidationError('reasoning was cancelled');
    if (typeof request !== 'string') throw new ValidationError('request must be text');
    const text = request.trim();
    if (text.length === 0) throw new ValidationError('request is empty');
    if (text.length > REQUEST_MAX) throw new ValidationError(`request exceeds ${REQUEST_MAX} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new ValidationError('request contains control characters');

    const started = Date.now();
    const now = this.#timeNow();
    const nowIso = now.toISOString();
    const limitations = [];
    let analysis = null;
    let worldState = null;
    let worldConflicts = null;
    try {
      worldState = this.worldModel && typeof this.worldModel.state === 'function' ? await this.worldModel.state() : null;
      worldConflicts = worldState ? computeConflicts(worldState, { now: now.toISOString() }) : null;
    } catch (err) {
      limitations.push(`world state is unavailable: ${err.message}`);
    }
    if (signal?.aborted) throw new ValidationError('reasoning was cancelled');

    let plans = [];
    try {
      plans = this.plans && typeof this.plans.list === 'function' ? await this.plans.list() : [];
    } catch (err) {
      limitations.push(`plans are unavailable: ${err.message}`);
    }
    let tasks = [];
    try {
      tasks = this.tasks && typeof this.tasks.list === 'function' ? await this.tasks.list() : [];
    } catch (err) {
      limitations.push(`tasks are unavailable: ${err.message}`);
    }
    let goals = [];
    try {
      goals = this.goals && typeof this.goals.list === 'function' ? await this.goals.list() : [];
    } catch (err) {
      limitations.push(`goals are unavailable: ${err.message}`);
    }

    try {
      analysis = await analyzeRequest({
        request: text,
        now,
        stores: {
          memory: this.memory,
          knowledge: this.knowledge,
          experience: this.experience,
          predictions: this.predictions,
          goals: this.goals,
          plans: this.plans,
          tasks: this.tasks,
        },
        seeds: {
          worldState,
          executive: { goals: goals.slice(0, 12), plans: plans.slice(0, 12), tasks: tasks.slice(0, 12) },
        },
        worldConflicts,
      });
    } catch (err) {
      limitations.push(`cross-store cognition was unavailable: ${err.message}`);
    }
    if (signal?.aborted) throw new ValidationError('reasoning was cancelled');

    const tokens = queryTokens(text);
    const base = normalizeBaseEvidence(analysis?.retrieval?.evidence ?? [], now, { perSource: BOUNDS.maxEvidencePerSource });
    // A current search deliberately omits a superseded record. T-13 must be able to say that a
    // historical record exists, so it supplements the retrieval with a bounded read of matching
    // knowledge history. The historical item cites the authoritative record and keeps its validity.
    if (this.knowledge && typeof this.knowledge.list === 'function') {
      try {
        const records = await this.knowledge.list({ limit: 200 });
        const known = new Set(base.map((item) => item.evidenceId));
        for (const record of records) {
          if (base.length >= BOUNDS.maxEvidence) break;
          const lifecycle = String(record.lifecycleState ?? '');
          const historical = ['superseded', 'retracted', 'historical'].includes(lifecycle)
            || (Array.isArray(record.supersededBy) && record.supersededBy.length > 0);
          if (!historical || known.has(`ev:knowledge:${record.id}`)) continue;
          const claim = `${record.subject} --[${record.relationship}]--> ${record.object}`;
          if (!overlaps(claim, tokens)) continue;
          base.push(makeEvidence({
            evidenceId: `ev:knowledge:${record.id}`,
            source: 'knowledge',
            recordId: record.id,
            claim,
            provenance: record.provenance,
            createdAt: record.createdAt,
            validity: lifecycle === 'retracted' ? 'retracted' : 'superseded',
            current: false,
            relation: 'historical',
            trust: record.candidate === true ? Trust.CANDIDATE : Trust.USER_CONFIRMED,
            retrievalReason: 'a superseded or retracted record matched the request; it is shown as historical, not current',
          }));
          known.add(`ev:knowledge:${record.id}`);
        }
      } catch (err) {
        limitations.push(`knowledge history could not be read: ${err.message}`);
      }
    }
    const documentItems = [];
    const documentCandidates = [];
    let documentState = null;
    if (this.documents && typeof this.documents.search === 'function') {
      try {
        const results = await this.documents.search(text, { limit: 8 });
        documentState = { available: true, results: results.length };
        for (const result of results) {
          documentItems.push(documentEvidence(result, now));
          if (result.version > 1) {
            const previous = await priorDocument(result, this.documents);
            if (previous) documentItems.push(documentEvidence(previous, now, { historical: true }));
          }
          if (typeof this.documents.candidateFacts === 'function') {
            try {
              const facts = await this.documents.candidateFacts(result.documentId);
              for (const fact of facts.slice(0, 12)) {
                documentCandidates.push({ fact, document: result });
              }
            } catch (err) {
              limitations.push(`candidate facts for one document are unavailable: ${err.message}`);
            }
          }
        }
      } catch (err) {
        documentState = { available: false, detail: err.message };
        limitations.push(`authorized document retrieval is unavailable: ${err.message}`);
      }
    } else {
      documentState = { available: false, detail: 'document content understanding is not configured' };
    }
    for (const entry of documentCandidates) documentItems.push(candidateEvidence(entry.fact, entry.document, now));

    const externalItems = [];
    let externalState = null;
    if (this.situation && typeof this.situation.events === 'function') {
      try {
        const page = await this.situation.events({ limit: 50 });
        const rows = Array.isArray(page?.rows) ? page.rows : [];
        externalState = { available: true, events: rows.length };
        for (const row of rows) {
          const event = row?.event ?? row;
          if (!event?.id) continue;
          const hay = [event.summary, event.title, event.type, event.provider, event.sourceRef,
            event.payload?.summary, event.payload?.message, row?.assessment?.summary]
            .filter(Boolean).join(' ');
          if (!overlaps(hay, tokens)) continue;
          externalItems.push(externalEvidence(event, now));
          if (externalItems.length >= 8) break;
        }
      } catch (err) {
        externalState = { available: false, detail: err.message };
        limitations.push(`situational observations are unavailable: ${err.message}`);
      }
    } else {
      externalState = { available: false, detail: 'situational awareness is not configured' };
    }

    const documentConflicts = documentCandidateConflicts(documentCandidates);
    const evidence = dedupeEvidence([...base, ...documentItems, ...externalItems, ...documentConflicts], { max: BOUNDS.maxEvidence });
    const byId = new Map(evidence.map((item) => [item.evidenceId, item]));

    // The T-02 readings are kept, but every evidence id they cite must exist in this bounded session.
    // A reading that cites evidence outside the set is retained as a reading and marked unbounded.
    const baseHypotheses = analysis?.deliberation?.hypotheses ?? null;
    if (baseHypotheses?.hypotheses?.length) {
      for (const item of baseHypotheses.hypotheses) {
        for (const claim of item.claims ?? []) {
          for (const id of claim.evidenceIds ?? []) if (!byId.has(id)) {
            limitations.push('a T-02 reading cited evidence outside the bounded T-13 retrieval set; it is not counted here');
          }
        }
      }
    }

    const claims = Array.isArray(analysis?.claims?.claims) ? analysis.claims.claims : [];
    const unsupportedClaims = claims.filter((claim) => claim.evidenceState === 'unsupported'
      || claim.kind === 'unsupported').map((claim) => ({ claimId: claim.claimId, text: cleanText(claim.text, 200) }));
    const conflicts = [
      ...(analysis?.retrieval?.conflicts ?? []).map((item) => ({ ...item, kind: item.kind ?? 'recorded_conflict' })),
      ...documentConflicts,
    ];
    const sources = [
      ...(analysis?.retrieval?.sources ?? []),
      { source: 'document', status: documentState?.available ? (documentState.results > 0 ? 'ok' : 'empty') : 'unavailable', count: documentItems.length, detail: documentState?.detail ?? null },
      { source: 'external_observation', status: externalState?.available ? (externalState.events > 0 ? 'ok' : 'empty') : 'unavailable', count: externalItems.length, detail: externalState?.detail ?? null },
    ];
    const missing = [
      ...missingFromAnalysis(analysis),
      ...(analysis?.deliberation?.hypotheses?.reasoning?.unknowns ?? []).map((item) => ({ code: String(item.code ?? item.kind ?? 'unknown').slice(0, 80), source: 'hypothesis_ledger' })),
      ...(documentState?.available === false ? [{ code: 'document_content_unavailable', source: 'documents' }] : []),
      ...(externalState?.available === false ? [{ code: 'external_observations_unavailable', source: 'situation' }] : []),
    ];
    if (!evidence.some((item) => item.current && item.relation === 'supporting' && SETTLING_TRUST.has(item.trust))
      && !evidence.some((item) => item.relation === 'contradicting')) {
      missing.push({ code: 'no_relevant_evidence', source: 'retrieval' });
    }

    const assessment = assessEvidence(evidence, {
      now: nowIso,
      conflicts,
      unsupportedClaims,
      missing,
      sources,
    });
    const hypotheses = buildHypotheses({ evidence, assessment, baseHypotheses, now: nowIso });
    const dependencies = dependencyAssessment({ plans, tasks, worldState });
    const temporal = analyzeTemporal(evidence, { now: nowIso, plans });
    for (const item of evidence) {
      const state = temporal.entries.find((entry) => entry.evidenceId === item.evidenceId)?.state;
      if (state) item.timeState = state;
    }
    const goal = goals.find((item) => text.toLowerCase().includes(String(item.request ?? '').toLowerCase().slice(0, 16)))
      ?? (goals.length === 1 ? goals[0] : null);
    const conclusion = evaluateConclusion({ assessment, hypotheses, dependencies, temporal, evidence, analysis, now: nowIso });
    const decision = buildDecision({ conclusion, assessment, dependencies, temporal, goal });
    const trace = reasoningTrace({ request: text, analysis, evidence, assessment, hypotheses, dependencies, temporal, conclusion, decision });

    const summary = reasoningSummary({ evidence, assessment, conclusion, dependencies, hypotheses });
    const elapsedMs = Date.now() - started;
    if (elapsedMs > 15_000) limitations.push(`the bounded reasoning budget was exceeded (${elapsedMs}ms); the result is reported as bounded rather than silently widened`);

    const sessionId = this.store.newSessionId();
    const retrieval = {
      items: evidence,
      digest: evidenceDigest(evidence),
      sources,
      limitations: [...new Set(limitations)].slice(0, 12),
      documents: documentState ? { ...documentState, conflicts: documentConflicts.length } : null,
      external: externalState,
      baseEvidence: Array.isArray(analysis?.retrieval?.evidence) ? analysis.retrieval.evidence.length : 0,
      evidenceDigest: evidenceDigest(evidence),
      note: 'authoritative source records remain in their own stores; this session holds bounded references and excerpts',
    };
    const session = {
      schema: REASONING_SCHEMA,
      kind: 'session',
      sessionId,
      request: text,
      origin,
      at: nowIso,
      status: 'completed',
      elapsedMs,
      evidence: retrieval,
      assessment,
      hypotheses: hypotheses.hypotheses,
      hypothesisSelection: {
        preferred: hypotheses.preferred,
        unresolved: hypotheses.unresolved,
        distinguishingEvidence: hypotheses.distinguishingEvidence,
        note: hypotheses.note,
      },
      dependencies,
      causal: dependencies.causal,
      temporal,
      conclusion,
      decision,
      trace,
      summary,
      assumptions: (analysis?.deliberation?.assumptions ?? analysis?.deliberation?.hypotheses?.reasoning?.assumptions ?? [])
        .slice(0, 10).map((item) => ({ code: String(item.code ?? item).slice(0, 80) })),
      unknowns: (analysis?.deliberation?.hypotheses?.reasoning?.unknowns ?? []).slice(0, 12)
        .map((item) => ({ kind: String(item.kind ?? 'unknown').slice(0, 60), code: item.code ? String(item.code).slice(0, 80) : null })),
      retrievalTrace: {
        steps: [
          { step: 'cognition', sources: (analysis?.retrieval?.sources ?? []).map((source) => source.source).slice(0, 20) },
          { step: 'documents', available: documentState?.available ?? false, results: documentState?.results ?? 0 },
          { step: 'external', available: externalState?.available ?? false, events: externalState?.events ?? 0 },
          { step: 'dedupe', selected: evidence.length, candidates: base.length + documentItems.length + externalItems.length + documentConflicts.length },
        ],
      },
      authorization: {
        grants: [],
        executes: false,
        note: 'a reasoning conclusion cannot grant a permission or authorize an action',
      },
    };

    if (persist) await this.store.appendSession(session);
    return session;
  }

  async list({ limit = 20 } = {}) {
    return this.store.list({ limit });
  }

  async session(sessionId) {
    return this.store.get(sessionId);
  }

  async status() {
    return this.store.status();
  }

  async invalidate(sessionId, { reason } = {}) {
    return this.store.invalidate(sessionId, reason, { byOrigin: 'user' });
  }

  // Replays deterministic reasoning against unchanged stores. A changed evidence digest is reported
  // as a change; the engine never pretends the earlier session still describes the present.
  async replay(sessionId) {
    const found = await this.store.get(sessionId);
    if (!found.found) throw new ValidationError(found.detail);
    if (found.session.invalidated) {
      return {
        sessionId,
        replayed: false,
        reason: 'the recorded conclusion is invalidated; a replay would be a new session, not a replay of the old conclusion',
      };
    }
    const fresh = await this.reason({ request: found.session.request, origin: 'user', persist: false });
    const before = found.session.evidence?.digest ?? null;
    const after = fresh.evidence.digest;
    return {
      sessionId,
      replayed: true,
      evidenceUnchanged: before === after,
      beforeDigest: before,
      afterDigest: after,
      beforeEvidenceIds: (found.session.evidence?.items ?? []).map((item) => item.evidenceId),
      afterEvidenceIds: fresh.evidence.items.map((item) => item.evidenceId),
      beforeConclusion: found.session.conclusion,
      afterConclusion: fresh.conclusion,
      changed: before !== after
        || found.session.conclusion?.classification !== fresh.conclusion.classification,
      note: 'replay re-runs the same deterministic rules over the current authoritative stores; it does not overwrite the recorded session',
    };
  }

  async compare(sessionId) {
    const replay = await this.replay(sessionId);
    if (!replay.replayed) return replay;
    return {
      ...replay,
      differences: {
        evidence: replay.evidenceUnchanged ? [] : ['the evidence id digest changed'],
        conclusion: replay.beforeConclusion?.classification === replay.afterConclusion?.classification
          ? [] : [`${replay.beforeConclusion?.classification} -> ${replay.afterConclusion?.classification}`],
      },
    };
  }
}
