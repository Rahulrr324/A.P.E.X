// T-36 Step 1 (2026-11-21): the workstation bootstrap service.
//
// The scenario this file exists for is the one no earlier test covered: a brand-new, unseeded
// data directory. Every other suite starts from a directory that already holds stores, or seeds
// one before it reads. Here the directory is empty, and the claims are the ones the owner would
// make after a first launch on Windows:
//
//   * the bootstrap reads the real machine and the real git repository, and records what it read;
//   * it enrols the local workstation once, and only when nothing else is enrolled;
//   * it creates no task, no goal and no plan - a cold start is not a demo;
//   * running it again changes nothing it should not change;
//   * and with the lockdown latch engaged it writes nothing at all.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { BOOTSTRAP_SCHEMA, LOCAL_WORKSTATION_DEVICE_ID } from '../src/system/bootstrap.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { cleanup(dir); } catch { /* already removed */ }
  }
});

// A real git repository with a committed HEAD, so the workspace sensor reads a real branch and a
// real commit rather than a stub. Git is invoked with fixed arguments and no shell.
function realWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', workspace], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't36@apex.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T-36 fixture'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# T-36 workspace\n');
  execFileSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'T-36 baseline'], { stdio: 'ignore' });
  return workspace;
}

function appFor({ dataDir, workspace = null } = {}) {
  return createApp({
    dataDir,
    ...(workspace ? { filesystemRoot: workspace } : {}),
    gateway: new ModelGateway({ backend: new NoBackend() }),
  });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

describe('T-36: the workstation bootstrap on a brand-new, unseeded data directory', () => {
  test('a cold boot reads the real machine and the real repository, enrols the workstation, and creates nothing synthetic', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const workspace = realWorkspace(root);
    const app = appFor({ dataDir, workspace });

    // The directory really is empty before the bootstrap runs.
    assert.deepEqual(fs.readdirSync(dataDir), [], 'the data directory starts empty');
    assert.equal(app.bootstrap.isBootstrapped(), false, 'and it is not bootstrapped yet');

    const result = await app.controller.systemBootstrap({ reason: 'first launch on a new machine' });
    assert.equal(result.status, Outcome.SUCCESS_VERIFIED, result.display);

    const report = result.operation.steps[0].result.data;
    assert.equal(report.schema, BOOTSTRAP_SCHEMA);
    assert.equal(report.status !== 'lockdown', true);
    assert.deepEqual(report.checks.map((entry) => entry.id), [
      'doctor_readiness', 'host_workspace_perception', 'workstation_enrollment', 'executive_briefing',
    ]);
    // Every check reports the state it can defend. A check that could not be made is not verified.
    for (const entry of report.checks) {
      assert.equal(typeof entry.verified, 'boolean', `${entry.id} says whether it was verified`);
      assert.equal(typeof entry.detail, 'string');
    }

    // --- check 2: real observed facts, from this machine and this repository -------------------
    const perception = report.perception;
    assert.ok(perception.reading, 'the bootstrap recorded a reading');
    assert.equal(perception.reading.source, 'host-workspace-sensor');
    assert.equal(perception.observed > 0, true, 'the reading produced observed entries');
    assert.equal(perception.reading.host.cpu.logicalCount > 0, true, 'the CPU count came from the machine');
    assert.equal(perception.reading.workspace.available, true, 'the workspace was read');
    assert.equal(perception.reading.workspace.branch, 'main', 'the branch came from the real repository');
    assert.ok(perception.reading.workspace.head, 'and the HEAD came from it too');

    // The observations are in the perception ledger, marked as observations with the sensor's own
    // source - not as inferences and not as assertions.
    const observations = readJsonl(path.join(dataDir, 'perception', 'observations.jsonl'));
    const observed = observations.filter((entry) => entry.epistemicStatus === 'observed');
    assert.equal(observed.length > 0, true, 'the ledger holds observed entries');
    for (const entry of observed) assert.equal(entry.source, 'host-workspace-sensor');
    assert.equal(observations.some((entry) => entry.subject === 'workspace.git.branch'), true);

    // The world model holds the sensor's facts, with the sensor's own scheme as their provenance.
    const world = readJsonl(path.join(dataDir, 'world-model.jsonl'));
    const facts = world.filter((entry) => entry.type === 'fact_asserted');
    assert.equal(facts.length > 0, true, 'the world model holds the sensor facts');
    for (const fact of facts) {
      assert.equal(fact.subjectId, 'host-workspace-sensor');
      assert.equal(fact.observedAt, perception.reading.at, 'each fact carries the reading time');
    }
    const entities = world.filter((entry) => entry.type === 'entity_created');
    assert.equal(entities.length, 1, 'exactly one entity: the sensor itself');
    assert.equal(entities[0].entityId, 'host-workspace-sensor');
    assert.deepEqual(entities[0].externalIds, [{ scheme: 'host-workspace-sensor', value: 'host-workspace-sensor' }]);

    // --- check 3: the local workstation ---------------------------------------------------------
    const devices = await app.deviceTrust.list();
    assert.equal(devices.length, 1, 'exactly one device is enrolled');
    assert.equal(devices[0].deviceId, LOCAL_WORKSTATION_DEVICE_ID);
    assert.equal(devices[0].status, 'trusted');
    assert.equal(devices[0].metadata.kind, 'workstation');
    assert.equal(devices[0].metadata.capability, 'local-loopback');
    assert.ok(devices[0].metadata.hostname.length > 0, 'the hostname is recorded');
    assert.ok(devices[0].metadata.platform.length > 0, 'and so is the platform');

    // --- check 4: the opening briefing ---------------------------------------------------------
    assert.ok(report.briefing, 'the opening briefing was compiled');
    assert.equal(report.briefing.schema, 'apex.briefing.v1');
    assert.equal(report.briefing.facts.length > 0, true);
    assert.equal(report.briefing.facts.some((fact) => fact.kind === 'workspace'), true);

    // --- and nothing synthetic ----------------------------------------------------------------
    assert.equal(fs.existsSync(path.join(dataDir, 'tasks.jsonl')), false, 'no task store was created');
    assert.equal(fs.existsSync(path.join(dataDir, 'goals.jsonl')), false, 'no goal store was created');
    assert.equal(fs.existsSync(path.join(dataDir, 'plans.jsonl')), false, 'no plan store was created');
    assert.deepEqual(await app.taskStore.list(), [], 'no task records exist');
    assert.deepEqual(await app.goals.list(), [], 'no goal records exist');

    // The marker is on disk, with the check digests.
    const markerPath = path.join(dataDir, 'system-bootstrap.json');
    assert.equal(fs.existsSync(markerPath), true, 'the bootstrap marker was written');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.schema, BOOTSTRAP_SCHEMA);
    assert.equal(marker.bootstrapped, true);
    assert.equal(marker.runs, 1);
    assert.equal(marker.checks.length, 4);
    for (const entry of marker.checks) assert.match(entry.digest, /^[a-f0-9]{64}$/);
    assert.equal(app.bootstrap.isBootstrapped(), true);
  });

  test('a second bootstrap is idempotent: the workstation is not enrolled twice', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const workspace = realWorkspace(root);
    const app = appFor({ dataDir, workspace });

    await app.controller.systemBootstrap({ reason: 'first' });
    const afterFirst = await app.deviceTrust.list();
    const factsAfterFirst = readJsonl(path.join(dataDir, 'world-model.jsonl')).filter((entry) => entry.type === 'fact_asserted');

    const second = await app.controller.systemBootstrap({ reason: 'second' });
    assert.equal(second.status, Outcome.SUCCESS_VERIFIED, second.display);
    const report = second.operation.steps[0].result.data;
    assert.equal(report.idempotent, true, 'the second run says it was a refresh, not a first run');
    assert.equal(report.firstRun, false);

    const afterSecond = await app.deviceTrust.list();
    assert.equal(afterSecond.length, 1, 'still exactly one device');
    assert.equal(afterSecond[0].deviceId, LOCAL_WORKSTATION_DEVICE_ID);
    assert.equal(afterSecond[0].enrolledAt, afterFirst[0].enrolledAt, 'and it is the same enrollment');

    // The live readings are refreshed - the ledger grows - but the world model does not gain a
    // second copy of a fact that is already recorded.
    const observations = readJsonl(path.join(dataDir, 'perception', 'observations.jsonl'));
    assert.equal(observations.filter((entry) => entry.reading === true).length, 2, 'a second reading was taken');
    const factsAfterSecond = readJsonl(path.join(dataDir, 'world-model.jsonl')).filter((entry) => entry.type === 'fact_asserted');
    assert.equal(factsAfterSecond.length, factsAfterFirst.length, 'no duplicate world-model facts were written');

    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'system-bootstrap.json'), 'utf8'));
    assert.equal(marker.runs, 2);
  });

  test('with the lockdown latch engaged the bootstrap refuses and writes nothing', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const app = appFor({ dataDir });
    await app.controller.runAction('safety.lockdown', { reason: 'the owner locked the system down' }, 'user', 'op-lock');

    const result = await app.controller.systemBootstrap({ reason: 'a cold start under lockdown' });
    assert.equal(result.status, Outcome.ACTION_DENIED, 'the control plane refused the write');
    assert.equal(result.operation.steps[0].authorization.decision, 'deny');

    // Nothing was enrolled, nothing was read, and no marker was written.
    assert.deepEqual(await app.deviceTrust.list(), [], 'no device was enrolled');
    assert.equal(fs.existsSync(path.join(dataDir, 'system-bootstrap.json')), false, 'no marker was written');
    assert.equal(fs.existsSync(path.join(dataDir, 'perception')), false, 'the host was not read');
    assert.equal(app.bootstrap.isBootstrapped(), false);
  });

  test('the bootstrap never enrols a second device when the owner has enrolled their own', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const app = appFor({ dataDir });
    await app.deviceTrust.enroll({ origin: 'user', label: 'owner laptop', deviceId: 'owner-laptop' });

    const result = await app.controller.systemBootstrap({ reason: 'first' });
    assert.equal(result.status, Outcome.SUCCESS_VERIFIED, result.display);
    const devices = await app.deviceTrust.list();
    assert.equal(devices.length, 1, 'the owner\'s own device is the only one enrolled');
    assert.equal(devices[0].deviceId, 'owner-laptop');
    const enrollment = result.operation.steps[0].result.data.checks.find((entry) => entry.id === 'workstation_enrollment');
    assert.equal(enrollment.verified, false, 'the enrollment check says it did not happen');
    assert.equal(enrollment.state, 'not_configured');
  });

  test('the bootstrap capability is a user-origin write and a reply may not run it', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const app = appFor({ dataDir });
    const definition = app.registry.get('system.bootstrap');
    assert.ok(definition, 'the capability is registered');
    assert.equal(definition.permission, 'write');
    assert.deepEqual([...definition.origins], ['user']);

    const before = fs.readdirSync(dataDir);
    const denied = await app.controller.runAction('system.bootstrap', { reason: 'the model asked for it' }, 'model', 'op-model');
    assert.equal(denied.authorization.decision, 'deny', 'a reply is refused');
    assert.equal(denied.execution.status, 'not_run');
    assert.deepEqual(fs.readdirSync(dataDir), before, 'and nothing was written');
  });
});
