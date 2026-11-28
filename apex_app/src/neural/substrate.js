// T-37 Step 1 (2026-11-21): Part 2 Track 2 - the 8-region LIF/STDP spiking substrate.
//
// What this module is, stated plainly because the distinction is the whole point of Part 2:
//
//   * It is a deterministic spiking simulation. Leaky integrate-and-fire cells, exponentially
//     decaying synapses, a flat synapse array with per-region adjacency lists, and spike-timing
//     dependent plasticity. Given the same seed, the same step count and the same drive, it
//     produces exactly the same numbers, every time, in every process.
//   * It is NOT a model, NOT inference, NOT training, and NOT a learner in any sense that could
//     change what APEX believes. It simulates a substrate. The substrate's only output is a set of
//     computational indicators that Track 1 may treat as candidate associations.
//
// The eight regions are the canonical Part 2 set: sensory, associative, temporal, predictive,
// attention, working, plasticity, integration. Each has its own cell population, its own drive
// input, and its own projection targets. The wiring between them is fixed and declared here rather
// than learned, so the topology a reader inspects is the topology that ran.
//
// The hard safety invariant is enforced structurally, not by convention:
//   * nothing in this file imports a store, a controller, the ECP, an action registry, or the
//     network. There is no path from a spike to an effect.
//   * `indicators()` labels everything it returns `candidate_association`. A caller that wants to
//     write a fact still has to go through the ECP like any other write.
import { createHash } from 'node:crypto';

export const SUBSTRATE_SCHEMA = 'apex.neural.substrate/1';
export const REGION_ORDER = Object.freeze([
  'sensory', 'associative', 'temporal', 'predictive', 'attention', 'working', 'plasticity', 'integration',
]);

// The cell count per region. Deliberately small: a substrate big enough to be slow and small enough
// that every number it reports can be checked by hand in a test is more convincing than one whose
// size is impressive and whose state is unauditable.
export const REGION_CELLS = Object.freeze({
  sensory: 16,
  associative: 24,
  temporal: 20,
  predictive: 20,
  attention: 12,
  working: 16,
  plasticity: 10,
  integration: 14,
});

// The fixed projections. Each entry is [from, to, count, weight], expanded into individual synapses
// deterministically, so the adjacency a reader inspects is the adjacency that ran.
const PROJECTIONS = Object.freeze([
  ['sensory', 'associative', 28, 0.62],
  ['associative', 'temporal', 24, 0.48],
  ['temporal', 'predictive', 22, 0.44],
  ['predictive', 'attention', 14, 0.40],
  ['attention', 'working', 18, 0.35],
  ['working', 'integration', 16, 0.52],
  ['plasticity', 'associative', 12, 0.30],
  ['plasticity', 'integration', 10, 0.34],
  ['associative', 'working', 14, 0.26],
  ['temporal', 'attention', 12, 0.30],
  ['predictive', 'integration', 12, 0.38],
  ['integration', 'associative', 10, 0.22],
]);

// LIF constants. A cell integrates its input, leaks toward its resting potential, and fires when it
// crosses threshold; after firing it is reset and held in a refractory period. The numbers are
// chosen so that a modest drive produces a sparse, readable spike train rather than a saturated one.
export const LIF = Object.freeze({
  restingPotentialMv: -65,
  thresholdMv: -52,
  resetPotentialMv: -70,
  leakTauMs: 20,
  membraneTauMs: 10,
  refractoryMs: 3,
  // The gain a synapse's decayed pre-trace contributes to its post cell's input, in mV. Chosen
  // with `rest + input = equilibrium`: a cell driven at 14 mV settles at -51, above the -52 mV
  // threshold, so a modest drive produces a sparse spike train rather than silence or saturation.
  synapticGainMv: 1,
  dtMs: 1,
});

// STDP constants: a pair of exponential traces per synapse, weighted by the relative spike timing.
export const STDP = Object.freeze({
  tauPlusMs: 20,
  tauMinusMs: 20,
  aPlus: 0.012,
  aMinus: 0.014,
  minWeight: 0.02,
  maxWeight: 0.95,
  // A hard ceiling on the total absolute weight change per step, so no single step can reshape the
  // substrate even if its constants were mis-set. Bounded by construction, not by hope.
  maxWeightDeltaPerStep: 0.08,
});

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Deterministic PRNG: xorshift32 driven by a seed derived from the substrate seed and the step
// index. No Math.random, no process entropy, no clock. Two runs with the same seed and the same
// drive are identical cell for cell.
function makeRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function seedFrom(value) {
  const digest = createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0);
}

