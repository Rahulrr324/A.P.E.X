// AP-10 §8: what the context budget removes, and what it must say about the removal.
// buildPrompt is exercised directly so the disclosure is pinned independently of the model path.
// Deterministic fixtures only; no model, no endpoint, no inference.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, dedupeKnowledge } from '../src/controller/context.js';

const CLOCK = '2026-06-01T00:00:00.000Z';

const memoryHit = (id, content, conflict = []) => ({
  record: { id, content, kind: 'user_fact', createdAt: CLOCK, sensitivity: 'normal' },
  score: 1,
  conflict,
  status: 'current',
});

const knowledgeHit = (id, subject, relationship, object) => ({
  record: { id, subject, relationship, object, provenance: { origin: 'user_supplied' }, conflictsWith: [], createdAt: CLOCK },
  score: 1,
});

const base = { request: 'what is the lighthouse status', memoryHits: [], turns: [] };

// The trim is a loop over a size budget, so the budget that produces a given cut is found by walking
// down from the untrimmed length rather than guessed from an arithmetic estimate of line widths. The
// step is one character: a disclosure note costs about as much as the line it replaces, so the window
// that keeps a given number of survivors can be only a few characters wide.
const atBudget = (input, want) => {
  const full = buildPrompt(input);
  for (let budget = full.prompt.length; budget > 0; budget -= 1) {
    const built = buildPrompt({ ...input, maxChars: budget });
    if (want(built)) return built;
  }
  return null;
};

