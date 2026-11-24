// T-44 Package 2 (2026-11-19): the Unified Executive Agenda.
//
// The deck already has several places where something is owed and several stores that hold it: a
// proposal waiting for a decision, a mission still running, an advisory nobody has acknowledged, a
// standing order armed and waiting for its event. Each of those is real and each is in its own ledger,
// and the owner has to visit four views to find out what any of it means for today. This module is the
// one list.
//
// Two rules make it honest:
//
//   1. **A commitment is a row the owner wrote, and it is stored here.** The agenda owns one ledger,
//      `<dataDir>/executive-agenda.json`, and it is the only thing it writes. A commitment has a title,
//      a due date, a priority, a category and a status; completing or dismissing it changes that row and
//      nothing else.
//   2. **A derived item is a reading, never a copy.** The pending approvals, the active missions, the
//      unacknowledged advisories and the enabled standing orders are computed on every build from the
//      stores that already hold them. None of them is written here. That is not tidiness: a copy would
//      let the agenda say a mission is running after it finished, and a list that is confidently out of
//      date is worse than no list. The derived items carry `readOnly: true` and the id of the record
//      they describe, so completing one is impossible rather than merely discouraged - the way to
//      resolve it is to go and resolve the thing.
//
// The horizon is the point of the whole surface, so it is computed the same way every time:
//
//   completed -> dismissed -> overdue (dueAt before now) -> today (within 24h) -> upcoming (> 24h) ->
//   unscheduled (no dueAt).
//
// The order of those tests is the whole algorithm. A completed commitment is not overdue however old its
// due date is, and a dismissed one is not today's work. Testing the terminal states first is what keeps
// the counts from disagreeing with the cards.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AGENDA_SCHEMA = 'apex.executive.agenda/1';
export const AGENDA_ITEM_SCHEMA = 'apex.executive.agenda-item/1';

export const AGENDA_CATEGORIES = Object.freeze(['commitment', 'focus_block', 'follow_up', 'milestone']);
export const AGENDA_PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);
export const AGENDA_STATUSES = Object.freeze(['pending', 'completed', 'dismissed']);

// The horizon buckets, in the order they are decided. `action_required` is the derived bucket and it is
// deliberately not reachable from a stored item: it is what a *reading* is, not what a commitment is.
export const HORIZON_BUCKETS = Object.freeze([
  'completed', 'dismissed', 'overdue', 'today', 'upcoming', 'unscheduled', 'action_required',
]);

const DAY_MS = 86_400_000;
const MAX_TITLE_CHARS = 160;
const MAX_NOTES_CHARS = 600;
const MAX_LINK_CHARS = 120;
const MAX_ITEMS = 500;

