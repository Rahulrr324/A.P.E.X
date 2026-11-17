// Real-process T-16 operational measurements (§8).
//
// Every figure below is measured by driving the installed application: each command is a real
// `bin/apex.js` child process against an isolated data directory and content root, and the runtime
// is a real foreground process whose memory is read from the operating system. Nothing is called
// in-process, so the numbers include process start, file-system reads, locking and persistence.
//
// Measured: one-shot CLI startup, runtime readiness, effective tick interval, checkpoint backlog,
// resident memory, shutdown from another process, provider event processing, cold and unchanged
// document ingestion, document search and answer retrieval, one reasoning session, storage growth,
// and recovery after the runtime process is killed without warning.
//
// Nothing here is a target. Conditions are compared only within the run; no remembered figure from
// an earlier run is compared against. No inference is used or authorized: every child environment
// drops every APEX_* variable, and no model backend, endpoint or socket is configured or contacted.
//
// Isolation: data and content roots are created with mkdtemp under the OS temporary directory with
// the `apex-bench-t16-` prefix, and cleanup refuses any path outside that root or without that
// prefix. APEX_DATA_ISOLATED must be unset or 1; any other value is refused.
//
// Do not run this benchmark at the same time as the test suite, or as another benchmark.
// Nothing here is part of `npm test`.
//
//   node benchmarks/run-t16-operational.mjs [--docs 150] [--provider-files 50] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { pilotEnv, processMemoryBytes } from '../pilot/harness.js';
import { SituationStore } from '../src/situational/store.js';
import { SituationService } from '../src/situational/service.js';
import { fingerprintOf } from '../src/situational/model.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DIR_PREFIX = 'apex-bench-t16-';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(APP_ROOT, 'bin', 'apex.js');
const TICK_INTERVAL = 100;
const TICK_SAMPLES = 6;

const isolation = (process.env.APEX_DATA_ISOLATED ?? '').trim();
if (isolation !== '' && isolation !== '1') {
  throw new Error(`APEX_DATA_ISOLATED must be unset or 1, not ${JSON.stringify(isolation)}`);
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const DOCS = Number(arg('docs', 150));
const PROVIDER_FILES = Number(arg('provider-files', 50));
const PRIOR_SITUATIONAL_ROWS = Number(arg('prior-situational-rows', 0));
for (const [label, value] of [['docs', DOCS], ['provider-files', PROVIDER_FILES]]) {
  if (!Number.isInteger(value) || value < 1 || value > 2000) throw new Error(`--${label} must be an integer from 1 to 2000`);
}
if (!Number.isInteger(PRIOR_SITUATIONAL_ROWS) || PRIOR_SITUATIONAL_ROWS < 0 || PRIOR_SITUATIONAL_ROWS % 2 !== 0) {
  throw new Error('--prior-situational-rows must be a non-negative even integer');
}
const keep = process.argv.includes('--keep');

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => (n === null || n === undefined ? 'n/a' : `${(Math.round(n * 1000) / 1000).toFixed(3)}`);
const mib = (n) => (n === null || n === undefined ? 'n/a' : `${(n / (1024 ** 2)).toFixed(1)} MiB`);
const ratio = (a, b) => (b > 0 ? `${(a / b).toFixed(2)}x` : 'n/a');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const dirs = [];
const checks = [];
function check(ok, message) {
  checks.push({ ok: Boolean(ok), message });
  if (!ok) console.log(`  FAIL ${message}`);
}

function makeRoot(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${DIR_PREFIX}${label}-`));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${TMP_ROOT}${path.sep}`) || !path.basename(resolved).startsWith(DIR_PREFIX)) {
    throw new Error(`refusing to remove ${resolved}: not a ${DIR_PREFIX} directory under the temp root`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

const root = makeRoot('run');
const dataDir = path.join(root, 'data');
const filesDir = path.join(root, 'files');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(filesDir, { recursive: true });

const env = pilotEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: filesDir });

