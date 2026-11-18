import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposal, advance, approve, rollback, STATES } from '../src/evolution/index.js';

test('evolution lifecycle requires approval before promotion', () => {
  let p = createProposal({ title: 'improve X' });
  while (p.state !== 'approval') p = advance(p);
  assert.throws(() => advance(p), /approval/);
  p = approve(p);
  p = advance(p);
  assert.equal(p.state, 'promotion');
  assert.equal(p.promoted, true);
});

test('rollback requires reason', () => {
  let p = createProposal({ title: 'x' });
  while (p.state !== 'approval') p = advance(p);
  p = approve(p);
  p = advance(p); // promotion
  const r = rollback(p, { reason: 'regression' });
  assert.equal(r.rolledBack, true);
  assert.throws(() => rollback(p, {}), /reason/);
});

test('isolation check', async (t) => {
  const { isIsolated } = await import('../src/evolution/index.js');
  assert.equal(isIsolated('/tmp/exp', '/data/prod'), true);
  assert.equal(isIsolated('/data/prod', '/data/prod'), false);
});
