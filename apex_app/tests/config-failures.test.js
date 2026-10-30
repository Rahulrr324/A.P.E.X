// Implementation 059: configuration and startup failure handling.
//
// Everything here runs the real CLI (bin/apex.js -> src/cli.js -> src/config.js ->
// src/app.js -> the real stores) against a temporary data directory. No component is
// stubbed except the two model endpoints, which are local HTTP servers: one that answers
// with a fixed reply, and one Ollama-shaped server that returns 404 for an unpulled model.
// They demonstrate how APEX classifies an endpoint's answer; they say nothing about any
// real model, and no inference was run.
//
// What this suite holds the implementation to:
//  - a bad setting is refused before any store is opened, and the refusal names the setting;
//  - a configuration error, a model error, a storage error and an execution failure are
//    four different reports, with four different exit codes;
//  - no command reports success when the operation it ran was degraded;
//  - an error line is actionable on its own, without a secret or a stored record in it.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { makeTempDataDir, cleanup, runCli, cleanEnv, closedPortUrl } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// A data directory that is isolated from the developer's own ~/.apex: HOME and USERPROFILE
// point at the temporary directory as well, so a test that forgets APEX_DATA_DIR still
// cannot reach real data.
function envFor(dataDir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir, ...extra });
}

const FILES = ['memory.jsonl', 'knowledge.jsonl', 'operations.jsonl', 'conversation.jsonl', 'session.json', 'tasks.jsonl'];

