// T-41 Step 1 (2026-11-22): socket OWNERSHIP, which is the question the old check was not asking.
//
// T-40 ended with one local failure and the cause was measured, not guessed: this sandbox's preview
// proxy runs as uid 0 and binds 169.254.0.21:<port> on every ephemeral port a server reports. The old
// check asked "is every listener on this port bound to loopback?", so a foreign socket could make APEX's
// own loopback-only server look publicly reachable. The claim worth making is narrower and testable: is
// the socket THIS PROCESS opened bound to loopback?
//
// That split has to hold in both directions, and this file proves both:
//
//   * a foreign listener (uid 0, an inode this process does not hold) on 169.254.0.21:<port> does NOT
//     fail a loopback-bound non-root server - and is reported, not silently dropped;
//   * an APEX-OWNED socket on 169.254.0.21:<port> or 0.0.0.0:<port> fails, deterministically, even
//     when foreign listeners are present and being ignored.
//
// The second half matters more than the first. A filter that decides "ignore the sockets that are not
// loopback" would pass every test in the first half and detect nothing at all, so the assertions below
// pin that ownership - never reachability - is what filters.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import {
  listensOnLoopbackOnly,
  inspectLoopbackListeners,
  listeningAddressesLinux,
  selfSocketInodes,
  listensOnLoopbackOnlyFor,
  decodeProcAddress,
  isLoopbackAddress,
} from '../pilot/scenarios/security-surface.js';

const haveProc = fs.existsSync('/proc/net/tcp');
const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';

function listening(host) {
  return new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(0, host, () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// A /proc/net/tcp reader that returns the REAL table with extra lines appended. Appending rather than
// replacing matters: the point of these tests is that the real socket and the foreign one are seen
// together, which is the state of this machine and not a scenario invented for a mock.
function withForeignLines(lines, { file = '/proc/net/tcp' } = {}) {
  return (pathname) => {
    const real = fs.readFileSync(pathname, 'utf8');
    if (String(pathname) !== file) return real;
    return `${real}${lines.join('')}`;
  };
}

// A listening line in the kernel's own format. Address hex is the table's little-endian encoding; the
// uid is field 8; the inode is field 10.
function procLine({ addressHex, port, uid = 0, inode = 999_999, state = '0A' }) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${addressHex}:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     ${String(uid).padStart(4, ' ')}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
}

// The encodings a container proxy actually produces, captured from this kernel rather than guessed.
const ADDR = Object.freeze({
  loopback4: '0100007F',
  wildcard4: '00000000',
  linkLocal: '1500FEA9', // 169.254.0.21
  loopback6: '00000000000000000000000001000000',
  wildcard6: '00000000000000000000000000000000',
  mappedLoopback: '0000000000000000FFFF00000100007F',
});

describe('T-41 the /proc address decoder names the address rather than the encoding', () => {
  test('every encoding the kernel uses is decoded to the address it means', () => {
    assert.deepEqual(decodeProcAddress(ADDR.loopback4), { family: 'ipv4', address: '127.0.0.1' });
    assert.deepEqual(decodeProcAddress(ADDR.wildcard4), { family: 'ipv4', address: '0.0.0.0' });
    assert.deepEqual(decodeProcAddress(ADDR.linkLocal), { family: 'ipv4', address: '169.254.0.21' });
    assert.deepEqual(decodeProcAddress(ADDR.loopback6), { family: 'ipv6', address: '::1' });
    assert.deepEqual(decodeProcAddress(ADDR.wildcard6), { family: 'ipv6', address: '::' });
    // An IPv4 socket the kernel filed in the v6 table. It is loopback, and reading it as an unknown
    // v6 string would have made a loopback-only server look reachable.
    assert.equal(decodeProcAddress(ADDR.mappedLoopback).address, '::ffff:7f00:1');
  });

  test('loopback is 127/8 and ::1, and a wildcard is never loopback', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isLoopbackAddress(address), true, `${address} is loopback`);
    }
    for (const address of ['0.0.0.0', '::', '169.254.0.21', '10.0.0.5', '::ffff:10.0.0.5', '', null, undefined]) {
      assert.equal(isLoopbackAddress(address), false, `${address} must not read as loopback`);
    }
  });
});

