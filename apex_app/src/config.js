// Configuration comes only from environment variables. Nothing is read from
// the repository and no network access is made at startup.
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from './errors.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 30000;

export function defaultDataDir() {
  return path.join(os.homedir(), '.apex', 'local-alpha');
}

export function loadConfig(env = process.env) {
  const rawDir = (env.APEX_DATA_DIR || '').trim();
  const dataDir = rawDir ? path.resolve(rawDir) : defaultDataDir();

  let timeoutMs = DEFAULT_MODEL_TIMEOUT_MS;
  const rawTimeout = (env.APEX_MODEL_TIMEOUT_MS || '').trim();
  if (rawTimeout) {
    if (!/^\d+$/.test(rawTimeout)) {
      throw new ValidationError('APEX_MODEL_TIMEOUT_MS must be a whole number of milliseconds', 'INVALID_CONFIG');
    }
    timeoutMs = Number(rawTimeout);
    if (timeoutMs < 100 || timeoutMs > 600000) {
      throw new ValidationError('APEX_MODEL_TIMEOUT_MS must be between 100 and 600000', 'INVALID_CONFIG');
    }
  }

  return {
    dataDir,
    model: {
      url: (env.APEX_MODEL_URL || '').trim() || null,
      name: (env.APEX_MODEL_NAME || '').trim() || 'local',
      timeoutMs,
      allowRemote: env.APEX_ALLOW_REMOTE_MODEL === '1',
    },
  };
}
