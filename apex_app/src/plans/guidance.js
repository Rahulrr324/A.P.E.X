// Approved-adaptation guidance: what recorded user guidance is allowed to do to a comparison.
//
// An adaptation is a pattern APEX found in the user's own corrections; it becomes guidance only when the
// user approved it. Until Batch AM such a record was printed beside a comparison and changed nothing in
// it, which was honest but incomplete: the user's recorded preference about how work of this kind should
// be ordered has consequences, and a system that reads it and ranks nothing by it is discarding the one
// thing the user asked it to remember.
//
// The consequence is bounded to ordering, and the ordering is bounded to what a record states as
// structure. A guidance record names one of two step orders, capabilities to avoid or prefer, and a step
// bound - all four are properties of a candidate's own steps, so `reads_first` is checked against the
// registry's read/write class for each step, not against anyone's opinion. A rule's prose is the user's
// own words and is displayed in full beside every influence; it is never parsed to decide anything,
// because a ranking read out of free text would be APEX choosing what the user meant and then reporting
// it as their instruction.
//
// What guidance can never do:
//   - grant permission. An approach moves up a comparison; every step is still authorized when it runs,
//     and the plan is still approved by the user against its exact bytes.
//   - outrank an instruction. A capability the user refused for this generation is settled by the
//     capability gate, and a blocker or unmet prerequisite the user recorded is settled by the constraint
//     gate. Where guidance points the other way, the record is reported as outranked and is not counted.
//   - pick a winner between two of the user's own records that disagree. If one approved record says
//     `reads_first` and another says `writes_first` for the same scope, that is a disagreement the user
//     has to see, so no ordering is claimed for either and both are printed with their ids.
//   - act on anything it is not entitled to. A candidate never approved, one rejected, retired, ambiguous,
//     resting on evidence that no longer stands, or contradicting another active record in its own scope is
//     inert here, exactly as it is inert everywhere else.
import { createHash } from 'node:crypto';
import { shortId, singleLine } from '../util.js';

export const GUIDANCE_NOTE = 'recorded guidance can move an approach in the comparison and nothing else: it authorizes no step, refuses no step, and starts nothing';
export const GUIDANCE_SCHEMA = 'apex.guidance.v1';

// Which ordinal of the user's recorded shapes is governing. The store keeps every shape record and the
// last one wins, so a version is the count of records, not a number APEX invents: version 2 is the second
// shape the user recorded for this adaptation. It is what an influenced decision names, so a reader can
// tell which statement of the rule was in force. A prediction-derived adaptation carries its shape in the
// candidate itself rather than in a separate guidance event, so the store states that version directly as
// `shapeVersion`; it is read first and the guidance-event count is only the fallback.
const versionOf = (row) => {
  if (Number.isInteger(row?.shapeVersion) && row.shapeVersion > 0) return row.shapeVersion;
  return Number.isInteger(row?.guidanceCount) && row.guidanceCount > 0 ? row.guidanceCount : null;
};

// The four things a guidance record can ask for, in the words the reader is shown. `order` is the only
// enumerated one; the other three are names and counts the candidate either matches or does not.
export const GUIDANCE_FIELDS = Object.freeze(['order', 'avoid', 'prefer', 'maxSteps']);

const INERT_STATES = Object.freeze({
  candidate: 'it was derived from recorded evidence and the user has not approved it',
  rejected: 'the user rejected it, so it is history and not guidance',
  retired: 'the user retired it, so nothing in it applies to future work',
  ambiguous: 'the log holds more than one retirement for it, so its state is not established',
  stale: 'its own supporting evidence no longer stands as recorded',
});

