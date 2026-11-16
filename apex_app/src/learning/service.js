// The composition layer for outcome learning.
//
// It reads the stores that already exist (plans, goals, tasks, experiences, predictions), asks the
// pure modules in this directory what the records state, and hands the result to the experience store
// to append. It holds no state of its own, opens no file, and adds no lock: the experience store's
// writer lock covers every append, exactly as it does for feedback and adaptation decisions.
//
// Two separations are load-bearing here and are not collapsed anywhere below:
//  - an evaluation is about one plan run against its objective; a prediction is an expectation and is
//    cited as such, never as an observation;
//  - a pattern is a count over evaluations; a proposal is a statement about one capability. Neither
//    is authorization, and only `adaptation.decide` turns a candidate into an applied rule.
import { buildEvaluation } from './evaluate.js';
import { analyzePatterns } from './patterns.js';
import { outcomeProposalKey, proposalForPattern } from './proposals.js';
import { MAX_EVALUATIONS, MIN_PATTERN_OBSERVATIONS } from './vocabulary.js';
import { singleLine } from '../util.js';

const EXPERIENCE_SCAN = 200;
const PREDICTION_SCAN = 50;

export class LearningService {
  constructor({
    experience, plans, goals = null, tasks = null, predictions = null, registry = null, now = () => new Date(),
  } = {}) {
    if (!experience || typeof experience.recordEvaluation !== 'function') {
      throw new TypeError('LearningService requires the experience store');
    }
    if (!plans || typeof plans.resolve !== 'function') throw new TypeError('LearningService requires the plan store');
    this.experience = experience;
    this.plans = plans;
    this.goals = goals;
    this.tasks = tasks;
    this.predictions = predictions;
    this.registry = registry;
    this.now = now;
  }

  // Everything the evaluation cites, read from the stores that own it. An absent optional store is
  // reported as absent by the evaluation itself (a limitation), never as an empty one that proves
  // nothing happened.
  async evaluationInputs(plan) {
    const goal = plan.goalId && this.goals ? await this.goals.get(plan.goalId) : null;
    const task = plan.activation?.taskId && this.tasks ? await this.tasks.get(plan.activation.taskId) : null;
    const operationIds = new Set(Object.values(plan.stepResults ?? {})
      .map((r) => r?.operationId)
      .filter(Boolean));
    const experiences = operationIds.size === 0
      ? []
      : (await this.experience.list({ limit: EXPERIENCE_SCAN }))
        .filter((e) => e.active !== false && operationIds.has(e.operationId));
    const feedback = experiences.flatMap((e) => (e.feedbackSamples ?? []).map((f) => ({ ...f, experienceId: e.id })));
    let predictions = [];
    if (this.predictions && typeof this.predictions.list === 'function') {
      const capabilities = new Set((plan.steps ?? []).map((s) => s.action).filter(Boolean));
      const ledger = await this.predictions.list({ limit: PREDICTION_SCAN });
      predictions = (ledger.projections ?? []).filter((p) => p.status === 'evaluated' && capabilities.has(p.capability));
    }
    return { goal, task, experiences, feedback, predictions };
  }

  // The evaluation as it would be recorded, without writing it. Used by `learning.observe` and by the
  // verification step, which re-reads the plan and rebuilds the same record.
  async evaluate(planRef) {
    const plan = await this.plans.resolve(planRef);
    const inputs = await this.evaluationInputs(plan);
    const evaluation = buildEvaluation({
      plan,
      goal: inputs.goal,
      task: inputs.task,
      experiences: inputs.experiences,
      feedback: inputs.feedback,
      predictions: inputs.predictions,
      now: this.now().toISOString(),
    });
    return { plan, goal: inputs.goal, task: inputs.task, evaluation };
  }

  async evaluations({ capability = null, objectiveKey = null, limit = MAX_EVALUATIONS } = {}) {
    return this.experience.evaluations({ capability, objectiveKey, limit });
  }

