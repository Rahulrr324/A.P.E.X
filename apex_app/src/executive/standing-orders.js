// T-44 Package 1 (2026-11-19): the governed Standing Orders engine.
//
// A Standing Order is a bounded delegation: the owner writes down, once, that whenever a named event
// happens a named capability may run, without them being present to press the button. That is a real
// and useful thing to be able to say - "when the workspace goes dirty, take a reading" - and it is also
// the single most dangerous idea in the whole product, because it is the mechanism by which a system
// starts acting on its own.
//
// Part 3 of the Master Spec draws the line, and this module is that line made executable:
//
//   **Nothing that is irreversible, destructive, security-relevant or `workspace_fs`-mutating may ever
//   execute above L2 Confirm.** A Standing Order is L3-L5 by definition - it runs with nobody present -
//   so it may only ever carry a capability that is `reversibility: 'reversible'` AND `blastRadius:
//   'local_state'`. A capability that writes the owner's files, moves the safety latch, or cannot be
//   undone, is refused at REGISTRATION, not at execution. A refusal at execution time would be a
//   refusal that had already been trusted to be correct; a refusal at registration means the dangerous
//   order never exists.
//
// Four rules govern the module, and the rest of this file is their consequences:
//
//   1. **The whitelist is derived, not listed.** The set of permitted capabilities is computed by
//      reading the registry's own declarations. A hard-coded list would drift from the registry the
//      moment a capability changed its blast radius; a derived one cannot, because the same facts that
//      the ECP authorizes on are the facts the whitelist is built from.
//   2. **The annotation is a second, independent check.** `#reasonsFor` also refuses a named set of
//      immutable governance capabilities, and refuses any capability the module knows nothing about.
//      Two independent tests of the same claim is the only way the claim survives a bug in either.
//   3. **Lockdown halts before anything else.** The latch is read first, on every entry point. It is
//      never consulted after a decision has been formed, because a decision formed before the latch is
//      read is a decision that could be acted on while the system is stopped.
//   4. **Release never re-fires.** Releasing Lockdown does not drain a queue of halted orders, because
//      there is no queue: a halted order records `halted_by_lockdown` in its history and returns. The
//      engine keeps no work-in-progress between calls, so there is nothing left to run when the latch
//      lifts. That is a structural guarantee, not a policy one.
//
// And the execution path is not a shortcut. Every run goes through `controlPlane.execute`, the same
// entry point the HTTP routes and the router use, so the ECP authorizes it, the registry's own
// validation runs, the step is recorded in `operations.jsonl`, and the capability's own `verify` decides
// whether it verified. A Standing Order cannot authorize anything; it can only *ask*, on a schedule the
// owner wrote.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STANDING_ORDERS_SCHEMA = 'apex.executive.standing-orders/1';
export const STANDING_ORDER_SCHEMA = 'apex.executive.standing-order/1';
export const STANDING_ORDER_POLICY_SCHEMA = 'apex.executive.standing-order-policy/1';

// The six triggers the brief names. Anything else is not a trigger, and an order carrying one could
// never fire - so it is refused at registration rather than stored as a row that looks armed.
export const TRIGGER_EVENT_TYPES = Object.freeze([
  'workspace_dirty', 'load_pressure', 'storage_pressure', 'drift_detected', 'session_start', 'manual_invoke',
]);

// The autonomy tiers a Standing Order may carry. L1 is not offered: a Standing Order that is not above
// Confirm is just a capability call with extra steps.
export const STANDING_ORDER_TIERS = Object.freeze(['L3', 'L4', 'L5']);

// The outcomes an order can record. `never_run` is the initial value and is never written after a run.
export const STANDING_ORDER_OUTCOMES = Object.freeze([
  'never_run', 'verified', 'cooldown_skipped', 'halted_by_lockdown', 'refused',
]);

const DEFAULT_COOLDOWN_SEC = 30;
const MIN_DEFAULT_COOLDOWN_SEC = 5;
const DEFAULT_MAX_RUNS_PER_HOUR = 12;
const MAX_MAX_RUNS_PER_HOUR = 240;
const MAX_TITLE_CHARS = 120;
const MAX_HISTORY = 50;
const MAX_REASON_CHARS = 240;

// ------------------------------------------------------------------------------------ refusals ---

