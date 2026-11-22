// T-37 Step 2 (2026-11-21): the Values & Constraints Core.
//
// V2-0317 asked for owner-defined values and hard rules evaluated before an action, with the hard
// rules living in policy rather than in a prompt. This is that core, built as data: an ordered list of
// rules, each one a predicate over what a candidate action *declares*, plus the reason it exists.
//
// Three things it deliberately is not:
//
//   1. It is not an authorization. A rule that passes produces no permission; the ECP is the only
//      thing that authorizes and this module never touches it. A rule that fails is reported as a
//      constraint violation in a deliberation, which is advice the owner may read.
//   2. It is not a prompt. Nothing here is sent to a model, and nothing a model says changes a rule.
//      The rules are frozen at load and evaluated over registry declarations and recorded evidence.
//   3. It is not a judgement about the world. Every rule tests a declaration the registry makes or a
//      record a store holds. Where it cannot see a fact it says `unverifiable` rather than assuming
//      the benign case, because "I could not check" and "I checked and it is fine" are different
//      answers and a deliberation must not confuse them.
//
// The owner can add values of their own through the same shape; a value is advisory and a constraint
// is a hard rule, and the two are reported separately so a reader can tell which is which.
import { truncate } from '../util.js';

export const VALUES_CORE_SCHEMA = 'apex.values.constraints/1';
export const CONSTRAINT_VERDICTS = Object.freeze(['satisfied', 'violated', 'unverifiable', 'not_applicable']);

// Hard rules. Each one is a predicate over the declarations a candidate carries. `severity` is what a
// deliberation should do with a violation: `blocking` means the owner should be told plainly that the
// candidate contradicts a rule they set, `caution` means it is worth naming but not decisive.
//
// The predicates read only what the registry already declares. None of them reaches a store, a
// network, a model or the ECP, so evaluating the core cannot itself have an effect.
// T-38 Step 1 (2026-11-21): what to say when there is no candidate. The resolver records why it found
// nothing, and a rule that cannot be checked should name that reason: `no_mapped_capability` means the
// sentence named nothing registered, which is the honesty rule working rather than a gap, while an
// absent declaration means the registry itself is missing a fact.
function missingDeclaration(resolution, tail = '') {
  if (resolution && resolution.reason === 'no_mapped_capability') {
    return {
      verdict: 'unverifiable',
      detail: 'no_mapped_capability - the objective names no registered capability, so there is no declaration to read'
        + (tail ? `, ${tail.replace(/^so /, 'so ')}` : ''),
    };
  }
  return { verdict: 'unverifiable', detail: `no registry declaration was supplied${tail ? `, ${tail}` : ''}` };
}

