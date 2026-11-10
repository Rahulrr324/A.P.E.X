// Cognitive reasoning engine.
//
// One request goes through the stages below in order: understand the request, retrieve and normalize
// evidence from the stores APEX already has, extract claims and link contradictions, deliberate
// deterministically, then build a bounded grounding brief. Nothing here calls a model, writes a store,
// or authorizes an action. A caller may pass the records it already retrieved as seeds, so integrating
// this layer does not read every store twice.
import {
  BOUNDS, COGNITION_SCHEMA, DecisionKind, Disclosure,
} from './vocabulary.js';
import { understandRequest } from './request.js';
import { retrieveEvidence } from './evidence.js';
import { extractClaims } from './claims.js';
import { deliberate } from './deliberation.js';
import { CognitionTrace } from './trace.js';
import { buildGroundingBrief, validatePlainAnswer } from './response.js';
import { cognitionAudit, validateCognitionModelOutput } from './protocol.js';
import { buildContract, contractAudit } from './contract.js';

const CONTINUATION_INTENTS = new Set([
  'next_step', 'goal_progress', 'plan_review',
]);

function millis(start) {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function unavailable(requestId, error, timings = {}) {
  return {
    schema: COGNITION_SCHEMA,
    available: false,
    unavailable: true,
    requestId: typeof requestId === 'string' ? requestId : null,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'COGNITION_ERROR',
      message: String(error?.message ?? 'the cognitive analysis could not be completed').slice(0, 300),
    },
    brief: null,
    audit: null,
    timings,
    // A failed analysis still states the contract: the request was received, the cognitive stages
    // could not be taken, and nothing after stage 5 was reached.
    contract: buildContract({ requestId, analysis: null }),
  };
}

export async function analyzeRequest({
  request,
  requestId = null,
  now = new Date(),
  turns = [],
  stores = {},
  seeds = {},
  worldConflicts = null,
  continuationLoader = null,
} = {}) {
  const started = performance.now();
  const timings = {};
  try {
    let mark = performance.now();
    const understanding = understandRequest({
      request,
      now,
      worldState: seeds.worldState ?? null,
      goals: seeds.executive?.goals ?? [],
      plans: seeds.executive?.plans ?? [],
      tasks: seeds.executive?.tasks ?? [],
      hasContext: Array.isArray(turns) && turns.length > 0,
      requestId,
    });
    timings.request = millis(mark);
    const trace = new CognitionTrace({ requestId, intent: understanding.intent });
    trace.stage('request', {
      counts: {
        entities: understanding.entities.length,
        goals: understanding.goals.length,
        plans: understanding.plans.length,
        tasks: understanding.tasks.length,
        missing: understanding.missing.length,
        ambiguities: understanding.ambiguities.length,
        execution_requested: understanding.executionRequested,
      },
      durationMs: timings.request,
    });

    mark = performance.now();
    const retrieval = await retrieveEvidence({
      request,
      understanding,
      now,
      stores,
      seeds,
      worldConflicts,
    });
    timings.retrieval = millis(mark);
    trace.stage('retrieval', {
      counts: {
        evidence: retrieval.counts.total,
        sources: retrieval.sources.filter((source) => source.status === 'ok').length,
        unavailable: retrieval.counts.unavailable.length,
        damaged: retrieval.counts.damaged.length,
        dropped: retrieval.counts.dropped,
      },
      durationMs: timings.retrieval,
    });
    trace.evidence(retrieval.evidence);
    if (retrieval.counts.dropped > 0) {
      trace.excluded('all', `bounded to ${BOUNDS.maxEvidenceTotal} evidence records (${BOUNDS.maxEvidencePerSource} per source)`, retrieval.counts.dropped);
    }
    for (const group of retrieval.conflicts ?? []) {
      trace.conflict({
        id: group.id ?? null,
        state: group.state ?? null,
        members: group.memberIds ?? (group.members ?? []).map((member) => member.id),
      });
    }

    mark = performance.now();
    const claimSet = extractClaims({
      evidence: retrieval.evidence,
      understanding,
      conflicts: retrieval.conflicts,
    });
    timings.claims = millis(mark);
    trace.stage('claims', {
      counts: {
        total: claimSet.counts.total,
        material: claimSet.counts.material,
        supported: claimSet.counts.supported,
        contradicted: claimSet.counts.contradicted,
        historical: claimSet.counts.historical,
        inference: claimSet.counts.inference,
        unknown: claimSet.counts.unknown,
        expectation: claimSet.counts.expectation,
      },
      durationMs: timings.claims,
    });

    mark = performance.now();
    let continuation = null;
    if (CONTINUATION_INTENTS.has(understanding.intent) && typeof continuationLoader === 'function') {
      try {
        continuation = await continuationLoader();
      } catch (err) {
        // The executive records may still answer part of the question. A failed continuation read is
        // disclosed as an unavailable source rather than rendered as "no next step exists".
        retrieval.counts.unavailable = [...new Set([...retrieval.counts.unavailable, 'continuation'])];
      }
    }
    timings.continuation = millis(mark);

    mark = performance.now();
    const deliberation = deliberate({
      understanding,
      retrieval,
      claims: claimSet,
      continuation,
    });
    timings.deliberation = millis(mark);
    trace.stage('deliberation', {
      counts: {
        subquestions: deliberation.subquestions.length,
        supporting: deliberation.supporting.length,
        contradicting: deliberation.contradicting.length,
        interpretations: deliberation.interpretations.length,
        assumptions: deliberation.assumptions.length,
        clarification: deliberation.clarification.needed,
      },
      durationMs: timings.deliberation,
    });
    for (const item of deliberation.subquestions) trace.subquestion(item);
    for (const item of deliberation.assumptions) trace.assumption(item.code);
    for (const claimId of deliberation.conclusion.claimIds) {
      const claim = claimSet.byId.get(claimId);
      trace.conclusion({
        claimId,
        kind: deliberation.conclusion.kind,
        evidenceIds: claim?.evidenceIds ?? [],
      });
    }
    if (deliberation.conclusion.claimIds.length === 0) {
      trace.conclusion({
        claimId: null,
        kind: deliberation.conclusion.kind,
        evidenceIds: deliberation.conclusion.evidenceIds,
      });
    }
    trace.validate(deliberation.validation.ok, deliberation.validation.problems);
    trace.decide({
      decision: deliberation.decision,
      uncertainty: deliberation.uncertainty?.category ?? null,
    });
    // The reason the layer stopped short, as the bounded missing-information code it already uses.
    // The clarification wording itself stays in the user-facing answer and out of the trace.
    if (deliberation.clarification?.needed) {
      trace.refusal('clarification_required', deliberation.clarification.missing);
    } else if (deliberation.decision === DecisionKind.REFUSE) {
      trace.refusal('unsupported_request');
    }
    for (const code of deliberation.disclosures) trace.disclose(code);
    if (deliberation.decision === DecisionKind.ANSWER) {
      trace.disclose(Disclosure.MODEL_OUTPUT_UNVERIFIED);
    }

    mark = performance.now();
    const brief = buildGroundingBrief({
      understanding,
      retrieval,
      claims: claimSet,
      deliberation,
    }, { forModelAnswer: true });
    timings.brief = millis(mark);
    trace.stage('response', {
      counts: {
        lines: brief?.lineCount ?? 0,
        omitted: brief?.omitted ?? 0,
        chars: brief?.chars ?? 0,
        disclosures: deliberation.disclosures.length,
      },
      durationMs: timings.brief,
    });

    const analysis = {
      schema: COGNITION_SCHEMA,
      available: true,
      unavailable: false,
      requestId: typeof requestId === 'string' ? requestId : null,
      understanding,
      retrieval,
      claims: claimSet,
      deliberation,
      continuationLoaded: continuation !== null,
      brief,
      audit: trace.toAudit(),
      timings,
    };
    // The contract records the five cognitive stages only. The caller that runs proposals and
    // actions rebuilds it with those records, so stage 6 onward is never assumed here.
    analysis.contract = buildContract({ requestId, analysis });
    return analysis;
  } catch (err) {
    return unavailable(requestId, err, timings);
  }
}

