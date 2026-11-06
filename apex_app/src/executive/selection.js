// Selecting one plan to record out of the candidates a comparison produced.
//
// The mission loop asks APEX to generate approaches, compare them, and then *select* one. Selection is
// where a system can quietly invent an authority it does not have, so this module is written to refuse:
// it hands back one candidate only when the disclosed comparison rule separates it from every other
// candidate that passed every gate. Where two candidates each lead on a dimension the rule ranks - one
// settling more of the goal's criteria, the other writing nothing - the answer is the trade-off, not a
// coin. That is the honest result more often than a single winner, and it is the result the user can
// act on: they set the priority, APEX records whichever one they name.
//
// What the others were is disclosed rather than dropped. A selection that hides the approaches it did
// not take leaves the reader unable to disagree with it, so each alternative is reported with the
// position it holds under the rule and the record that put it there: the dimensions a dominated
// candidate lost on, the gate an excluded candidate failed, the reason an approach was not offered at
// all. Nothing here adds a reason the comparison did not produce, and nothing here invents a candidate
// the generator did not return.
//
// Selection records nothing and approves nothing. The caller records the chosen candidate with the
// existing `plan.add` action, which is verified by that action's own read-back; approval stays a
// separate user act bound to the recorded bytes.
import { shortId, singleLine } from '../util.js';
import { BOUNDS } from './vocabulary.js';

export const SELECTION_NOTE = 'one plan is recorded only when the disclosed comparison rule separates it from the others; where it cannot, the trade-off is reported and nothing is recorded';

const MAX_DISCLOSED = 6;

function why(row, comparison) {
  if (row.position === 'excluded') {
    return row.failedGates.map((g) => `gate ${g.gate}: ${g.detail}`).join('; ');
  }
  if (row.position === 'not offered') return row.reason;
  if (row.position === 'behind') {
    const behind = (comparison.behind ?? []).find((b) => b.strategy === row.strategy);
    return (behind?.whyBehind ?? [])
      .map((w) => `behind ${w.under} on ${w.on.join(', ')}, and at least as good on nothing it leads`)
      .join('; ') || 'another candidate is at least as good on every ranked dimension and better on one';
  }
  if (row.position === 'unseparated') {
    const said = (comparison.tradeOffs ?? []).filter((t) => t.includes(row.strategy));
    if (said.length > 0) return said.join('; ');
    const tie = (comparison.ties ?? []).find((t) => t.includes(row.strategy));
    return tie ?? 'the ranked dimensions do not separate it from the candidate that leads';
  }
  if (row.position === 'unranked') {
    return 'it passed every gate, and the comparison recorded no dimension on which another candidate does better everywhere';
  }
  return comparison.basis ?? 'the rule placed it above every other candidate that passed every gate';
}

// One row per approach the comparison knows about, in the order the reader is shown them: the leader
// first, then the others as the comparison classified them. `position` is the comparison's own
// classification, never a new judgement.
function alternativesOf(comparison, candidates, leading) {
  const rows = [];
  const seen = new Set();
  for (const row of candidates ?? []) {
    if (row.strategy === leading) continue;
    seen.add(row.strategy);
    const position = (comparison.included ?? []).includes(row.strategy)
      ? ((comparison.behind ?? []).some((b) => b.strategy === row.strategy) ? 'behind' : 'unseparated')
      : 'unranked';
    rows.push({ strategy: row.strategy, digest: row.digest, position, why: why({ position }, comparison) });
  }
  for (const c of comparison.excluded ?? []) {
    if (seen.has(c.strategy)) continue;
    rows.push({
      strategy: c.strategy, digest: c.digest, position: 'excluded',
      failedGates: c.failedGates ?? [], why: why({ position: 'excluded', failedGates: c.failedGates ?? [] }, comparison),
    });
  }
  return rows;
}

