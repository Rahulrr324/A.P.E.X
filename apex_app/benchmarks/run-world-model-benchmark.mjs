// Bounded, model-free benchmark for the World Model, Entity Memory and Evidence Graph.
//
// It measures APEX's own paths against synthetic fixtures in fresh temporary data directories.
// No inference is run or simulated: every application is built with NoBackend, and no read below
// asks a model anything. This is not part of `npm test` and no test depends on it.
//
//   node benchmarks/run-world-model-benchmark.mjs [--repeats R] [--phase P] [--keep]
//
// Phases, run in order unless one is selected:
//   reads       what a store read costs at progressive log sizes, as the public reads are called.
//   analysis    the derived reads that do more than one pass: traversal, contradiction analysis,
//               identity candidates, entity history, changes, historical reconstruction, and the
//               bounded prompt section.
//   writes      one append in parts: raw JSONL append, uncontended lock, entity/fact/relationship/
//               event/retraction writes, and the same through the authorized action layer.
//   contention  1, 2 and 4 real child processes creating entities in one log from a shared start.
//   context     what the bounded world-model section adds to a prompt, and which requests pay.
//
// The fixture is written as records in the store's own validated shape rather than through the
// write paths, so a read still validates and reduces every line the same way a real log is read,
// while the seeding cost stays out of the measurement. Every fixture line is checked with the
// store's validator as it is produced, so a line no reader would accept cannot become a fast number.
// The fixture is deterministic: fixed ids, fixed instants, fixed order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WorldModelStore } from '../src/world/store.js';
import { WORLD_SCHEMA, validateWorldRecord } from '../src/world/model.js';
import { buildWorldModelContext } from '../src/world/context.js';
import { buildPrompt, MAX_CONTEXT_CHARS } from '../src/controller/context.js';
import { createApp } from '../src/app.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const CHILD_WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'world-writer-child.mjs');

const CLOCK = () => new Date('2026-11-01T10:00:00.000Z');
const BASE_MS = Date.parse('2024-01-01T00:00:00.000Z');
const VALID_FROM = '2024-01-01T00:00:00.000Z';
const HISTORICAL_UNTIL = '2024-02-01T00:00:00.000Z';
const OBSERVED_AT = '2024-01-01T00:00:00.000Z';

const READ_MATRIX = [100, 250, 500, 1000, 2000];
const WRITE_FIXTURE = 1000;
const CONTEXT_FIXTURE = 1000;
const CONTENTION_FIXTURE = 500;
const MAX_ENTITIES = 5000;
const MAX_REPEATS = 25;
const WRITERS = [1, 2, 4];
const ATTEMPTS_PER_WRITER = 3;

const USER_EVIDENCE = [{ relation: 'supports', sourceType: 'user', sourceId: 'user', classification: 'user_statement' }];
const CONTESTED_EVIDENCE = [
  { relation: 'supports', sourceType: 'user', sourceId: 'user', classification: 'user_statement' },
  { relation: 'contradicts', sourceType: 'user', sourceId: 'user', classification: 'user_statement' },
];

