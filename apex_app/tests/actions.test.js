// Actions, authorization, execution, and verification as separate concerns.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ActionRegistry } from '../src/actions/registry.js';
import { builtinActions } from '../src/actions/builtin.js';
import { executeAction } from '../src/actions/executor.js';
import { evaluateExpression, evaluateRpn, validateExpression } from '../src/actions/calc.js';
import { Verifier } from '../src/verify/verifier.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { Outcome } from '../src/outcomes.js';
import { ValidationError, StoreError } from '../src/errors.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function registryWithBuiltins() {
  const r = new ActionRegistry();
  for (const d of builtinActions()) r.register(d);
  return r;
}

describe('authorization policy', () => {
  test('read actions are allowed from user and model origins', () => {
    const r = registryWithBuiltins();
    assert.equal(r.authorize('calc.evaluate', 'user').decision, 'allow');
    assert.equal(r.authorize('calc.evaluate', 'model').decision, 'allow');
    assert.equal(r.authorize('memory.search', 'model').decision, 'allow');
    assert.equal(r.authorize('memory.correct', 'user').decision, 'allow');
  });

  test('write actions are denied to the model origin (a model request is not authorization)', () => {
    const r = registryWithBuiltins();
    assert.deepEqual(r.authorize('memory.add', 'model'), { decision: 'deny', reason: 'ORIGIN_NOT_PERMITTED' });
    assert.equal(r.authorize('memory.add', 'user').decision, 'allow');
    assert.equal(r.authorize('memory.save_conclusion', 'model').decision, 'deny');
    assert.equal(r.authorize('memory.correct', 'model').decision, 'deny');
  });

  test('unknown actions, unknown origins, and prototype-like names are denied', () => {
    const r = registryWithBuiltins();
    assert.equal(r.authorize('shell.exec', 'user').reason, 'UNKNOWN_ACTION');
    assert.equal(r.authorize('constructor', 'user').reason, 'UNKNOWN_ACTION');
    assert.equal(r.authorize('__proto__', 'user').reason, 'UNKNOWN_ACTION');
    assert.equal(r.authorize('calc.evaluate', 'root').reason, 'UNKNOWN_ORIGIN');
    assert.equal(r.authorize(undefined, 'user').reason, 'UNKNOWN_ACTION');
  });

  test('the registry refuses to register a write action for the model origin or duplicate names', () => {
    const r = new ActionRegistry();
    const base = { name: 'x.write', description: 'd', permission: 'write', origins: ['user', 'model'], validate: (i) => i, execute: async () => ({}) };
    assert.throws(() => r.register(base), TypeError);
    r.register({ ...base, origins: ['user'] });
    assert.throws(() => r.register({ ...base, origins: ['user'] }), /duplicate/);
    assert.throws(() => r.register({ ...base, name: 'Bad Name' }), TypeError);
  });
});

describe('calculator (executor and independent verifier)', () => {
  test('evaluates arithmetic with precedence, parentheses, and unary minus', () => {
    assert.equal(evaluateExpression('(2+3)*4'), 20);
    assert.equal(evaluateExpression('2+3*4'), 14);
    assert.equal(evaluateExpression('-2+3'), 1);
    assert.equal(evaluateExpression('2*-3'), -6);
    assert.equal(evaluateExpression('10/4'), 2.5);
  });

  test('the verifier method agrees with the executor method on the same expressions', () => {
    const samples = ['(2+3)*4', '2+3*4', '-2+3', '2*-3', '10/4', '((7))', '-(2+3)*-2', '1.5*4-0.5'];
    for (const s of samples) {
      assert.equal(evaluateRpn(s), evaluateExpression(s), s);
    }
  });

  test('invalid expressions are rejected before execution and never evaluated as code', () => {
    for (const bad of ['', '2+', '(2+3', '2 3', '1.2.3', 'process.exit()', 'require("fs")', 'alert(1)', 'no digits here', '2^3', '9'.repeat(201)]) {
      assert.throws(() => validateExpression(bad), ValidationError, `expected rejection: ${bad.slice(0, 20)}`);
    }
  });

  test('division by zero is an execution failure, not a value', () => {
    assert.throws(() => evaluateExpression('1/0'), (e) => e.code === 'DIVISION_BY_ZERO');
  });
});

describe('executor and verifier are separate', () => {
  test('a thrown execution error is reported as failed and never reaches verification', async () => {
    const r = registryWithBuiltins();
    const def = r.get('calc.evaluate');
    const exec = await executeAction(def, {}, { expression: '1/0' });
    assert.equal(exec.status, 'failed');
    assert.equal(exec.error.code, 'DIVISION_BY_ZERO');
  });

  test('invalid input is rejected by the executor with INVALID_EXPRESSION', async () => {
    const def = registryWithBuiltins().get('calc.evaluate');
    const exec = await executeAction(def, {}, { expression: 'process.exit()' });
    assert.equal(exec.status, 'rejected');
    assert.equal(exec.error.code, 'INVALID_EXPRESSION');
  });

  test('verification unavailable: an action with no verifier', async () => {
    const v = await new Verifier().check({ name: 'x.y', verify: null }, {}, {}, { data: {} });
    assert.equal(v.outcome, Outcome.VERIFICATION_UNAVAILABLE);
  });

  test('verification unavailable: the evidence cannot be read (store unavailable)', async () => {
    const dir = makeTempDataDir(); dirs.push(dir);
    const blocker = path.join(dir, 'file');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(blocker, 'x');
    const memory = new MemoryStore(path.join(blocker, 'memory.jsonl'));
    const def = registryWithBuiltins().get('memory.list');
    const v = await new Verifier().check(def, { memory }, { limit: 5 }, { data: { hits: [] } });
    assert.equal(v.outcome, Outcome.VERIFICATION_UNAVAILABLE);
    assert.match(v.detail, /STORE_UNAVAILABLE/);
  });

  test('verification failed: a postcondition does not hold', async () => {
    const dir = makeTempDataDir(); dirs.push(dir);
    const memory = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const def = registryWithBuiltins().get('memory.add');
    const v = await new Verifier().check(def, { memory }, { content: 'never stored' }, { data: { id: 'missing-id' } });
    assert.equal(v.outcome, Outcome.VERIFICATION_FAILED);
  });

  test('verification success only when the independent check confirms the postcondition', async () => {
    const dir = makeTempDataDir(); dirs.push(dir);
    const memory = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const def = registryWithBuiltins().get('memory.add');
    const ctx = { memory, operationId: 'op-1' };
    const exec = await executeAction(def, ctx, { content: 'verified fact' });
    const v = await new Verifier().check(def, ctx, exec.input, exec.result);
    assert.equal(v.outcome, Outcome.SUCCESS_VERIFIED);
  });

  test('a verifier that throws is reported as unavailable, not as success', async () => {
    const v = await new Verifier().check(
      { verify: async () => { throw new StoreError('down'); } }, {}, {}, {},
    );
    assert.equal(v.outcome, Outcome.VERIFICATION_UNAVAILABLE);
  });

  test('a verifier that returns no decision is unavailable, not success', async () => {
    const v = await new Verifier().check({ verify: async () => undefined }, {}, {}, {});
    assert.equal(v.outcome, Outcome.VERIFICATION_UNAVAILABLE);
  });
});
