// Evidence-backed planning constraints: what the records already say stands in the way.
//
// A goal can state that something has to hold before the work, that something stands in the way of
// it, and that a criterion needs a particular piece of evidence before it counts. Those lists were
// carried into a candidate's precondition text and then dropped: no candidate was refused, gated, or
// reported differently because one was on record. This module gives them consequences, and only the
// consequences the records support.
//
// What makes a constraint able to gate work is provenance and applicability, both read from records:
//   - provenance: a limit the user stated in their own words on this goal, or one that names a record
//     this read checked and found current, is established. What APEX inferred, what the user assumed,
//     and anything found as text in memory, experience, or model output is not established, so it is
//     disclosed and gates nothing. Prose does not become a rule by being quoted often enough.
//   - applicability: a limit that names a capability binds the steps that use it and leaves the others
//     alone. One that names nothing applies to every approach for that goal, because APEX cannot say
//     which part of the work it stops; what would resolve that is stated as naming the capability.
//   - currency: a limit recorded against a goal that has since closed, or resting on a record that has
//     been retracted, superseded, or no longer resolves, is historical. It stays on the list - the
//     record is still there and a reader can still see it - but it gates nothing, and it says why not.
//
// The asymmetry between a prerequisite and a blocker is deliberate. A prerequisite the user stated
// stays in force until a record discharges it, because the alternative is that only an absence of
// evidence lets a requirement be skipped. A blocker whose authority comes from a cited record gates
// nothing until that record has been read and found current, because then its authority is the record,
// and a record nobody could read establishes neither work nor refusal.
//
// Nothing here is a permission, and nothing here overrules the user. APEX declines to offer a plan
// that walks into an established obstacle and reports what would clear it; the user can record the
// clearing, revise the goal, or say a capability is usable after all. Every exclusion names the record,
// the candidate or step it applies to, the reason, and what would resolve it: the four things that make
// a refusal checkable instead of a surprise.
import { createHash } from 'node:crypto';
import { singleLine } from '../util.js';
import { GoalBasis, GoalStatus, basisOf, requirementOf, Requirement } from '../goals/model.js';
import { MAX_PRECONDITION_CHARS } from './model.js';

export const CONSTRAINT_NOTE = 'a constraint is a recorded limit on what a plan may assume: it gates or discloses work, grants no permission, and starts nothing';

// The classes a constraint can be in. Three describe a blocker, at the three levels of confidence the
// records actually support; two describe a prerequisite; three are the other things a goal can record
// that a plan has to account for.
export const ConstraintClass = Object.freeze({
  CONFIRMED_BLOCKER: 'confirmed_blocker',
  SUSPECTED_BLOCKER: 'suspected_blocker',
  HISTORICAL_BLOCKER: 'historical_blocker',
  UNRESOLVED_PREREQUISITE: 'unresolved_prerequisite',
  UNCONFIRMED_PREREQUISITE: 'unconfirmed_prerequisite',
  UNMET_DEPENDENCY: 'unmet_dependency',
  MISSING_EVIDENCE: 'missing_evidence',
  UNCHECKABLE_LIMIT: 'uncheckable_limit',
});

// The classes that can refuse work. Everything else is reported and changes nothing, because a
// constraint APEX cannot trace to the user's own record or to a current one is a hint, not an obstacle.
export const GATING_CLASSES = Object.freeze([
  ConstraintClass.CONFIRMED_BLOCKER,
  ConstraintClass.UNRESOLVED_PREREQUISITE,
  ConstraintClass.UNMET_DEPENDENCY,
]);

const GATING = new Set(GATING_CLASSES);

// A limit on a goal that has stopped is a statement about an intention nobody is pursuing, so it is
// historical by currency rather than by provenance: the user's own words, recorded on a closed goal.
const CLOSED_GOAL = new Set([
  GoalStatus.COMPLETED, GoalStatus.FAILED, GoalStatus.CANCELLED, GoalStatus.ABANDONED, GoalStatus.SUPERSEDED,
]);

const CRITERION_ID_RE = /^c[1-9][0-9]?$/;
const ITEM_FIELDS = ['blockers', 'prerequisites', 'constraints', 'resources', 'timeConditions', 'unknowns'];

