// Implementation Batch S: read-only health for the persistent stores.
//
// `memory health` and `audit health` join the existing `knowledge health` as inspect-only
// views. They must state what was inspected, what was readable, what was damaged, and what
// they cannot prove. None of them writes, repairs, calls a model, or reads record contents
// into its summary, and one damaged store must not erase the report of another.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { MemoryStore, sha256Hex } from '../src/memory/memory-store.js';
import { OperationLog } from '../src/operations/operation-log.js';
import { OPERATION_SCHEMA, Outcome } from '../src/outcomes.js';
import { ModelGateway } from '../src/model/gateway.js';

const AT = '2026-01-01T00:00:00.000Z';
const MAX_HEALTH_SAMPLES = 20;

function tempDir() {
  return makeTempDataDir();
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`, 'utf8');
}

function memoryRecord({
  id,
  content,
  kind = 'user_fact',
  source = 'user',
  sensitivity = 'normal',
  provenance = { origin: 'user_request', updateMode: 'user_confirmed' },
}) {
  return {
    schema: 1,
    id,
    kind,
    source,
    sensitivity,
    content,
    contentSha256: sha256Hex(content),
    createdAt: AT,
    provenance,
  };
}

function operationRecord({
  id,
  status,
  capability = 'knowledge.add',
  requestedAt = AT,
  finishedAt = AT,
  extra = {},
}) {
  return {
    schema: OPERATION_SCHEMA,
    id,
    status,
    capability,
    origin: 'user',
    request: 'knowledge add [Engine -> fuel -> Coal]',
    // null means the field is absent, as a damaged or older write could leave it.
    ...(requestedAt === null ? {} : { requestedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    steps: [],
    ...extra,
  };
}

test('store health - empty stores are healthy, and inspection writes nothing', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = createApp({ dataDir: dir });

  const before = snapshot(dir);
  const memory = await app.controller.memoryHealth();
  const audit = await app.controller.auditHealth();
  const knowledge = await app.controller.knowledgeHealth();

  assert.equal(memory.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(memory.operation, null);
  assert.equal(memory.recorded, false);
  assert.equal(memory.health.inspected, true);
  assert.equal(memory.health.complete, true);
  assert.equal(memory.health.state, 'ok');
  assert.equal(memory.health.records, 0);
  assert.equal(memory.health.attention, false);
  assert.match(memory.display, /Store:\s+ok - empty store \(no memory records\)/);

  assert.equal(audit.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(audit.health.state, 'ok');
  assert.equal(audit.health.records, 0);
  assert.equal(audit.health.attention, false);
  assert.match(audit.display, /Store:\s+ok - empty log \(no operation records\)/);

  assert.equal(knowledge.health.state, 'ok');
  assert.equal(knowledge.health.attention, false);

  assert.deepEqual(snapshot(dir), before, 'no health view created or changed a file');

  const env = envFor(dir);
  const beforeCli = snapshot(dir);
  assert.equal((await runCli(['memory', 'health'], env)).code, 0);
  assert.equal((await runCli(['audit', 'health'], env)).code, 0);
  assert.equal((await runCli(['knowledge', 'health'], env)).code, 0);
  assert.deepEqual(snapshot(dir), beforeCli, 'the CLI health commands wrote nothing');
});

test('store health - memory counts cover kinds, provenance, corrections, and privacy', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'memory.jsonl');
  const original = memoryRecord({ id: '11111111-1111-4111-8111-111111111111', content: 'the project codename is Lighthouse' });
  writeLines(file, [
    original,
    memoryRecord({
      id: '22222222-2222-4222-8222-222222222222',
      content: 'the answer is probably yes',
      kind: 'model_conclusion',
      source: 'model',
      provenance: { updateMode: 'model_proposed' },
    }),
    memoryRecord({
      id: '33333333-3333-4333-8333-333333333333',
      content: 'my pin is kept at the bank',
      sensitivity: 'private',
    }),
    memoryRecord({
      id: '44444444-4444-4444-8444-444444444444',
      content: 'the project codename is Bluebird',
      provenance: { origin: 'user_memory_correction', updateMode: 'user_confirmed', replaces: [original.id] },
    }),
  ]);
  const before = snapshot(dir);
  const app = createApp({ dataDir: dir });

  const res = await app.controller.memoryHealth();
  const health = res.health;
  assert.equal(health.inspected, true);
  assert.equal(health.complete, true);
  assert.equal(health.records, 4);
  assert.deepEqual(health.kinds, { user_fact: 3, model_conclusion: 1 });
  assert.deepEqual(health.sources, { user: 3, model: 1 });
  assert.deepEqual(health.sensitivities, { normal: 3, private: 1 });
  assert.equal(health.privateRecords, 1);
  assert.equal(health.corrections, 1);
  assert.equal(health.replacedClaims, 1);
  assert.deepEqual(health.updateModes, { user_confirmed: 3, model_proposed: 1, unresolved_conflict: 0 });
  assert.equal(health.anomalies.count, 0);
  assert.equal(health.attention, false);
  assert.match(res.display, /user facts:\s+3/);
  assert.match(res.display, /model conclusions: 1/);
  assert.match(res.display, /private:\s+1 \(never sent to a model\)/);
  assert.match(res.display, /corrections:\s+1 \(replacing 1 claim\(s\)\)/);
  assert.match(res.display, /user_confirmed 3, model_proposed 1, unresolved_conflict 0/);
  assert.match(res.display, /does not prove the content is true/);

  // Counts are reported, content is not.
  assert.equal(JSON.stringify(health).includes('Lighthouse'), false);
  assert.equal(JSON.stringify(health).includes('Bluebird'), false);
  assert.equal(res.display.includes('my pin'), false);
  assert.deepEqual(snapshot(dir), before, 'the inspection wrote nothing');

  const cli = await runCli(['memory', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Records:\s+4 readable/);
});

test('store health - memory anomalies are reported and samples stay bounded', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'memory.jsonl');
  const records = [
    memoryRecord({ id: 'aaaaaaaa-1111-4111-8111-111111111111', content: 'first claim' }),
    memoryRecord({ id: 'aaaaaaaa-1111-4111-8111-111111111111', content: 'duplicate id claim' }),
    memoryRecord({
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      content: 'a claim that replaces nothing',
      provenance: { origin: 'user_memory_correction', updateMode: 'user_confirmed', replaces: ['cccccccc-3333-4333-8333-333333333333'] },
    }),
  ];
  const lines = records.map((record) => JSON.stringify(record));
  for (let i = 0; i < MAX_HEALTH_SAMPLES + 5; i += 1) lines.push('{not json');
  writeLines(file, lines);

  const res = await createApp({ dataDir: dir }).controller.memoryHealth();
  const health = res.health;
  assert.equal(health.inspected, true);
  assert.equal(health.complete, false, 'damage means inspection is incomplete');
  assert.equal(health.state, 'damaged');
  assert.equal(health.corruptLines, MAX_HEALTH_SAMPLES + 5);
  assert.equal(health.records, 3, 'readable records are counted exactly');
  assert.equal(health.anomalies.count, 2, 'duplicate id and a dangling replacement link');
  assert.equal(health.attention, true);
  assert.match(res.display, /damaged - 25 corrupt line\(s\); inspection incomplete/);
  assert.match(res.display, /counts cover readable records only; corrupt lines could change every count/);
  assert.match(res.display, /- 5 more corrupt line\(s\) not shown/);

  const cli = await runCli(['memory', 'health'], envFor(dir));
  assert.equal(cli.code, 1, 'damage requires attention');
  assert.equal((cli.stdout.match(/line \d+: /g) ?? []).length, MAX_HEALTH_SAMPLES, 'the display is bounded');
});

test('store health - an unreadable store is unavailable, never empty', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  // A directory where the log file should be makes the read fail rather than return
  // "no records".
  fs.mkdirSync(path.join(dir, 'memory.jsonl'));

  const app = createApp({ dataDir: dir });
  const res = await app.controller.memoryHealth();
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.equal(res.health.inspected, false);
  assert.equal(res.health.state, 'unavailable');
  assert.equal(res.health.records, null);
  assert.equal(res.health.attention, true);
  assert.match(res.display, /Store:\s+unavailable/);
  assert.match(res.display, /an unreadable store is not an empty store/);

  // The other stores are unaffected by this one.
  const knowledge = await app.controller.knowledgeHealth();
  assert.equal(knowledge.health.state, 'ok');
  assert.equal(knowledge.health.inspected, true);
  const audit = await app.controller.auditHealth();
  assert.equal(audit.health.state, 'ok');

  const env = envFor(dir);
  assert.equal((await runCli(['memory', 'health'], env)).code, 1);
  assert.equal((await runCli(['knowledge', 'health'], env)).code, 0);
  assert.equal((await runCli(['audit', 'health'], env)).code, 0);
});

test('store health - audit counts outcomes, reports anomalies, and states its integrity limit', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'operations.jsonl');
  writeLines(file, [
    operationRecord({ id: 'op-1', status: Outcome.SUCCESS_VERIFIED }),
    operationRecord({ id: 'op-1', status: Outcome.INPUT_REJECTED }),
    operationRecord({ id: 'op-2', status: Outcome.SUCCESS_VERIFIED, requestedAt: null, finishedAt: 'not-a-date' }),
  ]);
  const before = snapshot(dir);
  const app = createApp({ dataDir: dir });

  const res = await app.controller.auditHealth();
  const health = res.health;
  assert.equal(health.inspected, true);
  assert.equal(health.complete, true, 'every line parsed, even though records disagree');
  assert.equal(health.records, 3);
  assert.equal(health.outcomes[Outcome.SUCCESS_VERIFIED], 2);
  assert.equal(health.outcomes[Outcome.INPUT_REJECTED], 1);
  assert.equal(health.anomalies.count, 3, 'duplicate id, missing timestamp, invalid timestamp');
  assert.deepEqual(health.integrity, { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false });
  assert.equal(health.attention, true);
  assert.match(res.display, /success_verified 2, input_rejected 1/);
  assert.match(res.display, /There is no hash chain, signature, or external anchor/);
  assert.match(res.display, /does not prove authenticity and deliberate editing cannot be detected/);
  assert.match(res.display, /writes no audit record and displays no request or output body/);
  assert.deepEqual(snapshot(dir), before, 'audit health writes no audit record');

  const cli = await runCli(['audit', 'health'], envFor(dir));
  assert.equal(cli.code, 1, 'structural anomalies require attention even though every line parsed');
  assert.match(cli.stdout, /Integrity:\s+parse-only/);
});

test('store health - audit health never exposes request or output bodies', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'operations.jsonl');
  writeLines(file, [
    operationRecord({
      id: 'op-1',
      status: Outcome.SUCCESS_VERIFIED,
      extra: {
        request: 'remember privately that the launch code is 0000',
        output: 'the model said: the launch code is 1234',
        steps: [{ action: 'memory.add', summary: 'stored private request' }],
      },
    }),
  ]);
  const app = createApp({ dataDir: dir });

  const res = await app.controller.auditHealth();
  assert.equal(res.health.records, 1);
  assert.equal(res.display.includes('launch code'), false);
  assert.equal(res.display.includes('1234'), false);
  assert.equal(JSON.stringify(res.health).includes('launch code'), false);

  const cli = await runCli(['audit', 'health'], envFor(dir));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stdout.includes('launch code'), false);
  assert.equal(cli.stderr.includes('launch code'), false);
});

test('store health - damaged and truncated audit storage is reported truthfully', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'operations.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify(operationRecord({ id: 'op-1', status: Outcome.SUCCESS_VERIFIED }))}\n{not json\n{"schema":1`,
    'utf8',
  );
  const app = createApp({ dataDir: dir });

  const res = await app.controller.auditHealth();
  const health = res.health;
  assert.equal(health.state, 'damaged');
  assert.equal(health.complete, false);
  assert.equal(health.records, 1);
  assert.equal(health.corruptLines, 2);
  assert.equal(health.attention, true);
  assert.equal(health.corrupt[0].truncatedTail, false);
  assert.equal(health.corrupt[1].truncatedTail, true, 'an unterminated final line is identified as such');
  assert.match(res.display, /line 3: invalid JSON \(final line without a newline\)/);
  assert.match(res.display, /incomplete: counts cover readable records only/);

  const cli = await runCli(['audit', 'health'], envFor(dir));
  assert.equal(cli.code, 1, 'parse damage requires attention');
});

