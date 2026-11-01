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
import { MAX_QUEUED_SUMMARIES } from './tasks/summary-queue.js';
import { TAKEOVER_EPOCHS } from './tasks/lock-recovery.js';
import { CONTROL_CHARS, shortId, truncate } from './util.js';
import { redactSecrets } from './security/secrets.js';
import { captureSettingPhrase } from './experience/capture.js';

export const State = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
  CORRUPT: 'corrupt',
  NOT_CONFIGURED: 'not configured',
  NOT_CHECKED: 'not checked',
  // The endpoint answered with a valid model list, but the configured model is not in
  // it. The server may still accept any name, so this is not a failure - but it is not
  // evidence that a request will work either, and must not be shown as plain "available".
  UNCONFIRMED: 'unconfirmed',
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
  return corrupt.map((c) => {
    // The store keeps the bytes either way. The distinction only tells an operator
    // whether this is what an interrupted append leaves or damage inside the log.
    const tail = c.truncatedTail
      ? ' (final line without a newline: consistent with an interrupted append; the bytes are preserved and new records start on a new line)'
      : '';
    return `${fileName}: line ${c.line}: ${safeText(c.reason, 160)}${tail}`;
  });
}

async function inspectJsonlStore({ key, label, noun, filePath, log, impact, summarize = null }) {
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
  const extras = summarize ? summarize(loaded.records) : null;
  return {
    key,
    label,
    state: state.state,
    count: loaded.records.length,
    corruptLines: loaded.corrupt.length,
    detail: null,
    summary: `${state.summary}${extras?.suffix ?? ''}`,
    ...(extras?.fields ?? {}),
    problems: corruptLineProblems(path.basename(filePath), loaded.corrupt),
  };
}

// Whether a recorded experience still matches the audit event it names is a second, separate
// question from whether the experience log parses. The store refuses to answer it from a
// damaged log, so the refusal is returned as a plain "not checked" rather than guessed at.
async function inspectExperienceEvidence(app, limit = 20) {
  try {
    return { ok: true, report: await app.experience.evidenceReport({ limit }) };
  } catch (err) {
    return { ok: false, detail: errorDetail(err) };
  }
}

