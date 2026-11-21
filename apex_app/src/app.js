// Composition root: wires the components together. Tests and the CLI both
// build the application through these functions.
import path from 'node:path';
import { StoreError } from './errors.js';
import { MemoryStore } from './memory/memory-store.js';
import { ConversationStore } from './memory/conversation-store.js';
import { OperationLog } from './operations/operation-log.js';
import { ActionRegistry } from './actions/registry.js';
import { builtinActions } from './actions/builtin.js';
import { knowledgeActions } from './actions/knowledge-actions.js';
import { worldActions } from './actions/world-actions.js';
import { worldModelActions } from './actions/world-model-actions.js';
import { WorldModelStore } from './world/store.js';
import { Verifier } from './verify/verifier.js';
import { CognitiveController } from './controller/controller.js';
import { createGateway, ModelGateway, NoBackend } from './model/gateway.js';
import { SessionState } from './session.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import {
  loadConfig,
  assertIsolatedDataDir,
  isolationRequested,
  DEFAULT_FILESYSTEM_MAX_READ_BYTES,
  FILESYSTEM_LIST_DEFAULT_LIMIT,
  FILESYSTEM_LIST_MAX_LIMIT,
} from './config.js';
import { createWorkspaces } from './filesystem/roots.js';
import { listAction, readAction } from './filesystem/actions.js';
import { workspaceActions } from './filesystem/workspace.js';
import { TaskStore } from './tasks/store.js';
import { SummaryQueue } from './tasks/summary-queue.js';
import { KnowledgeStore } from './knowledge/knowledge-store.js';
import { NoteStore } from './notes/note-store.js';
import { noteActions } from './actions/note-actions.js';
import { ExperienceStore } from './experience/experience-store.js';
import { experienceActions } from './actions/experience-actions.js';
import { LearningService } from './learning/service.js';
import { learningActions } from './actions/learning-actions.js';
import { SituationStore } from './situational/store.js';
import { SituationService } from './situational/service.js';
import { situationActions } from './actions/situation-actions.js';
import { ExecutiveRuntime } from './runtime/executive-runtime.js';
import { IntegrationFabric } from './integrations/manager.js';
import { DocumentService } from './documents/service.js';
import { ReasoningService } from './reasoning/service.js';
import { PredictionStore } from './prediction/prediction-store.js';
import { predictionActions } from './actions/prediction-actions.js';
import { historyActions } from './actions/history-actions.js';
import { GoalStore } from './goals/store.js';
import { PlanStore } from './plans/store.js';
import { ProposalStore } from './proposals/store.js';
import { DeadlineStore } from './deadlines/store.js';
import { deadlineActions } from './actions/deadline-actions.js';
import { backupActions } from './actions/backup-actions.js';
import { councilActions, createCouncilService } from './actions/council-actions.js';
// T-37 Step 1: the 8-region LIF/STDP substrate and its versioned bridge, plus the capabilities that
// step and read them. Track 2 produces candidate associations; it authorizes nothing.
import { neuralActions, createNeural } from './actions/neural-actions.js';
// T-37 Step 3: the deterministic executive command router. No inference; every route names a
// capability or hands the line to the T-29 pipeline.
import { createCommandRouter } from './cognition/command-router.js';
import { workshopActions } from './actions/workshop-actions.js';
import { evolutionActions } from './actions/evolution-actions.js';
import { briefingActions } from './actions/briefing-actions.js';
import { presenceHandoffActions } from './actions/presence-handoff-actions.js';
import { createPresenceHandoffs } from './presence/handoff.js';
import { createBriefingService } from './briefing/service.js';
import { createEvolutionLab } from './evolution/lab.js';
import { goalActions } from './actions/goal-actions.js';
import { planActions } from './actions/plan-actions.js';
import { proposalActions } from './actions/proposal-actions.js';
import { workActions } from './actions/work-actions.js';
import { taskFeedbackActions } from './actions/task-feedback-actions.js';
import { safetyActions } from './actions/safety-actions.js';
import { cognitionActions } from './actions/cognition-actions.js';
import { createCognitivePipeline } from './cognition/pipeline.js';
import { CAPTURE_OFF } from './experience/capture.js';
import { ResourceFabric } from './resources/fabric.js';
import { createWorkshopService } from './workshop/service.js';
import { WorkshopSandbox } from './workshop/sandbox.js';
import { MemoryTraceService } from './memory/trace.js';
import { createPerceptionService } from './perception/service.js';
import { perceptionActions } from './actions/perception-actions.js';
import { DeviceTrustService } from './security/device-trust.js';
import { createDoctor } from './system/doctor.js';
import { createWorkstationBootstrap } from './system/bootstrap.js';
import { systemBootstrapActions } from './actions/system-bootstrap-actions.js';

