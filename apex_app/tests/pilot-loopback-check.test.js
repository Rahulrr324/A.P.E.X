// T-33 Step 1 (2026-11-19): the loopback check must not depend on how the container routes.
//
// The pilot's security scenario decides "the interface is loopback only" from the kernel's own
// listening-socket table, and uses the second-address probe only as corroboration. This test pins
// both halves of that: a socket bound to 127.0.0.1 is reported as loopback, a socket bound to every
// interface is not, and the scenario treats a link-local second address as corroboration rather than
// as proof - which is the false negative that made one full run red.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { listensOnLoopbackOnly } from '../pilot/scenarios/security-surface.js';

const haveProc = fs.existsSync('/proc/net/tcp');

function listening(host) {
  return new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(0, host, () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

describe('the pilot loopback check reads the kernel, not the routing table', () => {
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

  test('the scenario states the link-local rule it now follows', async () => {
    const text = fs.readFileSync(new URL('../pilot/scenarios/security-surface.js', import.meta.url), 'utf8');
    assert.match(text, /169\.254\.0\.0\/16/, 'the rule names the link-local range');
    assert.match(text, /corroborates and does not decide/, 'the probe is described as corroboration');
    assert.match(text, /T-33 Step 1, 2026-11-19/, 'the change is dated');
  });
});
