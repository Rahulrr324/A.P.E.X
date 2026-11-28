// T-45 Package 1 (2026-11-19): the Executive Playbooks engine.
//
// A Playbook is a named, curated routine made of steps whose order is not a list but a graph. The brief
// asks for three of them, and all three have the same shape on purpose: two roots that do not depend on
// each other, then one step that depends on both. That shape is the interesting one, because it is where
// a routine stops being a script.
//
// The difference matters. A script that runs doctor, then git status, then the agenda will run the agenda
// even when the doctor found the data directory unreadable - it has no way to say "that answer is not
// good enough to build on". A DAG can say it: the fan-in step is *dependent*, so a root that did not
// verify stops the work that would have leaned on it, and the record says `skipped` rather than pretending.
//
// Four rules govern this module, and the rest of the file is their consequences:
//
//   1. **Every step is a real capability, authorized by the ECP.** A Playbook cannot do anything a person
//      could not have typed: each step names a registered capability, and each one runs through the same
//      controller path a route or a router line takes. The Playbook composes; it does not execute.
//   2. **The template is checked against the registry, not against a comment.** A template step that names
//      a capability which has been un-registered, or whose declarations have become unsafe, is a broken
//      template - and the engine refuses to build a run from it rather than launching and failing halfway.
//   3. **Dependency order is enforced from the recorded results, not from the schedule.** The fan-in step
//      runs only if both of its dependencies are present in the run's own results with `verified: true`.
//      A step whose dependency failed is recorded `skipped`, which is a different thing from `failed`: one
//      says the work was not attempted, the other says it was attempted and did not hold.
//   4. **Lockdown halts before the first step.** The latch is read at the door. A run that is refused
//      writes no run record, because a run that never started is not a run that halted.
//
// A note on what a Playbook is *not*. It is not a Standing Order. A standing order is a delegation that
// waits for an event and needs nobody present; a Playbook is a routine the owner launches, right now, and
// watches. That is why a Playbook has no trigger and no cooldown, and why launching one is an L2 Confirm
// act rather than an L3 delegation. The two features share the execution path and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PLAYBOOKS_SCHEMA = 'apex.executive.playbooks/1';
export const PLAYBOOK_RUN_SCHEMA = 'apex.executive.playbook-run/1';
export const PLAYBOOK_TEMPLATE_SCHEMA = 'apex.executive.playbook-template/1';

export const PLAYBOOK_CODES = Object.freeze({
  PLAYBOOK_NOT_FOUND: 'PLAYBOOK_NOT_FOUND',
  PLAYBOOK_TEMPLATE_BROKEN: 'PLAYBOOK_TEMPLATE_BROKEN',
  LOCKDOWN_ACTIVE: 'LOCKDOWN_ACTIVE',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  EXECUTION_REFUSED: 'EXECUTION_REFUSED',
  INVALID_INPUT: 'INVALID_INPUT',
});

