// Implementation 103: the deterministic workflows must be executable from the CLI
// using only what the built-in help documents, and a user must be able to tell a
// usage error, a denied action, and an unusable data directory apart. These tests
// drive the real entry point in child processes with no model configured.
//
// Coverage of a deterministic workflow is not evidence of general autonomy: every
// example below is a fixed command with a checked, deterministic outcome.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, runCli, cleanEnv, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function envFor(dir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, ...extra });
}

describe('103: deterministic CLI workflow is discoverable and truthful', () => {
  test('help maps every supported command, exit code, and example without claiming autonomy', async () => {
    const dir = tempDir();
    const env = envFor(dir);
    for (const argv of [['help'], []]) {
      const help = await runCli(argv, env);
      assert.equal(help.code, 0, help.stderr);
      const text = help.stdout;
      for (const usage of [
        'chat', 'ask', 'new', 'status', 'diagnose', 'memory correct', 'history',
        'knowledge add', 'knowledge list', 'knowledge search', 'knowledge show',
        'task plan', 'task list', 'task show', 'task explain', 'task approve',
        'task run', 'task resume', 'task retry', 'task cancel', 'queue', 'repair locks', 'help',
      ]) {
        assert.match(text, new RegExp(`node bin/apex\\.js ${usage}`), `help must document: ${usage}`);
      }
      assert.match(text, /Exit codes:\s*\n\s*0\s+completed[\s\S]*?\n\s*1\s+not completed[\s\S]*?\n\s*2\s+usage or configuration error; nothing was run[\s\S]*?\n\s*3\s+the outcome could not be written to the audit log/);
      assert.match(text, /Request examples \(no model needed/);
      assert.match(text, /task plan "calc 1\+1; calc 2\+2"/);
      assert.match(text, /read-only preflight, including recovery guidance/);
      assert.match(text, /Model output is never authorization\./);
      assert.doesNotMatch(text, /\bautonom|general intelligence|\bAGI\b|thinks for itself/i, 'deterministic commands must not be described as general autonomy');
    }
    assert.deepEqual(fs.readdirSync(dir), [], 'help reads nothing and creates no store');
  });

  test('the documented walkthrough runs end to end with no model configured', async () => {
    const dir = tempDir();
    const env = envFor(dir);

    const remembered = await runCli(['ask', 'remember', 'that', 'the', 'project', 'codename', 'is', 'Lighthouse'], env);
    assert.equal(remembered.code, 0, remembered.stdout + remembered.stderr);
    assert.match(remembered.stdout, /Status:\s+success_verified/);

    const recall = await runCli(['ask', 'recall', 'codename'], env);
    assert.equal(recall.code, 0, recall.stdout + recall.stderr);
    assert.match(recall.stdout, /the project codename is Lighthouse/);

    // The quoted example from help: plan, run, show, explain.
    const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /The plan was checked\. Nothing has run yet\./);
    const taskId = planned.stdout.match(/Task ([0-9a-f]{8})/)?.[1];
    assert.ok(taskId, `plan output must carry a task id: ${planned.stdout}`);

    const ran = await runCli(['task', 'run', taskId], env);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /status: completed/);
    assert.match(ran.stdout, /1\+1 = 2 \(verified\)/);
    assert.match(ran.stdout, /2\+2 = 4 \(verified\)/);

    const shown = await runCli(['task', 'show', taskId], env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /status: completed/);
    assert.match(shown.stdout, /2 of 2 step\(s\) completed/);

    const explained = await runCli(['task', 'explain', taskId, 'steps'], env);
    assert.equal(explained.code, 0, explained.stdout + explained.stderr);
    assert.match(explained.stdout, /Verified complete: s1 .*s2/);
    assert.match(explained.stdout, /have an operation record of their own/);

    // Knowledge examples from help.
    const added = await runCli(['knowledge', 'add', '--subject', 'APEX', '--relationship', 'has_subsystem', '--object', 'Diagnostics'], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    const knowledgeId = added.stdout.match(/Stored knowledge record ([0-9a-f]{8})/)?.[1];
    assert.ok(knowledgeId, `knowledge add output must carry the record id: ${added.stdout}`);

    const listed = await runCli(['knowledge', 'list'], env);
    assert.equal(listed.code, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /APEX --\[has_subsystem\]--> Diagnostics/);

    const searched = await runCli(['knowledge', 'search', 'subsystem'], env);
    assert.equal(searched.code, 0, searched.stdout + searched.stderr);
    assert.match(searched.stdout, new RegExp(`\\[${knowledgeId}\\] .*Diagnostics`));

    const knowledge = await runCli(['knowledge', 'show', knowledgeId], env);
    assert.equal(knowledge.code, 0, knowledge.stdout + knowledge.stderr);
    assert.match(knowledge.stdout, /Subject:\s+APEX/);
    assert.match(knowledge.stdout, /Provenance:\s+user_supplied \(user_confirmed\)/);

    const history = await runCli(['history'], env);
    assert.equal(history.code, 0, history.stdout + history.stderr);
    assert.match(history.stdout, /task\.plan/);
    assert.match(history.stdout, /task\.run/);
    assert.match(history.stdout, /knowledge\.add/);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Memory records: 1/);
    assert.match(status.stdout, /Model backend: none configured/);

    const diagnosed = await runCli(['diagnose'], env);
    assert.equal(diagnosed.code, 0, diagnosed.stdout + diagnosed.stderr);
    assert.match(diagnosed.stdout, /Overall: local subsystems healthy; no model configured/);

    const queue = await runCli(['queue'], env);
    assert.equal(queue.code, 0, queue.stdout + queue.stderr);
    assert.match(queue.stdout, /Queue: empty/);
    assert.match(queue.stdout, /Queue lock: no lock file/);
  });

  test('missing and invalid arguments are usage errors that create no state', async () => {
    const dir = tempDir();
    const env = envFor(dir);
    const cases = [
      [['ask'], /usage: ask/],
      [['task', 'plan'], /usage: task plan/],
      [['task', 'show'], /usage: task show/],
      [['task', 'explain'], /usage: task explain/],
      [['task', 'run'], /usage: task run/],
      [['task', 'retry', 'only-an-id'], /usage: task retry/],
      [['knowledge', 'add', '--subject', 'APEX', '--relationship', 'has_subsystem'], /usage: knowledge add/],
      [['knowledge', 'search'], /usage: knowledge search/],
      [['knowledge', 'show'], /usage: knowledge show/],
      [['memory', 'correct'], /usage: memory correct/],
      [['queue', '--limit', 'x'], /--limit needs a whole number/],
      [['history', '--limit'], /--limit needs a whole number/],
      [['status', 'extra'], /usage: status/],
      [['repair'], /usage: repair locks/],
      [['nonsense'], /unknown command/],
    ];
    for (const [argv, pattern] of cases) {
      const r = await runCli(argv, env);
      assert.equal(r.code, 2, `${argv.join(' ')} must be a usage error: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, pattern, `${argv.join(' ')} must explain its usage`);
      assert.equal(r.stdout, '', `${argv.join(' ')} must not print a result`);
    }
    assert.deepEqual(fs.readdirSync(dir), [], 'a refused argument must not create a store');
  });

  test('a model-proposed write is denied and does not execute', async () => {
    const dir = tempDir();
    const s = await startStubModel();
    stubs.push(s);
    s.behavior.reply = 'I saved that for you.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"the launch code is Zephyr"}}';
    const env = envFor(dir, { APEX_MODEL_URL: s.url, APEX_MODEL_NAME: 'stub' });

    const denied = await runCli(['ask', 'what is the launch code?'], env);
    assert.equal(denied.code, 1, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /did not execute a proposed action: denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.equal(fs.existsSync(path.join(dir, 'memory.jsonl')), false, 'the denied write left no memory store');

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Memory records: 0/);
  });

  test('an unusable data directory is reported with guidance, never as success', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'data-is-a-file');
    fs.writeFileSync(blocker, 'x');
    const env = envFor(blocker);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stderr, /data store unavailable/);
    assert.match(status.stderr, /APEX_DATA_DIR/);

    const planned = await runCli(['task', 'plan', 'calc 1+1'], env);
    assert.equal(planned.code, 3, 'the plan could not be stored or audited');
    assert.match(planned.stdout, /task store unavailable/);
    assert.match(planned.stdout, /Check APEX_DATA_DIR/);
    assert.doesNotMatch(planned.stdout, /Status:\s+plan_created|Task [0-9a-f]{8}/, 'a refused plan is not reported as stored');
    assert.match(planned.stderr, /NOT RECORDED/);

    const remembered = await runCli(['ask', 'remember that nothing can be stored'], env);
    assert.equal(remembered.code, 3, remembered.stdout + remembered.stderr);
    assert.match(remembered.stdout, /execution failed: cannot read memory\.jsonl/);
    assert.match(remembered.stdout, /Check APEX_DATA_DIR, its permissions, and free space/);
    assert.match(remembered.stdout, /Audit:\s+NOT RECORDED/);
    assert.doesNotMatch(remembered.stdout, /Status:\s+success_verified/);

    assert.equal(fs.readFileSync(blocker, 'utf8'), 'x', 'the blocking file was not replaced');
  });
});
