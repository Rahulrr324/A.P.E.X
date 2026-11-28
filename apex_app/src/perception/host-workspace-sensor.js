// T-32 Step 3 (2026-11-19): the host and workspace sensor.
//
// Perception, not inference. Every value here is read from the machine this process is actually
// running on (os, process, statfs) or from the git repository the owner pointed at, and every git
// read is a fixed-argument `execFileSync('git', ...)` with a hard timeout, no shell, and no
// interpolation of anything the caller supplies except the directory, which is resolved first.
//
// The sensor is read-only by construction: it opens no socket, starts no process other than the
// fixed git reads, writes nothing, and returns `null` rather than a guess when a reading is not
// available. A null is reported to the owner as unavailable; it is never silently turned into 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOST_SENSOR_SCHEMA = 'apex.host-workspace-sensor/1';
export const HOST_SENSOR_SOURCE = 'host-workspace-sensor';
export const HOST_SENSOR_TIMEOUT_MS = 2_000;

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeFloat(value, precision = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function gitRead(runner, args) {
  try {
    return { ok: true, text: String(runner(args) ?? '').trim() };
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'GIT_NOT_INSTALLED' : 'GIT_UNAVAILABLE' };
  }
}

// The workspace half of the reading. It reports counts and names only: no file contents, no diffs,
// no author identity, and nothing that is not already visible to whoever runs the process.
export function readWorkspaceGit(workspaceDir, { git } = {}) {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
    return Object.freeze({ available: false, reason: 'NO_WORKSPACE_ROOT' });
  }
  const root = path.resolve(workspaceDir);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return Object.freeze({ available: false, reason: 'WORKSPACE_ROOT_MISSING', root });
  if (typeof git !== 'function') return Object.freeze({ available: false, reason: 'NO_GIT_READER', root });

  const branch = gitRead(git, ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) return Object.freeze({ available: false, reason: branch.reason, root });
  const head = gitRead(git, ['-C', root, 'rev-parse', '--short', 'HEAD']);
  const status = gitRead(git, ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal']);
  const lastCommit = gitRead(git, ['-C', root, 'log', '-1', '--format=%cI']);

  let dirty = null;
  let untracked = null;
  if (status.ok) {
    const lines = status.text.length === 0 ? [] : status.text.split('\n');
    untracked = lines.filter((line) => line.startsWith('??')).length;
    dirty = lines.filter((line) => line.trim().length > 0 && !line.startsWith('??')).length;
  }
  return Object.freeze({
    available: true,
    root,
    branch: branch.text.length > 0 ? branch.text : null,
    head: head.ok && head.text.length > 0 ? head.text : null,
    dirtyFiles: dirty,
    untrackedFiles: untracked,
    lastCommitAt: lastCommit.ok && lastCommit.text.length > 0 ? lastCommit.text : null,
  });
}

