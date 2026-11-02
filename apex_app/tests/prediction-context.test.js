// Batch AE-06: the prediction ledger as it reaches a model context and the world-state projection.
//
// AE-05 proved that a prediction can only be written by an authorized user command and that its
// verdict is computed from records. This suite asks where that information goes afterwards, which is
// where a prediction is most likely to be mistaken for a report of something that happened: a model
// context is prose, and an expectation sitting in prose beside recalled records reads like evidence
// unless the section says otherwise. So every assertion here is made against what the real path
// produced - the bytes sent to a test-double backend, the rendered projection, the audit record -
// never against internals.
//
// Four boundaries get the closest attention:
//
//   separation   an expectation is labelled as an expectation, in a section of its own, after the
//                records that describe what happened; it never enters the memory, knowledge, belief
//                or temporal sections, and recording a prediction changes no experience record;
//   scope        the ledger is opened only for a request whose own words speak about a prediction,
//                and only its published prompt shape crosses - aggregate counts and a few standing
//                ids, never the subject prose that only the ledger holds;
//   truthfulness an unreadable ledger is stated as unavailable on both surfaces, never as an empty
//                one, and the counts state their own denominator and why no rate is given;
//   budget       under pressure the expectation block gives up its room before any retrieved record
//                does, and its loss is announced rather than going silent.
//
// Nothing here contacts a model, starts an inference service, or downloads anything. Every prompt is
// captured by an in-process test double that records what it was sent.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { Outcome } from '../src/outcomes.js';
import { shortId } from '../src/util.js';
import {
  buildPrompt,
  predictionPromptLines,
  predictionPromptRelevant,
} from '../src/controller/context.js';
import { renderWorldState } from '../src/world/world-state.js';
import { MAX_PREDICTION_PROMPT_ITEMS, PREDICTION_KIND } from '../src/prediction/prediction-engine.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const dir = makeTempDataDir();
  dirs.push(dir);
  return dir;
}

function makeClock(start = '2026-10-01T09:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advanceDays: (days) => { ms += days * 86400000; },
  };
}

// A backend that records the exact system text and prompt text it was sent. "The model received X"
// is then a measurement of this process's call, not a claim about any real model.
function capturingGateway(reply = 'double answer') {
  const state = { calls: 0, prompts: [], systems: [], reply };
  const backend = {
    name: 'test-double',
    provider: 'test-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'test-double', endpoint: 'test-double', model: 'test-double' }),
    health: async () => ({ available: true, detail: 'test double' }),
    async complete({ system, prompt }) {
      state.calls += 1;
      state.systems.push(system);
      state.prompts.push(prompt);
      return {
        ok: true, backend: 'test-double', provider: 'test-double', model: 'test-double',
        text: state.reply, finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), state };
}

function appFor(dir, clock, options = {}) {
  return createApp({ dataDir: dir, now: clock.now, ...options });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function ledgerOf(dir) {
  return readLines(path.join(dir, 'predictions.jsonl')).map((line) => JSON.parse(line));
}

function expectationsOf(dir) {
  return ledgerOf(dir).filter((record) => record.kind === PREDICTION_KIND);
}

// An operation APEX really ran and audited, plus the experience the user recorded of it - the only
// kind of evidence a prediction may cite, and the only kind that can establish an outcome.
async function seedEvent(app, clock, { request = 'calc 1+1', subject = 'evaluated 1+1', day = 0 } = {}) {
  clock.advanceDays(day);
  const res = await app.controller.handle(request, { origin: 'user' });
  assert.ok(res.operation, `the fixture depends on "${request}" producing an audited operation`);
  const { record } = await app.experience.recordExperience({
    operationId: res.operation.id,
    subject,
    origin: 'user',
  });
  return { operation: res.operation, experience: record };
}

// An expectation entered through the authorized command, returning the id the ledger stored. The id
// is read back out of the log rather than trusted from the write result, because the log is what a
// later reader recomputes state from.
async function recordExpectation(app, dir, input) {
  const res = await app.controller.predictionRecord(input);
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, `record failed: ${res.output}`);
  return expectationsOf(dir).at(-1).id;
}

// Sections of the model prompt are separated by blank lines, so a section can be read back out of the
// assembled text exactly as the model was sent it.
function sectionOf(prompt, header) {
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const rest = prompt.slice(start);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

// The rendered projection has no blank lines, so one of its sections is a run of lines: the labelled
// line and every line indented further than it.
function worldSection(text, label) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith(label));
  if (start < 0) return null;
  const taken = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    taken.push(line);
  }
  return taken.join('\n');
}