function digestOf(shape) {
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// Is a step a write? The registry's own permission class answers it - the same fact the reversibility
// dimension and the capability gate read - so a guidance record cannot be satisfied by a step calling
// itself read-only in its description.
function writeIndexOf(steps, registry) {
  let firstWrite = -1;
  let lastRead = -1;
  steps.forEach((s, i) => {
    const isWrite = registry.get(s.action)?.permission === 'write';
    if (isWrite && firstWrite === -1) firstWrite = i;
    if (!isWrite) lastRead = i;
  });
  return { firstWrite, lastRead };
}

// The order an `order` field asks for, judged on the steps as they are written. `null` means the record
// says nothing this candidate can answer either way - a plan with only reads cannot be said to have put
// its reads first, because it has no write to put after them.
function orderHolds(order, steps, registry) {
  const { firstWrite, lastRead } = writeIndexOf(steps, registry);
  if (order === 'reads_first') {
    if (firstWrite === -1 || lastRead === -1) return null;
    return lastRead < firstWrite;
  }
  if (order === 'writes_first') {
    if (firstWrite === -1 || lastRead === -1) return null;
    return firstWrite < lastRead;
  }
  return null;
}

// One field, one answer: `met`, `unmet`, or `void` when the candidate cannot be said to answer the
// question at all. `void` never counts against a candidate, and a field refused by the user's own
// instruction is reported as outranked rather than as a disagreement with the guidance.
function fieldState(field, value, { steps, registry, instructionRefusals }) {
  const uses = new Set(steps.map((s) => s.action));
  if (field === 'order') {
    const holds = orderHolds(value, steps, registry);
    return holds === null ? 'void' : holds ? 'met' : 'unmet';
  }
  if (field === 'avoid') {
    const named = value.filter((name) => uses.has(name));
    // The user's own instruction about this generation answers the same question with more authority:
    // a capability they have already refused cannot be refused twice by a record beside it.
    if (named.some((name) => instructionRefusals.has(name))) return 'outranked';
    if (named.length > 0) return 'unmet';
    return value.length === 0 ? 'void' : 'met';
  }
  if (field === 'prefer') {
    if (value.length === 0) return 'void';
    const askable = value.filter((name) => !instructionRefusals.has(name));
    if (askable.length === 0) return 'outranked';
    return askable.some((name) => uses.has(name)) ? 'met' : 'unmet';
  }
  if (field === 'maxSteps') {
    if (value === null || value === undefined) return 'void';
    return steps.length <= value ? 'met' : 'unmet';
  }
  return 'void';
}

// Which of two applied records contradict each other, as the fields state it: the same field of two
// records about an overlapping scope asking for opposite things - `reads_first` against `writes_first`,
// one record's `avoid` in the other's `prefer`, two different step bounds. A preference one record states
// and another simply does not mention is not a contradiction, and nothing is invented from the silence.
function contradictingPairs(applied) {
  const pairs = [];
  for (let i = 0; i < applied.length; i += 1) {
    for (const other of applied.slice(i + 1)) {
      const a = applied[i];
      const b = other;
      if (!scopesOverlap(a.capability, b.capability)) continue;
      const fields = [];
      if (a.guidance.order && b.guidance.order && a.guidance.order !== b.guidance.order) fields.push('order');
      if (a.guidance.avoid.some((n) => b.guidance.prefer.includes(n))
        || b.guidance.avoid.some((n) => a.guidance.prefer.includes(n))) fields.push('avoid', 'prefer');
      if (a.guidance.maxSteps !== null && b.guidance.maxSteps !== null && a.guidance.maxSteps !== b.guidance.maxSteps) fields.push('maxSteps');
      if (fields.length > 0) {
        pairs.push({
          between: [a.id, b.id],
          capabilities: [a.capability, b.capability],
          fields,
          statement: `${a.id} (${a.capability}) and ${b.id} (${b.capability}) disagree on ${fields.join(', ')}: `
            + `${a.rule} / ${b.rule}. Both records stand as the user approved them, so the ordering is withheld rather than decided.`,
        });
      }
    }
  }
  return pairs;
}

function scopesOverlap(a, b) {
  if (!a || !b) return a === b;
  const [pa, pb] = [String(a).toLowerCase().split('.'), String(b).toLowerCase().split('.')];
  const shared = Math.min(pa.length, pb.length);
  return pa.slice(0, shared).join('.') === pb.slice(0, shared).join('.');
}

// Does this adaptation's scope bear on the capabilities these candidates actually name? The same
// prefix rule the experience store uses for a scope question, so guidance recorded for `memory` reaches
// a step of `memory.add` and guidance for `memory.add` does not reach a step of `memory.search`.
function inScope(adaptation, capabilities) {
  if (!adaptation?.capability) return false;
  const scope = String(adaptation.capability).toLowerCase();
  return capabilities.some((name) => {
    const parts = String(name).toLowerCase().split('.');
    const scopeParts = scope.split('.');
    return scopeParts.length <= parts.length && parts.slice(0, scopeParts.length).join('.') === scopeParts.join('.');
  });
}

function stateOf(row) {
  if (row.decisionState === 'approved' && row.active === true) return 'applied';
  if (row.decisionState && row.active === false) {
    return row.decisionState === 'approved' ? 'stale' : row.decisionState;
  }
  return row.decisionState ?? 'candidate';
}

// The guidance ledger for one comparison. `adaptations` are the rows a learning read produced for the
// capabilities these candidates name, with their derived `guidance` shapes beside them; `instructionRefusals`
// are the capabilities the user told this generation not to use, which the gates already own.
export function guidanceFrom({
  adaptations = [], candidates = [], registry = null, instructionRefusals = null, now = null,
} = {}) {
  const names = new Set(candidates.flatMap((c) => (c?.content?.steps ?? []).map((s) => s.action)));
  const refusals = new Set((instructionRefusals ?? []).map(String));
  const capabilities = [...names];
  const records = [];
  const inert = [];
  const applied = [];
  for (const row of adaptations ?? []) {
    const state = stateOf(row);
    const shape = row.guidance ?? null;
    const source = row.source === 'prediction' || row.method === 'evaluated_prediction' ? 'prediction' : 'feedback';
    const entry = {
      id: row.id,
      capability: row.capability ?? null,
      rule: singleLine(row.rule ?? '', 200),
      ruleHash: row.ruleHash ?? null,
      version: versionOf(row),
      // What produced the rule. Feedback-derived and prediction-derived records run through the same
      // approval gate and the same ordering, so a comparison that could not name which one it was reading
      // could not disclose that two different kinds of evidence were behind the same dimension.
      source,
      method: row.method ?? null,
      supportCount: row.supportCount ?? 0,
      // The exact records the rule rests on, kept separated by kind. A prediction-derived rule cites one
      // prediction and one evaluation; folding those into the experience list would let a reader count one
      // evaluation twice and lose which ledger it came from.
      support: {
        experienceIds: [...(row.support?.experienceIds ?? [])],
        feedbackIds: [...(row.support?.feedbackIds ?? [])],
        predictionIds: [...(row.support?.predictionIds ?? [])],
        evaluationIds: [...(row.support?.evaluationIds ?? [])],
      },
      // The store's read of whether the cited prediction still stands behind this candidate. It is null
      // for a feedback-derived record and for a caller that did not read the prediction ledger, which is
      // why it is printed as an absence rather than treated as "eligible".
      predictionEvidence: row.predictionEvidence ? {
        eligible: row.predictionEvidence.eligible === true,
        state: row.predictionEvidence.state ?? null,
        reason: row.predictionEvidence.reason ?? null,
      } : null,
      // The typed rule the evaluated outcome proposed, exactly as stored, for the records whose shape came
      // from a prediction rather than from a guidance event. Bounded to what the validator admits.
      proposal: row.proposal ? {
        type: row.proposal.type ?? null,
        dimension: row.proposal.dimension ?? null,
        verdicts: (row.proposal.verdicts ?? []).slice(0, 2).map((v) => ({ ...v })),
        guidance: {
          order: row.proposal.guidance?.order ?? null,
          avoid: [...(row.proposal.guidance?.avoid ?? [])],
          prefer: [...(row.proposal.guidance?.prefer ?? [])],
          maxSteps: row.proposal.guidance?.maxSteps ?? null,
        },
        limitations: [...(row.proposal.limitations ?? [])],
        evidenceDigest: row.proposal.evidenceDigest ?? null,
      } : null,
      decidedAt: row.decidedAt ?? null,
      decisionState: row.decisionState ?? null,
      active: row.active === true,
      conflicts: (row.conflictsWith ?? []).length,
      guidance: shape ? {
        order: shape.order ?? null,
        avoid: [...(shape.avoid ?? [])],
        prefer: [...(shape.prefer ?? [])],
        maxSteps: shape.maxSteps ?? null,
        id: shape.id ?? null,
        createdAt: shape.createdAt ?? null,
        operationId: shape.operationId ?? null,
      } : null,
      state: null,
      why: null,
    };
    if (!shape) {
      entry.state = state === 'applied' ? 'unshaped' : state;
      entry.why = state === 'applied'
        ? 'the user approved the rule and never recorded a shape for it, so there is nothing to compare a candidate against'
        : (INERT_STATES[state] ?? 'it is not an approved, active guidance record');
      inert.push(entry);
      records.push(entry);
      continue;
    }
    if (state !== 'applied') {
      entry.state = state;
      entry.why = (state === 'stale' && typeof row.inactiveReason === 'string' && row.inactiveReason.length > 0)
        ? singleLine(row.inactiveReason, 300)
        : (INERT_STATES[state] ?? 'the record it belongs to is not an approved, active adaptation');
      inert.push(entry);
      records.push(entry);
      continue;
    }
    if (!inScope(entry, capabilities)) {
      entry.state = 'out_of_scope';
      entry.why = `its scope is ${entry.capability ?? 'nothing'}, which no step of any candidate here names`;
      inert.push(entry);
      records.push(entry);
      continue;
    }
    if (entry.conflicts > 0) {
      entry.state = 'conflicted';
      entry.why = `another active adaptation for ${entry.capability} records a different rule, and the store keeps both`;
      inert.push(entry);
      records.push(entry);
      continue;
    }
    entry.state = 'applicable';
    entry.why = 'the user approved it, its evidence still stands, and its shape names work these candidates do';
    applied.push(entry);
    records.push(entry);
  }

  const pairs = contradictingPairs(applied);
  const withheld = new Set(pairs.flatMap((p) => p.between));
  for (const entry of applied) {
    if (withheld.has(entry.id)) {
      entry.state = 'contradicted';
      entry.why = pairs.find((p) => p.between.includes(entry.id)).statement;
      inert.push(entry);
    }
  }
  const usable = applied.filter((e) => e.state === 'applicable');

  const rows = (candidates ?? []).map((candidate) => {
    const steps = candidate?.content?.steps ?? [];
    const fields = [];
    for (const record of usable) {
      for (const field of GUIDANCE_FIELDS) {
        const value = record.guidance[field];
        if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) continue;
        const state = fieldState(field, value, { steps, registry, instructionRefusals: refusals });
        fields.push({ id: record.id, capability: record.capability, field, state });
      }
    }
    const met = fields.filter((f) => f.state === 'met');
    const unmet = fields.filter((f) => f.state === 'unmet');
    const outranked = fields.filter((f) => f.state === 'outranked');
    const voided = fields.filter((f) => f.state === 'void');
    const checkable = met.length + unmet.length;
    return {
      strategy: candidate?.strategy ?? null,
      digest: candidate?.digest ?? null,
      // Counted the way the resource dimension is: what is recorded, unmodified, and read the
      // low-is-good way by the comparison. Negating it here as well would invert the ordering twice
      // and rank a candidate that answers nothing above one that answers everything.
      value: checkable === 0 ? null : unmet.length,
      invert: true,
      band: checkable === 0
        ? (usable.length === 0
          ? 'no approved, applicable guidance record with a recorded shape bears on these capabilities'
          : 'the guidance on record asks nothing these steps can answer, so it separates nothing')
        : `${met.length} of ${checkable} recorded guidance requirement(s) met${unmet.length ? `; not met: ${unmet.map((u) => `${shortId(u.id)} ${u.field}`).join(', ')}` : ''}${voided.length ? `; silent on: ${voided.map((v) => `${shortId(v.id)} ${v.field}`).join(', ')}` : ''}${outranked.length ? `; settled by the user's own instruction instead: ${outranked.map((o) => `${shortId(o.id)} ${o.field}`).join(', ')}` : ''}`,
      fields,
      met: met.map((m) => ({ id: m.id, field: m.field })),
      unmet: unmet.map((u) => ({ id: u.id, field: u.field })),
      outranked: outranked.map((o) => ({ id: o.id, field: o.field })),
      notCheckable: voided.map((v) => ({ id: v.id, field: v.field })),
    };
  });

  const influenced = rows.some((r) => r.value !== null);
  // Which kind of evidence is behind the ordering that was applied. The five distinctions the disclosure
  // owes the user are all readable here: a feedback-derived rule, a prediction-derived rule, both kinds
  // applicable at once, a prediction record that was considered and could not stand, and no prediction
  // record at all (`predictionConsidered === 0`).
  const sources = {
    feedbackDerived: usable.filter((e) => e.source === 'feedback').map((e) => e.id),
    predictionDerived: usable.filter((e) => e.source === 'prediction').map((e) => e.id),
    bothEligible: usable.some((e) => e.source === 'feedback') && usable.some((e) => e.source === 'prediction'),
    predictionConsidered: records.filter((e) => e.source === 'prediction').length,
    predictionRejected: inert.filter((e) => e.source === 'prediction').map((e) => ({ id: e.id, state: e.state, why: e.why })),
  };
  return {
    schema: GUIDANCE_SCHEMA,
    note: GUIDANCE_NOTE,
    at: now ?? null,
    records,
    applicable: usable.map((e) => e.id),
    inert: inert.map((e) => ({ id: e.id, source: e.source, state: e.state, why: e.why })),
    conflicts: pairs,
    sources,
    candidates: rows,
    // The claim the AL record set made as an absence, now stated as a fact about this comparison: one
    // record shaped the ordering, or none could. `false` is still the honest answer when no approved
    // record carries a shape that these steps can answer.
    influencesSelection: influenced,
    authorizes: false,
    digest: digestOf({
      applicable: usable.map((e) => [e.id, e.capability, e.version, e.source, e.guidance.order, e.guidance.avoid, e.guidance.prefer, e.guidance.maxSteps]).sort(),
      // Inert records are deliberately not in here: this digest certifies what ranked the candidates,
      // and a record that ranked nothing moving between two inert states must not read as a change to
      // the answer. What can move the ranking - an applicable shape, an unresolved conflict, a field
      // judgement - is all above.
      conflicts: pairs.map((p) => [p.between, p.fields]).sort(),
      rows: rows.map((r) => [r.strategy, r.value, r.met, r.unmet, r.outranked, r.notCheckable]),
    }),
  };
}

