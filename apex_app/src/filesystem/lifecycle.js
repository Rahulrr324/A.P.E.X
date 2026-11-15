// Workspace lifecycle: create directories, move or rename entries, delete into a quarantine,
// restore from it, and apply a batch with a preflight that refuses before any change.
//
// These are the only actions that change the configured workspace, and every one of them is
// user-origin only and unplannable: a model may propose them, but the registry refuses that
// origin, and no plan step can contain one. Containment is the same boundary as the read
// actions: each named root is validated once at startup, every path is resolved and checked
// before an fs call, symlinks at the requested path are refused, and nothing is followed
// while scanning. Delete never erases: it renames the entry into .apex-trash inside the same
// root and writes a manifest, so every delete is reversible until the user removes the
// quarantine themselves. Nothing here executes a file or interprets its content.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError, ExecutionError } from '../errors.js';
import { resolveInside, resolveNewFile, isInside } from './path.js';
import { workspaceField } from './roots.js';
import { ORIGIN_USER } from '../actions/origins.js';
import {
  expectObject, pathField, displaySafe, ioCode, sha256, relativeTo, resolveForAction,
} from './workspace.js';

export const TRASH_DIR = '.apex-trash';
export const MAX_BATCH_ITEMS = 20;
export const MAX_TRASH_ENTRIES = 200;
export const MAX_MOVE_HASH_BYTES = 1_048_576;
const TRASH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// The quarantine is reserved at the top of every root. Without this, a delete could be
// pointed at the quarantine itself and a restore could overwrite the bookkeeping.
function isReservedInput(inputPath) {
  const segments = inputPath.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  return segments.length > 0 && segments[0].toLowerCase() === TRASH_DIR;
}

function refuseReserved(inputPath, verb) {
  if (isReservedInput(inputPath)) {
    throw new ValidationError(`"${TRASH_DIR}" is the workspace quarantine and cannot be ${verb}`, 'RESERVED_PATH');
  }
}

function trashPath(root) {
  return path.join(root, TRASH_DIR);
}

