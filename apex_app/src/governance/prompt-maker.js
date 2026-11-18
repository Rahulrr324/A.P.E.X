// Deterministic prompt/spec maker for APEX v2. It creates implementation specifications only;
// it never claims a C/P concept is working and it never activates inference or providers.
export const SPEC_SCHEMA = 'apex.prompt-spec/1';
export const EVIDENCE_TIERS = Object.freeze(['C', 'P', 'V']);

const DOMAIN_RE = /^[a-z][a-z0-9_-]{1,63}$/;

function boundedText(value, name, max = 2000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${name} must be non-empty text of at most ${max} characters`);
  }
  return value.trim();
}

export function makeSubsystemSpec(input = {}) {
  const subsystem = boundedText(input.subsystem, 'subsystem', 64);
  if (!DOMAIN_RE.test(subsystem)) throw new TypeError('subsystem must be a lowercase domain identifier');
  const tier = input.evidenceTier;
  if (!EVIDENCE_TIERS.includes(tier)) throw new TypeError('evidenceTier must be C, P, or V');
  const purpose = boundedText(input.purpose, 'purpose');
  const owner = boundedText(input.owner, 'owner', 120);
  const interfaces = input.interfaces ?? [];
  if (!Array.isArray(interfaces) || interfaces.length === 0 || interfaces.length > 16
    || interfaces.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 240)) {
    throw new TypeError('interfaces must name 1-16 bounded interfaces');
  }
  const acceptanceTests = input.acceptanceTests ?? [];
  if (!Array.isArray(acceptanceTests) || acceptanceTests.length === 0 || acceptanceTests.length > 32
    || acceptanceTests.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 300)) {
    throw new TypeError('acceptanceTests must name 1-32 bounded tests');
  }
  const invariants = input.invariants ?? [];
  if (!Array.isArray(invariants) || invariants.length > 17
    || invariants.some((value) => !Number.isInteger(value) || value < 1 || value > 17)
    || new Set(invariants).size !== invariants.length) {
    throw new TypeError('invariants must be unique integers from 1-17');
  }
  const autonomyLevel = Number.isInteger(input.autonomyLevel)
    ? input.autonomyLevel
    : (input.permissions && Number.isInteger(input.permissions.autonomyLevel)
      ? input.permissions.autonomyLevel
      : null);
  if (!Number.isInteger(autonomyLevel) || autonomyLevel < 0 || autonomyLevel > 5) {
    throw new TypeError('autonomyLevel must be an integer from 0 to 5');
  }
  const result = {
    schema: SPEC_SCHEMA,
    subsystem,
    purpose,
    owner,
    evidenceTier: tier,
    implementationMaturity: boundedText(input.implementationMaturity ?? 'Not started', 'implementationMaturity', 40),
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    interfaces: [...interfaces],
    dependencies: input.dependencies ?? [],
    invariants: [...invariants].sort((a, b) => a - b),
    acceptanceTests: [...acceptanceTests],
    explicitNonGoals: input.explicitNonGoals ?? [],
    failureAndRollback: boundedText(input.failureAndRollback ?? 'Fail closed; preserve state; roll back only owned changes.', 'failureAndRollback'),
    permissions: input.permissions ?? { capability: null, resourceScope: 'one explicit bounded scope', autonomyLevel },
    performance: input.performance ?? { resourceBudget: 'bounded and disclosed', timing: 'measured, not assumed' },
    repositoryGit: input.repositoryGit ?? { root: 'E:\\A.P.E.X', branch: 'main', inference: 'inactive' },
    ...(Array.isArray(input.architecturalOwners) ? { architecturalOwners: [...input.architecturalOwners] } : {}),
    ...(Array.isArray(input.reuse) ? { reuse: [...input.reuse] } : {}),
    ...(typeof input.reimplementation === 'string' ? { reimplementation: input.reimplementation } : {}),
  };
  const arrays = ['inputs', 'outputs', 'dependencies', 'explicitNonGoals'];
  for (const key of arrays) {
    if (!Array.isArray(result[key]) || result[key].length > 32
      || result[key].some((value) => typeof value !== 'string' || value.length === 0 || value.length > 300)) {
      throw new TypeError(`${key} must be a bounded string list`);
    }
  }
  return result;
}
