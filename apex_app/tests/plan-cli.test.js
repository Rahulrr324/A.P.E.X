// Batch AL, work package A and K on the terminal side: the four planning actions that had no command.
//
// AL-11 proved candidate generation, the disclosed comparison, the outcome reading and the recorded
// assessment against the controller and the stores. Those four registered actions - `plan.candidates`,
// `plan.replan`, `plan.outcome`, `plan.assess` - were reachable only from inside the application, while
// the answers the application prints told the user to type them: continuation readiness names
// `node bin/apex.js plan candidates <goal-id>` and `plan outcome <plan-id>`, the preparation answer
// names `plan replan <plan-id>`, and the outcome view's own bound says `plan outcome <plan-id> --json`
// returns every finding and its citations. Until now every one of those hints was a command that
// exited 2.
//
// Each test runs the real entry point as a separate child process against one isolated data directory,
// and asserts both what the command prints and what the store files gain. For the three reads that is
// one operation record and nothing else; for `plan assess` it is exactly one assessment event beside a
// plan record that re-reads byte for byte. The last test takes the commands out of a real answer's own
// text and runs them, so an advertised command cannot quietly rot back into a hint.
//
// No model is contacted and no inference is run: nothing here sends a request anywhere, and the goal,
// criterion and memory text is synthetic.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

const CLOCK = () => new Date('2026-11-05T09:00:00.000Z');
const short = (id) => String(id).slice(0, 8);
const LEAD_BASIS = 'no other candidate that passed every gate is as good on all ranked dimensions and better on one';
// The terminal's own unknown-verb line for `plan`. Quoted once so a refusal of a malformed command can
// be told apart from a verb the CLI has never heard of.
const PLAN_USAGE = 'usage: plan add|list|show|validate|history|compare|candidates|replan|outcome|assess|revise|approve|start|reconcile|continuation|continue|cancel|supersede';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function dir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

function envFor(d) {
  return cleanEnv({ APEX_DATA_DIR: d, HOME: d, USERPROFILE: d });
}

function cli(d, ...args) {
  return runCli(args.map(String), envFor(d));
}

function idFrom(text, kind) {
  const match = new RegExp(`^${kind} ([0-9a-f]{8})`, 'm').exec(text);
  assert.ok(match, `no ${kind} id in output:\n${text}`);
  return match[1];
}

// Every persistent file the run could touch, as its exact bytes.
function census(d) {
  const files = {};
  for (const name of fs.readdirSync(d).sort()) {
    if (name.endsWith('.jsonl')) files[name] = fs.readFileSync(path.join(d, name), 'utf8');
  }
  return files;
}

function changedKeys(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return names.filter((n) => before[n] !== after[n]).sort();
}

function records(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const appended = (before, after) => records(after.slice(before.length));

// `--json` prints the read's own data and then the audit line it is recorded under, so the document is
// everything above that line.
function dataOf(stdout) {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('Audit: '));
  assert.notEqual(at, -1, `no audit line in:\n${stdout}`);
  return JSON.parse(lines.slice(0, at).join('\n'));
}

const linesOf = (stdout) => stdout.split(/\r?\n/);
function hasLine(stdout, needle) {
  return linesOf(stdout).some((l) => l.startsWith(needle));
}

// An active goal with two required criteria, a one-step plan of record, and - when asked for - the run
// that leaves a step outcome for an outcome read to answer from. Every record is made with commands a
// user can type.
async function seededGoal(d) {
  const add = await cli(d, 'goal', 'add', 'list my memory',
    '--criterion', 'the stored list is read back',
    '--criterion', 'a remembered fact appears in it');
  assert.equal(add.code, 0, add.stdout + add.stderr);
  const goalId = idFrom(add.stdout, 'Goal');
  for (const status of ['accepted', 'active']) {
    const up = await cli(d, 'goal', 'update', goalId, status);
    assert.equal(up.code, 0, up.stdout + up.stderr);
  }
  return goalId;
}

