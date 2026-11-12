// Plan actions: the user-facing surface of the plan store.
//
// A plan records intent, steps, assumptions, and risk. It is not permission: approval validates
// the plan against the live registry, and every step is authorized again when a task runs it.
// Every write here is user-origin only and unplannable, so a model cannot author, revise, or
// approve a plan.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { STEP_ID_RE, StepStatus } from '../tasks/model.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import {
  ASSERTION_KINDS,
  WORLD_ASSERTION_KINDS,
  ASSESSMENT_ASPECTS,
  MAX_CANDIDATES_PER_GOAL,
  MAX_ESTIMATE_SECONDS,
  MAX_PLAN_OUTCOME_CHARS,
  MAX_PRECONDITIONS,
  MAX_PRECONDITION_CHARS,
  MAX_ASSERTION_CHARS,
  MAX_ASSERTIONS,
  MAX_EXPECTED_CHARS,
  MAX_VERIFICATION_CHARS,
  MAX_RECOVERY_CHARS,
  REVERSIBILITY_LEVELS,
  RISK_LEVELS,
  PlanStatus,
  planContentHash,
  validatePlanContent,
} from '../plans/model.js';
import { renderPlan } from '../plans/format.js';
import { candidatesForGoal, revisedCandidates, renderCandidates } from '../plans/candidates.js';
import { evaluateCandidates, renderAdaptationDecision, renderEvaluation } from '../plans/evaluation.js';
import {
  constraintDigest, constraintLedger, planConstraintFinding, readConstraintRecords, renderConstraints,
} from '../plans/constraints.js';
import { emptyGuidance, guidanceDigest, guidanceFrom, renderGuidance } from '../plans/guidance.js';
import { outcomesAudit, outcomesForGoal } from '../plans/outcomes.js';
import { assessGoal, completionConsistency } from '../goals/assess.js';
import { assessOutcome, renderAssessment, VERDICT_RULE } from '../plans/assessment.js';
import { learningScope, learningDigest, readLearning, renderLearning, adaptationRow } from '../executive/learning.js';

// How many adaptation records, in any state, one comparison reads for guidance. The store bounds the
// read; this bounds the answer, and a guidance ledger that had to truncate would say so in its own
// record list rather than rank on a partial view of the user's approvals.
const MAX_GUIDANCE_READ = 25;

