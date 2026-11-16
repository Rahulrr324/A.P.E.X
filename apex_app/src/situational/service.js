// Situational awareness service: the deterministic pipeline
// EVENT -> OBSERVATION -> WORLD UPDATE -> CHANGE DETECTION -> CONTEXT -> ASSESSMENT -> DECISION
// -> AUTHORIZED ACTION -> OUTCOME -> LEARNING.
//
// It owns no second world model, planner, or runner. Observations with a fact or world event are
// written through the existing WorldModelStore, context is read from the existing goal, plan, task,
// prediction and world stores, and an approved response is executed by the controller through the
// same registry every other command uses. This class only normalises, deduplicates, scores and
// records.
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { MAX_NOTIFICATIONS_PER_HOUR, NOTIFY_COOLDOWN_MS, RESPONSE_ACTION_GUARD, RESPONSES } from './vocabulary.js';
import { canonicalJson, fingerprintOf } from './model.js';
import { assessEvent } from './significance.js';

const HOUR = 60 * 60 * 1000;

function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value ?? {})).digest('hex');
}

function question(userText) {
  return `situation ${userText}`;
}

export class SituationService {
  constructor({
    store, worldModel, goals, plans, tasks, predictions, learning, experience, operations, registry,
    now = () => new Date(), idFactory = () => crypto.randomUUID(),
  } = {}) {
    if (!store) throw new TypeError('SituationService requires a situational store');
    this.store = store;
    this.worldModel = worldModel;
    this.goals = goals;
    this.plans = plans;
    this.tasks = tasks;
    this.predictions = predictions;
    this.learning = learning;
    this.experience = experience;
    this.operations = operations;
    this.registry = registry;
    this.now = now;
    this.idFactory = idFactory;
  }

  // ---- context --------------------------------------------------------------

