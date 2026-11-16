// Implementation 107: the documents a user reads first must separate what is implemented
// from what is stub-tested, what was actually measured against a real model, and what is
// only proposed. These tests pin those distinctions in the README and in the CLI's own
// output, and reject the false claims that would turn a passing suite into "APEX is done".
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, makeTempDataDir, cleanup, cleanEnv, runCli, closedPortUrl } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

const APP_README = fs.readFileSync(path.join(APP_ROOT, 'README.md'), 'utf8');
const ROOT_README = fs.readFileSync(path.join(APP_ROOT, '..', 'README.md'), 'utf8');

// Text that would assert more than the evidence supports. Checked case-insensitively.
const OVERCLAIMS = [
  /\bAPEX (?:is|has been) (?:complete|fully implemented)\b/i,
  /\ball capabilities (?:are )?implemented\b/i,
  /\breal[- ]model (?:validation|testing) (?:is )?(?:complete|passed)\b/i,
  /\bverified against a real model\b/i,
  /\bno known limitations\b/i,
  /\bproduction[- ]ready\b/i,
];

describe('107: capability statements match the evidence', () => {
  test('the application README separates implemented, stub-tested, real-model-tested, and proposed work', () => {
    assert.match(APP_README, /^## Capability status$/m);
    for (const row of [
      'Runnable application',
      'Deterministic capabilities (no model)',
      'Model gateway protocol handling',
      'Real-model behaviour',
      '`stark/` research tree',
      'Neural integration',
    ]) {
      assert.ok(APP_README.includes(row), `capability table is missing the "${row}" row`);
    }
    assert.match(APP_README, /Stub tests prove protocol handling, not answer quality, and no test in `npm test` runs a real model\./);
    assert.match(APP_README, /\*\*Observed outside the automated suite\*\*/);
    assert.match(APP_README, /Every answer was reported as unverified\./);
    assert.match(APP_README, /Neural integration \| \*\*Contract implemented, no runtime connected\.\*\*/);
    assert.match(APP_README, /No child process, HTTP endpoint, model, or `stark\/` import exists, and nothing is inferred\./);
    assert.match(APP_README, /World Model, entity memory and evidence graph \| Implemented as an append-only `world-model\.jsonl` of user-origin records/);
    assert.match(APP_README, /General planner, persistent learning, voice \| \*\*Not implemented\.\*\*/);
    // The loopback page is an implemented surface and must be described as one, with its bound.
    assert.match(APP_README, /Local browser interface \| Implemented as a loopback-only, zero-dependency HTTP server/);
    assert.match(APP_README, /It binds `127\.0\.0\.1` only, requires a process-random token/);
    assert.match(APP_README, /It is a single-user local surface, not a hosted service/);
    assert.match(APP_README, /### Historical record: the controlled real-model run of 2026-10-31/);
    assert.match(APP_README, /This is a dated observation of one run, \*\*not a setup instruction\*\*\./);
    assert.match(APP_README, /one bounded `ask` completed in about 105 s and was reported as unverified\./);
    // The detailed model section keeps the same distinction.
    assert.match(APP_README, /no test in this repository runs a real model/);
    // Batch AA: the README documents an endpoint the reader already configured; it must not
    // turn into an instruction to install, download, start, or pull in a local inference server.
    assert.match(APP_README, /^## Optional: a model endpoint you configure$/m);
    assert.match(APP_README, /APEX does not install, download, start, or recommend a model server/);
    for (const pattern of [/ollama pull/i, /llama-server/i, /LM Studio/i, /\bollama serve\b(?!r)/i, /install(?:ing)? ollama/i]) {
      assert.doesNotMatch(APP_README, pattern, `active setup guidance must not point at a local inference server: ${pattern}`);
    }
  });

  test('neither README makes an unqualified completion or real-model validation claim', () => {
    for (const [name, text] of [['apex_app/README.md', APP_README], ['README.md', ROOT_README]]) {
      for (const pattern of OVERCLAIMS) {
        assert.doesNotMatch(text, pattern, `${name} contains an unsupported claim: ${pattern}`);
      }
    }
  });

  test('the root README no longer says there is no assistant application, and keeps the historical gate state', () => {
    assert.doesNotMatch(ROOT_README, /There is no personal APEX assistant application yet/);
    assert.match(ROOT_README, /APEX Local Alpha/);
    assert.match(ROOT_README, /\[`apex_app\/`\]\(apex_app\/README\.md\)/);
    assert.match(ROOT_README, /It has a persistent World\s+Model, but there is still no general-purpose planner, no persistent learning, no voice, and no\s+hosted or multi-user interface - only the loopback-only page it documents for this machine - and\s+no implemented neural–cognitive bridge/);
    assert.match(ROOT_README, /does not import it/);
    // The recorded research gates are preserved, not rewritten by this documentation change.
    assert.match(ROOT_README, /G7 FAIL \/ M0 FAIL \(NOT ACCEPTED\) \/ M1 LOCKED/);
  });

  test('CLI help states the same boundaries: no inference from probes, no model bundled, model output is not authorization', async () => {
    const dir = tempDir();
    const res = await runCli(['help'], envFor(dir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = res.stdout + res.stderr;
    assert.match(text, /--model probes the endpoint; no inference/);
    assert.match(text, /Model output is never authorization\./);
    assert.match(text, /A model answer is unverified/);
    assert.match(text, /repair locks/);
    assert.match(text, /queue\s+deferred task summaries and their state \(read-only\)/);
    assert.match(text, /Filesystem inspection is available only when APEX_FILESYSTEM_ROOT is set/);
    assert.doesNotMatch(text, /\bAPEX (?:is|has been) (?:complete|fully implemented)\b/i);
    assert.doesNotMatch(text, /real[- ]model validation (?:is )?(?:complete|passed)/i);
  });

  test('diagnostics report an unprobed model as not checked, and a probe as a model-list read with no inference', async () => {
    const dir = tempDir();
    const url = await closedPortUrl();

    const unprobed = await runCli(['diagnose'], envFor(dir, { APEX_MODEL_URL: url }));
    assert.equal(unprobed.code, 0, unprobed.stdout + unprobed.stderr);
    assert.match(unprobed.stdout, /Model: not checked \(configured at .*run "apex diagnose --model" to probe it\)/);
    assert.doesNotMatch(unprobed.stdout, /Model: ok/);
    assert.match(unprobed.stdout, /Remote synchronization: not checked/);

    const probed = await runCli(['diagnose', '--model'], envFor(dir, { APEX_MODEL_URL: url }));
    assert.equal(probed.code, 1, probed.stdout + probed.stderr);
    assert.match(probed.stdout, /Model: unavailable/);
    assert.match(probed.stdout, /no inference (?:was run|was tested)/);
    assert.doesNotMatch(probed.stdout, /Model: ok/);
  });

  test('status without a probe does not call a configured model available', async () => {
    const dir = tempDir();
    const res = await runCli(['status'], envFor(dir, { APEX_MODEL_URL: await closedPortUrl() }));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Model backend: .* connectivity not checked \(run "status --model"\)/);
    assert.doesNotMatch(res.stdout, /Model backend: .* - available/);
  });
});
