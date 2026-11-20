// T-33 Step 3 (2026-11-19): deterministic sandbox verification for a Workshop artifact.
//
// The Workshop stores design sheets and answers arithmetic questions about them. This module is the
// step between "the sheet is stored" and "the sheet is fit to apply": a fixed list of checks, each
// one an assertion about the stored record and the reports the Workshop already derives from it.
// Nothing is executed, no code is run, and no check contacts anything outside the record.
//
// The rule the UI depends on (Part 4, Principle #7 - honest cinema): `verified` is true only when
// *every* check passed, and the record that says so is written before any surface may show a badge.
// A verification that failed is recorded too - a failure is evidence, not a missing record.
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonlStore } from '../memory/jsonl-store.js';

export const WORKSHOP_VERIFICATION_SCHEMA = 'apex.workshop.verification/1';
export const WORKSHOP_PROMOTION_SCHEMA = 'apex.workshop.promotion/1';
export const WORKSHOP_VERIFICATION_LEDGER = 'workshop-verifications.jsonl';
export const MAX_VERIFICATION_RECORDS = 5_000;

// The checks, in the order they are reported. Each one names what it asserts, so a reader can see
// what "verified" means for this artifact rather than trusting the word.
export const WORKSHOP_CHECKS = Object.freeze([
  Object.freeze({ id: 'structure_declared', asserts: 'the sheet declares at least one component and its ids are unique' }),
  Object.freeze({ id: 'connections_resolve', asserts: 'every connection names two declared components' }),
  Object.freeze({ id: 'no_isolated_components', asserts: 'no component is disconnected from the rest of the sheet' }),
  Object.freeze({ id: 'no_feedback_loops', asserts: 'the connections contain no cycle' }),
  Object.freeze({ id: 'supply_meets_demand', asserts: 'every component receives at least what it demands' }),
  Object.freeze({ id: 'budget_within_limit', asserts: 'the declared cost fits inside the declared budget, when one is declared' }),
]);

function integer(value) {
  return Number.isFinite(value) ? value : null;
}

