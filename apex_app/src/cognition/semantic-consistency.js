// Semantic consistency between a claim and the records it cites.
//
// AP-08 established *lexical* attribution: a claim restates a cited record when enough of its content
// words appear there. That comparison cannot tell "the operation succeeded" from "the operation did
// not succeed", because every word but one is shared. This module adds a second, independent check on
// the dimensions a bounded deterministic rule can actually decide:
//
//   polarity      explicit negation and its clause scope, plus a fixed antonym table
//   numerical     values, signs, units, bound vs exact quantities, ranges, added precision
//   temporal      dates, periods, weekdays, explicit ordering pairs
//   entity        capitalised names checked against every word of the cited records
//   relationship  a closed set of relation verbs, including passive reversal
//   qualifier     quantifier and certainty ladders
//   transformation  causation or uniqueness added by the claim
//
// None of this is natural-language understanding. Each check is a fixed rule over tokens, and when a
// rule cannot decide, the result is `ambiguous` or `insufficient_evidence`, never an optimistic
// upgrade. The closed finding vocabulary and its precedence are explicit so a later reader can see
// why one outcome won over another. No numeric confidence is produced: the only numbers here are
// token counts and quantities copied from the text.
//
// The module reads no store and writes nothing. It is handed the claim text and the retrieval map that
// the response-integrity layer already has, and returns a record that says `authorizes: false`.
import { EvidenceState, EvidenceValidity } from './vocabulary.js';

export const SEMANTIC_SCHEMA = 1;

export const SemanticFinding = Object.freeze({
  SEMANTICALLY_CONSISTENT: 'semantically_consistent',
  PARTIALLY_CONSISTENT: 'partially_consistent',
  POLARITY_CONFLICT: 'polarity_conflict',
  NUMERICAL_CONFLICT: 'numerical_conflict',
  TEMPORAL_CONFLICT: 'temporal_conflict',
  ENTITY_CONFLICT: 'entity_conflict',
  RELATIONSHIP_CONFLICT: 'relationship_conflict',
  QUALIFIER_CONFLICT: 'qualifier_conflict',
  UNSUPPORTED_TRANSFORMATION: 'unsupported_transformation',
  AMBIGUOUS: 'ambiguous',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  UNAVAILABLE: 'unavailable',
  NOT_CHECKED: 'not_checked',
});

export const SEMANTIC_FINDINGS = Object.freeze(Object.values(SemanticFinding));

export const SemanticDimension = Object.freeze({
  ATTRIBUTION: 'attribution',
  POLARITY: 'polarity',
  NUMERICAL: 'numerical',
  TEMPORAL: 'temporal',
  ENTITY: 'entity',
  RELATIONSHIP: 'relationship',
  QUALIFIER: 'qualifier',
  TRANSFORMATION: 'transformation',
});

export const SEMANTIC_DIMENSIONS = Object.freeze(Object.values(SemanticDimension));

export const SemanticDimensionStatus = Object.freeze({
  CHECKED: 'checked',
  CONFLICT: 'conflict',
  AMBIGUOUS: 'ambiguous',
  NOT_APPLICABLE: 'not_applicable',
  NOT_CHECKED: 'not_checked',
  UNAVAILABLE: 'unavailable',
});

// Highest precedence first. A conflict always outranks ambiguity, ambiguity outranks a partial
// reading, and a partial reading outranks the consistent label. The three "could not check" outcomes
// are fixed ahead of the conflicts because they describe the reading itself, not the claim.
//   unavailable > not_checked > insufficient_evidence > polarity > numerical > temporal > entity >
//   relationship > qualifier > transformation > ambiguous > partially_consistent > semantically_consistent
export const SEMANTIC_PRECEDENCE = Object.freeze([
  SemanticFinding.UNAVAILABLE,
  SemanticFinding.NOT_CHECKED,
  SemanticFinding.INSUFFICIENT_EVIDENCE,
  SemanticFinding.POLARITY_CONFLICT,
  SemanticFinding.NUMERICAL_CONFLICT,
  SemanticFinding.TEMPORAL_CONFLICT,
  SemanticFinding.ENTITY_CONFLICT,
  SemanticFinding.RELATIONSHIP_CONFLICT,
  SemanticFinding.QUALIFIER_CONFLICT,
  SemanticFinding.UNSUPPORTED_TRANSFORMATION,
  SemanticFinding.AMBIGUOUS,
  SemanticFinding.PARTIALLY_CONSISTENT,
  SemanticFinding.SEMANTICALLY_CONSISTENT,
]);

export const SEMANTIC_AUTHORITY = Object.freeze({
  authorizes: false,
  factualAuthority: 'none',
  statement: 'A semantic finding compares wording with cited records. It neither establishes truth nor grants authority; only the action registry authorizes an action.',
});

// Fixed reasons. A reason never carries claim text, record text, or model prose, so an audit line can
// name why a check failed without becoming a second copy of the answer.
const REASON = Object.freeze({
  NOT_A_FACT: 'the claim is not presented as a stored fact, so there is no entailment to check',
  NO_CITATION: 'the claim cites no record',
  NO_INDEX: 'the retrieval index for this request is unavailable',
  NO_CONTENT: 'the claim has no checkable content words',
  RETRIEVED_OUTSIDE_WINDOW: 'the request did not finish retrieving its evidence',
  SNAPSHOT_NOT_CONSISTENT: 'the contributing stores could not be checked as one consistent snapshot',
  MISSING_RECORD: 'a cited record is not in this retrieval',
  UNREADABLE_RECORD: 'a cited record has no readable statement',
  WITHDRAWN: 'a cited record was retracted or replaced and no longer stands',
  NOT_CURRENT: 'a cited record describes a past state and the claim is not marked historical',
  CONTESTED: 'a cited record is contested or unverified',
  TOO_LITTLE_OVERLAP: 'the claim does not restate the cited records closely enough to check its meaning',
  POLARITY: 'a shared predicate has opposite polarity in the claim and the cited records',
  ANTONYM: 'the claim states the opposite of a predicate in the cited records',
  VALUE: 'the claim states a different quantity from the cited records',
  UNIT: 'the claim states the same magnitude in a different unit',
  BOUND: 'the claim changes a bound into an exact value or reverses the comparison',
  PRECISION: 'the claim states more numerical precision than the cited records support',
  ADDED_QUANTITY: 'the claim states a quantity the cited records do not',
  DATE: 'the claim states a different date or period from the cited records',
  ADDED_DATE: 'the claim states a date or period the cited records do not',
  ORDER: 'the claim reverses the order of two events recorded in the cited records',
  ENTITY: 'the claim names an entity the cited records do not',
  RELATION: 'the claim reverses a relationship recorded in the cited records',
  QUANTIFIER: 'the claim changes a quantifier stated by the cited records',
  CERTAINTY: 'the claim states more certainty than the cited records support',
  CAUSAL: 'the claim asserts a causal link the cited records do not',
  UNIQUENESS: 'the claim asserts uniqueness the cited records do not',
  NEGATION_SCOPE: 'negation in the claim cannot be scoped deterministically',
  BOUNDED: 'the retrieval was bounded, so the cited records are not a complete statement',
  OMITTED_DIMENSION: 'the cited records state a value or date the claim omits',
  PARTIAL_CITATION: 'one or more cited records could not be read, so the claim rests only in part on this retrieval',
});

