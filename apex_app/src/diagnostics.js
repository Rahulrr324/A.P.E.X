// Read-only operational diagnostics. Nothing here writes, repairs, resumes, or
// retries: every check either reads a file or replays a task log in memory. The
// goal is to separate what is known from what is merely suspected, and to point
// at recovery commands that actually exist.
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { Outcome } from './outcomes.js';
import { StoreError } from './errors.js';
import { StepStatus, TaskStatus } from './tasks/model.js';
import { CONTROL_CHARS, shortId, truncate } from './util.js';
import { redactSecrets } from './security/secrets.js';

export const State = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
  CORRUPT: 'corrupt',
  NOT_CONFIGURED: 'not configured',
  NOT_CHECKED: 'not checked',
});

const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

// Every value that reaches the terminal is bounded, stripped of control
// characters, and redacted. Diagnostics never print stored content, prompts,
// goals, or request text.
export function safeText(value, max = 240) {
  const text = String(value ?? '').replace(CONTROL_CHARS_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
  return truncate(redactSecrets(text), max);
}

function errorDetail(err) {
  if (err instanceof StoreError) return err.message;
  return err?.message ?? String(err);
}

// Redact before shortening, so a credential-like identifier is not partially
// exposed by an eight-character display prefix.
function safeId(id) {
  return safeText(shortId(redactSecrets(String(id ?? ''))), 32);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    return err?.code === 'ENOENT' ? false : null;
  }
}

function missingValid(label, noun) {
  return `${label}: missing (valid: no ${noun} yet)`;
}

function jsonlState({ label, noun, records, corrupt, exists, impact }) {
  if (corrupt.length > 0) {
    return {
      state: State.CORRUPT,
      summary: `${label}: corrupt (${records.length} readable ${noun}, ${corrupt.length} corrupt line(s); ${impact})`,
    };
  }
  if (exists === false) return { state: State.MISSING, summary: missingValid(label, noun) };
  return { state: State.OK, summary: `${label}: ok (${records.length} ${noun})` };
}

async function loadLog(log) {
  try {
    const { records, corrupt } = await log.load();
    return { ok: true, records, corrupt };
  } catch (err) {
    return { ok: false, detail: errorDetail(err) };
  }
}

function corruptLineProblems(fileName, corrupt) {
  return corrupt.map((c) => `${fileName}: line ${c.line}: ${safeText(c.reason, 160)}`);
}

async function inspectJsonlStore({ key, label, noun, filePath, log, impact }) {
  const loaded = await loadLog(log);
  if (!loaded.ok) {
    return {
      key,
      label,
      state: State.UNAVAILABLE,
      count: null,
      corruptLines: 0,
      detail: loaded.detail,
      summary: `${label}: unavailable (${safeText(loaded.detail)})`,
      problems: [],
    };
  }
  const exists = await fileExists(filePath);
  const state = jsonlState({ label, noun, records: loaded.records, corrupt: loaded.corrupt, exists, impact });
  return {
    key,
    label,
    state: state.state,
    count: loaded.records.length,
    corruptLines: loaded.corrupt.length,
    detail: null,
    summary: state.summary,
    problems: corruptLineProblems(path.basename(filePath), loaded.corrupt),
  };
}