  async #lists() {
    const [goals, plans, tasks] = await Promise.all([
      this.goals?.list ? this.goals.list() : [],
      this.plans?.list ? this.plans.list() : [],
      this.tasks?.list ? this.tasks.list() : [],
    ]);
    return { goals, plans, tasks };
  }

  async #contextFor(event) {
    const { goals, plans, tasks } = await this.#lists();
    let world = { conflicts: 0, conflictEntities: [] };
    if (this.worldModel?.conflicts) {
      try {
        const conflicts = await this.worldModel.conflicts();
        world = {
          conflicts: conflicts?.counts?.groups ?? 0,
          // A conflict group names the claims, not always an entity id in every version, so this
          // list is best-effort and the count is the value the assessment reports.
          conflictEntities: [...new Set((conflicts?.groups ?? []).flatMap((group) => (
            Array.isArray(group.entityIds) ? group.entityIds : group.entityId ? [group.entityId] : []
          )))],
        };
      } catch {
        world = { conflicts: 0, conflictEntities: [], unavailable: true };
      }
    }
    return { goals, plans, tasks, world };
  }

  // ---- ingest ---------------------------------------------------------------

  async #checkRefs({ goalRefs, planRefs, taskRefs, entityRefs }) {
    for (const ref of goalRefs) {
      try {
        await this.goals.resolve(ref);
      } catch (err) {
        throw new ValidationError(`goal reference ${ref} cannot be used: ${err?.message ?? String(err)}`);
      }
    }
    for (const ref of planRefs) {
      try {
        await this.plans.resolve(ref);
      } catch (err) {
        throw new ValidationError(`plan reference ${ref} cannot be used: ${err?.message ?? String(err)}`);
      }
    }
    for (const ref of taskRefs) {
      try {
        await this.tasks.resolve(ref);
      } catch (err) {
        throw new ValidationError(`task reference ${ref} cannot be used: ${err?.message ?? String(err)}`);
      }
    }
    for (const ref of entityRefs) {
      let view;
      try {
        view = await this.worldModel.showEntity(ref);
      } catch (err) {
        throw new ValidationError(`entity reference ${ref} cannot be checked: ${err?.message ?? String(err)}`);
      }
      if (view?.problem) throw new ValidationError(`entity reference ${ref} cannot be used: ${view.problem}`);
    }
  }

  // One world write for the observation's fact or world event. A stale observation is preserved in
  // the situational log but is not asserted as current world state.
  async #applyWorld(spec, event, expired) {
    const refs = {};
    if (expired) return { skipped: 'expired' };
    if (!this.worldModel) return { skipped: 'no-world-model' };
    const fact = spec.payload?.fact;
    if (fact && typeof fact === 'object') {
      if (event.entityRefs.length === 0) throw new ValidationError('a fact observation must name the entity it is about');
      const predicate = typeof fact.predicate === 'string' ? fact.predicate : null;
      if (!predicate) throw new ValidationError('a fact observation needs a predicate');
      const raw = fact.object ?? fact.value;
      const object = raw && typeof raw === 'object'
        ? raw
        : { kind: 'scalar', valueType: 'string', value: String(raw ?? '') };
      const written = await this.worldModel.assertFact({
        origin: 'user',
        subjectId: event.entityRefs[0],
        predicate,
        object,
        validFrom: fact.validFrom ?? event.observedAt,
        validUntil: fact.validUntil ?? event.validUntil,
        observedAt: event.observedAt,
        confidence: { value: event.confidence, basis: `stated by ${event.source}` },
        supersedes: Array.isArray(fact.supersedes) ? fact.supersedes : [],
        evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
      });
      refs.factId = written.record.factId;
      refs.entityId = event.entityRefs[0];
    }
    const worldEvent = spec.payload?.worldEvent;
    if (worldEvent && typeof worldEvent === 'object') {
      if (event.entityRefs.length === 0) throw new ValidationError('a world event must name at least one participant entity');
      const written = await this.worldModel.recordEvent({
        origin: 'user',
        eventType: typeof worldEvent.eventType === 'string' ? worldEvent.eventType : event.type,
        participants: event.entityRefs,
        occurredAt: worldEvent.occurredAt ?? event.observedAt,
        observedAt: event.observedAt,
        properties: worldEvent.properties ?? null,
        evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
      });
      refs.eventId = written.record.worldEventId;
    }
    return refs;
  }

  async ingest(spec) {
    const now = this.now();
    const nowIso = now.toISOString();
    const observedAt = spec.observedAt ?? nowIso;
    const validUntil = spec.validUntil ?? null;
    const expired = validUntil !== null && Date.parse(validUntil) <= now.getTime();
    const fingerprint = fingerprintOf(spec.payload ?? {});
    const existing = await this.store.findEvent({
      source: spec.source,
      sourceEventId: spec.sourceEventId,
      fingerprint,
    });
    if (existing.inconsistent) {
      throw new ValidationError(
        `source event ${spec.sourceEventId} is already recorded with different content; a replay must carry the same payload`,
        'EVENT_REPLAY_INCONSISTENT',
      );
    }
    if (existing.duplicate) {
      const assessment = (await this.store.snapshot({ limit: 1 })).assessments.get(existing.event.id) ?? null;
      return { event: existing.event, assessment, duplicate: true };
    }

    await this.#checkRefs(spec);
    if (spec.source === 'apex') {
      const operationId = spec.provenance?.operationId;
      if (!operationId) throw new ValidationError('an APEX lifecycle event must cite the operation it came from');
      if (!this.operations || typeof this.operations.findById !== 'function') {
        throw new ValidationError('the audit log is not available, so an APEX lifecycle event cannot be checked');
      }
      const found = await this.operations.findById(operationId);
      if (!found?.found) throw new ValidationError(`operation ${operationId} is not in the audit log; the lifecycle event was not accepted`);
    }

    const event = {
      schema: 'apex.situation/1',
      kind: 'event_observed',
      id: this.idFactory(),
      source: spec.source,
      sourceEventId: spec.sourceEventId,
      type: spec.type,
      category: spec.category,
      observedAt,
      ingestedAt: nowIso,
      payload: spec.payload ?? {},
      confidence: spec.confidence,
      provenance: {
        origin: 'user',
        reporter: spec.provenance?.reporter ?? spec.source,
        operationId: spec.provenance?.operationId ?? null,
        provider: spec.provenance?.provider ?? null,
      },
      entityRefs: [...(spec.entityRefs ?? [])],
      goalRefs: [...(spec.goalRefs ?? [])],
      planRefs: [...(spec.planRefs ?? [])],
      taskRefs: [...(spec.taskRefs ?? [])],
      validUntil,
      integrity: { algorithm: 'sha256', digest: fingerprint, validated: true },
      fingerprint,
      worldRefs: {},
      at: nowIso,
      origin: 'user',
    };

    // World first: if the world refuses the observation, no situational event claims it was applied.
    event.worldRefs = await this.#applyWorld(spec, event, expired);
    const observed = await this.store.observe(event);
    if (observed.duplicate) {
      const assessment = (await this.store.snapshot({ limit: 1 })).assessments.get(observed.record.id) ?? null;
      return { event: observed.record, assessment, duplicate: true };
    }

    const context = await this.#contextFor(observed.record);
    const reading = assessEvent({ event: observed.record, context, now: nowIso, duplicate: false });
    const assessment = await this.store.recordAssessment({
      eventId: observed.record.id,
      assessmentId: this.idFactory(),
      spec: reading,
    });
    return { event: observed.record, assessment, duplicate: false };
  }

  // ---- evaluation -----------------------------------------------------------

  async evaluate(ref) {
    const event = await this.store.event(ref);
    const context = await this.#contextFor(event);
    const reading = assessEvent({ event, context, now: this.now().toISOString(), duplicate: false });
    const assessment = await this.store.recordAssessment({
      eventId: event.id,
      assessmentId: this.idFactory(),
      spec: reading,
    });
    return { event, assessment };
  }

  async latestAssessment(eventId) {
    const snapshot = await this.store.snapshot({ limit: 1 });
    return snapshot.assessments.get(eventId) ?? null;
  }

  // ---- decisions ------------------------------------------------------------

  async decide(eventId, { response, action = null, input = null, reason }) {
    if (!RESPONSES.includes(response)) throw new ValidationError(`response must be one of: ${RESPONSES.join(', ')}`);
    const event = await this.store.event(eventId);
    const assessment = await this.latestAssessment(event.id);
    if (!assessment) throw new ValidationError('the event has no recorded assessment; evaluate it first');

    let inputDigest = null;
    if (response === 'execute') {
      if (typeof action !== 'string' || action.length === 0) {
        throw new ValidationError('an execute decision must name one registered action');
      }
      if (RESPONSE_ACTION_GUARD.includes(action)) {
        throw new ValidationError(`"${action}" cannot be chosen as an event response: an event must not drive the awareness or approval surface`);
      }
      const def = this.registry?.get(action);
      if (!def) throw new ValidationError(`"${action}" is not a registered action`);
      const allowed = this.registry.authorize(action, 'user');
      if (allowed.decision !== 'allow') throw new ValidationError(`the registry refuses "${action}" for a user operation: ${allowed.reason}`);
      // The action's own validator decides whether the proposed input is usable. Nothing runs here.
      try {
        def.validate(input ?? {});
      } catch (err) {
        throw new ValidationError(`the proposed input for ${action} is not usable: ${err?.message ?? String(err)}`);
      }
      inputDigest = digestOf(input ?? {});
    } else if (action !== null) {
      throw new ValidationError(`a ${response} decision runs no action, so it cannot name one`);
    }

    const key = `${event.category}:${event.type}:${[...event.entityRefs, ...event.goalRefs].sort().join(',')}`;
    const nowMs = this.now().getTime();
    const recent = (await this.store.snapshot({ limit: 1 })).decisions
      .filter((decision) => decision.notification?.dedupeKey === key
        && !decision.notification?.suppressed
        && ['notify', 'recommend', 'request_approval'].includes(decision.response)
        && nowMs - Date.parse(decision.at) <= HOUR);
    let suppressed = false;
    let suppressionReason = null;
    if (['notify', 'recommend', 'request_approval'].includes(response)) {
      if (recent.length >= MAX_NOTIFICATIONS_PER_HOUR) {
        suppressed = true;
        suppressionReason = `${MAX_NOTIFICATIONS_PER_HOUR} comparable notices were already surfaced in the last hour`;
      } else {
        const last = recent.map((d) => Date.parse(d.at)).sort((a, b) => b - a)[0];
        if (last !== undefined && nowMs - last < NOTIFY_COOLDOWN_MS) {
          suppressed = true;
          suppressionReason = `the same condition was surfaced ${Math.round((nowMs - last) / 60000)} minute(s) ago, inside the ${Math.round(NOTIFY_COOLDOWN_MS / 60000)}-minute cooldown`;
        }
      }
    }

    const decision = await this.store.recordDecision({
      eventId: event.id,
      assessmentId: assessment.id,
      decisionId: this.idFactory(),
      response,
      action,
      inputDigest,
      reason,
      notification: { dedupeKey: key, suppressed, reason: suppressionReason },
    });
    return { event, assessment, decision };
  }

  async decisionForExecution(ref) {
    const decision = await this.store.decision(ref);
    if (decision.response !== 'execute') {
      throw new ValidationError(`decision ${decision.id} chose ${decision.response}, not execute; nothing is run`);
    }
    if (decision.responseRecord) {
      throw new ValidationError(`decision ${decision.id} already ran as ${decision.responseRecord.action}; it is not run twice`);
    }
    return decision;
  }

  // The decision stores only the digest of the approved input, not the input itself: an event must
  // not become a place where a credential-shaped value is kept. The caller supplies the input again
  // and it must hash to the approved digest, so an approval cannot be stretched to different bytes.
  async executionFor(ref, input) {
    const decision = await this.decisionForExecution(ref);
    if (decision.inputDigest !== digestOf(input ?? {})) {
      throw new ValidationError('the input supplied for execution does not match the input approved in the decision; nothing was run', 'EXECUTION_INPUT_MISMATCH');
    }
    return decision;
  }

  async decisionForExecutionOrRead(ref) {
    return this.store.decision(ref);
  }

  async recordResponse(decisionId, { operationId, action, outcome, status, evaluationId = null, experienceId = null }) {
    const decision = await this.store.decision(decisionId);
    const event = await this.store.event(decision.eventId);
    return this.store.recordResponse({
      schema: 'apex.situation/1',
      kind: 'response_recorded',
      id: this.idFactory(),
      eventId: event.id,
      decisionId: decision.id,
      responseId: this.idFactory(),
      operationId,
      action,
      outcome,
      status,
      evaluationId,
      experienceId,
      at: this.now().toISOString(),
      origin: 'user',
    });
  }

  // ---- reads ----------------------------------------------------------------

  async events({ limit } = {}) {
    return this.store.events({ limit });
  }

  async decisions({ limit, event } = {}) {
    let eventId = null;
    if (event !== undefined && event !== null) eventId = (await this.store.event(event)).id;
    return this.store.decisions({ limit, eventId });
  }

  async state({ limit = 10 } = {}) {
    const snapshot = await this.store.snapshot({ limit });
    const events = [...snapshot.events.values()].sort((a, b) => (a.ingestedAt < b.ingestedAt ? 1 : -1));
    const recent = events.slice(0, Math.max(1, Math.min(limit, 20))).map((event) => {
      const assessment = snapshot.assessments.get(event.id) ?? null;
      const decision = [...snapshot.decisions].reverse().find((d) => d.eventId === event.id) ?? null;
      return {
        id: event.id,
        source: event.source,
        type: event.type,
        category: event.category,
        at: event.observedAt,
        ingestedAt: event.ingestedAt,
        effectiveAt: event.observedAt,
        confidence: event.confidence,
        stale: event.validUntil !== null && Date.parse(event.validUntil) <= this.now().getTime(),
        significance: assessment?.significance ?? null,
        recommended: assessment?.recommended ?? null,
        decision: decision ? { id: decision.id, response: decision.response, suppressed: decision.notification?.suppressed === true } : null,
        worldRefs: event.worldRefs,
      };
    });

    const alerts = [];
    const uncertainty = [];
    const pending = [];
    const recommendations = [];
    for (const event of events) {
      const assessment = snapshot.assessments.get(event.id);
      if (!assessment) continue;
      const decision = [...snapshot.decisions].reverse().find((d) => d.eventId === event.id) ?? null;
      if (['high', 'critical'].includes(assessment.significance.level) && (!decision || decision.response !== 'ignore')) {
        alerts.push({ eventId: event.id, level: assessment.significance.level, type: event.type, summary: event.payload?.summary ?? event.type, decision: decision?.id ?? null });
      }
      for (const text of assessment.uncertainty) uncertainty.push({ eventId: event.id, text });
      if (decision) {
        if (decision.response === 'request_approval' && !snapshot.responseByDecision.has(decision.id)) {
          pending.push({ decisionId: decision.id, eventId: event.id, reason: decision.reason, at: decision.at, action: decision.action });
        }
        if (decision.response === 'recommend' && !snapshot.responseByDecision.has(decision.id)) {
          recommendations.push({ decisionId: decision.id, eventId: event.id, reason: decision.reason, suppressed: decision.notification?.suppressed === true, at: decision.at });
        }
      }
    }

    let world = { conflicts: 0 };
    if (this.worldModel?.conflicts) {
      try {
        const conflicts = await this.worldModel.conflicts();
        world = { conflicts: conflicts?.counts?.groups ?? 0 };
      } catch {
        world = { conflicts: null, unavailable: true };
      }
    }
    let learning = null;
    if (this.learning?.status) {
      try {
        const report = await this.learning.status({ limit: 1 });
        learning = { evaluations: report.evaluations?.total ?? null, adaptations: report.adaptations?.total ?? null };
      } catch {
        learning = { unavailable: true };
      }
    }

    return {
      at: this.now().toISOString(),
      counts: {
        events: snapshot.events.length,
        assessments: snapshot.assessments.size,
        decisions: snapshot.decisions.length,
        responses: snapshot.responses.length,
        alerts: alerts.length,
        pendingApprovals: pending.length,
        recommendations: recommendations.length,
        suppressed: snapshot.decisions.filter((d) => d.notification?.suppressed).length,
      },
      recent,
      alerts: alerts.slice(0, 10),
      uncertainty: uncertainty.slice(0, 20),
      understanding: {
        observedEvents: snapshot.events.length,
        unresolvedWorldConflicts: world.conflicts,
        wording: 'This is a reading of recorded observations and stored claims, not a claim about the real world beyond them.',
      },
      pendingApprovals: pending.slice(0, 10),
      recommendations: recommendations.slice(0, 10),
      actionsTaken: snapshot.responses.slice(-10).map((response) => ({
        responseId: response.id,
        eventId: response.eventId,
        action: response.action,
        outcome: response.outcome,
        operationId: response.operationId,
        evaluationId: response.evaluationId,
        experienceId: response.experienceId,
        at: response.at,
      })),
      learning,
      limits: { recent: recent.length, alerts: 10, pendingApprovals: 10, recommendations: 10 },
    };
  }

  async status() {
    const status = await this.store.status();
    if (!status.available) return status;
    const snapshot = await this.store.snapshot({ limit: 1 });
    const levels = { none: 0, low: 0, medium: 0, high: 0, critical: 0 };
    for (const assessment of snapshot.assessments.values()) {
      if (levels[assessment.significance.level] !== undefined) levels[assessment.significance.level] += 1;
    }
    return {
      ...status,
      counts: {
        ...status.counts,
        byLevel: levels,
        pendingApprovals: snapshot.decisions.filter((d) => d.response === 'request_approval'
          && !snapshot.responseByDecision.has(d.id)).length,
        suppressedNotifications: snapshot.decisions.filter((d) => d.notification?.suppressed).length,
        executedResponses: snapshot.responses.filter((r) => r.status === 'executed').length,
        failedResponses: snapshot.responses.filter((r) => r.status === 'failed').length,
      },
    };
  }

  // Kept for the action layer: a short request label without quoting the event payload.
  requestLabel(event) {
    return question(`${event.category}/${event.type}`);
  }
}
