// The declaration an operator and a test can read. It states the versions, limits, isolation
// contract, trust boundary, and lifecycle counters, and it always says that no inference has
// been tested. It never starts a runtime or contacts one.
import {
  MAX_DEADLINE_MS,
  MAX_OUTPUT_CHARS,
  MAX_PLAN_STEPS,
  MAX_PROPOSALS,
  MAX_REQUEST_CHARS,
  MAX_RESPONSE_CHARS,
  NEURAL_REQUEST_SCHEMA,
  NEURAL_RESPONSE_SCHEMA,
  PROPOSAL_KINDS,
} from './contract.js';
import { NEURAL_BOUNDARY_SCHEMA, createNeuralBoundary } from './runtime.js';
import { SIMULATED_NOTE, SIMULATED_RUNTIME } from './simulated.js';

const DISCONNECTED = createNeuralBoundary();

function withSimulation(declaration) {
  return {
    ...declaration,
    simulated: {
      available: true,
      name: SIMULATED_RUNTIME.name,
      version: SIMULATED_RUNTIME.version,
      modelId: SIMULATED_RUNTIME.modelId,
      connected: declaration.transport?.simulated === true,
      note: SIMULATED_NOTE,
    },
  };
}

// With no boundary supplied, the application reports the disconnected default.
export function describeNeuralBoundary(boundary = null) {
  return withSimulation((boundary ?? DISCONNECTED).describe());
}

const ZERO_COUNTS = Object.freeze({
  requests: 0, completed: 0, empty: 0, unavailable: 0, errored: 0,
  timedOut: 0, cancelled: 0, malformed: 0, tooLarge: 0, unsupportedVersion: 0, rejected: 0,
});

