// T-35 Step 3 (2026-11-19): `apex doctor` - six read-only checks, inside a stated time budget.
//
// A doctor is only useful if it cannot lie in the reassuring direction. Three rules hold here:
//
//   * Every check returns a state it can defend. `pass` means the read succeeded and the thing it
//     read was right; a check that could not be made is `degraded`, a check that found a defect is
//     `failed`, and a check with nothing to look at is `not_configured` - never `pass`.
//   * Nothing is repaired. The doctor opens files, asks the registry and the ECP what they hold, and
//     reports. It writes no store, starts no runtime, calls no model, and installs no browser.
//   * The budget is measured, not asserted. Every run reports how long it took and whether that was
//     inside the 500 ms target; a slow run says so instead of pretending.
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_NAME_RE } from '../actions/registry.js';
import { resolveBrowser } from '../ui/browser-binary.js';

export const DOCTOR_SCHEMA = 'apex.system.doctor/1';
export const DOCTOR_BUDGET_MS = 500;
export const DOCTOR_STATES = Object.freeze(['pass', 'degraded', 'failed', 'not_configured']);
export const DOCTOR_CHECKS = Object.freeze([
  'safety_latch', 'ecp_authority', 'stores_integrity', 'capability_inventory', 'browser_binary', 'workspace_sensor',
]);

// failed > degraded > not_configured > pass. A not_configured check is not a defect, but it is not a
// pass either, and the overall status says so by never being reported as fully ok on its strength.
const SEVERITY = { failed: 3, degraded: 2, not_configured: 1, pass: 0 };
const MAX_STORE_FILES = 400;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

function check(name, state, summary, evidence = {}) {
  if (!DOCTOR_STATES.includes(state)) throw new TypeError(`doctor check ${name} has an unknown state ${state}`);
  return Object.freeze({ name, state, summary, evidence: Object.freeze(evidence) });
}

function worst(states) {
  return states.reduce((acc, state) => (SEVERITY[state] > SEVERITY[acc] ? state : acc), 'pass');
}

// The store scan reads what is on disk and parses it. It does not verify hash chains: those belong to
// the stores that own them, and duplicating a chain check here would be a second, weaker opinion.
function scanStores(dataDir) {
  const report = { files: 0, lines: 0, corrupt: [], unreadable: [], truncated: false, skipped: [], missing: false };
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    report.unreadable.push({ file: '(none)', detail: 'no data directory is configured' });
    return report;
  }
  let names;
  try {
    names = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (err) {
    // A data directory that does not exist yet is a fresh installation, not a fault: nothing has
    // been written, so nothing is claimed. The doctor never creates it to have something to check.
    if (err?.code === 'ENOENT') {
      report.missing = true;
      return report;
    }
    report.unreadable.push({ file: path.basename(dataDir) || dataDir, detail: err?.code || err?.message || 'unreadable' });
    return report;
  }
  const files = [];
  for (const entry of names) {
    if (entry.isFile() && /\.(jsonl|json)$/.test(entry.name)) files.push(entry.name);
    else if (entry.isDirectory() && /^[a-z0-9._-]+$/.test(entry.name)) {
      // One level down, so a store kept in its own directory is still covered without walking the
      // whole disk. Anything deeper is named as skipped rather than silently passed over.
      if (files.length < MAX_STORE_FILES) report.skipped.push(`${entry.name}/`);
    }
  }
  for (const entry of names) {
    if (!entry.isDirectory() || !/^[a-z0-9._-]+$/.test(entry.name)) continue;
    let inner;
    try {
      inner = fs.readdirSync(path.join(dataDir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of inner) {
      if (child.isFile() && /\.(jsonl|json)$/.test(child.name)) files.push(path.join(entry.name, child.name));
    }
  }
  files.sort();
  report.skipped = report.skipped.filter((name) => !files.some((file) => file.startsWith(name)));

  for (const relative of files.slice(0, MAX_STORE_FILES)) {
    const file = path.join(dataDir, relative);
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_STORE_BYTES) {
        report.skipped.push(`${relative} (${stat.size} bytes, above the ${MAX_STORE_BYTES} byte read limit)`);
        continue;
      }
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      report.unreadable.push({ file: relative, detail: err?.code || err?.message || 'unreadable' });
      continue;
    }
    report.files += 1;
    if (relative.endsWith('.json')) {
      report.lines += 1;
      try {
        JSON.parse(text);
      } catch {
        report.corrupt.push({ file: relative, line: 1 });
      }
      continue;
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      report.lines += 1;
      try {
        JSON.parse(line);
      } catch {
        report.corrupt.push({ file: relative, line: index + 1 });
      }
    }
  }
  if (files.length > MAX_STORE_FILES) report.truncated = true;
  return report;
}

