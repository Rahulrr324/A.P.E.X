// Outcome-learning actions: the user-facing surface of T-08.
//
// Every write here is user-origin only and `plannable: false`. A model may read what was learned, but
// it cannot record an evaluation, propose an adaptation, measure one, or roll one back - those are the
// user's own acts on records the user can inspect. `learning.observe` records what a run achieved;
// `learning.measure` records what an authorised rule did afterwards; `learning.rollback` records the
// user taking a rule out of force on measured evidence. None of them approves an adaptation: that is
// still `adaptation.decide`, and an approved rule still authorises nothing.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import { validateExperienceRecord } from '../experience/experience-store.js';
import { classifyOutcome } from '../learning/evaluate.js';
import { MAX_EVALUATIONS, MAX_LIMITATIONS } from '../learning/vocabulary.js';

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const text = value.trim();
  if (text.length === 0) throw new ValidationError(`${name} is empty`);
  if (text.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(text)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(text)) throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  return text;
}

function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(ref)) throw new ValidationError(`${name} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  return ref;
}

function optionalRef(value, name) {
  if (value === undefined || value === null) return null;
  return recordRef(value, name);
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${String(key).slice(0, 40)}"`);
  }
  return input;
}

function limitValue(value, { max = MAX_EVALUATIONS, fallback = 10 } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`limit must be an integer from 1 to ${max}`);
  }
  return value;
}

function minObservationsValue(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 2 || value > 20) {
    throw new ValidationError('minObservations must be an integer from 2 to 20');
  }
  return value;
}

const CLASSIFICATION_LABEL = Object.freeze({
  achieved: 'achieved',
  partially_achieved: 'partially achieved',
  not_achieved: 'not achieved',
  indeterminate: 'indeterminate',
});

const VERDICT_LABEL = Object.freeze({
  improved: 'improved',
  no_change: 'no change',
  regressed: 'regressed',
  insufficient_evidence: 'insufficient evidence',
});

function evidenceLine(refs) {
  const parts = [];
  if (refs.operationIds.length) parts.push(`${refs.operationIds.length} operation(s)`);
  if (refs.experienceIds.length) parts.push(`${refs.experienceIds.length} experience(s)`);
  if (refs.feedbackIds.length) parts.push(`${refs.feedbackIds.length} feedback record(s)`);
  if (refs.predictionIds.length) parts.push(`${refs.predictionIds.length} prediction(s)`);
  return parts.length === 0 ? 'no record is cited' : parts.join(', ');
}

function evaluationDisplay(record) {
  const criteria = record.criteria.length === 0
    ? ['  criteria: none recorded with the objective']
    : record.criteria.map((c) => `  criterion ${c.id}: ${c.state}${c.gating ? '' : ' (declined, gates nothing)'}`);
  return [
    `Evaluation ${shortId(record.id)} of plan ${shortId(record.planId)} version ${record.planVersion}: ${CLASSIFICATION_LABEL[record.classification]}`,
    `  objective: ${record.objective}`,
    `  steps: ${record.steps.completed} completed, ${record.steps.failed} failed, ${record.steps.skipped} skipped, ${record.steps.uncertain} uncertain, ${record.steps.notRun} not run (of ${record.steps.total})`,
    ...criteria,
    `  confidence: ${record.confidence} | evidence: ${evidenceLine(record.evidence)}`,
    ...record.limitations.map((text) => `  limitation: ${text}`),
    'This is a reading of recorded outcomes against the objective. It is not a claim that the objective holds outside these records.',
  ].join('\n');
}

function patternLine(pattern) {
  const support = pattern.supporting.slice(0, 4).map((e) => shortId(e.id)).join(', ');
  const against = pattern.contradicting.slice(0, 4).map((e) => shortId(e.id)).join(', ');
  return `  [${pattern.kind}] ${pattern.capability}${pattern.objectiveKey ? ` (objective ${pattern.objectiveKey})` : ''}\n`
    + `      ${pattern.definition}\n`
    + `      observations: ${pattern.observations.total} (${pattern.observations.successes} success, ${pattern.observations.failures} failure, ${pattern.observations.partial} partial) | confidence: ${pattern.confidence} | threshold: ${pattern.minObservations}\n`
    + `      supporting: ${support || 'none'} | contradicting: ${against || 'none'} | ${pattern.proposalEligible ? 'may be proposed' : 'reported only, not proposable'}`;
}

