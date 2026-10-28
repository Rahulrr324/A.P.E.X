// Controller decision vocabulary. A decision describes what the controller chose
// to do with a request; it is separate from the operation outcome, which records
// what execution and verification actually established.
//
//   answer          normal response, grounded in the supplied evidence or model text
//   clarify         a targeted question, because the request cannot proceed safely
//   propose_action  an action went through (or is waiting in) the existing workflow
//   refuse_or_block an unavailable, unauthorized, or failed operation was refused
//
// The classifier is deterministic and reads only recorded outcomes. It never
// grants authority: proposals still pass through the action registry.
import { Outcome } from '../outcomes.js';

export const Decision = Object.freeze({
  ANSWER: 'answer',
  CLARIFY: 'clarify',
  PROPOSE_ACTION: 'propose_action',
  REFUSE_OR_BLOCK: 'refuse_or_block',
});

const REFUSED = new Set([
  Outcome.ACTION_DENIED,
  Outcome.EXECUTION_FAILED,
  Outcome.VERIFICATION_FAILED,
  Outcome.AUDIT_INTEGRITY_FAILED,
  Outcome.INPUT_REJECTED,
  Outcome.MODEL_UNAVAILABLE,
  Outcome.PLAN_REJECTED,
]);

export function classifyDecision({ status, steps = [] }) {
  if (status === Outcome.CLARIFICATION_REQUIRED) return Decision.CLARIFY;
  if (REFUSED.has(status)) return Decision.REFUSE_OR_BLOCK;
  if (status === Outcome.PLAN_CREATED || status === Outcome.PLAN_PROPOSED || status === Outcome.TASK_PAUSED) {
    return Decision.PROPOSE_ACTION;
  }
  const modelSteps = steps.filter((step) => step && step.origin === 'model');
  if (modelSteps.some((step) => step.outcome !== Outcome.SUCCESS_VERIFIED)) return Decision.REFUSE_OR_BLOCK;
  if (modelSteps.length > 0) return Decision.PROPOSE_ACTION;
  return Decision.ANSWER;
}

const PRONOUN = '(?:it|that|this|them|those|these)';

// A lookup with no topic, or a file request with no path, cannot be answered
// reliably. These are the narrow cases where APEX asks instead of guessing.
const CLARIFY_MEMORY = /^(?:what\s+do\s+you\s+(?:remember|know)\s+about|recall|search\s+memor(?:y|ies)(?:\s+for)?)\s*[?.!]*$/i;
const CLARIFY_PATH = new RegExp(
  `^(?:read|open|cat|print|peek|display|show|ls|list|dir)\\s+(?:the\\s+)?(?:(?:file|folder|directory|path)\\s*)?${PRONOUN}\\s*[?.!]*$`,
  'i',
);
const CLARIFY_NAMED_PATH = /^(?:read|open|cat|print|peek|display|show|ls|list|dir)\s+(?:the\s+)?(?:file|folder|directory|path)\s*[?.!]*$/i;
// A follow-up with no prior conversation has nothing to resolve "it" against.
const CLARIFY_CONTINUATION = new RegExp(
  `^(?:do|handle|fix|continue|go\\s+ahead|proceed|carry\\s+on)(?:\\s+(?:${PRONOUN}|so|with\\s+${PRONOUN}))?\\s*[?.!]*$`,
  'i',
);

export function clarificationFor(request, { hasContext = false, checkContinuation = true } = {}) {
  const text = String(request).trim();
  if (CLARIFY_MEMORY.test(text)) return 'What topic should I search your memory for?';
  if (CLARIFY_PATH.test(text) || CLARIFY_NAMED_PATH.test(text)) {
    return 'Which file or directory do you mean? Please give a path.';
  }
  // Continuation needs the conversation context, so callers that have not loaded
  // recent turns can skip it rather than guessing.
  if (checkContinuation && !hasContext && CLARIFY_CONTINUATION.test(text)) {
    return 'What would you like APEX to do? Please state the action and its target.';
  }
  return null;
}

// Requests for capabilities APEX deliberately does not have. They are refused
// before any model call so no model can imply that they were carried out.
const UNSUPPORTED = [
  /^(?:sudo\s+)?(?:rm|del|delete|remove|unlink|rmdir|shutdown|reboot|kill|pkill|taskkill)\b/i,
  /^format\s+(?:the\s+)?(?:disk|drive|volume|partition)\b/i,
  /^(?:exec|execute|run)\s+(?:a\s+)?(?:shell|command|cmd|script|code|program)\b/i,
];

export function unsupportedOperationFor(request) {
  const text = String(request).trim();
  if (!UNSUPPORTED.some((re) => re.test(text))) return null;
  return 'APEX has no capability for that operation, and nothing was executed. '
    + 'It cannot run shell commands or delete, format, or stop system resources. '
    + 'The request was not sent to a model.';
}
