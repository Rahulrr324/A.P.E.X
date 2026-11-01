// Batch Y: deterministic fault injection and trust boundaries on the cognitive path.
//
// Batch X's own suite (world-context.test.js) pins what the projection contributes when
// everything works. This suite attacks that path from the other side: empty, malformed,
// truncated, timed-out and erroring model responses, an unreadable projection, damaged
// stores, and model prose that tries to contradict APEX's own disclosures or convert its
// conclusion into a stored fact. Every case runs against an in-process test-double backend
// that performs no work at all: no endpoint, no server, no inference, and therefore no
// evidence about real model reasoning - only about what APEX assembles, says, and refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { StoreError } from '../src/errors.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup } from './helpers.js';

const AT = '2026-04-04T00:00:00.000Z';
const FIXED_NOW = () => new Date(AT);
const HEADER = 'APEX STORE-WIDE PROJECTION';

const tempDir = () => makeTempDataDir();

// A scripted backend. `script` decides what one call returns; every call is recorded so a
// test can prove APEX did not silently retry, did not invent an answer, and saw exactly the
// prompt it was given.
function scriptedGateway(script = { ok: true, text: 'stub answer' }) {
  const state = { calls: 0, prompts: [], systems: [] };
  const backend = {
    name: 'batch-y-double',
    provider: 'batch-y-double',
    configured: true,
    describe: () => ({ configured: true, provider: 'batch-y-double', endpoint: 'in-process-double', model: 'batch-y-double' }),
    health: async () => ({ available: true, detail: 'in-process double, no endpoint' }),
    async complete({ system, prompt }) {
      state.calls += 1;
      state.systems.push(system);
      state.prompts.push(prompt);
      if (script.throws) throw new Error(script.throws);
      if (script.ok === false) {
        return { ok: false, backend: 'batch-y-double', provider: 'batch-y-double', error: { code: script.code, message: script.message }, latencyMs: 0 };
      }
      return {
        ok: true, backend: 'batch-y-double', provider: 'batch-y-double', model: 'batch-y-double',
        text: script.text, finishReason: script.finishReason ?? 'stop',
        truncated: script.truncated ?? false, truncatedBy: script.truncatedBy ?? null, latencyMs: 0,
      };
    },
  };
  return { gateway: new ModelGateway({ backend }), state };
}

function appWith(dir, cap, extra = {}) {
  return createApp({ dataDir: dir, now: FIXED_NOW, gateway: cap.gateway, ...extra });
}

async function remember(app, content, opts = {}) {
  const step = await app.controller.runAction('memory.add', { content, ...opts }, 'user', 'op-seed');
  assert.equal(step.outcome, Outcome.SUCCESS_VERIFIED, `seed failed: ${step.summary}`);
  return step.result.data.id;
}

async function claim(app, { subject, relationship, object, evidence = null, supersedes = [] }) {
  const res = await app.controller.knowledgeAdd({ subject, relationship, object, evidence, supersedes });
  assert.equal(res.status, Outcome.SUCCESS_VERIFIED, `claim failed: ${res.output}`);
  const [newest] = await app.knowledge.list({ limit: 1 });
  return newest.id;
}

const read = (dir, name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null);
const storesOf = (dir) => ({ memory: read(dir, 'memory.jsonl'), knowledge: read(dir, 'knowledge.jsonl') });
const projectionOf = (prompt) => {
  const start = prompt.indexOf(`${HEADER}`);
  if (start < 0) return null;
  const rest = prompt.slice(start);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
};

// Seed one disagreement, the shape most fault cases need.
async function seedConflict(dir, cap) {
  const app = appWith(dir, cap);
  await remember(app, 'The incident commander is Nadia');
  await remember(app, 'The incident commander is Bruno');
  return app;
}

test('fault - an empty model response produces no answer and no store change', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: '' });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(cap.state.calls, 1, 'the model was asked once');
  assert.notEqual(res.status, Outcome.SUCCESS_VERIFIED, 'an empty response is never a verified result');
  assert.doesNotMatch(String(res.output), /incident commander is (Nadia|Bruno)/, 'APEX does not fill in the answer itself');
  assert.equal(storesOf(dir).memory, before.memory, 'nothing was written to memory');
  assert.equal(storesOf(dir).knowledge, before.knowledge, 'nothing was written to knowledge');
});