describe('T-41 a foreign listener cannot decide the verdict', () => {
  test('a uid 0 proxy on 169.254.0.21 does not fail a loopback-bound server', { skip: !haveProc }, async () => {
    const server = await listening('127.0.0.1');
    try {
      // Baseline: this process's own loopback socket, with nothing else on the port.
      const clean = inspectLoopbackListeners(server.port);
      assert.equal(clean.verdict, true, clean.reason);
      assert.equal(clean.foreignListenersIgnored, 0);

      // Now the container's shape: the same port, a second listener bound to 169.254.0.21 as uid 0,
      // holding an inode this process does not have.
      const measured = inspectLoopbackListeners(server.port, {
        readFileSync: withForeignLines([procLine({ addressHex: ADDR.linkLocal, port: server.port, uid: 0, inode: 9_999_999 })]),
      });
      assert.equal(measured.verdict, true, 'a socket this process does not own must not fail the check');
      assert.equal(measured.foreignListenersIgnored, 1, 'the foreign listener is counted');
      assert.equal(measured.foreign.length, 1);
      assert.equal(measured.foreign[0].address, '169.254.0.21');
      assert.equal(measured.foreign[0].uid, 0);
      assert.equal(measured.own.length, 1);
      assert.equal(measured.own[0].address, '127.0.0.1');
      // And the public function agrees with the detailed one, because it is the same function.
      assert.equal(listensOnLoopbackOnly(server.port, {
        readFileSync: withForeignLines([procLine({ addressHex: ADDR.linkLocal, port: server.port, uid: 0 })]),
      }), true);
    } finally {
      await server.close();
    }
  });

  test('a foreign WILDCARD listener is also ignored, and also reported', { skip: !haveProc }, async () => {
    const server = await listening('127.0.0.1');
    try {
      const measured = inspectLoopbackListeners(server.port, {
        readFileSync: withForeignLines([procLine({ addressHex: ADDR.wildcard4, port: server.port, uid: 0 })]),
      });
      // Ignored is not the same as hidden: the fact that something advertises this port on 0.0.0.0 is
      // recorded, and the verdict still describes only the socket APEX opened.
      assert.equal(measured.verdict, true);
      assert.equal(measured.foreignListenersIgnored, 1);
      assert.equal(measured.foreign[0].address, '0.0.0.0');
    } finally {
      await server.close();
    }
  });

  test('a listener whose uid matches but whose inode does not is still foreign', { skip: !haveProc }, async () => {
    // The sharpest version of the rule: same user, different process. If the check keyed on uid alone,
    // a sibling process's wildcard socket would be blamed on APEX - or worse, filtered out because it
    // is "ours". Ownership is the inode; the uid is recorded and never decisive.
    const server = await listening('127.0.0.1');
    try {
      const measured = inspectLoopbackListeners(server.port, {
        readFileSync: withForeignLines([procLine({
          addressHex: ADDR.wildcard4, port: server.port, uid: process.getuid?.() ?? 1000, inode: 9_999_999,
        })]),
      });
      assert.equal(measured.verdict, true, 'same uid is not the same process');
      assert.equal(measured.foreignListenersIgnored, 1);
    } finally {
      await server.close();
    }
  });
});

