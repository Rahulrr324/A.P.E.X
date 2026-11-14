// Batch AP-10: one retrieval report for every evidence read.
//
// AP-07 says what a bounded read covered. This module says what retrieval did with it: which sources
// were searched, what each returned, what was excluded and why, and whether the selection can be
// called complete. The eleven states are ordered from least to most limiting; a report is described
// by its worst source, so two readers cannot disagree about whether a retrieval that lost records to
// a limit was "complete". The two complete states come first and `complete_empty` before
// `complete_with_results` so a retrieval that contributed records is never described as empty.
//
// The load-bearing rules:
//  - a missing result is never proof of absence; `absenceProven` is reused from the read contract and
//    is false for every bounded window, including one that returned nothing;
//  - an inconsistent or unverifiable window blocks completeness for every source and for the report;
//  - "the store held more than the limit returned", "the relevance floor excluded everything", and
//    "the context budget cut the tail" are three different limitations and stay three different states;
//  - an unreadable source reports null counts, never 0.
import { absenceProven } from '../evidence/read-contract.js';

export const RETRIEVAL_REPORT_SCHEMA = 'apex.retrieval-report.v1';

// Least to most limiting. `not_searched` sits just above the complete states: an intentional skip is
// not a failure, but it still means the report cannot claim it covered every source.
export const RETRIEVAL_STATES = Object.freeze([
  'complete_empty',
  'complete_with_results',
  'not_searched',
  'below_relevance_threshold',
  'bounded_results',
  'source_limit_reached',
  'context_budget_limited',
  'incomplete_source',
  'unavailable_source',
  'damaged_source',
  'inconsistent_snapshot',
]);

const SEVERITY = new Map(RETRIEVAL_STATES.map((state, index) => [state, index]));
const MAX_LIMITATIONS = 12;
const MAX_UNMATCHED = 16;
const FAILURE_STATES = new Set(['incomplete_source', 'unavailable_source', 'damaged_source', 'inconsistent_snapshot']);
const singleLine = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isRetrievalState(state) {
  return SEVERITY.has(state);
}

export function worstRetrievalState(states = []) {
  let worst = 'complete_empty';
  for (const state of states) {
    if (!isRetrievalState(state)) {
      throw new TypeError(`unknown retrieval state ${JSON.stringify(singleLine(state, 60))}`);
    }
    if (SEVERITY.get(state) > SEVERITY.get(worst)) worst = state;
  }
  return worst;
}

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function profileOf(profiles, source) {
  const profile = profiles?.[source];
  return profile && typeof profile === 'object' ? profile : null;
}

