// Batch AP-10 §10: twenty-five deterministic adversarial retrieval cases.
//
// Each case drives the real controller and the real stores with a fixed-output model stub, and
// asserts the eight dimensions the batch requires: the records that reached the prompt, the ranking
// the stores produced, the retrieval state, the completeness claim, the citation behaviour, the
// limitation the answer carries, what was persisted, and whether any executive action was permitted.
// No inference, no endpoint, no download: every record is a synthetic fixture and every clock is
// fixed. Where a state is not reachable through the controller because it fails closed earlier, the
// case asserts that refusal and the report-level state is pinned in retrieval-snapshot.test.js.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { probe, cleanupAll, cognitionBlock, evidenceId, readJsonl, NOISE } from './retrieval-probe.js';
import { normalizeTokens, queryTokens, MAX_QUERY_TOKENS } from '../src/retrieval/normalize.js';
import { RETRIEVAL_STATES, isRetrievalState } from '../src/retrieval/report.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';

after(cleanupAll);

const triple = (subject, relationship, object, extra = {}) => ({ subject, relationship, object, origin: 'user', ...extra });

// Two runs use two directories, so their record ids differ. Ranking is compared by position in the
// fixture, which is what "the same ranking" means; comparing generated ids would compare nothing.
const positions = (ids, fixtureIds) => ids.map((id) => fixtureIds.indexOf(id));

// Dimensions 7 and 8 hold for every case unless the case is specifically about a write. Retrieval
// grants nothing: the response assessment and the handoff contract both say so, and no model-proposed
// step reached a verified execution.
function expectNoExecutiveAuthority(p) {
  assert.equal(p.executive.authorizes.integrity, false, 'the response assessment grants no authority');
  assert.equal(p.executive.authorizes.contract, false, 'the handoff contract grants no authority');
  assert.equal(p.executive.executed, 0, 'no model-proposed action was executed');
  assert.notEqual(p.executive.decision, Decision.PROPOSE_ACTION, 'the request did not become an executive action');
}

function expectPersisted(p, { memory, knowledge }) {
  assert.equal(p.persistence.auditFound, true, 'the operation was persisted');
  assert.equal(p.persistence.memoryRecords, memory, 'the request wrote no memory record');
  assert.equal(p.persistence.knowledgeRecords, knowledge, 'the request wrote no knowledge record');
  assert.equal(p.persistence.auditAuthorizes, false, 'the persisted assessment grants no authority');
  const serialized = JSON.stringify(p.persistence.auditReport ?? {});
  assert.equal(/NaN|null record/.test(serialized), false, 'the persisted report carries no unknown count');
}

// The report may never claim completeness over a window the read contract did not certify.
function expectCompletenessHonest(p) {
  if (p.report === null) return;
  assert.ok(isRetrievalState(p.retrievalState), `unknown retrieval state ${p.retrievalState}`);
  if (p.completeness.read === false) {
    assert.equal(p.completeness.report, false, 'an uncertified read cannot yield a complete retrieval report');
  }
  if (p.completeness.window === 'concurrent_modification' || p.completeness.window === 'unverifiable') {
    assert.equal(p.completeness.report, false, 'an inconsistent window blocks completeness');
    assert.equal(p.retrievalState, 'inconsistent_snapshot');
  }
}

