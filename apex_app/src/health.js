// Unified operational health: one composition of the surfaces each subsystem already exposes.
// Nothing here starts the runtime, polls a provider, calls a model, or invents a record. Reads are
// the same reads each command performs, so a damaged checkpoint is quarantined by the store that
// reads it - preserved, never deleted. The states are deliberately not a score: a subsystem is
// healthy only when a record says so, and a subsystem that could not be read is "unknown", never
// "healthy". A process that started is not evidence that every store parses, every checkpoint
// verifies, or every provider can poll.
import { collectDiagnostics, State, safeText } from './diagnostics.js';
import { truncate } from './util.js';

export const Health = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

// failed > blocked > degraded > unknown > healthy. "Unknown" is above healthy because an
// unreadable store or an unchecked model is not a passing result; it is below degraded because a
// known, explained degradation is more actionable than an absence of information.
const SEVERITY = {
  [Health.HEALTHY]: 0,
  [Health.UNKNOWN]: 1,
  [Health.DEGRADED]: 2,
  [Health.BLOCKED]: 3,
  [Health.FAILED]: 4,
};

export const HEALTH_NOTE = 'Health is read from existing subsystem records. Starting APEX, or reading this view, proves no subsystem healthy by itself; every state names the read it came from. A damaged checkpoint is quarantined by the store that reads it, never deleted.';

function worst(states) {
  return states.reduce((acc, state) => (SEVERITY[state] > SEVERITY[acc] ? state : acc), Health.HEALTHY);
}

function mapDiagnosticState(state) {
  switch (state) {
    case State.OK:
    case State.MISSING:
    case State.NOT_CONFIGURED:
      return Health.HEALTHY;
    case State.CORRUPT:
    case State.UNAVAILABLE:
      return Health.FAILED;
    case State.UNCONFIRMED:
      return Health.DEGRADED;
    case State.NOT_CHECKED:
    default:
      return Health.UNKNOWN;
  }
}

function area(key, label, state, summary, source, extra = {}) {
  return { key, label, state, summary, source, ...extra };
}

function attention(severity, kind, text, source) {
  return { severity, kind, text: truncate(String(text ?? ''), 300), source };
}

function failureDetail(err) {
  return safeText(err?.message ?? String(err));
}