// The name a record is worth printing. Ids in this repository are prefixes a user types back in, so a
// value is shown nearly whole rather than cut to eight characters: two records that print the same
// name make an exclusion impossible to check against the record it came from.
const label = (value) => singleLine(String(value ?? ''), 24);

const CLASS_ORDER = Object.freeze([
  'confirmed_blocker', 'unresolved_prerequisite', 'unmet_dependency', 'suspected_blocker',
  'historical_blocker', 'unconfirmed_prerequisite', 'missing_evidence', 'uncheckable_limit',
]);

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

function nameSet(registry) {
  const list = typeof registry?.names === 'function' ? registry.names() : [];
  return new Set((Array.isArray(list) ? list : []).map((n) => String(n)));
}

// The whole-token rule. A capability is named when the text holds it as one token, not when its
// letters appear inside other words: "memory.add" names a capability, "remember to add milk" does
// not. Substring matching would let a sentence gate a plan by accident, which is the arbitrary text
// this module may not treat as a constraint. Names are matched as written, case-sensitive: they are
// identifiers in the registry, not words.
function namedIn(names, ...values) {
  if (names.size === 0) return null;
  for (const value of values) {
    const text = String(value ?? '');
    if (!text) continue;
    if (names.has(text)) return text;
    for (const token of text.split(/[^A-Za-z0-9._:-]+/)) {
      if (token && names.has(token)) return token;
    }
  }
  return null;
}

function revisionAt(goal) {
  const history = Array.isArray(goal?.revisionHistory) ? goal.revisionHistory : [];
  const entry = history.find((r) => r.revision === goal?.revision) ?? history.at(-1);
  return entry?.at ?? goal?.updatedAt ?? goal?.createdAt ?? null;
}

// The record a goal-level constraint came from. The log dates a revision, not an individual item, and
// the current goal state is what the constraint is a statement about: naming the goal, the revision,
// and that revision's recorded time is the whole of what a later reader can check.
function goalRecord(goal, { field, basis, ref, extra = {} }) {
  return {
    store: 'goal',
    goalId: goal?.id ?? null,
    revision: goal?.revision ?? null,
    recordedAt: revisionAt(goal),
    field,
    basis: basis ?? null,
    ...(ref ? { ref } : {}),
    ...extra,
  };
}

function constraint({ goal, field, text, basis, ref = null, capability = null, cls, why, resolution, record }) {
  return {
    id: `con-${digest([field, text, basis ?? null, ref ?? null, cls])}`,
    class: cls,
    field,
    text: singleLine(text, MAX_PRECONDITION_CHARS),
    basis: basis ?? null,
    capability,
    // Whether this limit speaks about one named capability or about the work as a whole. A bound limit
    // touches only the candidates that use it; an unbound one touches every approach, and says so.
    bindsAll: capability === null,
    gates: GATING.has(cls),
    why: singleLine(why, MAX_PRECONDITION_CHARS),
    resolution: singleLine(resolution, MAX_PRECONDITION_CHARS),
    record: record ?? goalRecord(goal, { field, basis, ref }),
  };
}

// What a read of the stores said about one cited record, as three answers rather than two: a record
// that is there and current, a record whose own authority has gone (retracted, superseded, absent),
// and a record this read could not reach. Only the first confirms anything; the second is history; the
// third is an unchecked claim, which is not the same as a retired one and must not be reported as one.
function citeState(cited, ref) {
  if (!ref) return { verdict: 'none', reason: 'it names no record' };
  if (!cited) return { verdict: 'unchecked', reason: 'the record it names was not read by this comparison' };
  const state = cited[ref];
  if (!state) return { verdict: 'unchecked', reason: `the record ${label(ref)} is not in the stores this read was given` };
  if (state.unreadable) return { verdict: 'unchecked', reason: `the store holding ${label(ref)} could not be read (${state.reason ?? 'store error'})` };
  if (!state.found) return { verdict: 'gone', reason: `the record ${label(ref)} no longer resolves` };
  if (state.retired) return { verdict: 'gone', reason: `the record ${label(ref)} is ${state.state ?? 'retired'}${state.note ? ` (${state.note})` : ''}` };
  if (state.source === 'goal' && state.status && state.status !== 'completed') {
    return { verdict: 'gone', reason: `the goal ${label(ref)} it names is ${state.status}, not completed` };
  }
  return { verdict: 'current', source: state.source ?? null, status: state.status ?? null, reason: null };
}