export function learningActions(service) {
  if (!service || typeof service.evaluate !== 'function') {
    throw new TypeError('learningActions requires a learning service');
  }
  const { experience } = service;

  return [
    {
      name: 'learning.observe',
      description: 'Evaluate one plan run against the objective it set out to achieve and the criteria recorded for it, then record the evaluation with its evidence. A step runner returning success is not enough for "achieved". Write: user origin only.',
      inputHint: '{"plan":"plan id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model could otherwise record its own account of what a run achieved. Evaluations are the
      // evidence a later proposal rests on, so only the user may write one.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['plan']);
        return { plan: recordRef(o.plan, 'plan') };
      },
      async execute(ctx, { plan }) {
        const { evaluation } = await service.evaluate(plan);
        const { record } = await experience.recordEvaluation(evaluation, {
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        return {
          summary: `recorded evaluation ${shortId(record.id)}: ${record.classification} for plan ${shortId(record.planId)}`,
          data: {
            id: record.id,
            planId: record.planId,
            planVersion: record.planVersion,
            goalId: record.goalId,
            classification: record.classification,
            confidence: record.confidence,
            steps: record.steps,
            criteria: record.criteria,
            evidence: record.evidence,
            limitations: record.limitations,
            objectiveKey: record.objectiveKey,
          },
          display: evaluationDisplay(record),
        };
      },
      async verify(_ctx, { plan }, result) {
        const stored = (await experience.evaluations({ limit: 100 })).evaluations
          .find((e) => e.id === result.data.id);
        if (!stored) return { ok: false, detail: 'the recorded evaluation cannot be read back' };
        const problem = validateExperienceRecord(stored);
        if (problem) return { ok: false, detail: `the stored evaluation does not validate: ${problem}` };
        const expected = classifyOutcome({
          activated: stored.activated,
          planStatus: stored.planStatus,
          steps: stored.steps,
          criteria: stored.criteria,
        });
        if (stored.classification !== expected) {
          return { ok: false, detail: `stored classification is ${stored.classification}; its counts state ${expected}` };
        }
        if (stored.evidence.operationIds.length > 0 && stored.confidence === 'high' && stored.limitations.length === 0) {
          return { ok: false, detail: 'a high-confidence evaluation cannot carry no limitation at all' };
        }
        let planNote = '';
        try {
          const current = await service.plans.resolve(plan);
          if (current.version !== stored.planVersion) {
            planNote = `; the plan has since moved to version ${current.version}, so this evaluation describes version ${stored.planVersion}`;
          }
        } catch {
          planNote = '; the plan it names is no longer readable, so the evaluation is the only record of that run';
        }
        return { ok: true, detail: `evaluation confirmed against its own counts and criteria${planNote}` };
      },
    },

    {
      name: 'learning.patterns',
      description: 'Describe repeated recorded outcomes: repeated success, repeated failure, corrected capabilities, inefficient steps, ordering dependencies, and a step-count association. Read-only; a pattern is a count, not a cause.',
      inputHint: '{"capability":"optional scope","minObservations":"optional 2-20","limit":"optional 1-40"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['capability', 'minObservations', 'limit']);
        const capability = o.capability === undefined || o.capability === null ? null : textField(o.capability, 'capability', 128);
        return {
          capability,
          minObservations: minObservationsValue(o.minObservations),
          limit: limitValue(o.limit, { max: MAX_EVALUATIONS, fallback: 20 }),
        };
      },
      async execute(_ctx, { capability, minObservations, limit }) {
        const analysis = await service.patterns({ minObservations });
        const patterns = (capability === null
          ? analysis.patterns
          : analysis.patterns.filter((p) => p.capability === capability
            || p.capability.startsWith(`${capability}.`)
            || capability.startsWith(`${p.capability}.`)))
          .slice(0, limit);
        return {
          summary: `${patterns.length} pattern(s) described over ${analysis.considered.evaluations} recorded evaluation(s)`,
          data: {
            patterns,
            considered: analysis.considered,
            truncated: analysis.truncated || patterns.length < analysis.patterns.length,
            read: analysis.read ?? null,
          },
          display: [
            `${patterns.length} pattern(s) over ${analysis.considered.evaluations} evaluation(s) and ${analysis.considered.experiences} experience(s); threshold ${analysis.considered.minObservations} observation(s):`,
            ...patterns.map(patternLine),
            patterns.length === 0
              ? '  no pattern has enough recorded evidence yet. One observation is not a pattern, and nothing was inferred.'
              : 'A pattern is a count over recorded outcomes. Contradicting evidence is listed beside every one; none of it is a cause, a probability, or permission.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { capability, minObservations }, result) {
        const fresh = await service.patterns({ minObservations });
        const expected = capability === null
          ? fresh.patterns
          : fresh.patterns.filter((p) => p.capability === capability
            || p.capability.startsWith(`${capability}.`)
            || capability.startsWith(`${p.capability}.`));
        if (expected.length !== result.data.patterns.length) {
          return { ok: false, detail: `reported ${result.data.patterns.length} pattern(s); an independent read gives ${expected.length}` };
        }
        for (let i = 0; i < expected.length && i < result.data.patterns.length; i += 1) {
          if (expected[i].kind !== result.data.patterns[i].kind || expected[i].capability !== result.data.patterns[i].capability) {
            return { ok: false, detail: 'an independent read describes a different pattern in the same position' };
          }
        }
        return { ok: true, detail: `${expected.length} pattern(s) confirmed by an independent read` };
      },
    },

    {
      name: 'learning.propose',
      description: 'Turn proposable patterns into candidate adaptations with expected benefit, risks, reversibility, validation criteria and the authorization they need. A candidate is never active and never authorizes anything. Write: user origin only.',
      inputHint: '{"minObservations":"optional 2-20"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['minObservations']);
        return { minObservations: minObservationsValue(o.minObservations) };
      },
      async execute(ctx, { minObservations }) {
        const result = await service.propose({
          minObservations,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const created = result.created.map((record) => ({
          id: record.id,
          capability: record.capability,
          rule: record.rule,
          method: record.method,
          pattern: record.proposal.pattern,
          guidance: record.proposal.guidance,
          expectedBenefit: record.proposal.expectedBenefit,
          risks: record.proposal.risks,
          reversibility: record.proposal.reversibility,
          validationCriteria: record.proposal.validationCriteria,
          requiredAuthorization: record.proposal.requiredAuthorization,
          support: record.support,
        }));
        return {
          summary: created.length === 0
            ? `no candidate proposed (${result.skipped.length} pattern(s) reported but not proposable)`
            : `proposed ${created.length} candidate adaptation(s) for your decision`,
          data: { created, skipped: result.skipped, considered: result.considered, truncated: result.truncated },
          display: [
            created.length === 0 ? 'No candidate adaptation was proposed.' : `Proposed ${created.length} candidate(s):`,
            ...created.map((c) => `  [${shortId(c.id)}] scope ${c.capability} | ${c.rule}\n`
              + `      pattern: ${c.pattern.kind} over ${c.pattern.observations} observation(s), ${c.pattern.supporting} supporting, ${c.pattern.contradicting} contradicting\n`
              + `      expected: ${c.expectedBenefit.statement}\n`
              + `      risks: ${c.risks.length} recorded${c.risks.length ? `; first: ${c.risks[0]}` : ''}\n`
              + `      reversible: ${c.reversibility} | judged by: ${c.validationCriteria.metric} over at least ${c.validationCriteria.minObservations} observation(s)\n`
              + `      requires: ${c.requiredAuthorization} | NOT APPROVED`),
            result.skipped.length === 0 ? null : `Not proposed: ${result.skipped.map((s) => `${s.capability} ${s.kind}: ${s.reason}`).join('; ')}`,
            'A candidate is a bounded restatement of recorded evidence, never an instruction. Nothing takes effect until you approve it.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { minObservations }, result) {
        for (const created of result.data.created) {
          const detail = await experience.adaptationDetail(created.id);
          if (!detail) return { ok: false, detail: `candidate ${shortId(created.id)} is not in the store after the proposal` };
          if (detail.decisionState !== 'candidate' || detail.stage !== 'evaluated') {
            return { ok: false, detail: `candidate ${shortId(created.id)} is reported ${detail.stage}, not an unapproved evaluated proposal` };
          }
          if (detail.active) return { ok: false, detail: `candidate ${shortId(created.id)} is active without a user decision` };
          if (detail.proposal?.requiredAuthorization !== 'user_approval') {
            return { ok: false, detail: `candidate ${shortId(created.id)} does not require the user's authorization` };
          }
          if (!detail.proposal?.reversibility) return { ok: false, detail: `candidate ${shortId(created.id)} states no reversibility` };
          const active = await experience.activeAdaptations({ capability: detail.capability, limit: 20 });
          if (active.adaptations.some((a) => a.id === detail.id)) {
            return { ok: false, detail: `candidate ${shortId(created.id)} is already offered as an active rule` };
          }
        }
        const fresh = await service.proposedSpecs({ minObservations });
        if (fresh.specs.length > 0) {
          return { ok: false, detail: `${fresh.specs.length} further candidate(s) could be derived from the same records; the derivation is not idempotent` };
        }
        return { ok: true, detail: `${result.data.created.length} candidate(s) present, unapproved and not in force; re-derivation added none` };
      },
    },

    {
      name: 'learning.measure',
      description: 'Compare the recorded outcomes of one approved adaptation before and after your decision to approve it, and record the measurement. It changes nothing about the adaptation. Write: user origin only.',
      inputHint: '{"target":"adaptation id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target']);
        return { target: recordRef(o.target, 'target') };
      },
      async execute(ctx, { target }) {
        const { record, adaptation } = await service.measure({
          target,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        return {
          summary: `recorded measurement ${shortId(record.id)} for adaptation ${shortId(adaptation.id)}: ${record.verdict}`,
          data: {
            id: record.id,
            targetId: adaptation.id,
            capability: adaptation.capability,
            rule: adaptation.rule,
            verdict: record.verdict,
            baseline: record.baseline,
            followUp: record.followUp,
            minObservations: record.minObservations,
            limitations: record.limitations,
          },
          display: [
            `Measurement ${shortId(record.id)} of adaptation ${shortId(adaptation.id)} (${adaptation.capability}): ${VERDICT_LABEL[record.verdict]}`,
            `  rule: ${adaptation.rule}`,
            `  before your approval: ${record.baseline.achieved} achieved of ${record.baseline.observations} determinate outcome(s) (${record.baseline.partiallyAchieved} partial, ${record.baseline.notAchieved} not achieved)`,
            `  after your approval:  ${record.followUp.achieved} achieved of ${record.followUp.observations} determinate outcome(s) (${record.followUp.partiallyAchieved} partial, ${record.followUp.notAchieved} not achieved)`,
            record.verdict === 'insufficient_evidence'
              ? `  each window needs ${record.minObservations} determinate outcome(s); this is not a finding either way`
              : null,
            ...record.limitations.slice(0, MAX_LIMITATIONS).map((text) => `  limitation: ${text}`),
            record.verdict === 'regressed'
              ? 'A regression is recorded. It changes nothing by itself: rolling the rule back is your decision, and "learning rollback" refuses unless a measurement recorded one.'
              : 'The measurement changes nothing about the adaptation. Only a measurement that recorded a regression can support a rollback.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const detail = await experience.adaptationDetail(result.data.targetId);
        if (!detail) return { ok: false, detail: 'the measured adaptation cannot be read back' };
        if (detail.measurement?.id !== result.data.id) {
          return { ok: false, detail: 'the stored measurement is not the one this read reports' };
        }
        if (detail.measurement.verdict !== result.data.verdict) {
          return { ok: false, detail: 'the stored verdict differs from the measurement that was recorded' };
        }
        if (detail.rolledBack) return { ok: false, detail: 'the adaptation was rolled back while this measurement was being recorded' };
        if (detail.active !== true) return { ok: false, detail: `the measured rule is not in force (${detail.inactiveReason ?? detail.stage})` };
        return { ok: true, detail: `measurement confirmed as the latest for that adaptation; ${detail.measurementCount} measurement(s) readable` };
      },
    },

    {
      name: 'learning.rollback',
      description: 'Take one approved adaptation out of force because a recorded measurement showed a regression. The approval, the rule and the evidence stay in the log. Write: user origin only.',
      inputHint: '{"target":"adaptation id","measurement":"optional measurement id","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'measurement', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          measurement: optionalRef(o.measurement, 'measurement'),
          reason: o.reason === undefined || o.reason === null ? null : textField(o.reason, 'reason', 500),
        };
      },
      async execute(ctx, { target, measurement, reason }) {
        const { record, adaptation, measurement: evidence } = await service.rollback({
          target,
          measurement,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        return {
          summary: `rolled back adaptation ${shortId(adaptation.id)} on measurement ${shortId(evidence.id)}`,
          data: {
            rollbackId: record.id,
            targetId: adaptation.id,
            capability: adaptation.capability,
            rule: adaptation.rule,
            measurementId: evidence.id,
            verdict: evidence.verdict,
            reason: record.reason ?? null,
            stageBefore: adaptation.stage,
          },
          display: [
            `Rolled back adaptation ${shortId(adaptation.id)}: ${adaptation.capability} | ${adaptation.rule}`,
            `  evidence: measurement ${shortId(evidence.id)} recorded ${evidence.verdict} (${evidence.baseline.achieved}/${evidence.baseline.observations} before, ${evidence.followUp.achieved}/${evidence.followUp.observations} after)`,
            '  the approval, the rule, the measurement and the supporting records all stay in the log',
            'It is no longer in force. No gate, authorization, or permission changed, and nothing was deleted.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { measurement }, result) {
        const detail = await experience.adaptationDetail(result.data.targetId);
        if (!detail) return { ok: false, detail: 'the rolled-back adaptation cannot be read back' };
        if (detail.rolledBack !== true) return { ok: false, detail: 'the adaptation is not reported rolled back' };
        if (detail.active !== false) return { ok: false, detail: 'a rolled-back adaptation is still reported in force' };
        if (detail.rollback?.id !== result.data.rollbackId) {
          return { ok: false, detail: 'the stored rollback differs from the write result' };
        }
        if (measurement !== null && detail.rollback.measurementId !== result.data.measurementId) {
          return { ok: false, detail: 'the rollback does not name the measurement it was asked to rest on' };
        }
        if (detail.decisionState !== 'approved') {
          return { ok: false, detail: 'the rollback altered the approval; it must leave it as recorded' };
        }
        const active = await experience.activeAdaptations({ limit: 20 });
        if (active.adaptations.some((a) => a.id === detail.id)) {
          return { ok: false, detail: 'a rolled-back rule is still offered to future comparisons' };
        }
        return { ok: true, detail: 'rollback confirmed; the rule is out of force and its history is intact' };
      },
    },

    {
      name: 'learning.status',
      description: 'What APEX learned from recorded outcomes: the evaluations, the patterns, what it proposes, whether that is authorised, whether it was measured as an improvement, and what was rejected or rolled back. Read-only.',
      inputHint: '{"limit":"optional 1-40"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: limitValue(o.limit, { max: MAX_EVALUATIONS, fallback: 10 }) };
      },
      async execute(_ctx, { limit }) {
        const report = await service.status({ limit });
        return {
          summary: `${report.evaluations.total} evaluation(s), ${report.patterns.total} pattern(s), ${report.adaptations.total} adaptation record(s)`,
          data: report,
          display: [
            report.hasEvidence
              ? `Outcomes: ${report.evaluations.total} recorded evaluation(s) - ${report.evaluations.counts.achieved} achieved, ${report.evaluations.counts.partially_achieved} partially achieved, ${report.evaluations.counts.not_achieved} not achieved, ${report.evaluations.counts.indeterminate} indeterminate`
              : 'Outcomes: no run has been evaluated yet. Record one with "learning observe <plan>".',
            `Patterns: ${report.patterns.total} (${report.patterns.proposable} proposable)${report.patterns.truncated ? ', bounded read' : ''}`,
            ...report.patterns.kinds.slice(0, 8).map((p) => `  ${p.kind}: ${p.capability}${p.objectiveKey ? ` (objective ${p.objectiveKey})` : ''} | confidence ${p.confidence}`),
            `Adaptations: ${report.adaptations.total} record(s) - ${Object.entries(report.adaptations.stages).map(([stage, n]) => `${n} ${stage}`).join(', ') || 'none'}`,
            ...report.adaptations.rows.map((row) => `  [${shortId(row.id)}] ${row.capability} | ${row.stage}${row.active ? ' (in force)' : ''}`
              + `${row.objectiveKey ? ` | objective ${row.objectiveKey}` : ''}`
              + `${row.measurement ? ` | measured ${row.measurement.verdict}: ${row.measurement.baseline} before, ${row.measurement.followUp} after` : ''}`
              + `${row.rolledBack ? ' | rolled back' : ''}`),
            'An authorised rule changes how one comparison is ordered and authorizes nothing. A measurement compares counts before and after; it does not establish that the rule caused the difference.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const fresh = await service.status({ limit: 1 });
        if (fresh.evaluations.total !== result.data.evaluations.total) {
          return { ok: false, detail: `read ${result.data.evaluations.total} evaluation(s); an independent read gives ${fresh.evaluations.total}` };
        }
        if (fresh.adaptations.total !== result.data.adaptations.total) {
          return { ok: false, detail: `read ${result.data.adaptations.total} adaptation record(s); an independent read gives ${fresh.adaptations.total}` };
        }
        return { ok: true, detail: `${fresh.evaluations.total} evaluation(s) and ${fresh.adaptations.total} adaptation record(s) confirmed` };
      },
    },
  ];
}
