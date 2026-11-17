// CLI surface for external sources. Commands configure and inspect providers; they never let an
// event or a provider choose an action. A poll is the only operation that can contact a source, and it
// still only writes observations through the existing situational contract.
import fs from 'node:fs';
import { ValidationError } from '../errors.js';

function numberFlag(flags, name, min, max) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`--${name} must be a whole number from ${min} to ${max}`, 'USAGE');
  }
  return value;
}

function readEventsFile(path) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (err) {
    throw new ValidationError(`--events-file cannot be read: ${err?.message ?? String(err)}`, 'USAGE');
  }
  if (!stat.isFile()) throw new ValidationError('--events-file must name a file', 'USAGE');
  if (stat.size > 128 * 1024) throw new ValidationError('--events-file exceeds 128 KiB', 'USAGE');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ValidationError(`--events-file is not valid JSON: ${err?.message ?? String(err)}`, 'USAGE');
  }
  if (!Array.isArray(parsed)) throw new ValidationError('--events-file must contain a JSON list of events', 'USAGE');
  return parsed;
}

function scopeLine(provider) {
  const config = provider.config ?? {};
  if (provider.id === 'filesystem') {
    return `roots ${config.roots.length === 0 ? 'none' : config.roots.join(', ')} | extensions ${config.extensions.join(', ')} | max ${config.maxFiles} file(s), depth ${config.maxDepth}`;
  }
  if (provider.id === 'system_health') {
    return `thresholds memory ${config.memoryPercent}% / disk ${config.diskPercent}% free | paths ${config.paths.length === 0 ? 'none' : config.paths.join(', ')}`;
  }
  if (provider.id === 'calendar') {
    return `${config.events.length} configured event(s) | horizon ${config.horizonDays} day(s)`;
  }
  if (provider.id === 'external_service') {
    return `endpoint ${config.endpoint ?? 'not configured'} | allowlist ${config.allowlist.length} origin(s) | max ${config.maxBytes} byte(s)`;
  }
  return 'no scope';
}

