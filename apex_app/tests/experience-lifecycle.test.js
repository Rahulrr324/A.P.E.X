// Batch Z §9: one deterministic, end-to-end demonstration of the experience-to-adaptation
// cycle, driven through the real CLI process the way a user drives it.
//
// The ten steps are the five states the batch promises, in the order a user would meet them:
// APEX does something auditable, the user records it as an experience, assesses it, repeated
// assessment becomes a candidate, the candidate does nothing until the user approves it, the
// approved rule reaches future context as wording only, conflicting rules stay visible instead
// of being chosen for, a corrected experience withdraws the evidence under an approval, and a
// retirement excludes a rule without deleting anything.
//
// Every assertion quotes output the CLI actually produced; nothing here paraphrases. Two things
// are proven structurally rather than by wording: no inference runs (the request path reports
// `model_unavailable`, and `cleanEnv` removes every APEX_* setting so no backend can be
// configured), and the log is append-only (the file after an approval is a byte-for-byte prefix
// of the file at the end). Model output, adapter behaviour and any real backend are out of scope
// and untested by this file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';
import { OperationLog } from '../src/operations/operation-log.js';

const AUDIT = /operations\.jsonl \(([0-9a-f-]{36})\)/;
const AUDIT_ALL = /operations\.jsonl \(([0-9a-f-]{36})\)/g;
const EXPERIENCE_ID = /Recorded experience ([0-9a-f]{8})/;
const FEEDBACK_ID = /Recorded your feedback ([0-9a-f]{8})/;
const DECISION_ID = /Recorded your decision ([0-9a-f]{8}) on adaptation ([0-9a-f]{8}): approved\./;
const DERIVED = /^ {2}\[([0-9a-f]{8})\] scope memory\.add \| rule: (.+)$/gm;
const CONFLICT_PAIR = /\(memory\.add: ([0-9a-f]{8}), ([0-9a-f]{8})\)/;

const dirs = [];
const results = [];
const auditIds = new Set();
const ids = {};

let env;
let logPath;
let ops;
// The log as it stood immediately after the first approval: every step that follows must
// extend it, never rewrite it.
let prefixAfterApproval = null;

function remember(label, res) {
  results.push({ label, code: res.code, stdout: res.stdout, stderr: res.stderr });
  for (const match of res.stdout.matchAll(AUDIT_ALL)) auditIds.add(match[1]);
  return res;
}

function resultOf(label) {
  const hits = results.filter((r) => r.label === label);
  assert.equal(hits.length, 1, `expected to have run '${label}' exactly once, ran ${hits.length} times`);
  return hits[0];
}

// The printed stdout of a command, with nothing asserted about its exit code. Some commands
// legitimately report "not completed" (a free-form request with no backend, a health check that
// has something to show), so their output is read this way.
function out(label) {
  const res = resultOf(label);
  assert.equal(res.stderr, '', `'${label}' wrote to stderr:\n${res.stderr}`);
  return res.stdout;
}

// The printed stdout of a command that was expected to succeed. A non-zero exit fails here, so a
// step that fell over is reported as the step, not as a later wording mismatch.
function show(label) {
  const res = resultOf(label);
  assert.equal(res.code, 0, `'${label}' exited ${res.code}:\n${res.stdout}${res.stderr}`);
  return out(label);
}

async function step(label, args, { expectExit = 0 } = {}) {
  const res = await runCli(args, env);
  remember(label, res);
  assert.equal(res.code, expectExit, `'${label}' exited ${res.code}, expected ${expectExit}:\n${res.stdout}${res.stderr}`);
  assert.equal(res.stderr, '', `'${label}' wrote to stderr:\n${res.stderr}`);
  return res.stdout;
}

