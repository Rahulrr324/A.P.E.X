// Configuration comes only from environment variables. Nothing is read from the
// repository, nothing is downloaded, and no network access happens at startup.
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from './errors.js';
import { resolveRoot } from './filesystem/path.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 30000;
export const MODEL_PROVIDERS = Object.freeze(['openai', 'ollama']);
export const DEFAULT_FILESYSTEM_MAX_READ_BYTES = 1_048_576; // 1 MB
export const FILESYSTEM_MAX_READ_BYTES_MAX = 10_485_760; // 10 MB
export const FILESYSTEM_LIST_DEFAULT_LIMIT = 200;
export const FILESYSTEM_LIST_MAX_LIMIT = 1000;
export function defaultDataDir() {
  return path.join(os.homedir(), '.apex', 'local-alpha');
}

function intEnv(env, name, fallback, min, max) {
  const raw = (env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ValidationError(`${name} must be a whole number`, 'INVALID_CONFIG');
  const n = Number(raw);
  if (n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`, 'INVALID_CONFIG');
  return n;
}

export function loadConfig(env = process.env) {
  const rawDir = (env.APEX_DATA_DIR || '').trim();
  const dataDir = rawDir ? path.resolve(rawDir) : defaultDataDir();

  // "openai" = any OpenAI-compatible chat server (llama.cpp's llama-server, or
  // Ollama's /v1 layer). "ollama" = Ollama's native API, with better errors.
  const provider = ((env.APEX_MODEL_PROVIDER || '').trim() || 'openai').toLowerCase();
  if (!MODEL_PROVIDERS.includes(provider)) {
    throw new ValidationError(`APEX_MODEL_PROVIDER must be one of: ${MODEL_PROVIDERS.join(', ')}`, 'INVALID_CONFIG');
  }

  const timeoutMs = intEnv(env, 'APEX_MODEL_TIMEOUT_MS', DEFAULT_MODEL_TIMEOUT_MS, 100, 600000);

  // Read-only filesystem inspection. The authorized root must be set explicitly; there is
  // no default, so the capability is absent unless the operator opts in. The root is resolved
  // once here, so it is fixed before any action runs, and it cannot be expanded by model output.
  let filesystemRoot = null;
  let filesystemMaxReadBytes = DEFAULT_FILESYSTEM_MAX_READ_BYTES;
  const rawRoot = (env.APEX_FILESYSTEM_ROOT || '').trim();
  if (rawRoot) {
    filesystemRoot = resolveRoot(rawRoot);
    filesystemMaxReadBytes = intEnv(
      env,
      'APEX_FILESYSTEM_MAX_READ_BYTES',
      DEFAULT_FILESYSTEM_MAX_READ_BYTES,
      4096,
      FILESYSTEM_MAX_READ_BYTES_MAX,
    );
  }

  return {
    dataDir,
    model: {
      url: (env.APEX_MODEL_URL || '').trim() || null,
      provider,
      name: (env.APEX_MODEL_NAME || '').trim() || 'local',
      timeoutMs,
      retries: intEnv(env, 'APEX_MODEL_RETRIES', 1, 0, 3),
      maxTokens: intEnv(env, 'APEX_MODEL_MAX_TOKENS', 512, 1, 8192),
      allowRemote: env.APEX_ALLOW_REMOTE_MODEL === '1',
    },
    contextTurns: intEnv(env, 'APEX_CONTEXT_TURNS', 6, 0, 50),
    filesystem: {
      root: filesystemRoot,
      maxReadBytes: filesystemMaxReadBytes,
      listDefaultLimit: FILESYSTEM_LIST_DEFAULT_LIMIT,
      listMaxLimit: FILESYSTEM_LIST_MAX_LIMIT,
    },
  };
}
