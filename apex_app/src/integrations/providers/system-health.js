// Read-only local system health. It uses Node's own os/process values and fs.statfs, never a
// privileged command, a shell, a service or a network call. Only threshold transitions and a bounded
// periodic summary become observations, so polling does not turn into an alert stream.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from '../../errors.js';
import { DEFAULT_COMMON_CONFIG, LIMITS, PERMISSIONS, PROVIDER_API_VERSION } from '../vocabulary.js';
import { hash, integer, mergeCommon, number, optionalText, stringList } from '../model.js';

const DEFAULTS = Object.freeze({
  ...DEFAULT_COMMON_CONFIG,
  paths: Object.freeze([]),
  memoryPercent: 90,
  diskPercent: 10,
  summaryIntervalMs: 15 * 60 * 1000,
  entityId: null,
});

function validate(config) {
  const merged = mergeCommon(DEFAULTS, config);
  const paths = stringList(merged.paths, 'paths', { max: LIMITS.maxPaths, each: 1024 }).map((entry, index) => {
    if (!path.isAbsolute(entry)) throw new ValidationError(`path ${index + 1} must be an absolute path`);
    const resolved = path.resolve(entry);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('not a file or directory');
    } catch (err) {
      throw new ValidationError(`path ${index + 1} cannot be inspected: ${err?.message ?? String(err)}`);
    }
    return resolved;
  });
  return {
    ...merged,
    paths,
    memoryPercent: number(merged.memoryPercent, 'memoryPercent', { min: 1, max: 100 }),
    diskPercent: number(merged.diskPercent, 'diskPercent', { min: 1, max: 100 }),
    summaryIntervalMs: integer(merged.summaryIntervalMs, 'summaryIntervalMs', { min: 60_000, max: 24 * 60 * 60 * 1000 }),
    entityId: optionalText(merged.entityId, 'entityId', 64),
  };
}

function scopeOf(config) {
  // A different path scope must invalidate the disk-pressure baseline; thresholds alone need not.
  return hash({ paths: config.paths });
}

async function diskMetrics(paths) {
  const rows = [];
  for (let index = 0; index < paths.length; index += 1) {
    const target = paths[index];
    try {
      const stats = await fs.promises.statfs(target);
      const total = Number(stats.blocks) * Number(stats.bsize);
      const available = Number(stats.bavail) * Number(stats.bsize);
      if (!(total > 0)) {
        rows.push({ label: `disk-${index + 1}`, available: false, detail: 'the filesystem reported no capacity' });
        continue;
      }
      const freePercent = Math.max(0, Math.min(100, (available / total) * 100));
      rows.push({
        label: `disk-${index + 1}`,
        available: true,
        freePercent: Math.round(freePercent * 100) / 100,
        freeBytes: Math.max(0, available),
        totalBytes: total,
      });
    } catch (err) {
      rows.push({ label: `disk-${index + 1}`, available: false, detail: err?.code ?? 'statfs unavailable' });
    }
  }
  return rows;
}

function memoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = total > 0 ? ((total - free) / total) * 100 : 0;
  return {
    totalBytes: total,
    freeBytes: free,
    usedPercent: Math.round(usedPercent * 100) / 100,
  };
}

function processMetrics() {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    node: process.version,
  };
}

function withWorldEvent(payload, config, type, nowIso, properties) {
  if (config.entityId) {
    payload.worldEvent = { eventType: type, occurredAt: nowIso, properties };
  }
}

