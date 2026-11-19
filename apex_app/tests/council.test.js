// T-26 Council tests. The package is ESM ("type": "module"), so this file uses top-level
// imports only. Every fixture is synthetic and local; no model is contacted and no user data
// is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { CouncilService } from '../src/council/service.js';
import { CouncilStore } from '../src/council/store.js';
import { executeAction } from '../src/actions/executor.js';
import {
  evaluatePerspective, PERSPECTIVES, classifyDisagreement, synthesize, parseObjective, buildEvidenceSet,
} from '../src/council/index.js';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('council parseObjective rejects empty and control chars', () => {
  assert.deepEqual(parseObjective(''), { valid: false, error: 'objective is required' });
  assert.deepEqual(parseObjective('   '), { valid: false, error: 'objective is required' });
  assert.deepEqual(parseObjective('\x00bad'), { valid: false, error: 'objective contains control characters' });
  assert.deepEqual(parseObjective('deploy the release'), { valid: true, objective: 'deploy the release' });
});

test('council evidence set separates current, contradicting, supporting', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const evidence = [
    { evidenceId: 'e1', source: 'memory', claim: 'a', current: true, relation: 'supporting', trust: 'user_statement' },
    { evidenceId: 'e2', source: 'knowledge', claim: 'b', current: false, relation: 'historical', trust: 'user_confirmed' },
    { evidenceId: 'e3', source: 'conflict', claim: 'c', current: true, relation: 'contradicting', trust: 'derived' },
  ];
  const set = buildEvidenceSet({ evidence, now: () => now });
  assert.equal(set.currentCount, 2);
  assert.equal(set.contradicting.length, 1);
  assert.equal(set.supporting.length, 1);
  assert.equal(set.count, 3);
});

test('council perspectives produced for a simple objective', () => {
  const positions = PERSPECTIVES.map((p) => evaluatePerspective(p, {
    objective: { text: 'finish the migration by Friday' },
    evidence: [
      { evidenceId: 'e1', source: 'memory', claim: 'migration runs weekly', current: true, relation: 'supporting', trust: 'user_statement' },
    ],
    candidate: { id: 't1', action: 'filesystem.copy', description: 'copy migration data' },
    capability: { name: 'filesystem.copy', permission: 'write', origins: ['user'], risk: 'low', delegable: true, sideEffect: 'append', reversibility: 'correctable' },
    resourceContext: { cpuMillis: 5000, memoryBytes: 256_000_000 },
    taskRecord: { steps: [{ status: 'completed' }, { status: 'pending' }] },
  }));
  assert.ok(positions.length === PERSPECTIVES.length);
  assert.equal(positions[0].perspectiveId, 'objective_alignment');
  assert.ok(positions.some((p) => p.perspectiveId === 'evidence_quality'));
  assert.ok(positions.some((p) => p.perspectiveId === 'safety_policy'));
});

test('council disagreement classification', () => {
  const agree = [
    { perspectiveId: 'a', status: 'position', position: { verdict: 'within_policy' } },
    { perspectiveId: 'b', status: 'position', position: { verdict: 'within_policy' } },
  ];
  assert.deepEqual(classifyDisagreement(agree), { kind: 'agreement', detail: 'all evaluators report within_policy' });

  const noPos = [
    { perspectiveId: 'a', status: 'insufficient_input', missing: ['evidence'] },
  ];
  assert.deepEqual(classifyDisagreement(noPos), { kind: 'no_positions', detail: 'no evaluator produced a position' });

  const mixed = [
    { perspectiveId: 'a', status: 'position', position: { verdict: 'risk_flag' } },
    { perspectiveId: 'b', status: 'position', position: { verdict: 'undetermined' } },
  ];
  assert.equal(classifyDisagreement(mixed).kind, 'partial_agreement');
});

