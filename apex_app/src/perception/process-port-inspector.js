// T-43 Package 2 (2026-11-19): the process and port inspector.
//
// Two questions an owner asks about a machine that is running an agent: *what is listening*, and *what
// is this process doing to the box*. Both are answered here, and both are answered from the operating
// system rather than from anything APEX remembers about itself.
//
// Four rules govern the file.
//
//   1. **The parsers are pure and exported.** `parseLinuxProcNetTcp`, `parseWindowsNetstatAno`,
//      `parsePosixPsOutput` and `parseWindowsTasklistCsv` take text and return records; they touch no
//      process and no socket. That is what makes them testable against fixtures from all three
//      platforms on one machine, and it is why a parser bug is a failing test rather than a wrong
//      reading nobody can reproduce.
//
//   2. **A command line is never output.** `ps` and `tasklist` can be asked for one, and it is
//      deliberately not asked for. A command line routinely carries a token, a password, a connection
//      string or a path with an employer's name in it, and telemetry is the last place any of those
//      should be copied to. Neither is the environment read: `process.env` is never serialized, so a
//      secret in APEX's own environment cannot reach a panel through this module.
//
//   3. **Loopback is a fact, not a heuristic.** `127.0.0.1`, any `127.x.x.x`, `::1` and
//      `::ffff:127.0.0.1` are loopback; `0.0.0.0` and `::` are wildcard binds, which are the widest
//      exposure a socket can have; anything else is an address on the host's own interfaces. The three
//      are reported separately because "listening on 8080" means three different things in each case.
//
//   4. **No shell.** `ps`, `tasklist` and `netstat` are invoked with an explicit argument array and
//      `shell: false`, bounded by a two-second timeout. Nothing the host reports is ever parsed into a
//      command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TELEMETRY_SCHEMA = 'apex.system.telemetry/1';
export const INSPECTION_TIMEOUT_MS = 2000;
const MAX_BUFFER = 1024 * 1024;

// The addresses that mean "this machine only". A wildcard bind is deliberately NOT in this set: a
// socket on 0.0.0.0 accepts from anywhere the firewall allows, which is the opposite claim.
const LOOPBACK_PATTERNS = Object.freeze([
  /^127\./,
  /^::1$/,
  /^0:0:0:0:0:0:0:1$/,
  /^::ffff:127\./i,
  /^\[?::1\]?$/,
]);

export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const bare = address.replace(/^\[|\]$/g, '').replace(/%\w+$/, '');
  return LOOPBACK_PATTERNS.some((pattern) => pattern.test(bare));
}

export function isWildcardAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const bare = address.replace(/^\[|\]$/g, '').replace(/%\w+$/, '');
  return bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0' || bare === '*';
}

// The classification a socket's local address gets, stated as a word so a table can colour it and a
// test can assert it without re-deriving the rule.
export function classifyAddress(address) {
  if (isLoopbackAddress(address)) return 'loopback';
  if (isWildcardAddress(address)) return 'wildcard';
  return 'external';
}

// The hex-encoded IPv4 an address in /proc/net/tcp is written as ("0100007F" is 127.0.0.1). The bytes
// are in host order and little-endian, which is the detail that makes a hand-written parser wrong.
function decodeProcIPv4(hex) {
  if (typeof hex !== 'string' || hex.length !== 8) return null;
  const bytes = [];
  for (let index = 6; index >= 0; index -= 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
  if (bytes.some((byte) => !Number.isFinite(byte))) return null;
  return bytes.join('.');
}

// The 32-hex-digit form /proc/net/tcp6 uses: four little-endian 32-bit words. `::1` is written
// `00000000000000000000000001000000`, so the last word is the one that reads 01000000.
function decodeProcIPv6(hex) {
  if (typeof hex !== 'string' || hex.length !== 32) return null;
  const groups = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    const bytes = [];
    for (let index = 6; index >= 0; index -= 2) bytes.push(parseInt(chunk.slice(index, index + 2), 16));
    if (bytes.some((byte) => !Number.isFinite(byte))) return null;
    groups.push(bytes);
  }
  const flat = groups.flat();
  // A v4-mapped address (`::ffff:a.b.c.d`) is reported in its familiar dotted form rather than as a
  // hex expansion, because that is the form the owner's own tools show.
  if (flat.slice(0, 10).every((byte) => byte === 0) && flat[10] === 0xff && flat[11] === 0xff) {
    return `::ffff:${flat.slice(12).join('.')}`;
  }
  const words = [];
  for (let index = 0; index < 16; index += 2) words.push(((flat[index] << 8) | flat[index + 1]).toString(16));
  const text = words.join(':');
  // Only `::1` and `::` are ever classified, so the full form is returned and both classifications
  // accept it.
  return text;
}

