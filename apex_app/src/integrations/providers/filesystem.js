// Metadata-only filesystem observation over explicitly configured roots. Nothing here reads file
// contents: a poll lists names, stats size/mtime/identity, and reports creation, modification,
// deletion and rename. Sensitive names are skipped before they are statted, symlinks are never
// followed, every traversal is bounded, and a truncated scan never reports files as deleted.
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../errors.js';
import {
  DEFAULT_COMMON_CONFIG, LIMITS, PERMISSIONS, PROVIDER_API_VERSION, SENSITIVE_FILE_RE, SENSITIVE_PATH_SEGMENTS,
} from '../vocabulary.js';
import {
  hash, integer, isoInstant, mergeCommon, optionalText, plainObject, stringList, text,
} from '../model.js';

const DEFAULTS = Object.freeze({
  ...DEFAULT_COMMON_CONFIG,
  roots: Object.freeze([]),
  extensions: Object.freeze(['md', 'txt', 'json', 'js']),
  exclude: Object.freeze([]),
  maxFiles: 500,
  maxDepth: 3,
  entityId: null,
});

function rootLabel(root, index) {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24);
  return `${base || 'root'}-${index + 1}`;
}

function sensitiveSegment(name) {
  return SENSITIVE_PATH_SEGMENTS.some((entry) => entry.toLowerCase() === String(name).toLowerCase());
}

function validateRoots(value) {
  const roots = stringList(value, 'roots', { max: LIMITS.maxRoots, each: 1024 });
  return roots.map((root, index) => {
    if (!path.isAbsolute(root)) throw new ValidationError(`root ${index + 1} must be an absolute path`);
    const resolved = path.resolve(root);
    if (path.parse(resolved).root === resolved) throw new ValidationError(`root ${index + 1} is a filesystem root; configure a narrower directory`);
    const parts = resolved.split(path.sep).filter(Boolean);
    const sensitive = parts.find((part) => sensitiveSegment(part));
    if (sensitive) throw new ValidationError(`root ${index + 1} passes through the excluded directory "${sensitive}"`);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (err) {
      throw new ValidationError(`root ${index + 1} cannot be read: ${err?.message ?? String(err)}`);
    }
    if (!stat.isDirectory()) throw new ValidationError(`root ${index + 1} is not a directory`);
    return resolved;
  });
}

function validate(config) {
  const merged = mergeCommon(DEFAULTS, config);
  const roots = validateRoots(merged.roots);
  const extensions = stringList(merged.extensions, 'extensions', { max: 20, each: 16 })
    .map((entry) => entry.replace(/^\./, '').toLowerCase())
    .filter((entry) => /^[a-z0-9][a-z0-9._-]{0,15}$/.test(entry));
  if (extensions.length === 0) throw new ValidationError('extensions must name at least one file extension');
  const exclude = stringList(merged.exclude, 'exclude', { max: 20, each: 64 });
  return {
    ...merged,
    roots,
    extensions: [...new Set(extensions)],
    exclude,
    maxFiles: integer(merged.maxFiles, 'maxFiles', { min: 1, max: LIMITS.maxFiles }),
    maxDepth: integer(merged.maxDepth, 'maxDepth', { min: 0, max: LIMITS.maxDepth }),
    entityId: optionalText(merged.entityId, 'entityId', 64),
  };
}

function scopeOf(config) {
  return hash({ roots: config.roots, extensions: config.extensions, exclude: config.exclude, maxDepth: config.maxDepth });
}

function fileExtension(name) {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ext || null;
}

function skipName(name, config) {
  return sensitiveSegment(name)
    || SENSITIVE_FILE_RE.test(name)
    || config.exclude.includes(name)
    || name.startsWith('~$');
}

