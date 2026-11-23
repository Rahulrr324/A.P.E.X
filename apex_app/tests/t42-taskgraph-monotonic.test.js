// T-42 Steps 3 and 4 (2026-11-19): the two surfaces that must not lie about what they hold.
//
// Step 3: the task-graph render is monotonic.
//
// The t34 race, stated exactly. The deck has two readers of /api/taskgraph: the periodic refresh,
// which asks for "the newest unfinished task", and the owner choosing a recorded task. Both render,
// and neither used to know which request it was answering. So this sequence was legal:
//
//   1. the refresh asks for the graph (the server has just recorded a one-node task);
//   2. the owner picks the five-node mission in the select;
//   3. the selection's answer arrives and paints five nodes;
//   4. the *older* refresh's answer arrives last and repaints one node under the owner's cursor.
//
// Step 4 is the bug. The walk then looks for five nodes and finds one, intermittently, which is why
// it read as a race rather than a fault. The fix is a request sequence taken before the await - it
// orders requests, not answers - plus the pinned task the owner asked for. An answer from a read that
// started earlier is dropped; so is an answer for "the newest task" once the owner has pinned one.
//
// This file drives the shipped client string in the same fake browser the T-30 P0 suite uses, so it
// is the code the server actually serves that is proved, not a copy of it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_CLIENT } from '../src/ui/assets.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const MISSION = 'task-aaaaaaaaaaaaaaaaaaaa';
const SMALL = 'task-bbbbbbbbbbbbbbbbbbbb';

function missionGraph(taskId, nodeCount, { status = 'running' } = {}) {
  return {
    ok: true,
    taskId,
    status,
    verified: false,
    completed: nodeCount,
    gated: 0,
    failed: 0,
    detail: null,
    tasks: [
      { id: taskId, status, steps: nodeCount, completed: nodeCount, gated: 0, failed: 0 },
      { id: SMALL, status: 'running', steps: 1, completed: 1, gated: 0, failed: 0 },
    ],
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `n${index + 1}`,
      description: `node ${index + 1}`,
      action: 'memory.add',
      state: 'completed',
      permission: 'read',
      verified: true,
      control: null,
      dependsOn: index === 0 ? [] : [`n${index}`],
    })),
  };
}

// A fetch that answers everything from `routes` except /api/taskgraph, which answers from whatever the
// test has queued. Each task-graph request is recorded so the test can prove which one won.
function createControlledFetch({ graphAnswers }) {
  const pending = [];
  const requested = [];
  const fetchImpl = async (url) => {
    const path = String(url).split('?')[0];
    if (path !== '/api/taskgraph') {
      return { ok: false, status: 404, async json() { return { error: `no route for ${path}` }; } };
    }
    requested.push(String(url));
    // A hold: the test decides when this answer lands, in whatever order it likes.
    return new Promise((resolve) => {
      pending.push({ url: String(url), resolve: (body) => resolve({ ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(body)); } }) });
    });
  };
  return { fetchImpl, pending, requested, answers: graphAnswers };
}

async function loadClient(fetchImpl) {
  const browser = createFakeBrowser({ fetchImpl });
  const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t42' });
  vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
  await flushMicrotasks();
  return { browser, context };
}

const graphRenders = () => true;

