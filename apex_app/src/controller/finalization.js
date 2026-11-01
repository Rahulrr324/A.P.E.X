// Unified operation finalization: the one tail every controller operation path runs.
//
// Before this module, four controller methods each repeated the same ending - append the audit
// record, learn whether that append succeeded, then attempt automatic experience capture - and a
// fifth path (a task step) is audited by the TaskRunner itself. Repetition is how a future
// operation path silently ends up without its audit record, or with a capture attempted before the
// audit record exists. This module owns steps 3-6 of the contract below; the caller owns the rest.
//
// The order is fixed by which evidence each step needs:
//   1. The outcome is already final (status, decision, output, finishedAt). Not done here, because
//      only the caller knows how its step produced it.
//   2. Whether a side effect may have occurred is already stated by that outcome: a failed
//      verification may have written something, an execution failure did not. Nothing is upgraded.
//   3. The audit record is appended.
//   4. Whether that append succeeded is established from the append itself, never assumed.
//   5. Automatic experience capture is attempted, and it is told step 4's answer. An experience is
//      a verified reference to one audit record, so there is nothing to attempt without it.
//   6. The capture verifies itself by reading the record back against the audit record.
//   7. The caller turns both results into a truthful user-facing disclosure.
//   8. The caller returns the operation's own result, unchanged by any capture failure.
//
// This function cannot fail an operation: append failure is reported to the caller, and a capture
// that throws becomes a notice, because the operation's evidence is already on disk and a
// bookkeeping failure is not evidence against it.
import { shortId } from '../util.js';

export const FINALIZATION_ORDER = Object.freeze([
  'outcome-finalized',
  'side-effect-established',
  'audit-appended',
  'audit-recording-established',
  'capture-attempted',
  'capture-verified',
  'disclosure-produced',
  'operation-result-returned',
]);

// The completion paths, as the controller actually implements them. This is the inventory the
// coverage test walks: a new operation path that appends its own record or ends an operation
// without capture must be added here deliberately (and the coverage test fails until it is), so
// "we forgot" cannot quietly become "it is unaudited" or "it is captured before it is audited".
export const OPERATION_COMPLETION_PATHS = Object.freeze([
  Object.freeze({
    id: 'request',
    entry: 'CognitiveController.handle',
    audit: 'controller',
    capture: 'attempted',
    note: 'every capability the router can select, including task questions and model answers',
  }),
  Object.freeze({
    id: 'memory-correction',
    entry: 'CognitiveController.correctMemory',
    audit: 'controller',
    capture: 'attempted',
    note: 'the correction path predates handle() and keeps its own envelope',
  }),
  Object.freeze({
    id: 'command',
    entry: 'CognitiveController#finishCommandOp',
    audit: 'controller',
    capture: 'attempted',
    note: 'knowledge commands, the experience/feedback/adaptation commands, and audited reads',
  }),
  Object.freeze({
    id: 'task-operation',
    entry: 'CognitiveController#finishTaskOp',
    audit: 'controller',
    capture: 'attempted',
    note: 'task.plan/run/approve/retry/cancel/explain, including refusals',
  }),
  Object.freeze({
    id: 'task-step',
    entry: 'TaskRunner#audit',
    audit: 'task-runner',
    capture: 'not-attempted',
    note: 'the runner writes one record per executed step; task.* is outside the capture subset, so capture is refused by eligibility rather than skipped silently',
  }),
]);

const FINALIZED = Symbol('apex.operation.finalized');

// Appends the audit record, establishes whether that succeeded, attempts capture, and returns the
// three facts the caller needs to disclose. The operation keeps its own outcome either way.
export async function finalizeOperation(op, { append, capture = null, onAuditFailure = null } = {}) {
  if (!op || typeof op !== 'object') throw new TypeError('finalizeOperation needs an operation record');
  if (typeof append !== 'function') throw new TypeError('finalizeOperation needs an append function');
  if (op[FINALIZED]) {
    throw new Error(`operation ${shortId(op.id)} was already finalized; a second audit record would duplicate it`);
  }
  // Non-enumerable, so the mark never reaches a JSONL file or a caller's deep comparison.
  Object.defineProperty(op, FINALIZED, { value: true });

  let recorded = true;
  let recordError = null;
  try {
    await append(op);
  } catch (err) {
    recorded = false;
    recordError = err?.message ?? String(err);
    // The caller decides what an audit failure means for its own status and output; this module
    // never rewrites them, because only the caller knows what its step did before the append.
    if (onAuditFailure) onAuditFailure(err);
  }

  let captureNotice = null;
  if (capture) {
    try {
      captureNotice = await capture(op, { recorded });
    } catch (err) {
      captureNotice = `Experience: not captured (${err?.message ?? String(err)}). Operation ${shortId(op.id)} and its audit record are unchanged.`;
    }
  }
  return { recorded, recordError, captureNotice };
}
