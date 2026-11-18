// Feasibility: where each task of a proposed plan stands against the live registry and the plan as
// it would be recorded.
//
// Six classes, each with the reason it was reached:
//   completed        the caller supplied a verified operation record for this step
//   ready            registered, plannable, authorized for the origin that would run it, inputs
//                    accepted, and every dependency is itself ready or completed
//   needs_approval   otherwise ready, but no approval binds the bytes of this plan yet
//   blocked          a dependency is unsupported, needs input, or itself blocked; or the request
//                    excluded the capability the step names
//   needs_input      no registered action carries this part, but nearby actions share its words, so
//                    a rewording or a missing input may make it executable
//   unsupported      no registered action matches, the action is absent, may not be a plan step, or
//                    the registry refuses it for the origin that would run it
//
// The classifier reads; it does not decide whether a plan may run. Approval and the runner's own
// revalidation remain the gates, and this module never adds one of its own.
export const FEASIBILITY_SCHEMA = 'apex.planning-feasibility.v1';

export const TASK_CLASSES = Object.freeze([
  'completed', 'ready', 'needs_approval', 'blocked', 'needs_input', 'unsupported',
]);

export const CLASS_NOTE = Object.freeze({
  completed: 'a verified operation record was supplied for this step',
  ready: 'the registry, the origin, the input, and every dependency allow this step; the plan still has to be approved and started',
  needs_approval: 'everything the step itself needs is in place, but no approval binds the content of this plan',
  blocked: 'the step cannot be taken up while what it depends on stands as it does',
  needs_input: 'no registered action carries this part, and the nearby matches are a word lookup rather than a capability',
  unsupported: 'nothing in this configuration can carry this task, so it is named rather than concealed',
});

function cycleMembers(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const cycle = new Set();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      const at = trail.indexOf(id);
      for (const member of trail.slice(at)) cycle.add(member);
      return;
    }
    const task = byId.get(id);
    if (!task) return;
    state.set(id, 'open');
    for (const dep of task.dependsOn ?? []) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id, []);
  return cycle;
}

function registryEvidence(registry, task) {
  const def = registry.get(task.action);
  const user = registry.authorize(task.action, 'user');
  return {
    registered: Boolean(def),
    plannable: def ? def.plannable !== false : false,
    permission: def?.permission ?? null,
    userDecision: user.decision,
    userReason: user.reason,
    hasVerifier: typeof def?.verify === 'function',
  };
}

// A task is executable only when nothing about the step itself stands in the way. The dependency
// and approval gates are applied after this, so the class says which gate was reached.
function stepObstacle(registry, task) {
  const evidence = registryEvidence(registry, task);
  if (!evidence.registered) {
    return { cls: 'unsupported', because: `the action ${task.action} is not registered in this configuration`, evidence };
  }
  if (!evidence.plannable) {
    return {
      cls: 'unsupported',
      because: `the registry marks ${task.action} as an action that may never appear as a plan step`,
      evidence,
    };
  }
  if (evidence.userDecision !== 'allow') {
    return {
      cls: 'unsupported',
      because: `the registry refuses ${task.action} for the user origin that would run it: ${evidence.userReason}`,
      evidence,
    };
  }
  return { cls: null, because: null, evidence };
}

export function classifyTasks({ tasks, registry, approval = null } = {}) {
  if (!Array.isArray(tasks)) throw new TypeError('classifyTasks requires the tasks of the proposed plan');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('classifyTasks requires the live action registry');
  const cycles = cycleMembers(tasks);
  const approvalBound = approval?.bound === true;
  const state = new Map();
  const rows = [];

  for (const task of tasks) {
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    let cls;
    let because;
    let blockedBecause = null;
    let blockedBy = [];
    let evidence = {};

    if (task.completed?.ref) {
      cls = 'completed';
      because = `a verified operation record was supplied for this step (${task.completed.ref})`;
    } else if (task.kind === 'unmapped' || !task.action) {
      const nearby = task.nearby ?? [];
      cls = nearby.length > 0 ? 'needs_input' : 'unsupported';
      because = nearby.length > 0
        ? `${task.reason}; ${nearby.length} registered action(s) share its words, but none was asked to accept this input`
        : `${task.reason}; nothing registered can carry it`;
      evidence = { nearby: nearby.map((n) => n.action) };
    } else if (task.excludedByRequest) {
      cls = 'blocked';
      because = `the request asked this read not to offer ${task.action}, so a plan that honors the request cannot carry it`;
      blockedBecause = 'excluded by the request';
      evidence = registryEvidence(registry, task);
    } else {
      const obstacle = stepObstacle(registry, task);
      evidence = obstacle.evidence;
      if (obstacle.cls) {
        cls = obstacle.cls;
        because = obstacle.because;
      } else if (cycles.has(task.id)) {
        cls = 'blocked';
        because = 'this step is part of a dependency cycle, so no order would ever make it runnable';
        blockedBy = deps.slice();
        blockedBecause = 'dependency cycle';
      } else {
        const missing = deps.filter((d) => !state.has(d));
        const stopped = deps.filter((d) => {
          const s = state.get(d);
          return s && s.class !== 'completed' && s.class !== 'ready' && s.class !== 'needs_approval';
        });
        if (missing.length > 0) {
          cls = 'blocked';
          blockedBy = missing;
          blockedBecause = `depends on ${missing.join(', ')}, which this plan does not record`;
          because = blockedBecause;
        } else if (stopped.length > 0) {
          cls = 'blocked';
          blockedBy = stopped;
          blockedBecause = `depends on ${stopped.map((d) => `${d} (${state.get(d).class})`).join(', ')}`;
          because = `cannot be run while ${blockedBecause}`;
        } else if (!approvalBound) {
          cls = 'needs_approval';
          because = approval?.why ?? 'no approval binds the content of this plan yet, so no step runs';
        } else {
          cls = 'ready';
          because = 'the registry, the origin, the input, and every dependency allow this step';
        }
      }
    }

    const row = {
      id: task.id,
      kind: task.kind ?? 'step',
      action: task.action ?? null,
      class: cls,
      because,
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      ...(blockedBecause ? { blockedBecause } : {}),
      evidence,
    };
    state.set(task.id, row);
    rows.push(row);
  }

  const counts = Object.fromEntries(TASK_CLASSES.map((c) => [c, 0]));
  for (const row of rows) counts[row.class] += 1;
  const eligible = rows.filter((r) => r.class === 'ready' || r.class === 'needs_approval' || r.class === 'completed').length;

  return {
    schema: FEASIBILITY_SCHEMA,
    classes: [...TASK_CLASSES],
    note: CLASS_NOTE,
    approval: {
      planLevel: true,
      bound: approvalBound,
      why: approval?.why ?? 'this read records nothing, so no approval binds any plan content',
      gate: 'every step of a plan stops at the same plan-level approval; there is no per-step approval that this read could grant',
    },
    counts: { ...counts, eligible },
    rows,
    cycles: [...cycles].sort(),
    statement: `${counts.unsupported + counts.needs_input} task(s) cannot be taken as they stand, `
      + `${counts.blocked} are blocked on what they depend on, ${counts.needs_approval} wait on approval, `
      + `${counts.ready} are ready, and ${counts.completed} have a verified record`,
  };
}
