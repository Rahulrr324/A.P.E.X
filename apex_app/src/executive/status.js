// Executive progress communication: what APEX's records say about open work.
//
// These questions - what are you doing, what is next, what needs my approval, can you continue, can
// you cancel - are answered from the plan, task, goal, and continuation records, never from a model.
// A model cannot know whether a step ran: the task log and the audit do. Every state printed here
// names the record it came from, and a state with no record behind it is not printed at all, so a
// proposal can never be read as an action that happened.
import { shortId, truncate } from '../util.js';
import { isOpenPlan, planProgress } from '../plans/model.js';
import { StepStatus } from '../tasks/model.js';
import { goalProgress, isOpenStatus, needsUserDecision } from '../goals/model.js';
import { STRATEGY_NOTE } from '../plans/candidates.js';
import {
  BOUNDS, ClaimKind, CLAIM_KINDS, CLAIM_LEGEND, CLAIM_NOTE, ExecutionState, NO_BACKGROUND_NOTE,
  READINESS_BASIS, READINESS_STATES, STATE_EVIDENCE, stateOfPlanStatus,
} from './vocabulary.js';
import { prioritizationFactors, renderReadiness } from './readiness.js';
import { renderSelection } from './selection.js';
import { CAUTION_NOTE, cautionLine } from '../prediction/caution.js';
import { LEARNING_BOUNDS, LEARNING_NOT_APPLIED, learningStatements } from './learning.js';

function words(text) {
  return truncate(String(text ?? ''), 160);
}

// The task a plan was started under, if the activation names one and it can be read.
function taskForPlan(plan, tasksById) {
  const id = plan.activation?.taskId ?? null;
  if (!id) return null;
  return tasksById.get(id) ?? null;
}

// One record translated into the shared vocabulary. A plan whose task cannot be read is reported as
// what the record actually says - an activation naming an unreadable task - rather than as running.
export function planState(plan, tasksById = new Map()) {
  const task = taskForPlan(plan, tasksById);
  if (plan.status === 'active') {
    if (!task) return { state: ExecutionState.BLOCKED, evidence: `plan ${shortId(plan.id)} is active and names task ${shortId(plan.activation?.taskId ?? '')}, which is not in the task log` };
    const progress = planProgress(plan);
    if (task.status === 'running') return { state: ExecutionState.RUNNING, evidence: `task ${shortId(task.id)} is recorded as running` };
    if (task.status === 'paused') return { state: ExecutionState.BLOCKED, evidence: `task ${shortId(task.id)} is paused for a user decision` };
    if (task.status === 'cancelled') return { state: ExecutionState.FAILED, evidence: `task ${shortId(task.id)} was cancelled` };
    if (task.status === 'failed') return { state: ExecutionState.FAILED, evidence: `task ${shortId(task.id)} failed` };
    if (task.steps.some((s) => s.status === StepStatus.UNCERTAIN)) {
      return { state: ExecutionState.UNCERTAIN, evidence: `task ${shortId(task.id)} has a step whose outcome was not established` };
    }
    if (task.status === 'completed') {
      return progress.completed === progress.total
        ? { state: ExecutionState.VERIFIED, evidence: `task ${shortId(task.id)} completed and ${progress.completed} step outcome(s) recorded against it` }
        : { state: ExecutionState.PARTIALLY_COMPLETED, evidence: `task ${shortId(task.id)} finished with ${progress.completed} of ${progress.total} step outcomes recorded on the plan` };
    }
    return { state: ExecutionState.PARTIALLY_COMPLETED, evidence: `task ${shortId(task.id)} is ${task.status} with ${progress.completed} of ${progress.total} outcomes recorded` };
  }
  const state = stateOfPlanStatus(plan.status);
  if (!state) return { state: null, evidence: `plan ${shortId(plan.id)} has the unrecognised status ${words(plan.status)}` };
  return { state, evidence: `plan ${shortId(plan.id)} is recorded as ${plan.status}` };
}

function stepStates(tasks) {
  const out = [];
  for (const task of tasks) {
    for (const step of task.steps ?? []) {
      if (step.status === StepStatus.PENDING) continue;
      out.push({
        task: shortId(task.id),
        step: step.id,
        action: step.action ?? null,
        state: step.status,
        evidence: `task ${shortId(task.id)} step ${step.id} is recorded as ${step.status}`,
      });
    }
  }
  return out;
}

