// T-30 P0 (2026-11-19): a deliberately small browser stand-in for executing the served
// client (src/ui/assets.js UI_CLIENT) under `node:vm` without a browser.
//
// It is not a DOM implementation and it is not a claim of browser fidelity. It exists so
// the suite can prove three things the real browser proved the hard way: the assembled
// script parses and runs without a ReferenceError, the Core reaches Idle on a healthy
// stream, and the watchdog degrades it inside the two-second acceptance window.
//
// Time is virtual: setTimeout/setInterval are scheduled on a clock the test advances, so
// a 1.5 s watchdog assertion runs in milliseconds and is deterministic.

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

function createClassList(element) {
  const values = new Set();
  return {
    add: (...names) => { for (const name of names) values.add(name); },
    remove: (...names) => { for (const name of names) values.delete(name); },
    toggle: (name, force) => {
      const next = force === undefined ? !values.has(name) : Boolean(force);
      if (next) values.add(name); else values.delete(name);
      return next;
    },
    contains: (name) => values.has(name),
    replace: (from, to) => { values.delete(from); values.add(to); },
    get value() { return [...values].join(' '); },
    toString: () => [...values].join(' '),
  };
}

function createElement(tagName, ownerDocument) {
  const node = {
    ownerDocument,
    tagName: String(tagName || 'div').toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    title: '',
    type: '',
    name: '',
    placeholder: '',
    scrollTop: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    children: [],
    parentNode: null,
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    classList: createClassList(),
    attributes: {},
    addEventListener(type, handler) { (this.__listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const handler of [...(this.__listeners[event.type] || [])]) handler(event);
      return true;
    },
    append(...nodes) { for (const child of nodes.flat()) if (child !== null && child !== undefined) this.appendChild(child); },
    appendChild(child) {
      if (child && typeof child === 'object') {
        child.parentNode = this;
        this.children.push(child);
      }
      return child;
    },
    prepend(child) { this.children.unshift(child); },
    insertBefore(child) { this.children.unshift(child); return child; },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); return child; },
    remove() { this.parentNode?.removeChild?.(this); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    focus() {},
    blur() {},
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); },
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    __listeners: {},
  };
  if (VOID_TAGS.has(String(tagName || '').toLowerCase())) node.children = [];
  return node;
}

export function createVirtualClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();

  const schedule = (callback, delay, every) => {
    const id = ++sequence;
    const wait = Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 0;
    timers.set(id, { at: now + wait, callback, every: every ? Math.max(1, wait) : null });
    return id;
  };

  return {
    now: () => now,
    pending: () => timers.size,
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: (id) => { timers.delete(id); },
    clearInterval: (id) => { timers.delete(id); },
    // Runs every timer due within `ms`, in schedule order, advancing `now` to each firing.
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (!due || timer.at < due.timer.at || (timer.at === due.timer.at && id < due.id)) due = { id, timer };
        }
        if (!due) break;
        now = due.timer.at;
        if (due.timer.every) due.timer.at = now + due.timer.every;
        else timers.delete(due.id);
        due.timer.callback();
      }
      now = target;
      return now;
    },
  };
}

// Canned reads. Shapes mirror what the server returns for each route, at the smallest
// size that exercises the client's rendering paths.
function defaultRoutes() {
  const state = {
    session: { id: 'session-test-0001', status: 'ok' },
    turns: [],
    tasks: [],
    plans: [],
    goals: [],
    docs: [],
    events: [],
    autonomy: { configured: { chat: 'L1' } },
    runtime: { status: 'stopped', lifecycle: 'stopped', paused: false },
    resources: { cpu: { logicalCount: 4 }, memory: { available: false }, storage: [] },
  };
  const health = {
    overall: 'healthy',
    areas: [],
    unhealthyAreaCount: 0,
    attentionCount: 0,
    errorCount: 0,
    coreAttentionCounts: { approval: 0, uncertain: 0, other: 0 },
  };
  return new Map([
    ['/api/state', state],
    ['/api/health', health],
    ['/api/killswitch', { active: false, policyUnavailable: false, persistence: 'durable' }],
    ['/api/mission-control', { available: true, goals: [], plans: [], counts: { goals: 0, plans: 0 } }],
    ['/api/approvals', { available: true, taskSteps: [], draftPlans: [], taskStepCount: 0, draftPlanCount: 0, truncatedTaskSteps: false, truncatedDraftPlans: false }],
    ['/api/timeline', { available: true, entries: [], total: 0 }],
    ['/api/situation', { available: true, counts: { events: 0, assessments: 0, decisions: 0, responses: 0, alerts: 0, pendingApprovals: 0, recommendations: 0, suppressed: 0 }, items: [], approvals: [] }],
    ['/api/briefing', { available: true, facts: [], sections: [] }],
    ['/api/runtime', { available: true, lifecycle: 'stopped', paused: false }],
    ['/api/sources', { available: true, sources: [] }],
    ['/api/documents', { available: true, documents: [], documentsTotal: 0 }],
    ['/api/reasoning', { available: true, items: [] }],
    ['/api/council', { available: true, sessions: [] }],
    ['/api/workshop', { available: true, artifacts: [] }],
    ['/api/resources', { cpu: { logicalCount: 4, available: true }, memory: { available: false, reported: false, reason: 'NO_MEMORY_PROVIDER' }, gpu: { available: false, reported: false, reason: 'NO_GPU_METADATA_PROVIDER' }, network: { available: null, reported: false, reason: 'NO_NETWORK_TELEMETRY_PROVIDER' }, storage: [], reservations: 0 }],
  ]);
}

