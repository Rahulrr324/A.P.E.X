// Configuration comes only from environment variables. Nothing is read from the
// repository, nothing is downloaded, and no network access happens at startup.
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from './errors.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 30000;
export const MODEL_PROVIDERS = Object.freeze(['openai', 'ollama']);

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
  };
}