// Every open record, in the shared vocabulary, with the line it came from. Closed records are left
// out of the list but counted, so "nothing is open" is a statement about the records read, not an
// invention.
export function executiveStates({ goals = [], plans = [], tasks = [] }) {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const rows = [];
  for (const plan of plans) {
    const { state, evidence } = planState(plan, tasksById);
    rows.push({
      kind: 'plan',
      id: plan.id,
      title: words(plan.outcome),
      state,
      evidence,
      open: isOpenPlan(plan.status),
    });
  }
  for (const task of tasks) {
    if (task.planId) continue; // already shown as the plan it was started from
    const uncertain = (task.steps ?? []).filter((s) => s.status === StepStatus.UNCERTAIN).length;
    const completed = (task.steps ?? []).filter((s) => s.status === StepStatus.COMPLETED).length;
    rows.push({
      kind: 'task',
      id: task.id,
      title: words((task.steps ?? []).map((s) => s.description).join('; ')),
      state: uncertain > 0
        ? ExecutionState.UNCERTAIN
        : task.status === 'running'
          ? ExecutionState.RUNNING
          : task.status === 'completed'
            ? ExecutionState.VERIFIED
            : task.status === 'failed' || task.status === 'cancelled'
              ? ExecutionState.FAILED
              : completed > 0
                ? ExecutionState.PARTIALLY_COMPLETED
                : ExecutionState.AWAITING_APPROVAL,
      evidence: `task ${shortId(task.id)} is recorded as ${task.status} with ${completed} completed and ${uncertain} uncertain step(s)`,
      open: task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'failed',
    });
  }
  for (const goal of goals) {
    rows.push({
      kind: 'goal',
      id: goal.id,
      title: words(goal.request),
      state: goal.status === 'blocked'
        ? ExecutionState.BLOCKED
        : goal.status === 'completed'
          ? ExecutionState.VERIFIED
          : goal.status === 'proposed'
            ? ExecutionState.AWAITING_APPROVAL
            : isOpenStatus(goal.status) ? ExecutionState.PREPARED : ExecutionState.FAILED,
      evidence: `goal ${shortId(goal.id)} is recorded as ${goal.status} with ${goal.criteria?.length ?? 0} criterion (s)`,
      open: isOpenStatus(goal.status),
    });
  }
  return rows;
}

function byState(rows, state) {
  return rows.filter((r) => r.state === state);
}

// One record, the state read from it, and the record the state was read from. The citation is
// labelled rather than given as a reason: "approved because plan x is recorded as approved" reads as
// circular, while the same line under "evidence:" says which record to check.
function recordList(rows, lines, { limit = BOUNDS.maxListedRecords } = {}) {
  for (const row of rows.slice(0, limit)) {
    line(`  - ${row.kind} ${shortId(row.id)}: ${row.title}`, lines);
    line(`    ${row.state}. evidence: ${row.evidence}`, lines);
  }
  if (rows.length > limit) line(`  - ... and ${rows.length - limit} more; run "node bin/apex.js work" for the ranked list`, lines);
}

function line(text, lines) {
  lines.push(truncate(String(text), 320));
}

const HEADER = 'Executive status, read from APEX records. Nothing here was run, approved, changed, or cancelled.';

// The view is bounded so one question cannot print a whole portfolio. `label` and `hint` are what a
// reader is told to run instead, so a cut view sends them to the record list rather than leaving them
// with a half answer and no way to finish it.
//
// `maxLines` and `maxChars` default to the shared budgets; a view that carries a fixed inventory it
// must print whole can ask for the room that inventory needs, so the budget it gives way on is its
// own and not every other answer's.
function boundedView(lines, {
  label = 'status view', hint = '"node bin/apex.js work" lists the open records in full',
  maxLines = BOUNDS.maxStatusLines, maxChars = BOUNDS.maxStatusChars,
} = {}) {
  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  let display = shown.join('\n');
  const cutByChars = display.length > maxChars;
  if (truncated || cutByChars) {
    // The reason the answer gave way is stated as the bound that actually did it: a view cut at 4000
    // characters while it still had lines left is not a view that reached 40 lines, and a reader who is
    // told the wrong reason cannot tell how much of the answer the command still holds.
    const cut = truncated ? `cut at ${maxLines} lines` : `cut at ${maxChars} characters`;
    display = `${truncate(display, maxChars)}\n[${label} ${cut}; ${hint}]`;
  }
  return { display, lines: shown, truncated: truncated || cutByChars };
}

