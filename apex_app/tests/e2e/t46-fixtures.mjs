// T-46 Experience Pass (2026-11-19): the fixture the experience walk drives.
//
// T-46 changes no backend behaviour. Every number the walk measures - the height of the header, the
// centre of the Core, the document's scroll height, the number of pending approvals - is decided by the
// shipped page and the shipped client, so the fixture's whole job is to give them something real to
// render. It does that the way the T-31, T-45 and T-44 fixtures do:
//
//   * a real temporary data directory, never the owner's;
//   * a real git repository on disk, so the workspace reading is a reading and not a label;
//   * a real composed application with a `NoBackend` gateway, so nothing contacts a model;
//   * a real `createUiServer` on an ephemeral loopback port;
//   * seeding through the public surfaces a person would use - the goal, memory and situation owners,
//     and the cognition pipeline's HTTP route - so the page cannot show anything the API would not.
//
// The gated cognition run is what gives the deck a real pending approval, a real task and a real
// T-29 run. T-46's header strip counts pending approvals, and a strip that counts a fabricated number
// would be exactly the dishonesty this milestone exists to remove.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T46_TOKEN = 'T46-experience-pass-token-0123456789abcdef';
export const T46_SCHEMA = 'apex.t46.experience/1';

// The three viewports the acceptance gates name. A desktop is 1600x900, a laptop is 1280x720, and the
// phone is 390x844 - the same three the T-45 walk measured, so a regression between the milestones is
// the same measurement rather than a different one.
export const T46_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', width: 1600, height: 900, mobile: false }),
  Object.freeze({ name: 'laptop', width: 1280, height: 720, mobile: false }),
  Object.freeze({ name: 'phone', width: 390, height: 844, mobile: true }),
]);

// The T-46 acceptance gates, as numbers. They are exported rather than written into the spec so the
// baseline report, the spec and the CI annotation can all quote one definition: a gate that is stated in
// three places drifts in two of them.
export const T46_GATES = Object.freeze({
  headerMaxHeightPx: 64,
  coreCentreToleranceRatio: 0.05,
  deckMaxHeightScreens: 1,
  mobileBreakpointPx: 720,
  contrastMin: 4.5,
  // The boot sequence must finish - every line measured, not invented - inside four seconds, and no
  // single line may flash faster than 3 Hz (the T-30 flash guard's ceiling).
  bootMaxMs: 4_000,
  bootFlashMaxHz: 3,
  // A mode pair must differ in at least three of the five properties the brief names.
  modePropertiesRequired: 3,
  // The pixel-diff threshold for a mode pair: at least this fraction of sampled pixels must change.
  modePixelDiffRatio: 0.02,
  // Overlay tags are capped on screen; the cap is stated because "+k more" is a claim about the rest.
  overlayTagCap: 6,
  // Workshop zoom bounds, so "zoom" cannot be an unbounded transform.
  workshopZoomMin: 0.5,
  workshopZoomMax: 3,
});

// The labels the header keeps visible. Everything else moves into the measures popover - by id, so the
// client keeps writing to the same elements and no selector elsewhere in the tree has to change.
export const T46_HEADER_PRIMARY_IDS = Object.freeze(['clock', 'mode', 'connectivity', 'core-state-compact']);
export const T46_HEADER_POPOVER_IDS = Object.freeze([
  'session', 'autonomy', 'gauge-cpu', 'gauge-mem', 'gauge-storage', 'sensor-privacy-indicator', 'stepdown-state-compact',
]);

