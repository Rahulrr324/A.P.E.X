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
import { PredictionStore } from './prediction/prediction-store.js';
import { predictionActions } from './actions/prediction-actions.js';
import { historyActions } from './actions/history-actions.js';
import { GoalStore } from './goals/store.js';
import { PlanStore } from './plans/store.js';
import { ProposalStore } from './proposals/store.js';
import { DeadlineStore } from './deadlines/store.js';
import { deadlineActions } from './actions/deadline-actions.js';
import { backupActions } from './actions/backup-actions.js';
import { goalActions } from './actions/goal-actions.js';
import { planActions } from './actions/plan-actions.js';
import { proposalActions } from './actions/proposal-actions.js';
import { workActions } from './actions/work-actions.js';
import { taskFeedbackActions } from './actions/task-feedback-actions.js';
import { CAPTURE_OFF } from './experience/capture.js';

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
  experienceCapture = CAPTURE_OFF,
  // A neural boundary is never selected by the application: the default reports that no runtime
  // is connected. Tests may inject one to exercise the contract, but the controller still sees
  // only the declaration, and no request path invokes it.
  neuralRuntime = null,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('dataDir is required');
  // Isolation is checked here as well as in loadConfig because this is the one place every
  // writer passes. A test or benchmark that builds an app programmatically with a real
  // directory fails at construction instead of writing into it, so the guarantee does not
  // depend on remembering to resolve configuration through the env layer first.
  if (isolationRequested(process.env)) assertIsolatedDataDir(dataDir);
  const clock = now ?? (() => new Date());
  const memory = new MemoryStore(path.join(dataDir, 'memory.jsonl'), { now: clock });
  const conversation = new ConversationStore(path.join(dataDir, 'conversation.jsonl'), { now: clock });
  const operations = new OperationLog(path.join(dataDir, 'operations.jsonl'));
  const session = new SessionState(path.join(dataDir, 'session.json'), { now: clock });
  const taskStore = new TaskStore(path.join(dataDir, 'tasks.jsonl'), { now: clock, idFactory });
  // The task summaries that conversation history refused. It holds only unsaved turns,
  // never task state or audit evidence, so the two authoritative logs are unaffected by it.
  const summaryQueue = new SummaryQueue(path.join(dataDir, 'task-summary-queue.json'), { now: clock, idFactory });
  const knowledge = new KnowledgeStore(path.join(dataDir, 'knowledge.jsonl'), { now: clock });
  // A note is the user's own composition with its own append-only revision log. It may cite a
  // memory record, a knowledge claim, or a file, but nothing is derived from it: it is not a
  // memory, not a claim, and not an instruction.
  const notes = new NoteStore(path.join(dataDir, 'notes.jsonl'), { now: clock });
  // An experience is a verified reference to one audit record, so this store is given the audit
  // log: a write whose operation cannot be found there is refused instead of recorded, and every
  // later read can recompute the evidence hash against it.
  const experience = new ExperienceStore(path.join(dataDir, 'experiences.jsonl'), { now: clock, operations });
  // A prediction cites recorded events, so this store is given the experience log: a write whose
  // citations do not resolve there is refused, and every later read re-opens the horizon against it.
  // It is a separate log on purpose - see the header of prediction-store.js.
  const predictions = new PredictionStore(path.join(dataDir, 'predictions.jsonl'), { now: clock, experiences: experience });
  // A prediction-derived candidate is checked against its prediction on every read, so the experience
  // store holds the reverse edge. Until the attach below, feedback-derived records behave exactly as
  // before and any prediction-derived record reads as inert.
  experience.attachPredictions(predictions);
  const registry = new ActionRegistry();
  // Goals and plans are append-only records of intent. The plan store validates against the
  // live registry and reads goals, so it is constructed after both; neither store can execute
  // anything, and both use their own writer lock for every mutation.
  const goals = new GoalStore(path.join(dataDir, 'goals.jsonl'), { now: clock, idFactory, operations });
  const plans = new PlanStore(path.join(dataDir, 'plans.jsonl'), { now: clock, idFactory, registry, goals, operations });
  // Proposals are model suggestions. The store records them and the user's decision about them;
  // it cannot approve, activate, or execute anything, and it is not a source of authority.
  const proposals = new ProposalStore(path.join(dataDir, 'proposals.jsonl'), { now: clock, idFactory });
  // Recorded deadlines: dates the owner imported from a local file. The ledger stores the date,
  // its source file, that file's digest, and the line. It is not a scheduler and holds no
  // completion state; a date passing changes nothing here.
  const deadlines = new DeadlineStore(path.join(dataDir, 'deadlines.jsonl'), { now: clock });
  // T-08 outcome learning composes reads over the stores above and appends its three record kinds to
  // the experience log. It holds no state, opens no file, and takes no lock of its own; the ordinary
  // action registry authorizes every write and the experience store's writer lock covers the append.
  const learning = new LearningService({
    experience, plans, goals, tasks: taskStore, predictions, registry, now: clock,
  });

  // The World Model is a separate append-only record of entities, facts, relationships, and events.
  // Every evidence reference is checked against the store that owns the cited record, so each
  // adapter answers only what its own log can justify: whether the record exists, whether it is
  // still current, and how it was produced. A damaged source store throws, which the world store
  // turns into a refusal - an unreadable source is never "no such evidence".
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

  // T-09 situational awareness: one append-only log of observations, assessments, decisions and
  // responses. Facts and world events are written through the World Model above; context is read
  // from the existing goal, plan, task and prediction stores; approved responses run through the
  // registry in the controller. Nothing here is a second world model, planner, or runner.
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

  // Filesystem assistance exists only when at least one root is configured. Every root is
  // resolved and validated here, once, and captured by the action closures: no request, model
  // proposal, or task step can add or widen one. A configured-but-invalid root is a startup
  // error rather than a silently disabled capability.
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

  for (const def of [...builtinActions(), ...knowledgeActions(knowledge), ...noteActions(notes), ...experienceActions(experience), ...learningActions(learning), ...situationActions(situation), ...predictionActions(predictions), ...historyActions({
      experience, predictions, world: worldModel, goals, plans, tasks: taskStore, memory, knowledge, operations,
    }), ...goalActions(goals), ...planActions(plans), ...proposalActions(proposals), ...deadlineActions({ deadlines, roots: workspaces }), ...backupActions({ dataDir, appVersion: APP_VERSION }), ...workActions(), ...taskFeedbackActions(), ...worldActions(), ...worldModelActions(worldModel), ...extraActions, ...fsActions]) registry.register(def);

  // Reporting must not create a session as a side effect. A missing session is
  // reported as absent; a damaged state still raises (it must not look empty).
  const getStatus = async () => {
    const m = await memory.status();
    const o = await operations.status();
    const t = await conversation.status();
    const x = await experience.status();
    const p = await predictions.status();
    const g = await goals.status();
    const pl = await plans.status();
    const pr = await proposals.status();
    // The world model reports damage instead of throwing from this read, so a damaged log is
    // displayed as unavailable-with-detail and never counted as an empty world.
    const wm = await worldModel.status();
    // A deadline count is what was imported from the owner's files; it is not a count of what is
    // due, which depends on a horizon and belongs to a reader that states it.
    const dl = await deadlines.status();
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
      // Stated as expectations, never as events: `predictions` counts what the user recorded, and the
      // verdict count is how many of those an outcome has been recorded against.
      predictionRecords: p.records,
      predictionsLive: p.live,
      predictionsSuperseded: p.superseded,
      predictionsEvaluated: p.evaluations,
      predictionsPastHorizon: p.pastHorizon,
      predictionConfidenceValues: p.confidenceValues,
      corruptPredictionLines: p.corrupt,
      // Goals and plans are records of intent, not work done. The counts say what is stored,
      // never that anything ran: progress lives on each record.
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
      // The world model is a record of claims, not verified world state. A count says what is
      // stored; conflictGroups says how many disagreements are stored unresolved.
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
      filesystemRoot: rootForContext,
      // Names are selectors, not authority: every listed root was already validated at startup.
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
    dataDir,
    neural: neuralRuntime,
  });
  // T-10 runtime: an opt-in process over the same controller. Constructing it starts nothing; no
  // timer, lease, or write exists until `runtime.start()` is called explicitly.
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
    dataDir,
    now: clock,
    idFactory,
  });
  return {
    controller,
    memory,
    conversation,
    session,
    operations,
    registry,
    gateway,
    getStatus,
    dataDir,
    taskStore,
    summaryQueue,
    filesystemRoot: rootForContext,
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
  };
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
  });
  return { config, ...app };
}