// The answer to one status question. `candidates` is the existing continuation ranking, so the
// recommendation APEX gives in a conversation is the same one `work` and `next` print.
export function describeExecutiveStatus({
  question, goals = [], plans = [], tasks = [], candidates = [], problems = [],
}) {
  const rows = executiveStates({ goals, plans, tasks });
  const open = rows.filter((r) => r.open);
  const lines = [HEADER, ''];
  const counts = {};
  for (const row of rows) counts[row.state ?? 'unrecognised'] = (counts[row.state ?? 'unrecognised'] ?? 0) + 1;
  line(`Records read: ${goals.length} goal(s), ${plans.length} plan(s), ${tasks.length} task(s).`, lines);
  if (problems.length > 0) {
    line('Problems reading those records (so the answer is partial, not complete):', lines);
    for (const p of problems.slice(0, 6)) line(`  - ${words(p)}`, lines);
    if (problems.length > 6) line(`  - ... and ${problems.length - 6} more`, lines);
  }

  switch (question) {
    case 'activity': {
      const running = open.filter((r) => r.state === ExecutionState.RUNNING);
      line(NO_BACKGROUND_NOTE, lines);
      if (running.length === 0) {
        line('No plan or task is recorded as running, so APEX is not carrying out work for you.', lines);
      } else {
        line(`${running.length} record(s) name work in progress:`, lines);
        recordList(running, lines);
      }
      break;
    }
    case 'next': {
      if (candidates.length === 0) {
        line('No open work is described by the records that were read. Nothing is suggested, because nothing is waiting.', lines);
      } else {
        line(`Next, ranked from the records (a recommendation only - it is not permission):`, lines);
        for (const [index, c] of candidates.slice(0, 3).entries()) {
          line(`  ${index + 1}. ${words(c.title)}`, lines);
          line(`     ${c.kind} ${shortId(c.ref)} is ${c.status ?? 'unknown'}; action: ${c.action}${c.ready ? '' : ' (not ready)'}`, lines);
          // The readiness the ranking read from a record, when a record stated one. A candidate whose
          // state was never read is printed without it rather than with a guessed state.
          if (c.readiness) line(`     readiness: ${c.readiness}`, lines);
          if (c.command) line(`     command: ${c.command}`, lines);
          for (const caution of c.cautions ?? []) line(`     caution: ${words(cautionLine(caution))}`, lines);
          for (const b of c.blockers.slice(0, 3)) line(`     blocker: ${words(b)}`, lines);
          if (c.requiresAuthorization) line('     this needs your own explicit action; APEX will not take it for you', lines);
          if (c.cautionChangedAction) line(`     ${words(CAUTION_NOTE)}`, lines);
        }
        if (candidates.length > 3) line(`  ${candidates.length - 3} other candidate(s): "node bin/apex.js work"`, lines);
      }
      break;
    }
    case 'completed': {
      const verified = byState(rows, ExecutionState.VERIFIED);
      const partial = byState(rows, ExecutionState.PARTIALLY_COMPLETED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.COMPLETED);
      if (verified.length === 0 && partial.length === 0 && steps.length === 0) {
        line('No step or plan is recorded as verified complete. Nothing is claimed as done.', lines);
      } else {
        line(`${verified.length} record(s) verified complete, ${partial.length} partially complete, ${steps.length} step outcome(s) recorded as completed:`, lines);
        recordList([...verified, ...partial], lines);
      }
      break;
    }
    case 'failed': {
      const failed = byState(rows, ExecutionState.FAILED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.FAILED);
      if (failed.length === 0 && steps.length === 0) {
        line('No plan, task, or step is recorded as failed.', lines);
      } else {
        line(`${failed.length} record(s) failed, ${steps.length} step(s) recorded as failed. Nothing retries on its own:`, lines);
        recordList(failed, lines);
        for (const s of steps.slice(0, BOUNDS.maxListedRecords)) line(`  - task ${s.task} step ${s.step}: failed (${s.action ?? 'action not recorded'})`, lines);
      }
      break;
    }
    case 'blocked': {
      const blocked = byState(rows, ExecutionState.BLOCKED);
      const blockers = candidates.flatMap((c) => (c.blockers ?? []).map((b) => ({ c, b })));
      if (blocked.length === 0 && blockers.length === 0) {
        line('No plan, goal, or task is recorded as blocked, and no ranked candidate carries a blocker.', lines);
      } else {
        line(`${blocked.length} record(s) blocked${blockers.length ? `, and ${blockers.length} blocker(s) named by the ranked candidates` : ''}:`, lines);
        recordList(blocked, lines);
        for (const { c, b } of blockers.slice(0, BOUNDS.maxListedRecords)) {
          line(`  - ${c.kind} ${shortId(c.ref)} (${c.action}): ${words(b)}`, lines);
        }
      }
      break;
    }
    case 'approval': {
      const awaiting = byState(rows, ExecutionState.AWAITING_APPROVAL);
      const approved = byState(rows, ExecutionState.APPROVED);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.AWAITING_APPROVAL);
      line('What needs your approval, and nothing else can supply:', lines);
      if (awaiting.length === 0 && steps.length === 0 && approved.length === 0) {
        line('  Nothing is waiting on you in the records that were read.', lines);
      }
      recordList(awaiting, lines);
      for (const s of steps.slice(0, BOUNDS.maxListedRecords)) {
        line(`  - task ${s.task} step ${s.step} is waiting for a step-level approval`, lines);
      }
      if (approved.length > 0) {
        line('Approved already, and waiting for you to start them (approval starts nothing by itself):', lines);
        recordList(approved, lines);
      }
      break;
    }
    case 'uncertain': {
      const uncertain = byState(rows, ExecutionState.UNCERTAIN);
      const steps = stepStates(tasks).filter((s) => s.state === StepStatus.UNCERTAIN);
      if (uncertain.length === 0 && steps.length === 0) {
        line('No step is recorded as uncertain. Every recorded step outcome either verified or failed.', lines);
      } else {
        line(`${steps.length} step(s) are uncertain: they may or may not have happened. APEX will not retry one, because a retry could repeat a side effect:`, lines);
        for (const s of steps.slice(0, BOUNDS.maxListedRecords)) {
          line(`  - task ${s.task} step ${s.step}: ${s.action ?? 'action not recorded'}. Resolve it from its own audit record: "node bin/apex.js task explain ${s.task} recovery"`, lines);
        }
        recordList(uncertain, lines);
      }
      break;
    }
    case 'continue': {
      const resumable = candidates.filter((c) => c.action === 'resume-task' || c.action === 'resolve-interrupted' || c.action === 'start-plan');
      line(NO_BACKGROUND_NOTE, lines);
      if (resumable.length === 0) {
        line('Nothing in the records is waiting to be continued: no interrupted task, no uncertain step blocking a task, and no approved plan that has not started.', lines);
      } else {
        line(`Yes, work can be continued, and only when you run the command: ${resumable.length} record(s) can be picked up.`, lines);
        for (const c of resumable.slice(0, 4)) {
          line(`  - ${words(c.title)}: ${c.command ?? c.action}`, lines);
        }
        line('  A step whose outcome was never established is not replayed: continuing means resolving it first, from its own audit record.', lines);
      }
      break;
    }
    case 'cancel': {
      const running = open.filter((r) => r.state === ExecutionState.RUNNING);
      const cancelable = open.filter((r) => r.kind === 'plan' || r.kind === 'task');
      line(NO_BACKGROUND_NOTE, lines);
      if (cancelable.length === 0) {
        line('There is nothing to cancel: no plan is drafted, approved, or active in the records read.', lines);
      } else {
        line(`Yes, safely. ${cancelable.length} open record(s) can be stopped, and stopping is a recorded decision, not a silent one:`, lines);
        for (const r of cancelable.slice(0, 4)) {
          const command = r.kind === 'plan'
            ? `node bin/apex.js plan cancel ${shortId(r.id)} --reason <text>`
            : `node bin/apex.js task cancel ${shortId(r.id)}`;
          line(`  - ${r.kind} ${shortId(r.id)}: ${command}`, lines);
        }
        line('  A step that has already verified keeps its result. A step that was interrupted is left uncertain until you resolve it, because APEX cannot tell from the log whether it happened.', lines);
        if (running.length > 0) line('  Nothing is running in another process, so cancelling cannot leave a half-written action behind.', lines);
      }
      break;
    }
    default: {
      line('Overall state of the open records:', lines);
      for (const [state, count] of Object.entries(counts)) {
        line(`  ${state}: ${count} - ${STATE_EVIDENCE[state] ?? 'the record carries a status this view does not translate'}`, lines);
      }
      if (open.length === 0) {
        line('', lines);
        line('Nothing is open. No work is proposed, prepared, approved, running, or blocked.', lines);
      } else {
        line('', lines);
        recordList(open, lines, { limit: 8 });
      }
    }
  }

  line('', lines);
  line('These states were read from records. APEX has proposed nothing here, approved nothing, started nothing, and completed nothing.', lines);
  const view = boundedView(lines);
  return { ...view, rows, counts };
}

