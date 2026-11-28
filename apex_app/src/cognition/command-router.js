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
  // T-43 Package 2: the deeper readings. `GIT` names the repository acts and `INSPECT` the host ones;
  // both are separate kinds rather than more `SENSE` because the target view differs - a git reading
  // belongs on the Workshop and a host reading on the Sentinel.
  GIT: 'git',
  INSPECT: 'inspect',
  // T-44 Package 2: the agenda and the standing orders. These are `refresh` routes rather than `action`
  // routes because the two GETs are reads the panel performs anyway: the line means "show me this", and
  // the receipt names the route that was refreshed rather than a capability that was run. Creating a
  // commitment is an `action` route on the same kind, because that one writes.
  AGENDA: 'agenda',
  STANDING_ORDER: 'standing_order',
  // T-45: the playbooks and the watchpoints, and the HUD posture. `HUD` carries no capability at all - a
  // posture is presentation, and the deck applies it - so it is its own kind rather than a mode, because a
  // mode changes palette and this changes what is on screen.
  PLAYBOOK: 'playbook',
  WATCHPOINT: 'watchpoint',
  HUD: 'hud',
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
  // T-43 Package 2. `git status` and `inspect ports` are whole-line phrases with no argument; the
  // Sentinel view is named because that is where the port and process tables live.
  { kind: ROUTE_KIND.GIT, phrases: ['git status'], action: 'git.status_detailed', targetView: 'workshop', summary: 'read the workspace repository in detail' },
  { kind: ROUTE_KIND.INSPECT, phrases: ['inspect ports', 'inspect listening ports'], action: 'system.inspect_ports', targetView: 'sentinel', summary: 'read the listening sockets from the operating system' },
  { kind: ROUTE_KIND.INSPECT, phrases: ['inspect processes', 'inspect process'], action: 'system.inspect_processes', targetView: 'sentinel', summary: 'read the running processes and own memory' },
  // T-44 Package 2. `show agenda` and `standing orders` are reads: they refresh a GET and focus the panel
  // that renders it. `show briefing` already exists above and still means the briefing report; these are
  // the two panels this batch puts on that view.
  // The two panels live inside existing views: the agenda beside the Briefings panel on the approvals
  // view, and the standing orders beside the safety latch on the system view. `targetView` names the view
  // the deck switches to and `target` the panel inside it, because a view is what `setView` can paint and a
  // panel is what the receipt points at.
  { kind: ROUTE_KIND.AGENDA, phrases: ['show agenda', 'agenda'], route: '/api/agenda', targetView: 'approvals', targetPanel: '#briefing-agenda-panel', summary: 'read the unified executive agenda' },
  { kind: ROUTE_KIND.STANDING_ORDER, phrases: ['standing orders', 'show standing orders'], route: '/api/standing-orders', targetView: 'system', targetPanel: '#standing-orders-panel', summary: 'read the standing orders and their policy' },
  // T-45. `show playbooks` is a read; `evaluate watchpoints` runs the evaluation, so it is a prefix-free
  // action phrase and not a refresh. The two are different kinds for the same reason `show agenda` and
  // `schedule x` are: one names a route the panel was going to read anyway, the other runs a capability.
  { kind: ROUTE_KIND.PLAYBOOK, phrases: ['show playbooks', 'playbooks'], route: '/api/playbooks', targetView: 'tasks', targetPanel: '#playbooks-panel', summary: 'read the playbook catalog and its runs' },
  { kind: ROUTE_KIND.WATCHPOINT, phrases: ['evaluate watchpoints', 'check watchpoints'], action: 'watchpoint.evaluate', targetView: 'sentinel', targetPanel: '#sentinel-watchpoints-panel', summary: 'evaluate every enabled watchpoint against the live machine' },
  // T-45 Package 3. The posture is applied by the deck, so this route names a target and no capability.
  // `toggle overlay` is not a mode: a mode changes palette and motion, and this changes what the deck puts
  // on screen. Keeping them apart is what stops `toggle overlay` being refused by the lockdown mode gate,
  // which guards a thing that does not apply here.
  { kind: ROUTE_KIND.HUD, phrases: ['toggle overlay', 'overlay mode', 'full hud'], targetView: null, summary: 'switch the deck between the full HUD and the compact tactical overlay' },
]);

// Patterns that carry an argument. The prefix is literal; the rest is the argument, kept as the owner
// wrote it rather than re-worded.
// T-43 Package 2: `create checkpoint <label>` is the one prefix whose argument is a label rather than a
// question. It is listed first because its prefix is the longest of the ones that could collide, and a
// router that matched `create` first would route `create checkpoint x` as a mission.
const CHECKPOINT_PREFIX = 'create checkpoint';

