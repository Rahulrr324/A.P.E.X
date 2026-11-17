// Deterministic calendar/time provider. The schedule is configured locally as a bounded list of
// events; no account, credential or network call is involved. A configured event is schedule
// metadata (`calendar_event_scheduled` / `calendar_event_updated`), while an approaching, started or
// ended notice is an observation about time passing. Updates change the stable identity, so they are
// distinguishable from a replay of the same schedule.
import { ValidationError } from '../../errors.js';
import { DEFAULT_COMMON_CONFIG, LIMITS, PERMISSIONS, PROVIDER_API_VERSION } from '../vocabulary.js';
import { hash, integer, isoInstant, mergeCommon, optionalText, text } from '../model.js';

const DEFAULTS = Object.freeze({
  ...DEFAULT_COMMON_CONFIG,
  events: Object.freeze([]),
  horizonDays: 30,
  entityId: null,
});

const MAX_TITLE = 200;

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function normalizeEvent(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`event ${index + 1} must be an object`);
  const allowed = ['id', 'title', 'start', 'end', 'timezone', 'reminderMinutes', 'location'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ValidationError(`event ${index + 1} has an unexpected field "${String(key).slice(0, 40)}"`);
  }
  const id = text(raw.id, `event ${index + 1} id`, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new ValidationError(`event ${index + 1} id is not a stable reference`);
  const start = isoInstant(raw.start, `event ${index + 1} start`);
  const end = isoInstant(raw.end, `event ${index + 1} end`);
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(start) || !/(?:Z|[+-]\d\d:\d\d)$/.test(end)) {
    throw new ValidationError(`event ${index + 1} must state an explicit UTC offset or Z`);
  }
  if (Date.parse(end) <= Date.parse(start)) throw new ValidationError(`event ${index + 1} ends before it starts`);
  const timezone = raw.timezone === undefined || raw.timezone === null ? null : text(raw.timezone, `event ${index + 1} timezone`, 64);
  if (timezone !== null && !validTimezone(timezone)) throw new ValidationError(`event ${index + 1} timezone "${timezone}" is not an IANA zone`);
  return {
    id,
    title: text(raw.title, `event ${index + 1} title`, MAX_TITLE),
    start,
    end,
    timezone,
    reminderMinutes: integer(raw.reminderMinutes ?? 15, `event ${index + 1} reminderMinutes`, { min: 0, max: 10080 }),
    location: optionalText(raw.location, `event ${index + 1} location`, 200),
  };
}

function validate(config) {
  const merged = mergeCommon(DEFAULTS, config);
  if (!Array.isArray(merged.events)) throw new ValidationError('events must be a list');
  if (merged.events.length > LIMITS.maxCalendarEvents) throw new ValidationError(`events holds more than ${LIMITS.maxCalendarEvents} entries`);
  const events = merged.events.map((event, index) => normalizeEvent(event, index));
  const ids = new Set();
  for (const event of events) {
    if (ids.has(event.id)) throw new ValidationError(`calendar event id "${event.id}" is repeated`);
    ids.add(event.id);
  }
  return {
    ...merged,
    events,
    horizonDays: integer(merged.horizonDays, 'horizonDays', { min: 1, max: 365 }),
    entityId: optionalText(merged.entityId, 'entityId', 64),
  };
}

function scopeOf(config) {
  return hash({ events: config.events.map((event) => event.id).sort() });
}

function eventHash(event) {
  return hash({
    title: event.title,
    start: event.start,
    end: event.end,
    timezone: event.timezone,
    reminderMinutes: event.reminderMinutes,
    location: event.location,
  });
}

function basePayload(event) {
  return {
    calendarEvent: {
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      timezone: event.timezone,
      reminderMinutes: event.reminderMinutes,
      location: event.location,
    },
  };
}

function observation({ key, type, category, summary, payload, nowIso, config, world = false, properties = null }) {
  const body = { ...basePayload(payload.event), ...payload.extra };
  if (config.entityId && world) {
    body.worldEvent = { eventType: type, occurredAt: nowIso, properties };
  }
  return {
    key,
    type,
    category,
    summary,
    observedAt: nowIso,
    payload: body,
    confidence: 0.9,
    entityRefs: config.entityId ? [config.entityId] : [],
  };
}

