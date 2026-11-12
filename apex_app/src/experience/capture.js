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
  // The prediction ledger's own operations. This is a separate category from `self-bookkeeping`
  // because the reason is not about filling a log with its own traffic: an experience answers "what
  // happened", a prediction answers "what I expected", and capturing one of these operations would
  // put the expectation into the experience log - where the pattern detector and the adaptation
  // derivation read, and from there into how APEX behaves.
  expectation: 'it reads or writes the prediction ledger, whose records are expectations about later events; an experience of one would put an expectation into the log that answers what happened, and from there into pattern and adaptation reads',
  // Executive records are the user's intentions and the plans derived from them. An experience
  // answers "what happened", not "what was intended", and a plan's steps are not events: capturing
  // either would put intentions into the log the pattern and adaptation reads draw from.
  executive: 'it records a goal, a plan, or evidence about them; these are intentions and their classified support, not events that happened, and they must not enter the experience log the pattern and adaptation reads draw from',
  // The world model already stores every claim with its evidence, validity, and provenance, and its
  // own append-only log is the record of the assertion. Capturing a world write would put a second
  // account of the same claim into the experience log the pattern and adaptation reads draw from.
  'world-model': 'it reads or writes the world model, whose records already carry their own evidence, validity, and provenance; an experience of one would copy that claim into the log the pattern and adaptation reads draw from',
});

// Every capability that can reach an operation-end path without being captured. A capability that
// appears in neither list is refused by autoCaptureDecision, but the coverage test fails first: a
// new action has to be classified here or added to the subset on purpose.
export const CAPTURE_EXCLUDED_CAPABILITIES = Object.freeze({
  'app.status': 'read',
  'calc.evaluate': 'read',
  'world.state': 'read',
  'world.state_at': 'read',
  'world.entity.list': 'read',
  'world.entity.show': 'read',
  'world.entity.find': 'read',
  'world.facts': 'read',
  'world.attributes': 'read',
  'world.relationships': 'read',
  'world.events': 'read',
  'world.conflicts': 'read',
  'world.related': 'read',
  'world.history': 'read',
  'world.statement.history': 'read',
  'world.identity.candidates': 'read',
  'world.identity.decision': 'read',
  'world.pair': 'read',
  'world.evidence': 'read',
  'world.changes': 'read',
  'world.inspect': 'read',
  'world.status': 'read',
  'world.entity.add': 'world-model',
  'world.entity.alias': 'world-model',
  'world.entity.retire': 'world-model',
  'world.entity.merge': 'world-model',
  'world.entity.unmerge': 'world-model',
  'world.identity.decide': 'world-model',
  'world.fact.add': 'world-model',
  'world.relationship.add': 'world-model',
  'world.event.add': 'world-model',
  'world.statement.retract': 'world-model',
  'world.statement.supersede': 'world-model',
  'memory.search': 'read',
  'memory.list': 'read',
  'knowledge.list': 'read',
  'knowledge.search': 'read',
  'experience.list': 'read',
  'experience.show': 'read',
  'experience.timeline': 'read',
  'experience.trends': 'read',
  'experience.patterns': 'read',
  'experience.compare': 'read',
  'adaptation.list': 'read',
  'adaptation.eligibility': 'read',
  'prediction.list': 'read',
  'prediction.show': 'read',
  'prediction.history': 'read',
  'prediction.summary': 'read',
  'memory.save_conclusion': 'model-words',
  'model.answer': 'model-words',
  'experience.record': 'self-bookkeeping',
  'feedback.record': 'self-bookkeeping',
  'adaptation.derive': 'self-bookkeeping',
  'adaptation.decide': 'self-bookkeeping',
  'adaptation.retire': 'self-bookkeeping',
  'adaptation.guide': 'self-bookkeeping',
  'prediction.record': 'expectation',
  'prediction.evaluate': 'expectation',
  'prediction.invalidate': 'expectation',
  'goal.add': 'executive',
  'goal.revise': 'executive',
  'goal.confirm': 'executive',
  'goal.update': 'executive',
  'goal.evidence': 'executive',
  'goal.complete': 'executive',
  'goal.link': 'executive',
  'goal.list': 'read',
  'goal.show': 'read',
  'proposal.create': 'executive',
  'proposal.accept': 'executive',
  'proposal.reject': 'executive',
  'proposal.invalidate': 'executive',
  'plan.add': 'executive',
  'plan.revise': 'executive',
  'plan.approve': 'executive',
  'plan.cancel': 'executive',
  'plan.supersede': 'executive',
  'plan.activate': 'executive',
  'plan.reconcile': 'executive',
  // The continuation pair is classified the way the rest of the plan surface is. The nine-state
  // reading re-derives itself from the run records whenever it is asked for, and the command that
  // takes untouched steps up writes step records and task transitions that the task log already
  // holds - so neither needs an experience line on top of them.
  'plan.continuation': 'read',
  'plan.continue': 'executive',
  'plan.list': 'read',
  'plan.show': 'read',
  'plan.validate': 'read',
  // A candidate set and a comparison are re-derived from the goal, the plan record and the live
  // registry whenever they are asked for; capturing one would freeze a comparison of a moment that
  // no longer holds, and the candidates themselves are intentions, not events.
  'plan.candidates': 'read',
  'plan.replan': 'read',
  // The same reasoning covers the outcome pair: the reading of a plan's records is re-derivable from
  // those records at any time, and what plan.assess stores is that derived reading, not an event - an
  // experience of it would say less than the assessment record already says and would put APEX's own
  // interpretation into the log the pattern and adaptation reads draw from.
  'plan.outcome': 'read',
  'plan.assess': 'executive',
  'recover': 'read',
  'task.plan': 'task',
  'task.run': 'task',
  'task.approve': 'task',
  'task.retry': 'task',
  'task.cancel': 'task',
  'task.explain': 'task',
  'task.step': 'task',
  // The outer operation of the executive bridge (the words a user types in a conversation: "prepare
  // a plan to…", "approve plan x", "start plan x", "what is pending"). Each of these ends an operation
  // of its own, and each is classified by what that operation does: a status read, a plan record, a
  // run whose real outcomes are in the task log, or a request that ran nothing.
  'executive.status': 'read',
  'executive.prepare': 'executive',
  'executive.approve': 'executive',
  'executive.execute': 'task',
  'executive.clarify': 'no-action',
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
