// T-30 Package 1: keep the ten-state Core vocabulary, authority table and served UI setter aligned.
// Reserved states cannot be assigned by production UI code; an invalid request degrades safely.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { UI_CLIENT } from '../src/ui/assets.js';
import {
  CORE_REACHABLE_STATES,
  CORE_RESERVED_STATES,
  CORE_STATE_DEFINITIONS,
  CORE_STATE_PRECEDENCE,
  assertReachableCoreState,
  isReachableCoreState,
  resolveCoreState,
} from '../src/ui/core-state.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(APP_ROOT, 'ARCHITECTURE_V2.md');
const EXPECTED_LABELS = [
  'Dormant', 'Idle', 'Listening', 'Thinking', 'Speaking',
  'Executing', 'Awaiting Approval', 'Uncertain', 'Degraded', 'Lockdown',
];
const EXPECTED_PRECEDENCE = [
  'lockdown', 'degraded', 'awaiting_approval', 'uncertain', 'executing', 'thinking', 'idle',
];

function embeddedJson(name) {
  const prefix = `const ${name} = `;
  const start = UI_CLIENT.indexOf(prefix);
  assert.notEqual(start, -1, `${name} is embedded in the served client`);
  const valueStart = start + prefix.length;
  const end = UI_CLIENT.indexOf(';\n', valueStart);
  assert.notEqual(end, -1, `${name} has a complete JSON literal`);
  return JSON.parse(UI_CLIENT.slice(valueStart, end));
}

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `served client includes ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${signature} has a closing brace`);
}

function parseCurrentStateTable(markdown) {
  const heading = '## T-30 current Core-state source and precedence contract (2026-11-19)';
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, 'the dated current Core-state table is present');
  const nextHeading = markdown.indexOf('\n### State ownership register', start);
  const section = markdown.slice(start, nextHeading < 0 ? undefined : nextHeading);
  return section.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| State |') && !line.startsWith('|---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4);
}