// ---- shared tokenizer --------------------------------------------------------------------------

// The same tokenizer AP-08 uses for attribution, exported so coverage means one thing in both
// modules. Content words only: lower-case, more than two characters, minus the function words.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'with', 'that', 'this', 'from',
  'into', 'but', 'not', 'its', 'his', 'her', 'their', 'our', 'you', 'your', 'they', 'them', 'then',
  'than', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'about', 'would',
  'could', 'should', 'will', 'shall', 'may', 'might', 'must', 'been', 'being', 'does', 'did', 'done',
]);

export function contentTokens(text) {
  const tokens = String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
  return new Set(tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

function lower(value) {
  return String(value ?? '').toLowerCase();
}

// A deliberately small morphological fold used only by the dimension checks, never by coverage. It
// makes "succeeded"/"succeed" and "tests"/"test" comparable without pretending to be a stemmer.
function fold(word) {
  let value = word;
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  // Words such as "succeed" already end in "-eed"; stripping "ed" there would fold the base word
  // differently from its own past tense.
  else if (value.length > 4 && value.endsWith('ed') && !value.endsWith('eed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1);
  if (value.length > 4 && value.endsWith('e')) value = value.slice(0, -1);
  return value;
}

const LEXEME = /[a-z0-9]+(?:['\u2019][a-z]+)?/g;

function lexemes(text) {
  const words = lower(text).match(LEXEME) ?? [];
  return words.slice(0, 240).map((word) => ({ word, norm: fold(word) }));
}

// Clause boundaries delimit negation scope. `and` is deliberately not a boundary: "was not approved
// and not executed" negates both, while `but` and a full stop do start a new scope.
const CLAUSE_SPLIT = /[,;.!?]|\b(?:but|however|whereas|although|though|yet)\b/;

function clauses(text) {
  return lower(text).split(CLAUSE_SPLIT).slice(0, 16).map(lexemes).filter((parts) => parts.length > 0);
}

function isContent(part) {
  return part.word.length > 2 && !STOPWORDS.has(part.word) && !NEGATION_CUES.has(part.word);
}

function firstContent(parts) {
  return parts.find(isContent) ?? null;
}

function lastContent(parts) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (isContent(parts[index])) return parts[index];
  }
  return null;
}

// ---- polarity ----------------------------------------------------------------------------------

const NEGATION_CUES = new Set([
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor', 'cannot', 'without',
  "can't", "didn't", "doesn't", "isn't", "wasn't", "aren't", "weren't", "won't", "wouldn't",
  "shouldn't", "couldn't", "don't", "hasn't", "haven't", "hadn't",
]);

// "not all", "not every", and "not necessarily" deny a quantity, not a predicate. Their scope is not
// recoverable from the words alone, so they are reported as ambiguous rather than negated.
const PARTIAL_NEGATION = new Set(['only', 'all', 'every', 'always', 'necessarily', 'entirely', 'fully', 'both', 'quite']);

const ANTONYM_GROUPS = Object.freeze([
  ['succeed', 'success', 'fail', 'failur'],
  ['approv', 'reject', 'deni', 'deny', 'refus'],
  ['open', 'clos'],
  ['complet', 'incomplet', 'abandon', 'unfinish'],
  ['valid', 'invalid'],
  ['present', 'absent'],
  ['true', 'fals'],
  ['enabl', 'disabl'],
  ['start', 'stop', 'halt'],
  ['gain', 'loss'],
  ['win', 'lose'],
  ['connect', 'disconnect'],
  ['includ', 'exclud'],
  ['add', 'remov'],
  ['safe', 'unsaf'],
  ['activ', 'inactiv'],
  ['accept', 'refus'],
  ['allow', 'forbid'],
  ['high', 'low'],
  ['abov', 'below'],
  ['first', 'last'],
]);

// Reversals of direction belong to the numerical dimension when a quantity is present, and to
// polarity when it is not: "the rate increased" and "the rate decreased" assert opposite directions.
const DIRECTION_GROUPS = Object.freeze([
  ['increas', 'decreas'],
  ['rise', 'fall'],
  ['grow', 'declin'],
  ['expand', 'shrink'],
  ['higher', 'lower'],
  ['more', 'less', 'fewer'],
  ['greater', 'smaller'],
  ['up', 'down'],
]);

function addSign(map, norm, sign) {
  const set = map.get(norm) ?? new Set();
  set.add(sign);
  map.set(norm, set);
}

function polarityOf(text) {
  const map = new Map();
  let ambiguous = false;
  for (const clause of clauses(text)) {
    let negated = false;
    let cues = 0;
    let applied = 0;
    for (let index = 0; index < clause.length; index += 1) {
      const part = clause[index];
      if (NEGATION_CUES.has(part.word)) {
        if (PARTIAL_NEGATION.has(clause[index + 1]?.word)) {
          ambiguous = true;
          continue;
        }
        negated = true;
        cues += 1;
        continue;
      }
      if (!isContent(part)) continue;
      if (negated) applied += 1;
      addSign(map, part.norm, negated ? -1 : 1);
    }
    if (negated && applied === 0) ambiguous = true;
    if (cues >= 2) ambiguous = true;
  }
  return { map, ambiguous };
}

function overlap(leftMap, rightMap) {
  for (const [norm, leftSigns] of leftMap) {
    const rightSigns = rightMap.get(norm);
    if (!rightSigns) continue;
    let same = false;
    for (const sign of leftSigns) if (rightSigns.has(sign)) same = true;
    if (!same) return norm;
  }
  return null;
}

function antonymPair(claimNorms, recordNorms) {
  for (const group of ANTONYM_GROUPS) {
    const claimHit = group.find((word) => claimNorms.has(word));
    const recordHit = recordNorms.has(claimHit)
      ? null
      : group.find((word) => word !== claimHit && recordNorms.has(word));
    if (claimHit && recordHit) return { claimHit, recordHit };
  }
  return null;
}

function directionPair(claimNorms, recordNorms) {
  for (const group of DIRECTION_GROUPS) {
    const claimHit = group.find((word) => claimNorms.has(word) && !recordNorms.has(word));
    if (!claimHit) continue;
    const recordHit = group.find((word) => word !== claimHit && recordNorms.has(word));
    if (recordHit) return { claimHit, recordHit };
  }
  return null;
}

function comparePolarity(claim, record, { numbersPresent }) {
  const opposite = overlap(claim.polarity.map, record.polarity.map);
  if (opposite) return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.POLARITY_CONFLICT, reason: REASON.POLARITY };
  const claimNorms = new Set(claim.norms);
  const recordNorms = new Set(record.norms);
  if (antonymPair(claimNorms, recordNorms)) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.POLARITY_CONFLICT, reason: REASON.ANTONYM };
  }
  // With a quantity present, a direction reversal is a change to the sign of that quantity, so the
  // numerical dimension owns it. Without one it is a reversal of the predicate itself.
  if (!numbersPresent && directionPair(claimNorms, recordNorms)) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.POLARITY_CONFLICT, reason: REASON.ANTONYM };
  }
  if (claim.polarity.ambiguous) {
    return { status: SemanticDimensionStatus.AMBIGUOUS, code: SemanticFinding.AMBIGUOUS, reason: REASON.NEGATION_SCOPE };
  }
  return { status: SemanticDimensionStatus.CHECKED, code: null, reason: null };
}