// The empty answer, with the reason it is empty: a comparison that was handed no learning read, or a
// read that found nothing shaped, must say which - "nothing on record" and "nothing checked" are
// different answers, and only the first is a fact about the user's guidance.
export function emptyGuidance(reason = null, candidates = []) {
  return {
    schema: GUIDANCE_SCHEMA,
    note: GUIDANCE_NOTE,
    at: null,
    records: [],
    applicable: [],
    inert: [],
    conflicts: [],
    sources: { feedbackDerived: [], predictionDerived: [], bothEligible: false, predictionConsidered: 0, predictionRejected: [] },
    // A row per candidate, so the comparison prints the same dimension for every approach and says it
    // had nothing to judge - the alternative is a dimension that silently disappears from half the
    // answers, which reads like a difference between the candidates rather than between the reads.
    candidates: (candidates ?? []).map((c) => ({
      strategy: c?.strategy ?? null,
      digest: c?.digest ?? null,
      value: null,
      band: 'no guidance read was made for this comparison, so nothing on record could be checked against these steps',
      fields: [],
      met: [],
      unmet: [],
      outranked: [],
      notCheckable: [],
    })),
    influencesSelection: false,
    authorizes: false,
    reason: reason ?? 'no guidance read was made for this comparison',
    digest: digestOf({ empty: reason ?? 'none', rows: (candidates ?? []).map((c) => c?.strategy ?? null) }),
  };
}

