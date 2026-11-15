// Batch AB: the unified operation-finalization contract, tested through observable behavior.
//
// Batch AA ended four controller methods with the same three statements - append the audit record,
// learn whether that append succeeded, attempt eligible experience capture - and a fifth path (a
// task step) is audited by the TaskRunner itself. Batch AB gives the controller's tail one function
// (`finalizeOperation`) and turns the capability decision into data, so this file can check the
// contract rather than the prose around it:
//
//   completeness   every capability that can end an operation is either capture-eligible or
//                  explicitly excluded with a stated category, and the five completion paths are
//                  declared one by one;
//   order          the audit record is on disk before capture is attempted, and capture is told
//                  whether that append succeeded;
//   separation     an audit failure is reported to the caller and never rewritten by the helper; a
//                  capture failure cannot change the operation's outcome, its audit record, or the
//                  notice that is shown;
//   idempotence    finalizing one operation twice is refused instead of appending a second record.
//
// No test here contacts a model, starts a service, or downloads anything. Audit and experience
// failures are injected by replacing one function on the real store instance, so the paths under
// test are the ones the application actually runs.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { formatResult } from '../src/cli.js';
import { finalizeOperation, FINALIZATION_ORDER, OPERATION_COMPLETION_PATHS } from '../src/controller/finalization.js';
import {
  AUTO_CAPTURE_CAPABILITIES,
  CAPTURE_EXCLUDED_CAPABILITIES,
  CAPTURE_EXCLUSION_CATEGORIES,
  CAPTURE_OFF,
  CAPTURE_VERIFIED_SUCCESS,
} from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';

