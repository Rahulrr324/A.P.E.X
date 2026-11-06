// Plain-text rendering of goals, shared by the controller replies and the CLI.
import { shortId, singleLine, truncate } from '../util.js';
import { containsSecret, SECRET_OMITTED } from '../security/secrets.js';
import {
  GOAL_ITEM_FIELDS,
  GoalBasis,
  Requirement,
  basisOf,
  goalProgress,
  isOpenStatus,
  needsUserDecision,
  requirementOf,
} from './model.js';
import { assessmentSummary } from './assess.js';

// How many records from one operation a criterion's assessment lists. The count of what the
// operation established is always stated; only the listing is bounded.
const MAX_RECORDS_SHOWN = 3;

// A goal log written before masking existed can hold a credential in a request or a criterion.
// Printing a match is refused the way storing one is: the value is replaced, not shown.
function storedText(value) {
  const text = String(value ?? '');
  return containsSecret(text) ? SECRET_OMITTED : text;
}

function nextHint(goal) {
  const id = shortId(goal.id);
  switch (goal.status) {
    case 'proposed':
      return `To accept it: node bin/apex.js goal update ${id} accepted. To cancel: node bin/apex.js goal update ${id} cancelled --reason "why"`;
    case 'accepted':
      return `To start pursuing it: node bin/apex.js goal update ${id} active`;
    case 'active':
      return `Record evidence with: node bin/apex.js goal evidence ${id} --criterion c1 --operation <op id>. Complete it only when every required criterion is verified: node bin/apex.js goal complete ${id}`;
    case 'blocked':
      return `Resolve the obstacle, then: node bin/apex.js goal update ${id} active --reason "what changed"`;
    case 'completed':
      return 'Completed against verified evidence. Contradicting evidence can reopen it with: node bin/apex.js goal evidence --reopen';
    case 'failed':
      return 'Recorded as failed. It can be cancelled, abandoned, or superseded; it cannot be completed.';
    case 'cancelled':
      return 'Cancelled. Nothing further will be done for this goal.';
    case 'abandoned':
      return 'Abandoned. The record stays readable; nothing further will be done for it.';
    case 'superseded':
      return goal.supersededBy ? `Superseded by ${shortId(goal.supersededBy)}.` : 'Superseded.';
    default:
      return '';
  }
}

// Where a criterion came from and what it does to the goal. An inference is printed as an
// inference, and a suggestion the user has not decided is printed as needing their decision, so
// the rendering cannot make APEX's own conclusion look like the user's requirement.
function criterionLine(c) {
  const latest = c.evidence.at(-1);
  const evidence = c.evidence.length === 0
    ? 'no evidence recorded'
    : `${c.evidence.length} evidence record(s); latest ${latest.kind}${latest.operationId ? ` of ${shortId(latest.operationId)}` : ''}`;
  const basis = basisOf(c);
  const requirement = requirementOf(c);
  const parts = [];
  if (basis !== GoalBasis.USER_STATED) parts.push(`from ${basis}`);
  parts.push(requirement === Requirement.REQUIRED ? 'required' : requirement);
  if (c.confirmation?.decision) parts.push(`your decision: ${c.confirmation.decision}`);
  if (needsUserDecision(c)) parts.push('needs your decision');
  return [
    `  ${c.id} [${c.status}] ${storedText(c.description)}`,
    `      ${evidence}`,
    `      ${parts.join(', ')}`,
    c.requiredEvidence ? `      would be proved by: ${storedText(c.requiredEvidence)}` : null,
  ].filter(Boolean).join('\n');
}

function decompositionLines(goal) {
  const fields = GOAL_ITEM_FIELDS.filter((f) => (goal[f]?.length ?? 0) > 0);
  if (fields.length === 0) return [];
  const lines = ['Decomposition (as recorded, with its source):'];
  for (const field of fields) {
    lines.push(`  ${field}:`);
    for (const item of goal[field]) {
      lines.push(`    - ${storedText(item.text)} (${basisOf(item)}${item.ref ? `, from record ${singleLine(item.ref, 40)}` : ''})`);
    }
  }
  return lines;
}

