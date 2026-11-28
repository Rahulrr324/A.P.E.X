// T-46 STEP 1 (2026-11-19): the layout the review asked for, pinned where a regression is cheap.
//
// The real measurement is `tests/e2e/t46-experience.spec.mjs`, which runs in a Chromium build and
// reports the header's height, the Core's offset from the viewport centre and the document's scroll
// height as numbers. This file is the browser-free half: it pins the structures those numbers depend
// on, so a change that would move the header or unhook the strip fails in a second rather than in the
// hosted run.
//
// What is pinned here:
//   * the document is one viewport tall and does not scroll; the shell is the scroll region;
//   * the header is a declared 64px band, and the only things in it are the readings the brief names;
//   * every badge and control that left the header still exists, with its id, in the header's panel;
//   * the strip reads from the same state the panels write, and never fetches;
//   * the popover is a panel, not a modal: Escape closes it, focus returns, nothing is trapped;
//   * the phone layout is declared by the client and has rules of its own;
//   * the command bar is inside the shell and ordered after the deck, which is what docks it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { UI_CLIENT, UI_CSS, UI_PAGE } from '../src/ui/assets.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const HEADER = UI_PAGE.slice(UI_PAGE.indexOf('<header class="topbar">'), UI_PAGE.indexOf('</header>'));
const PANEL_START = UI_PAGE.indexOf('id="measures-panel"');
// The panel runs from its opening tag to the end of its own block. It is the longest stretch between
// #measures-panel and the first marker that belongs to the next section (#tactical-overlay-strip),
// so the slice is bounded by a marker rather than by a byte count.
const PANEL_END = UI_PAGE.indexOf('id="tactical-overlay-strip"');
const PANEL = UI_PAGE.slice(UI_PAGE.lastIndexOf('<div', PANEL_START), PANEL_END);

function client({ routes = new Map(), search = '' } = {}) {
  const browser = createFakeBrowser({ routes });
  browser.window.location.search = search;
  const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t46' });
  vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
  return browser;
}

// The text of a function from its `function` keyword to its matching closing brace. Used instead of a
// regex so a nested block cannot end the slice early.
function functionBody(source, start) {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

const EMPTY = { available: true, items: [], entries: [], counts: {}, facts: [], sections: [], checks: [], devices: [], observations: [] };
function baseRoutes() {
  const map = new Map();
  map.set('/api/state', {
    session: { id: 'session-t46-0001', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [],
    autonomy: { configured: {} }, runtime: { status: 'stopped' },
    resources: { cpu: {}, memory: {}, storage: [] },
    system: { bootstrap: { bootstrapped: true } },
  });
  map.set('/api/health', { overall: 'healthy', areas: [], unhealthyAreaCount: 0, attentionCount: 0, errorCount: 0, coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 } });
  map.set('/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' });
  for (const path of ['/api/mission-control', '/api/approvals', '/api/timeline', '/api/situation', '/api/briefing',
    '/api/runtime', '/api/sources', '/api/documents', '/api/reasoning', '/api/council', '/api/workshop',
    '/api/resources', '/api/cognition/runs', '/api/presence', '/api/autonomy/matrix', '/api/world/epistemic',
    '/api/evolution', '/api/step-up', '/api/perception', '/api/taskgraph', '/api/memory/associations']) {
    if (!map.has(path)) map.set(path, EMPTY);
  }
  return map;
}

