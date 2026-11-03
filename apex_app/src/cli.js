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
import { redactSecrets } from './security/secrets.js';
import { shortId } from './util.js';
import { TaskStatus } from './tasks/model.js';
import { MAX_QUEUED_SUMMARIES } from './tasks/summary-queue.js';
import { TAKEOVER_EPOCHS } from './tasks/lock-recovery.js';
import { State, collectDiagnostics, dataDirLabel, renderDiagnostics, safeText } from './diagnostics.js';
import { MAX_WORLD_LIMIT } from './world/world-state.js';

export const HELP = `${APP_NAME} - ${APP_EXPANSION} (${APP_STAGE} ${APP_VERSION})

Usage:
  node bin/apex.js chat                  interactive conversation (same session across restarts)
  node bin/apex.js ask [--save-answer] <request words...>
  node bin/apex.js new                   start a new conversation session
  node bin/apex.js status [--model]      subsystem counts (--model probes the endpoint; no inference)
  node bin/apex.js diagnose [--model]    read-only preflight: config, stores, guidance (--model probes; no inference)
  node bin/apex.js memory correct --resolve <record-id> <replacement claim...>
  node bin/apex.js memory health         store-wide record, provenance, and corruption counts (read-only)
  node bin/apex.js world [--limit N]     stored beliefs, contradictions, decisions, and unknowns (read-only)
  node bin/apex.js history [--limit N]
  node bin/apex.js knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]
  node bin/apex.js knowledge retract <id> [--reason <text>]
  node bin/apex.js knowledge resolve <target-id> --choose <claim-id> [--reason <text>]
  node bin/apex.js knowledge history <id>
  node bin/apex.js knowledge health          store-wide counts, conflicts, and lifecycle anomalies (read-only)
  node bin/apex.js knowledge list [--limit N]
  node bin/apex.js knowledge search <query words...>
  node bin/apex.js knowledge show <id>
  node bin/apex.js experience record <operation-id> --subject <text> [--replaces <id[,id...]>]
  node bin/apex.js experience list [--limit N]
  node bin/apex.js experience show <experience-or-operation-id>
  node bin/apex.js experience timeline|trends|patterns [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]
  node bin/apex.js experience compare [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]
  node bin/apex.js experience health       experiences, feedback, adaptation states, and evidence checks (read-only)
  node bin/apex.js feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]
  node bin/apex.js adaptation derive [--min-support N]     turn repeated feedback into candidates (never active)
  node bin/apex.js adaptation list [--limit N] [--exclude-retired]
  node bin/apex.js adaptation approve <id> [--reason <text>]     your decision; the only way a rule takes effect
  node bin/apex.js adaptation reject <id> [--reason <text>]
  node bin/apex.js adaptation retire <id> [--reason <text>]      stop using a rule; its history stays readable
  node bin/apex.js prediction record --capability <name> --expect <kind> --subject <text> (--expires <iso> | --in-days N) [--supports <id[,id...]>] [--contradicts <id[,id...]>] [--feedback <id[,id...]>] [--pattern <kind[,kind...]>] [--replaces <id[,id...]>]
  node bin/apex.js prediction list [--limit N] [--capability <name>] [--status <name>]
  node bin/apex.js prediction show <prediction-id>
  node bin/apex.js prediction history <prediction-id>
  node bin/apex.js prediction evaluate <prediction-id>
  node bin/apex.js prediction invalidate <prediction-id> --reason <text>
  node bin/apex.js prediction summary [--capability <name>] [--limit N]
  node bin/apex.js prediction health      record kinds, standing expectations, and anomalies (read-only)
  node bin/apex.js goal add [--criterion <text>]... [--priority N] [--deadline <iso>] [--depends-on <id>]... <request>
  node bin/apex.js goal list [--limit N]
  node bin/apex.js goal show <id>
  node bin/apex.js goal update <id> <status> [--reason <text>] [--by <goal-id>]
  node bin/apex.js goal revise <id> --criterion <text>... --reason <text> [--request <text>] [--priority N] [--deadline <iso>]
  node bin/apex.js goal evidence <id> --criterion <c1> --kind supports|contradicts [--operation <audit-id>] [--detail <text>] [--reopen]
  node bin/apex.js goal complete <id> [--reason <text>]
  node bin/apex.js goal link <id> (--plan <id> | --task <id>)
  node bin/apex.js plan add --outcome <text> --step <json>... [--goal <id>] [--precondition <text>]... [--assertion <json>]... [--estimate N] [--reason <text>]
  node bin/apex.js plan list [--limit N]
  node bin/apex.js plan show <id>
  node bin/apex.js plan validate <id>     check a stored plan against live state (read-only)
  node bin/apex.js plan history <id>       recorded versions of a plan (read-only)
  node bin/apex.js plan compare <id> [--from N] [--to N]   compare two recorded versions (read-only)
  node bin/apex.js plan revise <id> --outcome <text> --step <json>... --reason <text> [--precondition <text>]... [--assertion <json>]... [--estimate N]
  node bin/apex.js plan approve <id>
  node bin/apex.js plan start <id>        create a user-origin task from an approved plan, then run it
  node bin/apex.js plan reconcile <id>    re-read the linked task and record its terminal outcomes
  node bin/apex.js plan cancel <id> --reason <text>
  node bin/apex.js plan supersede <id> --by <plan-id> --reason <text>
  node bin/apex.js recover                interrupted, uncertain, resumable, and blocked work (read-only)
  node bin/apex.js work [--limit N]      ranked next work from the records (read-only, executes nothing)
  node bin/apex.js next                  the single top recommendation and why (read-only)
  node bin/apex.js propose [--kind goal_create|goal_clarify|plan_create|plan_revise|advice] [--goal <id>] [--plan <id>] <request>
  node bin/apex.js proposal list [--limit N]
  node bin/apex.js proposal show <id>
  node bin/apex.js proposal accept <id> [--reason <text>]
  node bin/apex.js proposal reject <id> --reason <text>
  node bin/apex.js proposal invalidate <id> --reason <text>
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
  node bin/apex.js queue                 deferred task summaries and their state (read-only)
  node bin/apex.js audit health          operation-log integrity and outcome counts (read-only)
  node bin/apex.js repair locks          inspect task, queue, memory, knowledge, experience and prediction write locks; remove only abandoned takeover tokens
  node bin/apex.js help

Exit codes:
  0  completed (a verified result, a created plan, or a model answer recorded as unverified)
  1  not completed (denied, rejected, failed, unverified, or no model configured)
  2  usage or configuration error; nothing was run
  3  the outcome could not be written to the audit log

Lock recovery never takes a lock, never removes a lock claim, and refuses while any
holder or takeover process is live. A dead claim is taken over by the next normal task
or queue update through the same election that already handles a crashed process.

Request examples (no model needed; use them with ask, or type the same words in chat):
  remember that the project codename is Lighthouse
  remember privately that my pin is kept at the bank   (never sent to a model)
  recall codename
  list memory
  memory correct --resolve <full-record-id> <replacement claim...>
  calc (2+3)*4          (or: what is 2+3*4?)
  status
  list src/             list one directory inside the authorized root (no model needed)
  read README.md        read a bounded text file inside the authorized root
  task plan "calc 1+1; calc 2+2"   plan a checked task; nothing runs yet
                                     task run <task-id> runs it, task show <task-id> shows the record
  diagnose              read-only preflight, including recovery guidance
  what conflicts do you have   stored contradictions, answered from the stores (no model)

Knowledge examples (explicit relationships; user-origin write only):
  knowledge add --subject APEX --relationship has_subsystem --object "Cognitive Controller"
  knowledge add --subject APEX --relationship has_subsystem --object "Memory Store" --evidence "README section 3"
  knowledge add --subject Engine --relationship fuel --object Electric --supersedes a1b2c3d4
  knowledge retract a1b2c3d4 --reason "superseded by a later service record"
  knowledge resolve a1b2c3d4 --choose 9f8e7d6c --reason "confirmed by the service record"
  knowledge history a1b2c3d4
  knowledge health
  knowledge list
  knowledge search subsystem
  knowledge show <record-id>

Experience and adaptation examples (what APEX did, what you thought, what to change):
  history                     find the operation id of something APEX already did
  experience record <operation-id> --subject "stored the review date"
  feedback record <experience-id> --assessment not_useful --guidance "give one dated fact, not a reminder"
  feedback record <experience-id> --assessment incorrect --reason "the file it names does not exist"
      assessments: correct | incorrect | partially_correct | useful | not_useful
                 | user_correction | outcome_succeeded | outcome_failed
  adaptation derive           repeated feedback becomes a candidate; a candidate does nothing yet
  adaptation list             shows each state: candidate, approved, in effect, rejected, retired, ambiguous
  adaptation approve <id>     your decision; only an approved rule is offered to future answers
  adaptation retire <id>      stop using a rule without deleting the history of it
  experience health           re-checks every recorded experience against the audit log
  experience timeline --days 7     recorded events in the window, newest first, corrections marked
  experience trends --days 30      per-capability outcome counts and an early/late trend
  experience patterns              repeated success/failure, alternation, regression, recurring corrections
  experience compare               the last 30 days against the 30 days before them
A timeline, trends, patterns, or comparison describes recorded order. It is not a cause and not a
prediction, and no pattern becomes an adaptation: a rule still needs your corrective feedback and
your explicit approval. Records without a usable timestamp are listed separately, never placed in a
window.
An experience is recorded when you ask, or by APEX itself for a verified successful operation when
APEX_EXPERIENCE_CAPTURE=verified-success. Either route records only that the event happened; an
assessment of it is written only by you. "experience list" and "experience show" name which route
each record came from, and "experience health" states the current setting.
An experience names one audited operation; it is not a fact about you. Feedback is your own
assessment and is never invented from silence. A rule takes effect only after you approve it
here, and even then it guides wording, never permission: APEX still asks before any write.

Prediction examples (what you expect to happen, kept apart from what happened):
  prediction record --capability memory.add --expect success --subject "the corrected record is read back on the next search" --in-days 30
  prediction record --capability knowledge.search --expect failure --subject "the stale claim still wins" \
      --expires 2026-12-01T00:00:00.000Z --supports <experience-id> --pattern repeated_failure
      expectations: success | failure | blocked
      pattern kinds: repeated_failure | repeated_success | alternating_outcomes
                   | regression_after_success | improvement_after_correction | recurring_corrections
      citations: name an experience, a feedback record, or a prediction by the id a read prints, its
                 first eight characters; APEX stores the whole id it resolves to and refuses a prefix
                 that matches more than one record
  prediction list [--status awaiting_evaluation]   what stands, and in which of its states
  prediction show <prediction-id>       the expectation, the evidence it cited, and what is known now
  prediction history <prediction-id>    every record about that one expectation, oldest first
  prediction evaluate <prediction-id>   the ledger compares the expectation to recorded outcomes
  prediction invalidate <prediction-id> --reason "the condition it assumed no longer holds"
  prediction summary                    what the verdicts support, their denominator, and their limits
  prediction health                     the ledger parses, and every withdrawal and verdict names a prediction
A prediction is an expectation you record, not an observation: nothing about it has happened. It lives
in predictions.jsonl, separate from experiences.jsonl, so no read of what happened can count it, and it
never enters the world-state observations. Recording, evaluating, and withdrawing are writes, and they
are yours alone: a model cannot create, evaluate, or withdraw a prediction, and no prediction authorizes
an action or approves an adaptation. You give only the expected kind, the horizon, and the evidence you
relied on; the verdict is computed from recorded outcomes, so "prediction evaluate" reports insufficient
or unavailable evidence rather than inventing one, and an expired horizon is not a wrong prediction.
This build stores no confidence in any record and computes none: the reads say it is unavailable.

Goal and plan examples (recorded intent; never permission to execute):
  goal add "ship the corrected memory index" --criterion "the stale claim no longer wins" \
      --criterion "search reads it back on the next run" --priority 2 --deadline 2026-12-01
  goal update <goal-id> accepted
  goal evidence <goal-id> --criterion c1 --kind supports --operation <audit-id>
  goal complete <goal-id>              refused unless every criterion cites a verified audit record
  plan add --goal <goal-id> --outcome "the corrected claim is stored and read back" \
      --step '{"id":"s1","action":"knowledge.add","description":"store the correction","input":{"subject":"Engine","relationship":"fuel","object":"Electric"},"expectedResult":"the record is stored","verification":"read it back","criterion":"c1"}' \
      --step '{"id":"s2","action":"knowledge.search","description":"read it back","input":{"query":"Engine fuel"},"dependsOn":["s1"],"expectedResult":"the new claim is first","verification":"the search names it","criterion":"c2"}'
  plan validate <plan-id>              live check: approval binding, goal revision, actions, evidence (read-only)
  plan history <plan-id>               every recorded version with its reason (read-only)
  plan compare <plan-id> [--from N] [--to N]   differences between two recorded versions (read-only)
  plan approve <plan-id>               binds approval to this exact content; every step is still authorized again
  plan start <plan-id>                 creates a user-origin task, runs it, and records each step's outcome
  plan reconcile <plan-id>             after an interrupted run, re-reads the task and records outcomes
  recover                              states what was interrupted, what is uncertain, and what can resume
  work                                 ranks the next work from goals, plans, tasks, and execution state
  next                                 states the single top recommendation; nothing is executed
A goal records what you intend; a plan records how you propose to get there; neither grants any
action permission. A task completing does not complete a goal: completion needs verified evidence
for every success criterion. Goal and plan writes are yours alone; a model cannot create, approve,
start, reconcile, or complete one, and cannot smuggle one into a plan. Starting a plan authorizes
only the steps it names, each through the same registry authorization as any other action, and an
interrupted step is reported as uncertain rather than assumed not to have happened.

With a configured model endpoint, any other request is answered from that model,
using relevant memory and the recent conversation. Without one, APEX says so.
A model answer is unverified, and a proposed action is checked by APEX itself: a
denied proposal is reported and does not run. Model output is never authorization.
APEX connects only to an endpoint you have configured and chosen yourself. It does
not install, download, start, or recommend a model server of any kind.

Filesystem inspection is available only when APEX_FILESYSTEM_ROOT is set to an
absolute directory. Paths are relative to it; it cannot be changed by a request.

Environment:
  APEX_DATA_DIR            data directory (default: ~/.apex/local-alpha)
  APEX_DATA_ISOLATED       1: refuse to start unless APEX_DATA_DIR names a directory inside the OS
                           temporary directory. A test, benchmark, or diagnostic runs with this set
                           cannot reach a real user store; a missing or mistyped value is a startup
                           error, never a silent return to normal operation. Unset or 0 is normal
                           operation, and any store you chose stays available.
  APEX_FILESYSTEM_ROOT     absolute directory APEX may inspect (unset: no filesystem access)
  APEX_FILESYSTEM_MAX_READ_BYTES  maximum file size for a read (default: 1048576)
  APEX_MODEL_URL           endpoint URL of a model server you have configured (unset: no model)
  APEX_MODEL_PROVIDER      protocol of that endpoint: openai (default) or ollama
  APEX_MODEL_NAME          model name to request (default: local; required for ollama)
  APEX_MODEL_TIMEOUT_MS    model call timeout in ms, 100-600000 (default: 30000)
  APEX_MODEL_MAX_TOKENS    maximum answer length in tokens, 1-8192 (default: 512)
  APEX_MODEL_RETRIES       retries for unreachable or interrupted calls, 0-3 (default: 1)
  APEX_CONTEXT_TURNS       recent conversation turns sent to the model, 0-50 (default: 6)
  APEX_ALLOW_REMOTE_MODEL  set to 1 to allow a non-loopback endpoint (not recommended)
  APEX_EXPERIENCE_CAPTURE  off (default) or verified-success: whether APEX records an experience of
                           a verified successful operation without being asked. It never records
                           feedback; "experience record <operation-id>" is always available.
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
  // Options that may be repeated. Each occurrence adds one value, so a goal can name
  // several criteria and a plan several steps without inventing a separator.
  const repeatable = new Set(['criterion', 'step', 'precondition', 'assertion', 'depends-on']);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--') && a !== '--') {
      const name = a.slice(2);
      if (!allowed.includes(name)) throw new ValidationError(`unknown option --${name}`, 'USAGE');
      if (repeatable.has(name)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ValidationError(`--${name} needs a value`, 'USAGE');
        flags[name] = [...(flags[name] ?? []), v];
        i += 1;
      } else if (name === 'limit') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--limit needs a whole number', 'USAGE');
        flags.limit = Number(v);
        i += 1;
      } else if (name === 'days') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--days needs a whole number', 'USAGE');
        flags.days = Number(v);
        i += 1;
      } else if (name === 'priority' || name === 'estimate') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError(`--${name} needs a whole number`, 'USAGE');
        flags[name] = Number(v);
        i += 1;
      } else if (name === 'min-support') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--min-support needs a whole number', 'USAGE');
        flags['min-support'] = Number(v);
        i += 1;
      } else if (name === 'in-days') {
        // A whole number here, so a mistaken value is a usage error that says what to type rather
        // than an action refusal about a field the user never meant to write badly. The ledger's own
        // bound (1 to MAX_PREDICTION_HORIZON_DAYS) is still enforced by the action.
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--in-days needs a whole number of days', 'USAGE');
        flags['in-days'] = Number(v);
        i += 1;
      } else if (['subject', 'relationship', 'object', 'evidence', 'supersedes', 'choose', 'reason', 'assessment', 'guidance', 'replaces', 'since', 'until', 'capability', 'a-since', 'a-until', 'b-since', 'b-until', 'expect', 'expires', 'status', 'supports', 'contradicts', 'feedback', 'pattern', 'goal', 'outcome', 'deadline', 'plan', 'task', 'kind', 'operation', 'detail', 'by'].includes(name)) {
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

// A comma-separated list of record ids on the command line. Blank entries are dropped, so
// "a,,b" is the same list as "a,b" instead of a reference to nothing.
function idList(value) {
  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

// Steps and assertions are JSON objects given one per repeated option. A value that is not
// JSON, or is not an object, is a usage error: it is never passed on to the action to be
// guessed at.
function jsonObjects(values, label) {
  return (values ?? []).map((value, i) => {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError(`${label} ${i + 1} is not valid JSON`, 'USAGE');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError(`${label} ${i + 1} must be a JSON object`, 'USAGE');
    }
    return parsed;
  });
}

function describeStepLine(step) {
  const auth = step.authorization ? `authorization ${step.authorization.decision} (${step.authorization.reason})` : 'authorization n/a';
  const exec = `execution ${step.execution?.status ?? 'not_run'}`;
  const ver = `verification ${step.verification?.outcome ?? 'not_run'}`;
  const name = step.action ?? '(unparsed)';
  return `  - ${name} [origin ${step.origin}]: ${auth}; ${exec}; ${ver}\n    ${redactSecrets(String(step.summary ?? ''))}`;
}

export function formatResult(res) {
  const lines = [];
  lines.push(`Operation: ${res.operation.id}`);
  lines.push(`Status:    ${res.status}`);
  const hits = res.operation.retrieval || [];
  lines.push(`Context:   ${hits.length} memory record(s) retrieved${hits.length ? ` [${hits.map((h) => shortId(h.id)).join(', ')}]` : ''}`);
  if (res.operation.prompt) {
    lines.push(`Prompt:    ${res.operation.prompt.memoryIds.length} memory record(s) and ${res.operation.prompt.turnIds.length} earlier turn(s) sent to the model`);
    const world = res.operation.prompt.world;
    if (world) {
      lines.push(world.unavailable
        ? 'Projection: could not be read for this answer, so APEX cannot say whether other stored records disagree.'
        : `Projection: ${world.included ? 'sent to the model' : 'omitted to keep the context within its budget'} (${world.unresolvedConflicts} unresolved knowledge group(s), ${world.memoryConflictGroups} memory group(s), ${world.unknowns} explicit unknown(s)${world.complete === false ? ', incomplete read' : ''})`);
    }
  }
  if (res.operation.steps.length) {
    lines.push('Steps:');
    for (const s of res.operation.steps) lines.push(describeStepLine(s));
  }
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') {
    lines.push('Note:      model answer; APEX cannot independently verify a model conclusion.');
  }
  // A corrupt store refuses before the action runs. Say that plainly: nothing was
  // changed, and a retry is only meaningful after repair, not while the damage remains.
  if (res.operation.steps.some((s) => s.execution?.status === 'failed' && /corrupt/i.test(s.execution?.error?.message ?? ''))) {
    lines.push('Note:      a stored data file is damaged, so this step was refused before it ran. Nothing in that store was changed. Run "node bin/apex.js diagnose" for what is readable and what is uncertain; retrying is safe only after the store is repaired.');
  }
  // A write whose executor reported a failure may already have changed data: the body was
  // invoked, so the outcome after the error is unknown. A rejected input never reached the
  // body and is reported above as rejected; this note is only for failures that started.
  // A coordination refusal is the exception that proves the rule the other way: the lock is
  // taken before any byte of the record is written, so `LOCKED` and the store's own
  // "nothing was written" refusals are known not to have changed anything, and telling the
  // user otherwise would invite them to treat a safe retry as dangerous.
  const writeActions = new Set([
    'memory.add', 'memory.correct', 'memory.save_conclusion', 'knowledge.add', 'knowledge.retract', 'knowledge.resolve',
    'experience.record', 'feedback.record', 'adaptation.derive', 'adaptation.decide', 'adaptation.retire',
    'prediction.record', 'prediction.evaluate', 'prediction.invalidate',
  ]);
  const refusedBeforeWriting = (s) => s.execution?.error?.code === 'LOCKED'
    || /nothing was written/i.test(s.execution?.error?.message ?? '');
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && writeActions.has(s.action)
    && !/corrupt/i.test(s.execution?.error?.message ?? '')
    && !refusedBeforeWriting(s))) {
    lines.push('Note:      a write reported a failure after it started. APEX cannot establish whether it changed stored data, so do not repeat it unless you can confirm it did not take effect; run "node bin/apex.js diagnose" for a read-only report.');
  }
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && writeActions.has(s.action)
    && refusedBeforeWriting(s))) {
    lines.push('Note:      this write was refused before it began, so nothing was written. The reason above names what was in the way; retrying after that no longer applies is safe. Run "node bin/apex.js diagnose" for a read-only report of the lock.');
  }
  // An unusable data directory is an environment failure, not a rejected request. A retry
  // cannot help until the path is usable, so say what to check instead of implying that the
  // request itself was wrong.
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && /^cannot (?:read|write|prepare)\b.*\b(?:memory|knowledge|experienc\w*|prediction\w*|conversation|operations|session|tasks?|queue)\b/i.test(s.execution?.error?.message ?? ''))) {
    lines.push('Note:      a data file could not be read or written, so this request was not completed and nothing was confirmed. Check APEX_DATA_DIR, its permissions, and free space; run "node bin/apex.js diagnose" for a read-only report.');
  }
  lines.push('Output:');
  lines.push(res.display ?? res.output ?? '(none)');
  lines.push(res.recorded
    ? `Audit:     recorded in operations.jsonl (${res.operation.id})`
    : `Audit:     NOT RECORDED (${res.recordError ?? 'no audit record was written'})`);
  if (res.recorded === false) {
    lines.push('Note:      the result above is what this run observed, but the audit trail will not contain it. Do not repeat the request just to obtain a record; if it ran an action, that action may already have happened.');
  }
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

// An error line is presentation, not evidence: the audit record keeps the original
// message. The text can still quote a user-supplied command, option, or store path,
// so it is bounded, stripped, and redacted like every other terminal line.
function errorText(e) {
  return safeText(e?.message ?? e, 400);
}

function exitCodeFor(res) {
  if (!res.recorded) return 3;
  if (res.status === Outcome.SUCCESS_VERIFIED) return 0;
  // A plan that was checked and stored is a success of planning. Nothing has run yet.
  if (res.status === Outcome.PLAN_CREATED || res.status === Outcome.PLAN_PROPOSED) return 0;
  // A goal or plan record that was written and read back is a completed command. It is not
  // a claim that any work ran: the record's own status says what it means.
  if (res.status === Outcome.GOAL_CREATED || res.status === Outcome.GOAL_UPDATED
    || res.status === Outcome.GOAL_COMPLETED || res.status === Outcome.PLAN_STORED) return 0;
  // A stored proposal and a recorded user decision are completed commands. A proposal is not
  // approval or execution; the record's own status and validation say what it means.
  if (res.status === Outcome.PROPOSAL_CREATED || res.status === Outcome.PROPOSAL_DECIDED) return 0;
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
  if (model.state === State.OK) return `Model backend: ${who} - available (model list checked; no inference was run)`;
  if (model.state === State.UNCONFIRMED) return `Model backend: ${who} - reachable, model not confirmed: ${safeText(model.detail)} (model list only; no inference was run)`;
  return `Model backend: ${who} - unavailable: ${safeText(model.detail)}`;
}

// One bounded line on a terminal before the model is asked. The transport is not
// streaming, so it says only what APEX is waiting for and for how long; it never shows
// progress, partial text, or a claim that the model is working on an answer.
function modelWaiting(err) {
  return (event) => {
    const seconds = event && Number.isFinite(event.timeoutMs) ? Math.round(event.timeoutMs / 1000) : null;
    err(seconds
      ? `Waiting for the model (up to ${seconds} s; no partial output is shown)...`
      : 'Waiting for the model (no partial output is shown)...');
  };
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

function holderText(report) {
  if (report.error) return `unreadable (${safeText(report.error)})`;
  if (report.alive === null) return 'holder not identifiable';
  // "live" is a statement about the recorded number, not proof that the process that wrote
  // it still runs: a recycled number is indistinguishable here.
  return `holder process ${report.pid} is ${report.alive ? 'live (liveness only; identity is not checked)' : 'not running'}`;
}

// Read-only view of the deferred task summaries. The queue is a delivery work list, not
// evidence: printing it never writes and never reissues a turn. Entry text is not printed;
// the task and audit logs remain the records of what happened.
async function showQueue({ app, limit, out, err }) {
  const max = MAX_QUEUED_SUMMARIES;
  let entries;
  try {
    entries = await app.summaryQueue.entries();
  } catch (e) {
    err(`Queue: unavailable (${errorText(e)})`);
    err('No entry was read or changed. Preserve task-summary-queue.json; there is no supported repair command. A corrupt queue blocks only the reissue of unsaved task summaries.');
    return 1;
  }
  if (entries.length === 0) {
    out('Queue: empty (no task summary is waiting to be reissued)');
  } else {
    const shown = entries.slice(0, Math.max(1, limit));
    out(`Queue: ${entries.length} deferred task summar${entries.length === 1 ? 'y' : 'ies'}${entries.length > shown.length ? ` (showing ${shown.length})` : ''}`);
    for (const entry of shown) {
      out(`  task ${shortId(entry.taskId)} session ${shortId(entry.sessionId)} queued ${safeText(entry.queuedAt, 40)}${entry.verified ? '' : ' (result not verified)'} text ${entry.text.length} char(s)`);
    }
    if (entries.length >= max) {
      out(`Queue: full (${entries.length}/${max}); a further task summary will be refused and disclosed, not queued. Entries are reissued at the next successful task write.`);
    }
  }
  let lock;
  try {
    lock = await app.summaryQueue.lockReport();
  } catch (e) {
    err(`Queue lock: inspection failed (${errorText(e)})`);
    return 1;
  }
  if (!lock.present) {
    out('Queue lock: no lock file (no queue update is in progress)');
  } else {
    out(`Queue lock: ${holderText(lock)}; takeover tokens ${lock.tokens.total} recorded (${lock.tokens.dead} dead for this claim)`);
    // Say what is known and what a retry would mean. This view never waits for or takes
    // the lock, so a held update is not a failure of the read.
    if (lock.alive === true) {
      out('A queue update is refused while that process holds the lock. This view is read-only; retrying the update after it finishes is safe.');
    } else if (lock.error || lock.alive === null) {
      out('The lock holder cannot be identified, so a queue update may be refused as "in use by unknown". This view is read-only; run "node bin/apex.js diagnose" and, if no update is active, "node bin/apex.js repair locks".');
    } else if (lock.tokens.current >= TAKEOVER_EPOCHS && lock.tokens.live === 0) {
      out('The holder is not running, but every takeover slot is abandoned, so the next update will be refused. Run "node bin/apex.js repair locks" after confirming no update is active.');
    } else {
      out('The holder is not running; the next queue update takes the claim over through its normal election. This view is read-only.');
    }
  }
  return 0;
}

// Removes abandoned takeover tokens only. It never removes a claim: the ordinary election
// is the only path that removes a lock, so recovery cannot displace a process that takes
// the dead claim over while recovery is running.
async function repairLocks({ app, out, err }) {
  // One fixed order for every lock, so a run always reports and recovers the same set of
  // stores. Recovery touches only abandoned takeover tokens, so the order cannot decide
  // which store wins - but the output is comparable across runs only if it is stable.
  const targets = [
    { label: 'Task lock', store: app.taskStore },
    { label: 'Summary queue lock', store: app.summaryQueue },
    { label: 'Memory lock', store: app.memory },
    { label: 'Knowledge lock', store: app.knowledge },
    { label: 'Experience lock', store: app.experience },
    { label: 'Prediction lock', store: app.predictions },
  ];
  let failed = 0;
  for (const target of targets) {
    let report;
    try {
      report = await target.store.lockReport();
    } catch (e) {
      err(`${target.label}: inspection failed: ${errorText(e)}`);
      failed += 1;
      continue;
    }
    if (!report.present) {
      out(`${target.label}: no lock file; nothing to recover`);
      continue;
    }
    const tokens = report.tokens;
    out(`${target.label}: present; ${holderText(report)}; takeover tokens ${tokens.total} recorded (${tokens.current} for this claim: ${tokens.dead} dead, ${tokens.live} live, ${tokens.unknown} unidentified)`);
    if (report.guard.present) {
      out(`${target.label}: recovery claim present (process ${report.guard.pid ?? 'unknown'}, ${report.guard.alive === true ? 'live' : report.guard.alive === false ? 'not running' : 'unreadable'})`);
    }
    try {
      const result = await target.store.recover();
      if (result.reason === 'no-lock') {
        out(`${target.label}: no claim now; nothing was removed`);
      } else if (result.removedTokens > 0) {
        out(`${target.label}: removed ${result.removedTokens} abandoned takeover token(s); the claim was left for the next normal run to take over`);
      } else {
        out(`${target.label}: no abandoned takeover tokens for this claim; the claim was left for the next normal run to take over`);
      }
    } catch (e) {
      err(`${target.label}: not recovered: ${errorText(e)}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    err('Recovery did not complete. No live holder or takeover was displaced, and no lock claim was deleted. Retrying is safe once the reported condition no longer applies.');
  }
  return failed > 0 ? 1 : 0;
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
    if (res.recorded === false) {
      err(`Audit: NOT RECORDED (${res.recordError ?? 'no audit record was written'})`);
      // The result is what this run observed; the evidence trail is incomplete. Repeating
      // the request cannot restore a record, and an action that already ran would run again.
      err('The result above is what this run observed, but the audit trail will not contain it. Do not repeat the request just to obtain a record; if it ran an action, that action may already have happened.');
    } else if (res.operation) {
      out(`Audit: recorded in operations.jsonl (${res.operation.id})`);
    }
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
    err(`configuration error: ${errorText(e)}`);
    err('No data was read or changed. Check the APEX_* settings in "node bin/apex.js help".');
    return 2;
  }

  // Which store this run is on, stated once, whenever its location came from the fallback rather
  // than from the operator. Every command below can reach that store - the writing families
  // through their records, the reading ones through the audit line an audited read appends - so
  // the line is about the run rather than about one command. `status` and `diagnose` name the
  // directory in their own output and are left out to avoid saying it twice.
  if (app.config?.dataDirIsDefault === true && app.config?.isolated !== true && command !== 'status' && command !== 'diagnose') {
    err(`Data: this run uses the default data directory (${safeText(app.dataDir)}); APEX_DATA_DIR is not set. Set it to keep your store where you chose it.`);
  }

  try {
    if (command === 'status') {
      const { flags, rest } = parseFlags(args, ['model']);
      rejectUnexpected(rest, 'status [--model]');
      const diag = await collectDiagnostics(app, { checkModel: Boolean(flags.model) });
      const { session, conversation, memory, experience, predictions, goals, plans, audit, queue, model, filesystem } = diag.subsystems;
      out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION} (${APP_EXPANSION})`);
      out(dataDirLabel(diag));
      out(sessionLine(session));
      const skipped = (s) => (s.state !== State.UNAVAILABLE && s.corruptLines > 0
        ? ` (corrupt lines skipped: ${s.corruptLines})`
        : '');
      out(`Memory records: ${memory.state === State.UNAVAILABLE ? 'unavailable' : memory.count} (corrupt lines skipped: ${memory.corruptLines})`);
      out(`Conversation turns: ${conversation.state === State.UNAVAILABLE ? 'unavailable' : conversation.count}${skipped(conversation)}`);
      out(`Operation records: ${audit.state === State.UNAVAILABLE ? 'unavailable' : audit.count}${skipped(audit)}`);
      // Named separately from memory on purpose: an experience references one audited event and
      // an adaptation in effect changes how APEX answers, so both counts belong where the user
      // can see what is currently being applied without running a second command.
      out(`Experiences: ${experience.state === State.UNAVAILABLE ? 'unavailable' : `${experience.experiences} record(s), ${experience.feedback} feedback record(s), ${experience.activeAdaptations} approved adaptation(s) in effect`}${skipped(experience)}`);
      if (experience.state !== State.UNAVAILABLE) {
        // How each experience arrived is printed with the counts because the two lead to different
        // questions: a record the user asked for, and a record of an outcome APEX verified on its own.
        out(`Experience capture: ${experience.capture?.setting ?? 'not reported'}; ${experience.recordedByUser} recorded by you, ${experience.capturedAutomatically} captured automatically`);
        if (experience.unknownCapture > 0) {
          out(`Experience capture: ${experience.unknownCapture} record(s) carry capture provenance no writer produces; run "node bin/apex.js experience health"`);
        }
      }
      if (experience.state !== State.UNAVAILABLE && experience.conflicts.scopes > 0) {
        out(`Experiences: ${experience.conflicts.scopes} capability scope(s) hold approved adaptations that disagree; run "node bin/apex.js adaptation list"`);
      }
      // Counted apart from experiences because it answers a different question: what the user
      // recorded expecting, not what happened. The two live in separate logs for that reason.
      out(`Predictions: ${predictions.state === State.UNAVAILABLE ? 'unavailable' : `${predictions.predictions} expectation(s) recorded, ${predictions.live} standing, ${predictions.evaluations} evaluated against recorded outcomes`}${skipped(predictions)}`);
      if (predictions.state !== State.UNAVAILABLE && predictions.predictions > 0) {
        out('  Expectations the user recorded, not observations, and no confidence is stored in any of them; run "node bin/apex.js prediction list" or "prediction summary".');
      }
      // Recorded intent, apart from work: an open goal or plan is unfinished intent, and a task
      // completing does not complete either one.
      out(`Goals: ${goals.state === State.UNAVAILABLE ? 'unavailable' : `${goals.count} record(s), ${goals.open} open`}${skipped(goals)}`);
      out(`Plans: ${plans.state === State.UNAVAILABLE ? 'unavailable' : `${plans.count} record(s), ${plans.open} open`}${skipped(plans)}`);
      out(`Deferred task summaries: ${queue.count === null ? queue.state : `${queue.count}/${queue.max}${queue.full ? ' (full)' : ''}`}`);
      if (diag.locks?.task?.state === State.CORRUPT || diag.locks?.queue?.state === State.CORRUPT) {
        out('Locks: abandoned takeover tokens require recovery; run "node bin/apex.js repair locks".');
      }
      out(modelLine(model));
      if (model.state === State.UNAVAILABLE) {
        out(model.reachable === true
          ? 'Model: no inference was tested. The endpoint answered but readiness failed (see above); correct the model name you configured, then re-run "status --model".'
          : 'Model: no inference was tested. The endpoint you configured did not answer; re-running "status --model" is safe because that probe only reads the model list. APEX does not install, start, or recommend a model server; check that the server you configured is running and reachable at that URL.');
      }
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
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'memory health');
        // A direct, unaudited read. Exit 0 only when the store was fully inspected and
        // nothing requires attention; damage or an unreadable store exits 1.
        const res = await app.controller.memoryHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
      }
      if (sub !== 'correct') {
        err('usage: memory correct --resolve <full-record-id> <replacement claim...> | memory health');
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
        const { flags, rest: extra } = parseFlags(rest, ['subject', 'relationship', 'object', 'evidence', 'supersedes']);
        rejectUnexpected(extra, 'knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]');
        if (!flags.subject || !flags.relationship || !flags.object) {
          err('usage: knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]');
          return 2;
        }
        const supersedes = typeof flags.supersedes === 'string'
          ? flags.supersedes.split(',').map((value) => value.trim()).filter(Boolean)
          : [];
        return emit(await app.controller.knowledgeAdd({
          subject: flags.subject,
          relationship: flags.relationship,
          object: flags.object,
          evidence: flags.evidence ?? null,
          supersedes,
        }));
      }
      if (sub === 'retract') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err('usage: knowledge retract <record-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.knowledgeRetract({
          target: ids[0],
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'resolve') {
        const { flags, rest: ids } = parseFlags(rest, ['choose', 'reason']);
        if (ids.length !== 1 || typeof flags.choose !== 'string' || flags.choose.trim().length === 0) {
          err('usage: knowledge resolve <target-id> --choose <claim-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.knowledgeResolve({
          target: ids[0],
          choose: flags.choose,
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'history') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: knowledge history <record-id>');
          return 2;
        }
        // A direct, unaudited read, like `knowledge show`: no operation record exists,
        // so the exit code reports whether the lifecycle could be resolved.
        const res = await app.controller.knowledgeHistory(ids[0]);
        out(res.display ?? res.output ?? '(none)');
        return res.status === Outcome.SUCCESS_VERIFIED ? 0 : 1;
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'knowledge health');
        // A direct, unaudited read. Exit 0 only when the store was fully inspected and
        // nothing requires a decision; damage, ambiguity, anomalies, and unresolved
        // conflicts exit 1 without changing anything.
        const res = await app.controller.knowledgeHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
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
      err('usage: knowledge add|retract|resolve|history|health|list|search|show');
      return 2;
    }

    if (command === 'experience') {
      const [sub, ...rest] = args;
      if (sub === 'record') {
        const { flags, rest: ids } = parseFlags(rest, ['subject', 'replaces']);
        if (ids.length !== 1 || !flags.subject) {
          err('usage: experience record <operation-id> --subject <text> [--replaces <id[,id...]>]');
          return 2;
        }
        return emit(await app.controller.experienceRecord({
          operationId: ids[0],
          subject: flags.subject,
          replaces: idList(flags.replaces),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'experience list [--limit N]');
        return emit(await app.controller.experienceList({ limit: flags.limit }));
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: experience show <experience-or-operation-id>');
          return 2;
        }
        return emit(await app.controller.experienceShow({ target: ids[0] }));
      }
      // Temporal reads. The window is resolved by the temporal engine, so an unparseable bound is
      // refused as usage here only when it has the wrong shape; a well-formed but unknown date is
      // reported by the action as rejected input.
      if (['timeline', 'trends', 'patterns'].includes(sub)) {
        const { flags, rest: extra } = parseFlags(rest, ['since', 'until', 'days', 'capability', 'limit']);
        rejectUnexpected(extra, `experience ${sub} [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]`);
        const query = { since: flags.since, until: flags.until, days: flags.days, capability: flags.capability, limit: flags.limit };
        const method = sub === 'timeline' ? 'experienceTimeline' : sub === 'trends' ? 'experienceTrends' : 'experiencePatterns';
        return emit(await app.controller[method](query));
      }
      if (sub === 'compare') {
        const { flags, rest: extra } = parseFlags(rest, ['a-since', 'a-until', 'b-since', 'b-until', 'days', 'capability']);
        rejectUnexpected(extra, 'experience compare [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]');
        return emit(await app.controller.experienceCompare({
          aSince: flags['a-since'],
          aUntil: flags['a-until'],
          bSince: flags['b-since'],
          bUntil: flags['b-until'],
          days: flags.days,
          capability: flags.capability,
        }));
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'experience health');
        // A direct, unaudited read. Exit 0 only when the log was fully inspected, nothing needs
        // a decision, and every recorded experience still matches the audit event it names.
        const res = await app.controller.experienceHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention || res.evidenceMismatch > 0 ? 1 : 0;
      }
      err('usage: experience record|list|show|timeline|trends|patterns|compare|health');
      return 2;
    }

    if (command === 'feedback') {
      const [sub, ...rest] = args;
      if (sub !== 'record') {
        err('usage: feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]');
        return 2;
      }
      const { flags, rest: ids } = parseFlags(rest, ['assessment', 'guidance', 'reason', 'supersedes']);
      if (ids.length !== 1 || !flags.assessment) {
        err('usage: feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]');
        return 2;
      }
      return emit(await app.controller.feedbackRecord({
        target: ids[0],
        assessment: flags.assessment,
        guidance: flags.guidance ?? null,
        reason: flags.reason ?? null,
        supersedes: idList(flags.supersedes),
      }));
    }

    if (command === 'adaptation') {
      const [sub, ...rest] = args;
      if (sub === 'derive') {
        const { flags, rest: extra } = parseFlags(rest, ['min-support']);
        rejectUnexpected(extra, 'adaptation derive [--min-support N]');
        return emit(await app.controller.adaptationDerive({ minSupport: flags['min-support'] }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'exclude-retired']);
        rejectUnexpected(extra, 'adaptation list [--limit N] [--exclude-retired]');
        return emit(await app.controller.adaptationList({
          limit: flags.limit,
          includeRetired: flags['exclude-retired'] ? false : undefined,
        }));
      }
      if (sub === 'approve' || sub === 'reject') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err(`usage: adaptation ${sub} <adaptation-id> [--reason <text>]`);
          return 2;
        }
        // The decision is the command that was typed. There is no default: a bare
        // `adaptation decide` cannot approve anything.
        return emit(await app.controller.adaptationDecide({
          target: ids[0],
          decision: sub === 'approve' ? 'approved' : 'rejected',
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'retire') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err('usage: adaptation retire <adaptation-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.adaptationRetire({ target: ids[0], reason: flags.reason ?? null }));
      }
      err('usage: adaptation derive|list|approve|reject|retire');
      return 2;
    }

    if (command === 'prediction') {
      const [sub, ...rest] = args;
      const recordUsage = 'prediction record --capability <name> --expect <kind> --subject <text> (--expires <iso> | --in-days N) [--supports <id[,id...]>] [--contradicts <id[,id...]>] [--feedback <id[,id...]>] [--pattern <kind[,kind...]>] [--replaces <id[,id...]>]';
      if (sub === 'record') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'expect', 'subject', 'expires', 'in-days', 'supports', 'contradicts', 'feedback', 'pattern', 'replaces']);
        rejectUnexpected(extra, recordUsage);
        if (!flags.capability || !flags.expect || !flags.subject) {
          err(`usage: ${recordUsage}`);
          return 2;
        }
        // One horizon, stated here rather than left to the action, because the two spellings are a
        // question of what to type: the ledger stores an instant, while "in 30 days" is what the
        // user means. Accepting both and preferring one would quietly record a bound that was not
        // the one asked for.
        if (flags.expires !== undefined && flags['in-days'] !== undefined) {
          err('usage: give the horizon either as --expires or as --in-days, not both');
          return 2;
        }
        if (flags.expires === undefined && flags['in-days'] === undefined) {
          err('usage: prediction record needs a horizon: --expires <iso> or --in-days N');
          return 2;
        }
        return emit(await app.controller.predictionRecord({
          capability: flags.capability,
          expectation: flags.expect,
          subject: flags.subject,
          expiresAt: flags.expires,
          inDays: flags['in-days'],
          evidence: {
            supportingExperienceIds: idList(flags.supports),
            contradictingExperienceIds: idList(flags.contradicts),
            feedbackIds: idList(flags.feedback),
            patternKinds: idList(flags.pattern),
          },
          replaces: idList(flags.replaces),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'capability', 'status']);
        rejectUnexpected(extra, 'prediction list [--limit N] [--capability <name>] [--status <name>]');
        return emit(await app.controller.predictionList({
          limit: flags.limit,
          capability: flags.capability,
          status: flags.status,
        }));
      }
      if (sub === 'show' || sub === 'history' || sub === 'evaluate') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err(`usage: prediction ${sub} <prediction-id>`);
          return 2;
        }
        // "evaluate" is the only one of these three that writes, and it writes a verdict the ledger
        // computes from recorded outcomes; the command supplies a reference and nothing else.
        const method = sub === 'show' ? 'predictionShow' : sub === 'history' ? 'predictionHistory' : 'predictionEvaluate';
        return emit(await app.controller[method]({ target: ids[0] }));
      }
      if (sub === 'invalidate') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        // The reason is part of the withdrawal, not a comment on it: the ledger keeps it with the
        // record so a later reader knows why the expectation was withdrawn. The store refuses an
        // absent reason, and a usage refusal costs no operation record.
        if (ids.length !== 1 || !flags.reason) {
          err('usage: prediction invalidate <prediction-id> --reason <text>');
          return 2;
        }
        return emit(await app.controller.predictionInvalidate({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'summary') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'limit']);
        rejectUnexpected(extra, 'prediction summary [--capability <name>] [--limit N]');
        return emit(await app.controller.predictionSummary({ capability: flags.capability, limit: flags.limit }));
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'prediction health');
        // A direct, unaudited read, like `experience health`: exit 0 only when the ledger was fully
        // inspected and every withdrawal and verdict names a prediction that is in the log.
        const res = await app.controller.predictionHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
      }
      err('usage: prediction record|list|show|history|evaluate|invalidate|summary|health');
      return 2;
    }

    if (command === 'audit') {
      const [sub, ...rest] = args;
      if (sub !== 'health') {
        err('usage: audit health');
        return 2;
      }
      rejectUnexpected(parseFlags(rest, []).rest, 'audit health');
      // A direct, unaudited read. Exit 0 only when the log was fully inspected and
      // nothing requires attention; damage or an unreadable log exits 1.
      const res = await app.controller.auditHealth();
      out(res.display ?? res.output ?? '(none)');
      return res.health?.attention ? 1 : 0;
    }

    if (command === 'queue') {
      const { flags, rest } = parseFlags(args, ['limit']);
      rejectUnexpected(rest, 'queue [--limit N]');
      return await showQueue({ app, limit: flags.limit ?? 20, out, err });
    }

    if (command === 'repair') {
      const [sub, ...rest] = args;
      if (sub !== 'locks') {
        err('usage: repair locks');
        return 2;
      }
      rejectUnexpected(parseFlags(rest, []).rest, 'repair locks');
      return await repairLocks({ app, out, err });
    }

    if (command === 'ask') {
      const { flags, rest } = parseFlags(args, ['save-answer']);
      const text = rest.join(' ');
      if (text.trim() === '') {
        err('usage: ask [--save-answer] <request>');
        return 2;
      }
      const res = await app.controller.handle(text, {
        origin: 'user',
        saveAnswer: Boolean(flags['save-answer']),
        onProgress: stderr.isTTY ? modelWaiting(err) : null,
      });
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
      let listed;
      try {
        listed = await app.operations.list({ limit: flags.limit ?? 10 });
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        err(`Audit: unavailable (${errorText(e)})`);
        err('No operation records could be read. This does not establish that any operation did not run. Run "node bin/apex.js diagnose" for a read-only view of what is readable; do not repeat an action merely because its record cannot be listed.');
        return 1;
      }
      const { records, corrupt } = listed;
      if (records.length === 0) out('No operations recorded yet.');
      for (const op of records) {
        // A record written before the audit mask existed can still hold a credential, so the
        // reader redacts what it prints. Nothing on disk is rewritten.
        out(`${op.requestedAt}  ${op.id}  ${op.status}  ${op.capability}  ${redactSecrets(String(op.request ?? ''))}`);
      }
      if (corrupt) {
        out(`(${corrupt} corrupt audit line(s) skipped)`);
        out(`Audit: ${corrupt} record(s) cannot be read, so this list is incomplete. A missing record does not prove an action did not execute; run "node bin/apex.js diagnose" before repeating anything.`);
      }
      return 0;
    }

    if (command === 'world') {
      const { flags, rest } = parseFlags(args, ['limit']);
      rejectUnexpected(rest, 'world [--limit N]');
      if (flags.limit !== undefined && (flags.limit < 1 || flags.limit > MAX_WORLD_LIMIT)) {
        err(`usage: world [--limit N]  (N is 1-${MAX_WORLD_LIMIT})`);
        return 2;
      }
      // A direct, unaudited read, like `memory health`: it writes nothing.
      const res = await app.controller.worldState({ limit: flags.limit });
      out(res.display);
      return res.world?.attention ? 1 : 0;
    }

    if (command === 'goal') {
      const [sub, ...rest] = args;
      if (sub === 'add') {
        const { flags, rest: words } = parseFlags(rest, ['criterion', 'priority', 'deadline', 'depends-on']);
        const request = words.join(' ').trim();
        if (request === '') {
          err('usage: goal add [--criterion <text>]... [--priority N] [--deadline <iso>] [--depends-on <id>]... <request>');
          return 2;
        }
        if ((flags.criterion ?? []).length === 0) {
          err('usage: goal add needs at least one --criterion; a goal without success criteria cannot be completed');
          return 2;
        }
        return emit(await app.controller.goalAdd({
          request,
          criteria: flags.criterion,
          priority: flags.priority ?? 3,
          deadline: flags.deadline ?? null,
          dependsOn: flags['depends-on'] ?? [],
        }));
      }
      if (sub === 'revise') {
        const { flags, rest: ids } = parseFlags(rest, ['request', 'criterion', 'priority', 'deadline', 'reason']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal revise <id> --criterion <text>... --reason <text> [--request <text>] [--priority N] [--deadline <iso>]', 'USAGE');
        }
        if ((flags.criterion ?? []).length === 0) {
          throw new ValidationError('goal revise needs at least one --criterion; a goal without success criteria cannot be completed', 'USAGE');
        }
        if (!flags.reason) throw new ValidationError('goal revise needs --reason <text>', 'USAGE');
        return emit(await app.controller.goalRevise({
          target: ids[0],
          request: flags.request ?? undefined,
          criteria: flags.criterion,
          priority: flags.priority,
          deadline: flags.deadline,
          reason: flags.reason,
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'goal list [--limit N]');
        out(await app.controller.listGoals({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: goal show <id>', 'USAGE');
        out((await app.controller.showGoal(ids[0])).display);
        return 0;
      }
      if (sub === 'update') {
        const { flags, rest: words } = parseFlags(rest, ['reason', 'by']);
        if (words.length !== 2) {
          throw new ValidationError('usage: goal update <id> <status> [--reason <text>] [--by <goal-id>]', 'USAGE');
        }
        return emit(await app.controller.goalUpdate({
          target: words[0],
          status: words[1],
          reason: flags.reason ?? null,
          by: flags.by ?? null,
        }));
      }
      if (sub === 'evidence') {
        const { flags, rest: ids } = parseFlags(rest, ['criterion', 'kind', 'operation', 'detail', 'reopen']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal evidence <id> --criterion <c1> --kind supports|contradicts [--operation <audit-id>] [--detail <text>] [--reopen]', 'USAGE');
        }
        if ((flags.criterion ?? []).length !== 1) {
          throw new ValidationError('usage: goal evidence needs exactly one --criterion, such as c1', 'USAGE');
        }
        if (!flags.kind) {
          throw new ValidationError('usage: goal evidence needs --kind supports or --kind contradicts', 'USAGE');
        }
        return emit(await app.controller.goalEvidence({
          target: ids[0],
          criterion: flags.criterion[0],
          kind: flags.kind,
          operationId: flags.operation ?? null,
          detail: flags.detail ?? null,
          reopen: flags.reopen === true,
        }));
      }
      if (sub === 'complete') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) throw new ValidationError('usage: goal complete <id> [--reason <text>]', 'USAGE');
        return emit(await app.controller.goalComplete({
          target: ids[0],
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'link') {
        const { flags, rest: ids } = parseFlags(rest, ['plan', 'task']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal link <id> (--plan <id> | --task <id>)', 'USAGE');
        }
        return emit(await app.controller.goalLink({
          target: ids[0],
          planId: flags.plan ?? null,
          taskId: flags.task ?? null,
        }));
      }
      err('usage: goal add|revise|list|show|update|evidence|complete|link');
      return 2;
    }

    if (command === 'plan') {
      const [sub, ...rest] = args;
      // Steps and assertions are JSON objects, never a separator-joined string: a malformed
      // one is a usage error here rather than a plan the action silently misreads.
      const content = (flags, requireReason) => {
        if (!flags.outcome) throw new ValidationError('a plan needs --outcome <text>', 'USAGE');
        if ((flags.step ?? []).length === 0) throw new ValidationError('a plan needs at least one --step <json>', 'USAGE');
        if (requireReason && !flags.reason) throw new ValidationError('this plan change needs --reason <text>', 'USAGE');
        return {
          outcome: flags.outcome,
          steps: jsonObjects(flags.step, 'step'),
          preconditions: flags.precondition ?? [],
          assertions: jsonObjects(flags.assertion, 'assertion'),
          estimatedSeconds: flags.estimate ?? null,
          reason: flags.reason ?? null,
        };
      };
      if (sub === 'add') {
        const { flags, rest: extra } = parseFlags(rest, ['goal', 'outcome', 'step', 'precondition', 'assertion', 'estimate', 'reason']);
        rejectUnexpected(extra, 'plan add --outcome <text> --step <json>... [--goal <id>] [--precondition <text>]... [--assertion <json>]... [--estimate N] [--reason <text>]');
        return emit(await app.controller.planAdd({
          goalId: flags.goal ?? null,
          ...content(flags, false),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'plan list [--limit N]');
        out(await app.controller.listPlans({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan show <id>', 'USAGE');
        out((await app.controller.showPlan(ids[0])).display);
        return 0;
      }
      if (sub === 'validate') {
        // A read with no operation record, like `plan show`: it checks the stored plan against
        // the live registry and writes nothing.
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan validate <id>', 'USAGE');
        const res = await app.controller.validateStoredPlan(ids[0]);
        out(res.display);
        return res.validation.ok ? 0 : 1;
      }
      if (sub === 'history') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan history <id>', 'USAGE');
        out((await app.controller.planHistory(ids[0])).display);
        return 0;
      }
      if (sub === 'compare') {
        const { flags, rest: ids } = parseFlags(rest, ['from', 'to']);
        if (ids.length !== 1) throw new ValidationError('usage: plan compare <id> [--from N] [--to N]', 'USAGE');
        const res = await app.controller.planCompare(ids[0], { from: flags.from ?? null, to: flags.to ?? null });
        out(res.display);
        return res.diff.unchanged ? 0 : 1;
      }
      if (sub === 'revise') {
        const { flags, rest: ids } = parseFlags(rest, ['outcome', 'step', 'precondition', 'assertion', 'estimate', 'reason']);
        if (ids.length !== 1) throw new ValidationError('usage: plan revise <id> --outcome <text> --step <json>... --reason <text>', 'USAGE');
        return emit(await app.controller.planRevise({
          target: ids[0],
          ...content(flags, true),
        }));
      }
      if (sub === 'approve') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan approve <id>', 'USAGE');
        return emit(await app.controller.planApprove({ target: ids[0] }));
      }
      if (sub === 'start' || sub === 'activate') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError(`usage: plan ${sub} <id>`, 'USAGE');
        return emit(await app.controller.planActivate(ids[0], { mode: 'run' }));
      }
      if (sub === 'reconcile') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan reconcile <id>', 'USAGE');
        return emit(await app.controller.planReconcile(ids[0]));
      }
      if (sub === 'cancel') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) {
          throw new ValidationError('usage: plan cancel <id> --reason <text>', 'USAGE');
        }
        return emit(await app.controller.planCancel({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'supersede') {
        const { flags, rest: ids } = parseFlags(rest, ['by', 'reason']);
        if (ids.length !== 1 || !flags.by || !flags.reason) {
          throw new ValidationError('usage: plan supersede <id> --by <plan-id> --reason <text>', 'USAGE');
        }
        return emit(await app.controller.planSupersede({
          target: ids[0],
          by: flags.by,
          reason: flags.reason,
        }));
      }
      err('usage: plan add|list|show|validate|history|compare|revise|approve|start|reconcile|cancel|supersede');
      return 2;
    }

    if (command === 'propose') {
      const { flags, rest: words } = parseFlags(args, ['kind', 'goal', 'plan']);
      const request = words.join(' ').trim();
      if (request === '') {
        throw new ValidationError('usage: propose [--kind goal_create|goal_clarify|plan_create|plan_revise|advice] [--goal <id>] [--plan <id>] <request>', 'USAGE');
      }
      return emit(await app.controller.proposeExecutive({
        kind: flags.kind ?? null,
        request,
        goal: flags.goal ?? null,
        plan: flags.plan ?? null,
        onProgress: modelWaiting(err),
      }));
    }

    if (command === 'proposal') {
      const [sub, ...rest] = args;
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'proposal list [--limit N]');
        out(await app.controller.listProposals({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: proposal show <id>', 'USAGE');
        out((await app.controller.showProposal(ids[0])).display);
        return 0;
      }
      if (sub === 'accept') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) throw new ValidationError('usage: proposal accept <id> [--reason <text>]', 'USAGE');
        return emit(await app.controller.acceptProposal({ target: ids[0], reason: flags.reason ?? null }));
      }
      if (sub === 'reject') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) throw new ValidationError('usage: proposal reject <id> --reason <text>', 'USAGE');
        return emit(await app.controller.rejectProposal({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'invalidate') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) throw new ValidationError('usage: proposal invalidate <id> --reason <text>', 'USAGE');
        return emit(await app.controller.invalidateProposal({ target: ids[0], reason: flags.reason }));
      }
      err('usage: proposal list|show|accept|reject|invalidate');
      return 2;
    }

    if (command === 'recover') {
      rejectUnexpected(parseFlags(args, []).rest, 'recover');
      // A direct, unaudited read: it reports what the stores say about unfinished work and
      // writes nothing. It never resumes, retries, or cancels anything by itself.
      const res = await app.controller.recoveryReport();
      out(res.display ?? res.output ?? '(none)');
      return res.attention ? 1 : 0;
    }

    if (command === 'work' || command === 'next') {
      const { flags, rest: extra } = parseFlags(args, ['limit']);
      rejectUnexpected(extra, command === 'next' ? 'next' : 'work [--limit N]');
      const res = await app.controller.continuationReport(
        command === 'next' ? { limit: 1, top: true } : { limit: flags.limit ?? null },
      );
      out(res.display);
      // Candidates are not errors. Only an unreadable or damaged record makes the answer
      // incomplete, and that is reported as a nonzero exit.
      return res.problems.length > 0 ? 1 : 0;
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
        const res = await app.controller.planTask(words.join(' '), {
          onProgress: stderr.isTTY ? modelWaiting(err) : null,
        });
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
        if ((flags.step ?? []).length > 1) throw new ValidationError('usage: task approve <id> [--step <stepId>]', 'USAGE');
        return emit(await app.controller.approveTask(ids[0], { stepId: flags.step?.[0] ?? null }));
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

    err(`unknown command: ${safeText(command, 200)}`);
    err('run "node bin/apex.js help" for usage');
    return 2;
  } catch (e) {
    if (e instanceof ValidationError) {
      err(`usage error: ${errorText(e)}`);
      return 2;
    }
    if (e instanceof StoreError) {
      if (e.code === 'LOCKED') {
        err(`lock contention: ${errorText(e)}`);
        err('No data was changed: the command was refused before it could run. This is not a data-directory permission problem. If no task run or recovery is active, run "node bin/apex.js repair locks" to inspect abandoned takeover tokens; a dead lock claim is taken over by the next normal run. Retrying after the active run finishes is safe.');
        return 1;
      }
      if (/corrupt/i.test(e.message)) {
        // A damaged store is not a permissions problem, and the repair is not a retry.
        err(`data store corrupt: ${errorText(e)}`);
        err('No file was changed. Run "node bin/apex.js diagnose" for what is readable, what is uncertain, and recovery guidance; there is no supported automatic repair for this store.');
        return 1;
      }
      err(`data store unavailable: ${errorText(e)}. No file was changed. Check APEX_DATA_DIR, its permissions, and free space; run "node bin/apex.js diagnose" for details.`);
      return 1;
    }
    err(`unexpected error: ${errorText(e)}`);
    return 1;
  }
}

// Interactive loop. Reads lines until end of input or /exit. Each line is one
// request through the controller, in the current session.
async function runChat({ app, stdin, stdout, stderr, out }) {
  const interactive = Boolean(stdin.isTTY);
  const err = (s) => stderr.write(`${s}\n`);
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
        const res = await app.controller.handle(line, {
          origin: 'user',
          onProgress: interactive ? modelWaiting(err) : null,
        });
        out(formatChatReply(res));
        const session = sessionNotice(res);
        if (session) stderr.write(`${session}\n`);
      } catch (e) {
        out(`error: ${errorText(e)}`);
      }
    }
    if (interactive) stdout.write('you> ');
  }
  rl.close();
  return 0;
}