export function renderGoal(goal) {
  const p = goalProgress(goal);
  const origin = goal.origin === 'user' ? 'your request' : goal.origin;
  const lines = [
    `Goal ${shortId(goal.id)}  status: ${goal.status}  origin: ${origin}  priority: ${goal.priority}  revision: ${goal.revision ?? 1}`,
    `Request: ${storedText(goal.request)}`,
    `Deadline: ${goal.deadline ?? 'none recorded'}`,
    `Progress: ${p.satisfied} of ${p.total} criterion(s) satisfied`
      + `${p.contradicted ? `, ${p.contradicted} contradicted` : ''}`
      + `${p.pending ? `, ${p.pending} pending` : ''}`
      // Stated only when the two counts differ: what gates completion is not the same as what was
      // written down, and a suggestion the user has not decided belongs to neither.
      + `${p.gating !== p.total ? `; ${p.gatingSatisfied} of ${p.gating} required for completion` : ''}`,
    'Success criteria:',
    ...goal.criteria.map(criterionLine),
    ...decompositionLines(goal),
  ];
  if (p.needsConfirmation > 0) {
    const ids = goal.criteria.filter((c) => needsUserDecision(c)).map((c) => c.id);
    lines.push(`Your decision is owed on: ${ids.join(', ')} - node bin/apex.js goal confirm ${shortId(goal.id)} <criterion> required|suggested|declined --reason "why"`);
  }
  if (p.declined > 0) {
    lines.push(`Declined by you, so not counted toward completion: ${goal.criteria.filter((c) => requirementOf(c) === Requirement.DECLINED).map((c) => c.id).join(', ')}`);
  }
  if (goal.dependsOn.length > 0) {
    lines.push(`Depends on: ${goal.dependsOn.map(shortId).join(', ')}`);
  }
  if (goal.blockedReason) lines.push(`Blocked: ${storedText(goal.blockedReason)}`);
  if (goal.contradiction) {
    lines.push(`Contradiction: criterion ${goal.contradiction.criterionId}${goal.contradiction.operationId ? ` (operation ${shortId(goal.contradiction.operationId)})` : ''}`);
  }
  if (goal.completion) {
    lines.push(`Completion evidence: ${goal.completion.criteria
      .map((c) => `${c.criterionId} -> ${c.operationId ? shortId(c.operationId) : 'none'}`)
      .join(', ')}`);
  }
  lines.push(`Plans: ${goal.planIds.length ? goal.planIds.map(shortId).join(', ') : 'none linked'}`);
  lines.push(`Tasks: ${goal.taskIds.length ? goal.taskIds.map(shortId).join(', ') : 'none linked'}`);
  if ((goal.entityIds?.length ?? 0) > 0) {
    lines.push(`World entities: ${goal.entityIds.map(shortId).join(', ')}`);
  }
  if ((goal.worldEventIds?.length ?? 0) > 0) {
    lines.push(`World events: ${goal.worldEventIds.map(shortId).join(', ')}`);
  }
  lines.push('History:');
  for (const h of goal.statusHistory) {
    lines.push(`  ${h.from ?? '(recorded)'} -> ${h.to}  ${String(h.at).slice(0, 19)}${h.reason ? `  ${storedText(h.reason)}` : ''}`);
  }
  if ((goal.revisionHistory?.length ?? 0) > 1) {
    lines.push('Revisions:');
    for (const r of goal.revisionHistory) {
      lines.push(`  r${r.revision}  ${String(r.at).slice(0, 19)}  ${storedText(r.reason)}`);
    }
  }
  lines.push(`Next: ${nextHint(goal)}`);
  return lines.join('\n');
}

// What the evidence behind a goal looks like now, as opposed to what the goal log says was
// recorded. `renderGoal` prints the record; this prints the result of re-opening the audit and
// knowledge records that record cites, and it names what only the user can settle without
// pretending an answer of its own.
const VERDICT_TEXT = {
  current: 'the proof still stands',
  stale: 'withdrawn after it was recorded',
  invalid: 'not supported by the audit log',
  unverifiable: 'could not be checked',
  none: 'awaiting evidence',
  contradicted: 'contradicted by later evidence',
};

