// Action registry and authorization policy.
//
// Policy (enforced here, not by the model):
//  - an action runs only if it is registered and the request origin is listed
//    in the action's `origins`;
//  - `write` actions are only ever offered to the 'user' origin. The model can
//    propose an action, but a proposal is never authorization by itself.
import { ORIGINS_LIST } from './origins.js';

export const PERMISSIONS = Object.freeze(['read', 'write']);
const NAME_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

function deny(reason) {
  return { decision: 'deny', reason };
}

export function validateDefinition(def) {
  if (!def || typeof def !== 'object') throw new TypeError('action definition must be an object');
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) throw new TypeError(`invalid action name: ${String(def.name)}`);
  if (typeof def.description !== 'string' || def.description.length === 0) throw new TypeError(`${def.name}: description required`);
  if (!PERMISSIONS.includes(def.permission)) throw new TypeError(`${def.name}: permission must be read or write`);
  if (!Array.isArray(def.origins) || def.origins.length === 0 || def.origins.some((o) => !ORIGINS_LIST.includes(o))) {
    throw new TypeError(`${def.name}: origins must be a non-empty list of user/model`);
  }
  if (def.permission === 'write' && def.origins.includes('model')) {
    throw new TypeError(`${def.name}: write actions may not be offered to the model origin`);
  }
  if (typeof def.validate !== 'function') throw new TypeError(`${def.name}: validate() required`);
  if (typeof def.execute !== 'function') throw new TypeError(`${def.name}: execute() required`);
  if (def.verify !== undefined && def.verify !== null && typeof def.verify !== 'function') {
    throw new TypeError(`${def.name}: verify must be a function or null`);
  }
}

export class ActionRegistry {
  #actions = new Map();

  register(def) {
    validateDefinition(def);
    if (this.#actions.has(def.name)) throw new Error(`duplicate action: ${def.name}`);
    this.#actions.set(def.name, Object.freeze({
      ...def,
      origins: Object.freeze([...def.origins]),
      verify: def.verify ?? null,
    }));
    return this;
  }

  get(name) {
    return typeof name === 'string' ? (this.#actions.get(name) ?? null) : null;
  }

  names() {
    return [...this.#actions.keys()].sort();
  }

  list() {
    return [...this.#actions.values()];
  }

  authorize(name, origin) {
    if (!ORIGINS_LIST.includes(origin)) return deny('UNKNOWN_ORIGIN');
    const def = this.get(name);
    if (!def) return deny('UNKNOWN_ACTION');
    if (!def.origins.includes(origin)) return deny('ORIGIN_NOT_PERMITTED');
    if (def.permission === 'write' && origin !== 'user') return deny('WRITE_REQUIRES_USER_APPROVAL');
    return { decision: 'allow', reason: 'PERMITTED' };
  }
}