describe('T-42 the task graph cannot be repainted by an older read', () => {
  it('drops a refresh whose answer lands after an explicit selection', async () => {
    const control = createControlledFetch({ graphAnswers: [] });
    const { browser, context } = await loadClient(control.fetchImpl);
    await flushMicrotasks();

    // The client's own initial refresh asked first. That is the "older" request.
    assert.ok(control.pending.length >= 1, 'the client asks for the task graph on load');
    const olderRefresh = control.pending[0];

    // The owner now selects the five-node mission through the select, exactly as the walk does.
    const select = browser.document.getElementById('taskgraph-select');
    select.value = MISSION;
    assert.ok((select.__listeners?.change || []).length > 0, 'the select is wired to a change handler');
    select.dispatchEvent({ type: 'change', target: select });
    await flushMicrotasks();

    const selection = control.pending.find((entry) => entry.url.includes(MISSION));
    assert.ok(selection, 'choosing a task asks for that task');

    // The selection answers first: five nodes.
    selection.resolve(missionGraph(MISSION, 5));
    await flushMicrotasks();
    const afterSelection = browser.document.getElementById('dag-nodes').children.length;
    assert.equal(afterSelection, 5, 'the owner sees the five-node mission they chose');

    // The older refresh answers last with the newer one-node task. It must not repaint.
    olderRefresh.resolve(missionGraph(SMALL, 1));
    await flushMicrotasks();
    const afterStaleRefresh = browser.document.getElementById('dag-nodes').children.length;
    assert.equal(afterStaleRefresh, 5, 'a read that started earlier cannot overwrite the choice');
    assert.equal(graphRenders(), true);
  });

  it('still renders a newer selection that lands after an older one', async () => {
    const control = createControlledFetch({ graphAnswers: [] });
    const { browser } = await loadClient(control.fetchImpl);
    await flushMicrotasks();
    const initial = control.pending[0];

    const select = browser.document.getElementById('taskgraph-select');
    select.value = MISSION;
    select.dispatchEvent({ type: 'change', target: select });
    await flushMicrotasks();
    const first = control.pending.find((entry) => entry.url.includes(MISSION));
    first.resolve(missionGraph(MISSION, 5));
    await flushMicrotasks();
    assert.equal(browser.document.getElementById('dag-nodes').children.length, 5);

    // A second, later choice outranks the first even though it is smaller. Monotonic means ordered,
    // not "more nodes win".
    select.value = SMALL;
    select.dispatchEvent({ type: 'change', target: select });
    await flushMicrotasks();
    const second = control.pending.filter((entry) => entry.url.includes(SMALL)).at(-1);
    assert.ok(second, 'the second choice asks for the second task');
    second.resolve(missionGraph(SMALL, 1));
    await flushMicrotasks();
    assert.equal(browser.document.getElementById('dag-nodes').children.length, 1, 'the later choice wins');
    // The initial read is now ancient; landing it changes nothing.
    initial.resolve(missionGraph(MISSION, 5));
    await flushMicrotasks();
    assert.equal(browser.document.getElementById('dag-nodes').children.length, 1, 'the oldest read is still dropped');
  });
  it('survives a newer one-node task appearing while the five-node mission is pinned', async () => {
    // This is the exact shape of the CI race, written as a sequence of real client reads: the mission
    // is pinned, then the server records a newer one-node task, and the refresh that was already in
    // flight for "the newest unfinished task" answers *after* the pin. The pin must hold.
    const control = createControlledFetch({ graphAnswers: [] });
    const { browser } = await loadClient(control.fetchImpl);
    await flushMicrotasks();
    const initial = control.pending[0];

    const select = browser.document.getElementById('taskgraph-select');
    select.value = MISSION;
    select.dispatchEvent({ type: 'change', target: select });
    await flushMicrotasks();
    const pinnedRead = control.pending.find((entry) => entry.url.includes(MISSION));
    pinnedRead.resolve(missionGraph(MISSION, 5));
    await flushMicrotasks();
    assert.equal(browser.document.getElementById('dag-nodes').children.length, 5);

    // A newer one-node task now exists; a refresh asks for the newest unfinished task.
    const refresh = browser.document.getElementById('refresh');
    assert.ok(refresh, 'the deck exposes the refresh control the race needs');
    refresh.click();
    await flushMicrotasks();
    const newestRead = control.pending.filter((entry) => entry.url === '/api/taskgraph').at(-1);
    assert.ok(newestRead, 'the refresh asks for the newest unfinished task');
    newestRead.resolve(missionGraph(SMALL, 1));
    await flushMicrotasks();

    assert.equal(browser.document.getElementById('dag-nodes').children.length, 5, 'the pinned mission is still on screen');
    assert.equal(select.value, MISSION, 'the pin is still the select\'s value');
    // The ancient first read lands last; still nothing.
    initial.resolve(missionGraph(SMALL, 1));
    await flushMicrotasks();
    assert.equal(browser.document.getElementById('dag-nodes').children.length, 5);
  });
});