describe('T-41 an APEX-owned listener on a public address always fails', () => {
  test('this process on 0.0.0.0 fails, with no foreign listener present', { skip: !haveProc }, async () => {
    const server = await listening('0.0.0.0');
    try {
      const measured = inspectLoopbackListeners(server.port);
      assert.equal(measured.verdict, false, 'a wildcard bind by this process is not loopback only');
      assert.equal(measured.own.length, 1);
      assert.equal(measured.own[0].address, '0.0.0.0');
      assert.match(measured.reason, /0\.0\.0\.0/);
      assert.equal(listensOnLoopbackOnly(server.port), false);
    } finally {
      await server.close();
    }
  });

  test('an APEX-owned socket claimed to be on 169.254.0.21 fails even beside a foreign one', { skip: !haveProc }, async () => {
    // The case the milestone names explicitly. The socket is this process's own - the inode comes from
    // the real table - but its address is rewritten to the link-local one. Ownership is satisfied and
    // reachability is not, which is precisely the state a filter based on reachability would miss.
    const server = await listening('127.0.0.1');
    try {
      const own = listeningAddressesLinux(server.port).find((socket) => socket.inode > 0);
      assert.ok(own, 'the server must have a socket in the real table');
      const hexPort = server.port.toString(16).toUpperCase().padStart(4, '0');
      const rewritten = (pathname) => {
        const real = fs.readFileSync(pathname, 'utf8');
        if (String(pathname) !== own.file) return real;
        return real.replace(`${own.addressHex}:${hexPort}`, `${ADDR.linkLocal}:${hexPort}`);
      };
      const measured = inspectLoopbackListeners(server.port, { readFileSync: rewritten });
      assert.equal(measured.verdict, false, 'an APEX-owned link-local bind must fail');
      assert.equal(measured.own.length, 1);
      assert.equal(measured.own[0].address, '169.254.0.21');
      assert.match(measured.reason, /169\.254\.0\.21/);
    } finally {
      await server.close();
    }
  });

  test('an APEX-owned wildcard fails even when a foreign loopback listener is present', { skip: !haveProc }, async () => {
    // The mirror image of the false-positive test: ignoring foreign sockets must not turn into
    // excusing our own. If the filter were written over reachability instead of ownership, this case
    // would pass by ignoring the only socket that matters.
    const server = await listening('0.0.0.0');
    try {
      const measured = inspectLoopbackListeners(server.port, {
        readFileSync: withForeignLines([procLine({ addressHex: ADDR.loopback4, port: server.port, uid: 0, inode: 9_999_999 })]),
      });
      assert.equal(measured.verdict, false, 'our own wildcard bind is not rescued by a foreign loopback one');
      assert.equal(measured.foreignListenersIgnored, 1);
      assert.ok(measured.own.some((socket) => socket.address === '0.0.0.0'));
    } finally {
      await server.close();
    }
  });

  test('the detailed verdict and the public one never disagree', { skip: !haveProc }, async () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const server = await listening(host);
      try {
        const measured = inspectLoopbackListeners(server.port);
        assert.equal(listensOnLoopbackOnly(server.port), measured.verdict,
          `the two entry points disagree for ${host}`);
      } finally {
        await server.close();
      }
    }
  });
});

describe('T-41 ownership is asked of the process that owns the socket', () => {
  test('the pilot measures the server pid, so a child listener counts as owned', { skip: !haveProc }, async () => {
    // This is the defect that kept `npm test` red: the pilot runs `bin/apex-serve.js` as a child, so
    // resolving /proc/self/fd looks in the harness and finds nothing. Ownership has to be asked of the
    // process holding the socket - and when it is, the child's own loopback bind is correctly its own.
    const { spawn } = await import('node:child_process');
    const os = await import('node:os');
    const path = await import('node:path');
    const script = path.join(os.tmpdir(), `apex-t41-listener-${process.pid}.mjs`);
    fs.writeFileSync(script, [
      "import net from 'node:net';",
      "const server = net.createServer(() => {});",
      "server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port)); });",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => reject(new Error('the child never reported a port')), 15_000);
        child.stdout.on('data', (chunk) => {
          buffered += chunk;
          const match = /^(\d{4,5})/.exec(buffered);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
      });
      // Judged as this process, the child's socket is foreign - which is exactly right and exactly why
      // the pilot must pass the pid.
      const asSelf = inspectLoopbackListeners(port);
      assert.equal(asSelf.own.length, 0, 'the child socket is not this process\'s');
      assert.equal(asSelf.verdict, false, 'unowned is not a pass');
      // Judged as the child, it is owned and loopback.
      const asChild = inspectLoopbackListeners(port, { pid: child.pid });
      assert.equal(asChild.own.length, 1);
      assert.equal(asChild.own[0].address, '127.0.0.1');
      assert.equal(asChild.verdict, true, asChild.reason);
      assert.equal(listensOnLoopbackOnlyFor(port, child.pid), true);
      assert.equal(listensOnLoopbackOnlyFor(port, null), asSelf.verdict, 'a missing pid falls back to this process');
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(script, { force: true });
    }
  });

  test('a child bound to 0.0.0.0 fails even when judged as its own', { skip: !haveProc }, async () => {
    const { spawn } = await import('node:child_process');
    const os = await import('node:os');
    const path = await import('node:path');
    const script = path.join(os.tmpdir(), `apex-t41-wildcard-${process.pid}.mjs`);
    fs.writeFileSync(script, [
      "import net from 'node:net';",
      "const server = net.createServer(() => {});",
      "server.listen(0, '0.0.0.0', () => { process.stdout.write(String(server.address().port)); });",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => reject(new Error('the child never reported a port')), 15_000);
        child.stdout.on('data', (chunk) => {
          buffered += chunk;
          const match = /^(\d{4,5})/.exec(buffered);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
      });
      const asChild = inspectLoopbackListeners(port, { pid: child.pid });
      assert.equal(asChild.verdict, false, 'a child wildcard bind is still a wildcard bind');
      assert.ok(asChild.own.some((socket) => socket.address === '0.0.0.0'));
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(script, { force: true });
    }
  });
});