describe('Batch Z §9: the experience-to-adaptation lifecycle through the real CLI', () => {
  before(async () => {
    const dir = makeTempDataDir();
    dirs.push(dir);
    env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    assert.equal(env.APEX_MODEL_URL, undefined, 'cleanEnv must leave the CLI with no configured backend');
    logPath = path.join(dir, 'experiences.jsonl');
    ops = new OperationLog(path.join(dir, 'operations.jsonl'));

    // 1. APEX does two real, separately audited things.
    const review = await step('do-review', ['ask', 'remember that the review is on Friday']);
    const standup = await step('do-standup', ['ask', 'remember that the standup is on Monday']);
    ids.op1 = AUDIT.exec(review)[1];
    ids.op2 = AUDIT.exec(standup)[1];

    // 2. The user records each one as an experience of that audited operation.
    const exp1 = await step('experience-review', ['experience', 'record', ids.op1, '--subject', 'stored the review date']);
    const exp2 = await step('experience-standup', ['experience', 'record', ids.op2, '--subject', 'stored the standup date']);
    ids.exp1 = EXPERIENCE_ID.exec(exp1)[1];
    ids.exp2 = EXPERIENCE_ID.exec(exp2)[1];

    // 3. The user assesses the first one, says what should change, and says why.
    const fb1 = await step('feedback-review-concise', [
      'feedback', 'record', ids.exp1, '--assessment', 'not_useful',
      '--guidance', 'answer in one line', '--reason', 'it took a whole paragraph',
    ]);
    ids.fb1 = FEEDBACK_ID.exec(fb1)[1];

    // 4. The same assessment on the second experience, and a second thing asked for on both:
    //    two independent observations per rule, which is the minimum one candidate needs.
    await step('feedback-standup-concise', [
      'feedback', 'record', ids.exp2, '--assessment', 'not_useful', '--guidance', 'answer in one line',
    ]);
    await step('feedback-review-nocode', [
      'feedback', 'record', ids.exp1, '--assessment', 'incorrect', '--guidance', 'never store a private code',
    ]);
    await step('feedback-standup-nocode', [
      'feedback', 'record', ids.exp2, '--assessment', 'incorrect', '--guidance', 'never store a private code',
    ]);
    await step('experience-show', ['experience', 'show', ids.exp1]);

    // 5. Derivation turns repeated guidance into candidates, and the candidates do nothing.
    await step('health-before-derive', ['experience', 'health']);
    const derived = await step('derive', ['adaptation', 'derive']);
    const candidates = [...derived.matchAll(DERIVED)].map((m) => ({ id: m[1], rule: m[2].trim() }));
    assert.equal(candidates.length, 2, `derive was expected to list two candidates:\n${derived}`);
    ids.adaptConcise = candidates.find((c) => c.rule === 'answer in one line')?.id;
    ids.adaptNocode = candidates.find((c) => c.rule === 'never store a private code')?.id;
    assert.ok(ids.adaptConcise && ids.adaptNocode, `both guidance groups must become one candidate each:\n${derived}`);
    await step('health-after-derive', ['experience', 'health']);
    await step('derive-again', ['adaptation', 'derive']);
    await step('list-candidates', ['adaptation', 'list']);
    await step('ask-candidates', ['ask', 'what did I ask you to hold about the review'], { expectExit: 0 });

    // 6. The user approves one rule, for a stated reason.
    const decision = await step('approve-concise', [
      'adaptation', 'approve', ids.adaptConcise, '--reason', 'this is what I want from now on',
    ]);
    ids.decision1 = DECISION_ID.exec(decision)[1];
    prefixAfterApproval = fs.readFileSync(logPath, 'utf8');

    // 7. The approved rule now reaches a later request.
    await step('ask-one-active', ['ask', 'what did I ask you to hold about the review'], { expectExit: 0 });

    // 8. A second, different rule in the same scope: both stay visible, neither is chosen.
    const decision2 = await step('approve-nocode', [
      'adaptation', 'approve', ids.adaptNocode, '--reason', 'and this one too',
    ]);
    ids.decision2 = DECISION_ID.exec(decision2)[1];
    await step('list-conflicting', ['adaptation', 'list']);
    await step('ask-conflicting', ['ask', 'what did I ask you to hold about the review'], { expectExit: 0 });
    await step('health-conflicting', ['experience', 'health'], { expectExit: 1 });

    // 9. The user corrects one of the experiences both rules were supported by.
    const corrected = await step('correct-experience', [
      'experience', 'record', ids.op1, '--subject', 'a better account of the review event',
      '--replaces', ids.exp1,
    ]);
    ids.exp3 = EXPERIENCE_ID.exec(corrected)[1];
    await step('list-stale', ['adaptation', 'list']);
    await step('ask-stale', ['ask', 'what did I ask you to hold about the review'], { expectExit: 0 });
    await step('health-stale', ['experience', 'health'], { expectExit: 1 });

    // 10. The user retires one rule. Everything recorded before it stays readable.
    await step('retire', ['adaptation', 'retire', ids.adaptNocode, '--reason', 'no longer wanted']);
    await step('list-retired', ['adaptation', 'list']);
    await step('health-final', ['experience', 'health'], { expectExit: 1 });
    await step('list-experiences', ['experience', 'list']);
  });

  after(() => {
    while (dirs.length > 0) cleanup(dirs.pop());
  });

  test('1. the cycle starts from two operations the audit log already records', () => {
    for (const label of ['do-review', 'do-standup']) {
      const text = show(label);
      assert.match(text, /Status:    success_verified/);
      // An experience is only ever a reference to an event that was really audited, so the
      // audited identity of each action has to be on the page the user is looking at.
      assert.match(text, /- memory\.add \[origin user\]: authorization allow \(PERMITTED\); execution ok; verification success_verified/);
      assert.match(text, AUDIT);
    }
    assert.notEqual(ids.op1, ids.op2, 'two separate actions must be two separate audited events');
  });

  test('2. each experience names its operation, its scope, its outcome and its evidence', () => {
    const first = show('experience-review');
    assert.match(first, new RegExp(`Recorded experience ${ids.exp1} as an account of operation ${ids.op1.slice(0, 8)}:`));
    assert.match(first, /  scope: memory\.add \| outcome: success_verified \| decision: answer/);
    assert.match(first, /  subject: stored the review date/);
    // Evidence is a digest the reader recomputes from the audit record, never a claim the
    // experience makes about itself.
    assert.match(first, /  evidence: [0-9a-f]{16} \(recomputed from the audit record on every read\)/);
    assert.match(first, /  the earlier records are unchanged/);
    assert.match(first, /This is evidence that the event happened, not a permanent fact about the user\./);
    assert.match(
      show('experience-standup'),
      new RegExp(`Recorded experience ${ids.exp2} as an account of operation ${ids.op2.slice(0, 8)}:`),
    );
  });

  test('3. feedback is the user’s own assessment, changes nothing by itself, and says why', () => {
    const text = show('feedback-review-concise');
    assert.match(text, new RegExp(`Recorded your feedback ${ids.fb1} on experience ${ids.exp1} \\(operation ${ids.op1.slice(0, 8)}\\):`));
    assert.match(text, /  assessment: not useful \(corrective: it can support a candidate adaptation\)/);
    assert.match(text, /  guidance: answer in one line/);
    assert.match(text, /  reason: it took a whole paragraph/);
    assert.match(text, /  earlier feedback on this experience is unchanged/);
    assert.match(
      text,
      /Recording feedback changes nothing about your future requests\. A behaviour change needs a candidate, and a candidate needs your explicit approval\./,
    );
  });

  test('4. the recorded trail shows both assessments against the experience they assess', () => {
    show('feedback-standup-concise');
    show('feedback-review-nocode');
    show('feedback-standup-nocode');
    const text = show('experience-show');
    assert.match(text, new RegExp(`\\[${ids.exp1}\\] memory\\.add \\| outcome success_verified`));
    assert.match(text, / {6}about: stored the review date/);
    assert.match(text, new RegExp(` {6}audit: ${ids.op1.slice(0, 8)} \\| requested: \\d{4}-`));
    assert.match(text, /  replaces: none \| replaced by: none/);
    assert.match(text, /  feedback \(\d+ current, \d+ corrected\):/);
    // Each assessment carries the origin it was required to carry: the user's own.
    assert.match(text, /  \[[0-9a-f]{8}\] not useful \(corrective\) \| user_feedback/);
    assert.match(text, /  \[[0-9a-f]{8}\] incorrect \(corrective\) \| user_feedback/);
    assert.match(text, / {6}guidance: answer in one line/);
    assert.match(text, / {6}guidance: never store a private code/);
    assert.match(text, / {6}why: it took a whole paragraph/);
  });

  test('5. derivation yields candidates that are inert until the user decides', () => {
    const beforeDerive = show('health-before-derive');
    assert.match(beforeDerive, /  Adaptations:    0 derived - candidate 0, approved 0, in effect 0, rejected 0, retired 0, ambiguous 0/);
    assert.match(beforeDerive, /  Next step:      2 candidate\(s\) could be derived from feedback already recorded/);

    const derived = show('derive');
    assert.match(derived, /Derived 2 candidate\(s\) from the recorded evidence:/);
    assert.match(derived, / {6}support: 2 experience\(s\) \| NOT APPROVED/);
    assert.match(
      derived,
      /A candidate is evidence that you asked for the same thing more than once\. Nothing takes effect until you approve it\./,
    );
    // Deterministic grouping: the rule asked for first in the log is listed first.
    assert.ok(derived.indexOf(ids.adaptConcise) < derived.indexOf(ids.adaptNocode), 'candidates must appear in evidence order');

    const afterDerive = show('health-after-derive');
    assert.match(afterDerive, /  Adaptations:    2 derived - candidate 2, approved 0, in effect 0, rejected 0, retired 0, ambiguous 0/);
    assert.match(afterDerive, /  Next step:      no feedback support that has not already been derived/);

    // Deriving twice from the same evidence reuses what is already recorded instead of
    // manufacturing a second rule for the same request.
    const again = show('derive-again');
    assert.match(again, /No new candidate adaptation\./);
    assert.match(again, /Skipped: memory\.add: an adaptation for this scope and rule is already recorded/);

    const list = show('list-candidates');
    assert.match(list, /2 adaptation record\(s\), newest first \(0 in effect\):/);
    assert.match(list, / {6}not approved: no user decision recorded/);
    assert.match(list, /Only an approved adaptation whose support still stands is retrieved into future context\./);

    // An undecided candidate is absent from the next request entirely.
    const asked = out('ask-candidates');
    assert.match(asked, /Status:    success_deterministic/);
    assert.match(asked, /Relevant memory found \(shown directly, not summarised by a model\):/);
    assert.doesNotMatch(asked, /Approved adaptations covering this request/);
  });

  test('6. approval is the user’s decision, and it is not permission', () => {
    const text = show('approve-concise');
    assert.match(text, new RegExp(`Recorded your decision ${ids.decision1} on adaptation ${ids.adaptConcise}: approved\\.`));
    assert.match(text, /  scope: memory\.add \| rule: answer in one line/);
    assert.match(text, /  support: 2 recorded experience\(s\)/);
    assert.match(text, /  this is the first decision on this candidate/);
    assert.match(
      text,
      /This now applies to future requests in this scope, within the bounded context\. It grants no permission: an approved rule never authorizes an action\./,
    );
  });

  test('7. the approved rule reaches a later request, labelled as a rule and not as a fact', () => {
    const text = out('ask-one-active');
    assert.match(text, /Status:    success_deterministic/);
    // No inference happened on the way to showing the rule: the answer is a deterministic reading.
    assert.match(text, /Deterministic answer from APEX's stored records\. No model was used/);
    assert.match(
      text,
      /Approved adaptations covering this request \(shown directly; without a model APEX did not apply them\):/,
    );
    assert.match(text, new RegExp(
      `\\[${ids.adaptConcise}\\] scope memory\\.add: "answer in one line" `
      + `\\[user-approved behaviour rule, supported by 2 recorded experience\\(s\\), not a fact and not authorization\\]`,
    ));
    // One rule in this scope, so there is nothing to conflict with yet.
    assert.doesNotMatch(text, /CONFLICTING/);
  });

  test('8. a second rule in the same scope makes the conflict visible instead of choosing', () => {
    show('approve-nocode');
    const list = show('list-conflicting');
    assert.match(list, /2 adaptation record\(s\), newest first \(2 in effect\):/);
    assert.match(list, new RegExp(`\\[${ids.adaptConcise}\\] scope memory\\.add \\| active`));
    assert.match(list, new RegExp(`conflicts with \\[${ids.adaptNocode}\\] in the same scope`));
    assert.match(list, new RegExp(`conflicts with \\[${ids.adaptConcise}\\] in the same scope`));

    const asked = out('ask-conflicting');
    const marked = asked.match(/CONFLICTING: [^\]]*\]/g) ?? [];
    assert.equal(marked.length, 2, 'both rules must be marked, not one chosen silently');
    for (const marker of marked) {
      assert.match(marker, /1 other approved rule\(s\) cover this scope and say something different/);
      assert.match(marker, /APEX has not resolved which the user would prefer/);
    }

    const health = out('health-conflicting');
    assert.match(health, /  Conflicts:      1 scope\(s\) with 2 active rule\(s\) that say different things/);
    assert.match(health, /- both are shown as conflicting; APEX does not choose/);
    const pair = CONFLICT_PAIR.exec(health);
    assert.ok(pair, `health must name the two conflicting rules:\n${health}`);
    assert.deepEqual([pair[1], pair[2]].sort(), [ids.adaptConcise, ids.adaptNocode].sort());
  });

  test('9. correcting a supporting experience withdraws its evidence without rewriting history', () => {
    const text = show('correct-experience');
    assert.match(text, new RegExp(`Recorded experience ${ids.exp3} as an account of operation ${ids.op1.slice(0, 8)}:`));
    assert.match(text, /  subject: a better account of the review event/);
    assert.match(text, new RegExp(`  corrects: ${ids.exp1} \\(the earlier record stays in the log\\)`));

    // Both approvals lose their support, because both were built on the corrected experience:
    // an approval is in effect only while the evidence the user pointed at still stands.
    const list = show('list-stale');
    assert.match(list, /2 adaptation record\(s\), newest first \(0 in effect\):/);
    for (const id of [ids.adaptConcise, ids.adaptNocode]) {
      assert.match(list, new RegExp(`\\[${id}\\] scope memory\\.add \\| approved`));
    }
    assert.match(list, / {6}a supporting experience no longer stands as recorded evidence/);

    const asked = out('ask-stale');
    assert.doesNotMatch(asked, /Approved adaptations covering this request/);
    // The memory the user stored is untouched by all of this.
    assert.match(asked, / {2}\[[0-9a-f]{8}\] user fact: the review is on Friday/);

    const health = out('health-stale');
    assert.match(health, /  Anomalies:      2/);
    assert.match(health, new RegExp(`- adaptation \\[${ids.adaptConcise}\\] supporting experience ${ids.exp1} was corrected by a later record`));
    assert.match(health, new RegExp(`- adaptation \\[${ids.adaptNocode}\\] supporting experience ${ids.exp1} was corrected by a later record`));
  });

  test('10. retiring excludes a rule and leaves the whole trail behind it', () => {
    const text = show('retire');
    assert.match(text, new RegExp(`Retired adaptation ${ids.adaptNocode}: memory\\.add \\| never store a private code`));
    assert.match(text, /  it was approved before this retirement; reason recorded/);
    assert.match(text, /  the candidate, your decision, and the supporting experiences remain in the log and are still readable/);
    assert.match(text, /It no longer contributes to future context\. Nothing else about your history changed\./);

    const list = show('list-retired');
    assert.match(list, new RegExp(`\\[${ids.adaptNocode}\\] scope memory\\.add \\| retired`));
    assert.match(list, / {6}retired; excluded from future context/);
    assert.match(list, /2 adaptation record\(s\), newest first \(0 in effect\):/);

    const health = out('health-final');
    assert.match(health, /  Experiences:    3 record\(s\) \(2 live, 1 corrected by a later record\)/);
    assert.match(health, /  Feedback:       4 record\(s\) \(4 current, 0 corrected\)/);
    assert.match(health, /  Adaptations:    2 derived - candidate 0, approved 1, in effect 0, rejected 0, retired 1, ambiguous 0/);
    assert.match(health, /  Decisions:      2 user decision\(s\), 1 retirement\(s\) recorded/);
    assert.match(health, /  Evidence:       3\/3 recent experience\(s\) re-verified against the audit log/);
    assert.match(health, /  Conflicts:      none among adaptations in effect/);
    assert.match(health, /  Corrupt lines:  0/);
    assert.match(health, /an experience is a reference to an audited event, not a fact about the user/);

    const experiences = show('list-experiences');
    assert.match(experiences, /3 recorded experience\(s\), newest first:/);
    assert.match(experiences, new RegExp(`\\[${ids.exp1}\\] memory\\.add \\| outcome success_verified \\[corrected by a later record\\]`));
    assert.match(experiences, new RegExp(`\\[${ids.exp3}\\] memory\\.add`));
  });

  test('the log is append-only and every step has its own audit record', async () => {
    const final = fs.readFileSync(logPath, 'utf8');
    assert.ok(
      final.startsWith(prefixAfterApproval),
      'the records written up to the first approval must be a byte-identical prefix of the final log',
    );

    const prefixRecords = prefixAfterApproval.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const allRecords = final.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(allRecords.length > prefixRecords.length, 'the later steps must have appended, not replaced');
    assert.deepEqual(allRecords.slice(0, prefixRecords.length), prefixRecords);
    assert.deepEqual(
      [...new Set(allRecords.map((r) => r.kind))].sort(),
      ['adaptation', 'adaptation_decision', 'adaptation_retirement', 'experience', 'feedback'],
      'one log carries every kind the cycle records',
    );
    for (const id of [ids.exp1, ids.exp2, ids.exp3, ids.fb1, ids.adaptConcise, ids.adaptNocode, ids.decision1, ids.decision2]) {
      assert.ok(allRecords.some((r) => r.id.startsWith(id)), `record ${id} must still be readable in the log`);
    }
    // The corrected experience is still the record it was; the correction is a later append.
    const original = allRecords.find((r) => r.id.startsWith(ids.exp1));
    assert.equal(original.subject, 'stored the review date');
    const replacement = allRecords.find((r) => r.id.startsWith(ids.exp3));
    assert.deepEqual(replacement.replaces, [original.id]);

    // Every step that showed or changed state audited itself exactly once, and the read-only
    // health checks audited nothing, so the audit log is precisely the set of ids the CLI printed.
    const { records, corrupt } = await ops.inspect();
    assert.deepEqual(corrupt, [], 'the audit log must parse completely');
    assert.equal(records.length, auditIds.size, 'each printed audit id is one operation, and no operation goes unprinted');
    assert.equal(records.filter((r) => auditIds.has(r.id)).length, auditIds.size, 'no audit id may be recorded twice');
    // The two operations the first experiences point at are still in the audit log, so the
    // evidence each experience claims is verifiable rather than merely stated.
    for (const operationId of [ids.op1, ids.op2]) {
      const found = await ops.findById(operationId);
      assert.equal(found.found, true);
      assert.equal(found.record.status, 'success_verified');
    }
  });
});
