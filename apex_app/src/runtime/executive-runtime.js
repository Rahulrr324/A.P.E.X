// The T-10 executive runtime. It is a process, not another executive: every consequential step goes
// through the controller, the registry and the verifier that already exist.
//
// RUNTIME START -> STATE RECOVERY -> EVENT PUBLICATION -> EVENT PROCESSING -> SCHEDULING ->
// AUTHORIZED EXECUTION -> OUTCOME RECORDING -> LEARNING -> CONTINUOUS OPERATION
//
// One tick is deterministic and bounded. Publishing scans stored lifecycle records and feeds new
// transitions to T-09 with stable source identities, so a restart or a repeated tick cannot publish
// the same transition twice. Processing records at most `maxEventsPerTick` decisions and never
// chooses `execute`: execution is a scheduler act on a plan the user already approved. Scheduling
// runs at most `maxActionsPerTick` approved plans through `controller.planActivate`, which re-reads
// the registry and the audit on every step.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeStateStore } from './state.js';
import { RuntimeLease } from './lease.js';
import { DEFAULT_RUNTIME_CONFIG, FAILED_PLAN_STATUSES, OPEN_GOAL_STATUSES, RUNTIME_EVENT_SOURCE, TASK_IN_FLIGHT } from './vocabulary.js';
import { DEFAULT_EVENTS_READ, MAX_EVENTS_READ, SIGNIFICANCE_RANK } from '../situational/vocabulary.js';

const ACTIVE_RUNTIMES = new Set();
const ATTENTION_TYPES = new Set(['task_failed', 'task_step_failed', 'plan_failed', 'plan_invalidated', 'operation_failed', 'deadline_passed', 'provider_unavailable']);

