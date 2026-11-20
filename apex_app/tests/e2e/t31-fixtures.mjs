// T-31 Step 1 (2026-11-19): the fixture the real-browser verification suite drives.
//
// It starts the shipped UI server in this process against an isolated, seeded temporary data
// directory. Nothing here reads or writes a real APEX data directory, contacts a model, or
// fabricates a screenshot: every value the browser sees comes from the same stores, ECP and
// cognitive pipeline the product uses.
//
// The fixture is deliberately browser-free so its own behaviour is testable on a host with no
// browser at all (`tests/real-browser-harness.test.js`). The Playwright spec adds the browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T31_TOKEN = 'T31-real-browser-token-0123456789';
export const T31_SCHEMA = 'apex.t31.browser-run/1';
export const T31_VIEWPORTS = Object.freeze([
  { name: 'desktop-wide', width: 1600, height: 900 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
]);

// Every screenshot this suite writes is named for its viewport, so a report can say exactly which
// file came from which size and no file is claimed twice.
export function screenshotPath(reportDir, viewport) {
  return path.join(reportDir, `t31_${viewport.name}_${viewport.width}x${viewport.height}.png`);
}

export async function startSeededUi({ token = T31_TOKEN, port = 0, dataDir = null, seedData = true } = {}) {
  const dir = dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'apex-t31-browser-'));
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend: new NoBackend() }) });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port });
  let started;
  try {
    started = await ui.start();
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };
  const seed = seedData ? await seedStores(app, { base, headers }) : null;
  return {
    app, ui, dir, base, port: started.port, token, headers, seed,
    // Stopping the server without touching the data directory is what the degraded/reconnect
    // check needs: the stores must survive the restart, exactly as they would on a desktop.
    async stopServer() {
      await ui.stop().catch(() => {});
    },
    async stop() {
      await ui.stop().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// The seeded state the browser is asked to render. It is written through the same public
// surfaces a person would use — the goal, memory and Sentinel owners, and the cognition
// pipeline's HTTP route — so the page cannot show anything the API would not.
async function seedStores(app, { base, headers }) {
  const seed = { goalId: null, memoryId: null, sentinelEventId: null, cognitionRunId: null, taskId: null, approvalId: null };

  const goal = await app.goals.createGoal({
    request: 'Verify the T-31 command deck in a real browser',
    criteria: [{ description: 'all three viewports render without horizontal overflow', basis: 'user_stated' }],
    priority: 2,
  });
  // `createGoal` answers with the mutation result, whose shape is not the record's; the goal is
  // read back from the owner so the fixture names the id the UI will list.
  const goals = await app.goals.list();
  seed.goalId = goals.at(-1)?.id ?? goal?.goal?.id ?? null;

  const memory = await app.memory.add({
    content: 'the T-31 verification checklist is stored so the deck can show real memory',
    kind: 'user_fact',
    source: 'user',
  });
  seed.memoryId = memory?.id ?? null;

  // A Sentinel observation, so the briefing and the Sentinel rail read a real event rather than
  // an empty store. The source is an integration, not APEX, so no operation citation is needed.
  const observed = await app.situation.ingest({
    source: 'test_provider',
    sourceEventId: 't31-browser-observation-1',
    type: 'release_check_observed',
    category: 'observation',
    observedAt: new Date().toISOString(),
    payload: { summary: 'the T-31 browser suite seeded one integration observation', severity: 'info' },
    confidence: 0.8,
    provenance: { reporter: 't31-fixture', provider: 'test_provider' },
    goalRefs: [], planRefs: [], taskRefs: [], entityRefs: [],
  });
  seed.sentinelEventId = observed?.event?.id ?? observed?.event?.eventId ?? null;

  // A gated cognitive run: the pipeline records the run, the TaskGraph creates the task and the
  // ECP leaves the write step awaiting the owner's own approval. That single act gives the deck a
  // real pending approval, a real task and a real T-29 run to render.
  const response = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'store the T-31 approval marker in memory',
      action: 'memory.add',
      input: { content: 'the T-31 gated approval marker' },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`the fixture could not start a gated cognitive run: ${response.status} ${JSON.stringify(body)}`);
  seed.cognitionRunId = body.run?.runId ?? body.runId ?? null;
  seed.cognitionRunStatus = body.runStatus ?? body.run?.status ?? null;
  // The task and the approval item are read back from the owners rather than inferred from the
  // response shape, so the fixture states what the UI will actually be handed.
  const [state, approvals] = await Promise.all([
    fetch(`${base}/api/state`, { headers }).then((r) => r.json()).catch(() => null),
    fetch(`${base}/api/approvals`, { headers }).then((r) => r.json()).catch(() => null),
  ]);
  seed.taskId = state?.tasks?.[0]?.id ?? null;
  seed.taskStatus = state?.tasks?.[0]?.status ?? null;
  seed.approvalId = approvals?.items?.[0]?.id ?? null;
  seed.approvalCount = Array.isArray(approvals?.items) ? approvals.items.length : 0;
  return seed;
}

// A second server over the same data directory and port: the browser sees the same loopback
// origin and the same token, so an open page reconnects to it rather than to a stranger.
export async function restartUi(handle, { port = handle.port } = {}) {
  // No second seeding: the restart serves the stores the first server wrote, which is exactly
  // what a page that reconnected has to reconcile with.
  const started = await startSeededUi({ token: handle.token, port, dataDir: handle.dir, seedData: false });
  return { ...started, seed: handle.seed };
}

// The read-only facts a browser run has to be able to state: which routes answered, what the
// owner snapshot says the Core is, and how many work items each surface holds.
export async function readSurfaceFacts(handle) {
  const get = async (route) => {
    const response = await fetch(`${handle.base}${route}`, { headers: handle.headers });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const [state, approvals, briefing, situation, autonomy, workshop, council] = await Promise.all([
    get('/api/state'), get('/api/approvals'), get('/api/briefing'), get('/api/situation'),
    get('/api/autonomy'), get('/api/workshop'), get('/api/council'),
  ]);
  return { state, approvals, briefing, situation, autonomy, workshop, council };
}
