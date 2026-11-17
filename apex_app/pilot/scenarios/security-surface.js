// Real local-interface security and UX checks (T-16, §9 and §10).
//
// The interface is started as the real `bin/apex-serve.js` process. Every request below is an
// HTTP request to that process; nothing calls the server object directly. The per-process token
// is never written into a result: requests record whether a token was presented, not its value.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { check } from '../harness.js';

function nonLoopbackIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false) return entry.address;
    }
  }
  return null;
}

function reaches(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function filesContaining(root, needle) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(needle)) hits.push(path.relative(root, full));
    }
  };
  walk(root);
  return hits;
}

const oneLine = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export default [
  {
    id: 'sec-01-local-ui-boundaries',
    category: 'real-world',
    area: 'security',
    title: 'The local interface authenticates, isolates origins and answers without a model',
    intent: 'Start the real web interface on loopback, then exercise its authentication, origin, header, content-type and session behaviour over HTTP and confirm the token is not persisted and no model is involved.',
    preconditions: ['an isolated data directory and content root, with no provider enabled'],
    steps: [
      'start bin/apex-serve.js with a per-process token on an ephemeral loopback port',
      'request health, the page and the APIs without a token',
      'exchange the printed token for the session cookie and load the page',
      'send a chat request with a cross-origin origin, without the UI header, and with the wrong content type',
      'send one valid chat request and read the resulting session and provider state',
      'scan the persisted data for the token and try the port from a non-loopback address',
    ],
    expected: {
      result: 'only /healthz is readable unauthenticated, every API and the page require the token, POSTs require the same origin and the UI header, the page and chat work over the cookie, no token is persisted, and the answer comes from the deterministic path',
      acceptance: [
        'GET /healthz without a token returns 200 and the page and every /api path return 401',
        'GET / with the token returns 303 with an HttpOnly SameSite=Strict cookie, and that cookie serves the page',
        'a POST is refused 403 cross-origin, 403 without x-apex-ui, and 415 with a non-JSON content type',
        'a valid chat POST returns a verified deterministic answer, and the session is readable afterwards',
        'the interface reports no model configured and no provider is enabled',
        'the token appears in no persisted data file',
        'the listening port is not reachable from a non-loopback local address',
      ],
    },
    async run(ctx) {
      const ui = await ctx.serve();
      const port = Number(new URL(ui.base).port);

      const health = await ui.get('/healthz', { token: null });
      const unauthState = await ui.get('/api/state', { token: null });
      const unauthPage = await ui.get('/', { token: null });
      const unauthEvents = await ui.get('/api/events', { token: null, timeoutMs: 5000 });

      const login = await ui.get('/', { token: null, queryToken: true });
      const setCookie = [].concat(login.headers['set-cookie'] ?? []).join('\n');
      const cookie = setCookie.split(';')[0] ?? '';
      const page = await ui.get('/', { token: null, headers: { cookie } });
      const stateBefore = await ui.get('/api/state', { token: null, headers: { cookie } });

      const crossOrigin = await ui.post('/api/chat', { text: 'calc 2+3' }, {
        token: null,
        headers: { cookie, origin: 'http://evil.example' },
      });
      const noHeader = await ui.post('/api/chat', { text: 'calc 2+3' }, {
        token: null,
        ui: false,
        headers: { cookie, origin: ui.base },
      });
      const wrongType = await ui.post('/api/chat', { text: 'calc 2+3' }, {
        token: null,
        ui: false,
        headers: { cookie, origin: ui.base, 'x-apex-ui': '1', 'content-type': 'text/plain' },
      });
      const chat = await ui.post('/api/chat', { text: 'calc 2+3' }, { token: null, headers: { cookie } });

      const stateAfter = await ui.get('/api/state', { token: null, headers: { cookie } });
      const stateAgain = await ui.get('/api/state', { token: null, headers: { cookie } });
      const sources = await ui.get('/api/sources', { token: null, headers: { cookie } });

      const lan = nonLoopbackIPv4();
      const lanReached = lan ? await reaches(lan, port) : null;
      const tokenHits = filesContaining(ctx.dataDir, ui.token);
      // Read the working set before stopping: the operating system cannot report a process that
      // has already exited, and a blank reading would otherwise look like an actual zero.
      const processMemory = await ctx.processMemory(ui.pid);
      const info = await ui.stop();

      ctx.record('interface bind', { url: ui.url, lan, lanReached });
      ctx.record('unauthenticated responses', {
        health: health.status,
        page: unauthPage.status,
        api: unauthState.status,
        events: unauthEvents.status,
      });
      ctx.record('login response', {
        status: login.status,
        location: login.headers.location ?? null,
        cookieFlags: setCookie.replace(/=.*?;/, '=<redacted>;'),
      });
      ctx.record('refusals', {
        crossOrigin: [crossOrigin.status, oneLine(crossOrigin.json?.error)],
        noHeader: [noHeader.status, oneLine(noHeader.json?.error)],
        wrongType: [wrongType.status, oneLine(wrongType.json?.error)],
      });
      ctx.record('chat result', {
        status: chat.status,
        outcome: chat.json?.status ?? null,
        display: oneLine(chat.json?.display, 200),
        timedOut: chat.json?.timedOut ?? null,
      });
      ctx.record('model line', oneLine(ui.lines().split('\n').find((line) => line.startsWith('Model:')) ?? '', 160));

      ctx.measure('health request', health.durationMs);
      ctx.measure('authenticated state request', stateAfter.durationMs);
      ctx.measure('deterministic chat request', chat.durationMs);
      ctx.measure('interface process memory', processMemory, 'resident bytes', 'bytes');
      ctx.measure('data directories during the run', ctx.dataBytes(), 'data directory bytes', 'bytes');

      const displayText = oneLine(chat.json?.display ?? '');
      const turns = stateAfter.json?.turns ?? [];
      const apexTurn = turns.find((turn) => turn.role === 'apex');
      const boundaries = health.status === 200
        && unauthPage.status === 401
        && unauthState.status === 401
        && unauthEvents.status === 401
        && /Open the URL printed by the server/.test(unauthPage.body)
        && /access token is missing or wrong/.test(unauthState.body);
      const cookieFlow = login.status === 303
        && login.headers.location === '/'
        && /^apex_ui=[a-f0-9]{16,}$/.test(cookie)
        && /HttpOnly/i.test(setCookie)
        && /SameSite=Strict/i.test(setCookie)
        && page.status === 200
        && /<title>APEX<\/title>/.test(page.body);
      const postGuards = crossOrigin.status === 403 && /cross-origin/.test(crossOrigin.json?.error ?? '')
        && noHeader.status === 403 && /x-apex-ui/.test(noHeader.json?.error ?? '')
        && wrongType.status === 415 && /application\/json/.test(wrongType.json?.error ?? '');
      const answered = chat.status === 200
        && chat.json?.status === 'success_verified'
        && chat.json?.timedOut === false
        && /5/.test(chat.json?.display ?? '');
      const stateTruthful = stateBefore.status === 200
        && stateBefore.json?.runtime?.lifecycle === 'stopped'
        && stateBefore.json?.runtime?.ticks === 0
        && stateAfter.status === 200
        && stateAfter.json?.session?.status === 'ok'
        && turns.some((turn) => turn.role === 'user' && turn.text.includes('calc 2+3'))
        && apexTurn?.verified === true
        && /5/.test(apexTurn?.text ?? '')
        && stateAgain.json?.session?.id === stateAfter.json?.session?.id;
      const providersInert = sources.status === 200
        && sources.json?.enabled === 0
        && (sources.json?.providers ?? []).every((provider) => provider.enabled === false)
        && sources.json?.totals?.observed === 0;
      const noModel = /Model: none configured/.test(ui.lines())
        && !/openai|ollama|localhost:\d+|127\.0\.0\.1:\d{2,}/i.test(ui.lines().split('\n').find((line) => line.startsWith('Model:')) ?? '');
      const noSecretStored = tokenHits.length === 0
        && !stateAfter.body.includes(ui.token)
        && !page.body.includes(ui.token);
      const csp = page.headers['content-security-policy'] ?? '';
      const loopbackHeld = ui.url.startsWith('http://127.0.0.1:')
        && (lan === null ? null : lanReached === false);

      const limitations = [];
      if (lan === null) limitations.push('no non-internal IPv4 address was available, so the loopback binding could not be probed from a second address');
      if (info.code !== 0 && info.signal !== null) limitations.push(`the interface process was ended with ${info.signal} because Windows has no portable way to deliver SIGINT to another process; its Ctrl+C path is covered by the in-process tests`);

      return {
        actual: `health=${health.status} page=${unauthPage.status} api=${unauthState.status} events=${unauthEvents.status}; login=${login.status} cookie=${cookie.length > 0}; pageWithCookie=${page.status}; guards=${crossOrigin.status}/${noHeader.status}/${wrongType.status}; chat=${chat.status} ${chat.json?.status ?? 'none'}; session=${stateAfter.json?.session?.status ?? 'none'}; providersEnabled=${sources.json?.enabled ?? 'unknown'}; tokenInData=${tokenHits.length}; lan=${lan ?? 'none'} reached=${lanReached === null ? 'untested' : lanReached}`,
        checks: {
          correctness: check(
            boundaries && cookieFlow && answered,
            'only health is public, the token is exchangeable for the page, and a valid chat is answered',
            { boundaries, cookieFlow, answered },
          ),
          completeness: check(
            postGuards && unauthEvents.status === 401 && /SameSite=Strict/.test(setCookie),
            'cross-origin, missing-header, non-JSON and unauthenticated event requests are all refused',
            { postGuards, events: unauthEvents.status },
          ),
          reliability: check(
            stateAfter.status === 200
              && stateAgain.status === 200
              && ui.requests.every((row) => row.status !== null)
              && ui.requests.length >= 12,
            'every request produced a response and the interface kept serving after the chat',
            { requests: ui.requests.length, errors: ui.requests.filter((row) => row.status === null).length },
          ),
          safety: check(
            stateTruthful && providersInert && noModel && noSecretStored && loopbackHeld !== false
              && /frame-ancestors 'none'/.test(csp)
              && /default-src 'none'/.test(csp),
            'the token is not persisted, no provider is enabled, no model is configured, and the socket is loopback only',
            {
              stateTruthful,
              providersInert,
              noModel,
              tokenHits,
              lan,
              lanReached,
              csp: oneLine(csp, 200),
            },
          ),
          continuity: check(
            stateAfter.json?.session?.id === stateAgain.json?.session?.id
              && apexTurn?.verified === true
              && /5/.test(apexTurn?.text ?? ''),
            'the chat session persists across reads and the stored answer is the one the user received',
            { session: stateAfter.json?.session?.id ?? null, turns: turns.length, verified: apexTurn?.verified ?? null },
          ),
          ux: check(
            /<link rel="stylesheet" href="\/style\.css">/.test(page.body)
              && /<script src="\/app\.js"><\/script>/.test(page.body)
              && /script-src 'self'/.test(csp)
              && displayText.length > 0
              && displayText.length <= 300
              && !/[\x00-\x1f\x7f]/.test(displayText)
              && /\d{4}-\d{2}-\d{2}T/.test(health.json?.at ?? ''),
            'the page loads its own assets under a restrictive policy, the answer is readable, and health is timestamped',
            { display: oneLine(chat.json?.display ?? '', 160), healthAt: health.json?.at ?? null },
          ),
        },
        recovery: null,
        limitations,
        notes: [`the interface was ended with ${info.code ?? info.signal}; requests=${ui.requests.length}`],
      };
    },
  },
];
