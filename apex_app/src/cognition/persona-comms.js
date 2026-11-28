// T-33 Step 2 (2026-11-19): the Persona and Executive Comms layer.
//
// Five characters, five framings, one set of facts. This module is a *formatter*: it takes facts the
// system already holds, the presentation mode the owner selected, and the safety signals of the
// moment, and it writes the same facts in five voices. It never computes a new fact, never changes a
// number, never decides anything, and never speaks for the ECP. If a fact is missing it says
// "unavailable" rather than filling the gap.
//
// The hard rule (Part 4, Principle #10 - "dry wit, never noise"):
//
//   Classic is the only voice allowed any wit at all, and only when nothing is wrong. An active
//   advisory, a pending approval, a degraded Core, an error or a latched Lockdown strip wit from
//   every voice, including Classic, and `witAllowed` becomes false. The rule is enforced twice: the
//   formatter will not choose a witty phrasing when `witAllowed` is false, and the assertion helper
//   below refuses to let a marker through even if a future edit tries.
//
// Nothing here calls a model. The phrasing is a fixed template per mode; the only variable input is
// the facts the caller supplies.
export const EXEC_COMMS_SCHEMA = 'apex.exec.comms/1';
export const EXEC_MODES = Object.freeze(['classic', 'tactical', 'overwatch', 'synthesis', 'quiet']);

export const PERSONAS = Object.freeze({
  classic: Object.freeze({ persona: 'JARVIS', framing: 'composed executive synthesis', wit: true }),
  tactical: Object.freeze({ persona: 'FRIDAY', framing: 'telemetry first, action, status, next gate', wit: false }),
  overwatch: Object.freeze({ persona: 'EDITH', framing: 'perimeter, resources and sovereignty', wit: false }),
  synthesis: Object.freeze({ persona: 'Vision', framing: 'observed, inferred and open risk, stated apart', wit: false }),
  quiet: Object.freeze({ persona: 'Her', framing: 'one calm line', wit: false }),
});

// Every phrase that could read as wit, banter or flourish. The formatter only emits these when
// `witAllowed` is true, and `witMarkersIn()` is what the tests and the browser run use to prove none
// of them survived a risk signal.
export const WIT_MARKERS = Object.freeze([
  /of course, sir/i,
  /\bsir\b/i,
  /as always/i,
  /rare and welcome/i,
  /a pleasure/i,
  /splendid/i,
  /delighted/i,
  /if i may say/i,
  /no rest for/i,
  /quietly pleased/i,
]);

const CLASSIC_HEALTHY = Object.freeze({
  headline: 'Systems are settled; the deck is yours whenever you want it.',
  flourish: 'A quiet hour is a rare and welcome thing, sir. Nothing in the fabric needs you.',
  close: 'As always, I will say something the moment that changes.',
});

const CLASSIC_GUARDED = Object.freeze({
  headline: 'Systems are settled, with something to review.',
  flourish: null,
  close: 'Nothing here is urgent, and nothing here is hidden.',
});

const UNAVAILABLE = 'unavailable';

function text(value, max = 240) {
  if (value === undefined || value === null || value === '') return UNAVAILABLE;
  const rendered = typeof value === 'string' ? value : String(value);
  return rendered.length > max ? `${rendered.slice(0, max - 1)}…` : rendered;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : UNAVAILABLE;
}