test('fault - a backend error object is reported as a failure with no answer and one attempt', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: false, code: 'UNREACHABLE', message: 'no server is listening' });
  const app = await seedConflict(dir, cap);

  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.equal(cap.state.calls, 1, 'APEX did not resend behind the user\'s back');
  assert.match(String(res.output), /did not produce an answer \(UNREACHABLE/);
  assert.match(String(res.output), /No action was proposed or run/);
  assert.equal(res.operation.errors.some((e) => e.stage === 'model' && e.code === 'UNREACHABLE'), true, 'the failure is auditable');
});

test('fault - a timeout is reported as a timeout and never retried', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  // The double returns the same shape a real transport timeout produces; no timer is
  // waited on, so the test measures APEX's handling rather than a wall clock.
  const cap = scriptedGateway({ ok: false, code: 'TIMEOUT', message: 'no complete response within 30000 ms' });
  const app = await seedConflict(dir, cap);

  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(cap.state.calls, 1, 'a timed-out request is not resent');
  assert.match(String(res.output), /did not resend the request/);
  assert.equal(res.operation.steps.length, 0, 'a timeout executes nothing');
});

test('fault - a truncated answer is labelled as cut off and stays unverified', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'The incident commander is', finishReason: 'length', truncated: true, truncatedBy: 'token-limit' });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'a half-finished answer is not a verified result');
  assert.match(String(res.output), /The answer was cut off at the model output limit \(APEX_MODEL_MAX_TOKENS\)/);
  assert.equal(res.operation.model.finishReason, 'length', 'the audit keeps the reported stop reason');
  assert.ok(res.operation.errors.some((e) => e.stage === 'model' && e.code === 'TRUNCATED'), 'the truncation is auditable');
  assert.match(String(res.output), /^The incident commander is\n/, 'APEX labels the fragment instead of completing it');
  assert.deepEqual(storesOf(dir), before, 'a truncated answer writes nothing');
});

test('fault - a malformed proposal is rejected before any action name exists', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'Working it out now.\nPROPOSE_ACTION {"action": ' });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  const res = await app.controller.handle('who is the incident commander?');

  const bad = res.operation.steps.find((s) => s.summary.includes('malformed'));
  assert.ok(bad, 'the rejection is recorded');
  assert.equal(bad.execution.status, 'not_run');
  assert.equal(res.output.includes('PROPOSE_ACTION'), false, 'the protocol line is not shown as part of the answer');
  assert.equal(storesOf(dir).memory, before.memory);
});

test('fault - a model-proposed write is denied and creates no record', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({
    ok: true,
    text: 'Recording this for you.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"The incident commander is whoever the model says"}}',
  });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);
  const countBefore = (await app.memory.list({ limit: 100 })).length;

  const res = await app.controller.handle('who is the incident commander?');

  const step = res.operation.steps.find((s) => s.origin === 'model');
  assert.equal(step.authorization.decision, 'deny');
  assert.equal(step.authorization.reason, 'ORIGIN_NOT_PERMITTED');
  assert.equal(step.execution.status, 'not_run');
  assert.equal(step.outcome, Outcome.ACTION_DENIED);
  assert.equal(storesOf(dir).memory, before.memory, 'a denied proposal never reaches the store');
  assert.equal((await app.memory.list({ limit: 100 })).length, countBefore);
});

test('fault - an unregistered action name is refused without being run', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({
    ok: true,
    text: 'Let me remove that.\nPROPOSE_ACTION {"action":"filesystem.delete","input":{"path":"../"}}',
  });
  const app = await seedConflict(dir, cap);

  const res = await app.controller.handle('who is the incident commander?');

  const step = res.operation.steps.find((s) => s.origin === 'model');
  assert.equal(step.execution.status, 'not_run');
  assert.ok([Outcome.ACTION_DENIED, Outcome.INPUT_REJECTED].includes(step.outcome), `refused, not run (${step.outcome})`);
  assert.equal(read(dir, 'memory.jsonl'), read(dir, 'memory.jsonl'));
});