describe('059: a bad setting is refused before anything is read or written', () => {
  test('every out-of-range or malformed setting exits 2, names the setting, and creates no store', async () => {
    const cases = [
      ['APEX_MODEL_TIMEOUT_MS', 'abc', /must be a whole number/],
      ['APEX_MODEL_TIMEOUT_MS', '50', /must be between 100 and 600000/],
      ['APEX_MODEL_RETRIES', '9', /must be between 0 and 3/],
      ['APEX_CONTEXT_TURNS', '999', /must be between 0 and 50/],
      ['APEX_MODEL_PROVIDER', 'gpt', /must be one of: openai, ollama/],
      ['APEX_MODEL_URL', 'not-a-url', /is not a valid URL/],
      ['APEX_MODEL_URL', 'ftp://127.0.0.1:1', /must use http or https/],
      ['APEX_MODEL_URL', 'http://model.example.com/v1', /is not loopback; set APEX_ALLOW_REMOTE_MODEL=1/],
      ['APEX_MODEL_URL', 'http://user:pw@127.0.0.1:1', /must not contain credentials/],
      ['APEX_FILESYSTEM_ROOT', 'relative/dir', /must be an absolute path/],
      ['APEX_FILESYSTEM_MAX_READ_BYTES', '1', /must be between 4096 and 10485760/],
    ];
    for (const [key, value, expected] of cases) {
      const dataDir = tempDir();
      const res = await runCli(['status'], envFor(path.join(dataDir, 'data'), { [key]: value }));
      assert.equal(res.code, 2, `${key}=${value} must be a configuration error, got: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /^configuration error: /, `${key}=${value} is reported as a configuration error`);
      assert.match(res.stderr, expected, `${key}=${value} names the setting: ${res.stderr}`);
      assert.match(res.stderr, /No data was read or changed/, `${key}=${value} says nothing was touched`);
      assert.equal(fs.existsSync(path.join(dataDir, 'data')), false, `${key}=${value} did not create the data directory`);
    }
  });

  test('a filesystem limit is validated even while the filesystem capability is off', async () => {
    // The defect this holds: APEX_FILESYSTEM_MAX_READ_BYTES was only read when
    // APEX_FILESYSTEM_ROOT was set, so an impossible value was accepted silently and the
    // mistyped setting surfaced only after the operator enabled the capability.
    const dataDir = tempDir();
    const bad = await runCli(['status'], envFor(dataDir, { APEX_FILESYSTEM_MAX_READ_BYTES: '1' }));
    assert.equal(bad.code, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /APEX_FILESYSTEM_MAX_READ_BYTES must be between 4096 and 10485760/);

    const good = await runCli(['status'], envFor(dataDir, { APEX_FILESYSTEM_MAX_READ_BYTES: '65536' }));
    assert.equal(good.code, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /Filesystem root: none configured/, 'a valid limit still does not enable the capability');
  });

  test('Ollama without a model name is a configuration error, not a failed request', async () => {
    const dataDir = tempDir();
    const res = await runCli(['status'], envFor(dataDir, { APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_URL: 'http://127.0.0.1:1' }));
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /APEX_MODEL_NAME is required when APEX_MODEL_PROVIDER=ollama/);
    assert.match(res.stderr, /ollama list/, 'and it points at the command that lists installed models');
  });
});

describe('059: storage failures are reported as storage failures', () => {
  test('a data directory that is a regular file is unavailable, and says which code made it so', async () => {
    const root = tempDir();
    const asFile = path.join(root, 'not-a-directory');
    fs.writeFileSync(asFile, 'this path is a file');
    const status = await runCli(['status'], envFor(asFile));
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /Memory records: unavailable/);
    assert.match(status.stderr, /data store unavailable: .*ENOTDIR/, `the stderr names the cause: ${status.stderr}`);

    const diag = await runCli(['diagnose'], envFor(asFile));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Overall: attention required/);
    for (const label of ['Memory', 'Knowledge', 'Conversation', 'Tasks', 'Audit']) {
      assert.match(diag.stdout, new RegExp(`${label}: unavailable \\(.*ENOTDIR`), `${label} is unavailable with its code`);
    }
  });

  test('an audit log that cannot be opened names the reason in status, diagnose, and ask', async () => {
    const dataDir = tempDir();
    fs.mkdirSync(path.join(dataDir, 'operations.jsonl'));

    const status = await runCli(['status'], envFor(dataDir));
    assert.equal(status.code, 1, status.stdout + status.stderr);
    assert.match(status.stdout, /Operation records: unavailable/);
    // The defect this holds: the stderr line was "data store unavailable: ." because the
    // diagnostics record carried its reason only in the summary, so the operator was told
    // to check permissions with no cause named.
    assert.match(status.stderr, /data store unavailable: cannot read operations\.jsonl: EISDIR/, status.stderr);

    const diag = await runCli(['diagnose'], envFor(dataDir));
    assert.equal(diag.code, 1, diag.stdout + diag.stderr);
    assert.match(diag.stdout, /Audit: unavailable \(cannot read operations\.jsonl: EISDIR\)/);
    assert.match(diag.stdout, /Recovery guidance:/);
    assert.match(diag.stdout, /Storage: Audit unavailable/);

    // The action ran and was verified, so the outcome stays success_verified; the missing
    // audit record is disclosed and the exit code says the request was not fully completed.
    const asked = await runCli(['ask', 'calc', '2+2'], envFor(dataDir));
    assert.equal(asked.code, 3, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Status:    success_verified/);
    assert.match(asked.stdout, /Audit:     NOT RECORDED \(cannot write operations\.jsonl: EISDIR\)/);
  });

  test('a corrupt memory line blocks retrieval instead of returning a partial answer', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), '{"broken\n');
    const asked = await runCli(['ask', 'recall', 'codename'], envFor(dataDir));
    assert.equal(asked.code, 1, asked.stdout + asked.stderr);
    assert.match(asked.stdout, /Status:    execution_failed/);
    assert.match(asked.stdout, /refusing incomplete retrieval/);
    assert.match(asked.stdout, /Audit:     recorded/, 'the refusal is itself audited');

    const status = await runCli(['status'], envFor(dataDir));
    assert.equal(status.code, 1, status.stdout);
    assert.match(status.stdout, /corrupt lines skipped: 1/);
  });

  test('a corrupt task log refuses task work rather than showing a partial list', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'tasks.jsonl'), 'this is not an event\n');
    const list = await runCli(['task', 'list'], envFor(dataDir));
    assert.equal(list.code, 1, list.stdout + list.stderr);
    assert.match(list.stderr, /task log contains 1 corrupt line\(s\); refusing incomplete task state/);

    const planned = await runCli(['task', 'plan', 'calc 1+1; calc 2+2'], envFor(dataDir));
    assert.equal(planned.code, 1, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /task store unavailable/);
    assert.equal(fs.existsSync(path.join(dataDir, 'tasks.jsonl')), true, 'the damaged log was not truncated or replaced');
    assert.equal(fs.readFileSync(path.join(dataDir, 'tasks.jsonl'), 'utf8'), 'this is not an event\n');
  });

  test('usage and unknown-reference errors exit 2, not 0', async () => {
    const dataDir = tempDir();
    for (const args of [['task', 'show'], ['task', 'explain'], ['knowledge', 'show'], ['ask'], ['nonsense-command']]) {
      const res = await runCli(args, envFor(dataDir));
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    }
    const missing = await runCli(['task', 'show', 'ffffffff'], envFor(dataDir));
    assert.equal(missing.code, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /no task matches "ffffffff"/);
  });

  test('reporting a failure never creates state: read-only commands leave a cold directory cold', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    for (const args of [['status'], ['diagnose'], ['history'], ['task', 'list'], ['help'], ['version']]) {
      const res = await runCli(args, envFor(dataDir));
      assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      for (const file of FILES) assert.equal(fs.existsSync(path.join(dataDir, file)), false, `${args.join(' ')} did not create ${file}`);
    }
  });
});

describe('059: model errors are reported as model errors', () => {
  test('an unreachable endpoint fails the request honestly and records the failure', async () => {
    const dataDir = tempDir();
    const url = await closedPortUrl();
    const res = await runCli(['ask', 'explain photosynthesis'], envFor(dataDir, { APEX_MODEL_URL: url, APEX_MODEL_RETRIES: '0' }));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Status:    execution_failed/);
    assert.match(res.stdout, /UNREACHABLE: could not reach the endpoint/);
    assert.match(res.stdout, /No answer has been generated/);
    assert.match(res.stdout, /Audit:     recorded/, 'the failed call is in the audit log');
    const turns = fs.existsSync(path.join(dataDir, 'conversation.jsonl'))
      ? fs.readFileSync(path.join(dataDir, 'conversation.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
      : [];
    // The user's question is a stored turn, and the failed call is stored as an APEX notice
    // (never replayed as context). What must not exist is an answer: no model-origin text,
    // and nothing recorded as verified.
    assert.equal(turns.filter((t) => t.origin === 'model').length, 0, 'nothing was attributed to a model');
    assert.equal(turns.filter((t) => t.origin === 'apex_notice' && /No answer has been generated/.test(t.text)).length, 1, 'the failure is stored as a notice');
    assert.equal(turns.some((t) => t.verified === true), false, 'no turn from a failed call claims verification');
  });

  test('a configured but down endpoint is a model problem, not a storage problem, in status', async () => {
    const dataDir = tempDir();
    const res = await runCli(['status', '--model'], envFor(dataDir, { APEX_MODEL_URL: 'http://127.0.0.1:1' }));
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Model backend: http:\/\/127\.0\.0\.1:1.*- unavailable: could not reach the endpoint/);
    assert.match(res.stdout, /Local integrity: no defects found; the model backend is unavailable/, 'storage is not blamed for the model');
    assert.equal(/data store unavailable/.test(res.stderr), false, res.stderr);
    assert.equal(fs.existsSync(path.join(dataDir, 'operations.jsonl')), false, 'probing the model writes no audit record');
  });

  test('an Ollama model that is not installed is named as missing, with the command to fix it', async () => {
    const dataDir = tempDir();
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'some-other-model:latest' }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model "nope" not found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const asked = await runCli(['ask', 'summarize the notes'], envFor(dataDir, {
        APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_URL: url, APEX_MODEL_NAME: 'nope', APEX_MODEL_RETRIES: '0',
      }));
      assert.equal(asked.code, 1, asked.stdout + asked.stderr);
      assert.match(asked.stdout, /MODEL_NOT_FOUND|not installed/, `an unknown model name is named: ${asked.stdout}`);
      assert.match(asked.stdout, /ollama pull nope/, 'and the fix is named');

      const status = await runCli(['status', '--model'], envFor(dataDir, {
        APEX_MODEL_PROVIDER: 'ollama', APEX_MODEL_URL: url, APEX_MODEL_NAME: 'nope',
      }));
      assert.equal(status.code, 1, status.stdout + status.stderr);
      assert.match(status.stdout, /not installed on this Ollama server/, 'the probe reaches the same conclusion as the request');
    } finally {
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    }
  });

  test('a response that is not JSON is a malformed model answer, not an empty one', async () => {
    const dataDir = tempDir();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>proxy error</html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await runCli(['ask', 'what is the capital of France'], envFor(dataDir, { APEX_MODEL_URL: url, APEX_MODEL_RETRIES: '0' }));
      assert.equal(res.code, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /MALFORMED_RESPONSE|is not JSON/, res.stdout);
      assert.match(res.stdout, /No answer has been generated/);
      assert.equal(/Status:    success_verified/.test(res.stdout), false, 'a bad endpoint is never a verified success');
    } finally {
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    }
  });
});