// ---- numerical ---------------------------------------------------------------------------------

const UNIT_ALIASES = new Map(Object.entries({
  day: 'day', days: 'day', hour: 'hour', hours: 'hour', minute: 'minute', minutes: 'minute',
  second: 'second', seconds: 'second', week: 'week', weeks: 'week', month: 'month', months: 'month',
  year: 'year', years: 'year', ms: 'ms', millisecond: 'ms', milliseconds: 'ms',
  percent: 'percent', percentage: 'percent', pct: 'percent',
  record: 'record', records: 'record', file: 'file', files: 'file', test: 'test', tests: 'test',
  item: 'item', items: 'item', row: 'row', rows: 'row', byte: 'byte', bytes: 'byte',
  kb: 'kb', mb: 'mb', gb: 'gb', tb: 'tb', request: 'request', requests: 'request',
  attempt: 'attempt', attempts: 'attempt', user: 'user', users: 'user', dollar: 'usd',
  dollars: 'usd', usd: 'usd', eur: 'eur', step: 'step', steps: 'step',
}));

const APPROXIMATION = /(?:about|around|approximately|roughly|nearly|almost|estimated|circa)\s*$/;
const BOUND_COMPARATORS = new Set(['>=', '<=', '>', '<']);
const DATE_LIKE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

function normalizeUnit(word) {
  if (!word) return null;
  const cleaned = lower(word).replace(/[^a-z%]/g, '');
  if (cleaned === '%' || cleaned === 'percent') return 'percent';
  return UNIT_ALIASES.get(cleaned) ?? null;
}

// Dates and clock times are masked before quantities are read, so a year or a timestamp is not
// counted as a magnitude. Ranges are read first, then removed from the scan.
function readQuantities(text) {
  const original = lower(text);
  let work = original.replace(DATE_LIKE, ' <time> ');
  const out = [];
  work = work.replace(/(\d+(?:\.\d+)?)\s*(?:-|\u2013|\bto\b)\s*(\d+(?:\.\d+)?)(?:\s*([a-z%]+))?/g, (match, from, to, unit) => {
    out.push({
      kind: 'range', min: Number(from), max: Number(to), unit: normalizeUnit(unit), comparator: null, decimals: 0,
    });
    return ' <range> ';
  });
  const pattern = /([+-])?\s*(\d+(?:\.\d+)?)(?:\s*(%))?(\s*([a-z]+))?/g;
  let match = pattern.exec(work);
  while (match) {
    const raw = match[2];
    const tail = match[5] ?? '';
    const unit = match[3] ? 'percent' : normalizeUnit(tail);
    // The match may begin with whitespace consumed before the digits, so the glue test must look at
    // the character immediately before the number itself.
    const digitStart = match.index + match[0].indexOf(raw);
    const bareYear = !unit && /^(?:19|20)\d{2}$/.test(raw);
    const glued = digitStart > 0 && /[a-z0-9]/.test(work[digitStart - 1]);
    if (!bareYear && !glued) {
      const before = work.slice(Math.max(0, digitStart - 28), digitStart);
      let comparator = null;
      if (/at least\s*$/.test(before)) comparator = '>=';
      else if (/at most\s*$/.test(before)) comparator = '<=';
      else if (/(?:more|greater|higher|longer|larger) than\s*$/.test(before)) comparator = '>';
      else if (/(?:less|fewer|lower|shorter|smaller) than\s*$/.test(before)) comparator = '<';
      else if (APPROXIMATION.test(before)) comparator = '~';
      else if (/exactly\s*$/.test(before)) comparator = '=';
      out.push({
        kind: 'value',
        value: Number(`${match[1] === '-' ? '-' : ''}${raw}`),
        unit,
        comparator,
        decimals: (raw.split('.')[1] ?? '').length,
        approximate: APPROXIMATION.test(before),
      });
    }
    match = pattern.exec(work);
  }
  return { quantities: out.slice(0, 12), text: original };
}

