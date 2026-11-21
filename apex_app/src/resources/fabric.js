// Resource Fabric is the sole owner of actual resource telemetry and bounded reservations.
// It does not start inference, providers or services. It provides admission and telemetry only.
import fs from 'node:fs';
import os from 'node:os';

export const RESOURCE_FABRIC_SCHEMA = 'apex.resource-fabric/1';
export const RESOURCE_FIELDS = Object.freeze(['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes']);

function safeNumber(value, fallback = null) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class ResourceFabric {
  constructor({
    now = () => new Date(), statfs = fs.promises.statfs, totalMemory = os.totalmem,
    freeMemory = os.freemem, cpus = os.cpus,
    // T-35 Step 1: the load average the visual step-down ladder reads. It is injected like every
    // other source here so a test can state a strained machine without loading one.
    loadAverage = os.loadavg,
  } = {}) {
    this.now = now;
    this.statfs = statfs;
    this.totalMemory = totalMemory;
    this.freeMemory = freeMemory;
    this.cpus = cpus;
    this.loadAverage = loadAverage;
    this.reservations = new Map();
  }

  async telemetry({ storagePaths = [] } = {}) {
    const cpuList = this.cpus();
    const logicalCpuCount = Array.isArray(cpuList) ? cpuList.length : null;
    const totalMemory = safeNumber(this.totalMemory());
    const freeMemory = safeNumber(this.freeMemory());
    const storage = [];
    const uniquePaths = [...new Set((Array.isArray(storagePaths) ? storagePaths : []).slice(0, 8).map((value) => String(value)))];
    for (const target of uniquePaths) {
      try {
        const stat = await this.statfs(target);
        const blockSize = safeNumber(stat.bsize, 0);
        const available = safeNumber(stat.bavail, 0) * blockSize;
        const total = safeNumber(stat.blocks, 0) * blockSize;
        storage.push({ path: target, availableBytes: available, totalBytes: total, reported: true });
      } catch (error) {
        storage.push({ path: target, availableBytes: null, totalBytes: null, reported: false, reason: 'UNAVAILABLE' });
      }
    }
    // T-35 Step 1: the one-minute load average, read here so the fabric remains the sole owner of
    // machine telemetry. An unreadable load average is null, never zero: zero would be a claim that
    // the machine is idle.
    const load = (() => {
      try {
        const values = this.loadAverage();
        return Array.isArray(values) ? safeNumber(values[0]) : null;
      } catch {
        return null;
      }
    })();
    const loadPerCpu1m = load !== null && logicalCpuCount ? load / logicalCpuCount : null;
    return Object.freeze({
      schema: RESOURCE_FABRIC_SCHEMA,
      at: this.now().toISOString(),
      cpu: Object.freeze({
        logicalCount: safeNumber(logicalCpuCount),
        loadAverage1m: load,
        loadPerCpu1m,
        available: logicalCpuCount !== null ? true : false,
      }),
      memory: Object.freeze({ totalBytes: totalMemory, freeBytes: freeMemory, available: totalMemory !== null && freeMemory !== null }),
      gpu: Object.freeze({ available: false, reported: false, reason: 'NO_GPU_METADATA_PROVIDER' }),
      network: Object.freeze({ available: null, reported: false, reason: 'NO_NETWORK_TELEMETRY_PROVIDER' }),
      storage,
      reservations: this.reservations.size,
    });
  }

  reserve({ id, owner, capability, resourceBudget, actionBudget = null, expiresAt } = {}) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('reservation id is required');
    if (typeof owner !== 'string' || owner.length === 0) throw new TypeError('reservation owner is required');
    if (typeof capability !== 'string' || capability.length === 0) throw new TypeError('reservation capability is required');
    if (!resourceBudget || typeof resourceBudget !== 'object' || Array.isArray(resourceBudget)) throw new TypeError('resourceBudget is required');
    const budget = {};
    for (const key of RESOURCE_FIELDS) {
      const value = resourceBudget[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`resource budget ${key} must be non-negative`);
      budget[key] = value;
    }
    if (actionBudget !== null && (!Number.isInteger(actionBudget) || actionBudget < 0)) throw new TypeError('actionBudget must be non-negative');
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw new TypeError('expiresAt must be an ISO timestamp');
    if (Date.parse(expiresAt) <= this.now().getTime()) throw new TypeError('reservation expires in the past');
    if (this.reservations.has(id)) throw new TypeError('duplicate reservation id');
    const row = Object.freeze({ id, owner, capability, resourceBudget: budget, actionBudget, expiresAt, released: false });
    this.reservations.set(id, row);
    return { ...row, resourceBudget: { ...budget } };
  }

  release(id) {
    if (typeof id !== 'string') return { released: false, reason: 'UNKNOWN_RESERVATION' };
    const row = this.reservations.get(id);
    if (!row) return { released: false, reason: 'UNKNOWN_RESERVATION' };
    if (row.released) return { released: true, alreadyReleased: true };
    const releasedRow = Object.freeze({ ...row, released: true });
    this.reservations.set(id, releasedRow);
    return { released: true, alreadyReleased: false };
  }

  status() {
    const now = this.now().getTime();
    for (const [id, row] of this.reservations) {
      if (row.released === true || Date.parse(row.expiresAt) <= now) this.reservations.delete(id);
    }
    return { schema: RESOURCE_FABRIC_SCHEMA, reservations: this.reservations.size };
  }
}
