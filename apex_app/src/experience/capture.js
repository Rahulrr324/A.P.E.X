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
  filesystem: 'it reads or writes a file outside APEX\'s stores, and no outcome here needs that file\'s content in the experience log',
  // A note is the user's own composition, held in its own append-only revision log. Capturing a
  // note operation would copy the user's text into the experience log that the pattern and
  // adaptation reads draw from, which would turn a personal note into behavioural evidence.
  notes: 'it reads or writes the personal note log, whose records are the user\'s own composition; an experience of one would copy that note into the log the pattern and adaptation reads draw from',
  // Deadlines are dates the owner read from a file. An experience answers what APEX did, and the
  // ledger already carries the source path, digest, and line; capturing an import would put the
  // owner's schedule into the log the pattern and adaptation reads draw from.
  deadlines: 'it reads or writes the deadline ledger, whose records are the owner\'s imported dates with their own source provenance; an experience of one would copy that schedule into the log the pattern and adaptation reads draw from',
  // Backup acts on the data directory as a whole, including this experience log. An experience of
  // an export or a restore would be a record of APEX's own files - and, after a restore, one written
  // into a log that was just replaced - so the archive and the pre-restore copy carry that account.
  backup: 'it reads or replaces the whole data directory, so an experience of one would describe APEX\'s own stores rather than an event, and a restore would write the experience into a log it just replaced',
  // A workshop sheet is the user's own design: components, connections, declared numbers. It is
  // held in its own append-only log, and an experience of a composition would copy that design
  // into the log the pattern and adaptation reads draw from.
  workshop: 'it reads or writes the workshop design log, whose records are the user\'s own composed sheet; an experience of one would copy that design into the log the pattern and adaptation reads draw from',
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
  // Outcome learning judges APEX's own behaviour from the records it holds. Capturing one of these
  // operations would put that judgement - an evaluation, a proposal, a measurement, a rollback - into
  // the very log the pattern and adaptation reads draw from, so the learning loop would start counting
  // its own conclusions as events that happened.
  // The situational log is APEX's own account of what it noticed, how it read it, and what it chose.
  // Capturing one of those operations would feed the awareness loop's bookkeeping into the experience
  // log that patterns and adaptations read, so an event could become evidence about APEX's response
  // to itself.
  situation: 'it records or reads the situational event log, its assessments, decisions, and responses; an experience of one would put the awareness bookkeeping into the log the pattern and adaptation reads draw from',
  learning: 'it records or reads APEX\'s own outcome evaluations, adaptation measurements, and rollbacks; an experience of one would put APEX\'s judgement about its own behaviour into the log the pattern and adaptation reads draw from',
  // T-31 Step 2: a lab proposal, its measured sandbox result, and the owner's promotion decision
  // describe what APEX might become rather than what happened. Capturing one would put a candidate
  // self-change into the log the pattern and adaptation reads draw from, so a proposal would start
  // to count as an event and an idea would feed the loop that shapes behaviour.
  // T-32 Step 3: perception records readings of the machine (CPU, memory, storage, process, and the
  // workspace git state) and the Sentinel's push discipline over them. Capturing one would put host
  // telemetry and notice bookkeeping into the log the pattern and adaptation reads draw from, so a
  // CPU reading would start to count as evidence about behaviour.
  perception: 'it records readings of the host and the workspace, or the Sentinel push discipline over them; an experience of one would put machine telemetry and notice bookkeeping into the log the pattern and adaptation reads draw from',
  evolution: 'it records a proposed change to APEX\'s own behaviour, the measured sandbox result for it, or the owner\'s promotion decision; a candidate self-change is not an event that happened, and it must not enter the experience log the pattern and adaptation reads draw from',
  // T-34 Step 3: acknowledging a briefing writes a checkpoint of what the stores held at that moment.
  // Capturing it would put APEX's own reading of its state into the log the pattern and adaptation
  // reads draw from, so "the owner read a briefing" would start to count as behavioural evidence.
  briefing: 'it records a checkpoint of what the owning stores held when the owner read a briefing; an experience of one would put APEX\'s own reading of its state into the log the pattern and adaptation reads draw from',
  // T-35 Step 2: handing work to another enrolled device is an owner act about where the work lives,
  // not something APEX did. Capturing it would teach the pattern reads that "moved a tab" is behaviour
  // worth generalising from.
  presence: 'it records an owner act about where work should continue - an envelope, its digest, its claim or its revocation - rather than something APEX did; capture would make a device handoff look like behavioural evidence',
  // T-36 Step 1: a cold-start bootstrap is the machine being read for the first time, not an act
  // APEX chose. Every value it records is re-derivable by reading the machine again, and an
  // experience of it would teach the pattern reads that "install and boot" is behavioural evidence.
  system: 'it reads the machine and the repository for the first time and records what it found; every value it holds is re-derivable by reading them again, so an experience of it would say less than a fresh reading',
  // T-37 Step 1 (2026-11-21): Track 2. The substrate is a deterministic simulation: its whole state is
  // a function of its seed and its step count, and the ledger it writes already records every step.
  // An experience of a step would copy a number that a replay reproduces exactly, and an experience
  // of the bridge reset would record the state of a translator. Neither says anything about what APEX
  // did to the owner's world, which is what the experience log is for.
  neural: 'it advances a deterministic simulation whose entire state is a function of its seed and step count, and whose own ledger already records each step; an experience of one would copy a number that a replay reproduces exactly',
});