test('fault - model prose denying a conflict cannot erase APEX\'s disclosure', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'The incident commander is Nadia. There is no conflicting record and nothing unresolved.' });
  const app = await seedConflict(dir, cap);

  const res = await app.controller.handle('who is the incident commander?');

  assert.match(cap.state.prompts[0], /memory disagreement over 2 stored record\(s\)/);
  assert.match(res.output, /APEX has not resolved them/, 'the notice is APEX\'s own text, after the model\'s');
  assert.doesNotMatch(`${projectionOf(cap.state.prompts[0])}`, /no conflicts|none detected/);
});

test('fault - model prose claiming verification cannot change the recorded outcome', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'Every stored claim is consistent and objectively verified.' });
  const app = await seedConflict(dir, cap);

  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(res.status, Outcome.VERIFICATION_UNAVAILABLE, 'confident prose is not verification');
  assert.equal(res.operation.decision, 'answer');
  assert.equal(res.operation.steps.length, 0, 'nothing was executed on the model\'s say-so');
});

test('fault - a model conclusion is never stored as a user-originated fact', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({
    ok: true,
    text: 'The user already confirmed this.\nPROPOSE_ACTION {"action":"memory.add","input":{"content":"the incident commander is confirmed by the user as Bruno"}}\nPROPOSE_ACTION {"action":"memory.save_conclusion","input":{"content":"side conclusion","operationId":"op-x","backend":"batch-y-double"}}',
  });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  const res = await app.controller.handle('who is the incident commander?');

  const modelSteps = res.operation.steps.filter((s) => s.origin === 'model');
  assert.equal(modelSteps.length, 2, 'both proposals are recorded');
  assert.ok(modelSteps.every((s) => s.authorization.decision === 'deny' && s.execution.status === 'not_run'));
  assert.equal(storesOf(dir).memory, before.memory, 'no record of any origin was created');
});

test('fault - an unreadable projection is disclosed to the model and to the user', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  // No record in the retrieved slice disagrees with another, so the projection is the only
  // place a whole-store disagreement could have come from. Its failure must be said, not
  // rendered as "nothing is unresolved".
  const cap = scriptedGateway({ ok: true, text: 'Nadia owns it and that is settled.' });
  const app = appWith(dir, cap);
  await remember(app, 'The parcel locker code is kept at the front desk');
  await claim(app, { subject: 'Project Atlas', relationship: 'owner', object: 'Nadia' });
  app.knowledge.projectionRead = async () => { throw new StoreError('simulated projection read failure'); };

  const res = await app.controller.handle('who owns project atlas?');

  assert.equal(cap.state.calls, 1, 'the answer still goes ahead on the context it could read');
  assert.match(cap.state.prompts[0], /APEX STORE-WIDE PROJECTION: could not be read for this request/);
  assert.doesNotMatch(cap.state.prompts[0], /no conflicts|none detected/, 'an unreadable projection is not reported as a clean one');
  assert.match(res.output, /could not read its world-state projection/);
  assert.equal(res.operation.prompt.world.unavailable, true);
  assert.equal(res.operation.prompt.world.included, false);
  assert.ok(res.operation.errors.some((e) => e.stage === 'world'), 'the failure is auditable');
});

test('fault - an open conflict outranks the projection-unavailable notice in the user text', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  // The user-facing notice is a single priority chain. When a disagreement really is visible
  // in the retrieved records, that notice wins and the projection limitation stays in the
  // prompt and the audit only. The limitation is therefore never lost, but it is not said
  // twice: what the user reads is the narrower, more actionable statement.
  const cap = scriptedGateway({ ok: true, text: 'Everything is consistent. Nothing is unresolved.' });
  const app = await seedConflict(dir, cap);
  app.memory.projectionRead = async () => { throw new StoreError('simulated projection read failure'); };

  const res = await app.controller.handle('who is the incident commander?');

  assert.match(cap.state.prompts[0], /could not be read for this request/);
  assert.equal(res.operation.prompt.world.unavailable, true);
  assert.match(res.output, /APEX has not resolved them/, 'the conflict is still disclosed to the user');
  assert.doesNotMatch(res.output, /could not read its world-state projection/);
});