function assertNoSecret(value, name) {
  if (containsSecret(String(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

function textField(value, name, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  assertNoSecret(t, name);
  return t;
}

function optionalTextField(value, name, max) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function parseStep(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`step ${i + 1} is not an object`);
  const allowed = ['id', 'description', 'action', 'input', 'dependsOn', 'expectedResult', 'verification', 'criterion', 'criterionId', 'risk', 'estimate', 'estimateSeconds', 'reversibility', 'recovery'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ValidationError(`step ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
  }
  const id = raw.id === undefined ? `s${i + 1}` : String(raw.id).trim();
  if (!STEP_ID_RE.test(id)) throw new ValidationError(`step ${i + 1}: id must be lowercase letters, digits, or underscores`);
  if (typeof raw.action !== 'string' || raw.action.trim().length === 0) throw new ValidationError(`step ${i + 1}: action is required`);
  const input = raw.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(`step ${i + 1}: input must be an object`);
  if (!Array.isArray(raw.dependsOn ?? [])) throw new ValidationError(`step ${i + 1}: dependsOn must be a list`);
  const risk = raw.risk ?? 'medium';
  if (!RISK_LEVELS.includes(risk)) throw new ValidationError(`step ${i + 1}: risk must be low, medium, or high`);
  if (raw.reversibility !== undefined && raw.reversibility !== null && !REVERSIBILITY_LEVELS.includes(raw.reversibility)) {
    throw new ValidationError(`step ${i + 1}: reversibility must be one of: ${REVERSIBILITY_LEVELS.join(', ')}`);
  }
  let seconds = null;
  if (raw.estimateSeconds !== undefined && raw.estimateSeconds !== null) {
    if (!Number.isInteger(raw.estimateSeconds) || raw.estimateSeconds < 0 || raw.estimateSeconds > MAX_ESTIMATE_SECONDS) {
      throw new ValidationError(`step ${i + 1}: estimateSeconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
    }
    seconds = raw.estimateSeconds;
  } else if (raw.estimate && Number.isInteger(raw.estimate.seconds)) {
    seconds = raw.estimate.seconds;
  }
  return {
    id,
    description: textField(raw.description, `step ${i + 1} description`, MAX_EXPECTED_CHARS),
    action: raw.action.trim(),
    input,
    dependsOn: (raw.dependsOn ?? []).map((d) => String(d).trim()),
    expectedResult: textField(raw.expectedResult, `step ${i + 1} expected result`, MAX_EXPECTED_CHARS),
    verification: textField(raw.verification, `step ${i + 1} verification`, MAX_VERIFICATION_CHARS),
    criterionId: raw.criterionId ?? raw.criterion ?? null,
    risk,
    estimate: { seconds },
    // Recorded only when given, so a step without these fields keeps the bytes it had before
    // these fields existed, and therefore keeps any approval already bound to them.
    ...(raw.reversibility === undefined || raw.reversibility === null
      ? {}
      : { reversibility: raw.reversibility }),
    ...(raw.recovery === undefined || raw.recovery === null
      ? {}
      : { recovery: textField(raw.recovery, `step ${i + 1} recovery`, MAX_RECOVERY_CHARS) }),
  };
}

function parseContent(input) {
  const outcome = textField(input.outcome, 'intended outcome', MAX_PLAN_OUTCOME_CHARS);
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new ValidationError('at least one step is required');
  const steps = input.steps.map(parseStep);
  const preconditions = input.preconditions ?? [];
  if (!Array.isArray(preconditions)) throw new ValidationError('preconditions must be a list');
  if (preconditions.length > MAX_PRECONDITIONS) throw new ValidationError(`at most ${MAX_PRECONDITIONS} preconditions are allowed`);
  const cleanPreconditions = preconditions.map((p, i) => textField(p, `precondition ${i + 1}`, MAX_PRECONDITION_CHARS));
  const assertions = input.assertions ?? [];
  if (!Array.isArray(assertions)) throw new ValidationError('assertions must be a list');
  if (assertions.length > MAX_ASSERTIONS) throw new ValidationError(`at most ${MAX_ASSERTIONS} assertions are allowed`);
  const cleanAssertions = assertions.map((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ValidationError(`assertion ${i + 1} is not an object`);
    for (const key of Object.keys(a)) {
      if (!['kind', 'text', 'ref', 'expected'].includes(key)) throw new ValidationError(`assertion ${i + 1}: unexpected field "${singleLine(key, 40)}"`);
    }
    if (!ASSERTION_KINDS.includes(a.kind)) throw new ValidationError(`assertion ${i + 1}: kind must be one of: ${ASSERTION_KINDS.join(', ')}`);
    if (a.expected !== undefined && a.expected !== null && !WORLD_ASSERTION_KINDS.includes(a.kind)) {
      throw new ValidationError(`assertion ${i + 1}: only a world_fact or world_entity assertion can carry an expected value`);
    }
    return {
      kind: a.kind,
      text: textField(a.text, `assertion ${i + 1}`, MAX_ASSERTION_CHARS),
      ref: a.ref === undefined || a.ref === null ? null : textField(a.ref, `assertion ${i + 1} reference`, 64),
      ...(a.expected === undefined || a.expected === null
        ? {}
        : { expected: textField(a.expected, `assertion ${i + 1} expected value`, MAX_ASSERTION_CHARS) }),
    };
  });
  let resources = { estimatedSeconds: null };
  if (input.estimatedSeconds !== undefined && input.estimatedSeconds !== null) {
    if (!Number.isInteger(input.estimatedSeconds) || input.estimatedSeconds < 0 || input.estimatedSeconds > MAX_ESTIMATE_SECONDS) {
      throw new ValidationError(`estimatedSeconds must be an integer from 0 to ${MAX_ESTIMATE_SECONDS}`);
    }
    resources = { estimatedSeconds: input.estimatedSeconds };
  }
  const content = { outcome, steps, preconditions: cleanPreconditions, assertions: cleanAssertions, resources };
  const problems = validatePlanContent(content);
  if (problems.length > 0) throw new ValidationError(`the plan is not valid: ${problems.join('; ')}`);
  return content;
}

function validationNote(validation) {
  if (!validation) return null;
  if (validation.ok) {
    return `Validation: passed. ${validation.steps} step(s): ${validation.reads} read, ${validation.writes} write; risk ${validation.risk}.`;
  }
  return [
    'Validation: NOT passed. The plan is stored as a draft, but it cannot be approved or run until these are resolved:',
    ...validation.problems.map((p) => `  - ${p}`),
  ].join('\n');
}

// The candidate and replanning routes read; they never write. Both of them need the live registry,
// because a step APEX cannot check against a registered capability is a step it must not offer.
function registryFor(ctx) {
  if (!ctx?.registry || typeof ctx.registry.get !== 'function') {
    throw new ValidationError(
      'the action registry is not available to this request, so no capability could be checked and no candidate could be compared',
    );
  }
  return ctx.registry;
}

async function goalForRead(ctx, ref) {
  if (!ctx?.goals || typeof ctx.goals.resolve !== 'function') {
    throw new ValidationError('the goal store is not available to this request, so the goal could not be read');
  }
  return ctx.goals.resolve(ref);
}

// What the records of past attempts say about the capabilities these steps actually name, attached to a
// read as disclosure. It is kept out of the comparison on purpose: no gate, ranked dimension, score, or
// candidate digest is computed from it, because a heuristic informed by the user's expectation would
// present that expectation as a fact about the world. A store this configuration does not have is
// reported by the read as unavailable rather than as empty, so the absence says which it is.
async function learningFor(store, ctx, { candidates = [], prior = null, goalId = null, excludePlanId = null }) {
  return readLearning({
    predictions: ctx?.predictions ?? null,
    experience: ctx?.experience ?? null,
    plans: store,
    scope: learningScope(candidates, prior),
    goalId,
    excludePlanId,
  });
}

// The ledger of what the records say stands in the way of this goal: the goal's own blockers,
// prerequisites, dependencies, evidence conditions and limits, with the records they cite actually
// read. A comparison gates on it and prints it, because an obstacle that changed the answer has to be
// visible in the answer - and a record that could not be read is reported as unread rather than as an
// absence.
async function constraintsFor(ctx, registry, goal, evidence) {
  const { cited, dependencies } = await readConstraintRecords({
    goal,
    registry,
    goals: ctx?.goals ?? null,
    knowledge: ctx?.knowledge ?? null,
    memory: ctx?.memory ?? null,
    experience: ctx?.experience ?? null,
  });
  return constraintLedger({ goal, registry, evidence, cited, dependencies });
}

// Whether a goal the record calls completed still rests on the evidence it was closed against. Read
// only for a completed goal - every other status has no completion to lose - and handed to the
// comparison, which cannot open the audit or knowledge stores itself. `holds: null` means the check
// could not be made, and the gate says so rather than reporting a settled goal.
async function goalEvidenceFor(store, ctx, goal) {
  if (goal?.status !== 'completed') return null;
  const assessment = await assessGoal(goal, {
    knowledge: ctx?.knowledge ?? null,
    operations: ctx?.operations ?? null,
    plans: store,
  });
  return completionConsistency(goal, assessment);
}

// The guidance ledger for one comparison. It reads every adaptation state the store holds for the
// capabilities these candidates name - not only the active ones the disclosure block shows - because
// "an unapproved rule changed nothing" is a claim about a specific record, and a read that never looked
// at that record could not make it. Bounded by the store's own limit, and a store this configuration
// cannot read is reported as unread rather than as nothing recorded.
async function guidanceFor(ctx, registry, candidates, { instructionRefusals = [] } = {}) {
  const scope = learningScope(candidates, null);
  const store = ctx?.experience;
  if (!store || typeof store.adaptations !== 'function') {
    return emptyGuidance('no experience store is configured in this build', candidates);
  }
  let rows;
  try {
    const all = await store.adaptations({ limit: MAX_GUIDANCE_READ, includeRetired: true });
    rows = (all ?? []).filter((a) => scope.capabilities.includes(a.capability)).map(adaptationRow);
  } catch (err) {
    return emptyGuidance(`the experience log could not be read (${err?.code ?? 'store error'})`, candidates);
  }
  return guidanceFrom({ adaptations: rows, candidates, registry, instructionRefusals });
}

// The audit shape: which record said what, in which class, and whether it was able to stop work. The
// digest is what an independent re-read is compared against, so a difference means a record moved
// rather than a sentence was rephrased.
function constraintAudit(ledger) {
  return {
    schema: ledger.schema,
    goalId: ledger.goalId,
    goalRevision: ledger.goalRevision,
    goalStatus: ledger.goalStatus,
    recordsRead: ledger.recordsRead,
    constraints: ledger.constraints.map((c) => ({
      id: c.id,
      class: c.class,
      field: c.field,
      text: c.text,
      capability: c.capability,
      gates: c.gates,
      why: c.why,
      resolution: c.resolution,
      record: c.record,
    })),
    cleared: ledger.cleared,
    unavailable: ledger.unavailable,
    digest: constraintDigest(ledger),
    note: ledger.note,
  };
}

// The revalidation an approval has to pass. An approval binds the plan's bytes and nothing else, so a
// blocker recorded after the plan was written, a prerequisite whose discharging record has been
// retracted, and a dependency that has moved are all answers the approval does not carry: they stop the
// approval here rather than surfacing as a task that failed for a reason the plan could have read.
async function assertConstraintsCleared(ctx, store, plan) {
  if (!plan?.goalId) return;
  const registry = store?.registry ?? null;
  if (!registry || typeof ctx?.goals?.get !== 'function') return;
  const goal = await ctx.goals.get(plan.goalId);
  if (!goal) return;
  const { finding } = await planConstraintFinding(plan, {
    goal,
    registry,
    goals: ctx.goals,
    knowledge: ctx?.knowledge ?? null,
    memory: ctx?.memory ?? null,
    experience: ctx?.experience ?? null,
  });
  if (finding.blockedBy.length === 0) return;
  throw new ValidationError(
    `approval refused: ${finding.blockedBy.map((b) => `${b.class} "${b.text}" stops ${b.steps.join(', ')} (recorded on ${b.record.store}${b.record.goalId ? ` ${shortId(b.record.goalId)}` : ''}); what would clear it: ${b.resolution}`).join('; ')}`,
    'CONSTRAINT_BLOCKED',
  );
}

// The audit shape for the guidance ledger: the records, what each was allowed to do, and which fields
// each candidate met - ids and states only, never the prose, so a difference between two reads means a
// record moved rather than that a rule was rephrased.
function guidanceAudit(guidance) {
  return {
    schema: guidance.schema,
    note: guidance.note,
    applicable: guidance.applicable,
    influencesSelection: guidance.influencesSelection,
    inert: guidance.inert.map((i) => ({ id: i.id, state: i.state, why: i.why })),
    records: guidance.records.map((r) => ({
      id: r.id,
      capability: r.capability,
      rule: r.rule,
      ruleHash: r.ruleHash ?? null,
      // Which recorded statement of the rule was in force: the store keeps every shape the user recorded
      // and the last one wins, so an influenced decision that names a version can be traced to the
      // statement, not only to the adaptation.
      version: r.version ?? null,
      state: r.state,
      why: r.why,
      decisionState: r.decisionState,
      active: r.active,
      supportCount: r.supportCount,
      support: r.support ?? { experienceIds: [], feedbackIds: [] },
      decidedAt: r.decidedAt,
      conflicts: r.conflicts,
      guidance: r.guidance,
    })),
    conflicts: guidance.conflicts,
    candidates: guidance.candidates.map((r) => ({
      strategy: r.strategy,
      digest: r.digest,
      value: r.value,
      met: r.met,
      unmet: r.unmet,
      outranked: r.outranked,
      notCheckable: r.notCheckable,
    })),
    digest: guidance.digest,
  };
}

function cannotUseOf(value) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) throw new ValidationError('cannot_use must be a list of action names');
  if (value.length > MAX_PRECONDITIONS) throw new ValidationError(`cannot_use may name at most ${MAX_PRECONDITIONS} actions`);
  return [...new Set(value.map((n) => textField(n, 'an action in cannot_use', 64)))];
}

// A name the registry does not hold is refused rather than ignored: an ignored typo would leave the
// excluded capability in the plan, which is the one thing the constraint was asked to prevent.
function assertKnownActions(registry, names) {
  const unknown = names.filter((n) => !registry.get(n));
  if (unknown.length > 0) {
    throw new ValidationError(
      `cannot_use names an action this configuration does not register: ${unknown.join(', ')}`,
    );
  }
  return names;
}

// The compact form of a comparison, for the audit record: what was included, what was gated out and
// why, where each candidate landed, and the digests the statement is bound to. The per-candidate
// bands are long and are printed rather than stored twice.
// Only what the ranking actually consumed: whether the outcomes were read at all, how many records
// reached it, which capabilities they name, and whether the bounded read had to stop short. The count
// of plan records looked at is printed for the reader, but a new draft with no step outcome recorded
// changes nobody's band, so refusing a re-read over it would be refusing a question nobody asked.
const outcomesRankingShape = (audit) => JSON.stringify([
  audit.read === true, audit.records, audit.truncated === true, [...audit.capabilities].sort(),
]);

function comparisonOf(evaluation) {
  return {
    ok: evaluation.ok,
    reason: evaluation.reason,
    problems: evaluation.problems ?? [],
    rule: evaluation.rule,
    gates: evaluation.gates,
    rankedDimensions: evaluation.rankedDimensions,
    disclosedDimensions: evaluation.disclosedDimensions,
    // Which records were able to stop work, how many were only reported, and what could not be
    // checked: the counts an auditor needs to notice that an answer changed, with the ids of the
    // gating ones so a refusal can be traced to the record it cites.
    constraints: evaluation.constraints
      ? {
        gating: evaluation.constraints.gating,
        reported: evaluation.constraints.disclosed.length,
        satisfied: evaluation.constraints.cleared.length,
        unestablished: evaluation.constraints.unavailable,
        digest: constraintDigest(evaluation.constraints),
      }
      : null,
    // What moved the ordering, in the records' own names: which approved guidance shaped it, which
    // disagreed with itself, and the digest an independent re-read is checked against.
    guidance: evaluation.guidance
      ? {
        applicable: evaluation.guidance.applicable,
        influencesSelection: evaluation.guidance.influencesSelection,
        conflicts: (evaluation.guidance.conflicts ?? []).map((c) => c.between),
        digest: evaluation.guidance.digest,
      }
      : null,
    // Whether this ranking saw what past runs of these capabilities left on record, how many plan
    // records that read looked at, and whether it had to stop short. A comparison that ranked on no
    // history says so here, so an unread record list cannot be read as "the records show no failures".
    outcomes: evaluation.outcomesRead ?? { read: false, records: 0, plans: 0, truncated: false, capabilities: [] },
    // Whether a completed goal's proof was re-read for this comparison, and what that re-read said.
    goalEvidence: evaluation.goalEvidenceRead ?? null,
    included: evaluation.included,
    excluded: evaluation.excluded,
    front: evaluation.front,
    behind: evaluation.behind,
    leading: evaluation.selection?.leading ?? null,
    basis: evaluation.selection?.basis ?? null,
    unresolvedTradeOff: evaluation.selection?.unresolvedTradeOff ?? false,
    tradeOffs: (evaluation.selection?.tradeOffs ?? []).map((t) => t.statement),
    ties: (evaluation.selection?.ties ?? []).map((t) => t.statement),
    clarificationNeeded: evaluation.clarificationNeeded,
    whatWouldSettleIt: evaluation.whatWouldSettleIt,
    boundTo: evaluation.boundTo,
    approved: false,
    executable: false,
    note: evaluation.note,
  };
}

const candidateRows = (rows) => rows.map((c) => ({
  strategy: c.strategy,
  digest: c.digest,
  steps: c.steps,
  writes: c.writes,
  risk: c.risk,
  criteriaCovered: c.criteriaCovered,
  validation: c.validation,
}));

function occupancyNote(occupancy) {
  return [
    `The plan store holds ${occupancy.drafts.length} draft candidate(s) for this goal of at most ${occupancy.maxDrafts}, and ${occupancy.live.length} live plan(s) (approved, active, or blocked).`,
    `It would accept ${occupancy.draftsRemaining} more draft(s) for this goal.`,
    'Recording one is `plan.add`, and a second live plan for the same goal is refused; nothing here has recorded either.',
  ].join('\n');
}

// The failures this revision can answer, as the plan's own recorded outcomes name them. A step with no
// operation id is still refused as a capability, but is not cited as evidence: there is nothing to cite.
function failedOperationRecords(prior) {
  return Object.entries(prior.stepResults ?? {})
    .filter(([, r]) => r?.status === StepStatus.FAILED || r?.status === StepStatus.UNCERTAIN)
    .map(([stepId, r]) => ({
      operationId: r.operationId ?? '',
      detail: singleLine(
        `${prior.steps.find((s) => s.id === stepId)?.action ?? 'a step'} ${r.status}${r.detail ? `: ${r.detail}` : ''}`,
        MAX_ASSERTION_CHARS,
      ),
    }));
}

const planSnapshot = (plan) => ({
  version: plan.version,
  status: plan.status,
  contentHash: planContentHash(plan),
  updatedAt: plan.updatedAt,
});

// The outcome questions are answered from four records, not one: the plan's own step outcomes, the
// audit operation each step cites, the goal's criteria with the standing of their evidence, and what
// the knowledge and memory stores still hold of what the plan wrote. A store this configuration does
// not have is reported as unreadable by the assessment rather than assumed.
async function outcomeOf(store, ctx, planRef) {
  const plan = await store.resolve(planRef);
  let goal = null;
  if (plan.goalId && ctx?.goals && typeof ctx.goals.resolve === 'function') {
    goal = await ctx.goals.resolve(plan.goalId);
  }
  const assessment = await assessOutcome(plan, {
    goal,
    operations: ctx?.operations ?? null,
    knowledge: ctx?.knowledge ?? null,
    memory: ctx?.memory ?? null,
  });
  return { plan, assessment };
}

const findingRows = (findings = []) => findings.map((f) => ({
  aspect: f.aspect,
  statement: f.statement,
  operations: [...f.operations],
  ...(f.records?.length ? { records: [...f.records] } : {}),
}));

// Recorded assessments as a reader needs them to judge a new one: what was concluded, against which
// version, and whether it still describes the plan's current content.
const assessmentRows = (list = []) => list.map((a) => ({
  at: a.at,
  verdict: a.verdict,
  planVersion: a.planVersion,
  contentHash: a.contentHash,
  stale: a.stale === true,
  summary: a.summary,
  findings: (a.findings ?? []).length,
}));

// Two findings are the same finding when they answer the same question from the same operations. The
// statement itself is prose, so the citation is what a repeat read is compared on.
const citedShape = (findings = []) => findings
  .map((f) => `${f.aspect}:${[...(f.operations ?? [])].join('|')}`)
  .join(',');

const approvalShape = (plan) => `${plan.approval?.version ?? '-'}:${plan.approval?.contentHash ?? '-'}`;

export function planActions(store) {
  if (!store || typeof store.createPlan !== 'function') {
    throw new TypeError('planActions requires a plan store');
  }
  return [
    {
      name: 'plan.add',
      description: 'Record an executive plan for a goal: ordered steps with dependencies, expected results, verification requirements, risk, preconditions, and classified assumptions. A plan is a proposal, not permission. Write: user origin only.',
      inputHint: '{"goal":"optional goal id","outcome":"intended outcome","steps":[{"id":"s1","description":"...","action":"memory.add","input":{},"dependsOn":[],"expectedResult":"...","verification":"...","criterion":"optional c1","risk":"low|medium|high","estimateSeconds":10,"reversibility":"read_only|reversible|not_reversible|unknown","recovery":"optional: what to do if this step fails"}],"preconditions":[],"assertions":[{"kind":"user_fact|stored_knowledge|retrieved_evidence|world_fact|world_entity|inference|unknown","text":"...","ref":"record id","expected":"optional live value to compare"}],"estimatedSeconds":30,"reason":"optional"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['goal', 'goalId', 'outcome', 'steps', 'preconditions', 'assertions', 'estimatedSeconds', 'reason']);
        return {
          goalId: o.goalId ?? o.goal ?? null,
          ...parseContent(o),
          reason: optionalTextField(o.reason, 'reason', 500),
        };
      },
      async execute(_ctx, { goalId, outcome, steps, preconditions, assertions, resources, reason }) {
        const { plan, linkError } = await store.createPlan({ goalId, outcome, steps, preconditions, assertions, resources, reason });
        const validation = store.validatePlan(plan);
        return {
          summary: `recorded plan ${shortId(plan.id)} v${plan.version} for ${goalId ? `goal ${shortId(goalId)}` : 'no goal'}; ${plan.steps.length} step(s)`,
          data: { planId: plan.id, version: plan.version, status: plan.status, goalId: plan.goalId, validation, linkError },
          display: [
            renderPlan(plan),
            validationNote(validation),
            linkError ? `Note: the plan is stored, but the goal's plan index could not be updated (${linkError}).` : null,
            'Nothing has run. Approval is separate, and approval still authorizes nothing by itself.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(ctx, { goalId, outcome, steps }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the recorded plan cannot be read back' };
        if (plan.outcome !== outcome) return { ok: false, detail: 'stored outcome differs from the request' };
        // The store stores the full id it resolved a short reference to, so the comparison
        // resolves the same reference rather than demanding the text be identical.
        let requestedGoalId = goalId ?? null;
        if (requestedGoalId && ctx.goals?.resolve) {
          try {
            requestedGoalId = (await ctx.goals.resolve(requestedGoalId)).id;
          } catch {
            return { ok: false, detail: 'the requested goal cannot be resolved to a recorded goal' };
          }
        }
        if ((plan.goalId ?? null) !== requestedGoalId) return { ok: false, detail: 'stored goal reference differs from the request' };
        if (plan.status !== PlanStatus.DRAFT) return { ok: false, detail: `the new plan is ${plan.status}, not draft` };
        if (plan.version !== 1) return { ok: false, detail: 'the new plan does not start at version 1' };
        if (plan.steps.length !== steps.length) return { ok: false, detail: 'stored step count differs from the request' };
        if (plan.steps.some((s, i) => s.id !== steps[i].id || s.action !== steps[i].action)) {
          return { ok: false, detail: 'stored steps differ from the request' };
        }
        if (plan.activation) return { ok: false, detail: 'a newly recorded plan already records an activation' };
        if (result.data.linkError === null && requestedGoalId && ctx.goals) {
          const goal = await ctx.goals.get(requestedGoalId);
          if (!goal || !goal.planIds.includes(plan.id)) return { ok: false, detail: 'the plan is not recorded on its goal' };
        }
        return { ok: true, detail: `plan present as a draft at v1; ${plan.steps.length} step(s); nothing has run` };
      },
    },

    {
      name: 'plan.revise',
      description: 'Replace a draft or blocked plan with a new version. The revision needs a reason, clears any approval, and must be approved again before it can be activated. Write: user origin only.',
      inputHint: '{"target":"plan id","outcome":"...","steps":[...],"preconditions":[],"assertions":[],"estimatedSeconds":30,"reason":"why the plan changed"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'outcome', 'steps', 'preconditions', 'assertions', 'estimatedSeconds', 'reason']);
        if (typeof o.target !== 'string') throw new ValidationError('target must be a plan id');
        return { target: o.target.trim(), ...parseContent(o), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, outcome, steps, preconditions, assertions, resources, reason }) {
        const { plan } = await store.revise(target, { outcome, steps, preconditions, assertions, resources, reason });
        const validation = store.validatePlan(plan);
        return {
          summary: `revised plan ${shortId(plan.id)} to v${plan.version}`,
          data: { planId: plan.id, version: plan.version, status: plan.status, validation },
          display: [
            renderPlan(plan),
            validationNote(validation),
            'Previous versions and their approvals remain in the log. This revision has no approval.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, { outcome, version: _ignored, steps }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the revised plan cannot be read back' };
        if (plan.version !== result.data.version) return { ok: false, detail: 'stored version differs from the revision result' };
        if (plan.outcome !== outcome) return { ok: false, detail: 'stored outcome differs from the revision' };
        if (plan.status !== PlanStatus.DRAFT) return { ok: false, detail: `the revision is ${plan.status}, not draft` };
        if (plan.approval) return { ok: false, detail: 'the revision inherited an approval' };
        if (plan.steps.length !== steps.length || plan.steps.some((s, i) => s.id !== steps[i].id)) {
          return { ok: false, detail: 'stored steps differ from the revision' };
        }
        return { ok: true, detail: `revision v${plan.version} present with all earlier versions preserved; no approval inherited` };
      },
    },

    {
      name: 'plan.approve',
      description: 'Approve a draft plan after validating it against the live action registry. Approval is bound to the plan content and authorizes no action by itself. Write: user origin only.',
      inputHint: '{"target":"plan id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        return { target: o.target.trim() };
      },
      async execute(ctx, { target }) {
        const draft = await store.resolve(target);
        await assertConstraintsCleared(ctx, store, draft);
        const { plan } = await store.approve(target);
        return {
          summary: `approved plan ${shortId(plan.id)} v${plan.version}`,
          data: { planId: plan.id, version: plan.version, status: plan.status, contentHash: plan.approval?.contentHash ?? null, validation: plan.validation },
          display: [
            `Approved plan ${shortId(plan.id)} v${plan.version}.`,
            `  content: ${String(plan.approval?.contentHash).slice(0, 16)} (approval is bound to these exact steps)`,
            validationNote(plan.validation),
            'Approval permits starting this plan. Every step is still authorized separately when it runs.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the approved plan cannot be read back' };
        if (plan.status !== PlanStatus.APPROVED) return { ok: false, detail: `plan is ${plan.status}, not approved` };
        if (!plan.approval) return { ok: false, detail: 'no approval record is present' };
        if (plan.approval.version !== plan.version) return { ok: false, detail: 'the approval names a different version' };
        if (plan.approval.contentHash !== planContentHash(plan)) return { ok: false, detail: 'the approval does not match the current plan content' };
        if (!plan.validation?.ok) return { ok: false, detail: 'the approved plan does not carry a passing validation record' };
        return { ok: true, detail: `approval confirmed for v${plan.version}; content hash matches; validation passed` };
      },
    },

    {
      name: 'plan.cancel',
      description: 'Cancel a draft, approved, active, blocked, or failed plan. This changes the plan record only; a task already created from it is not cancelled by this action. Write: user origin only.',
      inputHint: '{"target":"plan id","reason":"why it is cancelled"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        return { target: o.target.trim(), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, reason }) {
        const before = await store.resolve(target);
        const { plan } = await store.setStatus(target, PlanStatus.CANCELLED, { reason });
        return {
          summary: `cancelled plan ${shortId(plan.id)} (was ${before.status})`,
          data: { planId: plan.id, previousStatus: before.status, status: plan.status, taskId: plan.activation?.taskId ?? null },
          display: [
            `Plan ${shortId(plan.id)} is cancelled (was ${before.status}).`,
            plan.activation ? `  task ${shortId(plan.activation.taskId)} was created from this plan and is not cancelled by this action; cancel it separately if it should stop.` : '  no task was created from this plan.',
            'The plan history and any recorded outcomes remain readable.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { reason }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the cancelled plan cannot be read back' };
        if (plan.status !== PlanStatus.CANCELLED) return { ok: false, detail: `plan is ${plan.status}, not cancelled` };
        if (plan.cancelledReason !== reason) return { ok: false, detail: 'stored cancellation reason differs from the request' };
        return { ok: true, detail: 'cancellation confirmed; history and outcomes preserved' };
      },
    },

    {
      name: 'plan.supersede',
      description: 'Record that one plan is replaced by another. The replacement must be a recorded plan. Nothing is executed. Write: user origin only.',
      inputHint: '{"target":"plan id being replaced","by":"replacement plan id","reason":"why"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'by', 'reason']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        if (typeof o.by !== 'string' || o.by.trim().length === 0) throw new ValidationError('by must be a plan id');
        return { target: o.target.trim(), by: o.by.trim(), reason: textField(o.reason, 'reason', 500) };
      },
      async execute(_ctx, { target, by, reason }) {
        const { plan } = await store.setStatus(target, PlanStatus.SUPERSEDED, { reason, by });
        return {
          summary: `plan ${shortId(plan.id)} superseded by ${shortId(by)}`,
          data: { planId: plan.id, status: plan.status, supersededBy: plan.supersededBy },
          display: [
            `Plan ${shortId(plan.id)} is superseded by ${shortId(by)}.`,
            'The earlier plan and its history remain readable. Superseding does not execute or cancel anything.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { by }, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the superseded plan cannot be read back' };
        if (plan.status !== PlanStatus.SUPERSEDED) return { ok: false, detail: `plan is ${plan.status}, not superseded` };
        if (plan.supersededBy !== by) return { ok: false, detail: 'the recorded replacement differs from the request' };
        return { ok: true, detail: 'supersession confirmed; both plans remain readable' };
      },
    },

    {
      name: 'plan.candidates',
      description: 'Generate the candidate plans a recorded goal currently supports and compare them under a disclosed rule: hard gates first, then a Pareto comparison of what each candidate records. Read-only: nothing is recorded, approved, or started, and no step is invented.',
      inputHint: '{"goal":"goal id","work":"optional: the work these candidates are for","cannot_use":["optional registered action names this generation must not offer"]}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['goal', 'goalId', 'work', 'cannot_use']);
        const goalRef = o.goalId ?? o.goal;
        if (typeof goalRef !== 'string' || goalRef.trim().length === 0) throw new ValidationError('goal must be a goal id');
        return {
          goalRef: goalRef.trim(),
          work: optionalTextField(o.work, 'work', MAX_PLAN_OUTCOME_CHARS),
          cannotUse: cannotUseOf(o.cannot_use),
        };
      },
      async execute(ctx, { goalRef, work, cannotUse }) {
        const registry = registryFor(ctx);
        assertKnownActions(registry, cannotUse);
        const goal = await goalForRead(ctx, goalRef);
        const evidence = { unavailableActions: cannotUse, knownBlockers: [], failedOperations: [] };
        const constraints = await constraintsFor(ctx, registry, goal, evidence);
        const generated = candidatesForGoal({ goal, registry, evidence, workText: work, constraints });
        // Read after generation, because the capabilities the learning question is scoped to are the ones
        // the candidates name; before the comparison, because an approved guidance record is one of the
        // dimensions the comparison ranks on and it has to be on the table when the ranking is taken.
        const learning = await learningFor(store, ctx, { candidates: generated.candidates, goalId: goal.id });
        const guidance = await guidanceFor(ctx, registry, generated.candidates, { instructionRefusals: cannotUse });
        // The step outcomes the goal's own plan records hold, read once for the ranking that compares
        // these candidates against them. An empty list here is a read that found nothing; the audit
        // line keeps that separate from a store nobody opened.
        const outcomes = await outcomesForGoal(store, { goalId: goal.id });
        const goalEvidence = await goalEvidenceFor(store, ctx, goal);
        const evaluation = evaluateCandidates({ result: generated, goal, registry, evidence, constraints, guidance, outcomes, goalEvidence });
        const occupancy = await store.candidateState(goal.id);
        return {
          summary: `${generated.candidates.length} candidate plan(s) for goal ${shortId(goal.id)}; `
            + (evaluation.ok
              ? (evaluation.selection.leading
                ? `${evaluation.selection.leading} leads under the disclosed rule`
                : `${evaluation.front.length} remain, not separated by it`)
              : `none can be compared (${evaluation.reason})`),
          data: {
            goalId: goal.id,
            goalRevision: goal.revision,
            goalStatus: goal.status,
            work: work ?? null,
            cannotUse,
            occupancy,
            candidateSetDigest: evaluation.boundTo.candidateSetDigest,
            candidates: candidateRows(generated.candidates),
            clarificationNeeded: generated.clarificationNeeded,
            unaddressed: (generated.unaddressed ?? []).map((u) => ({ criterionId: u.criterionId ?? null, text: u.text })),
            assumedFromGoalRequest: (generated.assumedFromGoalRequest ?? []).map((a) => ({ criterionId: a.criterionId ?? null, text: a.text })),
            skipped: generated.skipped ?? [],
            refusedCapabilities: generated.refusedCapabilities ?? [],
            constraints: constraintAudit(constraints),
            guidance: guidanceAudit(guidance),
            comparison: comparisonOf(evaluation),
            // The one decision the approved records were allowed to move: the order the same rule produced
            // without them, the order it produced with them, the record ids and versions behind it, and the
            // explicit statement that it authorized nothing. Null means no comparison was made at all.
            adaptationDecision: evaluation.adaptationDecision ?? null,
            learning,
            recorded: false,
            approved: false,
            executable: false,
          },
          display: [
            renderCandidates(generated, { registry }),
            renderEvaluation(evaluation),
            renderConstraints(constraints),
            renderGuidance(guidance),
            renderAdaptationDecision(evaluation.adaptationDecision),
            occupancyNote(occupancy),
            renderLearning(learning),
            'No effort estimate appears above because the audit log holds no per-action duration to average; a number here would be a guess.',
            'These are drafts on screen. Recording one is plan.add, approving it is plan.approve, and both are user acts.',
          ].join('\n'),
        };
      },
      async verify(ctx, { goalRef, work, cannotUse }, result) {
        const registry = registryFor(ctx);
        const goal = await goalForRead(ctx, goalRef);
        const evidence = { unavailableActions: cannotUse, knownBlockers: [], failedOperations: [] };
        const constraints = await constraintsFor(ctx, registry, goal, evidence);
        const again = candidatesForGoal({ goal, registry, evidence, workText: work, constraints });
        const againLearning = await learningFor(store, ctx, { candidates: again.candidates, goalId: goal.id });
        const againGuidance = await guidanceFor(ctx, registry, again.candidates, { instructionRefusals: cannotUse });
        const againOutcomes = await outcomesForGoal(store, { goalId: goal.id });
        const compared = evaluateCandidates({
          result: again, goal, registry, evidence, constraints, guidance: againGuidance,
          outcomes: againOutcomes, goalEvidence: await goalEvidenceFor(store, ctx, goal),
        });
        if (compared.boundTo.candidateSetDigest !== result.data.candidateSetDigest) {
          return {
            ok: false,
            detail: 'an independent generation gives different candidate bytes, so this answer describes a goal, a registry, or a constraint that has since moved',
          };
        }
        if (constraintDigest(constraints) !== result.data.constraints.digest) {
          return {
            ok: false,
            detail: 'the constraints that gated these candidates no longer read the same: a blocker, prerequisite, dependency, or a record one of them cites has moved since this answer was read',
          };
        }
        if (againGuidance.digest !== result.data.guidance.digest) {
          return {
            ok: false,
            detail: 'the guidance that ranked these candidates no longer reads the same: an adaptation was approved or retired, a recorded shape changed, or two of the user\'s own records came to disagree while this answer was being read',
          };
        }
        if (outcomesRankingShape(outcomesAudit(againOutcomes)) !== outcomesRankingShape(result.data.comparison.outcomes)) {
          return {
            ok: false,
            detail: 'the recorded step outcomes these candidates were ranked against no longer read the same: a step of one of this goal\'s plans failed, stayed uncertain, or was recorded while this answer was being read',
          };
        }
        const occupancy = await store.candidateState(goal.id);
        if (occupancy.drafts.join(',') !== result.data.occupancy.drafts.join(',')) {
          return { ok: false, detail: 'the plan store now holds a different set of drafts for this goal than this read reported' };
        }
        if (learningDigest(againLearning) !== learningDigest(result.data.learning)) {
          return { ok: false, detail: 'the learning records disclosed with this comparison no longer read the same: an adaptation was decided, an expectation changed state, or an assessment was recorded while this answer was being read' };
        }
        return {
          ok: true,
          detail: `${again.candidates.length} candidate(s) reproduce byte for byte from the recorded goal, the live registry, and the constraints its records state; the store holds ${occupancy.drafts.length} draft(s) for this goal, none added by this read; the learning disclosure re-reads to the same records; the constraint ledger re-reads to the same records; the guidance ledger re-reads to the same records`,
        };
      },
    },

    {
      name: 'plan.replan',
      description: 'Generate and compare revised candidates for a recorded plan that has stopped being viable, answering only what the plan record and the audit log hold about its steps. Read-only: the plan being answered is left exactly as it was, and a revision needs fresh validation and fresh approval.',
      inputHint: '{"plan":"plan id","reason":"why this plan stopped being viable","cannot_use":["optional registered action names this revision must not offer"]}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['plan', 'planId', 'target', 'reason', 'cannot_use']);
        const planRef = o.plan ?? o.planId ?? o.target;
        if (typeof planRef !== 'string' || planRef.trim().length === 0) throw new ValidationError('plan must be a plan id');
        return { planRef: planRef.trim(), reason: textField(o.reason, 'reason', 500), cannotUse: cannotUseOf(o.cannot_use) };
      },
      async execute(ctx, { planRef, reason, cannotUse }) {
        const registry = registryFor(ctx);
        assertKnownActions(registry, cannotUse);
        const prior = await store.resolve(planRef);
        if (!prior.goalId) {
          throw new ValidationError(`plan ${shortId(prior.id)} records no goal, so a revision has no intention to revise an approach for`);
        }
        const goal = await goalForRead(ctx, prior.goalId);
        const failedOperations = failedOperationRecords(prior);
        const constraints = await constraintsFor(ctx, registry, goal, { unavailableActions: cannotUse, knownBlockers: [], failedOperations });
        const generated = revisedCandidates({
          goal,
          registry,
          prior,
          evidence: { unavailableActions: cannotUse, knownBlockers: [], failedOperations },
          reason,
          constraints,
        });
        // What the earlier run refused stays refused while the revision is compared, so a revision that
        // quietly kept a capability that already failed is gated out rather than ranked.
        const refused = [...new Set([...cannotUse, ...(generated.revision?.refusedActions ?? [])].map(String))];
        const learning = await learningFor(store, ctx, { candidates: generated.candidates, prior, goalId: goal.id });
        const guidance = await guidanceFor(ctx, registry, generated.candidates, { instructionRefusals: refused });
        // The recorded step outcomes this revision's capabilities carry, across every plan record for
        // this goal - the prior plan's own failures among them. Read here, not copied from the plan
        // being answered, because a revision has to see what the earlier approaches left behind.
        const outcomes = await outcomesForGoal(store, { goalId: goal.id });
        const goalEvidence = await goalEvidenceFor(store, ctx, goal);
        const evaluation = evaluateCandidates({
          result: generated,
          goal,
          registry,
          evidence: { unavailableActions: refused, knownBlockers: [] },
          constraints,
          guidance,
          outcomes,
          goalEvidence,
        });
        const occupancy = await store.candidateState(goal.id);
        return {
          summary: `${generated.candidates.length} revised candidate plan(s) for plan ${shortId(prior.id)} v${prior.version}; `
            + (evaluation.ok
              ? (evaluation.selection.leading
                ? `${evaluation.selection.leading} leads under the disclosed rule`
                : `${evaluation.front.length} remain, not separated by it`)
              : `none can be compared (${evaluation.reason})`),
          data: {
            planId: prior.id,
            planSnapshot: planSnapshot(prior),
            goalId: goal.id,
            goalRevision: goal.revision,
            reason,
            cannotUse,
            refusedActions: refused,
            failedOperations,
            revision: generated.revision ?? null,
            occupancy,
            candidateSetDigest: evaluation.boundTo.candidateSetDigest,
            candidates: candidateRows(generated.candidates),
            clarificationNeeded: generated.clarificationNeeded,
            unaddressed: (generated.unaddressed ?? []).map((u) => ({ criterionId: u.criterionId ?? null, text: u.text })),
            skipped: generated.skipped ?? [],
            refusedCapabilities: generated.refusedCapabilities ?? [],
            constraints: constraintAudit(constraints),
            guidance: guidanceAudit(guidance),
            comparison: comparisonOf(evaluation),
            adaptationDecision: evaluation.adaptationDecision ?? null,
            learning,
            freshApprovalRequired: generated.revision ? generated.revision.freshApprovalRequired : null,
            recorded: false,
            approved: false,
            executable: false,
          },
          display: [
            `Revised candidates for plan ${shortId(prior.id)} v${prior.version} (${prior.status}), answering: ${reason}`,
            failedOperations.length
              ? `Recorded step outcomes it answers: ${failedOperations.map((f) => `${singleLine(f.detail, 120)}${f.operationId ? ` [operation ${shortId(f.operationId)}]` : ' [no operation recorded]'}`).join('; ')}`
              : 'The plan record holds no failed or uncertain step outcome, so this revision answers the stated reason and the constraints given, not a recorded failure.',
            renderCandidates(generated, { registry }),
            renderEvaluation(evaluation),
            renderConstraints(constraints),
            renderGuidance(guidance),
            renderAdaptationDecision(evaluation.adaptationDecision),
            occupancyNote(occupancy),
            renderLearning(learning),
            `Plan ${shortId(prior.id)} is unchanged by this read, and its approval binds to its own bytes: none of the candidates above inherits it.`,
            'A revision is recorded with plan.add and authorized with plan.approve, both user acts, after fresh validation.',
          ].join('\n'),
        };
      },
      async verify(ctx, { planRef, reason, cannotUse }, result) {
        const registry = registryFor(ctx);
        const prior = await store.resolve(planRef);
        const snapshot = planSnapshot(prior);
        const recorded = result.data.planSnapshot;
        if (snapshot.version !== recorded.version || snapshot.contentHash !== recorded.contentHash
          || snapshot.status !== recorded.status || snapshot.updatedAt !== recorded.updatedAt) {
          return { ok: false, detail: `the plan being answered changed during the read (v${recorded.version} ${recorded.status} -> v${snapshot.version} ${snapshot.status})` };
        }
        if (!prior.goalId) return { ok: false, detail: 'the plan records no goal, so the revision cannot be regenerated' };
        const goal = await goalForRead(ctx, prior.goalId);
        const constraints = await constraintsFor(ctx, registry, goal, { unavailableActions: cannotUse, knownBlockers: [], failedOperations: failedOperationRecords(prior) });
        const again = revisedCandidates({
          goal,
          registry,
          prior,
          evidence: { unavailableActions: cannotUse, knownBlockers: [], failedOperations: failedOperationRecords(prior) },
          reason,
          constraints,
        });
        const refusedNow = [...new Set([...cannotUse, ...(again.revision?.refusedActions ?? [])].map(String))];
        const againLearning = await learningFor(store, ctx, { candidates: again.candidates, prior, goalId: goal.id });
        const againGuidance = await guidanceFor(ctx, registry, again.candidates, { instructionRefusals: refusedNow });
        const againOutcomes = await outcomesForGoal(store, { goalId: goal.id });
        const compared = evaluateCandidates({
          result: again,
          goal,
          registry,
          evidence: { unavailableActions: refusedNow, knownBlockers: [] },
          constraints,
          guidance: againGuidance,
          outcomes: againOutcomes,
          goalEvidence: await goalEvidenceFor(store, ctx, goal),
        });
        if (compared.boundTo.candidateSetDigest !== result.data.candidateSetDigest) {
          return { ok: false, detail: 'an independent revision gives different candidate bytes, so this answer describes a plan, goal, or registry that has since moved' };
        }
        if (outcomesRankingShape(outcomesAudit(againOutcomes)) !== outcomesRankingShape(result.data.comparison.outcomes)) {
          return {
            ok: false,
            detail: 'the recorded step outcomes this revision was ranked against no longer read the same: a step of one of this goal\'s plans failed, stayed uncertain, or was recorded since this answer was read',
          };
        }
        if (againGuidance.digest !== result.data.guidance.digest) {
          return {
            ok: false,
            detail: 'the guidance that ranked this revision no longer reads the same: an adaptation was approved or retired, a recorded shape changed, or two of the user\'s own records came to disagree while this answer was being read',
          };
        }
        if (constraintDigest(constraints) !== result.data.constraints.digest) {
          return {
            ok: false,
            detail: 'the constraints that gated this revision no longer read the same: a blocker, prerequisite, dependency, or a record one of them cites has moved since this answer was read',
          };
        }
        const occupancy = await store.candidateState(goal.id);
        if (occupancy.drafts.length !== result.data.occupancy.drafts.length) {
          return { ok: false, detail: 'the plan store holds a different number of drafts for this goal than this read reported' };
        }
        if (learningDigest(againLearning) !== learningDigest(result.data.learning)) {
          return { ok: false, detail: 'the learning records disclosed with this revision no longer read the same: an adaptation was decided, an expectation changed state, or an assessment was recorded while this answer was being read' };
        }
        return {
          ok: true,
          detail: `plan ${shortId(prior.id)} is still v${snapshot.version} ${snapshot.status} with the same content hash; ${again.candidates.length} revised candidate(s) reproduce byte for byte; the learning disclosure re-reads to the same records; nothing was recorded, approved, or started`,
        };
      },
    },

    {
      name: 'plan.outcome',
      description: 'Read what a plan\'s execution established and what it left open, as seven separate questions answered from the audit log, the goal\'s criteria and evidence, and the stores: step outcomes, expected outputs, verifier verdicts, criteria settled, evidence state, durability, and what only confirmation outside APEX can settle. A verdict is a reading of records, not real-world success and not permission. Read-only: nothing is recorded and the plan is left byte-identical.',
      inputHint: '{"plan":"plan id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['plan', 'planId', 'target']);
        const planRef = o.plan ?? o.planId ?? o.target;
        if (typeof planRef !== 'string' || planRef.trim().length === 0) throw new ValidationError('plan must be a plan id');
        return { planRef: planRef.trim() };
      },
      async execute(ctx, { planRef }) {
        const { plan, assessment } = await outcomeOf(store, ctx, planRef);
        const prior = assessment.ok ? await store.assessments(plan.id) : [];
        // The scope is the plan's own step actions, so the independent re-read below, which is handed the
        // same plan record, derives the same capabilities and can detect a moved record.
        const learning = await learningFor(store, ctx, { prior: plan, goalId: plan.goalId ?? null, excludePlanId: plan.id });
        if (!assessment.ok) {
          return {
            summary: `plan ${shortId(plan.id)} v${plan.version} (${plan.status}) has no execution outcome to read back: ${assessment.reason}`,
            data: {
              planId: plan.id,
              planSnapshot: planSnapshot(plan),
              assessed: false,
              reason: assessment.reason,
              goalId: plan.goalId ?? null,
              recordable: false,
              priorAssessments: [],
              learning,
              recorded: false,
            },
            display: [
              renderAssessment(assessment),
              `Plan ${shortId(plan.id)} is v${plan.version} (${plan.status}) with ${plan.steps.length} step(s) and ${Object.keys(plan.stepResults ?? {}).length} recorded step outcome(s).`,
              renderLearning(learning),
              'Recording an assessment is plan.assess, and it needs an outcome to assess.',
            ].join('\n'),
          };
        }
        return {
          summary: `outcome of plan ${shortId(plan.id)} v${plan.version} (${plan.status}): ${assessment.verdict} - ${singleLine(assessment.basis, 140)}`,
          data: {
            planId: plan.id,
            planSnapshot: planSnapshot(plan),
            assessed: true,
            taskId: assessment.taskId,
            goalId: assessment.goalId,
            goalRevision: assessment.goalRevision,
            goalStatus: assessment.goalStatus,
            progress: assessment.progress,
            verdict: assessment.verdict,
            verdictRule: VERDICT_RULE,
            basis: assessment.basis,
            summary: assessment.summary,
            aspects: assessment.aspects.map((a) => ({ aspect: a.aspect, question: a.question, answered: a.answered })),
            findings: findingRows(assessment.findings),
            dropped: assessment.dropped,
            auditReads: assessment.auditReads,
            recordable: assessment.recordable,
            unrecordableReason: assessment.unrecordableReason,
            priorAssessments: assessmentRows(prior),
            learning,
            note: assessment.note,
            recorded: false,
            authorizes: false,
          },
          display: [
            renderAssessment(assessment),
            prior.length
              ? `Already recorded against this plan: ${assessmentRows(prior).map((a) => `${a.verdict} for v${a.planVersion}${a.stale ? ' (stale: the plan content has since changed)' : ''}`).join('; ')}`
              : `No outcome assessment of plan ${shortId(plan.id)} is recorded yet.`,
            renderLearning(learning),
            'This read recorded nothing: an assessment is written by plan.assess, which is a user act, and it changes no status, approval, or timestamp.',
            'A step that ran and verified is a fact about the audit log. Whether the intention holds outside APEX\'s records is not answered here.',
          ].join('\n'),
        };
      },
      async verify(ctx, { planRef }, result) {
        const { plan, assessment } = await outcomeOf(store, ctx, planRef);
        const now = planSnapshot(plan);
        const then = result.data.planSnapshot;
        if (now.version !== then.version || now.status !== then.status
          || now.contentHash !== then.contentHash || now.updatedAt !== then.updatedAt) {
          return { ok: false, detail: `the plan changed during the read (v${then.version} ${then.status} -> v${now.version} ${now.status})` };
        }
        const recorded = assessment.ok ? await store.assessments(plan.id) : [];
        if (recorded.length !== result.data.priorAssessments.length) {
          return { ok: false, detail: 'this read left a recorded assessment behind, which a read must not do' };
        }
        const againLearning = await learningFor(store, ctx, { prior: plan, goalId: plan.goalId ?? null, excludePlanId: plan.id });
        if (learningDigest(againLearning) !== learningDigest(result.data.learning)) {
          return { ok: false, detail: 'the learning records this answer disclosed no longer read the same: an adaptation was decided, an expectation changed state, or an assessment was recorded against another plan for this goal while this answer was being read' };
        }
        if (!result.data.assessed) {
          if (assessment.ok) {
            return { ok: false, detail: 'the plan now records an execution outcome, so the answer that there was none to read back no longer holds' };
          }
          return { ok: true, detail: `plan ${shortId(plan.id)} is unchanged at v${now.version} ${now.status}; it still has no execution outcome to read back, the learning disclosure re-reads to the same records, and nothing was recorded` };
        }
        if (!assessment.ok) return { ok: false, detail: 'the plan no longer has an execution outcome to read back' };
        if (assessment.verdict !== result.data.verdict) {
          return { ok: false, detail: `an independent read gives ${assessment.verdict}, not the ${result.data.verdict} reported: the records this answer reads have moved` };
        }
        if (citedShape(assessment.findings) !== citedShape(result.data.findings)) {
          return { ok: false, detail: 'the findings this read reported no longer cite the same operations' };
        }
        return {
          ok: true,
          detail: `plan ${shortId(plan.id)} is still v${now.version} ${now.status} with the same content hash; the ${assessment.verdict} reading reproduces from ${assessment.findings.length} finding(s) citing the same operation(s); the learning disclosure re-reads to the same records; nothing was recorded`,
        };
      },
    },

    {
      name: 'plan.assess',
      description: 'Record the outcome assessment APEX derives from a plan\'s recorded step outcomes, the audit operations they cite, the goal\'s criteria and evidence, and what the stores still hold. The verdict is re-derived here and never accepted as input, so an input naming a verdict or findings is refused. Recording writes one assessment event: it changes no plan status, approval, or timestamp, and completes or reopens no goal. Write: user origin only.',
      inputHint: '{"target":"plan id"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target']);
        if (typeof o.target !== 'string' || o.target.trim().length === 0) throw new ValidationError('target must be a plan id');
        return { target: o.target.trim() };
      },
      async execute(ctx, { target }) {
        const { plan, assessment } = await outcomeOf(store, ctx, target);
        if (!assessment.ok) {
          throw new ValidationError(`plan ${shortId(plan.id)} has no execution outcome to assess: ${assessment.reason}`);
        }
        // Recorded only when every retained finding cites an operation this read actually found and the
        // question the verdict depends on is among them. An assessment the store would refuse is reported
        // rather than written, and an answer with no record behind it stays unrecorded.
        if (!assessment.recordable) {
          throw new ValidationError(`the derived assessment cannot be recorded: ${assessment.unrecordableReason}`);
        }
        const before = planSnapshot(plan);
        const beforeApproval = approvalShape(plan);
        const { plan: after } = await store.assessPlan(target, {
          verdict: assessment.verdict,
          summary: assessment.summary,
          findings: assessment.findings,
        });
        const afterApproval = approvalShape(after);
        const list = await store.assessments(after.id);
        return {
          summary: `recorded outcome assessment ${assessment.verdict} for plan ${shortId(plan.id)} v${plan.version}`,
          data: {
            planId: plan.id,
            before,
            after: planSnapshot(after),
            beforeApproval,
            afterApproval,
            verdict: assessment.verdict,
            summary: assessment.summary,
            findings: findingRows(assessment.findings),
            dropped: assessment.dropped,
            assessments: assessmentRows(list),
          },
          display: [
            `Recorded outcome assessment for plan ${shortId(plan.id)} v${plan.version} (${after.status}).`,
            `  verdict: ${assessment.verdict} - ${assessment.basis}`,
            `  findings: ${assessment.findings.length} of ${ASSESSMENT_ASPECTS.length} question(s) answered from records`,
            assessment.dropped.length
              ? `  not recorded: ${assessment.dropped.map((d) => `${d.aspect} (${d.reason})`).join('; ')}`
              : null,
            `  the plan record is unchanged: v${after.version} ${after.status}, same content hash, ${before.updatedAt === after.updatedAt ? 'same' : 'CHANGED'} timestamp, approval ${beforeApproval === afterApproval ? 'unchanged' : 'CHANGED'}`,
            `  assessments now on this plan: ${assessmentRows(list).map((a) => `${a.verdict} for v${a.planVersion}${a.stale ? ' (stale)' : ''}`).join('; ')}`,
            'Recording an assessment completes no goal and reopens none, and authorizes nothing. Whether the intention holds outside these records is the user\'s to confirm.',
          ].filter(Boolean).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const plan = await store.get(result.data.planId);
        if (!plan) return { ok: false, detail: 'the assessed plan cannot be read back' };
        const now = planSnapshot(plan);
        const before = result.data.before;
        if (now.version !== before.version || now.status !== before.status
          || now.contentHash !== before.contentHash || now.updatedAt !== before.updatedAt) {
          return {
            ok: false,
            detail: `recording an assessment changed the plan record (v${before.version} ${before.status} updatedAt ${before.updatedAt} -> v${now.version} ${now.status} updatedAt ${now.updatedAt})`,
          };
        }
        if (approvalShape(plan) !== result.data.beforeApproval) {
          return { ok: false, detail: 'recording an assessment changed the plan\'s approval' };
        }
        const list = await store.assessments(plan.id);
        const last = list.at(-1);
        if (!last) return { ok: false, detail: 'no assessment is recorded on the plan' };
        if (last.verdict !== result.data.verdict) return { ok: false, detail: `the recorded verdict is ${last.verdict}, not ${result.data.verdict}` };
        if (last.summary !== result.data.summary) return { ok: false, detail: 'the recorded summary differs from what was derived' };
        if (last.planVersion !== before.version) return { ok: false, detail: `the assessment names plan version ${last.planVersion}, not ${before.version}` };
        if (last.contentHash !== before.contentHash) {
          return { ok: false, detail: 'the assessment is not bound to the plan content it was derived from' };
        }
        if (last.stale) return { ok: false, detail: 'the assessment already reads as stale against the plan\'s current content' };
        const earlier = list.length - 1;
        if ((last.findings ?? []).length !== result.data.findings.length) {
          return { ok: false, detail: `the recorded assessment holds ${(last.findings ?? []).length} finding(s), not ${result.data.findings.length}` };
        }
        for (const f of last.findings ?? []) {
          if (!(f.operations ?? []).length) return { ok: false, detail: `the recorded ${f.aspect} finding cites no operation` };
        }
        if (citedShape(last.findings) !== citedShape(result.data.findings)) {
          return { ok: false, detail: 'the recorded findings cite operations other than those the read found' };
        }
        return {
          ok: true,
          detail: `assessment ${last.verdict} recorded for v${last.planVersion} and bound to its content hash; ${last.findings.length} finding(s), each citing an operation in the audit log; ${earlier} earlier assessment(s) preserved; plan still ${plan.status} with its approval and timestamp unchanged`,
        };
      },
    },
  ];
}