function bounded(raw, min, max, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function parseArgs(argv) {
  const opts = { repeats: 3, keep: false, phase: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repeats') { opts.repeats = bounded(argv[i + 1], 1, MAX_REPEATS, '--repeats'); i += 1; }
    else if (arg === '--phase') {
      const name = argv[i + 1];
      if (!['reads', 'analysis', 'writes', 'contention', 'context'].includes(name)) throw new Error(`unknown phase ${name}`);
      opts.phase = name;
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const dirs = [];
function tempDir(prefix = 'apex-bench-world-') {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
  dirs.push(dir);
  return dir;
}

function removeDir(dir) {
  const real = fs.realpathSync(dir);
  if (!real.startsWith(TMP_ROOT) || !path.basename(real).startsWith('apex-bench-')) {
    throw new Error(`refusing to remove non-benchmark directory: ${real}`);
  }
  fs.rmSync(real, { recursive: true, force: true });
}

async function copyDir(from) {
  const to = tempDir('apex-bench-copy-');
  await fs.promises.mkdir(to, { recursive: true });
  for (const name of await fs.promises.readdir(from)) {
    if (name.endsWith('.lock') || name.includes('.takeover.') || name.endsWith('.recover') || name.endsWith('.tmp')) continue;
    await fs.promises.copyFile(path.join(from, name), path.join(to, name));
  }
  return to;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  };
}

const ms = (value) => `${value.toFixed(2)} ms`;
const byteCount = (value) => Number(value).toLocaleString('en-US');

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

function header(cells) {
  console.log(`  ${cells.map(([label, width]) => label.padStart(width)).join('  ')}`);
}

function row(cells) {
  console.log(`  ${cells.map(([value, width]) => String(value).padStart(width)).join('  ')}`);
}

// ---- fixture ----------------------------------------------------------------

const pad4 = (i) => String(i).padStart(4, '0');
const entityId = (i) => `e-${pad4(i)}`;
const factId = (i, name) => `f-${pad4(i)}-${name}`;

function fixtureLines(n) {
  if (n > MAX_ENTITIES) throw new Error(`fixtures above ${MAX_ENTITIES} entities are not supported here`);
  const lines = [];
  let seq = 0;
  const push = (type, fields) => {
    const record = {
      schema: WORLD_SCHEMA,
      eventId: `evt-${String(seq).padStart(7, '0')}`,
      type,
      at: new Date(BASE_MS + seq * 1000).toISOString(),
      origin: 'user',
      ...fields,
    };
    const problem = validateWorldRecord(record);
    if (problem) throw new Error(`fixture ${type} ${seq} is not a valid record: ${problem}`);
    lines.push(JSON.stringify(record));
    seq += 1;
  };
  const scalar = (valueType, value, extra = {}) => ({ kind: 'scalar', valueType, value, ...extra });
  const fact = (i, name, predicate, object, extra = {}) => push('fact_asserted', {
    factId: factId(i, name),
    subjectId: entityId(i),
    predicate,
    object,
    validFrom: VALID_FROM,
    validUntil: null,
    observedAt: OBSERVED_AT,
    evidence: USER_EVIDENCE,
    ...extra,
  });

  // Every entity is created before any claim about it: a fact whose object entity does not exist
  // yet is correctly refused by the reducer, and the fixture must be a log the reducer accepts.
  for (let i = 0; i < n; i += 1) {
    push('entity_created', {
      entityId: entityId(i),
      category: 'product',
      name: `Unit-${pad4(i)}`,
      aliases: i % 50 === 0 ? ['Shared Alias'] : [],
      description: null,
      externalIds: [],
      observedAt: OBSERVED_AT,
      evidence: USER_EVIDENCE,
    });
  }

  for (let i = 0; i < n; i += 1) {
    fact(i, 'status', 'has_status', scalar('string', 'operational'));
    fact(i, 'capacity', 'has_capacity', scalar('number', i % 500, { unit: 'units' }));
    fact(i, 'described', 'described_as', scalar('string', `seeded unit ${i}`), {
      evidence: i % 30 === 0 ? CONTESTED_EVIDENCE : USER_EVIDENCE,
    });
    if (i % 10 === 0) {
      fact(i, 'phase', 'has_phase', scalar('string', 'planned'), {
        validUntil: HISTORICAL_UNTIL,
      });
    }
    if (i % 20 === 0) {
      fact(i, 'status2', 'has_status', scalar('string', 'degraded'));
    }
    if (i % 60 === 0) {
      push('statement_superseded', {
        targetType: 'fact',
        targetId: factId(i, 'status'),
        byId: factId(i, 'status2'),
        reason: 'a later status reading replaced the earlier one',
        evidence: USER_EVIDENCE,
      });
    }
    if (i % 7 === 0 && i + 1 < n) {
      fact(i, 'located', 'located_in', { kind: 'entity', entityId: entityId(i + 1) });
    }
    if (i % 50 === 0) {
      push('statement_retracted', {
        targetType: 'fact',
        targetId: factId(i, 'described'),
        reason: 'the description was withdrawn',
        evidence: USER_EVIDENCE,
      });
    }
    if (i > 0) {
      push('relationship_asserted', {
        relationshipId: `r-${pad4(i)}-part`,
        subjectId: entityId(i),
        objectId: entityId(i >> 1),
        predicate: 'part_of',
        directionality: 'directed',
        properties: null,
        validFrom: VALID_FROM,
        validUntil: null,
        observedAt: OBSERVED_AT,
        supersedes: [],
        evidence: USER_EVIDENCE,
      });
    }
    if (i % 4 === 0) {
      push('event_recorded', {
        worldEventId: `x-${pad4(i)}-check`,
        eventType: 'operational_check',
        participants: [entityId(i)],
        affected: [],
        occurredAt: '2024-01-02T00:00:00.000Z',
        observedAt: OBSERVED_AT,
        properties: null,
        evidence: USER_EVIDENCE,
      });
    }
    if (i % 25 === 0) {
      push('event_recorded', {
        worldEventId: `x-${pad4(i)}-late`,
        eventType: 'audit_passed',
        participants: [entityId(i)],
        affected: [],
        occurredAt: '2024-02-01T00:00:00.000Z',
        observedAt: '2024-03-01T00:00:00.000Z',
        properties: null,
        evidence: USER_EVIDENCE,
      });
    }
  }
  return lines;
}

function storeOn(dir, extra = {}) {
  return new WorldModelStore(path.join(dir, 'world-model.jsonl'), { now: CLOCK, ...extra });
}

function buildFixture(n) {
  const dir = tempDir();
  const seeded = fixtureLines(n);
  fs.writeFileSync(path.join(dir, 'world-model.jsonl'), `${seeded.join('\n')}\n`);
  const store = storeOn(dir);
  return {
    dir,
    entities: n,
    lines: seeded.length,
    bytes: fs.statSync(path.join(dir, 'world-model.jsonl')).size,
    store,
  };
}

function appOn(dir) {
  return createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    now: CLOCK,
    experienceCapture: CAPTURE_OFF,
  });
}

// ---- reads ------------------------------------------------------------------

async function phaseReads(opts) {
  console.log('\n== reads: what one public store read costs at progressive log sizes ==');
  for (const line of [
    '  each cell is one call on a fresh WorldModelStore instance: the whole log is read, every line',
    '  validated, and the world reduced again, then the read itself runs.',
    '  load   = store.load(): read + validate + reduce, with no query',
    '  status = store.status(): inspect() (read + reduce + conflicts + counts)',
    '  list   = listEntities({limit:20, includeRetired:true})',
    '  show   = showEntity(id): entity view plus its history scan',
    '  find   = findEntities("Unit-0001"): alias/name lookup',
    '  facts / attrs / rels / events = the entity-scoped reads, each re-deriving conflicts',
  ]) console.log(line);
  header([
    ['entities', 9], ['lines', 8], ['bytes', 10], ['load', 10], ['status', 10], ['list', 10],
    ['show', 10], ['find', 9], ['facts', 10], ['attrs', 10], ['rels', 10], ['events', 10],
  ]);
  for (const size of READ_MATRIX) {
    const fixture = buildFixture(size);
    const samples = { load: [], status: [], list: [], show: [], find: [], facts: [], attrs: [], rels: [], events: [] };
    for (let i = 0; i < opts.repeats; i += 1) {
      for (const [key, fn] of [
        ['load', () => storeOn(fixture.dir).load()],
        ['status', () => storeOn(fixture.dir).status()],
        ['list', () => storeOn(fixture.dir).listEntities({ limit: 20, includeRetired: true })],
        ['show', () => storeOn(fixture.dir).showEntity(entityId(0))],
        ['find', () => storeOn(fixture.dir).findEntities('Unit-0001')],
        ['facts', () => storeOn(fixture.dir).facts(entityId(0), {})],
        ['attrs', () => storeOn(fixture.dir).attributes(entityId(0), {})],
        ['rels', () => storeOn(fixture.dir).relationships(entityId(0), { direction: 'both' })],
        ['events', () => storeOn(fixture.dir).events(entityId(0), {})],
      ]) {
        samples[key].push((await timed(fn)).ms);
      }
    }
    const cell = (key) => ms(stats(samples[key]).median);
    row([
      [size, 9], [fixture.lines, 8], [byteCount(fixture.bytes), 10], [cell('load'), 10],
      [cell('status'), 10], [cell('list'), 10], [cell('show'), 10], [cell('find'), 9],
      [cell('facts'), 10], [cell('attrs'), 10], [cell('rels'), 10], [cell('events'), 10],
    ]);
  }
  console.log('  every read above re-reads and re-validates the whole log; no read uses a derived');
  console.log('  persisted index, and the store keeps no state between calls.');
}

// ---- analysis ---------------------------------------------------------------

async function phaseAnalysis(opts) {
  console.log('\n== analysis: the derived reads and the bounded prompt section ==');
  for (const line of [
    '  related  = traversal from one entity, depth 3 (edges re-derived from the whole state)',
    '  conflicts = computeConflicts over every active fact and relationship',
    '  identity = identityCandidates for one entity: a scan of every other active entity',
    '  history  = entity history: one scan of every record for the entity',
    '  changes  = every recorded change in the whole interval',
    '  stateAt  = replay of the records known at a mid-log instant',
    '  ctx      = buildWorldModelContext over an already-reduced state (no store read inside)',
  ]) console.log(line);
  header([
    ['entities', 9], ['lines', 8], ['related', 10], ['conflicts', 11], ['identity', 10],
    ['history', 10], ['changes', 10], ['stateAt', 10], ['ctx', 10], ['ctx lines', 10],
  ]);
  for (const size of READ_MATRIX) {
    const fixture = buildFixture(size);
    const cutoff = new Date(BASE_MS + Math.floor(fixture.lines / 2) * 1000).toISOString();
    const state = await fixture.store.state();
    const samples = { related: [], conflicts: [], identity: [], history: [], changes: [], stateAt: [], ctx: [] };
    let contextLines = 0;
    for (let i = 0; i < opts.repeats; i += 1) {
      for (const [key, fn] of [
        ['related', () => storeOn(fixture.dir).related(entityId(0), { depth: 3 })],
        ['conflicts', () => storeOn(fixture.dir).conflicts({})],
        ['identity', () => storeOn(fixture.dir).identityCandidates(entityId(0))],
        ['history', () => storeOn(fixture.dir).history(entityId(0))],
        ['changes', () => storeOn(fixture.dir).changes(VALID_FROM, CLOCK().toISOString())],
        ['stateAt', () => storeOn(fixture.dir).stateAt(cutoff)],
      ]) {
        samples[key].push((await timed(fn)).ms);
      }
      const ctx = await timed(() => buildWorldModelContext(state, {
        request: `what is the status of unit-${pad4(0)}`, now: CLOCK(),
      }));
      samples.ctx.push(ctx.ms);
      contextLines = ctx.result.lines.length;
    }
    const cell = (key) => ms(stats(samples[key]).median);
    row([
      [size, 9], [fixture.lines, 8], [cell('related'), 10], [cell('conflicts'), 11],
      [cell('identity'), 10], [cell('history'), 10], [cell('changes'), 10], [cell('stateAt'), 10],
      [cell('ctx'), 10], [contextLines, 10],
    ]);
  }
  console.log('  conflict analysis and identity scanning are whole-store passes; traversal is bounded by');
  console.log('  depth and a node cap, and the prompt section is bounded independently of the log size.');
}

// ---- writes -----------------------------------------------------------------

async function phaseWrites(opts) {
  const fixture = buildFixture(WRITE_FIXTURE);
  console.log('\n== writes: one append in parts, at the fixture size above ==');
  for (const line of [
    '  append        = the raw JSONL append alone, with no read, no validation and no lock',
    '  lock          = writeLock.run(async () => {}): the uncontended coordination section',
    '  create        = createEntity: whole-log read, reduce, simulate, append, read back',
    '  fact          = assertFact about a seeded entity',
    '  relationship  = assertRelationship between two seeded entities',
    '  event         = recordEvent naming one seeded entity',
    '  retract       = retractStatement on a seeded fact',
    '  create (act)  = the authorized command: audit record, action, independent re-read',
    '  fact (act)    = the same for a fact, including the action verifier',
  ]) console.log(line);
  header([['operation', 16], ['median', 11], ['min', 11], ['max', 11], ['n', 5], ['records after', 13]]);
  const before = await fixture.store.status();
  const samples = { append: [], lock: [], create: [], fact: [], relationship: [], event: [], retract: [], actionCreate: [], actionFact: [] };
  const after = { append: 0, lock: 0, create: 0, fact: 0, relationship: 0, event: 0, retract: 0, actionCreate: 0, actionFact: 0 };
  for (let i = 0; i < opts.repeats; i += 1) {
    const rawRecord = {
      schema: WORLD_SCHEMA,
      eventId: `evt-raw-${i}`,
      type: 'entity_created',
      at: CLOCK().toISOString(),
      origin: 'user',
      entityId: `e-raw-${i}`,
      category: 'product',
      name: `Raw append ${i}`,
      aliases: [],
      description: null,
      externalIds: [],
      observedAt: null,
      evidence: USER_EVIDENCE,
    };
    const bad = validateWorldRecord(rawRecord);
    if (bad) throw new Error(`raw append fixture is invalid: ${bad}`);

    const copy1 = await copyDir(fixture.dir);
    const s1 = storeOn(copy1);
    samples.append.push((await timed(() => s1.log.append(rawRecord))).ms);
    after.append = (await s1.status()).records;

    const copy2 = await copyDir(fixture.dir);
    const s2 = storeOn(copy2);
    samples.lock.push((await timed(() => s2.lock.run(async () => {}))).ms);
    after.lock = (await s2.status()).records;

    const copy3 = await copyDir(fixture.dir);
    const s3 = storeOn(copy3);
    samples.create.push((await timed(() => s3.createEntity({
      origin: 'user', entityId: `e-new-${i}`, category: 'product', name: `New unit ${i}`, evidence: USER_EVIDENCE,
    }))).ms);
    after.create = (await s3.status()).records;

    const copy4 = await copyDir(fixture.dir);
    const s4 = storeOn(copy4);
    samples.fact.push((await timed(() => s4.assertFact({
      origin: 'user', factId: `f-new-${i}`, subjectId: entityId(0), predicate: 'has_capacity',
      object: { kind: 'scalar', valueType: 'number', value: i + 1, unit: 'units' },
      validFrom: VALID_FROM, evidence: USER_EVIDENCE,
    }))).ms);
    after.fact = (await s4.status()).records;

    const copy5 = await copyDir(fixture.dir);
    const s5 = storeOn(copy5);
    samples.relationship.push((await timed(() => s5.assertRelationship({
      origin: 'user', relationshipId: `r-new-${i}`, subjectId: entityId(1), objectId: entityId(2),
      predicate: 'depends_on', validFrom: VALID_FROM, evidence: USER_EVIDENCE,
    }))).ms);
    after.relationship = (await s5.status()).records;

    const copy6 = await copyDir(fixture.dir);
    const s6 = storeOn(copy6);
    samples.event.push((await timed(() => s6.recordEvent({
      origin: 'user', worldEventId: `x-new-${i}`, eventType: 'benchmark_event',
      participants: [entityId(0)], occurredAt: VALID_FROM, observedAt: OBSERVED_AT, evidence: USER_EVIDENCE,
    }))).ms);
    after.event = (await s6.status()).records;

    const copy7 = await copyDir(fixture.dir);
    const s7 = storeOn(copy7);
    samples.retract.push((await timed(() => s7.retractStatement({
      origin: 'user', targetType: 'fact', targetId: factId(0, 'capacity'),
      reason: 'benchmark withdrawal', evidence: USER_EVIDENCE,
    }))).ms);
    after.retract = (await s7.status()).records;

    const copy8 = await copyDir(fixture.dir);
    const target8 = appOn(copy8);
    const actionCreate = await timed(() => target8.controller.worldWrite('world.entity.add', {
      id: `e-act-${i}`, category: 'product', name: `Action unit ${i}`, evidence: USER_EVIDENCE,
    }));
    samples.actionCreate.push(actionCreate.ms);
    if (actionCreate.result.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`action create did not verify: ${actionCreate.result.display}`);
    after.actionCreate = (await target8.worldModel.status()).records;

    const copy9 = await copyDir(fixture.dir);
    const target9 = appOn(copy9);
    const actionFact = await timed(() => target9.controller.worldWrite('world.fact.add', {
      id: `f-act-${i}`, subject: entityId(0), predicate: 'has_capacity',
      object: { kind: 'scalar', valueType: 'number', value: i + 2, unit: 'units' },
      validFrom: VALID_FROM, evidence: USER_EVIDENCE,
    }));
    samples.actionFact.push(actionFact.ms);
    if (actionFact.result.status !== Outcome.SUCCESS_VERIFIED) throw new Error(`action fact did not verify: ${actionFact.result.display}`);
    after.actionFact = (await target9.worldModel.status()).records;
  }
  const print = (label, key) => {
    const s = stats(samples[key]);
    row([[label, 16], [ms(s.median), 11], [ms(s.min), 11], [ms(s.max), 11], [s.n, 5], [after[key], 13]]);
  };
  print('append', 'append');
  print('lock', 'lock');
  print('create', 'create');
  print('fact', 'fact');
  print('relationship', 'relationship');
  print('event', 'event');
  print('retract', 'retract');
  print('create (act)', 'actionCreate');
  print('fact (act)', 'actionFact');
  console.log(`  fixture: ${before.records} record line(s), ${before.counts.entities} entities, `
    + `${before.counts.facts} facts, ${before.counts.relationships} relationships, ${before.counts.events} events.`);
  console.log('  `append` and `lock` are printed to bound the parts: they are not operations APEX offers.');
  console.log('  Every store write above re-reads and re-reduces the whole log inside the lock, so its');
  console.log('  cost follows the log size even though the appended record is one line.');
}

// ---- contention -------------------------------------------------------------

function spawnWriter(dir, writer, count, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD_WRITER, 'create', dir, String(writer), String(count)], { env, windowsHide: true });
    const results = [];
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, nl).trim();
        text = text.slice(nl + 1);
        if (line.startsWith('RESULT ')) {
          try { results.push(JSON.parse(line.slice(7))); } catch { /* a partial line is not a result */ }
        }
      }
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('close', (code) => resolve({ results, code, err }));
  });
}