function git(cwd, args) {
  // No trim, for the reason the T-43, T-44 and T-45 fixtures give: porcelain's leading space is the whole
  // difference between a worktree edit and a staged one.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'APEX T-46',
      GIT_AUTHOR_EMAIL: 't46@apex.invalid',
      GIT_COMMITTER_NAME: 'APEX T-46',
      GIT_COMMITTER_EMAIL: 't46@apex.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export async function startT46Ui({ token = T46_TOKEN, port = 0 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t46-e2e-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'phase.js'), 'export const phase = 1;\n', 'utf8');
  await fsp.writeFile(path.join(workspace, 'README.md'), '# the T-46 workspace\n\nA real git repository.\n', 'utf8');

  git(workspace, ['init', '--quiet', '--initial-branch=main']);
  git(workspace, ['add', '--', 'README.md', 'src/phase.js']);
  git(workspace, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'T-46 fixture baseline']);
  const clean = git(workspace, ['status', '--porcelain=v1']);
  if (clean !== '') throw new Error(`the T-46 fixture baseline is not clean: ${JSON.stringify(clean)}`);
  const headSha = git(workspace, ['rev-parse', 'HEAD']).trim();
  // One worktree edit, so the git rail and the header's workspace reading both have something true to say.
  await fsp.writeFile(path.join(workspace, 'src', 'phase.js'), 'export const phase = 2;\n', 'utf8');

  const app = createApp({
    dataDir,
    filesystemRoot: workspace,
    gateway: new ModelGateway({ backend: new NoBackend() }),
  });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port });
  let started;
  try {
    started = await ui.start();
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };
  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (pathname, body = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const stop = async () => {
    await ui.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  const seed = await seedStores({ app, base, headers });

  // The deck opens on the boot sequence when `system.bootstrap.bootstrapped === false`, and a boot
  // sequence in flight is a layout in motion - the Core is Dormant, the sequence panel is up, and the
  // threshold below would measure the machine waking rather than the machine at rest. The fixture
  // therefore bootstraps the directory through the product's own governed route BEFORE the page opens,
  // which is also what puts a real bootstrap record in the store the boot-sequence walk later reads.
  // The boot sequence's own gates live in their own step and drive `?boot=1` (or an unseeded directory)
  // rather than relying on this one being absent.
  const bootstrap = await post('/api/system/bootstrap', { reason: 'T-46 fixture: settle the directory before measuring layout' });
  if (bootstrap.status !== 200 && bootstrap.status !== 201) {
    throw new Error(`the T-46 fixture could not bootstrap its data directory: ${bootstrap.status} ${JSON.stringify(bootstrap.body)}`);
  }
  seed.bootstrapStatus = bootstrap.status;

  return {
    app, ui, root, dataDir, workspace, base, token, headers, headSha, port: started.port, seed, stop, get, post,
    // Stopping the server without touching the data directory is what the degraded / reconnect check
    // needs: the stores survive the restart, exactly as they would on a desktop.
    async stopServer() {
      await ui.stop().catch(() => {});
    },
    async restart() {
      const again = createUiServer({ app, token, host: '127.0.0.1', port: started.port });
      const restarted = await again.start();
      return { base: `http://127.0.0.1:${restarted.port}` };
    },
    readJson: (name) => {
      const file = path.join(dataDir, name);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    lock: () => post('/api/safety/lockdown', { reason: 'T-46 walk: the latch overrides the presentation picker' }),
    release: () => post('/api/safety/release', { reason: 'T-46 walk: release fires nothing', confirm: true }),
    latchActive: () => app.registry.controlPlane.killSwitchStatus().active === true,
    url: (suffix = '') => `${base}/${suffix}?token=${encodeURIComponent(token)}`,
  };
}

// Seeded through the public surfaces. The gated run is the source of the pending approval the header
// counts, and the goal is one of the active missions the left rail lists beside the Core.
async function seedStores({ app, base, headers }) {
  const seed = { goalId: null, memoryId: null, sentinelEventId: null, cognitionRunId: null, taskId: null, approvalId: null };

  const goal = await app.goals.createGoal({
    request: 'Verify the T-46 experience pass in a real browser',
    criteria: [{ description: 'the deck fits one viewport and the Core is centred', basis: 'user_stated' }],
    priority: 2,
  });
  const goals = await app.goals.list();
  seed.goalId = goals.at(-1)?.id ?? goal?.goal?.id ?? null;

  const memory = await app.memory.add({
    content: 'the T-46 experience pass is measured, not asserted',
    kind: 'user_fact',
    source: 'user',
  });
  seed.memoryId = memory?.id ?? null;

  const observed = await app.situation.ingest({
    source: 'test_provider',
    sourceEventId: 't46-experience-observation-1',
    type: 'release_check_observed',
    category: 'observation',
    observedAt: new Date().toISOString(),
    payload: { summary: 'the T-46 walk seeded one integration observation', severity: 'info' },
    confidence: 0.8,
    provenance: { reporter: 't46-fixture', provider: 'test_provider' },
    goalRefs: [], planRefs: [], taskRefs: [], entityRefs: [],
  });
  seed.sentinelEventId = observed?.event?.id ?? observed?.event?.eventId ?? null;

  const response = await fetch(`${base}/api/cognition/run`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'store the T-46 approval marker in memory',
      action: 'memory.add',
      input: { content: 'the T-46 gated approval marker' },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(`the fixture could not start a gated cognitive run: ${response.status} ${JSON.stringify(body)}`);
  seed.cognitionRunId = body.run?.runId ?? body.runId ?? null;

  const [snapshot, approvals] = await Promise.all([
    fetch(`${base}/api/state`, { headers }).then((r) => r.json()).catch(() => null),
    fetch(`${base}/api/approvals`, { headers }).then((r) => r.json()).catch(() => null),
  ]);
  seed.taskId = snapshot?.tasks?.[0]?.id ?? null;
  seed.approvalId = approvals?.items?.[0]?.id ?? null;
  seed.approvalCount = Array.isArray(approvals?.items) ? approvals.items.length : 0;
  return seed;
}
