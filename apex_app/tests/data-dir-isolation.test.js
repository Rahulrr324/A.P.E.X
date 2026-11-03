// AF-09..AF-13: how a run decides where its data lives, and the isolation that keeps a test,
// benchmark, or diagnostic from reaching a real user store.
//
// Everything written here goes to a synthetic temporary directory, including the "home"
// directories the tests pin through HOME and USERPROFILE. The real default store is opened for
// one purpose only: a before/after snapshot of its file names, sizes and modification times, so
// a refusal can be shown to have changed nothing on the machine that ran the test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, test, describe } from 'node:test';
import { createApp } from '../src/app.js';
import { assertIsolatedDataDir, defaultDataDir, isolationRequested, loadConfig } from '../src/config.js';
import { ValidationError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { cleanEnv, cleanup, makeTempDataDir, runCli } from './helpers.js';

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }

// A home directory that belongs to no user. The default data directory is derived from HOME,
// so a run that falls back lands here and the test can see exactly what a fallback creates.
function fakeHome() { const h = makeTempDataDir(); dirs.push(h); return h; }

function envFor(dir, extra = {}) {
  return cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, ...extra });
}

// A location outside the temporary root, named so a guarded cleanup can recognise its own.
// Nothing here creates it: the tests below assert that APEX refuses to.
const OUTSIDE_ROOT = path.resolve(TMP_ROOT, '..', `apex-isolation-probe-${randomUUID()}`);
function assertOutsideUncreated() {
  if (!fs.existsSync(OUTSIDE_ROOT)) return;
  // Reaching this line means the guard failed and a probe directory was created. Remove the
  // exact path this file invented, and fail loudly rather than leaving it behind.
  fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
  assert.fail(`a refused run still created ${OUTSIDE_ROOT}`);
}
afterEach(assertOutsideUncreated);

// Read-only: names, sizes and modification times of the real default store, or 'absent'.
function snapshotDefaultStore() {
  const dir = defaultDataDir();
  if (!fs.existsSync(dir)) return 'absent';
  return fs.readdirSync(dir)
    .map((name) => `${name}:${fs.statSync(path.join(dir, name)).size}:${fs.statSync(path.join(dir, name)).mtimeMs}`)
    .sort()
    .join('|');
}

