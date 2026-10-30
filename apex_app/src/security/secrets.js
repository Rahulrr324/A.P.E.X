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
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
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