function bytesIn(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += bytesIn(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function run(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [BIN, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ args, code, signal, timedOut, ms: performance.now() - started, stdout, stderr });
    });
  });
}

function startRuntime(label) {
  const child = spawn(process.execPath, [BIN, 'runtime', 'start', '--interval', String(TICK_INTERVAL)], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = performance.now();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() }));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not reach readiness: ${stdout}${stderr}`)), 60000);
    const scan = () => {
      if (/ms cycle\./.test(stdout)) {
        clearTimeout(timer);
        resolve(performance.now() - started);
      }
    };
    child.stdout.on('data', scan);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited ${code}: ${stdout}${stderr}`)); });
    scan();
  });
  return { child, pid: child.pid, stdout: () => stdout, exited, ready };
}

function parseStatus(text) {
  const head = /is (running|stopped|starting|stopping) \| boot (\d+) \| ticks (\d+)/.exec(text);
  const checkpoint = /checkpoint: (\d+)\/(\d+) processed, (\d+)\/(\d+) published \| backlog (\d+)/.exec(text);
  const interval = /interval (\d+) ms/.exec(text);
  return {
    lifecycle: head?.[1] ?? null,
    boot: head ? Number(head[2]) : null,
    ticks: head ? Number(head[3]) : null,
    backlog: checkpoint ? Number(checkpoint[5]) : null,
    intervalMs: interval ? Number(interval[1]) : null,
    id: /^Runtime ([0-9a-f-]{36})/.exec(text)?.[1] ?? null,
  };
}

function parseIngest(text) {
  const match = /Document ingest: (\d+) indexed, (\d+) changed, (\d+) duplicate, (\d+) failed, (\d+) deleted of (\d+) observed/.exec(text);
  return match ? {
    indexed: Number(match[1]), changed: Number(match[2]), duplicates: Number(match[3]),
    failed: Number(match[4]), deleted: Number(match[5]), observed: Number(match[6]),
  } : null;
}

function parsePoll(text) {
  const match = /polled in (\d+) ms: (\d+) accepted, (\d+) duplicate, (\d+) refused of (\d+) observation/.exec(text);
  return match ? {
    reportedMs: Number(match[1]), accepted: Number(match[2]), duplicates: Number(match[3]),
    refused: Number(match[4]), observed: Number(match[5]),
  } : null;
}

const sleep = (msValue) => new Promise((resolve) => setTimeout(resolve, msValue));
const storage = [];