function filesIn(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('AF: normal data-directory resolution is unchanged', () => {
  test('an explicit directory wins and an unset one still means the home default', () => {
    const dir = tempDir();
    const explicit = loadConfig({ APEX_DATA_DIR: dir });
    assert.equal(explicit.dataDir, path.resolve(dir));
    assert.equal(explicit.dataDirIsDefault, false);
    assert.equal(explicit.isolated, false);

    const fallback = loadConfig({});
    assert.equal(fallback.dataDir, defaultDataDir());
    assert.equal(fallback.dataDirIsDefault, true, 'a run that was not told where to write says so');

    // Whitespace is what an unset variable looks like in a shell, and has always resolved to the
    // default. Isolation asks for a directory by name, so the same value is refused there.
    const blank = loadConfig({ APEX_DATA_DIR: '   ' });
    assert.equal(blank.dataDir, defaultDataDir());
    assert.equal(blank.dataDirIsDefault, true);
    assert.throws(() => loadConfig({ APEX_DATA_ISOLATED: '1', APEX_DATA_DIR: '   ' }), ValidationError);
  });

  test('a relative directory is resolved against the working directory as before', () => {
    assert.equal(loadConfig({ APEX_DATA_DIR: path.join('some', 'where') }).dataDir, path.resolve('some', 'where'));
  });

  test('APEX_DATA_ISOLATED=0 is normal operation, and a persistent store of your own stays available', () => {
    const outside = path.resolve(TMP_ROOT, '..', 'apex-isolation-normal-operation-not-created');
    const cfg = loadConfig({ APEX_DATA_ISOLATED: '0', APEX_DATA_DIR: defaultDataDir() });
    assert.equal(cfg.dataDir, defaultDataDir());
    assert.equal(cfg.isolated, false);
    assert.equal(loadConfig({ APEX_DATA_ISOLATED: '0', APEX_DATA_DIR: outside }).dataDir, outside,
      'choosing a directory outside the temporary root is allowed when isolation is not asked for');
    assert.equal(fs.existsSync(outside), false, 'reading configuration creates nothing');
  });
});

describe('AF: a malformed isolation setting is a startup error, never a silent downgrade', () => {
  for (const bad of ['yes', 'no', '2', 'true', 'false', 'on', 'off', 'isolated', '01', '10', 'x1', 'iso=1']) {
    test(`APEX_DATA_ISOLATED="${bad}" is refused rather than read as normal operation`, () => {
      const dir = tempDir();
      assert.throws(() => isolationRequested({ APEX_DATA_ISOLATED: bad }), (e) => {
        assert.ok(e instanceof ValidationError);
        assert.equal(e.code, 'INVALID_CONFIG');
        assert.match(e.message, /must be exactly 1 or 0/);
        return true;
      });
      // The value that was meant to isolate must not be able to become a normal run.
      assert.throws(() => loadConfig({ APEX_DATA_ISOLATED: bad, APEX_DATA_DIR: dir }), ValidationError);
    });
  }

  test('the accepted spellings are 1 and 0, with surrounding whitespace tolerated', () => {
    const dir = tempDir();
    assert.equal(isolationRequested({}), false);
    assert.equal(isolationRequested({ APEX_DATA_ISOLATED: '' }), false);
    assert.equal(isolationRequested({ APEX_DATA_ISOLATED: '   ' }), false, 'an empty variable is unset, as every other APEX variable is');
    assert.equal(isolationRequested({ APEX_DATA_ISOLATED: '0' }), false);
    assert.equal(isolationRequested({ APEX_DATA_ISOLATED: '1' }), true);
    assert.equal(loadConfig({ APEX_DATA_ISOLATED: '1', APEX_DATA_DIR: dir }).isolated, true);

    // Whitespace is trimmed before the value is read, exactly as APEX_DATA_DIR is. The direction
    // matters: padding can never turn a value that means 1 into a normal run, which is the only
    // downgrade isolation has to prevent. A shell that appends a space (`set VAR=1 &`) still
    // gets an isolated run rather than a startup error.
    for (const padded of [' 1', '1 ', '\t1\n']) {
      assert.equal(isolationRequested({ APEX_DATA_ISOLATED: padded }), true, `"${padded}" means isolated`);
    }
    assert.equal(isolationRequested({ APEX_DATA_ISOLATED: ' 0 ' }), false);
  });
});

describe('AF: isolated execution refuses every location that is not a temporary directory', () => {
  test('an isolated run must name its data directory', () => {
    assert.throws(() => loadConfig({ APEX_DATA_ISOLATED: '1' }), (e) => {
      assert.ok(e instanceof ValidationError);
      assert.match(e.message, /requires an explicit APEX_DATA_DIR/);
      assert.match(e.message, /default home data directory/);
      return true;
    });
  });

  test('the temporary root itself is not an isolated data directory', () => {
    assert.throws(() => assertIsolatedDataDir(TMP_ROOT), ValidationError);
    assert.throws(() => loadConfig({ APEX_DATA_ISOLATED: '1', APEX_DATA_DIR: TMP_ROOT }), (e) => {
      assert.match(e.message, /inside the OS temporary directory/);
      return true;
    });
  });

  test('a directory outside the temporary root is refused, including the real default store', () => {
    for (const candidate of [defaultDataDir(), OUTSIDE_ROOT, path.resolve(TMP_ROOT, '..', 'Windows')]) {
      assert.throws(() => assertIsolatedDataDir(candidate), (e) => {
        assert.ok(e instanceof ValidationError);
        assert.equal(e.code, 'INVALID_CONFIG');
        assert.match(e.message, /Normal operation, including a persistent store of your own choosing/);
        return true;
      });
    }
    assert.equal(fs.existsSync(OUTSIDE_ROOT), false, 'a refusal never creates the directory it refused');
  });

  test('the check is about the location, not the spelling', (t) => {
    if (process.platform !== 'win32') return t.skip('case-insensitive paths are a Windows property');
    const dir = tempDir();
    // The same temporary directory spelled with different case is still inside it. The returned
    // spelling is the one the filesystem reported, so equality here is about the location.
    const lower = assertIsolatedDataDir(dir).toLowerCase();
    assert.equal(assertIsolatedDataDir(dir.toUpperCase()).toLowerCase(), lower);
    assert.equal(assertIsolatedDataDir(dir.toLowerCase()).toLowerCase(), lower);
    assert.equal(loadConfig({ APEX_DATA_ISOLATED: '1', APEX_DATA_DIR: dir.toUpperCase() }).isolated, true);
    // A directory outside the root is refused whichever case it is spelled in.
    for (const spelling of [defaultDataDir(), defaultDataDir().toUpperCase()]) {
      assert.throws(() => assertIsolatedDataDir(spelling), ValidationError);
    }
  });

  test('a nested path inside the temporary root that does not exist yet is accepted', () => {
    const dir = tempDir();
    const future = path.join(dir, 'not', 'created', 'yet');
    assert.equal(assertIsolatedDataDir(future).startsWith(assertIsolatedDataDir(dir)), true);
    assert.equal(fs.existsSync(future), false, 'the check itself creates nothing');
  });
});

describe('AF: createApp guards a programmatic writer as well as the CLI', () => {
  // Isolation is a property of the process, so these two tests set it on the test process and
  // restore the environment however they finish.
  const saved = process.env.APEX_DATA_ISOLATED;
  const restore = () => {
    if (saved === undefined) delete process.env.APEX_DATA_ISOLATED;
    else process.env.APEX_DATA_ISOLATED = saved;
  };

  test('an isolated process cannot build an app on a directory outside the temporary root', () => {
    process.env.APEX_DATA_ISOLATED = '1';
    try {
      assert.throws(() => createApp({ dataDir: OUTSIDE_ROOT }), (e) => {
        assert.ok(e instanceof ValidationError);
        assert.equal(e.code, 'INVALID_CONFIG');
        return true;
      });
      assert.throws(() => createApp({ dataDir: defaultDataDir() }), ValidationError);
      assert.equal(fs.existsSync(OUTSIDE_ROOT), false);
    } finally {
      restore();
    }
  });

  test('an isolated process builds an app on a temporary directory and writes only there', async () => {
    const dir = tempDir();
    const home = fakeHome();
    process.env.APEX_DATA_ISOLATED = '1';
    try {
      const app = createApp({ dataDir: dir });
      const step = await app.controller.runAction('memory.add', { content: 'the isolation probe record' }, 'user', 'op-iso-01');
      assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, step.summary);
      const stored = fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8');
      assert.match(stored, /the isolation probe record/);
      assert.equal(fs.existsSync(path.join(home, '.apex')), false, 'nothing reached the home directory this process could have defaulted to');
    } finally {
      restore();
    }
  });
});

