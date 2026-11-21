// Static browser assets for the local APEX UI. They are served from this module so the
// server needs no filesystem reads and no build step. The client renders every piece of
// text with textContent: model output and stored records are untrusted strings.
// T-30 P0 (2026-11-19): the client is no longer assembled from Node function source.
// One self-contained contract program (client-contract.js) is rendered verbatim below,
// so nothing serialized into the browser can depend on Node module scope.
import { CLIENT_CONTRACT_SOURCE } from './client-contract.js';

export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APEX</title>
<!-- [T-31 Step 3, 2026-11-19] The first real-browser run recorded exactly one console error at the
     first viewport. The page declared no icon, so the browser asked for /favicon.ico, and the
     policy answer was a 404 that Chromium reports as a console error. An empty data: icon means the
     browser asks for nothing; the server also answers the path for clients that ignore the link. -->
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/style.css">
</head>
<body data-core-state="degraded" data-view="deck" data-motion="full" data-mode="classic" data-contrast="standard" data-depth-plane="z0">
<a class="skip-link" href="#main-content">Skip to main content</a>
<div id="hud-grid" data-depth-plane="z1" aria-hidden="true"></div>
<!-- T-35 Step 1: the background particle field, a real layer the step-down ladder can drop. -->
<div id="hud-particles" data-depth-plane="z1" aria-hidden="true"></div>
<div id="boot" class="boot" role="status" aria-live="polite">
  <div class="boot-core" aria-hidden="true"></div>
  <div class="boot-lines" id="boot-lines"></div>
  <button id="boot-skip" type="button" class="quiet">Quick boot</button>
</div>
<header class="topbar">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">A</div>
    <div>
      <h1>APEX</h1>
      <p class="sub">Command Deck &middot; loopback only &middot; verified state only</p>
    </div>
  </div>
  <div class="topbar-meta">
    <span id="clock" class="meta mono"></span>
    <span id="session" class="meta"></span>
    <span id="mode" class="badge">Deck</span>
    <span id="autonomy" class="badge">Autonomy: —</span>
    <span id="connectivity" class="badge">Connecting</span>
    <span id="gauge-cpu" class="badge" aria-label="CPU">CPU: —</span>
    <span id="gauge-mem" class="badge" aria-label="Memory">Mem: —</span>
    <span id="gauge-storage" class="badge" aria-label="Storage">Storage: —</span>
    <!-- T-35 Step 1: Part 4's system sensor and privacy indicator. Every value on it is read from the
         backend: which local sensors are wired, when each last read, and that capture is disabled. -->
    <span id="sensor-privacy-indicator" class="badge" role="status" aria-live="polite"
          data-audio="disabled" data-camera="disabled" aria-label="Local sensors and privacy">Sensors: reading…</span>
  </div>
  <div class="topbar-actions">
    <!-- T-32 Step 1: the command dispatch is reachable from the top bar, so Tab reaches it before the
         workspace tabs, and Ctrl+K or / opens it from anywhere. -->
    <button id="command-trigger" type="button" class="hud-chip" aria-keyshortcuts="Control+K" aria-controls="chat-text">
      Command <kbd>Ctrl K</kbd>
    </button>
    <label class="visually-hidden" for="mode-select">Presentation mode</label>
    <select id="mode-select" class="small" aria-label="Presentation mode">
      <option value="classic">Classic</option>
      <option value="tactical">Tactical</option>
      <option value="overwatch">Overwatch</option>
      <option value="synthesis">Synthesis</option>
      <option value="quiet">Quiet</option>
    </select>
    <button id="motion-toggle" type="button" class="quiet small" aria-pressed="false">Motion: full</button>
    <button id="contrast-toggle" type="button" class="quiet small" aria-pressed="false">Contrast: standard</button>
    <label class="visually-hidden" for="stepdown-select">Visual step-down stage</label>
    <select id="stepdown-select" class="small" aria-label="Visual step-down stage">
      <option value="auto">Step-down: auto</option>
      <option value="0">Stage 0 · nominal</option>
      <option value="1">Stage 1 · drop bloom</option>
      <option value="2">Stage 2 · drop particles</option>
      <option value="3">Stage 3 · drop parallax</option>
      <option value="4">Stage 4 · drop ambient motion</option>
      <option value="5">Stage 5 · flat mode</option>
    </select>
    <button id="new-session" type="button" class="quiet small">New session</button>
    <button id="quick-boot" type="button" class="quiet small">Quick boot</button>
  </div>
</header>
<!-- T-32 Step 1: the command dispatch lives in its own bar between the top bar and the workspace
     tabs. One input, one place, and Tab reaches it before the tabs because that is where it is in
     the document rather than because a tabindex was raised above its neighbours. -->
<section class="command-bar" data-depth-plane="z1" aria-label="Command dispatch">
  <form id="chat-form">
    <label for="chat-text" class="visually-hidden">Message</label>
    <textarea id="chat-text" rows="2" maxlength="4000" placeholder="Command APEX, or ask for a verified read"></textarea>
    <div class="row">
      <button id="send" type="submit">Send</button>
      <span id="activity" class="meta" role="status"></span>
    </div>
  </form>
</section>
<nav class="nav" aria-label="Primary">
  <button type="button" data-view="deck" class="nav-item active" aria-current="page">Deck</button>
  <button type="button" data-view="conversations" class="nav-item">Conversations</button>
  <button type="button" data-view="missions" class="nav-item">Missions</button>
  <button type="button" data-view="tasks" class="nav-item">Tasks</button>
  <button type="button" data-view="approvals" class="nav-item">Approvals</button>
  <button type="button" data-view="sentinel" class="nav-item">Sentinel</button>
  <button type="button" data-view="memory" class="nav-item">Memory</button>
  <button type="button" data-view="documents" class="nav-item">Documents</button>
  <button type="button" data-view="reasoning" class="nav-item">Reasoning</button>
  <button type="button" data-view="council" class="nav-item">Council</button>
  <button type="button" data-view="cognition" class="nav-item">Cognition</button>
  <button type="button" data-view="presence" class="nav-item">Presence</button>
  <button type="button" data-view="system" class="nav-item">System</button>
  <button type="button" data-view="integrations" class="nav-item">Integrations</button>
  <button type="button" data-view="workshop" class="nav-item">Workshop</button>
</nav>
<main id="main-content" class="deck">
  <aside class="rail left" data-depth-plane="z3" aria-label="Missions">
    <section class="panel">
      <h2>Active missions</h2>
      <ul id="missions-list" class="work"></ul>
    </section>
    <section class="panel">
      <h2>TaskGraph</h2>
      <ul id="taskgraph" class="work"></ul>
    </section>
  </aside>
  <section class="stage" data-depth-plane="z3" aria-label="APEX Core">
    <div class="core-wrap">
      <svg class="core" id="core-reticle" data-depth-plane="z2" viewBox="0 0 240 240" role="img" aria-label="APEX Core status" data-ack-state="idle" data-ack-count="0">
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#00e5ff" stop-opacity="0.95"/>
            <stop offset="55%" stop-color="#00e5ff" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#00e5ff" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g class="reticle-azimuth" data-ring="azimuth">
          <circle class="core-halo" cx="120" cy="120" r="96"/>
          <circle class="core-ring outer" cx="120" cy="120" r="88"/>
          <circle class="reticle-tick" cx="120" cy="120" r="96"/>
        </g>
        <g class="reticle-telemetry" data-ring="telemetry">
          <circle class="core-ring mid" cx="120" cy="120" r="70"/>
          <path class="reticle-arc" d="M120 42 A78 78 0 0 1 198 120"/>
        </g>
        <g data-ring="progress">
          <circle class="reticle-progress" cx="120" cy="120" r="64" pathLength="100"/>
        </g>
        <g data-ring="brackets">
          <path d="M18 42 L18 18 L42 18"/>
          <path d="M198 18 L222 18 L222 42"/>
          <path d="M222 198 L222 222 L198 222"/>
          <path d="M42 222 L18 222 L18 198"/>
        </g>
        <g data-ring="nucleus">
          <circle class="core-ring inner" cx="120" cy="120" r="52"/>
          <circle class="core-center" cx="120" cy="120" r="28"/>
          <circle class="reticle-ack" cx="120" cy="120" r="34"/>
        </g>
        <g class="core-segments">
          <path d="M120 32 A88 88 0 0 1 208 120"/>
          <path d="M208 120 A88 88 0 0 1 120 208"/>
          <path d="M120 208 A88 88 0 0 1 32 120"/>
          <path d="M32 120 A88 88 0 0 1 120 32"/>
        </g>
      </svg>
      <div class="core-state" id="core-state" role="status" aria-live="polite">Degraded</div>
      <p class="core-caption" id="core-caption">Waiting for an authoritative owner snapshot.</p>
      <!-- T-35 Step 1: which rung of the visual ladder the deck is on, and why. -->
      <span id="stepdown-state" class="badge" role="status" aria-live="polite"
            data-stage="0" data-source="auto">Step-down: reading…</span>
    </div>
    <!-- T-33 Step 2 (2026-11-19): the executive comms layer. The same facts in the voice of the
         mode the owner selected; the formatter withholds every flourish while anything is wrong. -->
    <section class="panel exec-comms" id="exec-comms-panel" data-depth-plane="z3" aria-label="Executive comms">
      <h2>Executive comms</h2>
      <p id="exec-comms-headline" class="exec-comms-headline" role="status" aria-live="polite">Reading the deck…</p>
      <ul id="exec-comms-lines" class="work"></ul>
      <p id="exec-comms-tone" class="meta" role="status"></p>
    </section>
    <section class="panel conversation" id="conversation-panel">
      <h2>Conversation</h2>
      <div id="banner" class="banner" data-depth-plane="z4" role="alert" hidden></div>
      <ol id="turns" class="turns"></ol>
      <p class="meta">Dispatch is the command bar above the tabs (Ctrl+K or /).</p>
    </section>
  </section>
  <aside class="rail right" data-depth-plane="z3" aria-label="Sentinel and approvals">
    <section class="panel">
      <h2>Sentinel</h2>
      <ul id="sentinel" class="work"></ul>
    </section>
    <section class="panel">
      <!-- T-32 Step 3: perception of the machine APEX is running on, on the deck itself. -->
      <h2>Perception</h2>
      <p id="perception-status" class="workspace-status" role="status" aria-live="polite">Loading host reading…</p>
      <ul id="perception-summary" class="work"></ul>
    </section>
    <section class="panel">
      <h2>Approvals</h2>
      <ul id="approvals" class="work"></ul>
    </section>
    <section class="panel">
      <h2>Briefings</h2>
      <p id="briefing-status" class="workspace-status" role="status" aria-live="polite">Loading recorded briefing…</p>
      <p id="briefing-perception" class="meta" role="status"></p>
      <ul id="briefings" class="work"></ul>
      <!-- T-34 Step 3: what changed since the owner last acknowledged a briefing, with a link to the
           view and the task each change belongs to, and the control that writes the next checkpoint. -->
      <h3>Changes since last briefing</h3>
      <p id="briefing-delta-status" class="workspace-status" role="status" aria-live="polite">Loading what changed…</p>
      <ul id="briefing-delta" class="work"></ul>
      <div class="row">
        <label for="briefing-ack-reason" class="visually-hidden">Reason for this checkpoint</label>
        <input id="briefing-ack-reason" type="text" maxlength="240" placeholder="optional reason for this checkpoint">
        <button id="briefing-acknowledge" type="button" class="small">Acknowledge briefing</button>
        <span id="briefing-ack-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <p class="meta">Acknowledging writes a checkpoint of what the stores hold now; it authorizes nothing and changes no other record.</p>
    </section>
  </aside>
</main>
<section class="workspace" id="workspace">
  <section class="view" data-view="conversations" data-depth-plane="z3">
    <h2>Conversations</h2>
    <p class="meta">Session persistence and history. The current session is shown on the deck; older turns remain in the conversation log.</p>
    <p id="conversation-status" class="workspace-status" role="status" aria-live="polite">Loading conversation records…</p>
    <ul id="conversation-history" class="work"></ul>
  </section>
  <section class="view" data-view="missions" data-depth-plane="z3">
    <h2>Mission Control</h2>
    <p class="meta">Goals, plans and tasks projected from their owning stores. Dependencies, blockers, checkpoints and verification are shown only when recorded; a plan or approval does not start work.</p>
    <p id="mission-status" class="workspace-status" role="status" aria-live="polite">Loading owner records…</p>
    <section class="panel">
      <h3>Goals and criteria</h3>
      <p id="mission-goals-status" class="workspace-status" role="status" aria-live="polite">Loading goals…</p>
      <ul id="goals" class="work"></ul>
    </section>
    <section class="panel">
      <h3>Plans and checkpoints</h3>
      <p id="mission-plans-status" class="workspace-status" role="status" aria-live="polite">Loading plans…</p>
      <ul id="plans" class="work"></ul>
    </section>
    <section class="panel">
      <h3>TaskGraph and blocked work</h3>
      <p id="mission-tasks-status" class="workspace-status" role="status" aria-live="polite">Loading tasks…</p>
      <ul id="mission-tasks" class="work"></ul>
    </section>
    <!-- T-33 Step 3 (2026-11-19): the recorded graph itself - nodes, dependency edges, per-node
         state and verification - with the owner controls that already exist on the controller. -->
    <section class="panel">
      <h3>TaskGraph — dependency and checkpoint view</h3>
      <p class="meta">Each node is a recorded step. Its state and its verification come from the task log; the controls post to the controller routes that already exist. A verified badge appears only when the step's own record says the verifier confirmed it.</p>
      <!-- T-34 Step 1: an explicit mission launcher. The mission is named, not inferred: the
           compiler holds one fixed template and the button starts that template, gated. -->
      <div class="row">
        <label for="mission-select">Start a mission</label>
        <select id="mission-select">
          <option value="audit_and_stage">audit_and_stage — sense, fan out, verify, read back</option>
        </select>
        <input id="mission-artifact" type="text" maxlength="64" placeholder="workshop artifact id (ws-…)">
        <button id="mission-run" type="button" class="small">Compile and start the mission</button>
        <span id="mission-run-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <div class="row">
        <label for="taskgraph-select">Recorded task</label>
        <select id="taskgraph-select">
          <option value="">newest unfinished task</option>
        </select>
        <span class="meta">Switching reads that task's own log; nothing is re-run by looking.</span>
      </div>
      <p id="dag-status" class="workspace-status" role="status" aria-live="polite">Loading the recorded graph…</p>
      <ul id="dag-nodes" class="work dag"></ul>
      <p id="dag-edges" class="meta"></p>
      <div class="row">
        <button id="dag-approve" type="button" class="small" hidden>Approve checkpoint</button>
        <button id="dag-resume" type="button" class="small" hidden>Resume recorded task</button>
        <button id="dag-retry" type="button" class="small" hidden>Retry failed node</button>
        <button id="dag-cancel" type="button" class="small" hidden>Abort mission</button>
        <span id="dag-control-status" class="meta" role="status" aria-live="polite"></span>
      </div>
    </section>
  </section>
  <section class="view" data-view="tasks" data-depth-plane="z3">
    <h2>Tasks and execution</h2>
    <p id="task-status" class="workspace-status" role="status" aria-live="polite">Loading tasks…</p>
    <ul id="tasks" class="work"></ul>
    <form id="planning-form" class="row">
      <label for="planning-objective" class="visually-hidden">Objective</label>
      <textarea id="planning-objective" rows="2" maxlength="500" placeholder="Objective for a bounded plan read"></textarea>
      <input id="planning-goal" type="text" maxlength="64" placeholder="optional goal id">
      <button id="planning-read" type="submit" class="small">Read plan</button>
      <span id="planning-status" class="meta" role="status"></span>
    </form>
    <ul id="planning" class="work"></ul>
  </section>
  <section class="view" data-view="approvals" data-depth-plane="z3">
    <h2>Approval Centre</h2>
    <p class="meta">Pending requests come from TaskStore, PlanStore and Sentinel records. Approving records intent only; it does not start a task or run a response. Risk, scope, reversibility and expiry are not inferred when an owner did not record them.</p>
    <p id="approval-state" class="workspace-status" role="status" aria-live="polite">Loading pending owner requests…</p>
    <p id="approval-action-status" class="workspace-status" role="status" aria-live="polite"></p>
    <ul id="approval-items" class="work"></ul>
  </section>
  <section class="view" data-view="sentinel" data-depth-plane="z3">
    <h2>Sentinel — recorded situational events</h2>
    <p class="meta">A bounded view of recorded observations, assessments, decisions and provenance. It does not imply that an external source is currently being watched.</p>
    <p id="sentinel-status" class="workspace-status" role="status" aria-live="polite">Loading situational records…</p>
    <ul id="sentinel-full" class="work"></ul>
    <section class="panel">
      <!-- T-32 Step 3: the perception ledger and the push discipline. The budget and the
           suppressions are the Sentinel's own rules, shown where the owner can revoke them. -->
      <h3>Perception — host and workspace</h3>
      <p class="meta">Read-only readings of this machine and the configured workspace. A value that could not be read is shown as unavailable; it is never shown as zero.</p>
      <p id="perception-detail-status" class="workspace-status" role="status" aria-live="polite">Loading perception ledger…</p>
      <div class="row">
        <button id="perception-sense" type="button" class="small">Sense host now</button>
        <span id="perception-budget" class="badge">Push budget: —</span>
        <span id="perception-sense-status" class="meta" role="status"></span>
      </div>
      <p id="perception-alert-policy" class="meta">Push policy: at most three non-critical notices an hour; two dismissals of one alert class suppress it for six hours; a safety, lockdown or degraded notice bypasses the cap.</p>
      <!-- T-34 Step 3: the watch rules themselves. Each line states the boundary it fires on, the
           last condition it raised, how many times it has fired and when it last did; a rule that has
           never fired says so rather than showing an invented count. -->
      <p id="perception-watch-status" class="workspace-status" role="status" aria-live="polite">Loading watch rules…</p>
      <ul id="perception-watches" class="work"></ul>
      <p id="perception-alert-status" class="workspace-status" role="status" aria-live="polite"></p>
      <ul id="perception-alerts" class="work"></ul>
      <ul id="perception-observations" class="work"></ul>
      <ul id="perception-suppressions" class="work"></ul>
    </section>
  </section>
  <section class="view" data-view="memory" data-depth-plane="z3">
    <h2>Memory Timeline</h2>
    <p class="meta">Chronological records from MemoryStore, KnowledgeStore and WorldModelStore. Corrections and lifecycle events are kept as provenance-linked history; the timeline does not make claims true.</p>
    <p id="timeline-status" class="workspace-status" role="status" aria-live="polite">Loading memory and world-model records…</p>
    <h3>Combined timeline</h3>
    <ul id="memory-timeline" class="work"></ul>
    <h3>Memory and corrections</h3>
    <p id="memory-records-status" class="workspace-status" role="status" aria-live="polite">Loading memory…</p>
    <ul id="memory" class="work"></ul>
    <h3>Knowledge and lifecycle changes</h3>
    <p id="knowledge-status" class="workspace-status" role="status" aria-live="polite">Loading knowledge…</p>
    <ul id="knowledge" class="work"></ul>
    <h3>World-model changes</h3>
    <p id="world-status" class="workspace-status" role="status" aria-live="polite">Loading world-model history…</p>
    <ul id="world" class="work"></ul>
    <!-- T-34 Step 2: candidate associative recall. A recall is a guess from a prior episode, so it
         is shown as its own class, with its source record and the terms that produced it, and never
         beside the observations as if it were one. -->
    <h3>Candidate associations</h3>
    <p class="meta">Prior episodes recalled as candidates for a later intent. Each one names the record it came from and the terms it matched; none of them is an observation, a fact or a permission.</p>
    <p id="associations-status" class="workspace-status" role="status" aria-live="polite">Loading candidate associations…</p>
    <ul id="associations" class="work"></ul>
  </section>
  <section class="view" data-view="documents" data-depth-plane="z3">
    <h2>Authorized documents</h2>
    <p id="documents-status" class="workspace-status" role="status" aria-live="polite">Loading document index…</p>
    <form id="doc-search-form" class="row">
      <label for="doc-search" class="visually-hidden">Search documents</label>
      <input id="doc-search" type="search" maxlength="500" placeholder="Search exact terms">
      <button id="doc-search-button" type="submit" class="small">Search</button>
    </form>
    <ul id="documents" class="work"></ul>
  </section>
  <section class="view" data-view="reasoning" data-depth-plane="z3">
    <h2>Reasoning workspace</h2>
    <p class="meta">Deterministic, evidence-linked reasoning records. This view reads stored sessions; it does not run inference or authorize actions.</p>
    <p id="reasoning-status" class="workspace-status" role="status" aria-live="polite">Loading reasoning records…</p>
    <ul id="reasoning" class="work"></ul>
  </section>
  <section class="view" data-view="council" data-depth-plane="z3">
    <h2>Council</h2>
    <p class="meta">Seven deterministic perspectives over evidence owned by the existing stores. This is not multi-model deliberation: no model is contacted. A synthesis explains disagreement and never authorizes execution.</p>
    <p id="council-state" class="workspace-status" role="status" aria-live="polite">Loading recorded council sessions…</p>
    <form id="council-form" class="row">
      <label for="council-objective" class="visually-hidden">Objective</label>
      <textarea id="council-objective" rows="2" maxlength="2000" placeholder="Objective to deliberate"></textarea>
      <label class="meta"><input id="council-gather" type="checkbox" checked> gather real evidence</label>
      <button id="council-run" type="submit" class="small">Deliberate</button>
      <span id="council-status" class="meta" role="status"></span>
    </form>
    <div id="council-synthesis" class="panel"></div>
    <ul id="council" class="work"></ul>
  </section>
  <section class="view" data-view="cognition" data-depth-plane="z3">
    <h2>Unified cognition — T-29 pipeline</h2>
    <p class="meta">One owner intent through five recorded stages: context packet, salience and Sentinel advisories, Council synthesis, task graph, and governed execution. Every value below is read from the run record. A recommendation is deliberation data, never a permission; a gated step executes only after the ECP authorizes it and you approve it yourself.</p>
    <p id="cognition-status" class="workspace-status" role="status" aria-live="polite">Loading recorded cognitive runs…</p>
    <form id="cognition-form" class="row">
      <label for="cognition-intent" class="visually-hidden">Intent</label>
      <textarea id="cognition-intent" rows="2" maxlength="500" placeholder="What should APEX work through? e.g. what does memory hold about the launch checklist"></textarea>
      <label for="cognition-action" class="visually-hidden">Capability</label>
      <select id="cognition-action">
        <option value="">classify from the intent</option>
        <option value="memory.search">memory.search (read)</option>
        <option value="memory.add">memory.add (write, gated)</option>
      </select>
      <button id="cognition-run" type="submit" class="small">Run pipeline</button>
      <span id="cognition-run-status" class="meta" role="status" aria-live="polite"></span>
    </form>
    <div id="cognition-trace" class="panel" aria-live="polite"></div>
    <h3>Epistemic world model</h3>
    <p class="meta">Every stored belief is shown with the label its own record carries: <strong>observed</strong>, <strong>inferred</strong>, <strong>assumed</strong> or <strong>predicted</strong>. A label describes how the record came to exist. It is not a claim that the belief is true, and an assumption is never shown as an observation.</p>
    <p id="world-labels" class="meta"></p>
    <ul id="world-claims" class="work"></ul>
    <h3>Recorded runs</h3>
    <ul id="cognition-runs" class="work"></ul>
  </section>
  <section class="view" data-view="presence" data-depth-plane="z3">
    <h2>Presence, device trust and autonomy policy</h2>
    <p class="meta">Device trust is an append-only enrollment log: a trusted device authenticates signed messages and grants no capability. Autonomy is read-only here. It is configured through the APEX_AUTONOMY_LEVELS environment at start-up, and the matrix below reports the level the ECP actually applies, not a value this page can change.</p>
    <p id="presence-status" class="workspace-status" role="status" aria-live="polite">Loading device trust and presence…</p>
    <h3>Devices</h3>
    <ul id="presence-devices" class="work"></ul>
    <h3>Mesh</h3>
    <ul id="presence-mesh" class="work"></ul>
    <!-- T-35 Step 2: the handoff envelopes. Staging is a governed write, so the form is a request and
         the answer below it is the ledger's, not the form's. The paragraph states the limit of what
         this is before the owner uses it: a local envelope, not a remote handoff. -->
    <h3>Handoff envelopes</h3>
    <p class="meta">A handoff names the view, mission and artifact the owner wants next, on a device they have already enrolled. It is stored locally with a SHA-256 digest, it expires, and it can be collected once by the device it names. There is no remote transport: the target device has to be this installation. An envelope grants no capability — after it is claimed, every action is still authorized by the ECP.</p>
    <p id="handoff-status" class="workspace-status" role="status" aria-live="polite">Loading the handoff ledger…</p>
    <div class="handoff-form">
      <label for="handoff-source">From device</label>
      <select id="handoff-source"></select>
      <label for="handoff-target">To device</label>
      <select id="handoff-target"></select>
      <label for="handoff-view">Open view</label>
      <select id="handoff-view">
        <option value="deck">deck</option>
        <option value="missions">missions</option>
        <option value="tasks">tasks</option>
        <option value="approvals">approvals</option>
        <option value="reasoning">reasoning</option>
        <option value="cognition">cognition</option>
        <option value="documents">documents</option>
        <option value="memory">memory</option>
        <option value="workshop">workshop</option>
        <option value="system">system</option>
        <option value="presence">presence</option>
      </select>
      <label for="handoff-task">Mission id (optional)</label>
      <input id="handoff-task" type="text" maxlength="96" placeholder="task id">
      <label for="handoff-note">Note (optional)</label>
      <input id="handoff-note" type="text" maxlength="240" placeholder="what to pick up">
      <button id="handoff-stage" type="button" class="small">Stage handoff</button>
    </div>
    <p id="handoff-message" class="meta" role="status" aria-live="polite"></p>
    <ul id="handoff-list" class="work"></ul>
    <h3>Autonomy policy</h3>
    <p id="autonomy-status" class="workspace-status" role="status" aria-live="polite">Loading the autonomy matrix…</p>
    <table class="matrix" aria-describedby="autonomy-note">
      <caption id="autonomy-note" class="meta">L0 Observe · L1 Suggest · L2 Confirm · L3 Delegate (bounded) · L4 Mission · L5 Standing orders</caption>
      <thead>
        <tr><th scope="col">Domain</th><th scope="col">Level</th><th scope="col">Capabilities</th><th scope="col">Source</th></tr>
      </thead>
      <tbody id="autonomy-matrix"></tbody>
    </table>
    <h3>Capabilities in the matrix</h3>
    <ul id="autonomy-capabilities" class="work"></ul>
  </section>
  <section class="view" data-view="system" data-depth-plane="z3">
    <h2>System diagnostics and Resource Fabric</h2>
    <p class="meta">Read-only diagnostics from the health, runtime, ECP and resource owners. Unknown or unavailable readings are not treated as healthy.</p>
    <p id="system-status" class="workspace-status" role="status" aria-live="polite">Loading system diagnostics…</p>
    <!-- T-35 Step 3: the doctor. Six read-only checks, each reporting the state it can defend. -->
    <section class="panel" aria-labelledby="doctor-heading">
      <h3 id="doctor-heading">Doctor</h3>
      <p class="meta">Six read-only checks inside a 500 ms budget: the safety latch, ECP authority, store readability, the capability inventory, a browser binary, and the workspace sensor. A check that cannot be made says so; nothing here is repaired by running it.</p>
      <p id="doctor-status" class="workspace-status" role="status" aria-live="polite">The doctor has not run yet.</p>
      <button id="doctor-run" type="button" class="small">Run doctor</button>
      <ul id="doctor-checks" class="work"></ul>
    </section>
    <section class="panel safety" data-depth-plane="z4" aria-labelledby="safety-heading">
      <h3 id="safety-heading">Execution safety</h3>
      <p id="safety-status" class="meta" role="status" aria-live="polite">Reading the ECP safety latch…</p>
      <form id="safety-lock-form" class="safety-form">
        <label for="safety-lock-reason">Lockdown reason</label>
        <textarea id="safety-lock-reason" rows="2" maxlength="240" required></textarea>
        <button id="safety-lock" type="submit" class="small">Activate lockdown</button>
        <span id="safety-lock-result" class="meta" role="status" aria-live="polite"></span>
      </form>
      <form id="safety-release-form" class="safety-form">
        <label for="safety-release-reason">Release reason</label>
        <textarea id="safety-release-reason" rows="2" maxlength="240" required></textarea>
        <label class="safety-confirm"><input id="safety-release-confirm" type="checkbox" required> I have reviewed the latch and explicitly confirm release</label>
        <div id="safety-step-up-wrap" hidden>
          <label for="safety-step-up">Step-up proof</label>
          <input id="safety-step-up" type="password" autocomplete="off" maxlength="200" placeholder="the configured step-up secret">
          <p id="safety-step-up-note" class="meta">A step-up secret is configured, so the release is refused without it.</p>
        </div>
        <button id="safety-release" type="submit" class="small" disabled>Release lockdown</button>
        <span id="safety-release-result" class="meta" role="status" aria-live="polite"></span>
      </form>
    </section>
    <div id="health-overall" class="row"></div>
    <ul id="health" class="work"></ul>
    <h3>Runtime</h3>
    <ul id="runtime" class="work"></ul>
    <h3>External sources</h3>
    <ul id="sources" class="work"></ul>
    <h3>Resource Fabric</h3>
    <p id="resources-status" class="workspace-status" role="status" aria-live="polite">Loading resource telemetry…</p>
    <ul id="resources" class="work"></ul>
  </section>
  <section class="view" data-view="integrations" data-depth-plane="z3">
    <h2>Integrations</h2>
    <p id="integrations-status" class="workspace-status" role="status" aria-live="polite">Loading integration state…</p>
    <ul id="integrations" class="work"></ul>
  </section>
  <section class="view" data-view="workshop" data-depth-plane="z3">
    <h2>Workshop — deterministic design sheets</h2>
    <p class="meta">This is not a 3D or interactive holographic workspace. It stores design sheets and performs arithmetic over declared values. Nothing here is executed, and a simulation never authorizes an action.</p>
    <p id="workshop-state" class="workspace-status" role="status" aria-live="polite">Loading stored designs…</p>
    <form id="workshop-form" class="row">
      <label for="workshop-title" class="visually-hidden">Title</label>
      <input id="workshop-title" maxlength="160" placeholder="Design title">
      <label for="workshop-domain" class="visually-hidden">Domain</label>
      <select id="workshop-domain">
        <option value="generic">generic</option>
        <option value="code">code</option>
        <option value="circuit">circuit</option>
        <option value="cad">cad</option>
        <option value="data">data</option>
        <option value="plan">plan</option>
      </select>
      <label for="workshop-budget" class="visually-hidden">Budget</label>
      <input id="workshop-budget" type="number" min="0" step="any" placeholder="budget (optional)">
      <label for="workshop-source" class="visually-hidden">Components and connections</label>
      <textarea id="workshop-source" rows="5" placeholder='{"components":[{"id":"api","kind":"service","supply":10},{"id":"db","kind":"store","demand":8}],"connections":[{"from":"api","to":"db"}]}'></textarea>
      <button id="workshop-compose" type="submit" class="small">Compose</button>
      <span id="workshop-status" class="meta" role="status"></span>
    </form>
    <!-- T-33 Step 3 (2026-11-19): the sandbox loop. A verification is a fixed check list over the
         stored sheet; a promotion is refused unless the newest recorded verification passed. -->
    <p class="meta">The sandbox verification checks structure, resolved connections, isolation, feedback loops, supply against demand, and the declared budget. A verified badge appears only after the backend records <code>verified: true</code>, and a promotion refuses without one.</p>
    <div class="row">
      <button id="workshop-stage-telemetry" type="button" class="small">Stage from telemetry</button>
      <span id="workshop-sandbox-status" class="meta" role="status" aria-live="polite"></span>
    </div>
    <div id="workshop-report" class="panel"></div>
    <ul id="workshop" class="work"></ul>
    <h3>Evolution Lab — controlled self-change</h3>
    <p class="meta">A proposal is a recorded idea about APEX's own behaviour. It authorizes nothing and changes nothing. Promotion is refused unless a sandbox run recorded a passing result, and only you can decide a promotion; the lab applies no change by itself.</p>
    <p id="evolution-status" class="workspace-status" role="status" aria-live="polite">Loading the evolution ledger…</p>
    <form id="evolution-form" class="row">
      <label for="evolution-title" class="visually-hidden">Proposal title</label>
      <input id="evolution-title" maxlength="160" placeholder="Proposal title">
      <label for="evolution-hypothesis" class="visually-hidden">Hypothesis</label>
      <input id="evolution-hypothesis" maxlength="2000" placeholder="Hypothesis (optional)">
      <button id="evolution-propose" type="submit" class="small">Record proposal</button>
      <span id="evolution-form-status" class="meta" role="status" aria-live="polite"></span>
    </form>
    <ul id="evolution-proposals" class="work"></ul>
    <h3>Immutable safety boundaries</h3>
    <p id="evolution-boundaries-status" class="meta" role="status" aria-live="polite"></p>
    <ul id="evolution-boundaries" class="work"></ul>
    <p id="evolution-policy" class="meta"></p>
  </section>
