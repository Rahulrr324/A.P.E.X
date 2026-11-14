// Small shared helpers.
import { redactSecrets } from './security/secrets.js';

// Control characters other than tab and newline.
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Everything that cannot appear inside one APEX line: all C0 controls (tab and the
// line breaks included), DEL, and C1. JSON string escapes are decoded after the model
// gateway removes control characters from the reply text, so a value such as
// "\u001b[2K" or "a\nb" can still reach APEX and must be normalized where it is used.
export const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f]/;
const SINGLE_LINE_FORBIDDEN_ALL = new RegExp(SINGLE_LINE_FORBIDDEN.source, 'g');

// Words that carry no retrieval signal. Shared by every store's tokenizer so a
// question such as "what is the capital of France?" cannot match a record merely
// because the record also contains "what" or "is".
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in', 'on', 'at',
  'for', 'from', 'by', 'with', 'and', 'or', 'it', 'its', 'this', 'that', 'these', 'those',
  'my', 'me', 'i', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'about',
  'as', 'if', 'so', 'not', 'no', 'yes', 'can', 'could', 'would', 'should', 'will', 'have', 'has',
  'had', 'please', 'tell', 'say', 'said', 'know', 'just', 'any', 'some', 'there', 'here',
]);

export function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

// Renders an untrusted name or key so it can be embedded in APEX's own one-line
// sentence without becoming a line of its own. Used for action names, step ids,
// input field names, and anything else an APEX message quotes back.
// A field name is attacker-chosen text, so a credential can arrive in one: the value is redacted
// before it is shortened, exactly as the diagnostics printer does it, so a refusal cannot quote
// back the beginning of the secret it is refusing.
export function singleLine(value, max = 80) {
  return truncate(
    redactSecrets(
      String(value ?? '').replace(SINGLE_LINE_FORBIDDEN_ALL, ' ').replace(/\s+/g, ' ').trim(),
    ),
    max,
  );
}

// A strict ISO instant: a calendar date, or a date-time with an explicit zone. `Date.parse`
// quietly rolls an impossible calendar date (2026-02-30) into the next month and reads a
// zone-less date-time in the machine's local time, so neither is accepted here. Returns the
// normalized UTC instant, or null when the text is not one unambiguous instant.
export function parseIsoInstant(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(text);
  const parts = dateOnly ?? dateTime;
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return null;
  }
  if (dateTime) {
    if (Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) return null;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