export const CONSTRAINTS = Object.freeze([
  {
    id: 'no-model-authored-write',
    name: 'A model may not author a write',
    severity: 'blocking',
    value: 'The owner is the only author of a change to APEX’s stores',
    because: 'AF-20: a reply never authorizes itself. A candidate that a model origin could execute '
      + 'would let the model manufacture the permission it is then asked about.',
    evaluate({ definition, resolution }) {
      if (!definition) return missingDeclaration(resolution, 'so the origins cannot be read');
      if (definition.permission !== 'write') return { verdict: 'not_applicable', detail: 'the candidate is a read; it writes nothing' };
      const origins = Array.isArray(definition.origins) ? definition.origins : [];
      if (origins.includes('model')) {
        return { verdict: 'violated', detail: `"${truncate(definition.name, 60)}" is a write that permits a model origin` };
      }
      return { verdict: 'satisfied', detail: `"${truncate(definition.name, 60)}" is a write restricted to ${origins.join(', ')}` };
    },
  },
  {
    id: 'no-unplannable-in-a-plan',
    name: 'A plan may only contain plannable steps',
    severity: 'blocking',
    value: 'A plan is a proposal the owner can read before anything runs',
    because: 'An unplannable capability is one whose effect is not a step in a world model - a '
      + 'simulation step, a lockdown, a release. Putting one in a plan would record it as work.',
    evaluate({ definition, resolution, inPlan }) {
      if (!definition) return missingDeclaration(resolution);
      if (inPlan !== true) return { verdict: 'not_applicable', detail: 'the candidate is not being proposed as a plan step' };
      if (definition.plannable === false) {
        return { verdict: 'violated', detail: `"${truncate(definition.name, 60)}" is declared unplannable and was proposed as a plan step` };
      }
      return { verdict: 'satisfied', detail: `"${truncate(definition.name, 60)}" is plannable` };
    },
  },
  {
    id: 'irreversible-needs-the-owner',
    name: 'An irreversible candidate is owner-only',
    severity: 'blocking',
    value: 'Nothing irreversible happens without the owner asking for it',
    because: 'A reversible step can be undone by reading the record of it. An irreversible one cannot, '
      + 'so the same autonomy that is appropriate elsewhere is not appropriate here.',
    evaluate({ definition, resolution }) {
      if (!definition) return missingDeclaration(resolution);
      const reversibility = definition.reversibility ?? definition.reversible;
      if (reversibility === undefined || reversibility === null) {
        return { verdict: 'unverifiable', detail: `"${truncate(definition.name, 60)}" declares no reversibility, so it cannot be read as safe` };
      }
      const reversible = reversibility === true || reversibility === 'reversible';
      if (reversible) return { verdict: 'satisfied', detail: `"${truncate(definition.name, 60)}" is declared reversible` };
      const origins = Array.isArray(definition.origins) ? definition.origins : [];
      if (origins.includes('model')) {
        return { verdict: 'violated', detail: `"${truncate(definition.name, 60)}" is irreversible and permits a model origin` };
      }
      return { verdict: 'satisfied', detail: `"${truncate(definition.name, 60)}" is irreversible and owner-only` };
    },
  },
  {
    id: 'evidence-before-inference',
    name: 'A claim about the world cites a record',
    severity: 'caution',
    value: 'APEX says where a belief came from',
    because: 'A conclusion drawn from nothing is indistinguishable from a guess that happens to be '
      + 'right. The label matters more than the confidence attached to it.',
    evaluate({ evidence }) {
      if (!Array.isArray(evidence)) return { verdict: 'unverifiable', detail: 'no evidence list was supplied' };
      if (evidence.length === 0) {
        return { verdict: 'violated', detail: 'the candidate cites no record at all' };
      }
      const uncited = evidence.filter((item) => !item || typeof item.evidenceId !== 'string' || item.evidenceId.length === 0);
      if (uncited.length > 0) {
        return { verdict: 'violated', detail: `${uncited.length} of ${evidence.length} cited item(s) name no record` };
      }
      const stale = evidence.filter((item) => item.current === false);
      return {
        verdict: 'satisfied',
        detail: `${evidence.length} cited item(s) each name a record`
          + (stale.length > 0 ? `; ${stale.length} is historical rather than current` : ''),
      };
    },
  },
  {
    id: 'no-candidate-as-permission',
    name: 'A candidate association is never a permission',
    severity: 'blocking',
    value: 'Track 2 may suggest; it may not decide',
    because: 'A spiking substrate produces associations that are useful precisely because they are '
      + 'not claims. Treating one as authorization would be the exact confusion the bridge exists to '
      + 'prevent.',
    evaluate({ claims }) {
      if (!claims || typeof claims !== 'object') return { verdict: 'not_applicable', detail: 'the candidate makes no claims about its own authority' };
      if (claims.authorizesExecution === true) {
        return { verdict: 'violated', detail: 'the candidate claims "authorizesExecution"; authority belongs to the ECP alone' };
      }
      if (claims.mutatesObservedFacts === true) {
        return { verdict: 'violated', detail: 'the candidate claims to write an observed fact' };
      }
      return { verdict: 'satisfied', detail: 'the candidate claims no authority' };
    },
  },
  {
    id: 'lockdown-fails-closed',
    name: 'An engaged latch is never worked around',
    severity: 'blocking',
    value: 'When the owner latches lockdown, the system stops',
    because: 'A latch that a deliberation could argue past would not be a latch. This rule reports the '
      + 'latch as a violation of the candidate rather than of the latch.',
    evaluate({ latch }) {
      if (!latch || typeof latch !== 'object') return { verdict: 'unverifiable', detail: 'the safety latch was not supplied' };
      if (latch.active === true) {
        return { verdict: 'violated', detail: 'the executive control plane has the lockdown latch engaged' };
      }
      if (latch.policyUnavailable === true) {
        return { verdict: 'unverifiable', detail: 'the authorization policy could not be read, so the latch state is unknown' };
      }
      return { verdict: 'satisfied', detail: 'no lockdown latch is engaged' };
    },
  },
]);

// Advisory values. These are not rules; nothing is violated by disagreeing with one. They exist so the
// owner can state what APEX is for and have a deliberation quote it back to them.
export const VALUES = Object.freeze([
  {
    id: 'epistemic-honesty',
    name: 'Say what is known and what is not',
    statement: 'An unavailable reading is reported as unavailable. A zero is never shown in place of a '
      + 'value that could not be measured.',
  },
  {
    id: 'owner-sovereignty',
    name: 'The owner decides',
    statement: 'APEX proposes, records and explains. It does not authorize itself, and it does not '
      + 'release its own latch.',
  },
  {
    id: 'reversibility-first',
    name: 'Prefer what can be undone',
    statement: 'Where two candidates serve the same objective, the reversible one is the better '
      + 'default, because the record of it can be read and the effect of it can be withdrawn.',
  },
  {
    id: 'no-inference-in-the-core',
    name: 'No model decides anything here',
    statement: 'Every perspective, every constraint and every recommendation in this core is computed '
      + 'deterministically from records. No model is contacted to reach them.',
  },
]);

export const CORE = Object.freeze({
  schema: VALUES_CORE_SCHEMA,
  constraints: CONSTRAINTS,
  values: VALUES,
  // Stated as data so a caller can check it rather than take it on trust.
  authorizesExecution: false,
  mutatesObservedFacts: false,
  requiresInference: false,
});