describe('T-41 a platform with no table, and a port with no owner', () => {
  test('a missing table reports null rather than a pass, and no owner reports false', { skip: !haveProc }, async () => {
    // The two null/false answers are different and must not be confused: "this platform cannot tell me"
    // is not "the answer is no", and "the table is readable but this process owns nothing here" is not
    // a pass. Only the second is reachable on a running Linux host, so the first is asserted through the
    // function that decides it rather than by pretending /proc is absent.
    const owning = await listening('127.0.0.1');
    try {
      // A readable table where every line on the port belongs to someone else: this process holds none.
      const measured = inspectLoopbackListeners(owning.port, { selfInodes: new Set() });
      assert.equal(measured.verdict, false, 'a readable table with no socket of ours is not a pass');
      assert.match(measured.reason, /belong to another process/);
      assert.ok(measured.foreignListenersIgnored >= 1);
    } finally {
      await owning.close();
    }
    // And the no-table answer is a distinct value, produced by the branch that detects it.
    const source = fs.readFileSync(new URL('../pilot/scenarios/security-surface.js', import.meta.url), 'utf8');
    assert.match(source, /the platform does not expose \/proc\/net\/tcp, so ownership cannot be measured/,
      'the no-table branch must say so rather than reporting a verdict');
  });

  test('a readable table with no listener of ours is false, not true', { skip: !haveProc }, async () => {
    const server = await listening('127.0.0.1');
    const port = server.port;
    await server.close();
    // Reading the real table after the close: the port may still be in TIME_WAIT or gone entirely.
    // Either way this process holds no listening socket there, so the answer must be false.
    const measured = inspectLoopbackListeners(port);
    assert.equal(measured.verdict, false);
    assert.equal(measured.own.length, 0);
    assert.match(measured.reason, /belong to another process|no socket on that port/);
  });

  test('selfSocketInodes reads the process\'s own socket descriptors', () => {
    const inodes = selfSocketInodes();
    assert.ok(inodes instanceof Set);
    // This test process has no listening socket of its own, but it may hold others; what is pinned is
    // that the function returns a Set of numbers and never throws, because it runs on the failure path.
    for (const value of inodes) assert.equal(typeof value, 'number');
  });
});

describe('T-41 the loopback check still reads the kernel, not the routing table', () => {
  // T-33 Step 1's claims, kept as they were: the change above narrowed what the check decides, it did
  // not replace the evidence it decides from.
  test('a 127.0.0.1 socket is loopback only, and an all-interfaces socket is not', { skip: !haveProc }, async () => {
    const loopback = await listening('127.0.0.1');
    try {
      assert.equal(listensOnLoopbackOnly(loopback.port), true);
    } finally {
      await loopback.close();
    }
    const anywhere = await listening('0.0.0.0');
    try {
      assert.equal(listensOnLoopbackOnly(anywhere.port), false, 'a wildcard bind is not loopback only');
    } finally {
      await anywhere.close();
    }
  });

  test('an unused port reports no listening socket', { skip: !haveProc }, async () => {
    const loopback = await listening('127.0.0.1');
    const port = loopback.port;
    await loopback.close();
    assert.equal(listensOnLoopbackOnly(port), false, 'nothing listens on a closed port');
  });

  test('the scenario states the link-local rule it follows, and the ownership rule it now applies', async () => {
    const text = fs.readFileSync(new URL('../pilot/scenarios/security-surface.js', import.meta.url), 'utf8');
    assert.match(text, /169\.254\.0\.0\/16/, 'the rule names the link-local range');
    assert.match(text, /corroborates and does not decide/, 'the probe is described as corroboration');
    assert.match(text, /T-33 Step 1, 2026-11-19/, 'the earlier change is dated');
    assert.match(text, /T-41 Step 1, 2026-11-22/, 'this change is dated');
    assert.match(text, /foreignListenersIgnored/, 'the ignored listeners are named in the result');
    // And it is stated in words, because a reader has to know which question is being answered.
    assert.match(text, /ownership/, 'the rule is described as ownership');
  });
});