// One goal's constraint ledger. `evidence` is what the caller handed the generation (blocker text it
// read, operations that failed); `cited` and `dependencies` are what a read of the stores said about
// the records these items name. Both are optional, so a ledger can be built from the goal record alone
// - which is what a candidate generation must do, since the bytes it produces cannot depend on a read
// only some callers make. What such a ledger cannot check, it reports as unchecked.
export function constraintLedger({
  goal = null, registry = null, evidence = null, cited = null, dependencies = null,
} = {}) {
  const names = nameSet(registry);
  const constraints = [];
  const cleared = [];
  const unavailable = [];
  const hasGoal = Boolean(goal && typeof goal === 'object' && goal.id);
  const closed = hasGoal && CLOSED_GOAL.has(goal.status);

  const historical = (item, field, capability, why) => constraint({
    goal, field, text: item.text, basis: item.basis, ref: item.ref ?? null, capability,
    cls: ConstraintClass.HISTORICAL_BLOCKER,
    why,
    resolution: 'it applies again only to a goal that is open: record it on the goal being worked on now',
  });

  for (const item of goal?.blockers ?? []) {
    const ref = item.ref ?? null;
    const capability = namedIn(names, ref, item.text);
    const basis = basisOf(item);
    if (closed) {
      constraints.push(historical(item, 'blockers', capability,
        `it is recorded on goal ${label(goal.id)}, which is ${goal.status}, so it speaks about work nobody is pursuing`));
      continue;
    }
    if (basis === GoalBasis.USER_STATED) {
      constraints.push(constraint({
        goal, field: 'blockers', text: item.text, basis, ref, capability,
        cls: ConstraintClass.CONFIRMED_BLOCKER,
        why: `the user's own words, recorded as a blocker on goal ${label(goal.id)} revision ${goal.revision ?? 1}`,
        resolution: capability
          ? 'clear it on the record: a goal revision that drops this blocker, once the obstacle is gone. APEX does not decide that a blocker the user stated has passed'
          : `name the capability it stops, so the approaches it does not touch can still be offered (record the blocker with a reference to a registered action)`,
      }));
      continue;
    }
    if (basis === GoalBasis.VERIFIED_FACT) {
      // Its authority is the record it cites, so that record is what decides the class: current
      // confirms it, gone makes it history, unchecked leaves it a claim that something was verified.
      const state = citeState(cited, ref);
      const cls = state.verdict === 'current' ? ConstraintClass.CONFIRMED_BLOCKER
        : state.verdict === 'gone' ? ConstraintClass.HISTORICAL_BLOCKER
          : ConstraintClass.SUSPECTED_BLOCKER;
      constraints.push(constraint({
        goal, field: 'blockers', text: item.text, basis, ref, capability, cls,
        why: state.verdict === 'current'
          ? `it names the ${state.source ?? 'record'} ${label(ref)}, which this read found still current`
          : state.verdict === 'gone'
            ? `its authority was a record, and ${state.reason}`
            : `it is recorded as a verified fact and ${state.reason}, so nothing here establishes it`,
        resolution: state.verdict === 'current'
          ? (capability ? `clear the obstacle the cited record describes, or revise the goal to drop this blocker` : `name the capability it stops so the approaches it does not touch can still be offered`)
          : state.verdict === 'gone'
            ? 'cite a current record for it; a blocker resting on a retracted claim is kept as history and not applied'
            : `have this read reach the store holding ${label(ref)}, or state it as the user's own blocker`,
      }));
      continue;
    }
    // An inference or an assumption of APEX's, recorded with its provenance: informative, and no
    // authority over which work APEX offers.
    constraints.push(constraint({
      goal, field: 'blockers', text: item.text, basis, ref, capability,
      cls: ConstraintClass.SUSPECTED_BLOCKER,
      why: `it was recorded as ${basis}, not as the user's own statement, so it is evidence about an obstacle rather than one on record`,
      resolution: 'the user states it as a blocker of their own on this goal (a revision with `basis: "user_stated"`)',
    }));
  }

  for (const item of goal?.prerequisites ?? []) {
    const ref = item.ref ?? null;
    const basis = basisOf(item);
    if (closed) {
      constraints.push(historical(item, 'prerequisites', null,
        `it is recorded on goal ${label(goal.id)}, which is ${goal.status}, so it conditions work nobody is pursuing`));
      continue;
    }
    if (basis !== GoalBasis.USER_STATED && basis !== GoalBasis.VERIFIED_FACT) {
      constraints.push(constraint({
        goal, field: 'prerequisites', text: item.text, basis, ref,
        cls: ConstraintClass.UNCONFIRMED_PREREQUISITE,
        why: `it was recorded as ${basis}: something APEX put forward, not a condition the user set`,
        resolution: 'the user records it as their own prerequisite, or decides the criterion it belongs to',
      }));
      continue;
    }
    // What discharges a prerequisite is a record, never its wording: a record this read found current,
    // or a criterion of this goal that is satisfied.
    const criterion = ref && CRITERION_ID_RE.test(ref) ? (goal.criteria ?? []).find((c) => c.id === ref) : null;
    if (criterion && criterion.status === 'satisfied') {
      cleared.push({
        kind: 'prerequisite',
        text: singleLine(item.text, MAX_PRECONDITION_CHARS),
        record: { ...goalRecord(goal, { field: 'prerequisites', basis, ref }), dischargedBy: `criterion ${ref}`, source: 'goal-criterion' },
      });
      continue;
    }
    const state = ref && !criterion ? citeState(cited, ref) : { verdict: 'none', reason: 'it names no record' };
    if (state.verdict === 'current') {
      cleared.push({
        kind: 'prerequisite',
        text: singleLine(item.text, MAX_PRECONDITION_CHARS),
        record: { ...goalRecord(goal, { field: 'prerequisites', basis, ref }), dischargedBy: label(ref), source: state.source ?? 'record' },
      });
      continue;
    }
    constraints.push(constraint({
      goal, field: 'prerequisites', text: item.text, basis, ref,
      cls: ConstraintClass.UNRESOLVED_PREREQUISITE,
      why: criterion
        ? `the user recorded it as a condition that has to hold first; the criterion it names (${ref}) is ${criterion.status}`
        : state.verdict === 'gone'
          ? `the user recorded it as a condition that has to hold first, and nothing discharges it: ${state.reason}`
          : state.verdict === 'unchecked'
            ? `the user recorded it as a condition that has to hold first, citing ${label(ref)}, and ${state.reason}`
            : 'the user recorded it as a condition that has to hold first, and no record named by it discharges it',
      resolution: 'name the record that settles it - a knowledge claim, an experience, an operation, or a criterion of this goal marked satisfied - or revise the goal to drop the prerequisite',
    }));
  }

  for (const dependencyId of goal?.dependsOn ?? []) {
    const id = String(dependencyId);
    const text = `goal ${label(id)} completes first`;
    if (closed) {
      constraints.push(constraint({
        goal, field: 'dependsOn', text, basis: GoalBasis.USER_STATED, ref: id,
        cls: ConstraintClass.HISTORICAL_BLOCKER,
        why: `goal ${label(goal.id)} is ${goal.status}, so its dependency conditions work nobody is pursuing`,
        resolution: 'it applies again only to a goal that is open',
      }));
      continue;
    }
    const read = Array.isArray(dependencies) ? dependencies.find((d) => String(d.id) === id) ?? null : null;
    const state = read ?? citeState(cited, id);
    if (state.status === 'completed') {
      cleared.push({ kind: 'dependency', text, record: { store: 'goal', goalId: id, status: 'completed', source: 'goal' } });
      continue;
    }
    constraints.push(constraint({
      goal, field: 'dependsOn', text, basis: GoalBasis.USER_STATED, ref: id,
      cls: ConstraintClass.UNMET_DEPENDENCY,
      why: state.status
        ? `goal ${label(id)} is ${state.status}, not completed`
        : state.verdict === 'unchecked'
          ? `goal ${label(id)} could not be read${state.reason && state.reason !== 'the record it names was not read by this comparison' ? `: ${state.reason}` : ', so its completion is not established'}`
          : `goal ${label(id)} does not stand as a completed goal: ${state.reason ?? 'no record of it was found'}`,
      resolution: state.status
        ? `complete goal ${label(id)}, or revise this goal to drop the dependency`
        : `have this read reach the goal store, or complete goal ${label(id)}`,
    }));
  }

  for (const c of goal?.criteria ?? []) {
    if (c.status === 'satisfied' || requirementOf(c) === Requirement.DECLINED || closed) continue;
    const wanted = typeof c.requiredEvidence === 'string' ? c.requiredEvidence.trim() : '';
    if (wanted.length === 0) continue;
    if ((c.evidence ?? []).some((ev) => ev.kind === 'supports')) continue;
    constraints.push(constraint({
      goal,
      field: 'criteria',
      text: `${c.id} asks for evidence: ${wanted}`,
      basis: c.basis ?? GoalBasis.USER_STATED,
      ref: c.ref ?? null,
      capability: namedIn(names, c.description),
      cls: ConstraintClass.MISSING_EVIDENCE,
      why: requirementOf(c) === Requirement.REQUIRED
        ? 'a criterion the user made required names evidence no record of this goal supplies'
        : 'a criterion APEX put forward names evidence nothing supplies; it gates completion only if the user makes it required',
      resolution: `record the operation that settles ${c.id} as evidence on the goal, or record that the criterion no longer needs it`,
    }));
  }

  for (const item of goal?.unknowns ?? []) {
    if (closed) {
      constraints.push(historical(item, 'unknowns', namedIn(names, item.text),
        `it is recorded on goal ${label(goal.id)}, which is ${goal.status}`));
      continue;
    }
    constraints.push(constraint({
      goal, field: 'unknowns', text: item.text, basis: item.basis, ref: item.ref ?? null,
      capability: namedIn(names, item.text),
      cls: ConstraintClass.MISSING_EVIDENCE,
      why: 'the goal records that this is not known',
      resolution: 'record what settles it, or record that the work proceeds without it',
    }));
  }

  // A limit the user stated that APEX holds no record able to measure. Saying so is the honest answer:
  // the constraint is on the record and APEX cannot check it, so it is disclosed rather than pretended
  // to be satisfied or violated.
  for (const field of ['constraints', 'resources', 'timeConditions']) {
    for (const item of goal?.[field] ?? []) {
      const capability = namedIn(names, item.ref, item.text);
      constraints.push(constraint({
        goal, field, text: item.text, basis: item.basis, ref: item.ref ?? null, capability,
        cls: ConstraintClass.UNCHECKABLE_LIMIT,
        why: `it is recorded as a ${field.replace(/s$/, '')} and APEX holds no record that measures it${capability ? `; it names ${capability}, which the capability gate does check` : ''}`,
        resolution: 'state it as a limit APEX can check - a capability not to use, or a step bound - or hold it as the user\'s own condition on the result',
      }));
    }
  }

  // Anything a caller handed as a blocker: it came from a record, but the record is not a statement by
  // the user about this goal, so it informs and does not gate. Text is what it is.
  for (const blocker of evidence?.knownBlockers ?? []) {
    const text = String(blocker ?? '').trim();
    if (text.length === 0) continue;
    constraints.push(constraint({
      goal, field: 'evidence', text, basis: 'record', capability: namedIn(names, text),
      cls: ConstraintClass.SUSPECTED_BLOCKER,
      why: 'it was handed to this comparison as text from the records, which is evidence about an obstacle rather than one the user recorded on the goal',
      resolution: 'record it as a blocker on the goal, or state it as the user\'s own condition on this work',
      record: { store: 'evidence', field: 'knownBlockers', text: singleLine(text, MAX_PRECONDITION_CHARS) },
    }));
  }

  for (const failure of evidence?.failedOperations ?? []) {
    const detail = (typeof failure === 'string' ? failure : String(failure?.detail ?? '')).trim();
    if (detail.length === 0) continue;
    const operationId = typeof failure === 'string' ? null : failure.operationId ?? null;
    constraints.push(constraint({
      goal, field: 'evidence', text: `recorded failure: ${detail}`, basis: 'record',
      capability: namedIn(names, detail),
      cls: ConstraintClass.SUSPECTED_BLOCKER,
      why: `an operation record ends in a failure${operationId ? ` (${label(operationId)})` : ''}, which is evidence about a capability and not a statement that it cannot run`,
      resolution: 'a recorded success after the failure, or the user stating it as a blocker; a capability this generation was told not to use is refused by the capability gate, not here',
      record: { store: 'evidence', field: 'failedOperations', ...(operationId ? { operationId } : {}) },
    }));
  }

  const citesARecord = ITEM_FIELDS.some((field) => (goal?.[field] ?? []).some((item) => item.ref && !namedIn(names, item.ref)));
  if (citesARecord && !cited) {
    unavailable.push('the records these items cite were not read, so a fact recorded as verified stays unestablished and a prerequisite keeps its force');
  }
  if (goal?.dependsOn?.length && !Array.isArray(dependencies) && !cited) {
    unavailable.push('the goals this one depends on were not read, so their completion is not established');
  }

  return {
    schema: 'apex.constraints.v1',
    note: CONSTRAINT_NOTE,
    goalId: goal?.id ?? null,
    goalRevision: goal?.revision ?? null,
    goalStatus: goal?.status ?? null,
    recordsRead: cited ? Object.keys(cited).length : 0,
    constraints,
    gating: constraints.filter((c) => c.gates).map((c) => c.id),
    disclosed: constraints.filter((c) => !c.gates).map((c) => c.id),
    cleared,
    unavailable,
  };
}

