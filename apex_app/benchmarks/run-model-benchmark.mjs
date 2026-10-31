// Bounded local-model benchmark through the ordinary APEX application path.
//
// It measures the controller (prompt build, gateway call, audit write, conversation
// turns), not raw HTTP, so the numbers include APEX's own overhead. It never changes
// production defaults and never runs under `npm test`.
//
//   APEX_BENCH_LIVE=1 APEX_MODEL_PROVIDER=ollama APEX_MODEL_URL=http://127.0.0.1:11434 \
//   APEX_MODEL_NAME=<installed-model> APEX_MODEL_TIMEOUT_MS=300000 APEX_MODEL_MAX_TOKENS=1200 \
//   APEX_MODEL_RETRIES=0 node benchmarks/run-model-benchmark.mjs --requests 4 --keep
//
// Without APEX_BENCH_LIVE=1 it prints the plan and exits 0: no request is sent.
//
// Bounds: at most 4 inference requests per run (one cold-plan + three warm-plan),
// prompts are fixed and non-sensitive, and all state is written to a fresh temporary
// directory that is removed unless --keep is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppFromEnv } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const MAX_REQUESTS = 4;
const READINESS_TIMEOUT_MS = 5000;

// Fixed, non-sensitive prompts. None asks for an action, a file, memory, or a write.
export const PROMPTS = {
  factual: 'In one short sentence, what is the capital of France?',
  summary: 'Summarize in one sentence: The library opens at nine and closes at six on weekdays.',
  arithmetic: 'What is 17 + 25? Answer with the number only.',
  concise: 'Answer in one word: what color is a clear daytime sky?',
};
const PROMPT_ORDER = ['factual', 'summary', 'arithmetic', 'concise'];

function parseArgs(argv) {
  const opts = { requests: MAX_REQUESTS, prompt: 'factual', out: null, keep: false, planOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--plan-only') { opts.planOnly = true; continue; }
    if (arg === '--keep') { opts.keep = true; continue; }
    if (arg === '--out') { opts.out = argv[++i] ?? null; continue; }
    if (arg === '--requests') { opts.requests = Number(argv[++i]); continue; }
    if (arg === '--prompt') { opts.prompt = argv[++i]; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.requests) || opts.requests < 1 || opts.requests > MAX_REQUESTS) {
    throw new Error(`--requests must be a whole number from 1 to ${MAX_REQUESTS}`);
  }
  if (!PROMPT_ORDER.includes(opts.prompt)) {
    throw new Error(`--prompt must be one of: ${PROMPT_ORDER.join(', ')}`);
  }
  return opts;
}

function usage() {
  return [
    'usage: APEX_BENCH_LIVE=1 node benchmarks/run-model-benchmark.mjs [options]',
    '',
    '  --prompt <name>   fixed prompt to send: ' + PROMPT_ORDER.join(', ') + ' (default: factual)',
    `  --requests <n>    inference requests, 1-${MAX_REQUESTS} (default: ${MAX_REQUESTS})`,
    '  --out <file>      also write the JSON result to this file',
    '  --keep            keep the temporary APEX data directory',
    '  --plan-only       print the plan without loading the application',
    '',
    'Requires APEX_BENCH_LIVE=1 and a configured loopback model endpoint.',
  ].join('\n');
}

