// AP-10 §4/§5: the shared query normalization and the shared relevance weighting, at module level.
// Store-level behaviour is covered by retrieval-quality.test.js; this suite pins the policy itself,
// including the measured size-decay defect and the calibration interval the cap was chosen from.
// Everything here is deterministic. No model, no endpoint, no inference.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUERY_TOKENS, NEGATION_WORDS, normalizeTokens, queryTokens,
} from '../src/retrieval/normalize.js';
import {
  MAX_UNSEEN_TERM_WEIGHT, isIdentifierToken, queryWeights, termIdf,
} from '../src/retrieval/relevance.js';
import { tokenize as memoryTokenize, PROMPT_RELEVANCE_MIN } from '../src/memory/memory-store.js';
import { tokenize as knowledgeTokenize } from '../src/knowledge/knowledge-store.js';

const score = (matched, terms, df, n) => {
  const { idf, totalWeight } = queryWeights(terms, df, n);
  return matched.reduce((sum, t) => sum + idf.get(t), 0) / totalWeight;
};

describe('query normalization', () => {
  test('case, punctuation and whitespace carry no signal', () => {
    assert.deepEqual(normalizeTokens('  Hello,   WORLD!!  '), ['hello', 'world']);
    assert.deepEqual(normalizeTokens('Lighthouse\tProject\nStatus'), ['lighthouse', 'project', 'status']);
  });

  test('common words are dropped and repeated tokens are collapsed once', () => {
    assert.deepEqual(normalizeTokens('what is the status of the report'), ['status', 'report']);
    const q = queryTokens('report report report status');
    assert.deepEqual(q.tokens, ['report', 'status']);
    assert.equal(q.total, 2);
    assert.equal(q.dropped, 0);
  });

  test('negation survives, so "not completed" is not "completed"', () => {
    for (const word of NEGATION_WORDS) assert.ok(normalizeTokens(word).includes(word), word);
    assert.deepEqual(memoryTokenize('not completed'), ['not', 'complet']);
    assert.deepEqual(memoryTokenize('completed'), ['complet']);
    assert.notDeepEqual(memoryTokenize('not completed'), memoryTokenize('completed'));
    assert.notDeepEqual(knowledgeTokenize('not completed'), knowledgeTokenize('completed'));
  });

  test('a number is not merged with a longer number', () => {
    assert.deepEqual(normalizeTokens('10'), ['10']);
    assert.deepEqual(normalizeTokens('100'), ['100']);
    assert.notDeepEqual(normalizeTokens('AP-10'), normalizeTokens('AP-100'));
  });

  test('two dates keep their own components and their own whole', () => {
    const june = normalizeTokens('2026-06-01');
    const january = normalizeTokens('2026-01-06');
    assert.ok(june.includes('2026-06-01'));
    assert.ok(january.includes('2026-01-06'));
    assert.notDeepEqual(june, january);
  });

  test('an identifier is kept whole beside its parts, and distinct identifiers stay distinct', () => {
    assert.deepEqual(normalizeTokens('AP-10'), ['ap', '10', 'ap-10']);
    assert.notDeepEqual(normalizeTokens('AP-10'), normalizeTokens('AP-11'));
    assert.notDeepEqual(normalizeTokens('node-2026.06'), normalizeTokens('node-2026.09'));
  });

  test('similar but distinct entity names are not folded together', () => {
    assert.notDeepEqual(normalizeTokens('Lighthouse Project'), normalizeTokens('Lighthouse Projects'));
    assert.notDeepEqual(knowledgeTokenize('Acme Corp'), knowledgeTokenize('Acme Corps'));
  });

  test('the two stores share the policy and differ only in stemming', () => {
    assert.deepEqual(memoryTokenize('the reports were completed'), ['report', 'complet']);
    assert.deepEqual(knowledgeTokenize('the reports were completed'), ['reports', 'completed']);
  });

  test('the token count is bounded and the drop is reported, not hidden', () => {
    const text = Array.from({ length: MAX_QUERY_TOKENS + 9 }, (_, i) => `term${i}`).join(' ');
    const q = queryTokens(text);
    assert.equal(q.tokens.length, MAX_QUERY_TOKENS);
    assert.equal(q.total, MAX_QUERY_TOKENS + 9);
    assert.equal(q.dropped, 9);
    assert.equal(queryTokens(text, { maxTokens: 4 }).tokens.length, 4);
  });

  test('a request at the documented size limit keeps its informative tail', () => {
    // growth-limits.test.js pins this end to end: 380 noise words followed by "launch code name" must
    // still retrieve the exact match. A front-truncating bound silently searched only the noise.
    const noise = Array.from({ length: 380 }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');
    const request = `${noise} launch code name`;
    assert.ok(request.length <= 4000);
    const q = queryTokens(request, { stem: true });
    assert.equal(q.dropped, 0);
    for (const term of ['launch', 'code', 'name']) assert.ok(q.tokens.includes(term), term);
  });

  test('an empty or malformed query normalizes to nothing rather than throwing', () => {
    for (const value of [null, undefined, '', '   ', 42, {}, [], '!!! ??? ...']) {
      assert.deepEqual(normalizeTokens(value), [], JSON.stringify(value));
      assert.deepEqual(queryTokens(value).tokens, [], JSON.stringify(value));
    }
    assert.deepEqual(queryTokens('a b c').tokens, []);
  });

  test('the original query text is never rewritten by normalization', () => {
    const original = '  Tell me about AP-10, please!  ';
    queryTokens(original);
    normalizeTokens(original);
    assert.equal(original, '  Tell me about AP-10, please!  ');
  });
});

describe('identifier tokens are never fuzzily matched', () => {
  test('identifier-like tokens are recognized', () => {
    for (const t of ['ap-10', '2026', '2026-06-01', 'v1.2', 'a_b', '10']) assert.equal(isIdentifierToken(t), true, t);
    for (const t of ['lighthouse', 'project', 'status', 'report']) assert.equal(isIdentifierToken(t), false, t);
  });
});

describe('relevance weighting', () => {
  test('IDF is floored at 1 and an absent term is the unbounded one', () => {
    assert.equal(termIdf(20, 20), 1);
    assert.equal(termIdf(0, 0), 1);
    assert.ok(termIdf(0, 4000) > termIdf(0, 20));
    assert.equal(termIdf(0, 20), Math.log(42));
  });

  test('when every query term occurs, the weighting is exactly the AP-09 formula', () => {
    const terms = ['lighthouse', 'project', 'status'];
    const df = new Map([['lighthouse', 1], ['project', 1], ['status', 1000]]);
    const { idf, totalWeight, unmatched } = queryWeights(terms, df, 1000);
    assert.deepEqual(unmatched, []);
    assert.equal(idf.get('lighthouse'), termIdf(1, 1000));
    assert.equal(idf.get('status'), 1);
    assert.equal(totalWeight, termIdf(1, 1000) * 2 + 1);
    assert.equal(score(terms, terms, df, 1000), 1);
  });

  test('an absent term is never lighter than the rarest observed term', () => {
    const df = new Map([['rare', 1], ['common', 4000]]);
    const { idf } = queryWeights(['rare', 'common', 'absent'], df, 4000);
    assert.ok(idf.get('absent') >= idf.get('rare'));
    assert.ok(idf.get('absent') >= MAX_UNSEEN_TERM_WEIGHT);
  });

  test('the measured defect: a fixed query against a fixed record no longer decays as the store grows', () => {
    // Fixture A from the AP-09 probe: every record holds "lighthouse" and "status", none holds
    // "project". Before the cap the target scored 0.3486 / 0.2501 / 0.2083 / 0.1820 at 20 / 200 /
    // 1000 / 4000 records and crossed the fixed 0.2 floor between 1000 and 4000.
    const terms = ['lighthouse', 'project', 'status'];
    const matched = ['lighthouse', 'status'];
    const before = [20, 200, 1000, 4000].map((n) => {
      const df = new Map([['lighthouse', n], ['status', n]]);
      const total = 2 + termIdf(0, n);
      return 2 / total;
    });
    assert.deepEqual(before, [0.3485735730804195, 0.250110921423078, 0.2082920663382822, 0.18202590996175266]);
    assert.ok(before[2] >= PROMPT_RELEVANCE_MIN && before[3] < PROMPT_RELEVANCE_MIN, 'the old score crossed the floor');

    const after = [20, 200, 1000, 4000, 10000].map((n) => score(matched, terms, new Map([['lighthouse', n], ['status', n]]), n));
    assert.equal(after[0], before[0], 'below the cap the AP-09 weighting is reproduced exactly');
    for (const value of after) assert.ok(value >= PROMPT_RELEVANCE_MIN, `${value} fell below the floor`);
    assert.equal(after[2], after[3]);
    assert.equal(after[3], after[4]);
    assert.equal(after[2], 2 / 6);
  });

  test('the precision the old score bought by accident is kept deliberately', () => {
    // Fixture D: the store holds only "weekly report status" records, so two of the three query terms
    // are absent and the record matches one ubiquitous term. It must stay below the floor.
    const terms = ['lighthouse', 'project', 'status'];
    for (const n of [20, 200, 1000, 4000, 10000]) {
      const value = score(['status'], terms, new Map([['status', n]]), n);
      assert.ok(value < PROMPT_RELEVANCE_MIN, `n=${n} scored ${value}`);
    }
    assert.equal(score(['status'], terms, new Map([['status', 20]]), 20), 0.11798937742639416);
    assert.equal(score(['status'], terms, new Map([['status', 1000]]), 1000), 1 / 9);
  });

  test('the cap sits inside the interval the fixtures measure', () => {
    // One absent term of three, every observed term ubiquitous: the cap must not exceed 8 or the
    // two-of-three match drops below the floor. Two absent terms of three: the cap must exceed 2 or
    // the one-of-three match rises above it.
    const twoOfThree = (cap) => 2 / (2 + cap);
    const oneOfThree = (cap) => 1 / (1 + 2 * cap);
    assert.ok(twoOfThree(8) >= PROMPT_RELEVANCE_MIN);
    assert.ok(twoOfThree(8.01) < PROMPT_RELEVANCE_MIN);
    assert.ok(oneOfThree(2) >= PROMPT_RELEVANCE_MIN);
    assert.ok(oneOfThree(2.01) < PROMPT_RELEVANCE_MIN);
    assert.ok(MAX_UNSEEN_TERM_WEIGHT > 2 && MAX_UNSEEN_TERM_WEIGHT <= 8);
    assert.equal(MAX_UNSEEN_TERM_WEIGHT, Math.sqrt(2 * 8));
  });

  test('a rare term is not overwhelmed by common ones', () => {
    const terms = ['zebrafish', 'report', 'status'];
    const df = new Map([['zebrafish', 1], ['report', 1000], ['status', 1000]]);
    const rareOnly = score(['zebrafish'], terms, df, 1000);
    const commonOnly = score(['report', 'status'], terms, df, 1000);
    assert.ok(rareOnly > commonOnly, `${rareOnly} should outrank ${commonOnly}`);
  });

  test('an empty query has no weight and no unmatched terms', () => {
    const { idf, totalWeight, unmatched, terms } = queryWeights([], new Map(), 100);
    assert.equal(idf.size, 0);
    assert.equal(totalWeight, 1);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(terms, []);
  });

  test('weighting is deterministic and independent of term order', () => {
    const df = new Map([['alpha', 3], ['beta', 900]]);
    const a = queryWeights(['alpha', 'beta', 'gamma'], df, 1000);
    const b = queryWeights(['gamma', 'beta', 'alpha'], df, 1000);
    assert.equal(a.totalWeight, b.totalWeight);
    assert.deepEqual([...a.idf.entries()].sort(), [...b.idf.entries()].sort());
    assert.deepEqual(a.unmatched, ['gamma']);
    assert.deepEqual(b.unmatched, ['gamma']);
  });
});