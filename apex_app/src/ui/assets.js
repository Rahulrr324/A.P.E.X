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
<!-- T-36 Step 2 (2026-11-21): Part 4 Screen #1 - the HUD boot sequence. It is the opening
     screen of a workstation that has not been set up yet: one message - the system waking and
     verifying readiness - over the six subsystems it actually checks. It is a panel and not a
     modal: it never takes focus, it never covers the emergency controls, and Escape dismisses
     it. Every line in it is a measured value; nothing here is a stage direction. -->
<div id="hud-boot-sequence" class="hud-boot" role="region" aria-labelledby="hud-boot-message"
     data-screen-id="boot"
     data-screen-message="The system waking and verifying readiness over the six subsystems it actually checks; every line is a measured value." hidden>
  <div class="hud-boot-panel">
    <p class="hud-boot-message" id="hud-boot-message">System waking and verifying readiness</p>
    <ol class="hud-boot-steps" id="hud-boot-steps"></ol>
    <button id="hud-boot-dismiss" type="button" class="quiet small">Skip &middot; dismiss (Esc)</button>
  </div>
</div>
<header class="topbar">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">A</div>
    <div>
      <h1>APEX</h1>
      <p class="sub">Command Deck &middot; loopback only &middot; verified state only</p>
    </div>
  </div>
  <!-- T-46 STEP 1 (2026-11-19): the header is ONE band, 64px tall on a desktop, carrying the five
       readings an owner glances at and nothing more. The review that started this milestone found the
       old header wrapping nine badges and eleven controls into several rows, which pushed the Core -
       the thing the eye is supposed to land on - halfway down the page. Everything that is not one of
       the five readings is still here, still carrying its id, and moved into #measures-panel below,
       which Tab reaches. Nothing was deleted: a badge that merely disappeared would have made the
       header shorter and the product smaller. -->
  <div class="topbar-meta">
    <span id="clock" class="meta mono"></span>
    <span id="session" class="meta" hidden></span>
    <span id="mode" class="badge">Deck</span>
    <span id="autonomy" class="badge" hidden>Autonomy: —</span>
    <span id="connectivity" class="badge">Connecting</span>
    <!-- The compact strip. Each reading is a mirror of an authoritative value the deck already holds:
         the Core projection, the latch, the Approval Centre's own total and the watchpoint ledger's
         breached count. They are written by syncHeaderStrip() in the client, from the same render pass
         that writes the panel the reading came from, so the strip cannot disagree with it. -->
    <span class="strip-item"><span class="strip-key">CORE</span>
      <span id="core-state-compact" class="strip-value" role="status" aria-live="polite">—</span></span>
    <span class="strip-item"><span class="strip-key">LATCH</span>
      <span id="latch-compact" class="strip-value">—</span></span>
    <span class="strip-item"><span class="strip-key">PENDING</span>
      <span id="approvals-compact" class="strip-value">—</span></span>
    <span class="strip-item"><span class="strip-key">BREACHED</span>
      <span id="watchpoints-compact" class="strip-value">—</span></span>
  </div>
  <!-- T-46 STEP 1: four controls stay on the band. Command and Help are how the owner finds anything
       else, the overlay toggle is the one posture a live watch uses, and the mode select is the one
       control whose current value is itself a reading. The rest - motion, contrast, step-down, New
       session, Quick boot, Run Boot Sequence, and the six system badges - are in #measures-panel, which
       the Measures button opens and Escape closes. Every one of them keeps its id. -->
  <div class="topbar-actions">
    <!-- T-32 Step 1: the command dispatch is reachable from the top bar, so Tab reaches it before the
         workspace tabs, and Ctrl+K or / opens it from anywhere. -->
    <button id="command-trigger" type="button" class="hud-chip" aria-keyshortcuts="Control+K" aria-controls="chat-text">
      Command <kbd>Ctrl K</kbd>
    </button>
    <!-- T-40 Step 3: the command and keyboard reference. It opens as a panel rather than a modal, so the
         owner can read it while still typing in the bar, and Escape closes it without losing the line. -->
    <button id="hud-help-toggle" type="button" class="hud-chip" aria-keyshortcuts="?" aria-controls="hud-command-help" aria-expanded="false">
      Help <kbd>?</kbd>
    </button>
    <label class="visually-hidden" for="mode-select">Presentation mode</label>
    <select id="mode-select" class="small" aria-label="Presentation mode">
      <option value="classic">Classic</option>
      <option value="tactical">Tactical</option>
      <option value="overwatch">Overwatch</option>
      <option value="synthesis">Synthesis</option>
      <option value="quiet">Quiet</option>
    </select>
    <!-- T-46 STEP 1: the popover. It is a panel, not a modal: it never traps focus, Escape closes it and
         returns focus to this button, and everything it carries is also reachable from the System view.
         The overlay toggle moved INTO it in the second pass: the band keeps two buttons and two
         selects, and the toggle is one click away behind a button that is itself one click away. A HUD's
         status band is not a toolbox. -->
    <button id="measures-trigger" type="button" class="hud-chip" aria-expanded="false"
            aria-controls="measures-panel" aria-keyshortcuts="Escape">
      Measures
    </button>
  </div>
</header>

<!-- T-46 STEP 1 (2026-11-19): the measures popover. It is where the header's other readings live now:
     the six system badges, and the six controls that are configuration rather than status. It is a
     panel rather than a modal - it does not take focus when it opens, it does not trap it while open,
     and Escape closes it and puts focus back on the button that opened it. Every element keeps the id
     it had in the header, so the client, every test and every reader of the ids is unaffected: what
     changed is WHERE the reading is drawn, not what it says. -->
<div id="measures-panel" class="measures-panel" role="group" aria-label="System measures and display settings" hidden>
  <p class="measures-title">Measures <span class="measures-hint">readings the header has no room for · Esc closes</span></p>
  <div class="measures-group">
    <p class="measures-key">System</p>
    <div class="measures-row">
      <span id="gauge-cpu" class="badge" aria-label="CPU">CPU: —</span>
      <span id="gauge-mem" class="badge" aria-label="Memory">Mem: —</span>
      <span id="gauge-storage" class="badge" aria-label="Storage">Storage: —</span>
      <!-- T-35 Step 1: Part 4's system sensor and privacy indicator. Every value on it is read from the
           backend: which local sensors are wired, when each last read, and that capture is disabled. -->
      <span id="sensor-privacy-indicator" class="badge" role="status" aria-live="polite"
            data-audio="disabled" data-camera="disabled" aria-label="Local sensors and privacy">Sensors: reading…</span>
      <span id="stepdown-state-compact" class="badge" aria-label="Visual step-down stage">Step-down: —</span>
    </div>
  </div>
  <div class="measures-group">
    <p class="measures-key">Display</p>
    <div class="measures-row">
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
    </div>
  </div>
  <div class="measures-group">
    <p class="measures-key">Posture</p>
    <div class="measures-row">
      <!-- T-45 Package 3: the compact tactical overlay. A posture, not a mode: a mode changes palette,
           motion and contrast; this changes what the deck puts on screen, and the strip it reveals is
           the five numbers an owner watching a live system needs without the full chrome. -->
      <button id="btn-hud-overlay-toggle" type="button" class="quiet small" aria-pressed="false"
              aria-controls="tactical-overlay-strip" title="Compact tactical overlay: the live core state, mode, latch and counts on one strip">OVERLAY: OFF</button>
    </div>
  </div>
  <div class="measures-group">
    <p class="measures-key">Session</p>
    <div class="measures-row">
      <button id="new-session" type="button" class="quiet small">New session</button>
      <button id="quick-boot" type="button" class="quiet small">Quick boot</button>
      <!-- T-36 Step 2: the owner can replay the cold-start sequence on a machine that is already
           set up. It is the same governed bootstrap, so it refreshes rather than re-creates. -->
      <button id="boot-sequence-run" type="button" class="quiet small">Run Boot Sequence</button>
    </div>
  </div>
</div>

<!-- T-45 Package 3: the compact tactical overlay strip. It is outside every view on purpose - it is the one
     surface that must be visible whichever workspace the owner is looking at, and a strip inside a view
     would disappear the moment they navigated. Every number in it is a reading the deck already holds, so
     the strip adds no request and cannot disagree with the panel the number came from. -->
<div id="tactical-overlay-strip" class="tactical-overlay-strip" role="group" aria-label="Tactical overlay" hidden>
  <span class="overlay-item"><span class="overlay-key">CORE</span> <span id="overlay-core-state" class="overlay-value">—</span></span>
  <span class="overlay-item"><span class="overlay-key">MODE</span> <span id="overlay-mode" class="overlay-value">—</span></span>
  <span class="overlay-item"><span class="overlay-key">LATCH</span> <span id="overlay-lockdown" class="overlay-value">—</span></span>
  <span class="overlay-item"><span class="overlay-key">BREACHED</span> <span id="overlay-watchpoint-breaches" class="overlay-value">0</span></span>
  <span class="overlay-item"><span class="overlay-key">PENDING</span> <span id="overlay-approvals" class="overlay-value">0</span></span>
</div>
<!-- T-32 Step 1: the command dispatch lives in its own bar between the top bar and the workspace
     tabs. One input, one place, and Tab reaches it before the tabs because that is where it is in
     the document rather than because a tabindex was raised above its neighbours. -->

<!-- T-46 STEP 1 (2026-11-19): the deck is a fixed shell now. <body> is one viewport tall and does not
     scroll; the header and the command bar are docked; the workspace band between them is the only
     scroll container, and every panel inside it scrolls inside itself. That is what makes the command
     bar reachable without scrolling past every panel, which is the review's second finding. Nothing is
     hidden to achieve it: every panel is still in the band, every panel can still be scrolled to its
     last row, and every view is still reachable from this navigation and Ctrl+K. -->
<div class="shell">
<!-- T-46 STEP 1 (2026-11-19): the command bar is the FIRST child of the shell in document order, and
     the LAST thing painted in it. The two orders are deliberate and different:
       * document order is focus order, and the bar is how the owner reaches everything else - so Tab
         reaches it before the fifteen workspace tabs, which is the contract T-32 pinned and this
         milestone is not allowed to break;
       * paint order is set by CSS (order: 3 on the bar, 1 on the navigation, 2 on the deck), so the bar
         is docked under the deck where a command line belongs.
     The bar used to sit outside the shell entirely, after every panel in the document - which is why
     typing meant scrolling past the whole deck to find it. -->
<section class="command-bar" data-depth-plane="z1" aria-label="Command dispatch">
  <!-- T-40 Step 3: what the bar accepts, read from the router at the moment it is opened. Nothing in this
       panel is written by hand: every row is a route the router will actually take, with the live ECP
       decision for the capability behind it. It is not a modal and traps nothing. -->
  <div id="hud-command-help" class="panel hud-help" data-depth-plane="z3" role="region"
       aria-labelledby="hud-command-help-title" hidden>
    <div class="row">
      <h3 id="hud-command-help-title">Command reference</h3>
      <button id="hud-help-close" type="button" class="quiet small">Close</button>
    </div>
    <p id="hud-command-help-state" class="meta" role="status" aria-live="polite">Reading the command catalogue…</p>
    <table class="hud-help-table">
      <caption class="visually-hidden">Commands the command bar accepts</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Route</th><th scope="col">Governance</th></tr></thead>
      <tbody id="hud-command-help-rows"></tbody>
    </table>
    <h4>Keys</h4>
    <ul id="hud-command-help-keys" class="work"></ul>
    <p class="meta">Clicking a command fills the bar with it. Pressing Escape closes this panel and leaves whatever you had typed in place.</p>
  </div>
  <form id="chat-form">
    <label for="chat-text" class="visually-hidden">Message</label>
    <textarea id="chat-text" rows="2" maxlength="4000" placeholder="Command APEX, or ask for a verified read"></textarea>
    <div class="row">
      <button id="send" type="submit">Send</button>
      <span id="activity" class="meta" role="status"></span>
    </div>
    <!-- T-37 Step 3: the dispatch receipt. The router answers with a structured record - route kind,
         capability, ECP decision, whether it verified - and this renders that record. It never
         guesses: a refused line shows the refusal, and an unmatched line says it went to the
         pipeline rather than pretending the router understood it. -->
    <dl id="dispatch-receipt" class="facts" hidden></dl>
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
<main id="main-content" class="deck"
      data-screen-id="command-deck"
      data-screen-message="Live command deck: core state, gauges, transcript and the governed composer that turns an intent into a recorded run.">
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

</div>
<section class="workspace" id="workspace">
  <section class="view" data-view="conversations" data-depth-plane="z3">
    <h2>Conversations</h2>
    <p class="meta">Session persistence and history. The current session is shown on the deck; older turns remain in the conversation log.</p>
    <p id="conversation-status" class="workspace-status" role="status" aria-live="polite">Loading conversation records…</p>
    <ul id="conversation-history" class="work"></ul>
  </section>
  <section class="view" data-view="missions" data-depth-plane="z3"
         data-screen-id="mission-view"
         data-screen-message="Mission control and the task graph: the steps a mission actually ran, each with the outcome the controller recorded rather than one predicted for it.">
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
  <section class="view" data-view="tasks" data-depth-plane="z3"
         data-screen-id="briefing"
         data-screen-message="The work briefing: what changed since the last acknowledged checkpoint, with the delta stated rather than summarised away.">
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
    <!-- T-45 Package 3: the executive playbooks. Three curated multi-step routines, each a DAG: two roots
         that do not depend on each other, then a fan-in step that runs only if both verified. The template
         cards are drawn from the template's own step list, so the panel cannot disagree with the engine
         about what the routine is. -->
    <section class="panel" id="playbooks-panel" data-depth-plane="z4" aria-labelledby="playbooks-heading"
             aria-describedby="playbooks-description">
      <h3 id="playbooks-heading">Executive playbooks</h3>
      <p id="playbooks-description" class="meta">A curated routine of three steps, run through the ECP in dependency order. A fan-in step runs only if every step it depends on verified; otherwise it is recorded as skipped and the run as failed.</p>
      <p id="playbooks-status" class="workspace-status" role="status" aria-live="polite">Loading the playbooks…</p>
      <div id="playbooks-summary-badges" class="badge-row" role="group" aria-label="Playbook summary">
        <span class="badge" data-playbook-badge="templates">TEMPLATES <span id="playbooks-template-count">0</span></span>
        <span class="badge" data-playbook-badge="runs">TOTAL RUNS <span id="playbooks-runs-count">0</span></span>
        <span class="badge" data-playbook-badge="verified">VERIFIED RUNS <span id="playbooks-verified-count">0</span></span>
      </div>
      <h4>Templates</h4>
      <ul id="playbooks-template-list" class="work playbooks-list"></ul>
      <h4>Runs</h4>
      <p id="playbooks-runs-status" class="workspace-status" role="status" aria-live="polite"></p>
      <ul id="playbooks-runs-list" class="work playbooks-list playbooks-runs"></ul>
    </section>
  </section>
  <section class="view" data-view="approvals" data-depth-plane="z3">
    <h2>Approval Centre</h2>
    <p class="meta">Pending requests come from TaskStore, PlanStore and Sentinel records. Approving records intent only; it does not start a task or run a response. Risk, scope, reversibility and expiry are not inferred when an owner did not record them.</p>
    <p id="approval-state" class="workspace-status" role="status" aria-live="polite">Loading pending owner requests…</p>
    <p id="approval-action-status" class="workspace-status" role="status" aria-live="polite"></p>
    <ul id="approval-items" class="work"></ul>
    <!-- T-44 Package 2: the unified executive agenda. The commitments are the owner's own words; the
         derived list is a reading of four other stores, so it carries no action buttons - the way to
         resolve one is to go and resolve the thing it names, which is why every card links to it. -->
    <section class="panel" id="briefing-agenda-panel" data-depth-plane="z3" aria-labelledby="agenda-heading"
             aria-describedby="agenda-description">
      <h3 id="agenda-heading">Executive agenda</h3>
      <p id="agenda-description" class="meta">The owner's commitments by horizon, and readings from the approval gate, the task graph, the Sentinel and the armed standing orders. A derived item is read from its own store and cannot be settled here.</p>
      <p id="agenda-status" class="workspace-status" role="status" aria-live="polite">Loading the agenda…</p>
      <div id="agenda-summary-badges" class="badge-row" role="group" aria-label="Agenda summary">
        <span class="badge" data-agenda-badge="overdue">OVERDUE <span id="agenda-overdue-count">0</span></span>
        <span class="badge" data-agenda-badge="today">TODAY <span id="agenda-today-count">0</span></span>
        <span class="badge" data-agenda-badge="upcoming">UPCOMING / UNSCHEDULED <span id="agenda-upcoming-count">0</span></span>
        <span class="badge" data-agenda-badge="completed">COMPLETED <span id="agenda-completed-count">0</span></span>
        <span class="badge" data-agenda-badge="derived">DERIVED GATES <span id="agenda-derived-count">0</span></span>
      </div>
      <div class="agenda-add">
        <label for="agenda-title-input" class="visually-hidden">Commitment title</label>
        <input id="agenda-title-input" type="text" maxlength="160" placeholder="what needs doing">
        <label for="agenda-priority-select" class="visually-hidden">Priority</label>
        <select id="agenda-priority-select">
          <option value="critical">critical</option>
          <option value="high">high</option>
          <option value="normal" selected>normal</option>
          <option value="low">low</option>
        </select>
        <label for="agenda-category-select" class="visually-hidden">Category</label>
        <select id="agenda-category-select">
          <option value="commitment" selected>commitment</option>
          <option value="focus_block">focus block</option>
          <option value="follow_up">follow up</option>
          <option value="milestone">milestone</option>
        </select>
        <label for="agenda-link-input" class="visually-hidden">Linked artifact id</label>
        <input id="agenda-link-input" type="text" maxlength="120" placeholder="linked id (optional)">
        <button id="btn-agenda-create" type="button" class="small">Add commitment</button>
        <span id="agenda-add-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <ul id="briefing-agenda-list" class="work agenda-list"></ul>
      <h4 class="agenda-derived-heading">Readings from other stores</h4>
      <p class="meta">Each one is read from the store that holds it and is not written here. Resolve it at its source.</p>
      <ul id="briefing-derived-agenda-list" class="work agenda-derived-list"></ul>
    </section>
  </section>
  <section class="view" data-view="sentinel" data-depth-plane="z3"
         data-screen-id="sentinel"
         data-screen-message="Sentinel advisories and host readings: what the governor noticed, what it suppressed and why, from the observation ledger rather than from a claim.">
    <h2>Sentinel — recorded situational events</h2>
    <p class="meta">A bounded view of recorded observations, assessments, decisions and provenance. It does not imply that an external source is currently being watched.</p>
    <p id="sentinel-status" class="workspace-status" role="status" aria-live="polite">Loading situational records…</p>
    <ul id="sentinel-full" class="work"></ul>
    <!-- T-43 Package 3: the host telemetry. Ports and processes are read from the operating system
         in one pass, so a port table and a process table on this screen always describe the same
         instant. A wildcard bind is the only row that claims external reachability, and it is the one
         painted red: a loopback socket and a wide-open one look different because they are. -->
    <section class="panel" id="sentinel-telemetry-panel">
      <h3>Host telemetry — listening sockets and processes</h3>
      <p class="meta">Read from this machine: the socket tables via the operating system, and the process table via <code>ps</code> or <code>tasklist</code>. Command lines and environment variables are never read, so a credential in either cannot appear here.</p>
      <div class="row" id="telemetry-badge-row">
        <span id="telemetry-total-badge" class="badge" data-telemetry="total">TOTAL PORTS: —</span>
        <span id="telemetry-loopback-badge" class="badge" data-telemetry="loopback">LOOPBACK ONLY: —</span>
        <span id="telemetry-exposure-badge" class="badge" data-telemetry="exposure">EXTERNAL EXPOSURE: —</span>
        <span id="telemetry-rss-badge" class="badge" data-telemetry="rss">APEX RSS: —</span>
        <button id="btn-telemetry-refresh" type="button" class="small">Refresh telemetry</button>
      </div>
      <p id="telemetry-status" class="workspace-status" role="status" aria-live="polite">Loading host telemetry…</p>
      <h4>Listening sockets</h4>
      <table class="telemetry-table" aria-label="Listening sockets">
        <caption class="visually-hidden">Every listening TCP socket, its exposure and its owning process</caption>
        <thead><tr><th scope="col">port</th><th scope="col">proto</th><th scope="col">address</th><th scope="col">exposure</th><th scope="col">process</th></tr></thead>
        <tbody id="edith-port-table"></tbody>
      </table>
      <h4>Processes by resident memory</h4>
      <table class="telemetry-table" aria-label="Processes by resident memory">
        <caption class="visually-hidden">The processes using the most resident memory, and this process's own reading</caption>
        <thead><tr><th scope="col">pid</th><th scope="col">name</th><th scope="col">cpu</th><th scope="col">rss</th></tr></thead>
        <tbody id="edith-process-table"></tbody>
      </table>
      <p id="edith-process-summary" class="meta"></p>
    </section>
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
    <!-- T-45 Package 3: the configurable Sentinel watchpoints. A rule is a metric, an operator and a
         threshold; an evaluation measures the metric by running the capability that owns it and records
         the number it saw. Nothing fires when a threshold is crossed - a breach is a recorded fact, not a
         trigger, because a monitor that acted would be a standing order wearing a monitor's name. -->
    <section class="panel" id="sentinel-watchpoints-panel" data-depth-plane="z4" aria-labelledby="watchpoints-heading"
             aria-describedby="watchpoints-description">
      <h3 id="watchpoints-heading">Watchpoints — thresholds on live readings</h3>
      <p id="watchpoints-description" class="meta">A threshold you set on a number the machine already measures. An evaluation reads the live metric and records what it saw; a paused rule keeps its history and is skipped.</p>
      <p id="watchpoints-status" class="workspace-status" role="status" aria-live="polite">Loading the watchpoints…</p>
      <div id="watchpoints-summary-badges" class="badge-row" role="group" aria-label="Watchpoint summary">
        <span class="badge" data-watchpoint-badge="total">TOTAL WATCHPOINTS <span id="watchpoints-total-count">0</span></span>
        <span class="badge" data-watchpoint-badge="enabled">ENABLED <span id="watchpoints-enabled-count">0</span></span>
        <span class="badge" data-watchpoint-badge="breached">BREACHED <span id="watchpoints-breached-count">0</span></span>
        <span class="badge" data-watchpoint-badge="nominal">NOMINAL <span id="watchpoints-nominal-count">0</span></span>
      </div>
      <!-- No inline handler here: this deck's content policy allows scripts from this origin only, and
           form-action none already refuses a native submit. The Create button is type="button" and posts
           through the client, so pressing Return in a field cannot navigate anywhere and the form never
           needs to be suppressed. An onsubmit attribute would be blocked by the policy AND unnecessary. -->
      <form id="watchpoint-form" class="watchpoint-form">
        <label for="wp-title-input" class="visually-hidden">Watchpoint title</label>
        <input id="wp-title-input" type="text" maxlength="120" placeholder="what this rule watches for" autocomplete="off">
        <label for="wp-metric-select" class="visually-hidden">Metric</label>
        <select id="wp-metric-select">
          <option value="dirty_files_count">dirty files</option>
          <option value="external_ports_count">external ports</option>
          <option value="apex_rss_mb">APEX memory (MB)</option>
          <option value="overdue_commitments_count">overdue commitments</option>
        </select>
        <label for="wp-operator-select" class="visually-hidden">Operator</label>
        <select id="wp-operator-select">
          <option value="gt">greater than</option>
          <option value="gte">at least</option>
          <option value="eq">exactly</option>
        </select>
        <label for="wp-threshold-input" class="visually-hidden">Threshold</label>
        <input id="wp-threshold-input" type="number" step="1" min="0" value="0" inputmode="numeric">
        <label for="wp-severity-select" class="visually-hidden">Severity</label>
        <select id="wp-severity-select">
          <option value="advisory">advisory</option>
          <option value="warning">warning</option>
          <option value="critical">critical</option>
        </select>
        <button id="btn-wp-create" type="button" class="small">Create watchpoint</button>
        <button id="btn-wp-evaluate" type="button" class="small">Evaluate all</button>
      </form>
      <p id="wp-refusal" class="meta" role="alert" hidden></p>
      <p id="wp-eval-status" class="workspace-status" role="status" aria-live="polite"></p>
      <ul id="sentinel-watchpoints-list" class="work watchpoints-list"></ul>
    </section>
  </section>
  <section class="view" data-view="memory" data-depth-plane="z3"
         data-screen-id="memory-timeline"
         data-screen-message="The combined timeline of memory, knowledge and world-model records, corrections and lifecycle changes kept as provenance-linked history.">
    <h2>Memory Timeline</h2>
    <p class="meta">Chronological records from MemoryStore, KnowledgeStore and WorldModelStore. Corrections and lifecycle events are kept as provenance-linked history; the timeline does not make claims true.</p>
    <p id="timeline-status" class="workspace-status" role="status" aria-live="polite">Loading memory and world-model records…</p>
    <!-- T-38 Step 3 (2026-11-21): search across every ledger, and the causal chain inspector.
         A result is a record that exists; the chain is the records in time order with the link
         that joins each one named. Nothing here writes, and an absent ledger is reported as
         missing rather than shown as an empty step. -->
    <h3>Search every ledger</h3>
    <p class="meta">One query across memory, cognitive runs, Council sessions, task graphs, sandbox verifications and authorized operations. Each result names its ledger and the record it came from, and a result can be opened as a causal chain.</p>
    <form id="trace-search-form" class="row">
      <label for="trace-search-q" class="visually-hidden">Search terms</label>
      <input id="trace-search-q" type="search" maxlength="200" placeholder="Search terms">
      <label for="trace-search-kind" class="visually-hidden">Ledger</label>
      <select id="trace-search-kind">
        <option value="">every ledger</option>
        <option value="memory">memory</option>
        <option value="cognition_run">cognitive runs</option>
        <option value="council_session">Council sessions</option>
        <option value="task">task graphs</option>
        <option value="workshop_verification">sandbox verifications</option>
        <option value="workshop_apply">workspace changes</option>
        <option value="ecp_audit">authorized operations</option>
      </select>
      <label for="trace-search-status" class="visually-hidden">Epistemic status</label>
      <select id="trace-search-status">
        <option value="">any status</option>
        <option value="asserted">asserted</option>
        <option value="observed">observed</option>
        <option value="inferred">inferred</option>
        <option value="candidate_association">candidate association</option>
        <option value="model_output">model output</option>
        <option value="unverified">unverified</option>
        <option value="contradicted">contradicted</option>
      </select>
      <button id="trace-search-button" type="submit" class="small">Search</button>
      <span id="trace-search-statusline" class="meta" role="status" aria-live="polite"></span>
    </form>
    <ul id="trace-results" class="work"></ul>
    <h3>Causal chain</h3>
    <p id="trace-chain-status" class="workspace-status" role="status" aria-live="polite">Open a search result to read its chain.</p>
    <ol id="trace-chain" class="work"></ol>
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
  <section class="view" data-view="council" data-depth-plane="z3"
         data-screen-id="council"
         data-screen-message="Council deliberation and Track 2: deterministic perspectives over owned evidence beside the spiking substrate and its bridge, none of which authorizes execution.">
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
    <!-- T-37 Step 2: the deliberation's recommendation, and the one governed act it can lead to.
         Compiling is a real ECP-gated T-29 mission run, not a shortcut: the button names the same
         /api/cognition/run route the composer uses, and the answer below it is that run's record. -->
    <div class="row">
      <button id="council-compile" type="button" class="small" disabled>Compile to TaskGraph Mission</button>
      <span id="council-compile-status" class="meta" role="status" aria-live="polite">Deliberate first; the recommendation is what gets compiled.</span>
    </div>
    <div id="council-compile-result" class="panel"></div>
    <ul id="council" class="work"></ul>
    <!-- T-37 Step 1: Track 2. The eight-region spiking substrate and its bridge, read from the same
         service the capabilities step. Every number here is measured from the running substrate;
         when the service is absent the panel says so rather than showing zeroes. -->
    <h3>Track 2 — spiking substrate and neural-cognitive bridge</h3>
    <p class="meta">A deterministic 8-region LIF/STDP simulation with a versioned bridge to the symbolic pipeline. Its signals are candidate associations only: they cannot authorize an action, write an observed fact or bypass the ECP. The bridge isolates itself if a producer breaks that contract, and the run falls back to pure Track 1.</p>
    <p id="neural-status" class="workspace-status" role="status" aria-live="polite">Loading the neural substrate…</p>
    <div class="row">
      <label for="neural-steps" class="meta">Steps</label>
      <input id="neural-steps" class="narrow-input" type="number" min="1" max="64" value="16">
      <button id="neural-step" type="button" class="small">Advance substrate</button>
      <button id="neural-reset-bridge" type="button" class="small">Reset bridge</button>
      <span id="neural-action-status" class="meta" role="status"></span>
    </div>
    <dl id="neural-summary" class="facts"></dl>
    <table id="neural-regions" class="work" hidden>
      <caption class="meta">Per-region measured state</caption>
      <thead><tr><th scope="col">Region</th><th scope="col">Cells</th><th scope="col">Spikes</th><th scope="col">Active</th><th scope="col">Membrane</th><th scope="col">Mean weight</th><th scope="col">Fan-out</th></tr></thead>
      <tbody id="neural-region-rows"></tbody>
    </table>
    <div id="neural-bridge" class="panel"></div>
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
  <section class="view" data-view="presence" data-depth-plane="z3"
         data-screen-id="presence-mesh"
         data-screen-message="Presence, device trust and the autonomy matrix: which devices are enrolled, which work can be handed off, and what each domain is permitted to do without asking.">
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
  <section class="view" data-view="system" data-depth-plane="z3"
         data-screen-id="policy-autonomy"
         data-screen-message="System health, the doctor and the safety latch: six read-only checks, the ECP authority, and the lockdown form that requires a typed reason and an explicit confirmation.">
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
    <section class="panel safety" data-depth-plane="z4" aria-labelledby="safety-heading"
             data-screen-id="lockdown"
             data-screen-message="The execution safety latch: activating it requires a typed reason, releasing it requires the reason, an explicit confirmation and the step-up secret when one is configured.">
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
    <!-- T-44 Package 1: the governed standing orders. The policy select is built from the server's own
         allowedCapabilities list, so the set of things that CAN be delegated is visible rather than
         implied by what is missing from a list someone typed here. Every button on a card goes through
         the ECP. -->
    <section class="panel" id="standing-orders-panel" data-depth-plane="z4" aria-labelledby="standing-orders-heading"
             aria-describedby="standing-orders-description">
      <h3 id="standing-orders-heading">Standing orders</h3>
      <p id="standing-orders-description" class="meta">A bounded delegation of one reversible local_state capability to one event. Nothing workspace-mutating, irreversible, security-relevant or system-wide can be delegated, and Lockdown halts every order.</p>
      <p id="so-status" class="workspace-status" role="status" aria-live="polite">Loading the standing orders…</p>
      <div id="so-summary-badges" class="badge-row" role="group" aria-label="Standing order summary">
        <span class="badge" data-so-badge="total">TOTAL ORDERS <span id="so-total-count">0</span></span>
        <span class="badge" data-so-badge="enabled">ENABLED <span id="so-enabled-count">0</span></span>
        <span class="badge" data-so-badge="runs">TOTAL RUNS <span id="so-runs-count">0</span></span>
        <span class="badge" data-so-badge="lockdown">LOCKDOWN STATUS <span id="so-lockdown-status">—</span></span>
      </div>
      <p class="meta">A standing order may only carry a capability that declares itself reversible with a local_state blast radius. It runs with nobody present, so nothing that writes the workspace, moves the safety latch or cannot be undone may ever be delegated.</p>
      <div class="so-add">
        <label for="so-title-input" class="visually-hidden">Standing order title</label>
        <input id="so-title-input" type="text" maxlength="120" placeholder="what this order is for">
        <label for="so-trigger-select" class="visually-hidden">Trigger event</label>
        <select id="so-trigger-select">
          <option value="workspace_dirty">workspace_dirty</option>
          <option value="load_pressure">load_pressure</option>
          <option value="storage_pressure">storage_pressure</option>
          <option value="drift_detected">drift_detected</option>
          <option value="session_start">session_start</option>
          <option value="manual_invoke" selected>manual_invoke</option>
        </select>
        <label for="so-capability-select" class="visually-hidden">Delegated capability</label>
        <select id="so-capability-select"></select>
        <button id="btn-so-create" type="button" class="small">Create standing order</button>
        <span id="so-create-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <p id="so-create-refusal" class="meta" role="alert" hidden></p>
      <ul id="standing-orders-list" class="work so-list"></ul>
      <div class="so-eval">
        <label for="so-eval-trigger-select" class="visually-hidden">Event to evaluate</label>
        <select id="so-eval-trigger-select">
          <option value="workspace_dirty">workspace_dirty</option>
          <option value="load_pressure">load_pressure</option>
          <option value="storage_pressure">storage_pressure</option>
          <option value="drift_detected">drift_detected</option>
          <option value="session_start">session_start</option>
          <option value="manual_invoke">manual_invoke</option>
        </select>
        <button id="btn-so-evaluate" type="button" class="small">Evaluate this event</button>
        <button id="btn-so-evaluate-dirty" type="button" class="small">Evaluate workspace_dirty</button>
        <span id="so-eval-status" class="meta" role="status" aria-live="polite"></span>
      </div>
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
  <section class="view" data-view="integrations" data-depth-plane="z3"
