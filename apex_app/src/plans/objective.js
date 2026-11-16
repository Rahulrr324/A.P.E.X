// Objective outline: a free-form objective read against the live registry, with nothing recorded.
//
// The executive bridge already maps a preparation request onto registered capabilities and records a
// draft. This module answers a different question, and answers it as a read: *what would the plan for
// this objective be, where does the request outrun what APEX can do, and what would have to be true
// for it to run?* The output is typed parts in the order the user wrote them, the step each mapped
// part becomes, the parts no capability can take, the alternatives that can be derived from the same
// mapping without inventing approval, and the risks, uncertainty, revalidation, and recovery facts
// the existing plan and task machinery state.
//
// It owns no store, registers no action, and grants no permission. Every step is the one
// `synthesizePlan` already produces under the same plan content rules; every authorization line is
// what `authorizationReview` asks the registry right now; every revalidation and recovery statement is
// a behaviour of `plan.add`, `plan.approve`, `plan start`, and the TaskRunner, not a promise made here.
// A draft in this answer is a proposal that still needs `plan add` and the user's own approval.
import { createHash } from 'node:crypto';
import { singleLine, truncate } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { stableStringify } from '../tasks/model.js';
import {
  MAX_EXPECTED_CHARS, MAX_PLAN_OUTCOME_CHARS, MAX_VERIFICATION_CHARS,
  RISK_ORDER, validatePlanContent,
} from './model.js';
import { authorizationReview, mapWorkText, stepExpectation, synthesizePlan } from '../executive/mapping.js';
import { Reversibility, SideEffect, SIDE_EFFECT_NOTE } from '../executive/vocabulary.js';

export const OBJECTIVE_SCHEMA = 'apex.objective-plan.v1';
export const MAX_OBJECTIVE_CHARS = 500;
// How many nearby capabilities one missing part may name, how many risk rows and uncertainty lines are
// printed, and how many alternatives are derived. The store's own bounds on steps and assertions are
// reused rather than repeated here.
export const MAX_NEARBY_CAPABILITIES = 3;
export const MAX_RISK_ROWS = 12;
export const MAX_UNCERTAINTY_ROWS = 10;
export const MAX_ALTERNATIVES = 3;

export const AUTHORITY_NOTE = 'everything here is a proposal read from the live registry: nothing was recorded, '
  + 'approved, or started, and no line authorizes a step. `plan add` records a draft, `plan approve` is the '
  + "user's own decision, and the TaskRunner asks the registry again before each step runs.";

// Words that carry no capability meaning. They are matched against action names and descriptions to
// answer "what exists that sounds related", so leaving them in would make every part neighbour
// everything.
const NEARBY_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'another', 'any', 'are', 'before', 'being', 'both', 'can',
  'could', 'does', 'each', 'from', 'have', 'into', 'itself', 'just', 'like', 'make', 'many', 'more',
  'most', 'much', 'must', 'need', 'only', 'other', 'over', 'please', 'same', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this',
  'those', 'through', 'under', 'until', 'very', 'want', 'what', 'when', 'where', 'which', 'while',
  'will', 'with', 'would', 'your', 'yours', 'mine', 'our', 'ours', 'for', 'not', 'now', 'using', 'use',
]);

function contentWords(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !NEARBY_STOPWORDS.has(w)))];
}

function inputLength(value) {
  return String(value ?? '').length;
}

// The input a reader may see. Memory text, note bodies, and file contents are the payload a write
// carries, and a read that is meant to describe the shape of a plan does not need to reproduce them;
// a value that looks like a credential is never reproduced at all.
const PAYLOAD_FIELDS = ['content', 'body'];
function publicInput(action, input) {
  const value = input ?? {};
  if (containsSecret(JSON.stringify(value))) {
    return { omitted: 'the input contains a value that looks like a password, key, or token, so it is not reproduced here' };
  }
  const copy = { ...value };
  for (const field of PAYLOAD_FIELDS) {
    if (typeof copy[field] === 'string') copy[field] = `<omitted: ${copy[field].length} chars>`;
  }
  return copy;
}

