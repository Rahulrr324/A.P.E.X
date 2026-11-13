// Batch AP-07: one documented bounded-read contract for every consumer that assembles evidence.
//
// The problem this solves: each store returns a bounded slice and each consumer decides for itself
// whether that slice is the whole history, a window the caller asked for, or a prefix that was cut
// short. Those three cases were described in different words, and some consumers treated a short read
// as if the store had nothing more to say. That turns a limit into a fact about the world.
//
// This module gives the three cases one closed vocabulary and derives it from the numbers the reader
// actually observed, rather than from how the reader feels about them:
//
//   complete_empty    - the read covered the whole store and the store held no records
//   complete_nonempty - the read covered the whole store and returned its records
//   bounded_usable    - the caller asked for a window (a limit, a time range) and the window is full
//   truncated         - the read stopped at a bound while the store held more; a source is named
//   missing           - a source that was cited or expected is not present at all
//   unavailable       - the source could not be read, so its contents are unknown, not empty
//   damaged           - the source was read and some of its records could not be parsed
//   inconsistent      - a contributing file changed while this read was in progress
//   unverifiable      - a contributing file could not be inspected, so consistency cannot be claimed
//
// The states are ordered from least to most severe, and a report is described by its worst read, so
// two readers cannot disagree about whether a bundle with one truncated source is "complete". Every
// rule that matters is enforced here and not left to the caller:
//
//  - a truncation must name the source it stopped inside; a bare "truncated" is rejected;
//  - an unreadable source reports `total: null`, never `0`, because "unknown" and "nothing recorded"
//    are different claims and only one of them is evidence of absence;
//  - absence is proven only by `complete_empty`; `absenceProven()` is false for every other state,
//    including a bounded window that happened to return nothing;
//  - longitudinal patterns are only permitted over complete reads, because a prefix is not history;
//  - a report carries `authorizes: false` and its digest covers the completeness of each read, so a
//    clipped report cannot present the same digest as a complete one.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import { integrityFinding } from './integrity.js';

export const READ_CONTRACT_SCHEMA = 'apex.bounded-read.v1';
export const MAX_READ_SOURCES = 32;

// Least to most severe. A bundle is described by its worst entry.
export const READ_STATES = Object.freeze([
  'complete_empty',
  'complete_nonempty',
  'bounded_usable',
  'truncated',
  'missing',
  'unavailable',
  'damaged',
  'inconsistent',
  'unverifiable',
]);

// The states whose records may be used as evidence of what the store contains.
export const READ_COMPLETE_STATES = Object.freeze(['complete_empty', 'complete_nonempty']);
// The states whose records may be used at all, provided the consumer discloses the bound.
export const READ_USABLE_STATES = Object.freeze([...READ_COMPLETE_STATES, 'bounded_usable', 'truncated', 'damaged']);

const SEVERITY = new Map(READ_STATES.map((state, index) => [state, index]));
const singleLine = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isReadState(state) {
  return SEVERITY.has(state);
}

export function worstReadState(states = []) {
  let worst = 'complete_empty';
  for (const state of states) {
    if (!isReadState(state)) {
      throw new TypeError(`unknown read state ${JSON.stringify(singleLine(state, 60))}`);
    }
    if (SEVERITY.get(state) > SEVERITY.get(worst)) worst = state;
  }
  return worst;
}

// The statuses a source reader may report before the window state is applied. They are deliberately
// fewer than the final vocabulary: a reader knows whether it read the whole store, stopped at a bound,
// or could not read at all; it does not know whether the bundle as a whole is consistent.
export const SOURCE_READ_STATUS = Object.freeze(['ok', 'empty', 'bounded', 'truncated', 'missing', 'unavailable', 'damaged']);

const STATUS_STATE = Object.freeze({
  ok: null, // decided from the counts
  empty: 'complete_empty',
  bounded: 'bounded_usable',
  truncated: 'truncated',
  missing: 'missing',
  unavailable: 'unavailable',
  damaged: 'damaged',
});

// One source's read. `returned` is what the read produced, `total` what the source says it holds when
// that is safely obtainable, and `limit` the bound the caller applied. A `truncated` read must name
// where it stopped; a read that could not happen reports null counts.
export function sourceRead({
  source,
  status = 'ok',
  returned = 0,
  total = null,
  limit = null,
  stoppedAt = null,
  reason = null,
  counts = null,
} = {}) {
  const name = singleLine(source, 80);
  if (name.length === 0) throw new TypeError('a source read needs a source name');
  if (!SOURCE_READ_STATUS.includes(status)) {
    throw new TypeError(`unknown source read status ${JSON.stringify(singleLine(status, 60))}`);
  }
  const count = Number.isInteger(returned) && returned >= 0 ? returned : null;
  const totalCount = Number.isInteger(total) && total >= 0 ? total : null;
  const bounded = Number.isInteger(limit) && limit > 0 ? limit : null;

  let state;
  if (STATUS_STATE[status] !== null) {
    state = STATUS_STATE[status];
  } else if (count === null) {
    state = 'unavailable';
  } else if (totalCount !== null && count < totalCount) {
    // The reader returned fewer records than the source says it holds without declaring a bound. That
    // is a truncation the reader did not name, and it is treated as more severe than one it did.
    state = 'truncated';
  } else if (count === 0) {
    state = 'complete_empty';
  } else {
    state = 'complete_nonempty';
  }

  // A read that could not happen has no count. Reporting zero would turn an unknown into an absence.
  if (state === 'unavailable') {
    return {
      source: name,
      status,
      state,
      returned: null,
      total: null,
      limit: bounded,
      stoppedAt: null,
      complete: false,
      truncated: false,
      usable: false,
      reason: reason ?? 'the source could not be read, so what it holds is unknown',
    };
  }

  const truncated = state === 'truncated';
  if (truncated && stoppedAt === null && totalCount === null) {
    throw new TypeError(`a truncated read of ${name} must name what stopped it`);
  }
  return {
    source: name,
    status,
    state,
    returned: count,
    total: totalCount,
    limit: bounded,
    stoppedAt: truncated ? singleLine(stoppedAt ?? 'its own limit', 120) : null,
    complete: state === 'complete_empty' || state === 'complete_nonempty',
    truncated,
    usable: READ_USABLE_STATES.includes(state),
    reason: reason ?? (truncated
      ? `the read of ${name} stopped at ${singleLine(stoppedAt ?? 'its limit', 120)} while the source held more`
      : null),
    ...(counts && typeof counts === 'object' ? { counts } : {}),
  };
}

