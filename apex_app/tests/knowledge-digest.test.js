import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';

function appOn(dir) {
  return createApp({ dataDir: dir });
}

function stepOutput(res) {
  return res.operation.steps[0];
}

async function closeAll(app) {
  // The stores keep only file handles per operation; nothing to close, but keep the
  // helper so a test that later gains a background queue has one place to drain it.
  void app;
}

test('knowledge.digest: overview reports both stores and keeps them separate', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'My favourite colour is blue' });
    await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'has_subsystem', object: 'Memory Store' });

    const res = await app.controller.knowledgeDigest();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = stepOutput(res).result.data;
    assert.equal(data.topic, null);
    assert.equal(data.knowledge.counts.claims, 1);
    assert.equal(data.knowledge.counts.active, 1);
    assert.equal(data.memory.counts.records, 1);
    assert.equal(data.knowledge.records.length, 1);
    assert.equal(data.memory.records.length, 1);
    // The two records are reported in their own sections, with no field linking them.
    assert.equal(data.knowledge.records[0].subject, 'APEX');
    // The audited step redacts memory `content`; the interactive display is where it is read.
    assert.match(res.display, /favourite colour/);
    assert.ok(data.notes.some((note) => /does not merge them or infer a relationship/.test(note)));
    assert.match(res.display, /Knowledge digest/);
    assert.match(res.display, /APEX --\[has_subsystem\]--> Memory Store/);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: a topic searches both stores and reports the profile', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'The meeting room is B-204' });
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'design review' });
    await app.controller.knowledgeAdd({ subject: 'laptop', relationship: 'vendor', object: 'Acme' });

    const res = await app.controller.knowledgeDigest({ query: 'meeting room' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = stepOutput(res).result.data;
    assert.equal(data.topic, 'meeting room');
    assert.equal(data.knowledge.search.results.length, 1);
    assert.equal(data.knowledge.search.results[0].subject, 'meeting room');
    assert.equal(data.memory.search.results.length, 1);
    assert.match(res.display, /B-204/);
    assert.equal(data.knowledge.search.returned, 1);
    assert.ok(data.knowledge.search.corpusSize >= 2);
    assert.ok(data.notes.some((note) => /Search matches are ranked/.test(note)));
    assert.match(res.display, /Knowledge matches: 1 returned of 1 matched/);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: a damaged store is reported as damaged, not empty', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.controller.knowledgeAdd({ subject: 'APEX', relationship: 'has_subsystem', object: 'Memory Store' });
    fs.appendFileSync(path.join(dir, 'knowledge.jsonl'), '{not json\n');

    const res = await app.controller.knowledgeDigest();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = stepOutput(res).result.data;
    assert.equal(data.knowledge.state, 'damaged');
    assert.equal(data.knowledge.counts.corruptLines, 1);
    assert.equal(data.knowledge.records, null);
    assert.equal(data.memory.state, 'ok');
    assert.ok(data.notes.some((note) => /damaged store is reported as such/.test(note)));
    assert.match(res.display, /knowledge: damaged/);

    const searched = await app.controller.knowledgeDigest({ query: 'APEX' });
    const searchedData = stepOutput(searched).result.data;
    assert.match(searchedData.knowledge.search.error, /corrupt line/);
    assert.deepEqual(searchedData.knowledge.search.results, []);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: a term no record holds is reported, not treated as a negative answer', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'The meeting room is B-204' });
    const res = await app.controller.knowledgeDigest({ query: 'launch window' });
    const data = stepOutput(res).result.data;
    assert.equal(data.knowledge.search.matched, 0);
    assert.deepEqual(data.knowledge.search.unmatched, ['launch', 'window']);
    assert.ok(data.notes.some((note) => /does not mean the claim is false/.test(note)));
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: private memory never reaches a model-origin caller', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'The safe combination is 12-34-56', sensitivity: 'private' });
    await app.memory.add({ content: 'The meeting room is B-204' });

    const step = await app.controller.runAction('knowledge.digest', {}, 'model', 'digest-model-op');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.includePrivate, false);
    assert.equal(step.result.data.memory.counts.privateRecords, 1);
    assert.ok(!JSON.stringify(step.display).includes('12-34-56'));
    assert.ok(step.display.includes('B-204'));

    const user = await app.controller.knowledgeDigest();
    assert.equal(stepOutput(user).result.data.includePrivate, true);
    assert.match(user.display, /12-34-56/);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: limit is bounded and the bound is reported', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    const tooLarge = await app.controller.knowledgeDigest({ limit: 11 });
    assert.equal(tooLarge.status, Outcome.INPUT_REJECTED);
    const zero = await app.controller.knowledgeDigest({ limit: 0 });
    assert.equal(zero.status, Outcome.INPUT_REJECTED);

    for (let i = 0; i < 4; i += 1) {
      await app.memory.add({ content: `Memory record number ${i}` });
    }
    const res = await app.controller.knowledgeDigest({ limit: 2 });
    const data = stepOutput(res).result.data;
    assert.equal(data.limit, 2);
    assert.equal(data.memory.records.length, 2);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: natural-language requests route to the digest without a model', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'The release note says the launch is Friday' });

    assert.equal(route('summarize what you know about the release note').action, 'knowledge.digest');
    assert.equal(route('knowledge digest').action, 'knowledge.digest');
    assert.equal(route('digest my knowledge for launch').input.query, 'launch');

    const res = await app.controller.handle('summarize what you know about the release note');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.operation.capability, 'knowledge.digest');
    assert.equal(res.operation.steps[0].action, 'knowledge.digest');
    assert.match(res.display, /Friday/);

    // The existing "what do you remember about" path is unchanged.
    assert.equal(route('what do you remember about the release note').action, 'memory.search');
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: conflicting claims are counted and marked, never silently resolved', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Electric' });
    await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Gasoline' });

    const res = await app.controller.knowledgeDigest();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = stepOutput(res).result.data;
    assert.equal(data.knowledge.counts.conflicts.groups, 1);
    assert.equal(data.knowledge.counts.conflicts.claims, 2);
    const statuses = data.knowledge.records.map((record) => record.status);
    assert.deepEqual(statuses.sort(), ['conflicting', 'conflicting']);
    assert.ok(data.notes.some((note) => /1 knowledge conflict group\(s\) are unresolved/.test(note)));
    assert.match(res.display, /1 unresolved conflict group\(s\)/);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: a superseded claim is history, not a current answer', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    const planned = await app.controller.knowledgeAdd({ subject: 'Launch', relationship: 'status', object: 'planned' });
    const plannedId = stepOutput(planned).result.data.id;
    await app.controller.knowledgeAdd({
      subject: 'Launch', relationship: 'status', object: 'shipped', supersedes: [plannedId],
    });

    const res = await app.controller.knowledgeDigest({ query: 'Launch' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const data = stepOutput(res).result.data;
    assert.equal(data.knowledge.counts.claims, 2);
    assert.equal(data.knowledge.counts.active, 1);
    assert.equal(data.knowledge.counts.superseded, 1);
    // Search reports only what still stands; the older claim is kept in history.
    assert.equal(data.knowledge.search.results.length, 1);
    assert.equal(data.knowledge.search.results[0].object, 'shipped');
    assert.ok(data.notes.some((note) => /1 superseded.*they are not current/.test(note)));
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: a corrected memory claim is shown as replaced, not current', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    const original = await app.memory.add({ content: 'My favourite colour is blue' });
    await app.memory.correct({
      targetId: original.id, content: 'My favourite colour is green', origin: 'user',
    });

    const res = await app.controller.knowledgeDigest({ query: 'favourite colour' });
    const data = stepOutput(res).result.data;
    assert.equal(data.memory.counts.corrections, 1);
    assert.equal(data.memory.counts.replacedClaims, 1);
    const current = data.memory.search.results.find((record) => record.status === 'active');
    assert.ok(current, 'the corrected claim is the current match');
    assert.ok(current.replaces.length === 1, 'the current record names the claim it replaced');
    assert.match(res.display, /green/);
    assert.match(res.display, /\[superseded\]/);
    assert.ok(data.notes.some((note) => /1 correction\(s\); a corrected record is shown as replaced/.test(note)));
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});

test('knowledge.digest: the CLI reads the same stores without a model', async () => {
  const dir = makeTempDataDir();
  try {
    const app = appOn(dir);
    await app.memory.add({ content: 'The meeting room is B-204' });
    await app.controller.knowledgeAdd({ subject: 'meeting room', relationship: 'booked_for', object: 'design review' });

    const env = cleanEnv({ APEX_DATA_DIR: dir });
    const summary = await runCli(['knowledge', 'digest'], env);
    assert.equal(summary.code, 0, summary.stderr);
    assert.match(summary.stdout, /Knowledge digest/);
    assert.match(summary.stdout, /1 claim\(s\)/);
    assert.match(summary.stdout, /B-204/);

    const searched = await runCli(['knowledge', 'digest', 'meeting', 'room'], env);
    assert.equal(searched.code, 0, searched.stderr);
    assert.match(searched.stdout, /Knowledge matches/);
    await closeAll(app);
  } finally {
    cleanup(dir);
  }
});