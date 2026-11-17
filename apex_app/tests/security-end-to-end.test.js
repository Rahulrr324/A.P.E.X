// AF-23: the whole route, checked against the bytes the route leaves behind.
//
//   user input -> CLI -> controller -> action registry -> validation -> store -> audit
//        -> finalization -> disclosure
//
// Every case here runs the real `main()` from `src/cli.js` in a fresh temporary data directory, with
// APEX_* stripped from the environment and APEX_DATA_ISOLATED=1, so the assertions are made against
// files APEX itself wrote rather than against a mock's record of a call. The stores are read back with
// `fs` directly: a claim that nothing was persisted is only evidence if something on disk was examined.
//
// Six scenario classes, chosen to be the ones a reviewer would ask about after Batch AF:
//   - credential-shaped input at every entry point, and a byte-level search for it afterwards;
//   - successful operations, and how the memory record, the audit record, the conversation turns and
//     the task log name each other;
//   - malformed input, where the split is between a usage error the CLI refuses before an operation
//     exists (exit 2, no audit record) and an input a store rejects (exit 1, audited, no side effect);
//   - an authorization refusal, on the same route and the same text that a user is allowed to write;
//   - interrupted writes, in the audit log and in a fact store, including what a reader echoes;
//   - experience capture armed through the CLI's own environment variable, and the reads that write
//     nothing at all.
//
// What this file does NOT establish, and no test here should be read as claiming:
//   - that APEX is secure in general. The credential patterns are a heuristic net over the common
//     formats; the boundary documented in `src/security/secrets.js` still holds, that detection
//     protects what is persisted and shown in diagnostics, not the request text sent to a configured
//     model or the user's own terminal.
//   - exactly-once execution. These tests pin the disclosure wording that says so ("matching operation
//     identifiers do not prove exactly-once execution") and the fact that a damaged audit line is
//     preserved and reported, not repaired.
//   - anything about a real model. No backend is configured in any case below, so no test here can be
//     evidence about model output; the model-origin refusal uses the controller's own origin argument,
//     and model proposals are covered by tests/proposal-hardening.test.js.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDataDir, cleanup, cleanEnv } from './helpers.js';
import { createApp } from '../src/app.js';
import { main } from '../src/cli.js';
import { Outcome } from '../src/outcomes.js';
import { Decision } from '../src/controller/decision.js';
import { containsSecret, findSecrets } from '../src/security/secrets.js';

// Unmistakably synthetic. None of these is a live credential of any provider: the API-key shape is
// `sk-synthetic-` plus an obvious placeholder body, the AWS shape is not an issued key, the bearer
// token reads as prose, and the password value says what it is. They are chosen to match the four
// detection patterns, which the fixture guard below re-checks on every run so a silent narrowing of
// those patterns cannot turn these tests into empty assertions.
const SYNTHETIC = Object.freeze([
  {
    label: 'API-key shape',
    secret: 'sk-synthetic-abcdefghijklmnopqrst',
    pattern: 'api-key-token',
    // The value part on its own as well: a mask that kept the prose and dropped only the prefix would
    // still leave the credential recoverable, so both the whole string and its distinctive tail are
    // searched.
    probes: ['sk-synthetic-abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
  },
  {
    label: 'cloud access-key shape',
    secret: 'AKIASYNTHETIC0000000',
    pattern: 'aws-access-key',
    probes: ['AKIASYNTHETIC0000000', 'AKIASYNTHETIC'],
  },
  {
    label: 'bearer token shape',
    secret: 'Bearer synthetic.token_value-abcdefghijklmnop',
    pattern: 'bearer-token',
    probes: ['Bearer synthetic.token_value-abcdefghijklmnop', 'synthetic.token_value'],
  },
  {
    label: 'assigned password shape',
    secret: 'password: syntheticphrase12345',
    pattern: 'assigned-secret',
    probes: ['password: syntheticphrase12345', 'syntheticphrase12345'],
  },
]);

const CLOCK = () => new Date('2026-04-01T09:00:00.000Z');
const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });
function tempDir() { const dir = makeTempDataDir(); dirs.push(dir); return dir; }

function sink() { return { text: '', write(chunk) { this.text += chunk; return true; } }; }

// One CLI invocation, isolated: no inherited APEX_* configuration, a named temp data directory, and
// stdin that is not a TTY so no case can enter the interactive chat loop.
async function cli(dir, argv, extraEnv = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, {
    env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir, ...extraEnv }),
    stdout: out,
    stderr: err,
    stdin: { isTTY: false },
  });
  return { code, out: out.text, err: err.text, argv };
}

const whereis = (argv) => `apex ${argv.join(' ')}`;

