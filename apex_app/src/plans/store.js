// Plan store: an append-only JSON Lines event log (plans.jsonl), replayed into plan state.
//
// Plans are user records. Every mutation runs under the store's WriterLock because each one is a
// read-modify-write (validate against the current plan, then append one event). Approval is bound
// to a content hash, so a revision cannot inherit an earlier approval, and activation re-checks
// both the hash and the live registry before a task may be created from the plan.
//
// A plan is not permission to execute. Validation only reports whether the steps name available,
// authorized capabilities with valid inputs; every step is still authorized separately when it
// runs, and the store never executes anything.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { WriterLock } from '../memory/writer-lock.js';
import { ValidationError, StoreError } from '../errors.js';
import { Outcome } from '../outcomes.js';
import { parseIsoInstant, shortId, singleLine } from '../util.js';
import { containsSecret, maskSecretLeaves } from '../security/secrets.js';
import {
  PLAN_SCHEMA,
  PlanStatus,
  MAX_CANDIDATES_PER_GOAL,
  isOpenPlan,
  plansForGoal,
  planContent,
  planContentHash,
  planProgress,
  planRisk,
  reduceEvents,
  validateEventShape,
} from './model.js';

const TERMINAL_GOAL = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'superseded']);

function assertNoSecret(value, name) {
  if (containsSecret(String(value ?? ''))) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
}

// How much of a goal's candidate room is taken, as the store's own bounds state it. A goal with no
// reference holds nothing: an unbound plan is nobody's candidate, so no goal may count it.
function goalOccupancy(plans, goalId) {
  const id = goalId ?? null;
  if (id === null) {
    return { goalId: null, drafts: [], live: [], maxDrafts: MAX_CANDIDATES_PER_GOAL, draftsRemaining: MAX_CANDIDATES_PER_GOAL };
  }
  const { drafts, live } = plansForGoal(plans, id);
  return {
    goalId: id,
    drafts: drafts.map((p) => p.id),
    live: live.map((p) => ({ id: p.id, status: p.status })),
    maxDrafts: MAX_CANDIDATES_PER_GOAL,
    draftsRemaining: Math.max(0, MAX_CANDIDATES_PER_GOAL - drafts.length),
  };
}

export class PlanStore {
  constructor(filePath, { now = () => new Date(), idFactory = randomUUID, registry = null, goals = null, operations = null } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.registry = registry;
    this.goals = goals;
    this.operations = operations;
    this.log = new JsonlStore(filePath, { validateRecord: validateEventShape });
    this.lock = new WriterLock(filePath, { label: path.basename(filePath), now, idFactory });
  }