>
    <h2>Integrations</h2>
    <p id="integrations-status" class="workspace-status" role="status" aria-live="polite">Loading integration state…</p>
    <ul id="integrations" class="work"></ul>
  </section>
  <section class="view" data-view="workshop" data-depth-plane="z3"
         data-screen-id="workshop"
         data-screen-message="The workshop: user-authored sheets with their components and declared numbers, inspected and simulated deterministically; a sheet authorizes nothing.">
    <h2>Workshop — deterministic design sheets</h2>
    <p class="meta">This is not a 3D or interactive holographic workspace. It stores design sheets and performs arithmetic over declared values. Nothing here is executed, and a simulation never authorizes an action.</p>
    <!-- T-38 Step 2 (2026-11-21): the real file inspector and its sandbox. Every value here comes from
         a backend reading of the tree - bytes, line counts, SHA-256, and the parser's own verdict and
         message. A candidate shows "verified" only when the backend recorded verified: true, and a
         promotion is refused by the backend, not by this markup. -->
    <h3>The workspace</h3>
    <p class="meta">These are the real files under the configured workspace root. A path outside that root is refused by the backend, so an entry that appears here is one the backend agreed to read. Nothing on this panel writes the live tree.</p>
    <div class="row">
      <button id="ws-refresh" type="button" class="small">Inspect workspace</button>
      <span id="ws-state" class="meta" role="status" aria-live="polite">Not inspected yet.</span>
    </div>
    <ul id="ws-entries" class="work"></ul>
    <div id="ws-excerpt-panel" class="panel" hidden>
      <h4 id="ws-excerpt-title" class="meta"></h4>
      <pre id="ws-excerpt" class="code"></pre>
    </div>
    <h4>Stage a candidate</h4>
    <p class="meta">Staging copies your proposed content into a sandbox under the APEX data directory. It does not touch the file you name. Verifying runs the real parser against the staged copy; promoting is refused unless that check passed.</p>
    <form id="ws-stage-form" class="row">
      <label for="ws-stage-path" class="visually-hidden">Relative path inside the workspace</label>
      <input id="ws-stage-path" maxlength="400" placeholder="src/example.js">
      <label for="ws-stage-rationale" class="visually-hidden">Why this change</label>
      <input id="ws-stage-rationale" maxlength="240" placeholder="rationale (optional)">
      <button id="ws-stage-submit" type="submit" class="small">Stage candidate</button>
      <span id="ws-stage-status" class="meta" role="status" aria-live="polite"></span>
    </form>
    <label for="ws-stage-content" class="visually-hidden">Proposed content</label>
    <textarea id="ws-stage-content" rows="6" placeholder="the proposed content of the file"></textarea>
    <!-- T-41 Step 2: an optional companion test. It runs under the real node:test runner inside the
         candidate's sandbox during verification; it is never applied to the workspace. Leaving it
         empty is honest - verification then measures parsing only, and says so. -->
    <label for="ws-stage-test" class="visually-hidden">Companion test (optional)</label>
    <textarea id="ws-stage-test" rows="4" placeholder="optional companion test (node:test) — runs in the sandbox, never applied"></textarea>
    <ul id="ws-candidates" class="work"></ul>
    <!-- T-40 Step 1 and 2: the live disk check, the all-or-nothing changeset controls, and the list of
         applied changesets. A checkbox selects a verified candidate for the batch; the Apply Changeset
         button is enabled only when the selection holds at least two, because that is what the backend
         will accept and a button that can only be refused teaches the owner to distrust refusals. -->
    <div class="row">
      <button id="ws-check-disk" type="button" class="small">Check Disk Status</button>
      <span id="ws-disk-state" class="meta" role="status" aria-live="polite">The disk has not been re-read in this page yet.</span>
    </div>
    <ul id="ws-disk-status" class="work"></ul>
    <div class="row">
      <label for="ws-changeset-title" class="visually-hidden">Changeset title</label>
      <input id="ws-changeset-title" maxlength="160" placeholder="changeset title">
      <button id="ws-apply-changeset" type="button" class="small" disabled>Apply Changeset</button>
      <span id="ws-changeset-state" class="meta" role="status" aria-live="polite">Select two or more verified candidates to apply them as one change.</span>
    </div>
    <p class="meta">A changeset writes every selected file or none of them. Before the first byte is written the backend re-checks each candidate and the file it targets; if any single one fails, the whole batch is refused and nothing on disk changes. The previous bytes of every file are saved together under the changeset id, so the batch can be rolled back as a batch.</p>
    <ul id="ws-changesets" class="work"></ul>
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
    <!-- T-43 Package 3: the git executive. The panel reads the repository the way the engine
         reads it, and the two write controls are the owner's: a checkpoint is a record of the tree as
         it is, and a restore is refused when it would discard work that is not already recorded. -->
    <section class="panel" id="workshop-git-panel">
      <h3>Repository — the workspace as git sees it</h3>
      <p class="meta">Read from the repository at the configured workspace root. A checkpoint records the tracked and untracked state without touching the working tree; a restore refuses when it would discard uncommitted work.</p>
      <p id="git-status-text" class="workspace-status" role="status" aria-live="polite">Loading the repository…</p>
      <div class="row" id="git-badge-row">
        <span id="git-branch-badge" class="badge" data-git="branch">branch: —</span>
        <span id="git-head-badge" class="badge" data-git="head">HEAD: —</span>
        <span id="git-staged-badge" class="badge" data-git="staged">staged: —</span>
        <span id="git-unstaged-badge" class="badge" data-git="unstaged">unstaged: —</span>
        <span id="git-untracked-badge" class="badge" data-git="untracked">untracked: —</span>
        <span id="git-checkpoints-badge" class="badge" data-git="checkpoints">checkpoints: —</span>
        <button id="btn-git-refresh" type="button" class="small">Refresh</button>
      </div>
      <div class="row">
        <label for="git-diff-path-input" class="visually-hidden">Path to inspect inside the workspace</label>
        <input id="git-diff-path-input" maxlength="400" placeholder="path inside the workspace (optional)">
        <button id="btn-git-diff-inspect" type="button" class="small">Inspect diff</button>
        <span id="git-diff-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <!-- T-43 Package 3: the diff viewer. The old and new line numbers are their own columns rather
           than part of the text, so a wrapped line cannot shift the numbering, and the tints are the
           two tokens the deck already uses for "this arrived" and "this was removed". -->
      <div id="workshop-diff-viewer" class="diff-viewer" role="region" aria-label="Workspace diff" hidden>
        <div class="diff-head">
          <span id="diff-file-header" class="diff-file">no file selected</span>
          <span id="diff-additions-badge" class="badge diff-add">+0</span>
          <span id="diff-deletions-badge" class="badge diff-del">-0</span>
          <span id="diff-hunks-badge" class="badge">0 hunk(s)</span>
        </div>
        <table class="diff-table">
          <caption class="visually-hidden">Unified diff with old and new line numbers</caption>
          <thead><tr><th scope="col">old</th><th scope="col">new</th><th scope="col">line</th></tr></thead>
          <tbody id="diff-body"></tbody>
        </table>
      </div>
      <div class="row">
        <label for="git-checkpoint-label-input" class="visually-hidden">Checkpoint label</label>
        <input id="git-checkpoint-label-input" maxlength="120" placeholder="checkpoint label">
        <button id="btn-git-checkpoint-create" type="button" class="small">Create checkpoint</button>
        <span id="git-checkpoint-status" class="meta" role="status" aria-live="polite"></span>
      </div>
      <p id="git-checkpoint-refusal" class="meta" role="alert" hidden></p>
      <ul id="workshop-checkpoints-list" class="work"></ul>
    </section>
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
      <!-- T-41 Step 3: a proposal may describe a file change. The target is checked against the
           immutable governance boundary when the proposal is recorded, and a target on that boundary
           is refused with IMMUTABLE_GOVERNANCE_BOUNDARY before anything is staged. -->
      <label for="evolution-target" class="visually-hidden">Target path inside the workspace</label>
      <input id="evolution-target" maxlength="400" placeholder="target path, e.g. src/greeting.js (optional)">
      <button id="evolution-propose" type="submit" class="small">Record proposal</button>
      <span id="evolution-form-status" class="meta" role="status" aria-live="polite"></span>
    </form>
    <label for="evolution-content" class="visually-hidden">Proposed content for the target</label>
    <textarea id="evolution-content" rows="4" placeholder="proposed content for the target (optional)"></textarea>
    <label for="evolution-test" class="visually-hidden">Companion test for the proposal</label>
    <textarea id="evolution-test" rows="3" placeholder="optional companion test (node:test) that runs in the sandbox"></textarea>
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
/* T-37 Step 4 (2026-11-21): the depth planes are translated by a fractional parallax offset, and a
   z1 plane the full width of the page therefore ends a sub-pixel past the viewport - which widens
   the document by 1-2 px and lets the page scroll sideways. An overflow-x: hidden on the body cannot
   stop that, because the viewport's scrollbox is propagated from the root element and not the body.
   Clipping on the root is what makes the guarantee true; clip is used where it is supported because
   it does not create a scroll container, so it cannot disturb a sticky topbar. */
html { overflow-x: hidden; }
@supports (overflow: clip) { html { overflow-x: clip; } }
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
/* T-40 Step 3: the command reference. It is a flex child of the command bar, so it takes a full row
   rather than being squeezed beside the input, and every cell wraps so a long route name cannot widen
   the page. */
.hud-help { flex: 1 1 100%; max-width: 100%; min-width: 0; }
.hud-help h3, .hud-help h4 { margin: 0 0 .4rem 0; }
.hud-help-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.hud-help-table th, .hud-help-table td {
  text-align: left; vertical-align: top; padding: .3rem .45rem;
  border-bottom: 1px solid var(--line); overflow-wrap: anywhere; word-break: break-word;
}
.hud-help-table th { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.hud-help-table th:first-child, .hud-help-table td:first-child { width: 30%; }
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
/* T-37 Step 1: a numeric field that should not stretch the row. Declared here rather than inline,
   because the shipped Content-Security-Policy serves style-src 'self' and blocks inline styles -
   an inline style attribute is a console error in every browser suite. */
.narrow-input { max-width: 6rem; }
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

/* T-43 Package 3: the git diff viewer and the host telemetry tables.
   Two rules govern every value below.
   1. No horizontal overflow. The tables scroll inside their own box rather than widening the page,
      and every cell wraps rather than pushes. The end-to-end suite measures scrollWidth against
      clientWidth on all eleven screens at three viewports, so a rule that breaks this is a failing
      test rather than a screenshot nobody looks at.
   2. Contrast. The add and delete tints are dark enough that --text, --ok-green and
      --armor-red-text each clear 4.5:1 against them (measured: 12.75, 11.57 and 6.43), so the colour
      is never the only thing carrying the meaning: the +/- glyph in the old/new gutter says the same
      thing for a reader who cannot see the tint. */
.diff-viewer { border: 1px solid var(--line); background: rgba(0,0,0,0.28); margin: .6rem 0; max-width: 100%; overflow-x: auto; }
.diff-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; padding: .45rem .6rem; border-bottom: 1px solid var(--line); }
.diff-file { font-family: var(--font-mono); font-size: .8rem; color: var(--cyan); overflow-wrap: anywhere; }
.badge.diff-add { color: var(--ok-green); border-color: rgba(43,255,136,0.35); }
.badge.diff-del { color: var(--armor-red-text); border-color: rgba(255,107,90,0.35); }
.diff-table, .telemetry-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: .78rem; table-layout: fixed; }
.diff-table th, .telemetry-table th { text-align: left; font-weight: 600; color: var(--muted); padding: .25rem .4rem; border-bottom: 1px solid var(--line); }
.diff-table td, .telemetry-table td { padding: .18rem .4rem; vertical-align: top; overflow-wrap: anywhere; }
.diff-table col { }
.diff-table th:nth-child(1), .diff-table td:nth-child(1),
.diff-table th:nth-child(2), .diff-table td:nth-child(2) { width: 3.2rem; text-align: right; color: var(--muted); }
.diff-line-ctx td { color: var(--text); }
.diff-line-add { background: rgba(43,255,136,0.10); }
.diff-line-add td { color: var(--text); }
.diff-line-del { background: rgba(255,107,90,0.10); }
.diff-line-del td { color: var(--text); }
.diff-gutter-add { color: var(--ok-green); }
.diff-gutter-del { color: var(--armor-red-text); }
.telemetry-table th:nth-child(1), .telemetry-table td:nth-child(1) { width: 4.5rem; }
.telemetry-table th:nth-child(2), .telemetry-table td:nth-child(2) { width: 4.5rem; }
.exposure-loopback { color: var(--ok-green); }
.exposure-wildcard { color: var(--armor-red-text); }
.exposure-external { color: var(--gold); }
.table-scroll { max-width: 100%; overflow-x: auto; }
#workshop-checkpoints-list li { display: grid; gap: .2rem; }
.checkpoint-ref-intact { color: var(--ok-green); }
.checkpoint-ref-drift { color: var(--armor-red-text); }
@media (max-width: 720px) {
  .diff-table th:nth-child(1), .diff-table td:nth-child(1),
  .diff-table th:nth-child(2), .diff-table td:nth-child(2) { width: 2.4rem; }
  .telemetry-table th:nth-child(2), .telemetry-table td:nth-child(2) { width: 3.4rem; }
  /* T-46 STEP 1: the phone. A layout of its own rather than the desktop one narrowed: the Core is the
     first thing in the deck, the cards stack under it full width, the command bar is docked to the
     bottom edge, and the navigation becomes a bottom bar of its own. */
  body[data-layout="mobile"] .topbar { height: 56px; min-height: 56px; max-height: 56px; padding: 0 .6rem; grid-template-columns: auto 1fr auto; gap: .4rem; }
  body[data-layout="mobile"] .topbar h1 { font-size: .9rem; letter-spacing: .16em; }
  body[data-layout="mobile"] .topbar-meta { gap: .25rem; }
  body[data-layout="mobile"] .strip-item { padding: .05rem .28rem; }
  body[data-layout="mobile"] .strip-key { display: none; }
  body[data-layout="mobile"] .topbar .badge, body[data-layout="mobile"] .topbar .meta { font-size: .62rem; }
  body[data-layout="mobile"] #mode { display: none; }
  body[data-layout="mobile"] .topbar-actions .quiet.small { display: none; }
  body[data-layout="mobile"] .shell, body[data-layout="mobile"] .workspace { flex-direction: column; }
  body[data-layout="mobile"] .deck {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    gap: .5rem;
    padding: .5rem .55rem .6rem;
    overflow-y: auto;
  }
  body[data-layout="mobile"] .stage {
    order: -2;
    grid-template-rows: auto auto auto;
    overflow: visible;
    padding: .4rem;
  }
  body[data-layout="mobile"] .core { width: min(62vw, 15rem); }
  body[data-layout="mobile"] .core-wrap { order: -2; }
  body[data-layout="mobile"] .rail {
    order: 1;
    grid-auto-rows: auto;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    overflow: visible;
  }
  body[data-layout="mobile"] .rail .panel { overflow: visible; }
  body[data-layout="mobile"] .stage > #exec-comms-panel,
  body[data-layout="mobile"] .stage > #conversation-panel { max-height: none; }
  /* The command bar is the last thing in the shell and stays on the bottom edge. */
  body[data-layout="mobile"] .command-bar { order: 4; padding: .35rem .55rem; }
  body[data-layout="mobile"] .command-bar #chat-text { min-height: 1.9rem; }
  /* The navigation is a bottom bar: one row, its own scroll for the fifteen workspaces. The deck is
     ordered FIRST and its stage above the rails, so the Core is the first thing in the deck - the
     order:-2 on .stage and .core-wrap above is what does that; this only keeps the deck before the
     bar and the navigation. */
  body[data-layout="mobile"] .shell > .deck { order: 1; }
  body[data-layout="mobile"] nav.nav { order: 5; }
  /* The rails stack in one column: two of them side by side at 390px would be 180px each, and their
     headings would wrap to three lines. */
  body[data-layout="mobile"] .rail { grid-template-columns: minmax(0, 1fr); }
  /* The measures popover is a bottom sheet on a phone, because a 34rem panel at the top right of a
     390px screen is a panel with its content off the edge. */
  body[data-layout="mobile"] .measures-panel {
    left: .4rem; right: .4rem; top: auto; bottom: .4rem;
    width: auto; max-height: 70vh; overflow-y: auto;
  }
  /* The bar and the navigation are the last two children of the shell, so they sit on the bottom edge
     of a shell that is exactly one viewport tall - without position:fixed. That matters: a fixed bar
     paints over whatever is under it, and "fits the viewport" would then be true and a lie at once.
     Everything is in flow, so the deck's own scroll region ends at the bar rather than under it. */
  body[data-layout="mobile"] nav.nav {
    order: 4;
    flex: 0 0 auto;
    padding: .3rem .4rem; gap: .25rem;
    background: rgba(5, 8, 15, 0.97); border-top: 1px solid var(--line-strong); border-bottom: 0;
  }
  body[data-layout="mobile"] nav.nav .nav-item { font-size: .68rem; padding: .3rem .45rem; }
  body[data-layout="mobile"] .command-bar { order: 4; }
}
.panel pre, .item pre { max-width: 100%; overflow-x: auto; }
/* ============================================================================================
   T-46 STEP 1 (2026-11-19): the shell, the one-band header, and the deck that fits a viewport.
   --------------------------------------------------------------------------------------------
   The review that opened this milestone found three things by looking at the product:
     * the header wrapped into several rows, because nine badges and eleven controls lived in it;
     * the Core sat in the middle column of a three-column grid at a fixed 260px, so it was neither
       centred nor the largest thing on the screen;
     * the command bar sat AFTER the deck in document order, so typing meant scrolling past every
       panel.
   The fix is a shell: the document does not scroll, the header and the command bar are docked, and
   the workspace band between them is the one scroll container. Nothing is hidden to make it fit -
   panels are required to scroll INSIDE themselves by the spec, and a panel that clipped its content
   with no way to reach it is a measured failure: the panel rules never set overflow:hidden.
   ============================================================================================ */

/* The document is exactly one viewport tall and is not a scroll container. This is the one place the
   milestone uses overflow:hidden, and it is safe because the band below is a real scroll region: no
   content is unreachable, it is one scroll inside a different element. */
html, body { height: 100%; overflow: hidden; }
body { display: flex; flex-direction: column; min-height: 0; }

/* The shell holds the navigation, the command strip and the deck; the workspace views are its
   siblings. Both scroll the same way, so switching between Deck and System does not change the shape
   of the screen. */
.shell > nav.nav { order: 1; }
.shell > .deck { order: 2; }
.shell > .command-bar { order: 3; }
.shell, .workspace {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

/* ---------------------------------------------------------------- the header: one 64px band --- */
.topbar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: .75rem;
  align-items: center;
  flex: 0 0 auto;
  height: 64px;
  min-height: 64px;
  max-height: 64px;
  padding: 0 1rem 0 1.1rem;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: rgba(5, 8, 15, 0.86);
  backdrop-filter: blur(14px);
}
.topbar h1 { font-size: 1.05rem; letter-spacing: .22em; line-height: 1; }
.topbar .sub { display: none; }
.brand { gap: .6rem; }
.brand-mark { width: 1.9rem; height: 1.9rem; font-size: .95rem; }
.topbar-meta, .topbar-actions { flex-wrap: nowrap; gap: .4rem; min-width: 0; }
.topbar-meta { justify-content: center; }
.topbar-actions { justify-content: flex-end; }
.topbar .meta, .topbar .badge { font-size: .7rem; padding: .1rem .45rem; white-space: nowrap; }
.topbar select.small, .topbar .quiet.small, .topbar .hud-chip { font-size: .7rem; padding: .18rem .5rem; }
.topbar .hud-chip kbd { display: none; }

/* The compact strip: five readings, each a key and a value, in one line. The values are written by
   syncHeaderStrip() from the same render pass that writes the panel each number came from. */
.strip-item {
  display: inline-flex; gap: .3rem; align-items: baseline; white-space: nowrap;
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: .1rem .4rem; background: rgba(0, 0, 0, .28);
}
.strip-key { font-family: var(--font-mono); font-size: .62rem; letter-spacing: .09em; color: var(--muted); }
.strip-value { font-family: var(--font-mono); font-size: .72rem; color: var(--text); font-variant-numeric: tabular-nums; }
.strip-value[data-core="idle"] { color: var(--green); }
.strip-value[data-core="lockdown"] { color: var(--armor-red-text); }
.strip-value[data-core="degraded"], .strip-value[data-core="uncertain"] { color: var(--gold); }
.strip-value[data-latch="active"] { color: var(--armor-red-text); }
.strip-value[data-count="some"] { color: var(--gold); }

/* ---------------------------------------------------------------- the measures popover --------- */
.measures-panel {
  position: fixed;
  top: 68px;
  right: 1rem;
  z-index: 45;
  width: min(34rem, calc(100vw - 2rem));
  display: grid;
  gap: .6rem;
  padding: .8rem .9rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: rgba(8, 15, 27, 0.97);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}
.measures-panel[hidden] { display: none; }
.measures-title { margin: 0; font-family: var(--font-display); font-size: .82rem; letter-spacing: .14em; text-transform: uppercase; color: var(--text); }
.measures-hint { font-family: var(--font-body); font-size: .68rem; letter-spacing: 0; text-transform: none; color: var(--muted); margin-left: .5rem; }
.measures-group { display: grid; gap: .3rem; }
.measures-key { margin: 0; font-family: var(--font-mono); font-size: .6rem; letter-spacing: .12em; color: var(--muted); text-transform: uppercase; }
.measures-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }

/* ---------------------------------------------------------------- the deck ---------------------------------- */
.deck {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.9fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: .65rem;
  padding: .65rem .9rem .7rem;
  align-items: stretch;
  min-height: 0;
  flex: 1 1 auto;
  /* The deck fills the band exactly. A deck taller than the band scrolls the band, which the spec
     measures: the deck itself must not exceed one viewport. */
  overflow: hidden;
}
.stage {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: .5rem;
  min-height: 0;
  min-width: 0;
  padding: .5rem;
  overflow: hidden;
}
/* The Core leads. It takes the stage's spare vertical space, and it is bounded by the SHORTER of the
   two dimensions the stage offers, so on a laptop it cannot push the panels below the fold. */
.core-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: .35rem;
  padding: .2rem;
  min-height: 0;
  overflow: hidden;
}
.core {
  width: min(34rem, 100%, calc(var(--core-fit, 24rem) * 1px));
  height: auto;
  filter: drop-shadow(0 0 18px rgba(0, 229, 255, 0.25));
}
.core-state { font-size: 1.15rem; }
.core-caption { max-width: 34rem; text-align: center; margin: 0; }
.stage > #exec-comms-panel, .stage > #conversation-panel { overflow-y: auto; max-height: 22vh; }

/* The rails are columns of panels beside the Core. Each panel scrolls inside itself, so a rail never
   grows the band and never hides its last row. */
.rail {
  display: grid;
  grid-auto-rows: minmax(0, 1fr);
  gap: .6rem;
  min-height: 0;
  min-width: 0;
  padding: 0;
  align-content: stretch;
  /* T-46 STEP 1: the RAIL scrolls. A column of two panels - two active missions and a task graph - is
     720px of content in a 720px column, and overflow:hidden here clipped 24 elements the owner could
     not reach. The rail is the scroll container and each panel keeps its own; both are measured. */
  overflow-y: auto;
  overflow-x: hidden;
}
.rail .panel { overflow-y: auto; min-height: 0; }
.deck .panel { padding: .6rem .7rem; }
.deck .panel h2 { font-size: .82rem; }
.deck .panel li { font-size: .74rem; }

/* ---------------------------------------------------------------- the command bar, docked ----- */
.command-bar {
  flex: 0 0 auto;
  order: 3;
  flex-wrap: nowrap;
  align-items: center;
  gap: .5rem;
  padding: .4rem .9rem;
  border-top: 1px solid var(--line);
  border-bottom: 0;
  background: rgba(5, 8, 15, 0.92);
  backdrop-filter: blur(14px);
}
.command-bar #chat-text { min-height: 2.1rem; max-height: 4.5rem; }
.command-bar #activity, .command-bar #dispatch-receipt { font-size: .7rem; }

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
/* T-46 STEP 1 (2026-11-19): the reticle takes the space its stage actually has, so the Core leads the
   deck instead of sitting in it at a fixed 260px. --core-fit is measured by the client from the stage's
   own box (see measureCoreFit); the 24rem fallback is what a page with no client still gets.
   The square is kept by bounding the WIDTH. An earlier version of this rule also capped max-height,
   which squashed the 260px-wide box to 144px tall and made the reticle a rectangle - the T-32 walk
   caught it ("the reticle is square at desktop: Expected 144 Received 260"), which is exactly what
   that assertion is for. */
#core-reticle {
  width: min(34rem, 100%, calc(var(--core-fit, 24rem) * 1px));
  /* T-46 STEP 1: the reticle is a flex item of .core-wrap, and a column flex item's automatic minimum
     is content-based - so with height: auto the box took the WIDTH it had been given (357px) as its
     height and stopped being square. It is its own size now: flex-shrink 0, an explicit 1/1, and
     height:auto derived from the width by aspect-ratio. The width is the only thing that varies. */
  flex: 0 0 auto;
  aspect-ratio: 1 / 1;
  height: auto;
  min-height: 0;
  transition: filter var(--motion-posture) ease;
}
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
  /* T-46 STEP 1: the columns are proportional, not minimum-width. A minmax(16rem, ...) column on a
     1600px deck is 256px of rail whatever the Core needs; the Core's own fit rule does the sizing. */
  .deck { grid-template-columns: minmax(0, 1fr) minmax(0, 1.9fr) minmax(0, 1fr); }
}
@media (max-width: 1280px) {
  /* T-46 STEP 1: no bottom padding and no minimum rail widths. The 6rem pad existed to clear the
     command bar when the bar was a static block at the end of the document; the bar is docked now, so
     the pad was 96px of empty page below the last panel and one of the reasons the deck scrolled. */
  .deck { gap: .55rem; padding: .55rem .7rem .6rem; }
  .topbar { gap: .5rem; padding: 0 .7rem 0 .8rem; }
  .topbar .meta, .topbar .badge { font-size: .66rem; padding: .1rem .38rem; }
  .strip-key { font-size: .58rem; }
  .strip-value { font-size: .68rem; }
}
@media (max-width: 1100px) {
  /* T-46 STEP 1: the intermediate band. The deck still does not scroll the document - the band
     scrolls - but its panels stack, so nothing is 110px wide. The Core keeps its place at the top. */
  .deck { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; overflow-y: auto; }
  .core-wrap { order: -1; }
  .stream, .rail { grid-auto-rows: auto; overflow: visible; }
  .rail { grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
  .rail .panel { overflow: visible; }
  .stage { overflow: visible; }
  .stage > #exec-comms-panel, .stage > #conversation-panel { max-height: none; }
}
@media (max-width: 720px) {
  .topbar { grid-template-columns: 1fr; }
  .nav { flex-wrap: wrap; }
  .workspace { padding: 0 .75rem 2rem; }
}
@media (max-width: 480px) {
  /* T-46 STEP 1: the old 4rem bottom pad and the full-width meta row are gone with the static
     command bar. The phone layout is declared once, at 720px, by body[data-layout="mobile"]. */
  body:not([data-layout="mobile"]) .deck { padding: .6rem .5rem; }
  body:not([data-layout="mobile"]) .topbar { padding: 0 .5rem; }
  h1 { font-size: 1.05rem; }
}
.boot {
  position: fixed; inset: 0; z-index: 50; background: rgba(5,8,15,0.96);
  display: grid; place-items: center; gap: 1rem; padding: 2rem;
}
.boot.hidden { display: none; }
.boot-core { width: 90px; height: 90px; border-radius: 50%; border: 2px solid var(--cyan); box-shadow: 0 0 30px rgba(0,229,255,0.4); animation: spin 6s linear infinite; }
.boot-lines { font-family: var(--font-mono); color: var(--muted); max-width: 36rem; width: 100%; }
.boot-lines div { padding: .2rem 0; }

/* T-36 Step 2 (2026-11-21): the boot sequence panel. It is deliberately NOT a full-screen
   blocker: the backdrop takes no pointer events and the panel sits in the lower-left corner, so
   the emergency controls above it stay clickable while the machine wakes. The hidden attribute is
   used rather than a class, so the element is out of the tab order entirely while it is away. */
.hud-boot {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  display: flex; align-items: flex-end; justify-content: flex-start;
  padding: 1.25rem;
}
.hud-boot[hidden] { display: none; }
.hud-boot-panel {
  pointer-events: auto;
  background: rgba(9, 16, 28, 0.96);
  border: 1px solid rgba(0, 229, 255, 0.35);
  border-radius: 4px;
  padding: 1rem 1.25rem;
  max-width: 34rem;
  width: 100%;
  box-shadow: 0 0 24px rgba(0, 0, 0, 0.55);
}
.hud-boot-message { font-family: var(--font-mono); color: var(--cyan); letter-spacing: .04em; margin: 0 0 .6rem; }
.hud-boot-steps { list-style: none; margin: 0 0 .75rem; padding: 0; font-family: var(--font-mono); font-size: .82rem; }
.hud-boot-steps li { display: flex; gap: .6rem; align-items: baseline; padding: .16rem 0; color: var(--muted); }
.hud-boot-steps li[data-boot-state="ok"] { color: var(--text); }
.hud-boot-steps li[data-boot-state="degraded"] { color: var(--gold); }
.hud-boot-steps li[data-boot-state="failed"] { color: var(--red); }
.hud-boot-steps li[data-boot-state="unavailable"] { color: var(--text-dim); }
.hud-boot-steps li .boot-step-label { min-width: 11rem; }
.hud-boot-steps li .boot-step-detail { flex: 1; }
@media (prefers-reduced-motion: reduce) {
  .hud-boot-panel { transition: none !important; animation: none !important; }
}

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
/* T-44 Packages 1 and 2: the standing-orders panel and the executive agenda.
   Every colour here is a token that already existed, and every red label uses --armor-red-text rather
   than --armor-red: the solid red is a fill for a bar, and as text on the void it measures 4.03:1, which
   is below the 4.5 the deck holds itself to. The text variant measures 5.94:1. */
/* A command that lands on a panel already on screen has to show that something answered. An outline
   rather than a transform, so the pulse cannot shift a single pixel of layout. */
[data-focus-pulse="on"] { outline: 2px solid var(--arc-cyan); outline-offset: 2px; }
.badge-row { display: flex; flex-wrap: wrap; gap: .4rem; margin: .5rem 0 .7rem; }
.badge-row .badge { border: 1px solid var(--line); padding: .15rem .45rem; }
.so-add, .so-eval, .agenda-add { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .4rem 0; }
.so-add input, .agenda-add input { min-width: 12rem; }
/* A card in a grid track wider than its content is the one way a card can push the page sideways: an
   order id or a capability name has no spaces to break at, so it is allowed to break anywhere rather
   than overflow. min-width:0 on the grid children is what lets the wrap actually take effect. */
.so-list li, .agenda-list li, .agenda-derived-list li { min-width: 0; }
.so-list, .agenda-list, .agenda-derived-list { min-width: 0; max-width: 100%; }
.so-id, .so-title, .so-badge, .agenda-id, .agenda-title, .agenda-badge, .agenda-link {
  overflow-wrap: anywhere; word-break: break-word; max-width: 100%;
}
.so-list li, .agenda-list li { display: grid; gap: .25rem; border-left: 2px solid var(--line); padding-left: .55rem; }
.so-card { border-left-color: var(--line-strong); }
.so-list .so-card[data-enabled="false"] { border-left-color: var(--armor-gold); }
.so-halted { border-left-color: var(--armor-red-text) !important; }
.so-head, .agenda-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; }
.so-title, .agenda-title { color: var(--text); font-weight: 600; }
.so-row, .agenda-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.so-id, .agenda-id { color: var(--text-dim); font-size: .78rem; letter-spacing: .04em; }
.so-badge, .agenda-badge { color: var(--text); background: rgba(0, 0, 0, .25); border: 1px solid var(--line); padding: .1rem .4rem; }
.so-badge--enabled, .agenda-badge--completed { color: var(--ok-green); border-color: var(--ok-green); }
.so-badge--paused { color: var(--armor-gold); border-color: var(--armor-gold); }
.so-badge--halted, .agenda-badge--overdue { color: var(--armor-red-text); border-color: var(--armor-red-text); }
.agenda-badge--today { color: var(--armor-gold); border-color: var(--armor-gold); }
.agenda-badge--upcoming, .agenda-badge--unscheduled, .so-badge--outcome { color: var(--arc-cyan); border-color: var(--arc-cyan); }
.agenda-badge--dismissed { color: var(--text-dim); }
.so-card button, .agenda-card button { color: var(--text); background: rgba(0, 0, 0, .3); border: 1px solid var(--line-strong); padding: .15rem .45rem; }
.so-card button:disabled, .agenda-card button:disabled { color: var(--text-dim); border-color: var(--line); cursor: not-allowed; }
.agenda-derived-list li { display: grid; gap: .2rem; border-left: 2px dashed var(--line); padding-left: .55rem; }
.agenda-derived-heading { margin-top: .9rem; }
.agenda-link { color: var(--text-dim); font-size: .78rem; }
@media (max-width: 720px) {
  .so-add input, .agenda-add input { min-width: 0; width: 100%; }
  .badge-row { gap: .3rem; }
}
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

