// Batch AP-14: cross-store belief tracing.
//
// These tests exercise the reverse citation lookup the World Model stores: which world statements
// were built from a given memory or knowledge record, and whether a cited record is still current
// in the store that owns it. The trace is read-only and never picks a side. Every fixture is
// synthetic and deterministic; no model is contacted.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { traceBelief } from '../src/world/belief-trace.js';
import { renderBeliefTrace } from '../src/world/format.js';
import { retrieveEvidence } from '../src/cognition/evidence.js';
import { understandRequest } from '../src/cognition/request.js';
import { extractClaims } from '../src/cognition/claims.js';
import { ClaimKind } from '../src/cognition/vocabulary.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');
const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
const DATA_FILES = ['memory.jsonl', 'knowledge.jsonl', 'world-model.jsonl', 'predictions.jsonl', 'experiences.jsonl'];

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
after(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function appOn(dir) {
  return createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    experienceCapture: CAPTURE_OFF,
    now: () => NOW,
  });
}

function dataOf(res) {
  return res.operation.steps[0].result.data;
}

function dataSizes(dir) {
  const sizes = {};
  for (const file of DATA_FILES) {
    try {
      sizes[file] = fs.statSync(path.join(dir, file)).size;
    } catch {
      sizes[file] = null;
    }
  }
  return sizes;
}

function scalar(value) {
  return { kind: 'scalar', valueType: 'string', value };
}

async function write(app, action, input) {
  const res = await app.controller.worldWrite(action, input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return res;
}

async function addEntity(app, id, name) {
  await write(app, 'world.entity.add', { id, category: 'project', name, evidence: UE });
}

async function addFact(app, id, subject, predicate, object, evidence) {
  await write(app, 'world.fact.add', {
    id, subject, predicate, object, validFrom: '2024-01-01', evidence,
  });
}

async function trace(app, targetType, target, extra = {}) {
  const res = await app.controller.worldRead('world.belief.trace', { targetType, target, ...extra });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display ?? res.output);
  return { res, data: dataOf(res) };
}

async function addMemory(app, content, extra = {}) {
  return app.memory.add({ content, kind: 'user_fact', source: 'user', ...extra });
}