// T-09 caps an event source id at 64 characters. A composed identity keeps the readable key in the
// checkpoint and a stable digest on the wire.
function wireId(key) {
  return key.length <= 64 ? key : `rt:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}

function mergeConfig(base, extra = {}) {
  return {
    ...base,
    ...extra,
    retry: { ...base.retry, ...(extra.retry ?? {}) },
  };
}

function makeDeadLetter(kind, ref, reason, detail, at) {
  return { id: randomUUID(), kind, ref, reason, detail: String(detail ?? '').slice(0, 500), at };
}

export class ExecutiveRuntime {
  constructor({
    controller, situation, taskStore, plans, goals, learning = null, experience = null, predictions = null, operations,
    integrations = null, dataDir, now = () => new Date(), idFactory = randomUUID, config = {},
  } = {}) {
    if (!controller || typeof controller.planActivate !== 'function') throw new TypeError('ExecutiveRuntime requires the controller');
    if (!situation || typeof situation.ingest !== 'function') throw new TypeError('ExecutiveRuntime requires the situational service');
    if (!dataDir) throw new TypeError('ExecutiveRuntime requires a data directory');
    this.controller = controller;
    this.situation = situation;
    this.taskStore = taskStore;
    this.plans = plans;
    this.goals = goals;
    this.learning = learning;
    this.experience = experience;
    this.predictions = predictions;
    this.integrations = integrations;
    this.operations = operations;
    this.dataDir = path.resolve(dataDir);
    this.now = now;
    this.idFactory = idFactory;
    this.config = mergeConfig(DEFAULT_RUNTIME_CONFIG, config);
    this.stateStore = new RuntimeStateStore(this.dataDir, { now, idFactory });
    this.lease = new RuntimeLease(this.dataDir, { now, ttlMs: this.config.leaseTtlMs });
    this.runtimeId = null;
    this.leaseNonce = null;
    this.tickPromise = null;
    this.timer = null;
    this.lastScheduleReport = { evaluated: 0, executed: 0, skipped: [] };
    this.lastError = null;
    this.startedAt = null;
  }

  // ---- lifecycle ------------------------------------------------------------

  async start({ intervalMs = 0 } = {}) {
    if (ACTIVE_RUNTIMES.has(this.dataDir)) {
      return { started: false, reason: 'a runtime is already active for this data directory', duplicate: true };
    }
    const loaded = await this.stateStore.load();
    let state = loaded.state;
    const previousLifecycle = state.lifecycle;
    if (state.lifecycle === 'running' || state.lifecycle === 'starting') {
      const held = this.lease.inspect();
      if (held.held) {
        return { started: false, reason: `runtime process ${held.pid} is already running`, duplicate: true, holder: held };
      }
    }
    const lease = this.lease.acquire({ runtimeId: state.runtimeId });
    if (!lease.acquired) {
      return { started: false, reason: lease.reason, duplicate: true, holder: lease.holder };
    }
    this.runtimeId = state.runtimeId;
    this.leaseNonce = lease.nonce;

    const dependencies = this.#dependencyProblems();
    if (dependencies.length > 0) {
      this.lease.release(this.leaseNonce);
      this.leaseNonce = null;
      return { started: false, reason: `the runtime dependencies are not available: ${dependencies.join('; ')}` };
    }

    const startedAt = this.now().toISOString();
    const interrupted = await this.#interruptedTasks();
    state.lifecycle = 'starting';
    state.boots += 1;
    state.startedAt = startedAt;
    state.stoppedAt = null;
    state.paused = false;
    state.history.push({ type: 'started', at: startedAt, boots: state.boots, interrupted: interrupted.length, recoveredLease: lease.previous ?? null });
    if (loaded.corruption) {
      state.history.push({ type: 'checkpoint_quarantined', at: startedAt, reason: loaded.corruption.reason, path: loaded.corruption.quarantinedAt });
    }
    state = await this.stateStore.save(state);
    state.lifecycle = 'running';
    state = await this.stateStore.save(state);

    ACTIVE_RUNTIMES.add(this.dataDir);
    this.startedAt = startedAt;
    await this.#emit('runtime_started', 'system', `runtime ${state.runtimeId} started`, [], [], []);
    if (['running', 'starting'].includes(previousLifecycle) || lease.previous || interrupted.length > 0 || loaded.corruption) {
      await this.#emit('runtime_recovered', 'system', 'the runtime recovered persisted state after an unclean stop', [], [], []);
    }

    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.tick().catch((err) => { this.lastError = err?.message ?? String(err); });
      }, intervalMs);
    }
    return {
      started: true,
      runtimeId: state.runtimeId,
      lifecycle: state.lifecycle,
      boots: state.boots,
      interrupted: interrupted.map((task) => task.id),
      corruption: loaded.corruption,
      leaseTakenOver: lease.previous,
      intervalMs,
    };
  }

  async stop({ reason = 'graceful shutdown' } = {}) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const loaded = await this.stateStore.load();
    let state = loaded.state;
    if (state.lifecycle !== 'running' && state.lifecycle !== 'starting') {
      ACTIVE_RUNTIMES.delete(this.dataDir);
      if (this.leaseNonce) {
        this.lease.release(this.leaseNonce);
        this.leaseNonce = null;
      }
      return { stopped: true, alreadyStopped: true, lifecycle: state.lifecycle };
    }
    state.lifecycle = 'stopping';
    state.history.push({ type: 'stopping', at: this.now().toISOString(), reason });
    state = await this.stateStore.save(state);
    if (this.tickPromise) await this.tickPromise.catch(() => {});
    await this.#emit('runtime_stopped', 'system', `runtime stopped: ${reason}`, [], [], []);
    const stoppedAt = this.now().toISOString();
    state.lifecycle = 'stopped';
    state.stoppedAt = stoppedAt;
    state.history.push({ type: 'stopped', at: stoppedAt, reason });
    state = await this.stateStore.save(state);
    const released = this.leaseNonce ? this.lease.release(this.leaseNonce) : { released: true };
    this.leaseNonce = null;
    ACTIVE_RUNTIMES.delete(this.dataDir);
    return { stopped: true, stoppedAt, lifecycle: state.lifecycle, leaseReleased: released.released };
  }

  async pause({ reason = 'paused by the user' } = {}) {
    const { state } = await this.stateStore.mutate((current) => {
      current.paused = true;
      current.history.push({ type: 'paused', at: this.now().toISOString(), reason });
      return current;
    });
    return { paused: true, lifecycle: state.lifecycle };
  }

  async resume() {
    const { state } = await this.stateStore.mutate((current) => {
      current.paused = false;
      current.history.push({ type: 'resumed', at: this.now().toISOString() });
      return current;
    });
    return { paused: false, lifecycle: state.lifecycle };
  }

  // ---- one bounded cycle ----------------------------------------------------

  tick(options = {}) {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.#tick(options).finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async #tick({ trigger = 'timer' } = {}) {
    const loaded = await this.stateStore.load();
    const state = loaded.state;
    const at = this.now().toISOString();
    if (state.lifecycle !== 'running') {
      return { ran: false, reason: `runtime is ${state.lifecycle}`, at };
    }
    const summary = {
      ran: true, at, trigger, published: 0, processed: 0, decisions: 0,
      notifications: 0, executed: [], retries: 0, deadLettered: 0, skipped: [],
      learning: [], integrations: null,
    };
    const heartbeat = this.lease.heartbeat(this.leaseNonce);
    if (!heartbeat.ok) {
      state.history.push({ type: 'lease_lost', at, reason: heartbeat.reason });
      await this.stateStore.save(state);
      return { ...summary, ran: false, reason: `the runtime lease is no longer held: ${heartbeat.reason}` };
    }
    try {
      // External observation comes first so a freshly ingested event is assessed and queued in this
      // same bounded cycle. A provider failure is contained by the fabric and cannot abort the tick.
      if (this.integrations) {
        try {
          summary.integrations = await this.integrations.pollDue({ limit: this.config.maxProvidersPerTick ?? 2 });
        } catch (err) {
          summary.integrations = { error: err?.message ?? String(err) };
          state.history.push({ type: 'integrations_failed', at, error: String(err?.message ?? err).slice(0, 300) });
        }
      }
      summary.published += await this.#publishLifecycle(state, at);
      summary.published += await this.#monitorDeadlines(state, at);
      const processed = await this.#processEvents(state, at);
      summary.processed = processed.processed;
      summary.decisions = processed.decisions;
      summary.deadLettered += processed.deadLettered;
      summary.retries += processed.retries;
      summary.notifications = await this.#collectNotifications(state, at);
      if (state.paused) {
        summary.skipped.push('scheduling is paused');
      } else {
        const scheduled = await this.#schedule(state, at);
        summary.executed = scheduled.executed;
        summary.retries += scheduled.retries;
        summary.deadLettered += scheduled.deadLettered;
        summary.learning = scheduled.learning;
        summary.skipped.push(...scheduled.skipped);
      }
      state.tickCount += 1;
      state.lastTickAt = at;
      state.counts.eventsProcessed += summary.processed;
      state.counts.decisionsMade += summary.decisions;
      state.counts.retries += summary.retries;
      state.counts.deadLettered += summary.deadLettered;
      state.counts.plansExecuted += summary.executed.length;
      state.history.push({ type: 'tick', at, trigger, processed: summary.processed, executed: summary.executed.length, published: summary.published });
      await this.stateStore.save(state);
    } catch (err) {
      // A tick failure is recorded and the runtime stays running. The next tick retries the work
      // that the checkpoint says was not finished.
      this.lastError = err?.message ?? String(err);
      state.history.push({ type: 'tick_failed', at, error: this.lastError });
      await this.stateStore.save(state);
      summary.error = this.lastError;
    }
    return summary;
  }

  // ---- automatic lifecycle events ------------------------------------------

  #alreadyPublished(state, key) {
    return state.checkpoint.published.includes(key);
  }

  async #publish(state, key, { type, category, summary, goalRefs = [], planRefs = [], taskRefs = [], entityRefs = [], confidence = 1 }) {
    if (this.#alreadyPublished(state, key)) return 0;
    try {
      await this.situation.ingest({
        source: RUNTIME_EVENT_SOURCE,
        sourceEventId: wireId(key),
        type,
        category,
        observedAt: this.now().toISOString(),
        payload: { summary },
        confidence,
        entityRefs,
        goalRefs,
        planRefs,
        taskRefs,
        provenance: { reporter: 'executive-runtime', runtimeId: this.runtimeId },
      });
      state.checkpoint.published.push(key);
      return 1;
    } catch (err) {
      state.deadLetters.push(makeDeadLetter('publication', key, 'processing_error', err?.message ?? String(err), this.now().toISOString()));
      state.counts.deadLettered += 1;
      return 0;
    }
  }

  async #publishLifecycle(state, at) {
    let count = 0;
    // Tasks: status and failed/uncertain step transitions.
    if (this.taskStore) {
      const tasks = (await this.taskStore.list()).slice(0, 500);
      for (const task of tasks) {
        if (!['running', 'completed', 'failed', 'paused', 'cancelled'].includes(task.status)) continue;
        count += await this.#publish(state, `task:${task.id}:${task.status}`, {
          type: `task_${task.status}`,
          category: 'task',
          summary: `task ${task.id.slice(0, 8)} is ${task.status}`,
          goalRefs: task.goalId ? [task.goalId] : [],
          planRefs: task.planId ? [task.planId] : [],
          taskRefs: [task.id],
        });
        for (const step of task.steps ?? []) {
          if (!['failed', 'uncertain'].includes(step.status)) continue;
          count += await this.#publish(state, `task:${task.id}:step:${step.id}:${step.status}`, {
            type: `task_step_${step.status}`,
            category: 'task',
            summary: `step ${step.id} of task ${task.id.slice(0, 8)} is ${step.status}`,
            goalRefs: task.goalId ? [task.goalId] : [],
            planRefs: task.planId ? [task.planId] : [],
            taskRefs: [task.id],
          });
        }
      }
    }
    // Plans.
    if (this.plans) {
      const plans = (await this.plans.list()).slice(0, 500);
      for (const plan of plans) {
        if (!['approved', 'blocked', 'completed', 'failed', 'cancelled'].includes(plan.status)) continue;
        const type = plan.status === 'blocked' ? 'plan_invalidated' : `plan_${plan.status}`;
        count += await this.#publish(state, `plan:${plan.id}:${plan.status}`, {
          type,
          category: 'plan',
          summary: `plan ${plan.id.slice(0, 8)} is ${plan.status}`,
          goalRefs: plan.goalId ? [plan.goalId] : [],
          planRefs: [plan.id],
        });
      }
    }
    // Goals.
    if (this.goals) {
      const goals = (await this.goals.list()).slice(0, 500);
      for (const goal of goals) {
        count += await this.#publish(state, `goal:${goal.id}:created`, {
          type: 'goal_created',
          category: 'goal',
          summary: `goal ${goal.id.slice(0, 8)} was created`,
          goalRefs: [goal.id],
        });
        if ((goal.revision ?? 1) > 1) {
          count += await this.#publish(state, `goal:${goal.id}:revision:${goal.revision}`, {
            type: 'goal_revised',
            category: 'goal',
            summary: `goal ${goal.id.slice(0, 8)} is at revision ${goal.revision}`,
            goalRefs: [goal.id],
          });
        }
        if (!['completed', 'blocked', 'cancelled', 'failed', 'active', 'accepted'].includes(goal.status)) continue;
        count += await this.#publish(state, `goal:${goal.id}:${goal.status}`, {
          type: `goal_${goal.status}`,
          category: 'goal',
          summary: `goal ${goal.id.slice(0, 8)} is ${goal.status}`,
          goalRefs: [goal.id],
        });
      }
    }
    // Adaptations in force and user corrections.
    if (this.experience) {
      const active = await this.experience.activeAdaptations({ limit: 50 });
      for (const adaptation of active.adaptations) {
        count += await this.#publish(state, `adaptation:${adaptation.id}:active`, {
          type: 'adaptation_active',
          category: 'adaptation',
          summary: `adaptation ${adaptation.id.slice(0, 8)} is in force for ${adaptation.capability}`,
        });
      }
      if (typeof this.experience.adaptations === 'function') {
        const all = await this.experience.adaptations({ limit: 50, includeRetired: true });
        for (const adaptation of all) {
          if (!['rolled_back', 'retired'].includes(adaptation.stage)) continue;
          count += await this.#publish(state, `adaptation:${adaptation.id}:${adaptation.stage}`, {
            type: adaptation.stage === 'rolled_back' ? 'adaptation_rollback' : 'adaptation_retired',
            category: 'adaptation',
            summary: `adaptation ${adaptation.id.slice(0, 8)} is ${adaptation.stage}`,
          });
        }
      }
      if (typeof this.experience.recentFeedback === 'function') {
        const feedback = await this.experience.recentFeedback({ limit: 20 });
        for (const row of feedback) {
          count += await this.#publish(state, `feedback:${row.id}`, {
            type: 'user_correction',
            category: 'memory',
            summary: 'the user recorded a correction about a completed outcome',
          });
        }
      }
    }
    // A recorded contradicted verdict is a lifecycle fact, not a new assessment.
    if (this.predictions && typeof this.predictions.list === 'function') {
      const page = await this.predictions.list({ limit: 50 });
      for (const prediction of page.projections ?? []) {
        const verdict = prediction.evaluation?.verdict ?? prediction.evaluationDecision ?? null;
        if (verdict !== 'contradicted') continue;
        count += await this.#publish(state, `prediction:${prediction.id}:contradicted`, {
          type: 'prediction_contradicted',
          category: 'prediction',
          summary: 'a recorded expectation was contradicted by recorded outcome evidence',
        });
      }
    }
    // Failed operations, with the audit record as the provenance.
    if (this.operations) {
      const page = await this.operations.list({ limit: 50 });
      for (const operation of page.records) {
        if (!['execution_failed', 'verification_failed'].includes(operation.status)) continue;
        count += await this.#publish(state, `operation:${operation.id}:failed`, {
          type: 'operation_failed',
          category: 'system',
          summary: `operation ${operation.id.slice(0, 8)} ended as ${operation.status}`,
          goalRefs: operation.goalId ? [operation.goalId] : [],
          planRefs: operation.planId ? [operation.planId] : [],
        });
      }
    }
    return count;
  }

  async #monitorDeadlines(state, at) {
    if (!this.goals) return 0;
    let count = 0;
    const nowMs = Date.parse(at);
    const goals = (await this.goals.list()).slice(0, 500);
    for (const goal of goals) {
      if (!OPEN_GOAL_STATUSES.includes(goal.status) || !goal.deadline) continue;
      const due = Date.parse(goal.deadline);
      if (Number.isNaN(due)) continue;
      if (due <= nowMs) {
        count += await this.#publish(state, `deadline:${goal.id}:${goal.deadline}:passed`, {
          type: 'deadline_passed',
          category: 'goal',
          summary: `goal ${goal.id.slice(0, 8)} is past its recorded deadline`,
          goalRefs: [goal.id],
        });
      } else if (due - nowMs <= this.config.deadlineHorizonMs) {
        count += await this.#publish(state, `deadline:${goal.id}:${goal.deadline}:approaching`, {
          type: 'deadline_approaching',
          category: 'goal',
          summary: `goal ${goal.id.slice(0, 8)} is due within ${Math.ceil((due - nowMs) / 3600000)} hour(s)`,
          goalRefs: [goal.id],
        });
      }
    }
    return count;
  }

  // ---- event processing ----------------------------------------------------

  async #processEvents(state, at) {
    const report = { processed: 0, decisions: 0, deadLettered: 0, retries: 0 };
    const page = await this.situation.events({ limit: Math.min(this.config.maxBacklog, MAX_EVENTS_READ) });
    const processed = new Set(state.checkpoint.processed);
    const rows = page.rows
      .filter((row) => !processed.has(row.event.id))
      .sort((a, b) => {
        const rank = (SIGNIFICANCE_RANK[b.assessment?.significance.level] ?? 0) - (SIGNIFICANCE_RANK[a.assessment?.significance.level] ?? 0);
        return rank !== 0 ? rank : (a.event.ingestedAt < b.event.ingestedAt ? -1 : 1);
      })
      .slice(0, this.config.maxEventsPerTick);
    for (const row of rows) {
      const event = row.event;
      if (event.source === RUNTIME_EVENT_SOURCE && event.type.startsWith('runtime_')) {
        state.checkpoint.processed.push(event.id);
        processed.add(event.id);
        continue;
      }
      if (row.decision) {
        state.checkpoint.processed.push(event.id);
        continue;
      }
      const key = `event:${event.id}`;
      const retry = state.retries[key];
      if (retry && Date.parse(retry.nextAt) > Date.parse(at)) {
        report.retries += 1;
        continue;
      }
      try {
        const assessment = row.assessment;
        let response = assessment && ['record', 'ignore', 'notify', 'recommend', 'request_approval'].includes(assessment.recommended)
          ? assessment.recommended
          : 'record';
        // A failed task, plan, operation or passed deadline is attention-worthy even when the
        // generic significance score only says "record". The runtime still does not execute.
        if (ATTENTION_TYPES.has(event.type) && !['notify', 'recommend', 'request_approval'].includes(response)) response = 'notify';
        await this.situation.decide(event.id, {
          response,
          reason: `runtime policy: ${assessment?.significance.level ?? 'unassessed'} significance${assessment ? ` (score ${assessment.significance.score})` : ''}`,
        });
        state.checkpoint.processed.push(event.id);
        delete state.retries[key];
        report.processed += 1;
        report.decisions += 1;
      } catch (err) {
        const attempts = (retry?.attempts ?? 0) + 1;
        if (attempts >= 2) {
          state.deadLetters.push(makeDeadLetter('event', event.id, 'processing_error', err?.message ?? String(err), at));
          state.counts.deadLettered += 1;
          state.checkpoint.processed.push(event.id);
          report.deadLettered += 1;
        } else {
          state.retries[key] = {
            attempts,
            nextAt: new Date(Date.parse(at) + this.config.retry.baseDelayMs).toISOString(),
            lastError: String(err?.message ?? err).slice(0, 300),
          };
          report.retries += 1;
        }
      }
    }
    state.checkpoint.processed = [...new Set(state.checkpoint.processed)];
    return report;
  }

  // ---- notifications -------------------------------------------------------

  #syncNotifications(state, at) {
    const nowMs = Date.parse(at);
    for (const notification of state.notifications) {
      if (!notification.acknowledged && !notification.expired && Date.parse(notification.expiresAt) <= nowMs) {
        notification.expired = true;
        notification.expiredAt = at;
      }
    }
  }

  // Notifications are derived from recorded decisions, keyed by decision id, so a restart or a
  // repeated tick cannot surface the same condition twice. Suppressed notices remain in history but
  // are not active attention requests.
  async #collectNotifications(state, at) {
    const page = await this.situation.decisions({ limit: 100 });
    const known = new Set(state.notifications.map((n) => n.decisionId));
    let added = 0;
    for (const decision of page.decisions) {
      if (!['notify', 'recommend', 'request_approval'].includes(decision.response)) continue;
      if (known.has(decision.id)) continue;
      state.notifications.push({
        id: this.idFactory(),
        decisionId: decision.id,
        eventId: decision.eventId,
        level: decision.response === 'request_approval' ? 'critical' : decision.response === 'recommend' ? 'high' : 'medium',
        response: decision.response,
        reason: decision.reason,
        suppressed: decision.notification?.suppressed === true,
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + this.config.notificationTtlMs).toISOString(),
        acknowledged: false,
        expired: false,
      });
      known.add(decision.id);
      added += 1;
    }
    this.#syncNotifications(state, at);
    return added;
  }

  async refreshNotifications() {
    const at = this.now().toISOString();
    const { state } = await this.stateStore.mutate(async (current) => {
      await this.#collectNotifications(current, at);
      return current;
    });
    return { notifications: state.notifications };
  }

  async notifications({ includeExpired = false } = {}) {
    await this.refreshNotifications();
    const loaded = await this.stateStore.load();
    const rows = loaded.state.notifications
      .filter((n) => includeExpired || (!n.expired && !n.acknowledged))
      .slice(-this.config.maxNotifications)
      .reverse();
    return { notifications: rows, total: loaded.state.notifications.length };
  }

  async acknowledge(ref) {
    const id = String(ref ?? '').trim();
    if (id.length < 4) throw new Error('a notification id is required');
    const { state } = await this.stateStore.mutate((current) => {
      const match = current.notifications.find((n) => n.id === id || n.id.startsWith(id));
      if (!match) throw new Error(`no notification matches ${id}`);
      match.acknowledged = true;
      match.acknowledgedAt = this.now().toISOString();
      return current;
    });
    return { acknowledged: true, notifications: state.notifications.filter((n) => n.acknowledged) };
  }

  // ---- scheduler -----------------------------------------------------------

  async schedule(planRef, { at, reason = 'scheduled by the user' } = {}) {
    const plan = await this.plans.resolve(planRef);
    if (plan.status !== 'approved') throw new Error(`plan ${plan.id} is ${plan.status}; only an approved plan can be scheduled`);
    const when = Date.parse(at);
    if (Number.isNaN(when)) throw new Error('a schedule needs an ISO date or date-time');
    const { state } = await this.stateStore.mutate((current) => {
      current.schedules = current.schedules.filter((entry) => entry.planId !== plan.id);
      current.schedules.push({ planId: plan.id, at: new Date(when).toISOString(), reason, createdAt: this.now().toISOString() });
      current.history.push({ type: 'scheduled', at: this.now().toISOString(), planId: plan.id, notBefore: new Date(when).toISOString() });
      return current;
    });
    return { planId: plan.id, schedules: state.schedules };
  }

  async unschedule(planRef) {
    const plan = await this.plans.resolve(planRef);
    const { state } = await this.stateStore.mutate((current) => {
      current.schedules = current.schedules.filter((entry) => entry.planId !== plan.id);
      return current;
    });
    return { planId: plan.id, schedules: state.schedules };
  }

  async cancelPlan(planRef, { reason = 'cancelled through the runtime' } = {}) {
    const plan = await this.plans.resolve(planRef);
    const result = await this.controller.planCancel({ target: plan.id, reason });
    return { planId: plan.id, status: result.status, output: result.output ?? result.display ?? null };
  }

  async #schedule(state, at) {
    const report = { executed: [], retries: 0, deadLettered: 0, skipped: [], learning: [] };
    const nowMs = Date.parse(at);
    const [plans, goals, tasks] = await Promise.all([this.plans.list(), this.goals?.list ? this.goals.list() : [], this.taskStore.list()]);
    const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
    const tasksByPlan = new Map();
    for (const task of tasks) {
      if (!task.planId) continue;
      const list = tasksByPlan.get(task.planId) ?? [];
      list.push(task);
      tasksByPlan.set(task.planId, list);
    }
    const candidates = [];
    for (const plan of plans) {
      if (plan.status !== 'approved') continue;
      const goal = plan.goalId ? goalsById.get(plan.goalId) : null;
      if (goal && !OPEN_GOAL_STATUSES.includes(goal.status)) {
        report.skipped.push({ planId: plan.id, reason: `its goal is ${goal.status}` });
        continue;
      }
      const unmet = (goal?.dependsOn ?? []).filter((id) => {
        const dependency = goalsById.get(id);
        return !dependency || dependency.status !== 'completed';
      });
      if (unmet.length > 0) {
        report.skipped.push({ planId: plan.id, reason: `goal dependencies are not complete: ${unmet.join(', ')}` });
        continue;
      }
      const schedule = state.schedules.find((entry) => entry.planId === plan.id);
      if (schedule && Date.parse(schedule.at) > nowMs) {
        report.skipped.push({ planId: plan.id, reason: `scheduled for ${schedule.at}` });
        continue;
      }
      const inFlight = (tasksByPlan.get(plan.id) ?? []).filter((task) => TASK_IN_FLIGHT.includes(task.status));
      if (inFlight.length > 0) {
        report.skipped.push({ planId: plan.id, reason: `a task for this plan is ${inFlight[0].status}` });
        continue;
      }
      const retry = state.retries[`plan:${plan.id}`];
      if (retry) {
        if (retry.attempts >= this.config.retry.maxAttempts) {
          state.deadLetters.push(makeDeadLetter('plan', plan.id, 'retry_exhausted', `the last attempt ended as ${retry.lastOutcome ?? 'unknown'}`, at));
          state.counts.deadLettered += 1;
          report.deadLettered += 1;
          delete state.retries[`plan:${plan.id}`];
          continue;
        }
        if (Date.parse(retry.nextAt) > nowMs) {
          report.skipped.push({ planId: plan.id, reason: `retry ${retry.attempts}/${this.config.retry.maxAttempts} waits until ${retry.nextAt}` });
          report.retries += 1;
          continue;
        }
      }
      candidates.push({ plan, goal });
    }
    candidates.sort((a, b) => {
      const pa = Number.isInteger(a.goal?.priority) ? a.goal.priority : 3;
      const pb = Number.isInteger(b.goal?.priority) ? b.goal.priority : 3;
      if (pa !== pb) return pa - pb;
      const da = a.goal?.deadline ? Date.parse(a.goal.deadline) : Number.MAX_SAFE_INTEGER;
      const db = b.goal?.deadline ? Date.parse(b.goal.deadline) : Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return a.plan.id < b.plan.id ? -1 : 1;
    });
    this.lastScheduleReport = { evaluated: candidates.length, executed: 0, skipped: report.skipped };
    for (const candidate of candidates.slice(0, this.config.maxActionsPerTick)) {
      const result = await this.#runPlan(candidate.plan, state, at);
      report.executed.push(result);
      if (result.retryScheduled) report.retries += 1;
      if (result.deadLettered) report.deadLettered += 1;
      if (result.learning) report.learning.push(result.learning);
    }
    this.lastScheduleReport.executed = report.executed.length;
    return report;
  }

  async #runPlan(plan, state, at) {
    let activation = null;
    let error = null;
    try {
      activation = await this.controller.planActivate(plan.id, { mode: 'run' });
    } catch (err) {
      error = err;
    }
    let after = null;
    try {
      after = await this.plans.get(plan.id);
    } catch {
      after = null;
    }
    const failed = error !== null || !after || FAILED_PLAN_STATUSES.includes(after.status);
    if (failed) {
      const key = `plan:${plan.id}`;
      const attempts = (state.retries[key]?.attempts ?? 0) + 1;
      const delay = this.config.retry.baseDelayMs * this.config.retry.multiplier ** (attempts - 1);
      const lastOutcome = after?.status ?? 'not recorded';
      if (attempts >= this.config.retry.maxAttempts) {
        state.deadLetters.push(makeDeadLetter('plan', plan.id, 'retry_exhausted', `attempt ${attempts} ended as ${lastOutcome}`, at));
        state.counts.deadLettered += 1;
        delete state.retries[key];
        state.history.push({ type: 'plan_dead_lettered', at, planId: plan.id, attempts, outcome: lastOutcome });
        return { planId: plan.id, status: 'dead_lettered', outcome: lastOutcome, deadLettered: true };
      }
      state.retries[key] = {
        attempts,
        nextAt: new Date(Date.parse(at) + delay).toISOString(),
        lastOutcome,
        lastError: error ? String(error.message).slice(0, 300) : null,
      };
      state.history.push({ type: 'plan_retry_scheduled', at, planId: plan.id, attempts, nextAt: state.retries[key].nextAt });
      return { planId: plan.id, status: 'retry_scheduled', outcome: lastOutcome, nextAt: state.retries[key].nextAt, retryScheduled: true };
    }
    delete state.retries[`plan:${plan.id}`];
    state.schedules = state.schedules.filter((entry) => entry.planId !== plan.id);
    state.history.push({ type: 'plan_executed', at, planId: plan.id, status: after.status, operationId: activation?.operation?.id ?? null });
    let learning = null;
    if (this.learning && this.experience && after.status === 'completed') {
      try {
        const { evaluation } = await this.learning.evaluate(plan.id);
        const { record } = await this.experience.recordEvaluation(evaluation, {
          provenance: { operationId: activation?.operation?.id ?? null },
          origin: 'user',
        });
        learning = { planId: plan.id, evaluationId: record.id, classification: record.classification };
      } catch (err) {
        state.history.push({ type: 'learning_link_failed', at, planId: plan.id, error: String(err?.message ?? err).slice(0, 300) });
      }
    }
    return { planId: plan.id, status: after.status, outcome: activation?.status ?? null, operationId: activation?.operation?.id ?? null, learning };
  }

  // ---- inspection -----------------------------------------------------------

  async #interruptedTasks() {
    const tasks = await this.taskStore.list();
    return tasks.filter((task) => ['running', 'paused'].includes(task.status));
  }

  #dependencyProblems() {
    const problems = [];
    if (!this.situation || typeof this.situation.ingest !== 'function') problems.push('situational awareness is unavailable');
    if (!this.taskStore || typeof this.taskStore.list !== 'function') problems.push('the task store is unavailable');
    if (!this.plans || typeof this.plans.list !== 'function') problems.push('the plan store is unavailable');
    if (!this.operations || typeof this.operations.list !== 'function') problems.push('the audit log is unavailable');
    return problems;
  }

  async status() {
    const loaded = await this.stateStore.load();
    const state = loaded.state;
    // Derived in memory only: reading the status must not create or rewrite a store file.
    await this.#collectNotifications(state, this.now().toISOString());
    const [tasks, plans] = await Promise.all([this.taskStore.list(), this.plans.list()]);
    const interrupted = tasks.filter((task) => ['running', 'paused'].includes(task.status));
    const blocked = tasks.filter((task) => task.status === 'failed');
    const notifications = state.notifications.filter((n) => !n.acknowledged && !n.expired);
    let situational = null;
    try {
      const page = await this.situation.status();
      situational = page.available ? { available: true, events: page.counts.events, decisions: page.counts.decisions, pendingApprovals: page.counts.pendingApprovals, suppressed: page.counts.suppressedNotifications } : { available: false, detail: page.detail };
    } catch (err) {
      situational = { available: false, detail: err?.message ?? String(err) };
    }
    const processed = new Set(state.checkpoint.processed);
    let backlog = 0;
    try {
      const page = await this.situation.events({ limit: maxBacklogProbe() });
      backlog = page.rows.filter((row) => !processed.has(row.event.id)).length;
    } catch {
      backlog = null;
    }
    return {
      at: this.now().toISOString(),
      lifecycle: state.lifecycle,
      runtimeId: state.runtimeId,
      version: state.version,
      configVersion: state.config.version,
      paused: state.paused,
      boots: state.boots,
      ticks: state.tickCount,
      lastTickAt: state.lastTickAt,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      uptimeMs: state.lifecycle === 'running' && state.startedAt ? this.now().getTime() - Date.parse(state.startedAt) : 0,
      lease: this.lease.inspect(),
      checkpoint: {
        processed: state.checkpoint.processed.length,
        published: state.checkpoint.published.length,
        processedCap: this.config.maxProcessedIds,
        publishedCap: this.config.maxPublishedKeys,
      },
      backlog,
      counts: { ...state.counts },
      notifications: {
        active: notifications.length,
        suppressed: notifications.filter((n) => n.suppressed).length,
        total: state.notifications.length,
        recent: notifications.slice(-5).reverse().map((n) => ({ id: n.id, level: n.level, reason: n.reason, decisionId: n.decisionId })),
      },
      schedule: state.schedules.slice().sort((a, b) => (a.at < b.at ? -1 : 1)),
      retries: Object.entries(state.retries).map(([key, value]) => ({ key, ...value })),
      deadLetters: state.deadLetters.slice(-10),
      interrupted: interrupted.map((task) => ({ id: task.id, status: task.status, planId: task.planId ?? null, goalId: task.goalId ?? null })),
      blockedTasks: blocked.map((task) => ({ id: task.id, planId: task.planId ?? null, goalId: task.goalId ?? null })),
      activePlans: plans.filter((plan) => ['approved', 'active'].includes(plan.status)).map((plan) => ({ id: plan.id, status: plan.status, outcome: plan.outcome })),
      lastSchedule: this.lastScheduleReport,
      integrations: this.integrations ? await this.integrations.summary().catch((err) => ({ available: false, detail: err?.message ?? String(err) })) : null,
      situational,
      lastError: this.lastError,
      history: state.history.slice(-10),
      corruption: loaded.corruption,
      config: { ...this.config },
    };
  }

  async diagnose() {
    const loaded = await this.stateStore.load();
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add('runtime identity', typeof loaded.state.runtimeId === 'string' && loaded.state.runtimeId.length > 0, loaded.state.runtimeId ?? 'missing');
    add('checkpoint readable', !loaded.corruption, loaded.corruption ? `${loaded.corruption.reason}; preserved at ${loaded.corruption.quarantinedAt}` : 'the checkpoint parses and its checksum matches');
    const deps = this.#dependencyProblems();
    add('dependencies', deps.length === 0, deps.length === 0 ? 'controller, situational service, task store, plan store and audit log are present' : deps.join('; '));
    const held = this.lease.inspect();
    add('single instance', !held.held || held.runtimeId === loaded.state.runtimeId, held.held ? `held by pid ${held.pid}` : 'no lease is held');
    add('runner available', typeof this.controller.planActivate === 'function', 'the existing plan activation path is the only way work runs');
    add('audit available', typeof this.operations.list === 'function', 'responses can cite the operation audit');
    try {
      const situational = await this.situation.status();
      add('situational log', situational.available === true, situational.available ? `${situational.counts.events} event(s)` : situational.detail);
    } catch (err) {
      add('situational log', false, err?.message ?? String(err));
    }
    try {
      const taskStatus = await this.taskStore.inspect();
      add('task log', taskStatus.corrupt.length === 0 && taskStatus.problems.length === 0, `${taskStatus.corrupt.length} corrupt line(s), ${taskStatus.problems.length} unapplied event(s)`);
    } catch (err) {
      add('task log', false, err?.message ?? String(err));
    }
    const interrupted = await this.#interruptedTasks();
    add('interrupted work', true, interrupted.length === 0 ? 'no task is recorded as running or paused' : `${interrupted.length} task(s) are recorded in flight and will not be re-run automatically`);
    add('inference', true, 'the runtime makes no model call and holds no inference handle');
    return { at: this.now().toISOString(), runtimeId: loaded.state.runtimeId, lifecycle: loaded.state.lifecycle, checks, healthy: checks.every((c) => c.ok) };
  }

  async #emit(type, category, summary, goalRefs, planRefs, taskRefs) {
    try {
      await this.situation.ingest({
        source: RUNTIME_EVENT_SOURCE,
        sourceEventId: `runtime:${type}:${this.runtimeId}`,
        type,
        category,
        observedAt: this.now().toISOString(),
        payload: { summary },
        confidence: 1,
        entityRefs: [],
        goalRefs,
        planRefs,
        taskRefs,
        provenance: { reporter: 'executive-runtime', runtimeId: this.runtimeId },
      });
    } catch (err) {
      this.lastError = `runtime event ${type} could not be published: ${err?.message ?? String(err)}`;
    }
  }
}

function maxBacklogProbe() {
  return DEFAULT_EVENTS_READ * 5;
}