// ---- planning answers -------------------------------------------------------
// The questions the mission loop asks once a plan exists - what else could do this, what did this one
// establish, can this be taken up now - are answered from the records the audited reads return, and
// every claim line says which kind of claim it is. A model cannot answer them: it holds no step
// outcome, no gate result and no comparison. The marks exist because the part of an answer that can be
// wrong is what APEX concluded from a record, not what it read from one, and a reader has to be able to
// tell those apart to check the answer. No reasoning steps appear, because there are none to expose:
// each line names the field or the operation it was read from.

const OPTIONS_HEADER = 'Planning options, answered from APEX records: the goal\'s own criteria, the live action registry, and the disclosed comparison rule.';
const OUTCOME_HEADER = 'A plan\'s outcome, answered from its recorded step outcomes, the audit operations they cite, the goal\'s criteria, and what the stores still hold.';
const READINESS_HEADER = 'Continuation readiness, answered from the plan, goal, task and comparison records and the live validity check.';

// One claim line, prefixed with the kind of claim it is. An unlisted kind is a bug in the caller, so
// it degrades to `fact` rather than printing a label a reader cannot look up.
function mark(kind, text, limit = 200) {
  const k = CLAIM_KINDS.includes(kind) ? kind : ClaimKind.FACT;
  return `[${k}] ${truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), limit)}`;
}

// A block from one of the other executive renderers, kept line by line so `line()` bounds each part
// instead of collapsing a whole comparison into one truncated string.
function block(text, lines) {
  for (const part of String(text ?? '').split('\n')) line(part, lines);
}

