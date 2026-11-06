// Read-only plan history comparison.
//
// A revision replaces the whole content, so a comparison is between two snapshots as written,
// not between their later recorded outcomes. Pure functions: nothing here reads a store, writes,
// approves, or activates.
import { stableStringify } from '../tasks/model.js';

function same(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function changedFields(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    if (!same(before[field], after[field])) {
      changes.push({ field, from: before[field] ?? null, to: after[field] ?? null });
    }
  }
  return changes;
}

function keyed(list, key) {
  return new Map((list ?? []).map((item, index) => [String(item?.[key] ?? index), item]));
}

const STEP_FIELDS = [
  'description', 'action', 'input', 'dependsOn', 'expectedResult',
  'verification', 'criterionId', 'risk', 'estimate', 'reversibility', 'recovery',
];

// The differences a reader needs in order to decide whether to approve the later revision:
// what the plan is for, which steps and records it names, and what it assumes. A step is
// compared as a whole, and each changed field is stated rather than hidden behind "modified".
export function comparePlanVersions(from, to) {
  const changes = [];
  if (!same(from.goalId, to.goalId)) changes.push({ field: 'goalId', from: from.goalId ?? null, to: to.goalId ?? null });
  if (!same(from.goalRevision, to.goalRevision)) changes.push({ field: 'goalRevision', from: from.goalRevision ?? null, to: to.goalRevision ?? null });
  if (!same(from.outcome, to.outcome)) changes.push({ field: 'outcome', from: from.outcome, to: to.outcome });
  if (!same(from.resources, to.resources)) changes.push({ field: 'resources', from: from.resources ?? null, to: to.resources ?? null });

  const stepsBefore = keyed(from.steps, 'id');
  const stepsAfter = keyed(to.steps, 'id');
  const added = [...stepsAfter.keys()].filter((id) => !stepsBefore.has(id));
  const removed = [...stepsBefore.keys()].filter((id) => !stepsAfter.has(id));
  const modified = [];
  for (const [id, after] of stepsAfter) {
    const before = stepsBefore.get(id);
    if (!before) continue;
    const fields = changedFields(before, after, STEP_FIELDS);
    if (fields.length > 0) modified.push({ id, fields });
  }

  const beforePre = new Map((from.preconditions ?? []).map((p) => [p, true]));
  const afterPre = new Map((to.preconditions ?? []).map((p) => [p, true]));
  const preconditionsAdded = [...afterPre.keys()].filter((p) => !beforePre.has(p));
  const preconditionsRemoved = [...beforePre.keys()].filter((p) => !afterPre.has(p));

  const assertionKey = (a) => `${a.kind}\u0000${a.text}\u0000${a.ref ?? ''}`;
  const assertionsBefore = new Map((from.assertions ?? []).map((a) => [assertionKey(a), a]));
  const assertionsAfter = new Map((to.assertions ?? []).map((a) => [assertionKey(a), a]));
  const assertionsAdded = [...assertionsAfter.keys()].filter((k) => !assertionsBefore.has(k)).map((k) => assertionsAfter.get(k));
  const assertionsRemoved = [...assertionsBefore.keys()].filter((k) => !assertionsAfter.has(k)).map((k) => assertionsBefore.get(k));

  const unchanged = changes.length === 0 && added.length === 0 && removed.length === 0
    && modified.length === 0 && preconditionsAdded.length === 0 && preconditionsRemoved.length === 0
    && assertionsAdded.length === 0 && assertionsRemoved.length === 0;

  return {
    unchanged,
    changes,
    steps: { added, removed, modified },
    preconditions: { added: preconditionsAdded, removed: preconditionsRemoved },
    assertions: { added: assertionsAdded, removed: assertionsRemoved },
  };
}

export function renderComparison({ plan, from, to, diff }) {
  const lines = [
    `Plan ${plan.id} version ${from.version} -> ${to.version}`,
    `  from: version ${from.version}, ${from.kind} at ${from.at}: ${from.reason}`,
    `  to:   version ${to.version}, ${to.kind} at ${to.at}: ${to.reason}`,
  ];
  if (diff.unchanged) {
    lines.push('The two versions have identical content. Nothing was approved or started.');
    return lines.join('\n');
  }
  for (const c of diff.changes) lines.push(`  ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  for (const id of diff.steps.added) lines.push(`  step ${id}: added`);
  for (const id of diff.steps.removed) lines.push(`  step ${id}: removed`);
  for (const m of diff.steps.modified) {
    lines.push(`  step ${m.id}: changed`);
    for (const f of m.fields) lines.push(`    ${f.field}: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
  }
  for (const p of diff.preconditions.added) lines.push(`  precondition added: ${p}`);
  for (const p of diff.preconditions.removed) lines.push(`  precondition removed: ${p}`);
  for (const a of diff.assertions.added) lines.push(`  assertion added: [${a.kind}] ${a.text}`);
  for (const a of diff.assertions.removed) lines.push(`  assertion removed: [${a.kind}] ${a.text}`);
  lines.push('This comparison is read-only. A later version is not approved by comparing it.');
  return lines.join('\n');
}