// Same magnitude and same unit. Ranges compare as intervals; a value inside a recorded range is
// compatible with it, and a range that contains a recorded value is compatible with that value.
function magnitudeEqual(claim, record) {
  if (claim.kind === 'range' && record.kind === 'range') {
    return claim.min === record.min && claim.max === record.max;
  }
  if (claim.kind === 'range') return record.value >= claim.min && record.value <= claim.max;
  if (record.kind === 'range') return claim.value >= record.min && claim.value <= record.max;
  return claim.value === record.value;
}

function compareQuantities(claim, record, claimText) {
  const claimQ = claim.quantities;
  const recordQ = record.quantities;
  if (claimQ.length === 0 && recordQ.length === 0) return null;
  if (recordQ.length === 0) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.UNSUPPORTED_TRANSFORMATION, reason: REASON.ADDED_QUANTITY, omitted: false };
  }
  if (claimQ.length === 0) {
    return { status: SemanticDimensionStatus.CHECKED, code: null, reason: null, omitted: true };
  }
  const recordUnits = new Set(recordQ.map((item) => item.unit).filter(Boolean));
  for (const item of claimQ) {
    // A claim that omits the unit is compatible with a record that states exactly one.
    const unit = item.unit ?? (recordUnits.size === 1 ? [...recordUnits][0] : null);
    const sameUnit = recordQ.filter((other) => other.unit === unit || (item.unit !== null && other.unit === item.unit));
    const equal = sameUnit.find((other) => magnitudeEqual(item, other));
    if (!equal) {
      if (sameUnit.length > 0) {
        // Same unit and the same underlying magnitude, but one side states a bound and the other an
        // exact value: a comparison changed. Otherwise the magnitude itself moved.
        const boundChange = sameUnit.some((other) => other.kind === item.kind
          && other.kind === 'value'
          && other.value === item.value
          && Boolean(other.comparator) !== Boolean(item.comparator));
        return {
          status: SemanticDimensionStatus.CONFLICT,
          code: SemanticFinding.NUMERICAL_CONFLICT,
          reason: boundChange ? REASON.BOUND : REASON.VALUE,
          omitted: false,
        };
      }
      const sameMagnitude = recordQ.find((other) => other.kind === 'value'
        && item.kind === 'value' && other.value === item.value);
      if (sameMagnitude) {
        return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.UNIT, omitted: false };
      }
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.VALUE, omitted: false };
    }
    if (item.comparator && !equal.comparator) {
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.BOUND, omitted: false };
    }
    if (item.comparator && equal.comparator && item.comparator !== equal.comparator) {
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.BOUND, omitted: false };
    }
    // The record states a bound and the claim states the same number as an exact value: the claim
    // asserts more than the record establishes, which is a change of comparison, not a match.
    if (!item.comparator && BOUND_COMPARATORS.has(equal.comparator)) {
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.BOUND, omitted: false };
    }
    if (!item.comparator && equal.comparator === '~') {
      return { status: SemanticDimensionStatus.AMBIGUOUS, code: SemanticFinding.AMBIGUOUS, reason: REASON.PRECISION, omitted: false };
    }
    if (item.decimals > (equal.decimals ?? 0) && (equal.approximate || APPROXIMATION.test(lower(claimText)))) {
      return { status: SemanticDimensionStatus.AMBIGUOUS, code: SemanticFinding.AMBIGUOUS, reason: REASON.PRECISION, omitted: false };
    }
  }
  // Every magnitude matched, but the words around them point in opposite directions (increased vs
  // decreased, higher vs lower). For a stated change, that is the sign of the quantity.
  if (compareDirection(claim, record)) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.NUMERICAL_CONFLICT, reason: REASON.VALUE, omitted: false };
  }
  return { status: SemanticDimensionStatus.CHECKED, code: null, reason: null, omitted: false };
}

function compareDirection(claim, record) {
  const claimNorms = new Set(claim.norms);
  const recordNorms = new Set(record.norms);
  return directionPair(claimNorms, recordNorms) ? true : false;
}

// ---- temporal ----------------------------------------------------------------------------------

const MONTHS = Object.freeze([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december',
]);
const MONTH_ABBREVIATIONS = Object.freeze(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
const WEEKDAYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

const ORDER_WORDS = new Map([
  ['before', 'before'], ['after', 'after'], ['then', 'before'], ['precedes', 'before'],
  ['follows', 'after'], ['preceding', 'before'], ['following', 'after'],
]);

function readTemporal(text) {
  const body = lower(text);
  const out = new Set();
  for (const match of body.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add(match[0]);
  const monthPattern = new RegExp(`\\b(${MONTHS.join('|')}|${MONTH_ABBREVIATIONS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'g');
  for (const match of body.matchAll(monthPattern)) {
    out.add(`month-day:${match[1].slice(0, 3)}-${Number(match[2])}${match[3] ? `-${match[3]}` : ''}`);
  }
  const reverseMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')}|${MONTH_ABBREVIATIONS.join('|')})[a-z]*`, 'g');
  for (const match of body.matchAll(reverseMonth)) {
    out.add(`day-month:${Number(match[1])}-${match[2].slice(0, 3)}`);
  }
  for (const weekday of WEEKDAYS) if (new RegExp(`\\b${weekday}\\b`).test(body)) out.add(weekday);
  for (const match of body.matchAll(/\b(?:19|20)\d{2}\b/g)) out.add(`year:${match[0]}`);
  for (const match of body.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)) out.add(`time:${match[0]}`);
  for (const match of body.matchAll(/\b(last|this|next|previous|current)\s+(day|week|month|quarter|year)\b/g)) {
    out.add(`${match[1]} ${match[2]}`);
  }
  for (const word of ['today', 'yesterday', 'tomorrow', 'tonight']) {
    if (new RegExp(`\\b${word}\\b`).test(body)) out.add(word);
  }
  for (const match of body.matchAll(/\bq[1-4]\b/g)) out.add(match[0]);
  return out;
}

// Two events joined by an ordering word. The subject is the first content word of the clause, which
// is the bounded stand-in for the event; the object is the first content word after the marker.
function readOrdering(text) {
  const pairs = [];
  for (const clause of clauses(text)) {
    const index = clause.findIndex((part) => ORDER_WORDS.has(part.word));
    if (index <= 0 || index >= clause.length - 1) continue;
    const left = firstContent(clause.slice(0, index));
    const right = firstContent(clause.slice(index + 1));
    if (!left || !right) continue;
    pairs.push(ORDER_WORDS.get(clause[index].word) === 'before'
      ? `${left.norm}>${right.norm}`
      : `${right.norm}>${left.norm}`);
  }
  return pairs.slice(0, 6);
}

function compareTemporal(claim, record) {
  const claimTimes = claim.temporal;
  const recordTimes = record.temporal;
  for (const pair of claim.ordering) {
    const [left, right] = pair.split('>');
    if (record.ordering.includes(`${right}>${left}`)) {
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.TEMPORAL_CONFLICT, reason: REASON.ORDER, omitted: false };
    }
  }
  if (claimTimes.size === 0 && recordTimes.size === 0) return null;
  if (recordTimes.size === 0) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.UNSUPPORTED_TRANSFORMATION, reason: REASON.ADDED_DATE, omitted: false };
  }
  if (claimTimes.size === 0) {
    return { status: SemanticDimensionStatus.CHECKED, code: null, reason: null, omitted: true };
  }
  for (const value of claimTimes) {
    if (!recordTimes.has(value)) {
      return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.TEMPORAL_CONFLICT, reason: REASON.DATE, omitted: false };
    }
  }
  return { status: SemanticDimensionStatus.CHECKED, code: null, reason: null, omitted: false };
}