export class AgendaRefusal extends Error {
  constructor(code, message, detail = {}, status = 400) {
    super(message);
    this.name = 'AgendaRefusal';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export const AGENDA_CODES = Object.freeze({
  NOT_FOUND: 'AGENDA_ITEM_NOT_FOUND',
  LOCKDOWN_ACTIVE: 'LOCKDOWN_ACTIVE',
  INVALID_INPUT: 'AGENDA_INVALID_INPUT',
  LEDGER_CORRUPT: 'AGENDA_LEDGER_CORRUPT',
});

function refused(code, message, detail = {}, status = 400) {
  return new AgendaRefusal(code, message, detail, status);
}

function plainText(value, limit, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refused(AGENDA_CODES.INVALID_INPUT, `${label} must be a string`, {}, 400);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// A date is either a parseable ISO instant or nothing at all. A bad date is refused rather than stored as
// a string that will silently sort last and be counted as unscheduled.
function dueAtOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw refused(AGENDA_CODES.INVALID_INPUT, 'dueAt must be an ISO date string', {}, 400);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw refused(AGENDA_CODES.INVALID_INPUT, `dueAt is not a date: ${value.slice(0, 40)}`, {}, 400);
  return new Date(parsed).toISOString();
}

// The horizon. One function, so a card and a count cannot disagree.
export function horizonFor(item, nowMs) {
  if (item.status === 'completed') return 'completed';
  if (item.status === 'dismissed') return 'dismissed';
  if (item.dueAt === null || item.dueAt === undefined) return 'unscheduled';
  const due = Date.parse(item.dueAt);
  if (Number.isNaN(due)) return 'unscheduled';
  const delta = due - nowMs;
  if (delta < 0) return 'overdue';
  if (delta <= DAY_MS) return 'today';
  return 'upcoming';
}

// ------------------------------------------------------------------------------------- the engine ---

export class ExecutiveAgenda {
  #file;
  #dataDir;
  #now;
  #idFactory;
  #lockdown;
  #sources;

  constructor({
    dataDir,
    now = () => new Date(),
    idFactory = randomUUID,
    lockdown = null,
    // The four authoritative readers. Each is injected so the agenda never imports a store, and each is
    // allowed to be absent: a build without a task graph simply derives no missions.
    tasks = null,
    approvals = null,
    advisories = null,
    standingOrders = null,
    workshopCandidates = null,
  } = {}) {
    if (!dataDir) throw new TypeError('ExecutiveAgenda requires a data directory');
    this.#dataDir = dataDir;
    this.#file = path.join(dataDir, 'executive-agenda.json');
    this.#now = now;
    this.#idFactory = idFactory;
    this.#lockdown = typeof lockdown === 'function' ? lockdown : () => false;
    this.#sources = {
      tasks: typeof tasks === 'function' ? tasks : null,
      approvals: typeof approvals === 'function' ? approvals : null,
      advisories: typeof advisories === 'function' ? advisories : null,
      standingOrders: typeof standingOrders === 'function' ? standingOrders : null,
      workshopCandidates: typeof workshopCandidates === 'function' ? workshopCandidates : null,
    };
  }

  // ------------------------------------------------------------------ persistence, failure-safe ---

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { present: false, corrupt: false, items: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A corrupt ledger is reported, not silently treated as empty: an empty agenda looks like good
      // news, and this module must never manufacture good news out of a read it could not complete.
      return { present: true, corrupt: true, items: [] };
    }
    if (!parsed || !Array.isArray(parsed.items)) return { present: true, corrupt: true, items: [] };
    const items = parsed.items
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.itemId === 'string')
      .map((entry) => this.#normalise(entry));
    return { present: true, corrupt: items.length !== parsed.items.length, items };
  }

