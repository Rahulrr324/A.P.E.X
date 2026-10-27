// Command-line interface. Exit codes:
//   0  request verified (or a model answer was produced and recorded as unverified)
//   1  request not completed (denied, rejected, failed, not verified, or no model)
//   2  usage or configuration error
//   3  the outcome could not be written to the audit log
import { createAppFromEnv } from './app.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { Outcome } from './outcomes.js';
import { ValidationError, StoreError } from './errors.js';
import { shortId } from './util.js';

export const HELP = `${APP_NAME} - ${APP_EXPANSION} (${APP_STAGE} ${APP_VERSION})

Usage:
  node bin/apex.js status
  node bin/apex.js ask [--save-answer] <request words...>
  node bin/apex.js history [--limit N]
  node bin/apex.js help

Request examples (no model needed):
  remember that the project codename is Lighthouse
  recall codename
  list memory
  calc (2+3)*4          (or: what is 2+3*4?)
  status

Anything else goes to the model path. Without a configured model, APEX says so
and generates nothing.

Environment:
  APEX_DATA_DIR            data directory (default: ~/.apex/local-alpha)
  APEX_MODEL_URL           optional local OpenAI-compatible endpoint, e.g. http://127.0.0.1:11434
  APEX_MODEL_NAME          model name sent to that endpoint (default: local)
  APEX_MODEL_TIMEOUT_MS    model call timeout in ms (default: 30000)
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

function exitCodeFor(res) {
  if (!res.recorded) return 3;
  if (res.status === Outcome.SUCCESS_VERIFIED) return 0;
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') return 0;
  return 1;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...args] = argv;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);

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
    app = createAppFromEnv(env);
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
      out(`Memory records: ${s.memoryRecords} (corrupt lines skipped: ${s.corruptMemoryLines})`);
      out(`Operation records: ${s.operationRecords}`);
      if (!avail.configured) {
        out('Model backend: none configured. Non-model functions are available.');
      } else {
        out(`Model backend: ${s.model.endpoint} (model "${s.model.model}") - ${avail.available ? 'available' : `unavailable: ${avail.detail}`}`);
      }
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