async function poll({ config, checkpoint, now, signal }) {
  if (signal?.aborted) throw Object.assign(new Error('system health poll was cancelled'), { code: 'ABORTED' });
  const at = now();
  const nowIso = at.toISOString();
  const memory = memoryMetrics();
  const disk = await diskMetrics(config.paths);
  const processInfo = processMetrics();
  const previous = checkpoint ?? {};
  const memoryPressure = memory.usedPercent >= config.memoryPercent;
  const diskState = {};
  const observations = [];

  if (memoryPressure !== (previous.memoryPressure === true)) {
    const type = memoryPressure ? 'system_memory_pressure' : 'system_memory_recovered';
    const payload = {
      metric: 'memory_used_percent',
      value: memory.usedPercent,
      threshold: config.memoryPercent,
    };
    withWorldEvent(payload, config, type, nowIso, { usedPercent: memory.usedPercent, threshold: config.memoryPercent });
    observations.push({
      key: `health:${type}:${config.memoryPercent}`,
      type,
      category: 'system',
      summary: memoryPressure
        ? `memory use is ${memory.usedPercent}%, at or above the ${config.memoryPercent}% threshold`
        : `memory use fell to ${memory.usedPercent}%, below the ${config.memoryPercent}% threshold`,
      observedAt: nowIso,
      payload,
      confidence: 0.9,
      entityRefs: config.entityId ? [config.entityId] : [],
    });
  }
  for (const row of disk) {
    if (!row.available) continue;
    const pressure = row.freePercent <= config.diskPercent;
    const key = `${row.label}:${config.diskPercent}`;
    const was = previous.disk?.[key] === true;
    diskState[key] = pressure;
    if (pressure === was) continue;
    const type = pressure ? 'system_disk_pressure' : 'system_disk_recovered';
    const payload = {
      metric: 'disk_free_percent',
      volume: row.label,
      value: row.freePercent,
      threshold: config.diskPercent,
      freeBytes: row.freeBytes,
      totalBytes: row.totalBytes,
    };
    withWorldEvent(payload, config, type, nowIso, { volume: row.label, freePercent: row.freePercent, threshold: config.diskPercent });
    observations.push({
      key: `health:${row.label}:${type}:${config.diskPercent}`,
      type,
      category: 'system',
      summary: pressure
        ? `disk ${row.label} has ${row.freePercent}% free, at or below the ${config.diskPercent}% threshold`
        : `disk ${row.label} recovered to ${row.freePercent}% free`,
      observedAt: nowIso,
      payload,
      confidence: 0.9,
      entityRefs: config.entityId ? [config.entityId] : [],
    });
  }

  const lastSummary = previous.lastSummaryAt ? Date.parse(previous.lastSummaryAt) : null;
  if (lastSummary === null || at.getTime() - lastSummary >= config.summaryIntervalMs) {
    const payload = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
      memory,
      disk,
      process: processInfo,
    };
    withWorldEvent(payload, config, 'system_health_observed', nowIso, { memoryPercent: memory.usedPercent });
    observations.push({
      key: `health:summary:${nowIso}`,
      type: 'system_health_observed',
      category: 'system',
      summary: `system health: memory ${memory.usedPercent}% used, ${disk.filter((row) => row.available).length} disk volume(s) inspected`,
      observedAt: nowIso,
      payload,
      confidence: 0.9,
      entityRefs: config.entityId ? [config.entityId] : [],
    });
  }

  return {
    observations,
    checkpoint: {
      memoryPressure,
      disk: diskState,
      lastSummaryAt: observations.some((row) => row.type === 'system_health_observed') ? nowIso : previous.lastSummaryAt ?? null,
      lastMetrics: { memory, disk, process: processInfo },
    },
    health: { memoryPercent: memory.usedPercent, disks: disk, observations: observations.length },
  };
}

export const systemHealthProvider = Object.freeze({
  id: 'system_health',
  name: 'Local system health',
  apiVersion: PROVIDER_API_VERSION,
  permissions: Object.freeze([PERMISSIONS.SYSTEM_METRICS]),
  defaults: DEFAULTS,
  validate,
  scopeOf,
  async poll(ctx) { return poll(ctx); },
  describe() {
    return {
      id: this.id,
      name: this.name,
      apiVersion: this.apiVersion,
      permissions: this.permissions,
      kind: 'real',
      reads: 'memory, process and filesystem capacity values from Node and fs.statfs',
      neverReads: 'files, credentials or another process\'s memory',
      defaults: DEFAULTS,
    };
  },
});