// The selection. `comparison` is the `comparison` field of a `plan.candidates` or `plan.replan` read,
// and `candidates` is the row list beside it, so this reads exactly what the audited read reported.
export function selectCandidate({ comparison, candidates = [], skipped = [], goalId = null, planId = null } = {}) {
  if (!comparison || typeof comparison !== 'object') {
    return {
      ok: false, reason: 'no-comparison', goalId, planId, chosen: null, alternatives: [],
      whatWouldSettleIt: [], basis: null,
      problems: ['no comparison was read, so there is nothing to select from and nothing was recorded'],
      note: SELECTION_NOTE,
    };
  }
  const leading = comparison.leading ?? null;
  const excluded = comparison.excluded ?? [];
  const alternatives = alternativesOf(comparison, candidates, leading);
  const notOffered = (skipped ?? []).map((s) => ({
    strategy: s.strategy, digest: null, position: 'not offered', why: s.reason,
  }));
  const all = [...alternatives, ...notOffered];

  if (comparison.ok === false) {
    return {
      ok: false, reason: comparison.reason ?? 'comparison-refused', goalId, planId, chosen: null,
      alternatives: all, whatWouldSettleIt: comparison.whatWouldSettleIt ?? [],
      basis: comparison.basis ?? null, problems: comparison.problems ?? [], note: SELECTION_NOTE,
    };
  }
  if (!leading) {
    // The rule ranked the candidates and could not separate them. That is the finding, and the
    // response is the trade-off in the reader's terms - not a tie-break invented here.
    return {
      ok: false, reason: 'unresolved', goalId, planId, chosen: null, alternatives: all,
      whatWouldSettleIt: comparison.whatWouldSettleIt ?? [],
      basis: comparison.basis ?? null, problems: [], note: SELECTION_NOTE,
    };
  }
  const row = (candidates ?? []).find((c) => c.strategy === leading);
  if (!row) {
    // The comparison names a leader the handed candidate list does not carry. Choosing anyway would
    // record bytes this read never saw, so the mismatch is the answer.
    return {
      ok: false, reason: 'leader-not-in-candidate-set', goalId, planId, chosen: null, alternatives: all,
      whatWouldSettleIt: [], basis: null,
      problems: [`the comparison names ${leading} as leading, but the candidate list it came with holds no such candidate`],
      note: SELECTION_NOTE,
    };
  }
  const cited = (comparison.boundTo?.candidateDigests ?? []).find((d) => d.strategy === leading);
  if (cited && cited.digest !== row.digest) {
    return {
      ok: false, reason: 'candidate-changed', goalId, planId, chosen: null, alternatives: all,
      whatWouldSettleIt: [], basis: null,
      problems: [`the candidate ${leading} no longer has the bytes the comparison was bound to (${shortId(cited.digest)} against ${shortId(row.digest)})`],
      note: SELECTION_NOTE,
    };
  }
  return {
    ok: true,
    reason: null,
    goalId,
    planId,
    chosen: { strategy: row.strategy, digest: row.digest, steps: row.steps, writes: row.writes, risk: row.risk },
    basis: comparison.basis,
    rule: comparison.rule,
    alternatives: all,
    // The candidate that was dropped, with the reason the comparison produced for it, is part of the
    // record the user reads: a selection with no alternatives shown is a selection that cannot be
    // argued with.
    excludedCount: excluded.length,
    whatWouldSettleIt: comparison.whatWouldSettleIt ?? [],
    note: SELECTION_NOTE,
  };
}

// The disclosure printed beside the recorded draft: what led, under what rule, and what the others
// were. Lines are bounded like every other view in this layer.
export function renderSelection(selection, { indent = '' } = {}) {
  const lines = [];
  if (!selection) return `${indent}No selection was made.`;
  if (!selection.ok) {
    lines.push(`${indent}Nothing was selected, and nothing was recorded: ${selection.reason}.`);
    for (const p of selection.problems ?? []) lines.push(`${indent}  - ${singleLine(p, BOUNDS.maxReasonChars)}`);
    if (selection.basis) lines.push(`${indent}  what the rule found: ${singleLine(selection.basis, BOUNDS.maxReasonChars)}`);
  } else {
    lines.push(`${indent}Selected: ${selection.chosen.strategy} (${selection.chosen.steps} step(s), ${selection.chosen.writes} write(s), ${selection.chosen.risk} risk), digest ${shortId(selection.chosen.digest)}.`);
    lines.push(`${indent}  why this one: ${singleLine(selection.basis, BOUNDS.maxReasonChars)}`);
    lines.push(`${indent}  rule: ${singleLine(selection.rule, 320)}`);
  }
  const others = selection.alternatives ?? [];
  if (others.length === 0) {
    lines.push(`${indent}  other approaches: none were compared, so there is nothing to disclose beside this one.`);
  } else {
    lines.push(`${indent}  the approaches not recorded, and why (${others.length}):`);
    for (const a of others.slice(0, MAX_DISCLOSED)) {
      lines.push(`${indent}    - ${a.strategy} [${a.position}]: ${singleLine(a.why, BOUNDS.maxReasonChars)}`);
    }
    if (others.length > MAX_DISCLOSED) {
      lines.push(`${indent}    - ... and ${others.length - MAX_DISCLOSED} more the comparison reported`);
    }
  }
  for (const w of (selection.whatWouldSettleIt ?? []).slice(0, 4)) {
    lines.push(`${indent}  what would settle the choice: ${singleLine(w, BOUNDS.maxReasonChars)}`);
  }
  lines.push(`${indent}  ${selection.note}`);
  return lines.join('\n');
}