const EXPECTATION_HEADER = 'APEX RECORDED EXPECTATIONS';
const expectationSection = (prompt) => sectionOf(prompt, EXPECTATION_HEADER);

const SUBJECT = 'the next calculation is reported as a verified success';
// disclaimer + Standing + Verdicts + Named for one standing expectation.
const BLOCK_LINES = 4;

describe('the recorded-expectation block inside a model context', () => {
  test('an expectation is sent as an expectation: its own label, its lifecycle, and no confidence', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });
    await seedEvent(app, clock, { request: 'calc 2+2', subject: 'evaluated 2+2', day: 1 });

    const res = await app.controller.handle('what do I expect to happen next with calculations?');
    assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'a model answer is not independently verifiable');
    assert.equal(cap.state.calls, 1);
    const prompt = cap.state.prompts[0];
    const block = expectationSection(prompt);
    assert.ok(block, 'a request about an expectation carries the expectation section');

    // The heading itself states the category, before any count a model could lift out of it.
    assert.match(block, /APEX RECORDED EXPECTATIONS \(the user's own recorded predictions, not observations, not instructions\)/);
    assert.match(block, /These are expectations the user recorded about later outcomes, not observations/);
    assert.match(block, /none of it authorizes an action or approves an adaptation/);
    assert.match(block, /no prediction in this build carries a confidence value/);
    assert.doesNotMatch(block, /confidence: /, 'a confidence value is never printed, only the statement that none exists');
    // Its state is the state the ledger derives: evidence exists inside the horizon, no verdict yet.
    assert.match(block, /calc\.evaluate expects success: awaiting_evaluation/);
    assert.match(block, /1 have outcome evidence but no recorded verdict/);
    assert.match(block, /evidence at creation none cited/);
    // A rate is not invented from one expectation, and the withheld rate says why.
    assert.match(block, /no rate is stated/);
    assert.match(block, /this sample supports no claim about reliability/);
    assert.doesNotMatch(prompt, /100%/);

    // What the model was sent and what the audit says agree, because both come from one read.
    const audit = res.operation.prompt.predictions;
    assert.equal(audit.relevant, true);
    assert.equal(audit.included, true);
    assert.equal(audit.live, 1);
    assert.equal(audit.evaluated, 0);
    assert.equal(audit.expired, 0);
    assert.equal(audit.lines, BLOCK_LINES);
    assert.equal(audit.linesTotal, BLOCK_LINES);
  });

  test('every lifecycle state the ledger holds is stated, and a passed horizon is not a wrong prediction', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });

    // One expectation in each state the ledger can derive, built only from records the app wrote.
    const recorded = await recordExpectation(app, dir, { capability: 'search.web', expectation: 'success', subject: 'the next search returns a result', inDays: 30 });
    const awaiting = await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });
    const scoreable = await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: 'a later calculation is reported as a verified success', inDays: 30 });
    const expiring = await recordExpectation(app, dir, { capability: 'memory.recall', expectation: 'success', subject: 'the next recall is reported as a verified success', inDays: 1 });
    const withdrawn = await recordExpectation(app, dir, { capability: 'file.list', expectation: 'success', subject: 'the next listing is reported as a verified success', inDays: 30 });
    const replaced = await recordExpectation(app, dir, { capability: 'summary.queue', expectation: 'success', subject: 'the next summary is delivered', inDays: 30 });
    const successor = await recordExpectation(app, dir, { capability: 'summary.queue', expectation: 'success', subject: 'a later summary is delivered', inDays: 30, replaces: [shortId(replaced)] });

    await seedEvent(app, clock, { request: 'calc 2+2', subject: 'evaluated 2+2', day: 1 });
    const evaluated = await app.controller.predictionEvaluate({ target: shortId(scoreable) });
    assert.equal(evaluated.status, Outcome.SUCCESS_VERIFIED, evaluated.output);
    const invalidation = await app.controller.predictionInvalidate({ target: shortId(withdrawn), reason: 'the user no longer holds this expectation' });
    assert.equal(invalidation.status, Outcome.SUCCESS_VERIFIED, invalidation.output);
    clock.advanceDays(2);

    const res = await app.controller.handle('what are my recorded expectations and how have they turned out?');
    const block = expectationSection(cap.state.prompts[0]);
    assert.ok(block);
    assert.match(block, /Standing: 6 expectation\(s\): 2 lack outcome evidence, 1 have outcome evidence but no recorded verdict, 1 passed their horizon, 1 have a recorded verdict; 1 withdrawn by the user, 1 replaced by a later one/);
    assert.match(block, /A horizon that passed with no outcome evidence is not a wrong prediction/);
    assert.match(block, /Verdicts: 1 matched, 0 contradicted, counted only over 1 evaluation\(s\) of expectations the user did not withdraw/);
    const audit = res.operation.prompt.predictions;
    assert.equal(audit.live, 6, 'the audit reports the same live count the block states');
    assert.equal(audit.evaluated, 1);
    assert.equal(audit.expired, 1, 'the passed horizon is audited as a count, not as a wrong prediction');

    // Only expectations that still stand may be named. A withdrawn, replaced or already-judged
    // expectation appears in the counts and never as a live item a model could act on.
    for (const gone of [withdrawn, replaced, scoreable]) {
      assert.equal(block.includes(shortId(gone)), false, `${shortId(gone)} no longer stands and must not be listed as a named expectation`);
    }
    const standing = [recorded, awaiting, expiring, successor];
    const named = standing.filter((id) => block.includes(shortId(id)));
    assert.ok(named.length >= 1, 'a standing expectation is named while the ledger has room for one');
    assert.match(block, new RegExp(`${standing.length - named.length} further standing expectation\\(s\\) are in the ledger`), 'what the line had no room for is counted, not lost');
  });

  test('a cited basis is stated and the subject prose stays in the ledger', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    const { experience } = await seedEvent(app, clock);
    await recordExpectation(app, dir, {
      capability: 'calc.evaluate',
      expectation: 'success',
      subject: SUBJECT,
      inDays: 30,
      evidence: { supportingExperienceIds: [experience.id] },
    });

    await app.controller.handle('do I have any expectations about calculations?');
    const block = expectationSection(cap.state.prompts[0]);
    assert.ok(block);
    assert.match(block, /evidence at creation cited recorded events/);

    // The sentence that describes the expectation is the record's own text and it is not sent: an
    // expectation must not reach a model as prose that reads like an observation of a fact.
    for (const text of [cap.state.prompts[0], cap.state.systems[0]]) {
      assert.equal(text.includes(SUBJECT), false, 'the subject prose left the ledger');
    }
    assert.equal(fs.readFileSync(path.join(dir, 'predictions.jsonl'), 'utf8').includes(SUBJECT), true, 'the ledger still holds what the user wrote');
    // Capability and state do cross, because they are a category and a derivation, not narration.
    assert.match(block, /calc\.evaluate expects success/);
  });

  test('the whole ledger is never injected: ten standing expectations contribute a bounded list and an honest count', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    const ids = [];
    for (let i = 1; i <= 10; i += 1) {
      ids.push(await recordExpectation(app, dir, {
        capability: 'calc.evaluate',
        expectation: 'success',
        subject: `the ${i}th calculation is reported as a verified success`,
        inDays: 30,
      }));
    }
    assert.equal(ledgerOf(dir).length, 10);

    const view = await app.predictions.promptView();
    assert.equal(view.active.length, MAX_PREDICTION_PROMPT_ITEMS, 'the published shape is bounded whatever the ledger holds');
    assert.equal(view.omitted, 10 - MAX_PREDICTION_PROMPT_ITEMS);

    await app.controller.handle('what predictions do I hold about calculations?');
    const block = expectationSection(cap.state.prompts[0]);
    assert.ok(block);
    assert.equal(block.split('\n').length, MAX_PREDICTION_PROMPT_ITEMS + 1, 'one heading plus at most the bounded lines, never one line per record');
    const named = ids.filter((id) => block.includes(shortId(id)));
    assert.ok(named.length >= 1, 'at least one standing expectation is named while the ledger has a standing expectation');
    assert.ok(named.length <= MAX_PREDICTION_PROMPT_ITEMS, `no more than the bound of ${MAX_PREDICTION_PROMPT_ITEMS} is named`);
    // The count of what was left out is exact, whether the published shape or this line's length
    // dropped it, so the list can never read as the whole ledger.
    assert.match(block, new RegExp(`${10 - named.length} further standing expectation\\(s\\) are in the ledger and readable with "prediction list"`));
    const leftOut = ids.filter((id) => !named.includes(id));
    assert.equal(leftOut.some((id) => block.includes(shortId(id))), false, 'an expectation the block left out is not in the context anyway');
    // And the line that carries them is built to fit, not cut: a truncated tail would drop the very
    // sentence that says more expectations exist.
    const namedLine = block.split('\n').find((line) => line.startsWith('Named:'));
    assert.ok(namedLine);
    assert.equal(namedLine.includes('...'), false, 'the named list was shortened, not sliced mid-record');
  });

  test('an empty ledger contributes nothing, so a quiet context is not read as a lost expectation', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });

    const res = await app.controller.handle('what do I expect to happen next?');
    assert.equal(cap.state.calls, 1);
    assert.equal(expectationSection(cap.state.prompts[0]), null, 'nothing recorded adds nothing');
    assert.equal(predictionPromptLines(await app.predictions.promptView()).length, 0);
    assert.equal(res.operation.prompt.predictions.included, false);
    assert.equal(res.operation.prompt.predictions.live, 0);
    assert.equal(res.operation.prompt.predictions.relevant, true, 'the ledger was opened and found empty; that is a different fact from not looking');
  });
});

