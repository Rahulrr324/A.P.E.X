// T-29 unified cognitive pipeline.
//
// One owner-requested intent goes through five recorded stages:
//
//   1. context     - what the system actually holds: owner context, memory, knowledge,
//                    world-model facts tagged with an epistemic status, active goals and
//                    the Sentinel reading. Every item names where it came from.
//   2. salience    - read-only regulatory variables computed from that packet with a stated
//                    basis, plus Sentinel advisories. Nothing here decides anything; the
//                    Sentinel may advise, never authorize.
//   3. council     - the deterministic Council perspective synthesis, cited against the
//                    packet, when uncertainty, risk or impact warrants it. A recommendation
//                    is deliberation data and never a permission.
//   4. task_graph  - the executable plan: one step per concrete action, with the permission
//                    and risk the registry declares for it.
//   5. execution   - governed execution strictly through the controller, the registry and the
//                    ECP. A write or L2+ step pauses as `awaiting_approval` with a real
//                    approval record; only an explicit owner approval lets it run, and
//                    `verified: true` is recorded only when the verifier says so.
//
// Fail-closed rules: if the kill-switch latch is active, or its policy state is unreadable,
// or the ECP denies the concrete action, the pipeline halts before any execution and the
// refusal is written to the operation audit trail by the controller. A run record is an
// account of what happened, never an authorization.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';
import { ValidationError } from '../errors.js';
import { compileMission, MissionError } from './missions.js';
import { blockedNodes as blockedNodesOf, unmetDependencies } from '../tasks/model.js';
import { associationEnvelope, candidateAssociations } from './associations.js';

export const PIPELINE_SCHEMA = 'apex.cognition.pipeline/1';
export const RUN_SCHEMA = 'apex.cognition.run/1';
export const PACKET_SCHEMA = 'apex.cognition.context/1';

// The five stages the Cognitive Trace renders, in order.
export const COGNITION_STAGES = Object.freeze(['context', 'salience', 'council', 'task_graph', 'execution']);

const RUN_STATUSES = Object.freeze(['running', 'awaiting_approval', 'completed', 'halted', 'failed']);

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 1000) / 1000));
}

function round3(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : null;
}

function text(value, max = 400) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// A read failure is reported, never disguised as emptiness.
async function attempt(fn, fallback) {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: fallback, error: text(String(err?.message ?? err), 240) };
  }
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

const PREDICTED = /predict|forecast|projection/i;
const ASSUMED = /assum/i;

// Epistemic status is a property of the record, decided by fixed rules over its own fields.
// It is never a judgement about whether the fact is true.
export function epistemicStatus(fact) {
  if (!fact || typeof fact !== 'object') return 'inferred';
  const provenance = fact.provenance && typeof fact.provenance === 'object' ? fact.provenance : {};
  const source = String(provenance.origin ?? provenance.source ?? fact.origin ?? fact.source ?? '');
  if (PREDICTED.test(source) || fact.kind === 'prediction') return 'predicted';
  if (ASSUMED.test(source) || fact.status === 'assumed' || provenance.assumed === true) return 'assumed';
  const confidence = Number.isFinite(fact.confidence) ? fact.confidence : 0.5;
  const evidence = listOf(provenance.evidenceIds ?? fact.evidence ?? fact.evidenceIds ?? []);
  if (confidence >= 0.8 && evidence.length > 0) return 'observed';
  return 'inferred';
}

function memoryItem(hit) {
  const record = hit && typeof hit === 'object' && hit.record && typeof hit.record === 'object' ? hit.record : hit;
  if (!record || typeof record !== 'object') return null;
  return {
    id: text(record.id, 60) || null,
    content: text(record.content ?? record.text ?? '', 240),
    kind: text(record.kind, 40) || null,
    at: record.at ?? record.createdAt ?? null,
    source: text(record.source, 40) || null,
  };
}

function knowledgeItem(claim) {
  if (!claim || typeof claim !== 'object') return null;
  return {
    id: text(claim.id ?? claim.claimId, 60) || null,
    claim: text(claim.claim ?? claim.statement ?? claim.text ?? '', 240),
    status: text(claim.status, 40) || null,
    confidence: Number.isFinite(claim.confidence) ? claim.confidence : null,
    epistemic: ASSUMED.test(String(claim.status ?? '')) ? 'assumed' : (claim.status === 'supported' ? 'observed' : 'inferred'),
  };
}

function worldItem(fact) {
  if (!fact || typeof fact !== 'object') return null;
  const value = fact.value ?? fact.object ?? fact.text ?? null;
  return {
    id: text(fact.id ?? fact.factId, 60) || null,
    subject: text(fact.subject ?? fact.entityId ?? fact.entity ?? '', 80) || null,
    predicate: text(fact.predicate ?? fact.attribute ?? fact.key ?? '', 80) || null,
    value: typeof value === 'string' ? text(value, 160) : (value === null ? null : text(JSON.stringify(value), 160)),
    confidence: Number.isFinite(fact.confidence) ? round3(fact.confidence) : null,
    epistemic: epistemicStatus(fact),
  };
}

function goalItem(goal) {
  if (!goal || typeof goal !== 'object') return null;
  const criteria = listOf(goal.criteria);
  const met = criteria.filter((c) => c && (c.status === 'met' || c.met === true)).length;
  const progress = criteria.length === 0 ? null : round3(met / criteria.length);
  return {
    id: text(goal.id ?? goal.goalId, 60) || null,
    title: text(goal.title ?? goal.statement ?? goal.text ?? '', 200),
    status: text(goal.status, 30) || null,
    progress,
    criteriaMet: met,
    criteriaCount: criteria.length,
  };
}

function openGoals(goalList) {
  return goalList
    .filter((goal) => goal && typeof goal === 'object')
    .filter((goal) => !['completed', 'abandoned', 'retired', 'cancelled'].includes(String(goal.status ?? '')))
    .map(goalItem)
    .filter(Boolean)
    .slice(0, 5);
}

