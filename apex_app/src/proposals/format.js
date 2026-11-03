// Plain-text rendering of proposals. A proposal is always labelled as a model suggestion:
// a reader must never mistake it for something the user recorded or something that ran.
import { shortId, truncate } from '../util.js';
import { containsSecret, SECRET_OMITTED } from '../security/secrets.js';
import { ProposalStatus, proposalStatus } from './model.js';

function storedText(value) {
  const text = String(value ?? '');
  return containsSecret(text) ? SECRET_OMITTED : text;
}

function nextHint(proposal, status) {
  const id = shortId(proposal.id);
  switch (status) {
    case ProposalStatus.PENDING:
      return `To accept it: node bin/apex.js proposal accept ${id}. To reject it: node bin/apex.js proposal reject ${id} --reason "why"`;
    case ProposalStatus.STALE:
      return 'The records it names have changed. Accepting it is refused; ask for a fresh proposal.';
    case ProposalStatus.EXPIRED:
      return 'This proposal passed its recorded expiry and cannot be accepted. Ask for a fresh proposal.';
    case ProposalStatus.INVALID:
      return 'This proposal failed validation. It cannot be accepted; ask for a corrected proposal.';
    case ProposalStatus.ACCEPTED:
      return proposal.decision?.applied?.goalId || proposal.decision?.applied?.planId
        ? 'Accepted. The record it created is still a draft or proposal; it did not approve, activate, or execute anything.'
        : 'Accepted as advice only. Nothing was changed and nothing ran.';
    case ProposalStatus.REJECTED:
      return 'Rejected. The record stays readable as history; nothing was changed.';
    case ProposalStatus.INVALIDATED:
      return 'Invalidated by the user. The record stays readable as history; nothing was changed.';
    default:
      return '';
  }
}

export function renderProposal(proposal, { now = new Date(), status = null, problems = [] } = {}) {
  const state = status ?? proposalStatus(proposal, { now });
  const lines = [
    `Proposal ${shortId(proposal.id)}  kind: ${proposal.kind}  status: ${state}  risk: ${proposal.risk}`,
    `Model suggestion: ${storedText(proposal.title)}`,
    `Rationale: ${storedText(proposal.rationale)}`,
  ];
  if (proposal.goalId) lines.push(`Goal referenced: ${shortId(proposal.goalId)}${proposal.baseRevision ? ` (base revision ${proposal.baseRevision})` : ''}`);
  if (proposal.planId) lines.push(`Plan referenced: ${shortId(proposal.planId)}${proposal.baseVersion ? ` (base version ${proposal.baseVersion})` : ''}`);
  const c = proposal.changes ?? {};
  if (proposal.kind === 'goal_create' || proposal.kind === 'goal_clarify') {
    if (c.request) lines.push(`Proposed request: ${storedText(c.request)}`);
    lines.push('Proposed success criteria:');
    for (const [i, criterion] of (c.criteria ?? []).entries()) lines.push(`  c${i + 1} ${storedText(criterion)}`);
    if (c.priority !== undefined) lines.push(`Proposed priority: ${c.priority}`);
    if (c.deadline !== undefined) lines.push(`Proposed deadline: ${c.deadline ?? 'none'}`);
  } else if (proposal.kind === 'plan_create' || proposal.kind === 'plan_revise') {
    lines.push(`Proposed outcome: ${storedText(c.outcome)}`);
    lines.push('Proposed steps:');
    for (const s of c.steps ?? []) {
      lines.push(`  ${s.id} ${storedText(s.description)}`);
      lines.push(`      action: ${s.action} | risk: ${s.risk}${s.criterionId ? ` | criterion ${s.criterionId}` : ''}`);
      lines.push(`      expected: ${truncate(storedText(s.expectedResult), 160)}`);
    }
    for (const [i, p] of (c.preconditions ?? []).entries()) lines.push(`Precondition ${i + 1}: ${storedText(p)}`);
    for (const a of c.assertions ?? []) lines.push(`Assertion (${a.kind}): ${storedText(a.text)}${a.ref ? ` [${shortId(a.ref)}]` : ''}`);
  } else if (proposal.kind === 'advice') {
    lines.push(`Advice: ${storedText(c.summary)}`);
    for (const action of c.recommendedActions ?? []) lines.push(`  - ${storedText(action)}`);
  }
  if (proposal.evidence.length) {
    lines.push('Evidence referenced:');
    for (const e of proposal.evidence) lines.push(`  ${e.source} ${shortId(e.ref)}${e.note ? ` — ${storedText(e.note)}` : ''}`);
  }
  for (const [label, items] of [['Assumptions', proposal.assumptions], ['Unknowns', proposal.unknowns], ['Invalidated by', proposal.invalidation]]) {
    if (!items.length) continue;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${storedText(item)}`);
  }
  if (proposal.expiresAt) lines.push(`Expires: ${proposal.expiresAt}`);
  lines.push(proposal.validation.ok
    ? `Validation at creation: passed${proposal.validation.problems.length ? ` (${proposal.validation.problems.length} note(s))` : ''}`
    : `Validation at creation: failed (${proposal.validation.problems.length} problem(s))`);
  for (const p of proposal.validation.problems) lines.push(`  - ${storedText(p)}`);
  if (problems.length) {
    lines.push('Current state check:');
    for (const p of problems) lines.push(`  - ${storedText(p)}`);
  }
  if (proposal.decision) {
    lines.push(`Decision: ${proposal.decision.decision} at ${String(proposal.decision.at).slice(0, 19)}${proposal.decision.reason ? ` — ${storedText(proposal.decision.reason)}` : ''}`);
    if (proposal.decision.applied?.goalId) lines.push(`Applied goal: ${shortId(proposal.decision.applied.goalId)}`);
    if (proposal.decision.applied?.planId) lines.push(`Applied plan: ${shortId(proposal.decision.applied.planId)}`);
  }
  lines.push('A proposal is a suggestion, not permission. It has not approved, activated, or executed anything.');
  lines.push(`Next: ${nextHint(proposal, state)}`);
  return lines.join('\n');
}

export function renderProposalList(items, { now = new Date() } = {}) {
  if (items.length === 0) return 'No proposals recorded yet. Generate one with: node bin/apex.js propose <goal|plan|clarify|revise|advice> ...';
  return items
    .map(({ proposal, status }) => `${shortId(proposal.id)}  ${proposal.kind.padEnd(13)}  ${status.padEnd(10)}  ${proposal.risk.padEnd(6)}  ${truncate(storedText(proposal.title), 100)}`)
    .join('\n');
}