// The three built-in routines. Each step carries everything the engine needs to decide whether it may run
// and what to call when it does - no step is identified by its position in an array, because position is
// the one thing a reordering silently changes.
//
// `dependsOn` is the graph. An empty list is a root; anything else names the steps that must have verified
// first. The engine does not care that both templates happen to be two-then-one; it reads the edges.
export const PLAYBOOK_TEMPLATES = Object.freeze([
  Object.freeze({
    playbookId: 'morning_briefing',
    title: 'Morning Executive Sweep',
    summary: 'Take the day\'s first reading: is the system healthy, is the repository dirty, and what is owed today - in that order, with the agenda held until both readings agree.',
    steps: Object.freeze([
      Object.freeze({
        stepId: 'doctor',
        label: 'Verify the environment',
        capabilityId: 'system.doctor',
        dependsOn: Object.freeze([]),
        input: Object.freeze({}),
      }),
      Object.freeze({
        stepId: 'repository',
        label: 'Inspect the repository',
        capabilityId: 'git.status_detailed',
        dependsOn: Object.freeze([]),
        input: Object.freeze({}),
      }),
      Object.freeze({
        stepId: 'agenda',
        label: 'Compile the agenda',
        capabilityId: 'agenda.list',
        dependsOn: Object.freeze(['doctor', 'repository']),
        input: Object.freeze({}),
      }),
    ]),
  }),
  Object.freeze({
    playbookId: 'workspace_security_audit',
    title: 'Workspace & Port Overwatch Audit',
    summary: 'Read the host\'s exposure and its own footprint, then capture the workspace\'s file hygiene once both host readings are in.',
    steps: Object.freeze([
      Object.freeze({
        stepId: 'ports',
        label: 'Inspect listening ports',
        capabilityId: 'system.inspect_ports',
        dependsOn: Object.freeze([]),
        input: Object.freeze({}),
      }),
      Object.freeze({
        stepId: 'processes',
        label: 'Inspect host processes',
        capabilityId: 'system.inspect_processes',
        dependsOn: Object.freeze([]),
        input: Object.freeze({}),
      }),
      Object.freeze({
        stepId: 'workspace',
        label: 'Capture workspace hygiene',
        capabilityId: 'git.status_detailed',
        dependsOn: Object.freeze(['ports', 'processes']),
        input: Object.freeze({}),
      }),
    ]),
  }),
  Object.freeze({
    playbookId: 'pre_release_readiness',
    title: 'Pre-Release Verification Sweep',
    summary: 'Before a release: the environment, every standing order\'s own trigger evaluation, and the current working-tree diff - the last held until the first two verify.',
    steps: Object.freeze([
      Object.freeze({
        stepId: 'doctor',
        label: 'Verify the environment',
        capabilityId: 'system.doctor',
        dependsOn: Object.freeze([]),
        input: Object.freeze({}),
      }),
      Object.freeze({
        stepId: 'standing_orders',
        label: 'Evaluate standing orders',
        capabilityId: 'standing_order.evaluate',
        dependsOn: Object.freeze([]),
        input: Object.freeze({ eventType: 'session_start' }),
      }),
      Object.freeze({
        stepId: 'diff',
        label: 'Capture the working-tree diff',
        capabilityId: 'git.diff_inspect',
        dependsOn: Object.freeze(['doctor', 'standing_orders']),
        input: Object.freeze({}),
      }),
    ]),
  }),
]);

export const PLAYBOOK_IDS = Object.freeze(PLAYBOOK_TEMPLATES.map((template) => template.playbookId));

// The two declarations every Playbook step's capability must carry. This is the same line the Standing
// Orders engine draws, for the same reason: a routine that runs with nobody reading each step may only
// be built from capabilities that cannot do anything that needs a person's judgement.
const REQUIRED_REVERSIBILITY = Object.freeze(['reversible', 'read_only']);
const REQUIRED_BLAST_RADIUS = Object.freeze(['local_state', 'none']);

function refused(code, message, detail = {}, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.detail = detail;
  return error;
}

function plainText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw refused(PLAYBOOK_CODES.INVALID_INPUT, `${label} must be a string`, {}, 400);
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoOrNull(value) {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// Why a capability may not carry a Playbook step, read from its declaration. Empty means it may.
export function playbookStepRefusalReasons(definition) {
  if (!definition || typeof definition !== 'object') {
    return ['no capability with that name is registered, so the step has nothing to run'];
  }
  const reasons = [];
  const name = definition.name ?? '(unnamed)';
  if (!REQUIRED_REVERSIBILITY.includes(definition.reversibility)) {
    reasons.push(`${name} declares reversibility ${definition.reversibility ?? 'nothing'}; a Playbook step may only run a capability that declares itself reversible or read_only`);
  }
  if (!REQUIRED_BLAST_RADIUS.includes(definition.blastRadius)) {
    reasons.push(`${name} has blastRadius ${definition.blastRadius ?? 'nothing'}; a Playbook step may only run one whose blast radius is local_state or none`);
  }
  if (definition.risk === 'high' || definition.risk === 'critical') {
    reasons.push(`${name} is declared ${definition.risk} risk, which no Playbook step may carry`);
  }
  return [...new Set(reasons)];
}

// The shape of one template as the API and the panel read it, including the DAG the panel draws. The
// `dependsOn` lists are copied rather than referenced, so a caller cannot reach into the frozen template.
export function describeTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  return {
    schema: PLAYBOOK_TEMPLATE_SCHEMA,
    playbookId: template.playbookId,
    title: template.title,
    summary: template.summary,
    stepCount: template.steps.length,
    steps: template.steps.map((step) => ({
      stepId: step.stepId,
      label: step.label,
      capabilityId: step.capabilityId,
      dependsOn: [...step.dependsOn],
    })),
    // The shape stated as data rather than left for a reader to infer: which steps are roots, what the
    // fan-in step waits for. The panel draws from this and cannot disagree with the engine.
    roots: template.steps.filter((step) => step.dependsOn.length === 0).map((step) => step.stepId),
    fanIn: template.steps.filter((step) => step.dependsOn.length > 1)
      .map((step) => ({ stepId: step.stepId, dependsOn: [...step.dependsOn] })),
    verified: true,
  };
}

