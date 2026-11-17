// T-16 real-world repair: a stop issued while a cycle is in flight must not be undone.
//
// The pilot observed the foreground runtime keep ticking after `runtime stop` reported success,
// hold its lease, and refuse the next start with "runtime process <pid> is already running". The
// cycle had loaded `running` before the stop landed, and its final checkpoint write put `running`
// back. This drives both the cycle and the stop deterministically in one process, with the stop
// happening inside the cycle's own external-observation step.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir, cleanup } from './helpers.js';
import { createApp } from '../src/app.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop());
});

describe('external stop while a runtime cycle is in flight', () => {
  test('the cycle persists its work and keeps the stopped lifecycle', async () => {
    const dir = makeTempDataDir();
    dirs.push(dir);
    const foreground = createApp({ dataDir: dir });
    const secondProcess = createApp({ dataDir: dir });

    const started = await foreground.runtime.start({ intervalMs: 0 });
    assert.equal(started.started, true);

    let stoppedDuringTick = null;
    const fabric = foreground.runtime.integrations;
    const realPoll = fabric.pollDue.bind(fabric);
    fabric.pollDue = async () => {
      stoppedDuringTick = await secondProcess.runtime.stop({ reason: 'external stop during a cycle' });
      return { providers: 0 };
    };

    let cycle;
    try {
      cycle = await foreground.runtime.tick({ trigger: 'test' });
    } finally {
      fabric.pollDue = realPoll;
    }
    assert.equal(cycle.ran, true, cycle.reason);
    assert.equal(stoppedDuringTick.stopped, true);
    assert.ok(stoppedDuringTick.stoppedAt);

    const after = await foreground.runtime.status();
    assert.equal(after.lifecycle, 'stopped');
    assert.equal(after.stoppedAt, stoppedDuringTick.stoppedAt);
    assert.equal(after.ticks, 1);

    const next = await foreground.runtime.tick({ trigger: 'test' });
    assert.equal(next.ran, false);
    assert.match(next.reason, /stopped/);

    // What the foreground process does when its watchdog sees the external stop: shut down and
    // release the lease it still owns.
    const shutdown = await foreground.runtime.stop({ reason: 'foreground noticed the stop' });
    assert.equal(shutdown.stopped, true);
    assert.equal(foreground.runtime.lease.inspect().held, false);

    // The restart that the pilot could not perform is now allowed, with the same identity.
    const restarted = await secondProcess.runtime.start({ intervalMs: 0 });
    assert.equal(restarted.started, true);
    assert.equal(restarted.runtimeId, started.runtimeId);
    assert.equal(restarted.boots, 2);
    await secondProcess.runtime.stop({ reason: 'test cleanup' });
  });
});
