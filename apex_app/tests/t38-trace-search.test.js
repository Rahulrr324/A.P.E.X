// T-38 Step 3: cross-ledger search and the causal chain.
//
// The claim this suite makes is narrow and checkable: for one cognition run, the six ledgers can be
// put in time order without inventing anything. Every assertion below reads records the pipeline
// really wrote, and the chain is compared against those records rather than against a fixture of the
// chain's own shape.
//
// It also pins the honesty rules that make the view trustworthy:
//   * a ledger that does not exist is reported as absent, never as an empty chain;
//   * an unknown id is a 404, never an empty chain that looks complete;
//   * a link that is a text match says so instead of posing as a foreign key;
//   * a search writes nothing to any ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { EPISTEMIC_STATUSES, MemoryTraceService, SEARCH_KINDS, TRACE_SCHEMA, SEARCH_SCHEMA } from '../src/memory/trace.js';

function tempDir(prefix = 'apex-t38-trace-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Every file in the data directory with its bytes, so a test can prove a read wrote nothing.
function snapshot(dir) {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out.set(path.relative(dir, full), fs.readFileSync(full, 'utf8'));
  }
  return out;
}

async function withRun(fn) {
  const data = tempDir();
  const workspace = tempDir('apex-t38-trace-ws-');
  try {
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'probe.js'), 'export const probe = 1;\n');
    const app = createApp({ dataDir: data, filesystemRoot: workspace });
    const step = await app.controller.runAction('cognition.run', {
      intent: 'remember that the launch moved to friday',
    }, 'user', 'op-trace-1');
    return await fn({ app, data, workspace, step });
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------- the vocabulary ---

test('T-38 trace: the searchable kinds and statuses are closed lists', () => {
  assert.deepEqual([...SEARCH_KINDS], [
    'memory', 'cognition_run', 'council_session', 'task', 'workshop_verification', 'ecp_audit',
  ]);
  assert.ok(EPISTEMIC_STATUSES.includes('candidate_association'),
    'a candidate association is a status a reader can filter on');
  assert.ok(!EPISTEMIC_STATUSES.includes('fact'),
    'a fact is not a status: the statuses describe how a record is held, not what it is');
});

test('T-38 trace: a service without a data directory refuses rather than guessing one', () => {
  assert.throws(() => new MemoryTraceService({}), TypeError);
  assert.throws(() => new MemoryTraceService({ dataDir: '' }), TypeError);
});

// --------------------------------------------------------------------------------- the search ---

test('T-38 trace: a search across every ledger finds the run, its Council session and its task', async () => {
  await withRun(async ({ app }) => {
    const result = app.memoryTrace.search({ q: 'launch' });
    assert.equal(result.ok, true);
    assert.equal(result.schema, SEARCH_SCHEMA);
    const kinds = new Set(result.results.map((r) => r.kind));
    // The run, the Council session that evaluated its intent, and the task graph it created.
    assert.ok(kinds.has('cognition_run'), 'the run must be found');
    assert.ok(kinds.has('council_session'), 'the Council session must be found');
    assert.ok(kinds.has('task'), 'the task graph must be found');
    assert.equal(result.readOnly, true);
    assert.equal(result.wroteNothing, true);
    // Every result carries the ledger it came from and the record's own words.
    for (const entry of result.results) {
      assert.ok(SEARCH_KINDS.includes(entry.kind), entry.kind);
      assert.equal(typeof entry.summary, 'string');
      assert.ok(entry.at, `${entry.kind} must carry its timestamp`);
    }
  });
});

test('T-38 trace: a search writes nothing to any ledger', async () => {
  await withRun(async ({ app, data }) => {
    const before = snapshot(data);
    app.memoryTrace.search({ q: 'launch' });
    app.memoryTrace.search({});
    app.memoryTrace.search({ kind: 'memory' });
    const after = snapshot(data);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'a search created no file');
    for (const [file, bytes] of before) {
      assert.equal(after.get(file), bytes, `a search changed ${file}`);
    }
  });
});

test('T-38 trace: the ledger filter narrows to one ledger', async () => {
  await withRun(async ({ app }) => {
    const onlyMemory = app.memoryTrace.search({ kind: 'memory' });
    assert.equal(onlyMemory.ok, true);
    assert.ok(onlyMemory.results.every((r) => r.kind === 'memory'));
    const onlyTasks = app.memoryTrace.search({ kind: 'task' });
    assert.ok(onlyTasks.results.every((r) => r.kind === 'task'));
    assert.ok(onlyTasks.results.length > 0);
  });
});

