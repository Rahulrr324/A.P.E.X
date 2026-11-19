import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActionRegistry } from '../src/actions/registry.js';
import { workshopActions } from '../src/actions/workshop-actions.js';
import { createWorkshopService } from '../src/workshop/service.js';
import { ORIGIN_MODEL, ORIGIN_USER } from '../src/actions/origins.js';
import { ValidationError } from '../src/errors.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-workshop-actions-'));
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const workshop = createWorkshopService({ dataDir });
  const registry = new ActionRegistry();
  for (const action of workshopActions(workshop)) registry.register(action);
  return { workshop, registry };
}

const composition = {
  title: 'Action boundary fixture',
  domain: 'plan',
  components: [
    { id: 'planner', kind: 'service', supply: 5, demand: 1, cost: 2 },
    { id: 'store', kind: 'database', supply: 0, demand: 3, cost: 1 },
  ],
  connections: [{ from: 'planner', to: 'store' }],
  budget: { total: 10 },
};

test('Workshop composition is a user-only write; model origin is denied', async (t) => {
  const { registry } = await fixture(t);
  assert.equal(registry.authorize('workshop.compose', ORIGIN_USER).decision, 'allow');
  assert.deepEqual(registry.authorize('workshop.compose', ORIGIN_MODEL), {
    decision: 'deny',
    reason: 'ORIGIN_NOT_PERMITTED',
  });
  assert.equal(registry.authorize('workshop.list', ORIGIN_MODEL).decision, 'allow');
  assert.equal(registry.authorize('workshop.simulate', ORIGIN_MODEL).decision, 'allow');
});

test('Workshop compose validates input, persists, and independently verifies the artifact', async (t) => {
  const { workshop, registry } = await fixture(t);
  const action = registry.get('workshop.compose');
  const input = action.validate(composition);
  const result = await action.execute({ workshop }, input);
  assert.equal(result.data.authorizesExecution, false);
  assert.equal(result.data.executedCode, false);
  assert.equal(result.data.appended, true);
  const verification = await action.verify({ workshop }, input, result);
  assert.equal(verification.ok, true);
  assert.match(verification.detail, /independent read and simulation/);
});

test('Workshop compose rejects unknown fields and invalid component numbers', async (t) => {
  const { registry } = await fixture(t);
  const action = registry.get('workshop.compose');
  assert.throws(() => action.validate({ ...composition, authorization: true }), ValidationError);
  assert.throws(() => action.validate({
    ...composition,
    components: [{ id: 'api', kind: 'service', supply: Number.NaN }],
  }), ValidationError);
});

test('Workshop model-origin read actions cannot mutate the append-only log', async (t) => {
  const { workshop, registry } = await fixture(t);
  const before = await workshop.status();
  const list = registry.get('workshop.list');
  const input = list.validate({ limit: 10 });
  const result = await list.execute({ workshop }, input);
  const verification = await list.verify({ workshop }, input, result);
  const after = await workshop.status();
  assert.equal(verification.ok, true);
  assert.equal(after.artifacts, before.artifacts);
  assert.equal(after.chain, 'intact');
});

test('Workshop simulation is read-only and explicitly never authorizes execution', async (t) => {
  const { workshop, registry } = await fixture(t);
  const compose = registry.get('workshop.compose');
  const composed = await compose.execute({ workshop }, compose.validate(composition));
  const simulate = registry.get('workshop.simulate');
  const input = simulate.validate({ artifactId: composed.data.artifactId });
  const before = await workshop.status();
  const result = await simulate.execute({ workshop }, input);
  const verification = await simulate.verify({ workshop }, input, result);
  const after = await workshop.status();
  assert.equal(result.data.authorizesExecution, false);
  assert.equal(result.data.executedCode, false);
  assert.equal(verification.ok, true);
  assert.equal(after.artifacts, before.artifacts);
});