/* T-45 Package 3: the tactical overlay, the playbook cards and the watchpoint cards.
   Every colour is a token that already existed. Every red *label* uses --armor-red-text rather than
   --armor-red: the solid red is a fill for a bar and measures 4.03:1 against the void, under the 4.5 the
   deck holds itself to, while the text variant measures 5.94:1. The green, gold and cyan labels are the
   same three the T-44 cards use, and they were measured at the same time. */
#btn-hud-overlay-toggle[aria-pressed="true"] {
  color: var(--arc-cyan); border-color: var(--arc-cyan); background: rgba(0, 229, 255, .08);
}
.tactical-overlay-strip {
  display: flex; flex-wrap: wrap; gap: .2rem 1rem; align-items: center;
  margin: 0; padding: .35rem .75rem; min-width: 0;
  border-bottom: 1px solid var(--line-strong); background: rgba(0, 0, 0, .45);
  font-family: var(--font-mono); font-size: .76rem; letter-spacing: .06em;
}
.tactical-overlay-strip[hidden] { display: none; }
.overlay-item { display: inline-flex; gap: .35rem; align-items: baseline; min-width: 0; max-width: 100%; }
.overlay-key { color: var(--text-dim); }
.overlay-value { color: var(--text); overflow-wrap: anywhere; }
#overlay-lockdown[data-latch="active"] { color: var(--armor-red-text); }
#overlay-watchpoint-breaches[data-breaches="some"] { color: var(--armor-red-text); }
/* The posture hides what it says it hides, and nothing else: the nav, the reticle, the mode controls and
   the view the owner chose all stay where they were. A compact posture that stranded someone on a screen
   with no way off it would be a worse deck, not a smaller one. */
body[data-hud-posture="overlay"] [data-overlay-collapsible="true"] { display: none !important; }
body[data-hud-posture="overlay"] .panel { padding: .7rem; }
body[data-hud-posture="overlay"] .view h2 { margin-bottom: .35rem; }
body[data-hud-posture="overlay"] .work { gap: .4rem; }
/* The two new panels reuse the T-44 card shape so a reader learns it once. The only additions are the
   DAG line and the step list, both of which wrap because a capability name has no spaces to break at. */
.playbooks-list li, .watchpoints-list li { min-width: 0; }
.playbooks-list, .watchpoints-list { min-width: 0; max-width: 100%; }
.playbooks-list li, .watchpoints-list li { display: grid; gap: .25rem; border-left: 2px solid var(--line); padding-left: .55rem; }
.playbook-card, .watchpoint-card { border-left-color: var(--line-strong); }
.playbook-card[data-run-status="failed"], .watchpoint-card[data-wp-state="breached"] { border-left-color: var(--armor-red-text); }
.playbook-card[data-run-status="verified"] { border-left-color: var(--ok-green); }
.watchpoint-card[data-wp-state="paused"] { border-left-color: var(--armor-gold); }
.watchpoint-card[data-wp-state="unmeasured"] { border-left-color: var(--arc-cyan); }
.playbook-head, .watchpoint-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; }
.playbook-title, .watchpoint-title { color: var(--text); font-weight: 600; }
.playbook-id, .watchpoint-id { color: var(--text-dim); font-size: .78rem; letter-spacing: .04em; }
.playbook-badge, .watchpoint-badge {
  color: var(--text); background: rgba(0, 0, 0, .25); border: 1px solid var(--line); padding: .1rem .4rem;
}
.playbook-badge--verified, .watchpoint-badge--nominal { color: var(--ok-green); border-color: var(--ok-green); }
.playbook-badge--failed, .watchpoint-badge--breached { color: var(--armor-red-text); border-color: var(--armor-red-text); }
.playbook-badge--skipped, .watchpoint-badge--paused { color: var(--armor-gold); border-color: var(--armor-gold); }
.playbook-badge--rule, .watchpoint-badge--unmeasured { color: var(--arc-cyan); border-color: var(--arc-cyan); }
.playbook-dag, .watchpoint-row { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.playbook-dag-arrow, .playbook-dag-label { color: var(--text-dim); font-size: .78rem; }
.playbook-steps { list-style: none; margin: .15rem 0 0; padding: 0; display: grid; gap: .15rem; }
.playbook-steps li { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; border: 0; padding-left: 0; }
.playbook-step-label, .playbook-step-capability, .playbook-step-op, .watchpoint-value { overflow-wrap: anywhere; }
.playbook-step-op { color: var(--text-dim); font-size: .78rem; }
.watchpoint-value { color: var(--text); }
.playbook-card button, .watchpoint-card button {
  color: var(--text); background: rgba(0, 0, 0, .3); border: 1px solid var(--line-strong); padding: .15rem .45rem;
}
.playbook-card button:disabled, .watchpoint-card button:disabled { color: var(--text-dim); border-color: var(--line); cursor: not-allowed; }
.watchpoint-form { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .4rem 0; }
.watchpoint-form input, .watchpoint-form select { min-width: 0; max-width: 100%; }
#wp-title-input { min-width: 12rem; }
#wp-threshold-input { width: 6rem; }
@media (max-width: 720px) {
  .watchpoint-form input, .watchpoint-form select { width: 100%; }
  #wp-title-input, #wp-threshold-input { width: 100%; min-width: 0; }
  .tactical-overlay-strip { font-size: .72rem; gap: .15rem .6rem; }
  .badge-row { gap: .3rem; }
}
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
  // T-38 Step 3: cross-ledger search and the causal chain.
  traceSearchForm: document.getElementById('trace-search-form'),
  traceSearchQ: document.getElementById('trace-search-q'),
  traceSearchKind: document.getElementById('trace-search-kind'),
  traceSearchStatus: document.getElementById('trace-search-status'),
  traceSearchStatusLine: document.getElementById('trace-search-statusline'),
  traceSearchButton: document.getElementById('trace-search-button'),
  traceResults: document.getElementById('trace-results'),
  traceChain: document.getElementById('trace-chain'),
  traceChainStatus: document.getElementById('trace-chain-status'),
  // T-38 Step 2: the real file inspector.
  wsRefresh: document.getElementById('ws-refresh'),
  wsState: document.getElementById('ws-state'),
  wsEntries: document.getElementById('ws-entries'),
  wsExcerptPanel: document.getElementById('ws-excerpt-panel'),
  wsExcerptTitle: document.getElementById('ws-excerpt-title'),
  wsExcerpt: document.getElementById('ws-excerpt'),
  wsStageForm: document.getElementById('ws-stage-form'),
  wsStagePath: document.getElementById('ws-stage-path'),
  wsStageRationale: document.getElementById('ws-stage-rationale'),
  wsStageContent: document.getElementById('ws-stage-content'),
  wsStageTest: document.getElementById('ws-stage-test'),
  wsStageSubmit: document.getElementById('ws-stage-submit'),
  wsStageStatus: document.getElementById('ws-stage-status'),
  wsCandidates: document.getElementById('ws-candidates'),
  hudHelpToggle: document.getElementById('hud-help-toggle'),
  hudCommandHelp: document.getElementById('hud-command-help'),
  hudCommandHelpState: document.getElementById('hud-command-help-state'),
  hudCommandHelpRows: document.getElementById('hud-command-help-rows'),
  hudCommandHelpKeys: document.getElementById('hud-command-help-keys'),
  hudHelpClose: document.getElementById('hud-help-close'),
  wsCheckDisk: document.getElementById('ws-check-disk'),
  wsDiskState: document.getElementById('ws-disk-state'),
  wsDiskStatus: document.getElementById('ws-disk-status'),
  wsChangesetTitle: document.getElementById('ws-changeset-title'),
  wsApplyChangeset: document.getElementById('ws-apply-changeset'),
  wsChangesetState: document.getElementById('ws-changeset-state'),
  wsChangesets: document.getElementById('ws-changesets'),
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
  evolutionTarget: document.getElementById('evolution-target'),
  evolutionContent: document.getElementById('evolution-content'),
  evolutionTest: document.getElementById('evolution-test'),
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
  dispatchReceipt: document.getElementById('dispatch-receipt'),
  councilSynthesis: document.getElementById('council-synthesis'),
  councilCompile: document.getElementById('council-compile'),
  councilCompileStatus: document.getElementById('council-compile-status'),
  councilCompileResult: document.getElementById('council-compile-result'),
  // T-37 Step 1: the Track 2 panel. Every one of these is written only after a read succeeded; an
  // unavailable substrate leaves them at whatever the status line says, never at a zero.
  neuralStatus: document.getElementById('neural-status'),
  neuralSummary: document.getElementById('neural-summary'),
  neuralRegions: document.getElementById('neural-regions'),
  neuralRegionRows: document.getElementById('neural-region-rows'),
  neuralBridge: document.getElementById('neural-bridge'),
  neuralSteps: document.getElementById('neural-steps'),
  neuralStep: document.getElementById('neural-step'),
  neuralResetBridge: document.getElementById('neural-reset-bridge'),
  neuralActionStatus: document.getElementById('neural-action-status'),
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
  // T-43 Package 3: the git panel and the host telemetry. One entry per element the renderers write
  // to, so a missing node is a null check rather than an exception thrown from a render path.
  gitStatusText: document.getElementById('git-status-text'),
  gitBranchBadge: document.getElementById('git-branch-badge'),
  gitHeadBadge: document.getElementById('git-head-badge'),
  gitStagedBadge: document.getElementById('git-staged-badge'),
  gitUnstagedBadge: document.getElementById('git-unstaged-badge'),
  gitUntrackedBadge: document.getElementById('git-untracked-badge'),
  gitCheckpointsBadge: document.getElementById('git-checkpoints-badge'),
  gitRefresh: document.getElementById('btn-git-refresh'),
  gitDiffPathInput: document.getElementById('git-diff-path-input'),
  gitDiffInspect: document.getElementById('btn-git-diff-inspect'),
  gitDiffStatus: document.getElementById('git-diff-status'),
  diffViewer: document.getElementById('workshop-diff-viewer'),
  diffFileHeader: document.getElementById('diff-file-header'),
  diffAdditionsBadge: document.getElementById('diff-additions-badge'),
  diffDeletionsBadge: document.getElementById('diff-deletions-badge'),
  diffHunksBadge: document.getElementById('diff-hunks-badge'),
  diffBody: document.getElementById('diff-body'),
  gitCheckpointLabel: document.getElementById('git-checkpoint-label-input'),
  gitCheckpointCreate: document.getElementById('btn-git-checkpoint-create'),
  gitCheckpointStatus: document.getElementById('git-checkpoint-status'),
  gitCheckpointRefusal: document.getElementById('git-checkpoint-refusal'),
  checkpointsList: document.getElementById('workshop-checkpoints-list'),
  telemetryTotalBadge: document.getElementById('telemetry-total-badge'),
  telemetryLoopbackBadge: document.getElementById('telemetry-loopback-badge'),
  telemetryExposureBadge: document.getElementById('telemetry-exposure-badge'),
  telemetryRssBadge: document.getElementById('telemetry-rss-badge'),
  telemetryRefresh: document.getElementById('btn-telemetry-refresh'),
  telemetryStatus: document.getElementById('telemetry-status'),
  portTable: document.getElementById('edith-port-table'),
  processTable: document.getElementById('edith-process-table'),
  processSummary: document.getElementById('edith-process-summary'),
  // T-44 Packages 1 and 2: the standing-orders panel and the executive agenda.
  standingOrdersPanel: document.getElementById('standing-orders-panel'),
  soStatus: document.getElementById('so-status'),
  soSummaryBadges: document.getElementById('so-summary-badges'),
  soTotalCount: document.getElementById('so-total-count'),
  soEnabledCount: document.getElementById('so-enabled-count'),
  soRunsCount: document.getElementById('so-runs-count'),
  soLockdownStatus: document.getElementById('so-lockdown-status'),
  soTitleInput: document.getElementById('so-title-input'),
  soTriggerSelect: document.getElementById('so-trigger-select'),
  soCapabilitySelect: document.getElementById('so-capability-select'),
  btnSoCreate: document.getElementById('btn-so-create'),
  soCreateStatus: document.getElementById('so-create-status'),
  soCreateRefusal: document.getElementById('so-create-refusal'),
  standingOrdersList: document.getElementById('standing-orders-list'),
  soEvalTriggerSelect: document.getElementById('so-eval-trigger-select'),
  btnSoEvaluate: document.getElementById('btn-so-evaluate'),
  btnSoEvaluateDirty: document.getElementById('btn-so-evaluate-dirty'),
  soEvalStatus: document.getElementById('so-eval-status'),
  agendaPanel: document.getElementById('briefing-agenda-panel'),
  agendaStatus: document.getElementById('agenda-status'),
  agendaOverdueCount: document.getElementById('agenda-overdue-count'),
  agendaTodayCount: document.getElementById('agenda-today-count'),
  agendaUpcomingCount: document.getElementById('agenda-upcoming-count'),
  agendaCompletedCount: document.getElementById('agenda-completed-count'),
  agendaDerivedCount: document.getElementById('agenda-derived-count'),
  agendaTitleInput: document.getElementById('agenda-title-input'),
  agendaPrioritySelect: document.getElementById('agenda-priority-select'),
  agendaCategorySelect: document.getElementById('agenda-category-select'),
  agendaLinkInput: document.getElementById('agenda-link-input'),
  btnAgendaCreate: document.getElementById('btn-agenda-create'),
  agendaAddStatus: document.getElementById('agenda-add-status'),
  agendaList: document.getElementById('briefing-agenda-list'),
  derivedAgendaList: document.getElementById('briefing-derived-agenda-list'),
  // T-45 Package 3: the playbooks panel, the watchpoints panel and the tactical overlay strip.
  playbooksPanel: document.getElementById('playbooks-panel'),
  pbStatus: document.getElementById('playbooks-status'),
  pbTemplateCount: document.getElementById('playbooks-template-count'),
  pbRunsCount: document.getElementById('playbooks-runs-count'),
  pbVerifiedCount: document.getElementById('playbooks-verified-count'),
  pbTemplateList: document.getElementById('playbooks-template-list'),
  pbRunsStatus: document.getElementById('playbooks-runs-status'),
  pbRunsList: document.getElementById('playbooks-runs-list'),
  watchpointsPanel: document.getElementById('sentinel-watchpoints-panel'),
  wpStatus: document.getElementById('watchpoints-status'),
  wpTotalCount: document.getElementById('watchpoints-total-count'),
  wpEnabledCount: document.getElementById('watchpoints-enabled-count'),
  wpBreachedCount: document.getElementById('watchpoints-breached-count'),
  wpNominalCount: document.getElementById('watchpoints-nominal-count'),
  wpTitleInput: document.getElementById('wp-title-input'),
  wpMetricSelect: document.getElementById('wp-metric-select'),
  wpOperatorSelect: document.getElementById('wp-operator-select'),
  wpThresholdInput: document.getElementById('wp-threshold-input'),
  wpSeveritySelect: document.getElementById('wp-severity-select'),
  btnWpCreate: document.getElementById('btn-wp-create'),
  btnWpEvaluate: document.getElementById('btn-wp-evaluate'),
  wpRefusal: document.getElementById('wp-refusal'),
  wpEvalStatus: document.getElementById('wp-eval-status'),
  watchpointsList: document.getElementById('sentinel-watchpoints-list'),
  btnHudOverlay: document.getElementById('btn-hud-overlay-toggle'),
  tacticalOverlayStrip: document.getElementById('tactical-overlay-strip'),
  overlayCoreState: document.getElementById('overlay-core-state'),
  overlayMode: document.getElementById('overlay-mode'),
  overlayLockdown: document.getElementById('overlay-lockdown'),
  overlayWatchpointBreaches: document.getElementById('overlay-watchpoint-breaches'),
  overlayApprovals: document.getElementById('overlay-approvals'),
  docSearch: document.getElementById('doc-search-form'),
  docSearchText: document.getElementById('doc-search'),
  banner: document.getElementById('banner'),
  coreState: document.getElementById('core-state'),
  // T-46 STEP 1: the header's compact strip, the measures popover, and the Core's own sizing box.
  coreStateCompact: document.getElementById('core-state-compact'),
  latchCompact: document.getElementById('latch-compact'),
  approvalsCompact: document.getElementById('approvals-compact'),
  watchpointsCompact: document.getElementById('watchpoints-compact'),
  measuresTrigger: document.getElementById('measures-trigger'),
  measuresPanel: document.getElementById('measures-panel'),
  stepdownCompact: document.getElementById('stepdown-state-compact'),
  coreCaption: document.getElementById('core-caption'),
  clock: document.getElementById('clock'),
  boot: document.getElementById('boot'),
  bootLines: document.getElementById('boot-lines'),
  bootSkip: document.getElementById('boot-skip'),
  quickBoot: document.getElementById('quick-boot'),
  // T-36 Step 2: the HUD boot sequence - the opening screen of a workstation that has not been
  // set up yet.
  bootSequence: document.getElementById('hud-boot-sequence'),
  bootSequenceSteps: document.getElementById('hud-boot-steps'),
  bootSequenceDismiss: document.getElementById('hud-boot-dismiss'),
  bootSequenceRun: document.getElementById('boot-sequence-run'),
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
  // T-44 Packages 1 and 2: the two panels' most recent readings. Held so a later render can reuse the
  // policy list the capability select is built from without a second fetch.
  standingOrders: null,
  agenda: null,
  // T-45 Package 3: the two new ledgers' last reads, and the approval total the strip quotes. An
  // undefined value means "not read yet"; null means "the read was partial". The strip tells them apart so
  // an unavailable owner store shows a dash rather than a zero the owner would read as an all-clear.
  playbooks: null,
  watchpoints: null,
  pendingApprovalCount: undefined,
  eventCursor: { streamId: null, seq: 0, versions: {} },
  ownerSnapshots: Object.create(null),
  eventReconciled: false,
  stateReadAvailable: false,
  thinking: false,
  safetyLatchFresh: false,
  safetyMutationInFlight: false,
  reducedMotion: false,
  // T-46 STEP 1: whether the measures popover is open. Held here rather than read back from the DOM,
  // for the reason measuresOpen() gives.
  measuresOpen: false,
  mode: 'classic',
  // T-35 Step 2: the enrolled devices the handoff form offers, and the ledger last read.
  handoffDevices: [],
  handoffLedger: null,
  doctorAt: 0,
  doctorRan: false,
  contrast: 'standard',
  cognitionInFlight: false,
  lastCognitionRun: null,
  // T-36 Step 2: the boot sequence. While it is active the Core is held in Dormant, because a
  // deck that is still verifying its own readiness is not Idle and not Degraded.
  bootSequence: { active: false, running: false, dismissed: false, startedAt: null, steps: [], triggered: false, report: null, error: null },
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
    // T-39: a refusal can carry structure the screen needs - the refusal code, and on a drift
    // refusal the two digests. Copying only the status would leave the diagnostic unable to say what
    // it was told, which is the difference between a diagnosis and a riddle. Bounded to the fields
    // the refusal contract defines; the body is never re-thrown wholesale.
    if (data && typeof data === 'object') {
      for (const key of ['code', 'expectedBaseSha256', 'actualDiskSha256',
        'expectedAppliedSha256', 'restoredSha256', 'display',
        // T-40: a batch refusal is a LIST of problems, not one pair of digests. Without these the
        // client received a 409 whose per-file diagnosis had been dropped on the floor, which is how
        // the T-40 walk reached the screen with an empty diagnostic while the server had answered with
        // everything needed to explain itself. The same three scalar fields are copied too, because a
        // caller that only wants the first offending file should not have to walk the list.
        'problems', 'refusedCandidateId', 'refusedRelativePath', 'filesChecked', 'filesRefused',
        'undone',
        // T-41: a boundary refusal carries which boundary was hit and why it exists. Without this the
        // 403 would reach the screen as a bare code.
        'boundary']) {
        if (typeof data[key] !== 'undefined') error[key] = data[key];
      }
    }
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
  // T-36 Step 2: while the boot sequence is running the Core is Dormant. The machine is still
  // verifying its own readiness, and a deck that is waking is not Idle, not Degraded and not
  // Awaiting Approval. The owners' states are still rendered; only the Core's own claim waits.
  // A state that carries no boot sequence is simply not booting, so the read is guarded: a
  // partial projection must never throw on the way to the owners' answer.
  if (state.bootSequence && state.bootSequence.active) {
    state.core = 'dormant';
    document.body.dataset.coreState = 'dormant';
    renderSafety();
    // A dormant Core is a reading too: the strip says Dormant while the machine is waking.
    if (typeof syncHeaderStripSafely === 'function') syncHeaderStripSafely();
    return 'dormant';
  }
  setCore(next, coreCaptionFor(next, reason));
  renderSafety();
  // T-46 STEP 1: the header strip mirrors this projection in this pass, so the two cannot disagree.
  // The typeof guard is the same convention the tactical strip uses: applyCoreProjection is exercised
  // on its own, as a slice of this source, by the browser-free projection tests, and a slice that
  // stops before the wrapper is defined must still project a Core rather than throw.
  if (typeof syncHeaderStripSafely === 'function') syncHeaderStripSafely();
  return next;
}

// The strip is a glance; the projection is the product. A strip that cannot paint is a missing
// reading, never a state change that did not happen - and this runs from the boot sequence's own
// dismiss path, where a throw would leave the overlay up over a Core that claims to be awake.
function syncHeaderStripSafely() {
  // The typeof guard is not decoration: the projection is exercised on its own, as a slice of this
  // source, by the browser-free projection tests, and a slice that stops before this file's later
  // definitions must still project a Core rather than throw. It is the same guard the tactical strip
  // has used since T-45 for the same reason.
  if (typeof syncHeaderStrip !== 'function') return;
  try {
    syncHeaderStrip();
  } catch (error) {
    // Nothing to do: the next render pass tries again.
  }
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
  // T-45 Package 3: the tactical strip quotes this number, so it is taken from the read that rendered the
  // centre rather than from a second read that could disagree with it. An unreadable owner store reports
  // nothing rather than zero: a strip that showed 0 while the read was failing would be a false all-clear.
  state.pendingApprovalCount = value.status === 'partial' || missing.length > 0 ? null : total;
  if (typeof syncOverlayStrip === 'function') syncOverlayStrip();
  if (typeof syncHeaderStrip === 'function') syncHeaderStrip();
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
  // T-37 Step 2: the compile button is live only when there is a recommendation in hand.
  if (els.councilCompile) {
    const ready = Boolean(state.lastCouncil && state.lastCouncil.result?.synthesis?.recommendedOption);
    els.councilCompile.disabled = !ready;
  }
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

  // T-37 Step 2: the four canonical perspectives the owner reads first, named as the brief names
  // them. They are the same eight positions the service evaluated - mapped onto the vocabulary the
  // brief uses - so this is a view of the deliberation, not a second one.
  const positions = Array.isArray(latest.positions) ? latest.positions : [];
  const find = (id) => positions.find((entry) => entry.perspectiveId === id) ?? null;
  const canonical = [
    ['thesis', 'Thesis — objective alignment', find('objective_alignment')],
    ['counter_risk', 'Counter-risk — safety and policy', find('safety_policy')],
    ['evidence_check', 'Evidence check — what the records support', find('evidence_quality')],
    ['constraint_check', 'Constraint check — values and constraints core', find('constraint_check')],
  ];
  const canonicalList = el('ul', 'work');
  for (const [id, label, position] of canonical) {
    const item = el('li');
    const text = position
      ? String(position.position?.verdict ?? position.status ?? 'status not recorded')
        + (position.position?.summary ? ' — ' + String(position.position.summary) : '')
      : 'not recorded in this session';
    const entry = itemFrom(label, text);
    entry.dataset.perspective = id;
    canonicalList.append(entry);
  }
  els.councilSynthesis.append(canonicalList);

  // The full evaluated set, including the constraint core's rule-by-rule verdicts when it ran.
  const list = el('ul', 'work');
  for (const position of positions) {
    const item = itemFrom(position.perspectiveName || position.perspectiveId,
      (position.position && position.position.verdict) || position.status || 'status not recorded');
    // The constraint core's own evaluation travels with it: each rule, its verdict and its reason.
    if (position.evaluation && Array.isArray(position.evaluation.evaluations)) {
      item.dataset.perspective = 'constraint_check';
      item.title = position.evaluation.evaluations
        .map((rule) => rule.name + ' — ' + rule.verdict + ': ' + rule.detail).join(String.fromCharCode(10));
    }
    list.append(item);
  }
  els.councilSynthesis.append(list);

  // The constraint core's rules, shown rather than hidden in a tooltip, because a rule the owner
  // cannot read is a rule they cannot disagree with.
  const core = find('constraint_check');
  if (core && core.evaluation && Array.isArray(core.evaluation.evaluations)) {
    const heading = el('h4', null, 'Values & Constraints Core — ' + String(core.evaluation.overall || 'unknown'));
    const rules = el('ul', 'work');
    for (const rule of core.evaluation.evaluations) {
      const row = itemFrom(rule.name + ' (' + rule.severity + ')', rule.verdict + ' — ' + rule.detail);
      row.dataset.constraint = rule.id;
      row.dataset.verdict = rule.verdict;
      rules.append(row);
    }
    els.councilSynthesis.append(heading, rules);
  }
}

// T-37 Step 1: Track 2 in the deck. Every value is read from the substrate the capabilities actually
// step; nothing is derived, estimated or defaulted. The bridge panel states its own status first,
// because "isolated, contributing nothing" and "connected, contributing zero salience" are different
// facts and a reader must be able to tell them apart at a glance.
function renderNeural(result) {
  if (!els.neuralStatus) return;
  const owner = ownerStatusText(result, 'Neural substrate');
  if (owner.text) {
    setWorkspaceStatus(els.neuralStatus, owner.text, owner.state);
    if (els.neuralSummary) els.neuralSummary.replaceChildren();
    if (els.neuralRegions) els.neuralRegions.hidden = true;
    if (els.neuralRegionRows) els.neuralRegionRows.replaceChildren();
    if (els.neuralBridge) {
      els.neuralBridge.replaceChildren();
      els.neuralBridge.append(el('p', 'meta', 'Unavailable: the neural substrate could not be read, so no value is shown.'));
    }
    return;
  }
  const report = result.value || {};
  const substrate = report.substrate || {};
  const bridge = report.bridge || {};
  const totals = substrate.totals || {};
  const regions = Array.isArray(substrate.regions) ? substrate.regions : [];

  if (regions.length === 0) {
    setWorkspaceStatus(els.neuralStatus, 'The substrate reported no regions; nothing is shown rather than an empty table.', 'empty');
    return;
  }
  setWorkspaceStatus(els.neuralStatus,
    regions.length + ' region(s) · step ' + String(substrate.step ?? 'unknown')
      + ' · bridge ' + String(bridge.status || 'unknown') + (bridge.isolated === true ? ' (isolated)' : '') + '.',
    bridge.isolated === true ? 'degraded' : 'available');

  // The headline facts. Each names the field it came from so a reader can check it against the API.
  els.neuralSummary.replaceChildren();
  const facts = [
    ['Regions', String(regions.length) + ' (' + regions.map((region) => region.id).join(', ') + ')'],
    ['Cells', String(totals.cells ?? 'unavailable')],
    ['Synapses', String(totals.synapses ?? 'unavailable')],
    ['Sparse density', totals.density === undefined ? 'unavailable' : String(totals.density)],
    ['Steps run', String(substrate.step ?? 'unavailable')],
    ['Seed', String(substrate.seed ?? 'unavailable')],
    ['Bridge', String(bridge.bridgeVersion || 'unknown') + ' · ' + String(bridge.status || 'unknown')],
    ['Crossings', String(bridge.crossings ?? 'unavailable') + ' · refusals ' + String(bridge.refusals ?? 'unavailable')],
    ['Circuit breaker', 'threshold ' + String(bridge.threshold ?? 'unknown') + ' consecutive refusals'
      + (bridge.isolated === true ? ' · ISOLATED (falling back to Track 1)' : '')],
  ];
  for (const [term, value] of facts) {
    const dt = el('dt', null, term);
    const dd = el('dd', null, value);
    els.neuralSummary.append(dt, dd);
  }

  // The per-region table: the eight canonical regions with the numbers the brief asks for.
  els.neuralRegionRows.replaceChildren();
  for (const region of regions) {
    const membrane = region.membranePotential || {};
    const adjacency = region.adjacency || {};
    const row = document.createElement('tr');
    for (const cell of [
      String(region.id),
      String(region.cells ?? ''),
      String(region.spikes ?? ''),
      String(region.activeNow ?? ''),
      membrane.meanMv === undefined ? '' : String(membrane.meanMv) + ' mV',
      region.meanOutgoingWeight === undefined ? '' : String(region.meanOutgoingWeight),
      adjacency.outgoingFanOut === undefined ? '' : String(adjacency.outgoingFanOut),
    ]) {
      row.append(el('td', null, cell));
    }
    els.neuralRegionRows.append(row);
  }
  els.neuralRegions.hidden = false;

  // The bridge contract and its boundary, stated as data rather than as a promise.
  els.neuralBridge.replaceChildren();
  els.neuralBridge.append(el('h4', null, 'Bridge contract'));
  const contract = bridge.contract || {};
  const lines = [
    'Version: ' + String(contract.bridgeVersion || bridge.bridgeVersion || 'unknown'),
    'Signal schema: ' + String(contract.signalSchema || 'unknown'),
    'Accepts: ' + (Array.isArray(contract.acceptedInputSchemas) ? contract.acceptedInputSchemas.join(', ') : 'unknown'),
    'Fallback: ' + String(bridge.isolationFallback || contract.fallback || 'symbolic') ,
    'Crossings: ' + String(bridge.crossings ?? 0) + ' · refusals: ' + String(bridge.refusals ?? 0)
      + ' · consecutive: ' + String(bridge.consecutiveRefusals ?? 0) + ' of ' + String(bridge.threshold ?? '?'),
  ];
  if (bridge.lastRefusal) {
    lines.push('Last refusal: ' + String(bridge.lastRefusal.refusal || 'unknown') + ' — ' + String(bridge.lastRefusal.detail || ''));
  }
  if (bridge.isolated === true) {
    lines.push('The bridge is isolated: it translates nothing and the pipeline is running on Track 1 alone.');
  }
  for (const line of lines) els.neuralBridge.append(el('p', 'meta', line));
  const boundary = report.boundary || {};
  els.neuralBridge.append(el('p', 'meta',
    'Boundary: every signal is ' + String(boundary.epistemicStatus || 'candidate_association')
      + '. It cannot authorize (' + String(boundary.authorizesExecution === false ? 'false' : 'unstated')
      + ') or write an observed fact (' + String(boundary.mutatesObservedFacts === false ? 'false' : 'unstated') + ').'));
}

