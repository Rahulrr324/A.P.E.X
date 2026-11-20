// T-30 Package 1 (2026-11-19): canonical Core-state vocabulary and display eligibility.
// The Core is a read-only projection. These definitions name the owner/source for each state;
// they do not create a state store or authorize an action. Listening, Speaking and Dormant have
// no process-owned state source that a live UI can observe, so they are not displayable states.
//
// T-30 P0 (2026-11-19): the vocabulary now lives in core-state-tables.js as data, and the
// resolvers are built by client-contract.js, so the served browser client runs the same
// reduce implementation as the server instead of a copy of its source text. This module
// remains the public facade: every name below was exported here before the change.
import { CLIENT_CONTRACT } from './client-contract.js';
import {
  CORE_REACHABLE_STATES,
  CORE_STATE_DEFINITIONS,
  CORE_STATE_PRECEDENCE,
} from './core-state-tables.js';

export { CORE_REACHABLE_STATES, CORE_STATE_DEFINITIONS, CORE_STATE_PRECEDENCE };

export const resolveCoreState = CLIENT_CONTRACT.resolveCoreState;
export const resolveCoreStateFromOwners = CLIENT_CONTRACT.resolveCoreStateFromOwners;

export const CORE_RESERVED_STATES = Object.freeze(
  CORE_STATE_DEFINITIONS.filter((state) => state.reachability === 'reserved, not reachable').map((state) => state.id),
);

export function isReachableCoreState(state) {
  return CORE_REACHABLE_STATES.includes(state);
}

export function assertReachableCoreState(state) {
  if (!isReachableCoreState(state)) {
    throw new RangeError(`Core state ${String(state)} is reserved or unknown and cannot be set`);
  }
  return state;
}