// Every capability that can reach an operation-end path without being captured. A capability that
// appears in neither list is refused by autoCaptureDecision, but the coverage test fails first: a
// new action has to be classified here or added to the subset on purpose.
export const CAPTURE_EXCLUDED_CAPABILITIES = Object.freeze({
  // T-32 Step 3: perception. A reading is re-derivable only while the machine is in the same state,
  // which is exactly why it belongs in its own ledger rather than in the experience log.
  'briefing.acknowledge': 'briefing',
  'presence.handoff.stage': 'presence',
  'presence.handoff.claim': 'presence',
  'presence.handoff.revoke': 'presence',
  'perception.sense_host': 'perception',
  'perception.state': 'perception',
  'perception.dismiss_alert': 'perception',
  'perception.revoke_suppression': 'perception',
  // T-36 Step 1: the cold-start bootstrap and its status read.
  'system.bootstrap': 'system',
  'system.bootstrap_status': 'system',
  'neural.step': 'neural',
  'neural.read': 'neural',
  'neural.bridge_reset': 'neural',
  'app.status': 'read',
  'app.capabilities': 'read',
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
  'world.belief.trace': 'read',
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
  'adaptation.effectiveness': 'read',
  'adaptation.reviews': 'read',
  'adaptation.review.inspect': 'read',
  'adaptation.review.reconcile': 'read',
  'evidence.integrity': 'read',
  'learning.observe': 'learning',
  'learning.propose': 'learning',
  'learning.measure': 'learning',
  'learning.rollback': 'learning',
  'learning.patterns': 'read',
  'learning.status': 'read',
  'situation.ingest': 'situation',
  'situation.evaluate': 'situation',
  'situation.decide': 'situation',
  'situation.response': 'situation',
  'situation.state': 'read',
  'situation.events': 'read',
  'situation.decisions': 'read',
  'situation.status': 'read',
  'history.reconstruct': 'read',
  'prediction.list': 'read',
  'prediction.show': 'read',
  'prediction.history': 'read',
  'prediction.summary': 'read',
  'prediction.longitudinal': 'read',
  'memory.save_conclusion': 'model-words',
  'model.answer': 'model-words',
  // The contract is a declaration read from configuration and backend metadata; it contacts no
  // endpoint and observes nothing that could become an experience.
  'model.contracts': 'read',
  'neural.contract': 'read',
  'experience.record': 'self-bookkeeping',
  'feedback.record': 'self-bookkeeping',
  'task.feedback': 'self-bookkeeping',
  'adaptation.derive': 'self-bookkeeping',
  'adaptation.decide': 'self-bookkeeping',
  'adaptation.retire': 'self-bookkeeping',
  'adaptation.guide': 'self-bookkeeping',
  'adaptation.review.open': 'self-bookkeeping',
  'adaptation.review.decide': 'self-bookkeeping',
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
  'plan.outline': 'read',
  'plan.replan': 'read',
  // The same reasoning covers the outcome pair: the reading of a plan's records is re-derivable from
  // those records at any time, and what plan.assess stores is that derived reading, not an event - an
  // experience of it would say less than the assessment record already says and would put APEX's own
  // interpretation into the log the pattern and adaptation reads draw from.
  'plan.outcome': 'read',
  'plan.assess': 'executive',
  'plan.pause': 'executive',
  'plan.resume': 'executive',
  'safety.lockdown': 'executive',
  'safety.release': 'executive',
  // T-29 (2026-11-19): one cognitive run ends one operation whose real outcomes are the task
  // records it created and ran, so it is classified with the executive commands that write those.
  'cognition.run': 'executive',
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
  'filesystem.find': 'filesystem',
  'filesystem.summarize': 'filesystem',
  'filesystem.extract': 'filesystem',
  'filesystem.compare': 'filesystem',
  'filesystem.report': 'filesystem',
  'filesystem.write': 'filesystem',
  // The lifecycle acts on files under the configured root, including moving an entry into the
  // quarantine; like the other filesystem actions, no outcome here needs the file's content or
  // path in the experience log.
  'filesystem.mkdir': 'filesystem',
  'filesystem.move': 'filesystem',
  'filesystem.delete': 'filesystem',
  'filesystem.restore': 'filesystem',
  'filesystem.trash': 'filesystem',
  'filesystem.batch': 'filesystem',
  'note.add': 'notes',
  'note.update': 'notes',
  'note.from_digest': 'notes',
  'note.list': 'read',
  'note.show': 'read',
  'note.search': 'read',
  'note.history': 'read',
  'deadline.list': 'read',
  'deadline.import': 'deadlines',
  'backup.export': 'backup',
  'backup.inspect': 'backup',
  'backup.restore': 'backup',
  'knowledge.digest': 'read',
  'work.review': 'read',
  'council.deliberate': 'read',
  'council.list': 'read',
  'council.get': 'read',
  'council.replay': 'read',
  'council.compare': 'read',
  // A design sheet is the user's own composition, held in its own append-only log. Capturing a
  // composition would copy that sheet into the experience log the pattern and adaptation reads
  // draw from, turning a design into behavioural evidence; a simulation is re-derivable from the
  // stored sheet and says nothing about what happened.
  'workshop.compose': 'workshop',
  // T-33 Step 3: a verification is a check of the user's own sheet and a promotion is the user's own
  // decision about it. Recording either as an experience would copy the design into the log the
  // pattern and adaptation reads draw from, which is the same reason composition is excluded.
  'workshop.verify': 'workshop',
  'workshop.promote': 'workshop',
  'evolution.propose': 'evolution',
  'evolution.verify': 'evolution',
  'evolution.promote': 'evolution',
  'evolution.decide': 'evolution',
  'workshop.list': 'read',
  'workshop.get': 'read',
  'workshop.inspect': 'read',
  'workshop.simulate': 'read',
  // T-38 Step 2: the file-backed Workshop. The two workspace reads are reads. The three sandbox
  // writes are excluded for the reason the composed sheet is: they carry the user's own proposed
  // content, and copying that into the experience log would turn a proposal into behavioural
  // evidence the pattern and adaptation reads then draw from.
  'workspace.inspect': 'read',
  'workspace.read_file': 'read',
  'workshop.stage_file': 'workshop',
  'workshop.verify_file': 'workshop',
  'workshop.promote_file': 'workshop',
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
