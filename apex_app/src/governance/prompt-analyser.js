// Prompt analyser: reject invalid subsystem specifications deterministically. This is a fail-closed
// governance mechanism, not an advisory scorer. It never calls a model or provider.
import { EVIDENCE_TIERS, SPEC_SCHEMA } from './prompt-maker.js';

export const ANALYSIS_SCHEMA = 'apex.prompt-analysis/1';
export const CORE_INVARIANTS = Object.freeze([
  'one persistent APEX identity across models, modes and sessions',
  'the ECP is the sole authorization authority and the kill switch is outside the model path',
  'Resource Fabric is the sole resource-allocation authority',
  'Memory, Knowledge, World Model, Perception and Neural Associative Memory have distinct owners',
  'observation, inference, assumption and prediction are distinguishable',
  'personas and UI themes change presentation only',
  'emotion indicators never override the ECP or create permissions',
  'self-improvement occurs only through the Evolution Lab with owner approval',
  'experimental components do not silently become trusted capabilities',
  'the UI does not show success until it is verified',
  'persistent state is recoverable and protected',
  'evidence tiers C, P and V are preserved',
  'delegation never increases authority',
  'every consequential operation is attributable',
  'uncertain outcomes remain uncertain until verified',
  'every subsystem has an owner and source of truth',
  'resource consumption is bounded and observable',
]);

function fixedViolation(code, detail) {
  return { code, detail };
}

export function analysePromptSpec(spec) {
  const violations = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { schema: ANALYSIS_SCHEMA, accepted: false, violations: [fixedViolation('INVALID_SPEC', 'specification must be an object')], inferenceActivated: false };
  }
  if (spec.schema !== SPEC_SCHEMA) violations.push(fixedViolation('SCHEMA', `spec.schema must be ${SPEC_SCHEMA}`));
  for (const key of ['subsystem', 'purpose', 'owner', 'implementationMaturity', 'failureAndRollback']) {
    if (typeof spec[key] !== 'string' || spec[key].trim().length === 0) violations.push(fixedViolation('MISSING_FIELD', `${key} is required`));
  }
  if (!EVIDENCE_TIERS.includes(spec.evidenceTier)) violations.push(fixedViolation('EVIDENCE_TIER', 'C, P, or V evidence tier is required'));
  if (!Array.isArray(spec.invariants) || spec.invariants.length === 0) violations.push(fixedViolation('INVARIANTS', 'applicable canonical invariants are required'));
  else {
    if (spec.invariants.some((number) => !Number.isInteger(number) || number < 1 || number > 17)) {
      violations.push(fixedViolation('INVARIANT_NUMBER', 'invariant numbers must be 1-17'));
    }
  }
  if (!Array.isArray(spec.interfaces) || spec.interfaces.length === 0) violations.push(fixedViolation('INTERFACE', 'at least one interface is required'));
  if (!Array.isArray(spec.acceptanceTests) || spec.acceptanceTests.length === 0) violations.push(fixedViolation('ACCEPTANCE_TEST', 'measurable acceptance tests are required'));
  if (!Array.isArray(spec.inputs) || !Array.isArray(spec.outputs)) violations.push(fixedViolation('IO', 'inputs and outputs must be bounded lists'));
  if (!Array.isArray(spec.explicitNonGoals) || spec.explicitNonGoals.length === 0) violations.push(fixedViolation('NON_GOALS', 'explicit non-goals are required'));

  if (!Number.isInteger(spec.autonomyLevel) && !(spec.permissions && Number.isInteger(spec.permissions.autonomyLevel))) {
    violations.push(fixedViolation('AUTONOMY', 'one exact autonomy level L0-L5 is required'));
  }
  const level = spec.permissions?.autonomyLevel ?? spec.autonomyLevel;
  if (!Number.isInteger(level) || level < 0 || level > 5) violations.push(fixedViolation('AUTONOMY_LEVEL', 'autonomy level must be 0-5'));
  if (level >= 3 && (!spec.permissions || typeof spec.permissions.resourceScope !== 'string' || spec.permissions.resourceScope.length === 0)) {
    violations.push(fixedViolation('DELEGATION_SCOPE', 'L3-L5 specifications require an explicit bounded resource scope'));
  }
  if (level === 5 && (!spec.permissions || spec.permissions.standingOrder !== true)) {
    violations.push(fixedViolation('L5_RESTRICTION', 'L5 requires an explicitly configured low-risk standing order'));
  }

  const text = JSON.stringify(spec).toLowerCase();
  const forbiddenClaims = ['instant', 'perfect', 'all capabilities', 'conscious', 'unrestricted', 'always successful'];
  for (const claim of forbiddenClaims) {
    if (text.includes(claim)) violations.push(fixedViolation('UNVERIFIABLE_CLAIM', `unverifiable claim language: ${claim}`));
  }
  const forbiddenInference = ['start ollama', 'start llama.cpp', 'download model', 'enable remote inference', 'launch inference'];
  for (const phrase of forbiddenInference) {
    if (text.includes(phrase)) violations.push(fixedViolation('INFERENCE_ACTIVATION', `current project instruction forbids: ${phrase}`));
  }
  const duplicateOwners = Array.isArray(spec.architecturalOwners) && spec.architecturalOwners.length > 1;
  if (duplicateOwners) violations.push(fixedViolation('DUPLICATE_OWNER', 'multiple owners for one subsystem state or authority boundary are forbidden'));

  const reimplementation = Array.isArray(spec.reuse) ? spec.reuse : [];
  const intentText = String(spec.reimplementation ?? '');
  if (/reimplement|replace|second controller|new registry|duplicate store/i.test(intentText)
    && /controller|registry|taskgraph|memory|world model|audit/i.test(intentText)
    && reimplementation.length === 0) {
    violations.push(fixedViolation('REIMPLEMENTATION', 'reimplementation of existing architecture lacks a reuse justification'));
  }
  if (spec.evidenceTier === 'V' && !Array.isArray(spec.acceptanceTests) || spec.evidenceTier === 'V' && spec.acceptanceTests?.length === 0) {
    violations.push(fixedViolation('V_EVIDENCE', 'V-tier claims require repeatable acceptance tests'));
  }

  return {
    schema: ANALYSIS_SCHEMA,
    accepted: violations.length === 0,
    violations,
    evidenceTier: spec.evidenceTier,
    invariantCount: Array.isArray(spec.invariants) ? spec.invariants.length : 0,
    inferenceActivated: false,
  };
}

export function rejectPromptSpec(spec) {
  const report = analysePromptSpec(spec);
  if (report.accepted) return report;
  const err = new Error(`prompt specification rejected: ${report.violations.map((row) => `${row.code}:${row.detail}`).join('; ')}`);
  err.code = 'PROMPT_SPEC_REJECTED';
  err.analysis = report;
  throw err;
}
