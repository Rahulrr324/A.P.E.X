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
<body>
<header class="top">
  <div>
    <h1>APEX</h1>
    <p class="sub">Local Alpha &middot; loopback only &middot; deterministic actions and the CLI's own gates</p>
  </div>
  <div class="row">
    <span id="session" class="meta"></span>
    <button id="new-session" type="button" class="quiet">New session</button>
  </div>
</header>
<main>
  <section class="panel chat">
    <h2>Conversation</h2>
    <div id="banner" class="banner" role="alert" hidden></div>
    <ol id="turns" class="turns"></ol>
    <form id="chat-form">
      <label for="chat-text" class="visually-hidden">Message</label>
      <textarea id="chat-text" rows="3" maxlength="4000" placeholder="Ask APEX, or give it a task"></textarea>
      <div class="row">
        <button id="send" type="submit">Send</button>
        <span id="activity" class="meta" role="status"></span>
      </div>
    </form>
  </section>
  <section class="panel">
    <h2>Tasks</h2>
    <p class="meta">Approval here is the same user-origin decision the CLI records; nothing runs by itself.</p>
    <ul id="tasks" class="work"></ul>
  </section>
  <section class="panel">
    <h2>Plans</h2>
    <p class="meta">Approving a plan records its hash-bound approval. Execution stays a separate command.</p>
    <ul id="plans" class="work"></ul>
  </section>
  <section class="panel">
    <h2>Executive runtime</h2>
    <p class="meta">Opt-in local process. Starting, stopping and approving remain explicit acts; this view only reports what the runtime has persisted.</p>
    <ul id="runtime" class="work"></ul>
  </section>
  <section class="panel">
    <h2>External sources</h2>
    <p class="meta">Permissioned, metadata-first providers. Enabling, configuring and polling are CLI acts; this view only reports persisted state.</p>
    <ul id="sources" class="work"></ul>
  </section>
  <section class="panel">
    <h2>Authorized documents</h2>
    <p class="meta">Content reading is a separate opt-in permission. This view reports versions and deterministic excerpts; it never uploads content.</p>
    <form id="doc-search-form" class="row">
      <label for="doc-search" class="visually-hidden">Search documents</label>
      <input id="doc-search" type="search" maxlength="500" placeholder="Search exact terms">
      <button id="doc-search-button" type="submit" class="small">Search</button>
    </form>
    <ul id="documents" class="work"></ul>
  </section>
  <section class="panel">
    <h2>Situational awareness</h2>
    <p class="meta">Recorded observations, alerts and pending decisions. Decisions and execution are made with the CLI; this view only reads.</p>
    <ul id="situation" class="work"></ul>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root { color-scheme: light dark; --bg: #10151a; --panel: #17202a; --line: #2a3744; --text: #e6edf3; --muted: #94a3b8; --accent: #4fb3a9; --warn: #e0b64a; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
.top { display: flex; justify-content: space-between; gap: 1rem; align-items: end; padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; letter-spacing: .04em; }
h2 { margin: 0 0 .5rem; font-size: 1rem; }
.sub, .meta { color: var(--muted); margin: 0; font-size: .85rem; }
main { display: grid; gap: 1rem; padding: 1rem 1.25rem 2rem; grid-template-columns: minmax(0, 2fr) minmax(18rem, 1fr); align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; min-width: 0; }
.chat { grid-row: span 2; }
.turns { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: .75rem; max-height: 55vh; overflow-y: auto; }
.turn { border-left: 3px solid var(--line); padding: .25rem 0 .25rem .7rem; }
.turn.user { border-left-color: var(--accent); }
.turn.apex { border-left-color: var(--warn); }
.turn .who { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.turn pre { white-space: pre-wrap; word-break: break-word; margin: .2rem 0 0; font: inherit; }
input[type=search] { flex: 1; min-width: 8rem; background: #0d1319; color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: .4rem .55rem; font: inherit; }
textarea { width: 100%; resize: vertical; background: #0d1319; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: .6rem; font: inherit; }
button { background: var(--accent); color: #06221f; border: 0; border-radius: 7px; padding: .45rem .8rem; font: inherit; font-weight: 600; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.quiet { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; }
button.small { padding: .2rem .5rem; font-size: .8rem; }
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.banner { border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: .5rem .7rem; margin-bottom: .75rem; }
.work { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
.item { border: 1px solid var(--line); border-radius: 8px; padding: .55rem .65rem; }
.item .title { font-weight: 600; word-break: break-word; }
.item ol { margin: .35rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: .85rem; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 .45rem; font-size: .75rem; color: var(--muted); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } .chat { grid-row: auto; } }
`;

export const UI_CLIENT = `'use strict';
const els = {
  turns: document.getElementById('turns'),
  form: document.getElementById('chat-form'),
  text: document.getElementById('chat-text'),
  send: document.getElementById('send'),
  activity: document.getElementById('activity'),
  session: document.getElementById('session'),
  newSession: document.getElementById('new-session'),
  tasks: document.getElementById('tasks'),
  plans: document.getElementById('plans'),
  situation: document.getElementById('situation'),
  runtime: document.getElementById('runtime'),
  sources: document.getElementById('sources'),
  documents: document.getElementById('documents'),
  docSearch: document.getElementById('doc-search-form'),
  docSearchText: document.getElementById('doc-search'),
  banner: document.getElementById('banner'),
};

function showBanner(text) {
  els.banner.textContent = text;
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
  return data;
}

function renderTurns(turns) {
  els.turns.replaceChildren();
  if (!Array.isArray(turns) || turns.length === 0) {
    els.turns.append(el('li', 'meta', 'No turns in this session yet.'));
    return;
  }
  for (const turn of turns) {
    const cls = turn.role === 'user' ? 'turn user' : 'turn apex';
    const item = el('li', cls);
    const who = turn.role === 'user' ? 'You' : 'APEX';
    const verified = turn.role === 'user' ? '' : (turn.verified ? ' \\u00b7 verified' : ' \\u00b7 unverified');
    item.append(el('div', 'who', who + verified));
    item.append(el('pre', null, turn.text));
    els.turns.append(item);
  }
  els.turns.scrollTop = els.turns.scrollHeight;
}

function actionButton(label, path, body) {
  const button = el('button', 'small quiet', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(path, { method: 'POST', body: body ?? {} });
      showBanner(result && result.display ? result.display : label + ' recorded.');
      await refresh();
    } catch (error) {
      showBanner(error.message);
      button.disabled = false;
    }
  });
  return button;
}

function renderTasks(tasks) {
  els.tasks.replaceChildren();
  if (!Array.isArray(tasks) || tasks.length === 0) {
    els.tasks.append(el('li', 'meta', 'No tasks recorded.'));
    return;
  }
  for (const task of tasks) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', task.goal));
    head.append(el('span', 'badge', task.status));
    if (task.status === 'proposed') head.append(actionButton('Approve', '/api/tasks/' + encodeURIComponent(task.id) + '/approve'));
    if (task.status === 'failed' || task.status === 'paused') {
      for (const step of task.steps) {
        if (step.status === 'failed' || step.status === 'uncertain' || (task.status === 'paused' && step.status === 'pending' && step.approval)) {
          const label = step.status === 'pending' ? 'Approve step' : 'Retry step';
          const path = '/api/tasks/' + encodeURIComponent(task.id) + (step.status === 'pending' ? '/approve' : '/retry');
          head.append(actionButton(label + ' ' + step.id, path, { stepId: step.id }));
        }
      }
    }
    if (!['completed', 'cancelled'].includes(task.status)) head.append(actionButton('Cancel', '/api/tasks/' + encodeURIComponent(task.id) + '/cancel'));
    item.append(head);
    item.append(el('div', 'meta', task.id));
    const steps = el('ol');
    for (const step of task.steps) {
      steps.append(el('li', null, step.id + ' \\u00b7 ' + step.action + ' \\u00b7 ' + step.status));
    }
    item.append(steps);
    els.tasks.append(item);
  }
}

function renderPlans(plans) {
  els.plans.replaceChildren();
  if (!Array.isArray(plans) || plans.length === 0) {
    els.plans.append(el('li', 'meta', 'No plans recorded.'));
    return;
  }
  for (const plan of plans) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', plan.outcome));
    head.append(el('span', 'badge', plan.status));
    if (plan.status === 'draft') head.append(actionButton('Approve', '/api/plans/' + encodeURIComponent(plan.id) + '/approve'));
    item.append(head);
    item.append(el('div', 'meta', plan.id + ' \\u00b7 v' + plan.version));
    const steps = el('ol');
    for (const step of plan.steps) steps.append(el('li', null, step.id + ' \\u00b7 ' + step.action + (step.status ? ' \\u00b7 ' + step.status : '')));
    item.append(steps);
    els.plans.append(item);
  }
}

function renderSituation(state) {
  els.situation.replaceChildren();
  if (!state) {
    els.situation.append(el('li', 'meta', 'Situational awareness is not configured.'));
    return;
  }
  if (state.unavailable) {
    els.situation.append(el('li', 'meta', state.unavailable));
    return;
  }
  const counts = state.counts || {};
  els.situation.append(el('li', 'meta', (counts.events || 0) + ' event(s) \\u00b7 ' + (counts.alerts || 0) + ' alert(s) \\u00b7 ' + (counts.pendingApprovals || 0) + ' pending approval(s)'));
  for (const alert of (state.alerts || [])) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', alert.summary));
    head.append(el('span', 'badge', alert.level));
    item.append(head);
    item.append(el('div', 'meta', String(alert.eventId).slice(0, 8)));
    els.situation.append(item);
  }
  for (const pending of (state.pendingApprovals || [])) {
    const item = el('li', 'item');
    item.append(el('div', 'title', 'Approval pending: ' + (pending.action || 'response')));
    item.append(el('div', 'meta', String(pending.decisionId).slice(0, 8) + ' \\u00b7 ' + (pending.reason || '')));
    els.situation.append(item);
  }
  for (const row of (state.recent || []).slice(0, 3)) {
    els.situation.append(el('li', 'meta', row.type + ' \\u00b7 ' + (row.significance ? row.significance.level : 'unassessed') + (row.decision ? ' \\u00b7 ' + row.decision.response : '')));
  }
  if ((state.recent || []).length === 0) els.situation.append(el('li', 'meta', 'No events recorded.'));
}

