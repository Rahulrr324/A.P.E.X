// Command-line interface. Exit codes:
//   0  request verified (or a model answer was produced and recorded as unverified,
//      with no proposed action blocked)
//   1  request not completed (denied, rejected, failed, not verified, or no model)
//   2  usage or configuration error
//   3  the outcome could not be written to the audit log
import readline from 'node:readline';
import { createAppFromEnv } from './app.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { Outcome } from './outcomes.js';
import { Decision } from './controller/decision.js';
import { ValidationError, StoreError } from './errors.js';
import { shortId } from './util.js';
import { TaskStatus } from './tasks/model.js';
import { State, collectDiagnostics, renderDiagnostics, safeText } from './diagnostics.js';

export const HELP = `${APP_NAME} - ${APP_EXPANSION} (${APP_STAGE} ${APP_VERSION})

Usage:
  node bin/apex.js chat                  interactive conversation (same session across restarts)
  node bin/apex.js ask [--save-answer] <request words...>
  node bin/apex.js new                   start a new conversation session
  node bin/apex.js status [--model]      subsystem counts (--model probes the endpoint; no inference)
  node bin/apex.js diagnose [--model]    read-only preflight: config, stores, guidance (--model probes; no inference)
  node bin/apex.js memory correct --resolve <record-id> <replacement claim...>
  node bin/apex.js history [--limit N]
  node bin/apex.js knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>]
  node bin/apex.js knowledge list [--limit N]
  node bin/apex.js knowledge search <query words...>
  node bin/apex.js knowledge show <id>
  node bin/apex.js task plan <goal...>   plan a multi-step task (checked; nothing runs yet)
  node bin/apex.js task list
  node bin/apex.js task show <id>
  node bin/apex.js task explain <id> [view]   what the records say about one task
                                             view: status (default) | finished | steps | pending | why | approval | recovery
  node bin/apex.js task approve <id> [--step <stepId>]   approve a proposed plan, or one write step
  node bin/apex.js task run <id>         run a pending task, stopping at the first failure
  node bin/apex.js task resume <id>      continue a paused task (never re-runs a completed step)
  node bin/apex.js task retry <id> <stepId>   retry a failed read-only step
  node bin/apex.js task cancel <id>
  node bin/apex.js help

Request examples (no model needed):
  remember that the project codename is Lighthouse
  remember privately that my pin is kept at the bank   (never sent to a model)
  recall codename
  list memory
  memory correct --resolve <full-record-id> <replacement claim...>
  calc (2+3)*4          (or: what is 2+3*4?)
  status
  list src/             list one directory inside the authorized root (no model needed)
  read README.md        read a bounded text file inside the authorized root

Knowledge examples (explicit relationships; user-origin write only):
  knowledge add --subject APEX --relationship has_subsystem --object "Cognitive Controller"
  knowledge add --subject APEX --relationship has_subsystem --object "Memory Store" --evidence "README section 3"
  knowledge list
  knowledge search subsystem
  knowledge show <record-id>

With a configured local model, any other request is answered from the model,
using relevant memory and the recent conversation. Without one, APEX says so.

Filesystem inspection is available only when APEX_FILESYSTEM_ROOT is set to an
absolute directory. Paths are relative to it; it cannot be changed by a request.

Environment:
  APEX_DATA_DIR            data directory (default: ~/.apex/local-alpha)
  APEX_FILESYSTEM_ROOT     absolute directory APEX may inspect (unset: no filesystem access)
  APEX_FILESYSTEM_MAX_READ_BYTES  maximum file size for a read (default: 1048576)
  APEX_MODEL_URL           local model server, e.g. http://127.0.0.1:11434 (Ollama) or http://127.0.0.1:8080 (llama.cpp)
  APEX_MODEL_PROVIDER      openai (default: llama.cpp / OpenAI-compatible) or ollama
  APEX_MODEL_NAME          model name to request (default: local; required for Ollama)
  APEX_MODEL_TIMEOUT_MS    model call timeout in ms, 100-600000 (default: 30000)
  APEX_MODEL_MAX_TOKENS    maximum answer length in tokens, 1-8192 (default: 512)
  APEX_MODEL_RETRIES       retries for unreachable or interrupted calls, 0-3 (default: 1)
  APEX_CONTEXT_TURNS       recent conversation turns sent to the model, 0-50 (default: 6)
  APEX_ALLOW_REMOTE_MODEL  set to 1 to allow a non-loopback endpoint (not recommended)
`;

