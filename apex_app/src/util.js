// Small shared helpers.

// Control characters other than tab and newline.
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function shortId(id) {
  return String(id).slice(0, 8);
}

// Remove bulky personal content before anything is written to the audit log.
// Keys named `content` are replaced by a length marker. `display` is never
// persisted (it is only for the interactive user).
export function redact(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'display') continue;
      if (k === 'content' && typeof v === 'string') out[k] = `[omitted ${v.length} chars]`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
