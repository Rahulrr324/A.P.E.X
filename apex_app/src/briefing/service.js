// T-34 Step 3 (2026-11-19): the briefing service - the checkpoint store plus the living delta.
//
// It owns exactly one file, in the isolated data directory, and it never reads a store it was not
// given. The delta is computed here so the route and the action cannot disagree about it.
import path from 'node:path';
import { BriefingCheckpointStore, briefingDelta } from './checkpoints.js';
import { collectBriefingSnapshot } from './snapshot.js';

export function createBriefingService({ dataDir, now = () => new Date(), idFactory, owners = {} } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('a briefing service needs a data directory');
  const store = new BriefingCheckpointStore(path.join(dataDir, 'briefing-checkpoints.jsonl'), { now, idFactory });
  const collect = () => collectBriefingSnapshot(owners);

  async function acknowledge({ by = 'owner', reason = null } = {}) {
    // The reading is taken before the checkpoint is written, so the checkpoint records what the owner
    // was looking at rather than what the system looked like a moment later.
    const snapshot = await collect();
    const record = await store.acknowledge({ by, reason, snapshot });
    return { record, snapshot };
  }

  async function latest() {
    return store.latest();
  }

  async function latestDelta() {
    const [prior, current] = await Promise.all([store.latest(), collect()]);
    return { prior, current, delta: briefingDelta({ prior, current }) };
  }

  async function status() {
    return { store: await store.status(), latest: await store.latest() };
  }

  return {
    acknowledge,
    latest,
    latestDelta,
    status,
    list: (options) => store.list(options),
    filePath: store.filePath,
    collect,
  };
}