export class ExecutivePlaybooks {
  #file;
  #dataDir;
  #registry;
  #now;
  #idFactory;
  #operations;
  #lockdown;
  #controller;

  constructor({
    dataDir,
    registry,
    controlPlane = null,
    now = () => new Date(),
    idFactory = randomUUID,
    operations = null,
    lockdown = null,
    controller = null,
  } = {}) {
    if (!dataDir) throw new TypeError('ExecutivePlaybooks requires a data directory');
    this.#dataDir = dataDir;
    this.#file = path.join(dataDir, 'playbook-runs.json');
    this.#registry = registry ?? null;
    // The latch is read through the injected reader when one is given, so a test can hold it still. The
    // default reads the registry's control plane, which is the same latch every other gate reads.
    this.#lockdown = typeof lockdown === 'function'
      ? lockdown
      : () => (controlPlane ?? this.#registry?.controlPlane)?.killSwitchStatus?.().active === true;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#operations = operations;
    this.#controller = controller;
  }

  // The controller is created after the registry, because the controller needs the registry to authorize.
  // Until it is attached, a launch refuses rather than running steps it could not audit.
  attachController(controller) {
    this.#controller = controller ?? null;
    return this;
  }

  lockdownActive() {
    try {
      return this.#lockdown() === true;
    } catch {
      // A latch that cannot be read is a latch that might be up. Failing closed is the only safe reading.
      return true;
    }
  }

  // ------------------------------------------------------------------ persistence, failure-safe ---
  //
  // Read on every operation rather than cached, for the reason the Standing Orders engine gives: two
  // instances disagreeing about what ran, silently, is worse than a small file read.

  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { present: false, corrupt: false, runs: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { present: true, corrupt: true, runs: [] };
    }
    if (!parsed || !Array.isArray(parsed.runs)) return { present: true, corrupt: true, runs: [] };
    const runs = parsed.runs.filter((entry) => entry && typeof entry === 'object' && typeof entry.runId === 'string');
    return { present: true, corrupt: runs.length !== parsed.runs.length, runs: runs.map((entry) => this.#normalise(entry)) };
  }

  #write(runs) {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const payload = {
      schema: PLAYBOOKS_SCHEMA,
      at: this.#now().toISOString(),
      runs: runs.map((entry) => ({ ...entry })),
    };
    // Write-then-rename, so a crash mid-write leaves the previous ledger intact rather than a truncated
    // file that reads as corrupt and hides every run behind one bad byte.
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, this.#file);
  }