export async function collectHealth(app, { checkModel = false, modelTimeoutMs = 2000 } = {}) {
  const areas = [];
  const attentionItems = [];
  const errors = [];

  // ---- application and its stores ------------------------------------------
  const diag = await collectDiagnostics(app, { checkModel, modelTimeoutMs });
  const storeEntries = Object.entries(diag.subsystems).filter(([key]) => key !== 'model');
  const healthyStores = storeEntries.filter(([, entry]) => mapDiagnosticState(entry.state) === Health.HEALTHY).length;
  const badStores = storeEntries.filter(([, entry]) => [State.CORRUPT, State.UNAVAILABLE].includes(entry.state));
  areas.push(area(
    'application',
    'Application and stores',
    worst(storeEntries.map(([, entry]) => mapDiagnosticState(entry.state))),
    `${healthyStores}/${storeEntries.length} subsystem(s) report a readable record${badStores.length ? `; unreadable or damaged: ${badStores.map(([, entry]) => entry.label).join(', ')}` : ''}`,
    'collectDiagnostics (diagnostics.js)',
    { details: storeEntries.filter(([, entry]) => mapDiagnosticState(entry.state) !== Health.HEALTHY).map(([, entry]) => entry.summary) },
  ));

  const modelEntry = diag.subsystems.model;
  const modelState = mapDiagnosticState(modelEntry.state);
  // Without --model the model is not checked at all; its state is reported but excluded from the
  // overall result, so a healthy local install is not downgraded for a remote read nobody asked for.
  areas.push(area('model', 'Model backend', modelState, modelEntry.summary, 'configuration and optional reachability check', {
    advisory: !checkModel,
  }));

  for (const problem of diag.integrity.confirmed) {
    attentionItems.push(attention(Health.FAILED, 'integrity', problem, 'diagnostics'));
  }
  for (const problem of diag.integrity.suspicions) {
    attentionItems.push(attention(Health.DEGRADED, 'integrity', problem, 'diagnostics'));
  }
  for (const step of diag.taskState.uncertainSteps) {
    attentionItems.push(attention(Health.DEGRADED, 'uncertain-step', `task ${step.taskId} step ${step.stepId} is uncertain: it may have executed, and no action was taken`, 'task log'));
  }
  for (const step of diag.taskState.awaitingApproval) {
    attentionItems.push(attention(Health.BLOCKED, 'approval', `task ${step.taskId} step ${step.stepId} is waiting for your explicit approval; nothing was run`, 'task log'));
  }
  for (const task of diag.taskState.pausedTasks) {
    attentionItems.push(attention(Health.BLOCKED, 'paused-task', `task ${task.id} is paused for a user decision`, 'task log'));
  }
  for (const task of diag.taskState.runningTasks.filter((entry) => entry.live !== true)) {
    attentionItems.push(attention(Health.DEGRADED, 'interrupted-task', `task ${task.id} is recorded as running but no live process holds the task lock; its running step has an unknown outcome`, 'task log and task lock'));
  }

  // ---- runtime lifecycle and checkpoint ------------------------------------
  let runtime = null;
  if (typeof app.runtime?.status !== 'function') {
    areas.push(area('runtime', 'Executive runtime', Health.UNKNOWN, 'no runtime is configured in this application', 'application wiring'));
  } else {
    try {
      runtime = await app.runtime.status();
    } catch (err) {
      errors.push({ area: 'runtime', source: 'runtime.status()', detail: failureDetail(err) });
    }
  }
  if (runtime === null && typeof app.runtime?.status === 'function') {
    areas.push(area('runtime', 'Executive runtime', Health.FAILED, `runtime state could not be read: ${errors.at(-1).detail}`, 'runtime.status()'));
    attentionItems.push(attention(Health.FAILED, 'runtime', `runtime state could not be read: ${errors.at(-1).detail}`, 'runtime.status()'));
  } else if (runtime !== null) {
    let state = Health.HEALTHY;
    let summary;
    if (runtime.corruption) {
      state = Health.FAILED;
      summary = `checkpoint is damaged (${safeText(runtime.corruption.reason)}); the bytes were preserved in quarantine and a fresh checkpoint was started`;
      attentionItems.push(attention(Health.FAILED, 'checkpoint', summary, 'runtime.checkpoint'));
    } else if (runtime.lifecycle === 'running' && !(runtime.lease?.held && runtime.lease?.runtimeId === runtime.runtimeId)) {
      state = Health.BLOCKED;
      summary = runtime.lease?.held
        ? `checkpoint says running, but the lease is held by runtime ${safeText(runtime.lease.runtimeId ?? 'unknown')}, not this one`
        : 'checkpoint says running, but no live process holds the runtime lease; it may have exited without clearing its state';
      attentionItems.push(attention(Health.BLOCKED, 'runtime-lease', summary, 'runtime lease'));
    } else if (runtime.lifecycle === 'starting' || runtime.lifecycle === 'stopping') {
      state = Health.DEGRADED;
      summary = `runtime is ${runtime.lifecycle}; if this persists, a previous process exited mid-transition`;
    } else {
      summary = runtime.lifecycle === 'running'
        ? `running (${runtime.ticks} tick(s), ${runtime.backlog === null ? 'backlog unreadable' : `${runtime.backlog} unprocessed event(s)`})`
        : `not running (${runtime.lifecycle}); events are processed only after an explicit start`;
    }
    if (runtime.paused) {
      state = worst([state, Health.DEGRADED]);
      summary += '; paused, so scheduled work is not being processed';
    }
    if (runtime.deadLetters?.length > 0) {
      state = worst([state, Health.DEGRADED]);
      summary += `; ${runtime.deadLetters.length} dead-lettered event(s)`;
    }
    if (runtime.retries?.length > 0) {
      summary += `; ${runtime.retries.length} retry(ies) pending`;
    }
    if (runtime.lastError) {
      state = worst([state, Health.DEGRADED]);
      summary += `; last error: ${safeText(runtime.lastError)}`;
      errors.push({ area: 'runtime', source: 'runtime.lastError', detail: safeText(runtime.lastError) });
    }
    if (runtime.checkpoint && runtime.backlog !== null && runtime.checkpoint.processedCap > 0 && runtime.backlog > runtime.checkpoint.processedCap) {
      state = worst([state, Health.DEGRADED]);
      summary += `; the backlog exceeds the ${runtime.checkpoint.processedCap}-id checkpoint capacity, so older processed ids will be forgotten`;
    }
    for (const letter of (runtime.deadLetters ?? []).slice(0, 5)) {
      attentionItems.push(attention(Health.DEGRADED, 'dead-letter', `event ${safeText(letter.eventId ?? letter.id ?? 'unknown')} was dead-lettered after its retries were exhausted: ${safeText(letter.reason ?? 'no reason recorded')}`, 'runtime checkpoint'));
    }
    for (const retry of (runtime.retries ?? []).slice(0, 5)) {
      attentionItems.push(attention(Health.DEGRADED, 'retry', `${safeText(retry.key)} will be retried at ${safeText(retry.nextAt ?? 'an unrecorded time')}`, 'runtime checkpoint'));
    }
    areas.push(area('runtime', 'Executive runtime', state, summary, 'runtime.status()'));
  }

  // ---- situational awareness ----------------------------------------------
  let situation = null;
  const hasSituation = typeof app.situation?.status === 'function';
  if (!hasSituation) {
    areas.push(area('situational', 'Situational awareness', Health.UNKNOWN, 'no situational service is configured in this application', 'application wiring'));
  } else {
    try {
      situation = await app.situation.status();
    } catch (err) {
      errors.push({ area: 'situational', source: 'situation.status()', detail: failureDetail(err) });
    }
  }
  if (hasSituation && situation === null) {
    areas.push(area('situational', 'Situational awareness', Health.FAILED, `situational state could not be read: ${errors.at(-1).detail}`, 'situation.status()'));
    attentionItems.push(attention(Health.FAILED, 'situational-log', `situational state could not be read: ${errors.at(-1).detail}`, 'situational log'));
  } else if (situation !== null && situation.available !== true) {
    areas.push(area('situational', 'Situational awareness', Health.FAILED, `situational log is unavailable: ${safeText(situation.detail)}`, 'situation.status()'));
    attentionItems.push(attention(Health.FAILED, 'situational-log', `the situational log is unavailable: ${safeText(situation.detail)}`, 'situational log'));
  } else if (situation !== null && (situation.complete !== true || (situation.corrupt?.length ?? 0) > 0)) {
    const detail = `${situation.corrupt?.length ?? 0} corrupt line(s); reads that present the environment are refused`;
    areas.push(area('situational', 'Situational awareness', Health.FAILED, detail, 'situation.status()'));
    attentionItems.push(attention(Health.FAILED, 'situational-log', `the situational log has damage: ${detail}`, 'situational log'));
  } else if (situation !== null) {
    const counts = situation.counts ?? {};
    let state = Health.HEALTHY;
    let summary = `${counts.events ?? 0} event(s), ${counts.decisions ?? 0} decision(s), ${counts.pendingApprovals ?? 0} pending approval(s)`;
    if ((counts.failedResponses ?? 0) > 0) {
      state = Health.DEGRADED;
      summary += `; ${counts.failedResponses} failed response(s)`;
      attentionItems.push(attention(Health.DEGRADED, 'situational-response', `${counts.failedResponses} situational response(s) are recorded as failed`, 'situational log'));
    }
    if ((counts.pendingApprovals ?? 0) > 0) {
      attentionItems.push(attention(Health.BLOCKED, 'approval', `${counts.pendingApprovals} situational decision(s) are waiting for your approval`, 'situational log'));
    }
    if ((counts.suppressedNotifications ?? 0) > 0) {
      summary += `; ${counts.suppressedNotifications} suppressed notification(s)`;
    }
    areas.push(area('situational', 'Situational awareness', state, summary, 'situation.status()'));
  }

  // ---- external providers --------------------------------------------------
  let integrations = null;
  const hasIntegrations = typeof app.integrations?.status === 'function';
  if (!hasIntegrations) {
    areas.push(area('providers', 'External providers', Health.UNKNOWN, 'no integration fabric is configured in this application', 'application wiring'));
  } else {
    try {
      integrations = await app.integrations.status();
    } catch (err) {
      errors.push({ area: 'providers', source: 'integrations.status()', detail: failureDetail(err) });
    }
  }
  if (hasIntegrations && integrations === null) {
    areas.push(area('providers', 'External providers', Health.FAILED, `provider state could not be read: ${errors.at(-1).detail}`, 'integrations.status()'));
    attentionItems.push(attention(Health.FAILED, 'provider-read', `provider state could not be read: ${errors.at(-1).detail}`, 'integration status'));
  } else if (integrations !== null && integrations.corruption) {
    const detail = `provider configuration or checkpoints are damaged: ${safeText(integrations.corruption.reason ?? 'checksum mismatch')}`;
    areas.push(area('providers', 'External providers', Health.FAILED, detail, 'integrations.status()'));
    attentionItems.push(attention(Health.FAILED, 'provider-config', detail, 'integration configuration'));
  } else if (integrations !== null) {
    const providers = integrations.providers ?? [];
    const enabled = providers.filter((provider) => provider.enabled);
    const failing = enabled.filter((provider) => provider.health?.exhausted === true);
    const retrying = enabled.filter((provider) => provider.health?.exhausted !== true && (provider.health?.consecutiveFailures ?? 0) > 0);
    let state = Health.HEALTHY;
    let summary = enabled.length === 0
      ? `no provider is enabled (${providers.length} defined)`
      : `${enabled.length}/${providers.length} provider(s) enabled; ${integrations.totals?.observed ?? 0} observation(s) observed, ${integrations.totals?.rejected ?? 0} rejected`;
    if (integrations.paused) {
      state = worst([state, Health.DEGRADED]);
      summary += '; polling is paused';
    }
    if (failing.length > 0 || retrying.length > 0) {
      state = worst([state, Health.DEGRADED]);
      summary += `; ${failing.length} exhausted, ${retrying.length} retrying`;
    }
    for (const provider of failing) {
      attentionItems.push(attention(Health.DEGRADED, 'provider', `provider ${provider.id} is exhausted after ${provider.health.consecutiveFailures} consecutive failure(s): ${safeText(provider.health.lastError ?? 'no detail')}`, 'provider health'));
    }
    for (const provider of retrying) {
      attentionItems.push(attention(Health.DEGRADED, 'provider', `provider ${provider.id} has ${provider.health.consecutiveFailures} consecutive failure(s): ${safeText(provider.health.lastError ?? 'no detail')}`, 'provider health'));
    }
    areas.push(area('providers', 'External providers', state, summary, 'integrations.status()'));
  }

  // ---- documents -----------------------------------------------------------
  let documents = null;
  let documentsError = null;
  if (typeof app.documents?.status !== 'function') {
    areas.push(area('documents', 'Document understanding', Health.UNKNOWN, 'no document service is configured in this application', 'application wiring'));
  } else {
    try {
      documents = await app.documents.status();
    } catch (err) {
      documentsError = failureDetail(err);
      errors.push({ area: 'documents', source: 'documents.status()', detail: documentsError });
    }
  }
  if (documents === null && typeof app.documents?.status === 'function') {
    areas.push(area('documents', 'Document understanding', Health.FAILED, `document state could not be read: ${documentsError}`, 'documents.status()'));
    attentionItems.push(attention(Health.FAILED, 'documents', `document state could not be read: ${documentsError}`, 'document configuration'));
  } else if (documents !== null) {
    let state = Health.HEALTHY;
    let summary;
    if (documents.corrupt > 0) {
      state = Health.FAILED;
      summary = `${documents.corrupt} corrupt document record(s); ${documents.documents} record(s) in total`;
      attentionItems.push(attention(Health.FAILED, 'documents', `${documents.corrupt} corrupt document record(s) are preserved and refused`, 'document store'));
    } else if (documents.config.enabled !== true) {
      summary = `content permission ${documents.permission} is not granted; no document content is read`;
    } else {
      summary = `${documents.indexed} indexed, ${documents.failed} failed, ${documents.deleted} invalidated of ${documents.documents} record(s)`;
      if (documents.failed > 0) {
        state = Health.DEGRADED;
        attentionItems.push(attention(Health.DEGRADED, 'documents', `${documents.failed} document(s) failed to ingest; their earlier records are preserved`, 'document store'));
      }
      if (documents.config.paused) {
        state = worst([state, Health.DEGRADED]);
        summary += '; ingestion is paused';
      }
      const last = documents.lastReport;
      if (last && Array.isArray(last.warnings) && last.warnings.length > 0) {
        state = worst([state, Health.DEGRADED]);
        summary += `; the last ingest reported ${last.warnings.length} warning(s)`;
      }
    }
    areas.push(area('documents', 'Document understanding', state, summary, 'documents.status()'));
  }

  // ---- reasoning workspace -------------------------------------------------
  let reasoning = null;
  const hasReasoning = typeof app.reasoning?.status === 'function';
  if (!hasReasoning) {
    areas.push(area('reasoning', 'Reasoning workspace', Health.UNKNOWN, 'no reasoning service is configured in this application', 'application wiring'));
  } else {
    try {
      reasoning = await app.reasoning.status();
    } catch (err) {
      errors.push({ area: 'reasoning', source: 'reasoning.status()', detail: failureDetail(err) });
    }
  }
  if (hasReasoning && reasoning === null) {
    areas.push(area('reasoning', 'Reasoning workspace', Health.FAILED, `reasoning state could not be read: ${errors.at(-1).detail}`, 'reasoning.status()'));
    attentionItems.push(attention(Health.FAILED, 'reasoning-read', `reasoning state could not be read: ${errors.at(-1).detail}`, 'reasoning status'));
  } else if (reasoning !== null && reasoning.corrupt > 0) {
    areas.push(area('reasoning', 'Reasoning workspace', Health.FAILED, `${reasoning.corrupt} corrupt reasoning record(s) preserved; sessions that cite them are refused`, 'reasoning.status()'));
    attentionItems.push(attention(Health.FAILED, 'reasoning', `${reasoning.corrupt} corrupt reasoning record(s) are preserved and refused`, 'reasoning store'));
  } else if (reasoning !== null) {
    let state = Health.HEALTHY;
    let summary = `${reasoning.sessions} session(s), ${reasoning.invalidated} invalidated`;
    if (reasoning.sessions >= reasoning.maxSessions) {
      state = Health.DEGRADED;
      summary += `; the bounded history is full (${reasoning.maxSessions}), so a new session would be refused`;
    }
    areas.push(area('reasoning', 'Reasoning workspace', state, summary, 'reasoning.status()'));
  }

  // ---- world model ---------------------------------------------------------
  let world = null;
  const hasWorld = typeof app.worldModel?.status === 'function';
  if (!hasWorld) {
    areas.push(area('world-model', 'World model', Health.UNKNOWN, 'no world model is configured in this application', 'application wiring'));
  } else {
    try {
      world = await app.worldModel.status();
    } catch (err) {
      errors.push({ area: 'world-model', source: 'worldModel.status()', detail: failureDetail(err) });
    }
  }
  if (hasWorld && world === null) {
    areas.push(area('world-model', 'World model', Health.FAILED, `world-model state could not be read: ${errors.at(-1).detail}`, 'worldModel.status()'));
    attentionItems.push(attention(Health.FAILED, 'world-model', `world-model state could not be read: ${errors.at(-1).detail}`, 'world-model status'));
  } else if (world !== null && world.available !== true) {
    areas.push(area('world-model', 'World model', Health.FAILED, `world-model log is unavailable: ${safeText(world.detail)}`, 'worldModel.status()'));
    attentionItems.push(attention(Health.FAILED, 'world-model', `the world-model log is unavailable: ${safeText(world.detail)}`, 'world-model store'));
  } else if (world !== null && world.complete !== true) {
    areas.push(area('world-model', 'World model', Health.FAILED, `world-model log has damage: ${safeText(world.detail ?? 'reads that present the world are refused')}`, 'worldModel.status()'));
    attentionItems.push(attention(Health.FAILED, 'world-model', 'the world-model log has damage; reads that present the world are refused', 'world-model store'));
  } else if (world !== null) {
    const counts = world.counts ?? {};
    const summary = `${counts.entities ?? 0} entit(ies), ${counts.facts ?? 0} fact(s), ${counts.relationships ?? 0} relationship(s), ${counts.events ?? 0} event(s), ${counts.conflictGroups ?? 0} unresolved conflict group(s)`;
    areas.push(area('world-model', 'World model', Health.HEALTHY, summary, 'worldModel.status()'));
  }

  // ---- learning ------------------------------------------------------------
  let learning = null;
  const hasLearning = typeof app.learning?.status === 'function';
  if (!hasLearning) {
    areas.push(area('learning', 'Outcome learning', Health.UNKNOWN, 'no learning service is configured in this application', 'application wiring'));
  } else {
    try {
      learning = await app.learning.status({ limit: 0 });
    } catch (err) {
      errors.push({ area: 'learning', source: 'learning.status()', detail: failureDetail(err) });
    }
  }
  if (hasLearning && learning === null) {
    areas.push(area('learning', 'Outcome learning', Health.FAILED, `learning state could not be read: ${errors.at(-1).detail}`, 'learning.status()'));
    attentionItems.push(attention(Health.FAILED, 'learning-read', `learning state could not be read: ${errors.at(-1).detail}`, 'learning status'));
  } else if (learning !== null) {
    const summary = `${learning.evaluations.total} evaluation(s), ${learning.adaptations.total} adaptation record(s), ${learning.patterns.total} observed pattern(s)`;
    areas.push(area('learning', 'Outcome learning', Health.HEALTHY, summary, 'learning.status()'));
  }

  // ---- storage and checkpoints --------------------------------------------
  // The same evidence as the areas above, assembled as one answer to "may I trust what I read?".
  // It is a view, not a store: every input is a read another module already performs.
  const damaged = [];
  for (const [key, entry] of storeEntries) {
    if ([State.CORRUPT, State.UNAVAILABLE].includes(entry.state)) damaged.push(`${entry.label}: ${safeText(entry.summary)}`);
  }
  if (runtime?.corruption) damaged.push(`runtime checkpoint: ${safeText(runtime.corruption.reason)} (quarantined, not deleted)`);
  if (hasIntegrations && (integrations === null || integrations.corruption)) {
    damaged.push('provider configuration or checkpoints could not be verified');
  }
  if (hasSituation && (situation === null || situation.available !== true || situation.complete !== true || (situation.corrupt?.length ?? 0) > 0)) {
    damaged.push(situation === null
      ? 'situational log: the status read failed'
      : `situational log: ${situation.available !== true ? safeText(situation.detail) : `${situation.corrupt?.length ?? 0} corrupt line(s)`}`);
  }
  if (hasReasoning && (reasoning === null || reasoning.corrupt > 0)) {
    damaged.push(reasoning === null ? 'reasoning store: the status read failed' : `reasoning: ${reasoning.corrupt} corrupt record(s)`);
  }
  if (hasWorld && (world === null || world.available !== true || world.complete !== true)) {
    damaged.push(world === null ? 'world model: the status read failed' : `world model: ${safeText(world.detail ?? 'corrupt lines')}`);
  }
  if (typeof app.documents?.status === 'function' && (documents === null || documents.corrupt > 0)) {
    damaged.push(documents === null ? 'documents: the status read failed' : `documents: ${documents.corrupt} corrupt record(s)`);
  }
  if (hasLearning && learning === null) damaged.push('outcome learning: the status read failed');
  const uncheckedStorage = diag.integrity.unchecked.filter((entry) => !/model/i.test(entry));
  const storageState = damaged.length > 0 ? Health.FAILED : uncheckedStorage.length > 0 ? Health.UNKNOWN : Health.HEALTHY;
  areas.push(area(
    'storage',
    'Storage and checkpoints',
    storageState,
    damaged.length > 0
      ? `${damaged.length} damaged or unreadable surface(s); every byte was preserved`
      : uncheckedStorage.length > 0
        ? `no damage was found, but ${uncheckedStorage.length} check(s) could not run`
        : 'every store parses, every checkpoint verifies, and no read was refused',
    'diagnostics, runtime checkpoint, integration and document stores',
    { details: damaged },
  ));

  // ---- recent errors -------------------------------------------------------
  for (const error of diag.integrity.confirmed) {
    errors.push({ area: 'application', source: 'diagnostics', detail: error });
  }

  // ---- overall -------------------------------------------------------------
  // Areas that exist only to report an unchecked advisory (the model when --model was not asked
  // for) do not decide the result. Everything else does, and attention items carry their own
  // severity so a healthy store with a blocked decision is not reported as healthy.
  const deciding = areas.filter((entry) => entry.advisory !== true).map((entry) => entry.state);
  const attentionSeverity = attentionItems.map((item) => item.severity);
  const overall = worst([...deciding, ...attentionSeverity]);

  return {
    at: (app.runtime?.now ? app.runtime.now() : new Date()).toISOString(),
    app: diag.app,
    dataDir: diag.dataDir,
    overall,
    areas,
    attention: attentionItems,
    errors,
    counts: {
      healthy: areas.filter((entry) => entry.state === Health.HEALTHY).length,
      degraded: areas.filter((entry) => entry.state === Health.DEGRADED).length,
      blocked: areas.filter((entry) => entry.state === Health.BLOCKED).length,
      failed: areas.filter((entry) => entry.state === Health.FAILED).length,
      unknown: areas.filter((entry) => entry.state === Health.UNKNOWN).length,
    },
    checks: {
      modelChecked: checkModel,
      runtimeRead: runtime !== null,
      situationalRead: situation !== null,
      providersRead: integrations !== null,
      documentsRead: documents !== null,
      reasoningRead: reasoning !== null,
      worldModelRead: world !== null,
      learningRead: learning !== null,
    },
    diagnostics: diag,
  };
}