async function phaseContention(opts) {
  const fixture = buildFixture(CONTENTION_FIXTURE);
  console.log('\n== contention: real processes creating entities in one log from a shared start ==');
  header([['writers', 8], ['wall', 11], ['accepted', 10], ['records', 9], ['new', 9], ['attempt med', 13],
    ['attempt max', 12], ['refusals', 10], ['corrupt', 9], ['residue', 9]]);
  for (const writers of WRITERS) {
    const copy = await copyDir(fixture.dir);
    const before = await storeOn(copy).status();
    const env = {
      ...process.env,
      APEX_DATA_DIR: copy,
      APEX_DATA_ISOLATED: '1',
      APEX_RACERS: String(writers),
      APEX_NOW: CLOCK().toISOString(),
      APEX_WAIT_MS: '10000',
    };
    const started = performance.now();
    const runs = await Promise.all(Array.from({ length: writers }, (_, w) => spawnWriter(copy, w, ATTEMPTS_PER_WRITER, env)));
    const wall = performance.now() - started;
    const results = runs.flatMap((r) => r.results);
    const accepted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    const durations = accepted.map((r) => r.ms);
    const after = await storeOn(copy).status();
    const afterState = await storeOn(copy).state();
    // Child ids are `e-w<writer>-<n>`; counting them shows that every accepted attempt produced
    // exactly one new entity and that no two writers claimed the same id.
    const written = [...afterState.entities.keys()].filter((id) => id.startsWith('e-w'));
    const residue = fs.readdirSync(copy).filter((name) => name.includes('.lock') || name.includes('.takeover') || name.endsWith('.tmp'));
    const s = stats(durations);
    if (written.length !== accepted.length) {
      throw new Error(`${accepted.length} accepted attempt(s) produced ${written.length} new entity/ies`);
    }
    row([
      [writers, 8], [ms(wall), 11], [`${accepted.length}/${results.length}`, 10], [after.records, 9],
      [written.length, 9], [ms(s.median), 13], [ms(s.max), 12], [refused.length, 10], [after.corrupt, 9],
      [residue.length, 9],
    ]);
    if (refused.length > 0) {
      for (const r of refused.slice(0, 3)) console.log(`      refusal: ${r.code ?? ''} ${r.message}`);
    }
    console.log(`      ${before.records} record(s) seeded, ${after.records} after ${accepted.length} accepted write(s), `
      + `exit codes ${runs.map((r) => r.code).join(',')}`);
  }
  console.log('  each attempt is timed from inside its own process and excludes that process\'s start-up;');
  console.log('  wall time includes it. A refused attempt writes nothing, so `records` must equal the seeded');
  console.log('  count plus the accepted attempts, and `new` must equal the accepted attempts, on every row.');
}

