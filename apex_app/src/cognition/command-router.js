// T-37 Step 3 (2026-11-21): the deterministic executive command router.
//
// The deck has one text input. Until now every line typed into it either became a conversation turn or
// was parsed as an intent. This routes the handful of things an owner says that are not requests for
// thought: take a reading, run the doctor, open the Council, acknowledge a briefing, verify a sheet,
// change the presentation, latch lockdown. Each of those has a name, and a name is not a guess.
//
// Three rules govern the whole module:
//
//   1. **No inference.** Every route is a literal or a narrow pattern over the exact words the brief
//      named. There is no model call, no embedding, no fuzzy score and no "best match". A line that
//      does not match a route falls through to the T-29 pipeline, which is the one place a general
//      intent is interpreted - and which is itself deterministic.
//   2. **The receipt is the answer.** Every dispatch returns a `CommandDispatchReceipt` naming the
//      route kind, the capability invoked, the view to focus, the ECP's decision, whether the result
//      verified, and a summary. The UI renders the receipt; it never guesses what happened.
//   3. **Safety is not routed around.** A lockdown dispatch calls the same `safety.lockdown`
//      capability the form calls, through the controller, which means the same ECP gate. A
//      presentation mode is refused while the latch is engaged, because a mode is not a permission
//      and the deck should not look calm while the system is stopped.
import { truncate } from '../util.js';

export const ROUTER_SCHEMA = 'apex.command.router/1';
export const RECEIPT_SCHEMA = 'apex.command.receipt/1';

// What kind of route answered. The UI uses this to decide what to focus, and a test uses it to check
// that a given sentence reached the route it should have.
export const ROUTE_KIND = Object.freeze({
  SENSE: 'sense',
  HEALTH: 'health',
  COUNCIL: 'council',
  BRIEFING: 'briefing',
  WORKSHOP: 'workshop',
  MODE: 'mode',
  SAFETY: 'safety',
  MISSION: 'mission',
  UNMATCHED: 'unmatched',
});

export const PRESENTATION_MODES = Object.freeze(['classic', 'tactical', 'overwatch', 'synthesis', 'quiet']);

// The literal phrases. Matching is case-insensitive and whitespace-normalised, and a phrase matches
// when the line *is* the phrase or begins with it followed by a separator - never when it merely
// contains it, because "do not run doctor" must not run the doctor.
const PHRASES = Object.freeze([
  { kind: ROUTE_KIND.SENSE, phrases: ['sense workspace', 'sense host', 'refresh telemetry', 'refresh sensor'], action: 'perception.sense_host', targetView: 'sentinel', summary: 'take a fresh host and workspace reading' },
  { kind: ROUTE_KIND.HEALTH, phrases: ['run doctor', 'system check', 'status report'], route: '/api/system/doctor', targetView: 'system', summary: 'run the six read-only doctor checks' },
  { kind: ROUTE_KIND.BRIEFING, phrases: ['acknowledge briefing'], action: 'briefing.acknowledge', targetView: 'tasks', summary: 'record a briefing checkpoint' },
  { kind: ROUTE_KIND.BRIEFING, phrases: ['briefing delta', 'show briefing', 'briefing'], route: '/api/briefing', targetView: 'tasks', summary: 'read the current briefing and its delta' },
  { kind: ROUTE_KIND.WORKSHOP, phrases: ['verify workshop'], action: 'workshop.verify', targetView: 'workshop', summary: 'verify the workshop sheets' },
]);

// Patterns that carry an argument. The prefix is literal; the rest is the argument, kept as the owner
// wrote it rather than re-worded.
const PREFIXES = Object.freeze([
  { kind: ROUTE_KIND.COUNCIL, prefix: 'council:', action: 'council.deliberate', targetView: 'council', summary: 'deliberate in the Council' },
  { kind: ROUTE_KIND.COUNCIL, prefix: 'deliberate', action: 'council.deliberate', targetView: 'council', summary: 'deliberate in the Council' },
  { kind: ROUTE_KIND.MODE, prefix: 'mode', targetView: null, summary: 'change the deck presentation' },
  { kind: ROUTE_KIND.SAFETY, prefix: 'lockdown', action: 'safety.lockdown', targetView: 'system', summary: 'latch the executive lockdown' },
]);

