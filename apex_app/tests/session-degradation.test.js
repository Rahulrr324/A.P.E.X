// Implementation 060: cross-component consistency.
//
// The inconsistency held here is between three components that each describe the same
// request honestly on their own: the session pointer (src/session.js), the controller
// (src/controller/controller.js, #resolveSession) and the CLI display (src/cli.js).
// When session.json cannot be read, the controller still runs the requested action and
// verifies it, records the loss in the audit record's errors, and writes no conversation
// turn. The CLI printed only "Status: success_verified" and exited 0, so the user saw an
// unqualified success while the authoritative record said the request had no conversation
// continuity. Every command line is real: bin/apex.js against a temporary data directory,
// with HOME/USERPROFILE redirected so a developer's own ~/.apex cannot be reached.
// No model is configured in these tests, so every action shown here is deterministic.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, runCli, cleanEnv, APP_ROOT } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

const NOTICE = 'Session: this request ran without conversation continuity';

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function lastOperation(dataDir) {
  const records = readJsonl(path.join(dataDir, 'operations.jsonl'));
  return records[records.length - 1] ?? null;
}

// `chat` reads its messages from stdin, so it runs as its own process.
function runChat(env, lines) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'apex.js'), 'chat'], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(lines.join('\n') + '\n');
  });
}

describe('060: a request that lost its session is not displayed as an unqualified success', () => {
  test('a healthy run records turns and prints no session notice', async () => {
    const dataDir = tempDir();
    const res = await runCli(['ask', 'calc', '2+2'], envFor(dataDir));
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/);
    assert.doesNotMatch(res.stderr, /Session:/, `no notice when nothing was lost: ${res.stderr}`);

    const op = lastOperation(dataDir);
    assert.equal(op.status, 'success_verified');
    assert.deepEqual(op.errors, [], 'a healthy run carries no failure');
    const turns = readJsonl(path.join(dataDir, 'conversation.jsonl'));
    assert.equal(turns.length, 2, 'the user request and the verified reply are both stored');
    assert.deepEqual([...new Set(turns.map((t) => t.sessionId))].length, 1, 'both turns belong to one session');
    // The turns and the live session pointer agree, which is what the degraded case breaks.
    const current = JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
    assert.equal(turns[0].sessionId, current.sessionId);
    assert.deepEqual([...new Set(turns.map((t) => t.operationId))], [op.id], 'both turns name this operation');
  });

  test('a corrupt session pointer still runs the action, and the loss is disclosed', async () => {
    const dataDir = tempDir();
    const damaged = '{ "sessionId": ';
    fs.writeFileSync(path.join(dataDir, 'session.json'), damaged, 'utf8');

    const res = await runCli(['ask', 'calc', '2+2'], envFor(dataDir));
    // The requested calculation ran and was verified, so this is not a failed request:
    // the exit code and the outcome must stay as they are.
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/);
    assert.match(res.stdout, /4/, 'the answer itself is still shown');

    // The defect: the CLI used to print only the outcome, so the degraded state was
    // invisible outside the audit file.
    assert.match(res.stderr, new RegExp(NOTICE), `the session loss is disclosed: ${res.stderr}`);
    assert.match(res.stderr, /corrupt/, 'the disclosure names the cause');

    const op = lastOperation(dataDir);
    assert.equal(op.status, 'success_verified', 'the notice does not change the recorded outcome');
    const sessionError = op.errors.find((e) => e.stage === 'session');
    assert.ok(sessionError, `the audit record names the failed stage: ${JSON.stringify(op.errors)}`);
    assert.equal(sessionError.code, 'STORE_UNAVAILABLE');

    // The notice describes a real consequence, not a cosmetic one: nothing was stored,
    // and the damaged pointer was not silently replaced on the way past.
    assert.deepEqual(readJsonl(path.join(dataDir, 'conversation.jsonl')), [], 'no turn was written without a session');
    assert.equal(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'), damaged, 'the corrupt pointer is left for the user to see');
  });

  test('the chat loop discloses the same loss on stderr', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    fs.writeFileSync(path.join(dataDir, 'session.json'), 'not json at all', 'utf8');

    const res = await runChat(env, ['calc 2+2', '/exit']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /\[success_verified · [0-9a-f-]{8}\]/, 'the reply keeps its verified tag');
    assert.match(res.stderr, new RegExp(NOTICE), `the loop discloses the loss too: ${res.stderr}`);
    assert.deepEqual(readJsonl(path.join(dataDir, 'conversation.jsonl')), []);
  });

  test('a finished task whose summary could not reach the conversation says so', async () => {
    const dataDir = tempDir();
    const env = envFor(dataDir);
    const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], env);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const created = readJsonl(path.join(dataDir, 'tasks.jsonl')).find((e) => e.type === 'task_created');
    assert.ok(created, 'the plan was stored');

    fs.writeFileSync(path.join(dataDir, 'session.json'), '{ "sessionId": ', 'utf8');
    const ran = await runCli(['task', 'run', created.taskId], env);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /success_verified|completed/, 'the steps really ran');
    assert.match(ran.stderr, new RegExp(NOTICE), `the missing summary turn is disclosed: ${ran.stderr}`);

    const shown = await runCli(['task', 'show', created.taskId], env);
    assert.match(shown.stdout, /completed/, 'the task finished');
    assert.deepEqual(readJsonl(path.join(dataDir, 'conversation.jsonl')), [], 'no summary turn exists to replay');
  });

  test('the notice is only about the session', async () => {
    // A different store failing must not be described as a session problem: the
    // disclosure has to stay specific to the stage that actually failed.
    const dataDir = tempDir();
    const env = envFor(dataDir);
    fs.mkdirSync(path.join(dataDir, 'conversation.jsonl'));

    const res = await runCli(['ask', 'calc', '2+2'], env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:\s+success_verified/);
    assert.doesNotMatch(res.stderr, /Session:/, `a conversation failure is not a session failure: ${res.stderr}`);

    const op = lastOperation(dataDir);
    assert.equal(op.errors.find((e) => e.stage === 'session'), undefined, 'the session was readable');
    assert.ok(op.errors.some((e) => e.stage === 'conversation'), `the real stage is recorded: ${JSON.stringify(op.errors)}`);
    // The session pointer is valid, so a later healthy run stores turns again.
    assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8')).sessionId);
  });
});