async function loadNeural() {
  renderNeural(await readApi('/api/neural/substrate'));
}

// The two governed acts. Both are writes, so both are answered by the action's own verification; the
// button never says "done" until the server said the step verified.
async function stepNeural() {
  if (!els.neuralStep) return;
  const steps = Math.max(1, Math.min(64, Number(els.neuralSteps && els.neuralSteps.value) || 1));
  els.neuralStep.disabled = true;
  if (els.neuralActionStatus) els.neuralActionStatus.textContent = 'Advancing ' + steps + ' step(s)…';
  try {
    const value = await api('/api/neural/step', { method: 'POST', body: { steps } });
    if (els.neuralActionStatus) {
      els.neuralActionStatus.textContent = value.stepVerified === true
        ? 'Verified: ' + String(value.spikes) + ' spike(s), ' + String(value.potentiated) + ' potentiated / '
          + String(value.depressed) + ' depressed; bridge ' + String(value.bridge?.status || 'unknown') + '.'
        : 'The step ran but did not verify: ' + String(value.display || 'no detail');
    }
    await loadNeural();
  } catch (error) {
    if (els.neuralActionStatus) els.neuralActionStatus.textContent = 'Refused or unavailable: ' + String(error?.message || error);
  } finally {
    els.neuralStep.disabled = false;
  }
}

async function resetNeuralBridge() {
  if (!els.neuralResetBridge) return;
  els.neuralResetBridge.disabled = true;
  if (els.neuralActionStatus) els.neuralActionStatus.textContent = 'Resetting the bridge…';
  try {
    const value = await api('/api/neural/bridge/reset', { method: 'POST', body: { reason: 'deck reset' } });
    if (els.neuralActionStatus) {
      els.neuralActionStatus.textContent = value.verified === true
        ? 'Bridge is ' + String(value.after?.status || 'unknown') + ' on an independent read.'
        : 'The reset did not verify: ' + String(value.display || 'no detail');
    }
    await loadNeural();
  } catch (error) {
    if (els.neuralActionStatus) els.neuralActionStatus.textContent = 'Refused or unavailable: ' + String(error?.message || error);
  } finally {
    els.neuralResetBridge.disabled = false;
  }
}

// T-37 Step 2: compiling a recommendation into a mission. This is deliberately not a shortcut: it
// calls the same /api/cognition/run route the composer calls, with the same ECP gate, and it reports
// the run record rather than a claim that a mission exists.
async function compileCouncilRecommendation() {
  const held = state.lastCouncil;
  if (!held || !held.objective) {
    if (els.councilCompileStatus) els.councilCompileStatus.textContent = 'Deliberate first; there is nothing to compile.';
    return;
  }
  const option = held.result?.synthesis?.recommendedOption ?? null;
  if (!option) {
    if (els.councilCompileStatus) els.councilCompileStatus.textContent = 'The deliberation produced no recommendation, so there is nothing to compile.';
    return;
  }
  if (els.councilCompile) els.councilCompile.disabled = true;
  if (els.councilCompileStatus) els.councilCompileStatus.textContent = 'Compiling into a governed T-29 mission…';
  if (els.councilCompileResult) els.councilCompileResult.replaceChildren();
  try {
    // The mission is the deliberation's own objective. The recommendation is cited in the intent so
    // the run record shows what was compiled from, not just what was asked for.
    const value = await api('/api/cognition/run', {
      method: 'POST',
      body: {
        intent: held.objective,
        councilRequested: true,
      },
    });
    // The route answers with the whole run nested under its own key, and the run record is what
    // carries the id, the task, the verification and the approval. Reading those off the envelope
    // found nothing, so
    // a verified run was reported as "not verified" beside a literal "undefined" run id - the exact
    // claim this panel exists not to make.
    const record = value.run ?? value;
    const verified = record.verification?.verified === true
      || record.verification?.outcome === 'verified'
      || record.status === 'completed';
    if (els.councilCompileStatus) {
      els.councilCompileStatus.textContent = verified
        ? 'Compiled and run: ' + String(value.status ?? record.status) + ' · task ' + String(record.taskId ?? 'none')
        : 'Compiled but not verified: ' + String(value.status ?? record.status ?? 'unknown');
    }
    if (els.councilCompileResult) {
      els.councilCompileResult.append(el('p', 'meta',
        'Run ' + String(record.runId ?? 'not recorded') + ' · status ' + String(value.status ?? record.status ?? 'unknown')
          + ' · verification ' + String(record.verification?.outcome ?? 'not_run')
          + (record.taskId ? ' · task ' + String(record.taskId) : '')));
      if (record.approval && record.approval.required === true) {
        els.councilCompileResult.append(el('p', 'meta',
          'Waiting for your approval: ' + String(record.approval.detail ?? 'a gated step needs it')));
      }
    }
    await refresh();
  } catch (error) {
    if (els.councilCompileStatus) els.councilCompileStatus.textContent = 'Refused or unavailable: ' + String(error?.message || error);
  } finally {
    if (els.councilCompile) els.councilCompile.disabled = false;
  }
}

// T-37 Step 3: the dispatch receipt. Every field the router reported is shown with the name the brief
// gave it, so a reader can check the claim against the record rather than against a sentence.
function renderDispatchReceipt(receipt) {
  if (!els.dispatchReceipt) return;
  els.dispatchReceipt.replaceChildren();
  if (!receipt) { els.dispatchReceipt.hidden = true; return; }
  const rows = [
    ['Route', String(receipt.routeKind || 'unknown')],
    ['Capability', receipt.actionInvoked ? String(receipt.actionInvoked) : (receipt.route ? String(receipt.route) : 'none')],
    ['Target view', receipt.targetView ? String(receipt.targetView) : 'none'],
    ['ECP decision', String(receipt.ecpDecision || 'not_applicable')],
    ['Verified', receipt.verified === true ? 'yes' : 'no'],
    ['Result', String(receipt.summary || '')],
  ];
  if (receipt.detail) rows.push(['Detail', String(receipt.detail)]);
  for (const [term, value] of rows) {
    els.dispatchReceipt.append(el('dt', null, term), el('dd', null, value));
  }
  els.dispatchReceipt.hidden = false;
  els.dispatchReceipt.dataset.verified = receipt.verified === true ? 'yes' : 'no';
  els.dispatchReceipt.dataset.route = String(receipt.routeKind || 'unknown');
}

// The one place the deck submits a line. The router decides; this only reports what it decided and
// moves the owner to the screen the route named.
async function dispatchCommand(line) {
  const receipt = await api('/api/command/dispatch', { method: 'POST', body: { line } });
  renderDispatchReceipt(receipt);
  // Applying a presentation mode is the deck's job: a mode is presentation, not an API call the
  // server can make on the owner's behalf. A refused mode is not applied - the latch wins, and the
  // receipt already says so.
  if (receipt.routeKind === 'mode' && receipt.target && receipt.ecpDecision !== 'deny') {
    applyMode(receipt.target);
  }
  if (receipt.targetView) setView(receipt.targetView);
  // T-44 Packages 1 and 2: a receipt may name the panel inside the view it wants looked at. The view
  // switch is what paints the screen; this is what puts the owner in front of the thing the command was
  // about, and it re-reads that panel so what they see is the current state rather than the one that was
  // on screen when they pressed return.
  if (typeof receipt.target === 'string' && receipt.target.length > 0) {
    focusPanel(receipt.target);
    if (receipt.target === '#briefing-agenda-panel') void refreshAgenda();
    if (receipt.target === '#standing-orders-panel') void refreshStandingOrders();
    // T-45 Package 3: a command that names one of the new panels re-reads it for the same reason.
    if (receipt.target === '#playbooks-panel') void refreshPlaybooks();
    if (receipt.target === '#sentinel-watchpoints-panel') void refreshWatchpoints();
  }
  // T-45 Package 3: the posture commands. They carry no capability, so the receipt names no view and
  // authorizes nothing - the router is stateless and does not know which posture is on screen, so it
  // answers "toggle" and the deck, which does know, performs the toggle. That keeps the router free of
  // browser state and keeps the button and the command line from disagreeing: both call this one function.
  if (receipt.routeKind === 'hud') toggleHudPosture();
  return receipt;
}

// Scroll the named panel into view and mark it briefly, so a command that lands on a panel already on
// screen still shows the owner that something answered. A selector that matches nothing is ignored: a
// receipt must never be able to throw.
function focusPanel(selector) {
  let panel = null;
  try { panel = document.querySelector(selector); } catch { panel = null; }
  if (!panel) return;
  if (typeof panel.scrollIntoView === 'function') {
    try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* older engines */ }
  }
  panel.dataset.focusPulse = 'on';
  window.setTimeout(() => { delete panel.dataset.focusPulse; }, 1200);
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
// T-42 Step 3: the graph render is monotonic. Two readers can be in flight at once - the periodic
// refresh and the owner choosing a recorded task - and the slower one is not necessarily the older
// one. Without a sequence the refresh, which asked for "the newest unfinished task" before the owner
// chose a five-node mission, could land afterwards and repaint the deck with a one-node task. The
// counter is per-renderer and the requested task is remembered, so an older read can never overwrite
// a graph the owner explicitly asked for.
let taskGraphRenderSequence = 0;
let taskGraphRequestedTaskId = null;
let taskGraphRenderedSequence = 0;
function renderTaskGraph(result, request = null) {
  if (!els.dagNodes) return;
  const graph = result?.ok === true ? result.value : null;
  // A read that started before the last render is stale whatever it contains. Dropping it is not the
  // same as failing it: the deck already shows a graph, and the read that is dropped was answering a
  // question the owner has moved on from.
  const sequence = request && Number.isSafeInteger(request.sequence) ? request.sequence : ++taskGraphRenderSequence;
  if (sequence < taskGraphRenderedSequence) return;
  // A read that is not stale by sequence can still be answering the wrong question: the owner pinned
  // a task, and this read asked for "the newest unfinished task". Rendering it would silently undo
  // the pin. It is dropped, and only for a read that did not ask for the pinned task.
  if (request && request.taskId === null && graph && taskGraphRequestedTaskId !== null
    && graph.taskId !== taskGraphRequestedTaskId) return;
  taskGraphRenderedSequence = sequence;
  // The pin is cleared only when the graph that arrived *is* the pinned one, so the deck never ends
  // up pinned to a task whose log has been read and rejected.
  if (request && request.taskId !== null && graph && graph.taskId === request.taskId) taskGraphRequestedTaskId = request.taskId;
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

// ------------------------------------------------------------------- T-43 Package 3: git and host ---
//
// Four renderers and their fetchers. Each one states a fact the server measured and none of them
// computes a fact of its own: a badge count comes from the reading, the diff rows come from the parsed
// hunks, and a checkpoint's REF INTACT badge is the live answer the server measured against the
// repository rather than a field it stored.

function shortSha(value) {
  return typeof value === 'string' && value.length >= 7 ? value.slice(0, 7) : String(value ?? '—');
}

function setGitBadge(target, label, value) {
  if (!target) return;
  target.textContent = label + ': ' + value;
}

// The git status panel. A repository that is not there is reported as such and the badges say so
// rather than showing zeroes: "0 unstaged" about a directory that is not a repository would be a lie
// of the calmest kind.
function renderGitStatus(result) {
  const owner = ownerStatusText(result, 'the repository');
  if (owner.text) {
    setWorkspaceStatus(els.gitStatusText, owner.text, owner.state);
    for (const badge of [els.gitBranchBadge, els.gitHeadBadge, els.gitStagedBadge, els.gitUnstagedBadge,
      els.gitUntrackedBadge, els.gitCheckpointsBadge]) {
      if (badge) badge.textContent = badge.textContent.replace(/:.*$/, ': unavailable');
    }
    return;
  }
  const data = result.value ?? {};
  if (data.isRepo !== true) {
    const reason = data.reason === 'git_unavailable' ? 'git is not available on this machine'
      : data.reason === 'not_a_git_repository' ? 'the workspace is not a git repository'
        // T-43 Package 3: a build with no workspace root is a build with no repository to read. That is
        // a stated absence rather than a read that failed, and saying so is more useful than a generic
        // failure on a screen where nothing is wrong.
        : data.reason === 'no_workspace_root' ? 'this build has no target workspace, so there is no repository to read'
          : 'the repository could not be read';
    setWorkspaceStatus(els.gitStatusText, 'No repository: ' + reason + '. Nothing is assumed about one that is not there.', 'empty');
    setGitBadge(els.gitBranchBadge, 'branch', 'none');
    setGitBadge(els.gitHeadBadge, 'HEAD', 'none');
    setGitBadge(els.gitStagedBadge, 'staged', '0');
    setGitBadge(els.gitUnstagedBadge, 'unstaged', '0');
    setGitBadge(els.gitUntrackedBadge, 'untracked', '0');
    setGitBadge(els.gitCheckpointsBadge, 'checkpoints', String(data.checkpointsCount ?? 0));
    return;
  }
  const aheadBehind = data.ahead === null || data.ahead === undefined
    ? 'no upstream configured'
    : data.ahead + ' ahead, ' + data.behind + ' behind';
  setWorkspaceStatus(els.gitStatusText,
    (data.branch || 'detached HEAD') + ' at ' + shortSha(data.headSha) + ' · ' + aheadBehind
      + ' · ' + (data.recentCommits.length > 0 ? 'latest ' + data.recentCommits[0].shortSha + ' ' + data.recentCommits[0].subject : 'no commits'),
    'available');
  setGitBadge(els.gitBranchBadge, 'branch', data.branch || 'detached');
  setGitBadge(els.gitHeadBadge, 'HEAD', shortSha(data.headSha));
  setGitBadge(els.gitStagedBadge, 'staged', String(data.staged.length));
  setGitBadge(els.gitUnstagedBadge, 'unstaged', String(data.unstaged.length));
  setGitBadge(els.gitUntrackedBadge, 'untracked', String(data.untracked.length));
  setGitBadge(els.gitCheckpointsBadge, 'checkpoints', String(data.checkpointsCount));
  // The three counts are also written as data attributes so the end-to-end suite can assert the number
  // it sees was the number the reading reported, rather than matching text.
  if (els.gitStagedBadge) els.gitStagedBadge.dataset.count = String(data.staged.length);
  if (els.gitUnstagedBadge) els.gitUnstagedBadge.dataset.count = String(data.unstaged.length);
  if (els.gitUntrackedBadge) els.gitUntrackedBadge.dataset.count = String(data.untracked.length);
  if (els.gitCheckpointsBadge) els.gitCheckpointsBadge.dataset.count = String(data.checkpointsCount);
}

// The diff viewer. One row per parsed line, with the old and new numbers in their own columns and the
// glyph in the gutter carrying the same meaning as the tint.
function renderDiff(data, { path = null } = {}) {
  if (!els.diffViewer) return;
  const hunks = Array.isArray(data?.hunks) ? data.hunks : [];
  const hasContent = hunks.length > 0;
  els.diffViewer.hidden = !hasContent && data?.isRepo !== false;
  if (els.diffFileHeader) {
    els.diffFileHeader.textContent = data?.isRepo === false
      ? 'no repository at the workspace root'
      : (data?.targetPath || path || 'the whole working tree');
  }
  if (els.diffAdditionsBadge) els.diffAdditionsBadge.textContent = '+' + (data?.additions ?? 0);
  if (els.diffDeletionsBadge) els.diffDeletionsBadge.textContent = '-' + (data?.deletions ?? 0);
  if (els.diffHunksBadge) els.diffHunksBadge.textContent = hunks.length + ' hunk(s)';
  if (!els.diffBody) return;
  els.diffBody.textContent = '';
  if (!hasContent) {
    const row = document.createElement('tr');
    const cell = el('td', 'meta', data?.isRepo === false
      ? 'There is no repository to diff.'
      : 'No changes against ' + (data?.baseRef ?? 'HEAD') + (data?.targetPath ? ' in ' + data.targetPath : '') + '.');
    cell.colSpan = 3;
    row.append(cell);
    els.diffBody.append(row);
    return;
  }
  for (const hunk of hunks) {
    const headerRow = document.createElement('tr');
    const headerCell = el('td', 'meta', hunk.header);
    headerCell.colSpan = 3;
    headerRow.append(headerCell);
    els.diffBody.append(headerRow);
    for (const line of hunk.lines) {
      const row = document.createElement('tr');
      // The class is what carries the tint; the text carries the glyph. Both say add or delete, so a
      // reader who cannot distinguish the two backgrounds is not missing the fact.
      row.className = line.type === 'add' ? 'diff-line-add' : line.type === 'del' ? 'diff-line-del' : 'diff-line-ctx';
      row.dataset.lineType = line.type;
      row.append(el('td', line.type === 'del' ? 'diff-gutter-del' : '', line.oldLine === null || line.oldLine === undefined ? '' : String(line.oldLine)));
      row.append(el('td', line.type === 'add' ? 'diff-gutter-add' : '', line.newLine === null || line.newLine === undefined ? '' : String(line.newLine)));
      const glyph = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      row.append(el('td', '', glyph + (line.text ?? '')));
      els.diffBody.append(row);
    }
  }
}

// The checkpoint list. REF INTACT is the server's live measurement; REF DRIFT means the ref no longer
// points where the record says, which is the one thing an owner must know before trusting a restore.
function renderCheckpoints(result) {
  if (!els.checkpointsList) return;
  const owner = ownerStatusText(result, 'the checkpoint ledger');
  if (owner.text) {
    renderList(els.checkpointsList, [], () => null, 'Unavailable: ' + owner.text);
    return;
  }
  const checkpoints = Array.isArray(result.value?.checkpoints) ? result.value.checkpoints : [];
  renderList(els.checkpointsList, checkpoints, (entry) => {
    const li = itemFrom(entry.label || entry.checkpointId,
      shortSha(entry.commitSha) + ' · ' + (entry.wasDirty ? entry.trackedModifiedCount + ' modified tracked' : 'clean tree')
        + (entry.untrackedPaths?.length ? ' · ' + entry.untrackedPaths.length + ' untracked' : '')
        + (entry.restoreCount > 0 ? ' · restored ' + entry.restoreCount + '×' : ''));
    li.dataset.checkpointId = entry.checkpointId;
    li.dataset.refIntact = entry.refIntact === true ? 'true' : 'false';
    const intact = entry.refIntact === true;
    const badge = el('span', 'badge ' + (intact ? 'checkpoint-ref-intact' : 'checkpoint-ref-drift'), intact ? 'REF INTACT' : 'REF DRIFT');
    badge.dataset.refIntact = intact ? 'true' : 'false';
    li.append(badge);
    const actions = el('div', 'row');
    const restore = el('button', 'small', 'Restore');
    restore.type = 'button';
    restore.dataset.action = 'restore-git-checkpoint';
    restore.dataset.checkpointId = entry.checkpointId;
    // A drifted checkpoint is not restorable and the control says so by being disabled, which is
    // clearer than allowing a click that the server will refuse.
    if (!intact) restore.disabled = true;
    const trace = el('button', 'small', 'Trace');
    trace.type = 'button';
    trace.dataset.action = 'trace-git-checkpoint';
    trace.dataset.checkpointId = entry.checkpointId;
    actions.append(restore, trace);
    li.append(actions);
    return li;
  }, 'No checkpoints are recorded yet. A checkpoint records the tree as it is without changing it.');
}

// The host telemetry: the badges, the two tables, and the one summary line.
function renderTelemetry(result) {
  if (!els.telemetryStatus) return;
  const owner = ownerStatusText(result, 'host telemetry');
  if (owner.text) {
    setWorkspaceStatus(els.telemetryStatus, owner.text, owner.state);
    if (els.portTable) els.portTable.textContent = '';
    if (els.processTable) els.processTable.textContent = '';
    return;
  }
  const payload = result.value ?? {};
  const ports = payload.ports ?? {};
  const summary = ports.summary ?? {};
  const processes = payload.processes ?? {};
  const own = processes.apexProcess ?? null;
  const rssMb = own ? Math.round(own.rssBytes / (1024 * 1024)) : null;
  if (els.telemetryTotalBadge) {
    els.telemetryTotalBadge.textContent = 'TOTAL PORTS: ' + (summary.totalListening ?? 0);
    els.telemetryTotalBadge.dataset.count = String(summary.totalListening ?? 0);
  }
  if (els.telemetryLoopbackBadge) {
    els.telemetryLoopbackBadge.textContent = 'LOOPBACK ONLY: ' + (summary.loopbackOnlyCount ?? 0);
    els.telemetryLoopbackBadge.dataset.count = String(summary.loopbackOnlyCount ?? 0);
  }
  if (els.telemetryExposureBadge) {
    els.telemetryExposureBadge.textContent = 'EXTERNAL EXPOSURE: ' + (summary.externalExposureCount ?? 0);
    els.telemetryExposureBadge.dataset.count = String(summary.externalExposureCount ?? 0);
    // The badge is red only when there is something to be red about. A zero in alarm colour would
    // teach the owner to ignore the one colour that should always mean something.
    els.telemetryExposureBadge.dataset.state = (summary.externalExposureCount ?? 0) > 0 ? 'exposed' : 'clear';
  }
  if (els.telemetryRssBadge) {
    els.telemetryRssBadge.textContent = 'APEX RSS: ' + (rssMb === null ? 'unavailable' : rssMb + ' MB');
    els.telemetryRssBadge.dataset.count = rssMb === null ? '' : String(rssMb);
  }
  setWorkspaceStatus(els.telemetryStatus,
    (ports.platform || payload.platform || 'this host') + ' · read at ' + String(payload.inspectedAt ?? '').replace('T', ' ').slice(0, 19)
      + (Array.isArray(ports.notes) && ports.notes.length > 0 ? ' · ' + ports.notes.join('; ') : ''),
    'available');

  if (els.portTable) {
    els.portTable.textContent = '';
    const rows = Array.isArray(ports.ports) ? ports.ports : [];
    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = el('td', 'meta', 'No listening sockets were reported. A reading that could not enumerate them says why above.');
      cell.colSpan = 5;
      row.append(cell);
      els.portTable.append(row);
    }
    for (const entry of rows) {
      const row = document.createElement('tr');
      row.dataset.port = String(entry.localPort);
      row.dataset.exposure = entry.isLoopbackOnly ? 'loopback' : entry.isWildcardBind ? 'wildcard' : 'external';
      row.append(el('td', '', String(entry.localPort)));
      row.append(el('td', '', entry.protocol));
      row.append(el('td', '', entry.localAddress));
      const exposure = entry.isLoopbackOnly ? 'LOOPBACK ONLY' : entry.isWildcardBind ? 'EXTERNAL EXPOSURE' : 'INTERFACE BOUND';
      row.append(el('td', entry.isLoopbackOnly ? 'exposure-loopback' : entry.isWildcardBind ? 'exposure-wildcard' : 'exposure-external', exposure));
      row.append(el('td', '', entry.processName ? entry.processName + (entry.ownedByApex ? ' (APEX)' : '') + (entry.pid ? ' · ' + entry.pid : '') : (entry.pid ? String(entry.pid) : 'not attributed')));
      els.portTable.append(row);
    }
  }

  if (els.processTable) {
    els.processTable.textContent = '';
    const rows = Array.isArray(processes.topProcesses) ? processes.topProcesses : [];
    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = el('td', 'meta', 'The process table could not be read. The reason is stated above rather than shown as an empty list.');
      cell.colSpan = 4;
      row.append(cell);
      els.processTable.append(row);
    }
    for (const entry of rows) {
      const row = document.createElement('tr');
      row.dataset.pid = String(entry.pid);
      if (entry.isApexProcess) row.dataset.apex = 'true';
      row.append(el('td', '', String(entry.pid)));
      row.append(el('td', '', entry.name + (entry.isApexProcess ? ' (APEX)' : '')));
      // tasklist reports no CPU percentage, and a 0 would read as idle rather than as unknown.
      row.append(el('td', '', entry.cpuPct === null || entry.cpuPct === undefined ? '—' : entry.cpuPct + '%'));
      row.append(el('td', '', Math.round(entry.rssBytes / (1024 * 1024)) + ' MB'));
      els.processTable.append(row);
    }
  }

  if (els.processSummary) {
    els.processSummary.textContent = own
      ? 'APEX pid ' + own.pid + ' · ' + own.nodeVersion + ' · up ' + own.uptimeSec + ' s · heap '
        + Math.round(own.heapUsedBytes / (1024 * 1024)) + '/' + Math.round(own.heapTotalBytes / (1024 * 1024)) + ' MB'
        + ' · ' + (processes.cpuCount ?? '—') + ' CPU(s)'
        + (processes.loadAverage === null ? ' · load not reported on this platform' : ' · load ' + processes.loadAverage.join(' / '))
      : 'This process could not read its own memory.';
  }
}

// The fetchers. Each one is fire-and-forget from the refresh path: the deck must never wait on a
// repository read to paint the rest of the screen, and a failure is reported where it belongs rather
// than as a banner over the whole page.
async function refreshGitPanel() {
  const status = await readApi('/api/git/status');
  renderGitStatus(status);
  const [checkpoints] = await Promise.all([readApi('/api/git/checkpoints')]);
  renderCheckpoints(checkpoints);
}

async function refreshTelemetry() {
  const reading = await readApi('/api/system/telemetry?limit=15');
  renderTelemetry(reading);
}

async function inspectDiff() {
  const path = els.gitDiffPathInput ? els.gitDiffPathInput.value.trim() : '';
  const query = path === '' ? '' : '?path=' + encodeURIComponent(path);
  if (els.gitDiffStatus) els.gitDiffStatus.textContent = 'Reading the diff…';
  const result = await readApi('/api/git/diff' + query);
  if (result.ok === false) {
    if (els.gitDiffStatus) els.gitDiffStatus.textContent = 'The diff could not be read: ' + result.error;
    if (els.diffViewer) els.diffViewer.hidden = true;
    return;
  }
  renderDiff(result.value, { path });
  if (els.gitDiffStatus) {
    els.gitDiffStatus.textContent = 'Diff against ' + (result.value.baseRef ?? 'HEAD')
      + (result.value.targetPath ? ' in ' + result.value.targetPath : '')
      + ': +' + (result.value.additions ?? 0) + ' -' + (result.value.deletions ?? 0)
      + (result.value.truncated ? ' (truncated)' : '');
  }
}

async function createCheckpoint() {
  const label = els.gitCheckpointLabel ? els.gitCheckpointLabel.value.trim() : '';
  if (els.gitCheckpointRefusal) { els.gitCheckpointRefusal.hidden = true; els.gitCheckpointRefusal.textContent = ''; }
  if (label === '') {
    if (els.gitCheckpointStatus) els.gitCheckpointStatus.textContent = 'A checkpoint needs a label: it is the name you will recognise in the list.';
    return;
  }
  if (els.gitCheckpointStatus) els.gitCheckpointStatus.textContent = 'Creating the checkpoint…';
  try {
    const created = await api('/api/git/checkpoints', { method: 'POST', body: { label } });
    if (els.gitCheckpointStatus) {
      els.gitCheckpointStatus.textContent = 'Checkpoint ' + created.checkpointId + ' recorded at ' + shortSha(created.commitSha)
        + (created.wasDirty ? ' (the working state was snapshotted; the tree was not touched)' : ' (clean tree)');
    }
    if (els.gitCheckpointLabel) els.gitCheckpointLabel.value = '';
    await refreshGitPanel();
  } catch (error) {
    // A refusal is shown where the act was attempted, with the server's own reason. A step-up refusal
    // and a dirty-tree refusal are both things the owner can act on, so neither is a banner.
    if (els.gitCheckpointStatus) els.gitCheckpointStatus.textContent = 'The checkpoint was refused.';
    if (els.gitCheckpointRefusal) {
      els.gitCheckpointRefusal.hidden = false;
      els.gitCheckpointRefusal.dataset.code = error.code || 'REFUSED';
      els.gitCheckpointRefusal.textContent = (error.code ? error.code + ': ' : '') + String(error.message || error);
    }
  }
}

async function restoreCheckpoint(checkpointId) {
  if (!checkpointId) return;
  if (els.gitCheckpointStatus) els.gitCheckpointStatus.textContent = 'Restoring ' + checkpointId + '…';
  try {
    const restored = await api('/api/git/checkpoints/' + encodeURIComponent(checkpointId) + '/restore',
      { method: 'POST', body: { reason: 'restored from the Workshop panel' } });
    if (els.gitCheckpointStatus) {
      els.gitCheckpointStatus.textContent = 'Restored ' + restored.checkpointId + ' to ' + shortSha(restored.treeSha) + '; verified after the write.';
    }
    await refreshGitPanel();
    await inspectDiff();
  } catch (error) {
    if (els.gitCheckpointStatus) els.gitCheckpointStatus.textContent = 'The restore was refused.';
    if (els.gitCheckpointRefusal) {
      els.gitCheckpointRefusal.hidden = false;
      els.gitCheckpointRefusal.dataset.code = error.code || 'REFUSED';
      // The dirty-tree refusal names the paths it would have discarded; that list is the actionable
      // part, so it is shown rather than summarised.
      const paths = error.detail && Array.isArray(error.detail.dirtyPaths) ? error.detail.dirtyPaths : [];
      els.gitCheckpointRefusal.textContent = (error.code ? error.code + ': ' : '') + String(error.message || error)
        + (paths.length > 0 ? ' Would have discarded: ' + paths.join(', ') + '.' : '');
    }
  }
}

function openCheckpointTrace(checkpointId) {
  if (!checkpointId) return;
  // The Memory screen's trace view already knows how to read a chain; a checkpoint id becomes a link in
  // the one place that reads every ledger rather than a second, private viewer here.
  setView('memory');
  void openTrace(checkpointId, null);
}