// The readable records of a store file, using the same tolerance the stores themselves use: a
// damaged line is skipped rather than thrown on, so a test can assert what a reader can actually see
// after an interrupted write. `rawLines` is the count of what is physically in the file.
function records(dir, name) {
  return rawLines(dir, name).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function rawLines(dir, name) {
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.trim() !== '');
}
const auditOf = (dir) => records(dir, 'operations.jsonl');
const memoryOf = (dir) => records(dir, 'memory.jsonl');
const knowledgeOf = (dir) => records(dir, 'knowledge.jsonl');
const conversationOf = (dir) => records(dir, 'conversation.jsonl');
const experiencesOf = (dir) => records(dir, 'experiences.jsonl').filter((r) => r.kind === 'experience');
const predictionsOf = (dir) => records(dir, 'predictions.jsonl');
const taskLogOf = (dir) => records(dir, 'tasks.jsonl');

// Every file under the data directory, keyed by its path relative to the directory. Lock files and
// any directory a store creates are included, because a credential does not care which file it lands
// in and neither should this check.
function filesOf(dir, prefix = '', acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(path.join(dir, entry.name), name, acc);
    else if (entry.isFile()) acc.push(name);
  }
  return acc;
}
function contentsOf(dir) {
  const map = {};
  for (const name of filesOf(dir)) map[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return map;
}
function holding(dir, needle) {
  return Object.entries(contentsOf(dir)).filter(([, text]) => text.includes(needle)).map(([name]) => name);
}
function assertNothingPersisted(dir, entry, where) {
  for (const probe of entry.probes) {
    assert.deepEqual(holding(dir, probe), [], `${where}: ${JSON.stringify(probe)} was written to disk`);
  }
}
function changed(before, dir) {
  const after = contentsOf(dir);
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((n) => before[n] !== after[n]);
}
const uuidOf = (res) => (res.out.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/) || ['', undefined])[1];
const short = (id) => String(id).slice(0, 8);