// Fixture setup only: a structurally valid prior situational log, written from one real
// event/assessment pair with fresh ids and a recomputed fingerprint. The measured ingest below is
// a real CLI process and pays only the reads, extraction and appends it is measuring.
async function seedSituational(dataDirPath, rows) {
  if (rows === 0) return;
  const at = '2026-01-05T09:00:00.000Z';
  const seedRoot = makeRoot('seed');
  const store = new SituationStore(path.join(seedRoot, 'template.jsonl'), { now: () => new Date(at) });
  const service = new SituationService({ store, now: () => new Date(at) });
  await service.ingest({
    source: 'user', sourceEventId: 'template', type: 'observation', category: 'observation',
    payload: { summary: 'template observation' }, confidence: 0.8,
    entityRefs: [], goalRefs: [], planRefs: [], taskRefs: [],
  });
  const [event, assessment] = fs.readFileSync(store.filePath, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const uuid = (prefix, i) => `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const lines = [];
  for (let i = 0; i < rows / 2; i += 1) {
    const eventId = uuid('2a000000', i);
    const payload = { ...event.payload, summary: `seeded observation ${i}` };
    const fingerprint = fingerprintOf(payload);
    lines.push(JSON.stringify({
      ...event, id: eventId, sourceEventId: `seeded-${i}`, observedAt: at, ingestedAt: at,
      payload, fingerprint, integrity: { ...event.integrity, digest: fingerprint }, at,
    }));
    lines.push(JSON.stringify({
      ...assessment, id: uuid('3b000000', i), assessmentId: uuid('3b000000', i), eventId, at,
    }));
  }
  fs.writeFileSync(path.join(dataDirPath, 'situational.jsonl'), `${lines.join('\n')}\n`);
}

// 1. One-shot CLI startup.
console.log('process startup, one-shot CLI (real child process, isolated data directory)');
const startup = [];
for (let i = 0; i < 3; i += 1) {
  const result = await run(['status']);
  startup.push(result.ms);
  check(result.code === 0, `status run ${i + 1} exited ${result.code}`);
}
console.log(`  ${pad('samples', 16)}${startup.map((value) => `${ms(value)} ms`).join(' / ')}`);
console.log(`  ${pad('median', 16)}${ms(median(startup))} ms`);
console.log('');

// 2. Sustained runtime: readiness, ticks, backlog, memory, shutdown.
console.log(`sustained runtime, interval ${TICK_INTERVAL} ms (foreground process, sampled by separate CLI processes)`);
const runtime = startRuntime('runtime start');
const readyMs = await runtime.ready;
await sleep(TICK_INTERVAL * 5);
const memoryEarly = await processMemoryBytes(runtime.pid);
const samples = [];
const sampleWall = [];
for (let i = 0; i < TICK_SAMPLES; i += 1) {
  const at = performance.now();
  const status = await run(['runtime', 'status']);
  samples.push(parseStatus(status.stdout));
  sampleWall.push(at);
  check(status.code === 0, `runtime status sample ${i + 1} exited ${status.code}`);
  await sleep(400);
}
const memoryLate = await processMemoryBytes(runtime.pid);
const storageAfterTicks = bytesIn(dataDir);
storage.push({ phase: 'runtime ticks', bytes: storageAfterTicks });

const ticks = samples.map((sample) => sample.ticks ?? 0);
const tickDelta = ticks[ticks.length - 1] - ticks[0];
const wallDelta = sampleWall[sampleWall.length - 1] - sampleWall[0];
const effectiveTickMs = tickDelta > 0 ? wallDelta / tickDelta : null;
const maxBacklog = Math.max(...samples.map((sample) => sample.backlog ?? 0));
check(samples.every((sample) => sample.lifecycle === 'running'), 'the runtime did not report running in every sample');
check(tickDelta >= 10, `only ${tickDelta} ticks were observed across ${TICK_SAMPLES} samples`);
check(maxBacklog === 0, `checkpoint backlog reached ${maxBacklog}`);

const stopStarted = performance.now();
const stopped = await run(['runtime', 'stop', '--reason', 'T-16 operational measurement finished']);
const stopMs = performance.now() - stopStarted;
const exitInfo = await runtime.exited;
check(stopped.code === 0, `runtime stop exited ${stopped.code}`);
check(exitInfo.code === 0, `the foreground runtime exited ${exitInfo.code ?? exitInfo.signal}`);
const stopLatency = exitInfo.at - stopStarted;

console.log(`  ${pad('readiness (marker)', 28)}${ms(readyMs)} ms`);
console.log(`  ${pad('ticks observed', 28)}${tickDelta} over ${ms(wallDelta)} ms of samples`);
console.log(`  ${pad('effective tick interval', 28)}${ms(effectiveTickMs)} ms (requested ${TICK_INTERVAL} ms)`);
console.log(`  ${pad('checkpoint backlog max', 28)}${maxBacklog}`);
console.log(`  ${pad('memory early / late', 28)}${mib(memoryEarly)} / ${mib(memoryLate)} (${mib((memoryLate ?? 0) - (memoryEarly ?? 0))} growth)`);
console.log(`  ${pad('stop command', 28)}${ms(stopMs)} ms (exit ${stopped.code})`);
console.log(`  ${pad('foreground exit after stop', 28)}${ms(stopLatency)} ms (exit ${exitInfo.code ?? exitInfo.signal})`);
console.log(`  ${pad('data bytes during ticks', 28)}${storageAfterTicks}`);
console.log('');

// 3. Provider event processing.
console.log(`provider event processing (${PROVIDER_FILES} files, real polls)`);
const observedDir = path.join(filesDir, 'observed');
fs.mkdirSync(observedDir, { recursive: true });
for (let i = 0; i < PROVIDER_FILES; i += 1) {
  fs.writeFileSync(path.join(observedDir, `event-${String(i).padStart(4, '0')}.txt`), `status: value-${i}\n`);
}
const sourceConfigure = await run(['source', 'configure', 'filesystem', '--root', observedDir, '--extension', 'txt', '--max-files', String(PROVIDER_FILES + 20)]);
const sourceEnable = await run(['source', 'enable', 'filesystem']);
const pollFirst = await run(['source', 'poll', 'filesystem']);
const pollSecond = await run(['source', 'poll', 'filesystem', '--force']);
const firstPoll = parsePoll(pollFirst.stdout);
const secondPoll = parsePoll(pollSecond.stdout);
check([sourceConfigure, sourceEnable, pollFirst, pollSecond].every((row) => row.code === 0), 'a provider command did not exit 0');
check(firstPoll?.accepted === PROVIDER_FILES, `the first poll accepted ${firstPoll?.accepted} of ${PROVIDER_FILES}`);
check((secondPoll?.accepted ?? 0) === 0, `the re-poll accepted ${secondPoll?.accepted} new observation(s)`);
console.log(`  ${pad('first poll', 28)}${ms(pollFirst.ms)} ms | ${firstPoll?.accepted ?? 'unknown'} accepted, ${firstPoll?.duplicates ?? '?'} duplicate, ${firstPoll?.refused ?? '?'} refused of ${firstPoll?.observed ?? '?'} observed`);
console.log(`  ${pad('re-poll', 28)}${ms(pollSecond.ms)} ms | ${secondPoll?.accepted ?? 'unknown'} accepted, ${secondPoll?.duplicates ?? '?'} duplicate, ${secondPoll?.refused ?? '?'} refused`);
console.log('');

// 4. Document ingestion, retrieval and reasoning.
console.log(`document ingestion and retrieval (${DOCS} markdown files, ${PRIOR_SITUATIONAL_ROWS} prior situational rows, real content permission)`);
await seedSituational(dataDir, PRIOR_SITUATIONAL_ROWS);
const docsDir = path.join(filesDir, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
for (let i = 0; i < DOCS; i += 1) {
  fs.writeFileSync(path.join(docsDir, `note-${String(i).padStart(4, '0')}.md`), [
    `# Supplier note ${i}`, `Owner: team-${i % 7}`, `Status: ${i % 3 === 0 ? 'open' : 'closed'}`, '',
    `The lighthouse status for lot ${i} was confirmed on day ${i % 28 + 1}.`,
    `Warehouse stock level ${i * 3 % 97} units.`,
  ].join('\n'));
}
const docConfigure = await run(['document', 'configure', '--root', docsDir, '--extension', 'md', '--max-files', String(DOCS + 100)]);
const docEnable = await run(['document', 'enable']);
const ingestCold = await run(['document', 'ingest']);
const coldCounts = parseIngest(ingestCold.stdout);
const ingestWarm = await run(['document', 'ingest']);
const warmCounts = parseIngest(ingestWarm.stdout);
const search = await run(['document', 'search', 'lighthouse']);
const documentAnswer = await run(['document', 'ask', 'What is the lighthouse status for lot 12?']);
check([docConfigure, docEnable, ingestCold, ingestWarm, search, documentAnswer].every((row) => row.code === 0), 'a document command did not exit 0');
check(coldCounts?.indexed === DOCS, `the first ingest indexed ${coldCounts?.indexed} of ${DOCS}`);
check(warmCounts !== null && (warmCounts.indexed ?? 0) === 0, `the unchanged re-ingest indexed ${warmCounts?.indexed}`);
const storageAfterIngest = bytesIn(dataDir);
storage.push({ phase: 'document ingests', bytes: storageAfterIngest });
console.log(`  ${pad('cold ingest', 28)}${ms(ingestCold.ms)} ms | ${coldCounts?.indexed ?? '?'} indexed, ${coldCounts?.failed ?? '?'} failed of ${coldCounts?.observed ?? '?'} observed`);
console.log(`  ${pad('unchanged re-ingest', 28)}${ms(ingestWarm.ms)} ms | ${warmCounts?.indexed ?? '?'} indexed, ${warmCounts?.duplicates ?? '?'} duplicate`);
console.log(`  ${pad('per-file cold cost', 28)}${ms(ingestCold.ms / DOCS)} ms/file`);
console.log(`  ${pad('document search', 28)}${ms(search.ms)} ms (exit ${search.code})`);
console.log(`  ${pad('document ask', 28)}${ms(documentAnswer.ms)} ms (exit ${documentAnswer.code})`);

