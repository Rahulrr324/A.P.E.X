// T-43 Package 2 (2026-11-19): the process and port inspector, its four parsers, and the guarantee
// that no command line or environment ever reaches a payload.
//
// The parsers are pure, so most of this file is fixture text lifted from what each operating system
// actually prints. The live tests run against this machine - a real /proc on linux, a real `ps`
// otherwise - and they are written to assert the property (a listening socket owned by this process is
// visible and classified) rather than a particular port number.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  ProcessPortInspector, processPortActions, parseLinuxProcNetTcp, parseWindowsNetstatAno,
  parsePosixPsOutput, parseWindowsTasklistCsv, classifyAddress, isLoopbackAddress,
  isWildcardAddress, TELEMETRY_SCHEMA,
} from '../src/perception/process-port-inspector.js';

// A /proc/net/tcp fixture in the real format. `0100007F:1F90` is 127.0.0.1:8080, `00000000:0050` is
// 0.0.0.0:80, and the second line is an ESTABLISHED socket (state 01) that must not be reported.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 123457 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 123458 1 0000000000000000 100 0 0 10 0
   3: 0B00007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123459 1 0000000000000000 100 0 0 10 0
`;

const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 223456 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 223457 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 223458 1 0000000000000000 100 0 0 10 0
`;

const NETSTAT_ANO = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1080
  TCP    127.0.0.1:445          0.0.0.0:0              LISTENING       4
  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:54321         127.0.0.1:54322        ESTABLISHED     8812
  TCP    [::]:80                [::]:0                 LISTENING       4
  TCP    [::1]:8080             [::]:0                 LISTENING       9001
  UDP    0.0.0.0:500            *:*                                    1080
`;

const PS_OUTPUT = `    1  0.0  9876 /sbin/init
  412  1.5 54321 /usr/lib/postgresql/postgres
 9001 12.3 1048576 node
 9002  0.0  2048 Google Chrome Helper