describe('AF-23 1: a rejected credential never becomes bytes, on any route', () => {
  test('each synthetic shape is refused by the memory route and absent from every file in the directory', async () => {
    for (const entry of SYNTHETIC) {
      const dir = tempDir();
      const sentence = `remember that ${entry.secret}`;
      // The fixture guard: if this fails, a detection pattern moved and the assertions below would
      // otherwise pass by testing nothing.
      assert.ok(findSecrets(sentence).includes(entry.pattern), `${entry.label}: the fixture no longer matches its pattern (${findSecrets(sentence).join(',')})`);

      const res = await cli(dir, ['ask', sentence]);
      const where = `${whereis(res.argv)} [${entry.label}]`;
      assert.equal(res.code, 1, `${where}: a credential-shaped request must not exit as success`);
      assert.equal(res.err, '', `${where}`);
      assert.match(res.out, /^Status: {4}input_rejected/m, `${where}`);
      assert.match(res.out, /input rejected: content looks like a password, key, or token; it was not stored/);
      assert.match(res.out, /Audit: {5}recorded in operations\.jsonl/, `${where}: the refusal is audited`);

      assertNothingPersisted(dir, entry, where);

      const audit = auditOf(dir);
      assert.equal(audit.length, 1, `${where}: one audit record for the refusal`);
      const [line] = audit;
      assert.equal(line.capability, 'memory.add', `${where}`);
      assert.equal(line.status, Outcome.INPUT_REJECTED, `${where}`);
      assert.equal(line.decision, Decision.REFUSE_OR_BLOCK, `${where}`);
      assert.equal(line.decision, 'refuse_or_block', `${where}: the persisted spelling of the decision`);
      assert.equal(line.request, '[request omitted: contained a password, key, or token]', `${where}`);
      assert.equal(line.output, 'input rejected: content looks like a password, key, or token; it was not stored', `${where}`);
      assert.equal(containsSecret(String(line.output)), false, `${where}: the reason text is not itself credential-shaped`);
      assert.deepEqual(line.errors, [], `${where}: the refusal is the outcome, not an error`);
      assert.equal(line.steps[0].execution.status, 'rejected', `${where}`);

      assert.equal(memoryOf(dir).length, 0, `${where}: nothing was stored`);
      assert.equal(experiencesOf(dir).length, 0, `${where}: a refused operation produced no experience`);

      // The turn still enters the conversation, because the exchange happened. What is kept is the
      // omission marker, not the text the user typed.
      const turns = conversationOf(dir);
      assert.equal(turns.length, 2, `${where}: the refused exchange is still an exchange`);
      assert.equal(turns[0].text, '[request omitted: contained a password, key, or token]', `${where}`);
      assert.equal(turns[0].operationId, line.id, `${where}: the turn names the audited operation`);
      assert.equal(turns[1].operationId, line.id, `${where}`);
    }
  });

  test('the knowledge, prediction and task routes refuse the same shape and write no record anywhere', async () => {
    const dir = tempDir();
    const entry = SYNTHETIC[0];
    const cases = [
      {
        argv: ['knowledge', 'add', '--subject', 'release', '--relationship', 'token', '--object', entry.secret],
        capability: 'knowledge.add', status: Outcome.INPUT_REJECTED, store: knowledgeOf,
        out: /input rejected: object looks like a password, key, or token; it was not stored/,
        request: 'knowledge add [content omitted: contained a password, key, or token]',
      },
      {
        argv: ['prediction', 'record', '--capability', 'memory.add', '--expect', 'success', '--subject', `the value ${entry.secret} is stored`, '--in-days', '30'],
        capability: 'prediction.record', status: Outcome.INPUT_REJECTED, store: predictionsOf,
        out: /input rejected: subject looks like a password, key, or token; it was not stored/,
        // The command path records the capability name and never composes the argument text before the
        // credential check runs, so there is no input-derived request field to mask here.
        request: 'prediction.record',
      },
      {
        argv: ['task', 'plan', `remember that ${entry.secret}`],
        capability: 'task.plan', status: Outcome.PLAN_REJECTED, store: taskLogOf,
        out: /the goal contains a password, key, or token; it was not planned/,
        // `planTask` starts the record with request null and only assigns the goal after this check,
        // so a refused plan keeps the null instead of a masked copy of the goal.
        request: null,
      },
    ];
    for (const c of cases) {
      const res = await cli(dir, c.argv);
      const where = whereis(res.argv);
      assert.equal(res.code, 1, `${where}: refused, so not a success exit`);
      assert.match(res.out, c.out, `${where}`);
      assertNothingPersisted(dir, entry, `${where}: a refusal must not grow the store it refused to write`);
      const line = auditOf(dir).at(-1);
      assert.equal(line.capability, c.capability, `${where}`);
      assert.equal(line.status, c.status, `${where}`);
      assert.equal(line.request, c.request, `${where}`);
      assert.deepEqual(line.errors, [], `${where}`);
      assert.equal(c.store(dir).length, 0, `${where}`);
    }
    assert.equal(auditOf(dir).length, 3, 'three refusals, three records');
    assert.deepEqual(
      Object.keys(contentsOf(dir)).filter((n) => n !== 'operations.jsonl'),
      [],
      'the audit log is the only file any of these refusals produced',
    );
    const world = await cli(dir, ['world']);
    assert.equal(world.code, 0, world.err);
    assert.match(world.out, /memory: ok - 0 readable \| knowledge: ok - 0 readable/);
  });
});
describe('AF-23 2: what a successful route leaves behind, and how the parts name each other', () => {
  test('a stored fact: the memory record, the audit claim and both conversation turns agree', async () => {
    const dir = tempDir();
    const res = await cli(dir, ['ask', 'remember that the release window is open']);
    assert.equal(res.code, 0, `${whereis(res.argv)}: ${res.out}${res.err}`);
    const id = uuidOf(res);
    const [mem] = memoryOf(dir);
    assert.ok(mem, 'the fact was written');
    assert.equal(mem.content, 'the release window is open');
    assert.equal(mem.kind, 'user_fact');

    const [line] = auditOf(dir);
    assert.equal(line.id, id, 'the operation id shown is the record on disk');
    assert.equal(line.capability, 'memory.add');
    assert.equal(line.origin, 'user');
    assert.equal(line.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(line.decision, Decision.ANSWER);
    assert.deepEqual(line.errors, []);
    assert.equal(line.output, `stored user fact ${short(mem.id)} (verified)`);
    assert.equal(line.steps[0].authorization.decision, 'allow');
    assert.equal(line.steps[0].verification.outcome, Outcome.SUCCESS_VERIFIED);
    assert.ok(Date.parse(line.finishedAt) >= Date.parse(line.requestedAt), 'the record is ordered in time');
    // Even for a benign fact the audit keeps the shape of the request, not its text.
    assert.match(line.request, /^remember \[content omitted: \d+ chars\]$/);

    const turns = conversationOf(dir);
    assert.deepEqual(turns.map((t) => t.operationId), [id, id], 'both turns name the operation');
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
    // The persisted conversation reuses the audit request form, so a memory write is not kept
    // verbatim in either store: the fact survives in memory.jsonl, the sentence does not.
    assert.equal(turns[0].text, line.request, 'the user turn is the audit request form, not the raw sentence');
    assert.match(turns[0].text, /^remember \[content omitted: \d+ chars\]$/);
    assert.equal(containsSecret(turns[0].text), false);
    assert.equal(turns[1].origin, 'apex_action');

    const history = await cli(dir, ['history']);
    assert.equal(history.code, 0, history.err);
    assert.ok(history.out.includes(id), 'history lists the record it just read from disk');
    assert.equal(auditOf(dir).length, 1, 'history is a read: it added nothing');

    const health = await cli(dir, ['audit', 'health']);
    assert.equal(health.code, 0, health.out);
    assert.match(health.out, /1 readable operation record\(s\)/);
  });

  test('a planned and run task: one plan record, one record per step, and the task log links them', async () => {
    const dir = tempDir();
    const plan = await cli(dir, ['task', 'plan', 'calc 2+2; remember that the release window is open']);
    assert.equal(plan.code, 0, `${plan.out}${plan.err}`);
    assert.match(plan.out, /status: pending/);
    assert.equal(memoryOf(dir).length, 0, 'planning is not running: the step it planned was not executed');

    const [planLine] = auditOf(dir);
    assert.equal(planLine.capability, 'task.plan');
    assert.equal(planLine.status, Outcome.PLAN_CREATED);
    assert.equal(planLine.decision, Decision.PROPOSE_ACTION, 'a plan is a proposal, not permission');
    assert.deepEqual(planLine.steps, [], 'the plan record claims no executed step');
    const created = taskLogOf(dir).find((e) => e.type === 'task_created');
    assert.equal(planLine.task.id, created.taskId, 'the record names the task the log holds');
    assert.equal(created.steps.length, 2);

    const run = await cli(dir, ['task', 'run', short(created.taskId)]);
    assert.equal(run.code, 0, `${run.out}${run.err}`);
    const lines = auditOf(dir);
    assert.deepEqual(
      lines.map((l) => l.capability),
      ['task.plan', 'task.step', 'task.step', 'task.run'],
      'the run adds one record per step and one for the run',
    );
    const last = lines.at(-1);
    assert.equal(last.capability, 'task.run');
    assert.equal(last.status, Outcome.SUCCESS_VERIFIED);
    assert.equal(last.task.status, 'completed');

    for (const step of created.steps) {
      const operationId = taskLogOf(dir)
        .find((e) => e.steps?.[0]?.id === step.id && e.steps[0].to === 'running')?.steps[0].operationId;
      assert.ok(operationId, `step ${step.id} records no operation`);
      const mine = lines.filter((l) => l.id === operationId);
      assert.equal(mine.length, 1, `step ${step.id}: exactly one record for the operation its log names`);
      assert.equal(mine[0].capability, 'task.step');
      assert.equal(mine[0].task.stepId, step.id);
      assert.equal(mine[0].task.id, created.taskId);
      const outcome = taskLogOf(dir)
        .find((e) => e.steps?.[0]?.id === step.id && e.steps[0].to === 'completed')?.steps[0].outcome;
      assert.equal(mine[0].status, outcome, `step ${step.id}: the record and the task log disagree`);
      assert.deepEqual(mine[0].errors, []);
    }
    assert.equal(memoryOf(dir).length, 1, 'the memory step ran when the task ran, and not when it was planned');
    assert.equal(experiencesOf(dir).length, 0, 'task.* is outside the automatic capture subset, and capture is off by default');
  });

  test('an experience is a reference to the audited event, and a second account of it is refused', async () => {
    const dir = tempDir();
    const add = await cli(dir, ['knowledge', 'add', '--subject', 'release', '--relationship', 'window', '--object', 'open']);
    assert.equal(add.code, 0, `${add.out}${add.err}`);
    const [rec] = knowledgeOf(dir);
    assert.match(add.out, new RegExp(`Stored knowledge record ${short(rec.id)}`));
    const [line] = auditOf(dir);

    const exp = await cli(dir, ['experience', 'record', line.id, '--subject', 'the release window claim was stored']);
    assert.equal(exp.code, 0, `${exp.out}${exp.err}`);
    const [experience] = experiencesOf(dir);
    assert.ok(experience, 'the manual record was written');
    assert.equal(experience.operationId, line.id, 'it names the operation it is an account of');
    assert.equal(experience.capability, 'knowledge.add');
    assert.equal(experience.provenance.origin, 'user_recorded');

    const dup = await cli(dir, ['experience', 'record', line.id, '--subject', 'a second account of the same event']);
    assert.equal(dup.code, 1, 'a second account of one event is refused, not silently coalesced');
    assert.match(dup.out, /already has a recorded experience/);
    assert.equal(experiencesOf(dir).length, 1, 'the refusal added no experience');
    assert.equal(auditOf(dir).length, 3, 'and the refusal is itself audited');

    const unknown = await cli(dir, ['experience', 'record', 'deadbeef', '--subject', 'an invented operation']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /is not in the audit log; an experience can only reference an event that was actually recorded/);

    const health = await cli(dir, ['experience', 'health']);
    assert.equal(health.code, 0, health.out);
    assert.match(health.out, /1 record\(s\) \(1 live, 0 corrected by a later record\)/);
    assert.match(health.out, /1 recorded by you, 0 captured automatically/);
  });
});
describe('AF-23 3: malformed input, and the two different things a rejection can mean', () => {
  test('a usage error exits 2 before an operation exists, and changes no byte in the directory', async () => {
    const dir = tempDir();
    const good = await cli(dir, ['ask', 'remember that the release window is open']);
    assert.equal(good.code, 0, `${good.out}${good.err}`);
    const cases = [
      ['memory', 'correct', '--resolve', 'ffffffff'],
      ['prediction', 'record', '--expect', 'success', '--subject', 'a claim', '--in-days', '30'],
      ['knowledge', 'add', '--subject', 'a', '--relationship', 'rel'],
      ['nonsense', 'something'],
    ];
    for (const argv of cases) {
      const before = contentsOf(dir);
      const res = await cli(dir, argv);
      const where = whereis(res.argv);
      assert.equal(res.code, 2, `${where}: a usage error is exit 2, not a failed operation`);
      assert.equal(res.out, '', `${where}: usage text goes to stderr`);
      assert.match(res.err, /usage|unknown command/, `${where}: ${res.err}`);
      assert.deepEqual(changed(before, dir), [], `${where}: no audit record, no store change, no session change`);
    }
    assert.equal(auditOf(dir).length, 1, 'only the earlier successful write is on the log');
  });
  test('an input a store rejects exits 1, is audited with its reason, and leaves every other store untouched', async () => {
    const dir = tempDir();
    const good = await cli(dir, ['ask', 'remember that the release window is open']);
    assert.equal(good.code, 0, `${good.out}${good.err}`);
    const cases = [
      // A well-formed reference that matches nothing is refused by the store, not by input syntax.
      { argv: ['memory', 'correct', '--resolve', 'ffffffff', 'the release window is closed'], capability: 'memory.correct', status: Outcome.EXECUTION_FAILED, out: /no memory record matches ffffffff/ },
      { argv: ['experience', 'record', 'deadbeef', '--subject', 'a stored fact'], capability: 'experience.record', status: Outcome.EXECUTION_FAILED, out: /is not in the audit log/ },
      { argv: ['prediction', 'record', '--capability', 'memory.add', '--expect', 'maybe', '--subject', 'a claim', '--in-days', '30'], capability: 'prediction.record', status: Outcome.INPUT_REJECTED, out: /expectation must be one of: success, failure, blocked/ },
      { argv: ['prediction', 'record', '--capability', 'memory.add', '--expect', 'success', '--subject', 'a claim', '--in-days', '99999'], capability: 'prediction.record', status: Outcome.INPUT_REJECTED, out: /inDays must be an integer from 1 to 366/ },
      { argv: ['feedback', 'record', 'deadbeef', '--assessment', 'not_useful'], capability: 'feedback.record', status: Outcome.EXECUTION_FAILED, out: /feedback target not found/ },
      { argv: ['adaptation', 'approve', 'deadbeef'], capability: 'adaptation.approve', status: Outcome.EXECUTION_FAILED, out: /decision target not found/ },
      { argv: ['task', 'run', 'ffffffff'], capability: 'task.run', status: Outcome.INPUT_REJECTED, out: /no task matches/ },
    ];
    const before = contentsOf(dir);
    for (const c of cases) {
      const res = await cli(dir, c.argv);
      const where = whereis(res.argv);
      assert.equal(res.code, 1, `${where}: a rejected operation exits 1, not 2`);
      assert.match(res.out, c.out, `${where}`);
      const line = auditOf(dir).at(-1);
      assert.equal(line.capability, c.capability, `${where}: the refusal is recorded against the capability it names`);
      assert.equal(line.status, c.status, `${where}`);
    }
    assert.equal(auditOf(dir).length, 1 + cases.length, 'each refusal added exactly one record');
    assert.deepEqual(changed(before, dir), ['operations.jsonl'], 'no store other than the audit log changed');
  });

  test('a request rejected before a capability is chosen records the stage, the reason and no input text', async () => {
    const dir = tempDir();
    const before = contentsOf(dir);
    // An embedded control character: validation refuses it, so no capability is ever picked and there
    // is no action step to record. What the audit keeps is the length of the rejected text.
    // Build the control character at runtime so this file contains no control byte of its own.
    const request = `remember that the${String.fromCharCode(1)}table is stale`;
    const res = await cli(dir, ['ask', request]);
    assert.equal(res.code, 1, 'a request that fails validation is not a success');
    assert.match(res.out, /^Status: {4}input_rejected/m);
    assert.match(res.out, /Output:\n\(none\)/, 'nothing is claimed as output');

    const lines = changed(before, dir).filter((n) => n !== 'session.json');
    // session.json is created by the first command run against an empty directory; nothing else may
    // appear. The contrast with the credential case above is measured, not assumed: a request that
    // never became an action writes no conversation turn either.
    assert.deepEqual(lines, ['operations.jsonl'], 'the rejected request produced no side effect anywhere else');
    assert.equal(conversationOf(dir).length, 0, 'no exchange was recorded for a request that never routed');
    assert.equal(memoryOf(dir).length, 0);
    const [line] = auditOf(dir);
    assert.equal(line.capability, 'none', 'no capability was chosen, and the record says so instead of guessing one');
    assert.equal(line.status, Outcome.INPUT_REJECTED);
    assert.equal(line.request, `[request omitted: rejected input of ${request.length} chars]`);
    assert.equal(line.output, null);
    assert.deepEqual(line.steps, []);
    assert.deepEqual(line.errors, [{ stage: 'input', code: 'INVALID_INPUT', message: 'request contains control characters' }]);
    assertNothingPersisted(dir, SYNTHETIC[0], 'a malformed request is no easier to persist than a credential');
  });
});

describe('AF-23 4: the authorization boundary, on the route that permits the same text', () => {
  test('a model-origin memory write is refused with its own record, while the user origin stores it', async () => {
    const dir = tempDir();
    const app = createApp({ dataDir: dir, now: CLOCK, experienceCapture: 'verified-success' });
    const text = 'remember that the vault code is 4411';

    const denied = await app.controller.handle(text, { origin: 'model' });
    assert.equal(denied.status, Outcome.ACTION_DENIED, denied.display);
    assert.equal(denied.recorded, true, 'a refusal still gets its record: the absence of one is not evidence that nothing was asked');
    assert.match(denied.display, /denied \(ORIGIN_NOT_PERMITTED\)/);
    assert.equal(memoryOf(dir).length, 0, 'the action registry refused before the store was opened');
    assert.equal(experiencesOf(dir).length, 0, 'a denied action is not an experience');

    const [line] = auditOf(dir);
    assert.equal(line.origin, 'model');
    assert.equal(line.status, Outcome.ACTION_DENIED);
    assert.equal(line.decision, Decision.REFUSE_OR_BLOCK);
    assert.equal(line.output, 'denied (ORIGIN_NOT_PERMITTED)');
    assert.deepEqual(line.errors, [], 'the denial is the outcome, not a malfunction');
    assert.equal(line.steps[0].authorization.decision, 'deny');
    assert.equal(line.steps[0].authorization.reason, 'ORIGIN_NOT_PERMITTED');
    assert.deepEqual(line.steps[0].execution, { status: 'not_run' }, 'nothing ran, so nothing is claimed to have run');

    // The same text, the same directory, the user origin: the refusal above was about who asked.
    const allowed = await cli(dir, ['ask', text]);
    assert.equal(allowed.code, 0, `${allowed.out}${allowed.err}`);
    assert.equal(memoryOf(dir).length, 1, 'and the fact is now stored');
    const stored = auditOf(dir).at(-1);
    assert.equal(stored.origin, 'user');
    assert.equal(stored.status, Outcome.SUCCESS_VERIFIED);
    assert.notEqual(stored.id, line.id, 'the two attempts are two records, not one merged claim');
  });
});
describe('AF-23 5: an interrupted write, and what a reader is allowed to do about it', () => {
  // The damage is written by this test, in the shape an interrupted append leaves: bytes of one record
  // with no terminating newline. The credential fragment inside it is the synthetic one from
  // SYNTHETIC[0], so the case that matters - a damaged line must never be echoed or completed - is
  // tested against bytes that would be harmful to display.
  const TORN = '{"schema":1,"id":"deadbeef-0000-0000-0000-000000000000","request":"sk-synthetic-abcdefghijklmnopqrst';

  test('the damaged audit line is preserved, reported as incomplete, and never echoed by a reader', async () => {
    const dir = tempDir();
    const good = await cli(dir, ['ask', 'remember that the audit log holds a torn line']);
    assert.equal(good.code, 0, `${good.out}${good.err}`);
    const target = path.join(dir, 'operations.jsonl');
    const before = fs.readFileSync(target, 'utf8');
    fs.appendFileSync(target, TORN);

    const readers = [
      ['history'],
      ['audit', 'health'],
      ['status'],
      ['diagnose'],
      ['world'],
      ['memory', 'health'],
    ];
    for (const argv of readers) {
      const res = await cli(dir, argv);
      const where = whereis(res.argv);
      assert.ok(!res.out.includes('sk-synthetic-abcdefghijklmnopqrst'), `${where}: a reader printed damaged bytes`);
      assert.ok(!res.err.includes('sk-synthetic-abcdefghijklmnopqrst'), `${where}: a reader printed damaged bytes on stderr`);
      assert.equal(fs.readFileSync(target, 'utf8'), before + TORN, `${where}: reading must not rewrite or truncate the damage`);
    }

    const history = await cli(dir, ['history']);
    assert.equal(history.code, 0, 'a partial read is still a read, so history exits 0 and says what it could not do');
    assert.match(history.out, /\(1 corrupt audit line\(s\) skipped\)/);
    assert.match(history.out, /cannot be read, so this list is incomplete/);
    assert.match(history.out, /A missing record does not prove an action did not execute/);

    const health = await cli(dir, ['audit', 'health']);
    assert.equal(health.code, 1, 'an incomplete ledger is attention, not a clean bill');
    assert.match(health.out, /damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(health.out, /corrupt lines could change every count/);
    assert.match(health.out, /this check writes no audit record and displays no request or output body/);

    const status = await cli(dir, ['status']);
    assert.equal(status.code, 1);
    assert.match(status.out, /Operation records: 1 \(corrupt lines skipped: 1\)/);

    const diagnose = await cli(dir, ['diagnose']);
    assert.equal(diagnose.code, 1);
    assert.match(diagnose.out, /Audit: corrupt \(1 readable operation\(s\), 1 corrupt line\(s\), 0 inconsistent record\(s\)\)/);
    assert.match(diagnose.out, /line 2: invalid JSON \(final line without a newline: consistent with an interrupted append; the bytes are preserved and new records start on a new line\)/);
    assert.match(diagnose.out, /no supported repair command exists\. Preserve operations\.jsonl/);
    assert.match(diagnose.out, /matching operation identifiers do not prove exactly-once execution/);
    assert.match(diagnose.out, /task step -> operation links were checked only against readable audit records/);
  });
  test('damage does not close the log: a later operation is appended, readable, and the damaged record stays unusable', async () => {
    const dir = tempDir();
    await cli(dir, ['ask', 'remember that the audit log holds a torn line']);
    const target = path.join(dir, 'operations.jsonl');
    const damaged = fs.readFileSync(target, 'utf8') + TORN;
    fs.appendFileSync(target, TORN);

    const later = await cli(dir, ['ask', 'remember that the tide table is stale']);
    assert.equal(later.code, 0, `${later.out}${later.err}: an unreadable earlier line does not hold up a new operation`);
    assert.equal(fs.readFileSync(target, 'utf8').startsWith(damaged + '\n'), true, 'the new record started on a new line and the damage is intact');
    assert.equal(memoryOf(dir).length, 2, 'both facts are stored');

    const readable = auditOf(dir);
    assert.equal(rawLines(dir, 'operations.jsonl').length, 3, 'the damaged bytes became their own line instead of swallowing the new record');
    assert.equal(readable.length, 2, 'the reader returns the two intact records and no invented third one');
    assert.equal(readable.at(-1).id, uuidOf(later));
    assert.equal(readable.at(-1).status, Outcome.SUCCESS_VERIFIED);

    // The damaged line names an operation id. Nothing may treat it as an event that happened.
    const reference = await cli(dir, ['experience', 'record', 'deadbeef-0000-0000-0000-000000000000', '--subject', 'an account of a record that cannot be read']);
    assert.equal(reference.code, 1);
    assert.match(reference.out, /is not in the audit log; an experience can only reference an event that was actually recorded/);
    assert.equal(experiencesOf(dir).length, 0);
    assert.equal(holding(dir, 'sk-synthetic-abcdefghijklmnopqrst').length, 1, 'the only copy of that fragment is the one this test wrote');
    assert.deepEqual(holding(dir, 'sk-synthetic-abcdefghijklmnopqrst'), ['operations.jsonl']);
  });

  test('an interrupted write in a fact store blocks that store and nothing else', async () => {
    const dir = tempDir();
    await cli(dir, ['ask', 'remember that the release window is open']);
    const target = path.join(dir, 'memory.jsonl');
    const damaged = fs.readFileSync(target, 'utf8') + '{"schema":1,"id":"torn';
    fs.writeFileSync(target, damaged);

    const write = await cli(dir, ['ask', 'remember that the tide table is stale']);
    assert.equal(write.code, 1, 'a damaged store is not a silent success');
    assert.match(write.out, /^Status: {4}execution_failed/m);
    assert.match(write.out, /memory store contains 1 corrupt line\(s\); refusing incomplete write/);
    assert.match(write.out, /a stored data file is damaged, so this step was refused before it ran\. Nothing in that store was changed/);
    assert.equal(fs.readFileSync(target, 'utf8'), damaged, 'the refusal left the damaged bytes alone');
    assert.equal(memoryOf(dir).length, 1, 'only the readable record counts');

    const health = await cli(dir, ['memory', 'health']);
    assert.equal(health.code, 1);
    assert.match(health.out, /damaged - 1 corrupt line\(s\); inspection incomplete/);
    assert.match(health.out, /corrupt lines could change every count/);

    const diagnose = await cli(dir, ['diagnose']);
    assert.equal(diagnose.code, 1);
    assert.match(diagnose.out, /memory reads, search, and corrections are blocked/);
    assert.match(diagnose.out, /no supported repair command exists\. Preserve memory\.jsonl and repair the damaged line outside APEX/);

    // The damage is confined to the store it landed in: an unrelated write still succeeds.
    const other = await cli(dir, ['knowledge', 'add', '--subject', 'release', '--relationship', 'window', '--object', 'open']);
    assert.equal(other.code, 0, `${other.out}${other.err}`);
    assert.equal(knowledgeOf(dir).length, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), damaged, 'and it did not disturb the damaged file');
    assert.deepEqual(auditOf(dir).map((l) => l.status), [Outcome.SUCCESS_VERIFIED, Outcome.EXECUTION_FAILED, Outcome.SUCCESS_VERIFIED]);
  });
});
describe('AF-23 6: capture armed through the route itself, and the reads that write nothing', () => {
  test('a refused credential is never captured, while the next verified success is', async () => {
    const dir = tempDir();
    const armed = { APEX_EXPERIENCE_CAPTURE: 'verified-success' };
    const entry = SYNTHETIC[0];

    const refused = await cli(dir, ['ask', `remember that ${entry.secret}`], armed);
    assert.equal(refused.code, 1);
    assert.equal(experiencesOf(dir).length, 0, 'a rejected operation is not an experience, with capture armed or not');
    assert.ok(!fs.existsSync(path.join(dir, 'experiences.jsonl')), 'and the log was not even created');
    assertNotCaptured(refused);
    assertNothingPersisted(dir, entry, whereis(refused.argv));

    const stored = await cli(dir, ['ask', 'remember that the release window is open'], armed);
    assert.equal(stored.code, 0, `${stored.out}${stored.err}`);
    assert.match(stored.out, /Experience: captured automatically as [0-9a-f]{8} from operation/);
    const [experience] = experiencesOf(dir);
    assert.ok(experience, 'the verified success was captured');
    assert.equal(experience.operationId, uuidOf(stored), 'the capture names the operation its record holds');
    assert.equal(experience.capability, 'memory.add');

    // The captured operation is now accounted for, so the manual route refuses to duplicate it.
    const dup = await cli(dir, ['experience', 'record', uuidOf(stored), '--subject', 'a manual account'], armed);
    assert.equal(dup.code, 1);
    assert.match(dup.out, /already has a recorded experience/);
    assert.equal(experiencesOf(dir).length, 1);

    const health = await cli(dir, ['experience', 'health'], armed);
    assert.equal(health.code, 0, health.out);
    assert.match(health.out, /0 recorded by you, 1 captured automatically/);
  });

  test('with capture armed, a recorded expectation persists and still produces no experience', async () => {
    const dir = tempDir();
    const armed = { APEX_EXPERIENCE_CAPTURE: 'verified-success' };
    const rec = await cli(dir, [
      'prediction', 'record', '--capability', 'memory.add', '--expect', 'success',
      '--subject', 'the next memory write succeeds', '--in-days', '30',
    ], armed);
    assert.equal(rec.code, 0, `${rec.out}${rec.err}`);
    assertNotCaptured(rec);
    const [prediction] = predictionsOf(dir);
    assert.ok(prediction, 'the expectation was persisted');
    assert.equal(prediction.capability, 'memory.add');
    assert.equal(prediction.expectation, 'success');
    assert.equal(prediction.subject, 'the next memory write succeeds');
    assert.equal(experiencesOf(dir).length, 0, 'a prediction is an expectation, not an experience');
    assert.equal(auditOf(dir).at(-1).capability, 'prediction.record');

    // The same session, the same armed capture, an eligible write: the empty experience log above was
    // about the capability, not about the configuration.
    const stored = await cli(dir, ['ask', 'remember that the release window is open'], armed);
    assert.equal(stored.code, 0, `${stored.out}${stored.err}`);
    assert.equal(experiencesOf(dir).length, 1);
    assert.equal(experiencesOf(dir)[0].capability, 'memory.add');
    assert.deepEqual(auditOf(dir).filter((l) => l.capability === 'prediction.record').map((l) => l.status), [Outcome.SUCCESS_VERIFIED]);
  });

  test('every read-only diagnostic writes no byte, and an audited read adds exactly its own record', async () => {
    const dir = tempDir();
    const seed = await cli(dir, ['ask', 'remember that the release window is open']);
    assert.equal(seed.code, 0, `${seed.out}${seed.err}`);
    await cli(dir, ['knowledge', 'add', '--subject', 'release', '--relationship', 'window', '--object', 'open']);
    const plan = await cli(dir, ['task', 'plan', 'calc 2+2']);
    const taskId = short((plan.out.match(/Task ([0-9a-f]{8})/) || ['', ''])[1]);
    const knowledgeId = knowledgeOf(dir)[0].id;

    // These commands read a store and report on it. They create no operation record, so they cannot
    // become evidence of something APEX did, and they leave the directory byte-for-byte unchanged.
    const unaudited = [
      ['memory', 'health'], ['knowledge', 'health'], ['knowledge', 'show', short(knowledgeId)],
      ['knowledge', 'history', short(knowledgeId)], ['experience', 'health'], ['prediction', 'health'],
      ['audit', 'health'], ['world'], ['history'], ['status'], ['diagnose'], ['task', 'show', taskId],
    ];
    for (const argv of unaudited) {
      const before = contentsOf(dir);
      const res = await cli(dir, argv);
      const where = whereis(res.argv);
      assert.deepEqual(changed(before, dir), [], `${where}: a read that writes is a write that reads`);
      assert.ok(res.out.length > 0, `${where}: a read reports something`);
      assert.equal(res.err, '', `${where}: ${res.err}`);
      assert.equal(res.code, 0, `${where}: a healthy store reads at exit 0`);
    }

    // The two reads that are operations: they disclose that they recorded themselves, and that is the
    // only byte change they make.
    for (const argv of [['experience', 'list'], ['knowledge', 'list'], ['prediction', 'list']]) {
      const before = contentsOf(dir);
      const ops = auditOf(dir).length;
      const res = await cli(dir, argv);
      const where = whereis(res.argv);
      assert.equal(res.code, 0, `${where}: ${res.out}${res.err}`);
      assert.match(res.out, /Audit: recorded in operations\.jsonl \(/, `${where}: an audited read says so`);
      assert.deepEqual(changed(before, dir), ['operations.jsonl'], `${where}`);
      assert.equal(auditOf(dir).length, ops + 1, `${where}: one record, not two`);
      assert.equal(auditOf(dir).at(-1).status, Outcome.SUCCESS_VERIFIED, `${where}: a read that succeeded is recorded as verified`);
    }
  });
});

function assertNotCaptured(res) {
  assert.ok(!/Experience: captured/.test(res.out), 'no capture was announced for a refused operation');
}
