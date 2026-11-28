// T-43 Package 3 (2026-11-19): the HUD surfaces for the git executive and the host telemetry.
//
// Two halves, and both matter. The first is static: the markup declares every id the brief names, the
// stylesheet defines the classes the renderers use, and the client parses - which is the check that
// fails first when a backtick reaches the template literal. The second runs the real client under the
// fake browser against real server readings and asserts what is actually on screen, because a renderer
// that exists and never paints is not a surface.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

import { UI_PAGE, UI_CSS, UI_CLIENT } from '../src/ui/assets.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX Test', GIT_AUTHOR_EMAIL: 'apex@example.invalid',
      GIT_COMMITTER_NAME: 'APEX Test', GIT_COMMITTER_EMAIL: 'apex@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Relative luminance and contrast, so the accessibility claim is measured rather than asserted.
function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

// A 10% accent over the panel background, which is what the diff tints actually are.
function overlay(accent, alpha, base) {
  const a = [1, 3, 5].map((index) => parseInt(accent.slice(index, index + 2), 16));
  const b = [1, 3, 5].map((index) => parseInt(base.slice(index, index + 2), 16));
  const mixed = a.map((value, index) => Math.round(value * alpha + b[index] * (1 - alpha)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

describe('T-43 Package 3: the markup, the stylesheet and the client', () => {
  test('every element the brief names is in the page', () => {
    const required = [
      // Workshop: the git panel, its controls, the diff viewer and the checkpoint list.
      'workshop-git-panel', 'btn-git-refresh', 'git-diff-path-input', 'btn-git-diff-inspect',
      'git-checkpoint-label-input', 'btn-git-checkpoint-create', 'workshop-diff-viewer',
      'workshop-checkpoints-list',
      'git-branch-badge', 'git-head-badge', 'git-staged-badge', 'git-unstaged-badge',
      'git-untracked-badge', 'git-checkpoints-badge',
      'diff-file-header', 'diff-additions-badge', 'diff-deletions-badge', 'diff-hunks-badge', 'diff-body',
      // Sentinel: the telemetry panel, its badges and its two tables.
      'sentinel-telemetry-panel', 'edith-port-table', 'edith-process-table', 'btn-telemetry-refresh',
      'telemetry-total-badge', 'telemetry-loopback-badge', 'telemetry-exposure-badge',
      'telemetry-rss-badge', 'telemetry-status', 'edith-process-summary',
    ];
    for (const id of required) {
      assert.ok(UI_PAGE.includes(`id="${id}"`), `the page must declare #${id}`);
    }
  });

  test('the client parses as a function body and carries no template literal', () => {
    // The T-42 Step 4a failure: a backtick anywhere inside the template literal - a comment included -
    // ends UI_CLIENT early and the served script is a syntax error in the browser only.
    assert.equal((UI_CLIENT.match(/`/g) || []).length, 0, 'UI_CLIENT must contain no backtick');
    assert.doesNotThrow(() => new Function(UI_CLIENT), 'UI_CLIENT must parse as a function body');
    // UI_CSS is a stylesheet, not a script; the check that matters for it is that it is a non-empty
    // string with balanced braces, because an unbalanced brace would silently swallow every rule after it.
    assert.equal(typeof UI_CSS, 'string');
    assert.equal((UI_CSS.match(/{/g) || []).length, (UI_CSS.match(/}/g) || []).length, 'UI_CSS braces must balance');
  });

  test('the renderers and their controls are all defined', () => {
    for (const name of ['renderGitStatus', 'renderDiff', 'renderCheckpoints', 'renderTelemetry',
      'refreshGitPanel', 'refreshTelemetry', 'inspectDiff', 'createCheckpoint', 'restoreCheckpoint',
      'openCheckpointTrace', 'inspectCandidateDiff', 'checkpointActionTarget']) {
      assert.ok(UI_CLIENT.includes(`function ${name}(`), `the client must define ${name}`);
    }
    // The words the brief names, stated where the renderer writes them.
    for (const label of ["'REF INTACT'", "'REF DRIFT'", "'TOTAL PORTS: '", "'LOOPBACK ONLY: '",
      "'EXTERNAL EXPOSURE: '", "'APEX RSS: '"]) {
      assert.ok(UI_CLIENT.includes(label), `the client must render ${label}`);
    }
    for (const action of ["'restore-git-checkpoint'", "'trace-git-checkpoint'", "'diff-candidate'"]) {
      assert.ok(UI_CLIENT.includes(action), `the client must emit data-action ${action}`);
    }
    // The candidate control is inside the candidate renderer, so a reader finds it beside Promote and
    // Rollback rather than somewhere else on the screen. This is the Workshop invariant the brief names.
    const candidates = UI_CLIENT.slice(UI_CLIENT.indexOf('function renderCandidates('));
    const body = candidates.slice(0, candidates.indexOf('\nfunction ', 10));
    assert.ok(body.includes("'diff-candidate'"), 'renderCandidates must emit the diff-candidate control');
    assert.ok(body.indexOf("'diff-candidate'") > body.indexOf("'promote-candidate'"),
      'the diff control sits after Promote, where a reader looks for it');
  });

  test('the stylesheet defines the diff, telemetry and checkpoint classes', () => {
    for (const selector of ['.diff-viewer', '.diff-line-add', '.diff-line-del', '.diff-gutter-add',
      '.diff-gutter-del', '.telemetry-table', '.exposure-loopback', '.exposure-wildcard',
      '.checkpoint-ref-intact', '.checkpoint-ref-drift']) {
      assert.ok(UI_CSS.includes(selector), `the stylesheet must define ${selector}`);
    }
    // The tints are the two tokens the deck already uses for added and removed, not new colours
    // invented for this screen.
    assert.match(UI_CSS, /\.diff-line-add[^}]*rgba\(43,255,136/);
    assert.match(UI_CSS, /\.diff-line-del[^}]*rgba\(255,107,90/);
    assert.match(UI_CSS, /\.diff-gutter-add[^}]*--ok-green/);
    assert.match(UI_CSS, /\.diff-gutter-del[^}]*--armor-red-text/);
    // No horizontal overflow: the viewer scrolls inside its own box and the tables fix their layout,
    // so a long path wraps rather than widening the page.
    assert.match(UI_CSS, /\.diff-viewer[^}]*overflow-x:\s*auto/);
    assert.match(UI_CSS, /\.diff-table, \.telemetry-table[^}]*table-layout:\s*fixed/);
    assert.ok(UI_CSS.includes('@media (max-width: 720px)'), 'the narrow viewport rule must exist');
  });

  test('every foreground the new surfaces use clears 4.5:1 against what it sits on', () => {
    const background = '#05080f';
    const addTint = overlay('#2bff88', 0.10, background);
    const delTint = overlay('#ff6b5a', 0.10, background);
    const pairs = [
      ['body text on an added line', '#dcebff', addTint],
      ['body text on a deleted line', '#dcebff', delTint],
      ['the added-line gutter', '#2bff88', addTint],
      ['the deleted-line gutter', '#ff6b5a', delTint],
      ['a loopback row', '#2bff88', background],
      ['a wildcard row', '#ff6b5a', background],
      ['the interface-bound row', '#ffb000', background],
      ['a dim caption', '#7fa3c7', background],
    ];
    for (const [name, foreground, backdrop] of pairs) {
      const ratio = contrast(foreground, backdrop);
      assert.ok(ratio >= 4.5, `${name} measures ${ratio.toFixed(2)}:1, below the 4.5:1 floor`);
    }
  });
});

describe('T-43 Package 3: the client paints real readings', () => {
  // One real repository, one real app, one real server. The fake browser answers a GET from a reading
  // the server actually produced and forwards a POST to the server itself, so the restore the UI
  // performs here is the restore the product performs.
  let root;
  let dataDir;
  let server;
  let base;
  let headers;
  const token = 'T43-hud-token-0123456789';
  let checkpointId;
  let driftedId;

  before(async () => {
    root = tempDir('apex-hud-ws-');
    dataDir = tempDir('apex-hud-data-');
    git(root, ['init', '--quiet', '--initial-branch=main']);
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "hello";\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'one\ntwo\nthree\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial commit']);
    // One staged, two unstaged (one of them also modified in the index is avoided so the three counts
    // are unambiguous), one untracked.
    fs.writeFileSync(path.join(root, 'greeting.js'), 'export const greeting = "changed";\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'one\ntwo\nTHREE\n');
    fs.writeFileSync(path.join(root, 'fresh.txt'), 'untracked\n');

    const { createApp } = await import('../src/app.js');
    const { createUiServer } = await import('../src/ui/server.js');
    const { ModelGateway, NoBackend } = await import('../src/model/gateway.js');
    const app = createApp({ dataDir, filesystemRoot: root, modelGateway: new ModelGateway({ backend: new NoBackend() }) });
    server = createUiServer({ app, token });
    const started = await server.start();
    base = `http://127.0.0.1:${started.port}`;
    headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1', 'content-type': 'application/json' };

    const created = await (await fetch(`${base}/api/git/checkpoints`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'rendered card' }),
    })).json();
    checkpointId = created.checkpointId;
    // A second checkpoint whose ref is then moved, so the list must show one intact card and one drift.
    const second = await (await fetch(`${base}/api/git/checkpoints`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'will drift' }),
    })).json();
    driftedId = second.checkpointId;
    git(root, ['update-ref', second.refName, git(root, ['rev-parse', 'HEAD'])]);
  });

  after(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function bootClient() {
    const captures = new Map();
    const capture = async (route) => {
      const response = await fetch(base + route, { headers });
      captures.set(route, await response.json());
    };
    await capture('/api/git/status');
    await capture('/api/git/checkpoints');
    await capture('/api/git/diff?path=greeting.js');
    // The client asks for a bounded page, so the exact URL it uses is what is captured. A route
    // captured at a different query string would be a 404 in the harness and a blank panel on screen.
    await capture('/api/system/telemetry?limit=15');

    const browser = createFakeBrowser();
    const fallback = browser.sandbox.fetch;
    browser.sandbox.fetch = async (url, options) => {
      const route = String(url);
      if (options && options.method === 'POST') {
        // The body is fetched and parsed HERE, in the host realm, and json() hands back a plain
        // resolved value. An async json() would create a promise on the host realm that the vm's
        // await cannot settle, which is the harness's sharpest edge: the POST would be issued and the
        // caller would wait forever, looking exactly like a server that never answered.
        const response = await fetch(base + route, { method: 'POST', headers, body: options.body });
        const body = await response.json();
        // A thenable rather than a host Promise: the vm's await adopts it on its own microtask queue,
        // which is what lets the client's own continuation run under the test's clock.
        return { ok: response.ok, status: response.status, json() { return { then(resolve) { resolve(body); } }; } };
      }
      if (captures.has(route)) {
        const body = captures.get(route);
        return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(body)); } };
      }
      // A route captured without its query string still answers the bare path, so a client that drops
      // an optional parameter is not failed by the harness.
      const bare = route.split('?')[0];
      if (captures.has(bare)) {
        const body = captures.get(bare);
        return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(body)); } };
      }
      return fallback(url, options);
    };
    // The fake browser auto-creates a node for any id asked for, so the real ids are installed first -
    // otherwise a missing element would silently become an empty div and a broken renderer would pass.
    for (const match of UI_PAGE.matchAll(/id="([^"]+)"/g)) browser.document.getElementById(match[1]);
    // The override must survive context creation: createFakeBrowser sets sandbox.fetch, and the client
    // reads the global name, so the object the context is built from is the one that must carry it.
    vm.createContext(browser.sandbox);
    vm.runInContext(UI_CLIENT, browser.sandbox, { filename: 'apex-client.js' });
    await flushMicrotasks();
    // The refresh path settles over several turns of the virtual clock; the T-42 lesson is that
    // microtasks alone never finish it.
    for (let step = 0; step < 40; step += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
    }
    return browser;
  }

  function findByAction(node, action, out = []) {
    if (node?.dataset?.action === action) out.push(node);
    for (const child of node?.children ?? []) findByAction(child, action, out);
    return out;
  }

  function textOf(node, out = []) {
    out.push(String(node?.textContent ?? ''));
    for (const child of node?.children ?? []) textOf(child, out);
    return out;
  }

  test('the git panel shows the reading the server produced, badge by badge', async () => {
    const browser = await bootClient();
    const element = (id) => browser.document.getElementById(id);
    const text = (id) => String(element(id).textContent ?? '');
    try {
      assert.match(text('git-branch-badge'), /branch: main/);
      assert.match(text('git-head-badge'), /HEAD: [0-9a-f]{7}/);
      // The counts are the server's, asserted through the data attribute so a text match cannot pass on
      // a coincidence. Two files are modified in the worktree and one is untracked.
      assert.equal(element('git-unstaged-badge').dataset.count, '2');
      assert.equal(element('git-untracked-badge').dataset.count, '1');
      assert.equal(element('git-checkpoints-badge').dataset.count, '2');
      assert.equal(element('git-status-text').dataset.state, 'available');
      assert.equal(browser.events.consoleErrors.length, 0, 'the client must log no console error');
    } finally {
      assert.equal(browser.events.pageErrors.length, 0);
    }
  });

  test('the checkpoint list paints one REF INTACT card and one REF DRIFT card', async () => {
    const browser = await bootClient();
    const list = browser.document.getElementById('workshop-checkpoints-list');
    const cards = list.children ?? [];
    assert.equal(cards.length, 2, 'both checkpoints are on screen');

    const intact = cards.filter((card) => card.dataset.refIntact === 'true');
    const drifted = cards.filter((card) => card.dataset.refIntact === 'false');
    assert.equal(intact.length, 1);
    assert.equal(drifted.length, 1);

    assert.ok(textOf(intact[0]).join('|').includes('REF INTACT'), 'the intact card says so in words');
    assert.ok(textOf(drifted[0]).join('|').includes('REF DRIFT'), 'the drifted card says so in words');
    assert.match(textOf(intact[0]).join('|'), /[0-9a-f]{7}/, 'the card names a short commit sha');
    assert.ok(textOf(intact[0]).join('|').includes('rendered card'), 'the card names the label');

    // Every card carries both controls, and a drifted one is not restorable.
    const restores = findByAction(list, 'restore-git-checkpoint');
    const traces = findByAction(list, 'trace-git-checkpoint');
    assert.equal(restores.length, 2);
    assert.equal(traces.length, 2);
    assert.equal(restores.find((button) => button.dataset.checkpointId === driftedId)?.disabled, true,
      'a checkpoint whose ref drifted cannot be restored from the panel');
    assert.equal(restores.find((button) => button.dataset.checkpointId === checkpointId)?.disabled, false);
  });

  test('the diff viewer renders the hunks the server parsed, with both line numbers', async () => {
    const browser = await bootClient();
    const input = browser.document.getElementById('git-diff-path-input');
    input.value = 'greeting.js';
    // The harness dispatches on the control itself and its closest() is a stub, so the handler is
    // invoked the way a real click invokes it: with the control as the event target.
    for (const handler of browser.document.getElementById('btn-git-diff-inspect').__listeners.click ?? []) {
      handler({ type: 'click', target: browser.document.getElementById('btn-git-diff-inspect'), preventDefault() {} });
    }
    await flushMicrotasks();
    for (let step = 0; step < 10; step += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
    }
    assert.equal(browser.document.getElementById('workshop-diff-viewer').hidden, false);
    assert.match(String(browser.document.getElementById('diff-additions-badge').textContent), /^\+1$/);
    assert.match(String(browser.document.getElementById('diff-deletions-badge').textContent), /^-1$/);
    const rows = browser.document.getElementById('diff-body').children ?? [];
    assert.ok(rows.length > 0, 'the diff body carries rows');
    const types = rows.map((row) => row.dataset.lineType).filter(Boolean);
    assert.ok(types.includes('add'), 'an added line is on screen');
    assert.ok(types.includes('del'), 'a deleted line is on screen');
    // The added row tints with the ok-green class and the deleted row with the armor-red one; the class
    // is what carries the tint, so asserting it is asserting the colour without rendering.
    for (const row of rows) {
      if (row.dataset.lineType === 'add') assert.equal(row.className, 'diff-line-add');
      if (row.dataset.lineType === 'del') assert.equal(row.className, 'diff-line-del');
    }
    // And the two number columns are present on every row, even when one of them is blank.
    const sample = rows.find((row) => row.dataset.lineType === 'add');
    assert.equal(sample.children.length, 3, 'old number, new number, text');
  });

  test('the Sentinel telemetry panel paints the four badges and both tables', async () => {
    const browser = await bootClient();
    const element = (id) => browser.document.getElementById(id);
    assert.match(String(element('telemetry-total-badge').textContent), /TOTAL PORTS: \d+/);
    assert.match(String(element('telemetry-loopback-badge').textContent), /LOOPBACK ONLY: \d+/);
    assert.match(String(element('telemetry-exposure-badge').textContent), /EXTERNAL EXPOSURE: \d+/);
    assert.match(String(element('telemetry-rss-badge').textContent), /APEX RSS: (\d+ MB|unavailable)/);
    assert.ok((element('edith-port-table').children ?? []).length > 0, 'the port table has rows');
    assert.ok((element('edith-process-table').children ?? []).length > 0, 'the process table has rows');
    assert.equal(element('telemetry-status').dataset.state, 'available');

    // The exposure column is the classification, in words and in the colour class.
    const portRows = element('edith-port-table').children ?? [];
    for (const row of portRows) {
      const exposure = row.dataset.exposure;
      if (!exposure) continue;
      const classes = textOf(row).map((value) => value);
      const cell = (row.children ?? []).find((child) => /LOOPBACK ONLY|EXTERNAL EXPOSURE|INTERFACE BOUND/.test(String(child.textContent)));
      assert.ok(cell, `a port row must state its exposure: ${classes.join('|')}`);
      if (exposure === 'loopback') {
        assert.equal(String(cell.textContent), 'LOOPBACK ONLY');
        assert.equal(cell.className, 'exposure-loopback');
      }
      if (exposure === 'wildcard') {
        assert.equal(String(cell.textContent), 'EXTERNAL EXPOSURE');
        assert.equal(cell.className, 'exposure-wildcard');
      }
    }
  });

  test('a restore driven from the panel reaches the governed route and verifies', async () => {
    const browser = await bootClient();
    const list = browser.document.getElementById('workshop-checkpoints-list');
    const restore = findByAction(list, 'restore-git-checkpoint')
      .find((button) => button.dataset.checkpointId === checkpointId);
    assert.ok(restore, 'the intact checkpoint has a restore control');
    // The harness dispatches on the control itself, so the handler is called the way a real click
    // calls it: with the control as the event target.
    for (const handler of list.__listeners.click ?? []) {
      handler({ type: 'click', target: restore, preventDefault() {} });
    }
    // The restore is a POST followed by two reads, and every one of them is a promise the fake browser
    // resolves on a turn this test drives. The wait is on the LEDGER rather than on the text, because
    // the server is the authority on whether the act happened and a status line is a rendering of an
    // answer that may still be in flight.
    let restored = null;
    for (let step = 0; step < 80; step += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
      const checkpoints = await (await fetch(`${base}/api/git/checkpoints`, { headers })).json();
      restored = checkpoints.checkpoints.find((entry) => entry.checkpointId === checkpointId);
      if (restored?.restoreCount === 1) break;
    }
    assert.equal(restored?.restoreCount, 1, 'the restore the panel performed reached the ledger');
    assert.equal(restored.lastRestoredAt !== null, true);
    // And the file on disk holds the checkpointed bytes again.
    assert.match(fs.readFileSync(path.join(root, 'greeting.js'), 'utf8'), /changed/);

    // The client reports the act it performed. Read from the state the click set rather than from a
    // timer, so the assertion is about the rendering and not about how many turns it took.
    const statusText = String(browser.document.getElementById('git-checkpoint-status').textContent);
    const refusalText = String(browser.document.getElementById('git-checkpoint-refusal').textContent);
    assert.ok(/Restoring/.test(statusText) || /Restored/.test(statusText),
      `the status line must acknowledge the restore, not ignore it: "${statusText}"`);
    assert.equal(refusalText, '', 'no refusal was recorded for a restore that succeeded');
  });
});