test('fault - a damaged memory store blocks the answer instead of pretending the store is empty', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'The stores are completely healthy and contain no problems.' });
  const app = await seedConflict(dir, cap);
  fs.appendFileSync(path.join(dir, 'memory.jsonl'), 'this line is not a record\n');
  const before = storesOf(dir);

  // Memory is the store the answer is built from, so a store that cannot be read fully is
  // not a store APEX may answer from: retrieval refuses rather than return a slice that
  // cannot be proven complete. The model is never asked, so damaged records cannot be
  // summarised into an answer that looks like it came from the whole store.
  const res = await app.controller.handle('who is the incident commander?');

  assert.equal(cap.state.calls, 0, 'no answer is generated from a store that could not be read');
  assert.equal(res.status, Outcome.EXECUTION_FAILED);
  assert.equal(res.operation.decision, 'refuse_or_block');
  assert.match(String(res.output), /Memory retrieval failed \(STORE_UNAVAILABLE\)/);
  assert.match(String(res.output), /did not generate an answer because stored context could not be checked/);
  assert.doesNotMatch(String(res.output), /no (records|stored records)|nothing stored|empty/i, 'damage is never rendered as an empty store');
  assert.equal(res.operation.prompt, null, 'no context was assembled from a partial read');
  assert.equal(res.operation.steps.length, 0);
  assert.ok(res.operation.errors.some((e) => e.stage === 'retrieval' && e.code === 'STORE_UNAVAILABLE'));
  assert.deepEqual(storesOf(dir), before, 'APEX did not repair, rewrite or drop the damaged line');
});

test('fault - a damaged knowledge store cannot be talked out of the disclosure', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'No knowledge problems exist.' });
  const app = await seedConflict(dir, cap);
  fs.appendFileSync(path.join(dir, 'knowledge.jsonl'), '{oops\n');

  const res = await app.controller.handle('who is the incident commander?');

  assert.match(cap.state.prompts[0], /KNOWLEDGE: \(knowledge store temporarily unavailable\)/);
  assert.match(res.output, /did not use stored knowledge/);
  assert.equal(res.operation.prompt.world.complete, false);
});