// The deterministic action classifier. The owner may always name the action explicitly;
// otherwise the verb decides, and the classifier only ever returns registered capabilities.
export function classifyIntent(intent) {
  const trimmed = String(intent ?? '').trim();
  if (/^(remember|note|record|save|store)\b/i.test(trimmed)) {
    return { action: 'memory.add', input: { content: trimmed }, rule: 'imperative verb selects the memory write' };
  }
  if (/^(find|search|recall|look\s+up)\b/i.test(trimmed)) {
    return { action: 'memory.search', input: { query: trimmed.replace(/^(find|search|recall|look\s+up)\s+/i, ''), limit: 5 }, rule: 'search verb selects the memory read' };
  }
  return { action: 'memory.search', input: { query: trimmed, limit: 5 }, rule: 'default read-only retrieval' };
}

export function createCognitivePipeline({
  dataDir,
  registry,
  controlPlane,
  controller,
  taskStore,
  memory,
  knowledge,
  worldModel,
  goals,
  situation,
  resources,
  // T-32 Step 3: optional. When the perception service is present, a run reads the latest host and
  // workspace observations as facts about this machine instead of only the stores APEX keeps.
  perception = null,
  // T-34 Step 1: optional. A compiled mission refuses an artifact this service cannot read, so the
  // mission's own precondition is stated before any step is recorded.
  workshop = null,
  council,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('a cognitive pipeline needs a data directory');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('a cognitive pipeline needs the ActionRegistry');
  const ecp = controlPlane ?? registry.controlPlane;
  if (!ecp || typeof ecp.evaluate !== 'function') throw new TypeError('a cognitive pipeline needs the Executive Control Plane');
  if (!controller || typeof controller.runAction !== 'function') throw new TypeError('a cognitive pipeline needs the controller');
  if (!taskStore || typeof taskStore.createTask !== 'function') throw new TypeError('a cognitive pipeline needs the task store');

  const store = new JsonlStore(path.join(dataDir, 'cognition-runs.jsonl'), {
    validateRecord(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return 'a cognition run must be an object';
      if (record.schema !== RUN_SCHEMA) return 'unexpected cognition run schema';
      if (typeof record.runId !== 'string' || record.runId.length === 0) return 'a cognition run needs an id';
      if (typeof record.intent !== 'string' || record.intent.length === 0) return 'a cognition run needs an intent';
      if (!RUN_STATUSES.includes(record.status)) return `unknown cognition run status: ${record.status}`;
      if (!record.stages || typeof record.stages !== 'object') return 'a cognition run needs recorded stages';
      return null;
    },
    parseCacheBytes: 1 << 20,
  });

  const stamp = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };

  const at = () => stamp().toISOString();

  async function situationReading() {
    if (!situation || typeof situation.state !== 'function') return { state: null, error: 'the Sentinel is not configured' };
    const read = await attempt(() => situation.state({ limit: 5 }), null);
    if (read.error) return { state: null, error: read.error };
    return { state: read.value ?? null, error: null };
  }

  function advisoriesOf(state) {
    if (!state || typeof state !== 'object') return [];
    const alerts = listOf(state.alerts).slice(0, 5).map((alert) => ({
      id: text(alert?.id ?? alert?.alertId, 60) || null,
      severity: text(alert?.severity ?? alert?.level, 30) || null,
      summary: text(alert?.summary ?? alert?.title ?? alert?.detail ?? alert?.message ?? '', 200),
    }));
    const uncertainty = listOf(state.uncertainty).slice(0, 5).map((entry) => ({
      kind: text(entry?.kind ?? entry?.type, 60) || null,
      detail: text(entry?.detail ?? entry?.summary ?? entry?.message ?? '', 200),
    }));
    return [...alerts, ...uncertainty].slice(0, 8);
  }

  function resourcePressure() {
    if (!resources || typeof resources.telemetry !== 'function') {
      return { value: null, basis: 'the resource fabric is not configured', unavailable: true };
    }
    return attempt(() => resources.telemetry(), null).then((read) => {
      if (read.error || !read.value) {
        return { value: null, basis: `resource telemetry is unavailable: ${read.error ?? 'no reading'}`, unavailable: true };
      }
      const telemetry = read.value;
      const parts = [];
      const memoryTotal = Number(telemetry.memory?.totalBytes);
      const memoryFree = Number(telemetry.memory?.freeBytes);
      let highest = 0;
      if (Number.isFinite(memoryTotal) && Number.isFinite(memoryFree) && memoryTotal > 0) {
        const used = clamp01(1 - memoryFree / memoryTotal);
        highest = Math.max(highest, used);
        parts.push(`memory ${Math.round(used * 100)}% in use`);
      } else {
        parts.push('memory telemetry unavailable');
      }
      const storage = listOf(telemetry.storage);
      for (const volume of storage.slice(0, 3)) {
        const total = Number(volume?.totalBytes);
        const free = Number(volume?.freeBytes);
        if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
          const used = clamp01(1 - free / total);
          highest = Math.max(highest, used);
          parts.push(`storage ${Math.round(used * 100)}% in use`);
        }
      }
      if (storage.length === 0) parts.push('no storage volumes reported');
      if (telemetry.cpu && telemetry.cpu.available !== true) parts.push('cpu telemetry unavailable');
      if (telemetry.gpu && telemetry.gpu.available === false) parts.push('gpu telemetry unavailable');
      return {
        value: clamp01(highest),
        basis: parts.length ? parts.join(' · ') : 'no resource reading available',
        unavailable: false,
        at: telemetry.at ?? null,
      };
    });
  }

  async function hostReading() {
    if (!perception || typeof perception.state !== 'function') {
      return { value: null, error: 'the perception service is not configured' };
    }
    return attempt(() => perception.state({ limit: 8 }), null);
  }

  // T-34 Step 2: the episodes this intent might be related to. A prior run is an episode: it has an
  // intent, an outcome and an id a reader can open. Nothing else is read, and the current run cannot
  // be among them because it has not been written yet.
  async function priorEpisodes({ limit = 8, excludeRunId = null } = {}) {
    const loaded = await attempt(() => store.load(), { records: [], corrupt: [] });
    const records = listOf(loaded.value?.records).filter((record) => record && typeof record.runId === 'string'
      && record.runId !== excludeRunId);
    const recent = records.slice(-Math.max(0, limit)).reverse();
    return recent.map((record) => ({
      id: record.runId,
      text: typeof record.intent === 'string' ? record.intent : '',
      outcome: record.status ?? null,
      at: record.at ?? null,
    }));
  }

  async function candidateRecalls(intent, { excludeRunId = null } = {}) {
    const episodes = await priorEpisodes({ excludeRunId });
    const recalls = candidateAssociations({ intent, episodes });
    return associationEnvelope({ intent, recalls, episodesConsidered: episodes.length });
  }

  async function buildContext(intent) {
    const [memoryRead, knowledgeRead, worldRead, goalRead, sentinel, host] = await Promise.all([
      memory && typeof memory.search === 'function'
        ? attempt(() => memory.search(intent, { limit: 6 }), [])
        : Promise.resolve({ value: [], error: 'memory is not configured' }),
      knowledge && typeof knowledge.search === 'function'
        ? attempt(() => knowledge.search(intent, { limit: 6 }), [])
        : Promise.resolve({ value: [], error: 'knowledge is not configured' }),
      worldModel && typeof worldModel.state === 'function'
        ? attempt(() => worldModel.state(), null)
        : Promise.resolve({ value: null, error: 'the world model is not configured' }),
      goals && typeof goals.list === 'function'
        ? attempt(() => goals.list(), [])
        : Promise.resolve({ value: [], error: 'goals are not configured' }),
      situationReading(),
      hostReading(),
    ]);

    const memoryItems = listOf(memoryRead.value).map(memoryItem).filter(Boolean).slice(0, 6);
    const knowledgeItems = listOf(knowledgeRead.value).map(knowledgeItem).filter(Boolean).slice(0, 6);
    const world = worldRead.value && typeof worldRead.value === 'object' ? worldRead.value : null;
    const worldItems = listOf(world?.facts).map(worldItem).filter(Boolean).slice(0, 12);
    const goalItems = openGoals(listOf(goalRead.value));
    const epistemic = { observed: 0, inferred: 0, assumed: 0, predicted: 0 };
    for (const item of [...worldItems, ...knowledgeItems]) {
      epistemic[item.epistemic ?? 'inferred'] = (epistemic[item.epistemic ?? 'inferred'] ?? 0) + 1;
    }
    // T-34 Step 2: candidate associative recall, stated as its own thing. It is not memory, not
    // knowledge and not an observation, and it is counted in its own epistemic class.
    const associations = await candidateRecalls(intent);
    const problems = [];
    if (memoryRead.error) problems.push(`memory: ${memoryRead.error}`);
    if (knowledgeRead.error) problems.push(`knowledge: ${knowledgeRead.error}`);
    if (worldRead.error) problems.push(`world model: ${worldRead.error}`);
    if (goalRead.error) problems.push(`goals: ${goalRead.error}`);
    if (sentinel.error) problems.push(`sentinel: ${sentinel.error}`);
    if (host.error) problems.push(`perception: ${host.error}`);
    const hostObservations = listOf(host.value?.observations).slice(0, 8).map((entry) => ({
      id: text(entry?.id, 60) || null,
      subject: text(entry?.subject, 80) || null,
      value: entry?.value === null || entry?.value === undefined ? null : text(String(entry.value), 120),
      unit: text(entry?.unit, 20) || null,
      at: entry?.at ?? null,
      source: text(entry?.source, 40) || 'host-workspace-sensor',
      epistemic: entry?.epistemicStatus === 'unavailable' ? 'unavailable' : 'observed',
    }));
    // Live host facts are observations, so they are counted as such and never as inferences.
    const observedHost = hostObservations.filter((entry) => entry.epistemic === 'observed').length;
    epistemic.observed = (epistemic.observed ?? 0) + observedHost;
    // A recall is counted as a candidate association, in its own class, so no reader can add it to the
    // observed total by accident.
    epistemic.candidate_association = associations.count;

    return {
      packet: {
        schema: PACKET_SCHEMA,
        at: at(),
        intent,
        owner: { activeGoals: goalItems, goalCount: goalItems.length, principal: 'local-user-origin' },
        memory: { count: memoryItems.length, items: memoryItems },
        knowledge: { count: knowledgeItems.length, items: knowledgeItems },
        world: { count: worldItems.length, entityCount: world ? listOf(world.entities).length : 0, facts: worldItems },
        // T-34 Step 2: recalled prior episodes, each a candidate association with its own source id,
        // similarity and basis. Never `observed`, never a permission.
        associativeRecalls: { ...associations, at: at() },
        epistemic,
        sentinel: {
          reading: sentinel.state
            ? {
              counts: sentinel.state.counts ?? null,
              alerts: listOf(sentinel.state.alerts).length,
              uncertainty: listOf(sentinel.state.uncertainty).length,
            }
            : null,
          advisories: advisoriesOf(sentinel.state),
          error: sentinel.error,
        },
        host: {
          available: host.value !== null,
          error: host.error,
          lastObservationAt: host.value?.lastObservationAt ?? null,
          observedCount: host.value?.observedCount ?? null,
          unavailableCount: host.value?.unavailableCount ?? null,
          observations: hostObservations,
          pushBudget: host.value?.governor?.budget ?? null,
          suppressions: listOf(host.value?.governor?.suppressions).map((rule) => ({
            alertClass: text(rule?.alertClass, 40) || null,
            suppressedUntil: rule?.suppressedUntil ?? null,
          })),
          reading: host.value?.lastReading ?? null,
        },
        problems,
      },
      goalItems,
      advisories: advisoriesOf(sentinel.state),
    };
  }

  function salienceOf({ packet, definition }) {
    const items = [...packet.memory.items, ...packet.knowledge.items, ...packet.world.facts];
    const confidences = items
      .map((item) => (Number.isFinite(item.confidence) ? item.confidence : null))
      .filter((value) => value !== null);
    const confidence = confidences.length === 0
      ? 0.2
      : clamp01(confidences.reduce((sum, value) => sum + value, 0) / confidences.length);
    const uncertainty = clamp01(1 - confidence);
    const advisories = packet.sentinel.advisories;
    const urgency = clamp01(0.15 + 0.15 * advisories.length);
    const goalProgressValues = packet.owner.activeGoals
      .map((goal) => goal.progress)
      .filter((value) => Number.isFinite(value));
    const goalProgress = goalProgressValues.length === 0
      ? null
      : clamp01(goalProgressValues.reduce((sum, value) => sum + value, 0) / goalProgressValues.length);

    const permission = definition?.permission === 'write' ? 'write' : 'read';
    const risk = String(definition?.risk ?? 'unknown');
    let riskScore = permission === 'write' ? 0.55 : 0.15;
    const riskBasis = [`${permission} action`];
    if (risk === 'high') { riskScore += 0.25; riskBasis.push('the registry declares high risk'); }
    if (risk === 'critical') { riskScore += 0.35; riskBasis.push('the registry declares critical risk'); }
    if (definition?.reversibility === 'irreversible') { riskScore += 0.2; riskBasis.push('the registry declares the effect irreversible'); }
    if (/security|safety|credential|secret/i.test(String(definition?.domain ?? definition?.name ?? ''))) {
      riskScore += 0.15;
      riskBasis.push('the capability is security or safety relevant');
    }
    const riskSensitivity = clamp01(riskScore);

    const novelty = clamp01(1 - Math.min(packet.memory.count, 5) / 5);

    return {
      urgency,
      confidence,
      uncertainty,
      goal_progress: goalProgress,
      resource_pressure: null, // filled by the caller from the resource fabric
      risk_sensitivity: riskSensitivity,
      novelty,
      basis: {
        urgency: `${advisories.length} Sentinel advisor${advisories.length === 1 ? 'y' : 'ies'} at 0.15 + 0.15 × count`,
        confidence: confidences.length === 0
          ? 'no cited item carries a confidence; the floor of 0.2 is used'
          : `mean of ${confidences.length} declared item confidences`,
        uncertainty: '1 − confidence',
        goal_progress: goalProgressValues.length === 0
          ? 'no active goal reports criteria, so progress is unavailable rather than invented'
          : `mean criteria completion across ${goalProgressValues.length} active goal(s)`,
        risk_sensitivity: riskBasis.join(' · '),
        novelty: `${packet.memory.count} of 5 memory retrieval slots matched`,
        epistemic: packet.epistemic,
      },
    };
  }

  function councilEvidence(packet) {
    const supplies = [
      ...packet.memory.items.slice(0, 3).map((item) => ({
        evidenceId: item.id ?? `memory:${item.content.slice(0, 24)}`,
        source: 'memory',
        claim: item.content,
        trust: 'direct',
        relation: 'contextual',
        current: true,
      })),
      ...packet.knowledge.items.slice(0, 3).map((item) => ({
        evidenceId: item.id ?? `knowledge:${item.claim.slice(0, 24)}`,
        source: 'knowledge',
        claim: item.claim,
        trust: 'derived',
        relation: 'supports',
        current: true,
      })),
      ...packet.world.facts.slice(0, 2).map((fact) => ({
        evidenceId: fact.id ?? `world:${fact.subject}:${fact.predicate}`,
        source: 'world_model',
        claim: `${fact.subject ?? 'subject'} ${fact.predicate ?? 'is'} ${fact.value ?? 'unknown'}`,
        trust: fact.epistemic === 'observed' ? 'direct' : 'derived',
        relation: 'contextual',
        current: true,
      })),
    ];
    return supplies.slice(0, 8);
  }

  function pickPosition(positions, id) {
    const found = Array.isArray(positions) ? positions.find((position) => position?.perspectiveId === id) : null;
    if (!found) return null;
    return {
      perspective: found.perspectiveName ?? id,
      verdict: text(found.position?.verdict ?? 'unknown', 60),
      summary: text(found.position?.summary ?? '', 300),
      evidence: listOf(found.position?.evidence).slice(0, 4).map((entry) => ({
        kind: text(entry?.kind, 40) || null,
        detail: text(entry?.detail ?? '', 160),
      })),
      uncertainty: found.position?.uncertainty ?? null,
    };
  }

  async function deliberate({ intent, packet, definition, action, warranted, reason }) {
    if (!council || typeof council.deliberate !== 'function') {
      return { status: 'unavailable', reason: 'the Council is not configured', perspectives: null, recommendation: null };
    }
    if (!warranted) {
      return {
        status: 'skipped',
        reason,
        perspectives: null,
        recommendation: null,
      };
    }
    try {
      const outcome = await council.deliberate({
        objective: intent,
        evidence: councilEvidence(packet),
        candidate: {
          id: action,
          action,
          description: definition?.description ?? `run ${action}`,
        },
      });
      const positions = outcome?.positions ?? [];
      const option = outcome?.synthesis?.synthesis?.recommendedOption ?? null;
      return {
        status: 'ran',
        reason: null,
        sessionId: outcome?.session?.sessionId ?? null,
        persisted: outcome?.persisted === true,
        disagreement: outcome?.disagreement?.kind ?? null,
        perspectives: {
          thesis: pickPosition(positions, 'objective_alignment'),
          counter_risk: pickPosition(positions, 'safety_policy'),
          evidence_check: pickPosition(positions, 'evidence_quality'),
        },
        recommendation: option
          ? {
            level: text(option.level, 40),
            support: text(option.support, 40),
            confidence: text(option.confidence, 40),
            confidenceBasis: text(option.confidenceBasis, 240),
            summary: text(option.summary, 320),
            requiresAuthorization: option.requiresAuthorization === true,
          }
          : null,
        // Stated on every record so no reader can mistake deliberation for permission.
        authorizesExecution: false,
      };
    } catch (err) {
      return {
        status: 'unavailable',
        reason: text(String(err?.message ?? err), 240),
        perspectives: null,
        recommendation: null,
      };
    }
  }

  // The gate reasons are derived from the capability's own registry definition and the configured
  // autonomy level. Any one of them stops the run before a step executes.
  function gateReasons(definition, level) {
    const reasons = [];
    if (definition?.permission === 'write') reasons.push('the capability writes');
    if (Number.isFinite(level) && level >= 2) reasons.push(`the configured autonomy level is L${level}, at or above the L2 execution gate`);
    const risk = String(definition?.risk ?? '');
    if (risk === 'high' || risk === 'critical') reasons.push(`the registry declares ${risk} risk`);
    if (definition?.reversibility === 'irreversible' || definition?.irreversible === true) reasons.push('the registry declares the effect irreversible');
    if (/security|safety|credential|secret/i.test(`${definition?.domain ?? ''} ${definition?.name ?? ''}`)) {
      reasons.push('the capability is security or safety relevant');
    }
    return reasons;
  }

  // A task step records its result as `outcome`; SUCCESS_VERIFIED is the only value that means
  // the verifier confirmed the effect. Nothing here promotes a hopeful status into a verification.
  function stepVerified(step) {
    if (!step) return false;
    if (step.verification && typeof step.verification === 'object') return step.verification.outcome === 'verified' || step.verification.ok === true;
    return step.outcome === 'success_verified';
  }

  function deriveRunStatus(run, task) {
    if (run.status === 'halted' || run.status === 'failed') return run.status;
    if (!task) return run.status;
    if (listOf(task.steps).some((step) => step?.status === 'awaiting_approval')) return 'awaiting_approval';
    if (task.status === 'completed') {
      return listOf(task.steps).length > 0 && listOf(task.steps).every(stepVerified) ? 'completed' : 'failed';
    }
    if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
    if (task.status === 'running' || task.status === 'paused' || task.status === 'pending') return 'running';
    return run.status;
  }

  function verificationOf(task) {
    if (!task) return { outcome: 'not_run', verified: false, detail: 'no task was created' };
    const steps = listOf(task.steps);
    if (steps.length === 0) return { outcome: 'not_run', verified: false, detail: 'the task has no steps' };
    const verified = steps.every(stepVerified);
    const detail = steps
      .map((step) => `${step.id ?? 'step'}: ${step.outcome ?? 'not_run'}${step.summary ? ` — ${step.summary}` : ''}`)
      .join(' · ');
    return {
      outcome: verified ? 'verified' : (steps.some((step) => step.outcome === 'execution_failed' || step.outcome === 'verification_failed') ? 'failed' : 'not_verified'),
      verified,
      detail,
    };
  }

  async function taskOf(run) {
    if (!run.taskId || typeof taskStore.get !== 'function') return null;
    const read = await attempt(() => taskStore.get(run.taskId), null);
    return read.value ?? null;
  }

  // Reads the run back against the task store so a record can never claim more than the task
  // actually holds: approval state and verification are re-derived on every read.
  async function project(run) {
    if (!run) return null;
    const task = await taskOf(run);
    const status = deriveRunStatus(run, task);
    const verification = verificationOf(task);
    const gated = listOf(task?.steps).filter((step) => step?.status === 'awaiting_approval');
    const recordedApproval = listOf(task?.steps).map((step) => step?.approval).filter(Boolean).slice(-1)[0] ?? null;
    const approval = task
      ? {
        required: gated.length > 0 || recordedApproval !== null || run.status === 'awaiting_approval',
        status: gated.length > 0
          ? 'awaiting_owner_decision'
          : (recordedApproval ? 'decided' : (run.status === 'awaiting_approval' ? 'awaiting_owner_decision' : 'not_required')),
        recorded: recordedApproval,
        waitingSteps: gated.map((step) => step.id),
      }
      : { required: false, status: 'not_required', recorded: null, waitingSteps: [] };
    return {
      ...run,
      status,
      verification,
      approval,
      task: task
        ? {
          id: task.id,
          status: task.status,
          origin: task.origin,
          planner: task.planner,
          steps: listOf(task.steps).map((step) => ({
            id: step.id ?? null,
            description: text(step.description ?? '', 200),
            action: step.action ?? null,
            permission: step.permission ?? null,
            status: step.status ?? null,
            // T-34 Step 1: the shape and the block, both derived from the records on every read. A
            // reader of the run can say which node waits on which without reading the task log too.
            dependsOn: [...(step.dependsOn ?? [])],
            blockedBy: unmetDependencies(task, step.id),
            outcome: step.outcome ?? null,
            execution: step.execution ?? null,
            verification: step.verification ?? null,
            approval: step.approval ?? null,
          })),
        }
        : null,
      // The nodes the records leave unrun or waiting, with what they wait on. Derived, never stored.
      blocked: task ? blockedNodesOf(task) : [],
      stages: {
        ...run.stages,
        execution: {
          ...run.stages.execution,
          currentStatus: status,
          verification,
          approval,
        },
      },
    };
  }

  // T-34 Step 1 (2026-11-19): a mission is compiled from a fixed template, authorized node by node,
  // and recorded as one task. Nothing about it is inferred: the template names the capability, the
  // input and the dependencies of every node, and the compiler refuses anything it cannot state.
  //
  // The write nodes are gated at compile time, exactly as the single-action path gates its own write:
  // the task is taken up to the gate and stopped with those steps awaiting the owner's approval, so
  // the priority of a mission never authorizes a write. The owner approves a node, resumes, and the
  // run continues to the next gate - the join included.
  async function runMission({ mission, artifactId, intent, runId, startedAt, requestedBy, origin, councilRequested }) {
    let compiled;
    try {
      compiled = compileMission({ mission, artifactId });
    } catch (err) {
      if (err instanceof MissionError) throw new ValidationError(`${err.code}: ${err.message}`);
      throw err;
    }

    // Every node must name a registered capability whose own validator accepts the template's input.
    // A mission is not allowed to bypass a capability's validation by carrying it in a template.
    const nodes = [];
    for (const node of compiled.nodes) {
      const definition = registry.get(node.action);
      if (!definition) {
        throw new ValidationError(`MISSION_ACTION_UNKNOWN: node ${node.id} names ${node.action}, which is not registered`);
      }
      const input = typeof definition.validate === 'function' ? definition.validate(node.input) : node.input;
      nodes.push({ ...node, input, permission: definition.permission ?? 'read', definition });
    }

    // The mission's own precondition, stated before any step is recorded: an artifact that cannot be
    // read is not an artifact this mission can verify.
    const artifactNode = nodes.find((node) => Object.hasOwn(node.input ?? {}, 'artifactId'));
    if (artifactNode && workshop && typeof workshop.get === 'function') {
      const found = (await attempt(() => workshop.get(artifactNode.input.artifactId), null)).value;
      if (!found || found.found !== true) {
        throw new ValidationError(`MISSION_ARTIFACT_UNKNOWN: no workshop artifact ${artifactNode.input.artifactId}`);
      }
    }

    // The node whose permission and risk speak for the mission: the write with the most dependencies
    // (the join), else the first write, else the root. It is used for salience and the Council only.
    const governing = nodes.filter((node) => node.permission === 'write')
      .sort((a, b) => b.dependsOn.length - a.dependsOn.length)[0] ?? nodes[0];
    const { packet } = await buildContext(intent);
    const pressure = await resourcePressure();
    const salience = { ...salienceOf({ packet, definition: governing.definition }), resource_pressure: pressure.value };
    if (pressure.unavailable) salience.resource_basis = pressure.basis;
    salience.basis.resource_pressure = pressure.basis;
    const councilStage = await deliberate({
      intent,
      packet,
      definition: governing.definition,
      action: governing.action,
      warranted: councilRequested === true || salience.uncertainty >= 0.4 || salience.risk_sensitivity >= 0.5 || nodes.some((node) => node.permission === 'write'),
      reason: 'not warranted: the mission holds no write step',
    });

    const missionGraph = {
      mission: compiled.name,
      title: compiled.title,
      describe: compiled.describe,
      nodes: nodes.map((node) => ({
        id: node.id,
        action: node.action,
        role: node.role,
        // The template's own gate declaration, with the basis written next to it, so the graph can
        // say why a node waits for the owner instead of only that it does.
        gate: node.gate,
        gateBasis: node.gateBasis,
        permission: node.permission,
        risk: node.definition.risk ?? null,
        description: text(node.description, 240),
        input: redactInput(node.input),
        dependsOn: [...node.dependsOn],
      })),
      edges: compiled.edges.map((edge) => ({ ...edge })),
      shape: compiled.shape,
      rule: `the ${compiled.name} template, compiled deterministically; no step was inferred`,
      summary: compiled.summary,
    };

    const killSwitch = typeof ecp.killSwitchStatus === 'function' ? ecp.killSwitchStatus() : { active: false, policyUnavailable: true };
    const authorization = {
      decision: 'not_requested',
      reason: null,
      autonomyLevel: null,
      autonomySource: null,
      approvalRequired: false,
      approvalRef: null,
      auditRef: null,
      verified: false,
      latch: { active: killSwitch.active === true, policyUnavailable: killSwitch.policyUnavailable === true },
      nodes: [],
    };

    const base = {
      schema: RUN_SCHEMA,
      runId,
      at: startedAt,
      intent,
      requestedBy: text(requestedBy, 60) || 'owner',
      origin,
      mission: { name: compiled.name, title: compiled.title, shape: compiled.shape },
      action: {
        name: governing.action,
        permission: governing.permission,
        risk: governing.definition.risk ?? null,
        description: text(governing.definition.description ?? '', 240),
      },
      stages: {
        context: packet,
        salience,
        council: councilStage,
        task_graph: missionGraph,
        execution: authorization,
      },
      status: 'running',
      halted: null,
      taskId: null,
    };

    // Fail closed before anything exists - the latch first, then the ECP for every node.
    if (authorization.latch.active || authorization.latch.policyUnavailable) {
      const reason = authorization.latch.policyUnavailable ? 'POLICY_UNAVAILABLE' : 'KILL_SWITCH_ACTIVE';
      authorization.decision = 'deny';
      authorization.reason = reason;
      const halted = {
        ...base,
        status: 'halted',
        halted: {
          reason,
          detail: authorization.latch.policyUnavailable
            ? 'the ECP kill-switch policy state is unreadable and has failed closed; the mission halts before any node exists'
            : 'the ECP kill-switch latch is active; the mission halts before any node exists',
          audit: 'this run record is the durable account; no task was created and no step executed',
        },
        stages: { ...base.stages, execution: { ...authorization, halt: true } },
      };
      await store.append(halted);
      return project(halted);
    }

    for (const node of nodes) {
      const decision = ecp.evaluate(node.action, origin, { phase: 'plan', operationId: runId });
      authorization.nodes.push({ id: node.id, action: node.action, decision: decision.decision, reason: decision.reason });
      if (decision.decision !== 'allow') {
        authorization.decision = decision.decision;
        authorization.reason = decision.reason;
        authorization.auditRef = runId;
        const halted = {
          ...base,
          status: 'halted',
          halted: {
            reason: decision.reason,
            detail: `the ECP refused node ${node.id} (${node.action}) before the mission was created`,
            audit: 'nothing was executed; this record holds the refusal',
          },
          stages: { ...base.stages, execution: { ...authorization, halt: true } },
        };
        await store.append(halted);
        return project(halted);
      }
    }
    authorization.decision = 'allow';
    authorization.reason = 'PERMITTED';
    authorization.auditRef = runId;

    const taskId = `task-${runId.slice(4)}`;
    try {
      await taskStore.createTask({
        taskId,
        goal: intent,
        origin,
        planner: 'deterministic',
        reason: `cognition run ${runId}: the ${compiled.name} mission`,
        steps: nodes.map((node) => ({
          id: node.id,
          description: `${node.id} ${node.role}: ${node.action} — ${node.description}`,
          action: node.action,
          permission: node.permission,
          input: node.input,
          dependsOn: [...node.dependsOn],
        })),
      });
    } catch (err) {
      const failed = {
        ...base,
        status: 'failed',
        halted: { reason: 'TASK_CREATION_FAILED', detail: text(String(err?.message ?? err), 240), audit: null },
        stages: { ...base.stages, execution: { ...authorization, error: text(String(err?.message ?? err), 240) } },
      };
      await store.append(failed);
      return project(failed);
    }

    // The gates. Every node the template declares `gate: 'approval'` is recorded awaiting the
    // owner's approval, before any node runs: a mission is not a permission, and a template that
    // writes twice is gated twice. The task is then taken up to those gates - the steps that need no
    // decision run, and the run stops where the owner's answer is required.
    const gated = nodes.filter((node) => node.gate === 'approval');
    let task = null;
    try {
      if (gated.length > 0) {
        await taskStore.transition(taskId, {
          reason: `cognition run ${runId}: the mission is taken up to its authorization gates (${gated.map((node) => node.id).join(', ')})`,
          task: { from: 'pending', to: 'running' },
          steps: [],
        });
        await taskStore.transition(taskId, {
          reason: `cognition run ${runId}: owner approval required before ${gated.map((node) => `${node.id} (${node.action}): ${node.gateBasis}`).join('; ')}`,
          task: { from: 'running', to: 'paused' },
          steps: gated.map((node) => ({ id: node.id, from: 'pending', to: 'awaiting_approval' })),
        });
        task = await taskOf({ taskId });
      } else {
        const outcome = await controller.runTask(taskId, 'run');
        task = outcome?.task ?? (await taskOf({ taskId }));
      }
      // The mission starts working immediately and stops only where it must. `resume` takes up the
      // steps that need no decision - the read root and the sibling branch - and leaves a gated step
      // and everything behind it where they are, so a paused mission is a real partial run and not an
      // empty plan.
      if (gated.length > 0 && task && task.status === 'paused') {
        const run = await controller.runTask(taskId, 'resume');
        task = run?.task ?? (await taskOf({ taskId }));
      }
    } catch (err) {
      const failed = {
        ...base,
        status: 'failed',
        taskId,
        halted: { reason: 'APPROVAL_GATE_FAILED', detail: text(String(err?.message ?? err), 240), audit: runId },
        stages: { ...base.stages, execution: { ...authorization, error: text(String(err?.message ?? err), 240), gates: gated.map((node) => node.id) } },
      };
      await store.append(failed);
      return project(failed);
    }

    const status = deriveRunStatus(base, task);
    const verification = verificationOf(task);
    const recorded = {
      ...base,
      status,
      taskId,
      stages: {
        ...base.stages,
        execution: {
          ...authorization,
          gates: gated.map((node) => node.id),
          approvalRequired: gated.length > 0,
          verified: verification.verified,
          verification,
          taskStatus: task?.status ?? null,
        },
      },
    };
    await store.append(recorded);
    return project(recorded);
  }

  async function run({ intent, action = null, input = null, councilRequested = false, requestedBy = 'owner', origin = 'user', mission = null, artifactId = null } = {}) {
    if (typeof intent !== 'string' || intent.trim().length === 0 || intent.length > 500) {
      throw new ValidationError('a cognition run needs an intent of 1-500 characters');
    }
    const cleanIntent = intent.trim();
    const runId = `cog-${idFactory().replace(/-/g, '').slice(0, 20)}`;
    const startedAt = at();

    // T-34 Step 1: a named mission is compiled from its template instead of selected from the intent.
    // It is a separate path on purpose - the single-action path below is unchanged - and it shares the
    // context packet, the salience, the Council and the ECP pre-check with it.
    if (mission !== null && mission !== undefined) {
      return runMission({ mission, artifactId, intent: cleanIntent, runId, startedAt, requestedBy, origin, councilRequested });
    }

    const selected = action
      ? { action, input: input && typeof input === 'object' ? input : {}, rule: 'the owner named the action explicitly' }
      : classifyIntent(cleanIntent);
    if (typeof selected.action !== 'string' || selected.action.length === 0) {
      throw new ValidationError('the pipeline could not select a registered action for this intent');
    }
    // An explicitly named action still needs a deterministic payload: the intent is the owner's
    // own words, so it is the query or the content, never a guess.
    if (!selected.input || Object.keys(selected.input).length === 0) {
      if (selected.action === 'memory.add') selected.input = { content: cleanIntent };
      else if (selected.action === 'memory.search') selected.input = { query: cleanIntent, limit: 5 };
    }
    const definition = registry.get(selected.action);
    if (!definition) throw new ValidationError(`the pipeline can only plan registered actions; ${selected.action} is not registered`);

    const { packet } = await buildContext(cleanIntent);
    const pressure = await resourcePressure();
    const salience = { ...salienceOf({ packet, definition }), resource_pressure: pressure.value };
    if (pressure.unavailable) salience.resource_basis = pressure.basis;
    salience.basis.resource_pressure = pressure.basis;

    const warranted = councilRequested === true
      || salience.uncertainty >= 0.4
      || salience.risk_sensitivity >= 0.5
      || definition.permission === 'write';
    const councilStage = await deliberate({
      intent: cleanIntent,
      packet,
      definition,
      action: selected.action,
      warranted,
      reason: `not warranted: uncertainty ${salience.uncertainty} < 0.4 and risk ${salience.risk_sensitivity} < 0.5 for a ${definition.permission} action`,
    });

    const nodes = [{
      id: 's1',
      action: selected.action,
      permission: definition.permission ?? null,
      risk: definition.risk ?? null,
      description: text(definition.description ?? '', 240),
      input: redactInput(selected.input),
      dependsOn: [],
    }];
    const taskGraph = {
      nodes,
      edges: [],
      rule: selected.rule,
      summary: `${nodes.length} step · ${definition.permission ?? 'unknown'} · ${definition.risk ?? 'unknown'} risk`,
    };

    const killSwitch = typeof ecp.killSwitchStatus === 'function' ? ecp.killSwitchStatus() : { active: false, policyUnavailable: true };
    const permission = typeof ecp.permissionFor === 'function' ? ecp.permissionFor(selected.action, { origin }) : null;
    const authorization = {
      decision: 'not_requested',
      reason: null,
      autonomyLevel: permission?.autonomyLevel ?? null,
      autonomySource: permission?.autonomy?.policySource ?? null,
      approvalRequired: false,
      approvalRef: null,
      auditRef: null,
      verified: false,
      latch: { active: killSwitch.active === true, policyUnavailable: killSwitch.policyUnavailable === true },
    };

    const base = {
      schema: RUN_SCHEMA,
      runId,
      at: startedAt,
      intent: cleanIntent,
      requestedBy: text(requestedBy, 60) || 'owner',
      origin,
      action: {
        name: selected.action,
        permission: definition.permission ?? null,
        risk: definition.risk ?? null,
        description: text(definition.description ?? '', 240),
      },
      stages: {
        context: packet,
        salience,
        council: councilStage,
        task_graph: taskGraph,
        execution: authorization,
      },
      status: 'running',
      halted: null,
      taskId: null,
    };

    // Fail closed before anything is created or executed.
    if (authorization.latch.active || authorization.latch.policyUnavailable) {
      // An unreadable policy is reported as unreadable, not as an active latch: the two are
      // different facts and the owner needs the right one.
      const reason = authorization.latch.policyUnavailable ? 'POLICY_UNAVAILABLE' : 'KILL_SWITCH_ACTIVE';
      authorization.decision = 'deny';
      authorization.reason = reason;
      const halted = {
        ...base,
        status: 'halted',
        halted: {
          reason,
          detail: authorization.latch.policyUnavailable
            ? 'the ECP kill-switch policy state is unreadable and has failed closed; the pipeline halts before execution'
            : 'the ECP kill-switch latch is active; the pipeline halts before execution',
          audit: 'this run record is the durable account; when the run is requested through the controller the operation record holds the same refusal',
        },
        stages: { ...base.stages, execution: { ...authorization, halt: true } },
      };
      await store.append(halted);
      return project(halted);
    }

    const pre = ecp.evaluate(selected.action, origin, { phase: 'plan', operationId: runId });
    authorization.decision = pre.decision;
    authorization.reason = pre.reason;
    authorization.auditRef = runId;
    if (pre.decision !== 'allow') {
      const halted = {
        ...base,
        status: 'halted',
        halted: {
          reason: pre.reason,
          detail: 'the ECP refused the concrete action before execution',
          audit: 'the requesting operation holds the ECP decision; nothing was executed',
        },
        stages: { ...base.stages, execution: { ...authorization, halt: true } },
      };
      await store.append(halted);
      return project(halted);
    }

    const taskId = `task-${runId.slice(4)}`;
    try {
      await taskStore.createTask({
        taskId,
        goal: cleanIntent,
        origin,
        planner: 'deterministic',
        reason: `cognition run ${runId}`,
        steps: [{
          id: 's1',
          description: `run ${selected.action} for: ${cleanIntent}`,
          action: selected.action,
          permission: definition.permission ?? 'read',
          input: selected.input,
          dependsOn: [],
        }],
      });
    } catch (err) {
      const failed = {
        ...base,
        status: 'failed',
        halted: { reason: 'TASK_CREATION_FAILED', detail: text(String(err?.message ?? err), 240), audit: null },
        stages: {
          ...base.stages,
          execution: { ...authorization, error: text(String(err?.message ?? err), 240) },
        },
      };
      await store.append(failed);
      return project(failed);
    }

    const gate = gateReasons(definition, permission?.autonomyLevel ?? null);
    let task = null;
    if (gate.length > 0) {
      // The step is recorded, but it is not executed. The task is taken up to its authorization
      // gate and stopped there with the step in awaiting_approval, so the owner's decision is a
      // real recorded approval and the pipeline never supplies it on the owner's behalf.
      const gateReason = gate.join('; ');
      try {
        await taskStore.transition(taskId, {
          reason: `cognition run ${runId}: taken up to the authorization gate (${gateReason})`,
          task: { from: 'pending', to: 'running' },
          steps: [],
        });
        await taskStore.transition(taskId, {
          reason: `cognition run ${runId}: owner approval required before execution (${gateReason})`,
          task: { from: 'running', to: 'paused' },
          steps: [{ id: 's1', from: 'pending', to: 'awaiting_approval' }],
        });
        task = await taskOf({ taskId });
      } catch (err) {
        const failed = {
          ...base,
          status: 'failed',
          taskId,
          halted: { reason: 'APPROVAL_GATE_FAILED', detail: text(String(err?.message ?? err), 240), audit: runId },
          stages: { ...base.stages, execution: { ...authorization, error: text(String(err?.message ?? err), 240), gate } },
        };
        await store.append(failed);
        return project(failed);
      }
    } else {
      try {
        const outcome = await controller.runTask(taskId, 'run');
        task = outcome?.task ?? (await taskOf({ taskId }));
      } catch (err) {
        task = await taskOf({ taskId });
        if (!task) {
          const failed = {
            ...base,
            status: 'failed',
            taskId,
            halted: { reason: 'EXECUTION_FAILED', detail: text(String(err?.message ?? err), 240), audit: runId },
            stages: { ...base.stages, execution: { ...authorization, error: text(String(err?.message ?? err), 240) } },
          };
          await store.append(failed);
          return project(failed);
        }
      }
    }

    const status = deriveRunStatus(base, task);
    const verification = verificationOf(task);
    const step = listOf(task?.steps)[0] ?? null;
    const recorded = {
      ...base,
      status,
      taskId,
      stages: {
        ...base.stages,
        execution: {
          ...authorization,
          approvalRequired: step?.approval?.required === true || status === 'awaiting_approval',
          approvalRef: step?.approval?.id ?? task?.approval?.id ?? null,
          verified: verification.verified,
          verification,
          taskStatus: task?.status ?? null,
          outcome: step?.outcome ?? null,
          summary: step?.summary ?? null,
        },
      },
    };
    await store.append(recorded);
    return project(recorded);
  }

  function redactInput(input) {
    if (!input || typeof input !== 'object') return input ?? null;
    const copy = {};
    for (const [key, value] of Object.entries(input)) {
      if (/secret|token|password|key/i.test(key)) { copy[key] = '[redacted]'; continue; }
      copy[key] = typeof value === 'string' ? text(value, 400) : value;
    }
    return copy;
  }

  async function list({ limit = 10 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
    const { records, corrupt } = await store.load();
    const runs = [];
    for (const record of records.slice(-bounded).reverse()) {
      runs.push(await project(record));
    }
    return { runs, corrupt: corrupt.length, total: records.length };
  }

  async function get(runId) {
    if (typeof runId !== 'string' || runId.length === 0) return null;
    const { records } = await store.load();
    const found = records.find((record) => record.runId === runId) ?? null;
    return found ? project(found) : null;
  }

  return { schema: PIPELINE_SCHEMA, run, list, get, project, stages: COGNITION_STAGES };
}
