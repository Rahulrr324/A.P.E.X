// Batch F / 065: storage integrity under concurrent writers.
//
// Two defects were reproduced before this suite was written:
//
//  1. Session creation was check-then-rotate. Two first requests arriving together each
//     saw no session file and each published its own id; the last rename won and the other
//     request's conversation turns were orphaned - recorded, but unreachable from the
//     pointer. Real processes reproduced it in 2 of 3 rounds (2-3 session ids for 8
//     requests, all exiting 0 with no disclosure).
//  2. JsonlStore.append wrote the record with one unchecked write. A fault-injected short
//     write resolved as success while only half the record was on disk, so the record was
//     lost and reported as written.
//
// The tests below drive real child processes for the positive concurrency properties
// (per-line appends do not lose or merge records; a live reader never observes a partial
// line; memory and audit stores accept concurrent adds) and inject the short write to hold
// the append contract.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDataDir, cleanup, cleanEnv, runCli, APP_ROOT } from './helpers.js';
import { SessionState } from '../src/session.js';
import { JsonlStore } from '../src/memory/jsonl-store.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { OperationLog } from '../src/operations/operation-log.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
const CHILD = path.join(APP_ROOT, 'tests', 'fixtures', 'storage-writer-child.mjs');

function spawnWriter(args, { racers, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      env: cleanEnv({ APEX_RACERS: String(racers) }),
      cwd,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

function envFor(dataDir) {
  return cleanEnv({ APEX_DATA_DIR: dataDir, HOME: dataDir, USERPROFILE: dataDir });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

describe('065: concurrent first requests share one session', () => {
  test('eight concurrent SessionState.current() calls publish exactly one session id', async () => {
    const dir = tempDir();
    const session = new SessionState(path.join(dir, 'session.json'));
    const states = await Promise.all(Array.from({ length: 8 }, () => session.current()));
    const ids = new Set(states.map((s) => s.sessionId));
    assert.equal(ids.size, 1, `concurrent current() callers saw ${ids.size} sessions: ${[...ids].join(', ')}`);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(stored.sessionId, [...ids][0], 'the stored pointer is the session every caller returned');
    assert.deepEqual(fs.readdirSync(dir), ['session.json'], 'no temp file was left behind');
  });

  test('real concurrent first CLI requests: every turn belongs to the one stored session', async () => {
    const dir = tempDir();
    const runs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => runCli(['ask', `calc ${i}+${i}`], envFor(dir))));
    for (const run of runs) assert.equal(run.code, 0, run.stdout + run.stderr);

    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    const turns = readLines(path.join(dir, 'conversation.jsonl')).map((l) => JSON.parse(l));
    assert.equal(turns.length, 12, 'each request recorded its user turn and its result');
    const sessions = new Set(turns.map((t) => t.sessionId));
    assert.deepEqual([...sessions], [pointer.sessionId], 'no request wrote history under a session the pointer abandoned');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp file was left behind');
  });

  test('apex new still replaces the session, and the next request follows it', async () => {
    const dir = tempDir();
    const first = await runCli(['ask', 'calc 1+1'], envFor(dir));
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).sessionId;

    const rotated = await runCli(['new'], envFor(dir));
    assert.equal(rotated.code, 0, rotated.stdout + rotated.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).sessionId;
    assert.notEqual(after, before, 'an explicit new session replaces the pointer');

    const next = await runCli(['ask', 'calc 2+2'], envFor(dir));
    assert.equal(next.code, 0, next.stdout + next.stderr);
    const turns = readLines(path.join(dir, 'conversation.jsonl')).map((l) => JSON.parse(l));
    assert.equal(turns.filter((t) => t.sessionId === after).length, 2, 'the request after "new" uses the new session');
    assert.equal(turns.filter((t) => t.sessionId === before).length, 2, 'the old session keeps its own turns');
  });
});