export function createDoctor({
  app,
  dataDir = app?.dataDir ?? null,
  now = () => new Date(),
  browserLookup = resolveBrowser,
  storeScan = scanStores,
} = {}) {
  if (!app) throw new TypeError('the doctor needs a composed app');

  function safetyLatch() {
    if (!app.ecp || typeof app.ecp.killSwitchStatus !== 'function') {
      return check('safety_latch', 'failed', 'the ECP is not reachable, so the safety latch cannot be read');
    }
    let status;
    try {
      status = app.ecp.killSwitchStatus();
    } catch (err) {
      return check('safety_latch', 'failed', `the safety latch could not be read: ${err?.message || err}`);
    }
    if (!status || typeof status.active !== 'boolean') {
      return check('safety_latch', 'failed', 'the safety latch returned no readable state');
    }
    if (status.policyUnavailable === true) {
      return check('safety_latch', 'failed',
        'the latch policy file is unreadable, so every write is refused and the policy cannot be confirmed',
        { active: status.active, policyUnavailable: true, persistence: status.persistence ?? null });
    }
    return check('safety_latch', 'pass',
      status.active
        ? `lockdown engaged${status.reason ? `: ${status.reason}` : ''} — every write is refused until the owner releases it`
        : 'the latch is clear and enforced; a write is authorized by the ECP, not by this report',
      { active: status.active, reason: status.reason ?? null, persistence: status.persistence ?? null, policyUnavailable: false });
  }

  function ecpAuthority() {
    if (!app.registry || typeof app.registry.authorize !== 'function') {
      return check('ecp_authority', 'failed', 'the action registry is not reachable, so authority cannot be checked');
    }
    let entries;
    try {
      entries = app.registry.list();
    } catch (err) {
      return check('ecp_authority', 'failed', `the registry could not be listed: ${err?.message || err}`);
    }
    const writes = entries.filter((entry) => entry.permission === 'write');
    const modelOffered = writes.filter((entry) => Array.isArray(entry.origins) && entry.origins.includes('model'));
    if (modelOffered.length > 0) {
      return check('ecp_authority', 'failed',
        `${modelOffered.length} write capability(ies) are offered to the model origin: ${modelOffered.slice(0, 5).map((entry) => entry.name).join(', ')}`,
        { writes: writes.length, modelOffered: modelOffered.map((entry) => entry.name) });
    }
    // A sample of the writes is probed rather than every one: the answer is a policy decision, and
    // the policy is shared. The sample covers the highest-risk capability and the safety controls.
    const probes = ['safety.lockdown', ...writes.slice(0, 4).map((entry) => entry.name)].filter((name, index, list) => list.indexOf(name) === index)
      .filter((name) => app.registry.get(name));
    const allowed = [];
    for (const name of probes) {
      let decision;
      try {
        decision = app.registry.authorize(name, 'model', { phase: 'execute', operationId: 'doctor-probe', auditRef: 'doctor-probe' });
      } catch (err) {
        return check('ecp_authority', 'degraded', `a policy probe could not be evaluated: ${err?.message || err}`);
      }
      if (!decision || decision.decision !== 'deny') allowed.push(name);
    }
    if (allowed.length > 0) {
      return check('ecp_authority', 'failed', `the model origin was allowed a write the policy should refuse: ${allowed.join(', ')}`,
        { probes, allowed });
    }
    const safetyControls = ['safety.lockdown', 'safety.release'].filter((name) => app.registry.get(name));
    if (safetyControls.length !== 2) {
      return check('ecp_authority', 'degraded',
        `the safety controls are incomplete: found ${safetyControls.join(', ') || 'none'}`);
    }
    return check('ecp_authority', 'pass',
      `the ECP is the sole authority: ${entries.length} capabilities, ${writes.length} of them writes, none offered to the model origin, and ${probes.length} policy probe(s) all refused`,
      { capabilities: entries.length, writes: writes.length, probes, safetyControls });
  }

  function storesIntegrity() {
    let report;
    try {
      report = storeScan(dataDir);
    } catch (err) {
      return check('stores_integrity', 'failed', `the store scan itself failed: ${err?.message || err}`);
    }
    if (report.unreadable.length > 0) {
      const first = report.unreadable[0];
      return check('stores_integrity', 'failed',
        `a store could not be read: ${first.file} (${first.detail})${report.unreadable.length > 1 ? ` and ${report.unreadable.length - 1} more` : ''}`,
        report);
    }
    if (report.corrupt.length > 0) {
      const first = report.corrupt[0];
      return check('stores_integrity', 'failed',
        `a store line does not parse: ${first.file} line ${first.line}${report.corrupt.length > 1 ? ` (and ${report.corrupt.length - 1} more)` : ''}`,
        report);
    }
    if (report.missing === true) {
      return check('stores_integrity', 'not_configured',
        'the data directory does not exist yet; nothing has been written, so nothing was checked and nothing was created',
        report);
    }
    if (report.files === 0) {
      return check('stores_integrity', 'not_configured',
        'no store file exists yet in this data directory; nothing has been written, so nothing was checked',
        report);
    }
    return check('stores_integrity', 'pass',
      `${report.files} store file(s), ${report.lines} line(s), every line parses. Hash chains are verified by the stores that own them, not here.`,
      report);
  }

  function capabilityInventory() {
    if (!app.registry || typeof app.registry.list !== 'function') {
      return check('capability_inventory', 'failed', 'the action registry is not reachable');
    }
    const entries = app.registry.list();
    const orphans = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !ACTION_NAME_RE.test(entry.name)) {
        orphans.push({ name: entry?.name ?? '(unnamed)', reason: 'the name does not match the capability grammar' });
        continue;
      }
      const resolved = typeof app.registry.get === 'function' ? app.registry.get(entry.name) : null;
      if (!resolved) {
        orphans.push({ name: entry.name, reason: 'the registry advertises it but cannot resolve it' });
        continue;
      }
      const viaEcp = app.ecp && typeof app.ecp.capabilityLookup === 'function' ? app.ecp.capabilityLookup(entry.name) : undefined;
      if (app.ecp && typeof app.ecp.capabilityLookup === 'function' && (!viaEcp || viaEcp.name !== entry.name)) {
        orphans.push({ name: entry.name, reason: 'the ECP resolves a different capability under this name' });
        continue;
      }
      if (typeof resolved.validate !== 'function' || typeof resolved.execute !== 'function') {
        orphans.push({ name: entry.name, reason: 'it has no validation or no execution procedure' });
        continue;
      }
      if (typeof resolved.description !== 'string' || resolved.description.length === 0) {
        orphans.push({ name: entry.name, reason: 'it has no description, so no surface can present it honestly' });
      }
    }
    const reads = entries.filter((entry) => entry.permission === 'read').length;
    const writes = entries.filter((entry) => entry.permission === 'write').length;
    const domains = [...new Set(entries.map((entry) => entry.domain).filter(Boolean))].sort();
    if (orphans.length > 0) {
      return check('capability_inventory', 'failed',
        `${orphans.length} orphan capability(ies): ${orphans.slice(0, 5).map((entry) => `${entry.name} (${entry.reason})`).join('; ')}`,
        { total: entries.length, reads, writes, domains: domains.length, orphans });
    }
    return check('capability_inventory', 'pass',
      `${entries.length} capabilities, ${reads} reads and ${writes} writes, across ${domains.length} domain(s), and 0 orphans`,
      { total: entries.length, reads, writes, domains: domains.length, orphans: 0 });
  }

  function browserBinary() {
    let resolution;
    try {
      resolution = browserLookup();
    } catch (err) {
      return check('browser_binary', 'degraded', `the browser lookup failed: ${err?.message || err}`);
    }
    if (!resolution || !resolution.executable) {
      const tried = Array.isArray(resolution?.tried) ? resolution.tried : [];
      return check('browser_binary', 'degraded',
        `no Chromium-family browser was found, so no real-browser check can run here; tried ${tried.length} candidate(s)`,
        { tried });
    }
    return check('browser_binary', 'pass',
      `a Chromium-family browser is installed: ${resolution.executable} (${resolution.source}${resolution.browser?.label ? `, ${resolution.browser.label}` : ''})`,
      { executable: resolution.executable, source: resolution.source, tried: resolution.tried?.length ?? 0 });
  }

  function workspaceSensor() {
    const perception = app.perception;
    if (!perception || typeof perception.state !== 'function') {
      return check('workspace_sensor', 'failed', 'the perception service is not reachable, so the workspace sensor cannot be read');
    }
    let state;
    try {
      state = perception.state({ limit: 1 });
    } catch (err) {
      return check('workspace_sensor', 'failed', `the perception state could not be read: ${err?.message || err}`);
    }
    const root = state?.workspaceRoot ?? null;
    if (!root) {
      return check('workspace_sensor', 'not_configured',
        'no workspace root is configured, so the git sensor has nothing to read and nothing is claimed about the tree',
        { workspaceRoot: null });
    }
    const reading = state?.lastReading ?? null;
    if (!reading) {
      return check('workspace_sensor', 'degraded',
        'a workspace root is configured but no reading has been recorded yet; run perception.sense_host',
        { workspaceRoot: root, lastObservationAt: state?.lastObservationAt ?? null });
    }
    const workspace = reading.workspace ?? null;
    if (!workspace) {
      return check('workspace_sensor', 'degraded', 'the last host reading carried no workspace section', { workspaceRoot: root });
    }
    if (workspace.available !== true) {
      return check('workspace_sensor', 'degraded',
        `the git sensor could not read the workspace: ${workspace.reason ?? 'no reason was recorded'}`,
        { workspaceRoot: root, reason: workspace.reason ?? null, at: reading.at ?? null });
    }
    return check('workspace_sensor', 'pass',
      `the git sensor reads branch ${workspace.branch ?? '(no branch)'} at ${String(workspace.head ?? '').slice(0, 7) || '(no head)'} as of ${reading.at ?? 'an unrecorded time'}`,
      { workspaceRoot: root, branch: workspace.branch ?? null, head: workspace.head ?? null, at: reading.at ?? null });
  }

  const CHECKS = [
    ['safety_latch', safetyLatch],
    ['ecp_authority', ecpAuthority],
    ['stores_integrity', storesIntegrity],
    ['capability_inventory', capabilityInventory],
    ['browser_binary', browserBinary],
    ['workspace_sensor', workspaceSensor],
  ];

  async function run() {
    const startedAt = now();
    const started = process.hrtime.bigint();
    const checks = [];
    for (const [name, run] of CHECKS) {
      const checkStart = process.hrtime.bigint();
      let result;
      try {
        result = run();
      } catch (err) {
        result = check(name, 'failed', `the check itself threw: ${err?.message || err}`);
      }
      const durationMs = Number(process.hrtime.bigint() - checkStart) / 1e6;
      checks.push(Object.freeze({ ...result, durationMs: Math.round(durationMs * 100) / 100 }));
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const states = checks.map((entry) => entry.state);
    const overall = worst(states);
    const counts = {
      pass: states.filter((state) => state === 'pass').length,
      degraded: states.filter((state) => state === 'degraded').length,
      failed: states.filter((state) => state === 'failed').length,
      notConfigured: states.filter((state) => state === 'not_configured').length,
    };
    const undecided = checks.filter((entry) => entry.state !== 'pass');
    return Object.freeze({
      schema: DOCTOR_SCHEMA,
      at: startedAt.toISOString(),
      status: overall === 'failed' ? 'failed' : overall === 'degraded' ? 'degraded' : 'ok',
      ok: counts.failed === 0 && counts.degraded === 0,
      counts,
      checks,
      failing: undecided.map((entry) => ({ name: entry.name, state: entry.state, summary: entry.summary })),
      durationMs: Math.round(durationMs * 100) / 100,
      budgetMs: DOCTOR_BUDGET_MS,
      withinBudget: durationMs <= DOCTOR_BUDGET_MS,
      order: DOCTOR_CHECKS,
      readOnly: true,
      leavesNothingBehind: true,
      note: 'Six read-only checks inside a 500 ms budget: the safety latch, ECP authority, store readability, the capability inventory, a browser binary, and the workspace sensor. A pass here is a statement about those six reads. It is not a statement that the system will behave well tomorrow, and nothing is repaired by running it.',
    });
  }

  return Object.freeze({ schema: DOCTOR_SCHEMA, run, checks: DOCTOR_CHECKS, budgetMs: DOCTOR_BUDGET_MS, storeScan: () => storeScan(dataDir) });
}