// Validates the model's output against this request's analysis. A plain answer gets the weaker audit
// checks (forged evidence ids, claims of execution). A COGNITION line is validated against the
// bounded schema and this retrieval's evidence ids, and malformed or over-claiming structures are
// rejected whole. Nothing in the result may be used as authorization.
export function validateModelOutput(text, analysis) {
  const result = validateCognitionModelOutput(text, analysis);
  if (!result.found) {
    const validation = validatePlainAnswer(text, analysis);
    return {
      found: false,
      text: result.text,
      structure: null,
      error: null,
      validation,
      audit: {
        structured: false,
        validationOk: validation.ok,
        problems: validation.problems.slice(0, 4),
      },
    };
  }
  if (result.error) {
    return {
      found: true,
      text: result.text,
      structure: null,
      error: result.error,
      validation: result.validation,
      audit: {
        structured: false,
        rejected: true,
        errorCode: result.error.code,
        validationOk: false,
        problems: (result.validation?.problems ?? []).slice(0, 4),
      },
    };
  }
  return {
    found: true,
    text: result.text,
    structure: result.structure,
    error: null,
    validation: result.validation,
    audit: cognitionAudit(result.structure, result.validation),
  };
}

// A bounded audit shape for the whole analysis. Stage names, counts, evidence ids, conflicts, and
// validation results only: no request text, stored content, model text, or chain of thought.
export function analysisAudit(analysis) {
  if (!analysis?.available) {
    return analysis?.available === false
      ? { available: false, error: analysis.error ?? null, contract: contractAudit(analysis.contract) }
      : null;
  }
  return {
    available: true,
    schema: analysis.schema,
    intent: analysis.understanding.intent,
    decision: analysis.deliberation.decision,
    uncertainty: analysis.deliberation.uncertainty?.category ?? null,
    conclusion: analysis.deliberation.conclusion.kind,
    claims: analysis.claims.counts,
    evidence: analysis.retrieval.counts,
    sources: analysis.retrieval.sources.map((source) => ({ source: source.source, status: source.status, count: source.count })),
    disclosures: analysis.deliberation.disclosures.slice(0, 16),
    clarification: analysis.deliberation.clarification.needed,
    brief: analysis.brief
      ? {
        lines: analysis.brief.lineCount,
        totalLines: analysis.brief.totalLines,
        omitted: analysis.brief.omitted,
        chars: analysis.brief.chars,
        maxLines: analysis.brief.maxLines,
        maxChars: analysis.brief.maxChars,
      }
      : null,
    timings: { ...analysis.timings },
    trace: analysis.audit,
    contract: contractAudit(analysis.contract),
  };
}