  #write(items) {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const payload = { schema: AGENDA_SCHEMA, at: this.#now().toISOString(), items: items.map((entry) => ({ ...entry })) };
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, this.#file);
  }

  #normalise(entry) {
    const createdAt = typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt))
      ? entry.createdAt
      : this.#now().toISOString();
    return {
      schema: AGENDA_ITEM_SCHEMA,
      itemId: String(entry.itemId),
      title: plainText(entry.title, MAX_TITLE_CHARS, 'title') || 'untitled commitment',
      category: AGENDA_CATEGORIES.includes(entry.category) ? entry.category : 'commitment',
      priority: AGENDA_PRIORITIES.includes(entry.priority) ? entry.priority : 'normal',
      dueAt: typeof entry.dueAt === 'string' && !Number.isNaN(Date.parse(entry.dueAt)) ? entry.dueAt : null,
      status: AGENDA_STATUSES.includes(entry.status) ? entry.status : 'pending',
      linkedArtifactId: typeof entry.linkedArtifactId === 'string' && entry.linkedArtifactId !== ''
        ? entry.linkedArtifactId.slice(0, MAX_LINK_CHARS) : null,
      notes: typeof entry.notes === 'string' ? entry.notes.slice(0, MAX_NOTES_CHARS) : '',
      createdAt,
      updatedAt: typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
        ? entry.updatedAt : createdAt,
      completedAt: typeof entry.completedAt === 'string' && !Number.isNaN(Date.parse(entry.completedAt))
        ? entry.completedAt : null,
      verified: true,
    };
  }

  lockdownActive() {
    try {
      return this.#lockdown() === true;
    } catch {
      return true;
    }
  }

  #refuseIfLocked() {
    if (this.lockdownActive()) {
      throw refused(AGENDA_CODES.LOCKDOWN_ACTIVE,
        'Lockdown is engaged, so the agenda cannot be changed. Release Lockdown first.', { lockdownActive: true }, 423);
    }
  }

  // ------------------------------------------------------------------------------------ reading ---

  items() {
    return this.#read().items;
  }

  detail(itemId) {
    const wanted = String(itemId ?? '');
    return this.#read().items.find((entry) => entry.itemId === wanted) ?? null;
  }

  // ------------------------------------------------------------------------------------- create ---

  create({ title, category = 'commitment', priority = 'normal', dueAt = null, linkedArtifactId = null, notes = '' } = {}) {
    this.#refuseIfLocked();
    const cleanTitle = plainText(title, MAX_TITLE_CHARS, 'title');
    if (cleanTitle === '') throw refused(AGENDA_CODES.INVALID_INPUT, 'a commitment needs a title', {}, 400);
    if (!AGENDA_CATEGORIES.includes(category)) {
      throw refused(AGENDA_CODES.INVALID_INPUT, `category must be one of ${AGENDA_CATEGORIES.join(', ')}`, { category }, 400);
    }
    if (!AGENDA_PRIORITIES.includes(priority)) {
      throw refused(AGENDA_CODES.INVALID_INPUT, `priority must be one of ${AGENDA_PRIORITIES.join(', ')}`, { priority }, 400);
    }
    const { items } = this.#read();
    if (items.length >= MAX_ITEMS) {
      throw refused(AGENDA_CODES.INVALID_INPUT, `the agenda holds its limit of ${MAX_ITEMS} items; complete or dismiss some first`, {}, 400);
    }
    const at = this.#now().toISOString();
    const item = this.#normalise({
      itemId: `ag_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`,
      title: cleanTitle,
      category,
      priority,
      dueAt: dueAtOrNull(dueAt),
      status: 'pending',
      linkedArtifactId: linkedArtifactId === null || linkedArtifactId === undefined
        ? null : plainText(linkedArtifactId, MAX_LINK_CHARS, 'linkedArtifactId'),
      notes: plainText(notes, MAX_NOTES_CHARS, 'notes'),
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    items.push(item);
    this.#write(items);
    return { ...item, verified: true };
  }

  // ------------------------------------------------------------------------------------ settling ---

  #settle(itemId, nextStatus) {
    const wanted = String(itemId ?? '');
    const { items } = this.#read();
    const index = items.findIndex((entry) => entry.itemId === wanted);
    if (index === -1) {
      throw refused(AGENDA_CODES.NOT_FOUND, `no agenda item with id ${wanted}`, { itemId: wanted }, 404);
    }
    const at = this.#now().toISOString();
    // Settling an already-settled item is idempotent rather than an error. An owner who presses Complete
    // on a card another window already completed should not see a failure; the state they asked for is
    // the state it is in. `completedAt` is preserved rather than moved, because the date it was actually
    // completed is the fact and a second press is not a second completion.
    const already = items[index].status === nextStatus;
    items[index] = {
      ...items[index],
      status: nextStatus,
      completedAt: nextStatus === 'completed'
        ? (items[index].completedAt ?? at)
        : null,
      updatedAt: already ? items[index].updatedAt : at,
    };
    this.#write(items);
    return { ...items[index], verified: true, already };
  }

  complete(itemId) {
    this.#refuseIfLocked();
    return this.#settle(itemId, 'completed');
  }

  dismiss(itemId) {
    this.#refuseIfLocked();
    return this.#settle(itemId, 'dismissed');
  }

  // --------------------------------------------------------------------------- the derived reads ---

  // Each derived family is read in its own try/catch. A store that cannot be read must not take the whole
  // agenda down: the owner still needs to see their commitments, and the missing family is reported rather
  // than rendered as "nothing pending", which is the one answer that would be a lie.
  async #derived(nowMs) {
    const derived = [];
    const sources = { approvals: 'unavailable', missions: 'unavailable', advisories: 'unavailable', standingOrders: 'unavailable', workshopCandidates: 'unavailable' };

    if (this.#sources.approvals) {
      try {
        const pending = await this.#sources.approvals();
        sources.approvals = 'read';
        for (const proposal of Array.isArray(pending) ? pending : []) {
          derived.push({
            itemId: `dv_approval_${proposal.id}`,
            source: 'approval_gate',
            sourceStore: 'proposals.jsonl',
            horizonBucket: 'action_required',
            title: `Approve or reject: ${proposal.summary ?? proposal.kind ?? 'a proposal'}`,
            detail: proposal.kind ?? null,
            priority: 'high',
            linkedArtifactId: proposal.id,
            at: proposal.createdAt ?? null,
            readOnly: true,
          });
        }
      } catch { sources.approvals = 'failed'; }
    }

    if (this.#sources.tasks) {
      try {
        const missions = await this.#sources.tasks();
        sources.missions = 'read';
        for (const mission of Array.isArray(missions) ? missions : []) {
          derived.push({
            itemId: `dv_mission_${mission.id}`,
            source: 'taskgraph',
            sourceStore: 'tasks.jsonl',
            horizonBucket: 'active_mission',
            title: `Mission ${mission.status}: ${mission.goal ?? 'an unnamed goal'}`,
            detail: mission.status ?? null,
            priority: mission.status === 'paused' ? 'high' : 'normal',
            linkedArtifactId: mission.id,
            at: mission.updatedAt ?? mission.createdAt ?? null,
            readOnly: true,
          });
        }
      } catch { sources.missions = 'failed'; }
    }

    if (this.#sources.advisories) {
      try {
        const advisories = await this.#sources.advisories();
        sources.advisories = 'read';
        for (const advisory of Array.isArray(advisories) ? advisories : []) {
          derived.push({
            itemId: `dv_advisory_${advisory.signature ?? advisory.alertClass}`,
            source: 'sentinel',
            sourceStore: 'perception/observations.jsonl',
            horizonBucket: 'advisory',
            title: `${advisory.alertClass}: ${advisory.summary ?? 'an unacknowledged advisory'}`,
            detail: advisory.severity ?? null,
            priority: advisory.severity === 'critical' ? 'critical' : 'normal',
            linkedArtifactId: advisory.signature ?? null,
            at: advisory.at ?? null,
            readOnly: true,
          });
        }
      } catch { sources.advisories = 'failed'; }
    }

    if (this.#sources.standingOrders) {
      try {
        const orders = await this.#sources.standingOrders();
        sources.standingOrders = 'read';
        for (const order of Array.isArray(orders) ? orders : []) {
          if (order.enabled !== true) continue;
          derived.push({
            itemId: `dv_order_${order.orderId}`,
            source: 'standing_order',
            sourceStore: 'standing-orders.json',
            horizonBucket: 'standing',
            title: `Standing order armed: ${order.title}`,
            detail: `${order.action?.capabilityId} on ${order.trigger?.eventType}`,
            priority: 'low',
            linkedArtifactId: order.orderId,
            at: order.updatedAt ?? order.createdAt ?? null,
            readOnly: true,
            runCount: order.runCount ?? 0,
            lastOutcome: order.lastOutcome ?? 'never_run',
          });
        }
      } catch { sources.standingOrders = 'failed'; }
    }

    if (this.#sources.workshopCandidates) {
      try {
        const candidates = await this.#sources.workshopCandidates();
        sources.workshopCandidates = 'read';
        for (const candidate of Array.isArray(candidates) ? candidates : []) {
          derived.push({
            itemId: `dv_candidate_${candidate.candidateId}`,
            source: 'workshop',
            sourceStore: 'workshop-sandbox',
            horizonBucket: 'action_required',
            title: `Review staged candidate: ${candidate.relativePath ?? candidate.candidateId}`,
            detail: candidate.verdict ?? null,
            priority: 'normal',
            linkedArtifactId: candidate.candidateId,
            at: candidate.createdAt ?? null,
            readOnly: true,
          });
        }
      } catch { sources.workshopCandidates = 'failed'; }
    }

    return { derived, sources, nowMs };
  }

  // ----------------------------------------------------------------------------- the unified view ---

  async build({ now = null } = {}) {
    const nowMs = now === null ? this.#now().getTime() : Date.parse(now);
    if (Number.isNaN(nowMs)) throw refused(AGENDA_CODES.INVALID_INPUT, 'now must be a date', {}, 400);
    const { present, corrupt, items } = this.#read();
    const { derived, sources } = await this.#derived(nowMs);

    const shaped = items.map((item) => ({
      ...item,
      horizonBucket: horizonFor(item, nowMs),
      // The gap is stated in the item because the panel sorts on it and a sort in the client would be a
      // second implementation of the same arithmetic.
      dueInMs: item.dueAt === null ? null : Date.parse(item.dueAt) - nowMs,
    }));
    // The order is the horizon first - what is late outranks what is due today - then priority, then the
    // due date, then the id so the order is total and two identical items never swap places.
    const horizonRank = { overdue: 0, today: 1, upcoming: 2, unscheduled: 3, completed: 4, dismissed: 5 };
    const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 };
    shaped.sort((a, b) => (horizonRank[a.horizonBucket] - horizonRank[b.horizonBucket])
      || (priorityRank[a.priority] - priorityRank[b.priority])
      || ((a.dueInMs ?? Number.MAX_SAFE_INTEGER) - (b.dueInMs ?? Number.MAX_SAFE_INTEGER))
      || a.itemId.localeCompare(b.itemId));

    derived.sort((a, b) => a.itemId.localeCompare(b.itemId));

    const count = (bucket) => shaped.filter((item) => item.horizonBucket === bucket).length;
    return {
      schema: AGENDA_SCHEMA,
      verified: true,
      evaluatedAt: new Date(nowMs).toISOString(),
      lockdownActive: this.lockdownActive(),
      ledger: { present, corrupt },
      summary: {
        totalCommitments: shaped.length,
        overdueCount: count('overdue'),
        todayCount: count('today'),
        upcomingCount: count('upcoming'),
        unscheduledCount: count('unscheduled'),
        completedCount: count('completed'),
        dismissedCount: count('dismissed'),
        derivedActionCount: derived.filter((item) => item.horizonBucket === 'action_required').length,
        derivedCount: derived.length,
        pendingApprovalCount: derived.filter((item) => item.source === 'approval_gate').length,
        activeMissionCount: derived.filter((item) => item.source === 'taskgraph').length,
        advisoryCount: derived.filter((item) => item.source === 'sentinel').length,
        armedOrderCount: derived.filter((item) => item.source === 'standing_order').length,
      },
      sources,
      items: shaped,
      derivedItems: derived,
    };
  }
}

