// Bounded, model-free benchmark for the one decision Batch AP lets approved guidance move (AP-01).
//
// The measured path is `evaluateCandidates` - the same call `plan.candidates` and `plan.replan` make -
// with an approved, shaped guidance record in force. Batch AP added exactly one stage to it: the
// counterfactual decision block (`adaptationDecision`), which runs the existing Pareto rule a second
// time over the same candidate bytes with the one guidance dimension removed, so the reader is shown
// what the rule would have said without the record. Nothing else in the call changed.
//
// So the before/after here is the real thing, not a switched-off mode: the pre-change module is
// extracted from git with `git archive` into a temporary directory and imported beside the working
// tree's module. Both are handed the same fixture objects in the same process, interleaved per sample,
// and their results are compared field by field. The default `--before-ref` is the last commit before
// Batch AP; after AP is committed, pass the parent commit's SHA.
//
// No inference is run or simulated and no backend is constructed: no application is built at all, the
// comparison is a pure function over synthetic candidates and a synthetic guidance ledger. This is not
// part of `npm test` and no test depends on it.
//
//   node benchmarks/run-adaptation-decision-benchmark.mjs [--sizes S,M,L] [--repeats R] [--before-ref SHA] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateCandidates, renderAdaptationDecision } from '../src/plans/evaluation.js';
import { guidanceFrom } from '../src/plans/guidance.js';
import { planRisk, validatePlanContent } from '../src/plans/model.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const MAX_REPEATS = 25;
const DEFAULT_BEFORE_REF = 'a2c9a64f7cbce0d9ae63baae0a2385beeff019dc';

// The growth axes are the two things the decision stage reads: how many candidates the Pareto pass
// compares, and how many approved records with how much support the disclosure has to name. The
// support axis stops at the evidence bound the decision itself applies (20 ids per kind), because a
// larger number would measure slicing, not the stage.
const SIZES = {
  S: { candidates: 4, records: 1, support: 2 },
  M: { candidates: 10, records: 6, support: 10 },
  L: { candidates: 20, records: 12, support: 20 },
};

const dirs = [];
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apex-bench-ap01-${tag}-`));
  dirs.push(dir);
  return dir;
}

function cleanup(keep) {
  if (keep) {
    for (const dir of dirs) console.log(`left behind: ${dir}`);
    return;
  }
  while (dirs.length) {
    const dir = dirs.pop();
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir())) || !path.basename(resolved).startsWith('apex-bench-ap01-')) {
      console.error(`refused to remove ${resolved}: not an apex-bench-ap01- temporary directory`);
      continue;
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - String(s).length))}`;
const ms = (n) => `${(Math.round(n * 1000) / 1000).toFixed(3)}ms`;

function timed(fn, runs) {
  const samples = [];
  let first = null;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const out = fn();
    if (i === 0) first = out;
    samples.push(performance.now() - started);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], all: samples, first };
}

const line = (label, t) => `  ${pad(label, 46)} ${pad(ms(t.median), 12)} min ${pad(ms(t.min), 12)}`
  + ` samples ${t.all.map((x) => (Math.round(x * 1000) / 1000).toFixed(2)).join('/')}ms`;

// The registry shape the comparison reads: a permission class per action, nothing else. The guidance
// ledger's order field is answered off this class, which is why the fixture is built here rather than
// inferred from the step text.
const NAMES = ['memory.add', 'memory.list', 'memory.search', 'calc.evaluate'];
const registry = {
  names: () => [...NAMES],
  get: (name) => (NAMES.includes(name)
    ? { name, permission: name === 'memory.add' ? 'write' : 'read', plannable: true }
    : null),
  authorize: () => ({ decision: 'allow' }),
};