describe('cross-store belief trace', () => {
  test('a world statement traces to the memory and knowledge records it was built from', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate opens at eight');
    const knowledge = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'open', origin: 'user',
    })).record;
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
      { relation: 'supports', sourceType: 'knowledge', sourceId: knowledge.id },
    ]);

    const { res, data } = await trace(app, 'fact', 'f-gate');
    assert.equal(data.target, 'fact:f-gate');
    assert.equal(data.disposition, 'supported');
    assert.deepEqual(data.evidence, [
      `supports:knowledge:${knowledge.id}:ok:true:true`,
      `supports:memory:${memory.id}:ok:true:true`,
    ]);
    assert.equal(data.authorizes, false);
    assert.equal(data.complete, true);
    assert.match(res.display, /Evidence references \(2\):/);
    assert.match(res.display, new RegExp(`memory:${memory.id}\\s+supports\\s+\\[current\\]`));
    assert.match(res.display, /A trace is descriptive: it keeps both sides, decides nothing, and authorizes no action\./);

    // The reverse direction names the same statement without repeating the lookup.
    const reverse = await trace(app, 'memory', memory.id);
    assert.equal(reverse.data.disposition, 'supported');
    assert.deepEqual(reverse.data.citations, [
      `fact:f-gate:supports:supported`,
    ]);
    assert.match(reverse.res.display, /World statements citing this record \(1\):/);
  });

  test('a live contradiction is surfaced for both sides and stays unresolved', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('closed'), [
      { relation: 'contradicts', sourceType: 'memory', sourceId: memory.id, note: 'store says open' },
    ]);

    const fact = await trace(app, 'fact', 'f-gate');
    assert.equal(fact.data.status, 'contested');
    assert.equal(fact.data.disposition, 'contradicted');

    const record = await trace(app, 'memory', memory.id);
    assert.equal(record.data.disposition, 'contradicted');
    assert.equal(record.data.citations.length, 1);
    assert.equal(record.res.display.includes('contradicts'), true);
    assert.match(record.res.display, /contradicts/);
    // The trace reports the disagreement; it never names a winner.
    assert.equal(/chose|winner|resolved/i.test(record.res.display), false);
    assert.equal(record.data.authorizes, false);
  });

  test('a same-store disagreement is listed with every member', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-open', 'e-gate', 'has_status', scalar('open'), UE);
    await addFact(app, 'f-closed', 'e-gate', 'has_status', scalar('closed'), UE);

    const { res, data } = await trace(app, 'fact', 'f-open');
    assert.equal(data.status, 'conflicting');
    assert.equal(data.disposition, 'contradicted');
    assert.equal(data.complete, true);
    assert.match(res.display, /Same-store disagreements \(1\):/);
    assert.match(res.display, /f-open|f-closed/);
    const first = res.display.slice(res.display.indexOf('Same-store disagreements'));
    assert.ok(first.includes('members'));
  });

  test('a missing record and an inconsistent citation are reported differently', async () => {
    const dir = tempDir();
    const app = appOn(dir);

    const absent = await trace(app, 'memory', 'm-never-stored');
    assert.equal(absent.data.found, false);
    assert.equal(absent.data.disposition, 'missing');
    assert.match(absent.res.display, /No world statement cites this record\./);

    // The world side names a memory id the memory store does not hold. Neither side is assumed
    // right: the trace reports that the citation and the absence disagree. This state cannot be
    // produced through the validated write path, so the pure trace is given the two readings the
    // action would have assembled.
    const state = { entities: new Map(), facts: new Map(), relationships: new Map(), events: new Map() };
    const inconsistent = traceBelief(state, {
      targetType: 'memory',
      targetId: 'm-absent',
      targetState: { found: false, complete: true },
      citations: {
        rows: [{
          targetType: 'fact', id: 'f-citing', label: 'North Gate has_status open', relations: ['supports'],
          live: true, validFrom: '2024-01-01', validUntil: null, occurredAt: null, evidence: [],
        }],
        total: 1,
        truncated: false,
      },
    });
    assert.equal(inconsistent.disposition.state, 'unknown');
    assert.match(inconsistent.disposition.reason, /does not hold that record/);
    assert.equal(inconsistent.target.found, false);
    assert.equal(inconsistent.authorizes, false);
  });

  test('a corrected memory record leaves the citation in place and marks it stale', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);
    const correction = await app.memory.correct({
      targetId: memory.id, content: 'the gate is closed', origin: 'user',
    });
    assert.ok(correction.id);

    const fact = await trace(app, 'fact', 'f-gate');
    assert.equal(fact.data.status, 'supported');
    assert.equal(fact.data.disposition, 'stale_evidence');
    assert.match(fact.res.display, /NOT CURRENT/);
    assert.match(fact.res.display, new RegExp(`superseded by ${correction.id.slice(0, 8)}`));

    const old = await trace(app, 'memory', memory.id);
    assert.equal(old.data.status, 'superseded');
    assert.equal(old.data.disposition, 'superseded');
    assert.match(old.res.display, /status superseded/);

    // The replacement is a new record; the old citation does not silently follow it.
    const replacement = await trace(app, 'memory', correction.id);
    assert.equal(replacement.data.disposition, 'uncited');
  });

  test('an unreadable memory store is reported as unavailable, not as an empty store', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);
    fs.appendFileSync(path.join(dir, 'memory.jsonl'), 'this line is not JSON\n');

    const record = await trace(app, 'memory', memory.id);
    assert.equal(record.data.disposition, 'unknown');
    assert.equal(record.data.complete, false);
    assert.match(record.res.display, /could not be read/);

    const fact = await trace(app, 'fact', 'f-gate');
    assert.equal(fact.data.disposition, 'unverified');
    assert.equal(fact.data.unavailable, 1);
    assert.match(fact.res.display, /\[UNREADABLE\]/);
  });

  test('a damaged world log refuses the trace rather than reporting an empty world', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    fs.appendFileSync(path.join(dir, 'world-model.jsonl'), 'this line is not JSON\n');

    const res = await app.controller.worldRead('world.belief.trace', { targetType: 'memory', target: memory.id });
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);
    assert.match(String(res.display ?? res.output), /corrupt|damaged|invalid|unreadable/i);
  });

  test('a second application instance sees citations written since the first read', async () => {
    const dir = tempDir();
    const first = appOn(dir);
    const memory = await addMemory(first, 'the gate is open');
    await addEntity(first, 'e-gate', 'North Gate');
    await addFact(first, 'f-one', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);

    const second = appOn(dir);
    assert.equal((await trace(second, 'memory', memory.id)).data.citations.length, 1);

    await addFact(second, 'f-two', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'qualifies', sourceType: 'memory', sourceId: memory.id },
    ]);
    const reread = await trace(second, 'memory', memory.id);
    assert.equal(reread.data.citations.length, 2);
    // Both statements still read the world as it is now; no cached earlier view is presented.
    assert.equal((await trace(first, 'memory', memory.id)).data.citations.length, 2);
  });

  test('repeating a trace is deterministic and writes no data store', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);

    const before = dataSizes(dir);
    const one = await trace(app, 'memory', memory.id);
    const two = await trace(app, 'memory', memory.id);
    const three = await trace(app, 'fact', 'f-gate');
    assert.deepEqual(one.data, two.data);
    assert.deepEqual(dataSizes(dir), before);
    assert.equal(three.data.authorizes, false);
  });

  test('citations are bounded and the omission is disclosed', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    for (const id of ['f-one', 'f-two', 'f-three']) {
      await addFact(app, id, 'e-gate', 'has_status', scalar('open'), [
        { relation: 'qualifies', sourceType: 'memory', sourceId: memory.id },
      ]);
    }

    const { res, data } = await trace(app, 'memory', memory.id, { limit: 2 });
    assert.equal(data.citations.length, 2);
    assert.equal(data.citationTotal, 3);
    assert.equal(data.citationTruncated, true);
    assert.match(res.display, /Showing 2 of 3\./);

    const invalid = await app.controller.worldRead('world.belief.trace', { targetType: 'memory', target: memory.id, limit: 0 });
    assert.notEqual(invalid.status, Outcome.SUCCESS_VERIFIED);
  });

  test('a model-proposed memory is not confirmed by a citation that agrees', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const conclusion = await app.memory.add({
      content: 'the gate is probably open', kind: 'model_conclusion', source: 'model',
    });
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: conclusion.id },
    ]);

    const { res, data } = await trace(app, 'memory', conclusion.id);
    assert.equal(data.disposition, 'proposed');
    assert.match(res.display, /model proposal/);
    assert.match(res.display, /not user-confirmed/);
    assert.equal(data.authorizes, false);
  });

  test('a retracted citation leaves history readable and withdraws the statement', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);
    await write(app, 'world.statement.retract', {
      targetType: 'fact',
      target: 'f-gate',
      reason: 'the gate reading was entered against the wrong gate',
      evidence: [{ relation: 'retracts', sourceType: 'user', sourceId: 'user' }],
    });

    const fact = await trace(app, 'fact', 'f-gate');
    assert.equal(fact.data.status, 'retracted');
    assert.equal(fact.data.disposition, 'withdrawn');
    assert.match(fact.res.display, /still readable in history/);

    const record = await trace(app, 'memory', memory.id);
    assert.equal(record.data.disposition, 'historical');
    assert.match(record.res.display, /\[\w+\]/);
  });

  test('a stored secret is not repeated in the trace display', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    // The memory store refuses secret-like content outright. The renderer is then checked against
    // a synthetic trace result whose label already holds a secret: it must not repeat what it was
    // handed, whatever path produced it.
    await assert.rejects(() => addMemory(app, 'the gate password is hunter2'), /password, key, or token/i);
    const state = { entities: new Map(), facts: new Map(), relationships: new Map(), events: new Map() };
    const result = traceBelief(state, {
      targetType: 'memory',
      targetId: 'm-secret',
      targetState: {
        found: true,
        label: 'the gate password is hunter2',
        state: 'stored',
        complete: true,
        sameStore: { status: 'stored', replacedBy: [], conflict: null },
      },
      citations: { rows: [], total: 0, truncated: false },
    });
    const rendered = renderBeliefTrace(result);
    assert.equal(rendered.includes('hunter2'), false);
    assert.match(rendered, /\[omitted/);
  });

  test('an unsupported target type is refused without reading anything', () => {
    const result = traceBelief(null, { targetType: 'plan', targetId: 'p-1' });
    assert.equal(result.disposition.state, 'unknown');
    assert.equal(result.target.status, 'unsupported');
    assert.equal(result.authorizes, false);
    assert.match(result.notes[0], /traceable record types/);
  });
});

