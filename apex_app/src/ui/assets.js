// Static browser assets for the local APEX UI. They are served from this module so the
// server needs no filesystem reads and no build step. The client renders every piece of
// text with textContent: model output and stored records are untrusted strings.
import { CORE_REACHABLE_STATES, CORE_STATE_DEFINITIONS, CORE_STATE_PRECEDENCE, resolveCoreState, resolveCoreStateFromOwners } from './core-state.js';
import { createEventWatchdog, EVENT_WATCHDOG_MS, HEARTBEAT_SCHEMA, isRecord, STATE_EVENT_OWNERS, STATE_EVENT_SCHEMA, validateHeartbeatEnvelope, validateStateEventEnvelope } from './event-contract.js';

export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APEX</title>
<link rel="stylesheet" href="/style.css">
</head>
<body data-core-state="degraded" data-view="deck" data-motion="full">
<a class="skip-link" href="#main-content">Skip to main content</a>
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
  </div>
  <div class="topbar-actions">
    <button id="new-session" type="button" class="quiet small">New session</button>
    <button id="quick-boot" type="button" class="quiet small">Quick boot</button>
  </div>
</header>
<nav class="nav" aria-label="Primary">
  <button data-view="deck" class="nav-item active">Deck</button>
  <button data-view="conversations" class="nav-item">Conversations</button>
  <button data-view="missions" class="nav-item">Missions</button>
  <button data-view="tasks" class="nav-item">Tasks</button>
  <button data-view="approvals" class="nav-item">Approvals</button>
  <button data-view="sentinel" class="nav-item">Sentinel</button>
  <button data-view="memory" class="nav-item">Memory</button>
  <button data-view="documents" class="nav-item">Documents</button>
  <button data-view="reasoning" class="nav-item">Reasoning</button>
  <button data-view="council" class="nav-item">Council</button>
  <button data-view="system" class="nav-item">System</button>
  <button data-view="integrations" class="nav-item">Integrations</button>
  <button data-view="workshop" class="nav-item">Workshop</button>
</nav>
<main id="main-content" class="deck">
  <aside class="rail left" aria-label="Missions">
    <section class="panel">
      <h2>Active missions</h2>
      <ul id="missions-list" class="work"></ul>
    </section>
    <section class="panel">
      <h2>TaskGraph</h2>
      <ul id="taskgraph" class="work"></ul>
    </section>
  </aside>
  <section class="stage" aria-label="APEX Core">
    <div class="core-wrap">
      <svg class="core" viewBox="0 0 240 240" role="img" aria-label="APEX Core status">
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#00e5ff" stop-opacity="0.95"/>
            <stop offset="55%" stop-color="#00e5ff" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#00e5ff" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <circle class="core-halo" cx="120" cy="120" r="96"/>
        <circle class="core-ring outer" cx="120" cy="120" r="88"/>
        <circle class="core-ring mid" cx="120" cy="120" r="70"/>
        <circle class="core-ring inner" cx="120" cy="120" r="52"/>
        <circle class="core-center" cx="120" cy="120" r="28"/>
        <g class="core-segments">
          <path d="M120 32 A88 88 0 0 1 208 120" />
          <path d="M208 120 A88 88 0 0 1 120 208" />
          <path d="M120 208 A88 88 0 0 1 32 120" />
          <path d="M32 120 A88 88 0 0 1 120 32" />
        </g>
      </svg>
      <div class="core-state" id="core-state" role="status" aria-live="polite">Degraded</div>
      <p class="core-caption" id="core-caption">Waiting for an authoritative owner snapshot.</p>
    </div>
    <section class="panel conversation" id="conversation-panel">
      <h2>Conversation</h2>
      <div id="banner" class="banner" role="alert" hidden></div>
      <ol id="turns" class="turns"></ol>
      <form id="chat-form">
        <label for="chat-text" class="visually-hidden">Message</label>
        <textarea id="chat-text" rows="3" maxlength="4000" placeholder="Command APEX, or ask for a verified read"></textarea>
        <div class="row">
          <button id="send" type="submit">Send</button>
          <span id="activity" class="meta" role="status"></span>
        </div>
      </form>
    </section>
  </section>
  <aside class="rail right" aria-label="Sentinel and approvals">
    <section class="panel">
      <h2>Sentinel</h2>
      <ul id="sentinel" class="work"></ul>
    </section>
    <section class="panel">
      <h2>Approvals</h2>
      <ul id="approvals" class="work"></ul>
    </section>
    <section class="panel">
      <h2>Briefings</h2>
      <p id="briefing-status" class="workspace-status" role="status" aria-live="polite">Loading recorded briefing…</p>
      <ul id="briefings" class="work"></ul>
    </section>
  </aside>
