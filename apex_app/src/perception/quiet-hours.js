// T-42 Step 2 (2026-11-19): the Sentinel's quiet hours.
//
// The owner's machine has hours the owner does not want interrupted. Quiet hours are a *delivery*
// rule, not a perception rule and not a truth rule: during the window the Sentinel still reads, still
// derives advisories and still records every one of them. What it does not do is surface a
// non-critical notice. A critical notice is never quiet - a cap or a window that silences an alarm is
// worse than a noisy alarm, which is the same reason the hourly cap already exempts critical pushes.
//
// Two properties matter more than the feature:
//
//   1. It is *off by default*. A wall-clock-dependent default is a test that fails at 22:00 and
//      passes at 09:00, which is not a test. A deployment that wants quiet hours turns them on and
//      names the window; every other deployment keeps its exact previous behaviour.
//   2. The clock is injectable. `nowFn` is how a test proves the inside-of-window branch and the
//      outside-of-window branch without waiting for the wall clock to get there.
//
// The window is named in whole hours. `startHour` is when quiet begins and `endHour` is when it ends,
// and a window that wraps midnight (22 -> 07) is the common case rather than a special case. Hours are
// UTC unless `utcOffsetHours` shifts them, so the arithmetic is reproducible on any host.
export const QUIET_HOURS_SCHEMA = 'apex.quiet-hours/1';
export const QUIET_HOURS_DEFAULT_START = 22;
export const QUIET_HOURS_DEFAULT_END = 7;
export const QUIET_HOURS_DEFAULT_OFFSET_HOURS = 0;

function hour(value, label) {
  if (Number.isInteger(value) && value >= 0 && value <= 23) return value;
  throw new TypeError(`${label} must be an integer hour from 0 to 23`);
}

function offsetHours(value) {
  if (Number.isFinite(value) && Math.abs(value) <= 14) return value;
  throw new TypeError('utcOffsetHours must be a number from -14 to 14');
}

// The declared policy, normalised. `enabled` defaults to false so an unconfigured governor is exactly
// the governor this product shipped before quiet hours existed.
export function resolveQuietHours({ enabled = false, startHour = QUIET_HOURS_DEFAULT_START,
  endHour = QUIET_HOURS_DEFAULT_END, utcOffsetHours = QUIET_HOURS_DEFAULT_OFFSET_HOURS } = {}) {
  const start = hour(startHour, 'quietHours.startHour');
  const end = hour(endHour, 'quietHours.endHour');
  // A window that starts and ends at the same hour is empty, not a whole day: "quiet from 09:00 to
  // 09:00" asks for no quiet at all, and treating it as all-day would be the surprising reading.
  if (start === end) throw new TypeError('quietHours.startHour and quietHours.endHour must differ');
  return Object.freeze({
    schema: QUIET_HOURS_SCHEMA,
    enabled: enabled === true,
    startHour: start,
    endHour: end,
    utcOffsetHours: offsetHours(utcOffsetHours),
    window: Object.freeze({ startHour: start, endHour: end, utcOffsetHours: offsetHours(utcOffsetHours) }),
  });
}

// `APEX_QUIET_HOURS` is the environment form, so an operator can set a window without editing a
// config file: "22-07", "22-7", or "off"/"" to disable. Anything unparseable is a startup error, not
// a silently ignored setting - an operator who believes quiet hours are on and finds they are not
// has been lied to by the tool.
export function quietHoursFromEnv(value, base = {}) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (text.length === 0) return null;
  if (text === 'off' || text === 'false' || text === 'none' || text === 'disabled') {
    return resolveQuietHours({ ...base, enabled: false });
  }
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
  if (!match) throw new TypeError('APEX_QUIET_HOURS must look like "22-07", or be "off"');
  return resolveQuietHours({ ...base, enabled: true, startHour: Number(match[1]), endHour: Number(match[2]) });
}

// The hour of the wall clock the window is named in.
export function quietHourOf(moment, { utcOffsetHours = 0 } = {}) {
  const ms = moment instanceof Date ? moment.getTime() : new Date(moment).getTime();
  if (!Number.isFinite(ms)) return null;
  const shifted = ms + utcOffsetHours * 60 * 60 * 1000;
  return new Date(shifted).getUTCHours();
}

// Whether the window is open at this instant. A wrapping window (22 -> 7) is open when the hour has
// passed the start *or* has not yet reached the end; a normal window (1 -> 5) is open in between.
export function isQuietAt(quietHours, moment) {
  const policy = quietHours ?? resolveQuietHours();
  if (policy.enabled !== true) return false;
  const current = quietHourOf(moment, policy);
  if (current === null) return false;
  const { startHour, endHour } = policy;
  return startHour > endHour
    ? (current >= startHour || current < endHour)
    : (current >= startHour && current < endHour);
}

// The projection the UI and `/api/perception` read. `activeNow` is computed from the same injected
// clock the governor admits on, so the surface and the decision can never disagree.
export function quietHoursStatus(quietHours, moment) {
  const policy = quietHours ?? resolveQuietHours();
  return Object.freeze({
    enabled: policy.enabled === true,
    activeNow: isQuietAt(policy, moment),
    window: policy.window,
  });
}