// What the records already say the registry would do with this step, read live. `plannable` is the
// registry's statement that the action may never be a plan step, and `origin` decisions are the ones
// the runner will ask for again.
function authorizationOf(registry, action) {
  const def = registry.get(action);
  const user = registry.authorize(action, 'user');
  const model = registry.authorize(action, 'model');
  return {
    registered: Boolean(def),
    plannable: def ? def.plannable !== false : false,
    hasVerifier: typeof def?.verify === 'function',
    userDecision: user.decision,
    userReason: user.reason,
    modelDecision: model.decision,
    modelReason: model.reason,
  };
}

// How a failure of this step is taken up. Both statements are the runner's recorded stop rules: a
// failed or uncertain step stops the task; nothing is retried automatically; a read may be retried on
// the user's instruction, and a write that may have landed needs inspection and a revision.
function recoveryOf(permission, action) {
  if (permission === 'read') {
    return `if ${action} fails or its outcome is uncertain, the task stops there; once inspected, this read-only step may be retried, and later steps stay unrun`;
  }
  return `if ${action} fails after starting, the task stops and nothing is retried automatically; inspect the record it may have written, then revise the plan rather than replay it`;
}

// The parts of the objective in the order written, each with the step it becomes or the reason it
// cannot be one. Ids are assigned here, to mapped steps only, and are stable across every re-read.
function typedParts(mapping, registry) {
  const rows = [];
  let stepNumber = 0;
  for (const part of mapping.parts) {
    if (part.status === 'mapped' || part.status === 'split') {
      for (const step of part.steps) {
        stepNumber += 1;
        const id = `s${stepNumber}`;
        const def = registry.get(step.action);
        const expectation = def ? stepExpectation(def) : null;
        const auth = authorizationOf(registry, step.action);
        rows.push({
          id,
          part: part.index,
          text: step.description,
          description: step.description,
          action: step.action,
          capability: step.capability,
          permission: step.permission,
          plannable: auth.plannable,
          input: publicInput(step.action, step.input),
          dependsOn: stepNumber === 1 ? [] : [`s${stepNumber - 1}`],
          dependencyBasis: stepNumber === 1 ? null : 'written order',
          expectedResult: expectation ? singleLine(expectation.expectedResult, MAX_EXPECTED_CHARS) : null,
          verification: expectation ? singleLine(expectation.verification, MAX_VERIFICATION_CHARS) : null,
          risk: expectation?.risk ?? 'unknown',
          sideEffect: step.permission === 'write' ? SideEffect.APPEND : SideEffect.NONE,
          reversibility: step.permission === 'write' ? Reversibility.APPEND : Reversibility.READ,
          recovery: recoveryOf(step.permission, step.action),
          authorization: auth,
          splitFromCoordination: part.status === 'split',
        });
      }
      continue;
    }
    rows.push({
      id: null,
      part: part.index,
      text: truncate(singleLine(part.text, 200), 200),
      description: null,
      action: null,
      capability: null,
      permission: null,
      plannable: false,
      input: null,
      dependsOn: [],
      dependencyBasis: null,
      expectedResult: null,
      verification: null,
      risk: null,
      sideEffect: null,
      reversibility: null,
      recovery: null,
      authorization: null,
      status: part.status,
      reason: part.reason,
      splitFromCoordination: false,
    });
  }
  return rows;
}

// Registered actions that share content words with a part no action took. This is a lookup, not a
// recommendation: the basis says exactly what matched and that the action was never asked to accept
// this input.
function nearbyCapabilities(registry, text, excluded) {
  const terms = contentWords(text);
  if (terms.length === 0) return [];
  const scored = [];
  for (const def of registry.list()) {
    if (excluded.has(def.name)) continue;
    const haystack = `${def.name.replace(/[._]/g, ' ')} ${def.description}`.toLowerCase();
    const shared = terms.filter((term) => haystack.includes(term));
    if (shared.length === 0) continue;
    scored.push({
      action: def.name,
      permission: def.permission,
      shared,
      basis: `shares ${shared.map((w) => `"${w}"`).join(', ')} with its name or description; this read did not check that it accepts this input`,
    });
  }
  scored.sort((a, b) => (b.shared.length - a.shared.length) || a.action.localeCompare(b.action));
  return scored.slice(0, MAX_NEARBY_CAPABILITIES);
}

