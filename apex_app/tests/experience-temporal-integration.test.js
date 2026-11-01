// Batch AC: temporal queries through the assembled application.
//
// These tests use the real request path with no model configured: every experience fixture is an
// audited operation APEX actually carried out, so an experience's evidence is a record it wrote
// rather than a stub pretending to be one. No local inference is performed. What is checked here
// is the boundary the engine sits behind: the queries verify their own reads, write nothing, keep
// user text out of the audit, disclose damage instead of reporting an empty history, and feed only
// a small, clearly-caveated summary into world state and the model context.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { buildPrompt } from '../src/controller/context.js';
import { renderWorldState } from '../src/world/world-state.js';

function tempDir() {
  return makeTempDataDir();
}

function makeClock(start = '2026-10-01T09:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    set: (iso) => { ms = Date.parse(iso); },
    advanceDays: (days) => { ms += days * 86400000; },
  };
}

function appFor(dataDir, clock, options = {}) {
  return createApp({ dataDir, now: clock.now, ...options });
}

async function run(app, request) {
  const res = await app.controller.handle(request, { origin: 'user' });
  assert.ok(res.operation, `the fixture depends on "${request}" producing an audited operation`);
  return res.operation;
}

async function record(app, clock, request, { day = 0, subject = 'a recorded event' } = {}) {
  clock.advanceDays(day);
  const operation = await run(app, request);
  const { record: stored } = await app.experience.recordExperience({ operationId: operation.id, subject, origin: 'user' });
  return { operation, stored };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out[entry.name] = entry.isDirectory() ? '<dir>' : fs.readFileSync(full).toString('base64');
  }
  return out;
}

describe('AC-7 the four reads through the controller', () => {
  test('timeline, trends, patterns, and comparison each verify an independent re-read', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 1+1', { subject: 'evaluated 1+1' });
    await record(app, clock, 'calc 2+2', { day: 1, subject: 'evaluated 2+2' });
    await record(app, clock, 'calc 3+3', { day: 2, subject: 'evaluated 3+3' });

    const timeline = await app.controller.experienceTimeline({});
    assert.equal(timeline.status, Outcome.SUCCESS_VERIFIED);
    assert.match(timeline.display, /Experience timeline/);
    assert.equal(timeline.operation.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.match(timeline.operation.steps[0].verification.detail, /confirmed by an independent read/);

    const trends = await app.controller.experienceTrends({});
    assert.equal(trends.status, Outcome.SUCCESS_VERIFIED);
    assert.match(trends.display, /calc\.evaluate/);

    const patterns = await app.controller.experiencePatterns({});
    assert.equal(patterns.status, Outcome.SUCCESS_VERIFIED);
    assert.match(patterns.display, /repeated_success/);
    assert.match(patterns.display, /not a prediction|not a cause/i);

    const comparison = await app.controller.experienceCompare({});
    assert.equal(comparison.status, Outcome.SUCCESS_VERIFIED);
    assert.match(comparison.display, /Window A/);
    assert.match(comparison.display, /Window B/);
  });

  test('the audited result carries ids, counts, and no user text', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'remember that the review codename is Seaglass', { subject: 'stored the review codename' });

    const timeline = await app.controller.experienceTimeline({});
    const data = JSON.stringify(timeline.operation.steps[0].result.data);
    assert.doesNotMatch(data, /Seaglass|review codename|stored the review/);
    assert.ok(data.includes('eventIds'));
    assert.ok(data.includes('window'));
  });

  test('the default comparison is the last 30 days against the 30 days immediately before it', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    const comparison = await app.controller.experienceCompare({});
    const windows = comparison.operation.steps[0].result.data.comparison.windows;
    assert.equal(windows.b.until, clock.now().toISOString());
    const bSince = Date.parse(windows.b.since);
    const bUntil = Date.parse(windows.b.until);
    assert.equal(bUntil - bSince, 30 * 86400000);
    assert.equal(Date.parse(windows.a.until) + 1, bSince, 'the earlier window ends the millisecond before B begins');
    assert.equal(Date.parse(windows.a.until) - Date.parse(windows.a.since), bUntil - bSince);
  });

  test('a capability filter applies to the query, and invalid input is refused before any read', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 4+4');
    await record(app, clock, 'remember that the codename is Seaglass', { day: 1 });

    const scoped = await app.controller.experienceTimeline({ capability: 'calc.evaluate' });
    assert.equal(scoped.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(scoped.operation.steps[0].result.data.view.counts.inWindow, 1);

    const badDays = await app.controller.experienceTimeline({ days: 0 });
    assert.equal(badDays.status, Outcome.INPUT_REJECTED);
    const badBound = await app.controller.experienceTrends({ since: 'sometime last week' });
    assert.equal(badBound.status, Outcome.INPUT_REJECTED);
    const badCompare = await app.controller.experienceCompare({ aSince: '2026-10-05', aUntil: '2026-10-01' });
    assert.equal(badCompare.status, Outcome.EXECUTION_FAILED);
    assert.match(badCompare.output, /start of the window is after its end/);
  });
});

