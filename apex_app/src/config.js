// Configuration comes only from environment variables. Nothing is read from the
// repository, nothing is downloaded, and no network access happens at startup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from './errors.js';
import { resolveRoot } from './filesystem/path.js';
import { parseWorkspaceSpec } from './filesystem/roots.js';
import { CONTROL_CHARS, singleLine } from './util.js';
import { CAPTURE_MODES, CAPTURE_OFF } from './experience/capture.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 30000;
export const MODEL_PROVIDERS = Object.freeze(['openai', 'ollama']);
export const DEFAULT_FILESYSTEM_MAX_READ_BYTES = 1_048_576; // 1 MB
export const FILESYSTEM_MAX_READ_BYTES_MAX = 10_485_760; // 10 MB
export const FILESYSTEM_LIST_DEFAULT_LIMIT = 200;
export const FILESYSTEM_LIST_MAX_LIMIT = 1000;
export function defaultDataDir() {
  return path.join(os.homedir(), '.apex', 'local-alpha');
}

// Isolated execution. A test, benchmark, or diagnostic can ask for it, and asking means the
// same thing every time: the data directory must have been named explicitly and must be inside
// the OS temporary directory, so the real user store cannot be reached even if a variable is
// missing or a value is inherited from a developer's shell. Unset or `0` is normal user
// operation, which is what a person running APEX on their own data expects. A value that is
// neither is a startup error rather than a silent downgrade to normal operation.
export function isolationRequested(env = process.env) {
  const raw = (env.APEX_DATA_ISOLATED || '').trim();
  if (raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  throw new ValidationError(
    `APEX_DATA_ISOLATED must be exactly 1 or 0, not ${singleLine(raw, 40)}; 1 isolates the run to a temporary data directory, 0 or unset is normal user operation`,
    'INVALID_CONFIG',
  );
}

// The path as the filesystem would report it, for a directory that does not exist yet: only the
// part that exists can be resolved, so the tail a run has not created is re-joined afterwards.
// This is what makes the isolation check about the real location rather than about a string -
// a link that leaves the temporary directory does not pass, and a short-name or case-differing
// spelling of the same temporary directory does.
function resolvedLocation(dir) {
  let existing = path.resolve(dir);
  const pending = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    pending.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try {
    real = fs.realpathSync(existing);
  } catch {
    // An ancestor that exists but cannot be resolved is still a location the run was not
    // shown to be inside the temporary directory, so the caller's check must be able to fail.
    real = existing;
  }
  return pending.length > 0 ? path.join(real, ...pending) : real;
}

export function tempRoot() {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    throw new ValidationError(
      'isolated execution needs a usable OS temporary directory, and the one this process reports could not be resolved',
      'INVALID_CONFIG',
    );
  }
}

// Windows treats two spellings that differ only in case as the same location, and the same
// temporary directory can be spelled with a different casing than os.tmpdir() reports, so
// containment is compared the way that filesystem compares it. Elsewhere the spelling is the
// location.
function isInsideRoot(real, root) {
  const a = process.platform === 'win32' ? real.toLowerCase() : real;
  const b = process.platform === 'win32' ? root.toLowerCase() : root;
  return a !== b && a.startsWith(`${b}${path.sep}`);
}

export function assertIsolatedDataDir(dataDir) {
  const root = tempRoot();
  const real = resolvedLocation(dataDir);
  if (!isInsideRoot(real, root)) {
    throw new ValidationError(
      `APEX_DATA_ISOLATED=1 requires a data directory inside the OS temporary directory (${root}) that is not the temporary root itself; "${dataDir}" is neither. Normal operation, including a persistent store of your own choosing, requires APEX_DATA_ISOLATED unset or 0`,
      'INVALID_CONFIG',
    );
  }
  return real;
}