export function guidanceDigest(guidance) {
  return guidance ? guidance.digest : null;
}

// Why the ordering was not moved. This is the comparison's own reading of the ledger it was handed, in
// the states the ledger already derives - it adds no reason the records do not support. `null` means the
// guidance was applied; a caller prints this only when it was not.
export function guidanceDeclinedReason(guidance) {
  if (!guidance) return 'no guidance read was made for this comparison';
  const records = guidance.records ?? [];
  if (records.length === 0) return guidance.reason ?? 'no approved guidance record bears on these capabilities';
  if ((guidance.conflicts ?? []).length > 0) {
    return 'two approved records for this scope disagree, so the ordering is withheld rather than decided';
  }
  if ((guidance.applicable ?? []).length === 0) {
    const states = new Set(records.map((r) => r.state));
    if (states.has('unshaped')) return 'the approved record carries no shape the user recorded, so it asks nothing this comparison can check';
    if (states.has('out_of_scope')) return 'the approved record names a scope no step of these candidates uses';
    if ([...states].some((s) => ['candidate', 'rejected', 'retired', 'ambiguous', 'stale'].includes(s))) {
      return 'the records that bear on this scope are not approved, active, and intact, so none of them may move the ordering';
    }
    return 'no approved guidance record bears on these capabilities';
  }
  return 'the applicable guidance asks nothing these candidate steps can answer';
}