describe('AC-8 temporal reads are read-only and restart-stable', () => {
  test('no query writes to any store', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 5+5');
    await record(app, clock, 'calc 6+6', { day: 1 });
    const [first] = await app.experience.list({ limit: 1 });
    await app.experience.recordFeedback({
      target: first.id,
      assessment: 'not_useful',
      reason: 'synthetic fixture',
      origin: 'user',
    });

    const before = snapshot(dir);
    // The direct read paths: store queries and the action's own execution, without the
    // audit append a user-issued command performs around them.
    await app.experience.temporalAnalysis({});
    await app.experience.temporalComparison({});
    await app.experience.temporalSummary({});
    for (const name of ['experience.timeline', 'experience.trends', 'experience.patterns']) {
      const def = app.registry.get(name);
      await def.execute({}, def.validate({}));
    }
    const compare = app.registry.get('experience.compare');
    await compare.execute({}, compare.validate({}));
    await app.controller.worldState();
    const after = snapshot(dir);
    assert.deepEqual(after, before, 'a read-only query must not append, rewrite, or lock any file');
  });

  test('a restarted application reports the same window, counts, and ids', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const first = appFor(dir, clock);
    await record(first, clock, 'calc 7+7');
    await record(first, clock, 'calc 8+8', { day: 1 });
    await record(first, clock, 'calc 9+9', { day: 2 });
    const query = { since: '2026-09-25', until: '2026-10-05' };
    const a = await first.experience.temporalAnalysis(query);

    const second = appFor(dir, clock);
    const b = await second.experience.temporalAnalysis(query);
    assert.deepEqual(b.view.window, a.view.window);
    assert.deepEqual(b.view.counts, a.view.counts);
    assert.deepEqual(b.view.events.map((event) => event.id), a.view.events.map((event) => event.id));
    assert.deepEqual(
      b.patterns.patterns.map((pattern) => `${pattern.kind}:${pattern.evidence.experienceIds.join(',')}`),
      a.patterns.patterns.map((pattern) => `${pattern.kind}:${pattern.evidence.experienceIds.join(',')}`),
    );
  });

  test('a store appended between the two reads makes verification fail instead of claiming success', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 10+10');
    await record(app, clock, 'calc 11+11', { day: 1 });

    const def = app.registry.get('experience.timeline');
    const query = def.validate({});
    const result = await def.execute({}, query);
    // A concurrent writer appends while the reader's first result is still the one it will check.
    await record(app, clock, 'calc 12+12', { day: 1 });
    const verification = await def.verify({}, query, result);
    assert.equal(verification.ok, false);
    assert.match(verification.detail, /changed during the read/);

    // With no append in between, the same two steps agree.
    const stable = await def.execute({}, query);
    const recheck = await def.verify({}, query, stable);
    assert.equal(recheck.ok, true);
  });

  test('a large stored history is bounded in the returned view', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    for (let index = 0; index < 25; index += 1) {
      await record(app, clock, `calc ${index + 1}+${index + 1}`);
      clock.advanceDays(0.05);
    }
    const res = await app.controller.experienceTimeline({ limit: 10 });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    const view = res.operation.steps[0].result.data.view;
    assert.equal(view.counts.inWindow, 25);
    assert.equal(view.eventIds.length, 10);
    assert.match(res.display, /the most recent 10 of 25/);
  });
});

describe('AC-9 capture provenance and explicit feedback', () => {
  test('automatic and explicit capture are counted separately, and no feedback is invented', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock, { experienceCapture: 'verified-success' });

    clock.advanceDays(1);
    const automatic = await run(app, 'remember that the backup window is Tuesday');
    assert.equal(automatic.capability, 'memory.add');
    const automaticallyStored = await app.experience.list();
    assert.equal(automaticallyStored.length, 1);
    assert.equal(automaticallyStored[0].capture, 'automatic');

    await record(app, clock, 'calc 13+13', { day: 1 });

    const timeline = await app.controller.experienceTimeline({});
    const counts = timeline.operation.steps[0].result.data.view.counts;
    assert.equal(counts.explicit, 1);
    assert.equal(counts.automatic, 1);
    assert.equal(counts.feedback, 0, 'nothing assessed the automatically captured event');
    assert.match(timeline.display, /1 captured automatically, 1 recorded by you/);
  });
});