</section>
<script src="/app.js"></script>
</body>
</html>
`;

export const UI_CSS = `/* T-30 Package 5 (2026-11-19): design tokens from the master document Part 4.
   The legacy aliases below keep every pre-existing rule meaningful, so the tokens changed
   the vocabulary without silently restyling rules that were never reviewed. */
:root {
  --bg-void: #05080f;
  --bg-deep: #0a1220;
  --glass: rgba(12, 28, 48, 0.55);
  --glass-strong: rgba(16, 34, 58, 0.82);
  --arc-cyan: #00e5ff;
  --armor-gold: #ffb000;
  --armor-red: #e10600;
  --armor-red-text: #ff6b5a;
  --ok-green: #2bff88;
  --text: #dcebff;
  --text-dim: #7fa3c7;
  --line: rgba(84, 132, 176, 0.28);
  --line-strong: rgba(0, 229, 255, 0.42);
  --radius: 2px;
  --bg0: var(--bg-void);
  --bg1: var(--bg-deep);
  --panel: var(--glass);
  --panel-strong: var(--glass-strong);
  --cyan: var(--arc-cyan);
  --gold: var(--armor-gold);
  --red: var(--armor-red);
  --green: var(--ok-green);
  --muted: var(--text-dim);
  --font-display: "Orbitron", "Rajdhani", "Segoe UI", sans-serif;
  --font-body: "Exo 2", "Inter", "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "Share Tech Mono", "Consolas", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font: 15px/1.5 var(--font-body);
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background:
    radial-gradient(circle at 50% 42%, rgba(0, 229, 255, 0.12), transparent 34%),
    radial-gradient(circle at 80% 10%, rgba(255, 176, 0, 0.08), transparent 28%),
    linear-gradient(180deg, var(--bg1), var(--bg0));
  background-color: var(--bg-void);
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.16;
  background:
    repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 3px),
    radial-gradient(circle at 50% 50%, transparent 0, rgba(0,0,0,0.35) 100%);
  mix-blend-mode: screen;
}
.command-bar {
  display: flex; flex-wrap: wrap; gap: .5rem; align-items: flex-start;
  padding: .55rem 1.25rem; border-bottom: 1px solid var(--line);
  background: rgba(5, 8, 15, 0.66); backdrop-filter: blur(14px);
}
.command-bar form { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; flex: 1 1 24rem; min-width: 0; }
.command-bar textarea { flex: 1 1 18rem; min-width: 0; height: 2.6rem; min-height: 2.6rem; resize: vertical; }
/* Narrow viewports: a command bar and a perception reading hold long unbroken tokens (a path, a
   subject name), and an item that cannot wrap is what pushes a 390px page sideways. */
