// Workshop artifacts: a deterministic design sheet the user composes.
//
// The Workshop is a place to declare structure and numbers - components, connections between
// them, and an optional budget - and to ask what those declarations imply. It is not a shell, a
// code runner, a CAD kernel, or a circuit solver. `simulateArtifact` is arithmetic over the
// numbers the artifact declares, and it returns a report. Nothing is executed, nothing is
// authorized, and the same artifact always produces the same report.
//
// The rules the module enforces, so the store and the UI cannot be given a shape they did not
// expect:
//  - an artifact is a finite list of uniquely named components and connections between them;
//  - every number is finite, non-negative, and bounded;
//  - a connection names two components that exist and is never a self-loop or a duplicate;
//  - the identity of an artifact is the digest of its content, so composing the same sheet twice
//    is the same artifact rather than two divergent copies;
//  - `authorizesExecution` and `executedCode` are false on every artifact and every report.
import { createHash } from 'node:crypto';

export const WORKSHOP_SCHEMA = 'apex.workshop.v1';
export const WORKSHOP_SCHEMA_VERSION = 1;
export const WORKSHOP_SIMULATION_SCHEMA = 'apex.workshop.simulation.v1';
export const WORKSHOP_INSPECTION_SCHEMA = 'apex.workshop.inspection.v1';

export const MAX_COMPONENTS = 200;
export const MAX_CONNECTIONS = 400;
export const MAX_TITLE_CHARS = 160;
export const MAX_LABEL_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_MAGNITUDE = 1e9;

export const DOMAINS = Object.freeze(['generic', 'code', 'circuit', 'cad', 'data', 'plan']);

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const EPSILON = 1e-9;

export class WorkshopError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkshopError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkshopError(code, message);
}

function numberField(value, name, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('WORKSHOP_NUMBER', `${name} must be a finite number`);
  }
  if (value < 0) fail('WORKSHOP_NUMBER', `${name} must not be negative`);
  if (value > MAX_MAGNITUDE) fail('WORKSHOP_NUMBER', `${name} must not exceed ${MAX_MAGNITUDE}`);
  return value;
}

function textField(value, name, max) {
  if (typeof value !== 'string') fail('WORKSHOP_TEXT', `${name} must be text`);
  if (value.length > max) fail('WORKSHOP_TEXT', `${name} must be at most ${max} characters`);
  return value;
}

