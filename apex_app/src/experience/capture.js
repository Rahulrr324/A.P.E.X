// Automatic experience capture: the decision of whether one finished operation may be written to
// the experience store without the user asking for it.
//
// Batch Z made an experience something the user records by name. That is honest but slow, so this
// module adds a narrow automatic path: APEX may capture the outcome of an operation it already
// proved it carried out. The boundary it must not cross is the one Batch Z drew - an experience is
// evidence that something happened, feedback is what the user thought of it, and only the user's own
// corrective feedback can support a behaviour rule. Automatic capture therefore writes an
// experience and nothing else: no feedback, no assessment, no adaptation, no decision.
//
// The capture decision is made from the finished audit record alone, before any store is opened, so
// an ineligible operation costs nothing and a store failure can never be read as an operation
// failure.
import { Outcome } from '../outcomes.js';
import { containsSecret } from '../security/secrets.js';
import { CONTROL_CHARS } from '../util.js';
import { MAX_SUBJECT_CHARS } from './experience-store.js';

export const CAPTURE_MODES = Object.freeze(['off', 'verified-success']);
export const CAPTURE_OFF = 'off';
export const CAPTURE_VERIFIED_SUCCESS = 'verified-success';

// The initial capture subset, deliberately small: the operations that change what APEX knows, and
// whose success has a postcondition the action's own verifier re-read from the store. Every name
// here is durable state the user asked for, and its audit step states the result as an identifier
// or a count rather than as the user's words.
//
// Everything else that can end an operation is classified, with its reason, in
// CAPTURE_EXCLUDED_CAPABILITIES below. The exclusion is data rather than prose so that the
// coverage test can require an explicit decision for every capability, including one added later.
export const AUTO_CAPTURE_CAPABILITIES = Object.freeze([
  'memory.add',
  'memory.correct',
  'knowledge.add',
  'knowledge.retract',
  'knowledge.resolve',
]);

export const CAPTURE_EXCLUSION_CATEGORIES = Object.freeze({
  read: 'its result is re-derivable from the stores at any time, so an experience of it would say less than a fresh read while making every later read slower',
  'model-words': 'what it stores or produces is a model conclusion, which is evidence only that a model said it',
  'self-bookkeeping': 'the experience log must not fill itself with records about its own bookkeeping, which would make the counts meaningless',
  task: 'one task operation covers several steps with separate outcomes, so a single experience would say less than the task log already says',
  filesystem: 'the read result is other people\'s file content, and no outcome here needs it',
  'no-action': 'the request ran no action, so there is no postcondition that could have been verified',
});

// Every capability that can reach an operation-end path without being captured. A capability that
// appears in neither list is refused by autoCaptureDecision, but the coverage test fails first: a
// new action has to be classified here or added to the subset on purpose.
export const CAPTURE_EXCLUDED_CAPABILITIES = Object.freeze({
  'app.status': 'read',
  'calc.evaluate': 'read',
  'world.state': 'read',
  'memory.search': 'read',
  'memory.list': 'read',
  'knowledge.list': 'read',
  'knowledge.search': 'read',
  'experience.list': 'read',
  'experience.show': 'read',
  'adaptation.list': 'read',
  'memory.save_conclusion': 'model-words',
  'model.answer': 'model-words',
  'experience.record': 'self-bookkeeping',
  'feedback.record': 'self-bookkeeping',
  'adaptation.derive': 'self-bookkeeping',
  'adaptation.decide': 'self-bookkeeping',
  'adaptation.retire': 'self-bookkeeping',
  'task.plan': 'task',
  'task.run': 'task',
  'task.approve': 'task',
  'task.retry': 'task',
  'task.cancel': 'task',
  'task.explain': 'task',
  'task.step': 'task',
  'filesystem.list': 'filesystem',
  'filesystem.read': 'filesystem',
  none: 'no-action',
});

// A step that was denied, rejected as input, failed, or executed without an independent
// confirmation of its postcondition cannot support a claim about what APEX did.
function stepStands(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.outcome !== Outcome.SUCCESS_VERIFIED) return false;
  if (step.authorization?.decision !== 'allow') return false;
  if (step.execution?.status !== 'ok') return false;
  if (step.verification?.outcome !== Outcome.SUCCESS_VERIFIED) return false;
  return true;
}

