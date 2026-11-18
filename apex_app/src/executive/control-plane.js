// The Executive Control Plane (ECP) owns authorization decisions. ActionRegistry remains the
// capability declaration source and keeps its compatibility API, but delegates every decision here.
// This first T-17 boundary supports explicit user actions and bounded in-process delegation grants;
// it does not claim owner MFA, persistent policy storage, or a connected agent runtime.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../security/secrets.js';

export const ECP_SCHEMA = 'apex.ecp.permission/1';
export const AUTONOMY_LEVELS = Object.freeze([
  Object.freeze({ level: 0, name: 'Observe' }),
  Object.freeze({ level: 1, name: 'Suggest' }),
  Object.freeze({ level: 2, name: 'Confirm' }),
  Object.freeze({ level: 3, name: 'Delegate (bounded)' }),
  Object.freeze({ level: 4, name: 'Mission' }),
  Object.freeze({ level: 5, name: 'Standing orders' }),
]);

const RESOURCE_FIELDS = Object.freeze(['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes']);
const LOW_RISK = new Set(['low']);
const CONTROL_REASON = Object.freeze({
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  UNKNOWN_ORIGIN: 'UNKNOWN_ORIGIN',
  ORIGIN_NOT_PERMITTED: 'ORIGIN_NOT_PERMITTED',
  WRITE_REQUIRES_USER_APPROVAL: 'WRITE_REQUIRES_USER_APPROVAL',
  AUTONOMY_LEVEL_BLOCKS_WRITE: 'AUTONOMY_LEVEL_BLOCKS_WRITE',
  AUTONOMY_LEVEL_EXCEEDS_CAPABILITY: 'AUTONOMY_LEVEL_EXCEEDS_CAPABILITY',
  DELEGATION_REQUIRED: 'DELEGATION_REQUIRED',
  DELEGATION_INVALID: 'DELEGATION_INVALID',
  DELEGATION_EXPIRED: 'DELEGATION_EXPIRED',
  DELEGATION_REVOKED: 'DELEGATION_REVOKED',
  DELEGATION_SCOPE_MISMATCH: 'DELEGATION_SCOPE_MISMATCH',
  DELEGATION_BUDGET_EXHAUSTED: 'DELEGATION_BUDGET_EXHAUSTED',
  MISSION_CHECKPOINT_REQUIRED: 'MISSION_CHECKPOINT_REQUIRED',
  STANDING_ORDER_RESTRICTED: 'STANDING_ORDER_RESTRICTED',
  KILL_SWITCH_ACTIVE: 'KILL_SWITCH_ACTIVE',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
});

function deny(reason, permission = null) {
  return { decision: 'deny', reason, permission };
}

function validBudget(value, { allowZero = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !RESOURCE_FIELDS.includes(key))) return false;
  return keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= (allowZero ? 0 : 1));
}

function cloneBudget(value) {
  return value ? Object.fromEntries(RESOURCE_FIELDS.map((key) => [key, value[key] ?? 0])) : null;
}

function budgetFits(requested, remaining) {
  if (!requested) return true;
  if (!remaining) return false;
  return RESOURCE_FIELDS.every((key) => (requested[key] ?? 0) <= (remaining[key] ?? 0));
}

function subtractBudget(remaining, requested) {
  if (!requested) return;
  for (const key of RESOURCE_FIELDS) remaining[key] = (remaining[key] ?? 0) - (requested[key] ?? 0);
}

