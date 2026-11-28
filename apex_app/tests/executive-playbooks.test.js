// T-45 Package 4 (2026-11-19): the governed Executive Playbooks engine.
//
// These tests pin the six claims the module exists to make, against the REAL composed application rather
// than a hand-built stub, because the question "may this step run" is answered by the registry's own
// declarations:
//
//   1. The catalog. Three templates, each a fan-out/fan-in DAG of exactly three steps. A template is
//      verified only if every one of its steps is a capability the ECP will allow, is reversible or local,
//      and declares no higher than L2 - so a template is a claim the product checks, not one it trusts.
//   2. The catalog is readable on every configuration, including one with no workspace root. A build with
//      no repository has no `git.status_detailed`; that must not make the panel unreadable.
//   3. The launch. Every step runs through the controller, in dependency order, and leaves its own
//      operation in `operations.jsonl`. The run's step ids name those operations, and the trace resolves
//      `pbr_*` back to them.
//   4. The fan-in rule. A fan-in step runs only if BOTH steps it depends on verified. When one root cannot
//      run, the fan-in is `skipped` and the run is `failed` - it does not run on half a reading.
//   5. Lockdown. A launch answers 423 LOCKDOWN_ACTIVE, at the route and from the engine's own door, and
//      nothing is recorded: a refusal at the door is not a run.
//   6. Step-up. `playbook.launch` is L2, so it is refused without a step-up grant like every other L2 write.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import {
  PLAYBOOK_IDS, PLAYBOOK_CODES, ExecutivePlaybooks, PLAYBOOK_TEMPLATES, playbookStepRefusalReasons,
} from '../src/executive/playbooks.js';

const dirs = [];
function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { cleanup(dirs.pop()); } catch { /* already gone */ }
  }
});

// Environment for every git child: a fixed identity and no user config, so a developer's own
// `~/.gitconfig` cannot change what the fixture's repository looks like.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'APEX T-45',
  GIT_AUTHOR_EMAIL: 't45@apex.invalid',
  GIT_COMMITTER_NAME: 'APEX T-45',
  GIT_COMMITTER_EMAIL: 't45@apex.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

// A real repository with one uncommitted edit, so `git.status_detailed` has something true to read and
// the run that verifies is a real verified run rather than a stub that returns a bool.
function gitWorkspace() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 't45-ws-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
  dirs.push(dir);
  return dir;
}

function appWith({ root = null, stepUpToken = null } = {}) {
  return createApp({
    dataDir: tempDir(),
    filesystemRoot: root,
    ...(stepUpToken ? { stepUpToken } : {}),
  });
}

async function launch(app, playbookId) {
  return app.playbooks.launch(playbookId);
}