.command-bar, .command-bar form, .command-bar .row { min-width: 0; max-width: 100%; }
.item .title, .item .meta, .workspace-status, #perception-budget, #perception-summary .title,
#perception-observations .title, #briefing-perception { overflow-wrap: anywhere; }
.skip-link { position: absolute; left: -999px; top: 0; }
.skip-link:focus { left: 1rem; top: 1rem; z-index: 100; background: var(--panel-strong); padding: .5rem; border-radius: 8px; }
.topbar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1rem;
  align-items: center;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--line);
  background: rgba(5, 8, 15, 0.72);
  backdrop-filter: blur(14px);
}
.brand { display: flex; gap: .85rem; align-items: center; }
.brand-mark {
  width: 42px; height: 42px; border-radius: 50%;
  display: grid; place-items: center;
  font-family: var(--font-display); font-weight: 700; color: var(--cyan);
  border: 1px solid var(--line-strong); box-shadow: 0 0 24px rgba(0,229,255,0.22);
  background: radial-gradient(circle, rgba(0,229,255,0.16), transparent 70%);
}
h1 { margin: 0; font-family: var(--font-display); font-size: 1.35rem; letter-spacing: .18em; }
.sub, .meta { color: var(--muted); margin: 0; font-size: .82rem; }
.topbar-meta, .topbar-actions, .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.badge {
  border: 1px solid var(--line); border-radius: 999px; padding: .15rem .55rem;
  font-size: .72rem; color: var(--muted); background: rgba(0,0,0,0.25);
}
.nav {
  display: flex; gap: .35rem; padding: .65rem 1.25rem; overflow-x: auto;
  border-bottom: 1px solid var(--line); background: rgba(5,8,15,0.5);
}
.nav-item {
  background: transparent; color: var(--muted); border: 1px solid var(--line);
  border-radius: 8px; padding: .35rem .7rem; cursor: pointer; font-size: .82rem;
}
.nav-item.active { color: var(--cyan); border-color: var(--line-strong); box-shadow: 0 0 18px rgba(0,229,255,0.16); }
.deck {
  display: grid;
  grid-template-columns: minmax(18rem, 1fr) minmax(22rem, 1.35fr) minmax(18rem, 1fr);
  gap: 1rem; padding: 1rem 1.25rem 6rem; align-items: start;
}
.rail, .panel, .stage {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  backdrop-filter: blur(12px);
}
.panel { padding: 1rem; min-width: 0; }
.rail { padding: .85rem; display: grid; gap: 1rem; align-content: start; }
h2 { margin: 0 0 .6rem; font-family: var(--font-display); font-size: .95rem; letter-spacing: .12em; color: var(--cyan); }
h3 { margin: .8rem 0 .4rem; font-size: .85rem; color: var(--gold); }
.work { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
.item { border: 1px solid var(--line); border-radius: 10px; padding: .6rem .7rem; background: rgba(0,0,0,0.18); }
.item .title { font-weight: 600; word-break: break-word; }
.item .meta { color: var(--muted); font-size: .8rem; margin-top: .25rem; }
.turns { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: .65rem; max-height: 42vh; overflow-y: auto; }
.turn { border-left: 3px solid var(--line); padding: .3rem 0 .3rem .7rem; }
.turn.user { border-left-color: var(--cyan); }
.turn.apex { border-left-color: var(--gold); }
.turn .who { font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.turn pre { white-space: pre-wrap; word-break: break-word; margin: .2rem 0 0; font: inherit; }
.stage { display: grid; gap: 1rem; padding: 1rem; }
.core-wrap { display: grid; place-items: center; gap: .4rem; padding: 1rem; }
.core { width: min(260px, 70vw); height: auto; filter: drop-shadow(0 0 18px rgba(0,229,255,0.25)); }
.core-halo { fill: url(#coreGlow); opacity: 0.9; }
.core-ring { fill: none; stroke: var(--cyan); stroke-width: 1.5; opacity: 0.7; }
.core-ring.outer { stroke-dasharray: 8 6; animation: spin 18s linear infinite; }
.core-ring.mid { stroke-dasharray: 4 10; animation: spin 12s linear infinite reverse; }
.core-ring.inner { stroke: var(--gold); opacity: 0.55; }
.core-center { fill: rgba(0,229,255,0.18); stroke: var(--cyan); stroke-width: 1.5; }
.core-segments path { fill: none; stroke: var(--cyan); stroke-width: 2; opacity: 0.55; stroke-linecap: round; }
.core-state { font-family: var(--font-display); letter-spacing: .18em; color: var(--cyan); }
.core-caption { color: var(--muted); font-size: .82rem; text-align: center; max-width: 24rem; }
body[data-core-state="idle"] .core-halo { animation: breathe 3.2s ease-in-out infinite; }
body[data-core-state="thinking"] .core-ring.outer { animation-duration: 4s; stroke: var(--gold); }
body[data-core-state="awaiting_approval"] .core-ring.outer { stroke: var(--gold); stroke-dasharray: 2 8; }
body[data-core-state="uncertain"] .core-ring, body[data-core-state="uncertain"] .core-center { stroke: var(--gold); }
body[data-core-state="uncertain"] .core-center { fill: rgba(255,176,0,0.16); }
body[data-core-state="executing"] .core-center { fill: rgba(43,255,136,0.22); stroke: var(--green); }
body[data-core-state="degraded"] .core { filter: drop-shadow(0 0 12px rgba(255,176,0,0.35)); opacity: 0.82; }
body[data-core-state="degraded"] .core-ring.outer { animation: none; stroke: var(--gold); }
body[data-core-state="lockdown"] .core { filter: drop-shadow(0 0 18px rgba(225,6,0,0.5)); transform: scale(.88); }
body[data-core-state="lockdown"] .core-ring, body[data-core-state="lockdown"] .core-center { stroke: var(--red); }
body[data-motion="reduced"] .core-ring, body[data-motion="reduced"] .core-segments path, body[data-motion="reduced"] .core-halo { animation: none !important; }
.safety { margin: .75rem 0 1rem; }
.safety-form { display: grid; gap: .45rem; margin-top: .75rem; max-width: 40rem; }
.safety-form label { color: var(--text); font-size: .84rem; }
.safety-form button { justify-self: start; }
.safety-confirm { display: flex; gap: .45rem; align-items: center; }
#safety-status[data-safety="active"] { color: var(--armor-red-text); }
#safety-status[data-safety="clear"] { color: var(--green); }
#safety-status[data-safety="unavailable"] { color: var(--gold); }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 50% { opacity: .55; transform: scale(.96); } }
.core, .core-ring, .core-segments, .core-segments path { transform-origin: 120px 120px; transform-box: view-box; }
.core-segments { transform-origin: 120px 120px; }
button { background: var(--cyan); color: #04131a; border: 0; border-radius: 8px; padding: .45rem .8rem; font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
button.quiet { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; }
button.small { padding: .2rem .5rem; font-size: .8rem; }
input, textarea, select {
  background: rgba(0,0,0,0.35); color: var(--text); border: 1px solid var(--line);
  border-radius: 8px; padding: .45rem .6rem; font: inherit;
}
textarea { width: 100%; resize: vertical; }
.banner { border: 1px solid var(--gold); color: var(--gold); border-radius: 8px; padding: .5rem .7rem; margin-bottom: .75rem; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.mono { font-family: var(--font-mono); }
.workspace { padding: 0 1.25rem 2rem; }
.workspace-status { margin: .25rem 0 .65rem; padding: .3rem 0; color: var(--muted); font-size: .82rem; }
.workspace-status[data-state="error"], .workspace-status[data-state="unavailable"] { color: var(--gold); }
.workspace-status[data-state="partial"] { color: var(--gold); }
.item form.row { margin-top: .5rem; flex-wrap: wrap; align-items: flex-start; }
/* T-33 Step 2: the executive comms panel. The tone line is deliberately plain: a voice that has
   withheld its wit should look like a statement, not like an alert. */
.exec-comms { margin-top: .75rem; }
.exec-comms-headline { font-size: 1.05rem; letter-spacing: .01em; margin: .25rem 0 .5rem; }
.exec-comms #exec-comms-lines .item .title { opacity: .82; }
.exec-comms[data-wit-allowed="false"] .exec-comms-headline { color: var(--hud-text, #d7e3f4); }
.item .plan-cancel { margin-top: .5rem; }
.item .plan-cancel textarea, .item .approval-decision textarea { min-height: 2.4rem; }
.view > .panel { margin: .75rem 0; }
.view { display: none; }
.view.active { display: block; }
.view h2 { margin-bottom: .8rem; }
/* T-30 Package 5: focus, motion, modes, contrast and responsive layout. */
:focus-visible { outline: 2px solid var(--arc-cyan); outline-offset: 2px; }
button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--arc-cyan); outline-offset: 2px; }
.badge, .meta.mono, #clock, #gauge-cpu, #gauge-mem, #gauge-storage { font-variant-numeric: tabular-nums; }
.item, .banner, .badge, input, textarea, select, button { border-radius: var(--radius); }
.badge { border-radius: 999px; }
.panel, .rail, .stage, .view { min-width: 0; overflow-wrap: anywhere; }
.panel pre, .item pre { max-width: 100%; overflow-x: auto; }
/* Presentation modes: palette emphasis only. They never change authorization or state. */
body[data-mode="tactical"] { --cyan: #2fd0ff; --gold: #ff7a00; --line-strong: rgba(47, 208, 255, 0.5); }
body[data-mode="tactical"] .core-ring.mid { animation-duration: 7s; }
body[data-mode="overwatch"] { --cyan: #ff4d3d; --gold: #ffb000; --line-strong: rgba(255, 77, 61, 0.55); }
body[data-mode="overwatch"]::before { opacity: 0.24; }
body[data-mode="overwatch"] .core-ring.outer { stroke-dasharray: 2 4; }
body[data-mode="synthesis"] { --cyan: #ffd166; --gold: #fff3d6; --line-strong: rgba(255, 209, 102, 0.5); }
body[data-mode="synthesis"] .core-ring.mid { animation-duration: 26s; }
body[data-mode="quiet"] { --cyan: #c9d6e4; --gold: #9aafc4; --muted: #8a9bae; --line: rgba(150, 168, 190, 0.22); }
body[data-mode="quiet"]::before { opacity: 0.05; }
body[data-mode="quiet"] .core-ring, body[data-mode="quiet"] .core-halo { animation: none !important; }
/* Lockdown text uses the readable alarm red: #e10600 clears the bar as a border and a fill, but
   not as 15px text on the glass planes, so the text token is the lighter one. */
body[data-mode="lockdown"] { --cyan: var(--armor-red-text); --gold: var(--armor-red-text); --line: rgba(225, 6, 0, 0.45); --line-strong: rgba(255, 107, 90, 0.6); }
body[data-mode="lockdown"] .core-ring, body[data-mode="lockdown"] .core-halo, body[data-mode="lockdown"]::before { animation: none !important; }
body[data-motion="reduced"] *, body[data-motion="reduced"] *::before { animation: none !important; transition: none !important; }
/* Contrast: a real high-contrast palette, not a filter. */
@media (prefers-contrast: more) {
  :root { --line: rgba(190, 215, 240, 0.5); --muted: #b9cde3; --glass: rgba(8, 18, 30, 0.9); }
}
body[data-contrast="high"] { --line: rgba(205, 226, 246, 0.6); --line-strong: rgba(0, 229, 255, 0.9); --muted: #c3d6ea; --glass: rgba(6, 14, 24, 0.94); }
body[data-contrast="high"] .panel, body[data-contrast="high"] .rail, body[data-contrast="high"] .stage { border-width: 2px; }
body[data-contrast="high"]::before { display: none; }
@media (prefers-reduced-motion: reduce) {
  body { animation: none; }
  .core-ring { animation: none !important; }
  .core-halo { animation: none !important; }
}
/* T-32 Step 1 (2026-11-19): Part 4 depth planes, motion tokens and the core reticle posture.
   Everything below is additive: the T-30 tokens and rules above keep their meaning, and the new
   custom properties are what the reticle layers and the panel transitions now read. */
:root {
  /* Part 4 motion tokens. Every animated state change names one of these four, so a reviewer can
     change the cadence in one place instead of hunting durations. */
  --motion-ack: 120ms;
  --motion-panel: 260ms;
  --motion-posture: 700ms;
  --motion-reticle: 380ms;
  /* Reticle posture. A Core state sets these; the layers below read them. */
  --reticle-color: var(--arc-cyan);
  --reticle-weight: 1.5;
  --reticle-spin-azimuth: 18s;
  --reticle-spin-telemetry: 12s;
  --reticle-dash-azimuth: 8 6;
  --reticle-dash-telemetry: 4 10;
  --reticle-progress-offset: 260;
  --surface-blur: 14px;
}

/* Z0-Z4: one declared depth plane per layer of the deck, monotonically increasing. z0 is the void
   field the deck is drawn on, z1 the HUD grid, z2 the reticle, z3 the focal workspace cards, and z4
   the gates that may interrupt the owner (banner, safety controls). */
body[data-depth-plane="z0"] { position: relative; z-index: 0; }
/* A plane that does not participate in stacking is a label, not a plane, so each one is positioned:
   z-index alone does nothing on a static block box, and the ordering assertion would then be
   reading an inert declaration. */
[data-depth-plane="z1"] { position: relative; z-index: 10; }
[data-depth-plane="z2"] { position: relative; z-index: 20; }
[data-depth-plane="z3"] { position: relative; z-index: 30; }
[data-depth-plane="z4"] { position: relative; z-index: 40; }
#hud-grid {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.07) 1px, transparent 1px);
  background-size: 64px 64px, 64px 64px;
  mask-image: radial-gradient(circle at 50% 40%, rgba(0, 0, 0, 0.9), transparent 72%);
  opacity: 0.5;
}
body[data-mode="quiet"] #hud-grid { opacity: 0.12; }
body[data-mode="overwatch"] #hud-grid { opacity: 0.75; }
body[data-motion="reduced"] #hud-grid { opacity: 0.25; }

/* The glass surface for the focal plane: the same tokens, at the Part 4 blur range, with the panel
   radius the spec asks for and tabular numerals wherever a counter is drawn. */
[data-depth-plane="z3"] .panel,
[data-depth-plane="z3"].stage,
[data-depth-plane="z3"].rail,
[data-depth-plane="z3"] .view,
[data-depth-plane="z3"].view {
  background: var(--glass);
  backdrop-filter: blur(var(--surface-blur));
  border-radius: var(--radius);
  transition: border-color var(--motion-panel) ease, box-shadow var(--motion-panel) ease;
}
[data-depth-plane="z4"] {
  background: var(--glass-strong);
  backdrop-filter: blur(20px);
  border-radius: var(--radius);
  transition: border-color var(--motion-panel) ease, box-shadow var(--motion-panel) ease;
}
#clock, #gauge-cpu, #gauge-mem, #gauge-storage, .badge, .core-caption, .workspace-status, .meta.mono {
  font-variant-numeric: tabular-nums;
}

/* The reticle's five layers. Each one is a real element with its own geometry and its own motion,
   driven by the posture variables above rather than by a state-specific rule per layer. */
#core-reticle { width: min(260px, 70vw); aspect-ratio: 1 / 1; height: auto; transition: filter var(--motion-posture) ease; }
#core-reticle .reticle-azimuth { transform-origin: 120px 120px; animation: spin var(--reticle-spin-azimuth) linear infinite; }
#core-reticle .reticle-telemetry { transform-origin: 120px 120px; animation: spin var(--reticle-spin-telemetry) linear infinite reverse; }
#core-reticle .reticle-ack { opacity: 0; transition: opacity var(--motion-ack) ease; }
#core-reticle[data-ack-state="active"] { filter: drop-shadow(0 0 26px var(--reticle-color)) brightness(1.28); }
#core-reticle[data-ack-state="active"] .reticle-ack { opacity: 0.95; }
#core-reticle [data-ring="azimuth"] .core-ring { stroke: var(--reticle-color); stroke-width: var(--reticle-weight); }
#core-reticle [data-ring="azimuth"] .reticle-tick { stroke: var(--reticle-color); stroke-width: 1; stroke-dasharray: var(--reticle-dash-azimuth); fill: none; opacity: 0.8; }
#core-reticle [data-ring="telemetry"] .reticle-arc { stroke: var(--reticle-color); fill: none; opacity: 0.85; stroke-width: calc(var(--reticle-weight) * 1.4); stroke-dasharray: var(--reticle-dash-telemetry); }
#core-reticle [data-ring="progress"] .reticle-progress { stroke: var(--reticle-color); fill: none; stroke-width: calc(var(--reticle-weight) * 2); stroke-linecap: butt; stroke-dasharray: 14 8; stroke-dashoffset: var(--reticle-progress-offset); transition: stroke-dashoffset var(--motion-posture) ease, stroke var(--motion-posture) ease; }
#core-reticle [data-ring="brackets"] path { stroke: var(--reticle-color); fill: none; stroke-width: var(--reticle-weight); opacity: 0.9; }
#core-reticle [data-ring="nucleus"] .core-center { stroke: var(--reticle-color); }
#core-reticle [data-ring="nucleus"] .core-ring.inner { stroke: var(--reticle-color); }

/* Posture per reachable Core state. Distinct cadence, segmentation, weight and colour token, so a
   reviewer can read the state from the reticle without reading the caption. */
body[data-core-state="dormant"] { --state-color: var(--text-dim); --state-weight: 1; --state-spin-azimuth: 60s; --state-spin-telemetry: 48s; --state-dash-azimuth: 2 10; --state-dash-telemetry: 2 14; --state-progress: 380; }
body[data-core-state="idle"] { --state-color: var(--arc-cyan); --state-weight: 1.5; --state-spin-azimuth: 18s; --state-spin-telemetry: 12s; --state-dash-azimuth: 8 6; --state-dash-telemetry: 4 10; --state-progress: 260; }
body[data-core-state="thinking"] { --state-color: var(--armor-gold); --state-weight: 2; --state-spin-azimuth: 6s; --state-spin-telemetry: 4s; --state-dash-azimuth: 3 9; --state-dash-telemetry: 6 4; --state-progress: 180; }
body[data-core-state="executing"] { --state-color: var(--ok-green); --state-weight: 2.2; --state-spin-azimuth: 3s; --state-spin-telemetry: 2s; --state-dash-azimuth: 18 6; --state-dash-telemetry: 10 4; --state-progress: 60; }
body[data-core-state="awaiting_approval"] { --state-color: var(--armor-gold); --state-weight: 1.8; --state-spin-azimuth: 9s; --state-spin-telemetry: 6s; --state-dash-azimuth: 2 8; --state-dash-telemetry: 3 9; --state-progress: 120; }
body[data-core-state="uncertain"] { --state-color: var(--armor-gold); --state-weight: 1.6; --state-spin-azimuth: 14s; --state-spin-telemetry: 10s; --state-dash-azimuth: 5 5; --state-dash-telemetry: 4 6; --state-progress: 200; }
body[data-core-state="degraded"] { --state-color: var(--armor-gold); --state-weight: 1.2; --state-spin-azimuth: 30s; --state-spin-telemetry: 22s; --state-dash-azimuth: 6 12; --state-dash-telemetry: 2 12; --state-progress: 300; }
body[data-core-state="lockdown"] { --state-color: var(--armor-red); --state-weight: 2.4; --state-spin-azimuth: 0s; --state-spin-telemetry: 0s; --state-dash-azimuth: 12 12; --state-dash-telemetry: 12 12; --state-progress: 320; }
/* Posture resolution: the Core state supplies the base posture and the presentation mode scales it,
   so a reviewer can tell Idle from Awaiting Approval from Degraded from Lockdown in every mode while
   the mode still changes the geometry. Mode never overwrites the state it is layered on. */
body {
  --reticle-color: var(--state-color, var(--arc-cyan));
  --reticle-weight: calc(var(--state-weight, 1.5) * var(--reticle-scale, 1));
  --reticle-spin-azimuth: calc(var(--state-spin-azimuth, 18s) * var(--state-spin-scale, 1));
  --reticle-spin-telemetry: calc(var(--state-spin-telemetry, 12s) * var(--state-spin-scale, 1));
  --reticle-dash-azimuth: var(--dash-mode, var(--state-dash-azimuth, 8 6));
  --reticle-dash-telemetry: var(--state-dash-telemetry, 4 10);
  --reticle-progress-offset: var(--state-progress, 260);
}
/* A zero-cadence posture must not spin: animation-duration 0s on an infinite animation still
   schedules work, so lockdown and quiet stop the layers outright. */
body[data-core-state="lockdown"] #core-reticle .reticle-azimuth,
body[data-core-state="lockdown"] #core-reticle .reticle-telemetry { animation: none !important; }

/* Presentation modes scale the same posture rather than restyling the reticle from scratch. */
body[data-mode="classic"] { --reticle-scale: 1; --surface-blur: 14px; }
body[data-mode="tactical"] { --reticle-scale: 1.2; --state-spin-scale: 0.75; --surface-blur: 14px; }
body[data-mode="overwatch"] { --reticle-scale: 1.45; --dash-mode: 2 4; --surface-blur: 20px; }
body[data-mode="synthesis"] { --reticle-scale: 0.8; --state-spin-scale: 1.6; --surface-blur: 16px; }
body[data-mode="quiet"] { --reticle-scale: 0.66; --surface-blur: 12px; }
body[data-mode="lockdown"] { --reticle-scale: 1.6; --surface-blur: 20px; }

/* Keyboard-first: one visible reticle outline on every interactive element, and a command trigger
   in the top bar so the dispatch is the first thing Tab reaches after the top bar's own controls. */
a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--arc-cyan);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(0, 229, 255, 0.18);
}
.hud-chip {
  display: inline-flex; gap: .4rem; align-items: center;
  border: 1px solid var(--line-strong); border-radius: 999px;
  background: rgba(0, 229, 255, 0.08); color: var(--text);
  padding: .25rem .6rem; font-size: .78rem; cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.hud-chip kbd {
  font-family: var(--font-mono); font-size: .72rem; border: 1px solid var(--line);
  border-radius: 4px; padding: 0 .25rem; color: var(--muted);
}

/* Reduced motion, by preference or by the owner's own toggle: no continuous animation, no parallax,
   and the acknowledgement still changes state instantly rather than animating. */
@media (prefers-reduced-motion: reduce) {
  #core-reticle .reticle-azimuth, #core-reticle .reticle-telemetry { animation: none !important; }
  #hud-grid { opacity: 0.25; }
  * { transition-duration: 0s !important; animation-duration: 0s !important; }
}
body[data-motion="reduced"] #core-reticle .reticle-azimuth,
body[data-motion="reduced"] #core-reticle .reticle-telemetry { animation: none !important; }
body[data-motion="reduced"] .core, body[data-motion="reduced"] .core-halo { animation: none !important; transform: none !important; }

/* Responsive: 1600x900 and 1280x720 tighten the three-column deck; 390x844 is one column. */
@media (max-width: 1600px) {
  .deck { grid-template-columns: minmax(16rem, 1fr) minmax(20rem, 1.3fr) minmax(16rem, 1fr); }
}
@media (max-width: 1280px) {
  .deck { grid-template-columns: minmax(15rem, 1fr) minmax(18rem, 1.2fr) minmax(15rem, 1fr); gap: .75rem; padding: .85rem 1rem 6rem; }
  .topbar-meta { row-gap: .25rem; }
}
@media (max-width: 1100px) {
  .deck { grid-template-columns: 1fr; }
  .core-wrap { order: -1; }
}
@media (max-width: 720px) {
  .topbar { grid-template-columns: 1fr; }
  .nav { flex-wrap: wrap; }
  .workspace { padding: 0 .75rem 2rem; }
}
@media (max-width: 480px) {
  .deck { padding: .75rem .6rem 4rem; }
  .topbar { padding: .6rem .75rem; }
  h1 { font-size: 1.1rem; }
  .topbar-meta { width: 100%; }
}
.boot {
  position: fixed; inset: 0; z-index: 50; background: rgba(5,8,15,0.96);
  display: grid; place-items: center; gap: 1rem; padding: 2rem;
}
.boot.hidden { display: none; }
.boot-core { width: 90px; height: 90px; border-radius: 50%; border: 2px solid var(--cyan); box-shadow: 0 0 30px rgba(0,229,255,0.4); animation: spin 6s linear infinite; }
.boot-lines { font-family: var(--font-mono); color: var(--muted); max-width: 36rem; width: 100%; }
.boot-lines div { padding: .2rem 0; }

/* T-35 Step 1 (2026-11-19): Part 4's visual step-down ladder and its flash guard.
   The ladder is a declaration, not a guess: src/ui/hud.js owns the table, the page writes the stage
   onto <body> as data-stepdown-stage, and each dropped layer is a data-hud-* attribute the rules
   below read. Nothing here changes authorization, state or text - only decoration. */
:root {
  --hud-bloom: 18px;
  --hud-bloom-strong: 26px;
  --hud-particle-opacity: 0.5;
  /* Z0-Z4 parallax factors. Z0 is the void field, which cannot move against itself, and Z2 is the
     reticle, whose transform belongs to its posture; the three container planes are the ones that
     read these. All five are zeroed at stage 3, so the ladder's statement is exact. */
  --parallax-z0: 0;
  --parallax-z1: 0.35;
  --parallax-z2: 0;
  --parallax-z3: 0.8;
  --parallax-z4: 1;
  --parallax-damp: 6px;
  --parallax-x: 0px;
  --parallax-y: 0px;
}
#hud-particles {
  position: fixed; inset: 0; pointer-events: none; z-index: 10; opacity: var(--hud-particle-opacity);
  background-image:
    radial-gradient(1.5px 1.5px at 20% 30%, rgba(0, 229, 255, 0.55) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 70% 65%, rgba(0, 229, 255, 0.4) 50%, transparent 51%),
    radial-gradient(1px 1px at 45% 80%, rgba(215, 227, 244, 0.45) 50%, transparent 51%),
    radial-gradient(1px 1px at 85% 22%, rgba(215, 227, 244, 0.35) 50%, transparent 51%);
  background-size: 320px 320px, 420px 420px, 260px 260px, 380px 380px;
  animation: particle-drift 42s linear infinite;
}
@keyframes particle-drift { to { background-position: 320px 0, -420px 0, 260px 0, -380px 0; } }
/* Stage 3's landing: the container planes read the factors, and the client writes the pointer
   offset that makes them visible. At stage 3 the factor is 0 and every plane is back to identity. */
[data-depth-plane="z1"] { transform: translate3d(calc(var(--parallax-z1) * var(--parallax-x)), calc(var(--parallax-z1) * var(--parallax-y)), 0); }
[data-depth-plane="z3"] { transform: translate3d(calc(var(--parallax-z3) * var(--parallax-x)), calc(var(--parallax-z3) * var(--parallax-y)), 0); }
[data-depth-plane="z4"] { transform: translate3d(calc(var(--parallax-z4) * var(--parallax-x)), calc(var(--parallax-z4) * var(--parallax-y)), 0); }
/* Stage 1: bloom. The token itself is zeroed on the element that carries the stage (the body, which
   the whole deck inherits from), so anything reading the effective value sees the dropped one rather
   than only the elements this rule happens to cover. The drop-shadow and the halo are the multi-tier
   glow; the rings, the reticle geometry and its cadence are untouched, so the Core state stays
   readable. */
body[data-hud-bloom="dropped"] { --hud-bloom: 0px; }
.core { filter: drop-shadow(0 0 var(--hud-bloom) rgba(0, 229, 255, 0.25)); }
/* The Core is #core-reticle, and the acknowledgement rule below carries an id, so the stage has to
   name the same element to win. The ack still shows: the opacity of its ring (.reticle-ack) is the
   cue, and the filter transition is zeroed so no glow is left mid-flight when the bloom drops. */
body[data-hud-bloom="dropped"] #core-reticle,
body[data-hud-bloom="dropped"] #core-reticle[data-ack-state="active"] { filter: none; transition-duration: 0s; }
body[data-hud-bloom="dropped"] .core-halo { opacity: 0.3; }
body[data-hud-bloom="dropped"] .nav-item.active { box-shadow: none; }
body[data-hud-bloom="dropped"] .panel, body[data-hud-bloom="dropped"] .rail, body[data-hud-bloom="dropped"] .stage { box-shadow: none; }
/* Stage 2: particles and the grid shimmer. Both are removed rather than dimmed, so a reviewer can
   see the layer is gone rather than wonder whether it moved. */
body[data-hud-particles="dropped"] #hud-particles { display: none; }
body[data-hud-particles="dropped"] #hud-grid { opacity: 0; }
/* Stage 3: parallax. The factors are zeroed at the root, which is what the planes read. */
body[data-hud-parallax="dropped"] {
  --parallax-z1: 0; --parallax-z3: 0; --parallax-z4: 0;
}
/* Stage 4: ambient motion - the secondary rings and the breathing halo stop, and the reticle's own
   azimuth and telemetry layers keep their cadence, because that is the Core state indicator. */
body[data-hud-ambient="dropped"] .core-ring.outer,
body[data-hud-ambient="dropped"] .core-ring.mid,
body[data-hud-ambient="dropped"] .core-halo,
body[data-hud-ambient="dropped"] #hud-particles { animation: none; }
/* Stage 5: flat mode. No backdrop blur, no panel transitions - and #core-reticle is not in this
   list on purpose: Part 4 keeps the Core state indicator at every stage. */
body[data-hud-flat="true"] .panel,
body[data-hud-flat="true"] .rail,
body[data-hud-flat="true"] .stage,
body[data-hud-flat="true"] .view,
body[data-hud-flat="true"] .command-bar,
body[data-hud-flat="true"] .topbar {
  backdrop-filter: none;
  transition: none;
}
body[data-hud-flat="true"] .panel, body[data-hud-flat="true"] .rail, body[data-hud-flat="true"] .stage { background: var(--panel-solid, rgba(9, 16, 28, 0.96)); }
/* T-35 Step 2: the handoff form. Two columns with minmax(0, ...) on the control side so a long
   device id shrinks instead of widening the page. */
.handoff-form {
  display: grid; gap: .45rem .75rem; margin: .6rem 0;
  grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr);
  align-items: center;
}
.handoff-form select, .handoff-form input { min-width: 0; max-width: 100%; }
.handoff-form button { justify-self: start; }
@media (max-width: 760px) { .handoff-form { grid-template-columns: minmax(0, 1fr); } }
.handoff-form label { color: var(--muted, #8fa3bd); font-size: .78rem; }
#sensor-privacy-indicator[data-audio="disabled"][data-camera="disabled"] { color: var(--hud-text, #d7e3f4); }
#sensor-privacy-indicator[data-capture-possible="true"] { color: var(--armor-red-text, #ff6b5a); }
#stepdown-state[data-stage="5"] { border-color: var(--gold); }
`;


export const UI_CLIENT = `'use strict';
${CLIENT_CONTRACT_SOURCE}\nconst els = {
  turns: document.getElementById('turns'),
  form: document.getElementById('chat-form'),
  text: document.getElementById('chat-text'),
  // T-32 Step 1: the command trigger and the reticle the acknowledgement pulse is written to.
  commandTrigger: document.getElementById('command-trigger'),
  coreReticle: document.getElementById('core-reticle'),
  send: document.getElementById('send'),
  activity: document.getElementById('activity'),
  session: document.getElementById('session'),
  mode: document.getElementById('mode'),
  autonomy: document.getElementById('autonomy'),
  connectivity: document.getElementById('connectivity'),
  gaugeCpu: document.getElementById('gauge-cpu'),
  gaugeMem: document.getElementById('gauge-mem'),
  gaugeStorage: document.getElementById('gauge-storage'),
  newSession: document.getElementById('new-session'),
  tasks: document.getElementById('tasks'),
  taskStatus: document.getElementById('task-status'),
  plans: document.getElementById('plans'),
  planning: document.getElementById('planning'),
  missionTasks: document.getElementById('mission-tasks'),
  missionStatus: document.getElementById('mission-status'),
  missionGoalsStatus: document.getElementById('mission-goals-status'),
  missionPlansStatus: document.getElementById('mission-plans-status'),
  missionTasksStatus: document.getElementById('mission-tasks-status'),
  approvalItems: document.getElementById('approval-items'),
  approvalState: document.getElementById('approval-state'),
  approvalActionStatus: document.getElementById('approval-action-status'),
  timeline: document.getElementById('memory-timeline'),
  timelineStatus: document.getElementById('timeline-status'),
  memoryRecordsStatus: document.getElementById('memory-records-status'),
  associations: document.getElementById('associations'),
  associationsStatus: document.getElementById('associations-status'),
  knowledgeStatus: document.getElementById('knowledge-status'),
  worldStatus: document.getElementById('world-status'),
  conversationStatus: document.getElementById('conversation-status'),
  sentinelStatus: document.getElementById('sentinel-status'),
  documentsStatus: document.getElementById('documents-status'),
  reasoningStatus: document.getElementById('reasoning-status'),
  councilState: document.getElementById('council-state'),
  workshopState: document.getElementById('workshop-state'),
  // T-31 Step 2 surfaces.
  dagStatus: document.getElementById('dag-status'),
  dagSelect: document.getElementById('taskgraph-select'),
  missionSelect: document.getElementById('mission-select'),
  missionArtifact: document.getElementById('mission-artifact'),
  missionRun: document.getElementById('mission-run'),
  missionRunStatus: document.getElementById('mission-run-status'),
  dagNodes: document.getElementById('dag-nodes'),
  dagEdges: document.getElementById('dag-edges'),
  dagApprove: document.getElementById('dag-approve'),
  dagResume: document.getElementById('dag-resume'),
  dagRetry: document.getElementById('dag-retry'),
  dagCancel: document.getElementById('dag-cancel'),
  dagControlStatus: document.getElementById('dag-control-status'),
  workshopStageTelemetry: document.getElementById('workshop-stage-telemetry'),
  workshopSandboxStatus: document.getElementById('workshop-sandbox-status'),
  execCommsHeadline: document.getElementById('exec-comms-headline'),
  execCommsLines: document.getElementById('exec-comms-lines'),
  execCommsTone: document.getElementById('exec-comms-tone'),
  execCommsPanel: document.getElementById('exec-comms-panel'),
  perceptionStatus: document.getElementById('perception-status'),
  perceptionSummary: document.getElementById('perception-summary'),
  perceptionDetailStatus: document.getElementById('perception-detail-status'),
  perceptionObservations: document.getElementById('perception-observations'),
  perceptionSuppressions: document.getElementById('perception-suppressions'),
  perceptionBudget: document.getElementById('perception-budget'),
  perceptionWatches: document.getElementById('perception-watches'),
  perceptionWatchStatus: document.getElementById('perception-watch-status'),
  perceptionAlerts: document.getElementById('perception-alerts'),
  perceptionAlertStatus: document.getElementById('perception-alert-status'),
  perceptionAlertPolicy: document.getElementById('perception-alert-policy'),
  perceptionSense: document.getElementById('perception-sense'),
  perceptionSenseStatus: document.getElementById('perception-sense-status'),
  briefingPerception: document.getElementById('briefing-perception'),
  // T-35 Step 3: the doctor panel in the System workspace.
  doctorStatus: document.getElementById('doctor-status'),
  doctorRun: document.getElementById('doctor-run'),
  doctorChecks: document.getElementById('doctor-checks'),
  presenceStatus: document.getElementById('presence-status'),
  presenceDevices: document.getElementById('presence-devices'),
  presenceMesh: document.getElementById('presence-mesh'),
  // T-35 Step 2: the handoff envelope form and ledger.
  handoffStatus: document.getElementById('handoff-status'),
  handoffSource: document.getElementById('handoff-source'),
  handoffTarget: document.getElementById('handoff-target'),
  handoffView: document.getElementById('handoff-view'),
  handoffTask: document.getElementById('handoff-task'),
  handoffNote: document.getElementById('handoff-note'),
  handoffStage: document.getElementById('handoff-stage'),
  handoffMessage: document.getElementById('handoff-message'),
  handoffList: document.getElementById('handoff-list'),
  autonomyStatus: document.getElementById('autonomy-status'),
  autonomyMatrix: document.getElementById('autonomy-matrix'),
  autonomyCapabilities: document.getElementById('autonomy-capabilities'),
  worldClaims: document.getElementById('world-claims'),
  worldLabels: document.getElementById('world-labels'),
  evolutionStatus: document.getElementById('evolution-status'),
  evolutionProposals: document.getElementById('evolution-proposals'),
  evolutionBoundaries: document.getElementById('evolution-boundaries'),
  evolutionBoundariesStatus: document.getElementById('evolution-boundaries-status'),
  evolutionPolicy: document.getElementById('evolution-policy'),
  evolutionForm: document.getElementById('evolution-form'),
  evolutionTitle: document.getElementById('evolution-title'),
  evolutionHypothesis: document.getElementById('evolution-hypothesis'),
  evolutionProposeButton: document.getElementById('evolution-propose'),
  evolutionFormStatus: document.getElementById('evolution-form-status'),
  systemStatus: document.getElementById('system-status'),
  integrationsStatus: document.getElementById('integrations-status'),
  planningForm: document.getElementById('planning-form'),
  planningObjective: document.getElementById('planning-objective'),
  planningGoal: document.getElementById('planning-goal'),
  planningRead: document.getElementById('planning-read'),
  planningStatus: document.getElementById('planning-status'),
  healthOverall: document.getElementById('health-overall'),
  health: document.getElementById('health'),
  safetyStatus: document.getElementById('safety-status'),
  safetyLockForm: document.getElementById('safety-lock-form'),
  safetyLockReason: document.getElementById('safety-lock-reason'),
  safetyLockButton: document.getElementById('safety-lock'),
  safetyLockResult: document.getElementById('safety-lock-result'),
  safetyReleaseForm: document.getElementById('safety-release-form'),
  safetyReleaseReason: document.getElementById('safety-release-reason'),
  safetyReleaseConfirm: document.getElementById('safety-release-confirm'),
  safetyReleaseButton: document.getElementById('safety-release'),
  safetyReleaseResult: document.getElementById('safety-release-result'),
  safetyStepUpWrap: document.getElementById('safety-step-up-wrap'),
  safetyStepUp: document.getElementById('safety-step-up'),
  safetyStepUpNote: document.getElementById('safety-step-up-note'),
  runtime: document.getElementById('runtime'),
  sources: document.getElementById('sources'),
  resources: document.getElementById('resources'),
  resourcesStatus: document.getElementById('resources-status'),
  documents: document.getElementById('documents'),
  reasoning: document.getElementById('reasoning'),
  council: document.getElementById('council'),
  councilForm: document.getElementById('council-form'),
  councilObjective: document.getElementById('council-objective'),
  councilGather: document.getElementById('council-gather'),
  councilRun: document.getElementById('council-run'),
  councilStatus: document.getElementById('council-status'),
  councilSynthesis: document.getElementById('council-synthesis'),
  cognitionForm: document.getElementById('cognition-form'),
  cognitionIntent: document.getElementById('cognition-intent'),
  cognitionAction: document.getElementById('cognition-action'),
  cognitionRun: document.getElementById('cognition-run'),
  cognitionRunStatus: document.getElementById('cognition-run-status'),
  cognitionStatus: document.getElementById('cognition-status'),
  cognitionTrace: document.getElementById('cognition-trace'),
  cognitionRuns: document.getElementById('cognition-runs'),
  workshop: document.getElementById('workshop'),
  workshopForm: document.getElementById('workshop-form'),
  workshopTitle: document.getElementById('workshop-title'),
  workshopDomain: document.getElementById('workshop-domain'),
  workshopBudget: document.getElementById('workshop-budget'),
  workshopSource: document.getElementById('workshop-source'),
  workshopCompose: document.getElementById('workshop-compose'),
  workshopStatus: document.getElementById('workshop-status'),
  workshopReport: document.getElementById('workshop-report'),
  docSearch: document.getElementById('doc-search-form'),
  docSearchText: document.getElementById('doc-search'),
  banner: document.getElementById('banner'),
  coreState: document.getElementById('core-state'),
  coreCaption: document.getElementById('core-caption'),
  clock: document.getElementById('clock'),
  boot: document.getElementById('boot'),
  bootLines: document.getElementById('boot-lines'),
  bootSkip: document.getElementById('boot-skip'),
  quickBoot: document.getElementById('quick-boot'),
  missions: document.getElementById('missions-list'),
  taskgraph: document.getElementById('taskgraph'),
  sentinel: document.getElementById('sentinel'),
  approvals: document.getElementById('approvals'),
  briefings: document.getElementById('briefings'),
  briefingStatus: document.getElementById('briefing-status'),
  briefingDelta: document.getElementById('briefing-delta'),
  briefingDeltaStatus: document.getElementById('briefing-delta-status'),
  briefingAckReason: document.getElementById('briefing-ack-reason'),
  briefingAcknowledge: document.getElementById('briefing-acknowledge'),
  briefingAckStatus: document.getElementById('briefing-ack-status'),
  goals: document.getElementById('goals'),
  memory: document.getElementById('memory'),
  knowledge: document.getElementById('knowledge'),
  world: document.getElementById('world'),
  integrations: document.getElementById('integrations'),
  sentinelFull: document.getElementById('sentinel-full'),
  conversationHistory: document.getElementById('conversation-history'),
  modeSelect: document.getElementById('mode-select'),
  // T-35 Step 1: the visual step-down ladder and the system sensor indicator.
  stepDownSelect: document.getElementById('stepdown-select'),
  stepDownState: document.getElementById('stepdown-state'),
  sensorPrivacy: document.getElementById('sensor-privacy-indicator'),
  motionToggle: document.getElementById('motion-toggle'),
  contrastToggle: document.getElementById('contrast-toggle'),
};

const state = {
  core: 'degraded',
  view: 'deck',
  last: null,
  eventCursor: { streamId: null, seq: 0, versions: {} },
  ownerSnapshots: Object.create(null),
  eventReconciled: false,
  stateReadAvailable: false,
  thinking: false,
  safetyLatchFresh: false,
  safetyMutationInFlight: false,
  reducedMotion: false,
  mode: 'classic',
  // T-35 Step 2: the enrolled devices the handoff form offers, and the ledger last read.
  handoffDevices: [],
  handoffLedger: null,
  doctorAt: 0,
  doctorRan: false,
  contrast: 'standard',
  cognitionInFlight: false,
  lastCognitionRun: null,
};
let eventStreamDegraded = false;

function showBanner(text) {
  if (!els.banner) return;
  els.banner.textContent = text || '';
  els.banner.hidden = !text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? { 'x-apex-ui': '1' } : { 'content-type': 'application/json', 'x-apex-ui': '1' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = data && typeof data.error === 'string' ? data.error : 'request failed (' + response.status + ')';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data === null ? {} : data;
}

async function readApi(path) {
  try {
    return { ok: true, value: await api(path) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), status: error?.status ?? null };
  }
}

function setWorkspaceStatus(target, text, status = 'available') {
  if (!target) return;
  target.dataset.state = status;
  target.textContent = text;
}

function ownerStatusText(result, label) {
  if (!result) return { text: 'Loading ' + label + '…', state: 'loading' };
  if (result.ok === false) {
    const state = result.status >= 500 ? 'unavailable' : 'error';
    return { text: (state === 'unavailable' ? 'Unavailable' : 'Read error') + ': ' + result.error, state };
  }
  const value = result.value;
  if (!value || value.available === false || value.unavailable === true || value.status === 'unavailable') {
    return { text: 'Unavailable: ' + String(value?.error || value?.unavailable || (label + ' owner is not configured')), state: 'unavailable' };
  }
  return { text: '', state: 'available' };
}

function setCore(next, caption) {
  if (!CORE_REACHABLE_STATES.includes(next)
    || !CORE_STATE_DEFINITIONS.some((definition) => definition.id === next && definition.reachability === 'reachable')) {
    next = 'degraded';
    caption = 'An unsupported or reserved state was refused; showing Degraded.';
  }
  const definition = CORE_STATE_DEFINITIONS.find((stateDefinition) => stateDefinition.id === next);
  state.core = next;
  document.body.dataset.coreState = next;
  // Presentation only: an active ECP latch always presents as Lockdown, whatever mode the
  // owner selected, and the selector is disabled so the UI cannot imply otherwise. No
  // authorization decision is made here.
  const lockdown = next === 'lockdown';
  document.body.dataset.mode = lockdown ? 'lockdown' : state.mode;
  if (els.modeSelect) els.modeSelect.disabled = lockdown;
  if (els.coreState) els.coreState.textContent = definition ? definition.label : 'Degraded';
  if (els.coreCaption && caption) els.coreCaption.textContent = caption;
}

function coreCaptionFor(core, reason = '') {
  if (core === 'lockdown') return 'ECP reports an active kill switch. Release requires an explicit reason and confirmation.';
  if (core === 'degraded') {
    if (reason) return reason;
    if (!state.eventReconciled || eventStreamDegraded) return 'The authoritative event stream is unavailable or not reconciled.';
    if (!state.stateReadAvailable) return 'The authoritative UI state read is unavailable.';
    const missing = ['tasks', 'plans', 'approval', 'lockdown', 'runtime', 'health', 'conversation']
      .filter((name) => !state.ownerSnapshots[name] || state.ownerSnapshots[name].available !== true);
    if (missing.length) return 'Required owner state is unavailable: ' + missing.join(', ') + '.';
    const runtime = state.ownerSnapshots.runtime;
    if (runtime?.corruption) return 'Runtime checkpoint is reported corrupt; work is not inferred healthy.';
    if (runtime?.lastError) return 'Runtime reports an error: ' + runtime.lastError;
    if (['starting', 'stopping', 'unknown'].includes(runtime?.lifecycle)) return 'Runtime lifecycle is ' + runtime.lifecycle + '.';
    const conversation = state.ownerSnapshots.conversation;
    if (conversation?.sessionStatus === 'corrupt' || conversation?.sessionStatus === 'unavailable') return 'Conversation state reports ' + conversation.sessionStatus + '.';
    if (conversation?.corruptCount > 0) return 'Conversation history reports corrupt records.';
    if (state.ownerSnapshots.tasks?.counts?.pausedTasks > 0) return 'A task is paused without a more specific reachable Core state.';
    const health = state.ownerSnapshots.health;
    return health && health.overall ? 'Health reports ' + health.overall + '; the UI is not assuming a healthy state.' : 'A required source is degraded or unavailable.';
  }
  if (core === 'awaiting_approval') return 'A task step or draft plan is waiting for an explicit owner approval.';
  if (core === 'uncertain') return 'A task step has an uncertain outcome; no completion is being inferred.';
  if (core === 'executing') return 'TaskStore reports one or more running tasks.';
  if (core === 'thinking') return 'A chat request is in progress.';
  if (state.ownerSnapshots.runtime?.paused === true) return 'No higher-priority task state is active; runtime scheduling is paused.';
  return 'Required owner snapshots are available; no higher-priority condition is reported.';
}

function renderSafety() {
  const snapshot = state.ownerSnapshots.lockdown;
  if (!els.safetyStatus) return;
  const known = snapshot && snapshot.available === true;
  const active = known && snapshot.active === true;
  const clear = known && snapshot.active === false && snapshot.policyUnavailable !== true;
  const fresh = state.eventReconciled && state.stateReadAvailable && !eventStreamDegraded
    && state.safetyLatchFresh === true && !state.safetyMutationInFlight;
  if (state.safetyMutationInFlight) {
    els.safetyStatus.dataset.safety = 'unavailable';
    els.safetyStatus.textContent = 'An ECP safety control is in progress; waiting for a fresh latch read.';
  } else if (!known || (!active && !clear)) {
    els.safetyStatus.dataset.safety = 'unavailable';
    els.safetyStatus.textContent = 'ECP kill-switch state is unavailable; it is not assumed clear.';
  } else if (active) {
    els.safetyStatus.dataset.safety = fresh ? 'active' : 'unavailable';
    const staleReason = state.safetyLatchFresh === true ? 'event state is stale' : 'the latch has not been freshly read';
    els.safetyStatus.textContent = (fresh ? 'LOCKDOWN ACTIVE — ' : 'Last reported LOCKDOWN ACTIVE; ' + staleReason + ' — ')
      + (snapshot.reason || 'ECP reports the durable latch active.');
  } else if (fresh) {
    els.safetyStatus.dataset.safety = 'clear';
    els.safetyStatus.textContent = 'ECP reports the durable lockdown latch clear.';
  } else {
    els.safetyStatus.dataset.safety = 'unavailable';
    els.safetyStatus.textContent = state.safetyLatchFresh === true
      ? 'Last reported clear; event state is stale.'
      : 'Last reported clear; current ECP latch state is not confirmed.';
  }
  if (els.safetyLockButton) els.safetyLockButton.disabled = active || state.safetyMutationInFlight;
  if (els.safetyReleaseButton) els.safetyReleaseButton.disabled = !active || !fresh || state.safetyMutationInFlight;
}

async function refreshSafetyLatch() {
  try {
    const snapshot = await api('/api/killswitch');
    if (!snapshot || typeof snapshot.active !== 'boolean' || typeof snapshot.policyUnavailable !== 'boolean') {
      throw new Error('ECP returned a malformed latch status');
    }
    state.ownerSnapshots.lockdown = {
      available: true,
      active: snapshot.active,
      policyUnavailable: snapshot.policyUnavailable,
      activatedAt: snapshot.activatedAt ?? null,
      reason: typeof snapshot.reason === 'string' ? snapshot.reason : null,
      persistence: typeof snapshot.persistence === 'string' ? snapshot.persistence : 'unknown',
    };
    state.safetyLatchFresh = true;
  } catch (error) {
    state.ownerSnapshots.lockdown = { available: false, error: String(error?.message || error).slice(0, 240) };
    state.safetyLatchFresh = false;
  }
  applyCoreProjection(state.safetyLatchFresh ? '' : 'The current ECP latch state could not be freshly read.');
  return state.safetyLatchFresh;
}

function applyCoreProjection(reason = '') {
  const next = resolveCoreStateFromOwners(state.ownerSnapshots, {
    eventStreamAvailable: state.eventReconciled && !eventStreamDegraded,
    stateReadAvailable: state.stateReadAvailable,
    thinking: state.thinking,
  });
  setCore(next, coreCaptionFor(next, reason));
  renderSafety();
  return next;
}

function renderTurns(turns, emptyMessage = 'No turns are recorded in this session.') {
  if (!els.turns) return;
  els.turns.replaceChildren();
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) {
    els.turns.append(el('li', 'meta', emptyMessage));
    return;
  }
  for (const turn of list) {
    if (!turn || typeof turn !== 'object' || typeof turn.text !== 'string') continue;
    const cls = turn.role === 'user' ? 'turn user' : 'turn apex';
    const item = el('li', cls);
    const who = turn.role === 'user' ? 'You' : 'APEX';
    const verified = turn.role === 'user' ? '' : (turn.verified ? ' · verified' : ' · unverified');
    item.append(el('div', 'who', who + verified));
    item.append(el('pre', null, turn.text));
    els.turns.append(item);
  }
  els.turns.scrollTop = els.turns.scrollHeight;
}

function renderList(target, items, mapper, emptyMessage = 'No records are recorded by this owner.') {
  if (!target) return;
  target.replaceChildren();
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    target.append(el('li', 'meta', emptyMessage));
    return;
  }
  for (const item of list) target.append(mapper(item));
}

function itemFrom(title, meta) {
  const li = el('li', 'item');
  li.append(el('div', 'title', title));
  if (meta) li.append(el('div', 'meta', meta));
  return li;
}

function renderOwnerItems(target, source, mapper, label, emptyMessage) {
  if (!target) return false;
  if (!source || source.available !== true || !Array.isArray(source.items)) {
    const reason = source?.error || (label + ' owner did not provide a readable item list.');
    renderList(target, [], mapper, 'Unavailable: ' + reason);
    return false;
  }
  renderList(target, source.items, mapper, emptyMessage);
  return true;
}

function reportSource(target, source, label) {
  if (!target) return;
  if (!source) {
    setWorkspaceStatus(target, 'Unavailable: no ' + label + ' owner response was received.', 'unavailable');
    return;
  }
  if (source.available !== true) {
    setWorkspaceStatus(target, 'Unavailable: ' + String(source.error || (label + ' records could not be read.')), 'unavailable');
    return;
  }
  const shown = Array.isArray(source.items) ? source.items.length : null;
  const total = Number.isInteger(source.total) ? source.total : shown;
  if (total === 0) {
    setWorkspaceStatus(target, 'No ' + label + ' records are present in the owner store.', 'empty');
    return;
  }
  const countText = shown === null ? String(total) : shown + ' of ' + total;
  let text = 'Loaded ' + countText + ' recorded ' + label + ' records' + (source.truncated ? ' (bounded view).' : '.');
  const corrupt = Number.isInteger(source.corrupt) ? source.corrupt : 0;
  if (corrupt > 0) text += ' ' + corrupt + ' corrupt record(s) were also reported.';
  setWorkspaceStatus(target, text, corrupt > 0 ? 'partial' : 'available');
}

function renderTaskRows(tasks, target = els.tasks, emptyMessage = 'No task records are present in TaskStore.') {
  const rows = Array.isArray(tasks) ? tasks : [];
  renderList(target, rows, (task) => {
    const item = itemFrom(task.goal || task.id, (task.status || 'unknown') + ' · task ' + task.id);
    if (task.origin || task.planner) item.append(el('div', 'meta', 'Recorded origin: ' + (task.origin || 'not recorded') + ' · planner: ' + (task.planner || 'not recorded')));
    if (task.goalId) item.append(el('div', 'meta', 'Goal reference: ' + task.goalId));
    if (task.planId) item.append(el('div', 'meta', 'Plan reference: ' + task.planId));
    if (task.approvedAt) item.append(el('div', 'meta', 'Task plan approval recorded at: ' + task.approvedAt));
    if (task.lastReason) item.append(el('div', 'meta', 'Recorded transition reason: ' + task.lastReason));
    if (task.createdAt || task.updatedAt) item.append(el('div', 'meta', 'Created: ' + (task.createdAt || 'not recorded') + ' · last updated: ' + (task.updatedAt || 'not recorded')));
    for (const step of (Array.isArray(task.steps) ? task.steps : [])) {
      item.append(el('div', 'meta', 'Step ' + step.id + ': ' + (step.description || step.action || 'description not recorded') + ' · ' + (step.status || 'unknown')));
      if (step.outcome) item.append(el('div', 'meta', '  recorded outcome: ' + step.outcome));
      if (step.dependsOn?.length) item.append(el('div', 'meta', '  depends on: ' + step.dependsOn.join(', ')));
      if (step.summary) item.append(el('div', 'meta', '  recorded result: ' + step.summary));
      if (step.operationId) item.append(el('div', 'meta', '  audit operation: ' + step.operationId));
      if (step.approval) item.append(el('div', 'meta', '  step approval by ' + (step.approval.approvedBy || 'not recorded') + ' at ' + (step.approval.at || 'time not recorded')));
    }
    return item;
  }, emptyMessage);
}

function cancellationFormForPlan(plan) {
  const cancellable = ['draft', 'approved', 'active', 'blocked', 'paused', 'failed'];
  if (!cancellable.includes(plan.status)) return null;
  const details = document.createElement('details');
  details.className = 'plan-cancel';
  const summary = document.createElement('summary');
  summary.textContent = 'Cancel this plan';
  const note = el('p', 'meta', 'This records plan cancellation only. A task already created from the plan is not stopped by this control.');
  const form = document.createElement('form');
  form.className = 'row';
  const inputId = 'plan-cancel-reason-' + String(plan.id).replace(/[^A-Za-z0-9_-]/g, '-');
  const label = document.createElement('label');
  label.htmlFor = inputId;
  label.className = 'visually-hidden';
  label.textContent = 'Reason for cancelling plan ' + plan.id;
  const reason = document.createElement('textarea');
  reason.id = inputId;
  reason.rows = 2;
  reason.maxLength = 500;
  reason.required = true;
  reason.setAttribute('aria-label', label.textContent);
  const button = el('button', 'small', 'Record cancellation');
  button.type = 'submit';
  form.append(label, reason, button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = reason.value.trim();
    if (!value) {
      setWorkspaceStatus(els.missionStatus, 'A cancellation reason is required.', 'error');
      return;
    }
    await cancelPlan(plan.id, value, button);
  });
  details.append(summary, note, form);
  return details;
}

function renderPlans(plans, emptyMessage = 'No plan records are present in PlanStore.') {
  renderList(els.plans, plans, (plan) => {
    const item = itemFrom(plan.outcome || plan.id, (plan.status || 'unknown') + ' · plan ' + plan.id
      + (plan.version ? ' · v' + plan.version : '') + ' · risk ' + (plan.risk || 'unknown'));
    if (plan.goalId) item.append(el('div', 'meta', 'Goal reference: ' + plan.goalId));
    if (plan.goalRevision !== null && plan.goalRevision !== undefined) item.append(el('div', 'meta', 'Linked goal revision: ' + plan.goalRevision));
    if (plan.origin) item.append(el('div', 'meta', 'Recorded origin: ' + plan.origin));
    if (plan.approval) item.append(el('div', 'meta', 'Approval recorded at ' + (plan.approval.at || 'time not recorded')
      + ' · bound version ' + (plan.approval.version ?? 'not recorded')
      + ' · content hash prefix ' + (plan.approval.contentHashPrefix || 'not recorded')));
    if (plan.activation) item.append(el('div', 'meta', 'Activation recorded at ' + (plan.activation.at || 'time not recorded')
      + ' · task ' + (plan.activation.taskId || 'not recorded')));
    if (plan.blockedReason) item.append(el('div', 'meta', 'Blocked: ' + plan.blockedReason));
    if (plan.failureReason) item.append(el('div', 'meta', 'Failure recorded: ' + plan.failureReason));
    if (plan.cancelledReason) item.append(el('div', 'meta', 'Cancellation reason: ' + plan.cancelledReason));
    if (plan.supersededBy) item.append(el('div', 'meta', 'Superseded by plan ' + plan.supersededBy));
    if (plan.createdAt || plan.updatedAt) item.append(el('div', 'meta', 'Created: ' + (plan.createdAt || 'not recorded') + ' · last updated: ' + (plan.updatedAt || 'not recorded')));
    for (const precondition of (Array.isArray(plan.preconditions) ? plan.preconditions : [])) item.append(el('div', 'meta', 'Precondition: ' + precondition));
    for (const milestone of (Array.isArray(plan.milestones) ? plan.milestones : [])) {
      const progress = milestone.recordedProgress || {};
      item.append(el('div', 'meta', 'Checkpoint ' + milestone.id + ': ' + milestone.title
        + ' · recorded outcomes ' + (progress.completed || 0) + '/' + (progress.total || 0)
        + ' · failed ' + (progress.failed || 0) + ' · uncertain ' + (progress.uncertain || 0)));
      if (milestone.checkpoint) item.append(el('div', 'meta', '  checkpoint: ' + milestone.checkpoint));
      if (milestone.verification) item.append(el('div', 'meta', '  checkpoint verification: ' + milestone.verification));
      if (milestone.dependsOn?.length) item.append(el('div', 'meta', '  milestone dependencies: ' + milestone.dependsOn.join(', ')));
    }
    for (const step of (Array.isArray(plan.steps) ? plan.steps : [])) {
      const outcome = step.result?.status || 'no outcome recorded';
      item.append(el('div', 'meta', 'Step ' + step.id + ': ' + (step.description || step.action || 'description not recorded')
        + ' · ' + outcome + ' · risk ' + (step.risk || 'unknown') + ' · reversibility ' + (step.reversibility || 'unknown')));
      if (step.dependsOn?.length) item.append(el('div', 'meta', '  depends on: ' + step.dependsOn.join(', ')));
      if (step.expectedResult) item.append(el('div', 'meta', '  expected: ' + step.expectedResult));
      if (step.verification) item.append(el('div', 'meta', '  verification: ' + step.verification));
      if (step.result?.operationId) item.append(el('div', 'meta', '  recorded operation: ' + step.result.operationId));
      if (step.result?.taskId) item.append(el('div', 'meta', '  outcome linked to task: ' + step.result.taskId));
      if (step.result?.at) item.append(el('div', 'meta', '  outcome recorded at: ' + step.result.at));
      if (step.result?.detail) item.append(el('div', 'meta', '  outcome detail: ' + step.result.detail));
    }
    const history = Array.isArray(plan.history) ? plan.history : [];
    for (const entry of history) {
      item.append(el('div', 'meta', 'Lifecycle ' + (entry.kind || 'event') + ' · ' + (entry.at || 'time not recorded')
        + ' · v' + (entry.version ?? 'unknown') + (entry.reason ? ' · ' + entry.reason : '')));
    }
    if (Number.isInteger(plan.historyTotal) && plan.historyTotal > history.length) {
      item.append(el('div', 'meta', 'Showing the most recent ' + history.length + ' of ' + plan.historyTotal + ' lifecycle records.'));
    }
    const cancel = cancellationFormForPlan(plan);
    if (cancel) item.append(cancel);
    return item;
  }, emptyMessage);
}

function renderGoals(goals, emptyMessage = 'No goal records are present in GoalStore.') {
  renderList(els.goals, goals, (goal) => {
    const progress = goal.progress || {};
    const item = itemFrom(goal.request || goal.id, (goal.status || 'unknown') + ' · priority '
      + (goal.priority ?? 'not recorded') + ' · required criteria ' + (progress.satisfied || 0) + '/' + (progress.required || 0) + ' satisfied');
    if (goal.origin) item.append(el('div', 'meta', 'Recorded origin: ' + goal.origin));
    if (goal.revision !== null && goal.revision !== undefined) item.append(el('div', 'meta', 'Revision: ' + goal.revision));
    if (goal.deadline) item.append(el('div', 'meta', 'Recorded deadline: ' + goal.deadline));
    if (goal.blockedReason) item.append(el('div', 'meta', 'Blocked: ' + goal.blockedReason));
    if (goal.contradiction) item.append(el('div', 'meta', 'Recorded contradiction for ' + (goal.contradiction.criterionId || 'criterion not recorded')
      + (goal.contradiction.detail ? ': ' + goal.contradiction.detail : '')
      + (goal.contradiction.operationId ? ' · operation ' + goal.contradiction.operationId : '')));
    if (goal.dependsOn?.length) item.append(el('div', 'meta', 'Depends on goals: ' + goal.dependsOn.join(', ')));
    if (goal.planIds?.length) item.append(el('div', 'meta', 'Linked plans: ' + goal.planIds.join(', ')));
    if (goal.taskIds?.length) item.append(el('div', 'meta', 'Linked tasks: ' + goal.taskIds.join(', ')));
    for (const blocker of (goal.decomposition?.blockers || [])) {
      item.append(el('div', 'meta', 'Blocker (' + (blocker.basis || 'basis not recorded') + '): ' + blocker.text));
    }
    for (const unknown of (goal.decomposition?.unknowns || [])) {
      item.append(el('div', 'meta', 'Unknown (' + (unknown.basis || 'basis not recorded') + '): ' + unknown.text));
    }
    for (const criterion of (Array.isArray(goal.criteria) ? goal.criteria : [])) {
      item.append(el('div', 'meta', criterion.id + ' ' + criterion.status + ': ' + criterion.description
        + ' · ' + (criterion.basis || 'basis not recorded') + '/' + (criterion.requirement || 'requirement not recorded')));
      if (criterion.confirmation) item.append(el('div', 'meta', '  user decision: ' + (criterion.confirmation.decision || 'not recorded')
        + (criterion.confirmation.reason ? ' · ' + criterion.confirmation.reason : '')
        + (criterion.confirmation.operationId ? ' · operation ' + criterion.confirmation.operationId : '')));
      if (criterion.evidence?.length) item.append(el('div', 'meta', '  evidence records: ' + criterion.evidence.map((entry) => (entry.operationId || 'no operation id') + ' (' + (entry.kind || 'kind not recorded') + ')').join(', ')));
    }
    if (goal.completion) {
      item.append(el('div', 'meta', 'Completion recorded at ' + (goal.completion.at || 'time not recorded')
        + ' · cited operations ' + (goal.completion.criteria || []).map((entry) => entry.operationId || 'not recorded').join(', ')));
    }
    for (const entry of (Array.isArray(goal.statusHistory) ? goal.statusHistory : [])) {
      item.append(el('div', 'meta', 'Lifecycle ' + (entry.from || 'new') + ' → ' + (entry.to || 'unknown')
        + ' · ' + (entry.at || 'time not recorded') + (entry.reason ? ' · ' + entry.reason : '')));
    }
    if (Number.isInteger(goal.statusHistoryTotal) && goal.statusHistoryTotal > (goal.statusHistory || []).length) {
      item.append(el('div', 'meta', 'Showing the most recent ' + (goal.statusHistory || []).length + ' of ' + goal.statusHistoryTotal + ' status records.'));
    }
    for (const entry of (Array.isArray(goal.revisionHistory) ? goal.revisionHistory : [])) {
      item.append(el('div', 'meta', 'Revision ' + (entry.revision ?? 'unknown') + ' recorded at ' + (entry.at || 'time not recorded')
        + (entry.reason ? ' · ' + entry.reason : '')));
    }
    return item;
  }, emptyMessage);
}

function renderMissions(goals = [], plans = [], emptyMessage = 'No mission records are present in GoalStore or PlanStore.') {
  const missions = [];
  for (const goal of (Array.isArray(goals) ? goals : [])) missions.push({ title: goal.request || goal.id, meta: 'goal · ' + (goal.status || 'unknown') });
  for (const plan of (Array.isArray(plans) ? plans : [])) missions.push({ title: plan.outcome || plan.id, meta: 'plan · ' + (plan.status || 'unknown') });
  renderList(els.missions, missions, (mission) => itemFrom(mission.title, mission.meta), emptyMessage);
}

function renderMissionControl(result) {
  const status = ownerStatusText(result, 'Mission Control');
  const value = result?.ok === true ? result.value : null;
  const sources = value?.sources || {};
  if (status.text) {
    setWorkspaceStatus(els.missionStatus, status.text, status.state);
  } else {
    const missing = Object.entries(sources).filter(([, source]) => source?.available !== true).map(([name]) => name);
    const empty = ['goals', 'plans', 'tasks'].every((name) => sources[name]?.available === true
      && Number.isInteger(sources[name].total) && sources[name].total === 0);
    if (value?.status === 'partial' || missing.length > 0) {
      setWorkspaceStatus(els.missionStatus, 'Partial owner read; unavailable: ' + (missing.join(', ') || 'one or more stores') + '.', 'partial');
    } else if (empty) {
      setWorkspaceStatus(els.missionStatus, 'No goal, plan or task records are present in the readable owner stores.', 'empty');
    } else {
      setWorkspaceStatus(els.missionStatus, 'Goal, plan and task state read from their owner stores.', 'available');
    }
  }
  const goalSource = sources.goals;
  const planSource = sources.plans;
  const taskSource = sources.tasks;
  for (const [source, target, label] of [
    [goalSource, els.missionGoalsStatus, 'goals'],
    [planSource, els.missionPlansStatus, 'plans'],
    [taskSource, els.missionTasksStatus, 'tasks'],
  ]) reportSource(target, source, label);
  if (goalSource?.available === true) renderGoals(goalSource.items, 'No goal records are present in GoalStore.');
  else renderList(els.goals, [], () => null, 'Unavailable: ' + String(goalSource?.error || 'GoalStore records could not be read.'));
  if (planSource?.available === true) renderPlans(planSource.items, 'No plan records are present in PlanStore.');
  else renderList(els.plans, [], () => null, 'Unavailable: ' + String(planSource?.error || 'PlanStore records could not be read.'));
  if (taskSource?.available === true) {
    renderTaskRows(taskSource.items, els.missionTasks, 'No task records are present in TaskStore.');
    renderTaskRows(taskSource.items, els.tasks, 'No task records are present in TaskStore.');
    renderTaskRows(taskSource.items, els.taskgraph, 'No task records are present in TaskStore.');
    const total = Number.isInteger(taskSource.total) ? taskSource.total : (taskSource.items || []).length;
    setWorkspaceStatus(els.taskStatus, total === 0 ? 'No task records are present in TaskStore.' : total + ' task record(s) are projected from TaskStore.', total === 0 ? 'empty' : 'available');
  } else {
    renderList(els.missionTasks, [], () => null, 'Unavailable: ' + String(taskSource?.error || 'TaskStore records could not be read.'));
    renderList(els.tasks, [], () => null, 'Unavailable: ' + String(taskSource?.error || 'TaskStore records could not be read.'));
    renderList(els.taskgraph, [], () => null, 'Unavailable: ' + String(taskSource?.error || 'TaskStore records could not be read.'));
    setWorkspaceStatus(els.taskStatus, 'Unavailable: ' + String(taskSource?.error || 'TaskStore records could not be read.'), 'unavailable');
  }
  const goals = goalSource?.available === true && Array.isArray(goalSource.items) ? goalSource.items : [];
  const plans = planSource?.available === true && Array.isArray(planSource.items) ? planSource.items : [];
  if (goalSource?.available !== true && planSource?.available !== true) {
    renderList(els.missions, [], () => null, 'Unavailable: neither GoalStore nor PlanStore could be read.');
  } else {
    const noMissionMessage = goalSource?.available === true && planSource?.available === true
      ? 'No mission records are present in GoalStore or PlanStore.'
      : 'No mission records are present in the readable stores; another owner is unavailable.';
    renderMissions(goals, plans, noMissionMessage);
  }
}

async function submitWorkspaceAction(path, body, button, label, target, expectedStatuses) {
  if (button) button.disabled = true;
  setWorkspaceStatus(target, label + ' is being sent through the controller…', 'loading');
  let message = '';
  let tone = 'error';
  try {
    const result = await api(path, { method: 'POST', body });
    const expected = expectedStatuses.includes(result.status);
    const refreshed = await refresh();
    tone = expected ? (refreshed ? 'available' : 'partial') : 'error';
    message = label + ' controller result: ' + String(result.status || 'status not returned')
      + (result.display ? ' — ' + result.display : '');
    if (!refreshed) message += ' The authoritative state refresh is unavailable.';
  } catch (error) {
    message = label + ' failed: ' + String(error?.message || error);
  } finally {
    if (button) button.disabled = false;
  }
  setWorkspaceStatus(target, message, tone);
}

async function cancelPlan(planId, reason, button) {
  if (button) button.disabled = true;
  setWorkspaceStatus(els.missionStatus, 'Plan cancellation is being sent through the controller…', 'loading');
  let message = '';
  let tone = 'error';
  try {
    const result = await api('/api/plans/' + encodeURIComponent(planId) + '/cancel', {
      method: 'POST',
      body: { reason },
    });
    const expected = result.status === 'plan_stored';
    const refreshed = await refresh();
    tone = expected ? (refreshed ? 'available' : 'partial') : 'error';
    message = 'Plan cancellation controller result: ' + String(result.status || 'status not returned')
      + (result.display ? ' — ' + result.display : '');
    if (!refreshed) message += ' The authoritative state refresh is unavailable.';
  } catch (error) {
    message = 'Plan cancellation failed: ' + String(error?.message || error);
  } finally {
    if (button) button.disabled = false;
  }
  setWorkspaceStatus(els.missionStatus, message, tone);
}

function appendApprovalCapabilities(item, approval) {
  const capabilities = Array.isArray(approval.capabilities) ? approval.capabilities : [];
  if (capabilities.length === 0) {
    item.append(el('div', 'meta', approval.kind === 'situation' ? 'No action is named by this record.' : 'No capabilities are recorded for this request.'));
    return;
  }
  for (const capability of capabilities) {
    const scope = capability.scope?.recorded === true
      ? (capability.scope.resource || 'scope recorded without a label')
      : 'not recorded';
    item.append(el('div', 'meta', 'Capability ' + (capability.action || 'not recorded')
      + ' · permission ' + (capability.permission || 'not recorded')
      + ' · risk ' + (capability.risk || 'unknown')
      + ' · scope ' + scope
      + ' · reversibility ' + (capability.reversibility || 'unknown')));
  }
}

function appendSituationalDecisionForm(item, approval) {
  const notice = el('p', 'meta', 'These choices only record a user decision. This form cannot execute an action.');
  const form = document.createElement('form');
  form.className = 'row approval-decision';
  const selectId = 'situation-response-' + String(approval.eventId).replace(/[^A-Za-z0-9_-]/g, '-');
  const selectLabel = document.createElement('label');
  selectLabel.htmlFor = selectId;
  selectLabel.textContent = 'Record response';
  const select = document.createElement('select');
  select.id = selectId;
  for (const [value, title] of [
    ['record', 'Record'], ['investigate', 'Investigate'], ['notify', 'Notify'], ['recommend', 'Recommend'], ['ignore', 'Ignore'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = title;
    select.append(option);
  }
  const reasonId = 'situation-reason-' + String(approval.eventId).replace(/[^A-Za-z0-9_-]/g, '-');
  const reasonLabel = document.createElement('label');
  reasonLabel.htmlFor = reasonId;
  reasonLabel.className = 'visually-hidden';
  reasonLabel.textContent = 'Reason for situational decision';
  const reason = document.createElement('textarea');
  reason.id = reasonId;
  reason.rows = 2;
  reason.maxLength = 500;
  reason.required = true;
  reason.setAttribute('aria-label', reasonLabel.textContent);
  const button = el('button', 'small', 'Record decision');
  button.type = 'submit';
  form.append(selectLabel, select, reasonLabel, reason, button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = reason.value.trim();
    if (!text) {
      setWorkspaceStatus(els.approvalActionStatus, 'A reason is required for a situational decision.', 'error');
      return;
    }
    await submitWorkspaceAction('/api/situation/decide', {
      event: approval.eventId,
      response: select.value,
      reason: text,
    }, button, 'Situational decision', els.approvalActionStatus, ['success_verified']);
  });
  item.append(notice, form);
}

function approvalItemNode(approval) {
  const item = itemFrom(approval.request || approval.id, approval.kind + ' · ' + (approval.at || 'time not recorded'));
  item.append(el('div', 'meta', 'Owner record: ' + approval.id + ' · basis: ' + (approval.basis || 'not recorded')));
  item.append(el('div', 'meta', 'Risk: ' + (approval.risk || 'unknown')
    + ' · expiry: ' + (approval.expiryStatus === 'not_recorded' ? 'not recorded' : (approval.expiresAt || 'unknown'))
    + ' · reversibility: ' + (Array.isArray(approval.reversibility)
      ? approval.reversibility.map((entry) => entry.action + '=' + (entry.value || 'unknown')).join(', ')
      : (approval.reversibility || 'unknown'))));
  if (approval.taskId) item.append(el('div', 'meta', 'Task: ' + approval.taskId + (approval.stepId ? ' · step ' + approval.stepId : '')));
  if (approval.planId) item.append(el('div', 'meta', 'Plan: ' + approval.planId + (approval.version ? ' · version ' + approval.version : '')));
  if (approval.taskOrigin || approval.planner) item.append(el('div', 'meta', 'Task provenance: origin ' + (approval.taskOrigin || 'not recorded') + ' · planner ' + (approval.planner || 'not recorded')));
  if (approval.eventScope) {
    item.append(el('div', 'meta', 'Observation scope: ' + (approval.eventScope.source || 'source not recorded')
      + ' · ' + (approval.eventScope.category || 'category not recorded') + '/' + (approval.eventScope.type || 'type not recorded')
      + (approval.eventScope.stale ? ' · stale event' : '')));
    if (approval.eventScope.refs?.length) item.append(el('div', 'meta', 'References: ' + approval.eventScope.refs.join(', ')));
  }
  if (approval.event?.summary) item.append(el('div', 'meta', 'Recorded event: ' + approval.event.summary));
  if (approval.recordedSignificance) item.append(el('div', 'meta', 'Recorded significance: ' + approval.recordedSignificance));
  if (approval.requestedAction) item.append(el('div', 'meta', 'Requested action in owner record: ' + approval.requestedAction));
  if (approval.provenance) {
    item.append(el('div', 'meta', 'Observation provenance: origin ' + (approval.provenance.origin || 'not recorded')
      + ' · reporter ' + (approval.provenance.reporter || 'not recorded')
      + ' · provider ' + (approval.provenance.provider || 'not recorded')
      + ' · operation ' + (approval.provenance.operationId || 'not recorded')));
  }
  appendApprovalCapabilities(item, approval);
  if (approval.kind === 'task_plan' && approval.taskId) {
    const button = el('button', 'small', 'Approve recorded task plan');
    button.type = 'button';
    button.addEventListener('click', () => submitWorkspaceAction(
      '/api/tasks/' + encodeURIComponent(approval.taskId) + '/approve', {}, button,
      'Task-plan approval', els.approvalActionStatus, ['success_verified'],
    ));
    item.append(button);
  } else if (approval.kind === 'task_step' && approval.taskId && approval.stepId) {
    const button = el('button', 'small', 'Approve step ' + approval.stepId);
    button.type = 'button';
    button.addEventListener('click', () => submitWorkspaceAction(
      '/api/tasks/' + encodeURIComponent(approval.taskId) + '/approve', { stepId: approval.stepId }, button,
      'Task-step approval', els.approvalActionStatus, ['success_verified'],
    ));
    item.append(button);
  } else if (approval.kind === 'plan' && approval.planId) {
    const button = el('button', 'small', 'Approve recorded plan');
    button.type = 'button';
    button.addEventListener('click', () => submitWorkspaceAction(
      '/api/plans/' + encodeURIComponent(approval.planId) + '/approve', {}, button,
      'Plan approval', els.approvalActionStatus, ['plan_stored'],
    ));
    item.append(button);
  } else if (approval.kind === 'situation' && approval.eventId) {
    appendSituationalDecisionForm(item, approval);
  }
  return item;
}

function renderApprovalCentre(result) {
  const owner = ownerStatusText(result, 'Approval Centre');
  const value = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.approvalState, owner.text, owner.state);
    renderList(els.approvalItems, [], approvalItemNode, 'Unavailable: pending approvals could not be read.');
    return;
  }
  const sources = value?.sources || {};
  const missing = Object.entries(sources).filter(([, source]) => source?.available !== true).map(([name]) => name);
  const total = Number.isInteger(value.total) ? value.total : (Array.isArray(value.items) ? value.items.length : 0);
  const shown = Array.isArray(value.items) ? value.items.length : 0;
  if (value.status === 'partial' || missing.length > 0) {
    setWorkspaceStatus(els.approvalState, 'Partial owner read; unavailable: ' + (missing.join(', ') || 'one or more stores')
      + '. Showing ' + shown + ' of ' + total + ' known request(s).', 'partial');
  } else if (total === 0) {
    setWorkspaceStatus(els.approvalState, 'No pending approval requests are recorded in the readable owner stores.', 'empty');
  } else {
    setWorkspaceStatus(els.approvalState, 'Showing ' + shown + ' of ' + total + ' owner-recorded pending request(s)'
      + (value.truncated ? ' (bounded view).' : '.'), 'available');
  }
  const emptyMessage = value.status === 'partial'
    ? 'No pending requests were found in the readable stores; other owners are unavailable.'
    : (value.truncated ? 'Requests exist, but this bounded page did not return an item.' : 'No pending approval requests are recorded.');
  renderList(els.approvalItems, value.items, approvalItemNode, emptyMessage);
}

function renderSentinel(result) {
  const owner = ownerStatusText(result, 'Sentinel');
  const situation = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.sentinelStatus, owner.text, owner.state);
    renderList(els.sentinelFull, [], () => null, 'Unavailable: situational records could not be read.');
    renderList(els.sentinel, [], () => null, 'Unavailable: situational records could not be read.');
    return;
  }
  const recent = Array.isArray(situation.recent) ? situation.recent : [];
  const total = Number.isInteger(situation.recentTotal) ? situation.recentTotal : recent.length;
  const alerts = Array.isArray(situation.alerts) ? situation.alerts.length : 0;
  const pending = Array.isArray(situation.pendingApprovals) ? situation.pendingApprovals.length : 0;
  const bounded = situation.recentTruncated === true || recent.length < total;
  let statusText = total === 0 ? 'No situational observation records are present in SituationStore.'
    : 'Showing ' + recent.length + ' of ' + total + ' recorded observation(s)';
  statusText += ' · recorded alerts ' + alerts + ' · pending approvals ' + pending;
  if (bounded) statusText += ' · bounded view';
  statusText += '. These are records, not verified current-world truth.';
  setWorkspaceStatus(els.sentinelStatus, statusText, total === 0 ? 'empty' : 'available');
  const mapper = (row) => {
    const at = row.at ? String(row.at) : 'time not recorded';
    const confidence = Number.isFinite(row.confidence) ? 'confidence ' + row.confidence : 'confidence not recorded';
    const significance = row.significance?.level ? 'significance ' + row.significance.level : 'not assessed';
    const provenance = row.provenance ? [row.provenance.reporter, row.provenance.provider, row.provenance.operationId].filter(Boolean).join(' · ') : 'provenance not available';
    const stale = row.stale ? ' · stale observation' : '';
    const decision = row.decision ? ' · decision ' + (row.decision.response || 'not recorded') : ' · no decision recorded';
    const item = itemFrom(row.summary || row.type || row.id, (row.source || 'source not recorded')
      + ' · ' + (row.category || 'category not recorded') + '/' + (row.type || 'type not recorded')
      + ' · ' + at + ' · ' + confidence + ' · ' + significance + stale + decision);
    item.append(el('div', 'meta', 'Basis: recorded observation · provenance: ' + provenance));
    if (row.recommended) item.append(el('div', 'meta', 'Recorded recommendation: ' + row.recommended));
    if (row.sourceEventId) item.append(el('div', 'meta', 'Source event id: ' + row.sourceEventId));
    if (row.refs) {
      const refs = [
        ...(row.refs.entities || []).map((id) => 'entity:' + id),
        ...(row.refs.goals || []).map((id) => 'goal:' + id),
        ...(row.refs.plans || []).map((id) => 'plan:' + id),
        ...(row.refs.tasks || []).map((id) => 'task:' + id),
      ];
      if (refs.length) item.append(el('div', 'meta', 'References: ' + refs.join(', ')));
    }
    if (row.validUntil) item.append(el('div', 'meta', 'Observation valid until: ' + row.validUntil));
    if (row.worldRefs && Object.keys(row.worldRefs).length) {
      item.append(el('div', 'meta', 'World-model record references: ' + Object.entries(row.worldRefs).map(([key, id]) => key + ':' + id).join(', ')));
    }
    return item;
  };
  renderList(els.sentinelFull, recent, mapper, 'No situational observations have been recorded.');
  renderList(els.sentinel, recent.slice(0, 5), mapper, 'No situational observations have been recorded.');
}

function renderTimeline(result) {
  const owner = ownerStatusText(result, 'Memory Timeline');
  const value = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.timelineStatus, owner.text, owner.state);
    for (const [target, statusTarget, label] of [
      [els.memory, els.memoryRecordsStatus, 'memory'],
      [els.knowledge, els.knowledgeStatus, 'knowledge'],
      [els.world, els.worldStatus, 'world-model'],
    ]) {
      setWorkspaceStatus(statusTarget, 'Unavailable: ' + label + ' timeline could not be read.', 'unavailable');
      renderList(target, [], () => null, 'Unavailable: ' + label + ' timeline could not be read.');
    }
    renderList(els.timeline, [], () => null, 'Unavailable: timeline owners did not return a snapshot.');
    return;
  }
  const sources = value.sources || {};
  const missing = Object.entries(sources).filter(([, source]) => source?.available !== true).map(([name]) => name);
  const items = Array.isArray(value.items) ? value.items : [];
  if (value.status === 'partial' || missing.length > 0) {
    setWorkspaceStatus(els.timelineStatus, 'Partial owner read; unavailable: ' + (missing.join(', ') || 'memory integrity is incomplete')
      + '. Showing ' + items.length + ' of ' + (value.total ?? items.length) + ' readable timeline record(s).', 'partial');
  } else if (items.length === 0) {
    setWorkspaceStatus(els.timelineStatus, 'No memory, knowledge, or world-model timeline records are present.', 'empty');
  } else {
    setWorkspaceStatus(els.timelineStatus, 'Showing ' + items.length + ' of ' + (value.total ?? items.length)
      + ' chronological owner record(s)' + (value.truncated ? ' (bounded view).' : '.')
      + ' Records preserve provenance; they do not establish truth.', 'available');
  }
  const timelineMapper = (row) => {
    const provenance = row.provenance || {};
    const item = itemFrom(row.summary || row.id, (row.source || 'owner not recorded') + ' · ' + (row.kind || row.type || 'record')
      + ' · ' + (row.at || 'time not recorded') + (row.status ? ' · ' + row.status : ''));
    if (row.source === 'memory') {
      item.append(el('div', 'meta', 'Memory provenance: source ' + (provenance.source || 'not recorded')
        + ' · kind ' + (provenance.memoryKind || 'not recorded')
        + ' · origin ' + (provenance.origin || 'not recorded')
        + ' · update mode ' + (provenance.updateMode || 'not recorded')
        + ' · backend ' + (provenance.backend || 'not recorded')
        + ' · operation ' + (provenance.operationId || 'not recorded')));
      if (provenance.replaces?.length) item.append(el('div', 'meta', 'Replaces records: ' + provenance.replaces.join(', ')));
      if (provenance.replacedBy?.length) item.append(el('div', 'meta', 'Replaced by records: ' + provenance.replacedBy.join(', ')));
    } else if (row.source === 'knowledge') {
      item.append(el('div', 'meta', 'Knowledge provenance: origin ' + (provenance.origin || 'not recorded')
        + ' · operation ' + (provenance.operationId || 'not recorded')
        + ' · update mode ' + (provenance.updateMode || 'not recorded')));
      if (provenance.document) item.append(el('div', 'meta', 'Document provenance: ' + (provenance.document.documentId || 'id not recorded')
        + ' · version ' + (provenance.document.version ?? 'not recorded')
        + ' · section ' + (provenance.document.section || 'not recorded')
        + ' · locator ' + (provenance.document.locator || 'not recorded')));
      if (row.targetIds?.length) item.append(el('div', 'meta', 'Lifecycle targets: ' + row.targetIds.join(', ')));
      if (row.replaces?.length) item.append(el('div', 'meta', 'Supersedes records: ' + row.replaces.join(', ')));
      if (row.replacedBy?.length) item.append(el('div', 'meta', 'Superseded by: ' + row.replacedBy.join(', ')));
      if (row.conflictsWith?.length) item.append(el('div', 'meta', 'Recorded conflicts: ' + row.conflictsWith.join(', ')));
    } else if (row.source === 'world') {
      item.append(el('div', 'meta', 'World-model provenance: origin ' + (provenance.origin || 'not recorded')));
      if (provenance.evidence?.length) item.append(el('div', 'meta', 'Cited evidence: ' + provenance.evidence.map((entry) => (
        (entry.relation || 'relation not recorded') + ' · ' + (entry.sourceType || 'source type not recorded') + ':' + (entry.sourceId || 'source id not recorded')
      )).join('; ')));
    }
    return item;
  };
  const timelineEmpty = value.status === 'partial'
    ? 'No timeline rows were returned by the readable owners; one or more owners are unavailable.'
    : 'No memory, knowledge, or world-model timeline records are present.';
  renderList(els.timeline, items, timelineMapper, timelineEmpty);
  for (const [key, target, statusTarget, label, emptyMessage] of [
    ['memory', els.memory, els.memoryRecordsStatus, 'memory', 'No memory records are present in MemoryStore.'],
    ['knowledge', els.knowledge, els.knowledgeStatus, 'knowledge', 'No knowledge claims or lifecycle records are present.'],
    ['world', els.world, els.worldStatus, 'world-model', 'No world-model changes are recorded.'],
  ]) {
    const source = sources[key];
    reportSource(statusTarget, source, label);
    const mapper = (row) => itemFrom(row.summary || row.id, (row.kind || row.type || 'record')
      + ' · ' + (row.at || 'time not recorded') + (row.status ? ' · ' + row.status : ''));
    renderOwnerItems(target, source, mapper, label, emptyMessage);
  }
}

function renderBriefing(result) {
  const owner = ownerStatusText(result, 'Briefing');
  const value = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.briefingStatus, owner.text, owner.state);
    renderList(els.briefings, [], () => null, 'Unavailable: briefing owners could not be read.');
    return;
  }
  const sources = value.sources || {};
  const missing = Object.entries(sources).filter(([, source]) => source?.available !== true).map(([name]) => name);
  const facts = Array.isArray(value.facts) ? value.facts : [];
  const inferences = Array.isArray(value.inferred) ? value.inferred : [];
  if (value.status === 'partial' || missing.length > 0) {
    setWorkspaceStatus(els.briefingStatus, 'Partial owner read; unavailable: ' + (missing.join(', ') || 'one or more stores')
      + '. Facts are limited to readable stores; inferred counts from missing owners are omitted.', 'partial');
  } else if (facts.length === 0 && inferences.length === 0) {
    setWorkspaceStatus(els.briefingStatus, 'No briefing facts are recorded by the current owners.', 'empty');
  } else {
    setWorkspaceStatus(els.briefingStatus, 'Generated at ' + (value.generatedAt || 'time not recorded')
      + ' · ' + facts.length + ' owner facts · ' + inferences.length + ' explicitly labeled heuristic(s).', 'available');
  }
  const rows = [];
  for (const fact of facts) rows.push({ title: fact.text || fact.id || fact.kind, meta: 'Recorded fact · ' + (fact.kind || 'kind not recorded')
    + ' · ' + (fact.status || 'status not recorded') + (fact.id ? ' · record ' + fact.id : '') });
  for (const inference of inferences) rows.push({ title: inference.text, meta: 'Heuristic inference, not a verified outcome · '
    + (inference.kind || 'kind not recorded') + ' · basis: ' + (inference.basis || 'not recorded') });
  renderList(els.briefings, rows, (row) => itemFrom(row.title, row.meta),
    value.status === 'partial' ? 'No facts came from readable owners; unavailable owners are named above.' : 'No briefing facts are recorded.');
  renderBriefingDelta(value.delta ?? null);
}

