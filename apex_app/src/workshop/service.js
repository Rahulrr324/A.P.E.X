// Workshop service: composes an artifact, reads it back, and runs the deterministic views over
// the stored record. The composition is validated once, then built into an immutable artifact
// whose identity is the digest of its content.
import { join } from 'node:path';
import {
  buildArtifact, inspectArtifact, normalizeComposition, simulateArtifact,
} from './index.js';
import { WorkshopStore } from './store.js';
import {
  WorkshopVerificationLedger, verifyArtifact, WORKSHOP_PROMOTION_SCHEMA, WORKSHOP_VERIFICATION_SCHEMA,
} from './verification.js';
import { randomUUID } from 'node:crypto';

export class WorkshopService {
  #now;
  #idFactory;

  constructor({ dataDir, now = () => new Date(), idFactory = randomUUID } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('a workshop data directory is required');
    this.#now = now;
    this.#idFactory = idFactory;
    this.store = new WorkshopStore(join(dataDir, 'workshop.jsonl'), { now });
    // T-33 Step 3: verification and promotion are recorded beside the design, never inside it, so a
    // check never rewrites the sheet it is checking.
    this.verificationLedger = new WorkshopVerificationLedger(WorkshopVerificationLedger.pathFor(dataDir), { now });
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

  // T-33 Step 3: the sandbox verification. The artifact is read back, the Workshop's own inspection
  // and simulation are re-derived, and the fixed check list is applied to those reports. The record
  // is appended before it is returned, so a caller cannot report a result the ledger does not hold.
  async verify(artifactId) {
    const found = await this.store.get(artifactId);
    if (!found.found) return found;
    const artifact = found.artifact;
    const inspection = inspectArtifact(artifact);
    const simulation = simulateArtifact(artifact);
    const report = verifyArtifact(artifact, inspection, simulation, { now: this.#now, idFactory: this.#idFactory });
    await this.verificationLedger.append(report);
    return { found: true, verification: report, artifact };
  }

  // Promotion is an owner act: it refuses unless the newest recorded verification of this exact
  // artifact passed, and it records why. It applies nothing and executes nothing; the memory record
  // it writes is the timeline entry that says the sheet was accepted.
  async promote(artifactId, { reason = null, memoryId = null } = {}) {
    const found = await this.store.get(artifactId);
    if (!found.found) return found;
    const artifact = found.artifact;
    const latest = await this.verificationLedger.latestVerification(artifact.artifactId);
    if (!latest.found) {
      return { found: true, promoted: false, reasonCode: 'NOT_VERIFIED', detail: latest.detail ?? 'no verification is recorded for this artifact', artifact };
    }
    if (latest.verification.verified !== true) {
      return {
        found: true, promoted: false, reasonCode: 'VERIFICATION_FAILED',
        detail: `the newest verification failed (${latest.verification.failed.join(', ') || 'no check passed'})`,
        verification: latest.verification, artifact,
      };
    }
    if (latest.verification.identityDigest !== artifact.identityDigest) {
      return {
        found: true, promoted: false, reasonCode: 'DIGEST_MISMATCH',
        detail: 'the verification was recorded against different content',
        verification: latest.verification, artifact,
      };
    }
    const at = this.#now().toISOString();
    const record = Object.freeze({
      schema: WORKSHOP_PROMOTION_SCHEMA,
      kind: 'promotion',
      id: `wsp-${this.#idFactory().replace(/[^a-z0-9]/gi, '').slice(0, 12)}`,
      artifactId: artifact.artifactId,
      identityDigest: artifact.identityDigest,
      verificationId: latest.verification.id,
      at,
      reason: reason === null ? null : String(reason).slice(0, 240),
      promotedBy: 'user',
      memoryId,
      appliesNothing: true,
      authorizesExecution: false,
      executedCode: false,
    });
    await this.verificationLedger.append(record);
    return { found: true, promoted: true, promotion: record, verification: latest.verification, artifact };
  }

  // One ledger read for the whole list: what each artifact's newest verification and promotion say.
  // A UI badge is drawn from this, and from nothing else.
  async verificationSummary() {
    const { records, corrupt } = await this.verificationLedger.list({ limit: 200 });
    const byArtifact = new Map();
    for (const record of [...records].reverse()) {
      const entry = byArtifact.get(record.artifactId) ?? { artifactId: record.artifactId, verified: false, verification: null, promotion: null, at: null };
      if (record.schema === WORKSHOP_VERIFICATION_SCHEMA) {
        entry.verification = { id: record.id, verified: record.verified === true, at: record.at, failed: record.failed ?? [] };
        entry.verified = record.verified === true;
        entry.at = record.at;
      } else if (record.schema === WORKSHOP_PROMOTION_SCHEMA) {
        entry.promotion = { id: record.id, at: record.at, verificationId: record.verificationId, reason: record.reason ?? null };
        entry.at = entry.at ?? record.at;
      }
      byArtifact.set(record.artifactId, entry);
    }
    return { available: true, corrupt, entries: [...byArtifact.values()] };
  }

  async verificationState(artifactId) {
    const latest = await this.verificationLedger.latestVerification(artifactId);
    const promotion = await this.verificationLedger.latestPromotion(artifactId);
    return {
      verified: latest.found === true && latest.verification.verified === true,
      verification: latest.found ? latest.verification : null,
      detail: latest.found ? null : (latest.detail ?? 'no verification is recorded'),
      promotion: promotion ?? null,
      schema: WORKSHOP_VERIFICATION_SCHEMA,
    };
  }

  async status() {
    const [storeStatus, ledger] = await Promise.all([
      this.store.status(),
      this.verificationLedger.list({ limit: 1 }).catch((err) => ({ total: 0, corrupt: 0, detail: err?.message ?? String(err) })),
    ]);
    return { ...storeStatus, verifications: ledger.total ?? 0 };
  }
}

export function createWorkshopService(options) {
  return new WorkshopService(options);
}
