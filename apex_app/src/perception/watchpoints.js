// T-45 Package 2 (2026-11-19): the Sentinel Watchpoints engine.
//
// A Watchpoint is a threshold the owner sets on a number the machine already measures. "Tell me when more
// than three files are dirty." "Tell me when anything is bound to a wildcard address." "Tell me when this
// process passes a gigabyte." The value of it is not the comparison - that is one line - it is that the
// rule outlives the conversation that set it, and that every evaluation is recorded so a breach can be
// read back with the number that caused it.
//
// Four rules govern this module:
//
//   1. **The measurement is the product's own reading, not a second one.** A Watchpoint names a metric
//      that is computed from a capability the system already runs - `git.status_detailed`,
//      `system.inspect_ports`, `system.inspect_processes`, `agenda.list` - and this engine reads those
//      through the registry like any other caller. A private implementation of "how many files are dirty"
//      would be a second answer that could disagree with the panel showing the first.
//   2. **A failed measurement is `unmeasured`, never `nominal`.** If the git read throws, the honest state
//      of a dirty-file watchpoint is that nobody knows, not that the tree is clean. Reporting the second
//      as though it were the first is how a monitor teaches its owner to ignore it.
//   3. **Overrides are explicit or absent.** `metricOverrides` exists so a test can hold a number still,
//      and it is only honoured when the caller passes it. The default path reads the machine.
//   4. **Lockdown halts the writes.** Creating, toggling, deleting and evaluating all refuse with 423
//      while the latch is up: a stopped system does not accept new standing instructions, and an
//      evaluation that recorded breaches would be a write.
//
// What a Watchpoint is *not*: it does not act. A breach is a recorded fact, not a trigger. Nothing fires
// when a threshold is crossed, because a monitor that acts is a Standing Order wearing a monitor's name,
// and Standing Orders are governed by their own rule - a much stricter one about what may be delegated.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WATCHPOINTS_SCHEMA = 'apex.perception.watchpoints/1';
export const WATCHPOINT_SCHEMA = 'apex.perception.watchpoint/1';

export const WATCHPOINT_CODES = Object.freeze({
  INVALID_WATCHPOINT_METRIC: 'INVALID_WATCHPOINT_METRIC',
  INVALID_WATCHPOINT_THRESHOLD: 'INVALID_WATCHPOINT_THRESHOLD',
  INVALID_WATCHPOINT_OPERATOR: 'INVALID_WATCHPOINT_OPERATOR',
  INVALID_WATCHPOINT_SEVERITY: 'INVALID_WATCHPOINT_SEVERITY',
  WATCHPOINT_NOT_FOUND: 'WATCHPOINT_NOT_FOUND',
  LOCKDOWN_ACTIVE: 'LOCKDOWN_ACTIVE',
  INVALID_INPUT: 'INVALID_INPUT',
});

// The four metrics the brief names, each with the capability it is measured from and the function that
// pulls the number out of that capability's result. Naming the source capability in the table is what
// makes rule 1 checkable rather than aspirational: there is one place a metric's origin is written down.
export const WATCHPOINT_METRICS = Object.freeze({
  dirty_files_count: Object.freeze({
    metric: 'dirty_files_count',
    capabilityId: 'git.status_detailed',
    label: 'Dirty files (staged + unstaged + untracked)',
    unit: 'files',
    // A build with no repository has no dirty files, and that is a measurement rather than a failure: the
    // capability itself reports `isRepo: false` without throwing.
    measure: (data) => {
      if (!data || data.isRepo === false) return 0;
      const staged = Array.isArray(data.staged) ? data.staged.length : 0;
      const unstaged = Array.isArray(data.unstaged) ? data.unstaged.length : 0;
      const untracked = Array.isArray(data.untracked) ? data.untracked.length : 0;
      return staged + unstaged + untracked;
    },
  }),
  external_ports_count: Object.freeze({
    metric: 'external_ports_count',
    capabilityId: 'system.inspect_ports',
    label: 'Listening sockets on a non-loopback address',
    unit: 'sockets',
    measure: (data) => {
      const value = data?.summary?.externalExposureCount;
      return Number.isFinite(value) ? value : null;
    },
  }),
  apex_rss_mb: Object.freeze({
    metric: 'apex_rss_mb',
    capabilityId: 'system.inspect_processes',
    label: 'Resident memory of this APEX process',
    unit: 'MB',
    measure: (data) => {
      const bytes = data?.apexProcess?.rssBytes;
      return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
    },
  }),
  overdue_commitments_count: Object.freeze({
    metric: 'overdue_commitments_count',
    capabilityId: 'agenda.list',
    label: 'Agenda commitments past their due date',
    unit: 'commitments',
    measure: (data) => {
      const value = data?.summary?.overdueCount;
      return Number.isFinite(value) ? value : null;
    },
  }),
});