// One source's retrieval entry. `returned`/`matched`/`eligible`/`corpusSize` are null when the read
// could not establish them; only `contributed` is always known, because it is counted from the kept
// evidence. `complete` is what the search profile establishes, and `absenceProven` is the stricter
// AP-07 gate: a bounded window that returned nothing proves neither completeness nor absence.
function sourceEntry({ entry, read, profile, contributed, windowBearing }) {
  const source = entry.source;
  const searched = entry.status !== 'skipped';
  const readState = read?.state ?? null;
  const returned = count(profile?.returned);
  const matched = count(profile?.matched);
  const eligible = count(profile?.eligible);
  const corpusSize = count(profile?.corpusSize);
  const limit = count(profile?.limit);
  const queryTokens = count(profile?.queryTokens) ?? 0;
  const droppedTokens = count(profile?.droppedTokens) ?? 0;
  const unmatched = Array.isArray(profile?.unmatched)
    ? profile.unmatched.filter((term) => typeof term === 'string').slice(0, MAX_UNMATCHED)
    : [];
  const belowRelevance = count(profile?.belowRelevance) ?? 0;

  const exclusions = { belowRelevance, sourceLimit: 0, contextBudget: 0 };
  if (matched !== null && returned !== null && matched > returned) exclusions.sourceLimit += matched - returned;
  if (eligible !== null && eligible > contributed) exclusions.sourceLimit += eligible - contributed;

  const windowState = readState === 'inconsistent' || readState === 'unverifiable';
  let complete = false;
  let state;
  let detail;
  if (windowBearing || windowState) {
    state = 'inconsistent_snapshot';
    detail = readState === 'unverifiable'
      ? 'a contributing store could not be inspected, so this read describes no verified snapshot'
      : 'a contributing store changed while this read was in progress';
  } else if (!searched) {
    state = 'not_searched';
    detail = 'this source was not searched for this request';
  } else if (readState === 'unavailable') {
    state = 'unavailable_source';
    detail = singleLine(entry.detail ?? 'the source could not be read, so what it holds is unknown');
  } else if (readState === 'damaged') {
    state = 'damaged_source';
    detail = singleLine(entry.detail ?? 'the source was read but some records could not be parsed');
  } else if (readState === 'missing' || readState === 'truncated') {
    state = 'incomplete_source';
    detail = `the read of this source was ${readState}`;
  } else if (exclusions.contextBudget > 0) {
    state = 'context_budget_limited';
    detail = `${exclusions.contextBudget} record(s) were left out to fit the context budget`;
  } else if (exclusions.sourceLimit > 0) {
    state = 'source_limit_reached';
    detail = 'the source held more eligible records than the bound returned';
  } else if (belowRelevance > 0 && eligible === 0 && returned !== null && returned > 0) {
    state = 'below_relevance_threshold';
    detail = 'every returned record fell below the relevance threshold';
  } else if (returned === 0 && corpusSize === 0 && matched === 0) {
    state = 'complete_empty';
    complete = true;
    detail = 'the search covered the whole store and the store held no records';
  } else if (read?.complete === true) {
    complete = true;
    state = contributed > 0 || (returned !== null && returned > 0) ? 'complete_with_results' : 'complete_empty';
    detail = 'the read covered the whole source';
  } else if (returned === 0 || contributed === 0) {
    state = 'bounded_results';
    detail = 'a bounded read selected no records; the store may hold more';
  } else if (matched !== null && returned !== null && matched === returned
    && (limit === null || returned < limit) && eligible === contributed && belowRelevance === 0) {
    complete = true;
    state = 'complete_with_results';
    detail = 'the search returned every matching record and all of them became evidence';
  } else {
    state = 'bounded_results';
    detail = 'the selection is bounded; more matching records may exist';
  }

  // An unavailable source has no counts. Reporting zero would turn an unknown into an absence.
  const unknown = state === 'unavailable_source';
  return {
    source,
    readState,
    searched,
    returned: unknown ? null : returned,
    matched: unknown ? null : matched,
    eligible: unknown ? null : eligible,
    contributed,
    limit: unknown ? null : limit,
    corpusSize: unknown ? null : corpusSize,
    queryTokens,
    droppedTokens,
    unmatched,
    exclusions,
    complete,
    absenceProven: absenceProven(read),
    state,
    detail,
  };
}

function limitationFor(entry) {
  switch (entry.state) {
    case 'not_searched': return `${entry.source} was not searched for this request`;
    case 'below_relevance_threshold': return `${entry.source} returned only records below the relevance threshold`;
    case 'bounded_results': return `${entry.source} was read under a bound; more records may exist`;
    case 'source_limit_reached': return `${entry.source} held more eligible records than the bound returned`;
    case 'context_budget_limited': return `${entry.source} lost ${entry.exclusions.contextBudget} record(s) to the context budget`;
    case 'incomplete_source': return `the read of ${entry.source} was incomplete (${entry.readState})`;
    case 'unavailable_source': return `${entry.source} could not be read; its contents are unknown, not empty`;
    case 'damaged_source': return `${entry.source} was read but some records could not be parsed`;
    case 'inconsistent_snapshot': return `${entry.source}: ${entry.detail}`;
    default: return null;
  }
}

