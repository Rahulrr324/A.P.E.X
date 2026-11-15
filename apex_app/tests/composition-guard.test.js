// Composition guards: a request written as several parts is one plan or one request, never half of
// each. Before this suite, a request whose first words named an action and whose later parts named
// none fell through to the single-request path: "remember that the sky is blue; book a flight to
// Mars" stored the whole sentence as memory content and never mentioned the flight, and a question
// combined with a memory write answered the question while the write was dropped. The same run could
// also record one step twice. These tests pin the refusal, the redaction that keeps the memory
// payload out of the audit and the conversation, the plan path that still names parts it cannot take,
// and the prose that must keep working. Nothing here invokes a model: the one gateway used returns a
// fixed reply and records that it was asked, so "not called" is measurable.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { planFromText } from '../src/tasks/planner.js';
import { synthesizePlan } from '../src/executive/mapping.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already removed */ }
  }
});

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

// TEST DOUBLE: a model backend that returns fixed text and records each request it receives. It
// proves whether APEX asked a model at all; it says nothing about what a real model would reply.
function testDoubleModel(reply, captured) {
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async (req) => {
      captured.push(req);
      return { ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double', text: reply, finishReason: 'stop', truncated: false, latencyMs: 0 };
    },
  };
  return new ModelGateway({ backend });
}

function appOn(dataDir, gateway = new ModelGateway({ backend: new NoBackend() })) {
  return createApp({ dataDir, gateway });
}

function readRaw(dataDir, file) {
  try {
    return fs.readFileSync(path.join(dataDir, file), 'utf8');
  } catch {
    return '';
  }
}

describe('a request that cannot be carried out in full is refused whole', () => {
  test('a memory write combined with a part no action can take runs nothing and stores nothing', async () => {
    const dataDir = tempDir();
    const captured = [];
    const app = appOn(dataDir, testDoubleModel('an answer', captured));
    const res = await app.controller.handle('remember that the sky is blue; book a flight to Mars', { origin: 'user' });

    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.match(res.display, /asks for more than one step/);
    assert.match(res.display, /book a flight to Mars/);
    assert.match(res.display, /No part ran, and the request was not sent to a model\./);
    assert.equal(captured.length, 0, 'no model was asked');
    assert.equal((await app.memory.list({ limit: 10 })).length, 0, 'the compound request was not stored as memory');
    assert.equal((await app.taskStore.list()).length, 0, 'no task was created');
    // The audit keeps the request with the memory payload redacted, and never the payload itself.
    assert.equal(res.operation.capability, 'none');
    assert.equal(res.operation.errors[0].code, 'COMPOSITION_REFUSED');
    assert.match(readRaw(dataDir, 'operations.jsonl'), /book a flight to Mars/);
    assert.doesNotMatch(readRaw(dataDir, 'operations.jsonl'), /sky is blue/);
    assert.doesNotMatch(readRaw(dataDir, 'conversation.jsonl'), /sky is blue/);
  });

  test('a question combined with a memory write is refused instead of answering only the question', async () => {
    const dataDir = tempDir();
    const captured = [];
    const app = appOn(dataDir, testDoubleModel('Paris', captured));
    const res = await app.controller.handle('what is the capital of France; remember that the codename is Lighthouse', { origin: 'user' });

    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.equal(captured.length, 0);
    assert.equal((await app.memory.list({ limit: 10 })).length, 0);
    assert.doesNotMatch(readRaw(dataDir, 'conversation.jsonl'), /Lighthouse/);
    assert.doesNotMatch(readRaw(dataDir, 'operations.jsonl'), /Lighthouse/);
  });

  test('the refusal names a part the plan policy refuses, in its own words', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    // app.capabilities is registered but cannot be part of a plan, so the second part routes and is
    // then refused by planRefusal. The refusal must say which part and why, and store nothing.
    const res = await app.controller.handle('remember that the gate is open; what can you do', { origin: 'user' });
    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.match(res.display, /part 2/);
    assert.match(res.display, /cannot be part of a plan/);
    assert.equal((await app.memory.list({ limit: 10 })).length, 0);
  });

  test('a plan request is not preempted: the bridge still records the parts it cannot take as unknown', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.handle('prepare a plan to remember that the AK note holds; negotiate a treaty', { origin: 'user' });
    assert.equal(res.status, Outcome.PLAN_STORED, res.display);
    const plans = await app.plans.list();
    assert.equal(plans.length, 1);
    assert.ok((plans[0].assertions ?? []).some((a) => a.kind === 'unknown' && /negotiate a treaty/.test(a.text)),
      'the part no capability can take is recorded as unknown, not dropped');
    assert.equal((await app.memory.list({ limit: 10 })).length, 0, 'a plan is a proposal; nothing ran');
  });

  test('prose that contains "then" is still stored as one memory', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.handle('remember that we met and then left', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const records = await app.memory.list({ limit: 10 });
    assert.equal(records.length, 1);
    assert.match(records[0].content, /^we met and then left$/);
  });
});

describe('a plan that would run the same step twice is refused', () => {
  test('two identical calculation steps are refused, and no task is created', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.handle('calc 2+2; calc 2+2', { origin: 'user' });
    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.match(res.display, /repeats/);
    assert.equal((await app.taskStore.list()).length, 0);
  });

  test('two identical memory writes are refused and nothing is stored', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.handle('remember that the tide is high; remember that the tide is high', { origin: 'user' });
    assert.equal(res.status, Outcome.ACTION_DENIED);
    assert.equal((await app.memory.list({ limit: 10 })).length, 0);
    assert.equal((await app.taskStore.list()).length, 0);
  });

  test('different inputs are not a repetition, and the request still runs as a task', async () => {
    const dataDir = tempDir();
    const app = appOn(dataDir);
    const res = await app.controller.handle('calc 2+2; calc 2+3', { origin: 'user' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.equal((await app.taskStore.list()).length, 1);
  });
});

describe('the planner report the guards read', () => {
  test('planFromText names each part, whether it routed, and the repeated pair', () => {
    const app = appOn(tempDir());
    const dup = planFromText('calc 2+2; calc 2+2', app.registry);
    assert.equal(dup.parts.length, 2);
    assert.deepEqual(dup.parts.map((p) => p.routed), [true, true]);
    assert.equal(dup.duplicates.length, 1);
    assert.deepEqual([dup.duplicates[0].first.index, dup.duplicates[0].second.index], [0, 1]);

    const mixed = planFromText('calc 2+2; book a flight', app.registry);
    assert.deepEqual(mixed.parts.map((p) => p.routed), [true, false]);
    assert.equal(mixed.duplicates.length, 0);

    const refused = planFromText('calc 2+2; what can you do', app.registry);
    assert.deepEqual(refused.parts.map((p) => p.routed), [true, true]);
    assert.match(refused.parts[1].refused, /cannot be part of a plan/);
  });

  test('synthesizePlan refuses a repeated step with its own reason', () => {
    const app = appOn(tempDir());
    const synth = synthesizePlan({
      request: 'prepare a plan to calc 2+2; calc 2+2',
      workText: 'calc 2+2; calc 2+2',
      registry: app.registry,
    });
    assert.equal(synth.ok, false);
    assert.equal(synth.reason, 'duplicates');
    assert.match(synth.problems[0], /part 1 and part 2/);
  });
});