// The disk-versus-candidate view. The candidate already carries the summary the sandbox computed when
// it staged the file - a line-level comparison of the bytes on disk at that moment against the proposed
// bytes - so this renders that rather than re-deriving a second answer that could disagree with the one
// the verification was based on. The preview lines already carry their own + and -, so they are parsed
// back into rows here rather than shown as a block of text.
function inspectCandidateDiff(candidate, button) {
  if (!candidate) return;
  const diff = candidate.diff ?? null;
  const preview = Array.isArray(diff?.preview) ? diff.preview : [];
  const rows = [];
  for (const line of preview) {
    const marker = typeof line === 'string' ? line.slice(0, 2) : '';
    const text = typeof line === 'string' ? line.slice(2) : '';
    rows.push({ type: marker === '+ ' ? 'add' : marker === '- ' ? 'del' : 'ctx', oldLine: null, newLine: null, text });
  }
  const payload = {
    isRepo: true,
    targetPath: candidate.relativePath,
    baseRef: 'the file on disk when the candidate was staged',
    staged: false,
    additions: diff?.addedLines ?? null,
    deletions: diff?.removedLines ?? null,
    hunks: rows.length === 0 ? [] : [{
      header: candidate.relativePath + ' — disk versus candidate',
      oldStart: 0,
      oldLines: 0,
      newStart: 0,
      newLines: 0,
      lines: rows,
    }],
  };
  renderDiff(payload, { path: candidate.relativePath });
  if (els.diffViewer) els.diffViewer.dataset.source = 'candidate';
  if (els.gitDiffStatus) {
    els.gitDiffStatus.textContent = diff?.detail
      ? diff.detail
      : candidate.relativePath + ': +' + (diff?.addedLines ?? 0) + ' -' + (diff?.removedLines ?? 0)
        + ' against the file as it was when the candidate was staged'
        + (preview.length > 0 && preview.length < ((diff?.addedLines ?? 0) + (diff?.removedLines ?? 0)) ? ' (first ' + preview.length + ' changed line(s))' : '');
  }
  if (button) {
    // The button does not stay disabled: it is a read, and the owner may want it again after editing.
    button.dataset.inspected = 'true';
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

// T-38 Step 3 (2026-11-21): cross-ledger search and the causal chain inspector.
//
// A result is a record that exists in a ledger. The chain is those records in time order, each one
// labelled with the link that joined it, and a chain that could not reach a task graph says so
// instead of appearing to be the whole story.
const traceState = { results: [], chain: null, lastQuery: null };

const TRACE_KIND_LABELS = {
  memory: 'memory', cognition_run: 'cognitive run', council_session: 'Council session',
  task: 'task graph', workshop_verification: 'sandbox verification', ecp_audit: 'authorized operation',
  // T-39 Step 1: both kinds travel under one label, and the step's own label distinguishes an apply
  // from the rollback that undid it.
  workshop_apply: 'workspace change',
};

// Which identifier on a result can be opened as a chain. A task event that is not the creation
// event has no chain of its own to open; the creation event does.
function traceIdFor(result) {
  if (!result || !result.identity) return null;
  if (result.kind === 'cognition_run') return result.identity.runId ?? null;
  if (result.kind === 'council_session') return result.identity.sessionId ?? null;
  if (result.kind === 'task') return result.identity.taskId ?? null;
  if (result.kind === 'ecp_audit') return result.identity.operationId ?? null;
  // A workspace change opens the chain for its own apply id, which is the id the ledger records.
  if (result.kind === 'workshop_apply') return result.identity.applyId ?? null;
  return null;
}

function renderTraceResults(payload) {
  if (!els.traceResults) return;
  els.traceResults.replaceChildren();
  if (!payload || payload.ok !== true) {
    els.traceResults.append(el('li', 'meta', 'No results.'));
    return;
  }
  if (!payload.results.length) {
    els.traceResults.append(el('li', 'meta',
      payload.total === 0
        ? 'No record in any ledger matches that query.'
        : 'No result to show.'));
    return;
  }
  for (const result of payload.results) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    head.append(el('span', 'badge', TRACE_KIND_LABELS[result.kind] ?? result.kind));
    head.append(el('span', 'meta', result.at ?? 'no timestamp'));
    if (result.epistemicStatus) head.append(el('span', 'badge', result.epistemicStatus));
    item.append(head);
    item.append(el('p', '', result.summary || '(this record has no text of its own)'));
    const traceId = traceIdFor(result);
    if (traceId) {
      const open = el('button', 'small', 'Open chain');
      open.type = 'button';
      open.addEventListener('click', () => { openTrace(traceId, open); });
      item.append(open);
    } else {
      // A memory record has no cross-ledger chain. Saying so is better than a button that does nothing.
      item.append(el('p', 'meta', 'This ledger records no chain of its own.'));
    }
    els.traceResults.append(item);
  }
}

async function runTraceSearch() {
  if (!els.traceSearchStatusLine) return;
  const q = (els.traceSearchQ?.value ?? '').trim();
  const kind = els.traceSearchKind?.value ?? '';
  const epistemicStatus = els.traceSearchStatus?.value ?? '';
  // The query string is built by hand here rather than by serialising a URLSearchParams object: the
  // served client must not contain source-text serialisation, and a literal join is also easier to
  // read in a test.
  const parts = [];
  if (q) parts.push('q=' + encodeURIComponent(q));
  if (kind) parts.push('kind=' + encodeURIComponent(kind));
  if (epistemicStatus) parts.push('epistemicStatus=' + encodeURIComponent(epistemicStatus));
  traceState.lastQuery = { q, kind, epistemicStatus };
  setWorkspaceStatus(els.traceSearchStatusLine, 'Searching every ledger…', 'loading');
  if (els.traceSearchButton) els.traceSearchButton.disabled = true;
  try {
    const data = await api('/api/memory/search' + (parts.length ? '?' + parts.join('&') : ''));
    traceState.results = data.results ?? [];
    renderTraceResults(data);
    // The availability map is reported as it is: a ledger that is not there says it is not there,
    // rather than being counted as a ledger with nothing in it.
    const missing = Object.entries(data.availability ?? {}).filter(([, v]) => v.present === false).map(([k]) => TRACE_KIND_LABELS[k] ?? k);
    const corrupt = Object.entries(data.availability ?? {}).filter(([, v]) => v.corrupt > 0).map(([k]) => TRACE_KIND_LABELS[k] ?? k);
    setWorkspaceStatus(els.traceSearchStatusLine,
      data.total + ' record' + (data.total === 1 ? '' : 's') + ' matched'
      + (data.truncated ? ' (showing the first ' + data.returned + ')' : '')
      + (missing.length ? ' · not present yet: ' + missing.join(', ') : '')
      + (corrupt.length ? ' · corrupt lines in: ' + corrupt.join(', ') : '') + '.',
      'available');
  } catch (error) {
    setWorkspaceStatus(els.traceSearchStatusLine, 'Search failed: ' + error.message, 'error');
    els.traceResults?.replaceChildren(el('li', 'meta', 'No results.'));
  } finally {
    if (els.traceSearchButton) els.traceSearchButton.disabled = false;
  }
}

function renderTraceChain(payload) {
  if (!els.traceChain) return;
  els.traceChain.replaceChildren();
  if (!payload || payload.ok !== true) {
    els.traceChain.append(el('li', 'meta', 'No chain.'));
    return;
  }
  for (const entry of payload.entries) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    head.append(el('span', 'badge', TRACE_KIND_LABELS[entry.kind] ?? entry.kind));
    head.append(el('strong', '', entry.label));
    head.append(el('span', 'meta', entry.at ?? 'no timestamp'));
    if (entry.sameInstantAsPrevious) head.append(el('span', 'badge', 'same instant'));
    item.append(head);
    // The link is named, so a reader can tell a foreign key from a match of text.
    item.append(el('p', 'meta', 'linked by: ' + entry.linkedBy));
    item.append(el('pre', 'code', JSON.stringify(entry.detail, null, 2)));
    els.traceChain.append(item);
  }
}

async function openTrace(id, button) {
  if (!els.traceChainStatus) return;
  if (button) button.disabled = true;
  setWorkspaceStatus(els.traceChainStatus, 'Reading the chain for ' + id + '…', 'loading');
  try {
    const data = await api('/api/memory/trace/' + encodeURIComponent(id));
    traceState.chain = data;
    renderTraceChain(data);
    const counts = data.counts ?? {};
    // T-39 Step 1: the apply count is reported beside the others, and a chain of workspace changes
    // is not treated as a failure. The complete flag means a cognition run and a task graph, which a chain
    // opened from a candidate id or an apply id cannot have by construction - so calling that
    // "partial" in red would report a normal shape as a defect. The status is amber only when the
    // chain is genuinely thin: no run, no task, and nothing else either.
    const applies = counts.applies ?? 0;
    // T-43: a checkpoint chain is substantial when it holds a checkpoint. It has no run and no task by
    // construction, so the flag that says "a chain of records rather than a run" is the honest one and
    // the chain is not painted as a defect.
    const checkpoints = counts.checkpoints ?? 0;
    const substantial = counts.runs > 0 || counts.taskEvents > 0 || applies > 0
      || counts.councilSessions > 0 || counts.verifications > 0 || checkpoints > 0;
    setWorkspaceStatus(els.traceChainStatus,
      (data.complete ? 'Complete chain' : substantial ? 'Chain' : 'Partial chain')
      + ' · ' + counts.runs + ' run(s), ' + counts.councilSessions + ' Council session(s), '
      + counts.taskEvents + ' task event(s), ' + counts.verifications + ' verification(s), '
      + applies + ' workspace change(s), '
      + (checkpoints > 0 ? checkpoints + ' checkpoint(s), ' : '')
      + counts.operations + ' operation(s)'
      + (data.complete ? '' : ' · a chain of records rather than a run; no cognition run names this id')
      + (data.missing?.length ? ' · ' + data.missing.join('; ') : '') + '.',
      data.complete ? 'available' : substantial ? 'available' : 'error');
  } catch (error) {
    // A 404 is "no ledger holds that id", which is a fact about the ledgers rather than a failure.
    setWorkspaceStatus(els.traceChainStatus,
      error.status === 404 ? 'No ledger holds a record for ' + id + '.' : 'Read error: ' + error.message,
      error.status === 404 ? 'unavailable' : 'error');
    els.traceChain?.replaceChildren(el('li', 'meta', 'No chain.'));
  } finally {
    if (button) button.disabled = false;
  }
}

// T-38 Step 2 (2026-11-21): the real file inspector.
//
// Every number on this panel is one the backend measured. A file's bytes, line count and digest come
// from the inspector's reading of the tree; a candidate's verdict comes from the parser's own exit
// code. Nothing here infers a value, and a candidate that has not been verified says so rather than
// showing an empty place where a badge would go.
const wsState = {
  entries: [],
  candidates: [],
  inspectedAt: null,
  // T-40: the last disk reading (null until the page asks for one), the changesets applied in this
  // session, and the busy flag that keeps two batch writes from overlapping.
  disk: null,
  changesets: [],
  changesetBusy: false,
  changesetRefusal: null,
  // The current batch notice and the node that goes with it, so a stale one can be removed.
  changesetNotice: null,
  changesetNoticeNode: null,
};

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return 'unavailable';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function shortDigest(digest) {
  return typeof digest === 'string' ? digest.slice(0, 12) : 'unavailable';
}

function renderWorkspaceEntries() {
  if (!els.wsEntries) return;
  els.wsEntries.replaceChildren();
  if (!wsState.entries.length) {
    els.wsEntries.append(el('li', 'meta', 'No entries to show.'));
    return;
  }
  for (const entry of wsState.entries) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    head.append(el('strong', '', entry.path));
    head.append(el('span', 'meta', entry.kind));
    if (entry.kind === 'file') {
      head.append(el('span', 'meta', formatBytes(entry.bytes) + ' · ' + entry.lines + ' lines'));
      head.append(el('span', 'meta', 'sha256 ' + shortDigest(entry.digest)));
      const open = el('button', 'small', 'Read');
      open.type = 'button';
      open.addEventListener('click', () => { readWorkspaceFile(entry.path, open); });
      head.append(open);
    } else if (entry.kind === 'binary') {
      head.append(el('span', 'meta', 'binary · not read'));
    }
    item.append(head);
    els.wsEntries.append(item);
  }
}

async function readWorkspaceFile(path, button) {
  if (button) button.disabled = true;
  try {
    const data = await api('/api/workshop/file?path=' + encodeURIComponent(path));
    if (els.wsExcerptTitle) {
      els.wsExcerptTitle.textContent = data.path + ' · lines ' + data.startLine + '–' + (data.startLine + data.lines - 1)
        + ' of ' + data.totalLines + ' · sha256 ' + shortDigest(data.digest);
    }
    if (els.wsExcerpt) els.wsExcerpt.textContent = data.excerpt;
    if (els.wsExcerptPanel) els.wsExcerptPanel.hidden = false;
  } catch (error) {
    if (els.wsExcerptTitle) els.wsExcerptTitle.textContent = 'Refused: ' + path;
    // The refusal is shown as the backend phrased it, because the reason is the useful part.
    if (els.wsExcerpt) els.wsExcerpt.textContent = error.message;
    if (els.wsExcerptPanel) els.wsExcerptPanel.hidden = false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function inspectWorkspace() {
  if (!els.wsState) return;
  setWorkspaceStatus(els.wsState, 'Inspecting the workspace…', 'loading');
  if (els.wsRefresh) els.wsRefresh.disabled = true;
  try {
    const data = await api('/api/workshop/workspace');
    wsState.entries = Array.isArray(data.entries) ? data.entries : [];
    // T-39 Step 1: the apply ledger is read beside the file listing, so a badge that says "applied"
    // is a record that exists rather than a memory of a click. A failed read leaves the badges alone
    // instead of clearing them, because "unknown" must not render as "not applied".
    void refreshApplyState();
    wsState.inspectedAt = data.at ?? null;
    renderWorkspaceEntries();
    const files = wsState.entries.filter((e) => e.kind === 'file').length;
    const dirs = wsState.entries.filter((e) => e.kind === 'directory').length;
    const skipped = wsState.entries.filter((e) => e.skipped === true).length;
    setWorkspaceStatus(els.wsState,
      'Read ' + files + ' file' + (files === 1 ? '' : 's') + ' in ' + dirs + ' director' + (dirs === 1 ? 'y' : 'ies')
      + (skipped ? ', skipped ' + skipped + ' unreadable or binary' : '')
      + (data.truncated ? ' (listing truncated at the bound)' : '') + '.', 'available');
  } catch (error) {
    // An unavailable workspace is a state, not an empty tree.
    setWorkspaceStatus(els.wsState,
      error.status === 503 ? 'Unavailable: no workspace root is configured.' : 'Read error: ' + error.message,
      error.status === 503 ? 'unavailable' : 'error');
    wsState.entries = [];
    renderWorkspaceEntries();
  } finally {
    if (els.wsRefresh) els.wsRefresh.disabled = false;
  }
}

// T-42 Step 4: the candidate list is the server's, not this tab's.
//
// Until this existed, wsState.candidates only held what *this page* had staged in its own form. A
// candidate staged on the server - by the Evolution Lab's "Stage to Workshop" button, by another tab,
// or by anything else - was invisible until a reload, so its provenance badge could not render and the
// t41 walk waited 30 s for a [data-source-proposal] element that was never going to be appended.
// The failure was real and the product was wrong, not the walk: the Workshop's own list has to show
// what the Workshop actually holds.
//
// The merge is careful about three things. A candidate the page already holds keeps its own bookkeeping
// (selection, verification, drift, applied) because those are answers this tab received and the listing
// does not repeat them. sourceProposalId is taken from the record when the page has none, so a
// server-staged candidate carries its provenance. Order is the server's - newest first - with any
// page-only candidate it does not know about kept at the front, where it was unshifted.
function hydrateCandidates(listing) {
  if (!Array.isArray(listing)) return false;
  const known = new Map(wsState.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const merged = listing.map((record) => {
    const existing = known.get(record.candidateId) ?? null;
    if (existing) {
      // The listing is authoritative about what the record says; the page is authoritative about
      // what the page was told. Neither overwrites the other's field.
      if (!existing.sourceProposalId && record.sourceProposalId) existing.sourceProposalId = record.sourceProposalId;
      if (existing.hasSandboxTest !== true && record.hasSandboxTest === true) existing.hasSandboxTest = true;
      return existing;
    }
    return {
      candidateId: record.candidateId,
      relativePath: record.relativePath,
      digest: record.digest,
      bytes: record.bytes,
      lines: record.lines,
      diff: record.diff ?? null,
      hasSandboxTest: record.hasSandboxTest === true,
      sourceProposalId: typeof record.sourceProposalId === 'string' ? record.sourceProposalId : null,
      baseDigest: record.baseDigest ?? null,
      verification: record.verified === true ? { passed: true, fromListing: true } : null,
      applied: null,
      drift: null,
      fromListing: true,
    };
  });
  // Anything this page staged that the listing has not caught up with is kept, not dropped.
  const listedIds = new Set(merged.map((candidate) => candidate.candidateId));
  const pageOnly = wsState.candidates.filter((candidate) => !listedIds.has(candidate.candidateId));
  const next = [...pageOnly, ...merged];
  const previous = wsState.candidates;
  const changed = next.length !== previous.length
    || next.some((candidate, index) => candidate !== previous[index]);
  wsState.candidates = next;
  return changed;
}

// Read the candidate ledger the Workshop holds and fold it into the page's own list. Read-only.
async function refreshCandidateListing() {
  if (!els.wsCandidates) return;
  try {
    const listing = await api('/api/workshop');
    if (hydrateCandidates(Array.isArray(listing && listing.candidates) ? listing.candidates : [])) renderCandidates();
    void refreshApplyState();
  } catch (error) {
    // The listing is an enhancement; the stage form works without it. But a silent catch here once
    // hid a real defect for a whole hosted run, so the failure is reported where a reader can see it.
    if (typeof console !== 'undefined' && console.warn) console.warn('candidate listing unavailable: ' + String(error && error.message ? error.message : error));
  }
}

// Read what the apply ledger says and attach it to the candidates this page holds. Nothing is
// written and no digest is invented: a candidate with no record simply has no applied badge.
async function refreshApplyState() {
  if (wsState.candidates.length === 0) return;
  try {
    const status = await api('/api/workshop/applies');
    const recent = Array.isArray(status.recent) ? status.recent : [];
    for (const candidate of wsState.candidates) {
      // An apply this page already knows about is not downgraded by a later read: the ledger keeps
      // both, and the newest open one is what the rollback control should point at.
      if (candidate.applied) continue;
      const record = recent.find((entry) => entry.candidateId === candidate.candidateId && entry.rolledBack !== true);
      if (!record) continue;
      candidate.applied = {
        applyId: record.applyId,
        relativePath: record.relativePath,
        appliedSha256: record.appliedSha256,
        beforeSha256: record.beforeSha256,
        backupId: record.applyId,
        // The ledger records that the apply re-read the file and compared. Whether the file still
        // matches today is a fresh question, and the screen does not answer it from a stale record.
        verifiedOnDisk: true,
      };
      // T-40 Step 1: the ledger read now carries the disk's own answer, measured when the ledger was
      // read. It is attached rather than inferred, and it is labelled with the moment it was taken.
      candidate.live = record.live ?? null;
    }
    renderCandidates();
  } catch {
    // The ledger read is an enhancement; the sandbox panel works without it.
  }
}

function renderCandidates() {
  if (!els.wsCandidates) return;
  els.wsCandidates.replaceChildren();
  if (!wsState.candidates.length) {
    els.wsCandidates.append(el('li', 'meta', 'No candidates staged in this page session.'));
    return;
  }
  for (const candidate of wsState.candidates) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    // T-40 Step 2: selection for the batch apply. Enabled only for a candidate the backend verified,
    // because the backend refuses an unverified one and the control should say so before it is pressed.
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.dataset.selectCandidate = candidate.candidateId;
    const candidateVerified = candidate.verification && candidate.verification.verified === true;
    pick.disabled = !candidateVerified || Boolean(candidate.applied) || Boolean(candidate.busy);
    pick.checked = candidateVerified && !candidate.applied ? Boolean(candidate.selected) : false;
    pick.setAttribute('aria-label', 'select ' + candidate.relativePath + ' for the changeset');
    pick.addEventListener('change', () => {
      candidate.selected = pick.checked;
      // A new selection makes any previous refusal or result stale, so it is dropped here rather than
      // lingering over a batch that is no longer the one it described.
      clearChangesetNotice();
      updateChangesetControls();
    });
    head.append(pick);
    head.append(el('strong', '', candidate.relativePath));
    const idNode = el('span', 'meta', candidate.candidateId);
    idNode.dataset.candidateId = candidate.candidateId;
    head.append(idNode);
    // The badge is the backend's verdict, not a local guess.
    const verified = candidate.verification && candidate.verification.verified === true;
    const failed = candidate.verification && candidate.verification.verified === false;
    const badge = el('span', verified ? 'badge badge-ok' : failed ? 'badge badge-bad' : 'badge',
      verified ? 'verified' : failed ? 'not verified' : 'not checked');
    head.append(badge);
    const check = el('button', 'small', 'Verify');
    check.type = 'button';
    check.disabled = Boolean(candidate.busy);
    check.addEventListener('click', () => { verifyCandidate(candidate.candidateId, check); });
    head.append(check);
    const promote = el('button', 'small', 'Promote');
    promote.type = 'button';
    // Promotion stays disabled until this page has seen verified: true from the backend. The server
    // refuses anyway; this is only so the button never advertises an action that will be refused.
    promote.disabled = !verified || Boolean(candidate.busy);
    promote.addEventListener('click', () => { promoteCandidate(candidate.candidateId, promote); });
    head.append(promote);
    // T-43 Package 3: the live disk-versus-candidate diff. It reads the file as it is on disk and the
    // candidate's staged content and renders the difference in the one diff viewer, so a reader compares
    // two real byte strings rather than a summary of them.
    const diffButton = el('button', 'small', 'Inspect Diff');
    diffButton.type = 'button';
    diffButton.dataset.action = 'diff-candidate';
    diffButton.dataset.candidateId = candidate.candidateId;
    diffButton.addEventListener('click', () => { void inspectCandidateDiff(candidate, diffButton); });
    head.append(diffButton);
    // T-39 Step 1: the apply control. It is enabled only after the backend reported verified true,
    // because a button that can only be refused teaches the owner to distrust the refusal.
    const applyButton = el('button', 'small', 'Apply to Workspace');
    applyButton.type = 'button';
    applyButton.dataset.applyCandidate = candidate.candidateId;
    applyButton.disabled = !verified || Boolean(candidate.busy) || Boolean(candidate.applied);
    applyButton.addEventListener('click', () => { applyCandidate(candidate.candidateId, applyButton); });
    head.append(applyButton);
    item.append(head);

    // What the apply would write, stated as the two digests the gate compares. The base reads as
    // absent rather than a placeholder digest when the file does not exist yet.
    const base = candidate.baseDigest ?? null;
    item.append(el('p', 'meta',
      'base ' + (base ? shortDigest(base) : 'absent (the file does not exist yet)')
      + ' -> candidate ' + shortDigest(candidate.digest)));

    // The applied badge, and the backup reference. Both come from the ledger, never from a local
    // guess, so a reload shows the same state as the click did.
    if (candidate.applied) {
      const applied = candidate.applied;
      const appliedBadge = el('span', applied.verifiedOnDisk ? 'badge badge-ok' : 'badge badge-bad',
        applied.verifiedOnDisk ? 'Applied to workspace — disk SHA-256 verified' : 'Applied, but the disk digest did not match');
      const line = el('div', 'row');
      line.append(appliedBadge);
      line.append(el('span', 'meta', applied.applyId));
      item.append(line);
      item.append(el('p', 'meta',
        'applied sha256 ' + shortDigest(applied.appliedSha256 ?? null)
        + ' · backup ' + (applied.backupId ?? 'n/a')
        + (applied.beforeSha256 ? ' (holds ' + shortDigest(applied.beforeSha256) + ')' : ' (the file did not exist before)')));
      const undo = el('button', 'small', 'Rollback to Prior File');
      undo.type = 'button';
      undo.dataset.rollbackApply = applied.applyId;
      undo.disabled = Boolean(candidate.busy);
      undo.addEventListener('click', () => { rollbackApply(applied.applyId, candidate.candidateId, undo); });
      item.append(undo);

      // T-40 Step 1: what the disk holds NOW. This is only ever drawn from a measurement the backend
      // sent - never inferred from the fact that an apply once succeeded - and it says which state it
      // was drawn from when the page has not re-read the disk.
      const live = candidate.live ?? null;
      const liveLine = el('div', 'row');
      if (live) {
        const stateBadge = el('span', live.state === 'intact' ? 'badge badge-ok' : 'badge badge-bad', live.state.replace(/_/g, ' '));
        stateBadge.dataset.liveState = live.state;
        liveLine.append(stateBadge);
        liveLine.append(el('span', 'meta', 'measured ' + live.checkedAt));
        item.append(liveLine);
        item.append(el('p', 'meta', live.detail ?? ''));
        // Both digests, named, whenever the file is not intact. A "drifted" badge without the two
        // digests is a riddle rather than a diagnosis.
        if (live.state !== 'intact') {
          item.append(el('p', 'meta', 'applied ' + (live.appliedSha256 ?? 'n/a')
            + ' · on disk ' + (live.currentDiskSha256 ?? 'absent')));
        }
        if (live.state === 'modified_externally') {
          item.append(el('p', 'meta', 'A rollback would refuse with ROLLBACK_DRIFT while the file is in this state. Your edit is intact.'));
        }
      } else {
        liveLine.append(el('span', 'badge', 'disk not re-read'));
        liveLine.append(el('span', 'meta', 'Press Check Disk Status to measure it.'));
        item.append(liveLine);
      }
    }

    // A refusal that names the two digests is a diagnosis; one that says "drift" is a riddle. The
    // route sends both, and this renders what it sent without inventing a value it did not.
    if (candidate.drift) {
      const drift = candidate.drift;
      const box = el('div', 'work-item diagnostic');
      box.append(el('strong', '', 'Refused: ' + (drift.code === 'ROLLBACK_DRIFT'
        ? 'the file changed after it was applied'
        : 'the file changed after this candidate was staged')));
      box.append(el('p', 'meta', 'expected ' + (drift.expected ?? 'unknown')));
      box.append(el('p', 'meta', 'actual on disk ' + (drift.actual ?? 'unknown')));
      box.append(el('p', 'meta', drift.detail ?? 'Nothing was written. Re-inspect the file, stage a fresh candidate, and verify it again.'));
      item.append(box);
    }

    // T-42 Step 1: the provenance badge. A candidate that came from an Evolution Lab proposal says so,
    // and one that did not says nothing - an "unknown source" line on every panel-staged card would be
    // noise pretending to be information.
    if (candidate.sourceProposalId) {
      const from = el('span', 'badge badge-ok', 'from proposal ' + candidate.sourceProposalId);
      from.dataset.sourceProposal = candidate.sourceProposalId;
      item.append(from);
      // And the trace link the milestone is built on: the chain can be opened from the card.
      item.append(el('p', 'meta', 'provenance: Evolution Lab proposal ' + candidate.sourceProposalId
        + ' → this candidate → sandbox verification → apply'));
    }
    item.append(el('p', 'meta',
      'sha256 ' + shortDigest(candidate.digest) + ' · staged ' + formatBytes(candidate.bytes)
      + ' · ' + candidate.lines + ' lines · diff +' + (candidate.diff?.addedLines ?? '?')
      + '/-' + (candidate.diff?.removedLines ?? '?')));
    if (candidate.verification) {
      const parser = candidate.verification.parser ?? {};
      item.append(el('p', 'meta',
        'parser ' + (parser.kind ?? 'n/a') + ' · ran ' + (parser.ran === true ? 'yes' : 'no')
        + ' · exit ' + (parser.exitCode === null || parser.exitCode === undefined ? 'n/a' : parser.exitCode)
        + ' · ' + candidate.verification.passed + '/' + candidate.verification.total + ' checks passed'));
      const failure = candidate.verification.checks?.find((c) => c.passed === false);
      if (failure) item.append(el('pre', 'code', failure.id + ': ' + failure.detail));
      // The parser's own words, verbatim - this is the message that names the broken line.
      if (parser.stderr) item.append(el('pre', 'code', parser.stderr));

      // T-41 Step 2: what the sandbox test measured. A verification without one says so rather than
      // showing a green line that implies behaviour was checked when it was not.
      const sandboxTest = candidate.verification.sandboxTestResult;
      if (sandboxTest) {
        item.append(el('p', 'meta',
          'sandbox test · exit ' + (sandboxTest.exitCode === null ? 'n/a' : sandboxTest.exitCode)
          + ' · ' + sandboxTest.passedCount + ' passed, ' + sandboxTest.failedCount + ' failed'
          + ' · ' + sandboxTest.durationMs + ' ms'
          + (sandboxTest.timedOut ? ' · timed out' : '')
          + (sandboxTest.mutatedLiveWorkspace === true ? ' · WROTE TO THE WORKSPACE' : '')));
        // The failing output, verbatim, because the reason an assertion failed is the only thing the
        // owner can act on. Truncated by the backend, never by this renderer.
        if (sandboxTest.outputExcerpt) item.append(el('pre', 'code', sandboxTest.outputExcerpt));
      } else if (candidate.hasSandboxTest) {
        item.append(el('p', 'meta', 'a companion test was staged but has not been run yet'));
      } else {
        item.append(el('p', 'meta', 'no companion test was staged: behaviour was not exercised'));
      }
    }
    els.wsCandidates.append(item);
  }
}

// T-40 Step 1: the live disk check. It asks the backend to measure every applied file against the
// disk at this instant and attaches the answer to the rows by candidate id, so a reloaded page and a
// pressed button show the same facts.
async function checkDiskStatus() {
  if (!els.wsDiskState) return;
  if (els.wsCheckDisk) els.wsCheckDisk.disabled = true;
  setWorkspaceStatus(els.wsDiskState, 'Re-reading every applied file from disk…', 'loading');
  try {
    const data = await api('/api/workshop/applies/status');
    wsState.disk = data;
    // The applied files, by relative path: a changeset's files are not candidates this page staged,
    // and they still belong on the panel.
    const byCandidate = new Map();
    const byPath = new Map();
    for (const state of Array.isArray(data.states) ? data.states : []) {
      if (state.candidateId) byCandidate.set(state.candidateId, state);
      byPath.set(state.relativePath, state);
    }
    for (const candidate of wsState.candidates) {
      if (!candidate.applied) continue;
      candidate.live = byCandidate.get(candidate.candidateId) ?? byPath.get(candidate.applied.relativePath) ?? null;
    }
    renderCandidates();
    renderDiskStatus(data);
    const counts = data.counts ?? {};
    setWorkspaceStatus(els.wsDiskState,
      data.open === 0
        ? 'No applied file is being tracked, so there is nothing to re-read.'
        : data.allIntact
          ? 'All ' + data.open + ' applied files still match what was written.'
          : data.open + ' applied files re-read: ' + Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([state, n]) => n + ' ' + state.replace(/_/g, ' '))
              .join(', ') + '.',
      data.allIntact || data.open === 0 ? 'available' : 'error');
  } catch (error) {
    wsState.disk = null;
    renderDiskStatus(null);
    setWorkspaceStatus(els.wsDiskState, 'The disk could not be re-read: ' + (error.message ?? 'the server refused it'), 'error');
  } finally {
    if (els.wsCheckDisk) els.wsCheckDisk.disabled = false;
  }
}

function renderDiskStatus(data) {
  if (!els.wsDiskStatus) return;
  els.wsDiskStatus.replaceChildren();
  if (!data) {
    els.wsDiskStatus.append(el('li', 'meta', 'No disk reading in this page yet.'));
    return;
  }
  const states = Array.isArray(data.states) ? data.states : [];
  if (states.length === 0) {
    els.wsDiskStatus.append(el('li', 'meta', 'No applied file is being tracked.'));
    return;
  }
  for (const state of states) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    head.append(el('strong', '', state.relativePath));
    const badge = el('span', state.state === 'intact' ? 'badge badge-ok' : 'badge badge-bad', state.state.replace(/_/g, ' '));
    badge.dataset.diskState = state.state;
    head.append(badge);
    head.append(el('span', 'meta', state.applyId));
    item.append(head);
    item.append(el('p', 'meta', state.detail ?? ''));
    // Full digests, not shortened ones. This row exists to be compared with a file the owner hashed,
    // and a 12-character prefix cannot be compared with anything.
    item.append(el('p', 'meta',
      'applied ' + (state.appliedSha256 ?? 'n/a')
      + ' · on disk ' + (state.currentDiskSha256 ?? 'absent')));
    els.wsDiskStatus.append(item);
  }
}

// T-40 Step 2: enabling the batch control only when the backend would accept the batch. Two is the
// backend's own floor; the button reads it rather than choosing a different one.
function selectedCandidates() {
  return wsState.candidates.filter((candidate) => candidate.selected === true);
}

// A refusal and a result both outrank the selection summary.
//
// This exists because the first hosted walk failed here: the batch was refused correctly and the
// refusal was rendered correctly, and then the function below - which runs in the same finally block -
// overwrote it with "2 selected: ..." before a human could read it. The same bug would have erased the
// success message. So a notice is held until something the owner does clears it, which is exactly the
// moment the notice stops being current.
function clearChangesetNotice() {
  if (wsState.changesetNoticeNode && wsState.changesetNoticeNode.parentNode) {
    wsState.changesetNoticeNode.parentNode.removeChild(wsState.changesetNoticeNode);
  }
  wsState.changesetNoticeNode = null;
  wsState.changesetNotice = null;
}

function setChangesetNotice(text, tone, node = null) {
  clearChangesetNotice();
  wsState.changesetNotice = { text, tone };
  if (!els.wsChangesetState) return;
  setWorkspaceStatus(els.wsChangesetState, text, tone);
  if (node) {
    els.wsChangesetState.after(node);
    wsState.changesetNoticeNode = node;
  }
}

function updateChangesetControls() {
  const selected = selectedCandidates();
  if (els.wsApplyChangeset) els.wsApplyChangeset.disabled = selected.length < 2 || Boolean(wsState.changesetBusy);
  if (!els.wsChangesetState) return;
  if (wsState.changesetBusy) return;
  // A notice is still current until the owner changes the selection or starts another attempt.
  if (wsState.changesetNotice) return;
  if (selected.length === 0) {
    setWorkspaceStatus(els.wsChangesetState, 'Select two or more verified candidates to apply them as one change.', 'idle');
    return;
  }
  setWorkspaceStatus(els.wsChangesetState,
    selected.length + ' selected: ' + selected.map((c) => c.relativePath).join(', ')
    + (selected.length < 2 ? ' — a changeset needs at least two files.' : ''),
    selected.length < 2 ? 'idle' : 'available');
}

