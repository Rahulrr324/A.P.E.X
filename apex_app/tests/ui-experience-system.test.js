// T-30 Package 5 (2026-11-19): the experience system — tokens, presentation modes,
// keyboard traversal, motion/contrast preferences and the Lockdown presentation.
//
// Two kinds of check:
//  - static audit of the served markup and CSS (no dead element references, no fake voice
//    controls, every token present, contrast measured from the shipped hex values);
//  - execution of the shipped client in the vm harness, asserting the behaviour.
// Layout and pixels are not covered here and remain UNVERIFIED without a browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT, UI_CSS, UI_PAGE } from '../src/ui/assets.js';
import { STATE_EVENT_OWNERS, STATE_EVENT_SCHEMA } from '../src/ui/event-contract.js';
import { CORE_REACHABLE_STATES, CORE_RESERVED_STATES } from '../src/ui/core-state.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const STREAM_ID = 'd'.repeat(32);

const readyOwners = (overrides = {}) => ({
  tasks: { available: true, total: 0, counts: { runningTasks: 0, pausedTasks: 0, awaitingApprovalSteps: 0, uncertainSteps: 0 }, items: [] },
  plans: { available: true, total: 0, counts: { unapprovedDrafts: 0 }, items: [] },
  approval: { available: true, taskStepCount: 0, draftPlanCount: 0, taskSteps: [], truncatedTaskSteps: false, draftPlans: [], truncatedDraftPlans: false },
  lockdown: { available: true, active: false, policyUnavailable: false },
  runtime: { available: true, lifecycle: 'stopped', paused: false },
  health: { available: true, overall: 'healthy', areas: [], unhealthyAreaCount: 0, attentionCount: 0, errorCount: 0, coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 } },
  conversation: { available: true, sessionStatus: 'missing', turnCount: 0, corruptCount: 0 },
  ...overrides,
});

function reconcile(owners = readyOwners(), seq = 3) {
  return {
    schema: STATE_EVENT_SCHEMA,
    streamId: STREAM_ID,
    seq,
    type: 'reconcile',
    versions: Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, 1])),
    payload: { reason: 'initial', owners },
  };
}

// Only the :root block: modes and the high-contrast block legitimately re-declare tokens.
function tokens(css) {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const found = {};
  for (const match of root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgba?\([^)]+\))/g)) {
    found[match[1]] = match[2];
  }
  return found;
}