// The views `task explain` prints. Each one is the same view the conversation uses when it
// answers that class of question about a task, so the CLI states nothing the follow-up path
// does not. Choosing a view is a display decision only: it never resolves an ambiguous
// reference, and it grants no approval and starts no run.
const TASK_EXPLAIN_VIEWS = {
  status: 'status',
  finished: 'finished',
  steps: 'steps_succeeded',
  pending: 'pending',
  why: 'why_stopped',
  approval: 'approval',
  recovery: 'recovery',
};

function parseFlags(args, allowed) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--') && a !== '--') {
      const name = a.slice(2);
      if (!allowed.includes(name)) throw new ValidationError(`unknown option --${name}`, 'USAGE');
      if (name === 'limit') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--limit needs a whole number', 'USAGE');
        flags.limit = Number(v);
        i += 1;
      } else if (name === 'step') {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ValidationError('--step needs a step id', 'USAGE');
        flags.step = v;
        i += 1;
      } else if (['subject', 'relationship', 'object', 'evidence'].includes(name)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ValidationError(`--${name} needs a value`, 'USAGE');
        flags[name] = v;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

// A command that takes no positional arguments must not ignore one: silently accepting
// "status extra" says the request was understood when it was not.
function rejectUnexpected(rest, usage) {
  if (rest.length > 0) throw new ValidationError(`usage: ${usage}`, 'USAGE');
}

function describeStepLine(step) {
  const auth = step.authorization ? `authorization ${step.authorization.decision} (${step.authorization.reason})` : 'authorization n/a';
  const exec = `execution ${step.execution?.status ?? 'not_run'}`;
  const ver = `verification ${step.verification?.outcome ?? 'not_run'}`;
  const name = step.action ?? '(unparsed)';
  return `  - ${name} [origin ${step.origin}]: ${auth}; ${exec}; ${ver}\n    ${step.summary}`;
}

export function formatResult(res) {
  const lines = [];
  lines.push(`Operation: ${res.operation.id}`);
  lines.push(`Status:    ${res.status}`);
  const hits = res.operation.retrieval || [];
  lines.push(`Context:   ${hits.length} memory record(s) retrieved${hits.length ? ` [${hits.map((h) => shortId(h.id)).join(', ')}]` : ''}`);
  if (res.operation.prompt) {
    lines.push(`Prompt:    ${res.operation.prompt.memoryIds.length} memory record(s) and ${res.operation.prompt.turnIds.length} earlier turn(s) sent to the model`);
  }
  if (res.operation.steps.length) {
    lines.push('Steps:');
    for (const s of res.operation.steps) lines.push(describeStepLine(s));
  }
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') {
    lines.push('Note:      model answer; APEX cannot independently verify a model conclusion.');
  }
  lines.push('Output:');
  lines.push(res.display ?? res.output ?? '(none)');
  lines.push(res.recorded
    ? `Audit:     recorded in operations.jsonl (${res.operation.id})`
    : `Audit:     NOT RECORDED (${res.recordError})`);
  return lines.join('\n');
}

// Compact reply for the chat loop. Full detail stays in `history` and the audit log.
export function formatChatReply(res) {
  // The source of the text is part of the tag: a model answer says so, and says it is unverified.
  const isModelAnswer = res.operation.capability === 'model.answer' && res.status === Outcome.VERIFICATION_UNAVAILABLE;
  const source = isModelAnswer ? `model answer, unverified (${res.operation.backend ?? 'model'}) · ` : '';
  const tag = `[${res.status} · ${source}${shortId(res.operation.id)}${res.recorded ? '' : ' · NOT RECORDED in audit log'}]`;
  return `${res.display ?? res.output ?? '(none)'}\n${tag}`;
}

// An operation can succeed while carrying a recorded failure that changes what the user
// actually got: when the session pointer cannot be read the action still runs, but the
// request has no conversation continuity, so the audit record says "session" while the
// outcome says "success_verified". The record is authoritative and must be disclosed.
// The notice goes to stderr and never changes the outcome or the exit code: the requested
// action did run and was verified.
function sessionNotice(res) {
  const failure = (res?.operation?.errors ?? []).find((e) => e?.stage === 'session');
  if (!failure) return null;
  return `Session: this request ran without conversation continuity (${safeText(failure.message, 200)})`;
}

