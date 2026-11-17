#!/usr/bin/env node
// T-16 real-world pilot runner.
//
//   node pilot/run.js                    run every real-world scenario once
//   node pilot/run.js --area filesystem  run one area
//   node pilot/run.js --workflow E       run the scenarios that exercise one §6 workflow
//   node pilot/run.js --id fs-02         run scenarios whose id matches (exact or prefix)
//   node pilot/run.js --repeat 2         re-run each scenario in fresh fixtures and compare signatures
//   node pilot/run.js --json             print the full machine-readable report
//   node pilot/run.js --keep             keep the isolated fixture directories and print their paths
//   node pilot/run.js --list             list declared scenarios and exit
//
// Every scenario spawns the real application (`bin/apex.js` / `bin/apex-serve.js`) with an
// isolated data directory and an isolated workspace. Runs are strictly sequential: timings are
// part of the evidence, and overlapping runs would make them meaningless.
//
// A nonzero exit means at least one scenario failed, a repeated run disagreed with itself, or the
// harness refused its input. A scenario that merely exits 0 is never a pass; that rule lives in
// the harness. No inference process is launched, contacted, downloaded, or recommended.
import { SCENARIOS, AREAS, WORKFLOWS, selectScenarios } from './index.js';
import {
  runPilotScenario, summarizePilot, renderPilotReport, pilotSignature,
  appIdentity, environment, PILOT_VERSION,
} from './harness.js';

const USAGE = `Usage: node pilot/run.js [--area NAME] [--workflow LETTER] [--id ID]... [--repeat N] [--json] [--keep] [--list]

  --area NAME      run only scenarios in one area (${AREAS.join(', ')})
  --workflow L     run only scenarios exercising workflow A-J
  --id ID          run a scenario by exact id or id prefix; repeatable
  --repeat N       run each scenario N times in fresh fixtures and compare signatures
  --json           print a JSON report instead of the text report
  --keep           keep the isolated data and workspace directories
  --list           list declared scenarios and workflow coverage, then exit
`;

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function value(argv, index, flag) {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) fail(`${flag} needs a value`);
  return next;
}

function parse(argv) {
  const options = { area: null, workflow: null, ids: [], repeat: 1, json: false, keep: false, list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--area') options.area = value(argv, index++, '--area');
    else if (arg === '--workflow') options.workflow = value(argv, index++, '--workflow').toUpperCase();
    else if (arg === '--id') options.ids.push(value(argv, index++, '--id'));
    else if (arg === '--repeat') {
      const repeat = Number(value(argv, index++, '--repeat'));
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) fail('--repeat must be an integer between 1 and 10');
      options.repeat = repeat;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown option: ${arg}`);
  }
  if (options.area && !AREAS.includes(options.area)) fail(`unknown area: ${options.area}`);
  if (options.workflow && !WORKFLOWS[options.workflow]) fail(`unknown workflow: ${options.workflow} (expected A-J)`);
  return options;
}

function list() {
  for (const scenario of SCENARIOS) {
    process.stdout.write(`${scenario.id.padEnd(40)} ${scenario.area.padEnd(12)} ${(scenario.workflow ?? '-').padEnd(2)} ${scenario.title}\n`);
  }
  process.stdout.write('\nWorkflow coverage (declared A-J):\n');
  for (const [letter, description] of Object.entries(WORKFLOWS)) {
    const count = SCENARIOS.filter((scenario) => scenario.workflow === letter).length;
    process.stdout.write(`  ${letter}  ${count === 0 ? 'no scenario yet' : `${count} scenario(s)`}  ${description}\n`);
  }
}

// A repeated run is evidence only if it agrees with itself. The signature covers the stated
// expectation hash, every dimension's verdict and every process's exit code, so a different
// interval between two runs shows up even when both happened to pass.
async function runOne(scenario, { repeat, keep }) {
  const runs = [];
  for (let index = 0; index < repeat; index += 1) {
    runs.push(await runPilotScenario(scenario, { keep }));
  }
  const primary = runs[0];
  const signatures = [...new Set(runs.map((run) => run.signature))];
  const reproducible = signatures.length === 1;
  const allPassed = runs.every((run) => run.pass);
  const result = {
    ...primary,
    pass: allPassed && reproducible,
    runs: runs.length,
    reproducible,
  };
  if (!reproducible) {
    result.failureClass = 'oracle_disagreement';
    result.notes = [...result.notes, `${runs.length} repeated run(s) produced ${signatures.length} distinct signatures`];
  }
  return { result, signatures, runs };
}

function renderMeasurements(results) {
  const lines = ['', 'Local measurements (recorded beside each outcome, never scored as one):'];
  let count = 0;
  for (const result of results) {
    for (const measurement of result.measurements ?? []) {
      count += 1;
      const unit = measurement.unit ? ` ${measurement.unit}` : '';
      const detail = measurement.detail ? ` (${measurement.detail})` : '';
      const shown = measurement.value === null ? 'n/a' : String(measurement.value);
      lines.push(`  ${result.id.padEnd(40)} ${shown.padStart(10)}${unit}  ${measurement.name}${detail}`);
    }
  }
  if (count === 0) lines.push('  (no measurement was recorded by the selected scenarios)');
  return lines.join('\n');
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.list) {
    list();
    return;
  }

  const selected = selectScenarios({ area: options.area, workflow: options.workflow, ids: options.ids });
  if (selected.length === 0) fail('no scenario matched the selected area, workflow or id');

  const identity = await appIdentity();
  const env = environment(identity);
  const startedAt = new Date().toISOString();
  const results = [];
  const repeats = [];
  for (const scenario of selected) {
    const { result, signatures, runs } = await runOne(scenario, { repeat: options.repeat, keep: options.keep });
    results.push(result);
    repeats.push({
      id: scenario.id,
      runs: runs.length,
      signatures,
      reproducible: signatures.length === 1,
      passed: runs.filter((run) => run.pass).length,
    });
  }

  const summary = summarizePilot(results);
  const report = {
    pilotVersion: PILOT_VERSION,
    category: 'real-world',
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: env,
    declaredWorkflows: WORKFLOWS,
    results,
    repeats,
    summary: {
      ...summary,
      reproducibleScenarios: repeats.filter((entry) => entry.reproducible).length,
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const kept = results.map((result) => result.kept).filter(Boolean);
    process.stdout.write(`${renderPilotReport(report)}\n${renderMeasurements(results)}\n`);
    if (kept.length > 0) {
      process.stdout.write(`\nKept fixtures:\n${kept.map((entry) => `  data ${entry.dataDir}\n  files ${entry.filesDir}`).join('\n')}\n`);
    }
  }
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`pilot run failed: ${err?.stack ?? err}\n`);
  process.exit(2);
});
