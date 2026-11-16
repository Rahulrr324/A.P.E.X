// The loopback-only browser interface. It is a thin, bounded transport over the same
// controller the CLI uses: every turn goes through controller.handle(), every approval
// through the existing user-origin controller method, and the UI adds no action, no
// store, and no authorization rule of its own. One request is in flight at a time,
// because session turns are ordered and the conversation log is the continuity record.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { UI_CLIENT, UI_CSS, UI_PAGE } from './assets.js';

export const UI_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxMessageChars: 4000,
  maxTurns: 60,
  maxWorkItems: 50,
  maxSubscribers: 8,
  maxBufferedBytes: 1024 * 1024,
  chatTimeoutMs: 120000,
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function cookiesOf(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0 && name.length <= 32) out[name] = value;
  }
  return out;
}

function baseHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra }));
  res.end(text);
}

function sendAsset(res, type, text) {
  res.writeHead(200, baseHeaders({ 'content-type': type, 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('the request body is too large');
        error.status = 413;
        // The unread remainder cannot be parsed as another request, so the connection is
        // closed after the refusal is written rather than reused.
        error.closeConnection = true;
        // Stop consuming without destroying the socket, so the refusal can still be written.
        fail(error);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = new Error('the request body is not valid JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', (error) => fail(error));
  });
}

function singleLine(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function projectTask(task) {
  return {
    id: String(task.id),
    goal: singleLine(task.goal, 300),
    origin: task.origin ?? null,
    status: task.status,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    steps: (Array.isArray(task.steps) ? task.steps : []).slice(0, 8).map((step) => ({
      id: step.id,
      action: singleLine(step.action, 60),
      permission: step.permission ?? null,
      status: step.status,
      outcome: step.outcome ?? null,
      approval: step.approval ? true : false,
    })),
  };
}

function projectPlan(plan) {
  return {
    id: String(plan.id),
    goalId: plan.goalId ?? null,
    outcome: singleLine(plan.outcome, 300),
    status: plan.status,
    version: Number.isInteger(plan.version) ? plan.version : null,
    approved: plan.approval ? true : false,
    activated: plan.activation ? true : false,
    steps: (Array.isArray(plan.steps) ? plan.steps : []).slice(0, 8).map((step) => ({
      id: step.id,
      action: singleLine(step.action, 60),
      status: step.status ?? null,
    })),
  };
}

export function createUiServer({
  app,
  token,
  host = '127.0.0.1',
  port = 0,
  heartbeatMs = 15000,
  chatTimeoutMs = UI_LIMITS.chatTimeoutMs,
  now = () => new Date(),
} = {}) {
  if (!app || typeof app.controller?.handle !== 'function' || typeof app.controller?.approveTask !== 'function') {
    throw new Error('createUiServer requires an APEX application');
  }
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('the UI binds to loopback only');
  const authToken = token ?? randomBytes(24).toString('hex');
  if (!TOKEN_RE.test(authToken)) throw new Error('the UI token must be 16-128 letters, digits, dash or underscore');

  const subscribers = new Set();
  let chatInFlight = false;
  let listeningPort = null;

  function presented(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = cookiesOf(req.headers.cookie).apex_ui;
    if (typeof cookie === 'string' && cookie.length > 0) return cookie;
    if (url.pathname === '/api/events' && url.searchParams.has('token')) return url.searchParams.get('token');
    return null;
  }

  function authorized(req, url) {
    return tokensMatch(presented(req, url), authToken);
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const sub of subscribers) {
      if (sub.res.writableEnded || sub.res.destroyed) {
        unsubscribe(sub);
        continue;
      }
      // A slow reader loses progress frames rather than growing an unbounded queue.
      if (sub.res.writableLength > UI_LIMITS.maxBufferedBytes) continue;
      try {
        sub.res.write(frame);
      } catch {
        unsubscribe(sub);
      }
    }
  }

  function unsubscribe(sub) {
    if (sub.timer) clearInterval(sub.timer);
    subscribers.delete(sub);
  }

  function subscribe(res) {
    if (subscribers.size >= UI_LIMITS.maxSubscribers) return false;
    res.writeHead(200, baseHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    }));
    res.write('retry: 5000\n\n');
    const sub = { res, timer: null };
    sub.timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return unsubscribe(sub);
      try {
        res.write(': ping\n\n');
      } catch {
        unsubscribe(sub);
      }
    }, heartbeatMs);
    if (typeof sub.timer.unref === 'function') sub.timer.unref();
    subscribers.add(sub);
    res.on('close', () => unsubscribe(sub));
    broadcastTo(sub, 'hello', { at: now().toISOString() });
    return true;
  }

  function broadcastTo(sub, event, data) {
    try {
      sub.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      unsubscribe(sub);
    }
  }

  async function snapshot() {
    let session = { id: null, status: 'missing', unavailable: null };
    let turns = [];
    const inspected = typeof app.session?.peek === 'function' ? await app.session.peek() : null;
    if (inspected && inspected.status === 'ok') {
      session = { id: inspected.state.sessionId, status: 'ok', unavailable: null };
      try {
        // The transcript, not the replay window: the page must show the answer the user received,
        // including turns the model path never replays (a deterministic reading is stored as a notice).
        const rows = await app.conversation.transcript(inspected.state.sessionId, UI_LIMITS.maxTurns);
        turns = rows.map((row) => ({
          role: row.role === 'user' ? 'user' : 'apex',
          origin: row.origin ?? null,
          text: singleLine(row.text, 8000),
          verified: row.verified === true,
          at: row.createdAt ?? null,
          taskId: row.taskId ?? null,
        }));
      } catch (err) {
        session.unavailable = `conversation history is unavailable: ${err.message}`;
      }
    } else if (inspected && (inspected.status === 'corrupt' || inspected.status === 'unavailable')) {
      session = { id: null, status: inspected.status, unavailable: `session state is ${inspected.status}: ${inspected.detail}` };
    }

    let tasks = [];
    try {
      const all = await app.taskStore.list();
      tasks = all.slice(0, UI_LIMITS.maxWorkItems).map(projectTask);
    } catch (err) {
      tasks = [];
      session.unavailable = session.unavailable ?? `task records are unavailable: ${err.message}`;
    }
    let plans = [];
    try {
      const all = await app.plans.list();
      plans = all.slice(0, UI_LIMITS.maxWorkItems).map(projectPlan);
    } catch (err) {
      plans = [];
      session.unavailable = session.unavailable ?? `plan records are unavailable: ${err.message}`;
    }

    // T-09: the same service the CLI reads. A damaged or unavailable situational log is reported
    // as unavailable-with-detail, never as an empty environment.
    let situation = null;
    try {
      situation = app.situation && typeof app.situation.state === 'function'
        ? await app.situation.state({ limit: 5 })
        : null;
    } catch (err) {
      situation = { unavailable: `situational state is unavailable: ${err.message}` };
    }

    // T-10: the runtime reports its own persisted state. A stopped runtime is shown as stopped;
    // nothing here starts a timer or a lease.
    let runtime = null;
    try {
      runtime = app.runtime && typeof app.runtime.status === 'function'
        ? await app.runtime.status()
        : { unavailable: 'the executive runtime is not configured' };
    } catch (err) {
      runtime = { unavailable: `runtime state is unavailable: ${err.message}` };
    }

    return {
      at: now().toISOString(),
      session,
      turns,
      tasks,
      plans,
      situation,
      runtime,
      limits: {
        maxMessageChars: UI_LIMITS.maxMessageChars,
        maxTurns: UI_LIMITS.maxTurns,
        maxWorkItems: UI_LIMITS.maxWorkItems,
        oneRequestAtATime: true,
      },
    };
  }

  async function handleChat(req, res) {
    // The slot is claimed before the first await: Node runs a request handler synchronously
    // up to that point, so two chats arriving together cannot both pass this check.
    if (chatInFlight) {
      sendJson(res, 409, { error: 'a request is already running; wait for it to finish' });
      return;
    }
    chatInFlight = true;
    let timer = null;
    try {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'the body must be a JSON object' });
        return;
      }
      const extra = Object.keys(body).filter((key) => key !== 'text');
      if (extra.length > 0) {
        sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
        return;
      }
      if (typeof body.text !== 'string') {
        sendJson(res, 400, { error: 'text is required' });
        return;
      }
      if (body.text.length > UI_LIMITS.maxMessageChars) {
        sendJson(res, 413, { error: `text is longer than ${UI_LIMITS.maxMessageChars} characters` });
        return;
      }
      if (body.text.trim().length === 0) {
        sendJson(res, 400, { error: 'text is empty' });
        return;
      }

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), chatTimeoutMs);
      const result = await app.controller.handle(body.text, {
        origin: 'user',
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress && typeof progress.stage === 'string') broadcast('progress', { stage: singleLine(progress.stage, 40) });
        },
      });
      const payload = {
        status: result.status,
        display: typeof result.display === 'string' ? result.display : '',
        verified: result.status === 'success_verified',
        recorded: result.recorded !== false,
        operation: result.operation ? { id: result.operation.id, capability: result.operation.capability ?? null } : null,
        timedOut: controller.signal.aborted,
      };
      sendJson(res, 200, payload);
      broadcast('chat', { operationId: payload.operation?.id ?? null, status: payload.status });
    } finally {
      if (timer) clearTimeout(timer);
      chatInFlight = false;
    }
  }

  async function handleTaskAction(req, res, kind, taskId) {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 64) {
      sendJson(res, 400, { error: 'a task id is required' });
      return;
    }
    const body = await readJson(req, UI_LIMITS.maxBodyBytes);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'the body must be a JSON object' });
      return;
    }
    const extra = Object.keys(body).filter((key) => key !== 'stepId');
    if (extra.length > 0) {
      sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
      return;
    }
    const stepId = body.stepId === undefined ? null : body.stepId;
    if (stepId !== null && (typeof stepId !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/.test(stepId))) {
      sendJson(res, 400, { error: 'stepId is not a step id' });
      return;
    }
    // A retry is always a retry of one named step, so there is no stepless form to default to.
    if (kind === 'retry' && stepId === null) {
      sendJson(res, 400, { error: 'retry requires a stepId' });
      return;
    }
    if (kind === 'cancel' && stepId !== null) {
      sendJson(res, 400, { error: 'cancel does not take a stepId' });
      return;
    }
    const result = kind === 'approve'
      ? await app.controller.approveTask(taskId, stepId === null ? {} : { stepId })
      : kind === 'retry'
        ? await app.controller.retryTask(taskId, stepId)
        : await app.controller.cancelTask(taskId);
    sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${listeningPort ?? port}`}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, at: now().toISOString() });
      return;
    }
    if (method === 'GET' && url.pathname === '/style.css') {
      sendAsset(res, 'text/css; charset=utf-8', UI_CSS);
      return;
    }
    if (method === 'GET' && url.pathname === '/app.js') {
      sendAsset(res, 'text/javascript; charset=utf-8', UI_CLIENT);
      return;
    }
    if (method === 'GET' && url.pathname === '/') {
      const queryToken = url.searchParams.get('token');
      if (queryToken !== null && tokensMatch(queryToken, authToken)) {
        res.writeHead(303, baseHeaders({
          'location': '/',
          'set-cookie': `apex_ui=${authToken}; Path=/; HttpOnly; SameSite=Strict`,
        }));
        res.end();
        return;
      }
      if (!authorized(req, url)) {
        sendText(res, 401, 'Open the URL printed by the server; it contains the access token.\n', { 'www-authenticate': 'Bearer' });
        return;
      }
      res.writeHead(200, baseHeaders({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'cross-origin-opener-policy': 'same-origin',
      }));
      res.end(UI_PAGE);
      return;
    }

    const api = url.pathname.startsWith('/api/');
    if (!api) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!authorized(req, url)) {
      sendJson(res, 401, { error: 'the access token is missing or wrong' });
      return;
    }
    if (method === 'POST') {
      const origin = req.headers.origin;
      const expected = `http://${req.headers.host ?? `${host}:${listeningPort ?? port}`}`;
      if (typeof origin === 'string' && origin !== expected) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' });
        return;
      }
      if (req.headers['x-apex-ui'] !== '1') {
        sendJson(res, 403, { error: 'the x-apex-ui header is required' });
        return;
      }
      if (typeof req.headers['content-type'] === 'string' && !req.headers['content-type'].startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, await snapshot());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/situation') {
      try {
        sendJson(res, 200, await app.situation.state({ limit: 10 }));
      } catch (err) {
        sendJson(res, 503, { error: `the situational state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/runtime') {
      try {
        sendJson(res, 200, await app.runtime.status());
      } catch (err) {
        sendJson(res, 503, { error: `the runtime state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/events') {
      if (!subscribe(res)) {
        sendJson(res, 429, { error: 'too many event stream subscribers' });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/session/new') {
      if (typeof app.session?.rotate !== 'function') {
        sendJson(res, 503, { error: 'session rotation is unavailable' });
        return;
      }
      const rotated = await app.session.rotate();
      sendJson(res, 200, { status: 'success_verified', display: `Started session ${String(rotated.sessionId).slice(0, 8)}.`, session: { id: rotated.sessionId } });
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)\/(approve|retry|cancel)$/.exec(url.pathname);
    if (method === 'POST' && taskMatch) {
      await handleTaskAction(req, res, taskMatch[2], decodeURIComponent(taskMatch[1]));
      return;
    }
    const planMatch = /^\/api\/plans\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === 'POST' && planMatch) {
      const result = await app.controller.planApprove({ target: decodeURIComponent(planMatch[1]) });
      sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const status = Number.isInteger(err?.status) ? err.status : 500;
      if (err?.closeConnection === true) {
        // A body that was refused while still arriving leaves unread bytes that cannot
        // start the next request, so this connection ends after the refusal flushes.
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
      }
      sendJson(res, status, { error: status === 500 ? 'the request failed inside APEX' : err.message });
    });
  });

  return {
    server,
    token: authToken,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen({ host, port }, () => {
          server.off('error', onError);
          listeningPort = server.address().port;
          const hostLabel = host === '::1' ? '[::1]' : host;
          resolve({ host, port: listeningPort, token: authToken, url: `http://${hostLabel}:${listeningPort}/?token=${authToken}` });
        });
      });
    },
    async stop() {
      for (const sub of [...subscribers]) {
        try { sub.res.end(); } catch { /* already gone */ }
        unsubscribe(sub);
      }
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(() => resolve());
        // A browser keeps its connection open after a response, so a plain close would wait
        // for pages that are still open. Stopping the server ends them instead.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    },
    // Exposed for tests and diagnostics; read-only.
    stats() {
      return { subscribers: subscribers.size, chatInFlight, port: listeningPort, limits: UI_LIMITS };
    },
  };
}