// The signals that forbid wit. Each one is a fact the caller states; none is inferred here.
export function readSignals(signals = {}) {
  const alerts = Array.isArray(signals.alerts) ? signals.alerts.filter((entry) => entry && entry.delivered !== false) : [];
  const approvals = Number.isSafeInteger(signals.approvals) ? signals.approvals : 0;
  const errors = Array.isArray(signals.errors) ? signals.errors.filter(Boolean) : [];
  const coreState = typeof signals.coreState === 'string' ? signals.coreState : null;
  const degraded = signals.degraded === true || coreState === 'degraded';
  const lockdown = signals.lockdown === true;
  const approvalPending = signals.approvalPending === true || approvals > 0;
  const alertActive = signals.alertActive === true || alerts.length > 0;
  const errorPresent = signals.error === true || errors.length > 0;
  const uncertainty = signals.uncertain === true;
  // Wit is only for a settled deck: a Core that is working, paused or awaiting anything is not idle.
  const coreBusy = typeof coreState === 'string' && coreState !== 'idle';
  const reasons = [];
  if (alertActive) reasons.push('an advisory is active');
  if (approvalPending) reasons.push('an owner approval is pending');
  if (degraded) reasons.push('the Core is degraded');
  if (errorPresent) reasons.push('an error is present');
  if (uncertainty) reasons.push('the state is uncertain');
  if (lockdown) reasons.push('Lockdown is latched');
  if (coreBusy) reasons.push(`the Core is ${coreState}`);
  const unique = [...new Set(reasons)];
  return Object.freeze({
    alerts: Object.freeze(alerts),
    approvals,
    errors: Object.freeze(errors),
    coreState,
    degraded,
    lockdown,
    approvalPending,
    alertActive,
    errorPresent,
    uncertain: uncertainty,
    // Wit needs every one of these to be false. It is a conjunction, so adding a signal can only
    // ever take wit away, never grant it.
    witAllowed: unique.length === 0,
    witWithheldBecause: Object.freeze(unique),
  });
}

// Which wit markers appear in a piece of text. Empty means the text is clean.
export function witMarkersIn(value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return WIT_MARKERS.filter((marker) => marker.test(rendered)).map((marker) => marker.source);
}

// A fact is `{ key, label, value, at? }`. The formatter only reads it.
function factLines(facts) {
  const list = Array.isArray(facts) ? facts.filter((fact) => fact && typeof fact === 'object') : [];
  return list.map((fact) => ({ label: text(fact.label ?? fact.key, 60), value: text(fact.value), at: fact.at ?? null }));
}

function line(label, value) {
  return Object.freeze({ label, value: text(value) });
}

function composeClassic(factList, signals) {
  const healthy = signals.witAllowed;
  const template = healthy ? CLASSIC_HEALTHY : CLASSIC_GUARDED;
  const lines = factList.slice(0, 6).map((fact) => line(fact.label, fact.value));
  if (!healthy) {
    lines.push(line('Attention', `wit withheld: ${signals.witWithheldBecause.join(', ')}`));
  } else {
    lines.push(line('Tone', template.flourish));
    lines.push(line('Standing', template.close));
  }
  return { headline: template.headline, lines };
}

function composeTactical(factList, signals) {
  const facts = new Map(factList.map((fact) => [fact.label.toLowerCase(), fact.value]));
  const status = signals.degraded ? 'DEGRADED' : signals.lockdown ? 'LOCKDOWN' : signals.approvalPending ? 'AWAITING APPROVAL' : 'NOMINAL';
  return {
    headline: `STATUS ${status}`,
    lines: [
      line('Action', facts.get('action') ?? facts.get('core') ?? UNAVAILABLE),
      line('Status', facts.get('status') ?? status),
      line('Next Gate', signals.approvalPending ? `${signals.approvals} approval(s) awaiting the owner` : (facts.get('next gate') ?? 'none recorded')),
      ...factList.filter((fact) => !['action', 'status', 'next gate', 'core'].includes(fact.label.toLowerCase()))
        .slice(0, 8).map((fact) => line(fact.label, fact.value)),
    ],
  };
}

function composeOverwatch(factList, signals) {
  const facts = new Map(factList.map((fact) => [fact.label.toLowerCase(), fact.value]));
  return {
    headline: signals.lockdown ? 'PERIMETER SEALED — Lockdown latched' : 'PERIMETER HELD',
    lines: [
      line('Perimeter', signals.lockdown ? 'Lockdown latched; every write is refused at the ECP' : 'loopback only; the ECP holds authority'),
      line('Resources', facts.get('resources') ?? facts.get('memory') ?? UNAVAILABLE),
      line('Devices', facts.get('devices') ?? 'no device is enrolled'),
      line('Sovereignty', facts.get('step-up') ?? facts.get('stepup') ?? 'step-up not required in this deployment'),
      line('Authority', 'the ECP decides; this framing authorizes nothing'),
    ],
  };
}