const reasoning = await run(['reasoning', 'start', 'What is the lighthouse status for lot 12?']);
const reasoningId = /rsn:[0-9a-f]{32}/.exec(reasoning.stdout)?.[0] ?? null;
const reasoningShow = reasoningId ? await run(['reasoning', 'show', reasoningId]) : null;
check(reasoning.code === 0 && reasoningId !== null, `the reasoning session did not start (exit ${reasoning.code})`);
if (reasoningShow) check(reasoningShow.code === 0, `reasoning show exited ${reasoningShow.code}`);
console.log(`  ${pad('reasoning start', 28)}${ms(reasoning.ms)} ms (${reasoningId ?? 'no id'})`);
if (reasoningShow) console.log(`  ${pad('reasoning show', 28)}${ms(reasoningShow.ms)} ms`);
console.log('');

// 4b. The situational read each ingest performs, measured in-process on the file the real CLI
// just produced. The read that follows this instance's own append reuses the records the write
// validated; a fresh instance parses and validates the same bytes. The five probe observations
// appended here are the only writes this section makes.
const situationalPath = path.join(dataDir, 'situational.jsonl');
if (fs.existsSync(situationalPath)) {
  const situationalBytes = fs.readFileSync(situationalPath);
  const situationalRows = situationalBytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length;
  const writerStore = new SituationStore(situationalPath);
  const writerService = new SituationService({ store: writerStore });
  const ownReads = [];
  for (let i = 0; i < 5; i += 1) {
    await writerService.ingest({
      source: 'user', sourceEventId: `bench-read-${i}`, type: 'observation', category: 'observation',
      payload: { summary: `read probe ${i}` }, confidence: 0.8, entityRefs: [], goalRefs: [], planRefs: [], taskRefs: [],
    });
    const startedAt = performance.now();
    await writerStore.findEvent({ source: 'user', sourceEventId: 'absent', fingerprint: 'none' });
    ownReads.push(performance.now() - startedAt);
  }
  const coldReads = [];
  for (let i = 0; i < 3; i += 1) {
    const startedAt = performance.now();
    await new SituationStore(situationalPath).load();
    coldReads.push(performance.now() - startedAt);
  }
  const hashReads = [];
  for (let i = 0; i < 7; i += 1) {
    const startedAt = performance.now();
    createHash('sha256').update(situationalBytes).digest('hex');
    hashReads.push(performance.now() - startedAt);
  }
  const ownReadMs = median(ownReads);
  const coldReadMs = median(coldReads);
  const hashMs = median(hashReads);
  const warmView = await writerStore.load();
  const coldView = await new SituationStore(situationalPath).load();
  check(coldReadMs > ownReadMs,
    `the cold read (${ms(coldReadMs)} ms) was not slower than the own-append read (${ms(ownReadMs)} ms)`);
  check(hashMs < coldReadMs, `hashing (${ms(hashMs)} ms) was not cheaper than parsing (${ms(coldReadMs)} ms)`);
  check(warmView.records.length === coldView.records.length && warmView.state.events.size === coldView.state.events.size,
    'the reused read and a cold read disagree about what the log holds');
  console.log(`situational read after an ingest (${situationalRows} rows, ${situationalBytes.length} bytes, real CLI-produced log)`);
  console.log(`  ${pad('own-append read (median)', 28)}${ms(ownReadMs)} ms`);
  console.log(`  ${pad('cold parse+validate', 28)}${ms(coldReadMs)} ms`);
  console.log(`  ${pad('own / cold', 28)}${ratio(ownReadMs, coldReadMs)}`);
  console.log(`  ${pad('sha256 of the same bytes', 28)}${ms(hashMs)} ms`);
  console.log('');
}