// T-34 Step 3: the delta. Each change names the view it belongs to and, for a task, the task itself,
// so the owner can go and look at the thing that changed. When nothing has been acknowledged the panel
// says exactly that instead of presenting the whole state as news.
function renderBriefingDelta(delta) {
  if (!els.briefingDelta) return;
  if (!delta) {
    setWorkspaceStatus(els.briefingDeltaStatus, 'No delta is recorded; the briefing could not be compared with a checkpoint.', 'empty');
    renderList(els.briefingDelta, [], () => null, 'No delta is recorded.');
    return;
  }
  if (delta.available !== true) {
    setWorkspaceStatus(els.briefingDeltaStatus, String(delta.text || 'No prior briefing checkpoint recorded — showing full current state'), 'empty');
    renderList(els.briefingDelta, [], () => null, String(delta.text || 'No prior briefing checkpoint recorded.'));
    return;
  }
  const items = Array.isArray(delta.items) ? delta.items : [];
  if (items.length === 0) {
    setWorkspaceStatus(els.briefingDeltaStatus, String(delta.text || 'Nothing has changed since the last briefing.'), 'available');
    renderList(els.briefingDelta, [], () => null, 'Nothing has changed since the last briefing.');
    return;
  }
  setWorkspaceStatus(els.briefingDeltaStatus, String(delta.text || items.length + ' change(s) since the last briefing.')
    + (delta.checkpointId ? ' · checkpoint ' + delta.checkpointId : ''), 'available');
  renderList(els.briefingDelta, items, (item) => {
    const node = itemFrom(item.text || item.kind, item.kind + (item.taskId ? ' · task ' + item.taskId : ''));
    node.dataset.kind = item.kind;
    if (item.goto && item.goto.view) node.dataset.gotoView = item.goto.view;
    if (item.goto && item.goto.task) node.dataset.gotoTask = item.goto.task;
    if (item.taskId) node.dataset.taskId = item.taskId;
    // The whole row is the link: it moves the owner to the view, and to the task where one is named.
    // Nothing is executed by looking.
    if (item.goto && item.goto.view) {
      node.tabIndex = 0;
      node.setAttribute('role', 'link');
      const go = () => {
        setView(item.goto.view);
        if (item.goto.task && els.dagSelect) {
          els.dagSelect.value = item.goto.task;
          loadSelectedTaskGraph(item.goto.task);
        }
      };
      node.addEventListener('click', go);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          go();
        }
      });
      const button = el('button', 'small', 'Go to ' + item.goto.view);
      button.type = 'button';
      button.dataset.go = item.goto.view;
      if (item.goto.task) button.dataset.gotoTask = item.goto.task;
      node.append(button);
    }
    return node;
  }, 'Nothing has changed since the last briefing.');
}

function renderHealth(result) {
  if (!els.health) return;
  els.health.replaceChildren();
  if (els.healthOverall) els.healthOverall.replaceChildren();
  const owner = ownerStatusText(result, 'Health');
  const health = result?.ok === true ? result.value : null;
  if (owner.text) {
    renderList(els.health, [], () => null, owner.text);
    return;
  }
  const areas = Array.isArray(health.areas) ? health.areas : [];
  if (els.healthOverall) els.healthOverall.append(el('span', 'badge', 'overall: ' + (health.overall || 'unknown')));
  for (const area of areas) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', area.label || area.key || 'subsystem'));
    head.append(el('span', 'badge', (area.state || 'unknown') + (area.advisory && area.state === 'unknown' ? ' / not checked' : '')));
    item.append(head);
    item.append(el('div', 'meta', area.summary || 'No health detail recorded.'));
    els.health.append(item);
  }
  if (areas.length === 0) renderList(els.health, [], () => null, 'The health owner returned no subsystem rows.');
}

function renderSystemStatus(snapshot, healthResult) {
  if (!snapshot) {
    setWorkspaceStatus(els.systemStatus, 'Unavailable: the authoritative system snapshot could not be read.', 'unavailable');
    return;
  }
  const health = healthResult?.ok === true ? healthResult.value : null;
  const runtime = snapshot.runtime;
  const latch = snapshot.killSwitch;
  const resources = snapshot.resources;
  const parts = [];
  const missing = [];
  if (health) parts.push('health reports ' + (health.overall || 'unknown'));
  else missing.push('health');
  if (runtime && !runtime.unavailable) parts.push('runtime lifecycle ' + (runtime.lifecycle || runtime.status || 'unknown'));
  else missing.push('runtime');
  if (latch && typeof latch.active === 'boolean' && latch.policyUnavailable !== true && !latch.unavailable) {
    parts.push('ECP latch ' + (latch.active ? 'ACTIVE' : 'clear'));
  } else {
    parts.push('ECP latch unavailable or policy unavailable');
    missing.push('ECP latch');
  }
  if (resources && !resources.unavailable) parts.push('resource telemetry returned');
  else missing.push('resource telemetry');
  setWorkspaceStatus(els.systemStatus, parts.join(' · ') + (missing.length ? ' · unavailable: ' + missing.join(', ') : ''), missing.length ? 'partial' : 'available');
}

