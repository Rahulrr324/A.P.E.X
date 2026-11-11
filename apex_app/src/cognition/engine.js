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
import { LifecycleStatus, RequestLifecycle, lifecycleAudit } from './lifecycle.js';
import { validateAnalysisArtifacts } from './artifacts.js';
import { claimLineageSnapshot } from './lineage.js';

const CONTINUATION_INTENTS = new Set([
  'next_step', 'goal_progress', 'plan_review',
]);

function millis(start) {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function unavailable(requestId, error, timings = {}, lifecycle = null) {
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
    lifecycle,
    // A failed analysis still states the contract: the request was received, the stage that failed is
    // recorded as failed, the dependent cognitive stages could not be taken, and nothing after stage
    // 5 was reached.
    contract: lifecycle
      ? buildContract({ requestId, lifecycle })
      : buildContract({ requestId, analysis: null }),
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
  // The request has arrived, so stage 1 is recorded before any work. `stage` names the stage whose
  // work is currently running; a thrown error is attributed to it instead of to the whole layer.
  const lifecycle = new RequestLifecycle({ requestId });
  lifecycle.complete(1, { counts: { received: 1 } });
  let stage = 2;
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
    lifecycle.complete(2, {
      counts: {
        entities: understanding.entities.length,
        goals: understanding.goals.length,
        plans: understanding.plans.length,
        tasks: understanding.tasks.length,
        missing: understanding.missing.length,
        ambiguities: understanding.ambiguities.length,
        execution_requested: understanding.executionRequested,
      },
    });
    stage = 3;
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
    lifecycle.complete(3, {
      counts: {
        evidence: retrieval.counts.total,
        sources: retrieval.sources.filter((source) => source.status === 'ok').length,
        unavailable: retrieval.counts.unavailable.length,
        damaged: retrieval.counts.damaged.length,
        dropped: retrieval.counts.dropped,
      },
    });
    stage = 4;
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
      // The conflict link is measured separately but is part of `timings.claims`; the diagnostics
      // record labels it as an overlapping sub-stage rather than a second cost.
      timing: (name, ms) => { timings[name] = ms; },
    });
    timings.claims = millis(mark);
    lifecycle.complete(4, {
      counts: {
        total: claimSet.counts.total,
        material: claimSet.counts.material,
        contradicted: claimSet.counts.contradicted,
        historical: claimSet.counts.historical,
        inference: claimSet.counts.inference,
      },
    });
    stage = 5;
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
    // Every deterministic artifact this request produced is checked against its contract before the
    // cognitive stage is recorded as complete. An artifact that contradicts itself - a material claim
    // with no evidence, a conclusion naming a claim that was never extracted - is not presented as a
    // reading of the records; the stage fails closed and the caller sees an unavailable analysis.
    const artifacts = validateAnalysisArtifacts({
      understanding,
      retrieval,
      claims: claimSet,
      deliberation,
    });
    if (!artifacts.ok) {
      const error = new Error(`cognitive artifact contract violated: ${artifacts.problems.slice(0, 3).join('; ')}`);
      error.code = 'ARTIFACT_INVALID';
      throw error;
    }
    lifecycle.complete(5, {
      counts: {
        lines: brief?.lineCount ?? 0,
        omitted: brief?.omitted ?? 0,
        claims: deliberation.conclusion.claimIds.length,
        disclosures: deliberation.disclosures.length,
      },
      labels: {
        decision: deliberation.decision,
        uncertainty: deliberation.uncertainty?.category ?? null,
      },
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
      artifacts,
      audit: trace.toAudit(),
      timings,
      lifecycle,
    };
    // The contract is now read from the lifecycle the request actually passed through. The caller
    // that runs proposals and actions continues the same lifecycle object, so stage 6 onward is
    // recorded by the path that does the work rather than assumed here.
    analysis.contract = buildContract({ requestId, analysis, lifecycle });
    return analysis;
  } catch (err) {
    // The stage that threw is recorded as failed and the cognitive stages that depended on it are
    // recorded as unavailable. The executive stages are left open: this layer cannot know whether the
    // caller will still ask the model without the cognitive reading, and closing them here would let
    // the contract deny an execution that really happened. The caller records them from its own
    // records, or closes them as not reached before it finalizes.
    lifecycle.fail(stage, { reason: 'stage_error' });
    if (stage < 5) lifecycle.closeRange(stage + 1, 5, LifecycleStatus.UNAVAILABLE);
    return unavailable(requestId, err, timings, lifecycle);
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
      ? {
        available: false,
        error: analysis.error ?? null,
        contract: contractAudit(analysis.contract),
        lifecycle: analysis.lifecycle ? lifecycleAudit(analysis.lifecycle.snapshot()) : null,
      }
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
    // Bounded lineage of the deterministic claims, so a later read can re-evaluate what this reading
    // rested on against the stores as they are then. Identifiers, kinds, and states only.
    lineage: claimLineageSnapshot(analysis.claims),
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
    // Which typed artifacts this reading produced, who owns each, and whether its contract held.
    // Kinds and bounded counts only: no artifact content.
    artifacts: analysis.artifacts
      ? {
        ok: analysis.artifacts.ok,
        entries: analysis.artifacts.artifacts.map((entry) => ({
          kind: entry.kind, owner: entry.owner, ok: entry.ok, count: entry.count,
        })),
        problemCount: analysis.artifacts.problems.length,
      }
      : null,
    contract: contractAudit(analysis.contract),
    lifecycle: analysis.lifecycle ? lifecycleAudit(analysis.lifecycle.snapshot()) : null,
  };
}