  // Pattern extraction over the recorded evaluations and the policy's own experiences. The same
  // bounded scans are used everywhere, so two reads of an unchanged log answer identically.
  async patterns({ minObservations = MIN_PATTERN_OBSERVATIONS } = {}) {
    const evaluations = await this.experience.evaluations({ limit: MAX_EVALUATIONS });
    const experiences = await this.experience.list({ limit: EXPERIENCE_SCAN });
    const analysis = analyzePatterns({
      evaluations: evaluations.evaluations,
      experiences,
      minObservations,
    });
    return { ...analysis, read: { evaluations: evaluations.evaluations.length, truncated: evaluations.truncated } };
  }

  // Turn proposable patterns into candidate adaptation records. A candidate whose scope, objective,
  // and rule are already recorded is skipped rather than duplicated, and a candidate the user has
  // rejected or retired is not re-created behind their back.
  // The specs a proposal pass would append, without writing anything. The write path uses this and
  // then records; verification uses it to prove a second pass would add nothing.
  async proposedSpecs({ minObservations = MIN_PATTERN_OBSERVATIONS } = {}) {
    const analysis = await this.patterns({ minObservations });
    const existing = await this.experience.adaptations({ limit: 200, includeRetired: true });
    const taken = new Set(existing
      .filter((a) => a.decisionState !== 'retired' && a.proposal?.type === 'recorded_outcome_evidence')
      .map((a) => outcomeProposalKey({ capability: a.capability, rule: a.rule, objectiveKey: a.proposal?.objectiveKey ?? null })));
    const specs = [];
    const skipped = [];
    // Two patterns can describe the same change (a capability that failed repeatedly is also the
    // capability that appears only in failed runs). Only the first shape for one capability and
    // objective is proposed; the other is reported, so the store never holds two candidates that
    // would conflict the moment both were approved.
    const shapes = new Set();
    for (const pattern of analysis.patterns) {
      const spec = proposalForPattern(pattern, { registry: this.registry });
      if (!spec) {
        if (pattern.proposalEligible === false || pattern.kind === 'condition_association') {
          skipped.push({
            capability: pattern.capability,
            kind: pattern.kind,
            reason: pattern.kind === 'condition_association'
              ? 'a condition association is reported, never proposed: acting on it would be a causal claim the records do not support'
              : pattern.kind === 'correction_hotspot'
                ? 'a correction pattern is reported, never proposed: the rule it implies is your own guidance, recorded with feedback'
                : `the pattern has ${pattern.supporting.length} supporting observation(s); ${pattern.minObservations} are required`,
          });
        }
        continue;
      }
      const shapeKey = `${spec.capability}\u0000${pattern.objectiveKey ?? ''}\u0000${JSON.stringify(spec.proposal.guidance)}`;
      if (shapes.has(shapeKey)) {
        skipped.push({
          capability: pattern.capability,
          kind: pattern.kind,
          reason: 'another pattern for this scope and objective already proposes the same change; that one is kept and this is reported',
        });
        continue;
      }
      // The shape is claimed even when the record already exists, so a second pattern describing the
      // same change is never treated as a new proposal on the next pass.
      shapes.add(shapeKey);
      const key = outcomeProposalKey({ capability: spec.capability, rule: spec.rule, objectiveKey: pattern.objectiveKey });
      if (taken.has(key)) {
        skipped.push({ capability: pattern.capability, kind: pattern.kind, reason: 'a candidate for this scope, objective and rule is already recorded' });
        continue;
      }
      taken.add(key);
      specs.push({
        ...spec,
        objectiveKey: pattern.objectiveKey ?? null,
        support: {
          evaluationIds: pattern.supporting.map((e) => e.id),
          experienceIds: await this.experiencesForEvaluations(pattern.supporting.map((e) => e.id)),
          feedbackIds: [],
        },
      });
    }
    return { specs, skipped, considered: analysis.considered, truncated: analysis.truncated };
  }