function missingCapabilitiesOf(mapping, rows, registry, cannotUse) {
  const used = new Set(rows.filter((r) => r.action).map((r) => r.action));
  for (const name of cannotUse) used.add(name);
  return mapping.unmapped.map((part) => ({
    text: truncate(singleLine(part.text, 160), 160),
    reason: part.reason,
    nearby: nearbyCapabilities(registry, part.text, used),
  }));
}

// The step key the plan store uses to call two parts the same step: the action plus its validated
// input. A duplicate is not a second step, so it is not counted as one in an alternative.
function stepKey(step) {
  return `${step.action}\u0000${JSON.stringify(step.input ?? {})}`;
}

// The texts of the mapped steps that survive an exclusion, unique by step key, in written order.
// Re-synthesizing from these texts runs the router and the plan checker again, so an alternative is
// produced under exactly the same rules as the primary draft rather than assembled by hand.
function textsFor(mapping, { excludeActions = new Set(), unique = false, reasonOf = (a) => `you asked this read not to offer ${a}` } = {}) {
  const texts = [];
  const excluded = [];
  const seen = new Set();
  for (const part of mapping.parts) {
    for (const step of part.steps ?? []) {
      // A coordinated part was split into steps that each carry their own text; re-synthesizing from
      // the segment text would route the whole coordination again and undo the exclusion.
      const stepText = step.text ?? part.text;
      if (excludeActions.has(step.action)) {
        excluded.push({ text: truncate(singleLine(stepText, 120), 120), reason: reasonOf(step.action) });
        continue;
      }
      const key = stepKey(step);
      if (unique && seen.has(key)) {
        excluded.push({ text: truncate(singleLine(stepText, 120), 120), reason: `repeats ${step.action} with the same input, so one plan would run it twice` });
        continue;
      }
      seen.add(key);
      texts.push(stepText);
    }
    if (part.status === 'unmapped' || part.status === 'unavailable') {
      excluded.push({ text: truncate(singleLine(part.text, 120), 120), reason: part.reason });
    }
  }
  return { texts: [...new Set(texts)], excluded };
}

function variantOf({ texts, registry, goalId, now, kind, title, excluded, note }) {
  if (texts.length === 0) return null;
  const outcome = singleLine(
    `${texts.join('; ')}${excluded.length > 0 ? ` (excluding ${excluded.length} part(s) this plan does not cover)` : ''}`,
    MAX_PLAN_OUTCOME_CHARS,
  );
  const synth = synthesizePlan({ request: outcome, workText: texts.join('; '), registry, goalId, now });
  if (!synth.ok) {
    return { kind, title, recordable: false, excluded, content: null, validation: { ok: false, problems: synth.problems }, note };
  }
  const validation = validatePlanContent(synth.content);
  return {
    kind,
    title,
    recordable: validation.length === 0,
    excluded,
    content: validation.length === 0 ? synth.content : null,
    validation: { ok: validation.length === 0, problems: validation },
    note,
  };
}

// Which steps the plan checker refused, read from why it refused. The checker names the step, and the
// mapping names the action, so both are read rather than guessed from a message that may not mention
// the capability at all - a private memory write, for one, is refused without naming memory.add.
function refusedActions(problems, mapping) {
  const found = new Set();
  for (const problem of problems) {
    const text = String(problem);
    for (const m of text.matchAll(/\bstep (s\d+)\b/g)) {
      const step = mapping.mapped[Number(m[1].slice(1)) - 1];
      if (step) found.add(step.action);
    }
    const named = /\baction ([a-z][a-z0-9]*(?:[._][a-z0-9]+)+)\b/.exec(text);
    if (named) found.add(named[1]);
  }
  return found;
}

function alternativeSignature(alternative) {
  if (!alternative?.content) return null;
  return stableStringify({
    outcome: alternative.content.outcome,
    steps: alternative.content.steps.map((s) => ({ action: s.action, input: s.input ?? {} })),
    assertions: alternative.content.assertions ?? [],
  });
}

