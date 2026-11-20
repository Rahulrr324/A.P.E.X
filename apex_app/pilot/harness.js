// Real-world pilot harness (T-16). It is deliberately separate from `eval/`, which measures
// synthetic scenarios against an in-process application. Here every operation the application
// performs goes through a real operating-system process: `bin/apex.js` or `bin/apex-serve.js`,
// started with a clean environment, an isolated data directory and an isolated pilot workspace
// under the OS temporary directory.
//
// What this file records for a run is what a person could have observed: process identity, exit
// codes, timestamps, stdout/stderr, the files the application read and wrote, and the persistent
// records a later process reads back. A scenario's stated expectation is frozen and hashed before
// it runs, so an evaluator cannot quietly change the acceptance criteria after seeing the
// outcome, and a successful process exit is never treated as task success.
//
// Nothing in this file starts, configures, or contacts a model. The child environments are built
// by dropping every APEX_* variable, including any model endpoint a developer's shell might set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FAILURE_CLASSES, check, stableValue } from '../eval/framework.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PILOT_VERSION = 1;
export const PILOT_CATEGORY = 'real-world';

// The same promises T-15 measured, without `performance`: §8 requires timings to be measured and
// reported separately from a scenario's outcome, so a slow run cannot be scored as a correct one.
export const PILOT_DIMENSIONS = Object.freeze(['correctness', 'completeness', 'reliability', 'safety', 'continuity', 'ux']);
export const PILOT_FAILURE_CLASSES = Object.freeze([...FAILURE_CLASSES, 'process_failure', 'environment_unavailable']);

const DIMENSION_FAILURE = Object.freeze({
  correctness: 'wrong_outcome',
  completeness: 'missing_evidence',
  safety: 'unsafe_side_effect',
  continuity: 'continuity_loss',
  ux: 'unusable_output',
  reliability: 'process_failure',
});

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA_PREFIX = 'apex-pilot-';
const ROOT_PREFIX = 'apex-pilot-root-';
const MAX_TEXT = 4000;
const MAX_PROCESSES = 120;
const MAX_TRACE = 160;
const MAX_EVIDENCE = 80;
const MAX_MEASUREMENTS = 160;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  if (!fs.realpathSync(dir).startsWith(TMP_ROOT)) throw new Error('pilot directory escaped the temp root');
  return dir;
}