function nameField(value, name) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    fail('WORKSHOP_NAME', `${name} must be a lower-case name of up to 32 letters, digits, "-" or "_"`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('WORKSHOP_SHAPE', `${where} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('WORKSHOP_SHAPE', `${where} has an unexpected field "${key}"`);
  }
}

// A composition is validated once, here, and every later reader sees the same normalized shape.
export function normalizeComposition(input) {
  rejectUnknownKeys(input, ['title', 'domain', 'components', 'connections', 'budget', 'note'], 'the composition');
  const title = textField(input.title, 'title', MAX_TITLE_CHARS).trim();
  if (title.length === 0) fail('WORKSHOP_TEXT', 'title must not be empty');

  const domain = input.domain === undefined || input.domain === null ? 'generic' : input.domain;
  if (!DOMAINS.includes(domain)) fail('WORKSHOP_DOMAIN', `domain must be one of ${DOMAINS.join(', ')}`);

  const note = input.note === undefined || input.note === null ? '' : textField(input.note, 'note', MAX_NOTE_CHARS).trim();

  if (!Array.isArray(input.components) || input.components.length === 0) {
    fail('WORKSHOP_SHAPE', 'components must be a non-empty list');
  }
  if (input.components.length > MAX_COMPONENTS) {
    fail('WORKSHOP_BOUND', `a design may declare at most ${MAX_COMPONENTS} components`);
  }
  const seen = new Set();
  const components = input.components.map((raw, index) => {
    rejectUnknownKeys(raw, ['id', 'label', 'kind', 'supply', 'demand', 'cost'], `component ${index}`);
    const id = nameField(raw.id, `component ${index} id`);
    if (seen.has(id)) fail('WORKSHOP_DUPLICATE', `component id "${id}" appears twice`);
    seen.add(id);
    const label = raw.label === undefined || raw.label === null ? id : textField(raw.label, `component ${id} label`, MAX_LABEL_CHARS).trim();
    const kind = raw.kind === undefined || raw.kind === null ? 'component' : raw.kind;
    if (typeof kind !== 'string' || !NAME_PATTERN.test(kind)) {
      fail('WORKSHOP_NAME', `component ${id} kind must be a lower-case name of up to 32 letters, digits, "-" or "_"`);
    }
    return {
      id,
      label: label.length === 0 ? id : label,
      kind,
      supply: numberField(raw.supply, `component ${id} supply`),
      demand: numberField(raw.demand, `component ${id} demand`),
      cost: numberField(raw.cost, `component ${id} cost`),
    };
  });

  const rawConnections = input.connections === undefined || input.connections === null ? [] : input.connections;
  if (!Array.isArray(rawConnections)) fail('WORKSHOP_SHAPE', 'connections must be a list');
  if (rawConnections.length > MAX_CONNECTIONS) {
    fail('WORKSHOP_BOUND', `a design may declare at most ${MAX_CONNECTIONS} connections`);
  }
  const pairs = new Set();
  const connections = rawConnections.map((raw, index) => {
    rejectUnknownKeys(raw, ['from', 'to', 'label'], `connection ${index}`);
    const from = nameField(raw.from, `connection ${index} from`);
    const to = nameField(raw.to, `connection ${index} to`);
    if (!seen.has(from)) fail('WORKSHOP_REFERENCE', `connection ${index} names an unknown component "${from}"`);
    if (!seen.has(to)) fail('WORKSHOP_REFERENCE', `connection ${index} names an unknown component "${to}"`);
    if (from === to) fail('WORKSHOP_REFERENCE', `connection ${index} connects "${from}" to itself`);
    const pair = `${from}\u0000${to}`;
    if (pairs.has(pair)) fail('WORKSHOP_DUPLICATE', `connection ${from} -> ${to} appears twice`);
    pairs.add(pair);
    const label = raw.label === undefined || raw.label === null ? '' : textField(raw.label, `connection ${index} label`, MAX_LABEL_CHARS).trim();
    return label.length === 0 ? { from, to } : { from, to, label };
  });

  let budget = null;
  if (input.budget !== undefined && input.budget !== null) {
    if (typeof input.budget === 'number') {
      budget = { total: numberField(input.budget, 'budget') };
    } else {
      rejectUnknownKeys(input.budget, ['total'], 'the budget');
      budget = { total: numberField(input.budget.total, 'budget total') };
    }
  }

  return { title, domain, note, components, connections, budget };
}

// Kept small and order-independent so a digest names the content and not the caller's key order.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function identityDigest(composition) {
  return createHash('sha256').update(canonicalJson(composition)).digest('hex');
}

export function artifactIdFor(composition) {
  return `ws-${identityDigest(composition).slice(0, 16)}`;
}

export function buildArtifact(composition, { now = () => new Date() } = {}) {
  const canonical = identityDigest(composition);
  return {
    schema: WORKSHOP_SCHEMA,
    schemaVersion: WORKSHOP_SCHEMA_VERSION,
    kind: 'artifact',
    artifactId: `ws-${canonical.slice(0, 16)}`,
    identityDigest: canonical,
    title: composition.title,
    domain: composition.domain,
    components: composition.components,
    connections: composition.connections,
    budget: composition.budget,
    note: composition.note,
    createdAt: now().toISOString(),
    authorizesExecution: false,
    executedCode: false,
  };
}

// Every node that participates in a directed cycle. Iterative-friendly depth is bounded by
// MAX_COMPONENTS, so the recursive walk cannot exhaust the stack on an accepted artifact.
export function findCycles(components, connections) {
  const ids = components.map((component) => component.id);
  const index = new Map(ids.map((id, position) => [id, position]));
  const adjacency = ids.map(() => []);
  for (const connection of connections) {
    adjacency[index.get(connection.from)].push(index.get(connection.to));
  }
  const state = new Array(ids.length).fill(0);
  const stack = [];
  const onCycle = new Set();
  const visit = (node) => {
    state[node] = 1;
    stack.push(node);
    for (const next of adjacency[node]) {
      if (state[next] === 0) visit(next);
      else if (state[next] === 1) {
        for (const member of stack.slice(stack.indexOf(next))) onCycle.add(ids[member]);
      }
    }
    stack.pop();
    state[node] = 2;
  };
  for (let node = 0; node < ids.length; node += 1) {
    if (state[node] === 0) visit(node);
  }
  return [...onCycle].sort();
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function inspectArtifact(artifact) {
  const byKind = {};
  const isolated = [];
  const incoming = new Set(artifact.connections.map((connection) => connection.to));
  const outgoing = new Set(artifact.connections.map((connection) => connection.from));
  for (const component of artifact.components) {
    byKind[component.kind] = (byKind[component.kind] ?? 0) + 1;
    if (!incoming.has(component.id) && !outgoing.has(component.id)) isolated.push(component.id);
  }
  const kinds = Object.keys(byKind).sort();
  const cycles = findCycles(artifact.components, artifact.connections);
  return {
    schema: WORKSHOP_INSPECTION_SCHEMA,
    artifactId: artifact.artifactId,
    identityDigest: artifact.identityDigest,
    title: artifact.title,
    domain: artifact.domain,
    counts: {
      components: artifact.components.length,
      connections: artifact.connections.length,
      kinds: kinds.length,
      isolated: isolated.length,
      cycles: cycles.length,
    },
    kinds,
    byKind,
    components: artifact.components.map((component) => ({ ...component })),
    connections: artifact.connections.map((connection) => ({ ...connection })),
    isolated,
    cycles,
    budget: artifact.budget === null ? null : { total: artifact.budget.total },
    note: artifact.note,
    executedCode: false,
    authorizesExecution: false,
  };
}

export function simulateArtifact(artifact) {
  const byId = new Map(artifact.components.map((component) => [component.id, component]));
  const outDegree = new Map(artifact.components.map((component) => [component.id, 0]));
  for (const connection of artifact.connections) {
    outDegree.set(connection.from, outDegree.get(connection.from) + 1);
  }
  // A declared supply is shared evenly across a component's outgoing connections. That is the
  // whole model: it is a budget arithmetic, not a physical or electrical simulation.
  const inbound = new Map(artifact.components.map((component) => [component.id, 0]));
  const flows = artifact.connections.map((connection) => {
    const supplier = byId.get(connection.from);
    const transferred = outDegree.get(connection.from) === 0 ? 0 : supplier.supply / outDegree.get(connection.from);
    inbound.set(connection.to, inbound.get(connection.to) + transferred);
    return { from: connection.from, to: connection.to, transferred: round(transferred) };
  });

  const components = artifact.components.map((component) => {
    const received = round(inbound.get(component.id));
    return {
      id: component.id,
      supply: component.supply,
      demand: component.demand,
      cost: component.cost,
      inbound: received,
      satisfied: received + EPSILON >= component.demand,
      slack: round(received - component.demand),
    };
  });
  const unsatisfied = components.filter((component) => !component.satisfied).map((component) => component.id);
  const spent = round(artifact.components.reduce((sum, component) => sum + component.cost, 0));
  const budget = artifact.budget === null
    ? null
    : {
      total: artifact.budget.total,
      spent,
      remaining: round(artifact.budget.total - spent),
      overBudget: spent > artifact.budget.total + EPSILON,
    };
  const cycles = findCycles(artifact.components, artifact.connections);

  const warnings = [];
  if (cycles.length > 0) {
    warnings.push(`connections form a feedback loop through ${cycles.length} component(s); the one-way share model reports it rather than simulating feedback`);
  }
  if (unsatisfied.length > 0) warnings.push(`${unsatisfied.length} component(s) receive less than they declare they need`);
  if (budget && budget.overBudget) warnings.push(`declared cost ${budget.spent} exceeds the budget ${budget.total}`);

  const underSupplied = unsatisfied.length > 0;
  const overBudget = Boolean(budget && budget.overBudget);
  const status = `${underSupplied ? 'under_supplied' : 'satisfied'}${overBudget ? '_and_over_budget' : ''}`;

  return {
    schema: WORKSHOP_SIMULATION_SCHEMA,
    artifactId: artifact.artifactId,
    identityDigest: artifact.identityDigest,
    status,
    components,
    flows,
    unsatisfied,
    cycles,
    budget,
    warnings,
    warningsText: warnings.join('; '),
    executedCode: false,
    authorizesExecution: false,
    note: 'Arithmetic over the numbers the design declares, with each supply split evenly across its outgoing connections. Nothing was executed and nothing was authorized.',
  };
}
