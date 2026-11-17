// Shared expectation predicates, written against the surfaces a user or operator can observe: an
// outcome status, displayed text, a record read back through the application, or a line in a
// documented audit log. They contain no APEX internals, no private helper names and no expected
// prose copied from the implementation, so a scenario's checks stay separate from the code they
// judge.
import fs from 'node:fs';
import path from 'node:path';
import { check } from './framework.js';

export const has = (text, re) => typeof text === 'string' && re.test(text);
export const hasAll = (text, patterns) => patterns.every((re) => has(text, re));

// The status a command reported. An absent status is reported as `null` rather than coerced to a
// string, so a missing answer cannot accidentally match an expectation.
export function outcomeIs(result, expected) {
  const actual = typeof result?.status === 'string' ? result.status : null;
  return check(actual === expected, expected, actual);
}

export function outcomeIn(result, expected) {
  const actual = typeof result?.status === 'string' ? result.status : null;
  return check(expected.includes(actual), expected.join(' or '), actual);
}

export function displayHas(result, pattern, label = null) {
  const display = typeof result?.display === 'string' ? result.display : '';
  return check(has(display, pattern), label ?? `the answer matches ${String(pattern)}`, display.slice(0, 600) || '(no display)');
}

export function displayLacks(result, pattern, label = null) {
  const display = typeof result?.display === 'string' ? result.display : '';
  return check(!has(display, pattern), label ?? `the answer does not match ${String(pattern)}`, display.slice(0, 600) || '(no display)');
}

export function boundedDisplay(result, { min = 1, max = 4000 } = {}) {
  const display = typeof result?.display === 'string' ? result.display : '';
  return check(display.length >= min && display.length <= max, `an answer of ${min}-${max} characters`, `${display.length} characters`);
}

export function equals(actual, expected, label) {
  return check(JSON.stringify(actual) === JSON.stringify(expected), expected, actual);
}

export function atLeast(actual, minimum, label) {
  return check(typeof actual === 'number' && actual >= minimum, `at least ${minimum}`, actual);
}

export function atMost(actual, maximum, label) {
  return check(typeof actual === 'number' && actual <= maximum, `at most ${maximum}`, actual);
}

export function isTrue(value, label) {
  return check(value === true, `${label} is true`, value);
}

export function isFalse(value, label) {
  return check(value === false, `${label} is false`, value);
}

// The first step's structured result, which is where a single-action command returns its data.
export function dataOf(result) {
  return result?.operation?.steps?.[0]?.result?.data ?? result?.result?.data ?? null;
}

export function stepsOf(result) {
  return result?.operation?.steps ?? [];
}

// Reads one documented append-only JSON Lines log. A damaged line is counted, never silently
// dropped: a safety check that cannot read its evidence must not look like proof of absence.
export function readJsonl(dataDir, name) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return { records: [], damaged: 0, file };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const records = [];
  let damaged = 0;
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { damaged += 1; }
  }
  return { records, damaged, file };
}

// A bounded text excerpt for evidence lists. Secrets are not expected in these fixtures, but a
// long answer is truncated so a trace stays readable and a report stays small.
export function excerpt(text, max = 500) {
  if (typeof text !== 'string') return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
