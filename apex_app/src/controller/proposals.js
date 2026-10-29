// Model output is untrusted text. The only structured thing the controller
// reads from it is one line: PROPOSE_ACTION followed by a single JSON object
// {"action": "<a registered action name>", "input": { <that action's parameters> }}.
// "input" is always an object of named parameters, and {} when the action takes
// none. Each proposal is only a request. It is authorized and validated like any
// other request. Nothing is evaluated.
export const PROPOSAL_PREFIX = 'PROPOSE_ACTION';
export const MAX_PROPOSALS = 3;

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
  if (obj.input === undefined) return 'proposal has no "input"';
  if (jsonType(obj.input) !== 'object') {
    return `proposal "input" must be an object of the action's parameters, got ${jsonType(obj.input)}`;
  }
  return null;
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
    proposals.push({ action: obj.action, input: obj.input });
  }
  return { text: answerLines.join('\n').trim(), proposals, malformed };
}