function candidateOf(index, structure, seconds) {
  const write = { action: 'memory.add', risk: 'medium' };
  const read = { action: 'memory.list', risk: 'low' };
  const ordered = structure === 'writes_first' ? [write, read, write, read] : [read, write, read, write];
  const steps = ordered.slice(0, 2 + (index % 3)).map((s, i) => ({
    id: `s${i + 1}`,
    description: `${s.action} is the ${i + 1} step of this approach`,
    action: s.action,
    input: {},
    dependsOn: i === 0 ? [] : [`s${i}`],
    expectedResult: `the ${s.action} result is recorded`,
    verification: 'the action re-checks its own result',
    risk: s.risk,
    estimate: { seconds: null },
    reversibility: s.action === 'memory.add' ? 'reversible' : 'read_only',
    recovery: 'the task stops here and later steps do not run',
  }));
  const content = {
    goalId: 'goal-bench',
    outcome: 'the recorded criteria are settled',
    steps,
    preconditions: [],
    assertions: [],
    resources: { estimatedSeconds: seconds },
  };
  const problems = validatePlanContent(content);
  const strategy = `${structure}_${String(index).padStart(2, '0')}`;
  const writes = steps.filter((s) => registry.get(s.action)?.permission === 'write').length;
  return {
    strategy,
    note: `${strategy} as an approach`,
    outcome: content.outcome,
    content,
    digest: createHash('sha256').update(strategy).digest('hex'),
    steps: content.steps.length,
    writes,
    reads: content.steps.length - writes,
    risk: planRisk(content.steps),
    reversibility: content.steps.map((s) => ({ id: s.id, action: s.action, reversibility: s.reversibility })),
    failurePaths: content.steps.map((s) => ({ id: s.id, action: s.action, recovery: s.recovery })),
    validation: problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems },
    capabilities: content.steps.map((s) => ({ action: s.action, permission: registry.get(s.action)?.permission, hasVerifier: false })),
    criteriaCovered: [],
    criteriaLeftUnaddressed: [],
    criteriaAssumedFromTheGoalRequest: [],
    criteriaSharedWithAnEarlierStep: [],
    criteriaBeyondThePlanBound: [],
    criteriaFromInference: [],
    criteriaLeftOutOfThisApproach: [],
    stepsBeyondThePlanBound: [],
    estimatedSeconds: seconds,
    executable: false,
    approved: false,
    readyForApproval: problems.length === 0,
  };
}

// A guidance ledger in the shape the learning read produces: approved, active records with a recorded
// shape and the support ids they were derived from. One record states the step order and is the record
// that can move the ordering; the others state a preference, which the ledger also checks against the
// steps. They do not disagree, so the ordering is not withheld - the fixture is measuring the cost of
// an applied decision, not a conflict path.
function guidanceFor({ candidates, records, support }) {
  const adaptations = Array.from({ length: records }, (_, i) => ({
    id: `adapt-bench-${String(i).padStart(2, '0')}`,
    capability: i === 0 ? 'memory' : 'memory.list',
    rule: i === 0
      ? 'read the list before writing to it, in this order'
      : 'when a step of this work is available, it should be used',
    supportCount: support + 1,
    guidanceCount: i + 1,
    ruleHash: createHash('sha256').update(`rule-${i}`).digest('hex'),
    support: {
      experienceIds: Array.from({ length: support }, (_, j) => `exp-bench-${i}-${j}`),
      feedbackIds: Array.from({ length: support }, (_, j) => `fb-bench-${i}-${j}`),
    },
    decidedAt: '2026-11-01T00:00:00.000Z',
    decisionState: 'approved',
    active: true,
    conflicts: 0,
    conflictsWith: [],
    guidance: i === 0
      ? { id: `guide-${i}`, order: 'reads_first', avoid: [], prefer: [], maxSteps: null, createdAt: '2026-11-02T00:00:00.000Z', operationId: `op-guide-${i}` }
      : { id: `guide-${i}`, order: null, avoid: [], prefer: ['memory.list'], maxSteps: null, createdAt: '2026-11-02T00:00:00.000Z', operationId: `op-guide-${i}` },
  }));
  return guidanceFrom({ adaptations, candidates, registry });
}

function fixture(spec) {
  const candidates = Array.from({ length: spec.candidates }, (_, i) => {
    const structure = i % 2 === 0 ? 'writes_first' : 'read_then_write';
    // Reads-first approaches are the slower ones, so without the guidance dimension the comparison
    // does not simply put every reads-first candidate first: the fixture has a trade-off for the
    // decision block to describe, which is the shape an applied record is interesting in.
    const seconds = 40 + (i % 5) * 10 + (structure === 'read_then_write' ? 15 : 0);
    return candidateOf(i, structure, seconds);
  });
  const result = { ok: true, candidates, skipped: [], unaddressed: [], assumedFromGoalRequest: [] };
  const goal = { id: 'goal-bench', revision: 1, status: 'active', criteria: [] };
  const guidance = guidanceFor({ candidates, records: spec.records, support: spec.support });
  return { args: { result, goal, registry, guidance }, guidance, candidates };
}

function stripDecision(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === 'adaptationDecision' ? undefined : v)));
}

function firstDifference(a, b) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return null;
  let i = 0;
  while (i < ja.length && i < jb.length && ja[i] === jb[i]) i += 1;
  return { at: i, before: ja.slice(Math.max(0, i - 80), i + 120), after: jb.slice(Math.max(0, i - 80), i + 120) };
}