const PREFIXES = Object.freeze([
  // T-44 Package 2: the two ways an owner writes a commitment down. Both are listed before the shorter
  // prefixes for the same reason `create checkpoint` is: `remind me to` cannot collide today, but
  // `schedule` could with a future `schedule <mission>`, and the longest-first rule is the one that keeps
  // that from becoming a silent misroute.
  { kind: ROUTE_KIND.AGENDA, prefix: 'remind me to', action: 'agenda.create', targetView: 'approvals', targetPanel: '#briefing-agenda-panel', summary: 'add a commitment to the agenda', argumentLabel: 'title' },
  { kind: ROUTE_KIND.AGENDA, prefix: 'schedule', action: 'agenda.create', targetView: 'approvals', targetPanel: '#briefing-agenda-panel', summary: 'add a commitment to the agenda', argumentLabel: 'title' },
  { kind: ROUTE_KIND.GIT, prefix: CHECKPOINT_PREFIX, action: 'git.checkpoint_create', targetView: 'workshop', summary: 'create a git checkpoint of the workspace', argumentLabel: 'label' },
  { kind: ROUTE_KIND.GIT, prefix: 'git diff', action: 'git.diff_inspect', targetView: 'workshop', summary: 'inspect a workspace diff', argumentLabel: 'path' },
  { kind: ROUTE_KIND.COUNCIL, prefix: 'council:', action: 'council.deliberate', targetView: 'council', summary: 'deliberate in the Council' },
  { kind: ROUTE_KIND.COUNCIL, prefix: 'deliberate', action: 'council.deliberate', targetView: 'council', summary: 'deliberate in the Council' },
  { kind: ROUTE_KIND.MODE, prefix: 'mode', targetView: null, summary: 'change the deck presentation' },
  { kind: ROUTE_KIND.SAFETY, prefix: 'lockdown', action: 'safety.lockdown', targetView: 'system', summary: 'latch the executive lockdown' },
  // T-45. The two ways an owner launches a routine. Listed after `lockdown` and before nothing, because the
  // matching rule takes the longest prefix that fits and neither collides with a shorter one today; they are
  // here rather than among the action phrases because the argument is a playbook id the owner types.
  { kind: ROUTE_KIND.PLAYBOOK, prefix: 'run playbook', action: 'playbook.launch', targetView: 'tasks', targetPanel: '#playbooks-panel', summary: 'launch an executive playbook', argumentLabel: 'playbook id' },
  { kind: ROUTE_KIND.PLAYBOOK, prefix: 'launch playbook', action: 'playbook.launch', targetView: 'tasks', targetPanel: '#playbooks-panel', summary: 'launch an executive playbook', argumentLabel: 'playbook id' },
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
        return {
          kind: entry.kind, action: entry.action ?? null, route: entry.route ?? null,
          targetView: entry.targetView, targetPanel: entry.targetPanel ?? null,
          summary: entry.summary, argument: null, matched: phrase,
        };
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
        // The panel inside the view, when the route names one. A prefix route to the agenda names the
        // panel its receipt will focus, so the pure `routeLine` decision can be checked against it.
        targetPanel: entry.targetPanel ?? null,
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
      case ROUTE_KIND.GIT: {
        // `create checkpoint <label>` is a governance question as well as a routing one: the label is
        // the owner's words, and a line with no label is refused rather than given a generated one. The
        // act itself still runs through `controller.runAction`, so the ECP decides it, Lockdown refuses
        // it, and step-up applies exactly as it does from the panel.
        if (route.action === 'git.checkpoint_create') {
          const label = (route.argument ?? '').trim();
          if (label.length === 0) {
            return receipt({
              routeKind: route.kind, actionInvoked: null, targetView: route.targetView,
              summary: 'Name the checkpoint after the command',
              detail: 'For example: create checkpoint before the refactor. The label is what the checkpoint list will show.',
            });
          }
          // The label travels into a git ref, so it is cleaned here as well as in the action: a label of
          // "a/b c" is fine and a label of "${x}" is refused by the action, but a label containing a newline
          // would produce an audit line no reader can parse.
          const safeLabel = label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
          const outcome = await dispatchAction(route.action, { label: safeLabel, reason: 'created from the command line' }, id);
          return receipt({
            routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
            ecpDecision: outcome.ecpDecision, verified: outcome.verified,
            summary: outcome.verified ? `Checkpoint created: ${outcome.summary}` : `The checkpoint was refused: ${outcome.summary}`,
            detail: outcome.step?.display ?? null, input: { label: safeLabel },
          });
        }
        if (route.action === 'git.diff_inspect') {
          // `git diff` with no argument inspects the whole working tree; `git diff <path>` narrows to a
          // path, and the path is passed through unchanged so the engine's containment check is what
          // decides whether it is inside the workspace. A router that pre-validated the path would be a
          // second, weaker copy of that check.
          const path = (route.argument ?? '').trim();
          const input = path.length === 0 ? {} : { targetPath: path };
          const outcome = await dispatchAction(route.action, input, id);
          const data = outcome.step?.result?.data ?? null;
          return receipt({
            routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
            ecpDecision: outcome.ecpDecision, verified: outcome.verified,
            summary: outcome.verified
              ? `Diff${path.length > 0 ? ` ${truncate(path, 60)}` : ''}: +${data?.additions ?? 0} -${data?.deletions ?? 0}`
              : `The diff could not be read: ${outcome.summary}`,
            detail: outcome.step?.display ?? null, input,
          });
        }
        // `git status`.
        const outcome = await dispatchAction(route.action, {}, id);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? `Repository read: ${outcome.summary}` : `The repository could not be read: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.INSPECT: {
        const outcome = await dispatchAction(route.action, {}, id);
        const data = outcome.step?.result?.data ?? null;
        const summary = route.action === 'system.inspect_ports'
          ? (data ? `${data.summary.totalListening} listening, ${data.summary.loopbackOnlyCount} loopback-only, ${data.summary.externalExposureCount} wildcard` : outcome.summary)
          : (data ? `${data.topProcesses?.length ?? 0} process(es), own RSS ${Math.round((data.apexProcess?.rssBytes ?? 0) / (1024 * 1024))} MB` : outcome.summary);
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified ? `Inspection taken: ${summary}` : `The inspection did not verify: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.AGENDA: {
        // `schedule <title>` and `remind me to <title>` write a commitment; `show agenda` reads one back.
        // The write goes through the controller like every other write, so Lockdown refuses it here as it
        // would from the panel - a command line is not a way around the latch.
        if (route.action === 'agenda.create') {
          const title = (route.argument ?? '').trim();
          if (title.length === 0) {
            return receipt({
              routeKind: route.kind, actionInvoked: null, targetView: route.targetView,
              summary: 'Say what to schedule',
              detail: 'For example: schedule review phase 2 telemetry. The words after the command become the commitment title.',
            });
          }
          // Cleaned here as well as in the action, for the reason the checkpoint label is: the title
          // travels into an audit line, and a newline in it would produce a line no reader can parse.
          const safeTitle = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
          const outcome = await dispatchAction(route.action, { title: safeTitle }, id);
          const data = outcome.step?.result?.data ?? null;
          return receipt({
            routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
            target: '#briefing-agenda-panel',
            ecpDecision: outcome.ecpDecision, verified: outcome.verified,
            summary: outcome.verified
              ? `Scheduled: ${data?.title ?? safeTitle} (${data?.itemId ?? 'agenda'})`
              : `The commitment was not written: ${outcome.summary}`,
            detail: outcome.step?.display ?? null,
            input: { title: safeTitle },
            result: data ? { itemId: data.itemId, horizonBucket: data.horizonBucket ?? null } : null,
          });
        }
        // `show agenda`: a read. The receipt names the route rather than a capability, because nothing
        // was authorized and nothing was run.
        return receipt({
          routeKind: route.kind, route: route.route, targetView: route.targetView,
          target: '#briefing-agenda-panel',
          summary: 'Reading the executive agenda',
          detail: 'The Briefing agenda panel is refreshing; the counts it shows come from GET /api/agenda.',
        });
      }
      case ROUTE_KIND.STANDING_ORDER: {
        // `standing orders`: a read of the engine's own policy and ledger. The panel is on the
        // policy-autonomy view, which is where the latch and the autonomy ceiling are already shown - an
        // owner reading what is armed and what is stopped should see both in one place.
        return receipt({
          routeKind: route.kind, route: route.route, targetView: route.targetView,
          target: '#standing-orders-panel',
          summary: 'Reading the standing orders',
          detail: 'The policy-autonomy standing-orders panel is refreshing; the policy and the orders come from GET /api/standing-orders.',
        });
      }
      case ROUTE_KIND.PLAYBOOK: {
        // The ids come from the engine's own catalog, read through the composed app, rather than from an
        // import: this module's import graph is deliberately one string helper, because a router that can
        // reach a store is not a router. A build without the engine offers an empty list, and every launch
        // is then refused by name rather than attempted.
        const knownPlaybooks = (() => {
          try {
            const templates = app?.playbooks?.catalog?.()?.templates;
            return Array.isArray(templates) ? templates.map((template) => template.playbookId) : [];
          } catch {
            return [];
          }
        })();
        // `run playbook <id>` and `launch playbook <id>` run the routine; `show playbooks` reads the
        // catalog. The launch goes through the controller like every other write, so Lockdown refuses it
        // here exactly as it would from the panel.
        if (route.action === 'playbook.launch') {
          const wanted = (route.argument ?? '').trim();
          if (wanted.length === 0) {
            return receipt({
              routeKind: route.kind, actionInvoked: null, targetView: route.targetView,
              summary: 'Say which playbook to run',
              detail: knownPlaybooks.length
                ? `Playbooks are ${knownPlaybooks.join(', ')}. For example: run playbook morning_briefing.`
                : 'No playbook engine is composed in this build, so there is nothing to run.',
            });
          }
          const playbookId = wanted.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (!knownPlaybooks.includes(playbookId)) {
            // Refused before an authorization is spent, with the ids named: a misremembered id should cost
            // a receipt, not a run.
            return receipt({
              routeKind: route.kind, actionInvoked: null, targetView: route.targetView,
              summary: `"${playbookId}" is not a playbook`,
              detail: knownPlaybooks.length
                ? `Playbooks are ${knownPlaybooks.join(', ')}.`
                : 'No playbook engine is composed in this build, so there is nothing to run.',
            });
          }
          const outcome = await dispatchAction(route.action, { playbookId }, id);
          const run = outcome.step?.result?.data ?? null;
          return receipt({
            routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
            target: '#playbooks-panel',
            ecpDecision: outcome.ecpDecision, verified: outcome.verified,
            // The operation verified because a routine that ran and did not hold is exactly what this
            // reports. `run.status` is the routine's answer, and it leads the line: a reader must not have
            // to reach the word "failed" at the end of a sentence that opened with "verified".
            summary: run
              ? `Playbook ${run.playbookId} ${run.status}: ${run.steps.filter((step) => step.verified).length}/${run.steps.length} steps (${run.runId})`
              : `The playbook did not run: ${outcome.summary}`,
            detail: outcome.step?.display ?? null, input: { playbookId },
          });
        }
        // `show playbooks`: a read. The receipt names the route rather than a capability.
        return receipt({
          routeKind: route.kind, route: route.route, targetView: route.targetView,
          target: '#playbooks-panel',
          summary: 'Reading the playbooks',
          detail: 'The tasks-view playbook panel is refreshing; the templates and the runs come from GET /api/playbooks.',
        });
      }
      case ROUTE_KIND.WATCHPOINT: {
        const outcome = await dispatchAction(route.action, {}, id);
        const result = outcome.step?.result?.data ?? null;
        return receipt({
          routeKind: route.kind, actionInvoked: route.action, targetView: route.targetView,
          target: '#sentinel-watchpoints-panel',
          ecpDecision: outcome.ecpDecision, verified: outcome.verified,
          summary: outcome.verified && result
            ? `Watchpoints evaluated: ${result.summary.evaluatedCount} evaluated, ${result.breachedCount} breached`
            : `The watchpoints were not evaluated: ${outcome.summary}`,
          detail: outcome.step?.display ?? null, input: {},
        });
      }
      case ROUTE_KIND.HUD: {
        // A posture is presentation, and the deck applies it. The receipt says which, so the command line
        // reports what the owner will see; it authorizes nothing and calls no API.
        return receipt({
          routeKind: route.kind, target: 'toggle', targetView: null,
          summary: 'Switching the HUD posture',
          detail: 'The deck toggles between the full HUD and the compact tactical overlay. A posture changes what is on screen and nothing else.',
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

  // T-40 Step 3: the router's own catalogue, so the HUD help panel lists what the router will actually
  // do rather than a hand-written list that can drift from it.
  //
  // Every entry is derived from the same PHRASES and PREFIXES tables that dispatch reads, so a command
  // added to the router appears in the help without anyone remembering to add it in two places - and a
  // command removed from the router cannot linger in the help as a lie. The ECP governance column is
  // read from the registry, not asserted: `not_applicable` means the line focuses a workspace or reads a
  // route and never invokes a capability, which is a different answer from `allow`.
  function catalog() {
    // The registry's decision is asked once per capability rather than once per row, so a catalogue of
    // twenty rows costs at most a handful of ECP evaluations and every row that names the same
    // capability reports the same answer.
    const decisions = new Map();
    const capabilityOf = (action) => {
      if (!action) return null;
      if (decisions.has(action)) return decisions.get(action);
      const definition = typeof controller.registry?.get === 'function' ? controller.registry.get(action) : null;
      let value = null;
      if (definition) {
        let ecpDecision = 'unknown';
        try {
          ecpDecision = controller.registry.authorize?.(action, 'user')?.decision ?? 'unknown';
        } catch {
          ecpDecision = 'unknown';
        }
        value = {
          name: definition.name,
          permission: definition.permission ?? null,
          reversibility: definition.reversibility ?? null,
          blastRadius: definition.blastRadius ?? null,
          origins: Array.isArray(definition.origins) ? [...definition.origins] : [],
          ecpDecision,
        };
      }
      decisions.set(action, value);
      return value;
    };

    const rows = [];
    // The literal phrases, exactly as dispatch reads them. `phrases` is the array in the table and the
    // row is built once per phrase, so the help shows every string that will actually match.
    for (const entry of PHRASES) {
      for (const phrase of entry.phrases) {
        rows.push({
          syntax: phrase,
          routeKind: entry.kind,
          summary: entry.summary,
          targetView: entry.targetView ?? null,
          action: entry.action ?? null,
          route: entry.route ?? null,
          argument: null,
          capability: capabilityOf(entry.action ?? null),
        });
      }
    }
    for (const entry of PREFIXES) {
      rows.push({
        // A prefix is shown with its argument slot, because the slot is the part the owner fills in.
        // A prefix is shown with its argument slot. The slot's name comes from the table where the
        // table knows it (`<label>` for a checkpoint, `<path>` for a diff), because a help panel that
        // says `<text>` for every prefix teaches the owner to guess what the argument is for.
        syntax: `${entry.prefix} ${entry.argumentLabel ? `<${entry.argumentLabel}>` : entry.kind === ROUTE_KIND.MODE ? '<mode>' : '<text>'}`,
        routeKind: entry.kind,
        summary: entry.summary,
        targetView: entry.targetView ?? null,
        action: entry.action ?? null,
        route: entry.route ?? null,
        argument: entry.kind === ROUTE_KIND.MODE ? [...PRESENTATION_MODES] : null,
        capability: capabilityOf(entry.action ?? null),
      });
    }
    // A line nothing matches is still routed - to the T-29 pipeline - so the help names that too rather
    // than implying the list above is exhaustive of what the bar accepts.
    rows.push({
      syntax: '<anything else>',
      routeKind: ROUTE_KIND.MISSION,
      summary: 'hand the line to the deterministic mission planner as an intent',
      targetView: 'cognition',
      // The fallback does invoke a capability - `cognition.run` - so the help names it rather than
      // implying the line goes nowhere unseen.
      action: 'cognition.run',
      route: null,
      argument: null,
      capability: capabilityOf('cognition.run'),
    });

    return Object.freeze({
      schema: 'apex.command.catalog/1',
      // Listed so the `mode` row's argument slot can be read without guessing at the vocabulary.
      modes: [...PRESENTATION_MODES],
      commands: rows,
      // The keyboard reference. These are the bindings the deck installs, and the end-to-end suite that
      // exercises them reads this same list, so a binding cannot be documented here and missing there.
      shortcuts: [
        { keys: 'Ctrl+K', also: 'Cmd+K', effect: 'focus the command bar from anywhere, including from inside a field' },
        { keys: '/', effect: 'focus the command bar when not typing in a field' },
        { keys: '?', effect: 'open this reference when not typing in a field' },
        { keys: 'Escape', effect: 'dismiss the command bar, this reference, or the boot sequence' },
        { keys: 'Tab', effect: 'move through the HUD in document order' },
        { keys: 'Alt+ArrowRight', also: 'Alt+ArrowLeft', effect: 'move to the next or previous workspace' },
      ],
      // A catalogue describes what exists. It authorizes nothing, changes nothing, and says so.
      readOnly: true,
      wroteNothing: true,
      authorizesExecution: false,
    });
  }

  return Object.freeze({
    schema: ROUTER_SCHEMA,
    routeLine,
    dispatch,
    catalog,
    modes: () => [...PRESENTATION_MODES],
    routes: () => ({ phrases: PHRASES.length, prefixes: PREFIXES.length }),
  });
}
