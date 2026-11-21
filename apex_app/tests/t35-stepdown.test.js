// T-35 Step 1 (2026-11-19): Part 4's visual step-down ladder, the flash guard, and the system
// sensor and privacy indicator.
//
// Three claims are tested here, and each one is tested against the artifact a browser would receive:
//
//   1. The ladder is a fixed, ordered table. Stage 0 is the full HUD, stage 5 is flat mode, each
//      stage names exactly which layers it drops, and no stage may drop the Core reticle.
//   2. The stage comes from real ResourceFabric telemetry through explicit thresholds, with an
//      operator override that is a presentation choice and never overwrites the machine's reading.
//   3. The served stylesheet cannot flash faster than three times a second, and the sensor
//      indicator reports what is actually wired: read-only sensors with their last read, and
//      microphone and camera disabled.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { UI_CSS, UI_PAGE, UI_CLIENT } from '../src/ui/assets.js';
import {
  FLASH_GUARD, HUD_SCHEMA, MAX_STAGE, PRESSURE_THRESHOLDS, SENSOR_SCHEMA, STEPDOWN_SCHEMA,
  VISUAL_STAGES, hudStatus, pressureFromTelemetry, resolveStepDown, sensorPrivacy,
} from '../src/ui/hud.js';
import { ResourceFabric } from '../src/resources/fabric.js';
import { createFakeBrowser, flushMicrotasks } from './helpers/fake-browser.js';

const TOKEN = 't35-stepdown-token-0123456789';
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1' };

function telemetryFor({ memoryUsedPercent = null, loadPerCpu1m = null } = {}) {
  const totalBytes = 8 * 1024 ** 3;
  return {
    schema: 'apex.resource-fabric/1',
    at: '2026-11-19T00:00:00.000Z',
    cpu: {
      logicalCount: 4,
      loadAverage1m: loadPerCpu1m === null ? null : loadPerCpu1m * 4,
      loadPerCpu1m,
      available: true,
    },
    memory: {
      totalBytes,
      freeBytes: memoryUsedPercent === null ? null : totalBytes * (1 - memoryUsedPercent),
      available: memoryUsedPercent !== null,
    },
    gpu: { available: false, reported: false, reason: 'NO_GPU_METADATA_PROVIDER' },
    network: { available: null, reported: false, reason: 'NO_NETWORK_TELEMETRY_PROVIDER' },
    storage: [],
    reservations: 0,
  };
}

