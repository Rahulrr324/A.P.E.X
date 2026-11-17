// CLI surface for the T-10 runtime. Kept separate from the main command table so the startup,
// shutdown and tick wording can be tested without threading a large block through cli.js.
export async function runRuntimeCommand({ app, args, out, err, parseFlags, rejectUnexpected }) {
  const runtime = app.runtime;
  if (!runtime) {
    err('the executive runtime is not available in this configuration');
    return 1;
  }
  const [sub, ...rest] = args;
  const statusLines = (s) => [
    `Runtime ${s.runtimeId} is ${s.lifecycle}${s.paused ? ' (scheduling paused)' : ''} | boot ${s.boots} | ticks ${s.ticks}`,
    `  config v${s.configVersion} | interval ${s.effectiveIntervalMs ?? s.config.tickIntervalMs} ms${s.effectiveIntervalMs ? ' (live)' : ' (configured; no live cycle)'} | bounds: ${s.config.maxEventsPerTick} event(s)/tick, ${s.config.maxActionsPerTick} action(s)/tick, backlog ${s.config.maxBacklog}`,
    `  checkpoint: ${s.checkpoint.processed}/${s.checkpoint.processedCap} processed, ${s.checkpoint.published}/${s.checkpoint.publishedCap} published | backlog ${s.backlog ?? 'unavailable'}`,
    `  lease: ${s.lease.held ? `held by pid ${s.lease.pid}` : 'not held'} | last tick ${s.lastTickAt ?? 'never'}`,
    `  notifications: ${s.notifications.active} active (${s.notifications.suppressed} suppressed) | pending approvals: ${s.situational?.pendingApprovals ?? 'unavailable'}`,
    `  retries: ${s.retries.length} | dead letters: ${s.deadLetters.length} | interrupted: ${s.interrupted.length} | blocked tasks: ${s.blockedTasks.length}`,
    `  active plans: ${s.activePlans.length} | schedule entries: ${s.schedule.length}`,
    ...s.activePlans.slice(0, 5).map((p) => `    plan ${String(p.id).slice(0, 8)} ${p.status}: ${p.outcome}`),
    ...s.interrupted.slice(0, 5).map((t) => `    interrupted task ${String(t.id).slice(0, 8)} (${t.status}); it will not be re-run automatically`),
    ...s.retries.slice(0, 5).map((r) => `    retry ${r.key} attempt ${r.attempts}, next ${r.nextAt}`),
    ...s.deadLetters.slice(-3).map((d) => `    dead letter ${d.kind} ${String(d.ref).slice(0, 12)}: ${d.reason}`),
    s.lastError ? `  last error: ${s.lastError}` : null,
  ].filter(Boolean).join('\n');

  if (sub === 'start') {
    const { flags, rest: extra } = parseFlags(rest, ['interval']);
    rejectUnexpected(extra, 'runtime start [--interval <ms>]');
    const interval = flags.interval === undefined ? 5000 : Number(flags.interval);
    if (!Number.isInteger(interval) || interval < 100 || interval > 3600000) {
      err('--interval must be an integer from 100 to 3600000 milliseconds');
      return 2;
    }
    const started = await runtime.start({ intervalMs: interval });
    if (!started.started) {
      err(`runtime not started: ${started.reason}`);
      return 1;
    }
    out(`Runtime ${started.runtimeId} started (boot ${started.boots}) with a ${interval} ms cycle. Press Ctrl+C to stop.`);
    if (started.corruption) out(`Recovered from a damaged checkpoint: ${started.corruption.reason} (preserved at ${started.corruption.quarantinedAt}).`);
    if (started.interrupted.length > 0) out(`${started.interrupted.length} interrupted task(s) will not be re-run automatically.`);
    const shutdown = async (signal) => {
      out(`\n${signal}: stopping the runtime...`);
      const stopped = await runtime.stop({ reason: `received ${signal}` });
      out(stopped.stopped ? 'Runtime stopped; queued work and checkpoints are preserved.' : 'Runtime did not stop cleanly.');
      process.exit(0);
    };
    process.once('SIGINT', () => { shutdown('SIGINT'); });
    process.once('SIGTERM', () => { shutdown('SIGTERM'); });
    // A stop issued from a second process updates the checkpoint, but it cannot clear this
    // process's interval. The foreground process watches the persisted lifecycle and the lease it
    // owns, so it exits instead of staying alive and holding the lease against the next start.
    let stopping = false;
    const shutdownOnce = async (signal) => {
      if (stopping) return;
      stopping = true;
      await shutdown(signal);
    };
    const watchdog = setInterval(async () => {
      if (stopping) return;
      let current;
      try {
        current = await runtime.supervision();
      } catch {
        return;
      }
      const stillMine = current.lease.held && current.lease.pid === process.pid;
      if (current.lifecycle === 'stopped' || !stillMine) {
        clearInterval(watchdog);
        out('The runtime was stopped from another process; this foreground process is exiting.');
        await shutdownOnce('external stop');
      }
    }, Math.max(500, Math.min(interval, 2000)));
    watchdog.unref?.();
    return 0;
  }
  if (sub === 'tick') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'runtime tick');
    const result = await runtime.tick({ trigger: 'cli' });
    if (result.ran === false) {
      err(`runtime did not tick: ${result.reason}`);
      return 1;
    }
    out([
      `Tick at ${result.at}: published ${result.published}, processed ${result.processed} event(s), ${result.decisions} decision(s), ${result.notifications} notification(s)`,
      `  executed: ${result.executed.length === 0 ? 'none' : result.executed.map((r) => `${String(r.planId).slice(0, 8)} ${r.status}`).join(', ')}`,
      `  retries: ${result.retries} | dead letters: ${result.deadLettered}`,
      ...result.executed.filter((r) => r.learning).map((r) => `  learning: plan ${String(r.planId).slice(0, 8)} evaluation ${String(r.learning.evaluationId).slice(0, 8)} (${r.learning.classification})`),
      ...result.skipped.slice(0, 5).map((s) => `  skipped ${typeof s === 'string' ? s : `plan ${String(s.planId).slice(0, 8)}: ${s.reason}`}`),
      result.error ? `  error: ${result.error}` : null,
    ].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'status') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'runtime status');
    out(statusLines(await runtime.status()));
    return 0;
  }
  if (sub === 'diagnose') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'runtime diagnose');
    const report = await runtime.diagnose();
    out([
      `Runtime ${report.runtimeId} (${report.lifecycle}) diagnosis: ${report.healthy ? 'healthy' : 'problems found'}`,
      ...report.checks.map((check) => `  [${check.ok ? 'ok' : 'FAIL'}] ${check.name}: ${check.detail}`),
      'No model or inference handle is held by the runtime.',
    ].join('\n'));
    return report.healthy ? 0 : 1;
  }
  if (sub === 'stop') {
    const { flags, rest: extra } = parseFlags(rest, ['reason']);
    rejectUnexpected(extra, 'runtime stop [--reason <text>]');
    const stopped = await runtime.stop({ reason: flags.reason ?? 'stopped from the CLI' });
    out(stopped.alreadyStopped ? 'Runtime was not running.' : `Runtime stopped at ${stopped.stoppedAt}. Pending work and checkpoints are preserved.`);
    return 0;
  }
  if (sub === 'pause' || sub === 'resume') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, `runtime ${sub}`);
    const result = sub === 'pause' ? await runtime.pause({}) : await runtime.resume();
    out(sub === 'pause' ? 'Runtime scheduling paused. Event processing continues; no plan will be started.' : 'Runtime scheduling resumed.');
    return result.lifecycle ? 0 : 1;
  }
  if (sub === 'schedule') {
    const { flags, rest: ids } = parseFlags(rest, ['at', 'reason']);
    if (ids.length !== 1 || !flags.at) {
      err('usage: runtime schedule <plan-id> --at <iso> [--reason <text>]');
      return 2;
    }
    const result = await runtime.schedule(ids[0], { at: flags.at, reason: flags.reason ?? 'scheduled from the CLI' });
    out(`Plan ${String(result.planId).slice(0, 8)} will not start before ${flags.at}.`);
    return 0;
  }
  if (sub === 'unschedule') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) {
      err('usage: runtime unschedule <plan-id>');
      return 2;
    }
    const result = await runtime.unschedule(ids[0]);
    out(`Schedule removed for plan ${String(result.planId).slice(0, 8)}.`);
    return 0;
  }
  if (sub === 'cancel') {
    const { flags, rest: ids } = parseFlags(rest, ['reason']);
    if (ids.length !== 1) {
      err('usage: runtime cancel <plan-id> [--reason <text>]');
      return 2;
    }
    const result = await runtime.cancelPlan(ids[0], { reason: flags.reason ?? 'cancelled through the runtime' });
    out(`Plan ${String(result.planId).slice(0, 8)}: ${result.status}`);
    return result.status === 'success_verified' || result.status === 'plan_stored' ? 0 : 1;
  }
  if (sub === 'notifications') {
    const { flags, rest: extra } = parseFlags(rest, ['all']);
    rejectUnexpected(extra, 'runtime notifications [--all]');
    const page = await runtime.notifications({ includeExpired: flags.all !== undefined });
    out([
      `${page.notifications.length} notification(s) of ${page.total} recorded:`,
      ...page.notifications.map((n) => `  [${String(n.id).slice(0, 8)}] ${n.level} ${n.response}${n.suppressed ? ' (suppressed)' : ''}${n.acknowledged ? ' (acknowledged)' : ''}${n.expired ? ' (expired)' : ''} | event ${String(n.eventId).slice(0, 8)} | ${n.reason}`),
      page.notifications.length === 0 ? '  none need attention' : null,
    ].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'ack') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) {
      err('usage: runtime acknowledge <notification-id>');
      return 2;
    }
    await runtime.acknowledge(ids[0]);
    out('Notification acknowledged.');
    return 0;
  }
  err('usage: runtime start|tick|status|diagnose|stop|pause|resume|schedule|unschedule|cancel|notifications|acknowledge');
  return 2;
}
