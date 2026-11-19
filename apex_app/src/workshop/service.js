// Workshop service: composes an artifact, reads it back, and runs the deterministic views over
// the stored record. The composition is validated once, then built into an immutable artifact
// whose identity is the digest of its content.
import { join } from 'node:path';
import {
  buildArtifact, inspectArtifact, normalizeComposition, simulateArtifact,
} from './index.js';
import { WorkshopStore } from './store.js';

export class WorkshopService {
  #now;

  constructor({ dataDir, now = () => new Date() } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('a workshop data directory is required');
    this.#now = now;
    this.store = new WorkshopStore(join(dataDir, 'workshop.jsonl'), { now });
  }

  async compose(input) {
    const composition = normalizeComposition(input);
    const artifact = buildArtifact(composition, { now: this.#now });
    const appended = await this.store.append(artifact);
    return {
      artifact,
      appended: appended.appended === true,
      duplicate: appended.duplicate === true,
      contentDigest: appended.contentDigest ?? null,
    };
  }

  async list(options = {}) {
    return this.store.list(options);
  }

  async get(artifactId) {
    return this.store.get(artifactId);
  }

  async inspect(artifactId) {
    const found = await this.store.get(artifactId);
    if (!found.found) return found;
    return { found: true, report: inspectArtifact(found.artifact) };
  }

  async simulate(artifactId) {
    const found = await this.store.get(artifactId);
    if (!found.found) return found;
    return { found: true, report: simulateArtifact(found.artifact) };
  }

  async status() {
    return this.store.status();
  }
}

export function createWorkshopService(options) {
  return new WorkshopService(options);
}