  async #readComplete() {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) {
      throw new StoreError(`plan log contains ${corrupt.length} corrupt line(s); refusing incomplete plan state`);
    }
    const { plans, problems } = reduceEvents(records);
    if (problems.length > 0) {
      throw new StoreError(`plan log contains ${problems.length} event(s) that cannot be applied; refusing incomplete plan state`);
    }
    return { records, plans };
  }

  async load() {
    const { records, plans } = await this.#readComplete();
    return { plans, events: records.length };
  }

  // The log replayed to one cutoff: only events stamped at or before it, derived by the reducer
  // every other read uses. Version, approval, activation, step outcomes, and assessments are the
  // ones recorded by then, so a later approval cannot authorize an earlier version and a later
  // revision cannot rewrite what was approved. A historical approval is a record of what the user
  // authorized then, never a current authorization.
  //
  // Filtering by `at` preserves append order among the events it keeps. A non-monotonic clock can
  // leave a subsequence that does not apply (a revision without the version it revises, for
  // example); those problems are reported instead of being repaired by reordering, because the
  // records carry no chronology other than the timestamps they report.
  async historicalView(knownAt, { withCurrent = true } = {}) {
    const cutoff = parseIsoInstant(knownAt);
    if (cutoff === null) {
      throw new ValidationError(`"${singleLine(knownAt, 60)}" is not an ISO date or an ISO date-time with a time zone`);
    }
    const cutoffMs = Date.parse(cutoff);
    const { records } = await this.#readComplete();
    const known = [];
    const later = [];
    let undated = 0;
    for (const record of records) {
      const at = Date.parse(record.at);
      if (Number.isNaN(at)) undated += 1;
      else if (at <= cutoffMs) known.push(record);
      else later.push({ at: record.at, type: record.type, planId: record.planId });
    }
    const derived = reduceEvents(known);
    const current = withCurrent ? reduceEvents(records) : null;
    return {
      cutoff,
      records: known.length,
      excluded: later.length,
      undated,
      plans: derived.plans,
      problems: derived.problems,
      later,
      current: withCurrent ? { plans: current.plans, problems: current.problems } : null,
      note: `replayed ${known.length} plan-log event(s) recorded at or before ${cutoff}; ${later.length} later event(s) are not included, so a later approval, revision, activation, step outcome, assessment, or status change does not apply`,
    };
  }

  async inspect() {
    const { records, corrupt } = await this.log.load();
    const { plans, problems } = reduceEvents(records);
    return { events: records.length, plans: [...plans.values()], corrupt, problems };
  }

  async status() {
    const { records, corrupt } = await this.log.load();
    const { plans, problems } = reduceEvents(records);
    return { records: records.length, plans: plans.size, corrupt: corrupt.length, problems: problems.length };
  }

  async get(planId) {
    const { plans } = await this.load();
    return plans.get(planId) ?? null;
  }

  async list() {
    const { plans } = await this.load();
    return [...plans.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async resolve(ref) {
    const q = String(ref ?? '').trim();
    if (q.length === 0) throw new ValidationError('a plan id is required');
    const { plans } = await this.load();
    if (plans.has(q)) return plans.get(q);
    if (q.length < 4) throw new ValidationError(`plan id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...plans.values()].filter((p) => p.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no plan matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} plans; use a longer id`);
    return matches[0];
  }

  #pick(plans, ref) {
    const q = String(ref ?? '').trim();
    if (plans.has(q)) return plans.get(q);
    if (q.length < 4) throw new ValidationError(`plan id "${singleLine(q, 40)}" is too short; use at least 4 characters`);
    const matches = [...plans.values()].filter((p) => p.id.startsWith(q));
    if (matches.length === 0) throw new ValidationError(`no plan matches "${singleLine(q, 40)}"`);
    if (matches.length > 1) throw new ValidationError(`"${singleLine(q, 40)}" matches ${matches.length} plans; use a longer id`);
    return matches[0];
  }

  #base(type, planId) {
    return { schema: PLAN_SCHEMA, eventId: this.idFactory(), type, planId, at: this.now().toISOString() };
  }

  async #mutate(build) {
    return this.lock.run(async () => {
      const { records, plans } = await this.#readComplete();
      const event = await build(plans);
      const masked = maskSecretLeaves(event);
      const safe = masked.masked > 0 ? { ...masked.value, secretsMasked: true } : masked.value;
      const next = reduceEvents([...records, safe]);
      const refused = next.problems.find((p) => p.index === records.length);
      if (refused) throw new ValidationError(`refused: ${refused.reason}`, 'ILLEGAL_TRANSITION');
      await this.log.append(safe);
      // The reduced map is returned with the plan so a caller that needs the goal's other plans
      // (the candidate occupancy) does not have to parse the log a second time.
      return { event: safe, plan: next.plans.get(event.planId), plans: next.plans };
    });
  }

  // ---- validation -----------------------------------------------------------

  // Checks a plan against the live registry and its own dependencies. It reads and never writes.
  // A capability missing from this configuration, a step the policy would refuse, an input the
  // action would reject, or a write classified as low risk is a problem the user must resolve
  // before approval. It does not claim that a validated plan will succeed, only that nothing in
  // the record is already known to be impossible or unauthorized.
  validatePlan(plan) {
    const problems = [];
    const capabilities = new Map();
    let writes = 0;
    let reads = 0;
    let estimatedSeconds = null;
    if (!this.registry) {
      problems.push('the action registry is not available, so no capability can be checked');
    }
    for (const s of plan.steps) {
      const label = `step ${s.id}`;
      const def = this.registry?.get(s.action) ?? null;
      if (!def) {
        problems.push(`${label}: action ${s.action} is not available in this configuration`);
        continue;
      }
      capabilities.set(def.name, def.permission);
      if (def.permission === 'write') writes += 1; else reads += 1;
      if (def.plannable === false) {
        problems.push(`${label}: action ${s.action} cannot be part of a plan`);
        continue;
      }
      // Reversibility is a claim about what the step does, and the registry's own permission class
      // can contradict it: a write is not read-only, and a read changes nothing to be irreversible.
      // `unknown`, and `reversible` on a write, are both left standing - the first because APEX may
      // genuinely not know, the second because undoing a record it wrote is within reach.
      if (s.reversibility === 'read_only' && def.permission === 'write') {
        problems.push(`${label}: ${s.action} is a write, so the step cannot be recorded as read_only`);
      }
      if (s.reversibility === 'not_reversible' && def.permission !== 'write') {
        problems.push(`${label}: ${s.action} changes no record, so the step cannot be recorded as not_reversible`);
      }
      const auth = this.registry.authorize(def.name, 'user');
      if (auth.decision !== 'allow') problems.push(`${label}: action ${s.action} is not permitted (${auth.reason})`);
      if (def.permission === 'write' && s.risk === 'low') {
        problems.push(`${label}: a write step cannot be classified low risk`);
      }
      if (def.permission === 'write' && typeof def.verify !== 'function') {
        problems.push(`${label}: a write step has no independent verifier, so its result could not be verified`);
      }
      let normalised = null;
      try {
        normalised = def.validate(s.input ?? {});
      } catch (err) {
        problems.push(`${label}: ${err?.message ?? String(err)}`);
      }
      // The task layer refuses a private memory write because its content must never reach a task
      // log, so a plan that needs one can never run. Saying so here keeps the user from approving a
      // step that cannot be executed, and keeps this check in agreement with `checkSteps`.
      if (def.name === 'memory.add' && normalised?.sensitivity === 'private') {
        problems.push(`${label}: a private memory write cannot be part of a plan; remember it on its own`);
      }
      if (Number.isInteger(s.estimate?.seconds)) {
        estimatedSeconds = (estimatedSeconds ?? 0) + s.estimate.seconds;
      }
    }
    if (plan.assertions.some((a) => a.kind === 'retrieved_evidence') && !plan.assertions.some((a) => a.kind === 'retrieved_evidence' && a.ref)) {
      problems.push('retrieved evidence must name the record it came from');
    }
    return {
      ok: problems.length === 0,
      problems,
      steps: plan.steps.length,
      writes,
      reads,
      capabilities: [...capabilities.keys()].sort(),
      estimatedSeconds,
      risk: planRisk(plan.steps),
    };
  }

  // ---- mutations ------------------------------------------------------------

  async createPlan({ goalId = null, outcome, steps, preconditions = [], assertions = [], resources = null, reason = null }) {
    assertNoSecret(outcome, 'the intended outcome');
    for (const p of preconditions) assertNoSecret(p, 'a precondition');
    for (const a of assertions) assertNoSecret(a?.text, 'an assertion');
    let goalRevision = null;
    if (goalId !== null) {
      if (!this.goals) throw new ValidationError('the goal store is not available, so a goal cannot be referenced');
      let goal;
      try {
        goal = await this.goals.resolve(goalId);
      } catch (err) {
        // The CLI only prints short ids, so a reference means the same unique prefix the
        // other goal commands accept. The record always stores the full id it resolved to.
        if (err instanceof ValidationError && /^no goal matches/.test(err.message)) {
          throw new ValidationError(`no goal ${shortId(goalId)} exists; a plan references a recorded goal`);
        }
        throw err;
      }
      if (TERMINAL_GOAL.has(goal.status)) throw new ValidationError(`goal ${shortId(goal.id)} is ${goal.status}; a new plan is not accepted for it`);
      goalId = goal.id;
      goalRevision = goal.revision ?? 1;
    }
    const planId = this.idFactory();
    const result = await this.#mutate(() => ({
      ...this.#base('plan_created', planId),
      origin: 'user',
      goalId,
      ...(goalRevision !== null ? { goalRevision } : {}),
      version: 1,
      reason: reason ?? 'created by the user',
      outcome,
      steps,
      preconditions,
      assertions,
      resources: resources ?? { estimatedSeconds: null },
    }));
    let linkError = null;
    if (goalId !== null && this.goals) {
      try {
        await this.goals.link(goalId, { planId });
      } catch (err) {
        // The plan record is authoritative and already stored. The goal's plan index is a
        // convenience; a failed link is disclosed rather than reported as a silent success.
        linkError = err?.code ?? 'LINK_FAILED';
      }
    }
    // What else the goal now holds, from the same replay that produced the plan: a caller recording
    // a second approach needs to say how many there are and whether one is already authorized.
    return { ...result, linkError, candidates: goalOccupancy(result.plans, goalId) };
  }

  async revise(ref, { outcome, steps, preconditions = [], assertions = [], resources = null, reason }) {
    assertNoSecret(outcome, 'the intended outcome');
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new ValidationError('a revision needs a reason');
    return this.#mutate(async (plans) => {
      const plan = this.#pick(plans, ref);
      let goalRevision = plan.goalRevision ?? null;
      if (plan.goalId && this.goals) {
        // A revision is bound to the goal wording it was written for. If the goal moved on,
        // the revision records the new revision, and approval must then be given again.
        const goal = await this.goals.resolve(plan.goalId);
        goalRevision = goal.revision ?? 1;
      }
      return {
        ...this.#base('plan_revised', plan.id),
        version: plan.version + 1,
        ...(goalRevision !== null ? { goalRevision } : {}),
        reason: reason.trim(),
        outcome,
        steps,
        preconditions,
        assertions,
        resources: resources ?? { estimatedSeconds: null },
      };
    });
  }

  async approve(ref) {
    return this.#mutate((plans) => {
      const plan = this.#pick(plans, ref);
      if (plan.status !== PlanStatus.DRAFT) throw new ValidationError(`plan is ${plan.status}; only a draft can be approved`);
      const validation = this.validatePlan(plan);
      if (!validation.ok) {
        throw new ValidationError(`plan cannot be approved: ${validation.problems.join('; ')}`, 'PLAN_INVALID');
      }
      // The one-live-plan-per-goal bound is not checked here: the reducer applies it, so a replay
      // of any log - hand-written or not - is held to the same rule as this call is.
      return {
        ...this.#base('plan_approved', plan.id),
        version: plan.version,
        contentHash: planContentHash(plan),
        validation,
      };
    });
  }

  // Activation is called only after the caller has created the task, so the task id is recorded
  // in the same event that makes the plan active. The content hash is recomputed from the current
  // plan and must still equal the approved hash; a revision between approval and activation is
  // therefore refused rather than activated under an old approval.
  async activate(ref, { taskId, goal = undefined }) {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 64) throw new ValidationError('a task id is required to activate a plan');
    if (goal !== undefined && goal !== null && TERMINAL_GOAL.has(goal.status)) {
      throw new ValidationError(`goal ${shortId(goal.id)} is ${goal.status}; its plan cannot be activated`);
    }
    return this.#mutate((plans) => {
      const plan = this.#pick(plans, ref);
      if (plan.status !== PlanStatus.APPROVED) throw new ValidationError(`plan is ${plan.status}; only an approved plan can be activated`);
      const validation = this.validatePlan(plan);
      if (!validation.ok) {
        throw new ValidationError(`plan cannot be activated: ${validation.problems.join('; ')}`, 'PLAN_INVALID');
      }
      return {
        ...this.#base('plan_activated', plan.id),
        version: plan.version,
        taskId,
        contentHash: planContentHash(plan),
      };
    });
  }

  // Records the outcome of a task step against the plan. A completed outcome must name an audit
  // operation, and when that operation can be read it must still be a verified success.
  async recordOutcome(ref, { taskId, steps }) {
    return this.#mutate(async (plans) => {
      const plan = this.#pick(plans, ref);
      if (!Array.isArray(steps) || steps.length === 0) throw new ValidationError('at least one step outcome is required');
      for (const s of steps) {
        if (s.status !== 'completed') continue;
        if (!s.operationId) throw new ValidationError(`a completed step outcome for ${singleLine(s.stepId, 40)} must name its operation`);
        if (this.operations) {
          const found = await this.operations.findById(s.operationId);
          if (!found.found) throw new ValidationError(`operation ${shortId(s.operationId)} is not in the audit log`, 'EVIDENCE_NOT_VERIFIED');
          if (found.record.status !== Outcome.SUCCESS_VERIFIED) {
            throw new ValidationError(`operation ${shortId(s.operationId)} ended as ${found.record.status}, so it cannot support a completed step`, 'EVIDENCE_NOT_VERIFIED');
          }
          if (Array.isArray(found.record.errors) && found.record.errors.length > 0) {
            throw new ValidationError(`operation ${shortId(s.operationId)} carries errors, so its evidence is incomplete`, 'EVIDENCE_NOT_VERIFIED');
          }
        }
      }
      return {
        ...this.#base('plan_outcome', plan.id),
        taskId,
        steps: steps.map((s) => ({
          stepId: s.stepId,
          status: s.status,
          operationId: s.operationId ?? null,
          detail: typeof s.detail === 'string' ? s.detail.slice(0, 300) : null,
        })),
      };
    });
  }

  async #verifyCompletion(plan) {
    const progress = planProgress(plan);
    if (progress.completed !== progress.total) {
      throw new ValidationError(`plan cannot be completed: ${progress.completed} of ${progress.total} step(s) have a completed outcome`, 'COMPLETION_UNVERIFIED');
    }
    if (!this.operations) throw new ValidationError('the audit log is not available, so completion evidence cannot be checked', 'COMPLETION_UNVERIFIED');
    for (const step of plan.steps) {
      const result = plan.stepResults[step.id];
      const found = await this.operations.findById(result.operationId);
      if (!found.found) throw new ValidationError(`operation ${shortId(result.operationId)} for step ${step.id} is not in the audit log`, 'COMPLETION_UNVERIFIED');
      if (found.record.status !== Outcome.SUCCESS_VERIFIED) {
        throw new ValidationError(`operation ${shortId(result.operationId)} for step ${step.id} ended as ${found.record.status}`, 'COMPLETION_UNVERIFIED');
      }
    }
  }

  async setStatus(ref, to, { reason = null, by = null } = {}) {
    if (!Object.values(PlanStatus).includes(to)) throw new ValidationError(`unknown plan status "${singleLine(to, 40)}"`);
    return this.#mutate(async (plans) => {
      const plan = this.#pick(plans, ref);
      const text = typeof reason === 'string' ? reason.trim() : '';
      if (text.length > 500) throw new ValidationError('reason exceeds 500 characters');
      assertNoSecret(text, 'the reason');
      if (to === PlanStatus.COMPLETED) await this.#verifyCompletion(plan);
      return {
        ...this.#base('plan_status', plan.id),
        from: plan.status,
        to,
        reason: text,
        by: by ?? null,
      };
    });
  }

  // Read-only: how many candidate drafts one goal holds, which of them are live, and how many more
  // drafts the store will accept for it. Presented from the same bounds the reducer enforces.
  async candidateState(goalId) {
    const { plans } = await this.load();
    return goalOccupancy(plans, goalId);
  }

  // Records an outcome assessment against the plan: what happened, as distinct from what the plan
  // set out to do. Every finding must cite an audit operation, and each cited operation must be in
  // the log - an assessment is not allowed to assert an outcome with no record behind it. The
  // assessment carries the version and content hash it was written against, so a later revision
  // shows it as a statement about older content rather than silently re-approving it.
  //
  // It changes nothing about the plan: not its status, not its approval, not its updatedAt.
  async assessPlan(ref, { verdict, summary, findings }) {
    assertNoSecret(summary, 'the assessment summary');
    for (const f of findings ?? []) {
      assertNoSecret(f?.statement, 'an assessment finding');
      for (const r of f?.records ?? []) assertNoSecret(r, 'a cited record id');
    }
    if (!this.operations) {
      throw new ValidationError(
        'the audit log is not available, so an assessment cannot cite the operations its findings rest on',
        'EVIDENCE_NOT_VERIFIED',
      );
    }
    return this.#mutate(async (plans) => {
      const plan = this.#pick(plans, ref);
      if (!plan.activation) throw new ValidationError('the plan has not been started, so there is no outcome to assess');
      const cited = [...new Set((findings ?? []).flatMap((f) => f.operations ?? []))];
      if (cited.length === 0) throw new ValidationError('an assessment needs at least one finding that cites an operation');
      for (const id of cited) {
        const found = await this.operations.findById(id);
        if (!found.found) {
          throw new ValidationError(`operation ${shortId(id)} is not in the audit log, so a finding cannot cite it`, 'EVIDENCE_NOT_VERIFIED');
        }
      }
      return {
        ...this.#base('plan_assessment', plan.id),
        origin: 'user',
        planVersion: plan.version,
        contentHash: planContentHash(plan),
        verdict,
        summary,
        findings: findings.map((f) => ({
          aspect: f.aspect,
          statement: f.statement,
          operations: [...(f.operations ?? [])],
          ...(f.records?.length ? { records: [...f.records] } : {}),
        })),
      };
    });
  }

  // Read-only: the assessments recorded against one plan, oldest first, each marked with whether it
  // still describes the plan's current content. A revision never erases an earlier conclusion; it
  // makes that conclusion a statement about an older version, and `stale` says so.
  async assessments(ref) {
    const { plans } = await this.load();
    const plan = this.#pick(plans, ref);
    const current = planContentHash(plan);
    return (plan.assessments ?? []).map((a) => ({
      ...a,
      stale: a.planVersion !== plan.version || a.contentHash !== current,
      currentVersion: plan.version,
    }));
  }

  // Read-only: every recorded version of a plan, in order, with the content each version
  // contained. Revisions reset step results, so a version is the plan as written, not the
  // outcomes later recorded against it.
  async history(ref) {
    const { plans, records } = await this.#readComplete();
    const plan = this.#pick(plans, ref);
    const versions = records
      .filter((e) => e.planId === plan.id && (e.type === 'plan_created' || e.type === 'plan_revised'))
      .map((e) => ({
        version: e.version,
        at: e.at,
        kind: e.type === 'plan_created' ? 'created' : 'revised',
        reason: e.reason,
        snapshot: planContent({
          goalId: plan.goalId,
          goalRevision: e.goalRevision ?? null,
          outcome: e.outcome,
          steps: e.steps,
          preconditions: e.preconditions,
          assertions: e.assertions,
          resources: e.resources ?? { estimatedSeconds: null },
        }),
      }));
    return { plan, versions };
  }

  async lockState() {
    return this.lock.state();
  }

  async recover() {
    return this.lock.recover();
  }
}

export { isOpenPlan };
