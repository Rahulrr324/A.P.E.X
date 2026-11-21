// T-37 Step 2 (2026-11-21): the 11-screen audit.
//
// Every screen declares a `data-screen-id` and a one-line `data-screen-message`. The brief named all 11;
// this suite requires exactly those 11, requires each message to exist and to be a sentence rather
// than a slogan, and - the part that actually catches drift - requires the element carrying each id to
// be a real element the client renders, not a marker added to satisfy a test.
import test from 'node:test';
import assert from 'node:assert/strict';

import { UI_PAGE, UI_CLIENT } from '../src/ui/assets.js';

const SCREENS = [
  'boot',
  'command-deck',
  'mission-view',
  'briefing',
  'workshop',
  'memory-timeline',
  'council',
  'presence-mesh',
  'sentinel',
  'policy-autonomy',
  'lockdown',
];

function screenDeclarations(html) {
  // Each declaration is an element that carries both attributes. They are read together so a screen
  // that has an id but no message - or a message on a different element - is not mistaken for a pass.
  const found = [];
  const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];
  for (const tag of tags) {
    const id = /\bdata-screen-id="([^"]+)"/.exec(tag);
    if (!id) continue;
    const message = /\bdata-screen-message="([^"]+)"/.exec(tag);
    found.push({ id: id[1], message: message ? message[1] : null, tag });
  }
  return found;
}

test('T-37 screens: all eleven canonical screens are declared, each exactly once', () => {
  const declared = screenDeclarations(UI_PAGE);
  const ids = declared.map((entry) => entry.id);
  assert.deepEqual([...ids].sort(), [...SCREENS].sort(),
    `the declared screens are ${ids.sort().join(', ')}`);
  assert.equal(new Set(ids).size, ids.length, 'a screen id is declared more than once');
});

test('T-37 screens: every screen carries a one-line message that says something', () => {
  const declared = screenDeclarations(UI_PAGE);
  for (const entry of declared) {
    assert.ok(entry.message, `${entry.id} declares no data-screen-message`);
    assert.ok(entry.message.length >= 40, `${entry.id}'s message is too short to say anything: "${entry.message}"`);
    assert.ok(entry.message.length <= 240, `${entry.id}'s message is longer than one line (${entry.message.length} chars)`);
    // A "line" means no newline and no markup: the attribute is text a reader sees.
    assert.equal(/[\r\n]/.test(entry.message), false, `${entry.id}'s message spans more than one line`);
    assert.equal(/[<>]/.test(entry.message), false, `${entry.id}'s message contains markup`);
    // It is a sentence, so it ends like one. This is what stops a placeholder from passing.
    assert.match(entry.message, /[.!]$/, `${entry.id}'s message is not a sentence: "${entry.message}"`);
  }
});

test('T-37 screens: each screen id is on a real element the client renders', () => {
  const declared = screenDeclarations(UI_PAGE);
  for (const entry of declared) {
    // The element must be one of the two things that can be a screen: the boot overlay, the deck's
    // main, a view section, or the safety panel. A marker on an arbitrary div would satisfy a naive
    // test and mean nothing.
    assert.match(entry.tag, /^<(main|section|div)\b/, `${entry.id} is declared on ${entry.tag.slice(0, 24)}…`);
    if (entry.id === 'command-deck') {
      assert.match(entry.tag, /^<main\b/, 'the command deck is the deck itself');
      assert.match(entry.tag, /class="deck"/);
    } else if (entry.id === 'boot') {
      assert.match(entry.tag, /^<div\b/);
      assert.match(entry.tag, /id="hud-boot-sequence"/);
    } else if (entry.id === 'lockdown') {
      // The lockdown screen is the safety panel that holds the latch, and it must be the real one:
      // the panel that also carries the lock and release forms.
      assert.match(entry.tag, /class="panel safety"/);
      assert.equal(UI_PAGE.includes('id="safety-lock"'), true, 'the safety panel must still hold the lock form');
      assert.equal(UI_PAGE.includes('id="safety-release"'), true, 'the safety panel must still hold the release form');
    } else {
      assert.match(entry.tag, /class="view"/, `${entry.id} is not on a view section`);
    }
  }
});

test('T-37 screens: each screen id maps to a view the navigation can reach', () => {
  // The eleven break down as: the boot overlay and the deck (not views), eight view sections, and the
  // safety panel that holds the latch. Counting them is what catches a screen added to the wrong kind
  // of element, or one that silently stopped being a view.
  const declared = screenDeclarations(UI_PAGE);
  const viewScreens = declared.filter((entry) => /class="view"/.test(entry.tag));
  assert.equal(viewScreens.length, 8, `expected eight view screens, found ${viewScreens.length}`);
  assert.equal(declared.length - viewScreens.length, 3, 'expected three non-view screens (boot, deck, safety panel)');
  for (const entry of viewScreens) {
    const view = /\bdata-view="([^"]+)"/.exec(entry.tag);
    assert.ok(view, `${entry.id} is on a view section with no data-view`);
    // A view the nav cannot reach would be a screen only a test can see.
    assert.ok(UI_PAGE.includes(`data-view="${view[1]}" class="nav-item"`),
      `${entry.id}'s view "${view[1]}" has no navigation button`);
    // And the view must be in the client's own order list, or a keyboard sweep would skip it.
    assert.ok(UI_CLIENT.includes(`'${view[1]}'`), `${entry.id}'s view "${view[1]}" is not in the client's VIEW_ORDER`);
  }
});

test('T-37 screens: the boot screen is still the cold-start overlay, not a splash', () => {
  // The screen id was added to an existing element. The behaviour that makes it the boot screen - the
  // sequence the T-36 tests drive - must be untouched by the label.
  assert.equal(UI_PAGE.includes('id="hud-boot-steps"'), true);
  assert.equal(UI_PAGE.includes('id="hud-boot-message"'), true);
  assert.match(UI_PAGE, /data-screen-message="The system waking and verifying readiness/);
});

test('T-37 screens: the panel that declares lockdown can actually latch', () => {
  // The declaration must sit on the panel whose controls are wired. Reading the client for the
  // handlers is what distinguishes a labelled screen from a relabelled one.
  for (const handler of ['safety-lock-form', 'safety-release-form']) {
    assert.equal(UI_CLIENT.includes(handler), true, `the client does not handle ${handler}`);
  }
});