function exitCodeFor(res) {
  if (!res.recorded) return 3;
  if (res.status === Outcome.SUCCESS_VERIFIED) return 0;
  // A plan that was checked and stored is a success of planning. Nothing has run yet.
  if (res.status === Outcome.PLAN_CREATED || res.status === Outcome.PLAN_PROPOSED) return 0;
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') {
    // Answer text alone is usable, but when a proposal was denied, failed, or could
    // not be verified the request only partly succeeded; the operation's own
    // decision already says refuse_or_block, so the exit code must not say success.
    return res.decision === Decision.REFUSE_OR_BLOCK ? 1 : 0;
  }
  return 1;
}

function modelLine(model) {
  if (model.state === State.NOT_CONFIGURED) {
    return 'Model backend: none configured. Non-model functions are available.';
  }
  const m = model.describe;
  const who = `${safeText(m.endpoint)} (provider ${safeText(m.provider, 32)}, model "${safeText(m.model, 80)}")`;
  if (model.state === State.NOT_CHECKED) {
    return `Model backend: ${who} - connectivity not checked (run "status --model")`;
  }
  if (model.state === State.OK) return `Model backend: ${who} - available`;
  if (model.state === State.UNCONFIRMED) return `Model backend: ${who} - reachable, model not confirmed: ${safeText(model.detail)}`;
  return `Model backend: ${who} - unavailable: ${safeText(model.detail)}`;
}

function sessionLine(session) {
  if (session.state === State.OK) return `Session: ${shortId(session.sessionId)}`;
  if (session.state === State.MISSING) {
    return session.orphanTurns > 0
      ? `Session: missing (${session.orphanTurns} stored conversation turn(s) will not be replayed; a new session starts on the first request)`
      : 'Session: none yet (a new session starts on the first request)';
  }
  if (session.state === State.CORRUPT) return 'Session: corrupt (the current session cannot be loaded)';
  return 'Session: unavailable';
}

