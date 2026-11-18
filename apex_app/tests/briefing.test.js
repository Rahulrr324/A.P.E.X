import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefing, BRIEFING_SCHEMA } from '../src/briefing/index.js';

test('briefing distinguishes facts and inferred items', () => {
  const b = buildBriefing({
    goals: [{ id: 'g1', title: 'Goal', status: 'active' }],
    plans: [{ id: 'p1', outcome: 'Plan', status: 'draft' }],
    tasks: [{ id: 't1', goal: 'Task', status: 'running' }, { id: 't2', goal: 'Task2', status: 'blocked', approval: true }],
    situation: { alerts: [{ id: 'a1', summary: 'alert' }], observations: [] },
  });
  assert.equal(b.schema, BRIEFING_SCHEMA);
  assert.ok(b.facts.some((f) => f.kind === 'goal'));
  assert.ok(b.facts.some((f) => f.kind === 'sentinel_alert'));
  assert.ok(b.inferred.some((i) => i.kind === 'decision_needed'));
  assert.ok(b.concise.includes('Goals: 1'));
});
