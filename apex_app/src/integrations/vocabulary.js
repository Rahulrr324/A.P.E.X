// Closed vocabulary and hard bounds for T-11 external sources. A provider is a deterministic
// adapter over one explicitly configured scope; it is not an action, cannot execute anything, and
// emits only metadata observations that are handed to the existing situational-awareness contract.
export const INTEGRATION_SCHEMA = 'apex.integrations/1';
export const PROVIDER_API_VERSION = 'apex.integration.provider/1';

export const SOURCE = 'external_provider';

export const PROVIDER_IDS = Object.freeze(['filesystem', 'system_health', 'calendar', 'external_service']);

export const LIMITS = Object.freeze({
  maxProviders: 8,
  maxRoots: 5,
  maxPaths: 8,
  maxFiles: 2000,
  maxDepth: 8,
  maxObservationsPerPoll: 100,
  maxObservationsRead: 100,
  maxEventsRead: 100,
  maxCalendarEvents: 200,
  maxServiceObservations: 50,
  maxPayloadBytes: 4096,
  maxRecent: 20,
  maxErrors: 10,
  maxCheckpointFiles: 2000,
  maxFingerprints: 500,
  minIntervalMs: 1000,
  maxIntervalMs: 24 * 60 * 60 * 1000,
  defaultIntervalMs: 60 * 1000,
  defaultTimeoutMs: 3000,
  minTimeoutMs: 100,
  maxTimeoutMs: 30 * 1000,
  maxRetryAttempts: 3,
  baseRetryMs: 30 * 1000,
});

// Every provider must declare one of these before it can be enabled. Enabling is the user's grant.
export const PERMISSIONS = Object.freeze({
  FILESYSTEM_METADATA: 'filesystem.metadata.read',
  SYSTEM_METRICS: 'system.metrics.read',
  CALENDAR_SCHEDULE: 'calendar.schedule.read',
  NETWORK_OUTBOUND: 'network.outbound',
});

export const DEFAULT_COMMON_CONFIG = Object.freeze({
  intervalMs: LIMITS.defaultIntervalMs,
  timeoutMs: LIMITS.defaultTimeoutMs,
  maxObservations: 50,
  retry: Object.freeze({ maxAttempts: LIMITS.maxRetryAttempts, baseDelayMs: LIMITS.baseRetryMs }),
});

// Names skipped in any configured tree. They are never traversed, even when a root contains them.
export const SENSITIVE_PATH_SEGMENTS = Object.freeze([
  '.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', 'node_modules',
  'Windows', 'System32', 'ProgramData', 'Recovery', 'System Volume Information',
  '.config', '.cache', '.npm', '.pnpm-store', '.yarn',
]);

export const SENSITIVE_FILE_RE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.?netrc|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|pfx|p12|keystore|jks))$/i;

export const DEFAULT_CONFIG = Object.freeze({
  schema: INTEGRATION_SCHEMA,
  version: 1,
  paused: false,
  providers: Object.freeze({}),
});