describe('T-43 Package 3: a build with no workspace root', () => {
  // The defect CI found on run 45199263255. The three git reads answered 503 when the build had no
  // workspace root, and the client asks for them on boot - so every screen navigation logged a console
  // error, and t31 and t37 went red on a change that never touched them. A 503 is a statement about
  // the server; "this build has no repository" is a statement about the workspace, and it is a reading.
  let root;
  let server;

  before(async () => {
    const { createApp } = await import('../src/app.js');
    const { createUiServer } = await import('../src/ui/server.js');
    const { ModelGateway, NoBackend } = await import('../src/model/gateway.js');
    root = tempDir('apex-hud-noroot-');
    const app = createApp({ dataDir: root, modelGateway: new ModelGateway({ backend: new NoBackend() }) });
    server = createUiServer({ app, token: 'T43-noroot-token-0123456789' });
    const started = await server.start();
    server.base = `http://127.0.0.1:${started.port}`;
  });

  after(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the three git reads report an absence rather than a server fault', async () => {
    const headers = { authorization: 'Bearer T43-noroot-token-0123456789', 'x-apex-ui': '1' };
    for (const route of ['/api/git/status', '/api/git/diff', '/api/git/checkpoints']) {
      const response = await fetch(server.base + route, { headers });
      assert.equal(response.status, 200, `${route} must answer a reading, not 503`);
      const body = await response.json();
      assert.equal(body.isRepo, false, `${route} must say there is no repository`);
      assert.equal(body.reason, 'no_workspace_root', `${route} must say why`);
      // The read was available; what it found is that there is no repository. `available: false` would
      // mean the read itself could not be taken, which is the opposite of what happened.
      assert.equal(body.available, true);
      // Nothing is invented about a repository that is not there.
      assert.equal(body.branch, null);
      assert.equal(body.headSha, null);
    }
  });

  test('the whole client boots on such a build with no console error and no page error', async () => {
    // The regression proper: it is the boot, not the route, that CI measured.
    const headers = { authorization: 'Bearer T43-noroot-token-0123456789', 'x-apex-ui': '1' };
    const browser = createFakeBrowser();
    const failures = [];
    browser.sandbox.fetch = async (url, options = {}) => {
      const route = String(url);
      const response = await fetch(server.base + route, {
        method: options.method ?? 'GET',
        headers,
        body: options.method === 'POST' ? options.body : undefined,
      });
      const text = await response.text();
      if (response.status >= 500) failures.push({ route, status: response.status });
      // A thenable, not a host promise, so the vm's await adopts it on its own queue.
      return {
        ok: response.ok,
        status: response.status,
        json() { return { then(resolve, reject) { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } }; },
        text() { return { then(resolve) { resolve(text); } }; },
      };
    };
    for (const match of UI_PAGE.matchAll(/id="([^"]+)"/g)) browser.document.getElementById(match[1]);
    vm.createContext(browser.sandbox);
    vm.runInContext(UI_CLIENT, browser.sandbox, { filename: 'apex-client.js' });
    await flushMicrotasks();
    // The git panel is refreshed fire-and-forget, so the panel paints on a turn the test drives rather
    // than within a fixed number of them. Waiting on a count is how this passed here and failed on a
    // slower runner: the reads had not landed yet. The wait is on the paint itself.
    const panelPainted = () => String(browser.document.getElementById('git-status-text').textContent).length > 0;
    for (let step = 0; step < 200 && !panelPainted(); step += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
    }
    for (let step = 0; step < 10; step += 1) {
      browser.clock.advance(100);
      await flushMicrotasks();
    }
    assert.ok(panelPainted(), 'the git panel must paint before the boot is called settled');
    assert.deepEqual(failures, [], 'no route the boot asks for may answer 5xx');
    assert.deepEqual(browser.events.consoleErrors, [], 'the boot must log no console error');
    assert.deepEqual(browser.events.pageErrors, [], 'the boot must raise no uncaught exception');
    // And the panel states the absence rather than showing a blank or an error.
    const statusText = String(browser.document.getElementById('git-status-text').textContent);
    assert.match(statusText, /no target workspace|not a git repository|No repository/i);
    assert.equal(browser.document.getElementById('git-status-text').dataset.state, 'empty');
    // The telemetry panel is unaffected: a host reading needs no workspace root.
    assert.match(String(browser.document.getElementById('telemetry-total-badge').textContent), /TOTAL PORTS: \d+/);
  });
});
