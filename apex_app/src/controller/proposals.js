// Model output is untrusted text. The only structured thing the controller
// reads from it is one line: PROPOSE_ACTION followed by a single JSON object
// {"action": "<a registered action name>", "input": { <that action's parameters> }}.
// "input" is always an object of named parameters, and {} when the action takes
// none. Each proposal is only a request. It is authorized and validated like any
// other request. Nothing is evaluated.
//
// The parsed proposal is a typed value owned by APEX, not the model's object: it always carries
// origin "model", trusted false, and authority "none", whatever the reply said. A line that tries to
// assert authorization, provenance, verification, or an execution at the root is malformed and is
// dropped whole; an unknown root field is refused rather than ignored, so a later reader cannot
// mistake a smuggled field for something APEX accepted.
import { ACTION_NAME_RE } from '../actions/registry.js';

export const PROPOSAL_PREFIX = 'PROPOSE_ACTION';
export const PROPOSAL_KIND = 'model_action_proposal';
export const MAX_PROPOSALS = 3;

const ROOT_KEYS = new Set(['action', 'input']);
const AUTHORITY_KEYS = new Set([
  'authorization', 'authorized', 'authority', 'approval', 'approved', 'permission', 'permissions',
  'role', 'origin', 'trusted', 'untrusted', 'verified', 'verification', 'verify', 'executed',
  'execute', 'run', 'activate', 'activated', 'requestId', 'request_id', 'operationId', 'capability',
  'decision', 'grant', 'grants', 'user', 'owner',
]);

function printableKey(key) {
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : 'unprintable field';
}

function rootKeyViolation(obj) {
  for (const key of Object.keys(obj)) {
    if (ROOT_KEYS.has(key)) continue;
    if (AUTHORITY_KEYS.has(key)) {
      return `proposal field "${key}" is not allowed; a proposal carries action and input only and cannot assert authorization, verification, or execution`;
    }
    return `proposal has an unrecognized field "${printableKey(key)}"; only action and input are accepted`;
  }
  return null;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Names the first schema violation found, so a rejected proposal says what was
// wrong instead of restating the whole protocol. A reason carries a JSON type and
// never the value: a proposal is model output, and its text must not reach the
// display, the audit log, or conversation history through a rejection reason.
function shapeViolation(obj) {
  const type = jsonType(obj);
  if (type !== 'object') return `proposal must be a JSON object, got ${type}`;
  if (obj.action === undefined) return 'proposal has no "action"';
  if (typeof obj.action !== 'string') return `proposal "action" must be a string, got ${jsonType(obj.action)}`;
  // The name is quoted back in step lines and history. A name the registry grammar
  // cannot produce is refused here, before it is copied anywhere.
  if (!ACTION_NAME_RE.test(obj.action)) return 'proposal "action" is not a valid action name';
  if (obj.input === undefined) return 'proposal has no "input"';
  if (jsonType(obj.input) !== 'object') {
    return `proposal "input" must be an object of the action's parameters, got ${jsonType(obj.input)}`;
  }
  return rootKeyViolation(obj);
}

export function parseModelOutput(text) {
  const answerLines = [];
  const proposals = [];
  const malformed = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith(PROPOSAL_PREFIX)) {
      answerLines.push(line);
      continue;
    }
    const body = t.slice(PROPOSAL_PREFIX.length).trim();
    let obj;
    try {
      obj = JSON.parse(body);
    } catch {
      malformed.push({ reason: 'proposal is not valid JSON' });
      continue;
    }
    const reason = shapeViolation(obj);
    if (reason) {
      malformed.push({ reason });
      continue;
    }
    proposals.push({
      type: PROPOSAL_KIND,
      proposalId: `mp:${proposals.length + 1}`,
      action: obj.action,
      input: obj.input,
      origin: 'model',
      trusted: false,
      authority: 'none',
    });
  }
  return { text: answerLines.join('\n').trim(), proposals, malformed };
}