export function neuralBoundaryProblems(declaration) {
  const problems = [];
  const push = (condition, message) => {
    if (!condition) problems.push(message);
  };
  push(declaration?.schema === NEURAL_BOUNDARY_SCHEMA, 'the boundary schema is not apex.neural-boundary/1');
  push(declaration?.requestSchema === NEURAL_REQUEST_SCHEMA, 'the request schema is not apex.neural.request/1');
  push(declaration?.responseSchema === NEURAL_RESPONSE_SCHEMA, 'the response schema is not apex.neural.response/1');
  push(typeof declaration?.configured === 'boolean', 'configured must be a boolean');
  if (declaration?.configured === true) {
    const t = declaration.transport;
    push(t && typeof t === 'object', 'a configured boundary must name its transport');
    if (t && typeof t === 'object') {
      push(typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 80, 'the transport name must be short text');
      push(typeof t.simulated === 'boolean', 'transport.simulated must be a boolean');
      push(t.inferenceTested === false, 'no neural runtime can be reported as inference-tested in this build');
    }
  } else {
    push(declaration?.transport === null, 'an unconfigured boundary must not name a transport');
  }
  const l = declaration?.limits ?? {};
  push(l.maxRequestChars === MAX_REQUEST_CHARS, `maxRequestChars must be ${MAX_REQUEST_CHARS}`);
  push(l.maxResponseChars === MAX_RESPONSE_CHARS, `maxResponseChars must be ${MAX_RESPONSE_CHARS}`);
  push(l.maxProposals === MAX_PROPOSALS, `maxProposals must be ${MAX_PROPOSALS}`);
  push(l.maxPlanSteps === MAX_PLAN_STEPS, `maxPlanSteps must be ${MAX_PLAN_STEPS}`);
  push(l.maxOutputChars === MAX_OUTPUT_CHARS, `maxOutputChars must be ${MAX_OUTPUT_CHARS}`);
  push(Number.isInteger(l.defaultDeadlineMs) && l.defaultDeadlineMs > 0 && l.defaultDeadlineMs <= MAX_DEADLINE_MS, 'the default deadline must be a positive bounded integer');
  push(l.maxDeadlineMs === MAX_DEADLINE_MS, `maxDeadlineMs must be ${MAX_DEADLINE_MS}`);
  const iso = declaration?.isolation ?? {};
  push(iso.runtimeReceivesStores === false, 'the runtime must not receive stores');
  push(iso.runtimeMayInvokeActions === false, 'the runtime must not invoke actions');
  push(iso.runtimeMayApprove === false, 'the runtime must not approve anything');
  push(iso.runtimeMayWrite === false, 'the runtime must not write');
  push(iso.oneRequestAtATime === true, 'one request at a time must be enforced');
  push(typeof iso.note === 'string' && iso.note.length > 0, 'the isolation statement must be explained');
  const trust = declaration?.trust ?? {};
  push(Array.isArray(trust.proposalKinds)
    && trust.proposalKinds.length === PROPOSAL_KINDS.length
    && trust.proposalKinds.every((k) => PROPOSAL_KINDS.includes(k)), 'the proposal kinds must be exactly the accepted three');
  push(trust.confidenceIsAdvisory === true, 'confidence must be declared advisory');
  push(trust.runtimeAuthority === 'none', 'the runtime must have no authority');
  push(trust.executableWithoutUserDecision === false, 'a proposal must not be executable without a user decision');
  push(trust.verified === false && trust.recorded === false, 'the trust boundary must say nothing is verified or recorded');
  push(declaration?.verified === false, 'the boundary declaration must not claim verification');
  push(declaration?.probed === false, 'the boundary declaration must not claim a probe');
  push(declaration?.inferenceTested === false, 'no inference has been tested in this build');
  const sim = declaration?.simulated ?? {};
  push(sim.available === true, 'the simulated transport must be reported as available to tests');
  push(sim.name === SIMULATED_RUNTIME.name && sim.version === SIMULATED_RUNTIME.version, 'the simulated runtime identity must match the module');
  push(typeof sim.connected === 'boolean', 'simulated.connected must be a boolean');
  push(typeof sim.note === 'string' && sim.note.length > 0, 'the simulated transport must be explained');
  const life = declaration?.lifecycle ?? {};
  push(life.inFlight === null || typeof life.inFlight === 'string', 'lifecycle.inFlight must be null or a request id');
  push(life.counts && typeof life.counts === 'object', 'lifecycle counts must be reported');
  if (life.counts && typeof life.counts === 'object') {
    for (const key of Object.keys(ZERO_COUNTS)) {
      push(Number.isInteger(life.counts[key]) && life.counts[key] >= 0, `lifecycle counter ${key} must be a non-negative integer`);
    }
  }
  push(life.last === null || (typeof life.last === 'object' && life.last !== null), 'lifecycle.last must be null or a record');
  return problems;
}

export function renderNeuralBoundary(declaration) {
  const lines = [];
  lines.push('Neural runtime boundary (declared, not probed; no neural inference runs)');
  lines.push(`Contract: ${declaration.requestSchema} -> ${declaration.responseSchema}`);
  lines.push(declaration.configured
    ? `State: transport ${declaration.transport.name} connected${declaration.transport.simulated ? ' (deterministic simulation)' : ''}`
    : 'State: not configured; no runtime is contacted');
  const l = declaration.limits;
  lines.push(`Limits: request ${l.maxRequestChars} chars, response ${l.maxResponseChars} chars, ${l.maxProposals} proposals, ${l.maxPlanSteps} plan steps, ${l.maxOutputChars} output chars, deadline ${l.maxDeadlineMs} ms maximum`);
  lines.push('Isolation: one request at a time; no store, registry, action, approval, or write handle crosses the boundary');
  lines.push(`Proposal kinds: ${declaration.trust.proposalKinds.join(', ')}; confidence is advisory; runtime authority: none`);
  lines.push('Trust: a proposal is data - not executed, approved, verified, or stored');
  if (declaration.simulated?.available) {
    lines.push(`Simulated transport: ${declaration.simulated.name} ${declaration.simulated.version} (${declaration.simulated.note}); ${declaration.simulated.connected ? 'connected' : 'available to tests only, not connected'}`);
  }
  return lines.join('\n');
}