test('store health - an unreadable audit log is unavailable, never empty', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, 'operations.jsonl'));
  const log = new OperationLog(path.join(dir, 'operations.jsonl'));
  const health = await log.health();
  assert.equal(health.inspected, false);
  assert.equal(health.state, 'unavailable');
  assert.equal(health.records, null);
  assert.equal(health.outcomes, null);
  assert.deepEqual(health.integrity, { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false });
  assert.equal(health.attention, true);

  const app = createApp({ dataDir: dir });
  const res = await app.controller.auditHealth();
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.match(res.display, /an unreadable log is not an empty log/);
});

test('store health - one damaged store does not erase the others or block deterministic work', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, 'knowledge.jsonl'), '{not json}\n', 'utf8');
  writeLines(path.join(dir, 'memory.jsonl'), [
    memoryRecord({ id: 'dddddddd-4444-4444-8444-444444444444', content: 'the project codename is Lighthouse' }),
  ]);
  writeLines(path.join(dir, 'operations.jsonl'), [
    operationRecord({ id: 'op-1', status: Outcome.SUCCESS_VERIFIED }),
  ]);

  const app = createApp({ dataDir: dir });
  const knowledge = await app.controller.knowledgeHealth();
  assert.equal(knowledge.health.state, 'damaged');
  assert.equal(knowledge.health.claims, 0);
  assert.equal(knowledge.health.corruptLines, 1);
  assert.equal(knowledge.health.attention, true);

  const memory = await app.controller.memoryHealth();
  assert.equal(memory.health.state, 'ok');
  assert.equal(memory.health.records, 1);
  assert.equal(memory.health.attention, false);
  assert.equal(memory.status, Outcome.SUCCESS_VERIFIED);

  const audit = await app.controller.auditHealth();
  assert.equal(audit.health.state, 'ok');
  assert.equal(audit.health.records, 1);

  const env = envFor(dir);
  assert.equal((await runCli(['knowledge', 'health'], env)).code, 1);
  assert.equal((await runCli(['memory', 'health'], env)).code, 0);
  assert.equal((await runCli(['audit', 'health'], env)).code, 0);

  // A deterministic built-in action does not depend on the damaged knowledge store.
  const calc = await runCli(['ask', 'calc', '6*7'], env);
  assert.equal(calc.code, 0, calc.stdout + calc.stderr);
  assert.match(calc.stdout, /42/);
});

