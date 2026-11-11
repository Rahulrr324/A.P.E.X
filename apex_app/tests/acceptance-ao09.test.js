// Batch AO, Package H: adversarial integration and end-to-end acceptance.
//
// These cases drive the real controller, stores, registry, task runner and proposal log in a
// temporary data directory. A model reply, where one is used, is a fixed string from a synthetic
// capture backend; nothing here is inference, and no endpoint is contacted.
//
// The cases fill gaps the AO-01..AO-08 suites left open, not behaviors that already have a test:
//   - a decided, expired or invalidated proposal cannot be replayed through the real accept action;
//   - a model-origin decision on its own proposal is refused by the registry;
//   - a claim that cites the same record twice counts the record once;
//   - the cognitive evaluation harness is deterministic and writes nothing;
//   - a declared read permission does not bypass the registry when a task runs it;
//   - an evidence record corrected or retracted while the model is answering is observed by a
//     separate, read-only re-check that never rewrites the recorded lineage or the outcome.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { TaskStatus, StepStatus } from '../src/tasks/model.js';
import { ProposalStatus } from '../src/proposals/model.js';
import { evaluateCognitiveQuality } from '../src/cognition/evaluation.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const NOW = '2026-06-01T00:00:00.000Z';
const clock = () => new Date(NOW);

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

// A backend that answers with fixed text. It is a test double, not a model.
function captureBackend(text) {
  const calls = [];
  return {
    calls,
    backend: {
      name: 'ao09-capture',
      provider: 'ao09-capture',
      configured: true,
      describe: () => ({ configured: true, provider: 'ao09-capture', endpoint: 'synthetic', model: 'synthetic' }),
      health: async () => ({ available: true, detail: 'synthetic capture' }),
      complete: async (request) => {
        calls.push(request);
        return {
          ok: true,
          backend: 'ao09-capture',
          provider: 'ao09-capture',
          model: 'synthetic',
          text: typeof text === 'function' ? await text(request, calls.length) : text,
          finishReason: 'stop',
          truncated: false,
          latencyMs: 0,
        };
      },
    },
  };
}

function appOn(dataDir, backend) {
  return createApp({
    dataDir,
    gateway: new ModelGateway({ backend }),
    experienceCapture: CAPTURE_OFF,
    now: clock,
  });
}

function appWith(text) {
  const dataDir = tempDir();
  const capture = captureBackend(text);
  const app = appOn(dataDir, capture.backend);
  return { app, dataDir, calls: capture.calls };
}

