// TEST FIXTURE for AF-18: one real process writing through every persistent APEX store at the
// same time as other copies of itself. Nothing here is a double: each call goes through the
// controller, so the writer locks, the independent verifier, the audit append and the disclosure
// text are the production ones.
//
//   fanout <dataDir> <writer> <rounds>  each round writes memory, knowledge, experience,
//                                       prediction and a planned+run task, and reports the
//                                   identifier and audit disposition of each
//   correct <dataDir> <writer> <target> one concurrent memory.correct of the same claim
//   ask      <dataDir> <writer> <text>  the real CLI request path, printing its full result text
//
// Every attempt is one `RESULT` line of JSON so the parent asserts against the files on disk
// rather than against an exit code. APEX_RACERS makes the copies start together.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { main } from '../../src/cli.js';

const [mode, dataDir, writer, arg3] = process.argv.slice(2);
const racers = Number(process.env.APEX_RACERS || '1');

function report(obj) {
  process.stdout.write(`RESULT ${JSON.stringify(obj)}\n`);
}

// The same file-barrier the Batch W writers use: copies spin until every one of them has arrived,
// so an interleaving is reproduced rather than scheduled around. The barrier is a directory of its
// own so the data directory still holds only what the writes put there.
function startTogether() {
  if (racers <= 1) return;
  const dir = path.join(dataDir, 'barrier');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `ready-${process.pid}`), 'r');
  const ceiling = Date.now() + 20000;
  while (fs.readdirSync(dir).filter((f) => f.startsWith('ready-')).length < racers && Date.now() < ceiling) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const app = createApp({ dataDir });

// One controller call, reported as it came back. A command that returns a non-success status is a
// fact about this run, not an exception: the parent has to see the status it got. A plan is a
// success of planning, so `plan_created` counts as the outcome that label was asked to reach.
const OK_BY_LABEL = {
  'task-plan': ['plan_created'],
  default: ['success_verified'],
};

function reported(label, res, extra = {}) {
  const allowed = OK_BY_LABEL[label] ?? OK_BY_LABEL.default;
  report({
    mode,
    writer,
    label,
    ok: allowed.includes(res.status),
    status: res.status,
    recorded: res.recorded ?? null,
    recordError: res.recordError ?? null,
    opId: res.operation?.id ?? null,
    display: String(res.display ?? res.output ?? '').slice(0, 900),
    ...extra,
  });
  return res;
}

// The identifier a store generated for itself, read back from the action's own result. The parent
// compares it against the file on disk, so a duplicate published by two processes is visible even if
// one of the two appends were somehow to overwrite the other.
function recordIdOf(res) {
  return res?.operation?.steps?.[0]?.result?.data?.id ?? null;
}

// Exactly one RESULT line per label per round, whatever happened. The parent counts reported labels
// against records on disk, so a line the fixture forgot to print would look like a record the store
// lost - and an exception part-way through a round must not swallow the labels after it.
async function step(label, call, extras = () => ({})) {
  let res;
  try {
    res = await call();
  } catch (err) {
    report({
      mode, writer, label, ok: false, status: 'threw', recordId: null,
      code: err?.code ?? null, message: String(err?.message ?? err),
    });
    process.exitCode = 1;
    return null;
  }
  return reported(label, res, { recordId: recordIdOf(res), ...extras(res) });
}

try {
  startTogether();

  if (mode === 'fanout') {
    const rounds = Number(arg3 ?? '1');
    for (let i = 0; i < rounds; i += 1) {
      const tag = `${writer}-${i}`;
      // memory: the natural-language route, so the router and the request path are exercised too.
      const note = await step('memory', () => app.controller.handle(`remember that the gate ${tag} is open`, { origin: 'user' }),
        () => ({ content: `the gate ${tag} is open` }));

      // knowledge: one claim per writer, so a lost update is a missing line and nothing else.
      await step('knowledge', () => app.controller.knowledgeAdd({
        subject: `gate ${tag}`, relationship: 'is operated by', object: `crew ${tag}`,
      }));

      // experience: an explicit reference to the operation above, so the store's own read-back of
      // the audit log is part of the concurrent path.
      const exp = await step('experience', () => app.controller.experienceRecord({
        operationId: note?.operation?.id ?? 'none',
        subject: `the gate ${tag} request ran as asked`,
      }));

      // prediction: an expectation that cites the experience this same process just recorded, so the
      // cross-store reference check runs while other processes are writing the log it reads. A round
      // whose experience write did not land cites nothing, rather than citing an id that does not exist.
      const experienceId = recordIdOf(exp);
      await step('prediction', () => app.controller.predictionRecord({
        capability: `race.${writer}`, expectation: 'success', subject: `gate ${tag} opens on time`, inDays: 7,
        ...(experienceId ? { evidence: { supportingExperienceIds: [experienceId] } } : {}),
      }));

      // task: plan, then run two steps, each of which appends its own operation record. A plan that
      // was refused because the task lock was held has no task to run, and that is reported as
      // "not attempted" - a sixth line, so the parent's count of reported labels stays exact.
      const planned = await step('task-plan', () => app.controller.planTask('calc 2+2; calc 3+3'),
        (res) => ({ taskId: res.task?.id ?? null }));
      if (planned?.task) {
        await step('task-run', () => app.controller.runTask(planned.task.id), (res) => ({
          taskId: planned.task.id,
          stepOps: (res.task?.steps ?? []).map((s) => s.operationId).filter(Boolean),
          auditGaps: res.auditGaps ?? 0,
        }));
      } else {
        report({
          mode, writer, label: 'task-run', ok: false, status: 'not attempted',
          recordId: null, taskId: null, display: 'this writer\'s plan was refused, so there was no task to run',
        });
      }
    }
  } else if (mode === 'correct') {
    // The replacement keeps the seeded claim's subject ("the launch code name") and changes only its
    // value, because the store refuses anything that does not contradict what it is replacing: a
    // rejected correction would show nothing about lost updates.
    await step('correct', () => app.controller.correctMemory({
      targetId: arg3,
      content: `the launch code name is corrected by writer ${writer}`,
      resolve: true,
    }), () => ({ targetId: arg3 }));
  } else if (mode === 'ask') {
    // The CLI's own text, because the disclosure a user reads is built there and not in the store.
    let out = '';
    const code = await main(['ask', arg3], {
      env: process.env,
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { out += chunk; return true; } },
      stdin: { isTTY: false },
    });
    report({ mode, writer, label: 'ask', ok: code === 0, status: null, exit: code, text: out.slice(0, 1400) });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report({ mode, writer, label: 'fatal', ok: false, status: 'fatal', code: err?.code ?? null, message: String(err?.message ?? err) });
  process.exitCode = 1;
}