// A benchmark must never reach a remote provider, even if APEX_ALLOW_REMOTE_MODEL is set.
function isLoopback(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function classify(status, output, errors) {
  const codes = errors.map((e) => e.code);
  if (status === 'verification_unavailable' && typeof output === 'string' && output.trim().length > 0) {
    return codes.includes('TRUNCATED') ? 'truncated_success' : 'success';
  }
  if (codes.includes('TIMEOUT')) return 'timeout';
  if (codes.includes('EMPTY_RESPONSE')) return 'empty_response';
  if (codes.some((c) => ['MALFORMED_RESPONSE', 'RESPONSE_TOO_LARGE', 'CONTEXT_TOO_LARGE'].includes(c))) return 'bad_response';
  if (codes.length > 0) return 'provider_error';
  return 'other';
}

function plan(opts, model) {
  return {
    kind: 'apex-model-benchmark-plan',
    live: false,
    prompt: { name: opts.prompt, text: PROMPTS[opts.prompt] },
    requests: opts.requests,
    requestSemantics: opts.requests > 1
      ? ['cold-planned: sample 1 (first request against a freshly started server)', `warm-planned: samples 2-${opts.requests}`]
      : ['single request'],
    measurements: [
      'readiness/list latency (no inference)',
      'total application-path latency per request',
      'generated token count and throughput when the backend reports them',
      'result classification (success, truncated, empty, timeout, provider error)',
      'verification status and whether any action was proposed or executed',
    ],
    notMeasured: ['time to first token (the transport is non-streaming)'],
    model,
    cleanup: 'fresh temporary APEX data directory; removed unless --keep',
    warnings: [
      'Planned cold/warm labels are defined by request order, not by a measured model load.',
      'A few samples describe this machine at this time; they are not a reliable benchmark.',
    ],
  };
}

function requestRecord(sample, result, wallMs) {
  const op = result.operation ?? {};
  const model = op.model ?? null;
  const usage = model?.usage ?? null;
  const timings = model?.timings ?? null;
  const errors = Array.isArray(op.errors) ? op.errors : [];
  const steps = Array.isArray(op.steps) ? op.steps : [];
  const tokens = usage?.completionTokens ?? null;
  const evalMs = timings?.evalMs ?? null;
  return {
    sample,
    wallMs,
    status: result.status ?? null,
    decision: result.decision ?? null,
    classification: classify(result.status, result.output, errors),
    recorded: result.recorded ?? null,
    answerChars: typeof result.output === 'string' ? result.output.length : 0,
    operationId: op.id ?? null,
    capability: op.capability ?? null,
    backend: op.backend ?? null,
    model: model ? { name: model.name ?? null, provider: model.provider ?? null, finishReason: model.finishReason ?? null } : null,
    latencyMs: model?.latencyMs ?? null,
    tokens,
    throughputTokensPerSecond: tokens !== null && evalMs ? Number((tokens / (evalMs / 1000)).toFixed(2)) : null,
    promptTokens: usage?.promptTokens ?? null,
    timeToFirstTokenMs: null,
    timeToFirstTokenUnavailable: 'non-streaming transport: the interface receives the whole answer at once',
    errors: errors.map((e) => ({ stage: e.stage ?? null, code: e.code ?? null })),
    steps: steps.length,
    executedSteps: steps.filter((s) => s?.execution?.status && s.execution.status !== 'not_run').length,
    verified: result.status === 'success_verified',
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(usage());
    return;
  }

  const live = process.env.APEX_BENCH_LIVE === '1';
  // A live run always writes to a fresh temporary directory, even if APEX_DATA_DIR is
  // set, so a benchmark cannot add records to the operator's real store.
  const tempDir = live && !opts.planOnly ? fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bench-')) : null;
  // Configuration is read before the plan is printed, so an invalid setting is named
  // instead of producing a plan that cannot run.
  let config = null;
  let model = null;
  try {
    config = loadConfig(process.env);
    model = {
      name: config.model.name,
      provider: config.model.provider,
      configured: Boolean(config.model.url),
      endpoint: config.model.url,
    };
  } catch (err) {
    console.error(`configuration error: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (!live || opts.planOnly) {
    console.log(JSON.stringify(plan(opts, model), null, 2));
    if (!live) console.error('not live: set APEX_BENCH_LIVE=1 to send requests');
    return;
  }

  if (!model.configured) {
    console.error('no model configured: set APEX_MODEL_URL (and APEX_MODEL_NAME for Ollama)');
    process.exitCode = 2;
    return;
  }
  if (!isLoopback(model.endpoint)) {
    console.error('refusing a non-loopback model endpoint');
    process.exitCode = 2;
    return;
  }

  const dataDir = tempDir;
  const result = {
    kind: 'apex-model-benchmark',
    startedAt: new Date().toISOString(),
    prompt: { name: opts.prompt, text: PROMPTS[opts.prompt] },
    settings: {
      provider: model.provider,
      endpoint: model.endpoint,
      model: model.name,
      maxTokens: config.model.maxTokens,
      timeoutMs: config.model.timeoutMs,
      retries: config.model.retries,
      contextTurns: config.contextTurns,
    },
    dataDir,
    readiness: null,
    samples: [],
    notes: [],
  };

  const promptText = PROMPTS[opts.prompt];
  let readinessApp = null;
  for (let i = 1; i <= opts.requests; i += 1) {
    // Each request gets its own store directory, so every prompt is sent with the same
    // (empty) conversation context and one sample cannot change another's prompt size.
    const sampleDir = path.join(dataDir, `sample-${i}`);
    let app;
    try {
      app = createAppFromEnv({ ...process.env, APEX_DATA_DIR: sampleDir });
    } catch (err) {
      result.samples.push({ sample: i, wallMs: null, status: null, classification: 'configuration_error', error: err.code ?? null });
      break;
    }
    if (!readinessApp) {
      readinessApp = app;
      const readyStart = Date.now();
      result.readiness = await app.gateway.checkAvailability({ timeoutMs: READINESS_TIMEOUT_MS });
      result.readiness.wallMs = Date.now() - readyStart;
      result.readiness.isInference = false;
    }
    const started = Date.now();
    let res;
    try {
      res = await app.controller.handle(promptText, { origin: 'user', saveAnswer: false });
    } catch (err) {
      result.samples.push({ sample: i, wallMs: Date.now() - started, status: null, classification: 'controller_error', error: err.code ?? null });
      break;
    }
    result.samples.push(requestRecord(i, res, Date.now() - started));
    console.error(`sample ${i}/${opts.requests}: ${result.samples.at(-1).classification} in ${result.samples.at(-1).wallMs} ms`);
  }

  const samples = result.samples.filter((s) => typeof s.wallMs === 'number');
  const cold = samples[0] ?? null;
  const warm = samples.slice(1);
  result.summary = {
    sampleCount: samples.length,
    succeeded: samples.filter((s) => s.classification === 'success').length,
    failed: samples.filter((s) => !['success'].includes(s.classification)).length,
    coldWallMs: cold?.wallMs ?? null,
    warmWallMs: warm.map((s) => s.wallMs),
    warmMeanWallMs: warm.length > 0 ? Math.round(warm.reduce((a, s) => a + s.wallMs, 0) / warm.length) : null,
    anyActionProposed: samples.some((s) => s.steps > 0),
    anyActionExecuted: samples.some((s) => s.executedSteps > 0),
    allAnswersUnverified: samples.every((s) => s.verified === false),
    stateChangingRequests: samples.some((s) => s.capability !== 'model.answer'),
  };
  result.measurementNotes = [
    'Cold/warm labels come from request order only; model load time was not measured directly.',
    'Throughput is reported only when the backend supplies both a completion token count and an evaluation duration.',
    'Time to first token is unavailable because the gateway receives non-streaming responses.',
    `Actual sample count: ${samples.length}. These are observations on one machine, not a statistically reliable benchmark.`,
  ];
  result.endedAt = new Date().toISOString();

  if (!opts.keep) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      result.cleanup = 'temporary data directory removed';
    } catch (err) {
      result.cleanup = `temporary data directory could not be removed: ${err.message}`;
    }
  } else {
    result.cleanup = 'temporary data directory kept';
  }

  const json = JSON.stringify(result, null, 2);
  console.log(json);
  if (opts.out) fs.writeFileSync(opts.out, json);
  if (result.summary.failed > 0 || result.samples.length !== opts.requests) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`benchmark failed: ${err.code || err.message}`);
  process.exitCode = 1;
});