const CLOCK = () => new Date('2026-11-02T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const OPS = (dir) => path.join(dir, 'operations.jsonl');
const LOG = (dir) => path.join(dir, 'experiences.jsonl');

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
const auditOf = (dir) => readRecords(OPS(dir));
const experiencesOf = (dir) => readRecords(LOG(dir)).filter((r) => r.kind === 'experience');
const feedbackOf = (dir) => readRecords(LOG(dir)).filter((r) => r.kind === 'feedback');

function appFor(dir, capture = CAPTURE_VERIFIED_SUCCESS) {
  return createApp({ dataDir: dir, now: CLOCK, experienceCapture: capture });
}

async function remember(app, note) {
  const res = await app.controller.handle(`remember that ${note}`, { origin: 'user' });
  assert.equal(res.operation.capability, 'memory.add', 'the fixture depends on this routing to memory.add');
  return res;
}

const lastMemoryId = (dir) => readRecords(path.join(dir, 'memory.jsonl')).at(-1).id;

// Capabilities that end an operation without being a registered action: the router's model path,
// rejected input, the task commands, the task-step record the runner writes itself, and the
// read-only executive routes that reuse the command completion path.
const NON_REGISTRY_CAPABILITIES = Object.freeze([
  'model.answer', 'none',
  'task.plan', 'task.run', 'task.approve', 'task.retry', 'task.cancel', 'task.explain', 'task.step',
  'goal.list', 'goal.show',
  'proposal.create',
  'plan.list', 'plan.show', 'plan.validate', 'plan.activate', 'plan.reconcile',
  'plan.continuation', 'plan.continue',
  'recover',
  // The outer operation each executive-bridge request produces in a conversation.
  'executive.status', 'executive.prepare', 'executive.approve', 'executive.execute', 'executive.clarify',
]);

describe('AB-1 the capability inventory is complete, exclusive, and source-backed', () => {
  test('every capability that can end an operation is capture-eligible or explicitly excluded', () => {
    const dir = tempDir();
    // A configured filesystem root, so every filesystem action is registered: the inventory must
    // cover the actions that exist in that configuration too, not just the default one.
    const app = createApp({ dataDir: dir, now: CLOCK, filesystemRoot: dir });
    const registered = app.registry.names();
    assert.deepEqual(registered.filter((n) => n.startsWith('filesystem.')),
      ['filesystem.batch', 'filesystem.compare', 'filesystem.delete', 'filesystem.extract',
        'filesystem.find', 'filesystem.list', 'filesystem.mkdir', 'filesystem.move',
        'filesystem.read', 'filesystem.report', 'filesystem.restore', 'filesystem.summarize',
        'filesystem.trash', 'filesystem.write']);

    const all = [...new Set([...registered, ...NON_REGISTRY_CAPABILITIES])];
    for (const name of all) {
      const eligible = AUTO_CAPTURE_CAPABILITIES.includes(name);
      const category = CAPTURE_EXCLUDED_CAPABILITIES[name];
      assert.ok(
        eligible !== Boolean(category),
        `${name} must be exactly one of capture-eligible or explicitly excluded; a new capability has to be classified`,
      );
      if (category) assert.ok(CAPTURE_EXCLUSION_CATEGORIES[category], `${name}: unknown exclusion category ${category}`);
    }
    // No stale entries: every exclusion names a capability the application can actually produce.
    for (const name of Object.keys(CAPTURE_EXCLUDED_CAPABILITIES)) {
      assert.ok(all.includes(name), `stale exclusion entry: ${name}`);
    }
    // The exact subset, in the order the documentation states it. Adding a sixth would be a
    // deliberate decision that also changes this assertion.
    assert.deepEqual([...AUTO_CAPTURE_CAPABILITIES], [
      'memory.add', 'memory.correct', 'knowledge.add', 'knowledge.retract', 'knowledge.resolve',
    ]);
  });

  test('the five completion paths are declared, and each declares its audit writer and capture stance', () => {
    assert.deepEqual(OPERATION_COMPLETION_PATHS.map((p) => p.id), [
      'request', 'memory-correction', 'command', 'task-operation', 'task-step',
    ]);
    assert.equal(new Set(OPERATION_COMPLETION_PATHS.map((p) => p.id)).size, OPERATION_COMPLETION_PATHS.length);
    for (const entry of OPERATION_COMPLETION_PATHS) {
      assert.equal(typeof entry.entry, 'string');
      assert.ok(['controller', 'task-runner'].includes(entry.audit), `${entry.id}: ${entry.audit}`);
      assert.ok(['attempted', 'not-attempted'].includes(entry.capture), `${entry.id}: ${entry.capture}`);
      assert.equal(typeof entry.note, 'string');
    }
    // The documented order is the contract the implementation claims to follow.
    assert.deepEqual([...FINALIZATION_ORDER], [
      'outcome-finalized',
      'side-effect-established',
      'audit-appended',
      'audit-recording-established',
      'capture-attempted',
      'capture-verified',
      'disclosure-produced',
      'operation-result-returned',
    ]);
    // No frozen entry can be edited at run time, which is what makes the test above meaningful.
    assert.equal(Object.isFrozen(OPERATION_COMPLETION_PATHS), true);
    assert.equal(Object.isFrozen(OPERATION_COMPLETION_PATHS[0]), true);
  });
});

describe('AB-2 every completion path reaches the contract, once', () => {
  test('one operation through each path writes one audit record, and only eligible writes become experiences', async () => {
    const dir = tempDir();
    const app = appFor(dir);

    const request = await remember(app, 'the deployment window is held');
    assert.equal(request.status, Outcome.SUCCESS_VERIFIED);
    const memoryId = lastMemoryId(dir);
    const correction = await app.controller.correctMemory({
      targetId: memoryId, content: 'the deployment window is postponed', resolve: true,
    });
    assert.equal(correction.status, Outcome.SUCCESS_VERIFIED, correction.display ?? correction.output);
    const added = await app.controller.knowledgeAdd({ subject: 'release', relationship: 'scheduled for', object: 'Friday' });
    assert.equal(added.status, Outcome.SUCCESS_VERIFIED, added.display ?? added.output);
    const read = await app.controller.knowledgeList({ limit: 5 });
    assert.equal(read.status, Outcome.SUCCESS_VERIFIED, read.display ?? read.output);

    const planned = await app.controller.planTask('remember that the standup is at nine');
    assert.equal(planned.status, Outcome.PLAN_CREATED, planned.display ?? planned.output);
    const run = await app.controller.runTask(planned.task.id, 'run');
    assert.equal(run.status, Outcome.SUCCESS_VERIFIED, run.display ?? run.output);

    const records = auditOf(dir);
    const countOf = (capability) => records.filter((r) => r.capability === capability).length;
    assert.equal(countOf('memory.add'), 1, 'handle() appended exactly one record');
    assert.equal(countOf('memory.correct'), 1, 'correctMemory() appended exactly one record');
    assert.equal(countOf('knowledge.add'), 1, 'the command path appended exactly one record');
    assert.equal(countOf('knowledge.list'), 1, 'an audited read appended exactly one record');
    assert.equal(countOf('task.plan'), 1, 'planTask appended exactly one record');
    assert.equal(countOf('task.step'), 1, 'the task runner appended exactly one record for its one step');
    assert.equal(countOf('task.run'), 1, 'runTask appended exactly one record');
    assert.equal(records.length, 7);
    assert.equal(new Set(records.map((r) => r.id)).size, records.length, 'no operation id appears twice');

    // The five eligible capabilities are not the five paths: only the three write operations here
    // are inside the subset. The read and both task records are audited and never captured.
    assert.deepEqual(experiencesOf(dir).map((r) => r.capability).sort(), ['knowledge.add', 'memory.add', 'memory.correct']);
    for (const record of experiencesOf(dir)) {
      assert.equal(record.provenance.origin, 'system_observed');
    }
  });

  test('the audit record is on disk before capture is attempted, for every captured operation', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const original = app.experience.recordExperience.bind(app.experience);
    const seen = [];
    app.experience.recordExperience = async (spec) => {
      seen.push({
        operationId: spec.operationId,
        auditPresent: auditOf(dir).some((r) => r.id === spec.operationId),
      });
      return original(spec);
    };

    await remember(app, 'the release train is delayed');
    await app.controller.knowledgeAdd({ subject: 'release', relationship: 'delayed for', object: 'a day' });

    assert.equal(seen.length, 2, 'both eligible operations reached capture');
    for (const call of seen) {
      assert.equal(call.auditPresent, true, `capture for ${call.operationId} saw the audit record already written`);
    }
    assert.equal(experiencesOf(dir).length, 2);
  });

  test('knowledge.resolve is captured through its real conflict path', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await app.controller.knowledgeAdd({ subject: 'the engine', relationship: 'runs on', object: 'diesel' });
    await app.controller.knowledgeAdd({ subject: 'the engine', relationship: 'runs on', object: 'coal' });
    const [diesel, coal] = readRecords(path.join(dir, 'knowledge.jsonl')).map((r) => r.id);
    const resolved = await app.controller.knowledgeResolve({ target: coal, choose: diesel, reason: 'service record' });
    assert.equal(resolved.status, Outcome.SUCCESS_VERIFIED, resolved.display ?? resolved.output);

    assert.deepEqual(experiencesOf(dir).map((r) => r.capability).sort(), [
      'knowledge.add', 'knowledge.add', 'knowledge.resolve',
    ]);
    const recorded = experiencesOf(dir).find((r) => r.capability === 'knowledge.resolve');
    assert.match(recorded.subject, /^knowledge\.resolve: /, 'the resolution capture is an account of the operation, not of the choice');
    assert.equal(recorded.assessments, undefined, 'a captured resolution carries no assessment');
    assert.equal(feedbackOf(dir).length, 0, 'capture wrote no feedback');
  });

  test('a model-origin request is denied, audited, and never captured - arming capture changes nothing', async () => {
    for (const mode of [CAPTURE_OFF, CAPTURE_VERIFIED_SUCCESS]) {
      const dir = tempDir();
      const app = appFor(dir, mode);
      const res = await app.controller.handle('remember that the vault code is 4411', { origin: 'model' });
      assert.equal(res.status, Outcome.ACTION_DENIED, `${mode}: a model may not write memory`);
      assert.equal(res.recorded, true, `${mode}: the refusal is audited`);
      assert.equal(auditOf(dir).length, 1);
      assert.equal(experiencesOf(dir).length, 0, `${mode}: no experience of a denied operation`);
      assert.equal(feedbackOf(dir).length, 0, `${mode}: no feedback from a model-origin operation`);
      assert.doesNotMatch(res.display ?? '', /Experience:/, `${mode}: no capture was attempted, so no notice claims one`);
    }
  });

  test('capture off leaves deterministic operations exactly as they were', async () => {
    const dir = tempDir();
    const app = appFor(dir, CAPTURE_OFF);
    const calc = await app.controller.handle('calc 2+2', { origin: 'user' });
    assert.equal(calc.status, Outcome.SUCCESS_VERIFIED);
    const added = await remember(app, 'the audit note is kept');
    assert.equal(added.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(added.display.includes('captured'), false, 'capture off adds no notice');
    assert.equal(fs.existsSync(LOG(dir)), false, 'capture off writes no experience file at all');
    assert.equal(auditOf(dir).length, 2, 'both operations were audited');
  });
});

