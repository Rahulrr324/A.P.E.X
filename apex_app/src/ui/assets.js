// Static browser assets for the local APEX UI. They are served from this module so the
// server needs no filesystem reads and no build step. The client renders every piece of
// text with textContent: model output and stored records are untrusted strings.
export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APEX</title>
<link rel="stylesheet" href="/style.css">
</head>
<body data-core-state="idle" data-view="deck" data-motion="full">
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
      <div class="core-state" id="core-state">Idle</div>
      <p class="core-caption" id="core-caption">No operation in progress.</p>
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
      <ul id="briefings" class="work"></ul>
    </section>
  </aside>
</main>
<section class="workspace" id="workspace">
  <section class="view" data-view="conversations">
    <h2>Conversations</h2>
    <p class="meta">Session persistence and history. The current session is shown on the deck; older turns remain in the conversation log.</p>
    <ul id="conversation-history" class="work"></ul>
  </section>
  <section class="view" data-view="missions">
    <h2>Missions and objectives</h2>
    <p class="meta">Goals, plans and tasks from the real stores. Planning reads are proposals until recorded and approved.</p>
    <ul id="goals" class="work"></ul>
    <ul id="plans" class="work"></ul>
  </section>
  <section class="view" data-view="tasks">
    <h2>Tasks and execution</h2>
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
  <section class="view" data-view="sentinel">
    <h2>Sentinel events</h2>
    <ul id="sentinel-full" class="work"></ul>
  </section>
  <section class="view" data-view="memory">
    <h2>Memory timeline</h2>
    <ul id="memory" class="work"></ul>
    <h3>Knowledge</h3>
    <ul id="knowledge" class="work"></ul>
    <h3>World model</h3>
    <ul id="world" class="work"></ul>
  </section>
  <section class="view" data-view="documents">
    <h2>Authorized documents</h2>
    <form id="doc-search-form" class="row">
      <label for="doc-search" class="visually-hidden">Search documents</label>
      <input id="doc-search" type="search" maxlength="500" placeholder="Search exact terms">
      <button id="doc-search-button" type="submit" class="small">Search</button>
    </form>
    <ul id="documents" class="work"></ul>
  </section>
  <section class="view" data-view="reasoning">
    <h2>Reasoning workspace</h2>
    <ul id="reasoning" class="work"></ul>
  </section>
  <section class="view" data-view="council">
    <h2>Council</h2>
    <p class="meta">Seven deterministic perspectives over evidence owned by the existing stores. A synthesis explains disagreement and never authorizes execution. Evidence is gathered from the real stores when "gather" is on; no model is contacted.</p>
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
    <h2>System and Resource Fabric</h2>
    <div id="health-overall" class="row"></div>
    <ul id="health" class="work"></ul>
    <h3>Runtime</h3>
    <ul id="runtime" class="work"></ul>
    <h3>External sources</h3>
    <ul id="sources" class="work"></ul>
  </section>
  <section class="view" data-view="integrations">
    <h2>Integrations</h2>
    <ul id="integrations" class="work"></ul>
  </section>
  <section class="view" data-view="workshop">
    <h2>Workshop</h2>
    <p class="meta">A deterministic design sheet: components with declared supply, demand and cost, connections between them, and an optional budget. A simulation is arithmetic over the declared numbers. Nothing here is executed, and a simulation never authorizes an action.</p>
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
body[data-core-state="thinking"] .core-ring.outer { animation-duration: 4s; stroke: var(--gold); }
body[data-core-state="awaiting"] .core-ring.outer { stroke: var(--gold); stroke-dasharray: 2 8; }
body[data-core-state="executing"] .core-center { fill: rgba(43,255,136,0.22); stroke: var(--green); }
body[data-core-state="degraded"] .core { filter: drop-shadow(0 0 12px rgba(255,176,0,0.35)); opacity: 0.82; }
body[data-core-state="lockdown"] .core { filter: drop-shadow(0 0 18px rgba(225,6,0,0.5)); }
body[data-core-state="lockdown"] .core-ring, body[data-core-state="lockdown"] .core-center { stroke: var(--red); }
body[data-motion="reduced"] .core-ring, body[data-motion="reduced"] .core-segments path { animation: none !important; }
@keyframes spin { to { transform: rotate(360deg); } }
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
  plans: document.getElementById('plans'),
  planning: document.getElementById('planning'),
  planningForm: document.getElementById('planning-form'),
  planningObjective: document.getElementById('planning-objective'),
  planningGoal: document.getElementById('planning-goal'),
  planningRead: document.getElementById('planning-read'),
  planningStatus: document.getElementById('planning-status'),
  healthOverall: document.getElementById('health-overall'),
  health: document.getElementById('health'),
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
  missions: document.getElementById('missions-list'),
  taskgraph: document.getElementById('taskgraph'),
  sentinel: document.getElementById('sentinel'),
  approvals: document.getElementById('approvals'),
  briefings: document.getElementById('briefings'),
  goals: document.getElementById('goals'),
  memory: document.getElementById('memory'),
  knowledge: document.getElementById('knowledge'),
  world: document.getElementById('world'),
  integrations: document.getElementById('integrations'),
  sentinelFull: document.getElementById('sentinel-full'),
  conversationHistory: document.getElementById('conversation-history'),
};

