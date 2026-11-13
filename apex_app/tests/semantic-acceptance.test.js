// Batch AP-09 §12: deterministic end-to-end acceptance for semantic grounding, claim consistency and
// adversarial response verification.
//
// Every scenario drives the real controller, memory/knowledge stores, conversation log and operation
// log. The model is an in-process fixed-output stub and capture is off; nothing here contacts a model,
// launches inference, or downloads anything. Expected values are APEX's own deterministic
// classification of records it can read, so a passing run is evidence of behaviour, not of model
// quality. The semantic assessment is a bounded lexical check, not natural-language inference; the
// fixtures below are worded so that each class is decidable without one.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import {
  ResponseDegradation,
  ResponseFindingKind,
  ResponseTrustState,
} from '../src/cognition/response-integrity.js';
import { SemanticFinding } from '../src/cognition/semantic-consistency.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = '2026-05-01T00:00:00.000Z';
const NOTICE = '[APEX check:';
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

// ---- deterministic model stand-ins -------------------------------------------------------------

function makeBackend(hooks) {
  return {
    name: 'ap09-capture',
    provider: 'ap09-capture',
    configured: true,
    describe: () => ({ configured: true, provider: 'ap09-capture', endpoint: 'synthetic', model: 'synthetic' }),
    health: async () => ({ available: true, detail: 'synthetic capture' }),
    complete: async () => {
      if (hooks.before) await hooks.before();
      return {
        ok: true,
        backend: 'ap09-capture',
        provider: 'ap09-capture',
        model: 'synthetic',
        text: hooks.reply(),
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    },
  };
}

function block(answer, claims, extra = {}) {
  return [
    answer,
    `COGNITION ${JSON.stringify({ schema: 1, decision: 'answer', answer, claims, ...extra })}`,
  ].join('\n');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// One request through the real controller. `build` and `duringModel` receive the stored record id and
// the app so a fixture can time a write against the retrieval or model phase.
async function run({
  record, query, claim = null, answer = null, kind = 'supported', extra = {},
  claims = null, build = null, prepare = null, duringModel = null,
}) {
  const state = { recordId: null, app: null };
  const hooks = {
    reply: () => (build
      ? build(state.recordId)
      : block(answer ?? claim, claims ?? [{ text: claim, evidence: [`ev:memory:${state.recordId}`], kind }], extra)),
    before: duringModel ? () => duringModel(state.app, state.recordId) : null,
  };
  const dataDir = makeTempDataDir();
  dirs.push(dataDir);
  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: makeBackend(hooks) }),
    experienceCapture: CAPTURE_OFF,
    now: () => new Date(NOW),
  });
  state.app = app;
  const stored = await app.memory.add({ content: record, kind: 'user_fact', source: 'user' });
  state.recordId = stored.id;
  if (prepare) await prepare(app, stored, dataDir);
  const res = await app.controller.handle(query, { origin: 'user' });
  const integrity = res.operation.cognition.responseIntegrity;
  const audit = readJsonl(path.join(dataDir, 'operations.jsonl'));
  return {
    res,
    integrity,
    semantic: integrity.semantic,
    stored: audit.find((op) => op.id === res.operation.id),
    dataDir,
    recordId: stored.id,
  };
}

function modelTurns(dataDir) {
  return readJsonl(path.join(dataDir, 'conversation.jsonl')).filter((turn) => turn.origin === 'model');
}

// The notice is shown beside the answer and never stored as a model turn, so a later follow-up cannot
// replay it as something the model said.
function expectNoticeOutsideModelTurn({ res, dataDir }) {
  assert.equal(res.output.includes(NOTICE), true, 'the answer is shown with an APEX notice');
  const turns = modelTurns(dataDir);
  assert.equal(turns.length, 1, 'the exchange records exactly one model turn');
  assert.equal(turns[0].text.includes(NOTICE), false, 'the APEX notice is not part of the model turn');
}