async function seededPlan(d, goalId, { run = false } = {}) {
  const step = JSON.stringify({
    id: 's1',
    action: 'memory.list',
    description: 'read the memory list back',
    input: {},
    expectedResult: 'the list is returned',
    verification: 'the task log records the step',
  });
  const add = await cli(d, 'plan', 'add', '--goal', goalId, '--outcome', 'the list is read back', '--step', step);
  assert.equal(add.code, 0, add.stdout + add.stderr);
  const planId = idFrom(add.stdout, 'Plan');
  if (run) {
    const approve = await cli(d, 'plan', 'approve', planId);
    assert.equal(approve.code, 0, approve.stdout + approve.stderr);
    const start = await cli(d, 'plan', 'start', planId);
    assert.equal(start.code, 0, start.stdout + start.stderr);
  }
  return planId;
}

test('`plan candidates` is a command: it answers from the records, is audited, and files nothing else', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const before = census(d);

  const res = await cli(d, 'plan', 'candidates', goalId);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(res.stderr.trim(), '', 'a read that worked has nothing to say on stderr');
  const out = res.stdout;
  assert.ok(/^Candidate plans for goal /.test(linesOf(out)[0]), linesOf(out)[0]);
  assert.ok(hasLine(out, '  required_only: works on the criteria the user made required'), out);
  assert.ok(linesOf(out).includes('    not approved, not started, not executable'), out);
  assert.ok(hasLine(out, '  under that rule required_only leads: '), out);
  assert.ok(hasLine(out, 'No effort estimate appears above'), out);
  assert.ok(hasLine(out, 'These are drafts on screen.'), out);
  assert.ok(hasLine(out, 'Audit: recorded in operations.jsonl '), out);

  const after = census(d);
  assert.deepEqual(changedKeys(before, after), ['operations.jsonl'],
    'a candidate read files no goal, plan, task, or conversation record');
  assert.ok(after['operations.jsonl'].startsWith(before['operations.jsonl']), 'the audit log stays append-only');
  const op = appended(before['operations.jsonl'], after['operations.jsonl']);
  assert.equal(op.length, 1, 'one read, one operation record');
  assert.equal(op[0].capability, 'plan.candidates');
  assert.equal(op[0].origin, 'user');
  assert.equal(op[0].request, `plan candidates ${short(goalId)}`);
  assert.equal(op[0].status, Outcome.SUCCESS_VERIFIED);
  assert.deepEqual(op[0].steps.map((s) => `${s.action}:${s.outcome}`), ['plan.candidates:success_verified']);
  assert.equal(op[0].steps[0].display, undefined, 'the stored step holds no second copy of the answer');
  assert.match(op[0].steps[0].verification.detail, /none added by this read/,
    'the action re-checks, from the store, that it left no draft behind');

  const json = await cli(d, 'plan', 'candidates', goalId, '--json');
  assert.equal(json.code, 0, json.stdout + json.stderr);
  const data = dataOf(json.stdout);
  assert.equal(data.goalId.length, 36, 'the read answers the whole goal id');
  assert.deepEqual([data.recorded, data.approved, data.executable], [false, false, false],
    'the read says of its own data that it recorded, approved and started nothing');
  assert.equal(data.candidates.length, 1);
  assert.equal(typeof data.candidates[0].digest, 'string');
  assert.equal(data.comparison.leading, 'required_only');
  assert.equal(data.comparison.basis, LEAD_BASIS);
  assert.equal(data.work, null);

  const worked = await cli(d, 'plan', 'candidates', goalId, '--work', 'before the demo on Friday', '--json');
  assert.equal(worked.code, 0, worked.stdout + worked.stderr);
  assert.equal(dataOf(worked.stdout).work, 'before the demo on Friday',
    'the framing the user named is echoed by the read that answers to it');
});

