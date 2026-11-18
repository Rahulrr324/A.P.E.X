// Rendering for the planning read. The structure is printed rather than summarized away: every task
// shows the class it was given and why, every milestone shows the steps it groups and the checkpoint
// that settles it, and every inferred statement carries the basis it entered with.
import { singleLine, truncate } from '../util.js';

const BASIS_LABEL = {
  user_stated: 'you stated',
  system_inferred: 'this read inferred',
  assumption: 'assumed',
  verified_fact: 'a record states',
  unknown: 'unknown',
};

function basisOf(item) {
  return BASIS_LABEL[item?.basis] ?? item?.basis ?? 'unknown basis';
}

function itemLine(item) {
  return `  - ${truncate(singleLine(item.text), 200)} (${basisOf(item)})`;
}

function appendList(lines, heading, items) {
  if (!items || items.length === 0) return;
  lines.push('', heading);
  for (const item of items) lines.push(itemLine(item));
}

function taskLines(planning) {
  const lines = [];
  if (planning.tasks.length === 0) return lines;
  lines.push('', `Tasks (${planning.tasks.length}):`);
  for (const task of planning.tasks) {
    lines.push(`  ${task.id} [${task.class}] ${truncate(singleLine(task.description), 180)}`);
    if (task.action) {
      const deps = task.dependsOn.length > 0 ? ` | after ${task.dependsOn.join(', ')}` : '';
      const milestone = task.milestoneId ? ` | milestone ${task.milestoneId}` : '';
      lines.push(`      action: ${task.action} (${task.permission}) | risk: ${task.risk}${milestone}${deps}`);
      if (task.expectedResult) lines.push(`      completes when: ${truncate(singleLine(task.expectedResult), 180)}`);
      if (task.verification) lines.push(`      verified by: ${truncate(singleLine(task.verification), 180)}`);
    } else if (task.nearby?.length) {
      lines.push(`      near: ${task.nearby.join(', ')} - a word match, not an accepted input`);
    }
    lines.push(`      why: ${truncate(singleLine(task.because), 220)}`);
  }
  return lines;
}

function milestoneLines(planning) {
  if (planning.milestones.length === 0) return [];
  const lines = ['', `Milestones (${planning.milestones.length}, proposed from capability families):`];
  for (const m of planning.milestones) {
    lines.push(`  ${m.id}  ${truncate(singleLine(m.title), 120)}${m.dependsOn.length ? ` | after ${m.dependsOn.join(', ')}` : ''}`);
    lines.push(`      steps: ${m.steps.join(', ')}`);
    lines.push(`      checkpoint: ${truncate(singleLine(m.checkpoint), 200)}`);
    lines.push(`      verified by: ${truncate(singleLine(m.verification), 200)}`);
  }
  return lines;
}