const state = { core: 'idle', view: 'deck', last: null, lastSeq: 0, reducedMotion: false };

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

function setCore(next, caption) {
  state.core = next;
  document.body.dataset.coreState = next;
  if (els.coreState) els.coreState.textContent = next.charAt(0).toUpperCase() + next.slice(1);
  if (els.coreCaption && caption) els.coreCaption.textContent = caption;
}

function renderTurns(turns) {
  if (!els.turns) return;
  els.turns.replaceChildren();
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) {
    els.turns.append(el('li', 'meta', 'No turns in this session yet.'));
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

function renderList(target, items, mapper) {
  if (!target) return;
  target.replaceChildren();
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    target.append(el('li', 'meta', 'No records available.'));
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

function renderTasks(tasks) {
  renderList(els.tasks, tasks, (task) => itemFrom(task.goal || task.id, (task.status || 'unknown') + (task.approval ? ' · approval' : '')));
  renderList(els.taskgraph, tasks, (task) => itemFrom(task.goal || task.id, 'steps: ' + (Array.isArray(task.steps) ? task.steps.length : 0)));
  if (els.approvals) {
    const pending = (Array.isArray(tasks) ? tasks : []).filter((task) => task.approval);
    renderList(els.approvals, pending, (task) => itemFrom(task.goal || task.id, 'approval required'));
  }
}

function renderPlans(plans) {
  renderList(els.plans, plans, (plan) => itemFrom(plan.outcome || plan.id, (plan.status || 'unknown') + (plan.approved ? ' · approved' : '')));
}

function renderGoals(goals) {
  renderList(els.goals, goals, (goal) => itemFrom(goal.title || goal.id, goal.status || 'recorded'));
}

function renderMissions(state) {
  const missions = [];
  for (const goal of (state.goals || [])) missions.push(goal.title || goal.id);
  for (const plan of (state.plans || [])) missions.push(plan.outcome || plan.id);
  renderList(els.missions, missions.map((title) => ({ title })), (m) => itemFrom(m.title, 'mission'));
}

function renderSentinel(situation) {
  const items = [];
  if (situation && Array.isArray(situation.observations)) items.push(...situation.observations.map((x) => x.summary || x.id || 'observation'));
  if (situation && Array.isArray(situation.alerts)) items.push(...situation.alerts.map((x) => x.summary || x.id || 'alert'));
  if (situation && Array.isArray(situation.pendingDecisions)) items.push(...situation.pendingDecisions.map((x) => x.summary || x.id || 'decision'));
  const mapped = items.map((text) => ({ text }));
  renderList(els.sentinel, mapped, (x) => itemFrom(x.text, 'sentinel'));
  renderList(els.sentinelFull, mapped, (x) => itemFrom(x.text, 'sentinel'));
  renderList(els.briefings, (situation && Array.isArray(situation.briefings) ? situation.briefings : []).map((x) => ({ text: x.summary || x.id || 'briefing' })), (x) => itemFrom(x.text, 'briefing'));
}

function renderHealth(health) {
  if (!els.health) return;
  els.health.replaceChildren();
  if (els.healthOverall) els.healthOverall.replaceChildren();
  if (!health || health.unavailable) {
    els.health.append(el('li', 'meta', 'The health view is not available.'));
    return;
  }
  if (els.healthOverall) els.healthOverall.append(el('span', 'badge', 'overall: ' + (health.overall || 'unknown')));
  for (const area of (health.areas || [])) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', area.label));
    head.append(el('span', 'badge', area.state + (area.advisory && area.state === 'unknown' ? ' / not checked' : '')));
    item.append(head);
    item.append(el('div', 'meta', area.summary));
    els.health.append(item);
  }
}

function renderRuntime(runtime) {
  renderList(els.runtime, Array.isArray(runtime) ? runtime : (runtime ? [runtime] : []), (row) => itemFrom(row.status || row.state || 'runtime', row.detail || ''));
}

function renderSources(sources) {
  renderList(els.sources, Array.isArray(sources) ? sources : (sources ? [sources] : []), (row) => itemFrom(row.name || row.provider || 'source', row.status || row.health || ''));
  renderList(els.integrations, Array.isArray(sources) ? sources : (sources ? [sources] : []), (row) => itemFrom(row.name || row.provider || 'integration', row.status || row.health || ''));
}

function renderDocuments(documents) {
  const docs = documents && Array.isArray(documents.documents) ? documents.documents : [];
  const results = documents && Array.isArray(documents.results) ? documents.results : [];
  const items = results.length ? results : docs;
  renderList(els.documents, items, (doc) => itemFrom(doc.title || doc.id || doc.path || 'document', doc.status || doc.summary || ''));
}

function renderReasoning(reasoning) {
  if (!els.reasoning) return;
  els.reasoning.replaceChildren();
  if (!reasoning || reasoning.unavailable) {
    els.reasoning.append(el('li', 'meta', 'Reasoning is unavailable.'));
    return;
  }
  const sessions = Array.isArray(reasoning.sessions) ? reasoning.sessions : [];
  for (const session of sessions.slice(0, 8)) {
    els.reasoning.append(itemFrom(session.sessionId || session.id || 'session', session.status || 'recorded'));
  }
  if (sessions.length === 0) els.reasoning.append(el('li', 'meta', 'No reasoning sessions recorded.'));
}

function renderCouncil(council) {
  if (!els.council) return;
  els.council.replaceChildren();
  if (!council || council.unavailable) {
    els.council.append(el('li', 'meta', 'Council is unavailable.'));
    return;
  }
  const sessions = Array.isArray(council.sessions) ? council.sessions : [];
  for (const session of sessions.slice(0, 12)) {
    const title = (session.recommendation ? session.recommendation + ' · ' : '') + (session.objective || session.sessionId);
    const meta = 'support ' + (session.support || 'unknown') + ' · ' + (session.at ? String(session.at).slice(0, 19) : '');
    els.council.append(itemFrom(title, meta));
  }
  if (sessions.length === 0) els.council.append(el('li', 'meta', 'No council sessions recorded.'));
  if (els.councilSynthesis) {
    els.councilSynthesis.replaceChildren();
    const latest = council.session;
    // The stored session keeps the whole synthesis record; the recommendation itself is nested.
    if (!latest || !latest.synthesis || !latest.synthesis.synthesis) {
      els.councilSynthesis.append(el('p', 'meta', 'No stored synthesis yet.'));
    } else {
      const s = latest.synthesis.synthesis;
      const verdict = el('p', '', 'Recommended: ' + s.recommendedOption.level + ' · support ' + s.support + ' · confidence ' + s.confidence);
      const summary = el('p', 'meta', s.explanation || '');
      const disagreement = el('p', 'meta', 'Disagreement: ' + (latest.disagreement?.kind || 'unknown') + ' — ' + (latest.synthesis.disagreementExplanation || latest.disagreement?.detail || ''));
      const evidence = el('p', 'meta', 'Supporting ' + (s.supportingEvidence?.length || 0) + ' · Conflicting ' + (s.conflictingEvidence?.length || 0) + ' · Approvals: ' + (s.requiredApprovals || []).join(', '));
      els.councilSynthesis.append(verdict, summary, disagreement, evidence);
      const list = el('ul', 'work');
      for (const p of (latest.positions || []).slice(0, 7)) {
        list.append(itemFrom(p.perspectiveName || p.perspectiveId, (p.position && p.position.verdict) || p.status));
      }
      els.councilSynthesis.append(list);
    }
  }
}

function renderWorkshop(page) {
  if (!els.workshop) return;
  els.workshop.replaceChildren();
  if (!page || page.unavailable) {
    els.workshop.append(el('li', 'meta', 'Workshop is unavailable.'));
  } else {
    const artifacts = Array.isArray(page.artifacts) ? page.artifacts : [];
    for (const artifact of artifacts.slice(0, 12)) {
      const meta = `${artifact.domain} · ${artifact.components} component(s) · ${artifact.connections} connection(s) · budget ${artifact.budget === null || artifact.budget === undefined ? 'not declared' : artifact.budget}`;
      const li = itemFrom(artifact.title || artifact.artifactId, meta);
      const button = el('button', 'small', 'Simulate');
      button.type = 'button';
      button.dataset.artifactId = artifact.artifactId;
      button.addEventListener('click', () => { simulateWorkshop(artifact.artifactId); });
      li.append(button);
      els.workshop.append(li);
    }
    if (artifacts.length === 0) els.workshop.append(el('li', 'meta', 'No workshop artifacts are stored.'));
  }
  renderWorkshopReport(state.workshopReport ?? null);
}

function renderWorkshopReport(report) {
  if (!els.workshopReport) return;
  els.workshopReport.replaceChildren();
  if (!report) {
    els.workshopReport.append(el('p', 'meta', 'No simulation yet. Compose a sheet, then simulate a stored artifact.'));
    return;
  }
  els.workshopReport.append(el('p', '', `Simulation of ${report.artifactId}: ${report.status}`));
  els.workshopReport.append(el('p', 'meta', report.budget === null || report.budget === undefined
    ? 'budget: not declared'
    : `budget: ${report.budget.spent} of ${report.budget.total}${report.budget.overBudget ? ' (over)' : ''}`));
  const list = el('ul', 'work');
  for (const component of (Array.isArray(report.components) ? report.components : [])) {
    list.append(itemFrom(component.id, `receives ${component.inbound}, demands ${component.demand}${component.satisfied ? '' : ' · short'} · cost ${component.cost}`));
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

function renderMemory(records) {
  renderList(els.memory, Array.isArray(records) ? records : [], (row) => itemFrom(row.content || row.id || 'memory', row.status || row.source || ''));
}

function renderPlanning(planning) {
  const tasks = planning && Array.isArray(planning.tasks) ? planning.tasks : [];
  renderList(els.planning, tasks, (task) => itemFrom(task.description || task.id, task.because || ''));
}

function renderKnowledge(claims) {
  renderList(els.knowledge, Array.isArray(claims) ? claims : [], (row) => itemFrom(row.claim || row.statement || row.id || 'knowledge', row.status || row.lifecycleState || ''));
}

function renderWorld(data) {
  renderList(els.world, Array.isArray(data && data.entities) ? data.entities : [], (row) => itemFrom(row.name || row.id || 'entity', row.category || row.status || ''));
}

function renderConversationHistory(turns) {
  renderList(els.conversationHistory, Array.isArray(turns) ? turns : [], (turn) => itemFrom(turn.text || turn.id || 'turn', turn.role || ''));
}

async function refresh() {
  try {
    const stateData = await api('/api/state');
    const s = stateData && typeof stateData === 'object' ? stateData : {};
    state.last = s;
    renderTurns(s.turns);
    renderTasks(s.tasks);
    renderPlans(s.plans);
    renderGoals(s.goals);
    renderMissions(s);
    renderSentinel(s.situation);
    renderHealth(await api('/api/health').catch(() => null));
    renderRuntime(s.runtime);
    renderSources(s.sources);
    renderDocuments(s.documents);
    renderReasoning(s.reasoning);
    renderCouncil(await api('/api/council').catch(() => null));
    renderWorkshop(await api('/api/workshop').catch(() => null));
    if (els.session) els.session.textContent = s.session && s.session.id ? 'session ' + String(s.session.id).slice(0, 8) : 'no session yet';
    if (s.session && s.session.unavailable) showBanner(s.session.unavailable);

    // Dynamic badges from real state.
    if (els.mode) els.mode.textContent = state.view === 'deck' ? 'Deck' : 'Workspace: ' + state.view;
    if (els.autonomy) {
      const cfg = s.autonomy && s.autonomy.configured ? s.autonomy.configured : {};
      const entries = Object.entries(cfg);
      els.autonomy.textContent = entries.length ? 'Autonomy: ' + entries.map(([d,l]) => d + '=' + l).join(', ') : 'Autonomy: default (L2)';
    }
    // Resource gauges.
    const r = s.resources || {};
    if (els.gaugeCpu) els.gaugeCpu.textContent = 'CPU: ' + (r.cpu && r.cpu.logicalCount != null ? r.cpu.logicalCount + ' cores' : 'n/a');
    if (els.gaugeMem) {
      const mem = r.memory || {};
      els.gaugeMem.textContent = 'Mem: ' + (mem.available ? Math.round((mem.freeBytes||0)/1048576) + '/' + Math.round((mem.totalBytes||0)/1048576) + ' MB' : 'n/a');
    }
    if (els.gaugeStorage) {
      const st = Array.isArray(r.storage) && r.storage.length ? r.storage[0] : null;
      els.gaugeStorage.textContent = 'Storage: ' + (st && st.reported ? Math.round((st.availableBytes||0)/1048576) + '/' + Math.round((st.totalBytes||0)/1048576) + ' MB' : 'n/a');
    }

    const [memory, knowledge, world] = await Promise.all([
      api('/api/memory').catch(() => ({ records: [] })),
      api('/api/knowledge').catch(() => ({ claims: [] })),
      api('/api/world').catch(() => ({ entities: [] })),
    ]);
    renderMemory(memory.records);
    renderKnowledge(knowledge.claims);
    renderWorld(world);

    const ks = s.killSwitch || {};
    const coreState = ks.policyUnavailable ? 'degraded'
      : ks.active === true ? 'lockdown'
      : (s.session && s.session.unavailable) ? 'degraded'
      : (Array.isArray(s.tasks) && s.tasks.some((t) => t.approval)) ? 'awaiting'
      : (Array.isArray(s.tasks) && s.tasks.some((t) => t.status === 'running')) ? 'executing'
      : 'idle';
    setCore(coreState, coreState === 'idle' ? 'Standing by.' : 'State derived from verified records.');
    if (els.connectivity) els.connectivity.textContent = 'Connected';
  } catch (error) {
    showBanner(error.message);
    setCore('degraded', 'State unavailable.');
  }
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
  const lines = [
    'APEX command deck initializing...',
    'Verifying loopback boundary...',
    'Loading controller state...',
    'No inference activated.',
  ];
  if (els.bootLines) {
    for (const line of lines) {
      els.bootLines.append(el('div', null, line));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
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
    setCore('thinking', 'Request in progress.');
    showBanner('');
    els.send.disabled = true;
    if (els.activity) els.activity.textContent = 'working…';
    try {
      await api('/api/chat', { method: 'POST', body: { text } });
      els.text.value = '';
      await refresh();
    } catch (error) {
      showBanner(error.message);
      setCore('degraded', 'Request failed.');
    } finally {
      els.send.disabled = false;
      if (els.activity) els.activity.textContent = '';
      if (state.core !== 'degraded') setCore('idle', 'Standing by.');
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
      renderDocuments(data);
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
      const result = await api('/api/workshop/compose', {
        method: 'POST',
        body: {
          title: els.workshopTitle.value,
          domain: els.workshopDomain.value,
          components: source.components,
          connections: source.connections ?? [],
          budget: budgetText === '' ? null : Number(budgetText),
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

if (els.bootSkip) {
  els.bootSkip.addEventListener('click', () => {
    if (els.boot) els.boot.classList.add('hidden');
  });
}

setInterval(() => {
  if (els.clock) els.clock.textContent = new Date().toLocaleString();
}, 1000);

const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
state.reducedMotion = !!(reduce && reduce.matches);
document.body.dataset.motion = state.reducedMotion ? 'reduced' : 'full';

let eventSource = null;
let watchdog = null;
let degraded = false;
function armWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    degraded = true;
    if (els.connectivity) els.connectivity.textContent = 'Degraded';
    setCore('degraded', 'Event stream lost.');
  }, 1500);
}
function connectEvents() {
  if (typeof EventSource !== 'function') return;
  try { if (eventSource) eventSource.close(); } catch (e) {}
  eventSource = new EventSource('/api/events');
  eventSource.onopen = () => { degraded = false; if (els.connectivity) els.connectivity.textContent = 'Connected'; armWatchdog(); };
  const reset = () => { degraded = false; if (els.connectivity) els.connectivity.textContent = 'Connected'; armWatchdog(); if (!degraded) refresh().catch(() => {}); };
  eventSource.addEventListener('hello', reset);
  eventSource.addEventListener('heartbeat', reset);
  eventSource.addEventListener('state-changed', (e) => {
    try {
      const data = JSON.parse(e.data);
      // detect seq gaps? store last seq
      if (state.lastSeq && data.seq && data.seq !== state.lastSeq + 1) {
        // gap or duplicate; reconcile
      }
      state.lastSeq = data.seq || state.lastSeq;
    } catch {}
    reset();
  });
  eventSource.addEventListener('progress', (e) => {
    try { const data = JSON.parse(e.data); if (els.activity) els.activity.textContent = data.stage === 'model' ? 'waiting for the model…' : 'working: ' + data.stage; } catch { if (els.activity) els.activity.textContent = 'working…'; }
    armWatchdog();
  });
  eventSource.addEventListener('chat', () => { if (!degraded) refresh().catch(() => {}); armWatchdog(); });
  eventSource.onerror = () => {
    if (els.connectivity) els.connectivity.textContent = 'Degraded';
    setCore('degraded', 'Event stream error.');
  };
  armWatchdog();
}

boot().then(() => {
  setView('deck');
  refresh();
  connectEvents();
  setInterval(refresh, 15000);
});
`;