// The read that lets a ledger speak about cited records: every id a goal item names, plus every goal
// this one depends on, looked up in the stores that hold them. It is bounded by the goal's own lists, so
// a large history cannot make a constraint read expensive, and a store this configuration does not have
// is recorded as unreadable rather than answered as an empty store.
export async function readConstraintRecords({ goal, registry = null, goals = null, knowledge = null, memory = null, experience = null }) {
  const cited = {};
  const dependencies = [];
  if (!goal) return { cited, dependencies };
  const names = nameSet(registry);
  const refs = [];
  for (const field of ITEM_FIELDS) {
    for (const item of goal[field] ?? []) if (item?.ref) refs.push(String(item.ref));
  }
  for (const id of goal.dependsOn ?? []) refs.push(String(id));
  for (const ref of refs) {
    if (cited[ref] || names.has(ref) || CRITERION_ID_RE.test(ref)) continue;
    const checks = [
      ['knowledge', knowledge, async (store) => {
        const view = await store.history(ref);
        if (!view?.record) return null;
        return {
          found: true,
          source: 'knowledge',
          retired: view.record.active !== true,
          ...(view.record.lifecycleState ? { state: view.record.lifecycleState } : {}),
          ...(view.replacedBy?.length ? { note: `replaced by ${view.replacedBy.map((r) => label(r.id)).join(', ')}` } : {}),
        };
      }],
      ['memory', memory, async (store) => (await store.get(ref) ? { found: true, source: 'memory' } : null)],
      ['experience', experience, async (store) => (await store.get(ref) ? { found: true, source: 'experience' } : null)],
      ['goal', goals, async (store) => {
        const record = await store.get(ref);
        return record ? { found: true, source: 'goal', status: record.status } : null;
      }],
    ];
    let outcome = null;
    const failures = [];
    for (const [, store, read] of checks) {
      if (!store) continue;
      try {
        const state = await read(store);
        if (state) { outcome = state; break; }
      } catch (err) {
        failures.push(String(err?.code ?? 'store error'));
      }
    }
    cited[ref] = outcome ?? (failures.length > 0
      ? { found: false, unreadable: true, reason: failures.join(', ') }
      : { found: false });
  }
  for (const dependencyId of goal.dependsOn ?? []) {
    const id = String(dependencyId);
    const state = cited[id];
    if (state?.found && state.source === 'goal') {
      dependencies.push({ id, found: true, status: state.status, verdict: 'current' });
    } else if (state?.unreadable) {
      dependencies.push({ id, found: false, verdict: 'unchecked', reason: `the goal store could not be read (${state.reason})` });
    } else if (state?.found) {
      dependencies.push({ id, found: true, status: state.status ?? null, verdict: state.status === 'completed' ? 'current' : 'gone' });
    } else {
      dependencies.push({ id, found: false, verdict: 'unchecked', reason: 'no goal with that id is recorded, or no goal store was reached' });
    }
  }
  return { cited, dependencies };
}