function renderRuntime(result) {
  const owner = ownerStatusText(result, 'Runtime');
  const runtime = result?.ok === true ? result.value : null;
  if (owner.text || !runtime || runtime.unavailable) {
    const message = owner.text || ('Unavailable: ' + String(runtime?.unavailable || 'runtime status was not returned.'));
    renderList(els.runtime, [], () => null, message);
    return;
  }
  const meta = [
    runtime.runtimeId ? 'runtime ' + runtime.runtimeId : null,
    'paused ' + (runtime.paused === true ? 'yes' : runtime.paused === false ? 'no' : 'unknown'),
    Number.isInteger(runtime.ticks) ? 'ticks ' + runtime.ticks : null,
    Number.isInteger(runtime.backlog) ? 'backlog ' + runtime.backlog : null,
    runtime.lastError ? 'last error ' + runtime.lastError : null,
    runtime.corruption ? 'corruption ' + runtime.corruption : null,
  ].filter(Boolean).join(' · ');
  renderList(els.runtime, [runtime], (row) => itemFrom(row.lifecycle || row.status || 'runtime status not recorded', meta), 'Runtime returned no status record.');
}

function renderResources(result) {
  const owner = ownerStatusText(result, 'Resource Fabric');
  const value = result?.ok === true ? result.value : null;
  if (owner.text || !value || value.unavailable) {
    const message = owner.text || ('Unavailable: ' + String(value?.unavailable || 'resource telemetry was not returned.'));
    setWorkspaceStatus(els.resourcesStatus, message, owner.text ? owner.state : 'unavailable');
    renderList(els.resources, [], () => null, message);
    return;
  }
  const megabytes = (bytes) => (Number.isFinite(bytes) ? Math.round(bytes / 1048576) + ' MB' : 'not reported');
  const rows = [];
  const cpu = value.cpu || {};
  rows.push({ title: 'CPU', meta: (cpu.available === true && Number.isInteger(cpu.logicalCount))
    ? cpu.logicalCount + ' logical processors reported by the host'
    : 'not reported by the Resource Fabric' });
  const memory = value.memory || {};
  rows.push({ title: 'Memory', meta: memory.available === true
    ? megabytes(memory.freeBytes) + ' free of ' + megabytes(memory.totalBytes)
    : 'not reported by the Resource Fabric' });
  const gpu = value.gpu || {};
  rows.push({ title: 'GPU', meta: gpu.reported === true
    ? 'reported'
    : 'unavailable: ' + String(gpu.reason || 'no GPU telemetry provider') });
  const network = value.network || {};
  rows.push({ title: 'Network', meta: network.reported === true
    ? 'reported'
    : 'unavailable: ' + String(network.reason || 'no network telemetry provider') });
  const storage = Array.isArray(value.storage) ? value.storage : [];
  for (const volume of storage) {
    rows.push({ title: 'Storage ' + String(volume.path || 'path not reported'), meta: volume.reported === true
      ? megabytes(volume.availableBytes) + ' available of ' + megabytes(volume.totalBytes)
      : 'unavailable: ' + String(volume.reason || 'statfs did not report this path') });
  }
  const unreported = [cpu.available !== true ? 'CPU' : null, memory.available !== true ? 'memory' : null,
    gpu.reported !== true ? 'GPU' : null, network.reported !== true ? 'network' : null,
    storage.some((volume) => volume.reported !== true) ? 'storage' : null].filter(Boolean);
  setWorkspaceStatus(els.resourcesStatus, rows.length + ' resource reading(s) returned'
    + (value.at ? ' at ' + value.at : '')
    + (unreported.length ? ' · not reported: ' + unreported.join(', ') : '')
    + ' · reservations held: ' + (Number.isInteger(value.reservations) ? value.reservations : 'not reported') + '.',
  unreported.length ? 'partial' : 'available');
  renderList(els.resources, rows, (row) => itemFrom(row.title, row.meta), 'The Resource Fabric returned no readings.');
}

function renderSources(result) {
  const owner = ownerStatusText(result, 'Integrations');
  const sources = result?.ok === true ? result.value : null;
  if (owner.text || !sources || sources.unavailable) {
    const message = owner.text || ('Unavailable: ' + String(sources?.unavailable || 'integration status was not returned.'));
    setWorkspaceStatus(els.integrationsStatus, message, owner.text ? owner.state : 'unavailable');
    renderList(els.sources, [], () => null, message);
    renderList(els.integrations, [], () => null, message);
    return;
  }
  const providers = Array.isArray(sources.providers) ? sources.providers : [];
  const enabled = Number.isInteger(sources.enabled) ? sources.enabled : providers.filter((provider) => provider.enabled === true).length;
  const corruption = sources.corruption;
  const damaged = corruption && (corruption === true || (typeof corruption === 'object' && Object.keys(corruption).length > 0));
  const statusText = providers.length === 0 ? 'No integration providers are registered.'
    : providers.length + ' provider record(s); ' + enabled + ' enabled' + (sources.paused ? ' · polling paused' : '') + '.';
  setWorkspaceStatus(els.integrationsStatus, statusText + (damaged ? ' Provider state reports corruption.' : ''), damaged ? 'partial' : (providers.length ? 'available' : 'empty'));
  const mapper = (row) => {
    const health = row.health || {};
    const details = [
      row.kind || 'kind not recorded',
      row.enabled === true ? 'enabled' : 'disabled',
      Number.isInteger(health.observed) ? 'observed ' + health.observed : 'observed not recorded',
      Number.isInteger(health.accepted) ? 'accepted ' + health.accepted : null,
      Number.isInteger(health.rejected) && health.rejected > 0 ? 'rejected ' + health.rejected : null,
      health.exhausted ? 'retry limit reached' : null,
      health.lastSuccessAt ? 'last success ' + health.lastSuccessAt : 'no successful poll recorded',
      health.lastError ? 'last error ' + health.lastError : null,
      row.nextPollAt ? 'next poll ' + row.nextPollAt : null,
      row.scope ? 'scope ' + JSON.stringify(row.scope) : null,
    ].filter(Boolean).join(' · ');
    return itemFrom(row.name || row.id || 'integration provider', details);
  };
  const empty = 'No integration providers are registered.';
  renderList(els.sources, providers, mapper, empty);
  renderList(els.integrations, providers, mapper, empty);
}

function renderDocuments(result) {
  const owner = ownerStatusText(result, 'Document index');
  const documents = result?.ok === true ? result.value : null;
  if (owner.text || !documents || documents.unavailable) {
    const message = owner.text || ('Unavailable: ' + String(documents?.unavailable || 'document records could not be read.'));
    setWorkspaceStatus(els.documentsStatus, message, owner.text ? owner.state : 'unavailable');
    renderList(els.documents, [], () => null, message);
    return;
  }
  const docs = Array.isArray(documents.documents) ? documents.documents : [];
  const results = Array.isArray(documents.results) ? documents.results : [];
  const items = results.length ? results : docs;
  const corrupt = Number.isInteger(documents.corrupt) ? documents.corrupt : 0;
  const total = Number.isInteger(documents.documentsTotal) ? documents.documentsTotal
    : (Number.isInteger(documents.indexed) ? documents.indexed : 0)
      + (Number.isInteger(documents.failed) ? documents.failed : 0)
      + (Number.isInteger(documents.deleted) ? documents.deleted : 0);
  const query = documents.query ? 'Search returned ' + results.length + ' result(s) for the submitted query.'
    : 'Document owner reports ' + docs.length + ' row(s) in this bounded listing; indexed ' + (documents.indexed ?? 'unknown')
      + ', failed ' + (documents.failed ?? 'unknown') + ', deleted ' + (documents.deleted ?? 'unknown') + '.';
  setWorkspaceStatus(els.documentsStatus, query + (corrupt ? ' ' + corrupt + ' corrupt record(s) were reported.' : ''), corrupt ? 'partial' : (total === 0 ? 'empty' : 'available'));
  renderList(els.documents, items, (doc) => {
    const title = doc.title || doc.documentId || doc.id || doc.path || 'document';
    const meta = [doc.status || doc.summary || 'status not recorded', doc.path || null,
      doc.version ? 'version ' + doc.version : null, doc.bytes !== undefined ? doc.bytes + ' bytes' : null,
      doc.score !== undefined ? 'score ' + doc.score : null].filter(Boolean).join(' · ');
    return itemFrom(title, meta);
  }, documents.query ? 'No matching document results were returned.' : 'No document records are present in the index.');
}

function renderReasoning(result) {
  const owner = ownerStatusText(result, 'Reasoning');
  const reasoning = result?.ok === true ? result.value : null;
  if (owner.text || !reasoning || reasoning.unavailable) {
    const message = owner.text || ('Unavailable: ' + String(reasoning?.unavailable || 'reasoning records could not be read.'));
    setWorkspaceStatus(els.reasoningStatus, message, owner.text ? owner.state : 'unavailable');
    renderList(els.reasoning, [], () => null, message);
    return;
  }
  const sessions = Array.isArray(reasoning.sessions) ? reasoning.sessions : [];
  const status = reasoning.status || {};
  const total = Number.isInteger(reasoning.total) ? reasoning.total : (Number.isInteger(status.sessions) ? status.sessions : sessions.length);
  const corrupt = Number.isInteger(status.corrupt) ? status.corrupt : 0;
  setWorkspaceStatus(els.reasoningStatus, total === 0 ? 'No reasoning sessions are recorded.'
    : 'Showing ' + sessions.length + ' of ' + total + ' recorded reasoning session(s)'
      + (Number.isInteger(status.invalidated) ? ' · invalidated ' + status.invalidated : '') + '.'
      + (corrupt ? ' ' + corrupt + ' corrupt record(s) were reported.' : ''), corrupt ? 'partial' : (total === 0 ? 'empty' : 'available'));
  renderList(els.reasoning, sessions, (session) => itemFrom(session.request || session.sessionId || session.id || 'session',
    (session.sessionId ? 'session ' + session.sessionId + ' · ' : '')
      + (session.status || 'status not recorded')
      + (session.at ? ' · ' + session.at : ' · time not recorded')
      + (session.invalidated ? ' · invalidated at ' + (session.invalidatedAt || 'time not recorded') : '')
      + (session.summary ? ' · ' + session.summary : '')),
  'No reasoning sessions are recorded.');
}

function renderConversation(snapshot) {
  if (!snapshot) {
    setWorkspaceStatus(els.conversationStatus, 'Unavailable: conversation snapshot could not be read.', 'unavailable');
    renderList(els.conversationHistory, [], () => null, 'Unavailable: conversation records could not be read.');
    renderTurns([], 'Conversation state is unavailable.');
    return;
  }
  const session = snapshot.session || {};
  const conversationError = typeof session.unavailable === 'string' && session.unavailable.startsWith('conversation history is unavailable:')
    ? session.unavailable : null;
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  if (conversationError || ['corrupt', 'unavailable'].includes(session.status)) {
    const message = conversationError || 'Conversation session state is ' + session.status + '.';
    setWorkspaceStatus(els.conversationStatus, 'Unavailable: ' + message, 'unavailable');
    renderList(els.conversationHistory, [], () => null, 'Unavailable: conversation history could not be read.');
    renderTurns([], 'Conversation history is unavailable.');
    return;
  }
  const sessionText = session.status === 'ok' ? 'Current session has ' + turns.length + ' returned turn(s).'
    : 'No active conversation session is recorded.';
  setWorkspaceStatus(els.conversationStatus, sessionText + ' Earlier sessions are not included in this current-session view.', turns.length ? 'available' : 'empty');
  const empty = session.status === 'ok' ? 'No turns are recorded in the current session.' : 'No active session or current-session turns are recorded.';
  renderList(els.conversationHistory, turns, (turn) => itemFrom(turn.text || turn.id || 'turn',
    (turn.role || 'role not recorded') + (turn.at ? ' · ' + turn.at : '') + (turn.verified ? ' · verified outcome' : '')),
  empty);
  renderTurns(turns, empty);
}

// ---- T-29 cognitive trace --------------------------------------------------
// Five stage blocks, each built from the run record only. No field is synthesised here: a
// missing value renders as "not recorded", and an approval button appears only when the run
// itself says a step is waiting for the owner.
function cognitionStage(title, lines) {
  const section = el('section', 'cognition-stage');
  section.append(el('h3', null, title));
  for (const line of lines) {
    if (line === null || line === undefined || line === '') continue;
    section.append(el('p', 'meta', line));
  }
  return section;
}

function renderCognitionTrace(run) {
  if (!els.cognitionTrace) return;
  els.cognitionTrace.replaceChildren();
  if (!run || typeof run !== 'object') {
    els.cognitionTrace.append(el('p', 'meta', 'No cognitive run is recorded yet. Run the pipeline to record one.'));
    return;
  }
  const stages = run.stages || {};
  const packet = stages.context || {};
  const epistemic = packet.epistemic || {};
  const salience = stages.salience || {};
  const council = stages.council || {};
  const graph = stages.task_graph || {};
  const execution = stages.execution || {};

  els.cognitionTrace.append(el('p', 'meta', 'Run ' + String(run.runId || 'recorded') + ' · status ' + String(run.status || 'unknown')
    + ' · ' + String(run.at || 'time not recorded') + ' · action ' + String(run.action?.name || 'not recorded')));

  const memoryCount = packet.memory?.count ?? 0;
  const knowledgeCount = packet.knowledge?.count ?? 0;
  const worldCount = packet.world?.count ?? 0;
  const contextLines = [
    'Owner context: ' + (packet.owner?.activeGoals || []).length + ' active goal(s) with recorded criteria.',
    'Memory ' + memoryCount + ' · knowledge ' + knowledgeCount + ' · world facts ' + worldCount + '.',
    'Epistemic tags: ' + (epistemic.observed ?? 0) + ' observed · ' + (epistemic.inferred ?? 0) + ' inferred · '
      + (epistemic.assumed ?? 0) + ' assumed · ' + (epistemic.predicted ?? 0) + ' predicted.',
    packet.sentinel?.error ? 'Sentinel unavailable: ' + packet.sentinel.error : 'Sentinel advisories: ' + ((packet.sentinel?.advisories || []).length),
  ];
  for (const advisory of packet.sentinel?.advisories || []) {
    contextLines.push('Advisory' + (advisory.severity ? ' (' + advisory.severity + ')' : '') + ': ' + (advisory.summary || advisory.detail || advisory.kind || 'not described'));
  }
  for (const problem of packet.problems || []) contextLines.push('Read problem: ' + problem);
  els.cognitionTrace.append(cognitionStage('1 · Context, memory and world model', contextLines));

  const reading = (value) => (value === null || value === undefined ? 'unavailable' : String(value));
  els.cognitionTrace.append(cognitionStage('2 · Salience, resources and Sentinel', [
    'urgency ' + reading(salience.urgency) + ' · confidence ' + reading(salience.confidence)
      + ' · uncertainty ' + reading(salience.uncertainty) + ' · goal progress ' + reading(salience.goal_progress)
      + ' · resource pressure ' + reading(salience.resource_pressure) + ' · risk sensitivity ' + reading(salience.risk_sensitivity)
      + ' · novelty ' + reading(salience.novelty),
    salience.basis?.resource_pressure ? 'Resource basis: ' + salience.basis.resource_pressure : null,
    salience.basis?.confidence ? 'Confidence basis: ' + salience.basis.confidence : null,
    salience.basis?.goal_progress ? 'Goal basis: ' + salience.basis.goal_progress : null,
    'Read-only: these variables advise; the ECP decides.',
  ]));

  const councilLines = [];
  if (council.status === 'ran') {
    const view = (label, position) => (position
      ? label + ': ' + position.verdict + ' — ' + position.summary
      : label + ': not recorded');
    councilLines.push(view('Thesis', council.perspectives?.thesis));
    councilLines.push(view('Counter-risk', council.perspectives?.counter_risk));
    councilLines.push(view('Evidence check', council.perspectives?.evidence_check));
    if (council.recommendation) {
      councilLines.push('Recommendation: ' + council.recommendation.summary + ' (support ' + council.recommendation.support
        + ', confidence ' + council.recommendation.confidence + ')');
    }
    councilLines.push('Session ' + String(council.sessionId || 'not recorded') + ' · deliberation data, not a permission.');
  } else {
    councilLines.push('Council ' + String(council.status || 'not run') + (council.reason ? ': ' + council.reason : ''));
  }
  els.cognitionTrace.append(cognitionStage('3 · Council synthesis', councilLines));

  const graphLines = [(graph.summary || 'not recorded')];
  for (const node of graph.nodes || []) {
    graphLines.push('Step ' + String(node.id) + ': ' + String(node.action) + ' · permission ' + String(node.permission)
      + ' · risk ' + String(node.risk) + (node.description ? ' — ' + node.description : ''));
  }
  graphLines.push('Plan rule: ' + String(graph.rule || 'not recorded'));
  els.cognitionTrace.append(cognitionStage('4 · Task graph', graphLines));

  const executionLines = [
    'Status: ' + String(run.status || 'unknown') + ' · ECP decision ' + String(execution.decision || 'not requested')
      + (execution.reason ? ' (' + execution.reason + ')' : ''),
    'Autonomy level: ' + reading(execution.autonomyLevel) + (execution.autonomySource ? ' · ' + execution.autonomySource : ''),
    'Latch: ' + (execution.latch ? (execution.latch.active ? 'active' : (execution.latch.policyUnavailableLatch ? 'unreadable' : 'clear')) : 'not recorded'),
    'Verification: ' + String(run.verification?.outcome || 'not_run') + (run.verification?.detail ? ' — ' + run.verification.detail : ''),
  ];
  if (run.approval?.required) {
    executionLines.push('Approval: ' + String(run.approval.status) + (run.approval.waitingSteps?.length ? ' for step(s) ' + run.approval.waitingSteps.join(', ') : ''));
    if (run.approval.recorded) executionLines.push('Recorded approval: ' + String(run.approval.recorded.approvedBy || 'owner') + ' at ' + String(run.approval.recorded.at || run.approval.recorded.approvedAt || 'not recorded'));
  }
  if (run.halted) executionLines.push('Halted: ' + String(run.halted.reason) + ' — ' + String(run.halted.detail || ''));
  if (run.task?.id) executionLines.push('Task ' + String(run.task.id) + ' · ' + String(run.task.status));
  els.cognitionTrace.append(cognitionStage('5 · Governed execution', executionLines));

  if (run.status === 'awaiting_approval' && run.task?.id) {
    const waiting = run.approval?.waitingSteps?.[0] || 's1';
    const approve = el('button', 'small', 'Approve step ' + waiting + ' and execute');
    approve.type = 'button';
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      els.cognitionRunStatus.textContent = 'Recording your approval for step ' + waiting + '…';
      try {
        const data = await api('/api/cognition/runs/' + encodeURIComponent(run.runId) + '/approve', { method: 'POST', body: { stepId: waiting } });
        state.lastCognitionRun = data.run || null;
        renderCognitionTrace(data.run || null);
        els.cognitionRunStatus.textContent = 'Approval recorded; the run is ' + String(data.runStatus || 'reported') + '.';
      } catch (err) {
        els.cognitionRunStatus.textContent = 'The approval was refused: ' + String(err.message || err);
        approve.disabled = false;
      }
      scheduleEventRefresh();
    });
    els.cognitionTrace.append(approve);
  }
}

function renderCognition(result) {
  if (!els.cognitionRuns) return;
  if (!result) {
    setWorkspaceStatus(els.cognitionStatus, 'Loading recorded cognitive runs…', 'loading');
    return;
  }
  if (result.ok !== true) {
    const state = result.status >= 500 ? 'unavailable' : 'error';
    setWorkspaceStatus(els.cognitionStatus, (state === 'unavailable' ? 'Unavailable: ' : 'Read error: ') + result.error, state);
    renderList(els.cognitionRuns, [], () => null, 'Unavailable: no cognitive run can be shown.');
    return;
  }
  const runs = Array.isArray(result.value.runs) ? result.value.runs : [];
  setWorkspaceStatus(els.cognitionStatus, runs.length === 0
    ? 'No cognitive run has been recorded yet.'
    : String(runs.length) + ' recorded run(s); the newest is shown above.', runs.length ? 'available' : 'empty');
  renderCognitionTrace(runs[0] ?? state.lastCognitionRun);
  renderList(els.cognitionRuns, runs, (run) => itemFrom(
    String(run.runId || 'run') + ' · ' + String(run.status || 'unknown'),
    String(run.intent || '') + ' · ' + String(run.action?.name || 'no action') + ' · verification '
      + String(run.verification?.outcome || 'not_run'),
  ), 'No cognitive run has been recorded yet.');
}

function renderCouncil(result) {
  const owner = ownerStatusText(result, 'Council');
  const council = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.councilState, owner.text, owner.state);
    renderList(els.council, [], () => null, 'Unavailable: council sessions could not be read.');
    if (els.councilSynthesis) {
      els.councilSynthesis.replaceChildren();
      els.councilSynthesis.append(el('p', 'meta', 'Unavailable: council synthesis could not be read.'));
    }
    return;
  }
  const sessions = Array.isArray(council.sessions) ? council.sessions : [];
  const total = Number.isInteger(council.total) ? council.total : sessions.length;
  const status = council.status || {};
  const corrupt = Number.isInteger(status.corrupt) ? status.corrupt : 0;
  setWorkspaceStatus(els.councilState, total === 0 ? 'No council sessions are recorded.'
    : 'Showing ' + sessions.length + ' of ' + total + ' recorded council session(s)'
      + (corrupt ? ' · ' + corrupt + ' corrupt record(s)' : '') + '.', corrupt ? 'partial' : (total === 0 ? 'empty' : 'available'));
  renderList(els.council, sessions, (session) => {
    const title = (session.recommendation ? session.recommendation + ' · ' : '') + (session.objective || session.sessionId);
    const meta = 'support ' + (session.support || 'unknown') + ' · ' + (session.at ? String(session.at).slice(0, 19) : 'time not recorded');
    return itemFrom(title, meta);
  }, 'No council sessions are recorded.');
  if (!els.councilSynthesis) return;
  els.councilSynthesis.replaceChildren();
  const latest = council.session;
  if (!latest || !latest.synthesis || !latest.synthesis.synthesis) {
    els.councilSynthesis.append(el('p', 'meta', 'No stored council synthesis is available.'));
    return;
  }
  const synthesis = latest.synthesis.synthesis;
  const verdict = el('p', '', 'Recommended: ' + (synthesis.recommendedOption?.level || 'not recorded')
    + ' · support ' + (synthesis.support ?? 'not recorded') + ' · confidence ' + (synthesis.confidence ?? 'not recorded'));
  const summary = el('p', 'meta', synthesis.explanation || 'No explanation was recorded.');
  const disagreement = el('p', 'meta', 'Disagreement: ' + (latest.disagreement?.kind || 'unknown')
    + ' — ' + (latest.synthesis.disagreementExplanation || latest.disagreement?.detail || 'not recorded'));
  const evidence = el('p', 'meta', 'Supporting ' + (synthesis.supportingEvidence?.length || 0)
    + ' · conflicting ' + (synthesis.conflictingEvidence?.length || 0)
    + ' · approvals listed: ' + (synthesis.requiredApprovals || []).join(', '));
  els.councilSynthesis.append(verdict, summary, disagreement, evidence);
  const list = el('ul', 'work');
  for (const position of (latest.positions || []).slice(0, 7)) {
    list.append(itemFrom(position.perspectiveName || position.perspectiveId,
      (position.position && position.position.verdict) || position.status || 'status not recorded'));
  }
  els.councilSynthesis.append(list);
}

function renderWorkshop(result) {
  const owner = ownerStatusText(result, 'Workshop');
  const page = result?.ok === true ? result.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.workshopState, owner.text, owner.state);
    renderList(els.workshop, [], () => null, 'Unavailable: stored design sheets could not be read.');
    renderWorkshopReport(state.workshopReport ?? null);
    return;
  }
  const artifacts = Array.isArray(page.artifacts) ? page.artifacts : [];
  const total = Number.isInteger(page.total) ? page.total : artifacts.length;
  const health = page.status || {};
  const damaged = (health.chain && health.chain !== 'intact') || (Number.isInteger(health.corrupt) && health.corrupt > 0);
  setWorkspaceStatus(els.workshopState, total === 0 ? 'No design sheets are recorded in WorkshopStore.'
    : 'Showing ' + artifacts.length + ' of ' + total + ' stored design sheet(s).'
      + (health.chain ? ' Store chain: ' + health.chain + '.' : '')
      + (page.authorizesExecution === false ? ' The store does not authorize execution.' : ''), damaged ? 'partial' : (total === 0 ? 'empty' : 'available'));
  const verificationEntries = Array.isArray(page.verificationSummary?.entries) ? page.verificationSummary.entries : [];
  renderList(els.workshop, artifacts, (artifact) => {
    const meta = (artifact.domain || 'domain not recorded') + ' · ' + artifact.components + ' component(s) · '
      + artifact.connections + ' connection(s) · budget '
      + (artifact.budget === null || artifact.budget === undefined ? 'not declared' : artifact.budget);
    const li = itemFrom(artifact.title || artifact.artifactId, meta);
    li.dataset.artifactId = artifact.artifactId;
    // T-33 Step 3: the badge is the ledger's answer. An artifact with no verification record shows
    // 'unverified', which is a fact about the record and not a softer way of saying it passed.
    const record = verificationEntries.find((entry) => entry.artifactId === artifact.artifactId) ?? null;
    const verified = record?.verification?.verified === true;
    li.dataset.verified = verified ? 'true' : 'false';
    li.dataset.promoted = record?.promotion ? 'true' : 'false';
    const badge = el('span', 'badge', verified ? 'verified' : 'unverified');
    badge.dataset.verified = verified ? 'true' : 'false';
    badge.dataset.verification = record?.verification ? record.verification.id : '';
    li.append(badge);
    if (record?.verification) {
      li.append(el('div', 'meta', 'Sandbox verification ' + record.verification.id + ' at ' + record.verification.at
        + (record.verification.failed?.length ? ' · failed: ' + record.verification.failed.join(', ') : ' · every check passed')));
    }
    if (record?.promotion) {
      li.append(el('div', 'meta', 'Promoted ' + record.promotion.at + ' on verification ' + record.promotion.verificationId
        + (record.promotion.reason ? ' — ' + record.promotion.reason : '')));
    }
    const simulate = el('button', 'small', 'Simulate');
    simulate.type = 'button';
    simulate.addEventListener('click', () => { simulateWorkshop(artifact.artifactId); });
    li.append(simulate);
    const verify = el('button', 'small', 'Verify in sandbox');
    verify.type = 'button';
    verify.dataset.action = 'workshop-verify';
    verify.dataset.artifactId = artifact.artifactId;
    verify.addEventListener('click', () => { verifyWorkshop(artifact.artifactId, verify); });
    li.append(verify);
    const promote = el('button', 'small', 'Promote');
    promote.type = 'button';
    promote.dataset.action = 'workshop-promote';
    promote.dataset.artifactId = artifact.artifactId;
    // A promotion is offered only where the ledger already says the artifact verified; the server
    // refuses it otherwise, and the button says why rather than pretending.
    promote.disabled = !verified;
    if (!verified) promote.title = 'A promotion requires a passed sandbox verification for this exact content.';
    promote.addEventListener('click', () => { promoteWorkshop(artifact.artifactId, promote); });
    li.append(promote);
    return li;
  }, 'No design sheets are recorded in WorkshopStore.');
  renderWorkshopReport(state.workshopReport ?? null);
}


// T-33 Step 3 (2026-11-19): the TaskGraph view and its checkpoint controls.
//
// The graph is read from the task log through /api/taskgraph. A node's state and its verified flag
// are the record's, not this function's: the badge says "verified" only when the step's own
// verification outcome is verified. The three controls post to controller routes that already
// existed (/api/tasks/:id/approve|retry|cancel), so this view offers an existing transition and
// never invents one. Lockdown refuses them at the ECP, which is where that decision belongs.
function renderTaskGraph(result) {
  if (!els.dagNodes) return;
  const graph = result?.ok === true ? result.value : null;
  state.taskGraph = graph;
  if (!graph) {
    const reason = result?.error || 'the task graph could not be read';
    setWorkspaceStatus(els.dagStatus, (result?.status >= 500 ? 'Unavailable: ' : 'Read error: ') + reason,
      result?.status >= 500 ? 'unavailable' : 'error');
    renderList(els.dagNodes, [], () => null, 'Unavailable: ' + reason);
    if (els.dagEdges) els.dagEdges.textContent = '';
    for (const button of [els.dagApprove, els.dagResume, els.dagRetry, els.dagCancel]) if (button) button.hidden = true;
    return;
  }
  if (!graph.taskId || (graph.nodes || []).length === 0) {
    setWorkspaceStatus(els.dagStatus, graph.detail || 'No task record exists, so there is no graph to show.', 'empty');
    renderList(els.dagNodes, [], () => null, 'No node is recorded.');
    if (els.dagEdges) els.dagEdges.textContent = '';
    for (const button of [els.dagApprove, els.dagResume, els.dagRetry, els.dagCancel]) if (button) button.hidden = true;
    return;
  }
  // The switch. One option per recorded task, labelled with what the owner needs to choose: the id,
  // the state, and how far the task got. The value is the task id, so choosing is a plain read of that
  // task's own log - nothing runs because a task was selected.
  if (els.dagSelect) {
    const tasks = Array.isArray(graph.tasks) ? graph.tasks : [];
    const previous = els.dagSelect.value;
    els.dagSelect.textContent = '';
    const newest = el('option', null, 'newest unfinished task');
    newest.value = '';
    els.dagSelect.append(newest);
    for (const task of tasks) {
      const option = el('option', null, task.id + ' · ' + task.status + ' · ' + task.completed + '/' + task.steps + ' node(s)'
        + (task.gated > 0 ? ' · ' + task.gated + ' gated' : '')
        + (task.failed > 0 ? ' · ' + task.failed + ' failed' : ''));
      option.value = task.id;
      els.dagSelect.append(option);
    }
    // The graph in hand is the one to select: the requested task when there is one, otherwise the
    // default the server chose. A stale value from a previous read is never left showing another task.
    els.dagSelect.value = tasks.some((task) => task.id === graph.taskId) ? graph.taskId : '';
    if (previous !== els.dagSelect.value) els.dagSelect.dataset.selected = els.dagSelect.value;
  }
  setWorkspaceStatus(els.dagStatus, graph.completed + ' of ' + graph.nodes.length + ' node(s) completed · '
    + graph.gated + ' gated · ' + graph.failed + ' failed · task ' + graph.status
    + (graph.verified ? ' · every node verified' : ' · not every node verified'),
  graph.failed > 0 ? 'partial' : 'available');
  renderList(els.dagNodes, graph.nodes, (node) => {
    const item = itemFrom(node.id + ' — ' + (node.description || node.action || 'no description'),
      node.state + ' · permission ' + (node.permission || 'not recorded') + ' · verified ' + (node.verified ? 'true' : 'false'));
    item.dataset.nodeId = node.id;
    item.dataset.state = node.state;
    item.dataset.verified = node.verified ? 'true' : 'false';
    item.dataset.control = node.control;
    if (node.dependsOn.length > 0) item.append(el('div', 'meta', 'Depends on: ' + node.dependsOn.join(', ')));
    // T-34 Step 1: what holds this node, in words. A gated node is held by the owner's decision; a
    // blocked one names the node it waits for; a ready one says so.
    if (Array.isArray(node.blockedBy) && node.blockedBy.length > 0) {
      const line = el('div', 'meta', 'Blocked by: ' + node.blockedBy.join(', ') + (node.state === 'awaiting_approval' ? ' · also needs your approval' : ''));
      line.dataset.blockedBy = node.blockedBy.join(',');
      item.dataset.blockedBy = node.blockedBy.join(',');
      item.append(line);
    } else if (node.state === 'awaiting_approval') {
      const line = el('div', 'meta', 'Waiting for your approval; nothing has run.');
      item.append(line);
    } else if (node.state === 'pending') {
      item.append(el('div', 'meta', node.dependsOn.length === 0 ? 'Ready to run.' : 'Ready: everything it depends on is complete.'));
    }
    if (node.outcome) item.append(el('div', 'meta', 'Recorded outcome: ' + node.outcome));
    if (node.verificationOutcome) item.append(el('div', 'meta', 'Verification outcome: ' + node.verificationOutcome));
    if (node.approval) item.append(el('div', 'meta', 'Approved by ' + (node.approval.approvedBy || 'not recorded') + ' at ' + (node.approval.at || 'time not recorded')));
    // A verified node says so in the element, and only a verified node may carry the badge.
    if (node.verified === true) {
      const badge = el('span', 'badge dag-verified', 'verified');
      badge.dataset.verified = 'true';
      item.append(badge);
    }
    return item;
  }, 'No node is recorded.');
  if (els.dagEdges) {
    const shape = graph.shape ? 'Shape: ' + graph.shape.nodes + ' node(s), ' + graph.shape.edges + ' edge(s), fan-out '
      + graph.shape.fanOut + ', join ' + (graph.shape.joins.length > 0 ? graph.shape.joins.join(', ') : 'none') + '. ' : '';
    els.dagEdges.textContent = shape + (graph.edges.length === 0
      ? 'No dependency edge is recorded; this task is a single node.'
      : 'Edges: ' + graph.edges.map((edge) => edge.from + ' → ' + edge.to).join(', '));
  }
  const taskId = graph.taskId;
  const gatedNode = graph.nodes.find((node) => node.state === 'awaiting_approval') || null;
  const failedNode = graph.nodes.find((node) => node.state === 'failed') || null;
  if (els.dagApprove) {
    els.dagApprove.hidden = !graph.controls.approve;
    els.dagApprove.dataset.taskId = taskId;
    els.dagApprove.dataset.stepId = gatedNode ? gatedNode.id : '';
  }
  if (els.dagResume) {
    els.dagResume.hidden = !graph.controls.resume;
    els.dagResume.dataset.taskId = taskId;
  }
  if (els.dagRetry) {
    els.dagRetry.hidden = !graph.controls.retry;
    els.dagRetry.dataset.taskId = taskId;
    els.dagRetry.dataset.stepId = failedNode ? failedNode.id : '';
  }
  if (els.dagCancel) {
    els.dagCancel.hidden = !graph.controls.cancel;
    els.dagCancel.dataset.taskId = taskId;
  }
}