// The compact account of the event: the capability and the step summaries, which are already
// minimized by the action layer (an id, a count, or an expression and its value). The request text
// and the displayed result are never used, so no conversation content can reach the experience log
// through this path.
export function captureSubject(op) {
  const capability = typeof op?.capability === 'string' ? op.capability.trim() : '';
  if (!capability) return null;
  const parts = (Array.isArray(op.steps) ? op.steps : [])
    .map((s) => (typeof s?.summary === 'string' ? s.summary.trim() : ''))
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const full = `${capability}: ${parts.join('; ')}`;
  if (full.length <= MAX_SUBJECT_CHARS) return full;
  // A bounded, content-free fallback beats a truncated sentence that might cut an identifier in
  // half and then disagree with the audit record on every later read.
  return `${capability}: ${parts.length} verified step(s)`;
}

// Returns `{ eligible, reason }`. `reason` is always stated, because a capture that simply did not
// happen looks exactly like a capture that was switched off.
export function autoCaptureDecision(op, { mode = CAPTURE_OFF, recorded = true } = {}) {
  if (mode !== CAPTURE_VERIFIED_SUCCESS) {
    return { eligible: false, reason: `automatic capture is set to ${mode}, so nothing was captured` };
  }
  if (!op || typeof op !== 'object') return { eligible: false, reason: 'no operation record was available' };
  if (!recorded) {
    return { eligible: false, reason: 'the audit record could not be written, so there is no operation to reference' };
  }
  if (typeof op.id !== 'string' || op.id.length === 0) {
    return { eligible: false, reason: 'the operation has no stable identifier to reference' };
  }
  if (op.origin !== 'user') {
    return { eligible: false, reason: `the operation was recorded as ${String(op.origin)} origin, and only a user-origin operation is captured automatically` };
  }
  if (op.status !== Outcome.SUCCESS_VERIFIED) {
    return { eligible: false, reason: `the operation ended as ${String(op.status)}, which is not a verified success` };
  }
  if (Array.isArray(op.errors) && op.errors.length > 0) {
    return { eligible: false, reason: `${op.errors.length} error(s) are attached to the operation, so its audit evidence is not complete` };
  }
  if (!AUTO_CAPTURE_CAPABILITIES.includes(op.capability)) {
    return { eligible: false, reason: `capability ${String(op.capability ?? 'none')} is outside the automatic capture subset` };
  }
  const steps = Array.isArray(op.steps) ? op.steps : [];
  if (steps.length === 0) return { eligible: false, reason: 'the operation recorded no steps, so nothing was verified' };
  if (!steps.every(stepStands)) {
    return { eligible: false, reason: 'at least one step was denied, failed, or not independently verified' };
  }
  const subject = captureSubject(op);
  if (!subject) return { eligible: false, reason: 'no account of the event could be built from the audit record' };
  if (CONTROL_CHARS.test(subject)) return { eligible: false, reason: 'the account of the event contains control characters' };
  if (containsSecret(subject)) {
    return { eligible: false, reason: 'the account of the event looks like a password, key, or token, so it was not captured' };
  }
  return { eligible: true, reason: 'a verified, user-origin, in-scope operation with complete audit evidence', subject };
}

// The setting as a reader must see it, stated from the value the application holds rather than from
// what a request claimed. A value that is neither known mode is reported as what it is - a setting
// that did not take effect - rather than folded in with `off`.
export function captureSettingPhrase(mode) {
  if (mode === CAPTURE_VERIFIED_SUCCESS) {
    return 'on for verified successful operations: an experience of the outcome is written, and no assessment of it';
  }
  // A configuration that never named a mode behaves as off, and is reported that way rather than
  // as a value the operator got wrong.
  if (mode === CAPTURE_OFF || mode === null || mode === undefined) {
    return 'off: an experience is written only when you record one';
  }
  return `set to "${String(mode).slice(0, 40)}", which APEX does not recognize, so nothing is captured (valid values: ${CAPTURE_MODES.join(', ')})`;
}