function renderRuntime(runtime) {
  els.runtime.replaceChildren();
  if (!runtime) {
    els.runtime.append(el('li', 'meta', 'The executive runtime is not configured.'));
    return;
  }
  if (runtime.unavailable) {
    els.runtime.append(el('li', 'meta', runtime.unavailable));
    return;
  }
  const head = el('li', 'item');
  const row = el('div', 'row');
  row.append(el('span', 'title', 'Runtime ' + String(runtime.runtimeId).slice(0, 8)));
  row.append(el('span', 'badge', runtime.lifecycle + (runtime.paused ? ' \\u00b7 paused' : '')));
  head.append(row);
  head.append(el('div', 'meta', 'boot ' + runtime.boots + ' \\u00b7 ' + runtime.ticks + ' tick(s) \\u00b7 last ' + (runtime.lastTickAt || 'never')));
  head.append(el('div', 'meta', (runtime.notifications ? runtime.notifications.active : 0) + ' active notice(s) \\u00b7 backlog ' + (runtime.backlog === null ? 'unavailable' : runtime.backlog) + ' \\u00b7 ' + runtime.activePlans.length + ' active plan(s)'));
  els.runtime.append(head);
  for (const plan of runtime.activePlans.slice(0, 3)) {
    const item = el('li', 'item');
    item.append(el('div', 'title', String(plan.id).slice(0, 8) + ' \\u00b7 ' + plan.status));
    item.append(el('div', 'meta', plan.outcome || ''));
    els.runtime.append(item);
  }
  for (const task of runtime.interrupted.slice(0, 3)) {
    els.runtime.append(el('li', 'meta', 'Interrupted task ' + String(task.id).slice(0, 8) + ' (' + task.status + '); not re-run automatically.'));
  }
  for (const notice of (runtime.notifications.recent || [])) {
    els.runtime.append(el('li', 'meta', notice.level + ' \\u00b7 ' + notice.reason));
  }
  if (runtime.lastError) els.runtime.append(el('li', 'meta', 'Last error: ' + runtime.lastError));
  if (runtime.deadLetters.length > 0) els.runtime.append(el('li', 'meta', runtime.deadLetters.length + ' dead letter(s) recorded.'));
}