// A refusal is a value, not an exception, everywhere the ECP might need to decide something. The class
// exists so the HTTP layer can turn one into a status code without guessing which field means what.
export class StandingOrderRefusal extends Error {
  constructor(code, message, detail = {}, status = 403) {
    super(message);
    this.name = 'StandingOrderRefusal';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export const STANDING_ORDER_CODES = Object.freeze({
  CAPABILITY_FORBIDDEN: 'STANDING_ORDER_CAPABILITY_FORBIDDEN',
  LOCKDOWN_ACTIVE: 'LOCKDOWN_ACTIVE',
  NOT_FOUND: 'STANDING_ORDER_NOT_FOUND',
  INVALID_TRIGGER: 'STANDING_ORDER_INVALID_TRIGGER',
  INVALID_TIER: 'STANDING_ORDER_INVALID_TIER',
  INVALID_INPUT: 'STANDING_ORDER_INVALID_INPUT',
  LEDGER_CORRUPT: 'STANDING_ORDER_LEDGER_CORRUPT',
  EXECUTION_REFUSED: 'STANDING_ORDER_EXECUTION_REFUSED',
});

function refused(code, message, detail = {}, status = 403) {
  return new StandingOrderRefusal(code, message, detail, status);
}

// ------------------------------------------------------------------------------------- inputs ---

function text(value, limit, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refused(STANDING_ORDER_CODES.INVALID_INPUT, `${label} must be a string`, {}, 400);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function integer(value, { fallback, min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw refused(STANDING_ORDER_CODES.INVALID_INPUT, `${label} must be an integer from ${min} to ${max}`, { value, min, max }, 400);
  }
  return parsed;
}

function plainObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw refused(STANDING_ORDER_CODES.INVALID_INPUT, `${label} must be an object`, {}, 400);
  }
  // A copy, so a caller cannot keep a reference and mutate an order's stored input afterwards.
  return JSON.parse(JSON.stringify(value));
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

// ------------------------------------------------------------------------------- the whitelist ---

// The annotation is the independent half of the whitelist. A capability on this list can never be
// carried by a Standing Order even if a future declaration made it look safe, because the reason it is
// on this list is not a fact about its metadata - it is a fact about what it is.
const IMMUTABLE_GOVERNANCE = Object.freeze([
  'workshop.apply_file', 'workshop.apply_changeset',
  'workshop.rollback_file', 'workshop.rollback_changeset',
  'git.checkpoint_create', 'git.checkpoint_restore',
  'safety.release', 'safety.lockdown',
]);

function isImmutableGovernance(capabilityId) {
  return IMMUTABLE_GOVERNANCE.includes(capabilityId) || capabilityId.startsWith('evolution.');
}

// The two reversibility declarations a delegable capability may carry.
//
// `reversible` is the brief's word for "an undo exists". `read_only` is the codebase's word for "no undo
// is needed, because nothing changed" - safety-metadata.js declares it for every read, and no other
// module in the system treats it as weaker than reversible: it is the *strongest* declaration on the
// scale, not a fourth one. A whitelist that demanded the literal string `reversible` would exclude every
// read in the system, which would leave a Standing Order able to do nothing at all. So the rule is
// stated as a set of two declarations rather than one, and the test file asserts both.
const DELEGABLE_REVERSIBILITY = Object.freeze(['reversible', 'read_only']);

// Why a capability may not be delegated, or an empty list when it may. Every reason names the rule it
// broke, because "forbidden" without a reason is indistinguishable from a bug.
export function standingOrderForbiddenReasons(definition) {
  if (!definition || typeof definition !== 'object') {
    return ['no capability with that name is registered, so there is nothing to delegate'];
  }
  const reasons = [];
  const name = definition.name ?? 'the capability';
  const reversible = DELEGABLE_REVERSIBILITY.includes(definition.reversibility);
  // The blast radius rule. A read that declares `none` has a smaller radius than local_state, so it is
  // inside the boundary rather than outside it; a read that declares `local_state` is equally fine. What
  // is outside is anything that touches the owner's files, the safety latch, or a session.
  const boundedRadius = definition.blastRadius === 'local_state'
    || (definition.permission === 'read' && definition.blastRadius === 'none');
  if (isImmutableGovernance(name)) {
    reasons.push(`${name} is immutable governance: its effect is security-relevant or it writes the owner's files, so it can never be delegated above L2 Confirm`);
  }
  if (definition.blastRadius === 'workspace_fs') {
    reasons.push(`${name} has blastRadius workspace_fs: it modifies the owner's live workspace, which cannot be done autonomously above L2 Confirm`);
  }
  if (definition.blastRadius === 'system_latch' || definition.blastRadius === 'session') {
    reasons.push(`${name} has blastRadius ${definition.blastRadius}, which is outside what a Standing Order may reach`);
  }
  if (!reversible) {
    reasons.push(`${name} declares reversibility ${definition.reversibility ?? 'nothing'}; a Standing Order may only carry a capability that declares itself reversible or read_only`);
  }
  if (!boundedRadius) {
    reasons.push(`${name} has blastRadius ${definition.blastRadius ?? 'nothing'}; a Standing Order may only carry a capability whose blast radius is local_state, or a read that changes nothing`);
  }
  if (definition.risk === 'high' || definition.risk === 'critical') {
    reasons.push(`${name} is declared ${definition.risk} risk, which is never delegated`);
  }
  // De-duplicate, keeping the first (most specific) reason first.
  return [...new Set(reasons)];
}

// The named safe set. The rule above decides what is *forbidden*; this table decides what is
// *offered* - and the two are deliberately not the same question.
//
// A rule that permitted every read would permit `workspace.read_file`, which reads any file under the
// owner's root. That is a local_state read that changes nothing, so it passes the letter of the rule, and
// it would let a standing order exfiltrate a different file every time it fired. "Reversible" is not the
// same as "appropriate to run unattended": the first is a fact about the effect, the second is a judgement
// the owner has not made. So the engine offers exactly the seven capabilities the brief names, and then
// *also* requires that each of them passes the rule - an entry here whose declaration turned unsafe stops
// being offered, rather than becoming a permission the rule is expected to remember to catch.
export const SAFE_CAPABILITY_SET = Object.freeze([
  'system.doctor', 'git.status_detailed', 'git.diff_inspect', 'system.inspect_ports',
  'system.inspect_processes', 'workspace.inspect', 'briefing.compile',
]);

// The capabilities a Standing Order may carry: the safe set, filtered to those actually registered and
// still passing the rule. Sorted so the list a select element is built from does not reorder between reads.
export function allowedStandingOrderCapabilities(registry) {
  if (!registry || typeof registry.list !== 'function') return [];
  return registry.list()
    .filter((definition) => SAFE_CAPABILITY_SET.includes(definition.name))
    .filter((definition) => standingOrderForbiddenReasons(definition).length === 0)
    .map((definition) => definition.name)
    .sort();
}

// Why a named capability may not be delegated, combining the rule with the safe set. This is what
// `create` calls, because "the rule permits it" and "an owner may write a standing order for it" are two
// answers and the second is the one that decides.
export function delegationRefusalReasons(definition) {
  if (!definition || typeof definition !== 'object') {
    return ['no capability with that name is registered, so there is nothing to delegate'];
  }
  const reasons = standingOrderForbiddenReasons(definition);
  if (reasons.length === 0 && !SAFE_CAPABILITY_SET.includes(definition.name)) {
    reasons.push(`${definition.name} is not in the standing-order safe set; offering every reversible read would include ones that read arbitrary files, and an owner has not delegated those`);
  }
  return reasons;
}

// --------------------------------------------------------------------------------- the engine ---

export class StandingOrdersEngine {
  #file;
  #dataDir;
  #registry;
  #controlPlane;
  #now;
  #idFactory;
  #operations;
  #lockdown;
  #controller;

  constructor({
    dataDir,
    registry,
    controlPlane = null,
    now = () => new Date(),
    idFactory = randomUUID,
    operations = null,
    // The lockdown reading is injected rather than reached for, so a test can hold the latch still and
    // so this module never imports the ECP. The default reads the registry's control plane, which is the
    // same latch every other gate in the system reads.
    lockdown = null,
    // The executor. When present, a run goes through it instead of `controlPlane.execute` directly,
    // which is what lets the controller record the operation in the same ledger as every other act.
    controller = null,
  } = {}) {
    if (!dataDir) throw new TypeError('StandingOrdersEngine requires a data directory');
    this.#dataDir = dataDir;
    this.#file = path.join(dataDir, 'standing-orders.json');
    this.#registry = registry ?? null;
    this.#controlPlane = controlPlane ?? registry?.controlPlane ?? null;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#operations = operations;
    this.#controller = controller;
    this.#lockdown = typeof lockdown === 'function'
      ? lockdown
      : () => this.#controlPlane?.killSwitchStatus?.().active === true;
  }

  // ------------------------------------------------------------------ persistence, failure-safe ---
  //
  // The ledger is read on every operation rather than cached. A cached copy would let two engine
  // instances - the one the routes hold and the one a test constructed - disagree about what has been
  // registered, and the disagreement would be silent. Reading is a small JSON file.

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { present: false, corrupt: false, orders: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { present: true, corrupt: true, orders: [] };
    }
    if (!parsed || !Array.isArray(parsed.orders)) return { present: true, corrupt: true, orders: [] };
    const orders = parsed.orders.filter((entry) => entry && typeof entry === 'object' && typeof entry.orderId === 'string');
    return { present: true, corrupt: orders.length !== parsed.orders.length, orders: orders.map((entry) => this.#normalise(entry)) };
  }

  #write(orders) {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const payload = {
      schema: STANDING_ORDERS_SCHEMA,
      at: this.#now().toISOString(),
      orders: orders.map((entry) => ({ ...entry })),
    };
    // Write-then-rename: a crash mid-write leaves the previous ledger intact rather than a truncated
    // file that would read as corrupt and disable every order at once.
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, this.#file);
  }

  // A stored row is rebuilt into the authoritative shape on read, so a hand-edited file cannot smuggle
  // an extra field into the record the routes return.
  #normalise(entry) {
    const createdAt = isoOrNull(entry.createdAt) ?? this.#now().toISOString();
    return {
      schema: STANDING_ORDER_SCHEMA,
      orderId: String(entry.orderId),
      title: text(entry.title, MAX_TITLE_CHARS, 'title') || 'untitled standing order',
      trigger: {
        eventType: TRIGGER_EVENT_TYPES.includes(entry.trigger?.eventType) ? entry.trigger.eventType : 'manual_invoke',
        cooldownSec: Number.isInteger(entry.trigger?.cooldownSec) ? entry.trigger.cooldownSec : DEFAULT_COOLDOWN_SEC,
        maxRunsPerHour: Number.isInteger(entry.trigger?.maxRunsPerHour) ? entry.trigger.maxRunsPerHour : DEFAULT_MAX_RUNS_PER_HOUR,
      },
      action: {
        capabilityId: typeof entry.action?.capabilityId === 'string' ? entry.action.capabilityId : '',
        input: entry.action?.input && typeof entry.action.input === 'object' ? { ...entry.action.input } : {},
        autonomyTier: STANDING_ORDER_TIERS.includes(entry.action?.autonomyTier) ? entry.action.autonomyTier : 'L3',
      },
      enabled: entry.enabled === true,
      createdAt,
      updatedAt: isoOrNull(entry.updatedAt) ?? createdAt,
      runCount: Number.isInteger(entry.runCount) && entry.runCount >= 0 ? entry.runCount : 0,
      lastRunAt: isoOrNull(entry.lastRunAt),
      lastRunId: typeof entry.lastRunId === 'string' ? entry.lastRunId : null,
      lastOutcome: STANDING_ORDER_OUTCOMES.includes(entry.lastOutcome) ? entry.lastOutcome : 'never_run',
      history: Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY).map((run) => ({
        runId: String(run.runId ?? ''),
        triggeredBy: TRIGGER_EVENT_TYPES.includes(run.triggeredBy) ? run.triggeredBy : 'manual_invoke',
        executedAt: isoOrNull(run.executedAt) ?? createdAt,
        outcome: STANDING_ORDER_OUTCOMES.includes(run.outcome) ? run.outcome : 'refused',
        operationId: typeof run.operationId === 'string' ? run.operationId : null,
        summary: typeof run.summary === 'string' ? run.summary.slice(0, MAX_REASON_CHARS) : '',
        verified: run.verified === true,
      })) : [],
      verified: true,
    };
  }

  // The controller is created after the registry in the composition root, because the controller needs
  // the registry to authorize. So the engine is constructed first, its five capabilities are registered
  // before anything can call them, and the executor arrives a few lines later. Until it does, a run
  // refuses rather than running unexecuted - which is the correct behaviour for a half-built app.
  attachController(controller) {
    this.#controller = controller ?? null;
    return this;
  }

  // ---------------------------------------------------------------------------- reading state ---

  #definition(capabilityId) {
    return this.#registry?.get?.(capabilityId) ?? null;
  }

  // Whether a run is permitted right now, checked the same way at registration and at execution. The
  // two checks are deliberately the same code: an order registered when a capability was safe must stop
  // running if that capability's declaration changes.
  #reasonsFor(capabilityId) {
    return delegationRefusalReasons(this.#definition(capabilityId));
  }

  lockdownActive() {
    try {
      return this.#lockdown() === true;
    } catch {
      // A latch that cannot be read is a latch that must be assumed engaged. This is the one place in
      // the module where failing closed is expressed by returning true rather than by refusing.
      return true;
    }
  }

  #refuseIfLocked() {
    if (this.lockdownActive()) {
      throw refused(STANDING_ORDER_CODES.LOCKDOWN_ACTIVE,
        'Lockdown is engaged, so no Standing Order may be created, changed, invoked or evaluated. Release Lockdown first; releasing it does not run anything that was halted.',
        { lockdownActive: true }, 423);
    }
  }

  allowedCapabilities() {
    return allowedStandingOrderCapabilities(this.#registry);
  }

  list() {
    const { present, corrupt, orders } = this.#read();
    const lockdownActive = this.lockdownActive();
    const withPolicy = orders.map((order) => ({
      ...order,
      // Recomputed on every read rather than stored: an order whose capability has since become
      // forbidden is shown as such, and one whose trigger would fire while the latch is up is shown as
      // halted rather than merely paused.
      runnable: order.enabled && this.#reasonsFor(order.action.capabilityId).length === 0 && !lockdownActive,
      forbiddenReasons: this.#reasonsFor(order.action.capabilityId),
    }));
    return {
      schema: STANDING_ORDERS_SCHEMA,
      verified: true,
      lockdownActive,
      allowedCapabilities: this.allowedCapabilities(),
      ledger: { present, corrupt },
      orders: withPolicy,
      summary: {
        totalCount: withPolicy.length,
        enabledCount: withPolicy.filter((order) => order.enabled).length,
        pausedCount: withPolicy.filter((order) => !order.enabled).length,
        totalRuns: withPolicy.reduce((total, order) => total + order.runCount, 0),
        haltedByLockdownCount: withPolicy.filter((order) => order.lastOutcome === 'halted_by_lockdown').length,
      },
    };
  }

  // ------------------------------------------------------------------------------------- create ---

  create({ title, eventType, capabilityId, input, autonomyTier = 'L3', cooldownSec, maxRunsPerHour, enabled = true } = {}) {
    this.#refuseIfLocked();
    const cleanTitle = text(title, MAX_TITLE_CHARS, 'title');
    if (cleanTitle === '') throw refused(STANDING_ORDER_CODES.INVALID_INPUT, 'a standing order needs a title', {}, 400);
    if (!TRIGGER_EVENT_TYPES.includes(eventType)) {
      throw refused(STANDING_ORDER_CODES.INVALID_TRIGGER,
        `trigger.eventType must be one of ${TRIGGER_EVENT_TYPES.join(', ')}`, { eventType, allowed: [...TRIGGER_EVENT_TYPES] }, 400);
    }
    if (!STANDING_ORDER_TIERS.includes(autonomyTier)) {
      throw refused(STANDING_ORDER_CODES.INVALID_TIER,
        `action.autonomyTier must be one of ${STANDING_ORDER_TIERS.join(', ')}; a Standing Order is above L2 by definition`,
        { autonomyTier, allowed: [...STANDING_ORDER_TIERS] }, 400);
    }
    const cleanCapability = text(capabilityId, 120, 'capabilityId');
    // The refusal that makes the whole module safe. It happens here, before anything is written, so a
    // forbidden order never exists on disk to be read, toggled, or trusted by a later bug.
    const reasons = this.#reasonsFor(cleanCapability);
    if (reasons.length > 0) {
      throw refused(STANDING_ORDER_CODES.CAPABILITY_FORBIDDEN,
        `a Standing Order may not carry ${cleanCapability || 'that capability'}: ${reasons[0]}. A Standing Order runs with nobody present, so it may only carry a reversible capability whose blast radius is local_state - never a workspace_fs, system_latch, security-relevant or irreversible one, which can never execute above L2 Confirm.`,
        { capabilityId: cleanCapability, reasons, allowedCapabilities: this.allowedCapabilities() }, 403);
    }
    const cooldown = integer(cooldownSec, { fallback: DEFAULT_COOLDOWN_SEC, min: 0, max: 86_400, label: 'trigger.cooldownSec' });
    const perHour = integer(maxRunsPerHour, { fallback: DEFAULT_MAX_RUNS_PER_HOUR, min: 1, max: MAX_MAX_RUNS_PER_HOUR, label: 'trigger.maxRunsPerHour' });
    const at = this.#now().toISOString();
    const order = this.#normalise({
      orderId: `so_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`,
      title: cleanTitle,
      trigger: { eventType, cooldownSec: cooldown, maxRunsPerHour: perHour },
      action: { capabilityId: cleanCapability, input: plainObject(input, 'action.input'), autonomyTier },
      enabled: enabled === true,
      createdAt: at,
      updatedAt: at,
      runCount: 0,
      lastRunAt: null,
      lastRunId: null,
      lastOutcome: 'never_run',
      history: [],
    });
    const { orders } = this.#read();
    orders.push(order);
    this.#write(orders);
    this.#recordOperation({
      capability: 'standing_order.create',
      request: `standing_order.create ${order.orderId}`,
      step: { action: 'standing_order.create', orderId: order.orderId, capabilityId: order.action.capabilityId, eventType: order.trigger.eventType },
    });
    return { ...order, verified: true };
  }

  // ------------------------------------------------------------------------------ toggle, revoke ---

  #withOrder(orderId, mutate) {
    const wanted = String(orderId ?? '');
    const { orders } = this.#read();
    const index = orders.findIndex((entry) => entry.orderId === wanted);
    if (index === -1) {
      throw refused(STANDING_ORDER_CODES.NOT_FOUND, `no standing order with id ${wanted}`, { orderId: wanted }, 404);
    }
    const at = this.#now().toISOString();
    const next = mutate(orders[index], at);
    orders[index] = next;
    this.#write(orders);
    return next;
  }

  toggle(orderId, { enabled = null } = {}) {
    this.#refuseIfLocked();
    const order = this.#withOrder(orderId, (entry, at) => ({
      ...entry,
      // A toggle with no explicit target flips, which is what the panel's one button needs; an explicit
      // target is honoured, which is what a test needs to be able to say what it meant.
      enabled: enabled === null ? !entry.enabled : enabled === true,
      updatedAt: at,
    }));
    this.#recordOperation({
      capability: 'standing_order.toggle',
      request: `standing_order.toggle ${order.orderId} ${order.enabled}`,
      step: { action: 'standing_order.toggle', orderId: order.orderId, enabled: order.enabled },
    });
    return { ...order, verified: true };
  }

  revoke(orderId) {
    this.#refuseIfLocked();
    const wanted = String(orderId ?? '');
    const { orders } = this.#read();
    const index = orders.findIndex((entry) => entry.orderId === wanted);
    if (index === -1) {
      throw refused(STANDING_ORDER_CODES.NOT_FOUND, `no standing order with id ${wanted}`, { orderId: wanted }, 404);
    }
    const [removed] = orders.splice(index, 1);
    this.#write(orders);
    this.#recordOperation({
      capability: 'standing_order.revoke',
      request: `standing_order.revoke ${wanted}`,
      step: { action: 'standing_order.revoke', orderId: wanted, title: removed.title },
    });
    return { revoked: true, orderId: wanted, title: removed.title, verified: true };
  }

  // ------------------------------------------------------------------------------- the run path ---

  // The rate limit. Two independent limits, because they answer different questions: `cooldownSec` is
  // "not again this soon" and `maxRunsPerHour` is "not this many in an hour". A burst of one event per
  // second would pass the cooldown if it were 0 and fail the hourly cap, and a single event an hour
  // apart passes both.
  #rateLimited(order, nowMs) {
    const lastMs = order.lastRunAt ? Date.parse(order.lastRunAt) : null;
    if (lastMs !== null && Number.isFinite(lastMs)) {
      const elapsedSec = (nowMs - lastMs) / 1000;
      if (elapsedSec < order.trigger.cooldownSec) {
        return { limited: true, reason: 'cooldown', retryAfterSec: Math.ceil(order.trigger.cooldownSec - elapsedSec) };
      }
    }
    const hourAgo = nowMs - 3_600_000;
    const recentRuns = order.history.filter((run) => {
      const at = Date.parse(run.executedAt);
      return Number.isFinite(at) && at >= hourAgo && run.outcome === 'verified';
    }).length;
    if (recentRuns >= order.trigger.maxRunsPerHour) {
      return { limited: true, reason: 'max_runs_per_hour', retryAfterSec: null };
    }
    return { limited: false, reason: null, retryAfterSec: null };
  }

  // One run. `triggeredBy` is what caused it, recorded verbatim in history so the owner can see whether
  // an order fired on its own event or because someone pressed Invoke.
  async #run(order, triggeredBy) {
    const at = this.#now();
    const runId = `sor_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`;

    // Lockdown is checked first and its refusal is RECORDED rather than thrown away: an order that was
    // halted while the system was stopped is a fact the owner should be able to find afterwards.
    if (this.lockdownActive()) {
      return this.#record(order, runId, triggeredBy, {
        outcome: 'halted_by_lockdown',
        operationId: null,
        summary: 'Lockdown was engaged, so the order was halted and the capability was not invoked',
        verified: false,
      }, { status: 423, code: STANDING_ORDER_CODES.LOCKDOWN_ACTIVE });
    }

    // The whitelist is re-checked. A capability that was safe when the order was written may have
    // changed its declaration since; an order is a standing permission, not a standing exemption.
    const reasons = this.#reasonsFor(order.action.capabilityId);
    if (reasons.length > 0) {
      return this.#record(order, runId, triggeredBy, {
        outcome: 'refused',
        operationId: null,
        summary: `the capability is no longer delegable: ${reasons[0]}`,
        verified: false,
      }, { status: 403, code: STANDING_ORDER_CODES.CAPABILITY_FORBIDDEN });
    }

    const rate = this.#rateLimited(order, at.getTime());
    if (rate.limited) {
      return this.#record(order, runId, triggeredBy, {
        outcome: 'cooldown_skipped',
        operationId: null,
        summary: rate.reason === 'cooldown'
          ? `skipped: the ${order.trigger.cooldownSec}s cooldown has not elapsed (${rate.retryAfterSec}s remaining)`
          : `skipped: ${order.trigger.maxRunsPerHour} verified runs in the last hour is the limit`,
        verified: false,
      }, { status: 200, code: null, skipped: true, retryAfterSec: rate.retryAfterSec });
    }

    // The execution itself, and it is not a shortcut. `controller.runAction` is the same path the HTTP
    // routes and the router take: it asks the registry to authorize, which the ECP decides; it runs the
    // capability's own validate; it runs the capability; and it runs the capability's own verify. There
    // is deliberately no second path. The ECP authorizes and does not execute, so an engine that reached
    // the control plane directly could produce an authorization with no execution behind it - a receipt
    // for something that never happened, which is worse than a refusal.
    let step = null;
    let operationId = null;
    let ranThroughController = false;
    try {
      if (!this.#controller || typeof this.#controller.runAction !== 'function') {
        throw new Error('no controller is configured, so the capability cannot be run through the ECP');
      }
      // Prefer the controller's named method, because that is the one that finalizes the operation into
      // `operations.jsonl`. The bare `runAction` path is kept for a caller that supplies a plain executor,
      // but the composed app always has the named one.
      if (typeof this.#controller.standingOrderRun === 'function') {
        const finished = await this.#controller.standingOrderRun({
          orderId: order.orderId,
          runId,
          capabilityId: order.action.capabilityId,
          input: order.action.input,
          autonomyTier: order.action.autonomyTier,
          triggeredBy,
        });
        ranThroughController = true;
        operationId = finished?.operation?.id ?? finished?.id ?? null;
        step = finished?.step ?? finished?.operation?.steps?.[0] ?? null;
      } else {
        operationId = `op_${this.#idFactory().replace(/-/g, '').slice(0, 20)}`;
        step = await this.#controller.runAction(order.action.capabilityId, order.action.input, 'user', operationId);
      }
    } catch (error) {
      return this.#record(order, runId, triggeredBy, {
        outcome: 'refused',
        operationId: null,
        summary: `the capability could not be run: ${String(error?.message ?? error).slice(0, MAX_REASON_CHARS)}`,
        verified: false,
      }, { status: 500, code: STANDING_ORDER_CODES.EXECUTION_REFUSED });
    }

    // `verified` is the capability's own answer, not the engine's opinion of it. An order that ran and
    // was not verified records exactly that. The only outcome that counts is the one the controller's
    // independent verifier writes, `success_verified`; `verification_unavailable` and `verification_failed`
    // are both failures to confirm, and a run that could not be confirmed is not a verified run.
    const verified = step?.verification?.outcome === 'success_verified'
      || step?.steps?.[0]?.verification?.outcome === 'success_verified';
    const summary = String(step?.summary ?? step?.steps?.[0]?.summary ?? '').slice(0, MAX_REASON_CHARS)
      || (verified ? 'ran and verified' : 'ran without a verified result');
    const denied = step?.authorization?.decision === 'deny' || step?.steps?.[0]?.authorization?.decision === 'deny';
    return this.#record(order, runId, triggeredBy, {
      outcome: verified ? 'verified' : 'refused',
      operationId: operationId ?? step?.operationId ?? null,
      summary: denied ? `the ECP refused the run: ${summary}` : summary,
      verified,
    }, {
      status: verified ? 200 : 403,
      code: verified ? null : STANDING_ORDER_CODES.EXECUTION_REFUSED,
      viaController: ranThroughController,
    });
  }

  // Persist the outcome of one run and return the shape the routes and the tests read. The write is a
  // read-modify-write of the whole ledger, because the file holds every order and a partial update would
  // need a lock the rest of this codebase does not use.
  #record(order, runId, triggeredBy, outcome, meta) {
    const at = this.#now().toISOString();
    const entry = {
      runId,
      triggeredBy,
      executedAt: at,
      outcome: outcome.outcome,
      operationId: outcome.operationId,
      summary: outcome.summary,
      verified: outcome.verified === true,
    };
    const { orders } = this.#read();
    const index = orders.findIndex((candidate) => candidate.orderId === order.orderId);
    if (index === -1) {
      // The order was revoked while the run was in flight. The run happened - the capability ran - so
      // the outcome is still returned; there is simply no row left to record it against.
      return { orderId: order.orderId, runId, ...entry, order: null, recorded: false, status: meta.status, code: meta.code ?? null };
    }
    const current = orders[index];
    // A skipped run does not count as a run and does not move `lastRunAt`: counting a skipped attempt
    // would let the cooldown extend itself forever, because each skip would reset the window.
    const counted = outcome.outcome === 'verified';
    orders[index] = {
      ...current,
      runCount: current.runCount + (counted ? 1 : 0),
      lastRunAt: counted ? at : current.lastRunAt,
      lastRunId: runId,
      lastOutcome: outcome.outcome,
      updatedAt: at,
      history: [...current.history, entry].slice(-MAX_HISTORY),
    };
    this.#write(orders);
    if (meta.skipped !== true) {
      this.#recordOperation({
        capability: 'standing_order.run',
        request: `standing_order.run ${order.orderId} ${runId}`,
        step: {
          action: 'standing_order.run', orderId: order.orderId, runId,
          capabilityId: order.action.capabilityId, outcome: outcome.outcome, verified: outcome.verified === true,
        },
        viaController: meta.viaController === true,
      });
    }
    return {
      orderId: order.orderId,
      runId,
      ...entry,
      order: { ...orders[index], verified: true },
      recorded: true,
      skipped: meta.skipped === true,
      viaController: meta.viaController === true,
      retryAfterSec: meta.retryAfterSec ?? null,
      status: meta.status,
      code: meta.code ?? null,
    };
  }

  // ------------------------------------------------------------------------------- entry points ---

  async invoke(orderId, { reason = 'invoked from the owner surface' } = {}) {
    this.#refuseIfLocked();
    const wanted = String(orderId ?? '');
    const { orders } = this.#read();
    const order = orders.find((entry) => entry.orderId === wanted);
    if (!order) throw refused(STANDING_ORDER_CODES.NOT_FOUND, `no standing order with id ${wanted}`, { orderId: wanted }, 404);
    const result = await this.#run(order, 'manual_invoke');
    return { ...result, reason: text(reason, MAX_REASON_CHARS, 'reason'), verified: result.verified === true };
  }

  // Evaluate every enabled order whose trigger matches. An order whose trigger is not the event named is
  // not touched at all - not skipped, not recorded - because it was never a candidate.
  async evaluate({ eventType, dryRun = false } = {}) {
    this.#refuseIfLocked();
    if (!TRIGGER_EVENT_TYPES.includes(eventType)) {
      throw refused(STANDING_ORDER_CODES.INVALID_TRIGGER,
        `eventType must be one of ${TRIGGER_EVENT_TYPES.join(', ')}`, { eventType, allowed: [...TRIGGER_EVENT_TYPES] }, 400);
    }
    const { orders } = this.#read();
    const matched = orders.filter((order) => order.enabled && order.trigger.eventType === eventType);
    if (dryRun === true) {
      return {
        eventType,
        dryRun: true,
        matchedCount: matched.length,
        matched: matched.map((order) => ({ orderId: order.orderId, title: order.title, capabilityId: order.action.capabilityId })),
        runs: [],
        verified: true,
      };
    }
    const runs = [];
    for (const order of matched) {
      runs.push({ orderId: order.orderId, ...(await this.#run(order, eventType)) });
    }
    return {
      eventType,
      dryRun: false,
      matchedCount: matched.length,
      runs,
      // The evaluation verified when every run that could verify did. A cooldown skip is not a failure
      // of the evaluation - it is the rate limit doing its job - so it does not make the whole false.
      verified: runs.every((run) => run.outcome === 'verified' || run.outcome === 'cooldown_skipped'),
      summary: {
        ran: runs.filter((run) => run.outcome === 'verified').length,
        skipped: runs.filter((run) => run.outcome === 'cooldown_skipped').length,
        halted: runs.filter((run) => run.outcome === 'halted_by_lockdown').length,
        refused: runs.filter((run) => run.outcome === 'refused').length,
      },
    };
  }

  // ----------------------------------------------------------------------------- the audit line ---

  // The `operations.jsonl` receipt for a standing-order act. It is written by the same writer the other
  // capabilities use, so the trace walks it with everything else. A failure to append is swallowed: the
  // act is already persisted in the standing-order ledger, and a missing audit line must not undo it.
  #recordOperation({ capability, request, step, viaController = false }) {
    // A *run* that the controller executed already has a full record in `operations.jsonl` - the
    // authorization, the validation, the execution and the verification - because `standingOrderRun`
    // finalizes one. Writing a second, thinner line for the same act would put two rows in one ledger for
    // one run, and a reader counting runs would count them twice. So the run path defers to the
    // controller and says so with `viaController`.
    //
    // The three ledger acts are different: they change the order ledger and nothing else, they go through
    // the engine's own code, and no controller method writes an operation for them. They record here.
    if (viaController) return;
    if (typeof this.#operations !== 'function') return;
    try {
      const result = this.#operations({
        id: `${capability}-${this.#idFactory().replace(/-/g, '').slice(0, 16)}`,
        requestedAt: this.#now().toISOString(),
        capability,
        origin: 'user',
        status: 'success_verified',
        request,
        // The same slot a controller-finalized operation uses, so a reader that walks the ledger for a
        // verification outcome finds one on every line rather than on some lines only.
        steps: [{ ...step, verified: true, verification: { outcome: 'success_verified', detail: `the ${capability} act was recorded` } }],
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  // The record a trace or a panel reads for one order, with its runs resolved against the operation
  // ledger. It never invents a run: a run whose operation is missing is reported as missing.
  async detail(orderId) {
    const wanted = String(orderId ?? '');
    const { orders } = this.#read();
    const order = orders.find((entry) => entry.orderId === wanted);
    if (!order) return null;
    return { ...order, verified: true };
  }
}

// ------------------------------------------------------------------------------------ the policy ---

// The safe-capability policy, as a value a surface can render. The panel shows this list as the options
// in its capability select, so the set of things that CAN be delegated is visible rather than implied by
// what is missing from the list.
export function standingOrderPolicy(registry) {
  const capabilities = allowedStandingOrderCapabilities(registry);
  return {
    schema: STANDING_ORDER_POLICY_SCHEMA,
    verified: true,
    rule: 'a Standing Order may only carry a capability that declares reversibility reversible and blast radius local_state; nothing workspace_fs-mutating, irreversible, security-relevant or system-wide may ever execute above L2 Confirm',
    triggerEventTypes: [...TRIGGER_EVENT_TYPES],
    autonomyTiers: [...STANDING_ORDER_TIERS],
    allowedCapabilities: capabilities,
    forbiddenCapabilities: [...IMMUTABLE_GOVERNANCE, 'evolution.*'],
    forbiddenFamilies: ['anything workspace_fs-mutating', 'anything declaring system_latch or session', 'anything not reversible or read_only', 'anything declared high or critical risk'],
    defaults: { cooldownSec: DEFAULT_COOLDOWN_SEC, maxRunsPerHour: DEFAULT_MAX_RUNS_PER_HOUR },
    minimums: { cooldownSec: MIN_DEFAULT_COOLDOWN_SEC },
  };
}

// ------------------------------------------------------------------------ the read capabilities ---
//
// Two capabilities that are not new behaviour, only new names for behaviour that already had a service
// behind it: the doctor's six checks and the briefing the read route compiles. They are registered as
// capabilities because a Standing Order may only carry a *capability* - the engine reads the registry for
// the declaration and the ECP authorizes the execution - and because the brief names both in the safe
// set. Registering them is the honest way to make them delegable: the alternative would be an engine
// that special-cases service calls, which is an engine with a second, unaudited execution path.
//
// Both are `read_only` with a `none` blast radius, which is what they are: each one reads stores and
// returns a report and writes nothing at all.
export function standingOrderReadActions({ doctor = null, briefing = null } = {}) {
  const actions = [];
  if (doctor && typeof doctor.run === 'function') {
    actions.push({
      name: 'system.doctor',
      description: 'Run the doctor: the read-only checks over the memory, the operations, the conversation, the experience and prediction stores, the safety latch and the browser. It reports what it finds and changes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'system',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('system.doctor expects an object');
        for (const key of Object.keys(input)) throw new TypeError(`unexpected system.doctor input: ${key}`);
        return {};
      },
      async execute() {
        const report = await doctor.run();
        const checks = Array.isArray(report?.checks) ? report.checks : [];
        const failed = checks.filter((check) => check.status === 'failed');
        return {
          summary: failed.length === 0
            ? `doctor: ${checks.length} check(s), ${report?.status ?? 'unknown'}`
            : `doctor: ${failed.length} of ${checks.length} check(s) failed`,
          data: { status: report?.status ?? null, checkCount: checks.length, failedCount: failed.length, verified: true },
          display: [
            `Doctor finished: ${report?.status ?? 'unknown'} across ${checks.length} check(s).`,
            ...checks.map((check) => `- ${check.name}: ${check.status}`),
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the doctor returned no report' };
        if (!Number.isInteger(data.checkCount) || data.checkCount === 0) return { ok: false, detail: 'the report carried no checks' };
        return { ok: true, detail: `${data.checkCount} check(s), ${data.failedCount} failed` };
      },
    });
  }
  if (briefing && typeof briefing.latest === 'function') {
    actions.push({
      name: 'briefing.compile',
      description: 'Compile the current briefing and read its delta: what is due, what is owed, what changed since it was last acknowledged. Read-only; it composes a report from the stores that already exist.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'briefing',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('briefing.compile expects an object');
        for (const key of Object.keys(input)) throw new TypeError(`unexpected briefing.compile input: ${key}`);
        return {};
      },
      async execute() {
        const report = await briefing.latest();
        const summary = typeof report?.summary === 'string' && report.summary !== ''
          ? report.summary
          : `briefing with ${Array.isArray(report?.sections) ? report.sections.length : 0} section(s)`;
        return {
          summary: `briefing: ${summary}`.slice(0, 200),
          data: {
            compiledAt: report?.compiledAt ?? report?.at ?? null,
            sectionCount: Array.isArray(report?.sections) ? report.sections.length : 0,
            hasDelta: Boolean(report?.delta),
            verified: true,
          },
          display: `Briefing compiled: ${summary}`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the briefing returned no report' };
        return { ok: true, detail: `${data.sectionCount} section(s)` };
      },
    });
  }
  return actions;
}

// ------------------------------------------------------------------------------- capabilities ---

// The validate helpers all refuse an unexpected key, for the same reason every other capability in this
// codebase does: a caller that sends `{ capabillityId }` gets a refusal naming the typo rather than an
// order created with the default.
function expectKeys(input, allowed, name) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${name} expects an object`);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`unexpected ${name} input: ${key}`);
  }
  return input;
}

export function standingOrderActions(engine) {
  if (!engine || typeof engine.create !== 'function') throw new TypeError('standingOrderActions requires the engine');
  return [
    {
      name: 'standing_order.create',
      description: 'Register a Standing Order: a bounded, owner-written delegation that lets a named reversible local_state capability run when a named event occurs. Refused with STANDING_ORDER_CAPABILITY_FORBIDDEN for any capability that modifies the workspace, moves the safety latch, is security-relevant, or does not declare itself reversible - because nothing of that kind may ever execute above L2 Confirm. Refused with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"title":"Take a repository reading when the tree goes dirty","eventType":"workspace_dirty","capabilityId":"git.status_detailed","autonomyTier":"L3"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'standing_order',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['title', 'eventType', 'capabilityId', 'input', 'autonomyTier', 'cooldownSec', 'maxRunsPerHour', 'enabled'], 'standing_order.create');
        if (!value.title) throw new TypeError('standing_order.create needs a title');
        if (!value.eventType) throw new TypeError('standing_order.create needs an eventType');
        if (!value.capabilityId) throw new TypeError('standing_order.create needs a capabilityId');
        return value;
      },
      async execute(_ctx, input) {
        const order = engine.create(input);
        return {
          summary: `standing order ${order.orderId} created: ${order.action.capabilityId} on ${order.trigger.eventType}`,
          data: order,
          display: [
            `Standing order ${order.orderId}: ${order.title}`,
            `When ${order.trigger.eventType} occurs, ${order.action.capabilityId} may run (${order.trigger.cooldownSec}s cooldown, at most ${order.trigger.maxRunsPerHour}/hour).`,
            'The capability is reversible with a local_state blast radius, which is the only kind a Standing Order may carry.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the action returned no order' };
        if (data.verified !== true) return { ok: false, detail: 'the order was not marked verified' };
        if (!data.orderId || !String(data.orderId).startsWith('so_')) return { ok: false, detail: 'the order has no id' };
        if (data.history.length !== 0) return { ok: false, detail: 'a new order must start with no runs' };
        return { ok: true, detail: `registered ${data.orderId} for ${data.action.capabilityId}` };
      },
    },
    {
      name: 'standing_order.toggle',
      description: 'Pause or resume a Standing Order. A paused order keeps its history and its record; it simply stops being a candidate when its trigger fires. Refused with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"orderId":"so_...","enabled":false}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'standing_order',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['orderId', 'enabled'], 'standing_order.toggle');
        if (!value.orderId) throw new TypeError('standing_order.toggle needs an orderId');
        return value;
      },
      async execute(_ctx, input) {
        const order = engine.toggle(input.orderId, { enabled: typeof input.enabled === 'boolean' ? input.enabled : null });
        return {
          summary: `standing order ${order.orderId} is now ${order.enabled ? 'enabled' : 'paused'}`,
          data: order,
          display: `Standing order ${order.orderId} (${order.title}) is ${order.enabled ? 'ENABLED' : 'PAUSED'}.`,
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the toggle returned no verified order' };
        if (typeof input.enabled === 'boolean' && data.enabled !== input.enabled) {
          return { ok: false, detail: `the order reports enabled=${data.enabled} but ${input.enabled} was asked for` };
        }
        return { ok: true, detail: `enabled=${data.enabled}` };
      },
    },
    {
      name: 'standing_order.revoke',
      description: 'Revoke a Standing Order. The record leaves the ledger; the runs it already performed remain in operations.jsonl, so the audit trail survives the revocation.',
      inputHint: '{"orderId":"so_..."}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'standing_order',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['orderId'], 'standing_order.revoke');
        if (!value.orderId) throw new TypeError('standing_order.revoke needs an orderId');
        return value;
      },
      async execute(_ctx, input) {
        const result = engine.revoke(input.orderId);
        return {
          summary: `standing order ${result.orderId} revoked`,
          data: result,
          display: `Standing order ${result.orderId} (${result.title}) was revoked. Its past runs remain in the operations ledger.`,
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || data.verified !== true || data.revoked !== true) return { ok: false, detail: 'the revoke did not report success' };
        const still = await engine.detail(input.orderId);
        if (still !== null) return { ok: false, detail: 'the order is still in the ledger after the revoke' };
        return { ok: true, detail: `revoked ${data.orderId}` };
      },
    },
    {
      name: 'standing_order.invoke',
      description: 'Run one Standing Order now, through the ECP, as if its trigger had fired. The cooldown and hourly rate limit apply exactly as they do to an automatic trigger, and Lockdown halts the run rather than deferring it.',
      inputHint: '{"orderId":"so_..."}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'standing_order',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['orderId', 'reason'], 'standing_order.invoke');
        if (!value.orderId) throw new TypeError('standing_order.invoke needs an orderId');
        return value;
      },
      async execute(_ctx, input) {
        const result = await engine.invoke(input.orderId, { reason: input.reason });
        const line = result.outcome === 'verified'
          ? `Standing order ${result.orderId} ran ${result.order.action.capabilityId} and verified (run ${result.runId}).`
          : `Standing order ${result.orderId} did not verify: ${result.outcome} - ${result.summary}`;
        return {
          summary: result.outcome === 'verified'
            ? `${result.order.action.capabilityId} ran and verified (${result.runId})`
            : `${result.outcome}: ${result.summary}`,
          data: result,
          display: line,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the invoke returned nothing' };
        // A withheld run is not a failed capability: the cooldown did its job and said so.
        if (data.outcome === 'cooldown_skipped') return { ok: true, detail: data.summary };
        if (data.outcome === 'halted_by_lockdown') return { ok: true, detail: data.summary };
        if (data.outcome !== 'verified') return { ok: false, detail: data.summary || 'the run did not verify' };
        if (typeof data.operationId !== 'string' || data.operationId === '') {
          return { ok: false, detail: 'a verified run must name the operation it recorded' };
        }
        return { ok: true, detail: `${data.runId} verified via ${data.operationId}` };
      },
    },
    {
      name: 'standing_order.evaluate',
      description: 'Evaluate every enabled Standing Order whose trigger matches an event type. Each match runs through the ECP with its own cooldown and rate limit; a non-matching order is not touched at all. Lockdown halts the whole evaluation.',
      inputHint: '{"eventType":"workspace_dirty"}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'standing_order',
      autonomyLevel: 'L0',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['eventType', 'dryRun'], 'standing_order.evaluate');
        // No event named means a dry run of the trigger the owner is most likely asking about, which
        // changes nothing. The alternative - refusing - would make an L0 read fail when called with no
        // argument, and a read that cannot be called without one is a write wearing a read's declaration.
        return value;
      },
      async execute(_ctx, input) {
        const eventType = input.eventType ?? 'manual_invoke';
        const dryRun = input.dryRun === true || input.eventType === undefined || input.eventType === null;
        const result = await engine.evaluate({ eventType, dryRun });
        const line = result.dryRun
          ? `${result.matchedCount} standing order(s) would run for ${result.eventType}.`
          : `${result.matchedCount} standing order(s) matched ${result.eventType}: ${result.summary.ran} ran, ${result.summary.skipped} skipped, ${result.summary.halted} halted, ${result.summary.refused} refused.`;
        return { summary: line, data: result, display: line };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the evaluation returned nothing' };
        if (data.verified !== true) return { ok: false, detail: 'the evaluation did not verify' };
        if (data.matchedCount !== data.runs.length && data.dryRun !== true) {
          return { ok: false, detail: `${data.matchedCount} matched but ${data.runs.length} were run` };
        }
        return { ok: true, detail: `${data.matchedCount} matched, ${data.runs.length} run` };
      },
    },
  ];
}