describe('AB-3 the finalization helper separates audit failure from operation outcome', () => {
  test('an audit-append failure is reported, told to capture, and never rewrites the operation', async () => {
    const failures = [];
    const captureCalls = [];
    const op = { id: 'abcdef0123456789', status: Outcome.SUCCESS_VERIFIED, output: 'stored', errors: [] };
    const res = await finalizeOperation(op, {
      append: async (record) => {
        assert.equal(record, op, 'the caller appends the record it finalized');
        throw new Error('injected: audit log refused');
      },
      capture: async (record, opts) => { captureCalls.push({ same: record === op, recorded: opts.recorded }); return null; },
      onAuditFailure: (err) => failures.push(err.message),
    });

    assert.equal(res.recorded, false);
    assert.equal(res.recordError, 'injected: audit log refused');
    assert.deepEqual(failures, ['injected: audit log refused'], 'the caller is told, so it can disclose');
    assert.deepEqual(captureCalls, [{ same: true, recorded: false }], 'capture is told the append did not succeed');
    assert.equal(op.status, Outcome.SUCCESS_VERIFIED, 'the helper never rewrites an outcome');
    assert.equal(op.output, 'stored');
    assert.deepEqual(op.errors, []);
  });

  test('a capture that throws becomes a notice, never an operation failure', async () => {
    let appended = 0;
    const res = await finalizeOperation({ id: 'abcdef0123456789' }, {
      append: async () => { appended += 1; },
      capture: async () => { throw new Error('injected: experience store gone'); },
    });
    assert.equal(appended, 1);
    assert.equal(res.recorded, true);
    assert.match(res.captureNotice, /^Experience: not captured \(injected: experience store gone\)/);
    assert.match(res.captureNotice, /audit record are unchanged/);
  });

  test('finalizing one operation twice is refused instead of appending a second record', async () => {
    const op = { id: 'abcdef0123456789', status: Outcome.SUCCESS_VERIFIED };
    let appended = 0;
    const first = await finalizeOperation(op, {
      append: async () => { appended += 1; },
      capture: async () => null,
    });
    assert.deepEqual(first, { recorded: true, recordError: null, captureNotice: null });

    await assert.rejects(
      () => finalizeOperation(op, { append: async () => { appended += 1; } }),
      /already finalized; a second audit record would duplicate it/,
    );
    assert.equal(appended, 1, 'the refused second finalization appended nothing');
    // The mark is non-enumerable, so a returned or persisted record does not gain a field.
    assert.deepEqual(Object.keys(op).sort(), ['id', 'status']);
    assert.deepEqual(JSON.parse(JSON.stringify(op)), { id: 'abcdef0123456789', status: Outcome.SUCCESS_VERIFIED });
  });
});

