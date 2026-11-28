// T-34 Step 3 (2026-11-19): the reading a briefing checkpoint stores.
//
// One implementation, used by the acknowledge action and by the delta the briefing route computes, so
// the two can never disagree about what "changed" means. Every field comes from an owning store; a
// store that cannot be read is named in `unavailable` and contributes `null` rather than zero, because
// "could not be read" and "empty" are different readings.
export async function collectBriefingSnapshot({ taskStore = null, perception = null, workshop = null, evolution = null, cognition = null } = {}) {
  const unavailable = [];
  const snapshot = {
    taskStatuses: null,
    taskCount: null,
    advisories: null,
    lastObservationAt: null,
    observedCount: null,
    runStatuses: null,
    runCount: null,
    workshopVerifications: null,
    evolutionVerifications: null,
    unavailable,
  };

  if (taskStore && typeof taskStore.list === 'function') {
    try {
      const tasks = await taskStore.list();
      const rows = Array.isArray(tasks) ? tasks : [];
      snapshot.taskStatuses = Object.fromEntries(rows.filter((task) => task && typeof task.id === 'string')
        .map((task) => [task.id, String(task.status ?? 'unknown')]));
      snapshot.taskCount = rows.length;
    } catch {
      unavailable.push('TaskStore');
    }
  } else {
    unavailable.push('TaskStore');
  }

  if (perception && typeof perception.state === 'function') {
    try {
      const view = perception.state({ limit: 1 });
      snapshot.advisories = (view.alerts?.advisories ?? []).map((entry) => entry.alertClass).filter((entry) => typeof entry === 'string');
      snapshot.lastObservationAt = typeof view.lastObservationAt === 'string' ? view.lastObservationAt : null;
      snapshot.observedCount = Number.isSafeInteger(view.observedCount) ? view.observedCount : null;
    } catch {
      unavailable.push('Perception');
    }
  } else {
    unavailable.push('Perception');
  }

  if (cognition && typeof cognition.list === 'function') {
    try {
      const page = await cognition.list({ limit: 50 });
      const runs = Array.isArray(page?.runs) ? page.runs : [];
      snapshot.runStatuses = Object.fromEntries(runs.filter((run) => run && typeof run.runId === 'string')
        .map((run) => [run.runId, String(run.status ?? 'unknown')]));
      snapshot.runCount = Number.isSafeInteger(page?.total) ? page.total : runs.length;
    } catch {
      unavailable.push('Cognition');
    }
  } else {
    unavailable.push('Cognition');
  }

  if (workshop && typeof workshop.status === 'function') {
    try {
      const status = await workshop.status();
      snapshot.workshopVerifications = Number.isSafeInteger(status?.verifications) ? status.verifications : null;
    } catch {
      unavailable.push('Workshop');
    }
  } else {
    unavailable.push('Workshop');
  }

  if (evolution && typeof evolution.list === 'function') {
    try {
      const page = await evolution.list();
      const proposals = Array.isArray(page?.proposals) ? page.proposals : [];
      snapshot.evolutionVerifications = proposals.filter((proposal) => proposal?.sandbox?.verified === true).length;
    } catch {
      unavailable.push('Evolution Lab');
    }
  } else {
    unavailable.push('Evolution Lab');
  }

  return snapshot;
}