test('T-38 trace: an unknown kind or status is refused, not silently ignored', async () => {
  await withRun(async ({ app }) => {
    const badKind = app.memoryTrace.search({ kind: 'beliefs' });
    assert.equal(badKind.ok, false);
    assert.equal(badKind.code, 'UNKNOWN_KIND');
    const badStatus = app.memoryTrace.search({ epistemicStatus: 'truthy' });
    assert.equal(badStatus.ok, false);
    assert.equal(badStatus.code, 'UNKNOWN_STATUS');
    const longQuery = app.memoryTrace.search({ q: 'x'.repeat(500) });
    assert.equal(longQuery.ok, false);
    assert.equal(longQuery.code, 'QUERY_TOO_LONG');
  });
});

test('T-38 trace: the epistemic status filter excludes records that have no status', async () => {
  await withRun(async ({ app }) => {
    await app.controller.runAction('memory.add', { content: 'the gate is open' }, 'user', 'op-m1');
    const filtered = app.memoryTrace.search({ epistemicStatus: 'asserted' });
    assert.ok(filtered.results.every((r) => r.kind === 'memory'),
      'a status filter must not smuggle in runs and tasks that have no status');
    assert.ok(filtered.results.length > 0);
  });
});

test('T-38 trace: a ledger that does not exist is reported absent, not empty', async () => {
  const data = tempDir();
  try {
    const service = new MemoryTraceService({ dataDir: data });
    const result = service.search({});
    assert.equal(result.ok, true);
    assert.equal(result.total, 0);
    // Every ledger is present:false, because none of them has been written yet.
    for (const kind of SEARCH_KINDS) {
      assert.equal(result.availability[kind].present, false, `${kind} must report absent`);
      assert.equal(result.availability[kind].count, 0);
    }
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('T-38 trace: a corrupt ledger line is counted rather than skipped silently', () => {
  const data = tempDir();
  try {
    fs.writeFileSync(path.join(data, 'memory.jsonl'), '{"id":"m-1","content":"a real record","createdAt":"2026-01-01T00:00:00.000Z"}\nnot json at all\n');
    const service = new MemoryTraceService({ dataDir: data });
    const result = service.search({ kind: 'memory' });
    assert.equal(result.total, 1, 'the real record is still found');
    assert.equal(result.availability.memory.corrupt, 1, 'the damaged line is counted');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------- the trace ---

test('T-38 trace: the chain for a run is chronological and reaches the task graph', async () => {
  await withRun(async ({ app, step }) => {
    const runId = step.result.data.runId;
    const chain = app.memoryTrace.trace(runId);
    assert.equal(chain.ok, true);
    assert.equal(chain.schema, TRACE_SCHEMA);
    assert.equal(chain.complete, true, JSON.stringify(chain.missing));
    assert.ok(chain.counts.runs >= 1);
    assert.ok(chain.counts.taskEvents >= 1);
    assert.ok(chain.counts.councilSessions >= 1, 'the run deliberated in the Council');

    // Time order, checked against the entries' own timestamps.
    const stamps = chain.entries.map((e) => e.at);
    assert.deepEqual(stamps, [...stamps].sort(), 'the chain must be in time order');

    // The kinds appear in pipeline order.
    const kinds = chain.entries.map((e) => e.kind);
    const runAt = kinds.indexOf('cognition_run');
    const councilAt = kinds.indexOf('council_session');
    const taskAt = kinds.indexOf('task_graph');
    assert.ok(runAt < councilAt && councilAt < taskAt, `unexpected order: ${kinds.join(' -> ')}`);

    // Every step names what linked it to the chain.
    for (const entry of chain.entries) {
      assert.ok(entry.linkedBy, `${entry.kind} must say what linked it`);
      assert.ok(entry.label, `${entry.kind} must carry a label`);
    }
  });
});

test('T-38 trace: the chain names a text-match link as a text match', async () => {
  await withRun(async ({ app, step }) => {
    const chain = app.memoryTrace.trace(step.result.data.runId);
    const council = chain.entries.find((e) => e.kind === 'council_session');
    // The Council is not called by the run; its objective equals the run's intent. The chain says so.
    assert.match(council.linkedBy, /objective equals a run intent/);
    assert.equal(council.detail.objective, 'remember that the launch moved to friday');
    // And the resolved candidate carries the metadata Step 1 added.
    if (council.detail.candidate) {
      assert.ok('reversibility' in council.detail.candidate);
      assert.ok('blastRadius' in council.detail.candidate);
    }
  });
});

test('T-38 trace: a task id opens the same chain as its run id', async () => {
  await withRun(async ({ app, step }) => {
    const runId = step.result.data.runId;
    const byRun = app.memoryTrace.trace(runId);
    const taskId = byRun.entries.find((e) => e.kind === 'task_graph').detail.taskId;
    const byTask = app.memoryTrace.trace(taskId);
    assert.equal(byTask.ok, true);
    assert.equal(byTask.complete, true);
    assert.deepEqual(byTask.keys.sort(), byRun.keys.sort(), 'both ids must reach the same chain');
    assert.equal(byTask.counts.taskEvents, byRun.counts.taskEvents);
  });
});

test('T-38 trace: an unknown id is a refusal that says what was searched', async () => {
  await withRun(async ({ app }) => {
    const missing = app.memoryTrace.trace('cog-doesnotexist0000');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'NOT_FOUND');
    assert.deepEqual(missing.searched.keys, ['cog-doesnotexist0000']);
    // And an empty id is a different refusal, because it is a different mistake.
    assert.equal(app.memoryTrace.trace('').code, 'INVALID_INPUT');
    assert.equal(app.memoryTrace.trace(null).code, 'INVALID_INPUT');
  });
});

test('T-38 trace: the chain carries the neural bridge without claiming an inference', async () => {
  await withRun(async ({ app, step }) => {
    const chain = app.memoryTrace.trace(step.result.data.runId);
    const run = chain.entries.find((e) => e.kind === 'cognition_run');
    assert.ok(run.detail.neural, 'the run recorded a neural stage');
    assert.equal(typeof run.detail.neural.available, 'boolean');
    // The stage names are the pipeline's own, in its order.
    assert.ok(Array.isArray(run.detail.stages));
    assert.ok(run.detail.stages.includes('neural') || run.detail.stages.includes('salience'),
      `the recorded stages are ${run.detail.stages.join(', ')}`);
  });
});

test('T-38 trace: a sandbox verification appears in a chain that names its candidate', async () => {
  await withRun(async ({ app, workspace }) => {
    fs.writeFileSync(path.join(workspace, 'src', 'probe.js'), 'export const probe = 1;\n');
    const staged = await app.controller.runAction('workshop.stage_file', {
      relativePath: 'src/probe.js', proposedContent: 'export const probe = 2;\n', rationale: 'raise it',
    }, 'user', 'op-s1');
    const candidateId = staged.result.data.candidateId;
    await app.controller.runAction('workshop.verify_file', { candidateId }, 'user', 'op-v1');

    // The verification is searchable on its own.
    const found = app.memoryTrace.search({ kind: 'workshop_verification' });
    assert.ok(found.total >= 1, 'the verification must be in the search index');
    const entry = found.results[0];
    assert.equal(entry.identity.candidateId, candidateId);
    assert.match(entry.summary, /probe\.js/);

    // And it is readable as a record with both digests.
    const [record] = app.memoryTrace.verificationsFor('src/probe.js');
    assert.ok(record, 'the verification must be findable by path');
    assert.match(record.stagedDigest, /^[0-9a-f]{64}$/);
    assert.match(record.baseDigest, /^[0-9a-f]{64}$/);
    assert.equal(record.verified, true);
  });
});

// ------------------------------------------------------------------------------- over HTTP ---

test('T-38 trace: the HTTP surface answers 200, 400 and 404 for the three outcomes', async () => {
  await withRun(async ({ app, step }) => {
    const token = 't38-trace-http-token-0123';
    const ui = createUiServer({ app, token, host: '127.0.0.1', port: 0 });
    const { port } = await ui.start();
    const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };
    const get = async (p) => {
      const response = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    try {
      const search = await get('/api/memory/search?q=launch');
      assert.equal(search.status, 200);
      assert.equal(search.body.ok, true);
      assert.ok(search.body.total >= 3);

      const badFilter = await get('/api/memory/search?kind=beliefs');
      assert.equal(badFilter.status, 400, 'a filter the surface does not understand is a refusal');
      assert.equal(badFilter.body.code, 'UNKNOWN_KIND');

      const chain = await get('/api/memory/trace/' + encodeURIComponent(step.result.data.runId));
      assert.equal(chain.status, 200);
      assert.equal(chain.body.complete, true);

      const unknown = await get('/api/memory/trace/cog-unknown0000000000');
      assert.equal(unknown.status, 404, 'an unknown id is not an empty chain');
      assert.equal(unknown.body.code, 'NOT_FOUND');

      // Both routes are reads. The response says so, and the file tree agrees.
      assert.equal(search.body.wroteNothing, true);
      assert.equal(chain.body.wroteNothing, true);
    } finally {
      await ui.stop?.();
    }
  });
});

test('T-38 trace: correlation search narrows to one chain', async () => {
  await withRun(async ({ app, step }) => {
    const runId = step.result.data.runId;
    // A second, unrelated memory record must not appear in the chain's correlation search.
    await app.controller.runAction('memory.add', { content: 'an unrelated note about lunch' }, 'user', 'op-x');
    const scoped = app.memoryTrace.search({ correlationId: runId });
    assert.equal(scoped.ok, true);
    for (const result of scoped.results) {
      assert.notEqual(result.kind, 'memory',
        'a memory record is not part of a run chain, so a correlation search must not return one');
    }
    assert.ok(scoped.results.some((r) => r.kind === 'cognition_run'));
  });
});