export function createFakeBrowser({ routes = defaultRoutes(), fetchStatus = 200, realTimers = false, fetchImpl = null, EventSourceClass = null } = {}) {
  const clock = createVirtualClock();
  const events = { consoleErrors: [], pageErrors: [], fetches: [], sources: [] };
  const elements = new Map();

  const document = {
    body: createElement('body'),
    documentElement: createElement('html'),
    activeElement: null,
    createElement: (tag) => createElement(tag, document),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById(id) {
      if (!elements.has(id)) {
        const node = createElement('div', document);
        node.id = id;
        elements.set(id, node);
      }
      return elements.get(id);
    },
    querySelector() { return createElement('div', document); },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { (this.__listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    __listeners: {},
  };

  const matchMedia = (query) => ({
    media: query,
    // Reduced motion stays off so every rendering path (not just the reduced one) runs.
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.onopen = null;
      this.onerror = null;
      this.closed = false;
      events.sources.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    removeEventListener() {}
    close() { this.closed = true; this.readyState = 2; }
    open() {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
    }
    fail() {
      if (typeof this.onerror === 'function') this.onerror({ type: 'error' });
    }
    emit(type, data, { lastEventId = '' } = {}) {
      const event = {
        type,
        data: typeof data === 'string' ? data : JSON.stringify(data),
        lastEventId,
        origin: 'http://127.0.0.1:0',
      };
      for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
      if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(event);
    }
  }

  // Real timers are unref'd: the client legitimately keeps a 15 s refresh interval and a
  // boot sequence, and neither should hold the test process open after the assertions run.
  const unref = (handle) => {
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
  const timers = realTimers
    ? {
      setTimeout: (callback, delay, ...rest) => unref(globalThis.setTimeout(callback, delay, ...rest)),
      clearTimeout: globalThis.clearTimeout,
      setInterval: (callback, delay, ...rest) => unref(globalThis.setInterval(callback, delay, ...rest)),
      clearInterval: globalThis.clearInterval,
      now: () => Date.now(),
      advance() { throw new Error('real timers cannot be advanced'); },
    }
    : clock;

  const httpFetch = fetchImpl || (async (url, options = {}) => {
    events.fetches.push({ url, method: options.method ?? 'GET' });
    const path = String(url).split('?')[0];
    if (fetchStatus !== 200) {
      return {
        ok: false,
        status: fetchStatus,
        async json() { return { error: 'unavailable in the harness' }; },
      };
    }
    const body = routes.get(path);
    if (body === undefined) {
      return { ok: false, status: 404, async json() { return { error: `no harness route for ${path}` }; } };
    }
    return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(body)); } };
  });

  const windowObject = {
    document,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    matchMedia,
    location: { href: 'http://127.0.0.1:0/', origin: 'http://127.0.0.1:0', search: '', hash: '' },
    navigator: { userAgent: 'apex-harness' },
    addEventListener(type, handler) { (this.__listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    __listeners: {},
  };

  const sandbox = {
    document,
    window: windowObject,
    self: windowObject,
    globalThis: undefined,
    console: {
      log() {},
      info() {},
      warn() {},
      error(...args) { events.consoleErrors.push(args.map(String).join(' ')); },
      debug() {},
    },
    EventSource: EventSourceClass || FakeEventSource,
    fetch: httpFetch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    queueMicrotask,
    Promise,
    Date,
    Math,
    JSON,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone: typeof structuredClone === 'function' ? structuredClone : (value) => JSON.parse(JSON.stringify(value)),
    eventSourceInstances: events.sources,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = windowObject;
  sandbox.window.globalThis = sandbox;

  return {
    sandbox,
    document,
    clock: timers,
    virtualClock: clock,
    events,
    window: windowObject,
    getElement: (id) => document.getElementById(id),
    coreState: () => document.body.dataset.coreState ?? null,
    connectivityText: () => document.getElementById('connectivity').textContent,
  };
}

// Lets pending promise chains (fetch stubs, render calls) settle before the next step.
export async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