function renderSources(sources) {
  els.sources.replaceChildren();
  if (!sources) {
    els.sources.append(el('li', 'meta', 'External sources are not configured.'));
    return;
  }
  if (sources.unavailable) {
    els.sources.append(el('li', 'meta', sources.unavailable));
    return;
  }
  els.sources.append(el('li', 'meta', (sources.enabled || 0) + ' of ' + sources.providers.length + ' provider(s) enabled' + (sources.paused ? ' \\u00b7 observation paused' : '') + ' \\u00b7 ' + sources.totals.accepted + ' accepted, ' + sources.totals.duplicates + ' duplicate, ' + sources.totals.rejected + ' refused'));
  for (const provider of sources.providers) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', provider.name));
    head.append(el('span', 'badge', provider.id + ' \\u00b7 ' + (provider.enabled ? 'enabled' : 'disabled')));
    item.append(head);
    item.append(el('div', 'meta', 'last success ' + (provider.health.lastSuccessAt || 'never') + ' \\u00b7 next ' + (provider.nextPollAt || 'not scheduled') + ' \\u00b7 checkpoint keys ' + provider.checkpoint.keys));
    item.append(el('div', 'meta', provider.permissions.join(', ')));
    if (provider.health.lastError) item.append(el('div', 'meta', 'error: ' + provider.health.lastError));
    els.sources.append(item);
  }
}

