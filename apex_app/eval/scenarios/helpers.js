// Small shared readers for the scenario files. They only read public results and documented
// append-only logs; they do not import application internals.
import { readJsonl } from '../oracles.js';

export const ACTIVE_MEMORY = new Set(['user_confirmed', 'active']);

export function memoryRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

export function taskSteps(task) {
  return Array.isArray(task?.steps) ? task.steps : [];
}

export function operationsCapable(dataDir, capability) {
  return readJsonl(dataDir, 'operations.jsonl').records.filter((record) => record?.capability === capability);
}

export function countedLines(dataDir, name) {
  return readJsonl(dataDir, name).records.length;
}

// A situation event with only the fields this evaluation varies. The defaults describe an
// observation, not a command: no source can ask for an action through this interface. The
// fallback identifier is a module counter, not a random value, so two runs over identical
// fixtures produce identical records.
let fallbackEventCount = 0;

export function situationEvent(overrides = {}) {
  fallbackEventCount += 1;
  return {
    source: 'user',
    sourceEventId: overrides.sourceEventId ?? `eval-${fallbackEventCount}`,
    type: 'observation',
    category: 'observation',
    payload: { description: 'An environmental observation.' },
    confidence: 0.8,
    ...overrides,
  };
}