test('fault - a private record stays out of the prompt, the audit and a model-proposed read', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const SECRET = 'The access code for the safe is 4417 kept on the door tag';
  const cap = scriptedGateway({
    ok: true,
    text: 'The stored record for the safe is the one at the front desk.\nPROPOSE_ACTION {"action":"memory.list","input":{"limit":100}}',
  });
  const app = appWith(dir, cap);
  const publicId = await remember(app, 'The access code for the safe is 8123.');
  const privateId = await remember(app, SECRET, { sensitivity: 'private' });

  const res = await app.controller.handle('what is the access code for the safe?');

  assert.equal(cap.state.prompts[0].includes(SECRET), false, 'the private wording never reaches the model');
  assert.equal(cap.state.prompts[0].includes('4417'), false, 'nor does its value');
  assert.match(cap.state.prompts[0], /private content is not shown to you/);
  assert.match(cap.state.prompts[0], /\[contested:/, 'the shown record is marked as one-sided');

  // A read-only action a model proposes is authorized and executed - the policy denies
  // writes and user-only reads, not every read - so the privacy boundary has to hold at the
  // store read itself. It does: the private record is not in the returned set at all, not
  // even by id, while the same user-origin call returns both records.
  const step = res.operation.steps.find((s) => s.origin === 'model');
  assert.equal(step.action, 'memory.list');
  assert.equal(step.authorization.reason, 'PERMITTED');
  assert.equal(step.execution.status, 'ok');
  const hits = step.result.data.hits;
  assert.equal(hits.length, 1, 'the model-proposed list returned only the eligible record');
  assert.equal(hits[0].id, publicId);
  assert.equal(JSON.stringify(step.result).includes(SECRET), false, 'its wording is not returned');
  assert.equal(JSON.stringify(step.result).includes(privateId), false, 'nor is it counted by id');
  assert.match(hits[0].content, /^\[omitted \d+ chars\]$/, 'the audit carries a length, not memory content');
  assert.equal(JSON.stringify(res.operation).includes(SECRET), false, 'no stage of the audit carries the private wording');
  assert.equal(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').includes(SECRET), false);
  const userOrigin = await app.controller.runAction('memory.list', { limit: 100 }, 'user', 'op-compare');
  assert.equal(userOrigin.result.data.hits.length, 2, 'the user, unlike the model, can list both records');
});

test('fault - what the privacy boundary does not do: scrub the model\'s own text', async (t) => {
  // Pinned as a limitation, not as a leak. APEX keeps private content out of the prompt and
  // out of model-origin store reads, but model prose is passed through as the model's answer
  // and recorded as such. Here the test double states the code itself, without ever being
  // shown it, and that sentence reaches the user transcript, the operation audit and
  // conversation history unfiltered. A real model could only do this from something outside
  // the store; APEX cannot tell an echo from a recollection.
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const SECRET = 'The access code for the safe is 4417 kept on the door tag';
  const cap = scriptedGateway({ ok: true, text: `${SECRET}.` });
  const app = appWith(dir, cap);
  await remember(app, 'The access code for the safe is 8123.');
  await remember(app, SECRET, { sensitivity: 'private' });

  const res = await app.controller.handle('what is the access code for the safe?');

  assert.equal(cap.state.prompts[0].includes(SECRET), false, 'the store was never the source');
  assert.match(String(res.output), /4417 kept on the door tag/, 'the model\'s own wording is not rewritten or redacted');
  assert.equal(fs.readFileSync(path.join(dir, 'operations.jsonl'), 'utf8').includes(SECRET), true);
  assert.equal(fs.readFileSync(path.join(dir, 'conversation.jsonl'), 'utf8').includes(SECRET), true);
});

test('fault - identical store bytes assemble identical prompts and outputs', async (t) => {
  // Seeded once, then copied. Two stores holding the same records still carry different
  // record ids, and a disagreement group lists its members in id order, so re-seeding the
  // same content does not produce the same prompt. Same bytes is the determinism claim APEX
  // can actually make; id-order dependence is reported as a Batch Y limitation.
  const source = tempDir();
  t.after(() => cleanup(source));
  const seedCap = scriptedGateway();
  const seedApp = appWith(source, seedCap);
  await remember(seedApp, 'The shift lead for Warehouse 7 is Dana Whitfield.');
  await claim(seedApp, { subject: 'Project Atlas', relationship: 'owner', object: 'Nadia' });
  await claim(seedApp, { subject: 'Project Atlas', relationship: 'owner', object: 'Bruno', evidence: 'signed memo' });

  const build = async () => {
    const dir = tempDir();
    t.after(() => cleanup(dir));
    for (const name of ['memory.jsonl', 'knowledge.jsonl']) {
      fs.copyFileSync(path.join(source, name), path.join(dir, name));
    }
    const cap = scriptedGateway({ ok: true, text: 'fixed answer' });
    const app = appWith(dir, cap);
    const res = await app.controller.handle('who owns project atlas?');
    return { prompt: cap.state.prompts[0], output: res.output, status: res.status, chars: res.operation.prompt.chars };
  };
  const a = await build();
  const b = await build();

  assert.equal(a.prompt, b.prompt, 'the same store bytes and question assemble the same context');
  assert.match(a.prompt, /knowledge disagreement over 2 stored claim\(s\); unresolved/, 'including the same projection');
  assert.equal(a.output, b.output);
  assert.equal(a.status, b.status);
  assert.equal(a.chars, b.chars);
});

test('fault - a backend that throws leaves no partial write or lock behind', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ throws: 'backend exploded' });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  // The transport doubles raise here instead of returning a failure object, so the real
  // question is what state APEX leaves behind: the answer is none. This pins the invariant
  // (no write, no lock), not a claim that the throw is handled gracefully.
  await assert.rejects(() => app.controller.handle('who is the incident commander?'));

  assert.equal(cap.state.calls, 1);
  assert.deepEqual(storesOf(dir), before, 'neither store changed');
  assert.equal(fs.existsSync(path.join(dir, 'memory.jsonl.lock')), false);
  assert.equal(fs.existsSync(path.join(dir, 'knowledge.jsonl.lock')), false);
});

test('fault - deterministic requests stay model-free and reads stay write-free', async (t) => {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  const cap = scriptedGateway({ ok: true, text: 'unused' });
  const app = await seedConflict(dir, cap);
  const before = storesOf(dir);

  const calc = await app.controller.handle('calc 2+2');
  const status = await app.controller.handle('status');
  const answer = await app.controller.handle('who is the incident commander?');

  assert.equal(cap.state.calls, 1, 'only the model-routed request asked the backend');
  assert.equal(calc.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(status.status, Outcome.SUCCESS_VERIFIED);
  assert.equal(answer.operation.prompt.chars > 0, true);
  assert.deepEqual(storesOf(dir), before, 'reading and answering wrote nothing to either store');
});
