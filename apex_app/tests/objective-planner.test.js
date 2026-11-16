// T-03: the general objective planner.
//
// A free-form objective is read against the live registry and answered as a *read*: typed parts in
// the order written, the step each mapped part becomes, the parts no registered capability can take,
// the alternatives that follow from the same mapping, and the risks, uncertainty, revalidation and
// recovery the existing plan store and TaskRunner already state. Nothing here records, approves, or
// runs anything, and no capability, parameter, or intent is invented for a part the router missed.
//
// The pure half runs against a stub registry so each case is exact. The integration half runs through
// the real app, the real registry, the real plan store and the real audit log; no model is contacted
// and no inference is performed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { ActionRegistry } from '../src/actions/registry.js';
import { PlanStatus } from '../src/plans/model.js';
import {
  AUTHORITY_NOTE,
  MAX_OBJECTIVE_CHARS,
  OBJECTIVE_SCHEMA,
  outlineObjective,
  renderOutline,
} from '../src/plans/objective.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

function stubRegistry() {
  const registry = new ActionRegistry();
  const add = (name, permission, description, { plannable = true } = {}) => registry.register({
    name,
    description,
    permission,
    plannable,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => input ?? {},
    async execute() { return { summary: name }; },
    async verify() { return { ok: true, detail: 'stub' }; },
  });
  add('memory.add', 'write', 'Save a fact or note into memory');
  add('memory.search', 'read', 'Search stored memories');
  add('note.list', 'read', 'List structured notes');
  return registry;
}

describe('T-03: objective outline is a read of the live registry', () => {
  test('a mapped objective produces a recordable draft and an ordered, typed part list', () => {
    const registry = stubRegistry();
    const o = outlineObjective({ objective: 'remember the build passed', registry });
    assert.equal(o.schema, OBJECTIVE_SCHEMA);
    assert.equal(o.counts.parts, 1);
    assert.equal(o.counts.steps, 1);
    assert.equal(o.counts.writes, 1);
    assert.equal(o.counts.reads, 0);
    assert.equal(o.parts[0].action, 'memory.add');
    assert.equal(o.parts[0].id, 's1');
    assert.deepEqual(o.parts[0].dependsOn, []);
    assert.equal(o.parts[0].authorization.userDecision, 'allow');
    assert.equal(o.draft.recordable, true);
    assert.equal(o.draft.content.steps[0].action, 'memory.add');
    // The write's payload is described by length, never reproduced.
    assert.match(o.parts[0].input.content, /^<omitted: \d+ chars>$/);
    assert.equal(JSON.stringify(o.parts).includes('build passed'), false);
    // Reading is not recording, approving, or starting, and the answer says so.
    assert.equal(o.authorizes, false);
    assert.equal(o.recorded, false);
    assert.equal(o.approved, false);
    assert.equal(o.executable, false);
    assert.equal(o.note, AUTHORITY_NOTE);
    assert.equal(o.estimation.available, false);
  });

  test('an unmatched part stays an unknown and a narrowed alternative names it outside the plan', () => {
    const registry = stubRegistry();
    const o = outlineObjective({ objective: 'remember the build passed; call the vendor', registry });
    assert.equal(o.counts.parts, 2);
    assert.equal(o.counts.steps, 1);
    assert.equal(o.counts.missing, 1);
    assert.equal(o.draft.recordable, true);
    assert.ok(o.draft.content.assertions.some((a) => a.kind === 'unknown'), 'the unmatched part is recorded as an unknown');
    const narrowed = o.alternatives.find((a) => a.kind === 'narrowed');
    assert.ok(narrowed, 'a narrowed alternative is derived');
    assert.equal(narrowed.recordable, true);
    assert.deepEqual(narrowed.content.steps.map((s) => s.action), ['memory.add']);
    assert.equal(narrowed.excluded.length, 1);
    assert.match(narrowed.excluded[0].text, /call the vendor/);
    // No capability was invented for the unmatched part.
    assert.equal(o.parts[1].action, null);
  });

  test('cannot_use withholds the draft that names the excluded action and the alternative omits it', () => {
    const registry = stubRegistry();
    const o = outlineObjective({
      objective: 'remember the build passed; recall build',
      registry,
      cannotUse: ['memory.add'],
    });
    assert.equal(o.draft, null);
    assert.match(o.draftWithheld, /memory\.add/);
    assert.equal(o.counts.excludedByRequest, 1);
    assert.ok(o.risks.some((r) => r.class === 'excluded-by-request' && r.step === 's1'));
    const narrowed = o.alternatives.find((a) => a.kind === 'narrowed');
    assert.ok(narrowed?.recordable);
    assert.deepEqual(narrowed.content.steps.map((s) => s.action), ['memory.search']);
    assert.ok(narrowed.excluded.some((e) => e.reason.includes('memory.add')));
  });

  test('a repeated step yields a deduplicated alternative instead of a second run', () => {
    const registry = stubRegistry();
    const o = outlineObjective({ objective: 'recall build; recall build', registry });
    assert.equal(o.draft, null);
    const alt = o.alternatives.find((a) => a.kind === 'deduplicated');
    assert.ok(alt?.recordable);
    assert.equal(alt.content.steps.length, 1);
    assert.ok(alt.excluded.some((e) => /repeats memory\.search/.test(e.reason)));
  });

  test('a policy-refused step is disclosed and relieved without claiming the refused plan', () => {
    const registry = stubRegistry();
    const o = outlineObjective({ objective: 'remember privately the code is 4411; recall code', registry });
    assert.equal(o.draft, null);
    assert.equal(o.draftWithheld, null);
    assert.ok(o.uncertainty.some((l) => /the plan checker refused it/.test(l)));
    assert.ok(o.risks.some((r) => r.class === 'private-content'));
    const alt = o.alternatives.find((a) => a.kind === 'policy-relieved');
    assert.ok(alt?.recordable);
    assert.deepEqual(alt.content.steps.map((s) => s.action), ['memory.search']);
    assert.ok(alt.excluded.some((e) => /the plan checker refuses memory\.add/.test(e.reason)));
  });

  test('the digest is deterministic and moves when the goal record moves', () => {
    const registry = stubRegistry();
    const goal = { id: 'goal-1', revision: 1, status: 'open' };
    const a = outlineObjective({ objective: 'remember the build passed', registry, goal });
    const b = outlineObjective({ objective: 'remember the build passed', registry, goal });
    assert.equal(a.digest, b.digest);
    assert.deepEqual(a.goal, goal);
    const moved = outlineObjective({
      objective: 'remember the build passed',
      registry,
      goal: { ...goal, revision: 2 },
    });
    assert.notEqual(moved.digest, a.digest);
    assert.equal(moved.goal.revision, 2);
  });

  test('invalid objectives and a missing registry are refused before anything is planned', () => {
    const registry = stubRegistry();
    assert.throws(() => outlineObjective({ objective: '', registry }), /1 to 500 characters/);
    assert.throws(() => outlineObjective({ objective: 'x'.repeat(MAX_OBJECTIVE_CHARS + 1), registry }), /1 to 500 characters/);
    assert.throws(
      () => outlineObjective({ objective: 'the password is hunter2', registry }),
      /password, key, or token/,
    );
    assert.throws(() => outlineObjective({ objective: 'remember the build passed' }), /live action registry/);
  });

  test('the rendered outline is bounded and repeats the authority note', () => {
    const registry = stubRegistry();
    const o = outlineObjective({ objective: 'remember the build passed; call the vendor', registry });
    const text = renderOutline(o);
    assert.match(text, /nothing recorded, approved, or running/);
    assert.match(text, /Each part, in the order you wrote it/);
    assert.match(text, /no effort estimate is given/);
    assert.ok(text.length <= 12000, `render exceeded its bound: ${text.length}`);
    assert.equal(text.includes('password'), false);
  });
});

