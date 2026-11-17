// Closed vocabulary for T-12 content understanding. A content source is not an action and cannot
// grant itself permission: reading a file is an explicit second permission, separate from T-11
// metadata observation. Everything here is deterministic and bounded.
export const DOCUMENT_SCHEMA = 'apex.documents/1';
export const DOCUMENT_PERMISSION = 'filesystem.content.read';
export const CONTENT_PERMISSION = DOCUMENT_PERMISSION;
export const DOCUMENT_SOURCE = 'filesystem_content';
export const EXTRACTOR_ID = 'apex.deterministic-document-extractor';
export const EXTRACTOR_VERSION = 2;

export const LIMITS = Object.freeze({
  maxRoots: 5,
  maxFiles: 500,
  maxFileBytes: 4 * 1024 * 1024,
  maxTextChars: 200_000,
  maxSections: 200,
  maxCandidates: 20,
  maxDocuments: 500,
  maxVersions: 60,
  maxQueryResults: 20,
  maxResults: 10,
  maxExcerptChars: 700,
  maxContextChars: 1400,
  maxWarnings: 20,
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
});

export const DEFAULT_EXTENSIONS = Object.freeze([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'css', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sql',
  'sh', 'ps1', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp',
]);

export const DEFAULT_CONFIG = Object.freeze({
  schema: DOCUMENT_SCHEMA,
  version: 1,
  enabled: false,
  paused: false,
  roots: Object.freeze([]),
  extensions: DEFAULT_EXTENSIONS,
  exclude: Object.freeze([]),
  maxFiles: 200,
  maxBytes: LIMITS.maxFileBytes,
  entityId: null,
});

export const CANDIDATE_LABEL = 'document-derived candidate (not user-confirmed)';
