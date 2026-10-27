// Composition root: wires the components together. Tests and the CLI both
// build the application through these functions.
import path from 'node:path';
import { MemoryStore } from './memory/memory-store.js';
import { ConversationStore } from './memory/conversation-store.js';
import { OperationLog } from './operations/operation-log.js';
import { ActionRegistry } from './actions/registry.js';
import { builtinActions } from './actions/builtin.js';
import { Verifier } from './verify/verifier.js';
import { CognitiveController } from './controller/controller.js';
import { createGateway, ModelGateway, NoBackend } from './model/gateway.js';
import { SessionState } from './session.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { loadConfig, DEFAULT_FILESYSTEM_MAX_READ_BYTES } from './config.js';
import { TaskStore } from './tasks/store.js';
import { validateRoot } from './filesystem/path.js';

export async function createApp({
  dataDir,
  gateway = new ModelGateway({ backend: new NoBackend() }),
  extraActions = [],
  contextTurns = 6,
  now,
  idFactory,
  filesystemRoot = null,
  filesystemMaxReadBytes = DEFAULT_FILESYSTEM_MAX_READ_BYTES,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('dataDir is required');
  const clock = now ?? (() => new Date());
  const memory = new MemoryStore(path.join(dataDir, 'memory.jsonl'), { now: clock });
  const conversation = new ConversationStore(path.join(dataDir, 'conversation.jsonl'), { now: clock });
  const operations = new OperationLog(path.join(dataDir, 'operations.jsonl'));
  const session = new SessionState(path.join(dataDir, 'session.json'), { now: clock });
  const taskStore = new TaskStore(path.join(dataDir, 'tasks.jsonl'), { now: clock, idFactory });
  const registry = new ActionRegistry();

  // When a root is supplied to the factory, validate it and register the filesystem
  // actions, so the capability is available in tests and in the env-driven path.
  // The filesystem actions receive the resolved root through their constructor
  // (listAction(root, ...) / readAction(root, ...)). They store it internally and expose it on
  // the action context at execution time.
  // Provide the authorized root on the action context so the actions can resolve paths against it.
  // This is the only place the root is bound into an action; it cannot be supplied by a model.
  const fsActions = [];
  let rootForContext = null;
  if (filesystemRoot) {
    const root = validateRoot(filesystemRoot);
    const { listAction, readAction } = await import('./filesystem/actions.js');
    fsActions.push(listAction(root, filesystemMaxReadBytes), readAction(root, filesystemMaxReadBytes));
    rootForContext = root;
  }

  for (const def of [...builtinActions(), ...extraActions, ...fsActions]) registry.register(def);

  const getStatus = async () => {
    const m = await memory.status();
    const o = await operations.status();
    const t = await conversation.status();
    const current = await session.current();
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
      sessionId: current.sessionId,
      model: gateway.describe(),
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
    rootForContext,
  });
  return { controller, memory, conversation, session, operations, registry, gateway, getStatus, dataDir, taskStore };
}

export async function createAppFromEnv(env = process.env) {
  const config = loadConfig(env);
  const gateway = createGateway(config.model);
  const extraActions = [];
  let rootForContext = null;
  if (config.filesystem.root) {
    // Validate the configured root at startup so a misconfigured boundary is caught before any
    // action runs, not during the first listing.
    const root = validateRoot(config.filesystem.root);
    const { listAction, readAction } = await import('./filesystem/actions.js');
    extraActions.push(listAction(root, config.filesystem.maxReadBytes));
    extraActions.push(readAction(root, config.filesystem.maxReadBytes));
    rootForContext = root;
  }
  return { config, ...createApp({ dataDir: config.dataDir, gateway, contextTurns: config.contextTurns, extraActions, rootForContext }) };
}