export async function main(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  appFactory = createAppFromEnv,
} = {}) {
  const [command, ...args] = argv;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  const emit = (res) => {
    out(res.display ?? res.output ?? '(none)');
    if (res.recorded === false) err(`Audit: NOT RECORDED (${res.recordError})`);
    else if (res.operation) out(`Audit: recorded in operations.jsonl (${res.operation.id})`);
    if (res.auditGaps) err(`Audit: ${res.auditGaps} step record(s) could not be written to the operation log`);
    const session = sessionNotice(res);
    if (session) err(session);
    return exitCodeFor(res);
  };

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return 0;
  }
  if (command === 'version') {
    out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION}`);
    return 0;
  }

  let app;
  try {
    app = appFactory(env);
  } catch (e) {
    // Configuration is validated before any store is opened, so this failure
    // cannot have read or changed persistent data.
    err(`configuration error: ${e.message}`);
    err('No data was read or changed. Check the APEX_* settings in "node bin/apex.js help".');
    return 2;
  }

  try {
    if (command === 'status') {
      const { flags, rest } = parseFlags(args, ['model']);
      rejectUnexpected(rest, 'status [--model]');
      const diag = await collectDiagnostics(app, { checkModel: Boolean(flags.model) });
      const { session, conversation, memory, audit, model, filesystem } = diag.subsystems;
      out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION} (${APP_EXPANSION})`);
      out(`Data directory: ${safeText(diag.dataDir)}`);
      out(sessionLine(session));
      const skipped = (s) => (s.state !== State.UNAVAILABLE && s.corruptLines > 0
        ? ` (corrupt lines skipped: ${s.corruptLines})`
        : '');
      out(`Memory records: ${memory.state === State.UNAVAILABLE ? 'unavailable' : memory.count} (corrupt lines skipped: ${memory.corruptLines})`);
      out(`Conversation turns: ${conversation.state === State.UNAVAILABLE ? 'unavailable' : conversation.count}${skipped(conversation)}`);
      out(`Operation records: ${audit.state === State.UNAVAILABLE ? 'unavailable' : audit.count}${skipped(audit)}`);
      out(modelLine(model));
      out(filesystem.state === State.OK
        ? `Filesystem root: ${safeText(filesystem.root)} (root validated at startup, read-only)`
        : 'Filesystem root: none configured. Filesystem inspection is unavailable.');
      if (diag.needsAttention) {
        // A model probe failure is not a storage or audit failure. Only say
        // "integrity" when a local check actually found something.
        const localAttention = diag.localDefects
          || diag.integrity.suspicions.length > 0
          || diag.taskState.uncertainSteps.length > 0
          || diag.taskState.runningTasks.some((task) => task.live !== true);
        if (localAttention) {
          out('Integrity: attention required; run "node bin/apex.js diagnose" for read-only details and recovery guidance.');
        } else {
          out('Local integrity: no defects found; the model backend is unavailable (see above).');
        }
        const unavailable = Object.values(diag.subsystems).find((s) => s.key !== 'model' && s.state === State.UNAVAILABLE);
        if (unavailable) err(`data store unavailable: ${safeText(unavailable.detail)}. Check APEX_DATA_DIR and its permissions.`);
      }
      return diag.needsAttention ? 1 : 0;
    }

    if (command === 'diagnose') {
      const { flags, rest } = parseFlags(args, ['model']);
      rejectUnexpected(rest, 'diagnose [--model]');
      const diag = await collectDiagnostics(app, { checkModel: Boolean(flags.model) });
      out(renderDiagnostics(diag));
      return diag.needsAttention ? 1 : 0;
    }

    if (command === 'new') {
      rejectUnexpected(parseFlags(args, []).rest, 'new');
      const state = await app.session.rotate();
      out(`Started a new session: ${state.sessionId}`);
      out('Earlier conversation stays in history but is not sent to the model.');
      return 0;
    }

    if (command === 'memory') {
      const [sub, ...rest] = args;
      if (sub !== 'correct') {
        err('usage: memory correct --resolve <full-record-id> <replacement claim...>');
        return 2;
      }
      const { flags, rest: values } = parseFlags(rest, ['resolve']);
      if (!flags.resolve || values.length < 2) {
        throw new ValidationError('usage: memory correct --resolve <full-record-id> <replacement claim...>', 'USAGE');
      }
      return emit(await app.controller.correctMemory({ targetId: values[0], content: values.slice(1).join(' '), resolve: true }));
    }

    if (command === 'knowledge') {
      const [sub, ...rest] = args;
      if (sub === 'add') {
        const { flags, rest: extra } = parseFlags(rest, ['subject', 'relationship', 'object', 'evidence']);
        rejectUnexpected(extra, 'knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>]');
        if (!flags.subject || !flags.relationship || !flags.object) {
          err('usage: knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>]');
          return 2;
        }
        return emit(await app.controller.knowledgeAdd({
          subject: flags.subject,
          relationship: flags.relationship,
          object: flags.object,
          evidence: flags.evidence ?? null,
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'knowledge list [--limit N]');
        return emit(await app.controller.knowledgeList({ limit: flags.limit }));
      }
      if (sub === 'search') {
        const { rest: words } = parseFlags(rest, []);
        if (words.length === 0) {
          err('usage: knowledge search <query words...>');
          return 2;
        }
        return emit(await app.controller.knowledgeSearch(words.join(' ')));
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: knowledge show <record-id>');
          return 2;
        }
        // A direct, unaudited read, like `task show`: there is no operation record,
        // so exit 0/1 reflects whether the record was found, not audit persistence.
        const res = await app.controller.knowledgeShow(ids[0]);
        out(res.display ?? res.output ?? '(none)');
        return res.status === Outcome.SUCCESS_VERIFIED ? 0 : 1;
      }
      err('usage: knowledge add|list|search|show');
      return 2;
    }

    if (command === 'ask') {
      const { flags, rest } = parseFlags(args, ['save-answer']);
      const text = rest.join(' ');
      if (text.trim() === '') {
        err('usage: ask [--save-answer] <request>');
        return 2;
      }
      const res = await app.controller.handle(text, { origin: 'user', saveAnswer: Boolean(flags['save-answer']) });
      out(formatResult(res));
      const session = sessionNotice(res);
      if (session) err(session);
      return exitCodeFor(res);
    }

    if (command === 'chat') {
      rejectUnexpected(parseFlags(args, []).rest, 'chat');
      return await runChat({ app, stdin, stdout, stderr, out });
    }

    if (command === 'history') {
      const { flags, rest } = parseFlags(args, ['limit']);
      rejectUnexpected(rest, 'history [--limit N]');
      const { records, corrupt } = await app.operations.list({ limit: flags.limit ?? 10 });
      if (records.length === 0) out('No operations recorded yet.');
      for (const op of records) {
        out(`${op.requestedAt}  ${op.id}  ${op.status}  ${op.capability}  ${op.request ?? ''}`);
      }
      if (corrupt) out(`(${corrupt} corrupt audit line(s) skipped)`);
      return 0;
    }

    if (command === 'task') {
      const [sub, ...rest] = args;
      if (sub === 'plan') {
        const { rest: words } = parseFlags(rest, []);
        if (words.join(' ').trim() === '') {
          // An empty goal is a usage error, like an empty `ask`: nothing is planned,
          // so there is no operation to record in the audit log.
          err('usage: task plan <goal...>');
          return 2;
        }
        const res = await app.controller.planTask(words.join(' '));
        return emit(res);
      }
      if (sub === 'list') {
        rejectUnexpected(parseFlags(rest, []).rest, 'task list');
        out(await app.controller.listTasks());
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: task show <id>', 'USAGE');
        out((await app.controller.showTask(ids[0])).display);
        return 0;
      }
      if (sub === 'explain') {
        const { rest: words } = parseFlags(rest, []);
        if (words.length < 1 || words.length > 2) {
          throw new ValidationError('usage: task explain <id> [status|finished|steps|pending|why|approval|recovery]', 'USAGE');
        }
        const view = words[1] ?? 'status';
        if (!TASK_EXPLAIN_VIEWS[view]) {
          throw new ValidationError(`unknown view "${view}"; use ${Object.keys(TASK_EXPLAIN_VIEWS).join(', ')}`, 'USAGE');
        }
        // A read with no operation record, like `task show`: the exit code reports what the
        // records establish, not whether the read was audited. 0 means the task log records
        // the work as complete and the audit holds a record for every verified step; anything
        // incomplete, held, failed, or unsupported by its own record is 1.
        const res = await app.controller.describeTask(words[0], TASK_EXPLAIN_VIEWS[view]);
        out(res.display);
        return res.task.status === TaskStatus.COMPLETED && res.evidenceState === 'complete' ? 0 : 1;
      }
      if (sub === 'run' || sub === 'resume') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError(`usage: task ${sub} <id>`, 'USAGE');
        return emit(await app.controller.runTask(ids[0], sub === 'resume' ? 'resume' : 'run'));
      }
      if (sub === 'approve') {
        const { flags, rest: ids } = parseFlags(rest, ['step']);
        if (ids.length !== 1) throw new ValidationError('usage: task approve <id> [--step <stepId>]', 'USAGE');
        return emit(await app.controller.approveTask(ids[0], { stepId: flags.step ?? null }));
      }
      if (sub === 'retry') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 2) throw new ValidationError('usage: task retry <id> <stepId>', 'USAGE');
        return emit(await app.controller.retryTask(ids[0], ids[1]));
      }
      if (sub === 'cancel') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: task cancel <id>', 'USAGE');
        return emit(await app.controller.cancelTask(ids[0]));
      }
      err('usage: task plan|list|show|explain|approve|run|resume|retry|cancel');
      return 2;
    }

    err(`unknown command: ${command}`);
    err('run "node bin/apex.js help" for usage');
    return 2;
  } catch (e) {
    if (e instanceof ValidationError) {
      err(`usage error: ${e.message}`);
      return 2;
    }
    if (e instanceof StoreError) {
      err(`data store unavailable: ${e.message}. Check APEX_DATA_DIR and its permissions.`);
      return 1;
    }
    err(`unexpected error: ${e?.message ?? e}`);
    return 1;
  }
}

// Interactive loop. Reads lines until end of input or /exit. Each line is one
// request through the controller, in the current session.
async function runChat({ app, stdin, stdout, stderr, out }) {
  const interactive = Boolean(stdin.isTTY);
  out('APEX chat. Type a message. /new starts a new session, /exit ends. Memory and history persist.');
  const rl = readline.createInterface({ input: stdin, output: interactive ? stdout : undefined, terminal: false });
  if (interactive) stdout.write('you> ');
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '') {
      if (interactive) stdout.write('you> ');
      continue;
    }
    if (line === '/exit' || line === '/quit') break;
    if (line === '/new') {
      const state = await app.session.rotate();
      out(`Started a new session: ${shortId(state.sessionId)}`);
    } else {
      try {
        const res = await app.controller.handle(line, { origin: 'user' });
        out(formatChatReply(res));
        const session = sessionNotice(res);
        if (session) stderr.write(`${session}\n`);
      } catch (e) {
        out(`error: ${e?.message ?? e}`);
      }
    }
    if (interactive) stdout.write('you> ');
  }
  rl.close();
  return 0;
}