const MAX_LINES = 220;
const MAX_CHARS = 40000;

export function renderHealth(health) {
  const lines = [];
  lines.push(`${health.app.name} ${health.app.stage} ${health.app.version} (${health.app.expansion}) - operational health`);
  lines.push(`Data directory: ${safeText(health.dataDir)}`);
  const counts = health.counts;
  const breakdown = [
    counts.healthy ? `${counts.healthy} healthy` : null,
    counts.degraded ? `${counts.degraded} degraded` : null,
    counts.blocked ? `${counts.blocked} blocked` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.unknown ? `${counts.unknown} unknown` : null,
  ].filter(Boolean).join(', ');
  lines.push(`Overall: ${health.overall} (${breakdown})`);
  lines.push('');
  lines.push('Areas:');
  for (const entry of health.areas) {
    const advisory = entry.advisory && entry.state === Health.UNKNOWN ? ' [not checked]' : '';
    lines.push(`  ${entry.label}: ${entry.state}${advisory}`);
    lines.push(`    ${entry.summary}`);
    if (entry.state !== Health.HEALTHY || entry.advisory) lines.push(`    source: ${entry.source}`);
    for (const detail of (entry.details ?? []).slice(0, 6)) lines.push(`    detail: ${safeText(detail, 240)}`);
  }
  if (health.attention.length > 0) {
    lines.push('');
    lines.push(`Needs attention (${health.attention.length}):`);
    for (const item of health.attention.slice(0, 40)) {
      lines.push(`  - [${item.severity}] ${safeText(item.text, 300)}`);
      lines.push(`    source: ${item.source}`);
    }
    if (health.attention.length > 40) lines.push(`  - ... and ${health.attention.length - 40} more; run "apex work" or "apex diagnose" for the full record list`);
  }
  if (health.errors.length > 0) {
    lines.push('');
    lines.push('Read errors:');
    for (const error of health.errors.slice(0, 20)) lines.push(`  - ${safeText(error.area)} (${safeText(error.source)}): ${safeText(error.detail)}`);
  }
  lines.push('');
  lines.push(HEALTH_NOTE);
  lines.push('This view starts nothing, polls nothing, and calls no model; it adds no record of its own.');

  const truncated = lines.length > MAX_LINES;
  const shown = truncated ? lines.slice(0, MAX_LINES) : lines;
  let display = shown.join('\n');
  if (display.length > MAX_CHARS) display = truncate(display, MAX_CHARS);
  if (truncated) display += `\n[health view cut at ${MAX_LINES} lines; run "apex diagnose" for the store detail]`;
  return display;
}