describe('context-budget disclosure', () => {
  test('a collapsed duplicate triple is counted and disclosed, not silently dropped', () => {
    const built = buildPrompt({
      ...base,
      knowledge: [
        knowledgeHit('k1', 'lighthouse', 'status', 'green'),
        knowledgeHit('k2', 'lighthouse', 'status', 'green'),
        knowledgeHit('k3', 'lighthouse', 'owner', 'ana'),
      ],
    });
    assert.equal(built.knowledgeDeduplicated, 1);
    assert.equal(built.knowledgeLinesTotal, 2);
    assert.equal(built.knowledgeLines, 2);
    assert.deepEqual(built.knowledgeIds, ['k1', 'k3']);
    assert.match(built.prompt, /1 retrieved knowledge record\(s\) repeated an identical subject-relationship-object triple and were collapsed into one line; the duplicates remain stored\./);
  });

  test('dedupe keeps the highest-ranked record and is deterministic', () => {
    const records = [
      knowledgeHit('k1', 'Lighthouse', 'Status', 'green').record,
      knowledgeHit('k2', ' lighthouse ', 'status', 'GREEN').record,
    ];
    assert.deepEqual(dedupeKnowledge(records).map((r) => r.id), ['k1']);
    assert.deepEqual(dedupeKnowledge([...records].reverse()).map((r) => r.id), ['k2']);
  });

  test('knowledge trimmed by the budget is disclosed, and the survivors are not presented as all of it', () => {
    const knowledge = [
      knowledgeHit('k1', 'lighthouse', 'status', 'green'),
      knowledgeHit('k2', 'lighthouse', 'owner', 'ana'),
      knowledgeHit('k3', 'lighthouse', 'budget', '1200 EUR'),
    ];
    const full = buildPrompt({ ...base, knowledge });
    assert.equal(full.knowledgeLines, 3);
    assert.equal(full.knowledgeLinesTotal, 3);
    assert.ok(!/knowledge record\(s\) were omitted/.test(full.prompt));

    const tight = atBudget({ ...base, knowledge }, (b) => b.knowledgeLines > 0 && b.knowledgeLines < 3);
    assert.ok(tight, 'no budget cut the knowledge tail while leaving a survivor');
    assert.equal(tight.knowledgeLinesTotal, 3);
    assert.equal(tight.knowledgeLinesTotal - tight.knowledgeLines, 3 - tight.knowledgeLines);
    const disclosed = tight.prompt.match(/(\d+) (?:retrieved )?knowledge record\(s\) (?:were )?omitted/);
    assert.ok(disclosed, 'the trim is not disclosed in the prompt');
    assert.equal(Number(disclosed[1]), 3 - tight.knowledgeLines);
    assert.match(tight.prompt, /still stored|remain stored/);
    assert.ok(tight.prompt.length < full.prompt.length);
  });

  test('the disclosure takes the fullest form that fits, and never displaces a record to do it', () => {
    // Long fields make a knowledge line cost more than the full sentence, so the fuller form fits in
    // the room the trimmed record freed. With short fields it does not, and the short form is used.
    const long = 'x'.repeat(160);
    const knowledge = [
      knowledgeHit('k1', 'lighthouse', 'status', `green ${long}`),
      knowledgeHit('k2', 'lighthouse', 'owner', `ana ${long}`),
      knowledgeHit('k3', 'lighthouse', 'budget', `1200 EUR ${long}`),
    ];
    const tight = atBudget({ ...base, knowledge }, (b) => b.knowledgeLines > 0 && b.knowledgeLines < 3);
    assert.ok(tight, 'no budget cut the knowledge tail while leaving a survivor');
    assert.match(tight.prompt, /\d+ retrieved knowledge record\(s\) were omitted from this context to keep it within its size budget; they remain stored and the user can ask again with a narrower question\./);

    const short = [
      knowledgeHit('s1', 'lighthouse', 'status', 'green'),
      knowledgeHit('s2', 'lighthouse', 'owner', 'ana'),
      knowledgeHit('s3', 'lighthouse', 'budget', '1200 EUR'),
    ];
    const compact = atBudget({ ...base, knowledge: short }, (b) => b.knowledgeLines > 0 && b.knowledgeLines < 3);
    assert.ok(compact);
    assert.match(compact.prompt, /\d+ knowledge record\(s\) omitted; still stored\./);
  });

  test('a budget that empties knowledge still says so instead of rendering an empty section', () => {
    const knowledge = [knowledgeHit('k1', 'lighthouse', 'status', 'green')];
    const tight = atBudget({ ...base, knowledge }, (b) => b.knowledgeLines === 0);
    assert.ok(tight, 'no budget emptied the knowledge section');
    assert.equal(tight.knowledgeLinesTotal, 1);
    assert.match(tight.prompt, /KNOWLEDGE: \(\d+ (?:retrieved )?knowledge record\(s\) (?:were )?omitted/);
    assert.ok(!/KNOWLEDGE \(explicit relationships/.test(tight.prompt), 'an emptied section must not render as a bare header');
  });

  test('an unreadable knowledge store is disclosed as unreadable, not as an omission', () => {
    const built = buildPrompt({ ...base, knowledge: [], knowledgeUnavailable: true });
    assert.match(built.prompt, /KNOWLEDGE: \(knowledge store temporarily unavailable\)/);
    assert.equal(built.knowledgeLinesTotal, 0);
    assert.equal(built.knowledgeDeduplicated, 0);
  });

  test('a disagreement survives the budget even when the record that disagrees is trimmed', () => {
    const memoryHits = [
      memoryHit('m1', 'the lighthouse status is green', ['m2']),
      memoryHit('m2', 'the lighthouse status is red', ['m1']),
    ];
    const full = buildPrompt({ ...base, memoryHits });
    assert.equal(full.memoryLines, 2);
    assert.match(full.prompt, /conflicting memory: 1 other record\(s\) disagree/);

    const tight = atBudget({ ...base, memoryHits }, (b) => b.memoryLines === 1);
    assert.ok(tight, 'no budget kept exactly one recalled record');
    assert.deepEqual(tight.memoryIds, ['m1']);
    assert.match(tight.prompt, /\[contested: APEX stores at least one other record for the same claim that is not shown here; the disagreement is unresolved\]/);
    assert.match(tight.prompt, /1 recalled record\(s\) were omitted from this context/);
  });

  test('an unopposed record carries no contested marker', () => {
    const built = buildPrompt({ ...base, memoryHits: [memoryHit('m1', 'the lighthouse status is green')] });
    assert.ok(!built.prompt.includes('[contested:'));
    assert.ok(!built.prompt.includes('conflicting memory:'));
  });

  test('provenance and the numeric detail survive a trim of the knowledge tail', () => {
    const knowledge = [
      knowledgeHit('k1', 'lighthouse', 'budget', '1200 EUR'),
      knowledgeHit('k2', 'lighthouse', 'owner', 'ana'),
    ];
    const tight = atBudget({ ...base, knowledge }, (b) => b.knowledgeLines === 1);
    assert.ok(tight, 'no budget kept exactly one knowledge line');
    assert.deepEqual(tight.knowledgeIds, ['k1']);
    assert.match(tight.prompt, /1200 EUR/);
    assert.match(tight.prompt, /user-supplied fact/);
  });

  test('the same inputs build the same prompt, and the counts always reconcile', () => {
    const input = {
      ...base,
      memoryHits: [memoryHit('m1', 'the lighthouse status is green')],
      knowledge: [knowledgeHit('k1', 'lighthouse', 'status', 'green'), knowledgeHit('k2', 'lighthouse', 'status', 'green')],
    };
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    assert.equal(a.prompt, b.prompt);
    assert.equal(a.knowledgeLinesTotal - a.knowledgeLines, 0);
    assert.equal(a.knowledgeDeduplicated, 1);
    assert.equal(a.memoryLinesTotal, a.memoryLines);
  });
});