// The standalone function the brief names. It takes already-read inputs rather than reaching for stores,
// so a caller can build an agenda from anything - a composition root, a test, a panel preview - and so it
// is obvious from the signature that nothing here writes.
export function buildUnifiedAgenda({
  now = new Date(), tasks = [], advisories = [], standingOrders = [], workshopCandidates = [],
  approvals = [], commitments = [],
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(nowMs)) throw refused(AGENDA_CODES.INVALID_INPUT, 'now must be a date', {}, 400);

  const shaped = commitments.map((item) => ({
    ...item,
    horizonBucket: horizonFor(item, nowMs),
    dueInMs: item.dueAt === null || item.dueAt === undefined ? null : Date.parse(item.dueAt) - nowMs,
  }));
  const horizonRank = { overdue: 0, today: 1, upcoming: 2, unscheduled: 3, completed: 4, dismissed: 5 };
  const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 };
  shaped.sort((a, b) => (horizonRank[a.horizonBucket] - horizonRank[b.horizonBucket])
    || (priorityRank[a.priority] - priorityRank[b.priority])
    || ((a.dueInMs ?? Number.MAX_SAFE_INTEGER) - (b.dueInMs ?? Number.MAX_SAFE_INTEGER))
    || String(a.itemId).localeCompare(String(b.itemId)));

  const derived = [];
  for (const proposal of approvals) {
    derived.push({
      itemId: `dv_approval_${proposal.id}`, source: 'approval_gate', sourceStore: 'proposals.jsonl',
      horizonBucket: 'action_required', title: `Approve or reject: ${proposal.summary ?? proposal.kind ?? 'a proposal'}`,
      detail: proposal.kind ?? null, priority: 'high', linkedArtifactId: proposal.id,
      at: proposal.createdAt ?? null, readOnly: true,
    });
  }
  for (const mission of tasks) {
    derived.push({
      itemId: `dv_mission_${mission.id}`, source: 'taskgraph', sourceStore: 'tasks.jsonl',
      horizonBucket: 'active_mission', title: `Mission ${mission.status}: ${mission.goal ?? 'an unnamed goal'}`,
      detail: mission.status ?? null, priority: mission.status === 'paused' ? 'high' : 'normal',
      linkedArtifactId: mission.id, at: mission.updatedAt ?? mission.createdAt ?? null, readOnly: true,
    });
  }
  for (const advisory of advisories) {
    derived.push({
      itemId: `dv_advisory_${advisory.signature ?? advisory.alertClass}`, source: 'sentinel',
      sourceStore: 'perception/observations.jsonl', horizonBucket: 'advisory',
      title: `${advisory.alertClass}: ${advisory.summary ?? 'an unacknowledged advisory'}`,
      detail: advisory.severity ?? null, priority: advisory.severity === 'critical' ? 'critical' : 'normal',
      linkedArtifactId: advisory.signature ?? null, at: advisory.at ?? null, readOnly: true,
    });
  }
  for (const order of standingOrders) {
    if (order.enabled !== true) continue;
    derived.push({
      itemId: `dv_order_${order.orderId}`, source: 'standing_order', sourceStore: 'standing-orders.json',
      horizonBucket: 'standing', title: `Standing order armed: ${order.title}`,
      detail: `${order.action?.capabilityId} on ${order.trigger?.eventType}`, priority: 'low',
      linkedArtifactId: order.orderId, at: order.updatedAt ?? order.createdAt ?? null, readOnly: true,
    });
  }
  for (const candidate of workshopCandidates) {
    derived.push({
      itemId: `dv_candidate_${candidate.candidateId}`, source: 'workshop', sourceStore: 'workshop-sandbox',
      horizonBucket: 'action_required', title: `Review staged candidate: ${candidate.relativePath ?? candidate.candidateId}`,
      detail: candidate.verdict ?? null, priority: 'normal', linkedArtifactId: candidate.candidateId,
      at: candidate.createdAt ?? null, readOnly: true,
    });
  }
  derived.sort((a, b) => a.itemId.localeCompare(b.itemId));

  const count = (bucket) => shaped.filter((item) => item.horizonBucket === bucket).length;
  return {
    schema: AGENDA_SCHEMA,
    verified: true,
    evaluatedAt: new Date(nowMs).toISOString(),
    summary: {
      totalCommitments: shaped.length,
      overdueCount: count('overdue'),
      todayCount: count('today'),
      upcomingCount: count('upcoming'),
      unscheduledCount: count('unscheduled'),
      completedCount: count('completed'),
      dismissedCount: count('dismissed'),
      derivedActionCount: derived.filter((item) => item.horizonBucket === 'action_required').length,
      derivedCount: derived.length,
    },
    items: shaped,
    derivedItems: derived,
  };
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