export function renderAssessment(goal, assessment) {
  const lines = [
    `Goal ${shortId(goal.id)} (${goal.status}) - evidence assessment`,
    assessmentSummary(assessment),
  ];
  for (const c of assessment.criteria) {
    lines.push(`  ${c.id} [${c.status}] ${storedText(c.description)}`);
    lines.push(`      ${VERDICT_TEXT[c.verdict] ?? c.verdict}: ${storedText(c.reason)}`);
    const latest = [...c.evidence].reverse().find((e) => e.kind === 'supports');
    const written = latest?.records ?? [];
    // A retired record is the finding, so it is shown first; the rest follow in the order stored.
    const ordered = [...written.filter((r) => !r.active), ...written.filter((r) => r.active)];
    for (const r of ordered.slice(0, MAX_RECORDS_SHOWN)) {
      lines.push(`        ${r.active ? 'established' : 'NO LONGER HOLDS'} ${r.shortId}: ${storedText(r.triple)} (${r.state}${r.note ? ` - ${storedText(r.note)}` : ''})`);
    }
    if (ordered.length > MAX_RECORDS_SHOWN) {
      lines.push(`        and ${ordered.length - MAX_RECORDS_SHOWN} further record(s) from that operation`);
    }
  }
  if (assessment.records.length > 0) {
    lines.push('Records the goal names:');
    for (const r of assessment.records) {
      const where = r.found && r.active ? 'still current' : r.found ? 'NO LONGER HOLDS' : 'not readable back';
      lines.push(`  ${r.from} -> ${singleLine(r.ref, 40)}: ${where} (${r.state}${r.detail ? ` - ${storedText(r.detail)}` : ''})`);
    }
  }
  if (assessment.plans.length > 0) {
    lines.push('Plans linked to this goal:');
    for (const p of assessment.plans) {
      lines.push(`  ${shortId(p.id)} ${p.found ? p.status : `cannot be read${p.detail ? `: ${singleLine(p.detail, 80)}` : ''}`}`);
    }
  } else {
    lines.push('Plans: none linked, so nothing has been proposed for this goal yet.');
  }
  if (assessment.questions.length > 0) {
    lines.push('Only you can settle these (APEX records your decision, never its own):');
    assessment.questions.forEach((q, i) => lines.push(`  ${i + 1}. ${storedText(q)}`));
    if (assessment.questionsTruncated) {
      lines.push(`  (${assessment.questionsHeldBack} further question(s) of the same kind are not printed)`);
    }
  }
  if (assessment.uncheckable.length > 0) {
    lines.push('What APEX could not check:');
    for (const u of assessment.uncheckable) lines.push(`  - ${storedText(u)}`);
  }
  lines.push(assessment.ok
    ? 'Nothing the goal claims about its own evidence is contradicted, withdrawn, or unsupported by the audit log. This read wrote nothing and ran nothing.'
    : 'These findings change no record. Nothing was written, linked, completed, or run by this read.');
  return lines.join('\n');
}

export function renderGoalList(goals) {
  if (goals.length === 0) return 'No goals yet. Record one with: node bin/apex.js goal add "<request>" --criterion "<success criterion>"';
  return goals
    .map((g) => {
      const p = goalProgress(g);
      const open = isOpenStatus(g.status) ? '' : '  (closed)';
      return `${shortId(g.id)}  ${g.status.padEnd(9)}  r${g.revision ?? 1}  ${p.satisfied}/${p.total} criteria  p${g.priority}  ${truncate(storedText(g.request), 120)}${open}`;
    })
    .join('\n');
}

// A goal reference shown on an audit line never repeats the request: the audit stores what
// happened, not a copy of the user's stored intention.
export function goalRef(goal) {
  return `${shortId(goal.id)} (${singleLine(goal.status, 20)})`;
}