  // A stored run is rebuilt into the authoritative shape on read, so a hand-edited file cannot smuggle an
  // extra field into the record the routes return.
  #normalise(entry) {
    const statuses = ['verified', 'failed', 'halted_by_lockdown'];
    const stepStatuses = ['verified', 'failed', 'skipped'];
    return {
      schema: PLAYBOOK_RUN_SCHEMA,
      runId: String(entry.runId),
      playbookId: PLAYBOOK_IDS.includes(entry.playbookId) ? entry.playbookId : String(entry.playbookId ?? ''),
      title: typeof entry.title === 'string' ? entry.title.slice(0, 160) : '',
      launchedAt: isoOrNull(entry.launchedAt) ?? this.#now().toISOString(),
      completedAt: isoOrNull(entry.completedAt) ?? isoOrNull(entry.launchedAt) ?? this.#now().toISOString(),
      status: statuses.includes(entry.status) ? entry.status : 'failed',
      steps: Array.isArray(entry.steps) ? entry.steps.map((step) => ({
        stepId: String(step?.stepId ?? ''),
        label: typeof step?.label === 'string' ? step.label.slice(0, 120) : '',
        capabilityId: String(step?.capabilityId ?? ''),
        dependsOn: Array.isArray(step?.dependsOn) ? step.dependsOn.filter((id) => typeof id === 'string') : [],
        status: stepStatuses.includes(step?.status) ? step.status : 'failed',
        operationId: typeof step?.operationId === 'string' ? step.operationId : null,
        summary: typeof step?.summary === 'string' ? step.summary.slice(0, 400) : '',
        verified: step?.verified === true,
      })) : [],
      verified: entry.verified === true,
    };
  }

  // ---------------------------------------------------------------- the template, checked ---

  // The template as it will actually be launched, with every step's capability checked against the
  // registry's current declarations. A broken template is refused before the first step: launching and
  // discovering the problem on step three would leave a half-run in the ledger that says nothing about
  // why it stopped.
  #checkedTemplate(playbookId) {
    const wanted = String(playbookId ?? '').trim();
    const template = PLAYBOOK_TEMPLATES.find((entry) => entry.playbookId === wanted);
    if (!template) {
      throw refused(PLAYBOOK_CODES.PLAYBOOK_NOT_FOUND,
        `no playbook named ${wanted === '' ? '(nothing)' : wanted.slice(0, 60)}`,
        { playbookId: wanted, known: [...PLAYBOOK_IDS] }, 404);
    }
    if (!this.#registry || typeof this.#registry.get !== 'function') {
      throw refused(PLAYBOOK_CODES.PLAYBOOK_TEMPLATE_BROKEN,
        'no registry is configured, so no step can be authorized', { playbookId: template.playbookId }, 500);
    }
    const broken = [];
    for (const step of template.steps) {
      const definition = this.#registry.get(step.capabilityId);
      // An un-registered capability is a step this build cannot run, not a template that has become
      // unsafe. The difference matters: a build with no workspace root has no `git.status_detailed`, and
      // the morning sweep must still launch there - reporting that one reading as unavailable rather
      // than refusing to read anything at all. The step is recorded `skipped` with the reason.
      if (!definition) continue;
      const reasons = playbookStepRefusalReasons(definition);
      if (reasons.length > 0) broken.push({ stepId: step.stepId, capabilityId: step.capabilityId, reasons });
    }
    if (broken.length > 0) {
      throw refused(PLAYBOOK_CODES.PLAYBOOK_TEMPLATE_BROKEN,
        `playbook ${template.playbookId} names ${broken.length} capability that may not carry a step`,
        { playbookId: template.playbookId, broken }, 409);
    }
    // A dependency that names a step that does not exist is a template that cannot run, and the failure
    // would otherwise appear as a step that silently never runs.
    const known = new Set(template.steps.map((step) => step.stepId));
    for (const step of template.steps) {
      for (const dependency of step.dependsOn) {
        if (!known.has(dependency)) {
          throw refused(PLAYBOOK_CODES.PLAYBOOK_TEMPLATE_BROKEN,
            `step ${step.stepId} depends on ${dependency}, which is not a step of ${template.playbookId}`,
            { playbookId: template.playbookId, stepId: step.stepId, dependsOn: dependency }, 409);
        }
      }
    }
    return template;
  }

  // ------------------------------------------------------------------------------- reading ---

  // The catalog and the runs, in one answer, with the summary the panel's badges read. A build with no
  // workspace root still gets three templates and a 200: the templates are constants, and a run that
  // failed because there is no repository is a run the owner can read, not an absent page.
  catalog() {
    const { present, corrupt, runs } = this.#read();
    return {
      schema: PLAYBOOKS_SCHEMA,
      verified: true,
      lockdownActive: this.lockdownActive(),
      ledger: { present, corrupt },
      templates: PLAYBOOK_TEMPLATES.map(describeTemplate),
      runs: [...runs].reverse(),
      summary: {
        templateCount: PLAYBOOK_TEMPLATES.length,
        totalRuns: runs.length,
        verifiedRuns: runs.filter((run) => run.status === 'verified').length,
        failedRuns: runs.filter((run) => run.status === 'failed' || run.status === 'halted_by_lockdown').length,
      },
    };
  }

  // One run, with each step's operation resolved against `operations.jsonl` when a reader is available.
  // A step whose operation is missing says so; it is never reported as though the receipt existed.
  detail(runId) {
    const wanted = String(runId ?? '').trim();
    const { runs } = this.#read();
    const run = runs.find((entry) => entry.runId === wanted);
    return run ?? null;
  }

  // A validation a route can call before it spends an authorization. It answers the two questions whose
  // answers have their own codes - does this id exist, and is the system stopped - without running a step.
  //
  // It is deliberately NOT an authorization: it grants nothing and the launch below re-checks both. Its
  // purpose is that a refusal reaches the owner with the code that describes it. Without this, Lockdown
  // would answer `403 KILL_SWITCH_ACTIVE` from the ECP before the engine's own gate was ever reached, which
  // is a true refusal but not the one the brief names.
  precheck(playbookId) {
    if (this.lockdownActive()) {
      throw refused(PLAYBOOK_CODES.LOCKDOWN_ACTIVE,
        'Lockdown is engaged, so no playbook may be launched; release the latch before launching one',
        { lockdownActive: true }, 423);
    }
    return describeTemplate(this.#checkedTemplate(playbookId));
  }

  // ------------------------------------------------------------------------------ launching ---

  // Launch one Playbook. Every step goes through `controller.runAction`, which is the same entry point a
  // route or a router line takes: the ECP authorizes it, the registry validates it, the capability runs,
  // and its own verifier decides whether it verified. There is deliberately no second path.
  async launch(playbookId, { reason = 'launched from the owner surface' } = {}) {
    // Lockdown is read first, before the template is even resolved, so a stopped system refuses a bad id
    // with the gate's answer rather than the id's.
    if (this.lockdownActive()) {
      throw refused(PLAYBOOK_CODES.LOCKDOWN_ACTIVE,
        'Lockdown is engaged, so no playbook may be launched; release the latch before launching one',
        { lockdownActive: true }, 423);
    }
    const template = this.#checkedTemplate(playbookId);
    if (!this.#controller || typeof this.#controller.runAction !== 'function') {
      throw refused(PLAYBOOK_CODES.EXECUTION_REFUSED,
        'no controller is configured, so the steps cannot be run through the ECP', { playbookId: template.playbookId }, 500);
    }

    const runId = `pbr_${this.#idFactory().replace(/-/g, '').slice(0, 16)}`;
    const launchedAt = this.#now().toISOString();
    const reasonText = plainText(reason, 240, 'reason');

    // The results, keyed by step id. Dependency order is decided from THIS map - a step's dependencies are
    // checked against what actually verified, not against the order the loop happened to take.
    const results = new Map();
    const stepRecords = [];
    const pending = [...template.steps];

    while (pending.length > 0) {
      // Pick the first step whose dependencies are all resolved. Templates are small and ordered, so a
      // linear scan is both correct and the clearest thing to read.
      const index = pending.findIndex((step) => step.dependsOn.every((dependency) => results.has(dependency)));
      if (index === -1) {
        // No step can run and none is left that could: a cycle, or a dependency that will never resolve.
        // The template check above makes this unreachable for the built-ins; it is here because an
        // unreachable branch that returns a recorded failure is better than a loop that never ends.
        for (const step of pending) {
          stepRecords.push(this.#stepRecord(step, {
            status: 'skipped', operationId: null, verified: false,
            summary: 'the step was never reached: its dependencies could not be ordered',
          }));
        }
        break;
      }
      const [step] = pending.splice(index, 1);

      const blockedBy = step.dependsOn.filter((dependency) => results.get(dependency)?.verified !== true);
      if (blockedBy.length > 0) {
        stepRecords.push(this.#stepRecord(step, {
          status: 'skipped', operationId: null, verified: false,
          summary: `skipped because ${blockedBy.join(' and ')} did not verify`,
        }));
        results.set(step.stepId, { verified: false, status: 'skipped' });
        continue;
      }

      // A capability that is not registered in this build is not an authorization question: there is
      // nothing to authorize. The step is recorded as skipped with the reason, and anything depending on
      // it is skipped by the rule above - a reading that could not be taken is not a reading that held.
      if (!this.#registry.get(step.capabilityId)) {
        stepRecords.push(this.#stepRecord(step, {
          status: 'skipped', operationId: null, verified: false,
          summary: `${step.capabilityId} is not registered in this build, so the step could not run`,
        }));
        results.set(step.stepId, { verified: false, status: 'skipped' });
        continue;
      }

      // One operation per step, so the ledger holds one receipt per step rather than one for the run.
      const operationId = `op_${this.#idFactory().replace(/-/g, '').slice(0, 20)}`;
      // `outcome` is the controller's answer; `step` stays the template's step, so the record it produces
      // describes the step that was asked for rather than whatever the capability happened to return.
      let outcome = null;
      try {
        // The named controller method is preferred because it is the one that finalizes the operation into
        // `operations.jsonl` - authorization, validation, execution and verification, on one line. The bare
        // `runAction` path is kept for a caller that supplies a plain executor, but the composed app always
        // has the named one, and a step whose receipt never reaches the ledger is a step a trace cannot find.
        outcome = typeof this.#controller.playbookStep === 'function'
          ? await this.#controller.playbookStep({
            runId, stepId: step.stepId, capabilityId: step.capabilityId,
            input: { ...step.input }, autonomyTier: 'L2',
          })
          : await this.#controller.runAction(step.capabilityId, { ...step.input }, 'user', operationId);
      } catch (error) {
        const summary = String(error?.message ?? error).slice(0, 400);
        stepRecords.push(this.#stepRecord(step, {
          status: 'failed', operationId: null, verified: false,
          summary: `the capability could not be run: ${summary}`,
        }));
        results.set(step.stepId, { verified: false, status: 'failed' });
        continue;
      }
      // `verified` is the capability's own answer, not this engine's opinion of it. The only outcome that
      // counts is the one the controller's independent verifier writes.
      // `playbookStep` answers with the finished operation and the step inside it; `runAction` answers with
      // the step alone. Both are read here so the engine does not depend on which executor it was given.
      const stepResult = outcome?.step ?? outcome?.steps?.[0] ?? outcome;
      const verified = stepResult?.verification?.outcome === 'success_verified';
      const summary = String(stepResult?.summary ?? '').slice(0, 400)
        || (verified ? 'ran and verified' : 'ran without a verified result');
      stepRecords.push({
        stepId: step.stepId,
        label: step.label,
        capabilityId: step.capabilityId,
        dependsOn: [...step.dependsOn],
        status: verified ? 'verified' : 'failed',
        // A step that ran without verifying still recorded an operation; naming it is what lets a reader
        // find receipt for the attempt rather than only for the successes.
        operationId: outcome?.operationId ?? stepResult?.operationId ?? operationId,
        summary,
        verified,
      });
      results.set(step.stepId, { verified, status: verified ? 'verified' : 'failed' });
    }

    // The steps are reported in template order, not in the order the scheduler happened to run them: the
    // record describes the routine, and the `dependsOn` edges describe the order it ran in.
    const ordered = template.steps.map((step) => stepRecords.find((record) => record.stepId === step.stepId))
      .filter(Boolean);
    const allVerified = ordered.every((record) => record.verified === true) && ordered.length === template.steps.length;
    const run = {
      schema: PLAYBOOK_RUN_SCHEMA,
      runId,
      playbookId: template.playbookId,
      title: template.title,
      launchedAt,
      completedAt: this.#now().toISOString(),
      status: allVerified ? 'verified' : 'failed',
      steps: ordered,
      verified: allVerified,
    };

    const { runs } = this.#read();
    runs.push(run);
    // A bounded ledger: the newest runs are kept. A routine launched every morning for a year is 365
    // records, and a file that grows without bound is a file that eventually fails to parse at boot.
    this.#write(runs.slice(-MAX_RUNS));

    // One line in the shared ledger describing the run as a whole. The individual steps already have their
    // own operations; this is the record that says a routine ran, which steps belong to it, and how it
    // ended - the thing a trace opened on the run id needs in order to find the rest.
    this.#recordOperation({
      capability: 'playbook.launch',
      request: `playbook.launch ${run.playbookId} ${runId}`.slice(0, 200),
      step: {
        action: 'playbook.launch',
        runId,
        playbookId: run.playbookId,
        status: run.status,
        verified: run.verified,
        stepIds: ordered.map((record) => record.stepId),
        operationIds: ordered.map((record) => record.operationId).filter((id) => typeof id === 'string'),
      },
      verified: run.verified,
      reason: reasonText,
    });

    return run;
  }

  #stepRecord(step, override) {
    return {
      stepId: step.stepId,
      label: step.label,
      capabilityId: step.capabilityId,
      dependsOn: [...step.dependsOn],
      ...override,
    };
  }

  #recordOperation({ capability, request, step, verified, reason }) {
    if (typeof this.#operations !== 'function') return;
    try {
      const result = this.#operations({
        id: `${capability}-${this.#idFactory().replace(/-/g, '').slice(0, 16)}`,
        requestedAt: this.#now().toISOString(),
        capability,
        origin: 'user',
        status: verified ? 'success_verified' : 'verification_failed',
        request: reason ? `${request} (${reason})`.slice(0, 240) : request,
        // The same slot a controller-finalized operation uses, so a reader that walks the ledger for a
        // verification outcome finds one on every line rather than on some lines only.
        steps: [{
          ...step,
          verified: verified === true,
          verification: {
            outcome: verified ? 'success_verified' : 'verification_failed',
            detail: `the ${capability} act was recorded by the playbook engine`,
          },
        }],
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Swallowed on purpose: the run's own ledger is already written, and failing here would report a
      // launch as refused after it had already happened.
    }
  }
}

