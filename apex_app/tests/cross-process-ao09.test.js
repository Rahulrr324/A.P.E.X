// Batch AO, Package H: a real process terminated immediately after it recorded a model proposal.
//
// tests/fixtures/proposal-after-create-child.mjs is a real APEX app that writes one proposal
// through the real proposal store, prints READY with the id, and then waits to be terminated. The
// parent kills it at that boundary, so what the fresh process finds is exactly what a lost process
// leaves: one `proposal_created` event, no decision, and a claim file the next writer must resolve.
//
// The boundary matters because it is the one place where "the proposal exists" and "the user has
// decided" can be confused. Nothing in the child decides, approves, activates, or executes; the
// fresh process has to resolve the abandoned claim through its own write, and only an explicit user
// decision may accept the proposal. A replay of the same decision is refused, and the log still
// holds exactly one decision - the accepted one.
//
// The stale-lock holder is identified by numeric pid only, so after the child's exit is awaited
// the test rewrites that pid to one the allocator cannot reach during the test (rebindDeadHolder
// in tests/helpers.js). The original pid is asserted first. Without that, a pid recycled by Windows
// would make the fresh process refuse the write as "in use" for no real reason.
//
// No backend is contacted and no inference is involved: the child creates a synthetic `advice`
// proposal, and the parent uses NoBackend.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { NoBackend, ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { ProposalStatus } from '../src/proposals/model.js';
import { makeTempDataDir, cleanup, cleanEnv, APP_ROOT, rebindDeadHolder } from './helpers.js';

const NOW = '2026-06-01T00:00:00.000Z';
const clock = () => new Date(NOW);
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'proposal-after-create-child.mjs');
// A ceiling on the wait for the marker, not a delay: the wait ends when the child prints it.
const READY_CEILING_MS = 90000;

const dirs = [];
const children = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
// If a check fails before the test terminates the child, the child must not be left blocked
// forever: it holds a claim and would keep the runner alive.
after(async () => {
  for (const c of children) {
    c.child.kill();
    await Promise.race([c.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appOn(dataDir) {
  return createApp({
    dataDir,
    now: clock,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
  });
}

// Starts the fixture and resolves with the id it printed after the store call returned. A child
// that exits before the marker, or never prints one, fails the test with everything it said.
async function startChild(dataDir) {
  const child = spawn(process.execPath, [CHILD, dataDir], {
    env: cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  children.push({ child, exited });
  const ready = new Promise((resolve) => {
    const check = () => {
      const line = out.split('\n').find((l) => l.startsWith('READY '));
      if (line) resolve(line.slice('READY '.length).trim());
    };
    child.stdout.on('data', check);
    check();
  });
  const ceiling = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never recorded its proposal within ${READY_CEILING_MS} ms. stdout: ${out} stderr: ${err}`)), READY_CEILING_MS);
    child.once('exit', () => clearTimeout(timer));
  });
  const lost = exited.then((info) => {
    throw new Error(`the child exited before the test terminated it (exit ${info.code ?? info.signal}). stdout: ${out} stderr: ${err}`);
  });
  const proposalId = await Promise.race([ready, lost, ceiling]);
  return { child, exited, proposalId, output: () => `${out}${err}` };
}

describe('a real process interrupted after recording a proposal', () => {
  test('the abandoned claim is resolved by the next write, the decision is explicit, and replay is refused', async () => {
    const dataDir = tempDir();
    const proposalsFile = path.join(dataDir, 'proposals.jsonl');
    const lockFile = `${proposalsFile}.lock`;

    const running = await startChild(dataDir);

    // The child's own store call returned before the marker, so the proposal is on disk and no
    // decision was written. The claim is its own live claim at this point.
    const before = readEvents(proposalsFile);
    assert.equal(before.length, 1, 'the lost process recorded exactly one event');
    assert.equal(before[0].type, 'proposal_created');
    assert.equal(before[0].proposalId, running.proposalId);
    assert.equal(before[0].origin, 'model');
    assert.equal(fs.existsSync(lockFile), true, 'the running process holds the proposal claim');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, running.child.pid, 'the claim names the child');

    // The interruption itself: no cleanup runs in the child.
    assert.equal(running.child.kill(), true, 'the process was signalled');
    const exit = await running.exited;
    assert.notEqual(exit.code, 0, 'the child did not exit cleanly');
    assert.equal(fs.existsSync(lockFile), true, 'and it left its claim file behind');
    rebindDeadHolder(lockFile, running.child.pid);

    // A read in a fresh process reports the raw state: one pending proposal, no decision.
    const app = appOn(dataDir);
    const pending = await app.proposals.get(running.proposalId);
    assert.equal(pending.decision, null, 'the interruption left no decision');
    assert.equal(readEvents(proposalsFile).length, 1, 'and reading wrote nothing');

    // Only an explicit user decision supersedes the abandoned claim, and the acceptance itself is
    // the write that proves the claim was resolved rather than stolen from a live holder.
    const accepted = await app.controller.runAction('proposal.accept', { target: running.proposalId }, 'user', randomUUID());
    assert.equal(accepted.outcome, Outcome.SUCCESS_VERIFIED, accepted.summary);
    assert.equal(accepted.result.data.proposalId, running.proposalId);
    assert.equal(accepted.result.data.decision, ProposalStatus.ACCEPTED);

    const after = readEvents(proposalsFile);
    assert.equal(after.length, 2, 'the proposal and exactly one decision are recorded');
    assert.equal(after[1].type, 'proposal_decided');
    assert.equal(after[1].proposalId, running.proposalId);
    assert.equal(after[1].origin, 'user');
    assert.equal(after[1].decision, ProposalStatus.ACCEPTED);
    assert.equal(fs.existsSync(lockFile), false, 'the fresh process replaced the dead claim');

    // Replay is refused and records nothing: a decision is not repeatable.
    const replay = await app.controller.runAction('proposal.accept', { target: running.proposalId }, 'user', randomUUID());
    assert.notEqual(replay.outcome, Outcome.SUCCESS_VERIFIED, 'a decided proposal is never accepted twice');
    assert.equal(replay.outcome, Outcome.EXECUTION_FAILED);
    assert.match(replay.summary, /is accepted; it cannot be accepted/);
    assert.equal(readEvents(proposalsFile).length, 2, 'the refused replay recorded nothing');

    // One more fresh process reads the same two events back.
    const reader = appOn(dataDir);
    const decided = await reader.proposals.get(running.proposalId);
    assert.equal(decided.decision.decision, ProposalStatus.ACCEPTED, 'the decision survived the process boundary');
    assert.equal(readEvents(proposalsFile).length, 2);
  });
});
