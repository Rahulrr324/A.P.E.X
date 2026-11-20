// Zero-dependency thin desktop shell (T-30 Package 5; decision recorded in
// reports/T30_P5_DESKTOP_SHELL_ADR.md, option A: a loopback browser + thin shell).
//
// What this module is: a launcher. It starts the existing loopback UI server, waits until
// `/api/state` answers, resolves a Chromium-family executable, and starts it with
// `--app=<loopback url>` and a profile directory of its own under the APEX data directory.
//
// What it is not: a second authority. It never reads the data directory's stores, never holds
// the ECP, and never makes an authorization decision. Every request the window makes goes
// through the same HTTP API, the same per-process token and the same ECP as a browser tab.
// The shell also owns the lifecycle: it stops the server when the shell exits, on SIGINT and
// on SIGTERM, so a closed window cannot leave a listening socket behind.
//
// Everything the shell would do can be inspected without doing it: `plan()` returns the exact
// launch specification, `launch({ dryRun: true })` returns it without spawning, and the spawner
// is injectable, so the behaviour is testable on a machine with no browser installed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createUiServer } from './server.js';

export const DESKTOP_SCHEMA = 'apex.desktop.shell/1';
export const DEFAULT_HOST = '127.0.0.1';
export const READY_PATH = '/api/state';
export const PROFILE_DIR_NAME = 'desktop-profile';

// The port: an explicit number, else APEX_DESKTOP_PORT, else 0 (the kernel picks a free
// loopback port, so two APEX instances never fight over one).
export function desktopPort(env = process.env, requested = null) {
  const source = requested ?? (env.APEX_DESKTOP_PORT ?? env.APEX_UI_PORT ?? '');
  if (source === '' || source === null || source === undefined) return 0;
  const port = Number(source);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`the desktop shell needs a whole-number port from 0 to 65535, not "${source}"`);
  }
  return port;
}