// One line per record and per candidate: what the record says, what it was allowed to do about it, and
// which fields each approach met. The rule text is the user's own, printed as recorded, because a reader
// who cannot see the words cannot disagree with the use made of them.
export function renderGuidance(guidance, { indent = '' } = {}) {
  if (!guidance) {
    return `${indent}No guidance read was made, so nothing on record moved this comparison. ${GUIDANCE_NOTE}`;
  }
  const lines = [];
  const applicable = guidance.applicable ?? [];
  lines.push(`${indent}Approved guidance that bears on these capabilities (${applicable.length} able to move the comparison, ${(guidance.inert ?? []).length} reported and not applied):`);
  for (const record of guidance.records ?? []) {
    const shape = record.guidance
      ? [`order ${record.guidance.order ?? '-'}`, `avoid ${record.guidance.avoid.join(', ') || '-'}`, `prefer ${record.guidance.prefer.join(', ') || '-'}`, `at most ${record.guidance.maxSteps ?? '-'} step(s)`].join(', ')
      : 'no shape recorded';
    // Which ledger the rule came from, stated beside the rule. A prediction-derived rule is not more or
    // less authoritative than a feedback-derived one - both needed the user's approval - but the reader
    // is entitled to know which kind of evidence they approved.
    const provenance = record.source === 'prediction'
      ? `prediction-derived${record.predictionEvidence ? ` (prediction evidence ${record.predictionEvidence.eligible ? 'still stands' : `no longer stands: ${record.predictionEvidence.reason ?? record.predictionEvidence.state ?? 'not established'}`})` : ''}`
      : 'feedback-derived';
    const support = record.source === 'prediction'
      ? `${record.support.predictionIds.length} prediction(s), ${record.support.evaluationIds.length} evaluation(s)`
      : `${record.support.experienceIds.length} experience(s), ${record.support.feedbackIds.length} feedback record(s)`;
    lines.push(`${indent}  ${record.id} for ${record.capability ?? '-'} [${record.state}]: ${record.rule}`);
    lines.push(`${indent}    ${provenance}; shape: ${shape}; approved ${record.active ? 'and still standing' : 'not established as active'}; support: ${support}`);
    lines.push(`${indent}    ${record.why}`);
  }
  for (const pair of guidance.conflicts ?? []) {
    lines.push(`${indent}  unresolved between the user's own records: ${pair.statement}`);
  }
  for (const row of guidance.candidates ?? []) {
    lines.push(`${indent}  ${row.strategy}: ${row.band}`);
    for (const f of row.unmet ?? []) lines.push(`${indent}    not met: ${f.field} as recorded by ${f.id}`);
    for (const f of row.outranked ?? []) {
      lines.push(`${indent}    settled elsewhere: ${f.field} as recorded by ${f.id} - the capability gate answers the user's own instruction first`);
    }
  }
  if ((guidance.records ?? []).length === 0) {
    lines.push(`${indent}  nothing is recorded as approved guidance for these capabilities${guidance.reason ? ` (${guidance.reason})` : ''}`);
  }
  lines.push(`${indent}  ${guidance.note}`);
  return lines.join('\n');
}
