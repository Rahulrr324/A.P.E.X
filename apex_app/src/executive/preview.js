// Bounded execution preview: what APEX says before any of it happens.
//
// This is the view the user approves. It is built from the plan as recorded - its stored steps, the
// live registry's own answers about each action, and the plan's content hash - so every line can be
// checked against a record instead of against a description someone hoped was accurate. Two rules
// shape it: nothing here may read as though work had been done, and nothing here may promise a
// check the system cannot perform.
//
// A recommendation can never make a proposal executable. The only thing that changes what is listed
// below is the user's own `plan approve`, and the hash printed here is the hash that approval binds
// to: revise the plan and the hash changes, so the earlier approval stops applying.
import { shortId, truncate } from '../util.js';
import {
  MAX_PLAN_STEPS, planContentHash, planProgress, planRisk,
} from '../plans/model.js';
import { SIDE_EFFECT_NOTE, BOUNDS, Reversibility, SideEffect } from './vocabulary.js';
import { authorizationReview } from './mapping.js';

function line(text, lines) {
  lines.push(truncate(String(text), 400));
}

// The irreversible part, stated as it actually is. APEX has no capability that deletes, overwrites,
// or reaches outside its own stores, so the honest warning is about persistence: a write stays in
// the log, and a later record can correct it but cannot erase it.
function irreversibilityNote(steps) {
  const writes = steps.filter((s) => s.sideEffect === SideEffect.APPEND);
  if (writes.length === 0) {
    return 'No step writes. Nothing here changes a stored record, and every step can be run again safely.';
  }
  return `${writes.length} step(s) append a persistent record (${writes.map((s) => s.id).join(', ')}). `
    + 'APEX stores are append-only: a later record can correct or supersede one of these, and nothing erases the original. '
    + 'APEX has no capability that deletes, overwrites, or reaches outside its own stores.';
}

function permissionSummary(review) {
  const reads = review.filter((r) => r.permission === 'read').length;
  const writes = review.filter((r) => r.permission === 'write').length;
  const denied = review.filter((r) => r.userDecision !== 'allow');
  const modelAllowed = review.filter((r) => r.modelDecision === 'allow').map((r) => r.id);
  const parts = [`${reads} read`, `${writes} write`];
  if (denied.length > 0) parts.push(`${denied.length} refused by the registry now`);
  if (modelAllowed.length > 0) parts.push(`${modelAllowed.length} readable without your approval`);
  return parts.join(', ');
}

// One line per step: what it runs, what it waits for, what it changes, and what would prove it.
function renderSteps(plan, review, lines) {
  const byId = new Map(review.map((r) => [r.id, r]));
  line('', lines);
  line(`Steps (${plan.steps.length} of at most ${MAX_PLAN_STEPS}, run one at a time in this order):`, lines);
  for (const [index, s] of plan.steps.entries()) {
    const auth = byId.get(s.id) ?? {};
    const deps = s.dependsOn.length > 0 ? s.dependsOn.join(', ') : 'nothing';
    line(`  ${index + 1}. ${s.id}  ${s.description}`, lines);
    line(`      capability: ${s.action} (${auth.permission ?? 'unknown'})  risk: ${s.risk}  depends on: ${deps}`, lines);
    line(`      expected: ${truncate(s.expectedResult, 180)}`, lines);
    line(`      verification: ${truncate(s.verification, 160)}`, lines);
    line(`      side effect: ${SIDE_EFFECT_NOTE[auth.sideEffect ?? SideEffect.NONE]}`, lines);
    if (auth.userDecision && auth.userDecision !== 'allow') {
      line(`      authorization NOW: refused (${auth.userReason})`, lines);
    }
    if (auth.hasVerifier === false) line('      no independent verifier is registered for this action', lines);
  }
}

