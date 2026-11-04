// Structured cognitive model protocol.
//
// The model may follow its prose with one line that begins with COGNITION and carries a JSON object.
// That line is a claim about what the model answered, not authority: it is parsed as untrusted input,
// validated against this request's evidence, and either accepted as a bounded structure or rejected
// whole. A rejected structure never executes anything, never changes a stored record, and is reported
// as a rejected structure rather than silently ignored. The prose outside the line is still the
// model's answer, and remains unverified.
import { CONTROL_CHARS } from '../util.js';
import { BOUNDS } from './vocabulary.js';
import { validateStructuredResponse } from './response.js';

export const COGNITION_PREFIX = 'COGNITION';
// The line is small by construction: at most a short answer, twelve claims, and a recommendation. A
// line far larger than that is refused before JSON parsing so a malformed response cannot spend
// unbounded work.
export const MAX_COGNITION_LINE_CHARS = 16000;

const LINE = /^COGNITION(?:\s+|$)(.*)$/;

function cleanBody(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reject(code, message, text) {
  return {
    found: true,
    text: cleanBody(text),
    structure: null,
    error: { code, message },
  };
}

// Returns `{ found, text, structure, error }`. `text` is the model's prose with the structured line
// removed, so raw JSON never reaches the user as an answer. At most one COGNITION line is accepted;
// a second line makes the whole structure ambiguous and is rejected rather than merged.
export function extractCognitionLine(text) {
  const body = String(text ?? '');
  const lines = body.split('\n');
  const found = lines.filter((line) => LINE.test(line));
  if (found.length === 0) {
    return { found: false, text: body, structure: null, error: null };
  }
  if (found.length > 1) {
    return reject('MULTIPLE_STRUCTURES', 'more than one COGNITION line was found; only one structured response is accepted', body);
  }
  const payload = found[0].match(LINE)?.[1] ?? '';
  if (payload.length > MAX_COGNITION_LINE_CHARS) {
    return reject('STRUCTURE_TOO_LARGE', `the COGNITION line exceeds ${MAX_COGNITION_LINE_CHARS} characters`, body);
  }
  if (payload.length === 0) {
    return reject('EMPTY_STRUCTURE', 'the COGNITION line carries no JSON object', body);
  }
  if (CONTROL_CHARS.test(payload)) {
    return reject('CONTROL_CHARS', 'the COGNITION line contains control characters', body);
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return reject('MALFORMED_JSON', `the COGNITION line is not valid JSON (${String(err.message).slice(0, 120)})`, body);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject('NOT_AN_OBJECT', 'the COGNITION line must contain a JSON object', body);
  }
  return { found: true, text: cleanBody(body), structure: parsed, error: null };
}

// Validates a parsed structure against the deterministic analysis. A caller must treat `ok === false`
// as a rejected response: nothing in `value` may be used, displayed as authoritative, or executed.
export function validateCognitionModelOutput(text, analysis) {
  const extracted = extractCognitionLine(text);
  if (!extracted.found) {
    return {
      found: false,
      text: extracted.text,
      structure: null,
      error: null,
      validation: null,
    };
  }
  if (extracted.error) {
    return {
      found: true,
      text: extracted.text,
      structure: null,
      error: extracted.error,
      validation: { ok: false, problems: [extracted.error.message] },
    };
  }
  const validation = validateStructuredResponse(extracted.structure, { analysis });
  if (!validation.ok) {
    return {
      found: true,
      text: extracted.text,
      structure: null,
      error: {
        code: 'INVALID_STRUCTURE',
        message: validation.problems.slice(0, 4).join('; '),
      },
      validation,
    };
  }
  return {
    found: true,
    text: extracted.text,
    structure: validation.value,
    error: null,
    validation,
  };
}

// The audit record of a structured response: the decision, counts, and validation result. It never
// contains the model's answer text or the evidence content it cited.
export function cognitionAudit(structured, validation, bound = BOUNDS.maxStructuredClaims) {
  if (!structured) return null;
  return {
    accepted: true,
    decision: structured.decision ?? null,
    claims: Math.min(Array.isArray(structured.claims) ? structured.claims.length : 0, bound),
    citedEvidence: [...new Set((structured.claims ?? []).flatMap((claim) => claim.evidenceIds ?? []))].length,
    disclosures: Array.isArray(structured.disclosures) ? [...structured.disclosures] : [],
    uncertainty: structured.uncertainty ?? null,
    missing: Array.isArray(structured.missing) ? [...structured.missing] : [],
    recommendation: Boolean(structured.recommendation),
    recommendationExecuted: structured.recommendation?.executed === true,
    repairedDisclosures: Array.isArray(validation?.repaired?.addedDisclosures)
      ? [...validation.repaired.addedDisclosures]
      : [],
    validationOk: validation?.ok === true,
    problems: Array.isArray(validation?.problems) ? validation.problems.slice(0, 4) : [],
  };
}