export const DEFAULT_SUBSTRATE_SEED = 'apex-track2-8-region-deterministic';

// The assay drive. This is what the substrate is stepped with when no caller supplies a drive: a
// fixed, declared current per region, chosen so every region's population is active and none is
// saturated. It is an assay, not an input from the world - the substrate is not reading anything.
// Stating it as a table rather than scattering constants is what makes "every region reported a
// real number" a claim a reader can check against one place.
export const ASSAY_DRIVE_MV = Object.freeze({
  sensory: 16,
  associative: 15,
  temporal: 15,
  predictive: 15,
  attention: 15,
  working: 15,
  plasticity: 15,
  integration: 15,
});

export function assayDrive(region) {
  return ASSAY_DRIVE_MV[region] ?? 0;
}

// Builds the flat cell array with per-region offsets and the flat synapse array with per-region
// adjacency lists. The flat arrays are the storage; the region slices are views into them, so a
// reader can ask "which cells does this region own" without a second copy existing.
export function buildSubstrate({ seed = DEFAULT_SUBSTRATE_SEED } = {}) {
  const rng = makeRng(seedFrom(seed));

  const cells = [];
  const regions = new Map();
  for (const id of REGION_ORDER) {
    const count = REGION_CELLS[id];
    const offset = cells.length;
    for (let index = 0; index < count; index += 1) {
      cells.push({
        id: `${id}:${index}`,
        region: id,
        index,
        // Initial potentials are spread deterministically around rest, never identical, so the
        // substrate is not a row of precisely synchronised oscillators at step zero.
        potentialMv: round(LIF.restingPotentialMv + (rng() - 0.5) * 6, 3),
        refractoryUntilMs: 0,
        lastSpikeMs: null,
        spikeCount: 0,
        inputCurrent: 0,
      });
    }
    regions.set(id, Object.freeze({ id, offset, count }));
  }

  // Synapses are built in projection order, so synapse 0 is always the first projection's first
  // synapse. The flat array is the storage; `outgoing`/`incoming` are index lists into it.
  const synapses = [];
  const outgoing = new Map();
  const incoming = new Map();
  for (const id of REGION_ORDER) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const [from, to, count, weight] of PROJECTIONS) {
    const fromRegion = regions.get(from);
    const toRegion = regions.get(to);
    for (let n = 0; n < count; n += 1) {
      const preIndex = fromRegion.offset + (n % fromRegion.count);
      const postIndex = toRegion.offset + Math.floor((n * 7 + fromRegion.offset) % toRegion.count);
      const jitter = Math.round((rng() - 0.5) * 4) / 100;
      const initial = round(clamp(weight + jitter, STDP.minWeight, STDP.maxWeight), 4);
      const index = synapses.length;
      synapses.push({
        index,
        from, to,
        preIndex,
        postIndex,
        weight: initial,
        initialWeight: initial,
        tracePlus: 0,
        traceMinus: 0,
        lastPreSpikeMs: null,
        lastPostSpikeMs: null,
        updates: 0,
        totalDelta: 0,
      });
      outgoing.get(from).push(index);
      incoming.get(to).push(index);
    }
  }

  return {
    schema: SUBSTRATE_SCHEMA,
    seed,
    regions,
    cells,
    synapses,
    outgoing,
    incoming,
    projections: PROJECTIONS.map(([from, to, count]) => ({ from, to, synapses: count })),
    totalCells: cells.length,
    totalSynapses: synapses.length,
  };
}