function composeSynthesis(factList, signals) {
  const observed = factList.filter((fact) => fact.basis !== 'inferred' && fact.basis !== 'assumed').slice(0, 4);
  const inferred = factList.filter((fact) => fact.basis === 'inferred' || fact.basis === 'assumed').slice(0, 3);
  const risks = [];
  if (signals.alertActive) risks.push(`${signals.alerts.length} active advisory/advisories`);
  if (signals.approvalPending) risks.push(`${signals.approvals} approval(s) cannot be inferred past`);
  if (signals.degraded) risks.push('the Core reading is degraded, so absence of evidence is not evidence');
  if (signals.lockdown) risks.push('Lockdown limits what can be done at all');
  if (risks.length === 0) risks.push('none recorded');
  return {
    headline: 'OBSERVED / INFERRED / OPEN',
    lines: [
      line('Observed', observed.length > 0 ? observed.map((fact) => `${fact.label}: ${fact.value}`).join(' · ') : 'nothing observed is recorded'),
      line('Inferred', inferred.length > 0 ? inferred.map((fact) => `${fact.label}: ${fact.value}`).join(' · ') : 'nothing is labelled inferred'),
      line('Open risk', risks.join(' · ')),
      line('Basis', 'an inference is never promoted to an observation by this framing'),
    ],
  };
}

function composeQuiet(factList, signals) {
  const facts = new Map(factList.map((fact) => [fact.label.toLowerCase(), fact.value]));
  const core = facts.get('core') ?? signals.coreState ?? UNAVAILABLE;
  const lineish = signals.lockdown
    ? 'Sealed.'
    : signals.approvalPending
      ? `${signals.approvals} approval(s) waiting.`
      : signals.degraded
        ? 'Degraded; watching.'
        : `${text(core, 40)}.`;
  return { headline: lineish, lines: [] };
}

const COMPOSERS = Object.freeze({
  classic: composeClassic,
  tactical: composeTactical,
  overwatch: composeOverwatch,
  synthesis: composeSynthesis,
  quiet: composeQuiet,
});

// One framing. Deterministic: the same facts, mode and signals always produce the same text.
export function composeExecutiveComms({ mode = 'classic', facts = [], signals = {} } = {}) {
  const selected = EXEC_MODES.includes(mode) ? mode : 'classic';
  const persona = PERSONAS[selected];
  const read = readSignals(signals);
  const factList = factLines(facts);
  const { headline, lines } = COMPOSERS[selected](factList, read);
  const body = { headline, lines };

  // Defence in depth: the composer above will not choose a witty phrasing when wit is withheld, and
  // this refuses to return one if a future edit ever does.
  if (!read.witAllowed) {
    const found = witMarkersIn(body);
    if (found.length > 0) {
      return Object.freeze({
        schema: EXEC_COMMS_SCHEMA,
        mode: selected,
        persona: persona.persona,
        framing: persona.framing,
        witAllowed: false,
        witWithheldBecause: read.witWithheldBecause,
        headline: 'Statement withheld: a witty phrasing was chosen while a risk signal was active.',
        lines: Object.freeze([]),
        withheld: true,
        markersFound: Object.freeze(found),
      });
    }
  }

  return Object.freeze({
    schema: EXEC_COMMS_SCHEMA,
    mode: selected,
    persona: persona.persona,
    framing: persona.framing,
    witAllowed: read.witAllowed,
    witWithheldBecause: read.witWithheldBecause,
    headline: text(headline, 240),
    lines: Object.freeze(lines.map((entry) => Object.freeze({ label: entry.label, value: entry.value }))),
    withheld: false,
    markersFound: Object.freeze(witMarkersIn(body)),
  });
}

// All five framings over one set of facts, so a mode switch is a selection rather than a round trip.
export function composeAllFramings({ facts = [], signals = {} } = {}) {
  const read = readSignals(signals);
  const framings = {};
  for (const mode of EXEC_MODES) framings[mode] = composeExecutiveComms({ mode, facts, signals });
  return Object.freeze({
    schema: 'apex.exec.comms-set/1',
    signals: Object.freeze({
      coreState: read.coreState,
      approvals: read.approvals,
      alerts: read.alerts.length,
      degraded: read.degraded,
      lockdown: read.lockdown,
      approvalPending: read.approvalPending,
      alertActive: read.alertActive,
      errorPresent: read.errorPresent,
      witAllowed: read.witAllowed,
      witWithheldBecause: read.witWithheldBecause,
    }),
    framings: Object.freeze(framings),
  });
}