describe('AP-10 §10 adversarial retrieval cases 1-9: ranking, identity and lifecycle', () => {
  test('01 a rare token is not overwhelmed by the common records around it', async () => {
    const fillers = Array.from({ length: 30 }, (_, i) => `the lighthouse archive batch ${i} was recorded`);
    const p = await probe({
      memory: [...fillers, 'the lighthouse zephyr anomaly was logged'],
      query: 'lighthouse zephyr',
      rank: true,
      reply: (s) => cognitionBlock('the lighthouse zephyr anomaly was logged', [
        { text: 'the lighthouse zephyr anomaly was logged', evidence: [evidenceId('memory', s.ids[30])], kind: 'supported' },
      ]),
    });
    assert.equal(p.ranking.memory[0], p.ids[30], 'the rare-token record ranks first');
    assert.ok(p.ranking.memoryScores[0] > p.ranking.memoryScores[1], 'its score is strictly above the common-token matches');
    assert.ok(p.records.memory.includes(p.ids[30]), 'the rare-token record reached the prompt');
    assert.equal(p.sourceState('memory'), 'source_limit_reached', '31 matches against a bound of 5 is a source limit, not a complete read');
    assert.equal(p.completeness.report, false);
    assert.equal(p.citation.trust, 'factually_supported');
    assert.ok(p.citation.codes.includes('citation_relevant_uncited'), 'the uncited common-token matches are disclosed');
    assert.ok(p.limitation.notices.some((n) => n.includes('cited by no claim')), 'the omission is stated beside the answer');
    expectPersisted(p, { memory: 31, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('02 a common-token query matches many records and the bound is disclosed, not hidden', async () => {
    const p = await probe({
      memory: Array.from({ length: 20 }, (_, i) => `the status note ${i} was recorded`),
      query: 'tell me about the status note',
      rank: true,
      // The twenty records tie on score, so the newest ranks first and the bound keeps ids 19..15.
      // Citing one of those keeps the structure valid; the other four are the uncited relevant ones.
      reply: (s) => cognitionBlock('the status note 19 was recorded', [
        { text: 'the status note 19 was recorded', evidence: [evidenceId('memory', s.ids[19])], kind: 'supported' },
      ]),
    });
    assert.equal(p.ranking.memory.length, 20, 'every record matches the common token');
    assert.equal(p.records.memory.length, 5, 'the prompt still carries only the bound');
    assert.equal(p.sourceState('memory'), 'source_limit_reached');
    assert.equal(p.sourceEntry('memory').exclusions.sourceLimit, 15, 'the 15 matches the bound excluded are counted');
    assert.equal(p.completeness.report, false);
    assert.equal(p.citation.trust, 'factually_supported');
    assert.ok(p.citation.codes.includes('citation_relevant_uncited'), 'the four uncited matches are disclosed');
    assert.ok(p.limitation.notices.some((n) => n.includes('cited by no claim')));
    expectPersisted(p, { memory: 20, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('03 a negation is not normalized away, and a contested negation is asked about rather than asserted', async () => {
    assert.notDeepEqual(normalizeTokens('not completed'), normalizeTokens('completed'));
    assert.ok(normalizeTokens('the task is not completed').includes('not'));
    const p = await probe({
      memory: ['the task is completed', 'the task is not completed'],
      query: 'task not completed',
      rank: true,
    });
    assert.equal(p.ranking.memory.length, 2, 'both records stay retrievable; the negation does not delete one');
    assert.equal(new Set(p.ranking.memory).size, 2, 'they are two records, not one merged claim');
    assert.deepEqual(p.ranking.memoryStatus, ['unresolved_conflict', 'unresolved_conflict'], 'the disagreement is recorded, not resolved');
    assert.equal(p.ranking.memory[0], p.ids[1], 'the negated record ranks first for a negated query');
    assert.deepEqual(p.ranking.memoryConflicts[0], [p.ranking.memory[1]], 'each side names the other');
    assert.deepEqual(p.ranking.memoryConflicts[1], [p.ranking.memory[0]]);
    // APEX asks instead of picking a side. The negation survived normalization; the conflict survived
    // retrieval; neither was quietly turned into an answer.
    assert.equal(p.res.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(p.executive.decision, Decision.CLARIFY);
    assert.equal(p.executive.executed, 0);
    assert.equal(p.persistence.memoryRecords, 2);
  });

  test('04 a numeric identifier does not collide with its neighbour', async () => {
    assert.notDeepEqual(normalizeTokens('ap-10'), normalizeTokens('ap-11'));
    assert.notDeepEqual(normalizeTokens('the count is 10'), normalizeTokens('the count is 100'));
    const p = await probe({
      memory: ['the release ap-10 shipped', 'the release ap-11 shipped'],
      query: 'ap-10',
      rank: true,
    });
    assert.equal(p.ranking.memory[0], p.ids[0], 'ap-10 ranks first for ap-10');
    assert.ok(p.ranking.memoryScores[0] > (p.ranking.memoryScores[1] ?? 0), 'the identifier is not fuzzy-matched to ap-11');
    assert.ok(p.records.memory.includes(p.ids[0]));
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 2, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('05 similar entity names stay two records and the exact one ranks first', async () => {
    const p = await probe({
      memory: ['lighthouse north is staffed', 'lighthouse northside is unstaffed'],
      query: 'lighthouse north',
      rank: true,
    });
    assert.equal(p.ranking.memory[0], p.ids[0]);
    assert.equal(p.ranking.memory.length, 2, 'the similar name is not merged into the exact one');
    assert.ok(p.records.memory.includes(p.ids[0]));
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 2, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('06 duplicates do not dominate the top-K', async () => {
    const p = await probe({
      memory: [...Array.from({ length: 5 }, () => 'the lighthouse status is green'), 'the lighthouse keeper is ana'],
      query: 'lighthouse status green keeper',
      rank: true,
    });
    assert.ok(p.ranking.memory.length <= 2, `the five identical records collapsed, got ${p.ranking.memory.length}`);
    assert.ok(p.ranking.memory.includes(p.ids[5]), 'the distinct record survives the collapse');
    assert.ok(p.records.memory.includes(p.ids[5]), 'the distinct record reached the prompt');
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 6, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('07 a contradiction outside the returned window is still named by the record inside it', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green', 'the lighthouse status is red'],
      query: 'lighthouse status',
      retrievalLimit: 1,
      rank: true,
      rankLimit: 1,
    });
    assert.equal(p.ranking.memory.length, 1, 'the bound returned one record');
    const excluded = p.ids.find((id) => id !== p.ranking.memory[0]);
    assert.deepEqual(p.ranking.memoryConflicts[0], [excluded], 'the returned record names the partner the bound excluded');
    assert.equal(p.ranking.memoryStatus[0], 'unresolved_conflict');
    assert.equal(p.sourceState('memory'), 'source_limit_reached');
    assert.equal(p.sourceEntry('memory').exclusions.sourceLimit, 1);
    assert.equal(p.completeness.report, false);
    assert.ok(p.limitation.notices.some((n) => n.includes('one side of a disagreement')), 'the one-sided selection is stated beside the answer');
    // The stub labelled a contested record `supported`. APEX refuses that structure rather than
    // presenting one side of an unresolved disagreement as a supported fact.
    assert.ok(p.limitation.codes.includes('structured_response_rejected'));
    assert.notEqual(p.citation.trust, 'factually_supported');
    expectPersisted(p, { memory: 2, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('08 a superseded claim cannot outrank the current one', async () => {
    const p = await probe({
      memory: ['the engine fuel is diesel'],
      knowledge: [triple('engine', 'fuel', 'diesel')],
      query: 'engine fuel',
      rank: true,
      prepare: async (app, s) => {
        s.corrected = (await app.memory.correct({ targetId: s.ids[0], content: 'the engine fuel is electric', origin: 'user' })).id;
        s.kNew = (await app.knowledge.add(triple('engine', 'fuel', 'electric', { supersedes: [s.kids[0]] }))).record.id;
      },
    });
    assert.ok(!p.ranking.knowledge.includes(p.kids[0]), 'knowledge excludes the superseded triple from retrieval');
    assert.ok(p.ranking.knowledge.includes(p.state.kNew), 'the current triple is retrievable');
    const old = p.ranking.memory.indexOf(p.ids[0]);
    const current = p.ranking.memory.indexOf(p.state.corrected);
    assert.ok(old >= 0, 'memory keeps the superseded record retrievable rather than deleting it');
    assert.equal(p.ranking.memoryStatus[old], 'superseded', 'and annotates it as superseded');
    assert.ok(current >= 0 && current < old, 'the current correction ranks above the record it replaces');
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 2, knowledge: 2 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('09 a retracted claim is not returned as current, and its absence is not a disproof', async () => {
    const p = await probe({
      knowledge: [triple('sensor', 'reading', '42')],
      query: 'sensor reading',
      rank: true,
      prepare: async (app, s) => {
        await app.knowledge.retract({ target: s.kids[0], reason: 'the sensor was recalibrated', origin: 'user' });
      },
    });
    assert.deepEqual(p.ranking.knowledge, [], 'the retracted triple is excluded from retrieval');
    assert.deepEqual(p.records.knowledge, [], 'it did not reach the prompt either');
    assert.equal(p.completeness.report, false, 'an empty result is not proof the fact never existed');
    assert.equal(p.sourceState('knowledge'), 'complete_empty', 'the search covered the active pool and found nothing');
    assert.ok(!/does not exist|never stored|no such fact/i.test(p.limitation.output));
    expectPersisted(p, { memory: 0, knowledge: 2 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });
});

describe('AP-10 §10 adversarial retrieval cases 10-17: thresholds, bounds and query shape', () => {
  test('10 a relevant record below the fixed floor is reported as below threshold, not as absent', async () => {
    const p = await probe({
      memory: ['the launch code name is Zephyr'],
      query: `${NOISE(380)} launch code name`,
      rank: true,
    });
    assert.equal(p.ranking.memory[0], p.ids[0], 'the search still finds and ranks the exact match first');
    assert.ok(p.ranking.memoryScores[0] < 0.2, `the long query dilutes its own score, got ${p.ranking.memoryScores[0]}`);
    assert.deepEqual(p.records.memory, [], 'the prompt floor excludes it');
    assert.equal(p.sourceState('memory'), 'below_relevance_threshold');
    assert.equal(p.sourceEntry('memory').exclusions.belowRelevance, 1);
    assert.equal(p.completeness.report, false);
    assert.ok(!/no records|nothing stored|does not exist/i.test(p.limitation.output), 'the answer does not claim the fact is absent');
    expectPersisted(p, { memory: 1, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('11 a source-limit exclusion is its own state and is counted', async () => {
    const p = await probe({
      memory: Array.from({ length: 12 }, (_, i) => `the lighthouse status is green variant ${i}`),
      query: 'lighthouse status green',
      rank: true,
    });
    assert.equal(p.ranking.memory.length, 12);
    assert.equal(p.records.memory.length, 5);
    assert.equal(p.sourceState('memory'), 'source_limit_reached');
    assert.equal(p.sourceEntry('memory').exclusions.sourceLimit, 7, 'twelve matches, five returned, seven excluded by the bound');
    assert.equal(p.sourceEntry('memory').contributed, 5);
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 12, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('12 a context-budget exclusion is disclosed, and the cut does not invalidate a citation', async () => {
    const p = await probe({
      memory: [
        'the lighthouse status is green and the inspection passed',
        'the lighthouse keeper is ana and she started in march',
        'the lighthouse budget is 1200 EUR for the current year',
      ],
      query: 'lighthouse status keeper budget',
      contextChars: 300,
      rank: true,
    });
    assert.deepEqual(p.records.memory, [], 'the budget removed every memory line');
    assert.equal(p.sourceState('memory'), 'context_budget_limited');
    assert.equal(p.sourceEntry('memory').exclusions.contextBudget, 3);
    assert.equal(p.completeness.report, false);
    assert.ok(p.limitation.notices.some((n) => n.includes('left out of this answer to fit the context budget')), 'the cut is stated beside the answer');
    assert.ok(p.limitation.notices.some((n) => n.includes('remain stored')), 'and the records are said to remain stored');
    // The budget trims the prompt, not the evidence snapshot: the cited record was still retrieved,
    // so the citation stays valid and the answer is not downgraded for a trim it did not cause.
    assert.equal(p.citation.claims.supported, 1, 'the citation still resolves against the snapshot');
    assert.equal(p.sourceEntry('memory').contributed, 3, 'all three records are still evidence');
    expectPersisted(p, { memory: 3, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('13 an empty query is refused rather than searched as a match-everything request', async () => {
    const p = await probe({ memory: ['the lighthouse status is green'], query: '   ' });
    assert.equal(p.res.status, Outcome.INPUT_REJECTED);
    assert.equal(p.executive.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(p.report, null, 'no retrieval was performed, so no retrieval report is invented');
    assert.equal(p.executive.executed, 0);
    assert.equal(p.persistence.memoryRecords, 1);
  });

  test('14 an extremely long query keeps its informative tail and stays bounded', async () => {
    const tail = 'zephyr anomaly';
    const query = `${NOISE(350)} ${tail}`;
    assert.ok(query.length <= 4000, `the fixture must fit the request bound, got ${query.length}`);
    const tokens = queryTokens(query, { stem: true });
    assert.ok(tokens.tokens.includes('zephyr'), 'the tail survived the request bound');
    assert.ok(tokens.tokens.includes('anomaly'));
    assert.ok(tokens.tokens.length <= MAX_QUERY_TOKENS);
    const p = await probe({ memory: [`the lighthouse ${tail} was logged`], query, rank: true });
    assert.equal(p.ranking.memory[0], p.ids[0], 'the tail terms still retrieve the record');
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 1, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('15 a malformed query is handled without crashing or matching everything', async () => {
    assert.deepEqual(queryTokens('??? !!! @@@ ### $$$ %%% ^^^ &&& ***').tokens, []);
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse ??? !!! @@@ ### $$$ %%% ^^^ &&& *** ((( )))',
      rank: true,
    });
    assert.deepEqual(p.ranking.memory, [p.ids[0]], 'the punctuation contributed no terms and did not broaden the match');
    assert.deepEqual(p.ranking.memoryScores, [1], 'the score is the one the clean query produces');
    assert.ok(p.records.memory.includes(p.ids[0]));
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 1, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('16 repeated tokens do not change the query', async () => {
    assert.deepEqual(queryTokens('status status status').tokens, queryTokens('status').tokens);
    const records = ['the lighthouse status is green'];
    const a = await probe({ memory: records, query: 'lighthouse status', rank: true });
    const b = await probe({ memory: records, query: 'lighthouse status status status', rank: true });
    assert.deepEqual(a.ranking.memoryScores, b.ranking.memoryScores, 'repetition does not inflate the score');
    assert.deepEqual(positions(a.ranking.memory, a.ids), positions(b.ranking.memory, b.ids));
    assert.equal(a.records.memory.length, b.records.memory.length);
    assert.equal(a.sourceState('memory'), b.sourceState('memory'));
    expectNoExecutiveAuthority(a);
    expectCompletenessHonest(a);
  });

  test('17 a different word order produces the same ranking', async () => {
    const records = ['the lighthouse status is green', 'the lighthouse keeper is ana', 'the archive batch was recorded'];
    const a = await probe({ memory: records, query: 'lighthouse status green', rank: true });
    const b = await probe({ memory: records, query: 'green status lighthouse', rank: true });
    assert.deepEqual(positions(a.ranking.memory, a.ids), positions(b.ranking.memory, b.ids), 'order is not a ranking signal');
    assert.deepEqual(a.ranking.memoryScores, b.ranking.memoryScores);
    assert.deepEqual(positions(a.records.memory, a.ids), positions(b.records.memory, b.ids));
    assert.equal(a.sourceState('memory'), b.sourceState('memory'));
    expectNoExecutiveAuthority(a);
    expectCompletenessHonest(a);
  });
});

describe('AP-10 §10 adversarial retrieval cases 18-22: snapshot integrity and determinism', () => {
  test('18 an append during the model phase does not silently enter the answer', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      rank: true,
      during: async (app) => { await app.memory.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user' }); },
    });
    assert.deepEqual(p.records.memory, [p.ids[0]], 'the appended record is not in the prompt of this request');
    assert.equal(p.persistence.memoryRecords, 2, 'the append was persisted');
    assert.equal(p.completeness.report, false, 'a store that changed during the request is not a complete selection');
    assert.equal(p.ranking.memory.length, 2, 'a later read does see it');
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('19 a write between two source reads cannot yield a completeness claim', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app) => {
        // The window is decided by the read contract from the stores' own certification. Writing
        // between the memory read and the knowledge read is what makes a window inconsistent; the
        // hook places the write exactly there.
        const original = app.knowledge.search.bind(app.knowledge);
        app.knowledge.search = async (...args) => {
          await app.memory.add({ content: 'the lighthouse status is amber', kind: 'user_fact', source: 'user' });
          return original(...args);
        };
      },
    });
    assert.equal(p.completeness.report, false);
    assert.equal(p.completeness.read, false);
    if (p.completeness.window === 'concurrent_modification') {
      assert.equal(p.retrievalState, 'inconsistent_snapshot');
      assert.ok(p.report.limitations.some((line) => /changed during the read|no single instant/.test(line)));
    }
    assert.equal(p.persistence.memoryRecords, 2, 'the concurrent write is preserved');
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('20 an unreadable memory store blocks the request instead of answering from an empty result', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app) => {
        app.memory.search = async () => { const err = new Error('memory store is offline'); err.code = 'STORE_UNAVAILABLE'; throw err; };
      },
    });
    // The controller fails closed at the retrieval stage, before cognition runs, so no report is
    // produced at all. The report-level `unavailable_source` state - null counts, never zero - is
    // pinned in retrieval-snapshot.test.js against retrieveEvidence directly.
    assert.ok(p.op.errors.some((e) => e.stage === 'retrieval'), 'the failure is recorded at the retrieval stage');
    assert.equal(p.executive.executed, 0);
    assert.ok(!/no records were stored|the store is empty|nothing is known/i.test(p.limitation.output), 'an unreadable store is never described as empty');
    assert.equal(p.persistence.memoryRecords, 1, 'the stored record is untouched');
    assert.equal(p.executive.authorizes.integrity ?? false, false);
  });

  test('21 a damaged source fails closed instead of answering from the readable part', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app, s, dir) => { fs.appendFileSync(path.join(dir, 'memory.jsonl'), '{"broken": \n'); },
    });
    assert.equal(p.res.status, Outcome.EXECUTION_FAILED, 'a damaged memory store blocks the request');
    assert.equal(p.executive.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(p.report, null, 'no retrieval report is produced for a request that never retrieved');
    assert.equal(p.executive.executed, 0);
    assert.equal(p.persistence.memoryRecords, 2, 'the damaged line is preserved, not repaired or deleted');
    assert.ok(p.op.errors.some((e) => e.stage === 'retrieval'), 'the failure is recorded at the retrieval stage');
  });

  test('22 the same query over the same snapshot produces the same ranking and the same report', async () => {
    const records = ['the lighthouse status is green', 'the lighthouse keeper is ana', 'the archive batch was recorded'];
    const run = () => probe({ memory: records, query: 'lighthouse status keeper', rank: true });
    const a = await run();
    const b = await run();
    assert.deepEqual(positions(a.ranking.memory, a.ids), positions(b.ranking.memory, b.ids));
    assert.deepEqual(a.ranking.memoryScores, b.ranking.memoryScores);
    assert.deepEqual(positions(a.records.memory, a.ids), positions(b.records.memory, b.ids));
    assert.equal(a.retrievalState, b.retrievalState);
    assert.deepEqual(a.report.counts, b.report.counts);
    assert.deepEqual(a.report.limitations, b.report.limitations);
    assert.deepEqual(a.report.sources, b.report.sources);
    assert.equal(a.citation.trust, b.citation.trust);
    expectNoExecutiveAuthority(a);
    expectCompletenessHonest(a);
  });
});

describe('AP-10 §10 adversarial retrieval cases 23-25: citation and completeness honesty', () => {
  test('23 a claim that cites nothing is labelled ungrounded, never supported', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      reply: () => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', kind: 'general_knowledge' },
      ]),
    });
    assert.equal(p.citation.claims.generalKnowledge, 1);
    assert.equal(p.citation.claims.supported, 0);
    assert.notEqual(p.citation.trust, 'factually_supported', 'an uncited claim cannot make the answer supported');
    assert.ok(p.limitation.codes.includes('claims_general_knowledge'));
    assert.ok(p.citation.codes.includes('citation_relevant_uncited'), 'the retrieved record no claim cites is disclosed');
    assert.equal(p.completeness.report, false);
    expectPersisted(p, { memory: 1, knowledge: 0 });
    expectNoExecutiveAuthority(p);
    expectCompletenessHonest(p);
  });

  test('23b a factual claim with no evidence id is rejected outright', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      reply: () => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [], kind: 'supported' },
      ]),
    });
    assert.ok(p.limitation.codes.includes('structured_response_rejected'), 'a supported claim must cite a retrieved record');
    assert.equal(p.citation.claims.total, 0, 'nothing in the rejected structure was used');
    assert.notEqual(p.citation.trust, 'factually_supported');
    assert.equal(p.executive.executed, 0);
    expectPersisted(p, { memory: 1, knowledge: 0 });
    expectCompletenessHonest(p);
  });

  test('24 a one-sided citation of a stored disagreement is disclosed, not silently accepted', async () => {
    const fixture = {
      memory: ['the lighthouse status is green', 'the lighthouse status is red'],
      query: 'lighthouse status',
    };
    // Labelled `supported`, the structure is refused: a contested record cannot support a flat fact.
    const refused = await probe({
      ...fixture,
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    assert.ok(refused.limitation.codes.includes('structured_response_rejected'));
    // Both sides reached the prompt here, so the disclosure is the stored-conflict one. The
    // one-sided wording belongs to a selection that showed only one side, which case 07 covers.
    assert.ok(refused.limitation.notices.some((n) => n.includes('conflicting records')));
    assert.notEqual(refused.citation.trust, 'factually_supported');
    expectNoExecutiveAuthority(refused);
    expectCompletenessHonest(refused);

    // Every factual label is refused, not just `supported`: APEX will not present one side of an
    // unresolved disagreement as a fact however the model qualifies it. The citation assessment's
    // own one-sided finding is the second line of defence and is pinned in citation-completeness.test.js,
    // because through the controller this validator refuses first.
    for (const label of ['partially_supported', 'historical']) {
      const partial = await probe({
        ...fixture,
        reply: (s) => cognitionBlock('the lighthouse status is green', [
          { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: label },
        ]),
      });
      assert.ok(partial.limitation.codes.includes('structured_response_rejected'), `${label} on a contested record is refused`);
      assert.equal(partial.citation.claims.total, 0, 'nothing in the refused structure was used');
      assert.notEqual(partial.citation.trust, 'factually_supported');
      assert.ok(partial.limitation.notices.some((n) => n.includes('conflicting records')), 'the disagreement is still stated beside the answer');
      assert.equal(partial.completeness.report, false);
      expectPersisted(partial, { memory: 2, knowledge: 0 });
      expectNoExecutiveAuthority(partial);
      expectCompletenessHonest(partial);
    }
  });

  test('25 an incomplete selection is never reported as complete, and an empty one is never proof of absence', async () => {
    const bounded = await probe({
      memory: Array.from({ length: 9 }, (_, i) => `the lighthouse note ${i} was recorded`),
      query: 'lighthouse note',
      rank: true,
    });
    assert.equal(bounded.completeness.report, false);
    assert.equal(bounded.completeness.read, false);
    assert.equal(bounded.sourceState('memory'), 'source_limit_reached');
    assert.ok(bounded.report.limitations.length > 0, 'the limitation is stated, not implied');

    const empty = await probe({ memory: [], query: 'lighthouse status', rank: true });
    assert.deepEqual(empty.ranking.memory, []);
    assert.equal(empty.completeness.report, false, 'a bounded read that returned nothing still proves nothing');
    assert.equal(empty.sourceState('memory'), 'complete_empty', 'the search covered an empty store');
    assert.ok(!/does not exist|never stored|no such fact/i.test(empty.limitation.output), 'the answer does not turn an empty result into a disproof');

    // Every state in the vocabulary is ordered, and the aggregate is the worst of its sources.
    assert.equal(RETRIEVAL_STATES.length, 11);
    assert.equal(new Set(RETRIEVAL_STATES).size, 11);
    for (const state of RETRIEVAL_STATES) assert.ok(isRetrievalState(state));
    assert.equal(isRetrievalState('complete'), false);
    expectNoExecutiveAuthority(bounded);
    expectCompletenessHonest(bounded);
    expectCompletenessHonest(empty);
  });
});

// The audit projection is bounded and carries no record text. This is checked once over a case that
// has plenty of content to leak, rather than repeated in all twenty-five.
test('the persisted retrieval report carries counts and states only, never record text', async () => {
  const p = await probe({
    memory: ['the lighthouse status is green and the secret passphrase is hunter2'],
    query: 'lighthouse status',
  });
  const serialized = JSON.stringify(p.persistence.auditReport ?? {});
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('lighthouse'), false);
  assert.ok(readJsonl(path.join(p.dir, 'operations.jsonl')).length >= 1);
  expectNoExecutiveAuthority(p);
});