function materializeBefore(ref) {
  const dir = tempDir('before');
  try {
    // `tar` is run with the temp directory as its working directory: a Windows path in `-C` is mangled
    // by the MSYS tar on this platform, while `cwd` is passed by the OS and survives intact.
    execSync(`git -C "${REPO_ROOT}" archive ${ref} apex_app/src | tar -x`, { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    return { dir, error: String(err?.stderr ?? err?.message ?? err).slice(0, 300) };
  }
  const file = path.join(dir, 'apex_app', 'src', 'plans', 'evaluation.js');
  if (!fs.existsSync(file)) return { dir, error: `the archive held no ${file}` };
  return { dir, file };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1] : (process.argv.includes(`--${name}`) ? true : fallback);
}

const repeats = Math.min(Math.max(1, Number(arg('repeats', 9)) || 9), MAX_REPEATS);
const keep = arg('keep', false) === true;
const beforeRef = String(arg('before-ref', DEFAULT_BEFORE_REF));
const wanted = String(arg('sizes', 'S,M,L')).split(',').map((s) => s.trim().toUpperCase()).filter((s) => SIZES[s]);

try {
  const before = materializeBefore(beforeRef);
  if (before.error) {
    console.log(`No pre-change module could be materialized from ${beforeRef}: ${before.error}`);
    console.log('The after-only columns cannot be interpreted as a before/after, so this run stops here.');
    process.exitCode = 1;
  } else {
    const beforeModule = await import(pathToFileURL(before.file).href);
    console.log(`pre-change module: ${path.relative(REPO_ROOT, before.file)} at ${beforeRef.slice(0, 12)}`);
    console.log(`current module:    apex_app/src/plans/evaluation.js (working tree)`);
    console.log(`repeats: ${repeats} per size, before and after interleaved per sample\n`);

    for (const size of wanted) {
      const spec = SIZES[size];
      const f = fixture(spec);
      const built = timed(() => f.args, 1);
      console.log(`### size ${size}  fixture: ${spec.candidates} candidates, ${spec.records} approved guidance record(s), `
        + `${spec.support} support id(s) per kind`);
      console.log(`  guidance applied ${f.guidance.influencesSelection ? 'yes' : 'no'}; `
        + `applicable record(s) ${f.guidance.applicable.length}; `
        + `applicable fields checked per candidate ${f.guidance.applicable.length * 4}`);

      // Both modules are warmed before any sample: the first call to either pays JIT compilation for
      // the whole comparison, which would otherwise land on whichever build ran first.
      for (let i = 0; i < 20; i += 1) { beforeModule.evaluateCandidates(f.args); evaluateCandidates(f.args); }

      // Interleaved so the machine's drift between the two builds is shared rather than assigned.
      const beforeTimes = [];
      const afterTimes = [];
      let beforeFirst = null;
      let afterFirst = null;
      for (let i = 0; i < repeats; i += 1) {
        let started = performance.now();
        const b = beforeModule.evaluateCandidates(f.args);
        beforeTimes.push(performance.now() - started);
        if (i === 0) beforeFirst = b;
        started = performance.now();
        const a = evaluateCandidates(f.args);
        afterTimes.push(performance.now() - started);
        if (i === 0) afterFirst = a;
      }
      const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const beforeMedian = median(beforeTimes);
      const afterMedian = median(afterTimes);
      const beforeT = { median: beforeMedian, min: Math.min(...beforeTimes), all: beforeTimes };
      const afterT = { median: afterMedian, min: Math.min(...afterTimes), all: afterTimes };
      const added = { median: afterMedian - beforeMedian, min: Math.min(...afterTimes) - Math.min(...beforeTimes), all: [] };

      const decision = afterFirst.adaptationDecision;
      console.log(`  candidates that passed every gate ${afterFirst.included.length}; `
        + `front without the record ${JSON.stringify(decision.before.front)}; with it ${JSON.stringify(decision.after.front)}`);
      console.log(`  decision outcome ${decision.outcome}; changed ${decision.changed}; `
        + `rules ${decision.rules.length}; evidence ${decision.evidence.experienceIds.length}+${decision.evidence.feedbackIds.length}; `
        + `records considered ${decision.considered.length}`);
      console.log(line('candidate evaluation before (pre-AP)', beforeT));
      console.log(line('candidate evaluation after (AP-01)', afterT));
      console.log(`  ${pad('added by the decision disclosure', 46)} ${pad(ms(added.median), 12)}`
        + ` (${beforeMedian === 0 ? 'n/a' : `${((added.median / beforeMedian) * 100).toFixed(1)}% of the pre-AP median`})`);

      const render = timed(() => renderAdaptationDecision(afterFirst.adaptationDecision), repeats);
      console.log(line('decision disclosure render (after)', render));

      const diff = firstDifference(stripDecision(afterFirst), beforeFirst);
      console.log(`  the two evaluations agree on every field except adaptationDecision: ${diff ? 'NO' : 'yes'}`);
      if (diff) {
        console.log(`    first difference at character ${diff.at}`);
        console.log(`    before: ${diff.before}`);
        console.log(`    after:  ${diff.after}`);
      }
      if (built.first !== f.args) console.log('  (fixture construction is not timed; this line is never reached)');
      console.log('');
    }
  }
} finally {
  cleanup(keep);
}
