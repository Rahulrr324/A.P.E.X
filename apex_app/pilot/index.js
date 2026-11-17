// T-16 real-world pilot registry.
//
// Synthetic evaluation lives in `eval/`; this directory is the separate real-world category the
// milestone requires. Every scenario here drives the installed application through real operating
// system processes against real local files, so its results are kept in their own report and are
// never merged into the synthetic totals.
//
// The registry is data plus one selector. It runs nothing until the runner asks.
import filesystemDocuments from './scenarios/filesystem-documents.js';
import executiveWorkflows from './scenarios/executive-workflows.js';
import securitySurface from './scenarios/security-surface.js';

export const SCENARIOS = Object.freeze([
  ...filesystemDocuments,
  ...executiveWorkflows,
  ...securitySurface,
]);

export const AREAS = Object.freeze([...new Set(SCENARIOS.map((scenario) => scenario.area))]);

// The ten sustained workflows §6 requires. A scenario names one so the report can show which
// workflows have real evidence and which do not; a workflow with no scenario is honestly empty.
export const WORKFLOWS = Object.freeze({
  A: 'project continuity across sessions (work started in one session is found and continued in the next)',
  B: 'requirements change mid-project, and later work follows the changed requirement',
  C: 'the user corrects earlier recorded work, and the correction is preserved without rewriting history',
  D: 'two real sources disagree, and the disagreement is represented rather than silently resolved',
  E: 'execution is interrupted, and the recovered state is accurate and not duplicated',
  F: 'an external observation changes what APEX knows, through a configured provider',
  G: 'a dependency is genuinely blocked, and the block is reported instead of skipped',
  H: 'a provider is unavailable or fails, and the failure is bounded and reported',
  I: 'the runtime runs for a sustained period under real scheduling',
  J: 'recovery and audit: a damaged or restarted state is inspected and reconstructed',
});

export function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function selectScenarios({ area = null, workflow = null, ids = [] } = {}) {
  return SCENARIOS.filter((scenario) => {
    if (area && scenario.area !== area) return false;
    if (workflow && scenario.workflow !== workflow) return false;
    if (ids.length === 0) return true;
    return ids.some((id) => scenario.id === id || scenario.id.startsWith(id));
  });
}

export {
  runPilotScenario, renderPilotReport, summarizePilot, pilotSignature,
  validatePilotScenario, check, stableValue, appIdentity, environment,
  PILOT_VERSION, PILOT_CATEGORY, PILOT_DIMENSIONS, PILOT_FAILURE_CLASSES,
} from './harness.js';
