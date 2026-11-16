// A deterministic transport for exercising the boundary. It is a fixed set of pattern rules,
// not understanding, not a model, and not training: the same text always yields the same
// proposals, and every reply says which simulated runtime produced it. It is never selected
// by the application; tests construct it explicitly and it runs no inference.
import { NEURAL_RESPONSE_SCHEMA } from './contract.js';
import { NeuralRuntimeBoundary } from './runtime.js';

export const SIMULATED_RUNTIME = Object.freeze({
  name: 'apex-neural-simulated',
  version: '1.0.0',
  modelId: 'none',
});

export const SIMULATED_NOTE = 'deterministic test rules; no neural model, no inference, no training';

export function simulatedProposals(text, limits = {}) {
  const body = String(text ?? '').trim();
  const outputLimit = Number.isInteger(limits.maxOutputChars) ? limits.maxOutputChars : 8000;
  const maxProposals = Number.isInteger(limits.maxProposals) ? limits.maxProposals : 8;
  const proposals = [];
  const remember = /^remember(?:\s+that)?\s+(.+)$/i.exec(body);
  if (remember) {
    proposals.push({
      kind: 'memory_claim',
      confidence: 0.5,
      payload: { content: remember[1].trim().slice(0, Math.min(4000, outputLimit)) },
    });
  }
  if (/\bplan\b/i.test(body)) {
    proposals.push({
      kind: 'plan',
      confidence: 0.5,
      payload: {
        steps: [{ id: 's1', description: 'report application status', action: 'app.status', input: {}, depends_on: [] }],
      },
    });
  }
  if (!remember) {
    const claim = /^(.{1,80}?)\s+(is|are)\s+(.{1,200})$/i.exec(body);
    if (claim) {
      proposals.push({
        kind: 'knowledge_claim',
        confidence: 0.4,
        payload: {
          subject: claim[1].trim().slice(0, Math.min(500, outputLimit)),
          relationship: claim[2].toLowerCase(),
          object: claim[3].trim().slice(0, Math.min(500, outputLimit)),
        },
      });
    }
  }
  return proposals.slice(0, maxProposals);
}

export function createSimulatedNeuralTransport({ runtime = SIMULATED_RUNTIME } = {}) {
  return Object.freeze({
    name: runtime.name,
    simulated: true,
    inferenceTested: false,
    async invoke(request, { signal } = {}) {
      if (signal?.aborted === true) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return JSON.stringify({
        schema: NEURAL_RESPONSE_SCHEMA,
        requestId: request?.requestId,
        status: 'ok',
        proposals: simulatedProposals(request?.input?.text, request?.limits),
        runtime,
      });
    },
  });
}

export function createSimulatedNeuralBoundary(options = {}) {
  return new NeuralRuntimeBoundary({ ...options, transport: createSimulatedNeuralTransport() });
}