async function applyChangeset(button) {
  const selected = selectedCandidates();
  if (selected.length < 2) {
    if (els.wsChangesetState) setWorkspaceStatus(els.wsChangesetState, 'A changeset needs at least two files, so nothing was sent.', 'error');
    return;
  }
  const rationale = window.prompt(
    'This writes ' + selected.length + ' files into your workspace as one all-or-nothing change. If any file fails its check, none of them are written. Type a reason to apply:');
  if (!rationale || !rationale.trim()) {
    if (els.wsChangesetState) setWorkspaceStatus(els.wsChangesetState, 'A changeset needs your reason, so nothing was written.', 'error');
    return;
  }
  const title = (els.wsChangesetTitle?.value ?? '').trim() || 'changeset of ' + selected.length + ' files';
  clearChangesetNotice();
  wsState.changesetBusy = true;
  if (button) button.disabled = true;
  if (els.wsChangesetState) setWorkspaceStatus(els.wsChangesetState, 'Applying ' + selected.length + ' files as one change…', 'loading');
  try {
    const data = await api('/api/workshop/changesets/apply', {
      method: 'POST',
      body: { candidateIds: selected.map((c) => c.candidateId), title, rationale: rationale.trim() },
    });
    for (const candidate of selected) candidate.selected = false;
    wsState.changesets.unshift(data);
    // Every file in the batch is now applied; the rows say so from the response, not from hope.
    for (const file of Array.isArray(data.files) ? data.files : []) {
      const candidate = wsState.candidates.find((c) => c.candidateId === file.candidateId);
      if (!candidate) continue;
      candidate.applied = {
        applyId: data.changesetId,
        relativePath: file.relativePath,
        appliedSha256: file.appliedSha256,
        beforeSha256: file.beforeSha256,
        backupId: data.changesetId,
        verifiedOnDisk: file.verifiedOnDisk === true,
      };
      candidate.live = {
        state: 'intact',
        checkedAt: data.at,
        appliedSha256: file.appliedSha256,
        currentDiskSha256: file.diskSha256 ?? file.appliedSha256,
        detail: 'Written by ' + data.changesetId + ' and read back from disk immediately afterwards.',
      };
    }
    renderCandidates();
    renderChangesets();
    setChangesetNotice(
      'Applied ' + data.fileCount + ' files atomically as ' + data.changesetId + '. Each was read back from disk and matched.',
      'available');
    // The ledger is the source of truth for what is open; re-read it rather than trusting this page.
    void refreshApplyState();
  } catch (error) {
    // A pre-flight refusal is not one file's problem, it is the batch's, and the response names which
    // file failed and both digests. That is rendered where the owner pressed the button.
    const problems = Array.isArray(error.problems) ? error.problems : [];
    const first = problems[0] ?? null;
    const box = el('div', 'work-item diagnostic');
    box.append(el('strong', '', 'Changeset refused: ' + (error.code ?? 'CHANGESET_PREFLIGHT_REFUSED')));
    box.append(el('p', 'meta', error.message ?? 'the server refused it'));
    if (first) {
      box.append(el('p', 'meta', 'first refused file: ' + (first.relativePath ?? first.candidateId ?? 'unknown') + ' — ' + (first.detail ?? first.reason ?? '')));
      if (first.expectedBaseSha256 !== undefined) box.append(el('p', 'meta', 'expected base ' + (first.expectedBaseSha256 ?? 'absent')));
      if (first.actualDiskSha256 !== undefined) box.append(el('p', 'meta', 'on disk ' + (first.actualDiskSha256 ?? 'absent')));
    }
    box.append(el('p', 'meta', 'No file was written: the pre-flight runs before the first byte.'));
    wsState.changesetRefusal = { code: error.code ?? null, first, problems };
    // The refusal is held as a notice so the finally block below cannot paint over it, and the
    // diagnostic box is kept beside it and removed when the notice is cleared.
    setChangesetNotice(
      'Changeset refused before writing anything' + (first ? ': ' + (first.relativePath ?? first.candidateId) : '') + '.',
      'error', box);
  } finally {
    wsState.changesetBusy = false;
    if (button) button.disabled = false;
    updateChangesetControls();
    renderCandidates();
  }
}

async function rollbackChangeset(changesetId, button) {
  const reason = window.prompt(
    'This restores every file in the changeset to the bytes it had before the batch was applied. If any file was edited outside APEX, the whole rollback is refused. Type a reason to roll back:');
  if (!reason || !reason.trim()) {
    if (els.wsChangesetState) setWorkspaceStatus(els.wsChangesetState, 'A batch rollback needs your reason, so no file was restored.', 'error');
    return;
  }
  if (button) button.disabled = true;
  clearChangesetNotice();
  wsState.changesetBusy = true;
  try {
    const data = await api('/api/workshop/changesets/' + encodeURIComponent(changesetId) + '/rollback', {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    wsState.changesets = wsState.changesets.filter((entry) => entry.changesetId !== changesetId);
    for (const file of Array.isArray(data.files) ? data.files : []) {
      const candidate = wsState.candidates.find((c) => c.applied && c.applied.applyId === changesetId && c.relativePath === file.relativePath);
      if (!candidate) continue;
      candidate.applied = null;
      candidate.live = null;
      candidate.selected = false;
      candidate.drift = null;
    }
    // A candidate the changeset created no longer exists on disk; the row should not claim otherwise.
    renderCandidates();
    renderChangesets();
    setChangesetNotice(
      'Rolled back ' + data.fileCount + ' files. Each holds the bytes it had before the changeset, verified on disk.',
      'available');
  } catch (error) {
    const problems = Array.isArray(error.problems) ? error.problems : [];
    const first = problems[0] ?? null;
    setChangesetNotice(
      'Batch rollback refused: ' + (error.code ?? 'CHANGESET_ROLLBACK_DRIFT')
      + (first ? ' — ' + (first.relativePath ?? '') + ' is not what the changeset wrote' : '')
      + '. No file was restored; your edit is intact.',
      'error');
  } finally {
    wsState.changesetBusy = false;
    if (button) button.disabled = false;
    renderChangesets();
  }
}

function renderChangesets() {
  if (!els.wsChangesets) return;
  els.wsChangesets.replaceChildren();
  if (!wsState.changesets.length) {
    els.wsChangesets.append(el('li', 'meta', 'No changeset applied in this page session.'));
    return;
  }
  for (const changeset of wsState.changesets) {
    const item = el('li', 'work-item');
    const head = el('div', 'row');
    head.append(el('strong', '', changeset.title || changeset.changesetId));
    head.append(el('span', 'meta', changeset.changesetId));
    head.append(el('span', 'badge badge-ok', changeset.fileCount + ' files, atomic'));
    item.append(head);
    item.append(el('p', 'meta', changeset.files.map((file) => file.relativePath).join(' · ')));
    // Each file with the digest the batch wrote, in full, so this panel can be checked against the
    // ledger and against the disk rather than merely admired.
    for (const file of Array.isArray(changeset.files) ? changeset.files : []) {
      item.append(el('p', 'meta', file.relativePath + ' · applied ' + (file.appliedSha256 ?? 'n/a')
        + (typeof file.beforeSha256 === 'string' ? ' · before ' + file.beforeSha256 : '')));
    }
    item.append(el('p', 'meta', 'applied ' + changeset.at + ' · every file verified on disk: ' + (changeset.everyFileVerifiedOnDisk ? 'yes' : 'no')));
    const undo = el('button', 'small', 'Rollback Changeset');
    undo.type = 'button';
    undo.dataset.rollbackChangeset = changeset.changesetId;
    undo.addEventListener('click', () => { rollbackChangeset(changeset.changesetId, undo); });
    item.append(undo);
    els.wsChangesets.append(item);
  }
}

async function stageCandidate() {
  if (!els.wsStageStatus) return;
  const relativePath = (els.wsStagePath?.value ?? '').trim();
  const proposedContent = els.wsStageContent?.value ?? '';
  const rationale = (els.wsStageRationale?.value ?? '').trim();
  // T-41 Step 2: the companion test travels with the candidate into the sandbox. An empty box is
  // null, not an empty string - the difference is "no behavioural check was staged" versus "a check
  // that asserts nothing", and only the first is honest.
  const testContent = (els.wsStageTest?.value ?? '').trim().length > 0 ? els.wsStageTest.value : null;
  if (!relativePath) {
    setWorkspaceStatus(els.wsStageStatus, 'A relative path is required.', 'error');
    return;
  }
  setWorkspaceStatus(els.wsStageStatus, 'Staging ' + relativePath + ' in the sandbox…', 'loading');
  if (els.wsStageSubmit) els.wsStageSubmit.disabled = true;
  try {
    const data = await api('/api/workshop/stage', {
      method: 'POST',
      // T-41 Step 2: the companion test is sent when there is one. It was computed and then dropped
      // from this body in the first version, so the sandbox never received a test, hasSandboxTest
      // came back false, and the T-41 walk failed at its own staging step while every backend test
      // passed - the field existed, the wiring did not.
      body: { relativePath, proposedContent, ...(rationale ? { rationale } : {}), ...(testContent ? { testContent } : {}) },
    });
    wsState.candidates.unshift({
      candidateId: data.candidateId,
      relativePath: data.relativePath,
      digest: data.digest,
      bytes: data.bytes,
      lines: data.lines,
      diff: data.diff,
      hasSandboxTest: data.hasSandboxTest === true,
      // T-42 Step 1: provenance from the Evolution Lab, when the candidate was staged by the bridge.
      sourceProposalId: typeof data.sourceProposalId === 'string' ? data.sourceProposalId : null,
      // The base digest the apply gate will compare against; null when the file does not exist yet.
      baseDigest: data.base?.exists === true ? (data.base.digest ?? null) : null,
      verification: null,
      applied: null,
      drift: null,
    });
    renderCandidates();
    setWorkspaceStatus(els.wsStageStatus,
      'Staged ' + data.candidateId + '. The live file is unchanged; verify to run '
      + (data.hasSandboxTest === true ? 'the parser and the sandbox test.' : 'the parser.'), 'available');
  } catch (error) {
    setWorkspaceStatus(els.wsStageStatus, 'Refused: ' + error.message, 'error');
  } finally {
    if (els.wsStageSubmit) els.wsStageSubmit.disabled = false;
  }
}

async function verifyCandidate(candidateId, button) {
  const candidate = wsState.candidates.find((c) => c.candidateId === candidateId);
  if (button) button.disabled = true;
  if (candidate) candidate.busy = true;
  renderCandidates();
  try {
    const data = await api('/api/workshop/verify-file', { method: 'POST', body: { candidateId } });
    if (candidate) {
      candidate.verification = data;
      // The rendered badge follows the record written to the sandbox, not the response alone.
      candidate.verifiedOnRecord = data.verified === true;
    }
    renderCandidates();
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus, data.verified
        ? 'Verified ' + candidateId + ' — the parser exited 0 and every check passed.'
        : 'Not verified: ' + (data.failed?.join(', ') ?? 'a check failed') + '. Promotion is refused.',
      data.verified ? 'available' : 'error');
    }
  } catch (error) {
    if (els.wsStageStatus) setWorkspaceStatus(els.wsStageStatus, 'Verification failed: ' + error.message, 'error');
  } finally {
    if (candidate) candidate.busy = false;
    renderCandidates();
  }
}

// T-39 Step 1: apply a verified candidate to the live workspace, and undo it.
//
// Both need the owner's reason, because both are audited acts rather than preferences. Neither is
// ever reported as done before the backend says it was verified: verifiedOnDisk is read from the
// response, and a refusal is rendered as the digests the server sent rather than as a generic error.
async function applyCandidate(candidateId, button) {
  if (button) button.disabled = true;
  const reason = window.prompt(
    'This writes the candidate into your workspace file. The previous bytes are saved first, so it can be rolled back. Type a reason to apply:');
  if (!reason || !reason.trim()) {
    if (button) button.disabled = false;
    if (els.wsStageStatus) setWorkspaceStatus(els.wsStageStatus, 'An apply needs your reason, so nothing was written.', 'error');
    return;
  }
  const candidate = wsState.candidates.find((c) => c.candidateId === candidateId);
  try {
    const data = await api('/api/workshop/candidates/' + encodeURIComponent(candidateId) + '/apply', {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    if (candidate) {
      candidate.applied = data;
      candidate.drift = null;
    }
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus,
        'Applied ' + data.relativePath + ' to the workspace. Disk SHA-256 ' + shortDigest(data.appliedSha256)
        + ' was read back and matched. Backup ' + data.backupId + '.', 'available');
    }
  } catch (error) {
    // A drift refusal carries both digests; anything else is reported as the server phrased it.
    if (candidate && typeof error.expectedBaseSha256 !== 'undefined') {
      candidate.drift = {
        code: error.code ?? 'WORKSPACE_DRIFT',
        expected: error.expectedBaseSha256 ?? 'absent',
        actual: error.actualDiskSha256 ?? 'absent',
        detail: 'The file changed on disk after this candidate was staged. Nothing was written.',
      };
    }
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus, 'Apply refused: ' + (error.message ?? 'the server refused it') + '. Nothing was written.', 'error');
    }
  } finally {
    if (candidate) candidate.busy = false;
    renderCandidates();
  }
}

async function rollbackApply(applyId, candidateId, button) {
  if (button) button.disabled = true;
  const reason = window.prompt('This restores the bytes the apply replaced. Type a reason to roll back:');
  if (!reason || !reason.trim()) {
    if (button) button.disabled = false;
    if (els.wsStageStatus) setWorkspaceStatus(els.wsStageStatus, 'A rollback needs your reason, so the file is unchanged.', 'error');
    return;
  }
  const candidate = wsState.candidates.find((c) => c.candidateId === candidateId);
  try {
    const data = await api('/api/workshop/applies/' + encodeURIComponent(applyId) + '/rollback', {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    if (candidate) {
      candidate.applied = null;
      candidate.drift = null;
    }
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus, data.removedFile
        ? 'Rolled back ' + data.relativePath + ' — the file the apply created has been removed, and its absence was confirmed.'
        : 'Rolled back ' + data.relativePath + ' to ' + shortDigest(data.restoredSha256) + ', the digest it had before the apply.',
      'available');
    }
  } catch (error) {
    if (candidate && typeof error.expectedAppliedSha256 !== 'undefined') {
      candidate.drift = {
        code: error.code ?? 'ROLLBACK_DRIFT',
        expected: error.expectedAppliedSha256 ?? 'unknown',
        actual: error.actualDiskSha256 ?? 'absent',
        detail: 'The file changed after it was applied, so a rollback would discard that edit. Your edit is intact; nothing was restored.',
      };
    }
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus, 'Rollback refused: ' + (error.message ?? 'the server refused it') + '. The file is unchanged.', 'error');
    }
  } finally {
    if (candidate) candidate.busy = false;
    renderCandidates();
  }
}