// T-34 Step 2: candidate associations, rendered as what they are. Every row carries the epistemic
// status the record gave it, names the source record it came from and shows the terms that matched,
// and the badge says "not observed fact" in as many words. A recall is never drawn as a memory, and a
// recall the record marks as anything but a candidate is not drawn at all.
function renderAssociations(result) {
  if (!els.associations) return;
  const response = result?.ok === true ? result.value : null;
  if (!response) {
    const reason = result?.error || 'the candidate associations could not be read';
    setWorkspaceStatus(els.associationsStatus, (result?.status >= 500 ? 'Unavailable: ' : 'Read error: ') + reason,
      result?.status >= 500 ? 'unavailable' : 'error');
    renderList(els.associations, [], () => null, 'Unavailable: ' + reason);
    return;
  }
  const recalls = (Array.isArray(response.recalls) ? response.recalls : [])
    .filter((recall) => recall.epistemicStatus === 'candidate_association');
  if (recalls.length === 0) {
    setWorkspaceStatus(els.associationsStatus, 'No prior episode has been recalled for a later intent yet. An association appears only when a prior run shares enough terms with a new one.', 'empty');
    renderList(els.associations, [], () => null, 'No candidate association is recorded.');
    return;
  }
  setWorkspaceStatus(els.associationsStatus, recalls.length + ' candidate association(s) recalled from prior runs · none of them is an observation', 'available');
  renderList(els.associations, recalls, (recall) => {
    const item = itemFrom(recall.summary || 'a prior episode, recalled as a candidate',
      'similarity ' + recall.similarity + ' · confidence ' + recall.confidence + ' · prior outcome ' + (recall.sourceOutcome || 'not recorded'));
    item.dataset.associationId = recall.id;
    item.dataset.epistemic = recall.epistemicStatus;
    item.dataset.sourceRecord = recall.sourceRecordId || '';
    item.dataset.runId = recall.runId || '';
    item.dataset.similarity = String(recall.similarity);
    const badge = el('span', 'badge association-candidate', 'candidate association — not observed fact');
    badge.dataset.epistemic = recall.epistemicStatus;
    item.append(badge);
    item.append(el('div', 'meta', 'From ' + (recall.sourceType || 'a record') + ' ' + (recall.sourceRecordId || 'not recorded')
      + (recall.forIntent ? ' · recalled for: ' + recall.forIntent : '')));
    if (recall.basis) item.append(el('div', 'meta', recall.basis));
    return item;
  }, 'No candidate association is recorded.');
}

// T-34 Step 3: the Sentinel's watch rules, from the governor's own admissions. A rule that has never
// fired reports 0 hits and no last-trigger time; a class the ledger recorded but this build does not
// declare is shown as undeclared rather than given a threshold it does not have.
function renderPerceptionWatches(watches) {
  if (!els.perceptionWatches) return;
  const rows = Array.isArray(watches) ? watches : null;
  if (!rows) {
    setWorkspaceStatus(els.perceptionWatchStatus, 'No watch rule is configured.', 'empty');
    renderList(els.perceptionWatches, [], () => null, 'No watch rule is configured.');
    return;
  }
  const fired = rows.filter((row) => row.hits > 0).length;
  setWorkspaceStatus(els.perceptionWatchStatus, rows.length + ' watch rule(s) · ' + fired + ' have fired on this machine'
    + (rows.length - fired > 0 ? ' · ' + (rows.length - fired) + ' have not' : ''), 'available');
  renderList(els.perceptionWatches, rows, (row) => {
    const node = itemFrom(row.alertClass + (row.declared === false ? ' (undeclared)' : ''),
      'watch ' + (row.watch || 'not recorded') + ' · ' + (row.critical ? 'critical' : 'advisory')
      + ' · ' + row.hits + ' hit(s) · last triggered ' + (row.lastTriggeredAt || 'never'));
    node.dataset.watchClass = row.alertClass;
    node.dataset.hits = String(row.hits);
    node.dataset.admitted = String(row.admitted);
    node.dataset.critical = row.critical ? 'true' : 'false';
    node.dataset.lastTriggered = row.lastTriggeredAt || '';
    if (row.signature) node.dataset.signature = row.signature;
    node.dataset.suppressed = row.suppressed ? 'true' : 'false';
    if (row.threshold) node.append(el('div', 'meta', 'Threshold: ' + row.threshold));
    if (row.signature) node.append(el('div', 'meta', 'Last signature: ' + row.signature));
    if (row.lastTriggeredAt) node.append(el('div', 'meta', 'Last fired ' + row.lastTriggeredAt + (row.lastReason ? ' — ' + row.lastReason : '')));
    if (row.suppression) node.append(el('div', 'meta', 'Suppressed until ' + row.suppression.suppressedUntil + ' by rule ' + row.suppression.id));
    return node;
  }, 'No watch rule is configured.');
}

