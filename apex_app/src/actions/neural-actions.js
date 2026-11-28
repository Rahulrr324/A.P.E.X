// T-37 Step 1 (2026-11-21): the neural capabilities, registered like every other one.
//
// `neural.step` is a write: it advances a stateful simulation and appends to a ledger. It is
// user-origin only, because a model that could step the substrate would be a model that could
// manufacture its own candidate associations. `neural.read` and `neural.bridge_status` are reads.
//
// The names and the boundary they declare are the whole safety story: nothing here can name another
// capability, and nothing here can execute one.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, singleLine } from '../util.js';
import { ORIGIN_USER, ORIGIN_MODEL } from './origins.js';
import { MAX_STEPS_PER_CALL, createNeuralService } from '../neural/service.js';

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function optionalReason(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('reason must be text');
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 240) throw new ValidationError('reason exceeds 240 characters');
  if (CONTROL_CHARS.test(trimmed)) throw new ValidationError('reason contains control characters');
  return trimmed;
}

export function neuralActions(neuralService) {
  return [
    {
      name: 'neural.step',
      description: 'Advance the deterministic 8-region LIF/STDP spiking substrate by a bounded number of steps and carry its indicators across the neural-cognitive bridge. Track 2 produces candidate associations only; it authorizes nothing and writes no observed fact.',
      inputHint: '{"steps": 1-64, "crossBridge": true, "reason": "text"}',
      permission: 'write',
      // Only the owner may step the substrate. A model origin that could step it could manufacture
      // the candidate associations it is then asked to consider.
      origins: [ORIGIN_USER],
      // A simulation step is not a world effect, so it is not offered to a plan as a step. Making it
      // plannable would record "the substrate advanced" as if it were an executed action.
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['steps', 'crossBridge', 'reason']);
        let steps = 1;
        if (o.steps !== undefined) {
          if (!Number.isInteger(o.steps) || o.steps < 1 || o.steps > MAX_STEPS_PER_CALL) {
            throw new ValidationError(`steps must be an integer from 1 to ${MAX_STEPS_PER_CALL}`);
          }
          steps = o.steps;
        }
        return {
          steps,
          crossBridge: o.crossBridge !== false,
          reason: optionalReason(o.reason),
        };
      },
      async execute(ctx, input) {
        const outcome = ctx.neural.advance({ steps: input.steps, crossBridge: input.crossBridge });
        const bridge = ctx.neural.bridgeState();
        const report = ctx.neural.report();
        return {
          summary: `substrate advanced ${outcome.record.steps} step(s); ${outcome.record.spikes} spike(s), `
            + `${outcome.record.potentiated} potentiated / ${outcome.record.depressed} depressed, bridge ${bridge.status}`,
          data: {
            schema: 'apex.neural.step-result/1',
            at: outcome.record.at,
            steps: outcome.record.steps,
            step: outcome.record.step,
            spikes: outcome.record.spikes,
            potentiated: outcome.record.potentiated,
            depressed: outcome.record.depressed,
            digest: outcome.record.digest,
            crossed: outcome.record.crossed,
            bridge: {
              status: bridge.status,
              bridgeVersion: bridge.bridgeVersion,
              crossings: bridge.crossings,
              refusals: bridge.refusals,
              lastRefusal: bridge.lastRefusal,
            },
            indicators: outcome.candidate,
            // The boundary, restated on every result so no reader has to remember it.
            epistemicStatus: 'candidate_association',
            authorizesExecution: false,
            mutatesObservedFacts: false,
            regionSpikes: report.substrate.regions.map((region) => ({ id: region.id, spikes: region.spikes, activeNow: region.activeNow })),
          },
          display: [
            `Substrate step ${outcome.record.step} (${outcome.record.steps} advance(s))`,
            `Spikes: ${outcome.record.spikes} · potentiated ${outcome.record.potentiated} · depressed ${outcome.record.depressed}`,
            `Bridge: ${bridge.status} (${bridge.bridgeVersion})`,
            `Signals are candidate associations; nothing was authorized.`,
          ].join('\n'),
        };
      },
      async verify(ctx, _input, result) {
        // The claim is determinism, so the check is a replay: rebuild from the seed, step to the
        // recorded count, and require the summary digest to match.
        const replay = ctx.neural.verify();
        if (!replay.ok) return { ok: false, detail: replay.detail };
        const report = ctx.neural.report();
        if (report.substrate.step !== result.data.step) {
          return { ok: false, detail: `the step counter moved to ${report.substrate.step} after the recorded ${result.data.step}` };
        }
        if (report.indicators.epistemicStatus !== 'candidate_association') {
          return { ok: false, detail: 'the indicators did not carry the candidate_association label' };
        }
        return { ok: true, detail: replay.detail };
      },
    },
    {
      name: 'neural.read',
      description: 'Read the 8-region spiking substrate state, its STDP plasticity counters, and the neural-cognitive bridge contract. Read-only; advances nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        return expectObject(input ?? {}, []);
      },
      async execute(ctx) {
        const report = ctx.neural.report();
        return {
          summary: `${report.substrate.totals.cells} cells across ${report.substrate.regions.length} region(s) at step ${report.substrate.step}; bridge ${report.bridge.status}`,
          data: report,
          display: [
            `Neural substrate ${report.substrate.schema}`,
            `Seed: ${report.substrate.seed} · step ${report.substrate.step}`,
            `Cells ${report.substrate.totals.cells} · synapses ${report.substrate.totals.synapses} · density ${report.substrate.totals.density}`,
            ...report.substrate.regions.map((region) => `  ${region.id.padEnd(12)} ${String(region.cells).padStart(3)} cells · ${String(region.spikes).padStart(4)} spikes · mean weight ${region.meanOutgoingWeight}`),
            `Bridge: ${report.bridge.status} (${report.bridge.bridgeVersion})`,
            'Every signal is a candidate association. Nothing here authorizes an action.',
          ].join('\n'),
        };
      },
      async verify(ctx, _input, result) {
        const fresh = ctx.neural.report();
        if (fresh.substrate.totals.cells !== result.data.substrate.totals.cells) {
          return { ok: false, detail: 'the cell count differs from an independent read' };
        }
        if (fresh.substrate.regions.length !== 8) {
          return { ok: false, detail: `expected 8 regions, an independent read found ${fresh.substrate.regions.length}` };
        }
        if (fresh.bridge.bridgeVersion !== result.data.bridge.bridgeVersion) {
          return { ok: false, detail: 'the bridge version differs from an independent read' };
        }
        return { ok: true, detail: 'the substrate report was confirmed against an independent read' };
      },
    },
    {
      name: 'neural.bridge_reset',
      description: 'Close the circuit breaker on the neural-cognitive bridge after it isolated itself, returning it to connected. User-origin only; records the reason.',
      inputHint: '{"reason":"text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['reason']);
        return { reason: optionalReason(o.reason) };
      },
      async execute(ctx, { reason }) {
        const before = ctx.neural.bridgeState();
        const outcome = ctx.neural.resetBridge({ reason });
        const after = ctx.neural.bridgeState();
        return {
          summary: outcome.wasIsolated
            ? `the bridge breaker was reset from isolated to ${after.status}`
            : `the bridge breaker was already ${before.status}; the reset recorded the request`,
          data: {
            schema: 'apex.neural.bridge-reset/1',
            wasIsolated: outcome.wasIsolated,
            reason: outcome.reason,
            before: { status: before.status, consecutiveRefusals: before.consecutiveRefusals },
            after: { status: after.status, consecutiveRefusals: after.consecutiveRefusals },
            bridgeVersion: after.bridgeVersion,
          },
          display: `Bridge ${before.status} -> ${after.status}${outcome.reason ? ` (${outcome.reason})` : ''}`,
        };
      },
      async verify(ctx, _input, result) {
        const fresh = ctx.neural.bridgeState();
        if (fresh.status !== result.data.after.status) {
          return { ok: false, detail: `the bridge reports ${fresh.status}; the result recorded ${result.data.after.status}` };
        }
        return { ok: true, detail: `the bridge is ${fresh.status} on an independent read` };
      },
    },
  ];
}

// The composition-root constructor, so the service is built once and shared by the actions and the
// pipeline exactly as the council and the workshop are.
export function createNeural({ dataDir, now, seed } = {}) {
  return createNeuralService({ dataDir, now, seed });
}