// The learning disclosure, printed in the shared vocabulary so a record cannot be read as more than the
// class it belongs to: an open expectation carries `[prediction]`, which the legend defines as resolved
// neither way, and a decided adaptation or a recorded verdict carries `[fact]`, which is a field of a
// named record. The block ends by saying what it did not do, because a reader who has just looked at a
// comparison is entitled to know whether an expectation moved it.
function learningBlock(learning, lines, reserve = 0) {
  line('', lines);
  if (!learning) {
    line('What the records of past attempts say: no learning read was taken for this answer, so nothing about a past attempt is claimed here.', lines);
    return;
  }
  const statements = learningStatements(learning).map((s) => mark(s.kind, s.text, 280));
  const caps = learning.scope?.capabilities ?? [];
  const note = `  ${learning.note ?? LEARNING_NOT_APPLIED}`;
  // Two tiers of header. The wide one names the capabilities the read was scoped to; the compact one says
  // only what the note beneath it refers to. Both exist because the view is bounded on characters as well
  // as lines, and an answer that is inside its line budget can still have no room for a header that names
  // eight capabilities - an answer whose disclosure is cut mid-sentence discloses nothing.
  const guided = learning.influencesSelection === true;
  const headerWide = `What the records of past attempts${caps.length ? ` about ${caps.join(', ')}` : ''}, ${guided ? 'disclosed, with the user\'s recorded shape checked against the comparison:' : 'disclosed and applied to nothing:'}`;
  const headerCompact = guided ? 'Learning read, with a recorded shape in the comparison:' : 'Learning read, applied to nothing:';
  // The block gives way from inside itself. The header and the note are its floor, because an answer that
  // lost the note leaves a reader to guess whether these records moved the selection, and the cut
  // `boundedView` applies takes the tail of the answer, which is exactly where that note sits.
  // `reserve` is how many lines the caller still has to print after this block, so a caller that ran out
  // of room prints its own trailing lines rather than printing them over the cut marker.
  const lineRoom = BOUNDS.maxStatusLines - lines.length - reserve;
  const room = BOUNDS.maxStatusChars - lines.join('\n').length;
  const header = headerWide.length + note.length + 2 <= room ? headerWide : headerCompact;
  const charRoom = room - header.length - note.length - 2;
  const shown = [];
  let spent = 0;
  for (const text of statements) {
    if (shown.length >= LEARNING_BOUNDS.answerStatements || shown.length + 3 > lineRoom) break;
    if (spent + text.length + 1 > charRoom) break;
    spent += text.length + 1;
    shown.push(text);
  }
  const more = statements.length - shown.length;
  const pointer = `  ... and ${more} more statement(s) from the same read; the command's own print shows them with the five separations.`;
  const pointerFits = more > 0 && shown.length + 4 <= lineRoom && spent + pointer.length + 1 <= charRoom;
  line(header, lines);
  for (const text of shown) line(text, lines);
  if (pointerFits) line(pointer, lines);
  line(note, lines);
}

// The claim legend, printed where a view closes. A reader who has not seen this layer's output before
// cannot look up what `[suggestion]` means, and the mark is the part of the answer that tells them how
// much of it APEX concluded rather than read.
function claimNote(lines) {
  line('', lines);
  line('What each mark means:', lines);
  for (const [kind, meaning] of CLAIM_LEGEND) line(`  [${kind}] - ${meaning}`, lines);
  line(CLAIM_NOTE, lines);
}

// The body is bounded first and the legend appended after it, so a reader whose answer was cut off can
// still look up the marks on the lines they did read. `lines` stays the body alone, so the tally of
// claim kinds counts the answer's claims and not the key that explains them.
function boundWithLegend(lines, opts = {}) {
  const view = boundedView(lines, opts);
  const tail = [];
  claimNote(tail);
  return { ...view, display: `${view.display}\n${tail.join('\n')}` };
}

function kindsShown(lines) {
  const tally = {};
  for (const l of lines) {
    const m = /^\s*\[([^\]]+)\]/.exec(l);
    if (m && CLAIM_KINDS.includes(m[1])) tally[m[1]] = (tally[m[1]] ?? 0) + 1;
  }
  return tally;
}

// The candidate-set digest is the set of per-candidate digests the read was bound to. Printed as one
// shortened string it is a fragment of a bracket, which tells a reader nothing, so each member is
// shortened with its count and can be matched against the digest on the candidate lines beside it.
function setDigestLabel(value) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(value ?? ''));
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed)) {
    return `${parsed.length} candidate digest(s) [${parsed.map((d) => shortId(d)).join(', ')}]`;
  }
  return truncate(String(value ?? 'none recorded'), 72);
}

function unreadableView(lines, problems, { label, hint, noun }) {
  line(`${noun} could not be read, so this answer states only what stopped it:`, lines);
  for (const p of (problems ?? []).slice(0, 6)) line(mark(ClaimKind.FACT, p), lines);
  if ((problems ?? []).length === 0) line(mark(ClaimKind.FACT, 'no reason was returned, so nothing is claimed about the records.'), lines);
  return boundWithLegend(lines, { label, hint });
}

