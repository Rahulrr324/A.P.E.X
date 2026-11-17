// T-11 acceptance tests. They drive the fabric, the situational service, the runtime, the CLI and the
// authenticated UI through public surfaces. Providers in most scenarios are the real adapters; the
// few test providers are explicit doubles for slow/failing/malformed cases and never reach a model.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { createUiServer } from '../src/ui/server.js';
import { DEFAULT_COMMON_CONFIG, PROVIDER_API_VERSION } from '../src/integrations/vocabulary.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const TOKEN = 't11-ui-token-0123456789abcdef';
const dirs = [];
const roots = [];
const servers = [];
const uis = [];

afterEach(async () => {
  while (uis.length) await uis.pop().stop().catch(() => {});
  while (servers.length) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
  }
  while (dirs.length) cleanup(dirs.pop());
  while (roots.length) {
    try { fs.rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function appOn(options = {}) {
  const dir = options.dataDir ?? makeTempDataDir();
  if (!options.dataDir) dirs.push(dir);
  const app = createApp({ dataDir: dir, ...options });
  app.__dir = dir;
  return app;
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t11-root-'));
  roots.push(root);
  return root;
}

const dataOf = (res) => res?.operation?.steps?.[0]?.result?.data ?? null;

async function rows(app, limit = 100) {
  return dataOf(await app.controller.situationEvents({ limit })).rows;
}

function observation(key, extra = {}) {
  return {
    key,
    type: 'service_status',
    summary: 'a service observation',
    payload: { summary: 'a service observation' },
    ...extra,
  };
}

function fakeProvider(id, poll, { permissions = ['network.outbound'], defaults = {} } = {}) {
  return {
    id,
    name: `Test provider ${id}`,
    apiVersion: PROVIDER_API_VERSION,
    permissions,
    defaults: { ...DEFAULT_COMMON_CONFIG, ...defaults },
    validate(config) { return { ...config }; },
    scopeOf() { return null; },
    async poll(ctx) { return poll(ctx); },
    describe() { return { id, name: `Test provider ${id}`, apiVersion: PROVIDER_API_VERSION, permissions, kind: 'test double', defaults: {} }; },
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function makeEntity(app, name = 'Observed project') {
  const res = await app.controller.worldWrite('world.entity.add', {
    category: 'project',
    name,
    evidence: [{ relation: 'supports', sourceType: 'user', sourceId: 'user' }],
  });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.output ?? res.display);
  const listed = await app.worldModel.listEntities({ limit: 50 });
  const entity = listed.entities.find((row) => row.name === name);
  assert.ok(entity);
  return entity.id;
}

describe('T-11 external event and integration fabric', () => {
  test('1: providers are registered, discoverable and versioned without connecting', async () => {
    const app = appOn();
    const providers = app.integrations.list();
    assert.deepEqual(providers.map((row) => row.id), ['filesystem', 'system_health', 'calendar', 'external_service']);
    for (const provider of providers) {
      assert.equal(provider.apiVersion, PROVIDER_API_VERSION);
      assert.ok(provider.permissions.length > 0);
      assert.ok(provider.kind);
    }
    await assert.rejects(() => app.integrations.enable('not_a_provider'), /unknown external provider/);
  });

  test('2: enabling and disabling controls whether a provider is polled', async () => {
    const app = appOn();
    const status = await app.integrations.status();
    assert.equal(status.enabled, 0);
    assert.ok(status.providers.every((row) => row.enabled === false));
    await app.integrations.enable('system_health');
    assert.equal((await app.integrations.status()).providers.find((row) => row.id === 'system_health').enabled, true);
    await app.integrations.disable('system_health');
    const polled = await app.integrations.poll('system_health', { force: true });
    assert.equal(polled.status, 'skipped');
    assert.equal(polled.reason, 'provider is disabled');
  });

  test('3: construction, listing and status start no poll and create no file', async () => {
    let calls = 0;
    const provider = fakeProvider('fake_inert', async () => {
      calls += 1;
      return { observations: [], checkpoint: {}, health: {} };
    });
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.list();
    await app.integrations.status();
    await app.integrations.diagnose();
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(app.__dir, 'integrations.json')), false);
  });

  test('4: a provider has an explicit configure, enable, poll and disable lifecycle', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'one.md'), 'one');
    const app = appOn();
    const configured = await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'], maxDepth: 1 });
    assert.equal(configured.config.roots[0], path.resolve(root));
    await app.integrations.enable('filesystem');
    const polled = await app.integrations.poll('filesystem', { force: true });
    assert.equal(polled.status, 'polled');
    assert.equal(polled.accepted, 1);
    const status = await app.integrations.status();
    const row = status.providers.find((provider) => provider.id === 'filesystem');
    assert.ok(row.health.lastAttemptAt);
    assert.ok(row.health.lastSuccessAt);
    await app.integrations.disable('filesystem');
    assert.equal((await app.integrations.status()).providers.find((provider) => provider.id === 'filesystem').enabled, false);
  });

  test('5: a valid observation is accepted and a malformed one is rejected without failing the provider', async () => {
    const provider = fakeProvider('fake_mixed', async () => ({
      observations: [
        observation('good-1'),
        { key: 'bad-1', type: 'Not Snake', summary: 'bad type' },
        null,
      ],
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.enable('fake_mixed');
    const result = await app.integrations.poll('fake_mixed', { force: true });
    assert.equal(result.status, 'polled');
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected, 2);
    assert.equal((await rows(app)).filter((row) => row.event.type === 'service_status').length, 1);
  });

  test('6: stable source identities turn a repeated observation into a duplicate, not a second event', async () => {
    const provider = fakeProvider('fake_stable', async () => ({
      observations: [observation('same-1')],
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.enable('fake_stable');
    const first = await app.integrations.poll('fake_stable', { force: true });
    const second = await app.integrations.poll('fake_stable', { force: true });
    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 1);
    assert.equal((await rows(app)).filter((row) => row.event.sourceEventId.includes('same-1')).length, 1);
  });

  test('7: repeated filesystem polling does not duplicate events', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'stable.md'), 'stable');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    const first = await app.integrations.poll('filesystem', { force: true });
    const second = await app.integrations.poll('filesystem', { force: true });
    assert.equal(first.accepted, 1);
    assert.equal(second.observed, 0);
    assert.equal((await rows(app)).length, 1);
  });

  test('8: a changed file produces a distinct modification observation', async () => {
    const root = tempRoot();
    const file = path.join(root, 'changed.md');
    fs.writeFileSync(file, 'first');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.integrations.poll('filesystem', { force: true });
    fs.writeFileSync(file, 'second state');
    const result = await app.integrations.poll('filesystem', { force: true });
    assert.equal(result.accepted, 1);
    const all = await rows(app);
    assert.deepEqual(all.map((row) => row.event.type).sort(), ['file_created', 'file_modified']);
    assert.equal(all.find((row) => row.event.type === 'file_modified').event.payload.file.path, 'changed.md');
  });

  test('9: out-of-order observations keep their own observed time and are not rewritten', async () => {
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    const provider = fakeProvider('fake_order', async () => ({
      observations: [
        observation('newer', { observedAt: new Date(now + 60_000).toISOString(), summary: 'newer observation', payload: { summary: 'newer observation' } }),
        observation('older', { observedAt: new Date(now - 60_000).toISOString(), summary: 'older observation', payload: { summary: 'older observation' } }),
      ],
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider], now: () => new Date(now) });
    await app.integrations.enable('fake_order');
    await app.integrations.poll('fake_order', { force: true });
    const all = await rows(app);
    assert.equal(all.length, 2);
    assert.equal(all.find((row) => row.event.sourceEventId.includes('older')).event.observedAt, new Date(now - 60_000).toISOString());
    assert.equal(all.find((row) => row.event.sourceEventId.includes('newer')).event.observedAt, new Date(now + 60_000).toISOString());
  });

  test('10: a stale observation is preserved as history but writes no current world fact', async () => {
    const app = appOn({ now: () => new Date('2026-11-17T12:00:00.000Z') });
    const entityId = await makeEntity(app, 'Stale target');
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        observations: [{ id: 'stale-1', type: 'service_status', summary: 'stale', value: 'old', observedAt: '2026-11-16T12:00:00.000Z', validUntil: '2026-11-16T13:00:00.000Z' }],
      }));
    });
    await app.integrations.configure('external_service', { endpoint: `${origin}/feed`, allowlist: [origin], entityId, predicate: 'service_state' });
    await app.integrations.enable('external_service');
    const result = await app.integrations.poll('external_service', { force: true });
    assert.equal(result.accepted, 1);
    const all = await rows(app);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].event.worldRefs, { skipped: 'expired' });
  });

  test('11: conflicting service facts remain visible instead of overwriting one another', async () => {
    const app = appOn();
    const entityId = await makeEntity(app, 'Service target');
    let value = 'ok';
    const { origin } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ observations: [{ id: 'state-1', type: 'service_status', summary: `state ${value}`, value, validUntil: '2099-01-01T00:00:00.000Z' }] }));
    });
    await app.integrations.configure('external_service', { endpoint: `${origin}/state`, allowlist: [origin], entityId, predicate: 'has_status' });
    await app.integrations.enable('external_service');
    await app.integrations.poll('external_service', { force: true });
    value = 'degraded';
    await app.integrations.poll('external_service', { force: true });
    const conflicts = await app.worldModel.conflicts();
    assert.ok(conflicts.counts.groups >= 1, 'the contradictory facts did not create a conflict group');
    assert.equal((await rows(app)).length, 2);
  });

  test('12: a provider timeout is reported as a failed poll, not a hang', async () => {
    const { origin } = await startServer((req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('{}'); }, 1000);
    });
    const app = appOn();
    await app.integrations.configure('external_service', { endpoint: `${origin}/slow`, allowlist: [origin], timeoutMs: 150 });
    await app.integrations.enable('external_service');
    const result = await app.integrations.poll('external_service', { force: true });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /timed out/i);
    assert.ok(result.retryAt);
  });

  test('13: a provider failure is isolated and a later success emits a recovery', async () => {
    let fail = true;
    let calls = 0;
    const provider = fakeProvider('fake_flaky', async () => {
      calls += 1;
      if (fail) throw new Error('temporary source failure');
      return { observations: [observation(`recovered-${calls}`)], checkpoint: {}, health: {} };
    });
    const app = appOn({ integrationProviders: [provider, fakeProvider('fake_healthy', async () => ({
      observations: [observation(`healthy-${calls}`)], checkpoint: {}, health: {},
    }))] });
    await app.integrations.enable('fake_flaky');
    await app.integrations.enable('fake_healthy');
    const first = await app.integrations.pollDue({ limit: 2 });
    assert.equal(first.polled.length, 1, 'the healthy provider was not polled alongside the failing one');
    assert.equal(first.skipped.some((row) => row.id === 'fake_flaky' && row.status === 'failed'), true);
    fail = false;
    const second = await app.integrations.poll('fake_flaky', { force: true });
    assert.equal(second.status, 'polled');
    const all = await rows(app);
    assert.ok(all.some((row) => row.event.type === 'provider_unavailable'));
    assert.ok(all.some((row) => row.event.type === 'provider_recovered'));
  });

  test('14: retry limits and exponential backoff are enforced', async () => {
    let calls = 0;
    const provider = fakeProvider('fake_broken', async () => {
      calls += 1;
      throw new Error('always unavailable');
    });
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.configure('fake_broken', { retry: { maxAttempts: 3, baseDelayMs: 100 } });
    await app.integrations.enable('fake_broken');
    const first = await app.integrations.poll('fake_broken', { force: true });
    assert.equal(first.attempts, 1);
    assert.ok(first.retryAt);
    const immediate = await app.integrations.poll('fake_broken');
    assert.equal(immediate.status, 'skipped');
    await app.integrations.poll('fake_broken', { force: true });
    await app.integrations.poll('fake_broken', { force: true });
    const exhausted = await app.integrations.poll('fake_broken');
    assert.equal(exhausted.status, 'skipped');
    assert.match(exhausted.reason, /retry limit/);
    assert.equal(calls, 3);
  });

  test('15: a bounded provider batch refuses to overflow one poll', async () => {
    const provider = fakeProvider('fake_many', async () => ({
      observations: Array.from({ length: 10 }, (_, index) => observation(`bulk-${index}`, { summary: `bulk observation ${index}`, payload: { summary: `bulk observation ${index}` } })),
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.configure('fake_many', { maxObservations: 2 });
    await app.integrations.enable('fake_many');
    const result = await app.integrations.poll('fake_many', { force: true });
    assert.equal(result.observed, 2);
    assert.equal(result.accepted, 2);
    assert.equal(result.truncated, true);
    assert.equal((await rows(app)).length, 2);
  });

  test('16: filesystem checkpoints persist and a new application does not replay old files', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'persisted.md'), 'persisted');
    const first = appOn();
    await first.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await first.integrations.enable('filesystem');
    await first.integrations.poll('filesystem', { force: true });
    const second = appOn({ dataDir: first.__dir });
    const status = await second.integrations.status();
    const row = status.providers.find((provider) => provider.id === 'filesystem');
    assert.equal(row.enabled, true);
    assert.ok(row.checkpoint.keys >= 1);
    const result = await second.integrations.poll('filesystem', { force: true });
    assert.equal(result.observed, 0);
    assert.equal((await rows(second)).length, 1);
  });

  test('17: a restart recovers the provider checkpoint and its health history', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'recover.md'), 'recover');
    const first = appOn();
    await first.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await first.integrations.enable('filesystem');
    const before = await first.integrations.poll('filesystem', { force: true });
    const second = appOn({ dataDir: first.__dir });
    const restored = await second.integrations.status();
    const row = restored.providers.find((provider) => provider.id === 'filesystem');
    assert.equal(row.health.accepted, before.accepted);
    assert.ok(row.health.lastSuccessAt);
    const again = await second.integrations.poll('filesystem', { force: true });
    assert.equal(again.duplicates + again.observed, 0);
  });

  test('18: a second concurrent poll is refused instead of duplicating work', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const provider = fakeProvider('fake_slow', async () => {
      await gate;
      return { observations: [], checkpoint: {}, health: {} };
    });
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.enable('fake_slow');
    const first = app.integrations.poll('fake_slow', { force: true });
    const second = await app.integrations.poll('fake_slow', { force: true });
    assert.equal(second.status, 'skipped');
    assert.match(second.reason, /already in flight/);
    release();
    assert.equal((await first).status, 'polled');
  });

  test('19: a broken provider does not prevent another provider from delivering observations', async () => {
    const app = appOn({ integrationProviders: [
      fakeProvider('fake_broken', async () => { throw new Error('broken'); }),
      fakeProvider('fake_working', async () => ({ observations: [observation('working-1')], checkpoint: {}, health: {} })),
    ] });
    await app.integrations.enable('fake_broken');
    await app.integrations.enable('fake_working');
    const result = await app.integrations.pollDue({ limit: 2 });
    assert.equal(result.polled.length, 1);
    assert.equal(result.accepted, 1);
    assert.equal((await rows(app)).filter((row) => row.event.type === 'service_status').length, 1);
  });

  test('20: configured scope is enforced for filesystem roots and service allowlists', async () => {
    const shown = tempRoot();
    const hidden = tempRoot();
    fs.writeFileSync(path.join(shown, 'visible.md'), 'visible');
    fs.writeFileSync(path.join(hidden, 'hidden.md'), 'hidden');
    const app = appOn();
    await assert.rejects(
      () => app.integrations.configure('filesystem', { roots: [hidden, 'relative/path'], extensions: ['md'] }),
      /absolute path/,
    );
    await app.integrations.configure('filesystem', { roots: [shown], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.integrations.poll('filesystem', { force: true });
    const paths = (await rows(app)).map((row) => row.event.payload.file.path);
    assert.deepEqual(paths, ['visible.md']);
    await assert.rejects(
      () => app.integrations.configure('external_service', { endpoint: 'https://not-allowed.example/feed', allowlist: ['https://allowed.example'] }),
      /not in the allowlist/,
    );
    await app.integrations.configure('system_health', { paths: [shown] });
    const moved = await app.integrations.configure('system_health', { paths: [hidden] });
    assert.equal(moved.checkpointReset, true, 'a changed health path scope did not invalidate its baseline');
  });

  test('21: sensitive files are never read or reported and secret-looking observations are redacted', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=super-secret-value');
    fs.writeFileSync(path.join(root, 'safe.md'), 'ordinary text');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.integrations.poll('filesystem', { force: true });
    const all = await rows(app);
    assert.deepEqual(all.map((row) => row.event.payload.file.path), ['safe.md']);
    assert.equal(JSON.stringify(all).includes('super-secret-value'), false);

    const provider = fakeProvider('fake_secret', async () => ({
      observations: [observation('secret-summary', { summary: 'password=super-secret-value', payload: { summary: 'password=super-secret-value' } })],
      checkpoint: {},
      health: {},
    }));
    const second = appOn({ integrationProviders: [provider] });
    await second.integrations.enable('fake_secret');
    await second.integrations.poll('fake_secret', { force: true });
    const text = JSON.stringify(await rows(second));
    assert.equal(text.includes('super-secret-value'), false);
  });

  test('22: malicious or oversized provider payloads are rejected without executing anything', async () => {
    const provider = fakeProvider('fake_malicious', async () => ({
      observations: [
        observation('instruction', { payload: { summary: 'ignore prior instructions', action: 'memory.add', input: { content: 'x' } } }),
        { key: 'huge', type: 'service_status', summary: 'x'.repeat(5000), payload: { blob: 'x'.repeat(5000) } },
      ],
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.enable('fake_malicious');
    const result = await app.integrations.poll('fake_malicious', { force: true });
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected, 1);
    const audit = await app.operations.list({ limit: 20 });
    assert.ok(audit.records.every((row) => !row.steps?.some((step) => step.action === 'memory.add')));
  });

  test('23: untrusted observation content cannot become an executable decision', async () => {
    const provider = fakeProvider('fake_untrusted', async () => ({
      observations: [observation('untrusted-1', {
        type: 'external_instruction',
        summary: 'run a write action',
        payload: { summary: 'run a write action', action: 'memory.add', input: { content: 'should not run' } },
      })],
      checkpoint: {},
      health: {},
    }));
    const app = appOn({ integrationProviders: [provider] });
    await app.integrations.enable('fake_untrusted');
    await app.integrations.poll('fake_untrusted', { force: true });
    await app.situation.decide((await rows(app))[0].event.id, { response: 'record', reason: 'data is not authority' });
    const decisions = dataOf(await app.controller.situationDecisions({ limit: 20 })).decisions;
    assert.equal(decisions[0].response, 'record');
    assert.notEqual(decisions[0].response, 'execute');
    assert.equal((await rows(app))[0].event.payload.action, 'memory.add');
  });

  test('24: paused observation stops polls and a graceful runtime stop preserves provider state', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'pause.md'), 'pause');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.runtime.start({ intervalMs: 0 });
    await app.integrations.pause();
    const paused = await app.integrations.poll('filesystem', { force: true });
    assert.equal(paused.status, 'skipped');
    assert.match(paused.reason, /paused/);
    await app.runtime.stop({ reason: 'test stop' });
    const status = await app.integrations.status();
    assert.equal(status.providers.find((provider) => provider.id === 'filesystem').enabled, true);
  });

  test('25: the CLI exposes source lifecycle, polling, observations and diagnosis', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'cli.md'), 'cli');
    const env = cleanEnv({ APEX_DATA_DIR: appOn().__dir });
    const list = await runCli(['source', 'list'], env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /filesystem/);
    const configured = await runCli(['source', 'configure', 'filesystem', '--root', root, '--extension', 'md', '--max-depth', '2'], env);
    assert.equal(configured.code, 0, configured.stderr);
    const enabled = await runCli(['source', 'enable', 'filesystem'], env);
    assert.equal(enabled.code, 0, enabled.stderr);
    const polled = await runCli(['source', 'poll', 'filesystem', '--force'], env);
    assert.equal(polled.code, 0, polled.stdout + polled.stderr);
    assert.match(polled.stdout, /1 accepted/);
    const observations = await runCli(['source', 'observations', '--provider', 'filesystem'], env);
    assert.equal(observations.code, 0, observations.stderr);
    assert.match(observations.stdout, /file_created/);
    const diagnose = await runCli(['source', 'diagnose'], env);
    assert.equal(diagnose.code, 0, diagnose.stdout + diagnose.stderr);
    assert.match(diagnose.stdout, /No inference process/);
    const paused = await runCli(['source', 'pause'], env);
    assert.equal(paused.code, 0, paused.stderr);
    const disabled = await runCli(['source', 'disable', 'filesystem'], env);
    assert.equal(disabled.code, 0, disabled.stderr);
  });

  test('26: the authenticated UI shows provider state without starting a poll', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'ui.md'), 'ui');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    const before = await app.integrations.status();
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    uis.push(ui);
    const stateResponse = await fetch(`http://127.0.0.1:${started.port}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.sources.enabled, 1);
    assert.equal(state.sources.providers.find((provider) => provider.id === 'filesystem').enabled, true);
    const direct = await fetch(`http://127.0.0.1:${started.port}/api/sources`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).providers.length, 4);
    const after = await app.integrations.status();
    assert.equal(after.totals.observed, before.totals.observed);
  });

  test('27: no inference handle, listener or model call is part of the fabric', async () => {
    const app = appOn();
    const report = await app.integrations.diagnose();
    assert.equal(report.checks.find((check) => check.name === 'inference').ok, true);
    assert.match(report.checks.find((check) => check.name === 'inference').detail, /no provider holds a model/);
    assert.equal(report.checks.find((check) => check.name === 'listener').ok, true);
    assert.equal(app.integrations.list().some((provider) => /model|inference/i.test(provider.name)), false);
  });

  test('28: an external observation travels through T-09 and the T-10 runtime in one tick', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'e2e.md'), 'end to end');
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.runtime.start({ intervalMs: 0 });
    const tick = await app.runtime.tick({ trigger: 'test' });
    assert.ok(tick.integrations);
    assert.ok(tick.integrations.accepted >= 1);
    const events = await rows(app);
    const file = events.find((row) => row.event.type === 'file_created');
    assert.ok(file, 'the external observation did not reach the situational log');
    assert.equal(file.event.source, 'external_provider');
    assert.equal(file.event.provenance.provider, 'filesystem');
    const decisions = dataOf(await app.controller.situationDecisions({ limit: 20 })).decisions;
    assert.ok(decisions.some((row) => row.eventId === file.event.id), 'the runtime did not decide the external event');
    assert.ok(file.assessment, 'the external event was not assessed');
    await app.runtime.stop({ reason: 'end-to-end complete' });
  });

  test('29: sustained polling is bounded and does not grow events or checkpoints without limit', async () => {
    const root = tempRoot();
    for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(root, `steady-${index}.md`), String(index));
    const app = appOn();
    await app.integrations.configure('filesystem', { roots: [root], extensions: ['md'] });
    await app.integrations.enable('filesystem');
    await app.integrations.poll('filesystem', { force: true });
    const eventCount = (await rows(app)).length;
    const checkpointBefore = (await app.integrations.status()).providers.find((provider) => provider.id === 'filesystem').checkpoint.keys;
    for (let index = 0; index < 20; index += 1) await app.integrations.poll('filesystem', { force: true });
    const after = await app.integrations.status();
    const provider = after.providers.find((row) => row.id === 'filesystem');
    assert.equal((await rows(app)).length, eventCount);
    assert.equal(provider.checkpoint.keys, checkpointBefore);
    assert.ok(provider.health.recent.length <= 20);
  });

  test('30: the existing runtime and situational contracts remain the only event path', async () => {
    const app = appOn();
    const status = await app.integrations.status();
    assert.equal(status.schema, 'apex.integrations/1');
    const situation = await app.situation.status();
    assert.equal(situation.available, true);
    const runtimeStatus = await app.runtime.status();
    assert.equal(runtimeStatus.integrations.enabled, 0);
    assert.equal(typeof app.runtime.tick, 'function');
    assert.equal(typeof app.controller.situationIngest, 'function');
  });
});

