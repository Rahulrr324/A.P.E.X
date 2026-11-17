// Isolated fixture for one evaluation scenario.
//
// Every scenario runs against its own data directory and its own content root under the operating
// system temp directory, both created with a fixed prefix and removed at the end unless the
// caller asks to keep them. A directory outside the temp root is refused, matching the isolation
// rule the application's own entry points enforce.
//
// The clock and the id factory live on the context, not on one application instance, so
// `restart()` builds a new application over the same bytes with the same deterministic identity.
// That is how continuity is measured: a second instance must derive the same picture from the
// stores, not from memory the first instance held.
//
// The only gateway this file can build is the no-backend one or a scripted in-process fixture that
// returns fixed text. There is no HTTP client, no endpoint setting, no server and no inference. A
// scripted fixture is labelled as such in the trace and reports `modelCalls` so a scenario can
// state how many fixture replies it consumed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { stableValue } from './framework.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA_PREFIX = 'apex-eval-';
const ROOT_PREFIX = 'apex-eval-root-';
const MAX_TEXT = 2000;

function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  if (!fs.realpathSync(dir).startsWith(TMP_ROOT)) throw new Error('evaluation directory escaped the temp root');
  return dir;
}

function removeTemp(dir) {
  if (!dir) return;
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  const base = path.basename(real);
  if (!real.startsWith(TMP_ROOT) || !(base.startsWith(DATA_PREFIX) || base.startsWith(ROOT_PREFIX))) {
    throw new Error(`refusing to remove a non-evaluation directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

// A deterministic clock: one second per reading, starting from a fixed instant. A scenario can
// advance it explicitly to age a record or make a validity window expire.
export function makeClock({ start = '2026-01-05T09:00:00.000Z', stepMs = 1000 } = {}) {
  let current = Date.parse(start);
  return {
    now: () => {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
    peek: () => new Date(current),
    advance: (ms) => { current += ms; },
  };
}

// Deterministic identifiers, shared across restarts on the same context. The shape is a UUID with
// a fixed version/variant nibble because several stores validate that shape for record ids; the
// counter replaces the random part, so two runs on the same fixture produce the same ids.
export function makeIds() {
  let count = 0;
  return {
    next: () => {
      count += 1;
      const tail = count.toString(16).padStart(12, '0');
      const head = count.toString(16).padStart(8, '0').slice(-8);
      return `${head}-0000-4000-8000-${tail}`;
    },
  };
}

// An in-process scripted gateway. It is a fixture, not a model: it returns the fixed text it was
// given and counts how many times it was asked. The controller still sees an ordinary gateway, so
// the real authorization path runs unchanged.
export function makeScriptedGateway(replies, { name = 'eval-scripted-fixture' } = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const requests = [];
  const backend = {
    name,
    provider: 'scripted-fixture',
    configured: true,
    describe: () => ({ configured: true, provider: 'scripted-fixture', endpoint: 'in-process', model: name }),
    health: async () => ({ available: true, detail: 'in-process scripted fixture; no inference' }),
    complete: async (request) => {
      requests.push(request);
      const text = queue.length > 1 ? queue.shift() : queue[0];
      return {
        ok: true,
        backend: name,
        provider: 'scripted-fixture',
        model: name,
        text: typeof text === 'function' ? text(request) : text,
        finishReason: 'stop',
        truncated: false,
        latencyMs: 0,
      };
    },
  };
  const gateway = new ModelGateway({ backend });
  gateway.requests = requests;
  return gateway;
}

function traceSummary(value) {
  if (value === null || value === undefined) return null;
  const status = typeof value.status === 'string' ? value.status : null;
  const display = typeof value.display === 'string' ? value.display : null;
  return {
    status,
    display: display === null ? null : stableValue(display, { max: MAX_TEXT }),
  };
}

export async function createEvaluationContext({
  scenario,
  dataDir = null,
  filesDir = null,
  keep = false,
  clock = makeClock(),
  ids = makeIds(),
} = {}) {
  const ownData = dataDir === null;
  const ownFiles = filesDir === null;
  const data = dataDir ?? makeTemp(DATA_PREFIX);
  const files = filesDir ?? makeTemp(ROOT_PREFIX);
  if (!fs.realpathSync(data).startsWith(TMP_ROOT) || !fs.realpathSync(files).startsWith(TMP_ROOT)) {
    throw new Error('evaluation fixture directories must live under the temp root');
  }

  const trace = [];
  const evidence = [];
  let droppedTrace = 0;
  let droppedEvidence = 0;
  let gateway = new ModelGateway({ backend: new NoBackend() });
  let app = null;

  async function buildApp(options = {}) {
    if (options.gateway) gateway = options.gateway;
    app = createApp({
      dataDir: data,
      filesystemRoot: files,
      now: clock.now,
      idFactory: ids.next,
      gateway,
      ...options.appOptions,
    });
    return app;
  }

  async function restart(options = {}) {
    await app?.runtime?.stop?.({ reason: 'evaluation restart' }).catch?.(() => {});
    return buildApp(options);
  }

  const sanitize = (value, depth = 0) => {
    if (depth > 8) return '[deep]';
    if (typeof value === 'string') {
      return value.split(data).join('<data>').split(files).join('<content-root>');
    }
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = sanitize(entry, depth + 1);
      return out;
    }
    return value;
  };

  const context = {
    scenario: scenario?.id ?? null,
    dataDir: data,
    filesDir: files,
    clock,
    ids,
    get app() { return app; },
    gateway: () => gateway,

    async open(options = {}) {
      return buildApp(options);
    },
    async restart(options = {}) {
      return restart(options);
    },

    advance(ms) {
      clock.advance(ms);
      return clock.peek().toISOString();
    },

    async run(label, fn) {
      const started = Date.now();
      const push = (entry) => {
        if (trace.length < 60) trace.push(entry);
        else droppedTrace += 1;
      };
      try {
        const value = await fn();
        const summary = traceSummary(value);
        push({
          label,
          ok: true,
          at: clock.peek().toISOString(),
          durationMs: Date.now() - started,
          ...(summary ?? {}),
        });
        return value;
      } catch (err) {
        push({
          label,
          ok: false,
          at: clock.peek().toISOString(),
          durationMs: Date.now() - started,
          error: stableValue(err?.message ?? String(err), { max: 500 }),
          code: err?.code ?? null,
        });
        throw err;
      }
    },

    async say(text) {
      return context.run(`user: ${stableValue(text, { max: 120 })}`, () => app.controller.handle(text));
    },

    async act(method, args = {}, label = null) {
      return context.run(label ?? `call: ${method}`, () => {
        const fn = app.controller?.[method];
        if (typeof fn !== 'function') throw new Error(`the controller has no method ${method}`);
        return fn.call(app.controller, args);
      });
    },

    // The positional form, for the controller methods whose reference or options are separate
    // arguments (`planActivate(ref, options)`, `showGoal(ref)`, `taskFeedback(ref, options)`).
    async call(method, args = [], label = null) {
      return context.run(label ?? `call: ${method}`, () => {
        const fn = app.controller?.[method];
        if (typeof fn !== 'function') throw new Error(`the controller has no method ${method}`);
        if (!Array.isArray(args)) throw new Error('call() takes an array of positional arguments');
        return fn.apply(app.controller, args);
      });
    },

    record(label, value) {
      if (evidence.length < 40) evidence.push({ label, value: sanitize(value) });
      else droppedEvidence += 1;
    },

    writeFile(relative, content) {
      const target = path.join(files, relative);
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });
      const realParent = fs.realpathSync(parent);
      if (!realParent.startsWith(fs.realpathSync(files))) throw new Error('fixture file escaped the content root');
      fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
      return relative;
    },

    removeFile(relative) {
      fs.rmSync(path.join(files, relative), { force: true });
    },

    // A genuine second operating-system process over the same data directory. Used for a
    // process-boundary continuity check; it is the CLI a user runs, with a clean APEX environment.
    async cli(args) {
      const env = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('APEX_')) env[key] = value;
      }
      // The child process gets the same authorized content root the in-process app was built
      // with, so a CLI command and a controller call resolve the same relative paths.
      Object.assign(env, { APEX_DATA_ISOLATED: '1', APEX_DATA_DIR: data, APEX_FILESYSTEM_ROOT: files });
      const result = await context.run(`cli: ${args.join(' ')}`, () => new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(EVAL_ROOT, 'bin', 'apex.js'), ...args],
          { env, timeout: 60000, windowsHide: true },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, stdout, stderr });
          },
        );
      }));
      return result;
    },

    sanitize,
    traceEntries() {
      const kept = trace.slice(0, 60);
      return droppedTrace > 0 ? [...kept, { label: `${droppedTrace} trace entries omitted`, ok: true }] : kept;
    },
    evidenceEntries() {
      return evidence;
    },
    evidenceDropped: () => droppedEvidence,

    async dispose() {
      await app?.runtime?.stop?.({ reason: 'evaluation cleanup' }).catch?.(() => {});
      if (!keep && ownData) removeTemp(data);
      if (!keep && ownFiles) removeTemp(files);
    },
  };

  await buildApp();
  return context;
}