test('council synthesis never authorizes execution', () => {
  const evidence = [
    { evidenceId: 'e1', source: 'memory', claim: 'done', current: true, relation: 'supporting', trust: 'user_statement' },
  ];
  const positions = [
    { perspectiveId: 'objective_alignment', perspectiveName: 'Objective alignment', status: 'position', position: { verdict: 'strong_alignment', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'evidence_quality', perspectiveName: 'Evidence quality', status: 'position', position: { verdict: 'adequate', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'safety_policy', perspectiveName: 'Safety and policy', status: 'position', position: { verdict: 'within_policy', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'resource_feasibility', perspectiveName: 'Resource feasibility', status: 'position', position: { verdict: 'declared_only', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'operational_reliability', perspectiveName: 'Operational reliability', status: 'position', position: { verdict: 'completed_steps', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'temporal_consequences', perspectiveName: 'Temporal consequences', status: 'position', position: { verdict: 'no_temporal_signal', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
    { perspectiveId: 'long_term_implications', perspectiveName: 'Long-term implications', status: 'position', position: { verdict: 'neutral', evidence: [], assumptions: [], limitations: [], uncertainty: null }, assumptions: [], limitations: [], method: '', notes: [] },
  ];
  const disagreement = { kind: 'agreement', detail: 'all evaluators report within_policy' };
  const evidenceSet = {
    items: evidence, current: evidence, contradicting: [], currentCount: 1, count: 1,
    bySource: new Map([['memory', evidence]]),
  };
  const synthesis = synthesize({ objective: { text: 'do the thing', valid: true }, positions, disagreement, evidence: evidenceSet, candidate: null });
  assert.equal(synthesis.authorizesExecution, false);
  assert.equal(synthesis.synthesis.recommendedOption.level, 'supported');
  assert.deepEqual(synthesis.synthesis.requiredApprovals, ['user_authorization_for_execution']);
});

test('council store append-only session persistence', async () => {
  const dir = await tempDir('apex-council-test-');
  try {
    const store = new CouncilStore(join(dir, 'council.jsonl'), { now: () => new Date('2026-01-01T00:00:00Z') });
    const session = {
      schema: 'apex.council.v1',
      kind: 'session',
      sessionId: 'cs-test-1',
      objective: 'test objective',
      at: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      authorizesExecution: false,
    };
    await store.append(session);
    const list = await store.list({ limit: 5 });
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].sessionId, 'cs-test-1');
    const found = await store.get('cs-test-1');
    assert.equal(found.found, true);
    assert.equal(found.session.status, 'completed');
    assert.equal(found.session.authorizesExecution, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('council service deliberation and verification determinism', async () => {
  const dir = await tempDir('apex-council-svc-');
  try {
    const app = createApp({ dataDir: dir, now: () => new Date('2026-01-01T00:00:00Z') });
    const evidence = [
      { evidenceId: 'e1', source: 'memory', claim: 'migration data copied', current: true, relation: 'supporting', trust: 'user_statement' },
      { evidenceId: 'e2', source: 'knowledge', claim: 'migration runs weekly', current: true, relation: 'supporting', trust: 'user_confirmed' },
    ];
    const result = await app.council.deliberate({
      objective: 'finish the migration by Friday',
      evidence,
      candidate: { id: 't1', action: 'filesystem.copy', description: 'copy migration data' },
      resourceContext: { cpuMillis: 5000, memoryBytes: 256_000_000 },
      taskRecord: { steps: [{ status: 'completed' }, { status: 'pending' }] },
    });
    assert.equal(result.synthesis.authorizesExecution, false);
    assert.ok(typeof result.disagreement.kind === 'string' && result.disagreement.kind.length > 0);
    assert.ok(result.synthesis.synthesis.recommendedOption.level);
    // Determinism: re-running with same inputs produces same session id and level.
    const result2 = await app.council.deliberate({
      objective: 'finish the migration by Friday',
      evidence,
      candidate: { id: 't1', action: 'filesystem.copy', description: 'copy migration data' },
      resourceContext: { cpuMillis: 5000, memoryBytes: 256_000_000 },
      taskRecord: { steps: [{ status: 'completed' }, { status: 'pending' }] },
    });
    assert.equal(result.session.sessionId, result2.session.sessionId);
    assert.equal(result.synthesis.synthesis.recommendedOption.level, result2.synthesis.synthesis.recommendedOption.level);
    const list = await app.council.list({ limit: 10 });
    assert.ok(list.sessions.length >= 1);
    assert.equal(list.sessions[0].sessionId, result.session.sessionId);
    // Replay is genuine: it recomputes from the recorded input.
    const replay = await app.council.replay(result.session.sessionId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.match, true, replay.detail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('council action requires objective text', async () => {
  const dir = await tempDir('apex-council-action-');
  try {
    const app = createApp({ dataDir: dir, now: () => new Date('2026-01-01T00:00:00Z') });
    const def = app.registry.get('council.deliberate');
    assert.ok(def, 'council.deliberate is registered');
    const outcome = await executeAction(def, app, { evidence: [] });
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.error.message, /objective/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