describe('T-03: plan.outline through the real app', () => {
  async function appIn(dir) {
    return createApp({ dataDir: dir, experienceCapture: CAPTURE_OFF });
  }

  test('the action is registered as a read and the controller route writes no plan', async () => {
    const app = await appIn(tempDir());
    const def = app.registry.get('plan.outline');
    assert.ok(def, 'plan.outline is registered');
    assert.equal(def.permission, 'read');
    assert.notEqual(def.plannable, false);
    assert.ok(def.origins.includes('user'));
    assert.ok(def.origins.includes('model'));

    const before = (await app.plans.list()).length;
    const res = await app.controller.planOutline({
      objective: 'remember the integrated outline fact is stored; call the vendor',
    });
    assert.equal(res.operation.steps.length, 1);
    const step = res.operation.steps[0];
    assert.equal(step.action, 'plan.outline');
    assert.equal(step.outcome, 'success_verified', 'the read is independently re-derived and verified');
    const data = step.result.data;
    assert.equal(data.recorded, false);
    assert.equal(data.approved, false);
    assert.equal(data.executable, false);
    assert.equal(data.counts.steps, 1);
    assert.equal(data.counts.missing, 1);
    assert.match(res.display, /nothing recorded, approved, or running/);
    assert.equal((await app.plans.list()).length, before, 'plan.outline stores no plan');
  });

  test('a goal reference binds the outline to the recorded revision', async () => {
    const app = await appIn(tempDir());
    const created = await app.controller.goalAdd({
      request: 'the outline goal binds a recorded revision',
      criteria: ['the outline is bound to this goal'],
    });
    const goalId = created.operation.steps[0].result.data.goalId;
    const res = await app.controller.planOutline({
      objective: 'remember the bound outline fact is stored',
      goal: goalId,
    });
    const data = res.operation.steps[0].result.data;
    assert.equal(data.goal.id, goalId);
    assert.equal(typeof data.goal.status, 'string');
    assert.equal(typeof data.goal.revision, 'number');
  });

  test('the verifier refuses an outline whose registry changed under it', async () => {
    const app = await appIn(tempDir());
    const def = app.registry.get('plan.outline');
    const input = def.validate({ objective: 'remember the verified outline fact is stored' });
    const out = await def.execute({ registry: app.registry }, input);
    const clean = await def.verify({ registry: app.registry }, input, out);
    assert.equal(clean.ok, true, clean.detail);
    assert.match(clean.detail, /recorded and approved nothing/);

    const shrunk = new ActionRegistry();
    for (const d of app.registry.list()) {
      if (d.name === 'plan.outline') continue;
      if (d.name === 'memory.add') continue;
      shrunk.register(d);
    }
    const changed = await def.verify({ registry: shrunk }, input, out);
    assert.equal(changed.ok, false, 'a registry that no longer holds a listed action invalidates the outline');
  });

  test('the CLI reads an outline and prints JSON without recording anything', async () => {
    const dir = tempDir();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir });
    const res = await runCli(['plan', 'outline', 'remember the cli outline fact is stored', '--json'], env);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout.split('\nAudit: recorded in operations.jsonl')[0]);
    assert.equal(payload.recorded, false);
    assert.equal(payload.approved, false);
    assert.equal(payload.executable, false);
    assert.equal(typeof payload.digest, 'string');
    const listed = await runCli(['plan', 'list'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /cli outline fact/);
  });
});

// The plan statuses the store understands are untouched by this read; asserted here so a later change
// to what an outline may claim has to face the existing lifecycle rather than drift from it.
assert.ok(Object.values(PlanStatus).includes('draft'));