export function createHostWorkspaceSensor({
  now = () => new Date(),
  workspaceDir = null,
  cpus = () => os.cpus(),
  loadAverage = () => os.loadavg(),
  totalMemory = () => os.totalmem(),
  freeMemory = () => os.freemem(),
  processUptime = () => process.uptime(),
  processMemory = () => process.memoryUsage(),
  statfsSync = (target) => fs.statfsSync(target),
  git = null,
  storagePaths = [],
} = {}) {
  const runner = git ?? ((args) => execFileSync('git', args, {
    encoding: 'utf8',
    timeout: HOST_SENSOR_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }));

  function hostReading() {
    const cpuList = cpus();
    const logicalCount = Array.isArray(cpuList) ? safeCount(cpuList.length) : null;
    const load = loadAverage();
    const load1m = Array.isArray(load) && Number.isFinite(load[0]) ? safeFloat(load[0]) : null;
    // Load is per-core normalised so a 4-core machine at 4.0 is 100%, not 400%.
    const loadPercent = load1m !== null && logicalCount ? safeFloat(Math.min(1, load1m / logicalCount), 4) : null;
    const total = totalMemory();
    const free = freeMemory();
    const totalBytes = safeCount(total);
    const freeBytes = safeCount(free);
    const usedBytes = totalBytes !== null && freeBytes !== null ? totalBytes - freeBytes : null;
    const usedPercent = totalBytes && usedBytes !== null ? safeFloat(usedBytes / totalBytes, 4) : null;
    const storage = [];
    const targets = [...new Set((Array.isArray(storagePaths) ? storagePaths : [])
      .filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 4))];
    for (const target of targets) {
      try {
        const stat = statfsSync(target);
        const blockSize = safeCount(Number(stat?.bsize)) ?? 0;
        storage.push(Object.freeze({
          path: target,
          totalBytes: safeCount(Number(stat?.blocks) * blockSize),
          availableBytes: safeCount(Number(stat?.bavail) * blockSize),
          reported: true,
        }));
      } catch {
        storage.push(Object.freeze({ path: target, totalBytes: null, availableBytes: null, reported: false, reason: 'UNAVAILABLE' }));
      }
    }
    const usage = processMemory();
    return Object.freeze({
      cpu: Object.freeze({ logicalCount, loadAverage1m: load1m, loadPercent }),
      memory: Object.freeze({ totalBytes, freeBytes, usedBytes, usedPercent }),
      storage: Object.freeze(storage),
      process: Object.freeze({
        pid: process.pid,
        uptimeSeconds: safeFloat(processUptime()),
        rssBytes: safeCount(usage?.rss),
        heapUsedBytes: safeCount(usage?.heapUsed),
      }),
    });
  }

  // One reading. Nothing is cached, so two calls a minute apart show the machine as it is then.
  function sense() {
    const at = now().toISOString();
    return Object.freeze({
      schema: HOST_SENSOR_SCHEMA,
      at,
      source: HOST_SENSOR_SOURCE,
      host: hostReading(),
      workspace: readWorkspaceGit(workspaceDir, { git: runner }),
    });
  }

  // The reading as epistemic entries. Each entry carries its own status and its own timestamp; the
  // value is what was read, and `null` means the reading was unavailable rather than zero.
  function observe() {
    const reading = sense();
    const entries = [];
    const push = (subject, value, unit, detail = null) => {
      entries.push(Object.freeze({
        subject,
        value,
        unit,
        detail,
        at: reading.at,
        source: HOST_SENSOR_SOURCE,
        epistemicStatus: value === null ? 'unavailable' : 'observed',
      }));
    };
    push('host.cpu.logical_count', reading.host.cpu.logicalCount, 'count');
    push('host.cpu.load_average_1m', reading.host.cpu.loadAverage1m, 'ratio_1m');
    push('host.cpu.load_percent', reading.host.cpu.loadPercent, 'ratio', 'load average divided by logical CPU count, capped at 1');
    push('host.memory.total_bytes', reading.host.memory.totalBytes, 'bytes');
    push('host.memory.free_bytes', reading.host.memory.freeBytes, 'bytes');
    push('host.memory.used_percent', reading.host.memory.usedPercent, 'ratio');
    for (const volume of reading.host.storage) {
      push(`host.storage.${volume.path}.available_bytes`, volume.availableBytes, 'bytes',
        volume.reported ? null : 'the filesystem did not answer a statfs call');
    }
    push('host.process.uptime_seconds', reading.host.process.uptimeSeconds, 'seconds');
    push('host.process.rss_bytes', reading.host.process.rssBytes, 'bytes');
    const workspace = reading.workspace;
    if (workspace.available) {
      push('workspace.git.branch', workspace.branch, 'name', workspace.root);
      push('workspace.git.head_short', workspace.head, 'commit', workspace.root);
      push('workspace.git.dirty_files', workspace.dirtyFiles, 'count', workspace.root);
      push('workspace.git.untracked_files', workspace.untrackedFiles, 'count', workspace.root);
      push('workspace.git.last_commit_at', workspace.lastCommitAt, 'instant', workspace.root);
    } else {
      // A missing git reading is recorded as a fact about the reading, not as a clean tree.
      push('workspace.git.available', null, 'flag', workspace.reason ?? null);
    }
    return Object.freeze({ reading, entries: Object.freeze(entries) });
  }

  return Object.freeze({ schema: HOST_SENSOR_SCHEMA, source: HOST_SENSOR_SOURCE, sense, observe, workspaceDir });
}