export async function collectDiagnostics(app, { checkModel = false, modelTimeoutMs = 2000 } = {}) {
  const confirmed = [];
  const suspicions = [];
  const unchecked = [];
  const recovery = [];
  const subsystems = {};

  // The configuration was parsed and validated before the app was built. Show the
  // effective values that will actually be used, so "ok" is evidence rather than an
  // assertion: a user can confirm that an environment override took effect. Only
  // known settings are listed; the environment is never dumped.
  const cfg = app.config ?? null;
  let configurationSummary = 'Configuration: ok (validated at startup)';
  if (cfg) {
    const parts = cfg.model.url
      ? [
          `provider ${safeText(cfg.model.provider, 32)}`,
          `model "${safeText(cfg.model.name, 80)}"`,
          `timeout ${cfg.model.timeoutMs} ms`,
          `max ${cfg.model.maxTokens} tokens`,
          `retries ${cfg.model.retries}`,
        ]
      : ['no model backend'];
    parts.push(`context ${cfg.contextTurns} turn(s)`);
    if (cfg.model.allowRemote) parts.push('remote model endpoints allowed');
    configurationSummary = `Configuration: ok (${parts.join('; ')})`;
  }
  subsystems.configuration = {
    key: 'configuration',
    label: 'Configuration',
    state: State.OK,
    summary: configurationSummary,
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

  // A missing session is valid on a fresh install, but not when turns are already
  // stored: the pointer was lost, and a new session will never replay them. That
  // is a suspicion about continuity, not a confirmed data defect.
  if (session.status === 'missing' && subsystems.conversation.state === State.OK && subsystems.conversation.count > 0) {
    const turns = subsystems.conversation.count;
    subsystems.session.orphanTurns = turns;
    subsystems.session.summary = `Session: missing (${turns} stored conversation turn(s) cannot be replayed without a session pointer; a new session starts on the first request)`;
    suspicions.push(`session.json is missing while conversation.jsonl holds ${turns} turn(s). A new session starts on the first request, so those stored turns will not be replayed. This does not establish that they are damaged.`);
  }

  // --- memory ----------------------------------------------------------------
  subsystems.memory = await inspectJsonlStore({
    key: 'memory',
    label: 'Memory',
    noun: 'record(s)',
    filePath: app.memory.filePath,
    log: app.memory.log,
    impact: 'memory reads, search, and corrections are blocked',
    // Structural counts only; no content is read into the report.
    summarize(records) {
      let userFacts = 0;
      let modelConclusions = 0;
      let privateRecords = 0;
      for (const record of records) {
        if (record.kind === 'model_conclusion') modelConclusions += 1;
        else userFacts += 1;
        if (record.sensitivity === 'private') privateRecords += 1;
      }
      return {
        fields: { kinds: { user_fact: userFacts, model_conclusion: modelConclusions }, privateRecords },
        suffix: records.length === 0 ? '' : `; ${userFacts} user fact(s), ${modelConclusions} model conclusion(s), ${privateRecords} private`,
      };
    },
  });

  // --- knowledge -------------------------------------------------------------
  // A claim and a lifecycle event are different things: a retraction event records
  // history, not a knowledge relationship. Store integrity (corrupt lines) and
  // lifecycle consistency (broken links, cycles, contradictory states) are therefore
  // separate. A damaged log makes every count a count of readable records only; it
  // does not make valid historical (superseded or retracted) records corrupt.
  const knowledgeHealth = await app.knowledge.health();
  if (!knowledgeHealth.inspected) {
    subsystems.knowledge = {
      key: 'knowledge',
      label: 'Knowledge',
      state: State.UNAVAILABLE,
      summary: `Knowledge: unavailable (${safeText(knowledgeHealth.detail)})`,
      detail: knowledgeHealth.detail,
      count: null,
      claims: null,
      lifecycleEvents: null,
      corruptLines: 0,
      conflicts: { groups: null, claims: null },
      lifecycle: { state: 'unavailable', anomalies: null },
      problems: [],
    };
    unchecked.push('knowledge lifecycle consistency was not checked because the knowledge store is unavailable');
  } else {
    const exists = await fileExists(app.knowledge.filePath);
    const lifecycleState = !knowledgeHealth.complete
      ? 'cannot be fully established (corrupt lines)'
      : knowledgeHealth.anomalies.count > 0
        ? 'inconsistent'
        : 'consistent';
    let state = State.OK;
    if (knowledgeHealth.corruptLines > 0) state = State.CORRUPT;
    else if (exists === false) state = State.MISSING;
    const parts = [
      `${knowledgeHealth.claims} claim(s)`,
      `${knowledgeHealth.lifecycleEvents} lifecycle event(s)`,
    ];
    if (knowledgeHealth.conflicts.groups > 0) {
      parts.push(`${knowledgeHealth.conflicts.groups} unresolved conflict group(s)`);
    }
    const summary = state === State.MISSING
      ? 'Knowledge: missing (valid: no claim or lifecycle event yet)'
      : state === State.CORRUPT
        ? `Knowledge: corrupt (${parts.join(', ')}, ${knowledgeHealth.corruptLines} corrupt line(s); lifecycle state cannot be fully established)`
        : `Knowledge: ok (${parts.join(', ')}; lifecycle ${lifecycleState})`;
    const problems = corruptLineProblems(path.basename(app.knowledge.filePath), knowledgeHealth.corrupt);
    const lifecycleProblems = knowledgeHealth.anomalies.samples.map(
      (message) => `${path.basename(app.knowledge.filePath)}: lifecycle: ${message}`,
    );
    if (knowledgeHealth.anomalies.count > knowledgeHealth.anomalies.samples.length) {
      lifecycleProblems.push(
        `${path.basename(app.knowledge.filePath)}: lifecycle: ${knowledgeHealth.anomalies.count - knowledgeHealth.anomalies.samples.length} more anomaly(ies) not listed (the health summary carries the exact count)`,
      );
    }
    subsystems.knowledge = {
      key: 'knowledge',
      label: 'Knowledge',
      state,
      summary,
      count: knowledgeHealth.claims,
      claims: knowledgeHealth.claims,
      lifecycleEvents: knowledgeHealth.lifecycleEvents,
      retractions: knowledgeHealth.retractions,
      resolutions: knowledgeHealth.resolutions,
      resolvedConflictGroups: knowledgeHealth.conflicts.resolvedGroups,
      corruptLines: knowledgeHealth.corruptLines,
      conflicts: { groups: knowledgeHealth.conflicts.groups, claims: knowledgeHealth.conflicts.claims },
      lifecycle: {
        state: lifecycleState,
        anomalies: knowledgeHealth.anomalies.count,
        anomaliesTruncated: knowledgeHealth.anomalies.truncated,
      },
      problems: [...problems, ...lifecycleProblems],
    };
    if (knowledgeHealth.corruptLines > 0) {
      unchecked.push('knowledge lifecycle consistency was checked only against readable records; corrupt lines leave the remaining state unverified');
    }
  }

  // --- experience, feedback, adaptation ----------------------------------------
  // Three separate questions are kept separate here: whether the log parses, whether its
  // records describe a coherent lifecycle (a feedback that assesses a recorded experience, a
  // decision that names a derived adaptation, one live experience per operation), and whether
  // each experience still matches the audit event it names. A well-formed line can disagree
  // with history, and a coherent record can point at an operation that is no longer audited,
  // so neither answer is folded into a record count.
  const experienceHealth = await app.experience.health();
  const captureSetting = captureSettingPhrase(app.experienceCapture);
  if (!experienceHealth.inspected) {
    subsystems.experience = {
      key: 'experience',
      label: 'Experience',
      state: State.UNAVAILABLE,
      summary: `Experience: unavailable (${safeText(experienceHealth.detail)})`,
      detail: experienceHealth.detail,
      count: null,
      experiences: null,
      // The setting is reported even when the store cannot be read: it is configuration, and a
      // reader needs to know whether capture is armed before judging what is missing.
      capture: { mode: app.experienceCapture ?? null, setting: captureSetting },
      recordedByUser: null,
      capturedAutomatically: null,
      unknownCapture: null,
      feedback: null,
      adaptations: null,
      activeAdaptations: null,
      corruptLines: 0,
      conflicts: { scopes: null, adaptations: null },
      lifecycle: { state: 'unavailable', anomalies: null },
      evidence: { state: 'not checked' },
      problems: [],
    };
    unchecked.push('experience, feedback, and adaptation states were not checked because the experience store is unavailable');
    unchecked.push('whether each recorded experience matches its audited operation was not checked because the experience store is unavailable');
  } else {
    const exists = await fileExists(app.experience.filePath);
    const experienceEvidence = await inspectExperienceEvidence(app);
    const lifecycleState = !experienceHealth.complete
      ? 'cannot be fully established (corrupt lines)'
      : experienceHealth.anomalies.count > 0
        ? 'inconsistent'
        : 'consistent';
    let state = State.OK;
    if (experienceHealth.corruptLines > 0) state = State.CORRUPT;
    else if (exists === false) state = State.MISSING;
    const parts = [
      `${experienceHealth.experiences} experience record(s) (${experienceHealth.recordedByUser} recorded by you, ${experienceHealth.capturedAutomatically} captured automatically)`,
      `${experienceHealth.feedback} feedback record(s)`,
      `${experienceHealth.adaptations} adaptation record(s) (${experienceHealth.activeAdaptations} active)`,
    ];
    if (experienceHealth.unknownCapture > 0) {
      parts.push(`${experienceHealth.unknownCapture} experience record(s) whose capture provenance no writer produces`);
    }
    if (experienceHealth.conflicts.scopes > 0) {
      parts.push(`${experienceHealth.conflicts.scopes} conflicting adaptation scope(s)`);
    }
    // The setting is stated in the summary, not only in the JSON: whether APEX writes experiences on
    // its own is the first thing a reader needs to judge these counts.
    const captureClause = `automatic capture ${captureSetting}`;
    const summary = state === State.MISSING
      ? `Experience: missing (valid: no experience, feedback, or adaptation record yet; ${captureClause})`
      : state === State.CORRUPT
        ? `Experience: corrupt (${parts.join(', ')}, ${experienceHealth.corruptLines} corrupt line(s); adaptation states derived only from readable records; ${captureClause})`
        : `Experience: ok (${parts.join(', ')}; lifecycle ${lifecycleState}; ${captureClause})`;
    const problems = corruptLineProblems(path.basename(app.experience.filePath), experienceHealth.corrupt);
    const lifecycleProblems = experienceHealth.anomalies.samples.map(
      (message) => `${path.basename(app.experience.filePath)}: lifecycle: ${message}`,
    );
    if (experienceHealth.anomalies.count > experienceHealth.anomalies.samples.length) {
      lifecycleProblems.push(
        `${path.basename(app.experience.filePath)}: lifecycle: ${experienceHealth.anomalies.count - experienceHealth.anomalies.samples.length} more anomaly(ies) not listed (the health summary carries the exact count)`,
      );
    }
    let evidence;
    if (!experienceEvidence.ok) {
      evidence = { state: 'not checked', detail: experienceEvidence.detail };
      unchecked.push(`whether each recorded experience matches its audited operation was not checked: ${safeText(experienceEvidence.detail)}`);
    } else {
      const r = experienceEvidence.report;
      const unresolved = r.mismatched + r.missingAudit;
      evidence = {
        state: !r.auditReadable ? 'not provable' : unresolved > 0 ? 'inconsistent' : 'consistent',
        checked: r.checked,
        of: r.experiences,
        verified: r.verified,
        mismatched: r.mismatched,
        missingAudit: r.missingAudit,
        auditReadable: r.auditReadable,
        auditCorruptLines: r.auditCorruptLines,
        samples: r.samples.map((s) => ({ experienceId: s.shortId, operationId: safeId(s.operationId), state: s.state, detail: safeText(s.detail) })),
      };
      if (!r.auditReadable) {
        unchecked.push('whether each recorded experience matches its audited operation could not be proven: the audit log could not be read');
      } else {
        if (r.checked < r.experiences) {
          unchecked.push(`whether each recorded experience matches its audited operation was checked for the ${r.checked} newest of ${r.experiences} experience record(s); the rest were not re-checked`);
        }
        for (const s of r.samples) {
          // A disagreement between two readable records is a defect. An experience whose audit
          // record is absent is not proof of invention: the audit log may hold less history than
          // the experience store, which is stated rather than concluded.
          const line = `${path.basename(app.experience.filePath)}: experience [${safeId(s.id)}] names operation [${safeId(s.operationId)}]: ${safeText(s.detail)}`;
          if (s.state === 'mismatch') confirmed.push(line);
          else suspicions.push(`${line}. This does not establish that the operation never ran.`);
        }
        if (unresolved > r.samples.length) {
          unchecked.push(`${unresolved - r.samples.length} further experience evidence problem(s) not listed (the health summary carries the exact counts)`);
        }
      }
    }
    subsystems.experience = {
      key: 'experience',
      label: 'Experience',
      state,
      summary,
      count: experienceHealth.records,
      experiences: experienceHealth.experiences,
      capture: { mode: app.experienceCapture ?? null, setting: captureSetting },
      recordedByUser: experienceHealth.recordedByUser,
      capturedAutomatically: experienceHealth.capturedAutomatically,
      unknownCapture: experienceHealth.unknownCapture,
      feedback: experienceHealth.feedback,
      adaptations: experienceHealth.adaptations,
      candidates: experienceHealth.candidates,
      approved: experienceHealth.approved,
      activeAdaptations: experienceHealth.activeAdaptations,
      ambiguousAdaptations: experienceHealth.ambiguousAdaptations,
      corruptLines: experienceHealth.corruptLines,
      conflicts: { scopes: experienceHealth.conflicts.scopes, adaptations: experienceHealth.conflicts.adaptations },
      lifecycle: {
        state: lifecycleState,
        anomalies: experienceHealth.anomalies.count,
        anomaliesTruncated: experienceHealth.anomalies.truncated,
      },
      evidence,
      problems: [...problems, ...lifecycleProblems],
    };
    if (experienceHealth.corruptLines > 0) {
      unchecked.push('adaptation states were derived only from readable records; corrupt lines leave the remaining state unverified');
    }
  }

  if (session.status === 'corrupt') confirmed.push(`session.json: ${safeText(session.detail)}`);
  confirmed.push(
    ...subsystems.conversation.problems,
    ...subsystems.memory.problems,
    ...subsystems.knowledge.problems,
    ...subsystems.experience.problems,
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
      detail: taskLoadError,
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
    // Execution states are counted separately: a task that was planned, one that ran
    // and was verified, and a step whose outcome is uncertain are different operational
    // facts, and a plain task count does not distinguish them.
    const completedTasks = taskInspect.tasks.filter((t) => t.status === TaskStatus.COMPLETED).length;
    const verifiedSteps = taskInspect.tasks.reduce(
      (n, t) => n + t.steps.filter((s) => s.status === StepStatus.COMPLETED && s.outcome === Outcome.SUCCESS_VERIFIED).length,
      0,
    );
    const uncertainStepCount = taskInspect.tasks.reduce(
      (n, t) => n + t.steps.filter((s) => s.status === StepStatus.UNCERTAIN).length,
      0,
    );
    const taskSummary = `${taskInspect.tasks.length} task(s), ${taskInspect.events} event(s); ${completedTasks} completed, ${verifiedSteps} verified step(s), ${uncertainStepCount} uncertain step(s)`;
    const summary = state === State.MISSING
      ? missingValid('Tasks', 'tasks')
      : state === State.CORRUPT
        ? `Tasks: corrupt (${taskInspect.events} readable event(s), ${taskInspect.tasks.length} recoverable task(s), ${corrupt.length} corrupt line(s), ${replayProblems.length} event(s) that cannot be applied)`
        : `Tasks: ok (${taskSummary})`;
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
    const outcomeCounts = {};
    for (const op of auditInspect.records) {
      outcomeCounts[op.status] = (outcomeCounts[op.status] ?? 0) + 1;
    }
    const outcomeText = Object.entries(outcomeCounts).map(([name, count]) => `${name} ${count}`).join(', ');
    subsystems.audit = {
      key: 'audit',
      label: 'Audit',
      state: auditState,
      summary: auditState === State.MISSING
        ? missingValid('Audit', 'operations')
        : auditState === State.CORRUPT
          ? `Audit: corrupt (${auditInspect.records.length} readable operation(s), ${auditInspect.corrupt.length} corrupt line(s), ${auditProblems.length - auditInspect.corrupt.length} inconsistent record(s))`
          : `Audit: ok (${auditInspect.records.length} operation(s)${outcomeText ? `; ${outcomeText}` : ''}; parse-only, no hash chain or signature)`,
      count: auditInspect.records.length,
      corruptLines: auditInspect.corrupt.length,
      outcomes: outcomeCounts,
      integrity: { mode: 'parse-only', hashChain: false, signature: false, externalAnchor: false },
      problems: auditProblems,
    };
    confirmed.push(...auditProblems);
  } else {
    subsystems.audit = {
      key: 'audit',
      label: 'Audit',
      state: State.UNAVAILABLE,
      summary: `Audit: unavailable (${safeText(auditLoadError)})`,
      detail: auditLoadError,
      count: null,
      corruptLines: 0,
      problems: [],
    };
  }

  // --- deferred task summaries ----------------------------------------------
  // A delivery work list, not evidence. Showing it separates "history refused a summary"
  // from "the summary is still owed", and a corrupt file is stated as damage rather than
  // read as an empty queue.
  let queueEntries = null;
  let queueError = null;
  try {
    queueEntries = await app.summaryQueue.entries();
  } catch (err) {
    queueError = err;
  }
  if (queueError) {
    const corrupt = queueError instanceof StoreError && /corrupt/i.test(queueError.message);
    subsystems.queue = {
      key: 'queue',
      label: 'Queue',
      state: corrupt ? State.CORRUPT : State.UNAVAILABLE,
      summary: corrupt
        ? `Queue: corrupt (${safeText(queueError.message)}; deferred task summaries cannot be read or queued)`
        : `Queue: unavailable (${safeText(queueError.message)}; deferred task summaries cannot be read or queued)`,
      count: null,
      max: MAX_QUEUED_SUMMARIES,
      full: false,
      oldest: null,
      corruptLines: 0,
      problems: [],
    };
    if (corrupt) confirmed.push(`task-summary-queue.json: ${safeText(queueError.message)}`);
  } else {
    const count = queueEntries.length;
    const full = count >= MAX_QUEUED_SUMMARIES;
    subsystems.queue = {
      key: 'queue',
      label: 'Queue',
      state: State.OK,
      summary: count === 0
        ? 'Queue: ok (no deferred task summaries)'
        : `Queue: ${full ? 'full' : 'ok'} (${count}/${MAX_QUEUED_SUMMARIES} deferred task summar${count === 1 ? 'y' : 'ies'}; reissued at the next successful task write${full ? '; a new summary is refused and disclosed rather than displacing one' : ''})`,
      count,
      max: MAX_QUEUED_SUMMARIES,
      full,
      oldest: queueEntries.length > 0 ? queueEntries[0].queuedAt : null,
      corruptLines: 0,
      problems: [],
    };
  }

  // --- locks -----------------------------------------------------------------
  // Read-only. A live holder is normal. A dead claim is normal too: the next write to that
  // store takes it over through the same election that handles a crash. What is not normal is
  // an election with every epoch occupied by an abandoned token, because that refuses
  // every later takeover until the tokens are removed.
  const locks = {};
  for (const [key, store, label] of [
    ['task', app.taskStore, 'Task lock'],
    ['queue', app.summaryQueue, 'Summary queue lock'],
    ['memory', app.memory, 'Memory lock'],
    ['knowledge', app.knowledge, 'Knowledge lock'],
    ['experience', app.experience, 'Experience lock'],
  ]) {
    let report;
    try {
      report = await store.lockReport();
    } catch (err) {
      locks[key] = { key, label, state: State.UNAVAILABLE, detail: errorDetail(err), summary: `${label}: unreadable (${safeText(errorDetail(err))})`, present: null };
      suspicions.push(`${label}: the lock could not be inspected (${safeText(errorDetail(err))}); a write may be refused until it is readable`);
      continue;
    }
    let state = State.OK;
    let summary;
    if (!report.present) {
      summary = `${label}: no claim`;
    } else if (report.error) {
      state = State.UNAVAILABLE;
      summary = `${label}: present but unreadable (${safeText(report.error)}); a write may be refused as "in use by unknown"`;
      suspicions.push(`${label}: present but unreadable (${safeText(report.error)}). Nothing was changed.`);
    } else {
      const holder = report.alive === null
        ? 'holder not identifiable'
        : report.alive
          ? `holder process ${report.pid} is live (liveness only; identity is not checked)`
          : `holder process ${report.pid} has exited (the next normal run takes the claim over)`;
      const t = report.tokens;
      const stuck = t.current >= TAKEOVER_EPOCHS && t.live === 0;
      if (stuck) {
        state = State.CORRUPT;
        summary = `${label}: recovery required - ${t.current} takeover token(s) for this claim (${t.dead} dead, ${t.unknown} unidentified); the next takeover is refused until they are removed`;
        confirmed.push(`${label}: ${t.current} abandoned takeover token(s) block the next takeover (${holder})`);
      } else {
        summary = `${label}: ${holder}; ${t.total} takeover token(s) recorded (${t.current} for this claim)`;
      }
      if (report.guard.present) {
        const guard = report.guard.alive === true
          ? `a recovery by process ${report.guard.pid} is in progress`
          : report.guard.alive === false
            ? `an unfinished recovery claim from process ${report.guard.pid} remains`
            : 'an unreadable recovery claim remains';
        summary = `${summary}; ${guard}`;
      }
    }
    locks[key] = { key, label, ...report, state, summary };
  }
  subsystems.queue.lock = locks.queue;
  subsystems.tasks.lock = locks.task;
  subsystems.memory.lock = locks.memory;
  subsystems.knowledge.lock = locks.knowledge;
  subsystems.experience.lock = locks.experience;


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
  let modelReachable = null;
  if (!describe.configured) {
    modelState = State.NOT_CONFIGURED;
  } else if (!checkModel) {
    modelState = State.NOT_CHECKED;
  } else {
    try {
      const result = await app.gateway.checkAvailability({ timeoutMs: modelTimeoutMs });
      modelReachable = result.reachable ?? null;
      if (result.available && result.modelListed === false) {
        modelState = State.UNCONFIRMED;
        modelDetail = result.detail;
      } else {
        modelState = result.available ? State.OK : State.UNAVAILABLE;
        modelDetail = result.detail;
      }
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
        ? `Model: ok (${safeText(modelDetail)}; model list only - no inference was run)`
        : modelState === State.UNCONFIRMED
          ? `Model: reachable but not confirmed (${safeText(modelDetail)}; model list only - no inference was run)`
          : `Model: unavailable (${safeText(modelDetail)})`;
  subsystems.model = {
    key: 'model',
    label: 'Model',
    state: modelState,
    summary: modelSummary,
    describe,
    detail: modelDetail,
    // True when the endpoint answered the readiness request, even if it could not serve
    // the configured model. It is evidence about the server, not about inference.
    reachable: modelReachable,
    // Readiness probes the model listing, never completion. False says exactly that,
    // so a caller cannot read "available" as "inference was tested".
    inferenceTested: false,
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
  if (byKey('knowledge').lifecycle?.anomalies > 0) {
    recovery.push('Knowledge lifecycle: stored supersession links or retraction events are inconsistent. Run "node bin/apex.js knowledge health" (read-only) and "node bin/apex.js knowledge history <id>". No supported repair command exists; do not rewrite knowledge.jsonl to hide the anomaly.');
  }
  if (byKey('conversation').state === State.CORRUPT) {
    recovery.push('Conversation: no supported repair command exists. Preserve conversation.jsonl. "apex new" starts a new session but does not delete or repair stored turns.');
  }
  if (byKey('experience').state === State.CORRUPT) {
    recovery.push('Experience: no supported repair command exists. Preserve experiences.jsonl; experience, feedback, and adaptation reads and writes stay blocked until it is repaired. An approved adaptation that cannot be read simply does not apply - it is never treated as retired.');
  }
  if (byKey('experience').lifecycle?.anomalies > 0) {
    recovery.push('Experience lifecycle: a feedback, decision, or retirement record names a record that is not present, or two live experiences name one operation. Run "node bin/apex.js experience health" (read-only) for the counts and samples. No supported repair command exists; the historical records are preserved and are corrected by recording a new one, not by editing the log.');
  }
  if (byKey('experience').conflicts?.scopes > 0) {
    recovery.push(`Adaptation conflict: ${byKey('experience').conflicts.scopes} capability scope(s) hold approved rules that disagree. Run "node bin/apex.js adaptation list" to see each one named as conflicting, then retire one rule with "node bin/apex.js adaptation retire <id> --reason ..." yourself. APEX does not choose between rules the user approved.`);
  }
  if (byKey('experience').evidence?.state === 'inconsistent') {
    recovery.push('Experience evidence: a recorded experience no longer matches the audit operation it names. Run "node bin/apex.js experience health" (read-only) for the samples. Both records are preserved; nothing was replayed and no adaptation was changed as a result of this report.');
  }
  if (byKey('tasks').state === State.CORRUPT) {
    recovery.push('Tasks: no supported repair command exists. Preserve tasks.jsonl and do not append to it; task list/show/run/resume/retry/cancel are unavailable until it is repaired.');
  }
  if (byKey('audit').state === State.CORRUPT) {
    recovery.push('Audit: no supported repair command exists. Preserve operations.jsonl; "apex history" skips damaged lines and new operations are still appended, so the audit trail remains incomplete.');
  }
  if (byKey('session').state === State.CORRUPT) {
    recovery.push('Session: "apex new" starts a new session and replaces session.json. Earlier conversation remains stored but is no longer replayed. Do this only if you accept losing the current session pointer.');
  } else if (byKey('session').state === State.MISSING && byKey('session').orphanTurns > 0) {
    recovery.push(`Session: no session pointer exists, but conversation.jsonl holds ${byKey('session').orphanTurns} turn(s). A new session starts on the first request and those turns are not replayed. Preserve conversation.jsonl; there is no command to reattach the lost session pointer.`);
  }
  const unavailable = Object.values(subsystems).filter((s) => s.key !== 'model' && s.state === State.UNAVAILABLE);
  if (unavailable.length > 0) {
    recovery.push(`Storage: ${unavailable.map((s) => s.label).join(', ')} unavailable. Check APEX_DATA_DIR, file permissions, and disk space. APEX does not recreate or truncate data automatically.`);
  }
  if ([locks.task, locks.queue, locks.memory, locks.knowledge, locks.experience].some((lock) => lock?.state === State.CORRUPT)) {
    recovery.push('Locks: abandoned takeover tokens block the next takeover. Run "apex repair locks" after confirming that no task run, queue update, memory write, knowledge write, experience write, or recovery is active. It removes only dead takeover tokens; it never removes a lock claim or displaces a live holder.');
  }
  for (const lock of [locks.task, locks.queue, locks.memory, locks.knowledge, locks.experience]) {
    if (lock?.guard?.present) {
      recovery.push(`${lock.label}: ${lock.guard.alive === true
        ? `a recovery is in progress by process ${lock.guard.pid}`
        : 'an unfinished recovery claim remains'}. Do not delete it while a recovery or task run may be active; "apex repair locks" will name the file if it is what blocks recovery.`);
    }
  }
  if (subsystems.queue.state === State.CORRUPT) {
    recovery.push('Queue: preserve task-summary-queue.json; there is no supported repair command. A corrupt queue blocks only the reissue of unsaved task summaries. The task and audit logs remain the records of what happened.');
  } else if (subsystems.queue.state === State.UNAVAILABLE) {
    recovery.push('Queue: the deferred-summary work list cannot be read. It is not evidence; the task and audit logs remain usable. Check APEX_DATA_DIR and file permissions.');
  } else if (subsystems.queue.full) {
    recovery.push(`Queue: ${subsystems.queue.count}/${MAX_QUEUED_SUMMARIES} deferred task summaries. A new one is refused and disclosed rather than displacing an older one; entries are reissued at the next successful task write. Run "apex queue" to inspect them.`);
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
    if (modelReachable === true) {
      recovery.push(`Model: the endpoint answered, but it could not serve the configured model (${safeText(modelDetail)}). This is not an outage and no inference was tested. Correct the model name you configured, or name a model that endpoint serves, then re-run "apex diagnose --model"; that read-only check is safe. The storage checks above do not depend on the model.`);
    } else {
      // States what the operator can check. APEX does not install, start, or recommend a server, so
      // recovery guidance must not read as permission to obtain one.
      recovery.push('Model: the endpoint you configured did not answer, so no inference was tested. Check that the server you configured is running and reachable at that URL, then re-run "apex diagnose --model"; retrying that read-only check is safe. APEX does not install, start, or recommend a model server. The storage checks above do not depend on the model.');
    }
  } else if (modelState === State.UNCONFIRMED) {
    recovery.push(`Model: the endpoint is reachable but did not list "${safeText(describe.model, 80)}". A request may still work if the server accepts the configured name; this is unconfirmed, not a failure, and no inference was run. Retrying "apex diagnose --model" is safe.`);
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
    locks,
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
  // Not a defect and not a claim: APEX neither inspects nor changes a Git remote, so the
  // report must not be read as evidence about synchronization.
  lines.push('Remote synchronization: not checked (APEX does not inspect or modify a Git remote; this report covers the local data directory only)');
  const modelState = diag.subsystems.model.state;
  const overall = diag.needsAttention
    ? 'attention required'
    : modelState === State.NOT_CHECKED
      ? 'local subsystems healthy; model not checked'
      : modelState === State.NOT_CONFIGURED
        ? 'local subsystems healthy; no model configured'
        : modelState === State.UNCONFIRMED
          ? 'local subsystems healthy; model reachable but not confirmed'
          : 'local subsystems healthy';
  lines.push(`Overall: ${overall}`);
  lines.push('Subsystems:');
  for (const key of ['configuration', 'session', 'conversation', 'memory', 'knowledge', 'experience', 'tasks', 'audit', 'queue', 'model', 'filesystem']) {
    lines.push(`  ${diag.subsystems[key].summary}`);
  }

  lines.push('Locks (read-only):');
  for (const lock of [diag.locks?.task, diag.locks?.queue, diag.locks?.memory, diag.locks?.knowledge, diag.locks?.experience]) {
    if (lock) lines.push(`  ${lock.summary}`);
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