test('store health - knowledge health keeps its existing counts and adds resolution status', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const app = createApp({ dataDir: dir });

  const coal = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Coal' });
  const diesel = await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Diesel' });
  const coalId = coal.operation.steps[0].result.data.id;
  const dieselId = diesel.operation.steps[0].result.data.id;
  await app.controller.knowledgeResolve({ target: coalId, choose: dieselId });

  const resolved = await app.controller.knowledgeHealth();
  assert.equal(resolved.health.claims, 2);
  assert.equal(resolved.health.resolutions, 1);
  assert.equal(resolved.health.retractions, 0);
  assert.equal(resolved.health.lifecycleEvents, 1);
  assert.equal(resolved.health.conflicts.groups, 0, 'a resolved group is not unresolved');
  assert.equal(resolved.health.conflicts.resolvedGroups, 1);
  assert.equal(resolved.health.conflicts.resolvedClaims, 2);
  assert.equal(resolved.health.attention, false);
  assert.equal((await runCli(['knowledge', 'health'], envFor(dir))).code, 0);

  // A new claim that joins the group reopens it; the decision remains in the history.
  await app.controller.knowledgeAdd({ subject: 'Engine', relationship: 'fuel', object: 'Hydrogen' });
  const reopened = await app.controller.knowledgeHealth();
  assert.equal(reopened.health.conflicts.groups, 1);
  assert.equal(reopened.health.conflicts.resolvedGroups, 0);
  assert.equal(reopened.health.attention, true);
  assert.equal((await runCli(['knowledge', 'health'], envFor(dir))).code, 1);
});