describe('065: concurrent JSONL appends keep every record intact', () => {
  test('four real writers to one JSONL store: no lost, merged, or reordered record', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'shared.jsonl');
    const writers = await Promise.all([0, 1, 2, 3].map((i) => spawnWriter(
      ['append-jsonl', file, String(i), '25', '4096'],
      { racers: 4, cwd: APP_ROOT },
    )));
    for (const w of writers) assert.equal(w.code, 0, w.out);

    const records = readLines(file).map((l) => JSON.parse(l));
    assert.equal(records.length, 100, 'every append from every process is present');
    for (let writer = 0; writer < 4; writer += 1) {
      const seqs = records.filter((r) => r.writer === writer).map((r) => r.seq);
      assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i), `writer ${writer} records are complete and in order`);
    }
    for (const record of records) {
      assert.equal(record.markerEnd, 'END', 'each record is whole, not a fragment of a neighbour');
      assert.equal(record.pad.length, 4096);
    }
  });

  test('a reader running during appends never observes a partial line', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'live.jsonl');
    const store = new JsonlStore(file);
    let writing = true;
    const stats = { reads: 0, corrupt: 0, errors: 0 };
    const writersDone = Promise.all([0, 1, 2, 3].map((i) => spawnWriter(
      ['append-jsonl', file, String(i), '40', '2048'],
      { racers: 4, cwd: APP_ROOT },
    ))).then((runs) => { writing = false; return runs; });
    const reader = (async () => {
      while (writing) {
        try {
          const { corrupt } = await store.load();
          stats.reads += 1;
          stats.corrupt += corrupt.length;
        } catch {
          stats.errors += 1;
        }
      }
    })();
    const writers = await writersDone;
    await reader;

    for (const w of writers) assert.equal(w.code, 0, w.out);
    assert.ok(stats.reads > 0, 'the reader observed the file while it was being written');
    assert.equal(stats.errors, 0, 'no read failed');
    assert.equal(stats.corrupt, 0, `a live read reported ${stats.corrupt} partial line(s)`);
    assert.equal(readLines(file).length, 160, 'the final file holds every record');
  });

  test('concurrent memory writes: every fact is stored and readable', async () => {
    const dir = tempDir();
    const writers = await Promise.all([0, 1, 2, 3].map((i) => spawnWriter(
      ['add-memory', dir, String(i), '15'],
      { racers: 4, cwd: APP_ROOT },
    )));
    for (const w of writers) assert.equal(w.code, 0, w.out);
    const store = new MemoryStore(path.join(dir, 'memory.jsonl'));
    const status = await store.status();
    assert.deepEqual(status, { path: path.join(dir, 'memory.jsonl'), records: 60, corrupt: 0 });
    const listed = await store.list({ limit: 1000 });
    assert.equal(listed.length, 60, 'every add is visible');
    assert.equal(new Set(listed.map((r) => r.content)).size, 60, 'no record replaced another');
  });

  test('concurrent audit writes: every operation record is valid', async () => {
    const dir = tempDir();
    const writers = await Promise.all([0, 1, 2].map((i) => spawnWriter(
      ['append-ops', dir, String(i), '20'],
      { racers: 3, cwd: APP_ROOT },
    )));
    for (const w of writers) assert.equal(w.code, 0, w.out);
    const log = new OperationLog(path.join(dir, 'operations.jsonl'));
    assert.deepEqual(await log.status(), { records: 60, corrupt: 0 });
    const recent = await log.list({ limit: 5 });
    assert.equal(recent.records.length, 5);
    assert.equal(recent.corrupt, 0);
  });
});

describe('065: an append reports success only when the whole record is written', () => {
  test('a short write is completed before append resolves', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'short.jsonl');
    const store = new JsonlStore(file);
    const record = { note: 'n'.repeat(1200), markerEnd: 'END' };
    const realOpen = fsp.open;
    let firstWrite = true;
    fsp.open = async (...args) => {
      const handle = await realOpen(...args);
      const realWrite = handle.write.bind(handle);
      handle.write = async (data, offset = 0, length = data.length - offset) => {
        if (firstWrite) {
          firstWrite = false;
          return realWrite(data, offset, Math.max(1, Math.floor(length / 2)));
        }
        return realWrite(data, offset, length);
      };
      return handle;
    };
    try {
      await store.append(record);
    } finally {
      fsp.open = realOpen;
    }
    const loaded = await store.load();
    assert.equal(loaded.corrupt.length, 0, 'no fragment was left behind');
    assert.equal(loaded.records.length, 1, 'the record survived the short write');
    assert.deepEqual(loaded.records[0], record);
  });

  test('a write that accepts no bytes fails instead of reporting success', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'stalled.jsonl');
    const store = new JsonlStore(file);
    const realOpen = fsp.open;
    fsp.open = async (...args) => {
      const handle = await realOpen(...args);
      handle.write = async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
      return handle;
    };
    try {
      await assert.rejects(store.append({ note: 'never lands' }), /cannot write stalled\.jsonl: write accepted 0 of \d+ bytes/);
    } finally {
      fsp.open = realOpen;
    }
    const loaded = await store.load();
    assert.equal(loaded.records.length, 0, 'nothing is reported as stored');
  });
});