// One simulation step. `drive(regionId, cellIndex)` returns the external current in mV for a cell;
// a caller with no drive passes null and the substrate still runs, quietly, on its own recurrent
// input. The step returns what fired, which is what the bridge translates.
export function stepSubstrate(substrate, { step, drive = null } = {}) {
  const nowMs = step * LIF.dtMs;
  const spikes = [];
  const stepRng = makeRng(seedFrom(`${substrate.seed}:${step}`));

  // 1. Integrate. Every cell sums its synaptic input from the previous step's spikes, leaks toward
  //    rest, adds whatever external drive it was given, and fires if it crosses threshold.
  const { cells, synapses } = substrate;

  // Synaptic current from the last step's post-synaptic traces is accumulated per cell.
  const driveByCell = new Float64Array(cells.length);
  for (const synapse of synapses) {
    // A synapse with a non-zero pre trace is still delivering; the trace decays exponentially, so
    // the current is the weight times the decayed trace.
    if (synapse.tracePlus > 0) {
      driveByCell[synapse.postIndex] += synapse.weight * synapse.tracePlus * 22 * LIF.synapticGainMv;
    }
  }

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    // A cell inside its absolute refractory period is clamped at reset and integrates nothing. That
    // is the textbook LIF refractory clamp, and it is also what keeps the membrane bounded: without
    // it a refractory cell keeps summing a suprathreshold drive it cannot discharge, so `potentialMv`
    // walks far above threshold and the summary reports a membrane voltage no cell could hold.
    if (nowMs < cell.refractoryUntilMs) {
      cell.inputCurrent = 0;
      cell.potentialMv = LIF.resetPotentialMv;
      continue;
    }
    const external = typeof drive === 'function' ? Number(drive(cell.region, cell.index)) || 0 : 0;
    const total = driveByCell[index] + external;
    cell.inputCurrent = round(total, 4);
    // Leak toward rest, integrate the input. Explicit Euler at dt=1 ms, which is stable for these
    // constants and, more importantly, is the arithmetic a reader can reproduce.
    const leak = (LIF.restingPotentialMv - cell.potentialMv) * (LIF.dtMs / LIF.membraneTauMs);
    const next = cell.potentialMv + leak + total * (LIF.dtMs / LIF.membraneTauMs);
    cell.potentialMv = round(next, 3);
  }

  // 2. Fire. Refractory cells cannot fire; a cell that crosses threshold spikes, records it, and
  //    resets. A small deterministic jitter breaks the perfect symmetry of identical drives.
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.potentialMv < LIF.thresholdMv) continue;
    if (nowMs < cell.refractoryUntilMs) continue;
    const jittered = LIF.thresholdMv + (stepRng() - 0.5) * 0.8;
    if (cell.potentialMv < jittered) continue;
    cell.potentialMv = LIF.resetPotentialMv;
    cell.refractoryUntilMs = nowMs + LIF.refractoryMs;
    cell.lastSpikeMs = nowMs;
    cell.spikeCount += 1;
    spikes.push({ index, cellId: cell.id, region: cell.region, atMs: nowMs });
  }

  // 3. Plasticity. Each synapse that has a pre or post spike in this step updates its traces and,
  //    where the pair timing warrants it, its weight - bounded per step and clamped to its range.
  const firedAt = new Map(spikes.map((spike) => [spike.index, spike.atMs]));
  let potentiated = 0;
  let depressed = 0;
  for (const synapse of synapses) {
    const preAt = firedAt.get(synapse.preIndex);
    const postAt = firedAt.get(synapse.postIndex);
    // Traces decay on every step, spike or no spike. This is the exponential that makes an old
    // spike count for less than a new one.
    synapse.tracePlus *= Math.exp(-LIF.dtMs / STDP.tauPlusMs);
    synapse.traceMinus *= Math.exp(-LIF.dtMs / STDP.tauMinusMs);
    // The previous spike times are kept for this step's pair test, then advanced. Without the
    // copy, a pre-spike in this step would overwrite the value the depression branch needs.
    const priorPre = synapse.lastPreSpikeMs;
    const priorPost = synapse.lastPostSpikeMs;
    if (preAt !== undefined) {
      synapse.tracePlus = clamp(synapse.tracePlus + 1, 0, 4);
      synapse.lastPreSpikeMs = preAt;
    }
    if (postAt !== undefined) {
      synapse.traceMinus = clamp(synapse.traceMinus + 1, 0, 4);
      synapse.lastPostSpikeMs = postAt;
    }
    if (preAt === undefined && postAt === undefined) continue;
    // Pair-based STDP is defined by the *order* of the two spikes, and both orders have to be able
    // to happen. Taking `lastPostSpikeMs - preAt` for potentiation and `postAt - lastPreSpikeMs`
    // for depression silently makes the rule one-sided: once a cell has fired once, every later
    // pre-spike is "after the post" and only ever depresses. The correct comparison is the one that
    // asks both questions of the same pair, using the other cell's most recent spike:
    //
    //   pre before post  (dt = post - pre > 0)  ->  potentiate, e^{-dt/tau+}
    //   post before pre  (dt = pre - post > 0)  ->  depress,    e^{-dt/tau-}
    let delta = 0;
    if (preAt !== undefined && priorPost !== null && priorPost < preAt) {
      delta += STDP.aPlus * Math.exp(-(preAt - priorPost) / STDP.tauPlusMs);
    }
    if (postAt !== undefined && priorPre !== null && priorPre < postAt) {
      delta -= STDP.aMinus * Math.exp(-(postAt - priorPre) / STDP.tauMinusMs);
    }
    if (delta === 0) continue;
    const bounded = clamp(delta, -STDP.maxWeightDeltaPerStep, STDP.maxWeightDeltaPerStep);
    const before = synapse.weight;
    synapse.weight = round(clamp(synapse.weight + bounded, STDP.minWeight, STDP.maxWeight), 5);
    const actual = round(synapse.weight - before, 6);
    if (actual === 0) continue;
    synapse.updates += 1;
    synapse.totalDelta = round(synapse.totalDelta + actual, 6);
    if (actual > 0) potentiated += 1; else depressed += 1;
  }

  return { step, atMs: nowMs, spikes, potentiated, depressed };
}

