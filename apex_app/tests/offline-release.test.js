// Usable offline release acceptance: one owner's workflow across every capability added for it,
// the recorded evidence read back from a second process, and recovery from a damaged or deleted
// store. Everything runs through the assembled application against real files in temp
// directories; no model is configured, started, or contacted.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { PlanStatus } from '../src/plans/model.js';
import { GoalStatus } from '../src/goals/model.js';
import { inspectArchive } from '../src/backup/archive.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appFor() {
  const dataDir = tempDir();
  const root = tempDir();
  const archives = tempDir();
  const app = createApp({ dataDir, filesystemRoot: root, now: () => NOW });
  return { app, dataDir, root, archives };
}

const archivePath = (archives, name = 'release.json') => path.join(archives, name);

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

function failureCode(res) {
  const step = res.operation.steps[0];
  return step.execution.error?.code ?? step.execution.error?.message;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

const SCHEDULE = [
  'title,dueAt',
  'submit the quarterly report,2026-11-20',
  'renew the parking permit,2026-11-10',
  '',
].join('\n');

// The CLI is a separate process, so it cannot be handed the fixed clock above: a command that runs
// with today's date needs dates written relative to today. This fixture is the same two deadlines -
// one five days out, one five days past - so `review --days 7` reports exactly one overdue whenever
// the suite is run, instead of only while a hard-coded date happens to be in the future.
function cliSchedule(today = new Date()) {
  const day = (offset) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  return [
    'title,dueAt',
    `submit the quarterly report,${day(5)}`,
    `renew the parking permit,${day(-5)}`,
    '',
  ].join('\n');
}

function memoryStep(id, criterion, tag) {
  return {
    id,
    description: `remember the ${tag} fact`,
    action: 'memory.add',
    input: { content: `the offline release rehearsal fact ${tag}` },
    dependsOn: [],
    expectedResult: `the ${tag} fact is stored`,
    verification: 'the stored record is read back and its content hash matches',
    criterion,
    risk: 'medium',
    estimateSeconds: 1,
  };
}

describe('the offline release workflow', () => {
  test('every capability records verified evidence, and a restore brings the stores back', async () => {
    const { app, dataDir, root, archives } = appFor();

    const claim = await app.controller.knowledgeAdd({ subject: 'release train', relationship: 'is', object: 'offline' });
    assert.equal(claim.status, Outcome.SUCCESS_VERIFIED, claim.display);

    const note = await app.controller.noteAdd({
      title: 'Release checklist', body: 'verify export and restore before shipping', tags: ['release'],
    });
    assert.equal(note.status, Outcome.SUCCESS_VERIFIED, note.display);
    const noteId = dataOf(note).id;
    assert.equal(dataOf(note).body, undefined, 'the note body is not copied into the operation record');

    const found = await app.controller.noteSearch({ query: 'export' });
    assert.equal(found.status, Outcome.SUCCESS_VERIFIED, found.display);
    assert.equal(dataOf(found).results.length, 1);

    const revised = await app.controller.noteUpdate({
      target: noteId, body: 'verify export, inspect, and restore before shipping',
    });
    assert.equal(revised.status, Outcome.SUCCESS_VERIFIED, revised.display);

    // A real file lifecycle in the workspace: create a directory, write, move, quarantine, restore.
    assert.equal((await app.controller.workspaceMkdir({ path: 'reports' })).status, Outcome.SUCCESS_VERIFIED);
    const wrote = await app.controller.workspaceWrite({ path: 'reports/draft.txt', content: 'first pass\n' });
    assert.equal(wrote.status, Outcome.SUCCESS_VERIFIED, wrote.display);
    assert.equal((await app.controller.workspaceMove({ path: 'reports/draft.txt', to: 'reports/final.txt' })).status, Outcome.SUCCESS_VERIFIED);
    const removed = await app.controller.workspaceDelete({ path: 'reports/final.txt' });
    assert.equal(removed.status, Outcome.SUCCESS_VERIFIED, removed.display);
    assert.equal(fs.existsSync(path.join(root, 'reports', 'final.txt')), false);
    const broughtBack = await app.controller.workspaceRestore({ id: dataOf(removed).trashId });
    assert.equal(broughtBack.status, Outcome.SUCCESS_VERIFIED, broughtBack.display);
    assert.equal(fs.readFileSync(path.join(root, 'reports', 'final.txt'), 'utf8'), 'first pass\n');

    // Deadlines come from a local file the owner wrote, and keep that file's name and line.
    fs.writeFileSync(path.join(root, 'schedule.csv'), SCHEDULE);
    const imported = await app.controller.deadlineImport({ path: 'schedule.csv' });
    assert.equal(imported.status, Outcome.SUCCESS_VERIFIED, imported.display);
    assert.deepEqual([dataOf(imported).added, dataOf(imported).duplicates, dataOf(imported).total], [2, 0, 2]);
    assert.match(imported.display, /nothing was scheduled, and no due date was inferred/);

    const extracted = await app.controller.workspaceExtract({ path: 'schedule.csv' });
    assert.equal(extracted.status, Outcome.SUCCESS_VERIFIED, extracted.display);
    assert.equal(dataOf(extracted).format, 'csv');
    assert.equal(dataOf(extracted).rows, 3, 'the header plus two entries');
    assert.match(dataOf(extracted).textSha256, /^[0-9a-f]{64}$/);
    assert.equal('text' in dataOf(extracted), false, 'the operation record holds a hash, not the document text');

    // The same two dates, answering a question without a model and showing the overdue one.
    const due = await app.controller.handle('what is due within 7 days', { origin: 'user' });
    assert.equal(due.status, Outcome.SUCCESS_VERIFIED, due.display);
    assert.match(due.display, /renew the parking permit/);

    const review = await app.controller.workReview({ horizonDays: 7 });
    assert.equal(review.status, Outcome.SUCCESS_VERIFIED, review.display);
    assert.deepEqual(dataOf(review).counts.deadlines, { total: 2, within: 2, overdue: 1 });
    assert.match(review.display, /deadlines: 2 recorded, 2 within 7 day\(s\), 1 overdue/);

    // Goal -> plan -> approval -> verified execution. The plan completes; the goal does not, because
    // its criteria are evidence the owner records, not a side effect of running steps.
    const goal = await app.controller.goalAdd({
      request: 'rehearse the offline release',
      criteria: ['the release rehearsal fact is stored', 'the second rehearsal fact is stored'],
    });
    assert.equal(goal.status, Outcome.GOAL_CREATED, goal.output);
    const goalId = dataOf(goal).goalId;
    assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'accepted' })).status, Outcome.GOAL_UPDATED);
    assert.equal((await app.controller.goalUpdate({ target: goalId, status: 'active' })).status, Outcome.GOAL_UPDATED);

    const added = await app.controller.planAdd({
      goalId,
      outcome: 'the release rehearsal facts are stored',
      steps: [memoryStep('s1', 'c1', 'a'), memoryStep('s2', 'c2', 'b')],
    });
    assert.equal(added.status, Outcome.PLAN_STORED, added.output);
    assert.equal(dataOf(added).validation.ok, true, JSON.stringify(dataOf(added).validation.problems));
    const planId = dataOf(added).planId;
    assert.equal((await app.controller.planApprove({ target: planId })).status, Outcome.PLAN_STORED);

    const ran = await app.controller.planActivate(planId, { mode: 'run' });
    assert.equal(ran.status, Outcome.SUCCESS_VERIFIED, ran.display);
    assert.match(ran.display, /is completed/);
    assert.equal((await app.controller.showPlan(planId)).plan.status, PlanStatus.COMPLETED);
    assert.equal((await app.controller.showGoal(goalId)).goal.status, GoalStatus.ACTIVE);

    // A versioned archive of everything written so far, validated by re-reading it.
    const exported = await app.controller.backupExport({ path: archivePath(archives) });
    assert.equal(exported.status, Outcome.SUCCESS_VERIFIED, exported.display);
    const digest = dataOf(exported).archiveSha256;
    assert.match(digest, /^[0-9a-f]{64}$/);
    const inspected = await app.controller.backupInspect({ path: archivePath(archives) });
    assert.equal(inspected.status, Outcome.SUCCESS_VERIFIED, inspected.display);
    assert.equal(dataOf(inspected).ok, true);
    assert.match(inspected.display, /is valid and can be restored/);

    // Work written after the archive is not overwritten without an explicit confirmation.
    const scratch = await app.controller.noteAdd({ title: 'Post backup scratch', body: 'written after the snapshot' });
    assert.equal(scratch.status, Outcome.SUCCESS_VERIFIED, scratch.display);
    assert.equal(dataOf(await app.controller.noteSearch({ query: 'scratch' })).results.length, 1);

    const refused = await app.controller.backupRestore({ path: archivePath(archives), confirm: digest.slice(0, 12) });
    assert.equal(refused.status, Outcome.EXECUTION_FAILED);
    assert.equal(failureCode(refused), 'BACKUP_REPLACE_REQUIRED');

    const restored = await app.controller.backupRestore({
      path: archivePath(archives), confirm: digest.slice(0, 12), replaceExisting: true,
    });
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.operation.steps[0].verification.detail);
    const restoreData = dataOf(restored);
    assert.ok(restoreData.replaced.includes('notes.jsonl'));
    assert.ok(restoreData.replaced.includes('operations.jsonl'), 'the audit written after the snapshot is preserved, not hidden');
    assert.ok(restoreData.safetyPath !== null && fs.existsSync(restoreData.safetyPath));
    assert.match(restored.display, /appended to the restored audit log/);
    assert.equal(dataOf(await app.controller.noteSearch({ query: 'scratch' })).results.length, 0, 'the late note is gone');
    assert.equal(dataOf(await app.controller.noteSearch({ query: 'export' })).results.length, 1);

    // The restored log holds the snapshot's records first, and the restore's own line is appended
    // immediately after them, so the replacement is recorded rather than hidden.
    const snapshotOps = dataOf(exported).files.find((file) => file.name === 'operations.jsonl').lines;
    const ops = readJsonl(path.join(dataDir, 'operations.jsonl'));
    assert.equal(ops[snapshotOps].capability, 'backup.restore');
    assert.equal(ops[snapshotOps].status, Outcome.SUCCESS_VERIFIED);
    assert.equal(ops.filter((op) => op.capability === 'backup.restore').length, 1);

    // A second process sees the restored state: notes, deadlines, the plan, and the workspace file.
    const reopened = createApp({ dataDir, filesystemRoot: root, now: () => NOW });
    const notesAgain = await reopened.controller.noteSearch({ query: 'export' });
    assert.equal(notesAgain.status, Outcome.SUCCESS_VERIFIED, notesAgain.display);
    assert.match(notesAgain.display, /Release checklist/);
    const history = await reopened.controller.noteHistory({ target: noteId });
    assert.equal(dataOf(history).history.versions.length, 2, 'the revision survived the round trip');

    const deadlines = await reopened.controller.deadlineList({ horizonDays: 30 });
    assert.equal(deadlines.status, Outcome.SUCCESS_VERIFIED, deadlines.display);
    assert.match(deadlines.display, /renew the parking permit/);
    assert.match(deadlines.display, /schedule\.csv:3/);

    const reviewAgain = await reopened.controller.workReview({ horizonDays: 7 });
    assert.deepEqual(dataOf(reviewAgain).counts.deadlines, { total: 2, within: 2, overdue: 1 });
    assert.equal((await reopened.controller.showPlan(planId)).plan.status, PlanStatus.COMPLETED);
    assert.equal(fs.readFileSync(path.join(root, 'reports', 'final.txt'), 'utf8'), 'first pass\n');
  });

  test('a corrupt store is repaired from the archive, and the corrupt bytes are preserved first', async () => {
    const { app, dataDir, archives } = appFor();
    assert.equal(
      (await app.controller.knowledgeAdd({ subject: 'Alpha', relationship: 'is', object: 'one' })).status,
      Outcome.SUCCESS_VERIFIED,
    );
    const exported = await app.controller.backupExport({ path: archivePath(archives) });
    const digest = dataOf(exported).archiveSha256;

    fs.appendFileSync(path.join(dataDir, 'knowledge.jsonl'), '{"truncated":\n');
    const broken = await app.controller.knowledgeList({ limit: 10 });
    assert.equal(broken.status, Outcome.EXECUTION_FAILED, 'a corrupt store is refused, not reported as empty');

    const restored = await app.controller.backupRestore({
      path: archivePath(archives), confirm: digest.slice(0, 12), replaceExisting: true,
    });
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.operation.steps[0].verification.detail);
    const data = dataOf(restored);
    assert.ok(data.replaced.includes('knowledge.jsonl'));
    assert.ok(data.safetyPath !== null);

    // The pre-restore archive is a real archive holding the damaged line, so the evidence of the
    // failure is not lost when the store is repaired.
    const safety = await inspectArchive({ source: data.safetyPath });
    assert.equal(safety.ok, true, safety.problems.join('; '));
    const damaged = safety.files.find((file) => file.name === 'knowledge.jsonl');
    assert.ok(damaged.unparsed >= 1, 'the safety copy reports the unparseable line');
    assert.match(damaged.text, /\{"truncated":/);

    const listed = await app.controller.knowledgeList({ limit: 10 });
    assert.equal(listed.status, Outcome.SUCCESS_VERIFIED, listed.display);
    assert.match(listed.display, /Alpha/);
  });

  test('a data directory whose stores were deleted is rebuilt by a confirmed restore', async () => {
    const { app, dataDir, root, archives } = appFor();
    assert.equal(
      (await app.controller.knowledgeAdd({ subject: 'Alpha', relationship: 'is', object: 'one' })).status,
      Outcome.SUCCESS_VERIFIED,
    );
    assert.equal(
      (await app.controller.noteAdd({ title: 'Recovery note', body: 'the stores were rebuilt from an archive' })).status,
      Outcome.SUCCESS_VERIFIED,
    );
    fs.writeFileSync(path.join(root, 'schedule.csv'), SCHEDULE);
    assert.equal((await app.controller.deadlineImport({ path: 'schedule.csv' })).status, Outcome.SUCCESS_VERIFIED);

    const exported = await app.controller.backupExport({ path: archivePath(archives) });
    const digest = dataOf(exported).archiveSha256;
    const archived = dataOf(exported).files.map((file) => file.name);
    for (const name of archived) fs.unlinkSync(path.join(dataDir, name));

    // No file is overwritten, so no confirmation beyond the archive digest and no pre-restore copy
    // is required. This is the case the restore classification distinguishes from a replacement.
    const restored = await app.controller.backupRestore({ path: archivePath(archives), confirm: digest.slice(0, 12) });
    assert.equal(restored.status, Outcome.SUCCESS_VERIFIED, restored.operation.steps[0].verification.detail);
    const data = dataOf(restored);
    assert.deepEqual(data.replaced, []);
    assert.deepEqual([...data.created].sort(), [...archived].sort());
    assert.equal(data.safetyPath, null);
    assert.match(restored.display, /no existing file was replaced, so none was written/);

    const reopened = createApp({ dataDir, filesystemRoot: root, now: () => NOW });
    assert.match((await reopened.controller.knowledgeList({ limit: 10 })).display, /Alpha/);
    assert.match((await reopened.controller.noteSearch({ query: 'rebuilt' })).display, /Recovery note/);
    const deadlines = await reopened.controller.deadlineList({ horizonDays: 30 });
    assert.match(deadlines.display, /submit the quarterly report/);
    assert.match(deadlines.display, /renew the parking permit/);
  });
});

