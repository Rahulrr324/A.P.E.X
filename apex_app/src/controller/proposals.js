// Model output is untrusted text. The only structured thing the controller
// reads from it is a line beginning with PROPOSE_ACTION followed by a JSON
// object {"action": "<name>", "input": {...}}. Each proposal is only a request.
// It is authorized and validated like any other request. Nothing is evaluated.
export const PROPOSAL_PREFIX = 'PROPOSE_ACTION';
export const MAX_PROPOSALS = 3;

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
    if (
      !obj || typeof obj !== 'object' || Array.isArray(obj) ||
      typeof obj.action !== 'string' ||
      !obj.input || typeof obj.input !== 'object' || Array.isArray(obj.input)
    ) {
      malformed.push({ reason: 'proposal must be {"action": string, "input": object}' });
      continue;
    }
    proposals.push({ action: obj.action, input: obj.input });
  }
  return { text: answerLines.join('\n').trim(), proposals, malformed };
}