// 5. Recovery after the runtime process is killed without warning.
console.log('recovery after an abrupt runtime termination');
const crash = startRuntime('runtime start (before crash)');
await crash.ready;
await sleep(TICK_INTERVAL * 8);
const crashStatus = await run(['runtime', 'status']);
const crashState = parseStatus(crashStatus.stdout);
const crashTicks = crashState.ticks ?? 0;
const crashBoot = crashState.boot;
const crashId = crashState.id;
crash.child.kill('SIGKILL');
const killed = await crash.exited;
check(killed.signal !== null || killed.code !== 0, 'the runtime was not actually terminated');
const recovery = startRuntime('runtime start (after crash)');
const recoveryMs = await recovery.ready;
const recovered = await run(['runtime', 'status']);
const recoveredState = parseStatus(recovered.stdout);
check(recoveredState.lifecycle === 'running', `the recovered runtime reports ${recoveredState.lifecycle}`);
check(recoveredState.id === crashId, 'the recovered runtime changed identity');
check(crashBoot !== null && recoveredState.boot === crashBoot + 1,
  `the recovered runtime reports boot ${recoveredState.boot}, expected ${(crashBoot ?? 0) + 1}`);
check(recoveredState.ticks >= crashTicks, `ticks fell from ${crashTicks} to ${recoveredState.ticks}`);
await run(['runtime', 'stop', '--reason', 'T-16 recovery measurement finished']);
await Promise.race([recovery.exited, sleep(15000)]);
const storageFinal = bytesIn(dataDir);
storage.push({ phase: 'after recovery', bytes: storageFinal });
console.log(`  ${pad('ticks before the kill', 28)}${crashTicks}`);
console.log(`  ${pad('termination', 28)}${killed.code ?? killed.signal}`);
console.log(`  ${pad('recovery to running', 28)}${ms(recoveryMs)} ms`);
console.log(`  ${pad('recovered', 28)}boot ${recoveredState.boot}, ticks ${recoveredState.ticks}, same id ${recoveredState.id === crashId}`);
console.log('');