describe('AC-10 world state and model context', () => {
  test('the world projection carries a bounded temporal section with its limits', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 14+14');
    await record(app, clock, 'calc 15+15', { day: 1 });
    await record(app, clock, 'calc 16+16', { day: 2 });

    const res = await app.controller.worldState();
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(res.world.temporal.available, true);
    assert.equal(res.world.temporal.counts.events, 3);
    assert.equal(res.world.temporal.prediction, false);
    const text = renderWorldState(res.world);
    assert.match(text, /Temporal:\s+3 recorded event/);
    assert.match(text, /Temporal order: repeated_success/);
    assert.match(text, /recorded order is not cause/);

    const step = await app.controller.runAction('world.state', {}, 'user', 'op-world-temporal');
    assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED);
    assert.equal(step.result.data.temporal.available, true);
    assert.equal(step.result.data.temporal.counts.events, 3);
    assert.deepEqual(step.result.data.temporal.patternKinds, ['repeated_success']);
  });

  test('a corrupt experience log is disclosed as unavailable, never as an empty history', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 17+17');
    const file = path.join(dir, 'experiences.jsonl');
    fs.writeFileSync(file, `{broken line\n${fs.readFileSync(file, 'utf8')}`, 'utf8');

    const timeline = await app.controller.experienceTimeline({});
    assert.equal(timeline.status, Outcome.EXECUTION_FAILED);
    assert.match(timeline.output, /corrupt line/);

    const world = await app.controller.worldState();
    assert.equal(world.status, Outcome.EXECUTION_FAILED, 'an incomplete projection is not verified success');
    assert.equal(world.world.temporal.available, false);
    assert.equal(world.world.complete, false);
    assert.equal(world.world.attention, true);
    assert.match(renderWorldState(world.world), /Temporal:\s+unavailable/);

    const prompt = buildPrompt({
      request: 'what happened recently with calc?',
      memoryHits: [],
      turns: [],
      temporal: null,
      temporalUnavailable: true,
    });
    assert.match(prompt.prompt, /APEX TEMPORAL SUMMARY: could not be read/);
    assert.equal(prompt.temporalIncluded, false);
  });

  test('the temporal summary enters the prompt only for a time-related request', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 18+18');
    await record(app, clock, 'calc 19+19', { day: 1 });
    await record(app, clock, 'calc 20+20', { day: 2 });
    const temporal = { available: true, ...(await app.experience.temporalSummary()) };

    const relevant = buildPrompt({ request: 'how have recent outcomes gone?', memoryHits: [], turns: [], temporal });
    assert.equal(relevant.temporalIncluded, true);
    assert.match(relevant.prompt, /APEX TEMPORAL SUMMARY/);
    assert.match(relevant.prompt, /does not show that one event caused another/);

    const ordinary = buildPrompt({ request: 'what is the capital of France?', memoryHits: [], turns: [], temporal });
    assert.equal(ordinary.temporalIncluded, false);
    assert.doesNotMatch(ordinary.prompt, /APEX TEMPORAL SUMMARY/);
  });

  test('the temporal summary gives up its room before any retrieved memory does', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'remember that the project codename is Seaglass');
    await record(app, clock, 'calc 21+21', { day: 1 });
    await record(app, clock, 'calc 22+22', { day: 2 });
    await record(app, clock, 'calc 23+23', { day: 3 });
    const temporal = { available: true, ...(await app.experience.temporalSummary()) };
    const hits = await app.memory.search('codename', { limit: 3 });
    const input = { request: 'what happened with recent outcomes and the codename?', memoryHits: hits, turns: [], temporal };

    const full = buildPrompt(input);
    assert.equal(full.temporalIncluded, true);
    assert.equal(full.memoryIds.length > 0, true);

    let observedDrop = null;
    for (let maxChars = full.prompt.length - 1; maxChars > 200; maxChars -= 10) {
      const built = buildPrompt({ ...input, maxChars });
      if (!built.temporalIncluded || built.temporalLines < built.temporalLinesTotal) {
        observedDrop = built;
        break;
      }
    }
    assert.ok(observedDrop, 'the budget must eventually trim the temporal section');
    assert.equal(observedDrop.memoryIds.length, full.memoryIds.length, 'no retrieved record was dropped first');
  });

  test('an omitted temporal summary is stated, not silently absent', async (t) => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    const clock = makeClock();
    const app = appFor(dir, clock);
    await record(app, clock, 'calc 24+24');
    await record(app, clock, 'calc 25+25', { day: 1 });
    await record(app, clock, 'calc 26+26', { day: 2 });
    const temporal = { available: true, ...(await app.experience.temporalSummary()) };
    const built = buildPrompt({ request: 'recent outcomes?', memoryHits: [], turns: [], temporal, maxChars: 440 });
    assert.equal(built.temporalIncluded, false);
    assert.match(built.prompt, /APEX TEMPORAL SUMMARY: omitted from this context/);
  });
});