// A listening TCP socket in /proc/net/tcp{,6} has state `0A`. The columns are
// `sl local_address rem_address st ... inode` with no header offset change between kernels that matters
// here, so the reading is positional and refuses a line that is too short rather than guessing.
export function parseLinuxProcNetTcp(text, { protocol = 'tcp', processes = null } = {}) {
  if (typeof text !== 'string') return [];
  const records = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const cells = line.trim().split(/\s+/);
    // sl, local, remote, st, then the queue/timer fields; the inode is column 9 in every kernel since
    // 2.6, but it is read by index only after the length check below.
    if (cells.length < 10) continue;
    if (!/^\d+:$/.test(cells[0])) continue;
    if (cells[3] !== '0A') continue; // LISTEN
    const [addressHex, portHex] = cells[1].split(':');
    const localPort = parseInt(portHex, 16);
    if (!Number.isInteger(localPort)) continue;
    const localAddress = protocol === 'tcp6' ? decodeProcIPv6(addressHex) : decodeProcIPv4(addressHex);
    if (localAddress === null) continue;
    const inode = cells[9];
    const pid = processes instanceof Map ? (processes.get(inode) ?? null) : null;
    records.push({ protocol, localAddress, localPort, inode, pid });
  }
  return records;
}

// `netstat -ano` on Windows. The rows are `Proto Local Foreign State PID`; a UDP row has no state and
// is skipped, because a bound UDP socket is not a listening one in the sense this module reports.
export function parseWindowsNetstatAno(text) {
  if (typeof text !== 'string') return [];
  const records = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 5) continue;
    const proto = cells[0].toUpperCase().replace(/^TCPV6$/, 'TCP6');
    if (proto !== 'TCP' && proto !== 'TCP6') continue;
    if (cells[3].toUpperCase() !== 'LISTENING') continue;
    const [address, portText] = splitHostPort(cells[1]);
    const localPort = Number(portText);
    if (!Number.isInteger(localPort)) continue;
    const pid = Number.parseInt(cells[4], 10);
    // Windows prints `TCP` for a socket on either family and distinguishes them by the address, so the
    // address decides the protocol here. `TCPv6` exists in some builds and is accepted above, but it is
    // not what the common case prints, and trusting the label alone would file every v6 socket as v4.
    const isV6 = proto === 'TCP6' || address.includes(':');
    records.push({
      protocol: isV6 ? 'tcp6' : 'tcp',
      localAddress: address,
      localPort,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    });
  }
  return records;
}

// `a.b.c.d:port`, `[::]:port`, `[::1]:port` and the bare `:::80` that some netstat builds print.
function splitHostPort(text) {
  if (typeof text !== 'string') return ['', ''];
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) return ['', ''];
    const address = text.slice(1, close);
    const port = text.slice(close + 1).replace(/^:/, '');
    return [address, port];
  }
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return ['', ''];
  return [text.slice(0, lastColon), text.slice(lastColon + 1)];
}

// `ps -eo pid=,pcpu=,rss=,comm=` on linux and darwin. The four columns are requested explicitly, and a
// line that does not hold four fields is skipped: a parser that invented a width would misattribute a
// percentage to a process it does not belong to.
export function parsePosixPsOutput(text) {
  if (typeof text !== 'string') return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // `comm` is last and may contain spaces (`Google Chrome Helper`), so it is taken as the remainder
    // of the line rather than as one field.
    const match = /^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const cpuPct = Number(match[2]);
    const rssKb = Number(match[3]);
    if (!Number.isInteger(pid) || !Number.isFinite(cpuPct) || !Number.isFinite(rssKb)) continue;
    records.push({
      pid,
      name: match[4].trim().slice(0, 120),
      cpuPct: Math.round(cpuPct * 10) / 10,
      // `ps` reports RSS in kilobytes on both linux and darwin; bytes is what the rest of APEX speaks.
      rssBytes: rssKb * 1024,
    });
  }
  return records;
}

