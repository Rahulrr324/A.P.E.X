// T-38 Step 1: the safety metadata and the deterministic candidate resolver.
//
// The subject of this suite is a single claim: the Values & Constraints Core evaluates a candidate
// from facts the registry really holds, and says `unverifiable` only when there is genuinely nothing
// to read. Before T-38 the second half of that was true for the wrong reason - *nothing* declared
// reversibility - and the tests below pin both halves so a future default cannot quietly satisfy a
// rule that was never checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import {
  BLAST_RADIUS_KINDS, BLAST_RADIUS_MEANING, REVERSIBILITY_KINDS, REVERSIBILITY_MEANING,
  contradictoryDeclaration, safetyDeclarations,
} from '../src/actions/safety-metadata.js';
import { resolveCandidateCapabilities, RESOLVER_SCHEMA } from '../src/council/candidate-resolver.js';
import { evaluateConstraints } from '../src/council/values-core.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t38-values-'));
}

function withApp(fn, { workspace = false } = {}) {
  const dir = tempDir();
  // T-43 Package 1: some capabilities are conditional on the build having a workspace root - the git
  // executive's four, and the filesystem actions. A check that asks whether a declaration matches a
  // registration has to say which build it means, so the root is opt-in rather than implied: a test
  // that does not ask for one keeps the narrower registry it was written against.
  const root = workspace ? path.join(dir, 'workspace') : null;
  if (root) fs.mkdirSync(root, { recursive: true });
  try {
    return fn(createApp(root ? { dataDir: dir, filesystemRoot: root } : { dataDir: dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// ------------------------------------------------------------------------------------ vocabulary ---

test('T-38 metadata: the two vocabularies are closed and every kind is explained', () => {
  assert.deepEqual([...REVERSIBILITY_KINDS], ['read_only', 'reversible', 'compensatable', 'irreversible']);
  // T-39 Step 1 adds `workspace_fs` in the position it belongs in: after the sandbox kind and before
  // the system-wide latch. It is a separate word because `workspace_sandbox` means "never the live
  // workspace tree", and a T-39 apply is exactly that tree. The list stays closed and pinned; it is
  // this test's job to make a new member a deliberate act rather than a side effect.
  // T-43 Package 1 adds `local_state` in the position it belongs in: after `local_store` and before
  // the workspace kinds. It is a separate word because `local_store` means APEX's own data directory
  // and `workspace_fs` means the owner's tracked files, while a git status read, a diff read or a
  // checkpoint create touches neither: the first two change nothing at all, and the third writes a ref
  // and a ledger record without modifying the working tree or the index. Naming it `local_store` would
  // understate where the ref lives; naming it `workspace_fs` would overstate what it changes. The list
  // stays closed and pinned, and adding a member here is a deliberate act.
  assert.deepEqual([...BLAST_RADIUS_KINDS], ['none', 'session', 'local_store', 'local_state', 'workspace_sandbox', 'workspace_fs', 'system_latch']);
  // A vocabulary whose words are not defined is a vocabulary a reader has to guess at.
  for (const kind of REVERSIBILITY_KINDS) {
    assert.equal(typeof REVERSIBILITY_MEANING[kind], 'string', `${kind} has no stated meaning`);
    assert.ok(REVERSIBILITY_MEANING[kind].length > 20, `${kind}'s meaning is too short to be useful`);
  }
  for (const kind of BLAST_RADIUS_KINDS) {
    assert.equal(typeof BLAST_RADIUS_MEANING[kind], 'string', `${kind} has no stated meaning`);
    assert.ok(BLAST_RADIUS_MEANING[kind].length > 20, `${kind}'s meaning is too short to be useful`);
  }
});

test('T-38 metadata: the registry refuses a declaration outside the vocabulary', () => {
  withApp((app) => {
    const base = {
      description: 'a probe capability', permission: 'read', origins: ['user', 'model'],
      plannable: true, validate: () => ({}), execute: () => ({}),
    };
    assert.throws(
      () => app.registry.register({ ...base, name: 'probe.bad_reversibility', reversibility: 'mostly_reversible' }),
      /reversibility must be one of/,
    );
    assert.throws(
      () => app.registry.register({ ...base, name: 'probe.bad_radius', blastRadius: 'galaxy' }),
      /blastRadius must be one of/,
    );
    // And a valid one is accepted, so the check is a filter rather than a wall.
    app.registry.register({ ...base, name: 'probe.good', reversibility: 'read_only', blastRadius: 'none' });
    assert.equal(app.registry.get('probe.good').reversibility, 'read_only');
  });
});

test('T-38 metadata: no declaration contradicts itself', () => {
  for (const { name, reversibility, blastRadius } of safetyDeclarations()) {
    const problem = contradictoryDeclaration(reversibility, blastRadius);
    assert.equal(problem, null, `${name}: ${problem}`);
  }
});

// ------------------------------------------------------------------------------------ coverage ---

test('T-38 metadata: every registered capability declares reversibility and blast radius', () => {
  withApp((app) => {
    const list = app.registry.list();
    assert.ok(list.length >= 159, `expected at least the 159 T-37 capabilities, got ${list.length}`);
    const undeclared = list.filter((d) => !d.reversibility || !d.blastRadius).map((d) => d.name);
    assert.deepEqual(undeclared, [], `capabilities with no safety metadata: ${undeclared.join(', ')}`);
    // The vocabulary is what the registry validated against, so nothing here can be off-list.
    for (const definition of list) {
      assert.ok(REVERSIBILITY_KINDS.includes(definition.reversibility), `${definition.name}: ${definition.reversibility}`);
      assert.ok(BLAST_RADIUS_KINDS.includes(definition.blastRadius), `${definition.name}: ${definition.blastRadius}`);
    }
  });
});

test('T-38 metadata: every write declares a blast radius that is not none', () => {
  withApp((app) => {
    const writes = app.registry.list().filter((d) => d.permission === 'write');
    // T-37 measured 80 writes. T-38 Step 2 adds the three sandbox writes - stage, verify and
    // promote - each of which declares `workspace_sandbox`, so the count was 83. T-39 Step 1 adds the
    // two writes that reach the live tree, `workshop.apply_file` and `workshop.rollback_file`, so it
    // is 85. T-40 Step 2 adds the two batch writes, `workshop.apply_changeset` and
    // `workshop.rollback_changeset`, both declaring `workspace_fs`, so it is 87. The number is pinned
    // rather than bounded so that a new write cannot arrive without someone deciding this question -
    // which is exactly what happened here.
    // T-41 Step 3 (2026-11-22) adds one, `evolution.stage_to_workshop`, which declares
    // `workspace_sandbox`: it writes inside the sandbox and appends one lab event, never the live tree.
    // T-44 Package 1 (2026-11-19) adds four: the standing-order ledger writes `create`, `toggle` and
    // `revoke`, and the run `invoke`, all declaring `local_state`. Each one is pinned here on purpose -
    // `local_state` is the declaration that lets a capability be delegated at all, so a new write that
    // claims it has to be looked at by a person rather than absorbed by a bound.
    // T-44 Package 2 adds three more: `agenda.create`, `.complete` and `.dismiss`, all `local_state`.
    // `agenda.list` is a read and does not count here.
    // T-45 Packages 1 and 2 add five writes: `playbook.launch`, and `watchpoint.create`, `.toggle`,
  // `.delete` and `.evaluate`. Every one of them declares a blast radius; `.evaluate` is a write because
  // it records the readings it took, and its radius is the watchpoint ledger.
  assert.equal(writes.length, 100, `expected 100 writes after T-45 Packages 1 and 2, got ${writes.length}`);
    for (const definition of writes) {
      assert.notEqual(definition.blastRadius, 'none',
        `${definition.name} is a write that claims to change nothing`);
    }
  });
});

test('T-38 metadata: every declaration names a capability the registry actually holds', () => {
  // T-43 Package 1: the four git capabilities register only when the build has a workspace root, so the
  // app checked here is built the way every deployment is built - with a workspace. Checking an app with
  // no root would report those four declarations as stale when in fact they are registered wherever a
  // repository can exist. The check itself is unchanged, and it is still the one that catches a
  // declaration for a name nobody registered.
  withApp((app) => {
    const names = new Set(app.registry.list().map((d) => d.name));
    const stale = safetyDeclarations().filter((entry) => !names.has(entry.name)).map((entry) => entry.name);
    assert.deepEqual(stale, [], `declarations naming no registered capability: ${stale.join(', ')}`);
  }, { workspace: true });
});

test('T-38 metadata: the capabilities the brief names declare accurate facts', () => {
  withApp((app) => {
    const expectations = [
      // name, permission, reversibility, blastRadius
      ['neural.step', 'write', 'reversible', 'local_store'],
      ['perception.sense_host', 'write', 'reversible', 'local_store'],
      ['briefing.acknowledge', 'write', 'reversible', 'local_store'],
      ['council.deliberate', 'read', 'reversible', 'local_store'],
      ['workshop.verify', 'write', 'reversible', 'local_store'],
      ['workshop.promote', 'write', 'reversible', 'local_store'],
      ['presence.handoff.stage', 'write', 'reversible', 'local_store'],
      ['presence.handoff.claim', 'write', 'reversible', 'session'],
      ['safety.lockdown', 'write', 'reversible', 'system_latch'],
      ['safety.release', 'write', 'reversible', 'system_latch'],
    ];
    for (const [name, permission, reversibility, blastRadius] of expectations) {
      const definition = app.registry.get(name);
      assert.ok(definition, `${name} must be registered`);
      assert.equal(definition.permission, permission, `${name} permission`);
      assert.equal(definition.reversibility, reversibility, `${name} reversibility`);
      assert.equal(definition.blastRadius, blastRadius, `${name} blastRadius`);
    }
  });
});

test('T-38 metadata: a definition may state its own facts and the overlay keeps them', () => {
  withApp((app) => {
    // `safety.lockdown` is declared in the overlay; nothing overrides it here, but a capability that
    // sets its own values must win over the defaulting layer, or the layer would be an override
    // pretending to be a default.
    app.registry.register({
      name: 'probe.self_declared',
      description: 'a probe that declares its own safety facts',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      reversibility: 'irreversible',
      blastRadius: 'workspace_sandbox',
      validate: () => ({}),
      execute: () => ({}),
    });
    const definition = app.registry.get('probe.self_declared');
    assert.equal(definition.reversibility, 'irreversible');
    assert.equal(definition.blastRadius, 'workspace_sandbox');
    assert.equal(definition.metadataSource, 'declared');
  });
});

// ------------------------------------------------------------------------------------ resolver ---

test('T-38 resolver: an exact capability id resolves without consulting the router', () => {
  withApp((app) => {
    const result = resolveCandidateCapabilities('neural.step', { registry: app.registry });
    assert.equal(result.schema, RESOLVER_SCHEMA);
    assert.equal(result.kind, 'capability_id');
    assert.equal(result.candidate.id, 'neural.step');
    assert.equal(result.deterministic, true);
    // Determinism stated as a fact, not a promise.
    assert.equal(result.usedInference, false);
  });
});

test('T-38 resolver: the router is the authority when it resolves the sentence', () => {
  withApp((app) => {
    const result = resolveCandidateCapabilities('remember that the launch moved to friday', { registry: app.registry });
    assert.equal(result.kind, 'router_action');
    assert.equal(result.candidate.id, 'memory.add');
    assert.match(result.reason, /router resolves this sentence to memory\.add/);
  });
});

test('T-38 resolver: a sentence naming a registered capability resolves by exact name', () => {
  withApp((app) => {
    const neural = resolveCandidateCapabilities('run the neural step now', { registry: app.registry });
    assert.equal(neural.kind, 'registry_name');
    assert.equal(neural.candidate.id, 'neural.step');

    // "verify" is a check, so it prefers the check over the store it names.
    const verify = resolveCandidateCapabilities('verify the workshop', { registry: app.registry });
    assert.equal(verify.kind, 'registry_name');
    assert.equal(verify.candidate.id, 'workshop.verify');
  });
});

test('T-38 resolver: the resolver is deterministic across repeated calls', () => {
  withApp((app) => {
    const objective = 'check the workshop and run the neural step';
    const first = resolveCandidateCapabilities(objective, { registry: app.registry });
    for (let i = 0; i < 5; i += 1) {
      const again = resolveCandidateCapabilities(objective, { registry: app.registry });
      assert.deepEqual(again, first, 'the same sentence must resolve identically every time');
    }
  });
});

test('T-38 resolver: a sentence naming nothing registered reports no_mapped_capability', () => {
  withApp((app) => {
    for (const objective of ['make me a sandwich', 'arrange flowers for the office', 'x']) {
      const result = resolveCandidateCapabilities(objective, { registry: app.registry });
      assert.equal(result.kind, 'none', `${objective} should resolve to nothing`);
      assert.equal(result.reason, 'no_mapped_capability', `${objective} should say why`);
      assert.equal(result.candidate, null);
      assert.deepEqual(result.capabilities, []);
      assert.match(result.detail, /names no registered capability/);
    }
  });
});

test('T-38 resolver: an empty objective is refused rather than answered', () => {
  withApp((app) => {
    const result = resolveCandidateCapabilities('   ', { registry: app.registry });
    assert.equal(result.kind, 'none');
    assert.equal(result.reason, 'empty_objective');
  });
});

test('T-38 resolver: a resolver without a registry never invents a candidate', () => {
  const result = resolveCandidateCapabilities('run the neural step', {});
  assert.equal(result.kind, 'none');
  assert.equal(result.candidate, null);
});

// ------------------------------------------------------------- the qualifier, closed end to end ---

test('T-38 core: a live deliberation of a resolved capability is satisfied, not partly unverifiable', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    // The sentence names `neural.step` without saying so. Before T-38 this deliberation reported
    // `partly_unverifiable` because the resolver did not exist and nothing declared reversibility.
    const result = await app.controller.runAction('council.deliberate', {
      objective: 'run the neural step',
    }, 'user', 'op-t38-resolved');
    assert.equal(result.outcome, 'success_verified', JSON.stringify(result.verification));

    const positions = result.result.data.positions;
    assert.equal(positions.length, 8);
    const core = positions.find((p) => p.perspectiveId === 'constraint_check');
    assert.ok(core, 'the constraint core must be the eighth position');
    assert.equal(core.position.verdict, 'satisfied', JSON.stringify(core.evaluation.counts));
    assert.deepEqual(core.evaluation.counts, { satisfied: 5, violated: 0, unverifiable: 0, not_applicable: 1 });
    assert.equal(core.evaluation.overall, 'satisfied');

    // The verdict came from the declaration, and the declaration is readable in the session record.
    const reversibilityRule = core.evaluation.evaluations.find((e) => e.id === 'irreversible-needs-the-owner');
    assert.equal(reversibilityRule.verdict, 'satisfied');
    assert.match(reversibilityRule.detail, /is declared reversible/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-38 core: a deliberation that maps to nothing states no_mapped_capability', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    const result = await app.controller.runAction('council.deliberate', {
      objective: 'arrange flowers for the office',
    }, 'user', 'op-t38-unmapped');
    assert.equal(result.outcome, 'success_verified');

    const core = result.result.data.positions.find((p) => p.perspectiveId === 'constraint_check');
    // The honesty rule: an unmapped proposal is never quietly satisfied.
    assert.notEqual(core.position.verdict, 'satisfied');
    for (const rule of ['no-model-authored-write', 'no-unplannable-in-a-plan', 'irreversible-needs-the-owner']) {
      const entry = core.evaluation.evaluations.find((e) => e.id === rule);
      assert.equal(entry.verdict, 'unverifiable', `${rule} must not claim to have checked anything`);
      assert.match(entry.detail, /no_mapped_capability/, `${rule} must name the reason`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-38 core: an explicit candidate still wins over the resolver', async () => {
  const dir = tempDir();
  try {
    const app = createApp({ dataDir: dir });
    // The sentence would resolve to `memory.add` through the router; the explicit candidateId names
    // the capability the owner actually asked about, and that must be what is evaluated.
    const result = await app.controller.runAction('council.deliberate', {
      objective: 'remember the release checklist and check neural.step',
      candidateId: 'neural.step',
    }, 'user', 'op-t38-explicit');
    const core = result.result.data.positions.find((p) => p.perspectiveId === 'constraint_check');
    const writeRule = core.evaluation.evaluations.find((e) => e.id === 'no-model-authored-write');
    assert.match(writeRule.detail, /neural\.step/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