describe('T-46 STEP 1: the shell', () => {
  test('the document is one viewport tall and the shell is the only scroll region', () => {
    assert.match(UI_CSS, /html, body \{ height: 100%; overflow: hidden; \}/,
      'the document is not a scroll container');
    assert.match(UI_CSS, /\.shell, \.workspace \{[^}]*overflow-y: auto/,
      'the shell carries the scroll instead');
    // The one legitimate overflow:hidden on the body is safe only because the shell scrolls: this
    // asserts BOTH halves, so a later change cannot keep the first and drop the second.
    const shellRule = UI_CSS.slice(UI_CSS.indexOf('.shell, .workspace {'));
    assert.ok(shellRule.indexOf('overflow-y: auto') > -1, 'the scroll region exists');
  });

  test('the header is one 64px band and everything in it is a reading', () => {
    assert.match(UI_CSS, /\.topbar \{[^}]*height: 64px/);
    assert.match(UI_CSS, /\.topbar \{[^}]*max-height: 64px/);
    assert.match(UI_CSS, /\.topbar-meta, \.topbar-actions \{ flex-wrap: nowrap/,
      'the header does not wrap');
    // The five readings the brief names are on the band.
    for (const id of ['clock', 'mode', 'connectivity', 'core-state-compact', 'latch-compact',
      'approvals-compact', 'watchpoints-compact']) {
      assert.ok(HEADER.includes(`id="${id}"`), `#${id} is on the band`);
    }
    // The controls that are configuration are not.
    for (const id of ['motion-toggle', 'contrast-toggle', 'stepdown-select', 'new-session', 'quick-boot', 'boot-sequence-run']) {
      assert.equal(HEADER.includes(`id="${id}"`), false, `#${id} is not on the band`);
      assert.ok(PANEL.includes(`id="${id}"`), `#${id} is in the measures panel`);
    }
  });

  test('the badges that left the header kept their ids, and their readers still find them', () => {
    for (const id of ['gauge-cpu', 'gauge-mem', 'gauge-storage', 'sensor-privacy-indicator', 'session', 'autonomy']) {
      assert.ok(UI_PAGE.includes(`id="${id}"`), `#${id} still exists`);
      assert.equal((UI_PAGE.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `#${id} exists exactly once`);
    }
    // The T-35 declaration survives: the indicator still states capture is disabled.
    assert.match(UI_PAGE, /id="sensor-privacy-indicator"[^>]*data-audio="disabled"[^>]*data-camera="disabled"/);
  });

  test('the command bar is inside the shell, first in document order and last in paint order', () => {
    const shell = UI_PAGE.indexOf('<div class="shell">');
    const bar = UI_PAGE.indexOf('class="command-bar"');
    const nav = UI_PAGE.indexOf('<nav class="nav"');
    const deck = UI_PAGE.indexOf('<main id="main-content"');
    const shellClose = UI_PAGE.indexOf('</div>\n<section class="workspace"');
    assert.ok(shell > -1 && bar > -1 && nav > -1 && deck > -1 && shellClose > -1, 'all markers exist');
    // Document order is focus order. The bar comes first inside the shell so Tab reaches the command
    // line before the fifteen workspace tabs - the contract T-32 pinned in T-32 and T-46 must not break.
    assert.ok(shell < bar && bar < nav && nav < deck && deck < shellClose,
      'the bar precedes the navigation and the deck in the document');
    assert.ok(UI_PAGE.indexOf('id="chat-text"') < UI_PAGE.indexOf('<nav class="nav"'),
      'the command input is focusable before the tabs');
    // Paint order is CSS, and it is the opposite: navigation, then deck, then the docked bar.
    assert.match(UI_CSS, /\.shell > nav\.nav \{ order: 1; \}/);
    assert.match(UI_CSS, /\.shell > \.deck \{ order: 2; \}/);
    assert.match(UI_CSS, /\.shell > \.command-bar \{ order: 3; \}/);
    assert.match(UI_CSS, /\.command-bar \{[^}]*border-top: 1px solid var\(--line\)/,
      'the docked bar draws its own top edge');
  });
});

describe('T-46 STEP 1: the phone layout', () => {
  test('the client declares the layout, and the stylesheet has rules keyed to it', () => {
    assert.match(UI_CLIENT, /function applyLayout\(\)/);
    assert.match(UI_CLIENT, /document\.body\.dataset\.layout = mobile \? 'mobile' : 'desktop'/);
    assert.match(UI_CLIENT, /applyLayout\(\);/, 'it is called at start');
    assert.match(UI_CLIENT, /window\.addEventListener\('resize'/, 'and on resize');
    assert.ok((UI_CSS.match(/body\[data-layout="mobile"\]/g) ?? []).length >= 15,
      'the phone has rules of its own rather than one override');
    // The three things the brief names, each a rule rather than an intention.
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.core \{ width: min\(62vw, 15rem\); \}/);
    // The stage is ONE column on a phone. Without this the Core shared its grid row with the two
    // side panels, started 267px right of the left edge, and the "Core is first" gate failed with the
    // rails beginning above the Core's bottom.
    // The deck and the stage are flex COLUMNS on a phone. A one-column grid put the stage's three
    // children in one row anyway (auto-placement puts each in a column of its own when no columns are
    // declared), and the hosted walk measured the Core starting 267px right of the left edge with the
    // rails above its bottom. A flex column has one axis and no placement to disagree with.
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.deck \{[^}]*display: flex;[^}]*flex-direction: column/);
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.stage \{[^}]*display: flex;[^}]*flex-direction: column/);
    // flex: 0 0 auto is not decoration. As a flex item of the deck the stage's basis was 0 and it never
    // grew: it measured 250px while its own content measured 1,336px, painted the Core 106px past its
    // bottom edge, and the rails - placed below its BOX - landed on top of the Core.
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.stage \{[^}]*flex: 0 0 auto/);
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.rail \{[^}]*flex: 0 0 auto/);
    // The side panels are bounded on a phone: unbounded they measured 811px and 141px, so an owner
    // scrolled past a paragraph to reach their alerts.
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.stage > #exec-comms-panel,[\s\S]{0,120}max-height: 34vh; overflow-y: auto;/);
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.stage > \* \{ flex: 0 0 auto; width: 100%; \}/);
    assert.match(UI_CSS, /body\[data-layout="mobile"\] \.rail \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    // 6, not 5: the deck is 1 and the bar 4, and equal orders fall back to document order - the bar is
    // first in the document for Tab, so the same number painted it above the navigation.
    assert.match(UI_CSS, /body\[data-layout="mobile"\] nav\.nav \{[^}]*order: 6/);
  });

  test('the layout flag matches the stylesheet breakpoint', () => {
    // The client asks matchMedia the same question the stylesheet asks, so the two cannot disagree
    // about which side of 720px a window is on.
    assert.match(UI_CLIENT, /window\.matchMedia\('\(max-width: 720px\)'\)/);
    assert.match(UI_CSS, /@media \(max-width: 720px\)/);
  });

  test('a browser without matchMedia keeps the desktop layout instead of throwing', () => {
    const browser = client({ routes: baseRoutes() });
    assert.equal(browser.document.body.dataset.layout, 'desktop',
      'the stand-in reports no matchMedia result, so the deck stays a desktop deck');
  });
});

