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
// T-36 Step 3 (2026-11-21): the shell now performs the cold-start bootstrap before it opens the
// window, so the owner's very first launch shows a real machine and not an empty deck. The
// bootstrap is the governed capability the ECP authorizes - the shell does not run it behind the
// ECP's back, it asks the controller to run it, exactly as the HTTP route does. With
// `--no-bootstrap` the shell skips it, and with the lockdown latch engaged it is refused.
//
// Everything the shell would do can be inspected without doing it: `plan()` returns the exact
// launch specification, `launch({ dryRun: true })` returns it without spawning, and the spawner
// is injectable, so the behaviour is testable on a machine with no browser installed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createUiServer } from './server.js';
import { browserCandidates, findExecutable, isExecutable, resolveBrowser } from './browser-binary.js';

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

// The browser candidates and the resolution rules moved to `browser-binary.js` in T-31 so the
// real-browser verification suite and this shell choose a browser by exactly the same rules.
// They are re-exported here because this module is the shell's public surface and callers (and
// tests) already import them from it.
export { browserCandidates, findExecutable, isExecutable, resolveBrowser };

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
  // T-36 Step 3: the cold-start bootstrap. It is on by default, it is idempotent, and it is
  // skipped when the owner asks for `--no-bootstrap` or when the lockdown latch is engaged.
  bootstrap = true,
} = {}) {
  if (!app || typeof app !== 'object') throw new TypeError('the desktop shell needs an APEX application');
  let ui = null;
  let info = null;
  let child = null;
  let stopped = false;
  let bootstrapReport = null;
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

  // T-36 Step 3: the cold start. The shell asks the controller to run the governed bootstrap, so
  // the ECP authorizes it and the operation is audited. A locked-down system refuses the write and
  // the shell says so rather than pretending the machine was set up.
  async function runBootstrap({ reason = 'desktop shell cold start' } = {}) {
    if (bootstrap === false) {
      // A skipped bootstrap is still a reported outcome: the banner has to say that it was
      // skipped and why, rather than leaving the row empty as though nothing had been decided.
      bootstrapReport = { skipped: true, reason: 'the owner passed --no-bootstrap' };
      return bootstrapReport;
    }
    const latch = (() => {
      try {
        return app.ecp?.killSwitchStatus?.() ?? null;
      } catch {
        return null;
      }
    })();
    if (latch && (latch.active === true || latch.policyUnavailable === true)) {
      bootstrapReport = {
        skipped: true,
        reason: latch.active === true
          ? 'lockdown is engaged, so the bootstrap was not attempted'
          : 'the safety latch could not be read, so the bootstrap was not attempted',
        lockdown: latch.active === true,
      };
      return bootstrapReport;
    }
    if (!app.controller || typeof app.controller.systemBootstrap !== 'function') {
      bootstrapReport = { skipped: true, reason: 'this application does not carry the workstation bootstrap' };
      return bootstrapReport;
    }
    const result = await app.controller.systemBootstrap({ reason });
    const step = result?.operation?.steps?.[0] ?? null;
    const report = step?.result?.data ?? null;
    bootstrapReport = {
      status: report?.status ?? result?.status ?? 'unknown',
      verified: step?.verification?.outcome === 'success_verified',
      checks: Array.isArray(report?.checks) ? report.checks.length : 0,
      verifiedChecks: Array.isArray(report?.checks) ? report.checks.filter((entry) => entry.verified === true).length : 0,
      doctor: report?.doctor ?? null,
      device: report?.device?.deviceId ?? null,
      workspace: report?.perception?.reading?.workspace?.branch ?? null,
      headline: report?.detail ?? null,
    };
    return bootstrapReport;
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
      bootstrap: bootstrapReport,
      diagnostic: resolution.browser
        ? null
        : 'No Chromium-family browser was found (Edge, Chrome or Chromium, or APEX_DESKTOP_BROWSER_BIN). The loopback interface is running; open the URL above in any browser.',
    };
  }

  // T-36 Step 3: the startup banner. It is a table, because a table is what a person reads at a
  // glance, and every row is a measured value: the loopback URL, the binary that was resolved,
  // the data directory, the doctor's own count and the autonomy profile the ECP holds.
  function banner(planned) {
    const doctor = planned.bootstrap?.doctor ?? null;
    const doctorRow = doctor && Array.isArray(doctor.checks)
      ? doctor.counts.pass + '/' + doctor.checks.length + ' ok (' + doctor.status + ')'
      : 'not read';
    let autonomy = 'not configured';
    try {
      const status = app.ecp?.autonomyStatus?.();
      const configured = status && status.configured ? status.configured : {};
      const entries = Object.entries(configured);
      autonomy = entries.length
        ? entries.map((entry) => entry[0] + '=' + entry[1]).join(', ')
        : 'not configured';
    } catch {
      autonomy = 'unavailable';
    }
    const rows = [
      ['Command Deck', planned.url],
      ['Browser', planned.executable ?? 'none resolved (open the URL above)'],
      ['Data directory', dataDir ?? 'not configured'],
      ['Doctor', doctorRow],
      ['Autonomy', autonomy],
      ['Bootstrap', planned.bootstrap
        ? (planned.bootstrap.skipped
          ? 'skipped (' + planned.bootstrap.reason + ')'
          : planned.bootstrap.status + ' · ' + planned.bootstrap.verifiedChecks + '/' + planned.bootstrap.checks + ' check(s) verified')
        : 'not run'],
    ];
    const width = Math.max(...rows.map((row) => row[0].length));
    const lines = ['APEX desktop shell ' + DESKTOP_SCHEMA];
    for (const row of rows) {
      lines.push('  ' + row[0].padEnd(width) + '  ' + String(row[1]));
    }
    return lines.join('\n');
  }

  async function launch({ dryRun = false, withBootstrap = true } = {}) {
    // The shell's own `bootstrap` option is the single source of the decision; `withBootstrap`
    // only lets a caller decline to attempt it at all, and either way the outcome is recorded so
    // the banner can say what happened instead of leaving the row blank.
    if (withBootstrap) {
      const outcome = await runBootstrap();
      if (outcome?.skipped) log('Bootstrap: ' + outcome.reason);
      else if (outcome) log('Bootstrap: ' + outcome.status + ' · ' + outcome.verifiedChecks + '/' + outcome.checks + ' check(s) verified');
    } else if (!bootstrapReport) {
      bootstrapReport = { skipped: true, reason: 'the launch did not request the bootstrap' };
    }
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
    runBootstrap,
    banner,
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