describe('AF: a child process cannot reach a real user store', () => {
  test('the temporary directory propagates and no home directory is created', async () => {
    const dir = tempDir();
    const home = fakeHome();
    const res = await runCli(['ask', 'calc 6*7'], cleanEnv({ APEX_DATA_DIR: dir, HOME: home, USERPROFILE: home }));
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /= 42/);
    for (const name of ['operations.jsonl', 'conversation.jsonl', 'session.json']) {
      assert.ok(filesIn(dir).includes(name), `${name} was written in the directory the child was told to use`);
    }
    assert.equal(fs.existsSync(path.join(home, '.apex')), false, 'the pinned home stayed empty');
    assert.equal(res.stderr.includes('default data directory'), false, 'a run that was told where to write says nothing about a fallback');
  });

  test('a missing APEX_DATA_DIR fails the run instead of falling back to the home default', async () => {
    const before = snapshotDefaultStore();
    const home = fakeHome();
    const res = await runCli(['ask', 'calc 6*7'], cleanEnv({ HOME: home, USERPROFILE: home }));
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /APEX_DATA_ISOLATED=1 requires an explicit APEX_DATA_DIR/);
    assert.match(res.stderr, /No data was read or changed/);
    assert.equal(fs.existsSync(path.join(home, '.apex')), false, 'the default location under the pinned home was never created');
    assert.equal(snapshotDefaultStore(), before, 'the real default store is byte-for-byte what it was before the refusal');
  });

  test('a malformed isolation value fails the child before any store is opened', async () => {
    const dir = tempDir();
    const home = fakeHome();
    const res = await runCli(['ask', 'remember that the probe marker is 1'], envFor(dir, { APEX_DATA_ISOLATED: 'yes', HOME: home, USERPROFILE: home }));
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /APEX_DATA_ISOLATED must be exactly 1 or 0/);
    assert.deepEqual(filesIn(dir), [], 'the directory the run was given stayed empty');
    assert.equal(fs.existsSync(path.join(home, '.apex')), false);
  });

  test('a data directory outside the temporary root is refused by the child and nothing is created', async () => {
    const home = fakeHome();
    const res = await runCli(['ask', 'calc 2+2'], cleanEnv({ APEX_DATA_DIR: OUTSIDE_ROOT, HOME: home, USERPROFILE: home }));
    assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /inside the OS temporary directory/);
    assert.equal(fs.existsSync(OUTSIDE_ROOT), false, 'the refusal happened before any directory was prepared');
    assert.equal(fs.existsSync(path.join(home, '.apex')), false);
  });

  test('parallel children with different data directories do not share stores', async () => {
    const a = tempDir();
    const b = tempDir();
    const home = fakeHome();
    const results = await Promise.all([
      runCli(['ask', 'remember that the isolation marker is alpha-only'], cleanEnv({ APEX_DATA_DIR: a, HOME: home, USERPROFILE: home })),
      runCli(['ask', 'remember that the isolation marker is beta-only'], cleanEnv({ APEX_DATA_DIR: b, HOME: home, USERPROFILE: home })),
    ]);
    for (const res of results) assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);

    const memoryA = fs.readFileSync(path.join(a, 'memory.jsonl'), 'utf8');
    const memoryB = fs.readFileSync(path.join(b, 'memory.jsonl'), 'utf8');
    assert.match(memoryA, /alpha-only/);
    assert.equal(memoryA.includes('beta-only'), false, "the other child's record is not in this store");
    assert.match(memoryB, /beta-only/);
    assert.equal(memoryB.includes('alpha-only'), false);
    assert.deepEqual(filesIn(a), filesIn(b), 'both children prepared the same set of files, in their own directories');

    const statusA = await runCli(['status'], cleanEnv({ APEX_DATA_DIR: a, HOME: home, USERPROFILE: home }));
    assert.match(statusA.stdout, /Memory records: 1/, 'one record, not two');
  });

  test('normal operation with the default directory still writes a store, and says where', async () => {
    const home = fakeHome();
    const res = await runCli(['ask', 'remember that the fallback marker is 90210'],
      cleanEnv({ APEX_DATA_ISOLATED: '0', APEX_DATA_DIR: '', HOME: home, USERPROFILE: home }));
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /this run uses the default data directory/);
    assert.match(res.stderr, /APEX_DATA_DIR is not set/);
    const created = filesIn(path.join(home, '.apex', 'local-alpha'));
    assert.ok(created.includes('memory.jsonl'), 'a person who set nothing still gets their store, in the documented place');
    assert.ok(created.includes('operations.jsonl'));
  });

  test('status and diagnose name the mode they are in', async () => {
    const isolatedDir = tempDir();
    const isolated = await runCli(['status'], envFor(isolatedDir));
    assert.equal(isolated.code, 0, `${isolated.stdout}\n${isolated.stderr}`);
    assert.match(isolated.stdout, /Data directory: .* \(isolated execution: APEX_DATA_ISOLATED=1\)/);

    const home = fakeHome();
    const fallback = await runCli(['status'], cleanEnv({ APEX_DATA_ISOLATED: '0', HOME: home, USERPROFILE: home }));
    assert.match(fallback.stdout, /Data directory: .* \(default location: APEX_DATA_DIR is not set\)/);

    const chosen = tempDir();
    const normal = await runCli(['status'], cleanEnv({ APEX_DATA_ISOLATED: '0', APEX_DATA_DIR: chosen, HOME: home, USERPROFILE: home }));
    const plain = chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(normal.stdout, new RegExp(`^Data directory: ${plain}$`, 'm'), 'a chosen directory is stated plainly, with no mode suffix');
    assert.equal(normal.stdout.includes('isolated execution'), false, 'a normal run does not claim to be isolated');
    assert.equal(normal.stderr.includes('default data directory'), false, 'a run that was told where to write says nothing about a fallback');

    const diag = await runCli(['diagnose'], envFor(isolatedDir));
    assert.match(diag.stdout, /isolated execution: APEX_DATA_ISOLATED=1/);
  });

  test('the read-only commands create no file at all in an isolated store', async () => {
    const dir = tempDir();
    const commands = [
      ['status'], ['diagnose'], ['audit', 'health'], ['memory', 'health'], ['knowledge', 'health'],
      ['experience', 'health'], ['prediction', 'health'], ['world'], ['history'], ['queue'],
      ['repair', 'locks'], ['help'], ['version'],
    ];
    for (const args of commands) {
      const res = await runCli(args, envFor(dir));
      assert.ok([0, 1].includes(res.code), `${args.join(' ')} exited ${res.code}: ${res.stderr}`);
      assert.deepEqual(filesIn(dir), [], `${args.join(' ')} created a file in an untouched store`);
    }
  });

  test('an audited read appends its audit record to the isolated store and nowhere else', async () => {
    const dir = tempDir();
    const home = fakeHome();
    const reads = [['knowledge', 'list'], ['experience', 'list'], ['prediction', 'list'], ['adaptation', 'list'], ['knowledge', 'search', 'isolation']];
    for (const args of reads) {
      const res = await runCli(args, cleanEnv({ APEX_DATA_DIR: dir, HOME: home, USERPROFILE: home }));
      assert.equal(res.code, 0, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
    }
    const audit = fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, reads.length, 'one audit record per audited read, in the store the run was given');
    assert.deepEqual(audit.map((o) => o.capability), ['knowledge.list', 'experience.list', 'prediction.list', 'adaptation.list', 'knowledge.search']);
    assert.deepEqual(filesIn(dir), ['operations.jsonl'], 'an audited read writes its audit line and nothing else');
    assert.equal(fs.existsSync(path.join(home, '.apex')), false, 'none of them reached the home directory');
  });

  // Which reads write is not uniform, and AF-12 depends on knowing exactly: a read whose record
  // is audited appends one line, and the task readers are direct - the code says so at each site
  // - so they touch nothing. Both kinds stay inside the store the run was given.
  test('a task read is direct: it appends no audit record and creates no file', async () => {
    const dir = tempDir();
    const home = fakeHome();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: home, USERPROFILE: home });
    const listed = await runCli(['task', 'list'], env);
    assert.equal(listed.code, 0, `${listed.stdout}\n${listed.stderr}`);
    assert.deepEqual(filesIn(dir), [], 'task list read an empty task log and wrote nothing');

    // An unknown id is refused by the readers that require one, and a refusal writes nothing
    // either: an attempt to read a record that is not there is not an operation.
    for (const args of [['task', 'show', 'nope-123'], ['task', 'explain', 'nope-123', 'why']]) {
      const res = await runCli(args, env);
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.deepEqual(filesIn(dir), [], `${args.join(' ')} created a file in an untouched store`);
    }
    assert.equal(fs.existsSync(path.join(home, '.apex')), false);
  });
});

