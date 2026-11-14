// Batch AP-10 §11: acceptance through the real controller.
//
// Every scenario drives the whole chain - request, normalization, multi-source retrieval, ranking,
// evidence snapshot, context-budget selection, claim attribution, semantic consistency, response
// integrity, final answer - and asserts what the user sees beside what was persisted. The model is a
// fixed-output stub and experience capture is off, so nothing here runs inference or contacts an
// endpoint. Where a guarantee is about a refusal, the refusal itself is the assertion.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { probe, cleanupAll, cognitionBlock, evidenceId } from './retrieval-probe.js';
import { normalizeTokens, queryTokens } from '../src/retrieval/normalize.js';
import { RETRIEVAL_STATES, isRetrievalState } from '../src/retrieval/report.js';
import { ResponseTrustState, ResponseDegradation } from '../src/cognition/response-integrity.js';
import { SemanticFinding } from '../src/cognition/semantic-consistency.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';

after(cleanupAll);

const triple = (subject, relationship, object, extra = {}) => ({ subject, relationship, object, origin: 'user', ...extra });
const positions = (ids, fixtureIds) => ids.map((id) => fixtureIds.indexOf(id));

// The chain is only accepted when every stage left its own trace. A missing stage is a gap, not a
// pass: the report, the read contract and the response assessment must all be present and agree.
function expectChain(p) {
  assert.ok(p.report, 'the retrieval report was produced');
  assert.ok(isRetrievalState(p.retrievalState), `unknown retrieval state ${p.retrievalState}`);
  assert.ok(p.read, 'the AP-07 read contract was produced');
  assert.ok(p.integrity, 'the AP-08/09 response assessment was produced');
  assert.equal(p.integrity.verified, false, 'model prose is never verified in this build');
  assert.equal(p.integrity.authorizes, false);
  assert.equal(p.report.authorizes, false);
  assert.equal(p.executive.authorizes.contract, false);
  assert.equal(p.executive.executed, 0, 'no model-proposed action was executed');
  assert.equal(p.persistence.auditFound, true, 'the operation was persisted');
  assert.equal(p.persistence.auditAuthorizes, false);
  if (p.completeness.read === false) {
    assert.equal(p.completeness.report, false, 'an uncertified read cannot yield a complete report');
  }
}

