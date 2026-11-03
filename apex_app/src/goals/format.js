// Plain-text rendering of goals, shared by the controller replies and the CLI.
import { shortId, singleLine, truncate } from '../util.js';
import { containsSecret, SECRET_OMITTED } from '../security/secrets.js';
import { goalProgress, isOpenStatus } from './model.js';

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
      return `Record evidence with: node bin/apex.js goal evidence ${id} --criterion c1 --operation <op id>. Complete it only when every criterion is verified: node bin/apex.js goal complete ${id}`;
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

function criterionLine(c) {
  const latest = c.evidence.at(-1);
  const evidence = c.evidence.length === 0
    ? 'no evidence recorded'
    : `${c.evidence.length} evidence record(s); latest ${latest.kind}${latest.operationId ? ` of ${shortId(latest.operationId)}` : ''}`;
  return `  ${c.id} [${c.status}] ${storedText(c.description)}\n      ${evidence}`;
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
      + `${p.pending ? `, ${p.pending} pending` : ''}`,
    'Success criteria:',
    ...goal.criteria.map(criterionLine),
  ];
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