// A bundle of source reads taken together. `window` is the snapshot verdict for the stores the reads
// came from. An inconsistent window outranks every per-source state except an unverifiable one,
// because records read across a moving window describe no single instant; the per-source states stay
// disclosed underneath so a reader can still see what each source said.
export function readReport({ subject = null, reads = [], window = null } = {}) {
  if (!Array.isArray(reads)) throw new TypeError('a read report needs a list of source reads');
  if (reads.length > MAX_READ_SOURCES) {
    throw new Error(`a read report covers at most ${MAX_READ_SOURCES} sources, not ${reads.length}`);
  }
  for (const read of reads) {
    if (!read || !isReadState(read.state)) {
      throw new TypeError(`a read report needs source reads, got ${JSON.stringify(singleLine(read?.state, 60))}`);
    }
  }
  const windowState = window?.state ?? null;
  const windowBearing = windowState === 'concurrent_modification' || windowState === 'unverifiable';
  const effective = reads.map((read) => {
    if (windowState === 'unverifiable') {
      return { ...read, sourceState: read.state, state: 'unverifiable', usable: false, complete: false, reason: 'a contributing store could not be inspected during this read' };
    }
    if (windowState === 'concurrent_modification') {
      return { ...read, sourceState: read.state, state: 'inconsistent', usable: false, complete: false, reason: 'a contributing store changed while this read was in progress' };
    }
    return { ...read, sourceState: read.state };
  });
  const state = worstReadState(effective.map((read) => read.state));
  const truncatedSources = effective
    .filter((read) => read.state === 'truncated')
    .map((read) => read.source);
  const damagedSources = effective
    .filter((read) => read.state === 'damaged')
    .map((read) => read.source);
  const unavailableSources = effective
    .filter((read) => read.state === 'unavailable' || read.state === 'unverifiable')
    .map((read) => read.source);
  const missingSources = effective
    .filter((read) => read.state === 'missing')
    .map((read) => read.source);

  const canonical = {
    schema: READ_CONTRACT_SCHEMA,
    subject,
    state,
    window: windowState ?? 'unverified',
    reads: effective
      .map((read) => ({
        source: read.source,
        state: read.state,
        returned: read.returned,
        total: read.total,
        limit: read.limit,
        stoppedAt: read.stoppedAt,
      }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
  };

  return {
    schema: READ_CONTRACT_SCHEMA,
    subject,
    state,
    // A complete report covers every source it names. A bounded or truncated one is usable evidence
    // only with disclosure; an unreadable or inconsistent one is not evidence of anything.
    complete: READ_COMPLETE_STATES.includes(state),
    // Patterns over a prefix are not patterns over history.
    patternsAllowed: effective.length > 0 && effective.every((read) => read.state === 'complete_empty' || read.state === 'complete_nonempty'),
    usable: READ_USABLE_STATES.includes(state),
    reads: effective,
    truncatedSources,
    damagedSources,
    unavailableSources,
    missingSources,
    window: windowState ?? 'unverified',
    certification: window?.certification ?? null,
    authorizes: false,
    digest: sha256Hex(stableStringify(canonical)),
    note: 'a complete read covers the whole store it names; a bounded or truncated one covers only what it read, and a prefix is never evidence that the rest does not exist',
  };
}

// True only when the read covered the whole source and the source was empty. Every other state -
// including a bounded window that returned nothing - leaves absence unproven.
export function absenceProven(read) {
  return Boolean(read) && read.state === 'complete_empty' && read.complete === true;
}

// The contract expressed in the closed integrity vocabulary, so a consumer that already reasons about
// integrity does not need a second switch.
const INTEGRITY_OF_READ = Object.freeze({
  complete_empty: 'valid',
  complete_nonempty: 'valid',
  bounded_usable: 'valid_bounded',
  truncated: 'truncated_history',
  missing: 'broken_reference',
  unavailable: 'unverifiable',
  damaged: 'damaged_store',
  inconsistent: 'concurrent_modification',
  unverifiable: 'unverifiable',
});

export function readFindings(report) {
  if (!report || !Array.isArray(report.reads)) return [];
  return report.reads
    .filter((read) => read.state !== 'complete_empty' && read.state !== 'complete_nonempty')
    .map((read) => integrityFinding(INTEGRITY_OF_READ[read.state], {
      check: 'bounded_read',
      subject: read.source,
      readState: read.state,
      detail: read.reason ?? `the read of ${read.source} is ${read.state}`,
    }));
}