// The alternatives this mapping can actually support. Each is re-synthesized and re-validated, so an
// alternative that would be refused at `plan add` is not shown as if it were recordable; no candidate
// capability, step, or ordering is added that the request did not contain.
function alternativesOf({ mapping, draftContent, synth, registry, goalId, now, cannotUse }) {
  const alternatives = [];
  const push = (alt) => {
    if (!alt) return;
    if (alternatives.length >= MAX_ALTERNATIVES) return;
    const signature = alternativeSignature(alt);
    if (signature && alternatives.some((a) => alternativeSignature(a) === signature)) return;
    alternatives.push(alt);
  };

  const cannotSet = new Set(cannotUse);
  const exclusion = textsFor(mapping, { excludeActions: cannotSet });
  const hasExcluded = exclusion.excluded.length > 0;
  // A plan over the supported, permitted steps only, with everything it does not cover named outside
  // it. This is the honest alternative to recording the user's unmatched words as unknowns inside a
  // plan: the same supported steps, and a shorter, unconditional set of assertions.
  if (hasExcluded && draftContent) {
    push(variantOf({
      texts: exclusion.texts,
      registry,
      goalId,
      now,
      kind: 'narrowed',
      title: 'Only the parts a registered, permitted capability can carry',
      excluded: exclusion.excluded,
      note: 'the same supported steps as the draft above, with the parts no plan step can take left out of the plan and listed here instead of being recorded inside it as unknowns',
    }));
  }

  if (synth.reason === 'duplicates') {
    const unique = textsFor(mapping, { excludeActions: cannotSet, unique: true });
    push(variantOf({
      texts: unique.texts,
      registry,
      goalId,
      now,
      kind: 'deduplicated',
      title: 'Run each repeated step once',
      excluded: unique.excluded,
      note: 'the plan store refuses a plan that would run the same action with the same input twice; this variant keeps the first occurrence and names the repeats it leaves out',
    }));
  }

  if (synth.reason === 'policy-refused') {
    const refused = refusedActions(synth.problems, mapping);
    if (refused.size > 0 && refused.size < new Set(mapping.mapped.map((m) => m.action)).size) {
      const without = textsFor(mapping, {
        excludeActions: new Set([...cannotSet, ...refused]),
        reasonOf: (a) => (cannotSet.has(a) ? `you asked this read not to offer ${a}` : `the plan checker refuses ${a} as a plan step`),
      });
      push(variantOf({
        texts: without.texts,
        registry,
        goalId,
        now,
        kind: 'policy-relieved',
        title: 'Only the steps the plan checker accepts',
        excluded: without.excluded,
        note: `the plan checker refused ${[...refused].sort().join(', ')}; this variant drops those steps and names them, rather than claiming a plan the registry would refuse`,
      }));
    }
  }
  return alternatives;
}

function riskRowsOf(rows, cannotUse) {
  const rowsOut = [];
  const cannotSet = new Set(cannotUse);
  for (const row of rows) {
    if (!row.action) continue;
    if (cannotSet.has(row.action)) {
      rowsOut.push({ step: row.id, class: 'excluded-by-request', statement: `you asked this read not to offer ${row.action}; it is not part of a plan you would record` });
    }
    if (row.plannable === false) {
      rowsOut.push({ step: row.id, class: 'not-plannable', statement: `the registry marks ${row.action} as an action that may never appear as a plan step (${row.authorization?.userReason ?? 'no reason recorded'})` });
    }
    if (row.action === 'memory.add' && row.input?.sensitivity === 'private') {
      rowsOut.push({ step: row.id, class: 'private-content', statement: 'a private memory write cannot be part of a plan; the plan checker refuses it, so it must be remembered on its own' });
    }
    if (row.permission === 'write') {
      rowsOut.push({ step: row.id, class: 'persistent-append', statement: `${row.action} appends a record. ${SIDE_EFFECT_NOTE[SideEffect.APPEND]}` });
    }
    if (row.authorization && row.authorization.hasVerifier === false) {
      rowsOut.push({ step: row.id, class: 'no-verifier', statement: `${row.action} registers no verify(); a step without an independent re-read could not be reported as verified` });
    }
  }
  return rowsOut.slice(0, MAX_RISK_ROWS);
}

