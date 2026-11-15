// Named workspace roots. The configured root is still the only base a relative path may
// resolve against; this module makes that base selectable from a fixed set validated once
// at startup. A name is a selector, never an authorization: every root in the set is
// independently resolved, must exist, must be a directory, and may not be a volume root.
// Nothing in an action input can add a root or widen one.
import { ValidationError } from '../errors.js';
import { singleLine } from '../util.js';
import { resolveRoot, validateRoot } from './path.js';

export const DEFAULT_WORKSPACE = 'default';
export const MAX_WORKSPACES = 16;
const WORKSPACE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export function isWorkspaceName(value) {
  return typeof value === 'string' && WORKSPACE_NAME.test(value);
}

// `name=path` entries separated by a semicolon. The separator is not a path character on
// the platforms this runs on; a path containing one cannot be expressed, and that refusal
// is clearer than guessing which part was meant.
export function parseWorkspaceSpec(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const entries = [];
  const seen = new Set();
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new ValidationError(
        `APEX_WORKSPACES entry ${singleLine(entry, 80)} must be "name=absolute-path"`,
        'INVALID_CONFIG',
      );
    }
    const name = entry.slice(0, eq).trim().toLowerCase();
    const pathText = entry.slice(eq + 1).trim();
    if (!isWorkspaceName(name)) {
      throw new ValidationError(
        `APEX_WORKSPACES name ${singleLine(name, 40)} must start with a letter and contain only letters, digits, "_" or "-" (at most 32)`,
        'INVALID_CONFIG',
      );
    }
    if (name === DEFAULT_WORKSPACE) {
      throw new ValidationError(
        `APEX_WORKSPACES may not define "${DEFAULT_WORKSPACE}": APEX_FILESYSTEM_ROOT is the default root`,
        'INVALID_CONFIG',
      );
    }
    if (seen.has(name)) {
      throw new ValidationError(`APEX_WORKSPACES defines "${name}" more than once`, 'INVALID_CONFIG');
    }
    if (pathText.length === 0) {
      throw new ValidationError(`APEX_WORKSPACES entry "${name}" has no path`, 'INVALID_CONFIG');
    }
    seen.add(name);
    entries.push({ name, path: resolveRoot(pathText) });
  }
  if (entries.length > MAX_WORKSPACES) {
    throw new ValidationError(`APEX_WORKSPACES may define at most ${MAX_WORKSPACES} roots`, 'INVALID_CONFIG');
  }
  return entries;
}

// Build the immutable set every filesystem action closure captures. `root` is the
// APEX_FILESYSTEM_ROOT value (or an already parsed entry, for programmatic use); `extra`
// is the parsed APEX_WORKSPACES list. A duplicate real path under two names is allowed:
// they are two names for one boundary, never a wider one.
export function createWorkspaces({ root = null, extra = [] } = {}) {
  const byName = new Map();
  let defaultRoot = null;
  if (root !== null && root !== undefined) {
    defaultRoot = validateRoot(resolveRoot(root));
    byName.set(DEFAULT_WORKSPACE, defaultRoot);
  }
  for (const entry of extra ?? []) {
    const name = typeof entry === 'string' ? null : entry?.name;
    const pathText = typeof entry === 'string' ? entry : entry?.path;
    if (!isWorkspaceName(name) || name === DEFAULT_WORKSPACE) {
      throw new ValidationError(`invalid workspace name ${singleLine(String(name ?? ''), 40)}`, 'INVALID_CONFIG');
    }
    if (byName.has(name)) {
      throw new ValidationError(`workspace "${name}" is defined more than once`, 'INVALID_CONFIG');
    }
    byName.set(name, validateRoot(resolveRoot(pathText), `APEX_WORKSPACES "${name}"`));
  }
  if (byName.size === 0) return null;
  if (byName.size > MAX_WORKSPACES + 1) {
    throw new ValidationError(`at most ${MAX_WORKSPACES} named workspaces may be defined`, 'INVALID_CONFIG');
  }
  const names = [...byName.keys()].sort();
  const set = {
    defaultRoot,
    names,
    has(name) {
      return typeof name === 'string' && byName.has(name);
    },
    list() {
      return names.map((name) => ({
        name,
        path: byName.get(name),
        default: name === DEFAULT_WORKSPACE,
      }));
    },
    // An absent selector means the default root. An unknown name is refused, never
    // treated as a path or silently mapped to the default.
    pick(name) {
      if (name === undefined || name === null) {
        if (defaultRoot === null) {
          throw new ValidationError('no workspace was named and no default root is configured', 'INVALID_INPUT');
        }
        return defaultRoot;
      }
      if (!isWorkspaceName(name) || !byName.has(name)) {
        throw new ValidationError(`unknown workspace ${singleLine(String(name), 40)}`, 'INVALID_INPUT');
      }
      return byName.get(name);
    },
  };
  return Object.freeze(set);
}

// Validate the optional selector while an action's input is being checked, so an unknown
// name is an input rejection rather than an execution failure.
export function workspaceField(value, workspaces) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('workspace must be text');
  const name = value.trim().toLowerCase();
  if (!isWorkspaceName(name)) {
    throw new ValidationError('workspace must be a name of 1-32 letters, digits, "_" or "-", starting with a letter');
  }
  if (!workspaces.has(name)) throw new ValidationError(`unknown workspace "${singleLine(name, 40)}"`);
  return name;
}