describe('the ledger is read only for a request the user made relevant', () => {
  test('an unrelated request never opens the prediction ledger', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });

    let reads = 0;
    const real = app.predictions.promptView.bind(app.predictions);
    app.predictions.promptView = async (options) => { reads += 1; return real(options); };

    const unrelated = await app.controller.handle('what is the capital of France?');
    assert.equal(cap.state.calls, 1);
    assert.equal(reads, 0, 'an unrelated answer does not open the ledger at all');
    assert.equal(expectationSection(cap.state.prompts[0]), null);
    assert.equal(unrelated.operation.prompt.predictions, undefined, 'no gate decision is audited for a request that never needed one');

    // The expectation is about calc.evaluate, and this request is too - but it does not speak about
    // an expectation, so the ledger stays shut. The gate is the user's own words, not the topic.
    const topical = await app.controller.handle('how does the calc.evaluate capability work?');
    assert.equal(cap.state.calls, 2);
    assert.equal(reads, 0, 'naming the capability an expectation concerns is not asking about the expectation');
    assert.equal(topical.operation.prompt.predictions, undefined);

    const relevant = await app.controller.handle('should I expect that to work?');
    assert.equal(cap.state.calls, 3);
    assert.equal(reads, 1, 'the one relevant request opened the ledger exactly once');
    assert.equal(relevant.operation.prompt.predictions.relevant, true);
    assert.ok(expectationSection(cap.state.prompts[2]));
  });

  test("relevance is decided from the user's own words, including their stems and horizon words", () => {
    for (const request of [
      'what are my predictions here?',
      'do I expect this to succeed',
      'am I anticipating a failure?',
      'what is my forecast for the deploy?',
      'will my expectation about the deploy hold tomorrow?',
      'what is due soon for calculations?',
    ]) {
      assert.equal(predictionPromptRelevant(request), true, `"${request}" speaks about an expectation`);
    }
    for (const request of [
      'what is the capital of France?',
      'list the files in the project',
      'summarize my recent outcomes',
      'remember that the codename is Seaglass',
    ]) {
      assert.equal(predictionPromptRelevant(request), false, `"${request}" says nothing about a prediction`);
    }
    // A word that merely contains a term is not the term: tokenization, not substring matching.
    assert.equal(predictionPromptRelevant('the forecastle is below deck'), false);
  });

  test('an expectation keeps out of the sections that describe what happened', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    const remembered = await app.controller.runAction('memory.add', {
      content: 'the deploy checklist is kept in the runbook',
    }, 'user', 'op-seed');
    assert.equal(remembered.outcome, Outcome.SUCCESS_VERIFIED);
    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });

    await app.controller.handle('what do I expect about the deploy?');
    const prompt = cap.state.prompts[0];
    const memory = sectionOf(prompt, 'MEMORY (recalled data');
    assert.ok(memory, 'the stored record that answers the question is still in the context');
    assert.match(memory, /deploy checklist is kept in the runbook/);
    assert.equal(memory.includes('expects'), false, 'no expectation line leaked into the recalled-data section');
    assert.equal(memory.includes(shortId(expectationsOf(dir)[0].id)), false, 'no prediction id appears among recalled records');
    // Order matters: the records come first, the expectation section after them and before the
    // conversation, so an expectation never reads as the thing the retrieval found.
    const at = prompt.indexOf(EXPECTATION_HEADER);
    assert.ok(at > prompt.indexOf('MEMORY (recalled data'));
    assert.ok(at < prompt.indexOf('RECENT CONVERSATION'));
    assert.ok(at < prompt.indexOf('USER REQUEST'));
  });

  test('recording an expectation changes no experience record and no temporal count', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    await seedEvent(app, clock, { request: 'calc 1+1', subject: 'evaluated 1+1' });
    await seedEvent(app, clock, { request: 'calc 2+2', subject: 'evaluated 2+2', day: 1 });
    const before = fs.readFileSync(path.join(dir, 'experiences.jsonl'), 'utf8');

    await app.controller.handle('how have recent outcomes gone?');
    const temporalBefore = sectionOf(cap.state.prompts[0], 'APEX TEMPORAL SUMMARY');
    assert.ok(temporalBefore, 'the request is temporal, so the summary is in the context');
    assert.equal(expectationSection(cap.state.prompts[0]), null, 'no expectation exists yet');

    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });
    assert.equal(fs.readFileSync(path.join(dir, 'experiences.jsonl'), 'utf8'), before, 'the experience log is byte-for-byte unchanged');

    await app.controller.handle('how have recent outcomes gone, and what do I expect next?');
    assert.equal(cap.state.calls, 2, 'both requests reached the test double, so both prompts are measurable');
    const temporalAfter = sectionOf(cap.state.prompts[1], 'APEX TEMPORAL SUMMARY');
    assert.equal(temporalAfter, temporalBefore, 'the temporal summary says the same thing about the same records');
    const block = expectationSection(cap.state.prompts[1]);
    assert.ok(block, 'and the expectation is stated, in its own section');
    assert.doesNotMatch(temporalAfter, /expect/i, 'the pattern section never took on the expectation');
    assert.equal(ledgerOf(dir).length, 1);
  });
});