describe('T-30 Core state ownership and reachability contract', () => {
  test('the dated architecture table matches all ten code-defined states', () => {
    const markdown = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const table = parseCurrentStateTable(markdown);
    assert.equal(table.length, 10, 'the Core has exactly ten named states');
    assert.deepEqual(table.map(([label]) => label), EXPECTED_LABELS);
    assert.deepEqual(CORE_STATE_DEFINITIONS.map((state) => state.label), EXPECTED_LABELS);

    const byLabel = new Map(CORE_STATE_DEFINITIONS.map((state) => [state.label, state]));
    for (const [label, source, precedence, reachability] of table) {
      const state = byLabel.get(label);
      assert.ok(state, `${label} has a code definition`);
      assert.ok(source.length > 0, `${label} has an explicit source statement, including reserved states`);
      const isReserved = reachability.toLowerCase().includes('reserved, not reachable');
      assert.equal(isReserved, state.reachability !== 'reachable', `${label} reachability agrees with the table`);
      assert.equal(precedence, state.precedence === null ? '—' : String(state.precedence), `${label} precedence agrees with the table`);
      if (state.reachability === 'reachable') assert.ok(state.source, `${label} has a real source`);
      else assert.equal(state.source, null, `${label} has no source and stays reserved`);
    }

    assert.match(markdown.slice(markdown.indexOf('### State ownership register'), markdown.indexOf('The T-30 implementation evidence')),
      /TaskStore|PlanStore|ExecutiveControlPlane|RuntimeStateStore|collectHealth/,
      'the architecture names concrete owners for task, plan, approval, lockdown, runtime and health');
  });

  test('the precedence order is explicit and all reachable states have unique ranks', () => {
    assert.deepEqual(CORE_STATE_PRECEDENCE, EXPECTED_PRECEDENCE);
    assert.deepEqual(CORE_REACHABLE_STATES, EXPECTED_PRECEDENCE);
    const ranks = CORE_STATE_DEFINITIONS
      .filter((state) => state.reachability === 'reachable')
      .map((state) => state.precedence);
    assert.deepEqual([...ranks].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    for (const state of CORE_RESERVED_STATES) {
      assert.equal(isReachableCoreState(state), false);
      assert.throws(() => assertReachableCoreState(state), /reserved or unknown and cannot be set/);
    }
    assert.equal(isReachableCoreState('future_state'), false);
    assert.throws(() => assertReachableCoreState('future_state'), /reserved or unknown and cannot be set/);
  });

  test('overlapping source conditions resolve using Lockdown-first fail-closed precedence', () => {
    const ready = {
      lockdown: 'clear',
      authoritativeStateAvailable: true,
      healthAvailable: true,
      eventStreamAvailable: true,
    };
    assert.equal(resolveCoreState({ ...ready, lockdown: 'active', degraded: true, pendingApproval: true }), 'lockdown');
    assert.equal(resolveCoreState({ ...ready, healthAvailable: false, pendingApproval: true, executing: true }), 'degraded');
    assert.equal(resolveCoreState({ ...ready, pendingApproval: true, uncertain: true, executing: true, thinking: true }), 'awaiting_approval');
    assert.equal(resolveCoreState({ ...ready, uncertain: true, executing: true, thinking: true }), 'uncertain');
    assert.equal(resolveCoreState({ ...ready, executing: true, thinking: true }), 'executing');
    assert.equal(resolveCoreState({ ...ready, thinking: true, idleReady: true }), 'thinking');
    assert.equal(resolveCoreState({ ...ready, idleReady: true }), 'idle');
    assert.equal(resolveCoreState({ ...ready, idleReady: false }), 'degraded', 'an unknown/empty snapshot is never treated as Idle');
    assert.equal(resolveCoreState({ ...ready, lockdown: 'unavailable', idleReady: true }), 'degraded', 'an unreadable latch is never treated as unlocked');
  });

  test('the actual served setter refuses Dormant, Listening, Speaking and unknown states', () => {
    assert.deepEqual(embeddedJson('CORE_STATE_DEFINITIONS'), CORE_STATE_DEFINITIONS);
    assert.deepEqual(embeddedJson('CORE_REACHABLE_STATES'), CORE_REACHABLE_STATES);
    const setter = functionSource(UI_CLIENT, 'function setCore(next, caption)');
    assert.match(setter, /!CORE_REACHABLE_STATES\.includes\(next\)/);
    assert.match(setter, /reachability === 'reachable'/);

    for (const requested of [...CORE_RESERVED_STATES, 'invented']) {
      const sandbox = {
        CORE_STATE_DEFINITIONS,
        CORE_REACHABLE_STATES,
        state: { core: 'idle' },
        document: { body: { dataset: { coreState: 'idle' } } },
        els: { coreState: { textContent: '' }, coreCaption: { textContent: '' } },
      };
      vm.runInNewContext(`${setter}\nsetCore(${JSON.stringify(requested)}, 'test');`, sandbox);
      assert.equal(sandbox.state.core, 'degraded', `${requested} is not displayed`);
      assert.equal(sandbox.document.body.dataset.coreState, 'degraded', `${requested} cannot reach the rendered state`);
      assert.equal(sandbox.els.coreState.textContent, 'Degraded');
    }

    const sandbox = {
      CORE_STATE_DEFINITIONS,
      CORE_REACHABLE_STATES,
      state: { core: 'degraded' },
      document: { body: { dataset: { coreState: 'degraded' } } },
      els: { coreState: { textContent: '' }, coreCaption: { textContent: '' } },
    };
    vm.runInNewContext(`${setter}\nsetCore('awaiting_approval', 'pending');`, sandbox);
    assert.equal(sandbox.state.core, 'awaiting_approval');
    assert.equal(sandbox.els.coreState.textContent, 'Awaiting Approval');
  });
});