</main>
<section class="workspace" id="workspace">
  <section class="view" data-view="conversations">
    <h2>Conversations</h2>
    <p class="meta">Session persistence and history. The current session is shown on the deck; older turns remain in the conversation log.</p>
    <p id="conversation-status" class="workspace-status" role="status" aria-live="polite">Loading conversation records…</p>
    <ul id="conversation-history" class="work"></ul>
  </section>
  <section class="view" data-view="missions">
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
  </section>
  <section class="view" data-view="tasks">
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
  <section class="view" data-view="approvals">
    <h2>Approval Centre</h2>
    <p class="meta">Pending requests come from TaskStore, PlanStore and Sentinel records. Approving records intent only; it does not start a task or run a response. Risk, scope, reversibility and expiry are not inferred when an owner did not record them.</p>
    <p id="approval-state" class="workspace-status" role="status" aria-live="polite">Loading pending owner requests…</p>
    <p id="approval-action-status" class="workspace-status" role="status" aria-live="polite"></p>
    <ul id="approval-items" class="work"></ul>
  </section>
  <section class="view" data-view="sentinel">
    <h2>Sentinel — recorded situational events</h2>
    <p class="meta">A bounded view of recorded observations, assessments, decisions and provenance. It does not imply that an external source is currently being watched.</p>
    <p id="sentinel-status" class="workspace-status" role="status" aria-live="polite">Loading situational records…</p>
    <ul id="sentinel-full" class="work"></ul>
  </section>
  <section class="view" data-view="memory">
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
  </section>
  <section class="view" data-view="documents">
    <h2>Authorized documents</h2>
    <p id="documents-status" class="workspace-status" role="status" aria-live="polite">Loading document index…</p>
    <form id="doc-search-form" class="row">
      <label for="doc-search" class="visually-hidden">Search documents</label>
      <input id="doc-search" type="search" maxlength="500" placeholder="Search exact terms">
      <button id="doc-search-button" type="submit" class="small">Search</button>
    </form>
    <ul id="documents" class="work"></ul>
  </section>
  <section class="view" data-view="reasoning">
    <h2>Reasoning workspace</h2>
    <p class="meta">Deterministic, evidence-linked reasoning records. This view reads stored sessions; it does not run inference or authorize actions.</p>
    <p id="reasoning-status" class="workspace-status" role="status" aria-live="polite">Loading reasoning records…</p>
    <ul id="reasoning" class="work"></ul>
  </section>
  <section class="view" data-view="council">
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
  <section class="view" data-view="system">
    <h2>System diagnostics and Resource Fabric</h2>
    <p class="meta">Read-only diagnostics from the health, runtime, ECP and resource owners. Unknown or unavailable readings are not treated as healthy.</p>
    <p id="system-status" class="workspace-status" role="status" aria-live="polite">Loading system diagnostics…</p>
    <section class="panel safety" aria-labelledby="safety-heading">
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
  </section>
  <section class="view" data-view="integrations">
    <h2>Integrations</h2>
    <p id="integrations-status" class="workspace-status" role="status" aria-live="polite">Loading integration state…</p>
    <ul id="integrations" class="work"></ul>
  </section>
  <section class="view" data-view="workshop">
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
    <div id="workshop-report" class="panel"></div>
    <ul id="workshop" class="work"></ul>
  </section>