export function createApp({
  dataDir,
  gateway = new ModelGateway({ backend: new NoBackend() }),
  extraActions = [],
  contextTurns = 6,
  now,
  idFactory,
  filesystemRoot = null,
  filesystemWorkspaces = [],
  filesystemMaxReadBytes = DEFAULT_FILESYSTEM_MAX_READ_BYTES,
  filesystemListDefaultLimit = FILESYSTEM_LIST_DEFAULT_LIMIT,
  filesystemListMaxLimit = FILESYSTEM_LIST_MAX_LIMIT,
  // T-31 Step 3: an optional step-up secret. Off by default, so every existing deployment keeps its
  // exact behaviour; when set, safety.release and evolution.decide require it in addition to the
  // typed reason and the explicit confirmation.
  stepUpToken = null,
  experienceCapture = CAPTURE_OFF,
  neuralRuntime = null,
  // T-37 Step 1: the Track 2 substrate seed. It is an option so a test can pin a substrate that is
  // reproducible across processes; the default is the declared constant in substrate.js.
  neuralSeed = null,
  integrationProviders = null,
  autonomyByDomain = {},
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('dataDir is required');
  if (isolationRequested(process.env)) assertIsolatedDataDir(dataDir);
  const clock = now ?? (() => new Date());
  const memory = new MemoryStore(path.join(dataDir, 'memory.jsonl'), { now: clock });
  const conversation = new ConversationStore(path.join(dataDir, 'conversation.jsonl'), { now: clock });
  const operations = new OperationLog(path.join(dataDir, 'operations.jsonl'));
  const session = new SessionState(path.join(dataDir, 'session.json'), { now: clock });
  const taskStore = new TaskStore(path.join(dataDir, 'tasks.jsonl'), { now: clock, idFactory });
  const summaryQueue = new SummaryQueue(path.join(dataDir, 'task-summary-queue.json'), { now: clock, idFactory });
  const knowledge = new KnowledgeStore(path.join(dataDir, 'knowledge.jsonl'), { now: clock });
  const notes = new NoteStore(path.join(dataDir, 'notes.jsonl'), { now: clock });
  const experience = new ExperienceStore(path.join(dataDir, 'experiences.jsonl'), { now: clock, operations });
  const predictions = new PredictionStore(path.join(dataDir, 'predictions.jsonl'), { now: clock, experiences: experience });
  experience.attachPredictions(predictions);
  const registry = new ActionRegistry({
    autonomyByDomain,
    now: clock,
    idFactory,
    killSwitchPath: path.join(dataDir, 'kill-switch.json'),
    // Absent by default: a deployment opts into step-up by setting APEX_STEP_UP_TOKEN, and the ECP
    // then refuses the two acts that need it until the proof matches.
    stepUpSecret: stepUpToken ?? null,
  });
  const goals = new GoalStore(path.join(dataDir, 'goals.jsonl'), { now: clock, idFactory, operations });
  const plans = new PlanStore(path.join(dataDir, 'plans.jsonl'), {
    now: clock, idFactory, registry, goals, operations, tasks: taskStore,
  });
  const proposals = new ProposalStore(path.join(dataDir, 'proposals.jsonl'), { now: clock, idFactory });
  const deadlines = new DeadlineStore(path.join(dataDir, 'deadlines.jsonl'), { now: clock });
  const learning = new LearningService({
    experience, plans, goals, tasks: taskStore, predictions, registry, now: clock,
  });

  const worldModel = new WorldModelStore(path.join(dataDir, 'world-model.jsonl'), {
    now: clock,
    idFactory,
    sources: {
      memory: async (id) => {
        const rows = await memory.list({ limit: Number.MAX_SAFE_INTEGER });
        const record = rows.find((row) => row.id === id);
        if (!record) return { found: false };
        return {
          found: true,
          active: record.status !== 'superseded',
          state: record.status,
          classification: record.source === 'model' ? 'model_generated' : 'user_statement',
        };
      },
      knowledge: async (id) => {
        const history = await knowledge.history(id);
        if (!history?.record) return { found: false };
        const record = history.record;
        return {
          found: true,
          active: record.active === true,
          state: record.lifecycleState ?? record.status,
          classification: record.provenance?.origin === 'model_proposed' ? 'model_generated' : 'recorded_claim',
        };
      },
      experience: async (id) => {
        const record = await experience.get(id);
        if (!record) return { found: false };
        return {
          found: true,
          active: record.active === true,
          state: record.superseded ? 'superseded' : 'active',
          classification: 'verified_record',
        };
      },
      task: async (id) => {
        const task = await taskStore.get(id);
        if (!task) return { found: false };
        return {
          found: true,
          active: task.status !== 'cancelled',
          state: task.status,
          classification: task.status === 'completed' || task.status === 'failed' ? 'recorded_outcome' : 'recorded_claim',
        };
      },
      operation: async (id) => {
        const result = await operations.findById(id);
        if (!result.found) return { found: false };
        return {
          found: true,
          active: true,
          state: result.record?.status ?? null,
          classification: 'verified_record',
        };
      },
      prediction: async (id) => {
        const projection = await predictions.detail(id);
        if (!projection) return { found: false };
        return {
          found: true,
          active: projection.retired !== true && projection.invalidation === null,
          state: projection.status,
          classification: 'recorded_expectation',
        };
      },
    },
  });

  const situationStore = new SituationStore(path.join(dataDir, 'situational.jsonl'), {
    now: clock,
    idFactory,
    operations,
  });
  const situation = new SituationService({
    store: situationStore,
    worldModel,
    goals,
    plans,
    tasks: taskStore,
    predictions,
    learning,
    experience,
    operations,
    registry,
    now: clock,
    idFactory,
  });

  const documents = new DocumentService({
    dataDir,
    knowledge,
    situation,
    worldModel,
    goals,
    now: clock,
    idFactory,
  });

  const reasoning = new ReasoningService({
    dataDir,
    memory,
    knowledge,
    experience,
    predictions,
    goals,
    plans,
    tasks: taskStore,
    situation,
    worldModel,
    documents,
    now: clock,
    idFactory,
  });

  const integrations = new IntegrationFabric({
    dataDir,
    situation,
    worldModel,
    now: clock,
    idFactory,
    providers: integrationProviders ?? undefined,
  });

  let rootForContext = null;
  let workspaces = null;
  const fsActions = [];
  const hasNamedRoots = Array.isArray(filesystemWorkspaces) && filesystemWorkspaces.length > 0;
  if ((filesystemRoot !== null && filesystemRoot !== undefined) || hasNamedRoots) {
    workspaces = createWorkspaces({ root: filesystemRoot, extra: filesystemWorkspaces });
    rootForContext = workspaces?.defaultRoot ?? null;
    fsActions.push(
      listAction(workspaces, { defaultLimit: filesystemListDefaultLimit, maxEntries: filesystemListMaxLimit }),
      readAction(workspaces, { maxBytes: filesystemMaxReadBytes }),
      ...workspaceActions(workspaces),
    );
  }

  // Council is constructed before action registration so its read-oriented actions are
  // registered exactly once, through the same registry/ECP path as every other capability.
  // T-37 Step 2: the Council also reads the safety latch, so its Values & Constraints Core can
  // evaluate its lockdown rule. The read is of the latch's state; the Council cannot move it.
  const council = createCouncilService({
    dataDir, now: clock, idFactory, registry, reasoning,
    controlPlane: registry.controlPlane,
  });

  // The Workshop is a design sheet store: composition is a user write, inspection and simulation
  // are reads. Nothing in it executes code, and a simulation is never an authorization.
  const workshop = createWorkshopService({ dataDir, now: clock });
  // T-38 Step 2 (2026-11-21): the file-backed Workshop. The inspector reads the configured target
  // workspace; the sandbox stages candidates under this data directory. The two never cross: the
  // workspace root is opened for reading and every staged byte lives under `<dataDir>/workshop-sandbox`.
  // T-38 Step 3 (2026-11-21): the cross-ledger trace and search. It reads six ledgers and writes
  // none; it needs only the data directory, because every record it assembles already exists.
  const memoryTrace = new MemoryTraceService({ dataDir, now: clock });
  const workshopSandbox = new WorkshopSandbox({
    dataDir,
    workspaceRoot: rootForContext,
    now: clock,
    ...(idFactory ? { idFactory } : {}),
  });

  // T-31 Step 2: the controlled Evolution Lab. It records proposals about APEX's own behaviour,
  // the sandbox result that was measured for each one, and the owner's promotion decisions. It
  // executes nothing: every act below is a user-origin capability the ECP authorizes.
  const evolution = createEvolutionLab({ dataDir, now: clock, idFactory });

  // T-32 Step 3: perception of the machine this process actually runs on. The sensor reads the host
  // and the configured workspace (when there is one) and the service owns the observation ledger and
  // the Sentinel's push discipline. It is constructed before action registration so
  // perception.sense_host is registered through the same registry/ECP path as everything else.
  const perception = createPerceptionService({
    dataDir,
    now: clock,
    ...(idFactory ? { idFactory } : {}),
    workspaceDir: rootForContext,
  });

  // T-37 Step 1: Track 2. One deterministic spiking substrate per data directory, its versioned
  // neural-cognitive bridge, and the ledger of steps that ran. It is constructed before action
  // registration so `neural.step` is authorized by the same ECP path as every other write.
  const neural = createNeural({ dataDir, now: clock, ...(neuralSeed ? { seed: neuralSeed } : {}) });

  // Device trust records enrollment and authenticates signed device messages. It does not
  // grant capabilities; all action authorization remains with the existing ECP.
  const deviceTrust = new DeviceTrustService(path.join(dataDir, 'devices.jsonl'), { now: clock, idFactory });

  for (const def of [...builtinActions(), ...safetyActions(registry.controlPlane), ...knowledgeActions(knowledge), ...noteActions(notes), ...experienceActions(experience), ...learningActions(learning), ...situationActions(situation), ...predictionActions(predictions), ...historyActions({
      experience, predictions, world: worldModel, goals, plans, tasks: taskStore, memory, knowledge, operations,
    }), ...goalActions(goals), ...planActions(plans), ...proposalActions(proposals), ...deadlineActions({ deadlines, roots: workspaces }), ...backupActions({ dataDir, appVersion: APP_VERSION }), ...workActions(), ...taskFeedbackActions(), ...worldActions(), ...worldModelActions(worldModel), ...councilActions(council), ...workshopActions(workshop), ...evolutionActions(evolution), ...perceptionActions(perception, { controlPlane: registry.controlPlane }), ...neuralActions(neural), ...extraActions, ...fsActions]) registry.register(def);

  const getStatus = async () => {
    const m = await memory.status();
    const o = await operations.status();
    const t = await conversation.status();
    const x = await experience.status();
    const p = await predictions.status();
    const g = await goals.status();
    const pl = await plans.status();
    const pr = await proposals.status();
    const wm = await worldModel.status();
    const dl = await deadlines.status();
    const deviceStatus = await deviceTrust.status();
    const current = await session.peek();
    if (current.status === 'corrupt') {
      throw new StoreError(`${current.detail}; run "apex new" to start a new session`);
    }
    if (current.status === 'unavailable') throw new StoreError(current.detail);
    return {
      app: APP_NAME,
      expansion: APP_EXPANSION,
      stage: APP_STAGE,
      version: APP_VERSION,
      dataDir,
      memoryRecords: m.records,
      corruptMemoryLines: m.corrupt,
      operationRecords: o.records,
      turnRecords: t.turns,
      experienceRecords: x.records,
      experienceRecordedByUser: x.recordedByUser,
      experienceCapturedAutomatically: x.capturedAutomatically,
      experienceCaptureMode: experienceCapture,
      corruptExperienceLines: x.corrupt,
      predictionRecords: p.records,
      predictionsLive: p.live,
      predictionsSuperseded: p.superseded,
      predictionsEvaluated: p.evaluations,
      predictionsPastHorizon: p.pastHorizon,
      predictionConfidenceValues: p.confidenceValues,
      corruptPredictionLines: p.corrupt,
      goalRecords: g.records,
      goalCount: g.goals,
      corruptGoalLines: g.corrupt,
      planRecords: pl.records,
      planCount: pl.plans,
      corruptPlanLines: pl.corrupt,
      proposalRecords: pr.records,
      proposalCount: pr.proposals,
      corruptProposalLines: pr.corrupt,
      deadlineRecords: dl.records,
      corruptDeadlineLines: dl.corrupt,
      worldModelAvailable: wm.available,
      worldModelComplete: wm.complete,
      worldModelRecords: wm.counts === null ? null : wm.records,
      worldModelEntities: wm.counts?.entities ?? null,
      worldModelFacts: wm.counts?.facts ?? null,
      worldModelRelationships: wm.counts?.relationships ?? null,
      worldModelEvents: wm.counts?.events ?? null,
      worldModelConflictGroups: wm.counts?.conflictGroups ?? null,
      corruptWorldModelLines: wm.counts === null ? null : wm.corrupt.length,
      worldModelDetail: wm.detail ?? null,
      sessionId: current.state?.sessionId ?? null,
      model: gateway.describe(),
      deviceTrust: deviceStatus,
      filesystemRoot: rootForContext,
      filesystemWorkspaces: workspaces === null ? [] : workspaces.list(),
    };
  };

  const controller = new CognitiveController({
    memory,
    operations,
    registry,
    verifier: new Verifier(),
    gateway,
    getStatus,
    conversation,
    session,
    contextTurns,
    now: clock,
    idFactory,
    taskStore,
    summaryQueue,
    rootForContext,
    workspaces,
    knowledge,
    notes,
    experience,
    experienceCapture,
    predictions,
    goals,
    plans,
    proposals,
    worldModel,
    deadlines,
    learning,
    situation,
    documents,
    reasoning,
    dataDir,
    neural: neuralRuntime,
    neuralService: neural,
    council,
    workshop,
    workshopSandbox,
    evolution,
  });
  const runtime = new ExecutiveRuntime({
    controller,
    situation,
    taskStore,
    plans,
    goals,
    learning,
    experience,
    predictions,
    operations,
    integrations,
    documents,
    reasoning,
    dataDir,
    now: clock,
    idFactory,
  });
  const resources = new ResourceFabric({ now: clock });

  // T-29: the unified cognitive pipeline. It is constructed after the resource fabric so the
  // salience stage can read real pressure, and its capability is registered through the same
  // registry/ECP path as every other action: the pipeline orchestrates, the ECP authorizes.
  const cognition = createCognitivePipeline({
    dataDir,
    registry,
    controlPlane: registry.controlPlane,
    controller,
    taskStore,
    memory,
    knowledge,
    worldModel,
    goals,
    situation,
    resources,
    // T-32 Step 3: live host and workspace facts, so a cognitive run reads the machine it is on
    // rather than only the stores it keeps.
    perception,
    // T-34 Step 1: a mission refuses an artifact this service cannot read, so the precondition is
    // stated before the mission's first step is recorded.
    workshop,
    council,
    // T-37 Step 1: Track 2's substrate is available to a cognitive run as a read-only salience
    // modulation. The pipeline reads the bridge; it never steps the substrate, because stepping is
    // a governed write the owner authorizes.
    neural,
    now: clock,
    idFactory,
  });
  for (const def of cognitionActions(cognition)) registry.register(def);
  // T-34 Step 3: the briefing checkpoints. The service reads the stores it is given and writes one
  // file in the isolated data directory; acknowledging is a governed write (briefing.acknowledge).
  const briefing = createBriefingService({
    dataDir,
    now: clock,
    idFactory,
    owners: { taskStore, perception, workshop, evolution, cognition },
  });
  for (const def of briefingActions(briefing)) registry.register(def);
  // T-35 Step 2: the presence handoff envelopes. The ledger is local and append-only; the device ids
  // are checked against the T-28 registry at staging and again at the claim, and the targets a
  // handoff may name are looked up rather than trusted, so an envelope cannot point at a task or
  // artifact that does not exist.
  const handoffs = createPresenceHandoffs({
    dataDir,
    deviceTrust,
    now: clock,
    idFactory,
    lookups: {
      task: (taskId) => taskStore.get(taskId),
      artifact: async (artifactId) => {
        const found = await workshop.get(artifactId);
        return found && found.found === true ? found.artifact ?? found : null;
      },
      checkpoint: async (checkpointId) => {
        const recorded = await briefing.list({ limit: 200 });
        return recorded.find((entry) => entry.id === checkpointId) ?? null;
      },
    },
  });
  for (const def of presenceHandoffActions(handoffs)) registry.register(def);
  const app = {
    controller,
    memory,
    conversation,
    session,
    operations,
    registry,
    ecp: registry.controlPlane,
    resources,
    gateway,
    getStatus,
    dataDir,
    taskStore,
    summaryQueue,
    filesystemRoot: rootForContext,
    // T-38 Step 2: the file-backed Workshop, so the UI routes reach the one sandbox the actions use.
    workshopSandbox,
    // T-38 Step 3: the cross-ledger trace and search, for the Memory Timeline.
    memoryTrace,
    filesystemWorkspaces: workspaces,
    knowledge,
    notes,
    experience,
    experienceCapture,
    predictions,
    goals,
    plans,
    proposals,
    worldModel,
    deadlines,
    learning,
    situation,
    runtime,
    integrations,
    documents,
    reasoning,
    council,
    workshop,
    evolution,
    deviceTrust,
    perception,
    cognition,
    briefing,
    handoffs,
    // T-37 Step 1: Track 2. Exposed so the UI server and the pipeline share the one substrate the
    // actions already step - a second instance would be a second simulation, and the deck would be
    // showing numbers no action produced.
    neural,
  };
  // T-36 Step 1: the doctor and the workstation bootstrap. The doctor is composed with the same
  // application the deck reads, so its six checks are the running system's and not a second opinion
  // built from environment variables; the bootstrap uses that doctor for its readiness gate. Both
  // are attached to the application so the CLI, the desktop shell and the UI server share one
  // instance of each rather than three readings of the same thing.
  const doctor = createDoctor({ app, dataDir });
  const bootstrap = createWorkstationBootstrap({ app, dataDir, now: clock, doctor });
  for (const def of systemBootstrapActions(bootstrap)) registry.register(def);
  app.doctor = doctor;
  app.bootstrap = bootstrap;

  // T-37 Step 3: the deterministic command router, composed with the controller so every route it
  // names is authorized by the same registry and gated by the same ECP. It is attached before the
  // server can serve a dispatch, and it reads the doctor and the briefing through `dispatchRead`
  // below rather than through a second implementation of either.
  app.dispatchRead = async (pathname) => {
    try {
      if (pathname === '/api/system/doctor') {
        const report = await doctor.run();
        return { ok: report?.status !== 'failed', status: 200, value: report };
      }
      if (pathname === '/api/briefing') {
        const report = await briefing.latest();
        return { ok: true, status: 200, value: report };
      }
      return { ok: false, status: 404, error: `this build cannot read ${pathname} internally` };
    } catch (err) {
      return { ok: false, status: 500, error: String(err?.message ?? err) };
    }
  };
  app.commandRouter = createCommandRouter({ controller, app });
  return app;
}

export function createAppFromEnv(env = process.env) {
  const config = loadConfig(env);
  const gateway = createGateway(config.model);
  const app = createApp({
    dataDir: config.dataDir,
    gateway,
    contextTurns: config.contextTurns,
    filesystemRoot: config.filesystem.root,
    filesystemWorkspaces: config.filesystem.workspaces,
    filesystemMaxReadBytes: config.filesystem.maxReadBytes,
    filesystemListDefaultLimit: config.filesystem.listDefaultLimit,
    filesystemListMaxLimit: config.filesystem.listMaxLimit,
    experienceCapture: config.experienceCapture,
    autonomyByDomain: config.autonomyByDomain,
    stepUpToken: config.stepUpToken ?? null,
  });
  return { config, ...app };
}
