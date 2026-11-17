// Dependency, causal and consequence reasoning over recorded plan/world structures. A dependency is
// read from an explicit dependsOn edge. A causal edge exists only when a world relationship carries an
// explicit causal predicate; order alone never creates one.
import { BOUNDS } from './vocabulary.js';

const SATISFIED = new Set(['completed', 'skipped', 'success', 'success_verified']);
const TERMINAL_FAILED = new Set(['failed', 'blocked', 'cancelled', 'rejected']);
const CAUSAL_PREDICATES = new Set(['causes', 'leads_to', 'blocks', 'prevents', 'requires', 'precondition_for', 'enables']);

function stepStatus(plan, step) {
  const recorded = plan?.stepResults?.[step.id]?.status;
  if (typeof recorded === 'string') return recorded;
  if (plan?.status === 'completed') return 'completed';
  return 'pending';
}

export function buildDependencyGraph(plans = [], { maxNodes = BOUNDS.maxSteps } = {}) {
  const nodes = new Map();
  const edges = [];
  let truncated = false;
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || !Array.isArray(plan.steps)) continue;
    for (const step of plan.steps) {
      if (nodes.size >= maxNodes) { truncated = true; break; }
      const id = `step:${plan.id}:${step.id}`;
      nodes.set(id, {
        id,
        planId: plan.id,
        stepId: step.id,
        description: String(step.description ?? step.action ?? '').slice(0, 180),
        action: step.action ?? null,
        status: stepStatus(plan, step),
        risk: step.risk ?? plan.risk ?? 'unknown',
        reversibility: step.reversibility ?? null,
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice(0, 24) : [],
        verification: step.verification ?? null,
      });
    }
    if (nodes.size >= maxNodes) { truncated = true; break; }
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      edges.push({ from: node.id, to: `step:${node.planId}:${dependency}`, dependency });
    }
  }

  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }

  const missing = [];
  const blocked = [];
  const ready = [];
  const satisfied = [];
  for (const node of nodes.values()) {
    const dependencies = (outgoing.get(node.id) ?? [])
      .map((edge) => ({ edge, node: nodes.get(edge.to) ?? null }));
    const unsatisfied = dependencies.filter(({ node: dependency }) => !dependency || !SATISFIED.has(dependency.status));
    if (dependencies.length > 0 && dependencies.some(({ node: dependency }) => !dependency)) {
      missing.push({
        nodeId: node.id,
        planId: node.planId,
        stepId: node.stepId,
        dependencyIds: dependencies.filter(({ node: dependency }) => !dependency).map(({ edge }) => edge.to),
        reason: 'a recorded dependency has no matching step in the bounded plan set',
      });
    }
    if (SATISFIED.has(node.status)) satisfied.push(node.id);
    else if (TERMINAL_FAILED.has(node.status)) {
      blocked.push({ nodeId: node.id, planId: node.planId, stepId: node.stepId, status: node.status, blockers: dependencies.map(({ edge }) => edge.to) });
    } else if (unsatisfied.length > 0) {
      blocked.push({
        nodeId: node.id,
        planId: node.planId,
        stepId: node.stepId,
        status: node.status,
        blockers: unsatisfied.map(({ edge }) => edge.to),
        reason: 'not every recorded prerequisite is completed',
      });
    } else {
      ready.push(node.id);
    }
  }

  // Bounded depth-first cycle detection with an explicit stack. Cycles are reported, never
  // traversed again: this is what keeps a malformed plan from turning reasoning into a loop.
  const color = new Map();
  const cycles = [];
  const stack = [];
  const visit = (id, depth) => {
    if (depth > BOUNDS.maxDepth || cycles.length >= 12) return;
    if (color.get(id) === 1) {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    if (color.get(id) === 2) return;
    color.set(id, 1);
    stack.push(id);
    for (const edge of outgoing.get(id) ?? []) visit(edge.to, depth + 1);
    stack.pop();
    color.set(id, 2);
  };
  for (const id of [...nodes.keys()].sort()) visit(id, 0);

  const impact = new Map();
  for (const edge of edges) {
    if (!impact.has(edge.to)) impact.set(edge.to, new Set());
    impact.get(edge.to).add(edge.from);
  }
  for (const item of blocked) {
    const affected = [];
    const queue = [...(impact.get(item.nodeId) ?? [])];
    const seen = new Set();
    while (queue.length > 0 && affected.length < 12) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      affected.push(id);
      for (const next of impact.get(id) ?? []) queue.push(next);
    }
    item.downstream = affected.sort();
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: edges.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : a.from + a.to > b.from + b.to ? 1 : 0)),
    ready: ready.sort(),
    satisfied: satisfied.sort(),
    blocked: blocked.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
    missing,
    cycles,
    truncated,
    totalNodes: nodes.size,
    maxNodes,
  };
}

function active(worldState, targetType, id) {
  const retracted = (worldState.retractions ?? []).some((item) => item.targetType === targetType && item.targetId === id);
  const superseded = (worldState.supersessions ?? []).some((item) => item.targetType === targetType && item.targetId === id);
  return !retracted && !superseded;
}

export function extractCausalLinks(worldState, { max = 20 } = {}) {
  if (!worldState?.relationships || typeof worldState.relationships.values !== 'function') return [];
  const entityName = (id) => worldState.entities?.get?.(id)?.name ?? id;
  const links = [];
  for (const relationship of worldState.relationships.values()) {
    const predicate = String(relationship.predicate ?? '').toLowerCase();
    if (!CAUSAL_PREDICATES.has(predicate)) continue;
    if (!active(worldState, 'relationship', relationship.id)) continue;
    links.push({
      id: relationship.id,
      from: relationship.subjectId,
      fromName: entityName(relationship.subjectId),
      to: relationship.objectId,
      toName: entityName(relationship.objectId),
      predicate,
      explicit: true,
      evidence: Array.isArray(relationship.evidence) ? relationship.evidence.slice(0, 8) : [],
      source: 'world_relationship',
      note: 'explicitly recorded relationship; correlation or temporal order alone would not create a causal link',
    });
    if (links.length >= max) break;
  }
  return links.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function dependencyAssessment({ plans = [], tasks = [], worldState = null } = {}) {
  const graph = buildDependencyGraph(plans);
  const causal = extractCausalLinks(worldState);
  const planById = new Map((plans ?? []).map((plan) => [plan.id, plan]));
  const linkedTasks = (tasks ?? [])
    .filter((task) => task?.planId && planById.has(task.planId))
    .slice(0, 20)
    .map((task) => ({ taskId: task.id, planId: task.planId, status: task.status, goal: String(task.goal ?? '').slice(0, 160) }));
  const preconditionGaps = graph.blocked.filter((item) => item.blockers?.length > 0);
  return {
    ...graph,
    causal,
    linkedTasks,
    // A consequence is the recorded downstream edge of a blocked or ready step; it is not a
    // prediction that the consequence will happen.
    consequence: graph.blocked.slice(0, 8).map((item) => ({
      blockedNode: item.nodeId,
      downstream: item.downstream,
      note: 'dependency propagation only; no outcome is asserted',
    })),
    preconditionGaps,
    correlationGuard: 'causal links come only from explicit causal predicates; the engine does not infer cause from correlation or temporal order',
  };
}