function uncertaintyOf({ mapping, rows, synth, draft, withheld, goal, missing }) {
  const lines = [];
  if (rows.filter((r) => r.action).length > 1) {
    lines.push('the steps are ordered as you wrote them: no data dependency was inferred between them, and the task runner has no parallel path, so they run one at a time in this order');
  }
  if (rows.some((r) => r.splitFromCoordination)) {
    lines.push('a coordinated part ("x and y") was split into separate steps only because every half routes to a registered action on its own; a part the router already matched was never split');
  }
  if (missing.length > 0) {
    const unavailable = rows.filter((r) => r.status === 'unavailable').length;
    lines.push(`${missing.length} part(s) of this objective no registered capability can take (${unavailable} name an action this configuration does not hold, ${mapping.unmapped.length - unavailable} match no registered action); they are named above and are not steps`);
  }
  if (withheld) {
    lines.push(`the full draft is not shown: ${withheld}`);
  } else if (!draft && synth.reason) {
    lines.push(`the draft was not produced (${synth.reason === 'nothing-mapped' ? 'no part of this objective maps to a registered action' : synth.reason === 'duplicates' ? 'the request would run the same step twice' : 'the plan checker refused it'}); the reasons are printed above rather than a plan being fabricated`);
  }
  if (goal) {
    lines.push(`a plan recorded against this goal would bind revision ${goal.revision}; a later goal revision makes that binding stale, and approval is bound to the plan content hash rather than to this outline`);
  }
  lines.push('no effort estimate is given: the audit log holds no per-action duration this read could average, so a number here would be a guess');
  lines.push('permissions, action names, and the list of registered capabilities were read from the live build; they are asked again when a plan is validated, approved, and before each step runs');
  lines.push('APEX did not infer an action, a parameter, or an intent beyond the words the router matched; an unmatched part stays unmatched here');
  return lines.slice(0, MAX_UNCERTAINTY_ROWS);
}

function revalidationOf() {
  return {
    onRecord: 'plan.add validates the content against the live registry before storing it, and refuses a step whose action is unknown, unplannable, or unauthorized',
    onApproval: 'plan.approve checks the version it approves and binds the stored content hash; a revised plan cannot inherit an earlier approval',
    onActivation: 'plan start re-checks the approved status, the version, the content hash, and the one-live-plan-per-goal bound',
    onEachStep: "the TaskRunner executes every step through the controller's own action path, which asks the registry for authorization again; a changed registry, a refused action, or a failed step stops the task",
    statement: 'these are behaviours of the existing plan store, approval path, and task runner, not promises made by this read. This outline is not a record and authorizes nothing.',
  };
}

function draftOf(synth) {
  if (!synth.ok || !synth.content) return null;
  const problems = validatePlanContent(synth.content);
  return {
    recordable: problems.length === 0,
    content: problems.length === 0 ? synth.content : null,
    validation: { ok: problems.length === 0, problems },
    note: 'recording this content is `plan add`; nothing is recorded by this read, and approval remains a separate act of the user\'s own',
  };
}