function removeTemp(dir) {
  if (!dir) return;
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  const base = path.basename(real);
  if (!real.startsWith(TMP_ROOT) || !(base.startsWith(DATA_PREFIX) || base.startsWith(ROOT_PREFIX))) {
    throw new Error(`refusing to remove a non-pilot directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

// Every APEX_* variable is dropped before a child starts. The pilot then sets only the isolation
// variables it needs, so a model endpoint or a real user data directory in the developer's shell
// cannot leak into the run.
export function pilotEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('APEX_')) env[key] = value;
  }
  return { ...env, APEX_DATA_ISOLATED: '1', ...extra };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitValue(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: APP_ROOT, timeout: 15000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

// Application identity is recorded once per run: package version, the exact commit the source
// tree is at, and the branch. A pilot result without this cannot be tied to code.
export async function appIdentity() {
  const pkg = readJson(path.join(APP_ROOT, 'package.json'));
  const [commit, branch, dirty] = await Promise.all([
    gitValue(['rev-parse', 'HEAD']),
    gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitValue(['status', '--porcelain']),
  ]);
  return {
    name: pkg.name,
    version: pkg.version,
    node: process.version,
    commit,
    branch,
    dirty: dirty === null ? null : dirty !== '',
  };
}

export function environment(identity) {
  return {
    pilotVersion: PILOT_VERSION,
    at: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    app: identity,
    isolation: 'APEX_DATA_ISOLATED=1 with data and content roots inside the OS temp directory',
    inference: 'none: every APEX_* variable is removed from child environments; no endpoint is configured or contacted',
  };
}

// The stated expectation is copied and hashed before the scenario runs. The copy, not the
// scenario's own object, is what the result carries; a mutation during execution is detected.
export function freezeExpectation(expected) {
  const copy = JSON.parse(JSON.stringify(expected ?? null));
  return { copy, hash: digest(copy) };
}

export function validatePilotScenario(scenario) {
  const problems = [];
  for (const field of ['id', 'area', 'title', 'intent']) {
    if (typeof scenario?.[field] !== 'string' || scenario[field].trim() === '') problems.push(`${field} must be a non-empty string`);
  }
  if (scenario?.category !== PILOT_CATEGORY) problems.push(`category must be "${PILOT_CATEGORY}"`);
  if (!Array.isArray(scenario?.preconditions)) problems.push('preconditions must be a list');
  if (!Array.isArray(scenario?.steps) || scenario.steps.length === 0) problems.push('steps must be a non-empty list');
  if (typeof scenario?.run !== 'function') problems.push('run must be a function');
  const expected = scenario?.expected;
  if (!expected || typeof expected !== 'object' || typeof expected.result !== 'string' || expected.result.trim() === '') {
    problems.push('expected.result must state the intended result');
  }
  if (!Array.isArray(expected?.acceptance) || expected.acceptance.length === 0) {
    problems.push('expected.acceptance must list the observable criteria');
  }
  if (scenario?.workflow !== undefined && !/^[A-J]$/.test(scenario.workflow)) problems.push('workflow must be one letter A-J');
  if (problems.length > 0) {
    const err = new Error(`invalid pilot scenario ${scenario?.id ?? '(no id)'}: ${problems.join('; ')}`);
    err.code = 'PILOT_HARNESS';
    throw err;
  }
}

function listTree(root, limit = 200) {
  const rows = [];
  const walk = (dir, prefix) => {
    if (rows.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (rows.length >= limit) return;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        rows.push(`${relative}/`);
        walk(path.join(dir, entry.name), relative);
      } else {
        rows.push(relative);
      }
    }
  };
  walk(root, '');
  return rows;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* a file removed during the scan */ }
      }
    }
  };
  walk(dir);
  return total;
}

// Windows process working set, read from the operating system. Returns null rather than a guess
// when the query is unavailable; the caller records that the measurement was not taken.
export function processMemoryBytes(pid) {
  return new Promise((resolve) => {
    // Number('') is 0, so a blank or unparsable reply must be rejected explicitly rather than
    // reported as a process that uses no memory.
    const parse = (text, scale = 1) => {
      const raw = String(text ?? '').trim();
      const value = raw === '' ? NaN : Number(raw);
      return Number.isFinite(value) && value > 0 ? value * scale : null;
    };
    const target = Number(pid);
    if (!Number.isSafeInteger(target) || target <= 0) return resolve(null);
    if (process.platform === 'linux') {
      // Read the kernel's resident-set field directly. Spawning `ps` for each sample can
      // time out under the same process contention the pilot is measuring, which would turn
      // a real OS measurement into an environment-dependent false failure.
      fs.promises.readFile(`/proc/${target}/status`, 'utf8').then((text) => {
        const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
        resolve(match ? parse(match[1], 1024) : null);
      }).catch(() => resolve(null));
      return;
    }
    if (process.platform !== 'win32') {
      execFile('ps', ['-o', 'rss=', '-p', String(target)], { timeout: 10000, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : parse(stdout, 1024));
      });
      return;
    }
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${target}).WorkingSet64`], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parse(stdout));
    });
  });
}