describe('the release surface without a model', () => {
  test('the documented commands run offline and a restore is confirmed on the command line', async () => {
    const dataDir = tempDir();
    const root = tempDir();
    const archives = tempDir();
    fs.writeFileSync(path.join(root, 'schedule.csv'), cliSchedule());
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_DATA_ISOLATED: '1', APEX_FILESYSTEM_ROOT: root });
    const destination = archivePath(archives, 'cli.json');

    const added = await runCli(['note', 'add', '--title', 'Release checklist', '--body', 'verify export and restore', '--tag', 'release'], env);
    assert.equal(added.code, 0, added.stderr);
    const search = await runCli(['note', 'search', 'restore'], env);
    assert.equal(search.code, 0, search.stderr);
    assert.match(search.stdout, /Release checklist/);

    assert.equal((await runCli(['workspace', 'mkdir', 'reports'], env)).code, 0);
    const wrote = await runCli(['workspace', 'write', 'reports/plan.txt', '--content', 'ship the offline build'], env);
    assert.equal(wrote.code, 0, wrote.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'reports', 'plan.txt'), 'utf8'), 'ship the offline build');

    const imported = await runCli(['deadline', 'import', 'schedule.csv'], env);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /nothing was scheduled, and no due date was inferred/);
    const listed = await runCli(['deadline', 'list', '--days', '30'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /renew the parking permit/);
    const review = await runCli(['review', '--days', '7'], env);
    assert.equal(review.code, 0, review.stderr);
    assert.match(review.stdout, /1 overdue/);

    const exported = await runCli(['backup', 'export', destination], env);
    assert.equal(exported.code, 0, exported.stderr);
    const digest = exported.stdout.match(/archive sha256: ([0-9a-f]{64})/);
    assert.ok(digest, exported.stdout);
    const inspected = await runCli(['backup', 'inspect', destination], env);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.match(inspected.stdout, /is valid and can be restored/);

    // A later note means the live audit differs from the snapshot; the restore says so and refuses
    // until the owner confirms the replacement.
    assert.equal((await runCli(['note', 'add', '--title', 'Later note', '--body', 'written after the export'], env)).code, 0);
    const refused = await runCli(['backup', 'restore', destination, '--confirm', digest[1].slice(0, 12)], env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /replaceExisting|replace-existing/);
    const restored = await runCli(
      ['backup', 'restore', destination, '--confirm', digest[1].slice(0, 12), '--replace-existing'],
      env,
    );
    assert.equal(restored.code, 0, restored.stderr);
    assert.match(restored.stdout, /appended to the restored audit log/);
    const after = await runCli(['note', 'search', 'Later'], env);
    assert.equal(after.code, 0, after.stderr);
    assert.ok(!after.stdout.includes('Later note'), after.stdout);
  });
});