function winCandidates(env) {
  const roots = [
    env['PROGRAMFILES(X86)'], env['ProgramFiles(x86)'], env['PROGRAMFILES'], env.ProgramFiles, env.LOCALAPPDATA, env.LocalAppData,
  ].filter((root) => typeof root === 'string' && root.length > 0);
  const relative = [
    ['msedge', path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['chrome', path.join('Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chromium', path.join('Chromium', 'Application', 'chrome.exe')],
  ];
  const list = [];
  for (const [id, suffix] of relative) {
    for (const root of roots) {
      list.push({ id, label: path.win32.basename(suffix), command: path.win32.join(root, suffix) });
    }
    // A bare name is also tried, so an executable on PATH is found without knowing where it lives.
    list.push({ id, label: path.win32.basename(suffix), command: path.win32.basename(suffix) });
  }
  return list;
}

function macCandidates() {
  return [
    { id: 'msedge', label: 'Microsoft Edge', command: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { id: 'chrome', label: 'Google Chrome', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { id: 'chrome-beta', label: 'Google Chrome Beta', command: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta' },
    { id: 'chromium', label: 'Chromium', command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  ];
}

function linuxCandidates() {
  return [
    { id: 'msedge', label: 'microsoft-edge', command: 'microsoft-edge' },
    { id: 'msedge-stable', label: 'microsoft-edge-stable', command: 'microsoft-edge-stable' },
    { id: 'chrome', label: 'google-chrome', command: 'google-chrome' },
    { id: 'chrome-stable', label: 'google-chrome-stable', command: 'google-chrome-stable' },
    { id: 'chromium', label: 'chromium', command: 'chromium' },
    { id: 'chromium-browser', label: 'chromium-browser', command: 'chromium-browser' },
  ];
}

// Priority order: the owner's explicit choice first, then the discovery order the ADR names (the
// platform's Edge, then Chrome or Chromium). `--browser` replaces this list entirely, so it wins
// over everything; `APEX_DESKTOP_BROWSER_BIN` is tried before discovery.
//
// The override used to be appended last, as the first draft of the ADR ordered it. A CI runner with
// /usr/bin/microsoft-edge then ignored the configured binary and launched Edge instead, which is
// what a configured browser silently losing to an installed one looks like in practice. An explicit
// setting is the owner's instruction, not a fallback, so it now comes first and discovery answers
// only when nothing was configured.
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  const list = platform === 'win32' ? winCandidates(env)
    : platform === 'darwin' ? macCandidates()
      : linuxCandidates();
  const override = typeof env.APEX_DESKTOP_BROWSER_BIN === 'string' ? env.APEX_DESKTOP_BROWSER_BIN.trim() : '';
  if (override.length > 0) list.unshift({ id: 'env', label: 'APEX_DESKTOP_BROWSER_BIN', command: override });
  return list;
}

// Deterministic resolution: a path is tested directly; a bare name is searched on PATH. It
// returns the absolute file so the printed command names a real executable rather than a name
// that happens to resolve in this shell's environment.
export function findExecutable(command, { platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const hasSeparator = command.includes('/') || (platform === 'win32' && command.includes('\\'));
  const test = (candidate) => {
    try {
      fsImpl.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return fsImpl.statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  };
  if (hasSeparator) return test(command);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const directories = String(env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${platform === 'win32' && !command.toLowerCase().endsWith(extension.toLowerCase()) ? extension : ''}`);
      const found = test(candidate);
      if (found) return found;
    }
  }
  return null;
}

export function isExecutable(command, options = {}) {
  return findExecutable(command, options) !== null;
}

export function resolveBrowser({ platform = process.platform, env = process.env, candidates = null, executable = findExecutable } = {}) {
  const tried = candidates ?? browserCandidates({ platform, env });
  for (const candidate of tried) {
    const found = executable(candidate.command, { platform, env });
    if (found) {
      return {
        browser: candidate,
        executable: typeof found === 'string' ? found : candidate.command,
        tried: tried.map((entry) => entry.command),
      };
    }
  }
  return { browser: null, executable: null, tried: tried.map((entry) => entry.command) };
}

// The exact argument vector the shell would use. `--app=` gives the frameless application frame;
// the profile directory keeps this window out of the owner's everyday browser profile; the two
// `--no-…` flags stop first-run UI from interrupting a window that is meant to be an app frame.
export function launchSpec({ url, executable, profileDir }) {
  const args = ['--app=' + url, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
  return { schema: DESKTOP_SCHEMA, executable, args, url, profileDir };
}

export function createDesktopShell({
  app,
  host = DEFAULT_HOST,
  port = null,
  env = process.env,
  platform = process.platform,
  dataDir = app?.dataDir ?? null,
  profileDir = null,
  spawn = nodeSpawn,
  fetchImpl = (...args) => globalThis.fetch(...args),
  executable = findExecutable,
  candidates = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  readinessTimeoutMs = 15000,
  readinessIntervalMs = 100,
  log = () => {},
} = {}) {
  if (!app || typeof app !== 'object') throw new TypeError('the desktop shell needs an APEX application');
  let ui = null;
  let info = null;
  let child = null;
  let stopped = false;
  const resolvedProfile = profileDir ?? (typeof dataDir === 'string' && dataDir.length > 0
    ? path.join(dataDir, PROFILE_DIR_NAME)
    : null);

  async function waitForReady(started) {
    const deadline = now() + readinessTimeoutMs;
    let lastError = null;
    for (;;) {
      try {
        const response = await fetchImpl(`http://${started.host}:${started.port}${READY_PATH}`, {
          headers: { authorization: `Bearer ${started.token}`, 'x-apex-ui': '1' },
        });
        if (response.ok) {
          const body = await response.json().catch(() => null);
          if (body && typeof body === 'object') return true;
          lastError = 'the state read returned no JSON object';
        } else {
          lastError = `the state read answered HTTP ${response.status}`;
        }
      } catch (err) {
        lastError = String(err?.message ?? err);
      }
      if (now() >= deadline) {
        throw new Error(`the loopback interface did not become ready within ${readinessTimeoutMs} ms (${lastError ?? 'no answer'})`);
      }
      await sleep(readinessIntervalMs);
    }
  }

  async function start() {
    if (info) return info;
    const listenPort = desktopPort(env, port);
    ui = createUiServer({ app, host, port: listenPort });
    try {
      info = await ui.start();
    } catch (err) {
      ui = null;
      throw new Error(err?.code === 'EADDRINUSE'
        ? `port ${listenPort} is already in use; set APEX_DESKTOP_PORT to another port or 0 to pick a free one`
        : `the loopback interface could not start: ${err?.message ?? err}`);
    }
    await waitForReady(info);
    log(`serving ${info.url}`);
    return info;
  }

  function profileDirectory() {
    if (!resolvedProfile) return null;
    try {
      fs.mkdirSync(resolvedProfile, { recursive: true, mode: 0o700 });
      return resolvedProfile;
    } catch (err) {
      log(`the profile directory could not be created (${err?.message ?? err}); the browser will use its default profile`);
      return null;
    }
  }

  async function plan() {
    const started = await start();
    const resolution = resolveBrowser({ platform, env, candidates, executable });
    const profile = profileDirectory();
    const spec = resolution.browser
      ? launchSpec({ url: started.url, executable: resolution.executable, profileDir: profile })
      : null;
    return {
      schema: DESKTOP_SCHEMA,
      host: started.host,
      port: started.port,
      url: started.url,
      ready: true,
      browser: resolution.browser,
      executable: resolution.executable,
      tried: resolution.tried,
      profileDir: profile,
      spec,
      found: resolution.browser !== null,
      diagnostic: resolution.browser
        ? null
        : 'No Chromium-family browser was found (Edge, Chrome or Chromium, or APEX_DESKTOP_BROWSER_BIN). The loopback interface is running; open the URL above in any browser.',
    };
  }

  async function launch({ dryRun = false } = {}) {
    const planned = await plan();
    if (dryRun) return { ...planned, spawned: false, dryRun: true };
    if (!planned.found) {
      log(planned.diagnostic);
      log(`Open: ${planned.url}`);
      return { ...planned, spawned: false, dryRun: false, fallback: true };
    }
    child = spawn(planned.spec.executable, planned.spec.args, { detached: false, stdio: 'ignore', windowsHide: false });
    if (child && typeof child.on === 'function') {
      child.on('exit', () => { child = null; });
      child.on('error', (err) => { log(`the browser could not be started: ${err?.message ?? err}`); child = null; });
    }
    log(`started ${planned.executable} with the APEX application frame`);
    log(`Open: ${planned.url}`);
    return { ...planned, spawned: true, dryRun: false, pid: child?.pid ?? null };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child && typeof child.kill === 'function') {
      try { child.kill('SIGTERM'); } catch { /* it is already gone */ }
      child = null;
    }
    if (ui) {
      try { await ui.stop(); } catch { /* the socket is already closed */ }
      ui = null;
    }
  }

  return {
    schema: DESKTOP_SCHEMA,
    start,
    plan,
    launch,
    stop,
    status() {
      return {
        schema: DESKTOP_SCHEMA,
        started: info !== null,
        port: info?.port ?? null,
        url: info?.url ?? null,
        childPid: child?.pid ?? null,
        profileDir: resolvedProfile,
      };
    },
  };
}
