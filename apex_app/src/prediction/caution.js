// Expectation cautions: what a recorded contradicted verdict says about work APEX has not run yet.
//
// Batch AE recorded what the user expected and what happened. Batch AL/AM read those records and
// disclosed them beside a comparison. Batch AP let an approved adaptation re-order approaches. What no
// component did was let one recorded verdict change one later decision - the open clause of the
// roadmap's stage 6. This module builds the smallest honest form of that: a *caution*, derived only
// from a contradicted evaluation that is live, current, and backed by evidence a fresh read could
// confirm right now. The continuation ranking uses it to change the *recommended next act* for an
// approved plan from `plan start` to a read; nothing else consumes it.
//
// Four separations bound what a caution may claim, and each is enforced structurally:
//
//  1 a caution is never a permission. It is derived here and read by a ranking that starts nothing;
//     every command it produces is a read, and the plan stays approved and startable.
//  2 a caution is never a gate. `ready`, the readiness state, the plan's validation, its approval
//     binding and the registry's authorization are untouched. A contradicted expectation can be a
//     reason to look again; it is not a reason the records say the work cannot run.
//  3 a caution is never a fact about the world. It repeats one recorded verdict and the record it
//     rests on. It does not become an observation, an experience, or a memory.
//  4 a caution is withdrawn the moment it stops being current. A stale verdict, an evaluation the
//     experience log can no longer confirm, a withdrawn or superseded expectation, and a log that
//     could not be read are all reported as withheld rather than softened into "no caution".
//
// The module performs no I/O. The store hands it projections that were already derived, so there is
// exactly one lifecycle derivation in APEX and this read cannot disagree with `prediction list`.
import { shortId } from '../util.js';

export const EXPECTATION_CAUTION_SCHEMA = 1;

// How much of the ledger one answer reads and prints. The scope is bounded before any horizon is
// opened, so a store with thousands of expectations costs the same as one with a handful of matches.
export const MAX_EXPECTATION_CAUTIONS = 3;
export const MAX_CAUTION_CAPABILITIES = 8;
export const MAX_CAUTION_WITHHELD = 4;

// What the read is, stated once, printed with every row so an answer cannot describe itself more
// strongly than its rule.
export const EXPECTATION_CAUTION_RULE = 'a caution is a recorded contradicted verdict that is still live and '
  + 'still confirmed by a fresh read of the evidence, for a capability the work would run. It changes only '
  + 'the next act the ranking recommends, and it grants no permission, gate, or authority.';

// Printed beside a candidate whose recommendation a caution moved. The plan is still approved; the
// caution is a disclosure, and the act is a read the user runs.
export const CAUTION_NOTE = 'The plan remains approved and startable, and no readiness state, gate, or authorization changed. '
  + 'The caution changed what is recommended next, not what is permitted.';

// One reason a projection is not a caution. Kept as data, not prose collapsed into an empty list, so
// "nothing contradicted" and "the log could not be read" never read the same.
function withheld(projection, reason) {
  return {
    id: projection?.id ?? null,
    capability: projection?.capability ?? null,
    status: projection?.status ?? null,
    verdict: projection?.evaluation?.verdict ?? null,
    reason,
  };
}

// Whether a projection is a caution right now. The checks run in the order the lifecycle resolves,
// and each refusal names the record it looked at.
//
// `counts` is the evidence the projection actually read inside the horizon. It is null only when the
// experience log could not be opened or was not opened for this record, which is precisely the state
// in which `evaluationStale` is false for lack of a comparison rather than because the verdict holds.
// Requiring it keeps an unreadable log from being reported as an unchanged verdict.
export function cautionOf(projection) {
  if (!projection) return { caution: null, withheld: null };
  const verdict = projection.evaluation?.verdict ?? null;
  if (projection.status === 'invalidated') {
    return { caution: null, withheld: withheld(projection, 'the user withdrew this expectation, so it is not scored') };
  }
  if (projection.status === 'superseded' || projection.retired === true) {
    return { caution: null, withheld: withheld(projection, 'a later expectation replaced it, so its verdict is history rather than guidance') };
  }
  if (projection.status !== 'evaluated' || verdict === null) {
    return {
      caution: null,
      withheld: withheld(projection, `no recorded verdict exists to act on (the read reports \`${projection.status ?? 'unknown'}\`)`),
    };
  }
  if (verdict !== 'contradicted') {
    return { caution: null, withheld: withheld(projection, `the recorded verdict is \`${verdict}\`, which is not a caution`) };
  }
  if (projection.evaluationStale === true) {
    return {
      caution: null,
      withheld: withheld(projection, `the recorded verdict no longer stands: ${projection.staleReason ?? 'a fresh read disagrees with it'}`),
    };
  }
  if (projection.counts === null || projection.counts === undefined) {
    return {
      caution: null,
      withheld: withheld(projection, 'the experience log could not be read, so the recorded verdict cannot be confirmed now'),
    };
  }
  return {
    withheld: null,
    caution: {
      schema: EXPECTATION_CAUTION_SCHEMA,
      id: projection.id,
      capability: projection.capability,
      expectation: projection.expectation,
      verdict,
      evaluationId: projection.evaluation.id ?? null,
      decidedAt: projection.evaluation.createdAt ?? null,
      decidingExperienceId: projection.evaluation.decidingExperienceId ?? null,
      outcomeExperienceIds: [...(projection.evaluation.outcomeExperienceIds ?? [])],
      window: projection.evaluation.window
        ? { since: projection.evaluation.window.since, until: projection.evaluation.window.until }
        : { since: projection.createdAt, until: projection.expiresAt },
      predictionCreatedAt: projection.createdAt,
      expiresAt: projection.expiresAt,
      rule: EXPECTATION_CAUTION_RULE,
    },
  };
}

// The whole read over projections the store already derived. `considered` counts the in-scope live
// expectations that carry a verdict, which is the denominator a reader needs to tell "none
// contradicted" from "none evaluated".
export function deriveExpectationCautions({ projections = [], limit = MAX_EXPECTATION_CAUTIONS } = {}) {
  const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_EXPECTATION_CAUTIONS) : MAX_EXPECTATION_CAUTIONS;
  const cautions = [];
  const withheldRows = [];
  let considered = 0;
  for (const projection of projections) {
    if (!projection || projection.retired === true) continue;
    if (projection.evaluation?.verdict) considered += 1;
    const { caution, withheld: why } = cautionOf(projection);
    if (caution) cautions.push(caution);
    else if (why) withheldRows.push(why);
  }
  return {
    cautions: cautions.slice(0, size),
    withheld: withheldRows.slice(0, MAX_CAUTION_WITHHELD),
    considered,
    truncated: cautions.length > size || withheldRows.length > MAX_CAUTION_WITHHELD,
    rule: EXPECTATION_CAUTION_RULE,
  };
}

// One caution as a single line, with the prediction and evaluation it was read from. The caller
// prefixes it; the record ids are what make the line checkable.
export function cautionLine(caution) {
  if (!caution) return null;
  const decided = caution.decidedAt ?? 'an unrecorded time';
  const evidence = caution.decidingExperienceId
    ? `experience ${shortId(caution.decidingExperienceId)}`
    : `evaluation ${shortId(caution.evaluationId ?? '')}`;
  return `prediction ${shortId(caution.id)} expected ${caution.capability} to end in ${caution.expectation}, `
    + `and the evaluation at ${decided} (${evidence}) recorded \`contradicted\``;
}