test('a candidate read honours a capability the user took away instead of inventing a step', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const before = census(d);

  const gated = await cli(d, 'plan', 'candidates', goalId, '--cannot-use', 'memory.list');
  assert.equal(gated.code, 0, gated.stdout + gated.stderr);
  assert.ok(gated.stdout.startsWith('No candidate plan could be recorded: no-capability'), gated.stdout);
  assert.ok(hasLine(gated.stdout, 'APEX does not invent a capability to fill a gap'), gated.stdout);

  const data = dataOf((await cli(d, 'plan', 'candidates', goalId, '--cannot-use', 'memory.list', '--json')).stdout);
  assert.deepEqual(data.cannotUse, ['memory.list']);
  assert.deepEqual(data.candidates, []);
  assert.equal(data.comparison.ok, false);
  assert.equal(data.comparison.reason, 'no-capability');
  assert.equal(data.comparison.leading, null, 'nothing is led to when nothing passed the gates');
  assert.equal(data.clarificationNeeded, true);

  // A name the registry does not hold is refused, not ignored: an ignored typo would leave the
  // excluded capability in the plan, which is the one thing the constraint was asked to prevent.
  const typo = await cli(d, 'plan', 'candidates', goalId, '--cannot-use', 'not.a.real.action');
  assert.equal(typo.code, 1, typo.stdout + typo.stderr);
  assert.match(typo.stdout, /cannot_use names an action this configuration does not register: not\.a\.real\.action/);

  const after = census(d);
  assert.deepEqual(changedKeys(before, after), ['operations.jsonl']);
  const ops = appended(before['operations.jsonl'], after['operations.jsonl']);
  assert.deepEqual(ops.map((o) => o.status), [Outcome.SUCCESS_VERIFIED, Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED],
    'a refusal is recorded as the outcome it had, and the excluded-capability read still succeeds');
});