export async function runIntegrationCommand({ app, args, out, err, parseFlags, rejectUnexpected }) {
  const fabric = app.integrations;
  if (!fabric) {
    err('external sources are not available in this configuration');
    return 1;
  }
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'source list');
    const status = await fabric.status();
    out([
      `${status.providers.length} external provider(s), ${status.enabled} enabled${status.paused ? '; observation is paused' : ''}:`,
      ...status.providers.map((provider) => `  ${provider.id} [${provider.enabled ? 'enabled' : 'disabled'}] ${provider.kind} | ${provider.apiVersion} | ${provider.permissions.join(', ')}`),
      'No provider connects during construction or while disabled.',
    ].join('\n'));
    return 0;
  }
  if (sub === 'status') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length > 1) {
      err('usage: source status [provider-id]');
      return 2;
    }
    const status = await fabric.status();
    const rows = ids.length === 0 ? status.providers : status.providers.filter((provider) => provider.id === ids[0]);
    if (rows.length === 0) {
      err(`no provider matches ${ids[0]}`);
      return 1;
    }
    out([
      `External observation is ${status.paused ? 'paused' : 'allowed'}${status.running ? `; polling in flight: ${status.inFlight.join(', ')}` : ''}.`,
      `Totals: ${status.totals.accepted} accepted, ${status.totals.duplicates} duplicate, ${status.totals.rejected} refused of ${status.totals.observed} observed.`,
      ...rows.flatMap((provider) => [
        `${provider.id} [${provider.enabled ? 'enabled' : 'disabled'}] ${provider.name}`,
        `  scope: ${scopeLine(provider)}`,
        `  interval ${provider.config.intervalMs} ms | timeout ${provider.config.timeoutMs} ms | max ${provider.config.maxObservations} observation(s)/poll`,
        `  last attempt ${provider.health.lastAttemptAt ?? 'never'} | last success ${provider.health.lastSuccessAt ?? 'never'} | next ${provider.nextPollAt ?? 'not scheduled'}`,
        `  counts: ${provider.health.polls} poll(s), ${provider.health.accepted} accepted, ${provider.health.duplicates} duplicate, ${provider.health.rejected} refused`,
        `  checkpoint keys: ${provider.checkpoint.keys} | last checkpoint ${provider.checkpoint.lastPollAt ?? 'none'}`,
        provider.health.lastError ? `  last error: ${provider.health.lastError}` : null,
        provider.history.length > 0 ? `  history: ${provider.history.map((row) => row.type).join(', ')}` : null,
      ].filter(Boolean)),
    ].join('\n'));
    return 0;
  }
  if (sub === 'health') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'source health');
    const status = await fabric.status();
    out([
      `Provider health${status.paused ? ' (observation paused)' : ''}:`,
      ...status.providers.map((provider) => `  ${provider.enabled ? 'on ' : 'off'} ${provider.id}: ${provider.health.lastError ? `error ${provider.health.lastError}` : provider.health.lastSuccessAt ? 'healthy' : 'not polled yet'}${provider.health.consecutiveFailures ? ` | ${provider.health.consecutiveFailures} consecutive failure(s)` : ''}`),
    ].join('\n'));
    return 0;
  }
  if (sub === 'enable' || sub === 'disable') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) {
      err(`usage: source ${sub} <provider-id>`);
      return 2;
    }
    const result = sub === 'enable' ? await fabric.enable(ids[0]) : await fabric.disable(ids[0]);
    out(`${result.id} is ${result.enabled ? 'enabled' : 'disabled'}.${sub === 'enable' ? ' It will be polled only when due, explicitly, or by the runtime tick.' : ' It will do nothing.'}`);
    return 0;
  }
  if (sub === 'configure') {
    const { flags, rest: ids } = parseFlags(rest, ['root', 'extension', 'exclude', 'path', 'entity', 'events-file', 'endpoint', 'allowlist', 'predicate', 'interval', 'timeout', 'max-observations', 'max-files', 'max-depth', 'memory-percent', 'disk-percent'], ['root', 'extension', 'exclude', 'path', 'allowlist']);
    if (ids.length !== 1) {
      err('usage: source configure <provider-id> [options]');
      return 2;
    }
    const patch = {};
    if (flags.root !== undefined) patch.roots = flags.root;
    if (flags.extension !== undefined) patch.extensions = flags.extension;
    if (flags.exclude !== undefined) patch.exclude = flags.exclude;
    if (flags.path !== undefined) patch.paths = flags.path;
    if (flags.allowlist !== undefined) patch.allowlist = flags.allowlist;
    if (flags.entity !== undefined) patch.entityId = flags.entity;
    if (flags.endpoint !== undefined) patch.endpoint = flags.endpoint;
    if (flags.predicate !== undefined) patch.predicate = flags.predicate;
    const interval = numberFlag(flags, 'interval', 1000, 24 * 60 * 60 * 1000);
    if (interval !== undefined) patch.intervalMs = interval;
    const timeout = numberFlag(flags, 'timeout', 100, 30000);
    if (timeout !== undefined) patch.timeoutMs = timeout;
    const maxObservations = numberFlag(flags, 'max-observations', 1, 100);
    if (maxObservations !== undefined) patch.maxObservations = maxObservations;
    const maxFiles = numberFlag(flags, 'max-files', 1, 2000);
    if (maxFiles !== undefined) patch.maxFiles = maxFiles;
    const maxDepth = numberFlag(flags, 'max-depth', 0, 8);
    if (maxDepth !== undefined) patch.maxDepth = maxDepth;
    const memoryPercent = numberFlag(flags, 'memory-percent', 1, 100);
    if (memoryPercent !== undefined) patch.memoryPercent = memoryPercent;
    const diskPercent = numberFlag(flags, 'disk-percent', 1, 100);
    if (diskPercent !== undefined) patch.diskPercent = diskPercent;
    if (flags['events-file'] !== undefined) patch.events = readEventsFile(String(flags['events-file']));
    if (Object.keys(patch).length === 0) {
      err('source configure needs at least one option');
      return 2;
    }
    const result = await fabric.configure(ids[0], patch);
    out(`${result.id} configuration saved${result.checkpointReset ? '; its old checkpoint was invalidated because the scope changed' : ''}.`);
    return 0;
  }
  if (sub === 'poll') {
    const { flags, rest: ids } = parseFlags(rest, ['force']);
    if (ids.length > 1) {
      err('usage: source poll [provider-id] [--force]');
      return 2;
    }
    if (ids.length === 1) {
      const result = await fabric.poll(ids[0], { force: flags.force === true });
      if (result.status === 'skipped') {
        err(`${ids[0]} was not polled: ${result.reason}`);
        return 1;
      }
      if (result.status === 'failed') {
        err(`${ids[0]} failed: ${result.error}${result.retryAt ? `; retry at ${result.retryAt}` : ''}`);
        return 1;
      }
      if (result.status === 'cancelled') {
        out(`${ids[0]} poll was cancelled.`);
        return 0;
      }
      out(`${ids[0]} polled in ${result.durationMs} ms: ${result.accepted} accepted, ${result.duplicates} duplicate, ${result.rejected} refused of ${result.observed} observation(s)${result.truncated ? ' (bounded; more remain)' : ''}.`);
      return 0;
    }
    const result = await fabric.pollDue({ limit: 8 });
    out([
      `Polled ${result.polled.length} due provider(s): ${result.accepted} accepted, ${result.duplicates} duplicate, ${result.rejected} refused of ${result.observed} observation(s).`,
      ...result.polled.map((row) => `  ${row.id}: ${row.status} in ${row.durationMs} ms`),
      ...result.skipped.slice(0, 5).map((row) => `  skipped ${row.id ?? ''}: ${row.reason}`),
    ].join('\n'));
    return 0;
  }
  if (sub === 'pause' || sub === 'resume') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, `source ${sub}`);
    const result = sub === 'pause' ? await fabric.pause() : await fabric.resume();
    out(result.paused ? 'External observation is paused. No provider will be polled.' : 'External observation is resumed.');
    return 0;
  }
  if (sub === 'observations') {
    const { flags, rest: extra } = parseFlags(rest, ['provider', 'limit']);
    rejectUnexpected(extra, 'source observations [--provider <id>] [--limit N]');
    const page = await fabric.observations({ provider: flags.provider ?? null, limit: flags.limit });
    out([
      `${page.observations.length} recent external observation(s) of ${page.total} event(s) in the situational log:`,
      ...page.observations.map((row) => `  ${row.provider ?? 'unknown'} ${row.type} | ${row.significance ?? 'unassessed'} | ${row.summary ?? 'no summary'}${row.decision ? ` | decision ${row.decision}` : ''}`),
      page.observations.length === 0 ? '  none recorded' : null,
    ].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'reset') {
    const { flags, rest: ids } = parseFlags(rest, ['reason']);
    if (ids.length !== 1 || !flags.reason) {
      err('usage: source reset <provider-id> --reason <text>');
      return 2;
    }
    const result = await fabric.resetCheckpoint(ids[0], { reason: flags.reason });
    out(`${result.id} checkpoint invalidated. The history records the reason; situational events already recorded are preserved.`);
    return 0;
  }
  if (sub === 'diagnose') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'source diagnose');
    const report = await fabric.diagnose();
    out([
      `External source diagnosis: ${report.healthy ? 'healthy' : 'problems found'}`,
      ...report.checks.map((check) => `  [${check.ok ? 'ok' : 'FAIL'}] ${check.name}: ${check.detail}`),
      'No inference process is contacted and no listener is opened by this fabric.',
    ].join('\n'));
    return report.healthy ? 0 : 1;
  }
  err('usage: source list|status|health|enable|disable|configure|poll|pause|resume|observations|reset|diagnose');
  return 2;
}
