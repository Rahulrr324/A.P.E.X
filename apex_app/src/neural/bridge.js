// T-37 Step 1 (2026-11-21): the Versioned Neural-Cognitive Bridge.
//
// Track 2 (the spiking substrate) and Track 1 (the symbolic cognitive pipeline) speak different
// languages on purpose. This module is the only place they meet, and it is a translator with a
// contract, not a channel with a permission.
//
// The contract, stated as plainly as it can be:
//
//   1. Everything crossing from Track 2 to Track 1 carries `epistemicStatus: 'candidate_association'`.
//      It is a candidate for Track 1 to consider. It is never an `observed` fact, and nothing here
//      can write one.
//   2. Nothing crossing the bridge can authorize, execute, or bypass the ECP. There is no field on
//      the wire that names a permission, and an incoming message that claims one is refused whole.
//   3. The bridge is versioned, and a message whose version it does not understand is refused rather
//      than guessed at. A refusal is not a failure of APEX: the circuit breaker opens, the bridge
//      reports `isolated`, and Track 1 keeps running on symbols alone.
//
// That third point is what makes this safe to wire into a live pipeline. A bridge that could only
// succeed would be a single point of failure for the whole cognitive path. This one fails closed and
// then gets out of the way, and the pipeline's behaviour is identical either way - it just has fewer
// candidate associations to consider.
import { createHash } from 'node:crypto';

export const BRIDGE_VERSION = 'apex.neural.cognitive-bridge/1';
export const BRIDGE_SUPPORTED_VERSIONS = Object.freeze([BRIDGE_VERSION]);
export const SIGNAL_SCHEMA = 'apex.neural.bridge-signal/1';
// The shape the substrate's own indicator block uses. A producer that emits this is making no claim
// about the bridge; the bridge is what stamps a crossing with SIGNAL_SCHEMA on the way through.
export const INDICATOR_INPUT_SCHEMA = 'apex.neural.indicators/1';
export const ACCEPTED_INPUT_SCHEMAS = Object.freeze([SIGNAL_SCHEMA, INDICATOR_INPUT_SCHEMA]);

// The only statuses the bridge can be in. `connected` means the last translation validated;
// `isolated` means it did not, and Track 1 is running without it. There is no half-connected state,
// because a bridge that is "mostly working" is a bridge nobody can reason about.
export const BRIDGE_STATUS = Object.freeze({
  CONNECTED: 'connected',
  ISOLATED: 'isolated',
  DISABLED: 'disabled',
});

// The failure classes the circuit breaker counts. Each one is a refusal, not a retry.
export const BRIDGE_REFUSAL = Object.freeze({
  VERSION_UNSUPPORTED: 'version_unsupported',
  SCHEMA_INVALID: 'schema_invalid',
  EPISTEMIC_VIOLATION: 'epistemic_violation',
  AUTHORITY_CLAIM: 'authority_claim',
  DISABLED: 'disabled',
});

const MAX_SIGNALS = 32;
const MAX_REASON_CHARS = 240;
// A bridge that refuses this many times in a row stays isolated until it is explicitly reset. The
// number is small because a bridge that keeps failing is not a bridge; it is a source of noise.
export const BREAKER_THRESHOLD = 3;

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// The bridge's declared contract. It is what `GET /api/neural/bridge` returns as `contract`, and it
// is deliberately a value the caller can compare against, not prose.
export function bridgeContract() {
  return {
    bridgeVersion: BRIDGE_VERSION,
    supportedVersions: [...BRIDGE_SUPPORTED_VERSIONS],
    signalSchema: SIGNAL_SCHEMA,
    acceptedInputSchemas: [...ACCEPTED_INPUT_SCHEMAS],
    epistemicBoundary: {
      status: 'candidate_association',
      canWriteObservedFacts: false,
      canAuthorizeActions: false,
      canBypassEcp: false,
      note: 'Every signal crossing this bridge is a candidate association. The ECP remains the only authority.',
    },
    circuitBreaker: {
      threshold: BREAKER_THRESHOLD,
      onOpen: 'isolated',
      fallback: 'Track 1 continues on symbolic evidence alone; no capability is lost, only candidates.',
    },
    isolation: {
      onVersionMismatch: 'refuse and isolate',
      onSchemaFailure: 'refuse and isolate',
      onAuthorityClaim: 'refuse and isolate',
    },
  };
}