async function promoteCandidate(candidateId, button) {
  if (button) button.disabled = true;
  const reason = window.prompt('Why are you accepting this candidate? The promotion records your reason.');
  if (!reason || !reason.trim()) {
    if (button) button.disabled = false;
    if (els.wsStageStatus) setWorkspaceStatus(els.wsStageStatus, 'A promotion needs your reason, so nothing was sent.', 'error');
    return;
  }
  try {
    const data = await api('/api/workshop/promote-file', { method: 'POST', body: { candidateId, reason: reason.trim() } });
    const candidate = wsState.candidates.find((c) => c.candidateId === candidateId);
    if (candidate) candidate.promotion = data;
    renderCandidates();
    if (els.wsStageStatus) {
      setWorkspaceStatus(els.wsStageStatus,
        'Promoted ' + candidateId + ' — recorded, and the live workspace was still not written.', 'available');
    }
  } catch (error) {
    if (els.wsStageStatus) setWorkspaceStatus(els.wsStageStatus, 'Promotion refused: ' + error.message, 'error');
  } finally {
    if (button) button.disabled = false;
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

// T-42 Step 1: the protected-path prefixes, as the UI's own copy. It is used only to explain a refusal
// BEFORE the request; the server's policy is still the thing that decides, and this list is asserted
// against it in the unit suite so the two cannot drift.
const EVOLUTION_PROTECTED = ['src/executive/', 'src/security/', 'src/governance/', 'src/autonomy/',
  'src/workshop/applier.js', 'data/safety-latch.json', 'data/autonomy-matrix.json'];

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
// T-42 Step 2: quiet hours are a delivery rule the owner can see. The sentence names the window and
// says whether it is open now, because 'held' without the window beside it is indistinguishable from
// a machine that is fine.
function quietHoursSentence(value) {
  const q = value && value.quietHours && typeof value.quietHours === 'object' ? value.quietHours : null;
  if (!q) return ' Quiet hours: not reported.';
  if (q.enabled !== true) return ' Quiet hours: off, so every notice inside the cap is surfaced.';
  const w = q.window || {};
  const pad = (h) => (h < 10 ? '0' + h : String(h));
  return ' Quiet hours ' + pad(w.startHour) + ':00-' + pad(w.endHour) + ':00 UTC'
    + (w.utcOffsetHours ? ' (offset ' + w.utcOffsetHours + 'h)' : '')
    + (q.activeNow === true
      ? ': open now, so a non-critical notice is held and an alarm still delivers.'
      : ': closed now.');
}
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
        + 'notice bypasses the cap.' + quietHoursSentence(value)
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
    // T-42 Step 2: a held row says *why* it was held. Without this, a quiet window and a cap read the
    // same as a fault, which is the opposite of what a diagnostic surface is for.
    if (row.state === 'held' && row.delivery && row.delivery.reason === 'quiet_hours') item.dataset.heldBy = 'quiet_hours';
    item.append(el('div', 'meta', row.state === 'suppressed'
      ? 'Delivery: suppressed by rule ' + row.rule.id + ' until ' + row.rule.suppressedUntil + ' (revocable above)'
      : row.state === 'delivered'
        ? 'Delivery: delivered at ' + (row.delivery.at || 'time not recorded') + ' · push ' + (row.delivery.pushId || 'not recorded')
        : (row.delivery && row.delivery.reason === 'quiet_hours'
          ? 'Delivery: held by quiet hours ('
            + (row.delivery.quietHours && row.delivery.quietHours.window
              ? String(row.delivery.quietHours.window.startHour) + ':00-'
                + String(row.delivery.quietHours.window.endHour) + ':00 UTC'
              : 'window not reported')
            + '), not by a fault; a critical notice delivers through it'
          : 'Delivery: not delivered — ' + String(row.delivery ? row.delivery.reason : 'the governor has not been asked yet'))));
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
    // T-41 Step 3: what the proposal would change, and the bridge control.
    if (proposal.targetRelativePath) {
      li.append(el('div', 'meta', 'Target: ' + proposal.targetRelativePath
        + (proposal.staging && proposal.staging.count > 0
          ? ' · staged as ' + proposal.staging.candidateId + ' at ' + proposal.staging.at
          : ' · not staged into the workshop')));
      // T-42 Step 1: the control carries its target id, so the walk can address one proposal's button
      // rather than "the first button on the page" - which is how selectors silently retarget.
      const stage = el('button', 'small', proposal.staging && proposal.staging.count > 0
        ? 'Stage to Workshop again' : 'Stage to Workshop');
      stage.type = 'button';
      stage.dataset.stageProposal = proposal.proposalId;
      // A protected path is refused by the backend at proposal time, so a protected proposal should not
      // exist. If one does (an older ledger, a hand-written record), the control says what it is rather
      // than offering a button that can only be refused.
      // The client is a template literal, so a backslash in a regex costs two characters in the
      // source and arrives as a different regex in the browser. A split/join is one layer fewer
      // to get wrong, and it reads identically in the file and in the served client.
      const targetPath = String(proposal.targetRelativePath).split(String.fromCharCode(92)).join('/').toLowerCase();
      const protectedTarget = EVOLUTION_PROTECTED.some((prefix) => (prefix.endsWith('/')
        ? targetPath.startsWith(prefix)
        : targetPath === prefix));
      if (protectedTarget) {
        stage.disabled = true;
        stage.title = 'IMMUTABLE_GOVERNANCE_BOUNDARY';
        li.append(stage);
        li.append(el('div', 'meta diagnostic-boundary',
          'IMMUTABLE_GOVERNANCE_BOUNDARY: ' + proposal.targetRelativePath
          + ' is inside the immutable governance boundary and cannot be staged.'));
      } else {
        if (sandbox.verified !== true) {
          // The backend refuses this with 409; the button says why before it is pressed, so the refusal
          // is never the first time the owner learns the rule.
          stage.disabled = true;
          stage.title = 'the proposal has no passing sandbox verification';
        }
        stage.addEventListener('click', () => stageToWorkshop(proposal.proposalId, stage));
        li.append(stage);
        if (sandbox.verified !== true) {
          li.append(el('span', 'meta', ' staging needs a passing sandbox verification first'));
        }
      }
    }
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
  // T-41 Step 3: the protected-path row, rendered from the policy the refusal uses.
  const protectedEntry = entries.find((entry) => entry.key === 'protected_paths');
  if (els.evolutionPolicy) {
    const policy = value.policy || {};
    const states = 'States: ' + (policy.states || []).join(' → ')
      + '. ' + (Array.isArray(policy.rules) ? policy.rules.join(' ') : '')
      + (policy.appliesChanges === false ? ' The lab applies no change to APEX.' : '');
    // Both lines are shown: the state machine's rules, then the protected-path policy the refusal
    // reads. Concatenating rather than assigning is what keeps the second from erasing the first.
    els.evolutionPolicy.textContent = protectedEntry && protectedEntry.policy
      ? states + ' Immutable boundary — ' + protectedEntry.policy.total + ' protected path(s), no override: '
        + (protectedEntry.policy.entries ?? []).map((item) => item.path).join(', ') + '.'
      : states;
  }
}

async function submitEvolutionProposal(event) {
  event.preventDefault();
  const title = els.evolutionTitle?.value?.trim() ?? '';
  if (title === '') { if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'a title is required'; return; }
  const body = { title };
  const hypothesis = els.evolutionHypothesis?.value?.trim() ?? '';
  const targetRelativePath = els.evolutionTarget?.value?.trim() ?? '';
  const proposedContent = els.evolutionContent?.value ?? '';
  const testContent = els.evolutionTest?.value ?? '';
  if (hypothesis !== '') body.hypothesis = hypothesis;
  // T-41 Step 3: the target travels only when the owner named one. A refused target comes back as the
  // boundary's own code, and the status line says which boundary it was rather than "refused".
  if (targetRelativePath !== '') {
    body.targetRelativePath = targetRelativePath;
    if (proposedContent !== '') body.proposedContent = proposedContent;
    if (testContent.trim() !== '') body.testContent = testContent;
  }
  if (els.evolutionProposeButton) els.evolutionProposeButton.disabled = true;
  if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'recording the proposal…';
  try {
    const result = await api('/api/evolution/propose', { method: 'POST', body });
    if (els.evolutionFormStatus) els.evolutionFormStatus.textContent = 'recorded ' + result.proposalId + '; it authorizes nothing.';
    if (els.evolutionTitle) els.evolutionTitle.value = '';
    if (els.evolutionHypothesis) els.evolutionHypothesis.value = '';
    if (els.evolutionTarget) els.evolutionTarget.value = '';
    if (els.evolutionContent) els.evolutionContent.value = '';
    if (els.evolutionTest) els.evolutionTest.value = '';
    scheduleEventRefresh();
  } catch (err) {
    // T-41 Step 3: a boundary refusal names its code on the screen. The first hosted run of the T-41
    // walk failed exactly here - the refusal reached the browser, the 403 was logged, and the status
    // line said only "the proposal was refused", which is the one thing the owner cannot act on.
    const code = err && err.code ? err.code : null;
    if (els.evolutionFormStatus) {
      els.evolutionFormStatus.textContent = code
        ? 'the proposal was refused ' + code + ': ' + String(err.message || err)
        : 'the proposal was refused: ' + String(err.message || err);
    }
  } finally {
    if (els.evolutionProposeButton) els.evolutionProposeButton.disabled = false;
    armWatchdog();
  }
}

// T-41 Step 3: stage a verified proposal into the Workshop. A boundary refusal arrives as a 403 whose
// body names the boundary, and the status line repeats that name rather than paraphrasing it: the code
// is the contract, and the owner should be able to search for it.
async function stageToWorkshop(proposalId, button) {
  button.disabled = true;
  if (els.evolutionStatus) els.evolutionStatus.textContent = 'staging ' + proposalId + ' into the workshop…';
  try {
    const data = await api('/api/evolution/proposals/' + encodeURIComponent(proposalId) + '/stage-workshop', {
      method: 'POST',
      body: {},
    });
    if (els.evolutionStatus) {
      els.evolutionStatus.textContent = 'staged ' + proposalId + ' as ' + data.candidateId
        + '. The file is in the sandbox; it has not been verified or applied.';
    }
    scheduleEventRefresh();
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (els.evolutionStatus) {
      els.evolutionStatus.textContent = code === 'IMMUTABLE_GOVERNANCE_BOUNDARY'
        ? 'REFUSED IMMUTABLE_GOVERNANCE_BOUNDARY: ' + String(err.message || err)
        : (code ? 'refused ' + code + ': ' : 'the staging was refused: ') + String(err.message || err);
    }
  } finally {
    button.disabled = false;
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
  // T-42 Step 3: the sequence is taken before the await, so it orders the *request*, not the answer.
  const graphSequence = ++taskGraphRenderSequence;
  const graphRequestedTask = els.dagSelect && els.dagSelect.value ? els.dagSelect.value : null;
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
    // T-36 Step 2: a data directory that has never been bootstrapped opens on the boot sequence.
    // This is the opening screen of a workstation that has not been set up yet, and it is what
    // the owner's first window shows. The flag makes it once-only: the sequence is not replayed
    // on every refresh.
    if (snapshot.system && snapshot.system.bootstrap && snapshot.system.bootstrap.bootstrapped === false
      && state.bootSequence.triggered !== true) {
      state.bootSequence.triggered = true;
      runBootSequence({ trigger: 'unseeded data directory' });
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
  // T-42 Step 4: and the Workshop's candidate list, so a candidate staged by the Evolution Lab's
  // button is on screen without a reload. The read is fire-and-forget: the deck must not wait on it.
  void refreshCandidateListing();
  // T-43 Package 3: the git panel and the host telemetry, refreshed with everything else. Both are
  // fire-and-forget for the same reason the candidate listing is: a repository read must never delay
  // painting the rest of the deck.
  void refreshGitPanel();
  void refreshTelemetry();
  // T-44 Packages 1 and 2: the two new panels, on the same fire-and-forget discipline.
  void refreshStandingOrders();
  void refreshAgenda();
  // T-45 Package 3: the playbooks and the watchpoints, and the strip that quotes both.
  void refreshPlaybooks();
  void refreshWatchpoints();
  renderPerception(perceptionResult);
  // T-33 Step 3: the graph and the perception reading the Workshop stages a sheet from.
  state.perception = perceptionResult.ok === true ? perceptionResult.value : null;
  renderTaskGraph(taskGraphResult, { sequence: graphSequence, taskId: graphRequestedTask });
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
  // The comms owner knows the live states, and dormant - the boot sequence's own state - is one
  // of them. A state this deck invented is asked for as degraded, so a partial projection can
  // never turn into a request the server rejects.
  const COMMS_STATES = ['dormant', 'idle', 'thinking', 'awaiting_approval', 'running', 'paused', 'degraded', 'lockdown'];
  const core = COMMS_STATES.includes(state.core) ? state.core : 'degraded';
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
  // T-37 Step 1: opening Council reads the live substrate, because its step count changes whenever a
  // step is governed. Like the doctor, a second visit in the same moment asks once.
  if (view === 'council') {
    const at = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (!state.neuralAt || at - state.neuralAt > 2000) {
      state.neuralAt = at;
      loadNeural();
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
  // T-46 STEP 1: the measures popover carries the same rung as the deck's own line, written here from
  // the same chosen stage rather than derived again.
  if (els.stepdownCompact) {
    els.stepdownCompact.textContent = 'Step-down: ' + chosen.stage + ' · ' + chosen.name
      + (override === 'auto' ? ' (auto)' : '');
    els.stepdownCompact.dataset.stage = String(chosen.stage);
  }
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
  // T-42 Step 3: an explicit choice takes the newest sequence, so a refresh that started earlier can
  // no longer repaint the deck with a task the owner did not ask for.
  const sequence = ++taskGraphRenderSequence;
  taskGraphRequestedTaskId = taskId || null;
  setWorkspaceStatus(els.dagStatus, 'Reading the recorded graph…', 'loading');
  try {
    const result = await readApi('/api/taskgraph' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''));
    renderTaskGraph(result, { sequence, taskId: taskId || null });
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
// T-38 Step 3: the search bar. Submitting an empty query is allowed and searches every ledger.
if (els.traceSearchForm) {
  els.traceSearchForm.addEventListener('submit', (event) => { event.preventDefault(); runTraceSearch(); });
}
// T-38 Step 2: the file inspector and the sandbox loop.
if (els.wsRefresh) els.wsRefresh.addEventListener('click', () => { inspectWorkspace(); });
// T-40 Steps 1 and 2: the disk re-check and the batch controls.
if (els.wsCheckDisk) els.wsCheckDisk.addEventListener('click', () => { checkDiskStatus(); });
if (els.wsApplyChangeset) els.wsApplyChangeset.addEventListener('click', () => { applyChangeset(els.wsApplyChangeset); });
if (els.wsChangesetTitle) {
  els.wsChangesetTitle.addEventListener('input', () => { updateChangesetControls(); });
}
if (els.wsStageForm) {
  els.wsStageForm.addEventListener('submit', (event) => { event.preventDefault(); stageCandidate(); });
}
// The candidate list starts empty with a line that says so, rather than blank space that could be
// mistaken for a load still in progress.
renderCandidates();
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

// T-44 Package 1: the standing-orders panel. Every string is written with textContent, and every id on a
// card is the record's own id, so a click can name the thing it means without parsing a label.
// A storage key is not a label. Every badge that shows one of the engine's own vocabulary words goes
// through here, so a halted_by_lockdown outcome reads as HALTED BY LOCKDOWN on the card while the value
// stays the key the route compares against.
function badgeLabel(value) {
  return String(value ?? '').replace(/_/g, ' ').toUpperCase();
}

function soOutcomeClass(outcome) {
  if (outcome === 'verified') return 'so-badge--enabled';
  if (outcome === 'halted_by_lockdown') return 'so-badge--halted';
  if (outcome === 'cooldown_skipped' || outcome === 'refused') return 'so-badge--paused';
  return 'so-badge--outcome';
}

function renderStandingOrders(view) {
  const orders = Array.isArray(view?.orders) ? view.orders : [];
  const summary = view?.summary ?? {};
  if (els.soTotalCount) els.soTotalCount.textContent = String(summary.totalCount ?? 0);
  if (els.soEnabledCount) els.soEnabledCount.textContent = String(summary.enabledCount ?? 0);
  if (els.soRunsCount) els.soRunsCount.textContent = String(summary.totalRuns ?? 0);
  if (els.soLockdownStatus) {
    els.soLockdownStatus.textContent = view?.lockdownActive === true ? 'ENGAGED' : 'OPEN';
    els.soLockdownStatus.dataset.lockdown = view?.lockdownActive === true ? 'engaged' : 'open';
  }
  const allowed = Array.isArray(view?.allowedCapabilities) ? view.allowedCapabilities : [];
  if (els.soCapabilitySelect) {
    const previous = els.soCapabilitySelect.value;
    els.soCapabilitySelect.replaceChildren();
    for (const name of allowed) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      els.soCapabilitySelect.append(option);
    }
    if (allowed.includes(previous)) els.soCapabilitySelect.value = previous;
  }
  if (els.soStatus) {
    els.soStatus.textContent = view?.available === false
      ? 'This build holds no capability registry, so no standing order can be written.'
      : (view?.lockdownActive === true
        ? summary.totalCount + ' order(s); Lockdown is engaged, so nothing may be created, changed or invoked.'
        : summary.totalCount + ' order(s), ' + summary.enabledCount + ' enabled, ' + summary.totalRuns + ' run(s) recorded.');
  }
  if (!els.standingOrdersList) return;
  els.standingOrdersList.replaceChildren();
  if (!Array.isArray(view?.orders)) return;
  for (const order of orders) {
    const item = document.createElement('li');
    item.className = 'so-card';
    item.dataset.orderId = order.orderId;
    item.dataset.enabled = String(order.enabled === true);
    item.dataset.runnable = String(order.runnable === true);
    if (order.lastOutcome === 'halted_by_lockdown') item.classList.add('so-halted');

    const head = document.createElement('div');
    head.className = 'so-head';
    const title = document.createElement('span');
    title.className = 'so-title';
    title.textContent = order.title;
    const id = document.createElement('span');
    id.className = 'so-id';
    id.textContent = order.orderId;
    head.append(title, id);

    const row = document.createElement('div');
    row.className = 'so-row';
    const trigger = document.createElement('span');
    trigger.className = 'so-badge';
    trigger.textContent = 'ON ' + badgeLabel(order.trigger.eventType);
    const capability = document.createElement('span');
    capability.className = 'so-badge';
    capability.textContent = order.action.capabilityId;
    const tier = document.createElement('span');
    tier.className = 'so-badge';
    tier.textContent = order.action.autonomyTier;
    const status = document.createElement('span');
    const halted = order.lastOutcome === 'halted_by_lockdown';
    status.className = 'so-badge ' + (halted ? 'so-badge--halted' : (order.enabled ? 'so-badge--enabled' : 'so-badge--paused'));
    status.dataset.soStatus = halted ? 'halted' : (order.enabled ? 'enabled' : 'paused');
    status.textContent = halted ? 'HALTED BY LOCKDOWN' : (order.enabled ? 'ENABLED' : 'PAUSED');
    const runs = document.createElement('span');
    runs.className = 'so-badge';
    runs.textContent = 'RUNS ' + order.runCount;
    runs.dataset.soRuns = String(order.runCount);
    const outcome = document.createElement('span');
    outcome.className = 'so-badge ' + soOutcomeClass(order.lastOutcome);
    outcome.textContent = badgeLabel(order.lastOutcome);
    outcome.dataset.soOutcome = order.lastOutcome;
    row.append(trigger, capability, tier, status, runs, outcome);

    const buttons = document.createElement('div');
    buttons.className = 'so-row';
    for (const [action, label, disabled] of [
      ['invoke-standing-order', 'Invoke now', order.enabled !== true || order.runnable !== true],
      ['toggle-standing-order', order.enabled ? 'Pause' : 'Enable', false],
      ['revoke-standing-order', 'Revoke', false],
      ['trace-standing-order', 'Trace', false],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.dataset.action = action;
      button.dataset.orderId = order.orderId;
      button.textContent = label;
      if (disabled) button.disabled = true;
      buttons.append(button);
    }
    const note = document.createElement('p');
    note.className = 'meta';
    note.textContent = order.lastRunAt === null
      ? 'never run'
      : 'last run ' + order.lastRunAt + (order.lastRunId ? ' (' + order.lastRunId + ')' : '');
    item.append(head, row, buttons, note);
    els.standingOrdersList.append(item);
  }
}

async function refreshStandingOrders() {
  try {
    const view = await api('/api/standing-orders');
    state.standingOrders = view;
    renderStandingOrders(view);
  } catch (error) {
    if (els.soStatus) els.soStatus.textContent = 'The standing orders could not be read: ' + String(error?.message || error);
  }
}

// ------------------------------------------------------------------------------------------------
// T-45 Package 3: the executive playbooks, the watchpoints and the tactical overlay.
//
// Three surfaces, one discipline: every number rendered here was returned by the server, and every
// button posts and then re-reads. Nothing is optimistically updated, because a deck that shows a
// threshold as breached before the evaluation that measured it has answered is a deck that has decided
// something the engine has not.
// ------------------------------------------------------------------------------------------------

function playbookStatusClass(status) {
  if (status === 'verified') return 'playbook-badge--verified';
  if (status === 'failed') return 'playbook-badge--failed';
  return 'playbook-badge--skipped';
}

// The template's DAG as one line: the roots that run in parallel, then the fan-in they feed. Read from
// the template's own step list so the line cannot drift from what launching it will actually do.
function playbookDagLine(template) {
  const steps = Array.isArray(template?.steps) ? template.steps : [];
  const roots = steps.filter((step) => Array.isArray(step.dependsOn) && step.dependsOn.length === 0);
  const joins = steps.filter((step) => Array.isArray(step.dependsOn) && step.dependsOn.length > 0);
  if (roots.length === 0 || joins.length === 0) return steps.map((step) => step.capabilityId).join(' then ');
  return roots.map((step) => step.capabilityId).join(' || ') + ' -> ' + joins.map((step) => step.capabilityId).join(', ');
}

function renderPlaybooks(view) {
  const templates = Array.isArray(view?.templates) ? view.templates : [];
  const runs = Array.isArray(view?.runs) ? view.runs : [];
  const summary = view?.summary ?? {};
  if (els.pbTemplateCount) els.pbTemplateCount.textContent = String(summary.templateCount ?? templates.length);
  if (els.pbRunsCount) els.pbRunsCount.textContent = String(summary.totalRuns ?? runs.length);
  if (els.pbVerifiedCount) els.pbVerifiedCount.textContent = String(summary.verifiedRuns ?? 0);
  if (els.pbStatus) {
    els.pbStatus.textContent = view?.lockdownActive === true
      ? templates.length + ' template(s). Lockdown is engaged, so nothing may be launched.'
      : templates.length + ' template(s), ' + (summary.totalRuns ?? runs.length) + ' run(s) recorded, '
        + (summary.verifiedRuns ?? 0) + ' verified, ' + (summary.failedRuns ?? 0) + ' failed.';
  }

  if (els.pbTemplateList) {
    els.pbTemplateList.replaceChildren();
    for (const template of templates) {
      // The step list is read once, guarded, and used everywhere below. A template whose steps could not be
      // read still renders its card with its title and its launch control disabled: a renderer that threw
      // here would leave the panel blank and the console holding an uncaught exception, which reads to an
      // owner as a broken deck rather than as one unreadable row.
      const templateSteps = Array.isArray(template?.steps) ? template.steps : [];
      const item = document.createElement('li');
      item.className = 'playbook-card';
      item.dataset.playbookId = template.playbookId;
      item.dataset.playbookStatus = String(template.verified === true);

      const head = document.createElement('div');
      head.className = 'playbook-head';
      const title = document.createElement('span');
      title.className = 'playbook-title';
      title.textContent = template.title;
      const id = document.createElement('span');
      id.className = 'playbook-id';
      id.textContent = template.playbookId;
      const rule = document.createElement('span');
      rule.className = 'playbook-badge playbook-badge--rule';
      rule.textContent = templateSteps.length + ' STEPS';
      head.append(title, id, rule);

      const dag = document.createElement('div');
      dag.className = 'playbook-dag';
      const dagText = document.createElement('span');
      dagText.className = 'playbook-dag-label';
      dagText.textContent = playbookDagLine(template);
      dag.append(dagText);

      const steps = document.createElement('ul');
      steps.className = 'playbook-steps';
      for (const step of templateSteps) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'playbook-step-label';
        label.textContent = step.label;
        const capability = document.createElement('span');
        capability.className = 'playbook-step-capability meta';
        capability.textContent = step.capabilityId;
        const tier = document.createElement('span');
        tier.className = 'playbook-step-op';
        const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : [];
        tier.textContent = dependsOn.length === 0 ? 'root' : 'after ' + dependsOn.join(', ');
        row.append(label, capability, tier);
        steps.append(row);
      }

      const buttons = document.createElement('div');
      buttons.className = 'playbook-row';
      const launch = document.createElement('button');
      launch.type = 'button';
      launch.className = 'small';
      launch.dataset.action = 'launch-playbook';
      launch.dataset.playbookId = template.playbookId;
      launch.textContent = 'Launch';
      // A locked deck offers the button disabled rather than hiding it: the owner can see that the routine
      // exists and why it will not run, which a missing button would not tell them.
      launch.disabled = view?.lockdownActive === true || template.verified !== true;
      if (view?.lockdownActive === true) launch.title = 'Lockdown is engaged; a launch is refused.';
      buttons.append(launch);

      item.append(head, dag, steps, buttons);
      els.pbTemplateList.append(item);
    }
  }

  if (!els.pbRunsList) return;
  els.pbRunsList.replaceChildren();
  if (runs.length === 0) {
    if (els.pbRunsStatus) els.pbRunsStatus.textContent = 'No routine has been launched yet.';
    return;
  }
  if (els.pbRunsStatus) els.pbRunsStatus.textContent = 'Newest first. A run is verified only if all three steps did.';
  for (const run of runs) {
    const item = document.createElement('li');
    item.className = 'playbook-card';
    item.dataset.playbookRunId = run.runId;
    item.dataset.runStatus = run.status;

    const head = document.createElement('div');
    head.className = 'playbook-head';
    const title = document.createElement('span');
    title.className = 'playbook-title';
    title.textContent = run.title;
    const id = document.createElement('span');
    id.className = 'playbook-id';
    id.textContent = run.runId;
    const status = document.createElement('span');
    status.className = 'playbook-badge ' + playbookStatusClass(run.status);
    status.dataset.runBadge = run.status;
    status.textContent = String(run.status).toUpperCase();
    const runSteps = Array.isArray(run.steps) ? run.steps : [];
    const verifiedCount = runSteps.filter((step) => step.verified === true).length;
    const steps = document.createElement('span');
    steps.className = 'playbook-badge';
    steps.textContent = verifiedCount + '/' + runSteps.length + ' STEPS';
    head.append(title, id, status, steps);

    const list = document.createElement('ul');
    list.className = 'playbook-steps';
    for (const step of runSteps) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'playbook-step-label';
      label.textContent = step.label;
      const capability = document.createElement('span');
      capability.className = 'playbook-step-capability meta';
      capability.textContent = step.capabilityId;
      const badge = document.createElement('span');
      badge.className = 'playbook-badge ' + playbookStatusClass(step.status);
      badge.dataset.stepStatus = step.status;
      badge.textContent = String(step.status).toUpperCase();
      row.append(label, capability, badge);
      if (step.operationId) {
        // The operation id is the receipt. It is rendered as text, not as a second control: the trace
        // button below opens the chain, and two ways to open the same chain would be one too many.
        const op = document.createElement('span');
        op.className = 'playbook-step-op';
        op.textContent = step.operationId;
        row.append(op);
      } else if (step.summary) {
        const why = document.createElement('span');
        why.className = 'playbook-step-op';
        why.textContent = step.summary;
        row.append(why);
      }
      list.append(row);
    }

    const buttons = document.createElement('div');
    buttons.className = 'playbook-row';
    const trace = document.createElement('button');
    trace.type = 'button';
    trace.className = 'small';
    trace.dataset.action = 'trace-playbook-run';
    trace.dataset.runId = run.runId;
    trace.textContent = 'Trace';
    buttons.append(trace);

    item.append(head, list, buttons);
    els.pbRunsList.append(item);
  }
}

async function refreshPlaybooks() {
  try {
    const view = await api('/api/playbooks');
    state.playbooks = view;
    renderPlaybooks(view);
    syncOverlayStrip();
    syncHeaderStrip();
  } catch (error) {
    if (els.pbStatus) els.pbStatus.textContent = 'The playbooks could not be read: ' + String(error?.message || error);
  }
}

function watchpointStateClass(wpState) {
  if (wpState === 'breached') return 'watchpoint-badge--breached';
  if (wpState === 'nominal') return 'watchpoint-badge--nominal';
  if (wpState === 'paused') return 'watchpoint-badge--paused';
  return 'watchpoint-badge--unmeasured';
}

function metricLabel(metric) {
  if (metric === 'dirty_files_count') return 'dirty files';
  if (metric === 'external_ports_count') return 'external ports';
  if (metric === 'apex_rss_mb') return 'APEX memory (MB)';
  if (metric === 'overdue_commitments_count') return 'overdue commitments';
  return String(metric);
}

function operatorLabel(operator) {
  if (operator === 'gte') return '>=';
  if (operator === 'eq') return '=';
  return '>';
}

function renderWatchpoints(view) {
  const watchpoints = Array.isArray(view?.watchpoints) ? view.watchpoints : [];
  const summary = view?.summary ?? {};
  if (els.wpTotalCount) els.wpTotalCount.textContent = String(summary.totalCount ?? watchpoints.length);
  if (els.wpEnabledCount) els.wpEnabledCount.textContent = String(summary.enabledCount ?? 0);
  if (els.wpBreachedCount) els.wpBreachedCount.textContent = String(summary.breachedCount ?? 0);
  if (els.wpNominalCount) els.wpNominalCount.textContent = String(summary.nominalCount ?? 0);
  if (els.wpStatus) {
    els.wpStatus.textContent = view?.lockdownActive === true
      ? watchpoints.length + ' rule(s). Lockdown is engaged, so a rule may be read but not written or evaluated.'
      : watchpoints.length + ' rule(s): ' + (summary.enabledCount ?? 0) + ' enabled, '
        + (summary.breachedCount ?? 0) + ' breached, ' + (summary.nominalCount ?? 0) + ' nominal.';
  }
  if (!els.watchpointsList) return;
  els.watchpointsList.replaceChildren();
  if (watchpoints.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'meta';
    empty.textContent = 'No watchpoint has been created yet. A rule is a metric, an operator and a threshold.';
    els.watchpointsList.append(empty);
    return;
  }
  for (const wp of watchpoints) {
    const item = document.createElement('li');
    item.className = 'watchpoint-card';
    item.dataset.watchpointId = wp.watchpointId;
    item.dataset.wpState = wp.lastState;

    const head = document.createElement('div');
    head.className = 'watchpoint-head';
    const title = document.createElement('span');
    title.className = 'watchpoint-title';
    title.textContent = wp.title;
    const id = document.createElement('span');
    id.className = 'watchpoint-id';
    id.textContent = wp.watchpointId;
    const state = document.createElement('span');
    state.className = 'watchpoint-badge ' + watchpointStateClass(wp.lastState);
    state.dataset.wpBadge = wp.lastState;
    state.textContent = String(wp.lastState).toUpperCase();
    head.append(title, id, state);

    const row = document.createElement('div');
    row.className = 'watchpoint-row';
    const rule = document.createElement('span');
    rule.className = 'watchpoint-badge watchpoint-badge--rule';
    rule.textContent = metricLabel(wp.metric) + ' ' + operatorLabel(wp.operator) + ' ' + wp.threshold;
    const severity = document.createElement('span');
    severity.className = 'watchpoint-badge';
    severity.textContent = String(wp.severity).toUpperCase();
    severity.dataset.wpSeverity = wp.severity;
    row.append(rule, severity);
    if (wp.lastMeasuredValue !== null && wp.lastMeasuredValue !== undefined) {
      // The measured value is shown against the threshold that judged it, so a reader never has to hold
      // one number in their head while looking at the other.
      const value = document.createElement('span');
      value.className = 'watchpoint-value';
      value.textContent = 'last measured ' + wp.lastMeasuredValue;
      value.dataset.wpMeasured = String(wp.lastMeasuredValue);
      row.append(value);
    }
    const breaches = document.createElement('span');
    breaches.className = 'watchpoint-badge';
    breaches.textContent = 'BREACHES ' + (wp.breachCount ?? 0) + '/' + (wp.evaluationCount ?? 0);
    breaches.dataset.wpBreaches = String(wp.breachCount);
    row.append(breaches);

    const buttons = document.createElement('div');
    buttons.className = 'watchpoint-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'small';
    toggle.dataset.action = 'toggle-watchpoint';
    toggle.dataset.watchpointId = wp.watchpointId;
    toggle.textContent = wp.enabled ? 'Pause' : 'Enable';
    toggle.disabled = view?.lockdownActive === true;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'small';
    remove.dataset.action = 'delete-watchpoint';
    remove.dataset.watchpointId = wp.watchpointId;
    remove.textContent = 'Delete';
    remove.disabled = view?.lockdownActive === true;
    const trace = document.createElement('button');
    trace.type = 'button';
    trace.className = 'small';
    trace.dataset.action = 'trace-watchpoint';
    trace.dataset.watchpointId = wp.watchpointId;
    trace.textContent = 'Trace';
    buttons.append(toggle, remove, trace);

    item.append(head, row, buttons);
    els.watchpointsList.append(item);
  }
}

async function refreshWatchpoints() {
  try {
    const view = await api('/api/watchpoints');
    state.watchpoints = view;
    renderWatchpoints(view);
    syncOverlayStrip();
    // T-46 STEP 1: the header's BREACHED reading comes from this same ledger read.
    syncHeaderStrip();
  } catch (error) {
    if (els.wpStatus) els.wpStatus.textContent = 'The watchpoints could not be read: ' + String(error?.message || error);
  }
}

// --------------------------------------------------------------------------------------------
// The tactical overlay. It is a posture on the body, not a route: switching view must not turn it off,
// and reloading must not turn it on. The choice is remembered in localStorage, which is the one place
// the deck keeps something the owner said about themselves rather than something the machine measured.
// --------------------------------------------------------------------------------------------

function hudPosture() {
  return document.body.dataset.hudPosture === 'overlay' ? 'overlay' : 'full';
}

function applyHudPosture(posture, options) {
  const next = posture === 'overlay' ? 'overlay' : 'full';
  document.body.dataset.hudPosture = next;
  if (els.btnHudOverlay) {
    els.btnHudOverlay.setAttribute('aria-pressed', next === 'overlay' ? 'true' : 'false');
    els.btnHudOverlay.textContent = next === 'overlay' ? 'OVERLAY: TACTICAL' : 'OVERLAY: OFF';
  }
  if (els.tacticalOverlayStrip) els.tacticalOverlayStrip.hidden = next !== 'overlay';
  if (options?.announce !== false) {
    if (els.connectivity) els.connectivity.dataset.hudPosture = next;
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('apex.hudPosture', next);
  } catch {
    // A browser with storage disabled keeps the posture for this page and loses it on reload. That is a
    // smaller failure than refusing the toggle.
  }
  return next;
}

function toggleHudPosture() {
  return applyHudPosture(hudPosture() === 'overlay' ? 'full' : 'overlay');
}

// Every number on the strip is a reading the deck already holds: state.core is the projected Core the
// top bar shows, state.mode is the presentation mode, state.watchpoints and state.standingOrders are
// the last reads of those two ledgers, and the approval total is the one the Approval Centre rendered. The
// strip never fetches. A surface visible on every screen that added a request to every screen would make
// the compact posture cost more than the full one, which is the opposite of what it is for.
function syncOverlayStrip() {
  if (!els.tacticalOverlayStrip) return;
  if (els.overlayCoreState) {
    const core = state.core ?? 'degraded';
    els.overlayCoreState.textContent = String(core).toUpperCase();
    els.overlayCoreState.dataset.core = String(core);
  }
  if (els.overlayMode) {
    const mode = document.body.dataset.mode ?? state.mode ?? 'classic';
    els.overlayMode.textContent = String(mode).toUpperCase();
  }
  if (els.overlayLockdown) {
    // Three independent readers agree before the strip says OPEN. Any one of them naming an engaged latch
    // is enough to say ENGAGED, because "OPEN" is the claim that could cost something if it were wrong.
    const latched = state.core === 'lockdown'
      || state.standingOrders?.lockdownActive === true
      || state.playbooks?.lockdownActive === true
      || state.watchpoints?.lockdownActive === true;
    els.overlayLockdown.textContent = latched ? 'ENGAGED' : 'OPEN';
    els.overlayLockdown.dataset.latch = latched ? 'active' : 'open';
  }
  if (els.overlayWatchpointBreaches) {
    const breached = state.watchpoints?.summary?.breachedCount ?? 0;
    els.overlayWatchpointBreaches.textContent = String(breached);
    els.overlayWatchpointBreaches.dataset.breaches = Number(breached) > 0 ? 'some' : 'none';
  }
  if (els.overlayApprovals) {
    const pending = state.pendingApprovalCount;
    els.overlayApprovals.textContent = pending === null || pending === undefined ? '—' : String(pending);
    els.overlayApprovals.dataset.approvals = pending === null || pending === undefined ? 'unknown' : 'known';
  }
}

// T-46 STEP 1 (2026-11-19): the header's compact strip.
//
// Every value here is one the deck already holds: state.core is the projection the Core itself
// renders, the latch is the same three-reader agreement the tactical strip uses, the pending count is
// the one the Approval Centre wrote from its own read, and the breached count is the watchpoint
// ledger's own summary. The strip never fetches, for the reason the tactical strip never fetches: a
// surface visible on every screen that added a request to every screen would make the glance cost more
// than the panel. The writers call this from the same pass that wrote the panel, so the two cannot
// disagree.
function syncHeaderStrip() {
  if (els.coreStateCompact) {
    const core = state.core ?? 'degraded';
    const definition = CORE_STATE_DEFINITIONS.find((entry) => entry.id === core) ?? null;
    els.coreStateCompact.textContent = definition ? definition.label : 'Degraded';
    els.coreStateCompact.dataset.core = String(core);
  }
  if (els.latchCompact) {
    const latched = state.core === 'lockdown'
      || state.standingOrders?.lockdownActive === true
      || state.playbooks?.lockdownActive === true
      || state.watchpoints?.lockdownActive === true;
    els.latchCompact.textContent = latched ? 'ENGAGED' : 'OPEN';
    els.latchCompact.dataset.latch = latched ? 'active' : 'open';
  }
  if (els.approvalsCompact) {
    const pending = state.pendingApprovalCount;
    // A dash, never a zero: an unreadable Approval Centre is not an all-clear, and the strip must not
    // say "0 pending" while the read behind it is failing.
    els.approvalsCompact.textContent = pending === null || pending === undefined ? '—' : String(pending);
    els.approvalsCompact.dataset.count = pending === null || pending === undefined
      ? 'unknown' : (Number(pending) > 0 ? 'some' : 'none');
  }
  if (els.watchpointsCompact) {
    const summary = state.watchpoints?.summary ?? null;
    const breached = summary ? (summary.breachedCount ?? 0) : null;
    els.watchpointsCompact.textContent = breached === null ? '—' : String(breached);
    els.watchpointsCompact.dataset.count = breached === null ? 'unknown' : (Number(breached) > 0 ? 'some' : 'none');
  }
}

// The phone layout is a decision of the client, not of the stylesheet alone: data-layout on the body
// is what the spec measures and what the mobile rules key on. matchMedia is used rather than a resize
// arithmetic so the same breakpoint the stylesheet uses decides it, and a browser without matchMedia
// simply keeps the desktop layout - a smaller failure than a page that throws on load.
function applyLayout() {
  let mobile = false;
  try {
    mobile = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 720px)').matches === true;
  } catch {
    mobile = false;
  }
  document.body.dataset.layout = mobile ? 'mobile' : 'desktop';
  measureCoreFit();
}

// The Core is sized by the space it actually has, not by a constant. The stage offers a column of a
// known width and a band of a known height; the Core takes the smaller of the two, less the room the
// caption and the state line need. This runs on load and on resize, and it only ever writes a CSS
// custom property, so no layout is forced by reading the wrong box.
function measureCoreFit() {
  const wrap = document.querySelector('.core-wrap');
  if (!wrap) return;
  // T-46 STEP 1: the measurement is the STAGE's first track, not the wrap's own box. The wrap is a
  // grid item that fills its track, so once the Core is inside it the wrap reports whatever the last
  // fit produced - measuring it fed the previous answer back in, which is why the hosted run saw the
  // reticle at 357px on one pass and 187px on the next. The track is the space the Core is allowed.
  const stage = wrap.closest('.stage');
  const probe = stage ?? wrap.parentElement ?? wrap;
  const box = probe.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  // The state line and the caption are measured rather than assumed, because both wrap differently at
  // different widths.
  const reserved = (document.getElementById('core-state')?.getBoundingClientRect().height ?? 0)
    + (document.getElementById('core-caption')?.getBoundingClientRect().height ?? 0)
    + 18;
  // The stage's padding is part of the box and not part of the room: subtract it before fitting.
  let horizontalPadding = 0;
  let verticalPadding = 0;
  if (stage && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(stage);
      horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    } catch {
      horizontalPadding = 0;
      verticalPadding = 0;
    }
  }
  const width = Math.max(96, box.width - horizontalPadding);
  const room = Math.max(96, box.height - verticalPadding - reserved);
  const fit = Math.max(96, Math.min(width, room));
  document.body.style.setProperty('--core-fit', String(Math.round(fit)));
}

// T-46 STEP 1: the measures popover. A panel, not a modal: it does not take focus on open, it does not
// trap it, Escape closes it and returns focus to the button that opened it. Opening it is presentation
// only - nothing about the measures is a setting, and nothing here authorizes anything.
function measuresOpen() {
  // The client's own record of what it opened, not the DOM's. Reading hidden back would mean the
  // client inferring its state from the markup it just wrote: on a document whose attributes are not
  // parsed into properties (a stand-in, a test harness) every panel looks open, and Escape would then
  // spend its one dismissal on a popover nobody opened.
  return state.measuresOpen === true;
}

function openMeasures({ focus = false } = {}) {
  if (!els.measuresPanel) return;
  els.measuresPanel.hidden = false;
  state.measuresOpen = true;
  if (els.measuresTrigger) els.measuresTrigger.setAttribute('aria-expanded', 'true');
  if (focus) {
    const first = els.measuresPanel.querySelector('button:not([disabled]), select:not([disabled])');
    if (first) first.focus();
  }
}

function closeMeasures({ returnFocus = false } = {}) {
  if (!els.measuresPanel || els.measuresPanel.hidden === true) return;
  els.measuresPanel.hidden = true;
  state.measuresOpen = false;
  if (els.measuresTrigger) {
    els.measuresTrigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) els.measuresTrigger.focus();
  }
}

function toggleMeasures() {
  if (measuresOpen()) closeMeasures({ returnFocus: true });
  else openMeasures({ focus: true });
}

// T-44 Package 2: the agenda panel. The horizon badge is the colour the brief names, and a completed card
// has its Complete button disabled rather than removed, so the card does not change shape under the
// pointer that just pressed it.
function agendaHorizonClass(bucket) {
  if (bucket === 'overdue') return 'agenda-badge--overdue';
  if (bucket === 'today') return 'agenda-badge--today';
  if (bucket === 'completed') return 'agenda-badge--completed';
  if (bucket === 'dismissed') return 'agenda-badge--dismissed';
  return 'agenda-badge--upcoming';
}

function renderAgenda(view) {
  const summary = view?.summary ?? {};
  if (els.agendaOverdueCount) els.agendaOverdueCount.textContent = String(summary.overdueCount ?? 0);
  if (els.agendaTodayCount) els.agendaTodayCount.textContent = String(summary.todayCount ?? 0);
  if (els.agendaUpcomingCount) {
    els.agendaUpcomingCount.textContent = String((summary.upcomingCount ?? 0) + (summary.unscheduledCount ?? 0));
  }
  if (els.agendaCompletedCount) els.agendaCompletedCount.textContent = String(summary.completedCount ?? 0);
  if (els.agendaDerivedCount) els.agendaDerivedCount.textContent = String(summary.derivedActionCount ?? 0);
  const items = Array.isArray(view?.items) ? view.items : [];
  const derived = Array.isArray(view?.derivedItems) ? view.derivedItems : [];
  if (els.agendaStatus) {
    els.agendaStatus.textContent = view?.available === false
      ? 'This build holds no agenda.'
      : (summary.totalCommitments ?? 0) + ' commitment(s): ' + (summary.overdueCount ?? 0) + ' overdue, '
        + (summary.todayCount ?? 0) + ' today, ' + (summary.derivedCount ?? 0) + ' reading(s) from other stores.'
        + (view?.lockdownActive === true ? ' Lockdown is engaged, so nothing may be changed.' : '');
  }
  if (els.agendaList) {
    els.agendaList.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'agenda-card';
      li.dataset.agendaId = item.itemId;
      li.dataset.horizon = item.horizonBucket;
      li.dataset.status = item.status;

      const head = document.createElement('div');
      head.className = 'agenda-head';
      const title = document.createElement('span');
      title.className = 'agenda-title';
      title.textContent = item.title;
      const id = document.createElement('span');
      id.className = 'agenda-id';
      id.textContent = item.itemId;
      head.append(title, id);

      const row = document.createElement('div');
      row.className = 'agenda-row';
      const horizon = document.createElement('span');
      horizon.className = 'agenda-badge ' + agendaHorizonClass(item.horizonBucket);
      horizon.dataset.agendaHorizon = item.horizonBucket;
      horizon.textContent = badgeLabel(item.horizonBucket);
      const priority = document.createElement('span');
      priority.className = 'agenda-badge';
      priority.textContent = badgeLabel(item.priority);
      const category = document.createElement('span');
      category.className = 'agenda-badge';
      category.textContent = badgeLabel(item.category);
      row.append(horizon, priority, category);
      if (item.linkedArtifactId) {
        const link = document.createElement('span');
        link.className = 'agenda-badge agenda-link';
        link.dataset.agendaLink = item.linkedArtifactId;
        link.textContent = 'LINKED ' + item.linkedArtifactId;
        row.append(link);
      }

      const buttons = document.createElement('div');
      buttons.className = 'agenda-row';
      const complete = document.createElement('button');
      complete.type = 'button';
      complete.className = 'small';
      complete.dataset.action = 'complete-agenda-item';
      complete.dataset.agendaId = item.itemId;
      complete.textContent = 'Complete';
      complete.disabled = item.status === 'completed';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'small';
      dismiss.dataset.action = 'dismiss-agenda-item';
      dismiss.dataset.agendaId = item.itemId;
      dismiss.textContent = 'Dismiss';
      dismiss.disabled = item.status === 'dismissed';
      const trace = document.createElement('button');
      trace.type = 'button';
      trace.className = 'small';
      trace.dataset.action = 'trace-agenda-item';
      trace.dataset.agendaId = item.itemId;
      trace.textContent = 'Trace';
      buttons.append(complete, dismiss, trace);

      li.append(head, row, buttons);
      if (item.dueAt) {
        const due = document.createElement('p');
        due.className = 'meta';
        due.textContent = 'due ' + item.dueAt + (item.completedAt ? ' · completed ' + item.completedAt : '');
        li.append(due);
      }
      els.agendaList.append(li);
    }
  }
  if (els.derivedAgendaList) {
    els.derivedAgendaList.replaceChildren();
    for (const item of derived) {
      const li = document.createElement('li');
      li.dataset.derivedId = item.itemId;
      li.dataset.source = item.source;
      const head = document.createElement('div');
      head.className = 'agenda-head';
      const title = document.createElement('span');
      title.className = 'agenda-title';
      title.textContent = item.title;
      head.append(title);
      const row = document.createElement('div');
      row.className = 'agenda-row';
      const source = document.createElement('span');
      source.className = 'agenda-badge';
      source.textContent = badgeLabel(item.source);
      const bucket = document.createElement('span');
      bucket.className = 'agenda-badge agenda-badge--upcoming';
      bucket.textContent = badgeLabel(item.horizonBucket);
      row.append(source, bucket);
      if (item.linkedArtifactId) {
        const link = document.createElement('span');
        link.className = 'agenda-badge agenda-link';
        link.textContent = String(item.linkedArtifactId);
        row.append(link);
      }
      li.append(head, row);
      els.derivedAgendaList.append(li);
    }
  }
}

async function refreshAgenda() {
  try {
    const view = await api('/api/agenda');
    state.agenda = view;
    renderAgenda(view);
  } catch (error) {
    if (els.agendaStatus) els.agendaStatus.textContent = 'The agenda could not be read: ' + String(error?.message || error);
  }
}

// ------------------------------------------------------------------------------------------------
// T-45 Package 3: the handling for the two new panels and the overlay toggle.
//
// The same discipline as the standing orders above: post, then re-read. A launch takes as long as three
// capabilities take, so the button says what it is doing and the run list is read again when it answers.
// ------------------------------------------------------------------------------------------------

if (els.pbTemplateList) {
  els.pbTemplateList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="launch-playbook"]');
    if (!button) return;
    const playbookId = button.dataset.playbookId;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Launching…';
    if (els.pbStatus) els.pbStatus.textContent = 'Launching ' + playbookId + ' — three steps, in dependency order…';
    try {
      const run = await api('/api/playbooks/' + encodeURIComponent(playbookId) + '/launch', { method: 'POST', body: {} });
      if (els.pbStatus) {
        // The run's own status is quoted, and so is the count: a routine that ran three steps and verified
        // two must not read as a success anywhere on the card or in this line.
        els.pbStatus.textContent = 'Playbook ' + run.playbookId + ' ' + run.status + ': '
          + (Array.isArray(run.steps) ? run.steps.filter((step) => step.verified === true).length : 0)
          + '/' + (Array.isArray(run.steps) ? run.steps.length : 0) + ' steps verified (' + run.runId + ').';
      }
    } catch (error) {
      if (els.pbStatus) els.pbStatus.textContent = 'Launch refused: ' + String(error?.message || error);
    } finally {
      button.disabled = false;
      button.textContent = original;
      await refreshPlaybooks();
    }
  });
}