// ---- entity ------------------------------------------------------------------------------------

// A sentence-initial capital is not a name. Quantifiers, hedges, and common sentence starters are
// excluded so that "All tests passed" and "Some tests passed" differ on the qualifier dimension
// rather than producing a spurious entity conflict on the word "All".
const NON_ENTITY = new Set([
  'apex', 'i', 'we', 'you', 'it', 'this', 'that', 'these', 'those', 'there', 'here', 'what', 'when',
  'where', 'who', 'why', 'how', 'if', 'then', 'so', 'but', 'also', 'please', 'note', 'yes', 'okay',
  'ok', 'sure', 'all', 'some', 'every', 'each', 'most', 'many', 'few', 'several', 'none', 'both',
  'either', 'neither', 'other', 'another', 'any', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'first', 'second', 'third', 'last', 'next', 'previous', 'current',
  'today', 'tomorrow', 'yesterday', 'now', 'however', 'although', 'though', 'yet', 'because',
  'therefore', 'thus', 'hence', 'consequently', 'finally', 'overall', 'summary', 'answer',
  'possibly', 'perhaps', 'maybe', 'likely', 'probably', 'expected', 'confirmed', 'verified', 'must',
  'certainly', 'definitely', 'guaranteed', 'proven', 'not', 'never', 'nothing', 'nobody', 'without',
]);

function readEntities(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/\b([A-Z][A-Za-z0-9]*(?:[-_.:'][A-Za-z0-9]+)*)/g)) {
    const word = match[1].toLowerCase();
    if (word.length < 2) continue;
    if (NON_ENTITY.has(word) || STOPWORDS.has(word)) continue;
    if (NON_ENTITY.has(word.split(/[-_.:']/)[0])) continue;
    if (MONTHS.includes(word) || MONTH_ABBREVIATIONS.includes(word) || WEEKDAYS.includes(word)) continue;
    found.add(word);
  }
  return [...found].slice(0, 16);
}

// A name is accepted when the cited records use the same word anywhere in their own vocabulary. A
// similar-looking name is not the same entity: `atlas-one` and `atlas-two` are different words.
function compareEntities(claim, record) {
  const unknown = claim.entities.filter((entity) => !record.words.has(entity));
  if (unknown.length === 0) return null;
  return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.ENTITY_CONFLICT, reason: REASON.ENTITY, omitted: false };
}

// ---- relationship ------------------------------------------------------------------------------

const RELATION_VERBS = new Map(Object.entries({
  owns: 'own', own: 'own', owned: 'own', owner: 'own', owning: 'own',
  manages: 'manage', managed: 'manage', managing: 'manage',
  requires: 'require', required: 'require',
  depends: 'depend', depended: 'depend', depending: 'depend',
  contains: 'contain', contained: 'contain', containing: 'contain',
  includes: 'include', included: 'include', including: 'include',
  supports: 'support', supported: 'support', supporting: 'support',
  blocks: 'block', blocked: 'block', blocking: 'block',
  assigned: 'assign', assigns: 'assign',
  belongs: 'belong', belonged: 'belong',
  reports: 'report', reported: 'report',
  uses: 'use', used: 'use', using: 'use',
  creates: 'create', created: 'create', made: 'make',
  leads: 'lead', led: 'lead', leading: 'lead',
}));

const EQUALS = /\b([a-z][a-z0-9_.-]{1,30})\s*(?:status|state|owner|value)?\s*=\s*([a-z][a-z0-9_.-]{1,30})\b/gi;
const OWNER_EQUALS = /\b([a-z][a-z0-9_.-]{1,30})\s+owner\s*=\s*([a-z][a-z0-9_.-]{1,30})\b/gi;

function readRelations(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(OWNER_EQUALS)) {
    out.push({ subject: fold(lower(match[2])), verb: 'own', object: fold(lower(match[1])) });
  }
  for (const match of String(text ?? '').matchAll(EQUALS)) {
    const left = fold(lower(match[1]));
    const right = fold(lower(match[2]));
    if (left === right) continue;
    if (!out.some((entry) => entry.subject === right && entry.object === left)) {
      out.push({ subject: left, verb: 'equals', object: right });
    }
  }
  for (const clause of clauses(text)) {
    for (let index = 0; index < clause.length; index += 1) {
      const verb = RELATION_VERBS.get(clause[index].word);
      if (!verb) continue;
      const left = lastContent(clause.slice(0, index));
      if (!left) continue;
      let cursor = index + 1;
      let passive = false;
      while (cursor < clause.length) {
        const part = clause[cursor];
        if (part.word === 'by') {
          passive = true;
          cursor += 1;
          continue;
        }
        if (!isContent(part)) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (cursor >= clause.length) continue;
      const right = clause[cursor];
      out.push(passive
        ? { subject: right.norm, verb, object: left.norm }
        : { subject: left.norm, verb, object: right.norm });
    }
  }
  return out.slice(0, 12);
}

function compareRelations(claim, record) {
  for (const claimPair of claim.relations) {
    for (const recordPair of record.relations) {
      if (claimPair.verb !== recordPair.verb) continue;
      if (claimPair.subject === claimPair.object) continue;
      if (claimPair.subject === recordPair.object && claimPair.object === recordPair.subject) {
        return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.RELATIONSHIP_CONFLICT, reason: REASON.RELATION, omitted: false };
      }
    }
  }
  return null;
}

// ---- qualifier ---------------------------------------------------------------------------------

const QUANTIFIERS = new Map(Object.entries({
  none: 0, zero: 0, no: 0, nothing: 0,
  some: 1, few: 1, several: 1, many: 1, any: 1, certain: 1,
  most: 2, majority: 2,
  all: 3, every: 3, each: 3, everyone: 3, everything: 3,
}));

const CERTAINTY = new Map(Object.entries({
  possibly: 0, perhaps: 0, maybe: 0, might: 0, uncertain: 0,
  likely: 1, probably: 1, expected: 1,
  must: 2, certainly: 2, definitely: 2, confirmed: 2, guaranteed: 2, proven: 2, verified: 2,
}));

function readQuantifiers(text) {
  const governed = new Map();
  for (const clause of clauses(text)) {
    for (let index = 0; index < clause.length; index += 1) {
      const rank = QUANTIFIERS.get(clause[index].word);
      if (rank === undefined) continue;
      const noun = clause.slice(index + 1).find(isContent);
      if (!noun) continue;
      governed.set(noun.norm, Math.max(governed.get(noun.norm) ?? -1, rank));
    }
  }
  return governed;
}

function readCertainty(text) {
  let rank = 1;
  let seen = false;
  for (const part of lexemes(text)) {
    const value = CERTAINTY.get(part.word);
    if (value === undefined) continue;
    seen = true;
    rank = Math.max(rank, value);
  }
  return { rank, seen };
}

function compareQualifiers(claim, record) {
  for (const [noun, rank] of claim.quantifiers) {
    const other = record.quantifiers.get(noun);
    if (other === undefined || other === rank) continue;
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.QUALIFIER_CONFLICT, reason: REASON.QUANTIFIER, omitted: false };
  }
  if (claim.certainty.rank > record.certainty.rank && claim.certainty.rank >= 2) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.QUALIFIER_CONFLICT, reason: REASON.CERTAINTY, omitted: false };
  }
  // A hedge the claim drops asserts more certainty than the record states, even when the claim uses
  // no certainty word of its own: "possibly delayed" restated as "delayed" is an upgrade.
  if (record.certainty.seen && !claim.certainty.seen && record.certainty.rank <= 1) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.QUALIFIER_CONFLICT, reason: REASON.CERTAINTY, omitted: false };
  }
  return null;
}