function renderDocuments(docs) {
  els.documents.replaceChildren();
  if (!docs) { els.documents.append(el('li', 'meta', 'Documents are not configured.')); return; }
  if (docs.unavailable) { els.documents.append(el('li', 'meta', docs.unavailable)); return; }
  els.documents.append(el('li', 'meta', (docs.indexed || 0) + ' indexed, ' + (docs.failed || 0) + ' failed, ' + (docs.deleted || 0) + ' deleted; permission ' + docs.permission));
  for (const doc of (docs.documents || []).slice(0, 8)) {
    const item = el('li', 'item');
    const head = el('div', 'row');
    head.append(el('span', 'title', doc.path));
    head.append(el('span', 'badge', 'v' + doc.version + ' · ' + doc.status));
    item.append(head);
    item.append(el('div', 'meta', doc.documentId + ' · ' + doc.format + ' · ' + doc.bytes + ' bytes'));
    if (doc.warnings && doc.warnings.length) item.append(el('div', 'meta', 'warnings: ' + doc.warnings.join('; ')));
    if (doc.limitations && doc.limitations.length) item.append(el('div', 'meta', 'limitation: ' + doc.limitations[0]));
    els.documents.append(item);
  }
  if (docs.searchError) els.documents.append(el('li', 'meta', docs.searchError));
  for (const result of docs.results || []) {
    const item = el('li', 'item');
    item.append(el('div', 'title', result.path + ' · v' + result.version + (result.section ? ' · ' + result.section.label : '')));
    item.append(el('div', 'meta', result.reasons.join('; ')));
    item.append(el('div', 'meta', result.excerpt.text));
    els.documents.append(item);
  }
}

async function refresh() {
  const state = await api('/api/state');
  renderTurns(state.turns);
  renderTasks(state.tasks);
  renderPlans(state.plans);
  renderRuntime(state.runtime);
  renderSources(state.sources);
  renderDocuments(state.documents);
  renderSituation(state.situation);
  els.session.textContent = state.session && state.session.id ? 'session ' + String(state.session.id).slice(0, 8) : 'no session yet';
  if (state.session && state.session.unavailable) showBanner(state.session.unavailable);
}

let busy = false;
els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const text = els.text.value;
  if (text.trim().length === 0) return;
  busy = true;
  els.send.disabled = true;
  els.activity.textContent = 'working\\u2026';
  showBanner('');
  try {
    await api('/api/chat', { method: 'POST', body: { text } });
    els.text.value = '';
    await refresh();
  } catch (error) {
    showBanner(error.message);
  } finally {
    busy = false;
    els.send.disabled = false;
    els.activity.textContent = '';
  }
});

els.newSession.addEventListener('click', async () => {
  els.newSession.disabled = true;
  try {
    await api('/api/session/new', { method: 'POST', body: {} });
    await refresh();
    showBanner('Started a new session. Earlier turns stay in the conversation log.');
  } catch (error) {
    showBanner(error.message);
  } finally {
    els.newSession.disabled = false;
  }
});

function connectEvents() {
  if (typeof EventSource !== 'function') return;
  const source = new EventSource('/api/events');
  source.addEventListener('progress', (event) => {
    try {
      const data = JSON.parse(event.data);
      els.activity.textContent = data.stage === 'model' ? 'waiting for the model\\u2026' : 'working: ' + data.stage;
    } catch { els.activity.textContent = 'working\\u2026'; }
  });
  source.addEventListener('chat', () => { if (!busy) refresh().catch(() => {}); });
  source.addEventListener('error', () => { els.activity.textContent = ''; });
}

els.docSearch.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = els.docSearchText.value.trim();
  if (!query) return;
  try {
    const result = await api('/api/documents?q=' + encodeURIComponent(query));
    renderDocuments(result);
  } catch (error) {
    showBanner(error.message);
  }
});

refresh().then(connectEvents).catch((error) => showBanner(error.message));
`;