const MAX_RUNS = 200;

// ------------------------------------------------------------------------------- capabilities ---

export function playbookActions(engine) {
  if (!engine || typeof engine.launch !== 'function') throw new TypeError('playbookActions requires the engine');
  return [
    {
      name: 'playbook.catalog',
      description: 'Read the Executive Playbooks catalog: the three built-in multi-step routines with their DAG shape, and every past run with each step\'s outcome and operation id. Reads one ledger and writes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'playbook',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('playbook.catalog expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'playbookId') throw new TypeError(`unexpected playbook.catalog input: ${key}`);
        }
        return input;
      },
      async execute(_ctx, input) {
        const catalog = engine.catalog();
        // A named template narrows the read to one; the catalog is small enough that this is a filter
        // rather than a second route.
        if (typeof input?.playbookId === 'string' && input.playbookId !== '') {
          const template = catalog.templates.find((entry) => entry.playbookId === input.playbookId) ?? null;
          return {
            summary: template ? `playbook ${template.playbookId}: ${template.stepCount} steps` : `no playbook named ${input.playbookId}`,
            data: { ...catalog, templates: template ? [template] : [] },
            display: template
              ? `${template.title} (${template.playbookId}): ${template.steps.map((step) => step.stepId).join(' -> ')}`
              : `No playbook is named ${input.playbookId}.`,
          };
        }
        return {
          summary: `${catalog.summary.templateCount} templates, ${catalog.summary.totalRuns} runs (${catalog.summary.verifiedRuns} verified)`,
          data: catalog,
          display: [
            `${catalog.summary.templateCount} playbook template(s), ${catalog.summary.totalRuns} recorded run(s).`,
            ...catalog.templates.map((template) => `${template.playbookId}: ${template.steps.map((step) => `${step.stepId}${step.dependsOn.length ? `<-${step.dependsOn.join('+')}` : ''}`).join(' ')}`),
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the catalog did not verify' };
        if (!Array.isArray(data.templates) || data.templates.length === 0) return { ok: false, detail: 'the catalog returned no templates' };
        for (const template of data.templates) {
          if (!Array.isArray(template.steps) || template.steps.length !== 3) {
            return { ok: false, detail: `${template.playbookId} does not have three steps` };
          }
        }
        return { ok: true, detail: `${data.templates.length} templates` };
      },
    },
    {
      name: 'playbook.launch',
      description: 'Launch an Executive Playbook: a curated multi-step routine whose steps run through the ECP in dependency order. A fan-in step runs only if every step it depends on verified; otherwise it is recorded as skipped and the run as failed. Refused with PLAYBOOK_NOT_FOUND for an unknown id and with LOCKDOWN_ACTIVE while Lockdown is engaged.',
      inputHint: '{"playbookId":"morning_briefing"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      domain: 'playbook',
      autonomyLevel: 'L2',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        if (input === undefined || input === null) throw new TypeError('playbook.launch needs a playbookId');
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('playbook.launch expects an object');
        for (const key of Object.keys(input)) {
          if (!['playbookId', 'reason'].includes(key)) throw new TypeError(`unexpected playbook.launch input: ${key}`);
        }
        if (typeof input.playbookId !== 'string' || input.playbookId.trim() === '') {
          throw new TypeError('playbook.launch needs a playbookId');
        }
        return input;
      },
      async execute(_ctx, input) {
        const run = await engine.launch(input.playbookId, { reason: input.reason });
        const verifiedSteps = run.steps.filter((step) => step.verified).length;
        const line = run.verified
          ? `Playbook ${run.playbookId} verified: ${verifiedSteps}/${run.steps.length} steps through the ECP (run ${run.runId}).`
          : `Playbook ${run.playbookId} did not verify: ${verifiedSteps}/${run.steps.length} steps (run ${run.runId}).`;
        return {
          summary: `${run.playbookId} ${run.status}: ${verifiedSteps}/${run.steps.length} steps`,
          data: run,
          display: [
            line,
            ...run.steps.map((step) => `  ${step.stepId} ${step.capabilityId}: ${step.status}${step.operationId ? ` (${step.operationId})` : ''}`),
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || typeof data !== 'object') return { ok: false, detail: 'the launch returned no run' };
        if (!String(data.runId ?? '').startsWith('pbr_')) return { ok: false, detail: 'the run has no id' };
        if (!Array.isArray(data.steps) || data.steps.length !== 3) return { ok: false, detail: 'the run does not have three steps' };
        // A verified run must name an operation for every step it verified. A run that reports a verified
        // step with no receipt is a run whose claim cannot be checked, which is the same as unverified.
        if (data.verified === true) {
          for (const step of data.steps) {
            if (step.verified !== true || typeof step.operationId !== 'string' || step.operationId === '') {
              return { ok: false, detail: `step ${step.stepId} claims verified but names no operation` };
            }
          }
          if (data.status !== 'verified') return { ok: false, detail: `the run reports verified but its status is ${data.status}` };
        }
        return { ok: true, detail: `${data.runId} ${data.status}` };
      },
    },
  ];
}

// The catalog as a read for a caller that is not the owner's panel: the router uses this so a `show
// playbooks` line reads through the same declaration rather than reaching into the engine.
export function playbookReadActions(engine) {
  if (!engine || typeof engine.catalog !== 'function') throw new TypeError('playbookReadActions requires the engine');
  return [
    {
      name: 'playbook.read',
      description: 'Read the Executive Playbooks catalog and its recorded runs. Reads one ledger and writes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user'],
      plannable: false,
      domain: 'playbook',
      autonomyLevel: 'L0',
      reversibility: 'read_only',
      blastRadius: 'none',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('playbook.read expects an object');
        return {};
      },
      async execute() {
        const catalog = engine.catalog();
        return {
          summary: `${catalog.summary.templateCount} templates, ${catalog.summary.totalRuns} runs`,
          data: catalog,
          display: `Playbooks: ${catalog.summary.templateCount} templates, ${catalog.summary.totalRuns} runs.`,
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the catalog did not verify' };
        return { ok: true, detail: `${data.summary.templateCount} templates` };
      },
    },
  ];
}
