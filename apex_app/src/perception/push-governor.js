// T-32 Step 3 (2026-11-19): the Sentinel's push discipline (Part 4, Principle #6).
//
// A push is a notice the Sentinel decides to surface unprompted. The rule this module enforces:
//
//   * at most three non-critical pushes in any rolling hour;
//   * a push is deduplicated by the watch that raised it together with its signature, so the same
//     condition does not arrive twice inside the window even when it is re-detected;
//   * a critical push (safety, lockdown, degraded Core) bypasses both the cap and the cooldown,
//     because a cap that silences an alarm is worse than a noisy alarm;
//   * two dismissals of the same alert class suppress that class until a fixed expiry, and the rule
//     that does the suppressing is recorded, visible and revocable by the owner.
//
// The governor never decides that something *is* critical; the caller says so explicitly and the
// record keeps that classification. Nothing here writes a file: persistence belongs to the service
// that owns the ledger.
//
// T-42 Step 2: quiet hours live here, because "may this be surfaced" is already this module's
// question and a second answer elsewhere would be a second policy. The window is off by default and
// the clock is the injected one, so the behaviour is reproducible rather than wall-clock dependent.
import { resolveQuietHours, isQuietAt, quietHoursStatus } from './quiet-hours.js';

export const PUSH_GOVERNOR_SCHEMA = 'apex.push-governor/1';
export const PUSH_LIMIT_PER_HOUR = 3;
export const PUSH_WINDOW_MS = 60 * 60 * 1000;
export const DISMISSALS_TO_SUPPRESS = 2;
export const SUPPRESSION_TTL_MS = 6 * 60 * 60 * 1000;

const CRITICAL_CLASSES = Object.freeze(['safety', 'lockdown', 'degraded']);

function text(value, label, max = 120) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new TypeError(`${label} must be at most ${max} characters`);
  return trimmed;
}

export class PushGovernor {
  constructor({ now = () => new Date(), limit = PUSH_LIMIT_PER_HOUR, windowMs = PUSH_WINDOW_MS,
    suppressionTtlMs = SUPPRESSION_TTL_MS, dismissalsToSuppress = DISMISSALS_TO_SUPPRESS,
    quietHours = null } = {}) {
    if (!Number.isInteger(limit) || limit < 0) throw new TypeError('push limit must be a non-negative integer');
    this.now = now;
    this.limit = limit;
    this.windowMs = windowMs;
    this.suppressionTtlMs = suppressionTtlMs;
    this.dismissalsToSuppress = dismissalsToSuppress;
    this.quietHours = resolveQuietHours(quietHours === null ? { enabled: false } : quietHours);
    this.admissions = [];
    this.dismissals = [];
    this.rules = new Map();
    this.sequence = 0;
  }