// ---- transformation ----------------------------------------------------------------------------

const CAUSAL_MARKERS = /\b(?:because|therefore|thus|hence|consequently|caused|causes|causing|due to|led to|leads to|results? in|resulted in|as a result|in order to|so that)\b/;
const UNIQUENESS_MARKERS = /\b(?:only|sole|unique|exclusively|first ever|never before)\b/;

function compareTransformation(claim, record, claimText, recordText) {
  const claimCausal = CAUSAL_MARKERS.test(lower(claimText));
  const recordCausal = CAUSAL_MARKERS.test(lower(recordText));
  if (claimCausal && !recordCausal) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.UNSUPPORTED_TRANSFORMATION, reason: REASON.CAUSAL, omitted: false };
  }
  if (UNIQUENESS_MARKERS.test(lower(claimText)) && !UNIQUENESS_MARKERS.test(lower(recordText))) {
    return { status: SemanticDimensionStatus.CONFLICT, code: SemanticFinding.UNSUPPORTED_TRANSFORMATION, reason: REASON.UNIQUENESS, omitted: false };
  }
  return null;
}

// ---- text analysis -----------------------------------------------------------------------------

function analyze(text) {
  const parts = lexemes(text);
  const quantities = readQuantities(text);
  return {
    polarity: polarityOf(text),
    quantities: quantities.quantities,
    temporal: readTemporal(text),
    ordering: readOrdering(text),
    entities: readEntities(text),
    relations: readRelations(text),
    quantifiers: readQuantifiers(text),
    certainty: readCertainty(text),
    norms: parts.map((part) => part.norm),
    words: new Set(parts.map((part) => part.word)),
    hasNumbers: quantities.quantities.length > 0,
  };
}

// ---- per-claim assessment ----------------------------------------------------------------------

const FACTUAL_KINDS = new Set(['supported', 'partially_supported', 'historical']);
const BAD_STATES = new Set([
  EvidenceState.RETRACTED,
  EvidenceState.SUPERSEDED,
  EvidenceState.CONFLICTING,
  EvidenceState.UNVERIFIED,
  EvidenceState.UNSUPPORTED,
]);
const WINDOW_STATES = new Set(['missing', 'unavailable', 'damaged']);
const UNVERIFIABLE_STATES = new Set(['inconsistent', 'unverifiable']);

function emptyDimensions() {
  return Object.fromEntries(SEMANTIC_DIMENSIONS.map((dimension) => [dimension, SemanticDimensionStatus.NOT_APPLICABLE]));
}

function lifecycleOf(item) {
  const validity = item?.validity ?? null;
  const status = lower(item?.status);
  if (validity === EvidenceValidity.RETRACTED || status === 'retracted') return 'retracted';
  if (validity === EvidenceValidity.SUPERSEDED || status === 'superseded') return 'superseded';
  if (item?.current === false || validity === EvidenceValidity.HISTORICAL || status === 'historical') return 'stale';
  return 'current';
}

function result({
  finding, reason, dimensions, claimTokens = 0, sharedTokens = 0, cited = 0, readable = 0,
  missing = 0, partial = false, evidenceState = null, bounded = false, ambiguous = false,
}) {
  return {
    schema: SEMANTIC_SCHEMA,
    finding,
    reason,
    dimensions,
    claimTokens,
    sharedTokens,
    cited,
    readable,
    missing,
    partialAttribution: partial,
    evidenceState,
    bounded,
    ambiguous,
    authorizes: false,
  };
}

