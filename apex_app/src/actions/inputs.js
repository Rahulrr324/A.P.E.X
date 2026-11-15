// Shared input validation for the actions added in the release sprint. The rules are the same as
// the knowledge and world actions: bounded length, no control characters, and a credential-looking
// value is refused rather than stored or echoed.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS } from '../util.js';
import { containsSecret } from '../security/secrets.js';

const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function textInput(value, name, { max = 500, required = true, multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (required && text.length === 0) throw new ValidationError(`${name} is empty`);
  if (text.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if ((multiline ? BODY_CONTROL : CONTROL_CHARS).test(text)) {
    throw new ValidationError(`${name} contains control characters`);
  }
  if (containsSecret(text)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not stored`, 'SECRET_REFUSED');
  }
  return text;
}

export function enumInput(value, name, allowed, { fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`${name} is required`);
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function intInput(value, name, { min, max, fallback }) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${name} is required`);
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