  #at(at) {
    if (at instanceof Date) return at.getTime();
    // A number is already epoch milliseconds, which is what the internal calls pass; Date.parse on a
    // number would quietly produce NaN and empty the window.
    if (Number.isFinite(at)) return at;
    if (at === undefined || at === null) return this.now().getTime();
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : this.now().getTime();
  }

  // Admitted pushes inside the rolling window. Critical pushes are recorded but never counted
  // against the cap, so an alarm cannot consume the budget a later alarm needs.
  #recent(at) {
    const since = at - this.windowMs;
    // Entries carry an ISO timestamp for the owner to read; the window arithmetic is numeric, so the
    // comparison parses the stamp rather than comparing a string to a number.
    this.admissions = this.admissions.filter((entry) => Date.parse(entry.at) >= since);
    return this.admissions.filter((entry) => entry.admitted === true && entry.critical !== true);
  }

  activeSuppressions(at = this.now()) {
    const moment = this.#at(at);
    return [...this.rules.values()]
      .filter((rule) => rule.revokedAt === null && Date.parse(rule.suppressedUntil) > moment)
      .map((rule) => ({ ...rule }));
  }

  budget(at = this.now()) {
    const moment = this.#at(at);
    const used = this.#recent(moment).length;
    return Object.freeze({
      limit: this.limit,
      used,
      remaining: Math.max(0, this.limit - used),
      windowMs: this.windowMs,
      // The earliest admitted push is the one whose slot frees first, so it dates the window's end.
      windowEndsAt: used === 0
        ? null
        : new Date(Math.min(...this.#recent(moment).map((entry) => Date.parse(entry.at))) + this.windowMs).toISOString(),
      quietHours: quietHoursStatus(this.quietHours, moment),
    });
  }

  // The decision for one candidate push. `watch` names the producer, `signature` is the condition.
  admit({ watch, signature, critical = false, alertClass = null, summary = null, at } = {}) {
    const watchName = text(watch, 'watch', 60);
    const signatureText = text(signature, 'signature', 160);
    const moment = this.#at(at);
    const stamp = new Date(moment).toISOString();
    const isCritical = critical === true || (alertClass !== null && CRITICAL_CLASSES.includes(alertClass));
    const cls = alertClass === null || alertClass === undefined ? null : text(alertClass, 'alertClass', 40);

    const record = (admitted, reason, extra = {}) => {
      this.sequence += 1;
      const entry = Object.freeze({
        id: `push-${this.sequence}`, at: stamp, watch: watchName, signature: signatureText,
        alertClass: cls, critical: isCritical, summary: summary === null ? null : String(summary).slice(0, 240),
        admitted, reason,
        // Every decision carries the window it was made in, so a reader never has to infer why a
        // notice was held or guess whether quiet hours were even on.
        quietHours: quietHoursStatus(this.quietHours, moment),
        ...extra,
      });
      this.admissions.push(entry);
      return Object.freeze({ ...entry, budget: this.budget(moment) });
    };

    if (cls !== null) {
      const suppression = this.activeSuppressions(moment).find((rule) => rule.alertClass === cls);
      if (suppression && !isCritical) {
        return record(false, `alert class ${cls} is suppressed by the owner's rule until ${suppression.suppressedUntil}`);
      }
    }
    // Quiet hours hold a non-critical notice; they never hold an alarm. The record says which rule
    // held it, so the screen can name the window instead of implying the machine is healthy. That
    // the condition was derived and recorded is unaffected - only the surfacing is.
    if (!isCritical && isQuietAt(this.quietHours, moment)) {
      return record(false, 'quiet_hours');
    }
    if (!isCritical) {
      const recent = this.#recent(moment);
      const duplicate = recent.find((entry) => entry.watch === watchName && entry.signature === signatureText);
      if (duplicate) return record(false, `the same condition from ${watchName} was already surfaced at ${duplicate.at}`);
      if (recent.length >= this.limit) {
        return record(false, `${recent.length} non-critical pushes were already surfaced in the last ${Math.round(this.windowMs / 60000)} minutes`);
      }
    }
    return record(true, isCritical ? 'critical pushes bypass the hourly cap and the cooldown' : 'within the hourly budget');
  }

  // One dismissal. The second dismissal of a class records the suppression rule that silences it.
  dismiss({ alertClass, at } = {}) {
    const cls = text(alertClass, 'alertClass', 40);
    const moment = this.#at(at);
    const stamp = new Date(moment).toISOString();
    this.dismissals.push(Object.freeze({ at: stamp, alertClass: cls }));
    const count = this.dismissals.filter((entry) => entry.alertClass === cls).length;
    let rule = this.rules.get(cls) ?? null;
    if (count >= this.dismissalsToSuppress && (!rule || rule.revokedAt !== null)) {
      this.sequence += 1;
      rule = Object.freeze({
        id: `rule-${this.sequence}`,
        alertClass: cls,
        dismissals: count,
        createdAt: stamp,
        suppressedUntil: new Date(moment + this.suppressionTtlMs).toISOString(),
        revokedAt: null,
        revocable: true,
        basis: `${count} dismissals of ${cls}; the owner can revoke this rule at any time`,
      });
      this.rules.set(cls, rule);
    }
    return Object.freeze({
      alertClass: cls,
      dismissals: count,
      suppressed: Boolean(rule && rule.revokedAt === null && Date.parse(rule.suppressedUntil) > moment),
      rule: rule ? { ...rule } : null,
      suppressions: this.activeSuppressions(moment),
    });
  }

  revoke(ruleId, { at } = {}) {
    const id = text(ruleId, 'ruleId', 40);
    const moment = this.#at(at);
    const rule = [...this.rules.values()].find((entry) => entry.id === id);
    if (!rule) return Object.freeze({ revoked: false, reason: 'UNKNOWN_RULE', ruleId: id });
    if (rule.revokedAt !== null) return Object.freeze({ revoked: true, alreadyRevoked: true, rule: { ...rule } });
    const revoked = Object.freeze({ ...rule, revokedAt: new Date(moment).toISOString() });
    this.rules.set(rule.alertClass, revoked);
    return Object.freeze({ revoked: true, alreadyRevoked: false, rule: { ...revoked } });
  }

  // T-34 Step 3 (2026-11-19): what the watched rules have actually done on this machine. The counters
  // come from the admissions this governor recorded - every evaluation, admitted or deduplicated -
  // and never from a rule's description. A rule that has never fired reports zero hits and no last
  // trigger rather than an age it cannot know.
  watchReport({ rules = [], at = this.now() } = {}) {
    const moment = this.#at(at);
    const suppressions = this.activeSuppressions(moment);
    const seen = new Map();
    for (const entry of this.admissions) {
      if (typeof entry.alertClass !== 'string' || entry.alertClass.length === 0) continue;
      const current = seen.get(entry.alertClass) ?? { hits: 0, admitted: 0, signature: null, lastTriggeredAt: null, lastReason: null };
      current.hits += 1;
      if (entry.admitted === true) current.admitted += 1;
      current.signature = typeof entry.signature === 'string' ? entry.signature : current.signature;
      current.lastTriggeredAt = entry.at ?? current.lastTriggeredAt;
      current.lastReason = entry.reason ?? current.lastReason;
      seen.set(entry.alertClass, current);
    }
    const declared = new Map((Array.isArray(rules) ? rules : []).map((rule) => [rule.alertClass, rule]));
    const classes = [...new Set([...declared.keys(), ...seen.keys()])].sort();
    return Object.freeze(classes.map((alertClass) => {
      const rule = declared.get(alertClass) ?? null;
      const counted = seen.get(alertClass) ?? { hits: 0, admitted: 0, signature: null, lastTriggeredAt: null, lastReason: null };
      const suppression = suppressions.find((entry) => entry.alertClass === alertClass) ?? null;
      return Object.freeze({
        alertClass,
        watch: rule?.watch ?? null,
        critical: rule?.critical === true,
        // The boundary the rule fires on, in the rule's own words. `null` when the class is one the
        // ledger recorded but this build does not declare, so a reader is never shown a guess.
        threshold: rule?.threshold ?? null,
        describe: rule?.describe ?? null,
        declared: rule !== null,
        signature: counted.signature,
        hits: counted.hits,
        admitted: counted.admitted,
        lastTriggeredAt: counted.lastTriggeredAt,
        lastReason: counted.lastReason,
        suppressed: suppression !== null,
        suppression: suppression ? { id: suppression.id, suppressedUntil: suppression.suppressedUntil } : null,
      });
    }));
  }

  snapshot(at = this.now()) {
    const moment = this.#at(at);
    return Object.freeze({
      schema: PUSH_GOVERNOR_SCHEMA,
      at: new Date(moment).toISOString(),
      budget: this.budget(moment),
      quietHours: quietHoursStatus(this.quietHours, moment),
      suppressions: this.activeSuppressions(moment),
      rules: [...this.rules.values()].map((rule) => ({ ...rule })),
      recent: this.admissions.slice(-20).map((entry) => ({ ...entry })),
    });
  }

  // Round-trip the state so the service that owns the ledger can persist it.
  toJSON() {
    return {
      sequence: this.sequence,
      admissions: this.admissions.map((entry) => ({ ...entry })),
      dismissals: this.dismissals.map((entry) => ({ ...entry })),
      rules: [...this.rules.values()].map((rule) => ({ ...rule })),
    };
  }

  load(state) {
    if (!state || typeof state !== 'object') return this;
    if (Array.isArray(state.admissions)) this.admissions = state.admissions.map((entry) => ({ ...entry }));
    if (Array.isArray(state.dismissals)) this.dismissals = state.dismissals.map((entry) => ({ ...entry }));
    if (Array.isArray(state.rules)) {
      this.rules = new Map(state.rules.filter((rule) => rule && typeof rule.alertClass === 'string')
        .map((rule) => [rule.alertClass, { ...rule }]));
    }
    if (Number.isSafeInteger(state.sequence)) this.sequence = state.sequence;
    return this;
  }
}