function renderAssumptions(plan, unmapped, lines) {
  const known = plan.assertions ?? [];
  line('', lines);
  if (known.length === 0 && unmapped.length === 0) {
    line('Assumptions and unknowns: none recorded.', lines);
    return;
  }
  line('Assumptions and unknowns (as classified in the record):', lines);
  for (const a of known) {
    const ref = a.ref ? ` [${shortId(a.ref)}]` : '';
    line(`  ${a.kind}${ref}: ${truncate(a.text, 180)}`, lines);
  }
}

function renderUnmapped(plan, unmapped, lines) {
  // The parts no registered capability could take are recorded in the plan itself as `unknown`
  // assertions. A view of a stored plan has no live request to compare against, so it must read the
  // count from the record: saying "none" about a plan that carries an unknown would be a claim the
  // stored plan contradicts.
  const recorded = (plan.assertions ?? []).filter((a) => a?.kind === 'unknown').length;
  line('', lines);
  if (unmapped.length === 0) {
    if (recorded > 0) {
      line(`Steps that cannot currently be completed: ${recorded}, recorded in this plan and listed under assumptions above.`, lines);
      line('  No substitute capability is invented for them, and no part of the plan is marked done because they were left out.', lines);
      return;
    }
    line('Steps that cannot currently be completed: none. Every part of the request matched a registered action.', lines);
    return;
  }
  const shown = unmapped.slice(0, BOUNDS.maxUnmappedDisclosed);
  line(`Steps that cannot currently be completed (${unmapped.length}):`, lines);
  for (const part of shown) {
    line(`  - "${truncate(part.text, 120)}" - ${part.reason}`, lines);
  }
  if (unmapped.length > shown.length) {
    line(`  - ... and ${unmapped.length - shown.length} more, listed in the plan's assertions`, lines);
  }
  line('  These are recorded as unknowns. No substitute capability is invented for them, and no part of the plan is marked done because they were left out.', lines);
}

function renderAuthorization(review, lines) {
  const refused = review.filter((r) => r.userDecision !== 'allow');
  line('', lines);
  line(`Authorization, as the registry answers it right now: ${permissionSummary(review)}`, lines);
  for (const r of refused) {
    line(`  ${r.id}: refused for a user plan (${r.userReason}); a model origin is ${r.modelDecision} (${r.modelReason})`, lines);
  }
  line('  A model origin cannot approve or run any of this. Every write above is user-origin only, and each step is authorized again by the registry at the moment it runs.', lines);
}

function renderValidity(validation, validity, lines) {
  if (validation) {
    line('', lines);
    line(`Plan validation: ${validation.ok ? 'passed' : `NOT passed - ${validation.problems.length} problem(s)`}`, lines);
    for (const p of validation.problems.slice(0, 8)) line(`  - ${truncate(p, 200)}`, lines);
    if (validation.problems.length > 8) line(`  - ... and ${validation.problems.length - 8} more`, lines);
  }
  if (validity) {
    line('', lines);
    line(`Live validity against current state: ${validity.ok ? 'passed' : `NOT passed - ${validity.problems.length} problem(s)`}`, lines);
    for (const p of validity.problems.slice(0, 8)) line(`  - ${truncate(p, 200)}`, lines);
  }
}

function renderApprovalBinding(plan, lines) {
  const hash = planContentHash(plan);
  line('', lines);
  line(`Approval binding: plan ${shortId(plan.id)} version ${plan.version}, content hash ${hash.slice(0, 16)}...`, lines);
  line('  Your approval is recorded against this hash. Revising the plan changes the hash, so an earlier approval does not carry over, and starting a plan whose bytes changed since approval is refused.', lines);
  line('  Approving this plan authorizes nothing by itself: it only makes the steps above eligible to run when you start the plan.', lines);
  return hash;
}

