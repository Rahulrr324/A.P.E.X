// Credential-looking text. APEX refuses to store such text in memory or knowledge,
// replaces a conversation turn's text that contains one, omits it from the audit
// `request` field, and removes matching substrings from an audit `output` before it is
// written (marking the record `outputMinimized`). These patterns are a heuristic safety
// net, not a guarantee; they catch the common formats (private keys, cloud and API keys,
// bearer tokens, "password: x").
//
// One boundary is deliberately wider than "never anywhere": a request is still answered,
// so its text (including a credential the user typed) is sent to the configured model,
// and the model's answer is still shown to the user. Detection protects what is persisted
// and shown in diagnostics, not the model call or the user's own terminal.

const SECRET_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'api-key-token', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // base64url and JWT payloads use `_` as well as `-`, so a token that contains an underscore is
  // still a bearer token; omitting it from this class let such a value through undetected.
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/_-]{20,}=*/i },
  { name: 'assigned-secret', re: /\b(?:api[_-]?key|secret|token|passwd|password|pin)\s*(?:is\s*|[:=]\s*)["']?[^\s"']{6,}/i },
];

export function findSecrets(text) {
  const s = String(text);
  return SECRET_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name);
}

export function containsSecret(text) {
  return findSecrets(text).length > 0;
}

export function redactSecrets(text) {
  let s = String(text);
  for (const p of SECRET_PATTERNS) {
    s = s.replace(new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`), '[redacted-secret]');
  }
  return s;
}

// ---- the persistence mask (Batch AF) ----------------------------------------
//
// One mask for anything that is about to become bytes on disk. It is applied at the audit write
// boundary, so a field does not have to be named anywhere for a credential to stay out of the log:
// every string leaf is tested by content, and a value whose field name alone says it is a
// credential is omitted even when its content matches no pattern. Bounded by depth and by a node
// budget, because this runs on every audited operation, and deterministic: the same input always
// produces the same bytes, and masking something already masked changes nothing.
//
// The whole string is replaced, not the matched part, because a match does not bound the value:
// a private-key pattern names only its header, and an assignment usually sits beside other
// secrets in the same sentence. The one place that keeps surrounding prose is the audit `output`
// field, which is handled by its own rule in operations/operation-log.js.

export const SECRET_OMITTED = '[omitted: contained a password, key, or token]';
export const MASK_BOUND_REACHED = '[omitted: audit masking bound reached]';
export const MAX_MASK_DEPTH = 8;
export const MAX_MASK_NODES = 4000;

// Field names whose value is never worth an audit record. Matched against the whole normalized
// name, a name ending in one of these (an `x-api-key`, a `awsSecretAccessKey`), or one of these as
// a separated segment (`api_key`, `refresh-token`, `tokens`). Deliberately without a bare `key` or
// `pin`: `mapping` and `monkey` are not credentials.
const SECRET_FIELD_WORDS = [
  'apikey', 'secret', 'secretkey', 'token', 'password', 'passwd', 'pwd', 'privatekey',
  'accesskey', 'secretaccesskey', 'authorization', 'auth', 'credential', 'credentials',
  'bearer', 'sessionkey', 'clientsecret', 'refreshtoken', 'accesstoken', 'authtoken', 'cookie',
];

export function fieldNameLooksLikeSecret(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const lower = name.toLowerCase();
  const joined = lower.replace(/[^a-z0-9]/g, '');
  if (SECRET_FIELD_WORDS.some((word) => joined === word || joined.endsWith(word))) return true;
  return lower.split(/[^a-z0-9]+/).filter(Boolean).some((segment) => {
    if (SECRET_FIELD_WORDS.includes(segment)) return true;
    return segment.length > 4 && segment.endsWith('s') && SECRET_FIELD_WORDS.includes(segment.slice(0, -1));
  });
}

// The value-level rule, exported so the controller and any later writer use exactly this test.
export function maskSecretLeaf(name, value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (fieldNameLooksLikeSecret(name)) return SECRET_OMITTED;
  return containsSecret(value) ? SECRET_OMITTED : value;
}

// Returns a copy with every offending string leaf replaced, plus how many were replaced and
// whether a bound stopped the walk. Never returns the input object, so a caller cannot hand the
// same reference to the log and to something else.
export function maskSecretLeaves(value, { skipTopLevel = [], maxNodes = MAX_MASK_NODES } = {}) {
  const budget = { nodes: 0, maxNodes, masked: 0, boundReached: false, active: new Set() };
  const skip = new Set(skipTopLevel);
  return { value: walkMask(value, 0, null, budget, skip), masked: budget.masked, boundReached: budget.boundReached };
}

function walkMask(value, depth, key, budget, skip) {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    budget.boundReached = true;
    return MASK_BOUND_REACHED;
  }
  if (typeof value === 'string') {
    // `skipTopLevel` names the root object's own fields; they are at depth 1.
    if (depth === 1 && skip.has(key)) return value;
    const masked = maskSecretLeaf(key, value);
    if (masked !== value) budget.masked += 1;
    return masked;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_MASK_DEPTH) {
    budget.boundReached = true;
    return '[truncated]';
  }
  if (budget.active.has(value)) {
    budget.boundReached = true;
    return '[circular]';
  }
  budget.active.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((entry) => walkMask(entry, depth + 1, key, budget, skip));
  } else {
    out = {};
    for (const [name, entry] of Object.entries(value)) {
      if (name === '__proto__') continue;
      // A credential can arrive as a key instead of a value, and a key is text that the audit record
      // copies verbatim (an unexpected field name is kept so a reader sees which field was refused).
      // So the name goes through the same content test: it is renamed, not dropped, and if the
      // substring rule leaves anything credential-shaped behind the whole name is omitted.
      let outName = name;
      if (containsSecret(name)) {
        outName = redactSecrets(name);
        if (containsSecret(outName)) outName = SECRET_OMITTED;
        budget.masked += 1;
        if (Object.prototype.hasOwnProperty.call(out, outName)) outName = `${outName} ${Object.keys(out).length + 1}`;
      }
      out[outName] = walkMask(entry, depth + 1, name, budget, skip);
    }
  }
  budget.active.delete(value);
  return out;
}