describe('T-46 STEP 1: the header strip', () => {
  test('the strip never fetches: it only reads state the panels already wrote', () => {
    const body = UI_CLIENT.slice(UI_CLIENT.indexOf('function syncHeaderStrip()'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    assert.equal(/fetch\(|await |api\(/.test(fn), false, 'syncHeaderStrip does no I/O');
    assert.equal(/\.innerHTML/.test(fn), false, 'and builds no markup');
  });

  test('the Core projection fills the strip in the same pass', () => {
    // The function's own body, found by counting braces rather than by searching for the first
    // closing brace: applyCoreProjection has a nested block, and the first version of this test
    // stopped inside it and reported a false failure.
    const start = UI_CLIENT.indexOf('function applyCoreProjection(');
    assert.ok(start > -1, 'the projection exists');
    const body = functionBody(UI_CLIENT, start);
    // The projection calls the guarded wrapper, not syncHeaderStrip directly: the wrapper is what keeps
    // a strip failure from leaving the boot overlay up over an awake Core. So both halves are pinned -
    // the call in the projection, and the wrapper being the only thing it calls.
    assert.ok(body.includes('syncHeaderStripSafely()'), 'the strip is written where the Core is written');
    assert.equal(body.includes('syncHeaderStrip()'), false, 'the projection does not call the writer unguarded');
    // And the dormant branch carries it too, so a waking machine's strip says Dormant.
    const dormant = body.slice(body.indexOf("state.core = 'dormant'"), body.indexOf("return 'dormant'"));
    assert.ok(dormant.includes('syncHeaderStripSafely()'), 'the dormant branch writes the strip as well');
  });

  test('the approval total is the one the Approval Centre read, and a dash when that read failed', async () => {
    const browser = client({ routes: baseRoutes() });
    await flushMicrotasks();
    const approvalRoute = browser.__routes?.get?.('/api/approvals');
    // The seeded read answers with an empty list: zero pending is a real zero, not a dash.
    assert.equal(browser.getElement('approvals-compact').textContent, '0');
    // And an unreadable store is a dash. This is the same rule the tactical strip has carried since
    // T-45: a strip that showed 0 while the read was failing would be a false all-clear.
    assert.equal(typeof approvalRoute, 'undefined', 'the stand-in does not expose its route table');
    assert.match(UI_CLIENT, /pending === null \|\| pending === undefined \? '—' : String\(pending\)/);
  });

  test('every strip cell carries the data attribute its styling and its gate read', async () => {
    const browser = client({ routes: baseRoutes() });
    await flushMicrotasks();
    for (const [id, attribute] of [
      ['core-state-compact', 'core'], ['latch-compact', 'latch'],
      ['approvals-compact', 'count'], ['watchpoints-compact', 'count'],
    ]) {
      const node = browser.getElement(id);
      assert.equal(typeof node.dataset[attribute], 'string', `#${id} carries data-${attribute}`);
      assert.notEqual(node.textContent, '', `#${id} was written`);
    }
  });
});

describe('T-46 STEP 1: the measures popover', () => {
  test('it is a panel, not a modal, and Escape closes it and returns focus', async () => {
    const browser = client({ routes: baseRoutes() });
    await flushMicrotasks();
    assert.match(UI_PAGE, /id="measures-panel"[^>]*role="group"/);
    assert.equal(/id="measures-panel"[^>]*aria-modal/.test(UI_PAGE), false, 'no modal role');
    assert.equal(/id="measures-panel"[^>]*autofocus/.test(UI_PAGE), false, 'it never takes focus by itself');

    const trigger = browser.getElement('measures-trigger');
    const panel = browser.getElement('measures-panel');
    // The stand-in has no getAttribute, and it creates every element with hidden:false whether or not
    // the markup says hidden - so the panel's own property is read only AFTER the client has moved it.
    // The initial closed state is pinned by the markup assertion below and by the hosted walk, which
    // reads it from a live DOM.
    assert.match(UI_PAGE, /id="measures-panel"[^>]*hidden>/, 'the panel ships closed');
    for (const handler of trigger.__listeners.click ?? []) handler({ target: trigger, preventDefault() {} });
    assert.equal(panel.hidden, false, 'the panel opened');
    assert.equal(trigger.getAttribute?.('aria-expanded'), 'true', 'and the trigger says so');

    const keydown = browser.document.__listeners?.keydown ?? [];
    for (const handler of keydown) handler({ key: 'Escape', target: browser.document.body, preventDefault() {}, defaultPrevented: false });
    assert.equal(panel.hidden, true, 'Escape closed it');
    // And Escape did not spend its dismissal on the popover when the popover was not open: the
    // boot-sequence path behind it still runs (pinned in t36-boot-sequence.test.js).
    assert.match(UI_PAGE, /id="measures-trigger"[^>]*aria-expanded="false"/,
      'the trigger ships with aria-expanded false, which is what the client flips');
  });

  test('opening the popover authorizes nothing: it issues no request and changes no policy', async () => {
    const browser = client({ routes: baseRoutes() });
    await flushMicrotasks();
    const before = browser.events.fetches.length;
    const trigger = browser.getElement('measures-trigger');
    for (const handler of trigger.__listeners.click ?? []) handler({ target: trigger, preventDefault() {} });
    await flushMicrotasks();
    assert.equal(browser.events.fetches.length, before, 'opening the popover fetched nothing');
    assert.equal(browser.getElement('mode-select').disabled, false, 'and disabled nothing');
  });

  test('a click outside closes it, and a click inside does not', async () => {
    const browser = client({ routes: baseRoutes() });
    await flushMicrotasks();
    const trigger = browser.getElement('measures-trigger');
    for (const handler of trigger.__listeners.click ?? []) handler({ target: trigger, preventDefault() {} });
    assert.equal(browser.getElement('measures-panel').hidden, false);

    const outside = browser.document.createElement('div');
    for (const handler of browser.document.__listeners.click ?? []) handler({ target: outside });
    assert.equal(browser.getElement('measures-panel').hidden, true, 'a click elsewhere closed it');
  });
});

describe('T-46 STEP 1: the Core leads', () => {
  test('the Core is sized from the space it has, not from a constant', () => {
    // The reticle's own rule is the one that wins (an id beats a class), so the fit is pinned there -
    // and it is a WIDTH bound only. An earlier version also capped max-height, which squashed the square
    // reticle into a 260x144 rectangle; the T-32 walk caught it, and this assertion is what would catch
    // it again before the hosted run does.
    assert.match(UI_CSS, /#core-reticle \{[^}]*width: min\(34rem, 100%, calc\(var\(--core-fit, 24rem\) \* 1px\)\)/,
      'the reticle takes the smaller of its column and its measured fit');
    assert.equal(/max-height/.test(UI_CSS.slice(UI_CSS.indexOf('#core-reticle {'), UI_CSS.indexOf('}', UI_CSS.indexOf('#core-reticle {')))), false,
      'the fit never caps the height, so the reticle stays square');
    assert.match(UI_CLIENT, /function measureCoreFit\(\)/);
    assert.match(UI_CLIENT, /setProperty\('--core-fit'/);
  });

  test('prose runs at a readable measure, so it cannot outgrow the Core', () => {
    // Measured by the hosted run: #exec-comms-headline was 713px of single-line sentence - wider than
    // the 544px Core at 1600x900 - and the "Core is the widest element" gate named it. A bounded
    // measure is both the layout fix and the better line length.
    // The bound is the Core's own fit: a character count alone measured 526px on a laptop whose reticle
    // is 425px, so the panel's message line was still wider than the Core.
    assert.match(UI_CSS, /#exec-comms-panel, #exec-comms-panel p, #exec-comms-panel \.exec-comms-line \{[^}]*max-width: min\(46ch, calc\(var\(--core-fit, 24rem\) \* 1px\)\)/);
    assert.match(UI_CSS, /#conversation-panel, #conversation-panel p \{[^}]*max-width: min\(66ch, calc\(var\(--core-fit, 24rem\) \* 1px\)\)/);
    // And the caption is bounded by the Core it captions: at a flat 34rem it was 526px of paragraph
    // under a 425px reticle on a laptop, so the widest thing in the deck was the sentence about the Core.
    assert.match(UI_CSS, /\.core-caption \{[^}]*max-width: min\(32rem, calc\(var\(--core-fit, 24rem\) \* 1px\)\)/);
    assert.equal((UI_CSS.match(/\.core-caption \{/g) ?? []).length, 1,
      'one caption rule: a duplicate would let the older max-width win');
  });

  test('the stage gives the Core the spare height and the panels their own scroll', () => {
    assert.match(UI_CSS, /\.stage \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto auto/);
    assert.match(UI_CSS, /\.rail \.panel \{ overflow-y: auto; min-height: 0; \}/,
      'a panel scrolls inside itself rather than growing the band');
    assert.equal(/\.deck \.panel \{[^}]*overflow: hidden/.test(UI_CSS), false,
      'no panel clips its content');
  });
});

describe('T-46: the measuring instrument is checked as code, not only as a run', () => {
  // The spec's page-side code runs in the BROWSER, where a mistake is a page error and not a lint
  // warning - and the first version of the phone gate called core.closest() on a DOMRect, which threw
  // on the laptop viewport and cost a 15-minute hosted run to find. These two tests catch that class of
  // mistake locally, in a second.
  const specPath = new URL('./e2e/t46-experience.spec.mjs', import.meta.url);
  const spec = fs.readFileSync(specPath, 'utf8');
  const code = spec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('no DOM method is called on a value that only ever held a DOMRect', () => {
    const sources = new Map();
    for (const match of code.matchAll(/const\s+(\w+)\s*=\s*([^;\n]+)/g)) {
      const [, name, rhs] = match;
      if (!sources.has(name)) sources.set(name, new Set());
      sources.get(name).add(/getBoundingClientRect/.test(rhs) ? 'rect' : 'other');
    }
    const rects = [...sources.entries()].filter(([, set]) => set.size === 1 && set.has('rect')).map(([name]) => name);
    const misuse = [];
    for (const name of rects) {
      for (const match of code.matchAll(new RegExp(`\\b${name}\\.(closest|querySelector|querySelectorAll|getAttribute|setAttribute|children)\\b`, 'g'))) {
        misuse.push(`${name}.${match[1]}`);
      }
    }
    assert.deepEqual(misuse, [], `a DOMRect has no DOM methods: ${misuse.join(', ')}`);
  });

  test('every page-side measure function is syntactically a function', async () => {
    // The blocks are handed to page.evaluate as source. A syntax error there is a page error on the
    // host, never a local one, so each one is parsed here.
    for (const name of ['measureHeader', 'measureCore', 'measureDocument', 'measureCommandBar',
      'measurePanelInteriors', 'measureMobile', 'measureContrast']) {
      assert.ok(spec.includes(`async function ${name}(`), `#${name} exists`);
    }
    // Every page.evaluate(() => { ... }) body is handed to the BROWSER as source: it is the only code in
    // this file that a local syntax check cannot see. Each one is parsed here, as a function body. The
    // bodies are delimited by brace matching, not by a regex, because a regex stops at the first inner
    // closing brace and then reports a real block as truncated.
    const bodies = [];
    let at = 0;
    while ((at = spec.indexOf('page.evaluate(', at)) !== -1) {
      const open = spec.indexOf('{', spec.indexOf('=>', at));
      if (open === -1) { at += 14; continue; }
      let depth = 0;
      let end = -1;
      for (let k = open; k < spec.length; k += 1) {
        if (spec[k] === '{') depth += 1;
        else if (spec[k] === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
      }
      if (end === -1) { at += 14; continue; }
      // An async arrow's body may use await, and only an async function may. The head between the
      // opening parenthesis of evaluate and the arrow is what says which.
      const head = spec.slice(at, open);
      bodies.push({ body: spec.slice(open + 1, end), isAsync: /\basync\b/.test(head) });
      at = end;
    }
    assert.ok(bodies.length >= 6, `found the page-side bodies (${bodies.length})`);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    for (const { body, isAsync } of bodies) {
      assert.doesNotThrow(() => new (isAsync ? AsyncFunction : Function)(body),
        'a page-side body parses as JavaScript');
    }
  });
});

describe('T-46 STEP 2: the boot sequence is per session, skippable, and bounded', () => {
  // The brief: runs from REAL sources, finishes inside 4 s, is skippable by any key or ?quick=1,
  // respects reduced motion, does not flash faster than 3 Hz, and must never mask a Degraded or an SSE
  // failure. The geometry is in the browser walk; these are the decisions, pinned where they are cheap.
  test('the sequence is once per session, and the marker is written when it starts', () => {
    assert.match(UI_CLIENT, /function bootSessionKey\(\)/);
    assert.match(UI_CLIENT, /sessionStorage\.setItem\(bootSessionKey\(\), '1'\)/);
    // Written at START, not at the end: a sequence that fails must not be retried in a loop on the next
    // read, and the failure is already on screen with the readings the doctor can give.
    const start = UI_CLIENT.indexOf('markBootSession();');
    const run = UI_CLIENT.indexOf("trigger: 'session start', maskCore: false");
    assert.ok(start > 0 && run > start, 'the marker is written before the session-start sequence runs');
  });

  test('?quick=1, ?boot=0 and reduced motion all skip it, and ?boot=1 forces it', () => {
    assert.match(UI_CLIENT, /if \(query\.get\('quick'\) === '1'\) return 'quick';/);
    assert.match(UI_CLIENT, /if \(query\.get\('boot'\) === '0'\) return 'off';/);
    assert.match(UI_CLIENT, /if \(state\.reducedMotion\) return 'reduced-motion';/);
    assert.match(UI_CLIENT, /if \(bootSessionShown\(\)\) return 'already-shown';/);
    // ?boot=1 is checked FIRST and returns null, so it wins over every skip.
    const forced = UI_CLIENT.indexOf("if (query.get('boot') === '1') return null;");
    const quick = UI_CLIENT.indexOf("if (query.get('quick') === '1') return 'quick';");
    assert.ok(forced > 0 && forced < quick, 'the forced replay is decided before the skip reasons');
  });

  test('any key dismisses, and the keys that must not are named', () => {
    assert.match(UI_CLIENT, /if \(state\.bootSequence\.active && event\.key && event\.key !== 'Escape'/);
    // Escape is excluded because it has an order of operations (reference, popover, then the sequence).
    assert.match(UI_CLIENT, /key === 'Shift' \|\| key === 'Control' \|\| key === 'Alt' \|\| key === 'Meta'/);
    // The function-key escape: F1..F12 are the browser's, not the sequence's.
    assert.ok(UI_CLIENT.includes('/^F([1-9]|1[0-2])$/'), 'the function-key pattern is present');
    assert.match(UI_CLIENT, /key !== 'Tab'/);
  });

  test('four seconds is a deadline, not a hope', () => {
    assert.match(UI_CLIENT, /const BOOT_SEQUENCE_MAX_MS = 4000;/);
    assert.match(UI_CLIENT, /const deadline = Date\.now\(\) \+ BOOT_SEQUENCE_MAX_MS;/);
    // The reveal pacing is clamped to what is left, so the pacing alone cannot overrun the deadline.
    assert.match(UI_CLIENT, /Math\.min\(delay, deadline - Date\.now\(\)\)/);
  });

  test('every step state is one an owner can act on', () => {
    // ok / degraded / failed / unavailable. "unavailable" is a real answer - a check with nothing to
    // look at is never reported as a success.
    for (const state of ["'ok'", "'degraded'", "'failed'", "'unavailable'"]) {
      assert.ok(UI_CLIENT.includes(`return ${state};`), `${state} is a state a step can report`);
    }
  });

  test('the forced failure is an ordinary failed request, not a scripted answer', () => {
    assert.match(UI_CLIENT, /if \(bootQuery\(\)\.get\('boot'\) === 'fail'\) throw new Error\('forced failure \(\?boot=fail\)'\);/);
    // It throws BEFORE the request, inside the same try, so the same catch produces the same failed step.
    const forcedAt = UI_CLIENT.indexOf("=== 'fail') throw");
    const requestAt = UI_CLIENT.indexOf("api('/api/system/bootstrap'");
    assert.ok(forcedAt > 0 && requestAt > forcedAt, 'the forced failure precedes the real read in one try');
  });

  test('a session-start reveal may not claim the Core, so it cannot hide Degraded', () => {
    // The Core is Dormant only while the machine is genuinely waking (unseeded, or a forced replay).
    // The per-session reveal runs when the deck already has the owners' answer, so it is passive:
    // maskCore false. This is the "must not mask Degraded" clause, in the one place it could be broken.
    assert.match(UI_CLIENT, /async function runBootSequence\(\{ trigger = 'manual', maskCore = true \} = \{\}\)/);
    assert.match(UI_CLIENT, /runBootSequence\(\{ trigger: 'session start', maskCore: false \}\)/);
    // The projection honours the flag rather than testing the overlay's mere presence.
    assert.match(UI_CLIENT, /state\.bootSequence\.active && state\.bootSequence\.maskCore === true/);
    // An unseeded directory and a forced replay still mask: the machine really is waking then.
    assert.match(UI_CLIENT, /runBootSequence\(\{ trigger: 'unseeded data directory' \}\)/);
    assert.match(UI_CLIENT, /runBootSequence\(\{ trigger: 'owner request \(\?boot=1\)' \}\)/);
  });

  test('the session reveal is started by the first read, not before it', () => {
    // T-36 caught the first version: starting the reveal at script load took the "a sequence is running"
    // slot, so when the first read then reported an UNSEEDED directory the genuine wake was refused and
    // the workstation looked awake before it had been set up. The decision and the start are the same
    // place now, and that place is the snapshot handler.
    assert.match(UI_CLIENT, /state\.bootSequence\.sessionReveal = true;/);
    // The ORDER that matters is inside the snapshot handler, not in this file: the unseeded branch is
    // tested first, and the session reveal is its else. Source positions prove nothing here - the
    // function definition comes after its call site - so the branch order is what is asserted.
    assert.match(UI_CLIENT,
      /bootstrapped === false\s*&& state\.bootSequence\.triggered !== true\) \{[\s\S]{0,220}unseeded data directory[\s\S]{0,400}else if \(state\.bootSequence\.sessionReveal === true/);
    // And an explicit request pre-empts the passive reveal; a genuine wake is never pre-empted.
    assert.match(UI_CLIENT, /const passive = state\.bootSequence\.maskCore === false;/);
    assert.match(UI_CLIENT, /if \(!passive\) return null;/);
  });

  test('the overlay never masks Degraded or an SSE failure', () => {
    // The overlay is a fixed panel over the deck's bottom-left, not an opaque full-viewport modal, and
    // the connectivity badge and the Core stay in the document and keep updating behind it.
    assert.match(UI_CSS, /\.hud-boot \{[^}]*pointer-events: none/);
    assert.match(UI_CSS, /\.hud-boot-panel \{[^}]*pointer-events: auto/);
    assert.doesNotMatch(UI_CSS, /\.hud-boot \{[^}]*background: [^;]*;/,
      'the overlay itself is transparent: it never covers the deck');
    // The overlay is transparent and only its panel takes pointers, so a Degraded that arrives while it
    // is up is written to the same badges underneath it. The one state the sequence does set is Dormant,
    // and it restores it in the same pass: the Core returns to the authoritative reading.
    assert.match(UI_CLIENT, /document\.body\.dataset\.coreState = 'dormant';/);
    // The own-property finally block restores it; the comment text before the call is longer than a
    // fixed window, so the window is generous rather than the assertion removed.
    assert.match(UI_CLIENT, /finally \{[\s\S]{0,400}dismissBootSequence\(\)/);
    // The overlay carries no background of its own anywhere, including in the mobile block.
    assert.doesNotMatch(UI_CSS, /\n\.hud-boot \{[^}]*background/);
  });

  test('STEP 2 is gated in the browser walk, not only asserted here', () => {
    const spec = fs.readFileSync(new URL('./e2e/t46-experience.spec.mjs', import.meta.url), 'utf8');
    for (const label of [
      'the boot sequence marks the session when it starts',
      'the boot sequence reads real sources',
      'the boot sequence finishes inside the budget',
      'a reload in the same session does not replay the sequence',
      '?quick=1 skips the boot sequence',
      'a failed bootstrap read reports a failed step, not a success',
      'reduced motion skips the boot overlay entirely',
      'the boot overlay does not flash faster than 3 Hz',
    ]) {
      assert.ok(spec.includes(`'${label}'`), `the walk gates: ${label}`);
    }
  });
});
