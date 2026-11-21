// T-36 Step 3 (2026-11-21): the Windows desktop launcher, on a brand-new data directory.
//
// The owner's first launch is the moment the whole thing has to work without help. These tests
// cover the two things the shell now does that it did not before:
//
//   * the cold-start bootstrap runs before the window opens, through the controller, so the ECP
//     authorizes it and the operation is audited;
//   * the startup banner names the loopback URL, the resolved browser, the data directory, the
//     doctor's own count and the autonomy profile - and every one of those is a measured value.
//
// No browser is launched here. The shell's spawner is injectable, and the server is the real
// loopback server, so what is asserted is what was launched and what was reported, not what a
// window looked like.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { createDesktopShell } from '../src/ui/desktop-shell.js';
import { LOCAL_WORKSTATION_DEVICE_ID } from '../src/system/bootstrap.js';

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

function platformBinary(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runNode(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

describe('T-36: the desktop launcher cold-starts the workstation', () => {
  test('the shell bootstraps before it opens the window, and the workstation is enrolled once', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const { spawn, calls } = fakeSpawn();
    const shell = createDesktopShell({ app, spawn, executable: () => null, candidates: [] });
    shells.push(shell);
    const planned = await shell.launch({ dryRun: true });
    assert.equal(calls.length, 0, 'a dry run spawns nothing');

    // The bootstrap ran, through the controller, so the ECP authorized it.
    const devices = await app.deviceTrust.list();
    assert.equal(devices.length, 1, 'the local workstation is enrolled');
    assert.equal(devices[0].deviceId, LOCAL_WORKSTATION_DEVICE_ID);
    assert.equal(app.bootstrap.isBootstrapped(), true, 'the marker is on disk');
    assert.ok(planned.bootstrap, 'the plan carries the bootstrap outcome');
    assert.equal(planned.bootstrap.verifiedChecks, 4, 'all four bootstrap checks were verified');
  });

  test('a second launch does not enrol a second workstation', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const { spawn } = fakeSpawn();
    const shell = createDesktopShell({ app, spawn, executable: () => null, candidates: [] });
    shells.push(shell);
    await shell.launch({ dryRun: true });
    await shell.launch({ dryRun: true });
    const devices = await app.deviceTrust.list();
    assert.equal(devices.length, 1, 'still exactly one device');
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'system-bootstrap.json'), 'utf8'));
    assert.equal(marker.runs, 2, 'but the readings were taken twice');
  });

  test('--no-bootstrap leaves the data directory alone', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const { spawn } = fakeSpawn();
    const shell = createDesktopShell({ app, spawn, executable: () => null, candidates: [], bootstrap: false });
    shells.push(shell);
    const planned = await shell.launch({ dryRun: true });
    assert.equal(planned.bootstrap.skipped, true, 'the shell says it skipped the bootstrap');
    assert.equal(app.bootstrap.isBootstrapped(), false, 'and the directory is still unseeded');
    assert.deepEqual(await app.deviceTrust.list(), [], 'no device was enrolled');
  });

  test('with the lockdown latch engaged the shell does not bootstrap, and says why', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    await app.controller.runAction('safety.lockdown', { reason: 'the owner locked the system down' }, 'user', 'op-lock');
    const { spawn } = fakeSpawn();
    const shell = createDesktopShell({ app, spawn, executable: () => null, candidates: [] });
    shells.push(shell);
    const planned = await shell.launch({ dryRun: true });
    assert.equal(planned.bootstrap.skipped, true);
    assert.match(planned.bootstrap.reason, /lockdown/i);
    assert.equal(app.bootstrap.isBootstrapped(), false, 'nothing was written');
  });

  test('the startup banner names the URL, the browser, the data directory, the doctor and the autonomy profile', async () => {
    const dir = tempDir();
    const app = newApp(dir);
    const binary = platformBinary(dir, 'chromium');
    const { spawn } = fakeSpawn();
    // A real resolution over a real executable file, so the banner row is what the resolver found
    // rather than what a stub was told to say.
    const shell = createDesktopShell({
      app, spawn, candidates: [{ id: 'env', label: 'APEX_DESKTOP_BROWSER_BIN', command: binary }],
    });
    shells.push(shell);
    const planned = await shell.launch({ dryRun: true });
    const banner = shell.banner(planned);
    const lines = banner.split('\n');
    assert.match(lines[0], /APEX desktop shell apex\.desktop\.shell\/1/);
    assert.match(banner, /Command Deck\s+http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.match(banner, new RegExp('Browser\\s+' + escapeRegExp(binary)));
    assert.match(banner, new RegExp('Data directory\\s+' + escapeRegExp(dir)));
    // The doctor row is the doctor's own count: "passed/total ok (status)".
    assert.match(banner, /Doctor\s+\d+\/\d+ ok \((ok|degraded|failed)\)/);
    assert.match(banner, /Autonomy\s+(not configured|.*=L\d)/);
    assert.match(banner, /Bootstrap\s+(ok|degraded|failed)/);
  });

  test('`node src/cli.js desktop --dry-run` prints the banner and still starts nothing', async () => {
    const dir = tempDir();
    const browser = platformBinary(dir, 'chromium');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
    const result = await runNode(script, ['desktop', '--dry-run'], cleanEnv({
      APEX_DATA_DIR: dir,
      APEX_DESKTOP_BROWSER_BIN: browser,
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /APEX desktop shell apex\.desktop\.shell\/1/);
    assert.match(result.stdout, /Command Deck\s+http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.match(result.stdout, /Data directory\s+/);
    assert.match(result.stdout, /Doctor\s+\d+\/\d+ ok/);
    assert.match(result.stdout, /Autonomy\s+/);
    assert.match(result.stdout, /Bootstrap\s+(ok|degraded|failed)/);
    assert.match(result.stdout, /Dry run: nothing was started/);
    // And the cold start really happened in that process.
    assert.equal(fs.existsSync(path.join(dir, 'system-bootstrap.json')), true, 'the bootstrap marker was written');
  });

  test('`node src/cli.js desktop --no-bootstrap` leaves the directory unseeded', async () => {
    const dir = tempDir();
    const browser = platformBinary(dir, 'chromium');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
    const result = await runNode(script, ['desktop', '--dry-run', '--no-bootstrap'], cleanEnv({
      APEX_DATA_DIR: dir,
      APEX_DESKTOP_BROWSER_BIN: browser,
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Bootstrap\s+skipped/);
    assert.equal(fs.existsSync(path.join(dir, 'system-bootstrap.json')), false, 'nothing was written');
  });
});
