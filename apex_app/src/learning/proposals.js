// Adaptation proposals from recorded outcome patterns.
//
// A proposal is a bounded restatement of evidence, never an instruction. It states what would change,
// the evidence for and against it, how many observations there are, what it is expected to buy, what
// could go wrong, whether it can be undone, how it would be judged, and who has to authorize it. The
// only authorization it names is the user's own approval, recorded through `adaptation.decide`.
//
// The guidance vocabulary is the four-field shape a user already writes for an adaptation: a step
// order, capabilities to avoid or prefer, and a whole-step bound. Nothing outside that vocabulary can
// be proposed, so no proposal can reach a policy, a permission, a security control, or a user-defined
// constraint: those are not plan steps and no guidance field names them.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import {
  MAX_LIMITATIONS,
  MAX_LIMITATION_CHARS,
  MAX_RISKS,
  MAX_RISK_CHARS,
  MAX_RULE_CHARS,
  OBSERVED_OUTCOME_PROPOSAL_TYPE,
  OUTCOME_DECISION_DIMENSION,
  PATTERN_DEFINITIONS,
  PATTERN_LIMITATIONS,
  PROPOSABLE_PATTERNS,
} from './vocabulary.js';

const GUIDANCE_ORDERS = Object.freeze(['reads_first', 'writes_first']);
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

// The rule text is generated, never parsed. Each sentence is the smallest claim its pattern states;
// a contradicting count is included whenever there is one, so the rule a user reads cannot look more
// settled than the evidence it rests on.
export function outcomePatternRule({ kind, capability, detail, observations, contradicting }) {
  const contradictions = contradicting > 0 ? `; ${contradicting} contradicting outcome(s) are recorded` : '';
  const total = observations?.total ?? 0;
  const successes = observations?.successes ?? 0;
  const failures = observations?.failures ?? 0;
  if (kind === 'repeated_success') {
    return `prefer ${capability}: ${successes} of ${total} recorded outcomes completed its steps${contradictions}`;
  }
  if (kind === 'repeated_failure') {
    return `avoid ${capability}: ${failures} of ${total} recorded outcomes failed its steps${contradictions}`;
  }
  if (kind === 'correction_hotspot') {
    return `avoid ${capability}: ${failures} recorded outcome(s) of it were corrected by you${contradictions}`;
  }
  if (kind === 'inefficient_execution') {
    return `avoid ${capability}: it appears only in ${detail?.failedRuns ?? failures} failed run(s) of this objective, and the objective succeeded ${detail?.succeededWithoutIt ?? 0} time(s) without it${contradictions}`;
  }
  if (kind === 'ordering_dependency') {
    return `prefer ${detail?.predecessor} before ${capability}: ${detail?.orderHeld ?? 0} recorded outcome(s) succeeded with that order and ${detail?.orderReversed ?? 0} failed when it was reversed`;
  }
  return null;
}

// The permission class of one registered capability, or null when the registry is unavailable or the
// name is unknown. Used only to decide whether an ordering proposal can say `reads_first` or
// `writes_first`; any other pair falls back to naming the predecessor to prefer.
function permissionOf(registry, name) {
  const def = registry && typeof registry.get === 'function' ? registry.get(name) : null;
  return def?.permission === 'read' || def?.permission === 'write' ? def.permission : null;
}

export function guidanceFor(pattern, { registry = null } = {}) {
  const base = { order: null, avoid: [], prefer: [], maxSteps: null };
  switch (pattern.kind) {
    case 'repeated_success':
      return { ...base, prefer: [pattern.capability] };
    case 'repeated_failure':
    case 'correction_hotspot':
    case 'inefficient_execution':
      return { ...base, avoid: [pattern.capability] };
    case 'ordering_dependency': {
      const predecessor = pattern.detail?.predecessor;
      if (!predecessor) return null;
      const before = permissionOf(registry, predecessor);
      const after = permissionOf(registry, pattern.capability);
      if (before === 'read' && after === 'write') return { ...base, order: 'reads_first' };
      if (before === 'write' && after === 'read') return { ...base, order: 'writes_first' };
      return { ...base, prefer: [predecessor] };
    }
    default:
      return null;
  }
}

