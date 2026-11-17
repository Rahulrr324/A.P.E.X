// T-15 evaluation scenario registry.
//
// A reader looking for "what APEX can do" starts here: every scenario is a documented user
// situation with a measurable expected outcome, and this file lists them in one place. The
// registry is data plus one factory; it does not run anything until the runner asks it to.
//
// Categories follow the six areas the milestone names: personal executive, research and
// knowledge, planning and execution, situational awareness, security and trust, long-duration
// operation, plus reasoning quality on the T-13 workspace.
import { createEvaluationContext } from './context.js';
import personalExecutive from './scenarios/personal-executive.js';
import researchKnowledge from './scenarios/research-knowledge.js';
import planningExecution from './scenarios/planning-execution.js';
import situationalAwareness from './scenarios/situational-awareness.js';
import securityTrust from './scenarios/security-trust.js';
import longDuration from './scenarios/long-duration.js';
import reasoningQuality from './scenarios/reasoning-quality.js';

export const SCENARIOS = Object.freeze([
  ...personalExecutive,
  ...researchKnowledge,
  ...planningExecution,
  ...situationalAwareness,
  ...securityTrust,
  ...longDuration,
  ...reasoningQuality,
]);

export const CATEGORIES = Object.freeze([...new Set(SCENARIOS.map((scenario) => scenario.category))]);

// One fresh isolated fixture per scenario. `restart()` inside a scenario keeps the same bytes,
// clock and identity so continuity is measured rather than assumed.
export function makeContext(scenario) {
  return createEvaluationContext({ scenario });
}

export function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function selectScenarios({ category = null, ids = [] } = {}) {
  return SCENARIOS.filter((scenario) => {
    if (category && scenario.category !== category) return false;
    if (ids.length === 0) return true;
    return ids.some((id) => scenario.id === id || scenario.id.startsWith(id));
  });
}

export { createEvaluationContext };
export {
  runEvaluation, runScenario, renderReport, summarize, signatureOf,
  validateScenario, check, DIMENSIONS, FAILURE_CLASSES,
} from './framework.js';
