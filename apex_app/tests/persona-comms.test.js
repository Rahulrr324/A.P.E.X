// T-33 Step 2 (2026-11-19): the Persona and Executive Comms formatter.
//
// The promise this file pins is narrow and absolute: five voices, one set of facts, and no wit at
// all the moment anything is wrong. The facts are supplied by the caller - the formatter invents
// none - so a wording change here can never change a number or an outcome.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXEC_MODES, PERSONAS, WIT_MARKERS,
  composeAllFramings, composeExecutiveComms, readSignals, witMarkersIn,
} from '../src/cognition/persona-comms.js';

const HEALTHY_FACTS = Object.freeze([
  { key: 'core', label: 'Core', value: 'idle' },
  { key: 'approvals', label: 'Approvals', value: 'none pending' },
  { key: 'perception', label: 'Perception', value: '12 observed · 0 unavailable' },
  { key: 'resources', label: 'Resources', value: 'CPU 4 logical · load 0.21 · memory 41% used' },
  { key: 'devices', label: 'Devices', value: 'no device is enrolled' },
]);
const HEALTHY_SIGNALS = Object.freeze({ coreState: 'idle', approvals: 0, alerts: [], lockdown: false });

describe('the five framings', () => {
  test('every mode produces its own persona, framing and wording', () => {
    const all = composeAllFramings({ facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    assert.deepEqual(Object.keys(all.framings), [...EXEC_MODES]);
    const headlines = new Set();
    for (const mode of EXEC_MODES) {
      const framing = all.framings[mode];
      assert.equal(framing.mode, mode);
      assert.equal(framing.persona, PERSONAS[mode].persona);
      assert.ok(framing.headline.length > 0, `${mode} has a headline`);
      headlines.add(framing.headline);
    }
    assert.equal(headlines.size, EXEC_MODES.length, 'no two modes say the same thing');
    // The shapes the product promised: FRIDAY is action/status/gate, Vision separates the three
    // epistemic categories, Her is one line, EDITH speaks about the perimeter, JARVIS synthesises.
    assert.deepEqual(all.framings.tactical.lines.slice(0, 3).map((entry) => entry.label), ['Action', 'Status', 'Next Gate']);
    assert.deepEqual(all.framings.synthesis.lines.slice(0, 3).map((entry) => entry.label), ['Observed', 'Inferred', 'Open risk']);
    assert.equal(all.framings.quiet.lines.length, 0, 'the quiet voice is a single calm line');
    assert.ok(all.framings.overwatch.lines.some((entry) => entry.label === 'Perimeter'));
    assert.match(all.framings.overwatch.lines.find((entry) => entry.label === 'Authority').value, /authorizes nothing/);
  });

  test('the same facts reach every framing unchanged', () => {
    const all = composeAllFramings({ facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    const tactical = all.framings.tactical.lines.map((entry) => `${entry.label}: ${entry.value}`).join(' | ');
    const overwatch = all.framings.overwatch.lines.map((entry) => `${entry.label}: ${entry.value}`).join(' | ');
    assert.match(tactical, /no device is enrolled/);
    assert.match(overwatch, /no device is enrolled/);
    assert.match(overwatch, /CPU 4 logical · load 0\.21 · memory 41% used/);
    const synthesis = all.framings.synthesis.lines.find((entry) => entry.label === 'Observed').value;
    assert.match(synthesis, /Perception: 12 observed · 0 unavailable/);
  });

  test('an absent fact is reported as unavailable, never invented', () => {
    const all = composeAllFramings({ facts: [], signals: { coreState: 'idle' } });
    const action = all.framings.tactical.lines.find((entry) => entry.label === 'Action');
    assert.equal(action.value, 'unavailable');
    const resources = all.framings.overwatch.lines.find((entry) => entry.label === 'Resources');
    assert.equal(resources.value, 'unavailable');
    assert.match(all.framings.synthesis.lines.find((entry) => entry.label === 'Observed').value, /nothing observed is recorded/);
  });

  test('composition is deterministic', () => {
    const once = composeExecutiveComms({ mode: 'synthesis', facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    const twice = composeExecutiveComms({ mode: 'synthesis', facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    assert.deepEqual(once, twice);
  });

  test('an unknown mode falls back to classic instead of inventing a sixth voice', () => {
    const framing = composeExecutiveComms({ mode: 'gladiator', facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    assert.equal(framing.mode, 'classic');
  });
});

describe('dry wit, never noise (Part 4, Principle #10)', () => {
  test('healthy and idle, Classic is the only voice allowed wit, and it uses it', () => {
    const all = composeAllFramings({ facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    assert.equal(all.signals.witAllowed, true);
    const classic = all.framings.classic;
    assert.equal(classic.witAllowed, true);
    assert.ok(witMarkersIn(classic).length > 0, 'the classic voice is allowed a flourish when nothing is wrong');
    for (const mode of ['tactical', 'overwatch', 'synthesis', 'quiet']) {
      assert.deepEqual(witMarkersIn(all.framings[mode]), [], `${mode} carries no wit even when healthy`);
    }
  });

  const RISKS = [
    ['an active advisory', { coreState: 'idle', alerts: [{ alertClass: 'workspace_dirty' }] }, /advisory is active/],
    ['a pending approval', { coreState: 'awaiting_approval', approvals: 1 }, /approval is pending/],
    ['a degraded Core', { coreState: 'degraded' }, /Core is degraded/],
    ['an error', { coreState: 'idle', errors: ['the store could not be read'] }, /error is present/],
    ['Lockdown', { coreState: 'idle', lockdown: true }, /Lockdown is latched/],
    ['uncertainty', { coreState: 'idle', uncertain: true }, /state is uncertain/],
    ['a working Core', { coreState: 'running' }, /Core is running/],
  ];

  for (const [name, signals, reason] of RISKS) {
    test(`${name} strips wit from every voice`, () => {
      const all = composeAllFramings({ facts: HEALTHY_FACTS, signals });
      assert.equal(all.signals.witAllowed, false);
      assert.match(all.signals.witWithheldBecause.join('; '), reason);
      for (const mode of EXEC_MODES) {
        const framing = all.framings[mode];
        assert.equal(framing.witAllowed, false, `${mode} reports witAllowed false`);
        assert.deepEqual(witMarkersIn(framing), [], `${mode} must carry no wit marker while ${name} holds`);
      }
      // Classic says why it is holding back rather than pretending the deck is calm.
      assert.ok(all.framings.classic.lines.some((entry) => entry.label === 'Attention' && /wit withheld/.test(entry.value)));
    });
  }

  test('a risk signal also strips the classic flourish when every other signal is clear', () => {
    const framing = composeExecutiveComms({ mode: 'classic', facts: HEALTHY_FACTS, signals: { coreState: 'idle', lockdown: true } });
    assert.equal(framing.witAllowed, false);
    assert.match(framing.witWithheldBecause.join('; '), /Lockdown is latched/);
    assert.deepEqual(witMarkersIn(framing), []);
    assert.match(framing.headline, /something to review/);
  });

  test('the wit markers are the ones the code can actually emit', () => {
    // If a marker list drifts from the templates, this catches it in the healthy case rather than in
    // the risky one where it would silently pass.
    const classic = composeExecutiveComms({ mode: 'classic', facts: HEALTHY_FACTS, signals: HEALTHY_SIGNALS });
    const rendered = JSON.stringify(classic);
    for (const marker of WIT_MARKERS) {
      if (marker.test(rendered)) assert.ok(witMarkersIn(classic).includes(marker.source));
    }
    assert.ok(WIT_MARKERS.length >= 5);
  });

  test('the formatter cannot be asked to allow wit by passing the flag itself', () => {
    // `witAllowed` is computed from the signals; a caller that sets it on the signal object instead
    // gets the computed answer, not its own.
    const signals = readSignals({ coreState: 'idle', witAllowed: true, lockdown: true });
    assert.equal(signals.witAllowed, false);
  });
});
