// T-37 Step 1 (2026-11-21): the neural service - Track 2's one stateful owner.
//
// The substrate is a pure simulation and the bridge is a pure translator. Neither remembers anything
// between calls. This service is what holds them: one substrate per data directory, stepped by an
// explicit governed act, with the bridge's crossings and the step counter recorded so a reader can
// see what actually ran rather than what was configured.
//
// Two things it deliberately does NOT do:
//   * It does not step on a timer. There is no background loop, no interval, and no auto-tick. A step
//     happens when someone asks for one, through `neural.step` and the ECP, or as a stage of a
//     governed pipeline run. A substrate that ticked on its own would be a process whose state
//     changed while nobody was looking.
//   * It does not read the stores. It takes the substrate's own indicators and, if asked, feeds them
//     across the bridge. It cannot see the world model, and therefore cannot write to it.
//
// The persisted file is an append-only ledger of steps and crossings, so the numbers a deck shows
// after a restart are the numbers that were recorded, not recomputed from a seed and hoped for.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_SUBSTRATE_SEED, LIF, REGION_ORDER, SUBSTRATE_SCHEMA, STDP,
  assayDrive, buildSubstrate, stepSubstrate, summarizeSubstrate, indicators as indicatorsOf,
} from './substrate.js';
import { BRIDGE_VERSION, bridgeContract, createNeuralCognitiveBridge } from './bridge.js';