</section>
<script src="/app.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root {
  --bg0: #05080f;
  --bg1: #0a1220;
  --panel: rgba(12, 22, 38, 0.72);
  --panel-strong: rgba(16, 28, 48, 0.9);
  --line: rgba(84, 132, 176, 0.28);
  --line-strong: rgba(0, 229, 255, 0.42);
  --text: #dcebff;
  --muted: #7fa3c7;
  --cyan: #00e5ff;
  --gold: #ffb000;
  --red: #e10600;
  --green: #2bff88;
  --radius: 12px;
  --font-display: "Orbitron", "Rajdhani", "Segoe UI", sans-serif;
  --font-body: "Exo 2", "Inter", "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "Share Tech Mono", "Consolas", monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font: 15px/1.5 var(--font-body);
  color: var(--text);
  background:
    radial-gradient(circle at 50% 42%, rgba(0, 229, 255, 0.12), transparent 34%),
    radial-gradient(circle at 80% 10%, rgba(255, 176, 0, 0.08), transparent 28%),
    linear-gradient(180deg, var(--bg1), var(--bg0));
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
#safety-status[data-safety="active"] { color: var(--red); }
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
.item .plan-cancel { margin-top: .5rem; }
.item .plan-cancel textarea, .item .approval-decision textarea { min-height: 2.4rem; }
.view > .panel { margin: .75rem 0; }
.view { display: none; }
.view.active { display: block; }
.view h2 { margin-bottom: .8rem; }
@media (max-width: 1100px) {
  .deck { grid-template-columns: 1fr; }
  .core-wrap { order: -1; }
}
@media (max-width: 720px) {
  .topbar { grid-template-columns: 1fr; }
  .nav { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  body { animation: none; }
  .core-ring { animation: none !important; }
}
.boot {
  position: fixed; inset: 0; z-index: 50; background: rgba(5,8,15,0.96);
  display: grid; place-items: center; gap: 1rem; padding: 2rem;
}
.boot.hidden { display: none; }
.boot-core { width: 90px; height: 90px; border-radius: 50%; border: 2px solid var(--cyan); box-shadow: 0 0 30px rgba(0,229,255,0.4); animation: spin 6s linear infinite; }
.boot-lines { font-family: var(--font-mono); color: var(--muted); max-width: 36rem; width: 100%; }
.boot-lines div { padding: .2rem 0; }
`;

export const UI_CLIENT = `'use strict';
const STATE_EVENT_SCHEMA = ${JSON.stringify(STATE_EVENT_SCHEMA)};
const HEARTBEAT_SCHEMA = ${JSON.stringify(HEARTBEAT_SCHEMA)};
const STATE_EVENT_OWNERS = ${JSON.stringify(STATE_EVENT_OWNERS)};
const EVENT_WATCHDOG_MS = ${EVENT_WATCHDOG_MS};
const isRecord = ${isRecord.toString()};
const validateStateEventEnvelope = ${validateStateEventEnvelope.toString()};
const validateHeartbeatEnvelope = ${validateHeartbeatEnvelope.toString()};
const createEventWatchdog = ${createEventWatchdog.toString()};
const CORE_STATE_DEFINITIONS = ${JSON.stringify(CORE_STATE_DEFINITIONS)};
const CORE_REACHABLE_STATES = ${JSON.stringify(CORE_REACHABLE_STATES)};
const CORE_STATE_PRECEDENCE = ${JSON.stringify(CORE_STATE_PRECEDENCE)};
const resolveCoreState = ${resolveCoreState.toString()};
const resolveCoreStateFromOwners = ${resolveCoreStateFromOwners.toString()};
const els = {
  turns: document.getElementById('turns'),
  form: document.getElementById('chat-form'),
  text: document.getElementById('chat-text'),
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
  knowledgeStatus: document.getElementById('knowledge-status'),
  worldStatus: document.getElementById('world-status'),
  conversationStatus: document.getElementById('conversation-status'),
  sentinelStatus: document.getElementById('sentinel-status'),
  documentsStatus: document.getElementById('documents-status'),
  reasoningStatus: document.getElementById('reasoning-status'),
  councilState: document.getElementById('council-state'),
  workshopState: document.getElementById('workshop-state'),
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
  situation: document.getElementById('situation'),
  runtime: document.getElementById('runtime'),
  sources: document.getElementById('sources'),
  documents: document.getElementById('documents'),
  reasoning: document.getElementById('reasoning'),
  council: document.getElementById('council'),
  councilForm: document.getElementById('council-form'),
  councilObjective: document.getElementById('council-objective'),
  councilGather: document.getElementById('council-gather'),
  councilRun: document.getElementById('council-run'),
  councilStatus: document.getElementById('council-status'),
  councilSynthesis: document.getElementById('council-synthesis'),
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
  goals: document.getElementById('goals'),
  memory: document.getElementById('memory'),
  knowledge: document.getElementById('knowledge'),
  world: document.getElementById('world'),
  integrations: document.getElementById('integrations'),
  sentinelFull: document.getElementById('sentinel-full'),
  conversationHistory: document.getElementById('conversation-history'),
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
    setWorkspaceStatus(target, 'No ' + label + ' are recorded in the owner store.', 'empty');
    return;
  }
  const countText = shown === null ? String(total) : shown + ' of ' + total;
  let text = 'Loaded ' + countText + ' recorded ' + label + (source.truncated ? ' (bounded view).' : '.');
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
    if (value?.status === 'partial' || missing.length > 0) {
      setWorkspaceStatus(els.missionStatus, 'Partial owner read; unavailable: ' + (missing.join(', ') || 'one or more stores') + '.', 'partial');
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
  renderList(els.workshop, artifacts, (artifact) => {
    const meta = (artifact.domain || 'domain not recorded') + ' · ' + artifact.components + ' component(s) · '
      + artifact.connections + ' connection(s) · budget '
      + (artifact.budget === null || artifact.budget === undefined ? 'not declared' : artifact.budget);
    const li = itemFrom(artifact.title || artifact.artifactId, meta);
    const button = el('button', 'small', 'Simulate');
    button.type = 'button';
    button.addEventListener('click', () => { simulateWorkshop(artifact.artifactId); });
    li.append(button);
    return li;
  }, 'No design sheets are recorded in WorkshopStore.');
  renderWorkshopReport(state.workshopReport ?? null);
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

function renderPlanning(planning) {
  const tasks = planning && Array.isArray(planning.tasks) ? planning.tasks : [];
  renderList(els.planning, tasks, (task) => itemFrom(task.description || task.id, task.because || ''));
}

async function refresh() {
  const [stateResult, healthResult, missionResult, approvalResult, timelineResult,
    situationResult, briefingResult, runtimeResult, sourcesResult, documentsResult,
    reasoningResult, councilResult, workshopResult] = await Promise.all([
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
  renderDocuments(documentsResult);
  renderReasoning(reasoningResult);
  renderCouncil(councilResult);
  renderWorkshop(workshopResult);

  applyCoreProjection(snapshot ? '' : 'The authoritative state read failed.');
  return snapshot !== null;
}

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === view);
  });
  const deck = document.querySelector('.deck');
  if (deck) deck.style.display = view === 'deck' ? '' : 'none';
  const workspace = document.getElementById('workspace');
  if (workspace) workspace.style.display = view === 'deck' ? 'none' : '';
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
      const result = await api('/api/safety/release', { method: 'POST', body: { reason, confirm: true } });
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
  source.addEventListener('workshop', () => { scheduleEventRefresh(); armWatchdog(); });
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