// The capability names a generation must not offer: the user's own blockers that bind to a capability.
// A blocker confirmed through a cited record reaches this list only when the caller built the ledger it
// passes here from the same read it uses for generation - the caller that must keep candidate bytes
// reproducible builds this from the goal record alone, where only `user_stated` blockers can be.
export function generationExclusions(ledger) {
  const map = new Map();
  for (const c of ledger?.constraints ?? []) {
    if (c.class !== ConstraintClass.CONFIRMED_BLOCKER || !c.capability) continue;
    map.set(c.capability, {
      id: c.id,
      text: c.text,
      record: c.record,
      phrase: `a blocker the user recorded on goal ${label(String(c.record?.goalId ?? ''))} names ${c.capability} ("${c.text}"), so it is not offered (${c.id})`,
    });
  }
  return map;
}

// How one candidate stands against the ledger. Every exclusion carries the record, the steps it applies
// to, the reason, and what would resolve it.
export function constraintFinding(ledger, { steps = [], strategy = null } = {}) {
  const blockedBy = [];
  const notApplicable = [];
  const limitations = [];
  for (const c of ledger?.constraints ?? []) {
    const uses = c.capability ? steps.filter((s) => s.action === c.capability).map((s) => s.id) : [];
    if (c.gates) {
      if (c.capability && uses.length === 0) {
        notApplicable.push({
          id: c.id,
          class: c.class,
          text: c.text,
          capability: c.capability,
          why: `it names ${c.capability}, which no step of ${strategy ?? 'this approach'} uses`,
        });
        continue;
      }
      blockedBy.push({
        id: c.id,
        class: c.class,
        field: c.field,
        text: c.text,
        capability: c.capability,
        steps: c.capability ? uses : ['every step of this approach'],
        reason: c.why,
        resolution: c.resolution,
        record: c.record,
      });
      continue;
    }
    if (c.class === ConstraintClass.SUSPECTED_BLOCKER || c.class === ConstraintClass.HISTORICAL_BLOCKER) {
      // An unbound hint still speaks about this approach; a bound one only where the steps use it.
      if (c.capability && uses.length === 0) continue;
      limitations.push({
        id: c.id,
        class: c.class,
        field: c.field,
        text: c.text,
        ...(c.capability ? { capability: c.capability, steps: uses } : {}),
        why: c.why,
        resolution: c.resolution,
        record: c.record,
      });
      continue;
    }
    limitations.push({
      id: c.id,
      class: c.class,
      field: c.field,
      text: c.text,
      ...(c.capability ? { capability: c.capability, steps: uses } : {}),
      why: c.why,
      resolution: c.resolution,
      record: c.record,
    });
  }
  return {
    passed: blockedBy.length === 0,
    detail: blockedBy.length === 0
      ? (ledger?.constraints ?? []).length === 0
        ? 'the goal records no blocker, prerequisite, dependency, evidence condition, or limit for this comparison to answer'
        : `nothing on the goal record stops this approach: ${(ledger.gating ?? []).length} gating record(s), none of them applicable to its steps`
      : blockedBy.map((b) => `${b.class} ${b.id} ("${b.text}") stops ${b.steps.join(', ')} - ${b.reason}; what would clear it: ${b.resolution}`).join('; '),
    blockedBy,
    notApplicable,
    limitations,
  };
}