export const WATCHPOINT_METRIC_NAMES = Object.freeze(Object.keys(WATCHPOINT_METRICS));
export const WATCHPOINT_OPERATORS = Object.freeze(['gt', 'gte', 'eq']);
export const WATCHPOINT_SEVERITIES = Object.freeze(['advisory', 'warning', 'critical']);
export const WATCHPOINT_STATES = Object.freeze(['unmeasured', 'nominal', 'breached', 'paused']);

const MAX_WATCHPOINTS = 64;
const MAX_HISTORY = 40;
const MAX_TITLE_CHARS = 120;

function refused(code, message, detail = {}, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.detail = detail;
  return error;
}

function plainText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refused(WATCHPOINT_CODES.INVALID_INPUT, `${label} must be a string`, {}, 400);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoOrNull(value) {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// The comparison, in one place, so the panel that draws the rule and the engine that evaluates it cannot
// disagree about what `gte` means.
export function compareToThreshold(measuredValue, operator, threshold) {
  if (!Number.isFinite(measuredValue) || !Number.isFinite(threshold)) return null;
  if (operator === 'gte') return measuredValue >= threshold;
  if (operator === 'eq') return measuredValue === threshold;
  return measuredValue > threshold;
}

// The rule stated as the reader sees it, and the phrase the panel prints.
// The state a rule returns to when it is enabled again. It is derived from the record rather than
// remembered in it, so pausing and resuming cannot change a judgement: the value and the threshold are both
// still on the record, and re-judging them gives the same answer they gave before.
function resumeState(watchpoint) {
  if (!Number.isFinite(watchpoint.lastMeasuredValue)) return 'unmeasured';
  const breached = compareToThreshold(watchpoint.lastMeasuredValue, watchpoint.operator, watchpoint.threshold);
  // A comparison that could not be made is not a pass. `unmeasured` is the only state that says nothing was
  // compared, and it is the honest answer here for the same reason it is on a fresh rule.
  if (breached === null) return 'unmeasured';
  return breached ? 'breached' : 'nominal';
}

export function describeRule(watchpoint) {
  const symbol = watchpoint.operator === 'gte' ? '>=' : (watchpoint.operator === 'eq' ? '==' : '>');
  const meta = WATCHPOINT_METRICS[watchpoint.metric];
  return `${watchpoint.metric} ${symbol} ${watchpoint.threshold}${meta ? ` ${meta.unit}` : ''}`;
}

export class SentinelWatchpoints {
  #file;
  #dataDir;
  #registry;
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
    lockdown = null,
    controller = null,
  } = {}) {
    if (!dataDir) throw new TypeError('SentinelWatchpoints requires a data directory');
    this.#dataDir = dataDir;
    this.#file = path.join(dataDir, 'sentinel-watchpoints.json');
    this.#registry = registry ?? null;
    this.#lockdown = typeof lockdown === 'function'
      ? lockdown
      : () => (controlPlane ?? this.#registry?.controlPlane)?.killSwitchStatus?.().active === true;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#operations = operations;
    this.#controller = controller;
  }

  attachController(controller) {
    this.#controller = controller ?? null;
    return this;
  }

  lockdownActive() {
    try {
      return this.#lockdown() === true;
    } catch {
      return true;
    }
  }

  // ------------------------------------------------------------------ persistence, failure-safe ---

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { present: false, corrupt: false, watchpoints: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { present: true, corrupt: true, watchpoints: [] };
    }
    if (!parsed || !Array.isArray(parsed.watchpoints)) return { present: true, corrupt: true, watchpoints: [] };
    const watchpoints = parsed.watchpoints.filter((entry) => entry && typeof entry === 'object' && typeof entry.watchpointId === 'string');
    return {
      present: true,
      corrupt: watchpoints.length !== parsed.watchpoints.length,
      watchpoints: watchpoints.map((entry) => this.#normalise(entry)),
    };
  }

  #write(watchpoints) {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const payload = { schema: WATCHPOINTS_SCHEMA, at: this.#now().toISOString(), watchpoints: watchpoints.map((entry) => ({ ...entry })) };
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, this.#file);
  }

  #normalise(entry) {
    const metric = WATCHPOINT_METRIC_NAMES.includes(entry.metric) ? entry.metric : 'dirty_files_count';
    const operator = WATCHPOINT_OPERATORS.includes(entry.operator) ? entry.operator : 'gt';
    const severity = WATCHPOINT_SEVERITIES.includes(entry.severity) ? entry.severity : 'advisory';
    const state = WATCHPOINT_STATES.includes(entry.lastState) ? entry.lastState : 'unmeasured';
    const createdAt = isoOrNull(entry.createdAt) ?? this.#now().toISOString();
    return {
      schema: WATCHPOINT_SCHEMA,
      watchpointId: String(entry.watchpointId),
      title: typeof entry.title === 'string' ? entry.title.slice(0, MAX_TITLE_CHARS) : 'untitled watchpoint',
      metric,
      operator,
      threshold: Number.isFinite(entry.threshold) ? entry.threshold : 0,
      severity,
      enabled: entry.enabled === true,
      evaluationCount: Number.isInteger(entry.evaluationCount) && entry.evaluationCount >= 0 ? entry.evaluationCount : 0,
      breachCount: Number.isInteger(entry.breachCount) && entry.breachCount >= 0 ? entry.breachCount : 0,
      lastEvaluatedAt: isoOrNull(entry.lastEvaluatedAt),
      lastMeasuredValue: Number.isFinite(entry.lastMeasuredValue) ? entry.lastMeasuredValue : null,
      lastState: state,
      lastEvalId: typeof entry.lastEvalId === 'string' ? entry.lastEvalId : null,
      history: Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY).map((record) => ({
        evalId: String(record?.evalId ?? ''),
        evaluatedAt: isoOrNull(record?.evaluatedAt) ?? createdAt,
        measuredValue: Number.isFinite(record?.measuredValue) ? record.measuredValue : null,
        threshold: Number.isFinite(record?.threshold) ? record.threshold : 0,
        breached: record?.breached === true,
        operationId: typeof record?.operationId === 'string' ? record.operationId : null,
      })) : [],
      createdAt,
      updatedAt: isoOrNull(entry.updatedAt) ?? createdAt,
      verified: true,
    };
  }

  // The row as the API and the panel read it, with the rule spelled out and the metric's own label.
  #shaped(watchpoint) {
    const meta = WATCHPOINT_METRICS[watchpoint.metric];
    return {
      ...watchpoint,
      rule: describeRule(watchpoint),
      metricLabel: meta?.label ?? watchpoint.metric,
      metricUnit: meta?.unit ?? '',
      sourceCapabilityId: meta?.capabilityId ?? null,
      // The state the panel colours. A paused watchpoint is paused whatever its last reading was; a live
      // one with no reading yet is unmeasured rather than nominal.
      displayState: watchpoint.enabled === false
        ? 'paused'
        : (watchpoint.lastState === 'breached' ? 'breached' : (watchpoint.lastMeasuredValue === null ? 'unmeasured' : 'nominal')),
    };
  }

  // ------------------------------------------------------------------------------- reading ---

  list() {
    const { present, corrupt, watchpoints } = this.#read();
    const shaped = watchpoints.map((entry) => this.#shaped(entry));
    return {
      schema: WATCHPOINTS_SCHEMA,
      verified: true,
      lockdownActive: this.lockdownActive(),
      ledger: { present, corrupt },
      metrics: WATCHPOINT_METRIC_NAMES.map((name) => ({
        metric: name,
        label: WATCHPOINT_METRICS[name].label,
        unit: WATCHPOINT_METRICS[name].unit,
        capabilityId: WATCHPOINT_METRICS[name].capabilityId,
      })),
      operators: [...WATCHPOINT_OPERATORS],
      severities: [...WATCHPOINT_SEVERITIES],
      watchpoints: shaped,
      summary: {
        totalCount: shaped.length,
        enabledCount: shaped.filter((entry) => entry.enabled).length,
        breachedCount: shaped.filter((entry) => entry.enabled && entry.lastState === 'breached').length,
        nominalCount: shaped.filter((entry) => entry.enabled && entry.lastState === 'nominal').length,
      },
    };
  }

  detail(watchpointId) {
    const wanted = String(watchpointId ?? '').trim();
    const { watchpoints } = this.#read();
    const found = watchpoints.find((entry) => entry.watchpointId === wanted);
    return found ? this.#shaped(found) : null;
  }

  // ------------------------------------------------------------------------------- writing ---

  create({ title, metric, operator = 'gt', threshold, severity = 'advisory', enabled = true } = {}) {
    this.#refuseIfLocked();
    const cleanTitle = plainText(title, MAX_TITLE_CHARS, 'title');
    if (cleanTitle === '') throw refused(WATCHPOINT_CODES.INVALID_INPUT, 'a watchpoint needs a title', {}, 400);
    if (!WATCHPOINT_METRIC_NAMES.includes(metric)) {
      throw refused(WATCHPOINT_CODES.INVALID_WATCHPOINT_METRIC,
        `metric must be one of ${WATCHPOINT_METRIC_NAMES.join(', ')}`,
        { metric, allowed: [...WATCHPOINT_METRIC_NAMES] }, 400);
    }
    if (!WATCHPOINT_OPERATORS.includes(operator)) {
      throw refused(WATCHPOINT_CODES.INVALID_WATCHPOINT_OPERATOR,
        `operator must be one of ${WATCHPOINT_OPERATORS.join(', ')}`,
        { operator, allowed: [...WATCHPOINT_OPERATORS] }, 400);
    }
    if (!WATCHPOINT_SEVERITIES.includes(severity)) {
      throw refused(WATCHPOINT_CODES.INVALID_WATCHPOINT_SEVERITY,
        `severity must be one of ${WATCHPOINT_SEVERITIES.join(', ')}`,
        { severity, allowed: [...WATCHPOINT_SEVERITIES] }, 400);
    }
    // A threshold is a non-negative whole number. `NaN`, a string that is not a number, or Infinity is
    // refused rather than coerced: a watchpoint whose bound is `NaN` compares false forever and looks like a
    // monitor that never fires.
    //
    // The whole-number rule is not decoration. Every one of the four metrics is a count of files, sockets or
    // commitments, or a count of megabytes - and being counts, none of them can be negative or fractional.
    // A threshold of `-1` on `dirty_files_count` would be breached by a clean tree, and a threshold of `0.5`
    // would be breached by nothing, because the measured value is always a whole number of files. Both read
    // as a rule that works and are in fact rules that cannot mean what their author intended, so both are
    // refused at the door with the bound the author wrote.
    const numeric = typeof threshold === 'string' && threshold.trim() !== '' ? Number(threshold) : threshold;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
      throw refused(WATCHPOINT_CODES.INVALID_WATCHPOINT_THRESHOLD,
        'threshold must be a whole number, zero or greater',
        { threshold: String(threshold).slice(0, 40) }, 400);
    }
    const { watchpoints } = this.#read();
    if (watchpoints.length >= MAX_WATCHPOINTS) {
      throw refused(WATCHPOINT_CODES.INVALID_INPUT,
        `the watchpoints hold their limit of ${MAX_WATCHPOINTS} entries; delete some first`, {}, 400);
    }
    const at = this.#now().toISOString();
    const watchpoint = this.#normalise({
      watchpointId: `wp_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`,
      title: cleanTitle,
      metric,
      operator,
      threshold: numeric,
      severity,
      enabled: enabled === true,
      evaluationCount: 0,
      breachCount: 0,
      lastEvaluatedAt: null,
      lastMeasuredValue: null,
      lastState: 'unmeasured',
      lastEvalId: null,
      history: [],
      createdAt: at,
      updatedAt: at,
      verified: true,
    });
    watchpoints.push(watchpoint);
    this.#write(watchpoints);
    this.#recordOperation({
      capability: 'watchpoint.create',
      request: `watchpoint.create ${watchpoint.watchpointId} ${watchpoint.rule ?? describeRule(watchpoint)}`.slice(0, 200),
      step: {
        action: 'watchpoint.create', watchpointId: watchpoint.watchpointId,
        metric: watchpoint.metric, operator: watchpoint.operator, threshold: watchpoint.threshold,
        severity: watchpoint.severity,
      },
    });
    return this.#shaped(watchpoint);
  }

  toggle(watchpointId, { enabled = null } = {}) {
    this.#refuseIfLocked();
    const wanted = String(watchpointId ?? '').trim();
    const { watchpoints } = this.#read();
    const index = watchpoints.findIndex((entry) => entry.watchpointId === wanted);
    if (index === -1) {
      throw refused(WATCHPOINT_CODES.WATCHPOINT_NOT_FOUND, `no watchpoint named ${wanted.slice(0, 60)}`, { watchpointId: wanted }, 404);
    }
    const current = watchpoints[index];
    const next = typeof enabled === 'boolean' ? enabled : !current.enabled;
    const at = this.#now().toISOString();
    // Pausing changes the state to `paused`; enabling returns it to whatever its last reading JUDGED, or
    // `unmeasured` if it has never been evaluated. A watchpoint that was breached and paused and then
    // enabled is breached again - the reading did not change because the monitor was off.
    //
    // The judgement is recomputed from the stored value and the stored threshold rather than read back from
    // the state, because the state is exactly what pausing overwrote: a rule that recorded `paused` has no
    // memory of whether it had been breached, and assuming `nominal` would turn a breach into a pass the
    // first time someone paused and resumed a rule.
    watchpoints[index] = {
      ...current,
      enabled: next,
      lastState: next ? resumeState(current) : 'paused',
      updatedAt: at,
    };
    this.#write(watchpoints);
    this.#recordOperation({
      capability: 'watchpoint.toggle',
      request: `watchpoint.toggle ${wanted} enabled=${next}`.slice(0, 200),
      step: { action: 'watchpoint.toggle', watchpointId: wanted, enabled: next },
    });
    return this.#shaped(watchpoints[index]);
  }

  remove(watchpointId) {
    this.#refuseIfLocked();
    const wanted = String(watchpointId ?? '').trim();
    const { watchpoints } = this.#read();
    const index = watchpoints.findIndex((entry) => entry.watchpointId === wanted);
    if (index === -1) {
      throw refused(WATCHPOINT_CODES.WATCHPOINT_NOT_FOUND, `no watchpoint named ${wanted.slice(0, 60)}`, { watchpointId: wanted }, 404);
    }
    const [removed] = watchpoints.splice(index, 1);
    this.#write(watchpoints);
    this.#recordOperation({
      capability: 'watchpoint.delete',
      request: `watchpoint.delete ${wanted}`.slice(0, 200),
      step: { action: 'watchpoint.delete', watchpointId: wanted, metric: removed.metric, threshold: removed.threshold },
    });
    return { watchpointId: wanted, title: removed.title, deleted: true, verified: true };
  }

  // --------------------------------------------------------------------------- measuring ---

  // Measure one metric by running the capability that owns it, through the controller path so the read is
  // authorized and audited like every other read. Returns `{ value, error }`: a null value with no error
  // means the capability answered but the number was absent, which is `unmeasured`.
  async #measure(metricName, { metricOverrides = null } = {}) {
    if (metricOverrides && Object.prototype.hasOwnProperty.call(metricOverrides, metricName)) {
      const override = metricOverrides[metricName];
      return { value: Number.isFinite(override) ? override : null, error: null, source: 'override' };
    }
    const meta = WATCHPOINT_METRICS[metricName];
    if (!meta) return { value: null, error: 'unknown metric', source: 'none' };
    if (!this.#registry || typeof this.#registry.get !== 'function') {
      return { value: null, error: 'no registry is configured, so the metric cannot be measured', source: 'none' };
    }
    const definition = this.#registry.get(meta.capabilityId);
    if (!definition) {
      // A build with no workspace root has no git capability. That is a measurement of zero dirty files
      // rather than an error, because the metric's own definition says so.
      if (metricName === 'dirty_files_count') return { value: 0, error: null, source: 'unregistered' };
      return { value: null, error: `${meta.capabilityId} is not registered in this build`, source: 'none' };
    }
    try {
      const result = await definition.execute({ origin: 'user', autonomyLevel: definition.autonomyLevel }, {});
      const value = meta.measure(result?.data ?? null);
      return { value: Number.isFinite(value) ? value : null, error: null, source: 'capability' };
    } catch (error) {
      return { value: null, error: String(error?.message ?? error).slice(0, 200), source: 'capability' };
    }
  }

  // Evaluate every enabled watchpoint. The measurement is taken once per metric rather than once per
  // watchpoint: two watchpoints on the same metric in one evaluation must see the same number, or the
  // report contradicts itself.
  async evaluate({ metricOverrides = null } = {}) {
    this.#refuseIfLocked();
    const { watchpoints } = this.#read();
    const evaluable = watchpoints.filter((entry) => entry.enabled);
    const evaluatedAt = this.#now().toISOString();
    const evalId = `wpe_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`;

    const metrics = [...new Set(evaluable.map((entry) => entry.metric))];
    const measured = new Map();
    for (const metric of metrics) {
      measured.set(metric, await this.#measure(metric, { metricOverrides }));
    }

    const results = [];
    for (const watchpoint of watchpoints) {
      if (!watchpoint.enabled) {
        results.push({
          watchpointId: watchpoint.watchpointId,
          title: watchpoint.title,
          skipped: true,
          reason: 'paused',
          state: 'paused',
        });
        continue;
      }
      const reading = measured.get(watchpoint.metric) ?? { value: null, error: 'not measured', source: 'none' };
      const measuredValue = reading.value;
      // A measurement that did not produce a number leaves the watchpoint unmeasured. It is not a breach
      // and it is not a pass, and recording it as either would be an invented answer.
      const breached = measuredValue === null ? null : compareToThreshold(measuredValue, watchpoint.operator, watchpoint.threshold);
      const state = measuredValue === null ? 'unmeasured' : (breached ? 'breached' : 'nominal');
      const index = watchpoints.findIndex((entry) => entry.watchpointId === watchpoint.watchpointId);
      const next = {
        ...watchpoint,
        evaluationCount: watchpoint.evaluationCount + 1,
        breachCount: watchpoint.breachCount + (breached === true ? 1 : 0),
        lastEvaluatedAt: evaluatedAt,
        lastMeasuredValue: measuredValue,
        lastState: state,
        lastEvalId: evalId,
        updatedAt: evaluatedAt,
        history: [...watchpoint.history, {
          evalId,
          evaluatedAt,
          measuredValue,
          threshold: watchpoint.threshold,
          breached: breached === true,
          operationId: null,
        }].slice(-MAX_HISTORY),
      };
      watchpoints[index] = next;
      results.push({
        watchpointId: next.watchpointId,
        title: next.title,
        metric: next.metric,
        rule: describeRule(next),
        threshold: next.threshold,
        measuredValue,
        breached: breached === true,
        state,
        severity: next.severity,
        source: reading.source,
        error: reading.error,
      });
    }

    const changed = results.some((entry) => !entry.skipped);
    if (changed) this.#write(watchpoints);

    const evaluated = results.filter((entry) => !entry.skipped);
    const evaluatedResult = {
      schema: WATCHPOINTS_SCHEMA,
      verified: true,
      evalId,
      evaluatedAt,
      results,
      breachedCount: evaluated.filter((entry) => entry.breached === true).length,
      summary: {
        evaluatedCount: evaluated.length,
        skippedCount: results.length - evaluated.length,
        breachedCount: evaluated.filter((entry) => entry.breached === true).length,
        nominalCount: evaluated.filter((entry) => entry.state === 'nominal').length,
        unmeasuredCount: evaluated.filter((entry) => entry.state === 'unmeasured').length,
      },
    };

    // The evaluation is a write when it recorded anything, so it is audited. The operation id is stamped
    // onto this evaluation's history rows so a trace can reach the receipt from the record.
    if (changed) {
      const operationId = this.#recordOperation({
        capability: 'watchpoint.evaluate',
        request: `watchpoint.evaluate ${evaluated.length} watchpoint(s)`.slice(0, 200),
        step: {
          action: 'watchpoint.evaluate', evalId, evaluatedCount: evaluated.length,
          breachedCount: evaluatedResult.breachedCount,
          results: evaluated.map((entry) => ({ watchpointId: entry.watchpointId, measuredValue: entry.measuredValue, breached: entry.breached })),
        },
      });
      if (typeof operationId === 'string') {
        evaluatedResult.operationId = operationId;
        const { watchpoints: fresh } = this.#read();
        for (const watchpoint of fresh) {
          const last = watchpoint.history[watchpoint.history.length - 1];
          if (last && last.evalId === evalId) last.operationId = operationId;
        }
        this.#write(fresh);
        for (const result of evaluatedResult.results) if (!result.skipped) result.operationId = operationId;
      }
    }
    return evaluatedResult;
  }

  #refuseIfLocked() {
    if (this.lockdownActive()) {
      throw refused(WATCHPOINT_CODES.LOCKDOWN_ACTIVE,
        'Lockdown is engaged, so watchpoints may not be created, changed, deleted or evaluated; release the latch first',
        { lockdownActive: true }, 423);
    }
  }

  #recordOperation({ capability, request, step }) {
    if (typeof this.#operations !== 'function') return null;
    const id = `${capability}-${this.#idFactory().replace(/-/g, '').slice(0, 16)}`;
    try {
      const result = this.#operations({
        id,
        requestedAt: this.#now().toISOString(),
        capability,
        origin: 'user',
        status: 'success_verified',
        request,
        steps: [{ ...step, verified: true, verification: { outcome: 'success_verified', detail: `the ${capability} act was recorded` } }],
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Swallowed: the ledger write is a second record, and failing it must not undo the first.
      return null;
    }
    return id;
  }
}

