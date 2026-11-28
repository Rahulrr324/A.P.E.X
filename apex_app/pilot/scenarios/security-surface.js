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

// [T-33 Step 1, 2026-11-19] The listening socket's own address, read from the kernel, as the primary
// evidence that the interface is loopback only.
//
// The second-address probe below is corroborating evidence, not proof: on a container host with an
// APIPA address (169.254.0.0/16) a connection to that address can be accepted by something that is
// not the interface at all - a NAT rule, a sandbox proxy, or a link-local peer - and the probe then
// reports "reachable" for a socket that is bound to 127.0.0.1. That happened once, in a full run, and
// it is a false negative about the code rather than a finding about it. The kernel's own view of the
// listening socket cannot be fooled that way, so it decides the check and the probe corroborates.
// How long the second socket-table read waits. Short by design: this is a container proxy's bind, not a
// network handshake, and a check that needs a second to become true is a check that cannot be trusted.
const LOOPBACK_SETTLE_MS = 250;
const LOOPBACK_PROBE_NOTE = 'a link-local (169.254.0.0/16) second address can be answered by host '
  + 'routing rather than by the interface, so it corroborates and does not decide';

function isLinkLocal(address) {
  return typeof address === 'string' && address.startsWith('169.254.');
}

// ---------------------------------------------------------------------------------------------
// T-41 Step 1, 2026-11-22: socket OWNERSHIP, so a container proxy cannot make this check a lie.
//
// T-40 ended with one local test red, and the cause was measured rather than guessed: this sandbox's
// preview proxy runs as uid 0 and binds 169.254.0.21:<port> on every ephemeral port a server reports.
// The old check asked "is every listener on this port bound to loopback?", which is the wrong question.
// The claim worth making is about APEX's own socket - the port this process opened - and a socket
// opened by some other process cannot retroactively make APEX reachable from the network.
//
// So the check now answers two separate questions and reports both:
//   * does APEX's own listening socket sit on loopback? (this decides)
//   * what else is listening on the same port? (this is recorded, never decisive)
//
// The distinction matters in both directions. A foreign wildcard listener is ignored for the verdict
// and named in `foreignListenersIgnored`, so it is visible rather than hidden. An APEX-owned wildcard
// listener fails immediately and is never filtered out - if the filter could be satisfied by "not
// loopback", the check would be exactly the kind of guard that passes by never looking at anything.
// ---------------------------------------------------------------------------------------------

// RFC 5952 compression: collapse the longest run of all-zero groups to `::`, lowercase, and leave the
// rest alone. Two groups are enough - a single `::` in the middle of an address is legal but nobody
// writes it that way, and matching the canonical form keeps the loopback test exact.
function compressIpv6(groups) {
  let best = { start: -1, length: 0 };
  let run = { start: -1, length: 0 };
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (run.start === -1) run = { start: i, length: 0 };
      run.length += 1;
      if (run.length > best.length) best = { start: run.start, length: run.length };
    } else {
      run = { start: -1, length: 0 };
    }
  }
  if (best.length < 2) return groups.join(':');
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}

// The little-endian hex a /proc table uses, decoded into the address it names.
//
// /proc/net/tcp gives IPv4 as four bytes in host order (127.0.0.1 is 0100007F). /proc/net/tcp6 gives
// sixteen bytes as four host-order 32-bit words, which is why 127.0.0.1 appears as
// 0000000000000000FFFF00000100007F rather than as a readable ::ffff: prefix. Both are decoded here so
// the verdict never depends on which table a socket landed in.
export function decodeProcAddress(addressHex) {
  const hex = String(addressHex ?? '').toUpperCase();
  if (hex.length === 8) {
    const octets = [];
    for (let i = 6; i >= 0; i -= 2) octets.push(Number.parseInt(hex.slice(i, i + 2), 16));
    return { family: 'ipv4', address: octets.join('.') };
  }
  if (hex.length === 32) {
    const words = [];
    for (let i = 0; i < 32; i += 8) {
      const word = hex.slice(i, i + 8);
      // Each 32-bit word is stored in host order, so its four bytes are read back to front.
      const bytes = [];
      for (let j = 6; j >= 0; j -= 2) bytes.push(word.slice(j, j + 2));
      words.push(bytes.join(''));
    }
    const groups = [];
    for (const word of words) {
      for (let i = 0; i < 8; i += 4) groups.push(word.slice(i, i + 4));
    }
    const short = groups.map((group) => group.toLowerCase().replace(/^0+/, '') || '0');
    return { family: 'ipv6', address: compressIpv6(short) };;
  }
  return { family: 'unknown', address: hex };
}