// The options answer: what approaches a goal supports now, what each one takes on and touches, where
// the disclosed rule put them, and which one a record was made of - with the alternatives kept in view.
export function describePlanOptions({
  goal = null, data = null, selection = null, reading = null,
  operationId = null, recorded = null, problems = [],
}) {
  const lines = [OPTIONS_HEADER, ''];
  if (!data) {
    const view = unreadableView(lines, problems, {
      label: 'planning options', hint: '"node bin/apex.js plan candidates <goal-id>" reads them under its own operation', noun: 'The candidate set',
    });
    return { ...view, kinds: kindsShown(view.lines) };
  }
  const comparison = data.comparison ?? {};
  line(`Read and audited under operation ${shortId(operationId ?? 'unknown')}. The read changed nothing${recorded ? `, and one draft was recorded from it (${shortId(recorded.id)})` : ', and this answer records nothing'}.`, lines);
  if (goal) {
    const p = goalProgress(goal);
    line(mark(ClaimKind.FACT, `goal ${shortId(goal.id)} is recorded as ${goal.status} at revision ${goal.revision}: ${p.total} criterion(s) on record, ${p.gating} made required by the user (${p.gatingSatisfied} satisfied), ${p.suggested} put forward by APEX, ${p.declined} declined.`), lines);
    for (const c of (goal.criteria ?? []).filter(needsUserDecision)) {
      line(mark(ClaimKind.SUGGESTION, `${c.id} ("${c.description}") is a criterion APEX put forward (${c.basis ?? 'from its reading of the records'}); it is not a requirement until you record one, and no plan completes the goal against it.`), lines);
    }
  }
  if (data.planId) {
    const snap = data.planSnapshot ?? {};
    line(mark(ClaimKind.FACT, `this is a revision of plan ${shortId(data.planId)}, recorded as v${snap.version ?? '?'} (${snap.status ?? '?'}): that plan and its approval are unchanged by this read, and a revision needs fresh validation and fresh approval.`), lines);
    for (const f of (data.failedOperations ?? []).slice(0, 4)) {
      line(mark(ClaimKind.VERIFIED_OUTCOME, `${f.detail}${f.operationId ? ` (operation ${shortId(f.operationId)})` : ' (the step record carries no operation id, so nothing is cited for it)'}`), lines);
    }
    if ((data.failedOperations ?? []).length === 0) {
      line(mark(ClaimKind.FACT, 'the plan record holds no failed or uncertain step outcome, so this revision answers the stated reason and the constraints given, not a recorded failure.'), lines);
    }
  }
  line(mark(ClaimKind.FACT, `${(data.candidates ?? []).length} approach(es) were generated from those records and compared; the candidate set digest is ${setDigestLabel(data.candidateSetDigest)}.`), lines);
  line('What the approaches mean:', lines);
  for (const [name, note] of Object.entries(STRATEGY_NOTE)) line(`  ${name} - ${note}`, lines);
  for (const c of data.candidates ?? []) {
    line(mark(ClaimKind.FACT, `${c.strategy}: ${c.steps} step(s), ${c.writes} write(s), ${c.risk} risk, digest ${shortId(c.digest)}, settles ${c.criteriaCovered?.length ? c.criteriaCovered.join(', ') : 'no recorded criterion'}; ${c.validation?.ok ? 'its read-only validation passed' : `validation refused: ${(c.validation?.problems ?? []).join('; ')}`}.`), lines);
  }
  for (const s of data.skipped ?? []) line(mark(ClaimKind.FACT, `${s.strategy} was not offered at all: ${s.reason}`), lines);
  for (const c of comparison.excluded ?? []) {
    line(mark(ClaimKind.FACT, `${c.strategy} was excluded by ${(c.failedGates ?? []).map((g) => `gate ${g.gate}: ${g.detail}`).join('; ')}`), lines);
  }
  for (const u of data.unaddressed ?? []) line(mark(ClaimKind.FACT, `no registered capability can carry ${u.criterionId ?? 'a criterion'} ("${u.text}") now, so no approach on the table settles it.`), lines);
  for (const a of data.assumedFromGoalRequest ?? []) {
    line(mark(ClaimKind.ASSUMPTION, `${a.criterionId ?? 'a criterion'} ("${a.text}") is planned only from the goal's recorded request, not from its own words: the step offered for it settles nothing by itself.`), lines);
  }
  for (const t of comparison.tradeOffs ?? []) line(mark(ClaimKind.FACT, t), lines);
  for (const t of comparison.ties ?? []) line(mark(ClaimKind.FACT, t), lines);
  if (comparison.ok === false) line(mark(ClaimKind.FACT, `no candidate could be compared: ${comparison.reason ?? 'no reason given'}.`), lines);
  line('', lines);
  line('Selection, which is APEX reading the comparison: it grants nothing, and the recording is a separate write.', lines);
  if (selection) block(renderSelection(selection), lines);
  if (reading) {
    line('', lines);
    line('Readiness of what the selection left on the table:', lines);
    block(renderReadiness(reading), lines);
  }
  const occ = data.occupancy ?? null;
  if (occ) {
    line('', lines);
    line(mark(ClaimKind.FACT, `as the read reported it: the plan store holds ${occ.drafts?.length ?? 0} draft(s) for this goal of at most ${occ.maxDrafts}, and ${occ.live?.length ?? 0} live plan(s); it would accept ${occ.draftsRemaining} more.`), lines);
  }
  if (recorded) {
    line(mark(ClaimKind.FACT, `recorded draft ${shortId(recorded.id)}: ${recorded.steps} step(s), recorded from the ${recorded.strategy} candidate, whose compared digest is ${shortId(recorded.digest ?? '')}. A draft is a record of an intention, not a run; its own content hash is in the preview below.`), lines);
    line(`  to approve it: node bin/apex.js plan approve ${shortId(recorded.id)}`, lines);
  } else if (selection?.ok !== true) {
    line('  Nothing was recorded, because the rule did not separate one candidate. Naming a priority settles it: say which of the approaches you want and APEX records that one.', lines);
  }
  if (data.learning) learningBlock(data.learning, lines);
  else {
    line('', lines);
    line('No prediction appears above: a comparison of recorded candidates holds no expectation about what will happen, and a passed gate is not a probability.', lines);
  }
  const view = boundWithLegend(lines, {
    label: 'planning options',
    hint: '"node bin/apex.js plan candidates <goal-id>" prints the comparison gate by gate',
  });
  return { ...view, kinds: kindsShown(view.lines), goalId: data.goalId ?? null, planId: data.planId ?? null };
}