describe('cross-store citations in cognition retrieval', () => {
  async function retrievalFor(app, memory, worldState, request = 'what do you know about the gate?') {
    const understanding = understandRequest({ request, now: NOW, worldState });
    const knowledgeRows = await app.knowledge.getMany([]);
    return retrieveEvidence({
      request,
      understanding,
      now: NOW,
      seeds: { memoryHits: [{ record: memory }], knowledge: [...knowledgeRows.values()], worldState },
    });
  }

  test('a world statement citing a memory record as contradiction is surfaced with both sides', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('closed'), [
      { relation: 'contradicts', sourceType: 'memory', sourceId: memory.id },
    ]);
    const state = await app.worldModel.state();

    const retrieval = await retrievalFor(app, memory, state);
    const memoryRow = retrieval.evidence.find((item) => item.evidenceId === `ev:memory:${memory.id}`);
    const worldRow = retrieval.evidence.find((item) => item.evidenceId === 'ev:world_fact:f-gate');
    assert.ok(memoryRow, 'the memory record is still evidence');
    assert.ok(worldRow, 'the citing world statement was added as evidence');
    assert.deepEqual(worldRow.relationships.contradicts, [`ev:memory:${memory.id}`]);
    assert.deepEqual(memoryRow.relationships.contradicts, ['ev:world_fact:f-gate']);
    assert.equal(worldRow.retrievalReason, 'cross-store-citation');
    assert.equal(worldRow.status, ClaimKind.CONTRADICTED);

    const understanding = understandRequest({ request: 'what do you know about the gate?', now: NOW });
    const claims = extractClaims({ evidence: retrieval.evidence, understanding, conflicts: retrieval.conflicts });
    const memoryClaim = claims.claims.find((claim) => claim.evidenceIds.includes(`ev:memory:${memory.id}`));
    const worldClaim = claims.claims.find((claim) => claim.evidenceIds.includes('ev:world_fact:f-gate'));
    assert.equal(memoryClaim.kind, ClaimKind.CONTRADICTED);
    assert.equal(worldClaim.kind, ClaimKind.CONTRADICTED);
    assert.ok(memoryClaim.contradicts.includes(worldClaim.claimId));
    assert.ok(worldClaim.contradicts.includes(memoryClaim.claimId));
  });

  test('support, qualification, and retracted citations do not create a contradiction link', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const memory = await addMemory(app, 'the gate is open');
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-support', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'supports', sourceType: 'memory', sourceId: memory.id },
    ]);
    await addFact(app, 'f-qualify', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'qualifies', sourceType: 'memory', sourceId: memory.id },
    ]);
    await addFact(app, 'f-retracted', 'e-gate', 'has_status', scalar('open'), [
      { relation: 'contradicts', sourceType: 'memory', sourceId: memory.id },
    ]);
    await write(app, 'world.statement.retract', {
      targetType: 'fact',
      target: 'f-retracted',
      reason: 'the contradiction was itself withdrawn',
      evidence: [{ relation: 'retracts', sourceType: 'user', sourceId: 'user' }],
    });
    const state = await app.worldModel.state();

    const retrieval = await retrievalFor(app, memory, state);
    const memoryRow = retrieval.evidence.find((item) => item.evidenceId === `ev:memory:${memory.id}`);
    assert.ok(memoryRow);
    assert.deepEqual(memoryRow.relationships.contradicts, []);
    assert.equal(retrieval.evidence.some((item) => item.retrievalReason === 'cross-store-citation'), false);
  });

  test('a knowledge record is linked the same way, and an unreadable memory store adds no link', async () => {
    const dir = tempDir();
    const app = appOn(dir);
    const knowledge = (await app.knowledge.add({
      subject: 'gate', relationship: 'has_status', object: 'open', origin: 'user',
    })).record;
    await addEntity(app, 'e-gate', 'North Gate');
    await addFact(app, 'f-gate', 'e-gate', 'has_status', scalar('closed'), [
      { relation: 'contradicts', sourceType: 'knowledge', sourceId: knowledge.id },
    ]);
    const state = await app.worldModel.state();
    const understanding = understandRequest({ request: 'what does the gate record say?', now: NOW });

    // Seed the annotated knowledge row so the citation has a side to link.
    const annotated = (await app.knowledge.getMany([knowledge.id])).get(knowledge.id);
    const retrieval = await retrieveEvidence({
      request: 'what does the gate record say?',
      understanding,
      now: NOW,
      seeds: { knowledge: [annotated], worldState: state },
    });
    const knowledgeRow = retrieval.evidence.find((item) => item.evidenceId === `ev:knowledge:${knowledge.id}`);
    assert.ok(knowledgeRow);
    assert.deepEqual(knowledgeRow.relationships.contradicts, ['ev:world_fact:f-gate']);
    const worldRow = retrieval.evidence.find((item) => item.evidenceId === 'ev:world_fact:f-gate');
    assert.deepEqual(worldRow.relationships.contradicts, [`ev:knowledge:${knowledge.id}`]);

    // A memory row is absent when the store is unreadable; the world side is not invented.
    const failed = await retrieveEvidence({
      request: 'what do you know about the gate?',
      understanding,
      now: NOW,
      seeds: { memoryHits: [], memoryUnavailable: true, worldState: state },
    });
    assert.equal(failed.evidence.some((item) => item.retrievalReason === 'cross-store-citation'), false);
  });
});