  async propose({ minObservations = MIN_PATTERN_OBSERVATIONS, provenance = {}, origin } = {}) {
    const planned = await this.proposedSpecs({ minObservations });
    if (planned.specs.length === 0) {
      return {
        created: [], skipped: planned.skipped, considered: planned.considered, truncated: planned.truncated,
      };
    }
    const { created, skipped: raced } = await this.experience.recordOutcomeCandidates(
      { specs: planned.specs },
      { provenance, origin },
    );
    return {
      created,
      skipped: [...planned.skipped, ...raced],
      considered: planned.considered,
      truncated: planned.truncated,
    };
  }

  // The experience records an evaluation cited, so an outcome-derived candidate can name the events
  // behind its evaluations as well as the evaluations themselves. Missing ids are dropped here; the
  // store refuses a support list that names nothing.
  async experiencesForEvaluations(evaluationIds) {
    const evaluations = await this.experience.evaluations({ limit: MAX_EVALUATIONS });
    const byId = new Map(evaluations.evaluations.map((e) => [e.id, e]));
    const ids = new Set();
    for (const id of evaluationIds) {
      for (const experienceId of byId.get(id)?.evidence.experienceIds ?? []) ids.add(experienceId);
    }
    return [...ids].slice(0, 20);
  }

  async measure({ target, provenance = {}, origin } = {}) {
    return this.experience.measureAdaptation({ target, provenance, origin });
  }

  async rollback({
    target, measurement = null, reason = null, provenance = {}, origin,
  } = {}) {
    return this.experience.rollbackAdaptation({
      target, measurement, reason, provenance, origin,
    });
  }

  // What APEX learned, which evidence supports it, what it proposes, whether that is authorized, and
  // whether it improved anything. Every row is read from records; nothing is computed for display
  // alone, and an absent read is reported as absent.
  async status({ limit = 10 } = {}) {
    const evaluations = await this.experience.evaluations({ limit: MAX_EVALUATIONS });
    const adaptations = await this.experience.adaptations({ limit: 200, includeRetired: true });
    const analysis = await this.patterns();
    const counts = { achieved: 0, partially_achieved: 0, not_achieved: 0, indeterminate: 0 };
    for (const evaluation of evaluations.evaluations) counts[evaluation.classification] += 1;
    const stages = {};
    for (const adaptation of adaptations) stages[adaptation.stage ?? 'proposed'] = (stages[adaptation.stage ?? 'proposed'] ?? 0) + 1;
    const rows = adaptations
      .filter((a) => (a.stage && a.stage !== 'retired') || a.rolledBack)
      .slice(0, limit)
      .map((a) => ({
        id: a.id,
        capability: a.capability,
        rule: singleLine(a.rule, 200),
        stage: a.stage,
        active: a.active === true,
        objectiveKey: a.proposal?.objectiveKey ?? null,
        measurement: a.measurement ? {
          verdict: a.measurement.verdict,
          baseline: `${a.measurement.baseline.achieved}/${a.measurement.baseline.observations}`,
          followUp: `${a.measurement.followUp.achieved}/${a.measurement.followUp.observations}`,
        } : null,
        rolledBack: a.rolledBack === true,
        support: {
          evaluations: (a.support?.evaluationIds ?? []).length,
          experiences: (a.support?.experienceIds ?? []).length,
        },
      }));
    return {
      evaluations: { total: evaluations.evaluations.length, counts, truncated: evaluations.truncated },
      patterns: {
        total: analysis.patterns.length,
        proposable: analysis.patterns.filter((p) => p.proposalEligible).length,
        kinds: analysis.patterns.map((p) => ({ kind: p.kind, capability: p.capability, confidence: p.confidence, objectiveKey: p.objectiveKey })),
        truncated: analysis.truncated,
      },
      adaptations: { total: adaptations.length, stages, rows },
      hasEvidence: evaluations.evaluations.length > 0,
    };
  }
}
