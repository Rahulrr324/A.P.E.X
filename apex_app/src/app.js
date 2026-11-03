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
import { resolveRoot, validateRoot } from './filesystem/path.js';
import { listAction, readAction } from './filesystem/actions.js';
import { TaskStore } from './tasks/store.js';
import { SummaryQueue } from './tasks/summary-queue.js';
import { KnowledgeStore } from './knowledge/knowledge-store.js';
import { ExperienceStore } from './experience/experience-store.js';
import { experienceActions } from './actions/experience-actions.js';
import { PredictionStore } from './prediction/prediction-store.js';
import { predictionActions } from './actions/prediction-actions.js';
import { GoalStore } from './goals/store.js';
import { PlanStore } from './plans/store.js';
import { goalActions } from './actions/goal-actions.js';
import { planActions } from './actions/plan-actions.js';
import { CAPTURE_OFF } from './experience/capture.js';

export function createApp({
  dataDir,
  gateway = new ModelGateway({ backend: new NoBackend() }),
  extraActions = [],
  contextTurns = 6,
  now,
  idFactory,
  filesystemRoot = null,
  filesystemMaxReadBytes = DEFAULT_FILESYSTEM_MAX_READ_BYTES,
  filesystemListDefaultLimit = FILESYSTEM_LIST_DEFAULT_LIMIT,
  filesystemListMaxLimit = FILESYSTEM_LIST_MAX_LIMIT,
  experienceCapture = CAPTURE_OFF,
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
  // An experience is a verified reference to one audit record, so this store is given the audit
  // log: a write whose operation cannot be found there is refused instead of recorded, and every
  // later read can recompute the evidence hash against it.
  const experience = new ExperienceStore(path.join(dataDir, 'experiences.jsonl'), { now: clock, operations });
  // A prediction cites recorded events, so this store is given the experience log: a write whose
  // citations do not resolve there is refused, and every later read re-opens the horizon against it.
  // It is a separate log on purpose - see the header of prediction-store.js.
  const predictions = new PredictionStore(path.join(dataDir, 'predictions.jsonl'), { now: clock, experiences: experience });
  const registry = new ActionRegistry();
  // Goals and plans are append-only records of intent. The plan store validates against the
  // live registry and reads goals, so it is constructed after both; neither store can execute
  // anything, and both use their own writer lock for every mutation.
  const goals = new GoalStore(path.join(dataDir, 'goals.jsonl'), { now: clock, idFactory, operations });
  const plans = new PlanStore(path.join(dataDir, 'plans.jsonl'), { now: clock, idFactory, registry, goals, operations });

  // Filesystem inspection exists only when a root is configured. The root is resolved
  // and validated here, once, and captured by the action closures: no request, model
  // proposal, or task step can change it. A configured-but-invalid root is a startup
  // error rather than a silently disabled capability.
  let rootForContext = null;
  const fsActions = [];
  if (filesystemRoot !== null && filesystemRoot !== undefined) {
    rootForContext = validateRoot(resolveRoot(filesystemRoot));
    fsActions.push(
      listAction(rootForContext, { defaultLimit: filesystemListDefaultLimit, maxEntries: filesystemListMaxLimit }),
      readAction(rootForContext, { maxBytes: filesystemMaxReadBytes }),
    );
  }

  for (const def of [...builtinActions(), ...knowledgeActions(knowledge), ...experienceActions(experience), ...predictionActions(predictions), ...goalActions(goals), ...planActions(plans), ...worldActions(), ...extraActions, ...fsActions]) registry.register(def);

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
      sessionId: current.state?.sessionId ?? null,
      model: gateway.describe(),
      filesystemRoot: rootForContext,
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
    knowledge,
    experience,
    experienceCapture,
    predictions,
    goals,
    plans,
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
    knowledge,
    experience,
    experienceCapture,
    predictions,
    goals,
    plans,
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
    filesystemMaxReadBytes: config.filesystem.maxReadBytes,
    filesystemListDefaultLimit: config.filesystem.listDefaultLimit,
    filesystemListMaxLimit: config.filesystem.listMaxLimit,
    experienceCapture: config.experienceCapture,
  });
  return { config, ...app };
}
