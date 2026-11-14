// Shared lexical relevance weighting for the memory and knowledge stores.
//
// Both stores rank by the same policy, so the policy lives here once. A query term is weighted by how
// rare it is in the store (IDF), a record's score is the share of that weight it matches, and the
// score is bounded to [0, 1]. Nothing here is a probability, a confidence, or a claim of meaning: it
// is a lexical coverage ratio over the words the store actually holds.
//
// The defect this module fixes was measured, not guessed. A term that no record contains has document
// frequency 0, so its BM25 IDF is log(1 + (n + 0.5) / 0.5), which grows without bound as unrelated
// records are added. That weight sat in every record's denominator while the matched terms' weights
// did not grow, so a fixed query against a fixed record scored 0.3486 at 20 records, 0.2501 at 200,
// 0.2083 at 1000 and 0.1820 at 4000 - crossing the fixed 0.2 prompt-relevance floor between 1000 and
// 4000 purely because the store grew. The record did not change and the query did not change.
//
// An absent term is rarer than any term the store holds, but the store cannot establish how much
// rarer: "appears in no record" is the same fact at 20 records and at 4000. Its weight is therefore
// the original formula capped at MAX_UNSEEN_TERM_WEIGHT, and never below the rarest weight actually
// observed. Below the cap the AP-09 weighting is reproduced exactly; above it the weight stops
// growing. The penalty for asking about something absent is kept - measured on a store holding only
// "weekly report status" records, the query "lighthouse project status" scores 0.1111 against them and
// stays under the 0.2 floor, while a record matching two of the three terms scores 0.3333 and stays
// over it. When every query term occurs in the store, nothing here changes at all.
//
// The cap was calibrated, not picked to make a test pass. With one absent term out of three and every
// observed term ubiquitous, a cap of 8 is the largest that keeps the two-of-three match at or above
// the 0.2 floor; with two absent terms out of three, the cap must exceed 2 to keep the one-of-three
// match below it. 4 is the geometric mean of that measured interval (2, 8].
export const MAX_UNSEEN_TERM_WEIGHT = 4;

// IDF is floored at 1. In a small personal store an absent word would otherwise outweigh a matched
// one and a clearly relevant record would score below the prompt-relevance floor.
export function termIdf(documentFrequency, corpusSize) {
  const df = Number.isInteger(documentFrequency) ? documentFrequency : 0;
  const n = Number.isInteger(corpusSize) ? corpusSize : 0;
  return Math.max(1, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
}

// The weight of every query term, the denominator every record is scored against, and the terms no
// record in the store contains. `documentFrequency` maps term -> number of records holding it.
export function queryWeights(terms, documentFrequency, corpusSize) {
  const list = [...new Set(terms)];
  const idf = new Map();
  const unmatched = [];
  let rarestObserved = 1;
  for (const term of list) {
    const df = documentFrequency.get(term) ?? 0;
    if (df <= 0) {
      unmatched.push(term);
      continue;
    }
    const weight = termIdf(df, corpusSize);
    idf.set(term, weight);
    if (weight > rarestObserved) rarestObserved = weight;
  }
  const unseen = Math.min(termIdf(0, corpusSize), MAX_UNSEEN_TERM_WEIGHT);
  for (const term of unmatched) idf.set(term, Math.max(rarestObserved, unseen));
  const totalWeight = list.reduce((sum, term) => sum + idf.get(term), 0) || 1;
  return { idf, totalWeight, unmatched, terms: list };
}

// A token that names an identifier, a version, or a date is not a word form. Folding it into a
// near-miss match would let "AP-10" retrieve "AP-11" and "2026" retrieve "2027", which is exactly the
// distinction retrieval must keep, so such tokens are compared exactly and never fuzzily.
export function isIdentifierToken(token) {
  return /[-./_\d]/.test(String(token));
}