describe('the world-state projection reports expectations in a section of their own', () => {
  test('expectations are projected beside beliefs and never among them', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    const remembered = await app.controller.runAction('memory.add', {
      content: 'the deploy checklist is kept in the runbook',
    }, 'user', 'op-seed');
    assert.equal(remembered.outcome, Outcome.SUCCESS_VERIFIED);

    const before = await app.controller.worldState();
    assert.equal(before.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(before.world.predictions.available, true);
    assert.equal(before.world.predictions.counts.live, 0);
    const beliefsBefore = before.world.beliefs.total;

    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });
    const after = await app.controller.worldState();
    assert.equal(after.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(after.world.beliefs.total, beliefsBefore, 'a prediction is not a belief and did not become one');
    assert.equal(after.world.predictions.counts.live, 1);
    assert.equal(after.world.predictions.confidenceAvailable, false);
    assert.equal(JSON.stringify(after.world.predictions).includes(SUBJECT), false, 'no subject prose crosses into the projection');

    const text = renderWorldState(after.world);
    assert.match(text, /Expectations: {3}1 standing expectation\(s\) of 1 recorded/);
    assert.match(text, /confidence is unavailable for every record/);
    assert.match(text, /an expectation is what the user recorded about a later outcome, not an observation and not a belief/);
    assert.match(text, /Expectations standing: \[[0-9a-f]{8}\] calc\.evaluate expects success \(recorded/);
    const beliefs = worldSection(text, 'User-asserted beliefs');
    assert.ok(beliefs);
    assert.match(beliefs, /deploy checklist is kept in the runbook/);
    assert.equal(beliefs.includes('expects'), false, 'the expectation is not rendered as a belief line');
    assert.doesNotMatch(beliefs, /Expectations:/, 'the belief section stopped before the expectation section');
  });

  test('an unreadable ledger is disclosed as unavailable on both surfaces, never as no expectations', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const cap = capturingGateway();
    const app = appFor(dir, clock, { gateway: cap.gateway });
    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });
    const file = path.join(dir, 'predictions.jsonl');
    fs.writeFileSync(file, `{broken line\n${fs.readFileSync(file, 'utf8')}`, 'utf8');

    const world = await app.controller.worldState();
    assert.equal(world.status, Outcome.EXECUTION_FAILED, 'a projection with an unreadable ledger is not verified success');
    assert.equal(world.world.predictions.available, false);
    assert.equal(world.world.complete, false);
    assert.equal(world.world.attention, true);
    const rendered = renderWorldState(world.world);
    assert.match(rendered, /Expectations: {3}unavailable/);
    assert.match(rendered, /recorded expectations are not represented/);
    assert.match(rendered, /The prediction ledger could not be read/);
    assert.doesNotMatch(rendered, /Expectations: {3}0 standing/, 'unavailable was rendered as an empty ledger');
    assert.equal(rendered.includes('1 standing expectation'), false, 'the damaged ledger still contributed no count');

    const res = await app.controller.handle('what do I expect to happen next?');
    const prompt = cap.state.prompts[0];
    assert.ok(prompt.includes(`${EXPECTATION_HEADER}: the prediction ledger could not be read`));
    assert.match(prompt, /it does not follow that none exists/);
    assert.doesNotMatch(prompt, /Standing: \d/, 'an unreadable ledger contributed no counts');
    assert.equal(res.operation.prompt.predictions.included, false);
    assert.equal(res.operation.prompt.predictions.unavailable, true);
    assert.equal(res.operation.prompt.predictions.relevant, true);
    assert.ok(res.operation.errors.some((entry) => entry.stage === 'predictions'));
    assert.match(res.operation.errors.find((entry) => entry.stage === 'predictions').message, /corrupt line/);

    // An unrelated request never reaches the damaged ledger, so it is neither told about it nor given
    // a partial view of it.
    cap.state.prompts.length = 0;
    await app.controller.handle('what is the capital of France?');
    assert.equal(cap.state.prompts[0].includes(EXPECTATION_HEADER), false);
  });
});

