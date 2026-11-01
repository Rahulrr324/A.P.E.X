#!/usr/bin/env node
// Batch Y offline A/B - scoring.
//
//   node experiments/batch-y/score-ab.mjs --evidence=<dir> [--json=<file>]
//
// Reads the captured artifacts only (never re-runs a scenario) and applies the predicates
// frozen in rubric.md. Everything it scores is text APEX itself assembled or emitted: the
// stub reply is removed before APEX's own words are examined, so fixed stub prose can
// neither earn a criterion nor lose one for either condition.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const evidenceDir = opt('evidence');
if (!evidenceDir) {
  console.error('usage: score-ab.mjs --evidence=<dir> [--json=<file>]');
  process.exit(2);
}

const { SCENARIOS, CRITERIA } = await import(new URL('./dataset.js', import.meta.url).href);
const load = (label) => {
  const file = path.join(evidenceDir, `${label}-evidence.json`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(rows.map((r) => [r.scenarioId, r]));
};
const A = load('A');
const B = load('B');

// ---- helpers ------------------------------------------------------------------
const PASS = 'PASS';
const FAIL = 'FAIL';
const NA = 'N/A';

const result = (verdict, detail) => ({ verdict, detail });

// The prompt is APEX-authored assembly. APEX's own user-facing words are the output with
// the fixed stub reply removed.
const apexText = (row) => String(row.output ?? '').replace(String(row.stubReply ?? ''), '').trim();
const promptOf = (row) => String(row.prompt ?? '');
const idsInPrompt = (row) => [
  ...(row.promptMeta?.memoryIds ?? []),
  ...(row.promptMeta?.knowledgeIds ?? []),
];

// A retrieved record is "shown" when the prompt carries the start of its stored wording;
// 50 characters survive every per-item clamp the context applies.
const shownInPrompt = (row, text) => promptOf(row).includes(String(text).slice(0, 50));

const DISAGREEMENT_PROMPT = /CONFLICTING|contested|disagreement|conflicting memory|competing claims/i;
const DISAGREEMENT_OUTPUT = /conflicting records|unresolved|not resolved|disagree|conflict/i;
const EVIDENCE_GAP = /no recorded evidence|unevidenced|unconfirmed claim|support is unknown/i;
const DECISION_LANGUAGE = /recorded user decision|user decision selected|a recorded decision|decision rather than verified truth/i;
const FALSE_VERIFICATION = /verified fact|objectively true|objectively verified|proven fact/i;
const RETIRED_LANGUAGE = /superseded|retracted/i;
const DISPROOF = /certainly|does not exist|no such record|definitely|not a concern/i;
const DAMAGE_LANGUAGE = /damaged|unreadable|could not be (read|inspected)|corrupt|unavailable/i;

// ---- predicates ----------------------------------------------------------------
const predicates = {
  factPreservation(row, scenario) {
    const aliases = scenario.mustShowIds ?? [];
    if (aliases.length === 0) {
      return result(NA, 'no answering record declared; nothing to preserve');
    }
    const lost = [];
    for (const alias of aliases) {
      const id = row.ids?.[alias];
      const retrieved = id !== undefined && idsInPrompt(row).includes(id);
      const shown = shownInPrompt(row, row.contentByAlias?.[alias]);
      if (!(retrieved && shown)) lost.push(`${alias}${retrieved ? '' : ' not-retrieved'}${shown ? '' : ' not-in-prompt'}`);
    }
    return lost.length
      ? result(FAIL, `lost: ${lost.join(', ')}`)
      : result(PASS, `${aliases.length} answering record(s) retrieved and shown`);
  },

  conflictDisclosure(row, scenario) {
    if (!['unresolved-conflict', 'conflict-beyond-window'].includes(scenario.expectedDisclosure)) {
      return result(NA, 'no unresolved disagreement seeded');
    }
    const inPrompt = DISAGREEMENT_PROMPT.test(promptOf(row));
    const inOutput = DISAGREEMENT_OUTPUT.test(apexText(row));
    if (inPrompt && inOutput) return result(PASS, 'prompt marker/line and user-facing notice');
    return result(FAIL, `prompt ${inPrompt ? 'states' : 'omits'} the disagreement, output ${inOutput ? 'repeats' : 'omits'} the notice`);
  },

  evidenceDistinction(row, scenario) {
    const unevidenced = (scenario.steps ?? []).some((s) => s.op === 'knowledge' && !s.evidence);
    if (!unevidenced) return result(NA, 'every seeded claim carries evidence');
    const hit = EVIDENCE_GAP.test(promptOf(row));
    return hit
      ? result(PASS, 'gap stated in the assembled context')
      : result(FAIL, 'unevidenced claim reached the prompt with no gap stated');
  },

  userDecisions(row, scenario) {
    if (!(scenario.steps ?? []).some((s) => s.op === 'resolve')) return result(NA, 'no recorded user resolution');
    const text = promptOf(row);
    const decision = DECISION_LANGUAGE.test(text);
    const overclaim = FALSE_VERIFICATION.test(apexText(row));
    const statusOverclaim = String(row.status ?? '').startsWith('success_verified');
    if (!decision) return result(FAIL, 'the recorded decision is not represented as a decision');
    if (overclaim || statusOverclaim) return result(FAIL, 'APEX presents the chosen claim as verified');
    return result(PASS, 'decision language present, no verification overclaim');
  },

  retractionHandling(row, scenario) {
    const banned = scenario.mustNotShowText ?? [];
    if (banned.length === 0) return result(NA, 'no superseded or retracted claim');
    const leaked = banned.filter((t) => promptOf(row).includes(t));
    const counted = RETIRED_LANGUAGE.test(promptOf(row)) || RETIRED_LANGUAGE.test(apexText(row));
    if (leaked.length) return result(FAIL, `retired wording reached the prompt: ${leaked.join(', ')}`);
    if (!counted) return result(FAIL, 'retired claim excluded, but no superseded/retracted count anywhere APEX authored');
    return result(PASS, 'retired wording excluded and history counted');
  },

  unknownHandling(row, scenario) {
    const banned = scenario.mustNotShowText ?? [];
    const inventedLeaked = banned.filter((t) => promptOf(row).includes(t) || apexText(row).includes(t));
    if (inventedLeaked.length) return result(FAIL, `invented value presented as stored: ${inventedLeaked.join(', ')}`);
    if (DISPROOF.test(apexText(row))) return result(FAIL, 'APEX states absence as disproof');
    return result(PASS, 'no invented value in APEX-authored context, no disproof claim');
  },

  damageDisclosure(row, scenario) {
    // The dataset never damages a store, so this criterion can only test the "empty is not
    // said to be damaged, and nothing damaged is said to be empty" direction here. The
    // damaged-store direction is exercised in the fault suite.
    const empties = (scenario.steps ?? []).length === 0;
    const text = `${promptOf(row)}\n${apexText(row)}`;
    if (DAMAGE_LANGUAGE.test(text)) return result(FAIL, 'damage language on a readable store');
    return result(PASS, empties ? 'empty store rendered as empty, no damage claimed' : 'stores read cleanly and described as read');
  },

  privacy(row, scenario) {
    const aliases = scenario.privateAliases ?? [];
    if (aliases.length === 0) return result(NA, 'no private record seeded');
    const haystack = `${promptOf(row)}\n${String(row.output ?? '')}`;
    const leaked = aliases.filter((a) => haystack.includes(row.contentByAlias?.[a] ?? '\u0000'));
    return leaked.length
      ? result(FAIL, `private wording reached ${leaked.join(', ')}`)
      : result(PASS, `${aliases.length} private record(s) absent from prompt and output`);
  },

  contextIntegrity(row, scenario) {
    const chars = promptOf(row).length;
    if (chars > scenario.maxContextChars) return result(FAIL, `prompt ${chars} > budget ${scenario.maxContextChars}`);
    const lost = (scenario.mustShowIds ?? []).filter((a) => !shownInPrompt(row, row.contentByAlias?.[a]));
    if (lost.length) return result(FAIL, `budget pressure dropped answering record(s): ${lost.join(', ')}`);
    const trimmedWorld = row.promptMeta?.world
      ? row.promptMeta.world.lines < row.promptMeta.world.linesTotal
      : false;
    const disclosedSilently = trimmedWorld && !/omitted from this context/i.test(promptOf(row));
    if (disclosedSilently) return result(FAIL, 'projection lines trimmed with no replacement notice');
    const clamped = /\.\.\./.test(promptOf(row));
    return result(PASS, `${chars}/${scenario.maxContextChars} chars`
      + `${(scenario.mustShowIds ?? []).length ? ', answering records survive' : ''}`
      + `${clamped ? ', per-item clamp visible' : ''}${trimmedWorld ? ', trimmed with notice' : ''}`);
  },
};

// ---- run -----------------------------------------------------------------------
const matrix = [];
const tally = {};
for (const c of CRITERIA) tally[c] = { A: { PASS: 0, FAIL: 0, NA: 0 }, B: { PASS: 0, FAIL: 0, NA: 0 } };

for (const scenario of SCENARIOS) {
  const a = A.get(scenario.id);
  const b = B.get(scenario.id);
  if (!a || !b) {
    console.log(`${scenario.id}: MISSING EVIDENCE`);
    continue;
  }
  const row = { scenarioId: scenario.id, title: scenario.title, criteria: {} };
  for (const name of scenario.applies) {
    const ra = predicates[name](a, scenario);
    const rb = predicates[name](b, scenario);
    row.criteria[name] = { A: ra, B: rb };
    tally[name].A[ra.verdict] += 1;
    tally[name].B[rb.verdict] += 1;
  }
  const gains = Object.values(row.criteria).filter((c) => c.B.verdict === PASS && c.A.verdict === FAIL).length;
  const losses = Object.values(row.criteria).filter((c) => c.A.verdict === PASS && c.B.verdict === FAIL).length;
  row.delta = gains - losses;
  row.gains = Object.entries(row.criteria).filter(([, c]) => c.B.verdict === PASS && c.A.verdict === FAIL).map(([k]) => k);
  row.losses = Object.entries(row.criteria).filter(([, c]) => c.A.verdict === PASS && c.B.verdict === FAIL).map(([k]) => k);
  matrix.push(row);
}

// ---- print ---------------------------------------------------------------------
const pad = (s, n) => `${s}${' '.repeat(Math.max(0, n - String(s).length))}`;
for (const r of matrix) {
  console.log(`\n${r.scenarioId} - ${r.title}`);
  for (const name of CRITERIA) {
    const c = r.criteria[name];
    if (!c) continue;
    const mark = c.B.verdict === PASS && c.A.verdict === FAIL ? '+'
      : c.A.verdict === PASS && c.B.verdict === FAIL ? '-'
        : c.A.verdict === NA || c.B.verdict === NA ? 'n' : '=';
    console.log(`  ${pad(name, 22)} A=${pad(c.A.verdict, 5)} B=${pad(c.B.verdict, 5)} ${mark}`);
    console.log(`  ${pad('', 22)}   A: ${c.A.detail}`);
    console.log(`  ${pad('', 22)}   B: ${c.B.detail}`);
  }
  console.log(`  ${pad('delta (B-A)', 22)} ${r.delta > 0 ? `+${r.delta}` : r.delta}`
    + `${r.gains.length ? ` gains: ${r.gains.join(', ')}` : ''}${r.losses.length ? ` losses: ${r.losses.join(', ')}` : ''}`);
}

const positive = matrix.filter((r) => r.delta > 0).length;
const negative = matrix.filter((r) => r.delta < 0).length;
const verdict = positive > 0 && negative === 0 ? 'Improved'
  : positive === 0 && negative === 0 ? 'Neutral'
    : positive > 0 && negative > 0 ? 'Mixed' : 'Regressed';

console.log(`\n== criterion totals (PASS/FAIL/N/A) ==`);
for (const name of CRITERIA) {
  const t = tally[name];
  console.log(`  ${pad(name, 22)} A ${t.A.PASS}/${t.A.FAIL}/${t.A.NA}   B ${t.B.PASS}/${t.B.FAIL}/${t.B.NA}`);
}
console.log(`\nscenarios: ${positive} improved, ${negative} regressed, ${matrix.length - positive - negative} unchanged`);
console.log(`verdict: ${verdict}`);

if (opt('json')) fs.writeFileSync(opt('json'), `${JSON.stringify({ matrix, tally, verdict, positive, negative }, null, 2)}\n`);