function intEnv(env, name, fallback, min, max) {
  const raw = (env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ValidationError(`${name} must be a whole number between ${min} and ${max}`, 'INVALID_CONFIG');
  const n = Number(raw);
  if (n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`, 'INVALID_CONFIG');
  return n;
}

function autonomyLevelsEnv(env) {
  const raw = (env.APEX_AUTONOMY_LEVELS || '').trim();
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError('APEX_AUTONOMY_LEVELS must be a JSON object mapping domains to integers 0-5', 'INVALID_CONFIG');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('APEX_AUTONOMY_LEVELS must be a JSON object mapping domains to integers 0-5', 'INVALID_CONFIG');
  }
  const entries = Object.entries(value);
  if (entries.length > 32 || entries.some(([domain, level]) => !/^[a-z][a-z0-9_]{0,31}$/.test(domain)
    || !Number.isInteger(level) || level < 0 || level > 5)) {
    throw new ValidationError('APEX_AUTONOMY_LEVELS domains must be lowercase identifiers with integer levels 0-5 (maximum 32 domains)', 'INVALID_CONFIG');
  }
  return Object.fromEntries(entries);
}

export function loadConfig(env = process.env) {
  const isolated = isolationRequested(env);
  const rawDir = (env.APEX_DATA_DIR || '').trim();
  const dataDir = rawDir ? path.resolve(rawDir) : defaultDataDir();
  if (isolated) {
    // An unset variable is refused by name rather than resolved first: a test that redirects
    // HOME and USERPROFILE puts the *default* directory inside the temporary root, so the
    // containment check alone would accept the very fallback isolation exists to prevent.
    if (!rawDir) {
      throw new ValidationError(
        'APEX_DATA_ISOLATED=1 requires an explicit APEX_DATA_DIR; refusing to run isolated against the default home data directory',
        'INVALID_CONFIG',
      );
    }
    assertIsolatedDataDir(dataDir);
  }

  // "openai" = any OpenAI-compatible chat server (llama.cpp's llama-server, or
  // Ollama's /v1 layer). "ollama" = Ollama's native API, with better errors.
  const provider = ((env.APEX_MODEL_PROVIDER || '').trim() || 'openai').toLowerCase();
  if (!MODEL_PROVIDERS.includes(provider)) {
    throw new ValidationError(`APEX_MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(', ')}`, 'INVALID_CONFIG');
  }

  const timeoutMs = intEnv(env, 'APEX_MODEL_TIMEOUT_MS', DEFAULT_MODEL_TIMEOUT_MS, 100, 600000);
  // Optional. APEX has no tokenizer, so a budget is only enforced when the operator states the
  // model's context window; an estimate is not allowed to stand in for a declared limit. A window
  // no larger than the reserved output budget would refuse every request, which is a configuration
  // error to name at startup rather than a mystery failure on the first prompt.
  const maxTokens = intEnv(env, 'APEX_MODEL_MAX_TOKENS', 512, 1, 8192);
  const contextTokens = (env.APEX_MODEL_CONTEXT_TOKENS || '').trim()
    ? intEnv(env, 'APEX_MODEL_CONTEXT_TOKENS', null, 512, 10000000)
    : null;
  if (contextTokens !== null && contextTokens <= maxTokens) {
    throw new ValidationError(
      'APEX_MODEL_CONTEXT_TOKENS must be greater than APEX_MODEL_MAX_TOKENS; otherwise no prompt could fit the declared window',
      'INVALID_CONFIG',
    );
  }

  const modelUrl = (env.APEX_MODEL_URL || '').trim() || null;
  const modelName = (env.APEX_MODEL_NAME || '').trim();
  // The name is sent to the server verbatim, so it is validated as configuration rather
  // than carried into a request and rejected there.
  if (modelName.length > 200 || CONTROL_CHARS.test(modelName) || /[\r\n]/.test(modelName)) {
    throw new ValidationError('APEX_MODEL_NAME must be at most 200 characters without control characters or line breaks', 'INVALID_CONFIG');
  }
  // Ollama needs a real model name; the OpenAI-compatible default "local" is not a
  // valid Ollama model and would otherwise produce a misleading "ollama pull local"
  // suggestion only after a request was attempted.
  if (provider === 'ollama' && modelUrl && !modelName) {
    throw new ValidationError(
      'APEX_MODEL_NAME is required when APEX_MODEL_PROVIDER=ollama; set it to a model that the endpoint you configured serves',
      'INVALID_CONFIG',
    );
  }

  // Read-only filesystem inspection. The authorized root must be set explicitly; there is
  // no default, so the capability is absent unless the operator opts in. The root is resolved
  // once here, so it is fixed before any action runs, and it cannot be expanded by model output.
  let filesystemRoot = null;
  // Both filesystem settings are validated on every run, not only when a root is set:
  // a mistyped limit must be named at startup like every other setting, rather than
  // lying dormant until the capability is switched on.
  const filesystemMaxReadBytes = intEnv(
    env,
    'APEX_FILESYSTEM_MAX_READ_BYTES',
    DEFAULT_FILESYSTEM_MAX_READ_BYTES,
    4096,
    FILESYSTEM_MAX_READ_BYTES_MAX,
  );
  const rawRoot = (env.APEX_FILESYSTEM_ROOT || '').trim();
  if (rawRoot) filesystemRoot = resolveRoot(rawRoot);
  // Named roots are additional boundaries, never a replacement for the configured base: a
  // selector than cannot fall back to a default root would make every unnamed request ambiguous.
  const workspaceSpec = (env.APEX_WORKSPACES || '').trim();
  const workspaces = parseWorkspaceSpec(workspaceSpec);
  if (workspaces.length > 0 && filesystemRoot === null) {
    throw new ValidationError(
      'APEX_WORKSPACES requires APEX_FILESYSTEM_ROOT; the default root remains the base every relative path resolves against',
      'INVALID_CONFIG',
    );
  }

  // Whether APEX may record an experience of a verified outcome on its own. The default is `off`
  // for the same reason nothing else in APEX is on by default: a capability becomes active only
  // when the user decides it should. A mistyped value is a startup error rather than a silent
  // disable, so the operator is never left believing a setting they did not ask for.
  const experienceCapture = (env.APEX_EXPERIENCE_CAPTURE || '').trim().toLowerCase() || CAPTURE_OFF;
  if (!CAPTURE_MODES.includes(experienceCapture)) {
    throw new ValidationError(
      `APEX_EXPERIENCE_CAPTURE must be one of: ${CAPTURE_MODES.join(', ')}`,
      'INVALID_CONFIG',
    );
  }

  return {
    dataDir,
    // Which one of the two locations this is: a run that wrote where nothing told it to
    // should be able to say so. The CLI's default-store notice and the isolation refusal both
    // turn on this distinction, and it is recorded here rather than re-derived from `env`.
    dataDirIsDefault: !rawDir,
    isolated,
    model: {
      url: modelUrl,
      provider,
      name: modelName || 'local',
      timeoutMs,
      retries: intEnv(env, 'APEX_MODEL_RETRIES', 1, 0, 3),
      maxTokens,
      contextTokens,
      allowRemote: env.APEX_ALLOW_REMOTE_MODEL === '1',
    },
    contextTurns: intEnv(env, 'APEX_CONTEXT_TURNS', 6, 0, 50),
    autonomyByDomain: autonomyLevelsEnv(env),
    experienceCapture,
    filesystem: {
      root: filesystemRoot,
      workspaces,
      maxReadBytes: filesystemMaxReadBytes,
      listDefaultLimit: FILESYSTEM_LIST_DEFAULT_LIMIT,
      listMaxLimit: FILESYSTEM_LIST_MAX_LIMIT,
    },
  };
}