describe('the expectation block gives up its room first', () => {
  test('budget pressure trims the expectation section before any retrieved record, and says so', async () => {
    const dir = tempDir();
    const clock = makeClock();
    const app = appFor(dir, clock);
    await app.controller.runAction('memory.add', { content: 'remember that the project codename is Seaglass' }, 'user', 'op-seed');
    // A stored guess the projection has to disclose, so this fixture really exercises all three
    // derived sections at once: the projection, the temporal summary and the expectations.
    await app.controller.runAction('memory.save_conclusion', {
      content: 'the codename is probably a nautical term', operationId: 'op-source', backend: 'stub',
    }, 'user', 'op-seed');
    await seedEvent(app, clock, { request: 'calc 3+3', subject: 'evaluated 3+3' });
    await seedEvent(app, clock, { request: 'calc 4+4', subject: 'evaluated 4+4', day: 1 });
    await recordExpectation(app, dir, { capability: 'calc.evaluate', expectation: 'success', subject: SUBJECT, inDays: 30 });

    const world = (await app.controller.worldState()).world;
    const predictions = await app.predictions.promptView();
    const temporal = { available: true, ...(await app.experience.temporalSummary()) };
    const hits = await app.memory.search('codename', { limit: 3 });
    const input = {
      request: 'what happened recently, and what do I expect about the codename?',
      memoryHits: hits,
      turns: [],
      knowledge: [],
      world,
      temporal,
      predictions,
    };

    const full = buildPrompt(input);
    assert.equal(full.predictionsIncluded, true);
    assert.equal(full.worldIncluded, true, 'the fixture gives the projection something to disclose, so the trim order is measurable');
    assert.equal(full.temporalIncluded, true);
    assert.equal(full.predictionLinesTotal, BLOCK_LINES);
    assert.ok(full.memoryIds.length > 0, 'the fixture retrieves a record that answers the question');
    const memoryIds = full.memoryIds;

    let first = null;
    for (let maxChars = full.prompt.length - 1; maxChars > 200; maxChars -= 10) {
      const built = buildPrompt({ ...input, maxChars });
      if (built.predictionLines < built.predictionLinesTotal) {
        first = built;
        break;
      }
    }
    assert.ok(first, 'the budget must eventually trim the expectation block');
    assert.equal(first.predictionLines, BLOCK_LINES - 1);
    assert.deepEqual(first.memoryIds, memoryIds, 'no retrieved record was dropped first');
    assert.equal(first.temporalIncluded, true, 'the expectation block gives up room before the temporal summary');
    assert.equal(first.worldIncluded, true);
    // What survives the first trim is the statement, not a bare count: the block is trimmed from the
    // end, so the line saying these are not observations is the last to go.
    assert.match(first.prompt, /These are expectations the user recorded about later outcomes, not observations/);

    // Then squeeze the budget all the way down and watch the omission notices. They are measured on
    // the same derived sections with nothing retrieved in the prompt, because a notice may never be
    // the reason a record that answers the question is dropped: with records competing for the same
    // room, the budget that leaves space for the block's lines always leaves space for a line too,
    // so the eviction is what the ladder below has to show on its own. The character count at which
    // a notice fits depends on every section, so the ladder is measured rather than hardcoded; the
    // order it must show is what is asserted.
    const noticeFor = {
      world: 'APEX STORE-WIDE PROJECTION: omitted from this context',
      temporal: 'APEX TEMPORAL SUMMARY: omitted from this context',
      prediction: `${EXPECTATION_HEADER}: omitted from this context`,
    };
    const bare = buildPrompt({ ...input, memoryHits: [], maxChars: 6000 });
    assert.equal(bare.memoryIds.length, 0);
    assert.equal(bare.predictionsIncluded, true);
    const ladder = [];
    for (let maxChars = bare.prompt.length - 1; maxChars >= 120; maxChars -= 10) {
      const built = buildPrompt({ ...input, memoryHits: [], maxChars });
      if (built.predictionsIncluded) continue;
      ladder.push({
        maxChars,
        built,
        notices: Object.fromEntries(Object.entries(noticeFor).map(([key, text]) => [key, built.prompt.includes(text)])),
      });
    }

    const noticed = ladder.filter((step) => step.notices.prediction);
    assert.ok(noticed.length > 0, 'an emptied expectation section is stated, not left as silence');
    const widest = noticed[0].built;
    assert.equal(widest.predictionsIncluded, false);
    assert.equal(widest.predictionLines, 0);
    assert.match(widest.prompt, /They remain expectations, not observations/);
    assert.match(widest.prompt, /"prediction list"/, 'the omission notice points at the read that still works');
    assert.equal(widest.worldIncluded || widest.temporalIncluded, true,
      'the notice rides beside whatever the other derived sections still have room for; it does not wait until every one of them is gone');

    // No budget may keep the whole-store counts' notice while dropping the expectation one: a
    // missing projection is a smaller truthfulness gap than a silent ledger of the user's own
    // expectations, so the notices give up their room in that order.
    for (const step of ladder) {
      assert.equal(step.notices.world && step.notices.prediction === false, false,
        `at ${step.built.prompt.length} chars the projection notice survived while the expectation notice was silenced`);
      assert.equal(step.notices.temporal && step.notices.prediction === false, false,
        `at ${step.built.prompt.length} chars the temporal notice survived while the expectation notice was silenced`);
    }
    const last = ladder.at(-1);
    assert.equal(last.notices.prediction, false, 'and once even the notice has no room left, nothing is forced in');
    assert.equal(last.built.worldIncluded, false);
    assert.equal(last.built.temporalIncluded, false);
    assert.ok(last.maxChars < noticed[0].maxChars, 'the notice gives up its room only as the budget tightens');
    const onlyExpectation = noticed.find((step) => step.notices.world === false && step.notices.temporal === false);
    assert.ok(onlyExpectation, 'a tight budget keeps the expectation notice after the projection and temporal notices have given up their room');
  });

  test('a block whose first line cannot fit is not sent in pieces', () => {
    const lines = predictionPromptLines({
      counts: { live: 1, recorded: 1, awaiting_evaluation: 0, expired: 0, evaluated: 0, matched: 0, contradicted: 0, invalidated: 0, superseded: 0 },
      matchRate: { value: null, numerator: 0, denominator: 0, reason: 'no prediction has been evaluated yet' },
      reliability: 'no_evaluations',
      active: [],
      omitted: 0,
    });
    assert.equal(lines.length, 3, 'counts with nothing standing are still stated, including the disclaimer');
    assert.match(lines[0], /not observations/);
    assert.equal(predictionPromptLines({ available: false, detail: 'unreadable' }).length, 0, 'unavailable is carried by the notice in buildPrompt, never by a partial block');
    assert.equal(predictionPromptLines(null).length, 0);
  });
});