function httpRequest({ base, method, pathname, token, headers = {}, body = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const finalHeaders = { ...headers };
    if (token) finalHeaders.authorization = `Bearer ${token}`;
    if (payload) {
      finalHeaders['content-type'] = finalHeaders['content-type'] ?? 'application/json';
      finalHeaders['content-length'] = String(payload.length);
    }
    const startedAt = Date.now();
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: finalHeaders,
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json, durationMs: Date.now() - startedAt, method, pathname });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`the request to ${pathname} timed out after ${timeoutMs} ms`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function createPilotContext({ scenario, keep = false, clockStart = null } = {}) {
  const dataDir = makeTemp(DATA_PREFIX);
  const filesDir = makeTemp(ROOT_PREFIX);
  const startedAt = clockStart ? new Date(clockStart) : new Date();
  const processes = [];
  const trace = [];
  let droppedTrace = 0;
  const evidence = [];
  let droppedEvidence = 0;
  const measurements = [];
  let droppedMeasurements = 0;
  const children = new Set();
  const handles = [];

  const sanitize = (value, depth = 0) => {
    if (depth > 8) return '[deep]';
    if (typeof value === 'string') {
      return value.split(dataDir).join('<data>').split(filesDir).join('<pilot-root>');
    }
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = sanitize(entry, depth + 1);
      return out;
    }
    return value;
  };

  const record = (label, detail = null) => {
    if (trace.length < MAX_TRACE) trace.push({ at: new Date().toISOString(), label, detail: detail === null ? null : sanitize(stableValue(detail, { max: 600 })) });
    else droppedTrace += 1;
  };

  const childEnv = (extra = {}) => pilotEnv({ APEX_DATA_DIR: dataDir, APEX_FILESYSTEM_ROOT: filesDir, ...extra });

  function track(child, label) {
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  }

  // One real CLI process. Its identity, exit code, signal and timings are kept for the result;
  // the scenario gets the parsed streams back to assert against. `probe` marks a read whose only
  // job is waiting for a condition: how many such reads a scenario needed depends on real
  // scheduling, so a probe is evidence but not part of the compared signature.
  function cli(args, { timeoutMs = 120000, extraEnv = {}, label = null, probe = false } = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const startedIso = new Date(started).toISOString();
      const child = track(spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex.js'), ...args], {
        env: childEnv(extraEnv),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }), label ?? args.join(' '));
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const finishedAt = new Date().toISOString();
        const result = {
          label: label ?? args.join(' '),
          args: [...args],
          pid: child.pid,
          startedAt: startedIso,
          finishedAt,
          durationMs: Date.now() - started,
          code,
          signal,
          timedOut,
          probe,
          stdout: sanitize(stableValue(stdout, { max: MAX_TEXT })),
          stderr: sanitize(stableValue(stderr, { max: MAX_TEXT })),
        };
        if (processes.length < MAX_PROCESSES) processes.push(result);
        record(`cli ${args.join(' ')} -> exit ${code ?? signal} in ${result.durationMs} ms`, timedOut ? 'timed out' : stderr.slice(0, 300));
        resolve({ ...result, rawStdout: stdout, rawStderr: stderr });
      });
    });
  }

  // A long-running foreground process. The marker is printed by the process itself after its
  // state is on disk, so waiting for it is not a delay: it is the process reporting readiness.
  function launch(args, { marker, timeoutMs = 90000, extraEnv = {}, label = null }) {
    const child = track(spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex.js'), ...args], {
      env: childEnv(extraEnv),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }), label ?? args.join(' '));
    const startedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const finishedAt = new Date().toISOString();
        if (processes.length < MAX_PROCESSES) {
          processes.push({
            label: label ?? args.join(' '),
            args: [...args],
            pid: child.pid,
            startedAt,
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
            code,
            signal,
            timedOut: false,
            stdout: sanitize(stableValue(stdout, { max: MAX_TEXT })),
            stderr: sanitize(stableValue(stderr, { max: MAX_TEXT })),
          });
        }
        record(`long-running ${args.join(' ')} -> exit ${code ?? signal}`);
        resolve({ code, signal, at: finishedAt });
      });
    });
    const output = () => `${stdout}${stderr}`;
    const handle = {
      pid: child.pid,
      startedAt,
      args: [...args],
      exited,
      output,
      stdout: () => stdout,
    };
    handles.push(handle);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${args.join(' ')} did not reach ${marker} within ${timeoutMs} ms. ${output()}`)), timeoutMs);
      const check = () => {
        if (stdout.includes(marker) || stderr.includes(marker)) { clearTimeout(timer); resolve(handle); }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`${args.join(' ')} exited ${code ?? signal} before ${marker}. ${output()}`)); });
      check();
    });
    return { handle, ready, output };
  }

  // A real CLI process the scenario itself will interrupt. The interrupted-ingestion scenario
  // watches the files this process writes and then ends it, which is what losing the machine or
  // closing the window would do; nothing here sends a graceful in-band command.
  function spawnCli(args, { extraEnv = {}, label = null } = {}) {
    const child = track(spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex.js'), ...args], {
      env: childEnv(extraEnv),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }), label ?? args.join(' '));
    const startedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const finishedAt = new Date().toISOString();
        if (processes.length < MAX_PROCESSES) {
          processes.push({
            label: label ?? args.join(' '),
            args: [...args],
            pid: child.pid,
            startedAt,
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
            code,
            signal,
            timedOut: false,
            stdout: sanitize(stableValue(stdout, { max: MAX_TEXT })),
            stderr: sanitize(stableValue(stderr, { max: MAX_TEXT })),
          });
        }
        record(`spawned ${args.join(' ')} -> exit ${code ?? signal}`);
        resolve({ code, signal, at: finishedAt });
      });
    });
    const handle = {
      pid: child.pid,
      args: [...args],
      startedAt,
      exited,
      output: () => `${stdout}${stderr}`,
      stdout: () => stdout,
      running: () => child.exitCode === null && child.signalCode === null,
      kill(signal) {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        record(`scenario interrupted ${args.join(' ')} (pid ${child.pid})`);
        return child.kill(signal);
      },
    };
    handles.push(handle);
    return handle;
  }

  // The local UI server is a real process too. Its URL carries the per-process token, which is
  // never written to a result; requests store only method, path, status and timing.
  async function serve({ extraEnv = {}, timeoutMs = 60000 } = {}) {
    const child = track(spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex-serve.js')], {
      env: childEnv({ APEX_UI_PORT: '0', ...extraEnv }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }), 'apex-serve');
    let stdout = '';
    let stderr = '';
    let printedToken = null;
    const startedAt = new Date().toISOString();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const finishedAt = new Date().toISOString();
        if (processes.length < MAX_PROCESSES) {
          // The printed URL carries the per-process token, so it is redacted before the process
          // output becomes part of a result.
          const redact = (text) => (printedToken ? text.split(printedToken).join('<token>') : text);
          processes.push({
            label: 'apex-serve',
            args: ['serve'],
            pid: child.pid,
            startedAt,
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
            code,
            signal,
            timedOut: false,
            probe: false,
            stdout: sanitize(stableValue(redact(stdout), { max: MAX_TEXT })),
            stderr: sanitize(stableValue(redact(stderr), { max: MAX_TEXT })),
          });
        }
        record(`apex-serve -> exit ${code ?? signal}`);
        resolve({ code, signal, at: finishedAt });
      });
    });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`apex-serve did not print its address within ${timeoutMs} ms. ${stdout}${stderr}`)), timeoutMs);
      const check = () => {
        const match = /Open: (http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+)/.exec(stdout);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', check);
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`apex-serve exited ${code}. ${stdout}${stderr}`)); });
      check();
    });
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    printedToken = token;
    const base = `http://${parsed.host}`;
    const requests = [];
    const request = async (method, pathname, options = {}) => {
      const effectiveToken = options.token === undefined ? token : options.token;
      const headers = { ...(options.headers ?? {}) };
      if (method === 'POST' && headers['x-apex-ui'] === undefined && options.ui !== false) {
        headers['x-apex-ui'] = '1';
        headers.origin = headers.origin ?? base;
      }
      // The token can be presented in a query string as the page's first link does. It is spliced
      // in here so the recorded path never contains it.
      const target = options.queryToken
        ? `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
        : pathname;
      let result;
      try {
        result = await httpRequest({
          base,
          method,
          pathname: target,
          token: options.queryToken ? null : effectiveToken,
          headers,
          body: options.body ?? null,
          timeoutMs: options.timeoutMs ?? 20000,
        });
      } catch (err) {
        result = { status: null, error: err?.message ?? String(err), method, pathname, headers: {}, body: '', json: null, durationMs: null };
      }
      requests.push({
        method,
        pathname,
        authenticated: Boolean(effectiveToken),
        queryToken: Boolean(options.queryToken),
        status: result.status,
        durationMs: result.durationMs,
        origin: headers.origin ?? null,
        hasUiHeader: headers['x-apex-ui'] === '1',
        error: result.error ?? null,
      });
      record(`http ${method} ${pathname} -> ${result.status ?? 'error'}${effectiveToken ? '' : ' (no token)'}`);
      return result;
    };
    const handle = {
      pid: child.pid,
      url: `${base}/`,
      base,
      token,
      requests,
      get: (pathname, options = {}) => request('GET', pathname, options),
      post: (pathname, body, options = {}) => request('POST', pathname, { ...options, body }),
      lines: () => stdout,
      errors: () => stderr,
      exited,
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        const info = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'unreaped' }), 10000))]);
        record(`apex-serve stopped: ${info.code ?? info.signal}`);
        return info;
      },
    };
    handles.push(handle);
    return handle;
  }

  const assertInside = (target) => {
    const root = fs.realpathSync(filesDir);
    const resolved = path.resolve(filesDir, target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`path escaped the pilot workspace: ${target}`);
    return resolved;
  };

  const context = {
    scenario: scenario?.id ?? null,
    dataDir,
    filesDir,
    startedAt: startedAt.toISOString(),
    processes,
    handles,
    env: childEnv,
    cli,
    launch,
    spawnCli,
    serve,

    // Direct file-system operations in the pilot workspace. These are the user's own actions
    // (editing a file, renaming it, deleting it), not application behaviour.
    write(relative, content) {
      const target = assertInside(relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
      record(`user wrote ${relative} (${fs.statSync(target).size} bytes)`);
      return relative;
    },
    mkdir(relative) {
      fs.mkdirSync(assertInside(relative), { recursive: true });
      record(`user created directory ${relative}`);
    },
    move(from, to) {
      fs.renameSync(assertInside(from), assertInside(to));
      record(`user renamed ${from} -> ${to}`);
    },
    remove(relative) {
      fs.rmSync(assertInside(relative), { force: true });
      record(`user deleted ${relative}`);
    },
    exists(relative) {
      try { fs.accessSync(assertInside(relative)); return true; } catch { return false; }
    },
    read(relative) {
      return fs.readFileSync(assertInside(relative), 'utf8');
    },
    list(relative = '') {
      return listTree(assertInside(relative));
    },
    filesTree() {
      return listTree(filesDir);
    },
    workspaceBytes() {
      return dirBytes(filesDir);
    },
    dataTree() {
      return listTree(dataDir);
    },
    dataBytes() {
      return dirBytes(dataDir);
    },
    dataFile(name) {
      return path.join(dataDir, name);
    },
    readJson(name) {
      return readJsonFile(path.join(dataDir, name));
    },
    readJsonl(name) {
      const file = path.join(dataDir, name);
      try {
        return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
      } catch (err) {
        if (err?.code === 'ENOENT') return [];
        throw err;
      }
    },
    countLines(name) {
      const file = path.join(dataDir, name);
      try {
        return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
      } catch (err) {
        if (err?.code === 'ENOENT') return 0;
        throw err;
      }
    },
    sha256(relative) {
      return createHash('sha256').update(fs.readFileSync(assertInside(relative))).digest('hex');
    },

    // Bounded evidence a reader can inspect without re-running the scenario.
    record(label, value) {
      if (evidence.length < MAX_EVIDENCE) evidence.push({ label, at: new Date().toISOString(), value: sanitize(value) });
      else droppedEvidence += 1;
    },

    // Timings live beside the result, never inside a dimension. §8 asks for measured startup,
    // tick, ingest, retrieval, recovery and storage figures; they are reported as measured.
    // A measurement is a number or an explicit null when the operating system would not report it;
    // anything else is a scenario mistake (an unawaited Promise reads as "[object Promise]" in the
    // report), so it fails the scenario instead of publishing a value the run did not take.
    measure(name, value, detail = null, unit = 'ms') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || (typeof value?.then === 'function'))) {
        const err = new Error(`measurement "${name}" must be a finite number or null, received ${typeof value}`);
        err.code = 'PILOT_HARNESS';
        throw err;
      }
      if (measurements.length < MAX_MEASUREMENTS) {
        measurements.push({ name, value, unit: value === null ? null : unit, detail: detail === null ? null : sanitize(detail), at: new Date().toISOString() });
      } else {
        droppedMeasurements += 1;
      }
    },

    startingState() {
      return {
        at: new Date().toISOString(),
        dataFiles: listTree(dataDir),
        workspaceFiles: listTree(filesDir),
      };
    },

    processMemory: processMemoryBytes,
    sanitize,
    traceEntries() {
      const kept = trace.slice(0, MAX_TRACE);
      return droppedTrace > 0 ? [...kept, { at: new Date().toISOString(), label: `${droppedTrace} trace entries omitted`, detail: null }] : kept;
    },
    evidenceEntries() {
      return evidence;
    },
    measurements: () => measurements.slice(),
    measurementsDropped: () => droppedMeasurements,

    async dispose() {
      for (const handle of handles.slice().reverse()) {
        if (typeof handle.stop === 'function') {
          await handle.stop().catch(() => {});
        } else if (handle.exited) {
          const info = await Promise.race([handle.exited, Promise.resolve({ code: null, signal: 'still-running' })]);
          if (info.code === null && info.signal === 'still-running' && handle.pid) {
            try { process.kill(handle.pid); } catch { /* already gone */ }
            await Promise.race([handle.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
          }
        }
      }
      for (const child of [...children]) {
        try { child.kill(); } catch { /* already gone */ }
      }
      if (!keep) {
        removeTemp(dataDir);
        removeTemp(filesDir);
      }
      return { kept: keep ? { dataDir, filesDir } : null };
    },
  };

  return context;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function normalizeChecks(raw) {
  const checks = {};
  for (const dimension of PILOT_DIMENSIONS) {
    const entry = raw?.[dimension];
    if (entry === undefined || entry === null) { checks[dimension] = null; continue; }
    if (typeof entry !== 'object' || typeof entry.ok !== 'boolean') {
      const err = new Error(`pilot check ${dimension} must be { ok, expected, actual }`);
      err.code = 'PILOT_HARNESS';
      throw err;
    }
    checks[dimension] = { ok: entry.ok, expected: entry.expected ?? null, actual: entry.actual ?? null };
  }
  return checks;
}

function classify(checks, scenario) {
  const failed = PILOT_DIMENSIONS.filter((dimension) => checks[dimension] !== null && !checks[dimension].ok);
  if (failed.length === 0) return null;
  const explicit = scenario.failureClasses ?? {};
  for (const dimension of failed) {
    if (explicit[dimension] && PILOT_FAILURE_CLASSES.includes(explicit[dimension])) return explicit[dimension];
    if (DIMENSION_FAILURE[dimension]) return DIMENSION_FAILURE[dimension];
  }
  return 'wrong_outcome';
}

// Each repeat starts from fresh fixtures, so every run mints new goal, plan, task and record ids,
// and lives in a new temp root. Those are inputs to later commands, not part of the workflow being
// compared: the command shape and its exit code are what must agree across repeats.
function commandKey(args) {
  return args
    .join(' ')
    .replace(/apex-pilot-root-[A-Za-z0-9]+/g, ':fixture-root')
    .replace(/apex-pilot-[A-Za-z0-9]+/g, ':fixture-data')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b(?:[a-z]+:)?[0-9a-f]{24,}\b/gi, ':id')
    .replace(/\b[0-9a-f]{8}\b/gi, ':id');
}

export function pilotSignature(result) {
  return digest({
    id: result.id,
    pass: result.pass,
    failureClass: result.failureClass,
    expectedHash: result.expectedHash,
    checks: PILOT_DIMENSIONS.map((dimension) => [dimension, result.checks?.[dimension] ? result.checks[dimension].ok : null]),
    exits: (result.processes ?? []).filter((row) => !row.probe).map((row) => [commandKey(row.args), row.code]),
  });
}

export function summarizePilot(results) {
  const dimensions = {};
  for (const dimension of PILOT_DIMENSIONS) {
    let passed = 0;
    let total = 0;
    for (const result of results) {
      const entry = result.checks?.[dimension];
      if (!entry) continue;
      total += 1;
      if (entry.ok) passed += 1;
    }
    dimensions[dimension] = { passed, total, rate: total > 0 ? passed / total : null };
  }
  const areas = {};
  const workflows = {};
  for (const result of results) {
    areas[result.area] = areas[result.area] ?? { passed: 0, total: 0 };
    areas[result.area].total += 1;
    if (result.pass) areas[result.area].passed += 1;
    if (result.workflow) {
      workflows[result.workflow] = workflows[result.workflow] ?? { passed: 0, total: 0 };
      workflows[result.workflow].total += 1;
      if (result.pass) workflows[result.workflow].passed += 1;
    }
  }
  const failureClasses = {};
  for (const result of results) {
    if (result.pass || !result.failureClass) continue;
    failureClasses[result.failureClass] = (failureClasses[result.failureClass] ?? 0) + 1;
  }
  const processRows = results.flatMap((result) => result.processes ?? []);
  return {
    scenarios: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    dimensions,
    areas,
    workflows,
    failureClasses,
    processes: {
      total: processRows.length,
      nonZeroExits: processRows.filter((row) => row.code !== 0).length,
      timedOut: processRows.filter((row) => row.timedOut).length,
    },
    measurements: results.reduce((total, result) => total + (result.measurements?.length ?? 0), 0),
  };
}

// One scenario against one fresh pair of real directories. The expected result is frozen before
// the run; a clean process exit is not a pass unless an outcome assertion holds.
export async function runPilotScenario(scenario, { keep = false } = {}) {
  validatePilotScenario(scenario);
  const frozen = freezeExpectation(scenario.expected);
  const statedHash = frozen.hash;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let ctx = null;
  let raw = null;
  let thrown = null;
  let startingState = scenario.startingState ?? null;
  try {
    ctx = await createPilotContext({ scenario, keep });
    // Fixture files are the user's own setup, written before the scenario starts operating.
    // Recording the tree here keeps the starting state separate from what the application did.
    if (typeof scenario.setup === 'function') await scenario.setup(ctx);
    startingState = scenario.startingState ?? ctx.startingState();
    raw = await scenario.run(ctx);
  } catch (err) {
    thrown = err;
  }
  const durationMs = Date.now() - started;

  const base = {
    id: scenario.id,
    category: PILOT_CATEGORY,
    area: scenario.area,
    workflow: scenario.workflow ?? null,
    title: scenario.title,
    intent: scenario.intent,
    preconditions: scenario.preconditions,
    steps: scenario.steps,
    expected: frozen.copy,
    expectedHash: statedHash,
    startedAt,
    durationMs,
    processes: ctx?.processes ?? [],
    trace: ctx?.traceEntries?.() ?? [],
    evidence: ctx?.evidenceEntries?.() ?? [],
    measurements: ctx?.measurements?.() ?? [],
    startingState,
  };

  let result;
  if (thrown) {
    const harness = thrown?.code === 'PILOT_HARNESS';
    result = {
      ...base,
      pass: false,
      actual: `${harness ? 'harness' : thrown?.code ?? 'ERROR'}: ${thrown?.message ?? String(thrown)}`,
      checks: Object.fromEntries(PILOT_DIMENSIONS.map((dimension) => [dimension, null])),
      failedDimensions: [],
      failureClass: harness ? 'harness_error' : 'unexpected_exception',
      recovery: null,
      limitations: [],
      notes: harness ? ['the scenario or its fixture is wrong; this result is not evidence about APEX'] : [],
    };
  } else if (!raw || typeof raw !== 'object') {
    result = {
      ...base,
      pass: false,
      actual: stableValue(raw),
      checks: Object.fromEntries(PILOT_DIMENSIONS.map((dimension) => [dimension, null])),
      failedDimensions: [],
      failureClass: 'harness_error',
      recovery: null,
      limitations: [],
      notes: ['the scenario returned no result object'],
    };
  } else {
    const checks = normalizeChecks(raw.checks);
    const failedDimensions = PILOT_DIMENSIONS.filter((dimension) => checks[dimension] !== null && !checks[dimension].ok);
    const asserted = checks.correctness !== null || checks.completeness !== null;
    const usedRealProcess = (ctx?.processes?.length ?? 0) > 0;
    let failureClass = classify(checks, scenario);
    if (!asserted && failedDimensions.length === 0) failureClass = 'invalid_scenario';
    if (!usedRealProcess) failureClass = failureClass ?? 'invalid_scenario';
    // A pilot scenario that never ran the application is not evidence about the application,
    // however well its file assertions happen to hold.
    const pass = asserted && failedDimensions.length === 0 && usedRealProcess;
    result = {
      ...base,
      pass,
      actual: raw.actual ?? null,
      checks,
      failedDimensions,
      failureClass: pass ? null : failureClass,
      recovery: raw.recovery ?? null,
      limitations: raw.limitations ?? [],
      notes: [
        ...(raw.notes ?? []),
        ...(usedRealProcess ? [] : ['no real application process ran; this scenario is not pilot evidence']),
      ],
    };
  }

  const disposal = ctx ? await ctx.dispose().catch((err) => ({ error: err?.message ?? String(err) })) : null;
  result.kept = disposal?.kept ?? null;

  // Proof the stated expectation did not change while the scenario ran.
  const afterHash = digest(JSON.parse(JSON.stringify(scenario.expected ?? null)));
  result.expectationIntact = afterHash === statedHash;
  if (!result.expectationIntact) {
    result.pass = false;
    result.failedDimensions = [...new Set([...result.failedDimensions, ...PILOT_DIMENSIONS])];
    result.failureClass = 'invalid_scenario';
    result.notes = [...result.notes, 'the declared expectation changed during execution; the run is not evidence'];
  }
  result.finishedAt = new Date().toISOString();
  result.signature = pilotSignature(result);
  return result;
}

export function renderPilotReport(report) {
  const { environment: env, results, summary } = report;
  const lines = [
    `Real-world pilot: ${summary.passed} of ${summary.scenarios} scenario(s) passed.`,
    `Application ${env.app.name} ${env.app.version} at ${env.app.commit ?? 'unknown commit'} (${env.app.branch ?? 'unknown branch'})${env.app.dirty ? ', dirty tree' : ''}.`,
    `Node ${env.app.node} on ${env.platform} ${env.release} (${env.arch}); ${env.cpus} CPU(s).`,
    'A pass requires every stated outcome assertion to hold through a real process; an exit code alone is not a pass.',
    '',
  ];
  let workflow = null;
  for (const result of results) {
    const bucket = result.workflow ? `workflow ${result.workflow}` : result.area;
    if (bucket !== workflow) {
      workflow = bucket;
      lines.push(`[${workflow}]`);
    }
    const status = result.pass ? 'pass' : `FAIL (${result.failureClass ?? 'unclassified'})`;
    lines.push(`  ${result.id} ${status} - ${result.title}`);
    lines.push(`      expected: ${result.expected?.result ?? '—'}`);
    if (!result.pass) {
      for (const dimension of result.failedDimensions) {
        const entry = result.checks?.[dimension];
        if (entry) lines.push(`      ${dimension}: expected ${stableValue(entry.expected, { max: 260 })}; got ${stableValue(entry.actual, { max: 260 })}`);
      }
      if (result.actual !== null && result.actual !== undefined) lines.push(`      actual: ${stableValue(result.actual, { max: 400 })}`);
    }
    if (result.recovery) lines.push(`      recovery: ${stableValue(result.recovery, { max: 240 })}`);
    if (result.limitations?.length) lines.push(`      limitations: ${result.limitations.join('; ')}`);
    const exits = (result.processes ?? []).map((row) => row.code).filter((code) => code !== 0).length;
    lines.push(`      ${result.processes.length} process(es), ${exits} non-zero exit(s), ${result.measurements.length} measurement(s)`);
  }
  lines.push('', 'Dimensions (each measured only where asserted; null is not a pass):');
  for (const dimension of PILOT_DIMENSIONS) {
    const entry = summary.dimensions[dimension];
    lines.push(`  ${dimension.padEnd(14)} ${entry.total === 0 ? 'n/a' : `${entry.passed}/${entry.total}`}`);
  }
  if (Object.keys(summary.workflows).length > 0) {
    lines.push('', 'Workflows:');
    for (const [name, entry] of Object.entries(summary.workflows)) lines.push(`  ${name.padEnd(6)} ${entry.passed}/${entry.total}`);
  }
  lines.push('', 'Areas:');
  for (const [name, entry] of Object.entries(summary.areas)) lines.push(`  ${name.padEnd(20)} ${entry.passed}/${entry.total}`);
  if (Object.keys(summary.failureClasses).length > 0) {
    lines.push('', 'Failure classes:');
    for (const [name, count] of Object.entries(summary.failureClasses)) lines.push(`  ${name.padEnd(22)} ${count}`);
  }
  lines.push('', `Processes: ${summary.processes.total} started, ${summary.processes.nonZeroExits} non-zero exit(s), ${summary.processes.timedOut} timed out.`);
  lines.push(`Measurements: ${summary.measurements} recorded separately from outcomes (see the measurements section).`);
  lines.push('', 'Real processes, real local files and real clocks. No model inference is used or contacted.');
  return lines.join('\n');
}

export { check, stableValue };