if (els.pbRunsList) {
  els.pbRunsList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="trace-playbook-run"]');
    if (!button) return;
    await openTrace(button.dataset.runId, button).catch(() => {});
  });
}

if (els.btnWpCreate) {
  els.btnWpCreate.addEventListener('click', async () => {
    const title = (els.wpTitleInput?.value ?? '').trim();
    els.btnWpCreate.disabled = true;
    if (els.wpRefusal) els.wpRefusal.hidden = true;
    try {
      const wpHolder = await api('/api/watchpoints', {
        method: 'POST',
        body: {
          title,
          metric: els.wpMetricSelect?.value ?? 'dirty_files_count',
          operator: els.wpOperatorSelect?.value ?? 'gt',
          threshold: Number(els.wpThresholdInput?.value ?? 0),
          severity: els.wpSeveritySelect?.value ?? 'advisory',
        },
      });
      if (els.wpTitleInput) els.wpTitleInput.value = '';
      if (els.wpEvalStatus) els.wpEvalStatus.textContent = 'Created ' + wpHolder.watchpointId + '. It is unmeasured until an evaluation runs.';
    } catch (error) {
      // A refusal is the engine's words, not a generic failure: the metric and threshold refusals name what
      // is wrong, and quoting them is the only way the owner can fix the rule without guessing.
      if (els.wpRefusal) {
        els.wpRefusal.hidden = false;
        els.wpRefusal.textContent = 'Refused: ' + String(error?.message || error);
      }
    } finally {
      els.btnWpCreate.disabled = false;
      await refreshWatchpoints();
    }
  });
}

if (els.btnWpEvaluate) {
  els.btnWpEvaluate.addEventListener('click', async () => {
    els.btnWpEvaluate.disabled = true;
    if (els.wpEvalStatus) els.wpEvalStatus.textContent = 'Evaluating every enabled watchpoint…';
    try {
      const result = await api('/api/watchpoints/evaluate', { method: 'POST', body: {} });
      if (els.wpEvalStatus) {
        els.wpEvalStatus.textContent = 'Evaluated ' + (result.evaluatedCount ?? 0) + ' rule(s): '
          + (result.breachedCount ?? 0) + ' breached, ' + (result.nominalCount ?? 0) + ' nominal, '
          + (result.unmeasuredCount ?? 0) + ' unmeasured'
          + ((result.skippedCount ?? 0) > 0 ? ', ' + result.skippedCount + ' paused' : '') + '.';
      }
    } catch (error) {
      if (els.wpEvalStatus) els.wpEvalStatus.textContent = 'Evaluation refused: ' + String(error?.message || error);
    } finally {
      els.btnWpEvaluate.disabled = false;
      await refreshWatchpoints();
    }
  });
}

if (els.watchpointsList) {
  els.watchpointsList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const watchpointId = button.dataset.watchpointId;
    const action = button.dataset.action;
    if (action === 'trace-watchpoint') {
      await openTrace(watchpointId, button).catch(() => {});
      return;
    }
    button.disabled = true;
    try {
      if (action === 'toggle-watchpoint') {
        await api('/api/watchpoints/' + encodeURIComponent(watchpointId) + '/toggle', { method: 'POST', body: {} });
      } else if (action === 'delete-watchpoint') {
        await api('/api/watchpoints/' + encodeURIComponent(watchpointId) + '/delete', { method: 'POST', body: {} });
      }
    } catch (error) {
      if (els.wpRefusal) {
        els.wpRefusal.hidden = false;
        els.wpRefusal.textContent = 'Refused: ' + String(error?.message || error);
      }
    } finally {
      await refreshWatchpoints();
    }
  });
}

if (els.btnHudOverlay) {
  els.btnHudOverlay.addEventListener('click', () => { toggleHudPosture(); });
}

// The four standing-order buttons on a card, and the evaluation bar. Each one posts to the route and
// re-reads the list afterwards, so the card an owner sees after a press is the ledger as it stands now
// rather than a local guess at what the press did.
if (els.standingOrdersList) {
  els.standingOrdersList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const orderId = button.dataset.orderId;
    const action = button.dataset.action;
    if (action === 'trace-standing-order') {
      // The same trace the Memory Timeline renders: the chain for an order reaches its runs and the
      // operations they performed, so the button opens the record rather than a second copy of it.
      await openTrace(orderId, button).catch(() => {});
      return;
    }
    button.disabled = true;
    try {
      if (action === 'toggle-standing-order') await api('/api/standing-orders/' + encodeURIComponent(orderId) + '/toggle', { method: 'POST', body: {} });
      else if (action === 'revoke-standing-order') await api('/api/standing-orders/' + encodeURIComponent(orderId) + '/revoke', { method: 'POST', body: {} });
      else if (action === 'invoke-standing-order') await api('/api/standing-orders/' + encodeURIComponent(orderId) + '/invoke', { method: 'POST', body: {} });
      if (els.soStatus) els.soStatus.textContent = 'Standing order ' + orderId + ': ' + action.replace('-standing-order', '') + ' sent.';
    } catch (error) {
      if (els.soCreateRefusal) {
        els.soCreateRefusal.hidden = false;
        els.soCreateRefusal.textContent = 'Refused: ' + String(error?.message || error);
      }
    } finally {
      await refreshStandingOrders();
    }
  });
}

if (els.btnSoCreate) {
  els.btnSoCreate.addEventListener('click', async () => {
    const title = (els.soTitleInput?.value ?? '').trim();
    const capabilityId = els.soCapabilitySelect?.value ?? '';
    els.btnSoCreate.disabled = true;
    if (els.soCreateRefusal) els.soCreateRefusal.hidden = true;
    try {
      const order = await api('/api/standing-orders', {
        method: 'POST',
        body: { title, eventType: els.soTriggerSelect?.value ?? 'manual_invoke', capabilityId },
      });
      if (els.soTitleInput) els.soTitleInput.value = '';
      if (els.soCreateStatus) els.soCreateStatus.textContent = 'Created ' + order.orderId + '.';
    } catch (error) {
      if (els.soCreateRefusal) {
        els.soCreateRefusal.hidden = false;
        els.soCreateRefusal.textContent = 'Refused: ' + String(error?.message || error);
      }
      if (els.soCreateStatus) els.soCreateStatus.textContent = '';
    } finally {
      els.btnSoCreate.disabled = false;
      await refreshStandingOrders();
    }
  });
}

async function evaluateStandingOrders(eventType) {
  if (els.soEvalStatus) els.soEvalStatus.textContent = 'Evaluating ' + eventType + '…';
  try {
    const result = await api('/api/standing-orders/evaluate', { method: 'POST', body: { eventType } });
    if (els.soEvalStatus) {
      els.soEvalStatus.textContent = eventType + ': ' + (result.matchedCount ?? 0) + ' matched, '
        + (result.summary?.ran ?? 0) + ' ran, ' + (result.summary?.skipped ?? 0) + ' skipped, '
        + (result.summary?.halted ?? 0) + ' halted.';
    }
  } catch (error) {
    if (els.soEvalStatus) els.soEvalStatus.textContent = 'Evaluation refused: ' + String(error?.message || error);
  } finally {
    await refreshStandingOrders();
  }
}

if (els.btnSoEvaluate) {
  els.btnSoEvaluate.addEventListener('click', () => {
    void evaluateStandingOrders(els.soEvalTriggerSelect?.value ?? 'workspace_dirty');
  });
}
if (els.btnSoEvaluateDirty) {
  els.btnSoEvaluateDirty.addEventListener('click', () => { void evaluateStandingOrders('workspace_dirty'); });
}

if (els.btnAgendaCreate) {
  els.btnAgendaCreate.addEventListener('click', async () => {
    const title = (els.agendaTitleInput?.value ?? '').trim();
    const linkedArtifactId = (els.agendaLinkInput?.value ?? '').trim();
    els.btnAgendaCreate.disabled = true;
    try {
      const item = await api('/api/agenda', {
        method: 'POST',
        body: {
          title,
          priority: els.agendaPrioritySelect?.value ?? 'normal',
          category: els.agendaCategorySelect?.value ?? 'commitment',
          ...(linkedArtifactId ? { linkedArtifactId } : {}),
        },
      });
      if (els.agendaTitleInput) els.agendaTitleInput.value = '';
      if (els.agendaLinkInput) els.agendaLinkInput.value = '';
      if (els.agendaAddStatus) els.agendaAddStatus.textContent = 'Added ' + item.itemId + '.';
    } catch (error) {
      if (els.agendaAddStatus) els.agendaAddStatus.textContent = 'Refused: ' + String(error?.message || error);
    } finally {
      els.btnAgendaCreate.disabled = false;
      await refreshAgenda();
    }
  });
}

if (els.agendaList) {
  els.agendaList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const itemId = button.dataset.agendaId;
    const action = button.dataset.action;
    if (action === 'trace-agenda-item') {
      await openTrace(itemId, button).catch(() => {});
      return;
    }
    button.disabled = true;
    try {
      const verb = action === 'complete-agenda-item' ? 'complete' : 'dismiss';
      await api('/api/agenda/' + encodeURIComponent(itemId) + '/' + verb, { method: 'POST', body: {} });
      if (els.agendaAddStatus) els.agendaAddStatus.textContent = itemId + ' ' + (verb === 'complete' ? 'completed' : 'dismissed') + '.';
    } catch (error) {
      if (els.agendaAddStatus) els.agendaAddStatus.textContent = 'Refused: ' + String(error?.message || error);
    } finally {
      await refreshAgenda();
    }
  });
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

// T-43 Package 3: the git panel's controls and the telemetry refresh. Every one of them calls a route
// the controller owns, so a checkpoint create and a restore are the governed capabilities rather than a
// client-side shortcut. A refusal is reported beside the control that attempted it.
if (els.gitRefresh) {
  els.gitRefresh.addEventListener('click', () => { void refreshGitPanel(); });
}
if (els.gitDiffInspect) {
  els.gitDiffInspect.addEventListener('click', () => { void inspectDiff(); });
}
if (els.gitDiffPathInput) {
  // Enter inspects the typed path rather than submitting a form, because the panel has no form and an
  // input that swallows Enter teaches the owner the control does not work.
  els.gitDiffPathInput.addEventListener('keydown', (event) => {
    if (event && event.key === 'Enter') { event.preventDefault(); void inspectDiff(); }
  });
}
if (els.gitCheckpointCreate) {
  els.gitCheckpointCreate.addEventListener('click', () => { void createCheckpoint(); });
}
if (els.gitCheckpointLabel) {
  els.gitCheckpointLabel.addEventListener('keydown', (event) => {
    if (event && event.key === 'Enter') { event.preventDefault(); void createCheckpoint(); }
  });
}
// The checkpoint list is re-rendered on every refresh, so its buttons are bound through one delegated
// listener on the list itself. Binding per row would leak a handler per checkpoint per refresh.
// Which element a checkpoint click belongs to. A real browser gives the innermost element, and its
// closest() walks up to the control; a test harness dispatches on the control itself and its closest()
// is a stub. Handling both is not defensive padding: the delegated handler is the only thing binding
// these per-row controls, so a resolver that only worked from a child element would make every restore
// and trace button untestable outside a browser.
function checkpointActionTarget(event) {
  const node = event && event.target ? event.target : null;
  if (!node) return null;
  if (node.dataset && typeof node.dataset.action === 'string' && node.dataset.action.length > 0) return node;
  if (typeof node.closest === 'function') {
    const found = node.closest('[data-action]');
    if (found && found.dataset && typeof found.dataset.action === 'string') return found;
  }
  // Walking up the parent chain, because the harness's closest() is a stub and the click may land on a
  // child span in a real browser that does not expose dataset on the event target.
  let current = node.parentNode ?? null;
  let depth = 0;
  while (current && depth < 12) {
    if (current.dataset && typeof current.dataset.action === 'string' && current.dataset.action.length > 0) return current;
    current = current.parentNode ?? null;
    depth += 1;
  }
  return null;
}

if (els.checkpointsList) {
  els.checkpointsList.addEventListener('click', (event) => {
    const target = checkpointActionTarget(event);
    if (!target) return;
    const action = target.dataset.action;
    const checkpointId = target.dataset.checkpointId ?? null;
    if (action === 'restore-git-checkpoint') { void restoreCheckpoint(checkpointId); return; }
    if (action === 'trace-git-checkpoint') { openCheckpointTrace(checkpointId); }
  });
}
if (els.telemetryRefresh) {
  els.telemetryRefresh.addEventListener('click', () => { void refreshTelemetry(); });
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
    // T-40 Step 3: Escape closes the reference first. Closing it is not the same as clearing the
    // command bar, so the line the owner was writing survives.
    if (helpState.open) {
      event.preventDefault();
      closeCommandHelp();
      return;
    }
    dismissCommandDispatch();
    // T-46 STEP 1: Escape closes the measures popover and puts focus back on the button that opened
    // it. It closes BEFORE the boot sequence, because the popover is the smaller surface and Escape
    // has to unwind the most recent thing first.
    if (measuresOpen()) {
      event.preventDefault();
      closeMeasures({ returnFocus: true });
      return;
    }
    // T-36 Step 2: Escape also dismisses the boot sequence. The overlay never traps the owner.
    if (state.bootSequence.active) dismissBootSequence();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault();
    moveView(event.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (typing) return;
  if (event.key === '/' && !event.shiftKey && els.text) {
    event.preventDefault();
    focusCommandDispatch();
    return;
  }
  // T-40 Step 3: the question mark opens the command reference. On a layout where Shift+/ does not resolve to it,
  // the physical key path is accepted too, so the binding is not a UK-only or US-only accident.
  if ((event.key === '?' || (event.key === '/' && event.shiftKey)) && !state.bootSequence.active) {
    event.preventDefault();
    void openCommandHelp();
  }
});

// T-40 Step 3: the command and keyboard reference.
//
// The panel is filled from GET /api/command/catalog, which the router builds from the same tables it
// routes with. So this code contains no list of commands: it renders rows, and a row that is not in the
// router cannot appear here. The ECP column is the router's live decision, which means the panel tells
// the truth during a lockdown rather than showing a reference to commands that would all be refused.
const helpState = { open: false, loadedAt: null, catalog: null };

function setHelpState(message, tone) {
  if (!els.hudCommandHelpState) return;
  els.hudCommandHelpState.textContent = message;
  els.hudCommandHelpState.dataset.tone = tone ?? 'idle';
}

function renderHelpKeys(shortcuts) {
  if (!els.hudCommandHelpKeys) return;
  els.hudCommandHelpKeys.replaceChildren();
  for (const shortcut of Array.isArray(shortcuts) ? shortcuts : []) {
    const item = el('li', 'work-item');
    const keys = el('span', 'row');
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut.keys;
    keys.append(kbd);
    if (shortcut.also) {
      keys.append(el('span', 'meta', 'or'));
      const also = document.createElement('kbd');
      also.textContent = shortcut.also;
      keys.append(also);
    }
    item.append(keys);
    item.append(el('p', 'meta', shortcut.effect ?? ''));
    els.hudCommandHelpKeys.append(item);
  }
}

function renderHelpRows(catalog) {
  if (!els.hudCommandHelpRows) return;
  els.hudCommandHelpRows.replaceChildren();
  const commands = Array.isArray(catalog?.commands) ? catalog.commands : [];
  for (const command of commands) {
    const row = document.createElement('tr');
    row.dataset.commandRoute = command.routeKind;
    // The command itself, as a button: pressing it fills the bar. That is the whole interaction, and it
    // is why a template is safe - it types a line, it does not run one.
    const syntaxCell = document.createElement('td');
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'quiet small';
    fill.dataset.fillCommand = command.syntax;
    fill.textContent = command.syntax;
    fill.addEventListener('click', () => { fillCommandFromHelp(command); });
    syntaxCell.append(fill);
    row.append(syntaxCell);

    const routeCell = document.createElement('td');
    routeCell.append(el('span', 'meta', command.routeKind));
    routeCell.append(el('p', 'meta', command.summary ?? ''));
    if (Array.isArray(command.argument) && command.argument.length > 0) {
      routeCell.append(el('p', 'meta', 'one of: ' + command.argument.join(', ')));
    }
    row.append(routeCell);

    const govCell = document.createElement('td');
    const capability = command.capability;
    if (capability) {
      const decision = capability.ecpDecision ?? 'unknown';
      const badge = el('span', decision === 'allow' ? 'badge badge-ok' : decision === 'deny' ? 'badge badge-bad' : 'badge', 'ECP: ' + decision);
      badge.dataset.ecpDecision = decision;
      govCell.append(badge);
      govCell.append(el('p', 'meta', capability.name + (capability.permission ? ' · ' + capability.permission : '')));
      govCell.append(el('p', 'meta', 'reversibility ' + (capability.reversibility ?? 'undeclared')
        + ' · blast ' + (capability.blastRadius ?? 'undeclared')));
    } else {
      govCell.append(el('span', 'badge', 'no capability'));
      govCell.append(el('p', 'meta', command.route ? 'reads ' + command.route : 'focuses a workspace'));
    }
    row.append(govCell);
    els.hudCommandHelpRows.append(row);
  }
}

// Filling the bar is a convenience, never a dispatch: the owner still presses Send. A template whose
// argument slot has already been chosen is filled completely; a prefix keeps its slot open.
function fillCommandFromHelp(command) {
  if (!els.text) return;
  let value = command.syntax;
  if (value === '<anything else>') value = '';
  else if (Array.isArray(command.argument) && command.argument.length > 0) value = command.syntax.replace('<mode>', command.argument[0]);
  else if (value.includes('<text>')) value = value.replace('<text>', '').trim() + ' ';
  els.text.value = value;
  if (typeof els.text.focus === 'function') els.text.focus({ preventScroll: true });
  if (typeof els.text.setSelectionRange === 'function') els.text.setSelectionRange(value.length, value.length);
  setHelpState('Filled "' + value + '" into the command bar. Press Send to dispatch it.', 'available');
}

async function openCommandHelp() {
  if (!els.hudCommandHelp) return;
  els.hudCommandHelp.hidden = false;
  helpState.open = true;
  if (els.hudHelpToggle) els.hudHelpToggle.setAttribute('aria-expanded', 'true');
  if (els.activity) els.activity.textContent = 'Command reference open. Escape closes it.';
  setHelpState('Reading the command catalogue…', 'loading');
  try {
    const catalog = await api('/api/command/catalog');
    helpState.catalog = catalog;
    helpState.loadedAt = catalog.at ?? new Date().toISOString();
    renderHelpRows(catalog);
    renderHelpKeys(catalog.shortcuts);
    setHelpState(catalog.commands.length + ' commands from the router, with the current ECP decision for each.', 'available');
  } catch (error) {
    // A catalogue that cannot be read leaves the panel open and empty rather than showing an
    // out-of-date copy: a reference to commands that may no longer exist is worse than none.
    renderHelpRows({ commands: [] });
    renderHelpKeys([]);
    setHelpState('The command catalogue could not be read: ' + (error.message ?? 'the server refused it'), 'error');
  }
}

function closeCommandHelp() {
  if (!els.hudCommandHelp) return;
  els.hudCommandHelp.hidden = true;
  helpState.open = false;
  if (els.hudHelpToggle) els.hudHelpToggle.setAttribute('aria-expanded', 'false');
  if (els.activity) els.activity.textContent = '';
}

function toggleCommandHelp() {
  if (helpState.open) closeCommandHelp();
  else void openCommandHelp();
}

if (els.hudHelpToggle) els.hudHelpToggle.addEventListener('click', () => { toggleCommandHelp(); });
if (els.hudHelpClose) els.hudHelpClose.addEventListener('click', () => { closeCommandHelp(); });

// T-36 Step 2 (2026-11-21): Part 4 Screen #1 - the HUD boot sequence.
//
// The Core starts Dormant and wakes through the six subsystems the workstation actually checks.
// Nothing in the sequence is a stage direction: every line is a measured value that came back from
// the server, and a value that could not be read says so.
//
// Three properties the walk checks, and that the code has to earn:
//   * it never traps focus - the panel takes no pointer events outside itself, nothing inside it is
//     focused automatically, and the emergency controls stay clickable while it is up;
//   * Escape dismisses it immediately, and dismissing it leaves the deck in its authoritative state;
//   * with prefers-reduced-motion the transition is instant - no reveal delay, no animation.
const BOOT_SEQUENCE_SUBSYSTEMS = Object.freeze([
  { id: 'safety_latch', label: 'Safety Latch' },
  { id: 'ecp_authority', label: 'ECP Authority' },
  { id: 'resource_fabric', label: 'Resource Fabric' },
  { id: 'git_workspace', label: 'Git Workspace' },
  { id: 'device_trust', label: 'Device Trust' },
  { id: 'executive_briefing', label: 'Executive Briefing' },
]);
const BOOT_SEQUENCE_STEP_DELAY_MS = 140;

function bootWait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function bootRevealDelay() {
  // Reduced motion means the state changes without an animation delay. The values are the same;
  // only the pacing is gone.
  return state.reducedMotion ? 0 : BOOT_SEQUENCE_STEP_DELAY_MS;
}

// A doctor's check state is the state of the subsystem it checked: 'pass' is ok, 'degraded' is
// degraded, 'failed' is failed, and 'not_configured' is unavailable - a check with nothing to
// look at is never reported as a success.
function bootStateOf(checkState) {
  if (checkState === 'pass') return 'ok';
  if (checkState === 'degraded') return 'degraded';
  if (checkState === 'failed') return 'failed';
  return 'unavailable';
}

function renderBootSequenceSteps(steps) {
  if (!els.bootSequenceSteps) return;
  els.bootSequenceSteps.replaceChildren();
  for (const def of BOOT_SEQUENCE_SUBSYSTEMS) {
    const entry = steps.find((candidate) => candidate.id === def.id) ?? null;
    const li = el('li');
    li.dataset.bootStep = def.id;
    li.dataset.bootState = entry ? entry.state : 'pending';
    li.append(el('span', 'boot-step-label', def.label));
    li.append(el('span', 'boot-step-detail', entry ? entry.detail : 'waiting'));
    els.bootSequenceSteps.append(li);
  }
}

function bootStepDetail(state, detail) {
  return String(detail ?? '').slice(0, 160);
}

// The sequence proper. It runs the doctor read first - the safety latch and the ECP authority
// are known before anything is written - and then the governed bootstrap, which does the reading,
// the enrollment and the briefing.
async function runBootSequence({ trigger = 'manual' } = {}) {
  if (state.bootSequence.running) return null;
  state.bootSequence.running = true;
  state.bootSequence.active = true;
  state.bootSequence.dismissed = false;
  state.bootSequence.steps = [];
  // The Core is Dormant for as long as the machine is waking. It is not Idle and it is not
  // Degraded: the deck has not finished verifying its own readiness.
  document.body.dataset.coreState = 'dormant';
  if (els.coreCaption) els.coreCaption.textContent = 'The system is waking and verifying readiness.';
  if (els.bootSequence) els.bootSequence.hidden = false;
  renderBootSequenceSteps([]);
  const revealed = [];
  const reveal = async (step) => {
    revealed.push(step);
    state.bootSequence.steps = revealed.slice();
    renderBootSequenceSteps(revealed);
    if (state.bootSequence.dismissed) return;
    // Reduced motion means no delay at all - not a zero-length timer. The values are identical.
    const delay = bootRevealDelay();
    if (delay > 0) await bootWait(delay);
  };

  try {
    const doctor = await readApi('/api/system/doctor');
    const doctorChecks = doctor.ok === true && Array.isArray(doctor.value?.checks) ? doctor.value.checks : [];
    const latch = doctorChecks.find((entry) => entry.name === 'safety_latch') ?? null;
    const authority = doctorChecks.find((entry) => entry.name === 'ecp_authority') ?? null;
    await reveal({
      id: 'safety_latch',
      state: doctor.ok === true ? bootStateOf(latch?.state) : 'unavailable',
      detail: doctor.ok === true
        ? bootStepDetail(latch?.state, latch?.summary ?? 'the latch state was not reported')
        : 'the doctor could not be read: ' + bootStepDetail(null, doctor.error),
    });
    await reveal({
      id: 'ecp_authority',
      state: doctor.ok === true ? bootStateOf(authority?.state) : 'unavailable',
      detail: doctor.ok === true
        ? bootStepDetail(authority?.state, authority?.summary ?? 'the authority state was not reported')
        : 'the doctor could not be read',
    });

    let report = null;
    let failure = null;
    try {
      report = await api('/api/system/bootstrap', { method: 'POST', body: { reason: 'HUD boot sequence (' + trigger + ')' } });
    } catch (error) {
      failure = String(error?.message || error);
    }
    const reading = report?.perception?.reading ?? null;
    const workspace = reading?.workspace ?? null;
    const device = report?.device ?? null;
    const briefing = report?.briefing ?? null;
    const resourceFact = Array.isArray(briefing?.facts) ? briefing.facts.find((fact) => fact.kind === 'resource') : null;

    await reveal({
      id: 'resource_fabric',
      state: report ? (reading ? 'ok' : 'degraded') : 'failed',
      detail: report
        ? bootStepDetail(null, reading
          ? (reading.host?.cpu?.logicalCount ?? 'unavailable') + ' CPU · '
            + Math.round((reading.host?.memory?.freeBytes ?? 0) / 1048576) + '/'
            + Math.round((reading.host?.memory?.totalBytes ?? 0) / 1048576) + ' MB free'
          : resourceFact?.text ?? 'the host reading was not recorded')
        : bootStepDetail(null, failure ?? 'the bootstrap failed'),
    });
    await reveal({
      id: 'git_workspace',
      state: report ? (workspace?.available === true ? 'ok' : 'unavailable') : 'failed',
      detail: report
        ? bootStepDetail(null, workspace?.available === true
          ? (workspace.branch ?? 'detached') + ' at ' + (workspace.head ?? '(no head)')
          : 'unavailable (' + (workspace?.reason ?? 'no reason recorded') + ')')
        : 'the bootstrap did not complete',
    });
    await reveal({
      id: 'device_trust',
      state: report ? (device?.deviceId ? 'ok' : 'degraded') : 'failed',
      detail: report
        ? bootStepDetail(null, device?.deviceId
          ? device.deviceId + ' (' + (device.status ?? 'unknown') + ')'
          : device?.detail ?? 'no device was enrolled')
        : 'the bootstrap did not complete',
    });
    await reveal({
      id: 'executive_briefing',
      state: report ? (briefing ? 'ok' : 'degraded') : 'failed',
      detail: report
        ? bootStepDetail(null, briefing?.concise ?? 'no briefing was compiled')
        : 'the bootstrap did not complete',
    });
    state.bootSequence.report = report ?? null;
    state.bootSequence.error = failure ?? null;
  } finally {
    state.bootSequence.running = false;
    // The Core returns to its authoritative state: whatever the owners say, not what the boot
    // screen hoped for. A lockdown latch still reads as Lockdown.
    state.bootSequence.active = false;
    dismissBootSequence();
    await refresh();
  }
  return state.bootSequence.report ?? null;
}

// Dismissing the overlay never leaves the deck in a made-up state. It applies the authoritative
// projection and lets the owners speak.
function dismissBootSequence() {
  state.bootSequence.active = false;
  state.bootSequence.dismissed = true;
  if (els.bootSequence) els.bootSequence.hidden = true;
  if (els.coreCaption && document.body.dataset.coreState === 'dormant') {
    els.coreCaption.textContent = 'The system is awake.';
  }
  applyCoreProjection('The boot sequence finished; the state below is the authoritative one.');
}

if (els.measuresTrigger) {
  els.measuresTrigger.addEventListener('click', () => { toggleMeasures(); });
}
// A click anywhere outside the popover and its trigger closes it. It does not prevent the click's own
// effect: the owner clicked something else because that is what they wanted next.
document.addEventListener('click', (event) => {
  if (!measuresOpen()) return;
  const target = event.target;
  if (!target) return;
  if (els.measuresPanel && els.measuresPanel.contains(target)) return;
  if (els.measuresTrigger && els.measuresTrigger === target) return;
  closeMeasures();
});
if (els.bootSequenceDismiss) {
  els.bootSequenceDismiss.addEventListener('click', () => { dismissBootSequence(); });
}
if (els.bootSequenceRun) {
  els.bootSequenceRun.addEventListener('click', () => { runBootSequence({ trigger: 'owner request' }); });
}

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
    if (els.activity) els.activity.textContent = 'dispatching…';
    try {
      const receipt = await dispatchCommand(text.trim());
      els.text.value = '';
      if (els.activity) {
        els.activity.textContent = receipt.verified === true
          ? String(receipt.routeKind) + ' · verified'
          : String(receipt.routeKind) + ' · ' + String(receipt.summary || '').slice(0, 80);
      }
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

// T-37 Step 1: the two Track 2 buttons. Each one is a governed write on the server; the button only
// reports what came back, and a refusal is shown as a refusal rather than as a silent no-op.
if (els.councilCompile) els.councilCompile.addEventListener('click', compileCouncilRecommendation);
if (els.neuralStep) els.neuralStep.addEventListener('click', stepNeural);
if (els.neuralResetBridge) els.neuralResetBridge.addEventListener('click', resetNeuralBridge);

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
          : 'deliberated: ' + (result.synthesis?.recommendedOption?.level ?? 'no recommendation');
      }
      // Keep what was deliberated so the compile button knows what it would compile.
      state.lastCouncil = { objective, result };
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
  source.addEventListener('workshop', (event) => {
    scheduleEventRefresh();
    // T-42 Step 4: a candidate staged anywhere in the system - the Workshop form, the Evolution Lab's
    // bridge, or another tab - is announced on this channel. The candidate list is re-read from the
    // record, so the card, its verify control and its provenance badge exist without a reload.
    let payload = null;
    try { payload = event && event.data ? JSON.parse(event.data) : null; } catch { payload = null; }
    if (payload && payload.candidateId) void refreshCandidateListing();
    armWatchdog();
  });
  source.addEventListener('evolution', (event) => {
    scheduleEventRefresh();
    // T-42 Step 4: a candidate staged from the Evolution Lab arrives through the candidate listing,
    // which is not part of the state snapshot. Re-read it on the event that says a proposal moved.
    let payload = null;
    try { payload = event && event.data ? JSON.parse(event.data) : null; } catch { payload = null; }
    if (payload && (payload.candidateId || payload.fromProposal === true)) void refreshCandidateListing();
    armWatchdog();
  });
  source.onerror = () => {
    if (source !== eventSource) return;
    markEventDegraded('Event stream error.');
    armWatchdog();
  };
}

// T-45 Package 3: the overlay posture is the owner's choice, so it is restored before the first paint of
// a view rather than after it. A browser that refuses storage starts in the full posture, which is the
// posture that hides nothing.
let storedPosture = 'full';
try {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('apex.hudPosture');
    if (saved === 'overlay') storedPosture = 'overlay';
  }
} catch {
  storedPosture = 'full';
}
applyHudPosture(storedPosture, { announce: false });

// T-46 STEP 1: the layout is decided before the first paint of the deck, so the mobile rules and the
// Core's fit are in place before anything is measured - including by the walk that measures them.
applyLayout();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => { applyLayout(); }, { passive: true });
}
// T-46 STEP 2 groundwork: prefers-reduced-motion is read once into state.reducedMotion by the motion
// setup; nothing here overrides it.
syncHeaderStrip();
setView('deck');
connectEvents();
refresh();
// The strip quotes the first read, so it is filled as soon as that read answers rather than on the next
// fifteen-second tick.
void Promise.resolve().then(syncOverlayStrip);
boot();
// T-36 Step 2: the boot overlay starts away. It is shown by the sequence and hidden again when the
// sequence ends; nothing else may leave it on the page.
if (els.bootSequence) els.bootSequence.hidden = true;
// T-36 Step 2: ?boot=1 replays the cold-start sequence on demand, on a machine that is already
// set up as well as on one that is not. It is the same governed bootstrap, so it refreshes the
// readings rather than re-creating them.
if (typeof window !== 'undefined' && window.location && window.location.search) {
  const requested = new URLSearchParams(window.location.search).get('boot');
  if (requested === '1') {
    state.bootSequence.triggered = true;
    runBootSequence({ trigger: 'owner request (?boot=1)' });
  }
}
setInterval(refresh, 15000);
`;