// The digest binds the rule to the evaluations that support it. Contradicting evidence is described
// by its count in the proposal and is deliberately outside the digest: it is not support, and a
// record that cited it as support would be stating something the pattern did not.
export function proposalDigest({ capability, rule, kind, objectiveKey, guidance, supportingIds }) {
  return sha256Hex(stableStringify({
    capability,
    rule,
    kind,
    objectiveKey: objectiveKey ?? null,
    guidance,
    supportingIds,
  }));
}

// The straight-face statement of what the user is being asked to approve, and what it is supposed to
// buy. `target` is stated as a comparison, not a percentage, because a percentage would be a
// prediction this evidence cannot make.
function expectedBenefitFor(pattern) {
  const supporting = pattern.supporting.length;
  const contradicting = pattern.contradicting.length;
  return {
    statement: `at least as many recorded successes as failures for ${pattern.capability} over the next ${pattern.minObservations} determinate outcome(s)`,
    basis: {
      supporting: supporting,
      contradicting,
      observations: pattern.observations.total,
    },
  };
}

function risksFor(pattern) {
  const risks = [
    `the association was observed under ${pattern.objectiveKey ? `objective ${pattern.objectiveKey}` : 'this scope'} and is not evidence for a different objective`,
    'a rule that avoids a capability can suppress work that would have succeeded under a condition the records do not show',
  ];
  if (pattern.contradicting.length > 0) {
    risks.push(`${pattern.contradicting.length} recorded observation(s) disagree with this pattern and stay visible beside it`);
  }
  if (pattern.kind === 'ordering_dependency') {
    risks.push('the observed order may describe the way the plan was written rather than a requirement of the work');
  }
  return risks.slice(0, MAX_RISKS).map((text) => text.slice(0, MAX_RISK_CHARS));
}

// Turn one proposable pattern into the spec the store appends. Returns null when the pattern may not
// become a proposal, with no partial record left behind.
export function proposalForPattern(pattern, { registry = null } = {}) {
  if (!PROPOSABLE_PATTERNS.includes(pattern.kind)) return null;
  if (!pattern.proposalEligible) return null;
  // One candidate may cite at most twenty supporting evaluations, which is also the bound an
  // adaptation record's support list enforces. A larger pattern is described, not proposed.
  if (pattern.observations.total > 20) return null;
  const guidance = guidanceFor(pattern, { registry });
  if (!guidance) return null;
  const rule = outcomePatternRule({
    kind: pattern.kind,
    capability: pattern.capability,
    detail: pattern.detail,
    observations: pattern.observations,
    contradicting: pattern.contradicting.length,
  });
  if (!rule || rule.length > MAX_RULE_CHARS) return null;
  const proposal = {
    type: OBSERVED_OUTCOME_PROPOSAL_TYPE,
    dimension: OUTCOME_DECISION_DIMENSION,
    pattern: {
      kind: pattern.kind,
      definition: PATTERN_DEFINITIONS[pattern.kind],
      objectiveKey: pattern.objectiveKey ?? null,
      observations: pattern.observations.total,
      successes: pattern.observations.successes,
      failures: pattern.observations.failures,
      supporting: pattern.supporting.length,
      contradicting: pattern.contradicting.length,
      ...(pattern.detail ? { detail: { ...pattern.detail } } : {}),
    },
    guidance,
    expectedBenefit: expectedBenefitFor(pattern),
    risks: risksFor(pattern),
    reversibility: 'reversible',
    validationCriteria: {
      metric: 'recorded_achieved_outcomes',
      baseline: {
        successes: pattern.observations.successes,
        failures: pattern.observations.failures,
        observations: pattern.observations.total,
      },
      target: `recorded achievements for ${pattern.capability} do not fall below the baseline over at least ${pattern.minObservations} determinate outcome(s) after activation`,
      minObservations: pattern.minObservations,
    },
    requiredAuthorization: 'user_approval',
    objectiveKey: pattern.objectiveKey ?? null,
    evidenceDigest: proposalDigest({
      capability: pattern.capability,
      rule,
      kind: pattern.kind,
      objectiveKey: pattern.objectiveKey,
      guidance,
      supportingIds: pattern.supporting.map((e) => e.id),
    }),
    limitations: [
      ...PATTERN_LIMITATIONS,
      ...(pattern.limitations ?? []).filter((text) => !PATTERN_LIMITATIONS.includes(text)),
    ].slice(0, MAX_LIMITATIONS).map((text) => text.slice(0, MAX_LIMITATION_CHARS)),
  };
  return { capability: pattern.capability, rule, proposal, supportingIds: pattern.supporting.map((e) => e.id) };
}

