// Strict structured-output validation for the model boundary.
//
// A provider that can be asked for structured output is still untrusted: the JSON is parsed here
// and checked against a bounded schema before any field is used. This validator supports only the
// subset APEX needs (objects, arrays, strings, numbers, integers, booleans, null, enums, and simple
// bounds). It does not claim to be JSON Schema: no $ref, pattern, format, or composition.
//
// Parsing is deliberately strict. The whole trimmed answer must be one JSON object, so prose wrapped
// around an object is refused rather than guessed at, and there is no fence-stripping pass that could
// turn two answers into one. Field names that would look like authority (authorization, verified,
// executed, ...) and prototype-mutating names are refused at any depth, because a structured reply
// is data and cannot carry a grant.
//
// The existing line protocols (PROPOSE_ACTION, PROPOSE_EXECUTIVE, COGNITION) keep their own parsers.
// This module is the shared contract for a future provider that returns one object, and it is
// exercised by deterministic stubs only.
export const MODEL_OBJECT_SCHEMA = 'apex.model-object.v1';
export const MODEL_SUGGESTION_SCHEMA = 'apex.model-suggestion.v1';
export const MAX_OBJECT_CHARS = 100000;
export const MAX_DEPTH = 12;
export const MAX_PROPERTIES = 64;
export const MAX_ARRAY_ITEMS = 1000;

// Names that would let parsed data masquerade as a decision. Refused case-insensitively at every
// depth; the answer may propose, but it cannot present itself as authorized, verified, or executed.
export const FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
  'authorization', 'authorized', 'permission', 'permissions', 'grant', 'grants',
  'verified', 'verifier', 'executed', 'executable', 'approved', 'authority', 'origin',
]);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function problem(path, code, message) {
  return { path, code, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The supported schema subset. A malformed schema is a programming error in APEX, reported as a
// schema problem rather than treated as permission to skip validation.
export function validateSchemaValue(value, schema, { path = '$', depth = 0 } = {}) {
  if (depth > MAX_DEPTH) return [problem(path, 'too-deep', `nesting exceeds ${MAX_DEPTH} levels`)];
  if (!isObject(schema)) return [problem(path, 'bad-schema', 'the schema is not an object')];
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) return [problem(path, 'not-in-enum', 'the value is not one of the allowed values')];
    return [];
  }
  const type = schema.type;
  if (type === 'object') {
    if (!isObject(value)) return [problem(path, 'not-an-object', 'the value must be an object')];
    const keys = Object.keys(value);
    if (keys.length > (schema.maxProperties ?? MAX_PROPERTIES)) return [problem(path, 'too-many-properties', 'the object has too many properties')];
    const properties = isObject(schema.properties) ? schema.properties : {};
    const problems = [];
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(problem(`${path}.${key}`, 'missing', 'a required field is missing'));
      }
    }
    for (const key of keys) {
      const child = `${path}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) problems.push(problem(child, 'unexpected', 'the field is not allowed here'));
        continue;
      }
      problems.push(...validateSchemaValue(value[key], properties[key], { path: child, depth: depth + 1 }));
    }
    return problems;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [problem(path, 'not-an-array', 'the value must be an array')];
    if (value.length > (schema.maxItems ?? MAX_ARRAY_ITEMS)) return [problem(path, 'too-many-items', 'the array has too many items')];
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return [problem(path, 'too-few-items', `the array needs at least ${schema.minItems} item(s)`)];
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return [problem(path, 'too-many-items', `the array allows at most ${schema.maxItems} item(s)`)];
    if (!isObject(schema.items)) return [];
    const problems = [];
    value.forEach((item, i) => problems.push(...validateSchemaValue(item, schema.items, { path: `${path}[${i}]`, depth: depth + 1 })));
    return problems;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [problem(path, 'not-a-string', 'the value must be text')];
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return [problem(path, 'too-short', `the text needs at least ${schema.minLength} characters`)];
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return [problem(path, 'too-long', `the text allows at most ${schema.maxLength} characters`)];
    return [];
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) return [problem(path, 'not-an-integer', 'the value must be an integer')];
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return [problem(path, 'too-small', `the value must be at least ${schema.minimum}`)];
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return [problem(path, 'too-large', `the value must be at most ${schema.maximum}`)];
    return [];
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [problem(path, 'not-a-number', 'the value must be a finite number')];
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return [problem(path, 'too-small', `the value must be at least ${schema.minimum}`)];
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return [problem(path, 'too-large', `the value must be at most ${schema.maximum}`)];
    return [];
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? [] : [problem(path, 'not-a-boolean', 'the value must be true or false')];
  }
  if (type === 'null') {
    return value === null ? [] : [problem(path, 'not-null', 'the value must be null')];
  }
  return [problem(path, 'bad-schema', `unknown schema type "${String(type).slice(0, 40)}"`)];
}

function keyProblems(value, forbidden, path, depth, problems) {
  if (depth > MAX_DEPTH) {
    problems.push(problem(path, 'too-deep', `nesting exceeds ${MAX_DEPTH} levels`));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => keyProblems(item, forbidden, `${path}[${i}]`, depth + 1, problems));
    return;
  }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    if (UNSAFE_KEYS.has(key)) problems.push(problem(path, 'unsafe-key', 'a prototype-mutating key is not allowed'));
    else if (forbidden.has(lower)) problems.push(problem(`${path}.${key}`, 'authority-key', 'a model object cannot carry an authority field'));
    if (problems.length > 20) return;
    keyProblems(value[key], forbidden, `${path}.${key}`, depth + 1, problems);
  }
}

// Parses and validates one JSON object. Returns problems instead of throwing; the value is null
// unless the whole object passed.
export function parseModelObject(text, schema, { maxChars = MAX_OBJECT_CHARS, forbiddenKeys = FORBIDDEN_AUTHORITY_KEYS } = {}) {
  const fail = (code, message) => ({ ok: false, value: null, problems: [problem('$', code, message)], chars: typeof text === 'string' ? text.length : 0 });
  if (typeof text !== 'string' || text.trim().length === 0) return fail('empty', 'the answer is not text');
  if (text.length > maxChars) return fail('too-large', `the answer is ${text.length} characters; the limit is ${maxChars}`);
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return fail('not-an-object', 'the whole answer must be one JSON object; prose or a code fence around it is refused');
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return fail('invalid-json', `the answer is not valid JSON${typeof err?.message === 'string' ? ` (${err.message.slice(0, 120)})` : ''}`);
  }
  if (!isObject(value)) return fail('not-an-object', 'the answer must be a JSON object');
  const forbidden = new Set([...forbiddenKeys].map((k) => String(k).toLowerCase()));
  const problems = [];
  keyProblems(value, forbidden, '$', 0, problems);
  problems.push(...validateSchemaValue(value, schema));
  if (problems.length > 0) return { ok: false, value: null, problems, chars: text.length };
  return { ok: true, value, problems: [], chars: text.length };
}

// A validated payload is still only a suggestion. The envelope adds that fact in a fixed shape so
// no caller can mistake a well-formed object for a decision, a verification, or permission.
export function asSuggestion(payload, { kind = null } = {}) {
  return Object.freeze({
    schema: MODEL_SUGGESTION_SCHEMA,
    kind: typeof kind === 'string' && kind.length > 0 && kind.length <= 64 ? kind : null,
    authority: 'none',
    executable: false,
    verified: false,
    recorded: false,
    payload,
  });
}
