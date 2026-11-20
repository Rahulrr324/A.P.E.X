// T-30 Package 5 (2026-11-19): the zero-dependency thin desktop shell.
//
// The shell is verified without a browser: command construction, per-platform resolution,
// the dry run, the honest no-browser fallback, and lifecycle cleanup are all observable
// through the injectable spawner and the real loopback server. Nothing here claims a window
// was opened; the tests assert what was launched, not what was seen.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { browserCandidates, createDesktopShell, desktopPort, isExecutable, launchSpec, resolveBrowser } from '../src/ui/desktop-shell.js';

const dirs = [];
const shells = [];

afterEach(async () => {
  while (shells.length) await shells.pop().stop().catch(() => {});
  while (dirs.length) cleanup(dirs.pop());
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function newApp(dir) {
  return createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
}

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    const handlers = {};
    const child = {
      pid: 4242,
      killed: null,
      on(event, handler) { (handlers[event] ||= []).push(handler); return child; },
      emit(event, payload) { for (const handler of handlers[event] ?? []) handler(payload); },
      kill(signal) { this.killed = signal; return true; },
    };
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

describe('desktop shell: browser resolution and command construction', () => {
  test('a configured browser is tried first, then the platform is searched Edge first and Chrome or Chromium next', () => {
    const win = browserCandidates({ platform: 'win32', env: { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', APEX_DESKTOP_BROWSER_BIN: 'D:\\edge.exe' } });
    assert.equal(win[0].id, 'env', 'an explicit setting outranks discovery: it is the owner naming a browser');
    assert.equal(win[0].command, 'D:\\edge.exe');
    assert.match(win[1].command, /Microsoft\\Edge\\Application\\msedge\.exe$/);
    assert.ok(win.some((entry) => /chrome\.exe$/i.test(entry.command) && entry.id !== 'env'));
    const discovered = browserCandidates({ platform: 'win32', env: { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' } });
    assert.match(discovered[0].command, /Microsoft\\Edge\\Application\\msedge\.exe$/, 'without a configured browser the ADR order is unchanged');
    assert.equal(discovered.some((entry) => entry.id === 'env'), false);

    const mac = browserCandidates({ platform: 'darwin', env: {} });
    assert.equal(mac[0].command, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    assert.ok(mac.some((entry) => entry.command.includes('Google Chrome.app')));

    const linux = browserCandidates({ platform: 'linux', env: {} });
    assert.deepEqual(linux.slice(0, 2).map((entry) => entry.command), ['microsoft-edge', 'microsoft-edge-stable']);
    assert.ok(linux.some((entry) => entry.command === 'chromium'));
  });

  test('a configured browser wins even when a system one is installed', () => {
    const candidates = browserCandidates({ platform: 'linux', env: { APEX_DESKTOP_BROWSER_BIN: '/opt/owner/edge' } });
    const resolved = resolveBrowser({
      platform: 'linux',
      candidates,
      executable: (command) => command === '/opt/owner/edge' || command === 'microsoft-edge',
    });
    assert.equal(resolved.executable, '/opt/owner/edge', 'the configured binary is chosen, not the installed Edge');
    assert.equal(resolved.browser.id, 'env');
    assert.equal(resolved.tried[0], '/opt/owner/edge', 'the printed "tried" list names the configured binary first');
  });

  test('resolution picks the first candidate that exists and reports everything it tried', () => {
    const candidates = [
      { id: 'a', label: 'a', command: '/nonexistent/edge' },
      { id: 'b', label: 'b', command: '/opt/chrome' },
      { id: 'c', label: 'c', command: '/opt/chromium' },
    ];
    const resolved = resolveBrowser({ platform: 'linux', candidates, executable: (command) => command === '/opt/chrome' });
    assert.equal(resolved.executable, '/opt/chrome');
    assert.equal(resolved.browser.id, 'b');
    assert.deepEqual(resolved.tried, ['/nonexistent/edge', '/opt/chrome', '/opt/chromium']);

    const none = resolveBrowser({ platform: 'linux', candidates, executable: () => false });
    assert.equal(none.browser, null);
    assert.equal(none.executable, null);
    assert.equal(none.tried.length, 3);
  });

  test('a bare command name is searched on PATH, and a missing one is not executable', () => {
    const dir = tempDir();
    const binary = platformBinary(dir, 'fake-chrome');
    const found = isExecutable('fake-chrome', { platform: 'linux', env: { PATH: dir } });
    if (process.platform === 'win32') {
      assert.equal(found, false, 'a Windows search appends PATHEXT; the fixture has no extension');
    } else {
      assert.equal(found, true, `found ${binary} on PATH`);
    }
    assert.equal(isExecutable('definitely-not-a-browser-xyz', { platform: 'linux', env: { PATH: dir } }), false);
  });

  test('the launch specification is an --app frame with an isolated profile and no shell interpolation', () => {
    const spec = launchSpec({ url: 'http://127.0.0.1:8787/?token=abc', executable: '/opt/chrome', profileDir: '/tmp/apex/desktop-profile' });
    assert.deepEqual(spec.args.slice(0, 2), ['--app=http://127.0.0.1:8787/?token=abc', '--user-data-dir=/tmp/apex/desktop-profile']);
    assert.ok(spec.args.includes('--no-first-run'));
    assert.ok(spec.args.every((arg) => !/[;&|`$]/.test(arg)), 'no argument is a shell fragment: the executable is spawned directly');
    assert.equal(spec.schema, 'apex.desktop.shell/1');
  });

  test('the port comes from an explicit value, then the environment, then the kernel', () => {
    assert.equal(desktopPort({}, null), 0);
    assert.equal(desktopPort({ APEX_DESKTOP_PORT: '8799' }, null), 8799);
    assert.equal(desktopPort({ APEX_DESKTOP_PORT: '8799' }, 1234), 1234);
    assert.throws(() => desktopPort({ APEX_DESKTOP_PORT: 'http' }, null), /whole-number port/);
    assert.throws(() => desktopPort({}, 70000), /whole-number port/);
  });
});

function platformBinary(dir, name) {
  const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

describe('desktop shell: server lifecycle', () => {
  test('plan() starts a loopback server, waits for /api/state, and names the isolated profile', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const browser = platformBinary(dir, 'chromium');
    const shell = createDesktopShell({
      app, dataDir: dir, env: { PATH: dir, APEX_DESKTOP_BROWSER_BIN: browser }, platform: 'linux', readinessTimeoutMs: 10000,
    });
    shells.push(shell);
    const planned = await shell.plan();
    assert.equal(planned.ready, true);
    assert.match(planned.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.equal(planned.port > 0, true);
    assert.equal(planned.found, true, 'the injected binary is found');
    assert.equal(planned.profileDir, path.join(dir, 'desktop-profile'));
    assert.equal(fs.statSync(planned.profileDir).isDirectory(), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(planned.profileDir).mode & 0o777, 0o700, 'the profile is owner-only');
    }
    assert.ok(planned.spec.args[0].startsWith('--app=' + planned.url));
  });

  test('launch({dryRun}) resolves everything and spawns nothing; the server still stops cleanly', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const browser = platformBinary(dir, 'chromium');
    const { spawn, calls } = fakeSpawn();
    const shell = createDesktopShell({
      app, dataDir: dir, env: { PATH: dir, APEX_DESKTOP_BROWSER_BIN: browser }, platform: 'linux', spawn, readinessTimeoutMs: 10000,
    });
    shells.push(shell);
    const planned = await shell.launch({ dryRun: true });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.spawned, false);
    assert.equal(calls.length, 0, 'a dry run starts no process');
    const url = planned.url;
    const port = planned.port;
    await shell.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/state`), 'the server is closed after stop()');
    assert.ok(url.startsWith('http://127.0.0.1:'));
  });

  test('launch() spawns the resolved executable with the app-frame arguments', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const browser = platformBinary(dir, 'chromium');
    const { spawn, calls } = fakeSpawn();
    const shell = createDesktopShell({
      app, dataDir: dir, env: { PATH: dir, APEX_DESKTOP_BROWSER_BIN: browser }, platform: 'linux', spawn, readinessTimeoutMs: 10000,
    });
    shells.push(shell);
    const launched = await shell.launch();
    assert.equal(launched.spawned, true);
    assert.equal(launched.pid, 4242);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, fs.realpathSync(browser));
    assert.deepEqual(calls[0].args.slice(0, 2), ['--app=' + launched.url, `--user-data-dir=${path.join(dir, 'desktop-profile')}`]);
    assert.equal(calls[0].options.detached, false, 'the shell keeps the child so it can stop it');
    await shell.stop();
    assert.equal(calls[0].child.killed, 'SIGTERM', 'the window process is terminated on stop');
  });

  test('with no browser installed the shell reports honestly, starts nothing, and keeps the URL usable', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const { spawn } = fakeSpawn();
    const shell = createDesktopShell({
      app, dataDir: dir, env: { PATH: '' }, platform: 'linux',
      candidates: [{ id: 'none', label: 'none', command: '/definitely/not/here' }], spawn, readinessTimeoutMs: 10000,
    });
    shells.push(shell);
    const launched = await shell.launch();
    assert.equal(launched.spawned, false);
    assert.equal(launched.fallback, true);
    assert.match(launched.diagnostic, /No Chromium-family browser was found/);
    assert.equal(launched.spec, null);
    const token = new URL(launched.url).searchParams.get('token');
    const response = await fetch(`http://127.0.0.1:${launched.port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, 'the loopback state read is still served without a browser');
    await shell.stop();
  });

  test('stop() twice is harmless and status() reports what is running', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const shell = createDesktopShell({ app, dataDir: dir, env: { PATH: '' }, platform: 'linux', candidates: [], readinessTimeoutMs: 10000 });
    shells.push(shell);
    assert.equal(shell.status().started, false);
    await shell.start();
    assert.equal(shell.status().started, true);
    assert.equal(shell.status().childPid, null);
    await shell.stop();
    await shell.stop();
    assert.equal(shell.status().started, true, 'status keeps reporting the last started state rather than pretending a restart');
  });
});

describe('desktop shell: the CLI entry point', () => {
  function runNode(script, args, env) {
    return new Promise((resolve) => {
      execFile(process.execPath, [script, ...args], { env, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    });
  }

  test('`node src/cli.js desktop --dry-run` prints the resolved launch specification without a browser', async () => {
    const dir = tempDir();
    const browser = platformBinary(dir, 'chromium');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
    const result = await runNode(script, ['desktop', '--dry-run'], cleanEnv({
      APEX_DATA_DIR: dir,
      APEX_DESKTOP_BROWSER_BIN: browser,
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /APEX desktop shell apex\.desktop\.shell\/1/);
    assert.match(result.stdout, /Loopback interface: http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.match(result.stdout, /Command: .*--app=http:\/\/127\.0\.0\.1:\d+/);
    assert.match(result.stdout, /Dry run: nothing was started/);
  });

  test('`desktop --print-launch-spec` emits machine-readable JSON and exits 0', async () => {
    const dir = tempDir();
    const browser = platformBinary(dir, 'chromium');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
    const result = await runNode(script, ['desktop', '--print-launch-spec'], cleanEnv({
      APEX_DATA_DIR: dir,
      APEX_DESKTOP_BROWSER_BIN: browser,
    }));
    assert.equal(result.code, 0, result.stderr);
    const spec = JSON.parse(result.stdout);
    assert.equal(spec.schema, 'apex.desktop.shell/1');
    assert.equal(spec.found, true);
    assert.equal(spec.ready, true);
    assert.equal(spec.spec.executable, fs.realpathSync(browser));
    assert.ok(spec.spec.args[0].startsWith('--app='));
  });

  test('with no browser on PATH the CLI still exits 0 and says what to open', async () => {
    const dir = tempDir();
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
    const env = cleanEnv({ APEX_DATA_DIR: dir });
    env.PATH = path.join(dir, 'empty-path');
    fs.mkdirSync(env.PATH, { recursive: true });
    const result = await runNode(script, ['desktop', '--dry-run'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /No Chromium-family browser was found/);
    assert.match(result.stdout, /Loopback interface: http/);
  });
});
