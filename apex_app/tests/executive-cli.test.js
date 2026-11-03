// The goal, plan, and recovery commands through the real entry point. Each command is a
// separate process against one isolated data directory, so every assertion is about what
// the stores actually hold after the process exits.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function envFor(dir) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
}

function idFrom(text, kind) {
  const match = new RegExp(`^${kind} ([0-9a-f]{8})`, 'm').exec(text);
  assert.ok(match, `no ${kind} id in output:\n${text}`);
  return match[1];
}

function operationIdFrom(text) {
  const match = /operations\.jsonl \(([0-9a-f-]{36})\)/.exec(text);
  assert.ok(match, `no audit operation id in output:\n${text}`);
  return match[1];
}

function stepJson(overrides = {}) {
  return JSON.stringify({
    id: 's1',
    description: 'store the corrected index fact',
    action: 'memory.add',
    input: { content: 'the executive cli test index is corrected' },
    expectedResult: 'the stored fact is read back unchanged',
    verification: 'a re-read compares the content hash',
    risk: 'medium',
    ...overrides,
  });
}

test('goal lifecycle through the real CLI: accept, activate, evidence, complete', async () => {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const env = envFor(dir);

  const add = await runCli(['goal', 'add', 'Ship the corrected memory index', '--criterion', 'the index is corrected', '--criterion', 'the correction is verified'], env);
  assert.equal(add.code, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /status: proposed/);
  assert.match(add.stdout, /Nothing has run, and the goal grants no permission/);
  const goalId = idFrom(add.stdout, 'Goal');

  const premature = await runCli(['goal', 'complete', goalId], env);
  assert.equal(premature.code, 1, premature.stdout);
  assert.match(premature.stdout, /is proposed; accept it, then move it to active/);

  const accepted = await runCli(['goal', 'update', goalId, 'accepted'], env);
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /is now accepted/);
  const active = await runCli(['goal', 'update', goalId, 'active'], env);
  assert.equal(active.code, 0, active.stdout + active.stderr);
  assert.match(active.stdout, /is now active/);

  const first = await runCli(['knowledge', 'add', '--subject', 'memory index', '--relationship', 'is', '--object', 'corrected'], env);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const second = await runCli(['knowledge', 'add', '--subject', 'memory index correction', '--relationship', 'is', '--object', 'verified'], env);
  assert.equal(second.code, 0, second.stdout + second.stderr);

  for (const [criterion, text] of [['c1', first.stdout], ['c2', second.stdout]]) {
    const evidence = await runCli(['goal', 'evidence', goalId, '--criterion', criterion, '--kind', 'supports', '--operation', operationIdFrom(text)], env);
    assert.equal(evidence.code, 0, evidence.stdout + evidence.stderr);
    assert.match(evidence.stdout, new RegExp(`Recorded supports evidence for criterion ${criterion}`));
  }

  const done = await runCli(['goal', 'complete', goalId], env);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /is completed/);
  assert.match(done.stdout, /Completion was checked against the audit log, not asserted/);

  const list = await runCli(['goal', 'list'], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /completed/);
  assert.match(list.stdout, /\(closed\)/);

  const show = await runCli(['goal', 'show', goalId], env);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /history:/i);
  assert.match(show.stdout, /active -> completed/);

  const recovery = await runCli(['recover'], env);
  assert.equal(recovery.code, 0, recovery.stdout + recovery.stderr);
  assert.match(recovery.stdout, /Recovery inspection \(read-only\)/);
  assert.match(recovery.stdout, /Completed or closed/);
});

