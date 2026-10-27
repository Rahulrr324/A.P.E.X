// Command-line interface. Exit codes:
//   0  request verified (or a model answer was produced and recorded as unverified)
//   1  request not completed (denied, rejected, failed, not verified, or no model)
//   2  usage or configuration error
//   3  the outcome could not be written to the audit log
import readline from 'node:readline';
import { createAppFromEnv } from './app.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { Outcome } from './outcomes.js';
import { ValidationError, StoreError } from './errors.js';
import { shortId } from './util.js';

export const HELP = `${APP_NAME} - ${APP_EXPANSION} (${APP_STAGE} ${APP_VERSION})

Usage:
  node bin/apex.js chat                  interactive conversation (same session across restarts)
  node bin/apex.js ask [--save-answer] <request words...>
  node bin/apex.js new                   start a new conversation session
  node bin/apex.js status
  node bin/apex.js history [--limit N]
  node bin/apex.js task plan <goal...>   plan a multi-step task (checked; nothing runs yet)
  node bin/apex.js task list
  node bin/apex.js task show <id>
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
  calc (2+3)*4          (or: what is 2+3*4?)
  status
  list src/             list one directory inside the authorized root (no model needed)
  read README.md        read a bounded text file inside the authorized root

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
  APEX_MODEL_TIMEOUT_MS    model call timeout in ms (default: 30000)
  APEX_MODEL_MAX_TOKENS    maximum answer length in tokens (default: 512)
  APEX_MODEL_RETRIES       retries for unreachable or interrupted calls (default: 1)
  APEX_CONTEXT_TURNS       recent conversation turns sent to the model (default: 6)
  APEX_ALLOW_REMOTE_MODEL  set to 1 to allow a non-loopback endpoint (not recommended)
`;

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
      } else {
        flags[name] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
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

function exitCodeFor(res) {
  if (!res.recorded) return 3;
  if (res.status === Outcome.SUCCESS_VERIFIED) return 0;
  // A plan that was checked and stored is a success of planning. Nothing has run yet.
  if (res.status === Outcome.PLAN_CREATED || res.status === Outcome.PLAN_PROPOSED) return 0;
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') return 0;
  return 1;
}

function modelLine(s, avail) {
  const m = s.model;
  if (!m.configured) return 'Model backend: none configured. Non-model functions are available.';
  const who = `${m.endpoint} (provider ${m.provider}, model "${m.model}")`;
  return `Model backend: ${who} - ${avail.available ? 'available' : `unavailable: ${avail.detail}`}`;
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
    err(`configuration error: ${e.message}`);
    return 2;
  }

  try {
    if (command === 'status') {
      const s = await app.getStatus();
      const avail = await app.gateway.checkAvailability();
      out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION} (${APP_EXPANSION})`);
      out(`Data directory: ${s.dataDir}`);
      out(`Session: ${shortId(s.sessionId)}`);
      out(`Memory records: ${s.memoryRecords} (corrupt lines skipped: ${s.corruptMemoryLines})`);
      out(`Conversation turns: ${s.turnRecords}`);
      out(`Operation records: ${s.operationRecords}`);
      out(modelLine(s, avail));
      out(s.filesystemRoot
        ? `Filesystem root: ${s.filesystemRoot} (read-only inspection)`
        : 'Filesystem root: none configured. Filesystem inspection is unavailable.');
      return 0;
    }

    if (command === 'new') {
      const state = await app.session.rotate();
      out(`Started a new session: ${state.sessionId}`);
      out('Earlier conversation stays in history but is not sent to the model.');
      return 0;
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
      return exitCodeFor(res);
    }

    if (command === 'chat') {
      parseFlags(args, []);
      return await runChat({ app, stdin, stdout, out });
    }

    if (command === 'history') {
      const { flags } = parseFlags(args, ['limit']);
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
        const res = await app.controller.planTask(words.join(' '));
        return emit(res);
      }
      if (sub === 'list') {
        out(await app.controller.listTasks());
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: task show <id>', 'USAGE');
        out((await app.controller.showTask(ids[0])).display);
        return 0;
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
      err('usage: task plan|list|show|approve|run|resume|retry|cancel');
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
      err(`memory store unavailable: ${e.message}. Check APEX_DATA_DIR and its permissions.`);
      return 1;
    }
    err(`unexpected error: ${e?.message ?? e}`);
    return 1;
  }
}

// Interactive loop. Reads lines until end of input or /exit. Each line is one
// request through the controller, in the current session.
async function runChat({ app, stdin, stdout, out }) {
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
      } catch (e) {
        out(`error: ${e?.message ?? e}`);
      }
    }
    if (interactive) stdout.write('you> ');
  }
  rl.close();
  return 0;
}
