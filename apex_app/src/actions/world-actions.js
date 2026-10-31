// Read-only world-state action. It exposes the epistemic projection to a user request
// (including a natural-language question routed here) without adding a write path.
// It is deliberately not offered to the model origin: the projection can include private
// memory content, and a model may not ask the system to read that back.
import { ValidationError } from '../errors.js';
import { ORIGIN_USER } from './origins.js';
import { buildWorldState, renderWorldState, MAX_WORLD_LIMIT, MAX_WORLD_CONFLICT_MEMBERS } from '../world/world-state.js';

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
  }
  return input;
}

// The audit keeps counts and ids, never a belief statement or memory content.
function auditShape(world) {
  return {
    schema: world.schema,
    complete: world.complete,
    attention: world.attention,
    counts: world.counts,
    history: world.history,
    beliefIds: world.beliefs.userAsserted.concat(world.beliefs.unverifiedModel).map((belief) => belief.id),
    // A heuristic memory group can hold every record in the window, so the audit keeps the
    // first members and the group size instead of an unbounded id list.
    contradictions: world.contradictions.map((group) => ({
      kind: group.kind,
      state: group.state,
      claimIds: group.claimIds.slice(0, MAX_WORLD_CONFLICT_MEMBERS),
      memberCount: group.claimIds.length,
    })),
    unknownCount: world.unknowns.length,
    limits: world.limits.length,
  };
}

export function worldActions() {
  return [
    {
      name: 'world.state',
      description: 'Read-only projection of stored beliefs: provenance, contradictions, recorded decisions, and unknowns. Writes nothing and calls no model.',
      inputHint: '{"limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        if (o.limit === undefined) return { limit: undefined };
        if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > MAX_WORLD_LIMIT) {
          throw new ValidationError(`limit must be an integer from 1 to ${MAX_WORLD_LIMIT}`);
        }
        return { limit: o.limit };
      },
      async execute(ctx, { limit }) {
        const world = await buildWorldState({ memory: ctx.memory, knowledge: ctx.knowledge, now: ctx.now, limit });
        return {
          summary: `world state: ${world.counts.userAsserted} user-asserted belief(s), ${world.counts.unverifiedModel} unverified model conclusion(s), ${world.counts.unresolvedConflicts} unresolved knowledge conflict group(s), ${world.counts.memoryConflictGroups} memory subject group(s) with differing values`,
          data: auditShape(world),
          display: renderWorldState(world),
        };
      },
      async verify(ctx, { limit }, result) {
        const fresh = await buildWorldState({ memory: ctx.memory, knowledge: ctx.knowledge, now: ctx.now, limit });
        const expected = auditShape(fresh);
        if (JSON.stringify(expected) !== JSON.stringify(result.data)) {
          return { ok: false, detail: 'a second read produced a different world-state projection; the stores may have changed during the read' };
        }
        return { ok: true, detail: 'counts and record ids confirmed by an independent read' };
      },
    },
  ];
}