export async function collectDiagnostics(app, { checkModel = false, modelTimeoutMs = 2000 } = {}) {
  const confirmed = [];
  const suspicions = [];
  const unchecked = [];
  const recovery = [];
  const subsystems = {};

  subsystems.configuration = {
    key: 'configuration',
    label: 'Configuration',
    state: State.OK,
    summary: 'Configuration: ok (validated at startup)',
    count: null,
    corruptLines: 0,
    problems: [],
  };

  // --- session ---------------------------------------------------------------
  const session = await app.session.peek();
  if (session.status === 'ok') {
    subsystems.session = {
      key: 'session',
      label: 'Session',
      state: State.OK,
      summary: `Session: ok (${safeId(session.state.sessionId)})`,
      sessionId: session.state.sessionId,
      count: null,
      corruptLines: 0,
      problems: [],
    };
  } else if (session.status === 'missing') {
    subsystems.session = {
      key: 'session',
      label: 'Session',
      state: State.MISSING,
      summary: 'Session: missing (valid: a new session starts on the first request)',
      sessionId: null,
      count: null,
      corruptLines: 0,
      problems: [],
    };
  } else {
    const corrupt = session.status === 'corrupt';
    subsystems.session = {
      key: 'session',
      label: 'Session',
      state: corrupt ? State.CORRUPT : State.UNAVAILABLE,
      summary: corrupt
        ? `Session: corrupt (${safeText(session.detail)}; the current session cannot be loaded)`
        : `Session: unavailable (${safeText(session.detail)})`,
      sessionId: null,
      count: null,
      corruptLines: 0,
      problems: [],
    };
  }

  // --- conversation ----------------------------------------------------------
  subsystems.conversation = await inspectJsonlStore({
    key: 'conversation',
    label: 'Conversation',
    noun: 'turn(s)',
    filePath: app.conversation.filePath,
    log: app.conversation.log,
    impact: 'conversation replay is blocked; new turns are still appended',
  });

  // --- memory ----------------------------------------------------------------
  subsystems.memory = await inspectJsonlStore({
    key: 'memory',
    label: 'Memory',
    noun: 'record(s)',
    filePath: app.memory.filePath,
    log: app.memory.log,
    impact: 'memory reads, search, and corrections are blocked',
  });

  // --- knowledge -------------------------------------------------------------
  subsystems.knowledge = await inspectJsonlStore({
    key: 'knowledge',
    label: 'Knowledge',
    noun: 'record(s)',
    filePath: app.knowledge.filePath,
    log: app.knowledge.log,
    impact: 'knowledge reads and writes are blocked',
  });

  if (session.status === 'corrupt') confirmed.push(`session.json: ${safeText(session.detail)}`);
  confirmed.push(
    ...subsystems.conversation.problems,
    ...subsystems.memory.problems,
    ...subsystems.knowledge.problems,
  );

  // --- tasks -----------------------------------------------------------------
  let taskInspect = null;
  let taskLoadError = null;
  try {
    taskInspect = await app.taskStore.inspect();
  } catch (err) {
    taskLoadError = errorDetail(err);
  }
  if (taskLoadError) {
    subsystems.tasks = {
      key: 'tasks',
      label: 'Tasks',
      state: State.UNAVAILABLE,
      summary: `Tasks: unavailable (${safeText(taskLoadError)})`,
      count: null,
      events: null,
      corruptLines: 0,
      problems: [],
    };
  } else {
    const taskFileExists = await fileExists(app.taskStore.filePath);
    const replayProblems = taskInspect.problems;
    const corrupt = taskInspect.corrupt;
    let state = State.OK;
    if (corrupt.length > 0 || replayProblems.length > 0) state = State.CORRUPT;
    else if (taskFileExists === false) state = State.MISSING;
    const summary = state === State.MISSING
      ? missingValid('Tasks', 'tasks')
      : state === State.CORRUPT
        ? `Tasks: corrupt (${taskInspect.events} readable event(s), ${taskInspect.tasks.length} recoverable task(s), ${corrupt.length} corrupt line(s), ${replayProblems.length} event(s) that cannot be applied)`
        : `Tasks: ok (${taskInspect.tasks.length} task(s), ${taskInspect.events} event(s))`;
    subsystems.tasks = {
      key: 'tasks',
      label: 'Tasks',
      state,
      summary,
      count: taskInspect.tasks.length,
      events: taskInspect.events,
      corruptLines: corrupt.length,
      problems: [
        ...corruptLineProblems(path.basename(app.taskStore.filePath), corrupt),
        ...replayProblems.map((p) => `${path.basename(app.taskStore.filePath)}: readable event ${p.index + 1}: ${safeText(p.reason, 160)}`),
      ],
    };
    confirmed.push(...subsystems.tasks.problems);
  }

  // --- audit -----------------------------------------------------------------
  let auditInspect = null;
  let auditLoadError = null;
  try {
    auditInspect = await app.operations.inspect();
  } catch (err) {
    auditLoadError = errorDetail(err);
  }
  let auditState = State.UNAVAILABLE;
  const auditProblems = [];
  if (!auditLoadError) {
    const auditFileExists = await fileExists(app.operations.filePath);
    auditProblems.push(...corruptLineProblems(path.basename(app.operations.filePath), auditInspect.corrupt));
    const idCounts = new Map();
    for (const op of auditInspect.records) {
      idCounts.set(op.id, (idCounts.get(op.id) ?? 0) + 1);
      if (typeof op.requestedAt !== 'string' || Number.isNaN(Date.parse(op.requestedAt))) {
        auditProblems.push(`${path.basename(app.operations.filePath)}: operation ${safeId(op.id)} has a missing or invalid requestedAt timestamp`);
      }
    }
    for (const [id, count] of idCounts) {
      if (count > 1) {
        auditProblems.push(`${path.basename(app.operations.filePath)}: duplicate operation id ${safeId(id)} appears ${count} times`);
      }
    }
    const hasCorrupt = auditInspect.corrupt.length > 0;
    const hasInvalid = auditProblems.length > 0;
    if (hasCorrupt || hasInvalid) auditState = State.CORRUPT;
    else if (auditFileExists === false) auditState = State.MISSING;
    else auditState = State.OK;
    subsystems.audit = {
      key: 'audit',
      label: 'Audit',
      state: auditState,
      summary: auditState === State.MISSING
        ? missingValid('Audit', 'operations')
        : auditState === State.CORRUPT
          ? `Audit: corrupt (${auditInspect.records.length} readable operation(s), ${auditInspect.corrupt.length} corrupt line(s), ${auditProblems.length - auditInspect.corrupt.length} inconsistent record(s))`
          : `Audit: ok (${auditInspect.records.length} operation(s))`,
      count: auditInspect.records.length,
      corruptLines: auditInspect.corrupt.length,
      problems: auditProblems,
    };
    confirmed.push(...auditProblems);
  } else {
    subsystems.audit = {
      key: 'audit',
      label: 'Audit',
      state: State.UNAVAILABLE,
      summary: `Audit: unavailable (${safeText(auditLoadError)})`,
      count: null,
      corruptLines: 0,
      problems: [],
    };
  }

  // --- task/audit cross-checks ----------------------------------------------
  const uncertainSteps = [];
  const awaitingApproval = [];
  const pausedTasks = [];
  const runningTasks = [];
  const tasksFullyReadable = taskInspect !== null
    && subsystems.tasks.state !== State.CORRUPT
    && taskInspect.problems.length === 0
    && taskInspect.corrupt.length === 0;
  const tasksKnown = taskInspect !== null && taskInspect.corrupt.length === 0 && taskInspect.problems.length === 0;

  if (taskInspect) {
    for (const task of taskInspect.tasks) {
      if (task.status === TaskStatus.PAUSED) {
        pausedTasks.push({ id: task.id, goal: null });
      } else if (task.status === TaskStatus.RUNNING && tasksFullyReadable) {
        // A "running" task is only interpretable against the lock: with no live
        // holder the log describes an interrupted run whose step outcome is unknown.
        runningTasks.push({
          id: task.id,
          runningSteps: task.steps.filter((s) => s.status === StepStatus.RUNNING).map((s) => s.id),
          live: null,
          pid: null,
        });
      }
      for (const step of task.steps) {
        if (step.status === StepStatus.UNCERTAIN) {
          uncertainSteps.push({ taskId: task.id, stepId: step.id });
        } else if (step.status === StepStatus.AWAITING_APPROVAL) {
          awaitingApproval.push({ taskId: task.id, stepId: step.id });
        }
      }
    }
  }

  if (runningTasks.length > 0) {
    let lock;
    try {
      lock = await app.taskStore.lockState();
    } catch (err) {
      lock = { present: true, pid: null, alive: null, error: errorDetail(err) };
    }
    for (const task of runningTasks) {
      task.live = lock.alive;
      task.pid = lock.pid;
    }
  }
  const unresolvedRunning = runningTasks.filter((task) => task.live !== true);

  if (!taskInspect) {
    unchecked.push('task step -> operation links were not checked because the task log is unavailable');
  } else if (!tasksFullyReadable) {
    unchecked.push('task step -> operation links were not checked because the task log is not fully replayable');
  } else if (auditLoadError) {
    unchecked.push('task step -> operation links were not checked because the audit log is unavailable');
  } else {
    const auditById = new Map();
    for (const op of auditInspect.records) {
      if (!auditById.has(op.id)) auditById.set(op.id, op);
    }
    const taskIds = new Map(taskInspect.tasks.map((t) => [t.id, t]));
    const seenStepOps = new Map();
    const auditIncomplete = auditInspect.corrupt.length > 0;
    if (auditIncomplete) {
      unchecked.push('task step -> operation links were checked only against readable audit records; corrupt audit lines leave completeness unverified');
    }

    for (const task of taskInspect.tasks) {
      for (const step of task.steps) {
        if (step.status === StepStatus.COMPLETED && step.outcome !== Outcome.SUCCESS_VERIFIED) {
          confirmed.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} is completed but its recorded outcome is ${safeText(step.outcome ?? 'none')}`);
        }
        if ((step.status === StepStatus.FAILED || step.status === StepStatus.UNCERTAIN)
          && step.outcome === Outcome.SUCCESS_VERIFIED) {
          confirmed.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} is ${step.status} but claims a verified success`);
        }
        if (typeof step.operationId !== 'string') continue;
        if (seenStepOps.has(step.operationId)) {
          suspicions.push(`two task steps reference the same audit operation id ${safeId(step.operationId)}; this does not establish which action ran`);
        } else {
          seenStepOps.set(step.operationId, step);
        }
        const op = auditById.get(step.operationId);
        if (!op) {
          suspicions.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)}: audit record ${safeId(step.operationId)} was not found${auditIncomplete ? ' among readable audit records' : ''}. This does not prove the action did not execute.`);
          continue;
        }
        if (op.capability !== 'task.step' || !op.task || typeof op.task.id !== 'string') {
          suspicions.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} points to audit record ${safeId(step.operationId)}, which is not a task-step record`);
          continue;
        }
        if (op.task.id !== task.id) {
          confirmed.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} links to audit record ${safeId(step.operationId)}, which belongs to task ${safeId(op.task.id)}`);
        }
        if (typeof op.task.stepId === 'string' && op.task.stepId !== step.id) {
          confirmed.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} links to an audit record for step ${safeText(op.task.stepId, 32)}`);
        }
        if (step.outcome && op.status !== step.outcome) {
          confirmed.push(`task ${safeId(task.id)} step ${safeText(step.id, 32)} records outcome ${safeText(step.outcome)} but its audit record says ${safeText(op.status)}`);
        }
      }
    }

    // Audit records that name a task must point at a task that is still present.
    for (const op of auditInspect.records) {
      if (!op.task || typeof op.task.id !== 'string') continue;
      if (!taskIds.has(op.task.id)) {
        suspicions.push(`audit record ${safeId(op.id)} references task ${safeId(op.task.id)}, which is not present in the task log. The audit record is preserved; this does not establish what executed.`);
        continue;
      }
      if (typeof op.task.stepId === 'string') {
        const task = taskIds.get(op.task.id);
        if (!task.steps.some((s) => s.id === op.task.stepId)) {
          suspicions.push(`audit record ${safeId(op.id)} references step ${safeText(op.task.stepId, 32)}, which is not present in task ${safeId(op.task.id)}`);
        }
      }
    }
  }
  if (!tasksKnown) {
    unchecked.push('audit -> task references were not checked because the task log is not fully loadable');
  }

  // --- model -----------------------------------------------------------------
  const describe = app.gateway.describe();
  let modelState;
  let modelDetail = null;
  if (!describe.configured) {
    modelState = State.NOT_CONFIGURED;
  } else if (!checkModel) {
    modelState = State.NOT_CHECKED;
  } else {
    try {
      const result = await app.gateway.checkAvailability({ timeoutMs: modelTimeoutMs });
      modelState = result.available ? State.OK : State.UNAVAILABLE;
      modelDetail = result.detail;
    } catch (err) {
      modelState = State.UNAVAILABLE;
      modelDetail = errorDetail(err);
    }
  }
  const modelWho = describe.configured
    ? `${safeText(describe.endpoint, 200)} (provider ${safeText(describe.provider, 32)}, model "${safeText(describe.model, 80)}")`
    : 'none configured';
  const modelSummary = modelState === State.NOT_CONFIGURED
    ? 'Model: not configured (non-model functions are available)'
    : modelState === State.NOT_CHECKED
      ? `Model: not checked (configured at ${modelWho}; run "apex diagnose --model" to probe it)`
      : modelState === State.OK
        ? `Model: ok (${safeText(modelDetail)})`
        : `Model: unavailable (${safeText(modelDetail)})`;
  subsystems.model = {
    key: 'model',
    label: 'Model',
    state: modelState,
    summary: modelSummary,
    describe,
    detail: modelDetail,
    count: null,
    corruptLines: 0,
    problems: [],
  };

  // --- filesystem ------------------------------------------------------------
  const fsConfigured = app.filesystemRoot !== null && app.filesystemRoot !== undefined;
  subsystems.filesystem = {
    key: 'filesystem',
    label: 'Filesystem',
    state: fsConfigured ? State.OK : State.NOT_CONFIGURED,
    summary: fsConfigured
      ? `Filesystem: ok (${safeText(app.filesystemRoot)}; root validated at startup, not re-probed here)`
      : 'Filesystem: not configured (set APEX_FILESYSTEM_ROOT to enable read-only inspection)',
    root: fsConfigured ? app.filesystemRoot : null,
    count: null,
    corruptLines: 0,
    problems: [],
  };

  // --- recovery guidance -----------------------------------------------------
  const byKey = (key) => subsystems[key];
  if (byKey('memory').state === State.CORRUPT) {
    recovery.push('Memory: no supported repair command exists. Preserve memory.jsonl and repair the damaged line outside APEX; memory reads, search, and corrections stay blocked until it is repaired.');
  }
  if (byKey('knowledge').state === State.CORRUPT) {
    recovery.push('Knowledge: no supported repair command exists. Preserve knowledge.jsonl; knowledge reads and writes stay blocked until it is repaired.');
  }
  if (byKey('conversation').state === State.CORRUPT) {
    recovery.push('Conversation: no supported repair command exists. Preserve conversation.jsonl. "apex new" starts a new session but does not delete or repair stored turns.');
  }
  if (byKey('tasks').state === State.CORRUPT) {
    recovery.push('Tasks: no supported repair command exists. Preserve tasks.jsonl and do not append to it; task list/show/run/resume/retry/cancel are unavailable until it is repaired.');
  }
  if (byKey('audit').state === State.CORRUPT) {
    recovery.push('Audit: no supported repair command exists. Preserve operations.jsonl; "apex history" skips damaged lines and new operations are still appended, so the audit trail remains incomplete.');
  }
  if (byKey('session').state === State.CORRUPT) {
    recovery.push('Session: "apex new" starts a new session and replaces session.json. Earlier conversation remains stored but is no longer replayed. Do this only if you accept losing the current session pointer.');
  }
  const unavailable = Object.values(subsystems).filter((s) => s.key !== 'model' && s.state === State.UNAVAILABLE);
  if (unavailable.length > 0) {
    recovery.push(`Storage: ${unavailable.map((s) => s.label).join(', ')} unavailable. Check APEX_DATA_DIR, file permissions, and disk space. APEX does not recreate or truncate data automatically.`);
  }
  if (uncertainSteps.length > 0) {
    const sample = uncertainSteps[0];
    recovery.push(`Task ${safeId(sample.taskId)} step ${safeText(sample.stepId, 32)} is uncertain: it may have executed. Review it with "apex task show ${safeId(sample.taskId)}" before deciding. Do not repeat the action blindly; resume, retry, or cancel only as an explicit user decision.`);
  }
  if (unresolvedRunning.length > 0) {
    const sample = unresolvedRunning[0];
    const why = sample.live === false
      ? 'no live process holds the task lock'
      : 'the task lock could not be read';
    recovery.push(`Task ${safeId(sample.id)} is recorded as running, but ${why}: its running step has an unknown outcome. Review it with "apex task show ${safeId(sample.id)}". "apex task resume ${safeId(sample.id)}" records the step as uncertain and pauses the task; "apex task cancel ${safeId(sample.id)}" is also available. Nothing was replayed or retried.`);
  }
  if (suspicions.length > 0) {
    recovery.push('Audit links: do not repeat an action merely because its audit record is missing or inconsistent; it may have executed. Compare the task and audit records before deciding.');
  }
  if (modelState === State.UNAVAILABLE) {
    recovery.push('Model: start the configured local model server, then re-run "apex diagnose --model". Local storage checks above do not depend on the model.');
  }
  if (recovery.length === 0) recovery.push('No recovery action needed.');

  const localDefects = confirmed.length > 0
    || Object.values(subsystems).some((s) => s.key !== 'model' && (s.state === State.CORRUPT || s.state === State.UNAVAILABLE));
  return {
    app: { name: APP_NAME, expansion: APP_EXPANSION, stage: APP_STAGE, version: APP_VERSION },
    dataDir: app.dataDir,
    subsystems,
    integrity: { confirmed, suspicions, unchecked },
    taskState: { uncertainSteps, awaitingApproval, pausedTasks, runningTasks },
    recovery,
    localDefects,
    needsAttention: localDefects
      || modelState === State.UNAVAILABLE
      || uncertainSteps.length > 0
      || unresolvedRunning.length > 0
      || suspicions.length > 0,
  };
}