// Normalise without losing the argument: collapse runs of whitespace and trim, but keep case so the
// argument of `council: Verify Release Readiness` reads as the owner wrote it.
function normalise(line) {
  return String(line ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function lower(line) {
  return normalise(line).toLowerCase();
}

// Does `line` match `phrase` as a whole line or as a phrase followed by a separator? The separator
// rule is what stops "do not run doctor" from reaching the doctor route.
function matchesPhrase(line, phrase) {
  if (line === phrase) return true;
  if (!line.startsWith(phrase)) return false;
  const rest = line.slice(phrase.length, phrase.length + 1);
  return rest.length === 1 && /[\s:,.!?;-]/.test(rest);
}

function argumentOf(line, prefix) {
  const rest = line.slice(prefix.length);
  return rest.replace(/^[\s:,.!?;-]+/, '').trim();
}

// The receipt. It is a plain object with exactly the fields the brief named, so the UI cannot invent
// a status the route did not report and a test can assert each one.
function receipt({ routeKind, actionInvoked = null, route = null, targetView = null, ecpDecision = 'not_applicable', verified = false, summary, detail = null, input = null, result = null, target = null }) {
  return {
    schema: RECEIPT_SCHEMA,
    routeKind,
    actionInvoked,
    route,
    targetView,
    target,
    ecpDecision,
    verified,
    summary: truncate(String(summary ?? ''), 300),
    detail: detail === null ? null : truncate(String(detail), 600),
    input,
    result,
    at: new Date().toISOString(),
    // A dispatch is a routing decision, never an authorization. Stated on every receipt.
    authorizesExecution: false,
  };
}

// The pure part: decide which route a line belongs to, with no side effects. Exported because the
// decision is the thing worth testing, and because a caller may want to preview it.
export function routeLine(rawLine) {
  const line = normalise(rawLine);
  const folded = lower(line);
  if (line.length === 0) {
    return { kind: ROUTE_KIND.UNMATCHED, reason: 'an empty line names no route' };
  }
  if (line.length > 2000) {
    return { kind: ROUTE_KIND.UNMATCHED, reason: 'the line is longer than 2000 characters' };
  }

  for (const entry of PHRASES) {
    for (const phrase of entry.phrases) {
      if (matchesPhrase(folded, phrase)) {
        return { kind: entry.kind, action: entry.action ?? null, route: entry.route ?? null, targetView: entry.targetView, summary: entry.summary, argument: null, matched: phrase };
      }
    }
  }

  for (const entry of PREFIXES) {
    // `deliberate` must be followed by something to deliberate on, or it is not a Council route.
    if (folded === entry.prefix || folded.startsWith(`${entry.prefix} `) || folded.startsWith(`${entry.prefix}:`)) {
      const argument = argumentOf(line, entry.prefix);
      return {
        kind: entry.kind,
        action: entry.action ?? null,
        targetView: entry.targetView,
        summary: entry.summary,
        argument,
        matched: entry.prefix,
      };
    }
  }

  // Anything else is a general request: the T-29 pipeline is the only thing that interprets it, and
  // it is deterministic too.
  return { kind: ROUTE_KIND.MISSION, argument: line, summary: 'run the T-29 cognition pipeline' };
}

function outcomeOf(step) {
  return step?.outcome ?? step?.verification?.outcome ?? 'unknown';
}

// The executable router. Every route that names a capability calls `controller.runAction`, which means
// the registry authorizes it and the ECP decides it - exactly as if the owner had used the form.
export function createCommandRouter({ controller, app = null, now = () => new Date() } = {}) {
  if (!controller || typeof controller.runAction !== 'function') {
    throw new TypeError('a command router needs the controller');
  }

  async function dispatchAction(name, input, operationId) {
    const step = await controller.runAction(name, input, 'user', operationId ?? null);
    return {
      step,
      ecpDecision: step?.authorization?.decision ?? 'unknown',
      verified: outcomeOf(step) === 'success_verified',
      summary: step?.summary ?? '',
    };
  }

  // A direct read of a route the deck already serves. It goes through the same handler the UI calls, so
  // the answer the receipt carries is the answer the screen would show.
  async function dispatchRoute(path) {
    if (!app || typeof app.dispatchRead !== 'function') {
      return { ecpDecision: 'not_applicable', verified: false, summary: `this build cannot read ${path} internally` };
    }
    const outcome = await app.dispatchRead(path);
    return {
      ecpDecision: 'not_applicable',
      verified: outcome?.ok === true,
      summary: outcome?.ok === true ? `${path} answered` : `${path} answered ${outcome?.status ?? 'with an error'}`,
      result: outcome,
    };
  }

  async function dispatch(rawLine, { operationId = null } = {}) {
    const route = routeLine(rawLine);
    const id = operationId ?? `dispatch-${Math.random().toString(36).slice(2, 10)}`;

    switch (route.kind) {
      case ROUTE_KIND.SENSE: {
        const outcome = await dispatchAction(route.action, {}, id);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? `Reading taken: ${outcome.summary}` : `The reading did not verify: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.HEALTH: {
        const outcome = await dispatchRoute(route.route);
        const doctor = outcome.result?.value ?? null;
        // The doctor reports counts by state, not a passed/total pair. Reading them as they are named
        // is the difference between a real number and a confidently rendered `?/?`.
        const counts = doctor?.counts ?? null;
        const tally = counts
          ? `${counts.pass ?? 0} pass, ${counts.degraded ?? 0} degraded, ${counts.failed ?? 0} failed, ${counts.notConfigured ?? 0} not configured`
          : 'no counts were reported';
        return receipt({
          routeKind: route.kind, route: route.route, targetView: route.targetView,
          verified: outcome.verified,
          summary: outcome.verified
            ? `Doctor: ${doctor?.status ?? 'unknown'} — ${tally}`
            : `The doctor could not run: ${outcome.summary}`,
          detail: outcome.summary,
          result: doctor === null ? null : { status: doctor?.status ?? null, counts, withinBudget: doctor?.withinBudget ?? null, durationMs: doctor?.durationMs ?? null },
        });
      }
      case ROUTE_KIND.COUNCIL: {
        const objective = route.argument && route.argument.length > 0 ? route.argument : null;
        if (objective === null) {
          // `deliberate` with no argument focuses the workspace and invokes nothing: there is no
          // objective, and inventing one would be the router deciding what to think about.
          return receipt({
            routeKind: route.kind, actionInvoked: null, targetView: route.targetView,
            summary: 'Open the Council workspace; an objective is needed to deliberate',
            detail: 'Name the question after the command, for example: council: should we widen the sensor budget?',
          });
        }
        const outcome = await dispatchAction(route.action, { objective, useContext: true }, id);
        const recommendation = outcome.step?.result?.data?.synthesis?.recommendedOption?.level ?? null;
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified
            ? `Deliberated${recommendation ? `: ${recommendation}` : ''}`
            : `The deliberation did not verify: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: { objective },
        });
      }
      case ROUTE_KIND.BRIEFING: {
        if (route.route) {
          const outcome = await dispatchRoute(route.route);
          return receipt({
            routeKind: route.kind, route: route.route, targetView: route.targetView,
            verified: outcome.verified,
            summary: outcome.verified ? 'The briefing was read' : `The briefing could not be read: ${outcome.summary}`,
          });
        }
        const outcome = await dispatchAction(route.action, {}, id);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? `Briefing acknowledged: ${outcome.summary}` : `The briefing was not acknowledged: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.WORKSHOP: {
        const outcome = await dispatchAction(route.action, {}, id);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? `Workshop verified: ${outcome.summary}` : `The workshop did not verify: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.MODE: {
        const requested = (route.argument ?? '').toLowerCase();
        if (!PRESENTATION_MODES.includes(requested)) {
          return receipt({
            routeKind: route.kind, targetView: null,
            summary: `"${truncate(requested || '(none)', 40)}" is not a presentation mode`,
            detail: `Modes are ${PRESENTATION_MODES.join(', ')}.`,
          });
        }
        // The presentation mode is refused while the latch is engaged. A mode changes how the deck
        // looks; it must never make a latched system look like a calm one.
        const latch = app?.ecp && typeof app.ecp.killSwitchStatus === 'function' ? app.ecp.killSwitchStatus() : null;
        if (latch && latch.active === true) {
          return receipt({
            routeKind: route.kind, target: requested, targetView: null,
            ecpDecision: 'deny', verified: false,
            summary: `"${requested}" was refused: the lockdown latch is engaged`,
            detail: 'A presentation mode is not a permission and cannot be applied while the system is stopped.',
          });
        }
        return receipt({
          routeKind: route.kind, target: requested, targetView: null,
          summary: `Presentation mode: ${requested}`,
          detail: 'Applied by the deck. A mode changes palette, motion and contrast only; it never calls an API or writes a store.',
        });
      }
      case ROUTE_KIND.SAFETY: {
        const reason = route.argument && route.argument.length > 0 ? route.argument : 'lockdown requested from the command line';
        const outcome = await dispatchAction(route.action, { reason }, id);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? 'Lockdown latched' : `Lockdown not latched: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: { reason },
        });
      }
      case ROUTE_KIND.MISSION:
      default: {
        // The T-29 pipeline. This is not the router guessing; it is the router declining to guess and
        // handing the line to the one component whose job is to interpret it.
        const outcome = await dispatchAction('cognition.run', { intent: route.argument }, id);
        const run = outcome.step?.result?.data ?? null;
        return receipt({
          routeKind: ROUTE_KIND.MISSION, actionInvoked: 'cognition.run', targetView: 'cognition',
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified
            ? `Run ${run?.status ?? 'completed'}${run?.taskId ? ` · task ${run.taskId}` : ''}`
            : `The run did not verify: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: { intent: route.argument },
        });
      }
    }
  }

  return Object.freeze({
    schema: ROUTER_SCHEMA,
    routeLine,
    dispatch,
    modes: () => [...PRESENTATION_MODES],
    routes: () => ({ phrases: PHRASES.length, prefixes: PREFIXES.length }),
  });
}