function renderNext(plan, lines) {
  line('', lines);
  line('Next, in order, each a separate command you run:', lines);
  line(`  1. review again:  node bin/apex.js plan show ${shortId(plan.id)}`, lines);
  line(`  2. approve it:    node bin/apex.js plan approve ${shortId(plan.id)}`, lines);
  line(`  3. start it:      node bin/apex.js plan start ${shortId(plan.id)}   (creates one task, runs the steps, verifies each, and records every outcome)`, lines);
  line(`  or stop here:     node bin/apex.js plan cancel ${shortId(plan.id)} --reason <text>`, lines);
  line('', lines);
  line('Nothing has run. No step has been started, no record has been changed, and no approval has been given.', lines);
}

// The full preview. `plan` is the stored draft; `unmapped` carries the parts of the request no
// registered capability could take. Output is capped, and a capped view says so rather than looking
// complete.
export function buildPreview({
  plan, registry, unmapped = [], validation = null, validity = null,
}) {
  const review = authorizationReview(plan.steps, registry);
  const progress = planProgress(plan);
  const risk = planRisk(plan.steps);
  const lines = [];
  line('Execution preview of the recorded plan. This is a proposal, not an action: nothing below has run.', lines);
  line('', lines);
  line(`Intended outcome: ${truncate(plan.outcome, 300)}`, lines);
  if (plan.goalId) line(`  goal: ${shortId(plan.goalId)} at revision ${plan.goalRevision ?? 'not recorded'}`, lines);
  line(`  overall risk: ${risk}  estimated time: ${plan.resources?.estimatedSeconds ?? 'no estimate recorded'}`, lines);
  renderSteps(plan, review, lines);
  renderAssumptions(plan, unmapped, lines);
  renderUnmapped(plan, unmapped, lines);
  renderAuthorization(review, lines);
  line('', lines);
  line(`Expected side effects: ${review.filter((r) => r.sideEffect === SideEffect.APPEND).length} append(s), ${review.filter((r) => r.sideEffect === SideEffect.NONE).length} read-only step(s).`, lines);
  line(`Reversibility: ${review.some((r) => r.sideEffect === SideEffect.APPEND) ? Reversibility.APPEND : Reversibility.READ}`, lines);
  line(`  ${irreversibilityNote(review)}`, lines);
  const irreversibleSteps = review.filter((r) => r.permission === 'write');
  if (irreversibleSteps.length > 0) {
    line(`  Persistent writes to confirm or accept: ${irreversibleSteps.map((r) => `${r.id} (${r.action})`).join(', ')}`, lines);
  }
  renderValidity(validation, validity, lines);
  const contentHash = renderApprovalBinding(plan, lines);
  renderNext(plan, lines);
  if (progress.total > 0 && progress.completed > 0) {
    line('', lines);
    line(`${progress.completed} of ${progress.total} step outcome(s) already recorded; those steps will not run again.`, lines);
  }

  const truncated = lines.length > BOUNDS.maxPreviewLines;
  const shownLines = truncated ? lines.slice(0, BOUNDS.maxPreviewLines) : lines;
  let display = shownLines.join('\n');
  if (truncated || display.length > BOUNDS.maxPreviewChars) {
    display = `${truncate(display, BOUNDS.maxPreviewChars)}\n[preview cut at ${BOUNDS.maxPreviewLines} lines / ${BOUNDS.maxPreviewChars} characters; the full record is in "plan show ${shortId(plan.id)}"]`;
  }
  return {
    display,
    lines: shownLines,
    truncated,
    contentHash,
    counts: {
      steps: plan.steps.length,
      unmapped: unmapped.length,
      writes: review.filter((r) => r.permission === 'write').length,
      reads: review.filter((r) => r.permission === 'read').length,
      refused: review.filter((r) => r.userDecision !== 'allow').length,
    },
    review,
  };
}

// The short form printed in a conversation: what was recorded, and what it is waiting for. The full
// preview is printed with it, so this only has to name the state and the next command.
export function previewHeadline(plan, { state, note = null }) {
  const headline = `${state}: plan ${shortId(plan.id)} v${plan.version}, ${plan.steps.length} step(s), ${planRisk(plan.steps)} risk`;
  return note ? `${headline} - ${note}` : headline;
}