async function postTaskControl(path, body, button, label) {
  if (button) button.disabled = true;
  setWorkspaceStatus(els.dagControlStatus, label + ' is being sent through the controller…', 'loading');
  try {
    const result = await api(path, { method: 'POST', body });
    const verified = result.status === 'success_verified';
    setWorkspaceStatus(els.dagControlStatus, label + ': ' + String(result.status || 'status not returned')
      + (result.display ? ' — ' + String(result.display).slice(0, 240) : ''),
    verified ? 'available' : 'error');
  } catch (error) {
    setWorkspaceStatus(els.dagControlStatus, label + ' failed: ' + String(error?.message || error), 'error');
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

// T-33 Step 3: a design sheet staged from the last host reading. Every number is one the sensor
// reported; when there is no reading the button says so instead of inventing a sheet.
function stageFromTelemetry() {
  const perception = state.perception;
  const reading = perception && perception.lastReading ? perception.lastReading : null;
  if (!reading) {
    setWorkspaceStatus(els.workshopSandboxStatus, 'No host reading is recorded yet. Sense the host in Sentinel first; a sheet is not invented from nothing.', 'empty');
    return null;
  }
  const host = reading.host || {};
  const logical = Number.isFinite(host.cpu?.logicalCount) && host.cpu.logicalCount > 0 ? host.cpu.logicalCount : null;
  const totalMb = Number.isFinite(host.memory?.totalBytes) ? Math.max(1, Math.round(host.memory.totalBytes / 1048576)) : null;
  const storage = Array.isArray(host.storage) ? host.storage.find((volume) => volume.reported === true) : null;
  const availableMb = storage && Number.isFinite(storage.availableBytes) ? Math.max(1, Math.round(storage.availableBytes / 1048576)) : null;
  if (logical === null && totalMb === null && availableMb === null) {
    setWorkspaceStatus(els.workshopSandboxStatus, 'The last reading carried no usable host figures, so no sheet can be staged from it.', 'unavailable');
    return null;
  }
  const components = [];
  if (logical !== null) components.push({ id: 'cpu', label: 'CPU', kind: 'resource', supply: logical, demand: 0, cost: 1 });
  if (totalMb !== null) components.push({ id: 'memory', label: 'Memory', kind: 'resource', supply: totalMb, demand: 0, cost: 1 });
  if (availableMb !== null) components.push({ id: 'storage', label: 'Storage', kind: 'resource', supply: availableMb, demand: 0, cost: 1 });
  components.push({ id: 'workspace_check', label: 'Workspace check', kind: 'service', supply: 0, demand: 1, cost: 1 });
  const connections = components.filter((component) => component.id !== 'workspace_check')
    .map((component) => ({ from: component.id, to: 'workspace_check', label: 'supplies' }));
  return {
    title: 'Host reading ' + (reading.at || 'time not recorded'),
    domain: 'plan',
    components,
    connections,
    budget: { total: components.length * 2 },
    note: 'Staged from the host reading at ' + (reading.at || 'time not recorded') + '; every number is a value the sensor reported.',
  };
}

async function composeFromTelemetry(button) {
  const sheet = stageFromTelemetry();
  if (!sheet) return;
  if (button) button.disabled = true;
  setWorkspaceStatus(els.workshopSandboxStatus, 'Staging the telemetry design through the controller…', 'loading');
  try {
    const result = await api('/api/workshop/compose', { method: 'POST', body: sheet });
    setWorkspaceStatus(els.workshopSandboxStatus, 'Staged ' + result.artifactId + '. It is stored, not verified; run the sandbox check next.', 'available');
  } catch (error) {
    setWorkspaceStatus(els.workshopSandboxStatus, 'Staging failed: ' + String(error?.message || error), 'error');
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

async function verifyWorkshop(artifactId, button) {
  if (button) button.disabled = true;
  setWorkspaceStatus(els.workshopSandboxStatus, 'Running the sandbox verification for ' + artifactId + '…', 'loading');
  try {
    const result = await api('/api/workshop/verify', { method: 'POST', body: { artifactId, reason: 'owner ran the sandbox check from the deck' } });
    setWorkspaceStatus(els.workshopSandboxStatus, artifactId + ': '
      + (result.verified === true ? 'verified — ' + result.passed + ' check(s) passed' : 'not verified — failed: ' + (result.failed || []).join(', ')),
    result.verified === true ? 'available' : 'partial');
  } catch (error) {
    setWorkspaceStatus(els.workshopSandboxStatus, 'Verification failed: ' + String(error?.message || error), 'error');
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

async function promoteWorkshop(artifactId, button) {
  const reason = window.prompt('Why is this design accepted? Your reason is recorded with the promotion.');
  if (reason === null || reason.trim() === '') {
    setWorkspaceStatus(els.workshopSandboxStatus, 'A promotion needs your reason; nothing was recorded.', 'error');
    return;
  }
  if (button) button.disabled = true;
  setWorkspaceStatus(els.workshopSandboxStatus, 'Promoting ' + artifactId + ' through the controller…', 'loading');
  try {
    const result = await api('/api/workshop/promote', { method: 'POST', body: { artifactId, reason: reason.trim() } });
    setWorkspaceStatus(els.workshopSandboxStatus, artifactId + ' promoted on verification ' + result.verificationId
      + (result.memoryId ? '; one memory-timeline entry was written.' : '; the memory-timeline entry could not be written.'), 'available');
  } catch (error) {
    setWorkspaceStatus(els.workshopSandboxStatus, 'Promotion refused: ' + String(error?.message || error), 'error');
  } finally {
    if (button) button.disabled = false;
    await refresh();
  }
}

function renderWorkshopReport(report) {
  if (!els.workshopReport) return;
  els.workshopReport.replaceChildren();
  if (!report) {
    els.workshopReport.append(el('p', 'meta', 'No simulation has been recorded in this page session.'));
    return;
  }
  els.workshopReport.append(el('p', '', 'Simulation of ' + report.artifactId + ': ' + report.status));
  els.workshopReport.append(el('p', 'meta', report.budget === null || report.budget === undefined
    ? 'budget: not declared'
    : 'budget: ' + report.budget.spent + ' of ' + report.budget.total + (report.budget.overBudget ? ' (over)' : '')));
  const list = el('ul', 'work');
  for (const component of (Array.isArray(report.components) ? report.components : [])) {
    list.append(itemFrom(component.id, 'receives ' + component.inbound + ', demands ' + component.demand
      + (component.satisfied ? '' : ' · short') + ' · cost ' + component.cost));
  }
  els.workshopReport.append(list);
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    els.workshopReport.append(el('p', 'meta', 'Warnings: ' + report.warnings.join('; ')));
  }
  els.workshopReport.append(el('p', 'meta', 'Arithmetic over the declared numbers. Nothing was executed and nothing was authorized.'));
}

async function simulateWorkshop(artifactId) {
  if (els.workshopStatus) els.workshopStatus.textContent = 'simulating…';
  try {
    const report = await api('/api/workshop/simulate', { method: 'POST', body: { artifactId } });
    state.workshopReport = report;
    renderWorkshopReport(report);
    if (els.workshopStatus) els.workshopStatus.textContent = 'simulated: ' + report.status;
  } catch (error) {
    if (els.workshopStatus) els.workshopStatus.textContent = error.message;
  }
}

// T-35 Step 3: the doctor in the System workspace.
//
// The report is rendered exactly as the route returned it: a not_configured check is not shown as a
// pass, a degraded check is not hidden behind a green total, and the duration is shown so the budget
// claim is visible rather than asserted.
function renderDoctor(report) {
  if (!els.doctorChecks) return;
  if (!report || !Array.isArray(report.checks)) {
    setWorkspaceStatus(els.doctorStatus, 'Unavailable: the doctor returned no report.', 'unavailable');
    renderList(els.doctorChecks, [], () => null, 'Unavailable: the doctor returned no report.');
    return;
  }
  setWorkspaceStatus(els.doctorStatus, report.status.toUpperCase() + ' · ' + report.counts.pass + ' pass, '
    + report.counts.degraded + ' degraded, ' + report.counts.failed + ' failed, '
    + report.counts.notConfigured + ' not configured · ' + report.durationMs + ' ms of a '
    + report.budgetMs + ' ms budget' + (report.withinBudget === true ? '' : ' (OVER BUDGET)'),
  report.status === 'ok' ? 'available' : report.status === 'failed' ? 'error' : 'degraded');
  renderList(els.doctorChecks, report.checks, (entry) => {
    const li = itemFrom(entry.name + ' · ' + entry.state, entry.summary);
    li.dataset.check = entry.name;
    li.dataset.checkState = entry.state;
    return li;
  }, 'The doctor reported no checks.');
}

async function runDoctor() {
  // A re-run keeps the last report on screen while it reads. Replacing a measured line with
  // "Running..." would hide a real measurement behind a status message - and the hosted walk caught
  // exactly that: opening System and then pressing Run again left the panel claiming it was running
  // while the six checks from the first reading were already listed underneath.
  if (els.doctorStatus && state.doctorRan !== true) {
    setWorkspaceStatus(els.doctorStatus, 'Running the six read-only checks…', 'loading');
  }
  try {
    const report = await api('/api/system/doctor');
    state.doctorRan = true;
    renderDoctor(report);
  } catch (error) {
    state.doctorRan = true;
    setWorkspaceStatus(els.doctorStatus, 'Unavailable: ' + String(error?.message || error), 'error');
  }
}

// T-35 Step 2: the handoff ledger in the Presence workspace.
//
// The form asks, the ledger answers. Nothing here marks an envelope staged, claimed or revoked until
// the route has come back with the record the service wrote, and a handoff the owner can no longer
// collect is shown with the reason it cannot rather than a dead button.
function fillHandoffDevices() {
  const devices = Array.isArray(state.handoffDevices) ? state.handoffDevices : [];
  const trusted = devices.filter((device) => device.status === 'trusted');
  for (const select of [els.handoffSource, els.handoffTarget]) {
    if (!select) continue;
    const previous = select.value;
    select.replaceChildren();
    for (const device of trusted) {
      const option = el('option', null, (device.label || device.deviceId) + ' · ' + device.deviceId.slice(0, 8));
      option.value = device.deviceId;
      select.append(option);
    }
    if (trusted.length === 0) {
      const option = el('option', null, 'no trusted device is enrolled');
      option.value = '';
      select.append(option);
    } else if (trusted.some((device) => device.deviceId === previous)) {
      select.value = previous;
    }
  }
  // The two sides default to different devices, because a handoff to the same device is refused.
  if (els.handoffSource && els.handoffTarget && trusted.length > 1 && els.handoffSource.value === els.handoffTarget.value) {
    els.handoffTarget.value = trusted.find((device) => device.deviceId !== els.handoffSource.value).deviceId;
  }
  if (els.handoffStage) els.handoffStage.disabled = trusted.length < 2;
}

function renderHandoffs(value) {
  if (!els.handoffList) return;
  if (value === null) {
    setWorkspaceStatus(els.handoffStatus, 'Unavailable: the presence reading could not be taken, so the handoff ledger was not read.', 'unavailable');
    renderList(els.handoffList, [], () => null, 'Unavailable: the handoff ledger could not be read.');
    return;
  }
  state.handoffDevices = Array.isArray(value.deviceTrust?.devices) ? value.deviceTrust.devices : [];
  const handoffs = value.handoffs;
  if (!handoffs || handoffs.available === false) {
    setWorkspaceStatus(els.handoffStatus, 'The handoff ledger is not configured in this deployment; staging is unavailable.', 'unavailable');
    renderList(els.handoffList, [], () => null, 'Unavailable: the handoff ledger is not configured.');
    fillHandoffDevices();
    return;
  }
  fillHandoffDevices();
  setWorkspaceStatus(els.handoffStatus, handoffs.total + ' envelope(s): ' + handoffs.staged + ' staged, '
    + handoffs.claimed + ' claimed, ' + handoffs.revoked + ' revoked'
    + (handoffs.expired ? ', ' + handoffs.expired + ' expired' : '')
    + ' · ' + (handoffs.remoteTransport === true ? 'remote transport implemented'
      : 'local, store-backed only — no remote transport'), 'available');
  const recent = Array.isArray(handoffs.recent) ? handoffs.recent : [];
  renderList(els.handoffList, recent, (handoff) => {
    const li = itemFrom(handoff.targetView + ' → ' + handoff.targetDeviceId.slice(0, 8),
      (handoff.status || 'status not recorded') + ' · digest ' + String(handoff.sha256Digest || '').slice(0, 12)
      + ' · staged ' + (handoff.stagedAt || 'time not recorded') + ' · expires ' + (handoff.expiresAt || 'not recorded'));
    li.dataset.handoffId = handoff.id;
    li.dataset.handoffStatus = handoff.status;
    if (handoff.taskId) li.append(el('div', 'meta', 'Mission: ' + handoff.taskId));
    if (handoff.artifactId) li.append(el('div', 'meta', 'Artifact: ' + handoff.artifactId));
    if (handoff.briefingCheckpointId) li.append(el('div', 'meta', 'Briefing checkpoint: ' + handoff.briefingCheckpointId));
    if (handoff.note) li.append(el('div', 'meta', 'Note: ' + handoff.note));
    if (handoff.revokeReason) li.append(el('div', 'meta', 'Revoked: ' + handoff.revokeReason));
    if (handoff.status === 'staged' || handoff.status === 'claimed') {
      const actions = el('div', 'meta');
      if (handoff.status === 'staged') {
        const claim = el('button', 'small', 'Claim & Restore');
        claim.type = 'button';
        claim.addEventListener('click', () => claimHandoff(handoff, claim));
        actions.append(claim);
        const revoke = el('button', 'quiet small', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', () => revokeHandoff(handoff, revoke));
        actions.append(revoke);
      } else {
        const restore = el('button', 'quiet small', 'Restore again');
        restore.type = 'button';
        restore.addEventListener('click', () => restoreFromHandoff(handoff.restoration));
        actions.append(restore);
      }
      li.append(actions);
    }
    return li;
  }, 'No handoff envelope has been staged.');
}

function restoreFromHandoff(restoration) {
  if (!restoration || typeof restoration.view !== 'string') {
    if (els.handoffMessage) els.handoffMessage.textContent = 'The envelope names no view to restore.';
    return false;
  }
  setView(restoration.view);
  if (restoration.taskId && els.dagSelect) {
    els.dagSelect.value = restoration.taskId;
    loadSelectedTaskGraph(restoration.taskId);
  }
  if (els.handoffMessage) {
    els.handoffMessage.textContent = 'Restored ' + restoration.view
      + (restoration.taskId ? ' on mission ' + restoration.taskId : '')
      + (restoration.artifactId ? ' with artifact ' + restoration.artifactId : '')
      + '. Nothing was executed by opening it.';
  }
  return true;
}

async function stageHandoff() {
  const sourceDeviceId = els.handoffSource ? els.handoffSource.value : '';
  const targetDeviceId = els.handoffTarget ? els.handoffTarget.value : '';
  if (!sourceDeviceId || !targetDeviceId) {
    if (els.handoffMessage) els.handoffMessage.textContent = 'Two enrolled, trusted devices are needed to stage a handoff.';
    return null;
  }
  const body = {
    sourceDeviceId,
    targetDeviceId,
    targetView: els.handoffView ? els.handoffView.value : 'deck',
  };
  const taskId = els.handoffTask ? els.handoffTask.value.trim() : '';
  const note = els.handoffNote ? els.handoffNote.value.trim() : '';
  if (taskId) body.taskId = taskId;
  if (note) body.note = note;
  if (els.handoffMessage) els.handoffMessage.textContent = 'Asking the ECP to stage the envelope…';
  try {
    const response = await api('/api/presence/handoffs', { method: 'POST', body });
    if (els.handoffMessage) {
      els.handoffMessage.textContent = 'Staged ' + response.handoff.id + ' for ' + response.handoff.targetView
        + ' (digest ' + String(response.handoff.sha256Digest).slice(0, 12) + ', expires ' + response.handoff.expiresAt + ').';
    }
    if (els.handoffTask) els.handoffTask.value = '';
    if (els.handoffNote) els.handoffNote.value = '';
    await refresh();
    return response.handoff;
  } catch (error) {
    if (els.handoffMessage) els.handoffMessage.textContent = 'Refused: ' + String(error?.message || error);
    return null;
  }
}

async function claimHandoff(handoff, button) {
  if (button) button.disabled = true;
  if (els.handoffMessage) els.handoffMessage.textContent = 'Claiming ' + handoff.id + '…';
  try {
    const response = await api('/api/presence/handoffs/' + encodeURIComponent(handoff.id) + '/claim',
      { method: 'POST', body: { targetDeviceId: handoff.targetDeviceId } });
    restoreFromHandoff(response.restoration);
    await refresh();
    return response.handoff;
  } catch (error) {
    if (els.handoffMessage) els.handoffMessage.textContent = 'Claim refused: ' + String(error?.message || error);
    if (button) button.disabled = false;
    return null;
  }
}

async function revokeHandoff(handoff, button) {
  const reason = typeof window.prompt === 'function' ? window.prompt('Why is this handoff being revoked?') : null;
  if (reason === null) return null;
  if (button) button.disabled = true;
  if (els.handoffMessage) els.handoffMessage.textContent = 'Revoking ' + handoff.id + '…';
  try {
    const response = await api('/api/presence/handoffs/' + encodeURIComponent(handoff.id) + '/revoke',
      { method: 'POST', body: { reason } });
    if (els.handoffMessage) els.handoffMessage.textContent = 'Revoked ' + response.handoff.id + ': ' + (response.handoff.revokeReason || 'reason not reported');
    await refresh();
    return response.handoff;
  } catch (error) {
    if (els.handoffMessage) els.handoffMessage.textContent = 'Revocation refused: ' + String(error?.message || error);
    if (button) button.disabled = false;
    return null;
  }
}

// ---- T-31 Step 2 surfaces -------------------------------------------------------
// Presence, the read-only autonomy matrix, the epistemic world model, and the Evolution Lab. Each
// renderer reports what the owner returned: an owner that could not be read says unavailable, an
// owner that returned nothing is honestly empty, and no value is ever defaulted to a clean reading.

function renderPresence(presenceResult, matrixResult) {
  const owner = ownerStatusText(presenceResult, 'Presence');
  const value = presenceResult?.ok === true ? presenceResult.value : null;
  if (owner.text) {
    setWorkspaceStatus(els.presenceStatus, owner.text, owner.state);
    renderList(els.presenceDevices, [], () => null, 'Unavailable: device trust could not be read.');
    renderList(els.presenceMesh, [], () => null, 'Unavailable: mesh state could not be read.');
    renderHandoffs(null);
  } else {
    const trust = value.deviceTrust || { available: false, detail: 'device trust is not configured' };
    const devices = Array.isArray(trust.devices) ? trust.devices : [];
    if (trust.available !== true) {
      setWorkspaceStatus(els.presenceStatus, 'Device trust is not configured in this deployment; no device is enrolled.', 'unavailable');
      renderList(els.presenceDevices, [], () => null, 'Unavailable: device trust is not configured.');
    } else if (devices.length === 0) {
      const status = trust.status || {};
      setWorkspaceStatus(els.presenceStatus, 'No device is enrolled. '
        + (status.persistence ? 'The registry is ' + status.persistence + '.' : 'The registry state was not reported.'), 'empty');
      renderList(els.presenceDevices, [], () => null, 'No device is enrolled, so no device is trusted.');
    } else {
      const trusted = devices.filter((device) => device.status === 'trusted').length;
      setWorkspaceStatus(els.presenceStatus, devices.length + ' enrolled device(s): ' + trusted + ' trusted, '
        + (devices.length - trusted) + ' revoked. A trusted device authenticates messages and grants no capability.', 'available');
      renderList(els.presenceDevices, devices, (device) => {
        const li = itemFrom(device.label || device.deviceId, (device.status || 'status not recorded')
          + ' · enrolled ' + (device.enrolledAt || 'time not recorded')
          + (device.lastAcceptedSequence !== null && device.lastAcceptedSequence !== undefined
            ? ' · last accepted sequence ' + device.lastAcceptedSequence : ' · no sequence accepted yet'));
        if (device.revokedAt) li.append(el('div', 'meta', 'Revoked ' + device.revokedAt
          + (device.revocationReason ? ' — ' + device.revocationReason : '')));
        return li;
      }, 'No device is enrolled, so no device is trusted.');
    }
    const mesh = value.mesh || {};
    const peers = Array.isArray(mesh.peers) ? mesh.peers : [];
    renderHandoffs(value);
    const meshItems = [itemFrom('Transport', mesh.implemented === true
      ? 'connected with ' + (mesh.connectedPeers ?? peers.length) + ' peer(s)'
      : (mesh.detail || 'no device mesh transport is implemented'))];
    if (peers.length === 0) meshItems.push(itemFrom('Peers', 'none — presence is the local owner session only'));
    renderList(els.presenceMesh, [...meshItems, ...peers.map((peer) => itemFrom(peer.label || peer.deviceId || 'peer', 'connected'))],
      (item) => null, 'No mesh peer is connected.');
  }

  const matrixOwner = ownerStatusText(matrixResult, 'Autonomy matrix');
  const matrix = matrixResult?.ok === true ? matrixResult.value : null;
  if (matrixOwner.text) {
    setWorkspaceStatus(els.autonomyStatus, matrixOwner.text, matrixOwner.state);
    if (els.autonomyMatrix) els.autonomyMatrix.replaceChildren();
    renderList(els.autonomyCapabilities, [], () => null, 'Unavailable: the autonomy matrix could not be read.');
    return;
  }
  const domains = Array.isArray(matrix.domains) ? matrix.domains : [];
  const levels = Array.isArray(matrix.levels) ? matrix.levels : [];
  const levelName = (level) => {
    const found = levels.find((entry) => entry.level === level);
    return found ? 'L' + found.level + ' ' + found.name : (level === null || level === undefined ? 'not reported' : 'L' + level);
  };
  setWorkspaceStatus(els.autonomyStatus, matrix.readonly === true
    ? 'Read-only: ' + matrix.source + ' sets these levels at start-up and the UI cannot change them'
      + (matrix.restartRequired === true ? ' (a change requires a restart).' : '.')
    : 'The ECP did not report this matrix as read-only; treat the levels below as unconfirmed.', matrix.readonly === true ? 'available' : 'partial');
  if (els.autonomyMatrix) {
    els.autonomyMatrix.replaceChildren();
    for (const domain of domains) {
      const row = document.createElement('tr');
      row.append(el('td', '', domain.domain));
      row.append(el('td', '', domain.configuredLevel === null ? 'default (L2 write / L0 read)' : levelName(domain.configuredLevel)));
      row.append(el('td', '', String(domain.capabilities)));
      row.append(el('td', '', domain.configuredLevel === null ? 'registry default' : 'APEX_AUTONOMY_LEVELS'));
      els.autonomyMatrix.append(row);
    }
  }
  if (domains.length === 0) {
    renderList(els.autonomyCapabilities, [], () => null, 'The registry reported no capabilities, so no level is shown.');
  } else {
    const rows = Array.isArray(matrix.capabilities) ? matrix.capabilities : [];
    renderList(els.autonomyCapabilities, rows, (row) => itemFrom(row.name, (row.permission || 'permission not recorded')
      + ' · ' + (row.levelName ? 'L' + row.level + ' ' + row.levelName : 'level not reported')
      + ' · domain ' + row.domain + (row.configured ? ' (configured)' : ' (default)')
      + (row.plannable ? '' : ' · not plannable')), 'The registry reported no capabilities.');
  }
}

function renderWorldClaims(worldResult) {
  if (!els.worldClaims) return;
  const value = worldResult?.ok === true ? worldResult.value : null;
  if (!value) {
    if (els.worldLabels) els.worldLabels.textContent = 'Unavailable: the epistemic projection could not be read.';
    renderList(els.worldClaims, [], () => null, 'Unavailable: the epistemic projection could not be read.');
    return;
  }
  const labels = value.labels || {};
  const beliefs = value.beliefs || {};
  const counts = value.counts || {};
  const rows = [];
  const labelOf = (belief) => {
    const epistemic = String(belief.epistemic || '');
    if (epistemic === 'observed') return 'observed';
    if (epistemic === 'predicted') return 'predicted';
    if (epistemic === 'assumed') return 'assumed';
    if (epistemic === 'inferred') return 'inferred';
    if (epistemic === 'user_asserted') return labels.user_asserted || 'stated by you — not independently observed';
    if (epistemic === 'unverified_model') return labels.unverified_model || 'inferred by a model — unverified';
    // An unclassified record is never promoted to 'observed'.
    return 'unclassified (never shown as observed)';
  };
  for (const belief of Array.isArray(beliefs.userAsserted) ? beliefs.userAsserted : []) {
    rows.push({ belief, label: labelOf(belief) });
  }
  for (const belief of Array.isArray(beliefs.unverifiedModel) ? beliefs.unverifiedModel : []) {
    rows.push({ belief, label: labelOf(belief) });
  }
  if (els.worldLabels) {
    els.worldLabels.textContent = (value.complete === false ? 'Partial projection: one or more stores could not be read completely. ' : '')
      + (beliefs.total ?? rows.length) + ' belief(s) recorded: '
      + (counts.userAsserted ?? 0) + ' stated by you, ' + (counts.unverifiedModel ?? 0) + ' inferred by a model. '
      + (value.attention === true ? 'This projection needs attention.' : '');
  }
  renderList(els.worldClaims, rows, ({ belief, label }) => {
    const subject = belief.subject || belief.surface || belief.id || 'subject not recorded';
    const li = itemFrom(belief.text || belief.claim || belief.summary || subject,
      '[' + label + '] · ' + (belief.source || belief.store || 'store not recorded')
      + (belief.recordedAt ? ' · ' + belief.recordedAt : ''));
    if (belief.provenance && typeof belief.provenance === 'object') {
      const parts = Object.entries(belief.provenance)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => k + ': ' + String(v));
      if (parts.length) li.append(el('div', 'meta', 'Provenance: ' + parts.join(' · ')));
    }
    return li;
  }, 'No belief is recorded, so there is nothing to label.');
}

const EVOLUTION_LABEL = {
  not_requested: 'no promotion requested',
  requested: 'promotion requested — awaiting your decision',
  approved: 'promotion approved by you',
  rejected: 'promotion rejected by you',
};

// T-32 Step 3: the perception surfaces. The reading is shown with its own timestamp and its own
// epistemic status, the push budget is the Sentinel's, and a suppression is listed with the rule id
// the owner needs in order to revoke it. Nothing here is estimated.
// T-33 Step 1 (2026-11-19): the Sentinel's advisories and the discipline that carries them.
//
// An advisory is a condition the reading implied. Whether it was *delivered* is the governor's
// decision, and the record here is the governor's own answer - admitted, deduplicated, capped or
// suppressed - so the owner can see the rule doing its work instead of wondering why a notice did
// not arrive. Dismissing twice records a revocable rule with an expiry; revoking restores delivery.
function renderPerceptionAlerts(value) {
  if (!els.perceptionAlerts) return;
  const alerts = value && value.alerts && typeof value.alerts === 'object' ? value.alerts : null;
  const advisories = Array.isArray(alerts?.advisories) ? alerts.advisories : [];
  const deliveries = Array.isArray(alerts?.deliveries) ? alerts.deliveries : [];
  const suppressions = Array.isArray(alerts?.suppressions) ? alerts.suppressions : [];
  const policy = alerts && alerts.policy ? alerts.policy : null;
  if (els.perceptionAlertPolicy) {
    els.perceptionAlertPolicy.textContent = policy
      ? 'Push policy: at most ' + policy.limitPerHour + ' non-critical notices an hour; '
        + policy.dismissalsToSuppress + ' dismissals of one alert class suppress it for '
        + Math.round((policy.suppressionTtlMs || 0) / 3600000) + ' hours; a safety, lockdown or degraded '
        + 'notice bypasses the cap.'
      : 'Push policy: unavailable until the perception service answers.';
  }
  if (els.perceptionAlertStatus) {
    const delivered = deliveries.filter((entry) => entry.admitted === true).length;
    setWorkspaceStatus(els.perceptionAlertStatus, advisories.length === 0
      ? 'No advisory is implied by the last reading.'
      : advisories.length + ' advisory/advisories implied by the last reading · ' + delivered
        + ' delivered · ' + suppressions.length + ' class(es) suppressed', advisories.length === 0 ? 'empty' : 'available');
  }
  const rows = advisories.map((entry) => {
    const rule = suppressions.find((candidate) => candidate.alertClass === entry.alertClass) || null;
    const delivery = deliveries.find((candidate) => candidate.alertClass === entry.alertClass) || null;
    const state = rule ? 'suppressed' : (delivery && delivery.admitted === true ? 'delivered' : 'held');
    return { entry, rule, delivery, state };
  });
  renderList(els.perceptionAlerts, rows, (row) => {
    const item = itemFrom('Advisory · ' + row.entry.alertClass + (row.entry.critical === true ? ' · critical' : ''),
      row.entry.severity + ' · ' + row.entry.watch + ' · ' + row.entry.summary);
    item.dataset.alertClass = row.entry.alertClass;
    item.dataset.delivery = row.state;
    item.dataset.alertSignature = row.entry.signature;
    item.append(el('div', 'meta', row.state === 'suppressed'
      ? 'Delivery: suppressed by rule ' + row.rule.id + ' until ' + row.rule.suppressedUntil + ' (revocable above)'
      : row.state === 'delivered'
        ? 'Delivery: delivered at ' + (row.delivery.at || 'time not recorded') + ' · push ' + (row.delivery.pushId || 'not recorded')
        : 'Delivery: not delivered — ' + String(row.delivery ? row.delivery.reason : 'the governor has not been asked yet')));
    item.append(el('div', 'meta', 'Signature: ' + row.entry.signature + ' · basis: ' + row.entry.basis));
    if (row.state !== 'suppressed') {
      const button = el('button', 'small', 'Dismiss notice');
      button.type = 'button';
      button.dataset.action = 'dismiss-alert';
      button.dataset.alertClass = row.entry.alertClass;
      button.addEventListener('click', async () => {
        button.disabled = true;
        if (els.perceptionAlertStatus) setWorkspaceStatus(els.perceptionAlertStatus, 'Dismissing ' + row.entry.alertClass + '…', 'loading');
        try {
          const result = await api('/api/perception/dismiss', { method: 'POST', body: { alertClass: row.entry.alertClass } });
          const dismissal = result.dismissals === undefined ? null : result.dismissals;
          const message = 'Dismissed ' + row.entry.alertClass + ' ('
            + (dismissal === null ? 'dismissal count not reported' : dismissal + ' of 2)')
            + (result.suppressed === true && result.rule ? '; suppressed until ' + result.rule.suppressedUntil : '');
          if (els.perceptionAlertStatus) setWorkspaceStatus(els.perceptionAlertStatus, message, 'available');
        } catch (error) {
          if (els.perceptionAlertStatus) setWorkspaceStatus(els.perceptionAlertStatus, 'Dismissal failed: ' + String(error?.message || error), 'error');
        } finally {
          button.disabled = false;
          refresh();
        }
      });
      item.append(button);
    }
    return item;
  }, 'No advisory is implied by the last reading.');
}

function renderPerception(result) {
  const owner = ownerStatusText(result, 'Perception');
  const value = result?.ok === true ? result.value : null;
  const budget = value?.governor?.budget ?? null;
  const suppressions = Array.isArray(value?.governor?.suppressions) ? value.governor.suppressions : [];
  const observations = Array.isArray(value?.observations) ? value.observations : [];
  if (els.perceptionBudget) {
    els.perceptionBudget.textContent = budget
      ? 'Push budget: ' + budget.remaining + '/' + budget.limit + ' non-critical left this hour'
      : 'Push budget: unavailable';
    // The numbers the badge states are also on the element, so a browser run asserts the record rather
    // than parsing the owner's prose.
    if (budget) {
      els.perceptionBudget.dataset.remaining = String(budget.remaining);
      els.perceptionBudget.dataset.limit = String(budget.limit);
      els.perceptionBudget.dataset.used = String(budget.used);
    }
  }
  if (owner.text) {
    // T-34 Step 3: an unreadable perception owner is stated once, for every list it fills - the new
    // watch rules included. Reading value.watches before this check threw on an unavailable read,
    // which took the whole client down with it; the guard belongs here, not inside the renderer.
    renderPerceptionAlerts(null);
    setWorkspaceStatus(els.perceptionStatus, owner.text, owner.state);
    if (els.perceptionDetailStatus) setWorkspaceStatus(els.perceptionDetailStatus, owner.text, owner.state);
    renderList(els.perceptionSummary, [], () => null, owner.text);
    if (els.perceptionObservations) renderList(els.perceptionObservations, [], () => null, owner.text);
    if (els.perceptionSuppressions) renderList(els.perceptionSuppressions, [], () => null, owner.text);
    if (els.perceptionWatches) {
      setWorkspaceStatus(els.perceptionWatchStatus, owner.text, owner.state);
      renderList(els.perceptionWatches, [], () => null, owner.text);
    }
    if (els.briefingPerception) els.briefingPerception.textContent = 'Perception unavailable: ' + owner.text;
    return;
  }
  renderPerceptionWatches(value.watches);
  renderPerceptionAlerts(value);
  const host = value.lastReading?.host ?? null;
  const workspace = value.lastReading?.workspace ?? null;
  const summary = [];
  if (host) {
    summary.push({ title: 'CPU: ' + (host.cpu?.logicalCount ?? 'unavailable') + ' logical · load 1m '
      + (host.cpu?.loadAverage1m ?? 'unavailable'), meta: 'Observed · host.cpu · at ' + (value.lastObservationAt || 'time not recorded') });
    summary.push({ title: 'Memory: ' + (host.memory?.usedPercent === null || host.memory?.usedPercent === undefined
      ? 'unavailable' : Math.round(host.memory.usedPercent * 100) + '% used'), meta: 'Observed · host.memory' });
    summary.push({ title: 'Process: up ' + (host.process?.uptimeSeconds ?? 'unavailable') + 's', meta: 'Observed · host.process' });
  }
  if (workspace) {
    summary.push({
      title: workspace.available
        ? 'Workspace: ' + (workspace.branch || 'detached') + ' at ' + (workspace.head || 'unavailable')
        : 'Workspace: unavailable (' + (workspace.reason || 'no reading') + ')',
      meta: workspace.available
        ? (workspace.dirtyFiles ?? 'unavailable') + ' changed · ' + (workspace.untrackedFiles ?? 'unavailable') + ' untracked'
        : 'A missing reading is not a clean tree.',
    });
  }
  if (summary.length === 0) {
    setWorkspaceStatus(els.perceptionStatus, 'No host reading has been recorded yet; use "Sense host now" in Sentinel.', 'empty');
  } else {
    setWorkspaceStatus(els.perceptionStatus, 'Last reading ' + (value.lastObservationAt || 'time not recorded')
      + ' · ' + (value.observedCount ?? 0) + ' observed · ' + (value.unavailableCount ?? 0) + ' unavailable', 'available');
  }
  renderList(els.perceptionSummary, summary, (row) => itemFrom(row.title, row.meta), 'No host reading recorded yet.');
  if (els.perceptionDetailStatus) {
    setWorkspaceStatus(els.perceptionDetailStatus, 'Ledger ' + (value.source || 'host-workspace-sensor') + ' · last observation '
      + (value.lastObservationAt || 'none recorded') + ' · ' + observations.length + ' shown', 'available');
  }
  if (els.perceptionObservations) {
    renderList(els.perceptionObservations, observations.slice(0, 20).map((entry) => ({
      title: entry.subject + ' = ' + (entry.value === null ? 'unavailable' : String(entry.value)) + (entry.unit ? ' ' + entry.unit : ''),
      meta: entry.epistemicStatus + ' · ' + entry.source + ' · ' + entry.at + (entry.detail && typeof entry.detail === 'string' ? ' · ' + entry.detail : ''),
    })), (row) => itemFrom(row.title, row.meta), 'No observation has been recorded in the perception ledger.');
  }
  if (els.perceptionSuppressions) {
    const rows = suppressions.map((rule) => ({
      title: 'Suppressed: ' + rule.alertClass + ' until ' + rule.suppressedUntil,
      meta: 'Rule ' + rule.id + ' · recorded from ' + rule.dismissals + ' dismissals · revocable · delivery resumes when revoked',
      rule,
    }));
    renderList(els.perceptionSuppressions, rows, (row) => {
      const node = itemFrom(row.title, row.meta);
      const rule = row.rule;
      if (rule) {
        // T-33 Step 1: the rule names its class and its expiry in the DOM, so the browser run can
        // assert the exact rule the governor recorded instead of reading the owner's prose.
        node.dataset.ruleId = rule.id;
        node.dataset.alertClass = rule.alertClass;
        node.dataset.suppressedUntil = rule.suppressedUntil;
        node.dataset.dismissals = String(rule.dismissals);
        const button = el('button', 'small', 'Revoke suppression');
        button.type = 'button';
        button.dataset.action = 'revoke-suppression';
        button.dataset.ruleId = rule.id;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api('/api/perception/suppressions/revoke', { method: 'POST', body: { ruleId: rule.id } });
            if (els.perceptionSenseStatus) els.perceptionSenseStatus.textContent = 'Suppression ' + rule.id + ' revoked; delivery for ' + rule.alertClass + ' resumes.';
            if (els.perceptionAlertStatus) setWorkspaceStatus(els.perceptionAlertStatus, 'Suppression ' + rule.id + ' revoked; the next reading of ' + rule.alertClass + ' is delivered again.', 'available');
          } catch (error) {
            if (els.perceptionSenseStatus) els.perceptionSenseStatus.textContent = 'Revoke failed: ' + String(error?.message || error);
          } finally {
            button.disabled = false;
            refresh();
          }
        });
        node.append(button);
      }
      return node;
    }, 'No alert class is suppressed. Two dismissals of one class record a rule with an expiry.');
  }
  if (els.briefingPerception) {
    els.briefingPerception.textContent = 'Perception: ' + (value.lastObservationAt || 'no reading recorded')
      + ' · ' + (value.observedCount ?? 0) + ' observed · push budget ' + (budget ? budget.remaining + '/' + budget.limit : 'unavailable')
      + (suppressions.length ? ' · suppressed: ' + suppressions.map((rule) => rule.alertClass + ' until ' + rule.suppressedUntil).join(', ') : '');
  }
}

function renderEvolution(result) {
  if (!els.evolutionProposals) return;
  const value = result?.ok === true ? result.value : null;
  if (!value) {
    if (els.evolutionStatus) setWorkspaceStatus(els.evolutionStatus, 'Unavailable: the evolution ledger could not be read.', 'unavailable');
    renderList(els.evolutionProposals, [], () => null, 'Unavailable: the evolution ledger could not be read.');
    renderList(els.evolutionBoundaries, [], () => null, 'Unavailable: the safety boundaries could not be read.');
    return;
  }
  const proposals = Array.isArray(value.proposals) ? value.proposals : [];
  const status = value.status || {};
  if (els.evolutionStatus) {
    setWorkspaceStatus(els.evolutionStatus, proposals.length === 0
      ? 'No evolution proposal is recorded. Nothing has been proposed, verified or promoted.'
      : proposals.length + ' proposal(s): ' + (status.verified ?? 0) + ' with a passing sandbox result, '
        + (status.failed ?? 0) + ' with a failed result, ' + (status.awaitingVerification ?? 0) + ' unverified, '
        + (status.promotionRequested ?? 0) + ' awaiting your decision, ' + (status.promoted ?? 0) + ' promoted.'
        + (status.corrupt && status.corrupt.length ? ' ' + status.corrupt.length + ' damaged ledger line(s) were skipped.' : ''),
      proposals.length === 0 ? 'empty' : (Array.isArray(status.corrupt) && status.corrupt.length ? 'partial' : 'available'));
  }
  renderList(els.evolutionProposals, proposals, (proposal) => {
    const sandbox = proposal.sandbox || {};
    const sandboxText = sandbox.verified === true ? 'sandbox: verified · ' + (sandbox.detail || 'no detail recorded')
      : sandbox.verified === false ? 'sandbox: failed · ' + (sandbox.detail || 'no detail recorded')
        : 'sandbox: no verification recorded';
    const li = itemFrom(proposal.title || proposal.proposalId, proposal.proposalId + ' · ' + sandboxText);
    if (proposal.hypothesis) li.append(el('div', 'meta', 'Hypothesis: ' + proposal.hypothesis));
    const promotion = proposal.promotion || {};
    li.append(el('div', 'meta', 'Promotion: ' + (EVOLUTION_LABEL[promotion.state] || promotion.state || 'not recorded')
      + (promotion.reason ? ' — ' + promotion.reason : '')
      + (promotion.decisionReason ? ' · decision: ' + promotion.decisionReason : '')));
    if (proposal.promotionBlocked) li.append(el('div', 'meta', 'Blocked: ' + proposal.promotionBlocked));
    else if (promotion.state === 'not_requested' || promotion.state === 'rejected') {
      const request = el('button', 'small', 'Request promotion');
      request.type = 'button';
      request.addEventListener('click', () => requestPromotion(proposal.proposalId, request));
      li.append(request);
    }
    if (promotion.state === 'requested') {
      const approve = el('button', 'small', 'Approve promotion');
      approve.type = 'button';
      approve.addEventListener('click', () => decidePromotion(proposal.proposalId, 'approved', approve));
      const reject = el('button', 'small', 'Reject promotion');
      reject.type = 'button';
      reject.addEventListener('click', () => decidePromotion(proposal.proposalId, 'rejected', reject));
      li.append(approve, reject);
    }
    return li;
  }, 'No evolution proposal is recorded.');
  const boundaries = value.boundaries || {};
  const entries = Array.isArray(boundaries.entries) ? boundaries.entries : [];
  if (els.evolutionBoundariesStatus) {
    els.evolutionBoundariesStatus.textContent = entries.length === 0
      ? 'The safety boundaries were not reported by this build.'
      : (boundaries.allLocked === true
        ? 'All ' + entries.length + ' boundaries were confirmed by a read of the running system.'
        : 'One or more boundaries could not be confirmed; each row says what was read.');
  }
  renderList(els.evolutionBoundaries, entries, (entry) => itemFrom(
    (entry.locked === true ? 'locked · ' : 'unconfirmed · ') + entry.title,
    entry.evidence,
  ), 'The safety boundaries were not reported by this build.');
  if (els.evolutionPolicy) {
    const policy = value.policy || {};
    els.evolutionPolicy.textContent = 'States: ' + (policy.states || []).join(' → ')
      + '. ' + (Array.isArray(policy.rules) ? policy.rules.join(' ') : '')
      + (policy.appliesChanges === false ? ' The lab applies no change to APEX.' : '');
  }
}

async function submitEvolutionProposal(event) {
  event.preventDefault();
  const title = els.evolutionTitle?.value?.trim() ?? '';
  if (title === '') { if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'a title is required'; return; }
  const body = { title };
  const hypothesis = els.evolutionHypothesis?.value?.trim() ?? '';
  if (hypothesis !== '') body.hypothesis = hypothesis;
  if (els.evolutionProposeButton) els.evolutionProposeButton.disabled = true;
  if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'recording the proposal…';
  try {
    const result = await api('/api/evolution/propose', { method: 'POST', body });
    if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'recorded ' + result.proposalId + '; it authorizes nothing.';
    if (els.evolutionTitle) els.evolutionTitle.value = '';
    if (els.evolutionHypothesis) els.evolutionHypothesis.value = '';
    scheduleEventRefresh();
  } catch (err) {
    if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'the proposal was refused: ' + String(err.message || err);
  } finally {
    if (els.evolutionProposeButton) els.evolutionProposeButton.disabled = false;
    armWatchdog();
  }
}

async function requestPromotion(proposalId, button) {
  const reason = window.prompt('Why should this proposal be promoted? A reason is required.');
  if (reason === null) return;
  button.disabled = true;
  if (els.evolutionStatus) els.evolutionStatus.textContent = 'requesting promotion of ' + proposalId + '…';
  try {
    await api('/api/evolution/promote', { method: 'POST', body: { proposalId, reason } });
    scheduleEventRefresh();
  } catch (err) {
    if (els.evolutionStatus) els.evolutionStatus.textContent = 'the promotion request was refused: ' + String(err.message || err);
  } finally {
    button.disabled = false;
    armWatchdog();
  }
}

async function decidePromotion(proposalId, decision, button) {
  const verb = decision === 'approved' ? 'approving' : 'rejecting';
  const reason = window.prompt('Record your reason for ' + verb + ' this promotion. Your decision is audited.');
  // Approving is the act that changes what APEX may become, so it takes the step-up when one is
  // configured. A rejection is never gated.
  const stepUp = decision === 'approved' && state.stepUp?.configured === true
    ? window.prompt('Step-up proof for approving this promotion (it is required and is never stored in the audit log).')
    : null;
  if (stepUp === null && decision === 'approved' && state.stepUp?.configured === true) return;
  button.disabled = true;
  if (els.evolutionStatus) els.evolutionStatus.textContent = 'recording your decision on ' + proposalId + '…';
  try {
    const body = { proposalId, decision };
    if (reason !== null && reason.trim() !== '') body.reason = reason.trim();
    if (typeof stepUp === 'string' && stepUp !== '') body.stepUp = stepUp;
    await api('/api/evolution/decide', { method: 'POST', body });
    scheduleEventRefresh();
  } catch (err) {
    if (els.evolutionStatus) els.evolutionStatus.textContent = 'the decision was refused: ' + String(err.message || err);
  } finally {
    button.disabled = false;
    armWatchdog();
  }
}

function renderPlanning(planning) {
  const tasks = planning && Array.isArray(planning.tasks) ? planning.tasks : [];
  renderList(els.planning, tasks, (task) => itemFrom(task.description || task.id, task.because || ''));
}

// T-31 Step 3: the step-up state is read, never assumed. The field is shown only when the ECP says
// a step-up secret is configured, and the note says which of the two applies.
function renderStepUp(result) {
  const status = result?.ok === true ? result.value : null;
  state.stepUp = status;
  const configured = status?.configured === true;
  if (els.safetyStepUpWrap) els.safetyStepUpWrap.hidden = !configured;
  if (els.safetyStepUp) els.safetyStepUp.required = configured;
  if (els.safetyStepUpNote) {
    els.safetyStepUpNote.textContent = status === null
      ? 'Step-up status is unavailable, so this page cannot say whether a proof is required.'
      : configured
        ? 'A step-up secret is configured: the release is refused without it, and a refusal leaves the latch active.'
        : 'No step-up secret is configured in this deployment; the reason and the confirmation are the gate.';
  }
}

async function refresh() {
  const [stateResult, healthResult, missionResult, approvalResult, timelineResult,
    situationResult, briefingResult, runtimeResult, sourcesResult, documentsResult,
    reasoningResult, councilResult, workshopResult, resourcesResult, cognitionResult,
    presenceResult, autonomyMatrixResult, worldResult, evolutionResult, stepUpResult, perceptionResult,
    taskGraphResult, associationResult] = await Promise.all([
    readApi('/api/state'),
    readApi('/api/health'),
    readApi('/api/mission-control'),
    readApi('/api/approvals'),
    readApi('/api/timeline'),
    readApi('/api/situation'),
    readApi('/api/briefing'),
    readApi('/api/runtime'),
    readApi('/api/sources'),
    readApi('/api/documents'),
    readApi('/api/reasoning'),
    readApi('/api/council'),
    readApi('/api/workshop'),
    readApi('/api/resources'),
    readApi('/api/cognition/runs?limit=10'),
    readApi('/api/presence'),
    readApi('/api/autonomy/matrix'),
    readApi('/api/world/epistemic'),
    readApi('/api/evolution'),
    readApi('/api/step-up'),
    readApi('/api/perception?limit=20'),
    // T-34 Step 1: a refresh keeps the task the owner selected. Looking at a task is a read; it changes
    // nothing, and it must not jump back to the newest one under the owner's cursor.
    readApi('/api/taskgraph' + (els.dagSelect && els.dagSelect.value ? '?taskId=' + encodeURIComponent(els.dagSelect.value) : '')),
    readApi('/api/memory/associations?limit=10'),
  ]);

  // The authoritative snapshot carries the current session, transcript, badges, gauges and the
  // same raw values the core projection was built from. Every other workspace reads its own owner
  // endpoint so one unavailable owner is reported as unavailable instead of blanking the page.
  const snapshot = stateResult.ok === true && stateResult.value && typeof stateResult.value === 'object'
    ? stateResult.value : null;
  state.stateReadAvailable = snapshot !== null;
  if (snapshot) {
    state.last = snapshot;
    renderConversation(snapshot);
    if (els.session) {
      els.session.textContent = snapshot.session && snapshot.session.id
        ? 'session ' + String(snapshot.session.id).slice(0, 8)
        : 'no session yet';
    }
    if (snapshot.session && snapshot.session.unavailable) showBanner(snapshot.session.unavailable);
    if (els.mode) els.mode.textContent = state.view === 'deck' ? 'Deck' : 'Workspace: ' + state.view;
    if (els.autonomy) {
      const configured = snapshot.autonomy && snapshot.autonomy.configured ? snapshot.autonomy.configured : {};
      const entries = Object.entries(configured);
      els.autonomy.textContent = entries.length
        ? 'Autonomy: ' + entries.map(([domain, level]) => domain + '=' + level).join(', ')
        : 'Autonomy: not recorded by this snapshot';
    }
    const resources = snapshot.resources || {};
    if (els.gaugeCpu) {
      const cpu = resources.cpu || {};
      els.gaugeCpu.textContent = 'CPU: ' + (cpu.logicalCount != null ? cpu.logicalCount + ' cores' : 'not reported');
    }
    if (els.gaugeMem) {
      const memory = resources.memory || {};
      els.gaugeMem.textContent = 'Mem: ' + (memory.available === true
        ? Math.round((memory.freeBytes || 0) / 1048576) + '/' + Math.round((memory.totalBytes || 0) / 1048576) + ' MB'
        : 'not reported');
    }
    if (els.gaugeStorage) {
      const storage = Array.isArray(resources.storage) && resources.storage.length ? resources.storage[0] : null;
      els.gaugeStorage.textContent = 'Storage: ' + (storage && storage.reported === true
        ? Math.round((storage.availableBytes || 0) / 1048576) + '/' + Math.round((storage.totalBytes || 0) / 1048576) + ' MB'
        : 'not reported');
    }
    // T-35 Step 1: the ladder and the sensor indicator, from this snapshot's own reading. An older
    // server that reports no hud block says so instead of leaving a stale stage on the page.
    if (snapshot.hud && snapshot.hud.stepDown) {
      applyStepDown(snapshot.hud.stepDown);
      renderSensorPrivacy(snapshot.hud.sensor || null);
    } else {
      if (els.stepDownState) {
        els.stepDownState.dataset.stage = '0';
        els.stepDownState.textContent = 'Step-down: not reported by this server';
      }
      if (els.sensorPrivacy) {
        els.sensorPrivacy.dataset.audio = 'unknown';
        els.sensorPrivacy.dataset.camera = 'unknown';
        els.sensorPrivacy.textContent = 'Sensors: not reported by this server';
      }
    }
  } else {
    const reason = stateResult.error || 'the authoritative state read failed';
    setWorkspaceStatus(els.conversationStatus, (stateResult.status >= 500 ? 'Unavailable: ' : 'Read error: ') + reason,
      stateResult.status >= 500 ? 'unavailable' : 'error');
    renderList(els.conversationHistory, [], () => null, 'Unavailable: the conversation snapshot could not be read.');
    renderTurns([], 'Conversation state is unavailable.');
    if (els.session) els.session.textContent = 'session state unavailable';
    if (els.mode) els.mode.textContent = state.view === 'deck' ? 'Deck' : 'Workspace: ' + state.view;
    if (els.autonomy) els.autonomy.textContent = 'Autonomy: unavailable';
    if (els.gaugeCpu) els.gaugeCpu.textContent = 'CPU: unavailable';
    if (els.gaugeMem) els.gaugeMem.textContent = 'Mem: unavailable';
    if (els.gaugeStorage) els.gaugeStorage.textContent = 'Storage: unavailable';
    showBanner('The authoritative state read failed: ' + reason + '. Values on this page are not current.');
  }

  renderMissionControl(missionResult);
  renderApprovalCentre(approvalResult);
  renderTimeline(timelineResult);
  renderSentinel(situationResult);
  renderBriefing(briefingResult);
  renderHealth(healthResult);
  renderSystemStatus(snapshot, healthResult);
  renderRuntime(runtimeResult);
  renderSources(sourcesResult);
  renderResources(resourcesResult);
  renderDocuments(documentsResult);
  renderReasoning(reasoningResult);
  renderCouncil(councilResult);
  renderWorkshop(workshopResult);
  renderCognition(cognitionResult);
  renderPresence(presenceResult, autonomyMatrixResult);
  renderWorldClaims(worldResult);
  renderEvolution(evolutionResult);
  renderPerception(perceptionResult);
  // T-33 Step 3: the graph and the perception reading the Workshop stages a sheet from.
  state.perception = perceptionResult.ok === true ? perceptionResult.value : null;
  renderTaskGraph(taskGraphResult);
  renderAssociations(associationResult);
  renderStepUp(stepUpResult);

  applyCoreProjection(snapshot ? '' : 'The authoritative state read failed.');
  // T-33 Step 2: the framings in the snapshot were computed with the server's Core reading. If the
  // deck derived a different Core state, ask again with the deck's own so the voice matches the
  // reticle rather than describing a calmer or busier system than the one on screen.
  if (snapshot && snapshot.comms && snapshot.comms.signals?.coreState === state.core) {
    state.comms = snapshot.comms;
    renderExecComms();
  } else if (snapshot) {
    await refreshExecComms();
  } else {
    state.comms = null;
    renderExecComms();
  }
  return snapshot !== null;
}


// T-33 Step 2 (2026-11-19): the deck speaks in the selected voice.
//
// The framings come from the server's formatter, which is the one place the five voices are defined.
// The Core state the formatter is given is the deck's own - the same one the reticle shows - so the
// voice can never describe a calmer deck than the one on screen. 'data-wit-allowed' is the formatter's
// answer, not a guess made here, which is what the browser run asserts against.
function renderExecComms() {
  if (!els.execCommsHeadline) return;
  const set = state.comms;
  if (!set || !set.framings) {
    els.execCommsHeadline.textContent = 'Executive comms unavailable: the framings could not be read.';
    els.execCommsHeadline.dataset.state = 'unavailable';
    if (els.execCommsLines) renderList(els.execCommsLines, [], () => null, 'The formatter returned no framing.');
    if (els.execCommsTone) els.execCommsTone.textContent = 'Nothing is claimed while the framings are unavailable.';
    return;
  }
  const mode = MODES.includes(state.mode) ? state.mode : 'classic';
  const framing = set.framings[mode] ?? set.framings.classic;
  els.execCommsHeadline.textContent = framing.headline;
  els.execCommsHeadline.dataset.state = 'available';
  els.execCommsHeadline.dataset.mode = mode;
  els.execCommsHeadline.dataset.persona = framing.persona;
  els.execCommsHeadline.dataset.witAllowed = framing.witAllowed === true ? 'true' : 'false';
  els.execCommsHeadline.dataset.core = set.signals?.coreState ?? 'unavailable';
  renderList(els.execCommsLines, framing.lines ?? [], (entry) => itemFrom(entry.label, entry.value), 'This voice is a single line.');
  if (els.execCommsTone) {
    els.execCommsTone.dataset.witAllowed = framing.witAllowed === true ? 'true' : 'false';
    els.execCommsTone.textContent = framing.witAllowed === true
      ? framing.persona + ': wit allowed — nothing is wrong on this deck.'
      : framing.persona + ': wit withheld — ' + (set.signals?.witWithheldBecause ?? []).join('; ')
        + '. Presentation only; the facts above are unchanged.';
  }
  if (els.execCommsPanel) els.execCommsPanel.dataset.witAllowed = framing.witAllowed === true ? 'true' : 'false';
}

// The deck's own Core reading decides the voice, so a framings refresh asks the server with it. One
// request, no loop: the answer is stored and rendered, and the request is skipped when the server
// already agrees about the Core state.
async function refreshExecComms() {
  const core = state.core || 'degraded';
  try {
    const set = await api('/api/comms?core=' + encodeURIComponent(core));
    state.comms = set;
  } catch (error) {
    state.comms = null;
    if (els.execCommsTone) els.execCommsTone.textContent = 'Executive comms unavailable: ' + String(error?.message || error);
  }
  renderExecComms();
  return state.comms;
}

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === view);
  });
  const deck = document.querySelector('.deck');
  if (deck) deck.style.display = view === 'deck' ? '' : 'none';
  const workspace = document.getElementById('workspace');
  if (workspace) workspace.style.display = view === 'deck' ? 'none' : '';
  // T-35 Step 3: opening System takes a reading, because the doctor is a statement about now. A
  // view switch that lands on System twice in the same moment asks once.
  if (view === 'system') {
    const at = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (!state.doctorAt || at - state.doctorAt > 2000) {
      state.doctorAt = at;
      runDoctor();
    }
  }
}

// T-30 Package 5 (2026-11-19): presentation preferences. They change palette, motion and
// contrast only. They never call an API, write a store or reach the ECP; a mode is not a
// permission and the Lockdown presentation is derived from the latch, not selected here.
const VIEW_ORDER = ['deck', 'conversations', 'missions', 'tasks', 'approvals', 'sentinel', 'memory',
  'documents', 'reasoning', 'council', 'cognition', 'presence', 'system', 'integrations', 'workshop'];
const MODES = ['classic', 'tactical', 'overwatch', 'synthesis', 'quiet'];

function applyMode(mode) {
  const next = MODES.includes(mode) ? mode : 'classic';
  state.mode = next;
  if (state.core !== 'lockdown') document.body.dataset.mode = next;
  if (els.modeSelect && els.modeSelect.value !== next) els.modeSelect.value = next;
  // T-33 Step 2: the same facts, the voice the owner just chose. The framings are already held, so
  // this is a selection and not a round trip.
  renderExecComms();
  return next;
}

function applyMotion(reduced) {
  state.reducedMotion = reduced === true;
  document.body.dataset.motion = state.reducedMotion ? 'reduced' : 'full';
  if (els.motionToggle) {
    els.motionToggle.textContent = state.reducedMotion ? 'Motion: reduced' : 'Motion: full';
    els.motionToggle.setAttribute('aria-pressed', state.reducedMotion ? 'true' : 'false');
  }
}

function applyContrast(high) {
  state.contrast = high === true ? 'high' : 'standard';
  document.body.dataset.contrast = state.contrast;
  if (els.contrastToggle) {
    els.contrastToggle.textContent = state.contrast === 'high' ? 'Contrast: high' : 'Contrast: standard';
    els.contrastToggle.setAttribute('aria-pressed', state.contrast === 'high' ? 'true' : 'false');
  }
}

// ---- T-35 Step 1: the visual step-down ladder and the system sensor indicator ----------------
//
// The ladder is computed by the backend from real ResourceFabric pressure (src/ui/hud.js); this page
// applies the stage the reading names and, when the owner has chosen a stage by hand, applies that
// instead. The override is a presentation choice kept in the browser. It writes no store, calls no
// route, authorizes nothing, and it does not change auto.stage, which stays the machine's own
// reading - so the page can always show both without either overwriting the other.
const STEPDOWN_OVERRIDE_KEY = 'apex.stepdown.override';