test('store health - memory and audit health never consult a model', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  let calls = 0;
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    complete: async () => {
      calls += 1;
      return {
        ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double',
        text: '{}', finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  const app = createApp({ dataDir: dir, gateway: new ModelGateway({ backend }) });
  await app.controller.memoryHealth();
  await app.controller.auditHealth();
  await app.controller.knowledgeHealth();
  assert.equal(calls, 0);

  const env = envFor(dir);
  await runCli(['memory', 'health'], env);
  await runCli(['audit', 'health'], env);
  await runCli(['knowledge', 'health'], env);
  assert.equal(calls, 0);
});

test('store health - memory health works without an app (store-level contract)', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const file = path.join(dir, 'memory.jsonl');
  writeLines(file, [memoryRecord({ id: 'eeeeeeee-5555-4555-8555-555555555555', content: 'a stored fact' })]);

  const store = new MemoryStore(file);
  const health = await store.health();
  assert.equal(health.inspected, true);
  assert.equal(health.records, 1);
  assert.equal(health.state, 'ok');

  fs.writeFileSync(file, 'not json\n', 'utf8');
  const damaged = await store.health();
  assert.equal(damaged.state, 'damaged');
  assert.equal(damaged.records, 0);
  assert.equal(damaged.corruptLines, 1);
  assert.equal(damaged.attention, true);
});