// The plan's own recorded step failures, as a ledger takes them: a failure a plan already answered is
// evidence about a capability. It is disclosed, never upgraded into a blocker the user recorded.
export function priorFailureEvidence(plan) {
  return {
    failedOperations: Object.entries(plan?.stepResults ?? {})
      .filter(([, r]) => r?.status === 'failed' || r?.status === 'uncertain')
      .map(([stepId, r]) => ({
        operationId: r.operationId ?? '',
        detail: `${plan?.steps?.find((s) => s.id === stepId)?.action ?? 'a step'} ${r.status}`,
      })),
  };
}

// The same re-read for a recorded plan: this goal's constraints, as they are now, against the steps
// the plan itself takes. Approval and activation both pass it, because an approval bound the plan's
// bytes and nothing else - a blocker recorded afterwards, or a prerequisite whose discharging record
// has been retracted, is a change of the world the plan was written against.
export async function planConstraintFinding(plan, {
  goal, registry, goals = null, knowledge = null, memory = null, experience = null,
}) {
  const { cited, dependencies } = await readConstraintRecords({
    goal, registry, goals, knowledge, memory, experience,
  });
  const ledger = constraintLedger({
    goal, registry, cited, dependencies, evidence: priorFailureEvidence(plan),
  });
  return {
    ledger,
    finding: constraintFinding(ledger, { steps: plan?.steps ?? [], strategy: `plan ${label(plan?.id ?? '')}` }),
  };
}