// ------------------------------------------------------------------------------- capabilities ---

function expectKeys(input, allowed, name) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${name} expects an object`);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`unexpected ${name} input: ${key}`);
  }
  return input;
}

export function watchpointActions(engine) {
  if (!engine || typeof engine.create !== 'function') throw new TypeError('watchpointActions requires the engine');
  return [
    {
      name: 'watchpoint.list',
      description: 'Read the Sentinel Watchpoints: every threshold the owner has set on a live workstation metric, with its rule, its last measured value and its state. Reads one ledger and writes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'watchpoint',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) { return expectKeys(input, [], 'watchpoint.list'); },
      async execute() {
        const view = engine.list();
        return {
          summary: `watchpoints: ${view.summary.totalCount} total, ${view.summary.breachedCount} breached`,
          data: view,
          display: `${view.summary.totalCount} watchpoint(s): ${view.summary.enabledCount} enabled, ${view.summary.breachedCount} breached, ${view.summary.nominalCount} nominal.`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the watchpoint list did not verify' };
        if (!Array.isArray(data.watchpoints)) return { ok: false, detail: 'the list returned no watchpoints array' };
        return { ok: true, detail: `${data.summary.totalCount} watchpoints` };
      },
    },
    {
      name: 'watchpoint.create',
      description: 'Create a Sentinel Watchpoint: a numeric threshold the owner sets on a live metric - dirty files, externally exposed ports, this process\'s resident memory, or overdue commitments. Refused with INVALID_WATCHPOINT_METRIC or INVALID_WATCHPOINT_THRESHOLD on bad input, and with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"title":"Warn when more than 3 files are dirty","metric":"dirty_files_count","operator":"gt","threshold":3,"severity":"warning"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'watchpoint',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['title', 'metric', 'operator', 'threshold', 'severity', 'enabled'], 'watchpoint.create');
        if (!value.title) throw new TypeError('watchpoint.create needs a title');
        if (!value.metric) throw new TypeError('watchpoint.create needs a metric');
        if (value.threshold === undefined || value.threshold === null) throw new TypeError('watchpoint.create needs a threshold');
        return value;
      },
      async execute(_ctx, input) {
        const watchpoint = engine.create(input);
        return {
          summary: `watchpoint ${watchpoint.watchpointId} created: ${watchpoint.rule}`,
          data: watchpoint,
          display: `Watchpoint ${watchpoint.watchpointId} (${watchpoint.title}) is ${watchpoint.rule}, severity ${watchpoint.severity}.`,
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the create returned no verified watchpoint' };
        if (!String(data.watchpointId ?? '').startsWith('wp_')) return { ok: false, detail: 'the watchpoint has no id' };
        if (data.threshold !== Number(input.threshold)) return { ok: false, detail: `threshold is ${data.threshold}, not ${input.threshold}` };
        if (data.evaluationCount !== 0) return { ok: false, detail: 'a new watchpoint must start unevaluated' };
        return { ok: true, detail: `created ${data.watchpointId}` };
      },
    },
    {
      name: 'watchpoint.toggle',
      description: 'Pause or resume a Sentinel Watchpoint. A paused watchpoint keeps its history and its rule; it simply stops being evaluated. Refused with WATCHPOINT_NOT_FOUND for an unknown id and with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"watchpointId":"wp_...","enabled":false}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'watchpoint',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['watchpointId', 'enabled'], 'watchpoint.toggle');
        if (!value.watchpointId) throw new TypeError('watchpoint.toggle needs a watchpointId');
        return value;
      },
      async execute(_ctx, input) {
        const watchpoint = engine.toggle(input.watchpointId, { enabled: typeof input.enabled === 'boolean' ? input.enabled : null });
        return {
          summary: `watchpoint ${watchpoint.watchpointId} is now ${watchpoint.enabled ? 'enabled' : 'paused'}`,
          data: watchpoint,
          display: `Watchpoint ${watchpoint.watchpointId} (${watchpoint.title}) is ${watchpoint.displayState.toUpperCase()}.`,
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the toggle returned no verified watchpoint' };
        if (typeof input.enabled === 'boolean' && data.enabled !== input.enabled) {
          return { ok: false, detail: `the watchpoint reports enabled=${data.enabled} but ${input.enabled} was asked for` };
        }
        return { ok: true, detail: `enabled=${data.enabled}` };
      },
    },
    {
      name: 'watchpoint.delete',
      description: 'Delete a Sentinel Watchpoint. The record leaves the ledger; the evaluations it already recorded remain in operations.jsonl, so the audit trail survives the deletion. Refused with WATCHPOINT_NOT_FOUND for an unknown id and with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"watchpointId":"wp_..."}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'watchpoint',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['watchpointId'], 'watchpoint.delete');
        if (!value.watchpointId) throw new TypeError('watchpoint.delete needs a watchpointId');
        return value;
      },
      async execute(_ctx, input) {
        const result = engine.remove(input.watchpointId);
        return {
          summary: `watchpoint ${result.watchpointId} deleted`,
          data: result,
          display: `Watchpoint ${result.watchpointId} (${result.title}) was deleted. Its past evaluations remain in the operations ledger.`,
        };
      },
      async verify(_ctx, input, result) {
        const data = result?.data;
        if (!data || data.deleted !== true) return { ok: false, detail: 'the delete did not report success' };
        if (engine.detail(input.watchpointId) !== null) return { ok: false, detail: 'the watchpoint is still in the ledger after the delete' };
        return { ok: true, detail: `deleted ${data.watchpointId}` };
      },
    },
    {
      name: 'watchpoint.evaluate',
      description: 'Evaluate every enabled Sentinel Watchpoint against the live machine: measure each metric by running the capability that owns it, compare it to the rule, and record the reading. A paused watchpoint is skipped; a metric that could not be measured leaves its watchpoint unmeasured rather than nominal. Note that this act writes the readings it takes, so it is refused with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"metricOverrides":{"apex_rss_mb":900}}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'watchpoint',
      autonomyLevel: 'L1',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) { return expectKeys(input, ['metricOverrides'], 'watchpoint.evaluate'); },
      async execute(_ctx, input) {
        // The evaluation writes the reading it took, which is why its declaration is a write even though
        // the measurement is a read. A declaration that said `read` would let a Lockdown that halts writes
        // be bypassed by the act that records what it saw.
        const result = await engine.evaluate({ metricOverrides: input?.metricOverrides ?? null });
        return {
          summary: `evaluated ${result.summary.evaluatedCount} watchpoint(s): ${result.summary.breachedCount} breached, ${result.summary.nominalCount} nominal, ${result.summary.unmeasuredCount} unmeasured`,
          data: result,
          display: [
            `Evaluated at ${result.evaluatedAt}: ${result.summary.evaluatedCount} watchpoint(s), ${result.summary.skippedCount} paused.`,
            ...result.results.filter((entry) => !entry.skipped)
              .map((entry) => `${entry.watchpointId}: ${entry.rule} -> ${entry.measuredValue ?? 'unmeasured'} (${entry.state})`),
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the evaluation did not verify' };
        if (!Array.isArray(data.results)) return { ok: false, detail: 'the evaluation returned no results' };
        const breached = data.results.filter((entry) => !entry.skipped && entry.breached === true).length;
        if (breached !== data.breachedCount) {
          return { ok: false, detail: `${breached} results are breached but the summary says ${data.breachedCount}` };
        }
        return { ok: true, detail: `${data.summary.evaluatedCount} evaluated, ${data.breachedCount} breached` };
      },
    },
  ];
}
