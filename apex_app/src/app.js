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
import { loadConfig } from './config.js';
import { TaskStore } from './tasks/store.js';

export function createApp({
  dataDir,
  gateway = new ModelGateway({ backend: new NoBackend() }),
  extraActions = [],
  contextTurns = 6,
  now,
  idFactory,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('dataDir is required');
  const clock = now ?? (() => new Date());
  const memory = new MemoryStore(path.join(dataDir, 'memory.jsonl'), { now: clock });
  const conversation = new ConversationStore(path.join(dataDir, 'conversation.jsonl'), { now: clock });
  const operations = new OperationLog(path.join(dataDir, 'operations.jsonl'));
  const session = new SessionState(path.join(dataDir, 'session.json'), { now: clock });
  const taskStore = new TaskStore(path.join(dataDir, 'tasks.jsonl'), { now: clock, idFactory });
  const registry = new ActionRegistry();
  for (const def of [...builtinActions(), ...extraActions]) registry.register(def);

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
  });
  return { controller, memory, conversation, session, operations, registry, gateway, getStatus, dataDir, taskStore };
}

export function createAppFromEnv(env = process.env) {
  const config = loadConfig(env);
  const gateway = createGateway(config.model);
  return { config, ...createApp({ dataDir: config.dataDir, gateway, contextTurns: config.contextTurns }) };
}