// The outline itself. Pure: the same objective, registry, goal record, and exclusions always produce
// the same bytes, which is what lets the action's verifier re-read the answer instead of trusting it.
export function outlineObjective({ objective, registry, goal = null, cannotUse = [], now = null } = {}) {
  const text = String(objective ?? '').trim();
  if (text.length === 0 || text.length > MAX_OBJECTIVE_CHARS) {
    throw new TypeError(`an objective must be 1 to ${MAX_OBJECTIVE_CHARS} characters`);
  }
  if (containsSecret(text)) {
    throw new TypeError('the objective contains a value that looks like a password, key, or token; it was not planned against');
  }
  if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
    throw new TypeError('outlineObjective requires the live action registry');
  }
  const cannot = [...new Set((cannotUse ?? []).map((n) => String(n).trim()).filter(Boolean))].sort();
  const mapping = mapWorkText(text, registry);
  const rows = typedParts(mapping, registry);
  const goalId = goal?.id ?? null;
  const synth = synthesizePlan({ request: text, workText: text, registry, goalId, now });
  const draft = draftOf(synth);
  // A draft that contains a capability the user asked this read not to offer is not the answer to the
  // request; the exclusions win, and the alternative that omits them is derived below.
  const excludedHits = rows.filter((r) => r.action && cannot.includes(r.action));
  const primary = excludedHits.length === 0 ? draft : null;
  const draftWithheld = excludedHits.length > 0
    ? `the request asked this read not to offer ${[...new Set(excludedHits.map((r) => r.action))].sort().join(', ')}`
    : null;
  const alternatives = alternativesOf({
    mapping, draftContent: draft?.content ?? null, synth, registry, goalId, now, cannotUse: cannot,
  });
  const missing = missingCapabilitiesOf(mapping, rows, registry, cannot);
  const steps = rows.filter((r) => r.action);
  const risk = steps.reduce((worst, s) => ((RISK_ORDER[s.risk] ?? 0) > (RISK_ORDER[worst] ?? 0) ? s.risk : worst), 'low');
  const outline = {
    schema: OBJECTIVE_SCHEMA,
    objective: text,
    goal: goal ? { id: goal.id, revision: goal.revision ?? null, status: goal.status ?? null } : null,
    counts: {
      parts: mapping.parts.length,
      steps: steps.length,
      writes: steps.filter((s) => s.permission === 'write').length,
      reads: steps.filter((s) => s.permission === 'read').length,
      missing: missing.length,
      excludedByRequest: excludedHits.length,
    },
    risk,
    parts: rows,
    draft: primary,
    draftWithheld: excludedHits.length > 0 ? `the request asked this read not to offer ${[...new Set(excludedHits.map((r) => r.action))].sort().join(', ')}, so the full draft is withheld` : null,
    alternatives,
    missingCapabilities: missing,
    risks: riskRowsOf(rows, cannot),
    uncertainty: uncertaintyOf({ mapping, rows, synth, draft: primary, withheld: draftWithheld, goal, missing }),
    revalidation: revalidationOf(),
    recovery: {
      onStepFailure: 'a failed or uncertain step stops the task; steps that depend on it are recorded as skipped and are not run',
      onInterruption: 'a step recorded as running whose operation record is missing stays uncertain; it is never replayed automatically, because its side effect may have happened',
      onRetry: 'a read-only step that failed may be retried on your instruction; a write that may have landed needs its record inspected and a new revision',
      revision: 'a revised plan is a draft again with a new content hash, so it needs its own approval before it can run',
    },
    estimation: { available: false, reason: 'no per-action duration is recorded in the audit log, so this read does not estimate how long the plan would take' },
    excludes: cannot,
    authorizes: false,
    recorded: false,
    approved: false,
    executable: false,
    note: AUTHORITY_NOTE,
  };
  // A plan may record at most a fixed number of assertions; the draft already respects that bound, and
  // the outline's own rows are bounded by the plan step bound the mapping enforces.
  outline.digest = outlineDigest(outline);
  return outline;
}

// The bytes an independent re-read is compared against. Everything that could change between two reads
// is included: the objective, the goal revision and status, every part and step, the draft content,
// the alternatives, the missing capabilities, and the live authorization lines.
export function outlineDigest(outline) {
  return createHash('sha256').update(stableStringify({
    schema: outline.schema,
    objective: outline.objective,
    goal: outline.goal,
    counts: outline.counts,
    risk: outline.risk,
    parts: outline.parts,
    draft: outline.draft,
    draftWithheld: outline.draftWithheld,
    alternatives: outline.alternatives,
    missingCapabilities: outline.missingCapabilities,
    risks: outline.risks,
    uncertainty: outline.uncertainty,
    revalidation: outline.revalidation,
    recovery: outline.recovery,
    estimation: outline.estimation,
    excludes: outline.excludes,
    authorizes: outline.authorizes,
    recorded: outline.recorded,
    approved: outline.approved,
    executable: outline.executable,
  })).digest('hex');
}

// The plan the outline's draft would become, as `plan add` would receive it. Present only when the
// draft is recordable; the caller still has to record and approve it in separate acts.
export function outlineContent(outline) {
  return outline?.draft?.content ?? null;
}

