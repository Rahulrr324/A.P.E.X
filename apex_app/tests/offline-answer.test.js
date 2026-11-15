// Offline deterministic answering: with no inference backend configured, APEX still reasons over its
// stores through the model-free cognitive engine and answers from the records it has, cited and
// bounded. These tests drive the real controller, stores, and CLI child processes. They assert the
// safety contracts that make the feature honest: record content never enters the audited output, only
// prompt-eligible memory/knowledge records are rendered (private and below-relevance records stay out),
// an unsupported question still reports MODEL_UNAVAILABLE, and nothing is written or authorized.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';
import { CAPTURE_VERIFIED_SUCCESS } from '../src/experience/capture.js';
import { makeTempDataDir, cleanup, cleanEnv, runCli } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

const NOW = '2026-11-15T00:00:00.000Z';
function appOn(dataDir = tempDir()) {
  return { dataDir, ...createApp({ dataDir, gateway: new ModelGateway({ backend: new NoBackend() }), now: () => new Date(NOW) }) };
}
const bytes = (dir, name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; } };

describe('offline deterministic answering', () => {
  test('a stored fact yields a cited deterministic answer with a content-free audit output', async () => {
    const app = appOn();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const res = await app.controller.handle('what is the codename of the project?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.equal(res.decision, Decision.ANSWER);
    assert.equal(res.operation.backend, null);
    assert.match(res.display, /Deterministic answer from APEX's stored records/);
    assert.match(res.display, /Lighthouse/);
    assert.match(res.display, /ev:memory:/, 'the answer cites the evidence id it rests on');
    assert.doesNotMatch(res.output ?? '', /Lighthouse/, 'stored content stays out of the audited output');
    assert.equal(res.operation.prompt, null, 'no model prompt was built');
  });

  test('a question the stores cannot answer still reports MODEL_UNAVAILABLE', async () => {
    const app = appOn();
    const res = await app.controller.handle('what is the capital of France?');
    assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
    assert.match(res.display, /No inference backend is configured/);
  });

  test('private memory is never surfaced by the deterministic answer', async () => {
    const app = appOn();
    await app.controller.handle('remember privately that the safe combination is seven-nine-two');
    const res = await app.controller.handle('what is the safe combination?');
    assert.equal(res.status, Outcome.MODEL_UNAVAILABLE);
    assert.ok(!res.display.includes('seven-nine-two'));
    assert.ok(!String(res.output).includes('seven-nine-two'));
  });

  test('a knowledge claim is answered with its triple shown directly', async () => {
    const app = appOn();
    await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Lighthouse' });
    const res = await app.controller.handle('what is the project codename?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.ok(res.display.includes('Project --[codename]--> Lighthouse'));
    assert.doesNotMatch(res.output ?? '', /Lighthouse/);
  });

  test('an incidental below-relevance record is not surfaced', async () => {
    const app = appOn();
    await app.controller.knowledgeAdd({ subject: 'martinez account', relationship: 'owned_by', object: 'finance team' });
    await app.controller.knowledgeAdd({ subject: 'office printer', relationship: 'budget_code', object: 'sigma 9' });
    const res = await app.controller.handle('which team owns the martinez account');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.ok(res.display.includes('martinez account'));
    assert.ok(!res.display.includes('office printer'), 'the deterministic answer uses the same relevance rule as the direct display');
  });

  test('the same question reconstructs the same answer deterministically', async () => {
    const app = appOn();
    await app.controller.handle('remember that the deploy target is the eu-west region');
    const a = await app.controller.handle('tell me about the deploy target');
    const b = await app.controller.handle('tell me about the deploy target');
    assert.equal(a.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.equal(a.display, b.display);
  });

  test('answering writes nothing to the memory or knowledge store', async () => {
    const app = appOn();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const memBefore = bytes(app.dataDir, 'memory.jsonl');
    const knowBefore = bytes(app.dataDir, 'knowledge.jsonl');
    const res = await app.controller.handle('what is the codename of the project?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.equal(bytes(app.dataDir, 'memory.jsonl'), memBefore);
    assert.equal(bytes(app.dataDir, 'knowledge.jsonl'), knowBefore);
  });

  test('a damaged knowledge store is disclosed while a readable memory fact still answers', async () => {
    const app = appOn();
    await app.controller.handle('remember that the project codename is Lighthouse');
    fs.appendFileSync(path.join(app.dataDir, 'knowledge.jsonl'), 'CORRUPT\n', 'utf8');
    const res = await app.controller.handle('what is the project codename?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.match(res.display, /Knowledge context was unavailable/);
    assert.ok(res.operation.errors.some((e) => e.stage === 'knowledge'));
  });

  test('a model-origin request may read deterministically but cannot write knowledge', async () => {
    const app = appOn();
    await app.controller.handle('remember that the project codename is Lighthouse');
    const asked = await app.controller.handle('what is the project codename?', { origin: 'model' });
    assert.equal(asked.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.equal(app.registry.authorize('knowledge.add', 'model').decision, 'deny');
    assert.equal(app.registry.authorize('memory.add', 'model').decision, 'deny');
  });

  test('contradictory records are presented as disputed, not settled by either side', async () => {
    const app = appOn();
    await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Lighthouse' });
    await app.controller.knowledgeAdd({ subject: 'Project', relationship: 'codename', object: 'Bluebird' });
    const res = await app.controller.handle('what is the project codename?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.ok(res.display.includes('Lighthouse') && res.display.includes('Bluebird'), 'both sides are shown');
    assert.match(res.display, /Disputed: 2 claim\(s\) are contradicted/);
    assert.match(res.display, /neither is chosen by recency, source rank, or repetition/);
    assert.match(res.output, /The records disagree; both sides are shown and neither is chosen/);
    assert.doesNotMatch(res.output ?? '', /Lighthouse|Bluebird/, 'content stays out of the audited output');
  });

  test('an ambiguous reference is clarified with no model configured', async () => {
    const app = appOn();
    const UE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }];
    for (const [id, name] of [['atlas-one', 'Atlas One'], ['atlas-two', 'Atlas Two']]) {
      const added = await app.controller.worldWrite('world.entity.add', {
        id, category: 'project', name, evidence: UE, aliases: ['Atlas'],
      });
      assert.equal(added.status, Outcome.SUCCESS_VERIFIED, added.output);
    }
    const res = await app.controller.handle('what is the status of Atlas?');
    assert.equal(res.status, Outcome.CLARIFICATION_REQUIRED);
    assert.equal(res.decision, Decision.CLARIFY);
    assert.match(res.display, /Which entity do you mean\?/);
    assert.equal(res.operation.prompt, null, 'the question is decided before any prompt is built');
  });

  test('a deterministic answer is never a verified success and creates no experience or executive record', async () => {
    const dir = tempDir();
    const app = createApp({
      dataDir: dir,
      gateway: new ModelGateway({ backend: new NoBackend() }),
      now: () => new Date(NOW),
      // Capture is enabled so the test proves the answer is excluded on its own outcome, not because
      // automatic capture happens to be off.
      experienceCapture: CAPTURE_VERIFIED_SUCCESS,
    });
    await app.controller.handle('remember that the staging window is Thursday night');
    const res = await app.controller.handle('what is the staging window?');
    assert.equal(res.status, Outcome.SUCCESS_DETERMINISTIC);
    assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED);

    const ops = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(ops.at(-1).status, Outcome.SUCCESS_DETERMINISTIC);
    assert.ok(!String(ops.at(-1).output).includes('Thursday'), 'the audit output is content-free');

    const experiences = fs.existsSync(path.join(dir, 'experience.jsonl'))
      ? fs.readFileSync(path.join(dir, 'experience.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.ok(!experiences.some((record) => record.operationId === res.operation.id), 'a deterministic reading is not captured as a verified experience');
    assert.ok(!fs.existsSync(path.join(dir, 'goals.jsonl')), 'no goal is created');
    assert.ok(!fs.existsSync(path.join(dir, 'plans.jsonl')), 'no plan is created');

    const turns = fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const replies = turns.filter((turn) => turn.operationId === res.operation.id && turn.role === 'assistant');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, res.output, 'the stored turn is the content-free summary, not the shown reading');
    assert.ok(!replies[0].text.includes('Thursday'));
  });

  test('the CLI answers deterministically and exits 0 with no backend', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const stored = await runCli(['ask', 'remember that the project codename is Lighthouse'], env);
    assert.equal(stored.code, 0, stored.stderr);
    const asked = await runCli(['ask', 'what is the codename of the project?'], env);
    assert.equal(asked.code, 0, asked.stderr);
    assert.match(asked.stdout, /success_deterministic/);
    assert.match(asked.stdout, /Deterministic answer from APEX's stored records/);
    assert.match(asked.stdout, /Lighthouse/);
  });
});