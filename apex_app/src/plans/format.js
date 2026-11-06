// Plain-text rendering of plans, shared by the controller replies and the CLI.
import { shortId, truncate } from '../util.js';
import { containsSecret, SECRET_OMITTED } from '../security/secrets.js';
import { planContentHash, planProgress, planRisk } from './model.js';

function storedText(value) {
  const text = String(value ?? '');
  return containsSecret(text) ? SECRET_OMITTED : text;
}

function nextHint(plan) {
  const id = shortId(plan.id);
  switch (plan.status) {
    case 'draft':
      return `To validate it: node bin/apex.js plan validate ${id}. To approve: node bin/apex.js plan approve ${id}`;
    case 'approved':
      return `To start it: node bin/apex.js plan start ${id}`;
    case 'active':
      return `To inspect the task: node bin/apex.js task show ${shortId(plan.activation?.taskId ?? '')}. Reconcile recorded outcomes: node bin/apex.js plan reconcile ${id}`;
    case 'blocked':
      return `Resolve the obstacle, then reconcile: node bin/apex.js plan reconcile ${id}`;
    case 'completed':
      return 'All steps carry verified outcomes. Whether that settles the goal is a separate reading: plan.outcome answers it from the records, and plan.assess records the answer.';
    case 'failed':
      return 'Failed. A new plan revision or a new plan is needed; a failed plan does not retry itself.';
    case 'cancelled':
      return 'Cancelled. Nothing further will run for this plan.';
    case 'superseded':
      return plan.supersededBy ? `Superseded by ${shortId(plan.supersededBy)}.` : 'Superseded.';
    default:
      return '';
  }
}

const ASSERTION_LABEL = Object.freeze({
  user_fact: 'user fact',
  stored_knowledge: 'stored knowledge',
  retrieved_evidence: 'retrieved evidence',
  inference: 'inference',
  unknown: 'unknown',
});

function stepLine(s, result) {
  const state = result ? ` [${result.status}${result.operationId ? ` ${shortId(result.operationId)}` : ''}]` : ' [not run]';
  const criterion = s.criterionId ? ` | criterion ${s.criterionId}` : '';
  const estimate = Number.isInteger(s.estimate?.seconds) ? ` | ~${s.estimate.seconds}s` : '';
  const reversibility = s.reversibility ? ` | reversibility: ${s.reversibility}` : '';
  const deps = s.dependsOn.length ? ` | after ${s.dependsOn.join(', ')}` : '';
  const input = Object.keys(s.input ?? {}).length ? `\n      input: ${truncate(JSON.stringify(s.input), 160)}` : '';
  const recovery = s.recovery ? `\n      if it fails: ${singleLine(storedText(s.recovery), 200)}` : '';
  return `  ${s.id}${state} ${singleLine(storedText(s.description), 200)}\n`
    + `      action: ${s.action} | risk: ${s.risk}${reversibility}${criterion}${estimate}${deps}`
    + `\n      expected: ${singleLine(storedText(s.expectedResult), 200)}`
    + `\n      verified by: ${singleLine(storedText(s.verification), 200)}${recovery}${input}`;
}

function singleLine(text, max) {
  return String(text).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

export function renderPlan(plan) {
  const p = planProgress(plan);
  const lines = [
    `Plan ${shortId(plan.id)}  v${plan.version}  status: ${plan.status}  risk: ${planRisk(plan.steps)}`,
    `Goal: ${plan.goalId ? `${shortId(plan.goalId)}${plan.goalRevision ? ` (revision ${plan.goalRevision})` : ''}` : 'none referenced'}`,
    `Intended outcome: ${storedText(plan.outcome)}`,
    `Progress: ${p.completed} of ${p.total} step(s) completed`
      + `${p.failed ? `, ${p.failed} failed` : ''}${p.uncertain ? `, ${p.uncertain} uncertain` : ''}${p.skipped ? `, ${p.skipped} skipped` : ''}`,
    `Steps (${plan.steps.length}):`,
    ...plan.steps.map((s) => stepLine(s, plan.stepResults?.[s.id])),
  ];
  if (plan.preconditions.length) {
    lines.push('Preconditions:');
    for (const pch of plan.preconditions) lines.push(`  - ${storedText(pch)}`);
  }
  if (plan.assertions.length) {
    lines.push('What the plan treats as known (classified, not merged):');
    for (const a of plan.assertions) {
      lines.push(`  - ${ASSERTION_LABEL[a.kind] ?? a.kind}: ${storedText(a.text)}${a.ref ? ` [${shortId(a.ref)}]` : ''}`);
    }
  }
  if (Number.isInteger(plan.resources?.estimatedSeconds)) {
    lines.push(`Estimated duration: about ${plan.resources.estimatedSeconds}s across ${plan.steps.length} step(s)`);
  }
  if (plan.validation) {
    lines.push(plan.validation.ok
      ? `Validation: passed (${plan.validation.steps} step(s), ${plan.validation.writes} write, ${plan.validation.reads} read)`
      : `Validation: failed (${plan.validation.problems.length} problem(s))`);
  }
  if (plan.approval) lines.push(`Approval: version ${plan.approval.version}, content ${String(plan.approval.contentHash).slice(0, 16)}`);
  if (plan.activation) lines.push(`Activation: task ${shortId(plan.activation.taskId)} at ${String(plan.activation.at).slice(0, 19)}`);
  // Recorded separately from the status: a plan can be completed and its goal still unmet, and reading
  // one as the other is the confusion these assessments exist to keep apart.
  const assessments = plan.assessments ?? [];
  if (assessments.length) {
    const current = planContentHash(plan);
    const shown = assessments.slice(-2);
    lines.push(`Outcome assessments: ${assessments.length} recorded`);
    for (const a of shown) {
      const stale = a.planVersion !== plan.version || a.contentHash !== current;
      lines.push(`  ${a.verdict} (v${a.planVersion}${stale ? ', stale: the plan content has since changed' : ''}) at ${String(a.at).slice(0, 19)}: ${storedText(a.summary)}`);
      if (a === shown[shown.length - 1]) {
        for (const f of a.findings ?? []) lines.push(`    ${f.aspect}: ${singleLine(storedText(f.statement), 200)}`);
      }
    }
    if (assessments.length > shown.length) {
      lines.push(`  ${assessments.length - shown.length} earlier assessment(s) remain readable; plan.outcome answers each question again from the records`);
    }
  }
  if (plan.blockedReason) lines.push(`Blocked: ${storedText(plan.blockedReason)}`);
  if (plan.failureReason) lines.push(`Failed: ${storedText(plan.failureReason)}`);
  if (plan.cancelledReason) lines.push(`Cancelled: ${storedText(plan.cancelledReason)}`);
  lines.push('History:');
  for (const h of plan.history) {
    lines.push(`  v${h.version}  ${h.kind}  ${String(h.at).slice(0, 19)}${h.reason ? `  ${storedText(h.reason)}` : ''}`);
  }
  lines.push(`Next: ${nextHint(plan)}`);
  return lines.join('\n');
}

export function renderPlanList(plans) {
  if (plans.length === 0) return 'No plans yet. Record one with: node bin/apex.js plan add --goal <id> --outcome "..." --step \'<json step>\'';
  return plans
    .map((p) => {
      const progress = planProgress(p);
      return `${shortId(p.id)}  ${p.status.padEnd(9)}  v${p.version}  ${progress.completed}/${progress.total} steps  risk ${planRisk(p.steps)}  ${truncate(storedText(p.outcome), 100)}`;
    })
    .join('\n');
}