`;

const TASKLIST_CSV = `"System Idle Process","0","Console","1","8 K"
"node.exe","9001","Console","1","104,857 K"
"chrome.exe","9002","Console","1","2,048 K"
"weird, name.exe","9003","Console","1","512 K"
`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ppi-'));
}

describe('T-43 Package 2: the address classification is three facts, not two', () => {
  test('loopback is 127.x.x.x, ::1 and the v4-mapped forms, and nothing else', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::1]']) {
      assert.equal(isLoopbackAddress(address), true, `${address} is loopback`);
      assert.equal(classifyAddress(address), 'loopback');
    }
    for (const address of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '192.168.1.20', '10.0.0.5', '128.0.0.1']) {
      assert.equal(isLoopbackAddress(address), false, `${address} is not loopback`);
    }
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(''), false);
  });

  test('a wildcard bind is its own classification and is never called loopback', () => {
    for (const address of ['0.0.0.0', '::', '*']) {
      assert.equal(isWildcardAddress(address), true, `${address} is a wildcard bind`);
      assert.equal(classifyAddress(address), 'wildcard');
    }
    assert.equal(classifyAddress('192.168.1.20'), 'external');
    assert.equal(isWildcardAddress('127.0.0.1'), false);
  });
});

describe('T-43 Package 2: the four parsers read what each platform actually prints', () => {
  test('the linux /proc parser reports listeners only and decodes the little-endian hex', () => {
    const records = parseLinuxProcNetTcp(PROC_NET_TCP, { protocol: 'tcp' });
    assert.equal(records.length, 3, 'the ESTABLISHED socket is not a listener');
    assert.deepEqual(records.map((entry) => entry.localPort), [8080, 80, 9000]);
    assert.deepEqual(records.map((entry) => entry.localAddress), ['127.0.0.1', '0.0.0.0', '127.0.0.11']);
    assert.equal(records[0].inode, '123456');
    // A line that is too short to hold the columns is skipped rather than guessed at.
    assert.deepEqual(parseLinuxProcNetTcp('  0: 0100007F:1F90 0A\n', {}), []);
    assert.deepEqual(parseLinuxProcNetTcp(null), []);
  });

  test('the linux /proc parser decodes ::1 and the v4-mapped form on the tcp6 table', () => {
    const records = parseLinuxProcNetTcp(PROC_NET_TCP6, { protocol: 'tcp6' });
    assert.equal(records.length, 3);
    assert.equal(records[0].localAddress, '0:0:0:0:0:0:0:1');
    assert.equal(classifyAddress(records[0].localAddress), 'loopback');
    assert.equal(records[1].localAddress, '0:0:0:0:0:0:0:0');
    assert.equal(classifyAddress(records[1].localAddress), 'wildcard');
    assert.equal(records[2].localAddress, '::ffff:127.0.0.1');
    assert.equal(classifyAddress(records[2].localAddress), 'loopback');
  });

  test('the linux parser attributes a socket to a pid through the inode map it is given', () => {
    const owners = new Map([['123456', 9001]]);
    const records = parseLinuxProcNetTcp(PROC_NET_TCP, { protocol: 'tcp', processes: owners });
    assert.equal(records[0].pid, 9001);
    assert.equal(records[1].pid, null, 'an unattributed socket reports no pid rather than a guess');
  });

  test('the windows netstat parser reads LISTENING rows on both address families', () => {
    const records = parseWindowsNetstatAno(NETSTAT_ANO);
    assert.equal(records.length, 5, 'the ESTABLISHED row and the UDP row are not listeners');
    const ipv4 = records.filter((entry) => entry.protocol === 'tcp');
    const ipv6 = records.filter((entry) => entry.protocol === 'tcp6');
    assert.equal(ipv4.length, 3);
    assert.equal(ipv6.length, 2);
    assert.deepEqual(ipv4.map((entry) => entry.localPort), [135, 445, 139]);
    assert.deepEqual(ipv4.map((entry) => entry.pid), [1080, 4, 4]);
    assert.deepEqual(ipv6.map((entry) => entry.localAddress), ['::', '::1']);
    assert.equal(classifyAddress(ipv6[0].localAddress), 'wildcard');
    assert.equal(classifyAddress(ipv6[1].localAddress), 'loopback');
    assert.deepEqual(parseWindowsNetstatAno(''), []);
  });

  test('the posix ps parser keeps a command name with spaces intact', () => {
    const records = parsePosixPsOutput(PS_OUTPUT);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((entry) => entry.pid), [1, 412, 9001, 9002]);
    assert.equal(records[2].name, 'node');
    assert.equal(records[3].name, 'Google Chrome Helper');
    assert.equal(records[2].cpuPct, 12.3);
    assert.equal(records[1].rssBytes, 54321 * 1024);
    // A malformed line is skipped, not partially parsed.
    assert.deepEqual(parsePosixPsOutput('not a ps line\n'), []);
    assert.deepEqual(parsePosixPsOutput(undefined), []);
  });

  test('the windows tasklist parser handles a quoted name containing a comma', () => {
    const records = parseWindowsTasklistCsv(TASKLIST_CSV);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((entry) => entry.pid), [0, 9001, 9002, 9003]);
    assert.equal(records[1].rssBytes, 104857 * 1024);
    assert.equal(records[3].name, 'weird, name.exe');
    // tasklist reports no CPU percentage, and a zero would read as idle rather than as unknown.
    assert.equal(records[1].cpuPct, null);
    assert.deepEqual(parseWindowsTasklistCsv(''), []);
  });
});

describe('T-43 Package 2: the inspector reads this machine', () => {
  test('a loopback server this test starts is reported as loopback-only', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const inspector = new ProcessPortInspector({ apexPid: process.pid });
      const reading = inspector.listeningPorts();
      assert.equal(reading.verified, true);
      assert.equal(reading.platform, process.platform);
      const found = reading.ports.find((entry) => entry.localPort === port);
      // The socket is read straight from the operating system. On linux and darwin the row must be
      // there; a platform whose netstat needs privileges reports a note instead, which is a gap in the
      // reading rather than a failed assertion about the machine.
      if (found) {
        assert.equal(found.isLoopbackOnly, true, 'a bind to 127.0.0.1 is loopback-only');
        assert.equal(found.isWildcardBind, false);
      } else {
        assert.ok(reading.notes.length > 0, 'a reading that could not enumerate sockets says why');
      }
      // The summary is arithmetic over the rows, whatever they are.
      const loopback = reading.ports.filter((entry) => entry.isLoopbackOnly).length;
      assert.equal(reading.summary.loopbackOnlyCount, loopback);
      assert.equal(reading.summary.totalListening, reading.ports.length);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('the process telemetry reports this process and never a command line or an environment', () => {
    const inspector = new ProcessPortInspector({ apexPid: process.pid });
    const telemetry = inspector.processTelemetry({ limit: 5 });
    assert.equal(telemetry.verified, true);
    assert.equal(telemetry.topProcesses.length <= 5, true);
    assert.equal(telemetry.apexProcess.pid, process.pid);
    assert.ok(telemetry.apexProcess.rssBytes > 0, 'a running process has a resident size');
    assert.match(telemetry.apexProcess.nodeVersion, /^v\d+\./);
    assert.ok(telemetry.apexProcess.uptimeSec >= 0);
    assert.deepEqual(telemetry.excluded, ['environment variables', 'process command lines', 'open file paths other than sockets']);
    // The absence is the point: a reading that carries an environment or a command line is a defect.
    const serialized = JSON.stringify(telemetry);
    assert.equal(/process\.env|"env"\s*:|"environ"/.test(serialized), false, 'no environment may be serialized');
    assert.equal(/"cmdline"|"commandLine"/.test(serialized), false, 'no command line may be serialized');
  });

  test('a platform whose tool is missing reports a note rather than throwing', () => {
    const missing = new ProcessPortInspector({
      platform: 'win32',
      run: () => { const err = new Error('spawn netstat ENOENT'); err.code = 'ENOENT'; throw err; },
    });
    const reading = missing.listeningPorts();
    assert.equal(reading.verified, true);
    assert.equal(reading.summary.totalListening, 0);
    assert.ok(reading.notes.some((note) => /netstat could not be read \(tool_unavailable\)/.test(note)));

    const noPs = new ProcessPortInspector({
      platform: 'darwin',
      run: () => { const err = new Error('spawn ps ENOENT'); err.code = 'ENOENT'; throw err; },
      processInfo: () => ({ pid: 4242, nodeVersion: 'v22.0.0', uptimeSec: 5, rss: 1024, heapUsed: 512, heapTotal: 1024 }),
    });
    const telemetry = noPs.processTelemetry();
    assert.equal(telemetry.topProcesses.length, 0);
    assert.equal(telemetry.apexProcess.pid, 4242);
    assert.ok(telemetry.notes.some((note) => /ps could not be read/.test(note)));
  });

  test('inspect() returns both readings under one schema and one timestamp', () => {
    const inspector = new ProcessPortInspector({ apexPid: process.pid });
    const both = inspector.inspect({ limit: 3 });
    assert.equal(both.schema, TELEMETRY_SCHEMA);
    assert.equal(both.ports.verified, true);
    assert.equal(both.processes.verified, true);
    assert.equal(typeof both.inspectedAt, 'string');
    assert.equal(both.platform, process.platform);
  });
});

describe('T-43 Package 2: the two capabilities declare their governance and verify themselves', () => {
  test('both are L0 reads that change nothing', () => {
    const defs = processPortActions(new ProcessPortInspector({}));
    assert.equal(defs.length, 2);
    assert.deepEqual(defs.map((def) => def.name), ['system.inspect_ports', 'system.inspect_processes']);
    for (const def of defs) {
      assert.equal(def.permission, 'read');
      assert.equal(def.autonomyLevel, 'L0');
      assert.equal(def.reversibility, 'reversible');
      assert.equal(def.blastRadius, 'local_state');
      assert.deepEqual(def.origins, ['user', 'model']);
      assert.equal(def.plannable, false);
      assert.equal(typeof def.validate, 'function');
      assert.equal(typeof def.verify, 'function');
    }
  });

  test('the port capability refuses a tampered summary', async () => {
    const defs = processPortActions(new ProcessPortInspector({ apexPid: process.pid }));
    const ports = defs.find((def) => def.name === 'system.inspect_ports');
    const result = await ports.execute({}, ports.validate({}));
    assert.equal((await ports.verify({}, {}, result)).ok, true);
    const tampered = { data: { ...result.data, summary: { ...result.data.summary, totalListening: result.data.summary.totalListening + 3 } } };
    assert.equal((await ports.verify({}, {}, tampered)).ok, false);
  });

  test('the process capability refuses a payload that carries an environment', async () => {
    const defs = processPortActions(new ProcessPortInspector({ apexPid: process.pid }));
    const processesDef = defs.find((def) => def.name === 'system.inspect_processes');
    const result = await processesDef.execute({}, { limit: 2 });
    assert.equal((await processesDef.verify({}, {}, result)).ok, true, 'the honest reading verifies');
    // Each leak the capability promises never to produce is refused by the verifier, so the promise is
    // enforced on every call rather than only in this test.
    for (const leak of [
      { ...result.data, apexProcess: { ...result.data.apexProcess, env: { TOKEN: 'x' } } },
      { ...result.data, environment: { TOKEN: 'x' } },
      { ...result.data, topProcesses: [{ ...result.data.topProcesses[0], cmdline: '/usr/bin/node --token x' }] },
      { ...result.data, commandLine: 'node --token x' },
    ]) {
      assert.equal((await processesDef.verify({}, {}, { data: leak })).ok, false, `refused: ${Object.keys(leak).join(',')}`);
    }
  });

  test('the limit is validated on both ends', () => {
    const defs = processPortActions(new ProcessPortInspector({}));
    const processesDef = defs.find((def) => def.name === 'system.inspect_processes');
    assert.deepEqual(processesDef.validate({}), { limit: 15 });
    assert.deepEqual(processesDef.validate({ limit: 3 }), { limit: 3 });
    assert.throws(() => processesDef.validate({ limit: 0 }));
    assert.throws(() => processesDef.validate({ limit: 51 }));
    assert.throws(() => processesDef.validate({ limit: 1.5 }));
    assert.throws(() => processesDef.validate({ extra: 1 }));
  });
});

describe('T-43 Package 2: the telemetry route and the router lines', () => {
  // A real app, a real UI server, a real socket. The property under test is the one the brief names:
  // the server's own ephemeral loopback port appears in the table and is classified as loopback-only,
  // because it was read from the operating system rather than from anything the app remembers.
  let dataDir;
  let server;
  let base;

  const token = 'T43-telemetry-token-0123456789';

  async function start() {
    dataDir = tempDir();
    const { createApp } = await import('../src/app.js');
    const { createUiServer } = await import('../src/ui/server.js');
    const { ModelGateway, NoBackend } = await import('../src/model/gateway.js');
    const app = createApp({ dataDir, modelGateway: new ModelGateway({ backend: new NoBackend() }) });
    server = createUiServer({ app, token });
    const started = await server.start();
    base = `http://127.0.0.1:${started.port}`;
    return app;
  }

  test('the telemetry route reports the server own loopback port and no environment', async () => {
    try {
      await start();
      const response = await fetch(`${base}/api/system/telemetry`, {
        headers: { authorization: `Bearer ${token}`, 'x-apex-ui': '1' },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(typeof payload.inspectedAt, 'string');
      assert.equal(payload.ports.verified, true);
      assert.equal(payload.processes.verified, true);

      const ownPort = Number(new URL(base).port);
      const mine = payload.ports.ports.find((entry) => entry.localPort === ownPort);
      if (mine) {
        assert.equal(mine.isLoopbackOnly, true, 'the test server binds 127.0.0.1, so its socket is loopback-only');
        assert.equal(payload.ports.summary.apexListeningPorts.includes(ownPort), true);
      } else {
        // A platform whose netstat needs privileges says so rather than reporting nothing.
        assert.ok(payload.ports.notes.length > 0);
      }

      assert.equal(payload.processes.apexProcess.pid, process.pid);
      // The absence, checked on the wire rather than on the object: no environment and no command line.
      const { excluded: _e, ...processBody } = payload.processes;
      const wire = JSON.stringify({ ports: payload.ports, processes: processBody });
      assert.equal(/"environ(?:ment)?"\s*:|"cmdline"|"commandLine"/.test(wire), false);
      assert.deepEqual(payload.processes.excluded,
        ['environment variables', 'process command lines', 'open file paths other than sockets']);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('the limit is validated on the route and a bad one is a 400', async () => {
    try {
      await start();
      const bad = await fetch(`${base}/api/system/telemetry?limit=0`, {
        headers: { authorization: `Bearer ${token}`, 'x-apex-ui': '1' },
      });
      assert.equal(bad.status, 400);
      const ok = await fetch(`${base}/api/system/telemetry?limit=3`, {
        headers: { authorization: `Bearer ${token}`, 'x-apex-ui': '1' },
      });
      assert.equal(ok.status, 200);
      const payload = await ok.json();
      assert.ok(payload.processes.topProcesses.length <= 3);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('the router dispatches all six lines and the catalogue lists them', async () => {
    const app = await (async () => {
      dataDir = tempDir();
      const { createApp } = await import('../src/app.js');
      const { ModelGateway, NoBackend } = await import('../src/model/gateway.js');
      return createApp({ dataDir, modelGateway: new ModelGateway({ backend: new NoBackend() }) });
    })();
    try {
      const { createCommandRouter, routeLine, ROUTE_KIND } = await import('../src/cognition/command-router.js');
      // The routing decision is pure, so the mapping from a sentence to a route is asserted without a
      // dispatch. `git diff <path>` and bare `git diff` are the same route with and without an argument.
      assert.equal(routeLine('git status').action, 'git.status_detailed');
      assert.equal(routeLine('git diff').action, 'git.diff_inspect');
      assert.equal(routeLine('git diff').argument, '');
      assert.equal(routeLine('git diff src/a.js').argument, 'src/a.js');
      assert.equal(routeLine('inspect ports').action, 'system.inspect_ports');
      assert.equal(routeLine('inspect processes').action, 'system.inspect_processes');
      assert.equal(routeLine('create checkpoint before the refactor').action, 'git.checkpoint_create');
      assert.equal(routeLine('create checkpoint before the refactor').argument, 'before the refactor');
      // The Sentinel is where the port and process tables live, and the Workshop is where a git reading
      // belongs; the target view is part of the route rather than something the UI decides.
      assert.equal(routeLine('inspect ports').targetView, 'sentinel');
      assert.equal(routeLine('git status').targetView, 'workshop');
      // A line that merely contains a phrase does not reach the route.
      assert.equal(routeLine('do not inspect ports').kind, ROUTE_KIND.MISSION);

      const router = createCommandRouter({ controller: app.controller, app });
      const catalog = router.catalog();
      const syntaxes = catalog.commands.map((row) => row.syntax);
      for (const syntax of ['git status', 'git diff <path>', 'create checkpoint <label>', 'inspect ports', 'inspect processes']) {
        assert.ok(syntaxes.includes(syntax), `the catalogue must list ${syntax}`);
      }
      // The catalogue's governance column is read from the registry rather than asserted. This app has
      // no workspace root, so the four git capabilities are not registered and the column is null -
      // which is the honest answer to "what would govern this here", not a row that reports a promise
      // the build cannot keep. The host readings are registered unconditionally, so their rows carry a
      // real definition.
      const diffRow = catalog.commands.find((row) => row.syntax === 'git diff <path>');
      assert.equal(diffRow.capability, null, 'a capability this build cannot run is not described as if it could');
      const portsRow = catalog.commands.find((row) => row.syntax === 'inspect ports');
      assert.equal(portsRow.capability.permission, 'read');
      assert.equal(portsRow.capability.blastRadius, 'local_state');
      assert.equal(portsRow.capability.ecpDecision, 'allow');

      // `inspect ports` and `inspect processes` reach a real reading: they are registered regardless of
      // a workspace root, so they verify here even though this app has none.
      for (const line of ['inspect ports', 'inspect processes']) {
        const receipt = await router.dispatch(line);
        assert.equal(receipt.verified, true, `${line} verifies: ${receipt.summary}`);
        assert.equal(receipt.ecpDecision, 'allow');
      }
      // A checkpoint line with no label invokes nothing: the router does not invent a name for the
      // owner's own record.
      const empty = await router.dispatch('create checkpoint');
      assert.equal(empty.actionInvoked, null);
      assert.match(empty.summary, /Name the checkpoint/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