async function withServer(run, { dataDir = null } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t35-hud-'));
  const app = createApp({ dataDir: dir });
  const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
  const started = await ui.start();
  try {
    return await run({ app, base: `http://127.0.0.1:${started.port}`, dir });
  } finally {
    await ui.stop().catch(() => {});
    if (dataDir === null) fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('T-35 the ladder is a fixed, ordered table', () => {
  test('six stages, exact drops, and stage 5 is flat mode', () => {
    assert.equal(VISUAL_STAGES.length, 6);
    assert.equal(MAX_STAGE, 5);
    assert.deepEqual(VISUAL_STAGES.map((entry) => entry.stage), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(VISUAL_STAGES.map((entry) => entry.name), [
      'nominal', 'drop_bloom', 'drop_particles', 'drop_parallax', 'drop_ambient_motion', 'flat_mode',
    ]);
    assert.deepEqual(VISUAL_STAGES.map((entry) => entry.dropped), [
      [],
      ['bloom'],
      ['bloom', 'particles'],
      ['bloom', 'particles', 'parallax'],
      ['bloom', 'particles', 'parallax', 'ambientMotion'],
      ['bloom', 'particles', 'parallax', 'ambientMotion', 'backdropBlur', 'panelTransitions'],
    ]);
    assert.equal(VISUAL_STAGES[0].tier, 'A');
    assert.equal(VISUAL_STAGES[5].tier, 'C');
    // The ladder is ordered: no stage may drop something a later stage keeps.
    for (let index = 1; index < VISUAL_STAGES.length; index += 1) {
      for (const dropped of VISUAL_STAGES[index - 1].dropped) {
        assert.ok(VISUAL_STAGES[index].dropped.includes(dropped), `stage ${index} keeps ${dropped}, which stage ${index - 1} dropped`);
      }
    }
  });

  test('no stage may drop the Core reticle, and flat mode keeps it explicitly', () => {
    for (const entry of VISUAL_STAGES) {
      const named = [entry.name, entry.summary, ...entry.dropped].join(' ').toLowerCase();
      assert.ok(!named.includes('reticle') || /reticle\b.*(stays|keeps|untouched|remains)/.test(named),
        `stage ${entry.stage} must not drop the reticle`);
      assert.notEqual(entry.layers.reticle, 'dropped');
    }
    assert.match(VISUAL_STAGES[5].summary, /Core state reticle stays active and legible/);
    // And the shipped stylesheet's flat-mode rule does not mention the reticle element.
    const flatRule = UI_CSS.slice(UI_CSS.indexOf('body[data-hud-flat="true"]'));
    assert.ok(!flatRule.slice(0, flatRule.indexOf('}')).includes('#core-reticle'),
      'flat mode must not restyle the Core reticle');
  });
});

describe('T-35 the stage comes from real telemetry, through explicit thresholds', () => {
  test('the thresholds are stated numbers', () => {
    assert.deepEqual(PRESSURE_THRESHOLDS.memoryUsedPercent, { elevated: 0.8, high: 0.9, critical: 0.96 });
    assert.deepEqual(PRESSURE_THRESHOLDS.loadPerCpu, { elevated: 1.5, high: 3, critical: 6 });
  });

  test('each level maps to its own rung, and both metrics are read', () => {
    const cases = [
      [{ memoryUsedPercent: 0.2, loadPerCpu1m: 0.2 }, 'nominal', 0],
      [{ memoryUsedPercent: 0.85, loadPerCpu1m: 0.2 }, 'elevated', 2],
      [{ memoryUsedPercent: 0.2, loadPerCpu1m: 1.6 }, 'elevated', 2],
      [{ memoryUsedPercent: 0.92, loadPerCpu1m: 0.2 }, 'high', 4],
      [{ memoryUsedPercent: 0.2, loadPerCpu1m: 3.5 }, 'high', 4],
      [{ memoryUsedPercent: 0.98, loadPerCpu1m: 0.2 }, 'critical', 5],
      [{ memoryUsedPercent: 0.2, loadPerCpu1m: 7 }, 'critical', 5],
    ];
    for (const [input, level, stage] of cases) {
      const read = pressureFromTelemetry(telemetryFor(input));
      assert.equal(read.level, level, `${JSON.stringify(input)} reads ${level}`);
      const resolved = resolveStepDown({ telemetry: telemetryFor(input) });
      assert.equal(resolved.auto.level, level);
      assert.equal(resolved.auto.stage, stage);
      assert.equal(resolved.effective.stage, stage);
      assert.equal(resolved.effective.source, 'auto');
      assert.ok(read.basis.length >= 2, 'the reading states its basis');
    }
  });

  test('the worse of the two metrics wins', () => {
    const read = pressureFromTelemetry(telemetryFor({ memoryUsedPercent: 0.91, loadPerCpu1m: 6.5 }));
    assert.equal(read.level, 'critical', 'load is past critical even though memory is only high');
  });

  test('unreadable telemetry is unknown, not nominal', () => {
    const resolved = resolveStepDown({ telemetry: { unavailable: 'resource fabric is not configured' } });
    assert.equal(resolved.auto.level, 'unknown');
    assert.equal(resolved.auto.source, 'telemetry-unavailable');
    assert.equal(resolved.effective.stage, 0, 'full HUD is the legible default, and the payload says unknown');
    assert.match(resolved.auto.pressure.basis.join(' '), /no telemetry|ResourceFabric/);
  });

  test('the operator override is applied, and it never rewrites the automatic reading', () => {
    const telemetry = telemetryFor({ memoryUsedPercent: 0.85, loadPerCpu1m: 0.2 });
    const overridden = resolveStepDown({ telemetry, override: 5 });
    assert.equal(overridden.auto.stage, 2, 'the machine still reads elevated');
    assert.equal(overridden.effective.stage, 5);
    assert.equal(overridden.effective.source, 'override');
    assert.equal(overridden.effective.name, 'flat_mode');
    assert.equal(overridden.override.applied, 5);
    assert.equal(overridden.override.invalid, null);

    const stringOverride = resolveStepDown({ telemetry, override: '3' });
    assert.equal(stringOverride.effective.stage, 3);

    const auto = resolveStepDown({ telemetry, override: 'auto' });
    assert.equal(auto.effective.stage, 2);
    assert.equal(auto.effective.source, 'auto');
  });

  test('an override outside the ladder is refused, not clamped into a stage that does not exist', () => {
    for (const bad of [6, -1, 2.5, 'six', 'stage-3']) {
      const resolved = resolveStepDown({ telemetry: telemetryFor({ memoryUsedPercent: 0.1 }), override: bad });
      assert.equal(resolved.override.invalid, String(bad));
      assert.equal(resolved.effective.source, 'auto');
      assert.equal(resolved.effective.stage, 0);
    }
  });

  test('the ResourceFabric reports the load average it now measures, and null when it cannot', async () => {
    const strained = new ResourceFabric({
      loadAverage: () => [12, 9, 7],
      totalMemory: () => 1000,
      freeMemory: () => 100,
      cpus: () => [1, 2, 3, 4],
      statfs: async () => ({ bsize: 1, bavail: 1, blocks: 2 }),
    });
    const telemetry = await strained.telemetry();
    assert.equal(telemetry.cpu.logicalCount, 4);
    assert.equal(telemetry.cpu.loadAverage1m, 12);
    assert.equal(telemetry.cpu.loadPerCpu1m, 3);
    assert.equal(pressureFromTelemetry(telemetry).level, 'high');

    const unreadable = new ResourceFabric({
      loadAverage: () => { throw new Error('no load average here'); },
      totalMemory: () => 0,
      freeMemory: () => 0,
      cpus: () => [],
      statfs: async () => ({}),
    });
    const blind = await unreadable.telemetry();
    assert.equal(blind.cpu.loadAverage1m, null, 'an unreadable load average is null, never zero');
    assert.equal(blind.cpu.loadPerCpu1m, null);
  });
});

describe('T-35 the flash guard: nothing may cycle faster than three times a second', () => {
  const MS_PER_SECOND = 1000;

  function durationsIn(css) {
    const found = [];
    const declaration = /(?:^|[;{\s])(-?animation(?:-duration)?|transition(?:-duration)?)\s*:\s*([^;{}]+)/g;
    let match;
    while ((match = declaration.exec(css)) !== null) found.push({ property: match[1], value: match[2].trim() });
    return found;
  }

  test('the guard is 334 ms, which is three cycles a second rounded down', () => {
    assert.equal(FLASH_GUARD.maxFlashesPerSecond, 3);
    // 334 ms is the first whole millisecond at or below three cycles a second; floor would allow
    // 3.003 cycles, which is over the limit.
    assert.equal(FLASH_GUARD.minIntervalMs, Math.ceil(MS_PER_SECOND / 3));
    assert.equal(FLASH_GUARD.minIntervalMs, 334);
  });

  test('every animation duration in the shipped stylesheet is at or above the guard', () => {
    const declarations = durationsIn(UI_CSS).filter((entry) => entry.property.startsWith('animation'));
    assert.ok(declarations.length >= 5, `the stylesheet still animates something (${declarations.length} declarations)`);
    for (const entry of declarations) {
      const times = [...entry.value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map((m) => (m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1])));
      for (const ms of times) {
        assert.ok(ms === 0 || ms >= FLASH_GUARD.minIntervalMs,
          `${entry.property}: ${entry.value} cycles in ${ms} ms, below the ${FLASH_GUARD.minIntervalMs} ms guard`);
      }
    }
  });

  test('the reticle cadence tokens the states use are all above the guard', () => {
    const tokens = [...UI_CSS.matchAll(/--state-spin-[a-z]+:\s*([\d.]+)s/g)].map((m) => Number(m[1]) * 1000);
    assert.ok(tokens.length >= 8, 'every reachable Core state declares a cadence');
    for (const ms of tokens) {
      assert.ok(ms === 0 || ms >= FLASH_GUARD.minIntervalMs, `a Core state cadence of ${ms} ms is faster than the guard`);
    }
    const keyframes = [...UI_CSS.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(keyframes)].sort(), ['breathe', 'particle-drift', 'spin']);
  });
});

describe('T-35 the sensor and privacy indicator reports what is wired', () => {
  test('host telemetry and git are named with their last read, and capture is disabled', () => {
    const sensor = sensorPrivacy({
      perception: {
        lastReading: {
          at: '2026-11-19T01:00:00.000Z',
          host: { cpu: { logicalCount: 4 } },
          workspace: { available: true, branch: 'arena/c4691a2f-a-p-e-x', head: 'ba8c508cad9232343714fd7c0b94acae9a995562' },
        },
        lastObservationAt: '2026-11-19T01:00:00.000Z',
      },
      workspaceConfigured: true,
      registryNames: ['memory.add', 'perception.state', 'perception.sense_host', 'cognition.run'],
    });
    assert.equal(sensor.schema, SENSOR_SCHEMA);
    assert.deepEqual(sensor.sensors.map((entry) => entry.id), ['host-telemetry', 'git-workspace']);
    for (const entry of sensor.sensors) {
      assert.equal(entry.readOnly, true);
      assert.equal(entry.active, true);
      assert.equal(entry.lastReadAt, '2026-11-19T01:00:00.000Z');
    }
    assert.equal(sensor.privacy.audio.state, 'disabled');
    assert.equal(sensor.privacy.camera.state, 'disabled');
    assert.deepEqual(sensor.privacy.captureCapabilities, []);
    assert.equal(sensor.privacy.capturePossible, false);
    assert.equal(sensor.capturesNothing, true);
    assert.match(sensor.sensors[1].detail, /arena\/c4691a2f-a-p-e-x at ba8c508cad92/, 'the head is shown as the reading stated it');
  });

  test('an unconfigured workspace is reported as having no git sensor, not as a clean tree', () => {
    const sensor = sensorPrivacy({ perception: null, workspaceConfigured: false, registryNames: [] });
    const git = sensor.sensors.find((entry) => entry.id === 'git-workspace');
    assert.equal(git.active, false);
    assert.equal(git.lastReadAt, null);
    assert.match(git.detail, /no workspace root is configured/);
    const host = sensor.sensors.find((entry) => entry.id === 'host-telemetry');
    assert.equal(host.lastReadAt, null);
    assert.match(host.detail, /no host reading has been recorded yet/);
  });

  test('a capture capability, if one were ever registered, is reported instead of hidden', () => {
    const sensor = sensorPrivacy({ registryNames: ['memory.add', 'audio.capture'] });
    assert.deepEqual(sensor.privacy.captureCapabilities, ['audio.capture']);
    assert.equal(sensor.privacy.capturePossible, true);
    assert.equal(sensor.capturesNothing, false);
  });
});

describe('T-35 /api/state carries the ladder and the indicator', () => {
  test('the snapshot reports a real stage, the whole ladder, and the sensor block', async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/state`, { headers: HEADERS });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.hud.schema, HUD_SCHEMA);
      const stepDown = body.hud.stepDown;
      assert.equal(stepDown.schema, STEPDOWN_SCHEMA);
      assert.ok(Number.isInteger(stepDown.auto.stage) && stepDown.auto.stage >= 0 && stepDown.auto.stage <= MAX_STAGE);
      assert.ok(['nominal', 'elevated', 'high', 'critical', 'unknown'].includes(stepDown.auto.level));
      assert.equal(stepDown.auto.source, stepDown.auto.level === 'unknown' ? 'telemetry-unavailable' : 'resource-fabric');
      assert.equal(stepDown.stages.length, 6);
      assert.deepEqual(stepDown.override.accepted, ['auto', 0, 1, 2, 3, 4, 5]);
      assert.equal(stepDown.flashGuard.minIntervalMs, 334);
      // The stage and the layers are the same answer, whichever one a reader starts from.
      const effective = stepDown.stages.find((entry) => entry.stage === stepDown.effective.stage);
      assert.deepEqual(stepDown.effective.layers, effective.layers);

      const sensor = body.hud.sensor;
      assert.equal(sensor.schema, SENSOR_SCHEMA);
      assert.equal(sensor.privacy.audio.state, 'disabled');
      assert.equal(sensor.privacy.camera.state, 'disabled');
      assert.deepEqual(sensor.sensors.map((entry) => entry.id), ['host-telemetry', 'git-workspace']);
      assert.deepEqual(sensor.privacy.captureCapabilities, [], 'nothing in the registry captures media');
      // A fresh data directory has no reading yet, and the page is told so rather than shown zeros.
      assert.equal(sensor.sensors[0].lastReadAt, null);
      assert.match(sensor.sensors[0].detail, /no host reading has been recorded yet/);
    });
  });

  test('a real host reading puts the timestamps and the git branch on the indicator', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t35-ws-'));
    fs.writeFileSync(path.join(workspace, 'README.md'), '# t35\n');
    // The git sensor reads a real repository, so the fixture is one. A committed HEAD is what the
    // sensor needs; an empty directory would honestly read as "not a repository".
    let gitRepo = true;
    try {
      const git = (args) => execFileSync('git', ['-C', workspace, '-c', 'user.email=t35@example.invalid',
        '-c', 'user.name=T35', ...args], { stdio: 'pipe' });
      git(['init', '-q', '-b', 'main']);
      git(['add', 'README.md']);
      git(['commit', '-q', '-m', 'T-35 sensor fixture']);
    } catch {
      gitRepo = false;
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t35-hud-'));
    try {
      const app = createApp({ dataDir, filesystemRoot: workspace });
      const sensed = await app.controller.runAction('perception.sense_host', { reason: 'T-35 sensor indicator' }, 'user', 'op1');
      assert.equal(sensed.outcome, 'success_verified', sensed.summary);
      const sensor = sensorPrivacy({
        perception: app.perception.state({ limit: 1 }),
        workspaceConfigured: true,
        registryNames: app.registry.list().map((entry) => entry.name),
      });
      const host = sensor.sensors.find((entry) => entry.id === 'host-telemetry');
      assert.ok(typeof host.lastReadAt === 'string' && !Number.isNaN(Date.parse(host.lastReadAt)));
      const gitSensor = sensor.sensors.find((entry) => entry.id === 'git-workspace');
      assert.equal(gitSensor.active, true);
      if (gitRepo) {
        assert.equal(gitSensor.available, true, gitSensor.detail);
        assert.match(gitSensor.detail, /^branch main at [0-9a-f]{7}/);
      } else {
        // No git binary in this environment: the indicator says the read could not be made rather
        // than claiming a clean tree.
        assert.equal(gitSensor.available, false);
        assert.match(gitSensor.detail, /could not be made/);
      }
      assert.deepEqual(sensor.privacy.captureCapabilities, []);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('T-35 the page carries the ladder and applies it', () => {
  test('the HUD markup has the stage badge, the override and the indicator', () => {
    for (const id of ['sensor-privacy-indicator', 'stepdown-select', 'stepdown-state', 'hud-particles']) {
      assert.ok(UI_PAGE.includes(`id="${id}"`), `the page carries #${id}`);
    }
    assert.match(UI_PAGE, /id="sensor-privacy-indicator"[^>]*data-audio="disabled"[^>]*data-camera="disabled"/);
    assert.match(UI_PAGE, /id="stepdown-select"[\s\S]*?value="auto"[\s\S]*?value="5"/);
    // The indicator is in the top bar, not somewhere the owner has to go looking for it.
    const topbar = UI_PAGE.slice(UI_PAGE.indexOf('<header class="topbar">'), UI_PAGE.indexOf('</header>'));
    assert.ok(topbar.includes('id="sensor-privacy-indicator"'));
    assert.ok(topbar.includes('id="stepdown-select"'));
  });

  test('the client applies the stage the reading names, and an override in the browser', async () => {
    const hud = hudStatus({
      telemetry: telemetryFor({ memoryUsedPercent: 0.92, loadPerCpu1m: 0.1 }),
      perception: null,
      workspaceConfigured: false,
      registryNames: [],
      now: () => new Date('2026-11-19T00:00:00.000Z'),
    });
    const routes = new Map([
      ['/api/state', { session: { id: 'session-t35', status: 'ok' }, turns: [], tasks: [], plans: [], goals: [], autonomy: { configured: {} }, resources: {}, hud }],
      ['/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' }],
      ['/api/health', { overall: 'healthy', areas: [] }],
    ]);
    const browser = createFakeBrowser({ routes });
    const context = vm.createContext(browser.sandbox, { name: 'apex-ui-client-t35' });
    vm.runInContext(UI_CLIENT, context, { filename: 'ui-client.js', displayErrors: true });
    const source = browser.events.sources.at(-1);
    source.open();
    source.emit('reconcile', {
      schema: 'apex.state-event/1',
      streamId: 'c'.repeat(32),
      seq: 3,
      at: '2026-11-19T00:00:00.000Z',
      type: 'reconcile',
      versions: {},
      payload: { reason: 'initial', snapshotUrl: '/api/state', owners: {} },
      correlationId: null,
    }, { lastEventId: `${'c'.repeat(32)}:3` });
    await flushMicrotasks();

    const body = browser.sandbox.document.body;
    assert.equal(body.dataset.stepdownStage, '4', 'memory at 92% is high pressure, which is stage 4');
    assert.equal(body.dataset.stepdownSource, 'auto');
    assert.equal(body.dataset.hudBloom, 'dropped');
    assert.equal(body.dataset.hudParticles, 'dropped');
    assert.equal(body.dataset.hudParallax, 'dropped');
    assert.equal(body.dataset.hudAmbient, 'dropped');
    assert.equal(body.dataset.hudFlat, 'false');
    assert.deepEqual(browser.events.pageErrors, []);
  });
});