// ---- context ----------------------------------------------------------------

async function phaseContext(opts) {
  const fixture = buildFixture(CONTEXT_FIXTURE);
  const store = storeOn(fixture.dir);
  const state = await store.state();
  const RELEVANT = `what is the status of unit-${pad4(0)}`;
  const OVERVIEW = 'what world facts and conflicts are recorded';
  const IRRELEVANT = 'what is 6 times 7';
  const view = buildWorldModelContext(state, { request: RELEVANT, now: CLOCK() });
  const overview = buildWorldModelContext(state, { request: OVERVIEW, now: CLOCK() });
  const unrelated = buildWorldModelContext(state, { request: IRRELEVANT, now: CLOCK() });
  const assembled = (request, extra) => buildPrompt({
    request, memoryHits: [], turns: [], ...extra,
  }).prompt;
  const base = assembled(RELEVANT, {});
  const withSection = assembled(RELEVANT, { worldModel: view });
  const overviewBase = assembled(OVERVIEW, {});
  const overviewWith = assembled(OVERVIEW, { worldModel: overview });
  const irrelevantBase = assembled(IRRELEVANT, {});
  const irrelevantWith = assembled(IRRELEVANT, { worldModel: view });
  const unavailableBase = assembled(OVERVIEW, {});
  const unavailable = assembled(OVERVIEW, { worldModel: null, worldModelUnavailable: true });

  console.log('\n== context: what the bounded world-model section adds, and which requests pay ==');
  console.log(`  world: ${fixture.lines} record line(s), ${state.entities.size} entities, ${state.facts.size} facts, `
    + `${state.relationships.size} relationships, ${state.events.size} events`);
  console.log(`  a named entity: ${view.lines.length} line(s), ${view.lines.join('\n').length} characters, `
    + `matchedBy ${view.matchedBy}, ${view.omitted} entr(y/ies) omitted by the local budget`);
  console.log(`  an overview request: ${overview.lines.length} line(s), ${overview.lines.join('\n').length} characters, `
    + `${overview.conflicts} disagreement group(s) named`);
  console.log(`  an unrelated request: ${unrelated.lines.length} line(s) (0 means the gate held)`);
  console.log(`  base prompt ${base.length} characters; with the section ${withSection.length} `
    + `(+${withSection.length - base.length}, ${(((withSection.length - base.length) / MAX_CONTEXT_CHARS) * 100).toFixed(1)}% of the `
    + `${MAX_CONTEXT_CHARS}-character prompt budget)`);
  console.log(`  overview request: +${overviewWith.length - overviewBase.length} character(s) on a ${overviewBase.length}-character base`);
  console.log(`  if the named-entity section were passed anyway, bypassing the builder's gate: `
    + `+${irrelevantWith.length - irrelevantBase.length} character(s) on a ${irrelevantBase.length}-character base`);
  console.log(`  an unreadable world model on a relevant-shaped request: `
    + `+${unavailable.length - unavailableBase.length} character(s), and it says the store could not be read`);
  if (view.lines.length === 0) throw new Error('the named entity produced no context line');
  if (view.lines.length > 10) throw new Error('the world-model section exceeded its line bound');

  const samples = [];
  for (let i = 0; i < opts.repeats; i += 1) samples.push((await timed(() => storeOn(fixture.dir).state())).ms);
  const s = stats(samples);
  const preloaded = [];
  for (let i = 0; i < opts.repeats; i += 1) {
    preloaded.push((await timed(() => buildWorldModelContext(state, { request: RELEVANT, now: CLOCK() }))).ms);
  }
  const p = stats(preloaded);
  console.log(`  store.state() on this log: ${ms(s.median)} median (${ms(s.min)} min, ${ms(s.max)} max) over ${s.n} samples`);
  console.log(`  buildWorldModelContext() on the reduced state: ${ms(p.median)} median - the section adds no store read`);
  console.log('  No model is contacted: every prompt above is assembled and measured offline.');
}

