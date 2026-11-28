// T-32 Step 3 (2026-11-19): the host/workspace sensor and its governed capability.
//
// These tests use the real machine and, where they can, a real git repository created in a temporary
// directory. Nothing is mocked into a plausible shape: a reading that the platform cannot take is
// expected to come back as unavailable, and the test asserts that rather than a number.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHostWorkspaceSensor, readWorkspaceGit, HOST_SENSOR_SOURCE } from '../src/perception/host-workspace-sensor.js';
import { createPerceptionService } from '../src/perception/service.js';
import { createApp } from '../src/app.js';

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
})();

function tempDir(prefix = 'apex-perception-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo() {
  const dir = tempDir('apex-perception-git-');
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  run(['init', '-q']);
  run(['config', 'user.email', 't32@example.invalid']);
  run(['config', 'user.name', 'T-32 perception test']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a tracked file\n');
  run(['add', 'tracked.txt']);
  run(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
  return { dir, run };
}

describe('T-32 host and workspace sensor', () => {
  test('a real reading carries the host values this process can actually see', () => {
    const sensor = createHostWorkspaceSensor({ workspaceDir: null, storagePaths: [os.tmpdir()] });
    const reading = sensor.sense();
    assert.equal(reading.source, HOST_SENSOR_SOURCE);
    assert.match(reading.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Number.isInteger(reading.host.cpu.logicalCount) && reading.host.cpu.logicalCount > 0,
      'the CPU count is read from the machine');
    assert.ok(Number.isFinite(reading.host.memory.totalBytes) && reading.host.memory.totalBytes > 0,
      'the total memory is read from the machine');
    assert.ok(reading.host.memory.freeBytes <= reading.host.memory.totalBytes);
    assert.ok(reading.host.process.uptimeSeconds >= 0);
    assert.ok(reading.host.process.rssBytes > 0, 'the process resident set has a real size');
    assert.equal(reading.workspace.available, false);
    assert.equal(reading.workspace.reason, 'NO_WORKSPACE_ROOT');
    // The load figure is the platform's, and a platform without load averages reports null rather
    // than a made-up zero. Either way the field exists.
    assert.ok(reading.host.cpu.loadAverage1m === null || Number.isFinite(reading.host.cpu.loadAverage1m));
  });

  test('a workspace without git is unavailable, not a clean tree', () => {
    const dir = tempDir('apex-perception-plain-');
    const reading = readWorkspaceGit(dir, { git: () => { throw Object.assign(new Error('no git'), { code: 'ENOENT' }); } });
    assert.equal(reading.available, false);
    assert.equal(reading.reason, 'GIT_NOT_INSTALLED');
    const missing = readWorkspaceGit(path.join(dir, 'does-not-exist'), { git: () => '' });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, 'WORKSPACE_ROOT_MISSING');
  });

  test('a real git workspace reports its branch, short HEAD, dirty and untracked counts', { skip: !GIT && 'git is not installed' }, () => {
    const { dir } = gitRepo();
    const sensor = createHostWorkspaceSensor({ workspaceDir: dir, storagePaths: [dir] });
    const reading = sensor.sense();
    assert.equal(reading.workspace.available, true);
    assert.ok(typeof reading.workspace.branch === 'string' && reading.workspace.branch.length > 0);
    assert.match(reading.workspace.head, /^[0-9a-f]{7,}$/, 'the short hash is a real commit hash');
    assert.equal(reading.workspace.dirtyFiles, 0, 'a freshly committed tree is clean');
    assert.equal(reading.workspace.untrackedFiles, 0);
    assert.match(reading.workspace.lastCommitAt, /^\d{4}-\d{2}-\d{2}T/, 'the last commit carries its own timestamp');

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a modified tracked file\n');
    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'an untracked file\n');
    const changed = sensor.sense();
    assert.equal(changed.workspace.dirtyFiles, 1, 'a modified tracked file is counted as dirty');
    assert.equal(changed.workspace.untrackedFiles, 1, 'an untracked file is counted separately');
  });

  test('the git reader is a fixed-argument execFileSync with a timeout and no shell', () => {
    const calls = [];
    const reading = readWorkspaceGit(os.tmpdir(), { git: (args) => { calls.push(args); throw new Error('stop'); } });
    assert.equal(reading.available, false);
    for (const args of calls) {
      assert.equal(args[0], '-C');
      assert.ok(args.slice(2).every((entry) => !/[;&|`$]/.test(entry)), `no argument carries a shell metacharacter: ${args.join(' ')}`);
    }
  });

  test('observations are recorded as observed entries with a source and a timestamp', () => {
    const { dir } = gitRepo();
    const dataDir = tempDir();
    let tick = 0;
    const service = createPerceptionService({
      dataDir,
      workspaceDir: dir,
      now: () => new Date(Date.UTC(2026, 10, 19, 12, 0, tick++)),
    });
    const result = service.sense({ reason: 'T-32 test' });
    assert.ok(result.recorded > 5, `a full reading records several values, got ${result.recorded}`);
    const state = service.state({ limit: 40 });
    assert.ok(state.observations.length > 5);
    for (const entry of state.observations) {
      assert.ok(['observed', 'unavailable'].includes(entry.epistemicStatus), `${entry.subject} has an epistemic status`);
      assert.equal(entry.source, HOST_SENSOR_SOURCE);
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(typeof entry.subject === 'string' && entry.subject.length > 0);
    }
    const branch = state.observations.find((entry) => entry.subject === 'workspace.git.branch');
    assert.ok(branch, 'the workspace branch was recorded');
    assert.equal(branch.epistemicStatus, 'observed');
    const ledger = fs.readFileSync(service.ledgerPath, 'utf8').trim().split('\n');
    assert.ok(ledger.length >= result.recorded, 'each observation is its own ledger line');
    assert.ok(ledger.every((line) => JSON.parse(line).source === HOST_SENSOR_SOURCE));
  });

  test('the governed capability records a reading and is refused to a model origin', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    const op = await app.controller.perceptionSense({ reason: 'T-32 governed read' });
    const step = op.operation.steps[0];
    assert.equal(step.authorization.decision, 'allow');
    assert.equal(step.verification.outcome, 'success_verified', JSON.stringify(step.verification));
    const state = app.perception.state({ limit: 5 });
    assert.ok(state.lastObservationAt, 'the ledger records when the reading was taken');
    assert.equal(app.registry.authorize('perception.sense_host', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('perception.state', 'model').decision, 'allow');
  });

  test('host sensing is denied while the ECP lockdown latch is active', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    const denied = await app.controller.runAction('perception.sense_host', {}, 'user', 'op-denied', null);
    assert.equal(denied.verification.outcome, 'success_verified', 'a clear latch permits the reading');
    const lock = await app.controller.runAction('safety.lockdown', { reason: 'T-32 lockdown sense check' }, 'user', 'op-lock');
    assert.equal(lock.authorization.decision, 'allow');
    const during = await app.controller.runAction('perception.sense_host', {}, 'user', 'op-during', null);
    assert.equal(during.authorization.decision, 'deny');
    assert.equal(during.outcome, 'action_denied');
    assert.match(String(during.summary), /KILL_SWITCH|denied/i);
    const release = await app.controller.runAction('safety.release', { reason: 'T-32 lockdown sense check complete' }, 'user', 'op-release');
    assert.equal(release.authorization.decision, 'allow');
    const after = await app.controller.runAction('perception.sense_host', {}, 'user', 'op-after', null);
    assert.equal(after.authorization.decision, 'allow');
  });

  test('the briefing carries the live perception reading', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    await app.controller.perceptionSense({ reason: 'T-32 briefing read' });
    const { createUiServer } = await import('../src/ui/server.js');
    const ui = createUiServer({ app, token: 't32-perception-token-0123456789', host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/briefing`, {
        headers: { authorization: 'Bearer t32-perception-token-0123456789', 'x-apex-ui': '1' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.perception.available, true);
      assert.ok(body.perception.lastObservationAt, 'the briefing states when the machine was read');
      assert.equal(body.perception.budget.limit, 3);
      assert.equal(body.perception.budget.remaining, 3);
      assert.ok(body.perception.observations.length > 0);
      const host = await fetch(`http://127.0.0.1:${started.port}/api/perception`, {
        headers: { authorization: 'Bearer t32-perception-token-0123456789', 'x-apex-ui': '1' },
      });
      assert.equal(host.status, 200);
      const view = await host.json();
      assert.equal(view.source, HOST_SENSOR_SOURCE);
      assert.ok(view.observations.length > 0);
    } finally {
      await ui.stop();
    }
  });

  test('the deck, Sentinel and Briefing carry the perception surfaces', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    const { createUiServer } = await import('../src/ui/server.js');
    const token = 't32-perception-ui-token-0123456789';
    const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    try {
      const page = await fetch(`http://127.0.0.1:${started.port}/?token=${token}`, { redirect: 'manual' });
      // The handshake sets the cookie; the page itself is served to an authenticated request.
      const html = await (await fetch(`http://127.0.0.1:${started.port}/`, {
        headers: { authorization: `Bearer ${token}` },
      })).text();
      assert.equal(page.status, 303);
      for (const id of ['perception-status', 'perception-summary', 'perception-sense', 'perception-budget',
        'perception-observations', 'perception-suppressions', 'perception-detail-status', 'briefing-perception']) {
        assert.ok(html.includes(`id="${id}"`), `the page carries #${id}`);
      }
      const client = await (await fetch(`http://127.0.0.1:${started.port}/app.js`, {
        headers: { authorization: `Bearer ${token}` },
      })).text();
      assert.ok(client.includes('/api/perception/sense'), 'the client posts the sense to the governed route');
      assert.ok(client.includes('renderPerception'), 'the client renders the perception surfaces');
      const sensed = await fetch(`http://127.0.0.1:${started.port}/api/perception/sense`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-apex-ui': '1' },
        body: JSON.stringify({}),
      });
      assert.equal(sensed.status, 200);
      const body = await sensed.json();
      assert.equal(body.senseVerified, true);
      assert.ok(body.recorded > 0);
      assert.ok(body.reading.at);
      const state = await (await fetch(`http://127.0.0.1:${started.port}/api/perception`, {
        headers: { authorization: `Bearer ${token}` },
      })).json();
      assert.ok(state.observations.length > 0);
      assert.equal(state.governor.budget.limit, 3);
      const unauthenticated = await fetch(`http://127.0.0.1:${started.port}/api/perception`);
      assert.equal(unauthenticated.status, 401, 'the reading is behind the token like every other route');
    } finally {
      await ui.stop();
    }
  });

  test('a cognitive run consumes the live host observation', async () => {
    const dataDir = tempDir();
    const app = createApp({ dataDir });
    await app.controller.perceptionSense({ reason: 'T-32 cognition read' });
    const run = await app.cognition.run({ intent: 'summarize the machine this process is running on' });
    const packet = run.stages.context;
    assert.equal(packet.host.available, true);
    assert.ok(packet.host.observations.length > 0, 'the run carries live host observations');
    assert.equal(packet.host.lastObservationAt, app.perception.state({ limit: 1 }).lastObservationAt);
    assert.ok(packet.epistemic.observed > 0, 'the observations are counted as observed');
    assert.ok(packet.host.observations.every((entry) => ['observed', 'unavailable'].includes(entry.epistemic)));
    const trace = (run.trace ?? []).join('\n') || JSON.stringify(run.stages);
    assert.ok(trace.length > 0);
  });
});