// The outcome answer: what the plan's own records establish, which of the seven questions they answer,
// and what only confirmation outside APEX can settle. The verdict is a reading of records and is
// reported as one, because the step that verified is a fact about the audit log rather than proof that
// the intention holds in the world.
export function describePlanOutcome({
  data = null, reading = null, operationId = null, problems = [],
}) {
  const lines = [OUTCOME_HEADER, ''];
  if (!data) {
    const view = unreadableView(lines, problems, {
      label: 'outcome view', hint: '"node bin/apex.js plan outcome <plan-id>" reads it under its own operation', noun: 'The outcome records',
    });
    return { ...view, kinds: kindsShown(view.lines) };
  }
  const snap = data.planSnapshot ?? {};
  line(`Read and audited under operation ${shortId(operationId ?? 'unknown')}. This read recorded nothing: an assessment is written by plan.assess, which is your act.`, lines);
  line(mark(ClaimKind.FACT, `plan ${shortId(data.planId)} is v${snap.version ?? '?'} (${snap.status ?? '?'}) with content hash ${shortId(snap.contentHash ?? '')} at ${snap.updatedAt ?? 'an unrecorded time'}.`), lines);
  if (data.assessed !== true) {
    line(mark(ClaimKind.FACT, `there is no execution outcome to read back: ${data.reason ?? 'no reason given'}.`), lines);
    line(mark(ClaimKind.FACT, 'no step outcome is recorded against this plan, so no verdict is available and none is guessed.'), lines);
    if (data.learning) learningBlock(data.learning, lines, 4);
    line('', lines);
    line('To settle it: node bin/apex.js plan validate <plan-id> reads whether the plan can still run; "plan outcome" answers again once a step has an outcome on record.', lines);
    line('', lines);
    line('Nothing here is a verified outcome, because nothing was verified. That is the honest answer, and it is stated rather than padded.', lines);
    const view = boundWithLegend(lines, { label: 'outcome view', hint: '"node bin/apex.js plan list" shows the plans this configuration holds' });
    return { ...view, kinds: kindsShown(view.lines), planId: data.planId ?? null };
  }
  line(mark(ClaimKind.VERIFIED_OUTCOME, `${data.verdict}: ${data.basis}`), lines);
  line(`  the rule that gave that reading, in full: ${truncate(String(data.verdictRule ?? ''), 300)}`, lines);
  line(mark(ClaimKind.FACT, `the plan record holds ${data.progress?.completed ?? 0} of ${data.progress?.total ?? 0} step outcome(s); task ${shortId(data.taskId ?? '')} is the run they were recorded under; goal ${shortId(data.goalId ?? '')} is recorded as ${data.goalStatus} at revision ${data.goalRevision ?? '?'}.`), lines);
  for (const a of data.aspects ?? []) {
    line(mark(ClaimKind.FACT, `${a.aspect}: ${a.answered ? 'answered from the records' : 'not answered, and disclosed as unanswered'} - the question was "${a.question}"`), lines);
  }
  for (const f of data.findings ?? []) {
    const ops = (f.operations ?? []).map(shortId).join(', ');
    const recs = (f.records ?? []).map(shortId).join(', ');
    line(mark(f.operations?.length ? ClaimKind.VERIFIED_OUTCOME : ClaimKind.FACT, `${f.aspect}: ${f.statement}${ops ? ` [operation(s) ${ops}]` : ''}${recs ? ` [record(s) ${recs}]` : ''}`), lines);
  }
  for (const d of data.dropped ?? []) line(mark(ClaimKind.FACT, `${d.aspect} was dropped rather than answered: ${d.reason}`), lines);
  for (const a of (data.priorAssessments ?? []).slice(0, 4)) {
    line(mark(ClaimKind.FACT, `an assessment of this plan is already recorded: ${a.verdict} for v${a.planVersion} at ${a.at}${a.stale ? ' (stale: the plan content has since changed)' : ''}, citing ${a.findings} finding(s).`), lines);
  }
  if (reading) {
    line('', lines);
    line('Whether this can be taken up now:', lines);
    block(renderReadiness(reading), lines);
  }
  line('', lines);
  line(data.recordable
    ? `This reading can be recorded with plan.assess against ${shortId(data.planId)}; recording it changes no status, approval, or timestamp.`
    : `This reading cannot be recorded: ${data.unrecordableReason}`, lines);
  line('A step that ran and verified is a fact about the audit log. Whether the intention holds outside APEX\'s records is a different question, and this answer does not settle it.', lines);
  if (data.learning) learningBlock(data.learning, lines);
  else {
    line('', lines);
    line('No prediction is shown above: this answer reads records that exist, and none of them is an expectation about what will happen next.', lines);
  }
  const view = boundWithLegend(lines, {
    label: 'outcome view',
    hint: '"node bin/apex.js plan outcome <plan-id> --json" returns every finding and its citations',
  });
  return { ...view, kinds: kindsShown(view.lines), planId: data.planId ?? null, verdict: data.verdict ?? null };
}