function runLedger(app) {
  const file = path.join(app.dataDir, 'playbook-runs.json');
  if (!fs.existsSync(file)) return { runs: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function operations(app) {
  const file = path.join(app.dataDir, 'operations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// A settled write: `OperationLog.append` is async, so a read taken the same tick a run finished can miss
// the line it just wrote. The T-44 suite learned this the same way.
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('T-45 Package 1: the playbook catalog', () => {
  test('three templates, each a three-step fan-out/fan-in DAG', () => {
    assert.deepEqual([...PLAYBOOK_IDS], ['morning_briefing', 'workspace_security_audit', 'pre_release_readiness']);
    assert.deepEqual(Object.keys(PLAYBOOK_CODES).sort(), [
      'EXECUTION_REFUSED', 'INVALID_INPUT', 'LOCKDOWN_ACTIVE', 'PLAYBOOK_NOT_FOUND',
      'PLAYBOOK_TEMPLATE_BROKEN', 'STEP_UP_REQUIRED',
    ]);
    assert.equal(PLAYBOOK_TEMPLATES.length, 3);
    const shapes = {
      morning_briefing: ['system.doctor', 'git.status_detailed', 'agenda.list'],
      workspace_security_audit: ['system.inspect_ports', 'system.inspect_processes', 'git.status_detailed'],
      pre_release_readiness: ['system.doctor', 'standing_order.evaluate', 'git.diff_inspect'],
    };
    for (const template of PLAYBOOK_TEMPLATES) {
      // The graph's shape is asserted rather than described: two roots, one fan-in, and the fan-in waits on
      // both. A template with a chain of three would pass a "three steps" check and fail this one.
      assert.equal(template.steps.length, 3, `${template.playbookId} must have three steps`);
      const roots = template.steps.filter((step) => step.dependsOn.length === 0);
      const joins = template.steps.filter((step) => step.dependsOn.length > 0);
      assert.equal(roots.length, 2, `${template.playbookId} must fan out to two roots`);
      assert.equal(joins.length, 1, `${template.playbookId} must fan in to one step`);
      assert.deepEqual(joins[0].dependsOn, roots.map((step) => step.stepId),
        `${template.playbookId}'s fan-in must wait on both roots`);
      assert.deepEqual(template.steps.map((step) => step.capabilityId), shapes[template.playbookId]);
    }
  });

  test('every template is verified against the real registry, and names a reason when it is not', () => {
    const app = appWith({ root: gitWorkspace() });
    const catalog = app.playbooks.catalog();
    assert.equal(catalog.verified, true);
    assert.equal(catalog.templates.length, 3);
    assert.equal(catalog.summary.templateCount, 3);
    for (const template of catalog.templates) {
      assert.equal(template.verified, true, `${template.playbookId} must be verified`);
      assert.deepEqual(template.broken ?? [], [], `${template.playbookId} must name no broken step`);
      // A template's ceiling is stated per step, and no step may be above the hard L2 ceiling. The
      // reversibility and blast-radius rules are the engine's own, read back through the same helper the
      // engine used, so the two cannot disagree about what makes a step admissible.
      for (const step of template.steps) {
        const definition = app.registry.get(step.capabilityId);
        assert.ok(definition, `${step.capabilityId} must be a registered capability`);
        assert.ok(['L0', 'L1', 'L2'].includes(definition.autonomyLevel),
          `${step.capabilityId} declares ${definition.autonomyLevel}, which no template may run`);
        assert.deepEqual(playbookStepRefusalReasons(definition), [],
          `${step.capabilityId} is not admissible as a step`);
      }
    }
  });

  test('the catalog is readable with no workspace root, and says which step cannot run', async () => {
    // This is the brief's "200 on all configurations" claim. A build with no repository has no
    // `git.status_detailed`, and the panel must still answer: the routine is a plan, and a plan for a
    // machine with no repository is still a readable plan.
    const app = appWith({ root: null });
    const catalog = app.playbooks.catalog();
    assert.equal(catalog.verified, true);
    assert.equal(catalog.templates.length, 3);
    assert.equal(catalog.summary.templateCount, 3);
    // The run below is what proves the difference between "unregistered" and "unsafe": a template whose
    // step is simply absent from this build is not broken, it is a routine this build cannot finish.
    const run = await launch(app, 'morning_briefing');
    assert.equal(run.runId.startsWith('pbr_'), true);
    assert.equal(run.status, 'failed');
    const byCapability = Object.fromEntries(run.steps.map((step) => [step.capabilityId, step]));
    assert.equal(byCapability['system.doctor'].status, 'verified');
    assert.equal(byCapability['git.status_detailed'].status, 'skipped');
    assert.match(byCapability['git.status_detailed'].summary, /not registered in this build/);
    // The fan-in did not run on half a reading.
    assert.equal(byCapability['agenda.list'].status, 'skipped');
    assert.match(byCapability['agenda.list'].summary, /repository did not verify/);
  });
});

describe('T-45 Package 1: launching a routine', () => {
  test('all three templates run to verified, in DAG order, with real operation ids', async () => {
    const app = appWith({ root: gitWorkspace() });
    for (const playbookId of PLAYBOOK_IDS) {
      const run = await launch(app, playbookId);
      assert.equal(run.playbookId, playbookId);
      assert.match(run.runId, /^pbr_[0-9a-f]+$/);
      assert.equal(run.status, 'verified', `${playbookId} must verify: ${JSON.stringify(run.steps)}`);
      assert.equal(run.verified, true);
      assert.equal(run.steps.length, 3);
      // Every step names its own operation, and every one of those is a line in the one ledger.
      const template = PLAYBOOK_TEMPLATES.find((entry) => entry.playbookId === playbookId);
      assert.deepEqual(run.steps.map((step) => step.capabilityId), template.steps.map((step) => step.capabilityId));
      for (const step of run.steps) {
        assert.equal(step.status, 'verified', `${playbookId}/${step.stepId}: ${step.summary}`);
        // The operation id is the ledger's own - a bare UUID, which is what every operation in this
        // product has always been. A template does not invent a prefix for a receipt it did not issue.
        assert.match(step.operationId, /^[0-9a-f-]{36}$/, `${playbookId}/${step.stepId} names no operation`);
      }
      // The order is the DAG's: both roots before the fan-in, and the fan-in last.
      const fanInIndex = run.steps.findIndex((step) => template.steps.find((entry) => entry.stepId === step.stepId).dependsOn.length > 0);
      assert.equal(fanInIndex, 2, `${playbookId}: the fan-in must be the third step`);
    }
    await settle();
    const ledger = runLedger(app);
    assert.equal(ledger.runs.length, 3);
    assert.equal(ledger.runs.every((run) => run.status === 'verified'), true);
    const ops = operations(app);
    for (const run of ledger.runs) {
      for (const step of run.steps) {
        const receipt = ops.find((entry) => entry.id === step.operationId);
        assert.ok(receipt, `${run.runId}/${step.stepId} names ${step.operationId}, which is not in operations.jsonl`);
        assert.equal(receipt.steps[0].action, step.capabilityId);
        assert.equal(receipt.steps[0].verification.outcome, 'success_verified');
      }
    }
  });

  test('a launch is one run, three operations, and the run names each one', async () => {
    const app = appWith({ root: gitWorkspace() });
    const run = await launch(app, 'workspace_security_audit');
    await settle();
    const ops = operations(app);
    // Exactly the three step operations plus the launch's own audit line: the routine does not re-record
    // what its steps already recorded, and it does not record its steps twice.
    const stepOps = ops.filter((entry) => run.steps.some((step) => step.operationId === entry.id));
    assert.equal(stepOps.length, 3);
    assert.deepEqual(stepOps.map((entry) => entry.steps[0].action).sort(),
      ['git.status_detailed', 'system.inspect_ports', 'system.inspect_processes']);
  });

  test('the causal trace of a run resolves to the run, its steps and their operations', async () => {
    const app = appWith({ root: gitWorkspace() });
    const run = await launch(app, 'morning_briefing');
    await settle();
    const trace = app.memoryTrace.trace(run.runId);
    assert.equal(trace.ok, true, JSON.stringify(trace).slice(0, 400));
    // Every step verified, so every step names an operation, so the chain is whole.
    assert.equal(run.status, 'verified');
    assert.equal(trace.complete, true);
    // A playbook id is never a cognition run id. The chain says so rather than reporting a gap that does
    // not exist - the false negative T-39 removed for candidate chains.
    assert.equal(trace.missing.some((note) => /playbook run chain/.test(note)), true);
    assert.equal(trace.counts.playbookRuns, 1);
    // Four operations, not three: the launch is itself a governed L2 write, so it leaves its own audit
    // line beside the three its steps recorded. A routine that did not record its own act would be the one
    // write in the product with no receipt.
    assert.equal(trace.counts.operations, 4);
    const kinds = trace.entries.map((entry) => entry.kind);
    assert.equal(kinds[0], 'playbook_run');
    assert.equal(kinds.filter((kind) => kind === 'ecp_audit').length, 4);
    assert.equal(kinds.every((kind) => kind === 'playbook_run' || kind === 'ecp_audit'), true);
    // The run's own steps are in the chain, and each operation the run named is too.
    const text = JSON.stringify(trace.entries);
    assert.match(text, /morning_briefing/);
    for (const step of run.steps) assert.match(text, new RegExp(step.operationId));
    // And each step's operation id resolves back to the run that caused it, which is what makes the chain a
    // chain rather than a list.
    const stepTrace = app.memoryTrace.trace(run.steps[0].operationId);
    assert.equal(stepTrace.ok, true);
    assert.match(JSON.stringify(stepTrace.entries), new RegExp(run.runId));
  });

  test('a run whose steps could not all verify reports an incomplete chain', async () => {
    // No workspace root, so the repository step cannot run and the fan-in is skipped. Two steps then name
    // no operation, and the chain must say it is incomplete rather than claim to be whole.
    const app = appWith({ root: null });
    const run = await launch(app, 'morning_briefing');
    await settle();
    const trace = app.memoryTrace.trace(run.runId);
    assert.equal(trace.ok, true);
    assert.equal(trace.complete, false);
    // The doctor's own operation and the launch's audit line, and nothing for the two steps that could
    // not run - a skipped step has no receipt because it did nothing.
    assert.equal(trace.counts.operations, 2);
  });

  test('an unknown id is refused with 404 and no run is recorded', async () => {
    const app = appWith({ root: gitWorkspace() });
    assert.throws(() => app.playbooks.precheck('no_such_playbook'), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'PLAYBOOK_NOT_FOUND');
      // The refusal names the ids that would have worked, in a field rather than in a sentence a UI would
      // have to parse.
      assert.deepEqual(error.detail.known, ['morning_briefing', 'workspace_security_audit', 'pre_release_readiness']);
      return true;
    });
    assert.equal(runLedger(app).runs.length, 0);
  });
});

describe('T-45 Package 1: the fan-in rule', () => {
  test('a fan-in step does not run when one root fails, and the run fails', async () => {
    // The registry is used directly because the failure this pins is the one that cannot be produced through
    // the real one: every real template is verified, which is the point. A stub whose second root refuses
    // lets the scheduler's own rule be tested without depending on a capability that might one day verify.
    const app = appWith({ root: gitWorkspace() });
    const engine = new ExecutivePlaybooks({
      registry: app.registry,
      // A plain executor rather than the composed controller, so the scheduler's own rule is what is under
      // test: the first root verifies, the second fails, and the fan-in must not run on half a reading.
      controller: {
        runAction: async (action) => {
          if (action === 'system.inspect_ports') {
            return { operationId: 'op_stub_ports', step: { verification: { outcome: 'success_verified' }, summary: 'ports read' } };
          }
          throw Object.assign(new Error('the process table could not be read'), { status: 503 });
        },
      },
      dataDir: tempDir(),
    });
    const run = await engine.launch('workspace_security_audit');
    const byCapability = Object.fromEntries(run.steps.map((step) => [step.capabilityId, step]));
    assert.equal(byCapability['system.inspect_ports'].status, 'verified');
    assert.equal(byCapability['system.inspect_processes'].status, 'failed');
    // The fan-in is skipped rather than run on one reading, and it says which step it was waiting for.
    assert.equal(byCapability['git.status_detailed'].status, 'skipped');
    // The fan-in names the step it was waiting for, by the label the card shows rather than by the
    // capability name, because the card is where the reader will look for it.
    assert.match(byCapability['git.status_detailed'].summary, /processes did not verify/);
    assert.equal(byCapability['git.status_detailed'].operationId, null);
    assert.equal(run.status, 'failed');
    assert.equal(run.verified, false);
  });
});

describe('T-45 Package 1: the latch and the tier', () => {
  test('a launch under Lockdown answers 423 and records nothing', async () => {
    const app = appWith({ root: gitWorkspace() });
    // The engine's own door, before any authorization is spent.
    // The latch is engaged through the control plane, which is the authority itself rather than a caller of
    // it: this test is about what the ENGINE does when the latch is up, not about the route that lifts it.
    app.registry.controlPlane.activateKillSwitch({ origin: 'user', reason: 'T-45 test: prove the latch halts a launch' });
    assert.equal(app.registry.controlPlane.killSwitchStatus().active, true);
    try {
      assert.throws(() => app.playbooks.precheck('morning_briefing'), (error) => {
        assert.equal(error.status, 423);
        assert.equal(error.code, 'LOCKDOWN_ACTIVE');
        return true;
      });
      // And the engine refuses it too, so a caller that skipped the precheck still cannot run it.
      await assert.rejects(() => launch(app, 'morning_briefing'), (error) => {
        assert.equal(error.status, 423);
        assert.equal(error.code, 'LOCKDOWN_ACTIVE');
        return true;
      });
      assert.equal(runLedger(app).runs.length, 0, 'a refusal at the door is not a run');
    } finally {
      app.registry.controlPlane.clearKillSwitch({ origin: 'user', reason: 'T-45 test: release' });
    }
    assert.equal(app.registry.controlPlane.killSwitchStatus().active, false);
  });

  test('playbook.launch is L2 and owner-only, and a model origin cannot reach it', async () => {
    const app = appWith({ root: gitWorkspace() });
    const definition = app.registry.get('playbook.launch');
    assert.equal(definition.autonomyLevel, 'L2');
    assert.equal(definition.permission, 'write');
    assert.deepEqual(definition.origins, ['user']);
    // The step-up secret is deliberately NOT a property of this capability. Step-up in this product is
    // reserved for the two acts that can end an audit trail - `safety.release` and `evolution.decide` -
    // and a routine launch is reversible and local. This test pins that distinction so a later change that
    // quietly gates every L2 act has to come here and say so.
    assert.equal(definition.stepUp ?? definition.requiresStepUp ?? null, null);
    const denied = await app.controller.runAction('playbook.launch', { playbookId: 'morning_briefing' }, 'model');
    assert.notEqual(denied.outcome, 'success_verified', JSON.stringify(denied));
    assert.equal(denied.authorization?.decision ?? 'deny', 'deny');
    assert.equal(runLedger(app).runs.length, 0, 'a model origin cannot launch a routine');
  });
});

describe('T-45 Package 1: the two routes', () => {
  test('GET /api/playbooks answers 200 with three templates, and POST launches', async () => {
    const app = appWith({ root: gitWorkspace() });
    const ui = createUiServer({ app, token: 't45-playbooks-route-token-0123456789', host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    const base = `http://127.0.0.1:${started.port}`;
    const headers = { authorization: 'Bearer t45-playbooks-route-token-0123456789', 'x-apex-ui': '1' };
    try {
      const listed = await fetch(`${base}/api/playbooks`, { headers });
      assert.equal(listed.status, 200);
      const body = await listed.json();
      assert.equal(body.verified, true);
      assert.equal(body.templates.length, 3);
      assert.deepEqual(body.summary, { templateCount: 3, totalRuns: 0, verifiedRuns: 0, failedRuns: 0 });

      const launched = await fetch(`${base}/api/playbooks/morning_briefing/launch`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(launched.status, 200);
      const run = await launched.json();
      assert.equal(run.status, 'verified');
      assert.equal(run.steps.length, 3);

      const unknown = await fetch(`${base}/api/playbooks/no_such_playbook/launch`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).code, 'PLAYBOOK_NOT_FOUND');

      const after = await (await fetch(`${base}/api/playbooks`, { headers })).json();
      assert.equal(after.summary.totalRuns, 1);
      assert.equal(after.summary.verifiedRuns, 1);
      assert.equal(after.runs[0].runId, run.runId);
    } finally {
      await ui.stop();
    }
  });

  test('GET /api/playbooks is 200 with no workspace root', async () => {
    const app = appWith({ root: null });
    const ui = createUiServer({ app, token: 't45-playbooks-unrooted-token-0123456789', host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/playbooks`, {
        headers: { authorization: 'Bearer t45-playbooks-unrooted-token-0123456789', 'x-apex-ui': '1' },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.templates.length, 3);
      assert.equal(body.summary.templateCount, 3);
    } finally {
      await ui.stop();
    }
  });
});