async function scan(config, { signal } = {}) {
  const files = new Map();
  const warnings = [];
  let truncated = false;
  for (let rootIndex = 0; rootIndex < config.roots.length; rootIndex += 1) {
    const root = config.roots[rootIndex];
    const label = rootLabel(root, rootIndex);
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (signal?.aborted) throw Object.assign(new Error('filesystem scan was cancelled'), { code: 'ABORTED' });
      const { dir, depth } = queue.shift();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        // A missing or unreadable configured root is a provider failure, not evidence that every
        // file under it was deleted. Only a subdirectory failure is tolerated as a warning.
        if (depth === 0) throw new Error(`root ${label} cannot be read: ${err?.code ?? err?.message ?? 'read_error'}`);
        warnings.push(`${label}: ${err?.code ?? 'read_error'}`);
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        if (signal?.aborted) throw Object.assign(new Error('filesystem scan was cancelled'), { code: 'ABORTED' });
        if (skipName(entry.name, config)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth < config.maxDepth) queue.push({ dir: absolute, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = fileExtension(entry.name);
        if (extension === null || !config.extensions.includes(extension)) continue;
        if (files.size >= config.maxFiles) {
          truncated = true;
          break;
        }
        let stat;
        try {
          stat = await fs.promises.stat(absolute);
        } catch (err) {
          warnings.push(`${label}: ${err?.code ?? 'stat_error'}`);
          continue;
        }
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        const key = `${label}/${relative}`;
        files.set(key, {
          root: label,
          path: relative,
          extension,
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          ino: Number.isSafeInteger(stat.ino) ? stat.ino : 0,
          birthtimeMs: Math.trunc(stat.birthtimeMs),
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { files, truncated, warnings };
}

function observationFor(change, config, nowIso) {
  const { type, current, previous } = change;
  const file = {
    path: current?.path ?? previous.path,
    root: current?.root ?? previous.root,
    extension: current?.extension ?? previous.extension,
    size: current?.size ?? previous.size,
    modifiedAt: new Date(current?.mtimeMs ?? previous.mtimeMs).toISOString(),
  };
  if (type === 'file_renamed') file.previousPath = previous.path;
  const signature = type === 'file_deleted'
    ? `${previous.mtimeMs}:${previous.size}`
    : `${current.mtimeMs}:${current.size}`;
  const label = file.path;
  const summary = type === 'file_renamed'
    ? `file ${previous.path} was renamed to ${label}`
    : `file ${label} was ${type === 'file_created' ? 'created' : type === 'file_modified' ? 'modified' : 'deleted'}`;
  const payload = {
    file,
    source: { provider: 'filesystem', root: file.root },
  };
  if (config.entityId) {
    payload.worldEvent = {
      eventType: type,
      occurredAt: type === 'file_deleted' ? nowIso : file.modifiedAt,
      properties: { path: label, root: file.root, ...(file.previousPath ? { previousPath: file.previousPath } : {}) },
    };
  }
  return {
    key: `fs:${file.root}:${type}:${label}:${signature}`,
    type,
    category: 'external',
    summary,
    observedAt: type === 'file_deleted' ? nowIso : file.modifiedAt,
    payload,
    confidence: 0.95,
    entityRefs: config.entityId ? [config.entityId] : [],
  };
}

function previousState(checkpoint) {
  const files = checkpoint?.files && typeof checkpoint.files === 'object' ? checkpoint.files : {};
  return files;
}

async function poll({ config, checkpoint, now, signal }) {
  const nowIso = now().toISOString();
  const { files, truncated, warnings } = await scan(config, { signal });
  const old = previousState(checkpoint);
  const changes = [];
  const seen = new Set(files.keys());

  // Rename first: match a disappeared path to a new path by inode, then by creation time + size.
  const oldMissing = Object.keys(old).filter((key) => !seen.has(key));
  const newPaths = [...files.keys()].filter((key) => !old[key]);
  const usedOld = new Set();
  const usedNew = new Set();
  for (const newKey of newPaths) {
    const fresh = files.get(newKey);
    const match = oldMissing.find((oldKey) => !usedOld.has(oldKey) && old[oldKey].ino > 0 && old[oldKey].ino === fresh.ino)
      ?? oldMissing.find((oldKey) => !usedOld.has(oldKey)
        && old[oldKey].birthtimeMs > 0 && old[oldKey].birthtimeMs === fresh.birthtimeMs
        && old[oldKey].size === fresh.size && old[oldKey].root === fresh.root);
    if (!match) continue;
    usedOld.add(match);
    usedNew.add(newKey);
    changes.push({ type: 'file_renamed', current: fresh, previous: old[match], oldKey: match, newKey });
  }
  for (const [key, current] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (usedNew.has(key)) continue;
    if (!old[key]) changes.push({ type: 'file_created', current, newKey: key });
    else if (old[key].mtimeMs !== current.mtimeMs || old[key].size !== current.size) {
      changes.push({ type: 'file_modified', current, previous: old[key], newKey: key });
    }
  }
  if (!truncated) {
    for (const key of oldMissing) {
      if (usedOld.has(key)) continue;
      changes.push({ type: 'file_deleted', previous: old[key], oldKey: key });
    }
  }
  changes.sort((a, b) => {
    const keyA = a.current?.path ?? a.previous?.path ?? '';
    const keyB = b.current?.path ?? b.previous?.path ?? '';
    return keyA === keyB ? (a.type < b.type ? -1 : 1) : (keyA < keyB ? -1 : 1);
  });

  const applied = changes.slice(0, config.maxObservations);
  const pending = new Set(changes.slice(config.maxObservations).map((change) => (change.newKey ?? change.oldKey)));
  const next = { ...old };
  for (const change of applied) {
    if (change.type === 'file_deleted') delete next[change.oldKey];
    if (change.type === 'file_renamed') {
      delete next[change.oldKey];
      next[change.newKey] = change.current;
    }
    if (change.type === 'file_created' || change.type === 'file_modified') next[change.newKey] = change.current;
  }
  // Unchanged files keep their baseline. A path whose change did not fit in this poll keeps the old
  // baseline so the next poll sees it again instead of silently losing the change.
  for (const [key, current] of files) {
    if (pending.has(key)) continue;
    if (next[key] === undefined) next[key] = current;
  }

  return {
    observations: applied.map((change) => observationFor(change, config, nowIso)),
    checkpoint: {
      files: next,
      lastScanAt: nowIso,
      truncated,
    },
    health: {
      files: files.size,
      changes: changes.length,
      truncated,
      warnings: warnings.slice(0, 5),
    },
  };
}

export const filesystemProvider = Object.freeze({
  id: 'filesystem',
  name: 'Local filesystem metadata',
  apiVersion: PROVIDER_API_VERSION,
  permissions: Object.freeze([PERMISSIONS.FILESYSTEM_METADATA]),
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
      reads: 'names, sizes and modification times under explicitly configured roots',
      neverReads: 'file contents, credentials, symlinks, excluded directories',
      defaults: DEFAULTS,
    };
  },
});