export function renderDiagnostics(diag) {
  const lines = [];
  lines.push(`${diag.app.name} ${diag.app.stage} ${diag.app.version} (${diag.app.expansion}) - diagnostics`);
  lines.push(`Data directory: ${safeText(diag.dataDir)}`);
  lines.push(`Overall: ${diag.needsAttention ? 'attention required' : 'local subsystems healthy'}`);
  lines.push('Subsystems:');
  for (const key of ['configuration', 'session', 'conversation', 'memory', 'knowledge', 'tasks', 'audit', 'model', 'filesystem']) {
    lines.push(`  ${diag.subsystems[key].summary}`);
  }

  lines.push(`Confirmed integrity defects: ${diag.integrity.confirmed.length === 0 ? 'none' : ''}`.trimEnd());
  for (const problem of diag.integrity.confirmed) lines.push(`  - ${problem}`);

  lines.push(`Unverified integrity suspicions: ${diag.integrity.suspicions.length === 0 ? 'none' : ''}`.trimEnd());
  for (const problem of diag.integrity.suspicions) lines.push(`  - ${problem}`);

  lines.push(`Not checked: ${diag.integrity.unchecked.length === 0 ? 'none' : ''}`.trimEnd());
  for (const problem of diag.integrity.unchecked) lines.push(`  - ${problem}`);

  const attention = [];
  for (const item of diag.taskState.uncertainSteps) {
    attention.push(`task ${safeId(item.taskId)} step ${safeText(item.stepId, 32)} is uncertain: it may have executed; no action was taken`);
  }
  for (const item of diag.taskState.awaitingApproval) {
    attention.push(`task ${safeId(item.taskId)} step ${safeText(item.stepId, 32)} is awaiting explicit approval; nothing was run`);
  }
  for (const item of diag.taskState.pausedTasks) {
    attention.push(`task ${safeId(item.id)} is paused; no action was taken`);
  }
  for (const item of diag.taskState.runningTasks.filter((t) => t.live !== true)) {
    const why = item.live === false
      ? 'no live process holds the task lock'
      : 'the task lock could not be read';
    attention.push(`task ${safeId(item.id)} is recorded as running but ${why}: its running step${item.runningSteps.length === 1 ? '' : 's'}${item.runningSteps.length ? ` (${item.runningSteps.map((s) => safeText(s, 32)).join(', ')})` : ''} may have executed; no action was taken`);
  }
  if (attention.length > 0) {
    lines.push('Task state requiring a decision:');
    for (const item of attention) lines.push(`  - ${item}`);
  }

  const runningNow = diag.taskState.runningTasks.filter((t) => t.live === true);
  if (runningNow.length > 0) {
    lines.push('Tasks running now (task lock held by a live process):');
    for (const item of runningNow) {
      lines.push(`  - task ${safeId(item.id)} is running under process ${safeText(item.pid, 16)}; diagnostics did not change it`);
    }
  }

  lines.push('Note: matching operation identifiers do not prove exactly-once execution; a missing audit record does not prove an action did not execute.');
  lines.push('Recovery guidance:');
  for (const step of diag.recovery) lines.push(`  - ${step}`);
  return lines.join('\n');
}