test('plan lifecycle through the real CLI: add, validate, approve, start, reconcile', async () => {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const env = envFor(dir);

  const goal = await runCli(['goal', 'add', 'Produce the corrected index', '--criterion', 'the corrected index fact is stored'], env);
  assert.equal(goal.code, 0, goal.stdout + goal.stderr);
  const goalId = idFrom(goal.stdout, 'Goal');
  assert.equal((await runCli(['goal', 'update', goalId, 'accepted'], env)).code, 0);
  assert.equal((await runCli(['goal', 'update', goalId, 'active'], env)).code, 0);

  const add = await runCli(['plan', 'add', '--goal', goalId, '--outcome', 'the corrected index fact is stored', '--step', stepJson()], env);
  assert.equal(add.code, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /status: draft/);
  assert.match(add.stdout, /Validation: passed/);
  const planId = idFrom(add.stdout, 'Plan');

  const show = await runCli(['plan', 'show', planId], env);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /memory\.add/);

  const validate = await runCli(['plan', 'validate', planId], env);
  assert.equal(validate.code, 0, validate.stdout);
  assert.match(validate.stdout, /Validation: passed\./);
  assert.match(validate.stdout, /Nothing has run/);

  const approve = await runCli(['plan', 'approve', planId], env);
  assert.equal(approve.code, 0, approve.stdout + approve.stderr);
  assert.match(approve.stdout, /Approved plan .* v1/);
  assert.match(approve.stdout, /Every step is still authorized separately when it runs/);

  const start = await runCli(['plan', 'start', planId], env);
  assert.equal(start.code, 0, start.stdout + start.stderr);
  assert.match(start.stdout, /Plan status: completed/);
  assert.match(start.stdout, /is completed against 1 verified step outcome/);

  const goalAfter = await runCli(['goal', 'show', goalId], env);
  assert.equal(goalAfter.code, 0, goalAfter.stderr);
  assert.match(goalAfter.stdout, /status: active/, 'a completed plan does not complete its goal');

  const reconcile = await runCli(['plan', 'reconcile', planId], env);
  assert.equal(reconcile.code, 0, reconcile.stdout + reconcile.stderr);
  assert.match(reconcile.stdout, /No new terminal outcome was recorded/);
  assert.match(reconcile.stdout, /already recorded as completed/);

  const recovery = await runCli(['recover'], env);
  assert.equal(recovery.code, 0, recovery.stdout + recovery.stderr);
  assert.match(recovery.stdout, /task .*: completed|plan .*: completed/);
});

test('a plan naming an unavailable capability stays a draft and cannot be approved or started', async () => {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const env = envFor(dir);

  const step = stepJson({
    action: 'test.missing',
    input: {},
    risk: 'low',
    description: 'call a sensor that this configuration does not have',
  });
  const add = await runCli(['plan', 'add', '--outcome', 'read the sensor', '--step', step], env);
  assert.equal(add.code, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /Validation: NOT passed/);
  assert.match(add.stdout, /not available in this configuration/);
  const planId = idFrom(add.stdout, 'Plan');

  const validate = await runCli(['plan', 'validate', planId], env);
  assert.equal(validate.code, 1, validate.stdout);
  assert.match(validate.stdout, /Validation: NOT passed/);
  assert.match(validate.stdout, /not available in this configuration/);

  const approve = await runCli(['plan', 'approve', planId], env);
  assert.equal(approve.code, 1, approve.stdout);
  assert.match(approve.stdout, /cannot be approved/);

  const start = await runCli(['plan', 'start', planId], env);
  assert.equal(start.code, 1, start.stdout);
  assert.match(start.stdout, /only an approved plan/);

  const show = await runCli(['plan', 'show', planId], env);
  assert.match(show.stdout, /status: draft/);

  const recovery = await runCli(['recover'], env);
  assert.equal(recovery.code, 1, recovery.stdout);
  assert.match(recovery.stdout, /draft\. Validate it, then approve it/);
});

test('goal and plan usage errors exit 2 and record nothing', async () => {
  const dir = makeTempDataDir();
  dirs.push(dir);
  const env = envFor(dir);

  assert.equal((await runCli(['goal', 'add', 'a request with no criteria'], env)).code, 2);
  assert.equal((await runCli(['goal', 'show'], env)).code, 2);
  assert.equal((await runCli(['plan', 'add', '--outcome', 'no steps here'], env)).code, 2);
  assert.equal((await runCli(['plan', 'add', '--outcome', 'x', '--step', '{not json'], env)).code, 2);
  assert.equal((await runCli(['plan', 'cancel', 'abc'], env)).code, 2);
  assert.equal((await runCli(['recover', 'extra'], env)).code, 2);

  const recovery = await runCli(['recover'], env);
  assert.equal(recovery.code, 0, recovery.stdout);
  assert.match(recovery.stdout, /Records read: 0 goal\(s\), 0 plan\(s\), 0 task\(s\)/);
});