function isoTime(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function autonomyLevel(value, name = 'autonomy level') {
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new TypeError(`${name} must be an integer from 0 to 5`);
  return value;
}

function normalizedContext(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  return context;
}

export class ExecutiveControlPlane {
  #lookup;
  #now;
  #idFactory;
  #levels;
  #killSwitchPath;
  #grants = new Map();
  #killSwitch = { active: false, activatedAt: null, reason: null, history: [] };
  #cancellables = new Map();

  constructor({ capabilityLookup, autonomyByDomain = {}, now = () => new Date(), idFactory = randomUUID, killSwitchPath = null } = {}) {
    if (typeof capabilityLookup !== 'function') throw new TypeError('ECP requires the capability registry lookup');
    if (!autonomyByDomain || typeof autonomyByDomain !== 'object' || Array.isArray(autonomyByDomain)) {
      throw new TypeError('autonomyByDomain must be an object');
    }
    this.#lookup = capabilityLookup;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#killSwitchPath = typeof killSwitchPath === 'string' && killSwitchPath.length > 0 ? path.resolve(killSwitchPath) : null;
    this.#levels = new Map();
    for (const [domain, level] of Object.entries(autonomyByDomain)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(domain)) throw new TypeError(`invalid autonomy domain: ${domain}`);
      this.#levels.set(domain, autonomyLevel(level, `autonomyByDomain.${domain}`));
    }
    this.#refreshKillSwitch();
  }

  #killPayload(state) {
    return {
      schema: 'apex.kill-switch/1',
      active: state.active === true,
      updatedAt: state.updatedAt ?? null,
      reason: state.reason ?? null,
      events: (state.events ?? []).slice(-100),
    };
  }

  #writeKillSwitch(state) {
    if (!this.#killSwitchPath) {
      this.#killSwitch = { ...state, policyUnavailable: false };
      return;
    }
    const directory = path.dirname(this.#killSwitchPath);
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = `${this.#killSwitchPath}.lock`;
    let lock;
    try {
      lock = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      const busy = new Error(`kill-switch state is locked: ${error?.code ?? 'unknown error'}`);
      busy.code = 'ECP_STATE_LOCKED';
      throw busy;
    }
    const temporary = `${this.#killSwitchPath}.${this.#idFactory()}.tmp`;
    try {
      const current = this.#readKillSwitchFile(true);
      if (current.policyUnavailable && state.active !== false) {
        throw new Error('kill-switch state is damaged; an explicit owner clear is required');
      }
      const payload = this.#killPayload(state);
      const record = {
        ...payload,
        digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      };
      fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.#killSwitchPath);
      this.#killSwitch = { ...payload, policyUnavailable: false };
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the control decision */ }
      try { fs.closeSync(lock); } catch { /* lock cleanup remains best-effort */ }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* an orphan lock fails closed on the next read */ }
    }
  }

  #readKillSwitchFile(ignoreLock = false) {
    if (!this.#killSwitchPath) return { active: false, updatedAt: null, reason: null, events: [], policyUnavailable: false };
    try {
      if (!ignoreLock && fs.existsSync(`${this.#killSwitchPath}.lock`)) {
        return { active: true, updatedAt: null, reason: 'control state is being updated', events: [], policyUnavailable: true };
      }
      const stat = fs.statSync(this.#killSwitchPath);
      if (stat.size > 64 * 1024) throw new Error('kill-switch record exceeds its size bound');
      const record = JSON.parse(fs.readFileSync(this.#killSwitchPath, 'utf8'));
      const payload = this.#killPayload(record);
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (record.schema !== payload.schema || record.digest !== digest || typeof record.active !== 'boolean'
        || !Array.isArray(record.events)) throw new Error('kill-switch integrity check failed');
      return { ...payload, policyUnavailable: false };
    } catch (error) {
      if (error?.code === 'ENOENT') return { active: false, updatedAt: null, reason: null, events: [], policyUnavailable: false };
      return { active: true, updatedAt: null, reason: 'kill-switch state is damaged; writes are disabled', events: [], policyUnavailable: true };
    }
  }

  #refreshKillSwitch() {
    this.#killSwitch = this.#readKillSwitchFile();
    return this.#killSwitch;
  }

  #levelFor(definition) {
    const domain = definition.domain ?? definition.name.split('.')[0];
    return this.#levels.get(domain) ?? (definition.permission === 'write' ? 2 : 0);
  }

  permissionFor(name, context = {}) {
    const ctx = normalizedContext(context);
    const definition = this.#lookup(name);
    if (!definition) return null;
    const domain = definition.domain ?? definition.name.split('.')[0];
    const level = this.#levelFor(definition);
    return Object.freeze({
      schema: ECP_SCHEMA,
      principal: ctx.principal ?? (ctx.origin === 'agent' ? 'delegated-agent' : 'local-user-origin'),
      identityAssurance: 'local-process-origin-only',
      domain,
      capability: definition.name,
      resourceScope: definition.resourceScope ?? null,
      autonomyLevel: level,
      resourceBudget: cloneBudget(definition.resourceDemand ?? null),
      expiresAt: definition.expiresAt ?? null,
      revoked: definition.revoked === true,
      provenance: {
        capabilitySource: 'action_registry',
        policySource: this.#levels.has(domain) ? 'owner-configured-process-policy' : 'conservative-default',
        ...(ctx.grantId ? { grantId: ctx.grantId } : {}),
      },
      auditRef: ctx.auditRef ?? ctx.operationId ?? null,
    });
  }

  evaluate(name, origin, context = {}) {
    const ctx = normalizedContext(context);
    const definition = this.#lookup(name);
    if (origin !== 'user' && origin !== 'model' && origin !== 'agent') return deny(CONTROL_REASON.UNKNOWN_ORIGIN);
    if (!definition) return deny(CONTROL_REASON.UNKNOWN_ACTION);
    this.#refreshKillSwitch();
    const permission = this.permissionFor(name, { ...ctx, origin });

    const safetyControl = name === 'safety.lockdown' || name === 'safety.release';
    if (this.#killSwitch.policyUnavailable && definition.permission === 'write' && !safetyControl) {
      return deny(CONTROL_REASON.POLICY_UNAVAILABLE, permission);
    }
    if (this.#killSwitch.active && definition.permission === 'write' && !safetyControl) {
      return deny(CONTROL_REASON.KILL_SWITCH_ACTIVE, permission);
    }
    if (definition.revoked === true) return deny(CONTROL_REASON.POLICY_UNAVAILABLE, permission);
    if (definition.expiresAt && Date.parse(definition.expiresAt) <= this.#now().getTime()) {
      return deny(CONTROL_REASON.POLICY_UNAVAILABLE, permission);
    }
    if (ctx.resourceScope !== undefined && ctx.resourceScope !== null
      && (definition.resourceScope === undefined || definition.resourceScope === null || ctx.resourceScope !== definition.resourceScope)) {
      return deny(CONTROL_REASON.DELEGATION_SCOPE_MISMATCH, permission);
    }
    if (origin === 'agent') {
      const grantResult = this.#grantFor(ctx.grantId);
      if (grantResult.reason) return deny(grantResult.reason, permission);
      const proposedGrant = grantResult.grant;
      if (!definition.delegable || !proposedGrant.capabilities.includes(definition.name)
        || proposedGrant.domain !== permission.domain) return deny(CONTROL_REASON.DELEGATION_INVALID, permission);
    } else if (origin !== 'user' && !definition.origins.includes(origin)) {
      return deny(CONTROL_REASON.ORIGIN_NOT_PERMITTED, permission);
    }

    if (definition.permission === 'write' && origin === 'model') {
      return deny(CONTROL_REASON.ORIGIN_NOT_PERMITTED, permission);
    }
    // The owner must always be able to engage or release the ECP safety boundary, including while
    // locked down or when the configured domain level is restrictive. The exact action is fixed;
    // no caller-supplied capability can opt into this exception.
    if (safetyControl && origin === 'user') return { decision: 'allow', reason: 'PERMITTED', permission };
    const level = permission.autonomyLevel;
    const maxAutonomy = definition.maxAutonomy ?? (definition.permission === 'write' ? 2 : 5);
    if (level > maxAutonomy) return deny(CONTROL_REASON.AUTONOMY_LEVEL_EXCEEDS_CAPABILITY, permission);
    if (definition.permission === 'write' && level < 2) return deny(CONTROL_REASON.AUTONOMY_LEVEL_BLOCKS_WRITE, permission);
    if (origin !== 'agent') return { decision: 'allow', reason: 'PERMITTED', permission };

    const grantResult = this.#grantFor(ctx.grantId);
    if (grantResult.reason) return deny(grantResult.reason, permission);
    const grant = grantResult.grant;
    if (!definition.delegable || !grant.capabilities.includes(definition.name) || grant.domain !== permission.domain) {
      return deny(CONTROL_REASON.DELEGATION_INVALID, permission);
    }
    if (grant.autonomyLevel !== level || level < 3) return deny(CONTROL_REASON.AUTONOMY_LEVEL_EXCEEDS_CAPABILITY, permission);
    if (grant.resourceScope !== (definition.resourceScope ?? null)
      || (ctx.resourceScope !== undefined && ctx.resourceScope !== grant.resourceScope)) {
      return deny(CONTROL_REASON.DELEGATION_SCOPE_MISMATCH, permission);
    }
    if (!budgetFits(definition.resourceDemand ?? null, grant.remainingBudget)) {
      return deny(CONTROL_REASON.DELEGATION_BUDGET_EXHAUSTED, permission);
    }
    if (grant.actionsRemaining <= 0) return deny(CONTROL_REASON.DELEGATION_BUDGET_EXHAUSTED, permission);
    if (level === 4 && (!grant.missionId || typeof ctx.checkpointRef !== 'string' || ctx.checkpointRef.length === 0)) {
      return deny(CONTROL_REASON.MISSION_CHECKPOINT_REQUIRED, permission);
    }
    if (level === 5 && (!grant.standingOrder || !LOW_RISK.has(definition.risk ?? 'high') || !grant.resourceBudget)) {
      return deny(CONTROL_REASON.STANDING_ORDER_RESTRICTED, permission);
    }
    if (ctx.phase === 'execute') {
      grant.actionsRemaining -= 1;
      subtractBudget(grant.remainingBudget, definition.resourceDemand ?? null);
      grant.history.push({ at: this.#now().toISOString(), action: name, auditRef: ctx.auditRef ?? ctx.operationId ?? null });
    }
    return { decision: 'allow', reason: 'PERMITTED', permission };
  }

  // Backwards-compatible policy answer shape. Existing consumers receive only these two fields;
  // the complete permission representation is available from evaluate() and permissionFor().
  authorize(name, origin, context = {}) {
    const result = this.evaluate(name, origin, context);
    return { decision: result.decision, reason: result.reason };
  }

  grantDelegation({ origin, domain, capabilities, resourceScope, resourceBudget, actionBudget, expiresAt, approvalRef, autonomyLevel: level = 3, missionId = null, standingOrder = false } = {}) {
    if (origin !== 'user' || this.#killSwitch.active) throw new TypeError('a delegation grant requires an explicit user act while the kill switch is clear');
    const normalizedLevel = autonomyLevel(level);
    if (normalizedLevel < 3) throw new TypeError('delegation grants require autonomy level 3, 4, or 5');
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(String(domain ?? ''))) throw new TypeError('delegation domain is invalid');
    if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 16
      || capabilities.some((name) => typeof name !== 'string' || !this.#lookup(name))) {
      throw new TypeError('delegation must name 1 to 16 registered capabilities');
    }
    if (typeof resourceScope !== 'string' || resourceScope.trim().length === 0 || resourceScope.length > 240) {
      throw new TypeError('delegation requires one explicit bounded resource scope');
    }
    if (!validBudget(resourceBudget, { allowZero: true }) || !Object.values(resourceBudget).some((value) => value > 0)) throw new TypeError('delegation requires a finite positive resource budget');
    if (!Number.isInteger(actionBudget) || actionBudget < 1 || actionBudget > 100) throw new TypeError('actionBudget must be from 1 to 100');
    if (typeof approvalRef !== 'string' || approvalRef.trim().length === 0 || approvalRef.length > 128) {
      throw new TypeError('delegation requires a user approval reference');
    }
    const expiry = isoTime(expiresAt, 'expiresAt');
    if (Date.parse(expiry) <= this.#now().getTime()) throw new TypeError('expiresAt must be in the future');
    if (normalizedLevel === 4 && (typeof missionId !== 'string' || missionId.trim().length === 0)) {
      throw new TypeError('L4 mission grants require a mission id');
    }
    if (normalizedLevel === 5 && standingOrder !== true) throw new TypeError('L5 requires an explicit standing order');

    for (const name of capabilities) {
      const def = this.#lookup(name);
      if (!def.delegable || (def.domain ?? def.name.split('.')[0]) !== domain
        || def.resourceScope !== resourceScope || !def.resourceDemand
        || !budgetFits(def.resourceDemand, resourceBudget)) {
        throw new TypeError(`capability ${name} is not declared for this bounded delegation`);
      }
      if (normalizedLevel > (def.maxAutonomy ?? 0)) throw new TypeError(`capability ${name} does not permit autonomy level ${normalizedLevel}`);
      if (normalizedLevel === 5 && !LOW_RISK.has(def.risk ?? 'high')) {
        throw new TypeError('L5 is restricted to capabilities explicitly classified low risk');
      }
    }
    const id = this.#idFactory();
    const grant = {
      id,
      domain,
      capabilities: [...new Set(capabilities)],
      resourceScope,
      autonomyLevel: normalizedLevel,
      resourceBudget: cloneBudget(resourceBudget),
      remainingBudget: cloneBudget(resourceBudget),
      actionBudget,
      actionsRemaining: actionBudget,
      expiresAt: expiry,
      approvalRef: approvalRef.trim(),
      missionId,
      standingOrder: standingOrder === true,
      revoked: false,
      history: [],
    };
    this.#grants.set(id, grant);
    return this.grantStatus(id);
  }

  #grantFor(id) {
    if (typeof id !== 'string' || !this.#grants.has(id)) return { reason: CONTROL_REASON.DELEGATION_REQUIRED, grant: null };
    const grant = this.#grants.get(id);
    if (grant.revoked) return { reason: CONTROL_REASON.DELEGATION_REVOKED, grant: null };
    if (Date.parse(grant.expiresAt) <= this.#now().getTime()) return { reason: CONTROL_REASON.DELEGATION_EXPIRED, grant: null };
    return { reason: null, grant };
  }

  revokeDelegation(id, { origin, reason } = {}) {
    if (origin !== 'user' || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new TypeError('revocation requires a user act and a reason');
    }
    const grant = this.#grants.get(id);
    if (!grant) throw new TypeError('delegation grant was not found');
    if (!grant.revoked) {
      grant.revoked = true;
      grant.revocation = { at: this.#now().toISOString(), reason: reason.trim().slice(0, 240) };
    }
    return this.grantStatus(id);
  }

  grantStatus(id) {
    const grant = this.#grants.get(id);
    if (!grant) return null;
    return Object.freeze({
      id: grant.id,
      domain: grant.domain,
      capabilities: [...grant.capabilities],
      resourceScope: grant.resourceScope,
      autonomyLevel: grant.autonomyLevel,
      resourceBudget: { ...grant.resourceBudget },
      remainingBudget: { ...grant.remainingBudget },
      actionBudget: grant.actionBudget,
      actionsRemaining: grant.actionsRemaining,
      expiresAt: grant.expiresAt,
      approvalRef: grant.approvalRef,
      revoked: grant.revoked,
      revocation: grant.revocation ?? null,
      history: grant.history.map((item) => ({ ...item })),
    });
  }

  activateKillSwitch({ origin, reason = 'owner emergency stop' } = {}) {
    if (origin !== 'user') throw new TypeError('only a user act can activate the kill switch');
    this.#refreshKillSwitch();
    if (this.#killSwitch.active) return this.killSwitchStatus();
    const safeReason = redactSecrets(String(reason).slice(0, 240));
    const next = {
      active: true,
      updatedAt: this.#now().toISOString(),
      reason: safeReason,
      events: [...(this.#killSwitch.events ?? []), { event: 'activated', at: this.#now().toISOString(), reason: safeReason }],
    };
    this.#writeKillSwitch(next);
    for (const cancel of this.#cancellables.values()) {
      try { cancel(); } catch { /* cancellation failure cannot clear the switch */ }
    }
    return this.killSwitchStatus();
  }

  clearKillSwitch({ origin, reason } = {}) {
    if (origin !== 'user' || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new TypeError('clearing the kill switch requires a user act and a reason');
    }
    this.#refreshKillSwitch();
    if (this.#killSwitch.active || this.#killSwitch.policyUnavailable) {
      const safeReason = redactSecrets(reason.trim().slice(0, 240));
      const priorEvents = this.#killSwitch.events ?? [];
      const next = {
        active: false,
        updatedAt: this.#now().toISOString(),
        reason: null,
        events: [...priorEvents, { event: 'cleared', at: this.#now().toISOString(), reason: safeReason }],
      };
      if (this.#killSwitch.policyUnavailable && this.#killSwitchPath && fs.existsSync(this.#killSwitchPath)) {
        const backup = `${this.#killSwitchPath}.corrupt.${this.#now().getTime()}`;
        fs.copyFileSync(this.#killSwitchPath, backup, fs.constants.COPYFILE_EXCL);
      }
      this.#writeKillSwitch(next);
    }
    return this.killSwitchStatus();
  }

  killSwitchStatus() {
    this.#refreshKillSwitch();
    return Object.freeze({
      active: this.#killSwitch.active,
      activatedAt: this.#killSwitch.events?.filter((event) => event.event === 'activated').at(-1)?.at ?? null,
      reason: this.#killSwitch.reason,
      events: (this.#killSwitch.events ?? []).map((event) => ({ ...event })),
      policyUnavailable: this.#killSwitch.policyUnavailable === true,
      cancellableOperations: this.#cancellables.size,
      persistence: this.#killSwitchPath ? 'durable local latch; corruption fails closed' : 'process-local; not durable across restart',
    });
  }

  registerCancellable(id, cancel) {
    if (typeof id !== 'string' || id.length === 0 || typeof cancel !== 'function') throw new TypeError('a cancellable operation needs an id and callback');
    if (this.#killSwitch.active) {
      cancel();
      return () => {};
    }
    this.#cancellables.set(id, cancel);
    return () => this.#cancellables.delete(id);
  }
}