function describeEntry(realPath) {
  let stat;
  try {
    stat = fs.lstatSync(realPath);
  } catch (err) {
    throw new ExecutionError(ioCode(err), `the entry cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (stat.isSymbolicLink()) throw new ExecutionError('SYMLINK_REFUSED', 'refusing to operate on a symbolic link');
  if (stat.isFile()) {
    let digest = null;
    if (stat.size <= MAX_MOVE_HASH_BYTES) {
      try {
        digest = sha256(fs.readFileSync(realPath));
      } catch {
        digest = null;
      }
    }
    return { kind: 'file', size: stat.size, sha256: digest, entries: null };
  }
  if (stat.isDirectory()) {
    let entries = null;
    try {
      entries = fs.readdirSync(realPath).length;
    } catch {
      entries = null;
    }
    return { kind: 'directory', size: null, sha256: null, entries };
  }
  return { kind: 'other', size: stat.size, sha256: null, entries: null };
}

function ensureTrash(root) {
  const dir = trashPath(root);
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new ExecutionError(ioCode(err), `the quarantine cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (stat === null) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw new ExecutionError(ioCode(err), `the quarantine could not be created (${err?.code ?? 'error'})`);
    }
    try {
      stat = fs.lstatSync(dir);
    } catch (err) {
      throw new ExecutionError(ioCode(err), `the quarantine cannot be inspected (${err?.code ?? 'error'})`);
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ExecutionError('TRASH_UNAVAILABLE', `"${TRASH_DIR}" exists but is not a plain directory`);
  }
  const real = fs.realpathSync(dir);
  if (!isInside(real, root)) throw new ExecutionError('ACCESS_DENIED', 'the quarantine resolves outside the authorized root');
  return real;
}

function readManifest(itemDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(itemDir, 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.id !== 'string' || parsed.id !== path.basename(itemDir) || !TRASH_ID.test(parsed.id)) return null;
  if (typeof parsed.originalPath !== 'string' || parsed.originalPath.length === 0) return null;
  if (typeof parsed.deletedAt !== 'string' || parsed.deletedAt.length === 0) return null;
  if (!['file', 'directory', 'other'].includes(parsed.kind)) return null;
  return parsed;
}

function entryPresent(itemDir) {
  try {
    const stat = fs.lstatSync(path.join(itemDir, 'entry'));
    return !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---- mkdir planning ---------------------------------------------------------

function planMkdir(root, inputPath, parents) {
  refuseReserved(inputPath, 'created into');
  const joined = path.resolve(root, inputPath);
  if (joined === root) throw new ValidationError('path names the workspace root itself', 'INVALID_INPUT');
  if (!isInside(joined, root)) throw new ValidationError('path resolves outside the authorized root', 'ACCESS_DENIED');
  const segments = path.relative(root, joined).split(path.sep).filter(Boolean);
  if (segments.length === 0) throw new ValidationError('path names the workspace root itself', 'INVALID_INPUT');
  let current = root;
  let missingFrom = -1;
  for (let i = 0; i < segments.length; i += 1) {
    const next = path.join(current, segments[i]);
    let stat = null;
    try {
      stat = fs.lstatSync(next);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new ExecutionError(ioCode(err), `a path component cannot be inspected (${err?.code ?? 'error'})`);
    }
    if (stat === null) {
      missingFrom = i;
      break;
    }
    if (stat.isSymbolicLink()) throw new ValidationError('a path component is a symbolic link', 'ACCESS_DENIED');
    if (!stat.isDirectory()) {
      if (i === segments.length - 1) throw new ExecutionError('FILE_EXISTS', 'a file already exists at that path');
      throw new ValidationError('a path component is not a directory', 'PATH_NOT_FOUND');
    }
    const real = fs.realpathSync(next);
    if (!isInside(real, root)) throw new ValidationError('a path component resolves outside the authorized root', 'ACCESS_DENIED');
    current = real;
  }
  if (missingFrom === -1) throw new ExecutionError('FILE_EXISTS', 'the directory already exists');
  if (!parents && segments.length - missingFrom > 1) {
    throw new ValidationError('the parent directory does not exist', 'PATH_NOT_FOUND');
  }
  return { root, base: current, missing: segments.slice(missingFrom) };
}

// Creates only the missing components, one at a time, re-checking a component that another
// process created in the same window. Creation is ours from the moment it succeeds, so no
// link can appear in a component we made.
function doMkdir(plan) {
  let current = plan.base;
  const created = [];
  for (const segment of plan.missing) {
    const next = path.join(current, segment);
    try {
      fs.mkdirSync(next);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        let stat;
        try {
          stat = fs.lstatSync(next);
        } catch (again) {
          throw new ExecutionError(ioCode(again), `a path component cannot be inspected (${again?.code ?? 'error'})`);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new ExecutionError('FILE_EXISTS', 'the path was created by something else and is not a directory');
        }
        const real = fs.realpathSync(next);
        if (!isInside(real, plan.root)) throw new ExecutionError('ACCESS_DENIED', 'the created path resolves outside the authorized root');
        current = real;
        continue;
      }
      throw new ExecutionError(ioCode(err), `the directory could not be created (${err?.code ?? 'error'})`);
    }
    created.push(relativeTo(plan.root, next));
    current = next;
  }
  return { target: current, created };
}

// ---- move planning ----------------------------------------------------------

function planMove(root, from, to) {
  refuseReserved(from, 'moved');
  refuseReserved(to, 'a move destination');
  const source = resolveForAction(root, from);
  if (source === root) throw new ValidationError('the workspace root itself cannot be moved', 'INVALID_INPUT');
  const destination = resolveNewFile(root, to);
  if (destination.exists) throw new ExecutionError('FILE_EXISTS', 'the destination already exists; nothing was moved');
  if (destination.targetPath === source) throw new ValidationError('the source and destination are the same path', 'INVALID_INPUT');
  if (isInside(destination.targetPath, source)) {
    throw new ValidationError('the destination is inside the source directory', 'INVALID_DESTINATION');
  }
  return { root, from, to, source, target: destination.targetPath, entry: describeEntry(source) };
}

function doMove(plan) {
  try {
    fs.renameSync(plan.source, plan.target);
  } catch (err) {
    if (err?.code === 'EXDEV') throw new ExecutionError('CROSS_DEVICE_UNSUPPORTED', 'the destination is on another volume; nothing was moved');
    throw new ExecutionError(ioCode(err), `the entry could not be moved (${err?.code ?? 'error'})`);
  }
  return { target: plan.target };
}

// ---- delete and restore planning -------------------------------------------

function planDelete(root, from) {
  refuseReserved(from, 'deleted');
  const source = resolveForAction(root, from);
  if (source === root) throw new ValidationError('the workspace root itself cannot be deleted', 'INVALID_INPUT');
  const entry = describeEntry(source);
  return { root, from, source, entry, id: randomUUID() };
}

function doDelete(plan) {
  const trash = ensureTrash(plan.root);
  const itemDir = path.join(trash, plan.id);
  try {
    fs.mkdirSync(itemDir);
  } catch (err) {
    throw new ExecutionError(ioCode(err), `the quarantine entry could not be created (${err?.code ?? 'error'})`);
  }
  const manifest = {
    version: 1,
    id: plan.id,
    originalPath: relativeTo(plan.root, plan.source),
    name: path.basename(plan.source),
    kind: plan.entry.kind,
    size: plan.entry.size,
    sha256: plan.entry.sha256,
    deletedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(itemDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    try { fs.rmSync(itemDir, { recursive: true, force: true }); } catch { /* nothing else to remove */ }
    throw new ExecutionError(ioCode(err), `the quarantine manifest could not be written (${err?.code ?? 'error'})`);
  }
  try {
    fs.renameSync(plan.source, path.join(itemDir, 'entry'));
  } catch (err) {
    try { fs.rmSync(itemDir, { recursive: true, force: true }); } catch { /* nothing else to remove */ }
    if (err?.code === 'EXDEV') throw new ExecutionError('CROSS_DEVICE_UNSUPPORTED', 'the quarantine is on another volume; nothing was deleted');
    throw new ExecutionError(ioCode(err), `the entry could not be quarantined (${err?.code ?? 'error'})`);
  }
  return { itemDir, manifest };
}

function planRestore(root, id) {
  if (typeof id !== 'string' || !TRASH_ID.test(id)) throw new ValidationError('id must be a quarantine id (a UUID)');
  const dir = trashPath(root);
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new ExecutionError('TRASH_EMPTY', 'the workspace has no quarantine entries');
    throw new ExecutionError(ioCode(err), `the quarantine cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExecutionError('TRASH_UNAVAILABLE', `"${TRASH_DIR}" is not a plain directory`);
  const real = fs.realpathSync(dir);
  if (!isInside(real, root)) throw new ExecutionError('ACCESS_DENIED', 'the quarantine resolves outside the authorized root');
  const itemDir = path.join(real, id);
  let itemStat;
  try {
    itemStat = fs.lstatSync(itemDir);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new ExecutionError('TRASH_ITEM_NOT_FOUND', 'no quarantine entry has that id');
    throw new ExecutionError(ioCode(err), `the quarantine entry cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (itemStat.isSymbolicLink() || !itemStat.isDirectory()) throw new ExecutionError('TRASH_UNAVAILABLE', 'the quarantine entry is not a plain directory');
  const manifest = readManifest(itemDir);
  if (manifest === null) throw new ExecutionError('TRASH_MANIFEST_INVALID', 'the quarantine entry has no valid manifest');
  const entryPath = path.join(itemDir, 'entry');
  if (!entryPresent(itemDir)) throw new ExecutionError('TRASH_ITEM_MISSING', 'the quarantined entry is missing');
  const destination = resolveNewFile(root, manifest.originalPath);
  if (destination.exists) throw new ExecutionError('FILE_EXISTS', 'the original path is occupied; nothing was restored');
  return { root, id, itemDir, entryPath, target: destination.targetPath, manifest };
}

function doRestore(plan) {
  try {
    fs.renameSync(plan.entryPath, plan.target);
  } catch (err) {
    if (err?.code === 'EXDEV') throw new ExecutionError('CROSS_DEVICE_UNSUPPORTED', 'the original location is on another volume; nothing was restored');
    throw new ExecutionError(ioCode(err), `the entry could not be restored (${err?.code ?? 'error'})`);
  }
  let cleaned = true;
  try {
    fs.rmSync(plan.itemDir, { recursive: true, force: true });
  } catch {
    cleaned = false;
  }
  return { cleaned };
}

// ---- trash listing ----------------------------------------------------------

function readTrash(root) {
  const dir = trashPath(root);
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { present: false, items: [], unreadable: 0, truncated: false };
    throw new ExecutionError(ioCode(err), `the quarantine cannot be inspected (${err?.code ?? 'error'})`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExecutionError('TRASH_UNAVAILABLE', `"${TRASH_DIR}" is not a plain directory`);
  const real = fs.realpathSync(dir);
  if (!isInside(real, root)) throw new ExecutionError('ACCESS_DENIED', 'the quarantine resolves outside the authorized root');
  let dirents;
  try {
    dirents = fs.readdirSync(real, { withFileTypes: true }).sort(byName);
  } catch (err) {
    throw new ExecutionError(ioCode(err), `the quarantine cannot be listed (${err?.code ?? 'error'})`);
  }
  const kept = dirents.filter((d) => d.isDirectory() && !d.isSymbolicLink());
  const shown = kept.slice(0, MAX_TRASH_ENTRIES);
  const items = [];
  let unreadable = 0;
  for (const dirent of shown) {
    const itemDir = path.join(real, dirent.name);
    const manifest = readManifest(itemDir);
    if (manifest === null) {
      unreadable += 1;
      continue;
    }
    items.push({
      id: manifest.id,
      originalPath: manifest.originalPath,
      name: typeof manifest.name === 'string' ? manifest.name : path.basename(manifest.originalPath),
      kind: manifest.kind,
      size: Number.isInteger(manifest.size) ? manifest.size : null,
      deletedAt: manifest.deletedAt,
      entryPresent: entryPresent(itemDir),
    });
  }
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : (a.id < b.id ? -1 : 1)));
  return { present: true, items, unreadable, truncated: kept.length > shown.length };
}

function trashLines(items) {
  return items.map((item) => {
    const size = item.kind === 'file' && item.size !== null ? `, ${item.size} bytes` : '';
    const missing = item.entryPresent ? '' : ' [entry missing]';
    return `  ${item.id}  ${displaySafe(item.originalPath, 120)} (${item.kind}${size}) deleted ${item.deletedAt}${missing}`;
  });
}

// ---- filesystem.mkdir -------------------------------------------------------

export function mkdirAction(roots) {
  return {
    name: 'filesystem.mkdir',
    description: 'Create a directory inside an authorized workspace root. Write: user origin only; never replaces a file or follows a link.',
    inputHint: '{"path": "relative/dir", "workspace": optional root name, "parents": optional true to create missing parent directories}',
    permission: 'write',
    origins: [ORIGIN_USER],
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'parents']);
      if (o.parents !== undefined && typeof o.parents !== 'boolean') throw new ValidationError('parents must be true or false');
      return { path: pathField(o.path), workspace: workspaceField(o.workspace, roots), parents: o.parents === true };
    },
    async execute(_ctx, { path: inputPath, workspace, parents }) {
      const root = roots.pick(workspace);
      const plan = planMkdir(root, inputPath, parents);
      const done = doMkdir(plan);
      const list = done.created.map((p) => `"${p}"`).join(', ');
      return {
        summary: `created director${done.created.length === 1 ? 'y' : 'ies'} ${list}`,
        data: {
          path: inputPath,
          workspace,
          target: relativeTo(root, done.target),
          created: done.created,
          parents,
        },
        display: `Created ${done.created.length} director${done.created.length === 1 ? 'y' : 'ies'}: ${list}.\nNothing was overwritten, and no existing entry was changed.`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const resolved = resolveInside(root, input.path);
        if (resolved.isLink) return { ok: false, detail: 'the created path is now a symbolic link' };
        let stat;
        try {
          stat = fs.statSync(resolved.realPath);
        } catch {
          return { ok: false, detail: 'the created directory no longer exists' };
        }
        if (!stat.isDirectory()) return { ok: false, detail: 'the created path is not a directory' };
        if (relativeTo(root, resolved.realPath) !== result.data.target) {
          return { ok: false, detail: 'the created directory resolves to a different path than reported' };
        }
        for (const createdPath of result.data.created) {
          const check = resolveInside(root, createdPath);
          if (!fs.statSync(check.realPath).isDirectory()) return { ok: false, detail: `"${createdPath}" is not a directory` };
        }
        return { ok: true, detail: `${result.data.created.length} director${result.data.created.length === 1 ? 'y' : 'ies'} confirmed by an independent check` };
      } catch (err) {
        return { ok: false, detail: `the directory creation could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.move --------------------------------------------------------

export function moveAction(roots) {
  return {
    name: 'filesystem.move',
    description: 'Move or rename one entry inside an authorized workspace root. Write: user origin only; never overwrites and refuses a cross-root move.',
    inputHint: '{"path": "relative/source", "to": "relative/destination", "workspace": optional root name}',
    permission: 'write',
    origins: [ORIGIN_USER],
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['path', 'to', 'workspace']);
      return { path: pathField(o.path), to: pathField(o.to, 'to'), workspace: workspaceField(o.workspace, roots) };
    },
    async execute(_ctx, { path: from, to, workspace }) {
      const root = roots.pick(workspace);
      const plan = planMove(root, from, to);
      doMove(plan);
      return {
        summary: `moved "${from}" to "${to}" (${plan.entry.kind})`,
        data: {
          from,
          to,
          workspace,
          kind: plan.entry.kind,
          size: plan.entry.size,
          sha256: plan.entry.sha256,
          entries: plan.entry.entries,
        },
        display: `Moved "${from}" to "${to}" (${plan.entry.kind}).\nThis was a rename inside the workspace; content was not copied, interpreted, or executed.`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        let sourceStillExists = true;
        try {
          resolveForAction(root, input.path);
        } catch (err) {
          if (err?.code === 'PATH_NOT_FOUND') sourceStillExists = false;
          else throw err;
        }
        if (sourceStillExists) return { ok: false, detail: 'the source path still exists after the move' };
        const target = resolveForAction(root, input.to);
        const entry = describeEntry(target);
        if (entry.kind !== result.data.kind) return { ok: false, detail: `the destination is ${entry.kind}, not ${result.data.kind}` };
        if (result.data.sha256 !== null && entry.sha256 !== result.data.sha256) {
          return { ok: false, detail: 'the destination content differs from the moved entry' };
        }
        return { ok: true, detail: `source is gone and ${entry.kind} confirmed at the destination` };
      } catch (err) {
        return { ok: false, detail: `the move could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.delete ------------------------------------------------------

export function deleteAction(roots) {
  return {
    name: 'filesystem.delete',
    description: `Move one entry into the workspace quarantine (${TRASH_DIR}) instead of erasing it. Write: user origin only; reversible with filesystem.restore.`,
    inputHint: '{"path": "relative/entry", "workspace": optional root name}',
    permission: 'write',
    origins: [ORIGIN_USER],
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['path', 'workspace']);
      return { path: pathField(o.path), workspace: workspaceField(o.workspace, roots) };
    },
    async execute(_ctx, { path: from, workspace }) {
      const root = roots.pick(workspace);
      const plan = planDelete(root, from);
      const done = doDelete(plan);
      return {
        summary: `moved "${from}" to the quarantine (${done.manifest.kind}, id ${plan.id})`,
        data: {
          path: from,
          workspace,
          trashId: plan.id,
          originalPath: done.manifest.originalPath,
          kind: done.manifest.kind,
          size: done.manifest.size,
          deletedAt: done.manifest.deletedAt,
        },
        display: `Moved "${from}" to the workspace quarantine (${done.manifest.kind}).\nId: ${plan.id}\nNothing was erased. Restore it with "workspace restore ${plan.id}"; list quarantined entries with "workspace trash".`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        let present = true;
        try {
          resolveForAction(root, input.path);
        } catch (err) {
          if (err?.code === 'PATH_NOT_FOUND') present = false;
          else throw err;
        }
        if (present) return { ok: false, detail: 'the deleted path still exists' };
        const itemDir = path.join(trashPath(root), result.data.trashId);
        const manifest = readManifest(itemDir);
        if (manifest === null) return { ok: false, detail: 'the quarantine entry has no valid manifest' };
        if (manifest.originalPath !== result.data.originalPath) return { ok: false, detail: 'the quarantine manifest names a different original path' };
        if (!entryPresent(itemDir)) return { ok: false, detail: 'the quarantined entry is missing' };
        return { ok: true, detail: `the entry is gone from its path and present in the quarantine as ${result.data.trashId}` };
      } catch (err) {
        return { ok: false, detail: `the delete could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.restore -----------------------------------------------------

export function restoreAction(roots) {
  return {
    name: 'filesystem.restore',
    description: 'Restore one quarantined entry to the path recorded when it was deleted. Write: user origin only; refuses if that path is occupied.',
    inputHint: '{"id": "quarantine uuid", "workspace": optional root name}',
    permission: 'write',
    origins: [ORIGIN_USER],
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['id', 'workspace']);
      if (typeof o.id !== 'string' || o.id.trim().length === 0) throw new ValidationError('id is required');
      return { id: o.id.trim(), workspace: workspaceField(o.workspace, roots) };
    },
    async execute(_ctx, { id, workspace }) {
      const root = roots.pick(workspace);
      const plan = planRestore(root, id);
      const done = doRestore(plan);
      return {
        summary: `restored "${plan.manifest.originalPath}" from the quarantine`,
        data: {
          id,
          workspace,
          restoredPath: plan.manifest.originalPath,
          kind: plan.manifest.kind,
          cleaned: done.cleaned,
        },
        display: `Restored "${plan.manifest.originalPath}" (${plan.manifest.kind}) from quarantine id ${id}.${done.cleaned ? '' : '\nThe entry was restored, but its quarantine bookkeeping could not be fully removed; run "workspace trash" to inspect it.'}`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const restored = resolveForAction(root, result.data.restoredPath);
        const entry = describeEntry(restored);
        if (entry.kind !== result.data.kind) return { ok: false, detail: `the restored path is ${entry.kind}, not ${result.data.kind}` };
        let itemExists = true;
        try {
          fs.lstatSync(path.join(trashPath(root), input.id));
        } catch {
          itemExists = false;
        }
        if (itemExists) return { ok: false, detail: 'the quarantine entry still exists after the restore' };
        return { ok: true, detail: `${entry.kind} confirmed at the recorded path and the quarantine entry is gone` };
      } catch (err) {
        return { ok: false, detail: `the restore could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.trash -------------------------------------------------------

export function trashAction(roots) {
  return {
    name: 'filesystem.trash',
    description: 'List the workspace quarantine: what was deleted, when, and whether its entry is still present. Read-only.',
    inputHint: '{"workspace": optional root name, "limit": optional 1-200}',
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const o = expectObject(input, ['workspace', 'limit']);
      let limit = MAX_TRASH_ENTRIES;
      if (o.limit !== undefined) {
        if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > MAX_TRASH_ENTRIES) {
          throw new ValidationError(`limit must be an integer from 1 to ${MAX_TRASH_ENTRIES}`);
        }
        limit = o.limit;
      }
      return { workspace: workspaceField(o.workspace, roots), limit };
    },
    async execute(_ctx, { workspace, limit }) {
      const root = roots.pick(workspace);
      const trash = readTrash(root);
      const items = trash.items.slice(0, limit);
      const notes = [
        trash.truncated ? `showing ${items.length} of the entries under ${MAX_TRASH_ENTRIES}` : null,
        trash.unreadable > 0 ? `${trash.unreadable} entry(ies) have no readable manifest` : null,
        items.some((item) => !item.entryPresent) ? 'some entries are missing the quarantined item' : null,
      ].filter(Boolean);
      return {
        summary: `${trash.present ? items.length : 0} quarantined entr${items.length === 1 ? 'y' : 'ies'}${trash.present ? '' : ' (no quarantine directory)'}`,
        data: {
          workspace,
          present: trash.present,
          total: trash.items.length,
          limit,
          truncated: trash.truncated,
          unreadable: trash.unreadable,
          items,
        },
        display: `Workspace quarantine (${trash.items.length} entr${trash.items.length === 1 ? 'y' : 'ies'}):\n${items.length > 0 ? trashLines(items).join('\n') : '  (empty)'}${notes.length > 0 ? `\n  (${notes.join('; ')})` : ''}`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const fresh = readTrash(root);
        const actual = fresh.items.slice(0, result.data.limit);
        const claimed = result.data.items ?? [];
        if (actual.length !== claimed.length) return { ok: false, detail: 'the quarantine now has a different number of entries' };
        for (let i = 0; i < claimed.length; i += 1) {
          if (actual[i].id !== claimed[i].id || actual[i].entryPresent !== claimed[i].entryPresent) {
            return { ok: false, detail: 'the quarantine listing differs from an independent read' };
          }
        }
        return { ok: true, detail: `${claimed.length} quarantined entr${claimed.length === 1 ? 'y' : 'ies'} confirmed by an independent read` };
      } catch (err) {
        return { ok: false, detail: `the quarantine listing could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

// ---- filesystem.batch -------------------------------------------------------

function normaliseOperation(raw, index) {
  const where = `operation ${index + 1}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`${where} must be an object`);
  const type = raw.type;
  if (type === 'mkdir') {
    for (const key of Object.keys(raw)) {
      if (!['type', 'path', 'parents'].includes(key)) throw new ValidationError(`${where} has an unexpected field "${displaySafe(key, 40)}"`);
    }
    if (raw.parents !== undefined && typeof raw.parents !== 'boolean') throw new ValidationError(`${where}: parents must be true or false`);
    return { type, path: pathField(raw.path, `${where} path`), parents: raw.parents === true };
  }
  if (type === 'move') {
    for (const key of Object.keys(raw)) {
      if (!['type', 'path', 'to'].includes(key)) throw new ValidationError(`${where} has an unexpected field "${displaySafe(key, 40)}"`);
    }
    return { type, path: pathField(raw.path, `${where} path`), to: pathField(raw.to, `${where} to`) };
  }
  if (type === 'delete') {
    for (const key of Object.keys(raw)) {
      if (!['type', 'path'].includes(key)) throw new ValidationError(`${where} has an unexpected field "${displaySafe(key, 40)}"`);
    }
    return { type, path: pathField(raw.path, `${where} path`) };
  }
  throw new ValidationError(`${where}: type must be "mkdir", "move", or "delete"`);
}

// The batch is all-or-nothing up to this point: every plan is computed against the
// filesystem as it is when the batch starts, before anything is changed, and two operations
// may not touch the same source, the same destination, or a destination that is another
// operation's source. That is what stops a conflict from being resolved silently by list
// order. For the same reason a move or delete may not depend on a directory an earlier
// operation in the same batch creates: arrange that with separate calls, so the preflight
// always describes the state the batch actually starts from.
function planBatch(root, operations) {
  const plans = [];
  const problems = [];
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    try {
      if (op.type === 'mkdir') plans.push({ index: i, type: op.type, input: op, plan: planMkdir(root, op.path, op.parents) });
      else if (op.type === 'move') plans.push({ index: i, type: op.type, input: op, plan: planMove(root, op.path, op.to) });
      else plans.push({ index: i, type: op.type, input: op, plan: planDelete(root, op.path) });
    } catch (err) {
      if (err?.name === 'ValidationError' || err?.name === 'ExecutionError') throw new ValidationError(
        `batch refused before any change: operation ${i + 1} (${op.type}) ${err.message}`,
        'BATCH_PREFLIGHT_FAILED',
      );
      throw err;
    }
  }
  const sources = new Map();
  const targets = new Map();
  for (const entry of plans) {
    if (entry.type === 'move' || entry.type === 'delete') {
      if (sources.has(entry.plan.source)) problems.push(`operations ${sources.get(entry.plan.source) + 1} and ${entry.index + 1} use the same source`);
      sources.set(entry.plan.source, entry.index);
    }
    if (entry.type === 'move') {
      if (targets.has(entry.plan.target)) problems.push(`operations ${targets.get(entry.plan.target) + 1} and ${entry.index + 1} use the same destination`);
      targets.set(entry.plan.target, entry.index);
    }
    if (entry.type === 'mkdir') {
      const created = path.join(entry.plan.base, ...entry.plan.missing);
      if (targets.has(created)) problems.push(`operations ${targets.get(created) + 1} and ${entry.index + 1} use the same destination`);
      targets.set(created, entry.index);
    }
  }
  for (const [target, index] of targets) {
    if (sources.has(target)) problems.push(`operation ${index + 1} writes a path that operation ${sources.get(target) + 1} moves or deletes`);
    for (const [source, sourceIndex] of sources) {
      if (source !== target && isInside(target, source)) {
        problems.push(`operation ${index + 1} writes inside a directory that operation ${sourceIndex + 1} moves or deletes`);
      }
    }
  }
  if (problems.length > 0) {
    throw new ValidationError(`batch refused before any change: ${problems[0]}`, 'BATCH_PREFLIGHT_FAILED');
  }
  return plans;
}

function runOperation(entry) {
  if (entry.type === 'mkdir') {
    const done = doMkdir(entry.plan);
    return { target: relativeTo(entry.plan.root, done.target), created: done.created };
  }
  if (entry.type === 'move') {
    doMove(entry.plan);
    return { target: relativeTo(entry.plan.root, entry.plan.target), kind: entry.plan.entry.kind };
  }
  const done = doDelete(entry.plan);
  return { trashId: entry.plan.id, kind: done.manifest.kind };
}

function batchItemResult(entry) {
  const base = { index: entry.index, type: entry.type, path: entry.input.path };
  if (entry.type === 'move') base.to = entry.input.to;
  if (entry.type === 'mkdir') base.parents = entry.input.parents;
  return base;
}

export function batchAction(roots) {
  return {
    name: 'filesystem.batch',
    description: 'Apply up to twenty mkdir, move, or delete operations inside one authorized workspace root. Write: user origin only; the whole batch is refused before any change if one operation cannot be planned. Every source and destination parent must exist when the batch starts.',
    inputHint: `{"workspace": optional root name, "operations": [{"type": "mkdir", "path": "dir", "parents": optional true}, {"type": "move", "path": "a.txt", "to": "dir/a.txt"}, {"type": "delete", "path": "old.txt"}]}`,
    permission: 'write',
    origins: [ORIGIN_USER],
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['operations', 'workspace']);
      if (!Array.isArray(o.operations) || o.operations.length === 0) throw new ValidationError('operations must be a non-empty array');
      if (o.operations.length > MAX_BATCH_ITEMS) throw new ValidationError(`operations may contain at most ${MAX_BATCH_ITEMS} items`);
      const operations = o.operations.map((op, i) => normaliseOperation(op, i));
      return { operations, workspace: workspaceField(o.workspace, roots) };
    },
    async execute(_ctx, { operations, workspace }) {
      const root = roots.pick(workspace);
      const plans = planBatch(root, operations);
      const items = [];
      let partialError = null;
      for (const entry of plans) {
        const item = batchItemResult(entry);
        try {
          const done = runOperation(entry);
          items.push({ ...item, ok: true, ...done });
        } catch (err) {
          const code = typeof err?.code === 'string' ? err.code : 'EXECUTION_FAILED';
          items.push({ ...item, ok: false, error: { code, message: err?.message ?? String(err) } });
          if (partialError === null) partialError = { code, message: err?.message ?? String(err) };
        }
      }
      const done = items.filter((item) => item.ok).length;
      const failed = items.length - done;
      const lines = items.map((item) => {
        if (item.ok) {
          if (item.type === 'mkdir') return `  ok   mkdir ${displaySafe(item.path)} (${item.created.length} created)`;
          if (item.type === 'move') return `  ok   move ${displaySafe(item.path)} -> ${displaySafe(item.to)}`;
          return `  ok   delete ${displaySafe(item.path)} -> quarantine ${item.trashId}`;
        }
        return `  FAIL ${item.type} ${displaySafe(item.path)}: ${item.error.code}: ${displaySafe(item.error.message)}`;
      });
      return {
        summary: failed === 0
          ? `batch applied ${done} operation(s)`
          : `PARTIAL batch: ${done} of ${items.length} operations applied, ${failed} failed`,
        data: {
          workspace,
          complete: failed === 0,
          total: items.length,
          applied: done,
          failed,
          items,
        },
        display: `Batch (${items.length} operation(s)):\n${lines.join('\n')}${failed === 0 ? '' : `\nThe ${done} applied operation(s) remain in effect and are re-checked by the verifier; the failed ones changed nothing.${partialError === null ? '' : ` First failure: ${partialError.code}.`}`}`,
      };
    },
    async verify(_ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        for (const item of result.data.items ?? []) {
          if (item.ok) {
            if (item.type === 'mkdir') {
              const created = resolveInside(root, item.path);
              if (!fs.statSync(created.realPath).isDirectory()) return { ok: false, detail: `operation ${item.index + 1}: the directory is not present` };
            } else if (item.type === 'move') {
              try {
                resolveForAction(root, item.path);
                return { ok: false, detail: `operation ${item.index + 1}: the source still exists` };
              } catch (err) {
                if (err?.code !== 'PATH_NOT_FOUND') throw err;
              }
              const target = resolveForAction(root, item.to);
              if (describeEntry(target).kind !== item.kind) return { ok: false, detail: `operation ${item.index + 1}: the destination is not a ${item.kind}` };
            } else {
              try {
                resolveForAction(root, item.path);
                return { ok: false, detail: `operation ${item.index + 1}: the deleted path still exists` };
              } catch (err) {
                if (err?.code !== 'PATH_NOT_FOUND') throw err;
              }
              const manifest = readManifest(path.join(trashPath(root), item.trashId));
              if (manifest === null) return { ok: false, detail: `operation ${item.index + 1}: the quarantine entry has no valid manifest` };
            }
          } else if (item.type === 'mkdir') {
            let exists = false;
            try {
              fs.lstatSync(path.resolve(root, input.operations[item.index].path));
              exists = true;
            } catch {
              exists = false;
            }
            if (exists) return { ok: false, detail: `operation ${item.index + 1}: the failed mkdir left a path behind` };
          } else {
            try {
              resolveForAction(root, item.path);
            } catch (err) {
              if (err?.code === 'PATH_NOT_FOUND') {
                return { ok: false, detail: `operation ${item.index + 1}: the failed operation still changed its source` };
              }
              throw err;
            }
          }
        }
        if (result.data.complete === false) {
          return { ok: false, detail: `the batch was partial: ${result.data.applied} of ${result.data.total} operations applied and confirmed; ${result.data.failed} changed nothing` };
        }
        return { ok: true, detail: `${result.data.applied} batch operation(s) confirmed by independent checks` };
      } catch (err) {
        return { ok: false, detail: `the batch could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

export function lifecycleActions(roots) {
  return [
    mkdirAction(roots),
    moveAction(roots),
    deleteAction(roots),
    restoreAction(roots),
    trashAction(roots),
    batchAction(roots),
  ];
}