// The bounded audit never carries claim prose or record content, and never claims authority.
function expectAuditHasNoText(stored, texts) {
  const serialized = JSON.stringify(stored.cognition.responseIntegrity)
    + JSON.stringify(stored.cognition.responseContract);
  for (const text of texts) {
    assert.equal(serialized.includes(text), false, `the audit does not carry text: ${text}`);
  }
  assert.equal(stored.cognition.responseIntegrity.authorizes, false);
  assert.equal(stored.cognition.responseIntegrity.verified, false);
  assert.equal(stored.cognition.responseContract.authorizes, false);
  assert.equal(stored.cognition.responseContract.checks.find((entry) => entry.check === 'execution_requires_registry_allow').ok, true);
  assert.equal(stored.cognition.responseContract.checks.find((entry) => entry.check === 'handoff_claims_no_authority').ok, true);
}

const CLEAN_COUNTS = Object.freeze({
  total: 1, assessed: 1, consistent: 1, partial: 0, conflict: 0, ambiguous: 0,
  insufficient: 0, unavailable: 0, not_checked: 0,
});

function expectSupportedForPresentation({ res, integrity, semantic, stored }) {
  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
  assert.equal(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
  assert.equal(integrity.degradation, ResponseDegradation.PRESENT_AS_IS);
  assert.deepEqual(integrity.limitations, ['model_output_unverified']);
  assert.equal(semantic.finding, SemanticFinding.SEMANTICALLY_CONSISTENT);
  assert.deepEqual(semantic.claims, CLEAN_COUNTS);
  assert.deepEqual(semantic.contradictions, []);
  assert.equal(semantic.overstated, 0);
  assert.equal(semantic.bounded, false);
  assert.equal(semantic.authorizes, false);
  assert.equal(integrity.verified, false, 'a supported answer is still not verification');
  assert.deepEqual(res.operation.steps, [], 'a read answer executes nothing');
  assert.equal(res.output.includes(NOTICE), false, 'a consistent answer carries no semantic notice');
  assert.equal(stored.cognition.responseIntegrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
  assert.equal(stored.cognition.responseIntegrity.verified, false);
  assert.equal(stored.cognition.responseContract.checks.every((entry) => entry.ok), true);
}

// ---- supported facts and valid paraphrases -----------------------------------------------------

describe('AP-09 §12: a supported answer is presented as support, never as verification', () => {
  test('an exact restatement of the cited record reaches factual support and stays below verified', async () => {
    const out = await run({
      record: 'the lighthouse project status is green',
      claim: 'the lighthouse project status is green',
      query: 'tell me about the lighthouse project status',
    });
    expectSupportedForPresentation(out);
    assert.deepEqual(Object.keys(out.semantic).sort(), [
      'authorizes', 'bounded', 'claims', 'contradictions', 'dimensions', 'finding', 'overstated', 'schema',
    ]);
  });

  test('a bounded paraphrase of the same record is assessed the same way', async () => {
    const out = await run({
      record: 'the lighthouse project status is green',
      claim: 'the lighthouse project is green',
      query: 'tell me about the lighthouse project status',
    });
    expectSupportedForPresentation(out);
  });
});

// ---- contradiction classes ---------------------------------------------------------------------

describe('AP-09 §12: a claim that changes meaning is disclosed, not silently supported', () => {
  const classes = [
    {
      name: 'a reversed negation is a polarity conflict',
      record: 'the deployment was approved',
      claim: 'the deployment was not approved',
      query: 'tell me about the deployment',
      finding: SemanticFinding.POLARITY_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_polarity_conflict'],
    },
    {
      name: 'a changed quantity is a numerical conflict',
      record: 'the archive retention window is at least 30 days',
      claim: 'the archive retention window is 3 days',
      query: 'tell me about the archive retention window',
      finding: SemanticFinding.NUMERICAL_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'claim_attribution_unverified', 'semantic_numerical_conflict'],
    },
    {
      name: 'an exact value for a record that states a bound is a numerical conflict',
      record: 'the archive retention window is at least 30 days',
      claim: 'the archive retention window is 30 days',
      query: 'tell me about the archive retention window',
      finding: SemanticFinding.NUMERICAL_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_numerical_conflict'],
    },
    {
      name: 'a changed date is a temporal conflict',
      record: 'the release happened on 2026-04-01',
      claim: 'the release happened on 2026-04-02',
      query: 'tell me about the release',
      finding: SemanticFinding.TEMPORAL_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_temporal_conflict'],
    },
    {
      name: 'a swapped entity is an entity conflict',
      record: 'the Aurora deployment succeeded',
      claim: 'the Meridian deployment succeeded',
      query: 'tell me about the deployment',
      finding: SemanticFinding.ENTITY_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_entity_conflict'],
    },
    {
      name: 'a reversed relationship is a relationship conflict',
      record: 'the operator owns the vault',
      claim: 'the vault owns the operator',
      query: 'tell me about the operator',
      finding: SemanticFinding.RELATIONSHIP_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_relationship_conflict'],
    },
    {
      name: 'a widened quantifier is a qualifier conflict',
      record: 'some checks passed',
      claim: 'all checks passed',
      query: 'tell me about the checks',
      finding: SemanticFinding.QUALIFIER_CONFLICT,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'semantic_qualifier_conflict'],
    },
    {
      name: 'an added causal claim is an unsupported transformation',
      record: 'the deployment failed',
      claim: 'the deployment failed because the cache expired',
      query: 'tell me about the deployment',
      finding: SemanticFinding.UNSUPPORTED_TRANSFORMATION,
      bucket: 'conflict',
      limitations: ['model_output_unverified', 'claim_attribution_unverified', 'semantic_unsupported_transformation'],
    },
    {
      name: 'a meaning the bounded check cannot establish stays ambiguous',
      record: 'the deployment was approved',
      claim: 'the deployment was not fully approved',
      query: 'tell me about the deployment',
      finding: SemanticFinding.AMBIGUOUS,
      bucket: 'ambiguous',
      limitations: ['model_output_unverified', 'semantic_ambiguous'],
    },
    {
      name: 'an omitted quantity leaves the claim only partially consistent',
      record: 'the release shipped with 3 known bugs',
      claim: 'the release shipped',
      query: 'tell me about the release',
      finding: SemanticFinding.PARTIALLY_CONSISTENT,
      bucket: 'partial',
      limitations: ['model_output_unverified', 'semantic_partial'],
    },
  ];

  for (const entry of classes) {
    test(entry.name, async () => {
      const out = await run({
        record: entry.record, claim: entry.claim, query: entry.query,
      });
      const { res, integrity, semantic, stored } = out;

      assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
      assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
      assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
      assert.deepEqual(integrity.limitations, entry.limitations);
      assert.notEqual(integrity.trust, ResponseTrustState.FACTUALLY_SUPPORTED);
      assert.notEqual(integrity.trust, ResponseTrustState.VERIFIED);
      assert.equal(integrity.verified, false);

      assert.equal(semantic.finding, entry.finding);
      assert.deepEqual(semantic.claims, {
        total: 1, assessed: 1, consistent: 0, partial: 0, conflict: 0, ambiguous: 0,
        insufficient: 0, unavailable: 0, not_checked: 0, [entry.bucket]: 1,
      });
      assert.equal(semantic.overstated, 1, 'the unsupported claim is counted as overstated');
      assert.equal(semantic.authorizes, false);

      expectNoticeOutsideModelTurn(out);
      expectAuditHasNoText(stored, [entry.claim, entry.record]);
      assert.equal(stored.cognition.responseIntegrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
      assert.equal(stored.cognition.responseIntegrity.limitations.includes(entry.limitations.at(-1)), true);
    });
  }
});

// ---- response-level consistency ----------------------------------------------------------------

describe('AP-09 §12: contradictions between factual claims are reported at the response level', () => {
  test('two claims of one answer that contradict each other are disclosed and defeat factual support', async () => {
    let recordId = null;
    const out = await run({
      record: 'the deployment was approved',
      query: 'tell me about the deployment',
      build: (id) => {
        recordId = id;
        return block('The deployment was approved. It was not approved.', [
          { text: 'the deployment was approved', evidence: [`ev:memory:${id}`], kind: 'supported' },
          { text: 'the deployment was not approved', evidence: [`ev:memory:${id}`], kind: 'supported' },
        ]);
      },
    });
    const { res, integrity, semantic, stored } = out;
    assert.ok(recordId);

    assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.deepEqual(integrity.limitations, [
      'model_output_unverified', 'semantic_polarity_conflict', 'response_inconsistent',
    ]);
    assert.deepEqual(semantic.claims, {
      total: 2, assessed: 2, consistent: 1, partial: 0, conflict: 1, ambiguous: 0,
      insufficient: 0, unavailable: 0, not_checked: 0,
    });
    assert.deepEqual(semantic.contradictions, [{ a: 0, b: 1, dimension: 'polarity_conflict' }]);
    assert.equal(semantic.overstated, 1);

    expectNoticeOutsideModelTurn({ res, dataDir: out.dataDir });
    assert.match(res.output, /contradict each other/);
    expectAuditHasNoText(stored, ['the deployment was not approved', 'the deployment was approved']);
    assert.deepEqual(stored.cognition.responseIntegrity.semantic.contradictions,
      [{ a: 0, b: 1, dimension: 'polarity_conflict' }]);
  });
});

// ---- availability and the moving window --------------------------------------------------------

describe('AP-09 §12: evidence that cannot be read is never reported as checked and supported', () => {
  test('an unreadable source is reported unavailable, not refuted and not supported', async () => {
    const out = await run({
      record: 'the deployment was approved',
      claim: 'the deployment was approved',
      query: 'tell me about the deployment',
      prepare: async (app, _record, dataDir) => {
        await app.knowledge.add({ subject: 'atlas', relationship: 'has_status', object: 'operational', origin: 'user' });
        fs.writeFileSync(path.join(dataDir, 'knowledge.jsonl'), '{"schema":1,"id":"partial');
      },
    });
    const { integrity, semantic, stored } = out;

    assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.equal(integrity.finding, ResponseFindingKind.UNAVAILABLE);
    assert.deepEqual(integrity.limitations, [
      'model_output_unverified', 'semantic_unavailable', 'evidence_unavailable',
    ]);
    assert.equal(semantic.finding, SemanticFinding.UNAVAILABLE);
    assert.equal(semantic.claims.unavailable, 1);
    assert.equal(semantic.claims.consistent, 0);
    assert.equal(semantic.authorizes, false);

    expectNoticeOutsideModelTurn(out);
    expectAuditHasNoText(stored, ['the deployment was approved']);
    assert.equal(stored.cognition.responseIntegrity.finding, ResponseFindingKind.UNAVAILABLE);
  });

  test('a write during the evidence window makes the answer not_checked', async () => {
    const out = await run({
      record: 'the deployment was approved',
      claim: 'the deployment was approved',
      query: 'tell me about the deployment',
      prepare: (app) => {
        const original = app.knowledge.search.bind(app.knowledge);
        let injected = false;
        app.knowledge.search = async (...args) => {
          const result = await original(...args);
          if (!injected) {
            injected = true;
            await app.memory.add({ content: 'a marker record written during the window', kind: 'user_fact', source: 'user' });
          }
          return result;
        };
      },
    });
    const { integrity, semantic, stored } = out;

    assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.equal(integrity.finding, ResponseFindingKind.NOT_CHECKED);
    assert.deepEqual(integrity.limitations, ['model_output_unverified', 'semantic_not_checked']);
    assert.equal(semantic.finding, SemanticFinding.NOT_CHECKED);
    assert.equal(semantic.claims.not_checked, 1);
    assert.equal(semantic.claims.consistent, 0);

    expectNoticeOutsideModelTurn(out);
    expectAuditHasNoText(stored, ['the deployment was approved']);
    assert.equal(stored.cognition.responseIntegrity.finding, ResponseFindingKind.NOT_CHECKED);
  });

  test('evidence that changes during the model call weakens the answer and keeps it below support', async () => {
    const out = await run({
      record: 'the deployment was approved',
      claim: 'the deployment was approved',
      query: 'tell me about the deployment',
      duringModel: async (app, recordId) => {
        await app.memory.correct({ targetId: recordId, content: 'the deployment was rejected', origin: 'user' });
      },
    });
    const { res, integrity, semantic, stored } = out;

    assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.deepEqual(integrity.limitations, ['model_output_unverified', 'evidence_changed']);
    assert.equal(semantic.finding, SemanticFinding.SEMANTICALLY_CONSISTENT,
      'the wording still matched the record as it stood during retrieval');
    assert.ok(res.operation.cognition.evidenceRecheck.weakened > 0);
    assert.match(res.output, /changed while the answer was being produced/);
    assert.equal(stored.cognition.responseContract.checks
      .find((entry) => entry.check === 'evidence_recheck_is_observation_only').ok, true);
    expectAuditHasNoText(stored, ['the deployment was approved']);
  });
});

// ---- the executive boundary --------------------------------------------------------------------

describe('AP-09 §12: a semantic assessment grants nothing and a model cannot authorize itself', () => {
  test('a self-verification field rejects the structure whole and executes nothing', async () => {
    const out = await run({
      record: 'the deployment was approved',
      claim: 'the deployment was approved',
      answer: 'The deployment was approved.',
      extra: { verified: true },
      query: 'tell me about the deployment',
    });
    const { res, integrity, semantic, stored, dataDir } = out;

    assert.equal(integrity.trust, ResponseTrustState.RECEIVED, 'a rejected structure is only received text');
    assert.equal(integrity.degradation, ResponseDegradation.PRESENT_WITH_LIMITATIONS);
    assert.deepEqual(integrity.limitations, [
      'model_output_unverified', 'plain_answer_unstructured', 'structured_response_rejected',
    ]);
    assert.equal(semantic.finding, null, 'no structured claim was assessed');
    assert.deepEqual(semantic.claims, {
      total: 0, assessed: 0, consistent: 0, partial: 0, conflict: 0, ambiguous: 0,
      insufficient: 0, unavailable: 0, not_checked: 0,
    });
    assert.equal(semantic.authorizes, false);

    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.outcome, Outcome.INPUT_REJECTED);
    assert.match(step.summary, /malformed structured cognition response rejected/);
    assert.equal(step.authorization, null);
    assert.equal(step.execution.status, 'not_run');
    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, 1, 'nothing was written');

    assert.equal(stored.cognition.responseIntegrity.trust, ResponseTrustState.RECEIVED);
    assert.equal(stored.cognition.responseIntegrity.verified, false);
    assert.equal(stored.cognition.responseIntegrity.authorizes, false);
    assert.equal(stored.steps[0].outcome, Outcome.INPUT_REJECTED);
  });

  test('a semantically conflicting answer beside a proposal never authorizes the proposal', async () => {
    const out = await run({
      record: 'the deployment was approved',
      query: 'tell me about the deployment',
      build: (id) => [
        'The deployment was not approved.',
        `COGNITION ${JSON.stringify({
          schema: 1,
          decision: 'answer',
          answer: 'The deployment was not approved.',
          claims: [{ text: 'the deployment was not approved', evidence: [`ev:memory:${id}`], kind: 'supported' }],
        })}`,
        'PROPOSE_ACTION {"action":"memory.add","input":{"content":"the model decided this"}}',
      ].join('\n'),
    });
    const { res, integrity, semantic, stored, dataDir } = out;

    assert.equal(integrity.trust, ResponseTrustState.ACCEPTED_FOR_PRESENTATION);
    assert.deepEqual(integrity.limitations, ['model_output_unverified', 'semantic_polarity_conflict']);
    assert.equal(semantic.finding, SemanticFinding.POLARITY_CONFLICT);
    assert.equal(semantic.authorizes, false);

    assert.equal(res.operation.steps.length, 1);
    const [step] = res.operation.steps;
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
    assert.equal(step.authorization.decision, 'deny');
    assert.equal(step.execution.status, 'not_run');
    assert.equal(step.handoff.authorizes, false);
    assert.notEqual(step.handoff.authorization.owner, 'model');
    assert.equal(readJsonl(path.join(dataDir, 'memory.jsonl')).length, 1, 'the denied proposal wrote nothing');

    assert.equal(res.output.includes(NOTICE), true);
    expectAuditHasNoText(stored, ['the deployment was not approved']);
  });
});