export const NEURAL_SERVICE_SCHEMA = 'apex.neural.service/1';
export const NEURAL_LEDGER_DIR = 'neural';
export const NEURAL_LEDGER_FILE = 'substrate.jsonl';
export const MAX_STEPS_PER_CALL = 64;

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], skipped: 0 };
    throw error;
  }
  const entries = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A damaged line is counted and skipped, never guessed at. The service reports the count so a
      // reader knows the ledger is incomplete rather than silently short.
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export function createNeuralService({ dataDir, now = () => new Date(), seed = DEFAULT_SUBSTRATE_SEED } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('the neural service needs a data directory');
  }
  const directory = path.join(dataDir, NEURAL_LEDGER_DIR);
  const ledgerPath = path.join(directory, NEURAL_LEDGER_FILE);
  // The directory is created on the first write, not here. Constructing the service must not touch
  // the filesystem: a read-only command builds the whole application, and a command that only reads
  // may not leave a new directory behind - that is the difference between an inspection and a change.
  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  // The substrate is rebuilt from its seed at construction. Because the simulation is deterministic,
  // replaying the recorded step count reproduces the recorded state exactly; `verify()` asserts that
  // rather than trusting it.
  const substrate = buildSubstrate({ seed });
  const history = [];
  let step = 0;
  let stepCount = 0;
  let lastStepAt = null;
  let skippedLines = 0;

  const bridge = createNeuralCognitiveBridge({ enabled: true });

  // The single place a step happens, so every step goes through the same accounting. The drive is
  // the declared assay current unless a caller supplies one; the substrate never reads the world,
  // so "no drive" and "assay drive" are the only two things it can be asked for.
  function tick({ drive = assayDrive } = {}) {
    const outcome = stepSubstrate(substrate, { step, drive });
    history.push({ step, spikes: outcome.spikes.length, potentiated: outcome.potentiated, depressed: outcome.depressed });
    if (history.length > 64) history.shift();
    step += 1;
    stepCount += 1;
    lastStepAt = now().toISOString();
    return outcome;
  }

  function appendLedger(entry) {
    try {
      ensureDirectory();
      fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- the public acts --------------------------------------------------------------------

  // Advance the substrate and, when asked, cross the bridge with what it produced. This is what
  // `neural.step` executes, and what the pipeline calls.
  function advance({ steps = 1, crossBridge = true } = {}) {
    // The bound is refused here as well as in the capability's validator. A clamp would let a caller
    // that asked for 500 steps believe it got 500, and the ledger would record a number it did not run.
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS_PER_CALL) {
      throw new RangeError(`steps must be an integer from 1 to ${MAX_STEPS_PER_CALL}`);
    }
    const fired = [];
    for (let n = 0; n < steps; n += 1) fired.push(tick({}));
    const summary = summarizeSubstrate(substrate, step, history);
    const candidate = indicatorsOf(substrate, summary);
    let crossing = null;
    if (crossBridge) {
      crossing = bridge.translate(candidate);
      appendLedger({
        type: 'crossing',
        at: now().toISOString(),
        step,
        crossed: crossing.crossed === true,
        digest: crossing.crossed === true ? crossing.signal.digest : null,
        refusal: crossing.crossed === true ? null : crossing.refusal?.refusal ?? null,
        signals: crossing.crossed === true ? crossing.signal.signals.length : 0,
        bridgeStatus: crossing.status,
      });
    }
    const record = {
      type: 'step',
      at: now().toISOString(),
      steps,
      step,
      spikes: fired.reduce((sum, entry) => sum + entry.spikes.length, 0),
      potentiated: fired.reduce((sum, entry) => sum + entry.potentiated, 0),
      depressed: fired.reduce((sum, entry) => sum + entry.depressed, 0),
      digest: digestOf({ step, spikes: fired.map((entry) => entry.spikes.length) }),
      crossed: crossing?.crossed === true,
      total: stepCount,
    };
    appendLedger(record);
    return { record, summary, candidate, crossing, fired };
  }

  // Rebuilds the substrate from its seed and steps it to the recorded count, then compares the
  // summary digest. A determinism claim that is never checked is a slogan.
  function verify() {
    const recorded = digestOf(liveSummary());
    const replay = buildSubstrate({ seed });
    for (let n = 0; n < step; n += 1) stepSubstrate(replay, { step: n, drive: assayDrive });
    const replayed = digestOf(summarizeSubstrate(replay, step, history));
    return {
      ok: recorded === replayed,
      step,
      recordedDigest: recorded,
      replayedDigest: replayed,
      detail: recorded === replayed
        ? `replayed ${step} step(s) from seed "${seed}" and reproduced the live summary digest`
        : `replaying ${step} step(s) from seed "${seed}" produced a different summary digest`,
    };
  }

  function liveSummary() {
    return summarizeSubstrate(substrate, step, history);
  }

  // The full report the deck and the routes read. Every number comes from the arrays that ran.
  function report() {
    const summary = liveSummary();
    const candidate = indicatorsOf(substrate, summary);
    const ledger = readLedger(ledgerPath);
    return {
      schema: NEURAL_SERVICE_SCHEMA,
      substrate: {
        schema: SUBSTRATE_SCHEMA,
        seed,
        step,
        totals: { cells: summary.cells, synapses: summary.synapses, density: summary.density },
        regions: summary.regions,
        regionOrder: [...REGION_ORDER],
        lif: { ...LIF },
        stdp: { ...STDP },
        plasticity: summary.plasticity,
        trace: summary.trace,
      },
      indicators: candidate,
      bridge: {
        ...bridge.state(),
        // Stated on every read: what Track 1 sees when the bridge is not crossing.
        isolationFallback: 'Track 1 continues on symbolic evidence alone.',
      },
      ledger: {
        path: ledgerPath,
        entries: ledger.entries.length,
        skippedLines: ledger.skipped + skippedLines,
        lastAt: ledger.entries.at(-1)?.at ?? null,
      },
      // The hard invariant, restated where a reader of the report will see it.
      boundary: {
        epistemicStatus: 'candidate_association',
        authorizesExecution: false,
        mutatesObservedFacts: false,
        note: 'Track 2 produces candidate associations. It cannot authorize, execute, or write an observed fact.',
      },
      at: now().toISOString(),
    };
  }

  return Object.freeze({
    schema: NEURAL_SERVICE_SCHEMA,
    dataDir,
    ledgerPath,
    seed,
    get step() { return step; },
    advance,
    verify,
    report,
    // Read-only views, so a caller (the pipeline, the deck) never reaches into the substrate.
    indicators() { return indicatorsOf(substrate, liveSummary()); },
    summary() { return liveSummary(); },
    bridgeStatus() { return bridge.status(); },
    bridgeState() { return bridge.state(); },
    resetBridge(options) { return bridge.reset(options); },
    contract: bridgeContract,
    bridgeVersion: BRIDGE_VERSION,
  });
}