// Reads the cited records as one passage. A claim that cites several records must be supported by
// them jointly, so the checks run against the union rather than choosing one record.
function recordText(records) {
  const parts = [];
  for (const item of records) {
    if (parts.length >= 6) break;
    if (typeof item.claim === 'string' && item.claim.length > 0) parts.push(item.claim);
  }
  return parts.join(' ; ');
}

export function assessClaimSemantics({
  text = '',
  evidenceIds = [],
  evidenceById = null,
  kind = 'supported',
  evidenceState = null,
  read = null,
} = {}) {
  const dimensions = emptyDimensions();
  const ids = [...new Set((Array.isArray(evidenceIds) ? evidenceIds : []).filter((id) => typeof id === 'string'))].slice(0, 6);
  const base = { dimensions, cited: ids.length };

  if (!FACTUAL_KINDS.has(kind)) {
    return result({ ...base, finding: SemanticFinding.NOT_CHECKED, reason: REASON.NOT_A_FACT });
  }
  if (ids.length === 0) {
    return result({ ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.NO_CITATION });
  }
  if (!(evidenceById instanceof Map)) {
    dimensions.attribution = SemanticDimensionStatus.NOT_CHECKED;
    return result({ ...base, finding: SemanticFinding.NOT_CHECKED, reason: REASON.NO_INDEX });
  }

  const readState = read?.state ?? null;
  if (WINDOW_STATES.has(readState)) {
    dimensions.attribution = SemanticDimensionStatus.UNAVAILABLE;
    return result({ ...base, finding: SemanticFinding.UNAVAILABLE, reason: REASON.RETRIEVED_OUTSIDE_WINDOW });
  }
  if (UNVERIFIABLE_STATES.has(readState)) {
    dimensions.attribution = SemanticDimensionStatus.NOT_CHECKED;
    return result({ ...base, finding: SemanticFinding.NOT_CHECKED, reason: REASON.SNAPSHOT_NOT_CONSISTENT });
  }

  const records = [];
  let missing = 0;
  let unreadable = 0;
  for (const id of ids) {
    const item = evidenceById.get(id);
    if (!item) {
      missing += 1;
      continue;
    }
    if (typeof item.claim !== 'string' || item.claim.length === 0) {
      unreadable += 1;
      continue;
    }
    records.push(item);
  }
  if (missing > 0) {
    dimensions.attribution = SemanticDimensionStatus.CONFLICT;
    return result({
      ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.MISSING_RECORD,
      readable: records.length, missing, partial: true,
    });
  }
  if (records.length === 0) {
    dimensions.attribution = SemanticDimensionStatus.UNAVAILABLE;
    return result({ ...base, finding: SemanticFinding.UNAVAILABLE, reason: REASON.UNREADABLE_RECORD, readable: 0 });
  }

  // Lifecycle is checked per record, independently of whatever state the structured validator derived:
  // a record can be withdrawn between validation and this assessment, and a withdrawn record must not
  // support anything even when the earlier derivation said it could.
  const lifecycle = records.map(lifecycleOf);
  if (lifecycle.some((state) => state === 'retracted' || state === 'superseded')) {
    dimensions.attribution = SemanticDimensionStatus.CONFLICT;
    return result({ ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.WITHDRAWN, readable: records.length, evidenceState });
  }
  if (kind !== 'historical' && lifecycle.some((state) => state === 'stale')) {
    dimensions.attribution = SemanticDimensionStatus.CONFLICT;
    return result({ ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.NOT_CURRENT, readable: records.length, evidenceState });
  }
  if (BAD_STATES.has(evidenceState)) {
    dimensions.attribution = SemanticDimensionStatus.CONFLICT;
    return result({ ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.CONTESTED, readable: records.length, evidenceState });
  }
  if (evidenceState === EvidenceState.TEMPORALLY_STALE && kind !== 'historical') {
    dimensions.attribution = SemanticDimensionStatus.CONFLICT;
    return result({ ...base, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.NOT_CURRENT, readable: records.length, evidenceState });
  }

  const recordBody = recordText(records);
  const claim = analyze(text);
  const record = analyze(recordBody);
  const claimTokens = contentTokens(text);
  const recordTokens = contentTokens(recordBody);
  let shared = 0;
  for (const token of claimTokens) if (recordTokens.has(token)) shared += 1;

  dimensions.attribution = SemanticDimensionStatus.CHECKED;
  const baseWithCounts = {
    ...base, readable: records.length, evidenceState, claimTokens: claimTokens.size, sharedTokens: shared,
  };
  if (claimTokens.size === 0) {
    return result({ ...baseWithCounts, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.NO_CONTENT });
  }
  // A single shared content word is enough to run the dimension checks: a swapped name or a changed
  // number often leaves only the subject word in common. Coverage decides the outcome only when no
  // dimension found anything to report.
  if (shared === 0) {
    return result({ ...baseWithCounts, finding: SemanticFinding.INSUFFICIENT_EVIDENCE, reason: REASON.TOO_LITTLE_OVERLAP });
  }

  const conflicts = new Map();
  const note = (dimension, outcome) => {
    if (!outcome) {
      dimensions[dimension] = SemanticDimensionStatus.CHECKED;
      return;
    }
    dimensions[dimension] = outcome.status;
    if (outcome.code) conflicts.set(outcome.code, outcome.reason ?? null);
  };

  note(SemanticDimension.POLARITY, comparePolarity(claim, record, { numbersPresent: claim.hasNumbers || record.hasNumbers }));
  const numerical = compareQuantities(claim, record, text);
  note(SemanticDimension.NUMERICAL, numerical);
  const temporal = compareTemporal(claim, record);
  note(SemanticDimension.TEMPORAL, temporal);
  note(SemanticDimension.ENTITY, compareEntities(claim, record));
  note(SemanticDimension.RELATIONSHIP, compareRelations(claim, record));
  note(SemanticDimension.QUALIFIER, compareQualifiers(claim, record));
  note(SemanticDimension.TRANSFORMATION, compareTransformation(claim, record, text, recordBody));

  const bounded = readState === 'truncated'
    || (Number.isFinite(read?.dropped) && read.dropped > 0)
    || records.some((item) => item.partial === true || item.truncated === true);
  const omitted = numerical?.omitted === true || temporal?.omitted === true;
  const ambiguous = conflicts.has(SemanticFinding.AMBIGUOUS);

  // Precedence is applied to the set of findings this claim actually produced. A conflict is never
  // replaced by a weaker outcome just because several axes disagree at once.
  const active = new Set([...conflicts.keys()].filter((code) => code !== SemanticFinding.AMBIGUOUS));
  if (ambiguous) active.add(SemanticFinding.AMBIGUOUS);
  if (bounded || omitted) active.add(SemanticFinding.PARTIALLY_CONSISTENT);
  if (active.size === 0) {
    const coverage = shared / claimTokens.size;
    if (coverage < 0.5) active.add(SemanticFinding.INSUFFICIENT_EVIDENCE);
    else if (coverage < 0.6) active.add(SemanticFinding.PARTIALLY_CONSISTENT);
    else active.add(SemanticFinding.SEMANTICALLY_CONSISTENT);
  }

  const finding = SEMANTIC_PRECEDENCE.find((code) => active.has(code)) ?? SemanticFinding.AMBIGUOUS;
  const reason = conflicts.has(finding)
    ? conflicts.get(finding) ?? REASON.POLARITY
    : finding === SemanticFinding.INSUFFICIENT_EVIDENCE
      ? REASON.TOO_LITTLE_OVERLAP
      : finding === SemanticFinding.PARTIALLY_CONSISTENT
        ? (bounded ? REASON.BOUNDED : omitted ? REASON.OMITTED_DIMENSION : REASON.TOO_LITTLE_OVERLAP)
        : ambiguous ? REASON.NEGATION_SCOPE : null;

  return result({
    ...baseWithCounts,
    finding,
    reason,
    bounded,
    ambiguous,
  });
}