export function agendaActions(agenda) {
  if (!agenda || typeof agenda.create !== 'function') throw new TypeError('agendaActions requires the agenda');
  return [
    {
      name: 'agenda.list',
      description: 'Read the unified executive agenda: the owner\'s own commitments with their horizon bucket, and the derived readings from the approval gate, the task graph, the Sentinel advisories and the armed standing orders. Reads four stores and writes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'agenda',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('agenda.list expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'now') throw new TypeError(`unexpected agenda.list input: ${key}`);
        }
        return input;
      },
      async execute(_ctx, input) {
        const view = await agenda.build({ now: input?.now ?? null });
        return {
          summary: `agenda: ${view.summary.overdueCount} overdue, ${view.summary.todayCount} today, ${view.summary.derivedActionCount} awaiting action`,
          data: view,
          display: [
            `Agenda at ${view.evaluatedAt}: ${view.summary.totalCommitments} commitment(s).`,
            `${view.summary.overdueCount} overdue, ${view.summary.todayCount} today, ${view.summary.upcomingCount} upcoming, ${view.summary.unscheduledCount} unscheduled, ${view.summary.completedCount} completed.`,
            `${view.summary.derivedCount} reading(s) from other stores, ${view.summary.derivedActionCount} needing an act.`,
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the agenda returned no view' };
        if (!Array.isArray(data.items) || !Array.isArray(data.derivedItems)) {
          return { ok: false, detail: 'the view must carry both lists' };
        }
        const counted = data.summary.overdueCount + data.summary.todayCount + data.summary.upcomingCount
          + data.summary.unscheduledCount + data.summary.completedCount + data.summary.dismissedCount;
        if (counted !== data.summary.totalCommitments) {
          return { ok: false, detail: `the buckets total ${counted} but ${data.summary.totalCommitments} commitments exist` };
        }
        return { ok: true, detail: `${data.summary.totalCommitments} commitment(s) and ${data.derivedItems.length} reading(s)` };
      },
    },
    {
      name: 'agenda.create',
      description: 'Add a commitment, focus block, follow-up or milestone to the executive agenda, with a priority and an optional due date. The horizon bucket is computed on every read rather than stored, so a commitment becomes overdue by being overdue rather than by anything updating it.',
      inputHint: '{"title":"Review phase 2 telemetry","priority":"high","category":"commitment"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'agenda',
      autonomyLevel: 'L1',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['title', 'category', 'priority', 'dueAt', 'linkedArtifactId', 'notes'], 'agenda.create');
        if (!value.title) throw new TypeError('agenda.create needs a title');
        return value;
      },
      async execute(_ctx, input) {
        const item = agenda.create(input);
        return {
          summary: `agenda item added: ${item.title}`,
          data: item,
          display: `Added "${item.title}" (${item.priority}, ${item.category}) as ${item.itemId}.`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the action returned no item' };
        if (!String(data.itemId).startsWith('ag_')) return { ok: false, detail: 'the item has no id' };
        if (data.status !== 'pending') return { ok: false, detail: 'a new commitment must be pending' };
        const stored = agenda.detail(data.itemId);
        if (stored === null) return { ok: false, detail: 'the item is not in the ledger after the write' };
        if (stored.title !== data.title) return { ok: false, detail: 'the stored title differs from the written one' };
        return { ok: true, detail: `stored ${data.itemId}` };
      },
    },
    {
      name: 'agenda.complete',
      description: 'Mark an agenda commitment completed. The completion date is recorded once and a second completion does not move it.',
      inputHint: '{"itemId":"ag_..."}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'agenda',
      autonomyLevel: 'L1',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['itemId'], 'agenda.complete');
        if (!value.itemId) throw new TypeError('agenda.complete needs an itemId');
        return value;
      },
      async execute(_ctx, input) {
        const item = agenda.complete(input.itemId);
        return {
          summary: `agenda item completed: ${item.title}`,
          data: item,
          display: `Completed "${item.title}" at ${item.completedAt}.`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the completion returned no item' };
        if (data.status !== 'completed') return { ok: false, detail: 'the item is not completed' };
        if (typeof data.completedAt !== 'string') return { ok: false, detail: 'a completed item must carry its completion date' };
        if (data.horizonBucket !== undefined && data.horizonBucket !== 'completed') {
          return { ok: false, detail: 'a completed item belongs in the completed bucket' };
        }
        return { ok: true, detail: `completed at ${data.completedAt}` };
      },
    },
    {
      name: 'agenda.dismiss',
      description: 'Dismiss an agenda commitment without completing it. A dismissal is a decision that the item will not be done, recorded so it stops appearing as owed work; it is not a completion and carries no completion date.',
      inputHint: '{"itemId":"ag_..."}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'agenda',
      autonomyLevel: 'L1',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        const value = expectKeys(input, ['itemId'], 'agenda.dismiss');
        if (!value.itemId) throw new TypeError('agenda.dismiss needs an itemId');
        return value;
      },
      async execute(_ctx, input) {
        const item = agenda.dismiss(input.itemId);
        return {
          summary: `agenda item dismissed: ${item.title}`,
          data: item,
          display: `Dismissed "${item.title}".`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the dismissal returned no item' };
        if (data.status !== 'dismissed') return { ok: false, detail: 'the item is not dismissed' };
        if (data.completedAt !== null) return { ok: false, detail: 'a dismissal is not a completion and must carry no completion date' };
        return { ok: true, detail: 'dismissed' };
      },
    },
  ];
}