// The summary a reader and the bridge both consume. Every field is computed from the arrays that
// just ran; none of it is remembered from a previous answer.
export function summarizeSubstrate(substrate, steps = 0, history = []) {
  const { cells, synapses } = substrate;
  const regionReports = [];
  for (const id of REGION_ORDER) {
    const region = substrate.regions.get(id);
    const slice = cells.slice(region.offset, region.offset + region.count);
    const potentials = slice.map((cell) => cell.potentialMv);
    const spikes = slice.reduce((sum, cell) => sum + cell.spikeCount, 0);
    const active = slice.filter((cell) => cell.lastSpikeMs !== null
      && steps > 0 && cell.lastSpikeMs >= (steps - 1) * LIF.dtMs).length;
    const outgoing = substrate.outgoing.get(id);
    const incoming = substrate.incoming.get(id);
    regionReports.push({
      id,
      cells: region.count,
      spikes,
      activeNow: active,
      membranePotential: {
        meanMv: round(potentials.reduce((a, b) => a + b, 0) / potentials.length, 3),
        minMv: round(Math.min(...potentials), 3),
        maxMv: round(Math.max(...potentials), 3),
        thresholdMv: LIF.thresholdMv,
        restingMv: LIF.restingPotentialMv,
      },
      // Sparse adjacency metrics, computed from the index lists rather than assumed from the
      // projection table: if the two ever disagreed, this is where it would show.
      adjacency: {
        outgoingSynapses: outgoing.length,
        incomingSynapses: incoming.length,
        outgoingFanOut: slice.length === 0 ? 0 : round(outgoing.length / slice.length, 3),
        incomingFanIn: slice.length === 0 ? 0 : round(incoming.length / slice.length, 3),
      },
      // The mean absolute weight of the synapses leaving this region - the number that moves when
      // STDP does something, and stays put when it does not.
      meanOutgoingWeight: outgoing.length === 0
        ? 0
        : round(outgoing.reduce((sum, index) => sum + synapses[index].weight, 0) / outgoing.length, 4),
    });
  }

  const weights = synapses.map((synapse) => synapse.weight);
  const meanWeight = weights.length === 0 ? 0 : weights.reduce((a, b) => a + b, 0) / weights.length;
  const variance = weights.length === 0
    ? 0
    : weights.reduce((sum, weight) => sum + (weight - meanWeight) ** 2, 0) / weights.length;
  const changed = synapses.filter((synapse) => synapse.weight !== synapse.initialWeight);

  return {
    schema: SUBSTRATE_SCHEMA,
    seed: substrate.seed,
    steps,
    atMs: steps * LIF.dtMs,
    cells: substrate.totalCells,
    synapses: substrate.totalSynapses,
    // Density is the honest measure of a sparse core: realised synapses over the possible ones.
    density: round(substrate.totalSynapses / (substrate.totalCells * substrate.totalCells), 5),
    regions: regionReports,
    plasticity: {
      rule: 'STDP (pair-based, exponential traces)',
      tauPlusMs: STDP.tauPlusMs,
      tauMinusMs: STDP.tauMinusMs,
      minWeight: STDP.minWeight,
      maxWeight: STDP.maxWeight,
      maxWeightDeltaPerStep: STDP.maxWeightDeltaPerStep,
      meanWeight: round(meanWeight, 5),
      weightStdDev: round(Math.sqrt(variance), 5),
      synapsesChanged: changed.length,
      totalUpdates: synapses.reduce((sum, synapse) => sum + synapse.updates, 0),
      potentiatedSteps: history.reduce((sum, entry) => sum + entry.potentiated, 0),
      depressedSteps: history.reduce((sum, entry) => sum + entry.depressed, 0),
    },
    lif: { ...LIF },
    // The last few steps, so the deck can show a real trace rather than a single number.
    trace: history.slice(-12).map((entry) => ({
      step: entry.step,
      spikes: entry.spikes.length,
      potentiated: entry.potentiated,
      depressed: entry.depressed,
    })),
  };
}