test('the planning verbs refuse a malformed command before any store is opened', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const before = census(d);

  const cases = [
    [['plan', 'candidates'], 'usage: plan candidates <goal-id>'],
    [['plan', 'candidates', goalId, goalId], 'usage: plan candidates <goal-id>'],
    [['plan', 'candidates', goalId, '--limit', '3'], 'unknown option --limit'],
    [['plan', 'replan'], 'usage: plan replan <plan-id>'],
    [['plan', 'outcome'], 'usage: plan outcome <plan-id>'],
    [['plan', 'assess'], 'usage: plan assess <plan-id>'],
    [['plan', 'outcome', goalId, '--bogus'], 'unknown option --bogus'],
    // `--json` is a read view. The one planning command that writes has no data to print in its place.
    [['plan', 'assess', goalId, '--json'], 'unknown option --json'],
    [['plan', 'frobnicate', goalId], PLAN_USAGE],
  ];
  for (const [args, needle] of cases) {
    const res = await cli(d, ...args);
    assert.equal(res.code, 2, `${args.join(' ')} exited ${res.code}: ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, '', `${args.join(' ')} printed a result for a command it refused`);
    assert.ok(res.stderr.includes(needle), `${args.join(' ')}: ${res.stderr} does not say ${needle}`);
  }
  assert.deepEqual(changedKeys(before, census(d)), [],
    'a usage refusal opens no store and writes no record');

  const help = await cli(d, 'help');
  assert.equal(help.code, 0, help.stdout + help.stderr);
  for (const advertised of [
    'node bin/apex.js plan candidates <goal-id>',
    'node bin/apex.js plan replan <plan-id>',
    'node bin/apex.js plan outcome <plan-id>',
    'node bin/apex.js plan assess <plan-id>',
  ]) {
    assert.ok(help.stdout.includes(advertised), `help does not advertise ${advertised}`);
  }
});

test('a flag that carries a credential is refused, and the value never reaches the audit log', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const planId = await seededPlan(d, goalId);
  const files = census(d);

  // These two flags are new ways for a user's words to reach a stored operation, so they take the same
  // boundary every other text field takes: refused at the action, and masked in the step it recorded.
  const withWork = await cli(d, 'plan', 'candidates', goalId, '--work', 'with password=hunter2 in the note');
  assert.equal(withWork.code, 1, withWork.stdout + withWork.stderr);
  assert.match(withWork.stdout, /^input rejected: work looks like a password, key, or token; it was not stored/);

  const withReason = await cli(d, 'plan', 'replan', planId, '--reason', 'because api_key=sk-abcdefghij changed');
  assert.equal(withReason.code, 1, withReason.stdout + withReason.stderr);
  assert.match(withReason.stdout, /^input rejected: reason looks like a password, key, or token/);

  const after = census(d);
  assert.deepEqual(changedKeys(files, after), ['operations.jsonl'], 'a refused read touches no store but the audit log');
  const ops = appended(files['operations.jsonl'], after['operations.jsonl']);
  assert.deepEqual(ops.map((o) => `${o.capability}:${o.status}:${o.decision}`), [
    'plan.candidates:input_rejected:refuse_or_block',
    'plan.replan:input_rejected:refuse_or_block',
  ], 'the refusal is recorded as a refusal, not as an answer');
  for (const [i, field] of [[0, 'work'], [1, 'reason']]) {
    assert.equal(ops[i].steps[0].input[field], '[omitted: contained a password, key, or token]',
      `the refused --${field} is stored masked, not in clear`);
  }
  assert.equal(/hunter2|sk-abcdefghij/.test(after['operations.jsonl']), false,
    'no copy of either value survives anywhere in the audit log');
});

test('`plan outcome` and `plan assess` on a plan that never ran: nothing to assess, and no assessment filed', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const planId = await seededPlan(d, goalId);
  const before = census(d);

  const read = await cli(d, 'plan', 'outcome', planId);
  assert.equal(read.code, 0, read.stdout + read.stderr);
  assert.ok(hasLine(read.stdout, "This plan's outcome cannot be assessed: the plan has not been started"), read.stdout);
  assert.ok(hasLine(read.stdout, 'Recording an assessment is plan.assess, and it needs an outcome to assess.'), read.stdout);

  const data = dataOf((await cli(d, 'plan', 'outcome', planId, '--json')).stdout);
  assert.equal(data.assessed, false);
  assert.equal(data.recordable, false);
  assert.equal(data.recorded, false);
  assert.deepEqual(data.priorAssessments, []);
  assert.equal(data.planSnapshot.status, 'draft');

  const refused = await cli(d, 'plan', 'assess', planId);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /has no execution outcome to assess: the plan has not been started/);

  const after = census(d);
  assert.deepEqual(changedKeys(before, after), ['operations.jsonl'],
    'a plan that never ran yields no assessment event, and its draft record is untouched');
  const ops = appended(before['operations.jsonl'], after['operations.jsonl']);
  assert.deepEqual(ops.map((o) => `${o.capability}:${o.status}`), [
    'plan.outcome:success_verified', 'plan.outcome:success_verified', 'plan.assess:execution_failed',
  ]);

  // A refused read has no data to print, so `--json` says what happened instead of `{}`: an empty
  // document would read as a successful read of nothing.
  const missing = await cli(d, 'plan', 'outcome', 'ffffffff', '--json');
  assert.equal(missing.code, 1, missing.stdout + missing.stderr);
  assert.ok(missing.stdout.startsWith('execution failed: no plan matches "ffffffff"'), missing.stdout);
});

test('`plan outcome` answers seven questions about a run, and cites an operation for each', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const planId = await seededPlan(d, goalId, { run: true });
  const before = census(d);

  const read = await cli(d, 'plan', 'outcome', planId);
  assert.equal(read.code, 0, read.stdout + read.stderr);
  assert.ok(new RegExp(`^Outcome assessment for plan ${planId} v1 \\(completed\\), task [0-9a-f]{8}:`).test(read.stdout), read.stdout);
  assert.ok(hasLine(read.stdout, '  verdict: awaiting_confirmation'), read.stdout);
  assert.ok(hasLine(read.stdout, '  step_completion: 1 of 1 step(s) recorded completed'), read.stdout);
  assert.ok(hasLine(read.stdout, '  external_confirmation: whether the intended outcome holds outside'), read.stdout);
  assert.ok(hasLine(read.stdout, 'No outcome assessment of plan'), read.stdout);
  assert.ok(hasLine(read.stdout, 'This read recorded nothing: an assessment is written by plan.assess'), read.stdout);

  const data = dataOf((await cli(d, 'plan', 'outcome', planId, '--json')).stdout);
  assert.equal(data.assessed, true);
  assert.equal(data.verdict, 'awaiting_confirmation',
    'a verified step is not a completed intention: the goal criteria still cite no evidence');
  assert.deepEqual(data.aspects.map((a) => a.aspect), [
    'step_completion', 'expected_output', 'verification', 'goal_criteria', 'evidence_state',
    'durability', 'external_confirmation',
  ]);
  assert.equal(data.aspects.every((a) => a.answered), true);
  assert.equal(data.findings.length, 7);
  for (const f of data.findings) {
    assert.ok(f.operations.length >= 1, `the ${f.aspect} finding cites no operation`);
    assert.match(f.operations[0], /^[0-9a-f-]{36}$/, `the ${f.aspect} finding cites a partial id`);
  }
  assert.deepEqual(data.auditReads.map((r) => r.state), ['present'],
    'the operation each finding cites is read back out of the audit log');
  assert.equal(data.recordable, true);
  assert.deepEqual([data.recorded, data.authorizes], [false, false]);
  assert.equal(data.progress.completed, 1);

  const after = census(d);
  assert.deepEqual(changedKeys(before, after), ['operations.jsonl'],
    'the outcome read answers from the run without adding a record to it');
});

test('`plan assess` records the derived verdict and leaves the plan it assessed byte-identical', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const planId = await seededPlan(d, goalId, { run: true });
  const beforeRead = await cli(d, 'plan', 'outcome', planId, '--json');
  const before = dataOf(beforeRead.stdout);
  const files = census(d);

  const assessed = await cli(d, 'plan', 'assess', planId);
  assert.equal(assessed.code, 0, assessed.stdout + assessed.stderr);
  assert.ok(hasLine(assessed.stdout, `Recorded outcome assessment for plan ${planId} v1 (completed).`), assessed.stdout);
  assert.ok(hasLine(assessed.stdout, '  verdict: awaiting_confirmation'), assessed.stdout);
  assert.ok(hasLine(assessed.stdout, '  findings: 7 of 7 question(s) answered from records'), assessed.stdout);
  assert.ok(hasLine(assessed.stdout, '  the plan record is unchanged: v1 completed, same content hash, same timestamp, approval unchanged'), assessed.stdout);
  assert.ok(hasLine(assessed.stdout, 'Recording an assessment completes no goal and reopens none, and authorizes nothing.'), assessed.stdout);

  const after = census(d);
  assert.deepEqual(changedKeys(files, after), ['operations.jsonl', 'plans.jsonl'],
    'an assessment writes one plan event and its own audit record, and touches no other store');
  const written = appended(files['plans.jsonl'], after['plans.jsonl']);
  assert.deepEqual(written.map((e) => e.type), ['plan_assessment']);
  assert.equal(written[0].verdict, 'awaiting_confirmation');
  assert.deepEqual(appended(files['operations.jsonl'], after['operations.jsonl']).map((o) => `${o.capability}:${o.status}`),
    ['plan.assess:success_verified']);

  // The plan itself re-reads exactly as it did: the assessment is a record beside the plan.
  const reread = dataOf((await cli(d, 'plan', 'outcome', planId, '--json')).stdout);
  assert.deepEqual(reread.planSnapshot, before.planSnapshot, 'the plan version, status, hash and timestamp are unchanged');
  assert.deepEqual(reread.priorAssessments.map((a) => [a.verdict, a.planVersion, a.stale]),
    [['awaiting_confirmation', 1, false]], 'one assessment is recorded against this version, and it is not stale');
  assert.equal(reread.recorded, false, 're-reading an assessment records nothing');
  assert.ok(hasLine((await cli(d, 'plan', 'outcome', planId)).stdout,
    `Already recorded against this plan: awaiting_confirmation for v1`));

  // The verdict is derived, never accepted: a second recording of the same version is refused, so no
  // command can store a reading twice or overwrite one that stands.
  const twice = await cli(d, 'plan', 'assess', planId);
  assert.equal(twice.code, 1, twice.stdout + twice.stderr);
  assert.match(twice.stdout, /that assessment of version 1 is already recorded/);
  assert.deepEqual(changedKeys(after, census(d)), ['operations.jsonl'], 'the refusal files no assessment');

  const goal = await cli(d, 'goal', 'show', goalId);
  assert.match(goal.stdout, /status: active/, 'recording an assessment completes no goal');
});

test('`plan replan` is a read: it answers with or without a stated reason and leaves the plan as it was', async () => {
  const d = dir();
  const goalId = await seededGoal(d);
  const planId = await seededPlan(d, goalId);
  const files = census(d);
  const snapshot = dataOf((await cli(d, 'plan', 'outcome', planId, '--json')).stdout).planSnapshot;

  const plain = await cli(d, 'plan', 'replan', planId);
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.ok(plain.stdout.startsWith(
    `Revised candidates for plan ${planId} v1 (draft), answering: the user asked for a revised approach to this plan`,
  ), linesOf(plain.stdout)[0]);
  assert.ok(hasLine(plain.stdout, 'The plan record holds no failed or uncertain step outcome'), plain.stdout);
  const revises = linesOf(plain.stdout).find((l) => l.startsWith('    revises '));
  assert.ok(revises, `no revision lineage line:\n${plain.stdout}`);
  assert.ok(revises.includes(short(planId)), 'the revision names no plan of record');
  assert.ok(revises.endsWith('a fresh approval is required'), revises);
  assert.ok(hasLine(plain.stdout, `Plan ${planId} is unchanged by this read, and its approval binds to its own bytes`), plain.stdout);
  assert.ok(hasLine(plain.stdout, 'A revision is recorded with plan.add and authorized with plan.approve, both user acts, after fresh validation.'), plain.stdout);

  const reasoned = await cli(d, 'plan', 'replan', planId, '--reason', 'the recorded plan no longer fits');
  assert.equal(reasoned.code, 0, reasoned.stdout + reasoned.stderr);
  assert.ok(reasoned.stdout.startsWith(
    `Revised candidates for plan ${planId} v1 (draft), answering: the recorded plan no longer fits`,
  ), linesOf(reasoned.stdout)[0]);

  const data = dataOf((await cli(d, 'plan', 'replan', planId, '--reason', 'the recorded plan no longer fits', '--json')).stdout);
  assert.equal(data.reason, 'the recorded plan no longer fits');
  assert.deepEqual([data.recorded, data.approved, data.executable], [false, false, false]);
  assert.equal(data.freshApprovalRequired, true, 'a revision inherits no approval from the plan it revises');
  assert.equal(data.revision.priorVersion, 1);
  assert.equal(data.revision.priorPlanChanged, false);
  assert.equal(data.comparison.leading, 'required_only');
  assert.equal(data.comparison.basis, LEAD_BASIS);

  const after = census(d);
  assert.deepEqual(changedKeys(files, after), ['operations.jsonl'],
    'two replanning reads added two audit records and no plan, goal, or task record');
  assert.deepEqual(dataOf((await cli(d, 'plan', 'outcome', planId, '--json')).stdout).planSnapshot, snapshot,
    'the plan the reads answered for still re-reads byte for byte');
});

test('every plan command a planning answer advertises is a command the terminal takes', async () => {
  const d = dir();
  const app = await createApp({ dataDir: d, now: CLOCK, experienceCapture: CAPTURE_OFF });
  const goal = await app.controller.goalAdd({
    request: 'remember that the release date holds',
    criteria: ['remember that the release date holds'],
  });
  assert.equal(goal.status, Outcome.GOAL_CREATED, goal.output);
  const goalId = goal.operation.steps[0].result.data.goalId;
  const prepared = await app.controller.handle(`prepare a plan for goal ${short(goalId)}`, { origin: 'user' });
  assert.equal(prepared.status, Outcome.PLAN_STORED, prepared.output);

  // The plan commands out of the answer's own text, exactly as it printed them. A hint is followed by
  // two spaces and its gloss, so the command is what comes before that.
  const hints = [...new Set(
    [...prepared.display.matchAll(/node bin\/apex\.js (plan \w+\b[^\n]*)/g)]
      .map((m) => m[1].split(/\s{2,}|\s\(/)[0].replace(/[\s.,;:)"`]+$/, '')),
  )];
  assert.ok(hints.length >= 2, `the preparation answer named no plan command:\n${prepared.display}`);
  assert.ok(hints.some((h) => h.startsWith('plan candidates')),
    'this answer no longer advertises `plan candidates`, so the guard stopped covering the hint it was written for');

  for (const hint of hints) {
    const args = hint.split(' ');
    if (hint.includes('<')) {
      // A placeholder is the user's own words to fill, so this checks only that the verb dispatches:
      // the answer must not name a command the CLI has never heard of.
      const probe = await cli(d, args[0], args[1]);
      assert.ok(!probe.stderr.includes(PLAN_USAGE),
        `"apex ${hint}" names a verb the CLI does not have:\n${probe.stderr}`);
      continue;
    }
    const res = await cli(d, ...args);
    assert.notEqual(res.code, 2,
      `"apex ${hint}" is advertised as typeable and refused by the CLI:\n${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0, `"apex ${hint}" answered nothing`);
  }
});