// Validates one Track 2 -> Track 1 signal. It returns `{ ok: true, signal }` or
// `{ ok: false, refusal, detail }`; there is no third outcome, and no partial acceptance.
export function validateSignal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: 'a bridge signal must be an object' };
  }
  if (raw.bridgeVersion !== undefined && !BRIDGE_SUPPORTED_VERSIONS.includes(raw.bridgeVersion)) {
    return {
      ok: false,
      refusal: BRIDGE_REFUSAL.VERSION_UNSUPPORTED,
      detail: `bridge version "${String(raw.bridgeVersion).slice(0, 40)}" is not one this build understands (${BRIDGE_VERSION})`,
    };
  }
  if (raw.schema !== undefined && !ACCEPTED_INPUT_SCHEMAS.includes(raw.schema)) {
    return {
      ok: false,
      refusal: BRIDGE_REFUSAL.SCHEMA_INVALID,
      detail: `signal schema "${String(raw.schema).slice(0, 60)}" is not one the bridge accepts (${ACCEPTED_INPUT_SCHEMAS.join(', ')})`,
    };
  }
  // An authority claim is refused whole rather than stripped, because a translator that silently
  // drops a claim has taught its caller that claims are harmless. A producer that explicitly
  // declares it is *not* claiming authority (`false`) is saying the right thing and is allowed to
  // say it - the substrate's own indicator block does exactly that. Anything that tries to carry
  // authority - true, a string, an object, a capability name - is refused.
  for (const field of ['authorizesExecution', 'authorize', 'execute', 'bypassesEcp']) {
    if (raw[field] !== undefined && raw[field] !== false) {
      return {
        ok: false,
        refusal: BRIDGE_REFUSAL.AUTHORITY_CLAIM,
        detail: `a bridge signal may not carry "${field}"; authority belongs to the ECP alone`,
      };
    }
  }
  for (const field of ['permission', 'capability']) {
    if (raw[field] !== undefined) {
      return {
        ok: false,
        refusal: BRIDGE_REFUSAL.AUTHORITY_CLAIM,
        detail: `a bridge signal may not carry "${field}"; authority belongs to the ECP alone`,
      };
    }
  }
  // The epistemic boundary is not advisory. A signal that calls itself an observed fact is refused,
  // not relabelled - relabelling would hide that a producer tried.
  if (raw.mutatesObservedFacts !== undefined && raw.mutatesObservedFacts !== false) {
    return {
      ok: false,
      refusal: BRIDGE_REFUSAL.EPISTEMIC_VIOLATION,
      detail: 'a bridge signal may not claim to mutate observed facts',
    };
  }
  if (raw.epistemicStatus !== undefined && raw.epistemicStatus !== 'candidate_association') {
    return {
      ok: false,
      refusal: BRIDGE_REFUSAL.EPISTEMIC_VIOLATION,
      detail: `a bridge signal must be candidate_association, not "${String(raw.epistemicStatus).slice(0, 40)}"`,
    };
  }
  if (!Array.isArray(raw.signals)) {
    return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: 'a bridge signal must carry a signals array' };
  }
  if (raw.signals.length > MAX_SIGNALS) {
    return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: `at most ${MAX_SIGNALS} signals may cross at once` };
  }
  const signals = [];
  for (const entry of raw.signals) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: 'each signal must be an object' };
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id.length === 0 || id.length > 64) {
      return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: 'each signal needs a 1-64 character id' };
    }
    const value = Number(entry.value);
    if (!Number.isFinite(value)) {
      return { ok: false, refusal: BRIDGE_REFUSAL.SCHEMA_INVALID, detail: `signal "${id}" has a non-finite value` };
    }
    // T-37 Step 1: a signal that names an epistemic status must name *this* one. Relabelling silently
    // would launder a producer's claim that it carries a stored fact into a candidate association, and
    // the producer would never learn that its contract was violated. An omitted status is fine - the
    // bridge sets it below - but a wrong one is refused.
    if (entry.epistemicStatus !== undefined && entry.epistemicStatus !== 'candidate_association') {
      return {
        ok: false,
        refusal: BRIDGE_REFUSAL.EPISTEMIC_VIOLATION,
        detail: `signal "${id}" claims epistemic status "${String(entry.epistemicStatus).slice(0, 40)}"; `
          + 'only candidate_association may cross the bridge',
      };
    }
    // The same reasoning for the two claims: a producer may not hand the bridge a signal that says it
    // authorizes execution or writes an observed fact. Truthy is refused; an explicit false is the
    // producer declaring the boundary, which is what a correct producer does.
    if (entry.authorizesExecution !== undefined && entry.authorizesExecution !== false) {
      return {
        ok: false,
        refusal: BRIDGE_REFUSAL.AUTHORITY_CLAIM,
        detail: `signal "${id}" claims "authorizesExecution"; authority belongs to the ECP alone`,
      };
    }
    if (entry.mutatesObservedFacts !== undefined && entry.mutatesObservedFacts !== false) {
      return {
        ok: false,
        refusal: BRIDGE_REFUSAL.EPISTEMIC_VIOLATION,
        detail: `signal "${id}" claims "mutatesObservedFacts"; Track 2 may not write an observed fact`,
      };
    }
    signals.push({
      id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : id,
      value,
      basis: typeof entry.basis === 'string' ? entry.basis.slice(0, 200) : null,
      // Set here rather than copied from the producer: whatever the producer said, what crosses is
      // a candidate association.
      epistemicStatus: 'candidate_association',
      authorizesExecution: false,
      mutatesObservedFacts: false,
    });
  }
  return {
    ok: true,
    signal: {
      schema: SIGNAL_SCHEMA,
      bridgeVersion: BRIDGE_VERSION,
      signals,
      digest: digestOf(signals),
    },
  };
}