// Evaluate every hard rule against a candidate. The result is what a Council perspective shows: which
// rules the candidate satisfies, which it violates, and which could not be checked.
export function evaluateConstraints(input = {}) {
  // The instant is supplied by the caller. Reading the wall clock here would make a deliberation
  // unreplayable: `council.replay` recomputes from the recorded input and compares, so a timestamp
  // taken at evaluation time would differ on every replay and the comparison would fail.
  const at = typeof input.at === 'string' ? input.at : null;
  const evaluations = CONSTRAINTS.map((constraint) => {
    let outcome;
    try {
      outcome = constraint.evaluate(input);
    } catch (err) {
      // A rule that threw has not been satisfied; it has failed to be evaluated, which is different
      // from both. Saying so is the honest answer.
      outcome = { verdict: 'unverifiable', detail: `the rule could not be evaluated: ${truncate(String(err?.message ?? err), 160)}` };
    }
    const verdict = CONSTRAINT_VERDICTS.includes(outcome?.verdict) ? outcome.verdict : 'unverifiable';
    return {
      id: constraint.id,
      name: constraint.name,
      severity: constraint.severity,
      value: constraint.value,
      because: constraint.because,
      verdict,
      detail: truncate(outcome?.detail ?? '', 240),
    };
  });

  const count = (verdict) => evaluations.filter((entry) => entry.verdict === verdict).length;
  const blocking = evaluations.filter((entry) => entry.verdict === 'violated' && entry.severity === 'blocking');
  const caution = evaluations.filter((entry) => entry.verdict === 'violated' && entry.severity !== 'blocking');
  const unverifiable = evaluations.filter((entry) => entry.verdict === 'unverifiable');

  // The overall verdict is the worst one, and `unverifiable` is deliberately worse than `satisfied`:
  // a rule that could not be checked has not passed.
  let overall = 'satisfied';
  if (blocking.length > 0) overall = 'violated';
  else if (caution.length > 0) overall = 'caution';
  else if (unverifiable.length > 0) overall = 'partly_unverifiable';

  return {
    schema: 'apex.values.constraint-evaluation/1',
    at,
    overall,
    counts: {
      satisfied: count('satisfied'),
      violated: count('violated'),
      unverifiable: count('unverifiable'),
      not_applicable: count('not_applicable'),
    },
    blocking: blocking.map((entry) => entry.id),
    caution: caution.map((entry) => entry.id),
    unverifiable: unverifiable.map((entry) => entry.id),
    evaluations,
    // A constraint evaluation is advice about a candidate, not a permission for one.
    authorizesExecution: false,
  };
}

// The perspective this core contributes to a Council deliberation. It is shaped exactly like the
// seven engineering perspectives so the Council can carry it without special-casing, and the Council
// service decides whether to include it.
export function constraintPerspective(input = {}) {
  const evaluation = evaluateConstraints(input);
  const violated = evaluation.evaluations.filter((entry) => entry.verdict === 'violated');
  const summary = evaluation.overall === 'violated'
    ? `The candidate contradicts ${violated.length} hard rule(s): ${violated.map((entry) => entry.name).join('; ')}.`
    : evaluation.overall === 'caution'
      ? `The candidate satisfies every blocking rule but raises ${evaluation.caution.length} caution(s).`
      : evaluation.overall === 'partly_unverifiable'
        ? `No rule is violated, but ${evaluation.unverifiable.length} could not be checked against the records available.`
        : `The candidate satisfies all ${evaluation.counts.satisfied + evaluation.counts.not_applicable} applicable rule(s).`;

  return {
    perspectiveId: 'constraint_check',
    perspectiveName: 'Constraint check (Values & Constraints Core)',
    status: 'evaluated',
    position: {
      verdict: evaluation.overall,
      summary: truncate(summary, 300),
      // The evidence is the rules themselves: each one cites the value it protects and the reason it
      // exists, so the owner can disagree with a rule rather than with an opinion about one.
      evidence: evaluation.evaluations
        .filter((entry) => entry.verdict !== 'not_applicable')
        .slice(0, 6)
        .map((entry) => ({
          kind: 'constraint',
          detail: truncate(`${entry.name} — ${entry.verdict}: ${entry.detail}`, 200),
        })),
      uncertainty: evaluation.counts.unverifiable > 0 ? 'some' : 'low',
    },
    evaluation,
    // T-38 Step 2 (2026-11-21): the declaration the core actually read. Without it a session record
    // says what was concluded but not what it was concluded against, and a later reader cannot tell
    // a rule that passed from a rule that had nothing to check. `null` means the capability had no
    // declaration; every field is the registry's own value, never a value inferred here.
    declaration: input.definition
      ? {
        capability: input.definition.name ?? null,
        permission: input.definition.permission ?? null,
        origins: Array.isArray(input.definition.origins) ? [...input.definition.origins] : [],
        plannable: input.definition.plannable !== false,
        reversibility: input.definition.reversibility ?? null,
        blastRadius: input.definition.blastRadius ?? null,
        metadataSource: input.definition.metadataSource ?? null,
      }
      : null,
    values: VALUES,
  };
}
