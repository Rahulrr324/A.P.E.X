// Shared query and record normalization for lexical retrieval.
//
// Both stores rank by the same policy, so they must also split text by the same policy. This module
// owns that split. It is deliberately lexical: it lowercases, separates words, keeps identifiers and
// dates whole, and drops the words that carry no retrieval signal. It does not expand synonyms,
// resolve coreference, or infer meaning, and nothing here claims that a token match is understanding.
//
// Three properties are load-bearing and are tested directly:
//   - a negation is not erased: "not completed" and "completed" must stay different queries;
//   - an identifier or date is not reordered: "2026-06-01" and "2026-01-06" must stay different;
//   - a number is not merged with a longer number: "10" and "100" must stay different.
import { STOPWORDS } from '../util.js';

// A request is bounded text, but its token count was not: the fuzzy matcher compares every query term
// with every record word, so a long request made retrieval quadratic. The bound is a guard against an
// unbounded direct store call, not a routine truncation. A request is already limited to 4000
// characters (MAX_REQUEST_CHARS), which cannot yield more than about 2400 distinct content tokens even
// when every token is a two-letter hyphenated pair, so the bound sits above that: cutting a legitimate
// request from the front would discard its informative tail and lose an exact match. `dropped` still
// reports any truncation, so a shortened query is disclosed rather than silently searched as a prefix.
export const MAX_QUERY_TOKENS = 4096;

// Words that reverse or deny a claim. They are ordinary stopwords in a bag-of-words matcher, and
// dropping them made "the task is not completed" retrieve exactly what "the task is completed"
// retrieves. They are kept as content so the two queries differ.
export const NEGATION_WORDS = Object.freeze(['not', 'no', 'never', 'without']);

const WORD = /[\p{L}\p{N}]+/gu;
// A run of word characters joined by - . / _ that contains a digit: an identifier (AP-10), a version
// (v1.2), or a date (2026-06-01). Kept whole so its parts cannot be reordered or matched separately.
const COMPOUND = /[\p{L}\p{N}]+(?:[-./_][\p{L}\p{N}]+)+/gu;

function stemWord(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// An identifier is not a word form: stemming "reports-2026" or "v1.2s" would change what it names.
function stemmable(token) {
  return !/[-./_\d]/.test(token);
}

function contentWords(text) {
  return String(text).toLowerCase().match(WORD) || [];
}

function compounds(text) {
  const out = [];
  for (const run of String(text).toLowerCase().match(COMPOUND) || []) {
    if (/\d/.test(run)) out.push(run);
  }
  return out;
}

// The tokens of one text. `stem` selects the memory store's word-form folding; the knowledge store
// keeps word forms whole. Both keep identifiers, dates, and negations.
export function normalizeTokens(text, { stem = false } = {}) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const word of contentWords(text)) {
    if (word.length < 2) continue;
    if (STOPWORDS.has(word) && !NEGATION_WORDS.includes(word)) continue;
    out.push(stem && stemmable(word) ? stemWord(word) : word);
  }
  // The whole identifier is added beside its parts, not instead of them: searching "10" must still
  // find "AP-10", while searching "2026-06-01" must not match "2026-01-06".
  for (const run of compounds(text)) {
    if (run.length < 2) continue;
    out.push(stem && stemmable(run) ? stemWord(run) : run);
  }
  return out;
}

// A query's distinct tokens, bounded. `dropped` is how many distinct tokens the bound removed, so a
// caller can disclose that the query was shortened instead of silently searching a prefix of it.
export function queryTokens(text, { stem = false, maxTokens = MAX_QUERY_TOKENS } = {}) {
  const distinct = [...new Set(normalizeTokens(text, { stem }))];
  const bound = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : MAX_QUERY_TOKENS;
  return {
    tokens: distinct.slice(0, bound),
    dropped: Math.max(0, distinct.length - bound),
    total: distinct.length,
  };
}