// The shape two reads of the same records must agree on: classes, ids, bindings and gating, never the
// prose, so a difference means a record moved rather than a wording changed.
export function constraintDigest(ledger) {
  if (!ledger) return null;
  const shape = {
    goalRevision: ledger.goalRevision ?? null,
    goalStatus: ledger.goalStatus ?? null,
    constraints: (ledger.constraints ?? [])
      .map((c) => [c.id, c.class, c.field, c.capability ?? null, c.gates ? 1 : 0, label(String(c.record?.goalId ?? c.record?.operationId ?? c.record?.ref ?? ''))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    cleared: (ledger.cleared ?? []).map((c) => [c.kind, label(String(c.record?.dischargedBy ?? c.record?.goalId ?? ''))]).sort(),
    unavailable: (ledger.unavailable ?? []).length,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// One line per record, able-to-stop-work first: the reader sees which obstacle stops which approach,
// which ones APEX is not entitled to act on, and what it checked and found satisfied.
export function renderConstraints(ledger, { indent = '' } = {}) {
  if (!ledger) {
    return `${indent}No constraint ledger was built, so nothing on the goal record was checked. ${CONSTRAINT_NOTE}`;
  }
  const lines = [];
  const all = ledger.constraints ?? [];
  lines.push(`${indent}Constraints on record for goal ${label(String(ledger.goalId ?? ''))} revision ${ledger.goalRevision ?? '-'} (${all.length} item(s), ${ledger.gating.length} able to stop work):`);
  const sorted = [...all].sort((a, b) => {
    const byClass = CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class);
    if (byClass !== 0) return byClass;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const c of sorted) {
    lines.push(`${indent}  ${c.class}${c.gates ? ' (gates work)' : ' (reported, gates nothing)'} ${c.id}: ${c.text}`);
    lines.push(`${indent}    ${c.capability ? `names ${c.capability}` : 'names no capability, so it speaks about every approach for this goal'}; ${c.why}`);
    lines.push(`${indent}    record: ${c.record.store === 'goal'
      ? `goal ${label(String(c.record.goalId ?? ''))} revision ${c.record.revision ?? '-'}${c.record.field ? `/${c.record.field}` : ''}`
      : JSON.stringify(c.record)}${c.record.recordedAt ? ` at ${c.record.recordedAt}` : ''}`);
    lines.push(`${indent}    what would clear it: ${c.resolution}`);
  }
  for (const c of ledger.cleared ?? []) {
    lines.push(`${indent}  checked and satisfied: ${c.kind} "${c.text}" by ${c.record.dischargedBy ? `${c.record.source} ${c.record.dischargedBy}` : `goal ${label(String(c.record.goalId ?? ''))} is completed`}`);
  }
  for (const u of ledger.unavailable ?? []) {
    lines.push(`${indent}  not established: ${u}`);
  }
  if (all.length === 0 && (ledger.cleared ?? []).length === 0) {
    lines.push(`${indent}  nothing is recorded as standing in the way of this goal, and nothing on it has to hold first`);
  }
  lines.push(`${indent}${ledger.note}`);
  return lines.join('\n');
}
