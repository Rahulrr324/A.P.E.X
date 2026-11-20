// Action registry and authorization policy.
//
// Policy (enforced here, not by the model):
//  - an action runs only if it is registered and the request origin is listed
//    in the action's `origins`;
//  - `write` actions are only ever offered to the 'user' origin. The model can
//    propose an action, but a proposal is never authorization by itself.
import { ORIGINS_LIST } from './origins.js';
import { ExecutiveControlPlane } from '../executive/control-plane.js';

export const PERMISSIONS = Object.freeze(['read', 'write']);
// One grammar for action names, shared with the proposal parser so that text which
// cannot name a registered action is refused as malformed before it is quoted anywhere.
export const ACTION_NAME_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/;

function deny(reason) {
  return { decision: 'deny', reason };
}

export function validateDefinition(def) {
  if (!def || typeof def !== 'object') throw new TypeError('action definition must be an object');
  if (typeof def.name !== 'string' || !ACTION_NAME_RE.test(def.name)) throw new TypeError(`invalid action name: ${String(def.name)}`);
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
  if (def.domain !== undefined && (typeof def.domain !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(def.domain))) {
    throw new TypeError(`${def.name}: domain must be a lowercase identifier`);
  }
  if (def.maxAutonomy !== undefined && (!Number.isInteger(def.maxAutonomy) || def.maxAutonomy < 0 || def.maxAutonomy > 5)) {
    throw new TypeError(`${def.name}: maxAutonomy must be an integer from 0 to 5`);
  }
  if (def.resourceScope !== undefined && def.resourceScope !== null
    && (typeof def.resourceScope !== 'string' || def.resourceScope.length === 0 || def.resourceScope.length > 240)) {
    throw new TypeError(`${def.name}: resourceScope must be bounded text`);
  }
  if (def.resourceDemand !== undefined && def.resourceDemand !== null) {
    const fields = new Set(['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes']);
    const entries = Object.entries(def.resourceDemand);
    if (!def.resourceDemand || typeof def.resourceDemand !== 'object' || Array.isArray(def.resourceDemand)
      || entries.length === 0 || entries.some(([key, value]) => !fields.has(key) || !Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError(`${def.name}: resourceDemand must be a finite non-negative resource map`);
    }
  }
  if (def.delegable !== undefined && typeof def.delegable !== 'boolean') {
    throw new TypeError(`${def.name}: delegable must be boolean`);
  }
  if (def.risk !== undefined && !['low', 'medium', 'high'].includes(def.risk)) {
    throw new TypeError(`${def.name}: risk must be low, medium, or high`);
  }
  if (def.permission === 'write' && def.origins.includes('agent')
    && (def.delegable !== true || !def.resourceScope || !def.resourceDemand || !Number.isInteger(def.maxAutonomy) || def.maxAutonomy < 3 || !def.risk)) {
    throw new TypeError(`${def.name}: agent writes require delegable=true, an exact resource scope, finite resourceDemand, maxAutonomy >= 3, and a risk classification`);
  }
}

export class ActionRegistry {
  #actions = new Map();
  #controlPlane;

  constructor({ autonomyByDomain = {}, now, idFactory, killSwitchPath = null, stepUpSecret = null } = {}) {
    this.#controlPlane = new ExecutiveControlPlane({
      capabilityLookup: (name) => this.get(name),
      autonomyByDomain,
      ...(now ? { now } : {}),
      ...(idFactory ? { idFactory } : {}),
      ...(killSwitchPath ? { killSwitchPath } : {}),
      ...(stepUpSecret ? { stepUpSecret } : {}),
    });
  }

  get controlPlane() { return this.#controlPlane; }

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

  authorize(name, origin, context = {}) {
    if (!ORIGINS_LIST.includes(origin)) return deny('UNKNOWN_ORIGIN');
    const result = this.#controlPlane.evaluate(name, origin, context);
    return { decision: result.decision, reason: result.reason };
  }
}