function structured(reply, cognition) {
  return [reply, `COGNITION ${JSON.stringify({ schema: 1, ...cognition })}`].join('\n');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function hashTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(root, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

const advice = (summary) => ({
  kind: 'advice',
  title: 'a suggestion for the user',
  rationale: 'the model suggests a next step; the user decides',
  changes: { summary },
  validation: { ok: true, problems: [] },
});

async function decide(app, action, target, origin = 'user', reason = null) {
  const input = reason === null ? { target } : { target, reason };
  return app.controller.runAction(action, input, origin, randomUUID());
}

describe('AO-09 executive authority boundary: proposal decisions are single-use', () => {
  test('an accepted, rejected or invalidated proposal cannot be replayed, and a model cannot decide its own proposal', async () => {
    const { app, dataDir } = appWith('unused');

    const accepted = (await app.proposals.createProposal(advice('accept this advice'))).proposal;
    const firstAccept = await decide(app, 'proposal.accept', accepted.id);
    assert.equal(firstAccept.outcome, Outcome.SUCCESS_VERIFIED, firstAccept.summary);
    const replayAccept = await decide(app, 'proposal.accept', accepted.id);
    assert.equal(replayAccept.outcome, Outcome.EXECUTION_FAILED, 'a replayed decision is never a success');
    assert.match(replayAccept.summary, /is accepted; it cannot be accepted/);

    const rejected = (await app.proposals.createProposal(advice('reject this advice'))).proposal;
    const firstReject = await decide(app, 'proposal.reject', rejected.id, 'user', 'not useful');
    assert.equal(firstReject.outcome, Outcome.SUCCESS_VERIFIED, firstReject.summary);
    const replayReject = await decide(app, 'proposal.reject', rejected.id, 'user', 'again');
    assert.equal(replayReject.outcome, Outcome.EXECUTION_FAILED);
    assert.match(replayReject.summary, /already has a decision/);
    const acceptRejected = await decide(app, 'proposal.accept', rejected.id);
    assert.equal(acceptRejected.outcome, Outcome.EXECUTION_FAILED, 'a rejection is not a pending proposal');
    assert.match(acceptRejected.summary, /is rejected/);

    const invalidated = (await app.proposals.createProposal(advice('invalidate this advice'))).proposal;
    const firstInvalidate = await decide(app, 'proposal.invalidate', invalidated.id, 'user', 'the assumption changed');
    assert.equal(firstInvalidate.outcome, Outcome.SUCCESS_VERIFIED, firstInvalidate.summary);
    const acceptInvalidated = await decide(app, 'proposal.accept', invalidated.id);
    assert.equal(acceptInvalidated.outcome, Outcome.EXECUTION_FAILED);
    assert.match(acceptInvalidated.summary, /invalidated/);

    const pending = (await app.proposals.createProposal(advice('the user has not decided this'))).proposal;
    const modelAccept = await decide(app, 'proposal.accept', pending.id, 'model');
    assert.equal(modelAccept.outcome, Outcome.ACTION_DENIED, 'the registry refuses a model-origin decision');
    assert.equal((await app.proposals.list()).find((p) => p.id === pending.id).decision ?? null, null,
      'a refused model decision records nothing');
    const userAccept = await decide(app, 'proposal.accept', pending.id);
    assert.equal(userAccept.outcome, Outcome.SUCCESS_VERIFIED, 'the user can still decide it');

    // The log holds exactly one creation and one decision per proposal; the model-origin refusal
    // wrote no event at all.
    const events = readJsonl(path.join(dataDir, 'proposals.jsonl'));
    assert.equal(events.filter((e) => e.type === 'proposal_created').length, 4);
    const decided = events.filter((e) => e.type === 'proposal_decided');
    assert.equal(decided.length, 4, `${decided.length} decisions recorded for 4 proposals`);
    assert.deepEqual(
      decided.map((e) => e.decision).sort(),
      [ProposalStatus.ACCEPTED, ProposalStatus.ACCEPTED, ProposalStatus.INVALIDATED, ProposalStatus.REJECTED].sort(),
    );
  });

  test('an expired proposal is refused explicitly rather than accepted or rejected implicitly', async () => {
    const { app } = appWith('unused');
    const expired = (await app.proposals.createProposal({
      ...advice('this suggestion has already expired'),
      expiresAt: '2026-05-31T00:00:00.000Z',
    })).proposal;
    const accept = await decide(app, 'proposal.accept', expired.id);
    assert.equal(accept.outcome, Outcome.EXECUTION_FAILED, 'an expiry is refused, never a silent success');
    assert.match(accept.summary, /expired/);
    const reject = await decide(app, 'proposal.reject', expired.id, 'user', 'too late');
    assert.equal(reject.outcome, Outcome.EXECUTION_FAILED);
    assert.match(reject.summary, /expired/);
    assert.equal((await app.proposals.list()).find((p) => p.id === expired.id).decision ?? null, null,
      'an expiry is derived, not a decision');
  });
});

describe('AO-09 evidence integrity at the response boundary', () => {
  test('one claim that repeats the same evidence id is counted once', async () => {
    let recordId = null;
    const { app } = appWith(() => structured('The lighthouse project status is green.', {
      decision: 'answer',
      answer: 'The lighthouse project status is green.',
      claims: [{
        text: 'the lighthouse project status is green',
        evidence: [`ev:memory:${recordId}`, `ev:memory:${recordId}`],
        kind: 'supported',
      }],
      disclosures: [],
      missing: [],
    }));
    const record = await app.memory.add({
      content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
    });
    recordId = record.id;

    const res = await app.controller.handle('tell me about the lighthouse project status', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const cognition = res.operation.cognition;
    assert.equal(cognition.model.accepted, true, JSON.stringify(cognition.model.problems ?? []));
    assert.equal(cognition.model.claims, 1);
    assert.equal(cognition.model.citedEvidence, 1, 'the repeated id is one record, not two supports');
    const responseClaims = cognition.model.lineage.claims;
    assert.equal(responseClaims.length, 1);
    assert.deepEqual(responseClaims[0].evidenceIds, [`ev:memory:${record.id}`]);
    assert.equal(responseClaims[0].evidenceState, 'directly_supported');
  });

  test('a memory record corrected while the model answers is observed without rewriting the recorded lineage', async () => {
    const dataDir = tempDir();
    let app = null;
    let recordId = null;
    let correction = null;
    const capture = captureBackend(() => structured('The lighthouse project status is green.', {
      decision: 'answer',
      answer: 'The lighthouse project status is green.',
      claims: [{
        text: 'the lighthouse project status is green',
        evidence: [`ev:memory:${recordId}`],
        kind: 'supported',
      }],
      disclosures: [],
      missing: [],
    }));
    const complete = capture.backend.complete;
    // TEST DOUBLE: the backend writes a real, user-origin correction before it returns. That is the
    // gap between the analysis (which read the old record) and the answer (which cites it).
    capture.backend.complete = async (request) => {
      correction = await app.memory.correct({
        targetId: recordId, content: 'the lighthouse project status is red', origin: 'user',
      });
      return complete(request);
    };
    app = appOn(dataDir, capture.backend);
    const record = await app.memory.add({
      content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user',
    });
    recordId = record.id;

    const res = await app.controller.handle('what is the lighthouse project status?', { origin: 'user' });
    assert.equal(correction?.id !== undefined, true, 'the correction was recorded during the model call');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);

    const stale = await app.memory.getMany([recordId]);
    assert.deepEqual(stale.get(recordId)?.replacedBy, [correction.id],
      'the bounded re-read names the successor, not the replaced record itself');

    const recheck = res.operation.cognition.evidenceRecheck;
    assert.ok(recheck, 'the answer carries a separate re-check observation');
    assert.equal(recheck.available, true);
    assert.equal(recheck.authorizes, false);
    assert.ok(recheck.recheckedSources.includes('memory'));
    assert.ok(recheck.weakened >= 1, `a claim resting on a corrected record is weakened (${JSON.stringify(recheck)})`);
    assert.ok(recheck.phases.analysis.weakened >= 1);
    assert.ok(recheck.phases.response.weakened >= 1);

    const recorded = res.operation.cognition.lineage.claims.find((c) => c.evidenceIds.includes(`ev:memory:${recordId}`));
    assert.equal(recorded.evidenceState, 'directly_supported', 'the recorded analysis lineage is not rewritten');
    const responseRecorded = res.operation.cognition.model.lineage.claims[0];
    assert.equal(responseRecorded.evidenceState, 'directly_supported');

    assert.match(res.output, /Evidence cited by this answer changed while the answer was being produced/);
    assert.match(res.output, /has not verified the answer against the current stores/);
    assert.equal(res.operation.status, Outcome.VERIFICATION_UNAVAILABLE, 'the re-check is not an execution result');
    assert.equal(readJsonl(path.join(dataDir, 'proposals.jsonl')).length, 0,
      'the re-check created no proposal and no authority record');
  });

  test('a knowledge claim retracted while the model answers is weakened, and an unchanged answer gets no notice', async () => {
    const dataDir = tempDir();
    let app = null;
    let recordId = null;
    let retracted = false;
    const capture = captureBackend(() => structured('Atlas is operational.', {
      decision: 'answer',
      answer: 'Atlas is operational.',
      claims: [{
        text: 'atlas has status operational',
        evidence: [`ev:knowledge:${recordId}`],
        kind: 'supported',
      }],
      disclosures: [],
      missing: [],
    }));
    const complete = capture.backend.complete;
    capture.backend.complete = async (request) => {
      if (!retracted) {
        retracted = true;
        await app.knowledge.retract({ target: recordId, origin: 'user', reason: 'the user withdrew this claim' });
      }
      return complete(request);
    };
    app = appOn(dataDir, capture.backend);
    const added = await app.knowledge.add({
      subject: 'atlas', relationship: 'has_status', object: 'operational', origin: 'user',
    });
    recordId = added.record.id;

    const res = await app.controller.handle('what is the status of atlas?', { origin: 'user' });
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE);
    const recheck = res.operation.cognition.evidenceRecheck;
    assert.ok(recheck, 'the retracted citation was re-checked');
    assert.equal(recheck.available, true);
    assert.ok(recheck.recheckedSources.includes('knowledge'));
    assert.ok(recheck.weakened >= 1, JSON.stringify(recheck));
    assert.match(res.output, /Evidence cited by this answer changed/);
    const recorded = res.operation.cognition.lineage.claims.find((c) => c.evidenceIds.includes(`ev:knowledge:${recordId}`));
    assert.equal(recorded.evidenceState, 'directly_supported', 'the recorded lineage keeps what the analysis saw');

    // The same request against an unchanged store: the re-check still runs, finds nothing changed,
    // and adds no notice.
    let steadyRecordId = null;
    const { app: steady } = appWith(() => structured('Atlas is operational.', {
      decision: 'answer',
      answer: 'Atlas is operational.',
      claims: [{ text: 'atlas has status operational', evidence: [`ev:knowledge:${steadyRecordId}`], kind: 'supported' }],
      disclosures: [],
      missing: [],
    }));
    const steadyRecord = await steady.knowledge.add({
      subject: 'atlas', relationship: 'has_status', object: 'operational', origin: 'user',
    });
    steadyRecordId = steadyRecord.record.id;
    const steadyRes = await steady.controller.handle('what is the status of atlas?', { origin: 'user' });
    const steadyRecheck = steadyRes.operation.cognition.evidenceRecheck;
    assert.ok(steadyRecheck, 'the re-check is an observation, not an error path');
    assert.equal(steadyRecheck.changed, 0);
    assert.equal(steadyRecheck.weakened, 0);
    assert.doesNotMatch(steadyRes.output, /Evidence cited by this answer changed/);
  });
});

describe('AO-09 evaluation harness is observational', () => {
  test('evaluation is deterministic, has no composite score, and writes nothing to a data directory', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir, captureBackend('unused').backend);
    await app.memory.add({ content: 'the lighthouse project status is green', kind: 'user_fact', source: 'user' });
    await app.knowledge.add({ subject: 'atlas', relationship: 'has_status', object: 'operational', origin: 'user' });

    const before = hashTree(dataDir);
    const first = await evaluateCognitiveQuality({ now: NOW });
    const after = hashTree(dataDir);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), 'evaluation changed no file');
    assert.equal(first.deterministic, true);
    assert.equal('score' in first, false, 'there is no composite intelligence score');
    assert.equal(first.ok, first.totals.failed === 0, 'ok is only "every rubric check held"');

    const second = await evaluateCognitiveQuality({ now: NOW });
    assert.deepEqual(second, first, 'two runs over fixed inputs are byte-identical');
  });
});