function intakeLines(planning) {
  const intake = planning.intake;
  const lines = ['', 'Intake (what the plan was read from):'];
  lines.push(`  objective: ${truncate(singleLine(intake.objective.text), 300)} (${basisOf(intake.objective)})`);
  lines.push(intake.goal
    ? `  goal: ${truncate(intake.goal.id, 40)} (revision ${intake.goal.revision ?? 'unrecorded'}, ${intake.goal.status ?? 'unknown'})`
    : '  goal: none referenced');
  const stated = [
    ...intake.constraints,
    ...intake.deliverables,
    ...intake.resources,
    ...intake.preferences,
    ...intake.deadlines,
    ...intake.priorities,
  ];
  const bySource = new Map();
  for (const item of stated) {
    const key = `${item.field ?? 'item'}|${item.source}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(item);
  }
  if (stated.length === 0) lines.push('  stated constraints, deliverables, resources, preferences, deadlines, priorities: none');
  for (const group of bySource.values()) {
    for (const item of group) lines.push(`  - ${truncate(singleLine(item.text), 200)} (${item.field ?? 'item'}, ${basisOf(item)})`);
  }
  if (intake.successCriteria.length > 0) {
    lines.push('  success criteria, from the goal record:');
    for (const c of intake.successCriteria) {
      lines.push(`    ${c.id ?? '?'} ${truncate(singleLine(c.description), 180)} (${basisOf(c)}, ${c.requirement ?? 'requirement unrecorded'}${c.status ? `, ${c.status}` : ''})`);
    }
  }
  appendList(lines, '  Unknowns (named rather than filled in):', intake.unknowns);
  appendList(lines, `  Assumptions and inferred statements:`, intake.assumptions);
  return lines;
}

function conflictLines(planning) {
  const lines = [];
  if (planning.conflicts.length > 0) {
    lines.push('', 'Conflicts read from the records:');
    for (const c of planning.conflicts) lines.push(`  - ${truncate(singleLine(c.text), 220)} (${basisOf(c)})`);
  }
  const ambiguity = planning.ambiguity;
  if (ambiguity?.material || (ambiguity?.interpretations?.length ?? 0) > 0) {
    lines.push('', `Competing readings (${ambiguity.material ? 'the choice changes the plan' : 'no reading changes the plan'}):`);
    lines.push(`  ${truncate(singleLine(ambiguity.because), 240)}`);
    for (const alt of ambiguity.interpretations) {
      lines.push(`  - ${alt.title}`);
      lines.push(`      ${truncate(singleLine(alt.note), 220)}`);
    }
    if (ambiguity.questions.length > 0) {
      lines.push('  What only you can settle:');
      for (const q of ambiguity.questions) {
        lines.push(`  - ${truncate(singleLine(q.question), 220)}${q.candidates?.length ? ` (near: ${q.candidates.join(', ')})` : ''}`);
      }
    }
  }
  return lines;
}

function draftLines(planning) {
  const draft = planning.draft;
  const lines = ['', `Draft${draft.recordable ? ' (recordable as written)' : ' (not recordable)'}:`];
  if (!draft.available) {
    lines.push(`  none: ${draft.reason}`);
    return lines;
  }
  const content = draft.content ?? null;
  if (content) {
    lines.push(`  intended outcome: ${truncate(singleLine(content.outcome), 300)}`);
    lines.push(`  ${content.steps.length} step(s), ${content.milestones?.length ?? 0} milestone(s), ${content.preconditions.length} precondition(s), ${content.assertions.length} assertion(s)`);
  }
  if (!draft.validation.ok) {
    for (const problem of draft.validation.problems.slice(0, 6)) lines.push(`  problem: ${truncate(singleLine(problem), 200)}`);
  }
  return lines;
}

export function renderPlanning(planning) {
  if (!planning) return 'No planning read was produced.';
  const counts = planning.counts;
  const lines = [
    `Objective planning (${planning.schema}) - nothing recorded, approved, or running`,
    `Tasks: ${counts.tasks} (${counts.completed} completed, ${counts.ready} ready, ${counts.needs_approval} need approval, ${counts.blocked} blocked, ${counts.needs_input} need input, ${counts.unsupported} unsupported); milestones: ${counts.milestones}`,
  ];
  lines.push(...intakeLines(planning));
  lines.push(...conflictLines(planning));
  lines.push(...milestoneLines(planning));
  lines.push(...taskLines(planning));
  if (planning.crossMilestoneDependencies.length > 0) {
    lines.push('', 'Dependencies that cross a milestone boundary (read from the written order):');
    for (const d of planning.crossMilestoneDependencies) {
      lines.push(`  - ${d.step} (${d.to}) depends on ${d.dependsOn} (${d.from})`);
    }
  }
  lines.push(...draftLines(planning));
  lines.push('', `Feasibility: ${planning.feasibility.statement}.`);
  lines.push(`Approval: ${planning.approval.required ? 'required and not present' : 'not required'} - ${planning.approval.path}.`);
  lines.push('How it would run, if you record and approve it:');
  for (const key of ['mode', 'activation', 'eachStep', 'failure', 'resume', 'completion']) {
    const value = planning.execution[key];
    lines.push(`  - ${key}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : truncate(singleLine(value), 240)}`);
  }
  lines.push(`Revision: ${planning.revision.statement}`);
  lines.push(`Learning: ${planning.learning.path}`);
  lines.push('', 'What this planning read does not know:');
  for (const line of planning.uncertainty) lines.push(`  - ${truncate(singleLine(line), 240)}`);
  lines.push('', 'This read records, approves, and runs nothing; every class above is the live registry\'s answer at this moment.');
  return lines.join('\n');
}