// `tasklist /FO CSV /NH /FI "MEMUSAGE gt 0"`. The image name is quoted, and a name containing a comma
// would break a naive split, so the quoted field is matched rather than split on the separator.
export function parseWindowsTasklistCsv(text) {
  if (typeof text !== 'string') return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Every field tasklist prints is quoted, including the columns between the pid and the memory, so
    // the pattern matches each quoted field explicitly. Splitting on the separator would break a name
    // that contains a comma, which is exactly the case this parser exists to handle.
    const match = /^"((?:[^"]|"")*)"\s*,\s*"(\d+)"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([\d,]+)\s*K"/i.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[2]);
    const rssKb = Number(match[3].replace(/,/g, ''));
    if (!Number.isInteger(pid) || !Number.isFinite(rssKb)) continue;
    records.push({ pid, name: match[1].replace(/""/g, '"').slice(0, 120), cpuPct: null, rssBytes: rssKb * 1024 });
  }
  return records;
}

export class ProcessPortInspector {
  #platform;
  #now;
  #run;
  #apexPid;
  #readFile;
  #processInfo;

  constructor({
    platform = process.platform,
    now = () => new Date(),
    run = null,
    apexPid = process.pid,
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    processInfo = null,
  } = {}) {
    this.#platform = platform;
    this.#now = now;
    this.#apexPid = apexPid;
    this.#readFile = readFile;
    // The memory and uptime reading is injectable so a test can hold it still; the default reads this
    // process, which is the only process whose numbers APEX can state about itself with certainty.
    this.#processInfo = typeof processInfo === 'function' ? processInfo : () => ({
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      ...process.memoryUsage(),
    });
    this.#run = typeof run === 'function' ? run : (args) => execFileSync(args[0], args.slice(1), {
      encoding: 'utf8',
      timeout: INSPECTION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  }

  get platform() { return this.#platform; }

  #safeRun(args) {
    try {
      return { ok: true, text: String(this.#run(args) ?? '') };
    } catch (err) {
      return { ok: false, text: '', reason: err?.code === 'ENOENT' ? 'tool_unavailable' : 'tool_failed' };
    }
  }

  // inode -> pid, from /proc/<pid>/fd/*. Only needed to attribute a linux socket to a process, and a
  // pid whose fd directory cannot be read is simply not attributed: a permission denial is a gap in the
  // reading, never a guess.
  #linuxInodeOwner() {
    const owners = new Map();
    let entries;
    try {
      entries = fs.readdirSync('/proc');
    } catch {
      return owners;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let fds;
      try {
        fds = fs.readdirSync(path.join('/proc', entry, 'fd'));
      } catch {
        continue;
      }
      for (const fd of fds) {
        let target;
        try {
          target = fs.readlinkSync(path.join('/proc', entry, 'fd', fd));
        } catch {
          continue;
        }
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) owners.set(match[1], Number(entry));
      }
    }
    return owners;
  }

  #linuxProcessName(pid) {
    if (!Number.isInteger(pid)) return null;
    try {
      return String(this.#readFile(`/proc/${pid}/comm`)).trim().slice(0, 120) || null;
    } catch {
      return null;
    }
  }

  // The listening sockets, from the operating system's own tables.
  listeningPorts() {
    const inspectedAt = this.#now().toISOString();
    const ports = [];
    let notes = [];

    if (this.#platform === 'linux') {
      const inodeOwner = this.#linuxInodeOwner();
      for (const [file, protocol] of [['/proc/net/tcp', 'tcp'], ['/proc/net/tcp6', 'tcp6']]) {
        let text;
        try {
          text = this.#readFile(file);
        } catch {
          continue;
        }
        ports.push(...parseLinuxProcNetTcp(text, { protocol, processes: inodeOwner }));
      }
    } else if (this.#platform === 'win32') {
      const result = this.#safeRun(['netstat', '-ano']);
      if (!result.ok) notes.push(`netstat could not be read (${result.reason})`);
      else ports.push(...parseWindowsNetstatAno(result.text));
    } else {
      // darwin and the BSDs. `-n` is numeric (no DNS lookups, which would be both slow and a network
      // call this module must not make), `-P tcp` restricts to TCP, and `-a` includes listeners.
      const result = this.#safeRun(['netstat', '-an', '-P', 'tcp']);
      if (!result.ok) notes.push(`netstat could not be read (${result.reason})`);
      else {
        for (const line of result.text.split('\n')) {
          const cells = line.trim().split(/\s+/);
          if (cells.length < 6 || cells[0].toLowerCase() !== 'tcp') continue;
          if (!/listen/i.test(cells[5])) continue;
          const [address, portText] = splitHostPort(cells[3]);
          const localPort = Number(portText);
          if (!Number.isInteger(localPort)) continue;
          const isV6 = /tcp6/.test(cells[0]) || address.includes(':');
          ports.push({ protocol: isV6 ? 'tcp6' : 'tcp', localAddress: address, localPort, pid: null });
        }
      }
    }

    const attributed = ports.map((entry) => {
      const pid = entry.pid ?? null;
      const name = this.#platform === 'linux' ? this.#linuxProcessName(pid) : null;
      const exposure = classifyAddress(entry.localAddress);
      return {
        protocol: entry.protocol,
        localAddress: entry.localAddress,
        localPort: entry.localPort,
        // The two booleans are stated separately rather than as one "is exposed" flag: a loopback bind
        // and no bind at all are different facts, and a UI badge that conflates them cannot be checked.
        isLoopbackOnly: exposure === 'loopback',
        isWildcardBind: exposure === 'wildcard',
        pid,
        processName: entry.processName ?? name ?? null,
        ownedByApex: pid !== null && pid === this.#apexPid,
      };
    });

    // One row per (protocol, address, port). A listen socket and an established connection to the same
    // local port are different rows in the table but would read as duplicate rows here, and a
    // duplicate is not a fact about the machine.
    const deduped = [];
    const seen = new Set();
    for (const entry of attributed) {
      const key = `${entry.protocol}|${entry.localAddress}|${entry.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    deduped.sort((a, b) => (a.localPort - b.localPort) || a.protocol.localeCompare(b.protocol));

    const loopbackOnlyCount = deduped.filter((entry) => entry.isLoopbackOnly).length;
    const wildcardCount = deduped.filter((entry) => entry.isWildcardBind).length;
    return {
      verified: true,
      platform: this.#platform,
      inspectedAt,
      ports: deduped,
      summary: {
        totalListening: deduped.length,
        loopbackOnlyCount,
        wildcardCount,
        // "Externally reachable" is a socket bound to every interface, which is the only case in which
        // the answer does not depend on a firewall this module cannot see.
        externalExposureCount: wildcardCount,
        apexListeningPorts: deduped.filter((entry) => entry.ownedByApex).map((entry) => entry.localPort),
      },
      notes,
    };
  }

  // The processes, and this one's own memory. The top list is ordered by resident bytes because that is
  // the measure every platform reports; CPU percentage is reported where the platform gives it and is
  // null where it does not, which is the honest answer rather than a zero that reads as idle.
  processTelemetry({ limit = 15 } = {}) {
    const inspectedAt = this.#now().toISOString();
    const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 15;
    const notes = [];
    let rows = [];

    if (this.#platform === 'win32') {
      const result = this.#safeRun(['tasklist', '/FO', 'CSV', '/NH', '/FI', 'MEMUSAGE gt 0']);
      if (!result.ok) notes.push(`tasklist could not be read (${result.reason})`);
      else rows = parseWindowsTasklistCsv(result.text);
    } else {
      // Linux and darwin both accept this form. `=` suppresses the header so every line is a record.
      const result = this.#safeRun(['ps', '-eo', 'pid=,pcpu=,rss=,comm=']);
      if (!result.ok) notes.push(`ps could not be read (${result.reason})`);
      else rows = parsePosixPsOutput(result.text);
    }

    let own = null;
    try {
      own = this.#processInfo();
    } catch {
      own = null;
    }
    const apexPid = Number.isInteger(own?.pid) ? own.pid : this.#apexPid;

    // `os.loadavg()` is meaningful on linux and darwin and always [0,0,0] on win32, which is a fact
    // about the platform rather than about the machine, so it is reported only where it is real.
    const loadAverage = this.#platform === 'win32' ? null : os.loadavg().map((value) => Math.round(value * 100) / 100);

    const topProcesses = rows
      .slice()
      .sort((a, b) => (b.rssBytes - a.rssBytes) || (a.pid - b.pid))
      .slice(0, bounded)
      .map((entry) => ({
        pid: entry.pid,
        name: entry.name,
        cpuPct: entry.cpuPct,
        rssBytes: entry.rssBytes,
        isApexProcess: entry.pid === apexPid,
      }));

    return {
      verified: true,
      platform: this.#platform,
      inspectedAt,
      apexProcess: own === null
        ? null
        : {
          pid: own.pid,
          nodeVersion: own.nodeVersion ?? process.version,
          uptimeSec: Number.isFinite(own.uptimeSec) ? own.uptimeSec : 0,
          rssBytes: Number.isFinite(own.rss) ? own.rss : 0,
          heapUsedBytes: Number.isFinite(own.heapUsed) ? own.heapUsed : 0,
          heapTotalBytes: Number.isFinite(own.heapTotal) ? own.heapTotal : 0,
        },
      cpuCount: os.cpus().length,
      loadAverage,
      topProcesses,
      // Stated rather than left to a reader: this reading is deliberately narrower than the machine.
      excluded: ['environment variables', 'process command lines', 'open file paths other than sockets'],
      notes,
    };
  }

  // One call for the telemetry route, so the two readings share a timestamp and a platform.
  inspect({ limit = 15 } = {}) {
    const ports = this.listeningPorts();
    const processes = this.processTelemetry({ limit });
    return {
      schema: TELEMETRY_SCHEMA,
      inspectedAt: processes.inspectedAt,
      platform: this.#platform,
      ports,
      processes,
    };
  }
}

// ------------------------------------------------------------------------------ capabilities ---

// The two registered reads. Both are `L0` Observe: they change nothing, they hold no state, and a
// reading a second later is a different reading rather than a stale one this module must invalidate.
export function processPortActions(inspector) {
  if (!inspector || typeof inspector.listeningPorts !== 'function') {
    throw new TypeError('processPortActions requires the inspector');
  }
  return [
    {
      name: 'system.inspect_ports',
      description: 'Read the host\'s listening TCP sockets from the operating system: address, port, protocol, the owning process where the platform exposes it, and whether each socket is loopback-only, a wildcard bind, or bound to a specific interface. Read-only; no network call is made and no environment or command line is read.',
      inputHint: '{}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'system',
      autonomyLevel: 'L0',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        if (input === undefined || input === null) return {};
        if (typeof input !== 'object' || Array.isArray(input)) throw new Error('system.inspect_ports expects an object');
        for (const key of Object.keys(input)) throw new Error(`unexpected system.inspect_ports input: ${key}`);
        return {};
      },
      async execute() {
        const data = inspector.listeningPorts();
        const { summary } = data;
        return {
          summary: `${summary.totalListening} listening · ${summary.loopbackOnlyCount} loopback · ${summary.wildcardCount} wildcard · ${summary.apexListeningPorts.length} own`,
          data,
          display: [
            `${summary.totalListening} listening socket(s) on ${data.platform}`,
            `${summary.loopbackOnlyCount} loopback-only · ${summary.externalExposureCount} wildcard bind(s) · ${summary.apexListeningPorts.length} owned by this process`,
            ...data.notes,
          ].filter((line) => line.length > 0).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the reading was not marked verified' };
        if (!Array.isArray(data.ports)) return { ok: false, detail: 'the reading carries no port list' };
        // The summary must agree with the rows it summarises, or one of the two is lying.
        const loopback = data.ports.filter((entry) => entry.isLoopbackOnly === true).length;
        const wildcard = data.ports.filter((entry) => entry.isWildcardBind === true).length;
        if (data.summary.loopbackOnlyCount !== loopback || data.summary.externalExposureCount !== wildcard) {
          return { ok: false, detail: `the summary (${data.summary.loopbackOnlyCount}/${data.summary.externalExposureCount}) disagrees with the rows (${loopback}/${wildcard})` };
        }
        if (data.summary.totalListening !== data.ports.length) {
          return { ok: false, detail: 'the total listening count disagrees with the port list' };
        }
        return { ok: true, detail: `${data.ports.length} socket(s) classified` };
      },
    },
    {
      name: 'system.inspect_processes',
      description: 'Read the host\'s processes (pid, name, resident bytes, CPU percentage where the platform reports it) and this process\'s own memory and uptime. Command lines and environment variables are deliberately not read, because both routinely carry credentials.',
      inputHint: '{"limit":15}',
      permission: 'read',
      origins: ['user', 'model'],
      plannable: false,
      domain: 'system',
      autonomyLevel: 'L0',
      reversibility: 'reversible',
      blastRadius: 'local_state',
      validate(input) {
        if (input === undefined || input === null) return { limit: 15 };
        if (typeof input !== 'object' || Array.isArray(input)) throw new Error('system.inspect_processes expects an object');
        for (const key of Object.keys(input)) {
          if (key !== 'limit') throw new Error(`unexpected system.inspect_processes input: ${key}`);
        }
        if (input.limit === undefined) return { limit: 15 };
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
          throw new Error('limit must be an integer from 1 to 50');
        }
        return { limit: input.limit };
      },
      async execute(_ctx, input) {
        const data = inspector.processTelemetry({ limit: input.limit });
        const own = data.apexProcess;
        return {
          summary: own === null
            ? `${data.topProcesses.length} process(es) read`
            : `${data.topProcesses.length} process(es) · own RSS ${Math.round(own.rssBytes / (1024 * 1024))} MB · up ${own.uptimeSec} s`,
          data,
          display: [
            own === null ? 'This process could not read its own memory.' : `APEX pid ${own.pid} on ${own.nodeVersion}: RSS ${Math.round(own.rssBytes / (1024 * 1024))} MB, heap ${Math.round(own.heapUsedBytes / (1024 * 1024))}/${Math.round(own.heapTotalBytes / (1024 * 1024))} MB, up ${own.uptimeSec} s`,
            `${data.topProcesses.length} of ${data.cpuCount} CPU(s) reported · load ${data.loadAverage === null ? 'not reported on this platform' : data.loadAverage.join(' / ')}`,
            'Command lines and environment variables are not read.',
            ...data.notes,
          ].filter((line) => line.length > 0).join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const data = result?.data;
        if (!data || data.verified !== true) return { ok: false, detail: 'the reading was not marked verified' };
        if (!Array.isArray(data.topProcesses)) return { ok: false, detail: 'the reading carries no process list' };
        if (data.apexProcess !== null) {
          if (!Number.isInteger(data.apexProcess.pid)) return { ok: false, detail: 'the own-process reading carries no pid' };
          if (!Number.isFinite(data.apexProcess.rssBytes) || data.apexProcess.rssBytes < 0) {
            return { ok: false, detail: 'the own-process reading carries no resident size' };
          }
        }
        // A reading that leaked an environment or a command line into the payload is a defect, and the
        // verifier is the one place that can refuse it on every call rather than only in a test. The
        // `excluded` declaration is removed before the scan: it names the very words being searched for
        // in order to say they are absent, and a check that flags its own promise is not a check.
        const { excluded: _declared, ...body } = data;
        const text = JSON.stringify(body);
        if (/"cmd(?:line)?"|"commandLine"|"environ(?:ment)?"\s*:|"env"\s*:/.test(text)) {
          return { ok: false, detail: 'the reading exposed a command line or an environment, which this capability never does' };
        }
        return { ok: true, detail: `${data.topProcesses.length} process(es) read` };
      },
    },
  ];
}