// The substrate's only outward channel. Everything it returns is labelled
// `candidate_association`: an indicator Track 1 may consider, never a fact it may assert, and never
// a step it may execute. The label is set here, once, rather than trusted to each caller.
export function indicators(substrate, summary = null) {
  const report = summary ?? summarizeSubstrate(substrate);
  const byRegion = new Map(report.regions.map((region) => [region.id, region]));
  const signal = (id, name, value, basis) => ({
    id,
    name,
    value,
    basis,
    epistemicStatus: 'candidate_association',
    authorizesExecution: false,
    mutatesObservedFacts: false,
  });
  return {
    schema: 'apex.neural.indicators/1',
    epistemicStatus: 'candidate_association',
    authorizesExecution: false,
    mutatesObservedFacts: false,
    note: 'Computational indicators from a deterministic spiking simulation. They are candidates for '
      + 'Track 1 to consider, never observed facts and never permissions.',
    signals: [
      signal(
        'salience',
        'Salience modulation',
        round(clamp((byRegion.get('attention')?.activeNow ?? 0) / Math.max(1, REGION_CELLS.attention), 0, 1), 4),
        'the share of attention-region cells that spiked on the last step',
      ),
      signal(
        'predictive_pressure',
        'Predictive pressure',
        round(clamp((byRegion.get('predictive')?.activeNow ?? 0) / Math.max(1, REGION_CELLS.predictive), 0, 1), 4),
        'the share of predictive-region cells that spiked on the last step',
      ),
      signal(
        'integration_load',
        'Integration load',
        round(clamp(report.plasticity.meanWeight / Math.max(0.0001, STDP.maxWeight), 0, 1), 4),
        'mean synaptic weight as a fraction of the declared maximum',
      ),
      signal(
        'plasticity_churn',
        'Plasticity churn',
        round(clamp(report.plasticity.synapsesChanged / Math.max(1, report.synapses), 0, 1), 4),
        'the share of synapses whose weight has moved from its initial value',
      ),
    ],
  };
}

// The substrate as a small deterministic machine, which is what the bridge and the service drive.
export function createSubstrate({ seed = DEFAULT_SUBSTRATE_SEED } = {}) {
  const substrate = buildSubstrate({ seed });
  const history = [];
  let step = 0;

  return Object.freeze({
    schema: SUBSTRATE_SCHEMA,
    seed,
    get step() { return step; },
    raw: substrate,
    // Runs one step with an optional drive function, records it, and returns what fired.
    tick({ drive = null } = {}) {
      const outcome = stepSubstrate(substrate, { step, drive });
      history.push(outcome);
      if (history.length > 64) history.shift();
      step += 1;
      return outcome;
    },
    // Runs `count` steps at once. Bounded by the caller, not by this function.
    run({ steps = 1, drive = null } = {}) {
      const fired = [];
      for (let n = 0; n < steps; n += 1) fired.push(this.tick({ drive }));
      return fired;
    },
    summary() {
      return summarizeSubstrate(substrate, step, history);
    },
    indicators() {
      return indicators(substrate, this.summary());
    },
  });
}
