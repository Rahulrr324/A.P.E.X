// CLI conversation: `chat` reads messages from stdin in its own process, `new`
// starts a session, and `status` shows the session. Each run uses a fresh temp data
// directory; no real user data is touched.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT, startStubModel } from './helpers.js';

const dirs = [];
const stubs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(async () => { for (const s of stubs) await s.close(); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// Runs `apex.js chat` with the given lines on stdin, as a separate process.
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

const sessionOf = (text) => (text.match(/Session: (\S+)/) || [])[1];

describe('chat command', () => {
  test('a memory stored in one chat process is available in the next one', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir });
    const first = await runChat(env, ['remember that the meeting room is B-204', '/exit']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Stored \(user fact\)/);
    assert.match(first.stdout, /\[success_verified · [0-9a-f-]{8}\]/);

    const second = await runChat(env, ['what do you know about the meeting room?', '/exit']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /B-204/);
  });

  test('the session id is the same across chat processes until /new or the new command', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir });
    await runChat(env, ['calc 2+2', '/exit']);
    const s1 = sessionOf((await runCli(['status'], env)).stdout);
    await runChat(env, ['calc 3+3', '/exit']);
    const s2 = sessionOf((await runCli(['status'], env)).stdout);
    assert.ok(s1 && s1 === s2, `session should persist: ${s1} vs ${s2}`);

    const started = await runCli(['new'], env);
    assert.equal(started.code, 0, started.stderr);
    const s3 = sessionOf((await runCli(['status'], env)).stdout);
    assert.ok(s3 && s3 !== s1, 'new starts a different session');
  });

  test('a model reply is shown with its status and labelled as an unverified model answer', async () => {
    const stub = await startStubModel();
    stubs.push(stub);
    stub.behavior.reply = 'Hello from the stub.';
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir, APEX_MODEL_URL: stub.url, APEX_MODEL_TIMEOUT_MS: '5000' });
    const res = await runChat(env, ['say hello', '/exit']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /\[verification_unavailable · model answer, unverified \(openai-compatible\) · [0-9a-f-]{8}\]/);
    assert.match(res.stdout, /Hello from the stub\./);
    assert.equal(stub.requests.length, 1);
  });

  test('a chat message that cannot be answered says so and generates nothing', async () => {
    const dataDir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dataDir });
    const res = await runChat(env, ['what is the capital of France?', '/exit']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /\[model_unavailable · /);
    assert.match(res.stdout, /Nothing has been generated/);
  });
});
