// T-15 evaluation framework regressions.
//
// These tests police the framework itself, not APEX: the scenario registry must stay complete and
// valid, a clean return must never become a pass, repeated runs must be compared, and no
// evaluation source may reach an inference system. The replay test pins the fix that made evidence
// identity depend on the record, not on the moment the question was asked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENARIOS, CATEGORIES, scenarioById, selectScenarios,
} from '../eval/index.js';
import {
  DIMENSIONS, validateScenario, runScenario, runEvaluation, summarize, check,
} from '../eval/framework.js';
import { createEvaluationContext } from '../eval/context.js';
import { dataOf } from '../eval/oracles.js';

const EVAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval');

function scenarioFor(id, category, run) {
  return {
    id,
    category,
    title: `test scaffold ${id}`,
    intent: 'exercise the framework, not APEX',
    preconditions: [],
    steps: ['run the scenario body'],
    run,
  };
}

// No state is needed for the framework-semantics tests, so a bare context is enough.
const bareContext = async () => ({ dispose: async () => {} });

function readEvalSources(dir = EVAL_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...readEvalSources(target));
    else if (entry.name.endsWith('.js')) files.push(target);
  }
  return files;
}

describe('T-15 evaluation framework', () => {
  test('the registry holds at least twenty valid scenarios with unique ids', () => {
    assert.ok(SCENARIOS.length >= 20, `expected at least 20 scenarios, found ${SCENARIOS.length}`);
    const ids = new Set();
    for (const scenario of SCENARIOS) {
      validateScenario(scenario);
      assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
      ids.add(scenario.id);
      assert.equal(typeof scenario.run, 'function', `${scenario.id} has no run function`);
    }
    assert.equal(scenarioById(SCENARIOS[0].id), SCENARIOS[0]);
    assert.equal(scenarioById('no-such-scenario'), null);
    assert.deepEqual(selectScenarios({ ids: ['rq-'] }).map((s) => s.id), ['rq-01', 'rq-02', 'rq-03', 'rq-04']);
  });

  test('every area the milestone names has more than one scenario', () => {
    const required = [
      'personal-executive',
      'research-knowledge',
      'planning-execution',
      'situational-awareness',
      'security-trust',
      'long-duration',
      'reasoning-quality',
    ];
    assert.deepEqual([...CATEGORIES].sort(), [...required].sort());
    for (const category of required) {
      const rows = SCENARIOS.filter((scenario) => scenario.category === category);
      assert.ok(rows.length >= 2, `${category} has only ${rows.length} scenario(s)`);
    }
    // The reasoning-quality set is the blind part of the suite: its checks were written against
    // the documented session result, not against the code that produces it.
    const blind = SCENARIOS.filter((scenario) => scenario.blind === true);
    assert.ok(blind.length >= 4, `expected at least 4 blind scenarios, found ${blind.length}`);
    assert.deepEqual(blind.map((scenario) => scenario.id).sort(), ['rq-01', 'rq-02', 'rq-03', 'rq-04']);
    assert.equal(summarize([]).blindResults.blind, 0);
  });

  test('a clean return is not a pass and an unasserted outcome is invalid', async () => {
    const silent = await runScenario(
      scenarioFor('x-silent', 'test', async () => ({ checks: {} })),
      { makeContext: bareContext },
    );
    assert.equal(silent.pass, false);
    assert.equal(silent.failureClass, 'invalid_scenario');
    assert.deepEqual(silent.failedDimensions, []);

    // A UX-only assertion cannot carry a pass: a readable answer that never says whether the task
    // succeeded would otherwise count as success.
    const uxOnly = await runScenario(
      scenarioFor('x-ux', 'test', async () => ({ checks: { ux: check(true, 'readable', 'readable') } })),
      { makeContext: bareContext },
    );
    assert.equal(uxOnly.pass, false);
    assert.equal(uxOnly.failureClass, 'invalid_scenario');

    const wrong = await runScenario(
      scenarioFor('x-wrong', 'test', async () => ({ checks: { correctness: check(false, 'stored', 'absent') } })),
      { makeContext: bareContext },
    );
    assert.equal(wrong.pass, false);
    assert.equal(wrong.failureClass, 'wrong_outcome');
    assert.deepEqual(wrong.failedDimensions, ['correctness']);
  });

  test('repeated runs are compared by signature and a disagreement is not reproducible', async () => {
    const stable = await runEvaluation({
      scenarios: [scenarioFor('x-stable', 'test', async () => ({ checks: { correctness: check(true, 'ok', 'ok') } }))],
      makeContext: bareContext,
      repeat: 2,
    });
    assert.equal(stable.results[0].pass, true);
    assert.equal(stable.results[0].reproducible, true);
    assert.equal(stable.summary.reproducibility.reproducible, 1);

    // Alternates between pass and fail on identical fixtures. The first run passed, but the
    // disagreement makes the result unusable: it is reported as oracle_disagreement, not a pass.
    let calls = 0;
    const flaky = await runEvaluation({
      scenarios: [scenarioFor('x-flaky', 'test', async () => {
        calls += 1;
        return { checks: { correctness: check(calls % 2 === 1, 'stable', `call ${calls}`) } };
      })],
      makeContext: bareContext,
      repeat: 2,
    });
    assert.equal(flaky.results[0].reproducible, false);
    assert.equal(flaky.results[0].pass, false);
    assert.equal(flaky.results[0].failureClass, 'oracle_disagreement');
    assert.deepEqual(flaky.results[0].failedDimensions, DIMENSIONS);
  });

  test('no evaluation source can reach an inference system', () => {
    const forbidden = [
      { label: 'an HTTP/TCP client import', pattern: /from\s+['"]node:(?:http|https|http2|net|tls|dgram)['"]/ },
      { label: 'a fetch call', pattern: /\bfetch\s*\(/ },
      { label: 'an inference product name', pattern: /\b(?:ollama|llama(?:\.cpp)?|lm[-\s]?studio|lmstudio)\b/i },
      { label: 'a remote endpoint literal', pattern: /\b(?:openai|api\.anthropic)\b/i },
    ];
    const files = readEvalSources();
    assert.ok(files.length >= 5, 'the evaluation sources were not found');
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { label, pattern } of forbidden) {
        assert.ok(!pattern.test(text), `${path.relative(EVAL_DIR, file)} contains ${label}`);
      }
    }
  });

  test('the default gateway is the no-backend stub, so a scenario cannot infer', async () => {
    const ctx = await createEvaluationContext({ scenario: { id: 'x-gateway', category: 'test' } });
    try {
      const description = ctx.gateway().describe();
      assert.equal(description.provider, 'none');
      assert.equal(description.configured, false);
      assert.equal(description.endpoint, null);
      assert.equal(ctx.gateway().isConfigured(), false);
      const health = await ctx.gateway().backend.health();
      assert.equal(health.available, false);
    } finally {
      await ctx.dispose();
    }
  });

  test('advancing the clock by a minute does not change evidence identity or the digest', async () => {
    // The evidence digest is computed from the evidence ids, and an id names the source record.
    // If an id carried the query time, the same question asked a minute later would produce a
    // different digest and the session could never be replayed against unchanged records.
    const ctx = await createEvaluationContext({ scenario: { id: 'x-replay', category: 'test' } });
    try {
      await ctx.say('remember that the Atlas database is PostgreSQL');

      const snapshot = async () => {
        const command = await ctx.act('reasoningStart', { request: 'Which database does Atlas use?' });
        const session = dataOf(command)?.session ?? {};
        return {
          status: command.status,
          at: session.at ?? null,
          digest: session.evidence?.digest ?? null,
          ids: (session.evidence?.items ?? []).map((item) => item.evidenceId).sort(),
          classification: session.conclusion?.classification ?? null,
        };
      };

      const before = await snapshot();
      ctx.advance(60_000);
      const after = await snapshot();

      assert.equal(before.status, 'success_verified');
      assert.ok(before.digest !== null, 'the session reported no evidence digest');
      assert.deepEqual(after.ids, before.ids, 'evidence identity changed when the question was asked a minute later');
      assert.equal(after.digest, before.digest, 'the evidence digest changed with the query clock');
      assert.equal(after.classification, before.classification);
      assert.notEqual(after.at, before.at, 'the fixture clock did not advance, so the replay check proves nothing');
    } finally {
      await ctx.dispose();
    }
  });

  test('a content-derived evidence id still satisfies the evidence-reference grammar', async () => {
    // The temporal summary is derived, so its id follows its content rather than the query clock.
    // The first form of that fix joined pattern keys with a separator the evidence-reference
    // grammar does not allow, so every later stage that validates a reference rejected the whole
    // analysis. The id must be stable and well-formed at the same time.
    const ctx = await createEvaluationContext({ scenario: { id: 'x-ids', category: 'test' } });
    try {
      for (const request of [
        'remember that the first report was late because of: put the date at the top',
        'remember that the second report was late because of: put the date at the top',
      ]) {
        const res = await ctx.say(request);
        await ctx.act('experienceRecord', { operationId: res.operation.id, subject: 'what APEX did here' });
        const [record] = await ctx.app.experience.list({ limit: 1 });
        await ctx.act('feedbackRecord', { target: record.id, assessment: 'incorrect', guidance: 'put the date at the top' });
      }
      const command = await ctx.act('reasoningStart', { request: 'What went wrong with the reports?' });
      const session = dataOf(command)?.session ?? {};
      const ids = (session.evidence?.items ?? []).map((item) => item.evidenceId);
      assert.ok(ids.some((id) => id.startsWith('ev:temporal:summary:')), 'the fixture produced no derived temporal summary to check');
      for (const id of ids) {
        assert.match(id, /^ev:[a-z_]+:[A-Za-z0-9_.:-]{1,200}$/, `evidence id is outside the reference grammar: ${id}`);
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('one registered scenario runs through the real fixture and passes', async () => {
    const scenario = scenarioById('pe-01');
    assert.ok(scenario, 'pe-01 is missing from the registry');
    const result = await runScenario(scenario, {
      makeContext: (selected) => createEvaluationContext({ scenario: selected }),
    });
    assert.equal(result.pass, true, `${result.failureClass}: ${result.actual}`);
    assert.ok(result.checks.correctness, 'the scenario asserted no correctness dimension');
    assert.ok(result.trace.length >= 2, 'the execution trace was not recorded');
  });
});