// Pure: the same artifact and the same reports always produce the same verification record, apart
// from its identity and timestamp (which are the caller's clock).
export function verifyArtifact(artifact, inspection, simulation, { now = () => new Date(), idFactory = randomUUID } = {}) {
  if (!artifact || typeof artifact !== 'object') throw new TypeError('verifyArtifact needs a stored artifact');
  const components = Array.isArray(artifact.components) ? artifact.components : [];
  const connections = Array.isArray(artifact.connections) ? artifact.connections : [];
  const byId = new Set(components.map((component) => component.id));
  const uniqueIds = byId.size === components.length;
  const resolvedConnections = connections.filter((connection) => byId.has(connection.from) && byId.has(connection.to));
  const counts = inspection?.counts ?? {};
  const simulationComponents = Array.isArray(simulation?.components) ? simulation.components : [];
  const short = simulationComponents.filter((component) => component.satisfied !== true);
  const budget = simulation?.budget ?? null;

  const results = [
    { id: 'structure_declared', passed: components.length > 0 && uniqueIds,
      detail: `${components.length} component(s); ${uniqueIds ? 'ids are unique' : 'ids repeat'}` },
    { id: 'connections_resolve', passed: resolvedConnections.length === connections.length,
      detail: `${resolvedConnections.length} of ${connections.length} connection(s) name declared components` },
    { id: 'no_isolated_components', passed: Number.isInteger(counts.isolated) && counts.isolated === 0,
      detail: Number.isInteger(counts.isolated) ? `${counts.isolated} isolated component(s)` : 'the inspection did not report isolation' },
    { id: 'no_feedback_loops', passed: Number.isInteger(counts.cycles) && counts.cycles === 0,
      detail: Number.isInteger(counts.cycles) ? `${counts.cycles} feedback loop(s)` : 'the inspection did not report cycles' },
    { id: 'supply_meets_demand', passed: short.length === 0,
      detail: short.length === 0 ? 'every component is supplied' : `${short.length} component(s) short: ${short.map((component) => component.id).join(', ')}` },
    { id: 'budget_within_limit', passed: budget === null || budget.overBudget !== true,
      detail: budget === null ? 'no budget is declared' : `${budget.spent} of ${budget.total}${budget.overBudget ? ' (over)' : ''}` },
  ];

  const verified = results.every((result) => result.passed === true);
  const at = now().toISOString();
  return Object.freeze({
    schema: WORKSHOP_VERIFICATION_SCHEMA,
    kind: 'verification',
    id: `wsv-${createHash('sha256').update(`${artifact.artifactId}:${at}:${idFactory()}`).digest('hex').slice(0, 12)}`,
    artifactId: artifact.artifactId,
    identityDigest: artifact.identityDigest,
    at,
    verified,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).map((result) => result.id),
    checks: Object.freeze(results.map((result) => Object.freeze(result))),
    metrics: Object.freeze({
      components: components.length,
      connections: connections.length,
      kinds: integer(counts.kinds),
      isolated: integer(counts.isolated),
      cycles: integer(counts.cycles),
      shortComponents: short.length,
      budgetSpent: budget === null ? null : budget.spent,
      budgetTotal: budget === null ? null : budget.total,
      status: simulation?.status ?? 'unavailable',
    }),
    // A verification is an account of a check. It authorizes nothing and runs nothing.
    authorizesExecution: false,
    executedCode: false,
  });
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'workshop verification record must be an object';
  if (record.schema !== WORKSHOP_VERIFICATION_SCHEMA && record.schema !== WORKSHOP_PROMOTION_SCHEMA) return 'unknown verification record schema';
  if (typeof record.artifactId !== 'string' || record.artifactId.length === 0) return 'a verification record needs an artifact id';
  if (typeof record.id !== 'string' || record.id.length === 0) return 'a verification record needs an id';
  if (record.authorizesExecution !== false) return 'a verification may never authorize execution';
  if (record.executedCode !== false) return 'a verification may never claim code ran';
  if (record.schema === WORKSHOP_VERIFICATION_SCHEMA && typeof record.verified !== 'boolean') return 'a verification must state whether it passed';
  return null;
}

// The ledger is its own append-only file beside the workshop log, so verifying a design never
// rewrites the design. The same JsonlStore the rest of APEX uses, with the same corrupt-line rule.
export class WorkshopVerificationLedger {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.log = new JsonlStore(filePath, { validateRecord });
    this.capped = false;
  }

  static pathFor(dataDir) {
    return path.join(dataDir, WORKSHOP_VERIFICATION_LEDGER);
  }

  async append(record) {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) throw new Error(`the verification ledger holds ${corrupt.length} corrupt line(s)`);
    if (records.length >= MAX_VERIFICATION_RECORDS) throw new Error('the verification ledger is at its bound');
    const line = this.log.append(record);
    this.capped = records.length + 1 >= MAX_VERIFICATION_RECORDS;
    return line;
  }

  async list({ limit = 20 } = {}) {
    const { records, corrupt } = await this.log.load();
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 20;
    return { records: records.slice(-bounded).reverse(), total: records.length, corrupt: corrupt.length };
  }

  // The newest verification for one artifact, read back from the ledger rather than remembered.
  async latestVerification(artifactId) {
    const { records, corrupt } = await this.log.load();
    if (corrupt.length > 0) return { found: false, corrupt: corrupt.length, detail: `${corrupt.length} corrupt line(s)` };
    const matches = records.filter((record) => record.schema === WORKSHOP_VERIFICATION_SCHEMA && record.artifactId === artifactId);
    if (matches.length === 0) return { found: false, detail: 'no verification has been recorded for this artifact' };
    return { found: true, verification: matches[matches.length - 1] };
  }

  async latestPromotion(artifactId) {
    const { records } = await this.log.load();
    const matches = records.filter((record) => record.schema === WORKSHOP_PROMOTION_SCHEMA && record.artifactId === artifactId);
    return matches.length === 0 ? null : matches[matches.length - 1];
  }
}