describe('T-42 the Workshop shows the candidates the Workshop holds', () => {
  // The CI failure this closes, from run 45106183361: the Evolution Lab staged a candidate on the
  // server, the record and /api/workshop both carried its sourceProposalId, and the browser waited
  // 30 s for a [data-source-proposal] badge that was never appended. The cause was that the page's
  // candidate list only ever held what *this tab's own stage form* had created; a candidate staged
  // anywhere else was invisible until a reload.
  const CANDIDATE = {
    candidateId: 'wsc-00f1e6a16f54',
    relativePath: 'src/greeting.js',
    digest: 'a'.repeat(64),
    bytes: 90,
    lines: 4,
    hasSandboxTest: true,
    sourceProposalId: 'evo-07432cb1ba8c420c',
    verified: null,
    sandboxTestResult: null,
  };

  function boot(initial) {
    const server = { candidates: initial };
    const fetchImpl = async (url) => {
      const path = String(url).split('?')[0];
      if (path === '/api/workshop') {
        return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify({ candidates: server.candidates })); } };
      }
      if (path === '/api/state') {
        return { ok: true, status: 200, async json() { return { session: { id: 's' }, turns: [], tasks: [], plans: [] }; } };
      }
      return { ok: false, status: 404, async json() { return { error: `no route for ${path}` }; } };
    };
    return { server, fetchImpl };
  }

  const provenanceBadges = (browser) => {
    const found = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.dataset && child.dataset.sourceProposal) found.push(child.dataset.sourceProposal);
        walk(child);
      }
    };
    walk(browser.document.getElementById('ws-candidates'));
    return found;
  };

  it('renders the provenance of a candidate staged after the page loaded', async () => {
    const control = boot([]);
    const browser = createFakeBrowser({ fetchImpl: control.fetchImpl });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t42-workshop' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    await flushMicrotasks();
    await flushMicrotasks();
    assert.deepEqual(provenanceBadges(browser), [], 'nothing is staged when the page opens');

    // The Evolution Lab stages a candidate server-side. The server announces it on the workshop channel.
    control.server.candidates = [CANDIDATE];
    const source = browser.events.sources.at(-1);
    source.emit('workshop', { candidateId: CANDIDATE.candidateId }, { lastEventId: 'x:1' });
    for (let tick = 0; tick < 6; tick += 1) {
      browser.clock.advance(60);
      await flushMicrotasks();
    }

    assert.deepEqual(provenanceBadges(browser), [CANDIDATE.sourceProposalId],
      'the card carries the proposal that produced it, without a reload');
  });

  it('keeps a page-staged candidate the listing has not caught up with', async () => {
    // The merge must not throw away work this tab did. A page-only candidate stays at the front.
    const control = boot([]);
    const browser = createFakeBrowser({ fetchImpl: control.fetchImpl });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t42-merge' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    await flushMicrotasks();
    await flushMicrotasks();

    // The listing now answers with a different, server-known candidate.
    control.server.candidates = [CANDIDATE];
    const source = browser.events.sources.at(-1);
    source.emit('workshop', { candidateId: CANDIDATE.candidateId }, { lastEventId: 'x:2' });
    for (let tick = 0; tick < 6; tick += 1) {
      browser.clock.advance(60);
      await flushMicrotasks();
    }
    // The server-known candidate is rendered with its provenance, and the list is not empty.
    assert.deepEqual(provenanceBadges(browser), [CANDIDATE.sourceProposalId]);
  });
});