// ---- response-level consistency ----------------------------------------------------------------

const FACTUAL = new Set(['supported', 'partially_supported', 'historical']);
const MAX_RESPONSE_CLAIMS = 12;
const MAX_PAIRS = 6;

// Compares two claims of one response. Only claims that both assert a stored fact are compared: an
// inference beside a fact is not a contradiction, it is a disclosed inference. A value or date
// mismatch is only called a contradiction when the two claims also share a content word, so two
// unrelated facts in one answer are not paired.
function contradictionBetween(left, right, related) {
  if (overlap(left.polarity.map, right.polarity.map)) return SemanticFinding.POLARITY_CONFLICT;
  if (!related) return null;
  if (left.hasNumbers && right.hasNumbers) {
    const quantities = compareQuantities(left, right, '');
    if (quantities?.code === SemanticFinding.NUMERICAL_CONFLICT) return SemanticFinding.NUMERICAL_CONFLICT;
  }
  const temporal = compareTemporal(left, right);
  if (temporal?.code === SemanticFinding.TEMPORAL_CONFLICT) return SemanticFinding.TEMPORAL_CONFLICT;
  const qualifiers = compareQualifiers(left, right);
  if (qualifiers?.code === SemanticFinding.QUALIFIER_CONFLICT) return SemanticFinding.QUALIFIER_CONFLICT;
  return null;
}

function sharesContent(leftText, rightText) {
  const left = contentTokens(leftText);
  const right = contentTokens(rightText);
  for (const token of left) if (right.has(token)) return true;
  return false;
}

export function assessResponseConsistency({ claims = [] } = {}) {
  const list = (Array.isArray(claims) ? claims : []).slice(0, MAX_RESPONSE_CLAIMS);
  const analyses = list.map((claim) => analyze(claim?.text ?? ''));
  const factual = [];
  list.forEach((claim, index) => {
    if (FACTUAL.has(claim?.kind)) factual.push({ index, claim, analysis: analyses[index] });
  });

  const findings = [];
  const pairs = [];
  for (let left = 0; left < factual.length; left += 1) {
    const first = factual[left];
    findings.push(first.claim.semantic?.finding ?? SemanticFinding.NOT_CHECKED);
    for (let right = left + 1; right < factual.length; right += 1) {
      if (pairs.length >= MAX_PAIRS) break;
      const second = factual[right];
      const related = sharesContent(first.claim.text, second.claim.text);
      const dimension = contradictionBetween(first.analysis, second.analysis, related);
      if (dimension) pairs.push({ a: first.index, b: second.index, dimension });
    }
  }
  for (const pair of pairs) findings.push(pair.dimension);

  const perClaim = list.map((claim, index) => ({
    index,
    kind: FACTUAL.has(claim?.kind) ? claim.kind : null,
    finding: claim?.semantic?.finding ?? SemanticFinding.NOT_CHECKED,
  }));

  // A claim that could not be checked does not hide a claim that was checked and contradicted: the
  // conflicts decide the summary, and "not checked" is reported only when nothing else was found.
  const active = findings.filter((code) => code !== SemanticFinding.NOT_CHECKED && code !== SemanticFinding.UNAVAILABLE);
  let finding = null;
  if (active.length > 0) {
    finding = SEMANTIC_PRECEDENCE.find((code) => active.includes(code)) ?? SemanticFinding.SEMANTICALLY_CONSISTENT;
  } else if (findings.includes(SemanticFinding.UNAVAILABLE)) {
    finding = SemanticFinding.UNAVAILABLE;
  } else if (findings.includes(SemanticFinding.NOT_CHECKED)) {
    finding = SemanticFinding.NOT_CHECKED;
  }
  const overstated = list.filter((claim) => claim?.kind === 'supported'
    && claim?.semantic?.finding !== SemanticFinding.SEMANTICALLY_CONSISTENT).length;
  const checked = list.filter((claim) => claim?.semantic
    && claim.semantic.finding !== SemanticFinding.NOT_CHECKED
    && claim.semantic.finding !== SemanticFinding.UNAVAILABLE).length;

  return {
    schema: SEMANTIC_SCHEMA,
    finding,
    claims: perClaim,
    contradictions: pairs,
    overstated,
    checked,
    total: list.length,
    authorizes: false,
  };
}