describe('cross-store belief trace through the CLI', () => {
  test('the CLI reads a trace from the same stores the API wrote', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const added = await runCli([
      'world', 'entity', 'add', '--category', 'product', '--alias', 'Gate 7', 'North Gate',
    ], env);
    assert.equal(added.code, 0, added.stdout + added.stderr);
    const entityId = added.stdout.match(/Entity ([A-Za-z0-9-]+) created/)[1];

    const fact = await runCli([
      'world', 'fact', 'add', '--subject', entityId, '--predicate', 'has_status',
      '--object-value', 'open', '--valid-from', '2024-01-01',
    ], env);
    assert.equal(fact.code, 0, fact.stdout + fact.stderr);
    const factId = fact.stdout.match(/Fact ([A-Za-z0-9-]+) recorded/)[1];

    const traced = await runCli(['world', 'trace', 'fact', factId], env);
    assert.equal(traced.code, 0, traced.stdout + traced.stderr);
    assert.match(traced.stdout, /Belief trace for fact/);
    assert.match(traced.stdout, /authorizes no action/);

    const unknown = await runCli(['world', 'trace', 'fact', 'f-does-not-exist'], env);
    assert.equal(unknown.code, 0, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout, /not in its store/);

    const badType = await runCli(['world', 'trace', 'plan', 'p-1'], env);
    assert.notEqual(badType.code, 0);
    assert.match(badType.stderr + badType.stdout, /plan|targetType|trace/i);
  });
});