// The bridge itself. `translate` takes the substrate's indicators and returns either a validated
// crossing or a refusal; `state` reports which. The breaker is per-instance and in-memory, so a
// restart begins connected and has to earn isolation again.
export function createNeuralCognitiveBridge({ enabled = true, threshold = BREAKER_THRESHOLD } = {}) {
  let consecutiveRefusals = 0;
  let isolated = false;
  let lastRefusal = null;
  let lastCrossing = null;
  let crossings = 0;
  let refusals = 0;
  let fallbacks = 0;

  function status() {
    if (enabled !== true) return BRIDGE_STATUS.DISABLED;
    return isolated ? BRIDGE_STATUS.ISOLATED : BRIDGE_STATUS.CONNECTED;
  }

  // Track 2 -> Track 1. A refusal opens the breaker and returns nothing for Track 1 to use; it never
  // throws, because a bridge failure must not fail the pipeline it is attached to.
  function translate(candidate) {
    if (enabled !== true) {
      refusals += 1;
      lastRefusal = { refusal: BRIDGE_REFUSAL.DISABLED, detail: 'the bridge is disabled by configuration', at: new Date().toISOString() };
      return { crossed: false, refusal: lastRefusal, status: BRIDGE_STATUS.DISABLED };
    }
    if (isolated) {
      refusals += 1;
      fallbacks += 1;
      lastRefusal = {
        refusal: BRIDGE_REFUSAL.DISABLED,
        detail: `the circuit breaker is open after ${threshold} consecutive refusals; Track 1 runs on symbols alone`,
        at: new Date().toISOString(),
      };
      return { crossed: false, refusal: lastRefusal, status: BRIDGE_STATUS.ISOLATED };
    }
    const verdict = validateSignal(candidate);
    if (!verdict.ok) {
      refusals += 1;
      consecutiveRefusals += 1;
      lastRefusal = { refusal: verdict.refusal, detail: verdict.detail, at: new Date().toISOString() };
      if (consecutiveRefusals >= threshold) isolated = true;
      return { crossed: false, refusal: lastRefusal, status: status() };
    }
    consecutiveRefusals = 0;
    crossings += 1;
    lastCrossing = {
      at: new Date().toISOString(),
      digest: verdict.signal.digest,
      signals: verdict.signal.signals.length,
    };
    return { crossed: true, signal: verdict.signal, status: status() };
  }

  // The explicit reset. It is not automatic: an operator who wants the bridge back says so, and the
  // refusal history is preserved as counters rather than erased.
  function reset({ reason = null } = {}) {
    const wasIsolated = isolated;
    isolated = false;
    consecutiveRefusals = 0;
    return {
      reset: true,
      wasIsolated,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, MAX_REASON_CHARS) : null,
      status: status(),
    };
  }

  function state() {
    return {
      schema: 'apex.neural.bridge-state/1',
      bridgeVersion: BRIDGE_VERSION,
      status: status(),
      enabled: enabled === true,
      isolated,
      consecutiveRefusals,
      threshold,
      crossings,
      refusals,
      fallbacks,
      lastCrossing,
      lastRefusal,
      // The one sentence a reader needs: what happens when the bridge is not connected.
      fallback: 'Track 1 continues on symbolic evidence alone. The bridge can only add candidate associations.',
      contract: bridgeContract(),
    };
  }

  return Object.freeze({ translate, reset, state, status, contract: bridgeContract });
}

// A bridge that is deliberately off. Wiring this instead of a real bridge is how a deployment - or a
// test - proves that Track 1 does not depend on Track 2 for anything.
export function createDisabledBridge() {
  return createNeuralCognitiveBridge({ enabled: false });
}