describe('AO-09 direct task path still consults the registry', () => {
  test('a model-origin task cannot run before approval, and a declared read permission does not bypass authorization', async () => {
    const { app } = appWith('unused');
    const taskId = randomUUID();
    // A malicious plan that declares a user-only write as a read. The task log accepts the declared
    // shape, so only the registry stands between it and the store.
    await app.taskStore.createTask({
      taskId,
      goal: 'try to write memory from a model task',
      origin: 'model',
      planner: 'deterministic',
      steps: [{
        id: 's1',
        description: 'attempt a user-only write',
        action: 'memory.add',
        permission: 'read',
        input: { content: 'a model-written fact' },
        dependsOn: [],
      }],
    });

    await assert.rejects(
      () => app.controller.tasks.run(taskId, { mode: 'run' }),
      /needs your approval first/,
      'the runner itself refuses a proposed model task, even when called directly',
    );
    assert.equal((await app.taskStore.get(taskId)).status, TaskStatus.PROPOSED);

    const approved = await app.controller.approveTask(taskId);
    assert.equal(approved.status, Outcome.SUCCESS_VERIFIED, approved.output);
    const run = await app.controller.runTask(taskId, 'run');
    assert.equal(run.status, Outcome.ACTION_DENIED, run.output ?? run.display);

    const task = await app.taskStore.get(taskId);
    assert.equal(task.status, TaskStatus.FAILED);
    assert.equal(task.steps[0].status, StepStatus.FAILED);
    assert.equal(task.steps[0].outcome, Outcome.ACTION_DENIED);
    assert.deepEqual(await app.memory.search('model-written fact'), [], 'nothing was written');

    const { records } = await app.operations.list({ limit: 1000 });
    const step = records.filter((r) => r.capability === 'task.step' && r.task?.stepId === 's1');
    assert.equal(step.length, 1);
    assert.equal(step[0].steps[0].authorization.decision, 'deny');
    assert.equal(step[0].status, Outcome.ACTION_DENIED);
  });
});