describe('AP-10 §11 acceptance: the whole chain, end to end', () => {
  test('A1 a grounded answer carries every stage of the chain and stays below verified', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      knowledge: [triple('lighthouse', 'keeper', 'ana')],
      query: 'lighthouse status',
      rank: true,
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    // normalization: the query the stores saw is the bounded token list, not the raw string.
    const entry = p.sourceEntry('memory');
    assert.deepEqual(queryTokens('lighthouse status').tokens, normalizeTokens('lighthouse status'));
    assert.equal(entry.queryTokens, 2);
    assert.equal(entry.droppedTokens, 0);
    // multi-source retrieval: both sources were searched and each keeps its own state.
    assert.ok(p.report.sources.some((s) => s.source === 'memory'));
    assert.ok(p.report.sources.some((s) => s.source === 'knowledge'));
    // ranking and snapshot: the cited record is the one that ranked first and reached the prompt.
    assert.equal(p.ranking.memory[0], p.ids[0]);
    assert.deepEqual(p.records.memory, [p.ids[0]]);
    // attribution, semantic consistency and integrity.
    assert.equal(p.integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(p.integrity.claims.supported, 1);
    assert.equal(p.integrity.semantic.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
    // The knowledge record was retrieved and no claim cites it, so even the happy path discloses an
    // omission rather than presenting the selection as exhaustive.
    assert.ok(p.integrity.limitations.includes('citation_relevant_uncited'));
    assert.equal(p.integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(p.limitation.output.includes('the lighthouse status is green'));
  });

  test('A2 an omission is visible beside the answer and in the audit', async () => {
    const p = await probe({
      memory: Array.from({ length: 9 }, (_, i) => `the lighthouse note ${i} was recorded`),
      query: 'lighthouse note',
      rank: true,
    });
    expectChain(p);
    const entry = p.sourceEntry('memory');
    assert.equal(entry.state, 'source_limit_reached');
    assert.ok(entry.exclusions.sourceLimit > 0);
    assert.equal(p.completeness.report, false);
    assert.ok(p.report.limitations.some((line) => /more eligible records than the bound returned/.test(line)));
    // The same exclusion is in the persisted projection, so a later reader sees it too.
    const stored = p.persistence.auditReport.sources.find((s) => s.source === 'memory');
    assert.equal(stored.state, 'source_limit_reached');
    assert.ok(stored.exclusions.sourceLimit > 0);
    assert.equal(p.ranking.memory.length, 9, 'the records the bound excluded are still stored');
  });

  test('A3 an incomplete selection cannot become complete on a second request', async () => {
    const fixture = {
      memory: Array.from({ length: 9 }, (_, i) => `the lighthouse note ${i} was recorded`),
      query: 'lighthouse note',
    };
    const first = await probe(fixture);
    const second = await probe(fixture);
    expectChain(first);
    expectChain(second);
    assert.equal(first.completeness.report, false);
    assert.equal(second.completeness.report, false);
    assert.equal(first.retrievalState, second.retrievalState);
    assert.deepEqual(first.report.counts, second.report.counts);
    assert.deepEqual(first.report.limitations, second.report.limitations);
  });

  test('A4 a stored contradiction is disclosed, never hidden behind a supported answer', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green', 'the lighthouse status is red'],
      query: 'lighthouse status',
      rank: true,
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    assert.notEqual(p.integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    // A factual claim leaning on one side of an unresolved disagreement is refused before it can be
    // assessed, so no claim survives and the claim-level `evidence_conflicting` code cannot fire.
    // The disagreement is still disclosed: the stored-conflict notice is beside the answer.
    assert.ok(p.integrity.limitations.includes('structured_response_rejected'));
    assert.equal(p.integrity.claims.total, 0);
    assert.ok(p.limitation.notices.some((n) => /conflicting records|one side of a disagreement/.test(n)));
    assert.equal(p.ranking.memory.length, 2, 'both sides stayed retrievable');
    assert.deepEqual(p.ranking.memoryConflicts[0], [p.ranking.memory[1]]);
  });

  test('A5 an empty result is not proof that the fact does not exist', async () => {
    const p = await probe({ memory: [], query: 'lighthouse status', rank: true });
    expectChain(p);
    assert.deepEqual(p.ranking.memory, []);
    assert.equal(p.sourceState('memory'), 'complete_empty');
    assert.equal(p.completeness.report, false, 'a bounded read that returned nothing still proves nothing');
    assert.ok(!/does not exist|never stored|no such fact/i.test(p.limitation.output));
    assert.equal(p.persistence.memoryRecords, 0);
  });

  test('A6 the AP-08 trust ladder and degradation vocabulary are unchanged', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green', 'the lighthouse review is pending'],
      query: 'lighthouse status',
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    assert.equal(p.integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(p.integrity.limitations.includes('citation_relevant_uncited'));
    assert.equal(p.integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.ok(p.limitation.notices.some((n) => /cited by no claim/.test(n)));
    assert.notEqual(p.integrity.trust, ResponseTrustState.VERIFIED);
  });

  test('A7 the AP-09 semantic assessment still catches a claim that alters a stored number', async () => {
    const p = await probe({
      memory: ['the lighthouse beam range is 12 nautical miles'],
      query: 'lighthouse beam range',
      reply: (s) => cognitionBlock('the lighthouse beam range is 21 nautical miles', [
        { text: 'the lighthouse beam range is 21 nautical miles', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    assert.notEqual(p.integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.ok(p.integrity.limitations.some((code) => code.startsWith('semantic_')), 'a semantic finding is disclosed');
    assert.equal(p.integrity.semantic.claims.consistent, 0);
  });

  test('A8 model output cannot override provenance: an unretrieved citation is refused', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      reply: () => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: ['ev:memory:never-retrieved'], kind: 'supported' },
      ]),
    });
    expectChain(p);
    assert.ok(p.integrity.limitations.includes('structured_response_rejected'));
    assert.equal(p.integrity.claims.total, 0, 'nothing in the rejected structure was used');
    assert.notEqual(p.integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
    assert.equal(p.persistence.memoryRecords, 1, 'the model did not write a record');
  });

  test('A9 a model reply cannot propose an executive action', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ], { decision: 'propose_action', proposal: { action: 'memory.add', args: { content: 'x' } } }),
    });
    expectChain(p);
    // The structured decision vocabulary has no action kind, so the reply is refused rather than
    // handed to the executive. Authorization stays with the ECP and the approval path.
    assert.ok(p.integrity.limitations.includes('structured_response_rejected'));
    assert.notEqual(p.executive.decision, Decision.PROPOSE_ACTION);
    assert.equal(p.executive.executed, 0);
    assert.equal(p.persistence.memoryRecords, 1);
  });

  test('A10 a context-budget cut keeps provenance and discloses what it removed', async () => {
    const p = await probe({
      memory: [
        'the lighthouse status is green',
        'the lighthouse status review is pending',
        'the lighthouse status audit is scheduled',
      ],
      query: 'lighthouse status',
      contextChars: 300,
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    const entry = p.sourceEntry('memory');
    assert.equal(entry.state, 'context_budget_limited');
    assert.ok(entry.exclusions.contextBudget >= 1);
    assert.equal(entry.contributed, 3, 'the snapshot still holds every retrieved record');
    assert.ok(p.records.memory.length < 3, 'the prompt carried fewer');
    assert.ok(p.limitation.notices.some((n) => /context budget/.test(n)));
    assert.ok(p.limitation.notices.some((n) => /remain stored/.test(n)), 'the cut records are not described as deleted');
  });

  test('A11 every contributing source keeps its own state in one report', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      knowledge: [triple('lighthouse', 'status', 'green')],
      query: 'lighthouse status',
      rank: true,
      reply: (s) => cognitionBlock('the lighthouse status is green', [
        { text: 'the lighthouse status is green', evidence: [evidenceId('memory', s.ids[0])], kind: 'supported' },
      ]),
    });
    expectChain(p);
    const memory = p.sourceEntry('memory');
    const knowledge = p.sourceEntry('knowledge');
    assert.ok(memory.searched && knowledge.searched);
    assert.equal(memory.contributed, 1);
    assert.equal(knowledge.contributed, 1);
    assert.deepEqual(p.records.knowledge, [p.kids[0]]);
    // The aggregate is the worst source, so one bounded source describes the whole retrieval.
    const worst = p.report.sources.reduce((acc, source) => (
      RETRIEVAL_STATES.indexOf(source.state) > RETRIEVAL_STATES.indexOf(acc) ? source.state : acc
    ), 'complete_empty');
    assert.equal(p.retrievalState, worst);
    assert.ok(RETRIEVAL_STATES.includes(worst));
  });

  test('A12 the same query over the same snapshot is deterministic across the whole chain', async () => {
    const fixture = {
      memory: ['the lighthouse status is green', 'the lighthouse keeper is ana', 'the archive batch was recorded'],
      query: 'lighthouse status keeper',
      rank: true,
    };
    const a = await probe(fixture);
    const b = await probe(fixture);
    expectChain(a);
    expectChain(b);
    assert.deepEqual(positions(a.ranking.memory, a.ids), positions(b.ranking.memory, b.ids));
    assert.deepEqual(a.ranking.memoryScores, b.ranking.memoryScores);
    assert.deepEqual(positions(a.records.memory, a.ids), positions(b.records.memory, b.ids));
    assert.equal(a.retrievalState, b.retrievalState);
    assert.deepEqual(a.report.sources, b.report.sources);
    assert.equal(a.integrity.trust, b.integrity.trust);
    assert.deepEqual(a.integrity.limitations, b.integrity.limitations);
  });

  test('A13 a request that never retrieved produces no report and no completeness claim', async () => {
    const p = await probe({
      memory: ['the lighthouse status is green'],
      query: 'lighthouse status',
      prepare: async (app) => {
        app.memory.search = async () => {
          const err = new Error('memory store is offline');
          err.code = 'STORE_UNAVAILABLE';
          throw err;
        };
      },
    });
    assert.equal(p.res.status, Outcome.EXECUTION_FAILED);
    assert.equal(p.report, null);
    assert.equal(p.executive.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(p.executive.executed, 0);
    assert.ok(!/the store is empty|nothing is known/i.test(p.limitation.output));
    assert.equal(p.persistence.memoryRecords, 1);
  });
});