// The readiness answer: the seven states in use, the one the records support, the factor behind it, and
// the factors the continuation ranking used. Each names the record it came from, so the reader can
// check the state instead of taking it on trust.
export function describeReadiness({
  reading = null, prioritization = [], problems = [], operationId = null, planRef = null,
}) {
  const lines = [READINESS_HEADER, ''];
  line(`Read and audited under operation ${shortId(operationId ?? 'unknown')}. Nothing here was run, approved, recorded, or cancelled.`, lines);
  line(`The seven states, and the record each one is read from${planRef ? ` (asked about ${shortId(planRef)})` : ''}:`, lines);
  for (const s of READINESS_STATES) line(`  ${s} - ${READINESS_BASIS[s]}`, lines);
  for (const p of (problems ?? []).slice(0, 6)) line(mark(ClaimKind.FACT, `reading the records hit a problem, so the answer is partial: ${p}`), lines);
  line('', lines);
  if (reading) block(renderReadiness(reading), lines);
  else line('No readiness reading was available: no plan, goal, or comparison could be read for it.', lines);
  const ranked = (prioritization ?? []).slice(0, 3);
  if (ranked.length > 0) {
    line('', lines);
    line('What the continuation ranking used, in this order:', lines);
    for (const [index, candidate] of ranked.entries()) {
      const pf = prioritizationFactors(candidate);
      line(`  ${index + 1}. ${candidate.kind} ${shortId(candidate.ref)} - "${words(candidate.title)}" (${candidate.status ?? 'status not recorded'})`, lines);
      line(`     ranking rule: ${pf.rule}${Number.isInteger(pf.score) ? `; score ${pf.score}` : ''}`, lines);
      for (const f of pf.factors.slice(0, BOUNDS.maxListedRecords)) line(`     ${mark(ClaimKind.FACT, `${f.factor} [read from: ${f.readFrom}]`)}`, lines);
      line(`     ${pf.note}`, lines);
      if (candidate.command) line(`     to take it up: ${candidate.command}`, lines);
    }
  } else {
    line('', lines);
    line('No open record is ranked, so no prioritization factor is claimed. Nothing is suggested, because nothing is waiting.', lines);
  }
  line('', lines);
  const view = boundWithLegend(lines, {
    label: 'readiness view',
    hint: '"node bin/apex.js work" ranks the open records and prints each one\'s readiness',
    // Batch AM added a seventh readiness state, and this view prints the record each state is read
    // from before it prints the answer. Measured on a draft plan with one ranked record the answer is
    // 45 lines and 5016 characters: under the shared 40/4000 budget the line that disclaims the score
    // ("not a probability, an importance, or a permission") is what gets cut, which is the one line
    // the reader must not lose. The inventory's own room is asked for here rather than added to every
    // other answer's budget; the view still says when it gives way.
    maxLines: 46, maxChars: 5200,
  });
  return { ...view, kinds: kindsShown(view.lines), readiness: reading?.readiness ?? null };
}