// Is this address loopback, for the purpose of "could a machine on the network reach it"?
//
// `::` and `0.0.0.0` are wildcards, not loopback: a socket bound there accepts from any interface, so
// they are the case this whole check exists to catch. `::1` and 127.0.0.0/8 are loopback.
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1' || address === 'localhost') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return true;
  // ::ffff:127.0.0.1 is an IPv4 socket the kernel filed in the v6 table. Its 32-bit tail holds the
  // IPv4 address, so it is loopback exactly when those four bytes are. Reporting it as loopback keeps
  // one rule instead of two that can disagree.
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (mapped) return Number(mapped[1]) === 127;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) return Number.parseInt(mappedHex[1], 16) === 0x7f00;
  return false;
}

// Every socket inode this process owns, read from /proc/self/fd. A socket file descriptor whose
// readlink is `socket:[<inode>]` is one we opened, and the kernel's table names the same inode.
export function selfSocketInodes({ pid = 'self', readdirSync = fs.readdirSync, readlinkSync = fs.readlinkSync } = {}) {
  const inodes = new Set();
  let entries;
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return inodes;
  }
  for (const entry of entries) {
    let target;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${entry}`);
    } catch {
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(String(target));
    if (match) inodes.add(Number(match[1]));
  }
  return inodes;
}

// /proc/net/tcp: field 2 is the local address as little-endian hex, field 4 is the state (0A = LISTEN),
// field 8 is the owning uid, field 10 is the socket's inode.
//
// The optional argument is a seam for tests, not configuration: a test supplies lines that look like a
// container proxy's, so the ownership rule can be proven without requiring this machine to have one.
export function listeningAddressesLinux(port, { readFileSync = fs.readFileSync } = {}) {
  const sockets = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = String(text).split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1].split(':');
      if (local.length !== 2) continue;
      if (Number.parseInt(local[1], 16) !== port) continue;
      if (fields[3] !== '0A') continue;
      const decoded = decodeProcAddress(local[0]);
      sockets.push({
        file,
        addressHex: local[0],
        address: decoded.address,
        family: decoded.family,
        loopback: isLoopbackAddress(decoded.address),
        uid: Number.parseInt(fields[7], 16),
        inode: Number(fields[9]),
      });
    }
  }
  return sockets;
}

// The measured answer, with the ownership split kept explicit.
//
// `null` means "the platform does not expose the table", which is different from "nothing is listening"
// and must never be read as a pass. When the table is readable but no socket on the port belongs to this
// process, the verdict is `false`: this process cannot show it holds a loopback-only socket, and a check
// that reports "yes" when it found nothing is the failure mode this milestone is fixing.
export function inspectLoopbackListeners(port, { pid = 'self', selfInodes = null, ownUid = process.getuid?.() ?? null, readFileSync = fs.readFileSync } = {}) {
  const sockets = listeningAddressesLinux(port, { readFileSync });
  if (sockets.length === 0 && !fs.existsSync('/proc/net/tcp')) {
    return {
      verdict: null,
      reason: 'the platform does not expose /proc/net/tcp, so ownership cannot be measured',
      own: [], foreign: [], foreignListenersIgnored: 0, sockets: [],
    };
  }
  // An inode is ours when this process owns the descriptor. The uid is a corroborating signal, not the
  // test: two processes running as the same user both match their own uid, so uid alone would let a
  // sibling process's wildcard socket be blamed on APEX. Ownership is the inode; the uid is recorded.
  // The pid matters, and getting it wrong is how this milestone started: the pilot measures a CHILD
  // process's socket, so resolving `/proc/self/fd` would look in the harness and find nothing. Ownership
  // is asked of the process that owns the socket - the server's pid when there is one, this process
  // otherwise.
  const inodes = selfInodes ?? selfSocketInodes({ pid });
  const own = [];
  const foreign = [];
  for (const socket of sockets) {
    if (inodes.has(socket.inode)) own.push(socket);
    else foreign.push(socket);
  }
  if (own.length === 0) {
    return {
      verdict: false,
      reason: sockets.length === 0
        ? 'no socket on that port is listening'
        : 'the listening sockets on that port belong to another process, so this process holds none',
      own, foreign, foreignListenersIgnored: foreign.length, sockets,
    };
  }
  const reachable = own.filter((socket) => socket.loopback !== true);
  return {
    verdict: reachable.length === 0,
    reason: reachable.length === 0
      ? 'every socket this process listens on is bound to loopback'
      : `this process listens on ${reachable.map((socket) => socket.address).join(', ')}, which is reachable from another interface`,
    own, foreign, foreignListenersIgnored: foreign.length, sockets,
  };
}

// True when every socket THIS PROCESS listens on the port is bound to a loopback address; null when the
// platform does not expose the table (the probe alone then answers, as it did before this change).
//
// A listener owned by a foreign process - the container's uid 0 preview proxy, most often - does not
// decide this, and is reported in `foreignListenersIgnored` so its presence is recorded rather than
// silently discarded.
export function listensOnLoopbackOnly(port, options = {}) {
  return inspectLoopbackListeners(port, options).verdict;
}

// True when the process that OWNS the socket on this port holds a loopback-only listener.
//
// This is the question the pilot actually asks: it starts `bin/apex-serve.js` as a child and measures
// that child's socket, so the ownership set must be read from the child's descriptors. It is the same
// rule as above, pointed at the right process.
export function listensOnLoopbackOnlyFor(port, pid, options = {}) {
  if (!Number.isInteger(pid)) return listensOnLoopbackOnly(port, options);
  return inspectLoopbackListeners(port, { ...options, pid }).verdict;
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
        // [T-33 Step 1, 2026-11-19] The kernel's listening-socket table decides this; the
        // second-address probe corroborates it and is not conclusive for link-local addresses.
        'the listening socket is bound to a loopback address and the port is not reachable from a routable non-loopback local address',
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
      // [T-33 Step 1, 2026-11-19] The kernel's view of the listening socket decides the loopback
      // check; the second-address probe corroborates it. See LOOPBACK_PROBE_NOTE.
      //
      // [T-41 Step 1, 2026-11-22] Measured with the ownership split, and measured twice with a short
      // settle. The settle is not flattery: on this container the preview proxy binds its wildcard
      // socket on an ephemeral port in the moment between the server printing its URL and the kernel
      // table being read, so a single early read can precede the listener it is meant to ignore. The
      // second read happens after the traffic above - several HTTP round trips - has given anything
      // that wants the port time to take it. What decides is still ownership, not timing: a late
      // foreign socket changes nothing, and an APEX-owned wildcard fails on the first read.
      // Ownership is asked of the server's pid, because the socket belongs to the server: this process
      // started it and does not hold its descriptors.
      let loopbackMeasured = inspectLoopbackListeners(port, { pid: ui.pid });
      if (loopbackMeasured.own.length > 0 && loopbackMeasured.verdict !== true) {
        // Never wait on a verdict that has already failed: an APEX-owned public socket is final.
        loopbackMeasured = inspectLoopbackListeners(port, { pid: ui.pid });
      } else {
        await new Promise((resolve) => { setTimeout(resolve, LOOPBACK_SETTLE_MS); });
        loopbackMeasured = inspectLoopbackListeners(port, { pid: ui.pid });
      }
      const loopbackBound = loopbackMeasured.verdict;
      const tokenHits = filesContaining(ctx.dataDir, ui.token);
      // Read the working set before stopping: the operating system cannot report a process that
      // has already exited, and a blank reading would otherwise look like an actual zero.
      const processMemory = await ctx.processMemory(ui.pid);
      const info = await ui.stop();

      ctx.record('interface bind', {
        url: ui.url, lan, lanReached,
        // T-41 Step 1: what listens on the port and is NOT the server. Recorded rather than discarded,
        // so "the interface is loopback only" is a claim about a measured socket with a stated exclusion
        // list rather than an unqualified sentence.
        loopbackBound,
        ownerPid: ui.pid,
        ownSockets: loopbackMeasured.own.map((socket) => socket.address),
        foreignListenersIgnored: loopbackMeasured.foreignListenersIgnored,
        foreignSockets: loopbackMeasured.foreign.map((socket) => `${socket.address}(uid ${socket.uid})`),
      });
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
        && loopbackBound !== false
        && (lan === null ? true : (isLinkLocal(lan) ? true : lanReached === false));

      const limitations = [];
      if (lan === null) limitations.push('no non-internal IPv4 address was available, so the loopback binding could not be probed from a second address');
      if (loopbackBound === null) limitations.push('the Linux listening-socket table was unavailable, so the loopback binding is corroborated only by the second-address probe');
      if (lan !== null && isLinkLocal(lan)) limitations.push(LOOPBACK_PROBE_NOTE);
      if (info.code !== 0 && info.signal !== null) limitations.push(`the interface process was ended with ${info.signal} because Windows has no portable way to deliver SIGINT to another process; its Ctrl+C path is covered by the in-process tests`);

      return {
        actual: `health=${health.status} page=${unauthPage.status} api=${unauthState.status} events=${unauthEvents.status}; login=${login.status} cookie=${cookie.length > 0}; pageWithCookie=${page.status}; guards=${crossOrigin.status}/${noHeader.status}/${wrongType.status}; chat=${chat.status} ${chat.json?.status ?? 'none'}; session=${stateAfter.json?.session?.status ?? 'none'}; providersEnabled=${sources.json?.enabled ?? 'unknown'}; tokenInData=${tokenHits.length}; boundLoopbackOnly=${loopbackBound === null ? 'untested' : loopbackBound} ownSockets=${loopbackMeasured.own.map((socket) => socket.address).join(',') || 'none'} foreignIgnored=${loopbackMeasured.foreignListenersIgnored}; lan=${lan ?? 'none'} reached=${lanReached === null ? 'untested' : lanReached}`,
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
            'the token is not persisted, no provider is enabled, no model is configured, and the listening socket is bound to loopback',
            {
              stateTruthful,
              providersInert,
              noModel,
              tokenHits,
              loopbackBound,
              lan,
              lanReached,
              linkLocalProbe: lan === null ? null : isLinkLocal(lan),
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