// ---- run --------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node benchmarks/run-world-model-benchmark.mjs [--repeats R] [--phase reads|analysis|writes|contention|context] [--keep]');
  console.log('  model-free; writes only into a fresh temporary data directory; not part of npm test');
} else {
  console.log(`node ${process.version} on ${process.platform} ${process.arch}, `
    + `${os.cpus().length} logical CPU(s), ${Math.round(os.totalmem() / 1073741824)} GiB reported memory`);
  console.log(`clock fixed at ${CLOCK().toISOString()}; fixtures dated from ${VALID_FROM}; repeats ${opts.repeats}`);
  console.log('no model, no network, no inference: every application here is built with NoBackend and no');
  console.log('read below asks one. Every fixture line is checked by the world-model validator as it is');
  console.log('written, so a line the store would reject cannot become a measurement.');
  try {
    if (!opts.phase || opts.phase === 'reads') await phaseReads(opts);
    if (!opts.phase || opts.phase === 'analysis') await phaseAnalysis(opts);
    if (!opts.phase || opts.phase === 'writes') await phaseWrites(opts);
    if (!opts.phase || opts.phase === 'contention') await phaseContention(opts);
    if (!opts.phase || opts.phase === 'context') await phaseContext(opts);
  } finally {
    if (opts.keep) {
      console.log(`\nkept: ${dirs.join(', ')}`);
    } else {
      for (const dir of dirs) removeDir(dir);
      console.log('\ntemporary data directories removed; nothing outside them was written.');
    }
  }
}