function readStepDownOverride() {
  try {
    const raw = window.localStorage ? window.localStorage.getItem(STEPDOWN_OVERRIDE_KEY) : null;
    if (raw === null || raw === undefined || raw === '' || raw === 'auto') return 'auto';
    const numeric = Number(raw);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 5 ? numeric : 'auto';
  } catch (error) {
    return 'auto';
  }
}

function writeStepDownOverride(value) {
  try {
    if (!window.localStorage) return false;
    window.localStorage.setItem(STEPDOWN_OVERRIDE_KEY, String(value));
    return true;
  } catch (error) {
    return false;
  }
}

function applyStepDown(stepDown) {
  if (!stepDown || !Array.isArray(stepDown.stages) || stepDown.stages.length === 0) return null;
  const override = readStepDownOverride();
  const autoStage = Number.isInteger(stepDown.auto && stepDown.auto.stage) ? stepDown.auto.stage : 0;
  const wanted = override === 'auto' ? autoStage : override;
  const chosen = stepDown.stages.find((entry) => entry.stage === wanted) || stepDown.stages[0];
  const layers = chosen.layers || {};
  const body = document.body;
  body.dataset.stepdownStage = String(chosen.stage);
  body.dataset.stepdownSource = override === 'auto' ? 'auto' : 'override';
  body.dataset.hudBloom = layers.bloom === 'dropped' ? 'dropped' : 'on';
  body.dataset.hudParticles = layers.particles === 'dropped' ? 'dropped' : 'on';
  body.dataset.hudParallax = layers.parallax === 'dropped' ? 'dropped' : 'on';
  body.dataset.hudAmbient = layers.ambientMotion === 'dropped' ? 'dropped' : 'on';
  body.dataset.hudBackdrop = layers.backdropBlur === 'dropped' ? 'dropped' : 'on';
  body.dataset.hudFlat = layers.backdropBlur === 'dropped' || layers.panelTransitions === 'dropped' ? 'true' : 'false';
  state.stepDown = stepDown;
  if (els.stepDownSelect) els.stepDownSelect.value = override === 'auto' ? 'auto' : String(override);
  if (els.stepDownState) {
    els.stepDownState.dataset.stage = String(chosen.stage);
    els.stepDownState.dataset.source = body.dataset.stepdownSource;
    els.stepDownState.dataset.autoStage = String(autoStage);
    els.stepDownState.textContent = 'Stage ' + chosen.stage + ' · ' + chosen.name
      + (override === 'auto'
        ? ' (auto: ' + String((stepDown.auto && stepDown.auto.level) || 'unknown') + ')'
        : ' (override; auto ' + autoStage + ')');
  }
  return chosen;
}

function renderSensorPrivacy(sensor) {
  if (!els.sensorPrivacy) return;
  if (!sensor || !Array.isArray(sensor.sensors)) {
    els.sensorPrivacy.textContent = 'Sensors: unavailable';
    els.sensorPrivacy.dataset.audio = 'unknown';
    els.sensorPrivacy.dataset.camera = 'unknown';
    return;
  }
  const active = sensor.sensors.filter((entry) => entry.active === true);
  const privacy = sensor.privacy || {};
  const audio = privacy.audio && privacy.audio.state ? privacy.audio.state : 'unknown';
  const camera = privacy.camera && privacy.camera.state ? privacy.camera.state : 'unknown';
  els.sensorPrivacy.dataset.audio = audio;
  els.sensorPrivacy.dataset.camera = camera;
  els.sensorPrivacy.dataset.activeSensors = active.map((entry) => entry.id).join(',');
  els.sensorPrivacy.dataset.capturePossible = privacy.capturePossible === true ? 'true' : 'false';
  const lastRead = active.map((entry) => entry.id + ' ' + (entry.lastReadAt || 'never read')).join(' · ');
  els.sensorPrivacy.textContent = 'Sensors: ' + (active.length === 0 ? 'none active' : active.map((entry) => entry.id).join(' + '))
    + ' · audio/mic: ' + audio + ' · camera/video: ' + camera
    + (lastRead ? ' · ' + lastRead : '');
  els.sensorPrivacy.title = (privacy.audio && privacy.audio.basis ? privacy.audio.basis : '')
    + ' ' + (privacy.camera && privacy.camera.basis ? privacy.camera.basis : '');
}

// The depth-plane pointer offset the parallax factors multiply. It is written only when the ladder
// has not dropped parallax and the owner has not asked for reduced motion, and it is clamped to a
// few pixels so it reads as depth rather than as a moving page.
function trackParallax() {
  if (typeof window.addEventListener !== 'function') return;
  window.addEventListener('pointermove', (event) => {
    if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;
    const width = Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1600;
    const height = Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 900;
    const dropped = document.body.dataset.hudParallax === 'dropped';
    const damp = state.reducedMotion || dropped ? 0 : 6;
    const x = ((event.clientX / width) - 0.5) * 2 * damp;
    const y = ((event.clientY / height) - 0.5) * 2 * damp;
    document.body.style.setProperty('--parallax-x', x.toFixed(2) + 'px');
    document.body.style.setProperty('--parallax-y', y.toFixed(2) + 'px');
  }, { passive: true });
}

// Sequential keyboard traversal of the same views the nav buttons expose.
function moveView(step) {
  const index = VIEW_ORDER.indexOf(state.view);
  const next = VIEW_ORDER[(index + step + VIEW_ORDER.length) % VIEW_ORDER.length];
  setView(next);
  return next;
}

// T-33 Step 3: the TaskGraph controls and the Workshop sandbox. Each one posts to a route that runs
// the corresponding controller path, so the ECP decides and this code only asks.
if (els.dagApprove) {
  els.dagApprove.addEventListener('click', () => {
    const taskId = els.dagApprove.dataset.taskId;
    const stepId = els.dagApprove.dataset.stepId;
    postTaskControl('/api/tasks/' + encodeURIComponent(taskId) + '/approve', stepId ? { stepId } : {}, els.dagApprove, 'Approving the checkpoint');
  });
}
// T-34 Step 1: switching the recorded task. The select only asks for another task's log through the
// same route the deck already reads; the response carries that task's full graph, and the renderer
// fills the select back from it, so a task that has gone away is not left showing.
async function loadSelectedTaskGraph(taskId) {
  setWorkspaceStatus(els.dagStatus, 'Reading the recorded graph…', 'loading');
  try {
    const result = await readApi('/api/taskgraph' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''));
    renderTaskGraph(result);
    if (result?.ok !== true) setWorkspaceStatus(els.dagStatus, 'Read error: ' + String(result?.error || 'the graph could not be read'), 'error');
  } catch (error) {
    setWorkspaceStatus(els.dagStatus, 'Read error: ' + String(error?.message || error), 'error');
  }
}

if (els.dagSelect) {
  els.dagSelect.addEventListener('change', () => {
    loadSelectedTaskGraph(els.dagSelect.value);
  });
}

// T-34 Step 1: starting a mission from the deck. The request names the template and the artifact; the
// pipeline compiles the nodes, the ECP authorizes each one and the write nodes stop at the owner's
// approval. The button reports what the pipeline answered - a mission that is paused at its gates is
// reported as paused, never as done.
if (els.missionRun) {
  els.missionRun.addEventListener('click', async () => {
    const mission = els.missionSelect ? els.missionSelect.value : 'audit_and_stage';
    const artifactId = els.missionArtifact ? String(els.missionArtifact.value || '').trim() : '';
    els.missionRun.disabled = true;
    setWorkspaceStatus(els.missionRunStatus, 'Compiling and starting ' + mission + '…', 'loading');
    try {
      const response = await api('/api/cognition/run', {
        method: 'POST',
        body: { intent: 'run the ' + mission + ' mission', mission, artifactId: artifactId || null },
      });
      if (response.error) {
        setWorkspaceStatus(els.missionRunStatus, 'Refused: ' + String(response.error), 'error');
      } else {
        const run = response.run || null;
        setWorkspaceStatus(els.missionRunStatus, (run ? run.status : 'not recorded')
          + (run && run.taskId ? ' · ' + run.taskId : '')
          + (run && run.approval && run.approval.waitingSteps && run.approval.waitingSteps.length > 0
            ? ' · waiting for your approval of ' + run.approval.waitingSteps.join(', ')
            : ''),
        run && run.status === 'awaiting_approval' ? 'partial' : (run && run.status === 'completed' ? 'available' : 'error'));
        if (run && run.taskId && els.dagSelect) {
          els.dagSelect.value = run.taskId;
          await loadSelectedTaskGraph(run.taskId);
        } else {
          await refresh();
        }
      }
    } catch (error) {
      setWorkspaceStatus(els.missionRunStatus, 'Failed: ' + String(error?.message || error), 'error');
    } finally {
      els.missionRun.disabled = false;
    }
  });
}

if (els.dagResume) {
  els.dagResume.addEventListener('click', () => {
    const taskId = els.dagResume.dataset.taskId;
    postTaskControl('/api/tasks/' + encodeURIComponent(taskId) + '/resume', {}, els.dagResume, 'Resuming the recorded task');
  });
}
if (els.dagRetry) {
  els.dagRetry.addEventListener('click', () => {
    const taskId = els.dagRetry.dataset.taskId;
    const stepId = els.dagRetry.dataset.stepId;
    if (!stepId) return;
    postTaskControl('/api/tasks/' + encodeURIComponent(taskId) + '/retry', { stepId }, els.dagRetry, 'Retrying the failed node');
  });
}
if (els.dagCancel) {
  els.dagCancel.addEventListener('click', () => {
    const taskId = els.dagCancel.dataset.taskId;
    const agreed = window.confirm('Abort this task? Every downstream node stops and the cancellation is recorded.');
    if (!agreed) return;
    postTaskControl('/api/tasks/' + encodeURIComponent(taskId) + '/cancel', {}, els.dagCancel, 'Aborting the mission');
  });
}
if (els.workshopStageTelemetry) {
  els.workshopStageTelemetry.addEventListener('click', () => { composeFromTelemetry(els.workshopStageTelemetry); });
}
if (els.doctorRun) els.doctorRun.addEventListener('click', () => { runDoctor(); });
if (els.handoffStage) els.handoffStage.addEventListener('click', () => { stageHandoff(); });
if (els.handoffSource) els.handoffSource.addEventListener('change', () => { fillHandoffDevices(); });
if (els.modeSelect) els.modeSelect.addEventListener('change', () => { applyMode(els.modeSelect.value); });
if (els.motionToggle) els.motionToggle.addEventListener('click', () => { applyMotion(!state.reducedMotion); });
if (els.contrastToggle) els.contrastToggle.addEventListener('click', () => { applyContrast(state.contrast !== 'high'); });
if (els.stepDownSelect) {
  els.stepDownSelect.addEventListener('change', () => {
    const value = els.stepDownSelect.value === 'auto' ? 'auto' : Number(els.stepDownSelect.value);
    writeStepDownOverride(value);
    // The reading already holds the whole ladder, so the stage is applied without a round trip. A
    // stage that is not in the ladder is refused here and the select returns to the auto reading.
    if (!applyStepDown(state.stepDown || null) && state.last && state.last.hud) applyStepDown(state.last.hud.stepDown);
  });
}
trackParallax();

// T-32 Step 1: the keyboard-first command dispatch. Ctrl+K (or Cmd+K) and the slash key both focus
// the dispatch input, and the reticle acknowledges within the Part 4 --motion-ack token (120 ms) by
// flipping data-ack-state to "active" and counting the acknowledgement, so the pulse is inspectable
// rather than merely visible. Escape dismisses the dispatch and returns focus to the deck.
const COMMAND_ACK_MS = 120;

function pulseReticleAck() {
  const reticle = els.coreReticle;
  if (!reticle) return null;
  const at = Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()));
  reticle.dataset.ackCount = String(Number(reticle.dataset.ackCount || '0') + 1);
  reticle.dataset.ackAt = String(at);
  reticle.dataset.ackState = 'active';
  if (state.ackTimer) clearTimeout(state.ackTimer);
  state.ackTimer = setTimeout(() => {
    if (reticle.dataset.ackState === 'active') reticle.dataset.ackState = 'settled';
  }, COMMAND_ACK_MS);
  return at;
}

function focusCommandDispatch() {
  if (state.view !== 'deck') setView('deck');
  pulseReticleAck();
  if (els.text) {
    els.text.focus({ preventScroll: true });
    if (typeof els.text.setSelectionRange === 'function' && els.text.value.length > 0) {
      els.text.setSelectionRange(els.text.value.length, els.text.value.length);
    }
  }
  if (els.activity) els.activity.textContent = 'Command dispatch focused. Type a request; Escape dismisses.';
}

function dismissCommandDispatch() {
  const reticle = els.coreReticle;
  if (reticle && reticle.dataset.ackState === 'active') reticle.dataset.ackState = 'settled';
  if (els.text && document.activeElement === els.text) els.text.blur();
  if (els.activity) els.activity.textContent = '';
}

if (els.commandTrigger) els.commandTrigger.addEventListener('click', () => { focusCommandDispatch(); });

// T-32 Step 3: sensing is the governed capability, not a client-side read. The button posts to the
// route the controller owns, so the ECP decides, the operation is audited, and a lockdown refusal
// comes back as the reason it is.
if (els.perceptionSense) {
  els.perceptionSense.addEventListener('click', async () => {
    els.perceptionSense.disabled = true;
    if (els.perceptionSenseStatus) els.perceptionSenseStatus.textContent = 'Reading the host…';
    try {
      const result = await api('/api/perception/sense', { method: 'POST', body: {} });
      if (els.perceptionSenseStatus) {
        els.perceptionSenseStatus.textContent = 'Recorded: ' + (result.recorded ?? 0) + ' observation(s) at '
          + (result.reading?.at ?? 'time not recorded') + '.';
      }
    } catch (error) {
      if (els.perceptionSenseStatus) els.perceptionSenseStatus.textContent = 'Reading refused: ' + String(error?.message || error);
    } finally {
      els.perceptionSense.disabled = false;
      refresh();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (!event || event.defaultPrevented) return;
  const target = event.target;
  const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || (target && target.isContentEditable === true);
  // The chord works even from inside a field, because it is how the owner leaves one.
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault();
    focusCommandDispatch();
    return;
  }
  if (event.key === 'Escape') {
    dismissCommandDispatch();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault();
    moveView(event.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (typing) return;
  if (event.key === '/' && els.text) {
    event.preventDefault();
    focusCommandDispatch();
  }
});

async function boot() {
  if (!els.boot) return;
  const checks = await Promise.allSettled([
    api('/api/state'),
    api('/api/health'),
    api('/api/killswitch'),
  ]);
  const lines = [];
  const stateResult = checks[0];
  if (stateResult.status === 'fulfilled') {
    const snapshot = stateResult.value;
    lines.push('State API: available (' + (Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0)
      + ' task records, ' + (Array.isArray(snapshot.plans) ? snapshot.plans.length : 0) + ' plan records).');
    lines.push('Runtime: ' + (snapshot.runtime?.status || snapshot.runtime?.lifecycle || 'status unavailable'));
  } else {
    lines.push('State API: unavailable (' + String(stateResult.reason?.message || stateResult.reason).slice(0, 180) + ').');
  }
  const healthResult = checks[1];
  if (healthResult.status === 'fulfilled') {
    const health = healthResult.value;
    lines.push('Health overall: ' + String(health.overall || 'unknown') + '.');
    for (const area of (Array.isArray(health.areas) ? health.areas : []).slice(0, 10)) {
      lines.push('  ' + String(area.label || area.key || 'subsystem') + ': ' + String(area.state || 'unknown'));
    }
  } else {
    lines.push('Health: unavailable (' + String(healthResult.reason?.message || healthResult.reason).slice(0, 180) + ').');
  }
  const safetyResult = checks[2];
  if (safetyResult.status === 'fulfilled') {
    const safety = safetyResult.value;
    lines.push('ECP kill switch: ' + (safety.active === true ? 'ACTIVE'
      : safety.policyUnavailable === true ? 'unavailable; fail-closed'
        : safety.active === false ? 'clear' : 'unknown') + '.');
  } else {
    lines.push('ECP kill switch: unavailable; not assumed clear.');
  }
  lines.push('Owner event stream: ' + (state.eventReconciled ? 'reconciled' : 'waiting for reconciliation') + '.');
  if (els.bootLines) {
    els.bootLines.replaceChildren();
    for (const line of lines) els.bootLines.append(el('div', null, line));
  }
  els.boot.classList.add('hidden');
}

// T-34 Step 3: acknowledging the briefing. The checkpoint is written by the governed action through
// the controller, and the answer is reported from what the action verified - never from the click.
if (els.briefingAcknowledge) {
  els.briefingAcknowledge.addEventListener('click', async () => {
    const reason = els.briefingAckReason ? String(els.briefingAckReason.value || '').trim() : '';
    els.briefingAcknowledge.disabled = true;
    setWorkspaceStatus(els.briefingAckStatus, 'Writing the checkpoint through the controller…', 'loading');
    try {
      const response = await api('/api/briefing/acknowledge', { method: 'POST', body: reason ? { reason } : {} });
      if (response.error) {
        setWorkspaceStatus(els.briefingAckStatus, 'Refused: ' + String(response.error), 'error');
      } else {
        const checkpointId = response.checkpoint?.checkpointId || 'recorded';
        setWorkspaceStatus(els.briefingAckStatus, 'Acknowledged · checkpoint ' + checkpointId
          + (response.delta?.text ? ' · ' + response.delta.text : ''), 'available');
        if (els.briefingAckReason) els.briefingAckReason.value = '';
      }
    } catch (error) {
      setWorkspaceStatus(els.briefingAckStatus, 'Failed: ' + String(error?.message || error), 'error');
    } finally {
      els.briefingAcknowledge.disabled = false;
      await refresh();
    }
  });
}

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

if (els.form) {
  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!els.text) return;
    const text = els.text.value;
    if (text.trim().length === 0) return;
    state.thinking = true;
    applyCoreProjection();
    showBanner('');
    els.send.disabled = true;
    if (els.activity) els.activity.textContent = 'working…';
    try {
      await api('/api/chat', { method: 'POST', body: { text } });
      els.text.value = '';
      await refresh();
    } catch (error) {
      showBanner(error.message);
    } finally {
      state.thinking = false;
      els.send.disabled = false;
      if (els.activity) els.activity.textContent = '';
      applyCoreProjection();
    }
  });
}

if (els.newSession) {
  els.newSession.addEventListener('click', async () => {
    els.newSession.disabled = true;
    try {
      await api('/api/session/new', { method: 'POST', body: {} });
      await refresh();
      showBanner('Started a new session. Earlier turns remain in the conversation log.');
    } catch (error) {
      showBanner(error.message);
    } finally {
      els.newSession.disabled = false;
    }
  });
}

if (els.safetyLockForm) {
  els.safetyLockForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = els.safetyLockReason?.value?.trim() ?? '';
    if (!reason) {
      if (els.safetyLockResult) els.safetyLockResult.textContent = 'A reason is required.';
      return;
    }
    state.safetyMutationInFlight = true;
    state.safetyLatchFresh = false;
    renderSafety();
    if (els.safetyLockResult) els.safetyLockResult.textContent = 'Sending the user-origin ECP request…';
    try {
      const result = await api('/api/safety/lockdown', { method: 'POST', body: { reason } });
      const audit = result.recorded === true && result.operationId ? ' Audit operation ' + result.operationId.slice(0, 8) + '.' : '';
      if (els.safetyLockResult) els.safetyLockResult.textContent = (result.recorded === true
        ? 'ECP lockdown request recorded; waiting for the authoritative latch event.'
        : 'ECP did not confirm that the audit record was written.') + audit;
      els.safetyLockForm.reset();
    } catch (error) {
      if (els.safetyLockResult) els.safetyLockResult.textContent = error.message;
    } finally {
      state.safetyMutationInFlight = false;
      await refreshSafetyLatch();
    }
  });
}

if (els.safetyReleaseForm) {
  els.safetyReleaseForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = els.safetyReleaseReason?.value?.trim() ?? '';
    if (!reason || !els.safetyReleaseConfirm?.checked) {
      if (els.safetyReleaseResult) els.safetyReleaseResult.textContent = 'A reason and explicit confirmation are required.';
      return;
    }
    state.safetyMutationInFlight = true;
    state.safetyLatchFresh = false;
    renderSafety();
    if (els.safetyReleaseResult) els.safetyReleaseResult.textContent = 'Sending the explicit user-origin ECP release request…';
    try {
      // The proof is read from the field only when step-up is configured; the server refuses the
      // release either way if step-up is configured and the proof is missing or wrong.
      const stepUp = state.stepUp?.configured === true ? (els.safetyStepUp?.value ?? '') : '';
      const body = stepUp === '' ? { reason, confirm: true } : { reason, confirm: true, stepUp };
      const result = await api('/api/safety/release', { method: 'POST', body });
      const audit = result.recorded === true && result.operationId ? ' Audit operation ' + result.operationId.slice(0, 8) + '.' : '';
      if (els.safetyReleaseResult) els.safetyReleaseResult.textContent = (result.recorded === true
        ? 'ECP release request recorded; waiting for the authoritative latch event. No task or runtime is resumed by this control.'
        : 'ECP did not confirm that the audit record was written.') + audit;
      els.safetyReleaseForm.reset();
    } catch (error) {
      if (els.safetyReleaseResult) els.safetyReleaseResult.textContent = error.message;
    } finally {
      state.safetyMutationInFlight = false;
      await refreshSafetyLatch();
    }
  });
}

if (els.planningForm) {
  els.planningForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (els.planningStatus) els.planningStatus.textContent = 'reading…';
    try {
      const result = await api('/api/planning', { method: 'POST', body: { objective: els.planningObjective.value, goal: els.planningGoal.value || null } });
      renderPlanning(result.planning);
      if (els.planningStatus) els.planningStatus.textContent = result.status || 'done';
    } catch (error) {
      if (els.planningStatus) els.planningStatus.textContent = error.message;
    }
  });
}

if (els.docSearch) {
  els.docSearch.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/documents?q=' + encodeURIComponent(els.docSearchText.value || ''));
      renderDocuments({ ok: true, value: data });
    } catch (error) {
      showBanner(error.message);
    }
  });
}

if (els.workshopForm) {
  if (els.evolutionForm) els.evolutionForm.addEventListener('submit', submitEvolutionProposal);
  els.workshopForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (els.workshopCompose) els.workshopCompose.disabled = true;
    if (els.workshopStatus) els.workshopStatus.textContent = 'validating design…';
    try {
      const source = JSON.parse(els.workshopSource.value || '{}');
      const budgetText = els.workshopBudget?.value?.trim() ?? '';
      const budget = budgetText === '' ? null : Number(budgetText);
      if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
        throw new Error('budget must be a finite, non-negative number');
      }
      const result = await api('/api/workshop/compose', {
        method: 'POST',
        body: {
          title: els.workshopTitle.value,
          domain: els.workshopDomain.value,
          components: source.components,
          connections: source.connections ?? [],
          budget,
          note: typeof source.note === 'string' ? source.note : '',
        },
      });
      if (els.workshopStatus) els.workshopStatus.textContent = result.status === 'success_verified'
        ? 'stored: ' + result.artifactId
        : (result.display || result.error || result.status || 'composition did not verify');
      await refresh();
      if (result.artifactId) await simulateWorkshop(result.artifactId);
    } catch (error) {
      if (els.workshopStatus) els.workshopStatus.textContent = error instanceof SyntaxError
        ? 'components and connections must be valid JSON'
        : error.message;
    } finally {
      if (els.workshopCompose) els.workshopCompose.disabled = false;
    }
  });
}

if (els.cognitionForm) {
  els.cognitionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.cognitionInFlight) return;
    const intent = els.cognitionIntent ? els.cognitionIntent.value.trim() : '';
    if (intent.length === 0) {
      if (els.cognitionRunStatus) els.cognitionRunStatus.textContent = 'An intent is required.';
      return;
    }
    state.cognitionInFlight = true;
    state.thinking = true;
    applyCoreProjection();
    if (els.cognitionRun) els.cognitionRun.disabled = true;
    if (els.cognitionRunStatus) els.cognitionRunStatus.textContent = 'Running the five stages…';
    try {
      const body = { intent };
      const chosen = els.cognitionAction ? els.cognitionAction.value : '';
      if (chosen) body.action = chosen;
      const data = await api('/api/cognition/run', { method: 'POST', body });
      state.lastCognitionRun = data.run || null;
      renderCognitionTrace(data.run || null);
      const status = data.runStatus || data.run?.status || data.status || 'recorded';
      if (els.cognitionRunStatus) {
        els.cognitionRunStatus.textContent = status === 'awaiting_approval'
          ? 'Recorded: a step is waiting for your explicit approval before it can execute.'
          : 'Recorded: run status ' + status + '.';
      }
      if (els.cognitionIntent) els.cognitionIntent.value = '';
    } catch (error) {
      if (els.cognitionRunStatus) els.cognitionRunStatus.textContent = 'The run was refused: ' + String(error.message || error);
    } finally {
      state.cognitionInFlight = false;
      state.thinking = false;
      applyCoreProjection();
      if (els.cognitionRun) els.cognitionRun.disabled = false;
      await refresh();
    }
  });
}

if (els.councilForm) {
  els.councilForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const objective = els.councilObjective ? els.councilObjective.value.trim() : '';
    if (objective.length === 0) {
      if (els.councilStatus) els.councilStatus.textContent = 'an objective is required';
      return;
    }
    if (els.councilRun) els.councilRun.disabled = true;
    if (els.councilStatus) els.councilStatus.textContent = 'deliberating…';
    try {
      const result = await api('/api/council/deliberate', {
        method: 'POST',
        body: { objective, useContext: !!(els.councilGather && els.councilGather.checked) },
      });
      if (els.councilStatus) {
        els.councilStatus.textContent = result.persisted === false
          ? 'deliberated, but the session was not persisted: ' + (result.persistenceError || 'store unavailable')
          : 'deliberated: ' + result.synthesis.recommendedOption.level;
      }
      await refresh();
    } catch (error) {
      if (els.councilStatus) els.councilStatus.textContent = error.message;
    } finally {
      if (els.councilRun) els.councilRun.disabled = false;
    }
  });
}

function skipBoot() {
  if (els.boot) els.boot.classList.add('hidden');
}
if (els.bootSkip) els.bootSkip.addEventListener('click', skipBoot);
if (els.quickBoot) els.quickBoot.addEventListener('click', skipBoot);

setInterval(() => {
  if (els.clock) els.clock.textContent = new Date().toLocaleString();
}, 1000);

const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
state.reducedMotion = !!(reduce && reduce.matches);
document.body.dataset.motion = state.reducedMotion ? 'reduced' : 'full';
const contrastQuery = window.matchMedia && window.matchMedia('(prefers-contrast: more)');
applyMotion(state.reducedMotion);
applyContrast(!!(contrastQuery && contrastQuery.matches));
applyMode(state.mode);

let eventSource = null;
let eventWatchdog = null;
let forcedReconciliation = false;
let snapshotSyncInFlight = false;
let eventRefreshRequested = false;
let eventRefreshTimer = null;
let eventHealthGeneration = 0;

function markEventDegraded(reason) {
  eventHealthGeneration += 1;
  eventStreamDegraded = true;
  if (els.connectivity) els.connectivity.textContent = 'Degraded';
  applyCoreProjection(reason || 'Event stream is unavailable.');
}

function armWatchdog() {
  if (!eventWatchdog) {
    eventWatchdog = createEventWatchdog({
      timeoutMs: EVENT_WATCHDOG_MS,
      onExpired: () => markEventDegraded('Event stream lost.'),
    });
  }
  eventWatchdog.arm();
}

function scheduleEventRefresh() {
  if (snapshotSyncInFlight) {
    eventRefreshRequested = true;
    return;
  }
  if (eventRefreshTimer) return;
  eventRefreshTimer = setTimeout(() => {
    eventRefreshTimer = null;
    refresh();
  }, 50);
}

async function synchronizeAfterReconcile() {
  if (snapshotSyncInFlight) {
    eventRefreshRequested = true;
    return;
  }
  snapshotSyncInFlight = true;
  const generation = eventHealthGeneration;
  eventStreamDegraded = false;
  const available = await refresh();
  if (!available) {
    markEventDegraded('Authoritative state reconciliation failed.');
  } else if (generation === eventHealthGeneration) {
    eventStreamDegraded = false;
    if (els.connectivity) els.connectivity.textContent = 'Connected';
    applyCoreProjection();
    armWatchdog();
  }
  snapshotSyncInFlight = false;
  if (eventRefreshRequested) {
    eventRefreshRequested = false;
    scheduleEventRefresh();
  }
}

function forceReconciliation(reason) {
  markEventDegraded('Event stream reconciliation required: ' + reason + '.');
  if (forcedReconciliation || typeof EventSource !== 'function') return;
  forcedReconciliation = true;
  try { if (eventSource) eventSource.close(); } catch (error) {}
  connectEvents(true);
}

function parseEventData(event) {
  try {
    const value = JSON.parse(event.data);
    return isRecord(value) ? value : null;
  } catch (error) {
    return null;
  }
}

function acceptStateEvent(event) {
  const data = parseEventData(event);
  if (!data) {
    forceReconciliation('malformed state event');
    return;
  }
  const validation = validateStateEventEnvelope(data, state.eventCursor);
  if (!validation.ok) {
    markEventDegraded('Invalid state event: ' + validation.reason + '.');
    if (validation.reason !== 'unsupported-schema') forceReconciliation(validation.reason);
    return;
  }
  if (event.lastEventId !== data.streamId + ':' + data.seq) {
    forceReconciliation('event cursor does not match its versioned envelope');
    return;
  }
  state.eventCursor = validation.cursor;
  armWatchdog();
  if (validation.kind === 'reconcile') {
    state.ownerSnapshots = data.payload.owners;
    state.eventReconciled = true;
    state.safetyLatchFresh = state.ownerSnapshots.lockdown?.available === true;
    forcedReconciliation = false;
    applyCoreProjection();
    synchronizeAfterReconcile();
    return;
  }
  state.ownerSnapshots[data.category] = data.payload;
  if (data.category === 'lockdown') state.safetyLatchFresh = data.payload.available === true;
  applyCoreProjection();
  if (eventStreamDegraded) synchronizeAfterReconcile();
  else scheduleEventRefresh();
}

function acceptHeartbeat(event) {
  const data = parseEventData(event);
  const validation = validateHeartbeatEnvelope(data, state.eventCursor);
  if (!validation.ok) {
    markEventDegraded('Invalid event heartbeat: ' + validation.reason + '.');
    if (validation.reason !== 'unsupported-heartbeat-schema') forceReconciliation(validation.reason);
    return;
  }
  armWatchdog();
  if (state.eventCursor.streamId === data.streamId && eventStreamDegraded) synchronizeAfterReconcile();
}

function connectEvents(forceReconcile = false) {
  if (typeof EventSource !== 'function') {
    markEventDegraded('Event streams are unavailable in this browser.');
    return;
  }
  try { if (eventSource) eventSource.close(); } catch (error) {}
  try {
    eventSource = new EventSource(forceReconcile ? '/api/events?reconcile=1' : '/api/events');
  } catch (error) {
    markEventDegraded('Event stream connection failed.');
    return;
  }
  const source = eventSource;
  source.onopen = () => {
    if (source !== eventSource) return;
    armWatchdog();
    if (els.connectivity) els.connectivity.textContent = state.eventReconciled && !eventStreamDegraded ? 'Connected' : 'Reconciling';
  };
  source.addEventListener('hello', () => { if (source === eventSource) armWatchdog(); });
  source.addEventListener('reconcile', acceptStateEvent);
  source.addEventListener('state-changed', acceptStateEvent);
  source.addEventListener('heartbeat', acceptHeartbeat);
  source.addEventListener('progress', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (els.activity) els.activity.textContent = data.stage === 'model' ? 'waiting for the model…' : 'working: ' + data.stage;
    } catch (error) {
      if (els.activity) els.activity.textContent = 'working…';
    }
    armWatchdog();
  });
  source.addEventListener('chat', () => {
    if (!eventStreamDegraded) scheduleEventRefresh();
    armWatchdog();
  });
  source.addEventListener('council', () => { scheduleEventRefresh(); armWatchdog(); });
  source.addEventListener('cognition', () => { scheduleEventRefresh(); armWatchdog(); });
  source.addEventListener('workshop', () => { scheduleEventRefresh(); armWatchdog(); });
  source.addEventListener('evolution', () => { scheduleEventRefresh(); armWatchdog(); });
  source.onerror = () => {
    if (source !== eventSource) return;
    markEventDegraded('Event stream error.');
    armWatchdog();
  };
}

setView('deck');
connectEvents();
refresh();
boot();
setInterval(refresh, 15000);
`;