console.log('storage growth (data directory bytes)');
for (let i = 0; i < storage.length; i += 1) {
  const delta = i === 0 ? null : storage[i].bytes - storage[i - 1].bytes;
  console.log(`  ${pad(storage[i].phase, 28)}${pad(storage[i].bytes, 12)}${delta === null ? '' : `+${delta}`}`);
}
console.log('');

console.log('what this run cannot prove:');
console.log('  - it is not a statistical benchmark: a few samples on one machine at one moment;');
console.log('  - startup includes Node process launch, so it is larger than in-process application setup;');
console.log('  - the tick interval is measured from status samples taken by separate processes, so it');
console.log(`    reflects achieved scheduling (${ms(effectiveTickMs)} ms) rather than the loop's own timer;`);
console.log(`  - ${DOCS} extracted text files are a small corpus; extraction cost per file is shown, not a cap;`);
console.log('  - the situational read comparison is in one process on one file: a restart holds no');
console.log('    validated state, so its first read is the cold one shown, not the reused one;');
console.log('  - every number is model-free and must not be read as intelligence or answer quality;');
console.log('  - no inference, provider endpoint, socket or model backend was used or contacted.');

if (!keep) {
  for (const dir of dirs) removeDir(dir);
  console.log(`\nremoved ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}`);
} else {
  console.log(`\n--keep: left ${dirs.length} temporary director${dirs.length === 1 ? 'y' : 'ies'}:`);
  for (const dir of dirs) console.log(`  ${dir}`);
}

const failed = checks.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${checks.length} checks passed`);
}