function summarize(sources, window) {
  const state = worstRetrievalState(sources.map((entry) => entry.state));
  const windowBearing = window === 'concurrent_modification' || window === 'unverifiable';
  const complete = !windowBearing && sources.length > 0 && sources.every((entry) => entry.complete);
  const sum = (pick) => sources.reduce((total, entry) => total + (pick(entry) ?? 0), 0);
  const limitations = [];
  if (windowBearing) {
    limitations.push(window === 'unverifiable'
      ? 'the contributing stores could not be verified as one snapshot; completeness is not claimed'
      : 'the contributing stores changed during the read; the evidence describes no single instant and completeness is not claimed');
  }
  for (const entry of sources) {
    const line = limitationFor(entry);
    if (line && limitations.length < MAX_LIMITATIONS) limitations.push(singleLine(line));
  }
  return {
    state,
    complete,
    counts: {
      sources: sources.length,
      searched: sources.filter((entry) => entry.searched).length,
      notSearched: sources.filter((entry) => !entry.searched).length,
      contributed: sum((entry) => entry.contributed),
      returned: sum((entry) => entry.returned),
      matched: sum((entry) => entry.matched),
      belowRelevance: sum((entry) => entry.exclusions.belowRelevance),
      sourceLimit: sum((entry) => entry.exclusions.sourceLimit),
      contextBudget: sum((entry) => entry.exclusions.contextBudget),
      unavailable: sources.filter((entry) => entry.state === 'unavailable_source').length,
      damaged: sources.filter((entry) => entry.state === 'damaged_source').length,
    },
    limitations,
  };
}

// Builds the report from the coordinator's own records: the source statuses, the AP-07 read report,
// the kept evidence, and the bounded search profiles. Nothing here reads a store.
export function buildRetrievalReport({ sources = [], read = null, kept = [], profiles = {} } = {}) {
  if (!Array.isArray(sources)) throw new TypeError('a retrieval report needs a list of sources');
  const window = read?.window ?? 'unverified';
  const windowBearing = window === 'concurrent_modification' || window === 'unverifiable';
  const reads = new Map((read?.reads ?? []).map((entry) => [entry.source, entry]));
  const contributed = new Map();
  for (const item of kept) {
    contributed.set(item.source, (contributed.get(item.source) ?? 0) + 1);
  }
  const entries = sources.map((entry) => sourceEntry({
    entry,
    read: reads.get(entry.source) ?? null,
    profile: profileOf(profiles, entry.source),
    contributed: contributed.get(entry.source) ?? 0,
    windowBearing,
  }));
  const summary = summarize(entries, window);
  return {
    schema: RETRIEVAL_REPORT_SCHEMA,
    sources: entries,
    window,
    ...summary,
    authorizes: false,
  };
}

// Pure finalization: the prompt budget is only known after buildPrompt trims the context, so the
// controller hands the per-source cut counts back here. A cut makes the source context_budget_limited
// unless a more severe failure already describes it; the aggregate and limitations are recomputed.
// A null cut is unknown and changes nothing.
export function finalizeRetrievalReport(report, { context = {} } = {}) {
  if (!report || report.schema !== RETRIEVAL_REPORT_SCHEMA) {
    throw new TypeError('finalizeRetrievalReport needs a retrieval report');
  }
  const cuts = { memory: count(context?.memory), knowledge: count(context?.knowledge) };
  const sources = report.sources.map((entry) => {
    // Only the two prompt-budget sources have a known cut. Every other source is absent from `cuts`,
    // and an absent key is unknown, not zero: adding `undefined` to a count produced NaN and marked
    // all eighteen sources context_budget_limited on a request that trimmed nothing.
    const cut = Object.hasOwn(cuts, entry.source) ? cuts[entry.source] : null;
    if (cut === null || cut === 0) return entry;
    const exclusions = { ...entry.exclusions, contextBudget: entry.exclusions.contextBudget + cut };
    const state = FAILURE_STATES.has(entry.state) ? entry.state : 'context_budget_limited';
    return {
      ...entry,
      exclusions,
      state,
      complete: false,
      detail: state === 'context_budget_limited'
        ? `${exclusions.contextBudget} record(s) were left out to fit the context budget`
        : entry.detail,
    };
  });
  const summary = summarize(sources, report.window);
  return {
    ...report,
    sources,
    ...summary,
    authorizes: false,
  };
}

// The user-facing disclosure for a budget cut. It names the counts and that the records remain
// stored; it never claims the omitted records were irrelevant or absent.
export function retrievalBudgetNotice(report) {
  const cut = (report?.sources ?? []).filter((entry) => entry.exclusions.contextBudget > 0);
  if (cut.length === 0) return '';
  const total = cut.reduce((sum, entry) => sum + entry.exclusions.contextBudget, 0);
  const parts = cut.map((entry) => `${entry.source}: ${entry.exclusions.contextBudget}`).join(', ');
  return `[APEX retrieval: ${total} retrieved record(s) were left out of this answer to fit the context budget (${parts}); they remain stored and a narrower question may recall them.]`;
}