function hexToRgb(hex) {
  assert.match(hex, /^#[0-9a-fA-F]{6}$/, `expected a hex colour, got ${hex}`);
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => (channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

async function loadClient() {
  const browser = createFakeBrowser();
  const context = vm.createContext(browser.sandbox, { name: 'apex-experience-ui' });
  vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
  await flushMicrotasks();
  const source = browser.events.sources.at(-1);
  source.open();
  source.emit('reconcile', reconcile(), { lastEventId: `${STREAM_ID}:3` });
  await flushMicrotasks();
  return { browser, source, document: browser.document };
}

describe('experience system: served markup and design tokens', () => {
  test('every element the client reads exists in the served page (no dead references)', () => {
    const ids = [...new Set([...UI_CLIENT.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]))];
    assert.ok(ids.length > 80, 'the client resolves its element registry at load');
    const missing = ids.filter((id) => !UI_PAGE.includes(`id="${id}"`));
    assert.deepEqual(missing, [], 'every getElementById target is present in UI_PAGE');
  });

  test('every navigation item has a view section and every view section has a nav item', () => {
    const nav = [...UI_PAGE.matchAll(/data-view="([a-z]+)" class="nav-item/g)].map((match) => match[1]);
    const sections = [...UI_PAGE.matchAll(/<section class="view" data-view="([a-z]+)"/g)].map((match) => match[1]);
    assert.deepEqual(nav, ['deck', ...sections]);
    assert.equal(new Set(nav).size, nav.length, 'no duplicate nav items');
    assert.equal(new Set(sections).size, sections.length, 'no duplicate view sections');
  });

  test('no fake voice or push-to-talk control is present', () => {
    const controls = [...UI_PAGE.matchAll(/<(button|a)[^>]*>([^<]*)<\/\1>/g)].map((match) => match[2]);
    const forbidden = controls.filter((label) => /voice|microphone|push to talk|push-to-talk|listen|speak|record audio|wake word/i.test(label));
    assert.deepEqual(forbidden, []);
    assert.equal(/getUserMedia|SpeechRecognition|webkitSpeechRecognition|AudioContext/.test(UI_CLIENT), false);
    // Listening/Speaking exist only as reserved vocabulary that the UI refuses to set.
    assert.equal(CORE_RESERVED_STATES.includes('listening'), true);
    assert.equal(CORE_REACHABLE_STATES.includes('listening'), false);
    assert.equal(CORE_REACHABLE_STATES.includes('speaking'), false);
  });

  test('the Part 4 tokens are the shipped values', () => {
    const values = tokens(UI_CSS);
    assert.equal(values['--bg-void'], '#05080f');
    assert.equal(values['--bg-deep'], '#0a1220');
    assert.equal(values['--glass'], 'rgba(12, 28, 48, 0.55)');
    assert.equal(values['--arc-cyan'], '#00e5ff');
    assert.equal(values['--armor-gold'], '#ffb000');
    assert.equal(values['--armor-red'], '#e10600');
    assert.equal(values['--ok-green'], '#2bff88');
    assert.equal(values['--text'], '#dcebff');
    assert.equal(values['--text-dim'], '#7fa3c7');
    assert.equal(UI_CSS.includes('--radius: 2px'), true);
    assert.equal(/font-variant-numeric:\s*tabular-nums/.test(UI_CSS), true);
    assert.match(UI_CSS, /:focus-visible/);
    assert.match(UI_CSS, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(UI_CSS, /@media \(prefers-contrast: more\)/);
    assert.match(UI_CSS, /@media \(max-width: 1600px\)/);
    assert.match(UI_CSS, /@media \(max-width: 1280px\)/);
    assert.match(UI_CSS, /@media \(max-width: 1100px\)/);
    assert.match(UI_CSS, /@media \(max-width: 720px\)/);
    assert.match(UI_CSS, /@media \(max-width: 480px\)/);
  });

  test('every presentation mode is a token change, and Lockdown is included', () => {
    // Classic is the default skin (the :root tokens) and needs no override block.
    assert.match(UI_PAGE, /<body[^>]*data-mode="classic"/);
    for (const mode of ['tactical', 'overwatch', 'synthesis', 'quiet', 'lockdown']) {
      assert.ok(UI_CSS.includes(`body[data-mode="${mode}"]`), `${mode} has presentation rules`);
    }
    assert.equal((UI_PAGE.match(/<option value="(classic|tactical|overwatch|synthesis|quiet)"/g) || []).length, 5,
      'the selector offers exactly the five owner-selectable modes');
    // Modes are a palette/behaviour skin: no mode rule may set an authorization-relevant
    // property, and the client never sends a mode anywhere.
    for (const block of UI_CSS.matchAll(/body\[data-mode="[a-z]+"\][^{]*\{([^}]*)\}/g)) {
      assert.equal(/display:\s*none/.test(block[1]), false, 'a mode never hides a record surface');
    }
    assert.equal(/fetch\([^)]*(mode|theme)/i.test(UI_CLIENT), false);
    assert.equal(/data-mode/.test(UI_PAGE), true);
  });

  test('text tokens meet the 4.5:1 contrast bar on their surfaces', () => {
    const v = tokens(UI_CSS);
    const pairs = [
      ['--text', '--bg-void'],
      ['--text', '--bg-deep'],
      ['--text-dim', '--bg-deep'],
      ['--arc-cyan', '--bg-void'],
      ['--armor-gold', '--bg-void'],
      ['--armor-red-text', '--bg-void'],
      ['--ok-green', '--bg-void'],
    ];
    for (const [foreground, background] of pairs) {
      const ratio = contrastRatio(v[foreground], v[background]);
      assert.ok(ratio >= 4.5, `${foreground} on ${background} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
    }
    // The danger fill is documented as a fill/border colour; its text-safe variant is the
    // one used for text (see --armor-red-text).
    assert.ok(contrastRatio(v['--armor-red'], v['--bg-void']) < 4.5,
      'the raw danger fill stays a fill colour; text uses --armor-red-text');
  });
});

describe('experience system: behaviour in the shipped client', () => {
  test('mode selection changes presentation only and issues no write', async () => {
    const { browser, document } = await loadClient();
    assert.equal(document.body.dataset.mode, 'classic');

    const select = document.getElementById('mode-select');
    for (const mode of ['tactical', 'overwatch', 'synthesis', 'quiet', 'classic']) {
      select.value = mode;
      select.dispatchEvent({ type: 'change', target: select, preventDefault() {}, stopPropagation() {} });
      assert.equal(document.body.dataset.mode, mode, `${mode} applies from the selector`);
    }
    // Selecting a mode must not touch the server: no POST/PUT/PATCH was ever issued.
    const writes = browser.events.fetches.filter((entry) => entry.method !== 'GET');
    assert.deepEqual(writes, []);
    assert.deepEqual(browser.events.consoleErrors, []);
  });

  test('motion and contrast toggles are real, reflected and reversible', async () => {
    const { document } = await loadClient();
    const motion = document.getElementById('motion-toggle');
    const contrast = document.getElementById('contrast-toggle');
    assert.equal(document.body.dataset.motion, 'full');
    assert.equal(motion.getAttribute('aria-pressed'), 'false');

    motion.dispatchEvent({ type: 'click', target: motion, preventDefault() {}, stopPropagation() {} });
    assert.equal(document.body.dataset.motion, 'reduced');
    assert.equal(motion.getAttribute('aria-pressed'), 'true');
    assert.match(motion.textContent, /reduced/i);

    motion.dispatchEvent({ type: 'click', target: motion, preventDefault() {}, stopPropagation() {} });
    assert.equal(document.body.dataset.motion, 'full');

    contrast.dispatchEvent({ type: 'click', target: contrast, preventDefault() {}, stopPropagation() {} });
    assert.equal(document.body.dataset.contrast, 'high');
    assert.equal(contrast.getAttribute('aria-pressed'), 'true');
    contrast.dispatchEvent({ type: 'click', target: contrast, preventDefault() {}, stopPropagation() {} });
    assert.equal(document.body.dataset.contrast, 'standard');
  });

  test('keyboard traversal moves between the same views the nav exposes', async () => {
    const { document } = await loadClient();
    let prevented = 0;
    const press = (key) => document.__listeners.keydown
      .forEach((handler) => handler({
        key,
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        target: document.body,
        defaultPrevented: false,
        preventDefault() { prevented += 1; },
      }));

    press('ArrowRight');
    assert.equal(document.body.dataset.view, 'conversations');
    press('ArrowRight');
    assert.equal(document.body.dataset.view, 'missions');
    press('ArrowLeft');
    assert.equal(document.body.dataset.view, 'conversations');
    assert.ok(prevented >= 3, 'the handler claims the shortcut so the browser does not scroll');
  });

  test('Lockdown presentation follows the latch and returns to the owner\'s mode', async () => {
    const { browser, source, document } = await loadClient();
    const select = document.getElementById('mode-select');
    select.value = 'tactical';
    select.dispatchEvent({ type: 'change', target: select, preventDefault() {}, stopPropagation() {} });
    assert.equal(document.body.dataset.mode, 'tactical');

    source.emit('reconcile', reconcile(readyOwners({
      lockdown: { available: true, active: true, policyUnavailable: false, reason: 'reviewed' },
    }), 4), { lastEventId: `${STREAM_ID}:4` });
    await flushMicrotasks();
    assert.equal(browser.coreState(), 'lockdown');
    assert.equal(document.body.dataset.mode, 'lockdown', 'an active latch presents as Lockdown');
    assert.equal(select.disabled, true, 'the selector cannot imply a choice while latched');

    source.emit('reconcile', reconcile(readyOwners(), 5), { lastEventId: `${STREAM_ID}:5` });
    await flushMicrotasks();
    assert.equal(browser.coreState(), 'idle');
    assert.equal(document.body.dataset.mode, 'tactical', 'releasing the latch restores the chosen mode');
    assert.equal(select.disabled, false);
  });
});