// AF-12, in one sweep: every command family that can persist something is run against one
// isolated directory, and the whole sweep is checked to have landed there and nowhere else.
// The exit code is allowed to report a documented non-verified outcome (1); 2 would mean the
// command was refused as bad usage or configuration, and 3 would mean the audit record itself
// could not be written - either would say the isolation contract broke normal operation.
describe('AF-12: every command that can write stays in the store the run was given', () => {
  const STORE_FILES = [
    'conversation.jsonl', 'experiences.jsonl', 'knowledge.jsonl', 'memory.jsonl',
    'operations.jsonl', 'predictions.jsonl', 'session.json', 'task-summary-queue.json', 'tasks.jsonl',
  ];

  test('memory, knowledge, experience, feedback, adaptation, prediction, task and session writes', async () => {
    const dir = tempDir();
    const home = fakeHome();
    const env = cleanEnv({ APEX_DATA_DIR: dir, HOME: home, USERPROFILE: home });
    const before = snapshotDefaultStore();
    const recordsIn = (name) => fs.existsSync(path.join(dir, name))
      ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
      : [];

    const step = async (args) => {
      const res = await runCli(args, env);
      assert.ok([0, 1].includes(res.code), `${args.join(' ')} exited ${res.code}:\n${res.stdout}\n${res.stderr}`);
      assert.equal(res.stderr.includes('default data directory'), false, 'an isolated run never warns about a fallback it cannot reach');
      return res;
    };

    await step(['ask', 'remember that the isolation inventory marker is 4411']);
    await step(['memory', 'correct', '--resolve', recordsIn('memory.jsonl').at(-1).id, 'the isolation inventory marker was corrected']);
    await step(['ask', 'remember that the isolation inventory backup marker is 5522']);

    await step(['knowledge', 'add', '--subject', 'iso-node', '--relationship', 'links to', '--object', 'iso-target']);
    await step(['knowledge', 'retract', recordsIn('knowledge.jsonl').at(-1).id, '--reason', 'inventory sweep']);

    // Two experiences in one capability scope, each given the same two pieces of guidance: a
    // candidate needs two independent supporting experiences, so the approve and reject below
    // have real candidates to decide on.
    const remembered = recordsIn('operations.jsonl').filter((op) => op.capability === 'memory.add').map((op) => op.id);
    assert.equal(remembered.length, 2, 'both remember requests were audited as memory.add');
    await step(['experience', 'record', remembered[0], '--subject', 'the first inventory experience']);
    await step(['experience', 'record', remembered[1], '--subject', 'the second inventory experience']);
    const experiences = recordsIn('experiences.jsonl').filter((r) => r.kind === 'experience').map((r) => r.id);
    assert.equal(experiences.length, 2, 'both experiences were recorded');
    for (const exp of experiences) {
      await step(['feedback', 'record', exp, '--assessment', 'not_useful', '--guidance', 'answer in one line']);
      await step(['feedback', 'record', exp, '--assessment', 'incorrect', '--guidance', 'never store a private code']);
    }
    const derived = await step(['adaptation', 'derive']);
    const candidates = recordsIn('experiences.jsonl').filter((r) => r.kind === 'adaptation');
    assert.equal(candidates.length, 2, `derive was expected to list two candidates:\n${derived.stdout}\n${derived.stderr}`);
    await step(['adaptation', 'approve', candidates[0].id, '--reason', 'keep this rule for the sweep']);
    await step(['adaptation', 'reject', candidates[1].id, '--reason', 'not this one']);

    await step(['prediction', 'record', '--capability', 'calc.evaluate', '--expect', 'success',
      '--subject', 'the inventory sweep stays inside its own store', '--in-days', '7']);
    const prediction = recordsIn('predictions.jsonl').at(-1).id;
    await step(['prediction', 'evaluate', prediction]);
    await step(['prediction', 'invalidate', prediction, '--reason', 'sweep is finishing']);

    await step(['task', 'plan', 'calc 1+1; calc 2+2']);
    const taskId = recordsIn('tasks.jsonl').at(-1).taskId;
    await step(['task', 'approve', taskId]);
    await step(['task', 'run', taskId]);

    await step(['new']);
    await step(['repair', 'locks']);

    // Everything the sweep persisted is in the directory it was given, and it is all store files:
    // no lock residue, no stray path, nothing outside.
    const created = filesIn(dir);
    assert.ok(created.length > 0, 'the sweep wrote its records');
    for (const name of created) assert.ok(STORE_FILES.includes(name), `unexpected file in the isolated store: ${name}`);
    for (const name of ['memory.jsonl', 'knowledge.jsonl', 'experiences.jsonl', 'predictions.jsonl', 'tasks.jsonl', 'operations.jsonl', 'session.json']) {
      assert.ok(created.includes(name), `${name} should hold the sweep's records`);
    }
    assert.equal(fs.existsSync(path.join(home, '.apex')), false, 'the pinned home stayed empty through every writing family');
    assert.equal(snapshotDefaultStore(), before, 'the real default store was not touched by the sweep');
  });
});