describe('AB-4 audit and experience failures at the controller', () => {
  test('a command whose audit record cannot be written is AUDIT_INTEGRITY_FAILED and is not captured', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const original = app.operations.append.bind(app.operations);
    app.operations.append = async () => { throw new Error('injected: audit log refused'); };
    let res;
    try {
      res = await app.controller.knowledgeAdd({ subject: 'release', relationship: 'moved to', object: 'Monday' });
    } finally {
      app.operations.append = original;
    }

    assert.equal(res.status, Outcome.AUDIT_INTEGRITY_FAILED, 'the command may have stored its record');
    assert.equal(res.recorded, false);
    assert.equal(res.recordError, 'injected: audit log refused');
    // The step's own text stays in `display`; the uncertainty is `output`, and the CLI renders both
    // (see formatResult) so the user is told the audit trail lacks this result.
    assert.match(res.output, /The knowledge record may have been stored, but its audit record could not be written\./);
    const rendered = formatResult(res);
    assert.match(rendered, /Audit: {5}NOT RECORDED \(injected: audit log refused\)/);
    assert.match(rendered, /Do not repeat the request just to obtain a record/);
    assert.doesNotMatch(rendered, /Experience:/, 'capture was refused before any store was opened, so nothing claims one');
    assert.equal(experiencesOf(dir).length, 0);
    assert.equal(readRecords(path.join(dir, 'knowledge.jsonl')).length, 1, 'the write itself did happen');
  });

  test('an audited read whose audit record cannot be written keeps its own outcome', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    await app.controller.knowledgeAdd({ subject: 'release', relationship: 'moved to', object: 'Monday' });
    const before = experiencesOf(dir).length;
    const original = app.operations.append.bind(app.operations);
    app.operations.append = async () => { throw new Error('injected: audit log refused'); };
    let res;
    try {
      res = await app.controller.knowledgeList({ limit: 5 });
    } finally {
      app.operations.append = original;
    }
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'a read that changed nothing keeps its outcome');
    assert.equal(res.recorded, false);
    assert.equal(res.recordError, 'injected: audit log refused');
    assert.equal(experiencesOf(dir).length, before, 'a read is never captured, whether or not it was audited');
  });

  test('an experience failure after a verified audit leaves the operation and its record intact', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const original = app.experience.recordExperience.bind(app.experience);
    app.experience.recordExperience = async () => { throw new Error('injected: experience store refused'); };
    let res;
    try {
      res = await remember(app, 'the rollback window is open');
    } finally {
      app.experience.recordExperience = original;
    }
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'the operation is not failed by its bookkeeping');
    assert.equal(res.recorded, true);
    assert.match(res.display, /Experience: not captured \(injected: experience store refused\)/);
    assert.match(res.display, /succeeded and its audit record is unchanged/);
    const [audit] = auditOf(dir);
    assert.equal(audit.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(audit.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED, 'the independent verification still stands');
    assert.equal(experiencesOf(dir).length, 0);
  });

  test('an experience that fails its read-back is disclosed, and the operation still stands', async () => {
    const dir = tempDir();
    const app = appFor(dir);
    const original = app.experience.evidenceCheck.bind(app.experience);
    app.experience.evidenceCheck = async () => ({ ok: false, detail: 'injected: the summary disagrees' });
    let res;
    try {
      res = await remember(app, 'the rollback window is closed');
    } finally {
      app.experience.evidenceCheck = original;
    }
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, 'a failed re-check is not evidence against the operation');
    assert.equal(res.recorded, true);
    assert.match(res.display, /Experience: appended as [0-9a-f]{8} for operation [0-9a-f]{8} \(memory\.add\), but it does not match the audit record \(injected: the summary disagrees\)/);
    assert.match(res.display, /itself succeeded and its audit record is unchanged/);
    // The record was appended before the check and is kept for inspection; a failed check is not a
    // reason to hide or delete it.
    assert.equal(experiencesOf(dir).length, 1);
    const [audit] = auditOf(dir);
    assert.equal(audit.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(audit.capability, 'memory.add');
  });
});