// The identity a candidate is deduplicated by. Two objectives never share one candidate, which is
// what keeps a rule learned under one intention from being offered for another.
export function outcomeProposalKey({ capability, rule, objectiveKey }) {
  return `${capability}\u0000${objectiveKey ?? ''}\u0000${String(rule).trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

const EXPECTED_METRIC = 'recorded_achieved_outcomes';

// Validates the proposal carried by an adaptation record. The store calls this; every field is
// re-derived from the pattern the proposal states, so a hand-edited line that claims a rule its
// pattern does not state, or a digest its evidence does not produce, is refused.
export function validateOutcomeProposal(record) {
  const p = record?.proposal;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'an outcome-derived adaptation must carry a proposal';
  if (p.type !== OBSERVED_OUTCOME_PROPOSAL_TYPE) return 'proposal type is not the recorded outcome proposal type';
  if (p.dimension !== OUTCOME_DECISION_DIMENSION) return `proposal must feed the ${OUTCOME_DECISION_DIMENSION} dimension and no other`;
  const pattern = p.pattern;
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) return 'proposal carries no pattern';
  if (!PROPOSABLE_PATTERNS.includes(pattern.kind)) return 'proposal pattern kind may not be proposed';
  if (pattern.definition !== PATTERN_DEFINITIONS[pattern.kind]) return 'proposal pattern definition is not the recorded definition';
  if (!Number.isInteger(pattern.observations) || pattern.observations < 2) return 'proposal pattern must state at least two observations';
  if (!Number.isInteger(pattern.successes) || pattern.successes < 0) return 'proposal pattern success count is invalid';
  if (!Number.isInteger(pattern.failures) || pattern.failures < 0) return 'proposal pattern failure count is invalid';
  if (pattern.successes + pattern.failures > pattern.observations) {
    return 'proposal pattern counts exceed its observations';
  }
  if (!Number.isInteger(pattern.supporting) || pattern.supporting < 1) return 'proposal pattern must cite supporting evidence';
  if (!Number.isInteger(pattern.contradicting) || pattern.contradicting < 0) return 'proposal pattern contradicting count is invalid';
  if (pattern.objectiveKey !== null && (typeof pattern.objectiveKey !== 'string' || !/^[0-9a-f]{16}$/.test(pattern.objectiveKey))) {
    return 'proposal pattern objective key is invalid';
  }
  if (p.objectiveKey !== pattern.objectiveKey) return 'proposal objective key disagrees with its pattern';
  const guidance = p.guidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) return 'proposal carries no guidance shape';
  if (guidance.order !== null && !GUIDANCE_ORDERS.includes(guidance.order)) return 'proposal names an unknown step order';
  if (guidance.maxSteps !== null && (!Number.isInteger(guidance.maxSteps) || guidance.maxSteps < 1)) return 'proposal names an invalid step bound';
  for (const name of ['avoid', 'prefer']) {
    const list = guidance[name];
    if (!Array.isArray(list) || list.length > 1) return `proposal ${name} must name at most one capability`;
    if (list.some((item) => typeof item !== 'string' || !CAPABILITY_RE.test(item))) return `proposal ${name} holds a name that is not a capability name`;
  }
  if (guidance.avoid.length > 0 && guidance.prefer.length > 0) return 'proposal may not both avoid and prefer a capability';
  const names = [...guidance.avoid, ...guidance.prefer];
  if (pattern.kind === 'repeated_success' && (guidance.prefer[0] !== record.capability || names.length !== 1)) {
    return 'a repeated-success pattern proposes preferring its own capability and nothing else';
  }
  if (['repeated_failure', 'correction_hotspot', 'inefficient_execution'].includes(pattern.kind)
    && (guidance.avoid[0] !== record.capability || names.length !== 1)) {
    return 'a failure pattern proposes avoiding its own capability and nothing else';
  }
  if (pattern.kind === 'ordering_dependency') {
    const predecessor = pattern.detail?.predecessor;
    if (typeof predecessor !== 'string' || !CAPABILITY_RE.test(predecessor)) return 'an ordering proposal must name its predecessor';
    if (predecessor === record.capability) return 'an ordering proposal names the same capability twice';
    if (guidance.order === null && guidance.prefer[0] !== predecessor) {
      return 'an ordering proposal must state an order or prefer its predecessor';
    }
  }
  const expectedRule = outcomePatternRule({
    kind: pattern.kind,
    capability: record.capability,
    detail: pattern.detail,
    observations: { total: pattern.observations, successes: pattern.successes, failures: pattern.failures },
    contradicting: pattern.contradicting,
  });
  if (!expectedRule) return 'proposal pattern cannot state a rule';
  if (record.rule !== expectedRule) return 'proposal rule text is not the text its recorded pattern states';
  if (!Array.isArray(p.risks) || p.risks.length === 0 || p.risks.length > MAX_RISKS) {
    return `proposal must record between 1 and ${MAX_RISKS} risks`;
  }
  if (p.risks.some((text) => typeof text !== 'string' || text.length === 0 || text.length > MAX_RISK_CHARS)) {
    return 'proposal risk text is invalid';
  }
  if (p.reversibility !== 'reversible') return 'proposal must state that the change is reversible';
  const criteria = p.validationCriteria;
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return 'proposal carries no validation criteria';
  if (criteria.metric !== EXPECTED_METRIC) return 'proposal validation metric is not a recorded outcome count';
  if (!Number.isInteger(criteria.minObservations) || criteria.minObservations < 2) return 'proposal validation must require at least two observations';
  if (!criteria.baseline || typeof criteria.baseline !== 'object') return 'proposal validation carries no baseline';
  if (criteria.baseline.successes !== pattern.successes || criteria.baseline.failures !== pattern.failures
    || criteria.baseline.observations !== pattern.observations) {
    return 'proposal validation baseline disagrees with its pattern counts';
  }
  if (p.requiredAuthorization !== 'user_approval') return 'proposal must require the user\'s own approval';
  if (!p.expectedBenefit || typeof p.expectedBenefit !== 'object') return 'proposal carries no expected benefit';
  if (!p.expectedBenefit.basis || p.expectedBenefit.basis.observations !== pattern.observations) {
    return 'proposal expected benefit disagrees with its pattern counts';
  }
  if (!Array.isArray(p.limitations) || p.limitations.length === 0 || p.limitations.length > MAX_LIMITATIONS) {
    return `proposal must record between 1 and ${MAX_LIMITATIONS} limitations`;
  }
  if (p.limitations.some((text) => typeof text !== 'string' || text.length === 0 || text.length > MAX_LIMITATION_CHARS)) {
    return 'proposal limitation text is invalid';
  }
  if (typeof p.evidenceDigest !== 'string' || p.evidenceDigest.length !== 64) return 'proposal has a missing or invalid evidence digest';
  const expectedDigest = proposalDigest({
    capability: record.capability,
    rule: record.rule,
    kind: pattern.kind,
    objectiveKey: pattern.objectiveKey,
    guidance,
    supportingIds: record.support?.evaluationIds ?? [],
  });
  if (p.evidenceDigest !== expectedDigest) return 'proposal evidence digest does not match the evidence it cites';
  return null;
}