// A bounded plain-text rendering for the CLI and the conversational surface. The structure above is
// printed, never summarized away: a part that could not be mapped is shown beside the reason, and a
// missing capability is shown with the basis of any nearby match.
export function renderOutline(outline) {
  if (!outline) return 'No outline was produced.';
  const lines = [
    `Objective plan outline (${outline.schema}) - nothing recorded, approved, or running`,
    `Objective: ${truncate(singleLine(outline.objective, MAX_OBJECTIVE_CHARS), 300)}`,
    `Goal: ${outline.goal ? `${truncate(outline.goal.id, 40)} (revision ${outline.goal.revision ?? 'unrecorded'}, ${outline.goal.status ?? 'unknown'})` : 'none referenced'}`,
    `Parts: ${outline.counts.parts}; ${outline.counts.steps} map to a registered capability (${outline.counts.reads} read, ${outline.counts.writes} write); ${outline.counts.missing} cannot be taken; overall step risk: ${outline.risk}`,
  ];
  lines.push('', 'Each part, in the order you wrote it:');
  for (const row of outline.parts) {
    if (row.action) {
      const deps = row.dependsOn.length > 0 ? ` | after ${row.dependsOn.join(', ')}` : '';
      lines.push(`  ${row.id}  ${truncate(row.description, MAX_EXPECTED_CHARS)}`);
      lines.push(`      capability: ${row.action} (${row.permission})${row.plannable ? '' : ' - NOT PLANNABLE'} | risk: ${row.risk}${deps}`);
      if (row.expectedResult) lines.push(`      expected: ${truncate(row.expectedResult, 160)}`);
      if (row.authorization?.userDecision && row.authorization.userDecision !== 'allow') {
        lines.push(`      authorization NOW: refused (${row.authorization.userReason})`);
      }
    } else {
      lines.push(`  --   "${row.text}"`);
      lines.push(`      not a step: ${row.reason}`);
    }
  }
  if (outline.draft) {
    lines.push('', `Draft (recordable as written: ${outline.draft.recordable ? 'yes' : 'no'}):`);
    lines.push(`  intended outcome: ${truncate(outline.draft.content.outcome, MAX_PLAN_OUTCOME_CHARS)}`);
    if (outline.draft.content.preconditions.length > 0) {
      for (const p of outline.draft.content.preconditions) lines.push(`  precondition: ${truncate(p, 200)}`);
    }
    for (const a of outline.draft.content.assertions ?? []) {
      lines.push(`  ${a.kind}: ${truncate(a.text, MAX_EXPECTED_CHARS)}`);
    }
    if (!outline.draft.validation.ok) {
      for (const p of outline.draft.validation.problems.slice(0, 6)) lines.push(`  problem: ${truncate(p, 200)}`);
    }
  } else {
    lines.push('', `Draft: none${outline.draftWithheld ? ` (${outline.draftWithheld})` : ' - the reasons are stated below'}`);
  }
  if (outline.alternatives.length > 0) {
    lines.push('', 'Alternatives derived from the same mapping:');
    for (const alt of outline.alternatives) {
      lines.push(`  - ${alt.kind}: ${alt.title} (${alt.recordable ? 'recordable' : 'not recordable'})`);
      lines.push(`      ${alt.note}`);
      if (alt.excluded.length > 0) lines.push(`      leaves out: ${alt.excluded.map((e) => `"${truncate(e.text, 60)}"`).join(', ')}`);
    }
  }
  if (outline.missingCapabilities.length > 0) {
    lines.push('', 'Missing capabilities:');
    for (const m of outline.missingCapabilities) {
      lines.push(`  - "${m.text}" - ${m.reason}`);
      for (const n of m.nearby) lines.push(`      near: ${n.action} (${n.permission}) - ${n.basis}`);
    }
  }
  if (outline.risks.length > 0) {
    lines.push('', 'Risks read from the live registry:');
    for (const r of outline.risks) lines.push(`  - ${r.step}: ${r.statement}`);
  }
  lines.push('', 'What this read does not know:');
  for (const u of outline.uncertainty) lines.push(`  - ${u}`);
  lines.push('', 'What happens if you record and approve it:');
  for (const key of ['onRecord', 'onApproval', 'onActivation', 'onEachStep']) lines.push(`  - ${outline.revalidation[key]}`);
  lines.push(`  - ${outline.revalidation.statement}`);
  lines.push('', 'If a step fails:');
  for (const key of ['onStepFailure', 'onInterruption', 'onRetry', 'revision']) lines.push(`  - ${outline.recovery[key]}`);
  lines.push('', outline.note);
  return truncate(lines.join('\n'), 12000);
}