async function poll({ config, checkpoint, now, signal }) {
  if (signal?.aborted) throw Object.assign(new Error('calendar poll was cancelled'), { code: 'ABORTED' });
  const at = now();
  const nowIso = at.toISOString();
  const nowMs = at.getTime();
  const horizonStart = nowMs - config.horizonDays * 24 * 60 * 60 * 1000;
  const previous = checkpoint?.events && typeof checkpoint.events === 'object' ? checkpoint.events : {};
  const next = { ...previous };
  const observations = [];
  const events = [...config.events].sort((a, b) => (a.start === b.start ? (a.id < b.id ? -1 : 1) : (a.start < b.start ? -1 : 1)));

  for (const event of events) {
    const startMs = Date.parse(event.start);
    const endMs = Date.parse(event.end);
    if (endMs < horizonStart) continue;
    const fingerprint = eventHash(event);
    const prior = previous[event.id];
    const changed = !prior || prior.hash !== fingerprint;
    if (changed) {
      const type = prior ? 'calendar_event_updated' : 'calendar_event_scheduled';
      observations.push(observation({
        key: `cal:${event.id}:${type}:${fingerprint.slice(0, 16)}`,
        type,
        category: 'external',
        summary: `${type === 'calendar_event_scheduled' ? 'scheduled' : 'updated'} calendar event "${event.title}" at ${event.start}`,
        payload: { event },
        nowIso,
        config,
      }));
      next[event.id] = { hash: fingerprint, remindedFor: null, startedFor: null, endedFor: null };
    }

    if (nowMs >= startMs - event.reminderMinutes * 60 * 1000 && nowMs < startMs && next[event.id].remindedFor !== event.start) {
      next[event.id].remindedFor = event.start;
      observations.push(observation({
        key: `cal:${event.id}:approaching:${event.start}:${event.reminderMinutes}`,
        type: 'calendar_deadline_approaching',
        category: 'observation',
        summary: `calendar event "${event.title}" starts in ${Math.max(0, Math.round((startMs - nowMs) / 60000))} minute(s)`,
        payload: { event, extra: { minutesUntilStart: Math.max(0, Math.round((startMs - nowMs) / 60000)) } },
        nowIso,
        config,
        world: true,
        properties: { eventId: event.id, startsAt: event.start, minutesUntilStart: Math.max(0, Math.round((startMs - nowMs) / 60000)) },
      }));
    }
    if (nowMs >= startMs && nowMs < endMs && next[event.id].startedFor !== event.start) {
      next[event.id].startedFor = event.start;
      observations.push(observation({
        key: `cal:${event.id}:started:${event.start}`,
        type: 'calendar_event_started',
        category: 'observation',
        summary: `calendar event "${event.title}" has started`,
        payload: { event },
        nowIso,
        config,
        world: true,
        properties: { eventId: event.id, startsAt: event.start },
      }));
    }
    if (nowMs >= endMs && next[event.id].endedFor !== event.start) {
      next[event.id].endedFor = event.start;
      observations.push(observation({
        key: `cal:${event.id}:ended:${event.start}`,
        type: 'calendar_event_ended',
        category: 'observation',
        summary: `calendar event "${event.title}" has ended`,
        payload: { event },
        nowIso,
        config,
        world: true,
        properties: { eventId: event.id, endsAt: event.end },
      }));
    }
  }

  return {
    observations,
    checkpoint: { events: next, lastPollAt: nowIso },
    health: { configured: config.events.length, observed: observations.length },
  };
}

export const calendarProvider = Object.freeze({
  id: 'calendar',
  name: 'Local calendar schedule (deterministic)',
  apiVersion: PROVIDER_API_VERSION,
  permissions: Object.freeze([PERMISSIONS.CALENDAR_SCHEDULE]),
  defaults: DEFAULTS,
  validate,
  scopeOf,
  async poll(ctx) { return poll(ctx); },
  describe() {
    return {
      id: this.id,
      name: this.name,
      apiVersion: this.apiVersion,
      permissions: this.permissions,
      kind: 'deterministic mock',
      reads: 'a locally configured list of events and the current clock',
      neverReads: 'an external calendar, account, credential or network service',
      defaults: DEFAULTS,
    };
  },
});
