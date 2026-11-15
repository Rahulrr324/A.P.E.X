// The deterministic capability evaluation: thirteen scenario classes the sprint names, each run
// through the real controller, the live action registry, the real stores and the shipped read
// actions. The fixtures are synthetic and no language model is consulted; the one stub speaks the
// HTTP protocol so the authorization path is exercised as it is in production.
//
// The report is asserted, not just printed: a scenario that stops passing must fail this suite.
// Each metric is counted separately over the scenarios that exercise it, because a request that
// never plans says nothing about planning correctness - the screenshot-style empty pass would
// inflate the number. Nothing here is a real-world intelligence benchmark, and the report says so.
import test, { after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createGateway, ModelGateway, NoBackend } from '../src/model/gateway.js';
import { makeTempDataDir, cleanup, startStubModel } from './helpers.js';
import {
  METRICS, SCENARIO_CLASSES, SCENARIOS,
  runCapabilityEvaluation, summarizeMetrics, renderReport,
} from '../src/evaluation/capability.js';

const dirs = [];
const stubs = [];

afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

// A fresh application per scenario: its own data directory, its own audit and task logs. The
// scenario's `reply` selects the stub so the model-origin path has something to answer with;
// without it the app runs exactly as an offline installation does.
const kit = {
  async fixture({ reply } = {}) {
    const dataDir = makeTempDataDir();
    dirs.push(dataDir);
    let stub = null;
    const gateway = reply === undefined
      ? new ModelGateway({ backend: new NoBackend() })
      : await (async () => {
        stub = await startStubModel();
        stubs.push(stub);
        stub.behavior.reply = reply;
        return createGateway({ url: stub.url, name: 'stub', timeoutMs: 3000, allowRemote: false });
      })();
    const app = await createApp({ dataDir, gateway });
    return { app, dataDir, stub };
  },
};

describe('capability evaluation: thirteen scenario classes through the real controller', () => {
  test('every scenario class is covered exactly once, in the declared order', () => {
    assert.deepEqual(SCENARIOS.map((s) => s.class), SCENARIO_CLASSES);
    assert.equal(new Set(SCENARIO_CLASSES).size, 13);
    for (const scenario of SCENARIOS) {
      assert.match(scenario.id, /^s\d{2}$/);
      assert.ok(scenario.title.length > 0, `${scenario.id} states what it expects`);
      assert.equal(typeof scenario.run, 'function');
    }
  });

  test('all thirteen scenarios pass, and each metric is reported separately', async (t) => {
    const report = await runCapabilityEvaluation(kit);
    t.diagnostic(`\n${renderReport(report)}`);

    const failures = report.results.filter((r) => !r.pass)
      .map((r) => `${r.id} (${r.class}): failed ${r.failed.join(', ')}; actual ${JSON.stringify(r.actual)}`);
    assert.deepEqual(failures, [], `scenario failures:\n${failures.join('\n')}`);
    assert.equal(report.passed, 13);
    assert.equal(report.total, 13);
    assert.deepEqual(report.results.map((r) => r.class), SCENARIO_CLASSES);
    assert.deepEqual(report.results.map((r) => r.id), Array.from({ length: 13 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`));

    // Every metric names its own denominator. A scenario that leaves a metric null is not in it.
    assert.deepEqual(Object.keys(report.metrics), METRICS);
    const expected = {
      task_success: 13,
      planning_correctness: 5,
      evidence_correctness: 12,
      safety_compliance: 13,
      recovery_correctness: 2,
      usability: 13,
    };
    assert.deepEqual(Object.fromEntries(METRICS.map((m) => [m, report.metrics[m].total])), expected);
    for (const metric of METRICS) {
      assert.equal(report.metrics[metric].passed, report.metrics[metric].total, `${metric} did not pass on a scenario that measured it`);
      assert.equal(report.metrics[metric].rate, 1);
    }

    const rendered = renderReport(report);
    assert.match(rendered, /^Capability evaluation: 13 of 13 scenario\(s\) passed\./);
    for (const scenario of SCENARIOS) assert.ok(rendered.includes(`${scenario.id} ${scenario.class}: pass`), `${scenario.id} is not printed`);
    for (const metric of METRICS) {
      const m = report.metrics[metric];
      assert.ok(rendered.includes(`${metric.padEnd(22)} ${m.passed}/${m.total}`), `${metric} is not printed with its own denominator`);
    }
    assert.match(rendered, /Synthetic, deterministic fixtures; this is not a real-world intelligence benchmark\./);
    assert.doesNotMatch(rendered, /\bscore\b|\boverall\b|\bgrade\b/i, 'no combined number is reported');
    assert.doesNotMatch(rendered, /\d+(?:\.\d+)?\s*%/, 'a ratio is not dressed as a percentage');
  });

  test('a metric no scenario exercises is null rather than a pass', () => {
    const summary = summarizeMetrics([
      { checks: { task_success: { ok: true }, usability: { ok: false } } },
      { checks: { task_success: { ok: true } } },
    ]);
    assert.deepEqual(summary.task_success, { passed: 2, total: 2, rate: 1 });
    assert.deepEqual(summary.usability, { passed: 0, total: 1, rate: 0 });
    for (const metric of ['planning_correctness', 'evidence_correctness', 'safety_compliance', 'recovery_correctness']) {
      assert.deepEqual(summary[metric], { passed: 0, total: 0, rate: null }, `${metric} would be an invented pass`);
    }
    const rendered = renderReport({ results: [], metrics: summary, passed: 0, total: 0 });
    assert.match(rendered, /planning_correctness +n\/a/);
  });
});
